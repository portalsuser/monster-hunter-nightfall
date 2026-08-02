import * as THREE from 'three';
import { CFG } from './config.js';
import { rand, TAU } from './utils.js';

/**
 * Every transient visual — sparks, blood, shockwave rings, floating damage
 * numbers — lives here. Everything is pooled and instanced so a screen full of
 * simultaneous kills does not allocate.
 */
export class VFX {
  constructor(scene) {
    this.scene = scene;
    this._buildParticles();
    this._buildRings();
    this._buildNumbers();
  }

  // -------------------------------------------------------------------------
  // Particles
  // -------------------------------------------------------------------------
  _buildParticles() {
    const MAX = CFG.MAX_PARTICLES;
    const geo = new THREE.TetrahedronGeometry(0.13, 0);
    // NOTE: no `vertexColors: true` here. Per-instance tint comes from
    // instanceColor (USE_INSTANCING_COLOR); switching on vertexColors as well
    // would make three declare a `color` attribute the geometry does not have,
    // which resolves to black and renders every particle invisible.
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 });
    this.pMesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.pMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pMesh.frustumCulled = false;
    this.pMesh.count = 0;
    // instanceColor is only allocated if we set it up front.
    this.pMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.pMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.pMesh);

    this.particles = [];
    for (let i = 0; i < MAX; i++) {
      this.particles.push({
        alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1, size: 1, spin: 0, rot: 0, grav: -9,
        r: 1, g: 1, b: 1, drag: 0.02,
      });
    }
    this._pDummy = new THREE.Object3D();
    this._pColor = new THREE.Color();
  }

  spawnParticles(x, y, z, count, opts = {}) {
    const {
      color = 0xffffff, speed = 4, spread = 1, life = 0.6, size = 1,
      grav = -9, up = 2, drag = 0.02,
    } = opts;
    this._pColor.set(color);
    let made = 0;
    for (let i = 0; i < this.particles.length && made < count; i++) {
      const p = this.particles[i];
      if (p.alive) continue;
      const a = Math.random() * TAU;
      const el = Math.random() * spread;
      const sp = speed * (0.45 + Math.random() * 0.75);
      p.alive = true;
      p.x = x; p.y = y; p.z = z;
      p.vx = Math.cos(a) * sp * el;
      p.vz = Math.sin(a) * sp * el;
      p.vy = up * (0.4 + Math.random());
      p.life = p.maxLife = life * (0.7 + Math.random() * 0.6);
      p.size = size * (0.6 + Math.random() * 0.8);
      p.spin = rand(-9, 9);
      p.rot = Math.random() * TAU;
      p.grav = grav;
      p.drag = drag;
      p.r = this._pColor.r; p.g = this._pColor.g; p.b = this._pColor.b;
      made++;
    }
  }

  _updateParticles(dt) {
    const d = this._pDummy;
    let n = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      p.vy += p.grav * dt;
      const k = Math.max(0, 1 - p.drag * dt * 60);
      p.vx *= k; p.vz *= k;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.05) { p.y = 0.05; p.vy *= -0.32; p.vx *= 0.7; p.vz *= 0.7; }
      p.rot += p.spin * dt;

      const t = p.life / p.maxLife;
      d.position.set(p.x, p.y, p.z);
      d.rotation.set(p.rot, p.rot * 0.7, 0);
      d.scale.setScalar(p.size * (0.3 + t * 0.9));
      d.updateMatrix();
      this.pMesh.setMatrixAt(n, d.matrix);
      this.pMesh.instanceColor.setXYZ(n, p.r * t, p.g * t, p.b * t);
      n++;
    }
    this.pMesh.count = n;
    if (n > 0) {
      this.pMesh.instanceMatrix.needsUpdate = true;
      this.pMesh.instanceColor.needsUpdate = true;
    }
  }

  // -------------------------------------------------------------------------
  // Expanding ground rings (explosions, boss slams, level-up bursts)
  // -------------------------------------------------------------------------
  _buildRings() {
    const MAX = 24;
    this.rings = [];
    const geo = new THREE.RingGeometry(0.72, 1.0, 32);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < MAX; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 5;
      this.scene.add(m);
      this.rings.push({ mesh: m, life: 0, maxLife: 1, from: 1, to: 5 });
    }
  }

  ring(x, z, from, to, color = 0xffffff, life = 0.45, y = 0.15) {
    for (const r of this.rings) {
      if (r.life > 0) continue;
      r.life = r.maxLife = life;
      r.from = from; r.to = to;
      r.mesh.visible = true;
      r.mesh.position.set(x, y, z);
      r.mesh.material.color.set(color);
      r.mesh.scale.setScalar(from);
      return r;
    }
    return null;
  }

  _updateRings(dt) {
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.mesh.visible = false; continue; }
      const t = 1 - r.life / r.maxLife;
      const s = r.from + (r.to - r.from) * (1 - Math.pow(1 - t, 2));
      r.mesh.scale.setScalar(s);
      r.mesh.material.opacity = 0.75 * (1 - t);
    }
  }

  // -------------------------------------------------------------------------
  // Floating damage numbers
  // -------------------------------------------------------------------------
  _buildNumbers() {
    this._numCache = new Map();
    this._numOrder = [];
    this.numbers = [];
    const MAX = 46;
    for (let i = 0; i < MAX; i++) {
      // fog:false — damage numbers are an overlay (see depthTest/renderOrder);
      // SpriteMaterial fogs by default and would tint distant hits toward black.
      const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      s.renderOrder = 20;
      this.scene.add(s);
      this.numbers.push({ sprite: s, life: 0, vx: 0, vy: 0, x: 0, y: 0, z: 0, scale: 1 });
    }
  }

  _numTexture(text, color) {
    const key = `${text}|${color}`;
    let tex = this._numCache.get(key);
    if (tex) return tex;

    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    g.font = 'bold 44px "Trebuchet MS", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 7;
    g.strokeStyle = 'rgba(0,0,0,0.9)';
    g.strokeText(text, 64, 34);
    g.fillStyle = color;
    g.fillText(text, 64, 34);

    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this._numCache.set(key, tex);
    this._numOrder.push(key);
    // Bounded cache — damage values repeat heavily, but crits and boss hits
    // create a long tail we do not want to keep forever.
    if (this._numOrder.length > 220) {
      const old = this._numOrder.shift();
      const stale = this._numCache.get(old);
      this._numCache.delete(old);
      // Only dispose if no visible sprite still references it.
      if (stale && !this.numbers.some((n) => n.life > 0 && n.sprite.material.map === stale)) {
        stale.dispose();
      }
    }
    return tex;
  }

  damageNumber(x, y, z, amount, opts = {}) {
    if (!CFG.DAMAGE_NUMBERS) return;
    const { color = '#ffe9b0', crit = false, prefix = '' } = opts;
    const text = prefix + (amount < 10 ? amount.toFixed(0) : Math.round(amount).toString());
    for (const n of this.numbers) {
      if (n.life > 0) continue;
      n.life = crit ? 1.05 : 0.75;
      n.maxLife = n.life;
      n.x = x + rand(-0.35, 0.35);
      n.y = y;
      n.z = z + rand(-0.25, 0.25);
      n.vx = rand(-0.7, 0.7);
      n.vy = crit ? 4.0 : 3.1;
      n.scale = crit ? 1.5 : 1.0;
      n.sprite.material.map = this._numTexture(text, crit ? '#ff5a4a' : color);
      n.sprite.material.needsUpdate = true;
      n.sprite.visible = true;
      return;
    }
  }

  _updateNumbers(dt) {
    for (const n of this.numbers) {
      if (n.life <= 0) continue;
      n.life -= dt;
      if (n.life <= 0) { n.sprite.visible = false; continue; }
      n.vy -= 7.5 * dt;
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      const t = n.life / n.maxLife;
      n.sprite.position.set(n.x, n.y, n.z);
      const s = n.scale * (1.15 - t * 0.15);
      n.sprite.scale.set(s * 1.5, s * 0.75, 1);
      n.sprite.material.opacity = Math.min(1, t * 2.2);
    }
  }

  update(dt) {
    this._updateParticles(dt);
    this._updateRings(dt);
    this._updateNumbers(dt);
  }

  // Convenience presets ------------------------------------------------------
  bloodBurst(x, y, z, color = 0x7d1f2a, big = false) {
    this.spawnParticles(x, y, z, big ? 22 : 9, {
      color, speed: big ? 7 : 4.5, life: big ? 0.8 : 0.5, size: big ? 1.4 : 0.85, up: big ? 3.5 : 2,
    });
  }

  sparks(x, y, z, color = 0xffd27f, n = 7) {
    this.spawnParticles(x, y, z, n, { color, speed: 6, life: 0.35, size: 0.6, up: 2.5, grav: -14 });
  }

  clear() {
    for (const p of this.particles) p.alive = false;
    for (const r of this.rings) { r.life = 0; r.mesh.visible = false; }
    for (const n of this.numbers) { n.life = 0; n.sprite.visible = false; }
    this.pMesh.count = 0;
  }
}
