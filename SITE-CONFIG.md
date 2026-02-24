# Site Config Reference

Mỗi site là một file JSON trong thư mục `sites/`. Bot tự scan tất cả `*.json` trong thư mục này.

---

## Cấu trúc đầy đủ

```json
{
  "id":       "site-id",        // unique, dùng làm key
  "name":     "Tên hiển thị",
  "hostname": "example.com",    // hiển thị trên UI

  // ── UI settings ────────────────────────────────────────────────
  "ui": {
    "web":      true,           // bật Web UI
    "terminal": false,          // bật Terminal UI
    "webPort":  3000,
    "remote":   false,          // true = lắng nghe 0.0.0.0 (cần auth.json)
    "uiMode":   "web"           // web | terminal | electron
  },

  // ── Giới hạn mua ───────────────────────────────────────────────
  "maxPrice":        500000,    // bỏ qua sản phẩm giá cao hơn (VNĐ)
  "maxBuy":          1,         // số lần mua tối đa rồi dừng
  "fetchLimit":      10,        // số sản phẩm lấy mỗi lần check

  // ── Timing ─────────────────────────────────────────────────────
  "retryNormal":     800,       // delay (ms) khi stock rỗng
  "retrySale":       200,       // delay (ms) khi có sale (aggressive)
  "jitter":          100,       // random ± jitter thêm vào delay
  "cooldownAfter429":30000,     // nghỉ bao lâu sau khi bị 429
  "emptyThreshold":  5,         // số lần rỗng liên tiếp → chuyển sang retrySale
  "pageTimeout":     30000,     // timeout mỗi request Puppeteer (ms)

  // ── Retry strategy (ghi đè default exponential) ────────────────
  "retryStrategy": {
    "type":       "exponential", // linear | exponential | stepped
    "baseDelay":  3000,
    "factor":     2.0,
    "maxDelay":   60000,
    "maxRetries": 10,
    "jitter":     500,

    // Chỉ dùng với type: "linear"
    // "increment": 1000,

    // Chỉ dùng với type: "stepped"
    // "steps": [2000, 5000, 10000, 30000, 60000]
  },

  // ── Login config (Puppeteer) ───────────────────────────────────
  "login": {
    "url":             "https://example.com/login",
    "usernameSelector":"#email",
    "passwordSelector":"#password",
    "submitSelector":  "button[type=submit]",
    "successUrl":      "https://example.com/home"
  },

  // ── API endpoints ──────────────────────────────────────────────
  "api": {
    "list": {
      "url":        "https://api.example.com/products?limit={limit}",
      "method":     "GET",
      "dataPath":   "data.items",       // dotPath đến array sản phẩm
      "idField":    "product_id",       // field ID sản phẩm
      "priceField": "final_price",      // field giá
      "stockField": "stock_count"       // field stock (optional)
    },
    "buy": {
      "url":    "https://api.example.com/cart/buy",
      "method": "POST",
      "body": {
        "product_id": "{id}",           // {id} được replace bằng ID sản phẩm
        "quantity":   1,
        "account_id": "{account_id}"    // {account_id} từ account config
      }
    },
    "responses": {
      "success":    { "path": "status", "value": "ok" },
      "soldOut":    { "path": "error",  "value": "sold_out" },
      "outOfMoney": { "path": "error",  "value": "insufficient_balance" },
      "rateLimit":  { "path": "error",  "value": "rate_limited" }
    }
  },

  // ── Accounts ───────────────────────────────────────────────────
  "accounts": [
    {
      "username":   "user1@email.com",
      "password":   "password1",
      "label":      "Tài khoản 1",      // hiển thị trên UI
      "account_id": "acc_001",          // optional, dùng trong buy body template
      "enabled":    true
    },
    {
      "username": "user2@email.com",
      "password": "password2",
      "label":    "Tài khoản 2",
      "enabled":  false                 // tạm thời tắt
    }
  ]
}
```

---

## Ví dụ: Preset retry strategies

```json
// Aggressive — giành hàng flash sale cực nhanh
"retryStrategy": { "type": "exponential", "baseDelay": 1000, "factor": 1.5, "maxDelay": 30000, "maxRetries": 15, "jitter": 500 }

// Default — cân bằng giữa tốc độ và tránh ban
"retryStrategy": { "type": "exponential", "baseDelay": 3000, "factor": 2.0, "maxDelay": 60000, "maxRetries": 10 }

// Patient — cho site khó tính, nhiều anti-bot
"retryStrategy": { "type": "linear", "baseDelay": 5000, "increment": 2000, "maxDelay": 60000, "maxRetries": 8 }

// Stepped — delays cố định theo từng bước
"retryStrategy": { "type": "stepped", "steps": [2000, 5000, 10000, 20000, 60000], "maxRetries": 10 }
```

---

## Lưu ý bảo mật

- **Không commit** file site config thật lên git — đã có trong `.gitignore`
- File `sites/example.json` là template an toàn để commit
- Password trong config được đọc trực tiếp bởi Puppeteer, không hash
