'use strict';

// ══════════════════════════════════════════════════════════════════
//  integration.test.js
//  End-to-end flows: scheduler → fire → history → export
//  Không dùng mạng, không dùng Puppeteer
// ══════════════════════════════════════════════════════════════════

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const { RetryStrategy }          = require('../retry-strategy');
const { AccountHealth, AccountHealthRegistry } = require('../account-health');
const { AccountLimiter, AdaptiveLimiterPool }  = require('../adaptive-limiter');
const { HistoryManager }         = require('../history');
const { Scheduler }              = require('../scheduler');

function tmpFile(name) {
  return path.join(os.tmpdir(), `${name}_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
}

// ── Flow 1: Retry + Health theo dõi cùng nhau ────────────────────

describe('[Integration] RetryStrategy + AccountHealth cùng nhau', () => {
  test('429 → backoff delay + giảm health score', () => {
    const strategy = RetryStrategy.exponential({ baseDelay: 1000, factor: 2, maxDelay: 60000 });
    const health   = new AccountHealth('site1__user1');

    // Giả lập 3 vòng retry do 429
    for (let i = 0; i < 3; i++) {
      health.record('429');
      strategy.nextDelay();
    }

    // Delay phải đã tăng lên
    assert.ok(strategy.nextDelay() > 1000, 'delay không tăng sau 3 lần 429');
    // Health phải giảm
    assert.ok(health.score() < 100, 'health score không giảm sau 3 lần 429');
    // Còn retry left
    assert.ok(strategy.hasRetriesLeft());
  });

  test('mua thành công → health tăng lại', () => {
    const health = new AccountHealth('s__u');

    // Gây damage
    for (let i = 0; i < 5; i++) health.record('429');
    const damaged = health.score();

    // Recovery
    for (let i = 0; i < 5; i++) health.record('buy');
    const recovered = health.score();

    assert.ok(recovered > damaged, `recovered ${recovered} phải > damaged ${damaged}`);
  });
});

// ── Flow 2: AdaptiveLimiterPool + AccountHealthRegistry ──────────

describe('[Integration] AdaptiveLimiterPool + AccountHealthRegistry', () => {
  test('account bị pause bị loại khỏi healthyKeys()', () => {
    const pool = new AdaptiveLimiterPool(['u1', 'u2', 'u3'], 500, {
      pauseThreshold: 2, pauseWindow: 60000, pauseDuration: 60000,
    });
    const reg = new AccountHealthRegistry();

    // u1 bị 2 lần 429 → pause
    pool.get('u1').on429();
    pool.get('u1').on429();
    reg.record('s__u1', '429');
    reg.record('s__u1', '429');

    // u2 mua thành công
    pool.get('u2').onSuccess();
    reg.record('s__u2', 'buy');

    const healthy = pool.healthyKeys();
    assert.ok(!healthy.includes('u1'), 'u1 phải bị loại khỏi healthyKeys');
    assert.ok(healthy.includes('u2'));
    assert.ok(healthy.includes('u3'));

    // Snapshot health phải phản ánh trạng thái
    const snap = reg.snapshot();
    const u1health = snap.find(s => s.key === 's__u1');
    assert.ok(u1health && u1health.score < 100);
  });

  test('healthy accounts sort theo score giảm dần', () => {
    const pool = new AdaptiveLimiterPool(['u1', 'u2', 'u3'], 1000, { maxDelay: 30000 });

    // u3 tốt nhất (ít 429)
    // u1 trung bình
    // u2 xấu nhất
    pool.get('u2').on429(); pool.get('u2').on429();
    pool.get('u1').on429();

    const keys = pool.healthyKeys();
    // u3 phải đứng đầu
    assert.equal(keys[0], 'u3');
    // u2 phải đứng cuối (delay cao nhất)
    assert.equal(keys[keys.length - 1], 'u2');
  });
});

// ── Flow 3: Scheduler → fire → HistoryManager ─────────────────────

describe('[Integration] Scheduler → fire → History', () => {
  test('khi scheduler fire → add vào history → query được', async () => {
    const histFile = tmpFile('hist');
    const hist     = new HistoryManager({ file: histFile });

    let scheduled = false;
    const s = new Scheduler({
      onStart: () => {
        // Giả lập engine mua được acc khi start
        hist.add({ site: 'flashsale', username: 'bot1', price: 99000 });
        scheduled = true;
      },
    });

    const future = new Date(Date.now() + 150).toISOString();
    const result = s.schedule(future);
    assert.ok(result.ok);

    await new Promise(r => setTimeout(r, 800));

    assert.ok(scheduled, 'onStart không được gọi');
    const records = hist.getAll({ site: 'flashsale' });
    assert.equal(records.length, 1);
    assert.equal(records[0].price, 99000);

    // Export CSV phải có dữ liệu
    const csv = hist.toCSV();
    assert.ok(csv.includes('flashsale'));
    assert.ok(csv.includes('bot1'));

    // Cleanup
    try { fs.unlinkSync(histFile); } catch {}
    try { if (fs.existsSync('scheduler.json')) fs.unlinkSync('scheduler.json'); } catch {}
  });
});

// ── Flow 4: History export formats đồng nhất ─────────────────────

describe('[Integration] History multi-format export consistency', () => {
  test('CSV / JSON / JSONL / Summary đều reflect cùng data', () => {
    const histFile = tmpFile('hist_export');
    const hist     = new HistoryManager({ file: histFile });

    hist.add({ site: 'siteA', username: 'alice', price: 10000 });
    hist.add({ site: 'siteA', username: 'alice', price: 20000 });
    hist.add({ site: 'siteB', username: 'bob',   price: 15000 });

    // CSV: 3 data rows + 1 header
    const csvLines = hist.toCSV().split('\n').filter(Boolean);
    assert.equal(csvLines.length, 4); // header + 3 rows

    // JSON: count đúng
    const json = hist.toJSON();
    assert.equal(json.count, 3);
    assert.equal(json.records.length, 3);

    // JSONL: 3 lines
    const jsonlLines = hist.toJSONL().split('\n').filter(Boolean);
    assert.equal(jsonlLines.length, 3);

    // Summary: 2 accounts, totalSpent đúng
    const summary = hist.toSummary();
    assert.equal(summary.totalRecords, 3);
    assert.equal(summary.totalSpent, 45000);
    assert.equal(summary.byAccount.length, 2);

    const alice = summary.byAccount.find(a => a.username === 'alice');
    assert.equal(alice.count, 2);
    assert.equal(alice.avgPrice, 15000);
    assert.equal(alice.minPrice, 10000);
    assert.equal(alice.maxPrice, 20000);

    // Filter theo site
    const siteA = hist.toJSON({ site: 'siteA' });
    assert.equal(siteA.count, 2);

    try { fs.unlinkSync(histFile); } catch {}
  });
});

// ── Flow 5: Retry strategy exhaustion ────────────────────────────

describe('[Integration] Retry exhaustion flow', () => {
  test('sau maxRetries — hasRetriesLeft() false và delay ở ceiling', () => {
    const s = RetryStrategy.exponential({
      baseDelay: 100, factor: 2, maxDelay: 1600, maxRetries: 5,
    });

    const delays = [];
    while (s.hasRetriesLeft()) {
      delays.push(s.nextDelay());
    }

    assert.equal(delays.length, 5);
    // Delay cuối phải đạt maxDelay
    assert.equal(delays[delays.length - 1], 1600);
    assert.ok(!s.hasRetriesLeft());

    // Reset → bắt đầu lại được
    s.reset();
    assert.ok(s.hasRetriesLeft());
    assert.equal(s.nextDelay(), 100);
  });

  test('stepped strategy — correct delay sequence rồi cap', () => {
    const steps = [500, 1000, 3000, 5000];
    const s = RetryStrategy.stepped(steps, { maxRetries: 6 });

    assert.equal(s.nextDelay(), 500);
    assert.equal(s.nextDelay(), 1000);
    assert.equal(s.nextDelay(), 3000);
    assert.equal(s.nextDelay(), 5000);
    assert.equal(s.nextDelay(), 5000); // cap at last
    assert.equal(s.nextDelay(), 5000);
    assert.ok(!s.hasRetriesLeft());
  });
});

// ── Flow 6: AccountHealth trend sau nhiều events ─────────────────

describe('[Integration] AccountHealth trend transitions', () => {
  test('stable → degrading → improving', () => {
    const h = new AccountHealth('s__u');
    const now = Date.now();
    const w = h._window;

    // Inject: 3 event xấu trong old half
    h._events = [
      { ts: now - w * 0.8, type: '429' },
      { ts: now - w * 0.7, type: '429' },
      { ts: now - w * 0.6, type: '429' },
    ];
    assert.equal(h.trend(), 'improving'); // xấu trong quá khứ → đang improve

    // Thêm 5 event xấu gần đây
    for (let i = 5; i >= 1; i--) {
      h._events.push({ ts: now - i * 1000, type: '429' });
    }
    assert.equal(h.trend(), 'degrading'); // xấu gần đây nhiều hơn

    // Clear hết → stable
    h._events = [];
    assert.equal(h.trend(), 'stable');
  });
});
