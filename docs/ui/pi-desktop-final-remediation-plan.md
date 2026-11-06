# PI-Desktop 最终审计修复计划

对应 [最终审计](pi-desktop-final-audit.md)，基线 `326cb3284c5bf67398290ca4cd6ea8bfd5ee8496`。

本文件是可执行计划，**不是实施或发版授权**。本次审计仅提交文档证据，没有修复生产代码。当前问题为 P0 0 / P1 1 / P2 9 / P3 4；历史待收尾 L01–L07 共7项。

## 范围与依赖

顺序：**R1 → R2 → R3 → R4 → R5 → R6**。R4可在R2后单独实施，但必须在最终冻结前完成；R3/R5不得用新覆盖重新掩盖R1修复。

保留原生JavaScript、现有tokens、既有menu/presenter/Runtime/right-pane/Browser owner。不引入依赖、框架迁移、第二套菜单、假按钮、假状态或付费模型测试。写用例全部使用TEMP项目/用户目录/上传路径；不操作真实供应商配置或真实会话。

开始实施前重新核对main、工作区、准确CI；如果main已变化，先确认这些定位和复现是否仍成立。使用独立 `codex/` 修复分支。按回滚边界提交中文提交信息；推送、PR、合并、发版分别等待相应授权。

## R1：先恢复真实可用性

**问题：AUD-001(P1)、003/004/008/009/010(P2)。建议立即执行。**

### R1.1 设置操作可见和可达

1. 从 `app.js → settingsSurface.presentDetail → providers/diagnostics/logs` 追踪每类操作；列出确实重复的“关闭”与不能隐藏的“保存/导出/刷新”等。
2. 去掉 `styles.css:2983` 对所有直接 `.modal-actions` 的无条件隐藏。需要隐藏重复展示按钮时由具体页面明确标记，默认保留真实业务动作。不以叠加另一条important修复。
3. 统一“右上添加服务”与“空态添加服务”的既有presenter策略。优先利用当前openModal/Detail能力；不要另造表单或复制保存handler。
4. 增加真实Electron回归：供应商列表的两条添加入口都能看见保存/取消、Tab能到达；对有效fixture提交，mock请求恰好一次且仍经过原验证；缺ID/Base URL、原文密钥输入保持拒绝；取消无写请求。诊断复制/导出/刷新可见且仍走原脱敏构造器。

**验收**：深/浅、空/非空供应商、鼠标/键盘入口均可操作；原provider-auth105条及相邻设置检查不减少；没有真实配置写入。删除新增服务/密钥测试数据只在TEMP中进行。

### R1.2 设置键盘与当前页投影

1. 在 `settings-surface.js` 让搜索输入与menu只消费一次Down，检查输入框→首项、首项Up→输入、多个/一个/零结果、Home/End、Escape返回与焦点。
2. 在现有Extensions tab owner上投影 `navMcp/navCapabilities/navExtensions` 与标题；内部tab切换和外部导航共用该派生事实。不得建立第二个可写tab存储。
3. 对实际DOM派发从搜索框开始的冒泡键盘事件，并用Electron受信Down复验。只在menu本身派发事件的旧用例不够。

**验收**：一次Down进入navAppearance；搜索后进入第一个可见结果；MCP/能力/Skills各自有正确且唯一的当前导航，实际tab与标题一致。返回Classic/Runtime不改变会话/草稿。

### R1.3 窄窗外观行

1. 按 `font-size-ctrls` 的真实嵌套修订 `.ds-settings-row-multiline` 的换行策略，保留可读标签宽度；控件组空间不足时整组移到下一行。
2. 700×600、900px、1205×803，字号100/130%，深/浅，实际测标签和控件矩形，不仅检查document.scrollWidth。

**验收**：字体大小不再逐字竖排，range/四个选项均可见可操作，帮助图标不被挤没；字号/字体/主题存储及首屏恢复仍由既有逻辑完成。

### R1.4 图表浅色与键盘提示

1. `viz.css` 的应用表面/文字/边框使用已定义语义token，去掉无定义变量导致的固定深色fallback；保留表达数据系列和阈值含义的颜色。
2. `viz-chart.js` 区分指针与focus事件。focus用生产数据点的 `getBoundingClientRect()` 转到wrapper坐标，进行四边约束；鼠标继续使用实际指针位置。
3. 用合法schema经过生产Markdown卡片→打开可视化→悬停及键盘focus，不用手写同形状假tooltip替代。

**验收**：浅色入口按钮和tooltip正文对比度至少4.5:1，深色无回退；keyboard tooltip与wrapper相交且完整在可视面板内；窄面板/长label/高低点/缩放均可见。维持schema恶意输入降级、真实数值、绘图边界与关闭释放。

**R1验证入口**：`node tests/settings-acceptance.cjs`、`node tests/theme.cjs`、`node tests/provider-auth.cjs`、`node tests/ui-ia.cjs`、`node tests/viz-schema.cjs`、`node tests/viz-ui.cjs`；在现有正常沙箱Electron工具增加上述生产路径回归。开发中先保留红灯再改实现；不复制生产算法到测试。

## R2：修验收盲区和测试副作用

**问题：AUD-005(P2)、013(P3)；同时补R1揭示的覆盖缺口。依赖R1可用入口。**

1. 逐项清查 `tests/ui4-pane.cjs`：区分真实设计契约、生产owner一致性、过时的420px文字/数值。392px有当前设计依据，不能为了测试改生产尺寸。
2. 通过当前可见的工作面板/launcher进入Changes，再测试开关、Escape焦点恢复、宽度记忆、双击复位、滚动、窄窗fallback等。避免对隐藏入口发送坐标点击。保留原有有效断言并逐条说明参数调整，不通过删检查或skip过关。
3. `test:ui4`当前不含这份Electron脚本。保持canonical从package递归生成；用既有专项alias/正常沙箱工具表达桌面验证，是否扩展CI另行评估，不在workflow抄一份列表。
4. 对剪贴板测试，在开始时有界读取原格式、在finally恢复；不写日志/报告。不以writeText('')代替恢复，不把用户剪贴板长期存到fixture。
5. 设置/primitives测试报告采用实际输出口径；原语5组无统一断言数就记录这一事实。完整CI的命令skip=0和内部权限skip必须分别显示。

**验收**：ui4专项完整执行退出0，原有有效场景没有减少；97原场景与新增项同时通过；模拟一次中途失败也能恢复剪贴板。测试只能清理自己创建的TEMP资源。

**建议入口**：`node tests/ui4-pane.cjs`（新TEMP输出）、`node tests/ui4-integration.cjs`、`node tests/split-workbench-ui.cjs`、`node tests/panel-restore-ui.cjs`、`node tests/browser-workbench-ui.cjs`，以及既有工作台Electron专项。每次输出使用新目录，不能覆写历史证据。

## R3：主要页面的统一视觉收尾

**问题：AUD-002/006(P2)，关闭历史L01/L07。依赖R1/R2。**

### 设置表面

- 核对 `.appearance-body` 从fieldset迁到section的所有引用，清理实际不再匹配的旧规则；组标题与独立行tile采用现有原语，不再套第二层边框卡片。
- 使常规、供应商、快捷键、更新以及已有Skills/MCP/能力页的标题、留白、正文和滚动层级有一致的页面边界。保留扩展信任、unknown、native MCP与双更新业务，不能把原工具页删成空卡片。
- 不把重做React式路由、引入主题缩略卡或实现参考AI偏好设置作为视觉修复前提。当前workspace/settings/Extensions所有权保留。
- 对 `.ds-select`、settings标题和控件同名覆盖做引用范围分析；清理已被证明失效的规则，不以!important数量归零为目标。

### 欢迎页

- 以参考 `chat-shell.css:671–774` 的居中、间距和溢出规则重排原welcomeReady/NoProj/Restore；品牌图标可以继续使用pi-GUI已有资产。
- 明确welcome样式唯一负责文件，移除已被后加载stylesheet覆盖的重复意图。
- 不增加无真实状态来源的模型配置/密钥完成清单；已存在的选择项目、恢复等行为继续可达。

**验收**：1205×803/DPR1.5，深浅、侧栏展开/折叠、宽/窄/短窗；外观组没有额外包框，标题与内容坐标有源码依据；欢迎区空间层级明显对齐参考。设置保存和键盘红灯不得复发。对没有浅色原图的设置只做固定源码+计算样式比较。

## R4：应用自有 Browser 空态

**问题：AUD-007(P2)，关闭历史L03。独立于网页内容主题。**

1. 先明确about:blank→首次导航→导航失败→返回空页→关闭/重开时的原生视图owner和权限状态。
2. 在现有BrowserController/Pane边界选择有依据的空态承载：可以在未导航时安全显示renderer引导并按原owner管理原生附着，或仅对应用自有空内容设置主题。设计前核对原有Agent bridge、模态遮挡和bounds更新，不能靠z-index覆盖native。
3. 所有已导航网站保持原主题/脚本/权限；不向任意页面注入应用颜色，不自动外联，不把“空白”误判为Agent可用。
4. 运行现有 `tests/browser-workbench-electron.cjs` 的正常沙箱64场景及新增空态场景；使用TEMP和loopback页面，记录native整窗及page捕获，确认20次切换/销毁后无隐藏WebContents。

**验收**：深浅空页有清楚引导、背景一致；输入URL后原页面、输入焦点、权限与分屏恢复保持；关闭/释放、模态遮挡、双Runtime归属均不回归。若修改原生控制器，按仓库高风险边界补专项安全审查；旧UI通过结论不得代替这一步。

## R5：低风险参考差距

**问题：AUD-011/012/014(P3)，关闭历史L04/L05/L06。依赖R1/R3/R4。**

| 项目 | 修改边界 | 验收 |
| --- | --- | --- |
| Slash | 继续使用现有注册表/IME/定位控制器；展示宽度可对齐外Composer，在原生面板旁仍服从实际可用边界；组标题和提示是展示，不新增命令 | 宽窗760px目标、窄窗不溢出；↑↓/Enter/Tab/Escape、合成composition及实际OS IME分层记录 |
| 上下文tip | 只调现有tip模式的宽度、14px圆角、16px留白；不可改动模型/Thinking共享模式 | 参考宽窗376px、窄窗按可用空间；unknown/额度警告/已用文案真实，字段不为截图捏造 |
| 项目标题 | 原列表滚动owner下固定分组标题或小范围挪层级，不复制项目状态 | 长列表标题/底栏均可达，菜单定位、稳定顺序和展开状态不变 |

允许产品明确接受某个P3差异并给出理由；不得无记录地再次留给“后续阶段”。三个条目必须逐项关闭或由验收者接受，不能用“总体接近”代替。

## R6：冻结后重新验收，决定是否结束

1. 冻结生产/测试输入，记录准确SHA、工作区diff、文件摘要和参考24图映射；重新检查remote main，不用历史分支图充当当前效果。
2. 跑本轮修改涉及的定向套件和正常沙箱Electron，保留首次失败、修复、复跑及实际断言数。新增检查加入仓库既有入口；不抄canonical清单、不削弱安全断言。
3. 按测试政策完成冻结状态单次本地canonical，或在已授权的当前PR上取得完整canonical CI；若为累计续跑明确标记。最终main的CI、打包、安装资格分别记录；不要把234个命令叫234个断言。
4. 改public/server后用 `npm run build:app -- --rebuild --output-root <新的独立目录>` 重建；包内文件摘要匹配；再启动实际打包GUI验关键路径，不能只验源码窗口。
5. 逐项重新比较本审计24图矩阵及新增Bug图。只保存真实Electron捕获，以每图CSS视口/DPR校准，renderer/native分别记录；不拉伸、拼接或生成相似示意图代替证据。
6. 补所需资格：作者外隔离审查、Windows真实IME、完整Collab交互、原生窗口手工操作。真Pi/真实模型/远端登录及安装升级按明确授权另跑，不因缺证据写“通过”。Object witness的8个未验项继续准确披露，研究资格不自动开放生产写入。
7. 新增或修订交付报告，把14项问题和L01–L07逐项标为已修复/误报理由/验收者批准延期。不得继承本报告作者的通过判断；该判断目前为不通过。

### 结束门槛

- P0=0、P1=0；所有影响实际使用的P2修复并由生产路径复验。
- 其他P2有可核验修复或明确、知情的处置；主要页面无明显阻断视觉问题。
- 旧ui4专项不再在首屏超时；新增回归覆盖保存可达、search Down、子页导航、窄窗标签、viz主题/focus，且不影响原核心功能。
- 7项历史收尾逐项清算，合理业务差异单独保留，未实现功能不伪装为完成。
- 准确状态的完整CI/定向/真实GUI证据可复查，剩余未验证资格被验收者明确接受。

满足以上条件后才建议进入正式发版测试。是否发布仍需独立授权和现有releasing流程，不由UI审计或合并许可推导。

## 单独的产品决策，不自动实施

REF-024的@文件提及/索引、实时语音、市场、独立子智能体声明、任意文件CRUD/多标签扩张、消息编辑/删除/重生成与完整耗时瀑布：分别评估真实owner、协议、权限、数据与交互契约。维持Pi外部程序边界；不把它们混入本计划的Bug修复，不用伪UI补截图覆盖率。

保留API Key环境引用/官方login、unknown三态、Runtime历史只读、原生Browser Agent行、Specs只读上下布局等合理差异。统一收尾应修真实问题，避免改掉这些安全与业务约束。
