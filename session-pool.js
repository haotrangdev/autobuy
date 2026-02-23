'use strict';

const fs    = require('fs');
const https = require('https');

// ── JWT helpers ───────────────────────────────────────────────────
function decodeJWT(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
  catch { return null; }
}
function isExpired(token, bufferSec = 60) {
  const p = decodeJWT(token);
  return !p || Date.now() / 1000 > p.exp - bufferSec;
}

// ── SessionEntry ──────────────────────────────────────────────────
class SessionEntry {
  constructor(key, cfg, accountCfg, loginFn) {
    this.key      = key;
    this.cfg      = cfg;
    this.account  = accountCfg;
    this._loginFn = loginFn;

    this.accessToken  = '';
    this.refreshToken = '';
    this.cfClearance  = '';
    this.userId       = '';

    this._refreshing     = false;
    this._refreshPromise = null;

    this.TOKEN_FILE   = `tokens_${key}.json`;
    this.COOKIES_FILE = `cookies_${key}.json`;
    this._load();
  }

  // ── Persistence ───────────────────────────────────────────────
  _load() {
    const tryRead = file => {
      if (!fs.existsSync(file)) return null;
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    };

    const token = tryRead(this.TOKEN_FILE);
    if (token) {
      ({ accessToken: this.accessToken = '', refreshToken: this.refreshToken = '',
         cfClearance: this.cfClearance = '', userId: this.userId = '' } = token);
      return;
    }

    // Fallback: cookies file
    const cookies = tryRead(this.COOKIES_FILE);
    if (cookies) {
      const map = Object.fromEntries(cookies.map(c => [c.name, c.value]));
      this.accessToken  = map.access_token  || '';
      this.refreshToken = map.refresh_token || '';
      this.cfClearance  = map.cf_clearance  || '';
    }
  }

  save() {
    try {
      fs.writeFileSync(this.TOKEN_FILE, JSON.stringify({
        accessToken: this.accessToken, refreshToken: this.refreshToken,
        cfClearance: this.cfClearance, userId: this.userId,
      }, null, 2), 'utf8');
    } catch {}
  }

  // ── Token management ──────────────────────────────────────────
  async getToken(log = () => {}) {
    if (!isExpired(this.accessToken)) return this.accessToken;

    // Only one concurrent refresh
    if (this._refreshing) return this._refreshPromise;
    this._refreshing = true;
    this._refreshPromise = this._doRefresh(log).finally(() => {
      this._refreshing = false; this._refreshPromise = null;
    });
    return this._refreshPromise;
  }

  async _doRefresh(log) {
    // Try refresh_token first
    if (this.refreshToken && !isExpired(this.refreshToken, 30)) {
      log('🔄 [SessionPool] Refresh token...');
      try {
        const authCfg  = this.cfg.api?.auth || {};
        const path     = authCfg.refreshPath || '/api/auth/refresh-token';
        const bodyTpl  = authCfg.refreshBody || { refresh_token: '{refresh_token}' };
        const body     = JSON.stringify(Object.fromEntries(
          Object.entries(bodyTpl).map(([k, v]) =>
            [k, typeof v === 'string' ? v.replace('{refresh_token}', this.refreshToken) : v]
          )
        ));

        const result    = await this._httpsPost(this.cfg.hostname, path, body);
        const fieldPath = authCfg.accessField || 'data.access_token';
        const newToken  = fieldPath.split('.').reduce((o, k) => o?.[k], result);

        if (newToken) {
          this.accessToken = newToken;
          const p = decodeJWT(newToken);
          if (p && authCfg.userIdField) this.userId = p[authCfg.userIdField] || this.userId;
          this.save();
          log(`✓ [SessionPool] Token mới đến ${new Date((p?.exp || 0) * 1000).toLocaleTimeString()}`);
          return newToken;
        }
      } catch (err) {
        log(`⚠ [SessionPool] Refresh lỗi: ${err.message}`);
      }
    }

    // Fallback: re-login
    log('🌐 [SessionPool] Refresh thất bại → đăng nhập lại...');
    try {
      const tokens = await this._loginFn();
      if (tokens) {
        Object.assign(this, tokens);
        this.save();
        log('✓ [SessionPool] Đăng nhập thành công');
        return this.accessToken;
      }
    } catch (err) {
      log(`✕ [SessionPool] Đăng nhập thất bại: ${err.message}`);
    }

    return this.accessToken; // return stale token; engine handles errors
  }

  _httpsPost(hostname, path, body) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname, path, method: 'POST',
        headers: {
          'content-type':   'application/json',
          'content-length': Buffer.byteLength(body),
          'cookie': `refresh_token=${this.refreshToken}; cf_clearance=${this.cfClearance}`,
        },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve({}); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });
  }

  getAuthHeaders() {
    return {
      authorization: `Bearer ${this.accessToken}`,
      cookie: [
        `cf_clearance=${this.cfClearance}`,
        `is_authenticated=true`,
        `refresh_token=${this.refreshToken}`,
        `access_token=${this.accessToken}`,
      ].join('; '),
    };
  }
}

// ── SessionPool ───────────────────────────────────────────────────
class SessionPool {
  constructor() {
    this._pool = new Map();
  }

  get(cfg, account, loginFn) {
    const key = `${cfg.hostname}_${account.username}`;
    if (!this._pool.has(key)) {
      this._pool.set(key, new SessionEntry(key, cfg, account, loginFn));
    }
    return this._pool.get(key);
  }

  delete(cfg, account) { this._pool.delete(`${cfg.hostname}_${account.username}`); }
  clear()              { this._pool.clear(); }
  get size()           { return this._pool.size; }
}

const sessionPool = new SessionPool();
module.exports = { SessionPool, SessionEntry, sessionPool, isExpired, decodeJWT };
