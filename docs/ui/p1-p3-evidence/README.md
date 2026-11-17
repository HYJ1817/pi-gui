# P1–P3 修复的真实渲染证据（2026-11-17）

基线：分支 `fix/ui-settings-session-context`。夹具为 `tests/visual-harness.cjs`（离线，不启 Pi、不读用户会话、不写用户数据）。浏览器为 Windows Chrome 157.0.8103.79，DPR 1。脚本：`node tests/p1-p3-shots.cjs`。

覆盖 1320×820 与 700×600、Dark 与 Light 四种组合，共 68 项断言全部通过，页面异常 0。原始断言、度量与截图清单见 [shots/shots-summary.json](shots/shots-summary.json)。

## P1 设置入口图标

- 入口渲染 `sliders-horizontal`，单 path、无齿轮 circle；SVG 18×18，按钮命中区 28×28。
- `title`、`aria-label`、`aria-controls`、`aria-expanded` 保持不变；键盘可聚焦。
- 点击仍打开既有设置界面。

截图：`shots/p1-settings-icon-*`、`shots/p1-settings-menu-*`。

## P2 顶部会话标题

- 历史会话打开时顶栏显示侧栏列表标题，不再停在「新会话」。
- 切换到另一条历史会话后顶栏立即显示目标标题。
- 行内重命名同时更新顶栏与侧栏当前行。
- 新建会话时旧列表的 current 不会覆盖「新会话」（由 `tests/session-title.cjs` 与 `tests/smoke.cjs` 覆盖）。

截图：`shots/p2-session-title-current-*`、`shots/p2-session-title-renamed-*`。

## P3 模型上下文容量

同一会话、已用 61.23k token 不变：

| 当前模型 | 容量 | 侧栏 / 浮层 |
| --- | --- | --- |
| DeepSeek V4 Pro | 1M | 6%，`已用 61.23k 标记, 共 1M` |
| Grok 4.7 · OpenCode Go | 256k | 24%，`已用 61.23k 标记, 共 256k` |
| DeepSeek V4 Flash | 200k | 31% |
| Mystery Model（无 contextWindow） | 未知 | `上下文 61.23k / 未知`，浮层说明容量未知 |

切回 Pro 后恢复 6% / 1M。侧栏文字、进度条、圆环、浮层与统计面板均取自同一份 `contextUsage()` 投影。

截图：`shots/p3-context-1m-*`、`shots/p3-context-grok-256k-*`、`shots/p3-context-unknown-*`。
