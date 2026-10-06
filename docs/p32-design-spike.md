# P32.1 Design Spike：勘察与验收报告

日期：2026-10-06。状态：**设计待验收，未进入 P32.2**。

- before HEAD：`30ffad882748264866a9c23c663eae302e975f9e`。
- 分支：`codex/p32-worktree-multisession`，从 fetch 后相同的 origin/main 建立。
- 基线版本：0.22.0，HEAD 对应本地 tag v0.22.0。
- after HEAD：见本阶段交付回复及 `git log -1`；不在本提交内写自引用 commit hash。
- 改动：仅本报告与 [ADR 0032](adr/0032-worktree-multisession.md)，无产品/测试/构建配置修改。

## 勘察结论先于实施

现有抽象足以复用：rpc bridge factory 与 pending/Stop/ready 状态机，runtime 权威目录，sessions 的 ID→文件/header.cwd 校验，纯 Timeline 模型，Browser 的 controller/CDP/策略分层，以及 Process 的 manager/guardian/脱敏有界日志。组合根继续通过依赖注入组织，前端继续原生 ES Modules，后端继续 Node HTTP。

需要偏离“直接加 Session Pool”的设想：官方单 child 的 switch_session 会 abort/dispose 当前 Session，无法保留 A 同时执行 B；当前 global currentCwd / S / Browser view / Process owner 切换策略也不能直接复用为 focus。推荐独立 Pi child/bridge，有界 registry 只管理资源，不共享正在工作的 runtime。每条执行线固定 workspace，focus 不影响生命周期。详见 ADR 方案对比。

## 只读检查记录

| 要求范围 | 已检查的代码/文档 | 核实结果 |
| --- | --- | --- |
| 约定与历史 | AGENTS.md、开发机 memory、README；architecture/security/testing/development、sessions/runtime-recovery、P30 IA、P31 设计 | memory 与早期文档版本/计数有过时内容，事实以当前源码与本次结果为准；无升级/联网查资料 |
| project/workspace/bridge | server.js、server/runtime.js、projects.js、project-config.js、rpc-bridge.js、router.js 路由装配 | 一个 currentCwd / rpc；project activate 要先换 cwd 再 restart；配置/指令 writer 依赖这个 cwd |
| Pi child lifecycle | rpc-bridge 启动/私有 ready handshake、request/response、exit/close、退避 restart、maintenance/stop；agents/cli、Electron killServer | ChildProcess/PID 不能证明 ready；Pi 重启与项目切换使 Browser/Process 换代；旧 CLI killTree 尚需 P32 实例级监督证明 |
| session restore/generation | server/sessions.js、session-search.js 的归属机制；public/state.js、sessions.js、rpc.js、app.js、bridge-recovery.js；runtime-recovery 文档 | 文件路径不来自 Renderer，header.cwd 校验；当前 bridgeRun/GUI generation 只服务一条执行线；选择历史不是无副作用的 focus |
| Git/worktree | lib/git.js、safe-path.js；对 server/lib/public/electron 搜索 worktree；真实 git worktree list / git-common-dir | 尚无 create/list/archive/remove manager。worktreeTree 用临时 index 写 Git tree 采集 evidence，不是 Git linked-worktree 生命周期 |
| Tool Timeline | public/tools.js、tool-model.js、tool-history.js、tool-view.js 与 architecture 的渲染合同 | 纯模型可复用；实时表与计时器仍是单会话 S.tools，回填/历史需要独立 owner |
| Browser Agent | gui-browser-launch、bundled Extension、Electron main/preload/browser-view/agent-host/agent-bridge/agent/policy；agent-browser 文档 | 单 view / 固定内存 partition / 单工具 token / queue；必须同时隔离页面、partition、权限、IPC 与 document refs |
| Managed Dev Process | process-bridge、managed-processes、process-runner、bundled Extension 与平台 guardian 边界；P31 设计/验收 | owner 换代清理；focus 必须保持 owner；Process 与 Browser 权限独立，guardian 不靠公开 PID 终止 |
| Stop barrier | rpc-bridge runStop/abortAndWait、server.js wrapper、public/rpc/app；stop-barrier/process-stop/gui-browser-stop tests | Process cancel → Browser cancel → clear_queue → abort/权威确认；超时不放行；每 runtime 必须独立 |
| Electron/Server 资源 | Electron backend spawn、单窗口/browser host、关闭；server shutdown、SSE backlog/snapshot、Activity/model-generation | 保留一个 HTTP backend，per-owner runtime/adapter；退出遍历全部 owner、全局资源限额不能只看 focus |
| Planner/Approvals/Models | planner/index/scheduler、agents/pi、provider-auth-runtime/provider-auth、组合根维护闸门；approvals/provider-auth 文档 | Planner 另起 CLI，写 lease/预算需覆盖它；审批与模型回读不能依当前 UI 路由；账户/更新是共享资源 |
| Pi 官方 session/agentDir | actual launch 包 1.0.4 的 rpc-mode、agent-session-runtime、agent-session、session-manager、config、auth-storage/settings-manager | switch_session 替换当前 Session；JSONL header 存 cwd/id；默认按 cwd 编码；auth/settings 原生锁不等于各 child 内存同步 |
| 测试/发布结构 | package.json（npm test 串行 66 个脚本）、现有 Git/session/Stop/Process/Browser tests；testing/development 文档 | 默认离线 fixture；真实模型与 Electron 需 opt-in。文档阶段无需 rebuild；后续 public/server 改动必须重建 |

源码证据的准确位置与官方包相对路径在 ADR 第 2、3 节。未读取真实 auth 文件、用户会话正文或运行真实 coding task。Git 项目检查只读；唯一 Git 写操作是用户要求的新开发分支和本阶段文档提交，不创建产品 worktree，除这两份文档外不修改项目文件。

## 当前架构变化与建议状态模型

**当前架构变化：无。** ADR 只是提出 Project → Workspace/Worktree → Conversation → Runtime/child 的映射、backend/runtime/workspace epoch、原生 sessionId 回读、Browser/Process scope，以及 focus 与 dispose 分离。

建议 runtime lifecycle 与 turn 状态分开；后台 running/idle/stopping/error 和 unread/attention 分开；写 lease 覆盖所有 GUI 写执行线及尚存活服务。A/B 事件、响应、Stop、审批、模型、Git 及 Browser/Process 都按 authoritative owner 路由，而不是根据当前 tab。建议默认 2 个活跃聊天 child，显式允许第 3 个、硬上限 3；这些是待批准且需压测校准的设计参数，不是已实现的限制。

## 本阶段实际验证

环境：Windows，Node **v24.14.0**，Git **2.53.0.windows.2**。Jev router 将任务分类为 docs（confidence 0.9 / low risk），只用于路由判断；仍按仓库约定跑 npm test。没有查 npm registry/官网或执行 runtime 下载。

| 检查 | 实际结果 |
| --- | --- |
| git fetch origin main --tags | 成功；HEAD 与 origin/main 均为完整 before HEAD |
| git worktree list --porcelain | 只有当前开发 checkout；无额外已登记 linked worktree |
| git rev-parse --git-common-dir | `.git`；没有把 cwd 等同新的 product repo/workspace 身份 |
| launch package 只读定位/源码核对 | package.json 为 **1.0.4**；没有用历史 0.99.x/1.0.2 版本冒充当前 Pi |
| npm test 首次 | **exit 1**，到 process-tools.cjs:23 日志脱敏断言失败；前序 62 个脚本已完成。未执行的后续 3 个脚本不计为通过 |
| process-tools 单独重跑 | **25/25，通过** |
| 断言误匹配诊断（临时目录，无源码修改） | 强制 fake process ID 含 `abc` 后复现同一失败；诊断为 `idHasMarker:true, linesHaveMarker:false`，说明整份 JSON 搜短 marker 可把随机 ID 当泄露 |
| npm test 完整重跑 | **exit 0，66 个脚本全部执行**；P31 manager 28/28、tools 25/25、Stop 10/10、UI 16/16、runner protocol 24/24，共 **103/103**；Stop barrier **16/16**；P29 七套件 **148/148**；保留首轮失败 |
| git diff --check / 文档引用与范围检查 | 无 whitespace 错误；内部文档链接均有效，16/16 用户验收场景映射；public/server/electron/lib/extensions/tests/package/组合根差异为空，仅两个文档 |

首轮未捕获失败响应的随机 ID，所以不能断言那个样本的 UUID 一定含 abc；已证明的是 **现有断言有可复现的假红路径**，定向重跑没有观察到脱敏失败。本阶段不擅自修测试，不减少断言数量，后续可独立收窄断言到日志字段并加入稳定身份样本。

原始 baseline 日志与临时诊断夹具保存在 os.tmpdir 的本轮 `pi-gui-p32-spike-*` 目录；不进入仓库，不含真实账户/会话数据。路径记录在本地 `.git/P32_SPIKE_LOG_DIR.txt`，不是产品持久化格式。设计审查材料以本报告的安全摘要为准。

## 后续验收与已知限制

ADR 第 10 节把用户要求的 16 项测试逐项映射到 P32.2/3/4；尤其真实 A/B coding 同时执行、Stop/Browser/Process 隔离，以及 **2–3 会话持续至少 30 分钟**均为 P32.3 必须提供的实际结果。P32.4 另给三个分辨率、缩放、键盘焦点和 P30 兼容证据。

当前没有新 runtime/worktree/UI，因此没有“P32 功能真机通过”或新截图。只读源码与基线 tests 不能替代后续真机。Windows/POSIX 多 Pi 树清理、三 Chromium view 内存、官方包不同版本兼容性、第三方 Extension/MCP/global memory 共享状态仍待后续阶段验证。

当前 agentDir 覆盖变量的 `~` 展开在官方 Pi、models.json 与 GUI session scanner 中并非同一段实现；ADR 已记录待对拍边界，未擅自修复或将它断言为已发生的用户问题。本轮未修改测试入口/断言，所以不存在主动减少断言数量；跳过平台项仍按原套件显式输出，不计作通过。

本阶段完成后只提交 ADR/报告并停止，等待 ChatGPT 验收。没有 push、merge、版本号变更或 Release；此前两个不相关的未跟踪开发目录保持原样。
