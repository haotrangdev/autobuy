'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const { MultiScheduler } = require('../multi-scheduler');

function cleanStateFile() {
  try { if (fs.existsSync('multi-scheduler.json')) fs.unlinkSync('multi-scheduler.json'); } catch {}
}

// ══════════════════════════════════════════════════════════════════
//  multi-scheduler.test.js
// ══════════════════════════════════════════════════════════════════

describe('MultiScheduler – schedule()', () => {
  test('reject time đã qua', () => {
    cleanStateFile();
    const ms = new MultiScheduler();
    const past = new Date(Date.now() - 5000).toISOString();
    const r = ms.schedule({ siteId: 's1', targetTime: past });
    assert.ok(!r.ok);
    assert.ok(r.error);
    cleanStateFile();
  });

  test('accept time tương lai', () => {
    cleanStateFile();
    const ms = new MultiScheduler();
    const future = new Date(Date.now() + 60000).toISOString();
    const r = ms.schedule({ siteId: 's1', targetTime: future, label: 'Test' });
    assert.ok(r.ok);
    assert.ok(r.slot.id);
    assert.equal(r.slot.state, 'pending');
    ms._timer && clearInterval(ms._timer);
    cleanStateFile();
  });

  test('reject time string không hợp lệ', () => {
    const ms = new MultiScheduler();
    const r = ms.schedule({ siteId: 's1', targetTime: 'invalid' });
    assert.ok(!r.ok);
  });

  test('label fallback về siteId', () => {
    cleanStateFile();
    const ms = new MultiScheduler();
    const future = new Date(Date.now() + 60000).toISOString();
    const r = ms.schedule({ siteId: 'mysite', targetTime: future });
    assert.ok(r.ok);
    assert.equal(r.slot.label, 'mysite');
    ms._timer && clearInterval(ms._timer);
    cleanStateFile();
  });
});

describe('MultiScheduler – cancel()', () => {
  test('cancel slot đang pending', () => {
    cleanStateFile();
    const ms = new MultiScheduler();
    const future = new Date(Date.now() + 60000).toISOString();
    const r = ms.schedule({ siteId: 's', targetTime: future });
    const ok = ms.cancel(r.slot.id);
    assert.ok(ok);
    const status = ms.getStatus();
    const slot = status.find(s => s.id === r.slot.id);
    assert.equal(slot?.state, 'cancelled');
    ms._timer && clearInterval(ms._timer);
    cleanStateFile();
  });

  test('cancel id không tồn tại → false', () => {
    const ms = new MultiScheduler();
    assert.ok(!ms.cancel('nonexistent_id'));
  });

  test('onCancel callback được gọi', () => {
    cleanStateFile();
    let called = false;
    const ms = new MultiScheduler({ onCancel: () => { called = true; } });
    const future = new Date(Date.now() + 60000).toISOString();
    const r = ms.schedule({ siteId: 's', targetTime: future });
    ms.cancel(r.slot.id);
    assert.ok(called);
    ms._timer && clearInterval(ms._timer);
    cleanStateFile();
  });
});

describe('MultiScheduler – cleanup()', () => {
  test('loại bỏ fired và cancelled slots', () => {
    cleanStateFile();
    const ms = new MultiScheduler();
    const future = new Date(Date.now() + 60000).toISOString();

    // Thêm 2 slots, cancel 1
    const r1 = ms.schedule({ siteId: 's1', targetTime: future });
    const r2 = ms.schedule({ siteId: 's2', targetTime: future });
    ms.cancel(r1.slot.id);

    ms.cleanup();
    const status = ms.getStatus();
    assert.equal(status.length, 1);
    assert.equal(status[0].id, r2.slot.id);
    ms._timer && clearInterval(ms._timer);
    cleanStateFile();
  });
});

describe('MultiScheduler – getStatus()', () => {
  test('trả remainingMs > 0 cho pending slot', () => {
    cleanStateFile();
    const ms = new MultiScheduler();
    const future = new Date(Date.now() + 60000).toISOString();
    ms.schedule({ siteId: 's', targetTime: future });
    const status = ms.getStatus();
    assert.equal(status.length, 1);
    assert.ok(status[0].remainingMs > 0);
    ms._timer && clearInterval(ms._timer);
    cleanStateFile();
  });

  test('multi slots – tất cả xuất hiện trong status', () => {
    cleanStateFile();
    const ms = new MultiScheduler();
    const f1 = new Date(Date.now() + 60000).toISOString();
    const f2 = new Date(Date.now() + 90000).toISOString();
    ms.schedule({ siteId: 's1', targetTime: f1 });
    ms.schedule({ siteId: 's2', targetTime: f2 });
    assert.equal(ms.getStatus().length, 2);
    ms._timer && clearInterval(ms._timer);
    cleanStateFile();
  });
});

describe('MultiScheduler – onStart callback', () => {
  test('onStart() được gọi khi slot fired', async () => {
    cleanStateFile();
    let startedSite = null;
    const ms = new MultiScheduler({
      onStart: ({ slot }) => { startedSite = slot.siteId; },
    });
    const future = new Date(Date.now() + 100).toISOString();
    ms.schedule({ siteId: 'flash_sale', targetTime: future });
    await new Promise(r => setTimeout(r, 700));
    assert.equal(startedSite, 'flash_sale');
    cleanStateFile();
  });
});

describe('MultiScheduler – _resolveTime()', () => {
  test('parse HH:MM đúng', () => {
    const ms = new MultiScheduler();
    const future = new Date(Date.now() + 3600000);
    const hh = String(future.getHours()).padStart(2, '0');
    const mm = String(future.getMinutes()).padStart(2, '0');
    const resolved = ms._resolveTime(`${hh}:${mm}`);
    assert.ok(resolved > Date.now());
  });

  test('trả null khi input rỗng', () => {
    const ms = new MultiScheduler();
    assert.equal(ms._resolveTime(''), null);
    assert.equal(ms._resolveTime(null), null);
  });

  test('trả null khi NaN', () => {
    const ms = new MultiScheduler();
    assert.equal(ms._resolveTime('aa:bb'), null);
  });
});
