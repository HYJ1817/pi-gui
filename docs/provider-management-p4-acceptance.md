# 供应商管理 P4 验收报告

生产基线为 `61aba829b7eb2f280522d3cb17a89f9f6e4fdcae`（`main`，P0＋P1 已合并）。P4 实现在独立分支 `codex/provider-management-p4`；本报告对应的首轮整改前审查提交为 `44a76d2a0ba8820f49768ee1c7556aed02907405`，最终验收整改前的审查提交为 `894b88b12e0eb1bbef2057a6220d9981bd446232`。任务所述固定参考为 [PI-Desktop v0.21.0](https://github.com/vastsa/PI-Desktop/tree/92ae661f1e399e69d514086b46029b4c34ba1a92)。

本报告分为四部分：P4 定型的界面与交互、首轮独立验收整改（FIX-01～FIX-05）、最终验收整改（FIX-06～FIX-08）与 P2 集成结果。整改只修缺陷、补回归与证据，不改变 P4 的既定视觉设计，不扩大到 P3 发现、Runtime 同步或 P5 联调。

## 交付范围

| 区域 | 行为 | 主要文件 |
| --- | --- | --- |
| 服务选择器 | 居中 1040×720 弹窗、搜索、订阅组在前、API Key 组在后、自定义端点固定在组首、四列卡片、订阅不可用状态与真实原因、键盘选择与中文输入法保护。 | [service-chooser.js](../public/provider-management/service-chooser.js)、[catalog.js](../public/provider-management/catalog.js) |
| 服务配置 | 服务身份与更换入口、凭据状态、P0 安全触发器、环境变量引用、OAuth 状态、高级设置、双模型栏、保存与冲突处理；复制只显示中性的“不携带凭据”状态。 | [dialog.js](../public/provider-management/dialog.js)、[connection-fields.js](../public/provider-management/connection-fields.js) |
| 模型管理 | 候选/已选双栏、各自搜索、勾选与可见范围全选、增删、拖拽与键盘排序、自定义模型 ID、上下文/输出上限、推理与输入类型、来源与三值能力、空状态与校验。 | [model-panes.js](../public/provider-management/model-panes.js)、[model-visibility.js](../public/provider-management/model-visibility.js)、[state.js](../public/provider-management/state.js) |
| 发现/测试边界 | `capabilities` 未开放时不发 `/discover`、不伪造加载成功；状态条注明 P3 待接通，刷新和连接测试禁用。 | [discovery.js](../public/provider-management/discovery.js) |
| 供应商列表 | 管理快照列表、添加/编辑/复制/删除确认/停用与启用、只读与兼容性标记、旧版密钥状态告警、保存后待 Runtime 同步提示；管理接口关闭时复用同一套 P4 弹窗走安全兼容路径。 | [providers.js](../public/providers.js) |
| 视觉与主题 | 复用现有 Settings、Modal、Design Tokens 与通知；暗/亮主题、940/720/480 响应式、焦点可见、减少动态效果。 | [provider-management.css](../public/provider-management.css)、[index.html](../public/index.html) |

主页面没有 `<input type="password">`，没有原文密钥，也没有私有 IPC。P4 不接入 P2 凭据窗口的生命周期；即使 P2 能力快照给 `privateDesktopBridge: true`，凭据触发器仍保持 disabled，并显示“桌面凭据输入待 P5 集成”，避免打开只显示占位说明的死入口。环境变量引用只接受 `$NAME` / `${NAME}`。所有文本经 `textContent` 写入。

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

## 最终验收整改（FIX-06～FIX-08）

以下三处同样先在测试或真实渲染中复现，再做最小修复。没有改动 P0 的 HTTP 合同、P1 仓储/事务、P2 Electron 凭据实现；没有新增后端写入路径，也没有通过默认开启实验开关绕过问题。

### FIX-06 兼容模式删除缺少二次确认

**复现**：管理接口关闭时，`legacyRow()` 的删除按钮直接调用 `removeProvider(name)`；jsdom 回归显示确认层保持隐藏，点击一次即发出 DELETE。失败路径也没有保留列表与真实错误的前端处理。

**修复**：[providers.js](../public/providers.js) 复用既有 `confirmModal()`，在发请求前明确说明：

- 将从 Pi 模型配置中移除该供应商及其模型设置；
- 不会删除 Pi 本机认证（`auth.json`）或系统环境变量；
- 如果端点需要认证，后端安全检查仍可能拒绝删除。

取消返回 `{ok:false,cancelled:true}`，不发送任何网络请求；鼠标点击与 Enter/Space 键盘都进入同一个确认入口，且按键不会触发第二次弹窗。`removeProvider` 不再接受调用方传入的“已确认”标志，导出函数无法绕过二次确认。确认后再次校验管理接口仍是“明确未启用”，再调用旧 DELETE。删除失败时保留当前列表，toast 显示服务端真实错误；成功才重新加载。P0/P1 的后端权限与安全检查未改动。

**回归**：`legacy delete asks first and cancel never sends DELETE`、`legacy delete supports keyboard confirmation and sends exactly one DELETE`、`legacy delete failure keeps the row and shows the real error`。真实 Chromium 证据：`.shots/p4-final/01-legacy-delete-confirm.png`、`02-legacy-delete-cancelled.png`、`03-legacy-delete-failure-kept-list.png`。

### FIX-07 管理接口错误被误当成“功能关闭”

**复现**：旧实现只把管理响应分成“有 `services`”与“其它”，于是网络失败、HTTP 500、403、响应合同异常都会进入旧 `/api/providers` 编辑器；回归用例中这些场景确实渲染出旧列表并可写入。

**修复**：

- [api.js](../public/api.js) 的 `fetchProviderManagement()` 不再复用吞掉状态码的 `getJSON`，保留 HTTP 状态与固定错误码；响应正文解析失败记为 `invalid_response`，网络异常记为 `unavailable`，不把正文文本当成能力判断依据。
- [providers.js](../public/providers.js) 新增 `classifyManagement()`：只有 `code:'unsupported'` 且状态属于 200/400/404/405/422 才判定为“明确未启用”；网络失败、401/403、5xx、非 2xx 但带成功正文、200 但字段形状不对，全部进入错误态。
- 错误态渲染独立错误卡，说明“不会自动切换旧接口写入”，并提供“重试”按钮重新读取管理快照；不会读取旧列表或打开旧编辑器。
- `createLegacyProviderApi` 在保存草稿、提交草稿前重新探测管理接口；`openLegacyEdit`、`removeProvider`、`openAddProvider` 同样在写入前复核。页面打开后管理接口恢复或出错时，旧路径立即停止，不再写盘。
- 默认管理关闭时仍可新增/编辑/删除，兼容路径能力与限制不变。

**回归**：`management 500 is not treated as disabled and never falls back to legacy writes`、`management network failure and 403 do not enable the legacy editor`、`malformed management response is a contract error, not feature-off`、`management 200 with a foreign body is a contract error, not feature-off`、`legacy mode rechecks management before adding after an API failure`、`legacy editor refuses to save if management stops being explicitly disabled`、`management error retry re-reads the management snapshot`。真实 Chromium 证据：`.shots/p4-final/05-management-error.png`、`06-management-retry-recovers.png`。

**重点验证结论**：没有任何用例出现“管理 API 出错，旧 API 却意外写入成功”。错误态下 `calls.legacyPosts`、`calls.legacyDeletes` 与草稿/提交计数均为 0；恢复后重试只重新读取管理快照，不触发旧写入。

### FIX-08 重载 Pi 配置清空当前对话视图

**复现**：`reloadPi()` 先调用 `restartBackend()`，随后无条件调用 `clearThread()`，直接清空 `S.thread` 与消息视图。即使重启请求失败，视图也已经被清空。

**修复**：先核对现有恢复链——`/api/restart` 走 `rpc-bridge` 的 `--continue`/`--session`，桥就绪后 `app.js` 的 `boot()` 会通过 `get_tree`/`get_messages` 重建线程，因此主动清空视图既无必要，也会在重启失败时误伤当前内容。[providers.js](../public/providers.js) 移除 `clearThread` 导入与调用；重载只重启后端并等待结果。成功时提示“当前对话视图会保留，pi 重连后按现有配置恢复会话”，失败时保留当前视图并显示真实错误。`app.js` 的重启确认文案同步改为“当前对话视图会保留，pi 重连后按现有配置恢复会话”。这里的“按现有配置”对应 `--continue` / `--session` / `PI_NO_CONTINUE` 的真实启动行为，不承诺绕过这些配置强制恢复。重载流程没有新增对其它 Runtime 的取消、切换或清空调用；用户确认重启仍会按既有语义中断当前生成。完整 Runtime 同步、会话映射与跨 Runtime 恢复仍属于 P3，本轮不实现新的同步协调器，也不删除重载入口。

**回归**：`reload keeps the current conversation thread`、`failed reload keeps the thread and shows the real error`。真实 Chromium 证据：`.shots/p4-final/04a-reload-before.png` 与 `04-reload-keeps-thread.png`（点击页面底部“重载 pi 配置”按钮前，注入的对话内容在正文中可见；点击后面板关闭、同一对话内容仍在，`/api/restart` 仅调用一次，提示文案可见）。

### 继承语义复核（未改合同）

本轮只复核既有行为，不修改 P0 commit 合同：

- `inherited selection requires explicit confirmation for unrelated edits`：无关编辑不会静默固定继承状态，保存前必须确认；
- `explicit selection, zero selection and model order keep their own semantics`：显式选择、`selectedModelIds: []` 零选择、`modelOrder` 只负责顺序，三者互不替代；
- 取消确认不会写入：FIX-06 的取消路径与继承确认取消路径均断言请求计数为 0。

“让 commit 直接表达继续继承”仍需 P5 合同扩展（例如显式 `inherit:true` 或允许 `selectedModelIds:null`），本轮记录为 P5 集成事项，不擅自修改后端。

### P2 集成结果

- 已把 `origin/main` 的 P2 合并进 `codex/provider-management-p4`，合并提交 `dbc178d`；唯一冲突在 `package.json`，已合并为同时保留 `test:provider-management` 的 P4 UI 文件和 `test:provider-p2`，canonical `test` 链同时包含两者。
- P2 的 Electron CredentialSheet、私有凭据桥、网络策略与同意存储文件全部原样保留；P4 没有修改 `electron/`、`server/provider-credential-*.js`、`server/provider-network.js` 等 P2 实现。
- `public/api.js` 与 P2 无重叠；P2 把 `server/provider-management.js` 的快照改为 async，P0 路由已正确 `await`，P4 的状态分类读取到同样的 `{ok,schemaVersion,revision,capabilities,catalog,services,auth,sync}` 合同。
- `providerManagementCapabilities({desktop})` 新增的桌面能力位不会让 P4 打开未接入的入口：[connection-fields.js](../public/provider-management/connection-fields.js) 在 `privateDesktopBridge:true` 时仍禁用触发器，原因显示“桌面凭据输入待 P5 集成”；新增回归 `P2 desktop capability stays behind an honest P5 gate in P4`。
- P2 回归全部通过：网络策略 37/37、credential opening 5/5、Electron 桌面凭据 42/42 checks，说明合并没有破坏已验收的 P2 安全边界。P4 仍未接入凭据窗口，也没有提前实现 P3/P5。
- **P2 集成是否引入新问题**：合并本身没有产生冲突或测试回归；唯一新增的可达状态是 P2 令 `privateDesktopBridge` 可为 true，而 P4 尚未接入窗口。若不处理，用户会看到一个点开后只显示占位说明的死触发器；本轮用 P5 闸门保持其 disabled 并给出准确原因，未改动 P2 的任何实现。除此之外未发现 P2 集成引入的新问题。

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

### 最终验收截图证据

最终整改的截图位于 `.shots/p4-final/`（Git 忽略），同样由真实 app server + 真实 Chromium 渲染进程通过 CDP 采集；报告与尺寸见 `.shots/p4-final/report.json`。采集脚本为 `.shots/p4-final-chrome-capture.cjs`（仅开发期证据工具，不进产品构建）。

- [兼容模式删除确认（浅色）](../.shots/p4-final/01-legacy-delete-confirm.png) — 1205×803
- [取消后列表保留、DELETE 计数为 0](../.shots/p4-final/02-legacy-delete-cancelled.png) — 1205×803
- [删除失败保留列表并显示真实错误](../.shots/p4-final/03-legacy-delete-failure-kept-list.png) — 1205×803
- [点击“重载 pi 配置”前：对话内容在正文中](../.shots/p4-final/04a-reload-before.png) — 1205×803
- [重载后当前对话仍在，面板已关闭且提示可见](../.shots/p4-final/04-reload-keeps-thread.png) — 1205×803
- [管理接口 500：错误卡与重试入口](../.shots/p4-final/05-management-error.png) — 1205×803
- [重试后恢复管理列表](../.shots/p4-final/06-management-retry-recovers.png) — 1205×803
- [P2 能力为 true 时触发器仍禁用（P5 闸门）](../.shots/p4-final/07-p2-capability-p5-gate.png) — 1205×803

**限制**：Chrome 以 `--no-sandbox` 运行（与上一轮相同），这不是正常沙箱验证，也不是 Electron 外壳验证；真实 Electron 删除确认、重载按钮与错误态交互仍需在可写桌面环境补验。

## 实际验证

Windows x64，Node v24.22.1，Electron 44.4.3（本轮 Electron 窗口受限，见上）。

| 证据层 | 命令或场景 | 结果 |
| --- | --- | --- |
| 定向功能 | `npm run test:provider-management`（合并 P2 后） | 76/76 通过，退出 0，failed=0，skipped=0；其中 P4 UI 文件 53 条，含 FIX-06～FIX-08 的 13 条回归与 1 条 P2 能力闸门回归。 |
| P2 回归 | `npm run test:provider-p2`（合并 P2 后） | 网络策略 37/37、opening 5/5、桌面凭据 42/42 checks，退出 0，failed=0，skipped=0。 |
| 冒烟回归 | `node tests/smoke.cjs` | 1345/1345 通过，退出 0。供应商页与添加流程已改写，断言数未减少。 |
| 设置与集成 | `node tests/ux-state.cjs` / `node tests/ui-ia.cjs` / `node tests/settings-acceptance.cjs` | 15/15、27/27、16/16，退出 0。ui-ia 的默认装配改为真实关闭形状（HTTP 422 + `unsupported`），删除路径按新的二次确认交互断言，断言数未减少。 |
| UI4 回归 | `npm run test:ui4` | 56/56 通过，退出 0，failed=0，skipped=0。 |
| CI 计划 | `node tests/ci-test-plan.cjs` | 239 个叶子、5 个分组，覆盖精确（coverage exact）；`test:provider-p2` 与 P4 UI 文件均被 canonical `test` 链覆盖。 |
| 本地完整 canonical | `npm test`（合并 P2 后） | 退出 0，全链通过，没有 failed/not ok；环境性跳过共 21 项：`session-revert-sacl-witness` 8、`Object witness` 8（均为 `existing_token_sacl_unavailable` / `audit_privilege_unavailable`，不计入分子分母），`session-revert-inplace` 2（research only）、`Collab store` 1、`Candidate adoption` 1、`logging-leaks` 1。日志 `.shots/npm-test-p4-final.log`。 |
| 管理接口关闭 | jsdom 新增/编辑/删除回归 + 真实旧路由 HTTP 集成 + Chromium 截图 | 新增与编辑均可用；删除先确认、取消不发 DELETE、失败保留列表；旧接口省略 `apiKey` 保留原密钥与外层未知字段；不出现假字段/假成功。 |
| 管理接口开启 | P4 UI fixture + 53 条 UI 测试 + Chromium 截图 | 新增/编辑/复制/删除/停用路径保持；500/网络/403/异常响应进入错误态并可重试恢复；P2 能力为 true 时凭据触发器仍禁用并显示 P5 原因。 |
| 凭据来源与清除 | 来源矩阵测试 + 截图 06（上一轮） | env/literal/command 可清除且文案写明范围；pi-credential/unknown 禁用并给出原因；`none` 不会在不受支持时提交。 |
| 菜单交互 | jsdom 鼠标/键盘回归 + 截图 01（上一轮） | 首次打开、同按钮二次关闭、跨行切换、外部点击、Escape 焦点恢复；`aria-expanded` 与可见性一致；无重复全局监听。 |
| 继承模型 | 状态/UI 回归（本轮复核） | 继承态无关编辑保存前必须确认；显式选择、零选择、`modelOrder` 顺序语义各自保留；取消不写入。 |
| 真实渲染（最终整改） | Chromium 157 headless + 真实 server；1205×803 | `.shots/p4-final/report.json`：删除确认可见且含 `auth.json`/环境变量边界；取消后 DELETE=0；确认后失败保留 1 行并显示真实错误；重载前后对话标记均在正文中可见、`/api/restart` 计数 1；管理 500 显示错误卡且旧列表 0 行；重试后恢复 2 行；P2 能力 true 时触发器 disabled、title 为“桌面凭据输入待 P5 集成”、密码输入 0。 |
| 打包产物 | `npm run build:app -- --rebuild`（内含 `build-exe.mjs`） | `dist-app/Pi GUI-win32-x64` 345,678,020 bytes（411 files）；`build/Pi GUI.exe` 103,476,224 bytes，SHA-256 `b94b76137cc4709acee5ed593a662b3bb70ee6f4af53de3dae14d1bf844f4b57`。已核对打包后的 `public/providers.js` 含“已停止自动降级”“不会删除 Pi 本机认证”，`connection-fields.js` 含“桌面凭据输入待 P5 集成”。未启动打包后的应用做交互验收。 |
| P2/P3 真实能力 | P2 桌面凭据测试已运行；P3 未验证 | P2 的 Electron CredentialSheet/私有桥/网络策略测试通过（网络策略 37/37、opening 5/5、desktop 42/42 checks）。未使用真实密钥、OAuth、供应商网络请求或真实 Pi 模型；P3 发现与 Runtime 同步未接通。 |
| 独立审查 | 独立上下文复审当前分支 diff | 未发现未修复的阻断项；指出并已处理“删除确认可被调用方跳过”（`65881ff`）与“管理关闭用例未用真实 422 形状”（`970ec24`）。另记录 Add 使用已加载快照、管理开关在页面打开后变化的非安全边界，留作 P5 动态能力切换处理。最终人工验收仍待用户完成。 |

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

第三轮 P4 独立复核确认上述两项均 resolved。本轮（独立验收整改）又新增 FIX-01～FIX-05 的复现、修复与回归；最终验收整改新增 FIX-06～FIX-08，并在合并 P2 后完成兼容性检查，结论见上文。

最终整改完成后另做了一次独立上下文复审（只读审查当前分支 diff）。复审未发现未修复的阻断项，指出的两处已处理：`removeProvider` 的 `confirmed` 绕过入口已删除；管理关闭测试已改用真实 HTTP 422 形状。复审还指出一个非安全边界：页面已持有管理快照后，若管理开关被关闭，再点“添加服务”会打开管理编辑器，提交会失败但不会降级旧接口写入；该动态能力切换留作 P5 集成事项。本轮结束时等待独立验收，不把 AI 复审意见当作人工批准。

## 后续阶段

- **P2**：桌面凭据输入窗、私有桥、网络策略与同意存储已合并到本分支并通过 P2 测试；P4 仍未接入其窗口生命周期，凭据触发器保持 disabled 并显示“桌面凭据输入待 P5 集成”。P5 接入 `window.piGuiDesktop.providerCredentials.open/cancel/status/onState`，并按 P2 合同处理草稿绑定、取消与后端重启失效。
- **P3**：接通发现授权、缓存/刷新、连接测试、自动推荐与 Runtime 同步；P4 已渲染 `unsupported` 状态并禁用按钮，测试确认不会发起未授权请求。
- **P5**：只做 P2/P3 能力接入和缺陷修复；主布局、双栏模型区、选择器与服务列表已在本轮定型，不需要再次重构。P0 的继承语义扩展（允许 commit 表达“继续继承”）作为合同层提案单独评审，不在本轮擅自修改。
- **P4 兼容路径**：管理接口关闭时使用旧 `/api/providers` 的轻量适配器，受旧 DTO 能力限制（无显示名/启用/模型选择元数据，不能清除凭据）；管理接口开启时仍走完整 P0 合同。P5 联调时确认默认能力开关的最终策略，不为兼容而默认开启实验开关。

## 限制与回滚

- 本轮截图使用 Chrome headless，不是 Electron 窗口；Electron 主进程在当前机器无法创建 profile 锁（0x5）。真实 Electron 场景仍需在可写桌面环境补验；不以 Chromium 截图冒充 Electron 真机通过。Chrome 采集使用 `--no-sandbox`，不是正常沙箱验证。
- P2 的 Electron CredentialSheet 测试使用 P2 fixture 与本机 Electron 进程，证明私有桥、窗口隔离与状态机，不代表真实供应商凭据或真实网络连接。
- 未验证 P2/P3 接通后的失败、缓存和同步画面；`discovery.js` 保留了状态机，但本轮生产分支不会调用远端。
- 本轮已用 `npm run build:app -- --rebuild` 重建 `dist-app/` 与单文件 `build/Pi GUI.exe`，并核对打包后的前端文件包含本轮字样；但没有启动打包后的应用做交互验收，Electron 外壳交互仍需在可写桌面环境补验。
- 管理接口关闭时的兼容路径只支持旧接口真实具备的字段与操作；勾选/排序、清除凭据、OAuth、本机注册引用均明确不可用，不显示假成功。旧内联表单未恢复，避免同时维护两套最终 UI。
- 页面已持有管理快照后，管理能力开关若在页面打开期间变化，`openAddProvider` 仍使用已加载快照；编辑器提交会按真实接口失败，不会降级旧接口写入。动态能力切换的完整处理留作 P5 集成事项。
- 回滚：回退本分支的 P4 实现、整改、测试与报告提交。整改没有新增后端写入路径，不修改 P2 Electron 凭据代码、P1 仓储、配置事务或 Runtime owner；不会改动用户真实配置。
- 合并与发布均需另行明确授权。本报告只记录开发、验证与分支推送状态；按用户要求本轮不创建 PR、不合并 `main`、不发版。
