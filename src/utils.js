/** Small math / helper grab-bag shared across the game modules. */

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const chance = (p) => Math.random() < p;

/** Frame-rate independent exponential smoothing. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Weighted pick. `entries` is [[value, weight], ...]. */
export function weighted(entries) {
  let total = 0;
  for (const e of entries) total += e[1];
  let r = Math.random() * total;
  for (const e of entries) {
    r -= e[1];
    if (r <= 0) return e[0];
  }
  return entries[entries.length - 1][0];
}

/** Shuffle in place (Fisher-Yates) and return the array. */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Squared distance on the XZ plane — avoids a sqrt in hot loops. */
export function dist2XZ(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Random point on a ring around a center, returned as {x, z}. */
export function ringPoint(cx, cz, rMin, rMax) {
  const a = Math.random() * TAU;
  const r = rMin + Math.random() * (rMax - rMin);
  return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r };
}

/**
 * Ring sample biased toward a direction.
 *
 * Without this, a player who simply holds one direction outruns the spawn ring
 * and never meets anything — the horde forever trails behind. Weighting most
 * spawns into the arc the player is heading into is what makes constant
 * movement a positioning choice instead of an exploit.
 *
 * `dirX/dirZ` need not be normalised; a zero vector falls back to uniform.
 */
export function ringPointBiased(cx, cz, rMin, rMax, dirX, dirZ, bias = 0.7, spread = 1.25) {
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.001 || Math.random() > bias) return ringPoint(cx, cz, rMin, rMax);
  const base = Math.atan2(dirZ / len, dirX / len);
  const a = base + (Math.random() * 2 - 1) * spread;
  const r = rMin + Math.random() * (rMax - rMin);
  return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r };
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Minimal generic object pool. Modules use this so a 40-minute run does not
 * churn the GC with thousands of short-lived meshes.
 */
export class Pool {
  constructor(factory, reset) {
    this.factory = factory;
    this.reset = reset;
    this.free = [];
    this.active = [];
  }

  get(...args) {
    const obj = this.free.pop() || this.factory();
    this.reset(obj, ...args);
    this.active.push(obj);
    return obj;
  }

  /** Release by index into `active` — callers iterate backwards. */
  releaseAt(i) {
    const obj = this.active[i];
    this.active[i] = this.active[this.active.length - 1];
    this.active.pop();
    this.free.push(obj);
    return obj;
  }

  release(obj) {
    const i = this.active.indexOf(obj);
    if (i >= 0) this.releaseAt(i);
  }

  clear(onRelease) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const o = this.releaseAt(i);
      if (onRelease) onRelease(o);
    }
  }
}

/**
 * Uniform spatial hash over the XZ plane. Weapons query "what is near this
 * point" every frame; brute-forcing 300 enemies per projectile per frame is the
 * single easiest way to tank the frame rate, so everything goes through here.
 */
export class SpatialHash {
  constructor(cell = 4) {
    this.cell = cell;
    this.map = new Map();
  }

  _key(x, z) {
    // Math.floor (not |0) so that negative world coordinates bucket uniformly —
    // truncation toward zero would make the cell straddling the origin double
    // width and quietly desync insert() from query().
    return (Math.floor(x / this.cell) * 73856093) ^ (Math.floor(z / this.cell) * 19349663);
  }

  clear() {
    this.map.clear();
  }

  insert(obj, x, z) {
    const k = this._key(x, z);
    let bucket = this.map.get(k);
    if (!bucket) {
      bucket = [];
      this.map.set(k, bucket);
    }
    bucket.push(obj);
  }

  /** Collect everything within `radius` of (x,z) into `out`. Returns `out`. */
  query(x, z, radius, out) {
    out.length = 0;
    const c = this.cell;
    const minX = Math.floor((x - radius) / c);
    const maxX = Math.floor((x + radius) / c);
    const minZ = Math.floor((z - radius) / c);
    const maxZ = Math.floor((z + radius) / c);
    for (let ix = minX; ix <= maxX; ix++) {
      for (let iz = minZ; iz <= maxZ; iz++) {
        const bucket = this.map.get((ix * 73856093) ^ (iz * 19349663));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out;
  }
}
