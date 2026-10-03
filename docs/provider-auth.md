# 供应商与认证（P25）

Provider 描述模型来源与可用认证方法；Auth 描述 **Pi 确认的本地状态**。
「已连接（本机凭据）」只表示 Pi 确认保存了 OAuth 登录，不证明远端账户仍有效，
也不证明下一次模型请求一定成功。API Key 配置证据同样不等于账户认证成功。
未知字段保持 `null`，界面显示「未知（无法确认）」。

## 原生入口与身份

本机 Pi 1.0.0 的公开 `ModelRuntime` 提供 `getProviders`、`listCredentials`、
`checkAuth`、`login`、`logout`。聊天 RPC 没有 login/logout 命令；GUI 不模拟它们。
`server/provider-auth-sdk.js` 只从主聊天 Pi 已证明的 launch identity 解析同一安装包
根公开 export，再由隔离 worker 调用 SDK。没有公开 API 时降级为官方交互式
`pi` 的 `/login <provider>`、`/logout` 说明，不读取 `auth.json` 原文。

方法来自 Pi descriptor。`openai` 支持 ChatGPT 订阅 OAuth 和 API Key；
`openai-codex` 保留为 legacy OAuth 入口。GUI 不复制 OAuth 协议常量，
callback、PKCE、凭据保存和 token refresh 均归 Pi 管理。

## 用户级认证流程

`server/provider-auth.js` 维护单个用户级 flow，独立于项目与 Composer 模型代次。
快照为 `{ok, capability, providers, flow, sync}`；descriptor 只包含白名单元数据、
本地凭据三值、方法与模型摘要。flow 带 `id`、`generation`、`revision`，
交互另带 prompt ID，旧回复不能应答新步骤。

`GET /api/provider-auth` 刷新快照。POST 子路由为：

| 路由 | 请求字段 | 行为 |
|---|---|---|
| `/login` | `providerId`, `authType: "oauth"` | 开始 Pi 原生 OAuth |
| `/logout` | `providerId` | 移除 Pi 保存的认证 |
| `/respond` | `flowId`, `promptId`, `value` | 应答当前授权回复或方法选择 |
| `/cancel` | `flowId` | 取消当前流程 |
| `/sync` | 无 | 重试聊天 Pi 与模型状态同步 |

状态闭集为 `starting`、`waiting-browser`、`waiting-device-code`、`waiting-input`、
`verifying`、`success`、`cancelled`、`failed`。URL、设备码、授权回复、方法选择、
取消与超时都有明确阶段；错误和进度采用固定文案，不回显 SDK 原始消息。
面板关闭仅卸载视图，重新打开仍能继续当前流程。SDK prompt 自行取消时，
GUI 清除过期输入并等待 Pi 回调。

## 凭据边界与聊天同步

环境变量凭据会进入 Pi 进程及它启动的 bash/其它命令，包括
`OPENAI_API_KEY`、`OPENROUTER_API_KEY`、`ANTHROPIC_API_KEY`。
这支持环境变量 Provider 认证，不意味着 API Key 对工具不可见。
建议使用最小权限、受限额度的 key，并信任执行工具的工作区。
`PI_GUI_TOKEN` 继续必须从 Pi 子进程环境剥离。Pi GUI 不从 Provider/Auth 配置、
认证状态或 Diagnostics 主动投影 key 原文。工具若主动读取并输出这些变量，
Pi 的 `tool_execution_end` / tool result 可将其作为普通工具输出返回，继而可能
进入 Pi 会话、模型上下文、SSE 和 GUI 工具结果（DOM）。当前没有承诺对任意工具
输出做通用 secret redaction。
SDK worker 的秘密隔离不改变 Pi 工具对继承环境的访问权限。

token 与 SDK 返回凭据只存在私有 worker，worker stdout/stderr 丢弃，
不进入 HTTP、SSE、DOM、诊断、日志或草稿。授权链接必须通过安全 URL 检查。
秘密输入不进入 renderer；API Key 原文应在官方 Pi `/login` 配置，
自定义模型配置只允许环境变量引用。既有磁盘密钥保留，但不回显。

登录、退出、取消或失败后都重新读 Pi 状态，不能凭 Promise 成功推断凭据已保存。
随后安全重载聊天 Pi 并保留当前会话；任务正在运行时延迟到空闲后同步，
同步失败提供重试。模型、当前选择与思考档位继续由聊天 RPC 回读，认证 adapter
不替 Composer 选择模型。相同 launch identity 的项目切换或重启不重启认证；
安装包身份变化使旧 flow 失效。

Pi 更新、扩展安装或受控 CLI 已在进行时不启动新认证；认证在飞时也不允许开始
更新或安装。聊天任务本身不阻止登录，认证后的重载等待任务空闲。
同步期间暂时拒绝新的聊天命令，项目切换仍可进行；跨项目的同步结果会失效并重试。
`PI_NO_SESSION` 或无法回读非空 `sessionFile` 时不自动重启，显示同步未确认，
避免用 `--continue` 切到其它历史会话。API Key 远端有效性与 OAuth 远端有效性均未主动验证。

退出只移除保存的凭据，环境变量或自定义配置仍可能提供认证。
测试与离线视觉入口见 [testing.md](testing.md)。

## 实现文件

| 范围 | 文件 |
|---|---|
| 原生认证与回读 | `server/provider-auth-sdk.js`、`server/provider-auth.js`、`server/provider-auth-runtime.js` |
| 后端接线与安全出口 | `server.js`、`server/router.js`、`server/providers.js`、`server/rpc-bridge.js` |
| 前端 | `public/provider-auth.js`、`public/providers.js`、`public/api.js`、`public/usage.js`、`public/styles.css` |
| 离线认证测试 | `tests/provider-auth.cjs`、`tests/provider-auth-runtime.cjs` |
| 已有回归与视觉 | `tests/smoke.cjs`、`tests/models-api.cjs`、`tests/capability-install.cjs`、`tests/visual-harness.cjs`、`tests/cdp-shot.cjs` |
| 测试入口 | `package.json` |
| 文档 | `README.md`、`docs/architecture.md`、`docs/security.md`、`docs/testing.md`、`docs/provider-auth.md` |
| 实施记录 | `docs/superpowers/specs/2026-10-03-provider-auth-design.md`、`docs/superpowers/plans/2026-10-03-provider-auth.md` |
