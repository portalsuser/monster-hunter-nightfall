import * as THREE from 'three';
import { CFG } from './config.js';
import { clamp, damp, TAU } from './utils.js';

const PAL = {
  coat: 0x2a2118,
  coatDark: 0x17110b,
  leather: 0x4a3320,
  leatherDark: 0x30210f,
  metal: 0x8d949c,
  metalDark: 0x555c66,
  horn: 0xd8cbb0,
  skin: 0xb98963,
  wrap: 0xc9bda4,
  glow: 0xffa64d,
};

/**
 * Builds the hunter: hooded cloak, horned helm, pauldrons, bandaged fists,
 * a belt of vials and a hip lantern. All hand-built primitives, no assets.
 * Returns the root Group with animatable parts hung off `.parts`.
 */
function buildHunter() {
  const g = new THREE.Group();
  const parts = {};

  // Smooth shading throughout now that the meshes carry enough segments for it
  // — flat shading was hiding the low segment counts, not stylising them.
  const mat = (color, rough = 0.8, flat = false) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, flatShading: flat });
  const metalMat = (color) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.9, flatShading: false });

  const add = (parent, mesh, x = 0, y = 0, z = 0) => {
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // ---- torso -------------------------------------------------------------
  const body = new THREE.Group();
  g.add(body);
  parts.body = body;

  const chest = add(body, new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.42, 10, 24), mat(PAL.leather, 0.85)), 0, 1.18, 0);
  chest.scale.set(1.0, 1.0, 0.78);

  // Chest harness straps.
  const strapGeo = new THREE.BoxGeometry(0.12, 0.72, 0.06);
  const strapL = add(body, new THREE.Mesh(strapGeo, mat(PAL.leatherDark)), -0.11, 1.2, 0.29);
  strapL.rotation.z = 0.22;
  const strapR = add(body, new THREE.Mesh(strapGeo, mat(PAL.leatherDark)), 0.13, 1.2, 0.29);
  strapR.rotation.z = -0.26;

  // Belt + buckle.
  add(body, new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.055, 12, 32), mat(PAL.leatherDark)), 0, 0.86, 0).rotation.x = Math.PI / 2;
  add(body, new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.06), metalMat(PAL.metal)), 0, 0.86, 0.31);

  // Vials on the belt — tiny green/red glass.
  [[-0.26, 0x7fd94a], [-0.15, 0xd94a4a], [0.24, 0x4a9fd9]].forEach(([x, col]) => {
    const vialMat = new THREE.MeshStandardMaterial({
      color: col, roughness: 0.2, metalness: 0.1, emissive: col, emissiveIntensity: 0.35,
    });
    // Tagged so the hurt-flash pass below does not blank out their glow.
    vialMat.userData.keepEmissive = true;
    const v = add(body, new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.16, 16), vialMat), x, 0.79, 0.26);
    v.rotation.x = 0.2;
  });

  // ---- head + horned helm ------------------------------------------------
  const head = new THREE.Group();
  head.position.set(0, 1.72, 0);
  body.add(head);
  parts.head = head;

  add(head, new THREE.Mesh(new THREE.SphereGeometry(0.23, 28, 20), mat(PAL.skin, 0.9, false)), 0, 0, 0);

  // Helm dome.
  const helm = add(head, new THREE.Mesh(new THREE.SphereGeometry(0.26, 28, 20, 0, TAU, 0, Math.PI * 0.62), metalMat(PAL.metalDark)), 0, 0.02, 0);
  helm.scale.set(1, 1.05, 1.05);

  // Brow guard.
  const brow = add(head, new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.09, 0.1), metalMat(PAL.metal)), 0, 0.04, 0.19);
  brow.rotation.x = -0.12;

  // Horns — the signature silhouette.
  const hornGeo = new THREE.ConeGeometry(0.075, 0.52, 16, 6);
  [-1, 1].forEach((s) => {
    const horn = add(head, new THREE.Mesh(hornGeo, mat(PAL.horn, 0.6)), s * 0.21, 0.16, -0.02);
    horn.rotation.z = s * 0.72;
    horn.rotation.x = -0.4;
    const tip = add(head, new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.34, 14, 4), mat(PAL.horn, 0.6)), s * 0.42, 0.36, -0.14);
    tip.rotation.z = s * 0.25;
    tip.rotation.x = -0.9;
  });

  // Glowing eyes under the brow.
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffd27f });
  [-1, 1].forEach((s) => add(head, new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), eyeMat), s * 0.09, -0.02, 0.21));

  // Scarf / mask over the lower face.
  const scarf = add(head, new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.2, 24), mat(0x5a2420)), 0, -0.16, 0.02);
  scarf.scale.z = 0.85;

  // ---- hood + cloak ------------------------------------------------------
  const hood = add(body, new THREE.Mesh(new THREE.SphereGeometry(0.36, 28, 20, 0, TAU, 0, Math.PI * 0.62), mat(PAL.coat, 0.95)), 0, 1.74, -0.06);
  hood.scale.set(1.05, 1.0, 1.15);

  const coat = new THREE.Group();
  coat.position.set(0, 1.52, -0.04);
  body.add(coat);
  parts.cloak = coat;   // the animation code still refers to this as `cloak`

  const COAT_GAP = 1.30;   // radians of opening across the front
  const coatMat = new THREE.MeshStandardMaterial({
    color: PAL.coat, roughness: 0.85, metalness: 0.05,
    flatShading: false, side: THREE.DoubleSide,
  });

  // Three builds cylinders/cones with x = r*sin(theta), z = r*cos(theta), so
  // theta 0 sits on +Z — the hunter's forward. Starting half a gap round and
  // stopping half a gap short leaves the opening centred on his chest, which is
  // what turns the old closed cone (a skirt) into a coat his legs show through.
  const coatGeo = new THREE.ConeGeometry(0.56, 1.18, 24, 6, true, COAT_GAP / 2, TAU - COAT_GAP);
  const coatMesh = new THREE.Mesh(coatGeo, coatMat);
  coatMesh.position.y = -0.42;
  coatMesh.castShadow = true;
  coat.add(coatMesh);

  // Two front panels hanging either side of the opening.
  const panelGeo = new THREE.BoxGeometry(0.2, 1.06, 0.05);
  [-1, 1].forEach((s2) => {
    const panel = new THREE.Mesh(panelGeo, coatMat);
    panel.position.set(s2 * 0.25, -0.44, 0.29);
    panel.rotation.z = s2 * 0.07;
    panel.rotation.x = -0.05;
    panel.castShadow = true;
    coat.add(panel);
  });

  // Lapels folded back over the chest.
  const lapelMat = mat(PAL.coatDark, 0.8);
  const lapelGeo = new THREE.BoxGeometry(0.15, 0.44, 0.05);
  [-1, 1].forEach((s2) => {
    const lapel = new THREE.Mesh(lapelGeo, lapelMat);
    lapel.position.set(s2 * 0.2, 0.08, 0.30);
    lapel.rotation.z = s2 * -0.36;
    coat.add(lapel);
  });

  // Torn hem across the back arc only — the front stays open.
  const hemMat = new THREE.MeshStandardMaterial({
    color: PAL.coatDark, side: THREE.DoubleSide, flatShading: false, roughness: 1,
  });
  for (let i = 0; i < 8; i++) {
    const a = COAT_GAP / 2 + (i / 7) * (TAU - COAT_GAP);
    const t = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.26, 8), hemMat);
    t.position.set(Math.sin(a) * 0.545, -1.05, Math.cos(a) * 0.545);
    t.rotation.x = Math.PI;
    coat.add(t);
  }

  // ---- pauldrons ---------------------------------------------------------
  [-1, 1].forEach((s) => {
    const p = add(body, new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16, 0, TAU, 0, Math.PI * 0.6), metalMat(PAL.metalDark)), s * 0.4, 1.46, 0);
    p.rotation.z = s * 0.55;
    p.scale.set(1.15, 0.85, 1.0);
    const stud = add(body, new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 12), metalMat(PAL.metal)), s * 0.55, 1.5, 0);
    stud.rotation.z = s * -1.3;
  });

  // ---- arms with bandaged fists -----------------------------------------
  const armGeo = new THREE.CapsuleGeometry(0.1, 0.4, 8, 18);
  const fistGeo = new THREE.IcosahedronGeometry(0.16, 2);
  parts.arms = [];
  [-1, 1].forEach((s) => {
    const arm = new THREE.Group();
    arm.position.set(s * 0.4, 1.4, 0);
    body.add(arm);
    const upper = add(arm, new THREE.Mesh(armGeo, mat(PAL.leather, 0.9)), 0, -0.24, 0);
    const wrapMat = mat(PAL.wrap, 1);
    const fore = add(arm, new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.26, 8, 18), wrapMat), 0, -0.6, 0);
    const fist = add(arm, new THREE.Mesh(fistGeo, wrapMat), 0, -0.84, 0.02);
    // Knuckle spikes — these are the level-1 "weapon".
    for (let i = 0; i < 3; i++) {
      const sp = add(arm, new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.1, 10), metalMat(PAL.metal)), (i - 1) * 0.075, -0.88, 0.14);
      sp.rotation.x = Math.PI / 2;
    }
    arm.userData.side = s;
    parts.arms.push(arm);
  });

  // ---- legs --------------------------------------------------------------
  parts.legs = [];
  [-1, 1].forEach((s) => {
    const leg = new THREE.Group();
    leg.position.set(s * 0.16, 0.82, 0);
    body.add(leg);
    add(leg, new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.4, 8, 18), mat(PAL.leatherDark, 0.9)), 0, -0.26, 0);
    const boot = add(leg, new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.34), mat(0x24190f)), 0, -0.56, 0.05);
    leg.userData.side = s;
    parts.legs.push(leg);
  });

  // ---- hip lantern -------------------------------------------------------
  const lantern = new THREE.Group();
  lantern.position.set(0.42, 0.9, -0.06);
  body.add(lantern);
  parts.lantern = lantern;
  const cage = add(lantern, new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.2, 16, 1, true), metalMat(PAL.metalDark)), 0, 0, 0);
  add(lantern, new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.09, 16), metalMat(PAL.metalDark)), 0, 0.13, 0);
  const flame = add(lantern, new THREE.Mesh(new THREE.SphereGeometry(0.07, 18, 14),
    new THREE.MeshBasicMaterial({ color: 0xffc46b })), 0, 0, 0);
  parts.flame = flame;

  g.scale.setScalar(CFG.SCALE.player);
  return { group: g, parts };
}

export class Player {
  constructor(scene) {
    const built = buildHunter();
    this.mesh = built.group;
    this.parts = built.parts;
    scene.add(this.mesh);

    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.facing = 0;         // radians, yaw
    this.aim = new THREE.Vector3(0, 0, -1); // last non-zero movement direction

    this.level = 1;
    this.levelUps = 0;       // how many upgrade picks have been taken
    this.xp = 0;
    this.xpNeeded = CFG.xpForLevel(1);
    this.kills = 0;
    this.parts_collected = 0;

    this.alive = true;
    this.invuln = 0;
    this.hurtFlash = 0;
    this._walkPhase = 0;
    this._punchT = 0;
    this._punchSide = 0;
    this._attackYaw = 0;
    this._attackHold = 0;

    // Stat block. Weapons read these every time they fire.
    this.stats = {
      maxHp: CFG.PLAYER.maxHp,
      hp: CFG.PLAYER.maxHp,
      speed: CFG.PLAYER.speed,
      might: 1.0,            // outgoing damage multiplier
      haste: 1.0,            // cooldown multiplier (lower = faster)
      area: 1.0,             // AoE size multiplier
      duration: 1.0,         // lingering effect multiplier
      projectiles: 0,        // flat extra projectiles
      speedProj: 1.0,        // projectile velocity multiplier
      magnet: CFG.PLAYER.pickupRadius,
      armor: 0,              // flat damage reduction
      regen: 0,              // hp per second
      greed: 1.0,            // xp multiplier
      luck: 1.0,             // chest / rare roll multiplier
      crit: 0.03,
      critMul: 2.0,
      revives: 0,
    };
  }

  get hp() { return this.stats.hp; }
  get maxHp() { return this.stats.maxHp; }

  addXp(amount) {
    this.xp += amount;
    this.parts_collected += amount;
    let gained = 0;
    while (this.xp >= this.xpNeeded && this.levelUps + gained < CFG.MAX_LEVEL_UPS) {
      this.xp -= this.xpNeeded;
      this.level++;
      gained++;
      this.xpNeeded = CFG.xpForLevel(this.level);
    }
    // At the cap XP still accumulates for score but stops granting picks.
    if (this.levelUps + gained >= CFG.MAX_LEVEL_UPS) this.xp = Math.min(this.xp, this.xpNeeded);
    return gained;
  }

  heal(amount) {
    const before = this.stats.hp;
    this.stats.hp = Math.min(this.stats.maxHp, this.stats.hp + amount);
    return this.stats.hp - before;
  }

  damage(amount) {
    if (this.invuln > 0 || !this.alive) return 0;
    const dealt = Math.max(1, amount - this.stats.armor);
    this.stats.hp -= dealt;
    this.invuln = CFG.PLAYER.iframes;
    this.hurtFlash = 1;
    if (this.stats.hp <= 0) {
      if (this.stats.revives > 0) {
        this.stats.revives--;
        this.stats.hp = Math.round(this.stats.maxHp * 0.55);
        this.invuln = 2.5;
        return dealt;
      }
      this.stats.hp = 0;
      this.alive = false;
    }
    return dealt;
  }

  /** Triggers the fist swing animation used by the unarmed weapon. */
  punch() {
    this._punchT = 1;
    this._punchSide = this._punchSide === 0 ? 1 : 0;
  }

  /**
   * Snap the hunter around to face an incoming attack direction for a moment.
   * Melee weapons auto-target the nearest monster, and the body needs to follow
   * the swing or the animation reads as punching empty air.
   */
  faceAttack(yaw) {
    this._attackYaw = yaw;
    this._attackHold = 0.34;
  }

  update(dt, move) {
    const s = this.stats;
    if (this.invuln > 0) this.invuln -= dt;
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3);
    if (s.regen > 0 && this.alive) this.heal(s.regen * dt);

    const moving = move.x !== 0 || move.z !== 0;
    const target = s.speed;
    this.vel.x = damp(this.vel.x, move.x * target, 16, dt);
    this.vel.z = damp(this.vel.z, move.z * target, 16, dt);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    if (moving) this.aim.set(move.x, 0, move.z).normalize();

    // An in-progress swing wins over the movement heading.
    if (this._attackHold > 0) this._attackHold -= dt;
    const want = this._attackHold > 0
      ? this._attackYaw
      : (moving ? Math.atan2(move.x, move.z) : null);

    if (want !== null) {
      // Shortest-arc yaw interpolation.
      let diff = want - this.facing;
      while (diff > Math.PI) diff -= TAU;
      while (diff < -Math.PI) diff += TAU;
      const rate = this._attackHold > 0 ? CFG.PLAYER.turnLerp * 2.2 : CFG.PLAYER.turnLerp;
      this.facing += diff * clamp(rate * dt, 0, 1);
    }

    this.mesh.position.set(this.pos.x, 0, this.pos.z);
    this.mesh.rotation.y = this.facing;

    // --- animation --------------------------------------------------------
    const speedFrac = Math.hypot(this.vel.x, this.vel.z) / Math.max(0.001, s.speed);
    this._walkPhase += dt * (4 + speedFrac * 7);
    const swing = Math.sin(this._walkPhase) * 0.55 * speedFrac;

    this.parts.legs[0].rotation.x = swing;
    this.parts.legs[1].rotation.x = -swing;

    // Arms counter-swing, then the punch animation overrides one of them.
    this.parts.arms[0].rotation.x = -swing * 0.7;
    this.parts.arms[1].rotation.x = swing * 0.7;

    if (this._punchT > 0) {
      this._punchT = Math.max(0, this._punchT - dt * 6.5);
      const p = 1 - this._punchT;
      // Fast out, slow back.
      const ext = p < 0.35 ? p / 0.35 : 1 - (p - 0.35) / 0.65;
      const arm = this.parts.arms[this._punchSide];
      arm.rotation.x = -1.55 * ext;
      arm.position.z = ext * 0.22;
      const other = this.parts.arms[1 - this._punchSide];
      other.position.z = 0;
    } else {
      this.parts.arms[0].position.z = 0;
      this.parts.arms[1].position.z = 0;
    }

    // Body bob + cloak drag.
    this.parts.body.position.y = Math.abs(Math.sin(this._walkPhase)) * 0.045 * speedFrac;
    this.parts.cloak.rotation.x = -0.06 - speedFrac * 0.34 + Math.sin(this._walkPhase * 0.5) * 0.05 * speedFrac;
    this.parts.cloak.rotation.z = Math.sin(this._walkPhase * 0.7) * 0.07 * speedFrac;

    // Lantern flicker.
    const fl = 0.85 + Math.sin(performance.now() * 0.011) * 0.1 + Math.random() * 0.06;
    this.parts.flame.scale.setScalar(fl);

    // Hurt flash tints the whole hunter red.
    if (this.hurtFlash > 0) {
      this.mesh.traverse((o) => {
        if (o.isMesh && o.material && o.material.emissive && !o.material.userData.keepEmissive) {
          o.material.emissive.setRGB(this.hurtFlash * 0.7, 0, 0);
        }
      });
    } else if (this._wasFlashing) {
      this.mesh.traverse((o) => {
        if (o.isMesh && o.material && o.material.emissive && !o.material.userData?.keepEmissive) {
          o.material.emissive.setRGB(0, 0, 0);
        }
      });
    }
    this._wasFlashing = this.hurtFlash > 0;
  }

  /** World position of the lantern flame, for lighting. */
  lanternWorld(out) {
    return this.parts.flame.getWorldPosition(out);
  }
}
