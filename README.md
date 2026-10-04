# Pi GUI

[![CI](https://github.com/HYJ1817/pi-gui/actions/workflows/ci.yml/badge.svg)](https://github.com/HYJ1817/pi-gui/actions/workflows/ci.yml)

给 [pi](https://github.com/earendil-works/pi) 套一个本地桌面界面：选一个文件夹当项目，
在输入框里说要做什么，文件改动与命令执行实时显示在窗口里；改完哪些文件、
具体改了什么，在侧栏「文件变更」里看 diff，然后决定留着还是撤销。

后端是个纯 Node 的 HTTP 服务，前端是原生 JS（没有构建步骤、没有框架），
Electron 只负责装一个窗口 —— 全部跑在本机，不开浏览器。

**对外的网络请求只有两处固定的版本检查**：读 GitHub 上的公开 Release 信息看 Pi GUI
有没有新版，读 `pi.dev` 的公开版本信息看本机装着的 `pi` 有没有新版。
两者都可以在诊断里手动触发，也都会在启动后各自动跑一次（延迟、可静默失败），
**不上传任何使用数据**，无网时主功能完全不受影响。用户安装的 Pi Extension 可以自行访问网络。

窗口大致是这样：左侧窄全局导航栏连接项目 / 会话侧栏，中间是连续的对话流
（工具执行直接嵌在对话里），底部是输入框。

## 核心能力

- **内置浏览器 Agent Control（P29）** —— 桌面右栏的「Agent 控制」默认关闭，开启后 Pi 可通过
  `gui_browser_*` 验证 localhost 页面：读取、点击、填表、截图、console/network、刷新。
  随安装包提供，不需额外安装，不开启调试端口，不控制用户 Chrome；与外部 `browser_*` 独立。
  页面内容会在工具调用时进入模型上下文。边界与用法见 [agent-browser.md](docs/agent-browser.md)。

- **对话** —— 流式渲染，工具调用以时间线形式嵌在对话流里
- **Web Activity** —— 可通过 Pi Web Extension 使用联网搜索与 URL Fetch，并提供原生 GUI Activity 展示；安装与安全边界见 [Web Access](docs/web-access.md)
- **Browser Use** —— 可通过 Browser Extension 让 Pi 驱动你**正在用的那个浏览器**（打开页面、点击、输入、截图、读正文），Pi GUI 提供原生 Activity 展示。它和 Web Search 是两件独立的事；这个 Extension **没有审批协议**，所以 GUI 不提供任何允许 / 拒绝按钮，也不宣称已保护 —— 边界见 [Browser Use](docs/browser.md)
- **Subagent Activity** —— 第三方 Extension 在当前对话内委派工作；展示结构化 child 状态与历史，与 Planner 独立。手动安装与限制见 [Subagents](docs/subagents.md)
- **Pi Memory（长期记忆）** —— 可通过 Pi Memory Extension 使用跨会话长期记忆，Pi GUI 对相关工具提供原生 Activity 展示。它与「会话搜索」是两套东西；安装、边界与安全投影见 [Pi Memory](docs/memory.md)
- **Approval / Permission** —— 装了会「先问一句」的 permission Extension 时，Pi GUI 用统一的确认层呈现它的请求，并把允许 / 拒绝作为**明确的协议应答**回给 Pi（拒绝真的会让这次工具调用不执行）。Pi 核心**没有**自带审批闸门，GUI 也不伪造全局权限开关；能力边界见 [Approvals](docs/approvals.md)
- **会话** —— 一次对话一条记录，挂在它所属的项目下面，随时切回旧的
- **分支** —— 从会话里任意一次对话分叉出一条新支线
- **提问导航** —— 聊天区左边一列短线，对应当前会话里的每次提问
- **会话搜索** —— 在当前项目内搜索历史提问和回答，并直接跳回对应会话
- **文件变更** —— 以 Git 为准看改了什么，按 hunk 看 diff
- **撤销** —— 逐文件撤销，或先看一遍完整计划再全部撤销
- **Skills 管理** —— 发现、查看、启用/停用你已装的 Skills
- **任务编排** —— 把大目标拆成带依赖的任务，交给不同 CLI 依次执行
- **任务工作流** —— Planner 的每次 Agent 执行可关联对应会话与执行期间文件变化，
  任务、会话和 Git Changes 可以互相追踪
- **任务验收** —— 对每次 Agent 执行结果做人工审阅，可查看关联会话与当前文件差异，
  记录「已接受 / 需修改」，并让 Pi GUI **自己跑一遍**那次执行冻结的验证命令
- **模型供应商** —— 不用手写 JSON 就能加自定义供应商，还能直接拉模型列表
- **自动备用模型** —— 项目设置中显式开启并配置顺序；仅对尚无输出的可靠生成故障尝试备用，Pi 确认后重放，成功后保持备用模型。默认关闭，边界见 [自动模型备用](docs/model-fallback.md)
- **诊断** —— 查看版本、bridge、Agent 与目录健康状态，复制脱敏 JSON 用于排障
- **版本检查** —— 在应用内检查 GitHub Release，新版本可直接查看发布说明和下载
- **Pi 运行时更新** —— 在应用内检查本机装着的 `pi` 有没有新版本；**用户确认后**由官方
  `pi update --self` 更新（更新期间暂停 Pi 进程，完成后自动重新启动并重新探测版本与能力）。
  它与上面的「版本检查」是两件事：端点、缓存、文案各有一套

## 安装

### 前置条件

**本机要先装好 pi，并且 `pi` 在 PATH 里。** 这个仓库只是界面，不含 pi 本体：

```bash
npm i -g @earendil-works/pi-coding-agent   # 需要 Node >= 22.19.0
pi --version                                # 能打印版本就对了
```

pi 本身还要配好模型供应商（API Key 之类），否则界面能打开但发出去的消息会报错。
不在 PATH 的话可以用环境变量指定：`PI_BIN=C:\...\pi.exe`。

**Pi GUI 自身也要求 Node ≥ 22.19**（写在 `package.json` 的 `engines` 里）。
和上面这条一致不是巧合 —— 运行时依赖（`pdfjs-dist`）与打包工具链的下限都在这之上，
而 pi 的要求最严，所以取它。

### Windows 安装

从 [Releases](https://github.com/HYJ1817/pi-gui/releases) 里挑一个：

| 文件 | 说明 |
| --- | --- |
| `Pi-GUI-Setup-<版本>.exe` | 安装程序。约 100 MB，装完建好开始菜单和桌面快捷方式 |
| `Pi-GUI-<版本>-portable.zip` | 便携版。解压后直接跑 `Pi GUI.exe`，不用装 |

安装程序是**单用户**的：装在 `%LOCALAPPDATA%\Programs\Pi GUI`，不弹 UAC、
不写系统目录。卸载走「添加或删除程序」，只删程序文件 ——
`%APPDATA%\Pi GUI` 下的项目列表和窗口布局会保留，重装接着用。

下载后建议核一下 `SHA256SUMS.txt`：

```powershell
certutil -hashfile Pi-GUI-Setup-<版本>.exe SHA256
```

## 快速开始

1. 装好 pi 并配好模型供应商（见上面）
2. 打开 Pi GUI，点「添加文件夹」选一个项目目录
3. 在输入框里说要做什么

想看改了什么：做完之后点全局导航栏「文件变更」，再点一行展开 diff；
不想要就点「撤销」。

## 主要功能

下面每节只给要点，完整设计与实现约束在 [文档](#文档) 里。

### 对话与会话

会话（一次对话）直接列在侧栏**当前项目那一行下面**，点一条就切过去 ——
会话本来就属于项目，不单开一个面板。

「新对话」不会把旧对话弄丢：pi 把每个会话存成独立的 `.jsonl` 文件，
`new_session` 只换了 pi 内存里的当前会话，磁盘上一个字节都没动。
列表是 Pi GUI 自己扫出来的（pi 的 RPC 没有「列出会话」的命令）。

- **新会话显示成斜体** —— pi 在会话有内容之前不落盘，列表里那条是占位，
  发第一条消息后变正常
- **归档**：只影响这个列表的可逆组织动作，文件不动、pi 不知道
- **删除**：软删除，文件进回收站目录，误点找得回来
- **分支**：从任意一次对话分叉出一条新支线

→ [sessions.md](docs/sessions.md)

### 文件变更与撤销

全局导航栏的「文件变更」列出**当前 Git 工作区**里相对 HEAD 有差异的文件，
外加相对路径和 `+N −M`。点一行就地展开 unified diff。

- 按 hunk 折叠，上下文可调（切换会重新问后端，前端补不出被裁掉的行）
- 有「全部 / 仅本次会话」两个视角，但侧栏徽标永远是 Git 的总数
- 撤销逐文件走；「全部撤销」先给你看一遍完整计划再执行
- **两条写权限默认关闭**（删未跟踪文件、取消暂存），要你明确授权
- 不是 Git 仓库不是错误 —— 只是没有变更信息，聊天和跑命令照常

定位是「看清改了什么、决定留还是撤」，**不是 IDE**。

→ [git-changes.md](docs/git-changes.md)

### 工具执行时间线

工具调用渲染成**嵌在对话流里的连续时间线**，不是一张张孤立的卡片：

```
操作 3 项
  ✓ 读取文件   src/app.js                    0.3s   128 行
  ✗ 执行命令   npm test                      12.4s  exit code 1
  ✓ 修改文件   src/util.js                   0.1s   +12 −3
```

实时与历史走**同一条渲染路径**（刷新前后语义一致是结构性保证）。
退化情况都有明确归宿，不允许静默消失：中断的收成「未完成」，孤儿结果就地降级，
未知工具显示原始名，不报错。

→ [architecture.md](docs/architecture.md#六前端渲染管线)

## 供应商与认证（P25）

模型列表保持按供应商折叠，并按已有证据展示推理、图片、Tools 与 Context。
模型能力按 Pi 运行态、用户配置、Provider metadata 的顺序合并；缺少证据保持未知。
思考等级仅取 Pi 回读结果，切模型期间清除旧候选，无可选等级时显示不可用。
模型明确不支持图片时阻止图片添加和发送，普通文件继续可用；未知图片能力不禁用。
旧 models.json 无需迁移。详见 [模型能力](docs/model-capabilities.md)。

「模型供应商」设置可展示 Pi 原生 OAuth、API Key 和环境变量认证。
ChatGPT 订阅登录走本机 Pi 的公开 SDK；凭据保存、浏览器回调和刷新由 Pi 负责。
GUI 不接收 API Key 原文，自定义供应商使用环境变量引用，既有磁盘凭据不会回显。
登录或退出后回读 Pi 状态，模型与思考档位仍由 Pi 决定。
旧 Pi 缺少公开认证入口时显示未知，并提供官方 `/login`、`/logout` 操作说明。

→ [provider-auth.md](docs/provider-auth.md)

## 兼容与升级安全（P23）

Pi GUI 是 pi 的界面，不是 pi 的一部分。所以「pi 换版本了怎么办」必须是一个
**可回答、可诊断、可复现**的问题，而不是每次靠人回忆。

- **四个「版本」分得开**：历史验证基线 / 当前验证基线 / 运行中版本 /
  **版本核对状态**（`verified` / `unverified` / `unknown` / `unchecked`）。
  版本号只用来回答「这个版本我们核过没有」，**永远不用来判断能力**。
- **能力靠 probe，不靠 `version >= X`**：14 条 probe 覆盖 RPC 命令集、
  扩展 UI 对话框、tool_call 阻断、built-in MCP、MCP 替换与闭集、`list --json` 资源字段等。
  每条都给**出处**（读了哪个文件的哪一行）与**降级策略**。只读、无副作用、不执行第三方代码。
- **升级流程写进文档**：[upgrade-playbook.md](docs/upgrade-playbook.md) ——
  取 release → diff contract → 更新 fixture → 跑契约测试 → **显式 live test** →
  更新矩阵与文档 → 人工验收。`npm run test:probes-live -- --strict` 会在
  「这个版本没被核对过」时明确说不。
  **CI 绿不能认证一个从未验证的新版本。**
- **schema 漂移看得见、但不带值**：上游多一个字段 / 多一个枚举值时，
  诊断里记下「来源 + 字段名 + 类型」—— **不记值、不记对象键名**；
  绝不因为形状不认识就回退成打印原始 JSON。
- **诊断面板**多了版本核对、能力 probe 表、兼容矩阵、Native MCP 状态、关键 Extension 版本，
  以及一个**脱敏的「复制诊断摘要」**（适合直接贴进 issue）。

→ [upgrade-playbook.md](docs/upgrade-playbook.md) · [pi-compatibility.md](docs/pi-compatibility.md)

### 能力视图（Capability）

一个界面回答「这个能力现在能不能用」，而且**不建第二套事实源** ——
它只是把 Extension Registry、各能力的运行观察与 Pi 自身的 built-in 探测**投影**成
一张统一状态表。

- 五个过滤器：**All / Capabilities / Extensions / Skills / MCP**（标签行就是过滤器，
  没新增导航）。已知能力、pi 内置能力、通用 Extension、MCP server 各归其位
- 每一条都报同一组字段：**安装状态 / 启用配置 / 已加载 / 运行观察 / 需要重启 / 诊断**，
  外加名称、用途、固定官方命令（若有）、复制、安装后重启与限制说明
- **`null` 显示「未知（无法确认）」，绝不显示成「否」**：没观察到调用不等于没有这个能力
- **Native MCP 进入统一体验但不丢边界**：它来自 Pi 的 builtin capability，
  所以**不显示 npm 安装命令**；原生状态（生效 / 被接管 / 被停用 / 不支持）原样搬运
  P20.6 的结论，不重新判断。内置扩展标成 `builtin:`，不伪装成你装的 Extension
- 不认识的 Extension **照常出现**、状态是未知、错误就地显示 —— 一个都不丢
- 只读：没有 Marketplace、没有自动更新、没有评分、没有远端 catalog、没有安装按钮

→ [capability-ux.md](docs/capability-ux.md)

### Skills / Extensions / MCP

管的是**你已经装好的**能力，不是商店 —— 没有下载、没有安装。

- **Skills** 是 pi 的原生能力：发现、查看、启停用 pi 官方的 override 机制，
  改完会自动重启 pi（pi 没有文件监听）
- **Extensions**：只读发现当前磁盘上的候选项，分开显示安装、配置与加载证据。
  Pi RPC 没有已注册工具清单，所以不会猜某个扩展提供了什么工具；安装与启停仍用 Pi 官方 CLI。
  Web / Subagent / Memory / Browser 的设置区（固定官方安装命令 + 安装后重启 Pi +
  当前 bridge 的真实工具调用观察）现在统一在 Capability 视图里。
  **长期记忆由 Extension 提供，不是 Pi GUI 内置的**
- **MCP**：用 pi **原生** MCP，Pi GUI 不自建 runtime —— 历史验证基线 **0.87.0**
  没有原生 MCP，当前验证基线 **0.99.2** 自带 `builtin:mcp`。标签页显示原生状态
  （active / replaced / disabled / unknown，只认证据）、两处 `mcp.json` 的
  安全结构解析、`pi mcp list --json` 的运行时状态（点刷新才跑，**缓存按项目与
  pi 实例分键**，切项目不会沿用上一个项目的结果），以及受控动作
  （add / remove / login / logout 走 pi 官方 CLI；enable 等走 `/mcp` TUI）。
  `mcp__` 工具调用走 Tool Timeline 语义行。**RPC 至今没有已注册工具清单命令**，
  所以不伪造工具注册表。
  安全边界：添加接口**只接受不含凭据值的配置**（`env` / `headers` / `oauth` /
  `auth` 在 HTTP 边界即拒绝）；项目级写操作**受 project trust 闸门保护**
  （未信任或信任未知一律 fail closed）；**未信任项目的同名 server 不覆盖用户级**；
  `mcp-auth.json` 从不读取，OAuth token 全程由 pi 自己管理。
  诚实边界：`pi mcp list --json` 是 shell 命令、**不加载 extensions**，所以它只
  看得到 `global` / `project` 两处 `mcp.json`；用 `pi.registerMcpServer()` 注册的
  session server 在 GUI 里属于 unknown / 不可枚举

→ [mcp.md](docs/mcp.md) · [extensions.md](docs/extensions.md)

### 任务 / 多 Agent 编排

**这不是 pi 的能力** —— pi 没有原生 sub-agent 也没有 plan mode。
这一层是 Pi GUI 在 pi 之上做的编排。

写一个较大的目标 → 生成计划 → 改 → 开始执行。
**不存在「一生成就自动开跑」**。即使 AI Planner 完全不可用，
手工新建空计划 + 自己加任务照样能跑。

- 依赖是真正的 DAG，执行前校验（无环、有入口、cwd 在项目内）
- 默认串行（多个 agent 同时改一个工作区会互相覆盖）
- 失败就暂停整个计划，给你重试 / 跳过 / 停止三个选择
- 可指定 `pi` / `codex` / `gemini` / `claude` 执行，可用性在运行时探测
- **每次执行结果可以人工验收**：看那次关联的会话、执行期间涉及的文件，以及**两个分开的
  Diff 入口**（工作区此刻的**当前 Diff** / 那次执行前后冻结的**本次 Diff**），
  然后记下「已接受 / 需修改」
- **历史变更证据**：每次执行前后各把工作区写成一棵 git tree（**临时 index，不碰你真实的
  `.git/index`**）再比 —— 所以「本次 Diff」**不随工作区漂移**：之后又改了文件、Retry 过、
  甚至工作区变回 clean，那条记录的内容一个字节都不动。它说的是「这段时间里工作区发生了
  什么」，**不是**「Agent 改的」
- **独立验证**：对某一次执行点「运行验证」，Pi GUI 自己跑一遍**那次执行当初
  冻结的**验证命令与工作目录，把退出码、耗时和输出摘要记在那条记录上。但
  **验证通过不等于验收通过** —— 认不认这个结果仍然是你的判断
- **人工验收门控（可选）**：给某个任务勾上「需要人工验收后再继续下游」，它就变成
  一道闸门 —— 执行成功**不等于**放行，要等你把**最新一次成功尝试**标成「已接受」，
  依赖它的任务才会变成可执行。**不会**替你自动跑下游、**不会**自动重试，
  **也**不把「在等人」混进执行状态（执行成功就是成功）
- **一次只干一件事**：同一时间只允许一个会实际执行工作区命令的主体（计划或验证）。
  验证在跑时起不了计划、不能重试 / 改计划 / 切项目 —— 免得两边的命令在同一个
  工作区里互相搅

→ [planner.md](docs/planner.md) · [reviews.md](docs/reviews.md)

### 模型供应商

全局导航栏「更多 → 模型供应商」可以往 pi 的 `~/.pi/agent/models.json` 里加自定义供应商
（Ollama、vLLM、LM Studio、各种中转站），不用手写 JSON。

「模型列表」可以手填，也可以点**「拉取」**直接从供应商的 `/models` 接口读
（由后端代发，浏览器直连会撞 CORS），并按 API 类型自动选对路径和鉴权头。

**能带回多少取决于供应商的接口** —— OpenRouter 和 Google 回得比较全，
OpenAI / DeepSeek / Anthropic 基本只有一个 id，那就只填 id。

→ [architecture.md](docs/architecture.md#八模型供应商与模型列表)

### 版本检查与更新

全局导航栏「更多 → 诊断」顶部有个「版本」小节：显示当前版本，一个 `[检查更新]` 按钮。

启动后也会**低打扰地**自动检查一次（延迟 8 秒、不阻塞启动）。发现新版本时
只有一次轻提示 + 诊断入口上的一个小点 —— 不弹窗、不重复打扰；
失败与无更新完全静默。

有更新时会摆出版本号、发布时间和**发布说明**，并给出「查看 Release」
与「安装版 / 便携版 / 校验和」的下载入口 —— 点开走系统浏览器，由 GitHub 下载。

**它不下载、不安装、不静默升级、不改 exe、不重启。** 这一层只负责
「发现 + 展示 + 让你自己点」，安全边界最简单。

只读取公开的 GitHub Release 元数据，**不上传任何使用数据**：没有 telemetry、
不带任何凭据、请求里只有 GitHub API 必需的 `User-Agent` 与 `Accept`。
无网时主功能完全不受影响。

→ [updates.md](docs/updates.md)

### Pi 运行时更新

同一块「诊断」里、紧挨着「版本」还有一节 **`Pi`**：显示本机装着的 pi 的版本和一个
`[检查 Pi 更新]` 按钮（启动后 12 秒也会静默检查一次，**只检查、不安装**）。
发现新版时给 `[更新到 x.y.z]`，点了先弹确认框，确认后由**官方**
`pi update --self` 更新：

- 更新期间暂停当前的 Pi 进程（bridge 进入维护态）、完成后自动恢复；
- **不会**更新 Extension、模型目录或 Node，也不会 `npm install -g` 或下载安装包；
- 官方 updater 退出码为 0 **不算成功** —— 之后会清掉与 pi 包身份绑定的缓存、
  用同一份启动身份重新读版本，版本真的变了才算更新成功；
- 更新后重新做能力探测：**没核对过的版本照旧显示「未验收」**，能力判定只看实际探测，
  不因为「刚更新过」就当作支持。

入口：全局导航栏「更多 → 诊断」→ `Pi`。端点与边界见
[updates.md](docs/updates.md) 第二部分与 [security.md](docs/security.md)。

## 安全

后端能驱动 pi 执行任意命令，所以**它的边界是唯一防线**。三条主要约束：

1. **只监听回环**（`127.0.0.1`），不用 `0.0.0.0`
2. **应用级身份握手** —— 端口上「有人在听」不等于「这是我们的后端」。
   启动时探 `/api/health`，凭 `app` / `protocol` 判断；如果是别的程序，
   **直接报错退出，绝不把窗口指过去**
3. **本地令牌** —— Electron 每次启动现生成，经请求头注入，
   **从不进入渲染进程**；请求还校验 `Origin`，非本机同源一律 403

此外：对话里的 Markdown 与工具输出**一律当不可信输入**处理；
所有 Git / Agent 命令走参数数组 + `shell: false`，路径经校验；
密钥只存在 `~/.pi/agent/models.json`，**项目配置不保存任何 secret**。

**仍然由你负责的部分**：pi 本身的配置与工具权限、模型供应商密钥的强度、
你让 Agent 做什么、以及开发模式（`npm start`）下本机程序都能调这个后端。

→ [security.md](docs/security.md)

## 从源码运行

```bash
npm install
npm start          # 只跑后端，用浏览器开 http://127.0.0.1:7788
npm run app        # 桌面窗口（Electron 会自己拉起一份后端，不用先 npm start）
```

改前端时用 `npm start` 更快（改完刷新页面即可）。构建与发版见
[development.md](docs/development.md)。

## 测试与开发

```bash
npm test           # 40 个套件，纯自动化，约 3-4 分钟（不联网、不花模型额度）
```

`npm test` 是测试入口的**唯一真相** —— CI 只调它，不把子测试抄进 workflow。
需要真 pi 的（`test:skills-live` 等）与需要 NSIS 的
（`test:portable` / `test:installer`）都不进默认 CI。

三个 workflow 分工按「多贵」划：`ci.yml`（每次提交）→ `release-check.yml`
（手动，跑完整发布路径但不发版）→ `release.yml`（tag 触发，验证全过才发布）。
三者调的是同一套 npm 脚本。

CI 在 **windows runner** 上跑：Node 22 与 24 各跑一遍 `npm test`，
通过后做一次 Electron 打包并验产物（25 项 + 47 项）。

常用单跑：`test:ui` / `test:git` / `test:modules` / `test:config` /
`test:skills` / `test:planner` / `test:workflow` / `test:reviews` / `test:verify` /
`test:evidence` / `test:lifecycle` / `test:web` / `test:browser` /
`test:sessions` / `test:search` / `test:mcp` / `test:quota` /
`test:security` / `test:diagnostics` / `test:update` / `test:pi-update` / `test:version` /
`test:release` / `test:guard`。

需要真浏览器的一条（opt-in，**不在 CI 里**）：`PI_GUI_BROWSER_LIVE=1 npm run test:browser-live`。

准备发版时有一条命令跑完的入口（版本一致性 + 全部测试 + 两条打包链路 +
产物验证 + 校验和）：

```bash
npm run release:check -- --with-installer    # → READY TO RELEASE
```

流程见 [releasing.md](docs/releasing.md)。

> jsdom **不做布局**，所以改了 `public/` 的样式或排版，**必须真看一眼截图** ——
> 测试全绿也说明不了排版对不对。

→ [testing.md](docs/testing.md)

## 文档

| 文档 | 讲什么 |
| --- | --- |
| [architecture.md](docs/architecture.md) | 进程与职责边界、pi RPC bridge、HTTP+SSE、项目生命周期状态防护、模块地图、数据存储 |
| [app-shell.md](docs/app-shell.md) | P14-A 三列 App Shell、全局导航映射、项目侧栏与验证场景 |
| [conversation-ui.md](docs/conversation-ui.md) | P14-B 消息、Thinking、工具、附件、Minimap 与阅读列的视觉规则 |
| [composer-ui.md](docs/composer-ui.md) | P14-C 浮动输入区、控件映射、高度同步与视觉验证 |
| [work-surfaces.md](docs/work-surfaces.md) | P14-D 四个 Stage 一级视图、生命周期、Chat 保留与二级 Modal 边界 |
| [security.md](docs/security.md) | 安全边界：回环、令牌、Origin、不可信输入、路径与子进程边界、密钥、Pi 运行时更新边界、以及你仍需负责的部分 |
| [sessions.md](docs/sessions.md) | 会话：文件机制、列表与归属、当前/pending、切换、归档、软删除、分支、提问导航 |
| [git-changes.md](docs/git-changes.md) | 文件变更：diff 渲染、撤销规则、权限闸门、设计取舍 |
| [planner.md](docs/planner.md) | 任务编排：Planner/Executor、Agent registry、DAG、失败与恢复、限制 |
| [workflows.md](docs/workflows.md) | 任务工作流：任务 ↔ 会话、任务 ↔ 文件、打开会话、项目隔离、元数据边界 |
| [reviews.md](docs/reviews.md) | 人工审阅：执行结果 ≠ 验收、三个审阅状态、验证快照、当前 diff、冲突与 revision、限制 |
| [extensions.md](docs/extensions.md) | 五个能力过滤器、Skills 发现与启停、Extension 只读发现与能力证据、MCP 原生集成 |
| [capability-ux.md](docs/capability-ux.md) | P22 能力视图：投影层边界、统一状态六字段与四值、统一 setup 布局、证据来源、Registry 边界、重启与 stale |
| [mcp.md](docs/mcp.md) | P20.6 MCP：用 pi 原生 MCP（不自建 runtime）、状态来源、受控动作、OAuth/工具/资源/权限边界 |
| [project-config.md](docs/project-config.md) | 项目配置：位置、字段、优先级、指令注入、坏配置行为 |
| [development.md](docs/development.md) | 从源码跑、三种构建形态、离线/代理构建、发版流程与坑 |
| [testing.md](docs/testing.md) | 测试分层：哪些进 CI、哪些要真 pi、哪些只在发布前跑 |
| [diagnostics.md](docs/diagnostics.md) | 诊断快照：收集范围、脱敏规则、隐私边界与测试 |
| [pi-compatibility.md](docs/pi-compatibility.md) | 与 pi 的边界、依赖哪些能力、缺失时怎么降级、P23 的版本真值 / probe registry / 兼容矩阵 / schema 漂移 |
| [upgrade-playbook.md](docs/upgrade-playbook.md) | P23 升级流程：取 release、diff contract、更新 fixture、契约测试、显式 live test、更新矩阵与文档、人工验收；内置更新器只是其中第 1–6 步的便利层 |
| [updates.md](docs/updates.md) | 两部分：Pi GUI 更新（数据源、SemVer、缓存与 single-flight、外链白名单、隐私、为什么不自动安装）与 Pi 运行时更新（检查、官方 `pi update --self`、维护暂停、版本复验） |
| [releasing.md](docs/releasing.md) | 发版：一条命令的发布预检、版本一致性守卫、资产命名契约、tag → 自动发布、失败不留半成品 |
| [web-access.md](docs/web-access.md) | Web Search / URL Fetch：适配的 Extension、状态模型、来源安全、外链边界 |
| [browser.md](docs/browser.md) | Browser Use：适配的 Extension 与工具清单、成功证据规则、输入内容与页面正文的安全投影、URL 过滤、为什么没有审批流 |
| [usage-quota.md](docs/usage-quota.md) | P21 用量与配额：本地模型用量（真实 token/cost/context）与 Provider 远端配额（官方 adapter/TTL 缓存/防重入/凭据隔离） |
| [daily-use.md](docs/daily-use.md) | P24 日常使用：命令面板（只暴露已有动作）、快捷键注册表（单一入口、不抢文本输入）、未发送草稿的存储边界与身份隔离、启动/连接状态说明、加载/空/失败措辞统一、无障碍 |
| [code-signing.md](docs/code-signing.md) | Windows 代码签名（SignPath Foundation）：签名边界（哪些 PE 属于本项目）、签名流水线、GitHub Actions 接入与审核通过后的发版改动 |

## Code signing policy

Windows 版通过 [SignPath.io](https://signpath.io) 做免费的代码签名，证书由
[SignPath Foundation](https://signpath.org) 提供：

> **Free code signing provided by SignPath.io, certificate by SignPath Foundation.**

只签**本项目自己构建的**产物 —— 目前就是由 `installer/pi-gui.nsi` 编译出来的
Windows 安装程序。随包分发的 Electron / Chromium / Node 等**上游开源二进制不签**
（那不是本项目维护的代码，给它们套本项目的证书是 SignPath 明令禁止的用法），
所以便携版里那个运行时 exe 依旧没有签名。

- 完整政策（角色分工、审批流程、证书范围）：[CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md)
- 隐私声明（联不联网、传什么、什么时候传）：[PRIVACY.md](PRIVACY.md)
- 签名边界清单与接入方式：[docs/code-signing.md](docs/code-signing.md)

**卸载**：装完走「设置 → 应用 → 已安装的应用 → Pi GUI → 卸载」（开始菜单里也有）。
卸载只删程序文件和快捷方式，`%APPDATA%\Pi GUI` 里的项目列表与窗口布局会保留。

## 许可证

本项目是 [MIT](LICENSE)。

打包出去的安装程序 / 便携版里还内嵌了这些第三方组件，各自的许可证随包附在
`resources/app/THIRD-PARTY-NOTICES.txt`：

| 组件 | 许可证 | 说明 |
| --- | --- | --- |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | Apache-2.0 | PDF 文本抽取，会打进包里 |
| [Electron](https://github.com/electron/electron) | MIT | 桌面窗口运行时 |
| [esbuild](https://github.com/evanw/esbuild) | MIT | 只在构建期用 |

**界面本身不含 pi 的代码** —— 它是通过 RPC 调用你本机安装的 pi（pi 是 MIT）。
