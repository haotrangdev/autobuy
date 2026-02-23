'use strict';

let express, http, WebSocket;
try {
  express   = require('express');
  http      = require('http');
  WebSocket = require('ws');
} catch {
  console.error('Thiếu thư viện: npm install express ws');
  process.exit(1);
}

const fs   = require('fs');
const path = require('path');

// ─── Optional feature modules ─────────────────────────────────────
let webhookNotifier, ConfigWatcher, MultiScheduler, createExportRoutes, registry, PRESETS;
try { ({ webhookNotifier }    = require('./webhook'));          } catch {}
try { ({ ConfigWatcher }      = require('../hot-reload'));       } catch {}
try { ({ MultiScheduler }     = require('../multi-scheduler'));  } catch {}
try { ({ createExportRoutes } = require('./export-manager'));   } catch {}
try { ({ registry }           = require('../account-health'));   } catch {}
try { ({ PRESETS }            = require('../retry-strategy'));   } catch {}

// ─── Helpers ──────────────────────────────────────────────────────
const ts       = () => new Date().toTimeString().slice(0, 8);
const logMsg   = (text, cls = '') => ({ type: 'log', text: `[${ts()}] ${text}`, cls });
const siteInfo = s => ({ id: s.id, name: s.name, hostname: s.hostname });

function logClass(msg) {
  if (msg.includes('🎉'))                                                  return 's';
  if (msg.includes('🔥'))                                                  return 'f';
  if (msg.includes('⚠'))                                                   return 'w';
  if (msg.includes('❌') || msg.includes('✕') || msg.includes('HẾT TIỀN')) return 'e';
  if (msg.includes('✓')  || msg.includes('📡'))                            return 'i';
  return '';
}

// ─── Static assets (inlined at startup) ──────────────────────────
const UI_DIR = __dirname;
const HTML = fs.readFileSync(path.join(UI_DIR, 'ui-template.html'), 'utf8')
  .replace('<link rel="stylesheet" href="ui-style.css">',
           '<style>'  + fs.readFileSync(path.join(UI_DIR, 'ui-style.css'),  'utf8') + '</style>')
  .replace('<script src="ui-client.js"></script>',
           '<script>' + fs.readFileSync(path.join(UI_DIR, 'ui-client.js'),  'utf8') + '</script>');

const RUNTIME_KEYS = [
  'maxPrice', 'maxBuy', 'fetchLimit',
  'retryNormal', 'retrySale', 'jitter', 'cooldownAfter429', 'emptyThreshold',
];

// ─── createWebUI ──────────────────────────────────────────────────
function createWebUI(sites, uiCfg, historyManager, saveOverrideFn, loadOverrideFn, callbacks) {
  callbacks = callbacks || {};
  // Support legacy 5-arg form: createWebUI(sites, uiCfg, hist, saveFn, callbacks)
  if (typeof loadOverrideFn === 'object' && !Array.isArray(loadOverrideFn)) {
    callbacks      = loadOverrideFn;
    loadOverrideFn = () => { try { return require('../sites').loadOverride(); } catch { return {}; } };
  }

  const app     = express();
  const server  = http.createServer(app);
  const wss     = new WebSocket.Server({ server });
  const clients = new Set();
  const accountStates   = {};
  const logBuffer       = [];
  const LOG_BUFFER_SIZE = 300;

  // ── Hot reload ────────────────────────────────────────────────
  const configWatcher = ConfigWatcher ? new ConfigWatcher(sites, () => {
    try { require('../sites').applyOverrides(); } catch {}
  }) : null;

  if (configWatcher) {
    configWatcher.on('change', ev => {
      broadcast(logMsg(`🔄 Hot reload: ${ev.siteId} → ${Object.keys(ev.patch).join(', ')}`, 'i'));
      const site = sites.find(s => s.id === ev.siteId);
      if (site) broadcast({ type: 'config', data: site });
    });
    configWatcher.start();
  }

  // ── Multi-scheduler ───────────────────────────────────────────
  const multiScheduler = callbacks.multiScheduler || (MultiScheduler ? new MultiScheduler({
    onStart:     ev => { broadcast(logMsg(`⏰ [Multi] Start: ${ev.slot.label}`, 'i')); callbacks.onStartSite?.(ev); },
    onPrewarm:   ev => broadcast(logMsg(`🔄 Pre-warm: ${ev.slot.label}`, 'i')),
    onCountdown: ()  => { if (clients.size) broadcast({ type: 'multiSchedule', data: multiScheduler.getStatus() }); },
    onCancel:    ev => broadcast(logMsg(`↺ Huỷ lịch: ${ev.slot.label}`, 'w')),
  }) : null);
  multiScheduler?.restore?.();

  // ── Core helpers ──────────────────────────────────────────────
  function broadcast(msg) {
    if (msg.type === 'log') {
      logBuffer.push(msg);
      if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    }
    const payload = JSON.stringify(msg);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  const sendTo = (ws, msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // ── Auth middleware ───────────────────────────────────────────
  try {
    const auth   = require('../auth');
    const remote = uiCfg.remote || false;
    app.use(auth.createAuthMiddleware(remote));
    server.on('upgrade', (req, socket) => {
      if (!auth.checkWsAuth(req, remote)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      }
    });
  } catch {}

  // ── Routes ───────────────────────────────────────────────────
  app.get('/', (_req, res) => res.send(HTML));

  app.get('/api/stats', (req, res) => {
    try { res.json(require('../logger').logger.getStats(Math.min(parseInt(req.query.days || '1', 10), 30))); }
    catch { res.json({ error: 'Logger not available' }); }
  });

  app.get('/api/health',        (_req, res) => res.json(registry ? registry.snapshot() : []));
  app.get('/api/retry-presets', (_req, res) => res.json(PRESETS || {}));

  // Export routes
  if (typeof historyManager.attachExportRoutes === 'function') {
    historyManager.attachExportRoutes(app);
  } else if (createExportRoutes) {
    app.use(createExportRoutes(historyManager));
  } else {
    app.get('/export.csv', (req, res) => {
      const filter = { site: req.query.site, username: req.query.username, from: req.query.from, to: req.query.to };
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="history_${Date.now()}.csv"`);
      res.send('\uFEFF' + historyManager.toCSV(filter));
    });
  }

  // ── WS message handler ────────────────────────────────────────
  function handleClientMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { cmd, siteId, patch, filter } = msg;

    // Helper: resolve notifier (prefers unified notifier.js, falls back to webhookNotifier)
    const getNotifier = () => { try { return require('../notifier').notifier; } catch { return null; } };

    // Helper: build export URL
    const exportUrl = (filename, qs) => {
      const host  = uiCfg.remote ? '<IP>' : 'localhost';
      const query = qs ? '?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v)).toString() : '';
      return `http://${host}:${uiCfg.webPort}/${filename}${query}`;
    };

    switch (cmd) {

      case 'startAll':
        broadcast({ type: 'cmd', cmd: 'start' });
        callbacks.onStartAll?.();
        break;

      case 'stopAll':
        broadcast({ type: 'cmd', cmd: 'stop' });
        callbacks.onStopAll?.();
        break;

      case 'getConfig': {
        const site = siteId && sites.find(s => s.id === siteId);
        if (site) sendTo(ws, { type: 'config', data: site });
        break;
      }

      case 'saveConfig': {
        if (!siteId || !patch) break;
        saveOverrideFn(siteId, patch);
        const site = sites.find(s => s.id === siteId);
        if (site) {
          for (const key of RUNTIME_KEYS) if (patch[key] !== undefined) site[key] = patch[key];
          if (patch.accounts)      site.accounts      = patch.accounts;
          if (patch.retryStrategy) site.retryStrategy = patch.retryStrategy;
          broadcast({ type: 'config', data: site });
        }
        broadcast(logMsg(`✓ Đã lưu config: ${siteId}`, 'i'));
        break;
      }

      case 'resetConfig': {
        if (!siteId) break;
        const ov = loadOverrideFn();
        delete ov[siteId];
        try { fs.writeFileSync('config.override.json', JSON.stringify(ov, null, 2)); } catch {}
        broadcast(logMsg(`↺ Reset config: ${siteId}`, 'w'));
        break;
      }

      case 'clearHistory':
        historyManager.clear();
        broadcast({ type: 'clearHistory' });
        break;

      case 'exportCSV':     sendTo(ws, logMsg(`⬇ CSV:     ${exportUrl('export.csv', filter)}`, 'i')); break;
      case 'exportJSON':    sendTo(ws, logMsg(`⬇ JSON:    ${exportUrl('export.json', filter)}`, 'i')); break;
      case 'exportSummary': sendTo(ws, logMsg(`⬇ Summary: ${exportUrl('export.summary')}`, 'i')); break;

      case 'getNotifierConfig': {
        const n = getNotifier();
        if (n) sendTo(ws, { type: 'notifierConfig', data: n.getConfig() });
        break;
      }

      case 'saveNotifierConfig':
        if (msg.patch) { getNotifier()?.updateConfig(msg.patch); broadcast(logMsg('✓ Đã lưu cấu hình thông báo', 'i')); }
        break;

      case 'testNotifier':
        getNotifier()?.test().then(r => {
          const ok = r.telegram || r.desktop;
          sendTo(ws, logMsg(ok ? '✓ Test thành công' : '✕ Test thất bại', ok ? 'i' : 'e'));
        });
        break;

      case 'getWebhookConfig': {
        const n = getNotifier();
        if (n)                sendTo(ws, { type: 'webhookConfig', data: n.getWebhookConfig() });
        else if (webhookNotifier) sendTo(ws, { type: 'webhookConfig', data: webhookNotifier.getConfig() });
        break;
      }

      case 'saveWebhookConfig': {
        if (!msg.patch) break;
        const n = getNotifier();
        if (n)                    n.updateWebhookConfig(msg.patch);
        else if (webhookNotifier) webhookNotifier.updateConfig(msg.patch);
        broadcast(logMsg('✓ Đã lưu webhook', 'i'));
        break;
      }

      case 'testWebhook': {
        const n  = getNotifier();
        const fn = n ? n.testWebhook.bind(n) : webhookNotifier?.test.bind(webhookNotifier);
        fn?.().then(r => sendTo(ws, logMsg(r.ok ? '✓ Webhook OK' : `✕ Webhook lỗi: ${r.error || r.status}`, r.ok ? 'i' : 'e'))).catch(() => {});
        break;
      }

      case 'getSchedule':
        sendTo(ws, { type: 'schedule', data: callbacks.scheduler?.getStatus() ?? null });
        break;

      case 'setSchedule': {
        if (!msg.targetTime || !callbacks.scheduler) break;
        const r = callbacks.scheduler.schedule(msg.targetTime, msg.prewarmSec ?? 30);
        if (r.ok) {
          broadcast(logMsg(`⏰ Lịch: ${new Date(r.targetTime).toLocaleString('vi')}`, 'i'));
          broadcast({ type: 'schedule', data: callbacks.scheduler.getStatus() });
        } else {
          sendTo(ws, logMsg(`✕ ${r.error}`, 'e'));
        }
        break;
      }

      case 'cancelSchedule':
        callbacks.scheduler?.cancel();
        broadcast(logMsg('↺ Đã huỷ lịch hẹn giờ', 'w'));
        broadcast({ type: 'schedule', data: null });
        break;

      case 'getMultiSchedule':
        sendTo(ws, { type: 'multiSchedule', data: multiScheduler?.getStatus() ?? [] });
        break;

      case 'addMultiSchedule': {
        if (!multiScheduler || !msg.entry) break;
        const r = multiScheduler.schedule(msg.entry);
        if (r.ok) {
          broadcast(logMsg(`⏰ [Multi] ${r.slot.label} → ${new Date(r.slot.targetTime).toLocaleString('vi')}`, 'i'));
          broadcast({ type: 'multiSchedule', data: multiScheduler.getStatus() });
        } else {
          sendTo(ws, logMsg(`✕ ${r.error}`, 'e'));
        }
        break;
      }

      case 'cancelMultiSchedule': {
        if (!multiScheduler || !msg.id) break;
        const ok = multiScheduler.cancel(msg.id);
        broadcast(logMsg(ok ? '↺ Đã huỷ lịch' : '✕ Không tìm thấy', ok ? 'w' : 'e'));
        broadcast({ type: 'multiSchedule', data: multiScheduler.getStatus() });
        break;
      }

      case 'cleanupMultiSchedule':
        if (multiScheduler) { multiScheduler.cleanup(); broadcast({ type: 'multiSchedule', data: multiScheduler.getStatus() }); }
        break;

      case 'getRetryPresets':
        sendTo(ws, { type: 'retryPresets', data: PRESETS || {} });
        break;

      case 'saveRetryStrategy': {
        if (!siteId || !msg.strategy) break;
        const site = sites.find(s => s.id === siteId);
        if (site) {
          site.retryStrategy = msg.strategy;
          saveOverrideFn(siteId, { retryStrategy: msg.strategy });
          broadcast(logMsg(`✓ Retry strategy: ${siteId} → ${msg.strategy.type}`, 'i'));
        }
        break;
      }

      case 'getAccountHealth':
        sendTo(ws, { type: 'accountHealth', data: registry?.snapshot() ?? [] });
        break;

      case 'addSite': {
        if (!msg.siteJson) break;
        try {
          const { buildSite } = require('../adapter');
          const newSite = buildSite(JSON.parse(msg.siteJson));
          if (sites.find(s => s.id === newSite.id)) {
            sendTo(ws, logMsg(`✕ Site ID "${newSite.id}" đã tồn tại`, 'e')); break;
          }
          if (!fs.existsSync('sites')) fs.mkdirSync('sites');
          fs.writeFileSync(`sites/${newSite.id}.json`, JSON.stringify(JSON.parse(msg.siteJson), null, 2), 'utf8');
          sites.push(newSite);
          broadcast({ type: 'sites', data: sites.map(siteInfo) });
          broadcast(logMsg(`✓ Thêm site: ${newSite.name}`, 'i'));
          sendTo(ws, { type: 'addSiteResult', ok: true, siteId: newSite.id });
        } catch (err) {
          sendTo(ws, logMsg(`✕ Lỗi: ${err.message}`, 'e'));
          sendTo(ws, { type: 'addSiteResult', ok: false, error: err.message });
        }
        break;
      }

      case 'deleteSite': {
        if (!siteId) break;
        const idx = sites.findIndex(s => s.id === siteId);
        if (idx !== -1) {
          const { name } = sites[idx];
          sites.splice(idx, 1);
          try { if (fs.existsSync(`sites/${siteId}.json`)) fs.unlinkSync(`sites/${siteId}.json`); } catch {}
          const ov = loadOverrideFn(); delete ov[siteId];
          try { fs.writeFileSync('config.override.json', JSON.stringify(ov, null, 2)); } catch {}
          broadcast({ type: 'sites', data: sites.map(siteInfo) });
          broadcast(logMsg(`🗑 Xoá site: ${name}`, 'w'));
        }
        break;
      }

      case 'getStats':
        try { sendTo(ws, { type: 'stats', data: require('../logger').logger.getStats(msg.days || 1) }); }
        catch { sendTo(ws, { type: 'stats', data: null }); }
        break;

      case 'getAuthConfig':
        try {
          const cfg = require('../auth').loadAuthConfig();
          sendTo(ws, { type: 'authConfig', data: { enabled: cfg.enabled, username: cfg.username, hasPassword: !!cfg.password } });
        } catch { sendTo(ws, { type: 'authConfig', data: null }); }
        break;

      case 'saveAuthConfig':
        if (msg.patch) {
          try {
            require('../auth').saveAuthConfig({ enabled: !!msg.patch.enabled, username: msg.patch.username || 'admin', password: msg.patch.password || '' });
            broadcast(logMsg('✓ Đã lưu auth config', 'i'));
          } catch { broadcast(logMsg('✕ Lỗi lưu auth', 'e')); }
        }
        break;

      case 'getHistoryRecord':
        if (msg.id) sendTo(ws, { type: 'historyRecord', data: historyManager.findById(Number(msg.id)) });
        break;
    }
  }

  // ── WS connection ─────────────────────────────────────────────
  wss.on('connection', ws => {
    clients.add(ws);
    sendTo(ws, { type: 'sites',   data: sites.map(siteInfo) });
    sendTo(ws, { type: 'history', data: historyManager.getAll().slice(0, 500) });
    for (const data of Object.values(accountStates)) sendTo(ws, { type: 'account', data });
    if (logBuffer.length)                   sendTo(ws, { type: 'logBatch',     data: logBuffer });
    if (callbacks.scheduler?.isScheduled()) sendTo(ws, { type: 'schedule',     data: callbacks.scheduler.getStatus() });
    if (multiScheduler)                     sendTo(ws, { type: 'multiSchedule',data: multiScheduler.getStatus() });
    if (registry)                           sendTo(ws, { type: 'accountHealth',data: registry.snapshot() });
    if (PRESETS)                            sendTo(ws, { type: 'retryPresets', data: PRESETS });
    ws.on('message', raw => handleClientMessage(ws, raw));
    ws.on('close',   ()  => clients.delete(ws));
  });

  // ── Listen ────────────────────────────────────────────────────
  const host = uiCfg.remote ? '0.0.0.0' : '127.0.0.1';
  server.listen(uiCfg.webPort, host, () => {
    console.log(`🌐 Web UI: ${uiCfg.remote ? `http://<IP>:${uiCfg.webPort}` : `http://localhost:${uiCfg.webPort}`}`);
    callbacks.onListen?.();
  });

  // Health broadcast every 10s
  if (registry) {
    const ht = setInterval(() => {
      if (clients.size) broadcast({ type: 'accountHealth', data: registry.snapshot() });
    }, 10000);
    ht.unref?.();
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    log(msg, site = '', user = '') {
      broadcast({ type: 'log', text: `[${ts()}] ${msg}`, cls: logClass(msg), site, user });
    },

    updateAccount(data) {
      const key = `${data.site}__${data.username}`;
      accountStates[key] = Object.assign(accountStates[key] || {}, data);
      broadcast({ type: 'account', data });
      registry?.record(key, data.running ? 'start' : 'stop');
    },

    notifyBought(data) {
      broadcast({ type: 'bought',  data });
      broadcast({ type: 'history', data: historyManager.getAll().slice(0, 500) });
      const key = `${data.site}__${data.username}`;
      registry?.record(key, 'buy');
      webhookNotifier?.send('onBought', {
        title:   '🎉 Mua được acc!',
        message: `${data.site} | ${data.username} | ${(data.price || 0).toLocaleString('vi')}₫`,
        ...data,
      }).catch(() => {});
    },

    notify429(siteId, username)     { registry?.record(`${siteId}__${username}`, '429'); },
    notifyRestart(siteId, username) { registry?.record(`${siteId}__${username}`, 'restart'); },
    watchEngine(siteId, engine)     { configWatcher?.subscribe(siteId, engine); },
    unwatch(siteId, engine)         { configWatcher?.unsubscribe(siteId, engine); },
    destroy()                       { server.close(); configWatcher?.stop(); },

    configWatcher,
    multiScheduler,
  };
}

module.exports = { createWebUI };
