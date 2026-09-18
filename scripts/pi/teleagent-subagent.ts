/**
 * TeleAgent Subagent — 把执行任务委派给 TeleAgent 内核 agent（方案 B）自治完成。
 *
 * 定位：pi 只做规划/编排，具体干活交给内核自带的 agent loop（powershell / 读写文件 /
 * 联网搜索 / 生图 / MCP），内核用它自己的工具，因此不受"方案 B 不接受自定义 tools"限制。
 *
 * 链路：pi(本扩展) --本地签名 X-SA-*--> 内核 127.0.0.1:4397 --App 进程--> 云网关
 *
 * 硬前提：TeleAgent 必须正在运行且已登录；sessionKey 每次启动会变（自动重取）。
 *
 * 环境变量：
 *   TA_KERNEL_URL         内核地址，默认 http://127.0.0.1:4397
 *   TA_PROVIDER_ID        默认 NewApi
 *   TA_SESSION_KEY        直接给 sessionKey
 *   TA_SESSION_KEY_FILE   session.key 路径
 *   TA_GET_SESSION_KEY    get-session-key.py 路径（用于自动/失效重取）
 *   TA_REPO               teleagent-proxy 仓库根，默认 D:\tele proxy\teleagent-proxy
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequestFn } from "node:http";
import { request as httpsRequestFn } from "node:https";
import { createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KERNEL = (process.env.TA_KERNEL_URL || "http://127.0.0.1:4397").replace(/\/+$/, "");
const PROVIDER = process.env.TA_PROVIDER_ID || "NewApi";
// 内核权限模式：yolo = 全自动执行（不弹权限确认窗，无人值守必需）
// 对应 App 的「执行模式 → 全自动执行」，会在消息体里带 { mode: "yolo" }
const KERNEL_MODE = process.env.TA_PERMISSION_MODE ?? "yolo";
const REPO = process.env.TA_REPO || "D:\\tele proxy\\teleagent-proxy";
// 内核的 /session/:id/message 是同步阻塞接口，要等整个 agent 循环跑完才返回，
// 生图/多步任务经常 5~20 分钟，所以默认给足时间（上限见 execute 里的 clamp）。
const DEFAULT_TIMEOUT_SEC = 900;
const MAX_RESULT_CHARS = 30000;
// 孤儿判定：内核里超过这个时长没动静、且不属于本进程在等的会话，视为遗留孤儿
const ORPHAN_AGE_MS = Number(process.env.TA_ORPHAN_AGE_MS ?? 10 * 60 * 1000);

const MODEL_IDS = ["chat-pro", "chat-lite", "chat-flash"] as const;
type ModelId = (typeof MODEL_IDS)[number];

const KEY_CANDIDATES = [
	process.env.TA_SESSION_KEY_FILE,
	join(homedir(), ".pi", "agent", "teleagent-session.key"),
	join(REPO, "scripts", "session.key"),
].filter((p): p is string => !!p);

const REFRESH_SCRIPT_CANDIDATES = [
	process.env.TA_GET_SESSION_KEY,
	join(REPO, "scripts", "get-session-key.py"),
].filter((p): p is string => !!p);

const PYTHON_CANDIDATES = [
	join(homedir(), ".local", "share", "TeleAgent", "runtimes", "python", "python.exe"),
	"python",
];

// ---------------------------------------------------------------- sessionKey

let cachedKey: string | undefined;

function isUsableKey(k: string | undefined): k is string {
	return !!k && /^[A-Za-z0-9_-]{20,120}$/.test(k.trim());
}

function readKeyFile(): string | undefined {
	for (const p of KEY_CANDIDATES) {
		try {
			const v = readFileSync(p, "utf8").trim();
			if (isUsableKey(v)) return v;
		} catch {
			// ignore
		}
	}
	return undefined;
}

/** 跑 get-session-key.py 扫内存重取（异步，避免阻塞 pi）；脚本会把 key 写在它自己旁边。 */
async function refreshKeyViaScript(): Promise<string | undefined> {
	const script = REFRESH_SCRIPT_CANDIDATES.find((p) => existsSync(p));
	if (!script) return undefined;
	const py = PYTHON_CANDIDATES.find((p) => p === "python" || existsSync(p)) ?? "python";
	try {
		await execFileAsync(py, [script], { timeout: 300_000, windowsHide: true });
	} catch {
		// 忽略：下面统一回读文件
	}
	const direct = readKeyFile();
	if (direct) return direct;
	// 脚本写在脚本同目录的 session.key
	try {
		const sibling = join(script, "..", "session.key");
		const v = readFileSync(sibling, "utf8").trim();
		if (isUsableKey(v)) return v;
	} catch {
		// ignore
	}
	return undefined;
}

let keyRefreshing: Promise<string | undefined> | null = null;

async function getKey(force = false): Promise<string | undefined> {
	if (!force && isUsableKey(process.env.TA_SESSION_KEY)) return process.env.TA_SESSION_KEY;
	if (!force && cachedKey) return cachedKey;
	const fromEnv = process.env.TA_SESSION_KEY?.trim();
	if (isUsableKey(fromEnv)) {
		cachedKey = fromEnv;
		return cachedKey;
	}
	let k = readKeyFile();
	if (!k || force) {
		// 避免并发重复扫内存
		keyRefreshing ??= refreshKeyViaScript();
		const refreshed = await keyRefreshing;
		keyRefreshing = null;
		k = refreshed ?? k;
	}
	if (isUsableKey(k)) {
		cachedKey = k;
		return cachedKey;
	}
	return undefined;
}

// ---------------------------------------------------------------- 本地签名

function signHeaders(method: string, pathWithQuery: string, key: string): Record<string, string> {
	const ts = String(Date.now()); // 毫秒
	const nonce = randomBytes(12).toString("hex");
	const payload = ["local-v1", method.toUpperCase(), pathWithQuery, ts, nonce].join("\n");
	const sig = createHmac("sha256", key).update(payload).digest("base64url");
	return {
		"X-SA-Sign-Version": "local-v1",
		"X-SA-Timestamp": ts,
		"X-SA-Nonce": nonce,
		"X-SA-Signature": sig,
	};
}

interface KernelResult {
	status: number;
	json: any;
	text: string;
}

/**
 * 用 node:http 发请求，而不是 Node 内置的 fetch(undici)。
 *
 * 原因（真实踩坑）：内核的 `POST /session/:id/message` 是「同步阻塞」接口，服务端要等整个
 * agent 循环跑完才吐出哪怕一个字节的响应头。而 undici 的 `fetch` 默认 `headersTimeout = 300s`，
 * 于是任何超过 5 分钟的任务都会抛 `fetch failed` (HeadersTimeoutError)——但内核并没有停，
 * 它还在后台继续跑，跑完照样把文件写下去。结果就是：
 *   1) pi 侧看到的是「失败」，其实任务在跑/已经成功；
 *   2) 一旦重复提交同一个任务，先前的「孤儿任务」会晚一步把文件又覆盖一遍，把好结果冲掉。
 *
 * node:http 的客户端没有默认的 header/socket 空闲超时，只受我们显式设置的「总时限」约束，
 * 所以长任务不会被莫名其妙掐断。
 */
function rawRequest(
	url: string,
	method: string,
	headers: Record<string, string>,
	body: string | undefined,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const isHttps = u.protocol === "https:";
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const onAbort = () => {
			req.destroy(new Error("调用方已取消"));
		};
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const req = (isHttps ? httpsRequestFn : httpRequestFn)(
			{
				protocol: u.protocol,
				hostname: u.hostname,
				port: u.port || (isHttps ? 443 : 80),
				path: u.pathname + u.search,
				method,
				headers,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
				});
				res.on("error", (e) => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(e);
				});
			},
		);
		// 总时限：不是空闲超时，任务正常跑着就不会被掐
		timer = setTimeout(() => {
			req.destroy(new Error(`内核请求超过总时限 ${Math.round(timeoutMs / 1000)}s`));
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		req.on("error", (e) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(e);
		});
		if (body !== undefined) req.write(body);
		req.end();
	});
}

async function kernelCall(
	method: string,
	path: string,
	body: unknown,
	opts: { timeoutMs?: number; signal?: AbortSignal; retry?: boolean } = {},
): Promise<KernelResult> {
	const key = await getKey();
	if (!key) throw new Error("拿不到 sessionKey：请确认 TeleAgent 正在运行，或设 TA_SESSION_KEY / TA_SESSION_KEY_FILE");
	const payload = body === undefined ? undefined : JSON.stringify(body);
	const headers: Record<string, string> = { ...signHeaders(method, path, key) };
	if (payload !== undefined) {
		headers["Content-Type"] = "application/json";
		headers["Content-Length"] = String(Buffer.byteLength(payload));
	}
	const res = await rawRequest(KERNEL + path, method, headers, payload, opts.timeoutMs ?? 60_000, opts.signal);
	const text = res.text;
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON
	}
	// 密钥失效（App 重启过）：重取一次再试
	if ((res.status === 401 || res.status === 403) && opts.retry !== false) {
		cachedKey = undefined;
		if (await getKey(true)) {
			return kernelCall(method, path, body, { ...opts, retry: false });
		}
	}
	return { status: res.status, json, text };
}

interface RecoveredMessage {
	text: string;
	reasoning: string;
	tools: ToolTrace[];
	info: any;
}

/**
 * POST 中途断线时的兜底：内核通常仍在后台把任务跑完，
 * 这里轮询会话历史，等到出现「稳定不变的 assistant 文本」就当作最终结果返回。
 * 这样既不会误报失败，也避免了「重新提交一次」导致的双跑互相覆盖。
 */
async function recoverFromHistory(
	sessionId: string,
	deadlineMs: number,
	signal?: AbortSignal,
): Promise<RecoveredMessage | undefined> {
	let lastText = "";
	let stable = 0;
	while (Date.now() < deadlineMs) {
		if (signal?.aborted) return undefined;
		try {
			const r = await kernelCall("GET", `/session/${sessionId}/message`, undefined, { timeoutMs: 20_000, retry: false, signal });
			const arr: any[] = Array.isArray(r.json) ? r.json : (r.json?.data ?? []);
			let hit: RecoveredMessage | undefined;
			for (const m of arr) {
				const d = m?.data ?? m;
				const info = d?.info ?? m?.info ?? {};
				const role = info?.role ?? d?.role;
				if (role && role !== "assistant") continue;
				const { text, reasoning, tools } = collectParts(d?.parts ?? d?.content ?? []);
				if (!text.trim()) continue;
				hit = { text, reasoning, tools, info };
			}
			if (hit) {
				const finished = hit.info?.finish && String(hit.info.finish) !== "unknown";
				if (finished) return hit;
				if (hit.text === lastText) {
					stable++;
					if (stable >= 2) return hit;
				} else {
					lastText = hit.text;
					stable = 0;
				}
			}
		} catch {
			// 单次轮询失败忽略
		}
		await new Promise((done) => setTimeout(done, 5000));
	}
	return undefined;
}

// ---------------------------------------------------------------- 权限自动放行

/** 应答一个待处理的权限请求（reply: once/session/always/reject） */
async function answerPendingPermissions(): Promise<void> {
	const r = await kernelCall("GET", "/permission", undefined, { timeoutMs: 10_000, retry: false });
	const list: any[] = Array.isArray(r.json) ? r.json : (r.json?.data ?? []);
	for (const item of list) {
		const id = item?.id ?? item?.requestID ?? item?.permissionID;
		if (!id) continue;
		await kernelCall("POST", `/permission/${id}/reply`, { reply: "always" }, { timeoutMs: 10_000, retry: false });
	}
}

/** 启动后台自动放行循环，返回停止函数 */
function startAutoApprove(): () => void {
	// 150ms：权限应答本身是串在 agent 循环里的，间隔越大每个工具调用越多等一次
	const timer = setInterval(() => {
		void answerPendingPermissions().catch(() => {});
	}, 150);
	return () => clearInterval(timer);
}

// ---------------------------------------------------------------- 孤儿会话治理

/**
 * 为什么需要这个：
 * POST /session/:id/message 是同步阻塞接口，pi 这边一旦超时/断开（历史上 undici 还会在 300s
 * 抛 fetch failed），**内核会话并不会停**，它会继续在自己的 agent loop 里跑下去。
 * 实测踩坑：一个 10:24 建的会话到 11:08 还在「生成→自查→重做」死循环，反复覆盖产物文件，
 * 还白烧 token/并发槽。所以：任何一次「我们不再等它」的时刻，都要主动 abort。
 */
const ACTIVE_SESSIONS = new Set<string>();

async function abortSession(sessionId: string, reason: string): Promise<void> {
	if (!sessionId) return;
	try {
		const r = await kernelCall("POST", `/session/${sessionId}/abort`, {}, { timeoutMs: 10_000, retry: false });
		if (r.status >= 200 && r.status < 300) ACTIVE_SESSIONS.delete(sessionId);
	} catch {
		// 内核可能已结束或重启，忽略
	}
}

/** 内核里所有会话（用于清扫） */
async function listSessions(): Promise<Array<{ id: string; title: string; updated: number }>> {
	try {
		const r = await kernelCall("GET", "/session", undefined, { timeoutMs: 20_000, retry: false });
		const arr: any[] = Array.isArray(r.json) ? r.json : (r.json?.data ?? []);
		return arr.map((s) => ({
			id: String(s.id ?? ""),
			title: String(s.title ?? ""),
			updated: Number(s.time?.updated ?? s.time?.created ?? 0),
		}));
	} catch {
		return [];
	}
}

/** 扫掉历史遗留的长跑会话（pid 前缀 = 本扩展建的） */
async function killOrphans(): Promise<{ killed: number; ids: string[] }> {
	const all = await listSessions();
	const old = Date.now() - ORPHAN_AGE_MS;
	const targets = all.filter((s) => s.id && s.updated < old && !ACTIVE_SESSIONS.has(s.id));
	const ids: string[] = [];
	for (const s of targets) {
		await abortSession(s.id, "orphan-sweep");
		ids.push(s.id);
	}
	return { killed: ids.length, ids };
}

// pi 退出时尽量把还在跑的会话收掉，否则它们会变成孤儿继续烧
process.once("exit", () => {
	for (const id of ACTIVE_SESSIONS) {
		try {
			void abortSession(id, "pi-exit");
		} catch {}
	}
});

// ---------------------------------------------------------------- 执行任务

interface ToolTrace {
	tool: string;
	status: string;
	count: number;
}

interface RunResult {
	text: string;
	reasoning: string;
	tools: ToolTrace[];
	sessionId: string;
	messageId: string;
	modelId: string;
	finish: string;
	tokens: any;
}

function shortTitle(task: string): string {
	const t = task.replace(/\s+/g, " ").trim();
	return (t.length > 24 ? t.slice(0, 24) + "…" : t) || "pi-delegated-task";
}

function collectParts(parts: any[]): { text: string; reasoning: string; tools: ToolTrace[] } {
	let text = "";
	let reasoning = "";
	const tools: ToolTrace[] = [];
	for (const p of parts || []) {
		if (p?.type === "text" && typeof p.text === "string") text += p.text;
		else if (p?.type === "reasoning" && typeof p.text === "string") reasoning += p.text;
		else if (p?.type === "tool") {
			const st = p.state || {};
			tools.push({ tool: String(p.tool ?? "tool"), status: String(st.status ?? "?"), count: 1 });
		}
	}
	return { text, reasoning, tools };
}

/** 从会话历史里汇总真实的工具调用轨迹（message 响应本身不含 tool 段）。 */
async function fetchToolTrace(sessionId: string): Promise<ToolTrace[]> {
	try {
		const r = await kernelCall("GET", `/session/${sessionId}/message`, undefined, { timeoutMs: 20_000 });
		const arr: any[] = Array.isArray(r.json) ? r.json : (r.json?.data ?? []);
		const seen = new Map<string, ToolTrace>();
		for (const m of arr) {
			const parts = m?.parts ?? m?.data?.parts ?? [];
			for (const p of parts) {
				if (p?.type !== "tool") continue;
				const tool = String(p.tool ?? "tool");
				const status = String(p.state?.status ?? "?");
				const k = tool + ":" + status;
				const cur = seen.get(k);
				if (cur) cur.count++;
				else seen.set(k, { tool, status, count: 1 });
			}
		}
		return [...seen.values()];
	} catch {
		return [];
	}
}

async function runTask(
	task: string,
	model: ModelId,
	timeoutSec: number,
	signal: AbortSignal | undefined,
	onUpdate: ((u: { content: { type: "text"; text: string }[] }) => void) | undefined,
): Promise<RunResult> {
	onUpdate?.({ content: [{ type: "text", text: "正在内核建会话…" }] });
	const created = await kernelCall("POST", "/session", { title: shortTitle(task) }, { timeoutMs: 20_000, signal });
	if (created.status !== 200 || !created.json?.id) {
		throw new Error(`内核建会话失败(${created.status}): ${created.text.slice(0, 300)}`);
	}
	const sessionId: string = created.json.id;
	ACTIVE_SESSIONS.add(sessionId);

	onUpdate?.({
		content: [{ type: "text", text: `已交给 TeleAgent 内核自治执行（${sessionId}，模型 ${model}）…` }],
	});

	const body: Record<string, unknown> = {
		model: { providerID: PROVIDER, modelID: model },
		parts: [{ type: "text", text: task }],
	};
	if (KERNEL_MODE) body.mode = KERNEL_MODE;

	// 保险：即使内核仍然发出权限确认，也自动放行（否则无人值守会永久卡住）
	const stopAutoApprove = startAutoApprove();
	let r: KernelResult;
	try {
		r = await kernelCall("POST", `/session/${sessionId}/message`, body, {
			timeoutMs: timeoutSec * 1000,
			signal,
		});
	} catch (err) {
		// 断线 ≠ 任务没在跑。内核往往还在后台执行，这里改为轮询会话历史兜底，
		// 避免「明明在跑却报失败」以及由此引发的重复提交/结果互相覆盖。
		onUpdate?.({ content: [{ type: "text", text: `请求中断（${(err as Error).message}），改为轮询内核会话历史等待结果…` }] });
		const recovered = await recoverFromHistory(sessionId, Date.now() + timeoutSec * 1000, signal);
		if (!recovered) {
			// 确认拿不回结果，且 pi 也不再等了 —— 那就别把内核留在那儿空转
			await abortSession(sessionId, "pi-timeout");
			throw err;
		}
		const toolsFromHistory = await fetchToolTrace(sessionId);
		ACTIVE_SESSIONS.delete(sessionId);
		return {
			text: recovered.text,
			reasoning: recovered.reasoning,
			tools: toolsFromHistory.length ? toolsFromHistory : recovered.tools,
			sessionId,
			messageId: String(recovered.info?.id ?? ""),
			modelId: String(recovered.info?.modelID ?? model),
			finish: String(recovered.info?.finish ?? "stop"),
			tokens: recovered.info?.tokens ?? {},
		};
	} finally {
		stopAutoApprove();
		if (signal?.aborted) {
			// 用户在 pi 里 Ctrl+C / 取消了 —— 内核也要停，否则立刻变孤儿
			await abortSession(sessionId, "pi-aborted");
		}
	}
	if (r.status !== 200 || !r.json) {
		throw new Error(`内核执行失败(${r.status}): ${r.text.slice(0, 400)}`);
	}
	const data = r.json.data ?? r.json;
	const info = data.info ?? {};
	const { text, reasoning, tools } = collectParts(data.parts);
	// 优先用会话历史里的真实工具轨迹（响应 parts 里没有 tool 段）
	const historyTools = await fetchToolTrace(sessionId);
	const mergedTools = historyTools.length ? historyTools : tools;
	ACTIVE_SESSIONS.delete(sessionId);

	return {
		text,
		reasoning,
		tools: mergedTools,
		sessionId,
		messageId: String(info.id ?? ""),
		modelId: String(info.modelID ?? model),
		finish: String(info.finish ?? "stop"),
		tokens: info.tokens ?? {},
	};
}

function formatResult(res: RunResult): string {
	const toolLines = res.tools.length
		? res.tools.map((t) => `- ${t.tool}: ${t.status} ×${t.count}`).join("\n")
		: "- ⚠️ 未调用任何工具（结果未经验证，可能是模型凭记忆作答，请自行核实）";
	let text = res.text.trim() || "（内核未返回文本输出）";
	if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + "\n…（已截断）";
	const tk = res.tokens || {};
	const usage = `input ${tk.input ?? 0} / output ${tk.output ?? 0} / total ${tk.total ?? 0}`;
	return [
		"## TeleAgent 子代理执行结果",
		"",
		text,
		"",
		"--- 内核执行报告 ---",
		`模型: ${res.modelId}    finish: ${res.finish}`,
		`会话: ${res.sessionId}    token: ${usage}`,
		"调用的工具:",
		toolLines,
	].join("\n");
}

/** 把内核返回的 token 统计映射成 pi 的 usage 结构 */
function toUsage(tk: any) {
	const t = tk || {};
	return {
		input: t.input ?? 0,
		output: t.output ?? 0,
		cacheRead: t.cache?.read ?? 0,
		cacheWrite: t.cache?.write ?? 0,
		reasoning: t.reasoning,
		totalTokens: t.total ?? (t.input ?? 0) + (t.output ?? 0),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// ---------------------------------------------------------------- extension

export default function teleagentSubagent(pi: ExtensionAPI) {
	const RO = "【约束】只允许读取/查询，禁止创建、修改、删除任何文件，禁止执行会改变系统状态的命令；只输出结论与依据。\n\n";

	pi.registerTool({
		name: "teleagent",
		label: "TeleAgent Subagent",
		description:
			"把具体执行委派给 TeleAgent 内核自治 agent（它自带 powershell/读写文件/联网搜索/生图/MCP，自主多轮）。" +
			"pi 负责规划与验收，执行交给它。任务必须自包含（它看不到本对话上下文）。" +
			"返回最终文本 + 它调用了哪些工具。需要联网、生图、浏览器自动化、长时间多步操作时用它。",
		promptSnippet: "委派执行任务给 TeleAgent 内核自治 agent（联网/生图/命令/浏览器）",
		promptGuidelines: [
			"teleagent 是一个自治子代理：只在需要真正动手执行（联网搜索、生图、浏览器自动化、多步机器操作）时用它，纯推理/规划不要用它。",
			"调用 teleagent 时 task 必须自包含（含目标、约束、期望产出与验收标准），因为它拿不到本会话的上下文。",
			"需要保守操作时把 mode 设为 readonly；执行类任务默认 execute，并在 task 里写清边界（不要删什么、不要改什么）。",
			"长任务（生图/多步执行）请显式传 timeoutSec（建议 900~1800），内核是同步阻塞返回的。",
			"同一个任务在超时/报错后不要立刻原样重发：内核可能仍在后台执行，重发会导致双跑并互相覆盖产物。",
			"【提速关键】需要做 N 件互相独立的事（N 张图 / N 个房间 / N 个文件）时，**不要**发 N 次 teleagent 调用，也不要塞进一个 task 让子代理串行做：一次调用用 tasks 数组扇出，内核会并发跑多个会话（实测 9 张图并行约 90 秒，串行要 10 分钟以上）。",
			"扇出时每个子任务必须**只做一件事**且自包含（一个房间=一个 task）。子代理在单任务里做多件事时极易串味、挑错产物。",
			"【反模式】不要让子代理「生成图→自己看图自查→不合格就重做」循环：这既慢又经常挑错文件。应当让它只负责生成/执行并回报**原始产物路径**，验证与挑选由 pi 自己做。",
		],
		// parallel：允许与其它工具调用并发。之前是 sequential，pi 会把多个 teleagent 调用排成一条队，
		// 这是「子智能体怎么这么慢」的头号原因（N 个任务线性叠加）。
		executionMode: "parallel",
		parameters: Type.Object({
			task: Type.Optional(Type.String({ description: "单个自包含任务（目标、约束、期望产出、验收标准）" })),
			tasks: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"批量扇出：多个互相独立的子任务，内核会并发执行（比多次调用或串行快一个数量级）。只传 tasks 时 task 可省略。",
				}),
			),
			model: Type.Optional(StringEnum(MODEL_IDS)),
			mode: Type.Optional(StringEnum(["execute", "readonly"] as const)),
			timeoutSec: Type.Optional(Type.Number({ description: "超时秒数，默认 300" })),
			concurrency: Type.Optional(Type.Number({ description: "扇出并发上限，默认=任务数，最多 8" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate): Promise<any> {
			const mode = params.mode ?? "execute";
			const timeoutSec = Math.min(Math.max(params.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 30), 3600);
			const model = (params.model ?? "chat-pro") as ModelId;
			const list = (params.tasks?.length ? params.tasks : [params.task ?? ""]).map((t) => t.trim()).filter(Boolean);
			if (!list.length) throw new Error("task / tasks 至少要有一个非空任务");
			const prep = (t: string) => (mode === "readonly" ? RO + t : t);

			type Outcome = { idx: number; ok: boolean; res?: RunResult; err?: string };

			// 单任务：走原路径，保留 onUpdate 流式提示
			if (list.length === 1) {
				const res = await runTask(prep(list[0]), model, timeoutSec, signal, onUpdate as any);
				const tk = res.tokens || {};
				return {
					content: [{ type: "text", text: formatResult(res) }],
					details: { sessionId: res.sessionId, messageId: res.messageId, model: res.modelId, tools: res.tools },
					usage: toUsage(tk),
				};
			}

			// 多任务：并发扇出到多个内核会话（这是主要提速手段）
			const limit = Math.min(Math.max(Math.floor(params.concurrency ?? list.length), 1), 8);
			const outcomes: Outcome[] = new Array(list.length);
			let cursor = 0;
			let done = 0;
			const started = Date.now();
			const progress = () =>
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `扇出 ${list.length} 个内核会话（并发 ${limit}）… 已完成 ${done}/${list.length}，用时 ${Math.round((Date.now() - started) / 1000)}s`,
						},
					],
				});
			progress();
			const worker = async () => {
				for (;;) {
					const i = cursor++;
					if (i >= list.length) return;
					try {
						outcomes[i] = { idx: i, ok: true, res: await runTask(prep(list[i]), model, timeoutSec, signal, undefined) };
					} catch (e) {
						outcomes[i] = { idx: i, ok: false, err: (e as Error).message };
					}
					done++;
					progress();
				}
			};
			await Promise.all(Array.from({ length: limit }, () => worker()));

			const okCount = outcomes.filter((o) => o?.ok).length;
			const blocks = outcomes.map((o, i) => {
				const head = `### [#${i + 1}] ${shortTitle(list[i])}`;
				if (!o || !o.ok) return `${head}\n\n❌ 失败：${o?.err ?? "未知错误"}`;
				return `${head}\n\n${o.res!.text.trim() || "（无文本输出）"}`;
			});
			const summary = [
				`## TeleAgent 扇出结果（${okCount}/${list.length} 成功，并发 ${limit}，总耗时 ${Math.round((Date.now() - started) / 1000)}s）`,
				"",
				blocks.join("\n\n---\n\n"),
			].join("\n");
			const usage = outcomes.reduce(
				(acc, o) => {
					const tk = o?.res?.tokens || {};
					acc.input += tk.input ?? 0;
					acc.output += tk.output ?? 0;
					acc.cacheRead += tk.cache?.read ?? 0;
					acc.cacheWrite += tk.cache?.write ?? 0;
					acc.totalTokens += tk.total ?? (tk.input ?? 0) + (tk.output ?? 0);
					return acc;
				},
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			);
			return {
				content: [{ type: "text", text: summary.length > MAX_RESULT_CHARS ? summary.slice(0, MAX_RESULT_CHARS) + "\n…（已截断）" : summary }],
				details: {
					fanout: outcomes.map((o, i) => ({ idx: i + 1, ok: !!o?.ok, sessionId: o?.res?.sessionId ?? null, tools: o?.res?.tools ?? [] })),
				},
				usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
		},
	});

	// 便捷命令：/ta <任务>
	pi.registerCommand("ta", {
		description: "把任务交给 TeleAgent 内核子代理执行（/ta <任务>）",
		handler: async (args, ctx) => {
			const task = String(args ?? "").trim();
			if (!task) {
				ctx.ui.notify("用法：/ta <任务描述>", "warning");
				return;
			}
			ctx.ui.notify("已提交 TeleAgent 内核，执行中…", "info");
			try {
				const res = await runTask(task, "chat-pro", DEFAULT_TIMEOUT_SEC, undefined, undefined);
				ctx.ui.notify(formatResult(res).slice(0, 1500), "info");
			} catch (err) {
				ctx.ui.notify(`TeleAgent 子代理失败：${(err as Error).message}`, "error");
			}
		},
	});

	// 便捷命令：/ta-kill —— 清扫内核里挂着的长跑/孤儿会话（它们会持续烧 token 并覆盖产物）
	pi.registerCommand("ta-kill", {
		description: "终止内核中挂着的长跑/孤儿会话（/ta-kill [all]）",
		handler: async (args, ctx) => {
			if (String(args ?? "").trim() !== "all") {
				const r = await killOrphans();
				ctx.ui.notify(
					r.killed
						? `已清理 ${r.killed} 个遗留孤儿会话：${r.ids.map((i) => i.slice(0, 12)).join(", ")}`
						: "未发现遗留孤儿会话",
					"info",
				);
				return;
			}
			const list = (await listSessions()).filter((s) => s.id && !ACTIVE_SESSIONS.has(s.id));
			if (!list.length) {
				ctx.ui.notify("内核没有空闲会话可清理", "info");
				return;
			}
			for (const s of list) await abortSession(s.id, "manual");
			ctx.ui.notify(`已终止 ${list.length} 个会话`, "info");
		},
	});
}
