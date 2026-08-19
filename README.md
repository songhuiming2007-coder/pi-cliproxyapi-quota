# pi-cliproxyapi-quota

A [pi](https://pi.dev) extension for users who route their Claude subscription into pi through
[CLIProxyAPI / EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI).

It adds two things pi doesn't surface for reverse‑proxied models:

1. **Quota** — see your Claude subscription **5‑hour** and **weekly** limits without leaving pi.
2. **Thinking level** — a `/think` command and a footer indicator for the active reasoning effort.

## Features

| Trigger | What it does |
|---|---|
| `/quota` | Show 5h / weekly (and other) quota windows: used %, remaining %, reset countdown. |
| `Ctrl+Shift+Q` | Same as `/quota`, but works **while the model is streaming** (it's a shortcut, not a queued command). |
| footer `Quota 5h 64% left · 7d 95% left` | Remaining %, matching the EasyCLIProxyAPI panel. Auto‑refreshed at the start/end of each turn (throttled to 60s). |
| `/think [level]` | Show or set thinking level (`off/minimal/low/medium/high/xhigh/max`), clamped to the model. |
| footer `🧠 high` | Always‑visible current thinking level (native `Shift+Tab` also cycles it). |

The quota data path mirrors the EasyCLIProxyAPI control panel exactly: the proxy management API
`POST /v0/management/api-call` proxies a `GET https://api.anthropic.com/api/oauth/usage` using your
stored Claude OAuth credential. This endpoint reports utilization; it does not consume quota.

## Install

```bash
pi install npm:pi-cliproxyapi-quota
# or from git:
pi install git:github.com/songhuiming2007-coder/pi-cliproxyapi-quota
```

Or load a local checkout by adding its path to `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/absolute/path/to/pi-cliproxyapi-quota/index.ts"] }
```

Reload pi (`/reload`) after installing.

## Configuration

No secrets are stored in this package. At runtime it resolves:

**Base URL** (proxy): `CLIPROXYAPI_BASE_URL` → `~/.pi/agent/cliproxyapi.json` `baseUrl` → `http://127.0.0.1:8317`

**Management key** (required for `/quota`), in order:
1. env `CLIPROXYAPI_MANAGEMENT_KEY`
2. `~/.pi/agent/cliproxyapi-quota.json` → `{ "managementKey": "..." }`
3. EasyCLIProxyAPI GUI `config.toml` (`management-secret-key`), auto‑located per‑OS:
   - macOS: `~/Library/Application Support/com.cpa.gui/config.toml`
   - Linux: `$XDG_CONFIG_HOME/com.cpa.gui/config.toml`
   - Windows: `%APPDATA%\com.cpa.gui\config.toml`

If you don’t run the GUI, set `CLIPROXYAPI_MANAGEMENT_KEY` (must match your proxy's
`remote-management.secret-key`) or the JSON override.

## Scope & limitations

- v0.1 covers **Claude** subscription windows. Codex / Antigravity use different usage endpoints
  and are not implemented yet — PRs welcome (see repo issues).
- Reads a local management key to call the localhost management API; nothing is sent anywhere except
  your own proxy and Anthropic's usage endpoint (through that proxy).

## License

MIT
