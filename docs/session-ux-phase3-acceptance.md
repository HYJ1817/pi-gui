# 会话过程 UI/UX P3 实施与验收

验收日期为 2026-11-16（Asia/Shanghai）。目标分支为 `feat/session-ux-phase-3`，基线为已合并 P2 的
`origin/main` `b3739ed5d105e56f1569a7962d0ba59dcefa485b`（Merge PR #89）。本轮覆盖
P3-A 至 P3-G：工具组信息收尾、Token 摘要统一、Classic/Runtime 视觉统一、Runtime 历史真实用量、
任务列表折叠摘要、可访问性与长会话性能测量。审计项对应 O-04、O-09、O-10、O-11、O-12。

本轮不合并、不发版、不进入 P4；pi 本体、用户真实会话和全局 npm 均未改动。所有会话、工具、
计划与 usage 证据都来自固定 fixture，未读取用户真实项目做写操作。

## 结论

- P3-A 的组头计数、并行耗时、缺失时间戳、结束停表与用户折叠优先已由新增测试验证；`tool-view.js`
  与 `tools.js` 本轮没有行为改动，只补了窄窗口下的紧凑排版。
- P3-B、P3-D 已落地：Classic、Runtime 实时、Runtime 历史共用一套 usage 字段名、数字格式与
  “摘要 + 明细”语义；历史只在原生记录确有 usage 时显示，旧记录不补 0。
- 验收整改补齐两处边界：`cloneBlock` 按 block 契约逐字段复制，非法顶层字段与工具原始载荷不再
  进入 store；plan-only assistant 消息的真实 usage 可挂在 plan block 并只显示一次。P3 定向
  测试增至 113/113。
- P3-C 已用真实 Chromium 计算样式确认：Runtime 用户消息由“外层卡片 + 内层气泡”改为单层右对齐
  气泡，用户角色标签视觉隐藏但保留在无障碍树，助手标签保留；工具组、计划卡与消息元信息与
  Classic 对齐。
- P3-E、P3-F 已完成：折叠任务列表显示真实完成数与当前任务短标题；两个输出容器使用 `role=log`
  且不逐 token 播报；键盘、焦点环与 reduced-motion 均有真实浏览器测量。
- P3-G 只做测量，没有引入虚拟化或 `content-visibility`。长会话首次渲染与切换仍会产生 Classic
  的同步长任务，数据与后续建议见下文。
- 定向测试全部通过，真实 Chromium 视觉/几何/可访问性脚本退出 0，P2 回归 13/13，应用产物已重建。
- 真实读屏软件未执行；本轮只验证了 Chromium 可访问性树、键盘与焦点。此项明确标为未验证。

## 修改文件

| 文件 | 内容 |
| --- | --- |
| `public/message-meta.js` | 共用 usage 字段、摘要/明细、0 与缺失语义、Pi 成本原值、流式提示 |
| `public/runtime-display.js` | `usageText` 复用同一摘要；只保留读取白名单，不再维护第二套标签 |
| `public/runtime-conversation.js` | 实时/历史 usage 渲染；历史提示按实际字段生成；`role=log`；Thinking/工具组/Plan 上的 usage |
| `public/runtime-timeline.js` | 历史 usage 白名单投影；usage 归属（含 plan-only）；`blockChars` 计入 usage 预算 |
| `public/runtime-store.js` | `cloneBlock` 按 block 契约逐字段复制；工具与 plan 子对象再走白名单；plan 可承载 usage |
| `public/agent-execution.css` | 删除 Runtime 用户外层卡片；统一计划/工具/Thinking/用量间距；折叠任务摘要样式 |
| `public/runtime-conversation.css` | 单层用户气泡兜底；用户标签视觉隐藏；历史消息用量间距 |
| `public/styles.css` | 工具状态数字等宽、组状态可换行但不挤；消息元信息与提示样式 |
| `public/plan-view.js` | 折叠摘要：完成计数 + 当前 `in_progress` 任务标题；stalled 用“未完成” |
| `public/index.html` | Classic `#stream` 增加 `role=log`、`aria-live=off` 等语义 |
| `tests/session-ux-phase3.cjs` | 新增 P3 定向行为与契约测试（113 条断言，含整改回归） |
| `tests/session-ux-phase3-shots.cjs` | 真实 Chromium 截图、几何、键盘、焦点、reduced-motion、AX 树 |
| `tests/session-ux-phase3-perf.cjs` | 500+ 消息、200 次工具调用的 Classic/Runtime 性能测量 |
| `tests/session-ux-phase1.cjs`、`tests/ui2-classic.cjs`、`tests/ui2-runtime-display.cjs` | 只对齐“推理”标签与新摘要格式的既有断言，未删除断言 |
| `package.json` | 把 `session-ux-phase3.cjs` 加入 `test` 链并新增 `test:session-ux-phase3` |

## P3-A 工具组信息收尾

`tool-view.js` / `tools.js` 在基线上已经具备运行、等待写入、成功、失败、未完成计数与真实组耗时，
本轮没有为了“完成任务”重写它们；新增测试固定了以下行为：

- 组头分别统计运行中、等待写入、成功、失败、未完成，等待写入不会混进运行中。
- 并行工具的组耗时取组内最早 `startedAt` 与最晚 `endedAt`，不是各工具耗时相加；部分条目缺时间戳
  时只用真实存在的时间，“全部缺失”时省略耗时，不显示 `0.0s`。
- 已结束的组不会继续推进秒表；测试在状态刷新前后比较文本，确认没有自行跳动。
- 用户点击组头的折叠选择优先；新工具到达、状态计数更新或组重建都不覆盖用户选择。
- 默认紧凑：`styles.css` 给状态数字加 `font-variant-numeric: tabular-nums`，组状态行允许在窄窗口
  换行但保持一行内的对齐与间距，不改变组头文案与折叠规则。

## P3-B Token 摘要与明细统一

`message-meta.js` 现在是 Classic、Runtime 实时与 Runtime 历史共用的唯一渲染入口：

- 白名单字段统一为 `input`、`output`、`cacheRead`、`cacheWrite`、`cacheWrite1h`、`reasoning`、
  `totalTokens`，标签统一为“输入 / 输出 / 缓存读取 / 缓存写入 / 缓存写入（1小时）/ 推理 / 总计”。
- 默认只显示一行摘要：有 `totalTokens` 用 `Token N`，否则退回真实 `output`；`reasoning` 标注
  “推理 N（含在输出中）”。完整拆分放在原生 `<details>` 中，默认收起。
- `reasoning` 是 output 的子集，不重复计入 `totalTokens`；渲染不修改原始 usage，也不改变上下文
  窗口统计、供应商配额或 usage 来源。
- 真实数字 `0` 保留，缺失或非法字段直接省略；不补 0、不推算。
- 成本只在 Pi 已给出 `usage.cost.total` 时显示为“预估成本 0.XXXX”，不乘单价、不补货币符号。
- 流式 `message_update` 的摘要带“（流式中，Pi 仍在累计）”，`message_end` 后是终值。

## P3-C Classic 与 Runtime 视觉统一

先在同一 fixture 下通过真实 Chromium 计算样式定位差异，再改 CSS：

- Runtime 实时/历史用户消息原有两层：外层 `.rtc-history-message` 带
  `rgba(0,0,0,0.03)` 背景、1px 边框、`8px 12px` 内边距与 12px 圆角，内层再有气泡。现在外层
  背景透明、边框/内边距/圆角为 0，内层保持唯一右对齐气泡；Classic 的 570.7×85.1、18/18/8 圆角、
  `10px 15px`、`min(82%,600px)` 等尺寸未变。
- 用户角色标签用 1px + `clip-path: inset(50%)` 视觉隐藏，`aria-label` 与生成内容保留；
  Chromium AX 树中仍有 `generic:你`。助手标签正常显示，AX 树中为 `generic:助手`。
- Runtime 计划外层边距从 `10px 0 14px` 改为 `8px 0 16px`，与 Classic 计划卡的 `8px 0 16px` 一致；
  计划卡内部自身 margin 归零，不再叠加。工具组保持 `9px 0 18px`；消息元信息统一 11.5px /
  `rgb(176,176,176)`，历史消息用量在正文下方 6px。
- 历史工具摘要与实时工具记录共用同一组 `.tl-*` 组件与间距；`incomplete` 继续使用 `--warn`，
  真正 `error` 使用 `--err`（基线上已正确，本轮回归验证，没有改成语义相反的颜色）。
- 只使用既有 `--ds-*` / `--t*` / `--line` / `--warn` / `--err` Token，没有新增平行样式体系；
  未修改阅读列宽度、用户气泡最大宽度或全局轮次间距。

真实 Chromium 计算样式（1320×820，深色）：

| 测量 | 修改前 | 修改后 |
| --- | --- | --- |
| Runtime 用户外层背景 | `rgba(0,0,0,0.03)` | `rgba(0,0,0,0)` |
| Runtime 用户外层边框/内边距/圆角 | `1px` / `8px 12px` / `12px` | `0` / `0` / `0` |
| Runtime 用户内层气泡 | 18/18/8 圆角，`10px 15px` | 不变 |
| Runtime 用户标签 | `position:static`、10.5px 可见 | 1px、`clip-path:inset(50%)` |
| Runtime 计划外层边距 | `10px 0 14px` | `8px 0 16px`（与 Classic 同） |
| Runtime 工具组边距 | `9px 0 18px` | `9px 0 18px`（与 Classic 同） |
| 文档 / 输出容器横向溢出 | 0 / 0 | 0 / 0 |

1320×820 与 700×600、深色与浅色、Classic、Runtime 实时、Runtime 历史、并行工具、等待写入、
失败、未完成、长 Token 摘要、折叠任务列表及长中英文均纳入截图；Composer 在 700px 下底部为
590，未超出 600 视口，也没有与输出重叠。完整截图与计算样式见
[after/measurements.json](ui/session-ux-phase3-evidence/after/measurements.json) 与
[before/measurements.json](ui/session-ux-phase3-evidence/before/measurements.json)。

## P3-D Runtime 历史真实用量

- `timelineFromMessages` 新增 `usageProjection`：只接受 `input`、`output`、`cacheRead`、
  `cacheWrite`、`cacheWrite1h`、`reasoning`、`totalTokens` 的**非负安全整数**，以及
  `costTotal` / `cost.total` 的非负有限数；其余字段（原始 `message`、工具参数、自由文本、
  `extra` 等）全部丢弃。
- 单条 assistant 消息的 usage 只挂一次：优先最后一个正文 block，其次 Thinking，再次工具组，
  最后 Plan。因此只思考、只调工具或只提交计划的消息也有真实用量，但不会为它伪造空的
  assistant 消息；一条消息有正文时，usage 不会再重复挂到计划卡。
- `cloneBlock` 不再对象展开整个 block，而是按 user/assistant/thinking/tools/plan 的既有契约
  逐字段构造；工具条目只保留 id/name/state/waiting/durationMs，plan 再走 `normalizePlan`，
  从入口排除 `message`、`args`、`secret`、`extra` 与工具原始输出。
- `blockChars` 给携带 usage 的正文、Thinking、工具组与 plan block 都计入固定 64 字符预算；
  既有 `MAX_BLOCKS`、`MAX_TIMELINE_CHARS` 与有界裁剪继续生效。
- `server/session-history.js` 继续调用同一个 `timelineFromMessages`，本轮不需要另写一份投影；
  服务端读取 fixture 的测试确认响应只含白名单字段，不含 `SECRET`、原始 message 或 `args`。
- 旧记录没有 usage 时不显示任何数字；历史提示改为“记录中无可显示的用量”，不再声称已恢复用量。
  只要任一 block 带真实 usage（包括只有 Thinking/工具组/Plan 的情况），提示仍为“正文与用量”。
  新增断言覆盖 thinking-only 与 plan-only 历史，避免提示与实际字段不符。
- 历史与实时的事件顺序、block 归属和用户折叠状态不变；多会话隔离仍由 store 的 owner /
  eventSequence / generation 校验和既有隔离测试覆盖，本轮性能夹具也实测无跨会话正文串扰。

## P3-E 任务列表折叠摘要

- 任务列表默认展开行为、P2 的折叠滚动补偿均未改动。
- 折叠后标题继续显示真实完成计数；存在 `in_progress` 时追加“正在执行：<任务标题>”，
  执行已结束但任务仍未完成时显示“未完成：<任务标题>”，不冒充正在执行。
- 当前任务标题最多占组头 46%，`overflow:hidden` + `text-overflow:ellipsis` + `nowrap`，
  `title` 属性保留完整标题；展开后摘要隐藏，避免与列表重复。
- 不新增 Composer 顶部任务列表；数据仍来自 `gui_plan` 的真实任务状态，`stopped`、`stalled`、
  `failed`、`cancelled` 的原有语义保持不变。

## P3-F 可访问性

- Classic `#stream`：`role=log`、`aria-live=off`、`aria-relevant=additions`、`aria-atomic=false`、
  `aria-label="对话记录"`。Runtime `.rtc-output`：同样的 log 语义，`aria-label="当前会话输出"`。
  两个容器都**不**逐 token 播报整段消息；局部 `role=status` / `role=alert` 语义保留，避免重复播报。
- Thinking、usage 明细使用原生 `<details>/<summary>`；工具组头、工具详情、任务卡头保持
  `aria-expanded` + `aria-controls`，展开状态与 DOM `hidden`/列表可见性一致。
- CDP 真实键盘事件验证：Tab/Shift+Tab 可到达工具组头，Enter 展开、Space 收起，焦点在折叠后
  仍留在原控件；Escape 不丢失焦点；Thinking 摘要 Enter 可展开且焦点保留。
- 深浅主题焦点环均可见：浅色 `2px solid rgb(40,91,150)`、偏移 `-2px`；深色
  `2px solid rgb(170,200,237)`、偏移 `-2px`。
- `prefers-reduced-motion` 下运行中实时会话的 4 个点动画全部停止，但相位仍为 `triangle`，
  点位、14×14 尺寸与 opacity 不变。
- 可访问性树实测：Classic 有 1 个 `log`（“对话记录”）；Runtime 历史有 1 个 `log`
  （“当前会话输出”），工具组为带 `expanded=false` 的按钮，Thinking 为已展开的
  `DisclosureTriangle`，用户/助手角色在树中分别为 `generic:你` / `generic:助手`。
- **未验证**：没有运行 NVDA、JAWS、VoiceOver 等真实读屏软件，因此不能宣称完成读屏验收。

## P3-G 长会话性能测量

夹具包含 770 条喂入消息（520 条可见正文消息）、200 次工具调用（50 组 × 4）、多次长输出；
Classic 与 Runtime 各自测量。Runtime 仍受 `MAX_BLOCKS=240` / `MAX_TIMELINE_CHARS=1MB` 有界
裁剪，最终 240 个 block（95 用户、95 助手、50 工具组），`truncated=true`。每次数据都是同一台
机器、同一天、同一 fixture 的单次 headless 测量，用于前后对比而不是微基准。

| 指标 | Classic 前 | Classic 后 | Runtime 前 | Runtime 后 |
| --- | ---: | ---: | ---: | ---: |
| 初次渲染 | 184.6 ms | 169.1 ms | 35.6 ms | 58.7 ms |
| 切到 B 会话 | 162.9 ms | 147.8 ms | 34.3 ms | 48.0 ms |
| 切回 A 会话 | 158.1 ms | 157.9 ms | 22.2 ms | 30.4 ms |
| 滚动到底 / 中段 | 23.5 / 38.8 ms | 24.3 / 35.6 ms | 27.1 / 33.8 ms | 28.0 / 34.0 ms |
| 工具组展开 / 收起 | 41.6 / 34.5 ms | 30.6 / 29.1 ms | 34.3 / 32.0 ms | 33.0 / 33.0 ms |
| DOM 节点（输出容器） | 11,399 | 11,399 | 5,765 | 6,780 |
| JS heap | 8,080,356 B | 8,196,787 B | 11,087,632 B | 11,853,540 B |

- Classic 首次渲染与切换仍有 1–2 个 long task（修改前首次最大 157 ms，修改后首次最大 136 ms；
  修改后切换最大 131/138 ms），说明同步重建 520 条消息/200 个工具行是当前的主要瓶颈。滚动与工具组
  展开/收起没有 long task。该差异与 P3 改动无直接关系，但值得后续单独评估分块渲染。
- Runtime 修改后首次渲染约 +23 ms、DOM 约 +1,015 节点，主要来自每条真实 assistant usage
  的 `<details>` 摘要/明细；这是 P3-D 的功能成本。Runtime 在 240 block 上限下没有 long task，
  切换、滚动、工具组展开/收起均保持低延迟。
- 两种模式均无跨会话正文串扰，两个性能脚本的 `pageErrors` 为空。
- 结论：本轮不做虚拟化或 `content-visibility`；如果后续把可见消息量提升到当前数倍，应另立
  决策，用分块渲染或虚拟化解决 Classic 的同步长任务。

原始数据见 [after/performance.json](ui/session-ux-phase3-evidence/after/performance.json) 与
[before/performance.json](ui/session-ux-phase3-evidence/before/performance.json)。

## 验收整改（P3 收尾）

本轮只修复两个边界问题，不扩大范围。

### 1. `cloneBlock` 顶层白名单

原实现用 `{ ...block }` 复制整个历史 block，只在事后过滤 `usage`；`message`、`args`、
`secret`、`extra` 等附加属性仍会进入 store。现在按既有 block 契约逐字段构造：

- user：`id/kind/text/truncated/messageId/userIndex`；
- assistant/thinking：`id/kind/text/state/truncated/usage`；
- tools：`id/kind/tools/truncated/usage`，每个工具只保留 `id/name/state/waiting/durationMs`；
- plan：`id/kind/plan/usage`，plan 与任务再走 `normalizePlan` 白名单，保留 turnId、任务状态与
  完成计数。
- 只有 `assistant/thinking/tools/plan` 可以承载 usage；user 上的 usage 不会被带入。
- block id、文本、状态、工具、Plan、历史定位（`messageId`/`userIndex`）与截断标记均保留；
  实时事件路径不经过 `cloneBlock`，事件顺序不受影响。

新增断言同时覆盖顶层字段集合、工具/计划子字段集合、非法值不可达，以及合法正文、工具耗时、
计划标题/状态、usage 仍正常。测试中的 `TOP_SECRET`、`PLAN_SECRET`、`TOOL_SECRET`、
`RAW_ARGS`、`RAW_OUTPUT` 均未出现在 store 序列化结果中。

### 2. plan-only usage

`gui_plan` 是唯一 content 的 assistant 消息，原先 usage 没有归属目标。现在：

- `USAGE_BLOCK_KINDS = ['assistant', 'thinking', 'tools', 'plan']` 明确可用 block 类型与优先级；
  一条消息只挂一次，正文存在时仍优先正文。
- `timelineFromMessages` 的 plan-only 消息把 usage 挂到最后创建的 plan block，不新增 assistant
  正文；plan + 正文的混合消息仍只出现一次 usage。
- `cloneBlock` 的 plan 分支保留白名单 usage；`blockChars` 给 plan usage 增加 64 字符预算，
  `boundTimeline` 会按 `maxChars` 正确淘汰更早的 plan block。
- Runtime 历史 plan 视图在计划卡外层渲染同一套 `.ui2-msg-meta`；折叠计划列表不会隐藏用量，
  计划折叠、`aria-expanded` 与既有 steer 归并逻辑不受影响。usage 不会进入计划列表内部，
  也不会为 plan-only 历史伪造空的助手正文。

### 整改测试

按用户要求只复跑 P3 与 Runtime 历史投影相关套件，未运行完整 `npm test`：

| 命令 | 结果 |
| --- | --- |
| `node tests/session-ux-phase3.cjs` | 113/113（原 78，新增 35 条） |
| `node tests/runtime-store.cjs` | 34/34 |
| `node tests/runtime-conversation.cjs` | 106/106 |
| `node tests/history-tool-summary.cjs` | 38/38 cases；168/168 assertions（含 steer 归并） |
| `node tests/history-tool-summary-http.cjs` | 14/14 cases；49/49 assertions |
| `node tests/runtime-history-search.cjs` | 37/37 |
| `node tests/ui2-runtime-display.cjs` | 83/83 |

没有删除既有断言。没有修改思考动画、P2 阅读位置机制或任何 CSS；本轮未重跑视觉与性能脚本，
因为它们对应的样式与性能路径未被整改改变，plan-only 用量的布局只做了 jsdom 行为验证。

## 真实视觉与 P2 回归

修改前后使用**同一个** Chromium/CDP 脚本与固定 fixture，只把静态目录切换为 `origin/main`
的 `public/`。截图像素尺寸为 1320×820 与 700×600。

| 场景 | 修改前 | 修改后 |
| --- | --- | --- |
| Classic 深色 1320 | [前](ui/session-ux-phase3-evidence/before/01-classic-dark-1320.png) | [后](ui/session-ux-phase3-evidence/after/01-classic-dark-1320.png) |
| Classic 浅色 700 | [前](ui/session-ux-phase3-evidence/before/02-classic-light-700.png) | [后](ui/session-ux-phase3-evidence/after/02-classic-light-700.png) |
| Runtime 实时深色 1320 | [前](ui/session-ux-phase3-evidence/before/05-runtime-live-dark-1320.png) | [后](ui/session-ux-phase3-evidence/after/05-runtime-live-dark-1320.png) |
| Runtime 实时浅色 700 | [前](ui/session-ux-phase3-evidence/before/06-runtime-live-light-700.png) | [后](ui/session-ux-phase3-evidence/after/06-runtime-live-light-700.png) |
| Runtime 历史深色 1320 | [前](ui/session-ux-phase3-evidence/before/09-runtime-history-dark-1320.png) | [后](ui/session-ux-phase3-evidence/after/09-runtime-history-dark-1320.png) |
| 折叠任务列表深色 1320 | [前](ui/session-ux-phase3-evidence/before/07-runtime-live-plan-collapsed-dark-1320.png) | [后](ui/session-ux-phase3-evidence/after/07-runtime-live-plan-collapsed-dark-1320.png) |
| 折叠任务列表浅色 700 | [前](ui/session-ux-phase3-evidence/before/11-runtime-history-plan-collapsed-light-700.png) | [后](ui/session-ux-phase3-evidence/after/11-runtime-history-plan-collapsed-light-700.png) |
| reduced-motion | [前](ui/session-ux-phase3-evidence/before/12-runtime-live-reduced-motion-light-1320.png) | [后](ui/session-ux-phase3-evidence/after/12-runtime-live-reduced-motion-light-1320.png) |

完整 19 张修改后截图（含历史工具组展开、计划卡底部、窄窗口计划摘要）位于
[after/](ui/session-ux-phase3-evidence/after/)，修改前同场景位于
[before/](ui/session-ux-phase3-evidence/before/)。

P2 阅读位置与折叠补偿在修改后的真实浏览器中重跑 **13/13**：

- Classic A→B→A、B 独立书签、实时 tools 锚点、实时 plan 锚点的恢复误差均为 **0px**。
- 工具组头、工具详情、Plan 任务卡折叠位置误差均为 **0px**；视口上方折叠后的内容位移
  **0.19px**。
- Runtime 搜索的祖先 stage/work-surface/外层文档滚动量均为 **0**，目标容器正常滚动，居中误差
  **0px**。

证据见 [P2 回归报告](ui/session-ux-phase3-evidence/after/p2-regression/report.json)。

## 定向测试

按用户要求没有运行本地完整 `npm test`；只运行与改动范围相关的套件。测试环境为 Windows x64、
Node 24.22.1、Chromium 157.0.8103.78。

| 命令 | 结果 |
| --- | --- |
| `npm run test:session-ux-phase3` | 113/113 |
| `node tests/runtime-conversation.cjs` | 106/106 |
| `node tests/runtime-store.cjs` | 34/34 |
| `node tests/agent-execution-ui.cjs` | 221/221 |
| `node tests/session-ux-phase1.cjs` | 81/81 |
| `node tests/session-ux-phase2.cjs` | 96/96 |
| `node tests/ui2-classic.cjs` | 55/55 |
| `node tests/ui2-runtime-display.cjs` | 83/83 |
| `node tests/usage-quota.cjs` | 229/229 |
| `node tests/thinking-dots.cjs` | 90/90 |
| `node tests/history-tool-summary.cjs` | 38/38 cases；168/168 assertions |
| `node tests/history-tool-summary-http.cjs` | 14/14 cases；49/49 assertions |
| `node tests/runtime-history-search.cjs` | 37/37 |
| `node tests/runtime-ui.cjs` | 16/16 |
| `node tests/runtime-nav.cjs` | 38/38 |
| `node tests/session-ux-phase3-shots.cjs` | 退出 0；19 张截图 + 测量 JSON |
| `node tests/session-ux-phase3-perf.cjs` | 退出 0；两类性能 JSON |
| `node scripts/run-test-group.mjs --validate` | 260 条 canonical 命令；core/ui/security/native/faults 五组 |

`runtime-live` 是需显式设置 `PI_GUI_RUNTIME_LIVE=1` 的 opt-in 套件，本轮未运行，不作为通过项。
本轮修改的既有测试只改了“思考”到“推理”和摘要格式的期望文本，没有删除断言；套件计数没有减少。
其余未列出的套件按“只跑相关范围”的策略未运行。

## 构建与冻结动画

- `npm run build:app -- --rebuild` 成功，产物为 `dist-app\Pi GUI-win32-x64`，整包 333.6 MB；
  P3 收尾整改后又执行了一次重建，退出 0。本轮没有发版，也没有安装/启动打包后的应用做二次验收。
- 思考动画冻结文件没有任何改动：

```text
$ git diff --exit-code -- public/thinking-dots.js public/thinking-dots.css public/scroll-button.js
$ echo $?
0
```

| 冻结路径 | Git blob（工作区 / HEAD 均一致） |
| --- | --- |
| `public/thinking-dots.js` | `02aa11c32e4d4720dafda8730d9d3440131bc998` |
| `public/thinking-dots.css` | `b9862cf93d3b71c38d040a10712e3264487636fa` |
| `public/scroll-button.js` | `5329ea74dc76da928a7aecd8de6d5a59f3703a4c` |

`thinking-dots.cjs` 90/90；真实 Chromium 的 reduced-motion 结果见上。没有新增类似的思考动画
组件，也没有通过新增选择器改变动画节点的布局、大小、颜色、透明度、速度、相位或触发时机。

## 对照审计

| 审计项 | 状态 | 说明 |
| --- | --- | --- |
| O-04 单条消息 Token 摘要 + 明细 | 已完成 | 共用 `message-meta.js`；0/缺失/成本/流式语义均有测试 |
| O-09 Runtime 与 Classic 消息视觉统一 | 已完成 | 单层用户气泡、隐藏用户标签、计划/工具/元信息对齐；真实计算样式与截图 |
| O-10 Runtime 历史真实用量 | 已完成 | 白名单投影、正文/Thinking/工具/Plan 归属、顶层与子对象过滤、裁剪预算、旧记录兼容；仅真实 usage 显示 |
| O-11 工具组真实耗时与等待计数 | 已有实现，本轮验证 | `tool-view.js`/`tools.js` 未改；新增测试锁定并行耗时、缺失省略、停表与折叠 |
| O-12 可访问性收口 | 已完成（AX/键盘）；真实读屏未验证 | `role=log` + `aria-live=off`；折叠控件、焦点环、reduced-motion 已实测 |
| P3-E 任务列表折叠摘要 | 已完成 | 真实完成数 + 当前任务短标题；stalled 用“未完成” |
| P3-G 长会话性能测量 | 已完成测量，不改架构 | 数据见上；虚拟化留待后续单独决策 |

## 残余风险与未验证项

- **真实读屏未验证**：只验证了 Chromium 可访问性树与键盘交互，未运行 NVDA/JAWS/VoiceOver。
- `role=log` 配合 `aria-live=off` 是有意选择：避免流式 delta 反复播报；新增消息不会自动播报，
  仍由局部 `role=status`/`role=alert` 承担状态提示。若后续要求“新消息自动播报”，需要真实读屏
  验证后再调整。
- 性能数据是单次 headless 测量，存在机器负载与 GC 波动；Classic 首次渲染/切换仍有同步长任务，
  当前数据只能说明没有因 P3 明显恶化，不能证明所有长会话都流畅。
- Runtime 历史仍受既有 240 block / 1MB 有界裁剪；更早记录会被截断，这是既有安全边界，本轮未放宽。
- usage 的可用性取决于原生记录是否真的写入 `message.usage`；没有就不显示，绝不按消息长度、
  工具次数或上下文比例推算。成本只在 Pi 提供 `cost.total` 时显示，且不补货币符号。
- 视觉证据来自离线 Chromium + 固定 fixture，不是已安装的 Electron 应用；打包产物已成功生成，
  但未启动打包后的应用做人工点击验收。其他平台、签名与真实模型长会话不在本轮范围。
- P4 未开始；本轮没有合并、发版或推送 tag。

## 回滚

本次改动按“业务代码 / 测试 / 验收证据”分别提交。回滚时回退对应提交后重新执行
`npm run build:app -- --rebuild`，即可恢复旧前端产物；没有修改会话文件、pi 本体或全局 npm，
因此不需要数据迁移。
