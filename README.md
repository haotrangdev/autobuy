# ⚡ AutoBuy Bot

Bot tự động mua hàng flash sale với Web UI, multi-account, scheduler và Telegram notification.

## Tính năng

- **Multi-account** — chạy song song nhiều tài khoản trên nhiều site
- **Web UI** — dashboard real-time qua browser, không cần cài thêm gì
- **Electron** — desktop app với system tray
- **Terminal UI** — full-screen dashboard trong terminal (dùng blessed)
- **Scheduler** — hẹn giờ tự động start (single + per-site)
- **Retry strategy** — linear / exponential / stepped, config per-site
- **Adaptive rate limit** — tự động giảm tốc khi bị 429, rotate sang account khỏe
- **Telegram / Webhook / Desktop** notification khi mua được
- **Session health** — proactive ping để detect session hết hạn trước khi bị lỗi
- **Hot reload** — thay đổi config không cần restart
- **Export** — lịch sử mua dạng CSV / JSON / JSONL / Summary

## Cài đặt

```bash
# Clone và cài dependencies
git clone <repo-url>
cd autobuy
npm install

# Copy env template
cp .env.example .env

# Tạo site config (xem hướng dẫn bên dưới)
cp sites/example.json sites/mysite.json
# Sửa sites/mysite.json với thông tin site thực
```

## Cấu hình site

Mỗi site là 1 file JSON trong thư mục `sites/`. Xem `sites/example.json` để biết cấu trúc đầy đủ.

```json
{
  "id": "mysite",
  "name": "My Site",
  "hostname": "mysite.com",
  "maxPrice": 500000,
  "accounts": [
    { "username": "user@email.com", "password": "pass", "enabled": true }
  ]
}
```

## Chạy

```bash
# Web UI mode (mặc định)
npm start
# → mở http://localhost:3000

# Terminal UI
npm run start:terminal

# Electron desktop app
npm run start:electron

# Chỉ định mode qua env
UI_MODE=web npm start
```

## Test

```bash
npm test                # run tất cả tests
npm run test:verbose    # output chi tiết
```

## Cấu trúc project

```
autobuy/
├── index.js              # Entry point, dispatch web/terminal/electron
├── core.js               # BuyEngine — logic mua hàng chính
├── watchdog.js           # Watchdog — retry/restart engine khi crash
├── adapter.js            # Chuyển JSON site config → JS functions
├── sites.js              # Load + scan sites/ directory
├── history.js            # Lịch sử mua + export CSV/JSON/JSONL
├── logger.js             # Structured logging (JSONL)
├── notifier.js           # Telegram + Webhook + Desktop notification
├── scheduler.js          # Hẹn giờ single-shot
├── multi-scheduler.js    # Hẹn giờ per-site
├── auth.js               # Basic auth cho Web UI
├── retry-strategy.js     # Pluggable retry strategies
├── adaptive-limiter.js   # Per-account adaptive rate limiter
├── account-health.js     # Health score + trend per account
├── session-health.js     # Proactive session ping monitor
├── session-pool.js       # Session pool management
├── hot-reload.js         # Config hot reload
│
├── ui-web/               # Web UI (Express + WebSocket)
│   ├── ui-web.js
│   ├── ui-template.html
│   ├── ui-style.css
│   └── ui-client.js
│
├── ui-terminal.js        # Terminal UI (blessed)
│
├── electron/             # Electron wrapper
│   ├── main.js
│   └── preload.js
│
├── sites/                # Site configs (*.json, không commit)
│   └── example.json      # Template
│
├── tests/                # Test suite (node:test)
│   └── *.test.js
│
└── logs/                 # Event logs (auto-created, không commit)
```

## Biến môi trường

| Biến | Mặc định | Mô tả |
|---|---|---|
| `UI_MODE` | `web` | `web` \| `terminal` \| `electron` |

Xem `.env.example` để biết thêm.

## Web UI Auth

Khi mở `remote: true` trong site config, bắt buộc phải đặt password:

```json
// auth.json (tạo thủ công hoặc qua tab Cấu hình)
{
  "enabled": true,
  "username": "admin",
  "password": "yourpassword"
}
```

## Notification

Cấu hình trong tab **🔔 Thông báo** trên Web UI, hoặc tạo `notifier.json`:

```json
{
  "telegram": {
    "enabled": true,
    "botToken": "YOUR_BOT_TOKEN",
    "chatId": "YOUR_CHAT_ID"
  }
}
```

## License

MIT
