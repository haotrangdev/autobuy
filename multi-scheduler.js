'use strict';

/**
 * multi-scheduler.js
 *
 * Per-site / per-account scheduler.
 * Allows scheduling different sites to start at different times.
 * Each schedule entry:
 *   { siteId, targetTime, prewarmSec, label }
 *
 * Extends the single-shot Scheduler concept to a multi-slot system.
 * Persists to multi-scheduler.json.
 */

const fs           = require('fs');
const EventEmitter = require('events');

const STATE_FILE   = 'multi-scheduler.json';
const TICK_MS      = 500;

class MultiScheduler extends EventEmitter {
  /**
   * @param {{ onStart, onPrewarm, onCountdown, onCancel }} callbacks
   */
  constructor(callbacks = {}) {
    super();
    this._callbacks = callbacks;
    this._slots     = [];  // [{ id, siteId, label, targetTime, prewarmSec, state }]
    this._timer     = null;
  }

  // ── Public API ────────────────────────────────────────────────

  /** Add a new scheduled slot */
  schedule({ siteId, label, targetTime, prewarmSec = 30 }) {
    // targetTime: HH:MM[:SS] or ISO string
    const resolved = this._resolveTime(targetTime);
    if (!resolved || resolved <= Date.now()) {
      return { ok: false, error: 'Thời gian không hợp lệ hoặc đã qua' };
    }
    const slot = {
      id:         `${siteId}_${Date.now()}`,
      siteId,
      label:      label || siteId,
      targetTime: resolved,
      prewarmSec,
      state:      'pending',   // pending | prewarm | fired | cancelled
    };
    this._slots.push(slot);
    this._save();
    this._ensureTimer();
    return { ok: true, slot };
  }

  /** Cancel a slot by id */
  cancel(id) {
    const slot = this._slots.find(s => s.id === id);
    if (!slot) return false;
    slot.state = 'cancelled';
    this._save();
    this._callbacks.onCancel?.({ slot });
    this.emit('cancel', slot);
    return true;
  }

  /** Remove all fired/cancelled slots */
  cleanup() {
    this._slots = this._slots.filter(s => s.state === 'pending' || s.state === 'prewarm');
    this._save();
  }

  /** Get full status (for UI) */
  getStatus() {
    return this._slots.map(s => ({
      ...s,
      remainingMs: Math.max(0, s.targetTime - Date.now()),
    }));
  }

  restore() {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // Only restore future slots
      this._slots = (data.slots || []).filter(
        s => (s.state === 'pending' || s.state === 'prewarm') && s.targetTime > Date.now()
      );
      if (this._slots.length) this._ensureTimer();
    } catch {}
  }

  // ── Internal ─────────────────────────────────────────────────

  _resolveTime(raw) {
    if (!raw) return null;
    // ISO / full datetime
    if (raw.includes('T') || raw.includes('-')) {
      const d = new Date(raw);
      return isNaN(d) ? null : d.getTime();
    }
    // HH:MM or HH:MM:SS
    const parts = raw.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    const [h, m, s = 0] = parts;
    const now = new Date();
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s, 0);
    if (candidate.getTime() <= Date.now()) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }

  _ensureTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._timer.unref?.();
  }

  _tick() {
    const now = Date.now();
    let active = false;

    for (const slot of this._slots) {
      if (slot.state === 'cancelled' || slot.state === 'fired') continue;
      active = true;
      const rem = slot.targetTime - now;

      // Countdown broadcast
      this._callbacks.onCountdown?.({ slot, remainingMs: rem });
      this.emit('countdown', { slot, remainingMs: rem });

      // Prewarm window
      const prewarmMs = slot.prewarmSec * 1000;
      if (slot.state === 'pending' && rem <= prewarmMs && rem > 0) {
        slot.state = 'prewarm';
        this._save();
        this._callbacks.onPrewarm?.({ slot });
        this.emit('prewarm', slot);
      }

      // Fire
      if (rem <= 0) {
        slot.state = 'fired';
        this._save();
        this._callbacks.onStart?.({ slot });
        this.emit('start', slot);
      }
    }

    if (!active) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _save() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ slots: this._slots }, null, 2)); } catch {}
  }
}

module.exports = { MultiScheduler };
