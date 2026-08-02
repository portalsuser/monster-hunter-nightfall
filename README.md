# Monster Hunter: Nightfall

A horde-survivor hunt through a dark forest, built with **three.js** for the
**Portals** platform. You are a monster hunter with a horned helm, a torn cloak
and a lantern on your hip. You start with nothing but your fists. Everything
else you take off the monsters you kill.

```
WASD / arrows / touch stick   move          (weapons fire on their own)
1 2 3                          pick an enhancement
Esc / P                        pause
M                              mute
```

---

## The loop

- **Fists first.** Your only starting weapon. Swings auto-target the nearest
  monster, so you can keep running while you fight.
- **Monster parts are XP.** Everything you kill drops them. Collect enough and
  you level up.
- **Everything ranks to 20.** Every level up offers three cards. Each weapon
  and each passive levels independently up to rank 20; you can carry 6 weapons
  and 6 passives at once, so a run tops out at 240 enhancements. Ranks 1-5 are
  hand-written milestones; past that a weapon keeps gaining damage and shedding
  cooldown.
- **A boss every 3 minutes.** It drops a large hoard of parts, a fistful of
  health, and a guaranteed **bonus enhancement**.
- **Chests** appear as you run. Break them by walking into them or hitting them.
  Inside: monster parts (~62%), health (~30%), or — rarely (~3.5%) — a free
  level up.

Difficulty scales continuously with elapsed time: monster health, damage, speed
and spawn density all climb, and new monster types unlock on a schedule.

## Weapons

| | Weapon | What it does |
|---|---|---|
| ✊ | **Warded Fists** | Auto-targeted arc strikes. At rank 5, every 4th swing releases a shockwave. |
| 🗡️ | **Throwing Knives** | Piercing knives toward the horde. Up to 5 in a spread. |
| ⚔️ | **Hunter's Blade** | Heavy sweeping slash; becomes a full 360° whirlwind. |
| ✝️ | **Silver Cross** | Flies out, pierces everything, returns to you. Sears at rank 5. |
| 🧪 | **Holy Water** | Lobbed flasks that shatter into lingering consecrated pools. |
| 🔥 | **Ember Pyre** | Ring of fire around you; applies burn, erupts in a nova at rank 5. |
| 🌀 | **Whetstone Fangs** | Up to 7 daggers orbiting you. |
| ⚡ | **Storm Sigil** | Lightning on nearby monsters. Chains, then stuns. |
| 🪤 | **Bear Traps** | Iron traps that root and maul. They explode at rank 5. |
| 💨 | **Warding Censer** | Pulsing smoke that damages and shoves monsters away. |
| 🌙 | **Moon Glaive** | Great crescent blade; seeks targets at rank 4. |
| ❄️ | **Frost Vial** | Freezes a bloom of enemies. Frozen targets take double damage at rank 5. |
| 🐺 | **Spirit Hound** | Up to 3 spectral wolves that hunt independently. |

Plus 11 passives: Might, Alacrity, Swiftshod, Ironhide, Vigor, Lodestone, Wide
Sweep, Keen Edge, Bloodhound, Slow Mending, and Second Wind (a revive).

## Monsters

Eight trash types unlock over time — Grotlings, Gloomwolves, Nightwings,
Widows (which spawn in clusters), Bonegnashers, Corpse Lights (ranged),
Revenants, and Shriekers (which detonate on death).

Four bosses cycle with escalating stats: **Elder Treant** (ground slam),
**Blight Wyrm** (charge), **Wraith Lord** (projectile volley + summons), and
the **Hollow Chimera**, which does all three.

---

## Running it

The game is plain ES modules — no build step, no bundler.

```bash
npm start          # serves on http://localhost:5173
```

Any static server works. It **must** be served over HTTP: browsers refuse to
load ES modules from `file://`.

### three.js

`index.html` prefers `vendor/three.module.js` and falls back to a CDN when that
file is absent, so the game runs immediately after cloning. Before publishing,
vendor it so the bundle has no external runtime dependency:

```bash
npm run vendor     # -> vendor/three.module.js (gitignored)
```

---

## Publishing to Portals

```bash
npm run bundle     # -> dist/monster-hunter-nightfall.zip
```

Upload that zip. Portals injects and manages `_portals/sdk.js` itself during
processing — the repo deliberately does not contain it, and the `<script>` tag
in `index.html` 404s harmlessly when you run locally.

### SDK integration

`src/portals.js` wraps the SDK and degrades gracefully when it is absent, so the
same build runs on Portals, on a plain static host, and on localhost:

| Portals API | Used for |
|---|---|
| `Portals.ready()` | Boot handshake; reports `standalone` vs `room` context. |
| `Portals.getPlayer()` / `identity.onChange()` | Sign-in state shown on the title card. |
| `Portals.saveState()` / `loadState()` | Best score, best time, lifetime kills, bosses felled. Falls back to `localStorage`. |
| `Portals.submitScore()` | Posted on death (requires sign-in). |
| `Portals.getLeaderboard()` | Top 10, shown on the results screen. |

Every call is timeout-guarded and wrapped — a Portals outage degrades the game
to local play rather than breaking it. The saved payload is six integers, far
under the SDK's 64 KB ceiling, and no tokens or credentials are ever stored.

Score is `time×10 + kills×2 + parts + bosses×500 + enhancements×50`.

---

## Testing

```bash
npm test
```

`tools/smoke.mjs` boots the real game headlessly against `tools/mock-three.mjs`
and a minimal DOM, then simulates roughly 20 minutes of play at a fixed
timestep: horde spawning, all 13 weapons and 11 passives at max rank, four boss
cycles, 400 chest breaks, the level-up cap, death, and restart.

It asserts on frame exceptions, `console.error`, unhandled rejections, pool
leaks, `NaN` positions, instanced-draw overruns, upgrade-slot caps, clean state
after restart, and a frame-time budget. It also enforces two balance guards:
the first minute must be survivable with fists alone, and must yield at least
two level ups.

The mock exists because the sandbox this was written in had no network access to
npm or any CDN. It implements the exact slice of the three.js API the game uses,
with the same signatures and mutation semantics, so it exercises *our* logic
faithfully — it caught the auto-aim problem, a `NaN` knockback path, and the
fact that the player originally outran every monster in the game.

## Layout

```
index.html          boot + import map (local three.js, CDN fallback)
styles.css          all UI
src/
  main.js           game loop, state machine, camera, Portals wiring
  config.js         every tunable number
  world.js          forest tiles, lighting, fog, mist, fireflies
  player.js         the hunter model, movement, stats
  enemies.js        monster types, instanced horde rendering, bosses
  weapons.js        all 13 weapons + 11 passives
  upgrades.js       level-up card generation
  pickups.js        monster parts, health, chests
  vfx.js            particles, rings, damage numbers
  hud.js            DOM UI
  audio.js          WebAudio synthesis — zero audio assets
  input.js          keyboard, gamepad, touch stick
  portals.js        SDK wrapper with local fallback
tools/
  smoke.mjs         headless test
  mock-three.mjs    three.js stand-in for the test
  tribudget.mjs     analytic triangle budget
  count-three.mjs   three.js stand-in that reports real triangle counts
  vendor-three.sh   fetch three.js into vendor/
  bundle.sh         build the Portals zip
push.sh             push this repo to GitHub
```

## Performance

The horde is drawn with one `InstancedMesh` per body part per monster type, so
300 wolves cost 4 draw calls rather than 1,200 objects. Forest tiles recycle
around the player with a seeded PRNG. Every projectile, particle, drop and
ground effect is pooled. Target lookups go through a spatial hash rather than
scanning the enemy list.

Measured by the smoke test at late-game density: **~0.5 ms/frame** of simulation
with 99 live monsters and every weapon firing.

GPU cost is budgeted analytically instead, because the headless test cannot
rasterise anything. `npm run tris` walks the real geometry constructors through
a counting stand-in and reports per-monster and whole-frame totals:

```
npm run tris   # currently ~1.46M triangles/frame incl. the shadow pass, 73% of budget
```

## License

MIT.
