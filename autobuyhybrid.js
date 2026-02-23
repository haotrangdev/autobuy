// ⚡ AUTOBUY HYBRID – Tự đăng nhập + Pure API mua hàng
// v9 – Gửi request mua song song cho toàn bộ acc trong list
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const https = require('https');
const fs = require('fs');

// ── CẤU HÌNH ──────────────────────────────────────────────────────
const CONFIG = {
  url: 'https://lychuotbach.shop/accounts/11061b48-41e2-4afc-a099-ebd5f459181f',
  username: 'tester001',
  password: 'tester001',

  maxPrice: 7000,

  retryNormal: 800,
  retrySale: 100,
  retryMs: 800,
  jitter: 200,

  cooldownAfter429: 10000,
  emptyThreshold: 60,
  pageTimeout: 10000,

  buyEndpoint: '/api/account-transaction/buy-by-id',

  // Số acc lấy mỗi lần (gửi song song tất cả)
  fetchLimit: 10,

  // Giới hạn mua tối đa (0 = không giới hạn)
  maxBuy: 0,
};

// ── STATE ──────────────────────────────────────────────────────────
let accessToken = '';
let refreshToken = '';
let cfClearance = '';
let userId = '';
let cateId = '';
let consecutiveEmpty = 0;
let lastKnownTotal = -1;

const COOKIES_FILE = 'cookies.json';
const TOKEN_FILE = 'tokens.json';
const RESULT_FILE = 'result.json';
const LOG_FILE = 'debug.log';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
};

function getCateIdFromUrl(url) {
  const match = url.match(/accounts\/([a-f0-9-]{36})/);
  return match ? match[1] : null;
}

function decodeJWT(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  } catch { return null; }
}

function isTokenExpired(token) {
  const payload = decodeJWT(token);
  if (!payload) return true;
  return Date.now() / 1000 > payload.exp - 60;
}

// ── HTTP helper ────────────────────────────────────────────────────
function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'lychuotbach.shop',
      path,
      method,
      headers: {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'authorization': `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'data-from': 'SHOP_LY',
        'cookie': `cf_clearance=${cfClearance}; is_authenticated=true; refresh_token=${refreshToken}; access_token=${accessToken}`,
        'referer': 'https://lychuotbach.shop/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
        'origin': 'https://lychuotbach.shop',
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Refresh token ──────────────────────────────────────────────────
async function doRefreshToken() {
  log('🔄 Refresh token...');
  const res = await apiRequest('POST', '/api/auth/refresh-token', { refresh_token: refreshToken });
  if (res.data?.data?.access_token) {
    accessToken = res.data.data.access_token;
    const payload = decodeJWT(accessToken);
    userId = payload?.user_id || userId;
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ accessToken, refreshToken, cfClearance, userId }));
    log(`✓ Token mới – hết hạn: ${new Date(payload.exp * 1000).toLocaleTimeString()}`);
    return true;
  }
  log(`✕ Refresh thất bại: ${JSON.stringify(res.data).slice(0, 100)}`);
  return false;
}

// ── Đăng nhập Puppeteer ───────────────────────────────────────────
async function doLogin() {
  log('🌐 Khởi động trình duyệt để đăng nhập...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(CONFIG.pageTimeout);

  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image', 'font', 'stylesheet', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  page.on('response', async res => {
    try {
      if (res.url().includes('/api/auth') || res.url().includes('refresh-token')) {
        const json = await res.json().catch(() => null);
        if (json?.data?.access_token) { accessToken = json.data.access_token; log('  → Bắt được access_token'); }
        if (json?.data?.refresh_token) refreshToken = json.data.refresh_token;
      }
    } catch { }
  });

  try {
    await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(1500);

    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Đăng ký/Đăng nhập'));
      if (btn) btn.click();
    });
    await sleep(1200);
    await page.waitForSelector('input[type="password"]', { timeout: 8000, visible: true });

    await page.evaluate(() => {
      const el = [...document.querySelectorAll('button, span, a')].find(e => e.innerText?.includes('Nhấn vào đây để đăng nhập'));
      if (el) el.click();
    });
    await sleep(800);

    await page.click('input#username', { clickCount: 3 });
    await page.type('input#username', CONFIG.username, { delay: 50 });
    await page.click('input#password', { clickCount: 3 });
    await page.type('input#password', CONFIG.password, { delay: 50 });
    await page.keyboard.press('Enter');
    log('✓ Đã submit đăng nhập');

    await page.waitForFunction(() => document.body.innerText.includes('Đăng xuất'), { timeout: 15000 });
    log('✓ Đăng nhập thành công');

    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies));
    const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
    if (cookieMap.access_token) accessToken = cookieMap.access_token;
    if (cookieMap.refresh_token) refreshToken = cookieMap.refresh_token;
    if (cookieMap.cf_clearance) cfClearance = cookieMap.cf_clearance;

    const payload = decodeJWT(accessToken);
    userId = payload?.user_id || '';
    log(`✓ user_id: ${userId}`);
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ accessToken, refreshToken, cfClearance, userId }));

  } catch (err) {
    log('✕ Đăng nhập thất bại: ' + err.message);
    await browser.close();
    return false;
  }

  await browser.close();
  log('✓ Đóng trình duyệt\n');
  return true;
}

// ── Khởi tạo session ──────────────────────────────────────────────
async function initSession() {
  if (fs.existsSync(TOKEN_FILE)) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE));
    accessToken = saved.accessToken || '';
    refreshToken = saved.refreshToken || '';
    cfClearance = saved.cfClearance || '';
    userId = saved.userId || '';

    if (!isTokenExpired(accessToken)) { log('✓ Dùng access token đã lưu'); return true; }
    if (refreshToken && !isTokenExpired(refreshToken)) {
      const ok = await doRefreshToken();
      if (ok) return true;
    }
  }

  if (fs.existsSync(COOKIES_FILE)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE));
    const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
    if (cookieMap.access_token) accessToken = cookieMap.access_token;
    if (cookieMap.refresh_token) refreshToken = cookieMap.refresh_token;
    if (cookieMap.cf_clearance) cfClearance = cookieMap.cf_clearance;

    if (!isTokenExpired(accessToken)) {
      log('✓ Dùng token từ cookies.json');
      const payload = decodeJWT(accessToken);
      userId = payload?.user_id || '';
      return true;
    }
    if (refreshToken) { const ok = await doRefreshToken(); if (ok) return true; }
  }

  log('Cần đăng nhập mới...');
  return await doLogin();
}

// ── Lấy danh sách acc đang bán ────────────────────────────────────
async function getAvailableAccounts() {
  const res = await apiRequest('GET', `/api/accounts/public/single?cate_id=${cateId}&limit=${CONFIG.fetchLimit}&page=1`);

  if (res.status === 429) {
    log(`⚠ Rate limit (429) – nghỉ ${CONFIG.cooldownAfter429 / 1000}s...`);
    CONFIG.retryMs = CONFIG.retryNormal;
    await sleep(CONFIG.cooldownAfter429);
    return [];
  }

  const records = res.data?.data?.records;
  const total = res.data?.data?.total ?? 0;

  if (lastKnownTotal !== -1 && total !== lastKnownTotal) {
    log(`📡 Stock thay đổi: ${lastKnownTotal} → ${total} – tăng tốc!`);
    CONFIG.retryMs = CONFIG.retrySale;
    consecutiveEmpty = 0;
  }
  lastKnownTotal = total;

  if (!records || records.length === 0) {
    consecutiveEmpty++;
    if (consecutiveEmpty > CONFIG.emptyThreshold && CONFIG.retryMs < CONFIG.retryNormal) {
      log(`💤 Không có acc lâu rồi – giảm tốc về ${CONFIG.retryNormal}ms`);
      CONFIG.retryMs = CONFIG.retryNormal;
    }
    return [];
  }

  consecutiveEmpty = 0;
  CONFIG.retryMs = CONFIG.retrySale;

  // Lọc acc đúng giá
  return records.filter(acc => acc.final_sale_price <= CONFIG.maxPrice);
}

// ── Mua 1 acc ─────────────────────────────────────────────────────
async function tryBuy(acc) {
  try {
    const res = await apiRequest('POST', CONFIG.buyEndpoint, { account_id: acc.id });

    if (res.status === 429) {
      return { success: false, data: res.data, status: res.status, acc, rateLimited: true };
    }

    const ok = res.data?.success === true || res.status === 200 || res.status === 201;
    return { success: ok, data: res.data, status: res.status, acc };
  } catch (err) {
    return { success: false, data: null, status: 0, acc, error: err.message };
  }
}

// ── Ghi kết quả ───────────────────────────────────────────────────
function saveResult(data) {
  const history = fs.existsSync(RESULT_FILE) ? JSON.parse(fs.readFileSync(RESULT_FILE)) : [];
  history.push({ time: new Date().toISOString(), data });
  fs.writeFileSync(RESULT_FILE, JSON.stringify(history, null, 2));
}

// ── MAIN ──────────────────────────────────────────────────────────
(async () => {
  fs.writeFileSync(LOG_FILE, `=== AUTOBUY v9 START: ${new Date().toISOString()} ===\n`);
  log('⚡ AUTOBUY HYBRID v9 – Song song + Mua liên tục\n');

  const ok = await initSession();
  if (!ok) { log('✕ Không khởi tạo được session'); return; }

  cateId = getCateIdFromUrl(CONFIG.url);
  if (!cateId) { log('✕ Không lấy được cate_id từ URL'); return; }

  log(`✓ Session OK | User: ${userId}`);
  log(`✓ Cate ID: ${cateId}`);
  log(`✓ Endpoint mua: ${CONFIG.buyEndpoint}`);
  log(`✓ Giá mỗi acc: ${CONFIG.maxPrice.toLocaleString()}₫`);
  log(`✓ Lấy tối đa ${CONFIG.fetchLimit} acc mỗi lần, gửi song song`);
  log(`✓ Chế độ: chậm ${CONFIG.retryNormal}ms ↔ nhanh ${CONFIG.retrySale}ms (tự động)`);
  log(`\n=== BẮT ĐẦU MUA LIÊN TỤC ===\n`);

  let attempt = 0;
  let totalBought = 0;
  let totalSpent = 0;
  let shouldStop = false;

  while (!shouldStop) {
    attempt++;

    try {
      const accs = await getAvailableAccounts();

      if (accs.length === 0) {
        // Refresh token an toàn khi đang rảnh
        if (isTokenExpired(accessToken)) {
          const refreshOk = await doRefreshToken();
          if (!refreshOk) await doLogin();
        }

        if (attempt % 50 === 0) {
          const now = new Date();
          log(`[#${attempt}] Chờ acc... (${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}) | Delay: ${CONFIG.retryMs}ms | Mua: ${totalBought} acc | Chi: ${totalSpent.toLocaleString()}₫`);
        }
        await sleep(CONFIG.retryMs + Math.random() * CONFIG.jitter);
        continue;
      }

      log(`[#${attempt}] 🔥 Thấy ${accs.length} acc – gửi ${accs.length} request song song!`);

      // Gửi tất cả request mua cùng lúc
      const results = await Promise.allSettled(accs.map(acc => tryBuy(acc)));

      let boughtThisRound = 0;

      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { success, data, status, acc, rateLimited, error } = r.value;

        if (success) {
          totalBought++;
          totalSpent += acc.final_sale_price;
          boughtThisRound++;
          log(`  🎉 MUA THÀNH CÔNG #${totalBought}! id=${acc.id} | Tổng chi: ${totalSpent.toLocaleString()}₫`);
          saveResult(data);

          if (CONFIG.maxBuy > 0 && totalBought >= CONFIG.maxBuy) {
            log(`🏁 Đã mua đủ ${CONFIG.maxBuy} acc – dừng lại`);
            shouldStop = true;
            break;
          }
        } else {
          const errText = JSON.stringify(data || '').toLowerCase();

          if (rateLimited) {
            log(`  ⚠ Rate limit – nghỉ ${CONFIG.cooldownAfter429 / 1000}s`);
            await sleep(CONFIG.cooldownAfter429);
            break;
          } else if (error) {
            log(`  ❌ Exception: ${error.slice(0, 80)}`);
          } else if (errText.includes('không đủ') || errText.includes('insufficient') || errText.includes('balance') || status === 402) {
            log(`\n🏁 HẾT TIỀN – dừng lại`);
            shouldStop = true;
            break;
          } else if (errText.includes('đã bán') || errText.includes('sold') || errText.includes('không tìm thấy')) {
            // Snipe – im lặng, không log rác
          } else {
            log(`  ✕ [${status}] ${errText.slice(0, 100)}`);
          }
        }
      }

      if (boughtThisRound > 0) {
        log(`  → Round này mua được ${boughtThisRound}/${accs.length} acc`);
      }

    } catch (err) {
      log(`[#${attempt}] ❌ Exception: ${err.message.slice(0, 100)}`);
    }

    if (!shouldStop) {
      await sleep(CONFIG.retryMs + Math.random() * CONFIG.jitter);
    }
  }

  log(`\n=== KẾT THÚC | Đã mua: ${totalBought} acc | Chi: ${totalSpent.toLocaleString()}₫ ===`);
})();