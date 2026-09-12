# TeleAgent 内核 / 本地服务内部结构

> 方案 B 的完整内部机理。信息来自：内核二进制符号、Electron `main-runtime-*.js`、
> 内核 `/config` `/provider` `/openapi` 接口、进程内存与日志。

## 1. 进程与端口全景

```
TeleAgent.exe                       Electron 主进程（生成 sessionKey、拉起下面两个子进程）
├─ TeleAgent.exe --type=renderer    渲染进程（UI）
├─ node.exe  resources/scheduler/index.cjs daemon   调度/执行器（Node）
├─ node.exe  app.asar.unpacked/dist-electron/im-service/index.cjs   IM 桥（Node）
└─ TeleAgent.exe  runtimes/super-agent-code/bin/TeleAgent.exe      内核（Go）  ← 监听 127.0.0.1:4397
```

| 服务 | 端口 | 语言/框架 | 协议 |
|---|---|---|---|
| **内核**（super-agent-code） | `127.0.0.1:4397`（另有 `:19876`） | Go + hertz | **OpenCode 风格 HTTP API** |
| 调度/执行器 | 由主进程分配 | Node | `/health` `/v1/executions` `/v1/setup/*` `/v1/audit/*` |

内核未鉴权访问返回 `401`（`Server: hertz`），**方案 B 就打到这个 4397**。

## 2. 三层鉴权，别搞混

| 层 | 头 | 密钥 | 谁验 |
|---|---|---|---|
| ① 云网关 | `X-Superagent-Signature` | JWT 签名段 | 云网关（方案 A 用） |
| ② 内核本地 | `X-SA-Signature` | `sessionKey`（HMAC，base64url） | 本地内核（方案 B 用） |
| ②' 内核本地（备选） | `Authorization: Basic base64(user:pass)` | `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | 同上 |

> 也就是说内核本地服务有两种等效鉴权：**HMAC 签名** 或 **Basic**。任一满足即可（见 `src/executor/local-auth.ts`）。

## 3. sessionKey

- 值：`base64url(randomBytes(32))` → **43 个字符**。
- 生成：Electron 主进程启动时生成，**每次启动都变**。
- 传递：主进程用**最小 env** 拉内核，敏感项（含它）改从 **stdin** 传给内核；同时也会作为
  `SUPER_AGENT_LOCAL_SESSION_KEY` 出现在 `node.exe`（scheduler / im-service）与 Electron 子进程的 **环境块**里。
- 取法：扫进程内存里的 `SUPER_AGENT_LOCAL_SESSION_KEY=...`
  → 见 `scripts/get-session-key.py`（本仓库已自动化）。

相关：内核还会收到 `SUPER_AGENT_AUTH_STATE = JSON.stringify(...)`（登录态密文），
校验方式：`AES-256-GCM(SHA256(sessionKey))` 能解开且含 `token/deviceId/installId` 即为正确密钥。

## 4. 内核被注入的敏感环境变量（主进程会从子进程 env 里删掉这些，防泄漏）

```
OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD    # 本地 server Basic 认证
SUPER_AGENT_AUTH_STATE                                 # 登录态
SUPER_AGENT_LOCAL_SESSION_KEY                          # 本地签名密钥
OPENCODE_CONFIG_CONTENT
OPENAI_API_KEY / ANTHROPIC_API_KEY / ARK_API_KEY       # ARK = 火山方舟（生图等）
SUPER_AGENT_TOOLS_BAIDU_SEARCH_AK / _SK                # 百度搜索工具
SUPER_AGENT_TOOLS_SECURITY_AK / _SK                    # 安全审查工具
SUPER_AGENT_TOOLS_BRIDGE_TOKEN
```

> 这也解释了为什么内核能生图：它拿着 `ARK_API_KEY`（火山方舟 / seedream）。

## 5. 内核 HTTP 接口（OpenCode 风格）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` `/ready` `/version` `/openapi` | 健康/版本/路由摘要 |
| GET | `/config` `/global/config` | 内核配置（agent / mcp / provider / permission / compaction） |
| GET | `/provider` | provider 列表（可见 `NewApi` → 网关 baseURL + apiKey + `useSuperAgentAuth`） |
| GET/POST | `/session` | 列表 / 新建会话（`{title}` → `{id}`） |
| GET | `/session/:id/message` | 会话的消息列表 |
| POST | `/session/:id/message` | **发消息**：`{model:{providerID,modelID}, parts:[{type:"text",text}], system?, agent?}` → `{data:{info,parts}}` |
| GET | `/session/status` `/global/session/status` | 会话状态 |
| GET | `/global/event` `/event` | SSE 事件流 |
| GET | `/permission` `/mcp` `/skill` `/experimental/tool/ids` | 权限/插件/技能/工具 id |
| GET | `/file` `/file/read` `/file/write` `/project` | 文件与项目 |

消息返回结构（关键）：
```jsonc
{ "data": {
    "info":  { "role":"assistant", "finish":"stop", "tokens": {...} },
    "parts": [
      { "type":"step-start" },
      { "type":"reasoning", "text":"..." },
      { "type":"text",      "text":"..." },      // ← 正文
      { "type":"tool",      "tool":"bash", "state": {...} },
      { "type":"step-finish" }
    ] } }
```

探针工具：`scripts/kernel-probe.js`（自动带本地签名）。

## 6. 内核自带工具（方案 B 能用！）

**内核跑的是它自己的 agent 循环，工具集固定且功能完整**。实测有效：
- 执行命令（bash / PowerShell）——实测 `echo KERNEL_TOOL_OK` 真跑通了；
- 读写文件、搜索、diff；
- **生图**（`internal/tool/imagegen`：`ImageGenTool` / `WithRefTool` / `imageGenArgs`，走 ARK）；
- 联网搜索（百度搜索 AK/SK、`mcp.exa.ai`）；
- **MCP 扩展**：`/config` 的 `mcp` 字段可挂载 MCP server（默认挂了 `@playwright/mcp`）；
- 可在 `/config` 的 `agent` 字段定义自定义 agent（prompt / mode / temperature）。

**但**：`POST /session/:id/message` 里传的 OpenAI 风格 `tools` 定义**会被忽略**
（模型会回答"工具列表里没有 xxx"）。也就是说：
- ✅ 能调用**内核自带的**工具；
- ❌ 不能注入**调用方自定义的**工具（pi 的 read/write/edit 等）。

→ 需要自定义工具链（pi 做编码）仍要用方案 A（网关原生 OpenAI）。

## 7. 多 provider 结构

`main-runtime-*.js` 里会打印：
```
Effective model relay URLs: { newApiBaseUrl, toolsNewApiBaseUrl, superAgentApiBaseUrl }
```
即内核至少持有三套上游：
- `NewApi`（默认，对话模型）→ `https://agent.teleai.com.cn/superCowork/sapi/api/v1`
- `toolsProvider.NewApi`（工具链用的模型）
- `toolsProvider.SuperAgentAPI`（平台 API）

模型别名：`chat-pro` / `chat-lite` / `chat-flash`（`/provider` 可查全量）。

## 8. 会话与多轮

- 内核会话由 `POST /session` 创建，服务端保存全部上下文。
- OpenAI 请求无会话 ID，方案 B 的 shim 用「历史消息前缀哈希 → 内核会话 ID」映射（见 `teleagent-local-shim.js`）。
- 消息以 `parts` 形式存储；`GET /session/:id/message` 可取历史。
