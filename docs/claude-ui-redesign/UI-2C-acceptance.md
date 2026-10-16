# UI-2C 实施与验收报告（聊天视觉 / 布局 / 响应式 / 轻量动效）

日期：2026-10-16（Asia/Shanghai）。独立工作区 `C:/pi-GUI-ui2-visual`，分支 `codex/ui2-visual`，基线 `d0585b89a81c0a93e894d58b9d078af75aa985b2`（未提交新 commit，HEAD 仍是该基线）。

**结论：UI-2C 的 CSS 改造、专项视觉自检、真实 Electron 与整套回归已完成并通过。** 本轮只动了一个产品文件（`public/styles.css`）与一个新测试套件（`tests/ui2-visual.cjs`），Event 未改任何 JS、DOM 或 `index.html`。**本轮在本地提交后停止，不 push、不 merge、不发版、不改版本号。**

## 1. 范围、并行约束与只读基线

本工作区是本轮三并行 Agent 中的 **Agent C**。允许改动被严格限定为：`public/styles.css`、新增 `tests/ui2-visual.cjs`、以及本报告与自己的证据目录 `docs/claude-ui-redesign/ui-2-c-evidence/`。

**刻意不去碰的文件**（其中多数属并行 Agent A/B 或 UI-1 的边界）：`public/messages.js`、`public/tool-view.js`、`public/runtime-conversation.js`、`public/index.html`、`public/tokens.css`、`public/theme.js`、`electron/`、`server/`、`package.json`。因此：

- 本套件**没有挂进 `package.json` 的 test 链** —— 合并时由合并方统一接入（见第 10 节）。这既是并行期的隔离要求，也避免与 A/B 争抢同一入口。
- token、主题与基础表面来自 UI-1（`public/tokens.css`），本阶段**只消费、不新增第二套真值**。

基线核对：`public/tokens.css`、`public/theme.js`、`electron/theme.cjs` 等受保护文件与基线一致；`git status` 除本报告所属文件外无其他改动。测试只写 `os.tmpdir()` 下的 fixture，对真实项目/真实会话只做只读验证。

## 2. 实际文件与变化

| 文件 | 实际修改 |
|---|---|
| `public/styles.css` | **118 insertions / 25 deletions**（`git diff --numstat`）；花括号 1257/1257 平衡；2713 行、146798 字节（改前同文件 ~140087 字节）。见第 3 节的区域清单 |
| 新 `tests/ui2-visual.cjs` | 341 行；自起 `tests/visual-harness.cjs`（`HARNESS_PORT=0` 随机端口）+ 无头 Chrome CDP，**43 条 claim**，输出 `report.json` 与 15 张场景截图 |
| 新 `docs/claude-ui-redesign/ui-2-c-evidence/{cdp,electron,electron-runtime}` | 本报告的证据目录（截图 + `report.json`） |

没有全局正则替换，没有新增依赖，没有改任何 JS 行为。动效全部走 CSS，利用的是「`display:none → 非 none` 时 CSS animation 自动重播」这一浏览器语义，**JS 侧仍是纯 `[hidden]` 切换，一行都不用改**。

## 3. CSS 区域清单（都改在 `public/styles.css`）

1. **阅读轴变量（顶部 `:root`）**：新增 `--ui-prose-width:768px`，并把 `--conversation-max-width`、`--composer-max-width` 都指向它；`--turn-gap` 34→36。校对理由见第 4 节。
2. **消息正文排版**：`.msg-role` 10→11px；用户气泡 `.msg.user .msg-body` 圆角 12→`var(--ui-radius-bubble)`(18px)、padding 9/13→10/16、字号 `var(--ui-font-prose)`、行高 1.75；助手正文同样上 `--ui-font-prose` + 1.75；`h4` 用 prose 字级 + 600；`pre.code` 圆角改 `var(--ui-radius-card)`(8px)；行内 `code` 边框由 `--line` 改 `--line-soft`，字号 12→12.5；列表/引用/段落间距微调。
3. **工具调用组 `.tl-*`**：`.tl-group` 从「左竖线列 + 圆角小药丸行」改成 **hairline 圆角卡片**（`--ui-radius-card`、`--line-soft` 边框、`--ui-user-surface` 底），行间用 `.tl-list>.tl-item+.tl-item{border-top:1px solid var(--line-soft)}` 分隔；`.tl-item:hover` 从圆角小药丸改为填满行宽（与容器圆角一致），`.tl-item.open` 底色由 `--ui-user-surface` 改 `--ui-selected`。**全部 `.tl-*` 选择器名与 `data-status` 语义原样保留，A 侧不需要改类名。**
4. **预留类（A/B 未合入的 DOM）**：`.ui2-tool-summary` / `.ui2-chev`（12px 次级色，`[aria-expanded=true]` 时旋转 90°）、`.ui2-msg-meta`（11.5px 弱化条）、`.ui2-runtime-meta` / `.ui2-runtime-status[data-state=…]`（见第 5 节）。这些规则**刻意不依赖 `.tl-*`**，A/B 的 DOM 挂在哪一层都能用。
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

合计 **43/43 通过**（[cdp/report.json](ui-2-c-evidence/cdp/report.json)）。

## 5. Token 使用（只消费 UI-1 语义 token）

本阶段未新增任何 token，全部 `var()` 引用自 `public/tokens.css`：

- 几何/材质：`--ui-radius-bubble`(18px)、`--ui-radius-card`(8px)、`--ui-radius-control`(6px)、`--ui-user-surface`、`--ui-selected`、`--ui-code-surface`、`--line-soft`、`--hover`。
- 字级/动效：`--ui-font-prose`(14px)、`--ui-duration-snap`(120ms)、`--ui-duration-base`(200ms)、`--ui-ease-out`。
- 状态色（runtime 预留类）：`--run` / `--ok` / `--warn` / `--err`，按 `[data-state=running|ready|ok|stopping|warn|error]` 取色，未知值回落 `--t2`（三值：是/否/未知，未知不定罪）。

## 6. 真实 Electron 与截图证据

| 套件 | 实际结果 | 证据 |
|---|---|---|
| UI-2C 专项自检 | **43/43，失败 0**，CDP 端口 9226，15 张场景截图 | [cdp/report.json](ui-2-c-evidence/cdp/report.json) 及同目录 `c1-…`、`c2-…`、`c4-width-*`、`c5-final.png` |
| 主题 Electron（dark/light × 700/900/1200/1536 × 侧栏开/关 × 右栏关闭/Changes/Browser，另 zoom、System、重载/重建、最大化/还原、reduced-motion） | **489/489，失败 0，renderer/harness errors 0，63 张截图** | 我的 CSS 下现跑的矩阵：[ui-2-c-evidence/electron/](ui-2-c-evidence/electron/)（dark/light 各宽度） |
| Runtime Electron（真实 Electron + 生产 server + 真实临时 Git/进程） | **170/170，43 张截图** | [ui-2-c-evidence/electron-runtime/](ui-2-c-evidence/electron-runtime/)（`p32-3` / `p32-4`） |
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

其余回归（改动后现跑）：`smoke 1338/1338`、`dev-server 30/30`、`theme 47/47`、`ui2-visual 43/43`、`theme-electron 489/489`、`runtime-electron 170/170`，失败均为 0。**断言总数没有下降**；`ui2-visual` 是纯新增，未替换任何旧断言。

## 9. 分支、SHA 与回退

- 分支：`codex/ui2-visual`；基线/HEAD：`d0585b89a81c0a93e894d58b9d078af75aa985b2`。本轮产出为**本地提交**（不 push/merge/发版）。
- 回退：本阶段是一个纯展示边界 —— 回退只需还原 `public/styles.css` 到基线、移除 `tests/ui2-visual.cjs` 与 `ui-2-c-evidence/`。**不涉及任何数据/session 迁移**，无需全仓 reset/clean。

## 10. 集成注意事项（交给合并方）

1. **入口接入**：`tests/ui2-visual.cjs` 尚未挂进 `package.json`（并行期隔离要求）。合并时把它加进 test 链即可；它自起 harness（`HARNESS_PORT=0`）与无头 Chrome，不依赖真 pi、不依赖固定端口。
2. **与 UI-2A/B 的接口**：A/B 落 DOM 时直接使用第 3.4 节的预留类名（`.ui2-tool-summary`/`.ui2-chev`/`.ui2-msg-meta`/`.ui2-runtime-meta`/`.ui2-runtime-status[data-state=…]`），CSS 已备好，无需再改样式；`data-state` 未知取值会回落 `--t2`，安全。
3. **字号校准**：若采纳 15px 正文，改 `public/tokens.css` 的 `--ui-font-prose` 一处（见第 7 节未解 1），不要在 styles.css 另写字号。
4. **cdp-shot 陈旧断言**：第 8 节的两类预先存在失败（`#0d0d0d` 顶栏、UX-MENU-02）**不在本阶段范围内**，合并方可根据需要单独更新那两条期望值（它们与 UI-1 的 token 变更 / DOM 断言有关，不属于 UI-2C）。
5. **必须重建产物**：本次改的是 `public/`，按仓库约定，要让用户看到新排版需 `npm run build:exe` / `npm run build:app -- --rebuild`；跑源码版（dev server）也能直接看到。
