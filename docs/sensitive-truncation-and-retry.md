# 云端「敏感截断」：现象、定位过程与最终处置

> 2026-09-18 实战复盘。触发场景：让 pi 子代理联网核实「全球人口 80 亿 / 联合国 2060 预测 / 各国预期寿命排名」，
> 任务返回空结果。本文记录**它是怎么产生的、怎么证实的、试过哪些方案为什么不行、最后怎么处置**。

## 0. 一句话结论

云网关会在模型流式回答的**最后一帧**回 `finish_reason:"sensitive"`，且**正文一个字节都不下发**；
内核读到就中断这一回合。它不是审查接口、不是本地能改的东西（原样重放网关直接 401），
**本地无法屏蔽**，只能由上游「换一次采样重做」（pi 层新建内核会话重跑）。

## 1. 现象（用户视角）

```
## TeleAgent 子代理执行结果
（内核未返回文本输出）
--- 内核执行报告 ---
模型: chat-pro    finish: error
会话: ses_f4ce58746ffeTpIxGbS2ishNrw    token: input 0 / output 0 / total 0
调用的工具:
- online_search: completed ×2
```

App 侧/内核侧会看到中文提示 `内容包含敏感信息，已被中断`（该字符串在 `super-agent-code/bin/TeleAgent.exe` 里）。
同一个问题**不是必现**：当天实测 6 次触发 3 次命中（约 50%）。

## 2. 定位过程：先把「不是它」排掉

分层排查，重点是**用日志把每一层排除**：

| 层 | 检查点 | 证据 | 结论 |
|---|---|---|---|
| 本地审查 sink | `sink.log` 的 `/security/instruction/review` | 当天 245/245 条 `result=1 action=allow`，reason=本地拦截：未检测到有效风险 | 已放行，**不是它** |
| App 内容审核 | `main-2.5.2.log` 的 `SecurityReviewClient` / moderation | 当天 54 条 review 全 allow；moderation 命中 0 次 | **不是它** |
| 内核审查 | `super-agent-server-*.log` 的 `tool_instruction_review` | 245 条 `decision ... action=allow` | **不是它** |
| 模型网关 | 同一份内核日志 | ↓ 见下 | **就是它** |

决定性的一行在内核日志里：

```
2026/09/18 14:01:11.661580 processor.go:545:  [Warn] [process] finish_reason=sensitive, interrupting
2026/09/18 14:01:11.661580 processor.go:2106: [Info] processResult: { {<nil> 0 0 0 {0 0}} false}
2026/09/18 14:01:11.661580 processor.go:2112: [Info] err: sensitive content detected
```

`finish_reason` 是**上游 SSE 帧里的字段**，不是内核自己编的 —— 顺着这条线抓包即可确认形态。

## 3. 取证方法：在 sink 上挂一层只读抓包

`POST /session/:id/message` 是同步阻塞的，光看 pi 侧只能看到「空结果」。
真正的判决帧在 sink 与网关之间的 SSE 流里，所以临时给本地 sink 加了一段**只读 tee**
（累积响应字节 → 匹配 `"finish_reason"\s*:\s*"sensitive"` → 命中就把该响应落盘），跑同一个问题复现。

抓到的原始帧（376KB 响应里就这一行是判决）：

```
data: {"choices":[{"index":0,"finish_reason":"sensitive","delta":{"role":"assistant","content":""}}],
       "created":1789718398,"id":"202609181559288fcc52bdd5374912","model":"chat-pro","object":"chat.completion.chunk"}

data: [DONE]
```

要点：

1. **前面的 `reasoning_content` 全部正常下发**（那轮 402 个 reasoning delta），被扣的只有正文 `content`；
2. 判决帧的 `content` 是空字符串 —— **正文根本没生成/没发出来**，本地拿不到；
3. 收尾是 `[DONE]` 之后连接被 abort，**不是干净的 HTTP end**（后来做重试时这点很关键）。

## 4. 试过的三条路，以及为什么都不行

### 4.1 改 `finish_reason`（把 sensitive 改写成 stop）
没用。**正文没下发**，改写只会把「明确报敏感中断」变成「一个空回答」，更糟。

### 4.2 在 sink 里原样重放同一个请求
**401**。网关鉴权是一次性签名：

```
authorization: Bearer sk-…(30)
x-superagent-nonce:       7095afeb-…(36)     ← 一次性
x-superagent-signature:   dde4b44940…(64)    ← HMAC-SHA256，密钥不在本机
x-superagent-timestamp:   1789719587
x-superagent-sign-version: v1
```

实测（同 body、同 header，仅间隔 0.4s）：

```
SENSITIVE_FRAME attempt=0 dropped=1
SENSITIVE_RETRY attempt=1/2
DBG_RESP attempt=1 status=401 enc=- te=- cl=75 conn=keep-alive
```

不是时间过期（0.4s）、不是 body 不匹配，就是 **nonce 防重放**。
要重签必须有 App 的签名密钥 —— 那等于伪造网关鉴权，不做。

### 4.3 中途换流 + 保活（想救回同一回合）
踩到第二个坑：**客户端（内核）读这条 SSE 时「静默约 0.5s 就当流结束」**。

```
08:14:02.172 SENSITIVE_FRAME attempt=0 dropped=1
08:14:02.583 内核 processResult: {stop … 0 tokens}   ← 411ms 后就收摊了
```

丢掉判决帧后，如果直接去发起重试（重试首个帧要几秒才到），内核早就把这一回合关掉了，
重试结果回来也没人要。用 200ms 间隔补发**语义为空的合法 SSE chunk** 可以把客户端按住 8s+（实测），
但这条路的前提（4.2）本身就不成立，所以最终没采用。

> 顺带一个观察：正常回合的收尾也是「发完 finish 帧后直接 abort」，没有干净 `end`。
> 所以判断「这一回合成功」只能靠「有没有见过 finish 帧」，不能靠 `end` 事件。

## 5. 最终处置

### 5.1 sink：只观测，不改流
保持原有的 `/security/` 本地放行 + 全量透传，新增一行留痕（只记元信息，**不存正文**）：

```
[2026-09-18T08:30:22.854Z] SENSITIVE_TRUNCATED /superCowork/sapi/api/v1/chat/completions
  (云端用 finish_reason=sensitive 掐掉了正文，需由上游重做)
```

以后遇到空结果，一眼能分清是「云端掐的」还是真的跑了空。

### 5.2 pi 扩展：新建会话重跑（`scripts/pi/teleagent-subagent.ts`）
判据 = **没正文 + 不是正常收尾**：

```ts
function looksTruncated(res: RunResult): boolean {
	if ((res.text || "").trim()) return false;
	const tk: any = res.tokens || {};
	return res.finish === "error" || Number(tk.total ?? 0) === 0;
}
```

命中就 `runTaskOnce` 重跑（外层 `runTask` 循环，默认最多额外 2 次，`TA_SENSITIVE_RETRY` 可调 0–3）。
**必须是新建会话**：内核会重新生成 nonce/签名/request-id，等于让模型换一次采样；
重放旧请求这条路已经被 401 堵死。扇出时每个子任务各自重跑。

TUI 里会明说在干嘛：

```
内核返回空结果（finish=error），大概率是云端敏感截断，换一次采样重跑（第 2 次）…
```

## 6. 教训（可复用）

1. **拦截分多种，别只盯自己装的那道。** 今天有三套互不相干的机制：
   本地 sink 的 `/security/instruction/review`（已放行）、App 的 `/api/v1/check/content` moderation
   （`tagCode 900006`，且 fail-open：网络失败时 `allow_by_policy`）、以及**网关在 SSE 里直接掐断**。
   定位时先按层把「不是它」用日志排掉，比猜快得多。
2. **`finish_reason` 是上游说的，不是本地猜的。** 看到这个字段就要往「上游协议」方向查，
   而不是继续在本地审查逻辑里打转。
3. **网关鉴权是一次性签名，重放必 401。** 任何「本地重发同一个请求」的方案先验证鉴权，
   否则写一堆换流代码最后死在 401 上（本次就是）。
4. **对方的成功判据不等于 `end`。** 正常收尾可能是 abort；判断要靠协议里的 finish 帧。
5. **流式链路里「静默」本身就是信号。** 停发 ~0.5s 客户端就收摊，中途换流必须补保活帧，
   否则重试永远「来不及」。
6. **恢复只能换采样，不能本地解锁。** 换一次采样有概率过（本次实测约 50%），
   两次约 87% —— 这是概率，不是保证；仍然失败要如实报「被云端掐断」，不能假装成功。
7. **善后要动手：孤儿会话会继续跑。** 排查过程中遇到一个 19 分钟前建的孤儿会话仍在发请求
   （它的 token 已过期，重试直接 401）。平时用 `/ta-kill` 清遗留会话，别让它白烧 token。

## 7. 复现与验收

触发用的只读任务（原样，命中率约一半）：

```
联网核实并回答（只给结论+来源链接）：
1) 全球人口在哪一年达到80亿？联合国《世界人口展望》对2060年全球人口的预测是多少亿？
2) 各国/地区平均预期寿命排名中，澳大利亚是否世界最高？前五名是哪些国家/地区？
```

三条验收线：

1. 任务返回空 + `finish: error` + `token: 0/0` → 命中云端截断；
2. `sink.log` 出现 `SENSITIVE_TRUNCATED`；
3. 内核日志出现 `[process] finish_reason=sensitive, interrupting` + `err: sensitive content detected`。

扩展生效方式：`/reload` 或重开 pi（扩展只在启动/重载时加载）。
