/**
 * Central tuning file. Everything that a designer would want to twiddle lives
 * here so the gameplay modules stay readable.
 */

export const CFG = {
  // ---- run structure -------------------------------------------------------
  // Each weapon and passive ranks to 20. With 6 weapon and 6 passive slots
  // that is 240 picks to max a build out — aspirational, not expected.
  MAX_RANK: 20,
  MAX_LEVEL_UPS: 240,
  BOSS_INTERVAL: 180,         // seconds between boss spawns (3 minutes)
  FIRST_BOSS_AT: 180,

  // Visual scale. Gameplay radii are scaled alongside these in the modules that
  // own them, so hitboxes keep matching what you can see.
  SCALE: {
    player: 2.0,     // the hunter reads as the hero of the frame
    monster: 1.35,   // trash mobs; bosses are already large and stay as-is
    reach: 1.35,     // melee arcs and auras, so they still look like they connect
  },

  // ---- player --------------------------------------------------------------
  PLAYER: {
    maxHp: 120,
    speed: 5.2,
    pickupRadius: 4.3,
    iframes: 0.62,            // invulnerability after taking a hit
    regen: 0,                 // gained via upgrades
    turnLerp: 14,
  },

  // ---- dodge + stamina -----------------------------------------------------
  // Space rolls the hunter in whatever direction he is already moving. The
  // half-second of invulnerability is the whole point of the move — long
  // enough to pass through a charging Gloomwolf, short enough that it cannot
  // be chained into permanent safety.
  // Distance matters more than it looks. At the first pass (0.24s at 3.4x) a
  // roll covered 2.8 units against the 1.0 you would have run anyway — a net
  // gain of under half the hunter's own height, which is invisible. These
  // numbers put ~6.7 units under him, clearing about 1.3 body lengths beyond
  // a normal stride, which is the point at which it reads as a dodge.
  DODGE: {
    duration: 0.34,     // seconds of travel
    speedMul: 5.6,      // multiplier on the hunter's current move speed
    iframes: 0.5,       // outlasts the roll, so the landing is still safe
    cooldown: 0.3,      // recovery after landing, so a double tap is one roll
    cost: 33,           // a third of the starting pool: three rolls from full
  },
  STAMINA: {
    base: 100,
    perRank: 30,        // Sure-Footed rank -> one more stored roll every rank
    regen: 19,          // per second; a single roll comes back in ~1.7s
    regenPerRank: 0.16, // fractional bonus per rank
    maxRank: 5,
    // Sure-Footed is deliberately scarce: about 5% of early card screens offer
    // it, rising to ~20% once owned because the upgrade bucket is small. This
    // is the chance it survives the
    // cull when a level-up screen is being rolled — see upgrades.js.
    cardChance: 0.85,
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
    treesPerTile: 24,
    rocksPerTile: 10,
    fernsPerTile: 30,
    fogColor: 0x05070c,
    fogDensity: 0.0080,
    groundColor: 0x11180f,
  },

  // ---- progression ---------------------------------------------------------
  // Monster parts needed to go from level L to L+1. The opening deliberately
  // ramps fast: the first two picks should land inside the first minute so the
  // player is never stuck with bare fists for long. The exponent is gentle
  // because ranks now run to 20 per weapon rather than 20 in total — a steep
  // curve would make anything past rank 5 unreachable.
  xpForLevel(level) {
    return Math.round(3 + level * 3 + Math.pow(level, 1.45) * 1.5);
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
  MAX_PARTICLES: 1300,
};

/** Difficulty scalars driven by elapsed run time (seconds). */
export function difficulty(t) {
  const m = t / 60;
  return {
    hpMul: 1 + m * 0.34 + Math.pow(m, 1.7) * 0.035,
    dmgMul: 1 + m * 0.16,
    speedMul: 1 + Math.min(0.45, m * 0.035),
    // Quadratic rather than linear: the 2-3 minute mark was chaotic on a
    // straight ramp. This is markedly calmer through the early game and
    // steeper than the old curve past ~15 minutes.
    countMul: 1 + m * 0.17 + m * m * 0.013,
    xpMul: 1 + m * 0.1,
  };
}
