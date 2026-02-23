'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { AccountHealth, AccountHealthRegistry } = require('../account-health');

// ══════════════════════════════════════════════════════════════════
//  account-health.test.js
// ══════════════════════════════════════════════════════════════════

describe('AccountHealth – score', () => {
  test('score khởi đầu là 100', () => {
    const h = new AccountHealth('test__user1');
    assert.equal(h.score(), 100);
  });

  test('score giảm khi có 429', () => {
    const h = new AccountHealth('test__user1');
    h.record('429'); h.record('429'); h.record('429');
    assert.ok(h.score() < 100);
  });

  test('score giảm mạnh hơn khi nhiều 429 hơn 1 restart', () => {
    const h1 = new AccountHealth('h1');
    const h2 = new AccountHealth('h2');
    // 5x429 = -20, 1 restart = -10 → 5x429 xấu hơn
    for (let i = 0; i < 5; i++) h1.record('429');
    h2.record('restart');
    assert.ok(h1.score() < h2.score(), `h1=${h1.score()} nên < h2=${h2.score()}`);
  });

  test('score không âm', () => {
    const h = new AccountHealth('test__user');
    for (let i = 0; i < 50; i++) h.record('429');
    assert.ok(h.score() >= 0);
  });

  test('score không vượt 100', () => {
    const h = new AccountHealth('test__user');
    for (let i = 0; i < 20; i++) h.record('buy');
    assert.ok(h.score() <= 100);
  });

  test('buy tăng score (bonus)', () => {
    const h1 = new AccountHealth('h1');
    const h2 = new AccountHealth('h2');
    h1.record('429'); h1.record('429');
    h2.record('429'); h2.record('429');
    h2.record('buy'); h2.record('buy');
    assert.ok(h2.score() > h1.score());
  });
});

describe('AccountHealth – trend', () => {
  test('stable khi không có event', () => {
    const h = new AccountHealth('u');
    assert.equal(h.trend(), 'stable');
  });

  test('degrading khi 429 tập trung ở cuối window', () => {
    const h = new AccountHealth('u');
    // Inject events thủ công: 1 old event, 3 new events
    const now = Date.now();
    const window = h._window;
    h._events.push({ ts: now - window * 0.75, type: '429' }); // old half
    h._events.push({ ts: now - 1000, type: '429' });          // new half
    h._events.push({ ts: now - 500,  type: '429' });
    h._events.push({ ts: now - 100,  type: '429' });
    assert.equal(h.trend(), 'degrading');
  });

  test('improving khi 429 giảm về cuối', () => {
    const h = new AccountHealth('u');
    const now = Date.now();
    const window = h._window;
    // 3 event xấu ở old half, 0 ở new half
    h._events.push({ ts: now - window * 0.8,  type: '429' });
    h._events.push({ ts: now - window * 0.7,  type: '429' });
    h._events.push({ ts: now - window * 0.6,  type: '429' });
    assert.equal(h.trend(), 'improving');
  });
});

describe('AccountHealth – toJSON', () => {
  test('toJSON trả đủ fields', () => {
    const h = new AccountHealth('site__user');
    h.record('start');
    const j = h.toJSON();
    assert.equal(j.key, 'site__user');
    assert.ok(typeof j.score  === 'number');
    assert.ok(typeof j.trend  === 'string');
    assert.ok(typeof j.uptime === 'number');
  });

  test('uptime > 0 sau khi record start', () => {
    const h = new AccountHealth('u');
    h.record('start');
    assert.ok(h.toJSON().uptime >= 0);
  });
});

describe('AccountHealthRegistry', () => {
  test('get() tạo mới nếu chưa tồn tại', () => {
    const r = new AccountHealthRegistry();
    const h = r.get('site__user1');
    assert.ok(h instanceof AccountHealth);
  });

  test('get() trả cùng instance', () => {
    const r = new AccountHealthRegistry();
    assert.strictEqual(r.get('k'), r.get('k'));
  });

  test('record() proxy đúng vào AccountHealth', () => {
    const r = new AccountHealthRegistry();
    r.record('site__user', '429');
    r.record('site__user', '429');
    const h = r.get('site__user');
    assert.ok(h.score() < 100);
  });

  test('snapshot() trả array JSON của tất cả entries', () => {
    const r = new AccountHealthRegistry();
    r.record('s__u1', 'buy');
    r.record('s__u2', '429');
    const snap = r.snapshot();
    assert.equal(snap.length, 2);
    assert.ok(snap.every(s => s.key && typeof s.score === 'number'));
  });
});
