# 安全

## P19 Approval 边界

**审批不是 OS sandbox。** Pi GUI 能拦的只有「有 Extension 来问」的调用：
Pi 0.87.0 里 `pi.on("tool_call", …)` 可以 `{ block: true }`，而 RPC 模式下
`ctx.ui.confirm/select/input/editor` 会**阻塞**到客户端回应答 —— 所以拒绝
（`{confirmed:false}` / `{cancelled:true}`，两者在 `rpc-mode.js` 里都解析成 `false`）
是真的会让这次工具调用不执行。**没有** Extension 来问时，GUI 没有任何拦截通道，
Pi 核心也没有自带审批弹窗；这种情况下界面不画假的允许/拒绝按钮，
也不提供全局权限开关。

- 决定只经 `extension_ui_response` 这一条明确协议命令，**不靠发聊天文本**。
- 一次性：协议没有持久化能力 → 不做「总是允许 / 按作用域允许」。
- 不从自然语言猜风险：无结构化风险字段 → `risk` 恒为 `unknown`。
- 对话框内容是不可信输入：只投影协议字段（含长度上限）、一律 `textContent`；
  事件里多出的 `env`/`token`/`apiKey`/`authorization`/`cookie`/`command`/`rawArgs` 等
  **不投影**；原始 payload 不进日志、诊断与 renderer。
- 能力报告只回「文件名:行号 + 原文片段」，不回 pi 包绝对路径。
- 生命周期不留悬挂：桥接重启/退出 → 本地作废且**不给已消失的进程发应答**；
  Stop → fail-closed 取消并收卡；`timeout` 到点只收卡（Pi 已按默认值 resolve）。
- 复用同一套确认层（`confirmModal`），危险操作仍是 `.btn.danger` + Enter 不误确认。

详见 [Approvals](approvals.md)。

## P18 Pi Memory 边界

长期记忆可能保存**用户偏好、项目决策、历史事实与自定义内容**，比普通 Tool 更敏感。
记忆由用户安装的 Pi Extension 提供并落盘（`pi-memory` 默认 `~/.pi/agent/memory/`），
Pi GUI 只做观察层：

- **不上传、不 telemetry、不做云同步**；不建立第二份数据库，不索引、不缓存 Memory
- **不复制 Memory 到 localStorage**，不把它拼进会话历史或导出
- **不读取整个 Memory 目录**，不扫描 `recovery/`，不读 qmd DB 或 index
- **不向 renderer 暴露绝对路径**：`details.path` / `recoveryPath` / `dir` 都不投影
- **不把 raw tool args / details / result 文本铺进 DOM**：识别为 Memory 语义工具后
  `argsText` 置空、`output` 换成白名单 facts，`memory_read` 的整份 MEMORY.md
  与 `memory_search` 的命中正文都不会出现在界面上
- **不猜**：`count` / `removed` / `restored` / `target` 缺失就说「结果不可用」，
  不写成 0；`mode` 只信 result，不因为装了 qmd 就说是语义检索；
  scope 只有 global（源码里没有 project scope），不发明「项目记忆」
- **请求参数不是成功证据**：`memory_read` 的 `args.target`、`scratchpad` 的
  `args.action`、`args.date` 都只用于「在做什么」的 running 文案；
  成功文案必须由 result `details` 证明（`path` / `path`+`date` / `files` /
  `details.action` / `count`|`open` / `removed`）。这也避免为了判断 soft-failure
  去解析 raw result 文本 —— 那条路会重新打开正文与绝对路径的泄露面
- **不做**自动 remember / forget / summarize，不把会话或 Git history 写进 Memory，
  也不提供恢复或删除 recovery 的入口（可恢复这件事只说事实，不动手）

注意 pi 0.87.0 的一个协议事实：Extension 在 result 里返回的 `isError: true`
**不会**到达 `tool_execution_end`（agent loop 正常 return 一律 `isError: false`）。
所以界面上的失败状态只代表「工具抛异常」，Extension 自报的失败会以
「结果不可用」这种中性降级出现，而不是被 GUI 猜成失败。见 [Pi Memory](memory.md)。

第三方 Extension 与 Pi 进程拥有同等文件、shell 与网络权限，Memory 的内容也由
Extension 决定如何保存；只安装可信代码。

## P16 Web Extension 边界

GUI 自身不联网搜索；搜索与 URL Fetch 来自用户安装的 Pi Extension。
第三方 Extension 与 Pi 进程拥有同等系统权限，可访问网络与本地文件，
不受 GUI sandbox 限制。当前只提供固定官方 CLI 命令复制，安装由用户
在终端明确执行；GUI 不提供自动安装、不接受任意 package、不写 cache/settings。
安装后重启复用现有确认框与 rpc.restart。
GUI 不收集搜索 telemetry、不上传会话、不保存搜索 key、不复制 OAuth，
配置由 Extension 管理。Web Activity 只投影 allowlist 字段，不展示 auth/proxy 原始参数。
来源只取明确结构化 URL，不解析正文链接，不执行 HTML，不自动打开地址。
renderer 与 Electron main 分别校验 http/https、credentials、控制字符及长度；
独立 `openWebUrl` IPC 不放宽 Release 白名单。详见 [Web Access](web-access.md)。

**后端能驱动 pi 执行任意命令，所以它的边界是唯一防线。**
这份文档逐条说明：威胁是什么、边界划在哪、Pi GUI 做了什么、**哪些事仍然由你负责**。

不是「绝对安全」的清单。每一条都写清了它防得住什么、防不住什么。

## 一、网络边界

### 只监听回环

**威胁**：后端能力等于「在你机器上跑命令」。一旦监听到 `0.0.0.0`，
同一局域网里任何人都能用它。

**做法**：显式 `listen(PORT, '127.0.0.1')`，不依赖 Node 的默认行为，
也不用 `0.0.0.0`。日志里只出现 `http://127.0.0.1:<PORT>`。
测试里有一条断言从本机的**非回环地址**去连，必须连不上。

### 应用级身份握手

**威胁**：端口上「有人在听」不等于「这是我们的后端」。如果把窗口指向一个
恰好占了 7788 的陌生程序，用户会看到一片「界面不对 + 所有接口 404」，
而真正的原因完全看不出来。

**做法**：Electron 启动时探一次 `GET /api/health`（唯一免认证的端点，
它要用来认亲），按返回的 `app` / `protocol` 判成三种状态：

| 状态 | 含义 | 处理 |
|---|---|---|
| `not-running` | 端口空着 | 自己拉起后端 |
| `pi-gui` | 是本应用的后端 | 复用（先验令牌能不能用） |
| `foreign-service` | 端口被别的程序占了 | **直接报错退出，绝不把窗口指过去** |

第三种会明确提示「端口已被其他程序占用，请关闭占用程序或通过 `PORT` 环境变量
修改 Pi GUI 端口」。

### 本地令牌

**威胁**：本机上任何别的程序（或另一个浏览器标签）都能向 `127.0.0.1:7788`
发请求。回环不等于可信。

**做法**：Electron 每次启动现生成一个 32 字节随机令牌，经环境变量
`PI_GUI_TOKEN` 交给后端；后端据此要求所有 `/api/*` 带
`Authorization: Bearer <token>` 或 `X-Pi-Gui-Token`（`/api/health` 除外）。

- 令牌比较是**定长比较**，错误信息不回显收到的值
- 令牌由 Electron 的 `onBeforeSendHeaders` 统一注入，**从不进入渲染进程**
- 不打印、不写进 URL、不落盘
- **令牌还会从 pi 子进程的环境里摘掉** —— pi 自带 bash 工具，环境变量对它
  （以及它跑的任何命令）都是可读的；令牌一旦进工具输出，就会随对话内容
  进模型上下文

### Origin 校验

**威胁**：浏览器里一个恶意页面可以向后端发跨站请求（配合 DNS rebinding 之类）。

**做法**：请求校验 `Origin`，非本机同源一律 403。判定顺序上
**Origin 必须排在令牌判定之前** —— 反过来的话，一个跨站请求会先因为令牌不对
拿到 401，用户看到的是「令牌有问题」而不是「这个来源被拒」，排查方向就跑偏了。

### 开发模式 vs 正式模式

| 模式 | 怎么进 | 令牌 | Origin 校验 |
|---|---|---|---|
| 正式（Electron） | `npm run app` / 安装版 | 有，必须带 | 有 |
| 开发 | `npm start`（不带 `PI_GUI_TOKEN`） | **无校验** | **仍然有** |

开发模式仅供本机开发。它的存在是必要的（浏览器里调试时没法注入令牌），
但它意味着**同一台机器上的任何程序都能调这个后端** —— 这是这个模式的已知代价。

## 二、渲染进程拿不到什么

渲染进程是「展示层」，它**不需要**知道任何秘密，所以它一个都拿不到：

- 令牌（在 Electron 主进程里，经请求头注入）
- 会话文件的绝对路径（只有路径的 sha1 前 16 位当 ID）
- Skill 文件的绝对路径（同上，只给哈希 ID）
- 项目的绝对路径（除了用户自己选的那个，那是必要信息）

Electron 与渲染进程之间**只有一个桥**（`electron/preload.cjs`），
只暴露三个转发动作：`openPath` 打开项目内文件、`openExternal` 打开 Release / 下载链接、
`openWebUrl` 打开 Web Activity 的 HTTP(S) 来源。不暴露整个 `ipcRenderer`。
判定在后端（`lib/git.js` 的路径校验）或主进程
（`electron/net-probe.cjs` 的 `isSafeReleaseUrl` / `isSafeWebUrl`）。
`tests/electron-guard.cjs` 钉住了这个形状。

### 外链白名单

「交给系统浏览器打开」有以下路径：

| 用途 | 判据 | 为什么 |
|---|---|---|
| 通用导航（对话里的链接、`target=_blank`） | `isSafeExternal`：只放行 `http` / `https` | 这是既有行为，收窄它会让正常链接打不开 |
| 版本检查的 Release / 下载 | `isSafeReleaseUrl`：**必须 `https` + GitHub 官方 host** | URL 来自外部响应，仓库被投毒时会变成「官方安装包」 |
| Web Activity 来源 | `isSafeWebUrl`：HTTP(S)，拒绝 URL 凭据与控制字符 | 用户明确点击，frontend / main 分别校验 |

第二条在**三个位置**各做一遍，**语义完全相同**：后端过滤 API 响应
（不让站外 URL 进 DOM）；前端在渲染 Release Notes 时按 host 收口
（白名单外的链接退化成纯文本、白名单内的也不渲染成真 `<a>` —— 因为真 `<a>`
的中键与右键菜单不经 JS，只在 click 上拦会漏）；主进程在 `shell.openExternal`
之前再拦一次（即便页面被注入脚本也打不开站外地址）。

**网页版没有主进程可转发，所以前端自己就是最后一道边界** ——
它执行的是同一套白名单，安全语义不因为少了一层而变松。
`tests/update-check.cjs` 对拍后端 ↔ 主进程，`tests/smoke.cjs` 对拍前端 ↔ 主进程，
传递出三份一致。细节见 [updates.md](updates.md)。

## 三、不可信输入

### Markdown（模型输出）

**威胁**：Agent 返回的 Markdown 直接进 DOM 就是 XSS。而且模型可能被诱导
输出恶意内容（提示注入）。

**做法**（`public/markdown.js`）：**先整体转义，再插入自己生成的白名单标签**。
也就是说，进入 HTML 的尖括号**只可能来自渲染器本身**。

这样 XSS 不是「被过滤掉了」，而是**在语法层面就不成立**：
不需要维护黑名单，也就不存在「漏掉某个向量」的问题。

具体约束：

- 不渲染原始 HTML（原文里的 `<div>` 会变成 `&lt;div&gt;`）
- 链接走 **scheme 白名单**（只放行 `http` / `https` / `mailto` 与相对路径），
  `javascript:` / `data:` / `vbscript:` / `file:` 一律退化成纯文本
- **从不生成 `on*` 事件属性**
- **不渲染远程图片** —— 避免把用户的 IP 暴露给模型随手写的一个地址

支持范围：段落、标题、有序 / 无序 / 嵌套 / 任务列表、引用、表格（带对齐）、
分隔线、围栏代码块（带语言标签，`diff` 额外逐行着色）、行内代码 / 粗体 /
斜体 / 删除线 / 链接。

**为什么不用 markdown-it 之类的成熟库**：本项目零构建、零前端依赖，引入它要
额外随包分发两个 UMD 文件（含 Apache-2.0 的署名义务），而上面这套结构性防护
已经把主要收益拿到了。渲染完整度上的差距，用增量补齐更划算。

### GitHub Release 说明

**威胁**：版本检查会把 Release 的 `body`（发布说明）显示出来，而它是
**外部 Markdown** —— 仓库被投毒 / 账号被接管时，它可以带任意内容进来。

**做法**：同一个渲染器（`public/markdown.js`），所以「转义优先」的结构性防护
照旧成立；额外再加两条：

- **最大 4000 字**，超出截断（否则一篇长文能塞进几万个链接）
- **说明里的链接按 host 白名单在渲染时收口**：白名单外的退化成纯文本，
  白名单内的也不渲染成真 `<a>`（真 `<a>` 的中键 / 右键菜单不经 JS）——
  否则一条「[点这里领奖](https://evil.example)」就能把用户引到站外

见 [updates.md](updates.md)。

### 工具输出与 Agent stdout

**威胁**：命令来自模型，输出来自被执行的程序 —— 两边都不可信。

**做法**：`public/tool-view.js` **一次 `innerHTML` 都不用**（除自己写死的
SVG 图标常量），所有文本走 `textContent`。于是「记得转义」这件事不需要被记住。
`extensions.js` / `planner.js` 同样如此（Planner 的 Agent stdout 一律当
不可信文本渲染）。

### 扩展目录只读元信息

**威胁**：扩展文件里可能有密钥。

**做法**：Extension discovery 不 import/require 候选代码，只读目录项与受限大小的
`package.json` 元数据；只输出已知字段，不回显配置中的未知字段或 Pi 原始错误。
目录 manifest、package manifest 和 package filter 都做所属根路径校验。
glob 只在 package 根内展开；每个结果再次校验，包含中间目录的符号链接也拒绝。
该策略比 Pi 0.87.0 允许部分链接的规则更严格；不通过执行 Extension 来补齐未知信息。
Skills 详情会按用户操作读取 `SKILL.md` 正文；MCP 报告只读目录元信息。
所以扩展源码里写着密钥，也不会因 discovery 出现在接口响应里
（`tests/skills.cjs` 直接断言 `ghp_LEAK_ME` 不出现）。

Extension 是**第三方本地代码**，在 Pi 进程权限下运行，可能读写文件、执行 shell、
访问网络、驱动浏览器或连接外部服务。Pi GUI 不对它提供 sandbox，也不安装或执行
候选代码。renderer 不读取 extension secrets、provider key、OAuth token 或 npm token。
诊断导出继续使用既有脱敏规则；P15 API 仅返回安全的状态与错误阶段。

## 四、文件系统边界

### 路径校验

**威胁**：客户端传 `../../` 或绝对路径，读写项目之外的文件。

**做法**：`lib/safe-path.js` 是项目内路径校验的唯一实现，被 **diff / 打开 /
撤销** 三条链路共用。`../`、绝对路径、符号链接 / junction 逃逸一律拒绝。

### 项目来源唯一

**威胁**：客户端传一个别的目录当「当前项目」，就能读到别的项目的配置。

**做法**：唯一对外暴露的项目来源是 `runtime.getCurrentCwd()`。
`/api/project-config` 等接口**不接受**客户端传 `projectPath` / `absolutePath` /
`../`。`activate` 是 cwd 的唯一写路径。

### ID 不暴露路径

**威胁**：接口回一个绝对路径，就多了一条「顺着路径去猜别的文件」的路子。

**做法**：会话与 Skill 的 ID 都是**路径的 sha1 前 16 位**；前端只拿得到 ID，
拿不到也传不了路径。切换 / 归档 / 删除时后端在自己的索引里查真实路径，
并核对那条会话确实属于当前项目 ⇒ **不可能操作到别的项目的会话上**。
列表响应里不回任何绝对路径（不回 `currentFile` / `cwd`）。

### Git 命令

**做法**：所有 Git 命令都指定项目目录、走参数数组、`shell: false`，
路径经 `lib/safe-path.js` 校验，并带超时与输出字节上限。

**批量撤销逐条走同一条动作路径**，不用 `git checkout .` / `git reset --hard` /
`git clean -fd` —— 于是「哪些文件不该被自动撤销」只有一处答案。
这几条禁令有自动化守卫盯着（`tests/git.cjs`）。

### 两条写权限默认关闭

删未跟踪文件（`deleteUntracked`）与取消暂存（`unstage`）**必须由用户明确授权**。
没有授权时后端一个字都不动，而是把「还需要什么授权」原样返回给界面 ——
所以不存在「静默改了 index」这种状态。

## 五、子进程边界

### Agent 一律过适配器

**威胁**：把用户输入拼进 shell 命令 = 命令注入。

**做法**：Planner 的所有 Agent 调用都经过 `server/agents/`，**唯一认识各 CLI
的地方**。全部是 `shell:false` + 参数数组，**一处都没有拼接命令字符串**。
取消走 `taskkill /T` 收整棵进程树（`child.kill()` 在 Windows 上只结束直接子进程，
agent 拉起的 `npm test` 会活下来继续改工作区）。

不提供「客户端传任意可执行文件」或「把 shell 命令当 agent」的入口 ——
Agent 必须来自内置 registry。

### Planner 的边界

- 计划的输出**一律视为不可信输入**：执行前校验 id 唯一、依赖存在、无自依赖、
  无环（报出环路径）、至少一个入口、agent 存在、**工作目录在项目内**
- 任何一条不过就**不许执行**
- `verification` 字段只保存描述，**由 Agent 执行**，Pi GUI 不自己 shell 执行它 ——
  「谁执行」这件事必须只有一个答案

## 六、密钥与用户数据

### 密钥只存在一个地方

`API Key` 存在 `~/.pi/agent/models.json`（pi 自己的配置）。Pi GUI 只是代写，
**不额外存一份**。

- **项目配置不保存任何密钥**：`<项目>/.pi-gui/config.json` 的字段白名单里根本
  没有这些名字，模型只存 `provider` + `id` 两个键
  （`tests/project-config.cjs` 钉住了「配置里不出现 `apiKey`」）
- 密钥**不进日志**：日志语句结构上不引用请求体
- **拉取模型列表时不会执行 `!command` 形式的 key** —— 那等于给一个网页界面
  开了任意命令执行。这种 key 手填模型列表仍然可用

### 用户数据保护：软删除

**威胁**：一次误点删掉真实的对话记录。

**做法**：会话删除是**软删除** —— 文件移进
`<PI_GUI_DATA>/trash-sessions/`，不是 `unlink`，并把「原来是谁、哪个项目、
多少条消息、何时删的」记进 `session-flags.json`，事后查得到。
**正在进行的会话拒绝删除**（pi 正开着那个文件往里追加）。

归档同样是纯组织动作：文件原地不动、pi 完全不知道。

见 [sessions.md](sessions.md)。

### 写盘一律原子

项目配置与 `session-flags.json` 都是「临时文件 → rename」的原子写。
读失败一律降级到默认值 + 轻提示，**绝不自动覆盖损坏文件** ——
只有用户点「保存」才替换。

## 七、仍然由你负责的部分

这一节和上面同等重要：

- **`pi` 本身的安全**。Pi GUI 通过 RPC 驱动你本机装的 pi。pi 能做什么、
  它的工具权限怎么配、它连的模型供应商可不可信 —— 都由 pi 和你的配置决定，
  Pi GUI 不介入也不代管。
- **模型供应商的密钥强度与额度**。填了弱 key 或把 key 贴进别的地方，
  不在这个项目的边界内。
- **开发模式下的本机暴露**。`npm start` 不校验令牌，本机任何程序都能调。
  别在不可信的本机上开着它。
- **你让 Agent 做什么**。后端能驱动任意命令，这是设计目的；它不判断
  「这条命令该不该跑」。撤销与 diff 是给你的后悔药，不是防火墙。
- **项目目录的权限**。Pi GUI 只做「项目内路径」校验，不改变操作系统的权限模型。

## P17 Subagent 边界

Context/session 隔离不是 OS sandbox；第三方 Extension 可读写文件、执行 shell、访问网络，后台 runner 可 detached。GUI 不安装、不扫描 Agent 定义、不控制 child，只投影有限白名单元数据；env/auth/token/messages/transcript 不进入 Subagent DOM。原始 Pi 会话仍由 Pi 管理。详见 [subagents.md](subagents.md)。

subagent_supervisor 的四个已知 action 与所有未知 action 都经过专用白名单投影。
message、filesystem root、channelDir、requestFile、replyFile、raw request body/question、env/auth/token/apiKey/credential/transcript
及未知 details 字段不进入 Activity DOM（包括隐藏详情、title 与历史）。status 只取 active/pending，pending/list 只取有限请求 metadata，reply 只取 replyTo/runId/agent。
不回显原始错误输出，不扫描 channel filesystem，不读取 request files，不自动执行 supervisor action 或建立 GUI 回复/权限系统。
