'use strict';

const fs = require('fs');

const CONFIG_FILE = 'scheduler.json';

function loadSchedule() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (raw.targetTime && new Date(raw.targetTime) <= new Date()) {
      fs.unlinkSync(CONFIG_FILE);
      return null;
    }
    return raw;
  } catch { return null; }
}

function saveSchedule(data) {
  if (!data) { try { fs.unlinkSync(CONFIG_FILE); } catch {} return; }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function resolveTargetTime(input) {
  if (typeof input === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(input.trim())) {
    const [h, m, s = 0] = input.trim().split(':').map(Number);
    const t = new Date();
    t.setHours(h, m, s, 0);
    if (t <= new Date()) t.setDate(t.getDate() + 1);
    return t;
  }
  return new Date(input);
}

class Scheduler {
  constructor(callbacks = {}) {
    this._callbacks   = callbacks;
    this._timer       = null;
    this._fired       = false;
    this._target      = null;
    this._prewarmSec  = 30;
    this._prewarmDone = false;
  }

  schedule(targetTime, prewarmSec = 30) {
    const target = resolveTargetTime(targetTime);
    if (isNaN(target.getTime())) return { ok: false, error: 'Thời gian không hợp lệ' };

    const remainingMs = target.getTime() - Date.now();
    if (remainingMs <= 0) return { ok: false, error: 'Thời gian đã qua' };

    this.cancel(false);
    this._target      = target;
    this._prewarmSec  = prewarmSec;
    this._fired       = false;
    this._prewarmDone = false;

    saveSchedule({ targetTime: target.toISOString(), prewarmSec });
    this._timer = setInterval(() => this._tick(), 500);

    return { ok: true, targetTime: target.toISOString(), remainingMs };
  }

  cancel(notify = true) {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._target = null;
    this._fired  = false;
    saveSchedule(null);
    if (notify) this._callbacks.onCancel?.();
  }

  isScheduled() { return this._target !== null && !this._fired; }

  getStatus() {
    if (!this.isScheduled()) return null;
    return { targetTime: this._target.toISOString(), remainingMs: Math.max(0, this._target - Date.now()), prewarmSec: this._prewarmSec };
  }

  restore() {
    const saved = loadSchedule();
    return saved ? this.schedule(saved.targetTime, saved.prewarmSec ?? 30).ok : false;
  }

  _tick() {
    if (!this._target || this._fired) return;
    const remainingMs = this._target - Date.now();

    if (!this._prewarmDone && remainingMs <= this._prewarmSec * 1000 && remainingMs > 0) {
      this._prewarmDone = true;
      this._callbacks.onPrewarm?.();
    }

    if (remainingMs <= 0) {
      this._fired = true;
      clearInterval(this._timer); this._timer = null;
      saveSchedule(null);
      this._callbacks.onStart?.();
      return;
    }

    this._callbacks.onCountdown?.(remainingMs, this._target.toISOString());
  }
}

function formatCountdown(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.ceil(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(v => String(v).padStart(2, '0')).join(':');
}

module.exports = { Scheduler, formatCountdown, loadSchedule, saveSchedule };
