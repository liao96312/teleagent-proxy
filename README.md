# TeleAgent 模型反代 —— 本地 OpenAI 兼容接口（两种方案）

把 **TeleAgent（电信 AI「超级智能体」桌面 App）** 的模型能力，在本机暴露成**标准 OpenAI 兼容接口**（`http://127.0.0.1:8788/v1`），让 pi / Cline / Cursor / 任何 OpenAI 客户端 / 脚本都能调用它的模型（`chat-pro` / `chat-lite` / `chat-flash`）。

本仓库给出**两种实现方案**，请按需选择：

| | 方案 A：直连云网关 | 方案 B：走 App 本地 server |
|---|---|---|
| 链路 | shim → **云网关** `agent.teleai.com.cn` | shim → **App 本地 server** `127.0.0.1:4397` → 云网关 |
| 出站流量特征 | 与 App **不同**（服务端可见"第二客户端"） | 与 App **完全一致**（由 App 进程发出） |
| 需要自己算云签名 | ✅ 需要（两轮 HMAC） | ❌ 不需要（App 自己算） |
| 需要 App 开着 | ❌ 不需要（token 有效期内可独立跑） | ✅ 必须开着 |
| 需要读 App 内存 | ❌ | ✅（取本地会话密钥） |
| 被封风险 | **较高** | **低**（但仍非零） |
| 实现状态 | **已实现可用**（本仓库 `scripts/teleagent-shim.js`） | **已逆向清楚，本文档给出完整实现步骤**（按需自行实现） |

> ⚠️ **合规与风险**：把 App 内额度搬到 App 外使用，违反服务商条款。**已有账号因本方法被封（`40109 current user is banned`）的真实案例**，详见 [`docs/ban-risk.md`](docs/ban-risk.md)。请仅在你自己的机器、自己的账号上研究，**风险自担**。想零风险请直接用官方 App。

---

## 目录

- [0. 快速开始（老手看这段就够）](#0-快速开始老手看这段就够)
- [1. 原理总览](#1-原理总览)
- [2. 方案 A：直连云网关](#2-方案-a直连云网关)
- [3. 方案 B：走 App 本地 server](#3-方案-b走-app-本地-server)
- [4. 接入 pi](#4-接入-pi)
- [5. 接入其它工具](#5-接入其它工具)
- [6. 关于 API Key](#6-关于-api-key)
- [7. 二次使用 / 一键恢复](#7-二次使用--一键恢复)
- [8. 迁移到别人的环境](#8-迁移到别人的环境)
- [9. 排错](#9-排错)
- [10. 文档索引](#10-文档索引)

---

## 0. 快速开始（老手看这段就够）

```bash
# 一次性：解出 safeStorage 的 AES key -> token.key
scripts\setup.cmd

# 每次开机：启动本地接口（127.0.0.1:8788）
scripts\start-shim.cmd

# 验证
curl http://127.0.0.1:8788/v1/models
```

然后在客户端里填：
```
Base URL : http://127.0.0.1:8788/v1
API Key  : teleagent          （本地不校验，随便填；见 §6）
Model    : chat-pro | chat-lite | chat-flash
```

---

## 1. 原理总览

TeleAgent 的模型端点**本身就是 OpenAI 兼容**的，只在外面套了一层私有鉴权（登录令牌 + HMAC 签名）。反代的核心就是**补上这层鉴权**。

### 方案 A（直连）
```
你的工具 (pi/Cline/脚本)
   │  OpenAI 协议: POST /v1/chat/completions
   ▼
本地 shim (127.0.0.1:8788)              ← scripts/teleagent-shim.js
   │  ① 从 token.json 解出登录令牌 X-Token（AES-256-GCM）
   │  ② 生成 ts(秒)+nonce(UUID)，算两轮 HMAC 签名
   │  ③ 带全部网关鉴权头，直连
   ▼
https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions
   ▼ SSE 原样透传回客户端
```

### 方案 B（走 App 本地 server）
```
你的工具
   │
   ▼
本地 shim (127.0.0.1:8788)
   │  带 X-SA-Signature（本地签名）+ X-Auth-Token(或等价头)
   ▼
App 本地 server (127.0.0.1:4397)   ← 由 TeleAgent 进程自带(Go/hertz)
   │  它持有登录态，自己算云签名、自己发请求
   ▼
云网关  ← 服务端只看到「App 在正常使用」
```
**方案 B 的关键优势**：出站请求由 **TeleAgent 本体进程**发出，指纹/心跳/会话节奏与真人用 App 完全一致，服务端无法区分"是不是 App 在用"。

两套签名算法细节见 [`docs/signature-algorithms.md`](docs/signature-algorithms.md)。

---

## 2. 方案 A：直连云网关

### 2.1 前置条件
- TeleAgent 已安装并**已登录**过（存在有效 `token.json`）。
- TeleAgent 自带运行时：`%USERPROFILE%\.local\share\TeleAgent\runtimes\{node,python}\`。
- 无需管理员权限，无需第三方依赖。

### 2.2 一次性初始化
双击 `scripts\setup.cmd`（内部用 TeleAgent 自带 Python 跑 `setup.py`）：
```
[+] AES key 已写入 token.key
    key = <64位hex>
```
它做的事：读 `…\TeleAgent\Local State` 的 `os_crypt.encrypted_key`（Electron safeStorage **v10**）→ 去掉 `DPAPI` 5 字节 → Windows DPAPI `CryptUnprotectData` → 32 字节 AES key → 写入 `token.key`。

### 2.3 启动
```
scripts\start-shim.cmd
```
自检：
```bash
curl http://127.0.0.1:8788/v1/models
# {"object":"list","data":[{"id":"chat-pro"},{...}]}

curl http://127.0.0.1:8788/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"chat-pro","messages":[{"role":"user","content":"Say OK"}],"max_tokens":200}'
# choices[0].message.content 有内容 = 成功
```

### 2.4 请求头形状（shim 自动生成）
```
POST /superCowork/sapi/api/v1/chat/completions
Authorization: Bearer sk-xxxxxxxx            # 通道密钥(内嵌固定)
X-Route-Target: ops-gateway
X-Token: <tenant>:<JWT>                      # 登录令牌
X-App-Version: 2.5.0
X-Device-Os / X-Device-Os-Version
X-Superagent-Device-Id / Install-Id
X-Superagent-Timestamp: <10位秒>
X-Superagent-Nonce: <UUID>
X-Superagent-Sign-Version: v1
X-Superagent-Signature: <64位hex>
X-Teleai-Client-Type: desktop / X-Teleai-Run-Unit-Type: agent_loop
User-Agent: super-agent/1.0
```

### 2.5 注意事项
- **不要**用错误签名反复试探网关 —— 会触发风控（`40105 疑似攻击` → `40109 封号`）。这是本仓库作者踩过的坑。
- `token.json` 有效期约 3~4 天，shim 会在 401/403 时自动重新解密；token 彻底过期需重开 App 登录。

---

## 3. 方案 B：走 App 本地 server

> **本方案文档化但未实现**（按要求不改动现有 shim）。下面是完整的落地方案。

### 3.1 原理
TeleAgent 进程内跑着一个**本地 HTTP server**（Go 写的 `hertz` 框架），监听 `127.0.0.1:4397`（另有 `:19876`）。它是 App 前端（Electron 渲染进程）与内核通信的桥：
- 它**自己持有登录态**，会**自己**用云签名去调网关；
- 前端给它发请求时要带**本地签名** `X-SA-Signature`（防其它程序乱调）。

所以：**我们只要冒充 App 前端，往 `127.0.0.1:4397` 发本地请求，出站就完全由 App 发出。**

### 3.2 需要什么
1. **本地会话密钥 `sessionKey`**（32 字节）
   - App 启动时由前端 `randomBytes(32)` 生成，通过**子进程环境变量** `SUPER_AGENT_LOCAL_SESSION_KEY` 传给内核；每次启动都变。
   - 获取办法（二选一）：
     - **(a) 读内核进程内存**：搜 `SUPER_AGENT_LOCAL_SESSION_KEY` 或直接定位 AUTH_STATE 解密密钥（需要先解出 AUTH_STATE 结构，见下）。
     - **(b) 读前端进程内存/日志**：Electron 渲染进程里持有同一密钥。
2. **本地签名算法**（已逆向，见 [`docs/signature-algorithms.md`](docs/signature-algorithms.md#2-本地-signature-app本地server)）：
   ```
   X-SA-Signature = base64url( HMAC-SHA256( sessionKey,
        ["local-v1", METHOD, pathWithQuery, Date.now()ms, <12字节hex随机>].join("\n") ) )
   ```
   > 注意：第 4 项是**毫秒**，第 5 项是**12 字节随机数的 hex**。
3. **AUTH_STATE**（App 自己维护的登录态密文）：
   ```
   AUTH_STATE = AES-256-GCM( SHA256(sessionKey), {token, deviceId, installId} )
   ```
   用它可验证你拿到的 sessionKey 是否正确。

### 3.3 实现步骤
1. **确认本地 server 在跑**
   ```powershell
   Get-NetTCPConnection -State Listen -LocalPort 4397
   # 应看到 OwningProcess = TeleAgent.exe 的 PID
   ```
   （未鉴权访问会返回 `401 Unauthorized`，`Server: hertz`，属正常。）
2. **取出 `sessionKey`**（按 3.2 的 (a)/(b)）。
3. **写一个新的本地 shim**（例如 `teleagent-local-shim.js`），把 OpenAI 请求翻译成 App 本地 server 的接口：
   - 监听 `127.0.0.1:8788/v1/*`（对外仍是 OpenAI 协议）；
   - 对每个出站请求：
     ```js
     const ts = Date.now();                       // 毫秒!
     const rnd = crypto.randomBytes(12).toString('hex');
     const msg = ['local-v1', method, pathWithQuery, ts, rnd].join('\n');
     const sig = crypto.createHmac('sha256', sessionKey).update(msg).digest('base64url');
     headers['X-SA-Signature'] = sig;
     headers['X-SA-Timestamp'] = String(ts);
     headers['X-SA-Nonce'] = rnd;
     // 再按 App 前端的真实请求头补齐（见 docs/signature-algorithms.md）
     ```
   - 转发到 `http://127.0.0.1:4397<真实路径>`。
4. **找到 App 聊天用的真实本地路径**
   - 参考内核日志：`%USERPROFILE%\.local\share\TeleAgent\users\<account>\log\super-agent-server-*.log`（里面有 `receive request method=... path=...`）。
   - 或用抓包（mitmproxy / Fiddler 看 `127.0.0.1:4397` 流量）确定对话/流式接口路径与 body 结构。
5. **SSE 透传**：本地 server 是流式的，shim 原样把 SSE 转发回客户端即可。

### 3.4 优缺点
- ✅ 出站流量与 App 无异 → **被封风险最低**。
- ✅ 不用自己维护云签名算法（App 升级也不影响）。
- ❌ App 必须开着；`sessionKey` 每次启动变，需要自动重新获取。
- ❌ 本地接口不是标准 OpenAI 格式，需要一层协议翻译（工作量主要在"找真实路径 + 对齐 body"）。
- ❌ 账号已被封时无用（App 自己也 401）。

---

## 4. 接入 pi

pi 的自定义 provider 配在 `%USERPROFILE%\.pi\agent\models.json`，key 在 `%USERPROFILE%\.pi\agent\auth.json`。

**`models.json`**（在已有 `providers` 里**追加** `teleagent`，勿删原有）：
```json
{
  "providers": {
    "teleagent": {
      "baseUrl": "http://127.0.0.1:8788/v1",
      "api": "openai-completions",
      "apiKey": "teleagent",
      "compat": { "supportsStore": false, "supportsDeveloperRole": false, "maxTokensField": "max_tokens" },
      "models": [
        { "id": "chat-pro",   "name": "TeleAgent chat-pro",   "reasoning": true, "input": ["text"],
          "contextWindow": 200000, "maxTokens": 65536, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} },
        { "id": "chat-lite",  "name": "TeleAgent chat-lite",  "input": ["text"],
          "contextWindow": 200000, "maxTokens": 65536, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} },
        { "id": "chat-flash", "name": "TeleAgent chat-flash", "input": ["text"],
          "contextWindow": 200000, "maxTokens": 65536, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} }
      ]
    }
  }
}
```

**`auth.json`**：
```json
{ "teleagent": { "type": "api_key", "key": "teleagent" } }
```

使用：pi 里输入 `/model` → 选 `teleagent` → 选 `chat-pro`（改完即热重载，无需重启）。

---

## 5. 接入其它工具

| 字段 | 值 |
|---|---|
| Base URL / API Base | `http://127.0.0.1:8788/v1` |
| API Key | 任意（如 `teleagent`） |
| Model | `chat-pro` / `chat-lite` / `chat-flash` |

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:8788/v1", api_key="teleagent")
print(c.chat.completions.create(model="chat-pro",
      messages=[{"role":"user","content":"你好"}]).choices[0].message.content)
```

---

## 6. 关于 API Key

**默认 shim 不校验本地客户端传来的 key** —— 它只在**出站**时补真鉴权。所以这个 key **只是占位符，填什么都行**（本文档统一用 `teleagent`）。

去哪儿看：它就是你**自己填进客户端**的那个值：
- pi：`%USERPROFILE%\.pi\agent\auth.json` 的 `teleagent.key`
- pi：`%USERPROFILE%\.pi\agent\models.json` 的 `providers.teleagent.apiKey`

```powershell
type $env:USERPROFILE\.pi\agent\auth.json
```

**想设真 key**（防本机其它程序误用）：
```powershell
setx TA_API_KEY "my-secret-123"     # 永久；重启 shim 生效
```
之后客户端必须带这个 key，否则 401；再把 pi 配置里的 `teleagent` 换成它。
（shim 只监听 `127.0.0.1`，外网访问不到，此步非必须。）

---

## 7. 二次使用 / 一键恢复

重启电脑后：
1. 确认 **TeleAgent 已打开并登录**（方案 B 必须；方案 A 只要 token 没过期可不开）。
2. 双击 **`scripts\start-shim.cmd`**。

**不需要再跑 setup**（`token.key` 一直在，除非换机器/重装系统）。

**开机自启（可选）**：把 `start-shim.cmd` 的快捷方式放进 `shell:startup`，或建「登录时运行」的计划任务。

**常用检查**：
```powershell
netstat -ano | findstr :8788                                   # 在跑吗
"%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe" teleagent-shim.js   # 前台跑看日志
```

---

## 8. 迁移到别人的环境

拷贝 `scripts/` 到对方机器 →

1. 对方装好 TeleAgent 并登录；
2. 双击 `setup.cmd`（生成**对方自己的** `token.key`）；
3. 双击 `start-shim.cmd`；
4. 按 §4 配置对方的 pi。

**已自动探测、无需手改**：账号目录 `users/v1_public_*`、`deviceId`/`installId`（读 `app-auth/device-meta.json`）、`token.json` 路径、Node/Python 路径。

**可用环境变量覆盖**：

| 变量 | 作用 | 默认 |
|---|---|---|
| `TA_PORT` | shim 监听端口 | `8788` |
| `TA_AES_KEY` | 直接提供 AES key（不读 token.key） | 读 `token.key` |
| `TA_DATA_DIR` | TeleAgent 数据目录 | `%USERPROFILE%\.local\share\TeleAgent` |
| `TA_ACCOUNT` | 账号分区目录名 | 自动取 `users/v1_public_*` 第一个 |
| `TA_DEVICE_ID` / `TA_INSTALL_ID` | 覆盖设备号 | 读 `device-meta.json` |
| `TA_APP_VERSION` | `X-App-Version` | `2.5.0` |
| `TA_SK` | 通道密钥 | 内嵌默认值 |

---

## 9. 排错

| 现象 | 原因 / 解决 |
|---|---|
| `500 缺少 AES key` | 没跑 `setup.cmd`，或 `token.key` 不在预期位置。跑一次 setup。 |
| `500 找不到账号目录` | TeleAgent 没登录过。先打开 App 登录。 |
| `401 40101 缺少安全头` / `40104` | 签名参数变了（多半 App 升级）。按 [`docs/signature-algorithms.md`](docs/signature-algorithms.md) 用真机抓包重校。 |
| `401 40103` | 系统时间不准（签名用 10 位**秒**）。校准时间。 |
| `401 40105 疑似攻击` | 风控。**立即停止**，别再刷。 |
| `401 40109 current user is banned` | **账号被封**。见 [`docs/ban-risk.md`](docs/ban-risk.md)。 |
| `403 40301 版本过低` | `X-App-Version` 太旧，改 `TA_APP_VERSION`。 |
| pi 里看不到 teleagent | `models.json` JSON 写错，或没在 `auth.json` 加 `teleagent`。改完重开 `/model`。 |
| pi 能选但连不上 | shim 没在跑。双击 `start-shim.cmd`。 |
| 工具调用不生效 | 网关原生支持 tools（已实测）；确认请求确实带了 `tools`。 |

---

## 10. 文档索引

| 文件 | 内容 |
|---|---|
| [`docs/signature-algorithms.md`](docs/signature-algorithms.md) | **两套签名算法**（云网关两轮 HMAC + App 本地 `X-SA-Signature`）逐字段说明 |
| [`docs/ban-risk.md`](docs/ban-risk.md) | 封号机理、触发因素、规避建议（含真实案例时间线） |
| [`docs/recon-notes.md`](docs/recon-notes.md) | 逆向过程笔记：二进制地址、内存扫描方法、错误码表 |
| `scripts/teleagent-shim.js` | 方案 A 实现（自动探测 account/device/install） |
| `scripts/setup.py` / `setup.cmd` | 一次性：解出 AES key |
| `scripts/start-shim.cmd` | 启动 shim |

---

**一句话**：装一次（`setup.cmd`）→ 之后开机双击（`start-shim.cmd`）→ 客户端填 `http://127.0.0.1:8788/v1`。
**想更安全**：用方案 B（走 App 本地 server），出站流量与 App 一致。
