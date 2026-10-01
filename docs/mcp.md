# MCP（Pi 原生集成）

Pi GUI **使用 pi 原生的 MCP，不内置独立 MCP runtime**：不自己实现 MCP client、
不管理连接、不存 token。所有状态与动作都走 pi 官方的路，拿不到证据就保持
unknown，不猜。

核对对象：pi **0.99.1** 发布包（`docs/mcp.md`、`docs/cli.md` 的 MCP commands、
`dist/core/mcp-servers.d.ts`、`dist/extensions/mcp/`）。历史验证基线 0.87.0
没有原生 MCP（见 [pi-compatibility](pi-compatibility.md) §〇）。

## 状态从哪来（三条官方路，不解析人类文本）

| 来源 | 内容 | 什么时候跑 |
|---|---|---|
| `pi mcp list --json` | 每台 server 的 state / tools / error（官方结构化输出） | 只在 MCP 页点「刷新状态」时跑一次，60s TTL 缓存，**绝不轮询** |
| 两处 `mcp.json` 的安全结构解析 | 名 / scope / enabled / exposure / transport 类型 / toolExposure 键 | 随摘要自动读（只取结构） |
| 内置 probe + `get_commands` + settings | `builtin:mcp` 在不在包里、有没有扩展注册 `/mcp`、有没有 `-builtin:mcp` | 随摘要自动读 |

`pi mcp list` 的裸人类输出与 `/mcp` TUI 文本**绝不解析** —— 文案不是 API。
RPC 33 条命令里没有 MCP 管理/状态接口（0.99.1 已再次确认），所以也没有
RPC 路可走。

注意：`list --json` **会启动你配置的 stdio servers**（远端还会联网）——
这正是它只在用户手势时跑的原因。自动返回的永远是轻量摘要。

## 原生状态机（只认证据）

- `active`：包里有 `builtin:mcp`、没被禁用、没被接管
- `replaced`：有扩展在 `get_commands` 里注册了 `/mcp`（`source:"extension"`，
  RPC 可见的唯一接管证据）—— session 内 pi 不再读 `mcp.json`
- `disabled`：settings 的 `extensions` 关了 `builtin:mcp`（项目覆盖用户）
- `unsupported`：包里就没有 `builtin:mcp`（0.87.0 就是这档）
- `unknown`：证据不足（包读不到或 pi 未应答），不断言

`packageDir` 证明不了时（launch identity 未知），状态 unknown、动作
unsupported —— 不退回裸 `pi`，那会命中另一份安装。

## 配置 scope（pi 原语，照搬）

- `~/.pi/agent/mcp.json`（用户级）与 `<项目>/.pi/mcp.json`（项目级）
- 项目同名覆盖用户级；项目文件只在项目被信任后才被 pi 读取
- 未信任项目的条目标 `未生效（项目未信任）`（与 Skills 的信任闸门同一判定）
- `enabled: false` 保留条目不断连；非法条目 pi 跳过，界面列出 invalid 原因

## 安全：凭据值不进 Pi GUI

- `env` / `headers` / `oauth` 的**值一个字节都不进报告**，只记「有没有」
- transport 原文（命令路径 / URL）、配置文件的绝对路径不进 renderer
- `mcp-auth.json` 的 token **绝不读**；错误文本截断 500 字符并脱敏已知路径
- 页内「添加」表单**只有无凭据字段**；含 `env` / `headers` / OAuth 的配置
  请走终端 `pi mcp add`（支持 `${VAR}` 与 `!command` 引用）或直接编辑文件

## 动作（只代理官方 CLI）

| 动作 | 路径 | 说明 |
|---|---|---|
| 刷新状态 | `pi mcp list --json` | 显式手势，60s 缓存 |
| 添加 | `pi mcp add`（stdio / http，`--exposure` 可选） | 显式确认 + workspace stale 守卫；同名替换（pi 原语） |
| 移除 | `pi mcp remove` | 显式确认；**OAuth 凭据保留**（pi 原语），清凭据走 logout |
| 登录 | `pi mcp login --timeout`（默认 120s，上限 180s） | OAuth 全程 pi 负责；超时给终端指引 |
| 退出登录 | `pi mcp logout` | 删掉 pi 存的 OAuth 凭据 |

enable / disable / reconnect / 改 exposure **没有** shell 接口，只能在 pi 的
`/mcp` 管理器（TUI）里做 —— 界面如实说明，不伪造这些开关。

所有动作都经 `server/agents/cli.js` 的 `runCli`（`shell:false` + args 数组，
server 名严格校验），入口从 launch identity 派生（与 bridge 同一份包）。

## OAuth 边界

- pi 负责：注册 client、开浏览器、127.0.0.1 回调、存 `mcp-auth.json`、自动刷新
- SSH 等浏览器不在本机时，按 pi 提示把 redirect URL 粘贴回登录界面
- 会话内的 select / input 经 P19 的 extension_ui 管道自动承接（mcp 扩展只用
  `notify` / `select` / `input`，无需新代码），见 [approvals](approvals.md)
- Pi GUI 不读、不缓存、不复制任何 access token / refresh token / clientSecret

## Tool exposure（只显示，不实现）

`codemode`（默认） / `codemode-deferred` / `deferred` / `direct` / `hidden`，
外加 per-tool `toolExposure`（精确名优先于 pattern）。显示的是**配置值**，
不猜当前 session 实际暴露 —— 实际走 `tool_search` / `codemode` 加载。

关系：`codemode` 脚本可调所有非 hidden 工具；`tool_search` 可加载任何
deferred 工具；`hidden` 不可调。GUI 不重新实现 tool search。

## MCP Tool Activity

`mcp__<server>__<tool>` 调用继续走 Pi Tool Timeline（实时与历史同一渲染路径），
加一个通用语义适配器（`public/mcp-activity.js`，tool-view 链第 5 个）：
只显示 server、tool、运行状态；**不展示完整 args / result**；
annotations（`readOnlyHint` 等）未经 RPC 暴露，**不猜**；
未知 MCP tool 走安全 generic fallback，server 加 tool 不会让 UI 崩。

资源工具（`list_mcp_resources` / `list_mcp_resource_templates` /
`read_mcp_resource`）同样走 Timeline（server / uri 安全摘要）。
`ui://` 与 MCP Apps pi 本身不渲染，GUI 也不渲染。

运行观察（`public/mcp-capabilities.js`）：当前 bridge run 内真实调用过的
server（按 server 聚合），切项目/重启清零。观察到只说明调用过，
不构成「已配置」的证据。

## Permission（自动生效，不另起一套）

pi 原文：Every MCP call goes through pi's tool pipeline —— 所以 `tool_call` /
`tool_result` 扩展处理器（含 permission gate）对 MCP 工具自动生效，
P19 的审批卡片照常弹出。GUI **不按工具名猜危险程度**，没有真实审批请求
就不画 Allow / Deny。annotations 未经 RPC 暴露，只在这里记录，不显示。

## Extension 注册的 servers（诚实边界）

扩展可用 `registerMcpServer` 注册 server（与 session 同寿，`mcp.json` 同名优先）。
`pi mcp` shell 命令不加载扩展所以看不见它们；RPC 也没有已注册 server 清单。
因此扩展来源的 servers 在 GUI 里是 unknown（文档记录，不伪造）——
唯一的例外是接管 `/mcp` 的扩展（见上面的 replaced）。

## 相关测试

```bash
npm run test:mcp    # tests/mcp-native.cjs（52 条，纯 fixture，完全离线）
```

覆盖：安全解析、入口派生、scope/信任/状态机、list 合并与脱敏、动作 argv 与
校验、stale、unsupported、secret 不回显、语义投影与运行观察。
`test:ui`（smoke）另有 MCP 标签页的界面行为（状态横幅、server 行、刷新/移除/
添加 wiring、unsupported 声明、无凭据字段）。

真机流程（手工，不进 CI）：配一个本地 stdio fixture server → 打开 MCP 页 →
刷新状态见 connected + 工具数 → 调一次工具见 Timeline 语义行 → logout 清理。
不要用真实远端 server，不要 OAuth 真登录。
