'use strict';

/**
 * session-health.js
 *
 * Proactively monitors session health per account.
 * - Periodically pings a lightweight endpoint to verify session is alive
 * - Detects token expiry before a real buy attempt fails
 * - Emits 'expired' event so the engine can refresh proactively
 * - Emits 'healthy' event when session is confirmed alive
 *
 * Usage:
 *   const monitor = new SessionHealthMonitor(account, pingFn, refreshFn, opts);
 *   monitor.on('expired',  () => engine.refreshSession());
 *   monitor.on('healthy',  () => { ... });
 *   monitor.on('error',    (err) => { ... });
 *   monitor.start();
 *   monitor.stop();
 */

const EventEmitter = require('events');

const DEFAULT_OPTS = {
  pingIntervalMs:  60000,   // how often to ping (ms)
  timeoutMs:       8000,    // ping request timeout
  maxFailures:     2,       // consecutive failures before 'expired'
  backoffOnFail:   true,    // reduce interval after failure
};

class SessionHealthMonitor extends EventEmitter {
  /**
   * @param {object}   account     - { username, label }
   * @param {Function} pingFn      - async () => boolean (true = alive)
   * @param {Function} refreshFn   - async () => void (refresh token)
   * @param {object}   [opts]
   */
  constructor(account, pingFn, refreshFn, opts = {}) {
    super();
    this.account      = account;
    this._ping        = pingFn;
    this._refresh     = refreshFn;
    this._opts        = { ...DEFAULT_OPTS, ...opts };
    this._failures    = 0;
    this._timer       = null;
    this._healthy     = true;
    this._refreshing  = false;
    this.lastChecked  = null;
    this.lastStatus   = null;
  }

  get isHealthy() { return this._healthy; }

  start() {
    if (this._timer) return;
    // First check after a short delay (don't block startup)
    setTimeout(() => this._check(), 5000);
    this._timer = setInterval(() => this._check(), this._opts.pingIntervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async _check() {
    if (this._refreshing) return; // avoid concurrent refreshes
    this.lastChecked = Date.now();

    let alive = false;
    try {
      const timeoutP = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('ping timeout')), this._opts.timeoutMs)
      );
      alive = await Promise.race([this._ping(), timeoutP]);
    } catch (err) {
      this.emit('error', err);
    }

    this.lastStatus = alive ? 'healthy' : 'failed';

    if (alive) {
      this._failures = 0;
      if (!this._healthy) {
        this._healthy = true;
        this.emit('healthy', this.account);
      }
    } else {
      this._failures++;
      this._healthy = false;
      if (this._failures >= this._opts.maxFailures) {
        this._failures = 0;
        await this._doRefresh();
      }
    }
  }

  async _doRefresh() {
    this._refreshing = true;
    this.emit('expired', this.account);
    try {
      await this._refresh();
      this._healthy = true;
      this.emit('healthy', this.account);
    } catch (err) {
      this.emit('error', err);
    } finally {
      this._refreshing = false;
    }
  }

  toJSON() {
    return {
      username:    this.account.username,
      label:       this.account.label || this.account.username,
      healthy:     this._healthy,
      lastChecked: this.lastChecked,
      lastStatus:  this.lastStatus,
      failures:    this._failures,
    };
  }
}

module.exports = { SessionHealthMonitor };
