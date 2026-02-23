// ══════════════════════════════════════════════════════════════════
//  pm2.config.js – Chạy AutoBuy như background service với PM2
//
//  Cài PM2:       npm install -g pm2
//  Khởi động:     pm2 start pm2.config.js
//  Xem log:       pm2 logs autobuy
//  Dừng (clean):  pm2 stop autobuy       ← gửi SIGTERM → graceful shutdown
//  Restart:       pm2 restart autobuy
//  Auto-start:    pm2 startup && pm2 save
//  Dashboard:     pm2 monit
//
//  Files được tạo khi chạy:
//    logs/events.jsonl   – structured event log (mua, rate limit, restart...)
//    logs/pm2-out.log    – stdout
//    logs/pm2-err.log    – stderr
//    history.json        – lịch sử mua hàng
//    config.override.json – override settings từ Web UI
//    notifier.json       – Telegram config
//    scheduler.json      – lịch hẹn giờ (tự xoá sau khi fire)
//    auth.json           – Web UI auth config
//    tokens_*.json       – JWT tokens per account
//    cookies_*.json      – Puppeteer cookies per account
// ══════════════════════════════════════════════════════════════════

module.exports = {
  apps: [{
    name:   'autobuy',
    script: 'index.js',
    cwd:    __dirname,

    // ── Restart policy ──────────────────────────────────────────
    autorestart:   true,
    max_restarts:  20,
    min_uptime:    '10s',    // phải chạy ít nhất 10s mới tính là stable
    restart_delay: 3000,     // chờ 3s trước khi restart

    // exit code 0 = thoát bình thường (hết tiền / đủ acc) → không restart
    stop_exit_codes: [0],

    // PM2 gửi SIGTERM trước khi kill → graceful shutdown có 5s để cleanup
    kill_timeout:  5000,
    listen_timeout: 10000,

    // ── Logging ─────────────────────────────────────────────────
    output:          'logs/pm2-out.log',
    error:           'logs/pm2-err.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs:      true,
    // Rotate log khi > 10MB (cần pm2-logrotate: npm install -g pm2-logrotate)
    max_size:        '10M',
    retain:          7,      // giữ 7 file log cũ

    // ── Memory guard ────────────────────────────────────────────
    // Puppeteer dễ leak memory nếu browser không được close đúng cách
    max_memory_restart: '600M',

    // ── Process model ───────────────────────────────────────────
    instances:  1,
    exec_mode:  'fork',   // KHÔNG dùng cluster — WebSocket cần single instance

    // ── Environment ─────────────────────────────────────────────
    env: {
      NODE_ENV:    'production',
      // UI_MODE mặc định đọc từ sites/*.json → ui.uiMode
      // Override ở đây nếu cần:
      // UI_MODE: 'web',
    },

    env_development: {
      NODE_ENV: 'development',
    },
  }],
};