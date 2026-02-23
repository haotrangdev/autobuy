'use strict';

// ══════════════════════════════════════════════════════════════════
//  ui-terminal.js – Full screen Terminal Dashboard (dùng blessed)
// ══════════════════════════════════════════════════════════════════

let blessed;
try {
  blessed = require('blessed');
} catch {
  console.error('Thiếu thư viện: npm install blessed');
  process.exit(1);
}

const LOG_COLOR_MAP = {
  s: 'green-fg',
  f: 'yellow-fg',
  e: 'red-fg',
  i: 'cyan-fg',
  w: 'yellow-fg',
};

const KEY_HELP    = '[Q] Thoát  [C] Xóa log  [P] Pause  [R] Reset stats  [↑↓] Cuộn';
const SCROLL_STEP = 3;

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/** Debounce screen.render() — tránh render chồng nhau trong cùng một tick */
function makeRenderer(screen) {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    setImmediate(() => { screen.render(); pending = false; });
  };
}

// ─── Widget builders ──────────────────────────────────────────────

function buildHeader(screen, hostname) {
  return blessed.box({
    top: 0, left: 0, width: '100%', height: 3,
    content: `{center}{bold}⚡ AUTOBUY – ${hostname}{/bold}{/center}`,
    tags: true,
    style: { fg: 'black', bg: 'cyan' },
    parent: screen,
  });
}

function buildStatsBox(screen) {
  return blessed.box({
    top: 3, left: 0, width: '40%', height: 12,
    label: ' 📊 Thống kê ',
    border: { type: 'line' },
    padding: { left: 1, right: 1 },
    tags: true,
    style: { border: { fg: 'cyan' }, label: { fg: 'cyan' } },
    parent: screen,
  });
}

function buildStatusBox(screen) {
  return blessed.box({
    top: 3, left: '40%', width: '60%', height: 12,
    label: ' ⚙️  Trạng thái ',
    border: { type: 'line' },
    padding: { left: 1, right: 1 },
    tags: true,
    style: { border: { fg: 'yellow' }, label: { fg: 'yellow' } },
    parent: screen,
  });
}

function buildLogBox(screen) {
  return blessed.log({
    top: 15, left: 0, width: '100%', height: '100%-18',
    label: ' 📋 Log ',
    border: { type: 'line' },
    padding: { left: 1 },
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollback: 500,
    scrollbar: { ch: '│', style: { fg: 'cyan' } },
    style: { border: { fg: 'blue' }, label: { fg: 'blue' } },
    parent: screen,
  });
}

function buildFooter(screen) {
  return blessed.box({
    bottom: 0, left: 0, width: '100%', height: 3,
    content: `{center}${KEY_HELP}{/center}`,
    tags: true,
    style: { fg: 'black', bg: 'blue' },
    parent: screen,
  });
}

// ─── Render helpers ───────────────────────────────────────────────

function renderStatsContent(statsBox, state, cfg) {
  statsBox.setContent(
    `{bold}Đã mua:{/bold}   {green-fg}${state.totalBought} acc{/green-fg}\n` +
    `{bold}Tổng chi:{/bold} {yellow-fg}${state.totalSpent.toLocaleString('vi')}₫{/yellow-fg}\n` +
    `{bold}Stock:{/bold}    {cyan-fg}${state.stock} acc{/cyan-fg}\n` +
    `{bold}Giá max:{/bold}  ${cfg.maxPrice.toLocaleString('vi')}₫\n` +
    `{bold}Thời gian:{/bold} ${formatElapsed(Date.now() - state.startTime)}\n` +
    `{bold}Paused:{/bold}   ${state.paused ? '{red-fg}■ Dừng{/red-fg}' : '{green-fg}▶ Đang chạy{/green-fg}'}`
  );
}

function renderStatusContent(statusBox, state, cfg) {
  const delayColor  = state.delay <= 100 ? 'red-fg' : 'green-fg';
  const statusColor = state.status.includes('Đang săn')   ? 'green-fg'
                    : state.status.includes('THÀNH CÔNG') ? 'yellow-fg'
                    : 'white-fg';

  statusBox.setContent(
    `{bold}Trạng thái:{/bold} {${statusColor}}${state.status}{/${statusColor}}\n` +
    `{bold}Delay:{/bold}      {${delayColor}}${state.delay}ms{/${delayColor}}\n` +
    `{bold}Host:{/bold}       ${cfg.hostname}\n` +
    `{bold}Endpoint:{/bold}   ${cfg.buyEndpoint}\n`
  );
}

// ─── Main factory ─────────────────────────────────────────────────

/**
 * Tạo Terminal UI full-screen cho một site.
 *
 * @param {object} cfg - Site config ({ hostname, maxPrice, buyEndpoint, onPauseToggle?, ... })
 * @returns {{ log, update, destroy }}
 */
function createTerminalUI(cfg) {
  const screen = blessed.screen({
    smartCSR: true,
    title: `AutoBuy – ${cfg.hostname}`,
    fullUnicode: true,
  });

  const render    = makeRenderer(screen);
  const statsBox  = buildStatsBox(screen);
  const statusBox = buildStatusBox(screen);
  const logBox    = buildLogBox(screen);

  buildHeader(screen, cfg.hostname);
  buildFooter(screen);

  // ── State ──────────────────────────────────────────────────────

  const state = {
    status:      'Đang khởi động...',
    delay:       800,
    stock:       0,
    totalBought: 0,
    totalSpent:  0,
    paused:      false,
    startTime:   Date.now(),
  };

  // dirty flag — tránh render vô ích khi không có thay đổi
  let dirty = true;

  function renderAll() {
    if (!dirty) return;
    dirty = false;
    renderStatsContent(statsBox, state, cfg);
    renderStatusContent(statusBox, state, cfg);
    render();
  }

  // Elapsed time luôn thay đổi mỗi giây → force dirty
  const statsTimer = setInterval(() => { dirty = true; renderAll(); }, 1000);
  renderAll();

  // ── Keyboard ───────────────────────────────────────────────────

  screen.key(['q', 'Q', 'C-c'], () => {
    clearInterval(statsTimer);
    screen.destroy();
    process.exit(0);
  });

  screen.key(['c', 'C'], () => { logBox.setContent(''); render(); });

  screen.key(['p', 'P'], () => {
    state.paused = !state.paused;
    // Dùng callback thay vì screen.emit — caller chủ động đăng ký
    cfg.onPauseToggle?.(state.paused);
    dirty = true;
    renderAll();
  });

  screen.key(['r', 'R'], () => {
    state.totalBought = 0;
    state.totalSpent  = 0;
    state.startTime   = Date.now();
    dirty = true;
    renderAll();
  });

  screen.key(['up'],   () => { logBox.scroll(-SCROLL_STEP); render(); });
  screen.key(['down'], () => { logBox.scroll(SCROLL_STEP);  render(); });

  screen.render();

  // ── Public API ─────────────────────────────────────────────────

  return {
    /**
     * Ghi log vào box (thay thế console.log).
     * @param {string} msg
     * @param {string} [cls] - 's' | 'f' | 'e' | 'i' | 'w'
     */
    log(msg, cls = '') {
      const color = LOG_COLOR_MAP[cls] || 'white-fg';
      logBox.log(`{gray-fg}[${ts()}]{/gray-fg} {${color}}${msg}{/${color}}`);
      render();
    },

    /**
     * Cập nhật state từ engine.
     * @param {Partial<typeof state>} patch
     */
    update(patch) {
      Object.assign(state, patch);
      dirty = true;
      renderAll();
    },

    /** Dừng timer và hủy screen. */
    destroy() {
      clearInterval(statsTimer);
      screen.destroy();
    },
  };
}

module.exports = { createTerminalUI };