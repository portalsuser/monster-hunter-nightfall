/**
 * All sound is synthesised with WebAudio at runtime — the game ships with zero
 * audio assets, which keeps the Portals bundle tiny and load times instant.
 *
 * Every effect is built from the same three parts a real sound has:
 *   transient — a few ms of click or noise that the ear reads as "impact"
 *   body      — the pitched/filtered part that says how big and what material
 *   tail      — decay, air, ring-out, and the shared room send
 * Layering those beats stacking more oscillators: the transient does the work,
 * so the body can stay quiet and the mix stays clean with 30 sounds a second.
 *
 * Everything here must survive having no AudioContext at all (the headless
 * smoke test runs in Node), so `ensure()` returning null is a supported path
 * and every entry point bails on it before touching anything.
 */

let ctx = null;
let master = null;
let musicGain = null;
let sfxGain = null;      // pre-limiter sum of all one-shots
let sfxIn = null;        // what individual sounds actually connect to
let started = false;
let muted = false;
let droneNodes = [];
let droneFilter = null;

// Shared effect sends, built once (see ensure()).
let verbTaps = null;     // fixed-level taps into the convolver
let echoTap = null;      // fixed-level tap into the feedback delay

/**
 * A short algorithmic room. Generated rather than loaded so we stay asset-free.
 * `decay` shapes how fast the noise tail dies; the one-pole lowpass inside the
 * loop is what stops it sounding like a hiss burst — real rooms lose highs much
 * faster than lows, and a darker tail also leaves the transients audible.
 */
function makeImpulse(c, seconds, decay) {
  const len = Math.max(1, Math.floor(c.sampleRate * seconds));
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const n = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      lp += (n - lp) * 0.32;
      // Sparse the first 12ms slightly so the room reads as reflections
      // arriving rather than as one solid wall of noise.
      d[i] = lp * (t < 0.012 ? 0.35 : 1);
    }
  }
  return buf;
}

function ensure() {
  if (ctx) return ctx;
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(ctx.destination);

  // Limiter on the sfx bus only. Combat routinely overlaps a dozen one-shots;
  // without this the sum clips on peaks and the whole mix has to be turned
  // down to compensate. The music bed stays outside it so hordes do not pump
  // the drone. WebAudio's compressor applies no makeup gain, so this can only
  // ever make things quieter — which is the point.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -14;
  limiter.knee.value = 8;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.14;
  limiter.connect(master);

  sfxGain = ctx.createGain();
  sfxGain.gain.value = 0.62;
  sfxGain.connect(limiter);
  sfxIn = sfxGain;

  musicGain = ctx.createGain();
  musicGain.gain.value = 0.0;
  musicGain.connect(master);

  // --- Shared sends -------------------------------------------------------
  // One convolver for the entire game. An impulse response is by far the
  // biggest allocation in this file, and sounds fire dozens of times a second,
  // so building a reverb per call would churn megabytes a second and stall on
  // GC. Instead the room exists once and sounds bus into it.
  if (ctx.createConvolver) {
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx, 1.15, 3.4);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.5;
    conv.connect(verbOut).connect(limiter);

    // Three fixed send levels instead of a per-call send gain: an extra
    // GainNode on every single one-shot is real garbage during a wave, and the
    // difference between "0.18 wet" and "0.2 wet" is inaudible anyway.
    verbTaps = [0.09, 0.22, 0.5].map((v) => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(conv);
      return g;
    });
  }

  // Small damped feedback delay. Two short repeats give distance and size to
  // the big events without a second convolver; the lowpass in the loop makes
  // each repeat duller so it recedes instead of ringing.
  const dl = ctx.createDelay(0.6);
  dl.delayTime.value = 0.17;
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 1900;
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  dl.connect(damp).connect(fb).connect(dl);
  const echoOut = ctx.createGain();
  echoOut.gain.value = 0.5;
  dl.connect(echoOut).connect(limiter);
  echoTap = ctx.createGain();
  echoTap.gain.value = 0.25;
  echoTap.connect(dl);

  return ctx;
}

/** Browsers require a user gesture before audio may start. */
export function unlock() {
  const c = ensure();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  if (!started) {
    started = true;
    startDrone();
  }
}

export function setMuted(v) {
  muted = v;
  if (master) master.gain.value = v ? 0 : 0.85;
}

export function isMuted() {
  return muted;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function rnd(a, b) { return a + Math.random() * (b - a); }

/**
 * Multiplicative pitch jitter, in cents-ish terms. Repeated hits that land on
 * exactly the same frequency machine-gun into one buzzing tone; a few percent
 * of wobble per call is the cheapest fix and is what makes a burst of ten
 * impacts read as ten separate objects.
 */
function jit(amount = 0.06) { return 1 + rnd(-amount, amount); }

/** Route a finished voice to the dry bus plus whatever sends it asked for. */
function out(node, { send = 0, echo = 0, pan = 0 } = {}) {
  let tail = node;
  // A little random stereo placement per call keeps a crowd of identical
  // enemies from collapsing into one point in the middle of the image.
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    node.connect(p);
    tail = p;
  }
  tail.connect(sfxIn);
  if (send && verbTaps) {
    const i = send < 0.15 ? 0 : send < 0.34 ? 1 : 2;
    tail.connect(verbTaps[i]);
  }
  if (echo && echoTap) tail.connect(echoTap);
}

/** Percussive attack/decay envelope. Exponential both ways; never hits zero. */
function env(node, t0, attack, decay, peak = 1) {
  const p = Math.max(0.0001, peak);
  node.gain.setValueAtTime(0.0001, t0);
  node.gain.exponentialRampToValueAtTime(p, t0 + Math.max(0.001, attack));
  node.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.001, attack) + Math.max(0.005, decay));
}

/**
 * One oscillator voice: osc -> optional filter -> envelope -> bus/sends.
 * `delay` schedules against the audio clock rather than setTimeout, so
 * sequences stay sample-accurate and never leak a pending timer.
 */
function tone({
  freq = 440, type = 'sine', dur = 0.15, attack = 0.005, vol = 0.3,
  slideTo = null, slideCurve = 1, detune = 0, delay = 0,
  filter = 0, filterType = 'lowpass', filterTo = 0, q = 0.7,
  send = 0, echo = 0, pan = 0,
} = {}) {
  const c = ensure();
  if (!c || muted) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(1, freq), t0);
  if (detune) osc.detune.setValueAtTime(detune, t0);
  if (slideTo) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur * slideCurve);
  }
  let head = osc;
  if (filter) {
    const bq = c.createBiquadFilter();
    bq.type = filterType;
    bq.frequency.setValueAtTime(Math.max(20, filter), t0);
    bq.Q.value = q;
    if (filterTo) bq.frequency.exponentialRampToValueAtTime(Math.max(20, filterTo), t0 + dur);
    osc.connect(bq);
    head = bq;
  }
  head.connect(g);
  env(g, t0, attack, dur, vol);
  out(g, { send, echo, pan });
  osc.start(t0);
  osc.stop(t0 + dur + attack + 0.05);
}

let noiseBuffer = null;
function getNoise() {
  const c = ensure();
  if (!c) return null;
  if (noiseBuffer) return noiseBuffer;
  const len = c.sampleRate * 1.0;
  noiseBuffer = c.createBuffer(1, len, c.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

/**
 * Filtered noise layer. Reads the shared buffer from a random offset so two
 * sounds fired in the same frame do not play byte-identical noise and phase
 * into a single artificial-sounding hiss.
 */
function noise({
  dur = 0.2, vol = 0.25, filter = 900, type = 'lowpass', q = 1,
  sweepTo = null, attack = 0.004, delay = 0, rate = 1,
  send = 0, echo = 0, pan = 0,
} = {}) {
  const c = ensure();
  if (!c || muted) return;
  const buf = getNoise();
  if (!buf) return;
  const t0 = c.currentTime + delay;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = rate;
  const bq = c.createBiquadFilter();
  bq.type = type;
  bq.frequency.setValueAtTime(Math.max(20, filter), t0);
  bq.Q.value = q;
  if (sweepTo) bq.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t0 + dur);
  const g = c.createGain();
  env(g, t0, attack, dur, vol);
  src.connect(bq).connect(g);
  out(g, { send, echo, pan });
  src.start(t0, Math.random() * 0.9);
  src.stop(t0 + dur + attack + 0.1);
}

/**
 * The transient. A 4-10ms highpassed noise spit is what actually sells an
 * impact — without it a hit is a soft "whump" no matter how loud the body is,
 * and with it the body can sit 6dB lower than it otherwise would.
 */
function click({ vol = 0.2, freq = 3200, dur = 0.008, delay = 0, pan = 0 } = {}) {
  noise({ dur, vol, filter: freq, type: 'highpass', q: 0.7, attack: 0.0006, delay, pan });
}

/**
 * Inharmonic metal ring. Real blades and chains ring on partials that are not
 * integer multiples, so the ratios below are deliberately irrational-ish; equal
 * multiples would just sound like another sawtooth.
 */
function metal({ freq = 2400, vol = 0.05, dur = 0.22, delay = 0, send = 0.2, pan = 0 } = {}) {
  const ratios = [1, 1.71, 2.43, 3.17];
  for (let i = 0; i < ratios.length; i++) {
    tone({
      freq: freq * ratios[i], type: 'sine', dur: dur * (1 - i * 0.18),
      attack: 0.001, vol: vol / (1 + i * 1.3), delay, send, pan,
    });
  }
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Per-sound rate limit. Several of these fire once per enemy per frame; past
 * roughly 25 overlapping copies you only hear mud and the limiter clamping, so
 * dropping the extras sounds strictly better as well as costing less.
 */
const gates = Object.create(null);
function gate(key, ms) {
  const t = nowMs();
  if (t - (gates[key] || -1e9) < ms) return false;
  gates[key] = t;
  return true;
}

// A natural minor set in Hz. The music bed drones on A1/E2, so every reward and
// UI sound is drawn from this table — picked arbitrarily they beat against the
// drone, and that dissonance is very audible on the ones that ring out.
const N = {
  A2: 110, E3: 164.81, G3: 196, A3: 220, C4: 261.63, D4: 293.66, E4: 329.63,
  G4: 392, A4: 440, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99,
  A5: 880, C6: 1046.5, E6: 1318.51, A6: 1760,
};

// ---------------------------------------------------------------------------
// Music bed
// ---------------------------------------------------------------------------

/**
 * Low ambient bed: a detuned A minor drone under a slowly opening filter, plus
 * a breath of filtered noise for air. The two LFOs run at deliberately
 * non-harmonic rates (0.043 vs 0.071 Hz) so their sum never repeats on any
 * timescale a player will notice.
 */
function startDrone() {
  const c = ensure();
  if (!c) return;
  musicGain.gain.setTargetAtTime(0.12, c.currentTime, 3);

  droneFilter = c.createBiquadFilter();
  droneFilter.type = 'lowpass';
  droneFilter.frequency.value = 320;
  droneFilter.Q.value = 3;
  droneFilter.connect(musicGain);

  // A1 doubled with a few cents of detune (the beating is what makes it feel
  // wide), E2 a fifth up, and a quiet A2 triangle to give the bed a top edge.
  const voices = [
    { f: 55, type: 'sawtooth', g: 0.18, det: -5 },
    { f: 55, type: 'sawtooth', g: 0.16, det: 7 },
    { f: 82.5, type: 'triangle', g: 0.11, det: 0 },
    { f: 110, type: 'triangle', g: 0.05, det: 3 },
  ];
  for (const v of voices) {
    const o = c.createOscillator();
    o.type = v.type;
    o.frequency.value = v.f;
    o.detune.value = v.det;
    const g = c.createGain();
    g.gain.value = v.g;
    o.connect(g).connect(droneFilter);
    o.start();
    droneNodes.push(o);
  }

  // Wind layer: near-inaudible on its own, but it fills the gap between the
  // drone and the effects so the mix never sounds like silence plus blips.
  const buf = getNoise();
  if (buf) {
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = 0.35;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.6;
    const wg = c.createGain();
    wg.gain.value = 0.05;
    src.connect(bp).connect(wg).connect(musicGain);
    src.start();
    droneNodes.push(src);

    const windLfo = c.createOscillator();
    windLfo.frequency.value = 0.071;
    const windAmt = c.createGain();
    windAmt.gain.value = 180;
    windLfo.connect(windAmt).connect(bp.frequency);
    windLfo.start();
    droneNodes.push(windLfo);
  }

  const lfo = c.createOscillator();
  lfo.frequency.value = 0.043;
  const lfoGain = c.createGain();
  lfoGain.gain.value = 160;
  lfo.connect(lfoGain).connect(droneFilter.frequency);
  lfo.start();
  droneNodes.push(lfo);
}

export function setMusicIntensity(v) {
  const c = ensure();
  if (!c || !musicGain) return;
  musicGain.gain.setTargetAtTime(0.08 + v * 0.14, c.currentTime, 1.5);
  // Opening the filter with intensity makes pressure audible as brightness
  // rather than as raw volume, which is what stops the bed getting fatiguing.
  if (droneFilter) droneFilter.frequency.setTargetAtTime(300 + v * 340, c.currentTime, 2.5);
}

// ---------------------------------------------------------------------------
// Named one-shots. Each is transient + body + tail, with a few percent of
// per-call randomisation so repeats never sound like a sample being retriggered.
// ---------------------------------------------------------------------------

export const SFX = {
  /** Blunt swing landing: air, then a dull filtered thud. */
  punch() {
    const c = ensure();
    if (!c || muted) return;
    if (!gate('punch', 28)) return;
    const p = rnd(-0.35, 0.35);
    const j = jit(0.09);
    // Whoosh: a bandpass falling fast is the whole trick behind "something
    // heavy moved through air".
    noise({ dur: 0.085, vol: 0.13, filter: 1700 * j, sweepTo: 260, type: 'bandpass', q: 1.4, pan: p });
    click({ vol: 0.11, freq: 2600, dur: 0.006, pan: p });
    tone({
      freq: 158 * j, slideTo: 62, type: 'square', dur: 0.075, vol: 0.1,
      filter: 900, filterTo: 260, pan: p, send: 0.09,
    });
    tone({ freq: 58 * j, slideTo: 40, type: 'sine', dur: 0.11, vol: 0.09, pan: p });
  },

  /** Bladed swing: air sweep plus a faint edge ring behind it. */
  slash() {
    const c = ensure();
    if (!c || muted) return;
    if (!gate('slash', 30)) return;
    const p = rnd(-0.4, 0.4);
    const j = jit(0.08);
    noise({ dur: 0.15, vol: 0.16, filter: 3600 * j, sweepTo: 620, type: 'bandpass', q: 2.2, pan: p, send: 0.12 });
    // Second, thinner layer half a beat behind: two sweeps at different rates
    // read as a blade with width rather than a single synth swish.
    noise({ dur: 0.1, vol: 0.07, filter: 6200, sweepTo: 1800, type: 'highpass', q: 0.7, delay: 0.012, pan: -p });
    metal({ freq: 2350 * j, vol: 0.028, dur: 0.16, delay: 0.02, send: 0.22, pan: p });
  },

  /** Heavier two-handed swing — same family as slash, longer and lower. */
  swordSwing() {
    const c = ensure();
    if (!c || muted) return;
    if (!gate('swordSwing', 40)) return;
    const p = rnd(-0.3, 0.3);
    const j = jit(0.07);
    noise({ dur: 0.24, vol: 0.15, filter: 2400 * j, sweepTo: 340, type: 'bandpass', q: 1.8, attack: 0.05, pan: p, send: 0.15 });
    tone({ freq: 120 * j, slideTo: 55, type: 'triangle', dur: 0.2, vol: 0.06, attack: 0.06, pan: p });
    metal({ freq: 1750 * j, vol: 0.02, dur: 0.24, delay: 0.06, send: 0.22, pan: p });
  },

  /** Thrown blade: breath off the hand, a falling whistle, a tiny ting. */
  throwKnife() {
    const c = ensure();
    if (!c || muted) return;
    if (!gate('throwKnife', 24)) return;
    const p = rnd(-0.5, 0.5);
    const j = jit(0.1);
    click({ vol: 0.06, freq: 4000, dur: 0.005, pan: p });
    noise({ dur: 0.07, vol: 0.07, filter: 5000 * j, sweepTo: 1400, type: 'bandpass', q: 1.2, pan: p });
    tone({ freq: 940 * j, slideTo: 380, type: 'triangle', dur: 0.11, vol: 0.09, pan: p, send: 0.1 });
    metal({ freq: 3100 * j, vol: 0.016, dur: 0.09, send: 0.09, pan: p });
  },

  /** Generic damage tick — by far the most frequently fired sound in the game. */
  hit() {
    const c = ensure();
    if (!c || muted) return;
    // Rate-limited: with 300 enemies on screen this fires constantly.
    if (!gate('hit', 42)) return;
    const p = rnd(-0.6, 0.6);
    const j = jit(0.12);
    click({ vol: 0.1, freq: 3400, dur: 0.005, pan: p });
    noise({ dur: 0.055, vol: 0.1, filter: 2400 * j, sweepTo: 520, type: 'bandpass', q: 1.1, pan: p, send: 0.09 });
    // The pitched thump is what gives the hit a body; the wide jitter above is
    // what keeps ten of them in a row from fusing into one buzzing note.
    tone({ freq: 132 * j, slideTo: 68, type: 'triangle', dur: 0.07, vol: 0.08, pan: p });
  },

  /** Enemy death: the hit, plus a wet collapse and a downward gutter. */
  kill() {
    const c = ensure();
    if (!c || muted) return;
    if (!gate('kill', 35)) return;
    const p = rnd(-0.5, 0.5);
    const j = jit(0.1);
    click({ vol: 0.09, freq: 2800, dur: 0.006, pan: p });
    tone({
      freq: 235 * j, slideTo: 82, type: 'sawtooth', dur: 0.15, vol: 0.085,
      filter: 1400, filterTo: 320, q: 1.2, pan: p, send: 0.2,
    });
    noise({ dur: 0.13, vol: 0.1, filter: 900 * j, sweepTo: 160, q: 1.4, pan: p, send: 0.2 });
    tone({ freq: 70 * j, slideTo: 42, type: 'sine', dur: 0.17, vol: 0.07, pan: p });
  },

  /** Taking damage: deliberately the ugliest thing in the palette. */
  playerHurt() {
    const c = ensure();
    if (!c || muted) return;
    const j = jit(0.05);
    click({ vol: 0.14, freq: 2000, dur: 0.01 });
    // Two detuned squares an octave apart beat against each other, which reads
    // as pain rather than as a note.
    tone({ freq: 296 * j, slideTo: 118, type: 'square', dur: 0.24, vol: 0.15, filter: 1300, filterTo: 400, send: 0.22 });
    tone({ freq: 148 * j, slideTo: 60, type: 'square', dur: 0.28, vol: 0.09, detune: 22, send: 0.22 });
    noise({ dur: 0.22, vol: 0.12, filter: 520, sweepTo: 190, send: 0.22 });
    tone({ freq: 62, slideTo: 38, type: 'sine', dur: 0.3, vol: 0.11 });
  },

  /** XP / loot blip. Kept in-scale and tiny — it fires hundreds of times. */
  pickup() {
    const c = ensure();
    if (!c || muted) return;
    if (!gate('pickup', 30)) return;
    const p = rnd(-0.45, 0.45);
    // Alternating a fifth against the root keeps a stream of pickups feeling
    // like a phrase instead of one repeated beep.
    const root = Math.random() < 0.5 ? N.E5 : N.A5;
    click({ vol: 0.04, freq: 6000, dur: 0.004, pan: p });
    tone({ freq: root, slideTo: root * 1.5, type: 'triangle', dur: 0.075, vol: 0.075, attack: 0.003, pan: p, send: 0.1 });
    tone({ freq: root * 2, slideTo: root * 3, type: 'sine', dur: 0.06, vol: 0.03, pan: p, send: 0.1 });
  },

  /** Healing: a warm rising fifth with a bell on top. */
  health() {
    const c = ensure();
    if (!c || muted) return;
    tone({ freq: N.C5, slideTo: N.G5, type: 'sine', dur: 0.3, vol: 0.13, attack: 0.02, send: 0.35 });
    tone({ freq: N.E5, slideTo: N.C6, type: 'sine', dur: 0.34, vol: 0.07, attack: 0.03, send: 0.35 });
    metal({ freq: N.A5, vol: 0.03, dur: 0.4, delay: 0.05, send: 0.35 });
    noise({ dur: 0.3, vol: 0.03, filter: 4200, type: 'bandpass', q: 0.9, attack: 0.08, send: 0.35 });
  },

  /** Level up fanfare: an A-minor arpeggio on the audio clock, not on timers. */
  levelUp() {
    const c = ensure();
    if (!c || muted) return;
    const steps = [N.A4, N.C5, N.E5, N.A5];
    steps.forEach((f, i) => {
      const d = i * 0.085;
      tone({ freq: f, type: 'triangle', dur: 0.3, vol: 0.14, attack: 0.006, delay: d, send: 0.35, echo: 1 });
      // A quiet octave above each note gives the arpeggio sparkle without
      // adding any perceived loudness.
      tone({ freq: f * 2, type: 'sine', dur: 0.22, vol: 0.045, delay: d, send: 0.5 });
      click({ vol: 0.03, freq: 7000, dur: 0.004, delay: d });
    });
    // Landing chord under the run so it resolves rather than just stopping.
    tone({ freq: N.A3, type: 'sawtooth', dur: 0.7, vol: 0.07, attack: 0.05, filter: 900, filterTo: 300, delay: 0.25, send: 0.5 });
    tone({ freq: N.E4, type: 'sawtooth', dur: 0.65, vol: 0.05, attack: 0.06, filter: 900, filterTo: 300, delay: 0.25, send: 0.5 });
  },

  /** Splintering wood: a burst of randomly timed shards over a box thump. */
  chestBreak() {
    const c = ensure();
    if (!c || muted) return;
    const p = rnd(-0.3, 0.3);
    click({ vol: 0.16, freq: 2400, dur: 0.009, pan: p });
    tone({ freq: 175 * jit(0.08), slideTo: 58, type: 'square', dur: 0.2, vol: 0.11, filter: 1100, filterTo: 220, pan: p, send: 0.22 });
    noise({ dur: 0.28, vol: 0.16, filter: 2400, sweepTo: 380, q: 0.9, pan: p, send: 0.22 });
    // Five short shards at random times and pitches. Scattering them is what
    // makes it wood breaking rather than one noise envelope opening.
    for (let i = 0; i < 5; i++) {
      noise({
        dur: rnd(0.02, 0.05), vol: rnd(0.03, 0.07), filter: rnd(1600, 5200),
        type: 'bandpass', q: rnd(3, 7), delay: rnd(0.02, 0.24),
        pan: rnd(-0.6, 0.6), send: 0.22,
      });
    }
  },

  /** Boss arrival: sub sweep, detuned choir of saws, and a long dark tail. */
  bossSpawn() {
    const c = ensure();
    if (!c || muted) return;
    // Sub first and alone for a beat — nothing else in the game occupies below
    // 50Hz, so this is the one place the mix has room to feel genuinely large.
    tone({ freq: 68, slideTo: 30, type: 'sine', dur: 1.7, vol: 0.26, attack: 0.12 });
    [-9, 0, 11].forEach((det, i) => {
      tone({
        freq: 55, type: 'sawtooth', dur: 1.6 - i * 0.1, vol: 0.09, attack: 0.25,
        detune: det, filter: 240, filterTo: 900, q: 4, delay: i * 0.04, send: 0.5,
      });
    });
    noise({ dur: 1.5, vol: 0.13, filter: 300, sweepTo: 70, attack: 0.4, send: 0.5 });
    // A struck-iron hit landing late, drenched, gives the whole thing a room.
    metal({ freq: 138, vol: 0.06, dur: 1.1, delay: 0.24, send: 0.5 });
    tone({ freq: 110, slideTo: 55, type: 'square', dur: 1.0, vol: 0.1, filter: 700, filterTo: 200, delay: 0.22, send: 0.5, echo: 1 });
  },

  /** Boss death: a descending collapse that falls apart as it goes. */
  bossDie() {
    const c = ensure();
    if (!c || muted) return;
    [N.E4, N.C4, N.A3, N.E3].forEach((f, i) => {
      const d = i * 0.135;
      tone({ freq: f, slideTo: f * 0.5, type: 'sawtooth', dur: 0.55, vol: 0.15, detune: -7, filter: 1800, filterTo: 300, delay: d, send: 0.5 });
      tone({ freq: f, slideTo: f * 0.5, type: 'sawtooth', dur: 0.5, vol: 0.1, detune: 8, delay: d + 0.01, send: 0.5 });
      click({ vol: 0.06, freq: 3000, dur: 0.007, delay: d });
    });
    noise({ dur: 1.3, vol: 0.18, filter: 1800, sweepTo: 110, q: 0.8, send: 0.5, echo: 1 });
    tone({ freq: 90, slideTo: 26, type: 'sine', dur: 1.5, vol: 0.2, delay: 0.35 });
    // Debris scattered through the tail so the collapse keeps decaying instead
    // of ending on a clean fade.
    for (let i = 0; i < 6; i++) {
      noise({ dur: rnd(0.03, 0.08), vol: rnd(0.02, 0.05), filter: rnd(900, 4200), type: 'bandpass', q: rnd(2, 6), delay: rnd(0.2, 1.0), pan: rnd(-0.7, 0.7), send: 0.5 });
    }
  },

  /** Explosion: crack, broadband body, sub drop, debris. */
  explode() {
    const c = ensure();
    if (!c || muted) return;
    if (!gate('explode', 45)) return;
    const p = rnd(-0.35, 0.35);
    const j = jit(0.12);
    click({ vol: 0.2, freq: 3000, dur: 0.008, pan: p });
    // Two noise layers with different decay rates: a fast bright crack over a
    // slow dark roar is the shape of every real blast.
    noise({ dur: 0.14, vol: 0.16, filter: 5000, sweepTo: 900, type: 'highpass', q: 0.7, pan: p, send: 0.22 });
    noise({ dur: 0.5, vol: 0.19, filter: 1100 * j, sweepTo: 85, q: 1.1, pan: p, send: 0.5, echo: 1 });
    tone({ freq: 92 * j, slideTo: 32, type: 'square', dur: 0.34, vol: 0.13, filter: 600, filterTo: 120, pan: p });
    tone({ freq: 55 * j, slideTo: 24, type: 'sine', dur: 0.45, vol: 0.13, pan: p });
    for (let i = 0; i < 3; i++) {
      noise({ dur: rnd(0.02, 0.05), vol: rnd(0.02, 0.04), filter: rnd(1400, 4600), type: 'bandpass', q: 4, delay: rnd(0.06, 0.3), pan: rnd(-0.7, 0.7), send: 0.5 });
    }
  },

  /** Flame tick: airy hiss plus an occasional crackle. Must stay in the back. */
  fire() {
    const c = ensure();
    if (!c || muted) return;
    if (!gate('fire', 60)) return;
    const p = rnd(-0.5, 0.5);
    noise({ dur: 0.3, vol: 0.06, filter: rnd(700, 1200), type: 'bandpass', q: 0.7, attack: 0.06, pan: p, send: 0.22 });
    noise({ dur: 0.2, vol: 0.025, filter: rnd(3000, 5000), type: 'bandpass', q: 1.4, attack: 0.04, pan: -p, send: 0.22 });
    // Crackle only sometimes: a pop on every single tick becomes a rhythm, and
    // a rhythm at this repeat rate is the fastest way to make fire sound fake.
    if (Math.random() < 0.35) {
      noise({ dur: 0.015, vol: 0.05, filter: rnd(2000, 6000), type: 'bandpass', q: 6, delay: rnd(0, 0.2), pan: p });
    }
  },

  /** Holy damage: consonant, slow, and very wet — the opposite of the impacts. */
  holy() {
    const c = ensure();
    if (!c || muted) return;
    if (!gate('holy', 70)) return;
    // Stacked fifths and octaves off the drone's root, so it can ring for half
    // a second over anything else playing without clashing.
    tone({ freq: N.C6, type: 'sine', dur: 0.5, vol: 0.075, attack: 0.03, send: 0.5, echo: 1 });
    tone({ freq: N.G5, type: 'sine', dur: 0.6, vol: 0.05, attack: 0.05, send: 0.5 });
    tone({ freq: N.E6, type: 'sine', dur: 0.45, vol: 0.035, attack: 0.02, detune: rnd(-6, 6), send: 0.5 });
    metal({ freq: N.A6, vol: 0.018, dur: 0.5, send: 0.5 });
    noise({ dur: 0.5, vol: 0.022, filter: 6000, type: 'bandpass', q: 0.8, attack: 0.12, send: 0.5 });
  },

  /** Death stinger: a slow descending minor line with a long room on it. */
  gameOver() {
    const c = ensure();
    if (!c || muted) return;
    [N.A3, N.G3, N.E3, N.A2].forEach((f, i) => {
      const d = i * 0.27;
      tone({ freq: f, type: 'sawtooth', dur: 0.75, vol: 0.14, attack: 0.04, detune: -6, filter: 1200, filterTo: 260, delay: d, send: 0.5, echo: 1 });
      tone({ freq: f, type: 'sawtooth', dur: 0.7, vol: 0.09, attack: 0.05, detune: 9, delay: d + 0.02, send: 0.5 });
    });
    // Sub pedal under the whole line so the stinger has floor.
    tone({ freq: 55, slideTo: 41, type: 'sine', dur: 1.8, vol: 0.12, attack: 0.3 });
    noise({ dur: 1.6, vol: 0.04, filter: 500, sweepTo: 140, attack: 0.5, send: 0.5 });
  },

  /** UI confirm. Short, in-scale, and quiet enough to press repeatedly. */
  select() {
    const c = ensure();
    if (!c || muted) return;
    click({ vol: 0.05, freq: 6000, dur: 0.004 });
    tone({ freq: N.E5, slideTo: N.A5, type: 'triangle', dur: 0.085, vol: 0.1, send: 0.1 });
    tone({ freq: N.A5, slideTo: N.E6, type: 'sine', dur: 0.07, vol: 0.035, delay: 0.02, send: 0.1 });
  },

  // --- Additions ----------------------------------------------------------

  /** Footfall on soft forest floor. Gated hard — it can fire every few frames. */
  footstep() {
    const c = ensure();
    if (!c || muted) return;
    if (!gate('footstep', 90)) return;
    const p = rnd(-0.25, 0.25);
    const j = jit(0.15);
    noise({ dur: 0.05, vol: 0.045, filter: 900 * j, sweepTo: 300, q: 1.2, attack: 0.002, pan: p });
    tone({ freq: 74 * j, slideTo: 44, type: 'sine', dur: 0.06, vol: 0.05, pan: p });
    // Loose grit on top, only sometimes, so successive steps differ.
    if (Math.random() < 0.5) {
      noise({ dur: 0.03, vol: 0.02, filter: rnd(3000, 6000), type: 'highpass', delay: 0.01, pan: p });
    }
  },

  /** Dodge / dash: a cloth-and-air rush with no impact at all. */
  dodge() {
    const c = ensure();
    if (!c || muted) return;
    if (!gate('dodge', 120)) return;
    const p = rnd(-0.3, 0.3);
    noise({ dur: 0.22, vol: 0.1, filter: 2600, sweepTo: 420, type: 'bandpass', q: 1.6, attack: 0.03, pan: p, send: 0.12 });
    noise({ dur: 0.16, vol: 0.04, filter: 5500, sweepTo: 2000, type: 'highpass', attack: 0.04, pan: -p });
    tone({ freq: 210, slideTo: 90, type: 'sine', dur: 0.18, vol: 0.05, attack: 0.03, pan: p });
  },
};
