# 与 pi 的兼容性

P19 的 approval 只依赖 Pi 已有的两个真实机制：`tool_call` hook 可返回
`{ block: true }`（`dist/core/extensions/types.d.ts` 的 `ToolCallEventResult`、
`docs/extensions.md` 的「Can block」），以及 RPC 模式下对话框方法发出的
`extension_ui_request` 会**阻塞等待** `extension_ui_response`（`docs/rpc.md`）。
> **基线说明**：这段的原始核对对象是 **0.87.0**；P20.5 在 **0.99.1** 上重新核对过 ——
> `ToolCallEventResult` 的字段集合与语义两个版本**完全一致**（`block?` / `reason?` /
> `terminate?`；`terminate` **0.87.0 就有，不是 0.99 新增的**），
> 9 个 `extension_ui_request` 方法一字不差。
> 「核心没有自带审批弹窗」在 0.99.1 上同样成立（0.99.1 的 `docs/usage.md` 里
> 那句「不含 permission popups」虽然被删了，但代码里依旧没有任何审批闸门）。
> `ctx.ui.custom()` 在 RPC 下返回 `undefined` —— 0.99.1 的 `docs/rpc-extension-ui.md`
> 明确列出这一条。GUI 不实现权限策略，只如实呈现与本机能力报告。
> 见 [Approvals](approvals.md)。

P18 按 pi-memory 0.4.2 的发布 tarball 接入 prompt-side 工具：
memory_write / memory_read / memory_search / memory_forget / memory_restore /
memory_status / scratchpad（名字不加前缀，来自 `pi.registerTool`）。
长期记忆是 **global-only**（`PI_MEMORY_DIR` 或 `~/.pi/agent/memory`），
源码里没有 project/cwd scope；qmd 是可选外部依赖，只有 memory_search 需要。
GUI 不读 memory 目录、不管理 qmd、不实现检索，只投影 allowlist 字段。
⚠️ **（0.87.0 的历史事实，0.99.1 已变）** pi 0.87.0 只把 execute 抛异常标成
`isError`，Extension 在 result 里返回的 `isError: true` 到不了 `tool_execution_end`；
因此缺结构化字段时降级为「结果不可用」，不猜失败。**这条在 0.99.1 上不再成立**
（见本页 §〇 的 `isError` 行为变化），但「只认结构化证据」的策略不变 ——
它本来就不依赖 `isError`。见 [Pi Memory](memory.md)。

P17 按 pi-subagents 0.73.1 的真实工具契约接入，parent-side 名字为 subagents_enable/bg_wait/subagent_supervisor/subagent。
Pi 0.86.1+ fresh unrestricted parent 初始前三项 active；subagent registered but inactive，loader 后在后续模型请求激活。Supervisor 不依赖 loader。
不增加 Pi 核心能力假设；dynamic loader 与实际 child 调用分别记录。
当前顶层 tasks/parallel/chain 已移除，workflow 使用 workflowScript；缺失 model/child relation 降级 unknown。
历史仍复用 toolCall/toolResult，不扫描 child transcripts，见 [Subagents](subagents.md)。

P16 的 Web tool adapter 按 Pi 0.87.0 的 tool_execution_start/update/end 与
历史 toolCall/toolResult 对接；partialResult 是累积输出，identity 为 toolCallId。
> 0.99.1 的 `dist/modes/json-event.d.ts` 与 0.87.0 **逐字节相同**，所以这套对接
> 在新版本上不需要改。见本页 §〇。
当前公开 pi-web-access 0.33.0 schema 已核对，但 GUI 不加载其代码或依赖。
RPC 不提供 registered tool list，P15 capabilityRegistry.tools 继续为空/未知
（0.99.1 已再次确认：33 条 RPC 命令里没有工具清单命令）。
独立 runtimeObserved 仅记录当前 bridge run 的真实调用，重启或切项目后归零。
工具来源不从工具名反推；未知名字继续 generic fallback。见 [Web Access](web-access.md)。

Pi GUI 是 pi 的界面，**不是 pi 的一部分**。这份文档讲清两者的边界、
Pi GUI 依赖 pi 的哪些能力、哪些能力缺失时可以降级、以及 pi 升级后怎么验。

代码在 [`server/pi-compat.js`](../server/pi-compat.js)。

## 〇、四个「版本」不是一回事（P20.5）

上一轮出过一个具体的错：文档里写着「pi 0.87.0 没有原生 MCP，而且是有意为之」，
用户机器上却装着 0.99.1（**它自带 `builtin:mcp`**）。一句话把四件事混成了一件。
现在把它们分开，**每一处都说清自己在讲哪一个**：

| | 是什么 | 谁决定 | 在哪看 |
|---|---|---|---|
| **历史验证基线** | P15–P19 当时的验收对象：**0.87.0** | 已固定的历史事实，不会变 | 各 feature 文档的「当时基线」句 |
| **当前验证基线** | P20.6-Fix 实测并写进测试的对象：**0.99.2** | 本轮的核对结果 | 本节 + `tests/pi-version.cjs` |
| **运行中版本** | 你这台机器上**实际跑的那个 pi** | 由 `server/pi-version.js` 探测 | Extensions 页 MCP 标签页 / Diagnostics |
| **未知能力** | 探测拿不到证据的能力 | 一律 `unknown`，**不猜** | 同左 |

**运行中版本**是一个规范状态，不是一个字符串：

```js
{ value: '0.99.2', source: 'package.json', status: 'known', updatedAt: '2026-10-01T03:00:00.000Z' }
```

- `source`：`'package.json'`（读**与 bridge 实际启动的那个入口绑定**的 pi 包，
  **首选**）· `'pi --version'`（兜底：包目录证明不了时，对**同一个 launch spec**
  跑一次探测）· `'none'`。
  包目录由 `server/pi-launch.js` 给：按 `PI_BIN` / PATH 解析出入口文件，再向上找
  属于它的包。**证明不了就留空** —— 不退回「常见全局安装位置」清单，那条旁路正是
  「探测读到的是另一份 pi」的来源（P20.5 Blocker A）。见
  [architecture.md](architecture.md) 的 launch identity。
- `status`：`'known'` · `'malformed'`（读到了、但它不是一个版本号）· `'unknown'`。
- **版本号只作线索，不作判据。** 能力判定一律走 probe 或真实事件 ——
  `server/pi-builtins.js` 读的是 pi 包的源码文本，`server/pi-compat.js` 看的是
  实际收到的 response / event 形状。

### 0.87.0 → 0.99.1 的实际差异（逐项核对过）

对照物：npm 上 `@earendil-works/pi-coding-agent` 的 **0.87.0** 与 **0.99.1**
发布 tarball（`gitHead` 分别是 `16787ad5…` / `d86654ab…`），逐文件比对。

| 面 | 0.87.0 | 0.99.1 | 结论 |
|---|---|---|---|
| **RPC 命令集** | 33 条 | 33 条 | **完全一致**，一条没加 |
| **`extension_ui_request` 方法集** | 9 个 | 9 个 | **完全一致** |
| **`dist/modes/json-event.d.ts`** | — | — | **逐字节相同** |
| **`get_commands` 实现** | 扩展命令 + prompt 模板 + `skill:<name>` | 同左 | **完全一致** |
| **built-in extensions** | 只有 `llama.cpp`（`hidden: true`） | `llama.cpp` + `codemode` + `tool-search` + `mcp`（都 `builtin: true`，后三个 `replaceable: true`） | **新增三个** |
| **ExtensionAPI 方法** | — | 新增 `getSettings` / `registerMcpServer` / `unregisterMcpServer` / `getMcpServers` / `registerVirtualModel` / `unregisterVirtualModel` | **新增六个**（`getExposure` / `getNamespace` 属 `ToolLoadout`，**不是** ExtensionAPI） |
| **ExtensionAPI 事件** | — | 新增 `mcp_servers_change` / `provider_stream_event` | **新增两个**（其余 39 个一致） |
| **`ToolCallEventResult`** | `block?` / `reason?` / `terminate?` | **同左** | **无变化**（`terminate` **不是** 0.99 新增） |
| **工具返回值里的 `isError`** | **被硬编码丢弃**（`return { result, isError: false }`） | **会传播**（`return { result, isError: result.isError === true }`） | ⚠️ **行为变化**，见下 |
| **`getAllTools()`** | **已有** | 已有 | ⚠️ **不是新能力**（任务描述里把它列为新增，这条要修正） |
| **`docs/usage.md` 的「不内置 MCP」** | 有 | **已删除** | 旧文案的出处已经不存在了 |
| **`docs/mcp.md`** | 无 | 有（配置格式 + `pi mcp add/remove`） | 新增 |

**最重要的结论：RPC 面（命令 / 事件 / UI 方法）在 0.87 → 0.99 之间没有任何漂移。**
所以 Pi GUI 现有的 RPC 集成不需要迁移；需要改的是**说法**（哪些是历史事实、
哪些是当前事实）与**新增能力的表示**（built-ins）。

### 0.99.1 → 0.99.2 的实际差异（P20.6-Fix 逐项核对过）

对照物：npm 上 `@earendil-works/pi-coding-agent` 的 **0.99.1** 与 **0.99.2**
发布 tarball，逐文件比对。**这一节只讲 MCP 相关面**，因为本轮核对范围就是它。

| 面 | 0.99.1 | 0.99.2 | 对 Pi GUI 的影响 |
|---|---|---|---|
| **RPC 命令集**（`dist/modes/rpc/rpc-types.d.ts`） | 33 条 | **33 条，diff 为空** | 无变化；**仍然没有 MCP 管理/状态接口** |
| **`pi mcp list --json` 实现**（`mcp/cli.js` 的 `list()`） | — | **逐字节相同** | 输出形状未变 |
| **CLI 子命令** | add / remove / list / login / logout | **同左** | 无变化（enable / disable / reconnect 仍无 shell 接口） |
| **`ServerState`**（`mcp/runtime.d.ts`） | `connecting / connected / disconnected / needs-auth / failed / closed` | **同左** | 无变化（GUI 的 allowlist 加 `list()` 合成的 `disabled`） |
| **`McpExposure`** | `codemode \| codemode-deferred \| deferred \| direct \| hidden` | **`codemode \| deferred \| direct \| hidden`**；`codemode-deferred` 降为**输入别名** | GUI 两版都认，但一律归一成 `codemode`（运行时报告里只会是规范值） |
| **工具命名** | `mcp__<server>__<tool>`，保留 `-`（`[^A-Za-z0-9_-]` → `_`） | **`[^A-Za-z0-9_]` → `_`**，重名再挂 8 位 sha256 后缀 | ⚠️ **名字会变**（`my-server` → `my_server`）；GUI 解析接受两版并集 |
| **server `description`** | 无 | 新增（`pi mcp add --description`） | 只读展示（单行、限长）；**API 可接收**，界面不新增输入框 |
| **`oauth.clientName`** | 无 | 新增（`pi mcp add --oauth-client-name`） | GUI 一律拒收 `oauth`（凭据面） |
| **`auth: { provider }`** | 无 | 新增（HTTP server 用 provider 的 `/login` token；**不允许出现在项目 mcp.json**） | GUI 一律拒收；`hasSecrets` 把它算进凭据面 |
| **`list --json` 新字段** | — | `resources` / `resourceTemplates`（数字）、`toolExposure`（覆盖项）、`note`（项目未信任时） | allowlist 接收；`note` 脱敏后显示 |
| **built-in extensions** | `llama.cpp` + `codemode` + `tool-search` + `mcp` | **同左**（`mcp` 仍 `replaceable: true`） | 无变化 |
| **`pi mcp add` / `remove` 的 trust 行为** | **不查 project trust**（直接写文件） | **同左**（未变） | ⚠️ GUI 必须自己立 project trust 闸门（P20.6-Fix） |
| **`pi mcp login` 默认超时** | 300s | 300s | 无变化（GUI 总是显式传 `--timeout`，用自己的更短上限） |

**结论：0.99.1 → 0.99.2 没有改变 Pi GUI 依赖的任何「协议形状」**（RPC 面、
`list --json` 形状、CLI 子命令、状态闭集、built-in 清单都一致）。变的是
**MCP 配置层的词汇表与命名规则**，以及**两个新的凭据面字段**——前者要求
GUI 归一化与兼容解析，后者要求 GUI 把它们纳入「拒绝接收」的清单。

### P20.6-Fix-2：两处**我们自己读错**的 0.99.2 契约

下面两条**不是**上游版本变化，是 pi-GUI 早先对同一份 0.99.2 源码的误读。
记录在这里，避免下次又按文档反证自己。

| 误读 | 上游事实（v0.99.2 源码） | 影响 |
|---|---|---|
| 「项目同名 server 覆盖用户级」是无条件的 | `loadMcpConfig` **只在 `projectTrusted` 时**才 `readConfigFile(project)`；两份写进同一个 `Map<name, entry>` ⇒ 覆盖**只在信任时成立** | 未信任项目里出现同名项时，GUI 曾把用户级也标成 `overridden`，导致**两条都不生效** |
| `pi mcp list --json` 的 `tools[]` 是注册后的 Pi tool identifier | 它是 `connection.tools.map((t) => t.name)` —— **MCP server 原始 tool.name**；`createMcpToolName()` 的 `[^A-Za-z0-9_]` → `_` 是**注册期**的另一层 | GUI 曾用标识符正则过滤 raw name，把 `get-user`、`工具搜索` 这类合法名字静默删掉，`toolCount` 跟着失真 |

核对方式：直接读 GitHub tag `v0.99.2` 的
`packages/coding-agent/src/extensions/mcp/{cli,config,tools}.ts` 与
`src/core/mcp-servers.ts`（不是读 pi-GUI 自己的文档）。

### ⚠️ 唯一一条真实的行为变化：工具返回值里的 `isError`

| | 代码 | 效果 |
|---|---|---|
| **0.87.0** | `executePreparedToolCall` 返回 `{ result, isError: false }`（硬编码） | Extension 在工具结果里放的 `isError: true` **被丢弃**；`tool_execution_end.isError` 只反映「抛异常 / 被阻断 / 参数校验失败」 |
| **0.99.1** | 返回 `{ result, isError: result.isError === true }` | Extension 自己返回的 `isError: true` **会传播到** `tool_execution_end.isError` |

对照物：`@earendil-works/pi-agent-core` 的 `dist/agent-loop.js`（0.87.0 第 556 行 vs
0.99.1 第 579 行），两个版本都从 npm 发布包取。

**对 Pi GUI 的影响：** P18 与 P20 定的策略是「**只认结构化证据**」——
success 必须由 result 的 `details` 证明，不靠 `isError` 推断。这条策略在两个版本下
都成立，所以**不需要改代码**；但：

- P18 文档里那句「pi 0.87.0 不传播 Extension 的 isError」是**历史事实**，
  在 0.99.1 上**已经不成立**（已就地标注）；
- 在 0.99.1 上，Extension 明确返回 `isError: true` 时，时间线会如实显示为失败 ——
  这是**上游自己的判断**，不是 GUI 猜的；
- 结构化证据与 `isError` 冲突时，仍然以 `details` 为准（P20 的
  `details.ok === false` 优先于 `isError`）。

### 仍然没有的东西（明确记录，不从新功能反推）

- **RPC 没有「已注册工具清单」命令。** 33 条命令里没有一条返回它。
  `ExtensionAPI.getAllTools()` 是**扩展进程内**的 API，RPC 客户端拿不到 ——
  两者不能混为一谈。所以 `capabilityRegistry.tools` 继续是空 / 未知，
  **GUI 不伪造工具注册表**（`/api/mcp` 的 `rpc.toolListCommand === false` 就是这条判据）。
- **RPC 没有 MCP 管理命令。** 增删改走 pi 自己的 CLI（`pi mcp add` / `pi mcp remove`）
  与 `mcp.json`，不走 RPC。P20.6 之前 Pi GUI 不碰它们。
- **built-in 扩展不是「用户装的 extension」。** 它们编译在 pi 包里
  （`dist/extensions/`），Extension Registry 的目录扫描**扫不到也不该扫**。

## 一、边界在哪

```
   Pi GUI（本仓库）                     pi（外部程序，本机安装）
   ├─ Electron 窗口                     ├─ 自己管模型供应商与密钥
   ├─ HTTP + SSE 后端                   ├─ 自己的配置文件（~/.pi/agent/）
   ├─ 项目 / 会话列表 / 文件变更          ├─ 自己的会话文件（JSONL）
   ├─ Planner 编排（**自己的**，不是 pi 的）└─ `pi --mode rpc`
   └─ 全部 UI
                    │
                    └─── 唯一的集成边界：**RPC**（stdio 上的 JSONL）
```

- **RPC 是唯一边界。** Pi GUI 通过 `pi --mode rpc` 的子进程 stdio 说话：
  每行一个 JSON 对象；命令写进 stdin，事件与应答从 stdout 出来。
  **没有插件、没有 monkey patch、不 fork pi、不改 pi 的任何文件。**
- **会话文件是第二条（只读的）边界。** 会话列表与搜索要扫
  `<agentDir>/sessions/`，所以会话 JSONL 的形状也算集成面。Pi GUI **只读**它，
  归档 / 删除这些动作只动 Pi GUI 自己的目录。
- **Planner / 多 Agent 不是 pi 的能力。** pi 没有原生 sub-agent、没有 plan mode，
  那是 Pi GUI 自己做的编排层。所以兼容报告里**不会**出现「pi 支持 planner」
  这种说法 —— 它区分的是「Pi GUI 的能力」与「pi 的能力」。

## 二、我们依赖哪些能力

兼容报告里的九个能力，来自代码里**实际用到**的东西（不是照抄一份理想清单）：

| 能力 | 对应什么 | 用在哪儿 |
|---|---|---|
| `rpc` | 能 spawn `pi --mode rpc` 并收发 JSONL | 全部功能的前提 |
| `getState` | `get_state` 应答里有 `sessionFile` | 当前会话指针、模型 / 思考档位显示、归档与删除的「当前会话」判断 |
| `getMessages` | `get_messages` 能返回消息数组 | 历史重建、刷新后恢复对话 |
| `newSession` | `new_session` | 「新对话」 |
| `switchSession` | `switch_session` | 切换会话、搜索结果跳转 |
| `sessionNaming` | `set_session_name`（+ 会话文件里的 `session_info.name`） | 给会话改名 |
| `toolEvents` | `tool_execution_start` / `_update` / `_end` | Tool Timeline；P16/P17/P18/P20 四个语义适配器都只依赖它 |
| `extensionUi` | `extension_ui_request` / `extension_ui_response` | pi 扩展向用户提问时的选择框 |
| Extension commands | `get_commands` 中 `source:"extension"` 及 `sourceInfo.path` | P15 已加载命令的来源证据；拿不到时保持未知 |
| `sessionJsonl` | 能认出会话文件（header 里的 `id` / `cwd`） | 会话列表、搜索、归档 / 删除 |

## 三、核心能力 vs 可降级能力

**核心（缺了整个集成就不成立）**：`rpc`、`getState`。
缺任何一个 → 状态判为 `incompatible`。

**其余都可降级**（缺了就局部停用对应功能，聊天照常）：

| 能力缺失 | 降级成什么 |
|---|---|
| `getMessages` | 对话区留一条「无法读取历史消息…」的说明，而不是一片空白 |
| `switchSession` | 侧栏会话行不给点（淡一档 + 悬停说明原因），搜索结果的点击也拦住并提示；**当前会话的聊天不受影响** |
| `sessionNaming` | 藏起改名入口（不做一个按了没反应的按钮） |
| `toolEvents` | Tool Timeline 缺 `tool_execution_end` 的条目显示成「未完成」（虚线圆），**不会一直停在「运行中」** |
| `extensionUi` | pi 扩展的提问框不出现；对话本身不受影响 |
| Extension commands | 扩展列表仍可只读发现候选项，加载与 capability 显示未知；聊天不受影响 |
| `sessionJsonl` | 会话列表 / 搜索降级（列不出来），当前会话的 RPC 不受影响 |

> `toolEvents` 的降级不是靠兼容层「判死」，而是**结构性**的：pi 崩溃 / 中断时
> 本来就可能收不到 `tool_execution_end`，所以 `agent_settled` 一收尾，
> 还挂着的条目就会被收成「未完成」。见
> [architecture.md](architecture.md#六前端渲染管线)。

## 四、怎么判断兼容 —— 版本号只是证据

**不要**用版本号判兼容：

```js
// ✗ 错的
if (semverGte(piVersion, '0.90')) compatible = true;
```

理由：

- 同一个版本号可能有不同的构建差异（打包方式、可选的编译特性）；
- 新版本通常仍兼容旧协议；
- **fork / 自定义实现**可能版本号完全不同，却完全兼容 RPC。

所以判定依据只有两条：**实际观察到的 response 形状** + **实际观察到的事件**。

### 三值能力：未验证 ≠ 不支持

每个能力有三种状态：

| 值 | 含义 | 怎么来的 |
|---|---|---|
| `true` | 观察到能用 | 收到了成功的 `get_state` 应答 / 见到了已知事件 / 会话文件解析成功 |
| `false` | **观察到不能用** | pi 明确回 `success:false`；或 spawn 失败 / 从未 ready 就退出 |
| `null` | 还没观察到 | 还没用到那个能力 |

⚠️ **「没观察到」绝不当成「不存在」。** 一个会话里没有 `session_info` 只说明那次
没改过名，不代表 pi 不支持改名 —— 所以文件侧的观察**只能把能力置 `true`**，
`false` 只由明确的失败产生。

这也是验收里那条对称要求的落点：**读不到 pi 版本号 ≠ 不兼容**。
版本读不到只是 `versionKnown: false`，状态照旧按能力判。

### 状态怎么派生

```
incompatible —— 某个核心能力被证实不可用（rpc / getState）
partial      —— 有非核心能力被证实不可用（局部降级）
compatible   —— 至少一个核心能力已证实可用，且没有已知缺失
unknown      —— 还没观察到足够证据（例如还没启动过 pi）
```

## 五、没有 handshake 协议（故意的）

pi 的 RPC 没有版本协商。**不为它造一个协议** —— 兼容证据全部来自现有链路里
本来就会发生的事：

- **收到 pi 的合法消息** → `rpc` = true（那才证明通道真的通了）
- spawn 报错 → `rpc` = false；**起来之后一句话没说就退出** → 也是 false

> ⚠️ `bridge_status: ready` **本身不算证据**。Windows 上 pi 是经 shell 启动的，
> 而 cmd.exe 对**不存在的命令「启动是成功的」** —— 会先报「不是内部或外部命令」
> 再退出，`ready` 照发。只看 ready 会把这种情况判成「兼容」，
> 所以判据是「说过话」。
- 启动时会问 `get_state`、`get_messages`（前端 boot + 会话列表）→ 顺带收集
- 列会话时扫会话文件 → 顺带收集 `sessionJsonl` / `sessionNaming` 的形状证据
- pi 有任何事件上来 → 顺带收集 `toolEvents` / `extensionUi`

所以兼容层是**被动累积**的，它**自己不发任何请求**：不产生模型调用、
不花额度、不改 session、不增加启动延迟。全部证据来自本机，**不联网**
（不查 npm registry / GitHub / 官网）。

## 六、异常记录（有上限、不含 payload）

探测到协议异常时记一条结构化记录，环形缓冲**最多 20 条**，**只记结构**：

```json
{ "at": 1758800000000, "category": "response", "operation": "get_state",
  "issue": "missing-field", "field": "sessionFile" }
```

**禁止**记录原始 payload。这条是硬规矩：诊断报告可能被贴进 issue，
用户正文、prompt、模型回复、密钥一个字节都不能进去。所以：

- 对象 → 只记**键名**（截断、过滤非法字符）
- 数组 → 只记长度
- 其余 → 只记 `typeof`

异常类别：

| category | 什么情况 |
|---|---|
| `envelope` | 半条 JSONL / 不是对象 / 没有 `type` / 应答没有 `command` |
| `response` | 命令被拒（`command-failed`）/ 应答缺了我们依赖的字段（`missing-field`） |
| `event` | **未知事件**（见下） |
| `session-file` | header 认不出来 / 消息体只在顶层 / 坏行 |
| `bridge` | spawn 失败 / 从未 ready 就退出 / ready 之后意外退出 |

## 七、未知字段 / 未知事件的策略

**未知字段 → 忽略，不算异常。** pi 给应答加字段是兼容的加法，Pi GUI 只取自己
要的那几个。测试 fixture E 覆盖这一条。

**未知事件 → 安全忽略，但留一条可见记录。**
前端的事件分发是 `switch (evt.type)` + `default: return` —— 不抛、不重置 bridge、
不清当前会话、不影响 SSE 连接。同时兼容层会记一条 `unknown-event`
（带上事件名），于是 **pi 哪天加了新事件，Diagnostics 里看得见**，
而不是「静默地什么都没发生」。

两者都有专门的回归守卫（`tests/smoke.cjs` 的「未知事件」两段）。

## 八、会话 JSONL 的兼容策略

会话文件是只读的，形状按「**宽松读取、严格归属**」处理：

| 变化 | 策略 |
|---|---|
| 消息体嵌在 `message` 下（pi 的真实形状） | ✅ 支持 |
| 消息体直接摆在顶层（旧 / 自定义形状） | ✅ 也支持（多一层兜底） |
| 出现不认识的条目类型 | 忽略该行，不当坏文件 |
| 出现不认识的 content block | 只取 `type === 'text'` 的，其余忽略 |
| **新增未知字段** | 忽略 |
| 某一行是坏 JSON / 被截断 | 跳过那一行；文件仍可用 |
| header 读不出来 / 没有 `cwd` | 这个文件跳过（**只有它自己受影响**），并计入诊断的 `skipped` |
| 单文件超大 | 只读前 4 MB（列表）/ 8 MB（搜索），标 `truncated` |

**归属判定只认 header 里的 `cwd`** —— 目录名只用来缩小扫描范围。所以 pi 以后
改了目录命名规则也不会让我们把两个项目的对话串起来。

判断消息体形状的那段逻辑**只有一处**（`pi-compat` 的 `sessionMessageBody`），
`sessions.js` 与 `session-search.js` 共用；前端 `public/tree.js` 因为跨进程
另有一份等价实现。

## 九、在 Diagnostics 里怎么看

侧栏底部「诊断」→「Pi 兼容性」区：

```
Pi 兼容性
  Pi 版本        0.87.0
  兼容状态       正常
  RPC           支持
  会话状态       支持
  历史消息       支持
  新会话        支持
  会话切换       支持
  会话重命名      支持
  Tool Events   支持
  扩展 UI       支持
  会话文件       支持
```

- 状态是 `partial` / `incompatible` 时用警示色；`unknown` 用弱化色。
- **未验证**的能力显示「未验证」而不是「不支持」—— 那只是还没用到。
- 有缺失时下面会列出**缺少能力（对应功能已降级）**。
- 有协议异常时列出最近 5 条（操作名 · 问题类型 · 字段名），并在 JSON 里给全量。

「脱敏后的诊断 JSON」里的 `compatibility` 段就是完整报告：

```json
{
  "detected": true, "version": "0.87.0", "versionKnown": true,
  "status": "compatible",
  "capabilities": { "rpc": true, "getState": true, "getMessages": true,
                    "newSession": true, "switchSession": true, "sessionNaming": null,
                    "toolEvents": null, "extensionUi": null, "sessionJsonl": true },
  "missing": [], "unverified": ["sessionNaming", "toolEvents", "extensionUi"],
  "protocol": { "expected": 1, "observed": 1 },
  "issues": []
}
```

> `protocol` 是 **Pi GUI 自己的期望标记**（应答信封该长什么样），不是 pi 声明的
> 版本号 —— pi 的 RPC 没有版本协商。`observed` 在第一次看到合法信封时置为同一个值。

## 十、升级 pi 之后怎么验

自动化测试**不依赖真 pi**（全部 fixture 驱动），所以升级后要人工过一遍：

1. `npm test` —— 基础测试全绿
2. `npm run test:app`（先 `npm run fixtures`）—— 打包链路正常
3. 打开应用 →「诊断」→ 看 **Pi 兼容性**：
   - 状态应是「正常」或「部分兼容」，**不该是「未知」**
   - `unverified` 里有能力是正常的（没用过）；`missing` 里**不该有**核心能力
   - 协议异常应尽量为空；有的话点开看是哪个操作、哪个字段
4. 新建会话
5. 发一条**不重要的**测试 prompt（这一步会花额度）
6. 让它跑一次工具（例如「列一下当前目录」）→ 看 Tool Timeline 是否有 start/end
7. 重开应用 → 历史是否恢复
8. 切换会话 → 是否切得过去、历史是否正确
9. 用侧栏搜索框搜一个词 → 结果、跳转是否正常
10. 有改名需求时点一次铅笔 → 改完刷新是否还在

**这不是自动化测试的替代品**，是 upstream 升级清单 —— 自动化测的是
「给定这些形状，我们的判定对不对」，没法替你确认「这个版本的 pi 真的这么发」。

## 十一、相关测试

```bash
npm run test:compat    # tests/pi-compat.cjs（57 条，纯 fixture）
```

覆盖：完全兼容 / 缺可选能力 → partial / 缺核心能力 → incompatible /
版本未知仍兼容 / 上游新增未知字段 / 未知事件安全忽略 / 畸形数据记异常不崩 /
会话两种消息形状 / 异常缓冲上限 / 报告不含任何原始值 / 三值语义。

前端侧（`npm run test:ui`）另有一组：未知事件不崩、未知 response command 不崩、
按能力局部降级（隐藏改名 / 禁用切换 / 一次性的核心不可用提示 / 历史说明）。

### 语义适配器都只站在 `toolEvents` 上

P16 Web / P17 Subagent / P18 Memory / P20 Browser 四层都不引入新的 pi 能力：
它们只消费 `tool_execution_*` 里的 `toolName` / `args` / `partialResult` / `result`，
按**工具名**匹配语义。所以：

- pi 新增或改名工具 → 对不上的走 generic fallback，**不会崩、也不会假装懂**；
- pi 的 `result.details` 形状变了 → 结构化证据拿不到时降级成「结果不可用」，
  而不是拿请求参数顶成成功（P18-Fix / P20 同一条规则）；
- `toolEvents` 整体缺失 → 四个适配器一起退回 generic fallback 文案，
  聊天与其它功能不受影响。

P20 另有一条上游侧的依赖：**默认适配的 Extension 自己**（`pi-browser-harness` 0.11.0）
决定了 `details.ok` / `details.kind` 的存在。它若改了这两个字段，
GUI 侧的表现是**保守地降级**（只说结果不可用），不会误报成功。
契约与升级后的复核方式见 [browser.md](browser.md)。

## 十二、不做的事

明确不做（见 P4 规格的禁止项）：自动更新 / 安装 / 降级 pi、查 npm registry、
查 GitHub Release、改用户全局 npm、改 pi 的 session schema、fork 或 monkey patch pi、
telemetry、崩溃上传、新数据库、新第三方依赖。

> P20.6 起 MCP 不再是「兼容层观察的对象」，而是原生集成的管理面：
> 状态走 `pi mcp list --json`、动作走官方 CLI（add / remove / login / logout），
> 详见 [mcp.md](mcp.md)。本页只保留一句话作边界：**RPC 至今没有 MCP 管理 /
> 状态命令**（33 条，0.99.1 与 0.99.2 上各确认一次，`rpc-types.d.ts` 两版 diff
> 为空），所以兼容层不判 MCP 兼容，只判上面那九个能力。
