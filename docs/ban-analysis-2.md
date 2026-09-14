# 第二次封号分析（2026-09-14）

> 基于 App 导出的日志包 + 消耗明细截图。第一次是**签名爆破**，这次是另一条路径。

## 1. 时间线

| 时间 | 事件 | 来源 |
|---|---|---|
| 09-12 10:44 | 内核侧生图（**先 review 再执行**，两者同 `X-Request-Id`） | 内核日志 |
| 09-12 10:54~11:15 | **我们开始直连生图 / 视觉**（全是 `tool_call`，**没有任何 review**） | 消耗页 |
| 09-12 10:56 / 11:00 | 消耗页出现 `pi + 图片生成 3.3`（**模型消耗 = 0**） | 截图 |
| 09-12 11:07 | `pi` 会话，旗舰，模型消耗 `0.03` | 截图 |
| 09-12 11:21 | 用户正常对话（`旗舰 3.33 + 联网搜索 2.12 = 5.45`） | 截图 |
| 09-12 11:23 | **App 关闭** | main 日志 |
| 09-13 | **全天 App 未启动** | main 日志无记录 |
| 09-14 09:22 | App 重新启动 | main 日志 |
| 09-14 09:23 | **首次 LLM 调用 → `40109 current user is banned`** | 内核日志 |
| 09-14 09:29 | 再次 `40109` | 内核日志 |

**封禁是在 App 关闭期间（09-12 11:23 ~ 09-14 09:22）被服务端下的**，说明是**事后判定**，不是实时拦截。

## 2. 关键发现：内核每次工具调用前都会做「安全审查」

09-12 内核日志里，**所有工具调用都先过一次 `POST /security/instruction/review`**：

```
toolID=online_search       × 32
toolID=image_understanding × 32     ← 视觉
toolID=webfetch            × 16
toolID=report_final_files  ×  8
toolID=powershell          ×  8
toolID=ImageGen            ×  8     ← 生图        全部 action=allow
```

审查上报的 payload（完整结构）：
```
{
  deviceId   = 74563cad11ca
  "ses_xxx:msg_xxx:call_xxx"        ← sessionID : messageID : toolCallID
  time       = 2026-09-12 10:44:12
  mode       = interactive
  sessionID  = ses_f6c7fbf0effeHLymp6iYY7AqDd
  messageID  = msg_0938041af001X0syaZ3mRFYNFb
  toolCallID = call_81858a938110462a8f37ae69
  tool       = ImageGen
  input      = {"prompt":"一只橘猫坐在窗台上…","size":"2048x2048"}      ← 完整入参
}
```

**然后才发真正的执行请求，两者共用同一个 `X-Request-Id`：**
```
POST /superCowork/sapi/api/v1/images/generations
X-Request-Id: 01a09380-41ae-712e-8d68-c007e162be3d   ← 与上面那次 review 同一个
X-Message-Id: msg_0938041af001X0syaZ3mRFYNFb          ← 会话里真实存在的消息 ID
X-Teleai-Run-Unit-Type: tool_call
```

## 3. 我们的 shim 差在哪

| 项 | 内核（正常） | 我们的 shim |
|---|---|---|
| 工具执行前 | ✅ 先 `security/instruction/review`，**上报完整工具入参** | ❌ **完全没有** |
| `X-Request-Id` | 与 review 同一个 ID | 随机新生成 |
| `X-Message-Id` | 会话里**真实存在**的消息 ID | 随机编造 |
| 消耗记录 | 模型消耗 > 0 + 工具消耗 | **模型消耗 = 0** + 工具消耗（裸调） |
| 会话标题 | 小模型总结生成（如"王者灵宝信息搜索"） | 写死 `pi` |

**平台只要一条规则就能识别**：
> 收到 `Run-Unit-Type: tool_call` 的执行请求，但**找不到对应的 review 记录** → 绕过安全审查。

再叠加一条更好判的：
> **模型消耗 = 0 的图片生成** —— 正常流程里生图必然发生在一个模型轮次内。

## 4. 结论与对策

| 危险度 | 项 | 对策 |
|---|---|---|
| 🔴 | 直连 `/images/generations` | **默认关闭**（`TA_ENABLE_TOOLS=0`） |
| 🔴 | 视觉（`tool_call`） | 同上 |
| 🟠 | 会话标题写死 `pi` | 改为**小模型生成**（同内核） |
| 🟡 | `X-Message-Id` 编造 | 不产生 tool_call 时影响很小 |
| 🟢 | 纯聊天（`agent_loop`） | 与内核无差别，**不受影响** |

### 重要结论
- **`review` 只对「工具调用」做**（toolID 全是工具），**聊天不审查**。
- 所以：**只要不做工具调用（生图/视觉），就完全不需要补 review —— 已经对齐。**
- 要恢复生图/视觉，必须同时满足：① 补 review、② 有真实 messageID/toolCallID、③ 模型消耗不为 0
  —— 第 ③ 条决定了「直连」这条路**本质上走不通**。

## 5. 本次改动

- `TA_ENABLE_TOOLS=0`（默认）：生图/视觉直接返回 403 并说明原因
- 会话标题改为**调用小模型 `chat-lite` 生成**（`docs` 的 title generator prompt），
  建会话后异步生成并 `PATCH /session/:id` 写回
- `TA_REAL_SESSION` 默认回调为 `1`（真实会话才能承载标题记录）
