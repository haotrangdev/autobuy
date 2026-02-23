'use strict';

const DEFAULT_OPTS = {
  minDelay:       50,
  maxDelay:       30_000,
  backoffFactor:  2.0,
  recoveryFactor: 0.85,
  recoveryAfter:  5,
  pauseThreshold: 5,
  pauseWindow:    60_000,
  pauseDuration:  120_000,
};

class AccountLimiter {
  constructor(key, baseDelay, opts = {}) {
    this.key          = key;
    this.opts         = { ...DEFAULT_OPTS, ...opts };
    this.baseDelay    = baseDelay;
    this.currentDelay = baseDelay;
    this.consecutive  = 0;
    this._429hist     = [];   // timestamps
    this.pausedUntil  = 0;
    this.totalHits    = 0;
    this.totalSuccess = 0;
  }

  isPaused()        { return Date.now() < this.pausedUntil; }
  pauseRemaining()  { return Math.max(0, this.pausedUntil - Date.now()); }

  onSuccess() {
    this.totalSuccess++;
    if (++this.consecutive >= this.opts.recoveryAfter) {
      this.currentDelay = Math.max(this.opts.minDelay, Math.round(this.currentDelay * this.opts.recoveryFactor));
      this.consecutive  = 0;
    }
  }

  on429() {
    this.totalHits++;
    this.consecutive  = 0;
    const now         = Date.now();
    this._429hist.push(now);
    this._429hist = this._429hist.filter(t => now - t < this.opts.pauseWindow);
    this.currentDelay = Math.min(this.opts.maxDelay, Math.round(this.currentDelay * this.opts.backoffFactor));
    if (this._429hist.length >= this.opts.pauseThreshold) {
      this.pausedUntil = now + this.opts.pauseDuration;
      this._429hist    = [];
    }
  }

  getDelay(jitter = 0) {
    return this.currentDelay + (jitter ? Math.floor(Math.random() * jitter) : 0);
  }

  healthScore() {
    if (this.isPaused()) return 0;
    return Math.round((1 - this.currentDelay / this.opts.maxDelay) * 100);
  }

  toJSON() {
    return {
      key:            this.key,
      currentDelay:   this.currentDelay,
      health:         this.healthScore(),
      paused:         this.isPaused(),
      pauseRemaining: this.pauseRemaining(),
      totalHits:      this.totalHits,
      totalSuccess:   this.totalSuccess,
      recent429s:     this._429hist.length,
    };
  }
}

class AdaptiveLimiterPool {
  constructor(keys, baseDelay, opts = {}) {
    this._limiters = new Map(keys.map(k => [k, new AccountLimiter(k, baseDelay, opts)]));
  }

  get(key) {
    if (!this._limiters.has(key)) this._limiters.set(key, new AccountLimiter(key, 800));
    return this._limiters.get(key);
  }

  healthyKeys() {
    return [...this._limiters.entries()]
      .filter(([, l]) => !l.isPaused())
      .sort(([, a], [, b]) => b.healthScore() - a.healthScore())
      .map(([k]) => k);
  }

  pausedKeys()  { return [...this._limiters.entries()].filter(([, l]) => l.isPaused()).map(([k]) => k); }
  snapshot()    { return [...this._limiters.values()].map(l => l.toJSON()); }
}

module.exports = { AccountLimiter, AdaptiveLimiterPool };
