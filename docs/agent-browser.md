# 内置浏览器 Agent Control（P29）

这项能力用于本地 Web 开发验证。打开右栏内置浏览器后，主动开启「Agent 控制」，
Pi 可读取本地页面、操作表单、截图、查看 console 与网络摘要，并在修改代码后刷新验证。
开关默认关闭，不持久化；关闭浏览器、重启 Pi 或退出应用会撤销授权。

## 两套独立能力

| | 内置浏览器 Agent Control | External Browser Use |
|---|---|---|
| 工具前缀 | `gui_browser_*` | `browser_*` |
| 提供方 | pi-GUI 随包 Extension | 用户安装的 pi-browser-harness |
| 浏览器 | 右栏 Electron WebContentsView | 用户外部 Chrome / Chromium |
| Agent 范围 | 仅 loopback HTTP / HTTPS | 由外部 Extension 决定 |
| 启用 | 本次运行手动开启开关 | 外部 Extension 自己的配置 |
| 安装 | 随桌面包提供，无需 npm install | 维持原有安装方式 |

P29 不开 remote debugging port，不启动外部 Chrome，也不使用 Playwright / Puppeteer。
用户手动导航仍可打开远程 HTTPS；Agent 对远程页面的 snapshot、输入、截图、console 和
network 均拒绝，返回 `remote_origin_not_allowed`。主 GUI 服务及其 loopback 端口别名仍被阻断。

## 工具

| 工具 | 参数 | 结果 |
|---|---|---|
| `gui_browser_status` | 无 | available / enabled / open / attached / generation / urlOrigin / loading |
| `gui_browser_open` | url | 打开右栏，等待实际加载状态，返回最终安全 URL、标题与 generation |
| `gui_browser_snapshot` | 无 | 有界 AX 快照、文本、viewport、元素 ref |
| `gui_browser_click` | ref | 滚动到元素，CDP 真实鼠标事件 |
| `gui_browser_fill` | ref, text | input / textarea / contenteditable，替换内容并触发 input/change |
| `gui_browser_press` | key | 闭集具名按键 |
| `gui_browser_reload` | 无 | 刷新并等待加载状态 |
| `gui_browser_back` / `gui_browser_forward` | 无 | 仅访问 loopback 历史条目 |
| `gui_browser_screenshot` | 无 | viewport PNG，正式 image ToolResult |
| `gui_browser_console` | limit（1–100） | 有界日志摘要 |
| `gui_browser_network` | limit（1–100） | 有界请求摘要 |

按键支持 Enter、Tab、Escape、四方向键、Backspace、Delete、Home、End、PageUp、PageDown、
Ctrl+Enter。不接受脚本、任意 JS、任意 CDP 方法或单字符键盘脚本。
填充使用产品固定的内部函数，通过 `Runtime.callFunctionOn` 的独立参数传递 text；
没有可由 Agent 提供的函数或表达式，也不往页面插入标记或持久脚本。
密码、文件和 hidden 输入拒绝操作；上传、下载、网站权限、Cookie、storage 管理均不提供。

## 进程与权限边界

```text
Pi 子进程内 bundled Extension（注册与 HTTP adapter）
  -> 127.0.0.1 随机端口 /action（独立 capability）
  -> Electron main 的闭集 controller
  -> 当前 WebContentsView.webContents.debugger
  -> CDP Page / DOM / Accessibility / Input / Runtime / Log / Network
```

Electron 为桥生成 256-bit 应用生命周期凭据，只交给服务进程；它不复用 `PI_GUI_TOKEN`。
服务每次启动 Pi，通过管理凭据向 `/session` 申请新的 256-bit 浏览器工具凭据。
Pi 只继承随机端口和本次 run 的工具凭据，不能调用桥的生命周期管理接口。
凭据在内存和进程环境中，不进入 argv、状态事件、renderer、诊断、日志或会话。
Pi Extension 与 Pi 自带 bash 在同一 OS 权限下，环境变量隔离不是 OS sandbox；
浏览器凭据本身只允许闭集浏览器动作，没有文件、Git、Provider 或 restart 权限。

桥拒绝网页 Origin、未授权请求、未知路径/动作、重复 ID 与超限 payload。
请求带 ID、动作世代与浏览器世代，正文有界，执行有超时。读入正文后再次核对 run 凭据，
阻止已通过初次鉴权的慢请求跨重启执行。动作按队列串行。

## 加载与真实 Pi API

通过项目已有 `createPiLaunch` 身份解析，读取**同一实际启动包**的 CLI/types 证据。
仅在桌面 bridge 与 bundled 文件可用、官方 API 可确认时，在实际 spawn 参数中加入
`--extension <bundled path>`。公共启动状态不包含这条路径，用户配置与其它 Extensions 保持原样。
Web GUI 不注册这些工具；旧 Pi 或无法确认官方入口时降级为 unavailable。

本轮实际核对 Pi 1.0.2 的 `docs/extensions.md`、`dist/cli/args.js`、
`dist/core/extensions/types.d.ts`、`dist/core/extensions/loader.js`、RPC mode 与 agent-core 类型：
默认 factory + registerTool、JSON Schema 参数、execute 的 AbortSignal、image content 和 isError
均有正式支持。能力判定使用证据，不以版本号比较替代探测。

## 生命周期与陈旧结果

WebContentsView 每次创建增加 browserGeneration；主文档导航、页面替换、reload 与关闭
增加 documentGeneration、清空 refs。ref 单调发号，映射 backendNodeId，仅在当前浏览器/文档有效，
不会将旧 ref 重新指向新元素。snapshot 更新后旧映射同样失效。

按需 attach，关闭开关/视图/应用 detach；被外部 detach 时立即标为 unavailable。
执行前、每个 CDP 步骤前后及结果返回前检查 signal 和世代。手动导航会使当前队列失效。
Stop 撤销动作 epoch 并取消等待；切 workspace / bridge restart 轮换工具凭据，默认关闭开关。
GUI 的 Stop 响应等待浏览器桥取消确认；确认失败仍向 Pi 发 abort，但返回明确失败，
不会把未确认的浏览器停止报告为成功。已取消的队列项不发送输入事件，运行项保持队列所有权直到实际结束。
已送到 Chromium 的事件不能撤回，取消保证后续步骤和陈旧结果不继续落到新页面。

## 数据范围

- 页面内容、截图、console 在调用工具时会进入模型上下文。请使用开发 fixture 和测试数据。
- snapshot 不返回 outerHTML、AX 值、Cookie 或 storage；最多 300 个 ref，文本最多 16000 字符。
- PNG 默认 viewport，最大边 4096、最多 8388608 像素、最多 4 MiB；不落盘、不上传。
  Extension 返回正式 `{type:'image',data,mimeType:'image/png'}`，图片从 details 中移除。
- console 最多 100 条、单条最多 1000 字符、总摘要最多 64 KiB；不展开对象。
  Runtime 日志仅收已验证的本地主文档默认执行上下文；Log 域仅收本地来源 URL，
  来源未知或远程的条目保守丢弃，子 frame 的日志与请求不收集。
- network 只保存 method、去 query/fragment/credentials 的 URL、status、resourceType、failed。
  不保存 header、request/response body、Cookie 或 Authorization；最多 100 条和 64 KiB。
- 状态 URL 仅 origin；其它工具 URL 为 origin + pathname，无 query/fragment/credentials。
- 独立 `gui-browser-activity.js` 对实时与历史共用固定文案/计数投影，填写内容、页面原文、标题、
  图片 base64、console、network 明细和 raw error 均不进入 Activity DOM 或 title。

Capability 中 bundled/configured/loaded 与运行观察独立。官方加载入口可确认只证明配置；
loaded 无权威 RPC 工具清单时保持未知。runtimeObserved 只来自当前 workspace/run 的工具事件。
available/enabled/attached/browserOpen 来自 Electron 真实状态，未经观察的值保持未知。

## 验证

`npm test` 包含离线 policy、controller、bridge、tools、UI 和 host 套件。
真实 Chromium 验证为显式 opt-in：

```powershell
$env:PI_GUI_AGENT_BROWSER_LIVE='1'
npm run test:agent-browser-live
$env:PI_GUI_AGENT_BROWSER_PI_LOAD='1'
node tests/gui-browser-tools.cjs
```

live 使用随机端口本机 fixture 和临时 userData，验证 WebContentsView、AX、真实 pointer、
fill/Enter、PNG、console、成功/404 请求、reload 和旧 ref 失效。不调用模型、不访问互联网。
默认 CI 不依赖 Electron 显示服务或本机真 Pi。

第一版为单 view、单 viewport；不做 iframe 跨 frame 元素映射、多 tab、fullPage、任意脚本，
页面含远程 frame 时拒绝页面观察与输入；受控导航阻断远程 frame 跳转。
也不支持绕过 TLS 错误。AX 不能提供的语义不猜测，布局遮挡或非交互节点可返回错误。
稳定错误包括 agent_control_disabled、remote_origin_not_allowed、cdp_attach_failed、cdp_error、
browser_unavailable、stale_browser_generation、stale_element_ref、element_not_allowed、
element_not_interactable、screenshot_too_large、invalid_key、navigation_failed、timeout、cancelled、
busy、invalid_request、payload_too_large、unauthorized、unknown_action、internal。
