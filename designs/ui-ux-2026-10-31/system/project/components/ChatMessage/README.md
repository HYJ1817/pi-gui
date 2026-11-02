# ChatMessage

聊天消息以角色、正文和可收拢活动建立可长读的信息层级。

本组件为 **Pi Workbench 新设计提案**，使用原生 HTML/CSS 手写，未替换生产组件。预览中的名称、进度和工具输出是演示数据。

## 使用与尺寸

正文使用 type-prose（15px/27px），阅读宽 reading-width（760px）；用户轻背景，Assistant开放排版。长表格与代码有界横向滚动。

consumer 提供 role、safe markdown、timestamp、streaming、actions、attachments；保留现有renderer和消息owner。

## 状态规范

| 状态 | 视觉与行为 |
| --- | --- |
| default | 基础状态；显示清晰标签或内容，使用 surface-panel / text-primary。 |
| hover | 仅可交互子控件使用 surface-hover；不改变边界尺寸、位置、行序或文字。 |
| pressed | 触发器使用 surface-pressed；动作在 click/键盘激活时执行，不缩放、不增加布局占位。 |
| selected | 持续选择使用 accent-soft + text-primary + 文字/aria-current；非选择组件不制造虚假的 selected。 |
| focus | 可交互目标使用2px focus / 2px offset，不能被父 overflow 裁掉；读内容本身不额外Tab。 |
| disabled | 禁用动作使用 disabled/aria-disabled 与原因；保留原内容，不能仅降透明度或删除入口。 |
| error | 内联 danger + 错误说明；保留草稿/当前选择/滚动，提供明确重试；只读组件由所属业务区显示错误。 |

预览顶部可切换模拟状态，真实 hover/active/focus 仍由浏览器驱动。对复合或只读组件，状态作用于其可交互子项；没有选择/禁用语义的正文保持可读，不为凑状态制造交互。

## 键盘与可访问性

正文可选可复制；代码块独立横向滚动；消息操作focus可达，不能只在hover出现。

颜色不能作为唯一信息；常规文字所有主题至少4.5:1，图标、控件边界和焦点至少3:1。错误即时说明影响范围，不重复弹通知。

## 生命周期与实施边界

预览仅演示交互反馈，不持久化用户文件、不读真实会话、不调用模型。生产接入继续使用现有 owner/generation、modal/popover、RPC 与安全授权边界；组件仅接收公开状态和回调，不能自行读写业务存储。
