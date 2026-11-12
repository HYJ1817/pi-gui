# 终端 P2 验收记录：多终端与会话生命周期

日期：2026-11-12–13（测试运行于 11-12 深夜，文档收尾于 11-13）  
分支：`feat/terminal-pty-p2`  
基线：`8dcca4ae3ba15f160a7b528a89650a30d11f344c`（P1 合并后的 `origin/main`）  
证据范围：提交前工作区 diff（与交付提交内容一致；若行为提交后仅修改本报告，另行标注）  
交付提交：包含本报告的提交，可用
`git log -1 --format=%H -- docs/terminal-p2-acceptance.md` 解析  
范围：多终端标签、会话生命周期、工作区隔离、右栏标签 UI 与三运行时证据。

> 本记录只证明下列命令、构建和真实环境。完整的 `npm test` 尚未在本记录完成，
> 因此**不宣称 canonical 全量已通过**；本 PR 的 CI 将作为最终 canonical，结果出来前
> 合并结论仍须以完整 canonical、独立审查和用户明确授权为准。

## 一、实现落点

| 文件 | 责任 |
| --- | --- |
| `server/terminal.js` | 服务端会话账本、状态机、workspace 归属校验、输出缓冲、游标、上限、scope sweep、退出清理 |
| `server/terminal-process.js` | shell 解析、受信目录加载 node-pty、ConPTY spawn、Windows `taskkill /T` 与一次性回退 |
| `server.js` | 聚焦会话 / 会话自身的 workspace scope；classic 稳定 scope 与 runtime epoch scope |
| `public/api.js` | `create` / `list` / `start` / `read` / `input` / `resize` / `stop` / `close` 客户端与 scope 记忆 |
| `public/terminal-session.js` | 每会话一个 xterm 控制器：读取游标、输入队列、resize、可见性、重连与释放 |
| `public/terminal-tabs.js` | 标签条 DOM、状态点、关闭/新建按钮、键盘切换、空态与提示 |
| `public/terminal-panel.js` | 面板编排：boot / list / create / 切换 / 关闭 / 重启 / scope 同步 / 迟到响应清理 |
| `public/ui4-pane.css` | 标签条横向滚动、长标题省略、状态色、隐藏视图与焦点环 |

没有新增运行依赖；PTY 库仍是现有 `node-pty@1.1.0`，没有改 pi 本体、session schema
或全局 npm，也没有新增网络行为。

## 二、接口、状态与边界

| 动作 | 语义 |
| --- | --- |
| `create` | 新建一个标签和 PTY；cwd 来自当前 workspace；尺寸可选，缺省 80×24 |
| `start` | P1 兼容：复用当前 workspace 最近运行中的会话；没有则新建 |
| `list` | 只返回当前 workspace 未退休的会话，按 ordinal / 创建时间稳定排序 |
| `read` | 按绝对游标返回缓冲尾部；缓存起点之前的读取标记截断 |
| `input` | 原始字节写入；拒绝 NUL、超过 64 KiB 或非运行状态 |
| `resize` | 校验 20–500 列、5–200 行，只在运行状态写入 PTY |
| `stop` | 结束进程树但保留 `exited` 标签，可原地重启 |
| `close` | 删除标签与缓冲；未知 id 幂等成功；已知 id 先校验 workspace；只树杀目标会话 |

生命周期状态：`creating` → `running` → `closing` → `exited`；spawn 或订阅失败返回
`error`，不留下账本记录。前端同时容忍 P1 的 `stopping` / `failed` 名称。

上限：每工作区 6 个未关闭标签、全局 12 个；已退出但未关闭的标签占额度。输出缓冲
256 KiB，保留尾部并保证不切开 UTF-16 代理对；空闲 30 分钟停止。会话 id 为
`crypto.randomUUID()`，不使用 PID。

安全边界：

- 每个动作都按请求方 workspace 校验；跨工作区返回 `stale_workspace`，未知 id 返回
  `terminal_missing`。Renderer 不能提交 cwd、shell、参数或环境变量。
- 关闭一个标签只影响该会话；切换工作区或焦点不停止任何会话；回到原工作区通过
  `list` 接管同一批 PTY。
- 只有显式 `stop` / `close`、所属会话确认失效、空闲超时或服务关闭才结束进程树；
  scope sweep 只在成功解析出不同 workspace 或确认失效码时退休，暂时性错误保留会话。
- spawn 前剥离 `PI_GUI_TOKEN`、浏览器/运行时桥令牌与 URL；PTY 统一
  `TERM=xterm-256color`、`COLORTERM=truecolor`。
- node-pty 只从源码树、应用资源目录或可执行文件同目录加载，不搜索进程 cwd。
- Windows 用 `taskkill /pid <pid> /T /F`；失败时仅在 PTY 进程仍存活时回退一次
  `pty.kill()`。服务退出时等待真实 exit；Electron 外壳先结束后端进程树再退出。

### 空闲计时语义（2026-11-13 最终审查修复）

原问题：`server/terminal.js` 的 `read()` 在每次成功读取后调用 `touch()`；前端多个 xterm
控制器以约 60ms（可见）或 240ms（隐藏）轮询 `read`。因此即使用户没有任何输入、PTY 也
没有新输出，空闲计时器仍会被持续重置，静默 shell 可能永远不进入 30 分钟超时，关闭面板
后也会一直占着进程和额度。

根因与修复：把空闲活动收敛为服务端唯一的 `lastActivityAt`，由 `noteActivity()` 统一
刷新；`read` / `list` / `resize` / `start` 复用、标签切换和 UI 重挂载都只是观察或布局，
不再续期。计时器仍在服务端，不依赖渲染层计时器。

| 事件 | 是否刷新空闲活动 | 依据 |
| --- | --- | --- |
| 新建会话成功 | 是（初始活动） | 会话从创建时开始计算 |
| 成功写入用户输入 | 是 | 真实键盘输入是唯一明确的用户活动 |
| PTY 产生新输出（`onData` → `append`） | 是 | 输出表明进程仍在工作，包括后台任务和进度点 |
| `read`（含首次重放、历史游标） | 否 | 前端轮询/重挂载不能代表用户或 shell 活动 |
| `list` | 否 | 打开面板或 scope 同步只是观察 |
| `resize` | 否 | 窗口/标签布局变化，不是命令输入；否则窗口调整可无限续期 |
| `start` 复用已有运行会话 | 否 | 与 UI 重挂载同类的观察 |
| `stop` / `close` / 真实退出 / dispose | 清除计时器 | 已结束或正在结束的会话不再产生空闲定时器 |

空闲超时仍为 **30 分钟**（`TERMINAL_LIMITS.idleMs`）。计时器在 `handleExit`、`stopSession`、
`removeSession` 和 `dispose` 中清除并把句柄置空；只有真实 `onExit` 才把状态变成 `exited`。
超时停止失败（kill 未产生 exit）时会话保持 `closing` 并由既有 scope sweep 重试；最终仍保留
可识别的 `exited` 标签，用户可原地重启。每个会话独立计时，一个标签的输入或输出不会刷新
其他标签。

**长期运行但暂时没有输出的任务：** 服务端没有跨平台可信的“前台命令是否仍在运行”信号；
本修复不伪造该信号。保护边界是：任何新输出（包括进度点）都会续期，面板隐藏不会终止，
只有连续 30 分钟完全无输入且无输出才会被视为空闲。完全静默超过 30 分钟的任务会被停止并
保留 `exited` 标签；这是为避免把前端轮询当作活动而保留的有界资源策略，限制已在本记录
和 `work-surfaces.md` 中说明，不通过关闭空闲超时绕过。

P3-A 在此基础上增加了**显式、按终端**的「保持运行」：默认关闭，开启后只豁免空闲计时，
手动停止、关闭标签、workspace 失效、应用退出和 dispose 仍然有效；关闭后重新计算完整
30 分钟。P2 的定向测试数字仍是本记录实际运行的结果，P3 的测试与证据见
[terminal-p3-keep-alive-acceptance.md](terminal-p3-keep-alive-acceptance.md)。

## 三、环境

- Windows 11 Home China 10.0.26200（真实桌面会话）
- Node.js v24.22.1
- Electron 44.4.3
- node-pty 1.1.0，Windows ConPTY
- 所有会写盘的用例使用 `os.tmpdir()` 下的临时项目 / 数据 / 用户目录；没有对用户真实
  项目或会话文件做写操作

## 四、构建

命令：

```bash
npm run build:app -- --rebuild
```

结果：exit 0（空闲计时修复及最终注释后重建）。应用目录 13.1 MB，整包 333.5 MB。已检查打包产物：

- `resources/app/public/terminal-panel.js`、`terminal-session.js`、`terminal-tabs.js` 存在
- `resources/app/node_modules/node-pty/prebuilds/win32-x64/conpty.node` 与
  `conpty/conpty.dll` 存在
- `resources/app/server.cjs` 存在

辅助检查：`node tests/file-size-report.cjs` 11/11、`node tests/ci-doc-scope.cjs` 28/28。

## 五、实际测试结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `node tests/files-terminal.cjs` | **83/83 PASS** | 假 PTY 的服务端契约：三会话、隔离、伪造 id、上限、序号、失败回滚、跨工作区 `start` 清理边界、快速创建/关闭、海量输出、dispose、app 退出；空闲计时短窗口覆盖轮询/输入/输出/历史读取/独立时钟/隐藏面板/自然退出/失败重试/超时后可重启 |
| `node tests/files-terminal-ui.cjs` | **73/73 PASS** | jsdom 面板：多标签、切换不重建、隐藏标签轮询、关闭/重启、关闭无定论时保留标签重试、重启失败/被 scope 列表延迟时不丢原标签、迟到列表不复活已关标签、面板重开、空态/错误、迟到响应、workspace detach/return、list 快照竞争、boot/scope 列表竞争、pending 死区、CSS 规则 |
| `node tests/modules.cjs` | **121/121 PASS** | 服务端模块依赖方向与无环；新增 `terminal-process.js` 属同目录叶子模块 |
| `node tests/smoke.cjs` | **1345/1345 PASS** | 既有 UI / 状态 smoke 回归；未改动该套件 |
| `node tests/app-check.cjs` | **27/27 PASS** | 重建后的 `dist-app` 内嵌后端在独立临时目录启动，不依赖开发 `node_modules` |
| `node tests/terminal-source-check.cjs` | **17/17 PASS** | 真实 `node server.js` + 仓库 node-pty + 真实 ConPTY；三会话并行、输出隔离、workspace A/B 隔离与返回、伪造 id、树杀、真实退出、令牌不泄漏 |
| `node tests/terminal-electron-check.cjs --shots docs/terminal-p2-evidence` | **30/30 PASS** | 真实 Electron 44.4.3：P1 能力 + P2 三标签、并行输出、切换不重建、关一个、面板重开恢复两个、两个会话的进程树在应用退出后按命令行身份消失 |

上述数字是空闲计时修复与复审后、在最终工作区上重跑的结果；均无 skip，均以 exit 0 结束。
Files 套件的既有断言仍保留在同一测试文件中，P2 新增检查见对应测试源。未单独运行
`npm test` 全量链，见第七节。

### 真实 Electron P2 细节

从测试日志与截图核对到：

- 面板启动时自建 1 个终端，再通过界面「新建终端」按钮创建 2 个，共 3 个标签，文字为
  `终端 1` / `终端 2` / `终端 3`；
- 会话 1 执行 `Start-Sleep -Milliseconds 3000` 时，另一会话的标记在 2 秒内返回，
  证明是并行 PTY，不是串行命令；
- 每个 `#term-view-<id>` 只渲染自己的标记；切换标签后 `list` 的 id 与 `createdAt`
  不变，没有新建 PTY；
- 关闭 `终端 2` 后只剩 2 个标签、2 个会话，对应视图消失，其余会话仍 `running`；
- 关闭并重开面板后恢复 2 个标签，缓冲重放成功，没有新建会话；
- 在两个剩余会话中分别启动带唯一命令行标记的 Node 子进程；关闭应用后两组标记都为空，
  PowerShell 按完整身份（CreationDate + CommandLine）确认消失；
- 日志中没有 ConPTY helper 崩溃栈。

截图（真实 Electron 窗口，CDP 页面捕获，1980×1323）：

- [terminal-p2-multi-tabs.png](terminal-p2-evidence/terminal-p2-multi-tabs.png)：3 个标签、活动态、状态点与「新建终端」按钮；207 233 字节
- [terminal-p2-after-close.png](terminal-p2-evidence/terminal-p2-after-close.png)：关闭一个标签后剩 2 个；86 295 字节

### 独立复审与修复记录

按 [REVIEW.md](../REVIEW.md) 的高风险变更要求，功能与安全分别由独立上下文的 Agent 复审；
下列问题均先修复并补回归，再复跑受影响套件。

| 轮次 | 结论 | 发现与处置 |
| --- | --- | --- |
| 功能第 1 轮 | 0 Blocker / 2 Important | 迟到 list 将新建标签移除（活 PTY 被藏且占额度）；boot 与 scope-sync 列表响应可互相覆盖、scope 事件被丢弃。修复 token / 快照边界并补 UI 用例 |
| 功能第 2 轮 | 0 Blocker / 1 Important | boot 列表压过 scope 列表时 `scopeSyncPending` 无人清除，New/Restart 永久禁用。在获胜的 boot 路径清除并补用例 |
| 功能第 3 轮 | 0 Blocker / 0 Important / 1 Nit | 重启时并发 scope-sync 会让 `createTab` 返回 null，旧标签已被删、替换却没建。改为先建新标签再删旧标签；延迟创建的旧标签在这次 scope 列表到达时也保留，补失败重启、延迟重启与迟到列表用例 |
| 安全复审 | 0 Blocker / 0 Important / 1 Nit / 1 既有 | 迟到同工作区列表可能把已关闭标签重新挂回；用 `closedIds` 过滤已确认关闭的 id 并补用例。既有风险：Windows `taskkill /T` 以 PID 为句柄，PID 复用窗口列入 P3 跟进 |
| Nit 定向复核 | 通过 | 功能侧确认保留的延迟重启标签不对应任何活 PTY、普通关闭不会遗留；安全侧确认 `closedIds` 不隐藏活会话、不跨工作区。UI 73/73 |
| 空闲修复复审 | 0 Blocker / 1 Important / 2 Nit | 独立复审确认轮询、读取、切换、重挂载均不再刷新空闲，计时器清理与多会话独立无问题。Important：短 `idleMs` 用例的「仍运行」窗口余量偏小，CI 事件循环停顿可能假红；已把 `idleMs` 提到 400ms 并同比放大等待，重复运行 83/83。Nit：验收文档仍写 82/82，已改 83/83；`touch()` 的剩余窗口计算加注释说明。 |

功能复审第 3 轮结论为「无 Blocker / 无 Important」，安全复审结论为「有条件通过」；
两处 Nit 修复后均做了定向复核并通过。两者都明确 AI 审查意见不代替用户审批，且完整
`npm test` 完整结果出来前不能记为 canonical 通过。

## 六、P2 需求覆盖

| 要求 | 证据 |
| --- | --- |
| 新建多个终端、并行运行 | source 17/17、Electron 30/30、fake 83/83 |
| 独立 session id / 缓冲 / 输入输出 | fake 三会话隔离、source 并行与输出隔离、UI 每视图只收到自己的输出 |
| 切换标签不重建 PTY、保留状态 | UI「switching tabs only toggles visibility」、Electron `createdAt` 不变 |
| 关闭指定终端、幂等关闭、只结束一个 | fake/UI/source/Electron 均有对应断言 |
| 启动失败清理、shell 退出同步、重复关闭 | fake 失败回滚/真实 exit/幂等 close；UI exited/restart |
| 关闭面板重开保留状态 | P1 Electron + P2 面板重开 2 标签重放 |
| 应用退出清理全部 PTY | fake dispose、source stop/exit、Electron 两个 marker 树清理 |
| 工作区隔离、返回原工作区可用、关闭 A 不影响 B | source workspace A/B、fake 伪造 id、UI detach/return |
| 快速创建/关闭、海量输出、运行中切 workspace/关应用 | fake + UI + Electron |
| 标签 UI、活动态、空态/错误态、横向滚动、长标题 | UI 73/73、Electron 截图 |
| 不泄漏 `PI_GUI_TOKEN`、会话 id 非 PID、服务端归属校验 | source 令牌断言、fake UUID/伪造 id、security.md |
| 空闲计时不被轮询/读取/切换刷新，输入和新输出独立续期 | fake 83/83 的短 `idleMs` 用例；`work-surfaces.md` 记录 30 分钟窗口与静默任务限制 |

## 七、未验证与剩余风险

- **完整 `npm test` 尚未运行。** 本记录只覆盖终端相关定向套件与真实运行时；本 PR
  的完整 CI 返回前不能记为 canonical 全量通过，最终以该次 CI 结果为准。
- 只在 Windows 11 + ConPTY 验证；POSIX 分支有单元覆盖（绝对 `$SHELL` / `/bin/sh`），
  没有在 macOS/Linux 实机跑真实 PTY。
- 只验证 Electron 44.4.3 与 Node 24.22.1；没有验证其它 Electron/Node ABI 组合。
- 打包验证覆盖 `dist-app` 目录和 node-pty sidecar；没有在 P2 重跑安装程序 / SEA
  发布链。
- 截图是 Chromium 页面捕获，不是 OS 级屏幕录制；能证明真实 Electron 渲染结果，
  但不能证明窗口装饰或系统缩放。
- 输出缓冲超过 256 KiB 时只能保留尾部；alternate-screen 的完整快照不在本期范围。
- 应用重启不持久化 session id，这是设计选择；重启后旧终端不会被恢复。
- `taskkill /T` 只能清理当时仍在进程树中的后代；若子进程先自行脱离父链，P2 不声称
  能追踪到它。Windows 的树杀仍以 PID 为句柄：若 shell 的 PID 在 exit 丢失后被系统
  复用，理论上可能终止无关进程树。这是 P1 既有的窄窗口风险，P2 未改变，建议后续按
  创建时间 / 命令行身份收紧。P3-B 的专项审计与候选方案见
  [terminal-p3-process-termination-design.md](terminal-p3-process-termination-design.md)；
  其中明确说明身份校验只能缩小 TOCTOU，不能消除 PID 复用，P3-A 未修改终止逻辑。
- 关闭未知 id 幂等成功是产品语义；已知跨区 id 仍返回 `stale_workspace`，但 id 是随机
  UUID，不能靠响应差异枚举。已知 id 仍校验归属。
- 若 kill 永久卡住，`close` 会把会话标为 retired，`list` 不再显示但会话仍占额度；
  sweep 每 5 秒重试，当前没有“强制释放额度”的入口。这是为避免把活进程当已死而保留的
  边界，需重启应用才能彻底清理。

## 八、结论与授权

- **开发完成：是。** P2-A 多终端标签、P2-B 生命周期、P2-C 工作区隔离与 P2-D 标签 UI
  已实现；文档、打包和定向运行时验证已完成。
- **代码验收：待完整 `npm test` 与用户确认。** 独立功能复审与安全复审已完成并处置发现；
  完整 `npm test` 由本 PR 的 CI 提供，结果出来前保持「待验证」，不能用定向套件或 AI
  复审意见代替用户审批。
- **合并许可：未授权。** 本分支提交、推送并创建 PR，不自行合并。
- **发布许可：未授权。** 未打 tag、未推送发布 tag、未执行正式发布。

## 九、回滚

本变更没有数据迁移、配置格式变更或用户文件写入。回滚时撤销 `feat/terminal-pty-p2`
的提交（若后续创建 PR 则关闭 PR）即可；已有后端进程在应用退出时按现有生命周期清理。终端会话本来
就不跨应用重启持久化，因此回滚不遗留需要迁移的会话数据。

## 十、证据文件

- [多标签截图](terminal-p2-evidence/terminal-p2-multi-tabs.png)
- [关闭一个标签后的截图](terminal-p2-evidence/terminal-p2-after-close.png)
- [工作区与生命周期说明](work-surfaces.md)
- [终端安全边界](security.md#项目终端)
- [测试分层](testing.md)
