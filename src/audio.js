/**
 * All sound is synthesised with WebAudio at runtime — the game ships with zero
 * audio assets, which keeps the Portals bundle tiny and load times instant.
 */

let ctx = null;
let master = null;
let musicGain = null;
let sfxGain = null;
let started = false;
let muted = false;
let droneNodes = [];

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(ctx.destination);

  sfxGain = ctx.createGain();
  sfxGain.gain.value = 0.7;
  sfxGain.connect(master);

  musicGain = ctx.createGain();
  musicGain.gain.value = 0.0;
  musicGain.connect(master);
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

function env(node, t0, attack, decay, peak = 1) {
  node.gain.setValueAtTime(0.0001, t0);
  node.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + attack);
  node.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

function tone({ freq = 440, type = 'sine', dur = 0.15, attack = 0.005, vol = 0.3, slideTo = null, detune = 0 }) {
  const c = ensure();
  if (!c || muted) return;
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (detune) osc.detune.setValueAtTime(detune, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
  env(g, t0, attack, dur, vol);
  osc.connect(g).connect(sfxGain);
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

function noise({ dur = 0.2, vol = 0.25, filter = 900, type = 'lowpass', q = 1, sweepTo = null }) {
  const c = ensure();
  if (!c || muted) return;
  const buf = getNoise();
  if (!buf) return;
  const t0 = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const bq = c.createBiquadFilter();
  bq.type = type;
  bq.frequency.setValueAtTime(filter, t0);
  bq.Q.value = q;
  if (sweepTo) bq.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t0 + dur);
  const g = c.createGain();
  env(g, t0, 0.004, dur, vol);
  src.connect(bq).connect(g).connect(sfxGain);
  src.start(t0);
  src.stop(t0 + dur + 0.1);
}

/** Low ambient bed — two detuned saws through a slow filter sweep. */
function startDrone() {
  const c = ensure();
  if (!c) return;
  musicGain.gain.setTargetAtTime(0.12, c.currentTime, 3);
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 320;
  filter.Q.value = 3;
  filter.connect(musicGain);

  [55, 55.4, 82.5].forEach((f, i) => {
    const o = c.createOscillator();
    o.type = i === 2 ? 'triangle' : 'sawtooth';
    o.frequency.value = f;
    const g = c.createGain();
    g.gain.value = i === 2 ? 0.12 : 0.2;
    o.connect(g).connect(filter);
    o.start();
    droneNodes.push(o);
  });

  // Slow LFO on the filter so the bed breathes instead of sitting flat.
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.05;
  const lfoGain = c.createGain();
  lfoGain.gain.value = 160;
  lfo.connect(lfoGain).connect(filter.frequency);
  lfo.start();
  droneNodes.push(lfo);
}

export function setMusicIntensity(v) {
  const c = ensure();
  if (!c || !musicGain) return;
  musicGain.gain.setTargetAtTime(0.08 + v * 0.14, c.currentTime, 1.5);
}

// ---------------------------------------------------------------------------
// Named one-shots. Kept deliberately terse — each is a couple of oscillators.
// ---------------------------------------------------------------------------

let lastHit = 0;
export const SFX = {
  punch() {
    noise({ dur: 0.09, vol: 0.18, filter: 1400, sweepTo: 300 });
    tone({ freq: 160, slideTo: 70, type: 'square', dur: 0.08, vol: 0.12 });
  },
  slash() {
    noise({ dur: 0.16, vol: 0.2, filter: 3200, sweepTo: 700, type: 'bandpass', q: 1.5 });
  },
  throwKnife() {
    tone({ freq: 900, slideTo: 400, type: 'triangle', dur: 0.1, vol: 0.12 });
  },
  hit() {
    // Rate-limited: with 300 enemies on screen this fires constantly.
    const now = performance.now();
    if (now - lastHit < 45) return;
    lastHit = now;
    noise({ dur: 0.06, vol: 0.13, filter: 2200, sweepTo: 600 });
  },
  kill() {
    tone({ freq: 220, slideTo: 90, type: 'sawtooth', dur: 0.14, vol: 0.1 });
    noise({ dur: 0.12, vol: 0.12, filter: 800, sweepTo: 180 });
  },
  playerHurt() {
    tone({ freq: 300, slideTo: 120, type: 'square', dur: 0.22, vol: 0.22 });
    noise({ dur: 0.2, vol: 0.16, filter: 500 });
  },
  pickup() {
    tone({ freq: 780, slideTo: 1180, type: 'sine', dur: 0.08, vol: 0.1 });
  },
  health() {
    tone({ freq: 520, slideTo: 880, type: 'sine', dur: 0.22, vol: 0.18 });
    tone({ freq: 660, slideTo: 1100, type: 'sine', dur: 0.26, vol: 0.1 });
  },
  levelUp() {
    [523, 659, 784, 1047].forEach((f, i) => {
      setTimeout(() => tone({ freq: f, type: 'triangle', dur: 0.28, vol: 0.2 }), i * 85);
    });
  },
  chestBreak() {
    noise({ dur: 0.3, vol: 0.28, filter: 2600, sweepTo: 400 });
    tone({ freq: 180, slideTo: 60, type: 'square', dur: 0.2, vol: 0.14 });
  },
  bossSpawn() {
    tone({ freq: 70, slideTo: 44, type: 'sawtooth', dur: 1.6, vol: 0.3 });
    noise({ dur: 1.4, vol: 0.2, filter: 260, sweepTo: 80 });
    setTimeout(() => tone({ freq: 110, slideTo: 55, type: 'square', dur: 1.0, vol: 0.16 }), 220);
  },
  bossDie() {
    [330, 262, 196, 131].forEach((f, i) => {
      setTimeout(() => tone({ freq: f, slideTo: f * 0.5, type: 'sawtooth', dur: 0.5, vol: 0.22 }), i * 130);
    });
    noise({ dur: 1.2, vol: 0.3, filter: 1600, sweepTo: 120 });
  },
  explode() {
    noise({ dur: 0.5, vol: 0.3, filter: 1200, sweepTo: 90 });
    tone({ freq: 90, slideTo: 35, type: 'square', dur: 0.35, vol: 0.18 });
  },
  fire() {
    noise({ dur: 0.3, vol: 0.09, filter: 900, type: 'bandpass', q: 0.8 });
  },
  holy() {
    tone({ freq: 1046, type: 'sine', dur: 0.5, vol: 0.12 });
    tone({ freq: 1568, type: 'sine', dur: 0.6, vol: 0.07 });
  },
  gameOver() {
    [220, 175, 147, 110].forEach((f, i) => {
      setTimeout(() => tone({ freq: f, type: 'sawtooth', dur: 0.7, vol: 0.22 }), i * 260);
    });
  },
  select() {
    tone({ freq: 660, slideTo: 990, type: 'square', dur: 0.09, vol: 0.12 });
  },
};
