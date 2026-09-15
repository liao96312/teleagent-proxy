# TeleAgent 模型反代 —— 本地 OpenAI 兼容接口（两种方案）

![cover](assets/cover.png)

> 封面图由 TeleAgent 自己的生图工具生成（`内部工具/生图`）。

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
| **工具调用** | ✅ 支持**自定义 tools**（网关原生 OpenAI） | ✅ 支持**内核自带工具**（bash / 读写文件 / 生图 / 联网搜索 / MCP）<br>❌ 不接受调用方自定义的 `tools` |
| 实现状态 | **已实现**（`scripts/teleagent-shim.js`） | **已实现**（`scripts/teleagent-local-shim.js`） |

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
- [10. 文档与文件索引](#10-文档与文件索引)

---

## 0. 快速开始（老手看这段就够）

> **推荐用 Go 版**（传输层指纹与 TeleAgent 内核一致 + 用真实内核会话）。

```bash
# 一次性：解出 safeStorage 的 AES key -> token.key
scripts\setup.cmd

# 一次性：编译 Go 版（需 go1.26.x，与内核同版本；见 §2.6）
scripts\go\build.cmd

# 每次开机（前提：TeleAgent 已打开并登录）
scripts\start-shim-go.cmd      # 自动取本地会话密钥 + 启动

# 验证
curl http://127.0.0.1:8788/v1/models
```

<details>
<summary>备选：Node 版（不装 Go 时可用）</summary>

```bash
scripts\start-shim.cmd
```
</details>

然后在客户端里填：
```
Base URL : http://127.0.0.1:8788/v1
API Key  : teleagent          （本地不校验，随便填；见 §6）
Model    : chat-pro | chat-lite | chat-flash
```

**额外能力（Go 版）**：
- 生图：`POST /v1/images/generations`（模型 `image-generation-pro`，尺寸 ≥1920×1920）
- 视觉：聊天请求里带 `image_url` 即可（自动切 `vision-standard`）

详见 [`docs/image-and-vision.md`](docs/image-and-vision.md)。

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

### 2.6 ★ 想要传输层也像 App？用 Go 版（推荐）

Node 版的 HTTP 头可以对齐，但 **TLS ClientHello 指纹**（Go vs Node/OpenSSL）无法伪装。
因此**主推 Go 版**：用内核同版本 Go（1.26.5）+ 默认 `net/http`、`crypto/tls` 编译。

```
scripts\go\main.go          # 源码
scripts\go\build.cmd        # 编译 -> scripts\teleagent-shim.exe
scripts\start-shim-go.cmd   # 启动（自动取会话密钥）
```

Go 版比 Node 版多这几件事：
1. **传输层指纹与内核同源** —— 实测从自己进程内存 dump 出的 wire 与内核请求**逐字段逐顺序一致**；
2. **`X-Session-Id` 用真实内核会话** —— 每个对话调内核 `POST /session` 建一个真会话并在后续轮次复用，
   而不是每次随机生成；
3. **支持和图相关的能力**：
   - `POST /v1/images/generations` 生图（/ 图生图）
   - 带 `image_url` 的聊天请求自动切 `vision-standard` + `tool_call`（视觉）
   → 见 [`docs/image-and-vision.md`](docs/image-and-vision.md)

完整对比与原理见 [`docs/wire-fidelity.md`](docs/wire-fidelity.md)。
Node 版保留作为“不想装 Go”时的备选（头已对齐，但会话 ID 为合成、TLS 指纹不同）。

---

## 3. 方案 B：走 App 本地 server

> ✅ **已实现可用**：`scripts/teleagent-local-shim.js`。
> ✅ **可调用内核自带工具**（bash / 读写文件 / 生图 / 联网搜索 / MCP）。
> ⚠️ **不接受调用方自定义的 `tools`**（pi 自己的工具链用不了）。
> 需要自定义工具调用（如 pi 做编码）请用[方案 A](#2-方案-a直连云网关)，详见 [§3.6](#36-工具调用能力实测结论)。

### 3.0 快速使用

```bash
# 一次性 / 每次开机：从 TeleAgent 进程取本地会话密钥
teleagent\runtimes\python\python.exe scripts\get-session-key.py

# 启动方案 B shim（可双击）
scripts\start-local-shim.cmd

# 自检
curl http://127.0.0.1:8788/v1/models
```

然后客户端照常填 `http://127.0.0.1:8788/v1`（与方案 A 同一端口，**pi 配置无需改动**）。

前置：**TeleAgent 必须正在运行并已登录**。

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

### 3.3 本仓库的实现（`scripts/teleagent-local-shim.js`）

它做的事：
1. 从同目录 `session.key` 读 `sessionKey`（没有就读 `TA_SESSION_KEY`；失效时自动重跑 `get-session-key.py`）。
2. 把 OpenAI 请求翻译成内核接口：
   ```
   POST /v1/chat/completions
     └─→ POST http://127.0.0.1:4397/session              # 每个会话建一个内核会话
         POST http://127.0.0.1:4397/session/:id/message  # 发消息，拿 parts
   ```
   出站请求带本地签名：
   ```js
   const ts  = Date.now();                                 // 毫秒!
   const rnd = crypto.randomBytes(12).toString('hex');
   const msg = ['local-v1', method, '/session', ts, rnd].join('\n');
   const sig = crypto.createHmac('sha256', sessionKey).update(msg).digest('base64url');
   // X-SA-Sign-Version / X-SA-Timestamp / X-SA-Nonce / X-SA-Signature
   ```
3. **会话映射**：OpenAI 请求没有会话 ID。shim 用「历史消息前缀的 SHA1」把多轮对话绑到同一个内核会话：
   每轮结束后记录 `hash(本轮全部消息) -> 内核会话ID`，下一轮（历史 = 上轮全量）就能命中同一个会话。
   （也可以把多个内核会话完全独立，代价是丢失上文。）
4. **响应转换**：内核返回的 `data.parts` 里 `type=="text"` 的部分拼成 `choices[0].message.content`；
   `stream:true` 时把这段文本按块模拟成 SSE（内核接口本身是一次性返回）。
5. **空响应兜底**：刚建会话时偶发空回复，会自动重发一次。

### 3.4 内核接口速查（OpenCode 风格）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/session` | 列出会话 |
| POST | `/session` | 建会话，body `{"title":"..."}`，返回 `{id}` |
| POST | `/session/:id/message` | 发消息。body `{model:{providerID,modelID}, parts:[{type:"text",text:"..."}], system?, mode?}`，返回 `{data:{info,parts}}`。**同步阻塞**，整个 agent 循环跑完才返回 |
| GET | `/session/:id/message` | 取该会话消息列表 |
| POST | `/session/:id/abort` | **终止会话**。断线/超时后必须主动调，否则它会变孤儿继续跑 |
| GET | `/permission` | 列出待批权限请求 |
| POST | `/permission/:id/reply` | `{"reply":"always"}` 放行 |
| GET | `/provider` | 列 provider（可见 `NewApi` → 网关 baseURL + apiKey） |
| GET | `/config` | 内核配置（`agent` / `mcp` / `provider`） |
| GET | `/openapi` | 路由摘要 |
| GET | `/global/event` | SSE 事件流 |

模型选择：`{"providerID":"NewApi","modelID":"chat-pro"}`。完整接口/鉴权/环境变量见 [`docs/kernel-internals.md`](docs/kernel-internals.md)。

### 3.5 优缺点
- ✅ 出站流量与 App 无异 → **被封风险最低**。
- ✅ 不用自己维护云签名算法（App 升级也不影响）。
- ✅ 已实现，pi 配置与方案 A 完全相同（同一端口）。
- ❌ **不支持自定义工具调用**（见下）。
- ❌ App 必须开着；`sessionKey` 每次启动会变，需重新获取（脚本已自动化）。
- ❌ 账号已被封时无用（App 自己也 401）。

### 3.6 工具调用能力（实测结论）

内核跑的是**它自己的 agent 循环**，工具集固定但功能完整。**实测有效：**

| 能力 | 状态 | 验证 |
|---|---|---|
| 执行命令（bash/PowerShell） | ✅ | 让它跑 `echo KERNEL_TOOL_OK`，真的执行并返回了 |
| 读写文件 / 搜索 / diff | ✅ | 内核自带 |
| **生图** | ✅ | 本仓库的 `assets/cover.png` 就是让它生成的 |
| 联网搜索 | ✅ | 百度搜索 AK/SK、`mcp.exa.ai` |
| MCP 扩展 | ✅ | `/config` 的 `mcp` 字段可挂 MCP server（默认挂了 playwright） |
| **调用方自定义 `tools`** | ❌ | 在 `/session/:id/message` 里传 OpenAI 风格 `tools`，模型回答“工具列表里没有 xxx” |

所以：
- **只想对话，或让 TeleAgent 自己干活**（自带工具已够强）→ 方案 B 完全够用，且最安全。
- **需要把 pi 自己的工具（read/write/edit/bash）接进去跑编码循环** → 只能用方案 A（网关是真正的 OpenAI 端点，原生支持自定义 tools）。
- 想给内核加工具：内核支持在 `/config` 配 **MCP server**，但那样跑的是**内核的** agent 循环。

细节见 [`docs/kernel-internals.md`](docs/kernel-internals.md)。

---

## 4. 接入 pi

### 4.0 模型与真实参数

内核里写死的三个模型（来自 `main-runtime.js`）：

| 模型 | 名称 | 上下文 | 最大输出 | 说明 |
|---|---|---|---|---|
| `chat-pro` | 旗舰 | 400,000 | 65,536 | 默认/最强 |
| `chat-flash` | 极速 | 400,000 | 65,536 | 快，长上下文 |
| `chat-lite` | 轻量 | 100,000 | 16,384 | 轻量任务 |

三者都开启 `tool_stream`。另外还存在 `chat-nano`（未在内核默认列表启用）。

### 4.1 配 provider
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
        { "id": "chat-pro",   "name": "TeleAgent 旗舰", "reasoning": true, "input": ["text"],
          "contextWindow": 400000, "maxTokens": 65536, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} },
        { "id": "chat-lite",  "name": "TeleAgent 轻量", "input": ["text"],
          "contextWindow": 100000, "maxTokens": 16384, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} },
        { "id": "chat-flash", "name": "TeleAgent 极速", "input": ["text"],
          "contextWindow": 400000, "maxTokens": 65536, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} }
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

### 4.4 在 pi 里用生图 / 视觉

先确认：模型配置里的 `input` 要包含 `"image"`（否则 pi 不会让你发图）：
```json
{ "id": "chat-pro", "input": ["text", "image"], ... }
```

#### 生图（走 bash 工具 + 一键脚本）
pi 没有内置生图工具，所以让它调本仓库提供的脚本：

1. 确认 shim 在跑（`netstat -ano | findstr :8788`）
2. 在 pi 里直接说：`生成一张「一只熊猫在敲代码，扁平插画」，存到 D:\panda.jpg`
3. pi 会执行：
   ```
   python <仓库>\scripts\ta-image.py "一只熊猫在敲代码，扁平插画" D:\panda.jpg
   ```
4. 约束：尺寸 **≥1920×1920**（默认 `2048x2048`），小图会被网关拒。

#### 视觉
1. 在 pi 里附上图片（三种方式任选）：
   - `Alt+V` 从剪贴板粘贴（Windows；WSL 同）
   - 把图片**拖进终端**
   - 提示里写 `@D:\shot.png`
2. 正常提问。pi 会以 OpenAI 多模态格式发出去，shim **自动**切 `model=vision-standard` + `X-Teleai-Run-Unit-Type: tool_call`。
3. 命令行/脚本场景可用：
   ```
   python <仓库>\scripts\ta-vision.py D:\shot.png "这个报错是什么意思？"
   ```

> 图片最小边 14 像素。两个脚本都用 Python 标准库，无需装依赖。

**⚠️ 重要区别**：这是**反代出来的裸模型能力**，不是复用内核的 `ImageGen` / `image_understanding` 工具。
所以内核工具帮你做的那些事（落盘命名、图生图编排、工具安全审查、多图重试）**都不包含**，
需要由 pi（或你）自己做。详见 [`docs/image-and-vision.md`](docs/image-and-vision.md)。

### 4.5 ★ 推荐用法：内核子代理（`teleagent` 工具）

上面的 §4.4 是「把内核当裸模型用」。但方案 B 真正的强项是另一种用法：
**把执行整体外包给内核自带的 agent loop，pi 只做规划与验收。**

```
pi（规划 / 验收 / 编排）
   │  teleagent 工具：一段自包含任务描述
   ▼
scripts/pi/teleagent-subagent.ts
   │  X-SA-* 本地签名 → POST /session/:id/message（同步阻塞）
   ▼
内核 127.0.0.1:4397 → App → 云网关
```

为什么值得：内核自带 PowerShell、读写文件、联网搜索、`ImageGen`、`image_understanding`、MCP——
这些能力用 §4.4 的裸模型路径**全部拿不到**，而用子代理就全都有了。

**安装**：

```bash
mkdir -p ~/.pi/agent/extensions
cp scripts/pi/teleagent-subagent.ts ~/.pi/agent/extensions/
# 确认 TeleAgent 已登录并取到本地会话密钥
python scripts/get-session-key.py
# 然后在 pi 里 /reload
```

**调用**（N 件独立的事用 `tasks` 扇出，内核会并发跑多个会话）：

```jsonc
// 单个任务
teleagent({ task: "...自包含任务...", timeoutSec: 900 })

// 扇出：不要发 N 次调用，也不要塞进一个 task 串行做
teleagent({
  tasks: [
    "生成 A 房间效果图，prompt 逐字照抄：...。只回报 RAW=<绝对路径>",
    "生成 B 房间效果图，prompt 逐字照抄：...。只回报 RAW=<绝对路径>"
  ],
  timeoutSec: 900,
  concurrency: 8
})
```

**实测性能**（详见 [`docs/pi-subagent.md`](docs/pi-subagent.md)）：

| 场景 | 耗时 |
|---|---|
| 9 张 3840×2160 生图，单用途任务扇出 | **~91 s**（串行 ≥10 min） |
| 宏压测 48 并发会话 | 9.46 s（串行应为 382 s），无排队 |

**两个必须知道的坑**：

1. **不要用 Node 内置 `fetch`**：内核 `message` 接口是同步阻塞的，undici 默认 `headersTimeout=300s`，
   任何 >5 min 的任务必抛 `fetch failed`。扩展里改用 `node:http` 裸请求绕过。
2. **超时 ≠ 失败，且内核不会自己停**：pi 报超时后，内核会话仍在跑（实测一个孤儿跑了 **44 分钟**，
   持续生图并反复覆盖产物文件）。扩展里的三条防线是：放弃时 `POST /session/:id/abort`、
   `signal.aborted` 时 abort、进程退出时 abort —— 另提供 `/ta-kill` 事后兜底。

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

重启电脑后：**确认 TeleAgent 已打开并登录**，然后双击启动脚本：

| 方式 | 脚本 | 前提 | 说明 |
|---|---|---|---|
| **★ Go 版（推荐）** | `scripts\start-shim-go.cmd` | **不需要 App** | 会话 ID 本地精确生成；传输层指纹与内核一致 |
| Node 版 | `scripts\start-shim.cmd` | token 未过期即可（App 可不开） | 头已对齐；TLS 指纹不同、会话 ID 为近似格式 |
| 方案 B | `scripts\start-local-shim.cmd` | **App 必须开着** | 走内核，出站流量最像 App；无自定义 tools |

> Go 版默认 **不依赖 TeleAgent 是否运行**。只有一个硬限制：**token 6 天过期**，
> 到期后必须重开 App 登录一次（`token.json` 不会自己刷新）。
>
> 若想让它向内核建“真会话”（需 App 运行），设 `TA_REAL_SESSION=1`——
> 但实测意义不大（云端看不到内核的会话列表，且 ID 格式已精确对齐，见 wire-fidelity §4.1）。

三者都监听**同一个端口 8788**，所以**客户端/pi 配置无需改动**，换着跑即可。

**不需要再跑 `setup.cmd`**（`token.key` 一直在，除非换机器 / 重装系统）。
**Go 版也不需要每次重新编译**（`teleagent-shim.exe` 在那儿就用）。

### 7.1 开机自启（可选）

把 **`start-shim-go.cmd`** 的快捷方式放进 `shell:startup`，或建「登录时运行」的计划任务。

> Go 版默认不依赖 App，**无需延迟等待**。
> （方案 B、或 Go 版设了 `TA_REAL_SESSION=1` 时才需要等 TeleAgent 先起来。）

### 7.2 常用检查

```powershell
netstat -ano | findstr :8788                       # 在跑吗
curl http://127.0.0.1:8788/v1/models              # 接口通吗

# 前台跑看日志（Go 版）
scripts\teleagent-shim.exe

# 前台跑看日志（Node 版）
"%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe" scripts\teleagent-shim.js
```

Go 版启动日志长这样：
```
[go-shim] listening on http://127.0.0.1:8788/v1
[go-shim] account=v1_public_xxx deviceId=... installId=...
[go-shim] apiKey 校验: 关（本地任意 key 均可）
[go-shim] 内核会话: 关（本地精确 ID，不依赖 App；设 TA_REAL_SESSION=1 可开）
[go-shim] token loaded OK
```

---

## 8. 迁移到别人的环境

拷贝 `scripts/` 到对方机器 →

1. 对方装好 TeleAgent 并登录；
2. 双击 `setup.cmd`（生成**对方自己的** `token.key`）；
3. （推荐）装 go1.26.x，跑 `go\build.cmd` 编译 Go 版；
4. 双击 `start-shim-go.cmd`（或 `start-shim.cmd`）；
5. 按 §4 配置对方的 pi。

**已自动探测、无需手改**：账号目录（选**有 token.json 且最新的** `users/v1_public_*`）、
`deviceId`/`installId`（读 `app-auth/device-meta.json`）、`token.json` / `token.key` / `session.key` 路径、Node/Python 路径。

**全部环境变量**（两个版本通用，带 ★ 的仅 Go 版用到）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `TA_PORT` | shim 监听端口 | `8788` |
| `TA_AES_KEY` | 直接提供 AES key（不读 token.key） | 读 `token.key` |
| `TA_API_KEY` | 设了就要求客户端带此 key（否则 401） | 空 = 不校验 |
| `TA_DATA_DIR` | TeleAgent 数据目录 | `%USERPROFILE%\.local\share\TeleAgent` |
| `TA_ACCOUNT` | 账号分区目录名 | 自动选有 token.json 且最新的那个 |
| `TA_DEVICE_ID` / `TA_INSTALL_ID` | 覆盖设备号 | 读 `device-meta.json` |
| `TA_APP_VERSION` | `X-App-Version` | `2.5.0` |
| `TA_SK` | 通道密钥 | 内嵌默认值 |
| ★ `TA_KERNEL_URL` | 内核本地地址（向内核建真会话时用） | `http://127.0.0.1:4397` |
| ★ `TA_SESSION_KEY` | 本地签名密钥（不读 `session.key`） | 读 `session.key` |
| ★ `TA_REAL_SESSION` | `1` = 向内核建真会话（需 App 运行）；默认 `0` = 本地精确生成会话 ID | `0` |

> 若不想装 Go：直接用 `start-shim.cmd`（Node 版），功能一样，只是 TLS 指纹不同、
> `X-Session-Id` 为合成 ID。

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

## 10. 文档与文件索引

**文档（`docs/`）**

| 文件 | 内容 |
|---|---|
| [`kernel-internals.md`](docs/kernel-internals.md) | 内核/本地服务内部结构：进程与端️口、三层鉴权、注入的 env、OpenCode API、**自带工具清单** |
| `scripts/ta-image.py` | 一键生图（提示词 → 文件），供 pi 的 bash 工具调用 |
| `scripts/ta-vision.py` | 一键看图（图片 + 问题 → 回答） |
| [`image-and-vision.md`](docs/image-and-vision.md) | 生图/视觉：端点、模型名、尺寸限制、**与内核工具的区别** |
| [`auto-ban-risk-points.md`](docs/auto-ban-risk-points.md) | **自动化封禁风险点清单**：已证实触发、平台可检测项、风险排序、换指纹正确姿势 |
| [`local-monitoring.md`](docs/local-monitoring.md) | **TeleAgent 在本机采集/监控了什么**：设备指纹、反调试、内容审核、工具审查、用量上报 |
| [`ban-analysis-2.md`](docs/ban-analysis-2.md) | **第二次封号分析**：工具调用缺 review、模型消耗=0、标题写死 pi 等硬指纹与对策 |
| [`wire-fidelity.md`](docs/wire-fidelity.md) | 真机抓取的内核 wire 请求、头差异清单、**Go 版如何对齐传输层**、仍无法伪装的部分 |
| [`signature-algorithms.md`](docs/signature-algorithms.md) | **两套签名算法**（云网关两轮 HMAC + 内核本地 `X-SA-*`）逐字段说明 |
| [`ban-risk.md`](docs/ban-risk.md) | 封号机理、触发因素、规避建议（含真实案例时间线） |
| [`recon-notes.md`](docs/recon-notes.md) | 逆向过程：二进制地址、内存扫描方法、错误码表 |
| [`pi-subagent.md`](docs/pi-subagent.md) | **pi 内核子代理**：设计、四个「慢」的根因、并发压测数据、**孤儿会话治理**、验收职责划分 |

**方案 A（直连网关，支持自定义 tools）—— ★ 推荐用 Go 版**

| 文件 | 内容 |
|---|---|
| `scripts/go/main.go` | **Go 版实现（主推）**：同版本 Go 1.26.5，传输层指纹与内核一致 + 真内核会话 |
| `scripts/go/build.cmd` | 编译 → `scripts/teleagent-shim.exe` |
| `scripts/start-shim-go.cmd` | 启动 Go 版（自动取会话密钥） |
| `scripts/teleagent-shim.js` | Node 版（备选，头已对齐；TLS 指纹不同、会话 ID 为合成） |
| `scripts/start-shim.cmd` | 启动 Node 版 |
| `scripts/setup.py` / `setup.cmd` | 一次性：解出 safeStorage AES key → `token.key` |
| `scripts/scan-gateway-req.py` / `compare-wire.py` | 从进程内存 dump / 对比真实 wire 请求 |
| `scripts/scan-req-body.py` | dump 请求 body 结构与是否带 tools |

**方案 B（走 App 本地 server，可用内核自带工具）**

| 文件 | 内容 |
|---|---|
| `scripts/teleagent-local-shim.js` | 实现（本地签名 + 会话映射 + SSE 模拟） |
| `scripts/get-session-key.py` | 从 TeleAgent 进程内存取 `SUPER_AGENT_LOCAL_SESSION_KEY` → `session.key` |
| `scripts/kernel-probe.js` | 带本地签名探测内核接口（调试用） |
| `scripts/start-local-shim.cmd` | 启动方案 B（先取密钥再起 shim） |
| `scripts/pi/teleagent-subagent.ts` | **pi 内核子代理扩展**（方案 B 推荐用法：并发扇出 + 防孤儿 + 自动放行），见 [`docs/pi-subagent.md`](docs/pi-subagent.md) |

**其他**：`assets/cover.png`（封面，由 TeleAgent 生图工具生成）、`LICENSE`。

---

**一句话**：方案 A 装一次（`setup.cmd`）→ 编译一次（`go\build.cmd`）→ 之后开机双击 `start-shim-go.cmd`（推荐）或 `start-shim.cmd`。
两者都监听 `127.0.0.1:8788/v1`，客户端配置不用改。
**要安全**选方案 B（走 App 本地 server）；**要自定义工具（pi 编码）**选方案 A（优先 Go 版）。
