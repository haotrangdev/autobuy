'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_DIR  = 'logs';
const LOG_FILE = path.join(LOG_DIR, 'events.jsonl');
const MAX_SIZE = 50 * 1024 * 1024;

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function rotateIfNeeded() {
  try {
    if (fs.statSync(LOG_FILE).size > MAX_SIZE)
      fs.renameSync(LOG_FILE, LOG_FILE.replace('.jsonl', `_${Date.now()}.jsonl`));
  } catch {}
}

class Logger {
  constructor() {
    ensureDir();
  }

  write(type, data = {}) {
    try {
      ensureDir();
      rotateIfNeeded();
      const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + '\n';
      fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch {}
  }

  // Shorthand methods
  buy(site, username, accId, price)       { this.write('buy',           { site, username, accId, price }); }
  rateLimit(site, username, cooldownMs)   { this.write('rateLimit',     { site, username, cooldownMs }); }
  outOfMoney(site, username, spent)       { this.write('outOfMoney',    { site, username, spent }); }
  sessionRefresh(site, username, success) { this.write('sessionRefresh',{ site, username, success }); }
  sessionLogin(site, username, success)   { this.write('sessionLogin',  { site, username, success }); }
  engineStart(site, username, tag)        { this.write('engineStart',   { site, username, tag }); }
  engineStop(site, username, tag, reason) { this.write('engineStop',    { site, username, tag, reason }); }
  engineRestart(site, username, attempt)  { this.write('engineRestart', { site, username, attempt }); }
  stock(site, username, count)            { this.write('stock',         { site, username, count }); }
  error(site, username, msg)              { this.write('error',         { site, username, msg }); }

  readEvents(limitDays = 7) {
    if (!fs.existsSync(LOG_FILE)) return [];
    const cutoff = Date.now() - limitDays * 86_400_000;
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).reduce((acc, line) => {
      try {
        const e = JSON.parse(line);
        if (new Date(e.ts).getTime() >= cutoff) acc.push(e);
      } catch {}
      return acc;
    }, []);
  }

  getStats(days = 1) {
    const events = this.readEvents(days);
    const byAccount = {};
    const byHour    = {};

    const getAcc  = u => (byAccount[u] ??= { buys: 0, spent: 0, rateLimits: 0, restarts: 0 });
    const getHour = h => (byHour[h]    ??= { buys: 0, stock: 0, samples: 0,    rateLimits: 0 });

    let totalBuys = 0, totalSpent = 0, totalRateLimits = 0, totalRestarts = 0;

    for (const e of events) {
      const hour = new Date(e.ts).getHours().toString().padStart(2, '0');
      const acc  = e.username || 'unknown';
      const h    = getHour(hour);
      const a    = getAcc(acc);

      switch (e.type) {
        case 'buy':
          totalBuys++; totalSpent += e.price || 0;
          h.buys++; a.buys++; a.spent += e.price || 0;
          break;
        case 'rateLimit':
          totalRateLimits++;
          h.rateLimits++; a.rateLimits++;
          break;
        case 'engineRestart':
          totalRestarts++; a.restarts++;
          break;
        case 'stock':
          if (e.count > 0) { h.stock += e.count; h.samples++; }
          break;
      }
    }

    const hourlyStock = Object.entries(byHour)
      .map(([h, d]) => ({ hour: h + ':00', avgStock: d.samples ? Math.round(d.stock / d.samples) : 0, buys: d.buys, rateLimits: d.rateLimits }))
      .sort((a, b) => b.avgStock - a.avgStock);

    const topBuyers = Object.entries(byAccount)
      .map(([username, d]) => ({ username, ...d }))
      .sort((a, b) => b.buys - a.buys);

    return { period: `${days} ngày gần nhất`, totalBuys, totalSpent, totalRateLimits, totalRestarts, byAccount, byHour, hourlyStock, topBuyers };
  }

  close() { /* no-op for sync logger */ }
}

const logger = new Logger();
module.exports = { Logger, logger };
