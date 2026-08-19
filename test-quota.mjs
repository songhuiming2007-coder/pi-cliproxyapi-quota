// Live smoke test of the quota data path + pure renderers.
// Run: node test-quota.mjs
import { resolveBaseUrl, resolveManagementKey, renderUsage, summaryLine, formatReset } from "./index.ts";

// formatReset unit checks
const now = Date.parse("2026-08-19T09:00:00Z");
console.assert(formatReset(null, now) === "—", "null reset");
console.assert(formatReset("2026-08-19T08:00:00Z", now) === "可刷新", "past reset");
console.assert(/后$/.test(formatReset("2026-08-19T11:50:00Z", now)), "future reset");
console.log("formatReset:", formatReset("2026-08-19T11:50:00Z", now), "|", formatReset("2026-08-25T03:00:00Z", now));

const base = resolveBaseUrl();
const key = resolveManagementKey();
console.log("baseUrl:", base);
console.log("managementKey:", key ? key.slice(0, 6) + "…(" + key.length + " chars)" : "NONE");
if (!key) process.exit(1);

const auth = await (await fetch(`${base}/v0/management/auth-files`, { headers: { Authorization: `Bearer ${key}` } })).json();
const claude = (auth.files ?? []).filter((f) => (f.provider === "claude" || f.type === "claude") && !f.disabled && f.auth_index);
console.log("claude creds:", claude.map((c) => c.email || c.name));

for (const c of claude) {
	const out = await (await fetch(`${base}/v0/management/api-call`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			authIndex: c.auth_index,
			method: "GET",
			url: "https://api.anthropic.com/api/oauth/usage",
			header: { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" },
		}),
	})).json();
	const usage = JSON.parse(out.body);
	console.log(`\n● ${c.email || c.name}`);
	console.log(renderUsage(usage).join("\n"));
	console.log("footer:", summaryLine(usage));
}
console.log("\nOK");
