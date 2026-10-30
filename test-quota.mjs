// Live smoke test of the quota data path + pure renderers.
// Run: node test-quota.mjs
import { resolveBaseUrl, resolveManagementKey, collectQuota, renderWindows, summaryFromWins, formatReset, parseXaiBilling, footerLine, providerFromModel } from "./index.ts";

// formatReset unit checks
const now = Date.parse("2026-08-19T09:00:00Z");
console.assert(formatReset(null, now) === "—", "null reset");
console.assert(formatReset("2026-08-19T08:00:00Z", now) === "resets now", "past reset");
console.assert(/^resets in /.test(formatReset("2026-08-19T11:50:00Z", now)), "future reset");

// renderWindows / summaryFromWins unit checks
const wins = [
	{ label: "5-hour (session)", remainingPct: 64, resetIso: "2026-08-19T11:50:00Z" },
	{ label: "7-day (weekly)", remainingPct: 95, resetIso: "2026-08-25T03:00:00Z" },
];
console.assert(summaryFromWins(wins, now) === "Quota 5h 64% left ↻2h50m · 7d 95% left ↻5d18h", "footer");
console.assert(renderWindows(wins, now)[0].includes("36% used · 64% left"), "render used/left");

// 100% remaining should NOT display a countdown (avoids sliding resetTime illusion like ↻4h59m)
const fullWins = [
	{ label: "5-hour (session)", remainingPct: 100, resetIso: "2026-08-19T14:00:00Z" },
];
console.assert(summaryFromWins(fullWins, now) === "Quota 5h 100% left", "footer full quota");
console.assert(renderWindows(fullWins, now)[0].includes("100% left · —"), "render full reset");
// rounding hole: 99.96% displays as 100% and must also hide the (sliding) countdown
const nearFull = [
	{ label: "5-hour (session)", remainingPct: 99.96, resetIso: "2026-08-19T14:00:00Z" },
];
console.assert(summaryFromWins(nearFull, now) === "Quota 5h 100% left", "footer near-full quota");

// grok-4.6 via cliproxyapi must map to xai, not fall through to antigravity keywords
console.assert(providerFromModel({ provider: "cliproxyapi", id: "grok-4.6" }) === "xai", "grok-4.6 → xai");
console.assert(providerFromModel({ provider: "cliproxyapi", id: "gemini-3.8-flash-high" }) === "antigravity", "gemini → antigravity");
console.assert(providerFromModel({ provider: "cliproxyapi", id: "devin/claude-sonnet-4-6" }) === "devin", "devin/claude → devin");

// SuperGrok weekly billing: creditUsagePercent is *used* %; skip duplicate GrokBuild row
const xaiWins = parseXaiBilling(JSON.stringify({
	config: {
		currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-11-06T13:13:01.032+00:00" },
		creditUsagePercent: 19.0,
		productUsage: [{ product: "GrokBuild", usagePercent: 19.0 }],
	},
}));
console.assert(xaiWins.length === 1 && xaiWins[0].label === "weekly" && xaiWins[0].remainingPct === 81, "xai weekly remaining");
console.assert(xaiWins[0].resetIso?.startsWith("2026-11-06"), "xai weekly reset");
console.assert(parseXaiBilling(JSON.stringify({ user_id: "x", team_id: "y" })).length === 0, "v1/me is not quota");

// Footer must not substitute antigravity when the current model is grok
const mixed = new Map([["antigravity", "Quota 7d 91% left"]]);
const t = Date.parse("2026-10-30T14:55:00Z");
console.assert(footerLine(mixed, "xai", t).startsWith("Quota[xai] n/a"), "no antigravity stand-in for grok");
const grokOk = new Map([["antigravity", "Quota 7d 91% left"], ["xai", "Quota 7d 81% left"]]);
console.assert(footerLine(grokOk, "xai", t).includes("Quota[xai] 7d 81% left"), "grok footer uses xai");
console.assert(!footerLine(grokOk, "xai", t).includes("91%"), "grok footer ignores antigravity");

console.log("units OK:", summaryFromWins(wins, now));

const base = resolveBaseUrl();
const key = resolveManagementKey();
console.log("baseUrl:", base);
console.log("managementKey:", key ? key.slice(0, 6) + "…(" + key.length + " chars)" : "NONE");
if (!key) process.exit(1);

const { blocks, footer } = await collectQuota(base, key);
console.log("\n" + blocks.join("\n"));
console.log("\nfooter:", footer);
console.log("\nOK");
