# 供应商管理 P4 验收报告

生产基线为 `61aba829b7eb2f280522d3cb17a89f9f6e4fdcae`（`main`，P0＋P1 已合并）。P4 实现在独立分支 `codex/provider-management-p4`；本报告对应的整改前审查提交为 `44a76d2a0ba8820f49768ee1c7556aed02907405`。任务所述固定参考为 [PI-Desktop v0.21.0](https://github.com/vastsa/PI-Desktop/tree/92ae661f1e399e69d514086b46029b4c34ba1a92)。

本报告分为两部分：P4 定型的界面与交互，以及独立验收整改（FIX-01～FIX-05）。整改只修缺陷、补回归与证据，不改变 P4 的既定视觉设计，不扩大到 P3 发现、Runtime 同步或 P5 联调。

## 交付范围

| 区域 | 行为 | 主要文件 |
| --- | --- | --- |
| 服务选择器 | 居中 1040×720 弹窗、搜索、订阅组在前、API Key 组在后、自定义端点固定在组首、四列卡片、订阅不可用状态与真实原因、键盘选择与中文输入法保护。 | [service-chooser.js](../public/provider-management/service-chooser.js)、[catalog.js](../public/provider-management/catalog.js) |
| 服务配置 | 服务身份与更换入口、凭据状态、P0 安全触发器、环境变量引用、OAuth 状态、高级设置、双模型栏、保存与冲突处理；复制只显示中性的“不携带凭据”状态。 | [dialog.js](../public/provider-management/dialog.js)、[connection-fields.js](../public/provider-management/connection-fields.js) |
| 模型管理 | 候选/已选双栏、各自搜索、勾选与可见范围全选、增删、拖拽与键盘排序、自定义模型 ID、上下文/输出上限、推理与输入类型、来源与三值能力、空状态与校验。 | [model-panes.js](../public/provider-management/model-panes.js)、[model-visibility.js](../public/provider-management/model-visibility.js)、[state.js](../public/provider-management/state.js) |
| 发现/测试边界 | `capabilities` 未开放时不发 `/discover`、不伪造加载成功；状态条注明 P3 待接通，刷新和连接测试禁用。 | [discovery.js](../public/provider-management/discovery.js) |
| 供应商列表 | 管理快照列表、添加/编辑/复制/删除确认/停用与启用、只读与兼容性标记、旧版密钥状态告警、保存后待 Runtime 同步提示；管理接口关闭时复用同一套 P4 弹窗走安全兼容路径。 | [providers.js](../public/providers.js) |
| 视觉与主题 | 复用现有 Settings、Modal、Design Tokens 与通知；暗/亮主题、940/720/480 响应式、焦点可见、减少动态效果。 | [provider-management.css](../public/provider-management.css)、[index.html](../public/index.html) |

主页面没有 `<input type="password">`，没有原文密钥，也没有私有 IPC。凭据触发器在生产能力为 false 时保持 disabled；环境变量引用只接受 `$NAME` / `${NAME}`。所有文本经 `textContent` 写入。

## 独立验收整改（FIX-01～FIX-05）

以下五处均先在默认配置或 fixture 下复现，再做最小修复；回归测试先失败后通过。整改没有改动 P0 的 HTTP 合同、P1 仓储/事务、P2 Electron 凭据安全实现，也没有新增后端写入路径。

### FIX-01 管理接口关闭时无法新增/编辑服务

**复现**：默认环境不设 `PI_GUI_PROVIDER_MANAGEMENT` 时，服务列表只剩旧只读列表；点“添加服务”后管理快照探测失败，界面停在“无法读取供应商配置 / 管理能力未开放 / 重试”，新增与编辑都不可用。

**修复**：[providers.js](../public/providers.js) 在确认管理接口不可用后，把旧 `/api/providers` 的 DTO 投影为 P4 快照（`legacySnapshot`），并实现轻量适配器 `createLegacyProviderApi`；P4 的服务选择器、双栏模型、高级设置与校验逻辑全部复用，不复制第二套业务状态机。旧接口没有 `displayName`/`enabled`/模型选择元数据，因此兼容界面隐藏或禁用这些字段，并在页面与弹窗中明确写出限制：

- 旧接口只写 Pi 模型配置，保存后重载 pi 生效；
- 勾选与排序不会落盘；修改列表必须用“移除模型配置”或添加模型，相关交互会被拦截并提示；
- 兼容模式不接受 OAuth 草稿、本机注册引用或清除操作，不做“看起来成功”的假提交；
- 兼容新增/编辑只写 `$NAME`/`${NAME}` 环境变量引用；更新时省略 `apiKey`，由旧路由保留原密钥与未知字段。

管理接口可用时仍使用 P0 的 draft/commit 合同，行为不变。没有默认开启实验开关，没有修改 P0/P1 的权限与存储边界。

**回归**：`management-off add uses the P4 UI over the legacy API without fake fields`、`management-off edit reuses the same model panes and preserves an existing key`（jsdom，含“勾选不假装已保存”断言）；`legacy route still supports update and create while management is disabled`（真实 HTTP 路由，断言省略 `apiKey` 保留旧值、创建环境变量引用成功）。

### FIX-02 Pi 本机凭据清除语义错误

**复现**：`credentialState.source === 'pi-credential'` 时，界面仍显示可点的“清除凭据”；提交会生成 `{type:'none', confirmed:true}`，而该动作只删除 `models.json` 的 `apiKey`，不会调用 Pi logout，也不会写 `auth.json`。

**修复**：[state.js](../public/provider-management/state.js) 新增 `credentialClearSupport`，按来源给出明确语义；[connection-fields.js](../public/provider-management/connection-fields.js) 只在受支持且非兼容模式时启用清除按钮，并显示原因；[catalog.js](../public/provider-management/catalog.js) 不再把配置内字面量/命令引用标成“Pi 本机凭据”。

| 来源 | 清除能力 | 实际删除范围 |
| --- | --- | --- |
| 环境变量引用 `env` | 可用 | 删除配置中的环境变量引用；环境变量本身与 Pi 本机登录不删 |
| 配置内字面量 `literal` | 可用 | 删除配置中的字面量 `apiKey`；Pi 本机登录不删 |
| 配置内命令 `command` | 可用 | 删除配置中的命令取值引用；命令本身与 Pi 本机登录不删 |
| Pi 本机凭据 `pi-credential` | 禁用 | 保留 P2 安全桌面窗口入口；不写 `auth.json`，不把 `none` 伪装成已清除 |
| 未知来源 `unknown` | 禁用 | 先确认认证来源；不猜测清除范围 |
| OAuth | 不提供清除 | 走既有 Pi 登录/认证视图，不在配置页清除 |

`commitCredentialAction` 对不受支持的来源返回 `keep`，不会发送 `none`；兼容模式也不发送 `none`。主页面没有新增 API Key 输入框，没有直接读写 `auth.json`，P2 的 `[data-credential-trigger]` 集成点保留。

**回归**：`credential clear support distinguishes config references from Pi native credentials`、`Pi native credential clear is disabled with an accurate reason and never sends none`、`config-owned credential clear states exactly what will and will not be removed`。

### FIX-03 删除确认文案与实际语义不符

**复现**：原文案写“模型与凭据会随配置一起移除”，会让用户以为 Pi 本机认证也会被删除；后端实际对内置服务只停用、对自定义服务删除 Pi 配置，并在可能回落到另一个内置端点时拒绝操作。

**修复**：[providers.js](../public/providers.js) 的确认框区分只读/内置停用与自定义删除，明确“不会删除 Pi 本机认证（auth.json）或环境变量”，并说明安全检查可能拒绝删除。删除权限、二次确认和既有后端检查均未改动；成功提示改成中性的“服务变更已保存，等待 Runtime 同步”，不再用“已删除”覆盖两种语义。

**回归**：`delete confirmation distinguishes config removal from native authentication`；既有菜单删除/复制确认测试保留。

### FIX-04 “更多操作”菜单开合状态错误

**复现**：第一次点击打开后，第二次点击同一按钮时，菜单先被全局 closer 关掉、随后按钮又打开，`aria-expanded` 变成 `false` 而菜单仍可见；跨行切换、点外部、Escape 与焦点恢复也不一致。

**修复**：[providers.js](../public/providers.js) 把菜单状态收敛到单个 `menuCloser`：同一按钮二次点击关闭；打开另一行先关闭旧菜单；点击外部关闭；Escape 关闭并把焦点还给触发按钮；`aria-expanded` 与 `hidden` 始终同步。全局 click/keydown 监听只在菜单打开期间挂载、关闭时移除，`renderProviders` 与面板关闭会清理旧监听，避免重复监听。行本身点击编辑、Enter/Space 编辑与行内按钮事件隔离保持原行为。

**回归**：`more menu toggles, closes other rows, and keeps aria-expanded in sync`（jsdom 鼠标与键盘）。

### FIX-05 无关编辑可能静默固定继承的模型选择

**复现**：服务 `selectedModelIds:null`（继承 Pi 模型列表）时，只改名称/启用状态等无关字段，`draft.inheritedSelection` 仍为 true，但保存会提交显式的 `selectedModelIds`，从而把“继承”静默改成“固定选择”。

**修复**：先核对冻结的 P0 合同——commit 只接受显式 `selectedModelIds`，无法表达“继续继承”。因此不改后端合同，也不静默改变状态：[state.js](../public/provider-management/state.js) 新增 `needsInheritedSelectionConfirmation`；[dialog.js](../public/provider-management/dialog.js) 在继承态且用户未触碰选择时显示说明条，保存前弹出“固定当前模型选择？”确认。确认后才提交显式列表；取消则保持原状。零选择仍是有效状态；`selectedModelIds` 决定选中集合，`modelOrder` 只负责顺序，二者没有被混用。

**未解决（合同限制）**：如果要让“只改名称/启用状态”保留继承语义，需要 P0/P5 扩展 commit 合同（例如显式 `inherit:true` 或可选的 `selectedModelIds:null`）并由后端做迁移校验。本轮不私自修改后端合同；已在界面用确认框提供可理解的真实选择，并记录为后续提案。

**回归**：`inherited selection requires explicit confirmation for unrelated edits`、`inherited model selection asks before an unrelated edit pins it`、`explicit selection, zero selection and model order keep their own semantics`；既有继承顺序回归保留。

## 与两张参考图的对照

参考图为任务提供的 REF-013（服务选择器）与 REF-014（服务配置）。截图未归档进仓库，下面是按参考提交源码、参考图和真实渲染截图逐项对照的结果。

| 对照点 | REF-013 服务选择器 | P4 实现 | 差异与原因 |
| --- | --- | --- | --- |
| 弹窗 | 1040×720 居中、遮罩、16px 内边距 | 同尺寸与层级，仅正文滚动 | 一致 |
| 搜索与分组 | 搜索框；订阅组在前、API Key 组在后 | 同顺序；自定义端点固定在 API 组首位 | 一致 |
| 卡片网格 | 四列、圆形字母标识、名称与端点 | 四列；名称、端点/环境变量提示、选中与不可用状态 | P0 目录只有 13 个条目；不凭空补参考图中的其它供应商 |
| 订阅能力 | 可登录的订阅直接发起现有 Pi 登录 | 仅当 `oauthLogin` 与对应 auth provider 同时可用才可点；否则显示“待接通” | 不创建假登录；未接通状态是真实能力 |
| 键盘 | 搜索框上下键进入卡片，方向键移动，Enter 选择 | 同交互，并保护中文输入法合成事件 | 额外提供“方向键选择”提示 |
| 服务配置顶带 | 左服务卡（名称、端点、更换），右 API 密钥 | 同样左右双栏；右侧为 P0 凭据状态/触发器与环境变量引用 | 参考图的密钥输入框属于 P2；P4 只保留冻结的安全触发器 |
| 模型双栏 | 候选模型/模型设置，独立搜索、全选、已选顺序、底部自定义模型 | 同结构；已选栏支持拖拽、键盘排序、参数展开与移除 | P3 的远端获取/自动推荐未接通，显示禁用原因而不是 fixture 成功态 |
| 高级设置 | 头部“高级设置”入口 | 独立视图包含名称、启用、Endpoint、API 类型、供应商标识、目录条目、本机注册引用与兼容性 | 端点/API 从主配置页移入高级，主配置页留给模型选择 |
| 复制服务 | 参考图未覆盖 | 保留当前模型与顺序，清空凭据状态，显示“复制不携带凭据”，不提供密钥输入、清除或更换入口 | 合同要求复制使用 `authMode:'none'` + keep，界面不暗示凭据会被继承 |
| 主题与窄窗 | 深色参考图；固定双栏 | 暗/亮截图；940px 以下双栏堆叠、720px 以下顶带单列 | 窄窗允许正文滚动，顶部操作保持可见 |

### 本轮截图证据

本轮截图位于 `.shots/p4-fix/`（Git 忽略），由**真实 app server + 真实 Chromium 渲染进程**通过 CDP 采集；fixture 只替换供应商相关路由，页面 DOM/CSS 与生产 `public/` 相同。报告与逐图尺寸见 `.shots/p4-fix/report.json`。

- [供应商列表（深色，菜单展开）](../.shots/p4-fix/01-list-dark-menu-open.png) — 1205×803
- [服务选择器（深色）](../.shots/p4-fix/02-chooser-dark.png) — 1205×803
- [服务配置/双栏模型（深色）](../.shots/p4-fix/03-setup-dark.png) — 1205×803
- [服务配置/双栏模型（浅色）](../.shots/p4-fix/04-setup-light.png) — 1205×803
- [高级设置（浅色）](../.shots/p4-fix/05-advanced-light.png) — 1205×1000
- [Pi 本机凭据清除禁用 + 继承说明（浅色）](../.shots/p4-fix/06-native-credential-inherited-light.png) — 1205×803
- [删除确认文案（浅色）](../.shots/p4-fix/07-delete-confirm-light.png) — 1205×803
- [700×760 窄窗](../.shots/p4-fix/08-setup-narrow-light.png) — 700×760
- [管理接口关闭：兼容列表（浅色）](../.shots/p4-fix/09-legacy-list-light.png) — 1205×803
- [管理接口关闭：兼容编辑器（浅色）](../.shots/p4-fix/10-legacy-setup-light.png) — 1205×803

**环境说明（如实记录）**：本轮 Electron 窗口在当前机器上无法启动，Chromium 的 `process_singleton_win.cc` 在创建 profile 锁时返回“拒绝访问”(0x5)，`DevToolsActivePort` 写入同样被拒；因此改用同一台机器、同一套 `public/` 资源的 Chrome 157 headless（UA `HeadlessChrome/157.0.8103.39`）完成截图。截图证明的是真实 Chromium 布局与交互，不等同于 Electron 外壳或打包安装验证；上一版 Electron 证据保留在 `.shots/p4/`，不作为本轮整改后的证据。

## 实际验证

Windows x64，Node v24.22.1，Electron 44.4.3（本轮 Electron 窗口受限，见上）。

| 证据层 | 命令或场景 | 结果 |
| --- | --- | --- |
| 定向功能 | `npm run test:provider-management` | 62/62 通过，退出 0，跳过 0；P4 UI 文件由 30 条增至 40 条，新增 1 条旧路由 HTTP 集成回归，原有 21 条后端合同测试保留。 |
| 冒烟回归 | `node tests/smoke.cjs` | 1345/1345 通过，退出 0。供应商页与添加流程已改写，断言数未减少。 |
| 设置与集成 | `node tests/ux-state.cjs` / `node tests/ui-ia.cjs` / `node tests/settings-acceptance.cjs` | 15/15、27/27、16/16，退出 0。 |
| UI4 回归 | `npm run test:ui4` | 56/56 通过，退出 0，failed=0，skipped=0。 |
| CI 计划 | `node tests/ci-test-plan.cjs` | 236 个叶子、5 个分组，覆盖精确（coverage exact）。 |
| 本地完整 canonical | `npm test` | 退出 0，全链通过；对象 witness 按环境跳过 8 项（`existing_token_sacl_unavailable`，不计入分子分母）。日志 `.shots/npm-test.log`。全量运行后仅调整了凭据清除按钮的展示文案，定向套件随后复跑 62/62。 |
| 管理接口关闭 | jsdom 新增/编辑回归 + 真实旧路由 HTTP 集成 | 新增与编辑均可用；旧接口省略 `apiKey` 保留原密钥与外层未知字段；不出现假字段/假成功。 |
| 管理接口开启 | P4 UI fixture + 既有 40 条 UI 测试 | 新增/编辑/复制/删除/停用路径保持；服务选择器、双栏模型、高级设置与列表均渲染。 |
| 凭据来源与清除 | 来源矩阵测试 + 截图 06 | env/literal/command 可清除且文案写明范围；pi-credential/unknown 禁用并给出原因；`none` 不会在不受支持时提交。 |
| 菜单交互 | jsdom 鼠标/键盘回归 + 截图 01 | 首次打开、同按钮二次关闭、跨行切换、外部点击、Escape 焦点恢复；`aria-expanded` 与可见性一致；无重复全局监听。 |
| 继承模型 | 状态/UI 回归 | 继承态无关编辑保存前必须确认；显式选择、零选择、`modelOrder` 顺序语义各自保留。 |
| 真实渲染 | Chromium 157 headless + 真实 server；1205×803、700×760、高级设置 1205×1000 | 选择器 13 卡、列表 3 行、已选 2 模型、密码输入 0、控制台异常 0；窄窗 700×760 正文无溢出，弹窗宽 684。 |
| 打包产物 | `npm run build:app -- --rebuild` / `npm run build:exe` | `dist-app/Pi GUI-win32-x64` 345,601,852 bytes；`build/Pi GUI.exe` 103,440,896 bytes，SHA-256 `279089c9ab706075b2f37091a851f7a997f550fbac27876b75b10b8e317fc1ba`。已核对打包后的 `dialog.js`/`connection-fields.js`/`providers.js`/`state.js` 含本轮整改字符串。 |
| P2/P3 真实能力 | 未验证（未运行） | 未使用真实密钥、OAuth、供应商网络请求或真实 Pi 模型。 |
| 独立审查 | 独立上下文复审当前工作区 diff | P4 首轮及第二轮处置见下；本轮整改后仍需独立复审。 |

## 独立审查处置（P4 首轮与第二轮）

首轮独立审查发现 1 个 Blocker、7 个 Important 和 2 个 Nit；以下修复均有对应测试或静态核对：

| 问题 | 处置 |
| --- | --- |
| 管理接口默认关闭时整页旧供应商列表被吞掉 | 只有旧路由也失败时才显示错误；管理接口 `unsupported` 不再抑制旧列表。新增 jsdom 回归。 |
| 冲突恢复把不透明字符串 revision 当成安全整数 | `readLatestSnapshot` 接受非空字符串；冲突时恢复“重读并继续 / 重新载入 / 复制”动作。 |
| 移除后再加回同一模型仍发送 `remove` 补丁 | 暂存被移除记录，重新加入时恢复并撤销 remove；新增纯状态回归。 |
| 复制对话框展示源凭据，并允许提交必然失败的凭据动作 | 复制草稿清空 `credentialState`，界面只显示“复制不携带凭据”，隐藏密钥输入、清除与更换入口。 |
| 重试不复用 requestId | 同内容重试复用草稿与提交 ID；草稿成功且内容未变时不再重发草稿。新增网络失败重试回归。 |
| create 的凭据冲突提供没有来源的“复制”动作 | 仅当存在 `sourceServiceId` 时提供复制；自定义 create 可修改供应商标识，其它情况提示返回选择服务。 |
| 行内“更多操作”按 Enter 被行级键盘处理抢开编辑 | 行级 keydown 只处理目标为行本身的事件；新增键盘回归。 |
| `selectedModelIds:null` 被 `modelOrder` 缩窄 | `selectedModelIds` 决定选中集合，`modelOrder` 只排序；新增继承选择回归。 |
| 高级模型字段缺少可访问名称 | 显示名、上下文窗口、最大输出、推理能力补 `aria-label`，并在测试中断言。 |
| Electron final-remediation fixture 从 commit 读不存在的 `draft` | 改为保存 `/drafts` 的草稿负载供 commit 使用，并同步 revision；该环境仍只能做语法核对。 |
| 第二轮：重读并继续后复用旧 draft requestId | requestId 按请求内容/版本键控；丢弃草稿句柄时清空 ID。新增点击“重读并继续”后 revision 变化的回归，断言第二轮 draft/commit ID 均轮换。 |
| 第二轮：复制高级设置仍可写本机注册引用 | clone 强制 `authMode:'none'`、commit keep、payload 不写 `piRegistrationReference`，高级输入 disabled 并显示原因；状态与 UI 均有断言。 |

第三轮 P4 独立复核确认上述两项均 resolved。本轮（独立验收整改）又新增 FIX-01～FIX-05 的复现、修复与回归，结论见上文；本轮结束时等待下一轮独立复审。

## 后续阶段

- **P2**：接通桌面凭据输入窗、私有桥与确认后的凭据保存；P4 已保留 `[data-credential-trigger]` 与 disabled 原因，主页面没有替代输入框。Pi 本机凭据清除继续只在 P2 安全路径处理。
- **P3**：接通发现授权、缓存/刷新、连接测试、自动推荐与 Runtime 同步；P4 已渲染 `unsupported` 状态并禁用按钮，测试确认不会发起未授权请求。
- **P5**：只做能力接入和缺陷修复；主布局、双栏模型区、选择器与服务列表已在本轮定型，不需要再次重构。P0 的继承语义扩展（允许 commit 表达“继续继承”）作为合同层提案单独评审，不在本轮擅自修改。
- **P4 兼容路径**：管理接口关闭时使用旧 `/api/providers` 的轻量适配器，受旧 DTO 能力限制（无显示名/启用/模型选择元数据，不能清除凭据）；管理接口开启时仍走完整 P0 合同。P5 联调时确认默认能力开关的最终策略，不为兼容而默认开启实验开关。

## 限制与回滚

- 本轮截图使用 Chrome headless，不是 Electron 窗口；Electron 主进程在当前机器无法创建 profile 锁（0x5）。真实 Electron 场景仍需在可写桌面环境补验；不以 Chromium 截图冒充 Electron 真机通过。
- 真实 Electron 截图（上一版）使用 `--no-sandbox` 与 P0 fixture；证明的是真实渲染与交互，不是真实供应商连接、真实凭据或打包安装升级。
- 未验证 P2/P3 接通后的失败、缓存和同步画面；`discovery.js` 保留了状态机，但本轮生产分支不会调用远端。
- 管理接口关闭时的兼容路径只支持旧接口真实具备的字段与操作；勾选/排序、清除凭据、OAuth、本机注册引用均明确不可用，不显示假成功。旧内联表单未恢复，避免同时维护两套最终 UI。
- 回滚：回退本分支的 P4 实现、整改、测试与报告提交。整改没有新增后端写入路径，不修改 P2 Electron 凭据代码、P1 仓储、配置事务或 Runtime owner；不会改动用户真实配置。
- 合并与发布均需另行明确授权。本报告只记录开发、验证与分支推送状态；按用户要求本轮不创建 PR、不合并 `main`、不发版。
