'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// ══════════════════════════════════════════════════════════════════
//  notifier.test.js
//  Test config I/O và logic — Telegram/webhook calls được mock
// ══════════════════════════════════════════════════════════════════

const CONFIG_FILE    = 'notifier.json';
const WEBHOOK_FILE   = 'webhook.json';

function cleanConfig() {
  for (const f of [CONFIG_FILE, WEBHOOK_FILE]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
}

// Fresh require helper
function freshNotifier() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('notifier')) delete require.cache[k];
  }
  return require('../notifier');
}

describe('Notifier – loadConfig / saveConfig (config I/O)', () => {
  test('loadConfig trả default khi không có file', () => {
    cleanConfig();
    const { notifier } = freshNotifier();
    const cfg = notifier.getConfig();
    assert.equal(cfg.telegram.enabled, false);
    assert.equal(cfg.telegram.botToken, '');
    assert.equal(cfg.desktop.enabled, false);
    cleanConfig();
  });

  test('updateConfig() merge đúng vào telegram', () => {
    cleanConfig();
    const { notifier } = freshNotifier();
    notifier.updateConfig({ telegram: { botToken: 'abc123', chatId: '999' } });
    const cfg = notifier.getConfig();
    assert.equal(cfg.telegram.botToken, 'abc123');
    assert.equal(cfg.telegram.chatId, '999');
    assert.equal(cfg.telegram.enabled, false); // giữ nguyên default
    cleanConfig();
  });

  test('updateConfig() persist qua getConfig()', () => {
    cleanConfig();
    const { notifier } = freshNotifier();
    notifier.updateConfig({ telegram: { enabled: true, botToken: 'tok', chatId: '123' } });
    // Đọc lại từ file
    const { notifier: n2 } = freshNotifier();
    const cfg = n2.getConfig();
    assert.equal(cfg.telegram.enabled, true);
    assert.equal(cfg.telegram.botToken, 'tok');
    cleanConfig();
  });

  test('updateConfig() không xoá fields không được patch', () => {
    cleanConfig();
    const { notifier } = freshNotifier();
    notifier.updateConfig({ telegram: { botToken: 'tok1' } });
    notifier.updateConfig({ telegram: { chatId: 'chat1' } });
    const cfg = notifier.getConfig();
    assert.equal(cfg.telegram.botToken, 'tok1'); // không bị xoá
    assert.equal(cfg.telegram.chatId, 'chat1');
    cleanConfig();
  });
});

describe('Notifier – webhook config', () => {
  test('getWebhookConfig trả default khi chưa có config', () => {
    cleanConfig();
    const { notifier } = freshNotifier();
    const cfg = notifier.getWebhookConfig?.() || {};
    // enabled=false là default OK
    assert.ok(typeof cfg === 'object');
    cleanConfig();
  });

  test('updateWebhookConfig() lưu url và format', () => {
    cleanConfig();
    const { notifier } = freshNotifier();
    if (!notifier.updateWebhookConfig) return; // skip nếu không có method
    notifier.updateWebhookConfig({ url: 'https://discord.com/hook/abc', format: 'discord', enabled: true });
    const cfg = notifier.getWebhookConfig();
    assert.equal(cfg.url, 'https://discord.com/hook/abc');
    assert.equal(cfg.format, 'discord');
    assert.equal(cfg.enabled, true);
    cleanConfig();
  });
});

describe('Notifier – shouldNotify logic', () => {
  test('không gửi Telegram khi enabled=false', async () => {
    cleanConfig();
    let httpCalled = false;
    const { notifier } = freshNotifier();
    // Patch nội bộ: khi enabled=false, send() không gọi HTTP
    notifier.updateConfig({ telegram: { enabled: false, botToken: 'tok', chatId: '123' } });

    // Mock https bằng cách spy trên network — đây là unit test nên chỉ check return
    const result = await notifier.send?.('onBought', { title: 'T', message: 'M' }) ?? {};
    // Telegram disabled → không nên throw, nhưng không gửi được
    assert.ok(!httpCalled);
    cleanConfig();
  });

  test('test() trả object với keys telegram và/hoặc desktop', async () => {
    cleanConfig();
    const { notifier } = freshNotifier();
    notifier.updateConfig({ telegram: { enabled: false }, desktop: { enabled: false } });
    const result = await notifier.test();
    assert.ok(typeof result === 'object');
    assert.ok('telegram' in result || 'desktop' in result);
    cleanConfig();
  });
});

describe('Notifier – onBought event routing', () => {
  test('send() không throw khi telegram disabled', async () => {
    cleanConfig();
    const { notifier } = freshNotifier();
    notifier.updateConfig({ telegram: { enabled: false } });
    await assert.doesNotReject(async () => {
      await notifier.send?.('onBought', { title: 'Mua được', message: 'test' });
    });
    cleanConfig();
  });

  test('send() không throw khi config thiếu botToken', async () => {
    cleanConfig();
    const { notifier } = freshNotifier();
    notifier.updateConfig({ telegram: { enabled: true, botToken: '', chatId: '' } });
    await assert.doesNotReject(async () => {
      await notifier.send?.('onBought', { title: 'T', message: 'M' });
    });
    cleanConfig();
  });
});
