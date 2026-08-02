import * as THREE from 'three';
import { CFG } from './config.js';
import { SFX, setMuted, isMuted, setMusicIntensity, unlock } from './audio.js';
import { HUD } from './hud.js';
import { Input } from './input.js';
import { Pickups } from './pickups.js';
import { Player } from './player.js';
import { PortalsBridge } from './portals.js';
import { EnemyManager } from './enemies.js';
import { VFX } from './vfx.js';
import { WeaponSystem } from './weapons.js';
import { World } from './world.js';
import { applyUpgrade, rollUpgrades } from './upgrades.js';
import { clamp, damp, formatTime } from './utils.js';

class Game {
  constructor() {
    this.state = 'boot';            // boot | menu | playing | levelup | paused | over
    this.elapsed = 0;
    this.score = 0;
    this.bossesKilled = 0;
    this.victory = false;
    this.abandoned = false;
    this.pendingLevelUps = 0;
    this.level = 1;              // game level, not the hunter's XP level
    this.levelTime = 0;          // seconds into the current level — drives difficulty
    this.levelPhase = null;      // null | 'clearing' | 'interlude'
    this.levelTimer = 0;
    this.levelSweepR = 0;
    this.levelSwept = 0;
    this.save = { bestScore: 0, bestTime: 0, totalRuns: 0, totalKills: 0, bestLevel: 0, bossesFelled: 0 };

    this._initRenderer();
    this._initScene();

    this.vfx = new VFX(this.scene);
    this.player = new Player(this.scene);
    this.enemies = new EnemyManager(this.scene, this.vfx, this);
    this.weapons = new WeaponSystem(this.scene, this.vfx, this.enemies, this.player, this);
    this.pickups = new Pickups(this.scene, this.vfx, this.player, this);
    this.hud = new HUD(this);
    this.input = new Input(this.renderer.domElement);

    this.portals = new PortalsBridge();

    this._shake = 0;
    this._hitstop = 0;
    this._hitstopCd = 0;
    this._clock = new THREE.Clock();
    this._camTarget = new THREE.Vector3();
    this._lanternPos = new THREE.Vector3();
    this._accum = 0;

    this._bindKeys();
    this._bindResize();
    this._initPortals();

    this.hud.showStart(true);
    this.state = 'menu';
    this._loop = this._loop.bind(this);
    this.renderer.setAnimationLoop(this._loop);
  }

  // ---- setup -------------------------------------------------------------

  _initRenderer() {
    const canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.5;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      CFG.CAMERA.fov, window.innerWidth / window.innerHeight, 0.5, 220
    );
    const [ox, oy, oz] = CFG.CAMERA.offset;
    this.camera.position.set(ox, oy, oz);
    this.camera.lookAt(0, 0, 0);
    this.world = new World(this.scene, this.renderer);
  }

  _bindResize() {
    const onResize = () => {
      const w = window.innerWidth, h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
  }

  _bindKeys() {
    this.input.onKey((code) => {
      if (this.state === 'levelup') {
        const n = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 }[code];
        if (n !== undefined) this.hud.pickByIndex(n);
        return;
      }
      // Pause is handled here rather than polled inside _step: while paused
      // _step does not run, so a polled toggle could never un-pause.
      if (code === 'Escape' || code === 'KeyP') {
        if (this.state === 'playing' || this.state === 'paused') this.togglePause();
        return;
      }
      if (code === 'Space' && this.state === 'playing') {
        this._tryDodge();
        return;
      }
      if (code === 'Enter' && this.state === 'menu') this.start();
      if (code === 'Enter' && this.state === 'over') this.restart();
      if (code === 'KeyM') {
        const m = this.toggleMute();
        const btn = document.getElementById('mute-btn');
        if (btn) btn.textContent = m ? '🔇' : '🔊';
      }
    });
  }

  /**
   * Space bar. `input.move` is at most one frame stale, which is exactly the
   * direction the player believed they were heading when they pressed it.
   */
  _tryDodge() {
    const p = this.player;
    const from = { x: p.pos.x, z: p.pos.z };
    if (!p.dodge(this.input.move)) return;

    SFX.slash();
    // Dust kicked up at the launch point, and a low ring that reads as the
    // push-off. Both sit at the origin so the roll visibly comes *from* there.
    this.vfx.ring(from.x, from.z, 0.4, 2.6, 0xcfe6ff, 0.34, 0.08);
    this.vfx.spawnParticles(from.x, 0.25, from.z, 14, {
      color: 0xb9c8d8, speed: 3.4, spread: 1, life: 0.42, size: 0.7, up: 1.1, grav: -5,
    });
  }

  async _initPortals() {
    const res = await this.portals.init();
    const saved = await this.portals.loadState();
    if (saved) Object.assign(this.save, saved);

    if (res.ok) {
      this.hud.setPortalsNote(
        this.portals.signedIn
          ? `Signed in — scores will be submitted (${this.portals.context})`
          : 'Playing as a guest. Sign in on Portals to save scores.'
      );
    } else {
      this.hud.setPortalsNote('Running standalone — progress saved to this browser.');
    }

    this.portals.onIdentityChange((signedIn) => {
      this.hud.setPortalsNote(signedIn
        ? 'Signed in — scores will be submitted'
        : 'Playing as a guest. Sign in on Portals to save scores.');
    });
  }

  // ---- lifecycle ---------------------------------------------------------

  start() {
    unlock();
    this.hud.showStart(false);
    this._reset();
    this.state = 'playing';
  }

  restart() {
    this.hud.showGameOver(false);
    this.hud.hideLevelUp();
    this.hud.showPause(false);
    this._reset();
    this.state = 'playing';
  }

  _reset() {
    this.elapsed = 0;
    this.score = 0;
    this.bossesKilled = 0;
    this.victory = false;
    this.abandoned = false;
    this.pendingLevelUps = 0;
    this.level = 1;
    this.levelTime = 0;
    this.levelPhase = null;
    this.levelTimer = 0;
    this.levelSweepR = 0;
    this.levelSwept = 0;
    this._shake = 0;
    this._hitstop = 0;
    this._hitstopCd = 0;

    this.enemies.reset();
    this.weapons.reset();
    this.pickups.reset();
    this.vfx.clear();

    // Fresh hunter.
    this.player.pos.set(0, 0, 0);
    this.player.vel.set(0, 0, 0);
    this.player.alive = true;
    this.player.level = 1;
    this.player.levelUps = 0;
    this.player.xp = 0;
    this.player.xpNeeded = CFG.xpForLevel(1);
    this.player.kills = 0;
    this.player.parts_collected = 0;
    this.player.invuln = 1.2;
    this.player.hurtFlash = 0;
    this.player.dodgeTime = 0;
    this.player.dodgeCd = 0;
    this.weapons._applyPassives();
    this.player.stats.hp = this.player.stats.maxHp;
    this.player.stats.stamina = this.player.stats.staminaMax;

    // You always begin with your fists and nothing else.
    this.weapons.addOrLevel('fists');

    const [ox, oy, oz] = CFG.CAMERA.offset;
    this.camera.position.set(ox, oy, oz);
    this.world.update(0.016, 0, 0, 0);
  }

  /**
   * "Abandon Hunt" from the pause menu.
   *
   * This used to call restart(), which silently began a fresh run — and from
   * the player's side that is indistinguishable from Resume, because you land
   * straight back in the forest. Abandoning should *end* the hunt: bank the
   * score, show the results and the leaderboard, exactly as if you had died.
   */
  abandon() {
    if (this.state !== 'paused' && this.state !== 'playing') return;
    this.hud.showPause(false);
    this.abandoned = true;
    this.player.alive = false;
    this.player.stats.hp = 0;
    this._gameOver();
  }

  togglePause() {
    this.input.consumePause();
    if (this.state === 'playing') {
      this.state = 'paused';
      this.hud.showPause(true);
    } else if (this.state === 'paused') {
      this.state = 'playing';
      this.hud.showPause(false);
    }
  }

  toggleMute() {
    const m = !isMuted();
    setMuted(m);
    return m;
  }

  // ---- callbacks used by subsystems --------------------------------------

  shake(amount) {
    this._shake = Math.min(1.4, this._shake + amount);
  }

  /**
   * Hit-stop: briefly crawl the simulation on a heavy connect. This is the
   * cheapest way to make a blow feel like it has mass — the frame hangs on the
   * moment of contact — and it changes no radius, damage or timing budget,
   * because the clock itself slows rather than anything being skipped.
   */
  hitstop(seconds) {
    // Rate-limited, and deliberately hard. With every weapon maxed, crits land
    // continuously — without this the duty cycle approached 100% and the whole
    // game ran in slow motion. Capped at ~10% of wall-clock time.
    if (this._hitstopCd > 0) return;
    this._hitstop = Math.min(0.05, seconds);
    this._hitstopCd = 0.5;
  }

  toast(text, color) {
    this.hud.toast(text, color);
  }

  hitPlayer(amount) {
    if (this.state !== 'playing') return;
    const dealt = this.player.damage(amount);
    if (dealt > 0) {
      SFX.playerHurt();
      this.shake(0.35);
      this.vfx.damageNumber(this.player.pos.x, 4.0, this.player.pos.z, dealt, { color: '#ff8a8a', prefix: '-' });
      if (!this.player.alive) this._gameOver();
    }
  }

  explosionHitsPlayer(x, z, radius, dmg) {
    const dx = this.player.pos.x - x, dz = this.player.pos.z - z;
    if (dx * dx + dz * dz <= radius * radius) this.hitPlayer(dmg);
  }

  onEnemyKilled(e) {
    this.player.kills++;
    this.pickups.dropParts(e.x, e.z, e.xp);
    // Occasional health drop from trash.
    if (Math.random() < 0.018) this.pickups.dropHealth(e.x, e.z, 12);
  }

  onBossSpawn(boss) {
    this.toast(`${boss.def.name} awakens`, '#ff5a4a');
    this.shake(0.8);
    setMusicIntensity(1);
  }

  onBossKilled(boss) {
    this.bossesKilled++;
    this.shake(1.0);
    setMusicIntensity(0.3);
    // A big hoard of monster parts...
    this.pickups.dropParts(boss.x, boss.z, boss.xp);
    for (let i = 0; i < 6; i++) {
      this.pickups.dropHealth(boss.x + (Math.random() - 0.5) * 3, boss.z + (Math.random() - 0.5) * 3, 20);
    }
    // ...plus the guaranteed bonus level up.
    this.grantLevelUp(boss.def.name);
    this.toast(`${boss.def.name} slain — bonus enhancement!`, '#ffd23c');
    // ...and the boss's death ends the level.
    this._beginLevelClear(boss);
  }

  // ---- levels ------------------------------------------------------------

  /**
   * The boss is down, so the level is over. Its death throws out a shockwave
   * that sweeps the field clean.
   *
   * The sweep is a growing radius rather than one instant wipe: it reads as a
   * wave rolling outward, and it spreads the particle cost over a second
   * instead of vaporising two hundred monsters in a single frame. The hunter
   * is invulnerable throughout — dying to a straggler during the victory lap
   * would be miserable, and he has no way to fight back once the field is
   * clearing.
   */
  _beginLevelClear(boss) {
    if (this.levelPhase) return;          // one clear per level, whatever else lands
    this.levelPhase = 'clearing';
    this.levelSweepR = 0;
    this.levelSwept = 0;
    this.enemies.spawnPaused = true;
    this.enemies.rewardsOff = true;
    this.player.invuln = Math.max(this.player.invuln, 99);
    this.hud.showBanner(`Level ${this.level} Cleared`, `${boss.def.name} has fallen`);
    this.vfx.ring(boss.x, boss.z, 1, 26, 0xffd23c, 1.2);
    SFX.levelUp();
  }

  /** Drives the sweep and the breather. Called from _step while a level ends. */
  _updateLevelPhase(dt) {
    if (this.levelPhase === 'clearing') {
      const prev = this.levelSweepR;
      this.levelSweepR += CFG.LEVEL.sweepSpeed * dt;
      // Only the newly-covered band needs checking, but the cost of scanning
      // the whole list is trivial next to the clarity, and enemies drift.
      this.levelSwept += this.enemies.vaporizeTrash(
        this.player.pos.x, this.player.pos.z, this.levelSweepR
      );
      // A visible front, drawn as a thin expanding ring each frame.
      if (Math.floor(prev / 6) !== Math.floor(this.levelSweepR / 6)) {
        this.vfx.ring(this.player.pos.x, this.player.pos.z,
          this.levelSweepR * 0.92, this.levelSweepR * 1.08, 0xffe9b0, 0.35, 0.12);
      }
      if (this.levelSweepR >= CFG.LEVEL.sweepMax && this.enemies.trashAlive === 0) {
        this.levelPhase = 'interlude';
        this.levelTimer = CFG.LEVEL.interlude;
        if (this.levelSwept > 0) {
          this.toast(`${this.levelSwept} monsters scattered`, '#ffe9b0');
        }
      }
      return;
    }

    // Interlude: the field is empty and the hunter gets a moment to breathe
    // and hoover up whatever the fight left on the ground.
    this.levelTimer -= dt;
    if (this.levelTimer <= 0) this._beginLevel(this.level + 1);
  }

  /** Starts a level: the horde returns and its boss clock begins. */
  _beginLevel(n) {
    this.level = n;
    this.levelTime = 0;          // every level ramps from calm, exactly like level 1
    this.levelPhase = null;
    this.levelSweepR = 0;
    // levelSwept is deliberately NOT cleared here — _beginLevelClear zeroes it
    // when the next sweep starts, so the tally survives long enough to be read
    // and reported after the level ends.
    this.enemies.spawnPaused = false;
    this.enemies.rewardsOff = false;
    this.enemies.spawnTimer = 0.6;
    this.enemies.bossTimer = CFG.BOSS_INTERVAL;
    this.player.invuln = Math.min(this.player.invuln, 2.0);   // drop the sweep's shield
    if (n > 1) {
      this.hud.showBanner(`Level ${n}`, 'The forest stirs again');
      SFX.bossSpawn();
      setMusicIntensity(0.4);
    }
  }

  collectParts(amount) {
    const scaled = Math.max(1, Math.round(amount * this.player.stats.greed));
    const gained = this.player.addXp(scaled);
    if (gained > 0) this.queueLevelUps(gained);
  }

  /** Bonus level ups (bosses, rare chests) bypass the XP bar but respect the cap. */
  grantLevelUp(source) {
    if (this.player.levelUps + this.pendingLevelUps >= CFG.MAX_LEVEL_UPS) return false;
    this.queueLevelUps(1);
    return true;
  }

  queueLevelUps(n) {
    const room = CFG.MAX_LEVEL_UPS - (this.player.levelUps + this.pendingLevelUps);
    const add = Math.max(0, Math.min(n, room));
    if (add <= 0) return;
    this.pendingLevelUps += add;
    if (this.state === 'playing') this._openLevelUp();
  }

  _openLevelUp() {
    if (this.pendingLevelUps <= 0) return;
    this.state = 'levelup';
    SFX.levelUp();
    this.vfx.ring(this.player.pos.x, this.player.pos.z, 0.5, 8, 0xffd23c, 0.8);
    const cards = rollUpgrades(this.weapons, this.player, 3);
    this.hud.showLevelUp(cards, this.pendingLevelUps, (card) => this._choose(card));
  }

  _choose(card) {
    // A pick is only valid against a queued level up. Without this, a stray
    // second fire spent another of the 20 enhancements and drove
    // pendingLevelUps negative, which silently swallowed later level ups.
    if (this.pendingLevelUps <= 0) return;

    const res = applyUpgrade(card, this.weapons, this.player);
    this.player.levelUps++;
    this.pendingLevelUps = Math.max(0, this.pendingLevelUps - 1);
    this.toast(res.label, card.color);
    if (res.gainedLevels) this.queueLevelUps(res.gainedLevels);

    this.hud.hideLevelUp();
    this.input.consumePause();
    if (this.pendingLevelUps > 0 && this.player.alive) {
      // Chain straight into the next pick.
      setTimeout(() => this._openLevelUp(), 90);
    } else {
      this.state = this.player.alive ? 'playing' : 'over';
      if (this.player.levelUps >= CFG.MAX_LEVEL_UPS) {
        this.toast('Every rank maxed — you are fully forged.', '#ffd23c');
      }
    }
  }

  async _gameOver() {
    if (this.state === 'over') return;
    this.state = 'over';
    SFX.gameOver();
    this.shake(1.2);

    // A run that banked all 20 enhancements is a finished hunt, not a failure.
    this.victory = !this.abandoned && this.player.levelUps >= CFG.MAX_LEVEL_UPS;
    this.score = this._computeScore();
    this.save.totalRuns++;
    this.save.totalKills += this.enemies.totalKills;
    this.save.bossesFelled += this.bossesKilled;
    this.save.bestScore = Math.max(this.save.bestScore, this.score);
    this.save.bestTime = Math.max(this.save.bestTime, Math.floor(this.elapsed));
    this.save.bestLevel = Math.max(this.save.bestLevel, this.player.level);

    this.hud.showResults(this, this.save.bestScore);
    this.hud.showGameOver(true);
    this.hud.showLeaderboard(null, 'Loading leaderboard…');

    await this.portals.saveState(this.save);
    const sub = await this.portals.submitScore(this.score);
    const board = await this.portals.getLeaderboard(10);
    if (board) this.hud.showLeaderboard(board);
    else if (sub.reason === 'signed-out') this.hud.showLeaderboard(null, 'Sign in on Portals to post your score.');
    else this.hud.showLeaderboard(null, 'Leaderboard unavailable outside Portals.');
  }

  _computeScore() {
    // Time is the primary axis; kills and depth are meaningful tiebreakers.
    return Math.round(
      this.elapsed * 10 +
      this.enemies.totalKills * 2 +
      this.player.parts_collected * 1 +
      this.bossesKilled * 500 +
      this.player.levelUps * 50
    );
  }

  // ---- loop --------------------------------------------------------------

  _loop() {
    const raw = this._clock.getDelta();
    // Clamp: a backgrounded tab returns a huge delta that would teleport the
    // whole horde on top of the player the instant it regains focus.
    const dt = Math.min(raw, 0.05);

    if (this.state === 'playing') {
      this._step(dt);
    } else if (this.state === 'menu') {
      // Idle camera drift on the title screen.
      this.elapsed += dt * 0.0;
      this.world.update(dt, 0, 0, performance.now() / 1000);
      this._updateCamera(dt, true);
    } else {
      // Paused / level up / game over: keep visuals alive but frozen in time.
      this.vfx.update(dt * 0.25);
      this._updateCamera(dt, false);
    }

    this.renderer.render(this.scene, this.camera);
  }

  _step(rawDt) {
    // Hit-stop scales time for everything downstream, so animation, physics and
    // the run clock all slow together and nothing desyncs.
    let dt = rawDt;
    if (this._hitstopCd > 0) this._hitstopCd = Math.max(0, this._hitstopCd - rawDt);
    if (this._hitstop > 0) {
      this._hitstop = Math.max(0, this._hitstop - rawDt);
      dt = rawDt * 0.25;
    }
    this.elapsed += dt;
    // The level clock stops while a level is being cleared, so the breather
    // never counts toward the next level's ramp.
    if (!this.levelPhase) this.levelTime += dt;

    const move = this.input.update();
    this.player.update(dt, move);

    // Dust laid down along the roll. Without a trail the hunter reads as
    // having jump-cut to a new spot rather than travelled there.
    const rolling = this.player.dodgeTime > 0;
    if (rolling) {
      this.vfx.spawnParticles(this.player.pos.x, 0.3, this.player.pos.z, 2, {
        color: 0xa8bccd, speed: 1.2, spread: 0.7, life: 0.34, size: 0.62, up: 0.5, grav: -3,
      });
    } else if (this._wasRolling) {
      // Landing: a scuff ring and a kick of dirt where he comes back up.
      this.vfx.ring(this.player.pos.x, this.player.pos.z, 0.3, 2.2, 0xbcd4e6, 0.28, 0.08);
      this.vfx.spawnParticles(this.player.pos.x, 0.2, this.player.pos.z, 9, {
        color: 0x9fb0bf, speed: 2.6, spread: 1, life: 0.38, size: 0.66, up: 1.4, grav: -6,
      });
    }
    this._wasRolling = rolling;
    this.world.update(dt, this.player.pos.x, this.player.pos.z, this.elapsed);
    this.player.lanternWorld(this._lanternPos);
    this.world.setLanternAt(this._lanternPos.x, this._lanternPos.y + 0.3, this._lanternPos.z);

    // Watchdog: a queued level up must never sit unopened. Whatever the cause
    // — a dropped callback, a grant that arrived mid-frame while the card
    // screen was already up — this guarantees the player always gets the pick
    // they earned rather than watching a full XP bar do nothing.
    if (this.pendingLevelUps > 0) {
      this._openLevelUp();
      return;
    }

    // A level ending owns the frame: the sweep runs, spawning stays off and
    // the hunter is untouchable until the next level begins.
    if (this.levelPhase) this._updateLevelPhase(dt);

    this.enemies.update(dt, this.player, this.elapsed);
    this.weapons.update(dt, this.elapsed);
    this._damageChests();
    this.pickups.update(dt, this.elapsed);
    this.vfx.update(dt);

    this._updateCamera(dt, false);
    this.hud.update(this);

    // Music swells with on-screen pressure.
    const pressure = clamp(this.enemies.enemies.length / 180, 0, 1);
    setMusicIntensity(this.enemies.bosses.length ? 1 : pressure * 0.7);
  }

  /**
   * Chests are not enemies, so weapons do not hit them through the spatial
   * hash. Instead every live area/aura the player owns gets a cheap proximity
   * check here — walking near a chest with any weapon breaks it open.
   */
  _damageChests() {
    const p = this.player.pos;
    for (const c of this.pickups.chests) {
      if (!c.alive) continue;
      const dx = c.x - p.x, dz = c.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 16) {
        // Damage scales with how invested the player is, so late-run chests
        // pop instantly instead of becoming a chore.
        const power = 8 + this.player.levelUps * 2.5;
        this.pickups.hurtChest(c, power * 0.35);
      }
    }
  }

  _updateCamera(dt, idle) {
    const [ox, oy, oz] = CFG.CAMERA.offset;
    const px = idle ? 0 : this.player.pos.x;
    const pz = idle ? 0 : this.player.pos.z;

    // Lead the camera slightly in the direction of travel.
    const leadX = idle ? 0 : clamp(this.player.vel.x * 0.35, -3, 3);
    const leadZ = idle ? 0 : clamp(this.player.vel.z * 0.35, -3, 3);

    this._camTarget.set(px + ox + leadX, oy, pz + oz + leadZ);
    this.camera.position.x = damp(this.camera.position.x, this._camTarget.x, CFG.CAMERA.lerp, dt);
    this.camera.position.y = damp(this.camera.position.y, this._camTarget.y, CFG.CAMERA.lerp, dt);
    this.camera.position.z = damp(this.camera.position.z, this._camTarget.z, CFG.CAMERA.lerp, dt);

    if (this._shake > 0) {
      this._shake = Math.max(0, this._shake - dt * CFG.CAMERA.shakeDecay);
      const s = this._shake * this._shake * 0.55;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
    }

    this.camera.lookAt(px + leadX * 0.4, 1.1, pz + leadZ * 0.4);
  }
}

// ---------------------------------------------------------------------------

function fail(msg, err) {
  console.error(msg, err);
  const el = document.getElementById('fatal');
  if (el) {
    el.classList.remove('hidden');
    el.querySelector('p').textContent = `${msg}${err ? `\n\n${err.message || err}` : ''}`;
  }
}

try {
  if (!window.WebGLRenderingContext) {
    fail('This browser does not support WebGL, which this game needs to run.');
  } else {
    window.__game = new Game();
    // Any first interaction unlocks the audio context.
    const kick = () => { unlock(); window.removeEventListener('pointerdown', kick); window.removeEventListener('keydown', kick); };
    window.addEventListener('pointerdown', kick);
    window.addEventListener('keydown', kick);
  }
} catch (err) {
  fail('The hunt failed to start.', err);
}
