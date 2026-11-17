# P1–P4 修复的真实渲染证据（2026-11-18）

基线：分支 `feat/ui-pi-desktop-v0220-parity`（从 `main` 的 `a9b6e00` 切出）。
夹具为 `tests/visual-harness.cjs`（离线，不启 Pi、不读用户会话、不写用户数据）。
浏览器为 Windows Chrome 157.0.8103.79，DPR 1。脚本：`node tests/p1-p3-shots.cjs`。

覆盖 1320×820 与 700×600、Dark 与 Light 四种组合，共 **124/124 项断言通过**，页面异常 0。
原始断言、度量与截图清单见 [shots/shots-summary.json](shots/shots-summary.json)。
所有截图均为最终 CSS 下的实际 Chromium 渲染，不是 jsdom 断言。

## P1 设置入口图标

- 入口渲染 Lucide `settings` 齿轮：单 path + 一个 `circle`，`M12.22 2h-.44`、`r=3`。
- 图形 14×14，按钮命中区仍是 28×28；`title`、`aria-label`、`aria-controls`、
  `aria-expanded` 保持不变；键盘可聚焦。
- 点击仍打开既有设置菜单，行为未变。

2026-11-17 的 `sliders-horizontal` 证据已被本节取代。

截图：`shots/p1-settings-icon-*`、`shots/p1-settings-menu-*`。

## P2 顶部会话标题与生成速度

### 会话标题

- 历史会话打开时顶栏显示侧栏列表标题，不再停在「新会话」。
- 切换到另一条历史会话后顶栏立即显示目标标题。
- 行内重命名同时更新顶栏与侧栏当前行。
- 新建会话时旧列表的 current 不会覆盖「新会话」（由 `tests/session-title.cjs` 与
  `tests/smoke.cjs` 覆盖）。

截图：`shots/p2-session-title-current-*`、`shots/p2-session-title-renamed-*`。

### 生成速度（TPS）

上下文浮层的「最近一轮用量」新增 `生成速度` 行。真实浏览器里注入
`message_start → message_end`（450 output / 10.0 s）后显示 `45 tokens/s`；
没有响应时间时显示 `—`，不编造 0 或实时速度。

口径、隔离与缺失值规则见 [usage-quota.md](../../usage-quota.md#生成速度-tps-口径)。
专项测试：`node tests/usage-throughput.cjs`（31/31）。

截图：`shots/p2-tps-context-*`、`shots/p2-tps-unavailable-*`。

## P3 模型上下文容量与欢迎吉祥物

### 上下文容量

同一会话、已用 61.23k token 不变：

| 当前模型 | 容量 | 侧栏 / 浮层 |
| --- | --- | --- |
| DeepSeek V4 Pro | 1M | 6%，`已用 61.23k 标记, 共 1M` |
| Grok 4.7 · OpenCode Go | 256k | 24%，`已用 61.23k 标记, 共 256k` |
| DeepSeek V4 Flash | 200k | 31% |
| Mystery Model（无 contextWindow） | 未知 | `上下文 61.23k / 未知`，浮层说明容量未知 |

切回 Pro 后恢复 6% / 1M。侧栏文字、进度条、圆环、浮层与统计面板均取自同一份
`contextUsage()` 投影。

截图：`shots/p3-context-1m-*`、`shots/p3-context-grok-256k-*`、`shots/p3-context-unknown-*`。

### 欢迎吉祥物

- 无内容的 ready 欢迎态显示原创 100×100 线稿机器人；不进入恢复态、无项目态或已有消息的对话。
- 只用 `currentColor` 与既有 token，无外链图片、无外部运行时请求、无新增依赖。
- 动画为轻微浮动、影子缩放、眨眼与天线呼吸；`prefers-reduced-motion: reduce` 下
  四个动画全部为 `none`，静态画面保留。
- 真实浏览器核对 100×100、`viewBox="0 0 100 100"`、动画名、无 `<image>/<use>/<script>/<foreignObject>`、
  `#welcomeRestore` 中没有吉祥物。

专项测试：`node tests/home-mascot.cjs`（22/22）。

截图：`shots/p3-welcome-mascot-*`、`shots/p3-welcome-mascot-reduced-*`。

## P4 模型 + 思考统一菜单

- 入口合并为一个 chip：模型名（可截断）+ 思考徽标 + chevron；不再有可见的第二个思考按钮。
- 共享 `.pop` 单例，无第二套全局弹层；菜单在 Composer 上方、右对齐，宽度 ≤ 420px，
  左右边缘均在视口内，底部不压住 Composer。
- 左栏为「最近使用 + 已配置供应商」，显示计数；右栏只画当前来源。
- 同名模型按 `providerId + modelId` 判定；跨 Provider 的同名条目不冒充当前项。
- 搜索跨全部供应商，保留输入大小写与焦点，显示匹配数、供应商分组与空状态；
  Escape 先清搜索，再关闭并归还焦点。
- 400+ 模型与超长名称可滚动、截断，不产生横向溢出或元素注入。
- 底部思考滑杆档位完全来自 `S.thinkingLevels`（夹具里 Pro 为 `off/high/max`，
  zhipu 为 `off/low/medium/high`），等宽分段、当前项唯一；pending 时滑杆禁用，
  失败回读会纠正选中态。
- 选择模型/档位仍走既有 `setModel` / `setThinkingLevel`，回读前不乐观改选中态；
  模型切换 pending 时行仍可点，交给既有 `queuedModelSwitch`。

| 场景 | 截图 |
| --- | --- |
| 菜单打开（1320/700 × Dark/Light） | `shots/p4-model-menu-*` |
| 最近使用跨供应商 | `shots/p4-recent-models-*` |
| 同一 Provider 100 个模型 | `shots/p4-multi-provider-*` |
| 跨供应商搜索 | `shots/p4-search-*` |
| 思考滑杆（zhipu 四档） | `shots/p4-thinking-slider-*` |

契约测试：`node tests/ui3-model.cjs`（57/57）；集成：`node tests/smoke.cjs`（1355/1355）。

## 复查方式

```bash
node tests/p1-p3-shots.cjs
node tests/ui3-model.cjs
node tests/usage-throughput.cjs
node tests/home-mascot.cjs
node tests/smoke.cjs
```

`tests/p1-p3-shots.cjs` 需要本机 Chrome/Edge；可用 `UI2C_CHROME` 指定浏览器路径。
夹具只使用 `os.tmpdir()` 与内存数据，不写用户真实项目或 Pi 会话。

## 构建产物

已运行 `npm run build:app -- --rebuild`，产物为 `dist-app/Pi GUI-win32-x64`（整包 333.7 MB）。
核对包内 `public/app.js`、`public/ui/icons.js`、`public/ui3-model-picker.js`、
`public/turn-throughput.js`、`public/usage.js`、`public/index.html` 的 SHA-256 均与源码一致。
