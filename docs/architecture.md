# 架构

面向维护者。这份文档回答「系统是怎么组成的、状态放在哪、为什么这么切」。
用户视角的功能说明在 [README](../README.md)，安全边界在 [security.md](security.md)。

## 一、三个进程，两条边界

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程（electron/main.cjs）                        │
│  · 生成令牌、拉起内嵌后端、管窗口与导航                      │
│  · 唯一持有令牌的地方；经 onBeforeSendHeaders 注入到请求头   │
└───────────────┬─────────────────────────────────────────────┘
                │ 只经 preload 桥（contextBridge）暴露一个入口
┌───────────────▼─────────────────────────────────────────────┐
│ 渲染进程（public/）                                         │
│  · 原生 ES Module，零构建、零前端依赖                        │
│  · 拿不到令牌，也拿不到任何绝对路径                          │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP + SSE（127.0.0.1，令牌 + Origin 校验）
┌───────────────▼─────────────────────────────────────────────┐
│ 后端（server.js + server/，纯 Node HTTP）                   │
│  · 唯一能 spawn pi 的地方                                    │
│  · 唯一能读文件系统 / 跑 git 的地方                          │
└───────────────┬─────────────────────────────────────────────┘
                │ JSONL over stdin/stdout（--mode rpc）
┌───────────────▼─────────────────────────────────────────────┐
│ pi（本机安装的 pi-coding-agent）                            │
└─────────────────────────────────────────────────────────────┘
```

切法的理由：

- **Electron 只做窗口**，不承载业务。它一换（换成 Tauri、或者干脆只跑浏览器），
  后端一行都不用改 —— `npm start` 那条路就是这么来的。
- **后端是唯一的能力出口**。它能驱动 pi 执行任意命令，所以安全边界只有它一处
  （见 [security.md](security.md)）。把校验散到渲染进程等于没有校验。
- **渲染进程什么都不知道**：不知道令牌、不知道会话文件路径、不知道项目绝对路径
  以外的东西（项目路径本来就是用户自己选的）。

## 二、pi RPC bridge（`server/rpc-bridge.js`）

Pi GUI **不 import pi 的任何代码**，只把 pi 当子进程按官方 RPC 协议对话
（`pi --mode rpc`）。这样 pi 升级、换版本、甚至换成别的实现，界面都不用跟着动。

几个必须守住的点：

- **stdout 只按 LF 切分**。pi 的 JSONL 协议一条一行，用 readline 之类的
  会把 `\r\n` 或超长行处理成别的东西。
- **诊断输出走 stderr**，不污染 stdout 的 JSONL。
- **令牌从 pi 的环境里摘掉**。pi 自带 bash 工具，环境变量对它（以及它跑的
  任何命令）都是可读的；令牌一旦进工具输出就会随对话进模型上下文。
- **`request()` 是请求/应答配对**（按 id）。它**永不 reject**，失败一律回 null ——
  调用方要的是「拿不到就降级」，而不是让一个读接口抛 500。
  超时、子进程退出、重启时统一 `settleAllPending(null)`，不让调用方干等超时。
  它**不影响 SSE** —— 同一条应答仍然照常 publish 给前端。
- **没有项目就不启动 pi**。pi 的 cwd 只能在启动时确定；随便挑一个目录当 cwd
  会凭空造出一批会话文件，还会把那个目录的历史会话显示给用户。

### 启动参数：哪些能传，哪些不能

这是实测出来的硬约束（pi 源码 `dist/main.js` 的 `hasRuntimeErrors` 分支）：

> **非交互模式（含 `--mode rpc`）下，任何 error 级启动诊断都会 `process.exit(1)`。**

| 参数 | 后果 |
|---|---|
| `--provider <不存在>` | **exit 1** |
| `--model <provider>/<id>` 整体不存在 | **exit 1** |
| `--provider <有效> --model <不存在>` | 只 warning，不退出 |
| `--thinking <非法值>` | 只 warning，不退出 |

所以**项目配置里的模型绝不能当启动参数传**：引用一过期，pi 就退出 → 桥接每
`RESTART_DELAY_MS`（1200ms）重启一次 → 项目彻底打不开。模型改成
「pi 起来后用 `get_available_models` 核对 + `set_model` 落地」——
那条路失败只回 `{success:false}`，不退出、不动当前模型。

思考档位与项目指令走启动参数是安全的（前者只 warning，后者见
[project-config.md](project-config.md)）。

## 三、HTTP + SSE

- **路由表顺序即语义**（`server/router.js`）。几处「必须排在前面」的注释都是
  踩过的坑，典型的是 `/api/providers/models` 必须排在 `/api/providers` 前缀匹配
  之前，否则会被当成「保存一个叫 models 的供应商」，而且前端拿不到任何报错。
- **`/api/project-config` 刻意不挂在 `/api/projects/` 前缀下** —— 那个前缀匹配会
  把它吃掉，症状是静默的（GET 返回项目列表、PUT 落进 405）。
- **SSE 事件总线**（`server/sse.js`）：`clients` / `backlog`（800 条）/
  `_seq`（单调序号）/ 25s ping。断线重连靠 `_seq` 去重，并按 `bridgeRun`
  过滤掉旧 pi 的事件。
- 选 SSE 而不是 WebSocket：只需要服务端单向推，SSE 在 HTTP 上就能跑，
  不用引入协议升级、心跳和重连状态机。

## 四、项目生命周期与状态防护

前端有两个「代次」概念，**它们是两件不同的事，不要混**：

| 名字 | 表示什么 | 防的是 |
|---|---|---|
| `workspaceGeneration` | 前端最后一次**项目选择** | 旧项目的 HTTP 结果更新到新项目的 UI 上 |
| `bridgeRun` | 后端每次**启动 pi** 的运行代次 | 旧 pi 的应答/事件更新到当前会话上 |

配套的几条规则：

- **项目选择按点击顺序排队**：中间未开始的跳过，最后一次生效。
- **切换期间锁定输入**；新 pi 的 `get_state` 与 `get_messages` 都回来后才解锁。
  同步超时会释放切换状态并给出可执行提示，而不是一直锁着。
- **RPC 命令带期望的 `bridgeRun`**，后端在写进 pi stdin 之前核对 ——
  避免旧请求抵达新进程。
- **项目配置保存带期望 cwd**，后端读请求体后核对 —— 避免旧表单写进新项目。
- **重启合并**：连续调用 `restart()` 不会重复 kill / spawn；进程退出后
  只安排一个替换进程。启动失败用 `close` 兜底（ENOENT 可能只有
  `error` + `close`，没有 `exit`），失败重启走指数退避。
- **崩溃收尾**：桥接退出时把还挂在 `running` 的工具条目收成「未完成」，
  不让界面永远转下去。

### 异步链路审计结论（P4 阶段整理）

| 链路 | 原有风险 | 处理 |
|---|---|---|
| 项目切换 | A 的状态、历史、Git 或 Skills 晚于 B 返回 | generation 与请求序号 |
| 模型恢复 | A 的配置或模型列表在 B ready 后触发 `set_model` | generation、bridgeRun、cwd 三重核对 |
| pi restart | 连续调用重复 kill 或 spawn | 合并正在执行的重启；退出后只安排一个替换进程 |
| pi 启动失败 | ENOENT 可能只有 `error` + `close`，没有 `exit` | `close` 兜底收尾；失败重启指数退避 |
| RPC request | 子进程退出或重启后 pending 等到超时 | 立即 settle 并清理计时器；stdin 异步写错误也 settle |
| SSE | 重连会补发 backlog | `_seq` 去重，并按 bridgeRun 过滤旧 pi 事件 |
| Tool Timeline | pi 崩溃后 running 留在界面 | bridge exit 时收成未完成；历史重建覆盖旧 DOM |
| Git status | 旧请求和新请求乱序 | generation 加单模块请求序号，保留 Git 作为权威 |
| CLI 端口占用 | 任意服务被当成 Pi GUI 打开 | 健康检查核对 app 与 protocol |
| 应用关闭 | `closeAll()` 没显式清除 SSE ping | 逐连接清 timer 后结束流 |

覆盖情况：`test:reliability-live` 用隔离的真实 pi 目录覆盖 A→B→A、配置保存、
连续手动重启、Skill 停用后重启、SSE 断开与 backlog 重连；`e2e:app` 用打包的
Electron 应用覆盖消息发送与错误呈现、窗口内 A→B→A、配置触发重启、关闭重开后
恢复。配置损坏、目录权限、磁盘写失败已由定向自动测试覆盖主要响应路径，
尚未逐项在真实桌面手工复现。

## 五、Git 刷新的状态模型

- **以 Git 为准**：界面上的数字来自 `git status`，不是「Agent 声称改过什么」。
- **写操作后自动刷新**（`write` / `edit` / `bash`），防抖 450ms ——
  连续改多个文件只查一次 `git status`。
- **加请求序号**：旧请求回来晚了不覆盖新结果。前端还有一层
  `workspaceGeneration` 过滤，跨项目的旧结果直接丢。
- 所有 Git 命令都指定项目目录、走参数数组、`shell: false`，路径经
  `lib/safe-path.js` 校验，并带超时与输出字节上限。

用户可见的行为见 [git-changes.md](git-changes.md)。

## 六、前端渲染管线

**零构建、零前端依赖**：`public/` 就是浏览器直接跑的原生 ES Module，
`app.js` 只做装配。好处是改一行刷新就见效，没有构建产物与源码不同步的问题
（打包形态另说，见 [development.md](development.md)）。

### Tool Timeline：一套中间结构，两条数据来源

实时事件与历史消息**各自解析成同一个 `ToolEntry`**，视图只认它：

```
SSE 事件流  ──┐
              ├──→ ToolEntry ──→ tool-view.js
get_messages ─┘
```

「刷新前后语义一致」是**结构性保证**，不靠对齐两套代码维持 —— 因为压根只有一套。
`tool-model.js` / `tool-history.js` 是纯数据 + 纯函数，不碰 DOM，所以能单测。

分组边界 = 一条 assistant 消息里的全部 toolCall（真实边界，不用「超过几秒算一组」
这种猜测）。限流三档：流式重画 150ms、时长 ticker 300ms、Git 刷新防抖 450ms。

**退化情况都有明确归宿，都不允许静默消失**：

| 情况 | 呈现 |
|---|---|
| 有 `toolCall` 没有 `toolResult`（中断 / 崩溃 / 会话被切走） | 「未完成」，虚线圆圈 |
| 有 `toolResult` 没有 `toolCall`（孤儿） | 就地降级成一条，不吞掉 |
| 未知工具（扩展注册的 / 以后新加的） | 「执行工具 + 原始名字」，不报错 |
| `agent_settled` 时还有条目在 running | 收成「未完成」 |
| 只有 `toolCall` 的助手消息 | 整条外壳（含「Pi」角色行）收掉，不留空白 |

### 几条 pi 协议事实（实测得出，代码里没有一处靠猜）

- `tool_execution_update.partialResult` 是**累积值**不是增量 → 整体替换；
  但空文本不覆盖已有内容（`bash` 的 `onUpdate` 会先发一次空的）。
- `tool_execution_end` **不保证带** `toolName` / `args` → 工具名与参数在
  `start` 时存进 entry。
- 协议里**没有结构化退出码**（`bash` 的 `details` 只有 `truncation` /
  `fullOutputPath`），只能从输出文本解析 pi 自己拼的 `Command exited with code N`；
  **解析不到就不显示，绝不按 `isError` 猜一个数字**。
- `toolResult` 是**独立的一条消息**，不在 `assistant.content[]` 里；
  配对键 `toolResult.toolCallId === toolCall.id`。
- 历史里**没有工具级起止时间戳** → 时长靠两条消息的 timestamp 估算，比实时值略大。
- `edit` 的 `details.diff` 是**单次**改动量，只作兜底；文件级权威 `+N −M` 由
  `git status` 给。
- `result.content` 是**单一文本流**，stdout / stderr 无法分离。
- 一条 assistant 消息可带**多个** toolCall，后面跟同样多条 toolResult，顺序可靠。

### 为什么零 `innerHTML`

`tool-view.js` 一次 `innerHTML` 都不用（除自己写死的 SVG 图标常量），
所有文本走 `textContent` —— 「记得转义」这件事不需要被记住。
`extensions.js` / `planner.js` 同样如此。理由见 [security.md](security.md)。

## 七、模块地图

### 后端

- `server.js` — **装配层**。只做：读环境变量、建共享运行态、按依赖顺序组装各模块、
  创建 HTTP server、启动 pi 桥接、listen、管生命周期。具体业务在 `server/` 下。
- `server/` — 各职责模块。全部由 `server.js` 装配，**模块之间不互相 import**
  （唯一例外是 `git-routes` 调 `lib/git.js`），依赖方向永远是 `server.js → 模块`：
  - `auth.js` — 访问控制（令牌 + Origin）与身份探测端点。令牌定长比较，
    错误信息不回显收到的值
  - `rpc-bridge.js` — pi 子进程：spawn / stdout JSONL 解析（**只按 LF 切分**）/
    stdin 写入 / 崩溃重启 / `request()` 配对。**令牌在这里从 pi 的环境里摘掉**
  - `pi-compat.js` — **pi 兼容层**：能力探测、response 形状规范化、协议异常记录。
    **只观察、不参与判断**，也不联网 / 不发请求 / 不碰磁盘 —— 证据全部来自
    bridge 与 sessions 已有的链路。见 [pi-compatibility.md](pi-compatibility.md)
  - `sse.js` — 事件总线：clients / backlog / `_seq`。断线重连靠 `_seq` 去重
  - `runtime.js` — 共享运行态（`currentCwd` / `shuttingDown`）的**唯一权威**。
    拆模块最容易出的问题是 cwd 漂移，所以这两个变量只在这里存一份
  - `projects.js` — 项目列表、目录浏览、切换项目；`activate` 是 cwd 的唯一写路径，
    另有 `beforeActivate` 闸门（Planner 运行中拒绝切项目）
  - `project-config.js` — 项目偏好的读取 / 校验 / 归一化 / 原子写入 / 默认值，
    以及「给 pi 的启动参数」。**不存任何密钥**，唯一对外暴露的项目来源是
    `runtime.getCurrentCwd()` —— 接口不接受客户端传路径。
    见 [project-config.md](project-config.md)
  - `providers.js` — `~/.pi/agent/models.json` 的读写、供应商 CRUD、模型拉取
  - `skills.js` — Skill 的发现 / 详情 / 启停。**移植 pi 自己的规则**（发现位置、
    两种 collect 模式、同名优先级、信任闸门、override 语法），每条都注明源码出处。
    见 [extensions.md](extensions.md)
  - `mcp.js` — MCP **能力报告**（不是 MCP 管理器）。去读本机装的 pi 包、给出
    「支不支持」的结论与原文证据，并列出官方替代路径 extension 下已有哪些东西。
    **只读名字，不读内容、不执行**
  - `sessions.js` — 会话列表 / 切换 / 改名 / 归档 / 删除。见 [sessions.md](sessions.md)
  - `agents/` — Agent 适配器与 registry。**唯一认识各 CLI 的地方**，Planner 不直接
    spawn 任何东西。所有调用都是 `shell:false` + 参数数组；`.cmd` shim 会被解析成
    包里真正的入口（`.js` 用 `process.execPath` 跑，`.exe` 直接跑）；取消走
    `taskkill /T` 收整棵进程树。见 [planner.md](planner.md)
    - `cli.js` — 共享的进程执行层（spawn / 行切分 / 超时 / 取消 / stdout 上限）
    - `pi.js` / `codex.js` / `claude.js` / `opencode.js` / `gemini.js` — 各 CLI 的适配
    - `fake.js` — 测试用适配器（确定性、进程内、不消耗额度）
    - `index.js` — registry：register / detect / get / list / resolveAuto
  - `planner/` — Planner / 多 Agent 编排。**Planner 与 Executor 严格分开**，
    见 [planner.md](planner.md)
    - `model.js` — Plan / Task 模型、DAG 校验、cwd 安全（复用 `lib/safe-path.js`）
    - `store.js` — 计划持久化（`<DATA_DIR>/plans/`，原子写，崩溃恢复只在启动时做）
    - `scheduler.js` — 只负责执行已确认的计划：依赖推进、串行、失败暂停、取消、重试
    - `index.js` — HTTP 路由 + 计划生成（用 pi 适配器 + 独立会话，不污染主聊天）
  - `uploads.js` — 附件上传与落盘（`safeName`）
  - `git-routes.js` — Git 接口的 **HTTP 适配层**，业务逻辑全在 `lib/git.js`
  - `router.js` — 路由表与静态资源。**顺序即语义**
  - `http-utils.js` — `json` / `readBody` / `readRawBody`。被五条链路共用，
    不能各复制一份
  - `port-owner.js` — 端口占用探测

### 共享库

- `lib/assets.js` — 静态资源解析（SEA 内嵌 vs 读磁盘两套模式）
- `lib/git.js` — Git 状态 / diff / 撤销。默认只读；写操作只有「撤销单个文件」
  与「撤销全部」，且两条权限闸门（删未跟踪文件、取消暂存）默认关闭
- `lib/safe-path.js` — 项目内路径校验，被 diff / 打开 / 撤销三条链路共用
- `lib/models-api.js` — 从供应商 `/models` 拉模型列表（路径回退、按 API 类型适配）
- `lib/extract.js` — docx / pdf / 图片的文本抽取（pdfjs）

### 前端

`public/` — 原生 ES Module，`app.js` 只做装配，其余按职责分模块：

- `api.js` 网络 / `state.js` 状态 / `shell.js` 外壳 / `util.js` 工具
- `markdown.js` Markdown 渲染（安全设计见 [security.md](security.md)）
- `messages.js` 对话流 / `composer.js` 输入框 / `attachments.js` 附件
- `tools.js` + `tool-model.js` + `tool-view.js` + `tool-history.js` 工具时间线
- `git.js` 变更面板 / `diff.js` unified diff 渲染 / `changes.js` 会话改动账本
- `sessions.js` 侧栏会话列表 / `conversation-nav.js` 会话内提问导航 /
  `tree.js` 分支树
- `extensions.js` 扩展面板 / `planner.js` 任务面板 / `project-config.js` 项目设置
- `providers.js` 模型供应商 / `usage.js` 用量与状态 / `ui/` 通用组件
  （`modal.js` / `popover.js` / `toast.js`）

### 桌面与构建

- `electron/main.cjs` — 主进程，拉起内嵌后端、管窗口与导航
- `electron/preload.cjs` — 渲染进程与主进程之间**唯一的桥**
  （只暴露「用系统默认程序打开文件」）
- `electron/net-probe.cjs` — 端口探测与 URL 判定（纯逻辑，不依赖 electron，可单测）
- `installer/pi-gui.nsi` — 安装程序脚本（NSIS）
- `assets/icon-src.png` — 图标母图；`scripts/make-icon.mjs` 读它、切圆角、
  编码成 `build/icon.ico`（不在就退回程序化绘制的 π）
- `scripts/` — 构建脚本，`scripts/util.mjs` 是共用小工具。见 [development.md](development.md)

## 八、模型供应商与模型列表

`provider.js` 读写 **`~/.pi/agent/models.json`**（pi 自己的配置，Pi GUI 只代写，
不额外存一份）。`lib/models-api.js` 负责从供应商的 `/models` 拉列表。

- **拉取由后端代发**，不从浏览器直连 —— 后者会撞 CORS。
- **按 API 类型自动选对路径和鉴权头**：`openai-completions` /
  `anthropic-messages` / `google-generative-ai`。
- **失败时逐级回退路径段重试**，所以 base 填成厂商的兼容子路径
  （比如 `https://api.deepseek.com/anthropic`）也能找到真正的模型列表。
- **能带回多少取决于供应商的接口**：OpenRouter 和 Google 回得比较全；
  OpenAI / DeepSeek / Anthropic 的 `/models` 基本只有一个 id，那就只填 id。

模型列表每行一个，`id` 之后是显示名，再往后都是 `key=value` 参数
（`ctx` / `max` 是 `contextWindow` / `maxTokens` 的简写）：

```
deepseek-chat
qwen3-max|Qwen3 Max
anthropic/claude-sonnet-4|Claude Sonnet 4|contextWindow=200000|maxTokens=64000|reasoning=true|input=text,image
```

> 参数必须带 `=` —— 否则没法区分那到底是显示名还是一个开关。

**`!command` 形式的 API Key 不会被拉取功能执行** —— 那等于给一个网页界面开了
任意命令执行。这种 key 手填模型列表仍然可用。详见 [security.md](security.md)。

## 九、数据存储

| 位置 | 内容 | 谁写 |
|---|---|---|
| `<PI_GUI_DATA>/projects.json` | 项目列表与上次激活的项目 | Pi GUI |
| `<PI_GUI_DATA>/plans/` | Planner 计划与执行历史 | Pi GUI |
| `<PI_GUI_DATA>/trash-sessions/` | 被删除的会话文件（软删除） | Pi GUI |
| `<PI_GUI_DATA>/session-flags.json` | 归档列表 + 已删除记录 | Pi GUI |
| `<PI_GUI_DATA>/.uploads/` | 附件缓存 | Pi GUI |
| `<项目>/.pi-gui/config.json` | 项目偏好 | Pi GUI（跟着项目走） |
| `~/.pi/agent/models.json` | 模型供应商与 API Key | pi（Pi GUI 代写，不额外存） |
| `~/.pi/agent/sessions/<cwd 编码>/` | 会话 `.jsonl` | **pi** |
| `~/.pi/agent/skills/`、`<项目>/.pi/skills/` | Skills | 用户 |

`PI_GUI_DATA` 缺省是「代码/exe 所在目录」：开发时是项目根，单文件 exe 是便携模式，
Electron 版由主进程指到 `%APPDATA%\Pi GUI`（装在 Program Files 下时那里不可写）。

**这是唯一计算数据目录的地方**，其余模块一律由 `server.js` 注入 ——
打包形态（源码 / SEA / Electron）变化时只改这一处。

## 十、贯穿全局的设计原则

1. **依赖方向单向**：`server.js → 模块`，跨模块共享一律「工厂函数 + 依赖注入」
   （`createProjects({ restartPi })`）而不是 import，这样不会成环。
2. **单一权威**：`runtime` 里的 `currentCwd`、`assets.js` 里的资源解析、
   `server.js` 里的数据目录 —— 每个概念只有一个地方说了算。
3. **测试守卫要跟着目录结构走**。`tests/modules.cjs` 的依赖方向守卫与
   `tests/server-security.cjs` 的源码集合都必须是**递归**的：加了子目录之后
   只看顶层会让守卫整个漏出扫描范围却仍然全绿，那种假绿比没有守卫更危险。
4. **不可信输入一律当不可信**：模型输出、被执行的程序输出、Markdown、
   Agent 的 stdout、客户端传的一切。
5. **退化情况不许静默消失**：缺数据、未知类型、坏文件都要有明确归宿。
6. **不伪造能力**：pi 没有的（MCP、sub-agent、plan mode）就说没有，
   不发明一套看起来像的东西。
