# 签名算法（两套）逐字段说明

TeleAgent 里其实有**两套独立的 HMAC 签名**，别搞混：

| | 云网关签名 | App 本地签名 |
|---|---|---|
| 头 | `X-Superagent-Signature` | `X-SA-Signature` |
| 谁验签 | `agent.teleai.com.cn` 网关 | 本机 App 内核（`127.0.0.1:4397`） |
| 密钥 | = 登录 JWT 的**签名段** | = 每次启动随机生成的 `sessionKey` |
| 时间戳单位 | **秒** | **毫秒** |
| 轮数 | **两轮**嵌套 HMAC | **单轮** HMAC |
| 编码 | 小写 hex | base64url |
| 用途 | 方案 A（直连） | 方案 B（走本地 server） |

---

## 1. 云网关签名（方案 A 用）

### 1.1 输入
- `X-Token` = 登录令牌，形如 `<tenant>:<JWT>`（例：`Em9xR4:eyJhbGciOi....`）
- `installId` = `users/.../app-auth/device-meta.json` 或本地 `app-auth/device-meta.json` 里的 `installId`
- `ts` = 当前时间戳，**秒**（10 位）
- `nonce` = 随机 UUID（带连字符）
- `body` = **实际转发的请求体原始字节**（必须和真正发出去的一模一样）
- `appVersion` = 如 `2.5.0`
- `scheme` = 固定字符串 `superagent-auth-v1`

### 1.2 算法（已真机验证）
```python
K        = token.split(".")[2]          # JWT 的第三段（签名段），43 字符

# —— 第 1 轮：分隔符是 "/" ——
m1       = "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}"
sig1     = hex( HMAC_SHA256(K, m1) )    # 64 hex

# —— 第 2 轮：分隔符是 "\n"（注意和第 1 轮不同！）——
bodyHash = hex( SHA256(body_bytes) )
m2       = "superagent-auth-v1\n{METHOD}\n{PATH}\n{ts}\n{nonce}\n{appVersion}\n{bodyHash}"
sig2     = hex( HMAC_SHA256(sig1, m2) ) # 64 hex  => X-Superagent-Signature
```

### 1.3 易错点（当年卡了很久）
1. **m1 用 `/`、m2 用 `\n`** —— 两轮分隔符不同，这是最大的坑。
2. **密钥是 JWT 第三段**，不是 `sk-` 通道密钥、也不是 `sessionKey`。网关自己签发的 JWT，所以它能验。
3. **`ts` 是秒**（用毫秒会报 `40103 时间不同步`）。
4. **头名小写** `X-Superagent-`。
5. **`bodyHash` 必须对应真正发出的 body**（连空格/字段顺序都要一致，因为网关会重算）。
6. 编码是**小写 hex**。

### 1.4 Node 参考实现
```js
function computeSignature(token, method, signPath, tsSec, nonce, bodyBuf, installId, appVersion) {
  const K = token.split(':').slice(1).join(':').split('.')[2];
  const m1 = ['superagent-auth-v1', token, installId, String(tsSec), nonce].join('/');
  const sig1 = crypto.createHmac('sha256', K).update(m1, 'utf8').digest('hex');
  const bodyHash = crypto.createHash('sha256').update(bodyBuf).digest('hex');
  const m2 = ['superagent-auth-v1', method, signPath, String(tsSec), nonce, appVersion, bodyHash].join('\n');
  return crypto.createHmac('sha256', sig1).update(m2, 'utf8').digest('hex');
}
```

### 1.5 网关错误码
| code | 含义 | 处理 |
|---|---|---|
| `40101` | 缺少安全头/签名头 | 补齐头 |
| `40103` | 时间不同步 | 用**秒**；校准系统时间 |
| `40104` | 签名无效 / 签名版本不支持 | 检查算法；带 `X-Superagent-Sign-Version: v1` |
| `40105` | 疑似攻击（风控） | **立即停止**，别继续试 |
| `40109` | 账号被封 | 见 `ban-risk.md` |
| `40301` | 客户端版本过低 | 提高 `X-App-Version` |

---

## 2. 本地签名（App 本地 server，方案 B 用）

App 前端（Electron）调用内核本地 server（`127.0.0.1:4397`，Go/hertz）时，要带一个防外部程序乱调的签名。

### 2.1 密钥 `sessionKey`
- 32 字节随机数，由**前端在 App 启动时生成**（`crypto.randomBytes(32)`）。
- 通过**子进程环境变量** `SUPER_AGENT_LOCAL_SESSION_KEY` 传给内核。
- **每次启动都会变** → 方案 B 的 shim 必须能自动重新获取（读进程内存）。

### 2.2 算法
```
ts   = Date.now()                              # 毫秒！
rnd  = 12 字节随机数的 hex（24 个 hex 字符）
msg  = ["local-v1", METHOD, pathWithQuery, ts, rnd].join("\n")
sig  = base64url( HMAC_SHA256(sessionKey, msg) )
=>  X-SA-Signature: <sig>
```
配套头（按 App 实际请求对齐）：`X-SA-Timestamp`、`X-SA-Nonce`，以及 App 自定义的其余头（如客户端类型、版本等，用抓包确认）。

### 2.3 Node 参考实现
```js
function localSignature(sessionKey, method, pathWithQuery) {
  const ts = Date.now();                                  // 毫秒
  const rnd = crypto.randomBytes(12).toString('hex');
  const msg = ['local-v1', method, pathWithQuery, ts, rnd].join('\n');
  return {
    sig: crypto.createHmac('sha256', sessionKey).update(msg, 'utf8').digest('base64url'),
    ts, rnd,
  };
}
// headers['X-SA-Signature'] = sig
// headers['X-SA-Timestamp'] = String(ts)
// headers['X-SA-Nonce']     = rnd
```

### 2.4 AUTH_STATE（校验 sessionKey 用）
App 自己保存的登录态密文：
```
AUTH_STATE = AES-256-GCM( SHA256(sessionKey), { token, deviceId, installId } )
```
- 拿到一个候选 `sessionKey` 后，用 `SHA256(sessionKey)` 去解内存里/磁盘上的 AUTH_STATE，
  能解出合法 JSON（含 `token`/`deviceId`/`installId`）就说明密钥对了。
- 注意：内存里大量 43 字符的 base64url 串是**本地签名**，不是网关签名，别拿来当密钥。

---

## 3. 两种方案怎么选

- **只要够用、不常跑、量小** → 方案 A（直连），实现简单，本仓库已可用。
- **在意账号安全、要长期跑** → 方案 B（走本地 server），出站流量与 App 完全一致。
- **两者都不保证 100% 安全** → 想零风险请用官方 App。
