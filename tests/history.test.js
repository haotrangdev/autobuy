'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { HistoryManager } = require('../history');

// ══════════════════════════════════════════════════════════════════
//  history.test.js
// ══════════════════════════════════════════════════════════════════

// Dùng temp dir để mỗi test dùng file riêng, không ảnh hưởng nhau
function makeTempHistory(opts = {}) {
  const file = path.join(os.tmpdir(), `history_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  return new HistoryManager({ file, ...opts });
}

function cleanup(h) {
  try { if (fs.existsSync(h.file)) fs.unlinkSync(h.file); } catch {}
  try { if (fs.existsSync(h.file + '.tmp')) fs.unlinkSync(h.file + '.tmp'); } catch {}
}

// ── add() ────────────────────────────────────────────────────────

describe('HistoryManager – add()', () => {
  test('add() trả về record với đủ fields', () => {
    const h = makeTempHistory();
    const r = h.add({ site: 'site1', username: 'user1', price: 50000 });
    assert.equal(r.site, 'site1');
    assert.equal(r.username, 'user1');
    assert.equal(r.price, 50000);
    assert.ok(r.id);
    assert.ok(r.time);
    cleanup(h);
  });

  test('add() lưu vào records', () => {
    const h = makeTempHistory();
    h.add({ site: 's', username: 'u', price: 100 });
    assert.equal(h.records.length, 1);
    cleanup(h);
  });

  test('add() persist qua reload', () => {
    const file = path.join(os.tmpdir(), `hist_${Date.now()}.json`);
    const h1 = new HistoryManager({ file });
    h1.add({ site: 's', username: 'u', price: 1000 });

    const h2 = new HistoryManager({ file });
    assert.equal(h2.records.length, 1);
    assert.equal(h2.records[0].site, 's');
    cleanup(h1);
  });

  test('add() trim whitespace khỏi site và username', () => {
    const h = makeTempHistory();
    const r = h.add({ site: '  mysite  ', username: '  admin  ', price: 0 });
    assert.equal(r.site, 'mysite');
    assert.equal(r.username, 'admin');
    cleanup(h);
  });

  test('add() reject site rỗng', () => {
    const h = makeTempHistory();
    assert.throws(() => h.add({ site: '', username: 'u', price: 0 }));
    cleanup(h);
  });

  test('add() reject username rỗng', () => {
    const h = makeTempHistory();
    assert.throws(() => h.add({ site: 's', username: '', price: 0 }));
    cleanup(h);
  });

  test('add() reject price âm', () => {
    const h = makeTempHistory();
    assert.throws(() => h.add({ site: 's', username: 'u', price: -100 }));
    cleanup(h);
  });

  test('add() chấp nhận price = 0', () => {
    const h = makeTempHistory();
    assert.doesNotThrow(() => h.add({ site: 's', username: 'u', price: 0 }));
    cleanup(h);
  });

  test('add() giới hạn maxRecords', () => {
    const h = makeTempHistory({ maxRecords: 3 });
    h.add({ site: 's', username: 'u1', price: 0 });
    h.add({ site: 's', username: 'u2', price: 0 });
    h.add({ site: 's', username: 'u3', price: 0 });
    h.add({ site: 's', username: 'u4', price: 0 });
    assert.equal(h.records.length, 3);
    cleanup(h);
  });

  test('add() mới nhất lên đầu (unshift)', () => {
    const h = makeTempHistory();
    h.add({ site: 's', username: 'first', price: 0 });
    h.add({ site: 's', username: 'second', price: 0 });
    assert.equal(h.records[0].username, 'second');
    cleanup(h);
  });
});

// ── getAll() / filter ─────────────────────────────────────────────

describe('HistoryManager – getAll() + filter', () => {
  test('getAll() không filter → trả tất cả', () => {
    const h = makeTempHistory();
    h.add({ site: 's', username: 'u1', price: 0 });
    h.add({ site: 's', username: 'u2', price: 0 });
    assert.equal(h.getAll().length, 2);
    cleanup(h);
  });

  test('filter theo site', () => {
    const h = makeTempHistory();
    h.add({ site: 'site1', username: 'u', price: 0 });
    h.add({ site: 'site2', username: 'u', price: 0 });
    assert.equal(h.getAll({ site: 'site1' }).length, 1);
    assert.equal(h.getAll({ site: 'site2' }).length, 1);
    cleanup(h);
  });

  test('filter theo username', () => {
    const h = makeTempHistory();
    h.add({ site: 's', username: 'alice', price: 0 });
    h.add({ site: 's', username: 'bob',   price: 0 });
    assert.equal(h.getAll({ username: 'alice' }).length, 1);
    cleanup(h);
  });

  test('filter kết hợp site + username', () => {
    const h = makeTempHistory();
    h.add({ site: 'A', username: 'alice', price: 0 });
    h.add({ site: 'A', username: 'bob',   price: 0 });
    h.add({ site: 'B', username: 'alice', price: 0 });
    assert.equal(h.getAll({ site: 'A', username: 'alice' }).length, 1);
    cleanup(h);
  });

  test('getAll() trả [] nếu filter không khớp', () => {
    const h = makeTempHistory();
    h.add({ site: 's', username: 'u', price: 0 });
    assert.equal(h.getAll({ site: 'nonexistent' }).length, 0);
    cleanup(h);
  });
});

// ── findById / deleteById ─────────────────────────────────────────

describe('HistoryManager – findById / deleteById', () => {
  test('findById() tìm đúng record', () => {
    const h = makeTempHistory();
    const r = h.add({ site: 's', username: 'u', price: 99 });
    const found = h.findById(r.id);
    assert.equal(found?.price, 99);
    cleanup(h);
  });

  test('findById() trả null nếu không tìm thấy', () => {
    const h = makeTempHistory();
    assert.equal(h.findById(999999), null);
    cleanup(h);
  });

  test('deleteById() xoá đúng record', () => {
    const h = makeTempHistory();
    const r = h.add({ site: 's', username: 'u', price: 0 });
    const ok = h.deleteById(r.id);
    assert.ok(ok);
    assert.equal(h.records.length, 0);
    cleanup(h);
  });

  test('deleteById() trả false nếu không tìm thấy', () => {
    const h = makeTempHistory();
    assert.ok(!h.deleteById(999));
    cleanup(h);
  });
});

// ── getSummary ────────────────────────────────────────────────────

describe('HistoryManager – getSummary()', () => {
  test('tổng hợp đúng totalSpent', () => {
    const h = makeTempHistory();
    h.add({ site: 's', username: 'u', price: 10000 });
    h.add({ site: 's', username: 'u', price: 20000 });
    const s = h.getSummary();
    assert.equal(s.totalSpent, 30000);
    cleanup(h);
  });

  test('group đúng theo site+username', () => {
    const h = makeTempHistory();
    h.add({ site: 's1', username: 'alice', price: 5000 });
    h.add({ site: 's1', username: 'alice', price: 5000 });
    h.add({ site: 's1', username: 'bob',   price: 3000 });
    const s = h.getSummary();
    assert.equal(s.byAccount.length, 2);
    const alice = s.byAccount.find(a => a.username === 'alice');
    assert.equal(alice.count, 2);
    assert.equal(alice.total, 10000);
    cleanup(h);
  });
});

// ── clear ─────────────────────────────────────────────────────────

describe('HistoryManager – clear()', () => {
  test('xoá tất cả records', () => {
    const h = makeTempHistory();
    h.add({ site: 's', username: 'u', price: 0 });
    h.add({ site: 's', username: 'u', price: 0 });
    h.clear();
    assert.equal(h.records.length, 0);
    cleanup(h);
  });

  test('persist empty sau clear', () => {
    const file = path.join(os.tmpdir(), `hist_clear_${Date.now()}.json`);
    const h1 = new HistoryManager({ file });
    h1.add({ site: 's', username: 'u', price: 0 });
    h1.clear();
    const h2 = new HistoryManager({ file });
    assert.equal(h2.records.length, 0);
    cleanup(h1);
  });
});

// ── Export: CSV / JSON / JSONL / Summary ──────────────────────────

describe('HistoryManager – exports', () => {
  test('toCSV() có header row', () => {
    const h = makeTempHistory();
    h.add({ site: 's', username: 'u', price: 0 });
    const csv = h.toCSV();
    assert.ok(csv.startsWith('id,time,site'));
    cleanup(h);
  });

  test('toCSV() escape dấu ngoặc kép trong data', () => {
    const h = makeTempHistory();
    h.add({ site: 'site "a"', username: 'u', price: 0 });
    const csv = h.toCSV();
    assert.ok(csv.includes('""a""'), `CSV không escape: ${csv}`);
    cleanup(h);
  });

  test('toCSV() trả "No data" khi rỗng', () => {
    const h = makeTempHistory();
    assert.equal(h.toCSV(), 'No data');
    cleanup(h);
  });

  test('toJSON() có fields: exportedAt, count, filter, records', () => {
    const h = makeTempHistory();
    h.add({ site: 's', username: 'u', price: 100 });
    const j = h.toJSON();
    assert.ok(j.exportedAt);
    assert.equal(j.count, 1);
    assert.ok(Array.isArray(j.records));
    cleanup(h);
  });

  test('toJSONL() — 1 JSON object per line', () => {
    const h = makeTempHistory();
    h.add({ site: 's', username: 'u1', price: 0 });
    h.add({ site: 's', username: 'u2', price: 0 });
    const lines = h.toJSONL().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.doesNotThrow(() => lines.forEach(l => JSON.parse(l)));
    cleanup(h);
  });

  test('toSummary() avgPrice tính đúng', () => {
    const h = makeTempHistory();
    h.add({ site: 's', username: 'u', price: 10000 });
    h.add({ site: 's', username: 'u', price: 30000 });
    const s = h.toSummary();
    const acc = s.byAccount[0];
    assert.equal(acc.avgPrice, 20000);
    assert.equal(acc.minPrice, 10000);
    assert.equal(acc.maxPrice, 30000);
    cleanup(h);
  });

  test('toSummary() không expose raw data', () => {
    const h = makeTempHistory();
    h.add({ site: 's', username: 'u', price: 0, data: { secret: 'abc' } });
    const s = h.toSummary();
    const str = JSON.stringify(s);
    assert.ok(!str.includes('secret'), 'toSummary() không nên có raw data');
    cleanup(h);
  });
});
