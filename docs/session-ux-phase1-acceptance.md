# 会话过程 UI/UX 第一阶段验收报告

> 分支：`feat/session-ux-phase-1`（未合并、未推送；推送在本报告提交后执行）  
> 基线：`c43fc3f21ae72a8948bb9b8b13dc01d304205c88`（v0.34.0 合并后）  
> 审计文档：[session-ux-comparison-audit.md](session-ux-comparison-audit.md)  
> 本阶段只实施审计文档中的阶段 1；未进入阶段 2。

## 1. 结论

- **开发完成，定向验收通过。** 本阶段实现：运行中工具组保持展开、工具组状态可读性、轮次终态、单条消息 Token 摘要、自动重试错误摘要、`incomplete` 状态色。
- **范围控制。** 未修改思考动画文件及调用点，未新增整轮父折叠，未重构 Runtime 时间线/多会话机制，未改变工具数据契约，未新增依赖，未复制 PI-Desktop 代码。
- **验证等级。** 完成定向行为测试、真实 Electron/Chromium 视觉验收、真实 Chrome 视觉自检与打包构建；**未运行完整 `npm test`**，未手动操作打包后的应用 UI，未做真实 pi 的新状态端到端。
- **风险等级：中。** 变更涉及会话渲染与状态展示，但不涉及凭据、执行权限、文件写入、安装更新或发布链；无数据迁移，回滚为代码回退。

## 2. 实施前基线核对

| 项 | 结果 |
| --- | --- |
| 当前 `main` | `d4ec941`（审计文档提交），父提交为 `c43fc3f` |
| `origin/main` | `c43fc3f`，没有领先提交 |
| `git diff c43fc3f..d4ec941` | 只有 `docs/session-ux-comparison-audit.md`，业务源码无变化 |
| 受影响模块工作区 | 修改前无未提交改动；只有既有的 `conpty.*` / `spike/` / `*.obj` 未跟踪构建残留 |
| 其它阶段已合并实现 | 未发现；本分支从审计提交直接切出，未覆盖其它分支 |

审计文档中先修正了实施前复核提出的 5 个问题（提交 `2157e2f`）：

1. **O-01 优先级**：用户显式展开/折叠 > 活跃组默认展开 > 已结束默认折叠；不再“运行中强制展开”覆盖用户折叠。
2. **O-02 证据**：轮次 `failed` 只接受 assistant 的轮次级错误；工具 `isError` 只计入工具失败数。
3. **O-07 测量时机**：在写入 `pre.textContent` 之前记录是否贴底，避免追加内容后误判。
4. **O-05 边界**：阶段 2 只做渲染进程内存书签；跨刷新持久化单列后续决策，不写 `localStorage`/会话文件。
5. **基线确认**：见上表。

## 3. 实施内容

| 工作项 | 主要文件 | 实际行为 |
| --- | --- | --- |
| 运行时工具组折叠 | [tool-view.js](../public/tool-view.js)、[tools.js](../public/tools.js) | 显式选择优先；无显式选择时活跃组展开、全部结束后折叠；焦点/文本选择/已展开行保护 |
| 工具组状态可读性 | [tool-view.js](../public/tool-view.js)、[styles.css](../public/styles.css) | 状态摘要增加“等待写入”；有真实起止时显示组耗时（Classic 运行中每次绘制刷新）；不伪造缺失值 |
| 轮次终态 | 新增 [turn-outcome.js](../public/turn-outcome.js)；[messages.js](../public/messages.js)、[runtime-conversation.js](../public/runtime-conversation.js) | Classic 实时/历史与 Runtime 时间线共用同一模型与视图；只显示状态、真实时长、工具数、工具失败/未完成数 |
| 轮次失败证据 | [messages.js](../public/messages.js)、[runtime-conversation.js](../public/runtime-conversation.js) | 仅 assistant `stopReason:error`/非空 `errorMessage`、或 Runtime `generation_failed`（最后一轮）判轮次失败；工具错误只计数 |
| Token 元信息 | [message-meta.js](../public/message-meta.js)、[styles.css](../public/styles.css) | 默认一行“Token 总量 · 思考”，完整输入/输出/缓存/思考/总计放入原生 `<details>`；0 保留、缺失不补 |
| 自动重试摘要 | [app.js](../public/app.js)、[messages.js](../public/messages.js)、[styles.css](../public/styles.css) | 撤旧错误块前抓取已显示的安全错误文本；重试期间显示可展开摘要；结束/成功/最终失败时移除；最终失败仍走原错误块 |
| `incomplete` 状态色 | [styles.css](../public/styles.css) | `incomplete` 的 `.tl-status` 改用 `--warn`，`error` 继续用 `--err` |
| 工具输出跟随 | [tool-view.js](../public/tool-view.js) | 运行中且详情展开、写入前距底 <40px 时跟随输出；用户上滚不拉回 |
| Runtime 换代隔离 | [runtime-conversation.js](../public/runtime-conversation.js) | 终态节点按轮次缓存；runtime 身份或历史对象变化时清空旧终态，避免 block id 复用误挂 |

**明确未改动**：

- [thinking-dots.js](../public/thinking-dots.js)、[thinking-dots.css](../public/thinking-dots.css)、[scroll-button.js](../public/scroll-button.js) 零 diff。
- `messages.js` 的 `showWorking` / `hideWorking` / `syncToolWorking` / `setStreaming` 显示时序未改；只在 `onSettled` 后追加终态、在重试路径增加摘要、在 `clearThread` 增加清理。
- 未修改 `runtime-store.js`、`runtime-timeline.js`、`server/`、工具数据模型或会话文件格式。
- 未新增依赖；`package.json` 只增加测试脚本与 `test` 链入口。

## 4. 定向测试结果

命令在仓库根目录执行；以下为实际输出数字，不是沿用历史记录。

**环境说明**：本机 `node_modules` 初始为空；用 `npm ci --offline --ignore-scripts` 从本地 npm 缓存恢复了锁定的开发依赖，未修改 `package-lock.json` 或依赖清单。Electron 运行时由 `electron` 包写入 `node_modules`（构建与真实渲染取证需要），不进入提交。真实视觉套件使用 Electron 44.4.3 / Chromium 152.0.7977.130。

| 命令 | 结果 | 覆盖 |
| --- | --- | --- |
| `npm run test:session-ux-phase1` | **66/66** | 轮次终态模型/实时/历史、工具组折叠优先级、组耗时、等待写入、Token 摘要/明细、重试摘要、Runtime 终态与换代隔离、`incomplete` CSS 契约 |
| `node tests/ui2-classic.cjs` | **55/55** | Classic 消息、Thinking、工具组、历史重建、错误/重试、Token 元信息 |
| `node tests/agent-execution-ui.cjs` | **221/221** | 计划、Runtime 时间线、工具组、历史顺序、回到底部、CSS 契约 |
| `node tests/thinking-dots.cjs` | **90/90** | 思考动画 CSS 时间轴、相位切换、工具起停、会话切换、reduced-motion |
| `node tests/runtime-conversation.cjs` | **106/106** | Runtime 历史/实时、工具摘要、会话隔离、只读历史动作 |
| `node tests/ui2-runtime-display.cjs` | **83/83** | Runtime thinking/usage 投影与生命周期 |
| `node tests/modules.cjs` | **121/121** | 模块依赖方向与循环依赖 |
| `node tests/smoke.cjs` | **1345/1345** | 全前端冒烟，含错误块/重试/历史/多会话 |
| `node tests/file-size-report.cjs` | **11/11** | 文件规模报告工具自身契约 |
| `node tests/agent-execution-visual.cjs` | **28/28** | 真实 Electron 44.4.3 / Chromium 152.0.7977.130；阶段 1 新增 5 条断言 |
| `node tests/ui2-visual.cjs` | **57/57** | 真实 Chrome CDP：阅读列、气泡、折叠、700/900/1200/1536px、无横向溢出 |

**真实 Electron 视觉套件新增断言**：

- Classic 轮次终态显示真实工具失败数，且工具失败不把整轮判成 failed。
- Token 默认摘要只显示总量/思考，完整 5 个字段默认收起且可达。
- 工具组保留真实耗时与失败/成功混合状态。
- 重试摘要保留“第 1/3 次重试”、人话标题与原始 429 文本。
- Runtime 终态不把工具失败升级为轮次失败。

**思考动画回归**：

- `git diff --exit-code -- public/thinking-dots.js public/thinking-dots.css public/scroll-button.js`：通过（零 diff）。
- `node tests/thinking-dots.cjs`：90/90。
- 真实 Electron 套件中“移开后恢复四点动画”“运行中悬停切换为下箭头，尺寸不跳”等断言通过。

**前后对照取证**：

- 基线 `c43fc3f` 的既有视觉套件：23/23（仅用于生成 before 截图，不是当前分支的测试结果）。
- 当前分支对照截图脚本：11 张 after；基线 10 张 before。见第 5 节。

## 5. 真实截图与前后对比

证据目录：[docs/ui/session-ux-phase1-evidence](ui/session-ux-phase1-evidence/README.md)（21 张 PNG + 2 份 JSON）。

| 场景 | 修改前（基线 `c43fc3f`） | 修改后（本分支） | 观察 |
| --- | --- | --- | --- |
| 工具组默认状态（两个已结束 + 一个运行中） | [before-01-group-default-dark.png](ui/session-ux-phase1-evidence/before-01-group-default-dark.png) | [after-01-group-default-dark.png](ui/session-ux-phase1-evidence/after-01-group-default-dark.png) | 基线只剩“工具调用 · 3 次”与状态汇总；当前展开真实三行，运行中/失败/成功与组耗时可见 |
| 同一场景浅色 | [before-02-group-default-light.png](ui/session-ux-phase1-evidence/before-02-group-default-light.png) | [after-02-group-default-light.png](ui/session-ux-phase1-evidence/after-02-group-default-light.png) | 深浅主题均按语义 Token 呈现 |
| 单条消息 Token | [before-04-token-default-dark.png](ui/session-ux-phase1-evidence/before-04-token-default-dark.png) | [after-04-token-default-dark.png](ui/session-ux-phase1-evidence/after-04-token-default-dark.png) | 基线 5 项平铺成一行；当前“Token 1,540 · 思考 120”+“明细”，完整字段在展开区 |
| Token 明细展开 | 无（基线无此交互） | [after-05-token-expanded-dark.png](ui/session-ux-phase1-evidence/after-05-token-expanded-dark.png) | 输入/输出/缓存/思考/总计仍可达 |
| 轮次终态 | [before-07-turn-end-dark.png](ui/session-ux-phase1-evidence/before-07-turn-end-dark.png) | [after-07-turn-end-dark.png](ui/session-ux-phase1-evidence/after-07-turn-end-dark.png) | 基线没有轮次结束行；当前显示“已完成 · 0.2s · 2 次工具 · 1 次工具失败” |
| 自动重试 | [before-10-after-retry-dark.png](ui/session-ux-phase1-evidence/before-10-after-retry-dark.png) | [after-10-after-retry-dark.png](ui/session-ux-phase1-evidence/after-10-after-retry-dark.png) | 基线撤掉错误块后只剩用户消息；当前保留“触发限流 · 第 1/3 次重试…”与可展开原始错误 |
| 浅色重试 | [before-11-after-retry-light.png](ui/session-ux-phase1-evidence/before-11-after-retry-light.png) | [after-11-after-retry-light.png](ui/session-ux-phase1-evidence/after-11-after-retry-light.png) | warning 表面/文字在浅色下可读 |

**观察结论**：

- 运行中工具组从“只有一行汇总”变为“汇总 + 可见执行行”，这是本阶段信息密度/可读性的主要变化；用户仍可一键折叠，显式选择不会被后续工具覆盖。
- Token 从一条长平铺行变为“摘要 + 按需明细”，默认宽度明显缩短；完整字段与 0/缺失语义未丢。
- 轮次终态把“这一轮怎么结束”从隐含状态变成一行明确记录；工具失败单独计数，不改变“已完成”。
- 重试摘要保住了原先会消失的失败原因；最终错误仍由原错误块承担，没有出现重复错误。

## 6. 构建与产物

- 执行：`npm run build:app -- --rebuild`。
- 结果：成功。
  - `build/Pi GUI.exe`：100.2 MB（Node SEA）。
  - `dist-app/Pi GUI-win32-x64/Pi GUI.exe`：234.9 MB；整包 333.5 MB。
  - 打包目录包含新文件 `resources/app/public/turn-outcome.js`，`messages.js`/`runtime-conversation.js` 的引用已在包内。
- **未手动操作打包后的应用 UI**；本报告的真实渲染证据来自源码 `public/` + 离线 harness 的 Electron/Chromium。打包层只证明构建成功与文件进入产物，不证明打包应用内交互。
- 构建产物在 `.gitignore` 范围内，不进入提交。

## 7. 未验证项

| 项 | 原因 | 后续 |
| --- | --- | --- |
| 完整 `npm test` / canonical 全量证明 | 本阶段只跑与修改范围直接相关的定向套件；套件数量多、耗时长 | 功能稳定后按 [测试政策](testing.md#测试执行政策) 跑完整 `npm test` 或由用户选择 PR CI；结果出来前标“待验证” |
| 真实 pi + 真实模型的阶段 1 状态 | 未启动真 pi；新状态用离线事件夹具和真实前端模块验证 | 需要时用真实会话做只读/临时 fixture 验证，不写用户数据 |
| 打包后应用 UI | 只完成构建，未启动 `dist-app` 逐项点测 | 发布前按 `docs/development.md` 做打包态烟测 |
| 屏幕阅读器对 `role=status` 的播报 | 未用真实读屏 | 阶段 3 可访问性收口时验证；本阶段没有给流式容器加 `aria-live` |
| 跨刷新阅读位置持久化 | 阶段 2 只在内存；本阶段未做 | 阶段 2 单独设计，不写会话文件/`localStorage` |
| Runtime 历史中“内容为空的失败轮次”终态 | 历史 timeline 没有对应 block；live 用 `generation_failed` 兜底 | 后续可在 history 投影增加显式状态块，需另做契约审查 |
| 700px 阅读列内部裁切 | 基线已有（`before-03` 同样存在），不是本阶段引入 | 外壳/阅读列问题，留待布局专项；本阶段未改外壳 |
| 组耗时在 Runtime live 的显示 | Runtime 工具 block 没有开始时间，未伪造；Classic/历史有真实起止时显示 | 阶段 3 如需 Runtime 组耗时，需在视图层记录观察时间或扩展投影，先做契约审查 |

## 8. 残余风险

- **轮次边界**：Classic 以真实 `agent_start`（上一轮已 settled）开始、`agent_settled` 结束；历史按用户消息/stopReason/时间戳派生。异常事件顺序（缺 settled、崩溃、重放）下可能少显示终态，而不伪造完成。
- **重试 DOM 生命周期**：`auto_retry_start` 撤旧错误块、`auto_retry_end` 清摘要、最终 `message_end` 显示错误块；已由 smoke 与阶段 1 测试覆盖，但真实 pi 的极端重试顺序仍需实机确认。
- **Runtime 终态缓存**：`settledTurns` 按 block id 缓存，已加 runtime 身份与历史对象变化清理；若未来 timeline 复用 id 的方式变化，需要重新核对。
- **组耗时口径**：Classic 用组内最早开始/最晚结束（并行重叠不重复计时），Runtime live 暂不显示；历史耗时是 assistant→toolResult 时间戳估算，不是工具内部精确计时。
- **Token 明细可访问性**：原生 `<details>` 在 Electron/Chromium 已验证；未覆盖其它浏览器（产品是 Electron，风险低）。
- **视觉窄窗**：700px 的既有右侧裁切未修复，阶段 1 截图保留该基线状态，未把它误报为回归。
- **文件规模**：[runtime-conversation.js](../public/runtime-conversation.js) 从 1090 行增至 1189 行，超过 1000 行软阈值。集中原因是时钟线投影/节点缓存/会话视图态必须在同一闭包内共享；本阶段只加视图派生的终态节点与清理，不改 store/timeline 契约。拆分会把“哪些节点属于哪个会话/哪一代 runtime”的判据分散，风险高于当前集中实现；后续若继续增长，建议先把 timeline 投影抽成独立纯模块并补契约测试。

## 9. 回滚方式

- 回退本阶段业务提交 `a34b075` 与测试提交 `6e089d0`，再回退证据/报告提交；无数据迁移、无会话文件格式变化、无服务端改动。
- 若只回退业务行为，保留测试会红；应成对回退。
- 构建产物可用回退后的源码重新执行 `npm run build:app -- --rebuild` 重建。
- 本阶段没有修改 pi 本体、全局 npm、仓库设置或发布配置。

## 10. 提交记录

| 提交 | 内容 |
| --- | --- |
| `2157e2f` | 审计文档：修正 O-01/O-02/O-05/O-07 与状态模型验收口径 |
| `a34b075` | 阶段 1 业务逻辑（9 个文件） |
| `6e089d0` | 阶段 1 测试、视觉取证脚本与 `npm test` 入口（6 个文件） |
| 本报告与证据 | 见本分支最后一次文档提交 |

分支：`feat/session-ux-phase-1`。未合并；本报告提交后按用户要求推送，不自动进入阶段 2。
