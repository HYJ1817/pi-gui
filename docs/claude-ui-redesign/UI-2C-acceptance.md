# UI-2C 实施与验收报告（聊天视觉 / 布局 / 响应式 / 轻量动效）

日期：2026-10-16（Asia/Shanghai）。独立工作区 `C:/pi-GUI-ui2-visual`，分支 `codex/ui2-visual`，基线 `d0585b89a81c0a93e894d58b9d078af75aa985b2`。本轮在该分支上做**本地提交**（不 push / merge / 发版）。

**结论：UI-2C 的 CSS 改造、专项视觉自检、真实 Electron 与整套回归已完成并通过；末轮已按 A/B 的**实际代码**（非报告）补齐组件接口样式。** 全程只动一个产品文件（`public/styles.css`）与一个测试套件（`tests/ui2-visual.cjs`），未改任何 JS、DOM、`index.html`、`tokens.css`、Electron、server 或 `package.json`。

分两轮交付：

1. **首轮**：聊天阅读轴 / 正文排版 / 工具组卡片 / 响应式 / 轻量动效（样式层的主体改造）。
2. **末轮（组件接口收口）**：只读核对 A（`messages.js`/`tool-view.js`/`message-meta.js`）与 B（`runtime-conversation.js`）**实际生成的 DOM/class/`data-*`/ARIA**，把 CSS 里原先按任务书「预留」的类名换成对真实结构的适配（第 11 节）。**未扩大开发范围**，未动 A/B 的 JS。

## 1. 范围、并行约束与只读基线

本工作区是本轮三并行 Agent 中的 **Agent C**。允许改动被严格限定为：`public/styles.css`、新增 `tests/ui2-visual.cjs`、以及本报告与自己的证据目录 `docs/claude-ui-redesign/ui-2-c-evidence/`。

**刻意不去碰的文件**（其中多数属并行 Agent A/B 或 UI-1 的边界）：`public/messages.js`、`public/tool-view.js`、`public/runtime-conversation.js`、`public/index.html`、`public/tokens.css`、`public/theme.js`、`electron/`、`server/`、`package.json`。因此：

- 本套件**没有挂进 `package.json` 的 test 链** —— 合并时由合并方统一接入（见第 10 节）。这既是并行期的隔离要求，也避免与 A/B 争抢同一入口。
- token、主题与基础表面来自 UI-1（`public/tokens.css`），本阶段**只消费、不新增第二套真值**。

基线核对：`public/tokens.css`、`public/theme.js`、`electron/theme.cjs` 等受保护文件与基线一致；`git status` 除本报告所属文件外无其他改动。测试只写 `os.tmpdir()` 下的 fixture，对真实项目/真实会话只做只读验证。

## 2. 实际文件与变化

| 文件 | 实际修改 |
|---|---|
| `public/styles.css` | **160 insertions / 25 deletions**（相对基线 `d0585b8`，`git diff --numstat`）；花括号 1274/1274 平衡；2755 行、149820 字节。区域清单见第 3 节，末轮新增见第 11 节 |
| `tests/ui2-visual.cjs` | 442 行；自起 `tests/visual-harness.cjs`（`HARNESS_PORT=0` 随机端口）+ 无头 Chrome CDP，**57 条 claim**（首轮 43 + 末轮 14），输出 `report.json` 与场景截图 |
| `docs/claude-ui-redesign/ui-2-c-evidence/{cdp,electron,electron-runtime}` | 本报告的证据目录（截图 + `report.json`） |

没有全局正则替换，没有新增依赖，没有改任何 JS 行为。动效全部走 CSS，利用的是「`display:none → 非 none` 时 CSS animation 自动重播」这一浏览器语义，**JS 侧仍是纯 `[hidden]` 切换，一行都不用改**。

## 3. CSS 区域清单（都改在 `public/styles.css`）

1. **阅读轴变量（顶部 `:root`）**：新增 `--ui-prose-width:768px`，并把 `--conversation-max-width`、`--composer-max-width` 都指向它；`--turn-gap` 34→36。校对理由见第 4 节。
2. **消息正文排版**：`.msg-role` 10→11px；用户气泡 `.msg.user .msg-body` 圆角 12→`var(--ui-radius-bubble)`(18px)、padding 9/13→10/16、字号 `var(--ui-font-prose)`、行高 1.75；助手正文同样上 `--ui-font-prose` + 1.75；`h4` 用 prose 字级 + 600；`pre.code` 圆角改 `var(--ui-radius-card)`(8px)；行内 `code` 边框由 `--line` 改 `--line-soft`，字号 12→12.5；列表/引用/段落间距微调。
3. **工具调用组 `.tl-*`**：`.tl-group` 从「左竖线列 + 圆角小药丸行」改成 **hairline 圆角卡片**（`--ui-radius-card`、`--line-soft` 边框、`--ui-user-surface` 底），行间用 `.tl-list>.tl-item+.tl-item{border-top:1px solid var(--line-soft)}` 分隔；`.tl-item:hover` 从圆角小药丸改为填满行宽（与容器圆角一致），`.tl-item.open` 底色由 `--ui-user-surface` 改 `--ui-selected`。**全部 `.tl-*` 选择器名与 `data-status` 语义原样保留，A 侧不需要改类名。**
4. **A/B 组件接口类（首轮按任务书预留，末轮对真实代码校正）**：`.ui2-tool-summary`（A 的组头原生 button，含重置 / `::before` 折叠图标 / `focus-visible`）、`.ui2-tool-state`（A 的组级状态计数）、`.ui2-msg-meta` + `.ui2-msg-meta-item`（A 的消息用量条）、`.ui2-think-status` + `.think[data-state]`（A 的思考状态）、`.ui2-runtime-thinking*` / `.ui2-runtime-usage` / `.ui2-runtime-tools` / `.ui2-runtime-tool[data-state]`（B 的 Runtime 展示）。**逐条对应关系与新增规则见第 11 节。**
5. **Runtime 会话**：`.runtime-conversation` max-width 跟随新的 768 轴、gap 10→12；`.rtc-output` 上 `--ui-font-prose` + 行高 1.75；`textarea` 加 border-color 过渡。
6. **轻量动效**：`ui2-fade-in`（think 正文 / 附件正文 / `.tl-more`）与 `ui2-rise-in`（`.thread>` 下的消息/工具组/note/working，3px 上浮、200ms 缓出）；文件最末的 `prefers-reduced-motion` 块关掉这两类装饰动效，但**保留 spinner / `tl-breathe` 状态指示**（那是必要动效）。

## 4. 检查点 C1–C5 覆盖

| 检查点 | 落实 | 自检 claim |
|---|---|---|
| C1 阅读轴与正文 | `--ui-prose-width=768`；正文=UI-1 `--ui-font-prose`(14px)/1.75；气泡 18px 圆角 + 端点内距 ≥16px；短气泡收缩贴右缘、长气泡 ≤76% | 8 条 |
| C2 工具组视觉 | 连续调用收进 hairline 卡片；行间 1px 分隔；行高保持 30px 紧凑体量；详情展开有内容高度 | 6 条 |
| C3 Runtime | 转录跟随正文字级；Runtime 会话跟随 768 轴；预留 runtime 状态/元信息类 | 4 条 |
| C4 响应式 | 700/900/1200/1536 四个宽度 ×（无横向溢出 / 阅读列居中收在轴内 / 长代码块内部滚动 / 气泡在列内） | 16 条 |
| C5 动效 | 落场动画挂着；展开淡入（display 切换自动重播）；运行态呼吸保留；reduced-motion 关闭装饰动效但内容仍可直接显示 | 5 条 |
| 预留 | `.ui2-tool-summary` / `.ui2-chev` / `.ui2-msg-meta` / `.ui2-runtime-status[running]` / `.ui2-runtime-meta` | 5 条 |
| C6 A/B 真实 DOM（末轮） | A：summary 按钮重置 / focus-visible / 折叠图标旋转 / tool-state / msg-meta-item / think[data-state]；B：thinking-body 换行不溢出 / usage / tools 纵排 / tool[data-state] 三态 + 未知回落 | 14 条 |

合计 **57/57 通过**（[cdp/report.json](ui-2-c-evidence/cdp/report.json)）。

## 5. Token 使用（只消费 UI-1 语义 token）

本阶段未新增任何 token，全部 `var()` 引用自 `public/tokens.css`：

- 几何/材质：`--ui-radius-bubble`(18px)、`--ui-radius-card`(8px)、`--ui-radius-control`(6px)、`--ui-user-surface`、`--ui-selected`、`--ui-code-surface`、`--line-soft`、`--hover`。
- 字级/动效：`--ui-font-prose`(14px)、`--ui-duration-snap`(120ms)、`--ui-duration-base`(200ms)、`--ui-ease-out`。
- 状态色：`--run` / `--ok` / `--warn` / `--err`。末轮已按真实 `data-*` 取值校准 —— A 的 `.tl-item[data-status]` 与 `.think[data-state]`、B 的 `.ui2-runtime-tool[data-state]`（仅 running/done/error）都只给**代码里真实存在**的状态着色，遇到未见过的值回落 `--t2`（三值：是/否/未知，未知不定罪）。

## 6. 真实 Electron 与截图证据

| 套件 | 实际结果 | 证据 |
|---|---|---|
| UI-2C 专项自检 | **57/57，失败 0**，CDP 端口 9226，17 张场景截图 | [cdp/report.json](ui-2-c-evidence/cdp/report.json) 及同目录 `c1-…`、`c2-…`、`c4-width-*`、`c5-final.png`、`c6-ab-dom.png` |
| 主题 Electron（dark/light × 700/900/1200/1536 × 侧栏开/关 × 右栏关闭/Changes/Browser，另 zoom、System、重载/重建、最大化/还原、reduced-motion） | **489/489，失败 0，renderer/harness errors 0，63 张截图**（末轮改样式后重跑） | 我的 CSS 下现跑的矩阵：[ui-2-c-evidence/electron/](ui-2-c-evidence/electron/)（dark/light 各宽度） |
| Runtime Electron（真实 Electron + 生产 server + 真实临时 Git/进程） | **170/170，43 张截图**（末轮改样式后重跑，证据输出到临时目录） | [ui-2-c-evidence/electron-runtime/](ui-2-c-evidence/electron-runtime/) |
| smoke | **1338/1338，失败 0**（原数量不变） | 见第 8 节 |
| dev-server | **30/30，退出 0** | 见第 8 节 |
| theme | **47/47，失败 0** | 见第 8 节 |

**浅色目视**：`electron/light-1200-sidebar-open-closed.png` 中正文列居中、hairline 工具卡片、`读取文件/执行命令` 的绿勾-红叉状态色在浅色下清晰；`electron/light-700-sidebar-open-changes.png` 中窄屏下左栏压缩、右栏覆盖式 Changes，无深色残留。**Runtime**：`electron-runtime/p32-3/running-B-*.png` 的独立会话面板与 `electron-runtime/p32-4/e-central-*.png` 的 Runtime 对话表面未因本次 CSS 出现排版破损或溢出。

## 7. 与 Claude 实机截图的对照与未解视觉问题

对照 `C:\Users\21022\OneDrive\图片\claude\` 与设计素材 `C:\Users\21022\AppData\Local\Temp\opencode\ui2c\design\`：

- **已对齐**：正文阅读轴收窄到与输入框同宽（Claude 实机正文列与 composer 几乎同轴，旧实现的 920/888 的 32px 差是历史而非设计）；用户气泡 18px 圆角 + 足够端点内距；工具调用从「缩进竖线」改为「hairline 分组卡片」，观感更接近「这一组做了什么」。
- **未解 1（字号校准）**：正文字号取 UI-1 的 `--ui-font-prose` = **14px**，而 Claude 实机截图正文目测更接近 **15px**。本轮**刻意不在 styles.css 里硬编码 15px** —— 那会造出与 `tokens.css` 并存的第二套字级真值。若后续要校准，**唯一正确落点是 `public/tokens.css` 的 `--ui-font-prose`**，改一处即可，本文件所有消费点自动跟随。
- **未解 2**：`--ui-prose-width` 定为 768px 是基于实机输入框实测 767px 的近似；不同 DPI / zoom 下的最优行宽未做逐点采样。

## 8. 回归与 A/B 差分

在改动前后对同一套 cdp-shot 场景做 A/B（`u2cbase` = 基线的 stash 版本，`u2cmine` = 本次版本），两版日志各 937 行：

- **失败 claim 集合完全一致：11 条**，且与 CSS 无关：
  - 1 条 `UX-MENU-02-project-menu-open: 结构判据不成立`（DOM 级 `role=menu`/menuitem，非 CSS）；
  - 10 条 `UX-08/UX-09 … 背景色不对：rgb(17, 17, 17)` —— cdp-shot 里硬编码期望顶栏 `#0d0d0d`，而 **UI-1 在 commit `61fddf4` 已把 `--ui-titlebar` 改成 `#111111`**。`git show d0585b8:public/tokens.css` 静态确认基线即 `#111111`，故这 10 条是**预先存在的陈旧断言**，不是本次回归。
- 两版之间**没有任何断言名级别的差异**（新增或转红）。差异只出现在 PASS 行内部的几何数值：例如 composer 靠右锚点 `anchorRight` 1188→1128、气泡矩形 ±3–6px —— 正是阅读轴 920→768（含 72px 装订距）带来的预期位移。

其余回归（末轮再次现跑）：`smoke 1338/1338`、`dev-server 30/30`、`theme 47/47`、`ui2-visual 57/57`、`theme-electron 489/489`、`runtime-electron 170/170`，失败均为 0。**断言总数没有下降**；`ui2-visual` 是纯新增，未替换任何旧断言。

## 9. 分支、SHA 与回退

- 分支：`codex/ui2-visual`；基线 `d0585b89a81c0a93e894d58b9d078af75aa985b2`。本轮产出为分支上的**本地提交**（不 push/merge/发版）；最终 SHA 见交付回复（文档自身在本提交内，写死会自指）。
- 回退：本阶段是一个纯展示边界 —— 回退只需还原 `public/styles.css` 到基线、移除 `tests/ui2-visual.cjs` 与 `ui-2-c-evidence/`。**不涉及任何数据/session 迁移**，无需全仓 reset/clean，也不触碰 A/B 的文件。

## 10. 集成注意事项（交给合并方）

1. **入口接入**：`tests/ui2-visual.cjs` 尚未挂进 `package.json`（并行期隔离要求）。合并时把它加进 test 链即可；它自起 harness（`HARNESS_PORT=0`）与无头 Chrome，不依赖真 pi、不依赖固定端口。
2. **与 UI-2A/B 的接口**：A/B 的 DOM 已按各自实际代码适配（第 11 节给出类名 → 规则对应表）。合并后**无需再改样式**：A 直接生成 `button.tl-group-head.ui2-tool-summary`、`span.ui2-tool-state`、`footer.ui2-msg-meta`、`.think[data-state]`；B 直接生成 `.ui2-runtime-thinking*` / `.ui2-runtime-usage` / `.ui2-runtime-tools` / `.ui2-runtime-tool[data-state]`。`.ui2-chev` / `.ui2-runtime-meta` / `.ui2-runtime-status` 是预留兼容类，**A/B 均未使用**，保留但不算适配证据。
3. **字号校准**：若采纳 15px 正文，改 `public/tokens.css` 的 `--ui-font-prose` 一处（见第 7 节未解 1），不要在 styles.css 另写字号。
4. **cdp-shot 陈旧断言**：第 8 节的两类预先存在失败（`#0d0d0d` 顶栏、UX-MENU-02）**不在本阶段范围内**，合并方可根据需要单独更新那两条期望值（它们与 UI-1 的 token 变更 / DOM 断言有关，不属于 UI-2C）。
5. **必须重建产物**：本次改的是 `public/`，按仓库约定，要让用户看到新排版需 `npm run build:exe` / `npm run build:app -- --rebuild`；跑源码版（dev server）也能直接看到。

## 11. 末轮：与 A/B 真实 DOM 的接口适配（类型 C 收口）

**方法：只读 A/B 工作区的源文件本身**（`C:\pi-GUI-ui2-classic\public\*`、`C:\pi-GUI-ui2-runtime\public\*`），不用报告里写的类名当既定事实。两个分支**均不合并**进 C 工作区。

### 11.1 A（Classic）真实结构 → C 侧规则

| A 的真实生成点 | 元素 / 属性 | C 侧规则 |
|---|---|---|
| `tool-view.js:343` | `button.tl-group-head.ui2-tool-summary`（`aria-expanded`/`-controls`/`-describedby`） | `.ui2-tool-summary`：原生 button 重置（`border:0;background:transparent;font:inherit`）+ `:hover` + `:focus-visible`（2px 焦点环） |
| —— A 的按钮里**没有 chevron 元素** | —— | `.ui2-tool-summary::before`：CSS 画折叠角标，`[aria-expanded=false]` 时 `rotate(-45deg)`（展开朝下 45°、折叠朝右）。A 的结构契约明确授权由 C 绘制 |
| `tool-view.js:348` | `span.ui2-tool-state`（`role=status`，单项组 `hidden`） | `.ui2-tool-state`：10.5px / `--t3`，与组头左缘对齐 |
| `tool-view.js:174,325` | `.tl-item[data-status]` ∈ running/success/error/incomplete/interrupted/cancelled/unknown | 首轮已有的 `.tl-item[data-status=…] .tl-dot`（`--run`/`--ok`/`--err`/`--warn`/`--t2`）——与真实值完全一致，未改 |
| `tool-view.js:368` | `.tl-group.is-collapsed` | 折叠真相仍是 `list.hidden`+`aria-expanded`；C 不额外加样式 |
| `messages.js:183,195` | `.think[data-state]` + `span.ui2-think-status`；state ∈ streaming/returned/complete/error/interrupted | `.think[data-state=error] .ui2-think-status{color:--err}`、`[data-state=interrupted]{color:--warn}`（只强调真实的两态） |
| `message-meta.js:15,19` | `footer.ui2-msg-meta` / `span.ui2-msg-meta-item[data-kind]` | `.ui2-msg-meta`（11.5px / `--t3` / flex 换行 / `margin-top:6px`）、`.ui2-msg-meta-item`（`white-space:nowrap` + `font-variant-numeric:tabular-nums` 数字对齐） |

### 11.2 B（Runtime）真实结构 → C 侧规则

| B 的真实生成点 | 元素 / 属性 | C 侧规则 |
|---|---|---|
| `runtime-conversation.js:135-137` | `details.ui2-runtime-thinking` > `summary.ui2-runtime-thinking-head` + `pre.ui2-runtime-thinking-body` | `.ui2-runtime-thinking` / `-head`（可点、`:focus-visible`）/ `-body` |
| **B 的已知缺陷** `runtime-conversation.js:137`（`<pre>` 默认 `white-space:pre`） | 长思考文本撑出容器横向滚动 | `.ui2-runtime-thinking-body{white-space:pre-wrap;overflow-wrap:anywhere;...}` —— **本轮修掉**（第 6 节截图与断言双证） |
| `runtime-conversation.js:144` | `p.ui2-runtime-usage` | `.ui2-runtime-usage`：11.5px / `--t3` |
| `runtime-conversation.js:148` | `div.rtc-state.ui2-runtime-tools` | `.ui2-runtime-tools`：`display:flex;flex-direction:column`；项间是**纯空白文本节点**（`runtime-conversation.js:323`），flex 下自动消失 —— 因此 C **不加任何分隔符 `content`**（遵守 B 的交付约束） |
| `runtime-conversation.js:324-326`、`TOOL_STATE:53` | `span.ui2-runtime-tool[data-state]`，state ∈ **running/done/error**（仅此三种） | `.ui2-runtime-tool[data-state=running|done|error]` → `--run`/`--ok`/`--err`；未知值回落 `--t2` |

### 11.3 预留但**未被使用**的类（保留为兼容扩展，不算适配证据）

| 类名 | 谁用 | 结论 |
|---|---|---|
| `.ui2-chev` | 无人 | A 的折叠图标是内联 svg（`.think-head`）且摘要按钮不含 chevron 元素；保留 |
| `.ui2-runtime-meta` | 无人 | B 用的是 `.ui2-runtime-usage`；保留 |
| `.ui2-runtime-status` | 无人 | B 用 `.rtc-state` 表达生命周期、用 `.ui2-runtime-tool[data-state]` 表达工具态；保留 |

### 11.4 测试与未完成项

- 新增 **14 条 claim**（`c6-ab-dom` 场景），断言「真实结构的 computed style」：A 的按钮重置 / focus-visible 规则 / 折叠图标旋转 / 组状态字号 / 元信息数字对齐 / think 错误态色；B 的 `pre-wrap`+`anywhere` / 长文本不横向滚动 / usage 字号 / tools 纵排 / 工具三态色 / **未知 `data-state` 不着色**。套件合计 **57/57**。
- **未完成（交集成阶段）**：本轮只在 C 工作区验证，**A/B 的代码没有合进来**，所以「A/B + C 三者组合后的真实 Electron 截图」不在本轮证据里 —— 需在集成分支上跑 `theme-electron` / `runtime-electron` 与 A 的 `ui2-classic.cjs --electron` 复核排版。本轮的 14 条断言是**合成真实结构**（照 A/B 的 DOM 形状）而非真实组合渲染，这一层已经说明清楚，不冒充已完成的集成验收。
