'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { AccountLimiter, AdaptiveLimiterPool } = require('../adaptive-limiter');

// ══════════════════════════════════════════════════════════════════
//  adaptive-limiter.test.js
// ══════════════════════════════════════════════════════════════════

describe('AccountLimiter – on429 / onSuccess', () => {
  test('on429() tăng delay', () => {
    const l = new AccountLimiter('u', 500);
    const before = l.currentDelay;
    l.on429();
    assert.ok(l.currentDelay > before);
  });

  test('on429() không vượt maxDelay', () => {
    const l = new AccountLimiter('u', 500, { maxDelay: 1000, backoffFactor: 100 });
    l.on429();
    assert.ok(l.currentDelay <= 1000);
  });

  test('onSuccess() giảm delay sau recoveryAfter lần', () => {
    const l = new AccountLimiter('u', 10000, { recoveryAfter: 3, recoveryFactor: 0.5, minDelay: 50 });
    l.on429(); // inflate delay
    const after429 = l.currentDelay;
    l.onSuccess(); l.onSuccess(); l.onSuccess(); // 3 successes → recovery
    assert.ok(l.currentDelay < after429);
  });

  test('onSuccess() không giảm dưới minDelay', () => {
    const l = new AccountLimiter('u', 100, { recoveryAfter: 1, recoveryFactor: 0.01, minDelay: 50 });
    for (let i = 0; i < 20; i++) l.onSuccess();
    assert.ok(l.currentDelay >= 50);
  });

  test('on429 reset consecutive counter', () => {
    const l = new AccountLimiter('u', 500, { recoveryAfter: 5 });
    l.onSuccess(); l.onSuccess(); // 2 successes
    l.on429();                     // reset
    assert.equal(l.consecutive, 0);
  });
});

describe('AccountLimiter – pause logic', () => {
  test('isPaused() false ban đầu', () => {
    const l = new AccountLimiter('u', 500);
    assert.ok(!l.isPaused());
  });

  test('paused sau khi 429 đủ số lần trong window', () => {
    const l = new AccountLimiter('u', 500, {
      pauseThreshold: 3,
      pauseWindow:    60000,
      pauseDuration:  5000,
    });
    l.on429(); l.on429(); l.on429();
    assert.ok(l.isPaused());
    assert.ok(l.pauseRemaining() > 0);
  });

  test('pauseRemaining() = 0 khi không paused', () => {
    const l = new AccountLimiter('u', 500);
    assert.equal(l.pauseRemaining(), 0);
  });

  test('healthScore() = 0 khi paused', () => {
    const l = new AccountLimiter('u', 500, { pauseThreshold: 1, pauseWindow: 60000, pauseDuration: 5000 });
    l.on429();
    assert.equal(l.healthScore(), 0);
  });
});

describe('AccountLimiter – getDelay / healthScore', () => {
  test('getDelay() không nhỏ hơn currentDelay khi có jitter', () => {
    const l = new AccountLimiter('u', 1000);
    for (let i = 0; i < 20; i++) {
      assert.ok(l.getDelay(200) >= 1000);
    }
  });

  test('healthScore() giảm khi delay tăng', () => {
    const l1 = new AccountLimiter('u1', 500,  { maxDelay: 1000 });
    const l2 = new AccountLimiter('u2', 1000, { maxDelay: 1000 });
    assert.ok(l1.healthScore() > l2.healthScore());
  });

  test('toJSON() trả đủ fields', () => {
    const l = new AccountLimiter('mykey', 800);
    l.on429(); l.onSuccess();
    const j = l.toJSON();
    assert.equal(j.key, 'mykey');
    assert.ok(typeof j.currentDelay  === 'number');
    assert.ok(typeof j.health        === 'number');
    assert.ok(typeof j.paused        === 'boolean');
    assert.ok(typeof j.totalHits     === 'number');
    assert.ok(typeof j.totalSuccess  === 'number');
    assert.ok(typeof j.recent429s    === 'number');
  });
});

describe('AdaptiveLimiterPool', () => {
  test('get() trả AccountLimiter', () => {
    const pool = new AdaptiveLimiterPool(['u1', 'u2'], 500);
    assert.ok(pool.get('u1') instanceof AccountLimiter);
  });

  test('get() tạo mới nếu key chưa có', () => {
    const pool = new AdaptiveLimiterPool([], 500);
    const l = pool.get('new_key');
    assert.ok(l instanceof AccountLimiter);
  });

  test('healthyKeys() loại trừ account bị pause', () => {
    const pool = new AdaptiveLimiterPool(['u1', 'u2'], 500, {
      pauseThreshold: 1, pauseWindow: 60000, pauseDuration: 10000,
    });
    pool.get('u1').on429(); // pause u1
    const healthy = pool.healthyKeys();
    assert.ok(!healthy.includes('u1'));
    assert.ok(healthy.includes('u2'));
  });

  test('healthyKeys() sort theo healthScore desc', () => {
    const pool = new AdaptiveLimiterPool(['u1', 'u2'], 500, { maxDelay: 10000 });
    // u2 bị 429 nhiều hơn → health thấp hơn
    pool.get('u2').on429(); pool.get('u2').on429();
    const keys = pool.healthyKeys();
    assert.equal(keys[0], 'u1');
  });

  test('pausedKeys() trả account đang pause', () => {
    const pool = new AdaptiveLimiterPool(['u1', 'u2'], 500, {
      pauseThreshold: 1, pauseWindow: 60000, pauseDuration: 10000,
    });
    pool.get('u1').on429();
    const paused = pool.pausedKeys();
    assert.ok(paused.includes('u1'));
    assert.ok(!paused.includes('u2'));
  });

  test('snapshot() trả array JSON của tất cả limiters', () => {
    const pool = new AdaptiveLimiterPool(['u1', 'u2', 'u3'], 500);
    const snap = pool.snapshot();
    assert.equal(snap.length, 3);
    assert.ok(snap.every(s => s.key && typeof s.health === 'number'));
  });
});
