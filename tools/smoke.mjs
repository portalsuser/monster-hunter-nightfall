/**
 * Headless smoke test.
 *
 * Boots the real game against tools/mock-three.mjs and a minimal DOM, then
 * simulates a full-length run at a fixed timestep: movement, hordes, four boss
 * cycles, every weapon and passive force-fed, chest breaks, level ups, death
 * and restart.
 *
 *   node tools/smoke.mjs
 *
 * Exits non-zero on any thrown error, console.error, unhandled rejection, or
 * failed invariant.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// --- Resolve the bare 'three' specifier to the mock -------------------------
// Node walks up from src/ looking for node_modules, so the shim goes at the
// repo root. It is gitignored and rebuilt on every run.
const shimDir = path.join(ROOT, 'node_modules', 'three');
fs.mkdirSync(shimDir, { recursive: true });
fs.writeFileSync(path.join(shimDir, 'package.json'), JSON.stringify({
  name: 'three', version: '0.0.0-mock', type: 'module', main: 'index.mjs', exports: './index.mjs',
}, null, 2));
fs.writeFileSync(
  path.join(shimDir, 'index.mjs'),
  `export * from ${JSON.stringify(path.join(HERE, 'mock-three.mjs'))};\n`
);

// --- Failure collection -----------------------------------------------------
const failures = [];
const warnings = [];
function fail(msg) { failures.push(msg); }

const realError = console.error;
console.error = (...a) => { fail(`console.error: ${a.join(' ')}`); realError('  [captured]', ...a); };
console.warn = (...a) => { warnings.push(a.join(' ')); };
process.on('unhandledRejection', (e) => fail(`unhandledRejection: ${e && e.stack || e}`));

// --- Minimal DOM ------------------------------------------------------------
function makeCtx2D() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    fillRect() {}, strokeRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {},
    stroke() {}, moveTo() {}, lineTo() {}, fillText() {}, strokeText() {},
    createRadialGradient() { return { addColorStop() {} }; },
    createLinearGradient() { return { addColorStop() {} }; },
    getImageData() { return { data: new Uint8ClampedArray(4) }; },
    putImageData() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
  };
}

class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = new Proxy({ setProperty(k, v) { this[k] = v; } }, {});
    this.dataset = {};
    this.classes = new Set();
    this._text = '';
    this._html = '';
    this.width = 256;
    this.height = 256;
    this.handlers = {};
    this.classList = {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
      toggle: (c, on) => { if (on === undefined) { this.classes.has(c) ? this.classes.delete(c) : this.classes.add(c); } else if (on) this.classes.add(c); else this.classes.delete(c); },
      contains: (c) => this.classes.has(c),
    };
    this.style.setProperty = () => {};
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children.length = 0; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
  remove() {}
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  removeEventListener() {}
  getContext(kind) { return kind === '2d' ? makeCtx2D() : null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; }
  click() { (this.handlers.click || []).forEach((f) => f({ currentTarget: this })); }
  focus() {}
}

const registry = new Map();
const document_ = {
  body: new El('body'),
  head: new El('head'),
  documentElement: new El('html'),
  getElementById(id) {
    if (!registry.has(id)) registry.set(id, new El());
    return registry.get(id);
  },
  createElement(tag) { return new El(tag); },
  addEventListener() {}, removeEventListener() {},
  querySelector() { return new El(); },
};

let now = 0;
const listeners = {};
const window_ = {
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  WebGLRenderingContext: function () {},
  addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
  removeEventListener() {},
  requestAnimationFrame() { return 0; },
  cancelAnimationFrame() {},
  localStorage: {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  },
  navigator: { getGamepads: () => [], userAgent: 'node' },
  // No AudioContext: the audio module is written to no-op when it is absent,
  // which is exactly the path we want to confirm never throws.
};

globalThis.window = window_;
globalThis.document = document_;
// Node 22 defines a getter-only global `navigator`; override the descriptor.
Object.defineProperty(globalThis, 'navigator', {
  value: window_.navigator, writable: true, configurable: true,
});
globalThis.localStorage = window_.localStorage;
globalThis.performance = { now: () => now };
globalThis.requestAnimationFrame = window_.requestAnimationFrame;

// setTimeout is used for weapon follow-up swings; run them synchronously on the
// next simulated frame instead of on real wall-clock time.
const timers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; };
function drainTimers() {
  for (let i = timers.length - 1; i >= 0; i--) {
    if (timers[i].at <= now) {
      const t = timers.splice(i, 1)[0];
      try { t.fn(); } catch (e) { fail(`timer callback threw: ${e.stack || e}`); }
    }
  }
}

// --- Boot -------------------------------------------------------------------
const { WEAPONS, PASSIVES } = await import('../src/weapons.js');
const { CFG } = await import('../src/config.js');
await import('../src/main.js');

const game = window_.__game;
if (!game) {
  realError('FATAL: game did not construct');
  process.exit(1);
}

// --- Simulation harness -----------------------------------------------------
const DT = 1 / 60;
function frame(input = { x: 0, z: 0 }) {
  now += DT * 1000;
  game.input.update = () => input;      // deterministic movement
  game.input.consumePause = () => false;
  drainTimers();
  try {
    game._loop();
  } catch (e) {
    fail(`frame threw at t=${game.elapsed.toFixed(2)}s: ${e.stack || e}`);
    throw e;
  }
}

/** Auto-pick the first card whenever a level up opens. */
let picks = 0;
const origShowLevelUp = game.hud.showLevelUp.bind(game.hud);
const autoPickLevelUp = (cards, remaining, onPick) => {
  origShowLevelUp(cards, remaining, onPick);
  if (!cards.length) fail('level up offered zero cards');
  for (const c of cards) {
    if (!c.name || !c.text) fail(`malformed card: ${JSON.stringify(c)}`);
  }
  picks++;
  // Pick something we do not own yet when possible, to widen coverage.
  const fresh = cards.find((c) => c.isNew) || cards[0];
  realSetTimeout(() => {}, 0);
  onPick(fresh);
};
game.hud.showLevelUp = autoPickLevelUp;


// --- NaN tripwire (debug) ---------------------------------------------------
if (process.env.NANPROBE) {
  const origSim = game.enemies._simEnemy.bind(game.enemies);
  game.enemies._simEnemy = (e, dt, player, px, pz, d2, el) => {
    const before = { x: e.x, z: e.z, kx: e.kx, kz: e.kz, sp: e.speed };
    origSim(e, dt, player, px, pz, d2, el);
    if (!Number.isFinite(e.x) || !Number.isFinite(e.z)) {
      realError('NaN introduced in _simEnemy', e.key, 'before=', before,
        'after=', { x: e.x, z: e.z, kx: e.kx, kz: e.kz },
        'player=', { x: player.pos.x, z: player.pos.z, vx: player.vel.x, vz: player.vel.z, facing: player.facing },
        'pvx=', game.enemies._pvx, game.enemies._pvz);
      process.exit(9);
    }
  };
  const origSpawn = game.enemies.spawnOne.bind(game.enemies);
  game.enemies.spawnOne = (k, x, z, el, so) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      realError('NaN at spawnOne', k, x, z, 'playerVel=', game.player.vel.x, game.player.vel.z,
        'facing=', game.player.facing, 'speed=', game.player.stats.speed);
      process.exit(9);
    }
    return origSpawn(k, x, z, el, so);
  };
}

console.log('▶ booting…');
game.start();
if (game.state !== 'playing') fail(`start() left state=${game.state}`);

// --- Phase 1: 30 s of normal play, wandering ---------------------------------
let steps = 0;

/**
 * Stand-in for a competent player: drift on a slow arc, but break away from
 * whatever is closest once it gets inside kiting range. A blind circler walks
 * straight into the horde and dies, which tells us nothing about balance.
 */
const KITE = () => {
  // Slow orbital drift so the hunter keeps meeting fresh spawns...
  let ax = Math.cos(steps * 0.004);
  let az = Math.sin(steps * 0.004);
  // ...plus a short-range shove away from anything about to land a hit. The
  // radius is deliberately just under the fists' reach (2.4) so the sim still
  // trades blows instead of running a marathon — a bot that never fights
  // measures nothing.
  const p = game.player.pos;
  let fx = 0, fz = 0, n = 0;
  for (const e of game.enemies.enemies) {
    const dx = p.x - e.x, dz = p.z - e.z;
    const d = Math.hypot(dx, dz);
    if (d < 2.2 && d > 0.01) { fx += dx / d; fz += dz / d; n++; }
  }
  if (n) { ax += (fx / n) * 1.6; az += (fz / n) * 1.6; }
  const l = Math.hypot(ax, az) || 1;
  return { x: ax / l, z: az / l };
};

console.log('▶ phase 1 — 60s of open play with fists only');
for (let i = 0; i < 60 * 60; i++) { frame(KITE()); steps++; }
if (game.enemies.enemies.length === 0) fail('no enemies spawned in the first 60s');
if (game.enemies.totalKills === 0) fail('fists killed nothing in 60s');
// Balance guard: the opening minute must be survivable with the starting kit.
if (!game.player.alive) {
  fail(`player died at ${game.elapsed.toFixed(1)}s with only fists — opening is too punishing`);
}
if (game.player.levelUps < 2) {
  fail(`only ${game.player.levelUps} level ups in the first 60s — progression is too slow`);
}
console.log(`   alive=${game.player.alive} hp=${Math.ceil(game.player.hp)}/${game.player.maxHp} enemies=${game.enemies.enemies.length} kills=${game.enemies.totalKills} picks=${picks}`);

// --- Phase 2: force-feed every weapon and passive -----------------------------
console.log('▶ phase 2 — every weapon and passive at max level');
for (const key of Object.keys(WEAPONS)) {
  for (let l = 0; l < WEAPONS[key].maxLevel; l++) game.weapons.addOrLevel(key);
}
for (const key of Object.keys(PASSIVES)) {
  for (let l = 0; l < PASSIVES[key].maxLevel; l++) game.weapons.addOrLevel(key);
}
for (const [key, w] of game.weapons.owned) {
  if (w.level !== WEAPONS[key].maxLevel) fail(`${key} capped at ${w.level}, expected ${WEAPONS[key].maxLevel}`);
}
// Make the hunter unkillable so the long run actually reaches the bosses.
game.player.stats.maxHp = 1e9;
game.player.stats.hp = 1e9;

for (let i = 0; i < 60 * 20; i++) { frame(KITE()); steps++; }
console.log(`   all ${game.weapons.owned.size} weapons + ${game.weapons.passives.size} passives firing`);

// --- Phase 3: run past four boss spawns --------------------------------------
console.log('▶ phase 3 — four boss cycles (12+ simulated minutes)');
const targetTime = CFG.FIRST_BOSS_AT * 4 + 40;
let guard = 0;
while (game.elapsed < targetTime && guard++ < 60 * 60 * 20) {
  frame(KITE());
  steps++;
}
if (game.enemies.bossIndex < 4) fail(`only ${game.enemies.bossIndex} bosses spawned in ${game.elapsed | 0}s`);
if (game.bossesKilled === 0) fail('no boss was ever killed despite max weapons');
console.log(`   bosses spawned=${game.enemies.bossIndex} killed=${game.bossesKilled} kills=${game.enemies.totalKills}`);

// --- Invariants --------------------------------------------------------------
console.log('▶ checking invariants');

if (game.player.levelUps > CFG.MAX_LEVEL_UPS) {
  fail(`levelUps ${game.player.levelUps} exceeded the cap of ${CFG.MAX_LEVEL_UPS}`);
}
// The slot cap is enforced by the upgrade roller, not addOrLevel (phase 2
// force-feeds every weapon directly, deliberately bypassing it). Assert the
// roller itself never offers a brand new weapon once the slots are full.
{
  const { rollUpgrades, MAX_WEAPONS } = await import('../src/upgrades.js');
  let offendingOffers = 0;
  for (let i = 0; i < 300; i++) {
    for (const c of rollUpgrades(game.weapons, game.player, 3)) {
      if (c.kind === 'weapon' && c.isNew && game.weapons.owned.size >= MAX_WEAPONS) offendingOffers++;
    }
  }
  if (offendingOffers) fail(`upgrade roller offered ${offendingOffers} new weapons past the ${MAX_WEAPONS}-slot cap`);
}

// Pools must not leak across a long run.
const leaks = [
  ['vfx particles', game.vfx.particles.filter((p) => p.alive).length, CFG.MAX_PARTICLES],
  ['weapon projectiles', game.weapons.projectiles.filter((p) => p.alive).length, 220],
  ['enemy projectiles', game.enemies.projectiles.filter((p) => p.alive).length, 110],
  ['ground effects', game.weapons.grounds.filter((g) => g.alive).length, 22],
  ['part drops', game.pickups.parts.length, 460 * 3],
  ['health drops', game.pickups.healths.length, 40],
];
for (const [name, n, cap] of leaks) {
  if (n > cap) fail(`${name} leaked: ${n} > ${cap}`);
}
console.log('   pools: ' + leaks.map(([n, v]) => `${n}=${v}`).join(', '));

// Every enemy must be inside the despawn radius of the player.
let strays = 0;
for (const e of game.enemies.enemies) {
  const d = Math.hypot(e.x - game.player.pos.x, e.z - game.player.pos.z);
  if (d > CFG.SPAWN.despawnRadius + 5) strays++;
  if (!Number.isFinite(e.x) || !Number.isFinite(e.z)) fail(`enemy ${e.key} has NaN position`);
}
if (strays > 0) fail(`${strays} enemies escaped the despawn radius`);
if (!Number.isFinite(game.player.pos.x)) fail('player position went NaN');

// Instanced draw counts must stay within capacity (the mock renderer asserts
// this every frame too, but check the final state explicitly).
for (const key of game.enemies.typeKeys) {
  const b = game.enemies.render[key];
  for (const m of b.meshes) {
    if (m.count > m.capacity) fail(`${key} instance count ${m.count} > ${m.capacity}`);
  }
}

// --- Phase 4: chests ---------------------------------------------------------
console.log('▶ phase 4 — chest loot table');
const outcomes = { parts: 0, health: 0, levelUp: 0 };
const realGrant = game.grantLevelUp.bind(game);
game.grantLevelUp = () => { outcomes.levelUp++; return true; };
const beforeParts = game.pickups.parts.length;
for (let i = 0; i < 400; i++) {
  const c = game.pickups.spawnChest(game.player.pos);
  if (!c) { game.pickups.chests.forEach((ch) => { ch.alive = false; }); continue; }
  game.pickups.breakChest(c);
}
game.grantLevelUp = realGrant;
if (outcomes.levelUp === 0) fail('400 chests never rolled a level up');
if (outcomes.levelUp > 120) fail(`level-up chests far too common: ${outcomes.levelUp}/400`);
console.log(`   400 chests → ${outcomes.levelUp} level ups (~${(outcomes.levelUp / 4).toFixed(1)}%), parts added=${game.pickups.parts.length - beforeParts}`);

// --- Phase 5: level cap ------------------------------------------------------
console.log('▶ phase 5 — level-up cap');
game.player.levelUps = CFG.MAX_LEVEL_UPS;
game.pendingLevelUps = 0;
const granted = game.grantLevelUp('test');
if (granted) fail('grantLevelUp() handed out a 21st enhancement');
game.queueLevelUps(5);
if (game.pendingLevelUps !== 0) fail(`queueLevelUps ignored the cap: pending=${game.pendingLevelUps}`);
console.log('   cap holds at 20');

// --- Phase 6: death and restart ---------------------------------------------
console.log('▶ phase 6 — death, results, restart');
game.player.stats.maxHp = 100;
game.player.stats.hp = 1;
game.player.stats.armor = 0;
game.player.stats.revives = 0;
game.player.invuln = 0;
game.hitPlayer(9999);
if (game.player.alive) fail('player survived a 9999 hit with 1 hp');
if (game.state !== 'over') fail(`expected state=over, got ${game.state}`);
if (!(game.score > 0)) fail(`score was ${game.score}`);
for (let i = 0; i < 30; i++) frame();

game.restart();
if (game.state !== 'playing') fail(`restart() left state=${game.state}`);
if (game.elapsed !== 0) fail(`restart() did not reset elapsed (${game.elapsed})`);
if (game.enemies.enemies.length !== 0) fail('restart() left enemies alive');
if (game.pickups.parts.length !== 0) fail('restart() left part drops on the floor');
if (game.weapons.owned.size !== 1 || !game.weapons.owned.has('fists')) {
  fail(`restart() should leave only fists, got [${[...game.weapons.owned.keys()].join(', ')}]`);
}
if (game.player.hp !== game.player.maxHp) fail('restart() did not restore health');
for (let i = 0; i < 60 * 25; i++) { frame(KITE()); steps++; }
if (game.enemies.totalKills === 0) fail('no kills after restart');
console.log(`   restarted cleanly, ${game.enemies.totalKills} kills in 25s`);

// --- Phase 7: frame cost under load -----------------------------------------
console.log('▶ phase 7 — frame cost with a saturated horde');
{
  game.restart();
  for (const key of Object.keys(WEAPONS)) {
    for (let l = 0; l < WEAPONS[key].maxLevel; l++) game.weapons.addOrLevel(key);
  }
  for (const key of Object.keys(PASSIVES)) {
    for (let l = 0; l < PASSIVES[key].maxLevel; l++) game.weapons.addOrLevel(key);
  }
  game.player.stats.maxHp = 1e9;
  game.player.stats.hp = 1e9;
  // Fast-forward the difficulty clock so waves arrive at late-run density.
  game.elapsed = 900;
  // Longer warm-up: the standing population takes a while to reach steady
  // state now that monsters are larger (separation spreads them out) and
  // hit-stop slightly slows the clock.
  for (let i = 0; i < 60 * 45; i++) { frame(KITE()); steps++; }

  // Sample the population across the whole timed window rather than at one
  // instant: kills arrive in bursts, so a single reading swings by ±10 and
  // made this assertion flaky for reasons that had nothing to do with density.
  let popSum = 0;
  const t0 = process.hrtime.bigint();
  const N = 600;
  for (let i = 0; i < N; i++) { frame(KITE()); steps++; popSum += game.enemies.enemies.length; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  const alive = Math.round(popSum / N);
  console.log(`   ${alive} enemies alive (mean) · ${ms.toFixed(2)} ms/frame of game logic (excludes GPU)`);
  // Budget: at 60fps a frame is 16.7ms and the GPU needs most of it. Simulation
  // has to stay well under a third of that even at max density.
  if (ms > 5) fail(`simulation costs ${ms.toFixed(2)} ms/frame with ${alive} enemies — too slow for 60fps`);
  // This only guards against the timing above being measured on an empty map.
  // It is deliberately loose. The population swings with how well the kite
  // pattern happens to cull, and it dropped sharply once the rankPick fix let
  // Knives, Cross, Holy Water, Sigil and Fangs fire past rank 5 — a fully
  // ranked build now actually mows the horde down, which is the point.
  if (alive < 25) fail(`late-game horde only reached ${alive} enemies; the frame-cost measurement is not meaningful`);
}

// --- Phase 8: level-up integrity (regression) -------------------------------
// A stray second fire on one card screen used to spend TWO of the 20
// enhancements and drive pendingLevelUps negative, which silently swallowed
// every later level up — the XP bar filled and nothing happened, permanently.
console.log('\u25b6 phase 8 \u2014 level-up integrity');
{
  game.restart();
  game.player.levelUps = 0;
  game.pendingLevelUps = 0;

  // Double-fire the picker the way a double-click does.
  let opened = 0;
  game.hud.showLevelUp = (cards, remaining, onPick) => {
    opened++;
    game.hud._levelUpOpen = true;
    onPick(cards[0]);
    onPick(cards[0]);   // the stray one — must be ignored
    onPick(cards[0]);
  };

  for (let i = 0; i < 6; i++) game.queueLevelUps(1);

  if (game.pendingLevelUps < 0) {
    fail(`pendingLevelUps went negative (${game.pendingLevelUps}) after double-fires`);
  }
  if (game.player.levelUps !== opened) {
    fail(`${opened} card screens spent ${game.player.levelUps} picks — stray fires are being counted`);
  }
  if (opened !== 6) {
    fail(`6 queued level ups produced only ${opened} card screens`);
  }
  console.log(`   6 level ups, ${opened} card screens, ${game.player.levelUps} picks spent, pending=${game.pendingLevelUps}`);

  // And the watchdog must recover a queued level up that never opened.
  game.hud.showLevelUp = autoPickLevelUp;
  game.hud.hideLevelUp();
  game.state = 'playing';
  game.pendingLevelUps = 1;
  const before = game.player.levelUps;
  let recovered = false;
  game.hud.showLevelUp = (cards, remaining, onPick) => {
    recovered = true;
    game.hud._levelUpOpen = true;
    onPick(cards[0]);
  };
  for (let i = 0; i < 5 && !recovered; i++) frame();
  if (!recovered) fail('watchdog did not reopen a stranded level up');
  if (game.player.levelUps !== before + 1) fail('watchdog pick did not apply');
  game.hud.showLevelUp = autoPickLevelUp;
  console.log('   stranded level up recovered by the watchdog');

  // The 20 cap must still hold exactly.
  game.restart();
  game.player.levelUps = 0;
  game.pendingLevelUps = 0;
  game.hud.showLevelUp = (cards, remaining, onPick) => { game.hud._levelUpOpen = true; onPick(cards[0]); };
  const over = CFG.MAX_LEVEL_UPS + 25;
  for (let i = 0; i < over; i++) game.queueLevelUps(1);
  if (game.player.levelUps !== CFG.MAX_LEVEL_UPS) {
    fail(`${over} level ups produced ${game.player.levelUps} picks, expected exactly ${CFG.MAX_LEVEL_UPS}`);
  }
  console.log(`   ${over} level ups clamp to exactly ${game.player.levelUps} picks`);
  game.hud.showLevelUp = autoPickLevelUp;
  game.restart();
}

// --- Phase 9: dodge + stamina -------------------------------------------------
console.log('▶ phase 9 — dodge roll and stamina');
{
  game.restart();
  game.state = 'playing';
  const p = game.player;
  const st = p.stats;

  // A full pool must buy exactly the advertised number of rolls and no more.
  const expected = Math.floor(CFG.STAMINA.base / CFG.DODGE.cost);
  let rolls = 0;
  for (let i = 0; i < expected + 4; i++) {
    p.dodgeCd = 0; p.dodgeTime = 0;      // isolate the stamina gate from the cooldown
    if (p.dodge({ x: 1, z: 0 })) rolls++;
  }
  if (rolls !== expected) {
    fail(`a full stamina pool bought ${rolls} rolls, expected ${expected}`);
  }
  if (st.stamina < 0) fail(`stamina went negative (${st.stamina})`);

  // The cooldown must stop a mashed key from chaining rolls.
  game.restart();
  p.dodge({ x: 1, z: 0 });
  if (p.dodge({ x: 1, z: 0 })) fail('a second dodge started while the first was still running');

  // Travel. The number that matters is not the raw distance but how far the
  // roll clears you *beyond a normal stride over the same time* — the first
  // version covered 2.8 units against 1.0 of running, a net gain of under half
  // the hunter's height, and read on screen as nothing happening at all.
  game.restart();
  const RUN = { x: 1, z: 0 };
  const rollFrames = Math.ceil(CFG.DODGE.duration * 60);
  let a0 = p.pos.x;
  for (let i = 0; i < rollFrames; i++) frame(RUN);
  const runDist = Math.abs(p.pos.x - a0);

  game.restart();
  p.dodgeCd = 0;
  if (!p.dodge(RUN)) fail('dodge refused to start on a full stamina bar');
  a0 = p.pos.x;
  let guard = 0;
  while (p.dodgeTime > 0 && guard++ < 200) frame(RUN);
  const rollDist = Math.abs(p.pos.x - a0);
  if (guard >= 200) fail('dodge never ended');
  if (!Number.isFinite(p.pos.x) || !Number.isFinite(p.pos.z)) fail('dodge produced a NaN position');

  // The hunter is 2 units tall at 1x and CFG.SCALE.player scales him up, so a
  // roll has to clear at least one body length past a stride to be legible.
  const bodyLength = 2 * CFG.SCALE.player;
  const gain = rollDist - runDist;
  if (gain < bodyLength) {
    fail(`a roll clears only ${gain.toFixed(2)} units past a normal stride `
      + `(${rollDist.toFixed(2)} vs ${runDist.toFixed(2)}); needs at least one `
      + `body length (${bodyLength}) to be visible`);
  }
  console.log(`   roll covers ${rollDist.toFixed(1)}u vs ${runDist.toFixed(1)}u running `
    + `— ${(gain / bodyLength).toFixed(1)} body lengths of daylight`);

  // I-frames: damage during the roll must be fully absorbed.
  game.restart();
  p.invuln = 0;
  p.dodge({ x: 0, z: 1 });
  const hpBefore = st.hp;
  if (p.damage(40) !== 0 || st.hp !== hpBefore) fail('dodge i-frames did not absorb a hit');
  if (p.invuln < CFG.DODGE.iframes - 1e-6) {
    fail(`dodge granted ${p.invuln.toFixed(2)}s of i-frames, expected ${CFG.DODGE.iframes}`);
  }
  // ...and must expire, or the roll would be permanent safety.
  for (let i = 0; i < 60 && p.invuln > 0; i++) frame();
  if (p.damage(10) === 0) fail('i-frames never expired');

  // Regen refills the pool, and never past the cap.
  game.restart();
  st.stamina = 0;
  for (let i = 0; i < 60 * 12; i++) frame();
  if (st.stamina !== st.staminaMax) {
    fail(`stamina refilled to ${st.stamina.toFixed(1)} of ${st.staminaMax} after 12s`);
  }

  // Sure-Footed: 5 ranks, each worth capacity, and it must not exceed 5.
  game.restart();
  const baseMax = st.staminaMax;
  for (let i = 0; i < 12; i++) game.weapons.addOrLevel('stamina');
  const rank = game.weapons.passives.get('stamina');
  if (rank !== CFG.STAMINA.maxRank) {
    fail(`Sure-Footed reached rank ${rank}, expected a hard cap of ${CFG.STAMINA.maxRank}`);
  }
  const wantMax = CFG.STAMINA.base + CFG.STAMINA.maxRank * CFG.STAMINA.perRank;
  if (st.staminaMax !== wantMax) fail(`maxed Sure-Footed gave ${st.staminaMax} stamina, expected ${wantMax}`);
  if (st.staminaMax <= baseMax) fail('Sure-Footed did not raise maximum stamina');
  if (st.staminaRegen <= CFG.STAMINA.regen) fail('Sure-Footed did not raise stamina regeneration');

  let maxRolls = 0;
  for (let i = 0; i < 20; i++) { p.dodgeCd = 0; p.dodgeTime = 0; if (p.dodge({ x: 1, z: 0 })) maxRolls++; }
  if (maxRolls <= expected) fail(`maxed Sure-Footed bought ${maxRolls} rolls, no better than the base ${expected}`);
  console.log(`   ${expected} rolls at base stamina, ${maxRolls} at Sure-Footed ${CFG.STAMINA.maxRank}`);

  // Rarity: the card pool has to cull it most of the time, but still offer it.
  game.restart();
  const { rollUpgrades } = await import('../src/upgrades.js');
  let seen = 0;
  const TRIES = 600;
  for (let i = 0; i < TRIES; i++) {
    if (rollUpgrades(game.weapons, p, 3).some((c) => c.key === 'stamina')) seen++;
  }
  const rate = seen / TRIES;
  if (seen === 0) fail('Sure-Footed never appeared in 600 level-up screens');
  if (rate > 0.5) fail(`Sure-Footed appeared on ${(rate * 100).toFixed(0)}% of screens — not rare`);
  console.log(`   Sure-Footed offered on ${(rate * 100).toFixed(0)}% of card screens`);

  // Abandon Hunt must END the run, not quietly start a new one. It used to
  // call restart(), which drops you straight back into the forest — from the
  // player's seat that is indistinguishable from pressing Resume.
  game.restart();
  for (let i = 0; i < 60 * 20; i++) frame({ x: 1, z: 0 });
  // Twenty seconds of play usually ends mid-card-screen; settle back into
  // 'playing' first, since pausing is only legal from there.
  for (let i = 0; i < 30 && game.state !== 'playing'; i++) frame();
  const runElapsed = game.elapsed;
  const runKills = game.enemies.totalKills;
  game.togglePause();
  if (game.state !== 'paused') fail('Esc did not pause');
  game.abandon();
  if (game.state !== 'over') {
    fail(`Abandon Hunt left the game in state '${game.state}' — it should end the run`);
  }
  if (p.alive) fail('Abandon Hunt left the hunter alive');
  if (game.elapsed < runElapsed) fail('Abandon Hunt reset the run clock instead of ending the run');
  if (game.enemies.totalKills !== runKills) fail('Abandon Hunt wiped the run stats');
  if (game.score <= 0) fail('Abandon Hunt did not bank a score');
  if (game.victory) fail('an abandoned run was scored as a victory');
  if (!game.abandoned) fail('the abandoned flag was not set for the results screen');
  console.log(`   Abandon Hunt ended the run at ${game.elapsed.toFixed(0) + "s"} with score ${game.score}`);

  // And "Hunt Again" from the results screen still starts fresh.
  game.restart();
  if (game.state !== 'playing' || game.elapsed !== 0 || game.abandoned) {
    fail('restart after abandoning did not begin a clean run');
  }

  // A dodge must be impossible while dead, and survive a restart cleanly.
  game.restart();
  p.alive = false;
  if (p.dodge({ x: 1, z: 0 })) fail('a corpse dodged');
  game.restart();
  if (st.stamina !== st.staminaMax) fail('restart did not refill stamina');
  if (p.dodgeTime !== 0 || p.dodgeCd !== 0) fail('restart left dodge state behind');
}

// --- Phase 10: every weapon does something at every rank ----------------------
//
// The milestone tables are five entries long but weapons rank to 20. Reading
// one past rank 5 gave `undefined`, and `for (let i = 0; i < undefined; i++)`
// runs zero times — so half the arsenal went silent at rank 6 while still
// burning its cooldown, and Bear Traps lost its cap entirely. Rank 5 passing
// told us nothing about rank 6, so this walks all 20 for all 13 weapons.
console.log('▶ phase 10 — every weapon at every rank');
{
  game.restart();
  game.state = 'playing';
  const W = game.weapons;

  // Count everything a weapon can possibly do in a frame.
  let hits = 0;
  const origHit = W.hitEnemy.bind(W);
  W.hitEnemy = (...a) => { hits++; return origHit(...a); };
  const activity = () => hits
    + W.projectiles.filter((x) => x.alive).length
    + W.grounds.filter((x) => x.alive).length
    + W.traps.filter((x) => x.alive).length
    + W.slashes.filter((x) => x.life > 0).length
    + W.bolts.filter((x) => x.life > 0).length
    + W.hounds.filter((x) => x.active).length
    + (W.pyreMesh.visible ? 1 : 0)
    + (W.censerMesh.visible ? 1 : 0)
    // Whetstone Fangs writes instances directly into the shared mesh; the
    // pools above never see it.
    + Object.values(W.projMeshes).reduce((n, m) => n + (m.count || 0), 0);

  const dead = [];
  for (const key of Object.keys(WEAPONS)) {
    for (let rank = 1; rank <= WEAPONS[key].maxLevel; rank++) {
      game.restart();
      game.state = 'playing';
      W.owned.clear();
      for (let i = 0; i < rank; i++) W.addOrLevel(key);
      if (W.owned.get(key).level !== rank) fail(`${key} would not rank to ${rank}`);

      // A ring of live targets, close enough for every reach in the game.
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        game.enemies.spawnOne(
          'goblin',
          game.player.pos.x + Math.cos(a) * 3.5,
          game.player.pos.z + Math.sin(a) * 3.5,
          game.elapsed
        );
      }

      hits = 0;
      // Long enough to clear the slowest cooldown in the game at rank 1.
      for (let i = 0; i < 60 * 5; i++) frame();
      if (activity() === 0) dead.push(`${key} rank ${rank}`);
    }
  }
  W.hitEnemy = origHit;

  if (dead.length) {
    fail(`${dead.length} weapon/rank combinations do nothing at all: ${dead.slice(0, 12).join(', ')}`
      + (dead.length > 12 ? ` … and ${dead.length - 12} more` : ''));
  }
  const combos = Object.values(WEAPONS).reduce((n, d) => n + d.maxLevel, 0);
  console.log(`   ${combos - dead.length}/${combos} weapon/rank combinations fire`);

  // Bear Traps must still respect its cap past rank 5 rather than losing it.
  game.restart();
  game.state = 'playing';
  W.owned.clear();
  for (let i = 0; i < 20; i++) W.addOrLevel('traps');
  for (let i = 0; i < 60 * 12; i++) frame();
  const liveTraps = W.traps.filter((t) => t.alive).length;
  const trapCap = W.constructor.rankPick([1, 2, 2, 3, 3], 20);
  if (liveTraps > trapCap) {
    fail(`Bear Traps at rank 20 placed ${liveTraps} traps against a cap of ${trapCap}`);
  }
  console.log(`   Bear Traps rank 20 holds its cap of ${trapCap} (${liveTraps} live)`);
  game.restart();
}

// --- Report ------------------------------------------------------------------
console.log(`\nframes simulated: ${steps}  renders: ${game.renderer.renders}  level-ups taken: ${picks}`);
if (warnings.length) {
  console.log(`warnings (expected — no Portals SDK in node): ${warnings.length}`);
}

if (failures.length) {
  realError(`\n✘ ${failures.length} failure(s):`);
  failures.forEach((f) => realError('  •', f));
  process.exit(1);
}
console.log('\n✔ all checks passed');
process.exit(0);
