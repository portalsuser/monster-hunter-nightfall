import * as THREE from 'three';
import { SFX } from './audio.js';
import { CFG } from './config.js';
import { chance, clamp, rand, TAU } from './utils.js';

/**
 * Weapons
 * -------
 * Every weapon is data + an `update` function. The WeaponSystem owns the shared
 * projectile pool, the ground-effect pool and the damage helpers, so an
 * individual weapon is usually a dozen lines.
 *
 * Damage convention: `dmg` fields are per-hit base values. Final damage is
 * base * player.stats.might, with a crit roll on top.
 */

const scratch = [];

// ---------------------------------------------------------------------------
// Visual styles for the shared projectile pool
// ---------------------------------------------------------------------------
function projectileStyles() {
  return {
    knife: {
      geo: () => {
        const g = new THREE.ConeGeometry(0.09, 0.5, 12);
        g.rotateX(Math.PI / 2);
        return g;
      },
      mat: () => new THREE.MeshStandardMaterial({ color: 0xcfd6e0, metalness: 0.9, roughness: 0.25, flatShading: false }),
      cap: 90,
    },
    cross: {
      geo: () => {
        // A cross built from two boxes merged by hand into one buffer.
        const a = new THREE.BoxGeometry(0.16, 0.62, 0.08);
        const b = new THREE.BoxGeometry(0.44, 0.16, 0.08);
        b.translate(0, 0.08, 0);
        return mergeGeometries([a, b]);
      },
      mat: () => new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0x6a5210, metalness: 0.8, roughness: 0.3 }),
      cap: 40,
    },
    flask: {
      geo: () => new THREE.SphereGeometry(0.19, 20, 16),
      mat: () => new THREE.MeshStandardMaterial({ color: 0x8fd8ff, emissive: 0x1d5f80, transparent: true, opacity: 0.9, roughness: 0.15 }),
      cap: 30,
    },
    frost: {
      geo: () => new THREE.OctahedronGeometry(0.2, 2),
      mat: () => new THREE.MeshStandardMaterial({ color: 0xa8e8ff, emissive: 0x2a6a8a, flatShading: false, roughness: 0.2 }),
      cap: 30,
    },
    glaive: {
      geo: () => {
        const g = new THREE.TorusGeometry(0.46, 0.07, 12, 32, Math.PI * 1.5);
        g.rotateX(Math.PI / 2);
        return g;
      },
      mat: () => new THREE.MeshStandardMaterial({ color: 0xdfe8ff, emissive: 0x33406a, metalness: 0.85, roughness: 0.2 }),
      cap: 16,
    },
    fang: {
      geo: () => {
        const g = new THREE.ConeGeometry(0.11, 0.62, 12);
        g.rotateX(Math.PI / 2);
        return g;
      },
      mat: () => new THREE.MeshStandardMaterial({ color: 0xe8d8b0, metalness: 0.5, roughness: 0.5, flatShading: false }),
      cap: 24,
    },
  };
}

/**
 * Minimal geometry merge — three's BufferGeometryUtils lives in the examples
 * folder, and this project deliberately depends on the core build only.
 * Handles non-indexed and indexed inputs sharing the same attribute set.
 */
function mergeGeometries(geos) {
  const nonIndexed = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const names = Object.keys(nonIndexed[0].attributes);
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    let total = 0;
    for (const g of nonIndexed) total += g.attributes[name].array.length;
    const itemSize = nonIndexed[0].attributes[name].itemSize;
    const arr = new Float32Array(total);
    let off = 0;
    for (const g of nonIndexed) {
      arr.set(g.attributes[name].array, off);
      off += g.attributes[name].array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  }
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------------------
// Weapon definitions
// ---------------------------------------------------------------------------

export const WEAPONS = {
  fists: {
    name: 'Warded Fists',
    icon: '✊',
    color: '#d8c9a8',
    maxLevel: 20,
    starting: true,
    desc: 'Bare-knuckle strikes in a short arc. Everything a hunter starts with.',
    levels: [
      'Strike enemies in front of you.',
      '+45% damage.',
      'Wider arc, +1 rapid follow-up.',
      '+60% damage, knocks enemies back.',
      'Every 4th strike releases a shockwave.',
    ],
    base: { dmg: 14, cd: 0.55, range: 2.4 * CFG.SCALE.reach, arc: 1.6 },
  },

  knives: {
    name: 'Throwing Knives',
    icon: '🗡️',
    color: '#cfd6e0',
    maxLevel: 20,
    desc: 'Hurls knives in the direction you face. They pierce.',
    levels: [
      'Throw 1 knife.',
      'Throw 2 knives.',
      '+1 pierce, +25% damage.',
      'Throw 3 knives in a spread.',
      'Throw 5 knives, +2 pierce.',
    ],
    base: { dmg: 14, cd: 0.85, speed: 20, pierce: 1 },
  },

  sword: {
    name: "Hunter's Blade",
    icon: '⚔️',
    color: '#e8eef7',
    maxLevel: 20,
    desc: 'A heavy sweeping slash that carves through a wide arc.',
    levels: [
      'Slash in a wide arc.',
      '+35% damage, wider arc.',
      'Slashes twice, alternating sides.',
      '+50% damage and reach.',
      'Full 360° whirlwind.',
    ],
    base: { dmg: 26, cd: 1.3, range: 3.4 * CFG.SCALE.reach, arc: 2.0 },
  },

  cross: {
    name: 'Silver Cross',
    icon: '✝️',
    color: '#ffe9a8',
    maxLevel: 20,
    desc: 'A blessed cross that flies out, pierces everything, and returns.',
    levels: [
      'Throw 1 cross that returns.',
      'Throw 2 crosses.',
      '+30% damage, flies further.',
      'Throw 3 crosses.',
      'Crosses sear on contact (burn).',
    ],
    base: { dmg: 20, cd: 1.9, speed: 13, range: 9 },
  },

  holywater: {
    name: 'Holy Water',
    icon: '🧪',
    color: '#8fd8ff',
    maxLevel: 20,
    desc: 'Lobbed flasks shatter into consecrated pools that burn the unclean.',
    levels: [
      'Throw 1 flask.',
      'Throw 2 flasks.',
      'Pools last 50% longer.',
      'Throw 3 flasks, +35% damage.',
      'Pools are much larger and slow enemies.',
    ],
    base: { dmg: 9, cd: 3.2, radius: 2.6, duration: 3.6, tick: 0.35 },
  },

  pyre: {
    continuous: true,
    name: 'Ember Pyre',
    icon: '🔥',
    color: '#ff8a3c',
    maxLevel: 20,
    desc: 'A ring of fire wreathes you, setting anything that closes alight.',
    levels: [
      'Burning aura around you.',
      '+30% radius.',
      '+50% damage, applies burn.',
      '+35% radius, burn stacks harder.',
      'Erupts periodically in a fire nova.',
    ],
    base: { dmg: 7, cd: 0.5, radius: 2.9 * CFG.SCALE.reach },
  },

  fangs: {
    continuous: true,
    name: 'Whetstone Fangs',
    icon: '🌀',
    color: '#e8d8b0',
    maxLevel: 20,
    desc: 'Daggers orbit you, shredding anything they touch.',
    levels: [
      '2 orbiting daggers.',
      '3 daggers.',
      '4 daggers, +25% damage.',
      '5 daggers, wider orbit.',
      '7 daggers, they spin much faster.',
    ],
    base: { dmg: 13, cd: 0.28, radius: 2.5 * CFG.SCALE.reach, speed: 2.4 },
  },

  sigil: {
    name: 'Storm Sigil',
    icon: '⚡',
    color: '#9fd0ff',
    maxLevel: 20,
    desc: 'Calls lightning down on enemies near you. Ignores everything in between.',
    levels: [
      '1 bolt every few seconds.',
      '2 bolts.',
      '+40% damage.',
      '3 bolts, bolts chain to a nearby foe.',
      '5 bolts, each stuns briefly.',
    ],
    base: { dmg: 34, cd: 2.6, range: 11 },
  },

  traps: {
    name: 'Bear Traps',
    icon: '🪤',
    color: '#a8a8b0',
    maxLevel: 20,
    desc: 'Drops iron traps that clamp shut, rooting and mauling whatever steps in.',
    levels: [
      'Drop a trap behind you.',
      'Hold 2 traps.',
      '+40% damage, longer root.',
      'Hold 3 traps.',
      'Traps explode when they snap.',
    ],
    base: { dmg: 45, cd: 3.4, radius: 1.15, root: 1.4 },
  },

  censer: {
    continuous: true,
    name: 'Warding Censer',
    icon: '💨',
    color: '#c8b0ff',
    maxLevel: 20,
    desc: 'A swinging censer pulses out warding smoke, shoving monsters away.',
    levels: [
      'Pulses damage and knockback.',
      '+30% radius.',
      '+40% damage.',
      'Pulses twice as often.',
      'Pulse leaves lingering smoke.',
    ],
    base: { dmg: 11, cd: 1.6, radius: 3.4 * CFG.SCALE.reach, knock: 9 },
  },

  glaive: {
    name: 'Moon Glaive',
    icon: '🌙',
    color: '#dfe8ff',
    maxLevel: 20,
    desc: 'A great crescent blade that arcs out, hunts a target, and comes home.',
    levels: [
      'Throw 1 glaive.',
      '+35% damage.',
      'Throw 2 glaives.',
      'Glaives seek the nearest monster.',
      'Throw 3 glaives, huge damage.',
    ],
    base: { dmg: 40, cd: 2.8, speed: 15, range: 11 },
  },

  frost: {
    name: 'Frost Vial',
    icon: '❄️',
    color: '#a8e8ff',
    maxLevel: 20,
    desc: 'Shatters into a bloom of frost, freezing everything caught in it.',
    levels: [
      'Throw a freezing vial.',
      '+40% radius.',
      'Freeze lasts longer.',
      'Throw 2 vials.',
      'Frozen enemies take double damage.',
    ],
    base: { dmg: 16, cd: 4.0, radius: 3.2, freeze: 1.5 },
  },

  hound: {
    continuous: true,
    name: 'Spirit Hound',
    icon: '🐺',
    color: '#8affd8',
    maxLevel: 20,
    desc: 'A spectral wolf hunts alongside you and tears into whatever is closest.',
    levels: [
      'Summon 1 hound.',
      'Hound bites harder (+40%).',
      'Summon a 2nd hound.',
      'Hounds move much faster.',
      'Summon a 3rd hound, +50% damage.',
    ],
    base: { dmg: 18, cd: 0.7, speed: 9, range: 13 },
  },
};

export const PASSIVES = {
  might: { name: 'Hunter\'s Might', icon: '💪', color: '#ff8a6a', maxLevel: 20, desc: 'Increases all damage dealt.', step: '+7% damage' },
  alacrity: { name: 'Alacrity', icon: '⏱️', color: '#9fd0ff', maxLevel: 20, desc: 'All weapons come off cooldown faster.', step: '-3.5% cooldown' },
  swift: { name: 'Swiftshod', icon: '👢', color: '#a8ffb0', maxLevel: 20, desc: 'You move faster.', step: '+3.5% move speed' },
  ironhide: { name: 'Ironhide', icon: '🛡️', color: '#c8c8d0', maxLevel: 20, desc: 'Reduces every hit you take.', step: '+1.5 armor' },
  vigor: { name: 'Vigor', icon: '❤️', color: '#ff6a8a', maxLevel: 20, desc: 'Raises maximum health and restores you to full.', step: '+16 max HP, heals to full' },
  lodestone: { name: 'Lodestone', icon: '🧲', color: '#ffd23c', maxLevel: 20, desc: 'Draws monster parts in from further away.', step: '+12% pickup range' },
  sweep: { name: 'Wide Sweep', icon: '🌐', color: '#c8b0ff', maxLevel: 20, desc: 'Enlarges every area of effect.', step: '+5% area' },
  keen: { name: 'Keen Edge', icon: '🎯', color: '#ffb03c', maxLevel: 20, desc: 'Chance to land devastating critical strikes.', step: '+2.5% crit' },
  bloodhound: { name: 'Bloodhound', icon: '🩸', color: '#ff4a6a', maxLevel: 20, desc: 'Monster parts are worth more.', step: '+7% monster parts' },
  mending: { name: 'Slow Mending', icon: '✚', color: '#8affb0', maxLevel: 20, desc: 'Regenerate health over time.', step: '+0.35 HP/sec' },
  secondwind: { name: 'Second Wind', icon: '🕯️', color: '#ffe9a8', maxLevel: 20, desc: 'Survive a fatal blow, restoring half your health.', step: '+1 revive every 4 ranks' },
  // The odd one out: five ranks instead of twenty, and `rare` makes the card
  // pool cull it most of the time. Each rank is worth roughly a whole extra
  // dodge, so it would dominate every screen it appeared on.
  stamina: {
    name: 'Sure-Footed', icon: '🌀', color: '#7fe8ff',
    maxLevel: CFG.STAMINA.maxRank, rare: true,
    desc: 'Deepens your wind, so you can roll more often before running dry.',
    step: `+${CFG.STAMINA.perRank} stamina and faster recovery`,
  },
};

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export class WeaponSystem {
  constructor(scene, vfx, enemies, player, game) {
    this.scene = scene;
    this.vfx = vfx;
    this.enemies = enemies;
    this.player = player;
    this.game = game;

    this.owned = new Map();     // key -> { key, def, level, cd, state }
    this.passives = new Map();  // key -> level

    this._dummy = new THREE.Object3D();
    this._buildProjectiles();
    this._buildGroundEffects();
    this._buildSlashes();
    this._buildAuras();
    this._buildTraps();
    this._buildBolts();
    this._buildHounds();
  }

  // ---- pools -------------------------------------------------------------

  _buildProjectiles() {
    this.styles = projectileStyles();
    this.projMeshes = {};
    for (const [key, s] of Object.entries(this.styles)) {
      const m = new THREE.InstancedMesh(s.geo(), s.mat(), s.cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      m.castShadow = false;
      this.scene.add(m);
      this.projMeshes[key] = m;
    }
    this.projectiles = [];
    for (let i = 0; i < 220; i++) {
      this.projectiles.push({ alive: false, style: 'knife', hits: new Set() });
    }
  }

  _buildGroundEffects() {
    const MAX = 22;
    this.grounds = [];
    const geo = new THREE.CircleGeometry(1, 64);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < MAX; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x8fd8ff, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 4;
      m.position.y = 0.08;
      this.scene.add(m);
      this.grounds.push({ mesh: m, alive: false });
    }
  }

  _buildSlashes() {
    const MAX = 18;
    this.slashes = [];
    for (let i = 0; i < MAX; i++) {
      // A narrow band, not a filled wedge — at peak opacity the old 0.55..1.0
      // ring covered a big slab of screen and read as a white blob rather than
      // a strike.
      const geo = new THREE.RingGeometry(0.76, 1.0, 56, 2, 0, 2.0);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xe8eef7, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 6;
      this.scene.add(m);
      this.slashes.push({ mesh: m, life: 0, maxLife: 0.3 });
    }
  }

  _buildAuras() {
    // Pyre ring.
    const pyreGeo = new THREE.RingGeometry(0.55, 1.0, 96);
    pyreGeo.rotateX(-Math.PI / 2);
    this.pyreMesh = new THREE.Mesh(pyreGeo, new THREE.MeshBasicMaterial({
      color: 0xff7b2a, transparent: true, opacity: 0.34, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.pyreMesh.visible = false;
    this.pyreMesh.renderOrder = 4;
    this.pyreMesh.position.y = 0.1;
    this.scene.add(this.pyreMesh);

    // Censer smoke sphere.
    this.censerMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 24),
      new THREE.MeshBasicMaterial({
        color: 0xc8b0ff, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.censerMesh.visible = false;
    this.censerMesh.renderOrder = 4;
    this.scene.add(this.censerMesh);
    this._censerPulse = 0;
  }

  _buildTraps() {
    const MAX = 8;
    this.traps = [];
    const jawGeo = new THREE.TorusGeometry(0.4, 0.07, 10, 26, Math.PI);
    const plateGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 24);
    for (let i = 0; i < MAX; i++) {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0x8a8a94, metalness: 0.8, roughness: 0.35, flatShading: false });
      const plate = new THREE.Mesh(plateGeo, mat);
      plate.position.y = 0.03;
      g.add(plate);
      const j1 = new THREE.Mesh(jawGeo, mat);
      const j2 = new THREE.Mesh(jawGeo, mat);
      j1.position.y = 0.06; j2.position.y = 0.06;
      j2.rotation.y = Math.PI;
      g.add(j1, j2);
      g.visible = false;
      this.scene.add(g);
      this.traps.push({ group: g, jaws: [j1, j2], alive: false, x: 0, z: 0, armed: true, life: 0 });
    }
  }

  _buildBolts() {
    const MAX = 10;
    this.bolts = [];
    const geo = new THREE.CylinderGeometry(0.08, 0.22, 14, 12, 1, true);
    geo.translate(0, 7, 0);
    for (let i = 0; i < MAX; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xdff0ff, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 7;
      this.scene.add(m);
      this.bolts.push({ mesh: m, life: 0 });
    }
  }

  _buildHounds() {
    this.hounds = [];
    const MAX = 3;
    for (let i = 0; i < MAX; i++) {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0x8affd8, transparent: true, opacity: 0.55 });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.5, 8, 18), mat);
      body.rotation.x = Math.PI / 2;
      body.position.y = 0.55;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.42, 16), mat);
      head.rotation.x = Math.PI / 2;
      head.position.set(0, 0.62, 0.48);
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.4, 12), mat);
      tail.rotation.x = -Math.PI / 2.5;
      tail.position.set(0, 0.66, -0.5);
      g.add(body, head, tail);
      g.scale.setScalar(CFG.SCALE.hound);
      g.visible = false;
      this.scene.add(g);
      this.hounds.push({ group: g, x: 0, z: 0, yaw: 0, cd: 0, active: false, target: null });
    }
  }

  // ---- ownership ---------------------------------------------------------

  has(key) {
    return this.owned.has(key) || this.passives.has(key);
  }

  levelOf(key) {
    if (this.owned.has(key)) return this.owned.get(key).level;
    if (this.passives.has(key)) return this.passives.get(key);
    return 0;
  }

  addOrLevel(key) {
    if (WEAPONS[key]) {
      const existing = this.owned.get(key);
      if (existing) {
        existing.level = Math.min(WEAPONS[key].maxLevel, existing.level + 1);
      } else {
        this.owned.set(key, { key, def: WEAPONS[key], level: 1, cd: 0.25, state: {} });
      }
      return;
    }
    if (PASSIVES[key]) {
      const lvl = Math.min(PASSIVES[key].maxLevel, (this.passives.get(key) || 0) + 1);
      this.passives.set(key, lvl);
      this._applyPassives();
      // Vigor's card promises a heal. _applyPassives only tops you up by the
      // maximum it just added — +16 HP on a 200 HP bar reads as nothing
      // happening at all. Taking a rank of Vigor puts you back to full.
      if (key === 'vigor') this.player.heal(this.player.stats.maxHp);
    }
  }

  /** Recomputes derived player stats from scratch so levels never double-apply. */
  _applyPassives() {
    const s = this.player.stats;
    const L = (k) => this.passives.get(k) || 0;

    const prevMax = s.maxHp;
    s.might = 1 + L('might') * 0.07;
    s.haste = Math.max(0.35, 1 - L('alacrity') * 0.035);
    s.speed = CFG.PLAYER.speed * (1 + L('swift') * 0.035);
    s.armor = L('ironhide') * 1.5;
    s.maxHp = CFG.PLAYER.maxHp + L('vigor') * 16;
    s.magnet = CFG.PLAYER.pickupRadius * (1 + L('lodestone') * 0.12);
    s.area = 1 + L('sweep') * 0.05;
    s.crit = 0.03 + L('keen') * 0.025;
    s.greed = 1 + L('bloodhound') * 0.07;
    s.regen = L('mending') * 0.35;
    s.revives = Math.floor(L('secondwind') / 4);

    // Stamina. Taking a rank hands you the new capacity immediately, the same
    // way Vigor heals you for the health it just granted.
    const prevStam = s.staminaMax;
    s.staminaMax = CFG.STAMINA.base + L('stamina') * CFG.STAMINA.perRank;
    s.staminaRegen = CFG.STAMINA.regen * (1 + L('stamina') * CFG.STAMINA.regenPerRank);
    if (s.staminaMax > prevStam) s.stamina += s.staminaMax - prevStam;
    s.stamina = Math.max(0, Math.min(s.staminaMax, s.stamina));

    if (s.maxHp > prevMax) this.player.heal(s.maxHp - prevMax);
  }

  // ---- damage helpers ----------------------------------------------------

  /**
   * Ranks 1-5 are hand-authored milestones (extra projectiles, new behaviours).
   * Ranks 6-20 are numeric: steady damage and recovery gains, so investing
   * further in a weapon you like stays worthwhile without inventing fifteen
   * more mechanics per weapon.
   */
  static rankDamage(level) { return 1 + Math.max(0, level - 5) * 0.11; }
  static rankCooldown(level) { return Math.max(0.55, 1 - Math.max(0, level - 5) * 0.028); }

  /**
   * Reads a per-rank milestone table safely.
   *
   * Every one of these tables is five entries long because ranks 1-5 are the
   * hand-authored ones — but maxLevel is 20. Indexing raw returned `undefined`
   * past rank 5, and `for (let i = 0; i < undefined; i++)` never runs even
   * once: the Storm Sigil, Throwing Knives, Silver Cross, Holy Water and
   * Whetstone Fangs all went completely silent the moment you ranked them to 6,
   * while still burning their cooldown. Bear Traps failed the opposite way —
   * `live >= undefined` is false, so the cap came off and they spawned to the
   * pool limit.
   *
   * Clamping holds the rank-5 shape from there on, which is the intent: past 5
   * a weapon grows through rankDamage and rankCooldown, not by sprouting more
   * projectiles forever.
   */
  static rankPick(table, level) {
    return table[Math.min(Math.max(1, level | 0), table.length) - 1];
  }

  _roll(base) {
    const s = this.player.stats;
    let dmg = base * s.might * (this._rankMul || 1);
    const crit = chance(s.crit);
    if (crit) dmg *= s.critMul;
    return { dmg: Math.max(1, Math.round(dmg)), crit };
  }

  hitEnemy(e, base, opts = {}) {
    if (!e || !e.alive) return;
    const { dmg, crit } = this._roll(base);
    // Frost Vial rank 5: frozen targets take double damage.
    const mult = e.frozen > 0 && this.levelOf('frost') >= 5 ? 2 : 1;

    // `knock` reaches this method as either a {x,z} impulse (area/projectile
    // hits, which know their own origin) or a bare magnitude (orbitals, summon
    // bites). Normalise to a vector here — passing a number straight through
    // makes hurt() read knock.x as undefined and NaN out the enemy's velocity.
    let knock = opts.knock;
    if (typeof knock === 'number') {
      const dx = e.x - this.player.pos.x;
      const dz = e.z - this.player.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      knock = { x: (dx / d) * knock, z: (dz / d) * knock };
    }
    const total = Math.round(dmg * mult);
    this.enemies.hurt(e, total, { ...opts, knock, crit });

    // Impact dressing. Crits get a much louder read so they stand out in a
    // screen full of chip damage.
    //
    // `silent` marks aura and ground-effect ticks, which land on dozens of
    // enemies at once — giving those the full treatment would drain the
    // particle pool every frame and wash the screen out. They keep the crit
    // pop, at reduced volume, and nothing else.
    const hy = (e.isBoss ? 2.2 : 0.8 * (e.scale || 1)) + (e.y || 0);
    if (crit) {
      this.vfx.impact(e.x, hy, e.z, opts.silent
        ? { color: 0xff7a4a, n: 6, speed: 9, power: 1.1, size: 0.9 }
        : { color: 0xff7a4a, n: 16, speed: 12, ring: 2.6, power: 2.2, size: 1.1 });
      if (!opts.silent) { this.game.shake(0.22); this.game.hitstop(0.06); }
    } else if (!opts.silent) {
      this.vfx.impact(e.x, hy, e.z, {
        color: opts.hitColor || 0xffe9b0, n: 4, speed: 7, power: 0.55, size: 0.65,
      });
    }
  }

  areaHit(x, z, radius, base, opts = {}) {
    const near = this.enemies.queryNear(x, z, radius, scratch);
    const r2 = radius * radius;
    let count = 0;
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      if (!e.alive) continue;
      const dx = e.x - x, dz = e.z - z;
      if (dx * dx + dz * dz > r2) continue;
      const knock = opts.knock
        ? { x: (dx / (Math.hypot(dx, dz) || 1)) * opts.knock, z: (dz / (Math.hypot(dx, dz) || 1)) * opts.knock }
        : undefined;
      this.hitEnemy(e, base, { ...opts, knock });
      count++;
    }
    return count;
  }

  /**
   * Direction a melee swing should point.
   *
   * Aiming at the movement heading is wrong for an auto-battler: the horde
   * chases from behind, so a player who keeps running never lands a hit. Swings
   * lock onto the nearest monster and only fall back to the heading when the
   * screen is empty.
   */
  aimAngle(range) {
    const p = this.player;
    const t = this.enemies.nearest(p.pos.x, p.pos.z, range + 3);
    if (!t) return p.facing;
    return Math.atan2(t.x - p.pos.x, t.z - p.pos.z);
  }

  /** Cone/arc hit centred on the player, used by fists and the sword. */
  arcHit(range, arc, base, opts = {}) {
    const p = this.player;
    const aim = opts.aim ?? p.facing;
    const near = this.enemies.queryNear(p.pos.x, p.pos.z, range, scratch);
    const fx = Math.sin(aim), fz = Math.cos(aim);
    let count = 0;
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      if (!e.alive) continue;
      const dx = e.x - p.pos.x, dz = e.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > range + e.radius) continue;
      if (arc < Math.PI * 1.99) {
        const dot = (dx / (d || 1)) * fx + (dz / (d || 1)) * fz;
        if (dot < Math.cos(arc / 2)) continue;
      }
      const knock = opts.knock ? { x: (dx / (d || 1)) * opts.knock, z: (dz / (d || 1)) * opts.knock } : undefined;
      this.hitEnemy(e, base, { ...opts, knock });
      count++;
    }
    return count;
  }

  // ---- spawn helpers -----------------------------------------------------

  spawnProjectile(cfg) {
    for (const p of this.projectiles) {
      if (p.alive) continue;
      p.alive = true;
      p.style = cfg.style || 'knife';
      p.x = cfg.x; p.y = cfg.y ?? 1.0; p.z = cfg.z;
      p.vx = cfg.vx; p.vz = cfg.vz;
      p.life = cfg.life ?? 2.2;
      p.dmg = cfg.dmg;
      p.radius = cfg.radius ?? 0.55;
      p.pierce = cfg.pierce ?? 1;
      p.spin = cfg.spin ?? 0;
      p.rot = 0;
      p.mode = cfg.mode || 'straight';  // straight | boomerang | seek
      p.range = cfg.range ?? 9;
      p.origin = { x: cfg.x, z: cfg.z };
      p.returning = false;
      p.homing = cfg.homing || 0;
      p.burn = cfg.burn || null;
      p.slow = cfg.slow || 0;
      p.freeze = cfg.freeze || 0;
      p.onExpire = cfg.onExpire || null;
      p.knock = cfg.knock || 0;
      p.scale = cfg.scale ?? 1;
      p.trailColor = cfg.trailColor || 0xffe9b0;
      // Reset transient flags here rather than on death: a boomerang that
      // despawns by reaching the player short-circuits the death cleanup path.
      p.lob = null;
      p._clearedOnReturn = false;
      p.hits.clear();
      return p;
    }
    return null;
  }

  spawnGround(x, z, radius, duration, dmg, tick, color, opts = {}) {
    for (const g of this.grounds) {
      if (g.alive) continue;
      g.alive = true;
      g.x = x; g.z = z;
      g.radius = radius;
      g.life = duration;
      g.maxLife = duration;
      g.dmg = dmg;
      g.tick = tick;
      g.t = 0;
      g.slow = opts.slow || 0;
      g.burn = opts.burn || null;
      g.freeze = opts.freeze || 0;
      g.mesh.visible = true;
      g.mesh.position.set(x, 0.08, z);
      g.mesh.scale.setScalar(radius);
      g.mesh.material.color.set(color);
      return g;
    }
    return null;
  }

  /**
   * `sweep` rotates the wedge through the swing over its lifetime, so the arc
   * reads as a blade travelling rather than a shape popping into existence.
   * Purely visual — the damage arc is resolved separately and instantly.
   */
  spawnSlash(x, z, angle, radius, arc, color, sweep = 0) {
    for (const s of this.slashes) {
      if (s.life > 0) continue;
      s.life = s.maxLife;
      s.sweep = sweep;
      s.baseYaw = angle - Math.PI / 2 - 1.0 - sweep * 0.5;
      s.mesh.visible = true;
      s.mesh.position.set(x, 0.55, z);
      s.mesh.scale.setScalar(radius);
      // The ring geometry spans 2.0 rad starting at theta 0; a mesh yaw of `r`
      // shifts effective theta by +r, so centre the wedge on `angle`.
      s.mesh.rotation.y = s.baseYaw;
      s.mesh.material.color.set(color);
      return s;
    }
    return null;
  }

  spawnBolt(x, z) {
    for (const b of this.bolts) {
      if (b.life > 0) continue;
      b.life = 0.22;
      b.mesh.visible = true;
      b.mesh.position.set(x, 0, z);
      b.mesh.rotation.y = Math.random() * TAU;
      b.mesh.scale.set(1, 1, 1);
      return b;
    }
    return null;
  }

  // ---- main update -------------------------------------------------------

  update(dt, elapsed) {
    const p = this.player;
    for (const w of this.owned.values()) {
      // Continuous weapons (auras, orbitals, summons) run their own timers in
      // the dedicated updaters below and must not go through the fire gate.
      if (w.def.continuous) continue;
      w.cd -= dt;
      if (w.cd <= 0) {
        const base = w.def.base;
        this._rankMul = WeaponSystem.rankDamage(w.level);
        const cd = this._fire(w, dt, elapsed);
        this._rankMul = 1;
        w.cd = (cd ?? base.cd) * p.stats.haste * WeaponSystem.rankCooldown(w.level);
      }
    }
    // Continuous weapons that do not use the cooldown gate.
    if (this.owned.has('fangs')) this._updateFangs(dt, elapsed);
    if (this.owned.has('pyre')) this._updatePyre(dt, elapsed);
    if (this.owned.has('censer')) this._updateCenser(dt, elapsed);
    if (this.owned.has('hound')) this._updateHounds(dt, elapsed);
    else this.hounds.forEach((h) => { h.group.visible = false; h.active = false; });

    this._updateProjectiles(dt);
    this._updateGrounds(dt);
    this._updateSlashes(dt);
    this._updateTraps(dt);
    this._updateBolts(dt);
  }

  _fire(w, dt, elapsed) {
    const lvl = w.level;
    const b = w.def.base;
    const p = this.player;
    const s = p.stats;

    switch (w.key) {
      // ---------------------------------------------------------------- fists
      case 'fists': {
        const dmg = b.dmg * (1 + (lvl >= 2 ? 0.45 : 0) + (lvl >= 4 ? 0.6 : 0));
        const arc = b.arc * (lvl >= 3 ? 1.4 : 1);
        const range = b.range * s.area;
        const aim = this.aimAngle(range);
        p.faceAttack(aim);
        p.attack('punch');
        SFX.punch();
        const fx = Math.sin(aim), fz = Math.cos(aim);
        this.spawnSlash(p.pos.x + fx * 0.5, p.pos.z + fz * 0.5, aim, range * 0.95, arc, 0xffd9a0, arc * 0.8);
        this.spawnSlash(p.pos.x + fx * 0.5, p.pos.z + fz * 0.5, aim, range * 0.62, arc, 0xfff4dc, arc * 0.8);
        // Speed lines streaking along the arc.
        for (let i = 0; i < 5; i++) {
          const sa = aim + (i / 4 - 0.5) * arc;
          this.vfx.spawnParticles(
            p.pos.x + Math.sin(sa) * range * 0.75, 1.0, p.pos.z + Math.cos(sa) * range * 0.75,
            1, { color: 0xfff0cf, speed: 2, life: 0.16, size: 0.6, up: 0.4, grav: -2 });
        }
        this.vfx.flash(p.pos.x + fx * range * 0.6, 1.2, p.pos.z + fz * range * 0.6, 0xffc879, 0.7);
        const hits = this.arcHit(range, arc, dmg, { aim, knock: lvl >= 4 ? 5 : 1.5 });
        if (hits > 0) {
          this.game.shake(0.06 + Math.min(0.12, hits * 0.02));
          this.game.hitstop(0.028);
        }

        w.state.combo = (w.state.combo || 0) + 1;
        if (lvl >= 5 && w.state.combo % 4 === 0) {
          // Shockwave finisher.
          this.vfx.ring(p.pos.x, p.pos.z, 0.5, 5.5 * s.area, 0xffd27f, 0.4);
          this.areaHit(p.pos.x, p.pos.z, 4.4 * s.area, dmg * 1.6, { knock: 11 });
          SFX.explode();
        }
        if (lvl >= 3) {
          // Rapid follow-up jab shortly after.
          setTimeout(() => {
            if (!p.alive || this.game.state !== 'playing') return;
            const aim2 = this.aimAngle(range);
            p.faceAttack(aim2);
            p.attack('punch');
            this.arcHit(range, arc, dmg * 0.7, { aim: aim2, knock: 1 });
          }, 140);
        }
        return b.cd;
      }

      // --------------------------------------------------------------- knives
      case 'knives': {
        const count = WeaponSystem.rankPick([1, 2, 2, 3, 5], lvl) + s.projectiles;
        const pierce = b.pierce + (lvl >= 3 ? 1 : 0) + (lvl >= 5 ? 2 : 0);
        const dmg = b.dmg * (lvl >= 3 ? 1.25 : 1);
        const spread = count > 1 ? 0.34 : 0;
        const aim = this.aimAngle(14);
        SFX.throwKnife();
        for (let i = 0; i < count; i++) {
          const off = count === 1 ? 0 : (i - (count - 1) / 2) * spread;
          const a = aim + off;
          this.spawnProjectile({
            style: 'knife', x: p.pos.x, z: p.pos.z, y: 1.0,
            vx: Math.sin(a) * b.speed * s.speedProj,
            vz: Math.cos(a) * b.speed * s.speedProj,
            dmg, pierce, life: 1.6, spin: 0, radius: 0.5,
          });
        }
        return b.cd;
      }

      // ---------------------------------------------------------------- sword
      case 'sword': {
        const dmg = b.dmg * (1 + (lvl >= 2 ? 0.35 : 0) + (lvl >= 4 ? 0.5 : 0));
        const range = b.range * s.area * (lvl >= 4 ? 1.2 : 1);
        const arc = lvl >= 5 ? Math.PI * 2 : b.arc * (lvl >= 2 ? 1.25 : 1);
        const swing = (side) => {
          if (!p.alive) return;
          SFX.slash();
          const aim = this.aimAngle(range);
          const a = aim + (arc >= Math.PI * 2 ? 0 : side * 0.35);
          if (arc < Math.PI * 2) p.faceAttack(a);
          p.attack('slash');
          this.spawnSlash(p.pos.x, p.pos.z, a, range * 1.05, arc, 0xbcd4ff, arc * 0.85);
          this.spawnSlash(p.pos.x, p.pos.z, a, range * 0.7, arc, 0xffffff, arc * 0.85);
          for (let i = 0; i < 8; i++) {
            const sa = a + (i / 7 - 0.5) * arc;
            this.vfx.spawnParticles(
              p.pos.x + Math.sin(sa) * range * 0.8, 1.05, p.pos.z + Math.cos(sa) * range * 0.8,
              1, { color: 0xdfe8ff, speed: 2.5, life: 0.2, size: 0.75, up: 0.5, grav: -2 });
          }
          this.vfx.ring(p.pos.x, p.pos.z, range * 0.5, range * 1.25, 0xdfe8ff, 0.3, 0.3);
          const hits = this.arcHit(range, arc, dmg, { aim: a, knock: 3, hitColor: 0xdfe8ff });
          this.vfx.spawnParticles(p.pos.x + Math.sin(a) * range * 0.6, 1.0, p.pos.z + Math.cos(a) * range * 0.6, 12,
            { color: 0xdfe8ff, speed: 11, life: 0.35, size: 0.8, up: 2.4, grav: -14 });
          this.vfx.flash(p.pos.x + Math.sin(a) * range * 0.5, 1.2, p.pos.z + Math.cos(a) * range * 0.5, 0xbcd4ff, 1.1);
          this.game.shake(0.1 + Math.min(0.2, hits * 0.03));
          if (hits > 0) this.game.hitstop(0.045);
        };
        swing(1);
        if (lvl >= 3) setTimeout(() => this.game.state === 'playing' && swing(-1), 190);
        return b.cd;
      }

      // ---------------------------------------------------------------- cross
      case 'cross': {
        const count = WeaponSystem.rankPick([1, 2, 2, 3, 3], lvl) + s.projectiles;
        const dmg = b.dmg * (lvl >= 3 ? 1.3 : 1);
        const range = b.range * (lvl >= 3 ? 1.3 : 1) * s.area;
        SFX.holy();
        const aimC = this.aimAngle(range);
        for (let i = 0; i < count; i++) {
          const a = aimC + (i - (count - 1) / 2) * 0.55;
          this.spawnProjectile({
            style: 'cross', mode: 'boomerang', x: p.pos.x, z: p.pos.z, y: 1.1,
            vx: Math.sin(a) * b.speed, vz: Math.cos(a) * b.speed,
            dmg, pierce: 999, life: 5, spin: 12, radius: 0.75, range,
            burn: lvl >= 5 ? { time: 2.5, dps: dmg * 0.28 } : null,
          });
        }
        return b.cd;
      }

      // ----------------------------------------------------------- holy water
      case 'holywater': {
        const count = WeaponSystem.rankPick([1, 2, 2, 3, 3], lvl) + s.projectiles;
        const dmg = b.dmg * (lvl >= 4 ? 1.35 : 1);
        const radius = b.radius * s.area * (lvl >= 5 ? 1.7 : 1);
        const dur = b.duration * s.duration * (lvl >= 3 ? 1.5 : 1);
        for (let i = 0; i < count; i++) {
          const a = Math.random() * TAU;
          const d = rand(2.5, 6.5);
          const tx = p.pos.x + Math.cos(a) * d;
          const tz = p.pos.z + Math.sin(a) * d;
          const target = this.enemies.nearest(p.pos.x, p.pos.z, 9);
          const gx = target ? target.x + rand(-1.5, 1.5) : tx;
          const gz = target ? target.z + rand(-1.5, 1.5) : tz;
          this._lob(p.pos.x, p.pos.z, gx, gz, 'flask', () => {
            SFX.holy();
            this.vfx.ring(gx, gz, 0.4, radius * 1.2, 0x8fd8ff, 0.4);
            this.spawnGround(gx, gz, radius, dur, dmg, b.tick, 0x6ac8ff, {
              slow: lvl >= 5 ? 1.2 : 0,
            });
          });
        }
        return b.cd;
      }

      // ---------------------------------------------------------------- frost
      case 'frost': {
        const count = lvl >= 4 ? 2 : 1;
        const radius = b.radius * s.area * (lvl >= 2 ? 1.4 : 1);
        const freeze = b.freeze * (lvl >= 3 ? 1.8 : 1) * s.duration;
        for (let i = 0; i < count; i++) {
          const target = this.enemies.nearest(p.pos.x, p.pos.z, 12);
          const a = Math.random() * TAU;
          const gx = target ? target.x : p.pos.x + Math.cos(a) * 5;
          const gz = target ? target.z : p.pos.z + Math.sin(a) * 5;
          this._lob(p.pos.x, p.pos.z, gx, gz, 'frost', () => {
            this.vfx.ring(gx, gz, 0.4, radius * 1.3, 0xa8e8ff, 0.5);
            this.vfx.spawnParticles(gx, 0.5, gz, 18, { color: 0xa8e8ff, speed: 6, life: 0.8, size: 0.9, up: 2.5 });
            this.areaHit(gx, gz, radius, b.dmg, { freeze, slow: freeze });
            this.spawnGround(gx, gz, radius, 1.6 * s.duration, b.dmg * 0.2, 0.4, 0xa8e8ff, { slow: 1.0 });
          });
        }
        return b.cd;
      }

      // --------------------------------------------------------------- glaive
      case 'glaive': {
        const count = lvl >= 5 ? 3 : lvl >= 3 ? 2 : 1;
        const dmg = b.dmg * (lvl >= 2 ? 1.35 : 1) * (lvl >= 5 ? 1.4 : 1);
        const aimG = this.aimAngle(b.range);
        for (let i = 0; i < count; i++) {
          const a = aimG + (i - (count - 1) / 2) * 0.75;
          this.spawnProjectile({
            style: 'glaive', mode: 'boomerang', x: p.pos.x, z: p.pos.z, y: 0.9,
            vx: Math.sin(a) * b.speed, vz: Math.cos(a) * b.speed,
            dmg, pierce: 999, life: 6, spin: 18, radius: 1.0,
            range: b.range * s.area, homing: lvl >= 4 ? 3.2 : 0, scale: 1.3,
          });
        }
        SFX.slash();
        return b.cd;
      }

      // ---------------------------------------------------------------- sigil
      case 'sigil': {
        const count = WeaponSystem.rankPick([1, 2, 2, 3, 5], lvl);
        const dmg = b.dmg * (lvl >= 3 ? 1.4 : 1);
        const near = this.enemies.queryNear(p.pos.x, p.pos.z, b.range * s.area, scratch).filter((e) => e.alive);
        if (!near.length) return 0.4;
        for (let i = 0; i < count; i++) {
          const e = near[Math.floor(Math.random() * near.length)];
          if (!e || !e.alive) continue;
          this._strike(e, dmg, lvl);
          if (lvl >= 4) {
            const chain = this.enemies.nearest(e.x, e.z, 5);
            if (chain && chain !== e) setTimeout(() => chain.alive && this._strike(chain, dmg * 0.6, lvl), 90);
          }
        }
        return b.cd;
      }

      // ---------------------------------------------------------------- traps
      case 'traps': {
        const maxTraps = WeaponSystem.rankPick([1, 2, 2, 3, 3], lvl);
        const live = this.traps.filter((t) => t.alive).length;
        if (live >= maxTraps) return 0.5;
        const slot = this.traps.find((t) => !t.alive);
        if (!slot) return 0.5;
        const a = p.facing + Math.PI + rand(-0.6, 0.6);
        slot.alive = true;
        slot.armed = true;
        slot.life = 22;
        slot.x = p.pos.x + Math.sin(a) * rand(1.5, 3.2);
        slot.z = p.pos.z + Math.cos(a) * rand(1.5, 3.2);
        slot.dmg = b.dmg * (lvl >= 3 ? 1.4 : 1);
        slot.root = b.root * (lvl >= 3 ? 1.6 : 1) * s.duration;
        slot.radius = b.radius * s.area;
        slot.explodes = lvl >= 5;
        slot.group.visible = true;
        slot.group.position.set(slot.x, 0, slot.z);
        slot.group.rotation.y = Math.random() * TAU;
        slot.jaws[0].rotation.z = 0;
        slot.jaws[1].rotation.z = 0;
        return b.cd;
      }

      default:
        return 1;
    }
  }

  _strike(e, dmg, lvl) {
    this.spawnBolt(e.x, e.z);
    this.vfx.ring(e.x, e.z, 0.3, 3.4, 0x9fd0ff, 0.34);
    this.vfx.ring(e.x, e.z, 0.2, 1.8, 0xffffff, 0.22);
    this.vfx.spawnParticles(e.x, 0.9, e.z, 16, { color: 0xcfe8ff, speed: 13, life: 0.4, size: 0.8, up: 4, grav: -18 });
    this.vfx.flash(e.x, 1.4, e.z, 0x9fd0ff, 1.6);
    this.game.shake(0.12);
    this.game.hitstop(0.035);
    this.hitEnemy(e, dmg, { freeze: lvl >= 5 ? 0.5 : 0, hitColor: 0x9fd0ff });
    SFX.throwKnife();
  }

  /** Lobbed flask: a projectile with an arcing Y that fires a callback on land. */
  _lob(x, z, tx, tz, style, onLand) {
    const dx = tx - x, dz = tz - z;
    const dist = Math.hypot(dx, dz) || 0.001;
    const flight = clamp(dist / 11, 0.3, 1.1);
    const pr = this.spawnProjectile({
      style, x, z, y: 1.2,
      vx: dx / flight, vz: dz / flight,
      dmg: 0, pierce: 0, life: flight, radius: 0,
      spin: 6, onExpire: onLand,
    });
    if (pr) {
      pr.lob = { t: 0, total: flight, h: 2.6 + dist * 0.12 };
    } else if (onLand) {
      // Pool exhausted — still apply the effect so damage never silently drops.
      onLand();
    }
  }

  // ---- continuous weapons ------------------------------------------------

  _updateFangs(dt, elapsed) {
    const w = this.owned.get('fangs');
    this._rankMul = WeaponSystem.rankDamage(w.level);
    const b = w.def.base;
    const lvl = w.level;
    const s = this.player.stats;
    const count = WeaponSystem.rankPick([2, 3, 4, 5, 7], lvl) + s.projectiles;
    const radius = b.radius * s.area * (lvl >= 4 ? 1.25 : 1);
    const spin = b.speed * (lvl >= 5 ? 2.0 : 1);
    const dmg = b.dmg * (lvl >= 3 ? 1.25 : 1);

    w.state.hitCd = w.state.hitCd || new Map();
    const angleBase = elapsed * spin;

    // The fangs are drawn from the shared 'fang' instanced mesh directly rather
    // than through the projectile pool — they are permanent, not transient.
    const mesh = this.projMeshes.fang;
    const d = this._dummy;
    let n = 0;
    for (let i = 0; i < count && n < this.styles.fang.cap; i++) {
      const a = angleBase + (i / count) * TAU;
      const x = this.player.pos.x + Math.cos(a) * radius;
      const z = this.player.pos.z + Math.sin(a) * radius;
      d.position.set(x, 0.95, z);
      d.rotation.set(0, -a + Math.PI / 2, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      mesh.setMatrixAt(n++, d.matrix);

      const near = this.enemies.queryNear(x, z, 0.75, scratch);
      for (const e of near) {
        if (!e.alive) continue;
        const dx = e.x - x, dz = e.z - z;
        if (dx * dx + dz * dz > 0.75 * 0.75) continue;
        const last = w.state.hitCd.get(e) || 0;
        if (elapsed - last < 0.42) continue;
        w.state.hitCd.set(e, elapsed);
        this.hitEnemy(e, dmg, { knock: 2.5 });
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;

    // Prune the per-enemy cooldown map so it does not grow across a long run.
    if (w.state.hitCd.size > 400) {
      for (const [e, t] of w.state.hitCd) {
        if (!e.alive || elapsed - t > 2) w.state.hitCd.delete(e);
      }
    }
  }

  _updatePyre(dt, elapsed) {
    const w = this.owned.get('pyre');
    this._rankMul = WeaponSystem.rankDamage(w.level);
    const b = w.def.base;
    const lvl = w.level;
    const s = this.player.stats;
    const radius = b.radius * s.area * (1 + (lvl >= 2 ? 0.3 : 0) + (lvl >= 4 ? 0.35 : 0));
    const dmg = b.dmg * (lvl >= 3 ? 1.5 : 1);

    this.pyreMesh.visible = true;
    this.pyreMesh.position.set(this.player.pos.x, 0.1, this.player.pos.z);
    this.pyreMesh.scale.setScalar(radius * (1 + Math.sin(elapsed * 7) * 0.03));
    this.pyreMesh.material.opacity = 0.28 + Math.sin(elapsed * 9) * 0.07;
    this.pyreMesh.rotation.y = elapsed * 0.6;

    if (Math.random() < dt * 22) {
      const a = Math.random() * TAU;
      this.vfx.spawnParticles(
        this.player.pos.x + Math.cos(a) * radius, 0.2, this.player.pos.z + Math.sin(a) * radius,
        1, { color: 0xff8a3c, speed: 0.7, life: 0.6, size: 0.7, up: 2.2, grav: -0.9 }
      );
    }

    w.state.t = (w.state.t || 0) + dt;
    if (w.state.t >= b.cd * s.haste) {
      w.state.t = 0;
      SFX.fire();
      this.areaHit(this.player.pos.x, this.player.pos.z, radius, dmg, {
        burn: lvl >= 3 ? { time: 2.2, dps: dmg * (lvl >= 4 ? 0.5 : 0.3) } : null,
        silent: true,
      });
    }

    // Rank 5 nova.
    w.state.nova = (w.state.nova || 0) + dt;
    if (lvl >= 5 && w.state.nova >= 5) {
      w.state.nova = 0;
      SFX.explode();
      this.vfx.ring(this.player.pos.x, this.player.pos.z, 0.6, radius * 2.6, 0xff7b2a, 0.6);
      this.areaHit(this.player.pos.x, this.player.pos.z, radius * 2.2, dmg * 3.2, {
        knock: 8, burn: { time: 3, dps: dmg * 0.6 },
      });
    }
  }

  _updateCenser(dt, elapsed) {
    const w = this.owned.get('censer');
    this._rankMul = WeaponSystem.rankDamage(w.level);
    const b = w.def.base;
    const lvl = w.level;
    const s = this.player.stats;
    const radius = b.radius * s.area * (lvl >= 2 ? 1.3 : 1);
    const dmg = b.dmg * (lvl >= 3 ? 1.4 : 1);
    const cd = b.cd * (lvl >= 4 ? 0.5 : 1) * s.haste;

    w.state.t = (w.state.t || 0) + dt;
    if (w.state.t >= cd) {
      w.state.t = 0;
      this._censerPulse = 1;
      this.areaHit(this.player.pos.x, this.player.pos.z, radius, dmg, { knock: b.knock, silent: true });
      this.vfx.ring(this.player.pos.x, this.player.pos.z, 0.5, radius * 1.4, 0xc8b0ff, 0.4);
      if (lvl >= 5) {
        this.spawnGround(this.player.pos.x, this.player.pos.z, radius * 0.9, 2.4 * s.duration, dmg * 0.35, 0.4, 0xc8b0ff, { slow: 0.8 });
      }
    }

    if (this._censerPulse > 0) {
      this._censerPulse = Math.max(0, this._censerPulse - dt * 3.2);
      this.censerMesh.visible = true;
      const t = 1 - this._censerPulse;
      this.censerMesh.position.set(this.player.pos.x, 1.0, this.player.pos.z);
      this.censerMesh.scale.setScalar(radius * (0.3 + t * 1.0));
      this.censerMesh.material.opacity = 0.3 * this._censerPulse;
    } else {
      this.censerMesh.visible = false;
    }
  }

  _updateHounds(dt, elapsed) {
    const w = this.owned.get('hound');
    this._rankMul = WeaponSystem.rankDamage(w.level);
    const b = w.def.base;
    const lvl = w.level;
    const count = lvl >= 5 ? 3 : lvl >= 3 ? 2 : 1;
    const dmg = b.dmg * (lvl >= 2 ? 1.4 : 1) * (lvl >= 5 ? 1.5 : 1);
    const speed = b.speed * (lvl >= 4 ? 1.5 : 1);

    this.hounds.forEach((h, i) => {
      if (i >= count) { h.group.visible = false; h.active = false; return; }
      if (!h.active) {
        h.active = true;
        h.x = this.player.pos.x + rand(-2, 2);
        h.z = this.player.pos.z + rand(-2, 2);
      }
      h.group.visible = true;

      const px = this.player.pos.x, pz = this.player.pos.z;
      // A bigger hound has to bite from further out or its jaws close on air.
      const bite = 1.1 * CFG.SCALE.hound;

      // Reacquire from around the HUNTER, not from wherever the hound happens
      // to be standing. Searching from the hound's own position could lock it
      // onto something at the far edge of its own leash — which immediately
      // tripped the leash below, cleared the target, and sent it home, only to
      // reacquire the same monster next frame. That ping-pong on the boundary
      // is what read as the hound getting stuck.
      if (!h.target || !h.target.alive) {
        h.target = this.enemies.nearest(px, pz, b.range * 0.8);
      }

      let tx, tz;
      if (h.target && h.target.alive) {
        tx = h.target.x; tz = h.target.z;
      } else {
        // Heel: circle the player.
        const a = elapsed * 1.4 + (i / count) * TAU;
        tx = px + Math.cos(a) * 2.6;
        tz = pz + Math.sin(a) * 2.6;
      }

      // Hysteresis: the leash breaks wider than targets are acquired, so a
      // monster sitting exactly on the boundary cannot flip the state every
      // frame.
      const leash = Math.hypot(h.x - px, h.z - pz);
      if (leash > b.range * 1.15) { tx = px; tz = pz; h.target = null; }

      const dx = tx - h.x, dz = tz - h.z;
      const d = Math.hypot(dx, dz);

      // Step toward the target, never past it, and stop at biting distance
      // rather than burying itself in the monster. The old version moved a flat
      // speed*dt every frame regardless of how close it already was, so on
      // arrival it overshot, corrected, overshot again — a hound vibrating in
      // place, which is the other half of what looked like getting stuck.
      const standoff = h.target && h.target.alive ? bite * 0.6 : 0;
      const step = Math.min(speed * dt, Math.max(0, d - standoff));
      if (d > 1e-4 && step > 0) {
        h.x += (dx / d) * step;
        h.z += (dz / d) * step;
        h.yaw = Math.atan2(dx, dz);   // hold the last heading when standing still
      }

      h.group.position.set(h.x, Math.abs(Math.sin(elapsed * 12 + i)) * 0.09 * CFG.SCALE.hound, h.z);
      h.group.rotation.y = h.yaw;

      h.cd -= dt;
      if (h.target && h.target.alive && d < bite && h.cd <= 0) {
        h.cd = b.cd * this.player.stats.haste;
        this.hitEnemy(h.target, dmg, { knock: 3 });
        this.vfx.sparks(h.target.x, 0.8, h.target.z, 0x8affd8, 5);
      }
    });
  }

  // ---- pooled updates ----------------------------------------------------

  _updateProjectiles(dt) {
    const counts = {};
    for (const key of Object.keys(this.projMeshes)) counts[key] = 0;
    // Fangs draw into the same 'fang' mesh and already set their own count.
    if (this.owned.has('fangs')) counts.fang = this.projMeshes.fang.count;

    const d = this._dummy;

    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.life -= dt;

      if (p.lob) {
        // Arcing flask flight.
        p.lob.t += dt;
        const t = clamp(p.lob.t / p.lob.total, 0, 1);
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        p.y = 1.2 + Math.sin(t * Math.PI) * p.lob.h;
        p.rot += p.spin * dt;
      } else if (p.mode === 'boomerang') {
        if (!p.returning) {
          const dx = p.x - p.origin.x, dz = p.z - p.origin.z;
          if (Math.hypot(dx, dz) >= p.range) p.returning = true;
        }
        if (p.returning) {
          // Home back onto the (moving) player.
          const tx = this.player.pos.x, tz = this.player.pos.z;
          const dx = tx - p.x, dz = tz - p.z;
          const dd = Math.hypot(dx, dz) || 1;
          const sp = Math.hypot(p.vx, p.vz) || 8;
          p.vx = (dx / dd) * sp;
          p.vz = (dz / dd) * sp;
          if (dd < 0.9) { p.alive = false; continue; }
          // Returning crosses can hit the same enemy a second time.
          if (!p._clearedOnReturn) { p.hits.clear(); p._clearedOnReturn = true; }
        }
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        p.rot += p.spin * dt;
      } else {
        if (p.homing) {
          const t = this.enemies.nearest(p.x, p.z, 9);
          if (t) {
            const dx = t.x - p.x, dz = t.z - p.z;
            const dd = Math.hypot(dx, dz) || 1;
            const sp = Math.hypot(p.vx, p.vz) || 8;
            p.vx += (dx / dd) * p.homing * dt * sp * 0.25;
            p.vz += (dz / dd) * p.homing * dt * sp * 0.25;
            const cur = Math.hypot(p.vx, p.vz) || 1;
            p.vx = (p.vx / cur) * sp;
            p.vz = (p.vz / cur) * sp;
          }
        }
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        p.rot += p.spin * dt;
      }

      // Collision.
      if (p.radius > 0 && p.pierce > 0) {
        const near = this.enemies.queryNear(p.x, p.z, p.radius + 1, scratch);
        for (const e of near) {
          if (!e.alive || p.hits.has(e)) continue;
          const dx = e.x - p.x, dz = e.z - p.z;
          const rr = p.radius + e.radius;
          if (dx * dx + dz * dz > rr * rr) continue;
          p.hits.add(e);
          const dd = Math.hypot(dx, dz) || 1;
          this.hitEnemy(e, p.dmg, {
            knock: p.knock ? { x: (dx / dd) * p.knock, z: (dz / dd) * p.knock } : undefined,
            burn: p.burn, slow: p.slow, freeze: p.freeze,
          });
          this.vfx.sparks(p.x, p.y, p.z, 0xffe9b0, 4);
          p.pierce--;
          if (p.pierce <= 0) { p.alive = false; break; }
        }
      }

      if (p.life <= 0) {
        p.alive = false;
        if (p.onExpire) p.onExpire();
      }

      if (!p.alive) {
        p._clearedOnReturn = false;
        p.lob = null;
        continue;
      }

      // Trail. Cheap because it is rate-limited per projectile per frame.
      if (p.radius > 0 && Math.random() < dt * 34) {
        this.vfx.spawnParticles(p.x, p.y, p.z, 1, {
          color: p.trailColor || 0xffe9b0, speed: 0.5, life: 0.22, size: 0.42, up: 0.2, grav: -1.5,
        });
      }

      const mesh = this.projMeshes[p.style];
      if (!mesh) continue;
      const idx = counts[p.style];
      if (idx >= this.styles[p.style].cap) continue;
      const yaw = Math.atan2(p.vx, p.vz);
      d.position.set(p.x, p.y, p.z);
      if (p.style === 'cross' || p.style === 'glaive') d.rotation.set(0, p.rot, 0);
      else if (p.style === 'flask' || p.style === 'frost') d.rotation.set(p.rot, p.rot * 0.7, 0);
      else d.rotation.set(0, yaw, 0);
      d.scale.setScalar(p.scale ?? 1);
      d.updateMatrix();
      mesh.setMatrixAt(idx, d.matrix);
      counts[p.style] = idx + 1;
    }

    for (const [key, mesh] of Object.entries(this.projMeshes)) {
      mesh.count = counts[key];
      if (counts[key] > 0) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  _updateGrounds(dt) {
    for (const g of this.grounds) {
      if (!g.alive) continue;
      g.life -= dt;
      if (g.life <= 0) {
        g.alive = false;
        g.mesh.visible = false;
        continue;
      }
      g.t -= dt;
      if (g.t <= 0) {
        g.t = g.tick;
        this.areaHit(g.x, g.z, g.radius, g.dmg, {
          slow: g.slow, burn: g.burn, freeze: g.freeze, silent: true,
        });
      }
      const frac = g.life / g.maxLife;
      g.mesh.material.opacity = 0.16 + 0.24 * Math.min(1, frac * 2.2);
      g.mesh.scale.setScalar(g.radius * (0.92 + Math.sin(g.life * 6) * 0.03));
      if (Math.random() < dt * 10) {
        const a = Math.random() * TAU;
        const r = Math.random() * g.radius;
        this.vfx.spawnParticles(g.x + Math.cos(a) * r, 0.15, g.z + Math.sin(a) * r, 1,
          { color: g.mesh.material.color.getHex(), speed: 0.5, life: 0.5, size: 0.5, up: 1.4, grav: -1 });
      }
    }
  }

  _updateSlashes(dt) {
    for (const s of this.slashes) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.mesh.visible = false; continue; }
      const t = s.life / s.maxLife;
      // Snap out fast, then linger — reads as a strike rather than a fade.
      const prog = 1 - t;
      s.mesh.material.opacity = Math.min(1, t * 1.9) * 0.72;
      s.mesh.scale.multiplyScalar(1 + dt * 2.6);
      if (s.sweep) s.mesh.rotation.y = s.baseYaw + s.sweep * (1 - Math.pow(1 - prog, 2));
    }
  }

  _updateTraps(dt) {
    for (const t of this.traps) {
      if (!t.alive) continue;
      t.life -= dt;
      if (t.life <= 0) { t.alive = false; t.group.visible = false; continue; }

      if (t.armed) {
        const near = this.enemies.queryNear(t.x, t.z, t.radius, scratch);
        for (const e of near) {
          if (!e.alive) continue;
          const dx = e.x - t.x, dz = e.z - t.z;
          if (dx * dx + dz * dz > t.radius * t.radius) continue;
          t.armed = false;
          t.life = 0.6;
          SFX.chestBreak();
          this.hitEnemy(e, t.dmg, { freeze: t.root });
          this.vfx.sparks(t.x, 0.3, t.z, 0xc8c8d0, 8);
          if (t.explodes) {
            SFX.explode();
            this.vfx.ring(t.x, t.z, 0.4, 4.2, 0xffb03c, 0.45);
            this.areaHit(t.x, t.z, 3.0, t.dmg * 0.8, { knock: 7 });
          }
          break;
        }
      } else {
        // Snap animation.
        const c = clamp(1 - t.life / 0.6, 0, 1);
        t.jaws[0].rotation.z = -c * 1.5;
        t.jaws[1].rotation.z = c * 1.5;
      }
    }
  }

  _updateBolts(dt) {
    for (const b of this.bolts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) { b.mesh.visible = false; continue; }
      b.mesh.material.opacity = clamp(b.life / 0.22, 0, 1) * 0.9;
      b.mesh.scale.x = b.mesh.scale.z = 0.7 + Math.random() * 0.6;
    }
  }

  reset() {
    this.owned.clear();
    this.passives.clear();
    for (const p of this.projectiles) { p.alive = false; p.hits.clear(); p.lob = null; }
    for (const m of Object.values(this.projMeshes)) m.count = 0;
    for (const g of this.grounds) { g.alive = false; g.mesh.visible = false; }
    for (const s of this.slashes) { s.life = 0; s.mesh.visible = false; }
    for (const t of this.traps) { t.alive = false; t.group.visible = false; }
    for (const b of this.bolts) { b.life = 0; b.mesh.visible = false; }
    for (const h of this.hounds) { h.active = false; h.target = null; h.group.visible = false; }
    this.pyreMesh.visible = false;
    this.censerMesh.visible = false;
    this._censerPulse = 0;
  }
}
