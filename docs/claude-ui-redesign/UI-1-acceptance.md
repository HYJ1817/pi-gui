# UI-1 实施与验收报告

日期：2026-10-16（Asia/Shanghai）。工作目录 `C:/pi-GUI`。分支 `codex/ui-1-theme-shell`，HEAD 仍为 `3e8d7296fc89c21d38e04879ef020c47680d7ce0`，版本仍为 0.25.0。

**结论：UI-1 代码实现、自动化回归和隔离离线构建完成；严格视觉验收保留原生窗口控制区域实拍缺口。** 三种主题、持久化、网页/原生调色板同步和四栏基础外观已实现。可在这一基线上开展 UI-2 开发，但不能宣称原生按钮接缝、真实 OS 主题变化和完整 OS DPI 矩阵已全部验收。本轮停止于 UI-1，没有进入 UI-2，也没有提交、推送、合并、升级版本、打 tag 或发版。

## 1. 基线、参考和范围

已读取 AGENTS、UI-0 五份文档、当前实际源码，以及素材包/Claude 截图的 UI-0 检查与分类结果。素材仍按原始选择器、上下文和定义顺序解释，不使用错误的 theme 标签或数组首项作为主题权威。没有复制 Anthropic 专有字体、图标字体或组件代码。遵守不联网约束，没有下载 open-claude-ui 或查询远端。

开始时 568 个 tracked 文件与 UI-0 快照一致；原有未跟踪素材、UI-0 文档和历史目录保留。另见到本机临时清理脚本，不执行、不覆盖。先以 UI-0 同 HEAD 的完整测试为前测，再实跑 smoke 1338/1338、guard 123/123；改后完整重跑见下文。没有以旧文档的“40 套件”作为当前数量。

当前 [scope-audit.json](ui-1-evidence/scope-audit.json) 列出 11 个 tracked 改动、4 个新增产品文件和2个新增测试文件。109 个受保护的 lib/server/extensions、server.js、package-lock.json 文件与 UI-0 hash 一致，缺失0。Pi RPC、SSE、模型/供应商策略、审批、owner/sequence/workspace、撤销算法及 P33 生产闸门均未修改。测试只写临时 fixture，不操作真实会话或真实项目数据。

最终 [final-verification.json](ui-1-evidence/final-verification.json) 再次确认：原127条测试链保留、版本/依赖不变、产品源码与最终包hash差异0、报告断链0、`git diff --check`退出0，三个实际进程结果均为0。

## 2. 实际文件与变化

以下路径均相对仓库根目录。

| 文件 | 实际修改 |
|---|---|
| 新 `public/tokens.css` | 71 个 `--ui-*` 语义变量：表面、文字、边界、强调/状态/Diff、阴影、系统字体、字号、间距、圆角和基础动效；保留 legacy alias |
| `public/styles.css` | 按组件语义迁移颜色；顶栏/导航/会话选中态/浮层/Classic/Runtime/Planner 等共用主题；修复 `.rp-titlebar` 透明背景；新增外观 select 样式、reduced-motion 覆盖 |
| `public/process.css` | 开发进程视图遗留实色改为主题语义，不改变进程能力或按钮生命周期 |
| 新 `public/theme-init.js` | 样式表之前的阻塞初始化，先解析主题属性，默认 dark |
| 新 `public/theme.js` | 偏好设置、订阅、System 跟随、持久化失败提示和 revision 防止旧响应覆盖 |
| `public/index.html` | 初始化脚本/Token 样式加载顺序；设置菜单增加“外观与主题”入口，原导航 ID 与结构保留 |
| `public/settings.js`、`public/app.js` | 复用现有 modal 和焦点交还；原生 select 提供 Claude Dark / Claude Light / System；关闭取消订阅 |
| `public/usage.js` | 仅把两处中性色赋值改为 Token；65/85 阈值、token 关联和业务计算未改 |
| 新 `electron/theme.cjs` | 主进程持有展示偏好、固定文件原子保存、nativeTheme、窗口底色及 overlay 同步、受限 IPC |
| `electron/main.cjs`、`electron/preload.cjs` | 建窗前恢复主题；固定启动标记启用展示桥；预加载缓存/回放快照，保留原桥 |
| 新 `tests/theme.cjs` | 47 项：枚举/来源/主 frame、恢复/损坏文件/写入失败、真实主题模块、事件顺序、旧 preload 兼容 |
| 新 `tests/theme-electron.cjs` | 真实 Electron 主题、布局、键盘/窗口状态、截图；额外原生截图尝试仅针对自己的测试窗口 |
| `tests/dev-server.cjs` | 原滚动条色值断言适配主题 Token，继续检查全局范围及横纵尺寸；检查两主题/native 调色板，加3条新静态资产检查 |
| `tests/runtime-electron.cjs` | 仅增加可选 fixture 主题和独立证据目录；原170项断言保留，启用主题后新增1项恢复检查 |
| `package.json` | 原127条 test 命令链原样保留，前置 theme 套件后为128条；增加 `test:theme`；不变更依赖或版本 |

没有全局正则替换旧变量。CSS 中的颜色按中性表面/文字、控制、错误/警告/成功、Diff 分别迁移；原几何和响应式逻辑保持。Token 定义不等于强制把所有旧字号、圆角和布局数值在本阶段改写，后续组件可以逐项采用。`--composer-reserved-height` 由既有 JS 动态提供，不是新增缺失 Token。

## 3. 检查点 A–C：主题、标题栏与布局

| 检查点 | 完成情况 |
|---|---|
| A：深色/Token/native 同步 | 默认保持深色；顶部统一 dark `#111111`，symbol `#c3c2b7`；右栏顶带改为明确 `--titlebar`，消除 UI-0 的网页色块差异 |
| B：Light/System/恢复 | light 顶部 `#fbfbf9`、symbol `#52514e`；桌面偏好保存在 Electron userData 下固定 `theme-preferences.json`；网页使用固定 localStorage key；重载/重建窗口恢复 |
| B：System | 主进程监听 nativeTheme `updated`；网页回退监听 matchMedia；显式 dark/light 不被 System 事件改写 |
| C：基础外观 | 全局栏、项目侧栏、会话选中、顶栏和右栏表面使用统一主题；hover/focus/selected/disabled 保持可辨 |
| C：能力与几何 | `.global-rail` 保留，52/46 px 基线不变；项目侧栏260/224/190、正文920和右栏420/min320基线保留；整栏折叠及焦点交接复用原实现 |
| C：导航 | Planner、Skills/MCP、设置、Browser、Changes、搜索、项目/会话菜单、独立命令面板保留；未加入无真实能力的入口 |

浅色已目视检查 Classic 消息/Changes/弹窗及 Runtime/开发进程表面，无大面积深色残留；错误、警告、成功和 Diff 保留独立色义。[token-contrast.json](ui-1-evidence/token-contrast.json) 的64组实色文字/表面对比均达到4.5:1，失败0；它不代替透明合成、disabled 和 Browser 外部网页的实际视觉验证。字体仍为系统字体栈。

### Electron 展示桥安全审查

仅接受 `dark | light | system`，不接受路径、任意 CSS/颜色、任意 IPC channel 或文件操作。写入目标由主进程固定；限尺寸读取，损坏偏好回退 dark 且不覆盖损坏文件；保存失败只回传固定布尔状态，界面当次仍可使用，不泄露路径/错误 payload。

主进程同时校验当前 BrowserWindow、sender、精确 mainFrame 和 origin；子 frame/其他窗口/前缀伪造被拒绝。正式窗口在注册 handler 后创建，并带固定 `--pi-gui-theme-bridge` 标记；没有标记的旧 Electron fixture 不做同步读取，也不暴露 theme，从而不阻塞旧桥或网页回退。标记只用于声明桥可用，不代替来源校验。

preload 缓存最新快照，订阅立即回放；主进程 revision 防止延迟回复覆盖新 System 事件。阻塞 head 脚本先于 CSS 读取快照；窗口原生底色在创建时确定。真实 Electron 已测最早可取得的 shell rAF、reload 和 controller/window 重建；这不是 GPU compositor 第一帧的采集证明。

## 4. 检查点 D：实际测试与基线差异

| 检查 | 实际结果 | 证据 |
|---|---|---|
| 主题专项 | **47/47，失败0，退出0** | [theme-final.log](ui-1-evidence/theme-final.log)；fixture/模块证据，不做布局结论 |
| smoke | **1338/1338，失败0**，原数量不变 | [smoke.log](ui-1-evidence/smoke.log)，canonical 再次通过 |
| daily-use / P30 IA | **31/31、12/12**，原数量不变 | canonical [test-summary.md](ui-1-evidence/test-summary.md) |
| 静态资源 | **30/30，退出0**；UI-0为27/27，新主题资产新增3项 | [server-final.log](ui-1-evidence/server-final.log) |
| Electron guard | **123/123，失败0**，原数量不变 | [guard.log](ui-1-evidence/guard.log)，canonical 再次通过 |
| 主题 Electron | **489/489，失败0，renderer/harness errors 0，退出0；63张有效网页截图** | [results.json](ui-1-evidence/electron/results.json)、[log](ui-1-evidence/theme-electron-final.log)、[退出码](ui-1-evidence/theme-electron-exit.json) |
| 既有 IA Electron | **161/161，失败0，退出0；37张截图**，与UI-0相同 | [log](ui-1-evidence/electron-ia.log)、[results](ui-1-evidence/ia-dark/results.json) |
| Runtime 浅色 Electron | **171/171，失败0，退出0；43张截图** | [log](ui-1-evidence/runtime-light.log)、[report](ui-1-evidence/runtime-light/p32-3/report.json)、[退出码](ui-1-evidence/runtime-light-exit.json)；原170项加1项主题恢复 |
| 完整 `npm test` | **实际退出0；128条命令链完成；报告失败0；明确跳过19项** | [原始日志](ui-1-evidence/npm-test.log)、[实际进程结果](ui-1-evidence/npm-test-result.json)、[逐套数字](ui-1-evidence/test-summary.md)、[JSON](ui-1-evidence/test-results.json) |

完整运行时段为13:50:14–14:37:24（+08:00），2829.775秒。保留113条数字摘要，不把嵌套 JSON/子套件重复累加为虚构总断言数。与 UI-0 的112条摘要比较，仅新增47/47主题摘要、静态资源27/27变30/30；没有既有断言数量下降。reliability/interactions/port-owner只打印 passed，未编造数量。

19项跳过与 UI-0 相同：SACL witness 8、inplace非空SACL保持2、Object witness 8（SeSecurityPrivilege不足），另 sessions 5i 符号链接1项（本机权限）。跳过不进入通过分子/分母，0/0 witness不代表通过；没有改变 P33 资格。

开发过程中首次主题测试按预期失败于尚未存在的 controller；迁移后旧静态资源测试曾26/27，原因是仍断言固定深色 scrollbar 值，随后改为检查主题引用和两主题 Token，尺寸/作用范围守卫保留。没有删除、削弱业务断言。首帧采样安装顺序、重复注册 Browser handler 和弹窗遮罩合成的夹具问题也已修正；最终 Electron 运行失败0。

## 5. 真实截图、覆盖与视觉结果

有效产品截图共 **143张**：主题63 + 既有IA37 + Runtime浅色43；不计UI-0截图、不计2张原生抓取的全黑诊断图。实际 Electron 44.4.3 / Chromium 152.0.7977.130，API/Pi回复均为离线 fixture；Runtime 使用生产 server 与真实临时 Git/进程，仍不是真模型证明。

| 场景 | 截图/结果 |
|---|---|
| Light 1200、侧栏展开、Changes | [light-1200-sidebar-open-changes.png](ui-1-evidence/electron/light-1200-sidebar-open-changes.png)：白色表面、灰色选中、红绿Diff语义清楚 |
| Dark 700、侧栏展开、Changes overlay | [dark-700-sidebar-open-changes.png](ui-1-evidence/electron/dark-700-sidebar-open-changes.png)：右栏沿用覆盖式行为；不声称四栏同时可读 |
| Light 700、Browser | [light-700-sidebar-open-browser.png](ui-1-evidence/electron/light-700-sidebar-open-browser.png)：浏览器加载本机fixture，外部内容不强制换色 |
| Light外观弹窗与键盘焦点 | [light-appearance-keyboard.png](ui-1-evidence/electron/light-appearance-keyboard.png)：select、Tab/Shift+Tab、Escape和关闭焦点交还 |
| Runtime浅色及开发进程 | [e-central-1280x800.png](ui-1-evidence/runtime-light/p32-4/e-central-1280x800.png)：独立会话/模型控件/右栏均保持浅色表面；开发进程未伪装成终端 |

主题专项核心为 dark/light × 700/900/1200/1536 CSS px × 左栏开关 × 右栏关闭/Changes/Browser 的48种组合；另测80/125/150%应用zoom、System应用内nativeTheme变化、弹窗、重载/重建、最大化/还原和reduced-motion。各场景 computed style、网页顶带像素、实际 `setTitleBarOverlay` 调用和无页面溢出检查均在results的facts/checks/overlayCalls中，未仅凭DOM字符串判断视觉。既有IA覆盖搜索、项目/会话菜单、Planner、Skills、命令面板、hover/focus等。

**证据限制：** capturePage不包含Windows原生按钮；desktopCapturer未取得精确窗口缩略图，随后仅对自己测试窗口HWND调用PrintWindow，返回全黑图。两次原生抓取均在 `nativeWindowSnapshots` 标为 available=false，不计入63张截图或通过项。网页顶带/右栏同色和真实原生API调用已证实，原生按钮带最终合成像素、接缝、hover及真实OS DPI变化仍需可用桌面环境下补拍。System事件在本应用内模拟，没有改Windows设置；本机应用zoom不等于完整OS DPI矩阵。

## 6. 离线构建和产物

使用本机已缓存Electron zip，显式离线，未装依赖。执行 `npm run build:app -- --rebuild --output-root <全新绝对目录>`，内部重建SEA/静态资源；原build/dist/dist-app及正在使用的安装产物不动。

最终输出根：`C:/pi-GUI/.ui1-build-final-1792129898855-d578f0cafd427`。详见 [build-final-report.json](ui-1-evidence/build-final-report.json) 及 `build-final*.log`。

- fixtures和构建实际退出0。
- SEA exe-check：49/49，退出0。
- Electron包内后端 app-check：26/26，退出0；这是包内后端/PDF/docx等验证，不冒充打包后的完整桌面主题实拍。
- 12/12产品文件源码/包内SHA一致；新theme/theme-init/tokens资产均在SEA manifest。最后的reduced-motion CSS修正已入包。
- SEA：99,414,016 bytes，SHA256 `81b0b1523895df951106a8f637144bde0b581f71eb38d9494114af35f069b17b`。
- Electron入口exe：246,324,736 bytes，SHA256 `4277314cc0d4bbd758581055181d770ba8ff024537514e0e70d1e36ad8ec518a`；不能把入口exe的hash当作整包hash。

首次隔离输出早于最后CSS修正，未作为交付产物；保留 `.ui1-build-1792129861508-87b5d0aa15777` 供追溯。最终app-check第一轮在仓库内TEMP报告25/26、退出1，唯一失败为祖先node_modules违反隔离前置条件；改到仓库外新TEMP后完整26/26，原失败日志保留。未通过改业务代码绕过守卫。

## 7. 未完成项、回退与后续门槛

1. **未关闭的视觉验收项：** 可用Windows桌面上的原生按钮/网页接缝实拍，尤其运行中切主题、最大化/还原及不同应用缩放；实际OS主题事件、完整OS DPI矩阵未验。
2. 真模型完整任务、长时soak、POSIX、安装器升级/签名/发版不在本轮证据中。中文文本输入/焦点导航已保留回归，但没有验证所有真实中文IME候选窗口场景。
3. UI-1仅完成基础表面和导航；消息排版、工具摘要、Thinking业务、输入交互和高级动效按UI-2–4执行，没有提前改写。

回退时把 `tokens.css`、theme-init/theme模块、main/preload/theme controller、相应CSS/设置入口作为同一展示边界回退，避免只回CSS而原生调色板仍为新值。只处理上述已归属文件/hunk；不使用全仓reset/clean、不清理用户素材或历史目录。新偏好文件为独立展示设置，旧代码会忽略；不涉及项目或会话迁移。测试新增入口与对应测试可随同回退，不删除旧127条链。两处隔离构建目录可以保留，不替换用户原安装。

**UI-2条件：** Token/主题/基础布局具备继续开发条件，未发现受保护协议或业务回归。开始UI-2仍由用户明确下达；UI-1的原生视觉缺口必须保留在后续验收清单，不能因为自动化通过而关闭。本轮在交付本报告后停止。
