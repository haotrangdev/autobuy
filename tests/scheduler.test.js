'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { Scheduler, formatCountdown, loadSchedule, saveSchedule } = require('../scheduler');

// ══════════════════════════════════════════════════════════════════
//  scheduler.test.js
// ══════════════════════════════════════════════════════════════════

// Patch CONFIG_FILE để test không đụng file thật
function withTempScheduler(fn) {
  // Scheduler dùng 'scheduler.json' hardcoded → tạm thời mock fs
  // Thay vào đó: test logic public API mà không cần file
  return fn();
}

// ── formatCountdown ───────────────────────────────────────────────

describe('formatCountdown()', () => {
  test('format 0 → "00:00:00"', () => {
    assert.equal(formatCountdown(0), '00:00:00');
  });

  test('format âm → "00:00:00"', () => {
    assert.equal(formatCountdown(-1000), '00:00:00');
  });

  test('format 1 giờ đúng', () => {
    assert.equal(formatCountdown(3600 * 1000), '01:00:00');
  });

  test('format 90 giây → "00:01:30"', () => {
    assert.equal(formatCountdown(90 * 1000), '00:01:30');
  });

  test('format 3661 giây → "01:01:01"', () => {
    assert.equal(formatCountdown(3661 * 1000), '01:01:01');
  });

  test('ceil partial seconds', () => {
    // 1500ms = 2 giây (ceiling)
    assert.equal(formatCountdown(1500), '00:00:02');
  });
});

// ── Scheduler.schedule() ──────────────────────────────────────────

describe('Scheduler – schedule()', () => {
  test('reject ISO time đã qua', () => {
    const s = new Scheduler();
    const past = new Date(Date.now() - 60000).toISOString();
    const r = s.schedule(past);
    assert.ok(!r.ok);
    assert.ok(r.error);
    s.cancel(false);
    // cleanup file nếu có
    try { if (fs.existsSync('scheduler.json')) fs.unlinkSync('scheduler.json'); } catch {}
  });

  test('accept ISO time tương lai', () => {
    const s = new Scheduler();
    const future = new Date(Date.now() + 60000).toISOString();
    const r = s.schedule(future);
    assert.ok(r.ok);
    assert.ok(r.remainingMs > 0);
    s.cancel(false);
    try { if (fs.existsSync('scheduler.json')) fs.unlinkSync('scheduler.json'); } catch {}
  });

  test('reject time string không hợp lệ', () => {
    const s = new Scheduler();
    const r = s.schedule('not-a-time');
    assert.ok(!r.ok);
  });

  test('isScheduled() = true sau schedule', () => {
    const s = new Scheduler();
    const future = new Date(Date.now() + 60000).toISOString();
    s.schedule(future);
    assert.ok(s.isScheduled());
    s.cancel(false);
    try { if (fs.existsSync('scheduler.json')) fs.unlinkSync('scheduler.json'); } catch {}
  });

  test('isScheduled() = false sau cancel', () => {
    const s = new Scheduler();
    const future = new Date(Date.now() + 60000).toISOString();
    s.schedule(future);
    s.cancel(false);
    assert.ok(!s.isScheduled());
    try { if (fs.existsSync('scheduler.json')) fs.unlinkSync('scheduler.json'); } catch {}
  });

  test('getStatus() trả null khi không có lịch', () => {
    const s = new Scheduler();
    assert.equal(s.getStatus(), null);
  });

  test('getStatus() trả đúng targetTime', () => {
    const s = new Scheduler();
    const future = new Date(Date.now() + 60000).toISOString();
    s.schedule(future);
    const st = s.getStatus();
    assert.ok(st);
    assert.ok(st.targetTime);
    assert.ok(st.remainingMs > 0);
    s.cancel(false);
    try { if (fs.existsSync('scheduler.json')) fs.unlinkSync('scheduler.json'); } catch {}
  });
});

// ── Scheduler – HH:MM time string ────────────────────────────────

describe('Scheduler – schedule() HH:MM string', () => {
  test('HH:MM 1 giờ tương lai → ok', () => {
    const s = new Scheduler();
    const future = new Date(Date.now() + 3600000);
    const hh = String(future.getHours()).padStart(2, '0');
    const mm = String(future.getMinutes()).padStart(2, '0');
    const r = s.schedule(`${hh}:${mm}`);
    // Có thể chuyển sang ngày mai nếu giờ đã qua, nhưng phải ok
    assert.ok(r.ok, `schedule(${hh}:${mm}) thất bại: ${r.error}`);
    s.cancel(false);
    try { if (fs.existsSync('scheduler.json')) fs.unlinkSync('scheduler.json'); } catch {}
  });
});

// ── Scheduler – onStart callback ──────────────────────────────────

describe('Scheduler – callbacks', () => {
  test('onStart() được gọi khi đến giờ', async () => {
    let called = false;
    const s = new Scheduler({ onStart: () => { called = true; } });
    // Schedule 100ms tương lai
    const future = new Date(Date.now() + 100).toISOString();
    s.schedule(future);
    await new Promise(r => setTimeout(r, 700));
    assert.ok(called, 'onStart chưa được gọi');
    try { if (fs.existsSync('scheduler.json')) fs.unlinkSync('scheduler.json'); } catch {}
  });

  test('cancel(true) gọi onCancel callback', () => {
    let cancelled = false;
    const s = new Scheduler({ onCancel: () => { cancelled = true; } });
    const future = new Date(Date.now() + 60000).toISOString();
    s.schedule(future);
    s.cancel(true);
    assert.ok(cancelled);
    try { if (fs.existsSync('scheduler.json')) fs.unlinkSync('scheduler.json'); } catch {}
  });

  test('cancel(false) không gọi onCancel', () => {
    let cancelled = false;
    const s = new Scheduler({ onCancel: () => { cancelled = true; } });
    const future = new Date(Date.now() + 60000).toISOString();
    s.schedule(future);
    s.cancel(false);
    assert.ok(!cancelled);
    try { if (fs.existsSync('scheduler.json')) fs.unlinkSync('scheduler.json'); } catch {}
  });

  test('onCountdown() được gọi trong quá trình đếm ngược', async () => {
    let countdownCalled = false;
    const s = new Scheduler({ onCountdown: () => { countdownCalled = true; }, onStart: () => {} });
    // Target 1.5s tương lai, tick interval = 500ms → tick đầu tiên ~500ms sẽ gọi onCountdown
    const future = new Date(Date.now() + 1500).toISOString();
    s.schedule(future);
    await new Promise(r => setTimeout(r, 700)); // chờ qua ít nhất 1 tick (500ms)
    assert.ok(countdownCalled, 'onCountdown chưa được gọi');
    s.cancel(false);
    try { if (fs.existsSync('scheduler.json')) fs.unlinkSync('scheduler.json'); } catch {}
  });
});
