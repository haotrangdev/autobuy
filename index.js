'use strict';

const fs = require('fs');
if (!fs.existsSync('logs')) fs.mkdirSync('logs');

let _globalRunnerRef = null;
let _shutdownStarted = false;

// ─── Electron mode ────────────────────────────────────────────────
if (typeof process !== 'undefined' && process.versions?.electron) {
  const { app }                                                       = require('electron');
  const { getEnabledSites, getEnabledAccounts, applyOverrides, saveOverride, loadOverride, SITES } = require('./sites');
  const { createWebUI }                                               = require('./ui-web/ui-web');
  const { HistoryManager }                                            = require('./history');
  const { BuyEngine }                                                 = require('./core');
  const { Watchdog }                                                  = require('./watchdog');
  const { createWindow, createTray, setupAppLifecycle }               = require('./electron/main');

  function buildEngineTask(site, account, ui, historyManager) {
    const tag = `[${site.id}:${account.label || account.username}]`;
    const engine = new BuyEngine(site, account, ui, tag);
    ui.web.updateAccount({
      site: site.hostname, username: account.username,
      label: account.label || account.username,
      totalBought: 0, totalSpent: 0, stock: 0, delay: site.retryNormal, running: false,
    });
    return {
      label: tag,
      fn: () => engine.run(historyManager),
      engine,
      options: {
        maxRetries:    10,
        baseDelay:     3000,
        maxDelay:      60000,
        // [2] Wire per-site retry strategy if configured
        retryStrategy: site.retryStrategy || null,
        // [5] Health key for account-health registry
        healthKey:     `${site.hostname}__${account.username}`,
        onRestart: (attempt, delay, err, label) => {
          const msg = `⟳ ${label} restart lần ${attempt} sau ${(delay / 1000).toFixed(1)}s (${err?.message?.slice(0, 60) || 'unknown'})`;
          ui.web.log(msg);
          try { require('./notifier').notifier.onError({ label, attempt, err }).catch(() => {}); } catch {}
        },
      },
    };
  }

  app.whenReady().then(() => {
    applyOverrides();
    const sites  = getEnabledSites();
    const uiCfg  = sites[0]?.ui ?? { webPort: 3000, remote: false };
    global.webPort = uiCfg.webPort;

    const historyManager = new HistoryManager();
    const ui = {};
    let runnerRef = null;

    ui.web = createWebUI(SITES, uiCfg, historyManager, saveOverride, loadOverride, {
      onStartAll() {
        if (runnerRef) return;
        applyOverrides();
        const tasks = getEnabledSites().flatMap(site =>
          getEnabledAccounts(site).map(acc => buildEngineTask(site, acc, ui, historyManager))
        );
        if (!tasks.length) {
          ui.web.log('⚠ Không có account nào được bật. Vào tab ⚙️ Cấu hình để thêm/bật account.');
          return;
        }
        runnerRef = _globalRunnerRef = Watchdog.watchAll(tasks);
        ui.web.log(`🚀 Đã khởi động ${tasks.length} engine(s).`);
        runnerRef.results.then(outcomes => {
          const dead = outcomes.filter(o => o.status === 'fulfilled').length;
          if (dead > 0) {
            const msg = `⚠️ ${dead} engine đã dừng hẳn (hết lượt retry). Kiểm tra log!`;
            ui.web.log(msg);
            try { require('./notifier').notifier._send('onError', '⚠️ Engine chết', msg, msg).catch(() => {}); } catch {}
          }
        }).finally(() => { runnerRef = _globalRunnerRef = null; });
      },
      onStopAll() {
        runnerRef?.stopAll?.();
        runnerRef = null;
      },
      onListen() {
        ui.web.log('⚡ AutoBuy (Electron). Nhấn ▶ Start All để bắt đầu.');
        setupAppLifecycle();
        createWindow();
        createTray();
      },
    });
  }).catch(err => {
    console.error('Electron bootstrap thất bại:', err);
    app.quit();
  });

  return; // stop non-electron code from running
}

// ─── Node mode ────────────────────────────────────────────────────
function getUiMode() {
  if (process.env.UI_MODE) return process.env.UI_MODE;
  try {
    const { SITES } = require('./sites');
    if (SITES[0]?.ui?.uiMode) return SITES[0].ui.uiMode;
  } catch {}
  return 'web';
}

const mode = getUiMode();

if (mode === 'electron') {
  console.log('Chạy Electron: npm start');
  process.exit(0);
}

// ─── Web mode ─────────────────────────────────────────────────────
async function runWebMode() {
  const { getEnabledSites, getEnabledAccounts, applyOverrides, saveOverride, loadOverride, SITES } = require('./sites');
  const { BuyEngine }       = require('./core');
  const { HistoryManager }  = require('./history');
  const { Watchdog }        = require('./watchdog');
  const { notifier }        = require('./notifier');
  const { Scheduler }       = require('./scheduler');

  applyOverrides();
  const sites  = getEnabledSites();
  const history = new HistoryManager();
  const uiCfg  = sites[0]?.ui || { web: true, terminal: false, webPort: 3000, remote: false };
  const ui     = {};
  let runnerRef = null;

  function buildAndStartTasks(webUI) {
    if (runnerRef) {
      webUI?.log('⚠ Engine đang chạy rồi. Bấm Stop All trước.');
      return;
    }
    applyOverrides();
    const enabledSites = getEnabledSites();
    const tasks = [];
    for (const site of enabledSites) {
      const accounts = getEnabledAccounts(site);
      if (!accounts.length) continue;
      for (const account of accounts) {
        const tag = `[${site.id}:${account.label || account.username}]`;
        const engine = new BuyEngine(site, account, ui, tag);
        webUI?.log(`  ✓ Khởi tạo engine: ${tag}`);
        ui.web?.updateAccount({
          site: site.hostname, username: account.username,
          label: account.label || account.username,
          totalBought: 0, totalSpent: 0, stock: 0, delay: site.retryNormal, running: false,
        });
        tasks.push({
          label: tag,
          fn: () => engine.run(history),
          engine,
          options: {
            maxRetries:    10,
            baseDelay:     3000,
            maxDelay:      60000,
            // [2] Wire per-site retry strategy if configured
            retryStrategy: site.retryStrategy || null,
            // [5] Health key for account-health registry
            healthKey:     `${site.hostname}__${account.username}`,
            onRestart: (attempt, delay, err, label) => {
              const msg = `⟳ ${label} restart lần ${attempt} após ${(delay / 1000).toFixed(1)}s (${err?.message?.slice(0, 60) || 'unknown'})`;
              console.log(msg);
              ui.web?.log(msg);
              notifier.onError({ label, attempt, err }).catch(() => {});
            },
          },
        });
      }
    }
    if (!tasks.length) {
      webUI?.log('⚠ Không có account nào được bật. Vào tab ⚙️ Cấu hình để thêm/bật account.');
      return;
    }
    runnerRef = _globalRunnerRef = Watchdog.watchAll(tasks);
    webUI.log(`🚀 Đã khởi động ${tasks.length} engine(s).`);
    notifier.onStart({ count: tasks.length }).catch(() => {});
    runnerRef.results.then(outcomes => {
      const dead = outcomes.filter(o => o.status === 'fulfilled').length;
      if (dead > 0) {
        const msg = `⚠️ ${dead} engine đã dừng hẳn (hết lượt retry). Kiểm tra log!`;
        webUI.log(msg);
        try { require('./notifier').notifier._send('onError', '⚠️ Engine chết', msg, msg).catch(() => {}); } catch {}
      }
    }).finally(() => { runnerRef = _globalRunnerRef = null; });
  }

  const scheduler = new Scheduler({
    onStart:     () => { ui.web?.log('⏰ Đến giờ! Tự động Start All...'); buildAndStartTasks(ui.web); },
    onCountdown: (remainingMs) => { require('./ui-web-internal')?.broadcastSchedule?.({ remainingMs }); },
    onCancel:    () => ui.web?.log('↺ Đã huỷ lịch hẹn giờ'),
    onPrewarm:   () => ui.web?.log('🔄 Pre-warm: khởi động session trước giờ start...'),
  });
  scheduler.restore();

  const { createWebUI } = require('./ui-web/ui-web');
  ui.web = createWebUI(SITES, uiCfg, history, saveOverride, loadOverride, {
    scheduler,
    onStartAll: () => buildAndStartTasks(ui.web),
    onStopAll: () => {
      runnerRef?.stopAll?.();
      runnerRef = _globalRunnerRef = null;
      notifier.onStop().catch(() => {});
      ui.web.log('⏹ Đã dừng tất cả engine.');
    },
    onListen: () => ui.web.log('⚡ Server sẵn sàng. Nhấn ▶ Start All để bắt đầu.'),
  });

  if (!sites.length) {
    ui.web.log('⚠ Không có site nào được kích hoạt. Kiểm tra sites/ và bật ít nhất 1 account.');
    return;
  }

  for (const site of sites) {
    const accounts = getEnabledAccounts(site);
    if (accounts.length) console.log(`\n📌 ${site.name} | ${accounts.length} account(s)`);
  }
  console.log(`\n🌐 Web UI: http://localhost:${uiCfg.webPort}`);
}

// ─── Terminal mode ────────────────────────────────────────────────
async function runTerminalMode() {
  const { getEnabledSites, getEnabledAccounts, applyOverrides, saveOverride, SITES } = require('./sites');
  const { BuyEngine }       = require('./core');
  const { HistoryManager }  = require('./history');
  const { Watchdog }        = require('./watchdog');
  const { createTerminalUI } = require('./ui-terminal');

  applyOverrides();
  const sites   = getEnabledSites();
  const history = new HistoryManager();
  const uiCfg   = sites[0]?.ui || { web: false, terminal: true, webPort: 3000, remote: false };

  if (!sites.length) { console.error('✕ Không có site nào được kích hoạt'); process.exit(1); }

  const ui = { terminal: createTerminalUI(sites[0]) };
  let runnerRef = null;

  if (uiCfg.web) {
    const { createWebUI } = require('./ui-web/ui-web');
    ui.web = createWebUI(SITES, uiCfg, history, saveOverride, { onStopAll: () => runnerRef?.stopAll?.() });
  }

  const tasks = [];
  for (const site of sites) {
    const accounts = getEnabledAccounts(site);
    if (!accounts.length) continue;
    console.log(`\n📌 ${site.name} | ${accounts.length} account(s)`);
    for (const account of accounts) {
      const tag = `[${site.id}:${account.label || account.username}]`;
      const engine = new BuyEngine(site, account, ui, tag);
      console.log(`  ✓ ${tag} → ${account.username}`);
      ui.web?.updateAccount({
        site: site.hostname, username: account.username,
        label: account.label || account.username,
        totalBought: 0, totalSpent: 0, stock: 0, delay: site.retryNormal, running: false,
      });
      tasks.push({
        label: tag,
        fn: () => engine.run(history),
        engine,
        options: {
          maxRetries: 10, baseDelay: 3000, maxDelay: 60000,
          onRestart: (attempt, delay, err, label) => {
            const msg = `⟳ ${label} restart lần ${attempt} sau ${delay / 1000}s (${err?.message?.slice(0, 60) || 'unknown'})`;
            console.log(msg);
            ui.web?.log(msg);
            ui.terminal?.log(msg);
          },
        },
      });
    }
  }

  if (!tasks.length) { console.error('✕ Không có task nào để chạy'); process.exit(1); }

  console.log(`\n🚀 Khởi động ${tasks.length} engine(s) (Terminal UI)...\n`);
  runnerRef = Watchdog.watchAll(tasks);
  await runnerRef.results;
  console.log('\n✅ Tất cả engine đã kết thúc.');
  if (!uiCfg.terminal) setTimeout(() => process.exit(0), 5000);
}

// ─── Graceful shutdown ────────────────────────────────────────────
function gracefulShutdown(signal) {
  if (_shutdownStarted) return;
  _shutdownStarted = true;
  console.log(`\n[shutdown] Nhận ${signal} — đang dừng engine...`);
  try {
    _globalRunnerRef?.stopAll();
    try { require('./logger').logger.close(); } catch {}
    try {
      require('./notifier').notifier.onStop().catch(() => {}).finally(() => {
        console.log('[shutdown] Hoàn tất. Bye!');
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 3000);
    } catch { process.exit(0); }
  } catch { process.exit(0); }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', err => {
  console.error('[fatal] uncaughtException:', err.message);
  try { require('./logger').logger.error('process', 'uncaught', err.message); } catch {}
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', reason => {
  console.error('[fatal] unhandledRejection:', reason?.message || reason);
  try { require('./logger').logger.error('process', 'unhandled', String(reason?.message || reason)); } catch {}
});

// ─── Dispatch ─────────────────────────────────────────────────────
const modeRunners = { web: runWebMode, terminal: runTerminalMode };
const runner = modeRunners[mode];
if (!runner) {
  console.error(`✕ UI mode không hợp lệ: ${mode}. Dùng: web | terminal | electron`);
  process.exit(1);
}
runner().catch(err => { console.error('Fatal:', err); process.exit(1); });
