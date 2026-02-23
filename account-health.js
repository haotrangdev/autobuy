'use strict';

const WINDOW_MS = 10 * 60 * 1000; // 10 min rolling window

class AccountHealth {
  constructor(key) {
    this.key    = key;
    this._events = [];
    this._startTs = null;
    this._window = WINDOW_MS;
  }

  record(type) {
    const now = Date.now();
    this._events.push({ ts: now, type });
    // Prune outside window
    const cutoff = now - this._window;
    this._events = this._events.filter(e => e.ts >= cutoff);
    if (type === 'start') this._startTs = now;
  }

  _recent() {
    const cutoff = Date.now() - this._window;
    return this._events.filter(e => e.ts >= cutoff);
  }

  score() {
    const recent = this._recent();
    const hits429  = recent.reduce((n, e) => n + (e.type === '429'     ? 1 : 0), 0);
    const restarts = recent.reduce((n, e) => n + (e.type === 'restart' ? 1 : 0), 0);
    const buys     = recent.reduce((n, e) => n + (e.type === 'buy'     ? 1 : 0), 0);
    const score = Math.max(0, 100 - hits429 * 4 - restarts * 10) + buys * 2;
    return Math.min(100, Math.round(score));
  }

  trend() {
    const now  = Date.now();
    const half = this._window / 2;
    const isBad = e => e.type === '429' || e.type === 'restart';
    const badOld = this._events.filter(e => now - e.ts >  half && isBad(e)).length;
    const badNew = this._events.filter(e => now - e.ts <= half && isBad(e)).length;
    if (badNew < badOld - 1) return 'improving';
    if (badNew > badOld + 1) return 'degrading';
    return 'stable';
  }

  toJSON() {
    return { key: this.key, score: this.score(), trend: this.trend(),
             uptime: this._startTs ? Date.now() - this._startTs : 0 };
  }
}

class AccountHealthRegistry {
  constructor() { this._map = new Map(); }
  get(key)         { if (!this._map.has(key)) this._map.set(key, new AccountHealth(key)); return this._map.get(key); }
  record(key, type){ this.get(key).record(type); }
  snapshot()       { return [...this._map.values()].map(a => a.toJSON()); }
}

const registry = new AccountHealthRegistry();
module.exports = { AccountHealth, AccountHealthRegistry, registry };
