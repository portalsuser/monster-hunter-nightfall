/**
 * Central tuning file. Everything that a designer would want to twiddle lives
 * here so the gameplay modules stay readable.
 */

export const CFG = {
  // ---- run structure -------------------------------------------------------
  MAX_LEVEL_UPS: 20,          // hard cap requested in the design brief
  BOSS_INTERVAL: 180,         // seconds between boss spawns (3 minutes)
  FIRST_BOSS_AT: 180,

  // ---- player --------------------------------------------------------------
  PLAYER: {
    maxHp: 120,
    speed: 5.2,
    pickupRadius: 3.4,
    iframes: 0.62,            // invulnerability after taking a hit
    regen: 0,                 // gained via upgrades
    turnLerp: 14,
  },

  // ---- camera --------------------------------------------------------------
  CAMERA: {
    // 3/4 top-down. Offset is in world units relative to the player.
    offset: [0, 21.5, 15.5],
    fov: 52,
    lerp: 6.5,
    shakeDecay: 6,
  },

  // ---- world ---------------------------------------------------------------
  WORLD: {
    tileSize: 40,             // ground tiles recycled around the player
    tileGrid: 5,              // 5x5 tiles follow the player -> 200u of ground
    treesPerTile: 34,
    rocksPerTile: 10,
    fernsPerTile: 30,
    fogColor: 0x05070c,
    fogDensity: 0.0080,
    groundColor: 0x11180f,
  },

  // ---- progression ---------------------------------------------------------
  // Monster parts needed to go from level L to L+1. The opening deliberately
  // ramps fast: the first two picks should land inside the first minute so the
  // player is never stuck with bare fists for long.
  xpForLevel(level) {
    return Math.round(4 + level * 3.4 + Math.pow(level, 1.82) * 1.25);
  },

  // Global horde density. Spawn *rate* is what gets scaled (not the per-wave
  // count, which is a small integer and would round badly). Monster part values
  // are raised by roughly the inverse in enemies.js, so thinning the horde does
  // not slow progression down.
  DENSITY: 0.65,

  // ---- spawning ------------------------------------------------------------
  SPAWN: {
    innerRadius: 21,          // never spawn closer than this to the player
    outerRadius: 28,
    despawnRadius: 62,        // enemies past this get recycled to the far side
    baseInterval: 1.5,        // seconds between spawn waves at t=0 (before DENSITY)
    minInterval: 0.16,       // floor, also divided by DENSITY
    baseCount: 2,
    maxAlive: 220,
  },

  // ---- chests --------------------------------------------------------------
  CHEST: {
    interval: [16, 26],       // random seconds between chest spawns
    maxAlive: 4,
    spawnRadius: [12, 24],
    hp: 26,
    // loot weights
    loot: {
      parts: 0.62,
      health: 0.30,
      levelUp: 0.035,         // "very rarely they contain a level up" (~3.4%)
    },
  },

  // ---- misc ----------------------------------------------------------------
  DAMAGE_NUMBERS: true,
  MAX_PARTICLES: 900,
};

/** Difficulty scalars driven by elapsed run time (seconds). */
export function difficulty(t) {
  const m = t / 60;
  return {
    hpMul: 1 + m * 0.34 + Math.pow(m, 1.7) * 0.035,
    dmgMul: 1 + m * 0.16,
    speedMul: 1 + Math.min(0.45, m * 0.035),
    countMul: 1 + m * 0.34,
    xpMul: 1 + m * 0.1,
  };
}
