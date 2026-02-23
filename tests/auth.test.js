'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ══════════════════════════════════════════════════════════════════
//  auth.test.js
// ══════════════════════════════════════════════════════════════════

// auth.js hardcode 'auth.json' — mock bằng cách override process.cwd()
// Cách đơn giản hơn: test các function riêng bằng module isolation

// Tạo temp copy của auth.js với file path có thể config
const { createAuthMiddleware, checkWsAuth, loadAuthConfig, saveAuthConfig } = require('../auth');

// Cleanup helper
const AUTH_FILE = 'auth.json';
function cleanAuthFile() {
  try { if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE); } catch {}
}

// ── loadAuthConfig / saveAuthConfig ──────────────────────────────

describe('loadAuthConfig / saveAuthConfig', () => {
  test('loadAuthConfig() trả default khi không có file', () => {
    cleanAuthFile();
    const cfg = loadAuthConfig();
    assert.equal(cfg.enabled,  false);
    assert.equal(cfg.username, 'admin');
    assert.equal(cfg.password, '');
  });

  test('saveAuthConfig() ghi và load lại đúng', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: true, username: 'testuser', password: 'secret' });
    const cfg = loadAuthConfig();
    assert.equal(cfg.enabled,  true);
    assert.equal(cfg.username, 'testuser');
    assert.equal(cfg.password, 'secret');
    cleanAuthFile();
  });

  test('saveAuthConfig() merge với config hiện tại', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: true, username: 'admin', password: 'pw1' });
    saveAuthConfig({ password: 'pw2' }); // chỉ đổi password
    const cfg = loadAuthConfig();
    assert.equal(cfg.enabled,  true);
    assert.equal(cfg.username, 'admin');
    assert.equal(cfg.password, 'pw2');
    cleanAuthFile();
  });
});

// ── createAuthMiddleware ──────────────────────────────────────────

function makeRes() {
  const res = {
    _status: 200, _body: '', _headers: {},
    status(code)               { this._status = code; return this; },
    send(body)                 { this._body = body; },
    setHeader(k, v)            { this._headers[k] = v; },
  };
  return res;
}

function makeReq(authHeader = '') {
  return { headers: { authorization: authHeader } };
}

describe('createAuthMiddleware', () => {
  test('bypass auth khi isRemote = false', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: true, username: 'admin', password: 'secret' });
    const mw = createAuthMiddleware(false); // localhost
    let nextCalled = false;
    mw(makeReq(), makeRes(), () => { nextCalled = true; });
    assert.ok(nextCalled, 'next() phải được gọi khi localhost');
    cleanAuthFile();
  });

  test('bypass auth khi enabled = false', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: false, username: 'admin', password: 'secret' });
    const mw = createAuthMiddleware(true);
    let nextCalled = false;
    mw(makeReq(), makeRes(), () => { nextCalled = true; });
    assert.ok(nextCalled);
    cleanAuthFile();
  });

  test('trả 503 khi enabled + remote nhưng password rỗng', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: true, username: 'admin', password: '' });
    const mw = createAuthMiddleware(true);
    const res = makeRes();
    mw(makeReq(), res, () => {});
    assert.equal(res._status, 503);
    cleanAuthFile();
  });

  test('401 khi không có Authorization header', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: true, username: 'admin', password: 'secret' });
    const mw = createAuthMiddleware(true);
    const res = makeRes();
    mw(makeReq(''), res, () => {});
    assert.equal(res._status, 401);
    assert.ok(res._headers['WWW-Authenticate']);
    cleanAuthFile();
  });

  test('401 khi sai password', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: true, username: 'admin', password: 'secret' });
    const mw = createAuthMiddleware(true);
    const res = makeRes();
    const badAuth = 'Basic ' + Buffer.from('admin:wrongpass').toString('base64');
    mw(makeReq(badAuth), res, () => {});
    assert.equal(res._status, 401);
    cleanAuthFile();
  });

  test('next() được gọi khi đúng credentials', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: true, username: 'admin', password: 'secret' });
    const mw = createAuthMiddleware(true);
    let nextCalled = false;
    const goodAuth = 'Basic ' + Buffer.from('admin:secret').toString('base64');
    mw(makeReq(goodAuth), makeRes(), () => { nextCalled = true; });
    assert.ok(nextCalled);
    cleanAuthFile();
  });
});

// ── checkWsAuth ───────────────────────────────────────────────────

describe('checkWsAuth', () => {
  function makeWsReq(token = '', authHeader = '') {
    const url = token ? `/?auth=${token}` : '/';
    return {
      url,
      headers: { authorization: authHeader },
    };
  }

  test('trả true khi isRemote = false', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: true, username: 'admin', password: 'secret' });
    assert.ok(checkWsAuth(makeWsReq(), false));
    cleanAuthFile();
  });

  test('trả true khi enabled = false', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: false });
    assert.ok(checkWsAuth(makeWsReq(), true));
    cleanAuthFile();
  });

  test('trả false khi không có token và sai header', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: true, username: 'admin', password: 'secret' });
    assert.ok(!checkWsAuth(makeWsReq(), true));
    cleanAuthFile();
  });

  test('trả true khi token đúng qua query param', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: true, username: 'admin', password: 'secret' });
    const token = Buffer.from('admin:secret').toString('base64');
    assert.ok(checkWsAuth(makeWsReq(token), true));
    cleanAuthFile();
  });

  test('trả true khi Authorization header đúng', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: true, username: 'admin', password: 'secret' });
    const header = 'Basic ' + Buffer.from('admin:secret').toString('base64');
    assert.ok(checkWsAuth(makeWsReq('', header), true));
    cleanAuthFile();
  });

  test('trả false khi token sai', () => {
    cleanAuthFile();
    saveAuthConfig({ enabled: true, username: 'admin', password: 'secret' });
    const token = Buffer.from('admin:wrong').toString('base64');
    assert.ok(!checkWsAuth(makeWsReq(token), true));
    cleanAuthFile();
  });
});
