# 输出上限改造 65,536 → 131,072：asar 三层防篡改与字节码定位

> 目标：把 App 里写死的 `chat-pro` / `chat-flash` 最大输出从 **65,536** 抬到 **131,072**。
> 结果：改完可用（已实测内核注入的是 `131072`），但过程中撞上了应用**三层防篡改**，逐层突破的细节记在这里。
> 环境：TeleAgent 2.5.2 / Electron 43.1.0 / 内置 node 24.18.0 / bytenode 1.6.0 / Windows 11。

⚠️ **风险提示**：改动会让厂商签名失效，属于「改客户端」行为，与 [`ban-risk.md`](ban-risk.md) 里讨论的封号风险属同一类（甚至更明显）——平台侧若做完整性上报会看出异常。**只在自己的机器、自己的账号上做，风险自担。**
⚠️ **副作用**：应用自动更新会替换掉 `app.asar`；若 exe 被换回厂商签名版而 asar 还是改过的，**L2 会直接导致启动失败**。所以更新前务必先回滚。

---

## 0. TL;DR

| # | 改什么 | 位置 | 变动 |
|---|---|---|---|
| 1 | 字节码里的模型限额 | `resources\app.asar` → `dist-electron\main.jsc` 内偏移 `4079767`、`4079897` | `0x02` → `0x04`（Smi(65536)→Smi(131072)） |
| 2 | 该文件的完整性记录 | asar 头部里 `main.jsc` 的 `integrity.hash` / `integrity.blocks[0]` | 等长 64 位 hex 替换 |
| 3 | exe 内嵌的「asar 头部 sha256」 | `TeleAgent.exe` 偏移 `224166255`（64 字节 ASCII） | 等长替换 |
| 4 | exe 的签名自校验 | 证书主题含厂商名字符串的**自签证书重签** | `Status: UnknownError` → 命中逻辑里的「放行」分支 |

**净改动：asar 内容 2 字节 + 头部 128 字节 + exe 64 字节 + 一次重签名，全部等长** → 文件大小与所有偏移不变。

---

## 1. 真正跑的是 bytenode 字节码，不是那堆 JS

`package.json` 的 `main` 是 `dist-electron/main-loader.cjs`：

```js
"use strict";
require("bytenode");
require("./main.jsc");        // ← 7.2MB V8 字节码，生产入口
```

`dist-electron/` 下那 14 个 4MB 的 `main-runtime-*.js` 和 14 个 95KB 的 `main-*.js`（只有一个动态 `import()` 互相引用）**没有任何入口引用它们**，是构建残留/死代码。
**决定性证据**：应用日志里的所有堆栈都指向 bytecode：

```
at yzt (D:\...\resources\app.asar\dist-electron\main.jsc:1:1185173)
```

> 所以：改 JS 源码没用，得改 `.jsc`。这一点和 [`kernel-internals.md`](kernel-internals.md) 里「内核自带工具清单从 main-runtime 里读」的结论并不冲突——**读源码用 JS 那份（可读），改行为要改字节码那份（在跑）**。

模型目录（三个模型的限额）就在字节码里，与 JS 源码一一对应：

```js
"chat-lite":  { name:"轻量", limit:{ context:1e5, output:16384 } }
"chat-pro":   { name:"旗舰", limit:{ context:4e5, output:65536 } }
"chat-flash": { name:"极速", limit:{ context:4e5, output:65536 } }
```

## 2. 在字节码里定位那个 65536

V8 code cache 里的数字常量是 **Smi**：`Smi(v) = v << 1`，在 32 位 tagged slot 里是 4 字节小端。

| 原值 | Smi | 小端字节 |
|---|---|---|
| `output: 65536` | `0x00020000` | `00 00 02 00` |
| `output: 16384` | `0x00008000` | `00 80 00 00` |
| `context: 4e5` | `0x000C3500` | `00 35 0c 00` |

单值搜索没用（`00 00 02 00` 全文件 16,874 处命中）。**用结构特征串**：

```
60 00 35 0c 00 05 20 c1 8b 60 00 00 02 00
│  └Smi(400000) └─固定串──┘ │  └Smi(65536)
标签                          标签
```

即 `60 <Smi(context)> 05 20 c1 8b 60 <Smi(output)>`。全文件**恰好命中 2 次**（chat-pro / chat-flash），
且旁边就是 ASCII 字符串 `chat-lite` / `chat-pro` / `chat-flash`、`tool_stream` —— 结构自证。

**改法**：`output` 的 Smi 中间那个字节 `0x02` → `0x04`（`0x00020000` → `0x00040000` = Smi(131072)）。

## 3. 在 asar 里定位这个 jsc：别信头部，用内容锚点

这份 asar 的头布局**不兼容 `@electron/asar` 的标准读取器**（前 8 字节不是它期望的结构，直接解析会报 JSON 错）。
更稳的办法是**内容锚点**：

1. 从解包出来的 `main.jsc` 取开头 64 字节作为特征串；
2. 分块扫描整个 `.asar`（本包只命中 **1 处**）；
3. 再用 +1MB / +4MB / +7MB 三个远端偏移各比 64 字节，确认是**常量偏移映射**；
4. 之后 `asar 绝对偏移 = 锚点 + jsc 内偏移`。

实测：asar 头部 JSON 在 `[16, 8441300)`（长度 8441284），文件数据紧随其后；`main.jsc` 数据起点 = **409211591**。

> 🐛 **踩坑**：分块扫描时必须把搜索范围限定在本次真正读到的字节数（`buf.subarray(0, n)`）。
> 第一版漏了这一步，`indexOf` 搜到了上一轮遗留的缓冲区内容，报出「main.jsc 有 50 份副本」的假象，
> 而且那些假命中还整齐地相差 64MB（= 分块大小）——这就是滑窗 bug 的典型指纹。

---

## 4. 三层防篡改，逐层突破

| 层 | 实现位置 | 校验对象 | 现象 | 突破 |
|---|---|---|---|---|
| **L1** | Electron asar fs wrapper（JS） | asar 头部里**逐文件**的 `integrity:{hash,blockSize,blocks[]}` vs 文件真实内容 | `ASAR Integrity Violation: got a hash mismatch (…)`，启动即死 | 重算并**等长替换**头部里的 `hash` / `blocks[0]` |
| **L2** | Electron C++ `asar_util.cc` | `sha256(asar 头部)` vs **exe 内嵌 PE 资源**里的值 | `FATAL: Integrity check failed for asar archive (… vs …)` | 把新头部 sha256 等长写回 exe |
| **L3** | 应用自己的 JS（`VerifySignature`） | PowerShell `Get-AuthenticodeSignature` 校验**自己的 exe** | `Signature self-check FAILED — tampering detected` → `Main window closed` | 自签证书重签（见 §4.3） |

### 4.1 L1：逐文件完整性

头部里每个文件都有：

```json
"main.jsc": { "size": 7234744, "offset": "400770291",
  "integrity": { "algorithm": "SHA256", "hash": "<文件内容 sha256>",
                 "blockSize": 4194304, "blocks": ["<块0>", "<块1>"] } }
```

**关键技巧：哈希都是 64 位十六进制 ASCII → 一律等长替换**，头部长度、文件大小、所有 `offset` 都不变。
本次两处补丁都落在 `block0`（偏移 < 4,194,304），所以只改了 `hash` 与 `blocks[0]`，`blocks[1]` 原值不动。
自检方式：断言 `integrity.hash == sha256(改后的文件内容)`。

### 4.2 L2：校验的是「头部」而不是整个文件

exe 里的 PE 资源（`ELECTRONASAR`）紧跟一段 ASCII JSON：

```json
[{"file":"resources\\app.asar","alg":"SHA256","value":"<64 hex>"}]
```

**它到底哈希哪一段？实测反推**（不要猜）：枚举候选区间算 sha256 与期望值比对——

| 候选 | 结果 |
|---|---|
| 整个文件 | ✗ |
| `[0,16+H)` / `[8,8+H)` / `[4,4+H)` | ✗ |
| **`[16, 8441300)`（纯头部 JSON，长度 8441284）** | ✅ **一次命中** |

于是机制确认：L2 = `sha256(asar头部JSON)`。改完头部把新值等长写回 exe 即可。
（顺带解释了为什么第一轮误判「内嵌哈希和文件对不上」——因为它根本不含数据区。）

### 4.3 L3：自校验里的「非 Valid 即放行」分支

反编译 main bundle 的 Windows 分支（简化）：

```
status == HashMismatch             -> 判篡改，退出
status == NotSigned 或 无签名证书   -> 判篡改，退出
Subject 是否包含 "<厂商名字符串>"?
    ├─ 是 且 status == Valid    -> 通过
    └─ 是 且 status 为其它       -> 只打 error「treating as environmental error and allowing」，**放行** ✅
Subject 不含                     -> 判篡改，退出
```

`Get-AuthenticodeSignature` 对「签名链不受信任」的文件返回的是 **`UnknownError`**（既不是 Valid，也不是 HashMismatch/NotSigned）。于是：

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=China Telecom Artificial Intelligence Technology(Beijing)Co. Ltd" `
  -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(5)
Set-AuthenticodeSignature -FilePath '<INSTALL>\TeleAgent.exe' -Certificate $cert -HashAlgorithm SHA256
```

- **不需要安装任何受信任根证书**：链不受信任（`UnknownError`）反而正好落进「放行」分支。
- 证书只进 `Cert:\CurrentUser\My`；但**别随手删**——删了签名者主题就解析不到，L3 会判定篡改导致启动失败（要删就先回滚 exe）。

实测日志：

```
[error] [VerifySignature] Authenticode status=UnknownError but signer is ours — treating as environmental error and allowing
[info]  [VerifySignature] Signature self-check passed
```

> 🔍 **设计观察**：这是「环境异常时选择继续启动」的容错设计（避免用户环境问题导致开不了机），
> 但它把「签名状态非 Valid」和「签名者是不是自己」解耦了——只要主题字符串能被伪装就等于自校验可绕过。
> 安全关键的自校验不应该把「链验证失败」降级为放行。另外 `$Ze` 是编译期常量 `false`，这条自校验**没有**配置/环境变量开关。

### 4.4 顺序

正向：改 asar 内容 → 改头部（L1）→ 改 exe（L2）→ 过签名自校验（L3）。
**回滚反着来**：先把 exe 换回原始签名版，再还原 asar。

---

## 5. 怎么验收「真的生效了」

改完文件 ≠ 生效。三条互相独立的通道（都不需要管理员）：

### 5.1 从内核进程 PEB 读它自己的环境变量

App 用环境变量把配置注入内核（`OPENCODE_CONFIG_CONTENT` / `OPENCODE_MODELS_EXTRA_CONTENT` / `SUPER_AGENT_*`），
而工具/子进程侧被 scrub（见 [`kernel-internals.md`](kernel-internals.md)），所以直接问工具进程看不到。读**内核进程自己的** PEB 才有：

```
OpenProcess(QUERY_INFORMATION|VM_READ)
 → NtQueryInformationProcess(ProcessBasicInformation) → PebBaseAddress
 → PEB+0x20 = ProcessParameters ；ProcessParameters+0x80 = Environment 指针
 → ReadProcessMemory 读 UTF-16 环境块，按 \0 切分
```

（同用户、非保护进程即可，无需管理员；x64 偏移，Win10/11 通用。）

### 5.2 扫进程内存找「注入后的配置 JSON」（本次最省事的验收）

```
VirtualQueryEx 枚举可读已提交区域 → ReadProcessMemory 分块读（4MB，重叠 64B）
 → Latin-1 解码 → String.IndexOf 匹配
```

内核进程内存里直接搜注入的配置片段（约 120MB，扫描 < 1 秒）：

| 模式 | 改前 | 改后 |
|---|---|---|
| `"limit":{"context":400000,"output":131072}` | 0 | **4** |
| `"limit":{"context":400000,"output":65536}` | 6 | **0** |
| `"limit":{"context":100000,"output":16384}`（未改的 chat-lite） | 1 | 4 |

「新值出现 + 旧值归零 + 无关项不变」同时成立才算生效。

### 5.3 持久化数据（`teleagent.db`）里的 usage

```json
"tokens":{"total":106520,"input":344,"output":65536,…},"finish":"length"
```

它既是改动前的截断证据（精确停在 65536），也是「改动后**端到端**是否真放行」的唯一可靠判据。

> ⚠️ **本次仍未验证**：只证明了**客户端→内核**侧上限已到 131072。
> 网关（`agent.teleai.com.cn` ops-gateway）**是否放行 >65,536 的输出**尚未验证——需要真跑一次 >65536 tokens 的长输出
> （约 5 万+ 汉字，10~40 分钟、消耗真实额度），再看 DB 里的 `tokens.output` 与 `finish`：
> `output` 超 65,536 → 完全打通；仍停在 65,536 且 `finish:"length"` → 网关侧另有上限，客户端改了也没用。

---

## 6. 别名 vs 真实模型名：客户端查不到

顺手查了 `chat-pro` / `chat-flash` 背后到底是哪个模型，**结论是客户端无法得知**：

| 线索 | 结果 |
|---|---|
| 客户端目录 | 只有别名 + 展示名 + 限额（`轻量`/`旗舰`/`极速`），另有 `chat-nano`（用于生成会话标题）；**没有上游模型字段** |
| 请求体 | 永远只发别名：`{"providerID":"NewApi","modelID":"chat-pro"}` |
| **网关响应** | SSE 分块把别名**原样回显**：`"object":"chat.completion.chunk","id":"a599bed9…","model":"chat-lite"`，且 `id` 对所有请求是**同一个常量** → 前面是转发/路由层，真名在后端 |
| 全量搜索 | app.asar、内核二进制（47MB Go）、`teleagent.db` 里都**没有**「别名→上游模型」映射表（内核里出现的 `chat-pro` 全是历史消息记录） |

所以 `chat-pro` / `chat-flash` 是 **ops-gateway 的服务端别名**（`NewApi` provider + `X-Route-Target: ops-gateway`），路由到哪个模型只有服务端知道。
想查明真名只有三条路：① 问服务端/看厂商文档；② 用应用自带的
`~\.local\share\TeleAgent\internal-debug.yaml` 里的 `llmBaseUrl` 开关把请求指到**本地抓包代理**，看响应头里是否带上游模型标识（零二进制改动的官方调试口）；③ 行为指纹——只能猜，不能当结论。

---

## 7. 方法论（下次遇到同类目标可直接套）

1. **先确认运行时真正加载的是哪个文件**，再决定改谁（源码 ≠ 生效的代码）。
2. **先建立可观测的验收通道，再动手**：这次先确认「内存扫描能稳定读出注入配置」才开改，否则就是盲改。
3. **能等长就等长**：改哈希、改数字优先选等长表示（`0x02→0x04`、64 位 hex→64 位 hex），文件大小/偏移不变，能一次性躲开一堆「结构变了」的连带问题。
4. **实测反推校验算法**：与其猜「哈希覆盖哪一段」，不如枚举候选区间算 sha256 与期望值比对，一次命中即机制证明。
5. **全量备份 + 字节级断言**：改动前后 `cmp -l` 确认「只差预期的那几个字节」，写入后立即读回校验。
6. **用结构特征定位，而不是单值搜索**（否则几万处命中）。
7. **回滚路径要精确**：优先保留原始二进制整份副本（含原始签名），比「按字节改回去」可靠。
8. **记住更新会覆盖**：应用自更新会替换 asar/exe，改造失效甚至导致启动失败。

### 踩坑时间线

| # | 现象 | 定位 | 修复 |
|---|---|---|---|
| 1 | 改 2 字节后启动无反应、无日志 | 前台运行捕获 `ASAR Integrity Violation`（L1） | 更新头部 `integrity.hash` / `blocks[0]` |
| 2 | 再启动报 `Integrity check failed for asar archive`（L2） | 枚举区间反推出 L2 校验的是**头部 JSON** | 更新 exe 内嵌期望值 |
| 3 | 仍退出，日志 `Signature self-check FAILED (HashMismatch)`（L3） | 反编译自校验逻辑，发现 `UnknownError` 放行分支 | 自签证书重签 exe |
| 4 | 扫描脚本报「main.jsc 有 50 份副本」 | 分块扫描未限定 `subarray(0, n)` | 限定搜索范围，确认只有 1 份 |

---

## 8. 附：关键脚本骨架

**① 等长替换的完整性同步（L1）**

```js
// 读取头部 JSON → 找 main.jsc 的 integrity → 用新算的 sha256 等长覆盖
const hdr = read(ASAR, HEADER_START, HEADER_LEN);
const integ = JSON.parse(hdr).files['dist-electron'].files['main.jsc'].integrity;
const content = read(ASAR, MAIN_JSC_ABS, MAIN_JSC_SIZE);
assert(integ.hash.length === 64);
writeAt(ASAR, offsetOfHeader(integ.hash), sha256hex(content));            // 64 hex → 64 hex
writeAt(ASAR, offsetOfHeader(integ.blocks[0]), sha256hex(content.subarray(0, 4194304)));
```

**② 同步 exe 内嵌的头部哈希（L2）**

```js
const cur = headerSha256(ASAR);                       // sha256(asar[16, 8441300))
const exeVal = read(exe, 224166255, 64).toString('latin1');
assert(exeVal === OLD_VALUE);                         // 防误写
write(exe, 224166255, Buffer.from(cur, 'latin1'));    // 等长 64 字节
```

**③ 进程内存特征串扫描（验收）**

```powershell
$h = [P]::OpenProcess(0x0410, $false, $pid)
while ($true) {                                        # VirtualQueryEx 遍历区域
  $r = [P]::VirtualQueryEx($h, $addr, [ref]$mbi, $sz); if ($r -eq 0) { break }
  if (readable) { for each 4MB chunk:                  # 只读已提交、非只读、非 guard
      ReadProcessMemory -> Latin1 -> IndexOf(pattern)  # 命中即打印地址与上下文
  }
  $addr = $mbi.Base + $mbi.RegionSize
}
```

**④ 回滚（推荐整份覆盖）**

```powershell
Copy-Item '<INSTALL>\resources\app.asar.bak' '<INSTALL>\resources\app.asar' -Force
Copy-Item '<BACKUP>\TeleAgent.exe.orig'       '<INSTALL>\TeleAgent.exe'      -Force   # 原始签名版
```
