'use strict';

const { EventEmitter } = require('events');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const lazy = fn => { let v; return () => v !== undefined ? v : (v = (() => { try { return fn(); } catch { return null; } })()); };
const getRetryStrategy = lazy(() => require('./retry-strategy').RetryStrategy);
const getHealthReg     = lazy(() => require('./account-health').registry);

const NETWORK_CODES    = new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EPIPE']);
const NETWORK_KEYWORDS = ['socket', 'network', 'fetch failed'];

class Watchdog extends EventEmitter {
  constructor({
    maxRetries     = 10,
    baseDelay      = 3_000,
    maxDelay       = 60_000,
    jitter         = 1_000,
    resetAfter     = 300_000,
    retryStrategy,
    isFatal,
    onRestart,
    onStopped,
    healthKey,
  } = {}) {
    super();
    this.maxRetries = maxRetries;
    this.baseDelay  = baseDelay;
    this.maxDelay   = maxDelay;
    this.jitter     = jitter;
    this.resetAfter = resetAfter;
    this.isFatal    = isFatal;
    this.onRestart  = onRestart;
    this.onStopped  = onStopped;
    this._healthKey = healthKey || null;
    this.attempts   = 0;
    this.enabled    = true;

    const RS = getRetryStrategy();
    this._strategy = RS && retryStrategy
      ? RS.fromConfig({ ...retryStrategy, maxRetries: retryStrategy.maxRetries ?? maxRetries })
      : null;
    if (this._strategy) this.maxRetries = this._strategy.maxRetries;
  }

  async watch(label, fn) {
    this.attempts = 0;
    this._strategy?.reset();

    while (this.enabled) {
      const startTime = Date.now();
      try {
        await fn();
        this._log(label, 'kết thúc bình thường.');
        this.emit('done', { label });
        break;
      } catch (err) {
        if (Date.now() - startTime >= this.resetAfter) {
          this.attempts = 0;
          this._strategy?.reset();
        }

        this.attempts++;

        if (this.isFatal?.(err)) {
          this._error(label, `lỗi fatal – không retry: ${err.message}`);
          this.emit('fatal', { label, err });
          break;
        }

        const maxR = this._strategy?.maxRetries ?? this.maxRetries;
        if (this.attempts >= maxR) {
          this._error(label, `đã thử ${maxR} lần – dừng hẳn.`);
          this.emit('stopped', { label, reason: 'max_retries', err });
          this.onStopped?.({ label, reason: 'max_retries', err });
          getHealthReg()?.record(this._healthKey, 'stop');
          break;
        }

        const delay     = this._strategy ? this._strategy.nextDelay() : this._calcDelay(this.attempts);
        const isNetwork = this._isNetworkError(err);
        this._error(label, `crash (lần ${this.attempts}/${maxR}): ${err.message}`);
        this._log(label, `${isNetwork ? 'Lỗi mạng' : 'Lỗi không xác định'} – chờ ${(delay / 1000).toFixed(1)}s...`);

        getHealthReg()?.record(this._healthKey, 'restart');
        this.emit('restart', { label, attempt: this.attempts, delay, err, isNetwork });
        this.onRestart?.(this.attempts, delay, err, label);
        await sleep(delay);
      }
    }
  }

  stop() { this.enabled = false; }

  static watchAll(tasks) {
    const watchdogs = tasks.map(({ label, fn, engine, options }) => {
      const wd = new Watchdog(options || {});
      return { label, wd, engine, promise: wd.watch(label, fn) };
    });

    const stopOne = entry => {
      entry.wd.stop();
      if (entry.engine && typeof entry.engine === 'object') entry.engine.forceStop = true;
    };

    return {
      results: Promise.allSettled(watchdogs.map(w => w.promise)),
      stop:    label => watchdogs.find(w => w.label === label) && stopOne(watchdogs.find(w => w.label === label)),
      stopAll: () => watchdogs.forEach(stopOne),
      get:     label => watchdogs.find(w => w.label === label)?.wd,
    };
  }

  _calcDelay(attempt) {
    return Math.round(Math.min(this.baseDelay * 2 ** (attempt - 1), this.maxDelay) + Math.random() * this.jitter);
  }

  _isNetworkError(err) {
    if (err.code && NETWORK_CODES.has(err.code)) return true;
    const msg = err.message?.toLowerCase() ?? '';
    return NETWORK_KEYWORDS.some(kw => msg.includes(kw));
  }

  _log(label, msg)   { console.log(`[watchdog:${label}] ${msg}`); }
  _error(label, msg) { console.error(`[watchdog:${label}] ${msg}`); }
}

module.exports = { Watchdog };
