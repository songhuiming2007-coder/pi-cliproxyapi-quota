/**
 * pi-cliproxy-quota
 *
 * View subscription quota for every OAuth provider CLIProxyAPI holds inside pi:
 *  - /quota: show subscription quota for every OAuth provider the proxy holds,
 *    fetched exactly like the EasyCLIProxyAPI panel does via the proxy management
 *    API `POST /v0/management/api-call`. Providers: claude + antigravity/gemini
 *    (verified), codex + kimi + xai (best-effort, marked (unverified)).
 *  - Footer quota display: automatically refreshed at turn start/end.
 *
 * No secrets in source. Management key is read at runtime from env,
 * ~/.pi/agent/cliproxyapi-quota.json, or the GUI config.toml. See AGENTS.md.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
	project_id?: string;
	path?: string;
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

// List every OAuth credential the proxy holds (any provider), enabled only.
async function listCredentials(base: string, key: string): Promise<AuthFile[]> {
	const data = await mgmtGet<{ files?: AuthFile[] }>(base, key, "auth-files");
	return (data.files ?? []).filter(
		(f) => typeof f.auth_index === "string" && f.auth_index.length > 0 && !f.disabled,
	);
}

// Normalize provider name the same way the GUI does.
function providerKey(f: AuthFile): string {
	const raw = (f.provider ?? f.type ?? "").trim().toLowerCase().replace(/_/g, "-");
	if (raw === "x-ai" || raw === "grok") return "xai";
	return raw;
}

// Normalized quota window (remaining-oriented; used = 100 - remaining).
export interface Win {
	/** Antigravity shared pool; absent on other providers/unknown groups. */
	quotaGroup?: "gemini" | "claude-gpt";
	label: string;
	remainingPct: number | null;
	resetIso: string | null;
}

function toNum(v: unknown): number | null {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
	return Number.isFinite(n) ? n : null;
}

function firstIso(...vals: unknown[]): string | null {
	for (const v of vals) if (typeof v === "string" && v.trim()) return v;
	return null;
}

// Run one upstream request through the management api-call proxy; returns raw body text.
// The proxy substitutes $TOKEN$ in headers with the stored OAuth bearer for authIndex.
async function proxyCall(
	base: string,
	key: string,
	req: { authIndex: string; method: string; url: string; header?: Record<string, string>; body?: string },
): Promise<string> {
	const out = await mgmtApiCall(base, key, req);
	if (out.status_code < 200 || out.status_code >= 300) {
		throw new Error(`upstream HTTP ${out.status_code}`);
	}
	return out.body;
}

const BEARER = { Authorization: "Bearer $TOKEN$" };

interface Adapter {
	verified: boolean;
	fetch: (base: string, key: string, cred: AuthFile) => Promise<Win[]>;
}

// ---- claude (VERIFIED): GET api.anthropic.com/api/oauth/usage ----
const CLAUDE_WINDOWS: Array<[string, string]> = [
	["five_hour", "5-hour (session)"],
	["seven_day", "7-day (weekly)"],
	["seven_day_oauth_apps", "7-day OAuth apps"],
	["seven_day_opus", "7-day Opus"],
	["seven_day_sonnet", "7-day Sonnet"],
	["seven_day_cowork", "7-day Cowork"],
	["iguana_necktie", "7-day Fable"],
];
const claudeAdapter: Adapter = {
	verified: true,
	async fetch(base, key, cred) {
		const authIndex = cred.auth_index as string;
		const body = await proxyCall(base, key, {
			authIndex,
			method: "GET",
			url: "https://api.anthropic.com/api/oauth/usage",
			header: { ...BEARER, "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" },
		});
		const usage = JSON.parse(body) as Record<string, { utilization?: unknown; resets_at?: unknown } | null>;
		const wins: Win[] = [];
		for (const [k, label] of CLAUDE_WINDOWS) {
			const w = usage[k];
			if (!w || typeof w !== "object") continue;
			const u = toNum((w as { utilization?: unknown }).utilization);
			if (u === null) continue;
			wins.push({ label, remainingPct: Math.max(0, 100 - u), resetIso: firstIso((w as { resets_at?: unknown }).resets_at) });
		}
		return wins;
	},
};

// ---- antigravity / gemini code assist (VERIFIED) ----
// Two upstream signals, both via /v0/management/api-call proxy:
//   1. retrieveUserQuotaSummary → time-window buckets (Claude/GPT shared group on this account)
//   2. loadCodeAssist           → paidTier.availableCredits (GOOGLE_ONE_AI credit balance, the
//                                 Gemini-side quota) + tier info
// The second is authoritative for "does this credential still have Gemini quota" — it's a
// credit balance (amount vs minimumCreditAmountForUsage), not a percentage window.
const ANTIGRAVITY_HOSTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];
const ANTIGRAVITY_UA = "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)";

export function parseQuotaSummary(body: string): Win[] {
	const data = JSON.parse(body) as {
		groups?: Array<{ displayName?: unknown; buckets?: Array<Record<string, unknown>> }>;
	};
	const wins: Win[] = [];
	for (const g of data.groups ?? []) {
		const gname = typeof g.displayName === "string" ? g.displayName : "Group";
		for (const b of g.buckets ?? []) {
			const frac = toNum(b.remainingFraction);
			if (frac === null) continue;
			const win = String(b.window ?? "").toLowerCase();
			const tag = win === "5h" ? "5h" : win === "weekly" ? "weekly" : win || "quota";
			const bucketId = String(b.bucketId ?? "");
			const quotaGroup = bucketId.startsWith("gemini-") ? "gemini"
				: bucketId.startsWith("3p-") ? "claude-gpt"
				: gname === "Gemini Models" ? "gemini"
				: gname === "Claude and GPT models" ? "claude-gpt" : undefined;
			wins.push({
				quotaGroup,
				label: `${gname} · ${tag}`,
				remainingPct: Math.max(0, Math.min(100, frac * 100)),
				resetIso: firstIso(b.resetTime),
			});
		}
	}
	return wins;
}

const antigravityAdapter: Adapter = {
	verified: true,
	async fetch(base, key, cred) {
		const authIndex = cred.auth_index as string;
		const header = { ...BEARER, "Content-Type": "application/json", "User-Agent": ANTIGRAVITY_UA };
		const wins: Win[] = [];

		// 1) loadCodeAssist → paidTier.availableCredits + tier. Always fetched (it also
		//    hands us the project id when cred.project_id is absent).
		let project = cred.project_id;
		try {
			const body = await proxyCall(base, key, {
				authIndex, method: "POST",
				url: `${ANTIGRAVITY_HOSTS[0]}/v1internal:loadCodeAssist`,
				header, body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
			});
			const d = JSON.parse(body) as {
				cloudaicompanionProject?: unknown;
				paidTier?: { id?: unknown; name?: unknown; availableCredits?: Array<Record<string, unknown>> };
			};
			const cp = d.cloudaicompanionProject;
			project = project ?? (typeof cp === "string" ? cp : (cp as { id?: string } | undefined)?.id);
			const tier = d.paidTier;
			const tierName = typeof tier?.name === "string" ? tier.name : typeof tier?.id === "string" ? tier.id : "";
			const credits = tier?.availableCredits ?? [];
			const g1 = credits.find((c) => String(c.creditType ?? "").toUpperCase() === "GOOGLE_ONE_AI");
			if (g1) {
				const amt = toNum(g1.creditAmount);
				const min = toNum(g1.minimumCreditAmountForUsage);
				if (amt !== null) {
					const pct = min !== null && min > 0 ? Math.min(100, (amt / min) * 100) : null;
					wins.push({ label: `${tierName || "credits"} · GOOGLE_ONE_AI`, remainingPct: pct, resetIso: null });
				} else {
					// Google omits creditAmount when balance >= minimum (unconstrained).
					// Show it as a state marker, not a fabricated 100% — remainingPct=null
					// renders as "n/a" which is honest, and we put the real signal in the label.
					wins.push({ label: `${tierName || "credits"} · GOOGLE_ONE_AI (≥${min ?? "?"})`, remainingPct: null, resetIso: null });
				}
			}
		} catch {
			// loadCodeAssist best-effort; quota summary still runs below
		}

		// 2) retrieveUserQuotaSummary → time-window buckets
		if (project) {
			for (const host of ANTIGRAVITY_HOSTS) {
				try {
					const body = await proxyCall(base, key, {
						authIndex, method: "POST",
						url: `${host}/v1internal:retrieveUserQuotaSummary`,
						header, body: JSON.stringify({ project }),
					});
					wins.push(...parseQuotaSummary(body));
					return wins;
				} catch {
					// next host
				}
			}
		} else {
			// no project id: legacy prod-host call
			try {
				const body = await proxyCall(base, key, {
					authIndex, method: "POST",
					url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
					header, body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
				});
				wins.push(...parseQuotaSummary(body));
			} catch {
				// both signals failed — return whatever loadCodeAssist gave us
			}
		}
		return wins;
	},
};

// ---- devin (VERIFIED): Connect-RPC GetUserStatus @ server.codeium.com ----
// Devin's quota endpoint speaks protobuf over Connect-RPC, NOT the OAuth-bearer
// proxy that /v0/management/api-call provides — so this adapter bypasses proxyCall
// and hits the upstream directly. It reads the session_token from the credential
// file that auth-files reports (cred.path), builds the wire request by hand, and
// parses only the quota fields out of the (large) binary response.
// Reference: CLIProxyAPI internal/auth/devin/user_status.go
const DEVIN_STATUS_URL =
	"https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";

function devinFingerprint(seed: string): string {
	let s = "";
	let c = 0;
	while (s.length < 732) s += createHash("sha256").update(`${seed}-${c++}`).digest("hex");
	return s.slice(0, 732);
}

// protobuf wire helpers (bytes + varint only — all we need)
function pbVarint(n: number | bigint): Buffer {
	let v = BigInt(n);
	const b: number[] = [];
	do { b.push(Number(v & 0x7fn) | 0x80); v >>= 7n; } while (v > 0n);
	b[b.length - 1] &= 0x7f;
	return Buffer.from(b);
}
function pbStr(field: number, s: string): Buffer {
	const b = Buffer.from(s, "utf8");
	return Buffer.concat([pbVarint((field << 3) | 2), pbVarint(b.length), b]);
}
function* pbFields(buf: Buffer): Generator<{ f: number; wt: number; v?: bigint; b?: Buffer }> {
	let i = 0;
	const readV = (at: number): [bigint, number] => {
		let v = 0n, s = 0n, n = 0;
		while (true) { const x = buf[at + n]; v |= BigInt(x & 0x7f) << s; n++; if (!(x & 0x80)) break; s += 7n; }
		return [v, n];
	};
	while (i < buf.length) {
		const [key, kn] = readV(i); i += kn;
		const f = Number(key >> 3n), wt = Number(key & 7n);
		if (wt === 0) { const [v, n] = readV(i); yield { f, wt, v }; i += n; }
		else if (wt === 2) { const [len, ln] = readV(i); i += ln; const n = Number(len); yield { f, wt, b: buf.subarray(i, i + n) }; i += n; }
		else if (wt === 5) { yield { f, wt, b: buf.subarray(i, i + 4) }; i += 4; }
		else if (wt === 1) { yield { f, wt, b: buf.subarray(i, i + 8) }; i += 8; }
		else throw new Error(`protobuf wire type ${wt}`);
	}
}

const devinAdapter: Adapter = {
	verified: true,
	async fetch(_base, _key, cred) {
		// session_token lives in the credential file (auth-files gives us its path)
		if (!cred.path) throw new Error("devin credential has no path field");
		let token: string;
		try {
			token = (JSON.parse(readFileSync(cred.path, "utf8")) as { session_token?: string }).session_token ?? "";
		} catch (e) {
			throw new Error(`read devin credential: ${(e as Error).message}`);
		}
		if (!token) throw new Error("devin credential missing session_token");

		const inner = Buffer.concat([
			pbStr(1, "chisel"), pbStr(2, "3000.10.21"), pbStr(3, token),
			pbStr(4, "en"), pbStr(5, "darwin"), pbStr(7, "3000.10.21"),
			pbStr(12, "chisel"), pbStr(31, devinFingerprint(token)),
		]);
		const body = Buffer.concat([pbVarint((1 << 3) | 2), pbVarint(inner.length), inner]);
		const res = await fetch(DEVIN_STATUS_URL, {
			method: "POST",
			headers: {
				Authorization: `Basic ${token}-${token}`,
				"Connect-Protocol-Version": "1",
				"Content-Type": "application/proto",
				Accept: "*/*",
			},
			body,
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) throw new Error(`devin seat management HTTP ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());

		// top-level f1 = user_status; inside it f13 = plan_status; inside plan_status
		// f14=daily%, f15=weekly%, f17=dailyReset unix, f18=weeklyReset unix
		const wins: Win[] = [];
		for (const t of pbFields(buf)) {
			if (t.f !== 1 || t.wt !== 2 || !t.b) continue;
			for (const u of pbFields(t.b)) {
				if (u.f !== 13 || u.wt !== 2 || !u.b) continue;
				const iso = (sec: bigint) => new Date(Number(sec) * 1000).toISOString();
				let dailyPct: number | null = null;
				let weeklyPct: number | null = null;
				let dailyReset: string | null = null;
				let weeklyReset: string | null = null;
				for (const p of pbFields(u.b)) {
					if (p.wt !== 0 || p.v === undefined) continue;
					if (p.f === 14) dailyPct = Number(p.v);
					if (p.f === 15) weeklyPct = Number(p.v);
					if (p.f === 17) dailyReset = iso(p.v);
					if (p.f === 18) weeklyReset = iso(p.v);
				}
				if (weeklyPct !== null) wins.push({ label: "weekly", remainingPct: weeklyPct, resetIso: weeklyReset });
				if (dailyPct !== null) wins.push({ label: "daily", remainingPct: dailyPct, resetIso: dailyReset });
			}
		}
		return wins;
	},
};

// ---- kimi (VERIFIED): GET api.kimi.com/coding/v1/usages ----
// Real shape: top-level `usage` = weekly quota; `limits[].detail` = per-window quota
// with `limits[].window.{duration,timeUnit}` (e.g. 300 minutes = the 5h window).
const kimiAdapter: Adapter = {
	verified: true,
	async fetch(base, key, cred) {
		const authIndex = cred.auth_index as string;
		const body = await proxyCall(base, key, {
			authIndex, method: "GET", url: "https://api.kimi.com/coding/v1/usages", header: { ...BEARER },
		});
		const data = JSON.parse(body) as {
			usage?: Record<string, unknown>;
			limits?: Array<{ window?: { duration?: unknown; timeUnit?: unknown }; detail?: Record<string, unknown> }>;
		};
		const wins: Win[] = [];
		const push = (label: string, d: Record<string, unknown> | undefined): void => {
			const remaining = toNum(d?.remaining);
			const limit = toNum(d?.limit);
			if (remaining === null || limit === null || limit <= 0) return;
			wins.push({
				label,
				remainingPct: Math.max(0, Math.min(100, (remaining / limit) * 100)),
				resetIso: firstIso(d?.resetTime, d?.reset_at, d?.resetAt, d?.reset_time),
			});
		};
		push("weekly", data.usage);
		for (const l of data.limits ?? []) {
			const mins = String(l.window?.timeUnit ?? "").includes("MINUTE") ? toNum(l.window?.duration) : null;
			const label = mins === null ? "window" : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
			push(label, l.detail);
		}
		return wins;
	},
};

// ---- codex (UNVERIFIED): GET chatgpt.com/backend-api/wham/usage ----
const codexAdapter: Adapter = {
	verified: false,
	async fetch(base, key, cred) {
		const authIndex = cred.auth_index as string;
		const body = await proxyCall(base, key, {
			authIndex,
			method: "GET",
			url: "https://chatgpt.com/backend-api/wham/usage",
			header: {
				...BEARER,
				"Content-Type": "application/json",
				"User-Agent": "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal",
			},
		});
		const data = JSON.parse(body) as Record<string, unknown>;
		const wins: Win[] = [];
		const rl = (data.rate_limits ?? data) as Record<string, unknown>;
		for (const slot of ["primary", "secondary"] as const) {
			const r = rl[slot] as Record<string, unknown> | undefined;
			const up = toNum(r?.used_percent ?? r?.usedPercent);
			if (up === null) continue;
			const secs = toNum(r?.resets_in_seconds ?? r?.resetsInSeconds);
			const resetIso = secs !== null && secs > 0 ? new Date(Date.now() + secs * 1000).toISOString() : firstIso(r?.resets_at);
			wins.push({ label: `rate ${slot}`, remainingPct: Math.max(0, 100 - up), resetIso });
		}
		const bp = toNum(
			data.creditUsagePercent ?? data.credit_usage_percent ?? data.usagePercent ?? data.usage_percent,
		);
		if (bp !== null) {
			const cp = (data.currentPeriod ?? data.current_period) as Record<string, unknown> | undefined;
			wins.push({ label: "credits", remainingPct: Math.max(0, 100 - bp), resetIso: firstIso(cp?.end) });
		}
		return wins;
	},
};

// ---- xai / grok (UNVERIFIED): GET api.x.ai/v1/me (mostly account health) ----
const xaiAdapter: Adapter = {
	verified: false,
	async fetch(base, key, cred) {
		const authIndex = cred.auth_index as string;
		const body = await proxyCall(base, key, {
			authIndex, method: "GET", url: "https://api.x.ai/v1/me", header: { ...BEARER, accept: "application/json" },
		});
		const data = JSON.parse(body) as Record<string, unknown>;
		const p = toNum(data.usagePercent ?? data.usage_percent ?? data.creditUsagePercent);
		return p === null ? [] : [{ label: "usage", remainingPct: Math.max(0, 100 - p), resetIso: null }];
	},
};

const ADAPTERS: Record<string, Adapter> = {
	claude: claudeAdapter,
	antigravity: antigravityAdapter,
	gemini: antigravityAdapter,
	kimi: kimiAdapter,
	codex: codexAdapter,
	xai: xaiAdapter,
	devin: devinAdapter,
};

/** Guess which quota provider the current pi model routes to (by provider/id text). */
export function providerFromModel(model: { provider?: string; id?: string } | undefined): string | null {
	const provider = (model?.provider ?? "").toLowerCase();
	const s = `${provider} ${model?.id ?? ""}`.toLowerCase();
	// Provider prefix wins over model-family keywords: "devin/claude-sonnet-4-6"
	// routes to devin quota, not claude. Check devin/swe before claude/gemini.
	if (s.includes("devin") || s.includes("swe-") || s.includes("swe_")) return "devin";
	// The explicit route wins over the underlying model family (Claude/GPT-OSS).
	if (provider.includes("antigravity")) return "antigravity";
	if (s.includes("claude")) return "claude";
	if (s.includes("gemini") || s.includes("antigravity")) return "antigravity";
	if (s.includes("codex") || s.includes("gpt")) return "codex";
	if (s.includes("kimi")) return "kimi";
	if (s.includes("grok") || s.includes("xai")) return "xai";
	return null;
}

/** Select only the current model's Antigravity pool, leaving /quota details intact. */
export function windowsForModel(wins: Win[], model: { id?: string }): Win[] {
	const id = (model.id ?? "").toLowerCase();
	const group = id.startsWith("gemini-") ? "gemini"
		: /^(claude-|gpt-oss-)/.test(id) ? "claude-gpt" : null;
	if (!group) return [];
	return wins.filter(w => w.quotaGroup === group).sort((a, b) =>
		Number(shortTag(a.label) !== "5h") - Number(shortTag(b.label) !== "5h"));
}

/** Fetch and render quota for every known credential. Exported for test-quota.mjs. */
export async function collectQuota(
	base: string,
	key: string,
	now = Date.now(),
	prefer?: string | null,
	model?: { provider?: string; id?: string },
): Promise<{ blocks: string[]; footer: string }> {
	const creds = await listCredentials(base, key);
	const known = creds
		.filter((c) => ADAPTERS[providerKey(c)])
		.sort((a, b) => (providerKey(a) === "claude" ? 0 : 1) - (providerKey(b) === "claude" ? 0 : 1));
	if (known.length === 0) throw new Error("NO_CRED");
	const blocks: string[] = [];
	const summaries = new Map<string, string>(); // providerKey -> one-line summary
	const activeAntigravity = prefer === "antigravity" && model !== undefined;
	const antigravityAccounts = known.filter(c => providerKey(c) === "antigravity");
	for (const c of known) {
		const pk = providerKey(c);
		const adapter = ADAPTERS[pk];
		const who = c.email || c.label || c.name;
		const tag = adapter.verified ? "" : " (unverified)";
		try {
			const wins = await adapter.fetch(base, key, c);
			blocks.push(`● ${who} [${pk}]${tag}`);
			blocks.push(...renderWindows(wins, now));
			const footerWins = activeAntigravity && pk === "antigravity"
				? windowsForModel(wins, model) : wins;
			const s = summaryFromWins(footerWins, now);
			// We cannot infer which credential a load balancer will use.
			const ambiguous = activeAntigravity && pk === "antigravity" && antigravityAccounts.length !== 1;
			if (!ambiguous && s !== "Quota n/a" && !summaries.has(pk)) summaries.set(pk, s);
		} catch (err) {
			blocks.push(`● ${who} [${pk}]${tag}\n  failed: ${(err as Error).message}`);
		}
	}
	// Explicit Antigravity models must not fall back to an unrelated provider.
	// Preserve the existing fallback for other providers and legacy callers.
	// Tag the provider whenever it is not the current model's (or when several exist),
	// so a fallback never masquerades as the active provider's quota.
	const actual = activeAntigravity
		? (summaries.has("antigravity") ? "antigravity" : undefined)
		: prefer && summaries.has(prefer) ? prefer : [...summaries.keys()][0];
	const hit = actual !== undefined ? summaries.get(actual) : undefined;
	// Stamp the fetch time so a stale/frozen footer is visibly distinguishable
	// from live data that simply hasn't moved.
	const d = new Date(now);
	const stamp = `@${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	const footer =
		hit && actual
			? (summaries.size > 1 || actual !== prefer
				? hit.replace("Quota ", `Quota[${actual}] `)
				: hit) + ` ${stamp}`
			: "";
	return { blocks, footer };
}

// ---------- rendering ----------

export function formatReset(iso: string | null, now = Date.now()): string {
	if (!iso) return "—";
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "—";
	let ms = t - now;
	if (ms <= 0) return "resets now";
	const days = Math.floor(ms / 86_400_000);
	ms -= days * 86_400_000;
	const hours = Math.floor(ms / 3_600_000);
	ms -= hours * 3_600_000;
	const minutes = Math.floor(ms / 60_000);
	if (days > 0) return `resets in ${days}d ${hours}h`;
	if (hours > 0) return `resets in ${hours}h ${minutes}m`;
	return `resets in ${minutes}m`;
}

function bar(pct: number, width = 12): string {
	const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Build display lines for one credential's normalized windows. */
export function renderWindows(wins: Win[], now = Date.now()): string[] {
	if (wins.length === 0) return ["  (no quota window data)"];
	return wins.map((w) => {
		const remain = w.remainingPct;
		if (remain === null) return `  ${w.label.padEnd(22)} n/a · ${formatReset(w.resetIso, now)}`;
		const used = Math.max(0, 100 - remain);
		// suppress when the displayed value rounds to 100%: upstream slides resetTime
		// on untouched buckets (always now+window), so a countdown there is an illusion.
		const resetStr = Math.round(remain) >= 100 ? "—" : formatReset(w.resetIso, now);
		return `  ${w.label.padEnd(22)} ${bar(used)} ${used.toFixed(0)}% used · ${remain.toFixed(0)}% left · ${resetStr}`;
	});
}

function shortTag(label: string): string {
	const l = label.toLowerCase();
	if (l.includes("5h") || l.includes("5-hour") || l.includes("five")) return "5h";
	if (l.includes("weekly") || l.includes("7-day") || l.includes("7d") || l.includes("week")) return "7d";
	if (l.includes("daily") || l.includes("24h") || l.includes("day")) return "24h";
	return label.split(/[ ·(]/)[0];
}

/** Compact relative reset for the footer: " ↻1h44m", " ↻2d21h" ("" when unknown). */
function compactReset(iso: string | null, now: number): string {
	if (!iso) return "";
	const t = Date.parse(iso);
	if (Number.isNaN(t) || t <= now) return "";
	const ms = t - now;
	const d = Math.floor(ms / 86_400_000);
	const h = Math.floor((ms % 86_400_000) / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	if (d > 0) return ` ↻${d}d${h}h`;
	if (h > 0) return ` ↻${h}h${m}m`;
	return ` ↻${m}m`;
}

/** Compact one-line summary for the footer (first two windows). */
export function summaryFromWins(wins: Win[], now = Date.now()): string {
	const parts: string[] = [];
	for (const w of wins.slice(0, 2)) {
		if (w.remainingPct === null) continue;
		const rounded = Math.round(w.remainingPct);
		const reset = rounded >= 100 ? "" : compactReset(w.resetIso, now);
		parts.push(`${shortTag(w.label)} ${rounded}% left${reset}`);
	}
	return parts.length ? `Quota ${parts.join(" · ")}` : "Quota n/a";
}

// ---------- extension ----------

function isPrimaryUiSession(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

export default function (pi: ExtensionAPI): void {
	// Switching models switches the footer to that provider's quota immediately.
	pi.on("model_select", (_e, ctx) => {
		modelRevision++;
		if (isPrimaryUiSession(ctx)) ctx.ui.setStatus(QUOTA_KEY, undefined);
		lastFooterFetch = 0;
		refreshFooterThrottled(ctx);
	});

	// ----- /quota -----
	const QUOTA_KEY = "cliproxy-quota";
	let lastFooterFetch = 0;
	let modelRevision = 0;

	async function collectUsage(now: number, prefer?: string | null, model?: { provider?: string; id?: string }): Promise<{ blocks: string[]; footer: string }> {
		const base = resolveBaseUrl();
		const key = resolveManagementKey();
		if (!key) throw new Error("NO_KEY");
		return collectQuota(base, key, now, prefer, model);
	}

	// silent=true only refreshes the footer (used for auto-refresh during/after a turn).
	async function runQuota(ctx: ExtensionContext, silent = false): Promise<void> {
		const revision = modelRevision;
		const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		if (!silent) ctx.ui.notify("Fetching quota…", "info");
		try {
			const { blocks, footer } = await collectUsage(Date.now(), providerFromModel(model), model);
			if (!silent) ctx.ui.notify(`Subscription quota\n${blocks.join("\n")}`, "info");
			if (revision === modelRevision && isPrimaryUiSession(ctx)) {
				ctx.ui.setStatus(QUOTA_KEY, footer ? ctx.ui.theme.fg("dim", footer) : undefined);
			}
		} catch (err) {
			if (revision === modelRevision && isPrimaryUiSession(ctx)) ctx.ui.setStatus(QUOTA_KEY, undefined);
			if (silent) return;
			const msg = (err as Error).message;
			if (msg === "NO_KEY") {
				ctx.ui.notify(
					'Management key not found. Set CLIPROXYAPI_MANAGEMENT_KEY, or write {"managementKey":"..."} to ~/.pi/agent/cliproxyapi-quota.json, or make sure the EasyCLIProxyAPI GUI has a management-secret-key configured.',
					"error",
				);
			} else if (msg === "NO_CRED") {
				ctx.ui.notify(
					"No usable OAuth credential found (claude / codex / antigravity / gemini / kimi / xai).",
					"warning",
				);
			} else {
				ctx.ui.notify(`Failed to fetch quota: ${msg}`, "error");
			}
		}
	}

	// Auto-refresh footer: first turn start + each turn end, throttled to 60s, silent.
	function refreshFooterThrottled(ctx: ExtensionContext): void {
		if (!isPrimaryUiSession(ctx)) return;
		const now = Date.now();
		if (now - lastFooterFetch < 60_000) return;
		lastFooterFetch = now;
		void runQuota(ctx, true);
	}
	pi.on("before_agent_start", (_e, ctx) => refreshFooterThrottled(ctx));
	pi.on("agent_settled", (_e, ctx) => refreshFooterThrottled(ctx));

	// Works while streaming: shortcut fetches and shows quota immediately.
	pi.registerShortcut("ctrl+shift+q", {
		description: "Show subscription quota (all OAuth providers)",
		handler: (ctx) => runQuota(ctx),
	});

	pi.registerCommand("quota", {
		description: "Show subscription quota for all OAuth providers (via CLIProxyAPI)",
		handler: async (_args, ctx) => runQuota(ctx),
	});
}
