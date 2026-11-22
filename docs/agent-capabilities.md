# Agent 能力：技能 / 扩展 / MCP 的入口与边界

拆分前，Skills、Extensions、MCP 挤在「设置 › 扩展与 MCP › Skills 与扩展」这一个
Work Surface 里（三个标签，`public/extensions.js` 一个文件 1152 行）。现在是三个独立入口，
各自拥有页面、状态与生命周期；服务端接口、Extension Registry、Skills 扫描与启停、
Pi 原生 MCP 协议都**没有改**，变的只是前端承载。

## 入口与事实来源

| 入口 | 位置 | 前端模块 | 唯一事实来源 |
|---|---|---|---|
| 技能 | 设置 › **Agent 能力** › 技能（`#navSkills`，菜单徽标 `#skillCount`） | `public/skills/`：`model.js` 纯投影、`page.js` 页面、`detail.js` 行内详情、`editor.js` 新建 / 编辑、`import.js` 导入、`external.js` 扫描、`market.js` 市场、`skills.css` | 扫描 / 启停：`/api/skills`、`/api/skills/<id>`（`server/skills.js`）；管理：`/api/skills/*`（`server/skills-routes.js` → `skills-manage.js` / `skills-import.js` / `skills-external.js` / `skills-market.js`） |
| 扩展 | 应用主导航 **扩展**（`#navExtensions`，Work Surface `extensions`，标题「扩展」） | `public/extensions/`：`model.js`、`installed.js`「已安装」、`market.js`「插件市场」、`page.js` 页签壳、`extensions.css` | `/api/extensions`（`server/extension-registry.js`，只读）、`/api/approvals/capability` |
| MCP | 设置 › 扩展与 MCP › **MCP 配置**（`#navMcp`） | `public/mcp-settings.js` 管理页 + 页尾折叠区 `public/mcp-report.js`「MCP 能力报告」 | 管理：`/api/mcp/config`、`/api/mcp/servers`；报告：`/api/mcp` |

- **技能页**：页头是「技能」及刷新 / 市场 / 新建；其下的工具栏是作用域分段（全部 / 全局 / 项目 /
  临时，带计数，没有临时技能时隐藏「临时」）、搜索、项目选择和从其他工具扫描。窄窗按内容宽度换行。
  列表按作用域分组（全局级 / 项目级 / 临时（--skill）/ 其他），组头显示图标、标题、条数与发现目录
  （`/api/skills` 的 `roots`：磁盘上存在的根，一个都不存在时给 pi 的默认位置）；全局级与项目级组头
  另带「导入文件 / 导入目录」。整宽行显示图标及状态点、名称、有值的描述，行尾放状态徽标与可用开关。作用域只在分组显示。每行一个状态徽标，已确认加载时显示「已加载」，其余
  保留停用、状态未知、未加载、同名覆盖、项目未信任和无法加载等状态。
  **停用只写了 settings；运行中的 pi 在重启前仍会加载它**，这时徽标显示「已停用 · 重启前仍加载」，
  与「已停用」（pi 已不再加载）区分；展开详情也写明「重启 pi 之后才会停止加载」。
  配置来源、提示词策略与完整加载诊断
  放到展开详情，与路径、写入目标和源文件一同查看。
  全局级与项目级即使为空也出现，空组写「此目录中没有技能」/「还没有打开项目」；筛选没有结果时只出
  一个空状态，不是每组一个。搜索覆盖名称 / 描述 / 路径 / 来源目录。展开项的详情在重绘时原样复用，
  不重复请求。
- **技能页的写入交互**：开关 → 确认（写哪个 settings.json、加 / 删哪条规则）→ 写入 → 页内提示
  「重启 pi 后生效」（可撤销、可重启），不再连续弹确认框；成功反馈留在页内，不弹 Toast。
  新建 / 编辑是表单与源文件双模式对话框，边输入边校验、带 `baseHash` 防覆盖、保存后提示撤销；
  删除先说明删的是哪个目录、进回收站而不是抹掉；导入分两步（选择文件 / 目录 → 服务端校验出的计划 →
  确认名称、位置、同名策略）；扫描只读列出 Claude Code / Codex 的技能，勾选后再导入；
  市场是页内子视图，进入后显示独立的「技能市场」标题，先「预览」全文再确认安装。操作使用发起时的项目，
  切换查看项目或真实工作区会关闭旧项目弹窗与确认，丢弃旧结果，包括切走后又切回来。
- **扩展页**：页头（唯一的「扩展」标题 + 当前页签的动作，「已安装」是刷新）→ 页签行
  （已安装 · 插件市场，右侧挂当前页签的工具栏，「已安装」是搜索与「找到 N 个，共 M 个」）→ 页签面板。
  工作区标题栏里的同名标题在本页隐藏，一屏只有一个「扩展」。
  - 两个页签共享当前 Pi 运行的「运行提示」。没有提示就不占位；有提示时默认收成一行，按错误、警告、普通提示显示去重条数。展开才显示原文与重复次数。更新不抢焦点，切项目或重启后不保留旧原文。提示区消失时，仅当键盘焦点位于摘要或原文内才回到当前页签；搜索框等其它控件保留焦点。扩展主动上报的严重错误仍走原有即时通知，不把来源不明的诊断归给某个包。
  - 「已安装」合并只读 Registry 与包清单，整宽条目按证据分组：需要处理（有 `error`）→ 已加载 → 未加载 →
    加载状态未知（`loaded: null` 单独成组，不并进「未加载」）。每行显示名称、版本 · 来源 · 作用域、一行非空简介，
    标题旁保留更新、停用或需要重启等状态；加载错误仍直接可见。命令和工具名字不占列表行，仍可搜索。
    「详情」在卡片内展开：事实行（`null` 显示「未知」）、错误阶段、已确认能力全集、工具清单限制；
    展开时简介不再截断，详情里不重复简介与错误。详情第一次展开才建，重绘后保持展开。
  - 列表之后是「已知能力」（Web Access / Subagents / Pi Memory / Browser Use 的受控安装与运行观察、
    Approval 协议探测），每项一块可展开的瓦片。
  - 空 Registry、读取失败（带「重试」）、项目已切换（带「刷新」）都是状态瓦片；读取失败时「已知能力」照样可用。
  - 「插件市场」对照 PI-Desktop v0.23.0：紧凑图标标题和右侧刷新，页签与搜索同排，独立分类胶囊可以换行，排序另成一组。再次点已选分类返回「全部」。网格按内容宽度以 272px 最小列宽自动排布（1320px 窗口三列、1010px 两列、700px 一列）。每张卡的正文进入详情，安装/更新栏贴底；在线同意和写操作确认仍走原流程。npm 月下载量不是安装数，包的关键词不是权限声明。
  - 旧入口参数 `{ tab: 'extensions' }` 与已移除的 `skills` / `mcp` 都落到「已安装」。
- **MCP 能力报告**：旧 MCP 标签里管理页没有的证据（是否带原生 MCP、版本与出处、built-in 清单、
  RPC / ExtensionAPI 事实、扩展目录与 settings 声明、本次运行的调用观察）。第一次展开才读 `/api/mcp`；
  原生状态取自管理页已经读到的 `/api/mcp/servers`（`setNative`），不再发第二次请求；
  那一次没读到时写「读不到原生 MCP 摘要」，不沿用上一次的结论。
  旧标签里的 server 列表 / 刷新 / 移除 / 添加与管理页重复，已由管理页承接，没有搬第二份。

## 第三阶段的版式与参照

技能与已安装扩展沿用 pi-GUI **原版 MCP** 的纯文字页头、工具栏和整宽管理行，不共享 MCP 的脚本或 CSS。二者保留 30px/700 标题。插件市场页签则按指定的 **PI-Desktop v0.23.0 插件市场** 使用 16px 紧凑图标标题、分行筛选和自适应卡片网格；切回已安装即恢复原页头。市场选用共享分段与搜索框的圆角变体，不重定义既有按钮、开关或全站 Token。原图版本、实际差异、四组窗口与真实环境证明见[第三阶段验收](agent-capabilities-phase3-final-acceptance.md)。

### 表面统一（2026-11-23）

三个页面此前把分组、行和工具栏都画成「深色底 + 整圈 1px 边框 + 更亮表面」的独立卡片，与
设置里的「常规 / 快捷键 / 信息」不是同一种视觉语言。现在以那三个页面为**内部参照**：

- 行 / 卡片用设计系统的内流瓦片 `--ds-tile` + `--radius-md-plus`，**不画整圈边框**；
  悬停、键盘焦点和展开态在同一层底色上升一级（`--ds-tile-hover`）。嵌套的展开详情用
  `--ds-raised` + `--ds-raised-shadow`，代码块继续用 `--ds-bg-inset`。列内行距统一为 6px，
  与 `.settings-row` 一致。
- 分组图标从「带边框的小方块」改为无边框的 `--ds-tile-deep` 图标片；分组标题统一为
  `--text-lg` / 600 / 主文字色，条数统一为 `.ds-badge` 尺度的胶囊，发现路径统一为
  `--text-xs` + 次级文字色。
- 搜索、选择器、开关、开关条和按钮仍由公共原语持有。MCP 的范围筛选改用共享
  `createSegmentedControl`（与技能页同一控件、同一计数节点 `.ds-segment-count`），项目选择器
  改用公共 `.ds-select`；页面不再维护第二套分段 / 字段样式。
- 语义提示（技能操作结果、市场横幅、MCP 横幅）保留语义底色和 2px 左缘标记，去掉整圈边框；
  空状态从虚线框改为瓦片。没有用 `border: none` 抹平所有边界，也没有降低文字对比度来「融合」：
  实际执行的输入框、选择器和 MCP 语义胶囊仍保留设计系统规定的低对比度边框或语义底色。
- 「刷新插件市场」从 Primary 改为 Ghost（设计系统把「刷新」列在 Ghost 下）；卡片里的
  「安装 / 更新」仍是该区域的 Primary。MCP 读取失败时的「重试」也从 Primary 改为默认 Secondary。
- MCP 市场卡片补 `min-width: 0`：窄窗下网格项此前按 min-content 撑宽，700×600 会横向溢出
  （既有缺陷）。卡内的信任来源仍按原约定用省略号截断，`title` 保留全文。


## 拆分时的历史版式（第一、二阶段）

结构取自 PI-Desktop 源码（@92ae661）的技能页 `AgentSkillsPage` 与扩展页 `PluginsPage`：
工具栏 → 分组（标题 + 条数）→ 行 / 卡片网格，扩展页的页签与搜索同一行。外观全部用 pi-GUI 既有 Token
与公共原语（`.ds-segmented` 页签与分段、`.ds-search-control`、`.ds-select`、`.ds-badge`、`.ds-switch`、`.btn`、
`.ext-rows` / `.cfg-note`），深浅主题跟随既有变量，没有引入新的视觉语言。
`createSegmentedControl` 为此加了可选计数（`count` / `setCount`）与 `setOptionHidden`，原有调用不受影响。

有意不照搬的地方：

| PI-Desktop | pi-GUI | 原因 |
|---|---|---|
| 技能页的「新建 / 导入 / 扫描 / 市场」 | 2A 已实现，入口、分组与密度对齐 | 能力范围按 pi-GUI 的边界收窄：扫描只读 Claude Code / Codex 的已确认目录；市场只读公开 GitHub 目录源，联网只在「加载 / 刷新」与「预览」两个手势上发生，安装不执行远端脚本；导入先出计划再落盘 |
| 技能编辑器直接写文件 | 表单 + 源文件双模式，服务端再校验一遍，保存带 `baseHash` | 前端表单无法保证磁盘上的字节；同名覆盖、路径逃逸与链接必须由服务端拒绝 |
| 扩展卡片的「安装 / 卸载」 | 卡片底部是「详情」 | 本阶段不实现安装器（属于 2B）；「已知能力」里既有的一键安装照常可用 |
| 插件市场的分类、排序与卡片 | 一块空状态 | 同上；市场还意味着新的网络行为，须先征得同意 |
| 技能页标题前的图标块 | 只有文字标题 | pi-GUI 的设置详情页统一用文字标题；扩展是主导航页，标题带图标块 |
| 自绘页签 | `.ds-segmented` | 复用 pi-GUI 的分段控件，不另画一套 |

技能分组「全局级」在前与 PI-Desktop 相同，但这只是展示顺序：同名时谁生效仍由 `server/skills.js`
按 pi 的规则判定（项目级优先），结果体现在行上的「被同名覆盖」状态，不靠分组先后表达。
`styles.css` 里拆分前的 `.ext-known*` 规则保留（其中 `.ext-known-item .cap-setup>h4:first-child`
仍负责去掉重复标题），扩展页在 `extensions.css` 里按 `.extensions-page` 作用域覆盖外观；
清理旧规则属于无关重构，本阶段不做。

## 不变的约束

- installed / enabled / loaded / restartRequired / runtimeObserved 仍是独立事实；
  `null` 显示「未知 / 无法确认」，绝不折算成「否」。闭集外的状态显示「状态未知」并记一条
  schema 漂移（只记来源 / 字段 / 类型，不记值）。
- 每个异步结果都过三重校验：Work Surface 实例身份（`instance.isCurrent`）或设置详情卡的
  `onClose`、工作区代号（`S.workspaceGeneration` / `ownsWorkspace`）、页面自己的请求序号。
  换项目后**不自动重读**（后端可能还在切换），列表换成「项目已切换，刷新后查看…」，由用户刷新；
  确认框在换项目或关页之后才被点下，不发写请求。**读取失败也走同一条规则**：即使上次读取已经把
  列表读空，工作区换代仍会把旧错误和旧诊断一并作废，换成「项目已切换」提示，而不是让上一个项目的
  失败信息留在页面上。
- 三个入口**互不 import UI**。共享层只有既有的 `api.js` / `state.js` / `ui/*`，
  以及 `ui/resource-dom.js`（只造节点：无状态、无业务文案、不 import 页面）。
- 页面状态只活在页面实例里：没有模块级可变状态，不写 `S`，每次读取整体替换。
- document 级监听：技能页 1 个、扩展页 3 个通知事件 + 「已安装」1 个、能力报告 1 个；关闭后净增为 0。

## 并行开发的文件归属

| 归属 | 独占文件（可自由修改） |
|---|---|
| **Agent A：技能（2A）** | `public/skills/**`、`server/skills.js` 及新增的技能服务端模块、`tests/skills.cjs` 的 Skills 段（同一文件里 `server/mcp.js` 能力报告那段属于 MCP，不改）、`tests/skills-live.cjs`、新增的技能测试 |
| **Agent B：扩展 / 插件市场（2B）** | `public/extensions/**`、`server/capability-install.js`、新增的扩展市场服务端模块、`tests/extensions.cjs`、`tests/capability-install.cjs`、`tests/capability.cjs`、新增的扩展测试 |
| 都不改（除非单独协调） | `server/extension-registry.js`（只读 Registry，B 也只消费它）、MCP 全部文件（`public/mcp-*.js`、`public/mcp.css`、`server/mcp*.js`）、已知能力的 feature 模块（`public/web-access.js` / `subagents.js` / `memory.js` / `browser.js` / `approval.js` 及各自的 `*-capabilities.js`，「已安装」只调用它们的 `render*Setup`）、`public/extension-notices.js`（全局通知路由） |

`server/skills.js` 虽归 A，但它的 `readIndex().trust` 是全仓库唯一的项目信任来源：`server.js`
把它注入 `extension-registry`、`mcp-config`、`mcp-import`、`mcp-native`。A 改动信任判定或
`readIndex()` 的返回形状，等于同时改了扩展与 MCP 的判定，须先协调。

**共享文件：不得并行修改**，同一时间只允许一个分支改动，另一方 rebase 后再动：

| 文件 | 为什么会冲突 |
|---|---|
| `public/index.html` | 主导航、设置分组、样式表链接 |
| `public/app.js` | 入口 import、导航绑定、快捷键、命令列表、徽标 |
| `public/api.js`、`server/router.js`、`server.js` | 两边都要加接口、路由与服务端装配（信任源注入也在 `server.js`） |
| `public/state.js`、`public/ui/workspace-surface.js`、`public/ui/settings-surface.js` | 工作区代号、Work Surface 标题 / 导航投影、设置菜单开合 |
| `public/ui/resource-dom.js`、`public/ui/capability-setup.js`、`public/capability-model.js` | 两个页面共用（`skills/detail.js` 用 `capability-setup.js` 的 `copyButton`） |
| `public/ui/primitives.*`、`public/ui/icons.js`、`public/tokens.css` | 设计系统公共实现（规范见 [design-system.md](ui/design-system.md)） |
| `package.json` | `test` 链与脚本 |
| `tests/smoke.cjs`、`tests/ui-ia.cjs`、`tests/agent-capability-pages.cjs`、`tests/visual-harness.cjs`、`tests/shortcut-electron.cjs`、`tests/cdp-shot.cjs`、`tests/primitives.cjs` | 两边的断言、fixture 与截图步骤在同一文件 |
| `public/styles.css` | 拆分前的 `.ext-*` 旧规则仍在（扩展页按 `.extensions-page` 作用域覆盖）；谁要清理先协调 |
| 本文件、`docs/testing.md`、`docs/README.md` | 文档索引与测试清单 |

## 2A 已实现：技能完整管理

第一阶段只有列表、详情与启停；2A 补齐新建、编辑、导入、扫描与市场，并按 PI-Desktop 重做版式。
**原有扫描规则、项目信任与加载状态判定没有改**，写入侧都建在 `server/skills.js` 的索引之上。

服务端模块（除 `skills.js` 外都是 2A 新增）：

| 模块 | 职责 |
|---|---|
| `skills.js` | 发现 / 详情 / 启停（唯一事实来源）；`buildIndex(context)` 支持查看非当前项目，`listExtras` 注入写入目标与可管理标记 |
| `skills-routes.js` | `/api/skills/*` 的收窄路由：解析 `?project=<16 位 ID>|none`，写操作必须显式项目，错误只带错误码 |
| `skills-manage.js` | 新建 / 编辑 / 删除 / 安装（导入、扫描、市场共用）与撤销；信任判定、写入目标、回收站、撤销令牌 |
| `skills-document.js` | SKILL.md 的逐字解析与合成：YAML frontmatter、BOM、换行、表单与源文件两种模式 |
| `skills-files.js` | 包的校验与原子落盘、读树、回收站、短期令牌；上限 200 个文件 / 单文件 2 MB / 合计 12 MB |
| `skills-import.js` | 本机导入两步协议：暂存（内存，15 分钟）→ 确认后落盘；失败保留暂存以便处理同名冲突 |
| `skills-external.js` | 只读扫描 Claude Code / Codex 的技能目录，按候选 ID 重新扫描后导入 |
| `skills-market-catalog.js` | 目录解析：GitHub 仓库（owner/repo、@ref、GitHub URL）、SKILL.md 目录识别、分类与上限 |
| `skills-market-network.js` | 唯一联网层：仅 HTTPS / 443、主机白名单、无凭据、不跟随重定向；直连钉 IP，代理走既有桥 |
| `skills-market.js` | 市场状态（离线缓存）、用户手势触发的刷新、预览令牌（15 分钟）、只认预览令牌的安装、目录源管理 |

端点（列表 / 详情 / 启停仍是第一阶段的 `/api/skills`、`/api/skills/<id>`）：

- `POST /api/skills/create`、`POST /api/skills/check`、`GET|PUT /api/skills/<id>/source`、
  `DELETE /api/skills/<id>`、`POST /api/skills/undo/<token>`
- `POST /api/skills/import/stage`、`POST /api/skills/import/commit`
- `GET /api/skills/external`、`POST /api/skills/external/import`
- `GET /api/skills/market`、`POST …/market/refresh|sources|preview|install`、
  `GET …/market/preview/<token>/file`

写操作一律显式带项目（`create` / `import/commit` / `external/import` / `market/install`）；
前端只传写入目标的 key 与技能 ID，不传绝对路径，后端从 `listTargets` 解析目录并做项目信任与链接检查。
写入目标是固定四个（`user-pi` / `user-agents` / `project-pi` / `project-agents`），不在列表里的
key、绝对路径、原型链上的名字一律 400。

**恢复**：删除、覆盖、撤销安装都是「挪进 `<dataDir>/skills-trash`」，编辑前备份旧字节（每文件保留
最近 5 份）；撤销令牌 30 分钟有效、只存在内存、单次使用。编辑核对 `afterHash`，安装核对包内文件、
目录及 SHA-256 内容摘要，发现改动即拒绝。所有撤销会重新核对原位置与项目当前信任。

**市场**：内置来源取自 PI-Desktop 公开目录，另可添加公开 GitHub 仓库；打开市场、搜索、分类、分页
只读本机缓存，联网只发生在「加载 / 刷新」与「预览」两个手势上，安装不联网（写的就是预览核对过的
字节）。完整性：固定提交用 git blob sha1，分支用 sha256；缺文件默认拒绝，明确勾选后才允许装不完整
的版本。不执行任何远端脚本；主机白名单只有 `api.github.com`、`cdn.jsdelivr.net`、
`data.jsdelivr.com`、`raw.githubusercontent.com`。「目录源」界面从市场状态接口读取实际主机白名单。
`pi` 没有内置技能，界面不造「内置」条目。

**内置技能**：按 pi 上游源码（@v1.6.0）确认不存在内置技能目录；来源不明或加载状态未知的条目显示
「状态未知」，不折算成「未安装 / 未加载」。

## 2B 边界：扩展市场

第二阶段 B 的市场数据、受控操作和验证结果见 [扩展市场实现与验收](extensions-market-phase2b.md)。

范围：插件市场浏览、安装、卸载、更新、启用。

- 替换 `public/extensions/market.js` 的占位；目录与安装逻辑放在**新的**服务端模块，
  不写进 `server/extension-registry.js`。
- 安装沿用 `server/capability-install.js` 已验证的路径：renderer 只送目录 ID，source 由服务端解析，
  固定 argv 调官方 `pi install`、执行前确认、暂停 / 重启 Pi，装没装由重新发现的 Registry 回答
  （退出码 0 ≠ 已安装 ≠ 已加载）。卸载 / 更新 / 启用先从 pi 上游源码确认官方命令与 settings 语义，
  没有官方接口的动作不做假开关。
- 网络请求可复用 `server/market-network.js`（MCP 市场已有的代理桥：只 GET、固定请求头、拒绝重定向）；
  新增联网需用户同意。
- 不引入第二套插件运行时：GUI / Electron 进程里永远不执行扩展代码。

## `.piplug` 不是 Pi 原生 Extension

依据 PI-Desktop 源码（@92ae661）：`.piplug` 是 PI-Desktop 的产品级分发包，zip 加根目录
`manifest.json`（ADR 0007）。它的插件跑在 PI-Desktop 自己的进程与权限网关下（ADR 0008）；
`contributes.agentExtensions` 模块跑在 PI-Desktop 的 Agent sidecar 里，面对的是只实现了
`ExtensionAPI` 子集的桌面适配层（`docs/spec/07-plugins/16-trusted-extensions.md` §1）；
PI-Desktop 也从不自动导入 `~/.pi`（D007）。

Pi 原生 Extension 由 pi 自己加载：`~/.pi/agent/extensions`、`<项目>/.pi/extensions`，以及 settings 的
`extensions` / `packages`（`pi install` 安装），在 pi 进程内拿到完整的 `ExtensionAPI`。
所以 `.piplug` 依赖 pi-GUI 没有、也不该重造的宿主（manifest、权限网关、宿主 RPC、sidecar 适配层），
不能直接当成 Pi Extension 安装。2B 只接入 pi 能直接加载的来源；如果目录里出现 `.piplug`，
标成「不兼容」或过滤掉，不解包、不执行。

## 测试

- `tests/agent-capability-pages.cjs`（在 `npm test` 里；第三阶段的实测数量见[验收记录](agent-capabilities-phase3-final-acceptance.md)）：静态边界（无互相 import、只经 `api.js`
  读各自的接口、无模块级状态、市场无安装路径、导出名唯一）、纯投影的三值语义、
  三个页面的生命周期（迟到结果丢弃、换项目提示、监听器净增为 0、页签复用不重复请求）、
  两个页面的版式结构（单标题、分组顺序与组头路径、空状态、「临时」页签、未信任提示、卡片分组与详情）。
- Skills 2A（`npm run test:skills`，8 个套件，1080 条通过 + 5 条因环境跳过）：
  `skills.cjs` 196（索引 / 启停 / 信任 / 加载三值）、`skills-document.cjs` 53、
  `skills-files.cjs` 181、`skills-manage.cjs` 218、`skills-manage-edit.cjs` 180、
  `skills-import.cjs` 123、`skills-market.cjs` 113、`skills-ui.cjs` 16。
  服务端套件全部在 `os.tmpdir()` 里造世界；`skills-ui.cjs` 用 jsdom 驱动页面，断言打开市场只读缓存、
  预览之后才安装、迟到的扫描 / 预览结果不写进新页面。
- `tests/smoke.cjs` 的「Agent 能力：扩展页 / 技能页 / MCP 配置页」段与 `tests/ui-ia.cjs`：
  导航、选中态、标题、设置搜索、返回会话；技能页断言单一状态徽标（已加载 / 已停用）、
  坏技能与未信任都在行内、重启提示是页内提示、PUT 只走 ID 路径；`tests/mcp-management-ui.cjs`：
  摘要读取失败时的页尾报告；`tests/primitives.cjs`：分段控件的计数与隐藏项。
- 真实渲染：`npm run test:shortcuts:electron`（不在 `npm test` 里）在 1320×820 / 700×600、
  深 / 浅色下截图，并实测版式：一屏一个「扩展」、页签与搜索同一行、已安装条目整宽不溢出、下行不遮挡展开详情、
  扩展页在内部滚动容器里滚动（Work Surface 保持 `overflow:hidden`）；技能页分组顺序、组头路径有宽度、
  作用域分段 / 搜索 / 项目选择在同一行（中线差 < 2px）、开关在行内且距右缘 10–18px、状态点在图标右下、
  700px 无横向溢出。夹具 `tests/visual-harness.cjs` 的 `/api/skills` 照 `server/skills.js` 的真实形状造。
- 视觉：`tests/skills-visual.cjs`（不在 `npm test`）用真实 Chromium 在 1320×820 / 700×600、
  深 / 浅色下截 44 张，覆盖列表 / 空 / 错误 / 成功提示 / 新建 / 编辑 / 导入 / 市场 / 预览 / 扫描，
  产物与 manifest 在 `.shots/skills-phase2a/`。
- 手动截图 `npm run shots`（`tests/cdp-shot.cjs`）的扩展 / 技能 / MCP 步骤已跟到新结构；
  技能未信任那一步改为断言行内「未加载（项目未信任）」。
