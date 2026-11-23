# P14-C Floating Composer

Composer 保留原有的 `composerBox`、`input` 和所有控制按钮 ID。它是 `.stage` 底部的单个浮动面板，与对话阅读列共用中央轴；阶段 D 改为消费既有 `--ds-composer-width`（760px），底部留 16px。20px 圆角、表面与阴影使用 A 阶段的 `--ds-*` 变量，发送/停止为 28px 圆形控件。对话仍由 `#stream` 独立滚动，底部渐隐不改变滚动或消息状态。

阶段 F 去除命令菜单的遗留 320px 上限，宽度继续由原 `inline-command-menu.js` 按输入框与原生右栏实测，CSS 只保留视口上限。命令菜单、模型及用量浮层消费既有语义文字与选中色，额度警告保留自己的状态色。当前 Composer 没有 `@` 文件补全入口，输入 `@` 仍是普通草稿；文件继续通过 Attach 原流程处理，不以视觉重构增加文件检索能力。实测及差异见 [阶段 F 验收](ui/pi-desktop-reference/19-phase-f-acceptance.md)。

## 高度与滚动

`composer.js` 对 `.composer` 外层建立一个 `ResizeObserver`，把实际高度写入 `.stage` 的 `--composer-reserved-height`。`.thread` 的底部 padding 使用这个变量加少量间隙，因此附件和多行输入增加高度时，末条消息仍能滚到面板上方。Observer 只读外层矩形、只写 CSS 变量。textarea 的 `autoGrow` 仍由原来的 input 事件触发，高度不超过 `min(184px, 24vh)`，超出时在 textarea 内滚动。窗口变小时重新计算上限。

## 控件与业务映射

| 控件 | 现有动作 |
|---|---|
| Attach | 点击同一个隐藏的 `fileInput`，继续由 `handleFiles` 上传和解析 |
| Context | `renderCtxChip` 显示真实百分比，`openCtxTip` 展示已有的上下文、输入、输出、缓存读取和成本字段 |
| Model | `openModelPicker` 使用现有模型列表与 `setModel` |
| Thinking | `openThinkPicker` 使用现有档位与 `setThinkingLevel` |
| Send | `submit`，运行中仍可通过现有路径发送 steer；**停止未确认期间禁用**（`S.stopping`），那时发出去会变成旧 run 的 steer |
| Stop | `stop`，运行时成为视觉上的主要动作；点击后立即进入「正在停止…」，等 Pi 回了权威 abort 应答才落回可发送状态（见下） |

**「正在停止…」是一个独立状态，不是 `S.streaming` 的别名。** Pi 的 abort 应答
（官方语义：等会话变空闲之后才应答）与 `agent_settled` 谁先到都可能，两种顺序下
`streaming` 都会先变 false，所以拿它当「能不能发」的判据就会把新消息变成旧 run 的
steer。界面用 `S.stopping`：点击那一刻置真（发送键禁用、Enter 不提交、再点 Stop 不
重发），只有后端确认（HTTP 应答或 `stop_state` 事件）才落回假，状态栏先说
「正在停止…」、确认后才是「已停止」。超时未确认时保持禁用并在状态栏说明
「停止尚未得到 Pi 确认，请等待或重启 Pi」——**不解除保护**。停止期间输入框里的
字保留，只是不让提交。后端还有一道同样的闸门（`stop_in_progress`），前端禁用不是唯一一层。

附件托盘位于同一个 Composer 表面内：图片／视频为 64×64 本地预览，普通文件为类型图标、真实文件名、大小组成的行内项；媒体优先，文件自然换行，托盘有高度上限并内部滚动，不增加内层卡片或边框。样式唯一归 `attachments.css`，`ui3-composer.css` 和 `styles.css` 不再各持一份附件几何。名称经省略后仍有完整 `title` 和可访问名称；普通文件可用键盘打开既有信息 Popover 查看全文。移除操作随 hover / focus-within 显示，触屏常显。普通文件出现状态文字时，文件信息与移除键固定在首行，状态独占第二行，不会把移除键挤到第三行。

`attachments.js` 持有 intake 与 `S.attachments`：先登记整个批次，再顺序上传；客户端 ID 与原始 File 名称／大小保持稳定，服务端存储名不覆盖展示名。上传失败用 `uploadFailed` 区分，按钮和直接提交两处阻止空引用发送；文本提取失败但已有 `path` 则保留原文件引用。正常文件没有「已就绪」或泛化的能力结论。文件名、状态和模型名继续经 `textContent`；`<pi-file>` 的名称／元信息在组装时转义并写入 `esc="1"` 标记，只有带标记的属性在共用消息视图中解码，旧消息里的字面 `&amp;` 不会被改写。拖入仍走 `dragDepth` 和既有 `handleFiles`，不新增上传协议。每次上传持有 `AbortController`；`pagehide`、移除、工作区／会话切换会使在途批次失效、中止请求，并把未完成项标为真实失败，避免清理后仍继续上传、留下服务端孤儿或重建 Blob URL；`pageshow(persisted)` 只用草稿保留的原始 File 重建本地预览。

`attachment-types.js` 区分展示类型与原生 ImageContent；明确 MIME 优先，缺失或通用 MIME 时才按扩展名补全。仅已有 PNG／JPEG／GIF／WebP／BMP 格式送入 `images`，且实际字节必须匹配文件头；扩展名改成 `.png` 的文本不会作为图像发送。字节不符或图片读取失败时保留已上传路径，按普通文件引用发送，不要求模型具备图片能力。视频以及 SVG／HEIC 等没有新增模型输入声明。PDF／DOCX／文本继续沿后端现有提取链；PPT／Excel／ZIP／视频可附加原文件路径，未提取不等于上传失败，也不代表模型已读内容。

`attachment-preview.js` 仅持有本地 Blob URL、缩略图解码器和打开的公共 Modal：视频跳到短首帧，等待浏览器呈现新帧（`requestVideoFrameCallback`，250ms 兜底）后画入有界 canvas，失败／超时回退视频图标，不阻塞发送。图片／视频点击进入本地预览，Escape 关闭回焦；移除、成功发送、工作区／会话切换和页面退出释放资源。切换使在途批次失效，旧结果不追加到新会话；不写真实会话、不改变 Pi schema。无项目时仍由 `applyProjectState` 锁定输入区。

## 弹层、键盘和窄屏

Model、Thinking 和 Context 共用 `ui/popover.js`，优先放在 Composer 上方。选项是可聚焦的 button；触发按钮维护 `aria-expanded` 和 `aria-controls`，当前项有 `aria-current`。Escape 关闭选择器并把焦点还给触发按钮。输入框原有的 Enter 发送、Shift+Enter 换行、IME 合成时不发送、Escape 停止行为不变。700px 下各控件仍在同一行，通过缩小间距和模型名截断保持可用；700×600 下 textarea 高度受视口约束。

阶段 D 修复了 Context 焦点仍在触发按钮时 Escape 无法关闭的问题，继续使用同一个 Popover。Runtime 保留自己的 owner、原生选择器及草稿通道，只统一表面、字体和动作尺寸；只读历史中的发送保护不变。详细源码与实测证据见 [阶段 D 记录](ui/pi-desktop-reference/14-phase-d-implementation.md)。

## 验证与边界

附件紧凑化的官方 T3 源码对照、当前证据和限制见 [附件验收](attachments-acceptance.md)。`npm run test:attachments` 已纳入 canonical；`npm run test:attachments:electron` 为正常沙箱的独立真实布局／交互专项，`node tests/attachments-packaged.cjs <构建根>` 检查 App 与 SEA 的上传、解析及前端摘要。完整 canonical 仍按测试政策单独提供，不以这些专项代替。

以下 P14 历史验证只描述原阶段，不代表后续附件改动也已被其当时证据覆盖。

`npm run test:ui` 检查控件、键盘和高度同步；`npm run shots:harness` 的 86–104 场景用真实 Chrome 检查面板同轴、控件边界、弹层位置、textarea 内滚动、附件、运行/锁定状态、四档宽度和长文本。P14-A/B 的 57–85 场景保持原样。此轮没有改发送协议、上传格式、附件解析器、Agent 生命周期或 Conversation 消息业务语义，也没有新增无真实 handler 的入口。

P14-E 统一了灰阶控件：Send 用较亮的中性背景表达主操作，Stop 用深灰背景与文字标识，Model / Thinking / Context 和 Popover 选中项不使用黄色。焦点环仍保持高对比度；正常 Context 用量为灰色，超过阈值才显示语义色。hover 只轻微改变背景，不缩放发送按钮。

## 模型 Provider 折叠与思考档位同步

模型列表仍来自 `S.models`，按 Provider 分组。每组头是整行可点击的 button，显示方向箭头、Provider 名和模型数量，并用 `aria-expanded` / `aria-controls` 关联安全的序号 ID。模型项继续复用 `popItem`；当前项优先以 Provider + id 判断，只有 state 缺 Provider 时才退回 id / name。Provider 名只经 `textContent` 写入。

展开状态只存在 `app.js` 的运行期集合中：初次打开仅当前 Provider 展开，其余收起；后续保留用户操作，但每次打开都确保当前模型所在组展开。已消失的 Provider 在下次构造 picker 时清理。`model-mode` 单独约束高度至 Composer 上方的可用视口，模型浮层内部滚动、无横向溢出；关闭及切换模式会清除专用 class 和高度。

选择模型时立即清空候选并标记 `modelSwitchPending`。Pi 确认 `set_model` 后，无论成功还是失败，都重新获取 `get_state` 与 `get_available_thinking_levels`；两份结果到齐才同步模型、有效思考档位和候选。等待时点击 Thinking 只提示正在读取，不展示旧档位。具体档位完全来自 Pi，不按 `reasoning` 推断。

命令沿用 Pi 原生请求 `id`；前端以 generation 和 workspace generation 关联响应，丢弃旧切换与旧回读（含思考设置的 state 回读）。连续选择时等待在途 `set_model` 确认，再发送最后一次选择，避免异步模型设置反序完成。读取失败不会恢复旧候选；再次点击 Thinking 可重试。未收到 Pi 响应时保持等待，不以定时器伪造完成。

`tests/smoke.cjs` 覆盖折叠记忆、当前项身份、100 模型、反序回读、失败恢复和连续切换。真实 Chrome 场景 `UX-MODEL-01…05` 在 700×600、900×700、1200×800、1536×900 检查内部滚动、视口边界、Composer 不位移、长模型 ID 截断及模型切换后四档 Thinking 候选。
