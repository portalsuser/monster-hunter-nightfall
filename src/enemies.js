import * as THREE from 'three';
import { CFG, difficulty } from './config.js';
import { SFX } from './audio.js';
import { clamp, pick, rand, randInt, ringPoint, ringPointBiased, TAU, weighted, SpatialHash } from './utils.js';

/**
 * Horde rendering strategy
 * ------------------------
 * Trash mobs are drawn with one InstancedMesh per body part per type. A wolf is
 * "body + head + 2 legs" = 4 instanced meshes, so 300 wolves still cost 4 draw
 * calls. Per-instance animation is done by writing each part's matrix from the
 * enemy's state every frame, which is cheap and gives us real limb motion.
 *
 * Bosses are the exception: there are at most a couple alive, so they get a
 * proper hierarchical THREE.Group with hand-animated parts.
 */

const stdMat = (color, opts = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.8, flatShading: false, ...opts });

/**
 * Merges primitives sharing an attribute set into one geometry.
 * Lets a pair of ears or eyes ride in a single InstancedMesh instead of two,
 * which matters when the type is on screen 150 times over.
 */
function mergeGeos(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const names = Object.keys(parts[0].attributes);
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    let total = 0;
    for (const g of parts) total += g.attributes[name].array.length;
    const itemSize = parts[0].attributes[name].itemSize;
    const arr = new Float32Array(total);
    let off = 0;
    for (const g of parts) { arr.set(g.attributes[name].array, off); off += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  }
  out.computeBoundingSphere();
  return out;
}


/** Four jointed legs for one side of the Widow, merged into one geometry. */
function spiderLegs(side) {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const spread = -0.34 + i * 0.24;
    const upper = new THREE.CylinderGeometry(0.028, 0.024, 0.32, 8);
    upper.rotateZ(side * -0.95);
    upper.translate(side * 0.19, 0.13, spread);
    const lower = new THREE.CylinderGeometry(0.024, 0.014, 0.34, 8);
    lower.rotateZ(side * 0.75);
    lower.translate(side * 0.36, -0.06, spread);
    // A knuckle at the joint so the leg reads as jointed rather than kinked.
    const joint = new THREE.SphereGeometry(0.032, 8, 6);
    joint.translate(side * 0.29, 0.03, spread);
    parts.push(upper, lower, joint);
  }
  return mergeGeos(parts);
}

/** Bonegnasher arm: upper limb plus a heavy knuckled fist. */
function bruteArm() {
  const limb = new THREE.CapsuleGeometry(0.16, 0.66, 6, 12);
  limb.translate(0, -0.36, 0);
  const fist = new THREE.DodecahedronGeometry(0.24, 1);
  fist.translate(0, -0.82, 0);
  return mergeGeos([limb, fist]);
}

// ---------------------------------------------------------------------------
// Trash mob type definitions
// ---------------------------------------------------------------------------
// `parts[].place(d, e, t)` positions the THREE.Object3D dummy `d` for enemy `e`
// at run time `t`. It runs once per part per enemy per frame.

function makeTypes() {
  const types = {};

  // --- Grotling: goblin scavenger, the bread-and-butter swarm unit ---------
  // Ten instanced meshes, but they are the first thing the player ever sees
  // and a blob does not sell "monster hunt". Y offsets all ride e.scale so the
  // model still stands on the ground when the global monster scale changes.
  const SKIN = 0x6f8a45;
  const SKIN_D = 0x54682f;
  types.goblin = {
    name: 'Grotling',
    hp: 9, speed: 2.7, dmg: 6, radius: 0.52, xp: 2, scale: 1,
    tint: 0x6a7f4a, blood: 0x4d6b2a,
    minute: 0,
    parts: [
      { // hunched torso
        geo: () => new THREE.CapsuleGeometry(0.26, 0.3, 8, 18),
        mat: () => stdMat(SKIN_D),
        place: (d, e, t) => {
          const bob = Math.sin(t * 9 + e.phase) * 0.05;
          d.position.set(e.x, (0.56 + bob) * e.scale, e.z);
          d.rotation.set(0.22, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // oversized head
        geo: () => new THREE.SphereGeometry(0.27, 20, 15),
        mat: () => stdMat(SKIN),
        place: (d, e, t) => {
          const bob = Math.sin(t * 9 + e.phase) * 0.05;
          d.position.set(e.x + Math.sin(e.yaw) * 0.07 * e.scale, (0.98 + bob) * e.scale, e.z + Math.cos(e.yaw) * 0.07 * e.scale);
          d.rotation.set(0.1, e.yaw + Math.sin(t * 3 + e.phase) * 0.16, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // pointed ears + hooked nose, merged into one mesh
        geo: () => {
          const earL = new THREE.ConeGeometry(0.07, 0.34, 10);
          earL.rotateZ(1.15); earL.translate(-0.27, 0.06, -0.03);
          const earR = new THREE.ConeGeometry(0.07, 0.34, 10);
          earR.rotateZ(-1.15); earR.translate(0.27, 0.06, -0.03);
          const nose = new THREE.ConeGeometry(0.055, 0.2, 10);
          nose.rotateX(1.9); nose.translate(0, -0.03, 0.26);
          // Snaggle teeth in the lower jaw.
          const tusks = [];
          for (const x of [-0.09, 0.09]) {
            const q = new THREE.ConeGeometry(0.02, 0.08, 6);
            q.translate(x, -0.09, 0.2);
            tusks.push(q);
          }
          return mergeGeos([earL, earR, nose, ...tusks]);
        },
        mat: () => stdMat(SKIN),
        place: (d, e, t) => {
          const bob = Math.sin(t * 9 + e.phase) * 0.05;
          d.position.set(e.x + Math.sin(e.yaw) * 0.07 * e.scale, (0.98 + bob) * e.scale, e.z + Math.cos(e.yaw) * 0.07 * e.scale);
          d.rotation.set(0.1, e.yaw + Math.sin(t * 3 + e.phase) * 0.16, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // both eyes in one mesh
        geo: () => {
          const a = new THREE.SphereGeometry(0.045, 12, 9); a.translate(-0.1, 0, 0.22);
          const b = new THREE.SphereGeometry(0.045, 12, 9); b.translate(0.1, 0, 0.22);
          return mergeGeos([a, b]);
        },
        mat: () => new THREE.MeshBasicMaterial({ color: 0xffe14a }),
        place: (d, e, t) => {
          const bob = Math.sin(t * 9 + e.phase) * 0.05;
          d.position.set(e.x + Math.sin(e.yaw) * 0.07 * e.scale, (0.98 + bob) * e.scale, e.z + Math.cos(e.yaw) * 0.07 * e.scale);
          d.rotation.set(0.1, e.yaw + Math.sin(t * 3 + e.phase) * 0.16, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // ragged loincloth
        geo: () => new THREE.BoxGeometry(0.4, 0.26, 0.34, 3, 2, 3),
        mat: () => stdMat(0x6b4a2c),
        place: (d, e, t) => {
          const bob = Math.sin(t * 9 + e.phase) * 0.05;
          d.position.set(e.x, (0.42 + bob) * e.scale, e.z);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // left arm
        geo: () => { const g = new THREE.CapsuleGeometry(0.065, 0.3, 6, 14); g.translate(0, -0.17, 0); return g; },
        mat: () => stdMat(SKIN),
        place: (d, e, t) => {
          const sw = Math.sin(t * 10 + e.phase) * 0.7;
          const c = Math.cos(e.yaw), sn = Math.sin(e.yaw);
          d.position.set(e.x + c * 0.27 * e.scale, 0.78 * e.scale, e.z - sn * 0.27 * e.scale);
          d.rotation.set(sw, e.yaw, 0.25);
          d.scale.setScalar(e.scale);
        },
      },
      { // right arm, raised to hold the club
        geo: () => { const g = new THREE.CapsuleGeometry(0.065, 0.3, 6, 14); g.translate(0, -0.17, 0); return g; },
        mat: () => stdMat(SKIN),
        place: (d, e, t) => {
          const sw = -0.9 + Math.sin(t * 10 + e.phase) * 0.35;
          const c = Math.cos(e.yaw), sn = Math.sin(e.yaw);
          d.position.set(e.x - c * 0.27 * e.scale, 0.78 * e.scale, e.z + sn * 0.27 * e.scale);
          d.rotation.set(sw, e.yaw, -0.25);
          d.scale.setScalar(e.scale);
        },
      },
      { // crude club, swung overhead
        geo: () => {
          const shaft = new THREE.CylinderGeometry(0.035, 0.045, 0.42, 10);
          const knot = new THREE.IcosahedronGeometry(0.1, 2); knot.translate(0, 0.24, 0);
          // Iron nails hammered through the head.
          const nails = [];
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * TAU;
            const q = new THREE.ConeGeometry(0.014, 0.09, 5);
            q.rotateZ(Math.PI / 2); q.rotateY(a);
            q.translate(Math.sin(a) * 0.12, 0.24, Math.cos(a) * 0.12);
            nails.push(q);
          }
          return mergeGeos([shaft, knot, ...nails]);
        },
        mat: () => stdMat(0x4a3520),
        place: (d, e, t) => {
          const sw = -0.9 + Math.sin(t * 10 + e.phase) * 0.35;
          const c = Math.cos(e.yaw), sn = Math.sin(e.yaw);
          const ax = e.x - c * 0.27 * e.scale;
          const az = e.z + sn * 0.27 * e.scale;
          d.position.set(ax + sn * 0.22 * e.scale, (0.92 + Math.sin(sw) * 0.2) * e.scale, az + c * 0.22 * e.scale);
          d.rotation.set(sw + 0.7, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // left leg
        geo: () => { const g = new THREE.CapsuleGeometry(0.075, 0.22, 6, 14); g.translate(0, -0.15, 0); return g; },
        mat: () => stdMat(SKIN_D),
        place: (d, e, t) => {
          const sw = Math.sin(t * 10 + e.phase) * 0.65;
          const c = Math.cos(e.yaw), sn = Math.sin(e.yaw);
          d.position.set(e.x + c * 0.12 * e.scale, 0.44 * e.scale, e.z - sn * 0.12 * e.scale);
          d.rotation.set(sw, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // right leg
        geo: () => { const g = new THREE.CapsuleGeometry(0.075, 0.22, 6, 14); g.translate(0, -0.15, 0); return g; },
        mat: () => stdMat(SKIN_D),
        place: (d, e, t) => {
          const sw = -Math.sin(t * 10 + e.phase) * 0.65;
          const c = Math.cos(e.yaw), sn = Math.sin(e.yaw);
          d.position.set(e.x - c * 0.12 * e.scale, 0.44 * e.scale, e.z + sn * 0.12 * e.scale);
          d.rotation.set(sw, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
    ],
  };

  // --- Gloomwolf: fast flanker --------------------------------------------
  types.wolf = {
    name: 'Gloomwolf',
    hp: 20, speed: 5.5, dmg: 10, radius: 0.6, xp: 3, scale: 1,
    tint: 0x3a3a44, blood: 0x6b1f2a,
    minute: 0.6,
    parts: [
      { // body
        geo: () => { const g = new THREE.CapsuleGeometry(0.28, 0.62, 10, 20); g.rotateX(Math.PI / 2); return g; },
        mat: () => stdMat(0x33333d),
        place: (d, e, t) => {
          d.position.set(e.x, (0.66 + Math.sin(t * 12 + e.phase) * 0.05) * e.scale, e.z);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // shoulder ruff
        geo: () => { const g = new THREE.TorusGeometry(0.3, 0.11, 12, 26); g.rotateY(Math.PI / 2); return g; },
        mat: () => stdMat(0x22222b),
        place: (d, e, t) => {
          d.position.set(e.x + Math.sin(e.yaw) * 0.28 * e.scale, (0.7 + Math.sin(t * 12 + e.phase) * 0.05) * e.scale, e.z + Math.cos(e.yaw) * 0.28 * e.scale);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // head
        geo: () => { const g = new THREE.ConeGeometry(0.24, 0.5, 20, 2); g.rotateX(Math.PI / 2); return g; },
        mat: () => stdMat(0x2a2a33),
        place: (d, e, t) => {
          d.position.set(e.x + Math.sin(e.yaw) * 0.6 * e.scale, 0.72 * e.scale, e.z + Math.cos(e.yaw) * 0.6 * e.scale);
          d.rotation.set(Math.sin(t * 12 + e.phase) * 0.1, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // snout + ears in one mesh
        geo: () => {
          const snout = new THREE.ConeGeometry(0.11, 0.3, 14); snout.rotateX(Math.PI / 2); snout.translate(0, -0.05, 0.24);
          const earL = new THREE.ConeGeometry(0.07, 0.22, 9); earL.translate(-0.13, 0.18, -0.1);
          const earR = new THREE.ConeGeometry(0.07, 0.22, 9); earR.translate(0.13, 0.18, -0.1);
          // Bared teeth — the wolf is always mid-snarl.
          const teeth = [];
          for (let i = 0; i < 4; i++) {
            const q = new THREE.ConeGeometry(0.016, 0.06, 5);
            q.rotateX(Math.PI);
            q.translate(-0.048 + i * 0.032, -0.09, 0.3);
            teeth.push(q);
          }
          return mergeGeos([snout, earL, earR, ...teeth]);
        },
        mat: () => stdMat(0x25252d),
        place: (d, e, t) => {
          d.position.set(e.x + Math.sin(e.yaw) * 0.68 * e.scale, 0.74 * e.scale, e.z + Math.cos(e.yaw) * 0.68 * e.scale);
          d.rotation.set(Math.sin(t * 12 + e.phase) * 0.1, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // both eyes
        geo: () => {
          const a = new THREE.SphereGeometry(0.05, 9, 7); a.translate(-0.09, 0, 0);
          const b = new THREE.SphereGeometry(0.05, 9, 7); b.translate(0.09, 0, 0);
          return mergeGeos([a, b]);
        },
        mat: () => new THREE.MeshBasicMaterial({ color: 0xff5a3c }),
        place: (d, e) => {
          d.position.set(e.x + Math.sin(e.yaw) * 0.8 * e.scale, 0.8 * e.scale, e.z + Math.cos(e.yaw) * 0.8 * e.scale);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // front legs
        geo: () => { const g = new THREE.CapsuleGeometry(0.055, 0.34, 6, 12); g.translate(0, -0.19, 0); return g; },
        mat: () => stdMat(0x24242c),
        place: (d, e, t) => {
          const sw = Math.sin(t * 16 + e.phase) * 0.75;
          d.position.set(e.x + Math.sin(e.yaw) * 0.32 * e.scale, 0.6 * e.scale, e.z + Math.cos(e.yaw) * 0.32 * e.scale);
          d.rotation.set(sw, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // back legs
        geo: () => { const g = new THREE.CapsuleGeometry(0.055, 0.34, 6, 12); g.translate(0, -0.19, 0); return g; },
        mat: () => stdMat(0x24242c),
        place: (d, e, t) => {
          const sw = -Math.sin(t * 16 + e.phase) * 0.75;
          d.position.set(e.x - Math.sin(e.yaw) * 0.3 * e.scale, 0.6 * e.scale, e.z - Math.cos(e.yaw) * 0.3 * e.scale);
          d.rotation.set(sw, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // tail
        geo: () => { const g = new THREE.ConeGeometry(0.09, 0.55, 12, 3); g.rotateX(-Math.PI / 2); g.translate(0, 0, -0.26); return g; },
        mat: () => stdMat(0x2a2a33),
        place: (d, e, t) => {
          d.position.set(e.x - Math.sin(e.yaw) * 0.52 * e.scale, 0.74 * e.scale, e.z - Math.cos(e.yaw) * 0.52 * e.scale);
          d.rotation.set(-0.4, e.yaw + Math.sin(t * 9 + e.phase) * 0.5, 0);
          d.scale.setScalar(e.scale);
        },
      },
    ],
  };

  // --- Nightwing: erratic flyer, ignores ground -----------------------------
  types.bat = {
    name: 'Nightwing',
    hp: 12, speed: 5.9, dmg: 7, radius: 0.42, xp: 3, scale: 1,
    tint: 0x2b2233, blood: 0x4a2244,
    minute: 1.4, flying: true, weave: 3.2,
    parts: [
      { // body
        geo: () => new THREE.IcosahedronGeometry(0.24, 2),
        mat: () => stdMat(0x2e2438),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(0, e.yaw, Math.sin(t * 18 + e.phase) * 0.2);
          d.scale.setScalar(e.scale);
        },
      },
      { // tall ears + snout
        geo: () => {
          const earL = new THREE.ConeGeometry(0.06, 0.28, 9); earL.rotateZ(0.3); earL.translate(-0.1, 0.2, -0.02);
          const earR = new THREE.ConeGeometry(0.06, 0.28, 9); earR.rotateZ(-0.3); earR.translate(0.1, 0.2, -0.02);
          const snout = new THREE.ConeGeometry(0.08, 0.16, 10); snout.rotateX(Math.PI / 2); snout.translate(0, -0.02, 0.2);
          const fangL = new THREE.ConeGeometry(0.018, 0.07, 6); fangL.rotateX(Math.PI); fangL.translate(-0.035, -0.06, 0.2);
          const fangR = new THREE.ConeGeometry(0.018, 0.07, 6); fangR.rotateX(Math.PI); fangR.translate(0.035, -0.06, 0.2);
          return mergeGeos([earL, earR, snout, fangL, fangR]);
        },
        mat: () => stdMat(0x3a2d47),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(0, e.yaw, Math.sin(t * 18 + e.phase) * 0.2);
          d.scale.setScalar(e.scale);
        },
      },
      { // both eyes
        geo: () => {
          const a = new THREE.SphereGeometry(0.035, 8, 6); a.translate(-0.07, 0.02, 0.17);
          const b = new THREE.SphereGeometry(0.035, 8, 6); b.translate(0.07, 0.02, 0.17);
          return mergeGeos([a, b]);
        },
        mat: () => new THREE.MeshBasicMaterial({ color: 0xff8adf }),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(0, e.yaw, Math.sin(t * 18 + e.phase) * 0.2);
          d.scale.setScalar(e.scale);
        },
      },
      { // membraned wing, right — ribs baked into the merge
        geo: () => {
          const web = new THREE.PlaneGeometry(0.62, 0.34, 9, 6); web.translate(0.31, 0, 0);
          const rib1 = new THREE.CylinderGeometry(0.012, 0.012, 0.6, 7); rib1.rotateZ(Math.PI / 2); rib1.translate(0.3, 0.1, 0);
          const rib2 = new THREE.CylinderGeometry(0.012, 0.012, 0.5, 7); rib2.rotateZ(Math.PI / 2.3); rib2.translate(0.26, -0.06, 0);
          return mergeGeos([web, rib1, rib2]);
        },
        mat: () => stdMat(0x40304d, { side: THREE.DoubleSide }),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(0, e.yaw, Math.sin(t * 22 + e.phase) * 0.9 + 0.2);
          d.scale.setScalar(e.scale);
        },
      },
      { // membraned wing, left
        geo: () => {
          const web = new THREE.PlaneGeometry(0.62, 0.34, 9, 6); web.translate(-0.31, 0, 0);
          const rib1 = new THREE.CylinderGeometry(0.012, 0.012, 0.6, 7); rib1.rotateZ(Math.PI / 2); rib1.translate(-0.3, 0.1, 0);
          const rib2 = new THREE.CylinderGeometry(0.012, 0.012, 0.5, 7); rib2.rotateZ(-Math.PI / 2.3); rib2.translate(-0.26, -0.06, 0);
          return mergeGeos([web, rib1, rib2]);
        },
        mat: () => stdMat(0x40304d, { side: THREE.DoubleSide }),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(0, e.yaw, -Math.sin(t * 22 + e.phase) * 0.9 - 0.2);
          d.scale.setScalar(e.scale);
        },
      },
    ],
  };

  // --- Widow: skittering spider, spawns in clusters -------------------------
  types.spider = {
    name: 'Widow',
    hp: 16, speed: 4.8, dmg: 9, radius: 0.5, xp: 3, scale: 1,
    tint: 0x1f1a24, blood: 0x2f4a1f,
    minute: 2.2, cluster: [3, 6],
    parts: [
      { // abdomen
        geo: () => new THREE.SphereGeometry(0.3, 22, 16),
        mat: () => stdMat(0x241d2b),
        place: (d, e, t) => {
          d.position.set(e.x - Math.sin(e.yaw) * 0.2 * e.scale,
                         (0.44 + Math.abs(Math.sin(t * 16 + e.phase)) * 0.05) * e.scale,
                         e.z - Math.cos(e.yaw) * 0.2 * e.scale);
          d.rotation.set(0, e.yaw, 0);
          d.scale.set(e.scale, e.scale * 0.85, e.scale * 1.15);
        },
      },
      { // cephalothorax
        geo: () => new THREE.SphereGeometry(0.19, 18, 14),
        mat: () => stdMat(0x2f2637),
        place: (d, e, t) => {
          d.position.set(e.x + Math.sin(e.yaw) * 0.24 * e.scale,
                         (0.42 + Math.abs(Math.sin(t * 16 + e.phase)) * 0.05) * e.scale,
                         e.z + Math.cos(e.yaw) * 0.24 * e.scale);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // four left legs, merged and jointed
        geo: () => spiderLegs(-1),
        mat: () => stdMat(0x171119),
        place: (d, e, t) => {
          d.position.set(e.x, 0.4 * e.scale, e.z);
          d.rotation.set(0, e.yaw, Math.sin(t * 17 + e.phase) * 0.14);
          d.scale.setScalar(e.scale);
        },
      },
      { // four right legs, opposite phase
        geo: () => spiderLegs(1),
        mat: () => stdMat(0x171119),
        place: (d, e, t) => {
          d.position.set(e.x, 0.4 * e.scale, e.z);
          d.rotation.set(0, e.yaw, -Math.sin(t * 17 + e.phase) * 0.14);
          d.scale.setScalar(e.scale);
        },
      },
      { // four eyes
        geo: () => {
          const g = [];
          for (const [x, y, r] of [[-0.08, 0.05, 0.032], [0.08, 0.05, 0.032], [-0.04, -0.01, 0.022], [0.04, -0.01, 0.022]]) {
            const q = new THREE.SphereGeometry(r, 10, 8); q.translate(x, y, 0.16); g.push(q);
          }
          return mergeGeos(g);
        },
        mat: () => new THREE.MeshBasicMaterial({ color: 0xff2d5e }),
        place: (d, e, t) => {
          d.position.set(e.x + Math.sin(e.yaw) * 0.24 * e.scale,
                         (0.44 + Math.abs(Math.sin(t * 16 + e.phase)) * 0.05) * e.scale,
                         e.z + Math.cos(e.yaw) * 0.24 * e.scale);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // fangs
        geo: () => {
          const a = new THREE.ConeGeometry(0.035, 0.16, 9); a.rotateX(2.6); a.translate(-0.06, -0.1, 0.15);
          const b = new THREE.ConeGeometry(0.035, 0.16, 9); b.rotateX(2.6); b.translate(0.06, -0.1, 0.15);
          return mergeGeos([a, b]);
        },
        mat: () => stdMat(0xd8cfc0),
        place: (d, e, t) => {
          d.position.set(e.x + Math.sin(e.yaw) * 0.26 * e.scale, 0.42 * e.scale, e.z + Math.cos(e.yaw) * 0.26 * e.scale);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
    ],
  };

  // --- Bonegnasher: slow, tanky, hits hard ---------------------------------
  const BONE = 0xbfb49a;
  types.brute = {
    name: 'Bonegnasher',
    hp: 70, speed: 2.4, dmg: 20, radius: 0.95, xp: 9, scale: 1.5,
    tint: 0x6b5a45, blood: 0x8a2b2b,
    minute: 3,
    parts: [
      { // torso
        geo: () => new THREE.CapsuleGeometry(0.5, 0.7, 8, 18),
        mat: () => stdMat(0x5d4d3a),
        place: (d, e, t) => {
          d.position.set(e.x, 0.95 * e.scale, e.z);
          d.rotation.set(0.08, e.yaw, Math.sin(t * 3.5 + e.phase) * 0.09);
          d.scale.setScalar(e.scale);
        },
      },
      { // shoulder plates
        geo: () => {
          const a = new THREE.SphereGeometry(0.34, 12, 8, 0, TAU, 0, Math.PI * 0.55); a.translate(-0.5, 0, 0);
          const b = new THREE.SphereGeometry(0.34, 12, 8, 0, TAU, 0, Math.PI * 0.55); b.translate(0.5, 0, 0);
          return mergeGeos([a, b]);
        },
        mat: () => stdMat(0x7a6a52),
        place: (d, e, t) => {
          d.position.set(e.x, 1.42 * e.scale, e.z);
          d.rotation.set(0, e.yaw, Math.sin(t * 3.5 + e.phase) * 0.09);
          d.scale.setScalar(e.scale);
        },
      },
      { // skull
        geo: () => new THREE.SphereGeometry(0.3, 14, 11),
        mat: () => stdMat(BONE),
        place: (d, e, t) => {
          d.position.set(e.x, 1.74 * e.scale, e.z);
          d.rotation.set(0.1, e.yaw + Math.sin(t * 3 + e.phase) * 0.14, 0);
          d.scale.set(e.scale, e.scale * 1.1, e.scale * 1.15);
        },
      },
      { // jaw + tusks
        geo: () => {
          const jaw = new THREE.BoxGeometry(0.34, 0.14, 0.3); jaw.translate(0, -0.2, 0.1);
          const tl = new THREE.ConeGeometry(0.05, 0.24, 6); tl.rotateX(-0.3); tl.translate(-0.13, -0.06, 0.2);
          const tr = new THREE.ConeGeometry(0.05, 0.24, 6); tr.rotateX(-0.3); tr.translate(0.13, -0.06, 0.2);
          return mergeGeos([jaw, tl, tr]);
        },
        mat: () => stdMat(0xd6cbb4),
        place: (d, e, t) => {
          const chew = Math.abs(Math.sin(t * 5 + e.phase)) * 0.08;
          d.position.set(e.x, (1.74 - chew) * e.scale, e.z);
          d.rotation.set(0.1, e.yaw + Math.sin(t * 3 + e.phase) * 0.14, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // horns
        geo: () => {
          const a = new THREE.ConeGeometry(0.07, 0.42, 8); a.rotateZ(0.9); a.translate(-0.26, 0.2, -0.04);
          const b = new THREE.ConeGeometry(0.07, 0.42, 8); b.rotateZ(-0.9); b.translate(0.26, 0.2, -0.04);
          return mergeGeos([a, b]);
        },
        mat: () => stdMat(0x8a7d63),
        place: (d, e, t) => {
          d.position.set(e.x, 1.74 * e.scale, e.z);
          d.rotation.set(0.1, e.yaw + Math.sin(t * 3 + e.phase) * 0.14, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // eye sockets
        geo: () => {
          const a = new THREE.SphereGeometry(0.055, 9, 7); a.translate(-0.11, 0.02, 0.24);
          const b = new THREE.SphereGeometry(0.055, 9, 7); b.translate(0.11, 0.02, 0.24);
          return mergeGeos([a, b]);
        },
        mat: () => new THREE.MeshBasicMaterial({ color: 0xff8a2a }),
        place: (d, e, t) => {
          d.position.set(e.x, 1.74 * e.scale, e.z);
          d.rotation.set(0.1, e.yaw + Math.sin(t * 3 + e.phase) * 0.14, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // left arm with fist
        geo: () => bruteArm(),
        mat: () => stdMat(0x4a3c2c),
        place: (d, e, t) => {
          const sw = Math.sin(t * 4 + e.phase) * 0.6;
          d.position.set(e.x + Math.cos(e.yaw) * 0.66 * e.scale, 1.4 * e.scale, e.z - Math.sin(e.yaw) * 0.66 * e.scale);
          d.rotation.set(sw, e.yaw, 0.28);
          d.scale.setScalar(e.scale);
        },
      },
      { // right arm with fist
        geo: () => bruteArm(),
        mat: () => stdMat(0x4a3c2c),
        place: (d, e, t) => {
          const sw = -Math.sin(t * 4 + e.phase) * 0.6;
          d.position.set(e.x - Math.cos(e.yaw) * 0.66 * e.scale, 1.4 * e.scale, e.z + Math.sin(e.yaw) * 0.66 * e.scale);
          d.rotation.set(sw, e.yaw, -0.28);
          d.scale.setScalar(e.scale);
        },
      },
      { // stubby legs
        geo: () => {
          const a = new THREE.CapsuleGeometry(0.17, 0.3, 5, 10); a.translate(-0.22, -0.2, 0);
          const b = new THREE.CapsuleGeometry(0.17, 0.3, 5, 10); b.translate(0.22, -0.2, 0);
          return mergeGeos([a, b]);
        },
        mat: () => stdMat(0x3f3426),
        place: (d, e, t) => {
          d.position.set(e.x, 0.52 * e.scale, e.z);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
    ],
  };

  // --- Corpse Light: ranged floater ---------------------------------------
  types.wisp = {
    name: 'Corpse Light',
    hp: 22, speed: 2.8, dmg: 10, radius: 0.5, xp: 6, scale: 1,
    tint: 0x5ad6ff, blood: 0x7fe8ff,
    minute: 4, flying: true, ranged: { range: 12, cooldown: 2.6, speed: 8.5, dmg: 9 },
    parts: [
      { // core
        geo: () => new THREE.IcosahedronGeometry(0.3, 2),
        mat: () => new THREE.MeshBasicMaterial({ color: 0x9fe9ff }),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(t * 0.9 + e.phase, t * 1.3, 0);
          d.scale.setScalar(e.scale * (0.9 + Math.sin(t * 4 + e.phase) * 0.12));
        },
      },
      { // halo
        geo: () => new THREE.SphereGeometry(0.5, 20, 14),
        mat: () => new THREE.MeshBasicMaterial({ color: 0x1d5f80, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(0, 0, 0);
          d.scale.setScalar(e.scale * (1.2 + Math.sin(t * 3 + e.phase) * 0.2));
        },
      },
      { // orbiting motes
        geo: () => {
          const g = [];
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * TAU;
            const q = new THREE.SphereGeometry(0.06, 12, 9);
            q.translate(Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42);
            g.push(q);
          }
          return mergeGeos(g);
        },
        mat: () => new THREE.MeshBasicMaterial({ color: 0xd8f7ff }),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(0.4, t * 2.2 + e.phase, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // trailing shroud
        geo: () => { const g = new THREE.ConeGeometry(0.26, 0.7, 18, 5, true); g.translate(0, -0.4, 0); return g; },
        mat: () => new THREE.MeshBasicMaterial({ color: 0x2f7fa0, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(Math.sin(t * 2 + e.phase) * 0.2, e.yaw, Math.cos(t * 2 + e.phase) * 0.2);
          d.scale.setScalar(e.scale);
        },
      },
    ],
  };

  // --- Revenant: mid-game all-rounder --------------------------------------
  types.revenant = {
    name: 'Revenant',
    hp: 46, speed: 4.3, dmg: 15, radius: 0.6, xp: 8, scale: 1.05,
    tint: 0x4a4f5e, blood: 0x3a2a4a,
    minute: 5,
    parts: [
      { // tattered robe
        geo: () => new THREE.ConeGeometry(0.42, 1.5, 24, 7, true),
        mat: () => stdMat(0x3d4250, { side: THREE.DoubleSide, transparent: true, opacity: 0.94 }),
        place: (d, e, t) => {
          d.position.set(e.x, 0.78 * e.scale, e.z);
          d.rotation.set(Math.sin(t * 5 + e.phase) * 0.07, e.yaw, Math.cos(t * 4 + e.phase) * 0.07);
          d.scale.setScalar(e.scale);
        },
      },
      { // hood
        geo: () => new THREE.SphereGeometry(0.3, 20, 14, 0, TAU, 0, Math.PI * 0.62),
        mat: () => stdMat(0x333846, { side: THREE.DoubleSide }),
        place: (d, e, t) => {
          d.position.set(e.x, (1.66 + Math.sin(t * 4 + e.phase) * 0.05) * e.scale, e.z);
          d.rotation.set(0.1, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // skull + jaw
        geo: () => {
          const sk = new THREE.SphereGeometry(0.2, 20, 14);
          const jaw = new THREE.BoxGeometry(0.2, 0.09, 0.18, 2, 1, 2); jaw.translate(0, -0.16, 0.05);
          // Brow ridge and cheekbones — a bare sphere reads as a ball, not a skull.
          const brow = new THREE.BoxGeometry(0.21, 0.05, 0.06, 3, 1, 1); brow.translate(0, 0.07, 0.16);
          const cheekL = new THREE.SphereGeometry(0.055, 8, 6); cheekL.translate(-0.13, -0.04, 0.12);
          const cheekR = new THREE.SphereGeometry(0.055, 8, 6); cheekR.translate(0.13, -0.04, 0.12);
          return mergeGeos([sk, jaw, brow, cheekL, cheekR]);
        },
        mat: () => stdMat(0xb9b2a0),
        place: (d, e, t) => {
          d.position.set(e.x, (1.6 + Math.sin(t * 4 + e.phase) * 0.05) * e.scale, e.z);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // eyes
        geo: () => {
          const a = new THREE.SphereGeometry(0.045, 12, 9); a.translate(-0.075, 0.02, 0.16);
          const b = new THREE.SphereGeometry(0.045, 12, 9); b.translate(0.075, 0.02, 0.16);
          return mergeGeos([a, b]);
        },
        mat: () => new THREE.MeshBasicMaterial({ color: 0x8affd8 }),
        place: (d, e, t) => {
          d.position.set(e.x, (1.6 + Math.sin(t * 4 + e.phase) * 0.05) * e.scale, e.z);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // skeletal arms
        geo: () => {
          const a = new THREE.CapsuleGeometry(0.05, 0.44, 6, 12); a.rotateZ(0.4); a.translate(-0.32, -0.1, 0.06);
          const b = new THREE.CapsuleGeometry(0.05, 0.44, 6, 12); b.rotateZ(-0.4); b.translate(0.32, -0.1, 0.06);
          // Bony hands so the sleeves do not end in stumps.
          const hL = new THREE.IcosahedronGeometry(0.07, 1); hL.translate(-0.44, -0.32, 0.06);
          const hR = new THREE.IcosahedronGeometry(0.07, 1); hR.translate(0.44, -0.32, 0.06);
          return mergeGeos([a, b, hL, hR]);
        },
        mat: () => stdMat(0xa9a290),
        place: (d, e, t) => {
          d.position.set(e.x, 1.24 * e.scale, e.z);
          d.rotation.set(Math.sin(t * 5 + e.phase) * 0.24, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      { // rusted blade
        geo: () => {
          const blade = new THREE.BoxGeometry(0.07, 0.72, 0.02, 1, 6, 1); blade.translate(0, 0.3, 0);
          const tip = new THREE.ConeGeometry(0.05, 0.16, 6); tip.translate(0, 0.72, 0);
          const guard = new THREE.BoxGeometry(0.22, 0.05, 0.05, 3, 1, 1);
          const grip = new THREE.CylinderGeometry(0.028, 0.032, 0.2, 8); grip.translate(0, -0.12, 0);
          const pommel = new THREE.OctahedronGeometry(0.045, 1); pommel.translate(0, -0.23, 0);
          return mergeGeos([blade, tip, guard, grip, pommel]);
        },
        mat: () => stdMat(0x6e5a48, { metalness: 0.5, roughness: 0.6 }),
        place: (d, e, t) => {
          const sw = Math.sin(t * 5 + e.phase) * 0.24;
          const c = Math.cos(e.yaw), sn = Math.sin(e.yaw);
          d.position.set(e.x - c * 0.36 * e.scale, 1.16 * e.scale, e.z + sn * 0.36 * e.scale);
          d.rotation.set(sw - 0.5, e.yaw, -0.3);
          d.scale.setScalar(e.scale);
        },
      },
    ],
  };

  // --- Shrieker: detonates on death ----------------------------------------
  types.shrieker = {
    name: 'Shrieker',
    hp: 30, speed: 5.0, dmg: 12, radius: 0.62, xp: 6, scale: 1.1,
    tint: 0xa33f2a, blood: 0xff8a3c,
    minute: 6, explodes: { radius: 3.4, dmg: 26 },
    parts: [
      { // swollen body
        geo: () => new THREE.SphereGeometry(0.44, 24, 18),
        mat: () => stdMat(0x8f3626, { emissive: 0x431208 }),
        place: (d, e, t) => {
          const pulse = 1 + Math.sin(t * 8 + e.phase) * 0.13;
          d.position.set(e.x, 0.55 * e.scale, e.z);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale * pulse);
        },
      },
      { // cracked shell plates
        geo: () => {
          const g = [];
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * TAU + 0.4;
            const q = new THREE.SphereGeometry(0.2, 14, 10, 0, TAU, 0, Math.PI * 0.5);
            q.rotateX(1.0); q.rotateY(a);
            q.translate(Math.sin(a) * 0.34, 0.1, Math.cos(a) * 0.34);
            g.push(q);
          }
          return mergeGeos(g);
        },
        mat: () => stdMat(0x5c2318),
        place: (d, e, t) => {
          const pulse = 1 + Math.sin(t * 8 + e.phase) * 0.09;
          d.position.set(e.x, 0.55 * e.scale, e.z);
          d.rotation.set(0, e.yaw + t * 0.3, 0);
          d.scale.setScalar(e.scale * pulse);
        },
      },
      { // glowing seams
        geo: () => new THREE.TorusGeometry(0.46, 0.06, 12, 32),
        mat: () => new THREE.MeshBasicMaterial({ color: 0xff7b3c }),
        place: (d, e, t) => {
          d.position.set(e.x, 0.55 * e.scale, e.z);
          d.rotation.set(Math.PI / 2, 0, t * 2 + e.phase);
          d.scale.setScalar(e.scale * (1 + Math.sin(t * 8 + e.phase) * 0.13));
        },
      },
      { // gaping maw
        geo: () => { const g = new THREE.ConeGeometry(0.19, 0.3, 16, 2, true); g.rotateX(-Math.PI / 2); g.translate(0, 0, 0.36); return g; },
        mat: () => new THREE.MeshBasicMaterial({ color: 0xffca6a, side: THREE.DoubleSide }),
        place: (d, e, t) => {
          d.position.set(e.x, 0.55 * e.scale, e.z);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale * (1 + Math.sin(t * 11 + e.phase) * 0.18));
        },
      },
      { // spines
        geo: () => {
          const g = [];
          for (let i = 0; i < 5; i++) {
            const a = (i / 5) * TAU;
            const q = new THREE.ConeGeometry(0.05, 0.28, 9);
            q.rotateX(Math.PI / 2.4); q.rotateY(a);
            q.translate(Math.sin(a) * 0.36, 0.28, Math.cos(a) * 0.36);
            g.push(q);
          }
          return mergeGeos(g);
        },
        mat: () => stdMat(0xe8b06a),
        place: (d, e, t) => {
          d.position.set(e.x, 0.55 * e.scale, e.z);
          d.rotation.set(0, e.yaw + t * 0.3, 0);
          d.scale.setScalar(e.scale * (1 + Math.sin(t * 8 + e.phase) * 0.1));
        },
      },
    ],
  };

  return types;
}

export const ENEMY_TYPES = makeTypes();

// ---------------------------------------------------------------------------
// Bosses — hand-built hierarchies, at most a couple alive at once
// ---------------------------------------------------------------------------

const BOSS_DEFS = [
  {
    key: 'treant',
    name: 'Elder Treant',
    hp: 1500, speed: 4.0, dmg: 30, radius: 2.4, xp: 185, blood: 0x3f6b2a,
    build: bossTreant,
    ability: 'slam',
  },
  {
    key: 'wyrm',
    name: 'Blight Wyrm',
    hp: 2100, speed: 4.6, dmg: 34, radius: 2.1, xp: 231, blood: 0x6a8a2a,
    build: bossWyrm,
    ability: 'charge',
  },
  {
    key: 'wraith',
    name: 'Wraith Lord',
    hp: 2600, speed: 4.2, dmg: 32, radius: 2.2, xp: 277, blood: 0x5a3a7a,
    build: bossWraith,
    ability: 'volley',
  },
  {
    key: 'chimera',
    name: 'Hollow Chimera',
    hp: 3400, speed: 5.0, dmg: 38, radius: 2.5, xp: 338, blood: 0x8a2b3a,
    build: bossChimera,
    ability: 'all',
  },
];

function bossTreant() {
  const g = new THREE.Group();
  const bark = stdMat(0x3b2c1e);
  const leaf = stdMat(0x1d3a1f);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.5, 4.6, 24, 4), bark);
  trunk.position.y = 2.3; trunk.castShadow = true; g.add(trunk);

  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(2.1, 3), leaf);
  crown.position.y = 5.4; crown.castShadow = true; g.add(crown);

  const face = new THREE.Mesh(new THREE.SphereGeometry(0.9, 28, 20), stdMat(0x2a1f14));
  face.position.set(0, 3.2, 1.0); face.scale.z = 0.6; g.add(face);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffb03c });
  [-0.35, 0.35].forEach((x) => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.16, 18, 14), eyeMat);
    e.position.set(x, 3.4, 1.5); g.add(e);
  });

  const arms = [];
  [-1, 1].forEach((s) => {
    const arm = new THREE.Group();
    arm.position.set(s * 1.4, 3.4, 0);
    const limb = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.45, 2.8, 20, 3), bark);
    limb.position.y = -1.2; limb.castShadow = true; arm.add(limb);
    const fist = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7, 2), bark);
    fist.position.y = -2.6; fist.castShadow = true; arm.add(fist);
    arm.rotation.z = s * 0.35;
    g.add(arm);
    arms.push(arm);
  });

  const roots = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    const r = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.5, 14), bark);
    r.position.set(Math.cos(a) * 1.2, 0.5, Math.sin(a) * 1.2);
    r.rotation.z = Math.cos(a) * 0.5;
    r.rotation.x = -Math.sin(a) * 0.5;
    g.add(r);
    roots.push(r);
  }
  return { group: g, anim: { arms, crown, roots } };
}

function bossWyrm() {
  const g = new THREE.Group();
  const scaleMat = stdMat(0x2f4a1c, { metalness: 0.2, roughness: 0.6 });
  const bellyMat = stdMat(0x7a8f3a);

  const segs = [];
  for (let i = 0; i < 9; i++) {
    const s = 1.15 - i * 0.1;
    const seg = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 3), i % 2 ? scaleMat : bellyMat);
    seg.castShadow = true;
    seg.position.set(0, 1.1, -i * 1.05);
    g.add(seg);
    segs.push(seg);
  }

  const head = new THREE.Group();
  head.position.set(0, 1.5, 1.3);
  const skull = new THREE.Mesh(new THREE.ConeGeometry(0.95, 2.2, 22), scaleMat);
  skull.rotation.x = Math.PI / 2; skull.castShadow = true; head.add(skull);
  const jaw = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.4, 18), stdMat(0x1c2a10));
  jaw.rotation.x = Math.PI / 2; jaw.position.set(0, -0.35, 0.4); head.add(jaw);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xd6ff3c });
  [-0.4, 0.4].forEach((x) => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.18, 18, 14), eyeMat);
    e.position.set(x, 0.32, 0.5); head.add(e);
  });
  for (let i = 0; i < 6; i++) {
    const t = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.4, 12), stdMat(0xe8e2c8));
    t.position.set((i % 2 ? 1 : -1) * 0.42, -0.1, 0.75 - Math.floor(i / 2) * 0.28);
    t.rotation.x = Math.PI / 2.2; head.add(t);
  }
  g.add(head);
  return { group: g, anim: { segs, head, jaw } };
}

function bossWraith() {
  const g = new THREE.Group();
  const robe = stdMat(0x2b2338, { transparent: true, opacity: 0.93, side: THREE.DoubleSide });
  const body = new THREE.Mesh(new THREE.ConeGeometry(1.5, 4.4, 28, 8, true), robe);
  body.position.y = 2.2; body.castShadow = true; g.add(body);

  const hood = new THREE.Mesh(new THREE.SphereGeometry(1.0, 28, 20, 0, TAU, 0, Math.PI * 0.6), robe);
  hood.position.y = 4.1; hood.castShadow = true; g.add(hood);

  const voidFace = new THREE.Mesh(new THREE.SphereGeometry(0.7, 24, 18), new THREE.MeshBasicMaterial({ color: 0x05030a }));
  voidFace.position.set(0, 3.95, 0.25); g.add(voidFace);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xbb6bff });
  const eyes = [];
  [-0.26, 0.26].forEach((x) => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), eyeMat);
    e.position.set(x, 4.0, 0.78); g.add(e); eyes.push(e);
  });

  // Floating sigil ring — spins faster while casting.
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.0, 0.08, 14, 56),
    new THREE.MeshBasicMaterial({ color: 0x9b5cff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending })
  );
  ring.rotation.x = Math.PI / 2; ring.position.y = 1.2; g.add(ring);

  const hands = [];
  [-1, 1].forEach((s) => {
    const h = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 2), stdMat(0xcfc8d8));
    h.position.set(s * 1.5, 2.6, 0.6); g.add(h); hands.push(h);
  });

  const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4.2, 16), stdMat(0x2a2118));
  staff.position.set(1.7, 2.4, 0.5); staff.rotation.z = -0.16; g.add(staff);
  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 2), new THREE.MeshBasicMaterial({ color: 0xbb6bff }));
  orb.position.set(1.85, 4.5, 0.5); g.add(orb);

  return { group: g, anim: { ring, hands, eyes, orb, body } };
}

function bossChimera() {
  const g = new THREE.Group();
  const hide = stdMat(0x4a1f24);
  const mane = stdMat(0x22131a);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(1.15, 1.9, 12, 28), hide);
  torso.rotation.x = Math.PI / 2; torso.position.y = 1.8; torso.castShadow = true; g.add(torso);

  const collar = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.42, 14, 36), mane);
  collar.position.set(0, 2.1, 1.1); collar.rotation.x = 0.3; g.add(collar);

  const heads = [];
  [-0.85, 0, 0.85].forEach((x, i) => {
    const h = new THREE.Group();
    h.position.set(x, 2.5 + (i === 1 ? 0.45 : 0), 1.9);
    const skull = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.25, 20), hide);
    skull.rotation.x = Math.PI / 2; skull.castShadow = true; h.add(skull);
    const eyeMat = new THREE.MeshBasicMaterial({ color: i === 1 ? 0xffd23c : 0xff3c3c });
    [-0.2, 0.2].forEach((ex) => {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), eyeMat);
      e.position.set(ex, 0.16, 0.42); h.add(e);
    });
    g.add(h);
    heads.push(h);
  });

  const legs = [];
  [[-0.8, 1.0], [0.8, 1.0], [-0.8, -1.0], [0.8, -1.0]].forEach(([x, z]) => {
    const l = new THREE.Group();
    l.position.set(x, 1.5, z);
    const limb = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 1.1, 8, 18), hide);
    limb.position.y = -0.7; limb.castShadow = true; l.add(limb);
    const claw = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.4, 14), stdMat(0xd8cfb8));
    claw.position.y = -1.45; claw.rotation.x = Math.PI; l.add(claw);
    g.add(l);
    legs.push(l);
  });

  const tail = new THREE.Group();
  tail.position.set(0, 2.0, -1.9);
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.34 - i * 0.05, 18, 14), mane);
    s.position.set(0, i * 0.16, -i * 0.55);
    tail.add(s);
  }
  const stinger = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.8, 14), new THREE.MeshBasicMaterial({ color: 0x9bff5c }));
  stinger.position.set(0, 0.8, -2.9); stinger.rotation.x = -0.5; tail.add(stinger);
  g.add(tail);

  return { group: g, anim: { heads, legs, tail, collar } };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

const _tmpNeighbors = [];

/** Releases the GPU resources of a per-spawn boss hierarchy. */
function disposeHierarchy(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m) m.dispose();
  });
}

export class EnemyManager {
  constructor(scene, vfx, game) {
    this.scene = scene;
    this.vfx = vfx;
    this.game = game;

    this.typeKeys = Object.keys(ENEMY_TYPES);
    this.enemies = [];         // flat list of all live trash mobs
    this.bosses = [];
    this.hash = new SpatialHash(3.2);

    this.spawnTimer = 0.9;
    this.bossTimer = CFG.FIRST_BOSS_AT;
    this.bossIndex = 0;
    this.bossCycle = 0;
    this.totalKills = 0;
    // Held high while a level is being cleared and through the breather that
    // follows, so the field stays empty until the next level actually starts.
    this.spawnPaused = false;
    // Raised alongside spawnPaused while a level is clearing: the field is
    // being wiped, not farmed, so nothing that dies in that window pays out.
    this.rewardsOff = false;

    this._dummy = new THREE.Object3D();
    this._buildInstances();
    this._buildProjectiles();
    this._bossPrefabs = new Map();
  }

  _buildInstances() {
    const CAP = 260;
    this.render = {};
    for (const key of this.typeKeys) {
      const def = ENEMY_TYPES[key];
      const meshes = def.parts.map((part) => {
        const m = new THREE.InstancedMesh(part.geo(), part.mat(), CAP);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3).fill(1), 3);
        m.instanceColor.setUsage(THREE.DynamicDrawUsage);
        m.frustumCulled = false;
        m.castShadow = !def.flying;
        m.count = 0;
        this.scene.add(m);
        return m;
      });
      this.render[key] = { meshes, cap: CAP, list: [], pool: [] };
    }
  }

  _buildProjectiles() {
    const MAX = 110;
    const geo = new THREE.IcosahedronGeometry(0.2, 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x9bff6a });
    this.projMesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.projMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3);
    this.projMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.projMesh.frustumCulled = false;
    this.projMesh.count = 0;
    this.scene.add(this.projMesh);
    this.projectiles = [];
    for (let i = 0; i < MAX; i++) {
      this.projectiles.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vz: 0, life: 0, dmg: 0, r: 0.4, col: new THREE.Color(0x9bff6a) });
    }
  }

  // ---- spawning -----------------------------------------------------------

  /** Types unlocked at the current run time, weighted so newer ones dominate. */
  _spawnTable(minutes) {
    const table = [];
    for (const key of this.typeKeys) {
      const def = ENEMY_TYPES[key];
      if (minutes < def.minute) continue;
      const age = minutes - def.minute;
      // Ramp in over ~1 minute, then slowly decay so early trash thins out.
      const w = Math.min(1, 0.25 + age) * (1 / (1 + age * 0.12));
      table.push([key, w]);
    }
    if (!table.length) table.push(['goblin', 1]);
    return table;
  }

  spawnOne(key, x, z, elapsed, scaleOverride) {
    const bucket = this.render[key];
    if (!bucket) return null;
    if (this.enemies.length >= CFG.SPAWN.maxAlive) return null;
    if (bucket.list.length >= bucket.cap) return null;

    const def = ENEMY_TYPES[key];
    const d = difficulty(elapsed);
    const e = bucket.pool.pop() || {};
    e.alive = true;
    e.key = key;
    e.def = def;
    e.x = x; e.z = z;
    e.y = def.flying ? 1.5 + Math.random() * 0.9 : 0;
    e.baseY = e.y;
    e.maxHp = def.hp * d.hpMul;
    e.hp = e.maxHp;
    e.speed = def.speed * d.speedMul * rand(0.92, 1.08);
    e.dmg = def.dmg * d.dmgMul;
    e.radius = def.radius * CFG.SCALE.monster;
    e.xp = Math.max(1, Math.round(def.xp * d.xpMul));
    e.scale = (scaleOverride || def.scale) * rand(0.92, 1.1) * CFG.SCALE.monster;
    e.phase = Math.random() * TAU;
    e.yaw = Math.random() * TAU;
    e.hitFlash = 0;
    e.attackCd = 0;
    e.rangedCd = rand(0.5, 2.5);
    e.kx = 0; e.kz = 0;      // knockback velocity
    e.slow = 0;              // slow effect timer
    e.burn = 0; e.burnDps = 0;
    e.isBoss = false;
    e.frozen = 0;

    bucket.list.push(e);
    this.enemies.push(e);
    return e;
  }

  spawnWave(player, elapsed) {
    const playerPos = player.pos;
    const d = difficulty(elapsed);
    const minutes = elapsed / 60;
    const table = this._spawnTable(minutes);
    let count = Math.round(CFG.SPAWN.baseCount * d.countMul);
    count = clamp(count, 1, 17);

    for (let i = 0; i < count; i++) {
      const key = weighted(table);
      const def = ENEMY_TYPES[key];
      // Most of the wave materialises in the arc the hunter is running into.
      const p = ringPointBiased(
        playerPos.x, playerPos.z, CFG.SPAWN.innerRadius, CFG.SPAWN.outerRadius,
        player.vel.x, player.vel.z
      );
      if (def.cluster) {
        const n = randInt(def.cluster[0], def.cluster[1]);
        for (let c = 0; c < n; c++) {
          this.spawnOne(key, p.x + rand(-2.5, 2.5), p.z + rand(-2.5, 2.5), elapsed);
        }
      } else {
        this.spawnOne(key, p.x, p.z, elapsed);
      }
    }
  }

  spawnBoss(player, elapsed) {
    const playerPos = player.pos || player;
    const def = BOSS_DEFS[this.bossIndex % BOSS_DEFS.length];
    const cycle = Math.floor(this.bossIndex / BOSS_DEFS.length);
    this.bossIndex++;

    // Always build a fresh hierarchy — two bosses of the same kind can be alive
    // at once late in a run, and they animate independently.
    const prefab = def.build();

    const p = ringPointBiased(
      playerPos.x, playerPos.z, 17, 21,
      player.vel ? player.vel.x : 0, player.vel ? player.vel.z : 0, 0.8
    );
    const mul = 1 + cycle * 1.15;
    const d = difficulty(elapsed);

    const boss = {
      alive: true, isBoss: true, def,
      group: prefab.group, anim: prefab.anim,
      x: p.x, z: p.z, y: 0,
      maxHp: def.hp * mul * (0.7 + d.hpMul * 0.5),
      hp: 0,
      speed: def.speed * (1 + cycle * 0.06),
      dmg: def.dmg * d.dmgMul,
      radius: def.radius,
      xp: Math.round(def.xp * mul),
      yaw: 0, phase: 0, hitFlash: 0,
      attackCd: 2, abilityCd: 5, state: 'chase', stateT: 0,
      kx: 0, kz: 0, slow: 0, burn: 0, burnDps: 0, frozen: 0,
      scale: 1,
      key: 'boss',
    };
    boss.hp = boss.maxHp;
    boss.group.position.set(boss.x, 0, boss.z);
    this.scene.add(boss.group);
    this.bosses.push(boss);

    SFX.bossSpawn();
    this.vfx.ring(p.x, p.z, 1, 16, 0xff3c3c, 1.2);
    if (this.game.onBossSpawn) this.game.onBossSpawn(boss);
    return boss;
  }

  // ---- damage / death -----------------------------------------------------

  hurt(e, amount, opts = {}) {
    if (!e.alive) return 0;
    const crit = opts.crit || false;
    e.hp -= amount;
    e.hitFlash = 1;
    if (opts.knock && Number.isFinite(opts.knock.x) && Number.isFinite(opts.knock.z)) {
      // Clamped: several sources can land on the same enemy in one frame, and
      // an unbounded impulse would fling it clean past the despawn radius.
      e.kx = clamp(e.kx + opts.knock.x, -40, 40);
      e.kz = clamp(e.kz + opts.knock.z, -40, 40);
    }
    if (opts.slow) e.slow = Math.max(e.slow, opts.slow);
    if (opts.burn) {
      e.burn = Math.max(e.burn, opts.burn.time);
      e.burnDps = Math.max(e.burnDps, opts.burn.dps);
    }
    if (opts.freeze) e.frozen = Math.max(e.frozen, opts.freeze);

    const y = (e.isBoss ? 3.2 : 0.9 * (e.scale || 1)) + (e.y || 0);
    this.vfx.damageNumber(e.x, y, e.z, amount, { crit });
    if (!opts.silent) SFX.hit();

    if (e.hp <= 0) {
      this.kill(e);
      return amount;
    }
    this.vfx.bloodBurst(e.x, y * 0.7, e.z, e.def.blood, false);
    return amount;
  }

  kill(e) {
    if (!e.alive) return;
    e.alive = false;

    // A level clear wipes the field. Anything that dies between the boss going
    // down and the next level starting counts for nothing — whether the sweep
    // took it or a weapon that was still swinging did. Without this a straggler
    // killed during the sweep would quietly pay out parts and a kill, which is
    // exactly what clearing the level is supposed to rule out. The boss is
    // always counted: it is what ended the level.
    const pays = !this.rewardsOff || e.isBoss;
    if (pays) this.totalKills++;

    if (e.isBoss) {
      SFX.bossDie();
      this.vfx.ring(e.x, e.z, 1, 22, 0xffd23c, 1.4);
      this.vfx.bloodBurst(e.x, 2.4, e.z, e.def.blood, true);
      this.vfx.spawnParticles(e.x, 2.2, e.z, 60, { color: 0xffd23c, speed: 11, life: 1.4, size: 1.7, up: 5 });
      this.scene.remove(e.group);
      disposeHierarchy(e.group);
      const i = this.bosses.indexOf(e);
      if (i >= 0) this.bosses.splice(i, 1);
      if (this.game.onBossKilled) this.game.onBossKilled(e);
      return;
    }

    SFX.kill();
    this.vfx.bloodBurst(e.x, 0.8, e.z, e.def.blood, e.scale > 1.2);

    // Shriekers detonate, damaging the player and other enemies.
    if (e.def.explodes) {
      const { radius, dmg } = e.def.explodes;
      SFX.explode();
      this.vfx.ring(e.x, e.z, 0.6, radius * 1.6, 0xff7b3c, 0.5);
      this.vfx.spawnParticles(e.x, 0.7, e.z, 26, { color: 0xff7b3c, speed: 9, life: 0.7, size: 1.2, up: 3 });
      // Snapshot the neighbours: hurt() can kill another shrieker, which
      // re-enters this method and re-runs hash.query() on the same shared
      // scratch array. Iterating the live buffer would skip or double-hit.
      const near = this.hash.query(e.x, e.z, radius, _tmpNeighbors).slice();
      for (const o of near) {
        if (o === e || !o.alive) continue;
        const dx = o.x - e.x, dz = o.z - e.z;
        if (dx * dx + dz * dz <= radius * radius) this.hurt(o, dmg * 0.5, { silent: true });
      }
      if (this.game.explosionHitsPlayer) this.game.explosionHitsPlayer(e.x, e.z, radius, dmg);
    }

    if (pays && this.game.onEnemyKilled) this.game.onEnemyKilled(e);
  }

  // ---- enemy projectiles --------------------------------------------------

  fireProjectile(x, y, z, tx, tz, speed, dmg, color = 0x9bff6a) {
    for (const p of this.projectiles) {
      if (p.alive) continue;
      const dx = tx - x, dz = tz - z;
      const len = Math.hypot(dx, dz) || 1;
      p.alive = true;
      p.x = x; p.y = y; p.z = z;
      p.vx = (dx / len) * speed;
      p.vz = (dz / len) * speed;
      p.life = 4.5;
      p.dmg = dmg;
      p.col.set(color);
      return p;
    }
    return null;
  }

  _updateProjectiles(dt, player) {
    const d = this._dummy;
    let n = 0;
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.life -= dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      if (p.life <= 0) { p.alive = false; continue; }

      const dx = p.x - player.pos.x, dz = p.z - player.pos.z;
      if (dx * dx + dz * dz < 0.62 * 0.62) {
        p.alive = false;
        this.game.hitPlayer(p.dmg);
        this.vfx.sparks(p.x, p.y, p.z, 0xff6a6a, 8);
        continue;
      }

      d.position.set(p.x, p.y, p.z);
      d.rotation.set(p.life * 8, p.life * 6, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      this.projMesh.setMatrixAt(n, d.matrix);
      this.projMesh.instanceColor.setXYZ(n, p.col.r, p.col.g, p.col.b);
      n++;
    }
    this.projMesh.count = n;
    if (n > 0) {
      this.projMesh.instanceMatrix.needsUpdate = true;
      this.projMesh.instanceColor.needsUpdate = true;
    }
  }

  // ---- per-frame update ---------------------------------------------------

  update(dt, player, elapsed) {
    // 1. Timers -------------------------------------------------------------
    const d = difficulty(elapsed);
    if (!this.spawnPaused) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        const interval = Math.max(CFG.SPAWN.minInterval, CFG.SPAWN.baseInterval / d.countMul);
        this.spawnTimer = interval / CFG.DENSITY;
        this.spawnWave(player, elapsed);
      }

      this.bossTimer -= dt;
      if (this.bossTimer <= 0) {
        // Infinity, not BOSS_INTERVAL: a level owns exactly one boss, and the
        // clock for the next one is restarted by the game when the next level
        // begins. Rearming here would stack a second boss on a slow fight.
        this.bossTimer = Infinity;
        this.spawnBoss(player, elapsed);
      }
    }

    // Cache the hunter's heading for the straggler-recycling path below.
    this._pvx = player.vel.x;
    this._pvz = player.vel.z;

    // 2. Rebuild the spatial hash (weapons query it after this returns) ------
    this.hash.clear();
    for (const e of this.enemies) if (e.alive) this.hash.insert(e, e.x, e.z);
    for (const b of this.bosses) if (b.alive) this.hash.insert(b, b.x, b.z);

    // 3. Trash mob simulation ------------------------------------------------
    const px = player.pos.x, pz = player.pos.z;
    const despawn2 = CFG.SPAWN.despawnRadius * CFG.SPAWN.despawnRadius;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.alive) {
        this.enemies.splice(i, 1);
        const bucket = this.render[e.key];
        const li = bucket.list.indexOf(e);
        if (li >= 0) bucket.list.splice(li, 1);
        bucket.pool.push(e);
        continue;
      }
      this._simEnemy(e, dt, player, px, pz, despawn2, elapsed);
    }

    // 4. Bosses --------------------------------------------------------------
    for (let i = this.bosses.length - 1; i >= 0; i--) {
      const b = this.bosses[i];
      if (!b.alive) { this.bosses.splice(i, 1); continue; }
      this._simBoss(b, dt, player, elapsed);
    }

    // 5. Push matrices to the GPU --------------------------------------------
    this._writeInstances(elapsed);
    this._updateProjectiles(dt, player);
  }

  _simEnemy(e, dt, player, px, pz, despawn2, elapsed) {
    // Status effects.
    if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
    if (e.slow > 0) e.slow -= dt;
    if (e.frozen > 0) e.frozen -= dt;
    if (e.burn > 0) {
      e.burn -= dt;
      e.hp -= e.burnDps * dt;
      if (Math.random() < dt * 6) {
        this.vfx.spawnParticles(e.x, 0.7 + e.y, e.z, 1, { color: 0xff8a3c, speed: 1.2, life: 0.4, size: 0.5, up: 1.6, grav: -1 });
      }
      if (e.hp <= 0) { this.kill(e); return; }
    }

    let dx = px - e.x;
    let dz = pz - e.z;
    const dist2 = dx * dx + dz * dz;

    // Recycle stragglers to the far side so the horde stays in play.
    if (dist2 > despawn2) {
      const p = ringPointBiased(
        px, pz, CFG.SPAWN.innerRadius, CFG.SPAWN.outerRadius,
        this._pvx, this._pvz
      );
      e.x = p.x; e.z = p.z;
      return;
    }

    const dist = Math.sqrt(dist2) || 1;
    dx /= dist; dz /= dist;
    e.yaw = Math.atan2(dx, dz);

    // Movement.
    let spd = e.speed;
    if (e.slow > 0) spd *= 0.55;
    if (e.frozen > 0) spd = 0;

    let mx = dx, mz = dz;
    if (e.def.weave) {
      // Flyers sine-weave so they do not form a laser-straight conga line.
      const w = Math.sin(elapsed * e.def.weave + e.phase);
      mx += -dz * w * 0.55;
      mz += dx * w * 0.55;
    }

    // Ranged units hold their distance.
    const rng = e.def.ranged;
    if (rng) {
      if (dist < rng.range * 0.7) { mx = -dx; mz = -dz; }
      else if (dist < rng.range) { mx = -dz; mz = dx; }
      e.rangedCd -= dt;
      if (e.rangedCd <= 0 && dist < rng.range * 1.1) {
        e.rangedCd = rng.cooldown * rand(0.85, 1.2);
        this.fireProjectile(e.x, e.y || 1.2, e.z, px, pz, rng.speed, rng.dmg * difficulty(elapsed).dmgMul, 0x63d9ff);
      }
    }

    // Separation — keeps the horde from collapsing into one pixel.
    const near = this.hash.query(e.x, e.z, 1.35, _tmpNeighbors);
    let sx = 0, sz = 0;
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (o === e || !o.alive) continue;
      const ox = e.x - o.x, oz = e.z - o.z;
      const d2 = ox * ox + oz * oz;
      const minD = (e.radius + o.radius) * 0.8;
      if (d2 > 0.0001 && d2 < minD * minD) {
        const dd = Math.sqrt(d2);
        const push = (minD - dd) / minD;
        sx += (ox / dd) * push;
        sz += (oz / dd) * push;
      }
    }

    e.x += (mx * spd + sx * 5.2 + e.kx) * dt;
    e.z += (mz * spd + sz * 5.2 + e.kz) * dt;

    // Knockback decay.
    e.kx *= Math.max(0, 1 - 9 * dt);
    e.kz *= Math.max(0, 1 - 9 * dt);

    if (e.def.flying) {
      e.y = e.baseY + Math.sin(elapsed * 2.2 + e.phase) * 0.35;
    }

    // Contact damage.
    e.attackCd -= dt;
    const touch = e.radius + 0.72;
    if (dist < touch && e.attackCd <= 0 && !rng) {
      e.attackCd = 0.75;
      this.game.hitPlayer(e.dmg);
    }
  }

  _simBoss(b, dt, player, elapsed) {
    if (b.hitFlash > 0) b.hitFlash = Math.max(0, b.hitFlash - dt * 4);
    if (b.slow > 0) b.slow -= dt;
    if (b.frozen > 0) b.frozen -= dt;
    if (b.burn > 0) {
      b.burn -= dt;
      b.hp -= b.burnDps * dt;
      if (b.hp <= 0) { this.kill(b); return; }
    }

    const px = player.pos.x, pz = player.pos.z;
    let dx = px - b.x, dz = pz - b.z;
    const dist = Math.hypot(dx, dz) || 1;
    dx /= dist; dz /= dist;

    b.phase += dt;
    b.stateT -= dt;
    b.abilityCd -= dt;
    b.attackCd -= dt;

    let spd = b.speed * (b.slow > 0 ? 0.6 : 1) * (b.frozen > 0 ? 0 : 1);

    if (b.state === 'chase') {
      b.x += (dx * spd + b.kx) * dt;
      b.z += (dz * spd + b.kz) * dt;
      const wantYaw = Math.atan2(dx, dz);
      let diff = wantYaw - b.yaw;
      while (diff > Math.PI) diff -= TAU;
      while (diff < -Math.PI) diff += TAU;
      b.yaw += diff * Math.min(1, 3.5 * dt);

      if (b.abilityCd <= 0) {
        const ab = b.def.ability;
        const choice = ab === 'all' ? pick(['slam', 'charge', 'volley']) : ab;
        b.state = choice === 'slam' ? 'windup' : choice === 'charge' ? 'chargeWindup' : 'cast';
        b.stateT = choice === 'volley' ? 1.1 : 0.85;
        b.abilityCd = 6.5 + Math.random() * 3;
        if (choice === 'charge') {
          b.chargeDirX = dx; b.chargeDirZ = dz;
        }
      }
    } else if (b.state === 'windup') {
      // Telegraph the slam with a shrinking ring so it can be dodged.
      if (b.stateT <= 0) {
        b.state = 'chase';
        const R = 7.5;
        SFX.explode();
        this.vfx.ring(b.x, b.z, 1, R * 1.5, 0xff5a2a, 0.6);
        this.vfx.spawnParticles(b.x, 0.5, b.z, 40, { color: 0x8a6a3a, speed: 12, life: 0.9, size: 1.6, up: 4 });
        if (this.game.explosionHitsPlayer) this.game.explosionHitsPlayer(b.x, b.z, R, b.dmg * 1.2);
        this.game.shake(0.9);
      } else if (Math.random() < dt * 8) {
        this.vfx.ring(b.x, b.z, 7.5, 7.0, 0xff5a2a, 0.2);
      }
    } else if (b.state === 'chargeWindup') {
      if (b.stateT <= 0) { b.state = 'charging'; b.stateT = 1.5; }
    } else if (b.state === 'charging') {
      const cs = b.speed * 4.2;
      b.x += b.chargeDirX * cs * dt;
      b.z += b.chargeDirZ * cs * dt;
      if (Math.random() < dt * 20) {
        this.vfx.spawnParticles(b.x, 0.4, b.z, 2, { color: 0x6a5a3a, speed: 3, life: 0.5, size: 1, up: 1 });
      }
      const hd = Math.hypot(px - b.x, pz - b.z);
      if (hd < b.radius + 1.0 && b.attackCd <= 0) {
        b.attackCd = 0.8;
        this.game.hitPlayer(b.dmg * 1.1);
      }
      if (b.stateT <= 0) b.state = 'chase';
    } else if (b.state === 'cast') {
      if (b.stateT <= 0) {
        b.state = 'chase';
        const n = 12;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + Math.random() * 0.2;
          this.fireProjectile(b.x, 2.2, b.z, b.x + Math.cos(a) * 10, b.z + Math.sin(a) * 10, 7.5, b.dmg * 0.5, 0xbb6bff);
        }
        // The Wraith also drags in reinforcements.
        if (b.def.key === 'wraith' || b.def.key === 'chimera') {
          for (let i = 0; i < 6; i++) {
            const p = ringPoint(b.x, b.z, 3, 6);
            this.spawnOne('revenant', p.x, p.z, elapsed);
          }
        }
        SFX.holy();
      }
    }

    b.kx *= Math.max(0, 1 - 9 * dt);
    b.kz *= Math.max(0, 1 - 9 * dt);

    // Contact damage.
    if (dist < b.radius + 0.7 && b.attackCd <= 0) {
      b.attackCd = 0.9;
      this.game.hitPlayer(b.dmg);
    }

    // Transform + per-boss animation.
    b.group.position.set(b.x, 0, b.z);
    b.group.rotation.y = b.yaw;
    this._animBoss(b, elapsed);

    // Hit flash tint.
    const f = b.hitFlash;
    b.group.traverse((o) => {
      if (o.isMesh && o.material && o.material.emissive) {
        o.material.emissive.setRGB(f * 0.8, f * 0.15, f * 0.15);
      }
    });
  }

  _animBoss(b, t) {
    const a = b.anim;
    const winding = b.state === 'windup' || b.state === 'cast' || b.state === 'chargeWindup';
    switch (b.def.key) {
      case 'treant': {
        a.crown.rotation.y = t * 0.25;
        a.crown.position.y = 5.4 + Math.sin(t * 1.4) * 0.12;
        a.arms.forEach((arm, i) => {
          const s = i === 0 ? -1 : 1;
          const raise = winding ? -2.1 : Math.sin(t * 1.8 + i * 2) * 0.35;
          arm.rotation.x = raise;
          arm.rotation.z = s * 0.35;
        });
        break;
      }
      case 'wyrm': {
        a.segs.forEach((s, i) => {
          s.position.x = Math.sin(t * 3.2 - i * 0.55) * (0.35 + i * 0.09);
          s.position.y = 1.1 + Math.sin(t * 2.4 - i * 0.4) * 0.22;
        });
        a.head.position.y = 1.5 + Math.sin(t * 2.4) * 0.2;
        a.jaw.rotation.x = Math.PI / 2 + (b.state === 'charging' ? 0.5 : Math.sin(t * 4) * 0.12);
        break;
      }
      case 'wraith': {
        a.ring.rotation.z = t * (winding ? 5 : 1.2);
        a.ring.position.y = 1.2 + Math.sin(t * 1.6) * 0.25;
        a.body.position.y = 2.2 + Math.sin(t * 1.2) * 0.18;
        a.hands.forEach((h, i) => {
          h.position.y = 2.6 + Math.sin(t * 2 + i * 3) * 0.3;
        });
        a.orb.scale.setScalar(winding ? 1.5 + Math.sin(t * 22) * 0.35 : 1);
        break;
      }
      case 'chimera': {
        a.heads.forEach((h, i) => {
          h.rotation.y = Math.sin(t * 2.2 + i * 1.7) * 0.35;
          h.rotation.x = Math.sin(t * 1.6 + i) * 0.12;
        });
        const gallop = b.state === 'charging' ? 16 : 6;
        a.legs.forEach((l, i) => {
          l.rotation.x = Math.sin(t * gallop + i * Math.PI * 0.5) * 0.55;
        });
        a.tail.rotation.y = Math.sin(t * 1.9) * 0.4;
        a.collar.scale.setScalar(winding ? 1.15 : 1);
        break;
      }
      default: break;
    }
  }

  _writeInstances(t) {
    const d = this._dummy;
    for (const key of this.typeKeys) {
      const bucket = this.render[key];
      const def = ENEMY_TYPES[key];
      const list = bucket.list;
      const limit = Math.min(list.length, bucket.cap);
      for (let p = 0; p < def.parts.length; p++) {
        const mesh = bucket.meshes[p];
        const place = def.parts[p].place;
        // Compact as we go: an enemy killed earlier this frame is still in the
        // list until the next update() sweep, and must not be drawn.
        let n = 0;
        for (let i = 0; i < limit; i++) {
          const e = list[i];
          if (!e.alive) continue;
          place(d, e, t);
          d.updateMatrix();
          mesh.setMatrixAt(n, d.matrix);
          const f = e.hitFlash;
          // Tint toward white on hit; frozen enemies read blue.
          if (e.frozen > 0) mesh.instanceColor.setXYZ(n, 0.55, 0.8, 1.6);
          else mesh.instanceColor.setXYZ(n, 1 + f * 3, 1 + f * 0.6, 1 + f * 0.6);
          n++;
        }
        mesh.count = n;
        if (n > 0) {
          mesh.instanceMatrix.needsUpdate = true;
          mesh.instanceColor.needsUpdate = true;
        }
      }
    }
  }

  /** Everything alive within `radius` of a point, including bosses. */
  queryNear(x, z, radius, out) {
    return this.hash.query(x, z, radius, out);
  }

  /** Nearest living enemy to a point, or null. Used by homing weapons. */
  nearest(x, z, maxRange = 30) {
    let best = null;
    let bestD = maxRange * maxRange;
    const near = this.hash.query(x, z, maxRange, _tmpNeighbors);
    for (const e of near) {
      if (!e.alive) continue;
      const dx = e.x - x, dz = e.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) { bestD = d2; best = e; }
    }
    return best;
  }

  /**
   * Removes every trash mob inside `radius` of a point, awarding nothing.
   *
   * This is the level-clear sweep, and it deliberately does NOT go through
   * kill(): the monsters are vaporised by the boss's death throes, not slain
   * by the hunter. Routing them through kill() would pay out monster parts,
   * inflate the kill tally and set off every shrieker on the field at once.
   *
   * Returns how many it took, so the caller can report the clear.
   */
  vaporizeTrash(cx, cz, radius) {
    const r2 = radius * radius;
    let n = 0;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.x - cx, dz = e.z - cz;
      if (dx * dx + dz * dz > r2) continue;
      // The per-frame loop in update() recycles anything flagged dead.
      e.alive = false;
      // Keep the puff small: the front can cross a hundred monsters in a
      // second and the particle pool has other work to do.
      this.vfx.spawnParticles(e.x, 0.8 * e.scale, e.z, 4, {
        color: 0xffd9a0, speed: 5.5, life: 0.42, size: 0.75, up: 2.6, grav: -7,
      });
      n++;
    }
    // Anything already in the air dies with them.
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      const dx = p.x - cx, dz = p.z - cz;
      if (dx * dx + dz * dz <= r2) p.alive = false;
    }
    return n;
  }

  /** Trash mobs still standing — the level-clear watches this reach zero. */
  get trashAlive() {
    let n = 0;
    for (const e of this.enemies) if (e.alive) n++;
    return n;
  }

  reset() {
    for (const key of this.typeKeys) {
      const bucket = this.render[key];
      for (const e of bucket.list) { e.alive = false; bucket.pool.push(e); }
      bucket.list.length = 0;
      for (const m of bucket.meshes) m.count = 0;
    }
    this.enemies.length = 0;
    for (const b of this.bosses) {
      this.scene.remove(b.group);
      disposeHierarchy(b.group);
    }
    this.bosses.length = 0;
    for (const p of this.projectiles) p.alive = false;
    this.projMesh.count = 0;
    this.spawnTimer = 0.9;
    this.bossTimer = CFG.FIRST_BOSS_AT;
    this.bossIndex = 0;
    this.totalKills = 0;
    this.spawnPaused = false;
    this.rewardsOff = false;
    this.hash.clear();
  }
}
