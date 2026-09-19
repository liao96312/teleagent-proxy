# pi 内核子代理（`teleagent` 扩展）—— 设计、踩坑与提速

> 适用方案：**方案 B**（走 App 本地 server `127.0.0.1:4397`）。
> 相关：[`kernel-internals.md`](kernel-internals.md)、[`signature-algorithms.md`](signature-algorithms.md)、README §3.4 / §4。

---

## 1. 为什么要「子代理」这个形状

方案 B 的硬限制是：**调用方不能传自定义 `tools`**（见 README §3.6）。
但内核自己跑着一个功能完整的 agent loop —— PowerShell、读写文件、联网搜索、`ImageGen`、`image_understanding`、MCP。

所以正确的用法不是「把内核当裸模型用」，而是**把整件事外包给内核，让它自己动手做完**：

```
pi（规划 / 验收 / 编排）
   │  teleagent 工具：一段自包含任务描述
   ▼
pi 扩展 teleagent-subagent.ts
   │  X-SA-* 本地 HMAC 签名（session.key）
   ▼
内核 127.0.0.1:4397（OpenCode 风格 API）
   │
   ▼
App → 云网关
```

pi 侧只保留两个职责：**下发任务**、**验收产物**。中间的「怎么干」全部交给内核。

---

## 2. 用到的内核接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/session` | 建会话，`{"title":"..."}` → `{id}` |
| POST | `/session/:id/message` | 发任务。**同步阻塞**，整个 agent 循环跑完才返回 |
| GET | `/session/:id/message` | 取消息历史（断线后靠它捞结果） |
| GET | `/permission` | 列出待批权限请求 |
| POST | `/permission/:id/reply` | `{"reply":"always"}` 自动放行 |
| **POST** | **`/session/:id/abort`** | **终止会话 —— 治孤儿的关键，见 §5** |
| GET | `/session` | 列出所有会话（清孤儿用） |
| GET | `/config` | 内核当前配置（agent / mcp / provider / permission / instructions） |
| **PATCH** | **`/global/config`** | **运行时注册/覆盖 agent —— 换系统提示词的关键，见 §8**（`/config` 的同名方法返回 501） |

请求体：

```json
{
  "model": { "providerID": "NewApi", "modelID": "chat-pro" },
  "parts": [{ "type": "text", "text": "<任务>" }],
  "mode": "yolo",
  "agent": "ta-subagent"
}
```

`mode: "yolo"` = 内核全自动执行（对应 App 的「执行模式 → 全自动执行」），无人值守必需。

---

## 3. 「慢」的四个根因（实测定位，非推测）

### 3.1 `executionMode: "sequential"` —— 头号元凶

pi 扩展里若给工具标了 `sequential`，**pi 会把该工具的所有调用排成一条队**。
发 9 个任务不是并行，而是线性叠加：9 × 2~5 min = **30~45 min**。

→ 改成 `executionMode: "parallel"`。

### 3.2 Node 内置 `fetch` 的 300s 超时

内核 `POST /session/:id/message` 是**同步阻塞**接口，服务端要等整个 agent 循环跑完才吐出哪怕一个字节的响应头。
而 undici（Node 内置 `fetch`）默认 `headersTimeout = 300s` —— 于是**任何超过 5 分钟的任务必然抛 `fetch failed`（`HeadersTimeoutError`）**。

在 pi 会话日志里实测抓到：`HeadersTimeoutError ×5`、`ECONNRESET ×2`、`BodyTimeoutError`、`ConnectTimeoutError`。

→ 改用 `node:http` / `node:https` 裸请求（`rawRequest()`），**没有默认 headers/socket 超时**，只受我们显式设置的总截止时间约束。

### 3.3 一个任务塞多个交付物 + 子代理「自查循环」

让子代理在**一个**任务里做 3~5 件互相独立的事（比如出 5 张图），它只能串行，而且会自发进入
「生成 → 用视觉模型看自己生成的图 → 不满意 → 重做」的死循环。既慢，又极易**挑错文件**（详见 §6）。

→ 一个 task 只做一件事；N 件独立的事用 `tasks` 数组扇出（见 §7）。

### 3.4 权限轮询间隔

内核 agent loop 里几乎每个工具调用都要等一次权限应答。轮询间隔 1500ms 时，每次工具调用至少白等 1.5s。

→ 降到 150ms。

---

## 4. 并发到底能到多少（受控压测）

不是推测，是拿 `chat-flash` 发纯文本任务（一次完整 LLM 往返）实测的：

| 并发 N | 成功 | 总墙钟 | 若完全串行应耗时 | 观测到的最大并发重叠 |
|---|---|---|---|---|
| 12 | 12/12 | 13.05 s | 100.7 s | **12** |
| 24 | 24/24 | 8.16 s | 157.0 s | **24** |
| 48 | 48/48 | 9.46 s | 382.2 s | **48** |

- 48 个会话在 **8 ms 内**全部启动完成；
- 单任务延迟 p50 始终在 8.5~9.0 s，48 并发时最大才 9.45 s —— **完全没有排队退化**；
- 真实生图同样成立：10:47:38–44 建 9 个会话，9 张 3840×2160 图（单张生成约 40~60 s）
  全部落在 10:48:14–30 这 **16 秒窗口**内完成，整批墙钟 ~91 s。

**结论：并发瓶颈不在内核，在云网关的限流。** 扩展里默认 `concurrency` 上限设 8 只是保守取值，不是内核上限。

---

## 5. ★ 孤儿会话 —— 最坑的一个

### 5.1 现象

pi 侧 300s 超时 → 报 `fetch failed` → UI 显示「失败 / 已交差」。
**但内核会话根本没停。** 它继续在自己的 agent loop 里跑，成为一个没人管的孤儿。

真实案例（实测抓到）：

```
ses_f5d1ecb08...   创建于 10:24
  ├─ 10:48:31 / 10:48:41 / 10:48:45  生成 3 张图并「覆盖写入」
  ├─ 10:52:31  生图
  ├─ 10:54:06  生图
  ├─ 10:55:43  生图
  ├─ 10:58:07  生图
  ├─ 11:05:21  生图
  └─ 11:08:39  最后一条活动（被手动 abort 终止）

存活 44 分钟，期间持续烧 token、占并发槽、反复覆盖产物文件
```

### 5.2 它造成的连锁后果

1. **产物被反复覆盖**：已经生成好的正确文件，过几分钟被孤儿的「重做」版本冲掉 ——
   表现为「明明改好了又变回去」，极难排查；
2. **重复劳动**：每次重试就多一个孤儿，N 次重试 = N 个会话并发烧钱；
3. **诊断被误导**：pi 报的是「失败」，但磁盘上其实有文件，只是不知道是哪个版本。

### 5.3 正确姿势

**任何一次「我们不再等它」的时刻，都要主动 `abort`。**

扩展里的三条防线：

| 时机 | 动作 |
|---|---|
| `recoverFromHistory()` 也拿不回结果（确认放弃） | `POST /session/:id/abort` |
| pi 的 `signal.aborted`（用户 Ctrl+C / 取消） | `POST /session/:id/abort` |
| pi 进程退出（`process.once("exit")`） | 收掉本进程仍在等的所有会话 |
| 事后兜底 | 命令 `/ta-kill`（扫 10 分钟无动静的）、`/ta-kill all`（清全部空闲会话） |

> 注意：**超时 ≠ 失败**。所以在 abort 之前，必须先走 `recoverFromHistory()` 轮询
> `GET /session/:id/message`，确认能把结果捞回来 —— 捞不回来才 abort。
> 直接 abort 会把已经跑了大半的任务白扔掉。

---

## 6. 「验证」这一步该由谁做

**反模式**（我踩过的坑）：

> 让子代理「生成图 → 自己用视觉模型看图 → 不合格就重做」循环。

问题有三：
1. 慢（每轮都要多一次视觉模型调用 + 一次重生成）；
2. 它**经常挑错文件** —— 实测同一条提示词产出的**原料是完美的全景图，子代理落盘的却是裁切特写**；
3. 触发 §5 的孤儿循环。

**正确姿势**：

```
子代理只负责：执行 + 回报「原始产物的绝对路径」
pi 负责：      读取 / 验收 / 挑选 / 落盘
```

具体做法（在户型效果图项目里跑通的）：

1. 任务里明确写：「生成后**不要**复制、**不要**转换格式、**不要**裁剪、**不要**做任何图像处理，
   只把生成文件的绝对路径写出来」；
2. 强制子代理最后只回一行 `RAW=<绝对路径>`；
3. pi 侧拿到路径后自己 `fs.copyFileSync` 搬运，再自己做格式转换与验收。
4. **注意 AIGC 水印**（见 §8.3）：`.txt` / `.md` 交付物会被内核重写，验收别当成内容错误；
   要字节精确就让子代理写 `.json` / `.csv` / `.log`。

另外，**落盘环节也别让子代理做**。实测 .NET `Image::FromFile(...).Save(png)` 这条路径会出问题
（写出内容与源图不一致）；用 `Bitmap` + `Graphics.DrawImage` 全量重绘才可靠：

```powershell
$img = [System.Drawing.Bitmap]::FromFile($src)
$bmp = New-Object System.Drawing.Bitmap -ArgumentList $img.Width, $img.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($img, 0, 0, $img.Width, $img.Height)
$g.Dispose(); $img.Dispose()
$bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
```

---

## 7. 用法

### 7.1 单个任务

```jsonc
teleagent({
  task: "在 D:\\out 下生成 a.txt，内容为 OK。完成后回报文件的绝对路径与字节数。",
  timeoutSec: 900
})
```

### 7.2 扇出（N 件独立的事）★ 主要提速手段

**不要**发 N 次调用，也**不要**塞进一个 task 让子代理串行做。一次调用用 `tasks` 扇出：

```jsonc
teleagent({
  tasks: [
    "生成 A 房间效果图，prompt 逐字照抄：...。只回报 RAW=<绝对路径>",
    "生成 B 房间效果图，prompt 逐字照抄：...。只回报 RAW=<绝对路径>",
    "生成 C 房间效果图，prompt 逐字照抄：...。只回报 RAW=<绝对路径>"
  ],
  timeoutSec: 900,
  concurrency: 8
})
```

内核会并发跑多个会话，pi 侧收到一个合并结果（含每个子任务的 sessionId 与工具轨迹）。

### 7.3 参数表

| 参数 | 说明 |
|---|---|
| `task` | 单个自包含任务（目标、约束、期望产出、验收标准） |
| `tasks` | 批量扇出，与 `task` 二选一 |
| `model` | `chat-pro`（默认）/ `chat-lite` / `chat-flash` |
| `mode` | `execute`（默认）/ `readonly`（前缀注入只读约束） |
| `timeoutSec` | 默认 900，clamp 30~3600 |
| `concurrency` | 扇出并发上限，默认 = 任务数，clamp 1~8 |

---

## 8. 执行协议 v3 —— 把协议**注册成内核的 agent 系统提示词**

> v1/v2 是「把协议塞进任务文本去压内核那 29k 默认提示词」；v3 直接**换掉系统提示词本身**。
> 下面的机制全部经过实验验证，同时列出了**已证伪的旁路**——改之前先读 §8.2，别再走回头路。

### 8.1 机制（三行 API）

```bash
# 1) 注册/覆盖一个 agent：prompt 就是它的系统提示词
PATCH /global/config
{ "agent": { "ta-subagent": { "description":"…", "mode":"primary",
                              "prompt":"<协议>", "permission": <照抄主 agent 的 permission> } } }

# 2) 建会话时指定 agent → 内核用 ta-subagent 的 prompt 当系统提示词
POST /session
{ "title":"…" }

# 3) 发任务时带上 agent
POST /session/:id/message
{ "model":{"providerID":"NewApi","modelID":"chat-pro"},
  "parts":[{"type":"text","text":"<任务 + 一句尾部输出契约>"}],
  "mode":"yolo", "agent":"ta-subagent" }
```

要点：

- **`PATCH /global/config` 是运行时生效的，不用重启 App**（实测：PATCH 后立刻 `GET /config` 就能看到新 agent，且马上可用）；
- PATCH 是**深合并**，只加 `agent` 这一个 key，其余（provider / mcp / instructions / permission / small_model）实测**原样不变**；
- **PATCH 只在内存生效**：App 重启后内核配置由主进程重建，agent 就没了 → 客户端要用 `sessionKey` 变化当作版本号**自动重新注册**（协议文本改了也要重注，所以版本号里再叠一个 prompt 指纹）；
- agent 的 `permission` **直接照抄 `opencowork-default`**，别自己硬编码：App 改了权限策略时能自动跟上。实测这个 permission 已足够（powershell allow、`external_directory` 对区外 ask→扩展每 150ms 自动放行、bash deny）；
- **不要给 agent 加 `hidden: true`**：实测加了之后内核会**回退成默认人格**（prompt 不生效）；
- 注册失败（老版本内核、路由变动）时客户端**自动回退**到 v2 的做法（把协议写进任务文本），不会直接不能用。`TA_AGENT=""` 可手动关闭该机制。

### 8.2 已证伪的旁路（都试过，别再试）

| 想法 | 实测结果 |
|---|---|
| `POST /session/:id/message` 带 `system` 字段 | schema **只收 string**（收 array 报 `invalid body`），但就算传对类型也**收下不生效**：模型仍按默认 agent 回答 |
| 往工作目录放 `AGENTS.md` | 不读。产出仍是默认人格，token 无变化 |
| 往 `$XDG_CONFIG_HOME/opencode/AGENTS.md` 放 | 不读 |
| 往 `$XDG_CONFIG_HOME/opencode/opencode.jsonc` 写自定义 agent | 不读（也不热加载）。**内核二进制里 `opencode.json(c)` 字符串出现 0 次**，它根本没有配置文件加载器 |
| 往 `~/.config/opencode/opencode.jsonc` 写 | 同样不读。注意：**这个目录不是内核的配置目录**——内核的 `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME` 都是 `C:\Users\Administrator\.config\TeleAgent\users\<account-id>`（用 `scripts/env-probe.py` 扫进程内存实测得到）。之前的会话就是找错了目录，得出过「不热加载」的错误结论 |
| `PATCH /config` | 路由存在，但显式返回 `config.update is not implemented yet`（501）。**只有 `/global/config` 能用** |
| 改 `instructions` 里列的文件（如那个不存在的 `USER.md`） | 写入后无任何效果（配置与指令在启动时已定型） |
| 选内置的其它 agent（`title`、`skill-scanner-*`） | `agent` 字段确实生效，但这些 agent 全是 `permission:{"*":"deny"}` → **拿不到 shell/文件工具**；而且 `mode:"yolo"` **压不过** agent 自己的 permission deny |
| 选内置主 agent（`opencowork-*`） | 三个主 agent 的 prompt **完全一样**（同一份 29k），换了没意义 |
| 改 `user-agent-config.json`（`features.watermark.aiWatermarkEnabled`） | 该开关落在 App 侧 hook，实测置 `false` 后水印**照样注入**，且文件在 App 启动时读入 → 不可靠 |

> 换句话说：**内核的系统提示词只来自 `OPENCODE_CONFIG_CONTENT`**（App 在 JS 里现造、经 stdin 交给内核）。
> 任何磁盘文件都改不动它。能改的只有那个**运行时配置 API**。

### 8.3 它到底在压什么（为什么值得换掉）

内核默认系统提示词（29k 字符，备份在 `D:\tele proxy\main-agent-prompt.txt`）里有 **9 条与「无人值守子代理」直接冲突的硬要求**：

| 冲突项 | 内核原文强度 | 后果 |
|---|---|---|
| TodoWrite | "Use these tools VERY frequently"、"Always use TodoWrite" | 每个任务多烧 2~4 轮 |
| `report_final_files` | "you MUST call exactly once" | 多一轮 |
| 收尾 Working-directory 自检 | "mandatory every time" | 多一轮目录遍历 / 改错落盘位置 |
| 敏感操作确认 | "confirm before execution"，可用 `Question` 或自然语言 | **以「提问」收尾 = 无人值守下静默失败** |
| Background command 注册表模板 | prepare/start/poll/inspect/cleanup 五段式 | 长命令多 4~5 轮，还可能留孤儿进程 |
| Document Delivery Format | 未指定格式时 "default to creating an `.html`" | pi 拿到意外扩展名 |
| AIGC 水印说明 | 见 §8.4 | 子代理读回校验必失败 → 重做循环 |
| WebFetch 不猜 URL | "NEVER generate or guess URLs" | 联网任务无谓犹豫 |
| Language / Adaptive communication style | "always respond in Chinese" / 分技术与非技术用户 | 输出啰嗦 |

v1/v2 只能在任务文本里**逐条声明「以上作废」**（提示词级对抗）；v3 是**换掉提示词**，这些要求根本不存在了。

### 8.4 ★ AIGC 水印 —— 实测最坑的一环

内核会给交付物**自动注水印，子代理和 pi 都无法避免**：

| 扩展名 | 水印形态 | 实测 |
|---|---|---|
| `.txt` | 插入零宽字符（U+200B / U+200D） | 14 字节内容 → **10766 字节**（3584 个零宽字符） |
| `.md` | 文件头插入 `---AIGC: ...` 块 | 约 430 字节 |
| `.json` `.csv` `.log` `.py` `.png` | **无污染，字节精确** | 33 字节就是 33 字节 |

对策：要「字节精确 / 可解析 / 可 diff」的交付物**点 `.json` / `.csv` / `.log` 扩展名**；
协议里明确写「水印是预期行为，不要读回、不要清除、不要因它重做」，否则子代理会发现多出 3500 个字符然后进入重做循环。

### 8.5 实测数据

**A/B（2026-09-19，chat-pro，3 任务 × 2 臂，同时跑）**：臂 A = v2（协议写进任务文本），臂 B = v3（agent = 系统提示词）。

| 指标 | A：协议写进任务文本 | B：协议=系统提示词 |
|---|---|---|
| 正确率 | 2/3 | **3/3** |
| 批墙钟 | 22 s | **16 s** |
| 失败形态 | ★ **静默失败**：任务 #2 只跑了 1 轮、**0 次工具调用**，却报告 `RAW=…\note.txt` 说「已创建」，**文件根本不存在** | 无 |

> 静默失败是最危险的一类：编排方拿到的是「成功 + 路径」，磁盘上什么都没有。
> 机制上说得通——协议挤在任务文本里时，模型容易把任务当成一段**对话请求**，简单任务直接「回答」而不是动手。

**早前 v1 vs v2 的三轮 6+6 会话实测**（协议都在任务文本里）：两版正确率均 100%、都已是「2 轮对话 / 1 次工具调用」的地板；
v2 在联网调研类更瘦（5 轮/4 工具/31 s vs 6 轮/5 工具/38 s）。**结论：任务文本注入已到极限，所以才有 v3。**

**换提示词省不了 token**（别为此做优化）：内核会把全部工具 schema（`playwright_browser_*` 等 40+ 个）发给模型，
实测 input 从头到尾都是 **~26k**，把 29k 提示词换成 1k 协议后 input 几乎不变。收益在**冲突消失 + 输出契约合规**，不在 token。

### 8.6 复测与副本一致性

```bash
# 协议候选 / A/B：TA_FAST_FILE 指向协议文件（一行 @@@ 分隔「协议正文」与「尾部契约」）
TA_FAST_FILE="D:\tele proxy\bench\fast-v2.txt" node "D:\tele proxy\qoder-ta.mjs" fan <tasks.txt>
# 关掉 agent 机制、回退到「协议写进任务文本」
TA_AGENT="" node "D:\tele proxy\qoder-ta.mjs" run "…"
# 完全不加协议（纯直通）
node "D:\tele proxy\qoder-ta.mjs" run "…" --no-fast
```

**协议正文在三处各存一份，必须逐字一致**（`const SUBAGENT_PROMPT` 那个模板字符串）：

- 本机 CLI / Codex / Qoder 侧：`D:\tele proxy\qoder-ta.mjs`（不在本仓库）
- 本机 pi `teleagent` 工具侧：`~/.pi/agent/extensions/teleagent-subagent.ts`
- 本仓库：`scripts/pi/teleagent-subagent.ts`

三个文件**其余部分可以不同**（本机 pi 扩展额外带云端敏感截断重跑，仓库版没有），
只要求协议正文一致。核对脚本见仓库 `bench/README.md`。
历史教训：`scripts/pi/teleagent-subagent.ts` 曾整文件被本机版本覆盖，把已经 revert 掉的
「敏感截断自动重跑」又带回仓库 —— 同步时**只打补丁，不要 `copy` 整个文件**。

## 9. 安装

```bash
# 1. 拷扩展
mkdir -p ~/.pi/agent/extensions
cp scripts/pi/teleagent-subagent.ts ~/.pi/agent/extensions/

# 2. 确认 TeleAgent 已开着并登录，然后取本地会话密钥
python scripts/get-session-key.py

# 3. pi 里 /reload 使扩展生效
```

**环境变量**（都有默认值，一般不用设）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `TA_KERNEL_URL` | `http://127.0.0.1:4397` | 内核地址 |
| `TA_PROVIDER_ID` | `NewApi` | provider |
| `TA_SESSION_KEY` | — | 直接给 sessionKey |
| `TA_SESSION_KEY_FILE` | `~/.pi/agent/teleagent-session.key` → `<repo>/scripts/session.key` | 密钥文件 |
| `TA_GET_SESSION_KEY` | `<repo>/scripts/get-session-key.py` | 失效时自动重取 |
| `TA_REPO` | `D:\tele proxy\teleagent-proxy` | 仓库根 |
| `TA_PERMISSION_MODE` | `yolo` | 内核权限模式 |
| `TA_ORPHAN_AGE_MS` | `600000` | 孤儿判定阈值（10 分钟无动静） |

> `session.key` 每次 App 重启都会变。扩展会在 401 时自动重取（调 `get-session-key.py` 扫内存），
> 若取不到会明确报错。

---

## 10. 已知限制 / TODO

- **`recoverFromHistory()` 的「稳定判定」是启发式的**：靠连续两轮轮询文本不变来判定结束，
  极端情况下可能在模型长思考期间误判为已完成。更稳的做法是走 `GET /global/event` SSE 监听
  `session.idle` 之类的结束事件（尚未实现）。
- **进程被强杀（`taskkill /F`）时 `process.once("exit")` 不会触发**，仍会留孤儿 ——
  所以保留 `/ta-kill` 作为事后兜底。
- **`concurrency` 默认封顶 8 是保守值**。实测内核 48 并发无压力，真正的墙是网关限流；
  放开前请评估封号风险（见 [`auto-ban-risk-points.md`](auto-ban-risk-points.md)）。
- 内核侧 `POST /session/:id/message` 的阻塞语义决定了「一个任务 = 一条长连接」，
  暂时无法做流式进度回传（只能靠轮询历史模拟）。
- 协议现在真的住在**系统提示词**里（见 §8），但仍不是硬拦截：它只是一份写得很短的提示词，
  极端情况下模型仍可能自作主张；要硬拦得改配置里的 `permission`。
- **运行时注册的 agent 不会落盘**：App 重启后消失（客户端会自动重注，见 §8.1）。
  同理 `PATCH /global/config` **只能增/改、不能删**（传 `null` 会变成 `{}` 空壳，实测删不掉），
  所以探针 agent 只能等下次重启 App 才清掉。
- `user-agent-config.json` 里的 `features.watermark.aiWatermarkEnabled` 看着像能关水印，
  实测置 `false` 后水印**照样注入**，不要指望它。
- 调试内核 REST 用 `D:\tele proxy\ta-probe.mjs`，**必须**加 `MSYS_NO_PATHCONV=1`，
  否则 git bash 会把 `/session` 改写成 `C:/.../session` 导致 `400 bad request`；
  想挖内核/App 的环境变量用 `scripts/env-probe.py`（扫进程内存，同 `get-session-key.py` 的手法）。
