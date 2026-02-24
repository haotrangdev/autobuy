# Changelog

Tất cả thay đổi đáng chú ý của project được ghi lại tại đây.

Format theo [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
versioning theo [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- Test suite đầy đủ dùng Node.js built-in `node:test` (177 tests)
- `.gitignore`, `package.json`, `README.md`, GitHub Actions CI/CD

---

## [1.0.0] - 2025-01-01

### Added
- **Core engine** (`core.js`) — BuyEngine với Puppeteer session
- **Watchdog** (`watchdog.js`) — tự động restart engine khi crash
- **Web UI** — dashboard real-time (Express + WebSocket)
- **Multi-account** — chạy song song nhiều tài khoản
- **Scheduler** — hẹn giờ single-shot với pre-warm
- **Multi-scheduler** — hẹn giờ per-site độc lập
- **Retry strategy** — linear / exponential / stepped, config per-site
- **Adaptive rate limiter** — tự điều chỉnh delay theo 429 history
- **Account health** — health score + trend per account
- **Session health monitor** — proactive ping để detect expired session
- **Notifier** — Telegram + Webhook (Discord/Slack) + Desktop notification
- **History** — lưu lịch sử mua, export CSV / JSON / JSONL / Summary
- **Logger** — structured logging (JSON Lines) với rotation
- **Auth** — HTTP Basic Auth cho Web UI khi remote
- **Hot reload** — thay đổi config không cần restart
- **Terminal UI** — full-screen dashboard dùng `blessed`
- **Electron** — desktop app với system tray
- **Adapter** — JSON-driven site config, không cần code per-site
