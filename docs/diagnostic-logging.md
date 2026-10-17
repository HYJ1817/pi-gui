# 本地诊断日志

本文说明 UI-5 新增的本地日志系统。它和 [diagnostics.md](diagnostics.md) 是**互补关系**：

| 能力 | 回答的问题 | 实现 |
|---|---|---|
| 诊断 `/api/diagnostics` | **现在**是什么状态 | 只读状态快照，沿用 P23 的白名单 |
| 本地日志 | 故障**前后**发生了什么 | 结构化 JSONL 时间线 |
| 崩溃记录 | 进程为什么异常退出 | 独立 `crash` 文件，仍在本机 |
| 故障报告 ZIP | 用户怎样一次性把线索交给开发者 | 在浏览器本地生成，不上传 |

日志不是第二套诊断，不复制 Runtime/ Bridge 状态机，也不替代 SSE、审批或 Pi 协议。

## 1. 设计目标与不变量

1. **本机、私有、默认轻量。** 默认启用标准日志（INFO 及以上），只记录稳定事件代码与经过白名单筛选的元信息。
2. **故障可追溯。** 每条记录有 UTC 时间戳；每个进程实例有 `runId`；一次操作开始/成功/失败共享 `correlationId`；失败事件带稳定 `code` 与耗时。
3. **隐私优先于完整。** 不记录聊天正文、模型回复、工具输入/输出、文件内容、配置原文、环境变量、用户绝对路径、命令行、URL 查询参数、Cookie、凭据或外部程序原文。
4. **日志失败不能影响业务。** 磁盘满、目录不可写、文件损坏、队列溢出都只让日志系统进入 `degraded`，不抛到调用方。
5. **进程隔离。** Electron 主进程、后端各写各的文件；Renderer 不直接拿文件系统权限，事件经现有本地令牌认证 API 交给后端。
6. **可验证的导出。** ZIP 只含固定白名单文件，导出前重新审查内容；不附带聊天历史、项目文件、截图或整日志目录。

## 2. 模块与数据流

```
public/app.js / api.js / 各 UI 模块
        │  结构化事件（renderer 白名单）
        ▼
public/log-client.js ──POST /api/logs/events──┐
                                              │
electron/main.cjs                             │   server.js（后端）
  └─ electron/logging.cjs                     │     └─ server/logging.js
       ├─ main-YYYYMMDD.jsonl                 │          ├─ app-YYYYMMDD.jsonl
       ├─ main-crash-YYYYMMDD.jsonl           │          ├─ app-crash-YYYYMMDD.jsonl
       └─ 原生视图 / 窗口 / 子进程故障        │          ├─ Bridge / Runtime / 审批故障
                                              │          └─ GET/POST /api/logs/*
                                              │                    │
                                              └────────────────────┤
                                                                   ▼
                                                        public/logs.js（设置与查看器）
                                                        预览 → 本地 ZIP → 用户保存
```

### 2.1 共享核心

新增 Node 侧共享文件（零第三方依赖）：

- `lib/log-contract.cjs`：事件目录、字段白名单、级别、字符串/错误码/堆栈线索规范化。
- `lib/log-core.cjs`：JSONL 写入、轮转、保留期、容量、状态/读取/清理、ZIP 导出。
- `lib/zip.cjs`：受控 ZIP 写入器（`node:zlib`，固定文件清单）。

`log-contract` 的策略是**事件目录**，不是泛化日志 API：未知 `event` 或未声明的字段直接丢弃。调用方传入的消息、文本、URL、命令、路径、异常对象不会被序列化。

### 2.2 进程角色与文件

| 角色 | 写入者 | 文件 |
|---|---|---|
| `app` | 后端进程 | `app-YYYYMMDD.jsonl` / `app-YYYYMMDD-<n>.jsonl` |
| `app-crash` | 后端进程 | `app-crash-YYYYMMDD.jsonl` |
| `main` | Electron 主进程 | `main-YYYYMMDD.jsonl` / `main-YYYYMMDD-<n>.jsonl` |
| `main-crash` | Electron 主进程 | `main-crash-YYYYMMDD.jsonl` |
| Renderer | **不直接写文件** | 经 `/api/logs/events` 写入 `app-*`，并带 `process: "renderer"` |

不同进程不会未经协调地追加同一文件。Renderer 不获得目录枚举、文件读取或任意路径接口。

### 2.3 目录

优先顺序：

1. `PI_GUI_LOG_DIR`（自动化测试与显式部署隔离用）。
2. Electron：`<userData>/logs`；后端由 Electron 启动时通过 `PI_GUI_LOG_DIR` 指向同一目录。
3. 独立后端：`<PI_GUI_DATA>/logs`；未设置 `PI_GUI_DATA` 时落到系统应用数据目录下的 `pi-gui/logs`。

**从不**写入当前项目、Git 仓库或会话目录。切换项目/会话不会改变日志目录。

### 2.4 运行标识与关联

- 每次进程启动生成新的随机 `runId`。
- 每个关键操作由调用点生成 `correlationId`；开始、成功、失败、耗时共享它。
- `source` 是固定的来源枚举（`app`、`electron`、`pi-bridge`、`runtime`、`renderer`、`browser`、`ui`、`network`、`logs` 等）。
- 用户无需记住 ID；查看器只显示短后缀，复制单条摘要时才包含完整标识。

## 3. 记录格式

每行一个 UTF-8 JSON 对象，例如：

```json
{"v":1,"timestamp":"2026-10-17T12:00:00.000Z","level":"ERROR","source":"pi-bridge","event":"bridge.connection_lost","code":"BRIDGE_DISCONNECTED","runId":"…","correlationId":"…","durationMs":1200,"process":"backend"}
```

约束：

- `timestamp` 一律 UTC ISO 8601。
- `level`：`DEBUG` / `INFO` / `WARN` / `ERROR` / `FATAL`。
- `event`：稳定点号代码，不接受任意字符串。
- `code`：大写稳定错误码，最多 80 字符。
- `details`：只接受该事件声明过的字段；值只允许受控枚举、有限数字、布尔和经过 token 规则的短标识。
- 单行上限 2 KiB；超限截断字段而不是写入原始大对象。
- `events.jsonl` 事件按时间升序；查看器展示按时间降序。

### 3.1 标准 / 详细

- **标准**（默认）：`INFO`、`WARN`、`ERROR`、`FATAL`；只含事件目录的基础字段。
- **详细**：额外记录 `DEBUG` 事件与事件目录声明的附加技术元数据（枚举、计数、时长、相对模块名、安全堆栈帧）。
- 详细模式只在用户主动选择后开启，默认 **24 小时**后自动回标准；到期由后端在读取/写入时判定并持久化。
- 两种模式共用同一隐私边界；详细模式不记录新的原始内容类别。

### 3.2 运行实例与崩溃恢复

启动时写 `session-<role>.json`（`{runId, startedAt, clean:false}`）；正常关闭写 `clean:true`。下次启动若发现上一份标记不是 clean：

- 追加 `app.previous_unclean_exit` / `electron.previous_unclean_exit`（`WARN`）；
- 在状态里暴露“上次异常退出”的计数与时间，不暴露路径；
- 旧日志继续可按时间读取。

崩溃记录写入独立的 `*-crash-YYYYMMDD.jsonl`，包含 `FATAL` 级别、安全错误名/错误码、自身模块的安全堆栈帧；**不包含异常 message**，因为 message 可能夹带用户正文或凭据。

## 4. 持久化、轮转与容量

初始默认值（最终以测试与界面显示为准）：

| 项 | 默认 | 可调 |
|---|---:|---|
| 保留天数 | 7 天 | 1 / 3 / 7 / 14 / 30 |
| 日志目录总上限 | 20 MB | 10 / 20 / 50 MB |
| 单文件上限 | 4 MB | 固定 |
| 查看器每页 | 100 条 | 固定，最多 200 |
| 导出默认窗口 | 30 分钟 | 30 / 120 / 1440 分钟 |
| 导出事件上限 | 5000 条 / 5 MB | 固定，超出明确标记 `truncated` |
| 读取尾部上限 | 每次请求 4 MB | 固定 |

- 超过单文件上限时关闭当前文件，创建当日序号文件；只清理**白名单文件名**、非符号链接、位于日志目录内的普通文件。
- 保留期按文件名日期与 mtime 双重判定；总容量按 `lstat` 结果从最旧文件开始删除。
- 日志关闭时不写新记录；现有文件仍可在查看器中读取/导出/清理。清理为显式用户动作，保留设置文件。
- 写入采用有界队列与批量 append；磁盘错误后标记 `degraded`、记录安全的错误码，并暂时停止重试，绝不让业务路径抛错。
- 退出前尽量 flush；崩溃路径使用同步追加一小条，保证下次启动仍能看到线索。
- 日志读取从文件尾部按块读取，有总字节预算，不把整个目录或数十 MB 文件一次载入 DOM。

## 5. 安全边界

### 5.1 永远不进入日志

- API Key、OAuth token、Cookie、Authorization header、`PI_GUI_TOKEN`；
- 用户聊天正文、模型回复正文、工具原始输入/输出、附件/文件正文；
- Provider 配置原文、环境变量及其值；
- 项目绝对路径、HOME、用户目录、用户文件名；
- Browser 页面正文、Cookie、URL 中的敏感查询参数；
- Git diff 原文、完整命令及参数、外部程序 stdout/stderr；
- 异常 message / 原始 stack（只保留经过白名单识别的自身模块相对文件和行列）。

### 5.2 三道防线

1. **默认不收集**：事件目录和字段白名单从结构上拒绝任意文本。
2. **规范化**：所有允许的短字符串经过已知路径/凭据形态替换；错误码只接受 token 字符；堆栈只识别 `lib/`、`server/`、`public/`、`electron/` 下的相对模块。
3. **导出前复核**：ZIP 中每个文件生成后再次扫描/规范化；发现无法归类的异常就中止导出并给出错误码，而不是“应该没问题”。

凭据/路径替换沿用并扩展 `lib/redact.js` 的思路；不声称穷尽，因此不把原始内容作为输入。

### 5.3 查看与导出的身份

- 所有 `/api/logs/*` 走现有 `auth.denyRequest`（Origin + `PI_GUI_TOKEN`）。
- 不新增文件路径参数；读取/清理只在后端固定日志目录、固定文件名模式内进行。
- 清理/修改设置为 POST；导出要求 `confirm:true`。
- 导出不发起任何网络请求、不创建 Issue、不上传。ZIP 由浏览器保存。
- 符号链接、路径遍历、非白名单文件名不进入读取或 ZIP；导出文件名由服务端固定生成。
- Renderer 事件入口限制 body 大小、批量条数、事件目录和速率；不接受任意 `source`、`level`、`runId` 或文件操作。

## 6. 故障报告 ZIP

用户路径：设置 → 诊断 →「日志与故障报告」→ 填写问题描述/复现步骤（可选）→ 预览 → 确认导出。

```
pi-gui-bugreport-<UTC 时间>.zip
├── README.txt       报告内容、检查提醒、明确的隐私说明
├── report.md        版本 / 构建信息（可得时）/ OS / Electron / Node / Pi / 时间范围 / 用户描述 / 复现步骤 / 错误摘要
├── diagnostics.json 直接复用现有 /api/diagnostics 快照（不再扩字段）
├── events.jsonl     所选时间窗口内的结构化事件（升序，脱敏）
└── errors.jsonl     ERROR/FATAL 与崩溃线索（脱敏）
```

- 默认窗口最近 30 分钟；可选 2 小时或 24 小时；受 5000 条/5 MB 上限约束。
- `report.md` 中的问题描述和复现步骤只来自用户填写，导出前会做已知凭据/路径替换并限长；界面明确提醒发送前自查。
- `diagnostics.json` 不额外加入 PID、绝对路径、环境变量或配置内容。
- 导出失败（目录不可写、ZIP 构建失败等）返回固定错误码；查看器提供“复制安全摘要”作为降级。
- 不打包整个日志目录；不打包用户文件、截图或聊天历史。

## 7. 插桩清单

只观察现有路径，不改变协议判定。

### Electron 主进程

- 启动/退出、后端启动失败、后端异常退出、窗口创建失败；
- Renderer `render-process-gone` / `unresponsive`、页面 `did-fail-load`；
- Native Browser View 创建/挂载/撤离/导航失败（原有固定错误码）；
- 未捕获异常、Promise rejection（只记安全名称/帧）；
- 主进程日志自身的降级/清理/导出失败。

### Pi Bridge

- 启动、就绪、退出、重启、维护暂停/恢复；
- 连接中断、协议解析错误、输出超限；
- RPC 请求超时、命令失败（只限已知操作与固定 code）；
- 模型切换失败、Thinking 设置失败；
- Stop/Abort 的 sent / failed / unknown 与耗时（不记录正文）。

### Runtime

- Runtime 创建/恢复/启动失败、owner stale / revision / sequence 拒绝原因；
- 会话启动/切换失败；
- Runtime Browser / Processes 状态错误；
- 审批应答明确失败或结果未知（复用现有投递结果）。

### 常用 UI（Renderer）

- 未捕获异常、未处理 rejection、动态模块加载失败；
- 必需 DOM 节点缺失；
- 附件解析失败；
- 模型/Provider 能力未知（去重，不按帧记录）；
- 请求失败或服务不可用、SSE 断线/恢复。

### 明确不记录

逐 token 流式输出、鼠标移动、滚动帧、每次渲染、完整 console、原始 `pi` stdout、完整错误对象。

## 8. 验收测试

新增独立套件（并接入 canonical `npm test`）：

- `tests/logging.cjs`：事件目录/级别/字段白名单、时间线、关联 ID、并发写入、轮转、容量/保留期、损坏文件、不可写目录、崩溃重启、分页、ZIP 清单与解压、导出失败、导出不上传、日志关闭、恶意 HTML、长中文。
- `tests/logging-leaks.cjs`：向隔离环境注入 `sk-…`、Bearer、API Key、OAuth token、Cookie、用户目录、项目路径、模拟聊天正文/工具输出/Browser URL、环境变量凭据、异常 message/stack；逐一检查普通日志、详细日志、最近错误列表、ZIP 每个文件、Renderer 可访问数据和诊断快照。
- `tests/logging-ui.cjs`：空/错误/加载状态、筛选、分页、复制单条、详细模式、清理确认、导出预览/确认/失败降级、恶意 HTML 与长中文。
- `tests/logging-packaged.cjs`：对隔离离线构建产物启动真实打包后端，验证日志落盘、读取、清理和 ZIP 导出；不能只在开发服务器上跑通。

最终回归还包含既有 diagnostics/security、UI-1～UI-4 关键套件、审批/Stop、Runtime owner、Browser 安全、P33 安全测试、完整 `npm test`、真实 Electron、CDP 视觉矩阵、离线构建与 app-check / exe-check。

## 9. 借鉴 OpenMinis 的部分与差异

研究了 OpenMinis 真实的 Android `AppLogger`、`LogManagementScreen`、`CrashFileReporter`、`ExitInfoCollector`、`OAuthLogRedaction` 及日志保留/级别测试，并参考了 iOS `LoggingManager`。

借鉴：

- 日志按日期保存、应用内查看、级别切换、清理/分享；
- 崩溃文件与普通日志分开，启动后仍能看到上次故障；
- 有界轮转、保留期清理、详细模式；
- OAuth 敏感参数在进入日志前替换；
- 日志列表/查看器的空状态与错误状态；
- 保留期与容量的测试思路。

不照搬：

- 不捕获完整 stdout/stderr/logcat，不写原始系统日志；这会把聊天、工具输出和第三方输出带入日志。
- 不用 15 天 / 100 MB 的数值；pi-GUI 是桌面应用，默认 7 天 / 20 MB / 单文件 4 MB。
- Android ACRA/tombstone/ExitInfo 不适用于 Electron；改为主进程 `child-process-gone` / `render-process-gone`、后端异常监控和进程会话标记。
- JSONL 结构事件而非纯文本，便于稳定筛选与导出；不存原始 URL token 前缀（连前缀也不留）。
- 导出不是分享整个日志文件，而是固定清单、时间窗口、脱敏与预览确认的 ZIP。
- Renderer 不通过任意读文件接口获得日志；只通过认证 API 读取结构化、白名单化后的记录。

## 10. 已知边界

- 日志无法覆盖“进程在第一行写入前被立即杀死”的时刻；这类情况只能通过 OS 崩溃/退出信息与下次启动的未清理标记间接体现。
- 标准/详细模式都不是“可安全公开”的承诺；导出前仍需用户复核填写内容。系统只保证默认不收集聊天/凭据/路径类别。
- 真实 OS 级磁盘耗尽、权限拒绝与 symlink 行为需实际测试；无法在 CI 环境复现的项会标记为未验证，不冒充通过。
- 日志查看器的读取预算意味着极长历史可能只看到最近窗口；界面会显示“已截断/仅显示最近 N 条”。
