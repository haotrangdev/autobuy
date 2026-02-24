# Hướng dẫn cài đặt

## Yêu cầu

- **Node.js** >= 18 (khuyến nghị 20 LTS) — kiểm tra: `node -v`
- **npm** >= 8
- **Chrome/Chromium** — Puppeteer tự download, hoặc chỉ định `PUPPETEER_EXECUTABLE_PATH`
- Windows 10/11, macOS 12+, hoặc Ubuntu 20.04+

---

## 1. Cài đặt Node.js

### Windows
Tải từ https://nodejs.org hoặc dùng nvm-windows:
```powershell
winget install CoreyButler.NVMforWindows
nvm install 20
nvm use 20
```

### macOS
```bash
brew install nvm
nvm install 20 && nvm use 20
```

### Linux (Ubuntu/Debian)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## 2. Clone và cài dependencies

```bash
git clone <repo-url>
cd autobuy
npm install
```

---

## 3. Tạo site config

```bash
cp sites/example.json sites/mysite.json
```

Sửa `sites/mysite.json`:

```json
{
  "id":       "mysite",
  "name":     "My Site",
  "hostname": "mysite.com",
  "maxPrice": 500000,
  "accounts": [
    {
      "username": "email@example.com",
      "password": "matkhau123",
      "label":    "Acc chính",
      "enabled":  true
    }
  ]
}
```

---

## 4. Chạy

```bash
npm start
# Web UI tại: http://localhost:3000
```

---

## 5. Cấu hình nâng cao

### Đổi port / bật remote access

Trong `sites/mysite.json`:
```json
"ui": {
  "webPort": 8080,
  "remote": true
}
```

Khi `remote: true`, bắt buộc tạo `auth.json`:
```json
{ "enabled": true, "username": "admin", "password": "matkhaumanhme" }
```

### Telegram notification

Tạo bot qua @BotFather, lấy `botToken` và `chatId`, vào tab **🔔 Thông báo** trên Web UI.

### Chạy bằng Docker

```bash
# Copy và sửa sites config
cp sites/example.json sites/mysite.json

# Chạy
docker compose up -d

# Xem log
docker compose logs -f
```

---

## 6. Cấu trúc thư mục runtime

Sau khi chạy lần đầu, các file này sẽ được tạo tự động:

```
autobuy/
├── logs/events.jsonl      # Event log (tự rotate khi > 50MB)
├── history.json           # Lịch sử mua hàng
├── sessions/              # Puppeteer session cache
├── notifier.json          # Config Telegram/Webhook (tạo qua UI)
├── auth.json              # Auth config (tạo qua UI)
├── config.override.json   # Override config per-site (tạo qua UI)
├── scheduler.json         # Lịch hẹn giờ (tự tạo/xoá)
└── multi-scheduler.json   # Multi-site scheduler state
```

**Không commit các file này lên git** — đã được `.gitignore` handle.
