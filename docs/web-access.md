# Web Search 与 URL Fetch（P16）

Pi → 用户安装的 Extension → registered tool → RPC → GUI Activity。
GUI 不实现搜索供应商、不发送搜索请求、不强制模型使用工具。

## 安装与配置

默认兼容 [pi-web-access](https://github.com/nicobailon/pi-web-access)。2026-09-30 核对 npm 当前版本 **0.33.0**，发布源码 commit `049587ea3f6dc4d1b0519f17e854ed7e5f57e4b2`。
manifest 为 `pi.extensions: ["./dist"]`。没有将第三方源码或依赖加入 GUI。

在终端使用 Pi 官方机制：

```sh
pi install npm:pi-web-access
```

Extensions 页提供固定命令复制与「安装后重启 Pi」。GUI 不自动执行安装，
当前 RPC/Windows shim 启动契约没有独立安装执行器；不直接 npm install，
不修改 package cache/settings，不接受任意包名。第三方 Extension 与 Pi
进程同等权限，可访问网络及文件，不受 GUI sandbox 限制。

完成安装后，经现有确认框重启 Pi（`POST /api/restart → rpc.restart()`）。
现有 bridge lifecycle 禁用 Composer，ready 后恢复；失败可重试。
这不会重启后端或 Electron，不会启动第二个 RPC 实例。

供应商配置由 Extension 的 `~/.pi/agent/web-search.json` 管理。
上游 0.33.0 支持免 key Exa；Codex OAuth reuse 由 Extension 的 auth 代码处理。
其他 key/endpoint 模式及可选 workflow 以 [上游说明](https://github.com/nicobailon/pi-web-access/blob/049587ea3f6dc4d1b0519f17e854ed7e5f57e4b2/README.md) 为准。
GUI 不读取、复制或保存搜索 API key/OAuth credential，也不增加 Provider Settings。
上游的 curator/browser 行为属于 Extension 配置，GUI 不自动打开其返回的地址。

## 能力与结果

通用 Extension Registry 不变：`capabilityRegistry.tools=[]`、`toolRegistryAvailable=false`。
独立 Web feature 区分 configured/discovered 与 runtimeObserved。
configured 使用 Registry 的 enabled 三值证据；单纯存在不能推出已启用。
工具真实事件只证明当前 workspace generation/bridge run 观察到调用，不证明其所属包。
切项目或 Pi restart 清除观察。安装状态无法完整发现时显示未知。
Extensions 页刷新读取当前证据；历史重建不计入运行时观察。

专用 renderer 按工具名匹配，不绑定包名：

| 工具 | 参数（0.33.0） | 默认 Activity |
|---|---|---|
| web_search | query 或 queries；可选 numResults/includeContent/recencyFilter/domainFilter/provider/workflow/proxy | Searching… → Searched the web / Web search failed |
| fetch_content | url 或 urls；mode/prompt 等由 Extension 决定 | Reading… → Read 标题或 hostname / URL fetch failed |
| get_search_content | responseId，query/queryIndex/url/urlIndex/offset/limit/findText/findMode | Read search content |

只投影 allowlist 详情。搜索使用真实 `totalResults/queryProviders`，来源优先
`curatedQueries[].sources` 或其他 Extension 的显式 `details.sources`。
普通非 curated 搜索可能只有文本与计数，没有结构化来源；此时明确显示缺失，
不 regex 正文提取链接。Fetch 使用 `urls/title/mimeType/status`，不展示几千行全文。
Pi 仍保存原始 Tool Result 并交给模型；历史与实时经过同一 view adapter。

start/update/end 按 toolCallId 使用现有实例表，支持并发与逆序完成。
update 为累积输出；end 可能不带 name/args。error/cancelled metadata 如实展示，
缺 end 时沿用统一未完成状态，不遗留 spinner。
其他工具（custom_search/browser_search/research_tool/foo_fetch，以及 PDF/video 工具）保持 generic fallback。

## 外链安全

结构化 URL 也属于不可信输入。renderer 与 Electron main 分别校验
http/https，拒绝 credentials、控制字符、空白、超长值及 javascript/file/data scheme。
只在用户点链接后打开：桌面经独立 `openWebUrl` preload IPC，浏览器为
`target=_blank rel=noopener noreferrer`。Release 的 GitHub 白名单保持独立。
标题/正文只做 textContent，不执行 HTML/script，不加载 iframe，不自动打开链接。

## 验收

`npm run test:web` 为完全离线 fixture/DOM 测试，并已加入 `npm test`。
截图 harness 的 156 场景也完全离线，不安装 package、不调用模型、不消耗 quota。

显式手工 live 验收（不属于默认 CI）：

1. 用户自行安装、配置可信 Web Extension，重启 Pi，选择可用模型。
2. 提问「搜索 Pi coding agent official documentation」。确认真实 web_search
   事件、Searching…、完成状态、query 及可用的结构化 sources。
3. 提问「读取其中 pi.dev 页面」。确认 fetch_content 与 Read Activity，
   模型能使用正文，而 GUI 不铺满全文。
4. 手动点来源，确认系统浏览器安全打开；Stop 后无残留 spinner。
5. 重新打开历史会话，确认相同 Activity；重启后观察状态归零。

没有现场安装/供应商凭据时不能声称真实联网验收通过。
Web Search 与 Browser Use 是独立能力；本轮不实现 browser automation、登录、
Cookie、截图、PDF/video 专用 UI、MCP 搜索、搜索历史或自动多轮研究。
