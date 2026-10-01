# 架构

## P16 Web adapter

`public/web-activity.js` 在现有 ToolEntry → tool-view 边界做纯语义投影，
实时与历史共用，实例 identity/并发/取消仍由现有 Timeline 管理。
`web-capabilities.js` 独立维护 generation/bridge run 范围的实际调用证据，
`web-access.js` 将事件观察、只读 discovery 与 Extensions 设置区连接。
不修改通用 Registry，不发搜索请求，不接触供应商 credential。
Electron 的 `openWebUrl` 是独立 http/https IPC；Release 外链白名单不变。
参见 [Web Access 数据流与限制](web-access.md)。

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
- `server/` — 各职责模块。全部由 `server.js` 装配，**业务模块之间不互相 import**
  （依赖方向永远是 `server.js → 模块`）。可以被 import 的只有**叶子原语**：
  `http-utils.js`、`lib/`，以及同目录的 `pi-launch.js`；`tests/modules.cjs` 把这条
  边界钉死（含 `rpc-bridge.js` 的白名单）：
  - `auth.js` — 访问控制（令牌 + Origin）与身份探测端点。令牌定长比较，
    错误信息不回显收到的值
  - `pi-launch.js` — **launch identity**：`PI_BIN` / PATH 解析出入口、向上绑包、
    `formatLaunch()` 成形启动命令。`rpc-bridge` 的 spawn、`pi --version` 探测、
    built-in / MCP / approval 能力探测**共用这一处**，所以「启动的那份 pi」和
    「探测读的那份 pi」不可能分叉（P20.5 Blocker A）。纯 fs，不执行 shell。
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
   - `mcp.js` — MCP **能力报告**（不是 MCP 管理器）。去读**与 launch identity
     绑定的**那份 pi 包、给出「支不支持」的结论与原文证据，并列出官方替代路径
     extension 下已有哪些东西。**只读名字，不读内容、不执行**。
     原生摘要只读 `mcp-native` 的缓存视图（同步、不 spawn）
   - `mcp-native.js` — P20.6 **原生 MCP 状态与受控动作**。状态真相只有两条官方路：
     `pi mcp list --json`（显式刷新才跑，60s 缓存，不轮询）与两处 `mcp.json`
     的安全结构解析（secret 值不进报告）；动作只代理官方 CLI
     （add / remove / login / logout，`shell:false` + args 数组 + stale 守卫）。
     入口从 launch identity 派生，证明不了就不代执行。
     **派生结论（runtime 状态 / `replaced`）的缓存按 `(cwd, launch identity)`
     复合键存** —— 换项目或换 pi 实例后立即失效，不会把上一个 workspace 的
     结论带过去；`project` scope 的写操作另有 project trust 闸门（fail closed）；
     add 接口在 HTTP 边界拒收一切凭据值。见 [mcp.md](mcp.md)
  - `extension-registry.js` — 只读发现 Pi 的本地与 npm Extension 候选项；用
    `get_commands.sourceInfo.path` 关联可验证命令。已注册工具列表当前不在 Pi RPC 中，
    所以 capability registry 不猜工具归属。Pi 重启和项目切换清掉上一轮错误证据。
    共享 `lib/extension-paths.js` 解析目录入口、package manifest glob 与资源 filter，
    不执行候选代码，也不调用 Pi package resolver。
  - `sessions.js` — 会话列表 / 切换 / 改名 / 归档 / 删除。见 [sessions.md](sessions.md)
  - `update-check.js` — **版本检查**：只读公开 GitHub Release 元数据，判断有没有新版。
    自带 SemVer 纯函数、30 分钟内存缓存、single-flight 与错误分类；
    **不下载、不安装、不发 telemetry、请求不带任何凭据**，
    响应里的外链先过一遍白名单。见 [updates.md](updates.md)
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
    - `scheduler.js` — 只负责执行已确认的计划：依赖推进、串行、失败暂停、取消、重试；
      每次尝试记下关联会话与执行期间变化的文件（P7，见 [workflows.md](workflows.md)）
    - `index.js` — HTTP 路由 + 计划生成（用 pi 适配器 + 独立会话，不污染主聊天）；
      另含「从任务打开会话」与「会话 → 任务」反查两条 P7 接口
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
- `lib/session-id.js` — 会话 id 的**唯一**校验处（字符集抄自 pi 的
  `assertValidSessionId`）。planner 拼 id 与 sessions 收前端输入都用它 ——
  同一约束两个消费者，各写一份迟早会漂
- `lib/models-api.js` — 从供应商 `/models` 拉模型列表（路径回退、按 API 类型适配）
- `lib/extract.js` — docx / pdf / 图片的文本抽取（pdfjs）

### 前端

`public/` — 原生 ES Module，`app.js` 只做装配，其余按职责分模块：

- `api.js` 网络 / `state.js` 状态 / `shell.js` 外壳 / `util.js` 工具
- `markdown.js` Markdown 渲染（安全设计见 [security.md](security.md)）
- `messages.js` 对话流 / `composer.js` 输入框 / `attachments.js` 附件
- `tools.js` + `tool-model.js` + `tool-view.js` + `tool-history.js` 工具时间线
- 语义适配器（按工具名匹配，互不依赖包名）：`web-activity.js` / `subagent-activity.js` /
  `memory-activity.js` / `browser-activity.js` / `mcp-activity.js`（`mcp__` 与资源工具，
  只投影 server / tool / 状态）；各自的 `*-capabilities.js` 管状态证据与运行观察
- `git.js` 变更面板 / `diff.js` unified diff 渲染 / `changes.js` 会话改动账本
- `sessions.js` 侧栏会话列表 / `conversation-nav.js` 会话内提问导航 /
  `tree.js` 分支树 / `session-plans.js` 会话标题旁的「关联任务」窄条（P7）
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
6. **不伪造能力**：能力以当前运行 Pi 的真实 probe、协议证据或真实 runtime event
   为准；拿不到证据就保持 unknown，不根据历史版本、包名或工具名猜测。
   例如当前 Pi 已原生支持 MCP，但 sub-agent / plan mode 是否原生存在仍应按
   当前版本事实判断。不发明一套看起来像的东西。

## P17 Subagent adapter

subagent-activity.js 仅投影白名单，subagent-capabilities.js 管 workspace/run 观察与 stale guard，subagents.js 提供手动设置。Timeline 保存 partial details，实时和历史复用 tool-view；completion 复用 Git 防抖。Planner / execution_event、Registry 与后端不改。见 [subagents.md](subagents.md)。

## P18 Memory adapter

`public/memory-activity.js` 把 **pi-memory 0.4.2** 的 7 个真实工具
（memory_write / memory_read / memory_search / memory_forget / memory_restore /
memory_status / scratchpad）投影成白名单事实：只给操作、query、数量、scope 与
allowlist 元数据，`path` / `recoveryPath` / `dir` / 预览与记忆正文一律不投影。
`memory-capabilities.js` 独立维护 installed / configured / loaded 三值与
generation+bridgeRun 范围内的真实调用观察，`memory.js` 连接 SSE 观察与
Extensions 设置区，`tool-view.js` 把语义结果接到既有 Timeline（实时与历史同一投影，
identity 仍是 toolCallId）。后端、通用 Registry、会话搜索与 Planner 均不参与。
Memory 工具不是写文件的工具：不进 Changes 账本、不触发 Git 刷新。
见 [memory.md](memory.md)。

## P19 Approval adapter

`public/approval-model.js` 把 Pi 的扩展对话框（`extension_ui_request` 的
`select`/`confirm`/`input`/`editor`）规范化成只含真实字段的请求对象；
`public/approval.js` 是它的存储、生命周期与 UI：按 `requestId`（=Pi 给的 `id`）
去重防重放，按 workspaceGeneration / bridgeRun 做陈旧守卫，桥接重启与 Stop
分别「本地作废」与「fail-closed 取消 + 收卡」，决定经 `extension_ui_response`
走明确协议命令。`confirm` 类请求复用 `ui/modal.js` 的 `confirmModal`
（与撤销文件、删除会话同一层），因此不再存在两套并行确认 UI ——
`app.js` 里原先自绘的三种对话框已删除，只留 fire-and-forget 方法。
`server/approval-probe.js` 只读本机 pi 包，报告 `tool_call` 阻断、
对话框子协议、核心无内置审批、RPC 下 `custom()` 退化这四件事（三值 + 出处）。
后端不下发任何策略，也不实现权限系统。见 [approvals.md](approvals.md)。

## P20 Browser adapter

`public/browser-activity.js` 把 **pi-browser-harness 0.11.0** 的 40 个 `browser_*` 工具
投影成白名单事实。它是纯函数（无 DOM、无 IO、无包名依赖），实时与历史复用同一条路径，
identity 仍是 `toolCallId`。

成功证据只有一条：`details.ok === true`（该 Extension 的 `registerBrowserTool` 统一加上），
失败走闭集 `details.kind`。拿不到 `ok:true` 就说「结果不可用」，**不拿请求参数顶成成功**；
不解析 result 正文（正文里就是页面内容）。

投影纪律比前几轮更严：输入内容（`fill.value` / `type.text` / `fill_form` 的字段值 /
`press_key` 的单字符 / `handle_dialog.promptText`）**默认完全不显示**；
页面正文、页面标题、控制台与网络记录、`execute_js` 的求值结果、
本机绝对路径（截图 / PDF / 上传 / 下载）与 `http_get` 的请求头**一律不投影**。
`browserHost()` / `safeBrowserUrl()` 做两级 URL 过滤，后者**再拒掉带 query/fragment 的地址**
（令牌通常挂在 query 上）。截图只显示「Captured page screenshot」+ 格式 ——
0.11.0 把图片存到文件，result 里没有 image block，GUI 不去读那个文件。

`browser-capabilities.js` 独立维护 installed / configured / loaded 三值与
generation+bridgeRun 范围内的真实调用观察（只记「观察到几个 / 最近哪几个」，不逐工具列），
`browser.js` 连接 SSE 观察与 Extensions 设置区，`tool-view.js` 的语义链加一项
（并把「结构化来源」的渲染从 Web 专用改成通用）。通用 Registry、Web adapter、
Memory / Subagent adapter 与 Planner 均不改。见 [browser.md](browser.md)。

> **没有审批流。** pi-browser-harness 没有 `pi.on("tool_call")` 拦截，也没有
> `ctx.ui.confirm`，所以按 [approvals.md](approvals.md) 的规矩，
> GUI 不为浏览器动作提供任何允许 / 拒绝按钮，也不画假 modal。

## P20.5 Pi 版本真值与 built-in 能力探测

这一层不引入任何新 UI 面，只把两个之前**隐式**的事实变成有出处的状态。

### launch identity：`server/pi-launch.js`

**「现在启动主聊天 Pi，实际会执行哪个入口、那个入口属于哪个包」——整个后端只有
一个答案**，在 `server.js` 里建一次，注入给所有要问它的模块。

- `identity()` → `{ bin, source, entryKnown, packageDir, packageDirKnown }`。
  `source: 'env'`（`PI_BIN` 是明确路径）/ `'path'`（裸命令，按 PATH + PATHEXT 解析，
  Windows 先看 cwd —— 镜像 cmd 的规则）。**纯文件系统 stat，不为找包执行任何 shell**。
- **`packageDir` 只在能证明时才非 null**：从实际入口文件（含 `realpath`）向上找
  `node_modules/@earendil-works/pi-coding-agent`，且那份 `package.json` 的 `name`
  必须就是它。找不到就 null。
- `formatLaunch(bin, args, isWin)` → `{ command, spawnArgs, shell }`，
  **`rpc-bridge` 的 spawn 与 `--version` 探测共用这一个函数**（POSIX 走数组、永不拼串；
  Windows 沿用桥接一直的做法自己拼命令串以绕开 DEP0190）。`launcher()` 就是它的
  `--version` 形态，直接交给 `createPiVersionProbe({ launcher })`。
- `summary()` → `{ source, binName, entryKnown, packageDirKnown }` ——
  **只有枚举与 basename**，renderer / Diagnostics 只拿这个。

**为什么必须收成一处**：旧实现有两条互不相干的路径 —— `rpc-bridge` 用
`PI_BIN || 'pi'`（看 PATH），而版本 / built-in / MCP 探测用「agent registry 的 npm 扫描
+ 常见全局安装位置清单」（**不看 PATH**）。机器上装着两份 pi 时，RPC 起的是 A、
探测读的是 B，于是「运行中 Pi 的版本」报的是别的安装。这就是 P20.5 的 Blocker A。

消费方：`rpc-bridge`（`launch` 参数）· `pi-version`（`packageDir` + `launcher`）·
`pi-builtins`（`packageDir`）· `mcp` / `approval-probe`（`resolvePackageDir`）·
`diagnostics`（`summary`）。

`server/pi-version.js` —— **运行中版本**的规范状态 `{ value, source, status, updatedAt }`：

- 取值顺序：**与 launch identity 绑定的那个** pi 包的 `package.json`（纯文件读，
  首选；证明不了就回 null，此时才轮到下一步）→ 受控的 `pi --version`
  （与 bridge **同一个 launch spec**，只多一个 `--version`）
  → 都拿不到就是 `unknown`。
- **绝不退回「常见全局安装位置」清单** —— 那是身份分叉的来源。
- `status` 三态：`known` / `malformed`（读到了但不是版本号）/ `unknown`。
  畸形**不退回**兜底探测 —— 那本身是有信息的结果。
- 带 TTL 缓存；`read()` 才求值，所以启动路径不付代价。

`server/pi-builtins.js` —— **built-in 扩展与相关能力**的只读探测：

- 解析 pi 包 `dist/extensions/index.js` 的 `builtInExtensions` 字面量
  （`parseBuiltInExtensions()` 是纯函数，用两个真实版本的原文当 fixture）。
- 读 `dist/core/extensions/types.d.ts` 找 `registerMcpServer` / `getMcpServers` /
  `getAllTools`；读 `dist/modes/rpc/rpc-types.d.ts` 拿 RPC 命令名集合
  （用来证明**没有**工具清单命令）。
- MCP 配置文件**只 stat 不读内容**；缓存按 **cwd** 分键，切项目不会返回上一个项目的结论。
- **不 import pi 的任何模块、不 spawn、不 require** —— 只有几个限长的 `readFileSync`。

两者的结论都汇进 `server/mcp.js` 的 `/api/mcp` 报告（`version` / `builtins` /
`extensionApi` / `rpc` / `mcpConfig` / `mcpCli`），前端在 Extensions 页的 MCP 标签页渲染。
`server/pi-compat.js` 的报告多一个 `versionSource`（版本值的出处），
让 Diagnostics 能区分「文档里的基线」与「你机器上跑的那个」。

**Registry 继续 generic**：built-ins 编译在 pi 包里，不是用户装的 extension，
所以既不进 Registry 的目录扫描，也不在 Registry 里特化 `builtin:mcp`。
见 [pi-compatibility.md](pi-compatibility.md) §〇 与 [extensions.md](extensions.md#mcp)。

## P20.6 Native MCP 集成

用 pi 原生的 MCP，不自建 client runtime（`server/mcp-native.js` + MCP 标签页
管理面 + `mcp-activity.js` 语义行，见 [mcp.md](mcp.md)）：

- 状态真相只有两条官方路 —— `pi mcp list --json`（显式刷新才跑，会启动用户的
  stdio servers，所以 60s 缓存、不轮询）与两处 `mcp.json` 的安全结构解析；
  人类文本与 TUI 不解析，RPC 里没有 MCP 接口（33 条，0.99.1 / 0.99.2 各确认一次）
- 跑的入口从 launch identity 派生（`packageDir` + 包内真 js +
  `process.execPath`，经 `agents/cli.js` 的 `runCli`），证明不了就不代执行
- 动作只代理官方 CLI（add / remove / login / logout）；enable / disable /
  reconnect / 改 exposure 没有 shell 接口，不伪造开关
- OAuth 全程 pi 负责；in-session 的 select / input 经 P19 管道自动承接
- `mcp__` 调用走 Tool Timeline 语义行（只投影 server / tool / 状态）；
  annotations 未经 RPC 暴露，不猜；`ui://` 与 MCP Apps 不渲染

### P20.6-Fix 的四条收口

| 面 | 做法 |
|---|---|
| **缓存跨 workspace 串状态** | runtime 状态与 `replaced` probe 的缓存改成 **keyed cache**：`key = canon(cwd) + launchIdentityKey`。读写前算一次 key，不符即当没有缓存；`peekStatus` / `peekSummary` 同样带 workspace 守卫。TTL 仍在，仍无轮询，`reset()` 一次清空三者 |
| **project trust 边界** | 上游 `pi mcp add/remove -l` 不查 trust → GUI 自己立闸：`scope=project` 的写操作只有 `trusted === true` 才执行，`false` / `null` / 抛异常一律 fail closed。项目 `.pi/settings.json` 也只在 `trusted === true` 时参与 `builtin:mcp` 判定。trust 真值仍只有注入的 `readTrust` 一处 |
| **secret contract** | add 接口只收「无 secret value」的配置：`headers[].value` / `env[].value` / `oauth` / `auth` / 常见 token 字段在 HTTP 边界拒绝，不调 `runCli`、不回显值。唯一保留的引用字段是 `bearerTokenEnvVar`（只传变量名） |
| **runtime parser** | `state` / `scope` / `exposure` / `tools` / `toolExposure` / `resources` 全部 allowlist；闭集外折成 `unknown` / `null`；`source` / `command` / `url` / `headers` / `env` 与未知字段一律不取 |

### P20.6-Fix-2 的两条事实修正

| 面 | 做法 |
|---|---|
| **覆盖关系受 trust 约束** | `readConfigs()` **只产出文件事实**（有哪些 server / scope / 配置结构），不再在那里决定 `overridden` —— 那时还不知道 trust。`summary()` 拿到 `tr` 后才用 `projectTrusted(tr)` 算出 `loadableProjectNames`，用户级条目的 `overridden` 由它决定。未信任 / 未知时该集合为空 ⇒ 不可能出现「用户级被一个不会被加载的项目项覆盖掉、两条都不生效」。判定用 `parseMcpServers` 认可的 `projectServers`（= Pi 会接受并加载的条目），不用原始 JSON key 是否存在 |
| **两层命名不共用规则** | **A. CLI raw MCP tool name**（`list --json` 的 `tools[]`，server 原始名字）走 `sanitizeMcpRawToolName()`：只做安全文本边界（去控制字符 / 单行化 / trim / 限长截断），**没有字符集白名单**。**B. 注册后的 Pi tool identifier**（`mcp__<server>__<tool>`）仍由 `public/mcp-activity.js` 的 `MCP_TOOL_RE` 解析。`toolCount` 是上游合法字符串项的数量，**不因字符集或展示边界缩水** |

### P20.6-Fix-3：把「Pi 会加载的条目」变成真的

Fix-2 让覆盖依赖「Pi 会接受并加载的 project entry」，但当时的 `parseMcpServers()`
只做结构解析 —— 上游会拒绝、GUI 认为合法的条目（如 `args: [123]`）仍会被算进
覆盖集合，于是同一个覆盖 bug 以更隐蔽的形式复活。

| 面 | 做法 |
|---|---|
| **配置校验** | `parseMcpServers()` **逐条复刻** `validateMcpServerConfig()`（`src/core/mcp-servers.ts`）：名字 / `exposure` / `toolExposure`（非法**整条拒**）/ `enabled` / `description` / `timeout` / `type`（含 `sse` 拒绝）/ `url`（可解析 + http(s)）/ `headers`（string→string）/ `oauth`（`validateOAuth` 全字段）/ `auth`（`{provider}` + https 或 loopback）/ `args`（string[]）/ `env`（string→string）/ `cwd`（string）/ 两条分支的优先级。另复刻 `readConfigFile()` 的 **namespace 冲突**（`mcpNamespace` 相等且名字不同 → 后者被拒，判据跨文件累积）与 **`auth` 不得出现在项目文件** |
| **覆盖集合** | 仍是 `parseMcpServers` 认可的 `projectServers` —— 但现在它真的等于「Pi 会加载的条目」。`readConfigs()` 按上游顺序（先 global 后 project）传 `takenNames`，namespace 冲突判据与上游一致 |
| **server 名长度** | 配置解析用上游规则（**不限长度**）；GUI 只在 `add` / `remove` **动作入参**上加 64 字符上限（输入侧防御，不影响配置判定） |
