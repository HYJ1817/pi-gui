# P14-C Floating Composer

Composer 保留原有的 `composerBox`、`input` 和所有控制按钮 ID。它是 `.stage` 底部的单个浮动面板，与对话阅读列共用中央轴；最大宽度由 `--composer-max-width: calc(var(--conversation-max-width) - 32px)` 得出，底部留 18px。对话仍由 `#stream` 独立滚动。

## 高度与滚动

`composer.js` 对 `.composer` 外层建立一个 `ResizeObserver`，把实际高度写入 `.stage` 的 `--composer-reserved-height`。`.thread` 的底部 padding 使用这个变量加少量间隙，因此附件和多行输入增加高度时，末条消息仍能滚到面板上方。Observer 只读外层矩形、只写 CSS 变量。textarea 的 `autoGrow` 仍由原来的 input 事件触发，高度不超过 `min(184px, 24vh)`，超出时在 textarea 内滚动。窗口变小时重新计算上限。

## 控件与业务映射

| 控件 | 现有动作 |
|---|---|
| Attach | 点击同一个隐藏的 `fileInput`，继续由 `handleFiles` 上传和解析 |
| Context | `renderCtxChip` 显示真实百分比，`openCtxTip` 展示已有的上下文、输入、输出、缓存读取和成本字段 |
| Model | `openModelPicker` 使用现有模型列表与 `setModel` |
| Thinking | `openThinkPicker` 使用现有档位与 `setThinkingLevel` |
| Send | `submit`，运行中仍可通过现有路径发送 steer |
| Stop | `stop`，运行时成为视觉上的主要动作 |

附件托盘展示原有 `loading`、解析结果和 `error` 字段，不增加业务状态；每项仍调用 `removeAttachment`。文件名、状态和模型名继续用 `textContent` 写入。拖入状态继续用原有 `dragDepth` 控制，只调整边框和背景。无项目时仍由 `applyProjectState` 锁定输入区。

## 弹层、键盘和窄屏

Model、Thinking 和 Context 共用 `ui/popover.js`，优先放在 Composer 上方。选项是可聚焦的 button；触发按钮维护 `aria-expanded` 和 `aria-controls`，当前项有 `aria-current`。Escape 关闭选择器并把焦点还给触发按钮。输入框原有的 Enter 发送、Shift+Enter 换行、IME 合成时不发送、Escape 停止行为不变。700px 下各控件仍在同一行，通过缩小间距和模型名截断保持可用；700×600 下 textarea 高度受视口约束。

## 验证与边界

`npm run test:ui` 检查控件、键盘和高度同步；`npm run shots:harness` 的 86–104 场景用真实 Chrome 检查面板同轴、控件边界、弹层位置、textarea 内滚动、附件、运行/锁定状态、四档宽度和长文本。P14-A/B 的 57–85 场景保持原样。此轮没有改发送协议、上传格式、附件解析器、Agent 生命周期或 Conversation 消息业务语义，也没有新增无真实 handler 的入口。

P14-E 统一了灰阶控件：Send 用较亮的中性背景表达主操作，Stop 用深灰背景与文字标识，Model / Thinking / Context 和 Popover 选中项不使用黄色。焦点环仍保持高对比度；正常 Context 用量为灰色，超过阈值才显示语义色。hover 只轻微改变背景，不缩放发送按钮。

## 模型 Provider 折叠与思考档位同步

模型列表仍来自 `S.models`，按 Provider 分组。每组头是整行可点击的 button，显示方向箭头、Provider 名和模型数量，并用 `aria-expanded` / `aria-controls` 关联安全的序号 ID。模型项继续复用 `popItem`；当前项优先以 Provider + id 判断，只有 state 缺 Provider 时才退回 id / name。Provider 名只经 `textContent` 写入。

展开状态只存在 `app.js` 的运行期集合中：初次打开仅当前 Provider 展开，其余收起；后续保留用户操作，但每次打开都确保当前模型所在组展开。已消失的 Provider 在下次构造 picker 时清理。`model-mode` 单独约束高度至 Composer 上方的可用视口，模型浮层内部滚动、无横向溢出；关闭及切换模式会清除专用 class 和高度。

选择模型时立即清空候选并标记 `modelSwitchPending`。Pi 确认 `set_model` 后，无论成功还是失败，都重新获取 `get_state` 与 `get_available_thinking_levels`；两份结果到齐才同步模型、有效思考档位和候选。等待时点击 Thinking 只提示正在读取，不展示旧档位。具体档位完全来自 Pi，不按 `reasoning` 推断。

命令沿用 Pi 原生请求 `id`；前端以 generation 和 workspace generation 关联响应，丢弃旧切换与旧回读（含思考设置的 state 回读）。连续选择时等待在途 `set_model` 确认，再发送最后一次选择，避免异步模型设置反序完成。读取失败不会恢复旧候选；再次点击 Thinking 可重试。未收到 Pi 响应时保持等待，不以定时器伪造完成。

`tests/smoke.cjs` 覆盖折叠记忆、当前项身份、100 模型、反序回读、失败恢复和连续切换。真实 Chrome 场景 `UX-MODEL-01…05` 在 700×600、900×700、1200×800、1536×900 检查内部滚动、视口边界、Composer 不位移、长模型 ID 截断及模型切换后四档 Thinking 候选。
