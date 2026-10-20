# UI-5 最终视觉对照审计

日期：2026-10-18（Asia/Shanghai）。本文件在任何产品文件修改之前建立。

## 基线与材料

- Worktree `C:/pi-GUI-ui5`，分支 `codex/ui5-diagnostics-polish`，HEAD `c0769cd78d3e25d39aed5c97bde09af397a28cf8`；开始时 clean，无用户未提交改动。
- 已核对 `09f6320` 日志修复、`0add82d` 回归测试、`c0769cd` 证据归档；本轮不改这些实现。
- 读取本 worktree 的 AGENTS、UI-1/2/3/4 集成报告及 UI-5/补丁验收。UI-0 的 `UI-design-contract.md`、`UI-component-mapping.md`、`UI-implementation-plan.md` 仅在 `C:/pi-GUI/docs/claude-ui-redesign/` 可用，以只读方式参考。两处均未找到 REVIEW.md，以现场 Git 状态为准。
- 设计素材 `C:/pi-GUI/docs/素材.zip` 包含六份文本/JSON，已读取布局规格；其中截图 DPI 说明为 150%，尺寸仍需用真实截图校验。没有提取或复用品牌图标、字体或宠物素材。
- 不 fetch/查 Release：遵守本项目离线约束。Jev 尝试因 API DNS 失败降级为普通工程判断；不把缓存远端状态视为当前事实。

## 真实参考图与裁切边界

原图目录 `C:/Users/21022/OneDrive/图片/claude/`。文件前缀均为 `Snipaste_2026-10-15_`，后缀 `.png`。

| 时间后缀 | 原图尺寸 px | 内容与用途 |
|---|---|---|
| 22-32-06 | 1950×1334 | Dark 主界面、展开侧栏、空输入框 |
| 22-32-46 | 1950×1334 | 正常长对话、代码、内联工具摘要 |
| 22-33-06 | 1950×1334 | 折叠侧栏、完整阅读轴 |
| 22-33-23 | 1949×1334 | 账户菜单（无等价产品身份，不复制） |
| 22-33-32 | 1949×1334 | 设置面板；只对照密度和浮层 |
| 22-39-39 | 1949×1334 | Terminal 右栏；pi-GUI 无 PTY，Processes 无直接功能对照 |
| 22-40-02 | 1949×1334 | PDF 右栏；pi-GUI 无独立 PDF surface，不添加 |
| 22-40-48 | 1949×1334 | HTML 右栏；对照 Browser 空间组织 |
| 22-41-08 | 1950×1334 | 主界面、输入区上下层级 |
| 22-41-26 | 1351×258 | **仅 Composer 裁图**；不能把整图宽当成窗口宽 |
| 22-41-42 | 1950×1334 | Slash 菜单及锚点 |
| 22-41-55 | 1950×1334 | @ 菜单；无统一提及能力，不添加 |
| 22-42-35 | 1950×1334 | Light 主界面 |
| 22-43-12 | 1950×1334 | Thinking/Effort 浮层；不复刻不存在的滑块协议 |
| 22-44-03 | 1950×1334 | 短对话、用户气泡、输入框 |
| 22-44-26 | 1950×1334 | 展开工具组、行间分隔、流式状态 |
| 22-44-58 | 1950×1334 | 源码右栏；Changes 仅对照空间、无编辑器功能 |
| 22-46-48 | 1950×1334 | 审批卡；本产品不引入 Always allow |
| 22-49-27 | 2559×1528 | Windows 桌面和缩小窗口；不等同应用 viewport |
| 22-54-48 | 1949×1334 | 长对话与底部工具条 |

20 图均通过真实文件读取并逐张单独查看，另建立 [缩略索引](ui5-visual-evidence/reference-contact.png)。主比较使用22-32-06、22-32-46、22-33-06、22-41-26、22-42-35、22-43-12、22-44-26、22-46-48；Slash补充使用22-41-42。缩略索引只用于寻找场景，不作为字体/线宽测量依据。没有参考图不可访问。

截图包含 Windows 窗口控制，不能用截图物理尺寸直接当 CSS 尺寸。布局素材指出 1300×889 CSS px、150% DPI；主要比较整体结构与约数，完整窗口装饰另列验收限制。没有任意“相似度百分比”。

## 当前产品截图的真实性

执行器 [tests/ui5-visual-electron.cjs](../../tests/ui5-visual-electron.cjs) 使用 **原始 `electron/main.cjs`**，并非另造 BrowserWindow 或静态 Mock 页面。Main 经既有后端复用流程连接本任务的 loopback fixture；仅 fixture proxy 提供 `/api/health` 身份字段，其余转发既有 visual-harness。生产 index/ESM/CSS/preload、窗口主题桥、原生 Browser controller 和 occlusion 逻辑全部原样执行。fixture 后端不作为认证、真实 Pi 或真实模型证据。

全部写盘 fixture 位于 `os.tmpdir()/ui5-final-*`，使用临时 userData、PI_GUI_DATA、日志和上传目录。会话内容经生产消息/工具模块渲染。没有加载或写入真实会话。capturePage 是网页像素，**不含 Windows 装饰，也不保证包含子 WebContentsView 的最终桌面合成像素**。

首批完整矩阵 60/60，补附件矩阵 61/61，Renderer errors 均为0；原始结构化记录保存在 [attempt-history](ui5-visual-evidence/attempt-history/)。前者缺附件，不冒称覆盖。执行器最初试跑存在脚本入口名错误，已按源码修正后全矩阵重跑；它不是产品错误。临时目录清理曾报 EPERM，后续须按本任务路径与进程归属核对，不结束用户进程。

**冻结后的修改前矩阵**：[before-approved/results.json](ui5-visual-evidence/before-approved/results.json)，86项中80通过、6项预期布局差异失败，Renderer errors=0；73张capturePage图及4张独立Win32截图。六项失败分别为欢迎区位置、Composer体量、左栏比例、工具组底色、右栏开启时的标题可读宽度和Slash菜单宽度，未通过的目标不会计为“基线全绿”。原始日志 [before-approved.log](ui5-visual-evidence/before-approved.log)。四张Win32图均通过所有权/遮挡检查，`GetDpiForWindow=144`（150%）；涵盖Browser、Browser+Modal、Dark主窗口和Light主窗口。没有把网页截图冒充Windows截图。

| 场景 | 当前真实截图（相对 ui5-visual-evidence/before-approved/） |
|---|---|
| 主界面/折叠/历史 | `dark-1200-empty.png`、`dark-1200-collapsed.png`、`dark-1200-history.png` |
| 代码与工具调用 | `dark-1200-tools.png`（含真实显示的 fixture exit code 1） |
| Composer 空/输入/附件 | `dark-1200-empty.png`、`dark-1200-input.png`、`dark-1200-attachment.png` |
| 模型/Thinking/Slash | `dark-1200-model.png`、`dark-1200-thinking.png`、`dark-1200-slash.png` |
| Changes/Browser | `dark-1200-changes.png`、`dark-1200-browser.png` |
| Processes/Session Changes | `dark-1200-processes.png`、`dark-1200-session-changes.png`（首批为读取失败状态） |
| Modal/审批 | `dark-1200-browser-modal.png`、`dark-1200-approval.png` |
| 设置/诊断/日志 | `dark-1200-settings.png`、`dark-1200-diagnostics.png`、`dark-1200-logs.png` |
| 两主题与响应式 | `{dark,light}-{700,900,1200,1536}-{expanded,collapsed,multiline,pane,expanded-pane}.png` |
| 应用缩放 | `{dark,light}-zoom-{0.8,1.25,1.5}-{composer,model}.png` |

## 差异表（修改前）

源码位置为当前 c0769cd 的行号；建议是设计判断，不是 Anthropic 官方规格。

| 优先级/区域 | 参考表现 | 当前表现与源码 | 差异程度 | 建议/是否修改 | 功能与布局影响 |
|---|---|---|---|---|---|
| P1 左栏总比例 | 约287 CSS px，导航与会话共一列 | global52 + project260 =312；`styles.css:2310` 附近 | 中；宽屏左栏多占25px | project236，总288；值得 | 保留 global rail 能力；900/720断点不变，聊天增加24px |
| P1 空会话空间组织（补充取证） | 欢迎标题位于阅读轴左侧上方，品牌图形与标题并排 | Pi图形/标题/描述垂直居中，距顶较大；`styles.css:358–362,2564`后被`ui4-feedback.css:348–379`覆盖，`before-approved/dark-1200-empty.png` | 高 | 在实际归属的UI-4样式中，把现有欢迎DOM改为图形+标题两列、沿阅读轴顶部放置；值得 | 不复制Overview统计、不添加功能；保留无项目/恢复中/就绪三种真实引导和选项目按钮 |
| P1 侧栏密度 | 会话行约25–28px，组标题更轻 | row34；`styles.css:2558`、`.pj-sess` | 中 | 统一最小30px，组标题保留；值得 | 不改排序、归属、展开状态或滚动逻辑；目标仍≥24px |
| P1 Composer 结构/比例 | 约40px输入轮廓，发送位于输入区右端，模型/Thinking位于下方独立行 | 一个99.33px整块轮廓，input40 + bar34 + padding；`ui3-composer.css:3`、`styles.css:597` | **高，主要观感差异** | 用现有DOM把轮廓放到textarea，发送视觉锚定输入右下、工具条留在外侧；值得 | 仅CSS；保留独立Stop/steer能力、不重叠按钮；不改发送/IME/附件/能力检查，原ResizeObserver继续测整个composer |
| P1 工具卡片 | 透明基底、细线分组，单行更平 | 整组实色底，内行各自圆角叠分隔；`styles.css:493–504` | 中到高 | 保留组hairline和完整结果，取消整组底色与行圆角；值得 | 不隐藏成功/失败/耗时/输出；不改ToolEntry或折叠规则 |
| P1 输入焦点/状态 | 输入轮廓清楚，按钮位置稳定 | 焦点在整块含工具条边框，空态留白偏多 | 中 | 输入自身焦点环，整组高度减少；值得 | 需真Electron检查多行、附件、bar换行及底部预留 |
| P2 Hover/按钮反馈 | 快速低装饰过渡 | 多个旧 .12/.13/.14s 常量；`styles.css:624–665` | 小 | 修改涉及控件时沿用已有motion token；值得 | 不给宽度/面板bounds增加动画；reduced-motion必须覆盖 |
| P2 占位文字 | 描述任务并提示命令入口 | “随心输入”；`index.html:167`会被`shell.js:91–99`按ready状态重新设置 | 小 | **保留**：静态HTML改动不会生效，撤回该无效改动，不为此扩大到状态控制器 | 无新能力/按钮；aria-label和所有状态提示保持 |
| P1 标题空间（补充取证） | 右栏开启后仍能辨认会话标题 | 1200px展开左栏+420px右栏时，关联任务条挤掉h1；`styles.css:339,1921`，`before-target/dark-1200-changes.png` | 中 | 对真实顶栏可用宽度增加container查询，沿用既有窄屏隐藏补充任务条的规则；值得 | 不改关联数据/任务入口；Planner保留，标题与面板按钮优先 |
| 保留 阅读轴 | 正文与输入框约767px共同轴 | 768px，已同轴；`styles.css:35–36,378` | 小 | 不改 | 避免反复改变阅读/历史导航 |
| 保留 标题栏 | 约40–43px，原生caption | 46px，原生caption预留；`.stage-head/.rp-titlebar` | 小 | 不改 | 受原生overlay/拖动/右栏约束；避免遮住caption |
| 保留 文本/段落/代码 | Sans正文，代码低装饰卡片 | 系统字体14px/1.75、代码12px/1.6、标题14px；`styles.css:401–429` | 中/字体不同 | 不重排/不换私有字体；记录差异 | 现有中文fallback观感需记录，不能假称用了Anthropic字体 |
| 保留 模型/Thinking | 紧凑菜单、Effort滑块 | 列表选择、真实能力unknown/disabled/回读说明；`ui3-model.css` | 中 | 只随Composer位置自然对齐，不换滑块 | 不发明支持等级或推断unknown=false |
| P1 Slash菜单（完整原图补充） | 22-41-42为窄命令列表，约236CSS px | `before-approved/dark-1200-slash.png`为约743CSS px，随textarea铺满；`ui/inline-command-menu.js:279`、`ui3-inline-commands.css:20` | 高 | 只用CSS把实际宽度限制在320px并把行内距8缩到6px；值得 | 不改定位JS；CSS实际宽不超过JS计算的安全宽，既有边界夹取更保守；保留完整ARIA命令名称和既有省略展示 |
| 保留 其他Popover/菜单 | 上锚定、轻阴影、列表 | 已使用8px边距与viewport夹取；`ui/popover.js` | 小 | 不重写 | 保留注册表/IME/Enter优先级和焦点恢复 |
| 保留 右栏比例 | 默认约327px，内容较简单 | 默认420/min320，宽度可保存；`right-pane.js`、`ui4-pane.css` | 中 | 不覆盖持久宽度、不统一强制327 | Git操作与Processes安全说明需要空间；保留dock/overlay |
| 无直接对照 Changes/Session Changes | 源码/工件右栏，不是安全撤销 | Git工作区与本会话证据分开 | 不可等同 | 只验一致性，不添加编辑器 | P33资格/写回继续关闭 |
| 无直接对照 Processes | 参考是PTY终端 | 本产品管理进程、脱敏日志、独立权限 | 不可等同 | 保留真实含义，不造终端 | 默认权限与运行状态不变 |
| 保留 Browser | 参考HTML预览 | 真WebContentsView，Modal时撤离 | 小/宿主不同 | 不改安全/挂载逻辑 | screenshot网页像素不等于Windows最终合成 |
| 保留 Approval | 参考内联大卡，有Always allow | 独立Modal、来源/风险未知/取消说明/允许一次 | 中但**有意** | 保留全部真实风险和安全交互 | 不把Esc或关闭改成批准，不新增持久授权 |
| 无直接对照 Diagnostics/Logs | 设置截图，无日志模块 | 固定日志/导出清单、安全摘要 | 不可等同 | 只验双主题、滚动、焦点 | c0769cd脱敏/恢复机制不得变 |
| 保留 色彩/图标/动效 | 暖中性色，品牌火花、原生caption | UI-1 Tokens、Pi自身SVG、120/200ms token | 小 | 不换品牌，不引复杂动效 | 不动画布局宽度；尊重reduced-motion |

当前没有确认的产品 P0。700px 下右栏 overlay 覆盖聊天是既有设计，必须保留关闭与恢复路径，不能把它误报为页面横向溢出。

## 执行清单（Writing Plans，单Agent）

- [x] 基线核对、真实参考阅读、生产入口矩阵与本审计；此刻产品源码尚未改动。
- [x] 仅修改 `public/styles.css`：宽屏project宽度、侧栏最小行高、工具组背景/行圆角、涉及控件的motion token。
- [x] 同文件让任务关联条按顶栏可用宽度响应，不再仅按窗口宽度判断；验证右栏开启时h1与关键按钮可见。
- [x] 在 `public/ui4-feedback.css` 调整现有欢迎区的轴线与纵向位置，不添加参考中的统计模块。
- [x] 仅修改 `public/ui3-composer.css`：textarea轮廓、外置底栏视觉与发送按钮位置；不移动DOM或改handler。
- [x] 修改 `public/ui3-inline-commands.css` 的宽度上限和行内距；定位/命令/IME模块完全不改，重跑UI-3与CDP边界矩阵。
- [x] 同一执行器重拍 before → after，增加1300×889 CSS px对照；核对多行、附件、发送/停止、模型/Thinking/Slash、两主题四宽及zoom。
- [x] 运行 UI-1至UI-4关键回归、日志安全与断线恢复、真实Electron与CDP。所有旧断言保留。
- [x] 完整npm test基线与最终运行分开保存实际退出状态，环境跳过不计通过。
- [x] 使用现有离线缓存、`--output-root`临时目录重建App/SEA；包内public哈希及App/EXE检查；不覆盖安装版。
- [x] 编写 `UI-5-visual-acceptance.md`，记录每项差异的实际关闭/保留、证据与未验证范围，按回滚边界本地提交后停止。

不引入新依赖、全局样式覆盖文件、状态机、网络目的地址或其他产品功能。若后续发现需要业务模块修复，先重新记录根因和范围，再增加回归；本审计不预先授权扩大范围。

## 截图循环中的补充发现

初轮主体修改通过后，仍继续人工核对，未以单次测试通过结束：

| 优先级 | 实际证据 | 根因/处理 | 风险与验证 |
|---|---|---|---|
| P1 长对话底部透字 | `ui5-visual-evidence/final-electron/light-900-multiline.png` 中底栏下方仍出现对话文字 | Composer 外围18px留白透明；在既有 `#chatComposer` 使用canvas token遮罩，DOM与测量逻辑不变 | 检查长文本/双主题，最终 `final-polished/light-900-multiline.png` 底部干净；不遮蔽消息，消息仍可在滚动区读到 |
| P1 百模型弹层边界 | `after-cdp.log`：1775条中2条布局判据失败；700px图中弹层右边贴视口，未留8px安全边距 | fixed弹层的shrink-to-fit宽度会受定位后剩余空间影响（源码与截图支持的解释）；给 `.pop.model-mode` 420px首选宽，继续受原maxWidth/面板边界限制；定位JS不改 | 保留全部旧判据；新增生产Main入口700/900百模型有界、内部滚动、Composer不位移检查；90/90，通过完整1775条CDP |

这两项只补CSS；不更改权限、RPC、模型能力或Pi回读。发现后中止了本轮自己启动、已核对命令行/父进程/创建时间的中间npm进程树，保留 `interim-*` 日志和终止身份记录；随后对最终110个public文件冻结哈希并重新执行完整npm test。不得把中止运行记为通过。
