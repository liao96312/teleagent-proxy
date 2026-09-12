#!/usr/bin/env node
/**
 * kernel-probe.js — 带本地签名调用 TeleAgent 内核本地 server（OpenCode 风格 API）
 * 用途：探测/调试方案 B（查看 provider、模型、会话、配置等）
 *
 * 用法:
 *   node kernel-probe.js <METHOD> <path> [bodyJson] [maxBytes]
 * 例:
 *   node kernel-probe.js GET /provider
 *   node kernel-probe.js GET /session
 *   node kernel-probe.js POST /session '{"title":"x"}'
 *   node kernel-probe.js POST /session/ses_xxx/message '{"model":{"providerID":"NewApi","modelID":"chat-pro"},"parts":[{"type":"text","text":"hi"}]}'
 *
 * sessionKey 取法（任选）:
 *   - 环境变量 TA_SESSION_KEY
 *   - 同目录 session.key（由 get-session-key.py 生成）
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = process.env.TA_KERNEL_URL || 'http://127.0.0.1:4397';
const [, , method = 'GET', urlPath = '/openapi', bodyJson, maxBytesArg] = process.argv;
const MAX = Number(maxBytesArg || 4000);

function loadKey() {
  if (process.env.TA_SESSION_KEY) return process.env.TA_SESSION_KEY;
  for (const f of [path.join(__dirname, 'session.key'), path.join(process.cwd(), 'session.key')]) {
    try { const k = fs.readFileSync(f, 'utf8').trim(); if (k) return k; } catch (_) {}
  }
  throw new Error('缺少 sessionKey（跑 get-session-key.py，或设 TA_SESSION_KEY）');
}

function signHeaders(method, pathWithQuery) {
  const key = loadKey();
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = ['local-v1', method.toUpperCase(), pathWithQuery, timestamp, nonce].join('\n');
  return {
    'X-SA-Sign-Version': 'local-v1',
    'X-SA-Timestamp': timestamp,
    'X-SA-Nonce': nonce,
    'X-SA-Signature': crypto.createHmac('sha256', key).update(payload).digest('base64url'),
  };
}

(async () => {
  const headers = signHeaders(method, urlPath);
  if (bodyJson) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + urlPath, { method, headers, body: bodyJson || undefined });
  console.error('STATUS', r.status, '|', r.headers.get('content-type'));
  if (!r.body) { console.log((await r.text()).slice(0, MAX)); return; }
  const reader = r.body.getReader();
  let out = Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out = Buffer.concat([out, Buffer.from(value)]);
    if (out.length >= MAX) { try { reader.cancel(); } catch (_) {} break; }
  }
  console.log(out.toString('utf8').slice(0, MAX));
})();
