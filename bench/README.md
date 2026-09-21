# 子代理 A/B 基准用例

配套文档：[`../docs/pi-subagent.md`](../docs/pi-subagent.md) §8「执行协议 v3」。

用途：改**注入给内核子代理的执行协议**之前，先在这里复测，别凭感觉改提示词。

## 怎么跑

v3 下协议**不是一个前缀字符串，而是内核里的一个 agent**：客户端先
`PATCH /global/config` 注册 `ta-subagent`（prompt = 协议正文），再在发任务时带 `agent:"ta-subagent"`。
所以任务文本里只剩一句尾部输出契约。

`qoder-ta.mjs` 的 `fan` 会把一个文件按 `===` 行拆成多个任务并发跑：

```bash
# 默认 = agent 模式 + append 注入（正版提示词全文 + 末尾追加协议）
node qoder-ta.mjs fan bench/r4-b.txt --concurrency 3 --model chat-pro --timeout 600

# 激进模式：只发协议本体（system prompt 与正版差异最大，见 docs/pi-subagent.md §8.7）
TA_AGENT_MODE=replace node qoder-ta.mjs fan bench/r4-b.txt --concurrency 3

# 关掉 agent 机制，回退到「协议写进任务文本」的旧做法（用于 A/B 对照）
TA_AGENT="" node qoder-ta.mjs fan bench/r4-a.txt --concurrency 3

# 换协议做 A/B（不改代码）：文件里用一行 @@@ 分隔「协议正文」与「尾部契约」
TA_FAST_FILE="bench/fast-v2.txt" node qoder-ta.mjs fan bench/r4-b.txt --concurrency 3

# 完全不加协议（纯直通基线）
node qoder-ta.mjs run "..." --no-fast
```

为公平对比，两组用例的差别只有**目标目录**（`a/` 与 `b/`），其余逐字相同，可以两个进程同时跑。

## 用例覆盖的失败模式

| 文件 | 覆盖 |
|---|---|
| `v1-tasks.txt` / `v2-tasks.txt` | 写绝对路径（工作目录之外）、删除+写入、联网搜索（无产物） |
| `r2-*.txt` | 几十秒的长命令（诱出后台注册表模板）、`.md` 报告（诱出 `.html` 默认与 `report_final_files`）、覆盖+删除已有文件（诱出敏感确认提问） |
| `r3-*.txt` | 「内容恰好一行」的严格内容任务（诱出水印重做循环）、格式自选（看默认扩展名） |
| `r4-a.txt` / `r4-b.txt` | v3 的对照臂：绝对路径 JSON 写入、严格内容 `.txt`、联网调研 |
| `subagent-prompt.txt` | 协议正文的单一来源（三处副本必须与此逐字一致） |

## 复测时该看什么

1. **最终文本**是否符合 `RAW=<绝对路径>` 契约（≤6 行、无表格、无确认提问）；
2. **产物**是否真在任务指定路径、内容是否正确、有没有多出报告/README；
3. **轮次 / 工具调用数 / 墙钟**（从内核会话历史里数，这才是「快」的硬指标）；
4. 有没有出现 `todowrite` / 后台注册表模板 / `report_final_files` / 询问确认；
5. ★ **静默失败**：文本声称成功并给出 `RAW=`，但**根本没有对应的工具调用**、文件也不存在。
   这类失败最危险（编排方会当成成功），一定要对着会话历史数一遍工具调用。

## 2026-09-19 的复测结果（chat-pro）

### 第一轮 A/B：v1 vs v2（协议都写在任务文本里，三轮 6+6 会话）

| 指标 | v1 | v2 |
|---|---|---|
| 正确率 | 100%（6/6） | 100%（6/6） |
| 典型轮次 / 工具调用 | 2 轮 / 1 次 | 2 轮 / 1 次 |
| 联网调研任务 | 6 轮 / 5 工具 / 38 s | 5 轮 / 4 工具 / 31 s |
| 格式自选产物 | `.txt`（内含 3.5k 零宽水印字符） | `.md`（430 B AIGC 头） |
| todowrite / 后台注册表 / 确认提问 | 0 / 0 / 0 | 0 / 0 / 0 |

结论：两版都已贴在「2 轮 / 1 次工具调用」的地板上；v2 的增量在**覆盖面**（AIGC 水印、
禁止确认提问、格式默认、工具 deny 清单、`FAIL=` 契约），联网调研更瘦是附带收益。
**任务文本注入这条路已经到极限，所以才有了 v3。**

### 第二轮 A/B（`r4-*.txt`，3 任务 × 2 臂，同时跑）

臂 A = v2（把协议写进任务文本）；臂 B = v3（协议 = 系统提示词）。

| 指标 | A：协议写进任务文本 | B：协议 = 系统提示词 |
|---|---|---|
| 正确率 | 2/3 | 3/3 |
| 批墙钟 | 22 s | **16 s** |
| 失败形态 | **静默失败**：任务 #2 只跑 1 轮、**0 次工具调用**，却报 `RAW=…\note.txt` 说已创建，文件不存在 | 无 |

顺手还发现：`write` 工具**不会自动创建父目录**（报 `cannot find the path specified`），
会白烧一轮去补 powershell —— 这条已经写进协议正文（第 8 条）。

### 协议副本一致性核对

```bash
python - <<'PY'
import io
def f(p):
    s = io.open(p, encoding='utf-8').read()
    a = 'const SUBAGENT_PROMPT = '
    i = s.index(a) + len(a)
    return s[i:s.index(chr(96) + ';', i)]
print(f(r'D:\tele proxy\qoder-ta.mjs') == f(r'scripts/pi/teleagent-subagent.ts'))
PY
```

## 尚未覆盖

- 生图类任务（`ImageGen`，单张 40~60 s，成本高，本机单张跑过但未进基准）；
- 浏览器自动化（`playwright_browser_*`，MCP 启动本身就有几十秒开销，噪声太大）；
- 真正的常驻服务任务（只验证了「不要套注册表模板」，没有验证「该后台时能正确后台并回报 PID」）；
- App 重启后客户端能否正确**自动重注 agent**（逻辑按 sessionKey 变化判定，但未实测过重启）。
