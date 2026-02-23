'use strict';

/**
 * hot-reload.js
 *
 * Watches config.override.json (and optionally sites/*.json) for changes.
 * When a change is detected:
 *   - Emits 'change' event with { siteId, patch }
 *   - Optionally signals running engines to gracefully pick up new runtime keys
 *
 * Usage:
 *   const watcher = new ConfigWatcher(sites, applyOverrides);
 *   watcher.on('change', ({ siteId, patch }) => { ... });
 *   watcher.start();
 *   watcher.stop();
 */

const fs           = require('fs');
const path         = require('path');
const EventEmitter = require('events');

const OVERRIDE_FILE = 'config.override.json';
const POLL_INTERVAL = 1500; // ms

// Runtime-safe keys that can be hot-applied without engine restart
const RUNTIME_KEYS = [
  'maxPrice', 'maxBuy', 'fetchLimit',
  'retryNormal', 'retrySale', 'jitter', 'cooldownAfter429', 'emptyThreshold',
];

class ConfigWatcher extends EventEmitter {
  /**
   * @param {object[]} sites          - live site objects (will be mutated)
   * @param {Function} applyOverrides - () => void, re-applies overrides to sites
   */
  constructor(sites, applyOverrides) {
    super();
    this._sites          = sites;
    this._applyOverrides = applyOverrides;
    this._lastMtime      = null;
    this._timer          = null;
    this._subscribers    = new Map(); // siteId -> Set<engine>
  }

  /** Register an engine to receive hot updates for a siteId */
  subscribe(siteId, engine) {
    if (!this._subscribers.has(siteId)) this._subscribers.set(siteId, new Set());
    this._subscribers.get(siteId).add(engine);
  }

  /** Unregister an engine */
  unsubscribe(siteId, engine) {
    this._subscribers.get(siteId)?.delete(engine);
  }

  start() {
    if (this._timer) return;
    this._poll();
    this._timer = setInterval(() => this._poll(), POLL_INTERVAL);
    this._timer.unref?.(); // don't keep process alive
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _poll() {
    try {
      const stat = fs.statSync(OVERRIDE_FILE);
      if (this._lastMtime && stat.mtimeMs === this._lastMtime) return;
      const wasNull = this._lastMtime === null;
      this._lastMtime = stat.mtimeMs;
      if (wasNull) return; // first run — just record baseline

      const overrides = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
      this._applyOverrides();

      for (const [siteId, patch] of Object.entries(overrides)) {
        const site = this._sites.find(s => s.id === siteId);
        if (!site) continue;

        // Apply runtime-safe keys to live site object
        const runtimePatch = {};
        for (const key of RUNTIME_KEYS) {
          if (patch[key] !== undefined) {
            site[key] = patch[key];
            runtimePatch[key] = patch[key];
          }
        }

        // Notify subscribers (engines) of the change
        const engines = this._subscribers.get(siteId);
        if (engines?.size) {
          for (const engine of engines) {
            engine.onConfigUpdate?.(runtimePatch);
          }
        }

        this.emit('change', { siteId, patch: runtimePatch, site });
      }
    } catch {
      // File missing or invalid JSON — ignore
    }
  }
}

module.exports = { ConfigWatcher, RUNTIME_KEYS };
