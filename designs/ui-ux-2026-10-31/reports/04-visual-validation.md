# 真实视觉与交互验收记录

本记录只证明设计原型及设计组件的表现，不证明生产功能已经迁移。推荐A进入人工设计验收；没有替用户批准实施、合并或发布。

## 环境与证据范围

Windows，仓库已安装的Electron/Chromium，sandbox与contextIsolation开启，nodeIntegration关闭。没有安装Playwright、浏览器、前端框架或npm依赖。生产原版运行真实main/preload/public，后端用现有离线visual-harness；原型运行claude-design正式HTML导出的本地页面。所有需要写入的运行profile、日志、上传与夹具都位于TEMP。

原版已取得29张唯一PNG（首次21张、补充9张，其中空会话一张重合），两轮renderer错误均为0。原型核心矩阵102张，另有思考展开、键盘调整面板和设置分类12张补充。缩放菜单4张已由严格补测替换。目录中的早期图片不是全部有效验收材料；有效清单以 `results.json`、`detail-results.json` 与下方索引为准。

请求的客户区是1280×800、1440×900、1920×1080。生产窗口测得准确三尺寸，OS DPR1.5时1440×900 PNG为2160×1350。原型最终采用真实Chromium离屏渲染，以解决隐藏窗口旧合成帧；本机离屏viewport测得1280×801、1440×901、1920×1081（Windows/Electron取整多1 CSS px），DPR1，PNG同像素尺寸。页面125/150% zoom分别测得1152×721/DPR1.25、960×601/DPR1.5。**没有将这些离屏图片声称为所有物理Windows高DPI资格。** 每张图的实际width/height/dpr/pixels均保存在记录中。

## 实际结果（不同检查不相加冒充一个总通过数）

| 验证对象 | 运行命令 / 证据 | 结果 |
| --- | --- | --- |
| 设计系统格式 | claude-design-system `artifact.mjs check system` | 0 problems；来源meta提示不阻止使用 |
| 双画板格式 | claude-design `artifact.mjs check canvas` | 2 boards，0 problems |
| 设计系统组件真实预览 | `node system/project/verify-previews.cjs`，原始记录 `system/project/verification/results.json` | 388/388，失败0、跳过0、renderer错误0，40张PNG |
| 设计系统颜色计算 | `system/project/Contrast-Checks.md` 与配对记录 | 78/78指定实色配对达标；不代替像素/字体检查 |
| 完整原型矩阵与主要操作 | `node tools/verify-prototypes.mjs` | 280/280，失败0、跳过0，102次截图；最终源/ZIP摘要绑定manifest |
| 缩放、思考、面板和设置补测 | `node tools/verify-details.mjs` | 24/24，失败0；明确检查125/150%模型浮层确实打开、边界及Escape焦点 |
| 异步归属与停止时序 | `node tools/verify-async-ownership.mjs` | 9/9；旧导出复现8/9，唯一失败为旧retry提前释放stopping |
| 生产canonical/构建/安装 | 未运行 | 生产代码未改、未进入实施；不从上述检查推断通过 |

完整原型矩阵含 A/B × 浅深 × 三尺寸 × 正常会话/空会话/运行中/长会话/Changes/Browser/错误，另有菜单、Dialog、模型、设置、键盘和缩放场景。控件检查是真实DOM事件和Electron输入事件，布局由Chromium排版；没有用jsdom的零尺寸来证明视觉。

## 关键页面截图索引

可在 [总验收入口](../index.html) 选择原版与方向对照，并筛选窗口/主题。所有图可点击查看原始分辨率。

| 页面 / 状态 | 原版代表图 | A代表图 | B代表图 |
| --- | --- | --- | --- |
| 正常会话 | [原版](../evidence/current/dark-1440-chat.png) | [A](../evidence/prototype/a-dark-1440-chat.png) | [B](../evidence/prototype/b-dark-1440-chat.png) |
| 空会话 | [原版](../evidence/current/dark-1440-empty.png) | [A浅色1280](../evidence/prototype/a-light-1280-empty.png) | [B浅色1280](../evidence/prototype/b-light-1280-empty.png) |
| 工具与Agent运行 | [原版长夹具](../evidence/current/dark-1440-full-fixture.png) | [A运行](../evidence/prototype/a-dark-1280-running.png) | [B运行](../evidence/prototype/b-dark-1280-running.png) |
| 长会话 | [原版工具](../evidence/current/dark-1440-tools.png) | [A长会话](../evidence/prototype/a-dark-1920-long.png) | [B长会话](../evidence/prototype/b-dark-1920-long.png) |
| 思考展开 | 思考等级已在原版实测；内容与生命周期另有源码审计 | [A](../evidence/prototype/a-1440-thinking-expanded.png) | [B](../evidence/prototype/b-1440-thinking-expanded.png) |
| Diff右栏 | [原版](../evidence/current/dark-1440-diff.png) | [A](../evidence/prototype/a-dark-1440-changes.png) | [B](../evidence/prototype/b-light-1280-changes.png) |
| Browser右栏 | [原版桌面面板](../evidence/current/dark-1440-btnBrowser.png) | [A](../evidence/prototype/a-dark-1440-browser.png) | [B](../evidence/prototype/b-dark-1280-browser.png) |
| 模型选择 | [原版](../evidence/current/dark-1440-btnModel.png) | [A深色](../evidence/prototype/a-dark-1440-model.png) | [B浅色](../evidence/prototype/b-light-1440-model.png) |
| 右键菜单 | 原版已有anchor-menu，源码已审计 | [A](../evidence/prototype/a-1440-contextmenu.png) | [B](../evidence/prototype/b-1440-contextmenu.png) |
| 重命名Dialog | 原版会话操作源码已审计 | [A](../evidence/prototype/a-1440-rename-dialog.png) | [B](../evidence/prototype/b-1440-rename-dialog.png) |
| 错误与恢复 | [原版工具失败](../evidence/current/dark-1440-tools.png) | [A](../evidence/prototype/a-light-1440-error.png) | [B](../evidence/prototype/b-dark-1440-error.png) |
| 任务 | [原版](../evidence/current/dark-1440-navPlanner.png) | [A示意](../evidence/prototype/a-1440-tasks.png) | [B示意](../evidence/prototype/b-1440-tasks.png) |
| Skills/Extensions | [原版](../evidence/current/dark-1440-navExtensions.png) | [A示意](../evidence/prototype/a-1440-skills.png) | [B示意](../evidence/prototype/b-1440-skills.png) |
| 模型与账户 | [原版供应商](../evidence/current/dark-1440-navProviders.png) | [A设置示意](../evidence/prototype/a-settings-models.png) | [B设置示意](../evidence/prototype/b-settings-models.png) |
| 应用与更新 | [原版](../evidence/current/dark-1440-navAppUpdates.png) | [A设置示意](../evidence/prototype/a-settings-updates.png) | [B设置示意](../evidence/prototype/b-settings-updates.png) |
| 诊断 | [原版](../evidence/current/dark-1440-navDiagnostics.png) | [A设置示意](../evidence/prototype/a-settings-diagnostics.png) | [B设置示意](../evidence/prototype/b-settings-diagnostics.png) |
| 日志 | [原版](../evidence/current/dark-1440-navLogs.png) | [A设置示意](../evidence/prototype/a-settings-logs.png) | [B设置示意](../evidence/prototype/b-settings-logs.png) |
| 原生MCP | [原版](../evidence/current/dark-1440-navMcp.png) | 入口与能力边界见功能映射 | 同左，不把完整MCP业务声称已制作 |
| 150%页面zoom | 非物理DPI完整资格 | [A菜单](../evidence/prototype/a-zoom-1.5-model.png) | [B菜单](../evidence/prototype/b-zoom-1.5-model.png) |

原型内的Diff、设置值、工具结果与状态都是演示，不能拿图中的“完成”作为真实业务完成证据。对照图夹具内容不同，比较的是布局、密度与层级，不是像素差分。

## 已实际操作与可观察结果

- 切四个会话：固定identity、顺序与Y坐标不变；s1/s2各自草稿恢复，s3阅读位置恢复；s2停止后离开再返回仍为停止状态。
- 切任务/设置再回对话：草稿不丢；侧栏展开/收起可恢复，项目折叠不改变会话身份。
- 模型：聚焦搜索、空结果、方向键与Enter选择、选择确认中的反馈、Escape关闭并回触发器。思考等级入口同样可关闭并回焦点；生产Pi回读未接入。
- Classic附件演示可移除；切Runtime后禁用附件并移除演示托盘。Classic运行中可追加说明，Runtime运行中输入禁用；停止等待期输入和发送都禁用。
- 右键菜单贴触发位置并钳位视口，点击外部/resize关闭；菜单打开Dialog、Tab首尾循环、Escape后回原会话触发项。
- 错误重试只更新原会话；停止使旧retry操作身份失效；9项确定性资格覆盖旧回调和后台切换。
- Changes与Browser显示/隐藏、面板关闭、局部Diff滚动；键盘左箭头将面板从420调到436 CSS px（两方向分别实测）。指针拖动实现存在，但未单列长时鼠标拖动专项。
- `prefers-reduced-motion` 在真实Chromium启用，CSS取消动画和过渡；focus轮廓可见，不用颜色单独表达状态。

## 逐图视觉判断与迭代

作者实际查看了原版chat、model、Changes、Extensions、Diff、更新、MCP与长夹具；查看改版A浅色1280空态、A浅色1280 Diff、A深色1280运行、B浅色1280正常会话、B深色1280 Browser、A模型、两方向菜单/Dialog、错误、任务、设置、长会话和缩放菜单。其余截图由矩阵捕获并收录图库，**不把102张自动截图都表述为逐张人工检查过**。设计系统另查看Dialog/Menu/WorkPanel/Chat/Tooltip/Cover，记录在其Visual-Verification中。

观察结论：两主题的阅读轴、Composer与正文边缘一致；A在小窗口保留更多工具内容，B长文行高更舒适但首屏容量较低；Diff颜色有符号/行号辅助；菜单和Dialog层级清楚；代码/长路径在自身区域滚动。没有在已看代表图发现外层横向溢出或主要操作被意外覆盖。推荐A作为统一方案，B作为可编辑对照保留。

实际修复过的原型/验收问题：

1. 预览组件 `.pw-panel` 固定300px高污染应用面板，Diff被截断。应用外壳改为独立 `pg-` 命名空间，继续消费同一Tokens，避免组件演示布局规则相互污染；真实复测面板占满workspace。
2. 菜单原来固定在主区右上，改为测量触发点、先测量后显示、视口钳位；补回原触发器焦点。
3. retry回调串会话、停止后侧栏文字不更新；改为session view归属。增量审查再发现同会话retry可能提前解除stopping，使用每会话操作身份失效旧回调；修复前8/9→修复后9/9。
4. 隐藏窗口可能捕获上一合成帧，菜单DOM已见但图像未出现；最终使用offscreen+invalidate+双rAF+220ms刷新并重拍矩阵。早期几何280通过不能作为该菜单像素证据。
5. 验收驱动缺Enter字符事件、将`ArrowDown`直接传给Electron产生空DOM key；分别补char与`Down`映射。初轮274/280，定向84/88失败记录保留；修正后定向88/88及完整280/280。
6. 页面zoom后必须把DOM CSS坐标乘zoom后发送Electron输入。严格补测首次12/24，修坐标后20/24，等待既有30ms焦点恢复后24/24；最终四张缩放菜单图确实含浮层。没有删断言或把失败改skip。

原始记录保留 `initial-results.json`、`intermediate-keyboard-results.json`、`pre-compositor-results.json`、`initial-detail-results.json`、`pre-focus-detail-results.json` 与键盘根因记录。正式导出源和ZIP摘要在 `exports/export-manifest.json`。画布工具曾输出4条相同 `tabindex/tabIndex` React开发警告，发生在官方画布编辑器runtime中；记录保留，没有把它伪装成生产错误或修改第三方runtime来消音。

## 限制与人工验收

生产Runtime呈现、实体中文IME、读屏器、完整物理125/150/200%DPI、原生Browser遮挡/分屏/进程控制、真实模型长时运行、生产认证/更新/撤销和打包安装没有由本原型证明。原版 Browser面板是真实桌面入口，但本轮没有对外部网页执行导航控制。PI-Desktop采用官方历史运行截图，不是本次现场启动。

独立审查首轮4项Important，一次增量到7/8通过；末项IR01随后由作者修复并做9/9归属验证。没有把作者复验写成独立Agent全部通过。见07报告附录。下一步请人工选择方向、核对关键页面和60项映射，再决定是否授权实施；本阶段到此停止。
