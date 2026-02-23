'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

// ══════════════════════════════════════════════════════════════════
//  logger.test.js
//  Logger ghi vào logs/events.jsonl (path cố định khi module load).
//  Strategy: dùng singleton logger, inject events trực tiếp vào file,
//  và test getStats() / readEvents() — đây là logic quan trọng nhất.
// ══════════════════════════════════════════════════════════════════

const LOG_DIR  = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'events.jsonl');

// Đảm bảo logs/ tồn tại
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const { Logger, logger } = require('../logger');

// Helper: inject events vào logfile bằng cách append JSON lines
function injectEvents(events) {
  const lines = events.map(e =>
    JSON.stringify({ ts: e.ts ?? new Date().toISOString(), ...e })
  ).join('\n') + '\n';
  fs.appendFileSync(LOG_FILE, lines, 'utf8');
}

// Helper: xoá log file để test sạch
function clearLog() {
  try { fs.writeFileSync(LOG_FILE, '', 'utf8'); } catch {}
}

// ── Logger instance ───────────────────────────────────────────────

describe('Logger – singleton', () => {
  test('logger là instance của Logger', () => {
    assert.ok(logger instanceof Logger);
  });
});

// ── write / shorthand methods ─────────────────────────────────────

describe('Logger – write methods', () => {
  test('write() ghi event vào file', () => {
    clearLog();
    logger.write('test_event', { foo: 'bar' });
    // Flush bằng cách đọc sau một microtask
    return new Promise(resolve => setImmediate(() => {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
      assert.ok(lines.length >= 1);
      const e = JSON.parse(lines[lines.length - 1]);
      assert.equal(e.type, 'test_event');
      assert.equal(e.foo, 'bar');
      assert.ok(e.ts);
      resolve();
    }));
  });

  test('buy() ghi đúng fields', () => {
    clearLog();
    logger.buy('site1', 'user1', 'acc123', 50000);
    return new Promise(resolve => setImmediate(() => {
      const e = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').pop());
      assert.equal(e.type, 'buy');
      assert.equal(e.site, 'site1');
      assert.equal(e.username, 'user1');
      assert.equal(e.price, 50000);
      resolve();
    }));
  });

  test('rateLimit() ghi đúng fields', () => {
    clearLog();
    logger.rateLimit('s', 'u', 5000);
    return new Promise(resolve => setImmediate(() => {
      const e = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').pop());
      assert.equal(e.type, 'rateLimit');
      assert.equal(e.cooldownMs, 5000);
      resolve();
    }));
  });

  test('engineRestart() ghi đúng fields', () => {
    clearLog();
    logger.engineRestart('s', 'u', 3);
    return new Promise(resolve => setImmediate(() => {
      const e = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').pop());
      assert.equal(e.type, 'engineRestart');
      assert.equal(e.attempt, 3);
      resolve();
    }));
  });
});

// ── readEvents() ─────────────────────────────────────────────────

describe('Logger – readEvents()', () => {
  test('bỏ qua event ngoài limitDays', () => {
    clearLog();
    const old   = { ts: new Date(Date.now() - 8 * 86400000).toISOString(), type: 'old_event' };
    const fresh = { ts: new Date().toISOString(), type: 'fresh_event' };
    injectEvents([old, fresh]);

    const events = logger.readEvents(7);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'fresh_event');
  });

  test('bỏ qua dòng JSON không hợp lệ', () => {
    clearLog();
    fs.writeFileSync(LOG_FILE,
      'NOT_JSON\n' +
      JSON.stringify({ ts: new Date().toISOString(), type: 'valid' }) + '\n',
      'utf8'
    );
    const events = logger.readEvents(7);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'valid');
  });

  test('trả [] khi file rỗng', () => {
    clearLog();
    const events = logger.readEvents(7);
    assert.equal(events.length, 0);
  });
});

// ── getStats() ────────────────────────────────────────────────────

describe('Logger – getStats()', () => {
  test('stats rỗng khi không có events', () => {
    clearLog();
    const stats = logger.getStats(1);
    assert.equal(stats.totalBuys, 0);
    assert.equal(stats.totalSpent, 0);
    assert.equal(stats.totalRateLimits, 0);
    assert.equal(stats.totalRestarts, 0);
  });

  test('đếm đúng totalBuys và totalSpent', () => {
    clearLog();
    injectEvents([
      { type: 'buy',       username: 'u', price: 10000 },
      { type: 'buy',       username: 'u', price: 20000 },
      { type: 'rateLimit', username: 'u' },
    ]);
    const stats = logger.getStats(1);
    assert.equal(stats.totalBuys, 2);
    assert.equal(stats.totalSpent, 30000);
    assert.equal(stats.totalRateLimits, 1);
  });

  test('đếm đúng totalRestarts', () => {
    clearLog();
    injectEvents([
      { type: 'engineRestart', username: 'u', attempt: 1 },
      { type: 'engineRestart', username: 'u', attempt: 2 },
    ]);
    const stats = logger.getStats(1);
    assert.equal(stats.totalRestarts, 2);
  });

  test('topBuyers sort theo buys desc', () => {
    clearLog();
    injectEvents([
      { type: 'buy', username: 'alice', price: 1000 },
      { type: 'buy', username: 'alice', price: 1000 },
      { type: 'buy', username: 'alice', price: 1000 },
      { type: 'buy', username: 'bob',   price: 1000 },
    ]);
    const stats = logger.getStats(1);
    assert.ok(stats.topBuyers.length >= 2);
    assert.equal(stats.topBuyers[0].username, 'alice');
    assert.equal(stats.topBuyers[0].buys, 3);
  });

  test('byHour chứa đúng key cho giờ hiện tại', () => {
    clearLog();
    const hour = String(new Date().getHours()).padStart(2, '0');
    injectEvents([{ type: 'buy', username: 'u', price: 5000 }]);
    const stats = logger.getStats(1);
    assert.ok(stats.byHour[hour], `byHour thiếu key "${hour}"`);
    assert.equal(stats.byHour[hour].buys, 1);
  });

  test('hourlyStock tính avgStock đúng', () => {
    clearLog();
    const hour = String(new Date().getHours()).padStart(2, '0');
    injectEvents([
      { type: 'stock', username: 'u', count: 10 },
      { type: 'stock', username: 'u', count: 20 },
    ]);
    const stats = logger.getStats(1);
    const hourEntry = stats.hourlyStock.find(h => h.hour === hour + ':00');
    assert.ok(hourEntry, `hourlyStock thiếu entry cho ${hour}:00`);
    assert.equal(hourEntry.avgStock, 15);
  });

  test('byAccount chứa đúng thông tin per account', () => {
    clearLog();
    injectEvents([
      { type: 'buy',       username: 'alice', price: 5000 },
      { type: 'rateLimit', username: 'alice' },
      { type: 'engineRestart', username: 'alice', attempt: 1 },
    ]);
    const stats = logger.getStats(1);
    const alice = stats.byAccount['alice'];
    assert.ok(alice);
    assert.equal(alice.buys, 1);
    assert.equal(alice.spent, 5000);
    assert.equal(alice.rateLimits, 1);
    assert.equal(alice.restarts, 1);
  });
});
