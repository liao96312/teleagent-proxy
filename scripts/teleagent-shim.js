#!/usr/bin/env node
/**
 * teleagent-shim.js — 把 TeleAgent 的模型网关包装成本地 OpenAI 兼容接口
 * 便携版：自动探测 account / deviceId / installId / token.json。
 *
 * 快速使用:
 *   1) 解出 safeStorage 的 AES key（见教程 3.1），写入本文件同目录 token.key
 *      或设环境变量 TA_AES_KEY=<64hex>
 *   2) node teleagent-shim.js
 *   3) 其它工具 base_url = http://127.0.0.1:8788/v1
 *
 * 依赖: 仅 Node 内置（Node >= 18，需全局 fetch）。
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ===================== 配置（多数自动探测） =====================
const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const TA_DATA = process.env.TA_DATA_DIR || path.join(HOME, '.local', 'share', 'TeleAgent');

const CONFIG = {
  listenPort: Number(process.env.TA_PORT || 8788),
  gateway: 'https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions',
  signPath: '/superCowork/sapi/api/v1/chat/completions',
  scheme: 'superagent-auth-v1',
  sk: process.env.TA_SK || 'sk-qvp4m6h9g20uM6PgYP7E',   // 通道密钥（内嵌固定）
  // 对外（本地客户端）用的 API key：默认空 = 不校验；设了 TA_API_KEY 则要求客户端带这个 key
  apiKey: process.env.TA_API_KEY || '',
  appVersion: process.env.TA_APP_VERSION || '2.5.0',
  dataDir: TA_DATA,
  keyFile: path.join(__dirname, 'token.key'),
  // deviceId / installId / account 自动探测，见下
};

// ---------- 自动探测 ----------
function findAccountDir() {
  try {
    const users = path.join(CONFIG.dataDir, 'users');
    const ds = fs.readdirSync(users).filter(d => d.startsWith('v1_public_'));
    if (ds.length) return ds[0];
  } catch (_) {}
  return null;
}
function readDeviceMeta() {
  // 优先 device 级 app-auth/device-meta.json
  const cands = [
    path.join(CONFIG.dataDir, 'app-auth', 'device-meta.json'),
    path.join(process.env.APPDATA || '', 'TeleAgent', 'app-auth', 'device-meta.json'),
  ];
  for (const f of cands) {
    try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j.deviceId) return j; } catch (_) {}
  }
  return {};
}
const META = readDeviceMeta();
CONFIG.account = process.env.TA_ACCOUNT || findAccountDir();
CONFIG.deviceId = process.env.TA_DEVICE_ID || META.deviceId || '';
CONFIG.installId = process.env.TA_INSTALL_ID || META.installId || '';

// ===================== AES key =====================
function loadAesKey() {
  if (process.env.TA_AES_KEY) return Buffer.from(process.env.TA_AES_KEY.trim(), 'hex');
  const cands = [
    CONFIG.keyFile,                                    // shim 同目录
    path.join(__dirname, '..', 'token.key'),           // 上级
    path.join(HOME, 'Desktop', 'token.key'),           // 桌面
    path.join(HOME, 'Desktop', 'teleagent', 'token.key'),
    path.join(CONFIG.dataDir, 'token.key'),
  ];
  for (const f of cands) {
    try {
      if (f && fs.existsSync(f)) {
        const h = fs.readFileSync(f, 'utf8').trim();
        if (/^[0-9a-fA-F]{64}$/.test(h)) return Buffer.from(h, 'hex');
      }
    } catch (_) {}
  }
  throw new Error('缺少 AES key：设置 TA_AES_KEY，或把 32 字节 key(hex) 写进 ' + CONFIG.keyFile);
}

// ===================== 取登录 Token =====================
let _token = null, _tokenTs = 0;
function tokenPath() {
  if (!CONFIG.account) throw new Error('找不到账号目录 users/v1_public_*');
  return path.join(CONFIG.dataDir, 'users', CONFIG.account, 'app-auth', 'token.json');
}
function decryptToken() {
  const key = loadAesKey();
  const tj = JSON.parse(fs.readFileSync(tokenPath(), 'utf8'));
  const b = Buffer.from(tj.encryptedToken, 'base64');       // v10 | 12B nonce | ct | 16B tag
  const nonce = b.subarray(3, 15), tag = b.subarray(b.length - 16), ct = b.subarray(15, b.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8').trim();
}
function getToken(force) {
  if (!force && _token && Date.now() - _tokenTs < 10 * 60 * 1000) return _token;
  _token = decryptToken(); _tokenTs = Date.now();
  return _token;
}

// ===================== 签名（复刻 GatewaySigner.Sign） =====================
function computeSignature(token, method, signPath, tsSec, nonce, bodyBuf) {
  // 第 1 轮：key = JWT 签名段；m1 用 "/"
  const K = token.split(':').slice(1).join(':').split('.')[2];
  const m1 = [CONFIG.scheme, token, CONFIG.installId, String(tsSec), nonce].join('/');
  const sig1 = crypto.createHmac('sha256', K).update(m1, 'utf8').digest('hex');
  // 第 2 轮：m2 用 "\n"，含 body 的 sha256
  const bodyHash = crypto.createHash('sha256').update(bodyBuf).digest('hex');
  const m2 = [CONFIG.scheme, method, signPath, String(tsSec), nonce, CONFIG.appVersion, bodyHash].join('\n');
  return crypto.createHmac('sha256', sig1).update(m2, 'utf8').digest('hex');
}

function buildHeaders(token, method, bodyBuf) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const sig = computeSignature(token, method, CONFIG.signPath, ts, nonce, bodyBuf);
  return {
    'Authorization': 'Bearer ' + CONFIG.sk,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'User-Agent': 'super-agent/1.0',
    'X-Route-Target': 'ops-gateway',
    'X-Token': token,
    'X-App-Version': CONFIG.appVersion,
    'X-Device-Os': 'Windows',
    'X-Device-Os-Version': '10.0.26100',
    'X-Message-Id': 'msg_' + crypto.randomBytes(12).toString('hex'),
    'X-Request-Id': crypto.randomUUID(),
    'X-Session-Id': 'ses_' + crypto.randomBytes(12).toString('hex'),
    'X-Teleai-Client-Type': 'desktop',
    'X-Teleai-Run-Unit-Type': 'agent_loop',
    'X-Superagent-Device-Id': CONFIG.deviceId,
    'X-Superagent-Install-Id': CONFIG.installId,
    'X-Superagent-Nonce': nonce,
    'X-Superagent-Sign-Version': 'v1',
    'X-Superagent-Signature': sig,
    'X-Superagent-Timestamp': String(ts),
  };
}

// ===================== 转发 =====================
async function forward(reqBody, res) {
  const method = 'POST';
  let token = getToken();
  let headers = buildHeaders(token, method, reqBody);
  let r = await fetch(CONFIG.gateway, { method, headers, body: reqBody });
  if (r.status === 401 || r.status === 403) {           // token 过期 → 重解重试一次
    try { token = getToken(true); headers = buildHeaders(token, method, reqBody); r = await fetch(CONFIG.gateway, { method, headers, body: reqBody }); } catch (_) {}
  }
  res.writeHead(r.status, {
    'Content-Type': r.headers.get('content-type') || 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  if (!r.body) { res.end(await r.text()); return; }
  const reader = r.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
  res.end();
}

// ===================== HTTP 服务 =====================
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const bodyBuf = Buffer.concat(chunks);
    try {
      // 若设置了 TA_API_KEY，则校验本地客户端的 Authorization
      if (CONFIG.apiKey) {
        const auth = String(req.headers['authorization'] || '');
        const given = auth.replace(/^Bearer\s+/i, '').trim();
        if (given !== CONFIG.apiKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        }
      }
      if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) return await forward(bodyBuf, res);
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list',
          data: ['chat-pro', 'chat-lite', 'chat-flash'].map(id => ({ id, object: 'model', owned_by: 'teleai' })) }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String((e && e.message) || e) } }));
    }
  });
});

server.listen(CONFIG.listenPort, '127.0.0.1', () => {
  console.log('[teleagent-shim] listening on http://127.0.0.1:%d/v1', CONFIG.listenPort);
  console.log('[teleagent-shim] account=%s deviceId=%s installId=%s', CONFIG.account, CONFIG.deviceId, CONFIG.installId);
  console.log('[teleagent-shim] apiKey 校验: %s', CONFIG.apiKey ? '开启（用 TA_API_KEY）' : '关闭（本地任意 key 均可）');
  try { getToken(); console.log('[teleagent-shim] token loaded OK'); }
  catch (e) { console.error('[teleagent-shim] token load failed:', e.message); }
});
