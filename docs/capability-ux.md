# Capability UX（P22）

这一页解决一个问题：**用户要在同一个界面里看懂「这个能力现在能不能用」**。
它**不是**第二套事实源，不是数据库，也不是 Marketplace。

> **一句话边界**：Capability 层只做**投影**（把已经存在、已经带出处的证据重新排版），
> 不产生任何新事实。任何「这个能力到底怎么样」的判定，都发生在它原来的那一层
> —— Extension Registry、各 feature 的运行观察、P20.5 / P20.6 的能力探测。
> Capability 层连一个缓存都不留（缓存就是会过期的第二份真相）。

## 一、信息架构

扩展工作区（`#navExtensions`）的标签行**就是过滤器** —— 不新增导航，复用现有的
Work Surface tab 机制（`aria-selected` / `aria-controls` 语义与生命周期都不变）：

| 过滤器 | 内容 | 事实来源 |
|---|---|---|
| **All** | 已知能力 + pi 内置 + 通用 Extension + MCP server，一张表 | 下面第三节的四条来源 |
| **Capabilities** | 只留已知能力与 Native MCP（「能不能用」这一问的答案） | 同上 |
| **Extensions** | 通用 Extension Registry，**包括完全不认识的** | `GET /api/extensions` |
| **Skills** | pi 原生 Skills 清单、详情与启停（原有实现，语义未改） | `GET /api/skills` |
| **MCP** | pi 原生 MCP 管理面（原有实现，语义未改） | `/api/mcp`、`/api/mcp/servers` |

默认落在 **All**。Skills / MCP 两个过滤器直接复用 P15 / P20.6 已有的面板 ——
filters 是**视图分组**，不是第二套实现。

搜索框按**名称 / 用途 / 状态**过滤，与当前过滤器叠加；搜不到时给中性空态文案，
不是空白页。「未知（无法确认）」不进搜索索引：它不是一个状态，是「没有证据」；
让它进索引的话，搜「未知」会命中几乎每一行，反而找不到真正未知的那几条。

## 二、统一状态

每一行都投影同一组字段（`public/capability-model.js` 的 `setupViewModel()`）：

| 字段 | 含义 | 四值 |
|---|---|---|
| 安装状态 `installed` | 磁盘上有没有（第三方 Extension）；原生 / 内置能力为「不适用」 | 是 / 否 / 未知 / 不适用 |
| 启用配置 `configured` | **enabled 证据**（存在 ≠ 已启用） | 已启用 / 已停用 / 未知 / 不适用 |
| 已加载 `loaded` | Pi 是否**证实**加载过（RPC 证据） | 已确认加载 / 未加载 / 未知 / 不适用 |
| 运行观察 `runtimeObserved` | 本次 `bridgeRun` 内真的收到过哪些 `tool_execution_*` | 文案 / 未知 / 不适用 |
| 需要重启 `restartRequired` | 配置改了但还没重启 | 是 / 否 / 未知 / 不适用 |
| 诊断 `diagnostic` | 这个能力自己的错误；没有就写「无」 | 文案 / 无 |

**三值纪律（写错就是骗人）：**

- `null` **一律**显示「未知（无法确认）」，**绝不显示成 false**。
  磁盘上没有 ≠ 未加载；没观察到调用 ≠ 没这个能力。
  发现接口失败时 `installed` 只能是未知 —— 这条在单测与真实 Chrome 截图里都钉住了。
- `'n/a'` 是第四种值：这个字段对这类能力**不适用**（例如 pi 内置扩展没有
  npm 安装概念、Skills 不是工具型能力）。显示「不适用」，它既不是未知，也不是否。
- **配置禁用与当前加载证据是两件事**：改了 `settings.json` 但还没重启时，
  可以同时出现「启用配置：已停用」与「已加载：已确认加载」，
  并且结论行追加「需重启 Pi」。
- **运行观察只说明这次 bridge run 真的见过调用。** Pi RPC 没有权威的已注册工具清单
  （0.87.0 / 0.99.1 / 0.99.2 的 33 条命令里一条都没有），所以观察到的工具名
  **不构成**「这个包已加载」的证据 —— 同名工具可能来自别的 Extension。

结论行（圆点 + 文案）由 `statusOf()` 唯一一处算出来，优先级固定：

```
原生 MCP 的原生状态（active / replaced / disabled / unsupported）
  → 未安装 → 安装状态未知 → 已安装未加载 → 已加载 → 已安装但加载未知
  → 若 restartRequired === true，追加「需重启 Pi」
```

## 三、每一条证据从哪来

Capability 层**不新增来源**，只把下面这些搬进一张表：

| 行 | 安装 / 加载证据 | 运行观察 | 能力真值 |
|---|---|---|---|
| Web Access | Extension Registry（包名 `pi-web-access`） | `web_search` / `fetch_content` / `get_search_content` | — |
| Subagents | Extension Registry（`pi-subagents`） | `subagent` / `subagents_enable` / `bg_wait` / `subagent_supervisor` | — |
| Pi Memory | Extension Registry（`pi-memory`） | memory 工具（`memory-activity.js` 的白名单） | — |
| Browser Use | Extension Registry（`pi-browser-harness`） | 40 个 `browser_*`（按工具名聚合，只报几个） | — |
| Native MCP | `GET /api/mcp` 的 `supported`（P20.5） | `mcp__*` 与资源工具（按 server 聚合） | `GET /api/mcp/servers` 的原生状态机 |
| built-in 扩展 | pi 包里的 `builtInExtensions` 清单（P20.5） | 不适用 | 包里带了 ≠ 当前启用了 |
| Skills | `GET /api/skills` + RPC `get_commands` | 不适用 | pi 原生能力 |
| Approval | `GET /api/approvals/capability`（P19） | 不适用 | tool_call hook 探测 |
| Usage / Quota | 不适用（**入口**，不是可安装能力） | 不适用 | Pi RPC 会话统计 + Provider 官方接口 |

**MCP 的原生状态原样搬运 P20.6 的结论**（`server/mcp-native.js` 的 `nativeState()`）：
`active` / `replaced` / `disabled` / `unsupported` / `unknown` 一个都不重判。
Capability 层只把它们翻成界面文案，并且把 `replaced`（被扩展接管）与
`disabled`（被 settings 停用）当**两件不同的事**说 —— 后者是用户显式关掉的。

「原生被扩展接管」计入概览的**未知**一档，不计入「不可用」：接管不等于 MCP 不可用，
这两件事混在一起说就是撒谎。

## 四、统一 setup 布局

`public/ui/capability-setup.js` 是**唯一一套** setup 布局，顺序固定：

```
名称 → 用途 → 结论（圆点 + 文案 + 来源徽标）→ 六个统一状态字段 →
来源 / 安装说明 → 固定官方命令（若有）→ 复制 → 安装后重启 Pi →
说明（含运行观察的纪律）→ 限制 → 出处 → 外链
```

- **Native MCP 与 built-in 没有安装命令**：它们的 `installCommand` 是 `null`，
  界面上连 `<code>` 元素都不会出现，只有一句「它从哪来」的说明。
  Native MCP **不显示** npm 安装命令 —— 它来自 Pi 的 builtin capability。
- **没有安装表单**：不提供任意包名入口，也不提供「安装」按钮。
- Web / Subagents / Pi Memory / Browser 四个 feature 模块**继续拥有**自己的事实、
  安装命令与措辞，只是把 descriptor 交给这一层排版 —— 换掉布局不会换掉语义。
- 「安装后重启 Pi」全仓库**只有一处实现**（就是这一层）：先 `confirmModal`，
  再校验 `ownsWorkspace(generation)`，最后调既有的 `restartBackend()`。
  切换了项目就什么都不做 —— **绝不对着新项目重启**。

## 五、Registry 边界

- `server/extension-registry.js` 保持 **generic**：它不知道 `pi-web-access`、
  `pi-memory`、`nativeState` 这些东西的存在。Capability 层知道推荐包名，
  但那只是 **setup metadata**（「磁盘上有没有它」这一条证据的键）。
- **built-in 能力不进 filesystem Extension discovery。** 它们编译在 pi 包里
  （`dist/extensions/`），不属于 `~/.pi/agent/extensions` 的扫描范围；
  在界面上用 `builtin:` 前缀、`pi 内置扩展` 的来源徽标与一句
  「不由 Extension Registry 的目录扫描发现」把自己和普通 Extension 分开。
- **unknown Extension 不丢**：我们完全不认识的 Extension 照样出现在 All 与
  Extensions 里，六个字段保持未知，错误就地显示，仍然可以在 Extensions 页诊断。

## 六、重启与 stale

- 任何「安装后重启 Pi」都走同一个确认流程与同一个 `POST /api/restart`。
- 结果落地前必须同时过两关：Surface 实例身份（`isCurrent()`）与
  workspace generation（`ownsWorkspace(generation)`）。切了项目之后，
  旧请求回来的是**上一份世界** —— 那一份一个字都不许落地，
  界面改成「项目已切换，刷新后查看当前项目的能力状态」。
- MCP 配置变化是否需要 reload / restart **按 Pi 当前的真实契约处理**：
  Pi GUI 只代理官方 CLI（add / remove / login / logout），enable / disable /
  reconnect / 改 exposure 没有官方自动化接口，界面上写清楚「请用 pi 的 /mcp 管理器」，
  **不伪造开关**。详见 [mcp.md](mcp.md)。

## 七、明确不做

Marketplace、自动更新、评分、远端 catalog、Extension logo 商店、Agent editor、
Memory browser、Browser manager、第二套 MCP runtime —— 一个都不做。
这一页只读：除了复制命令、走官方重启、打开既有的上下文 Tip 之外，
它没有任何写动作。

## 八、相关文件与验证

| 文件 | 职责 |
|---|---|
| `public/capability-model.js` | 纯投影：四值状态、结论行、概览计数、过滤器、setup 视图模型 |
| `public/ui/capability-setup.js` | 唯一一套 setup 布局 + 唯一的「安装后重启 Pi」实现 |
| `public/capability-view.js` | All / Capabilities 两个过滤器的渲染与加载（不缓存观察） |
| `public/extensions.js` | 五个过滤器的标签行 + 通用 Registry 页 + Skills / MCP 原有面板 |
| `public/*-capabilities.js` | 各 feature 的事实与 descriptor（Registry 证据 → 三值） |

验证：

- `npm run test:capability`（62 条，纯函数、离线）：四值投影、`null` 不冒充 `false`、
  built-in / Native MCP 与 unknown Extension、搜索与过滤、运行观察重置、
  `restartRequired`、stale、无自动安装、**Registry 无特化**。
- `npm run test:ui` 的 P22 段（jsdom，21 条）：五个过滤器、六个字段、
  统一文案、未知不写成否、restartRequired、stale、Usage 入口只读。
- `npm run shots:harness` 的场景 **171–180**（真实 Chrome）：
  171 All、172 统一 setup、173 Native MCP（无安装命令）、174 built-in、
  175 发现失败 → 未知、176–179 的 700 / 900 / 1200 / 1536px、
  180 搜索。每一张都带结构判据（字段齐全、无横向溢出、列表项高度受控）。

截图在 `.shots/` 下，前缀 `p22-`。
