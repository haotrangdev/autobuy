'use strict';

const fs    = require('fs');
const https = require('https');
const http  = require('http');

const CONFIG_FILE  = 'notifier.json';
const WEBHOOK_FILE = 'webhook.json';

const DEFAULT_CONFIG = {
  telegram: { enabled: false, botToken: '', chatId: '', onBought: true, onOutOfMoney: true, onError: false, onStart: false, onStop: false },
  desktop:  { enabled: false },
};

// ── Config I/O ────────────────────────────────────────────────────
const readJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

function loadConfig() {
  const raw = readJSON(CONFIG_FILE, {});
  return {
    telegram: { ...DEFAULT_CONFIG.telegram, ...(raw.telegram || {}) },
    desktop:  { ...DEFAULT_CONFIG.desktop,  ...(raw.desktop  || {}) },
  };
}

function saveConfig(patch) {
  const current = loadConfig();
  const next = { telegram: { ...current.telegram, ...(patch.telegram || {}) }, desktop: { ...current.desktop, ...(patch.desktop || {}) } };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function loadWebhookConfig()      { return readJSON(WEBHOOK_FILE, {}); }
function saveWebhookConfig(patch) {
  const next = { ...loadWebhookConfig(), ...patch };
  fs.writeFileSync(WEBHOOK_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ── Telegram ──────────────────────────────────────────────────────
function sendTelegram(botToken, chatId, text) {
  return new Promise(resolve => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${botToken}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString()).ok === true); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(8_000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ── Desktop ───────────────────────────────────────────────────────
const getDesktopNotifier = (() => { let n; return () => n !== undefined ? n : (n = (() => { try { return require('node-notifier'); } catch { return null; } })()); })();

function sendDesktop(title, message) {
  try { getDesktopNotifier()?.notify({ title, message, sound: true }); } catch {}
}

// ── Webhook ───────────────────────────────────────────────────────
const WEBHOOK_COLORS = { onBought: 0x00ff88, onError: 0xff4466, onStart: 0x00d4ff, onStop: 0xffcc00, onOutOfMoney: 0xff8800 };

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('URL không hợp lệ: ' + url)); }
    const payload = JSON.stringify(body);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const req     = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => { res.resume(); resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300 }); });
    req.on('error', reject);
    req.setTimeout(8_000, () => { req.destroy(); reject(new Error('webhook timeout')); });
    req.write(payload);
    req.end();
  });
}

async function sendWebhook(event, data) {
  const cfg = loadWebhookConfig();
  if (!cfg.enabled || !cfg.url) return { ok: false, reason: 'disabled' };
  if (cfg.events?.[event] === false) return { ok: false, reason: 'event disabled' };

  const body = cfg.format === 'discord'
    ? { embeds: [{ title: data.title || event, description: data.message || JSON.stringify(data).slice(0, 1000), color: WEBHOOK_COLORS[event] ?? 0x888888, timestamp: new Date().toISOString(), footer: { text: 'AutoBuy' } }] }
    : { event, data, ts: new Date().toISOString(), source: 'autobuy' };

  try { return await postJson(cfg.url, body); }
  catch (err) { return { ok: false, error: err.message }; }
}

// ── Notifier class ────────────────────────────────────────────────
class Notifier {
  constructor() { this._cfg = loadConfig(); }

  reload()              { this._cfg = loadConfig(); }
  getConfig()           { return this._cfg; }
  updateConfig(patch)   { this._cfg = saveConfig(patch); return this._cfg; }
  getWebhookConfig()    { return loadWebhookConfig(); }
  updateWebhookConfig(patch) { return saveWebhookConfig(patch); }

  async onBought({ site, username, accId, price }) {
    const priceStr = (price || 0).toLocaleString('vi') + '₫';
    const text = [`🎉 <b>MUA ĐƯỢC!</b>`, `🌐 Site: <code>${site}</code>`, `👤 Account: <code>${username}</code>`, `🆔 ID: <code>${accId || '—'}</code>`, `💰 Giá: <b>${priceStr}</b>`, `🕐 ${new Date().toLocaleString('vi')}`].join('\n');
    await this._send('onBought', '🎉 Mua được!', text, `Mua được acc ${accId} giá ${priceStr} trên ${site}`);
    sendWebhook('onBought', { title: '🎉 Mua được acc!', message: `${site} | ${username} | ${priceStr}`, site, username, accId, price }).catch(() => {});
  }

  async onOutOfMoney({ site, username, totalBought, totalSpent }) {
    const text = [`💸 <b>HẾT TIỀN</b>`, `🌐 Site: <code>${site}</code>`, `👤 Account: <code>${username}</code>`, `📦 Đã mua: <b>${totalBought}</b> acc`, `💰 Đã chi: <b>${(totalSpent||0).toLocaleString('vi')}₫</b>`].join('\n');
    await this._send('onOutOfMoney', '💸 Hết tiền', text, `Hết tiền trên ${site}/${username}`);
    sendWebhook('onOutOfMoney', { title: '💸 Hết tiền', message: `${site} | ${username} | Đã mua ${totalBought} acc`, site, username, totalBought, totalSpent }).catch(() => {});
  }

  async onError({ label, attempt, err }) {
    const text = [`⚠️ <b>ENGINE LỖI</b>`, `🏷 Label: <code>${label}</code>`, `🔄 Lần thứ: ${attempt}`, `❌ Lỗi: <code>${(err?.message || 'unknown').slice(0, 200)}</code>`].join('\n');
    await this._send('onError', '⚠️ Engine lỗi', text, `${label} lỗi lần ${attempt}`);
    sendWebhook('onError', { title: '⚠️ Engine lỗi', message: `${label} | Lần ${attempt} | ${err?.message?.slice(0, 100) || ''}`, label, attempt, error: err?.message }).catch(() => {});
  }

  async onStart({ count }) {
    const text = `🚀 <b>Đã khởi động ${count} engine(s)</b>\n🕐 ${new Date().toLocaleString('vi')}`;
    await this._send('onStart', '🚀 AutoBuy Start', text, `Đã khởi động ${count} engine(s)`);
    sendWebhook('onStart', { title: '🚀 AutoBuy Start', message: `Đã khởi động ${count} engine(s)`, count }).catch(() => {});
  }

  async onStop() {
    const text = `🛑 <b>Đã dừng tất cả engine</b>\n🕐 ${new Date().toLocaleString('vi')}`;
    await this._send('onStop', '🛑 AutoBuy Stop', text, 'Đã dừng tất cả engine');
    sendWebhook('onStop', { title: '🛑 AutoBuy Stop', message: 'Đã dừng tất cả engine' }).catch(() => {});
  }

  async test() {
    const text    = `✅ <b>AutoBuy Test Notification</b>\n🕐 ${new Date().toLocaleString('vi')}\nKết nối Telegram thành công!`;
    const results = { telegram: false, desktop: false, webhook: false };
    const { telegram, desktop } = this._cfg;
    if (telegram.enabled && telegram.botToken && telegram.chatId)
      results.telegram = await sendTelegram(telegram.botToken, telegram.chatId, text);
    if (desktop.enabled) { sendDesktop('AutoBuy Test', 'Kết nối desktop notification thành công!'); results.desktop = true; }
    const wh = await sendWebhook('onStart', { title: '🧪 Test webhook', message: 'AutoBuy webhook đang hoạt động!' });
    results.webhook = wh.ok ?? false;
    return results;
  }

  testWebhook() {
    return sendWebhook('onStart', { title: '🧪 Test webhook', message: 'AutoBuy webhook đang hoạt động!' });
  }

  async _send(eventKey, desktopTitle, telegramText, desktopMessage) {
    const { telegram, desktop } = this._cfg;
    if (telegram.enabled && telegram[eventKey] && telegram.botToken && telegram.chatId)
      await sendTelegram(telegram.botToken, telegram.chatId, telegramText).catch(() => {});
    if (desktop.enabled) sendDesktop(desktopTitle, desktopMessage);
  }
}

const notifier = new Notifier();
module.exports = { Notifier, notifier, loadConfig, saveConfig, loadWebhookConfig, saveWebhookConfig, sendWebhook };
