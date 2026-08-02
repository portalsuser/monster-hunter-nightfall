import * as THREE from 'three';
import { CFG } from './config.js';
import { SFX } from './audio.js';
import { chance, damp, rand, randInt, ringPoint, TAU, weighted } from './utils.js';

/**
 * Drops and chests.
 *
 * Monster parts are the XP currency. They are drawn from three instanced
 * meshes (small / medium / large) so a floor covered in 400 drops is still
 * three draw calls.
 */

const PART_TIERS = [
  { value: 1, color: 0x8fd94a, scale: 0.9 },
  { value: 5, color: 0x4ac8ff, scale: 1.15 },
  { value: 25, color: 0xd94aff, scale: 1.5 },
];

export class Pickups {
  constructor(scene, vfx, player, game) {
    this.scene = scene;
    this.vfx = vfx;
    this.player = player;
    this.game = game;
    this._dummy = new THREE.Object3D();

    this._buildParts();
    this._buildHealth();
    this._buildChests();

    this.chestTimer = rand(CFG.CHEST.interval[0], CFG.CHEST.interval[1]);
  }

  _buildParts() {
    const CAP = 460;
    // A "monster part" reads as a chunk of bone/claw: an octahedron works well
    // at this camera distance and costs almost nothing.
    const geo = new THREE.OctahedronGeometry(0.19, 1);
    this.partMeshes = PART_TIERS.map((tier) => {
      const mat = new THREE.MeshStandardMaterial({
        color: tier.color, emissive: tier.color, emissiveIntensity: 0.55,
        roughness: 0.3, metalness: 0.15, flatShading: false,
      });
      const m = new THREE.InstancedMesh(geo, mat, CAP);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      this.scene.add(m);
      return m;
    });
    this.parts = [];
    this.partCap = CAP;
  }

  _buildHealth() {
    const CAP = 40;
    const geo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff5a7a, emissive: 0xff2a4a, emissiveIntensity: 0.7, roughness: 0.4, flatShading: false,
    });
    this.healthMesh = new THREE.InstancedMesh(geo, mat, CAP);
    this.healthMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.healthMesh.frustumCulled = false;
    this.healthMesh.count = 0;
    this.scene.add(this.healthMesh);
    this.healths = [];
  }

  _buildChests() {
    this.chests = [];
    for (let i = 0; i < CFG.CHEST.maxAlive; i++) {
      const g = new THREE.Group();
      const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a29, roughness: 0.8, flatShading: false });
      const iron = new THREE.MeshStandardMaterial({ color: 0x9c8c68, metalness: 0.85, roughness: 0.35, flatShading: false });

      const base = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.6, 0.72), wood);
      base.position.y = 0.3;
      base.castShadow = true;
      g.add(base);

      const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 1.0, 28, 1, false, 0, Math.PI), wood);
      lid.rotation.z = Math.PI / 2;
      lid.position.y = 0.6;
      lid.castShadow = true;
      g.add(lid);

      [-0.32, 0.32].forEach((x) => {
        const band = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.66, 0.78), iron);
        band.position.set(x, 0.3, 0);
        g.add(band);
      });
      const lock = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.1), iron);
      lock.position.set(0, 0.5, 0.38);
      g.add(lock);

      // Faint glow so chests are findable in the dark.
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 22, 16),
        new THREE.MeshBasicMaterial({ color: 0xffd23c, transparent: true, opacity: 0.09, depthWrite: false, blending: THREE.AdditiveBlending })
      );
      glow.position.y = 0.5;
      g.add(glow);

      g.visible = false;
      this.scene.add(g);
      this.chests.push({ group: g, glow, alive: false, x: 0, z: 0, hp: 0, maxHp: 0, hitFlash: 0, bob: Math.random() * TAU });
    }
  }

  // ---- spawning ----------------------------------------------------------

  /** Splits a monster's XP value into denominated drops. */
  dropParts(x, z, value) {
    let remaining = Math.max(1, Math.round(value));
    const drops = [];
    for (let t = PART_TIERS.length - 1; t >= 0; t--) {
      const tier = PART_TIERS[t];
      while (remaining >= tier.value && drops.length < 12) {
        drops.push(t);
        remaining -= tier.value;
      }
    }
    if (!drops.length) drops.push(0);

    for (const tierIndex of drops) {
      if (this.parts.length >= this.partCap * PART_TIERS.length) break;
      this.parts.push({
        tier: tierIndex,
        x: x + rand(-0.5, 0.5),
        z: z + rand(-0.5, 0.5),
        y: 0.55,
        vy: rand(1.5, 3.2),
        vx: rand(-1.4, 1.4),
        vz: rand(-1.4, 1.4),
        spin: rand(-4, 4),
        rot: Math.random() * TAU,
        grounded: false,
        magnetized: false,
        life: 0,
      });
    }
  }

  dropHealth(x, z, amount) {
    if (this.healths.length >= 40) return;
    this.healths.push({
      x, z, y: 0.6, vy: 2.6, rot: 0, amount,
      vx: rand(-1, 1), vz: rand(-1, 1), grounded: false, magnetized: false,
    });
  }

  spawnChest(playerPos) {
    let slot = this.chests.find((c) => !c.alive);

    // No free slot: take the one furthest away rather than giving up.
    //
    // Slots were only ever freed by breaking a chest or by getting 70 units
    // clear of it. A player who kites in a circle does neither, so all four
    // filled with chests they had circled past and every later spawn was
    // silently dropped — which looked exactly like "chests stopped appearing on
    // level 2", because that is when the fourth slot filled. A fresh chest near
    // the hunter is worth more than a stale one he already walked away from.
    if (!slot) {
      let best = null, bestD2 = -1;
      for (const c of this.chests) {
        const dx = c.x - playerPos.x, dz = c.z - playerPos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > bestD2) { bestD2 = d2; best = c; }
      }
      // Leave alone anything still close enough that the hunter is plausibly
      // walking to it. Chests spawn 12-24 units out, so the guard has to sit
      // below that or a kiting player never frees a slot at all.
      if (!best || bestD2 < 14 * 14) return null;
      best.alive = false;
      best.group.visible = false;
      slot = best;
    }
    const p = ringPoint(playerPos.x, playerPos.z, CFG.CHEST.spawnRadius[0], CFG.CHEST.spawnRadius[1]);
    slot.alive = true;
    slot.x = p.x;
    slot.z = p.z;
    slot.maxHp = CFG.CHEST.hp;
    slot.hp = slot.maxHp;
    slot.hitFlash = 0;
    slot.group.visible = true;
    slot.group.position.set(p.x, 0, p.z);
    slot.group.rotation.y = Math.random() * TAU;
    slot.group.scale.setScalar(0.01);
    return slot;
  }

  /** Chests are damaged like enemies; weapons find them via this list. */
  hurtChest(chest, amount) {
    if (!chest.alive) return;
    chest.hp -= amount;
    chest.hitFlash = 1;
    this.vfx.spawnParticles(chest.x, 0.6, chest.z, 3, { color: 0x8a6a3a, speed: 3, life: 0.4, size: 0.7, up: 1.6 });
    if (chest.hp <= 0) this.breakChest(chest);
  }

  breakChest(chest) {
    chest.alive = false;
    chest.group.visible = false;
    SFX.chestBreak();
    this.vfx.ring(chest.x, chest.z, 0.4, 4.0, 0xffd23c, 0.5);
    this.vfx.spawnParticles(chest.x, 0.6, chest.z, 26, { color: 0x8a6a3a, speed: 7, life: 0.9, size: 1.1, up: 3.5 });

    const luck = this.player.stats.luck || 1;
    const roll = weighted([
      ['parts', CFG.CHEST.loot.parts],
      ['health', CFG.CHEST.loot.health],
      ['levelUp', CFG.CHEST.loot.levelUp * luck],
    ]);

    if (roll === 'levelUp') {
      this.vfx.ring(chest.x, chest.z, 0.5, 7, 0xff9fd0, 0.9);
      this.vfx.spawnParticles(chest.x, 1.0, chest.z, 40, { color: 0xffd23c, speed: 9, life: 1.2, size: 1.4, up: 4 });
      this.game.grantLevelUp('a chest');
      this.game.toast('Chest: LEVEL UP!', '#ffd23c');
    } else if (roll === 'health') {
      const n = randInt(2, 4);
      for (let i = 0; i < n; i++) this.dropHealth(chest.x + rand(-0.7, 0.7), chest.z + rand(-0.7, 0.7), 22);
      this.game.toast('Chest: Health', '#ff6a8a');
    } else {
      const value = Math.round(rand(34, 84) + this.player.level * 6);
      this.dropParts(chest.x, chest.z, value);
      this.game.toast('Chest: Monster Parts', '#8fd94a');
    }
  }

  // ---- update ------------------------------------------------------------

  update(dt, elapsed) {
    this._updateChests(dt, elapsed);
    this._updateParts(dt);
    this._updateHealth(dt);

    this.chestTimer -= dt;
    if (this.chestTimer <= 0) {
      this.chestTimer = rand(CFG.CHEST.interval[0], CFG.CHEST.interval[1]);
      this.spawnChest(this.player.pos);
    }
  }

  _updateChests(dt, elapsed) {
    const p = this.player.pos;
    for (const c of this.chests) {
      if (!c.alive) continue;
      // Pop-in scale.
      const s = c.group.scale.x;
      if (s < 1) c.group.scale.setScalar(Math.min(1, s + dt * 4));
      c.group.position.y = Math.sin(elapsed * 2 + c.bob) * 0.04;
      c.glow.material.opacity = 0.07 + Math.sin(elapsed * 3 + c.bob) * 0.03;

      if (c.hitFlash > 0) {
        c.hitFlash = Math.max(0, c.hitFlash - dt * 4);
        c.group.rotation.z = Math.sin(c.hitFlash * 30) * 0.06;
      }

      // Walking into a chest also breaks it, so melee builds are never stuck.
      const dx = c.x - p.x, dz = c.z - p.z;
      if (dx * dx + dz * dz < 1.3 * 1.3) this.hurtChest(c, 40 * dt);

      // Chests too far behind are recycled. 70 was well past the fog, so a
      // chest could sit forever just off screen holding a slot hostage.
      if (dx * dx + dz * dz > 46 * 46) {
        c.alive = false;
        c.group.visible = false;
      }
    }
  }

  _updateParts(dt) {
    const p = this.player.pos;
    const magnet = this.player.stats.magnet;
    const magnet2 = magnet * magnet;
    const counts = [0, 0, 0];
    const d = this._dummy;
    let collected = 0;

    for (let i = this.parts.length - 1; i >= 0; i--) {
      const g = this.parts[i];
      g.life += dt;

      if (!g.grounded) {
        g.vy -= 12 * dt;
        g.x += g.vx * dt;
        g.z += g.vz * dt;
        g.y += g.vy * dt;
        if (g.y <= 0.22) { g.y = 0.22; g.grounded = true; }
      }
      g.rot += g.spin * dt * (g.grounded ? 0.25 : 1);

      const dx = p.x - g.x, dz = p.z - g.z;
      const d2 = dx * dx + dz * dz;

      if (g.magnetized || d2 < magnet2) {
        g.magnetized = true;
        const dd = Math.sqrt(d2) || 1;
        // Accelerating pull — feels much better than a constant speed.
        const pull = 6 + (1 - Math.min(1, dd / (magnet + 4))) * 22;
        g.x += (dx / dd) * pull * dt;
        g.z += (dz / dd) * pull * dt;
        g.y = damp(g.y, 0.8, 8, dt);
        if (d2 < 0.55 * 0.55) {
          collected += PART_TIERS[g.tier].value;
          this.parts.splice(i, 1);
          continue;
        }
      }

      const tier = PART_TIERS[g.tier];
      const idx = counts[g.tier];
      if (idx < this.partCap) {
        d.position.set(g.x, g.y + (g.grounded ? Math.sin(g.life * 3 + g.rot) * 0.06 : 0), g.z);
        d.rotation.set(g.rot * 0.6, g.rot, 0);
        d.scale.setScalar(tier.scale);
        d.updateMatrix();
        this.partMeshes[g.tier].setMatrixAt(idx, d.matrix);
        counts[g.tier] = idx + 1;
      }
    }

    for (let t = 0; t < 3; t++) {
      this.partMeshes[t].count = counts[t];
      if (counts[t] > 0) this.partMeshes[t].instanceMatrix.needsUpdate = true;
    }

    if (collected > 0) {
      SFX.pickup();
      this.game.collectParts(collected);
    }
  }

  _updateHealth(dt) {
    const p = this.player.pos;
    const magnet = this.player.stats.magnet * 0.8;
    const d = this._dummy;
    let n = 0;
    let healed = 0;

    for (let i = this.healths.length - 1; i >= 0; i--) {
      const h = this.healths[i];
      if (!h.grounded) {
        h.vy -= 12 * dt;
        h.x += h.vx * dt;
        h.z += h.vz * dt;
        h.y += h.vy * dt;
        if (h.y <= 0.2) { h.y = 0.2; h.grounded = true; }
      }
      h.rot += dt * 2.2;

      const dx = p.x - h.x, dz = p.z - h.z;
      const d2 = dx * dx + dz * dz;
      if (h.magnetized || d2 < magnet * magnet) {
        h.magnetized = true;
        const dd = Math.sqrt(d2) || 1;
        h.x += (dx / dd) * 13 * dt;
        h.z += (dz / dd) * 13 * dt;
        if (d2 < 0.6 * 0.6) {
          healed += h.amount;
          this.healths.splice(i, 1);
          continue;
        }
      }

      if (n < 40) {
        d.position.set(h.x, h.y + Math.sin(h.rot) * 0.05, h.z);
        d.rotation.set(0, h.rot, 0.2);
        d.scale.setScalar(1);
        d.updateMatrix();
        this.healthMesh.setMatrixAt(n++, d.matrix);
      }
    }

    this.healthMesh.count = n;
    if (n > 0) this.healthMesh.instanceMatrix.needsUpdate = true;

    if (healed > 0) {
      const got = this.player.heal(healed);
      if (got > 0) {
        SFX.health();
        this.vfx.damageNumber(p.x, 2.2, p.z, Math.round(got), { color: '#8affb0', prefix: '+' });
      }
    }
  }

  reset() {
    this.parts.length = 0;
    this.healths.length = 0;
    for (const m of this.partMeshes) m.count = 0;
    this.healthMesh.count = 0;
    for (const c of this.chests) { c.alive = false; c.group.visible = false; }
    this.chestTimer = rand(CFG.CHEST.interval[0], CFG.CHEST.interval[1]);
  }
}
