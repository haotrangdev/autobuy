# ⚡ AutoBuy

Tool tự động mua acc trên các web flash sale. Hỗ trợ multi-account, multi-site, Web UI realtime, Telegram notification, hẹn giờ, và analytics.

---

## 📋 Yêu cầu

- Node.js 18+
- Chrome / Chromium (cho Puppeteer login)
- npm

---

## 🚀 Cài đặt lần đầu

```bash
# 1. Clone / copy project vào thư mục
cd autobuy

# 2. Cài dependencies
npm install

# 3. Cấu hình site đầu tiên
# Sửa file sites/lychuotbach.json — điền thông tin account:
#   "accounts": [{ "username": "user", "password": "pass", "label": "Acc1", "enabled": true }]

# 4. Chạy
npm run web
# Mở trình duyệt: http://localhost:3000
```

---

## 📁 Cấu trúc thư mục

```
autobuy/
├── index.js              # Entry point
├── core.js               # BuyEngine — vòng lặp mua
├── adapter.js            # Chuyển JSON site config → site object
├── sites.js              # Load sites từ sites/*.json
├── watchdog.js           # Auto-restart engine khi crash
├── session-pool.js       # Quản lý session dùng chung, tránh race condition
├── notifier.js           # Telegram + Desktop notification
├── scheduler.js          # Hẹn giờ tự động Start All
├── logger.js             # Structured logging (JSON Lines)
├── auth.js               # Basic auth cho Web UI (remote mode)
├── history.js            # Lịch sử mua hàng + Export CSV
├── ui-web.js             # Web Dashboard (Express + WebSocket)
├── pm2.config.js         # PM2 config để chạy background
│
├── sites/                # Cấu hình từng site (JSON)
│   └── lychuotbach.json  # Template — copy để thêm site mới
│
└── logs/                 # Tự động tạo
    ├── events.jsonl      # Structured event log
    ├── pm2-out.log       # stdout (khi dùng PM2)
    └── pm2-err.log       # stderr (khi dùng PM2)
```

---

## ⚙️ Cấu hình site

Mỗi site là 1 file JSON trong `sites/`. Xem `sites/lychuotbach.json` làm template.

**Các field quan trọng:**

| Field | Mô tả |
|---|---|
| `id` | ID unique, dùng làm tên file và key override |
| `hostname` | Domain của site (không có `https://`) |
| `loginPageUrl` | URL trang sản phẩm (chứa category ID) |
| `maxPrice` | Giá tối đa để mua (₫) |
| `retryNormal` | Delay giữa các lần fetch khi hết hàng (ms) |
| `retrySale` | Delay khi đang có hàng (ms) — nên nhỏ hơn |
| `accounts` | Danh sách account để mua |
| `api.*` | Cách parse response của site |
| `login.*` | Selector Puppeteer để đăng nhập |

**Thêm site mới:**
1. Copy `sites/lychuotbach.json` → `sites/tensite.json`
2. Sửa các field theo API của site đó
3. Restart app — site tự động được load (không cần sửa code)

Hoặc dùng **Web UI → tab 🌐 Sites → Thêm site mới**.

---

## 🖥 Web UI

Mở `http://localhost:3000` sau khi chạy.

| Tab | Chức năng |
|---|---|
| 📊 Dashboard | Realtime log, stats, account status |
| 📋 Lịch sử | Lịch sử mua, filter, export CSV, xem chi tiết acc |
| ⚙️ Cấu hình | Thay đổi settings site (maxPrice, delay...) và accounts |
| 🔔 Thông báo | Cài Telegram bot, chọn loại event nhận |
| ⏰ Hẹn giờ | Đặt giờ tự động Start All với countdown |
| 🌐 Sites | Thêm/xoá site, xem danh sách |
| 📈 Analytics | Thống kê mua/rate limit/restart theo giờ |
| 🔒 Bảo mật | Đặt password cho Web UI khi remote |

**Dark/light mode:** nút 🌙 góc trên phải header.

---

## 📱 Telegram Notification

1. Chat với [@BotFather](https://t.me/BotFather) → `/newbot` → lấy **Bot Token**
2. Chat với [@userinfobot](https://t.me/userinfobot) → lấy **Chat ID** của bạn
3. Vào Web UI → **🔔 Thông báo** → nhập token + chat ID → bật các event → **Lưu**
4. Nhấn **📤 Gửi test** để kiểm tra

---

## ⏰ Hẹn giờ

1. Vào Web UI → **⏰ Hẹn giờ**
2. Nhập giờ bắt đầu (VD: `12:00:00` cho flash sale trưa)
3. Đặt pre-warm (mặc định 30s) — tool sẽ login Puppeteer trước N giây
4. Nhấn **Đặt lịch** → đồng hồ đếm ngược xuất hiện
5. Đúng giờ → tự động Start All

Lịch được lưu vào `scheduler.json` — reload trang / tắt mở tab không mất lịch.

---

## 🔒 Bảo mật (Remote access)

Khi muốn truy cập dashboard từ điện thoại hoặc máy khác:

1. Trong `sites/lychuotbach.json`, đặt `"remote": true` và `"webPort": 3000`
2. Vào Web UI → **🔒 Bảo mật** → bật xác thực → đặt username/password → Lưu
3. Restart app
4. Truy cập `http://<IP-máy-chủ>:3000` — trình duyệt sẽ hỏi login

> ⚠️ Nếu quên password: xoá file `auth.json` rồi restart.

---

## 🛠 Chạy background với PM2

```bash
# Cài PM2 (1 lần)
npm install -g pm2

# Khởi động
pm2 start pm2.config.js

# Xem log realtime
pm2 logs autobuy

# Dừng (graceful — đợi engine finish request hiện tại)
pm2 stop autobuy

# Restart
pm2 restart autobuy

# Tự khởi động khi boot máy
pm2 startup
pm2 save

# Xem memory/CPU
pm2 monit
```

---

## 📈 Analytics

Tab **📈 Analytics** hiển thị từ log file `logs/events.jsonl`:

- **Tổng mua / chi tiêu / rate limit / restart**
- **Top buyers** — account nào mua nhiều nhất
- **Giờ có nhiều stock** — biết flash sale thường mở lúc mấy giờ

Chọn khoảng: 24h / 3 ngày / 7 ngày / 30 ngày.

---

## 🔧 Biến môi trường

| Biến | Mặc định | Mô tả |
|---|---|---|
| `UI_MODE` | đọc từ site config | `web` / `terminal` / `electron` |
| `CHROME_PATH` | auto-detect | Đường dẫn Chrome nếu không tìm thấy tự động |

---

## 🧩 Thêm site mới — Hướng dẫn nhanh

```json
{
  "id": "mysite",
  "hostname": "example.com",
  "loginPageUrl": "https://example.com/products/<category-uuid>",
  "api": {
    "list": {
      "path": "/api/products",
      "params": { "category_id": "{cateId}", "limit": "{limit}" },
      "parseList":  "data.items",
      "parsePrice": "price",
      "parseId":    "id"
    },
    "buy": {
      "path": "/api/buy",
      "body": { "product_id": "{id}" }
    },
    "responses": {
      "success":    { "check": "success === true", "orStatus": [200] },
      "soldOut":    { "keywords": ["sold out", "hết hàng"] },
      "outOfMoney": { "keywords": ["insufficient"], "orStatus": [402] },
      "rateLimit":  { "status": 429 }
    }
  },
  "login": {
    "usernameSelector": "input#username",
    "passwordSelector": "input#password",
    "successText": "Đăng xuất"
  }
}
```

Dùng **DevTools → Network** của Chrome để xem API của site và điền đúng các field trên.

---

## ❓ Troubleshooting

**Puppeteer không login được:**
- Kiểm tra `loginPageUrl` đúng không
- Thử set `CHROME_PATH` trỏ đến Chrome đã cài
- Xem log trong `debug_<site>_<user>.log`

**429 liên tục:**
- Tăng `retryNormal` và `cooldownAfter429` trong Settings
- Tool đã có adaptive rate limit — cooldown tự tăng khi bị 429 nhiều lần

**Token hết hạn giữa chừng:**
- SessionPool tự xử lý — chỉ 1 engine refresh, engine khác chờ
- Nếu vẫn lỗi: xoá `tokens_*.json` và `cookies_*.json`, login lại

**Site thêm mới không load:**
- Kiểm tra file JSON hợp lệ (dùng jsonlint.com)
- Restart app sau khi thêm site