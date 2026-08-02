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

// ---------------------------------------------------------------------------
// Trash mob type definitions
// ---------------------------------------------------------------------------
// `parts[].place(d, e, t)` positions the THREE.Object3D dummy `d` for enemy `e`
// at run time `t`. It runs once per part per enemy per frame.

function makeTypes() {
  const types = {};

  // --- Rotfeeder: the bread-and-butter swarm unit --------------------------
  types.grub = {
    name: 'Rotfeeder',
    hp: 9, speed: 2.7, dmg: 6, radius: 0.52, xp: 2, scale: 1,
    tint: 0x6a7f4a, blood: 0x4d6b2a,
    minute: 0,
    parts: [
      {
        geo: () => new THREE.IcosahedronGeometry(0.42, 2),
        mat: () => stdMat(0x5c7040),
        place: (d, e, t) => {
          const squash = 1 + Math.sin(t * 9 + e.phase) * 0.16;
          d.position.set(e.x, 0.42 / squash, e.z);
          d.rotation.set(0, e.yaw, 0);
          d.scale.set(e.scale * squash * 0.95, e.scale / squash, e.scale * squash * 0.95);
        },
      },
      {
        geo: () => new THREE.SphereGeometry(0.15, 12, 9),
        mat: () => new THREE.MeshBasicMaterial({ color: 0xd6ff5c }),
        place: (d, e, t) => {
          d.position.set(e.x + Math.sin(e.yaw) * 0.3, 0.5, e.z + Math.cos(e.yaw) * 0.3);
          d.scale.setScalar(e.scale * (0.85 + Math.sin(t * 6 + e.phase) * 0.15));
          d.rotation.set(0, 0, 0);
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
      {
        geo: () => { const g = new THREE.CapsuleGeometry(0.28, 0.62, 8, 16); g.rotateX(Math.PI / 2); return g; },
        mat: () => stdMat(0x33333d),
        place: (d, e, t) => {
          d.position.set(e.x, 0.66 + Math.sin(t * 12 + e.phase) * 0.05, e.z);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      {
        geo: () => { const g = new THREE.ConeGeometry(0.24, 0.5, 14); g.rotateX(Math.PI / 2); return g; },
        mat: () => stdMat(0x2a2a33),
        place: (d, e, t) => {
          d.position.set(e.x + Math.sin(e.yaw) * 0.6, 0.72, e.z + Math.cos(e.yaw) * 0.6);
          d.rotation.set(Math.sin(t * 12 + e.phase) * 0.1, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      {
        geo: () => new THREE.SphereGeometry(0.06, 10, 8),
        mat: () => new THREE.MeshBasicMaterial({ color: 0xff5a3c }),
        place: (d, e) => {
          d.position.set(e.x + Math.sin(e.yaw) * 0.78, 0.78, e.z + Math.cos(e.yaw) * 0.78);
          d.scale.setScalar(e.scale * 1.4);
          d.rotation.set(0, 0, 0);
        },
      },
      {
        geo: () => new THREE.BoxGeometry(0.5, 0.1, 0.12),
        mat: () => stdMat(0x24242c),
        place: (d, e, t) => {
          // Cheap four-legged gallop: one bar that scissors under the body.
          const s = Math.sin(t * 14 + e.phase);
          d.position.set(e.x, 0.24, e.z);
          d.rotation.set(0, e.yaw, s * 0.5);
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
      {
        geo: () => new THREE.IcosahedronGeometry(0.24, 2),
        mat: () => stdMat(0x2e2438),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(0, e.yaw, Math.sin(t * 18 + e.phase) * 0.2);
          d.scale.setScalar(e.scale);
        },
      },
      {
        geo: () => { const g = new THREE.PlaneGeometry(0.62, 0.34, 6, 4); g.translate(0.31, 0, 0); return g; },
        mat: () => stdMat(0x40304d, { side: THREE.DoubleSide }),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(0, e.yaw, Math.sin(t * 22 + e.phase) * 0.9 + 0.2);
          d.scale.setScalar(e.scale);
        },
      },
      {
        geo: () => { const g = new THREE.PlaneGeometry(0.62, 0.34, 6, 4); g.translate(-0.31, 0, 0); return g; },
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
      {
        geo: () => new THREE.SphereGeometry(0.32, 16, 12),
        mat: () => stdMat(0x241d2b),
        place: (d, e, t) => {
          d.position.set(e.x, 0.42 + Math.abs(Math.sin(t * 16 + e.phase)) * 0.07, e.z);
          d.rotation.set(0, e.yaw, 0);
          d.scale.set(e.scale, e.scale * 0.8, e.scale * 1.1);
        },
      },
      {
        geo: () => { const g = new THREE.TorusGeometry(0.42, 0.05, 8, 20, Math.PI); g.rotateX(Math.PI / 2); return g; },
        mat: () => stdMat(0x161119),
        place: (d, e, t) => {
          d.position.set(e.x, 0.3, e.z);
          d.rotation.set(0, e.yaw + Math.sin(t * 16 + e.phase) * 0.25, 0);
          d.scale.setScalar(e.scale);
        },
      },
      {
        geo: () => { const g = new THREE.TorusGeometry(0.42, 0.05, 8, 20, Math.PI); g.rotateX(Math.PI / 2); return g; },
        mat: () => stdMat(0x161119),
        place: (d, e, t) => {
          d.position.set(e.x, 0.3, e.z);
          d.rotation.set(0, e.yaw + Math.PI - Math.sin(t * 16 + e.phase) * 0.25, 0);
          d.scale.setScalar(e.scale);
        },
      },
      {
        geo: () => new THREE.SphereGeometry(0.05, 10, 8),
        mat: () => new THREE.MeshBasicMaterial({ color: 0xff2d5e }),
        place: (d, e) => {
          d.position.set(e.x + Math.sin(e.yaw) * 0.3, 0.5, e.z + Math.cos(e.yaw) * 0.3);
          d.scale.setScalar(e.scale * 1.5);
          d.rotation.set(0, 0, 0);
        },
      },
    ],
  };

  // --- Bonegnasher: slow, tanky, hits hard ---------------------------------
  types.brute = {
    name: 'Bonegnasher',
    hp: 70, speed: 2.4, dmg: 20, radius: 0.95, xp: 9, scale: 1.5,
    tint: 0x6b5a45, blood: 0x8a2b2b,
    minute: 3,
    parts: [
      {
        geo: () => new THREE.CapsuleGeometry(0.5, 0.7, 8, 18),
        mat: () => stdMat(0x5d4d3a),
        place: (d, e, t) => {
          d.position.set(e.x, 0.95 * e.scale, e.z);
          d.rotation.set(0, e.yaw, Math.sin(t * 3.5 + e.phase) * 0.09);
          d.scale.setScalar(e.scale);
        },
      },
      {
        geo: () => new THREE.DodecahedronGeometry(0.36, 1),
        mat: () => stdMat(0xa89275),
        place: (d, e, t) => {
          d.position.set(e.x, 1.72 * e.scale, e.z);
          d.rotation.set(0.1, e.yaw + Math.sin(t * 3 + e.phase) * 0.15, 0);
          d.scale.setScalar(e.scale);
        },
      },
      {
        geo: () => { const g = new THREE.CapsuleGeometry(0.16, 0.72, 6, 14); g.translate(0, -0.4, 0); return g; },
        mat: () => stdMat(0x4a3c2c),
        place: (d, e, t) => {
          const sw = Math.sin(t * 4 + e.phase) * 0.6;
          d.position.set(e.x + Math.cos(e.yaw) * 0.62 * e.scale, 1.4 * e.scale, e.z - Math.sin(e.yaw) * 0.62 * e.scale);
          d.rotation.set(sw, e.yaw, 0.3);
          d.scale.setScalar(e.scale);
        },
      },
      {
        geo: () => { const g = new THREE.CapsuleGeometry(0.16, 0.72, 6, 14); g.translate(0, -0.4, 0); return g; },
        mat: () => stdMat(0x4a3c2c),
        place: (d, e, t) => {
          const sw = -Math.sin(t * 4 + e.phase) * 0.6;
          d.position.set(e.x - Math.cos(e.yaw) * 0.62 * e.scale, 1.4 * e.scale, e.z + Math.sin(e.yaw) * 0.62 * e.scale);
          d.rotation.set(sw, e.yaw, -0.3);
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
      {
        geo: () => new THREE.IcosahedronGeometry(0.34, 2),
        mat: () => new THREE.MeshBasicMaterial({ color: 0x63d9ff, transparent: true, opacity: 0.72 }),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(t * 0.9 + e.phase, t * 1.3, 0);
          d.scale.setScalar(e.scale * (0.9 + Math.sin(t * 4 + e.phase) * 0.12));
        },
      },
      {
        geo: () => new THREE.SphereGeometry(0.5, 14, 10),
        mat: () => new THREE.MeshBasicMaterial({ color: 0x1d5f80, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }),
        place: (d, e, t) => {
          d.position.set(e.x, e.y, e.z);
          d.rotation.set(0, 0, 0);
          d.scale.setScalar(e.scale * (1.2 + Math.sin(t * 3 + e.phase) * 0.2));
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
      {
        geo: () => new THREE.ConeGeometry(0.42, 1.5, 16, 4, true),
        mat: () => stdMat(0x3d4250, { side: THREE.DoubleSide, transparent: true, opacity: 0.92 }),
        place: (d, e, t) => {
          d.position.set(e.x, 0.78, e.z);
          d.rotation.set(Math.sin(t * 5 + e.phase) * 0.07, e.yaw, Math.cos(t * 4 + e.phase) * 0.07);
          d.scale.setScalar(e.scale);
        },
      },
      {
        geo: () => new THREE.SphereGeometry(0.26, 16, 12),
        mat: () => stdMat(0xb9b2a0),
        place: (d, e, t) => {
          d.position.set(e.x, 1.62 + Math.sin(t * 4 + e.phase) * 0.05, e.z);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale);
        },
      },
      {
        geo: () => new THREE.SphereGeometry(0.055, 10, 8),
        mat: () => new THREE.MeshBasicMaterial({ color: 0x8affd8 }),
        place: (d, e) => {
          d.position.set(e.x + Math.sin(e.yaw) * 0.22, 1.66, e.z + Math.cos(e.yaw) * 0.22);
          d.rotation.set(0, 0, 0);
          d.scale.setScalar(e.scale * 1.6);
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
      {
        geo: () => new THREE.SphereGeometry(0.48, 16, 12),
        mat: () => stdMat(0x8f3626, { emissive: 0x431208 }),
        place: (d, e, t) => {
          const pulse = 1 + Math.sin(t * 8 + e.phase) * 0.11;
          d.position.set(e.x, 0.55, e.z);
          d.rotation.set(0, e.yaw, 0);
          d.scale.setScalar(e.scale * pulse);
        },
      },
      {
        geo: () => new THREE.TorusGeometry(0.5, 0.07, 10, 24),
        mat: () => new THREE.MeshBasicMaterial({ color: 0xff7b3c }),
        place: (d, e, t) => {
          d.position.set(e.x, 0.55, e.z);
          d.rotation.set(Math.PI / 2, 0, t * 2 + e.phase);
          d.scale.setScalar(e.scale * (1 + Math.sin(t * 8 + e.phase) * 0.12));
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
    if (!table.length) table.push(['grub', 1]);
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
    e.radius = def.radius;
    e.xp = Math.max(1, Math.round(def.xp * d.xpMul));
    e.scale = (scaleOverride || def.scale) * rand(0.92, 1.1);
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
    this.totalKills++;

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

    if (this.game.onEnemyKilled) this.game.onEnemyKilled(e);
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
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      const interval = Math.max(CFG.SPAWN.minInterval, CFG.SPAWN.baseInterval / d.countMul);
      this.spawnTimer = interval / CFG.DENSITY;
      this.spawnWave(player, elapsed);
    }

    this.bossTimer -= dt;
    if (this.bossTimer <= 0) {
      this.bossTimer = CFG.BOSS_INTERVAL;
      this.spawnBoss(player, elapsed);
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
    const touch = e.radius + 0.55;
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
    this.hash.clear();
  }
}
