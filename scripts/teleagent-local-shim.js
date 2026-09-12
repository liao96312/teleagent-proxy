#!/usr/bin/env node
/**
 * teleagent-local-shim.js — 方案 B：走 App 本地 server
 *
 *   你的工具 → 本 shim(127.0.0.1:8788, OpenAI 协议)
 *            → App 内核本地 server(127.0.0.1:4397, OpenCode 协议)
 *            → 云网关（由 App 进程发出，流量特征与真人用 App 一致）
 *
 * sessionKey 从同目录 session.key 读；失效时自动跑 get-session-key.py 重新取。
 *
 * 已知限制：内核用自己固定的工具集，**不接受调用方传入的 tools 定义**，
 *          所以本方案只支持普通对话，不支持自定义工具调用（详见 README）。
 *
 * 依赖：Node >= 18（内置 fetch）。仅本机回环。
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const CONFIG = {
  port: Number(process.env.TA_PORT || 8788),
  kernel: process.env.TA_KERNEL_URL || 'http://127.0.0.1:4397',
  providerID: process.env.TA_PROVIDER_ID || 'NewApi',
  models: ['chat-pro', 'chat-lite', 'chat-flash'],
  keyFile: path.join(__dirname, 'session.key'),
  // 本地 server 鉴权
  signVersion: 'local-v1',
};

// ===================== sessionKey =====================
let _key = null;
function pythonPath() {
  const cands = [
    path.join(HOME, '.local', 'share', 'TeleAgent', 'runtimes', 'python', 'python.exe'),
    'python',
  ];
  for (const c of cands) { try { if (c === 'python' || fs.existsSync(c)) return c; } catch (_) {} }
  return 'python';
}
function refreshKey() {
  // 1) 直接跑脚本重新抓
  try {
    const py = pythonPath();
    const out = execFileSync(py, [path.join(__dirname, 'get-session-key.py')], { encoding: 'utf8', timeout: 300000 });
    const k = (out || '').trim().split('\n').pop().trim();
    if (k) { _key = k; return _key; }
  } catch (e) { /* 忽略，走下面读文件 */ }
  return loadKeyFile();
}
function loadKeyFile() {
  try {
    const k = fs.readFileSync(CONFIG.keyFile, 'utf8').trim();
    if (k) { _key = k; return k; }
  } catch (_) {}
  return null;
}
function getKey(force) {
  if (process.env.TA_SESSION_KEY) return process.env.TA_SESSION_KEY;
  if (!force && _key) return _key;
  return loadKeyFile() || refreshKey();
}

// ===================== 本地签名 =====================
function signHeaders(method, pathWithQuery) {
  const key = getKey();
  if (!key) throw new Error('缺少 sessionKey（请先运行 scripts/get-session-key.py，或设 TA_SESSION_KEY）');
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = [CONFIG.signVersion, method.toUpperCase(), pathWithQuery, timestamp, nonce].join('\n');
  const signature = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return {
    'X-SA-Sign-Version': CONFIG.signVersion,
    'X-SA-Timestamp': timestamp,
    'X-SA-Nonce': nonce,
    'X-SA-Signature': signature,
  };
}

async function kernelCall(method, urlPath, body, retry = true) {
  const headers = signHeaders(method, urlPath);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(CONFIG.kernel + urlPath, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if ((r.status === 401 || r.status === 403) && retry) {
    // 会话密钥变了（App 重启）→ 重新抓一次，再试
    getKey(true);
    const text = await r.text();
    console.error('[local-shim] 401/403:', text.slice(0, 200));
    return kernelCall(method, urlPath, body, false);
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

// ===================== 会话映射 =====================
// OpenAI 请求没有会话 ID；用「历史消息前缀的哈希」把多轮对话绑到同一个内核会话。
const sessionMap = new Map();   // historyHash -> kernelSessionId
const H = (arr) => crypto.createHash('sha1').update(JSON.stringify(arr)).digest('hex');

function splitMessages(messages) {
  const sys = messages.filter(m => m.role === 'system' || m.role === 'developer')
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n');
  const rest = messages.filter(m => m.role !== 'system' && m.role !== 'developer');
  const last = rest[rest.length - 1];
  const prefix = rest.slice(0, -1);
  return { sys, last, prefix, rest };
}

async function ensureSession(prefix) {
  const h = H(prefix);
  if (prefix.length && sessionMap.has(h)) return { id: sessionMap.get(h), created: false };
  const r = await kernelCall('POST', '/session', { title: 'pi-shim' });
  if (r.status !== 200 || !r.json || !r.json.id) throw new Error('创建内核会话失败: ' + r.text.slice(0, 200));
  return { id: r.json.id, created: true };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : (p.text || ''))).join('');
  return '';
}

// ===================== OpenAI <-> 内核 =====================
async function chatCompletion(body) {
  const messages = body.messages || [];
  const { sys, last, prefix, rest } = splitMessages(messages);
  if (!last) throw new Error('请求里没有可发送的用户消息');

  const modelID = CONFIG.models.includes(body.model) ? body.model : 'chat-pro';
  const { id: sessionId } = await ensureSession(prefix);

  const payload = {
    model: { providerID: CONFIG.providerID, modelID },
    parts: [{ type: 'text', text: textOf(last.content) }],
  };
  if (sys) payload.system = sys;

  const r = await kernelCall('POST', `/session/${sessionId}/message`, payload);
  if (r.status !== 200 || !r.json) throw new Error('内核调用失败(' + r.status + '): ' + r.text.slice(0, 300));

  const data = r.json.data || r.json;
  let info = data.info || {};
  let parts = data.parts || [];
  let text = parts.filter(p => p.type === 'text').map(p => p.text).join('');
  // 偶发空响应（内核刚建会话时）：补发一次
  if (!text && !parts.some(p => p.type === 'tool')) {
    const r2 = await kernelCall('POST', `/session/${sessionId}/message`, payload);
    if (r2.status === 200 && r2.json) {
      const d2 = r2.json.data || r2.json;
      info = d2.info || info;
      parts = d2.parts || parts;
      text = parts.filter(p => p.type === 'text').map(p => p.text).join('');
    }
  }
  const reasoning = parts.filter(p => p.type === 'reasoning').map(p => p.text).join('');
  const toolParts = parts.filter(p => p.type === 'tool');

  // 记下这一轮的历史哈希，下一轮（历史=本轮全量）才能命中同一会话
  sessionMap.set(H(rest), sessionId);
  sessionMap.set(H([...rest, { role: 'assistant', content: text }]), sessionId);

  return {
    text, reasoning, toolParts, info,
    usage: info.tokens || {},
    finish: info.finish || 'stop',
    modelID,
  };
}

function openaiResponse(result, model) {
  const usage = result.usage || {};
  return {
    id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: result.text },
      finish_reason: result.finish === 'stop' ? 'stop' : 'stop',
    }],
    usage: {
      prompt_tokens: usage.input || 0,
      completion_tokens: usage.output || 0,
      total_tokens: (usage.input || 0) + (usage.output || 0),
    },
  };
}

function sseStream(res, result, model) {
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish) => 'data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  }) + '\n\n';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
  });
  res.write(chunk({ role: 'assistant', content: '' }));
  // 内核是一次性返回，这里按块模拟流式输出
  const text = result.text || '';
  for (let i = 0; i < text.length; i += 24) {
    res.write(chunk({ content: text.slice(i, i + 24) }));
  }
  res.write(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

// ===================== HTTP 服务 =====================
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: CONFIG.models.map(id => ({ id, object: 'model', owned_by: 'teleagent-local' })) }));
      }
      if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
        const body = JSON.parse(raw || '{}');
        const result = await chatCompletion(body);
        if (body.stream) return sseStream(res, result, body.model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(openaiResponse(result, body.model)));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    } catch (e) {
      console.error('[local-shim] error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(e.message || e) } }));
    }
  });
});

server.listen(CONFIG.port, '127.0.0.1', () => {
  console.log('[local-shim] listening on http://127.0.0.1:%d/v1', CONFIG.port);
  console.log('[local-shim] kernel = %s  provider = %s', CONFIG.kernel, CONFIG.providerID);
  const k = getKey(true);
  console.log('[local-shim] sessionKey = %s', k ? (k.slice(0, 6) + '...(' + k.length + ')') : '未取到');
});
