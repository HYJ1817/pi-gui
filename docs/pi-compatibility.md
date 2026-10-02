# 与 pi 的兼容性

P21 的 usage/quota 与 pi 本体解耦：本地用量只吃 pi 的 RPC 事件
（`get_session_stats` / `message_update` / `message_end` 的真实 usage 字段），
远端额度则直接对上**各家供应商自己的官方接口**，与 pi 版本无关。
当前基线 pi **1.0.0**（2026-10-02 逐项核对 + 本机 live 复核）；
适配器清单与重置语义见 [usage-quota.md](usage-quota.md)。
pi 的 provider 配置（`~/.pi/agent/models.json`）只用来读 `baseUrl` / `apiKey` /
`quotaAdapter`（以及旧部署可选的 `quotaUserId`）这几个字段，Pi GUI 不写回、不改 schema。

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

## P23：长期兼容与升级安全

P20.5 把「文档里的基线版本」和「你机器上跑的版本」拆开了。P23 把那次**一次性迁移**
变成长期机制 —— 四块，都不新增事实源：

| 块 | 在哪 | 回答什么 |
|---|---|---|
| **版本真值** | `server/pi-version.js` | 跑的是哪个 pi（`value` / `source` / `status` / `updatedAt`）**以及这个版本我们核过没有**（`verifiedAgainst` / `verification`） |
| **probe registry** | `server/pi-probes.js` | 14 条能力 probe 的三值 + 出处 + 降级策略。**优先 probe feature，不写 `if version >= X`** |
| **兼容矩阵** | `server/pi-compat-matrix.js` | 小型、明确、可核对的 metadata：已验证的 Pi 版本、关键 Extension release、Native MCP 契约、已知差异 |
| **升级 playbook** | [upgrade-playbook.md](upgrade-playbook.md) | 拿到新版本之后按什么顺序做，以及「**CI 绿不能认证一个新版本**」 |

### 版本真值多了一个维度

```js
{
  value: '0.99.2', source: 'package.json', status: 'known',
  updatedAt: '2026-10-02T00:00:00.000Z',
  verification: 'verified',                      // verified / unverified / unknown / unchecked
  verifiedAgainst: { version: '0.99.2', verifiedAt: '2026-10-01', scope: 'current' },
  relative: 'same',                              // 只作提示，不作判据
}
```

- `verification: 'verified'` = 这个版本在 `PI_BASELINES` 里，逐项核对过。
- `'unverified'` = 读到了版本，但矩阵里没有它 —— **不是「不支持」，功能照常**。
- `'unknown'` = 版本本身没读到（与「没核过」是两件事）。
- `'unchecked'` = 没注入矩阵（老调用方 / 单测）。
- `relative`（比基线新/旧）**明确标注为不作判据**：fork / 自定义实现的版本号可能完全不同。

### probe registry

每条 probe 只回答是 / 否 / 未知，带**出处**（读了哪个文件的哪一行，相对路径）与
**降级策略**（拿不到时 GUI 会怎样）。source probe 只 `readFileSync` 已知相对路径并限长；
runtime probe 只读已有观察（`pi-compat` 的能力三值、`mcp-native` 的摘要）。
**不 import pi 的模块、不 spawn、绝不执行第三方 Extension 代码。**

缓存绑定 `(launch identity, 包目录)`，带 30s TTL；bridge 生命周期一变
（starting / restarting / exited / error / no-project）由 `server.js` 调 `reset()` ——
旧 run 的 runtime probe 不许留在表里。

### 实测发现的两处**文档漂移**（P23 的 live probe 抓到的）

`npm run test:probes-live` 对着本机真实 pi 跑，第一次就把 P19 的能力报告打脸了：

| 面 | 0.87.0 / 0.99.1 | 0.99.2（本机实测） | 后果（修之前） |
|---|---|---|---|
| tool_call 阻断的**措辞** | `docs/extensions.md` 里「**Can block.**」/「before the tool executes」 | 改成「`tool_call` can mutate input or block execution.」+ `block: true` 示例 | 类型里明明有 `block?: boolean`，报告却说「没有阻断契约」→ **伪 false** |
| 对话框阻塞契约的**位置** | `docs/rpc.md` | 搬到 `docs/rpc-extension-ui.md` | 「扩展可向本界面要确认并阻塞」被判成不支持 → **伪 false** |

修法是 **probe 同时接受两版措辞与两处位置**，证据里带上真正命中的文件；
`tests/pi-probes.cjs` 还会交叉核对 `approval-probe.js`(P19) 与 `pi-probes.js`(P23)
对同一份包给出一致结论 —— 两处判定不能各说各话。两条漂移都登记在
`KNOWN_DIFFERENCES` 里（`approval-doc-wording` / `dialog-doc-moved`）。

> 教训写进 playbook 第二步：**文档措辞会变、文档会搬家，而语义没变。**
> 只认一处措辞的 probe 不是「保守」，是**会撒谎**。

### schema 漂移：看得见，但不带值

语义适配器对未知字段的策略不变（忽略 / 关键字段缺失 → 「结果不可用」/ 新枚举 → unknown），
但**降级不再静默**：

- 后端：`server/pi-compat.js` 的 `observeUnknownField()` / `observeUnknownEnum()`，
  记 `{category: 'schema', operation: 来源, field: 我们自己代码里的字段路径, actual: typeof}`。
  **对象键名都不记**（用 `driftType()`），更不记值。
- 前端：`public/schema-drift.js` 的小环（上限 20，同一条去重），
  由 `browser-activity` / `memory-activity` / `tool-view` / `extensions.js` 上报
  「闭集外的 `details.kind`」「不认识的 `snapshotMode`」「一个适配器都不认识的工具名」
  「闭集外的 MCP 运行状态」。进诊断面板与「复制诊断摘要」。

**硬规矩：绝不因为形状不认识就回退成打印原始 JSON。** 语义适配器按工具名接管，
命中之后 raw args/details 一律不进 DOM；只有**一个适配器都不认识**的工具才走
generic fallback（那是 P15 的既有行为，且内容是折叠区里的、不是摘要行）。

## 〇、四个「版本」不是一回事（P20.5）

上一轮出过一个具体的错：文档里写着「pi 0.87.0 没有原生 MCP，而且是有意为之」，
用户机器上却装着 0.99.1（**它自带 `builtin:mcp`**）。一句话把四件事混成了一件。
现在把它们分开，**每一处都说清自己在讲哪一个**：

| | 是什么 | 谁决定 | 在哪看 |
|---|---|---|---|
| **历史验证基线** | P15–P19 当时的验收对象：**0.87.0**；P20.5 的对照物 0.99.1；P20.6-Fix 与 P22/P23 的对照物 0.99.2 | 已固定的历史事实，不会变 | 各 feature 文档的「当时基线」句 |
| **当前验证基线** | 本轮逐项核对并 live 复核的对象：**1.0.0**（2026-10-02） | 本轮的核对结果 | 本节 + `server/pi-compat-matrix.js` + `tests/pi-probes.cjs` |
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

### 0.99.2 → 1.0.0 的实际差异（逐项核对过）

对照物：GitHub tag **v0.99.2** 与 **v1.0.0** 的源码树。两个 tag 的 commit
正好等于 npm 上两个发布包的 `gitHead`：

| 版本 | tag commit = npm `gitHead` |
|---|---|
| 0.99.2 | `005af57d88ee23b33778f343a9595b32e67ff788` |
| 1.0.0 | `a13d35a742c6ef8462812a28fbe1d8c8b7431c32` |

**tag 与发布包是同一份东西**，所以这次可以逐文件比对源码而不必再解 tarball。

| 面 | 读哪个文件 | 0.99.2 → 1.0.0 | 对 Pi GUI 的影响 |
|---|---|---|---|
| **RPC 命令集 / 应答 / 扩展 UI** | `packages/coding-agent/src/modes/rpc/rpc-types.ts` | **逐字节相同**（SHA256 `BE06A1D53916…`）：`RpcCommand` **33 条**、顺序一致、零增删；`extension_ui_request` 9 个方法、`extension_ui_response` 3 个形状不变 | **无。不需要任何 RPC migration** |
| **事件流** | `packages/agent/src/types.ts` + `core/agent-session.ts` | `AgentEvent` **逐字节相同**（`tool_execution_start/_update/_end` 在那一份里）；`AgentSessionEvent` 的相关区间也相同 | 无。**没有叫 `RpcEvent` 的类型** —— 事件是 `AgentSessionEvent`，别在文档里再造一个名字 |
| **Extension API** | `packages/coding-agent/src/core/extensions/types.ts` | **逐字节相同**（SHA256 `C22E4DDD89F0…`，82,143 字节）：`ToolCallEventResult.block/reason/terminate`、`getAllTools(): ToolInfo[]`、`mcp_servers_change`、四个 provider 事件都没变 | 无。Approval / Extensions / Tool Timeline **不按版本号重写** |
| **MCP 配置校验** | `packages/coding-agent/src/core/mcp-servers.ts` | **变了**（整个文件只有这一处差异）：新增 `oauth.authServerMetadataUrl` 字段 + 一段校验 | ⚠️ **必须复刻**（见下） |
| **MCP 配置文件读取** | `packages/coding-agent/src/extensions/mcp/config.ts` | **逐字节相同** | 覆盖 / 信任 / namespace 规则不变 |
| **MCP CLI** | `packages/coding-agent/src/extensions/mcp/cli.ts` | 改了两处调用签名：`credentials.remove(name, url)` / `credentials.forServer(name, url)` | GUI 只代理官方 CLI，**不自己实现 OAuth** |
| **OAuth 凭据存储** | `packages/coding-agent/src/extensions/mcp/oauth.ts` | 键从「URL」改成「server name + URL」 | 见下（Pi 自己迁移，GUI 不碰） |
| **deferred MCP 工具** | `core/agent-session.ts` | 上游**修了一个 bug**：`tool_search` 动态加载的 deferred MCP 工具在 resume / `/reload` 后不再被丢掉 | GUI **不重写**工具恢复；无证据就 `unknown` |
| **codemode** | `packages/codemode/src/runtime/prelude-source.ts` 等 | 沙箱改成 Proxy：读不存在的成员会**抛错**，`typeof tools.x` 不再是合法探测（要用 `"x" in tools`）；新增 `models.generateImages()` | 仓库里 `typeof tools.` 用法为 **0**，也不生成 codemode 脚本 ⇒ **不迁移**，只记录 |
| **版本串** | `src/main.ts` / `src/config.ts` | `pi --version` 两个版本都打印**裸版本号**（没有 `pi ` 前缀） | 探测本来就两版都认，无需改 |

#### 唯一需要改代码的一处：`oauth.authServerMetadataUrl`

上游 v1.0.0 的完整校验（手写校验器，不是 zod；报错统一带 `server "<name>": ` 前缀）：

```ts
const metadataUrl = value.authServerMetadataUrl;
if (metadataUrl !== undefined) {
  const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
  if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) {
    return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
  }
}
```

| 输入 | 上游 | Pi GUI（`server/mcp-native.js` 的 `validateOAuthConfig`） |
|---|---|---|
| `https://…`（任意主机，**允许** query / fragment，**不校验端口**） | 接受 | 接受 |
| `http://localhost` / `http://127.0.0.1` / `http://[::1]` | 接受 | 接受 |
| `http://example.com`、`ftp://…`、`file://…` | 拒绝 | 拒绝 |
| 畸形串 / 空串 / number / object / array | 拒绝 | 拒绝 |
| 未给这个键 | 接受（跳过） | 接受（跳过） |
| `oauth` 里其它未知键 | **静默忽略** | 同样不拒 |

**为什么这条必须复刻**：`parseMcpServers()` 是「Pi 会不会加载这条配置」的复刻，
而它同时决定**项目条目算不算覆盖同名用户级条目**。少了这条规则就会出现
P20.6-Fix-3 的变体：GUI 认为项目里那条合法 → 把用户级标成 `overridden` →
上游把整条拒掉 → **两条都不生效**。所以上游拒的，GUI 也必须拒。

#### OAuth 凭据身份：`forServer(url)` → `forServer(name, url)`

- 新键：`` `${mcpNamespace(name)}|${String(new URL(serverUrl))}` ``（`mcpNamespace` = `mcp__` + 名字里的 `-` 折成 `_`）；旧键是**规范化后的 URL 单独作键**。
- **迁移由 Pi 自己做，而且是懒迁移**：第一个 `load()` 的 server 会接手旧键、把 `mcp-auth.json` 重写成新键形式；`tokens()` 只回退读取、不迁移；`remove()` 删掉实际存在的那个键。
- 副作用：**同一个 URL、不同 name 的两个 server 不再共用一个账号** —— 先加载的那个接手旧凭据，其余需要重新登录。
- Pi GUI 的立场不变：**不读 `mcp-auth.json`、不解析 token、不迁移、不复制凭据存储、不自己实现 OAuth**，只把 server **名**原样交给官方 `pi mcp login` / `pi mcp logout`。

#### 上游修复：deferred MCP 工具不再丢

`tool_search` 动态加载的 deferred MCP 工具，过去在 session resume / `/reload`
之后如果 MCP 已经重新连上，仍会被丢掉（会话恢复工具时那些 server 还没注册）。
1.0.0 用 `_pendingToolNames` 解决了它。**这是上游的修复**，Pi GUI 不需要重写
工具恢复逻辑；GUI 只按真实事件观察，拿不到证据一律 `unknown`，
**不按 changelog 硬编码 `true`**。

#### codemode：一条要记住的用法变化（与 Pi GUI 无关）

1.0.0 的 codemode 沙箱把 `tools` / `models` 包成了 Proxy，读不存在的成员会
**抛错**（错误信息里会提示用 `in`），所以：

- `typeof tools.name` 不再是合法的存在性探测 → 用 `"name" in tools`；
- 新增 `models.generateImages()`（图片生成）。

Pi GUI **既不生成也不执行** codemode 脚本（仓库里 `typeof tools.` 用法为 0），
所以本轮**不做迁移**；`models.generateImages()` 也**不新增消费入口**
（没有图片生成页面 / 按钮 / 假的 Capability action），只在本文档注明。

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

### P20.6-Fix-3：修完覆盖 bug 后**同一 bug 的隐蔽变体**

Fix-2 把「覆盖」建立在「Pi 会接受并加载的 project entry」上，但当时的
`parseMcpServers()` 只做**结构**解析，没有复刻上游 `validateMcpServerConfig()`。
于是上游会拒绝、GUI 却认为合法的项目条目（例如 `args: [123]`）仍会被算进覆盖
集合 —— 用户级被标 `overridden`、项目那条被上游跳过，**两条都不生效**。
同一个 bug，只是触发条件更隐蔽。

| 面 | 修法 |
|---|---|
| 接受/拒绝判定 | `parseMcpServers()` **逐条复刻** `validateMcpServerConfig()`（名字 / `exposure` / `toolExposure` / `enabled` / `description` / `timeout` / `type` / `url` / `headers` / `oauth` / `auth` / `args` / `env` / `cwd` / 分支优先级），并复刻 `readConfigFile()` 的 **namespace 冲突**与 **`auth` 不得出现在项目文件** 两条 |
| 覆盖集合 | 仍然是 `parseMcpServers` 认可的 `projectServers`，但现在它真的等于「Pi 会加载的条目」 |
| server 名长度 | 配置解析改用上游规则（**不限长度**）；GUI 只在 `add`/`remove` **动作入参**上加 64 字符上限（输入侧防御） |

顺带纠正了两处旧的错误理解（都已有测试钉住）：
- `{command, url}` 并存**不是**非法 —— 上游 HTTP 分支优先，按 HTTP 接受。
- `toolExposure` 有非法值**不是**「只丢那个键」—— 上游**拒绝整条**。

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

> 这一轮起，Pi GUI 自带一个 **built-in Pi updater**（诊断面板 → Pi → 「更新到 x.y.z」）：
> 它自动检查新版本、**用户确认后**只跑官方 `pi update --self`，更新期间把 bridge
> 切到维护态、更新完清掉所有与 Pi 包 identity 绑定的缓存并**重新读版本**，
> 读到旧版本就判失败。**它不替代下面这份人工清单** —— 更新完仍然要跑 live probe
> 与第 6 步的矩阵收口。安全边界见 [security.md](security.md)、流程见 [updates.md](updates.md)。

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
npm run test:compat       # tests/pi-compat.cjs（57 条，纯 fixture）
npm run test:probes       # tests/pi-probes.cjs（62 条，纯 fixture，P23）
npm run test:pi-version   # tests/pi-version.cjs（136 条，版本真值 + built-in 探测）
npm run test:mcp          # tests/mcp-native.cjs（含 1.0.0 的 oauth.authServerMetadataUrl 对拍）
npm run test:pi-update    # tests/pi-update.cjs（Pi 运行时更新：检查 / 闸门 / 维护 / 复验）
npm run test:probes-live  # 对着**本机真装着的 pi** 打一张 probe 表（opt-in，不进 CI）
```

覆盖：完全兼容 / 缺可选能力 → partial / 缺核心能力 → incompatible /
版本未知仍兼容 / 上游新增未知字段 / 未知事件安全忽略 / 畸形数据记异常不崩 /
会话两种消息形状 / 异常缓冲上限 / 报告不含任何原始值 / 三值语义；
P23 另加：兼容矩阵（已验证 / 未核对 / 未知）、probe 的 supported / unsupported / **抛错**、
缓存 TTL 与 identity 失效、版本 `verifiedAgainst` 四态、schema 漂移只记字段名与类型、
诊断五块集成与脱敏、MCP 闭集外状态的漂移出口。

`npm run test:probes-live [-- --strict]` 是**升级流程第 5 步**：
它不假设本机版本，只断言结构事实（每条 probe 都有结论、证据里没有绝对路径），
并把整张表打出来。`--strict` 在「版本不在矩阵里」时以退出码 1 结束 ——
这条就是「CI 绿不能认证一个新版本」的机器可执行落点。

前端侧（`npm run test:ui`）另有一组：未知事件不崩、未知 response command 不崩、
按能力局部降级（隐藏改名 / 禁用切换 / 一次性的核心不可用提示 / 历史说明）、
以及 P23 的诊断面板（五个新小节 / 三值文案 / 摘要脱敏 / 漂移记录与清空）。

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

## 十三、P21 Usage 与 Quota 契约（核对时的类型定义来自 0.99.2；1.0.0 未变）

Pi 对用量的支持完全停留在**本地运行指标**层。这里必须严格区分三层，名字不能混：
**Pi wire Usage → adapter（`public/usage.js`）→ Pi GUI LocalUsage**。

1. **Pi wire `Usage`**（`@earendil-works/pi-ai@0.99.2` 的 `Usage` 接口，对应上游
   `packages/ai/src/types.ts`）：
   ```ts
   interface Usage {
     input: number;
     output: number;
     cacheRead: number;
     cacheWrite: number;
     cacheWrite1h?: number;   // cacheWrite 的子集，只有 Anthropic 报这个拆分
     reasoning?: number;      // output 的子集；不报的供应商保持 undefined（可能是 0）
     totalTokens: number;
     cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
   }
   ```
2. **`get_session_stats` RPC 命令**（0.99.2 的 session stats 载荷）：
   ```ts
   {
     userMessages, assistantMessages, toolCalls, toolResults, totalMessages,
     tokens: { input, output, cacheRead, cacheWrite, total },
     cost: number,
     contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
   }
   ```
   - 字段是 **`contextWindow`**，**不是** `limit`。
   - `contextUsage` 本身可选；`tokens` 与 `percent` 可以是 `null`。上游注释写明：
     刚做完 compaction、下一次 LLM 响应之前**无法确认**当前上下文用量，
     此时 `tokens = null` / `percent = null`，而 `contextWindow` 仍然存在。
     **null 不是 0** —— 界面显示 `—`，不显示 `0%`。
3. **`message_update` / `message_end`**：payload 里的 `message.usage` 就是上面的 wire `Usage`；
   adapter 把它映射成 LocalUsage 的 `lastTurn`（`input` → `inputTokens`、`cacheRead` →
   `cacheReadTokens`、`cacheWrite1h` → `cacheWrite1hTokens`、`reasoning` → `reasoningTokens`、
   `cost.total` → `estimatedCost`）。
   ⚠️ **`inputTokens` / `outputTokens` / `cacheReadTokens` / `reasoningTokens` 是 Pi GUI
   `LocalUsage` 的字段名，不是 Pi wire 字段** —— 本文件早先版本把它们写成 wire schema，是错的。
4. **远端配额（Quota）**：
   - **Pi 核心完全不提供任何远端 Quota / Balance 查询接口**（33 条 RPC 命令中无任何配额相关指令）。
   - 配额完全由 Pi-GUI 独立 adapter（`server/quota.js`）按官方规范接口异步采集，与 Pi 核心运行时零耦合。详见 [usage-quota.md](usage-quota.md)。

