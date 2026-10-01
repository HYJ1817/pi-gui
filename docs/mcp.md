# MCP（Pi 原生集成）

Pi GUI **使用 pi 原生的 MCP，不内置独立 MCP runtime**：不自己实现 MCP client、
不管理连接、不存 token。所有状态与动作都走 pi 官方的路，拿不到证据就保持
unknown，不猜。

核对对象：pi **0.99.2** 发布包（`docs/mcp.md`、`docs/cli.md` 的 MCP commands、
`dist/core/mcp-servers.d.ts`、`dist/extensions/mcp/{cli,config,runtime,tools}.d.ts`）。
历史验证基线 0.87.0 没有原生 MCP；上一轮基线 0.99.1 的差异见
[pi-compatibility](pi-compatibility.md) §0.99.1 → 0.99.2。

## 状态从哪来（三条官方路，不解析人类文本）

| 来源 | 内容 | 什么时候跑 |
|---|---|---|
| `pi mcp list --json` | 每台 server 的 state / tools / resources / error（官方结构化输出） | 只在 MCP 页点「刷新状态」时跑一次，60s TTL 缓存，**绝不轮询** |
| 两处 `mcp.json` 的安全结构解析 | 名 / scope / enabled / exposure / description / transport 类型 / toolExposure 键 | 随摘要自动读（只取结构） |
| 内置 probe + `get_commands` + settings | `builtin:mcp` 在不在包里、有没有扩展注册 `/mcp`、有没有 `-builtin:mcp` | 随摘要自动读 |

`pi mcp list` 的裸人类输出与 `/mcp` TUI 文本**绝不解析** —— 文案不是 API。
RPC 命令面在 0.99.1 与 0.99.2 上**逐字节相同**（`dist/modes/rpc/rpc-types.d.ts`
两版 diff 为空），仍然没有任何 MCP 管理/状态接口，所以也没有 RPC 路可走。

注意：`list --json` **会启动你配置的 stdio servers**（远端还会联网）——
这正是它只在用户手势时跑的原因。自动返回的永远是轻量摘要。

### `list --json` 的实测形状（0.99.2）

```jsonc
{
  "servers": [{
    "name": "docs", "scope": "global" | "project",   // CLI 只能产出这两个（见下）
    "source": "<配置文件绝对路径>",
    "enabled": true, "exposure": "codemode",
    "transport": "<命令串或 URL>", "state": "connected",
    "tools": ["read_file"],                       // MCP server 原始 tool.name
    "toolExposure": { "read_file": "direct" },    // 仅在确有覆盖时出现
    "resources": 3, "resourceTemplates": 1,       // 仅在该 server 提供资源时出现
    "error": "…"                                   // 仅在未 connected 且确实有错时出现
  }],
  "errors": ["…"],
  "note": "…"   // 仅当项目未信任且存在 <项目>/.pi/mcp.json 时出现
}
```

`source` / `transport` 都是**原文**（绝对路径 / 命令 / URL），Pi GUI 一个字节
都不投影 —— 只留 `transportType: 'stdio' | 'http'` 这个类型面。

### `scope`：类型上有三值，CLI 实际只产两个

`McpServerEntry.scope`（0.99.2 `src/extensions/mcp/config.ts`）的类型是
`"global" | "project" | "extension"`，但**只有前两个会出现在 `pi mcp list --json` 里**：

| 值 | 谁产生 | CLI 看得到吗 |
|---|---|---|
| `global` | `~/.pi/agent/mcp.json` | ✅ |
| `project` | `<项目>/.pi/mcp.json`（仅项目被信任时） | ✅ |
| `extension` | session 内的 MCP 扩展（`mcp/index.ts` 的 `registeredServers()` 走 `pi.getMcpServers()`，`pi.registerMcpServer()` 注册） | ❌ |

原因是上游明文：**Shell commands do not load extensions.**（0.99.2
`docs/mcp.md`；同页另有「`pi mcp` shell commands do not load extensions and
only see file-configured servers.」）。`pi mcp list --json` 走的是
`runMcpCommand` → `loadMcpConfig`，只读文件；扩展注册的 server 只活在
session/runtime 里，出现在 `/mcp` 管理器中，**不出现在 shell 输出里**。

所以：GUI 的 CLI 状态源**无法枚举 extension-registered servers**，RPC 也没有
已注册 MCP server 清单 —— 这一类 server 属于 **unknown / 不可枚举**边界
（GUI 不伪造它们）。

> 实现注记：`server/mcp-native.js` 的 `RUNTIME_SCOPES` 仍接受 `"extension"`，
> 那是**防御性前向兼容**（上游若哪天从 CLI 侧也报这个值，我们不会把它折成
> `null`），**不代表当前 CLI source 实际会产生它**。界面上的「扩展注册」标签
> 同理只在真的收到该值时才出现。

## 运行时投影：逐项 allowlist（不猜、不原样透传）

上游新增字段默认**丢弃**，未知枚举值折成中性值：

| 字段 | 规则 |
|---|---|
| `state` | 闭集 `connecting / connected / needs-auth / disconnected / disabled / failed / closed`（`runtime.d.ts` 的 `ServerState` + `list()` 合成的 `disabled`）。**闭集外 → `"unknown"`**，绝不把上游字符串原样放进 DOM |
| `scope` | 只认 `global`（映射为 `user`）/ `project` / `extension`（防御性前向兼容，见上），其余 → `null` |
| `exposure` | 只认 0.99.2 闭集 `codemode / deferred / direct / hidden`；别名 `codemode-deferred` → `codemode`；其余 → `null` |
| `transport` | 只留 `stdio` / `http` 类型面，**原文不进报告** |
| `tools` | **raw MCP tool name**（不是注册后的标识符）—— 见下节；单行化 + 限长 128 + 最多 200 条 |
| `toolExposure` | 键也是 raw tool name（单行化 + 限长），值必须是 exposure 枚举 |
| `resources` / `resourceTemplates` | 只接受非负整数，否则 `null` |
| `error` / `errors` / `note` | 截断 500 字符 + 已知路径脱敏 |
| `source` / `command` / `url` / `headers` / `env` / 其它未知键 | **一律不取** |

界面上不认识的 `state` 显示为「无法识别」，而不是打印上游原文。

### `tools`：raw MCP tool name ≠ 注册后的 Pi tool identifier

这是**两层完全不同的命名**，不能共用一条字符规则：

| | A. CLI 状态里的 `tools[]` | B. Tool Timeline 里的工具名 |
|---|---|---|
| 来源 | `connection.tools.map((t) => t.name)`（`mcp/cli.ts`） | `createMcpToolName(server, tool)`（`mcp/tools.ts`） |
| 是什么 | **MCP server 自己报的原始 tool name** | **注册为 Pi tool 后的标识符** |
| 形态 | 任意：`get-user`、`tool name`、`a/b`、`x:y`、`工具搜索`、`emoji-🔎` | `mcp__<server>__<tool>`，其中非 `[A-Za-z0-9_]` 全被换成 `_`（0.99.1 还保留 `-`），重名再挂 8 位 sha256 后缀 |
| GUI 处理 | 安全文本边界（见下） | `public/mcp-activity.js` 的前缀解析（**另一条路径，不共用正则**） |

**绝不能**拿 B 的标识符正则去过滤 A —— 那会把 `get-user`、`工具搜索` 这类完全
合法的 raw name 静默删掉，`toolCount` 也跟着失真。

raw tool name 的**安全文本边界**（`sanitizeMcpRawToolName`）：

1. 只接受 `string`（对象 / 数字 / 数组 / `null` 一律丢，不做 `String()` 转换）
2. 控制字符 → 空格（NUL / CR / LF / C0 / C1 / DEL 都挡掉，防多行与注入）
3. 折叠空白 + trim
4. 空串丢弃（清一色控制字符的名字没有可展示形态）
5. 超长**安全截断**（128 + `…`），不丢弃 —— 保留「server 确实报了这个工具」这个事实

**`toolCount` 的语义**：它是**上游事实** —— `tools` 里合法字符串项的**数量**，
**不因字符集或展示边界缩水**。`tools` 是有界的安全展示列表（≤200 条）。
极端情况下两者可以不等（例如一个纯控制字符的名字没有可展示形态），
这是有意的：**数量说事实，列表说能安全显示的部分**。
`tools` 不是数组时两者都是 `null`（不猜成空数组）。

界面上 `tools` 目前只用来算 `toolCount` 徽标，不逐条渲染。

## 原生状态机（只认证据）

- `active`：包里有 `builtin:mcp`、没被禁用、没被接管
- `replaced`：有扩展在 `get_commands` 里注册了 `/mcp`（`source:"extension"`，
  RPC 可见的唯一接管证据）—— session 内 pi 不再读 `mcp.json`
- `disabled`：settings 的 `extensions` 关了 `builtin:mcp`
- `unsupported`：包里就没有 `builtin:mcp`（0.87.0 就是这档）
- `unknown`：证据不足（包读不到或 pi 未应答），不断言

`packageDir` 证明不了时（launch identity 未知），状态 unknown、动作
unsupported —— 不退回裸 `pi`，那会命中另一份安装。

## 缓存与 workspace 隔离（P20.6-Fix）

`pi mcp list --json` 的结果与 `replaced` 结论都是**「当前 cwd + 当前这份 pi」**
的事实，不是进程级事实。所以两处缓存（runtime 状态、`get_commands` probe）
**都按 `(cwd, launch identity)` 复合键存**，读写前先算 key，key 不符即当没有缓存：

- **换项目** → cwd 变 → 上一个项目的 runtime 状态与 `replaced` 结论立即不可见，
  界面回到「尚未获取运行时状态」；再点刷新会真的重新跑一次 `pi mcp list --json`。
- **换 pi 实例**（改了 `PI_BIN` / 换了包）→ launch identity 变 → 旧结论同样作废，
  不会把「A 那份 pi 里 builtin:mcp 被接管」带到 B 上。
- **同一个 key 内**仍然保留 60s TTL —— 连点刷新不会重复启动用户的 stdio servers。
- **绝不后台轮询**；`reset()`（任何动作成功后）会同时清掉 runtime 与 command probe。

launch identity 用的是 `piLaunch.identityKey()` 返回的不透明哈希（`v1-<hex>`），
只参与内部比较，**永不进 API 响应 / Diagnostics / 日志**。

## 配置 scope（pi 原语，照搬）

- `~/.pi/agent/mcp.json`（用户级）与 `<项目>/.pi/mcp.json`（项目级）
- **项目同名覆盖用户级 —— 但只在项目被信任时**（见下节）
- 未信任项目的条目标 `未生效（项目未信任）`；信任状态拿不到时标
  `未生效（信任状态未知）`（fail closed，与 Skills 的信任闸门同一判定来源）
- `enabled: false` 保留条目不断连；非法条目 pi 跳过，界面列出 invalid 原因

### 覆盖关系受 trust 约束（P20.6-Fix-2 Blocker A）

上游依据（v0.99.2 `src/extensions/mcp/config.ts` 的 `loadMcpConfig`）：

```ts
readConfigFile(join(agentDir, "mcp.json"), "global", state);          // 总是读
if (projectTrusted) readConfigFile(join(cwd, CONFIG_DIR_NAME, "mcp.json"), "project", state);
```

两份都往**同一个 `Map<name, entry>`** 里 `set`，所以「项目同名覆盖用户级」
**只在项目被信任时才发生**。未信任时项目文件被整个忽略，用户级那条**照旧生效**。

| trust | 用户级 `github` | 项目级 `github` |
|---|---|---|
| `true` | `overridden`（不生效） | 生效 |
| `false` | **照常生效**（不被覆盖） | `未生效（项目未信任）` |
| `null`（拿不到） | **照常生效**（不被覆盖） | `未生效（信任状态未知）` |

**「项目文件里有没有这个 key」≠「用户级那条被覆盖了」。** 覆盖也是 effective
truth，和「项目条目能不能生效」受同一个 trust 约束。实现上：

- `readConfigs()` **只产出文件事实**（有哪些 server、scope、配置结构），
  **不产出 `overridden`** —— 那时还不知道 trust；
- `summary()` 拿到 `tr` 之后才用 `projectTrusted(tr)` 算出
  `loadableProjectNames`，用户级条目的 `overridden` 由它决定；
- 未信任 / 未知时这个集合是**空的**，所以不可能出现「用户级被一个不会被加载的
  项目项覆盖掉」这种两个都不生效的状态。

### 只有「Pi 会接受并加载的 entry」才参与覆盖（P20.6-Fix-3）

上游 `readConfigFile` 对 `validateMcpServerConfig` 返回错误的条目 `errors.push` 后
**`continue`** —— 该条目被跳过，**从不进入那个 `Map`**，因此不会 `set`、也就不会
覆盖全局同名项。所以：

> **被 Pi 拒绝的 project entry 不覆盖全局同名项**，全局那条保留并继续生效。

关键点：`parseMcpServers()` **完整复刻了上游 `validateMcpServerConfig()` 的接受/拒绝
判定**（不是「结构看起来像」）。只要 GUI 的 parser 比上游**宽**，一个上游会拒绝、
而 GUI 认为合法的项目条目就会被算进覆盖集合 —— 用户级被标 `overridden`、项目那条
又被上游跳过，**两条都不生效**。这是覆盖 bug 最隐蔽的变体，所以这里逐条对齐：

| 上游规则（`src/core/mcp-servers.ts`） | GUI 是否复刻 |
|---|---|
| 名字 `/^[A-Za-z0-9_-]+$/`（**不限长度**） | ✅ |
| 条目必须是对象 | ✅ |
| `exposure` 必须在闭集（别名先归一） | ✅ |
| `toolExposure` 必须是 record 且**每个值**都在闭集 → 否则**整条拒绝** | ✅ |
| `enabled` 必须是 boolean | ✅ |
| `description` 必须是 string | ✅ |
| `timeout` 必须是正数 | ✅ |
| `type === "sse"` 明确拒绝（legacy SSE 不支持） | ✅ |
| `url` 必须是可解析的 http/https | ✅ |
| `headers` 必须 string→string | ✅ |
| `oauth` 走 `validateOAuth`（`clientId` / `clientSecret` 是 string；`callbackPort` 是 1–65535 整数；`callbackUrl` 必须是 loopback http 且无 query/fragment，端口要与 `callbackPort` 一致；`scope` 是 string；`clientName` 是非空 string） | ✅ |
| `auth` 必须是 `{provider: 非空 string}`，且 URL 为 https（或 loopback http） | ✅ |
| `args` 必须是 string[] | ✅ |
| `env` 必须 string→string | ✅ |
| `cwd` 必须是 string | ✅ |
| 两条分支都不成立 → 拒绝 | ✅ |
| **namespace 冲突**：`mcpNamespace(other) === mcpNamespace(name)` 且 `other !== name` → 后者被拒 | ✅ |
| **`auth` 不允许出现在项目文件**（`scope === "project"` 且 HTTP 且带 `auth`） | ✅ |

两个**与直觉相反**但上游确实如此的细节（已用测试钉住）：

- `{command, url}` **同时存在**时上游按 **HTTP 接受**（HTTP 分支优先），不是「只能二选一」。
- `type` 是未知值时两条分支的 guard 都不成立 → 落到最后的「needs either command or url」拒绝。

**namespace 冲突的判据是累积的**，与上游读取顺序一致：先读 global 并接受，
再读 project，此时 project 里的条目要同时避开 **global 已接受的名字**与
**同文件内已接受的名字**。同名（`github` vs `github`）**不是**冲突 —— 那正是覆盖。

GUI 侧的判定因此不用「原始 JSON key 是否存在」，而用 `parseMcpServers` 认可的
`projectServers`。整个项目文件读不出来（坏 JSON）时同理：一个都不覆盖。

> 唯一的**有意偏严**之处：GUI 的 `add` / `remove` **动作入参**额外限制 64 字符
> （输入侧防御）。配置解析用的是上游规则、**不限长度** —— 配置判定不会因此误拒。

### 项目信任（P20.6-Fix）

上游实测（0.99.2 `dist/extensions/mcp/cli.js`）：`runMcpCommand` 在 `add` / `remove`
两条分支上**直接返回，不查 project trust**；只有 `list` / `login` / `logout`
才读 `ProjectTrustStore`。也就是说 `pi mcp add -l` 会照写未信任项目的
`.pi/mcp.json` —— 这条产品安全边界得由 GUI 自己立。

| 规则 | 行为 |
|---|---|
| project scope 的 `add` / `remove` | 只有 `trusted === true` 才落到 pi CLI |
| `trusted === false` | 不执行，返回 `project-untrusted`，`runCli` 调用 **0 次** |
| 信任状态拿不到（`null`）或 `readTrust` 抛异常 | 同样 fail closed，`project-untrusted` |
| user scope 的 `add` / `remove` | **不受影响** |
| 项目 `.pi/settings.json` 的 `-builtin:mcp` | 只在 `trusted === true` 时参与判定；未信任 / 未知时忽略，不据此下结论 |

信任真值来源仍然只有一处：注入的 `readTrust`（`server/skills.js` 的
`readTrustState`，与 Skills / extension-registry 同一个），本模块不复制第二套。

## 安全：凭据值不进 Pi GUI（P20.6-Fix）

- `env` / `headers` / `oauth` / `auth` 的**值一个字节都不进报告**，只记「有没有」
- transport 原文（命令路径 / URL）、配置文件的绝对路径不进 renderer
- `mcp-auth.json` 的 token **绝不读**；错误文本截断 500 字符并脱敏已知路径
- **MCP 添加接口只接受「不含 secret value」的配置**，后端防御式校验：

| 被拒字段 | 结果 |
|---|---|
| `headers[].value` / `headers[].key` | `secret-input-unsupported`（`field: "headers[].value"`） |
| `env[].value` / `env[].key`、裸 `env` 对象 | `secret-input-unsupported` |
| `oauth`（整块：`clientSecret` / `clientId` / `callbackPort` / …） | `secret-input-unsupported` |
| `auth`（0.99.2 的 provider token 引用） | `secret-input-unsupported` |
| `token` / `accessToken` / `refreshToken` / `bearerToken` / `apiKey` / `secret` / `password` / `authorization` | `secret-input-unsupported` |

被拒时：**不调用 `runCli`**，错误文案只带**字段名**、绝不回显值，并指引用户
改用官方 `pi mcp add` 或手工编辑 pi 的 `mcp.json`。

为什么必须堵在源头：`runCli` 的 `pi-error` 分支会把 pi 的 stderr 尾巴回显进
错误文案。我们无法假设 pi 永远不会回显敏感 argv —— 既然 GUI 不再传 secret
argv，这条风险就不存在了，而不是靠「响应里不打印」。

**唯一保留的引用字段**是 `bearerTokenEnvVar`：只传**变量名**，
argv 里是 `--bearer-token-env-var GITHUB_TOKEN`，pi 把它写成
`Authorization: Bearer ${GITHUB_TOKEN}`，值由 pi 在运行时从环境里取，
从不经过 renderer / HTTP / GUI 进程。

页内「添加」表单**只有无凭据字段**；含凭据的配置请走终端 `pi mcp add`
（支持 `${VAR}` 与 `!command` 引用）或直接编辑文件。

## 动作（只代理官方 CLI）

| 动作 | 路径 | 说明 |
|---|---|---|
| 刷新状态 | `pi mcp list --json` | 显式手势，60s 缓存（按 workspace 分键） |
| 添加 | `pi mcp add`（stdio / http，`--exposure` / `--description` 可选） | 显式确认 + workspace stale 守卫 + **project trust 闸门**；同名替换（pi 原语） |
| 移除 | `pi mcp remove` | 显式确认 + **project trust 闸门**；**OAuth 凭据保留**（pi 原语），清凭据走 logout |
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

0.99.2 的闭集是 `codemode`（默认） / `deferred` / `direct` / `hidden`，
外加 per-tool `toolExposure`（精确名优先于 pattern）。
`codemode-deferred` **只是 `codemode` 的输入别名**，pi 解析时会归一 ——
所以运行时报告里看到的永远是 `codemode`。显示的是**配置值**，
不猜当前 session 实际暴露 —— 实际走 `tool_search` / `codemode` 加载。

0.99.2 起 `codemode` 的工具不再列进 codemode 描述、也不再阻塞首次提示词；
server 改为出现在系统提示词的 `mcp_servers` 段，脚本用 `searchTools()` /
`describeNamespace()` 找工具。GUI 不重新实现这些机制。

关系：`codemode` 脚本可调所有非 hidden 工具；`tool_search` 可加载任何
deferred 工具；`hidden` 不可调。

## MCP Tool Activity

`mcp__<server>__<tool>` 调用继续走 Pi Tool Timeline（实时与历史同一渲染路径），
加一个通用语义适配器（`public/mcp-activity.js`，tool-view 链第 5 个）：
只显示 server、tool、运行状态；**不展示完整 args / result**；
annotations（`readOnlyHint` 等）未经 RPC 暴露，**不猜**；
未知 MCP tool 走安全 generic fallback，server 加 tool 不会让 UI 崩。

**命名规则在 0.99.2 变了**：pi 把名字里除 `[A-Za-z0-9_]` 之外的字符全部换成 `_`
（0.99.1 还保留 `-`），重名再挂 8 位 sha256 后缀。所以 `my-server` 的工具名是
`mcp__my_server__x` —— 名字里的 server 段不再等于配置里的 server 名，界面按
工具名如实显示、不反推。GUI 的解析接受两版并集（`[A-Za-z0-9_-]`），
连哪个版本都不会把行显示成「未知工具」。

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

扩展可用 `pi.registerMcpServer(name, config)` 注册 server：与 session 同寿，
`mcp.json` 里的同名项优先（被覆盖的注册项会在 `/mcp` 里列出来）。

**`pi mcp list --json` 看不到这些 server。** 上游明文：

> Shell commands do not load extensions.（0.99.2 `docs/mcp.md`）
> `pi mcp` shell commands do not load extensions and only see file-configured servers.

`pi mcp list --json` 走 `runMcpCommand` → `loadMcpConfig`，只读
`mcp.json`；而 `scope: "extension"` 是**session 内**的 MCP 扩展在
`registeredServers()` 里赋的（走 `pi.getMcpServers()`），只在 `/mcp` 管理器里出现。

因此扩展来源的 servers 在 GUI 里是 **unknown / 不可枚举**（文档记录，不伪造）：

- CLI 状态源只可能产出 `global` / `project`；
- RPC 也没有已注册 MCP server 清单（33 条命令，0.99.1 / 0.99.2 各确认一次）；
- 唯一的例外是**接管 `/mcp` 的扩展** —— 那条有证据（`get_commands` 里
  `source:"extension"` 的 `/mcp`），对应 native 状态机的 `replaced`。

`server/mcp-native.js` 的 `RUNTIME_SCOPES` 保留 `"extension"` 只是**防御性
前向兼容**，不表示当前 CLI source 会产出它（详见上文「`scope`：类型上有三值，
CLI 实际只产两个」）。

## 相关测试

```bash
npm run test:mcp    # tests/mcp-native.cjs（187 条，纯 fixture，完全离线）
```

覆盖：**上游 validateMcpServerConfig 逐条对拍**（接受集合 ⊆ Pi 接受集合）、
cache/workspace 隔离、**project trust 覆盖语义**（trusted / untrusted /
unknown 三态 + 非法条目 + 坏文件）、**raw MCP tool name 安全投影**（连字符 /
空格 / Unicode / emoji / 控制字符 / 超长 / 非字符串 / toolCount 语义）、
**两层命名边界**（CLI raw vs Timeline registered）、secret API contract、
0.99.2 fixture/schema、unknown enum fallback，以及安全解析、入口派生、
scope/状态机、list 合并与脱敏、动作 argv 与校验、stale、unsupported、
语义投影与运行观察。
`test:ui`（smoke）另有 MCP 标签页的界面行为（状态横幅、server 行、刷新/移除/
添加 wiring、trust 提示、workspace 隔离文案、unsupported 声明、无凭据字段）。

**live MCP 测试本轮未执行**（不进 CI）。真机流程（手工）：配一个本地 stdio
fixture server → 打开 MCP 页 → 刷新状态见 connected + 工具数 → 调一次工具见
Timeline 语义行 → logout 清理。不要用真实远端 server，不要 OAuth 真登录。
