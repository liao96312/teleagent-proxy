# 传输层保真度：让方案 A 的流量尽可能像 App 内核

> 目标：方案 A 绕过了内核、自己发请求，所以要在**协议层尽量复刻内核的 wire 格式**。
> 本文记录真机抓取的内核请求、我们踩到的差异、以及 Go 版实现如何对齐。
>
> 抓取方法：内核进程内存里仍留有 Go `http.Transport` 序列化后的原始 wire 字节，
> 用 `scripts/scan-gateway-req.py` 扫出来即可逐字比对。

## 1. 内核真实请求（从内核进程内存 dump，逐字）

```
POST /superCowork/sapi/api/v1/chat/completions HTTP/1.1
Host: agent.teleai.com.cn
User-Agent: super-agent/1.0
Content-Length: 97593
Accept: text/event-stream
Authorization: Bearer sk-qvp4m6h9g20uM6PgYP7E
Cache-Control: no-cache
Connection: keep-alive
Content-Type: application/json
X-App-Version: 2.5.0
X-Message-Id: msg_0935699b5001GxcCNiKlK7ncLK
X-Request-Id: 01a09356-99b0-7821-abd9-2ccc430de774
X-Route-Target: ops-gateway
X-Session-Id: ses_f6ca966ecffeNSbTlkba1AV2fd
X-Superagent-Device-Id: 74563cad11ca
X-Superagent-Install-Id: 05e154b7-77af-4b0c-bc3c-1986fc220189
X-Superagent-Nonce: b8be6c1a-bc6d-4958-9f57-59ce91157516
X-Superagent-Sign-Version: v1
X-Superagent-Signature: ec2dd527946c083b24e442c260186d5c14dfd3666feeecc79a707ab7a9c39d0e
X-Superagent-Timestamp: 1789178321
X-Teleai-Client-Type: desktop
X-Teleai-Root-Session-Id: ses_f6ca966ecffeNSbTlkba1AV2fd
X-Teleai-Run-Unit-Type: agent_loop
X-Teleai-Upstream-Request-Id: 6db0de0f-94bb-4613-aaf8-a9071fcf006a
X-Token: Em9xR4:<JWT>
Accept-Encoding: gzip

{"max_tokens":65536,"messages":[...],"tools":[{"type":"function","function":{"name":"read",...}}]}
```

**要点**
- 连接是 **HTTP/1.1**（不是 h2），显式带 `Connection: keep-alive`。
- 头顺序 = Go `net/http` 的写出顺序：`Host` → `User-Agent` → `Content-Length` → 其余**按字母序** → `Accept-Encoding` 由 Transport 追加在**最后**。
- `Accept-Encoding` 只有 `gzip`（Go 默认），**不是** `gzip, deflate, br`。
- `X-Request-Id` 是 **UUIDv7**（`01a09356-...`，第 7 字节 version nibble = 7）。
- `X-Message-Id` / `X-Session-Id` 形状：`<prefix>_` + **12 位十六进制** + **14 位 base62**；
  其中 hex 段随时间是**递减**的（近似取反的时间戳），例如 `ses_f6ca40887ffe...`。
  实测：`msg_*` 的 hex 低 12 位固定为 `001`，`ses_*` 固定为 `ffe`；高位部分 ≈ `~毫秒时间戳`。
  本仓库 shim 只对齐了**形状**（12hex+14base62），内部编码未逐位复刻（网关不校验，实测随机 ID 也返 200）。

## 1.1 实测：Go 版 vs 内核（逐字段对比）

用 `scripts/compare-wire.py <内核pid> <shim pid>` 从两边进程内存各 dump 一条真实请求对比，结果：

```
请求行一致: True
A 头顺序(25): Host, User-Agent, Content-Length, Accept, Authorization, Cache-Control, Connection,
  Content-Type, X-App-Version, X-Message-Id, X-Request-Id, X-Route-Target, X-Session-Id,
  X-Superagent-*, X-Teleai-*, X-Token, Accept-Encoding
B 头顺序(25): （完全相同）
【顺序完全一致】: True
只有 A(内核) 有: 无
只有 B(shim) 有: 无
--- 逐字段: 25/25 [OK]（静态值全等；动态值仅签名/时间戳/nonce/ID/长度不同）
```

动态字段格式也对齐：`X-Request-Id` 两边都是 **UUIDv7**（`01a0935f-...` 时间前缀相同）、
`msg_`/`ses_` 形状相同、`X-Token` 为**同一个 JWT**。
- **body 里带 `tools`**（OpenAI 风格函数定义，第一个是 `read`）→ 印证网关原生支持工具调用。
- 请求头里**没有** `X-Device-Os` / `X-Device-Os-Version`。

## 2. 修复前的差异（Node 版 shim）

| 头 | 内核 | 旧 Node shim | 影响 |
|---|---|---|---|
| `X-Device-Os` | 不发 | **发了** `Windows` | ❌ 直接暴露 |
| `X-Device-Os-Version` | 不发 | **发了** `10.0.26100` | ❌ 直接暴露 |
| `Cache-Control` | `no-cache` | 缺 | ❌ |
| `Connection` | `keep-alive` | 缺（Node 自己决定） | ❌ |
| `X-Teleai-Root-Session-Id` | 有 | 缺 | ❌ |
| `X-Teleai-Upstream-Request-Id` | 有 | 缺 | ❌ |
| `X-Request-Id` | UUIDv7 | UUIDv4 | ⚠️ |
| `X-Message-Id` / `X-Session-Id` | 12hex+14base62 | `<hex24>` | ⚠️ |
| `Accept-Encoding` | `gzip` | Node 默认值 | ⚠️ |
| 头顺序 | Go 字母序 | Node 插入序 | ⚠️ |

## 3. 两个版本

### 3.1 Node 版（`scripts/teleagent-shim.js`）
已按上表补齐/删除头，并实现了 UUIDv7 与内核形状的 ID。
**仍无法解决**：Node/undici 的 **TLS ClientHello 指纹**与 Go 不同，且头顺序由 undici 决定。

### 3.2 Go 版（`scripts/go/main.go` → `teleagent-shim.exe`）★ 推荐
用**与内核完全相同的 Go 版本（1.26.5）**编译，用默认 `net/http` + `crypto/tls`：
- TLS ClientHello（cipher suites / 扩展顺序 / X25519MLKEM768 / ALPN）与内核**同源**；
- 头顺序、`Accept-Encoding` 位置、`Content-Length` 处理由同一个 Go Transport 产生；
- 实测 dump 出来的 wire 与内核**逐字段逐顺序一致**（仅 `Content-Length` 与动态值不同）。

构建：
```
# 1) 装 Go（国内可用 go.dev 镜像；要与内核同版本，内核 = go1.26.5）
curl -L -o go.zip https://golang.google.cn/dl/go1.26.5.windows-amd64.zip
tar -xf go.zip -C %USERPROFILE%\.local\share\go-toolchain
# 2) 编译与启动
scripts\go\build.cmd          # 输出 scripts\teleagent-shim.exe
scripts\start-shim-go.cmd     # 启动
```

## 4. 仍然无法伪装的部分

| 维度 | 说明 |
|---|---|
| **行为模式** | 内核还会打 `/app`、`/global/session/status`、心跳、其他 sapi 接口；一个账号“只发 chat/completions”本身是异常信号。<br>**缓解**：让 TeleAgent 常开，让真实流量打底，shim 只做增量。 |
| **body 内容** | 内核发的是它自己的 agent 会话（巨型 system prompt + 全套 tools）；我们发的是调用方的消息。 |
| **出口 IP / 设备** | 同机同 IP 天然一致；deviceId/installId 也要保持一致。 |
| 频率 | 人类节奏；不要并发刷。 |

## 5. 结论

- **协议层（头 + 签名 + 传输）**：Go 版已做到与内核一致。
- **行为层**：单靠 shim 做不到，必须让 App 一起跑。
- **根因提醒**：真正导致封号的是**签名爆破**（40105→40109），不是流量指纹。别再做任何形式的试探性请求。
