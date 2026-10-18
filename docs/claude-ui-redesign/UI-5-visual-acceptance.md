# UI-5 Final Visual Polish 验收

日期：2026-10-18，单Agent。仓库 `C:/pi-GUI-ui5`，分支 `codex/ui5-diagnostics-polish`。

## 交付状态与版本

起点为已验收 `c0769cd78d3e25d39aed5c97bde09af397a28cf8`，开始时工作区干净，无用户未提交改动。最终产品只改四个CSS文件；未改任何产品JS/Server/lib/Electron、安全协议、日志存储与脱敏代码。版本保持0.25.0，依赖和canonical `npm test` 的137个顶层命令保持原样。

最终视觉CSS提交：`4ebb85d`；测试基建提交：`8651028`。审计、证据和本报告位于其后的文档提交；交接时以最终交付消息中的 `git rev-parse HEAD` 为准。完整测试以 `final-test-source.json` 的110个public文件SHA256绑定实际运行源码，测试启动时HEAD仍为c0769cd，CSS为本轮未提交修改；不能据此把它误称为只测过基线。

原仓库、main、其他worktree和用户安装版均未作为修改/构建输出目标。未push、merge、升版本、打tag或创建Release。不查远端当前状态（遵守项目不联网约束）。未找到REVIEW.md；UI-0规范只读参考原仓库，详情见[审计](UI-5-visual-audit.md)。

## 参考与真实截图边界

使用用户目录 `C:/Users/21022/OneDrive/图片/claude/` 的全部20张PNG；逐张打开阅读并记录原尺寸、裁切内容，完整清单见审计。关键图为22-32-06主界面、22-32-46对话、22-33-06收栏、22-33-32设置、22-40-48右栏、22-41-26输入区裁图、22-41-42 Slash、22-42-35 Light、22-43-12 Thinking、22-44-26工具、22-46-48审批。未访问失败；参考是Desktop截图，未用CLI/网页代替。

`素材.zip` 的布局说明用于解释DPI，不把描述当截图证据。参考多数1950×1334或1949×1334；Composer单独裁图1351×258，不能把1351当窗口宽。未把Claude商标、图标、字体、宠物或其素材作为Pi品牌资源。

证据根目录：[ui5-visual-evidence](ui5-visual-evidence/)。

- `before-approved/`：产品修改前，真实生产 `electron/main.cjs` + 现有预加载与ESM/CSS，离线fixture；80/86，六项明确布局目标失败，renderer errors=0。
- `current-final/`：同一生产入口最终90/90，74张capturePage和4张Win32客户区截图；新增四条检查为两档百模型截图溢出与位置检查，旧断言未减少。
- `final-polished-ui3/`、`final-polished-ui4/`、`final-runtime/`：既有真实Electron交互回归；其入口/fixture边界与新生产Main截图执行器不同。
- `final-cdp/`的过程JSON、`final-cdp.log` 和 `shots/` 下276张PNG：完整CDP矩阵，1775条断言失败0。
- `native-*.png`通过HWND/PID、可见/遮挡检查后用Win32抓取自己的窗口客户区；真实显示系统caption按钮和WebContentsView。其余PNG均为capturePage，**不声称含Windows窗口装饰或子View合成画面**。

新执行器不创建替代产品的Mock页面或自定义BrowserWindow，而是加载生产Main并复用隔离的身份代理/harness。会话、附件、错误、工具结果和审批内容来自受控fixture，无真Pi/模型/真实项目。Browser中的Local preview是本机HTTP fixture，经真实WebContentsView挂载。生产Main的sandbox/contextIsolation实测保持true。

## 修改与逐区域判断

| 区域/问题 | 参考 → 修改前 → 最终 | 判断、影响和保留 |
|---|---|---|
| 主布局/侧栏 P1 | 参考约287CSS px；原52+260=312；最终52+236=288 | 总比例明显接近；global rail与四栏能力保留，未删除入口 |
| 会话密度 P1 | 原最小34px；最终实际30px，菜单触发26px | 更紧凑，项目/会话层级清楚；不改排序、归属、滚动定位，长标题省略与独立菜单保留 |
| 空会话 P1 | 参考沿阅读轴顶部、图形与标题并排；原垂直居中；最终顶部两列 | 结构和留白更相似；保留Pi三种真实欢迎状态及选项目引导，不添加Overview统计 |
| 阅读轴 | 参考约767px，Pi已有768px | 正文/Composer同轴保留，未为像素差改变历史导航 |
| 标题可读性 P1 | 原1200px左右栏并开时关联任务挤掉h1 | 依顶栏实际宽度隐藏已有补充关联条，标题可辨、操作按钮可用；任务/Planner功能与关联数据保留 |
| Composer P1 | 参考40px轮廓+下方独立工具栏；原99.33px整体卡片；最终40px输入、约75px总占位 | 最主要的结构差异已收敛；Send在输入右下，模型/Thinking在下方；多行与附件自然增加占位 |
| 底部透字 P1 | 长对话能从透明底边穿出 | canvas遮罩覆盖完整输入底座；最终长对话截图清楚，完整消息仍可滚动读取 |
| 消息/Markdown | 正文14px/1.75、代码12px/1.6，长代码内部滚动 | 结构和信息层级一致；保留Pi字体/标题尺度/用户气泡，不使用私有字体 |
| 工具卡 P1 | 原整组实色底及内行圆角叠加；最终透明基底、细分隔 | 降低视觉噪声；成功/失败、耗时、参数/输出、展开入口均保留，图中exit code 1未隐藏 |
| Slash P1 | 参考窄命令列表；原随输入铺满约743px；最终≤320px | 菜单比例接近，命令/IME/定位处理器不变 |
| 模型/Thinking P1 | Thinking参考滑块；Pi真实候选列表；百模型曾在700/900触边 | 保留真实能力/unknown/disabled与列表语义；模型首选宽420并受现有maxWidth约束，有界内滚、Composer不位移 |
| 右侧工作区 | 原生Browser、Changes/Session Changes、Processes | 现有标题带、行密度、截断、滚动、空态一致；未复制Terminal/PDF功能；Processes与Session Changes无直接参考 |
| Approval/Modal | 参考内联批准/持久权限；Pi modal与真实风险 | **有意保留**Pi审批结构、风险原文、busy/failed/unknown和关闭语义，未添加Always allow |
| Settings/Diagnostics/Logs | 参考设置，无日志模块直接对照 | 使用既有统一面板/反馈；只验主题、滚动、焦点、错误与断线恢复；日志安全机制不改 |
| 颜色/图标/状态 P2 | 既有UI-1 token与Pi SVG；部分按钮旧过渡常量 | 保持warm neutral体系；涉及控件改用snap/ease token，selected/hover/disabled/focus区分保留 |

没有确认的产品P0；修复P1为侧栏比例/密度、空会话、标题空间、Composer结构/遮罩、工具组、Slash及模型边界。P2仅涉及控件过渡与低噪声内行圆角。未以任意“相似度百分比”验收。

实际产品文件与原因：`public/styles.css`负责导航、工具组、标题container规则、模型宽和motion；`public/ui3-composer.css`负责输入轮廓/底栏/Send/遮罩；`public/ui3-inline-commands.css`负责Slash宽与内距；`public/ui4-feedback.css`负责最终层叠中真正拥有欢迎区的样式。无新增全局覆盖样式文件。

测试基础设施新增 `tests/ui5-visual-electron.cjs`、`tests/ui5-native-window.ps1`、opt-in `test:ui5:visual`；仅为UI3/CDP既有执行器增加输出目录env，测试逻辑和断言不减。Canonical测试链未新增桌面手动矩阵，与既有桌面测试分层一致。

## 修改前后与保留差异

| 场景 | 修改前 | 最终 |
|---|---|---|
| 空会话 | [before](ui5-visual-evidence/before-approved/dark-1200-empty.png) | [after](ui5-visual-evidence/current-final/dark-1200-empty.png) |
| 工具与代码 | [before](ui5-visual-evidence/before-approved/dark-1200-tools.png) | [after](ui5-visual-evidence/current-final/dark-1200-tools.png) |
| 输入/附件 | [before](ui5-visual-evidence/before-approved/dark-1200-attachment.png) | [after](ui5-visual-evidence/current-final/dark-1200-attachment.png) |
| Slash | [before](ui5-visual-evidence/before-approved/dark-1200-slash.png) | [after](ui5-visual-evidence/current-final/dark-1200-slash.png) |
| Changes+标题 | [before](ui5-visual-evidence/before-approved/dark-1200-changes.png) | [after](ui5-visual-evidence/current-final/dark-1200-changes.png) |
| 长对话底边 | [中间缺陷](ui5-visual-evidence/final-electron/light-900-multiline.png) | [最终](ui5-visual-evidence/current-final/light-900-multiline.png) |
| 原生Browser | [before](ui5-visual-evidence/before-approved/native-dark-browser.png) | [after](ui5-visual-evidence/current-final/native-dark-browser.png) |

前后同场景使用相同窗口/裁切执行器。参考图另按其原尺寸和150%DPI解释；没有把不同DPI或crop直接当像素误差。最终1300×889 CSS请求下系统会有舍入（实际geometry记录为准），Win32客户区1949×1334，接近参考原图尺寸。截图对照是人工设计判断，不是功能等价声明。

明确保留：global rail折叠后仍占52px；标题带46px而参考约40–43px；右栏沿用可调整/持久化与420px初始宽（参考不同页面宽度不一）；系统字体和Pi图标；独立Stop与steer发送；输入提示“随心输入”（由shell按状态管理，不做无效静态HTML改字）；风险/错误/unknown的说明文字；不复制参考缺少Pi等价能力的账户、@、Terminal、PDF、Overview与权限按钮。它们是功能或品牌边界，不是未完成的CSS目标。

## 响应式、交互与可访问性

矩阵 `current-final/results.json`：Dark/Light ×700/900/1200/1536 CSS px；左栏展开/折叠、右栏开/关、多行；两主题×80%/125%/150%应用zoom的Composer与模型；空输入、附件、菜单、Modal、Approval、Settings/Diagnostics/Logs均有截图。700px右栏按既有overlay策略覆盖聊天，关闭入口可用；不把overlay误报为全页横向溢出。没有给sidebar/原生View bounds增加动画。

生产Main执行器检查Esc关闭与焦点恢复、草稿/附件移除、横向溢出、标题可读性、原生Browser挂载/Modal撤离与真实reduced-motion。UI-3交互覆盖中文composition保护、发送屏障、steer/stop、附件pending/failure、模型能力/回读、命令键盘；UI-4覆盖pane几何、Esc/点击关闭、焦点、审批重复操作、失败重试、toast owner和观察器稳定。不能把合成composition事件称为Windows真实IME实测。

人工核对最终宽/窄两主题、代码/工具错误、输入多行/附件、Slash、百模型、原生Browser/Modal；无明显新增布局跳动或内容截断故障。焦点环保留，最小会话行30px，菜单触发26px；未以降对比或隐藏风险简化画面。

## 测试、失败记录与安全

以下只填实际完成的退出结果；跳过另列，不计通过。

| 验证 | 结果 | 证据 |
|---|---|---|
| pristine完整npm test | exit0，137顶层命令，8852行；baseline未保存精确时长 | `baseline-npm-test.log/.exit`、`baseline-summary.json` |
| 最终完整npm test | exit0，137顶层命令，2978.732秒（49分39秒） | `final-npm-test.log/.exit`、`final-npm-process.json` |
| 日志安全/脱敏/断线恢复 | 32+7+9+8+7=63通过，symlink跳过1 | 最终npm前缀，`after-logging.log` |
| UI-1/2与UI3/4专项 | Theme47/47；UI2 Classic48/48、visual57/57；UI3 34/34、50/50、46/46、23/23；UI4 44/44、27/27、55/55 | 最终npm及专项日志 |
| 生产Main视觉 | 90/90，errors0 | `current-final/results.json`、`current-final.log/.exit` |
| UI3 Electron | 243/243，skip0 | `final-polished-ui3.log/.exit`，107图 |
| UI4 pane Electron | 427/427 | `final-polished-ui4.log/.exit`，75图 |
| Theme Electron | 489/489 | `after-theme.log/.exit`，65图；后续两处CSS以最终Main/CDP覆盖 |
| Approval Electron / feedback | 44/44、9/9 | `final-approval.log`、`final-feedback.log`；同上最后两处CSS由最终矩阵覆盖 |
| Runtime Electron | 181/181，47图 | `final-runtime.log/.exit` |
| Logs Electron | 23/23 | `after-logs-electron.log/.exit` 和最终包public `final-packaged-logs.log/.exit`，均10图 |
| 最终CDP | 1775条，失败0 | `final-cdp.log/.exit`、`final-cdp/shots` |
| 离线最终构建 | exit0 | `final-build-app.log/.exit` |
| 最终App/EXE/日志包内 | 26/26、49/49、15/15 | `final-app-check.log`、`final-exe-check.log`、`final-logging-packaged.log`及exit |

中间失败如实保留：首次welcome覆盖写错归属导致85/86，后移到ui4-feedback实际归属处修复；`after-cdp`为1773/1775，模型边界修复后完整复跑；首次App19/21和EXE43/44缺TEMP下PDF fixture，未创建上传缓存且附件分支未执行，补同一TEMP fixture后26/26和49/49；错误调用不存在的测试文件保留日志，正确UI4入口已复跑。`--ux-only`独立运行依赖先前场景状态而启动失败，未改断言绕过，以完整矩阵复跑。

中止的 `interim-final-npm-*` 仅为旧样式未完成运行，不计通过；只结束了本轮自己启动并核对身份的npm树，未按端口/进程名清理用户进程。临时Electron profile清理出现EPERM，记录保留，不改ACL/不强清未知进程。可选证据清理曾被自动审批拒绝，未换方式绕过，旧目录原样保留。

日志补丁c0769cd行为保持：安全状态投影、secret状态清理、allowlist/脱敏、日志渲染和断线恢复均沿用原实现。最终产品diff只含四个CSS文件；Server、lib、Electron、日志与P33文件均无diff；`final-package-assets.json` 的冻结测试源hash mismatch为0。未使用真实用户会话/项目作写盘验证。

## 构建与包内检查

输出仅在 `final-build-root.txt` 指定的全新OS TEMP目录。使用本机Electron44.4.3缓存，日志明确离线；未请求registry或下载运行时，未覆盖源码根dist或安装目录。

`final-package-assets.json`：source110、package110，onlySource/onlyPackage/mismatch均0；冻结测试源hash mismatch0。main/preload与源逐字节一致。SEA为99,749,888字节，SHA256 `d2a7d2731fe9ab946a52a47db6d748bbebcf1adfcb08944a9458656082b3eee0`；Electron EXE为246,324,736字节，SHA256 `4277314cc0d4bbd758581055181d770ba8ff024537514e0e70d1e36ad8ec518a`。完整目录体积约328.5MB，EXE与整包体积不是同一概念。

包内public生产入口视觉复验：90/90，errors=0（`packaged-current-final.log/.exit`）。该模式是源生产Main+打包后的public，不能冒称已运行用户安装版。App/SEA本身运行证据由各check提供。

## 未验证与合并建议

已验证当前Windows OS150%（GetDpiForWindow=144）客户区原生caption外观和真实WebContentsView合成；未验证多显示器跨DPI、OS125%、实际caption按钮点击/拖动/最大化、窗口阴影/完整桌面、真实Windows中文IME、安装升级、真实Pi/模型/长时间soak和POSIX。应用zoom与OS缩放是两回事。

SACL/Native相关环境跳过不能证明生产撤销写入安全，P33 allowlist/fail-closed行为未修改。最终完整测试实际记录：logging-leaks的符号链接用例跳过1（EPERM）；session-revert-inplace跳过2（非空SACL需要SeSecurityPrivilege）；session-revert-sacl-witness与Object witness各跳过8（现有token无SACL权限）。这些均不计入分子/分母，也不转化为生产证据。离线契约中的真实模型复测仍标为 `REAL_MODEL_RETEST_PENDING`。

合并建议：从当前Windows源码、真实Electron、CDP和离线包检查看，没有已知的P0/P1阻塞，可进入用户最终验收；上述真实IME、多DPI OS缩放、真实Pi/模型和SACL生产资格仍未验证。建议用户完成最终产品验收后再决定是否合入main。本轮未push/merge，只交付本地提交与证据。

## 提交边界

本地提交按可回滚边界拆分：视觉CSS `4ebb85d`、视觉测试基建 `8651028`、审计与证据为本次最终提交。文档提交会改变 `HEAD`，因此这里不伪造自引用hash；实际最终 `HEAD` 在交付消息中给出。
