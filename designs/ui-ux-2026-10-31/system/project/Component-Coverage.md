# 组件与状态覆盖

19 个组件均有 README 状态表与可交互 preview。状态表描述 default / hover / pressed / selected / focus / disabled / error；对于内容、状态、进度等只读对象，选中/禁用只适用其可交互动作，不虚构对象本身的状态。

| 组件 | 规范 | 可操作预览内容 |
| --- | --- | --- |
| Button | [README](components/Button/README.md) | 按钮以稳定尺寸表达单次操作，只保留一个主要动作。 [preview](components/Button/preview.html) |
| IconButton | [README](components/IconButton/README.md) | 图标按钮提供紧凑且有可访问名称的辅助操作。 [preview](components/IconButton/preview.html) |
| Input | [README](components/Input/README.md) | 单行输入通过标签、提示和内联错误完整表达字段含义。 [preview](components/Input/preview.html) |
| Textarea | [README](components/Textarea/README.md) | 多行输入固定宽度并按内容增高，超出上限后内部滚动。 [preview](components/Textarea/preview.html) |
| ModelPicker | [README](components/ModelPicker/README.md) | 模型选择器同时呈现供应商、模型身份与权威回读状态。 [preview](components/ModelPicker/preview.html) |
| Menu | [README](components/Menu/README.md) | Dropdown 和右键菜单共用动作列表、锚点边界和键盘规则。 [preview](components/Menu/preview.html) |
| Dialog | [README](components/Dialog/README.md) | 模态对话框只用于需要中断当前工作的确认或独立编辑。 [preview](components/Dialog/preview.html) |
| Popover | [README](components/Popover/README.md) | 非模态浮层承载当前操作的补充信息，不改变输入区布局。 [preview](components/Popover/preview.html) |
| Tabs | [README](components/Tabs/README.md) | 页签切换同一工作面板内的兄弟视图并保留各自状态。 [preview](components/Tabs/preview.html) |
| Sidebar | [README](components/Sidebar/README.md) | 会话侧栏使用固定行序和项目层级，让选择动作保持空间稳定。 [preview](components/Sidebar/preview.html) |
| Tooltip | [README](components/Tooltip/README.md) | Tooltip 解释图标操作与快捷键，不承载必要操作或错误原因。 [preview](components/Tooltip/preview.html) |
| StatusIndicator | [README](components/StatusIndicator/README.md) | 状态标识以文字和形状共同表达系统状态，颜色只作补充。 [preview](components/StatusIndicator/preview.html) |
| Progress | [README](components/Progress/README.md) | 进度条仅在有可靠分母时显示百分比，否则显示活动和阶段文字。 [preview](components/Progress/preview.html) |
| EmptyState | [README](components/EmptyState/README.md) | 空状态解释当前上下文并提供一个真实可执行的下一步。 [preview](components/EmptyState/preview.html) |
| ErrorState | [README](components/ErrorState/README.md) | 错误状态保留上下文、说明影响范围，并提供可验证的恢复动作。 [preview](components/ErrorState/preview.html) |
| Toast | [README](components/Toast/README.md) | Toast 对非阻断操作提供短暂、去重且不打断焦点的确认。 [preview](components/Toast/preview.html) |
| ChatMessage | [README](components/ChatMessage/README.md) | 聊天消息以角色、正文和可收拢活动建立可长读的信息层级。 [preview](components/ChatMessage/preview.html) |
| ToolActivity | [README](components/ToolActivity/README.md) | 工具活动默认压缩为可扫描的阶段与结果，需要时再展开细节。 [preview](components/ToolActivity/preview.html) |
| WorkPanel | [README](components/WorkPanel/README.md) | 右侧工作面板共用标题、页签、尺寸和关闭规则，并保留业务实例。 [preview](components/WorkPanel/preview.html) |

复合覆盖：ModelPicker 同时覆盖 Select；Menu 同时覆盖 Dropdown 与 Context Menu；Progress 同时覆盖 Loading/Progress；Tabs 与 Sidebar 分开；Dialog 与 Popover 分开；Input 与 Textarea 分开。所有控件基于原生语义，无新组件库。

状态审查需在真实浏览器中检查。顶部模拟器只改变演示 data-state 或原生disabled/aria-invalid，不能替代真实 hover、pointer/keyboard press、焦点还原与业务接口验证。
