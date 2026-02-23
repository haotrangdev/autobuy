'use strict';

const MAX_LOGS          = 400;
const HISTORY_PAGE_SIZE = 500;

let ws;
let startTime = null;
let timer     = null;

// ── State ─────────────────────────────────────────────────────────
let allAccounts = {};
let allHistory  = [];
let allSites    = [];
let allLogs     = [];
let historyPage = 1;

// ── Sub-tabs ──────────────────────────────────────────────────────
function showSubtab(group, name, btn) {
  document.querySelectorAll(`#page-${group === 'ntf' ? 'notifier' : 'scheduler'} .subtab-page`).forEach(p => p.classList.remove('active'));
  document.querySelectorAll(`#page-${group === 'ntf' ? 'notifier' : 'scheduler'} .stab`).forEach(b => b.classList.remove('active'));
  document.getElementById(`${group}-${name}`)?.classList.add('active');
  btn?.classList.add('active');

  // Show the right save button for notifier tab
  if (group === 'ntf') {
    const isWh = name === 'webhook';
    document.getElementById('wh-save-btn').style.display  = isWh ? '' : 'none';
    document.getElementById('wh-saved-msg').style.display = isWh ? '' : 'none';
    document.getElementById('notif-saved-msg').style.display = isWh ? 'none' : '';
  }
}

// ── Nav ───────────────────────────────────────────────────────────
function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nb').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name)?.classList.add('active');
  (btn || event?.target)?.classList.add('active');

  const loaders = {
    history:   renderHistory,
    settings:  loadSettings,
    notifier:  loadNotifierTab,
    scheduler: loadScheduleTab,
    sites:     loadSitesTab,
    analytics: loadAnalyticsTab,
    health:    loadHealthTab,
  };
  loaders[name]?.();
}

// ── WebSocket ─────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket('ws://' + location.host);
  const statusEl = document.getElementById('ws-status');
  ws.onopen    = () => { statusEl.className = ''; statusEl.textContent = '🟢 Live'; appendLog('i', '🔌 Kết nối OK'); };
  ws.onclose   = () => { statusEl.className = 'off'; statusEl.textContent = '🔴 Offline'; setTimeout(connect, 3000); };
  ws.onmessage = e => { try { handle(JSON.parse(e.data)); } catch (err) { console.warn('[WS]', err); } };
}

function sendCmd(cmd, data = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ cmd, ...data }));
}

// ── Message handler ───────────────────────────────────────────────
function handle(msg) {
  const { type, data, cls, text, site, user } = msg;
  ({
    log:            () => appendLog(cls || '', text, site, user),
    logBatch:       () => { for (const l of (data || [])) { allLogs.push({ cls: l.cls || '', text: l.text, site: l.site, user: l.user }); if (allLogs.length > MAX_LOGS) allLogs.shift(); } renderLog(); },
    account:        () => updateAccCard(data),
    bought:         () => addBought(data),
    history:        () => { allHistory = data; historyPage = 1; renderHistory(); },
    sites:          () => { allSites = data; initSelectors(); renderAccCards(); updateGlobalStats(); renderSiteList(); },
    config:         () => populateSettings(data),
    clearHistory:   () => { allHistory = []; historyPage = 1; renderHistory(); },
    schedule:       () => handle_schedule(data),
    notifierConfig: () => handle_notifierConfig(data),
    addSiteResult:  () => handle_addSiteResult(data),
    stats:          () => handle_stats(data),
    authConfig:     () => handle_authConfig(data),
    historyRecord:  () => handle_historyRecord(data),
    multiSchedule:  () => handle_multiSchedule(data),
    accountHealth:  () => handle_accountHealth(data),
    retryPresets:   () => handle_retryPresets(data),
    webhookConfig:  () => handle_webhookConfig(data),
  })[type]?.();
}

// ── Global stats ──────────────────────────────────────────────────
function updateGlobalStats() {
  let bought = 0, spent = 0, running = 0;
  for (const a of Object.values(allAccounts)) {
    bought  += a.totalBought || 0;
    spent   += a.totalSpent  || 0;
    if (a.running) running++;
  }
  document.getElementById('s-bought').textContent  = bought;
  document.getElementById('s-spent').textContent   = spent.toLocaleString('vi') + '₫';
  document.getElementById('s-running').textContent = running;
  document.getElementById('s-sites').textContent   = allSites.length;
  document.getElementById('site-count').textContent = allSites.length ? `(${allSites.length})` : '';
}

// ── Account cards ─────────────────────────────────────────────────
function updateAccCard(data) {
  const key = data.site + '__' + data.username;
  allAccounts[key] = Object.assign(allAccounts[key] || {}, data);
  updateGlobalStats();
  let card = document.getElementById('ac-' + key);
  if (!card) { renderAccCards(); return; }
  card.outerHTML = accCardHTML(allAccounts[key]);
}

function accCardHTML(a) {
  const key      = a.site + '__' + a.username;
  const state    = a.stopped ? 'stopped' : a.running ? 'buying' : '';
  const badge    = a.stopped ? 'badge-stop' : a.running ? 'badge-run' : 'badge-idle';
  const badgeT   = a.stopped ? 'STOPPED' : a.running ? 'RUNNING' : 'IDLE';
  const delayMs  = a.delay || 0;
  const delayC   = delayMs < 200 ? 'delay-fast' : delayMs > 1000 ? 'delay-slow' : '';
  return `<div id="ac-${key}" class="acc-card ${state}">
    <div class="acc-card-top">
      <div><div class="acc-label">${a.label || a.username}</div><div class="acc-site">${a.site}</div></div>
      <span class="badge ${badge}">${badgeT}</span>
    </div>
    <div class="acc-stats">
      <div class="acc-stat"><div class="acc-stat-l">Đã mua</div><div class="acc-stat-v" style="color:var(--g)">${a.totalBought || 0}</div></div>
      <div class="acc-stat"><div class="acc-stat-l">Đã chi</div><div class="acc-stat-v">${(a.totalSpent || 0).toLocaleString('vi')}₫</div></div>
      <div class="acc-stat"><div class="acc-stat-l">Stock</div><div class="acc-stat-v">${a.stock || 0}</div></div>
      <div class="acc-stat"><div class="acc-stat-l">Delay</div><div class="acc-stat-v ${delayC}">${delayMs}ms</div></div>
    </div>
  </div>`;
}

function renderAccCards() {
  const grid = document.getElementById('accounts-grid');
  if (!grid) return;
  const list = Object.values(allAccounts);
  grid.innerHTML = list.length
    ? list.map(accCardHTML).join('')
    : '<div class="no-data-msg">Chưa có engine nào. Nhấn ▶ Start All</div>';
}

// ── Log ───────────────────────────────────────────────────────────
function appendLog(cls, text, site = '', user = '') {
  allLogs.push({ cls, text, site, user });
  if (allLogs.length > MAX_LOGS) allLogs.shift();
  renderLog();
}

function renderLog() {
  const filter = document.getElementById('log-filter')?.value || '';
  const box    = document.getElementById('log-box');
  if (!box) return;
  const filtered = filter ? allLogs.filter(l => l.site === filter || l.user === filter) : allLogs;
  box.innerHTML  = filtered.map(l => `<div class="ll ${l.cls}">${escapeHtml(l.text)}</div>`).join('');
  box.scrollTop  = box.scrollHeight;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Bought ────────────────────────────────────────────────────────
function addBought(d) {
  const box = document.getElementById('bought-box');
  if (!box) return;
  const prev = box.querySelector('.no-data');
  if (prev) prev.remove();
  const el = document.createElement('div');
  el.className = 'bi';
  el.innerHTML = `
    <div>
      <div class="fw-bold">${d.username} @ ${d.site}</div>
      <div class="bi-id">ID: ${d.accId || '—'}</div>
    </div>
    <div style="text-align:right">
      <div class="bi-price">${(d.price || 0).toLocaleString('vi')}₫</div>
      <div class="bi-time">${new Date().toLocaleTimeString('vi')}</div>
    </div>`;
  box.prepend(el);
  document.getElementById('bought-count').textContent =
    parseInt(document.getElementById('bought-count').textContent || '0') + 1;
}

function clearBought() {
  const box = document.getElementById('bought-box');
  if (box) { box.innerHTML = '<div class="no-data">Chưa có acc nào...</div>'; }
  document.getElementById('bought-count').textContent = '0';
}

// ── History ───────────────────────────────────────────────────────
function getHistoryFilter() {
  return {
    site:     document.getElementById('h-site')?.value || undefined,
    username: document.getElementById('h-acc')?.value  || undefined,
    from:     document.getElementById('h-from')?.value || undefined,
    to:       document.getElementById('h-to')?.value   || undefined,
  };
}

function applyHistoryFilter(rows) {
  const f = getHistoryFilter();
  return rows.filter(r => {
    if (f.site     && r.site     !== f.site)     return false;
    if (f.username && r.username !== f.username) return false;
    if (f.from && new Date(r.time) < new Date(f.from)) return false;
    if (f.to   && new Date(r.time) > new Date(f.to + 'T23:59:59')) return false;
    return true;
  });
}

function renderHistory() {
  const tbody = document.getElementById('history-body');
  if (!tbody) return;
  const filtered = applyHistoryFilter(allHistory);
  const page     = filtered.slice(0, historyPage * HISTORY_PAGE_SIZE);
  tbody.innerHTML = page.map(r => `
    <tr>
      <td class="td-muted">${new Date(r.time).toLocaleString('vi')}</td>
      <td>${r.site}</td>
      <td>${r.username}</td>
      <td class="td-muted">${r.accId || '—'}</td>
      <td class="td-price">${(r.price || 0).toLocaleString('vi')}₫</td>
      <td><button class="btn-ghost btn-xs" onclick="viewHistoryRecord(${r.id})">👁</button></td>
    </tr>`).join('') || `<tr><td colspan="6" class="no-data">Không có dữ liệu</td></tr>`;

  const wrap = document.getElementById('load-more-wrap');
  if (wrap) {
    wrap.innerHTML = filtered.length > historyPage * HISTORY_PAGE_SIZE
      ? `<button class="btn-ghost" onclick="loadMoreHistory()">Tải thêm (${filtered.length - historyPage * HISTORY_PAGE_SIZE} còn lại)</button>`
      : '';
  }
}

function loadMoreHistory()   { historyPage++; renderHistory(); }
function resetHistoryPage()  { historyPage = 1; renderHistory(); }
function exportCSVFiltered() { sendCmd('exportCSV', { filter: getHistoryFilter() }); }

// Inject extra export buttons
(function injectExportButtons() {
  const tpl = document.getElementById('tpl-export-extra');
  if (!tpl) return;
  const toolbar = document.querySelector('.history-toolbar');
  if (toolbar) toolbar.append(tpl.content.cloneNode(true));
})();

// ── Selectors ─────────────────────────────────────────────────────
function initSelectors() {
  const populate = (id, items, val = a => a) => {
    const el = document.getElementById(id);
    if (!el) return;
    const prev = el.value;
    while (el.options.length > 1) el.remove(1);
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = val(item);
      opt.textContent = typeof item === 'string' ? item : item.name || item;
      el.add(opt);
    }
    if (prev) el.value = prev;
  };

  const sites    = allSites.map(s => s.id);
  const accounts = [...new Set(Object.values(allAccounts).map(a => a.username))];

  populate('h-site', allSites, s => s.id);
  populate('h-acc',  accounts);
  populate('site-sel', allSites, s => s.id);
  populate('retry-site', allSites, s => s.id);
  populate('ms-site', allSites, s => s.id);

  // Log filter
  const logFilter = document.getElementById('log-filter');
  if (logFilter) {
    while (logFilter.options.length > 1) logFilter.remove(1);
    for (const s of allSites) {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = s.name;
      logFilter.add(opt);
    }
    for (const u of accounts) {
      const opt = document.createElement('option');
      opt.value = u; opt.textContent = u;
      logFilter.add(opt);
    }
  }
}

// ── Settings – Accounts ───────────────────────────────────────────
let _editAccounts = [];

function renderAccTable() {
  const tbody = document.getElementById('acc-tbody');
  if (!tbody) return;
  tbody.innerHTML = _editAccounts.length
    ? _editAccounts.map((a, i) => `
      <tr>
        <td><input type="text"     value="${a.username || ''}" onchange="editAcc(${i},'username',this.value)"></td>
        <td><input type="password" value="${a.password || ''}" onchange="editAcc(${i},'password',this.value)"></td>
        <td><input type="text"     value="${a.label    || ''}" onchange="editAcc(${i},'label',this.value)"   placeholder="(tuỳ chọn)"></td>
        <td style="text-align:center"><label class="toggle"><input type="checkbox" ${a.enabled !== false ? 'checked' : ''} onchange="editAcc(${i},'enabled',this.checked)"><span class="tslider"></span></label></td>
        <td><button class="btn-d btn-xs" onclick="removeAcc(${i})">✕</button></td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="no-data">Chưa có account nào</td></tr>';
}

function editAcc(i, key, val)  { if (_editAccounts[i]) { _editAccounts[i][key] = val; } }
function removeAcc(i)          { _editAccounts.splice(i, 1); renderAccTable(); }
function addNewAcc() {
  const u = document.getElementById('new-username')?.value?.trim();
  const p = document.getElementById('new-password')?.value?.trim();
  const l = document.getElementById('new-label')?.value?.trim();
  if (!u) { document.getElementById('new-username')?.classList.add('err'); return; }
  document.getElementById('new-username')?.classList.remove('err');
  _editAccounts.push({ username: u, password: p || '', label: l || '', enabled: true });
  renderAccTable();
  ['new-username','new-password','new-label'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

// ── Settings – Load / Save ────────────────────────────────────────
function loadSettings() {
  const siteId = document.getElementById('site-sel')?.value;
  if (siteId) sendCmd('getConfig', { siteId });
  sendCmd('getAuthConfig');
}

function populateSettings(d) {
  if (!d) return;
  const v = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
  const c = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

  v('cfg-url',            d.loginPageUrl);
  v('cfg-maxPrice',       d.maxPrice);
  v('cfg-maxBuy',         d.maxBuy);
  v('cfg-fetchLimit',     d.fetchLimit);
  v('cfg-retryNormal',    d.retryNormal);
  v('cfg-retrySale',      d.retrySale);
  v('cfg-jitter',         d.jitter);
  v('cfg-cooldown',       d.cooldownAfter429);
  v('cfg-emptyThreshold', d.emptyThreshold);
  v('cfg-pageTimeout',    d.pageTimeout);
  v('cfg-port',           d.ui?.webPort);
  c('cfg-terminal',       d.ui?.terminal);
  c('cfg-remote',         d.ui?.remote);

  _editAccounts = (d.accounts || []).map(a => ({ ...a }));
  renderAccTable();
}

function validateSettings() {
  const banner = document.getElementById('err-banner');
  const errs   = [];
  const url = document.getElementById('cfg-url')?.value?.trim();
  if (!url) errs.push('URL trang sản phẩm không được để trống');
  if (errs.length) {
    banner.textContent = errs.join('. ');
    banner.classList.add('show');
    return false;
  }
  banner.classList.remove('show');
  return true;
}

function saveSettings() {
  if (!validateSettings()) return;
  const siteId = document.getElementById('site-sel')?.value;
  if (!siteId) return;
  const val = id => document.getElementById(id)?.value;
  const chk = id => document.getElementById(id)?.checked;
  sendCmd('saveConfig', {
    siteId,
    patch: {
      loginPageUrl:     val('cfg-url'),
      maxPrice:         Number(val('cfg-maxPrice')),
      maxBuy:           Number(val('cfg-maxBuy')),
      fetchLimit:       Number(val('cfg-fetchLimit')),
      retryNormal:      Number(val('cfg-retryNormal')),
      retrySale:        Number(val('cfg-retrySale')),
      jitter:           Number(val('cfg-jitter')),
      cooldownAfter429: Number(val('cfg-cooldown')),
      emptyThreshold:   Number(val('cfg-emptyThreshold')),
      pageTimeout:      Number(val('cfg-pageTimeout')),
      accounts:         _editAccounts,
      ui: { webPort: Number(val('cfg-port')), terminal: chk('cfg-terminal'), remote: chk('cfg-remote') },
    },
  });
  showSavedMsg('saved-msg');
}

function resetSettings() {
  const siteId = document.getElementById('site-sel')?.value;
  if (siteId && confirm('Reset về cấu hình gốc?')) sendCmd('resetConfig', { siteId });
}

// ── Helpers ───────────────────────────────────────────────────────
function showSavedMsg(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

// ── Timer ─────────────────────────────────────────────────────────
function startTimer() {
  if (timer) return;
  startTime = Date.now();
  timer = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(s / 60);
    document.getElementById('elapsed').textContent = `${String(m).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  }, 1000);
}

function confirmStopAll() {
  if (confirm('Dừng tất cả engine?')) sendCmd('stopAll');
}

// ── Theme ─────────────────────────────────────────────────────────
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? '' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  document.getElementById('theme-toggle').textContent = next === 'light' ? '🌙' : '☀️';
  localStorage.setItem('theme', next);
}

(function restoreTheme() {
  const t = localStorage.getItem('theme');
  if (t) {
    document.documentElement.setAttribute('data-theme', t);
    const el = document.getElementById('theme-toggle');
    if (el) el.textContent = t === 'light' ? '🌙' : '☀️';
  }
})();

// ── Scheduler (single) ────────────────────────────────────────────
let _scheduleStatus = null;
let _schedCountdown = null;

function loadScheduleTab() { sendCmd('getSchedule'); sendCmd('getMultiSchedule'); }

function handle_schedule(data) { _scheduleStatus = data; renderSchedule(); }

function renderSchedule() {
  const box      = document.getElementById('sched-status-box');
  const formWrap = document.getElementById('sched-form-wrap');
  if (!box) return;
  if (_scheduleStatus) {
    box.style.display = 'block';
    if (formWrap) formWrap.style.display = 'none';
    document.getElementById('sched-countdown').textContent    = formatCountdown(_scheduleStatus.remainingMs);
    document.getElementById('sched-target-label').textContent = 'Sẽ start lúc ' + new Date(_scheduleStatus.targetTime).toLocaleString('vi');
    if (_schedCountdown) clearInterval(_schedCountdown);
    _schedCountdown = setInterval(() => {
      const rem = _scheduleStatus.targetTime ? Math.max(0, new Date(_scheduleStatus.targetTime) - Date.now()) : 0;
      const el  = document.getElementById('sched-countdown');
      if (el) el.textContent = formatCountdown(rem);
      if (rem <= 0) { clearInterval(_schedCountdown); _schedCountdown = null; }
    }, 500);
  } else {
    box.style.display = 'none';
    if (formWrap) formWrap.style.display = 'block';
    if (_schedCountdown) { clearInterval(_schedCountdown); _schedCountdown = null; }
  }
}

function formatCountdown(ms) {
  if (!ms || ms <= 0) return '00:00:00';
  const s = Math.ceil(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(v => String(v).padStart(2,'0')).join(':');
}

function scheduleStart() {
  const timeEl    = document.getElementById('sched-time');
  const prewarmEl = document.getElementById('sched-prewarm');
  if (!timeEl?.value) { timeEl?.classList.add('err'); return; }
  timeEl.classList.remove('err');
  sendCmd('setSchedule', { targetTime: timeEl.value, prewarmSec: Number(prewarmEl?.value || 30) });
}

function cancelSchedule() {
  if (!confirm('Huỷ lịch hẹn giờ?')) return;
  sendCmd('cancelSchedule');
}

// ── Notifier ──────────────────────────────────────────────────────
function loadNotifierTab() { sendCmd('getNotifierConfig'); sendCmd('getWebhookConfig'); }

function handle_notifierConfig(data) {
  const set = (id, v) => { const el = document.getElementById(id); if (!el) return; el.type === 'checkbox' ? (el.checked = !!v) : (el.value = v ?? ''); };
  const tg  = data.telegram || {};
  set('ntf-tg-enabled',     tg.enabled);
  set('ntf-tg-token',       tg.botToken);
  set('ntf-tg-chatid',      tg.chatId);
  set('ntf-tg-bought',      tg.onBought);
  set('ntf-tg-money',       tg.onOutOfMoney);
  set('ntf-tg-error',       tg.onError);
  set('ntf-tg-start',       tg.onStart);
  set('ntf-tg-stop',        tg.onStop);
  set('ntf-desktop-enabled',data.desktop?.enabled);
}

function saveNotifierConfig() {
  const get = id => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
  sendCmd('saveNotifierConfig', {
    patch: {
      telegram: { enabled: get('ntf-tg-enabled'), botToken: get('ntf-tg-token'), chatId: get('ntf-tg-chatid'),
                  onBought: get('ntf-tg-bought'), onOutOfMoney: get('ntf-tg-money'), onError: get('ntf-tg-error'),
                  onStart: get('ntf-tg-start'), onStop: get('ntf-tg-stop') },
      desktop: { enabled: get('ntf-desktop-enabled') },
    },
  });
  showSavedMsg('notif-saved-msg');
}

function testNotifier() { sendCmd('testNotifier'); }

// ── Sites ─────────────────────────────────────────────────────────
function loadSitesTab() { renderSiteList(); }

function renderSiteList() {
  const list = document.getElementById('site-list-items');
  if (!list) return;
  list.innerHTML = allSites.length
    ? allSites.map(s => `
        <div class="site-list-item">
          <div><div class="site-name">${s.name}</div><div class="site-host">${s.hostname}</div></div>
          <button class="btn-d btn-xs" onclick="deleteSite('${s.id}','${s.name}')">🗑 Xoá</button>
        </div>`).join('')
    : '<div class="no-data" style="padding:20px">Chưa có site nào</div>';
}

function deleteSite(id, name) {
  if (!confirm(`Xoá site "${name}"? Không thể hoàn tác.`)) return;
  sendCmd('deleteSite', { siteId: id });
}

function handle_addSiteResult(data) {
  if (data.ok) {
    const el = document.getElementById('new-site-json');
    if (el) { el.value = ''; el.classList.remove('err'); }
    renderSiteList();
  }
}

function validateAndAddSite() {
  const el = document.getElementById('new-site-json');
  if (!el) return;
  el.classList.remove('err');
  try { JSON.parse(el.value); }
  catch (e) { el.classList.add('err'); appendLog('e', '[UI] JSON không hợp lệ: ' + e.message); return; }
  sendCmd('addSite', { siteJson: el.value });
}

function fillSiteTemplate() {
  const el = document.getElementById('new-site-json');
  if (!el) return;
  el.value = JSON.stringify({
    id: 'mysite', name: 'Tên site', hostname: 'example.com',
    loginPageUrl: 'https://example.com/products/category-id-here',
    maxPrice: 100000, maxBuy: 0, fetchLimit: 10,
    retryNormal: 800, retrySale: 100, jitter: 200, cooldownAfter429: 10000, emptyThreshold: 60, pageTimeout: 10000,
    accounts: [{ username: 'user1', password: 'pass1', label: 'Acc1', enabled: true }],
    ui: { uiMode: 'web', terminal: false, web: true, webPort: 3000, remote: false },
    api: {
      list: { method: 'GET', path: '/api/products', params: { category_id: '{cateId}', limit: '{limit}', page: 1 }, parseList: 'data.items', parseTotal: 'data.total', parsePrice: 'price', parseId: 'id' },
      cateId: { source: 'loginPageUrl', regex: 'products/([a-f0-9-]{36})' },
      buy: { method: 'POST', path: '/api/buy', body: { product_id: '{id}' } },
      auth: { type: 'jwt_cookie', refreshPath: '/api/auth/refresh', refreshBody: { refresh_token: '{refresh_token}' }, accessField: 'data.access_token', userIdField: 'user_id', cookieNames: ['access_token','refresh_token'] },
      responses: { success: { check: 'success === true', orStatus: [200,201] }, soldOut: { keywords: ['sold out','hết hàng'] }, outOfMoney: { keywords: ['insufficient','không đủ'], orStatus: [402] }, rateLimit: { status: 429 } },
    },
    login: { type: 'modal', openModalText: 'Đăng nhập', switchToLoginText: '', usernameSelector: 'input#username', passwordSelector: 'input#password', successText: 'Đăng xuất' },
  }, null, 2);
  el.classList.remove('err');
}

// ── Analytics ─────────────────────────────────────────────────────
function loadAnalyticsTab() { loadAnalytics(); }
function loadAnalytics() { sendCmd('getStats', { days: Number(document.getElementById('analytics-days')?.value || 7) }); }

function handle_stats(data) {
  const el = document.getElementById('analytics-content');
  if (!el) return;
  if (!data) { el.innerHTML = '<div class="no-data">Logger không khả dụng</div>'; return; }
  const fmt = n => Number(n || 0).toLocaleString('vi');
  el.innerHTML = `
    <div class="settings-grid" style="margin-bottom:16px">
      <div class="sec stat-card-center"><div class="stat-big ${data.totalBuys > 0 ? 'stat-good' : ''}">${fmt(data.totalBuys)}</div><div class="stat-label">Tổng mua được</div></div>
      <div class="sec stat-card-center"><div class="stat-big">${fmt(data.totalSpent)}₫</div><div class="stat-label">Tổng chi tiêu</div></div>
      <div class="sec stat-card-center"><div class="stat-big ${data.totalRateLimits > 50 ? 'stat-warn' : ''}">${fmt(data.totalRateLimits)}</div><div class="stat-label">Rate Limit (429)</div></div>
      <div class="sec stat-card-center"><div class="stat-big ${data.totalRestarts > 5 ? 'stat-warn' : ''}">${fmt(data.totalRestarts)}</div><div class="stat-label">Engine Restart</div></div>
    </div>
    <div class="settings-grid">
      <div class="sec">
        <h3>👤 Top accounts</h3>
        <table class="acc-table"><thead><tr><th>Account</th><th>Mua</th><th>Chi tiêu</th><th>429</th><th>Restart</th></tr></thead>
        <tbody>${(data.topBuyers || []).slice(0,10).map(a => `<tr><td class="fw-bold">${a.username}</td><td class="tc-green">${a.buys}</td><td>${fmt(a.spent)}₫</td><td ${a.rateLimits>20?'class="tc-red"':''}>${a.rateLimits}</td><td ${a.restarts>3?'class="tc-red"':''}>${a.restarts}</td></tr>`).join('')||'<tr><td colspan="5" class="no-data">Chưa có dữ liệu</td></tr>'}</tbody></table>
      </div>
      <div class="sec">
        <h3>🕐 Giờ có nhiều stock nhất</h3>
        <table class="acc-table"><thead><tr><th>Giờ</th><th>Avg stock</th><th>Mua</th><th>429</th></tr></thead>
        <tbody>${(data.hourlyStock||[]).filter(h=>h.avgStock>0).slice(0,12).map(h=>`<tr><td class="fw-bold">${h.hour}</td><td>${h.avgStock}</td><td class="tc-green">${h.buys}</td><td ${h.rateLimits>10?'class="tc-red"':''}>${h.rateLimits}</td></tr>`).join('')||'<tr><td colspan="4" class="no-data">Chưa có dữ liệu</td></tr>'}</tbody></table>
      </div>
    </div>`;
}

// ── Auth config (trong Settings) ──────────────────────────────────
function handle_authConfig(data) {
  if (!data) return;
  const e = id => document.getElementById(id);
  if (e('auth-enabled'))  e('auth-enabled').checked = !!data.enabled;
  if (e('auth-username')) e('auth-username').value   = data.username || 'admin';
}

function saveAuthConfig() {
  const username = document.getElementById('auth-username')?.value || 'admin';
  const password = document.getElementById('auth-password')?.value || '';
  const enabled  = document.getElementById('auth-enabled')?.checked || false;
  sendCmd('saveAuthConfig', { patch: { enabled, username, password } });
  showSavedMsg('auth-saved-msg');
  if (password) document.getElementById('auth-password').value = '';
}

// ── History record detail ─────────────────────────────────────────
function viewHistoryRecord(id) { sendCmd('getHistoryRecord', { id }); }

function handle_historyRecord(data) {
  if (!data) return;
  let overlay = document.getElementById('record-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'record-overlay';
    overlay.className = 'record-overlay';
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="record-dialog">
      <div class="record-dialog-hdr">
        <span class="fw-bold">📦 Chi tiết acc #${data.id}</span>
        <button class="btn-close" onclick="document.getElementById('record-overlay').remove()">✕</button>
      </div>
      <div class="record-meta">${data.site} | ${data.username} | ${new Date(data.time).toLocaleString('vi')} | ${(data.price||0).toLocaleString('vi')}₫</div>
      <pre class="record-body">${JSON.stringify(data.data||{},null,2)||'Không có dữ liệu'}</pre>
    </div>`;
}

// ── Multi-Scheduler ───────────────────────────────────────────────
let _multiSchedData = [];

function handle_multiSchedule(data) { _multiSchedData = data || []; renderMultiSched(); }

function renderMultiSched() {
  const list   = document.getElementById('ms-list');
  if (!list) return;
  const active = _multiSchedData.filter(s => s.state === 'pending' || s.state === 'prewarm');
  const done   = _multiSchedData.filter(s => s.state === 'fired'   || s.state === 'cancelled');
  if (!_multiSchedData.length) { list.innerHTML = '<div class="no-data">Chưa có lịch nào</div>'; return; }
  list.innerHTML =
    active.map(s => `
      <div class="ms-slot ms-slot-${s.state}">
        <div class="ms-slot-top">
          <span class="ms-slot-label">${s.label}</span>
          <span class="badge ${s.state==='prewarm'?'badge-run':'badge-idle'}">${s.state==='prewarm'?'🔄 Pre-warm':'⏳ Chờ'}</span>
        </div>
        <div class="ms-slot-meta">${new Date(s.targetTime).toLocaleString('vi')} · còn ${formatCountdown(s.remainingMs)}</div>
        <button class="btn-d btn-xs" onclick="sendCmd('cancelMultiSchedule',{id:'${s.id}'})">✕ Huỷ</button>
      </div>`).join('') +
    (done.length ? `<div class="hint" style="margin-top:8px">${done.length} lịch đã hoàn thành/huỷ</div>` : '');
}

function addMultiSchedule() {
  const timeEl    = document.getElementById('ms-time');
  const labelEl   = document.getElementById('ms-label');
  const siteEl    = document.getElementById('ms-site');
  const prewarmEl = document.getElementById('ms-prewarm');
  if (!timeEl?.value) { timeEl?.classList.add('err'); return; }
  timeEl.classList.remove('err');
  sendCmd('addMultiSchedule', { entry: {
    siteId:     siteEl?.value || '',
    label:      labelEl?.value.trim() || siteEl?.options[siteEl.selectedIndex]?.text || '',
    targetTime: timeEl.value,
    prewarmSec: Number(prewarmEl?.value || 30),
  }});
  if (timeEl)  timeEl.value  = '';
  if (labelEl) labelEl.value = '';
}

// ── Account Health ────────────────────────────────────────────────
let _healthData       = [];
let _retryPresetsData = {};

function loadHealthTab() { sendCmd('getAccountHealth'); sendCmd('getRetryPresets'); }

function handle_accountHealth(data) { _healthData = data || []; renderHealthList(); }
function handle_retryPresets(data)  { _retryPresetsData = data || {}; }

function renderHealthList() {
  const el = document.getElementById('health-list');
  if (!el) return;
  if (!_healthData.length) { el.innerHTML = '<div class="no-data">Chưa có dữ liệu health (cần Start All trước)</div>'; return; }
  el.innerHTML = _healthData.map(a => {
    const color    = a.score >= 70 ? 'var(--g)' : a.score >= 40 ? 'var(--y)' : 'var(--r)';
    const trendIcon = { improving: '📈', degrading: '📉' }[a.trend] || '➡️';
    const uptime   = a.uptime ? Math.floor(a.uptime / 60000) + 'm' : '—';
    return `
      <div class="health-row">
        <div class="health-key">${a.key.replace('__',' / ')}</div>
        <div class="health-score" style="color:${color}">${a.score}</div>
        <div class="health-trend">${trendIcon} ${a.trend}</div>
        <div class="health-uptime">⏱ ${uptime}</div>
        <div class="health-bar-wrap"><div class="health-bar" style="width:${a.score}%;background:${color}"></div></div>
      </div>`;
  }).join('');
}

// ── Retry Strategy ────────────────────────────────────────────────
const RETRY_PRESET_VALUES = {
  aggressive: { type: 'exponential', baseDelay: 1000, maxDelay: 30000, maxRetries: 15, jitter: 500 },
  default:    { type: 'exponential', baseDelay: 3000, maxDelay: 60000, maxRetries: 10, jitter: 0   },
  patient:    { type: 'linear',      baseDelay: 5000, maxDelay: 60000, maxRetries: 8,  jitter: 0   },
  stepped:    { type: 'stepped',     baseDelay: 2000, maxDelay: 60000, maxRetries: 10, jitter: 0   },
};

function applyRetryPreset() {
  const p = RETRY_PRESET_VALUES[document.getElementById('retry-preset')?.value];
  if (!p) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('retry-type', p.type); set('retry-base', p.baseDelay); set('retry-max', p.maxDelay);
  set('retry-count', p.maxRetries); set('retry-jitter', p.jitter || 0);
}

function loadRetryForSite() { document.getElementById('retry-preset').value = ''; }

function saveRetryStrategy() {
  const siteId = document.getElementById('retry-site')?.value;
  if (!siteId) return;
  const get = id => document.getElementById(id)?.value;
  sendCmd('saveRetryStrategy', { siteId, strategy: {
    type:       get('retry-type') || 'exponential',
    baseDelay:  Number(get('retry-base')   || 3000),
    maxDelay:   Number(get('retry-max')    || 60000),
    maxRetries: Number(get('retry-count')  || 10),
    jitter:     Number(get('retry-jitter') || 0),
  }});
  showSavedMsg('retry-saved-msg');
}

// ── Webhook ───────────────────────────────────────────────────────
function handle_webhookConfig(data) {
  if (!data) return;
  const set = (id, v) => { const el = document.getElementById(id); if (!el) return; el.type === 'checkbox' ? (el.checked = !!v) : (el.value = v ?? ''); };
  set('wh-enabled',  data.enabled);
  set('wh-url',      data.url);
  set('wh-format',   data.format || 'generic');
  const ev = data.events || {};
  set('wh-ev-bought', ev.onBought); set('wh-ev-error', ev.onError);
  set('wh-ev-start',  ev.onStart);  set('wh-ev-stop',  ev.onStop); set('wh-ev-money', ev.onOutOfMoney);
}

function saveWebhookConfig() {
  const get = id => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
  sendCmd('saveWebhookConfig', { patch: {
    enabled: get('wh-enabled'), url: get('wh-url'), format: get('wh-format'),
    events: { onBought: get('wh-ev-bought'), onError: get('wh-ev-error'), onStart: get('wh-ev-start'), onStop: get('wh-ev-stop'), onOutOfMoney: get('wh-ev-money') },
  }});
  showSavedMsg('wh-saved-msg');
}

function testWebhook() { sendCmd('testWebhook'); }

connect();
