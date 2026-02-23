'use strict';

// ══════════════════════════════════════════════════════════════════
//  adapter.js – Chuyển JSON site config → site object đầy đủ
//
//  Mỗi site JSON chỉ cần mô tả:
//    - api.list:      endpoint lấy danh sách, tên field parse
//    - api.buy:       endpoint mua, template body
//    - api.responses: cách nhận biết success/soldOut/outOfMoney/rateLimit
//    - api.cateId:    cách extract cateId từ URL
//    - login:         selector / text cho Puppeteer login
//
//  Adapter tự tạo ra các hàm JS tương ứng (parseList, buyBody, isSuccess...)
//  để core.js dùng mà không cần biết site config là JSON hay code.
// ══════════════════════════════════════════════════════════════════

// ─── Path getter ──────────────────────────────────────────────────

/**
 * Tạo hàm lấy giá trị từ object theo dotPath.
 * Ví dụ: makeGetter("data.records") → obj => obj?.data?.records ?? []
 *
 * @param {string} dotPath  - "data.records" | "final_sale_price" | "id"
 * @param {*}      fallback - giá trị trả về nếu không tìm thấy
 * @returns {Function}
 */
function makeGetter(dotPath, fallback = null) {
  const keys = dotPath.split('.');
  return obj => {
    let cur = obj;
    for (const k of keys) {
      if (cur == null) return fallback;
      cur = cur[k];
    }
    return cur ?? fallback;
  };
}

// ─── Template engine nhỏ ──────────────────────────────────────────

/**
 * Điền giá trị vào template object/string.
 * Ví dụ: fillTemplate({ account_id: "{id}" }, { id: "abc" })
 *         → { account_id: "abc" }
 *
 * @param {*}      template - object hoặc string chứa placeholder {key}
 * @param {object} vars     - { key: value }
 * @returns {*}
 */
function fillTemplate(template, vars) {
  if (typeof template === 'string') {
    return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  }
  if (typeof template === 'object' && template !== null) {
    const out = {};
    for (const [k, v] of Object.entries(template)) {
      out[k] = fillTemplate(v, vars);
    }
    return out;
  }
  return template;
}

// ─── Query string builder ─────────────────────────────────────────

/**
 * Tạo hàm build URL cho list endpoint.
 * params trong JSON có thể chứa placeholder: { "cate_id": "{cateId}", "limit": "{limit}" }
 *
 * @param {string} path
 * @param {object} paramTemplate
 * @returns {Function} (cateId, limit) => "/path?..."
 */
function makeListEndpoint(path, paramTemplate) {
  return (cateId, limit) => {
    const filled = fillTemplate(paramTemplate, { cateId, limit });
    const qs = Object.entries(filled)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return `${path}?${qs}`;
  };
}

// ─── Response checkers ────────────────────────────────────────────

/**
 * Tạo hàm kiểm tra response dựa theo config.
 *
 * Config ví dụ:
 *   success:    { check: "data.success === true", orStatus: [200, 201] }
 *   soldOut:    { keywords: ["đã bán", "sold"] }
 *   outOfMoney: { keywords: ["không đủ"], orStatus: [402] }
 *   rateLimit:  { status: 429 }
 */
function makeResponseCheckers(responses = {}) {
  /**
   * Parse "data.success === true" → hàm kiểm tra field
   * Chỉ hỗ trợ dạng: "path.to.field === value" hoặc "path.to.field !== value"
   */
  function parseFieldCheck(expr) {
    if (!expr) return () => false;
    const eqMatch  = expr.match(/^([\w.]+)\s*===\s*(.+)$/);
    const neqMatch = expr.match(/^([\w.]+)\s*!==\s*(.+)$/);
    if (eqMatch) {
      const getter = makeGetter(eqMatch[1]);
      const expected = JSON.parse(eqMatch[2].trim());
      return obj => getter(obj) === expected;
    }
    if (neqMatch) {
      const getter = makeGetter(neqMatch[1]);
      const expected = JSON.parse(neqMatch[2].trim());
      return obj => getter(obj) !== expected;
    }
    return () => false;
  }

  // isSuccess
  const successCfg    = responses.success || {};
  const successCheck  = parseFieldCheck(successCfg.check);
  const successStatus = new Set(successCfg.orStatus || []);
  const isSuccess = res =>
    successCheck(res.data) ||
    successStatus.has(res.status);

  // isSoldOut
  const soldOutCfg      = responses.soldOut || {};
  const soldOutKws      = (soldOutCfg.keywords || []).map(s => s.toLowerCase());
  const soldOutStatuses = new Set(soldOutCfg.orStatus || []);
  const isSoldOut = res => {
    const t = JSON.stringify(res.data || '').toLowerCase();
    return soldOutKws.some(kw => t.includes(kw)) || soldOutStatuses.has(res.status);
  };

  // isOutOfMoney
  const moneyC         = responses.outOfMoney || {};
  const moneyKws       = (moneyC.keywords || []).map(s => s.toLowerCase());
  const moneyStatuses  = new Set(moneyC.orStatus || []);
  const isOutOfMoney = res => {
    const t = JSON.stringify(res.data || '').toLowerCase();
    return moneyKws.some(kw => t.includes(kw)) || moneyStatuses.has(res.status);
  };

  // isRateLimit
  const rlCfg       = responses.rateLimit || {};
  const rlStatus    = rlCfg.status ?? 429;
  const rlKws       = (rlCfg.keywords || []).map(s => s.toLowerCase());
  const isRateLimit = res => {
    if (res.status === rlStatus) return true;
    if (rlKws.length) {
      const t = JSON.stringify(res.data || '').toLowerCase();
      return rlKws.some(kw => t.includes(kw));
    }
    return false;
  };

  return { isSuccess, isSoldOut, isOutOfMoney, isRateLimit };
}

// ─── CateId extractor ─────────────────────────────────────────────

/**
 * Tạo hàm extract cateId từ URL dựa theo regex trong config.
 * cateId.source: "loginPageUrl" (mặc định) — extract từ URL đó
 * cateId.regex:  regex string, capture group 1 là cateId
 */
function makeParseCateId(cateIdCfg = {}) {
  const pattern = new RegExp(cateIdCfg.regex || 'accounts/([a-f0-9-]{36})');
  return url => {
    const m = url?.match(pattern);
    return m?.[1] ?? null;
  };
}

// ─── Main builder ─────────────────────────────────────────────────

/**
 * Chuyển JSON site config → site object đầy đủ dùng được bởi core.js
 *
 * @param {object} json - nội dung file .json đã parse
 * @returns {object}    - site object với đầy đủ fields và methods
 */
function buildSite(json) {
  const { api = {}, login = {} } = json;
  const list = api.list || {};
  const buy  = api.buy  || {};

  // ── List endpoint ────────────────────────────────────────────
  const listEndpoint = makeListEndpoint(list.path || '/', list.params || {});

  // ── Parsers ──────────────────────────────────────────────────
  const parseList  = makeGetter(list.parseList  || 'data', []);
  const parseTotal = makeGetter(list.parseTotal || 'total', 0);
  const parsePrice = makeGetter(list.parsePrice || 'price', 0);
  const parseId    = makeGetter(list.parseId    || 'id', null);

  // ── CateId ───────────────────────────────────────────────────
  const parseCateId = makeParseCateId(api.cateId || {});

  // ── Buy ──────────────────────────────────────────────────────
  const buyBodyTemplate = buy.body || {};
  const buyBody = id => fillTemplate(buyBodyTemplate, { id });

  // ── Response checkers ────────────────────────────────────────
  const { isSuccess, isSoldOut, isOutOfMoney, isRateLimit } =
    makeResponseCheckers(api.responses || {});

  // ── Login steps (Puppeteer) ──────────────────────────────────
  // Đặt vào loginSteps để core.js dùng như cũ
  const loginSteps = {
    openModalText:    login.openModalText    || '',
    switchToLoginText:login.switchToLoginText|| '',
    usernameSelector: login.usernameSelector || 'input[name=username]',
    passwordSelector: login.passwordSelector || 'input[name=password]',
    successText:      login.successText      || '',
  };

  // ── Kết hợp: JSON fields + computed functions ─────────────────
  return {
    // Scalar fields — copy thẳng từ JSON
    id:               json.id,
    name:             json.name,
    hostname:         json.hostname,
    loginPageUrl:     json.loginPageUrl,
    maxPrice:         json.maxPrice         ?? 999999,
    maxBuy:           json.maxBuy           ?? 0,
    fetchLimit:       json.fetchLimit       ?? 10,
    retryNormal:      json.retryNormal      ?? 800,
    retrySale:        json.retrySale        ?? 100,
    jitter:           json.jitter           ?? 200,
    cooldownAfter429: json.cooldownAfter429 ?? 10000,
    emptyThreshold:   json.emptyThreshold   ?? 60,
    pageTimeout:      json.pageTimeout      ?? 10000,
    accounts:         json.accounts         ?? [],
    ui:               json.ui               ?? {},

    // Computed functions — từ JSON config
    listEndpoint,
    parseList,
    parseTotal,
    parsePrice,
    parseId,
    parseCateId,

    buyEndpoint: buy.path || '/buy',
    buyBody,

    isSuccess,
    isSoldOut,
    isOutOfMoney,
    isRateLimit,

    loginSteps,

    // Giữ lại raw JSON để Web UI đọc config gốc
    _raw: json,
  };
}

// ─── Load từ file ─────────────────────────────────────────────────

/**
 * Load và parse một file JSON site config.
 *
 * @param {string} filePath - đường dẫn đến file .json
 * @returns {object}        - site object đầy đủ
 */
function loadSiteFromFile(filePath) {
  const raw = require('fs').readFileSync(filePath, 'utf8');
  const json = JSON.parse(raw);
  return buildSite(json);
}

// ─── Rate limit adaptive ─────────────────────────────────────────

/**
 * Wrap site object với rate limit adaptive.
 * Khi bị 429 liên tục: cooldown tăng dần (x1.5 mỗi lần, tối đa maxCooldown).
 * Khi request thành công: cooldown giảm dần về mặc định.
 *
 * @param {object} site
 * @returns {object} same site object, mutated in place
 */
function applyAdaptiveRateLimit(site) {
  const baseCooldown = site.cooldownAfter429;
  const maxCooldown  = baseCooldown * 8; // tối đa 8x base
  let   streak       = 0;                // số lần 429 liên tiếp

  const origIsRateLimit = site.isRateLimit.bind(site);

  site._rlStreak    = () => streak;
  site._rlCooldown  = () => Math.min(baseCooldown * Math.pow(1.5, streak), maxCooldown);

  // Override isRateLimit để track streak
  site.isRateLimit = res => {
    const hit = origIsRateLimit(res);
    if (hit) {
      streak++;
      site.cooldownAfter429 = site._rlCooldown();
    } else {
      // Giảm streak khi request thành công
      if (streak > 0) {
        streak = Math.max(0, streak - 1);
        site.cooldownAfter429 = site._rlCooldown();
        // Reset hẳn nếu đã về 0
        if (streak === 0) site.cooldownAfter429 = baseCooldown;
      }
    }
    return hit;
  };

  return site;
}

module.exports = { buildSite, loadSiteFromFile, applyAdaptiveRateLimit, makeGetter, fillTemplate };