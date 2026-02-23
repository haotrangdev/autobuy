'use strict';

// ══════════════════════════════════════════════════════════════════
//  sites.js – Load site configs từ sites/*.json qua adapter
//
//  Để thêm site mới:
//    1. Tạo file sites/tensite.json theo template sites/lychuotbach.json
//    2. Thêm tên file vào SITE_FILES bên dưới
//    3. Restart script
//
//  Không cần sửa file này hay bất kỳ file JS nào khác.
// ══════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const { loadSiteFromFile, applyAdaptiveRateLimit } = require('./adapter');

// ── Auto-scan sites/ directory + optional explicit list ──────────
//
// Cách hoạt động:
//   1. Đọc tất cả *.json trong thư mục sites/
//   2. Sort theo tên file để thứ tự load ổn định
//   3. Khi thêm site qua Web UI → file mới tự động được load khi restart
//
// Không cần sửa file này để thêm site mới!

const SITES_DIR = 'sites';

function scanSiteFiles() {
  if (!fs.existsSync(SITES_DIR)) {
    fs.mkdirSync(SITES_DIR, { recursive: true });
    return [];
  }
  return fs.readdirSync(SITES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => path.join(SITES_DIR, f));
}

// ── Load tất cả sites ─────────────────────────────────────────────
const SITES = scanSiteFiles()
  .filter(f => {
    try {
      const raw = fs.readFileSync(f, 'utf8').trim();
      if (!raw || raw === '{}') {
        console.warn(`[sites] ⚠ Bỏ qua file rỗng: ${f}`);
        return false;
      }
      return true;
    } catch { return false; }
  })
  .map(f => {
    try {
      return applyAdaptiveRateLimit(loadSiteFromFile(f));
    } catch (err) {
      console.error(`[sites] ✕ Lỗi load ${f}: ${err.message}`);
      return null;
    }
  })
  .filter(Boolean);

if (!SITES.length) {
  console.error('[sites] ✕ Không load được site nào. Kiểm tra thư mục sites/');
}

// ── Override từ file (Web UI settings) ───────────────────────────
const OVERRIDE_FILE = 'config.override.json';

function loadOverride() {
  if (!fs.existsSync(OVERRIDE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8')); }
  catch { return {}; }
}

const ALLOWED_OVERRIDE_KEYS = [
  'maxPrice', 'maxBuy', 'fetchLimit',
  'retryNormal', 'retrySale', 'jitter', 'cooldownAfter429',
  'emptyThreshold', 'pageTimeout',
  'loginPageUrl',
];

function applyOverrides() {
  const override = loadOverride();
  for (const site of SITES) {
    const patch = override[site.id] || {};
    for (const k of ALLOWED_OVERRIDE_KEYS) {
      if (patch[k] !== undefined) site[k] = patch[k];
    }
    if (patch.accounts) site.accounts = patch.accounts;
  }
}

function saveOverride(siteId, patch) {
  const override = loadOverride();
  override[siteId] = Object.assign(override[siteId] || {}, patch);
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(override, null, 2), 'utf8');
}

function getEnabledSites() {
  return SITES.filter(s => s.accounts?.some(a => a.enabled !== false));
}

function getEnabledAccounts(site) {
  return (site.accounts || []).filter(a => a.enabled !== false);
}

module.exports = {
  SITES,
  getEnabledSites,
  getEnabledAccounts,
  applyOverrides,
  saveOverride,
  loadOverride,
};