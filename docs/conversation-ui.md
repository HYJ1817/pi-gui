# P14-B Conversation Visual System

Conversation 使用工作区内居中的阅读列，最大正文宽度为 920px；空间不足时收窄边距并占满剩余宽度。消息、代码块、工具摘要和附件都不能让页面横向滚动。流底部留出空间，Composer 的结构与行为留给 P14-C。

## 消息层级

- **User**：右对齐、内容自适应的柔和灰色 Bubble，最大占阅读列的 76%。短消息不铺满，长路径和 URL 在 Bubble 内换行；换行、行内代码与附件仍按原消息内容展示。视觉隐藏「你」标签，DOM 仍保留身份信息。
- **Assistant**：背景透明的开放正文。保留轻量「Pi」标记，以及现有 Markdown 的段落、标题、列表、代码、引用、表格和链接语义。每个 User Turn 与下一个 Turn 的间距由 `--turn-gap` 控制；Assistant 内段落沿用 Markdown 间距。
- **状态反馈**：处理中、失败、空回复和中断继续走原有状态路径；正文优先，状态文字和 metadata 次之。没有真实功能的消息操作按钮不会出现。

## Thinking 与 Tool Timeline

Thinking 默认折叠，摘要只显示已有文本的字数。按钮用 `aria-expanded` / `aria-controls` 指向保留在 DOM 的内容；Enter、Space 可操作。流式 `thinking_end` 不覆盖用户手动展开状态，`message_end` 复用原节点，避免结束时整条消息被替换。历史重建也用同一个 Thinking 构造函数，默认折叠；状态不写入会话文件。

Tool Timeline 仍以一条 Assistant 消息中的连续 tool calls 为组。实时事件和历史结果都转成既有 `ToolEntry`，共用 `tool-view.js`；只调整行、状态文字、图标与详情按钮。运行中、成功、失败和未完成都有文字与形状，不只靠颜色。没有结构化区分的取消或中断结果继续如实标「未完成」，不推断状态或退出码。已有详情在当前行下方展开；未知工具、孤儿结果和无结果的降级规则不变。

## 附件与 Minimap

文件附件在消息里是紧凑块，保留原名称、元信息和当前已有的文本详情；详情按钮可用键盘打开，不新增 PDF/Word 预览或分栏入口。多附件在 Bubble 内自然堆叠。图片继续显示现有缩略图，上传逻辑不变。

Minimap 仍按每条 User 消息建一条短线，沿用 DOM 锚点、位置缓存与点击跳转。当前项更亮，hover / focus 可见；点击后立即同步高亮，窄窗口沿用隐藏策略。它不索引 Assistant、Thinking 或 Tool，也不另存消息副本。

## 渲染边界与验证

SSE 的增量消息与 `get_messages` 历史消息仍走 `messages.js`；Tool 的两个数据来源仍共用 `ToolEntry → tool-view.js`。流式绘制保留原限流与近底部自动滚动规则；最终内容只更新变化的块并复用现存 Thinking 节点。长代码只在 `<pre>` 内横向滚动。

`npm run test:ui` 验证 DOM 语义、折叠状态、流式结束、工具状态、附件与 Minimap。`npm run harness` + `npm run shots:harness` 在真实 Chrome 中验证 69–85 场景，包括 700、900、1200、1536px 的阅读列和溢出。P14-A 的 57–68 场景在注入 P14-B 夹具前运行。

本阶段没有改变 P14-A Shell、项目/会话、Composer 内部、附件上传、模型与上下文选择、Planner、Git、后端 API、pi RPC 或 session 存储语义。

P14-E 的阅读区域仍由 `#stream` 独占滚动，切换 Work Surface 后保留位置。Markdown 链接通过浅色文字和下划线辨认，代码与任务勾选使用灰阶；Tool Timeline 的展开按钮保持中性，运行、成功、失败和 Diff 的状态色仍传递实际状态。
