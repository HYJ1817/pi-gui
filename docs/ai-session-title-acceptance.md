# AI 会话标题验收材料

- 目标与交付：实现 AI 自动 / 手动会话标题。首条有效回复完成后后台生成标题，
  不阻塞聊天、不进入主会话上下文；标题来源优先级为
  「用户确认的覆盖 / Pi 原生手动名 > 自动标题 > 首条用户消息 > 默认」。
  覆盖经典 Pi 与独立 Runtime、后台会话、并发隔离、设置开关、手动入口、
  现有侧栏 / 顶栏 / 搜索的就地同步。未交付：模型供应商选择器（当前 Pi 没有
  可配置的独立标题模型，避免假入口）、历史会话批量补标题、真实模型 E2E。
- 身份：before HEAD `1bb6bce87e47d8d9ccb507c2b82d1fc1cb8f96d1`；
  功能提交 `104b6382c76e420431c947f7ce0b69dd4b7ff89f`，测试 / 文档提交为
  本报告所在提交，可用 `git log -1 --format=%H -- docs/ai-session-title-acceptance.md`
  解析；分支 `feat/ai-session-title` 已推送。本文证据覆盖提交前工作区 diff；
  提交后的 canonical / CI 另行记录，不用旧运行代替。
- 证据范围：`1bb6bce8` 之上的功能 diff（`git diff --name-status 1bb6bce8`）。
- 修改文件：
  - 后端：`server/session-title-context.js`（有界上下文与输出校验）、
    `server/session-title-store.js`（自有元数据、优先级、原子写）、
    `server/session-title-sdk.js`（Pi SDK 独立 worker 调用）、
    `server/session-titles.js`（触发、队列、归属、迟到丢弃、HTTP）；
    `server.js` / `server/router.js`（接线，应用级路由）；
    `server/sessions.js`（列表同步标题与删除清理）；
    `server/runtime-registry.js`（Runtime 标题投影与 settled 观察）。
  - 前端：`public/session-titles.js`（设置缓存、SSE 就地更新、手动入口）、
    `public/appearance.js`（「常规」页会话标题卡）、`public/sessions.js`
    （经典会话菜单项与行更新）、`public/runtime-nav.js`（Runtime 行菜单，
    复用同一生成服务）、`public/app.js`、`public/rpc.js`、`public/api.js`、
    `public/runtime-*.js`、`public/session-search.js`、
    `public/ui/action-menu.js`、`public/styles.css`。
  - 测试与夹具：`tests/session-title-{store,context,service,sdk,ui}.cjs`、
    `tests/session-title-visual.cjs`、`tests/runtime-registry.cjs`、
    `tests/runtime-nav.cjs`、`tests/smoke.cjs`、`tests/visual-harness.cjs`、
    `tests/cdp-shot.cjs`、`package.json`（canonical `test` 链与视觉脚本入口）。
  - 文档：`docs/sessions.md`、`docs/provider-auth.md`、
    `docs/architecture.md`、`docs/README.md` 与本文。
- 行为与安全边界：
  - 只写 `<DATA_DIR>/session-titles.json` 与
    `<DATA_DIR>/session-title-settings.json`，**从不写 Pi 的 JSONL**；
    Pi 的 `session_info` 仍由 Pi 自己维护。
  - 独立调用复用 Pi 包公开 `ModelRuntime`、同一 `auth.json` / `models.json`；
    不登录、不新增 API Key、不复制供应商客户端。worker 剥离
    `PI_GUI_TOKEN`，只回传标题文本、`stopReason` 与三个数字 usage；
    SDK 错误原文、stdout/stderr、凭据、完整回复不跨线程。
  - 自动生成只认 `success + hasVisibleOutput + 非 aborted`；首条回复失败 /
    为空 / 中断时等下一次有效回复。每个会话最多一次自动生成，不回填历史。
  - 生成前捕获会话文件身份、header id 与原生名；应用前重读核对，迟到结果
    在手动改名 / 文件变化 / 开关关闭后丢弃。手动标题先确认再替换。
  - 不改 Composer、思考动画、并行机制、Pi RPC 生命周期或全局按钮设计。
- 风险：中级（后台模型调用、元数据写入、跨会话 UI 更新、设置开关）；
  未触及 Pi 本体写入、凭据输出或权限提升。

| 证据层 | 命令/场景与代码状态 | 环境、退出码与实际结果 | 日志/截图/run |
| --- | --- | --- | --- |
| 作者自测 / 本地定向 | `npm run test:session-title-ai`（工作区 diff，Node 24 / Windows 11） | 5 套件 **200/200**，exit 0：store 39、context 33、service 40、sdk 34、ui 54 | 终端输出；套件源文件 |
| 作者自测 / 受影响回归 | `tests/runtime-registry.cjs`、`tests/runtime-nav.cjs`、`tests/modules.cjs`、`tests/sessions.cjs`、`tests/session-search.cjs`、`tests/sidebar-menu.cjs`、`tests/settings-acceptance.cjs`、`tests/runtime-conversation.cjs`、`tests/smoke.cjs` | 全部 exit 0：37/37、41/41、121/121、91、72/72、37/37、19、110/110、1335/1335 | 终端输出 |
| 本地完整 canonical | 未运行。按本轮范围只跑定向与受影响套件；完整 `npm test` 交给 PR CI。 | 未验证（未运行，按测试政策由 PR CI 完成） | 待 PR CI run |
| 独立审查 | 具备独立上下文的 Agent 复审功能 diff（含未跟踪文件） | 报告 1 blocker / 1 high / 1 medium / 3 low；blocker、high、medium 与两条 low 已修复并补回归，见「独立审查处置」 | 审查记录随交付消息 |
| Electron 实测 | `npm run test:session-title:visual`（源码版 + 离线 harness） | **43/43**，exit 0；18 张截图；4 组实际 CSS 视口：1320×820 dark/light、700×600 light/dark，DPR=1；经典与 Runtime 行菜单均覆盖；0 条 renderer console error | `.shots/session-title/`（`results.json`、18 PNG） |
| 真实浏览器视觉 | `node tests/cdp-shot.cjs --url=http://127.0.0.1:7789/ --tag=hv` | 会话菜单四档宽度截图全部通过结构判据（`UX-MENU-04`、`UX-SESSION-MENU-*`）；脚本其余既有的顶栏配色 / 机型判据仍报告失败，末尾还有一个被截断的 TypeError，均未作为本功能通过依据 | `.shots/hv-UX-MENU-04-session-menu-open.png`、`.shots/hv-UX-SESSION-MENU-*.png` |
| 真实模型 E2E | 未运行。离线优先政策下不擅自调用模型；本轮没有可合法使用的隔离凭据。 | 未验证（未运行，原因：离线政策与无隔离凭据） | — |
| PR CI | 未运行（分支已推送，未创建 PR；用户未要求创建） | 未验证 | — |

- 失败与修复历史（均为开发期，已重跑通过）：
  1. 服务层测试最初只给夹具 `id`，与产品 `resolveClassic` 要求的
     `{ file, sessionId, cwd }` 不符；按真实形状补齐原生 `sessionId` 后通过。
  2. 并发测试用 `gates.length >= 1` 等待第三个任务，残留 gate 让条件假真，
     进程静默提前退出；改为等待队列真正产生新 gate 后通过。
  3. 自动 Runtime 标题的 `publishTitle` 漏传 `conversationId`，前端按
     `conversationId` 找不到行；补上后 UI 事件链通过。
  4. 菜单新增「AI 生成标题」后，`smoke.cjs` 三处旧的三项菜单断言与
     降级断言失败；更新为四项并区分 `sessionNaming` 只禁用改名 / 归档 /
     删除，重跑 1335/1335。
  5. 视觉脚本首次把设置详情的 Escape 当成离开设置区，菜单锚定在隐藏行上
     且回焦失败；改为 Escape 后点「返回应用」，重跑 43/43。
  6. 独立审查发现 Runtime `settled` 后的 `refreshSession` rejection 未被消费
     （可导致进程级 unhandledRejection），以及自动链路 `recordAttempt`
     写失败同样未消费；两处均已捕获并补回归。审查同时指出 Runtime 手动标题
     只有服务端与测试、没有产品入口，已补 Runtime 行三点菜单与 Electron 截图；
     坏文件「可解析但形状错误」未备份、容量截断未按 `updatedAt` 保留新条目，
     一并修正并补 store 测试。
  7. 独立审查处置时又发现一条竞态：会话 A 的 `settled` 与读取 `get_state`
     之间切到会话 B，旧逻辑会按「当前主会话」给 B 补标题。现在在 `settled`
     时捕获 `primaryAtSettle`，与 A 不一致就放弃；补服务层用例 2h 覆盖
     「A settled 后、get_state 返回前切到 B」。
- 独立审查处置：报告 1 个 blocker（settled refresh 的未处理 rejection）、
  1 个 high（recordAttempt 写失败产生未处理 rejection）、1 个 medium
  （Runtime 手动入口不可达）、3 个 low（文档过度声明、坏形状备份、容量排序）。
  六项均已修复并由上述测试覆盖；另采纳测试质量建议，新增真实 Worker 源码
  执行测试。处置过程中自查出的 settle/get_state 切换竞态也已修复并补用例 2h。
  没有未处置的阻断项。审查者建议的真实模型 E2E 仍受离线政策限制，未运行。
- 限制与残余风险：仅实测 Windows 11 + Electron 44.4.3 源码版；没有打包产物
  内的真实模型调用证据；OAuth / 订阅 / 自定义 provider 的标题调用依赖 Pi
  的认证解析，未在真实账户上逐一实测；标题生成会消耗少量模型用量，
  设置页已说明；`cdp-shot` 的既有 harness 判据不全部通过，不能据此宣称整站
  视觉回归通过。
- 回滚：回退本功能提交；删除 `<DATA_DIR>/session-titles.json` 与
  `session-title-settings.json` 可清除标题元数据与开关，Pi 会话文件无需恢复
  （本功能从未写入）。不影响其他工作区改动。
- 待用户决定：是否运行真实模型 E2E、是否合并、是否发版。当前均未授权。
- 结论：开发完成，功能与验收材料已提交并推送；独立审查发现均已处置；
  完整 canonical / PR CI 未运行；合并未授权；发布未授权。
