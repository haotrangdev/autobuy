'use strict';

const https = require('https');
const fs    = require('fs');

// ── Lazy singletons (tránh require() lặp lại) ─────────────────────
const lazy = fn => { let v; return () => v !== undefined ? v : (v = (() => { try { return fn(); } catch { return null; } })()); };
const getNotifier       = lazy(() => require('./notifier').notifier);
const getLogger         = lazy(() => require('./logger').logger);
const getAccountLimiter = lazy(() => require('./adaptive-limiter').AccountLimiter);
const getHealthReg      = lazy(() => require('./account-health').registry);
const getSessionPool    = lazy(() => require('./session-pool').sessionPool);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── JWT ───────────────────────────────────────────────────────────
function decodeJWT(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
  catch { return null; }
}
function isTokenExpired(token, bufferSec = 60) {
  const p = decodeJWT(token);
  return !p || Date.now() / 1000 > p.exp - bufferSec;
}

// ── Constants ─────────────────────────────────────────────────────
const LOG_MAX_BYTES  = 10 * 1024 * 1024;
const BUY_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 60_000;
const RUNTIME_KEYS   = ['retryNormal','retrySale','jitter','maxPrice','maxBuy','fetchLimit','cooldownAfter429','emptyThreshold'];
const BLOCKED_RES    = new Set(['image','font','stylesheet','media']);

// ── BuyEngine ─────────────────────────────────────────────────────
class BuyEngine {
  constructor(cfg, accountCfg, ui, tag) {
    this.cfg     = cfg;
    this.account = accountCfg;
    this.ui      = ui;
    this.tag     = tag;

    const slug = `${cfg.hostname}_${accountCfg.username}`;
    this.COOKIES_FILE = `cookies_${slug}.json`;
    this.TOKEN_FILE   = `tokens_${slug}.json`;
    this.LOG_FILE     = `debug_${slug}.log`;

    this.forceStop   = false;
    this.totalBought = 0;
    this.totalSpent  = 0;

    this._healthKey = `${cfg.hostname}__${accountCfg.username}`;

    const Limiter = getAccountLimiter();
    this._limiter = Limiter
      ? new Limiter(this._healthKey, cfg.retryNormal, {
          minDelay:       50,
          maxDelay:       cfg.cooldownAfter429 * 2 || 60_000,
          backoffFactor:  2.0,
          recoveryFactor: 0.85,
          recoveryAfter:  5,
          pauseThreshold: 5,
          pauseWindow:    60_000,
          pauseDuration:  cfg.cooldownAfter429 * 2 || 120_000,
        })
      : null;

    this._session = getSessionPool()?.get(cfg, accountCfg, () => this.doLogin()) ?? null;
    this._syncFromSession();

    this._refreshing     = false;
    this._refreshPromise = null;
    this._errorStreak    = 0;

    // Shallow copy runtime-safe config
    this._runtimeCfg = Object.fromEntries(RUNTIME_KEYS.map(k => [k, cfg[k]]));
  }

  // ── Hot-reload ────────────────────────────────────────────────────
  onConfigUpdate(patch) {
    let changed = false;
    for (const key of RUNTIME_KEYS) {
      if (patch[key] !== undefined && patch[key] !== this._runtimeCfg[key]) {
        this._runtimeCfg[key] = patch[key];
        changed = true;
      }
    }
    if (!changed) return;
    const keys = Object.keys(patch).filter(k => RUNTIME_KEYS.includes(k)).join(', ');
    this.log(`🔄 Hot reload: ${keys}`);
    if (this._limiter && patch.retryNormal) {
      this._limiter.baseDelay    = patch.retryNormal;
      this._limiter.currentDelay = Math.max(this._limiter.opts.minDelay, Math.min(this._limiter.currentDelay, patch.retryNormal * 4));
    }
  }

  get _rc() { return this._runtimeCfg; }

  // ── Logger ────────────────────────────────────────────────────────
  log(msg) {
    const line = `[${new Date().toTimeString().slice(0, 8)}] ${this.tag} ${msg}`;
    try {
      if (fs.existsSync(this.LOG_FILE) && fs.statSync(this.LOG_FILE).size > LOG_MAX_BYTES)
        fs.renameSync(this.LOG_FILE, this.LOG_FILE + '.old');
    } catch {}
    if (!this.ui?.terminal) console.log(line);
    fs.appendFileSync(this.LOG_FILE, line + '\n');
    this.ui?.terminal?.log?.(`${this.tag} ${msg}`);
    this.ui?.web?.log?.(msg, this.cfg.hostname, this.account.username);
  }

  // ── HTTP ──────────────────────────────────────────────────────────
  apiRequest(method, path, body = null) {
    this._syncFromSession();
    return new Promise((resolve, reject) => {
      const data    = body ? JSON.stringify(body) : null;
      const headers = {
        'accept':          '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'authorization':   `Bearer ${this.accessToken}`,
        'content-type':    'application/json',
        'data-from':       'SHOP_LY',
        'cookie':          `cf_clearance=${this.cfClearance}; is_authenticated=true; refresh_token=${this.refreshToken}; access_token=${this.accessToken}`,
        'referer':         `https://${this.cfg.hostname}/`,
        'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145 Safari/537.36',
        'origin':          `https://${this.cfg.hostname}`,
      };
      if (data) headers['content-length'] = Buffer.byteLength(data);

      const req = https.request({ hostname: this.cfg.hostname, path, method, headers }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try   { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, data: raw }); }
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  // ── Auth ──────────────────────────────────────────────────────────
  _syncFromSession() {
    if (!this._session) return;
    ({ accessToken: this.accessToken, refreshToken: this.refreshToken,
       cfClearance: this.cfClearance, userId: this.userId } = this._session);
  }

  _saveTokens() {
    const payload = { accessToken: this.accessToken, refreshToken: this.refreshToken,
                      cfClearance: this.cfClearance, userId: this.userId };
    fs.writeFileSync(this.TOKEN_FILE, JSON.stringify(payload));
    if (this._session) { Object.assign(this._session, payload); this._session.save(); }
  }

  async doRefreshToken() {
    if (this._session) {
      const token = await this._session.getToken(msg => this.log(msg));
      this._syncFromSession();
      getLogger()?.sessionRefresh(this.cfg.hostname, this.account.username, !!token);
      return !!token;
    }
    // Deduplicate concurrent refreshes
    if (this._refreshing) return this._refreshPromise;
    this._refreshing = true;
    this._refreshPromise = this._execRefresh().finally(() => {
      this._refreshing = false; this._refreshPromise = null;
    });
    return this._refreshPromise;
  }

  async _execRefresh() {
    this.log('🔄 Refresh token...');
    try {
      const res = await this.apiRequest('POST', '/api/auth/refresh-token', { refresh_token: this.refreshToken });
      const newToken = res.data?.data?.access_token;
      if (newToken) {
        this.accessToken = newToken;
        const p = decodeJWT(newToken);
        if (p) this.userId = p.user_id || this.userId;
        this._saveTokens();
        this.log(`✓ Token mới – hết hạn: ${new Date(p.exp * 1000).toLocaleTimeString()}`);
        getLogger()?.sessionRefresh(this.cfg.hostname, this.account.username, true);
        return true;
      }
      this.log(`✕ Refresh thất bại: ${JSON.stringify(res.data).slice(0, 80)}`);
    } catch (err) {
      this.log(`✕ Refresh lỗi: ${err.message}`);
    }
    getLogger()?.sessionRefresh(this.cfg.hostname, this.account.username, false);
    return false;
  }

  async doLogin() {
    const puppeteer     = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    this.log('🌐 Đăng nhập bằng trình duyệt...');

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(this.cfg.pageTimeout);

    await page.setRequestInterception(true);
    page.on('request', req => BLOCKED_RES.has(req.resourceType()) ? req.abort() : req.continue());
    page.on('response', async res => {
      if (!res.url().includes('/api/auth') && !res.url().includes('refresh-token')) return;
      const json = await res.json().catch(() => null);
      if (json?.data?.access_token)  this.accessToken  = json.data.access_token;
      if (json?.data?.refresh_token) this.refreshToken = json.data.refresh_token;
    });

    const { loginSteps: s } = this.cfg;
    const clickByText = (sel, text) => page.evaluate(
      (s, t) => [...document.querySelectorAll(s)].find(el => el.innerText?.includes(t))?.click(), sel, text
    );
    const typeInto = async (sel, text) => {
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, text, { delay: 50 });
    };

    try {
      await page.goto(this.cfg.loginPageUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await sleep(1500);
      await clickByText('button', s.openModalText);
      await sleep(1200);
      await page.waitForSelector(s.passwordSelector, { timeout: 8_000, visible: true });
      if (s.switchToLoginText) { await clickByText('button,span,a', s.switchToLoginText); await sleep(800); }
      await typeInto(s.usernameSelector, this.account.username);
      await typeInto(s.passwordSelector, this.account.password);
      await page.keyboard.press('Enter');
      this.log('✓ Submit đăng nhập');
      await page.waitForFunction(t => document.body.innerText.includes(t), { timeout: 15_000 }, s.successText);
      this.log('✓ Đăng nhập thành công');

      const cookies   = await page.cookies();
      const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
      fs.writeFileSync(this.COOKIES_FILE, JSON.stringify(cookies));
      if (cookieMap.access_token)  this.accessToken  = cookieMap.access_token;
      if (cookieMap.refresh_token) this.refreshToken = cookieMap.refresh_token;
      if (cookieMap.cf_clearance)  this.cfClearance  = cookieMap.cf_clearance;
      this.userId = decodeJWT(this.accessToken)?.user_id || '';
      this._saveTokens();
    } catch (err) {
      this.log('✕ Đăng nhập thất bại: ' + err.message);
      await browser.close();
      return false;
    }
    await browser.close();
    this.log('✓ Đóng trình duyệt');
    return true;
  }

  async initSession() {
    if (this._session) {
      const token = await this._session.getToken(msg => this.log(msg));
      this._syncFromSession();
      return !!token;
    }
    const readTokenFile = file => {
      if (!fs.existsSync(file)) return null;
      try { return JSON.parse(fs.readFileSync(file)); } catch { return null; }
    };
    const saved = readTokenFile(this.TOKEN_FILE);
    if (saved) {
      Object.assign(this, { accessToken: saved.accessToken || '', refreshToken: saved.refreshToken || '',
                            cfClearance: saved.cfClearance || '', userId: saved.userId || '' });
      if (!isTokenExpired(this.accessToken)) { this.log('✓ Dùng token đã lưu'); return true; }
      if (this.refreshToken && !isTokenExpired(this.refreshToken) && await this.doRefreshToken()) return true;
    }
    const cookies = readTokenFile(this.COOKIES_FILE);
    if (cookies) {
      const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
      this.accessToken  = cookieMap.access_token  || '';
      this.refreshToken = cookieMap.refresh_token || '';
      this.cfClearance  = cookieMap.cf_clearance  || '';
      if (!isTokenExpired(this.accessToken)) {
        this.log('✓ Dùng token từ cookies');
        this.userId = decodeJWT(this.accessToken)?.user_id || '';
        return true;
      }
      if (this.refreshToken && await this.doRefreshToken()) return true;
    }
    return this.doLogin();
  }

  // ── Fetch + Buy ───────────────────────────────────────────────────
  async fetchAvailableAccounts(cateId) {
    const res = await this.apiRequest('GET', this.cfg.listEndpoint(cateId, this._rc.fetchLimit));
    return {
      isRateLimit: this.cfg.isRateLimit(res),
      total:       this.cfg.parseTotal(res.data),
      accounts:    this.cfg.parseList(res.data) || [],
    };
  }

  _preBuyCheck(acc) {
    const price = this.cfg.parsePrice(acc);
    if (price > this._rc.maxPrice)
      return { ok: false, reason: `Giá ${price.toLocaleString()} > maxPrice ${this._rc.maxPrice.toLocaleString()}` };
    if (this._rc.maxBuy > 0 && this.totalBought >= this._rc.maxBuy)
      return { ok: false, reason: `Đã đạt maxBuy (${this._rc.maxBuy})` };
    return { ok: true };
  }

  async tryBuy(acc) {
    const check = this._preBuyCheck(acc);
    if (!check.ok) return { success: false, data: null, status: 0, acc, error: check.reason };
    try {
      const res = await this.apiRequest('POST', this.cfg.buyEndpoint, this.cfg.buyBody(this.cfg.parseId(acc)));
      return { success: this.cfg.isSuccess(res), data: res.data, status: res.status, acc };
    } catch (err) {
      return { success: false, data: null, status: 0, acc, error: err.message };
    }
  }

  tryBuyWithTimeout(acc) {
    return Promise.race([
      this.tryBuy(acc),
      sleep(BUY_TIMEOUT_MS).then(() => ({ success: false, data: null, status: 0, acc, error: 'Timeout' })),
    ]);
  }

  // ── Helpers ───────────────────────────────────────────────────────
  _uiUpdate(extra = {}) {
    this.ui?.web?.updateAccount?.({
      site:        this.cfg.hostname,
      username:    this.account.username,
      totalBought: this.totalBought,
      totalSpent:  this.totalSpent,
      health:      this._limiter?.healthScore() ?? 100,
      ...extra,
    });
  }

  _handle429(source) {
    this._limiter?.on429();
    getHealthReg()?.record(this._healthKey, '429');
    this.ui?.web?.notify429?.(this.cfg.id || this.cfg.hostname, this.account.username);
    const cooldown = this._limiter?.getDelay() ?? this._rc.cooldownAfter429;
    this.log(`${source} Rate limit – nghỉ ${(cooldown / 1000).toFixed(1)}s`);
    getLogger()?.rateLimit(this.cfg.hostname, this.account.username, cooldown);
    return cooldown;
  }

  // ── Main loop ─────────────────────────────────────────────────────
  async run(historyManager) {
    fs.writeFileSync(this.LOG_FILE, `=== START ${new Date().toISOString()} ===\n`);
    this.log(`⚡ ${this.cfg.hostname} | user: ${this.account.username}`);
    getHealthReg()?.record(this._healthKey, 'start');

    if (!await this.initSession()) { this.log('✕ Không khởi tạo được session'); return; }

    const cateId = this.cfg.parseCateId(this.cfg.loginPageUrl);
    if (!cateId) { this.log('✕ Không lấy được cate_id'); return; }

    this.log(`✓ Session OK | userId: ${this.userId} | cateId: ${cateId}`);

    const state = { cateId, stock: 0, retryMs: this._rc.retryNormal, consecutiveEmpty: 0, lastKnownTotal: -1 };
    this._uiUpdate({ stock: 0, delay: state.retryMs, running: true });
    this.ui?.web?.watchEngine?.(this.cfg.id || this.cfg.hostname, this);

    let attempt = 0;

    mainLoop:
    while (!this.forceStop) {
      attempt++;

      // Paused by adaptive limiter
      if (this._limiter?.isPaused()) {
        const pauseMs = this._limiter.pauseRemaining();
        this.log(`⏸ Tạm dừng ${Math.ceil(pauseMs / 1000)}s do quá nhiều 429...`);
        this._uiUpdate({ delay: pauseMs, paused: true });
        await sleep(Math.min(pauseMs, 5_000));
        continue;
      }

      try {
        const { isRateLimit, total, accounts } = await this.fetchAvailableAccounts(cateId);

        if (isRateLimit) {
          await sleep(this._handle429('⚠ [Fetch]'));
          state.retryMs = this._rc.retryNormal;
          continue;
        }

        this._limiter?.onSuccess();

        if (state.lastKnownTotal !== -1 && total !== state.lastKnownTotal) {
          this.log(`📡 Stock: ${state.lastKnownTotal} → ${total} – tăng tốc!`);
          state.retryMs = this._rc.retrySale;
          state.consecutiveEmpty = 0;
        }
        state.lastKnownTotal = total;
        state.stock          = total;

        const eligible = accounts.filter(a => this.cfg.parsePrice(a) <= this._rc.maxPrice);
        this._uiUpdate({ stock: state.stock, delay: state.retryMs, paused: false });

        // No stock
        if (!eligible.length) {
          state.consecutiveEmpty++;
          if (state.consecutiveEmpty > this._rc.emptyThreshold && state.retryMs < this._rc.retryNormal) {
            this.log(`💤 Giảm tốc về ${this._rc.retryNormal}ms`);
            state.retryMs = this._rc.retryNormal;
          }
          if (isTokenExpired(this.accessToken)) {
            if (!await this.doRefreshToken()) await this.doLogin();
          }
          if (attempt % 50 === 0) {
            const n = new Date();
            this.log(`[#${attempt}] Chờ... ${n.getHours()}:${String(n.getMinutes()).padStart(2,'0')} | Mua: ${this.totalBought} | ${this.totalSpent.toLocaleString()}₫`);
          }
          await sleep(this._limiter ? this._limiter.getDelay(this._rc.jitter) : state.retryMs + Math.random() * this._rc.jitter);
          this._errorStreak = 0;
          continue;
        }

        // Buy all in parallel
        state.consecutiveEmpty = 0;
        state.retryMs          = this._rc.retrySale;
        this.log(`[#${attempt}] 🔥 ${eligible.length} acc – gửi song song!`);
        getLogger()?.stock(this.cfg.hostname, this.account.username, eligible.length);

        const results       = await Promise.allSettled(eligible.map(a => this.tryBuyWithTimeout(a)));
        let boughtThisRound = 0;

        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const { success, data, status, acc, error } = r.value;

          if (success) {
            const price = this.cfg.parsePrice(acc);
            const id    = this.cfg.parseId(acc);
            this.totalBought++;
            this.totalSpent += price;
            boughtThisRound++;
            this.log(`  🎉 MUA ĐƯỢC #${this.totalBought}! id=${id} | ${this.totalSpent.toLocaleString()}₫`);
            getLogger()?.buy(this.cfg.hostname, this.account.username, id, price);
            getHealthReg()?.record(this._healthKey, 'buy');
            historyManager?.add({ site: this.cfg.hostname, username: this.account.username, accId: id, price, data });
            this._uiUpdate();
            this.ui?.web?.notifyBought?.({ site: this.cfg.hostname, username: this.account.username, accId: id, price, data });
            getNotifier()?.onBought({ site: this.cfg.hostname, username: this.account.username, accId: id, price }).catch(() => {});
            if (this._rc.maxBuy > 0 && this.totalBought >= this._rc.maxBuy) {
              this.log(`🏁 Đã mua đủ ${this._rc.maxBuy} acc`);
              break mainLoop;
            }
          } else if (error) {
            this.log(`  ❌ ${error.slice(0, 80)}`);
            getLogger()?.error(this.cfg.hostname, this.account.username, error.slice(0, 120));
          } else if (this.cfg.isRateLimit({ status, data })) {
            await sleep(this._handle429('  ⚠ [Buy]'));
            break;
          } else if (this.cfg.isOutOfMoney({ status, data })) {
            this.log(`\n🏁 HẾT TIỀN`);
            getLogger()?.outOfMoney(this.cfg.hostname, this.account.username, this.totalSpent);
            getNotifier()?.onOutOfMoney({ site: this.cfg.hostname, username: this.account.username, totalBought: this.totalBought, totalSpent: this.totalSpent }).catch(() => {});
            break mainLoop;
          } else if (!this.cfg.isSoldOut({ status, data })) {
            this.log(`  ✕ [${status}] ${JSON.stringify(data).slice(0, 80)}`);
          }
        }

        if (boughtThisRound > 0) {
          this.log(`  → ${boughtThisRound}/${eligible.length} thành công`);
          for (let i = 0; i < boughtThisRound; i++) this._limiter?.onSuccess();
        }
        this._errorStreak = 0;

      } catch (err) {
        getHealthReg()?.record(this._healthKey, 'restart');
        this._errorStreak++;
        const backoff = Math.min(3_000 * 2 ** (this._errorStreak - 1), MAX_BACKOFF_MS);
        this.log(`[#${attempt}] ❌ ${err.message.slice(0, 100)} – retry sau ${backoff / 1000}s`);
        await sleep(backoff);
        continue;
      }

      if (!this.forceStop) {
        await sleep(this._limiter ? this._limiter.getDelay(this._rc.jitter) : state.retryMs + Math.random() * this._rc.jitter);
      }
    }

    this.log(`\n=== DONE | Mua: ${this.totalBought} | Chi: ${this.totalSpent.toLocaleString()}₫ ===`);
    getLogger()?.engineStop(this.cfg.hostname, this.account.username, this.tag, this.forceStop ? 'forced' : 'done');
    this.ui?.web?.unwatch?.(this.cfg.id || this.cfg.hostname, this);
    getHealthReg()?.record(this._healthKey, 'stop');
    this._uiUpdate({ running: false, stopped: true });
  }
}

module.exports = { BuyEngine };
