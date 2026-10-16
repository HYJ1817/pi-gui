# UI-2 集成与最终验收

执行：2026-10-16；归档：2026-10-17，Asia/Shanghai。工作区 `C:/pi-GUI-ui2-integration`，分支 `codex/ui2-integration`。共同起点 `d0585b89a81c0a93e894d58b9d078af75aa985b2`（UI-1）。

**结论：A/B/C 集成、展示修补、完整业务回归和隔离离线构建完成；严格桌面验收尚未全部通过。** 打包启动存在间歇性初始上下文错误，Windows原生标题栏接缝实拍仍未取得，不能宣布UI-2所有验收项已关闭。 本报告不授权进入 UI-3，不推送、不合并 main、不升级版本、不打 tag、不发版。

## 1. 输入分支、隔离与合并

| 成果 | 实际最终 SHA | 集成 merge SHA |
|---|---|---|
| A Classic | `5573e7387b379ee5bebbc5cd35faf0157f82e230` | `f356069917e8222fac8448a8be66baf6557515b0` |
| B Runtime | `72294e6aa98b7edda7da016e95fa5781c074e138` | `f2599bdfe223cac357a2992571334d099afbdf45` |
| C 视觉 | `ceab44e23065dc53a04ac6813f2ac64de49aee08` | `50d20dd523c765fbd45072e170be5e3d9e8b3a03` |

按 A→B→C 顺序本地 `git merge --no-ff`，没有文本冲突，提交历史完整保留。C 的末轮真实 DOM 样式修补 `208feb5fd87cb088ae49f73b8aa13906148c0695`、相应 57 条测试修补 `d5ba8aa35bc050360f2cbc0296b881fed62d33c6` 均在 ceab44e 的祖先中，没有取修补前版本。

创建前检查目录/分支，使用指定起点创建独立 worktree。原 A/B/C 在开始及集成后均无未提交修改、HEAD 未变，未复制原工作区未提交文件。原仓库的未跟踪素材/规划文件未处理。只读参考原仓库 AGENTS、机器记忆与 UI-0/1 文档，按离线约束不 fetch、不访问远端、不下载依赖。依赖使用本机已有 node_modules 的忽略目录 junction；这不是新增依赖。

完整分支、源文件、受保护路径差异记录见 [source-audit.json](ui2-integration-evidence/source-audit.json)。集成展示修补提交 `c63175c955666afcd4c77df659e8b084a0979be1`；最终产品/测试版本 HEAD 为 `5f8a7671b8f991729e7d5da9431a26404f327967`（测试整合提交），本报告与证据另作末尾归档提交。归档提交最终SHA见交付对话或本分支 `git log -1`，不写成文档内容的哈希自引用。

## 2. 实际产品与测试变化

相对 UI-1 的产品文件仅以下 7 个；其余是测试、验收文档与证据。

| 文件 | 最终行为 |
|---|---|
| `public/messages.js` | Classic Thinking 状态和消息元信息接入；保留消息基本类与原有文本/中断语义；流式新助手出现时尊重用户阅读位置 |
| `public/message-meta.js`（新增） | 仅取对应助手自己的 usage；真实 0 可见，未知省略；不取 localUsage.lastTurn，不伪造耗时 |
| `public/tool-view.js` | 复用既有分组/ToolEntry，真实数量摘要、原生 button、ARIA、折叠状态和失败/运行计数；单项避免重复摘要 |
| `public/tools.js` | 工具开始时沿用滚动跟随判断，取消无条件拉底；执行/配对/Git 回填逻辑未改 |
| `public/runtime-display.js`（新增） | 只消费已通过 store 校验的帧，Thinking 与 usage 纯展示投影、截断、终值来源、记录有效期 |
| `public/runtime-conversation.js` | Runtime Thinking/usage/工具状态 DOM；每会话手动展开与滚动；在布局变化前捕获跟随状态 |
| `public/styles.css` | C 的 768px 阅读轴、消息/工具/Thinking/Runtime 层级、明暗语义色、换行、响应式和 reduced-motion |

测试/入口：新增 `tests/ui2-classic.cjs`、`tests/ui2-runtime-display.cjs`、`tests/ui2-visual.cjs`、`tests/ui2-integration-electron.cjs`；修改 `tests/cdp-shot.cjs`、`tests/theme-electron.cjs` 和 `package.json`。Classic/theme 测试仅新增可选证据输出目录，保留原断言；visual 测试另修独立临时浏览器 profile 与关闭清理，防止覆盖源分支证据。新增三套已前置接入 canonical `npm test`，UI-1 完整 128 条链原样保留，共 131 条；同时新增 `test:ui2`。版本和依赖不变。

所有实际变更路径及分支归属见 [change-manifest.json](ui2-integration-evidence/change-manifest.json)、source-audit 和最终 Git diff；A/B/C 的原验收及截图作为继承材料保留，**不代替本轮联合证据**。

## 3. 组合问题及修复证据

没有 merge 文本冲突；发现以下行为问题，均在集成分支最小修复。

1. Classic `createAssistant` 与 `onToolStart` 强制滚底：仅去掉两处 `scrollBottom(true)` 的强制参数。用户主动发送消息仍保留原强制滚底，历史恢复逻辑不变。
2. Runtime `draw` 在正文/Thinking 改变布局后才判断贴底：改为绘制前捕获 follow，保持切会话位置分支不变。大型 chunk 不再误判为用户离底。
3. Runtime assistant 最终帧缺 usage 时保留“流式中”旧值：改为省略缺失最终用量；不将临时值升级为权威终值。
4. Runtime 纯展示投影将 store 记录消失与关闭后 owner=null 混淆：绑定当前已接受 store 对象身份；新后端/新记录/缺记录使旧展示失效，原记录真正关闭仍可保留本地已观察展示。未修改 owner 或 store 的验收规则。
5. Token 数值仅接受非负安全整数，费用接受非负有限小数，拒绝负数/小数 token；0 保留。没有使用文字长度替代 token，Thinking 的“字”明确是字符计数。

[review.md](ui2-integration-evidence/review.md) 保留复核与复测。Runtime 新增 8 条回归，74→82，无删减，先红后绿见 runtime-red.log/runtime-after-fixes.log。滚动初轮 40/56：15 条对应上述三个滚动缺陷，另 1 条是夹具误以为关闭/恢复会保留旧文本；修正为真实 fresh-record 语义后再测，未改生产关闭协议。原始 [pre-fix-report.json](ui2-integration-evidence/scroll/pre-fix-report.json) 保留。

## 4. DOM 与 CSS 的真实匹配

| 真实接口 | 联合结果 |
|---|---|
| `.msg.user`、`.msg.assistant`、`.msg-body` | 保留；用户气泡/助手正文层级、长内容内部滚动 |
| `.think`、`.think-head`、`.think-body`、`.ui2-think-status` | 完成/流式/错误/中断有文字；手动展开不被流式绘制覆盖；错误/中断消费 err/warn token |
| `.tl-group`、`.tl-group-head.ui2-tool-summary`、`.tl-list`、`.tl-item`、`.ui2-tool-state` | 真实 button 的 Enter/Space、Tab、aria-expanded/controls；摘要真实数量；折叠仍可发现运行/失败；明暗共用语义 token |
| `.ui2-msg-meta`、`.ui2-msg-meta-item[data-kind]` | footer 是正文同级，真实单消息用量，缺数据不造行；tool-only 不制造空白助手 shell |
| `.ui2-runtime-thinking-body` | pre-wrap + overflow-wrap，64KiB 上限诚实截断；700px 下长连续英文不撑宽 |
| `.ui2-runtime-usage` | 当前已观察助手用量来源，缺失/未知隐藏；不假装历史具备这些数据 |
| `.ui2-runtime-tool[data-state]` | 实际 running/done/error 三态及文字，未知回落中性色；不虚构工具详情/结果 |

`.ui2-runtime-status`、`.ui2-runtime-meta` 是 C 留下的未使用预留选择器，**不算作任何已完成适配或验收证据**。本轮只以生产 DOM 的 thinking/usage/tool 接口及其真实 Electron 渲染为依据。

## 5. 联合 Electron、滚动及视觉证据

全部新证据在 [ui2-integration-evidence](ui2-integration-evidence/)，Electron 44.4.3 / Chromium 152.0.7977.130。均运行集成后真实 public 模块和样式，独立临时 userData、端口和 fixture；无用户项目/会话写操作、无真模型调用。

| 实际命令 | 实际结果 | 范围/证据 |
|---|---|---|
| `node tests/ui2-classic.cjs --electron` | 65/65，退出0，16截图 | [classic-electron](ui2-integration-evidence/classic-electron/)；生产 Classic 历史+实时、独立usage/缺失/0、工具、Thinking、键盘与四宽度/两主题 |
| `node tests/theme-electron.cjs` | 489/489，退出0，63有效截图 | [theme-electron/results.json](ui2-integration-evidence/theme-electron/results.json)；dark/light ×700/900/1200/1536 ×左栏开/关 ×右栏关/Changes/Browser，另80/125/150%zoom、System、重建/重载、最大化/还原、焦点/弹窗/reduced-motion |
| `node tests/ui2-integration-electron.cjs` | 72/72，退出0，24截图 | [scroll/report.json](ui2-integration-evidence/scroll/report.json)；实际连续输出、真实 CDP wheel 和可信 scroll 事件、A/B草稿与位置、迟到帧、历史/停止请求/恢复live |
| `node tests/runtime-electron.cjs`（dark、light分别执行） | 171/171 ×两主题，各退出0，各43截图 | [runtime-dark](ui2-integration-evidence/runtime-dark/)、[runtime-light](ui2-integration-evidence/runtime-light/)；生产 server/临时Git/真实子进程、owner与关闭/审批/模型/Browser回归；Pi回复仍为fixture |

滚动不是纯函数证明：Classic/Runtime 均实际上滚650px，确认 isTrusted scroll；连续六个增量后阅读 top 不变，wheel 回底后新大块内容跟随，最终底部 gap 分别约0.67px/0px。原64条确定性 DOM 几何断言全部保留，新增8条wheel断言。A→B→A、后台合法迟到A、离开/重进、停止请求和历史/实时切换均有实际布局记录。history/stop API 使用 CDP 离线回复，不能据此声称真 Pi stop completion 已验。

人工复核本轮 Classic light700-expanded、Runtime dark700长Thinking、light700工具和主题右栏截图：消息与输入轴一致，元信息能换行，工具失败红字/成功绿字在浅色可辨，长连续Thinking在列内折行；700px保留既有覆盖式右栏行为，不声称四栏可以同时完整阅读。参考用户 Claude 实机 `22-40-02`/`22-44-26` 截图的正文/工具摘要层级，没有复制字体或添加截图里的 Auto/Bypass/PDF 等能力。正文仍消费 UI-1 的14px token，是否调整到估算15px留后续统一Token校准；767px输入测量不当固定窗口规格。

**原生标题栏未关闭项：** 本轮再次尝试 exact fixture HWND 的 Windows PrintWindow，dark/light均全黑；results 中 available=false，两张诊断图不计有效63张。不把 capturePage 当原生窗口截图。真实 setTitleBarOverlay API、网页/右栏46px顶带CSS与采样像素一致已验；原生按钮合成接缝/hover、真实OS主题事件及OS DPI仍需可用系统桌面补拍。System仅应用内 nativeTheme 模拟，应用zoom不等于完整OS DPI。

## 6. 测试基线与 cdp 陈旧断言

新增专项实际数量：Classic48/48、Runtime82/82（原74+8）、Visual57/57；无原断言下降。完整 `npm test` 首轮运行490.109秒、退出1：dev-server在127.0.0.1:7791发生listen EACCES，两个服务前置断言失败，后续fetch中止；此前套件完成不能冒充全链通过。保留 npm-test-attempt1.log 与 npm-test-attempt1-exit.json。随后不改任何代码，实际同端口bind探测成功，独立 `node tests/dev-server.cjs` 30/30、退出0；系统当时排除端口范围只有50000–50059，未观察到7791占用，无法追溯瞬时拒绝来源，按环境启动失败记录。第二轮完整 `npm test` **实际退出0**，2026-10-16 22:46:39.125至23:39:55.741（+08:00），**3196.616秒**。131条入口链完成，116条数字摘要，失败0；reliability/interactions/port-owner另有不打印数量的passed结果，不编造断言总数。实际退出记录见 [npm-test-exit.json](ui2-integration-evidence/npm-test-exit.json)，原始 [npm-test.log](ui2-integration-evidence/npm-test.log)，逐套计数 [test-summary.md](ui2-integration-evidence/test-summary.md) / [test-results.json](ui2-integration-evidence/test-results.json)。日志路径重新创建时Windows复用了较早的creation time，文件时窗3779秒不是测试耗时；运行时间以进程记录3196.616秒为准。

[baseline-comparison.json](ui2-integration-evidence/baseline-comparison.json)：UI-1原113条数字摘要的通过/总计序列完全一致，没有任何既有断言下降；只新增Classic48/48、Runtime82/82、Visual57/57，113→116。**明确跳过19项**（与UI-1一致）：SACL witness8、非空SACL保持2、Object witness8（权限不足），会话符号链接1。两种witness的0/0不是通过；跳过不计通过分子分母，不赋予P33生产资格。

`cdp-shot` 的独立原版复现为1750/1761、失败11、退出1；最终严格版本1761/1761、失败0、renderer异常0、退出0，两轮各270张Chrome截图（全部留在本工作区忽略目录 .shots/ui2-before-*.png 与 .shots/ui2-verified-*.png，版本化证据中保留选定截图；不计入Electron截图数），263次shotOf+57次UX调用，194个shotOf静态调用点与14个UX调用点均未减少。见 [cdp-reconciliation.md](ui2-integration-evidence/cdp-reconciliation.md)、[cdp-results.json](ui2-integration-evidence/cdp-results.json)，实际日志cdp-verified.log及退出码cdp-verified-exit.json。已确认原11条失败为：10处顶栏旧#0d0d0d与UI-1 Dark#111111/Light#fbfbf9冲突；1处项目菜单仍期待2项，而共同UI-1代码实际已是“工作区管理→项目设置→分隔→移除项目”。修正以共同基线真实源码/Token为依据，保留尺寸、位置、焦点等全部判据，采用固定主题常量+Token一致性和完整有序菜单校验，不删断言。

额外审查发现 `shotOf` 将异常描述字符串当truthy通过，改为谓词必须 `=== true`。严格执行由此揭露另外4个潜藏陈旧断言：builtin capability状态/来源真实结构1项、滚动条主题颜色3项；与原11条分开记录。严格首轮1757/1761、退出1，如实保留；最终严格全轮1761/1761、退出0，额外负向对照26/26、退出0：两主题下旧背景/旧滚动条、错误Token、缺菜单/缺来源/多余启用加载字段均必须拒绝。没有靠放宽成任意Token自洽来通过。

## 7. 离线构建与包内资产

实际执行 `node scripts/build-app.mjs --rebuild --output-root <fresh absolute temp root>`（即package.json的build:app入口，未实际调用npm包装命令），显式指向本机缓存 Electron zip，未联网安装。输出：`C:/Users/21022/AppData/Local/Temp/pi-ui2-build-557f38db-41b6-41aa-9311-e99bee5c9d5c`，不覆盖现有build/dist-app/用户安装产物。临时数据在仓库外，进程仅结束自己启动的fixture。

| 检查 | 实际结果 |
|---|---|
| fixtures / build:app | 均退出0 |
| exe-check | 49/49，退出0 |
| app-check | 26/26，退出0；包内后端验证，不代表完整桌面行为 |
| 源码→Electron包内全部public磁盘SHA | 99/99一致 |
| SEA manifest public收录 | 99/99，manifest总294项 |
| 实际启动SEA并经本机HTTP读取全部public资产SHA | 99/99一致 |

实际检查命令为 `node tests/fixtures.mjs`、`node tests/exe-check.cjs --output-root <上述目录>`（CHECK_PORT=32741）、`node tests/app-check.cjs --output-root <上述目录>`（CHECK_PORT=32751，另使用32752）。SEA逐资源校验为PowerShell here-string送入Node的内联程序，独立端口32761，不冒充仓库已有命名测试。TEMP/TMP/TMPDIR均指向构建根/tmp；PI_GUI_ELECTRON_ZIP_DIR指向build-state中的本地缓存。

打包烟测实际命令是 `node <上述构建根>/desktop-smoke.cjs`，四轮输出分别为build-desktop-smoke{,-repeat,-context,-timeline}.log；最终带时间线的夹具源码归档为 [build-desktop-smoke-source.cjs.txt](ui2-integration-evidence/build-desktop-smoke-source.cjs.txt)。其dist-app入口、32771本机CDP、32772后端、全新userdata/data和不存在的Pi路径可审阅；该文本是审计快照，运行时__dirname必须仍在上述隔离构建根。

证据：[build-state.json](ui2-integration-evidence/build-state.json)、[build-checks.json](ui2-integration-evidence/build-checks.json)、[build-artifacts.json](ui2-integration-evidence/build-artifacts.json) 与 build-*.log。

SEA exe：99,442,176 bytes；SHA256 `2408e60b5143d38abe2b16c54c9942a2dbc397bc0c63fd1537ffac4859646ad5`。Electron入口exe：246,324,736 bytes；SHA256 `4277314cc0d4bbd758581055181d770ba8ff024537514e0e70d1e36ad8ec518a`。入口exe哈希不代表整包哈希，public逐文件摘要另存。另实际启动隔离产物的 production main/preload，采集 [build-desktop-dark.png](ui2-integration-evidence/build-desktop-dark.png) / [build-desktop-light.png](ui2-integration-evidence/build-desktop-light.png)：真实主题桥、无renderer Node require、无真实项目、明暗主题一致并持久化均观察到正常。

**桌面稳定性验收未通过，不能写成整体通过：** 4次有限烟测分别12/12退出0、10/11退出1、11/12退出1、12/12退出0。中间两次各出现2条Electron sandboxed_renderer/preloadScripts内部错误，属于同一主frame的初始空文档`origin=://`隔离上下文；后续本机应用页面default/isolated context及production preload/主题可用。失败试次未记录完整时间戳，最后一次带timeline验证无错误，不能据内部栈就认定环境原因，也未证明一定由CDP导致。见 [build-desktop-summary.json](ui2-integration-evidence/build-desktop-summary.json) 和四份原始report/log。没有扩大范围改Electron沙箱、安全设置或静默忽略console错误。该不确定项保留，不能把最后一次12/12覆盖前两次失败。

最初自写桌面夹具误读/api/projects结构（实际items），对照既有app-check修正；错误试次不列产品通过证据。所有桌面试次使用全新userData/data、无真实项目/Pi/model，更新调度通过既有取消导出关闭；未替换用户产物。实际打包桌面只验启动与主题，不代表打包后完整业务矩阵。

## 8. 安全、限制、回退与阶段结论

受保护路径与UI-1无差异：server/、lib/、server.js、electron/、public/runtime-store.js及runtime-state.js、Pi接口、Browser权限、审批协议、Git撤销/P33闸门均未改。展示订阅仍在原 owner/sequence/generation 校验之后，显示失效校验只能删去过期信息，不能接受原store拒绝的帧。无历史Thinking、单消息usage或工具结果时诚实省略；取消/中断不据工具文字伪造结果。

未关闭问题还包括上述打包初始上下文间歇错误。未验证范围：原生窗口接缝实拍、完整OS DPI/真OS主题事件、全部真实中文IME候选窗、真模型完整任务、长时soak、POSIX、安装器升级与签名。P33 SACL环境跳过不构成生产资格；没有扩大UI2安全权限。

回退以本地集成提交为边界：三个 no-ff merge 保留源提交；先回退集成展示修补/测试入口，再按对应merge主线撤销A/B/C，或保留本分支转回UI-1另建验证分支。不要只回CSS遗漏真实DOM，不对原worktree做reset/clean，不覆盖用户数据。本轮没有session迁移或配置schema变化。隔离产物保留供审阅，不替换当前用户安装。

**阶段判定：实现与联合业务回归完成，严格UI-2验收部分通过，暂不作无条件UI-3放行。** 未观察到受保护协议回归，但仍须定位打包初始空文档隔离上下文错误；原生接缝实拍缺口也不能关闭。若用户决定在已知限制下继续，当前产品/测试版本可作为UI-3代码起点；本轮不自行进入UI-3。

最终可执行代码及测试HEAD：`5f8a7671b8f991729e7d5da9431a26404f327967`；展示修补边界：`c63175c955666afcd4c77df659e8b084a0979be1`。最终归档提交只含本报告/证据，无产品变化；精确归档HEAD在交付对话与本分支Git记录中。所有操作仅在本地集成分支，无推送、main合并、tag、版本升级或发版。完成后停止，等待用户验收。
