# P14-B Conversation Visual System

Conversation 使用工作区内居中的阅读列。PI-Desktop 阶段 D 将内容带统一为既有 `--ds-composer-width`（760px），线程在带内保留 32px 水平内距；空间不足时收窄边距并占满剩余宽度。消息、代码块、工具摘要和附件都不能让页面横向滚动。流底部按 Composer 实测高度预留并渐隐，Composer 的结构与行为见 [composer-ui.md](composer-ui.md)。

## 消息层级

- **User**：右对齐、内容自适应的柔和灰色 Bubble，最大为阅读列的 82% 与 600px 中较小值；18px 圆角（右下角 8px）、10/15px 内距。短消息不铺满，长路径和 URL 在 Bubble 内换行；换行、行内代码与附件仍按原消息内容展示。视觉隐藏「你」标签，DOM 仍保留身份信息。用户消息的复制栏在 hover、键盘 focus 或触屏显示，复制原始文本；失败可见且可重试，不修改会话。pi 没有对应的消息删除或编辑重发业务，不添加这些入口。
- **Assistant**：背景透明的开放正文。保留轻量「Pi」标记，以及现有 Markdown 的段落、标题、列表、代码、引用、表格和链接语义。每个 User Turn 与下一个 Turn 的间距由 `--turn-gap` 控制；Assistant 内段落沿用 Markdown 间距。
- **状态反馈**：处理中、失败、空回复和中断继续走原有状态路径；正文优先，状态文字和 metadata 次之。没有真实功能的消息操作按钮不会出现。

## Thinking 与 Tool Timeline

Thinking 默认折叠，摘要只显示已有文本的字数。按钮用 `aria-expanded` / `aria-controls` 指向保留在 DOM 的内容；Enter、Space 可操作。流式 `thinking_end` 不覆盖用户手动展开状态，`message_end` 复用原节点，避免结束时整条消息被替换。历史重建也用同一个 Thinking 构造函数，默认折叠；状态不写入会话文件。

Tool Timeline 仍以一条 Assistant 消息中的连续 tool calls 为组。实时事件和历史结果都转成既有 `ToolEntry`，共用 `tool-view.js`；只调整行、状态文字、图标与详情按钮。运行中、成功、失败和未完成都有文字与形状，不只靠颜色。没有结构化区分的取消或中断结果继续如实标「未完成」，不推断状态或退出码。已有详情在当前行下方展开；未知工具、孤儿结果和无结果的降级规则不变。两项以上时组头写「工具调用 · N 次」，默认折叠；状态汇总（运行中 / 失败 / 未完成…）留在组头上，折叠时错误仍然可见。单条调用不摆冗余组头。

## 任务列表（gui_plan）

计划来自 Pi 扩展 `extensions/pi-gui-plan` 注册的 `gui_plan` 工具，不从工具调用次数、时长或正文推断。每次调用提交**完整**任务列表：id 稳定，状态只有 `pending` / `in_progress` / `completed` / `failed` / `cancelled`；扩展拒绝重复 id、空列表和未知状态。同一轮重新规划时，模型漏掉的已完成 / 失败 / 已取消任务会由扩展保留并标 `retained`；新一轮用户任务不继承上一轮完成项。工具结果 `details` 随会话持久化。计划工具不进入 Tool Timeline，避免同一件事出现两次。

**回合边界只认 Pi 的真实事件。** `agent_settled` 在整个 session 级 run 收尾时发出，自动重试、压缩、steering/follow-up 都在它之前跑完；运行中追加用户消息不会发新的 `agent_start`。因此「上一轮已 settled 后的 `agent_start`」才是新任务边界：此时切换当前计划指针，旧计划卡仍留在时间线里；运行中的 steer / follow-up、自动重试和压缩都不清空当前计划。Runtime store 与 Classic 的 `plan-live.js` 共用这条判据，不用「看到一条 user 消息」猜新回合。

## Runtime 执行时间线

Runtime 的计划、思考、工具与正文不再分散在输出区外的固定槽位，而是进入同一个 `.rtc-output` 滚动容器，按真实事件/消息顺序排列。实时顺序来自 store 收到事件的先后（不按类别重排）；历史顺序来自原生 JSONL 的 message/content 顺序。视图只按投影出的有界 block 列表放置节点，节点按 block id 复用，流式更新不重建整条时间线。

`public/runtime-timeline.js` 是实时与历史共用的纯投影：只保留用户/助手文本、真实 thinking 文本、工具名/状态/耗时和 `gui_plan` 白名单字段；工具原始 args、result 正文、环境变量与凭据不进入投影。历史读取用同一个投影，因此恢复的计划、思考、工具与最终回答都来自真实记录；缺字段就省略，记录被截断时状态行明确说明，不伪造内容。展开状态按会话保存：Thinking 和多项工具组默认折叠，用户展开后，新工具、流式增量和切换会话都不会把它收回。

回到底部按钮只操作当前会话自己的 `.rtc-output`，不共享滚动位置，也不强制把正在阅读历史的用户拉回底部；点击后才恢复 follow-latest。任务列表、工具组、Thinking 与正文的视觉 token 与 Classic 一致。

`public/plan-model.js` 只做契约校验与按回合归并，`public/plan-view.js` 只认归一后的 plan；按稳定 id 复用行，只改变化的文字/状态/顺序。默认展开，用户折叠后流式更新不改变折叠状态；头部显示真实的 `已完成/总数`。执行结束但仍有 `in_progress` 时，数据状态不变，展示文案改为「未完成」并停止呼吸动画，不伪造 `completed`。

## 回到底部

`public/scroll-button.js` 给 Classic 的 `#stream` 与 Runtime 的 `.rtc-output` 各建一个按钮，只对传入的滚动容器写 `scrollTop`，从不调用 `document` / `window` 的通用滚动。离底超过 160px 出现，回到 8px 以内消失（两段阈值防抖）。运行中复用 `thinking-dots` 的四点/三点动画，悬停或键盘聚焦时换成下箭头，两个图标叠在同一网格，按钮尺寸不变；闲置时直接显示下箭头。点击后平滑回到底部，并在短 follow 窗口结束时再补一次到底，覆盖流式连续追加；用户滚轮 / 触摸 / 方向键会立即退出 follow。`prefers-reduced-motion` 下改为瞬时滚动并关闭过渡。Runtime 切会话时按钮跟随该会话自己的 `scrollTops`，不共享其他会话的位置。

## 附件与 Minimap

文件附件在消息里是紧凑块，保留原名称、元信息和当前已有的文本详情；详情按钮可用键盘打开，不新增 PDF/Word 预览或分栏入口。多附件在 Bubble 内自然堆叠。图片继续显示现有缩略图，上传逻辑不变。

Minimap 仍按每条 User 消息建一条短线，沿用 DOM 锚点、位置缓存与点击跳转。当前项更亮，hover / focus 可见；点击后立即同步高亮，窄窗口沿用隐藏策略。它不索引 Assistant、Thinking 或 Tool，也不另存消息副本。

这一轮 UX 修复改了它的两处行为：marker **聚成一组紧凑短线**（整组纵向居中、条数与可用高度决定间距，不再按消息在内容里的比例铺满整个左栏 —— 那样一条长回答就会把后面的点推到很远）；点击跳转**只写 `#stream.scrollTop`**，不再用 `element.scrollIntoView()` —— 后者连带滚动 `overflow:hidden` 的 `.stage`，会把顶栏推出视口（详见 [sessions.md](sessions.md) 第十节）。`.stage` 同时改成 `overflow:clip`（不是可被脚本滚动的 `hidden`），`.stage-head` 有了显式背景并与 `electron/main.cjs` 的 `titleBarOverlay.color` 共用同一个 `--titlebar` 值。

## 渲染边界与验证

SSE 的增量消息与 `get_messages` 历史消息仍走 `messages.js`；Tool 的两个数据来源仍共用 `ToolEntry → tool-view.js`。流式绘制保留原限流与近底部自动滚动规则；最终内容只更新变化的块并复用现存 Thinking 节点。长代码只在 `<pre>` 内横向滚动。

`npm run test:ui` 验证 DOM 语义、折叠状态、流式结束、工具状态、附件与 Minimap。`npm run harness` + `npm run shots:harness` 在真实 Chrome 中验证 69–85 场景，包括 700、900、1200、1536px 的阅读列和溢出。P14-A 的 57–68 场景在注入 P14-B 夹具前运行。

本阶段没有改变 P14-A Shell、项目/会话、Composer 内部、附件上传、模型与上下文选择、Planner、Git、后端 API、pi RPC 或 session 存储语义。

P14-E 的阅读区域仍由 `#stream` 独占滚动，切换 Work Surface 后保留位置。Markdown 链接通过浅色文字和下划线辨认，代码与任务勾选使用灰阶；Tool Timeline 的展开按钮保持中性，运行、成功、失败和 Diff 的状态色仍传递实际状态。
