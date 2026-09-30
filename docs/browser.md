# Browser Use / 真实浏览器自动化（P20）

Pi → 用户安装的 **Browser Extension** → `browser_*` registered tool → RPC → GUI Activity。

Pi GUI **不重新实现浏览器 Agent 决策层**：不决定点什么、不解析页面、不维护页面状态机、
不驱动 Chrome。它只做三件事 —— 如实呈现真实工具事件、按语义给紧凑文案、
把不该进 DOM 的东西挡住。

> **Browser Use ≠ Web Search。** 两者是独立能力，各自渲染、各自观察、互不代劳：
>
> | | Web Search（P16） | Browser Use（P20） |
> |---|---|---|
> | 工具 | `web_search` / `fetch_content` / `get_search_content` | `browser_*`（40 个） |
> | 做什么 | 搜索 + 取正文，**不驱动浏览器** | 真的打开页面、点击、输入、截图 |
> | 安装命令 | `pi install npm:pi-web-access` | `pi install npm:pi-browser-harness` |
> | 观察 | 各自一套（互不合并） | 各自一套（互不合并） |
>
> `browser_web_search` 是**浏览器版**搜索（抓真实 Google SERP），不是 `web_search`；
> 它归本文管，不归 [web-access.md](web-access.md) 管。

## 一、当前适配的 Extension

2026-09-30 核对 npm 当前发布版 **`pi-browser-harness` 0.11.0**：

| | |
|---|---|
| 包 | [`pi-browser-harness`](https://www.npmjs.com/package/pi-browser-harness) |
| 仓库 | [amankumarsingh77/pi-browser-harness](https://github.com/amankumarsingh77/pi-browser-harness)（MIT，未归档，24 stars） |
| 发布 | 2026-08-02，`gitHead f20fdf7fc4039ea71f3a8b56c7c508e46f1bbc51` |
| 入口 | manifest `"pi": { "extensions": ["./src/index.ts"], "skills": ["./skills"] }` |
| 运行依赖 | `ws`（+ 可选 `sharp`，仅用于截图缩放）；peer 是 `@mariozechner/pi-coding-agent` / `pi-tui` / `typebox` |
| 前置 | Node ≥ 22 + Chrome / Chromium / Brave / Edge |
| 安装 | `pi install npm:pi-browser-harness` |

`v0.11.0` tag 与 npm 发布包指向**同一个 commit**（`f20fdf7f…`）；
tag 上的 `src/index.ts`、`src/registry.ts`、`src/util/tool.ts` 与 6 个 `src/domains/*.ts`
与发布 tarball **逐字节相同**。本文所有 schema / details 形状都来自
**0.11.0 的发布 tarball**，不是 README 摘要，也不是仓库 `main`。
契约核对版本**不是** GUI 的安装要求：GUI 不检查版本号，只按工具名投影。

### 为什么选它（而不是别的 browser Extension）

2026-09-30 在 npm 上按 `pi browser` 与 `keywords:pi-package` 扫了一遍，候选不少。
判据是「与 Pi Extension 架构最匹配 + 维护状态」，不是下载量单指标：

| 候选 | 月下载 | 判断 |
|---|---|---|
| **`pi-browser-harness` 0.11.0** | 2.5k | ✅ **选它**：原生 `pi.registerTool`，**40 个语义化工具**（navigate/click/fill/select/wait/screenshot/read_page/close_tab…），每个工具的 `details` 是**结构化闭集**，不依赖 MCP，不依赖外部 CLI |
| `pi-browser-use` 0.12.2 | 5.7k | 走 `chrome-devtools-mcp`，工具从 MCP 动态注册；`index.js` 里显式 `details: undefined` → GUI 侧没有结构化证据可用 |
| `@amaster.ai/pi-browser-use` 0.1.22 | 5.4k | 同上（chrome-devtools-mcp，`browser_` 前缀，但 details 形状不同） |
| `pi-agent-browser-native` 0.8.2 | 20.8k | 下载量最高，但工具是**一个宽 `browser` 入口 + argv 语法**，语义粒度太粗；且依赖外部 `agent-browser` 二进制 |
| `pi-browser-actions` / `pi-browser-debug` / `pi-browser-search` / 其它 | < 1k | 维护状态或架构匹配度更弱 |

**渲染器绑定 tool semantics，不绑定包名**：适配表按工具名匹配。别的 Extension 若注册同名工具，
会走同一套语义路径（安全方向上是**更保守**：拿不到 `details.ok` 就只说「结果不可用」）；
名字对不上的浏览器工具走 **generic fallback**，不会假装懂它。

## 二、安装与配置

沿用 P16 / P17 / P18：**第一版不自动安装**。Extensions 页的 Browser Use 区块只给：

- 状态（见第三节）
- 固定命令 `pi install npm:pi-browser-harness` + 「复制安装命令」
- 「安装后重启 Pi」—— 复用现有确认框与 `POST /api/restart`（`rpc.restart()`）

不做：`npm install`、下载 Chrome / 驱动、clone 仓库、写 `~/.pi/agent/settings.json`、
改用户 settings、启动第二个浏览器实例。

安装之后的**一次性前置**由用户在终端 / 浏览器里完成（GUI 不代劳）：

1. 在浏览器里打开 `chrome://inspect/#remote-debugging`，勾选 **Discover network targets** 并点
   **Allow**（或者用 `--remote-debugging-port=9222` 重启浏览器）；
2. 在 pi 里执行 `/browser-setup` 连接（幂等；连接跨 pi 会话存活，Chrome 重启后会自动重连）；
3. 首次连接会问「用哪个浏览器 Profile」→ `/browser-profile` 选一个。
   **没选 Profile 时，标签页会开在当前有焦点的那个 Profile 上** —— 也就是可能落到你正在用的账号上。

其它命令：`/browser-status`（连接状态 / 当前页）、`/browser-reload-daemon`（重启浏览器客户端）。

## 三、状态模型

四个状态分开表达，谁都不要替谁说话：

| 状态 | 证据 |
|---|---|
| `installed` | Extension Registry 在磁盘上发现了 `pi-browser-harness` |
| `configured` | Registry 的 `enabled` 证据（**存在 ≠ 已启用**） |
| `loaded` | Registry 的 `loaded` 证据（无证据 → 未知） |
| `runtimeObserved` | 当前 workspace generation / bridge run 内**真实收到过** `browser_*` 的 `tool_execution_*` 事件 |

- 通用 Extension Registry 不变：`capabilityRegistry.tools=[]`、`toolRegistryAvailable=false`。
- **观察到的工具名不构成「这个包已加载」的证据**：同名工具可能来自别的 Extension，
  而 RPC 没有权威的已注册工具清单。
- 40 个工具逐个列没有意义（Extensions 页会被撑爆），所以只记
  **「观察到几个 / 最近是哪几个（最多 3 个）」**。
- restart / 切项目 / bridge 生命周期变化 / 无项目 → **清空观察**。
- 历史重建**不计入**运行时观察。
- 安装状态无法完整发现时显示「未知」，不写成「未安装」。

## 四、真实工具清单与 Activity 文案

工具名与参数全部来自 `src/registry.ts` 的 `ALL_TOOLS`（40 个）。

| 工具 | running | 结束（有结构化证据） |
|---|---|---|
| `browser_navigate` | Opening… | Opened `<host>` |
| `browser_open_urls` | Opening… | Opened N pages |
| `browser_go_back` / `browser_go_forward` | Going back… / forward… | Went back / Went forward |
| `browser_reload` | Reloading… | Reloaded page |
| `browser_click` | Clicking… | Clicked `[eN]`（无 ref 时给坐标） |
| `browser_focus` | Focusing… | Focused `[eN]` |
| `browser_type` / `browser_fill` | Entering text… | **Entered text**（**永不显示内容**） |
| `browser_fill_form` | Filling form… | Filled N/M fields（只有计数） |
| `browser_select_option` | Selecting option… | Selected option（选项文案过 allowlist 才显示） |
| `browser_set_checked` | Setting checked state… | Set checked state (true/false) |
| `browser_press_key` / `browser_dispatch_key` | Pressing / Dispatching key… | Pressed / Dispatched `<具名键>`（单字符键不显示） |
| `browser_wait` / `browser_wait_for` / `browser_wait_for_load` | Waiting… / Waiting for page… | Waited `N s` / Page loaded |
| `browser_screenshot` | Capturing screenshot… | **Captured page screenshot** |
| `browser_snapshot` | Reading page structure… | Read page structure (N elements) |
| `browser_read_page` | Reading page… | Read `<host>` |
| `browser_page_info` | Checking page… | Checked `<host>` |
| `browser_current_tab` | Checking current tab… | Checked tab on `<host>` |
| `browser_list_tabs` | Listing tabs… | Listed N tabs |
| `browser_new_tab` | Opening tab… | Opened `<host>` / Opened tab |
| `browser_switch_tab` / `browser_close_tab` | Switching / Closing tab… | Switched tab / **Closed tab** |
| `browser_scroll` | Scrolling… | Scrolled page |
| `browser_viewport_resize` | Resizing viewport… | Resized viewport |
| `browser_drag_and_drop` | Dragging… | Dragged element |
| `browser_handle_dialog` | Handling dialog… | Handled dialog (accepted/dismissed) |
| `browser_execute_js` / `browser_run_script` | Running page script… | Ran page script（只有结果字节数） |
| `browser_http_get` | Fetching URL… | Fetched `<host>` |
| `browser_network_requests` | Reading network activity… | Read network activity（只有计数） |
| `browser_console` | Reading console… | Read console（只有计数） |
| `browser_upload_file` / `browser_download` / `browser_print_to_pdf` | Uploading… / Configuring… / Printing… | Uploaded file / Configured downloads / Saved page as PDF |
| `browser_web_search` | Searching… | Searched the web (N results) |
| `browser_setup` | Initializing browser… | Initialized browser |

**没有「Closed browser session」。** 0.11.0 里最接近的是 `browser_close_tab`（关标签页）；
会话级的关闭只有 `/browser-reload-daemon` 这类**命令**，不是工具。GUI 不发明一个不存在的动作 ——
**以源码为准**，不按任务描述里的设想硬套。

取消 / 中断（Stop、abort、进程退出）时，文案是 `<running 去掉 …> stopped`
（例如 `Waiting stopped`），**不残留 spinner**，状态点也不是对勾。

## 五、成功证据规则（沿用 P18-Fix）

`pi-browser-harness` 的每个工具都经 `registerBrowserTool` 返回：

```js
// 成功
{ content:[{type:'text',text}], details:{ ok:true, ... } }
// 失败
{ isError:true, content:[…], details:{ ok:false, kind, message, ... } }
```

`kind` 是**闭集**：`not_connected` / `cdp_error` / `timeout` / `invalid_state` / `io_error` / `internal`。

于是：

1. **请求参数不是成功证据。** `args.url` / `args.seconds` / `args.query` 只用于
   running 文案与失败时的「请求目标」；success 必须由 `details.ok === true` 证明。
2. **没有 `details.ok` 就说「结果不可用」。** 已结束但拿不到 `ok:true` 时，
   文案是 `<动作> — result unavailable`，事实行是 `Result details unavailable`，
   **一个具体字段都不给**（不显示主机名、不显示元素、不给链接）。
   既不拿参数顶成成功，也不改判成 error。
3. **失败回显闭集里的 `kind`**，不回显上游 `message`（它可能带着页面文本 / 选项列表）。
   不认识的 `kind` → 只说「结果不可用」，**不回显原值**。
4. **`details.ok === false` 优先于 pi 的 `isError`**：两者冲突时以结构化证据为准。
5. **不解析 result 正文。** 文案不是 API，而且正文里就是页面内容。
   `browser-activity.js` 里没有 `entry.output` / `entry.error` / `resultLine` 的读取。

## 六、数据流

```
真实 Chrome ←CDP→ pi-browser-harness（daemon + Extension）
                    │  pi.registerTool({ execute })
                    ▼
        tool_execution_start / _update / _end（SSE，带 bridgeRun）
                    │
   app.js handle()：bridgeRun / switching 守卫 → observeBrowserEvent（只记「观察到哪些工具名」）
                    │
        onToolStart / onToolUpdate / onToolEnd → Tool Timeline
                    │
   tool-view.updateEntry：browserActivity(entry) 命中 → 接管
                    │
   紧凑文案 + 事实行（折叠区）+ 安全来源链接（最多 10 条）
```

- 实时与历史走**同一个** adapter：历史 entry 由 `tool-model.entryFromHistory` 造出
  （`details` 来自 `toolResult` 消息），因此刷新前后一致，**不会退回巨大 raw JSON**。
- 实时事件按 `toolCallId` 用现有实例表，支持并发与逆序完成。
- **GUI 不做主动轮询**：0.11.0 的协议是「工具调用驱动」，不需要 setInterval。
- 浏览器页面与 Profile 由 Extension 自己管理；GUI 不读它的状态文件。

## 七、安全投影

### 7.1 只投影 allowlist 字段

浏览器工具的结果里混着大量原始内容与凭据。**这些一个都不进 DOM，也不进诊断报告**：

| 工具 | 被挡住的字段 | 为什么 |
|---|---|---|
| `browser_execute_js` / `browser_run_script` | `details.full` / `details.pretty` / `args.expression` | 页面里求值出来的任意值（含 `document.cookie`） |
| `browser_read_page` | `details.render.body` / `details.title` | 整页正文与页面标题 |
| `browser_snapshot` | `details.fullOutputPath` / `details.screenshotPath` / `title` | 快照落盘路径与页面标题（**结构计数摘要保留**） |
| `browser_network_requests` | `details.requests[]` | URL / 请求头 / 响应体 |
| `browser_console` | `details.records[]` | 控制台消息 |
| `browser_fill` / `browser_fill_form` | `value` / `verified` / `args.value` | **刚输入的内容** |
| `browser_select_option` | `value`（原始值永不显示） | 可能是账号 / 令牌 |
| `browser_upload_file` / `browser_download` / `browser_print_to_pdf` / `browser_screenshot` | `filePath` / `downloadPath` / `path` | 本机绝对路径 |
| `browser_http_get` | `args.headers` | `Authorization` / `Cookie` |
| `browser_handle_dialog` | `args.promptText` | `prompt()` 里填的文本 |
| 所有工具 | 上游 `details.message` | 可能带页面文本 / 选项列表 |

保留的只有：**闭集枚举**（`kind` / `format` / `scope` / `mode` / `engine` / `outcome.kind` /
`dialog.type`）、**计数与尺寸**（`nodeCount` / `wordCount` / `total` / `returned` / `valueLength` /
`length` / `ms` / 视口与坐标）、**主机名**、以及 `snapshot.summary`（纯角色计数串，无页面文本）。

### 7.2 输入内容的默认策略

**默认完全不投影**：`browser_type` / `browser_fill` / `browser_fill_form` 的内容一律不显示，
连长度都不显示。

唯一例外是 `<select>` 的选项文案，且必须过一道**保守 allowlist**
（`nonSensitiveOption()`）：长度 ≤ 40、无控制字符、无 `@ : ; / \ < > " '`、
无连续 5 位以上数字（OTP / 卡号）、无 `pass|pwd|token|secret|otp|pin|cvv|ssn|iban|account|card|auth|cookie|bearer|api key` 之类的词。
**过不了就只显示「Selected option」。**

**不从 DOM 文本猜「这是密码」** —— 只对结构化字段做标记，默认策略仍然是不显示。
按键同理：只有**具名键**（Enter / Tab / Escape / 方向键…）才显示，
单个可打印字符可能是密码的一位，一律显示成「Pressed key」。

### 7.3 URL

页面地址是**不可信输入**，走两道过滤：

- `browserHost()`：只认 `http:` / `https:`，拒绝凭据（`user:pass@`）、控制字符、空白、超长值。
  用于「Opened `<host>`」这类**纯文本**。
- `safeBrowserUrl()`：比 P16 的 `safeWebUrl` **更严 —— 再拒掉带 query / fragment 的地址**。
  理由很直接：令牌、一次性链接、OTP 回调都挂在 query 上，「token 永远不进 DOM」
  这条约束必须落到 URL 层面。被拒**不影响主机名照常以纯文本显示**。

`javascript:` / `file:` / `data:` / `vbscript:` / `chrome:` / `about:` 一律拒绝进入可点击 URL。
只有「打开页面」类动作（navigate / open_urls / new_tab / read_page）会给来源链接，
最多 10 条，**只在用户点击后**经独立 `openWebUrl` preload IPC 打开系统浏览器；
Release 的 GitHub 白名单保持独立、不放宽。

### 7.4 截图

`browser_screenshot` 在 0.11.0 里把图片**存到本机文件**，result 里只有
`details:{ path, format, attached:false }` —— **没有 image content block**。
所以 GUI 只显示「Captured page screenshot」+ 格式，**不读那个文件、不投影路径、不渲染图片、
不写 localStorage、不自动上传**。

若将来上游改成把图片放进 result 的 `content`（`type:'image'`），那属于
[conversation-ui.md](conversation-ui.md) 既有的附件展示路径（同样只走 `textContent` /
`img.src=data:`，不执行 HTML）。**GUI 不会自己去读磁盘上的截图文件。**

## 八、session 与生命周期

- **按真实的 `toolCallId` 关联**（pi 自己的标识）。0.11.0 的 tool result 里
  **没有** `browserSessionId` / `pageId` 这样的字段（只有 CDP 的 `targetId` 与 daemon 的
  `namespace`，且不在每个工具的 details 里）→ GUI **不自造**权威的会话关系，
  也**不**把 `targetId` 当成会话 id 展示。
- start / update / end / error / cancel / interrupt 全部按现有 Tool Timeline 规则处理；
  **并发 `toolCallId` 各自独立，逆序完成不串结果**。
- 切项目 / 重启后旧事件被 `bridgeRun` + `S.switching` 守卫挡掉；
  运行观察同时清空（见第三节）。
- **不轮询**：没有 `setInterval`。上游协议是工具调用驱动的，不需要主动拉取。

## 九、权限边界：没有审批，也不假装有

这是本文最要紧的一条。

`pi-browser-harness` **没有针对 `browser_*` 工具执行的审批协议**：源码里没有
`pi.on("tool_call")` 拦截，也没有在这些工具执行前调用 `ctx.ui.confirm`。
`/browser-profile` 确实使用 `ctx.ui.select` 做 Profile 选择；Pi 0.87.0 的 RPC 会把这类
`select` 作为 `extension_ui_request` 交给 GUI，并等待 `extension_ui_response`。
这属于**配置交互**，不是浏览器工具执行的权限闸门。

因此按 P19 定下的规矩（见 [approvals.md](approvals.md)）：

- Pi GUI **不提供**任何浏览器动作的允许 / 拒绝按钮；
- **不画假的 modal**，不宣称「已保护」；
- Extensions 页的 Browser 区块**明说**这一点：「这些动作会直接发生，Pi GUI 拦不住它们」。

真实的风险面必须讲清楚：

- 这个 Extension 接的是**你自己正在用的那个 Chrome**（真 Profile、真登录、真 Cookie）；
- 没 pin Profile 时，标签页会开在**当前有焦点**的 Profile 上，可能落到你正在用的账号；
- 它会在浏览器里开一个**专用窗口**，并且拒绝操作不是自己开的标签页（tab ownership），
  但这**不构成**对页面内容的保护 —— 页面上的点击、输入、提交都是真的；
- 高风险动作（提交表单、购买、删除、发布、发送消息）**没有闸门**，请自己盯住页面。

GUI 侧能做的只有「如实呈现」与「少投影」。

## 十、明确不做

不做完整浏览器 UI、Cookie 导入、密码库、CAPTCHA 绕过、下载中心、书签、
Deep Research、自动登录、浏览器历史中心、MCP Browser 重构。

也不做：自己启动 Chrome、自己装驱动、改 Profile、pin Profile、点页面上的东西、
从 DOM 猜语义、把页面正文当 Activity 内容。

## 十一、验证

### 离线（进默认 CI）

`npm run test:browser`（已加入 `npm test` 链）—— **215 条断言，完全离线**：
不启动 Chrome / Playwright、不联网、不登录任何站点、不安装任何包。
覆盖：全部 40 个动作的 start/success/error、navigate / open_urls 的真实字段、
输入内容与凭据的脱敏（含 `outerHTML` 级别）、页面正文 / 标题 / 控制台 / 网络记录 /
本机路径不投影、闭集 `kind`、`ok:false` 优先于 `isError`、无证据降级、
URL scheme 与 query 拒绝、并发与逆序、取消 / 中断、历史重建、运行观察与清空、
Web / Subagent / Memory / Planner 回归、DOM 渲染与 fallback。

截图 harness 的场景 **165-browser-activity** 也是离线的（fixture 走
`/api/__conversation?what=browser-activity`），用 `PRIVATE_*` marker 证明
输入内容、页面正文、页面标题、本机路径、上游错误原文都不进 DOM。

### 真实浏览器（opt-in，**不进默认 CI**）

```sh
PI_GUI_BROWSER_LIVE=1 npm run test:browser-live
```

它拉起真的 `pi --mode rpc`（`--no-session`，临时工作目录），让模型真的调浏览器工具，
把**真实事件**喂给**同一个** `browserActivity`。不带 `PI_GUI_BROWSER_LIVE=1` 时
只打印手工清单并退出 0 —— 既不会在 CI 上误跑，也不会让手滑的人花掉模型额度。

手工验收（脚本覆盖不到的部分）见 `tests/browser-live.cjs` 顶部的清单，要点是：
用 `https://example.com` 这种公开无登录无副作用的站点，走「打开 → 点击无副作用链接 →
读取 → 返回 / 关闭」，再测 Stop 与历史重开；要测表单只用专门的测试页面且**不提交**真实数据。

> **本阶段没有执行真实浏览器验收。** 离线测试与截图全部通过；`test:browser-live` 的
> opt-in 闸门已核对，但**没有**在真实 Chrome + 已装 Extension 的环境里跑过一次。
> 不得据此推断「真实浏览器链路已验证」。

## 十二、相关文件

- `public/browser-activity.js` —— 语义投影（无 DOM、无 IO、无包名）
- `public/browser-capabilities.js` —— installed/configured/loaded 三值与运行观察
- `public/browser.js` —— SSE 观察入口 + Extensions 页设置区
- `public/tool-view.js` —— 语义适配器分发（`browserActivity`）+ 通用来源渲染
- `tests/browser.cjs` —— 离线契约（215 条）
- `tests/browser-live.cjs` —— opt-in 真实浏览器验收 + 手工清单
- `.probe/p20-upstream/` —— 0.11.0 tarball、tag 对照、候选包元数据与下载量（gitignore）
- [web-access.md](web-access.md) / [extensions.md](extensions.md) /
  [architecture.md](architecture.md) / [security.md](security.md) /
  [testing.md](testing.md) / [pi-compatibility.md](pi-compatibility.md) /
  [approvals.md](approvals.md)
