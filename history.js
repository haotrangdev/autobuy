'use strict';

const fs   = require('fs');

const HISTORY_FILE = 'history.json';
const DEFAULT_MAX  = 10_000;
const csvEscape    = val => `"${String(val ?? '').replace(/"/g, '""')}"`;

class HistoryManager {
  constructor({ file = HISTORY_FILE, maxRecords = DEFAULT_MAX } = {}) {
    this.file       = file;
    this.maxRecords = maxRecords;
    this.records    = this._load();
  }

  _load() {
    if (!fs.existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Invalid format');
      return parsed;
    } catch {
      try { fs.copyFileSync(this.file, this.file + '.bak'); } catch {}
      return [];
    }
  }

  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  _validate({ site, username, price }) {
    if (!site     || typeof site     !== 'string') throw new Error('site phải là string không rỗng');
    if (!username || typeof username !== 'string') throw new Error('username phải là string không rỗng');
    if (price != null && (typeof price !== 'number' || !isFinite(price) || price < 0))
      throw new Error('price phải là số không âm');
  }

  add({ site, username, accId, price, data } = {}) {
    this._validate({ site, username, price });
    const record = {
      id:       Date.now(),
      time:     new Date().toISOString(),
      site:     site.trim(),
      username: username.trim(),
      accId:    accId ?? null,
      price:    price ?? 0,
      data:     data && typeof data === 'object' ? data : {},
    };
    this.records.unshift(record);
    if (this.records.length > this.maxRecords) this.records.length = this.maxRecords;
    this._save();
    return record;
  }

  getAll({ site, username, from, to } = {}) {
    const fromMs = from ? new Date(from).getTime() : null;
    const toMs   = to   ? new Date(to).getTime()   : null;
    return this.records.filter(r => {
      if (site     && r.site     !== site)     return false;
      if (username && r.username !== username) return false;
      if (fromMs || toMs) {
        const t = new Date(r.time).getTime();
        if (fromMs && t < fromMs) return false;
        if (toMs   && t > toMs)   return false;
      }
      return true;
    });
  }

  findById(id)   { return this.records.find(r => r.id === id) ?? null; }

  deleteById(id) {
    const len = this.records.length;
    this.records = this.records.filter(r => r.id !== id);
    if (this.records.length !== len) { this._save(); return true; }
    return false;
  }

  getSummary() {
    const byAccount = {};
    for (const r of this.records) {
      const key = `${r.site}__${r.username}`;
      const e   = (byAccount[key] ??= { site: r.site, username: r.username, count: 0, total: 0 });
      e.count++;
      e.total += r.price;
    }
    return { totalRecords: this.records.length, totalSpent: this.records.reduce((s, r) => s + r.price, 0), byAccount: Object.values(byAccount) };
  }

  clear() { this.records = []; this._save(); }

  // ── Export ────────────────────────────────────────────────────
  toCSV(filter = {}) {
    const rows = this.getAll(filter);
    if (!rows.length) return 'No data';
    return [
      ['id','time','site','username','accId','price','data'].join(','),
      ...rows.map(r => [r.id, r.time, r.site, r.username, r.accId, r.price, JSON.stringify(r.data)].map(csvEscape).join(',')),
    ].join('\n');
  }

  toJSON(filter = {}) {
    const records = this.getAll(filter);
    return { exportedAt: new Date().toISOString(), count: records.length, filter, records };
  }

  toJSONL(filter = {}) {
    return this.getAll(filter).map(r => JSON.stringify(r)).join('\n');
  }

  toSummary(filter = {}) {
    const records = this.getAll(filter);
    const map = {};
    for (const r of records) {
      const key = `${r.site}__${r.username}`;
      const e   = (map[key] ??= { site: r.site, username: r.username, count: 0, totalSpent: 0, prices: [], firstBuy: r.time, lastBuy: r.time });
      e.count++;
      e.totalSpent += r.price;
      e.prices.push(r.price);
      if (r.time < e.firstBuy) e.firstBuy = r.time;
      if (r.time > e.lastBuy)  e.lastBuy  = r.time;
    }
    const byAccount = Object.values(map).map(e => ({
      ...e,
      prices:   undefined,
      avgPrice: e.prices.length ? Math.round(e.totalSpent / e.count) : 0,
      minPrice: e.prices.length ? Math.min(...e.prices) : 0,
      maxPrice: e.prices.length ? Math.max(...e.prices) : 0,
    }));
    return { exportedAt: new Date().toISOString(), totalRecords: records.length, totalSpent: records.reduce((s, r) => s + r.price, 0), filter, byAccount };
  }

  saveCSV(p, f)     { fs.writeFileSync(p, this.toCSV(f), 'utf8'); }
  saveJSON(p, f)    { const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.toJSON(f), null, 2)); fs.renameSync(tmp, p); }
  saveJSONL(p, f)   { fs.writeFileSync(p, this.toJSONL(f), 'utf8'); }
  saveSummary(p, f) { fs.writeFileSync(p, JSON.stringify(this.toSummary(f), null, 2), 'utf8'); }

  attachExportRoutes(app) {
    const parseFilter = q => ({ site: q.site || undefined, username: q.username || undefined, from: q.from || undefined, to: q.to || undefined });

    app.get('/export.csv',     (req, res) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="history_${Date.now()}.csv"`); res.send('\uFEFF' + this.toCSV(parseFilter(req.query))); });
    app.get('/export.json',    (req, res) => { res.setHeader('Content-Disposition', `attachment; filename="history_${Date.now()}.json"`); res.json(this.toJSON(parseFilter(req.query))); });
    app.get('/export.jsonl',   (req, res) => { res.setHeader('Content-Type', 'application/x-ndjson'); res.setHeader('Content-Disposition', `attachment; filename="history_${Date.now()}.jsonl"`); res.send(this.toJSONL(parseFilter(req.query))); });
    app.get('/export.summary', (req, res) => { res.json(this.toSummary(parseFilter(req.query))); });
  }
}

module.exports = { HistoryManager };
