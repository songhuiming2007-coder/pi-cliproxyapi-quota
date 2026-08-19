# pi-cliproxyapi-quota

[![npm version](https://img.shields.io/npm/v/pi-cliproxyapi-quota.svg)](https://www.npmjs.com/package/pi-cliproxyapi-quota)
[![license](https://img.shields.io/npm/l/pi-cliproxyapi-quota.svg)](./LICENSE)

**English** | [中文](#中文说明)

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

---

## 中文说明

适用于通过 [CLIProxyAPI / EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI)
把 Claude 订阅接入 [pi](https://pi.dev) 的用户。它补上了 pi 对反向代理模型不暴露的两件事：

1. **额度** — 在 pi 里直接看 Claude 订阅的 **5 小时**与**周**限额。
2. **思考强度** — `/think` 命令 + footer 常驻显示当前推理档位。

### 功能

| 触发 | 作用 |
|---|---|
| `/quota` | 显示 5 小时 / 周（及其它）配额窗口：已用 %、剩余 %、重置倒计时。 |
| `Ctrl+Shift+Q` | 同 `/quota`，但**模型正在输出时也能按**（快捷键，不会被排队）。 |
| footer `Quota 5h 64% left · 7d 95% left` | 显示剩余 %，与 EasyCLIProxyAPI 面板一致；每轮开始/结束自动刷新（60s 节流）。 |
| `/think [level]` | 查看/设置思考强度（`off/minimal/low/medium/high/xhigh/max`，受模型能力限制）。 |
| footer `🧠 high` | 常驻显示当前思考强度（原生 `Shift+Tab` 也能循环切换）。 |

取数链路与 EasyCLIProxyAPI 控制面板完全一致：代理管理 API `POST /v0/management/api-call`
用你存储的 Claude OAuth 凭证代理请求 `GET https://api.anthropic.com/api/oauth/usage`。
该端点只报告用量，不消耗额度。

### 安装

```bash
pi install npm:pi-cliproxyapi-quota
# 或从 git：
pi install git:github.com/songhuiming2007-coder/pi-cliproxyapi-quota
```

或把本地目录的路径加到 `~/.pi/agent/settings.json`：

```json
{ "extensions": ["/absolute/path/to/pi-cliproxyapi-quota/index.ts"] }
```

安装后 `/reload` 重载 pi。

### 配置

本包不存储任何密钥，运行时解析：

**Base URL**（代理）：`CLIPROXYAPI_BASE_URL` → `~/.pi/agent/cliproxyapi.json` 的 `baseUrl` → `http://127.0.0.1:8317`

**管理密钥**（`/quota` 必需），按顺序：
1. 环境变量 `CLIPROXYAPI_MANAGEMENT_KEY`
2. `~/.pi/agent/cliproxyapi-quota.json` 的 `{ "managementKey": "..." }`
3. EasyCLIProxyAPI GUI 的 `config.toml`（`management-secret-key`），按系统自动定位：
   - macOS：`~/Library/Application Support/com.cpa.gui/config.toml`
   - Linux：`$XDG_CONFIG_HOME/com.cpa.gui/config.toml`
   - Windows：`%APPDATA%\com.cpa.gui\config.toml`

不用 GUI 的话，设置 `CLIPROXYAPI_MANAGEMENT_KEY`（需与代理的 `remote-management.secret-key` 一致）或用上述 JSON 覆盖。

### 范围与限制

- v0.1 只覆盖 **Claude** 订阅窗口。Codex / Antigravity 用量端点不同，尚未实现 — 欢迎 PR。
- 仅读取本地管理密钥去调本机管理 API；除了你自己的代理和（经代理的）Anthropic 用量端点，不向任何地方发送数据。

### 许可证

MIT
