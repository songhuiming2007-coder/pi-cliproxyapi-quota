# pi-cliproxy-quota

pi 扩展。解决两件事：

1. `/quota`（别名 `/额度`）：在 pi 里直接查看 CLIProxyAPI 背后 Claude 订阅的 **5 小时额度**与**周额度**（以及其它可用配额窗口）。数据链路与 EasyCLIProxyAPI 客户端一致：调用代理管理 API `POST /v0/management/api-call`，让代理用你的 Claude OAuth 凭证代理请求 `https://api.anthropic.com/api/oauth/usage`。
   - **`Ctrl+Shift+Q`** 快捷键：模型正在跑的时候也能按，直接弹额度（快捷键走 TUI 事件循环，不受排队影响）。
   - footer 自动刷新：会话首轮开始 + 每轮结束时静默拉取一次（60s 节流），常驻显示 `额度 5h xx% · 周 xx%`，工作中随时可瞟。
2. `/think [档位]`：显式查看/设置当前模型的思考强度（pi 原生也可用 `Shift+Tab` 循环）。并在 footer 常驻显示当前思考档位。

## 目录约定

- `index.ts` —— 扩展主体（唯一源文件，pi 直接以 TS 加载）。
- 不引入任何运行时第三方依赖；只用 Node 内置模块 + 全局 `fetch`。
- 对 `@earendil-works/*` 只做 `import type`（编译期擦除，运行时不解析），避免脱离 node_modules 时解析失败。

## 凭据纪律（重要）

- 管理密钥（`management-secret-key`）**绝不写入本仓库任何文件**。运行时按以下顺序解析：
  1. 环境变量 `CLIPROXYAPI_MANAGEMENT_KEY`
  2. `~/.pi/agent/cliproxyapi-quota.json` 的 `managementKey` 字段（可选覆盖）
  3. EasyCLIProxyAPI GUI 的 `~/Library/Application Support/com.cpa.gui/config.toml` 里的 `management-secret-key`（默认来源）
- base URL 解析：环境变量 `CLIPROXYAPI_BASE_URL` → `~/.pi/agent/cliproxyapi.json` 的 `baseUrl` → `http://127.0.0.1:8317`。

## 挂载方式

在 `~/.pi/agent/settings.json` 的 `extensions` 数组加入本目录的 `index.ts` 绝对路径，重启 pi（或 `/reload`）。

## 验证

- `node --experimental-strip-types test-quota.mjs`（或直接用 `curl` 打管理 API）确认取数逻辑；
- pi 内 `/quota` 有额度输出、`/think high` 能改档位即为通过。

## 范围

- 当前只实现 Claude 订阅的配额窗口（用户订阅即 Claude）。Codex/Antigravity 的配额端点不同，暂不覆盖，需要再加。
