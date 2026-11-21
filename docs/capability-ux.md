# Capability UX（P22 / P36）

这一页解决一个问题：**用户要能看懂一个已知能力装没装、能不能用，并在需要时安装它**。
它**不是**第二套事实源，不是数据库，也不是 Marketplace。

> **一句话边界**：Capability 层只做**投影**（把已经存在、已经带出处的证据重新排版），
> 不产生任何新事实。任何「这个能力到底怎么样」的判定，都发生在它原来的那一层
> —— Extension Registry、各 feature 的运行观察、P20.5 / P20.6 的能力探测。
> Capability 层连一个缓存都不留（缓存就是会过期的第二份真相）。

## 一、当前信息架构（P36 → 三入口拆分）

P36 移除了独立的能力状态页，以及它原有的 **All / Capabilities** 两个过滤器。
之后 Skills / Extensions / MCP 又从同一个工作区的三个标签拆成三个独立入口
（入口、模块归属与并行开发边界见 [agent-capabilities.md](agent-capabilities.md)）：

| 入口 | 内容 | 事实来源 |
|---|---|---|
| 应用主导航 **扩展**（`#navExtensions`）›「已安装」 | 通用 Extension Registry，**包括完全不认识的**；顶部另有「已知能力设置」折叠区 | `GET /api/extensions` |
| 扩展 ›「插件市场」 | 第一阶段只预留布局，不发请求、不安装 | 无 |
| 设置 › Agent 能力 › **技能** | pi 原生 Skills 清单、详情与启停（语义未改） | `GET /api/skills` |
| 设置 › 扩展与 MCP › **MCP 配置** | pi 原生 MCP 管理面 + 页尾「MCP 能力报告」（Native MCP / built-in 状态，语义未改） | `/api/mcp/config`、`/api/mcp/servers`、`/api/mcp` |

扩展页默认落在「已安装」。两个页签用 `role="tablist"` / `aria-selected` /
`aria-controls="extensionsTabPanel"`，面板懒建后复用，异步结果过实例身份守卫。

**「已知能力设置（安装 / 运行观察）」**是「已安装」顶部的一个默认折叠区，
只保留旧能力状态页里**仍然有动作或独有证据**的五项：

- Web Access
- Subagents
- Pi Memory
- Browser Use
- Approval / Permission

它**不提供**能力总览、计数、搜索、筛选、列表 / 详情切换或整页刷新 —— 这些属于
已删除的能力状态页。它只做 setup：安装状态、固定官方命令、复制、受控一键安装、
安装后重启、运行观察、限制与出处。每个子项也默认折叠，避免把 Registry 列表挤下去。

> **为什么回到 Extensions 页**：这五项的唯一入口原本是能力状态页。删除页面时
> 不能把一键安装、运行观察和 Approval 探测一起变成不可达功能；Extensions 页是
> 它们最自然的宿主。Registry 本身仍然保持通用，不因这五项加入按包名的发现逻辑。

## 二、统一状态

每一行都投影同一组字段（`public/capability-model.js` 的 `setupViewModel()`）。
**内部是四值，界面只画适用的那些**（收口见 §三）：

| 字段 | 含义 | 四值 |
|---|---|---|
| 安装状态 `installed` | 磁盘上有没有（第三方 Extension）；原生 / 内置能力为「不适用」 | 是 / 否 / 未知 / 不适用 |
| 启用配置 `configured` | **enabled 证据**（存在 ≠ 已启用） | 已启用 / 已停用 / 未知 / 不适用 |
| 已加载 `loaded` | Pi 是否**证实**加载过（RPC 证据） | 已确认加载 / 未加载 / 未知 / 不适用 |
| 运行观察 `runtimeObserved` | 本次 `bridgeRun` 内真的收到过哪些 `tool_execution_*` | 文案 / 未知 / 不适用 |
| 需要重启 `restartRequired` | 配置改了但还没重启 | 是 / 否 / 未知 / 不适用 |
| 诊断 `diagnostic` | 这个能力自己的错误（**没有错误就不画这一行**） | 文案 / 不画 |

**三值纪律（写错就是骗人）：**

- `null` **一律**显示「未知（无法确认）」，**绝不显示成 false**。
  磁盘上没有 ≠ 未加载；没观察到调用 ≠ 没这个能力。
  发现接口失败时 `installed` 只能是未知 —— 这条在单测与真实 Chrome 截图里都钉住了。
- `'n/a'` 是第四种值：这个字段对这类能力**不适用**（例如 pi 内置扩展没有
  npm 安装概念、Skills 不是工具型能力）。它既不是未知，也不是否。
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

## 三、详情只画「对这个能力适用」的字段

四值模型一个都没改，改的只是**画不画**（`applicableStateRows()`）：

| 值 | 详情里怎么处理 | 为什么 |
|---|---|---|
| `'n/a'`（不适用） | **不画这一行** | Native MCP 没有 npm 安装概念、built-in 的启用/加载由 pi 自己决定、Usage 整条不是可安装能力。以前它们各自画一行「不适用」，语义没错，但一张详情里七八行「不适用」等于什么都没说 |
| `undefined`（descriptor 没声明） | **不画** | 凭空画一个「未知」是在替 descriptor 编一句它没说过的话 |
| `null`（适用但没证据） | **照常画「未知（无法确认）」** | ⚠️ `null` 绝不能因为「想少画几行」被藏掉 —— 那正好把「未知」伪装成「不适用」，比多画几行危险得多 |
| `diagnostic === null` | **不画「诊断」这一行** | 「诊断　无」不是信息；有真实错误才画 |

实际效果：built-in 只剩「安装状态：已安装」一条；Native MCP 从六格（含两个不适用）
变成四格；Usage 一条状态行都没有（它是入口，不是能力）。
**这是纯呈现收口**：catalog 计数、过滤、搜索、capability truth、Extension Registry
truth、Native MCP 状态机一个字都没动。

## 四、每一条证据从哪来

Capability 层**不新增来源**，只把下面这些搬进设置区：

| 行 | 安装 / 加载证据 | 运行观察 | 能力真值 |
|---|---|---|---|
| Web Access | Extension Registry（包名 `pi-web-access`） | `web_search` / `fetch_content` / `get_search_content` | — |
| Subagents | Extension Registry（`pi-subagents`） | `subagent` / `subagents_enable` / `bg_wait` / `subagent_supervisor` | — |
| Pi Memory | Extension Registry（`pi-memory`） | memory 工具（`memory-activity.js` 的白名单） | — |
| Browser Use | Extension Registry（`pi-browser-harness`） | 40 个 `browser_*`（按工具名聚合，只报几个） | — |
| Approval | `GET /api/approvals/capability`（P19） | 不适用 | tool_call hook 探测 |
| Native MCP | `GET /api/mcp` 的 `supported`（P20.5） | `mcp__*` 与资源工具（按 server 聚合） | `GET /api/mcp/servers` 的原生状态机 |
| built-in 扩展 | pi 包里的 `builtInExtensions` 清单（P20.5） | 不适用 | 包里带了 ≠ 当前启用了 |
| Skills | `GET /api/skills` + RPC `get_commands` | 不适用 | pi 原生能力 |
| Usage / Quota | 不适用（**入口**，不是可安装能力） | 不适用 | Pi RPC 会话统计 + Provider 官方接口 |

Native MCP 与 built-in 继续在 **MCP 配置页**（页尾「MCP 能力报告」）里显示；它们没有安装命令，也不在
「已知能力设置」里重复一份。Approval 不是 Extension 包，没有安装命令，只在设置区
显示协议探测结果。

**MCP 的原生状态原样搬运 P20.6 的结论**（`server/mcp-native.js` 的 `nativeState()`）：
`active` / `replaced` / `disabled` / `unsupported` / `unknown` 一个都不重判。
Capability 层只把它们翻成界面文案，并且把 `replaced`（被扩展接管）与
`disabled`（被 settings 停用）当**两件不同的事**说 —— 后者是用户显式关掉的。

「原生被扩展接管」计入概览的**未知**一档，不计入「不可用」：接管不等于 MCP 不可用，
这两件事混在一起说就是撒谎。

## 五、统一 setup 布局

`public/ui/capability-setup.js` 是**唯一一套** setup 布局，顺序固定：

```
名称 → 用途 → 结论（圆点 + 文案 + 来源徽标）→ 适用的状态字段 →
来源 / 安装说明 → 固定官方命令（若有）→ 一键安装 / 复制 → 安装后重启 Pi →
说明（含运行观察的纪律）→ 限制 → 出处 → 外链
```

- **没有安装表单**：不提供任意包名入口。一键安装只服务 §六 的固定 allowlist。
- Web / Subagents / Pi Memory / Browser 四个 feature 模块**继续拥有**自己的事实、
  安装命令与措辞，只是把 descriptor 交给这一层排版 —— 换掉布局不会换掉语义。
- Approval 由 `approval.js` 提供 descriptor；它没有安装命令，也没有安装按钮。
- 「安装后重启 Pi」全仓库**只有一处实现**（就是这一层）：先 `confirmModal`，
  再校验 `ownsWorkspace(generation)`，最后调既有的 `restartBackend()`。
  切换了项目就什么都不做 —— **绝不对着新项目重启**。
- Extensions 页把四个 feature 的 setup 挂载为折叠项，并通过
  `renderFeatureSetup(..., { onRegistry })` 在安装后的 recheck 里同步刷新左栏
  Registry 列表：两边看的是同一份新证据，不是两份。

## 六、受控一键安装（Known Capability Installer）

四个已知第三方 Capability 从「复制命令 → 自己开终端 → 回来重启」变成：

```
未安装 → 点「安装」→ 确认 → 后端暂停 Pi → 官方 pi install <固定 source> --no-approve
       → 清缓存 → 恢复（= 重启）Pi → 前端重新读 Extension Registry → 按新证据重画
```

**它是什么、不是什么**（边界与 [security.md](security.md) 的
「Known Capability Installer 边界」一节是同一件事）：

- 只服务 Pi GUI **自己维护**的四个 descriptor。`installId` 由 descriptor 给出
  （`web` / `subagents` / `memory` / `browser`），source 由**服务端固定 allowlist**
  决定 —— renderer 只送 id，**不送** source / packageName / command / args / url。
  未知 id fail closed。
- 不是 Extension 商店：不查 npm、不搜包、不发现陌生 Extension、不 uninstall、
  不 update、**不做 project-local 安装**（不带 `-l`，统一装到用户级，跨项目可用）。
- 执行的永远是**当前那一份 Pi**（launch identity → `buildPiEntry()` → 共享的
  `runCli`），argv 固定 `['install', <allowlisted source>, '--no-approve']`。
- 安装期间 bridge 进维护态（`pauseForMaintenance('capability-install')`）：
  **暂停超时 = 失败**、旧 Pi 没死就一次都不装、只 resume 自己暂停的那次、
  失败也恢复（GUI 不会永久停在维护态）。
- **退出码 0 ≠ 已安装 ≠ 已加载**。后端只回 `commandCompleted: true` 且 `loaded: null`；
  是否真的装上由**重新发现的 Extension Registry**回答。刷新后：
  - `installed === true` → 显示「已安装：Extension Registry 已经发现它」；
  - 仍然没有这个 package → 如实说「安装命令已完成，但尚未确认到 Extension：
    Extension Registry 里还没有它，请刷新或查看诊断」，**绝不伪造绿色 loaded**。
  `installed` / `configured` / `loaded` / `runtimeObserved` 四个状态继续独立。
- 按钮状态：`安装 → 安装中… → 正在重启… → 按 Registry 的证据重画 / 安装失败`，
  期间 disabled（后端另有单飞锁，前端 disabled 只是体验）。
  `installed === null` 时**不显示「安装」**（那不是「确认未安装」，是「无法确认」），
  只给「重新检查」；`installed === true` **不画安装按钮** —— 已安装不是动作，
  状态行已经写着「已安装」，动作区不再重复一个按不动的同名词按钮。
- **四个 feature 设置区走同一条 recheck 路径**（`ui/capability-setup.js` 的
  `renderFeatureSetup()`）：安装成功后重新 `fetchExtensions()`、用新 registry
  重算 descriptor、原地重画，并把新 descriptor 交回给 `runInstall()` 判断
  `state.installed`。**没有 `onRecheck` 的调用点是防线而不是主路径**：那种情况下
  命令成功也只停在「命令已完成，待确认」（disabled），界面**不出现「已安装」**；
  同样地，`installed === null` 又没有 recheck 入口时连按钮都不画
  （不给点了没反应的入口）。
- **复制安装命令保留**，作为高级 / 故障恢复入口。

## 七、Registry 边界

- `server/extension-registry.js` 保持 **generic**：它不知道 `pi-web-access`、
  `pi-memory`、`nativeState` 这些东西的存在。Capability 层知道推荐包名，
  但那只是 **setup metadata**（「磁盘上有没有它」这一条证据的键）。
- **built-in 能力不进 filesystem Extension discovery。** 它们编译在 pi 包里
  （`dist/extensions/`），不属于 `~/.pi/agent/extensions` 的扫描范围；
  在 MCP 能力报告里用 `builtin:` 前缀与「built-in 能力（pi 自带）」小标题
  把自己和普通 Extension 分开。
- **unknown Extension 不丢**：我们完全不认识的 Extension 照样出现在扩展页
  「已安装」里，六个字段保持未知，错误就地显示，仍然可以在那里诊断。

## 八、重启与 stale

- 任何「安装后重启 Pi」都走同一个确认流程与同一个 `POST /api/restart`。
- 结果落地前必须同时过两关：Surface 实例身份（`isCurrent()`）与
  workspace generation（`ownsWorkspace(generation)`）。切了项目之后，
  旧请求回来的是**上一份世界** —— 那一份一个字都不许落地，
  界面改成「项目已切换，刷新后查看当前项目的扩展状态」。
- MCP 配置变化是否需要 reload / restart **按 Pi 当前的真实契约处理**：
  Pi GUI 只代理官方 CLI（add / remove / login / logout），enable / disable /
  reconnect / 改 exposure 没有官方自动化接口，界面上写清楚「请用 pi 的 /mcp 管理器」，
  **不伪造开关**。详见 [mcp.md](mcp.md)。

## 九、明确不做

Marketplace、自动更新、评分、远端 catalog、Extension logo 商店、Agent editor、
Memory browser、Browser manager、第二套 MCP runtime、**任意包安装 / npm 搜索 /
自动推荐陌生 Extension / uninstall / extension update** —— 一个都不做。
独立能力状态页、能力总览计数、能力搜索与过滤器也在 P36 明确移除。

写动作只有三处，且都有明确边界：一键安装（§六，固定 allowlist）、
走官方重启、打开既有的上下文 Tip。

## 十、相关文件与验证

| 文件 | 职责 |
|---|---|
| `public/capability-model.js` | 纯投影：四值状态、适用性收口、结论行、setup 视图模型 |
| `public/ui/capability-setup.js` | 唯一一套 setup 布局 + 唯一的一键安装 + 唯一的「安装后重启 Pi」实现 |
| `public/extensions/` | 扩展页：「已安装」通用 Registry 页 + 「已知能力设置」折叠区，「插件市场」占位 |
| `public/skills/`、`public/mcp-report.js` | 技能设置页；MCP 配置页页尾的能力报告（拆分前与扩展页同在 `public/extensions.js`） |
| `public/*-capabilities.js` | 各 feature 的事实与 descriptor（Registry 证据 → 三值；`installId` 指向服务端 allowlist） |
| `server/capability-install.js` | 受控安装：固定 allowlist、固定 argv、闸门、维护暂停 / 恢复、脱敏错误 |
| `lib/redact.js` | 脱敏唯一实现（Pi 更新与 Capability 安装共用） |

验证：

- `npm run test:capability`（74 条，纯函数、离线）：四值投影、适用性收口
  （NA 不画 / 未声明不画 / **null 仍显示未知** / 诊断无错误不画）、
  built-in / Native MCP 与 unknown Extension、运行观察重置、
  `restartRequired`、stale、一键安装的按钮形态与确认文案、**Registry 无特化**。
- `npm run test:capability-install`（38 条，离线、**用 fake runner，绝不真装包**）：
  allowlist、未知 id fail closed、renderer 不能指定 source、固定 argv
  （没有 `-l` / `--local` / `--approve`）、闸门（确认 / 单飞 / 忙 / 过期 / 入口）、
  暂停失败与超时、只 resume 自己的维护态、失败也恢复、退出码 0 ≠ 已加载、
  脱敏与「原始输出不出后端」、HTTP 层、server.js 装配的共享原语。
- `npm run test:ui` 的「Agent 能力」段：扩展 / 技能 / MCP 配置三个入口、
  「已知能力设置」仍可从扩展页「已安装」到达、一键安装的确认与重新发现后的重画、
  旧能力状态页不再渲染；`npm run test:agent-capabilities`：拆分边界与三个页面的生命周期。
- `npm run test:sidebar-menu`（37 条，jsdom）：菜单单例、锚定 / 翻转 / 夹紧、
  键盘导航、Escape 还焦点、点外部 / resize / 滚动关闭、role 语义，
  以及两个调用点的静态边界（旧类名与字符图标不再出现）。
- `npm run shots:harness` 的场景 **UX-MENU-01…05**（真实 Chrome）：
  菜单不被侧栏裁掉、不跑出窗口、不盖住对话区、danger 只在 hover 时变红、
  trigger 不撑高行。能力安装截图随 P36 的设置页验收覆盖。

截图在 `.shots/` 下。
