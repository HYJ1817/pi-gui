# P31 Managed Dev Process

基线：P30 已合并的 main `bc051b0553a7bb7f39833a1b0747dd9075fe6370`。独立分支 `codex/p31-managed-dev-process`。不修改 Pi RPC 或用户全局 Pi 安装，不新增依赖。

## 只读勘察与实现计划

| 现有机制 | 采用的边界 | 本次调整 |
| --- | --- | --- |
| P29 用官方 `--extension` / `registerTool` 注入内置 Browser 工具 | 继续使用官方 Extension API；本机包源码表明 `getAllTools` 在绑定后可用 | Process 独立命名空间，session_start 后先检查冲突，整组跳过冲突注册 |
| RPC bridge 有 bridgeRun、launchGeneration、Stop authority barrier | 不改协议，注入 launch adapter | Stop 先取消进程动作；重启、维护、退出撤销凭据和清理 |
| runtime 是 cwd 权威 | 不信 Renderer 的工作区身份 | 增加单调 workspace generation；A→B→A 也不同 |
| agents/cli.js killTree 用 taskkill /T 或 POSIX group signal | 保留旧工具行为 | 新功能使用存活 guardian + 私有管道 + Windows Job 句柄；不对记忆中的 PID 发信号 |
| P30 已有按需 right-pane 和命令面板 | 不加一级导航 | 更多→开发进程 / 命令面板→开发进程 |
| P29 Agent Browser 独立权限、localhost-only | 完全保留 Browser 策略 | Process 默认关闭；开启服务不会开启 Browser 或授予远程网页权限 |
| Electron 启动私有 backend，退出会收 backend | 不向 preload 暴露 spawn/env | backend 清理 + guardian stdin EOF / Job close 清理 |
| SEA/Electron 分别嵌入或复制静态资源 | 零运行时下载 | 内置 Extension 和两个 guardian 随包；SEA 私有临时目录独占写入 |

执行顺序：所有权/日志 fixture 回归 → 平台 guardian 和真实树清理 → 私有工具桥/RPC 生命周期 → 按需右栏/安全 Activity → 离线全量与真实 Vite/Python/Electron → 重建产物与独立审查。

## 所有权与生命周期

manager 的 owner 是后端权威 cwd、单调 workspace generation、bridgeRun、session generation。公开 generation 是随机 UUID；进程 ID 是另一个随机 UUID。每次启动有私有 spawn identity，绑定到实际 ChildProcess、私有 stdin 管道及其 guardian。restart 保留受控 spec/ID，revision 单调增加并更换 spawn identity。stop/log/status/restart 的 ID 操作必须同时匹配当前 generation、ID、revision。PID 不作为公开标识或终止凭据。

工作区、Pi 重启/维护、会话切换会清理旧进程并关闭 Process 权限。Chat Stop 取消在途动作、清理尚未 ready 的启动/重启动作；已 ready/running 的服务留待显式 stop。Stop barrier 挂起期间拒绝新进程动作。应用正常退出等待清理；backend 突然退出关闭 guardian 管道。Windows Job 的 KILL_ON_JOB_CLOSE 覆盖 guardian 突然退出。

状态：start→starting；无 ready 策略在真实启动确认后→running；有策略检测成功→ready；显式 stop→stopping→exited；非零 child exit / spawn failure / ready timeout→stopping→failed。整树停止不能确认时保留 failed/stop_unconfirmed，不谎报成功。主进程退出后也清理仍存活的后代。

## 工具和安全边界

`gui_process_start/status/logs/stop/restart`。start 结构化 command、args、cwd、env、ready。status 可 list，也可带 id/revision/waitReady；logs 使用 cursor/limit。start 返回 ID/revision/initial state；status(waitReady) 提供闭环等待。重复 active spec 去重；重复 stop 幂等；restart 仅复用原 spec，旧 revision 拒绝。

cwd realpath 后必须在当前 workspace 内；外部 symlink/junction 不可穿越。Windows npm.cmd 被解析为 node.exe + npm-cli.js + 参数，不执行拼接 shell；其他 .cmd/.bat 和 shell launcher 拒绝。仅继承 PATH、系统目录、临时目录、用户目录和 locale 等启动必需环境；显式 override 限定 9 个开发键、每次最多 8 个，不复制 GUI/Browser/Process/Auth 凭据。

ready 至少提供 TCP 和 HTTP（仅字面量 127.0.0.1 / ::1，不用远程 DNS、不跟随重定向）以及完整日志 marker。所有策略有 timeout。端口预检查拒绝已占用端口；GUI/Process bridge 端口拒绝作为目标。不用固定 sleep 判定 ready。

日志 UTF-8 增量解码，完整行处理；超过 8192 字节整行省略。每进程 256 行 / 64 KiB ring，游标单调，返回 truncated。Authorization、Cookie、常见 secret 键赋值整行脱敏；常见 token/JWT 和 URL 凭据/query 脱敏。脱敏发生在持久于内存前。Timeline 和 SSE 只显示固定标签/状态，不投射原 env、命令参数或日志。没有磁盘日志或 spec 持久化。

私有 HTTP bridge 使用每次 Pi run 的随机令牌、loopback 动态端口、Origin 拒绝、请求体限额、并发限额、请求 ID 去重、读取 body 后二次凭据校验。Renderer 正常认证 API 只可 permission/list/log/stop/restart，不能任意 start。Browser 与 Process 的令牌、权限、generation 均独立。

## 平台差异

Windows guardian 使用 PowerShell/.NET 的内置 API：CreateProcess suspended → AssignProcessToJobObject → ResumeThread；STARTUPINFOEX 仅继承日志/NUL 句柄，子进程不能持有 guardian 控制管道。Stop 通过仍持有的 Job 句柄 TerminateJobObject，并检查 active process accounting。没有 PID fallback。PowerShell/native API 不可用时失败关闭。

POSIX guardian 自身是 session/group leader，子进程不 detached；私有管道 EOF 后由仍存活的 group leader 向自己的进程组发 SIGKILL。此实现针对普通 dev 服务进程树；主动 setsid/daemonize 的后代不属于首版支持范围。没有容器、远程进程、服务管理器或持久会话恢复。

真实运行结果和已知限制见最终验收报告；平台不可运行时明确标注，不用注入测试冒充真机。
