# PI-GUI-UI-FULL-AUDIT · 全项目 UI/UX 审计

日期 2026-11-14。只读审计，人工验收待定。适用标准为 [全局 UI/UX 设计规范](design-system.md)，上一轮证据见 [设计系统现状审查](design-system-audit.md)。

## 1. 摘要与基线

- 产品代码采用 `origin/main` 的 `9ddf0aa1018481616ce9fdc32a2ea7671237ef8c`。本工作树为 detached HEAD，产品及测试目录与远端基线无差异。保留了工作树已有的设计系统文档改动。远端查询时无开放 PR，本机另有分支/工作树，其中包括思考动画；无法据此判断其他 Agent 的活动状态。
- 发行版为 v0.33.0。基线 main push CI 第 1 次成功，包含 UI、打包检查与最终 gate。本报告的专项渲染和测试有各自结果。[基线 CI](https://github.com/HYJ1817/pi-gui/actions/runs/43448003847)
- 首要问题集中在输入焦点。设置搜索与 MCP 搜索都复现了蓝色内轮廓叠加中性外框。Classic Composer 获得键盘焦点时仅见插入光标。设置 Select、帮助图标、文件状态、浅色搜索对比度和协同文案有独立发现。
- 本轮报告只新增 Markdown。未运行全量 `npm test` 或重建产物，依据为 [纯文档测试政策](../testing.md#测试执行政策)。

## 2. 取证环境与口径

Windows、Node v24.22.1、Chrome 157.0.8103.78，Chrome 视口使用 CSS px、DPR 1。用仓库 `tests/visual-harness.cjs` 提供环回 HTTP 和临时上传目录，CDP 操作生产页面、采集控件计算样式、截图及失败原因。设置主题走 `setThemePreference`。文件预览和供应商配置用现有 API 形状的临时响应，应用 DOM 与样式来自被审计代码。英文压力测试只替换离线外观页标题和字号选项文本。反馈原语用显式测试消息触发。

Electron 专项使用本机已有 Electron 44.4.3 和仓库脚本，逐项记录结果。外壳专项确认正常沙箱、隔离上下文和 DPR 1.5。真实凭据、远端 OAuth、安装与升级、外部网页、真实模型和用户数据均在取证范围之外。未给环境受限状态授予通过结论。

证据根位于本聊天可视化目录下的本机 `ui-full-audit/`，`index.html` 支持按页面、宽度和主题筛选。报告的相对截图名与证据根对应。本机截图采用离线内容，留在仓库外。

- **实测**表示当前代码经浏览器或 Electron 渲染并观察到该状态。**局部**表示已渲染部分路径，另有未覆盖状态。**源码确认**表明找到具体路径、规则或接口。**待验证**表明未达到应有场景或缺乏足够证据。
- 覆盖率以登记的产品界面组计数，重复截图与主题变体不增加分子。全局交互层另外列出。「未发现 P0」只适用于实际观察范围。失败的测试与产品问题分开登记。

## 3. 页面、入口和覆盖率

从 [入口 HTML](../../public/index.html)、[应用绑定](../../public/app.js)、[设置路由](../../public/ui/settings-surface.js)、[工作面板注册](../../public/ui/work-panel-launcher.js) 与 [Runtime 次级表面](../../public/runtime-secondary.js) 追踪。pi-GUI 使用 DOM surface、面板及原生窗口，URL 路径无法代表页面数量。下表将共享同一入口的子状态合并，每组保留代表截图名。

28/28 个登记界面组有当次渲染证据，其中 11 组完成代表路径检查，17 组仍有具体分支、原生行为或真实服务状态待验证。「代表路径检查」仅指下表所列场景，子状态和四尺寸覆盖以证据索引为准。

Chrome 保留 283 张按文件去重的截图。1440×900 的深、浅主题各 70 张，700×600 分别为 64 和 61 张，1024×768 分别为 5 和 4 张，1280×800 分别为 4 和 5 张。中间两个尺寸重点复核主界面、外观、Changes、MCP 市场与模型选择。个别视口的模型选择捕获未到达目标，已在运行清单中保留原因。283 张图对应的探针都未测出根文档横向溢出。此测量不覆盖局部面板遮挡与滚动。

| ID | 页面／功能组 | 入口或所有者 | 状态与证据 |
| --- | --- | --- | --- |
| A01 | 欢迎、Classic 聊天、用户与 Agent 消息、Thinking、任务摘要、工具调用、历史与 Composer | `app.js` / `messages.js` / `composer.js` | 实测，`classic-clean-1440-dark.png`、`welcome-clean-700-light.png`、外壳 running；工具细分状态及全部可视化类型待逐一检查 |
| A02 | 项目、会话列表、搜索、项目/会话菜单、项目设置 | `projects.js` / `app.js` | 实测，`search-1440-dark.png`、`project-settings-1440-dark.png`，Electron 项目/会话菜单和滚动 |
| A03 | Runtime 对话、导航、流式输出、模型、独立输入 | `runtime-conversation.js` / `runtime-nav.js` | 局部，`runtime-base/p32-3/running-B-1440x900.png`；证实独立会话切换、输入与模型菜单键盘路径，专项在后续几何或 Browser 用例处中断 |
| A04 | 模型选择、思考强度、上下文及斜杠命令 | `app.js` / `ui/popover.js` / `ui/inline-command-menu.js` | 实测，`model-picker-1440-dark.png`、`thinking-1440-dark.png`、`context-1440-dark.png`、`slash-1440-dark.png` |
| S01 | 设置首页、搜索及返回 | `ui/settings-surface.js` | 实测，`settings-1440-dark.png`、`settings-search-focus-1440-dark.png` |
| S02 | 常规、主题与字体 | `settings.js` / `theme.js` | 实测，`appearance-focus-1440-dark.png`、`long-english-700-dark.png` |
| S03 | 键盘快捷键 | `ui/shortcut-help.js` | 实测，`shortcuts-1440-dark.png` |
| S04 | 命令面板 | `app.js` / `palette.js` | 实测，`palette-1440-dark.png` |
| S05 | 任务列表、Planner 详情、审阅/验证及子 Agent 入口 | `planner.js` / `plan-view.js` / `subagents.js` | 局部，`planner-1440-dark.png`、`planner-detail-1440-dark.png`，审批/候选/多 Agent 全生命周期待补 |
| S06 | 模型供应商、添加、配置、删除 | `providers.js` / `provider-management/dialog.js` | 局部，`providers-1440-dark.png`、`provider-add-700-dark.png`、`provider-config-700-dark.png`、`provider-invalid-700-dark.png`。用已配置离线服务渲染编辑和删除确认，见 `provider-edit-1440-light.png`、`provider-remove-1440-light.png`。保存、确认删除和同步待验证。 |
| S07 | 供应商认证、OAuth、环境变量和隔离 Key 窗口 | `providers.js` / `provider-auth.js` / `electron/provider-credential-page.cjs` | 局部，`auth-1440-dark.png` 及配置页离线不可输入状态。远端 OAuth 和可信桌面 Key 窗口待补 |
| S08 | Agent 能力及能力详情 | `extensions.js` / `ui/capability-setup.js` | 局部，`capabilities-1440-dark.png`、`capability-error-1440-dark.png`；实际安装、配置回读待补 |
| S09 | Skills 管理、Extensions 列表与详情 | `extensions.js` | 局部，`skills-1440-dark.png`、`extension-list-1440-dark.png`、`extension-detail-1440-dark.png`，修改/安装/卸载待补 |
| S10 | MCP 配置、新增、服务器详情和导入 | `mcp-settings.js` | 局部，`mcp-1440-dark.png`、`mcp-add-1440-dark.png`、`mcp-detail-1440-dark.png`；导入、保存和服务器认证未执行 |
| S11 | MCP 市场、安装确认、来源管理 | `mcp-market.js` | 局部，`market-1440-dark.png`、`market-detail-1440-dark.png`、`mcp-market-loading-700-dark.png`。生产加载 UI 用延迟的离线响应取证，真实安装和自定义来源待补 |
| S12 | Pi GUI 与 Pi 更新及重启确认 | `settings.js` / `app.js` | 局部，`updates-1440-dark.png`、`project-confirm-1440-dark.png`，真实下载、安装、Pi 重启未执行 |
| S13 | 运行状态与诊断 | `app.js` 诊断入口 | 实测，`diagnostics-1440-dark.png`，日志导出和真实故障恢复不计 |
| S14 | 日志及故障报告 | `logs.js` | 局部，`logs-1440-dark.png`，不同事件状态及导出未逐条检查 |
| W01 | 工作面板起始页和全局工具入口 | `right-pane.js` / `ui/work-panel-launcher.js` | 实测，`tools-1440-dark.png` |
| W02 | Git Changes、Diff、行/区间评论与审阅 | `git.js` / `diff-comments.js` | 局部，`changes-1440-dark.png`、`diff-review/range-saved.png`，危险写回和撤销操作未执行 |
| W03 | 文件树、代码/文本预览 | `files-panel.js` | 实测，`files-1440-dark.png`、`files-normal-700-dark.png`、`files-preview-700-light.png`，含错误及离线成功分支 |
| W04 | Specs 文档树、Markdown 预览 | `specs-panel.js` / `specs-tree.js` | 实测，`specs-native/specs-populated-1200.png`、`specs-native/specs-narrow-720.png`、`specs-native/specs-empty-1200.png` |
| W05 | 协同文档、流程图和 Agent 提案 | `collab-panel.js` / `collab-canvas.js` | 局部，`collab-native/collab-760.png`、`collab-native/collab-agent-proposal.png`，浅色计算样式断言失败，见专项记录 |
| W06 | 分支树、工作区和 Worktree 管理 | `#btnTree` / `tree.js` / `worktrees.js` | 局部，`tree-1440-dark.png`、`worktrees/workspaces-1280x800.png`，Tab 回绕专项未通过 |
| W07 | 终端、标签与状态 | `terminal-panel.js` / `terminal-tabs.js` | 局部，`terminal-1440-dark.png`、`terminal-full-700-light.png`，Web 的不可用、禁用与重试状态实测；在线 ConPTY 与正常输出待补 |
| W08 | 内置 Browser 及原生工作台 | `browser-pane.js` / `electron/browser-view.cjs` | 局部，`runtime-base/p32-3/scoped-browser-open.png` 有应用面板，原生网页捕获报 `UnknownVizError` |
| W09 | 开发进程、进程日志与控制 | `process-panel.js` / `runtime-secondary.js` | 局部，`process-1440-dark.png`、`process-1440-light.png`。只验证权限段、空/失败状态，进程启动与控制专项仍待运行 |
| W10 | 本会话变更、审批、安全撤销及候选应用 | `session-changes-panel.js` / `approval.js` / `candidate-review.js` | 局部，`session-changes-1440-light.png`、`project-confirm-1440-dark.png` 见面板错误态及通用确认层。审批、候选写回及撤销专项仍待验证 |

不进入分母的参考场景包括 PI-Desktop 的实时语音、独立 Skills 市场、子 Agent 配置页与 `@` 文件补全。已查现有入口和参考档案，pi-GUI 有自己的 Skills 管理、MCP 市场、会话调度和文件面板。

## 4. 跨模块组件、主题、排版与交互

| 组件 | 现状与读数方式 | 覆盖与下一步 |
| --- | --- | --- |
| Button / IconButton | 通用 `.btn` 30px、8px 圆角、12.5px、`--line`。Provider `.pm-btn` 30px、6px、12px、`--ds-border-default`。Shell 28px 图标控制使用 `--ds-control-size`。 | 通用/供应商三类按钮有样式或渲染证据。保留紧凑工具动作与普通提交的角色差异。 |
| Input / SearchInput / Textarea | 设置搜索外壳实测 224×34，内 input 12.5px；Provider 搜索外壳 34px，MCP 有独立外壳；Classic textarea 用 `--text-base`、`--leading-body`、`--ds-placeholder-ink`。 | 收敛搜索的焦点所有者。字段内边距、装饰图标和清空按钮的焦点分别检查；Composer 的替代焦点指示仍需验证。 |
| Select / Checkbox / Radio / Switch | 外观 Select 34px、13px、8px，分段 Radio 26px 项高、12.5px、圆角 8px；Switch 38×22、圆形、`--ds-switch-*`；Checkbox 在 MCP、日志和 Review 使用各自原生字段及样式。 | 选中、按下、hover 和 Tab 有不同样本。MCP 切换真实连接、复选状态穷举及高对比模式待补。 |
| Dropdown / Menu / MenuItem | `openActionMenu` 的行至少 32px、8px gap、10px 圆角。模型项使用独立浮层，实测 10px 圆角。动作与选择列表需要保持不同语义。 | 项目菜单方向键/回焦有 Electron 证据，Runtime 模型 Escape、选中与 Tab 离开有实测。 |
| Card / Panel / List | 设置卡片使用 `--ds-tile` 和 14px 行半径，市场 `.mcp-market-card` 与工作面板是不同的信息结构。外壳 Electron 测得标题栏 46px、导轨 275px、项目/会话行 28px。 | 宽窄截图用于比布局。层级应优先靠留白和表面分组；保留任务与状态差异。 |
| Tabs / Badge | 扩展与日志的 `.ext-tab` 与终端 Tabs 各有所有者；设置 Badge 为 20px/11px/6px；侧栏计数和 Diff 计数有业务映射。 | 已见选中、计数、禁用。无障碍树上的选中关联、完整方向键序列待补。 |
| Tooltip / Popover | `createHelpIcon` 当前 15px、10px 字、圆形背景。`openPop` 用于上下文及模型类浮层。 | 帮助键盘焦点与点击契约存在差距。普通 Tooltip 的 hover 延迟与 dismiss 待补。 |
| Dialog / Modal / Confirmation | `modal.js` 与独立确认层，Provider 在 700px 使用近全视口可滚动卡片。 | Runtime 某对话框 Tab、Shift+Tab、Escape 有通过断言。Worktree 的 Tab 回绕断言另有失败。 |
| Toast / Notification | `ui/toast.js` 去重且抑制常规成功提示；`ui/notice.js` 绑定持续状态。 | 用离线错误消息与常驻通知取证；频率、队列峰值和辅助技术播报待补。 |
| EmptyState / Loading / ErrorState | 无项目、无匹配、停机与传输失败共存，分属各个 surface 所有者。 | 终端、文件、供应商校验有错误/禁用图。MCP 用 3.5 秒离线响应延迟验证生产加载 UI，参考 `mcp-market-loading-700-dark.png`。 |

字体取角色基准核对。普通设置 Select 13px 与分段项 12.5px 是现有控件差异；模型标识、路径和命令应保留等宽语义。中文真实产品有覆盖。长英文标题与四个字号选项在 700px 夹具图换行，标题占三行，分段项在两排，靠页面滚动继续浏览。受测文件中按 `docOver` 记录根文档宽度，局部子容器仍需单独核对。产品没有全局英文切换的证据，英文产品验收未完成。

两主题使用 `data-theme`、`color-scheme` 与公共层叠。主题反转在外壳、设置、市场和选取场景可见，语义颜色仍有旧桥接消费者。可访问性按真实 Tab 和悬浮层边界取证，不以程序化 `focus()` 模拟指针结果当作真实鼠标验收。已用 CDP 鼠标事件检查分段 hover/pressed，并记录可见错误、选中与禁用。强制颜色、屏幕阅读器、移动触控命中、动效持续时间和减弱动效仍需独立检验。

## 5. 已确认问题及整改清单

| 编号 | 页面 / 组件与源码 | 复现、截图、规则和影响 | 整改与影响面 |
| --- | --- | --- | --- |
| P1-01 | 设置及 MCP 搜索，`styles.css:826,2663–2691`，`mcp.css:156–180`，`tokens.css:211,444` | **实测。** Tab 到搜索。设置深色内 input 为 2px 蓝色 `rgb(170,200,237)`，MCP 浅色内轮廓为 `rgb(40,91,150)`，同帧外壳也使用主题焦点色。违反单一指示和焦点语义一致。图 `settings-search-focus-1440-dark.png`、`mcp-keyboard-1440-light.png`。 | 输入焦点由单一外壳绘制。保留清除等子动作自己的焦点。复核设置、MCP、会话及 Provider 搜索。 |
| P1-02 | Classic Composer，`ui3-composer.css:3–15`、`styles.css:653` | **实测。** 从附件按钮按 Shift+Tab 到 textarea。深浅主题均为 `:focus-visible`，计算 outline 为 none，外壳为零边框，画面仅见插入光标。核心输入缺少设计系统规定的持久可见指示。图 `composer-kbd-1440-dark.png`、`composer-kbd-1440-light.png`。 | 在公共字段规则下为输入区保留一道清晰键盘指示。验证窄窗、输入扩高、附件拖放提示及 Runtime 的独立实现。 |
| P2-01 | 外观主题 Select，`ui/primitives.css:337` 与 `styles.css:42–46` | **实测。** 从「主题」帮助图标 Tab 到 Select。1440 深色边框 1px 和外圈 2px 同为白色，偏移 1px。违反一道描边。图 `appearance-focus-1440-dark.png`。 | 统一字段原语的 keyboard ring 及边框组合，保证高对比、错误和禁用仍可辨识。可能影响其他 `.ds-select` 消费者。 |
| P2-02 | 设置帮助图标，`ui/primitives.js:112–121`、`ui/primitives.css:117–143` | **实测 + 源码。** Tab 到主题旁 15px 帮助图标，计算 outline 为 none。该节点是 `span[role=note]`，文字仅设置原生 title；键盘和点击没有打开帮助的操作。违反可点击帮助和可见焦点契约。图 `appearance-help-1440-dark.png`。 | 复用有名称的按钮和 Popover，核对 Enter/Space、Escape、回焦与目标尺寸。影响设置卡片/行引用处。 |
| P2-03 | 文件面板初次加载错误，`files-panel.js:110–113,137–151`，`.files-tree-status` | **实测。** 在有选中项目的应用中首次请求根目录失败，顶部显示「无法读取项目文件」，树显示「还没有打开项目」。错误分支清空条目后进入空态。违反状态明确，用户可能误以为项目已关闭。图 `files-1440-dark.png`。 | 错误分支专用状态，保留刷新入口。仅当响应明确 `noProject` 时显示未打开项目。影响 Classic 与 Runtime 文件面板，由共用组件验证。 |
| P2-04 | 设置外观常驻说明，`settings.js:18,149`，`.settings-page-desc` | **实测。** 打开常规，标题下的「自定义界面主题与字体排版偏好」重复主题、字体、字号控件名称。下方 System 说明可就近放到主题帮助；保存失败提示本身保留。违反内容克制，增加阅读和滚动成本。图 `appearance-1440-dark.png`。 | 删标题下重复句，把系统跟随解释移到就近帮助。保留动态保存反馈。仅外观页。 |
| P2-05 | MCP／Provider 搜索 placeholder，`mcp.css:180`、`provider-management.css:194`、`tokens.css:353` | **源码确认，浅色界面有截图。** `--ds-text-faint` 在浅色为 `#afafaf`。以白底作为最亮边界计算约 2.19:1，低于规范 4.5:1；实际底色更暗时对比度继续降低。若 placeholder 是可见的唯一用途线索，用户识别成本提高。图 `market-1440-light.png`、`provider-add-1440-light.png`。 | 浅色用更清晰的次级字色并保留可访问名称，验收时取实际合成底色。先覆盖两处搜索和 Provider 字段，再扩到其他 faint 文本。 |
| P2-06 | 模型供应商页主操作重复，`providers.js:1077–1083,1104–1124`，`.prov-header-actions`、`.prov-catalog-footer`、`.modal-actions` | **实测。** 有已配置服务时，同屏出现两处「添加服务」、两处「重载 pi 配置」。同义按钮各走同一业务入口，但分散在头部、目录卡片和页尾。图 `provider-remove-1440-light.png` 的遮罩背景可见四处入口。违反组件与内容层级一致性。 | 页面形态保留一处主动作及一处重载；确认是否需要在复用的模态形态展示页尾动作。保持重载权限和确认流程。 |
| P3-01 | 协同文档顶部状态与操作说明，`collab-panel.js:33,102`、`collab-canvas.js:92,639` | **实测。** 展示已保存版本的画布，标题副文案常驻存储实现，两个状态行都显示版本，底部整段快捷键继续占用窄栏。违反内容克制。图 `collab-native/failure.png`。 | 保留「已保存」和节点/连线数量，版本保留一处。把完整快捷键列表移至可点击帮助。影响协同面板，不改变保存、预览和 undo。 |
| P3-02 | 供应商页副标题，`providers.js:1088–1089`，`.settings-page-desc` | **实测。** 打开模型配置，默认介绍暴露 `models.json` 路径。对添加/切换服务无直接作用，密钥输入边界则需保留。图 `providers-1440-dark.png`。 | 把路径移入诊断或按需帮助，在配置步骤保留 API Key 安全说明。影响供应商页。 |

没有确认 P0。已确认 **P1 2 项、P2 6 项、P3 2 项**。浅色对比度为基于源码色的计算发现，其余上表都有对应当次渲染。专项断言失败见下节。

## 6. 图标、CSS 和未验证项

扫描 production `public/` 186 个非 vendor 的 JS/CSS/HTML/SVG 文件。共 22 个 CSS，找到 95 处 SVG 开始标签/构造写法，源文件中无独立 SVG。该计数统计声明点，模板重复实例、独立窗口内联 SVG、商标、xterm 与流程图装饰另看各自所有者。入口 HTML 43 处，随后为工具视图 7、Browser 6、任务视图 6、util 6、项目 5、动作菜单 4。设置/Chrome/选取菜单截图见证据索引。常见图标以 `styles.css:115` 的 15px、stroke 1.7、`currentColor` 为起点，菜单源映射 stroke 1.6，附件、返回、关闭和面板手势继续核对相同角色。流程图节点、品牌与原生控件可以保持不同视觉规则。

IconMCP 只在同义图标缺失时进入选项。若日后将帮助图标改成可点按钮，可先查现有帮助语义，再用 `circle-help outline`、`info circle stroke` 查同系列。折叠/返回箭头可先比对已有路径，必要时查 `chevron left round outline`。官网说明图标库使用 MIT。箭头集合需要 JavaScript，本次通过官网读取入口信息，表内只提供搜索词。[图标库](https://iconmcp.com/?set=arrows) · [官方 Agent 入口](https://iconmcp.com/agents)

CSS 粗计发现 267 处 hex 形态词元、55 处 `!important`、4222 处 px 长度、134 处焦点伪类，`--ui-*` 与 `--ds-*` 的 `var()` 词元分别为 901 与 814。`tokens.css` 311 个唯一属性名中有 108 个未匹配本次静态 `var()`。这些数字含 token 定义、重复样式、跟随变量、注释或选择器中的词元。应交叉检查 CSS 自定义属性的 JS 读取、运行时拼接、原生桥和测试后再判弃用。可证实的后置覆盖包括 `.ds-select` 和全局输入焦点。既有 `!important` 中含 `[hidden]` 语义保障和 reduced-motion，保留具体用例边界。 `--ui-focus`、`--focus-ring`、`--ui-focus-glow` 的消费者优先排查。

待验证项按证据登记：

- **Electron 外壳** `tests/app-shell-electron.cjs` 24/25，13 个场景截图并生成原生截图等文件。供应商选择器旧预期等待超时，启用组合场景的追加运行也停在该处。Chrome 已用专项 fixture 补拿供应商界面证据。
- **Browser** `tests/browser-workbench-electron.cjs` 在 1 个通过检查后退出 1，`UnknownVizError`。未确认根因。Runtime 普通专项的开发分支也停在原生 Browser 超时，已保存运行中对话等 6 张图。
- **Runtime Refined** 在计算样式检查要求 15px/18px 时失败，该次检查没输出实际数值，且断言与历史尺度有关。需要采集新值后确认是测试旧期待还是产品偏离。
- **凭据** 桥接层 43 条通过，真实 Electron 阶段 2/4，`key_input_unqualified` 导致窗口未打开。无法据此确认窗口样式或断言真实认证失效。
- **Collab** 正常沙箱和 760/1200/1536 画布几何有通过检查。浅色断言同时校验背景、字色和无描边，未输出失配项。`collab-native/failure.png` 仍见深色画布。须对实际根 theme 与组件 computed style 取样后定位。
- **Worktree** 菜单命中、Escape 与多个视口边界已验证，随后工作区对话框 Tab 回绕断言失败。缺少失焦后的 activeElement 详情，暂列待复测。
- **Specs** 用 Electron 可执行文件运行 `tests/specs-electron.cjs` 后 10/10，3 张截图。初次误用普通 Node 启动，重跑结果替代该入口错误。
- **Diff** `tests/diff-comment-ranges-electron.cjs` 正常沙箱 34/34，覆盖选择区间、保存、恢复、过期反馈、删除与再次启动回读，保存了 3 张截图。
- **其他限制** 原生 Browser 地址焦点 glow、真实 Toast 排队、强制颜色及所有 ARIA 名称仍需复测。测试未取得确定截图的路径不升级为发现。

## 7. PI-Desktop 对照

从用户给出的 OneDrive 路径读取并解码 24 个 PNG，按原始文件名匹配仓库参考编号。21 张为 1808×1205，3 张为 1808×1204。参考档案记录 20 深色、4 浅色及约 150% 缩放，取意图和 CSS 逻辑尺寸，色值与几何以各自渲染证据复核。证据包含按编号排序的联系表和每张原图 SHA-256。[参考截图档案](pi-desktop-reference/01-screenshot-inventory.md)

| 参考 | 对照和可执行取舍 |
| --- | --- |
| REF-001–004、021 | 主区、侧栏和设置导轨沿用紧凑层级。pi-GUI 实测 46px 顶栏和 275px 导轨与参考尺度对应。项目状态与 Pi 数据归属按自身 UI 保留。设置概览在宽屏有短组卡片重复导航和大片留白，可在后续页面设计验证是否需要调整密度。 |
| REF-007、013–014 | 借鉴模型目录和配置任务分组。pi-GUI 700px 时将双栏表单改为纵向滚动，保留固定主操作与凭据边界。继续检查窄窗长字段和焦点，避免机械沿用四列目录或外部产品的凭据流。 |
| REF-008、010、012 | Skills、MCP 与更新可复用统一的搜索、范围控件、状态和分组。保留 pi-GUI 对本机真相源、权限和必要错误的解释。 |
| REF-015–017、020、022–023 | 现有模型浮层、Thinking、消息工具和 `/` 菜单可沿用分组及可见键盘反馈。上下文比较使用同一任务及可用指标，不能推定 Pi 提供参考产品的全部统计。 |
| REF-018–019 | 借鉴标题工具组和文件／预览分栏，原生 Browser、只读文件和面板 owner 遵循本仓库职责。 |
| REF-005–006、009、011、024 | 当作信息层级参考。语音、独立 Skill 市场、子 Agent 规则编辑和文件补全不构成缺陷或新增功能要求。 |

「AI 生成痕迹」按可复查的设计结果描述，例如重复介绍、重复版本号和无动作的帮助标记。没有据此判断界面的作者或生成方式。

## 8. 证据索引与整改路线图

- 浏览器证据以 `chrome-*.json` 的 `rows[].file` 定位。对应记录含主题、CSS 视口、DPR、可见状态选择器、控件数据和捕获失败列表。经补查可达的场景以最终截图为证据，早期选择器或 fixture 未命中记录保留供回溯。原生证据按 `electron-shell/`、`diff-review/`、`runtime-base/`、`worktrees/`、`specs-native/`、`collab-native/` 等目录定位。浏览器复现脚本保存在证据目录 `reproduce/`，从基线 checkout 根目录执行，输出路径为脚本第一个参数。
- 代表问题图为 `settings-search-focus-1440-dark.png`、`appearance-focus-1440-dark.png`、`appearance-help-1440-dark.png`、`files-1440-dark.png` 和 `collab-native/failure.png`。参考对照用 `reference-contact.jpg` 及 `reference-inventory.json`。 `source-inventory.json` 提供扫描词元与最高频源文件。
- **第一批，共享焦点。** 同一所有者处理 P1-01、P1-02、P2-01、P2-02，先定输入、复合搜索和可点帮助原语。按真实鼠标、键盘、错误状态、深浅及宽窄复核，确认菜单和原生边界后再替换旧焦点调用点。
- **第二批，反馈与组件。** 处理 P2-03、P2-05，收敛字段、按钮和状态通用样式，先做设置、MCP、Provider 样本。保留终端、审批和文件的事实语义。
- **第三批，页面文案与响应式。** 遵循 P2-04、P2-06、P3-01、P3-02。使用已落地的帮助原语处理说明，合并重复信息和操作，补长中英文、窄窗、焦点和禁用样本。
- **最后，原生专项与跨模块复查。** 在已知环境中闭合 Browser、Worktree、Collab、Runtime、凭据与 ConPTY；逐项记录失败根因和无法覆盖的场景。先完成公共层改动的所有权交接，再分派互相独立的页面，避免多 Agent 同改共享文件。每批验收沿用 [设计系统的视觉验收](design-system.md#视觉验收)。

本次回滚边界为这份新增报告，证据在仓库外。保持报告和产品整改分开，等待人工验收。
