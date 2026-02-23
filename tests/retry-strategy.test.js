'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RetryStrategy, PRESETS } = require('../retry-strategy');

// ══════════════════════════════════════════════════════════════════
//  retry-strategy.test.js
// ══════════════════════════════════════════════════════════════════

describe('RetryStrategy – linear', () => {
  test('delay tăng đều theo attempt', () => {
    const s = RetryStrategy.linear({ baseDelay: 1000, increment: 500, maxDelay: 9999 });
    assert.equal(s.nextDelay(), 1000);
    assert.equal(s.nextDelay(), 1500);
    assert.equal(s.nextDelay(), 2000);
  });

  test('delay không vượt maxDelay', () => {
    const s = RetryStrategy.linear({ baseDelay: 1000, increment: 5000, maxDelay: 3000 });
    s.nextDelay(); // 1000
    s.nextDelay(); // 6000 → capped 3000
    assert.equal(s.nextDelay(), 3000);
  });

  test('jitter làm delay >= base (không âm)', () => {
    const s = RetryStrategy.linear({ baseDelay: 1000, increment: 0, maxDelay: 9999, jitter: 200 });
    for (let i = 0; i < 20; i++) {
      const d = s.nextDelay();
      assert.ok(d >= 1000, `delay ${d} < base 1000`);
      assert.ok(d <= 1200, `delay ${d} > base+jitter 1200`);
    }
  });

  test('reset() trả attempt về 0', () => {
    const s = RetryStrategy.linear({ baseDelay: 1000, increment: 1000, maxDelay: 9999 });
    s.nextDelay(); s.nextDelay();
    assert.equal(s.attempt, 2);
    s.reset();
    assert.equal(s.attempt, 0);
    assert.equal(s.nextDelay(), 1000); // về lại ban đầu
  });

  test('hasRetriesLeft() false sau maxRetries', () => {
    const s = RetryStrategy.linear({ baseDelay: 100, maxRetries: 3 });
    assert.ok(s.hasRetriesLeft());
    s.nextDelay(); s.nextDelay(); s.nextDelay();
    assert.ok(!s.hasRetriesLeft());
  });
});

describe('RetryStrategy – exponential', () => {
  test('delay tăng theo lũy thừa', () => {
    const s = RetryStrategy.exponential({ baseDelay: 1000, factor: 2, maxDelay: 999999 });
    assert.equal(s.nextDelay(), 1000);  // 1000 * 2^0
    assert.equal(s.nextDelay(), 2000);  // 1000 * 2^1
    assert.equal(s.nextDelay(), 4000);  // 1000 * 2^2
  });

  test('delay không vượt maxDelay', () => {
    const s = RetryStrategy.exponential({ baseDelay: 1000, factor: 10, maxDelay: 5000 });
    s.nextDelay(); // 1000
    s.nextDelay(); // 10000 → capped 5000
    assert.equal(s.nextDelay(), 5000);
  });

  test('name là "exponential"', () => {
    const s = RetryStrategy.exponential();
    assert.equal(s.name, 'exponential');
  });
});

describe('RetryStrategy – stepped', () => {
  test('trả về đúng step theo attempt', () => {
    const steps = [1000, 3000, 10000];
    const s = RetryStrategy.stepped(steps);
    assert.equal(s.nextDelay(), 1000);
    assert.equal(s.nextDelay(), 3000);
    assert.equal(s.nextDelay(), 10000);
  });

  test('repeat step cuối khi vượt số steps', () => {
    const steps = [1000, 5000];
    const s = RetryStrategy.stepped(steps);
    s.nextDelay(); // 1000
    s.nextDelay(); // 5000
    assert.equal(s.nextDelay(), 5000); // lặp step cuối
    assert.equal(s.nextDelay(), 5000);
  });
});

describe('RetryStrategy – fromConfig', () => {
  test('tạo exponential từ config', () => {
    const s = RetryStrategy.fromConfig({ type: 'exponential', baseDelay: 2000, factor: 3 });
    assert.equal(s.name, 'exponential');
    assert.equal(s.nextDelay(), 2000);
    assert.equal(s.nextDelay(), 6000);
  });

  test('tạo linear từ config', () => {
    const s = RetryStrategy.fromConfig({ type: 'linear', baseDelay: 500, increment: 250 });
    assert.equal(s.name, 'linear');
    assert.equal(s.nextDelay(), 500);
    assert.equal(s.nextDelay(), 750);
  });

  test('fallback về exponential nếu type không rõ', () => {
    const s = RetryStrategy.fromConfig({ type: 'unknown', baseDelay: 1000 });
    assert.equal(s.name, 'exponential');
  });
});

describe('RetryStrategy – toJSON', () => {
  test('serialize đúng fields', () => {
    const s = RetryStrategy.linear({ baseDelay: 1000, maxRetries: 5 });
    s.nextDelay();
    const j = s.toJSON();
    assert.equal(j.name, 'linear');
    assert.equal(j.attempt, 1);
    assert.equal(j.maxRetries, 5);
    assert.ok(j.opts);
  });
});

describe('PRESETS', () => {
  test('tất cả preset tồn tại và có type', () => {
    for (const [name, cfg] of Object.entries(PRESETS)) {
      assert.ok(cfg.type, `PRESETS.${name} thiếu type`);
    }
  });

  test('aggressive có maxRetries > default', () => {
    assert.ok(PRESETS.aggressive.maxRetries > PRESETS.default.maxRetries);
  });

  test('fromConfig hoạt động với mọi preset', () => {
    for (const [name, cfg] of Object.entries(PRESETS)) {
      assert.doesNotThrow(() => RetryStrategy.fromConfig(cfg), `PRESETS.${name} fromConfig lỗi`);
    }
  });
});
