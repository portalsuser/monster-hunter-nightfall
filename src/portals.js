/**
 * Portals SDK wrapper.
 *
 * The platform injects `_portals/sdk.js` into every processed preview and
 * published bundle, so `window.Portals` only exists once the game is running on
 * Portals. Everything here degrades to localStorage when it is absent, which is
 * what happens when you open index.html straight off disk.
 *
 * Reference: https://portals.to/documentation/advanced-tooling/portals-sdk
 */

const LOCAL_KEY = 'monster-hunter-nightfall/state';
const READY_TIMEOUT = 4000;

export class PortalsBridge {
  constructor() {
    this.available = false;
    this.session = null;
    this.context = 'local';
    this.player = null;
    this.signedIn = false;
    this._listeners = [];
  }

  /** Never rejects — a Portals outage must not stop the game from running. */
  async init() {
    const P = typeof window !== 'undefined' ? window.Portals : undefined;
    if (!P || typeof P.ready !== 'function') {
      this.context = 'local';
      return { ok: false, reason: 'sdk-absent' };
    }
    try {
      this.session = await withTimeout(P.ready(), READY_TIMEOUT);
      this.available = true;
      this.context = this.session?.context || 'standalone';
      if (typeof P.getPlayer === 'function') {
        this.player = await withTimeout(Promise.resolve(P.getPlayer()), 2500).catch(() => null);
        this.signedIn = !!this.player;
      }
      if (typeof P.identity?.onChange === 'function') {
        P.identity.onChange((info) => {
          this.player = info || null;
          this.signedIn = !!info;
          this._listeners.forEach((fn) => fn(this.signedIn, this.player));
        });
      }
      return { ok: true, context: this.context };
    } catch (err) {
      console.warn('[portals] ready() failed, running locally:', err);
      this.available = false;
      this.context = 'local';
      return { ok: false, reason: String(err) };
    }
  }

  onIdentityChange(fn) {
    this._listeners.push(fn);
  }

  async requestLogin() {
    const P = window.Portals;
    if (!P?.identity?.requestLogin) return false;
    try {
      await P.identity.requestLogin();
      return true;
    } catch (err) {
      console.warn('[portals] login failed:', err);
      return false;
    }
  }

  /** Persisted progress: best score, best time, unlock-ish stats. */
  async loadState() {
    if (this.available && typeof window.Portals.loadState === 'function') {
      try {
        const s = await withTimeout(window.Portals.loadState(), 3000);
        if (s) return s;
      } catch (err) {
        console.warn('[portals] loadState failed:', err);
      }
    }
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async saveState(data) {
    // Keep the payload well under the SDK's 64 KB ceiling.
    const payload = {
      bestScore: data.bestScore | 0,
      bestTime: data.bestTime | 0,
      totalRuns: data.totalRuns | 0,
      totalKills: data.totalKills | 0,
      bestLevel: data.bestLevel | 0,
      bossesFelled: data.bossesFelled | 0,
    };
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(payload));
    } catch { /* private browsing — ignore */ }

    if (this.available && this.signedIn && typeof window.Portals.saveState === 'function') {
      try {
        await withTimeout(window.Portals.saveState(payload), 3000);
      } catch (err) {
        console.warn('[portals] saveState failed:', err);
      }
    }
    return payload;
  }

  async submitScore(score) {
    if (!this.available || typeof window.Portals.submitScore !== 'function') {
      return { ok: false, reason: 'unavailable' };
    }
    if (!this.signedIn) return { ok: false, reason: 'signed-out' };
    try {
      await withTimeout(window.Portals.submitScore(Math.max(0, Math.round(score))), 4000);
      return { ok: true };
    } catch (err) {
      console.warn('[portals] submitScore failed:', err);
      return { ok: false, reason: String(err) };
    }
  }

  async getLeaderboard(limit = 10) {
    if (!this.available || typeof window.Portals.getLeaderboard !== 'function') return null;
    try {
      const res = await withTimeout(window.Portals.getLeaderboard({ limit }), 4000);
      // The SDK returns either an array or an object wrapping one.
      if (Array.isArray(res)) return res;
      if (res && Array.isArray(res.entries)) return res.entries;
      if (res && Array.isArray(res.scores)) return res.scores;
      return null;
    } catch (err) {
      console.warn('[portals] getLeaderboard failed:', err);
      return null;
    }
  }

  quit() {
    if (this.available && typeof window.Portals.quit === 'function') {
      try { window.Portals.quit(); } catch { /* noop */ }
    }
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}
