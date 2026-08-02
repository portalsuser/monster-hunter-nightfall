/**
 * Analytic triangle budget.
 *
 * The smoke test cannot measure GPU cost — the mock never rasterises anything.
 * This walks the real geometry constructors through a counting stand-in and
 * reports per-monster and whole-frame triangle totals, so a round of "make the
 * models nicer" can be checked against a budget instead of a vibe.
 *
 *   node tools/tribudget.mjs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Point the bare 'three' specifier at the counting stand-in.
const shimDir = path.join(ROOT, 'node_modules', 'three');
fs.mkdirSync(shimDir, { recursive: true });
fs.writeFileSync(path.join(shimDir, 'package.json'), JSON.stringify({
  name: 'three', version: '0.0.0-count', type: 'module', main: 'index.mjs', exports: './index.mjs',
}, null, 2));
fs.writeFileSync(
  path.join(shimDir, 'index.mjs'),
  `export * from ${JSON.stringify(path.join(HERE, 'count-three.mjs'))};\n`
);

// Minimal DOM so the modules import cleanly.
globalThis.window = globalThis.window || { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document = globalThis.document || {
  addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, getContext: () => null }),
  getElementById: () => null, body: { appendChild() {} }, head: { appendChild() {} },
};

const { trisOf } = await import('./count-three.mjs');
const THREE = await import('three');
const { ENEMY_TYPES } = await import('../src/enemies.js');
const { CFG } = await import('../src/config.js');
const { Player } = await import('../src/player.js');

// --- per-monster cost -------------------------------------------------------

const rows = [];
for (const [key, def] of Object.entries(ENEMY_TYPES)) {
  let tris = 0;
  for (const part of def.parts) tris += trisOf(part.geo());
  rows.push({ key, name: def.name, parts: def.parts.length, tris });
}
rows.sort((a, b) => b.tris - a.tris);

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => Math.round(n).toLocaleString('en-US');

console.log('\nPER-MONSTER GEOMETRY');
console.log('─'.repeat(58));
console.log(`${pad('type', 14)}${pad('name', 16)}${pad('parts', 7)}tris`);
for (const r of rows) {
  console.log(`${pad(r.key, 14)}${pad(r.name, 16)}${pad(r.parts, 7)}${num(r.tris)}`);
}

const heaviest = rows[0];
const mean = rows.reduce((s, r) => s + r.tris, 0) / rows.length;
console.log('─'.repeat(58));
console.log(`${pad('mean', 37)}${num(mean)}`);
console.log(`${pad('heaviest', 37)}${num(heaviest.tris)}  (${heaviest.name})`);

// --- whole-frame estimate ---------------------------------------------------
//
// The horde is capped at CFG.SPAWN.maxAlive, but not every spawn is on screen
// and not every type is the heaviest. Two cases are reported: a realistic mixed
// horde at the mean, and the pathological case of maxAlive of the worst type.

const alive = CFG.SPAWN.maxAlive;
const hordeMean = mean * alive;
const hordeWorst = heaviest.tris * alive;

// Static scenery, measured the same way the world builds it.
const tiles = CFG.WORLD.tileGrid * CFG.WORLD.tileGrid;
const TREE_TRIS = 1 * (14 * (8 * 2 - 2)) + 2 * (10 * 1 * 2 + 10 * 2); // canopy spheres + trunk, order of magnitude
const world = {
  trees: tiles * CFG.WORLD.treesPerTile * TREE_TRIS,
  rocks: tiles * CFG.WORLD.rocksPerTile * 20,
  ferns: tiles * CFG.WORLD.fernsPerTile * 8,
  ground: tiles * 2 * 64,
};
const worldTotal = Object.values(world).reduce((a, b) => a + b, 0);

// --- the hunter -------------------------------------------------------------
// One character, so he can afford detail the horde cannot. Worth measuring
// separately because his draw-call count matters as much as his triangles:
// he is a tree of separate meshes, not an instanced batch.
const scene = new THREE.Scene();
const hunter = new Player(scene);
let heroTris = 0, heroMeshes = 0, heroCasters = 0;
hunter.mesh.traverse((o) => {
  if (!o.geometry) return;
  heroMeshes++;
  if (o.castShadow) heroCasters++;
  heroTris += trisOf(o.geometry);
});
console.log('\nTHE HUNTER');
console.log('─'.repeat(58));
console.log(`${pad('triangles', 40)}${num(heroTris)}`);
console.log(`${pad('meshes (draw calls)', 40)}${heroMeshes}`);
console.log(`${pad('shadow casters', 40)}${heroCasters}`);

console.log('\nWHOLE FRAME (upper bounds)');
console.log('─'.repeat(58));
console.log(`${pad('horde @ maxAlive ' + alive + ', mean type', 40)}${num(hordeMean)}`);
console.log(`${pad('horde @ maxAlive, worst type', 40)}${num(hordeWorst)}`);
console.log(`${pad('static world (trees/rocks/ferns/ground)', 40)}${num(worldTotal)}`);
console.log(`${pad('the hunter', 40)}${num(heroTris)}`);

const SHADOW = 2; // the directional light re-draws casters once
const frameMean = (hordeMean + worldTotal + heroTris) * SHADOW;
const frameWorst = (hordeWorst + worldTotal + heroTris) * SHADOW;
console.log(`${pad('frame incl. shadow pass — mixed horde', 40)}${num(frameMean)}`);
console.log(`${pad('frame incl. shadow pass — worst case', 40)}${num(frameWorst)}`);
console.log(`${pad('at 60fps, mixed', 40)}${num(frameMean * 60 / 1e6)}M tris/sec`);

// --- verdict ----------------------------------------------------------------
//
// Integrated laptop GPUs comfortably push a few hundred million triangles per
// second; 2M per frame is the line where a mid-range machine starts to sweat.
const BUDGET = 2_000_000;
console.log('─'.repeat(58));
if (frameMean > BUDGET) {
  console.log(`OVER BUDGET: mixed horde frame is ${num(frameMean)} tris, budget ${num(BUDGET)}`);
  process.exit(1);
}
console.log(`within budget: ${num(frameMean)} / ${num(BUDGET)} tris per frame `
  + `(${Math.round((frameMean / BUDGET) * 100)}%)\n`);
