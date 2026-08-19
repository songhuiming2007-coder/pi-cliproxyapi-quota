/**
 * pi-cliproxy-quota
 *
 * Two commands for a CLIProxyAPI (EasyCLIProxyAPI) setup:
 *  - /quota (alias /额度): show the Claude subscription 5-hour + weekly quota,
 *    fetched exactly like the EasyCLIProxyAPI panel does: the proxy management
 *    API `POST /v0/management/api-call` proxies a GET to
 *    https://api.anthropic.com/api/oauth/usage using the stored Claude OAuth token.
 *  - /think [level]: show or set the thinking level for the current model, and
 *    keep a footer indicator of the active level (native Shift+Tab also works).
 *
 * No secrets in source. Management key is read at runtime from env,
 * ~/.pi/agent/cliproxyapi-quota.json, or the GUI config.toml. See AGENTS.md.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, ModelThinkingLevel } from "@earendil-works/pi-ai";

// ---------- config resolution ----------

const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
const AGENT_DIR = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");

// EasyCLIProxyAPI GUI config.toml candidate locations, per platform.
function guiConfigCandidates(): string[] {
	const home = homedir();
	if (process.platform === "darwin") {
		return [join(home, "Library", "Application Support", "com.cpa.gui", "config.toml")];
	}
	if (process.platform === "win32") {
		const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
		return [join(appData, "com.cpa.gui", "config.toml")];
	}
	// linux / other
	const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
	return [join(xdg, "com.cpa.gui", "config.toml")];
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function firstString(...vals: unknown[]): string | undefined {
	for (const v of vals) {
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

export function resolveBaseUrl(): string {
	const fromFile = readJson(join(AGENT_DIR, "cliproxyapi.json"))?.baseUrl;
	return firstString(process.env.CLIPROXYAPI_BASE_URL, fromFile) ?? DEFAULT_BASE_URL;
}

/** Read `management-secret-key = "..."` from the GUI TOML without a TOML dep. */
function readManagementKeyFromToml(): string | undefined {
	for (const path of guiConfigCandidates()) {
		try {
			const text = readFileSync(path, "utf8");
			const m = text.match(/^\s*management-secret-key\s*=\s*"([^"]+)"/m);
			if (m?.[1]) return m[1];
		} catch {
			// try next candidate
		}
	}
	return undefined;
}

export function resolveManagementKey(): string | undefined {
	const override = readJson(join(AGENT_DIR, "cliproxyapi-quota.json"))?.managementKey;
	return firstString(
		process.env.CLIPROXYAPI_MANAGEMENT_KEY,
		override,
		readManagementKeyFromToml(),
	);
}

// ---------- management API ----------

interface AuthFile {
	id: string;
	name: string;
	provider?: string;
	type?: string;
	auth_index?: string;
	disabled?: boolean;
	email?: string;
	label?: string;
}

async function mgmtGet<T>(base: string, key: string, path: string): Promise<T> {
	const res = await fetch(`${base}/v0/management/${path}`, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
	return (await res.json()) as T;
}

async function mgmtApiCall(
	base: string,
	key: string,
	body: unknown,
): Promise<{ status_code: number; body: string }> {
	const res = await fetch(`${base}/v0/management/api-call`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`api-call -> HTTP ${res.status}`);
	return (await res.json()) as { status_code: number; body: string };
}

async function listClaudeCredentials(base: string, key: string): Promise<AuthFile[]> {
	const data = await mgmtGet<{ files?: AuthFile[] }>(base, key, "auth-files");
	return (data.files ?? []).filter(
		(f) =>
			(f.provider === "claude" || f.type === "claude") &&
			!f.disabled &&
			typeof f.auth_index === "string" &&
			f.auth_index.length > 0,
	);
}

// Anthropic OAuth usage endpoint (proxy swaps $TOKEN$ for the real bearer).
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_USAGE_HEADERS = {
	Authorization: "Bearer $TOKEN$",
	"Content-Type": "application/json",
	"anthropic-beta": "oauth-2025-04-20",
};

interface UsageWindow {
	utilization: number | null;
	resets_at: string | null;
}
interface UsageResponse {
	[key: string]: UsageWindow | null | unknown;
}

async function fetchClaudeUsage(
	base: string,
	key: string,
	authIndex: string,
): Promise<UsageResponse> {
	const out = await mgmtApiCall(base, key, {
		authIndex,
		method: "GET",
		url: ANTHROPIC_USAGE_URL,
		header: ANTHROPIC_USAGE_HEADERS,
	});
	if (out.status_code < 200 || out.status_code >= 300) {
		throw new Error(`usage upstream HTTP ${out.status_code}`);
	}
	return JSON.parse(out.body) as UsageResponse;
}

// ---------- rendering ----------

// Ordered list of known windows and their human labels (Chinese).
const WINDOW_LABELS: Array<[string, string]> = [
	["five_hour", "5 小时 (会话)"],
	["seven_day", "7 天 (周)"],
	["seven_day_opus", "7 天 Opus"],
	["seven_day_sonnet", "7 天 Sonnet"],
	["seven_day_oauth_apps", "7 天 OAuth 应用"],
	["seven_day_cowork", "7 天 Cowork"],
	["seven_day_fable", "7 天 Fable"],
];

export function formatReset(iso: string | null, now = Date.now()): string {
	if (!iso) return "—";
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "—";
	let ms = t - now;
	if (ms <= 0) return "可刷新";
	const days = Math.floor(ms / 86_400_000);
	ms -= days * 86_400_000;
	const hours = Math.floor(ms / 3_600_000);
	ms -= hours * 3_600_000;
	const minutes = Math.floor(ms / 60_000);
	if (days > 0) return `${days}天${hours}小时后`;
	if (hours > 0) return `${hours}小时${minutes}分后`;
	return `${minutes}分后`;
}

function bar(pct: number, width = 12): string {
	const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function isWindow(v: unknown): v is UsageWindow {
	return !!v && typeof v === "object" && "utilization" in (v as object);
}

/** Build display lines for one credential's usage payload. */
export function renderUsage(usage: UsageResponse, now = Date.now()): string[] {
	const lines: string[] = [];
	for (const [key, label] of WINDOW_LABELS) {
		const w = usage[key];
		if (!isWindow(w) || typeof w.utilization !== "number") continue;
		const used = w.utilization;
		const remain = Math.max(0, 100 - used);
		lines.push(
			`  ${label.padEnd(14)} ${bar(used)} 已用 ${used.toFixed(0)}% · 余 ${remain.toFixed(0)}% · ${formatReset(w.resets_at, now)}`,
		);
	}
	if (lines.length === 0) lines.push("  (无可用配额窗口数据)");
	return lines;
}

/** Compact one-line summary for the footer. */
export function summaryLine(usage: UsageResponse): string {
	const parts: string[] = [];
	const fh = usage.five_hour;
	const wk = usage.seven_day;
	if (isWindow(fh) && typeof fh.utilization === "number")
		parts.push(`5h 剩${Math.max(0, 100 - fh.utilization).toFixed(0)}%`);
	if (isWindow(wk) && typeof wk.utilization === "number")
		parts.push(`周 剩${Math.max(0, 100 - wk.utilization).toFixed(0)}%`);
	return parts.length ? `额度 ${parts.join(" · ")}` : "额度 n/a";
}

// ---------- extension ----------

function isPrimaryUiSession(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

const THINK_ORDER: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function supportedLevels(ctx: ExtensionContext): ModelThinkingLevel[] {
	const map = ctx.model?.thinkingLevelMap;
	if (!map) return [];
	return THINK_ORDER.filter((lvl) => lvl === "off" || (map[lvl] != null));
}

export default function (pi: ExtensionAPI): void {
	// ----- footer: current thinking level -----
	const THINK_KEY = "cliproxy-think";
	function refreshThinkStatus(ctx: ExtensionContext): void {
		if (!isPrimaryUiSession(ctx)) return;
		const level = pi.getThinkingLevel();
		ctx.ui.setStatus(THINK_KEY, ctx.ui.theme.fg("dim", `🧠 ${level}`));
	}
	pi.on("thinking_level_select", (_e, ctx) => refreshThinkStatus(ctx));
	pi.on("model_select", (_e, ctx) => refreshThinkStatus(ctx));
	pi.on("before_agent_start", (_e, ctx) => refreshThinkStatus(ctx));

	// ----- /think -----
	pi.registerCommand("think", {
		description: "查看或设置当前模型的思考强度 (off/minimal/low/medium/high/xhigh/max)",
		getArgumentCompletions: (prefix: string) => {
			const items = THINK_ORDER.map((l) => ({ value: l, label: l }));
			const f = items.filter((i) => i.value.startsWith(prefix.trim().toLowerCase()));
			return f.length ? f : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const supported = supportedLevels(ctx);
			if (!arg) {
				const cur = pi.getThinkingLevel();
				const list = supported.length ? supported.join(" / ") : "(当前模型不支持思考)";
				ctx.ui.notify(
					`当前思考强度: ${cur}\n本模型可选: ${list}\n用法: /think high   (也可按 Shift+Tab 循环)`,
					"info",
				);
				return;
			}
			if (!THINK_ORDER.includes(arg as ModelThinkingLevel)) {
				ctx.ui.notify(`未知档位 "${arg}"。可选: ${THINK_ORDER.join(" / ")}`, "error");
				return;
			}
			if (arg !== "off" && supported.length && !supported.includes(arg as ModelThinkingLevel)) {
				ctx.ui.notify(
					`本模型不支持 "${arg}"。可选: ${supported.join(" / ")}`,
					"warning",
				);
				return;
			}
			pi.setThinkingLevel(arg === "off" ? ("off" as ThinkingLevel) : (arg as ThinkingLevel));
			refreshThinkStatus(ctx);
			ctx.ui.notify(`思考强度已设为: ${pi.getThinkingLevel()}`, "info");
		},
	});

	// ----- /quota -----
	const QUOTA_KEY = "cliproxy-quota";
	let lastFooterFetch = 0;

	async function collectUsage(now: number): Promise<{ blocks: string[]; footer: string }> {
		const base = resolveBaseUrl();
		const key = resolveManagementKey();
		if (!key) throw new Error("NO_KEY");
		const creds = await listClaudeCredentials(base, key);
		if (creds.length === 0) throw new Error("NO_CRED");
		const blocks: string[] = [];
		let footer = "";
		for (const c of creds) {
			const who = c.email || c.label || c.name;
			try {
				const usage = await fetchClaudeUsage(base, key, c.auth_index as string);
				blocks.push(`● ${who}`);
				blocks.push(...renderUsage(usage, now));
				if (!footer) footer = summaryLine(usage);
			} catch (err) {
				blocks.push(`● ${who}\n  获取失败: ${(err as Error).message}`);
			}
		}
		return { blocks, footer };
	}

	// silent=true 只更新 footer，不弹 toast（供运行中/结束时自动刷新）。
	async function runQuota(ctx: ExtensionContext, silent = false): Promise<void> {
		if (!silent) ctx.ui.notify("正在获取额度…", "info");
		try {
			const { blocks, footer } = await collectUsage(Date.now());
			if (!silent) ctx.ui.notify(`Claude 订阅额度\n${blocks.join("\n")}`, "info");
			if (footer && isPrimaryUiSession(ctx)) {
				ctx.ui.setStatus(QUOTA_KEY, ctx.ui.theme.fg("dim", footer));
			}
		} catch (err) {
			if (silent) return;
			const msg = (err as Error).message;
			if (msg === "NO_KEY") {
				ctx.ui.notify(
					"未找到管理密钥。请设置 CLIPROXYAPI_MANAGEMENT_KEY，或在 ~/.pi/agent/cliproxyapi-quota.json 写入 {\"managementKey\":\"...\"}，或确保 EasyCLIProxyAPI GUI 已配置 management-secret-key。",
					"error",
				);
			} else if (msg === "NO_CRED") {
				ctx.ui.notify("未找到可用的 Claude OAuth 凭证。", "warning");
			} else {
				ctx.ui.notify(`获取额度失败: ${msg}`, "error");
			}
		}
	}

	// 自动刷新 footer：会话首轮开始 + 每轮结束，60s 节流，静默。
	function refreshFooterThrottled(ctx: ExtensionContext): void {
		if (!isPrimaryUiSession(ctx)) return;
		const now = Date.now();
		if (now - lastFooterFetch < 60_000) return;
		lastFooterFetch = now;
		void runQuota(ctx, true);
	}
	pi.on("before_agent_start", (_e, ctx) => refreshFooterThrottled(ctx));
	pi.on("agent_settled", (_e, ctx) => refreshFooterThrottled(ctx));

	// 运行中也能按：快捷键即时拉取并弹出额度。
	pi.registerShortcut("ctrl+shift+q", {
		description: "查看 Claude 订阅额度 (5 小时 / 周)",
		handler: (ctx) => runQuota(ctx),
	});

	pi.registerCommand("quota", {
		description: "查看 Claude 订阅的 5 小时 / 周额度 (经 CLIProxyAPI)",
		handler: async (_args, ctx) => runQuota(ctx),
	});
	pi.registerCommand("额度", {
		description: "查看 Claude 订阅的 5 小时 / 周额度 (经 CLIProxyAPI)",
		handler: async (_args, ctx) => runQuota(ctx),
	});
}
