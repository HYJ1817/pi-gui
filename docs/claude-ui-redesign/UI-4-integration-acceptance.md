# UI-4 集成与联合验收

日期：2026-10-17，Asia/Shanghai。工作区 `C:/pi-GUI-ui4-integration`；分支 `codex/ui4-integration`；共同基线 `17f855f01fedb7b13a13496ba45ebf8d28e465ac`。

状态：A/B/C 三个分支已按独立历史合入；生产接线、联合 Electron、Runtime 原生边界、CDP 视觉矩阵、完整 `npm test` 与隔离离线构建均已完成（见第 6、7 节）。本地提交，不 push、不 merge main、不打 tag、不升级版本、不发版。

> 本文件是集成验收，不替代 A/B/C 各自的设计验收；协议与状态语义以 [UI-4B-acceptance.md](UI-4B-acceptance.md) 为准，右栏边界以 [UI-4A-acceptance.md](UI-4A-acceptance.md) 为准，通知语义以 [UI-4C-acceptance.md](UI-4C-acceptance.md) 为准。

## 1. 输入分支和预检

| Agent | 真实最终提交 | 集成 merge 提交 |
|---|---|---|
| A 右栏 | `a097b17b26a8a3c6944c6ff2aae401349ee635f1` | `7fa6df15b52f5c6d417ef99b58c54a3d0f3d43af` |
| B 审批 | `c2b1044d40aea61f066bfa4845909c266e0f53be` | `54a90d37c9dcfde67b3cd79509e084a07514b7a7` |
| C 通知 | `8679740192b39875b08232adf82439307d0aefd0` | `68c9f92ac0920ac35682c08a11ed76c1a460c1e1` |

三次 `git merge --no-ff`，无文本冲突；merge-base 均为共同基线。A/B/C 输入工作区在原集成阶段与本轮接手后均未切换、重置或写入（只读验证）。原仓库 `C:/pi-GUI` 未被本任务修改。

本轮的接手依据是 [UI-4-integration-HANDOFF.md](UI-4-integration-HANDOFF.md)：集成修复仍在未提交工作区，未重做 merge、未新建空工作区、未安装依赖。`node_modules` 是指向 `C:/pi-GUI/node_modules` 的忽略 junction；全程无网络、无依赖变更。

## 2. 文件范围与安全审查

相对共同基线的产品文件：

- A：`public/right-pane.js`、`public/session-changes-panel.js`、`public/process-panel.js`、`public/ui4-pane.css`。
- B：`public/approval.js`、`public/ui/modal.js`、`public/ui4-approval.css`。
- C：`public/ui/toast.js`、`public/ui/notice.js`、`public/ui4-feedback.css`。
- 集成共享入口：`public/index.html`、`public/app.js`、`public/api.js`、`public/runtime-conversation.js`、`public/runtime-nav.js`、`public/runtime-sessions.js`、`public/browser-pane.js`、`public/ui/action-menu.js`；`package.json` 仅测试脚本。
- 集成新增测试：`tests/ui4-integration.cjs`、`tests/ui4-integration-electron.cjs`、`tests/ui4-runtime-electron.cjs`、`tests/ui4-cdp.cjs`。
- 修改既有测试以接入联合场景：`tests/runtime-electron.cjs`（`UI4_RUNTIME_INTEGRATION` 钩子与 sandbox）、`tests/ui4-approval.cjs`、`tests/ui4-feedback.cjs`、`tests/ui4-pane.cjs`（证据根 / 静态样式表 / 联合入口）；`tests/bridge-state-recovery.cjs`（先验证重启确认再做重新同步，避免引用已移除的 Notice 按钮）；`tests/visual-harness.cjs`（`VISUAL_PUBLIC_ROOT` 规范化为绝对路径，修复正斜杠路径被 `startsWith` 误判 404）。所有原断言保留。

`server/`、`lib/`、`electron/`、`extensions/`、`server.js`、`public/runtime-store.js`、`public/runtime-state.js`、`public/approval-model.js`、`public/tokens.css`、`public/styles.css`、`package-lock.json` 与基线 **无差异**（`git diff --name-only 17f855f -- <protected paths>` 输出为空）。版本仍为 `0.25.0`。

没有修改：Pi RPC/SSE 协议、`extension_ui_response` 的 wire 形状、Runtime store/owner/revision/sequence、审批授权范围与持久化语义、P33 Git 资格/写入闸门、Browser 安全策略、附件解析协议。`api.js` 的 `sendCommand(cmd, {notify})` 只增加展示参数，返回值与请求体形状不变。

## 3. 生产接线

1. **样式表**：`public/index.html` 在 `process.css` 之后静态加载 `ui4-pane.css`、`ui4-approval.css`、`ui4-feedback.css`，ID 分别为 `ui4-pane-style`、`ui4-approval-style`、`ui4-feedback-style`；三个模块的 `ensureStylesheet` 按同一 ID 幂等复用，真实页面中每个只有一份且 `cssRules` 解析成功。`ui4-approval.css` 带 `data-ui4-approval`，与 B 原注入节点兼容。
2. **审批**：Classic 仍由 `approval.js` 的 `pending/settled` 驱动；`sendCommand` 可等待结果，明确区分 `sent`（HTTP 接受并写入 Pi stdin）、`failed`（后端明确拒绝，可重试）、`unknown`（网络/响应解析失败，可能已送达，锁定所有决定）。迟到结果不能结算新请求，也不能改写已记录状态。Stop 不补发第二条矛盾应答。协议没有回执，UI 不显示「Pi 已确认」。
3. **弹窗身份**：`ui/modal.js` 用每次 `openModal` 的实例 token 绑定关闭；`confirmModal` 在 `await` 前后比较 resolve 身份。旧弹窗的迟到成功不能关闭或授权替换后的卡片。
4. **Runtime**：不把 B 的 `renderRuntimeApproval()` 接入生产，保留现有控制器和 owner 闭包；只为 `extension_ui_response` 的异步 notice 增加显示前 owner 对照，普通 Runtime modal 仍执行权威 refresh。没有扩大投影或复制 owner 生命周期。
5. **会话变更**：`session-changes-panel.js` 的缺省工作区匹配收紧为「仅 Classic 且双方都没有 workspace 身份」；Runtime / 明确 foreign 事件不能泛化失效；`clear()` 同步移除 `aria-busy`。P33 资格与写入协议未改。
6. **通知**：Toast 去重键包含只读展示上下文（Classic generation/session + Runtime conversation/owner 九字段）；上下文变化后旧 Toast 标记为「此前会话通知」并禁用动作；hover 与 focus 任一存在都暂停计时；堆叠高度取 Composer 实际上边。Notice 继续绑定 Classic startup/Bridge 状态，不因 Runtime 导航清掉有效 Bridge 错误；同上下文同签名的 handler 原地更新且保留 DOM/焦点。
7. **右栏**：Browser 在原 toolbar 内补真实 `h3`「浏览器」，不新增标题行；容器宽度 ≤360 CSS px 时视觉隐藏标题，地址栏优先；原 46px 工具条、420px 默认宽保持不变。
8. **动作菜单**：只有能移动锚点的滚动（文档本身或锚点祖先）才关闭菜单；无关的 Toast 栈滚动不再收起会话菜单。
9. **Toast 拆除**：MutationObserver 在文档已销毁（窗口关闭/卸载）时不再排帧；`placeToasts` 先确认文档与窗口仍存在。

## 4. 集成中发现并修复的问题

除交接文档已列的 13 项外，本轮接手后额外发现并修复：

1. **B 桌面套件陈旧文案断言**：`tests/ui4-approval.cjs` 仍断言失败卡写着「仍在等待」，实际协议事实是「后端没有接受这条应答」。按真实投递结果最小更新断言，保留 44 项与「后端拒绝可重试、unknown 锁定」判据。
2. **Toast 滚动误关会话菜单**：UI-4C 把 `#toasts` 变成可滚动容器后，Toast 栈的滚动事件会让锚点根本没动的 `#actionMenu` 收起。CDP 在 1200×800 稳定复现（两次完整矩阵，6 条结构判据失败；基线 `17f855f` 同场景 1761/1761 通过）。修复 `action-menu.js` 的 `onScroll` 判据，并加入集成回归用例（55/55）。
3. **UI3 Composer 套件 rAF 拆除**：Toast 的 MutationObserver 在 jsdom `window.close()` 后仍排 `requestAnimationFrame`，`placeToasts` 访问已销毁的 `document` 抛错，使 `npm test` 在 34/34 之后退出 1。为观察回调与 `placeToasts` 增加文档存活守卫；Composer 套件恢复 34/34、退出 0。
4. **Bridge 恢复测试的过期按钮引用**：重新同步成功后 Notice 正确消失，旧按钮已脱离 DOM；UI-4C 明确不执行脱离节点的动作。基线里 `click()` 仍会触发脱离节点的 handler，属于测试的偶然通过。测试改为先在 Notice 上验证「重启 Pi」的确认路径，再做重新同步（55/55）。
5. **CDP 附件固件**：`tests/ui4-cdp.cjs` 每次使用新 TEMP，原实现没有生成 `pi-gui-fixtures`，附件断言会被静默跳过。现在在同一 TEMP 先生成固件（`fixturesExitCode=0`），再跑完整矩阵。

## 5. 审批状态矩阵（集成后）

「展示完成」= 卡片已渲染；「发送成功」= `/api/command` 返回 `ok:true`；「Pi 确认完成」协议不存在。

| 状态 | 触发 | 卡片 / 动作 | 协议 | 本地记录 |
|---|---|---|---|---|
| `pending` | 收到 `extension_ui_request` | 完整正文、来源/类型、一次性决定、超时事实、风险未知 | 无 | `pending` |
| `submitting` | 允许/拒绝/取消 | 按钮禁用、`aria-busy=true`、状态行可见 | 应答在飞 | `pending` |
| `sent` | 后端接受 | 收卡 + toast；不声称 Pi 已执行 | 已写 stdin，无回执 | `settled` + `deliveries.sent` |
| `failed` | 后端明确拒绝 | 卡片保留、原因可见、可重试；重试必须是用户下一次点击 | 应答未送达 | 仍在 `pending`；`deliveries.failed` |
| `unknown` | 网络/响应解析失败 | 卡片保留、锁定所有决定，只允许「关闭提示」；不补发取消 | **可能已送达** | `settled=unknown`；`deliveries.unknown` |
| `expired` | 超时 / 切工作区 / 切会话 / 桥接重启 / agent settled | 收卡；不发应答 | — | `settled=expired` |
| `cancelled` | Stop；或 select/input/editor 取消成功 | 收卡 | `{cancelled:true}` | `settled=cancelled` |
| 迟到结果 | 在 Stop/切换/超时之后返回 | 不能打开或结算替换后的卡；失败/unknown 以持久 warning 说明 | — | 不改写已记录状态 |

安全边界保持不变：拒绝、取消、Esc、点遮罩、Stop、超时、切换都不会产生「允许」；没有 Always Allow / Bypass / Auto Approve；确认卡只有「拒绝 / 允许一次」两个决定按钮；风险恒为 `unknown`，不从文案猜等级；所有工具/模型文本走 `textContent`；不存原始 payload。

## 6. 测试与证据

### UI-4 专项（jsdom）

| 套件 | 结果 | 退出码 |
|---|---|---|
| `node tests/ui4-approval.cjs` | 44/44 | 0 |
| `node tests/ui4-feedback.cjs` | 27/27 | 0 |
| `node tests/ui4-integration.cjs` | 55/55 | 0 |

### UI-4 真实 Electron / CDP

| 执行 | 结果 | 证据 |
|---|---|---|
| `node tests/ui4-approval.cjs --electron` | jsdom 44/44 + Electron **44/44**，22 图 | `ui4-integration-evidence/approval-electron/`、`approval-electron-final.log` |
| `node tests/ui4-feedback.cjs --electron` | **9/9**，7 图 | `feedback-electron/`、`feedback-electron-final.log` |
| `node tests/ui4-integration-electron.cjs` | **427/427**，75 图 | `electron/`、`electron-final.log` |
| `node tests/ui4-runtime-electron.cjs` | **181/181**，47 图 | `runtime-electron/`、`runtime-electron-final.log` |
| `node tests/ui4-cdp.cjs` | **1775 条取景断言，0 失败**，附件固件 exit 0 | `cdp-final.log`、`cdp-process.json` |

CDP 基线对照：`17f855f` 同场景 **1761 条，0 失败**（`baseline-cdp.log`）。修复前 UI-4 两次完整复跑均在同一处失败（`cdp-first.log`、`cdp-second.log`；事件探针 `cdp-probe.log`、`cdp-probe2.log` 证明关闭源是 `#toasts` 的 scroll）。

### 完整 `npm test`

- 命令：`npm test`（canonical 入口，顶部新增 `npm run test:ui4` 前缀；原字符串后缀逐字保留，程序断言 `suffix-preserved=true`）。
- 结果：**退出码 0**，**3393.3 秒**（56 分 33 秒），`12:35:19Z–13:31:44Z`；日志 [final.log](ui4-integration-evidence/final.log)，进程记录 [final-process.json](ui4-integration-evidence/final-process.json)。
- 套件摘要：**85 个**（基线 82 个原有套件 + 3 个新增 UI4 套件）；`failed=0` 行 **0 条**，`FAIL` / `not ok` **0 条**。
- 跳过：**18**，与基线完全相同（`session-revert-sacl-witness` 8、`session-revert-inplace` 2、`Object witness` 8；均为权限/研究限定，跳过的断言不计入分子分母）。
- 期间的三次失败与处理保留为证据：`final-attempt1.log`（UI3 Composer 的 jsdom rAF 拆除，已修产品守卫）、`final-attempt2.log`（Bridge 恢复测试的过期按钮引用，已改测试顺序）、`final-attempt3.log`（P33 相对 `SystemRoot` 用例受 Git Bash 大小写环境变量影响；用标准大小写 `SystemRoot` 启动后 23/23，产品未改）。
- 基线对照：[baseline.log](ui4-integration-evidence/baseline.log) 为 82 个摘要、0 失败、18 跳过；本轮原有 82 个套件全部保持通过，未减少任何既有断言。

### 既有套件（本轮复跑）

| 套件 | 结果 |
|---|---|
| `tests/smoke.cjs` | 1338/1338 |
| `tests/sidebar-menu.cjs` | 37/37 |
| `tests/bridge-state-recovery.cjs` | 55/55 |
| `tests/interactions.cjs` | passed |
| `tests/ux-state.cjs` | 15/15 |
| `tests/hotfix-ui.cjs` | 10/10 |
| `tests/approvals.cjs` | 80/80 |
| `tests/ui2-classic.cjs` | 48/48 |
| `tests/ui2-runtime-display.cjs` | 82/82 |
| `tests/ui3-integration.cjs` | 23/23 |
| `tests/runtime-ui.cjs` | 16/16 |
| `tests/runtime-conversation.cjs` | 48/48 |
| `tests/runtime-finish-ui.cjs` | 27/27 |
| `tests/modules.cjs` | 117/117 |
| `tests/dev-server.cjs` | 30/30 |

## 7. 构建与包内验证

- 命令：`PI_GUI_ELECTRON_ZIP_DIR=<本机缓存> node scripts/build-app.mjs --rebuild --output-root <全新绝对 TEMP>`；**退出码 0**，无网络。日志 [build.log](ui4-integration-evidence/build.log)，进程记录 [build-process.json](ui4-integration-evidence/build-process.json)。
- 输出根：`C:/Users/21022/AppData/Local/Temp/pi-gui-ui4-build-ZLR49f`（全新 TEMP；不是仓库目录）。
- Electron zip：`electron-v44.4.3-win32-x64.zip`，158,247,567 字节，SHA-256 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`。
- 产物：`dist-app/Pi GUI-win32-x64/Pi GUI.exe` 246,324,736 字节；整包 344,184,388 字节（脚本报告 328.2 MB）。
- **源/包 public 全文件哈希**：107 ↔ 107 个文件，`onlySource=0`、`onlyPackaged=0`、`mismatched=0`；[build-audit.json](ui4-integration-evidence/build-audit.json)。
- **三套 CSS**：`ui4-pane.css` / `ui4-approval.css` / `ui4-feedback.css` 在包内 index.html 各 **1** 个 link，文件均存在（18,415 / 11,350 / 10,932 字节），ID 与模块幂等注入一致。
- `node tests/app-check.cjs --output-root <root>`：**26/26**，退出 0（[build-app-check.log](ui4-integration-evidence/build-app-check.log)）。
- `node tests/exe-check.cjs --output-root <root>`：**49/49**，退出 0（[build-exe-check.log](ui4-integration-evidence/build-exe-check.log)）。
- **包内 UI4 联合 Electron**：`UI4_ASSETS_ROOT=<包内 public> UI4_INTEGRATION=1 node tests/ui4-pane.cjs`：**427/427，0 失败，75 图**，退出 0；[packaged-electron/results.json](ui4-integration-evidence/packaged-electron/results.json)。首次失败 [packaged-electron-attempt1.log](ui4-integration-evidence/packaged-electron-attempt1.log) 是 `VISUAL_PUBLIC_ROOT` 正斜杠路径被 `startsWith` 误判 404；修正夹具路径规范化后通过，产品未改。
- 包内截图与源码版截图分开存放：`ui4-integration-evidence/packaged-electron/`。

## 8. 真实截图人工检查

已人工查看（不只跑断言）：

- `approval-electron/approval-dark-1200-pane-closed.png`：深色、长命令换行、风险中性说明、拒绝/允许一次可区分、初始焦点在拒绝。
- `approval-electron/approval-light-700-pane-open.png`：浅色、700 CSS px、右栏打开，卡片不超出视口，操作区换行。
- `approval-electron/state-failed-dark-900.png`：后端拒绝后卡片保留、错误行可见、按钮恢复。
- `runtime-electron/p32-4/ui4-runtime-owner-replaced.png`：Runtime owner 替换后旧通知标记「此前会话通知」且动作禁用，新通知独立。
- `electron/joint-explicit-delivery-failure.png`：Classic + 原生 Browser 同时存在，长中文路径不溢出，失败原因来自真实投递。
- `electron/dark-700-browser-browser.png`：窄宽下原生 WebContentsView 边界与中央区布局。
- `feedback-electron/ui4-toasts-dark.png` / `ui4-notice-light.png`：四种 Toast、持久 Notice、动作与关闭层级。

限制：截图是 `capturePage` 的网页像素，不含 OS 窗口装饰；Approval/Feedback 套件不连接真实 Pi；Runtime 套件使用真实 Electron、真实 server、真实 native Browser 与 fake Pi，但 `FIXTURE_UI4_APPROVAL` 的 settled 是夹具事件，不能当作真实 Pi 执行证据。

## 9. 已知限制

- Classic 协议没有应答回执：`sent` 只代表后端接受并写入 Pi stdin，不代表 Pi 已执行。
- `approval-model.js` 的 600 字符 message 上限是既有安全边界；UI 不二次截断，但也不会绕过模型层规范化。
- Runtime store 投影没有审批正文；本任务不编造，也不扩大隐私投影。Runtime 仍使用现有 renderer，未接入 `renderRuntimeApproval()`。
- 被其他弹窗替换的审批没有恢复入口；迟到失败/unknown 留在持久 warning 中。后台请求可能仍等待 Stop 或真实 timeout。
- Stop 发生在「允许已发出但结果未知」的窗口时，无法撤回已写出的允许；UI 只保证不补发第二条矛盾应答并收卡。
- 同时只有一个确认框；新确认框顶掉旧请求时，旧请求按既有 P19 行为结算为 denied。
- 没有使用真实 Pi、真实用户会话或真实项目做写操作；所有测试数据为 jsdom / Electron / CDP 夹具。
- 没有真实 Windows 中文 IME 手工终验；没有系统级窗口捕获，原生 caption 接缝未关闭。
- C 验收文档中标注为「建议」的两项未接入：Workspace 切换的 `busy` Notice 模型、Runtime notice 的 `data-state="error"` 语义。本轮只接入 C 的样式、Toast 上下文/失效/暂停与 Notice handler 刷新，避免在共享文件里新增未经联合测试的状态机；现有 bridge Notice 与 Runtime 文本状态保持不变。
- 本轮全量测试从 Git Bash 启动，MSYS 会把 `SystemRoot` 规范成大写 `SYSTEMROOT`，导致 P33 的「相对 SystemRoot」env 覆盖用例假红；用标准大小写 `SystemRoot` 启动后 23/23。该用例属于真实 OS 观测，记录在 `final-attempt3.log`，不改 P33 代码或测试。
- 本任务不负责把安装版 v0.24 切换到本开发分支；离线构建产物只存在于 TEMP，未写入仓库或用户安装目录。

## 10. 提交

| 内容 | SHA |
|---|---|
| 共同基线 | `17f855f01fedb7b13a13496ba45ebf8d28e465ac` |
| A / B / C tip | `a097b17b26a8a3c6944c6ff2aae401349ee635f1` / `c2b1044d40aea61f066bfa4845909c266e0f53be` / `8679740192b39875b08232adf82439307d0aefd0` |
| 三次 merge | `7fa6df15b52f5c6d417ef99b58c54a3d0f3d43af` / `54a90d37c9dcfde67b3cd79509e084a07514b7a7` / `68c9f92ac0920ac35682c08a11ed76c1a460c1e1` |
| 产品（public/） | `68caac36b027882686191645a5d08acd255e3d3e` |
| 测试与 canonical 入口 | `e6c0059454f357b5a7bac99a64e6c943556428c7` |
| 本文档与全部证据 | 见 `git log -1`（文档无法包含自身提交 SHA） |

未 push、未 merge main、未打 tag、未升级版本、未发版。提交后工作区应为 clean；输入工作区与原仓库未被修改。
