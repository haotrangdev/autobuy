'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { SessionHealthMonitor } = require('../session-health');

// ══════════════════════════════════════════════════════════════════
//  session-health.test.js
// ══════════════════════════════════════════════════════════════════

const ACC = { username: 'user1', label: 'Test Acc' };

describe('SessionHealthMonitor – state khởi đầu', () => {
  test('isHealthy = true ban đầu', () => {
    const m = new SessionHealthMonitor(ACC, async () => true, async () => {});
    assert.ok(m.isHealthy);
    m.stop();
  });

  test('lastChecked = null ban đầu', () => {
    const m = new SessionHealthMonitor(ACC, async () => true, async () => {});
    assert.equal(m.lastChecked, null);
    m.stop();
  });
});

describe('SessionHealthMonitor – _check() healthy', () => {
  test('emit "healthy" sau ping thành công', async () => {
    let emitted = false;
    const m = new SessionHealthMonitor(ACC, async () => true, async () => {});
    m.on('healthy', () => { emitted = true; });
    // Force check thủ công (không dùng timer)
    m._healthy = false; // giả lập đang unhealthy
    await m._check();
    assert.ok(emitted);
    m.stop();
  });

  test('không emit "healthy" nếu đã healthy rồi', async () => {
    let count = 0;
    const m = new SessionHealthMonitor(ACC, async () => true, async () => {});
    m.on('healthy', () => { count++; });
    await m._check();
    await m._check();
    assert.equal(count, 0); // đã healthy từ đầu, không emit thêm
    m.stop();
  });

  test('lastChecked được cập nhật sau _check()', async () => {
    const m = new SessionHealthMonitor(ACC, async () => true, async () => {});
    await m._check();
    assert.ok(m.lastChecked !== null);
    assert.ok(m.lastChecked <= Date.now());
    m.stop();
  });

  test('lastStatus = "healthy" sau ping ok', async () => {
    const m = new SessionHealthMonitor(ACC, async () => true, async () => {});
    await m._check();
    assert.equal(m.lastStatus, 'healthy');
    m.stop();
  });
});

describe('SessionHealthMonitor – _check() failure', () => {
  test('isHealthy = false sau ping thất bại (chưa tới maxFailures)', async () => {
    // maxFailures=2: sau 1 lần fail chưa trigger refresh, isHealthy vẫn false
    const m = new SessionHealthMonitor(ACC, async () => false, async () => {}, { maxFailures: 2 });
    await m._check(); // failure 1: chưa đạt max, không refresh
    assert.ok(!m.isHealthy);
    m.stop();
  });

  test('lastStatus = "failed" khi ping thất bại', async () => {
    const m = new SessionHealthMonitor(ACC, async () => false, async () => {});
    await m._check();
    assert.equal(m.lastStatus, 'failed');
    m.stop();
  });

  test('emit "expired" sau maxFailures lần thất bại liên tiếp', async () => {
    let expiredEmitted = false;
    const m = new SessionHealthMonitor(
      ACC,
      async () => false,
      async () => {},
      { maxFailures: 2 }
    );
    m.on('expired', () => { expiredEmitted = true; });
    await m._check(); // failure 1
    await m._check(); // failure 2 → trigger expired
    assert.ok(expiredEmitted);
    m.stop();
  });

  test('refreshFn được gọi sau expired', async () => {
    let refreshCalled = false;
    const m = new SessionHealthMonitor(
      ACC,
      async () => false,
      async () => { refreshCalled = true; },
      { maxFailures: 1 }
    );
    await m._check();
    assert.ok(refreshCalled);
    m.stop();
  });

  test('emit "error" khi ping throw', async () => {
    let errorEmitted = false;
    const m = new SessionHealthMonitor(
      ACC,
      async () => { throw new Error('network error'); },
      async () => {}
    );
    m.on('error', () => { errorEmitted = true; });
    await m._check();
    assert.ok(errorEmitted);
    m.stop();
  });
});

describe('SessionHealthMonitor – timeout', () => {
  test('emit "error" khi ping timeout', async () => {
    let errorEmitted = false;
    const slowPing = () => new Promise(r => setTimeout(r, 500, true)); // 500ms
    const m = new SessionHealthMonitor(
      ACC,
      slowPing,
      async () => {},
      { timeoutMs: 50, maxFailures: 10 } // timeout nhỏ hơn ping time
    );
    m.on('error', () => { errorEmitted = true; });
    await m._check();
    assert.ok(errorEmitted);
    m.stop();
  });
});

describe('SessionHealthMonitor – start/stop', () => {
  test('start() không throw', () => {
    const m = new SessionHealthMonitor(ACC, async () => true, async () => {}, { pingIntervalMs: 99999 });
    assert.doesNotThrow(() => m.start());
    m.stop();
  });

  test('stop() dừng timer', () => {
    const m = new SessionHealthMonitor(ACC, async () => true, async () => {}, { pingIntervalMs: 99999 });
    m.start();
    m.stop();
    assert.equal(m._timer, null);
  });

  test('start() idempotent — gọi 2 lần không lỗi', () => {
    const m = new SessionHealthMonitor(ACC, async () => true, async () => {}, { pingIntervalMs: 99999 });
    m.start(); m.start();
    m.stop();
  });
});

describe('SessionHealthMonitor – toJSON()', () => {
  test('trả đủ fields', async () => {
    const m = new SessionHealthMonitor(ACC, async () => true, async () => {});
    await m._check();
    const j = m.toJSON();
    assert.equal(j.username, 'user1');
    assert.equal(j.label, 'Test Acc');
    assert.ok(typeof j.healthy     === 'boolean');
    assert.ok(typeof j.failures    === 'number');
    assert.ok(typeof j.lastChecked === 'number');
    m.stop();
  });
});
