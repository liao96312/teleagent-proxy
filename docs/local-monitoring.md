# TeleAgent 在本机采集/监控了什么

> 依据：App 导出的日志包（`main-*.log` / `js-*.log` / 内核日志）、内核二进制符号、实际状态文件。
> 注意：导出工具会**主动打码**（`macAddress: '[REDACTED]'`、路径 `<redacted-user>`），
> 说明原始采集里这些字段是有值的。

## 1. 设备指纹（每次启动采集）

```
[SysInfo] basicSystemInfo {
  os: 'win32', osType: 'Windows', osVersion: '10.0.26100', arch: 'x64',
  appVersion: '2.5.0', electron: '43.1.0', chrome: '150.0.7871.47', node: '24.18.0',
  macAddress: '[REDACTED]'            ← MAC 地址（导出时才打码）
}

[SysInfo] osInfo {
  platform: 'Windows',
  distro: 'Microsoft Windows 11 企业版 LTSC',
  release: '10.0.26100', codename: '24H2', kernel: '10.0.26100', arch: 'x64',
  hostname: 'DESKTOP-UP1F0V9',        ← 主机名
  fqdn:     'DESKTOP-UP1F0V9',
  codepage: '936',
  serial:   '00484-31114-81358-AAOEM', ← Windows 安装序列号
  build: '26100', servicepack: '0.0',
  uefi: true,
  hypervisor: false,                   ← 是否虚拟机
  remoteSession: false                 ← 是否远程桌面会话
}
```

`hypervisor` / `remoteSession` 是典型的**反作弊 / 反分析**字段（识别 VM 和 RDP）。

本机实际落盘：
```
app-auth/device-meta.json   {"deviceId":"74563cad11ca","installId":"05e154b7-..."}
app-auth/install-receipt.json {"generation":"fresh:{329792CB-4893-431B-A8E1-6E39920FD2CA}"}
```

## 2. 反调试 / 完整性

| 日志 | 含义 |
|---|---|
| `[AntiDebug] Anti-debug protection enabled (Inspector monitoring every 5s)` | **每 5 秒检测调试器** |
| `[VerifySignature] Signature self-check passed` | 自身签名自检 |
| `[InstallGeneration] Install generation changed, forcing re-login` | 安装代际 GUID 变化 → 强制重登（换安装/迁移会被识别） |

## 3. 网络环境

```
[network] Resolved proxy settings { status: 'disabled', source: 'windows-registry' }
```
读 **Windows 注册表**里的代理设置。

## 4. 内容审核（把内容送去审）

| 场景 `scene` | 类型 | 说明 |
|---|---|---|
| `chat_user_message` | `checkType=text` / `contentType=userQuery` | **用户输入**要审 |
| `chat_assistant_output` | `checkType=text` / `contentType=modelOutput` | **模型输出**也要审 |

**图片同样会审**：
```
[contentModeration] Image read failed, allowing by policy:
  {"sourceKind":"localPath",
   "path":"C:\\...\\image-20260912024436-01-74fae867.jpg",
   "sessionId":"ses_...","messageId":"msg_..."}
```
→ `sourceKind: localPath` 表示它会**读取本机图片文件**再送审。

实际拦截样例：
```
[contentModeration] Moderation rejected raw content:
  {"checkType":"text","contentType":"userQuery",
   "apiMessage":"谩骂内容,谩骂其他,,政治违规,核心领导人,",
   "content":"伍贱奴，这位领导是谁"}
[contentModeration] User message sensitive content blocked: {...}
```
→ 政治敏感/谩骂类内容会被直接拦下。

## 5. 工具 / 命令审查（每条危险命令上报平台）

```
[tool_instruction_review] request, toolID=powershell,
  payload={deviceId, "ses:msg:callID", time, mode, sessionID, messageID, toolCallID,
           tool, input={完整命令}}
```
统计：`是否通过【powershell】执行【…】` × 123，其中「递归删除文件」45、「彻底删除文件」18。
`action=allow` 才继续执行。

## 6. 用量 / 会话

| 日志 | 含义 |
|---|---|
| `[tokenUsage] Usage upload policy changed: {"from":"uninitialized","to":"metering"}` | **token 用量上报**（这就是「消耗明细」的数据源） |
| `reason: send_active_session_limit_check` | 活跃会话数检查 |
| `reason: load_token_usage` | 拉取用量 |

## 7. 封禁通知（历史，含自动解封时间）

```
尊敬的用户，您好：
系统监测到您疑似多次尝试违规操作，现已暂停您的使用权限。
如对处理结果有异议，欢迎联系客服进行核实解决。
预计自动解封时间：2026-08-28 09:54:36。
```

要点：
- 触发词是「**多次尝试**违规操作」——**模式/次数**导向，不是单次内容。
- **有时间限制**，会给出自动解封时间。

## 8. 内核侧的系统能力（Win32 API 导入）

`GetForegroundWindow`（前台窗口）、`EnumProcesses`（进程枚举）、`GetClassNameW`、
`ShellExecuteW`、`net.Interfaces`（网卡/MAC）、`os.Hostname`、`VolumeSerialNumber`（磁盘卷序列号）。

这些是内核工具（自动化/进程管理）的底层能力，**不等于**都会上报；但意味着内核进程本身能拿到这些。

## 9. 汇总表

| 类别 | 采集内容 | 是否出本机 |
|---|---|---|
| 设备指纹 | OS/版本/arch、hostname、**MAC**、**Windows 序列号**、UEFI、**是否VM**、**是否RDP** | ✅ 随请求头/登录上报 |
| 安装标识 | deviceId、installId、install generation GUID | ✅ |
| 反调试 | 每 5s 检测调试器、签名自检 | ❌（本地） |
| 网络 | 系统代理设置（读注册表） | 视用途 |
| 内容审核 | 用户输入、模型输出、**本地图片文件内容** | ✅ 送审 |
| 工具审查 | 每条危险命令的**完整命令行** | ✅ 上报 |
| 用量 | token 计量 | ✅ 上报 |
| 进程/窗口/磁盘序列号 | 内核有 API 能力 | 未观测到主动上报 |


补充：`[SysInfo] system` —— **主板/整机信息**
```
[SysInfo] system {
  manufacturer: 'Gigabyte Technology Co., Ltd.',
  model:        'H610M H V2 DDR4',
  version:      '-CF',
  serial:       'Default string',
  uuid:         '03560274-043c-05ad-1106-ca0700080009',   ← 主板 UUID
  sku:          'Default string',
  virtual:      false
}
```
四项 `[SysInfo]`：`basicSystemInfo`(含 MAC) / `osInfo`(含 Windows 序列号) /
`system`(含主板厂商+型号+UUID) / `systemSupport`。

## 11. 指纹可伪造性（实测）

**实测结论：`deviceId` / `installId` 不是硬件派生，是 `app-auth/device-meta.json` 里的存盘值。**

```
改 file -> {"deviceId":"aabbccddeeff","installId":"11111111-..."}
重启 App -> 文件未被改回；扫内核内存：aabbccddeeff ×4，旧值 74563cad11ca ×0
```

工具：`scripts/randomize-fingerprint.py`（自动备份，支持 `--show/--restore/--rotate-generation`）。

| 项 | 可伪造 | 是否上传 |
|---|---|---|
| deviceId / installId | ✅ 随便编 | ✅ 每个请求头 |
| 主板 UUID / MAC / Windows 序列号 / hostname | ❌ | 未观测到上传；启动采集后不留内存（扫 5 个进程 0 命中） |
| install generation | ✅ 可轮换 | ✅，但**会强制重新登录** |

## 12. 对反代的直接含义

1. **deviceId / installId / MAC / Windows 序列号** 都进指纹 → 多账号共用一台机器时，
   平台看到的设备指纹是**同一个**，这是「多账号」关联的最直接线索。
2. **内容审核**：从我们的 shim 发出去的内容**不经过审核**（审核在 App/内核侧做）——
   这本身也是一种差异（正常流量应该「有审核记录」）。
3. **工具审查**：内核每次工具调用都有审查记录，我们直连没有 → 见 [`ban-analysis-2.md`](ban-analysis-2.md)。
4. **用量上报**：App 会上报 metering；我们直连的调用由平台侧记账，
   所以「模型消耗=0 的图片生成」在账面上非常刺眼。
