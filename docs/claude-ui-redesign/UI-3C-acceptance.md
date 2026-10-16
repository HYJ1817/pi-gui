# UI-3C：Composer 内联 Slash Command 验收

执行：2026-10-16（本地，Asia/Shanghai）。独立工作区 `C:/pi-GUI-ui3-commands`，分支 `codex/ui3-commands`，共同基线 `d1524cb02f010cf9d474727c212f4048fc9abf75`（本分支创建时 HEAD 即为此值）。本报告只描述内联 Slash 命令菜单（UI-3C）；不含 `@` 文件索引，不改 pi 本体，不推送、不合并 main、不发版。

**结论：C1–C5 已实现并有可复现证据。** 内联菜单通过 `palette-model.js` 的同一份注册表取候选、调用同一份 `run()`；独立命令面板 `palette.js` 完整保留。jsdom 契约 **41/41 通过**，真实 Electron 采集 **13/13 通过、5 张截图**。合成键盘事件不能代替真实中文 IME 的人工终验（见第 8 节）。

## 0. 勘察结论（先读代码，后动手）

| 关注点 | 现有实现 | 本模块如何用 |
|---|---|---|
| 命令注册 / 过滤 | `palette-model.js`：`allCommands(ctx)`、`filterCommands(list,query)`、`normalizeCommand`、动态 provider | **直接调用**，不新增注册表、不复制匹配算法 |
| 可执行性判定 | `when(ctx)`（多为闭包读 `S`，动态命令读 `ctx.query`） | 候选只来自 `allCommands`，`when=false` 压根不出现 |
| 动作执行 | 每个 command 的 `run(ctx)`（`app.js` 装配，直接调既有 handler） | 只调 `cmd.run(ctx)`，**不拼 RPC、不提供 skipConfirm** |
| 独立面板 | `palette.js`（`#paletteLayer`，居中卡片 + 独立搜索框） | **完全不动**，保留 `Ctrl+K` / `Ctrl+Shift+P` 入口 |
| 全局快捷键 | `shortcuts.js`（唯一 document 监听、冲突检测、文本域守卫） | 不注册新快捷键（`Ctrl+/` 已被「快捷键帮助」占用，不能抢） |
| textarea 键盘 | `app.js:891` 的 keydown，**不看 `event.defaultPrevented`** | 提供 `handleKeydown(e)` 供集成层在原有分支前调用并 return（第 6 节） |
| 右栏原生视图 | `right-pane.js`：`#modal/#confirmLayer/#paletteLayer/globalMoreMenu` 可见时经 `onOccluded` 摘除 WebContentsView | 内联菜单**不是全屏遮罩**，按 `--rp-width` 把右边界收在原生视图左边，不冒充能覆盖原生子视图 |

**与任务描述的偏离（以现有代码为准）：** 任务提到「UI-3 规划」「UI-2 集成报告」；仓库里只有 `docs/claude-ui-redesign/UI-2-*`，没有 UI-3 规划文档，故以任务文本 + 现有代码为准。另有两点实现取舍见第 8 节（行首触发、样式由模块自注入）。

## 1. 接口 API

新增 `public/ui/inline-command-menu.js`（无 import 期副作用，只 import `../palette-model.js`）。

```js
import { createInlineCommandMenu, ensureStylesheet, parseSlashTrigger } from './ui/inline-command-menu.js';
```

### `createInlineCommandMenu(options) -> controller`

| 选项 | 默认 | 说明 |
|---|---|---|
| `input` | 必填 | 绑定的 `textarea` |
| `getContext()` | `() => ({})` | 传给 `when(ctx)` / `run(ctx)` 的上下文；与 `query` 合并 |
| `listCommands(ctx)` | `palette-model.allCommands` | 取候选（同一注册表） |
| `filter(list, query)` | `palette-model.filterCommands` | 过滤 |
| `hintFor(cmd)` | `null` | 覆盖右侧提示；默认用 `cmd.hint` |
| `onError(err)` | `console.error` | 命令执行/过滤出错落点 |
| `host` | `input.ownerDocument.body` | 菜单挂载点 |
| `acceptTab` | `true` | 菜单开着时 Tab 是否=接受 |
| `maxItems` | `50` | 列表渲染上限 |
| `injectStyles` | `true` | 是否自注入 `ui3-inline-commands.css` |
| `label` | `'命令'` | listbox 的 `aria-label` |

controller 方法：

| 方法 | 语义 |
|---|---|
| `attach(el?)` | 建 DOM + 挂 `input`/`compositionstart`/`compositionend`/document `mousedown`(capture)/`pi-gui:workspace-generation`/`resize`。幂等 |
| `bindKeyboard(scopeEl?)` | 可选兜底：在 composer 子树捕获阶段挂 keydown，只对绑定 textarea 生效（不是全局永久拦截） |
| `handleKeydown(event) -> boolean` | **集成主入口**；返回 true=本键已消费，调用方须立刻 return |
| `refresh()` | 依当前输入值与光标重算触发/候选 |
| `close({restoreFocus})` | 关菜单、清 aria/缓存；`restoreFocus` 时把焦点还给 textarea |
| `destroy()` | 拆所有监听、DOM、缓存，可再次 `attach()` |
| `isOpen() / isComposing() / items() / activeIndex() / activeCommand() / query() / menuElement() / listElement()` | 只读状态（测试与集成用） |

`ensureStylesheet(doc)` 幂等注入 `<link id="ui3-inline-commands-style">`；`parseSlashTrigger(value, caret)` 是纯函数（可离线单测）。

## 2. 真实命令复用依据

- 候选 = `filterCommands(listCommands({ ...ctx, query }), query)`，`listCommands` 默认就是 `allCommands`。`tests/ui3-inline-commands.cjs` 断言菜单候选与 `palette.allCommands({query:''})` **逐一致**。
- 执行 = 接受时按 id 从**当前**注册表重新取实例并 `fresh.run(ctx)`；找不到就不执行（第 12/13 项）。全程无 `fetch`、无 RPC 拼接（测试断言 `fetches.length===0`）。
- 危险动作：本模块没有 `skipConfirm`/bypass 参数，命令自己该走的 `confirmModal`（如 `restartPi()`）原样发生。
- 「未知/过期命令不发伪造指令」：`items` 只可能来自注册表；接受前再查一次，命令消失即拒绝。

## 3. 输入法与键盘事件契约

触发（`parseSlashTrigger`）：仅当**光标所在行**从行首到光标是 `[ \t]*` + `/` + `[A-Za-z0-9_-]*`，且光标后不接命令词字符。含义：

| 输入 | 是否触发 |
|---|---|
| `/`、`  /`、`第一行\n/` | 是（行首，允许前导空白） |
| `https://x`、`and/or`、`看看 /help` | 否（`/` 前不是行首空白） |
| `C:\Users\me\a/b` | 否（`/` 前是普通字符） |
| `/usr/bin` | 第二个 `/` 出现即关闭 |

键盘（`handleKeydown`，仅菜单开着时生效）：

| 键 | 行为 |
|---|---|
| `ArrowDown` / `ArrowUp` | 移动活动项（环形），`preventDefault`（光标不动） |
| `Enter`（非 Shift） | 接受当前项；`preventDefault+stopPropagation` |
| `Tab`（非 Shift） | 接受当前项（`acceptTab`，默认开）；`Shift+Tab` 不接受 |
| `Escape` | **只关菜单**，`preventDefault+stopPropagation` 冒泡不到 `app.js` 的 `stop()` |
| 鼠标点击/悬停 | 点击执行；悬停设活动项 |
| `Shift+Enter` | 不消费 → Composer 换行 |
| `isComposing===true` / `keyCode===229` | **原地吞掉** Enter/Tab/Escape/方向键（既不接受也不冒泡到 submit），其余键放行 |
| `compositionstart` | 立即关闭菜单、期间 `refresh()` 不动作；`compositionend` 后按当前值重判 |

**为什么 keyCode 229 要「吞掉」而不是放行：** `app.js` 原有 submit 分支只判 `!e.isComposing`，不判 229。若菜单开着却把 229 的 Enter 放行，就会误发聊天。故菜单开着时把 229 的动作键原地消费（`inline-command-menu.js` 的 `handleKeydown`）。

## 4. 新增 DOM / CSS 类

DOM（`createInlineCommandMenu` 建）：

```
div.ui3-inline-menu[data-ui3-inline-menu]      // position:fixed, hidden 切换
  ├ div.ui3-inline-list[role=listbox][aria-label]      // 每次重画
  │   └ div.ui3-inline-item[role=option][aria-selected][data-command-id][data-index]
  │       ├ span.ui3-inline-title
  │       ├ span.ui3-inline-group          // 分组标签
  │       └ span.ui3-inline-hint           // 快捷键/提示（cmd.hint 或 hintFor）
  └ div.ui3-inline-empty[role=status]      // 「没有匹配的命令」
```

输入框 ARIA：开时 `aria-expanded=true`、`aria-controls=<list id>`、`aria-autocomplete=list`、`aria-activedescendant=<active option id>`；关时 `aria-expanded=false` 并移除后三者。

CSS 全部在 `public/ui3-inline-commands.css`，类名统一 `.ui3-inline-*`，颜色只取 `tokens.css` 变量（`--ui-popover-surface` 等），自动跟随 `:root[data-theme]`。含 `prefers-reduced-motion` 分支与 640px 窄屏分支。定位（left/top/width、越界收回、`--rp-width` 右边界）由 JS 实测写在行内样式。

## 5. 测试证据与截图

### 5.1 离线契约 `tests/ui3-inline-commands.cjs`（jsdom，真 `public/index.html`）

实际命令 `node tests/ui3-inline-commands.cjs` → **41/41 通过**，退出 0。覆盖任务列出的 1–14 项与可离线判定的 a11y/CSS 契约（第 15 项的真实排版在 5.2）。要点：

- 输入 `/` / 前导空白 / 换行后触发；失去前缀自动关闭；
- `/query` 实时筛选、无候选显示「没有匹配的命令」空状态；
- URL / Windows 路径 / 正文斜杠 / 行内斜杠不触发；`/usr/bin` 第二个斜杠关闭且从不执行；
- `when(ctx)` 过滤与 `allCommands` 一致；
- ArrowUp/Down（含环形）；Enter/Tab 接受、Shift+Tab 不接受；
- Escape 只关菜单（`stops===0`）；
- IME：组合期不弹、`compositionend` 后重判；`isComposing`/`keyCode 229` 的 Enter 既不执行也不发消息；
- 一次 Enter：`run===1 && submits===0`；菜单关闭后 Enter 仍是既有发送；
- `palette.openPalette()` 仍可打开且列出同一注册表；
- `pi-gui:workspace-generation` 关闭菜单且旧候选不再执行；
- 过期（`when` 变假）/未知（id 消失）候选：不执行、`fetch` 全程为 0；
- destroy 后 DOM/监听/aria 清理，重挂不重复触发；
- `ensureStylesheet` 幂等；CSS 含约定类名与 reduced-motion 分支。

### 5.2 真实 Electron 证据 `docs/claude-ui-redesign/ui3-c-evidence/`

脚本 `capture-electron.cjs`：真实 `electron .`（`--remote-debugging-port` + CDP），全新临时 `PI_GUI_DATA`/`PI_CWD`，真实 input 事件，`Page.captureScreenshot`。实际运行 → **13/13 通过，5 张截图**（`results.json`）：

| 截图 | 场景 | 关键实测 |
|---|---|---|
| `menu-dark.png` | 深色输入 `/` | 22 候选，菜单 x=151 y=430 w=741（贴合 composer 宽），焦点在 textarea |
| `menu-dark-filter.png` | 深色 `/re` | 9 候选，宽度不变 |
| `menu-light.png` | 浅色 `/` | 25 候选，浅色 token 生效（白底深字） |
| `menu-narrow-700.png` | 700px 视口 `/` | x=8 w=264，菜单不越界 |
| `menu-with-browser-pane.png` | 打开右侧原生 Browser 后 `/` | 右栏已开（`paneLeft=900`），菜单右边界 855，**margin=45px**，不与原生视图重叠 |

说明：真实 Electron 窗口 `capturePage` **不包含原生 `WebContentsView` 内容**（原生子视图不在页面合成里），截图里右栏网页区域为空属正常；菜单与右栏边界由几何实测（margin≥0）证明。「深色 22 / 浅色 25 条」是启动早期 `app` 状态尚未完全就绪时 `when()` 的诚实结果差异，不是筛选 bug。

## 6. 集成方需要添加的导入、初始化及事件路由

**必须**（`public/app.js`，集成方修改；本任务不改 app.js）：

1) 顶部 import：

```js
import { createInlineCommandMenu } from './ui/inline-command-menu.js';
```

2) 在命令注册之后（例如 `installShortcuts({})` / `defineCommands([...])` 之后、`el.input` 已存在处）初始化并绑定：

```js
const inlineCommandMenu = createInlineCommandMenu({ input: el.input, getContext: () => ({}) });
inlineCommandMenu.attach();
```

> `getContext` 返回 `{}` 即可：现有 `when()` 多为闭包读 `S`，动态会话命令读 `ctx.query`（由本模块合并注入）。若将来有命令需要更多上下文，在这里补字段。

3) 在**原有** textarea keydown 分支最前面加一行并早退：

```js
el.input.addEventListener('keydown', (e) => {
  if (inlineCommandMenu.handleKeydown(e)) return;   // ← 新增：内联菜单先消费 Enter/Tab/Esc/方向键
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  else if (e.key === 'Escape') { /* ... 原有 ... */ }
});
```

**样式**：无需改 `index.html` —— `attach()` 会幂等注入 `<link href="/ui3-inline-commands.css">`。若集成方偏好静态引入，可在 `<link href="/styles.css">` 之后加 `<link rel="stylesheet" href="/ui3-inline-commands.css">`；`ensureStylesheet` 检测到后不会重复注入。

**可选**：无法改 keydown 的宿主用 `inlineCommandMenu.bindKeyboard()`（在 composer 子树捕获阶段兜底）。切换项目/会话无需手动调用——模块已订阅 `pi-gui:workspace-generation` 自动关闭。

## 7. 分支 HEAD 与未提交文件情况

- 分支 `codex/ui3-commands`，创建时 HEAD = 基线 `d1524cb02f010cf9d474727c212f4048fc9abf75`。
- 新增（未提交时）：
  - `public/ui/inline-command-menu.js`
  - `public/ui3-inline-commands.css`
  - `tests/ui3-inline-commands.cjs`
  - `docs/claude-ui-redesign/ui3-c-evidence/`（`capture-electron.cjs`、`results.json`、5 张 PNG）
  - 本报告 `docs/claude-ui-redesign/UI-3C-acceptance.md`
- **未改**任何受限文件（`app.js`/`composer.js`/`palette.js`/`palette-model.js`/`shortcuts.js`/`index.html`/`styles.css`/`tokens.css`/`rpc.js`/`package.json`/`server`/`electron`）；未改 `package.json`（完整测试由集成方接入 canonical `npm test`）。
- 本地提交，不 push、不 merge main、不发版。精确 HEAD 见本分支 `git log -1`（不写成文档内自引用的哈希）。

## 8. 未解决问题 / 已知取舍

1. **真实中文 IME 终验未做**：jsdom 用合成 `CompositionEvent`/`isComposing`/`keyCode=229` 覆盖了分支逻辑，但真实输入法候选窗、上屏时序仍需人工在真机验收（任务已明示不能以合成事件替代）。本轮只到分支逻辑级。
2. **行首触发是刻意的保守选择**：任务要求「不把 URL/路径/正文斜杠当命令」。本实现限定行首（允许前导空白）且命令词仅 `[A-Za-z0-9_-]`。副作用：在行首敲 POSIX 绝对路径 `/usr` 到第二个 `/` 之前会短暂显示「没有匹配的命令」空状态；不会执行任何命令。若产品要支持正文中 `/`（像某些 CLI），需放宽触发并承担路径误判，本轮不做。
3. **样式自注入 vs 静态 link**：为不改 `index.html` 采用运行时注入，首帧可能有一次极短的无样式窗口（`attach()` 在启动期执行，实际可忽略）。集成方若偏好可改静态 link，二者兼容。
4. **`bindKeyboard` 兜底路径**：真实键盘交互的推荐路径是 `handleKeydown` 早退（app.js 需改一行）。`bindKeyboard` 的捕获阶段兜底已在 jsdom 覆盖绑定/解绑，但未在真实 Electron 里单独驱动验证其 preempt 顺序（主路径已在真实 Electron 走通）。
5. **采集夹具解锁了禁用输入框**：采集时页面无项目、Composer 处于 `is-locked/disabled`，脚本只解锁 textarea 以取得真实打字与排版证据；「when 过滤」由 jsdom 套件单独证明。这不影响生产逻辑。
6. **未接入 canonical 测试**：按任务要求未改 `package.json`；集成方应把 `node tests/ui3-inline-commands.cjs` 加进 `npm test`（本报告不代改）。
