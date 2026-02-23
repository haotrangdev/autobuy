'use strict';

class RetryStrategy {
  constructor(fn, opts = {}) {
    this._fn        = fn;
    this.opts       = opts;
    this._attempt   = 0;
    this.maxRetries = opts.maxRetries ?? 10;
    this.name       = opts.name ?? 'custom';
  }

  nextDelay()       { return this._fn(++this._attempt, this.opts); }
  reset()           { this._attempt = 0; }
  hasRetriesLeft()  { return this._attempt < this.maxRetries; }
  get attempt()     { return this._attempt; }

  toJSON() {
    return { name: this.name, attempt: this._attempt, maxRetries: this.maxRetries, opts: this.opts };
  }

  // ── Factories ──────────────────────────────────────────────────
  static linear({ baseDelay = 3_000, increment = 1_000, maxDelay = 60_000, jitter = 0, ...opts } = {}) {
    return new RetryStrategy(
      attempt => Math.min(baseDelay + increment * (attempt - 1), maxDelay) + Math.floor(Math.random() * jitter),
      { baseDelay, increment, maxDelay, jitter, ...opts, name: 'linear' }
    );
  }

  static exponential({ baseDelay = 3_000, factor = 2, maxDelay = 60_000, jitter = 0, ...opts } = {}) {
    return new RetryStrategy(
      attempt => Math.min(baseDelay * factor ** (attempt - 1), maxDelay) + Math.floor(Math.random() * jitter),
      { baseDelay, factor, maxDelay, jitter, ...opts, name: 'exponential' }
    );
  }

  static stepped(steps = [3_000, 6_000, 15_000, 30_000, 60_000], opts = {}) {
    return new RetryStrategy(
      attempt => steps[Math.min(attempt - 1, steps.length - 1)],
      { ...opts, steps, name: 'stepped' }
    );
  }

  static fromConfig(cfg = {}) {
    const type = cfg.type || 'exponential';
    if (type === 'linear')  return RetryStrategy.linear(cfg);
    if (type === 'stepped') return RetryStrategy.stepped(cfg.steps, cfg);
    return RetryStrategy.exponential(cfg);
  }
}

const PRESETS = {
  aggressive: { type: 'exponential', baseDelay: 1_000, factor: 1.5, maxDelay: 30_000, maxRetries: 15, jitter: 500 },
  default:    { type: 'exponential', baseDelay: 3_000, factor: 2.0, maxDelay: 60_000, maxRetries: 10, jitter: 0   },
  patient:    { type: 'linear',      baseDelay: 5_000, increment: 2_000, maxDelay: 60_000, maxRetries: 8           },
  stepped:    { type: 'stepped',     steps: [2_000, 5_000, 10_000, 20_000, 60_000], maxRetries: 10                 },
};

module.exports = { RetryStrategy, PRESETS };
