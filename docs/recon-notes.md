# 逆向过程笔记

> 记录**怎么把这些算法挖出来的**，方便他人复现/在 App 升级后重新校准。
> 本机环境：无 x64dbg/WinDbg/objdump；仅用 Python(ctypes) + Node + Electron 自带工具。

## 1. 素材来源

| 素材 | 位置 |
|---|---|
| 前端 JS 源码 | `%LOCALAPPDATA%\Programs\TeleAgent\resources\app.asar`（解包可得） |
| 内核二进制 | `%USERPROFILE%\.local\share\TeleAgent\runtimes\super-agent-code\bin\TeleAgent.exe` |
| 网关抓包 | mitmproxy / Fiddler（`agent.teleai.com.cn`） |
| 登录令牌 | `…\users\<account>\app-auth\token.json`（Electron safeStorage v10 加密） |
| 本地 server 日志 | `…\users\<account>\log\super-agent-server-*.log`（Go，含每个请求 path/status） |
| 内核配置 | `…\app-auth\device-meta.json`（`deviceId`/`installId`） |

## 2. 登录令牌解密（Electron safeStorage v10）

```
Local State: os_crypt.encrypted_key  (base64)
   → 去掉前 5 字节 "DPAPI"
   → Windows DPAPI CryptUnprotectData  → 32 字节 AES key
token.json: encryptedToken (base64)
   → 前 3 字节版本 "v10" | 12 字节 nonce | 密文 | 16 字节 GCM tag
   → AES-256-GCM(key, nonce) 解密 → "<tenant>:<JWT>"
```

Python 版 DPAPI 调用（无第三方依赖）：
```python
import ctypes
from ctypes import wintypes
class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_char))]
def dpapi_unprotect(data: bytes) -> bytes:
    buf = ctypes.create_string_buffer(data, len(data))
    bin_ = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    bout = DATA_BLOB()
    ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(bin_), None, None, None, None, 0, ctypes.byref(bout))
    out = ctypes.string_at(bout.pbData, bout.cbData)
    ctypes.windll.kernel32.LocalFree(bout.pbData)
    return out
```

> ⚠️ PowerShell 的 `ProtectedData.Unprotect` 在本机实测**失败**，请用上面 ctypes 方案。

## 3. 二进制关键地址

镜像基址 `0x140000000`：

| 符号 | VA |
|---|---|
| `GatewaySigner.Sign`（云端两轮签名） | `0x140d6ff8c` |
| `hmacHex` | `0x140d72400` |
| `token_transform` | `0x140d72280` |
| `join` | `0x1401461c0` |
| `AKSKSigner.Sign`（仅 `/security/instruction/review` 用，反代不需要） | `0x140d70940` |
| 读 m2 的断点 | `TeleAgent.exe+d70225`（RAX=指针, RBX=长度） |

## 4. 内存取证方法（无调试器时）

用 Python `ctypes` + `VirtualQueryEx` / `ReadProcessMemory` 扫内核进程内存，再用正则匹配：

| 目标 | 正则 |
|---|---|
| 真实上行的完整请求 | `\r\nX-Superagent-Signature: ([0-9a-f]{64})\r\n` |
| m1 串 | `superagent-auth-v1/(Em9xR4:[^\x00/]{100,600})/([0-9a-f-]{36})/(\d{10})/([0-9a-f-]{36})` |
| m2 串 | `superagent-auth-v1\n([A-Z]+)\n(/[^\n]{3,120})\n(\d{10})\n([0-9a-f-]{36})\n([^\n]{1,20})\n([0-9a-f]{64})` |

**验证三连**（确认算法对）：
1. 用内存里的 `m1` 算出 `sig1`，与内存中同址的中间值比对；
2. 用内存里的 `body` 算 `bodyHash`（长度可对照，如 992153）；
3. 最终 `sig2` 与抓包里的 `X-Superagent-Signature` 逐字符比对。

## 5. 签名算法的确定过程

1. 抓包得到完整请求头 + body。
2. 解出 `X-Token`，观察到 JWT 第三段（43 字符 base64url）长度与"疑似密钥"吻合。
3. 动态搜索尝试：先猜单轮 `HMAC(SHA256)`，失败（`40104`）。
4. 改为**两轮嵌套**：`sig1 = HMAC(K, m1)`，`sig2 = HMAC(sig1, m2)`。
5. **关键突破**：发现 `m1` 用 `/` 拼接，而 `m2` 用 `\n` 拼接（两轮分隔符不同）。
6. 与内存中间值比对，三个中间值全部命中 → 算法确认。

## 6. 本地（App 内核）签名

- 签名代码在 `resources/scheduler/index.cjs` 的 `src/executor/local-auth.ts`（`signRequest`）。
- `X-SA-Signature = base64url(HMAC-SHA256(sessionKey, ["local-v1", METHOD, pathWithSearch, Date.now()ms, 12Bhex].join("\n")))`
- 配套头：`X-SA-Sign-Version` / `X-SA-Timestamp` / `X-SA-Nonce` / `X-SA-Signature`。
- `sessionKey`：主进程 `randomBytes(32)` → `base64url`（**43 字符**），每次启动都变；
  作为 `SUPER_AGENT_LOCAL_SESSION_KEY` 出现在 `node.exe`（scheduler / im-service）与 Electron 子进程的**环境块**里。
  → 取法：扫进程内存 `SUPER_AGENT_LOCAL_SESSION_KEY=...`（见 `scripts/get-session-key.py`，实测一次命中）。
- 备用鉴权：`Authorization: Basic base64(OPENCODE_SERVER_USERNAME:OPENCODE_SERVER_PASSWORD)`（同一份代码里）。
- `AUTH_STATE = AES-256-GCM(SHA256(sessionKey), {token, deviceId, installId})`。
- 内存里大量 43 字符 base64url 串是**这些本地签名**，别误当网关签名的密钥。

> 完整的进程/端口/接口/工具结构见 [`kernel-internals.md`](kernel-internals.md)。

## 7. 工具与环境坑

- 本机**没有** `strings`/`objdump`/`gdb` 等；可用 Python(capstone) 反汇编。
- Windows 侧命令走 `.ps1` 文件，别在 bash 里写含 `$_`/嵌套引号的 inline PowerShell。
- git-bash 里 `cmd.exe /c xxx` 会被路径转换；用 `//c` 或 PowerShell。
- TeleAgent 自带 Python：`%USERPROFILE%\.local\share\TeleAgent\runtimes\python\python.exe`（已装 capstone）。

## 8. App 升级后怎么重新校准

1. 抓一次真实请求，对比头字段（`X-App-Version` 等）。
2. 若签名不匹配，按第 4 节重新扫内存里的 `m1`/`m2`，确认拼接串结构是否变化。
3. 若 `installId` 变化（重装会变），从 `app-auth/device-meta.json` 或内存更新。
4. 校验顺序：先 `m1` → 再 `bodyHash` → 最后 `sig2`。
