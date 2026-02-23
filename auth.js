'use strict';

// ══════════════════════════════════════════════════════════════════
//  auth.js – Basic auth middleware cho Web UI
//
//  Nếu remote: true → bắt buộc đặt password trong auth.json
//  Nếu remote: false → bỏ qua auth (localhost only)
//
//  Config: auth.json
//    { "enabled": true, "username": "admin", "password": "mypassword" }
//
//  Dùng HTTP Basic Auth — không cần cookie hay session.
//  Để thay đổi password: sửa auth.json rồi restart.
// ══════════════════════════════════════════════════════════════════

const fs     = require('fs');
const crypto = require('crypto');

const AUTH_FILE = 'auth.json';

const DEFAULT_CONFIG = {
  enabled:  false,
  username: 'admin',
  password: '',   // rỗng = chưa đặt
};

// ─── Config ───────────────────────────────────────────────────────

function loadAuthConfig() {
  if (!fs.existsSync(AUTH_FILE)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveAuthConfig(patch) {
  const current = loadAuthConfig();
  const next    = { ...current, ...patch };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ─── Timing-safe compare ──────────────────────────────────────────

function safeEqual(a, b) {
  // Dùng timingSafeEqual để tránh timing attack
  try {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
      // Vẫn phải compare để tránh timing leak về độ dài
      crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// ─── Express middleware ────────────────────────────────────────────

/**
 * Tạo middleware Express cho Basic Auth.
 *
 * @param {boolean} isRemote  - nếu false → bỏ qua auth (localhost)
 * @returns {Function}        - Express middleware
 */
function createAuthMiddleware(isRemote) {
  return (req, res, next) => {
    const cfg = loadAuthConfig();

    // Không cần auth nếu: disabled hoặc localhost
    if (!cfg.enabled || !isRemote) return next();

    // Chưa đặt password → chặn và nhắc cấu hình
    if (!cfg.password) {
      res.status(503).send([
        '<h2>⚠️ Web UI đang mở ra ngoài nhưng chưa đặt password</h2>',
        '<p>Tạo file <code>auth.json</code> với nội dung:</p>',
        '<pre>{ "enabled": true, "username": "admin", "password": "yourpassword" }</pre>',
        '<p>Sau đó restart app.</p>',
      ].join(''));
      return;
    }

    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Basic ')) {
      const [user, pass] = Buffer.from(authHeader.slice(6), 'base64')
        .toString('utf8').split(':', 2);
      if (safeEqual(user || '', cfg.username) && safeEqual(pass || '', cfg.password)) {
        return next();
      }
    }

    // Yêu cầu Basic Auth
    res.setHeader('WWW-Authenticate', 'Basic realm="AutoBuy Dashboard"');
    res.status(401).send('401 Unauthorized — Đăng nhập để tiếp tục');
  };
}

/**
 * Tương tự nhưng cho WebSocket — kiểm tra trước khi upgrade.
 * Dùng trong server 'upgrade' event.
 *
 * @param {object}   req       - HTTP IncomingMessage
 * @param {boolean}  isRemote
 * @returns {boolean}          - true nếu được phép
 */
function checkWsAuth(req, isRemote) {
  const cfg = loadAuthConfig();
  if (!cfg.enabled || !isRemote || !cfg.password) return true;

  // WS auth qua URL query: ws://host:port/?auth=user:pass (base64)
  const url    = new URL(req.url || '/', `http://localhost`);
  const token  = url.searchParams.get('auth') || '';
  if (token) {
    const [user, pass] = Buffer.from(token, 'base64').toString().split(':', 2);
    return safeEqual(user || '', cfg.username) && safeEqual(pass || '', cfg.password);
  }

  // Fallback: Authorization header (Electron / cli clients)
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(authHeader.slice(6), 'base64').toString().split(':', 2);
    return safeEqual(user || '', cfg.username) && safeEqual(pass || '', cfg.password);
  }

  return false;
}

module.exports = { createAuthMiddleware, checkWsAuth, loadAuthConfig, saveAuthConfig };
