# P32.3 Multi Session Runtime：实施与验收记录

日期：2026-10-06。状态：实现及离线/Electron 验证已完成；**尚未通过本阶段验收**。真实模型 coding 与至少 30 分钟并行压力测试没有通过，不能进入 P32.4。

## 基线与交付边界

- before HEAD：`698fcab252795d29176aa6c21bc40e3e0e2def52`（P32.1/P32.2 已合并基线）。
- 代码/测试 after HEAD：`891026425914193cb4d5decfc0c8a72472a6eb63`；最终分支 HEAD 另包含本验收文档提交，以 `git rev-parse HEAD` 为准。
- branch：`codex/p32-worktree-multisession`。
- 用户已授权推送当前分支；未合并、未发布。业务、测试、文档按回滚边界拆提交，保留既有未跟踪的 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`。
- 遵循 [ADR 0032](adr/0032-worktree-multisession.md) 的 A+B3；不改 Pi 本体、RPC/schema，不新增第三方依赖。

## 架构与 identity

每个 conversation 固定绑定一个经过 P32.2 验证的受控 worktree，拥有独立官方 Pi child、RPC bridge、Activity、ModelGeneration、project config、Browser scope、Managed Process manager、审批集合。经典主会话路径继续保留，独立会话不用全局 Renderer S 路由事件。

所有控制/回读使用完整 owner：`backendInstance / projectId / repoId / workspaceId / workspaceEpoch / conversationId / runtimeId / runtimeGeneration / sessionId`。backend/runtime identity 使用随机标识；sessionId 在官方 get_state 确认后绑定。PID 仅是观测值，不能作为控制权限。已经证明的原生 session identity 在 child 崩溃时保留，错误状态仍能传到该会话；明确重启时才分配新 runtime/generation。

工作区 canonical root lease 在 spawn 前取得，生命周期 admission 与 P32.2 工作区操作共用锁；同一工作区不能有第二个 writer。恢复逐项核对 project/repo/workspace/epoch/cwd/root/branch，不接受 Renderer 提供任意工作目录。经典主工作区及其目录别名不能同时接独立 writer。

异步操作在 preflight 和执行/返回后重新校验 owner；迟到 command、history、tool result、approval、stop_state、close 不作用于新 generation。前端逐会话 revision 防止较旧 HTTP snapshot 覆盖较新的 SSE 状态；eventSequence 防止重复和乱序。focus 仅切换视图，不终止后台任务。失败清理保留 lease，拒绝新写者。

## 状态与 Stop

- 生命周期：dormant → starting → ready；child crash → error；close/restart 先 disposing，再 dormant 或新 starting。
- 活动：idle / running / stopping，attention 独立标记。
- prompt 在异步发送前进入 running，失败回滚；agent_end 不是 idle 证据，沿用 agent_settled 与权威 Stop barrier。
- Stop 只向所属 bridge 发送既有 abort/clear_queue 等协议，等待既有权威屏障；A 的 Stop 不切断 B 的流。
- 模型生成失败显示简短 error/attention，保留就绪 child 和 owner，允许同一会话 retry。
- 独立会话禁止 new_session/switch_session/fork 等改变固定 session 的命令；原经典入口仍保留这些能力。

## 资源与持久化

默认总 child 上限 2，显式确认可临时达到 3，硬上限 3；经典主工作区占一个名额。列举或打开对话记录不会 spawn。Planner/generation/verifier、Pi CLI 维护与独立池互斥，避免另一个隐含 workspace writer。

每条会话记录只保存 workspace descriptor、conversation/native session ID、经会话 scanner/header 证明的 session locator 和创建时间；不保存 child PID、token、env、消息或运行状态。启动应用重新发现真实 worktree/session，记录先显示 dormant，用户恢复时才 spawn；不使用 --continue 猜会话。

每个 runtime backlog 限制 200 帧/1 MiB，前端文本 1 MiB UTF-8、100 tool 摘要、32 审批。全局 SSE 历史限制 800 帧/8 MiB，最多 8 clients，单 client 输出/待发队列 128 MiB；超限断开并重新发现。RPC 单条 JSON 上限 96 MiB，传输分帧、有背压，LF/CRLF 分隔符不占消息预算。截断显式标记并可受身份约束回读历史。

Managed Process 全局最多 8 个活动实例，沿用 P31 spec/token/generation/tree cleanup、ready、ring buffer、脱敏。每个 Pi child/模型请求/开发进程分别消耗内存、连接和系统资源；当前硬预算不代替真实长期资源验收。

## Browser / Process / 审批边界

Browser 使用现有 WebContentsView/CDP，独立非持久化 partition、私有 bridge 与令牌；各 owner 默认关闭 Agent 权限。仅 focused view 展示，后台 scope 仍独立。最多两个独立 Browser scope，加经典 scope；主进程只暴露具名 preload 方法。控制权限不因启动开发服务而扩展，P29 localhost-only 与 generation/ref 检查保留。后端退出撤销所有 Browser gateway，关闭操作幂等。

Process 每会话独立 manager；跨 processId/token/bridge generation 拒绝。关闭/重启先确认自己持有的树已清理。Agent Tool Timeline 只显示工具名、ID、状态摘要，不显示原始 args、结果、env 或 worker 错误。Model/Auth 沿用既有安全投影，不复制用户 auth.json；审批闭包捕获原 owner，切换会话不会将 A 审批发给 B。

独立会话存在时，经典 workspace switch 和 Pi 维护采取明确拒绝/先清理策略。Pi child 崩溃仅该会话进入错误，不自动重启/猜旧 child；显式重启恢复原生 session，并分配新身份。

## Windows / POSIX 与退出

复用 P31 平台监督原语：Windows guardian 通过 Job Object 清理整个拥有的树；POSIX 使用受控进程组/guardian。私有认证 duplex 通道连接真实官方 Node Pi 入口，退出通过持有的 supervisor handle 完成，不按 PID 查杀。Backend EOF 与 app quit 清理 scoped child、Browser 和 owned dev process。

本机是 Windows；真实树清理、duplex、Electron、实际 Node HTTP 服务均已在 Windows 执行。**没有 POSIX 真机证据**；离线条件/协议检查不等于 POSIX 实跑。

## 验证记录

日志目录：`C:\Users\21022\AppData\Local\Temp\pi-gui-p32-3-3ec1643284934d55808ec8b3d69849ff`。默认 npm test 仍完全离线、确定性：原 69 个脚本加 10 个专项，共 79 个；不依赖本机真实 Pi/model。

| 检查 | 实际结果 |
|---|---|
| 修改前 npm test | EXIT 0，baseline.log |
| 第一轮集成 npm test | EXIT 0，integrated-full.log |
| 第二轮全量 npm test | EXIT 0，final-full.log；后续边界修复须看最终轮日志 |
| 后续全量 npm test | EXIT 0，final-full-2.log；关闭会话前端修复后再运行 final-full-3.log |
| 最终源码 npm test | EXIT 0，final-full-3.log；全部 79 个脚本，新专项共 184/184 |
| 推送前专项复测 | EXIT 0，pre-push-runtime.log；10 个专项共 184/184 |
| registry | 31/31 |
| runtime HTTP | 12/12 |
| runtime store | 25/25，新增 dormant/null owner 重复刷新与关闭恢复回归 |
| runtime UI | 14/14 |
| session factory | 5/5，真实 Windows guardian + fixture Pi |
| Pi supervisor | 24/24；5.25 MiB Unicode/image JSON digest 一致、背压/认证/嵌套树 |
| runtime Browser | 45/45，HTTP/IPC 身份、独立 scope、关闭幂等、经典视图可见性 |
| 全局 Process budget | 4/4 |
| SSE bounded delivery | 14/14 |
| 实际 Node HTTP Process | 10/10，A/B ready、文件/端口隔离、脱敏、restart/stop/dispose A 不影响 B、退出清理 |
| 原 bridge recovery | 55/55（原 45 条保留，新增输出预算行为） |
| 原 sessions | 91 passed，0 failed（原 85 条保留，新增 tilde 路径恢复） |
| 原 Planner | 124 passed，0 failed（原 115 条保留，新增互斥/并发 generation/Stop） |
| Electron | 36/36、8 张截图，实际 Electron 44.4.3 + production server + 临时真实 Git + fixture Pi；包括 125% 缩放、真实 Escape、可见错误态、crash/restart/磁盘重新发现 |
| Electron build | 最终重建成功，整包 327.7 MB、运行时 234.9 MB，build-app-final.log |
| 打包后端 app-check | 26/26；新 temp 初次缺 PDF fixture 19/21，补运行 fixtures 后复测通过 |

新增 suite 的每条断言都保留；原有断言没有删除。上表不把未执行/跳过项目计为通过。Electron fixture RPC 只能证明路由和生命周期，不能代替真实模型 coding。

验收中发现并修复的实际问题：迟到 session locator 写回新 generation、并发 close 重复清理/释放新 lease、审批闭包串到切换后的会话、多行 stdout 误占单行预算、后台退出未撤销 Browser 网关、child 崩溃清空 session identity 导致前端误丢错误态、dormant/null owner 重复刷新抛异常。对应行为回归已保留；崩溃/关闭相关修复另外经过真实 Electron 再验证。

| 用户验收场景 | 证据与缺项 |
|---|---|
| A/B worktree 创建、dirty main、branch/path 冲突、dirty remove、非 Git | P32.2 原有临时真实 Git suites 在 npm test 保留；Electron 实际创建 A/B |
| 同时真实 coding、文件/Git 隔离 | fixture Git/Process 隔离已过；真实模型 coding HTTP 502，缺项 |
| A streaming 切 B 并发送、Stop A 不停 B | registry/HTTP/UI/factory + Electron 实际输入/后端检查；Pi 回复为 fixture |
| B Browser/Process 与 A 隔离 | 实际 Electron/CDP A/B 页面与 localhost 拒绝；实际 Node HTTP P31 managers A/B ready/restart/stop/dispose |
| stale workspace/runtime、迟到事件与返回 | registry/store/UI/HTTP 可控 barrier；不依赖固定 sleep 判断 stale |
| 重启应用重新发现 session/worktree | Electron 的 production backend 重启 + 页面重载；零 scoped auto-spawn、旧 backend owner 拒绝、原生 session 恢复；非整应用窗口重开 |
| 外部删除 worktree | 既有 worktree missing/open/restore suites；registry epoch replacement 隔离；未在运行中强行删除 Windows 锁定 cwd |
| Pi crash/restart 单会话 | 实际 supervised fixture Pi exit 7、A 可见错误、B 继续 streaming，A 重启保持原生 session/fresh runtime owner |
| 2–3 会话至少 30 分钟 | 未通过，不以短 fixture 流程替代 |

### 截图与键盘

截图位于 `C:\pi-GUI\.shots\p32-3\`，尺寸及 overflow 数据在 report.json。1280×800、1440×900、1920×1080 均以 CSS viewport 实测，Windows DPI 会使 PNG 像素尺寸更大。

1. [1280×800 A/B streaming](../.shots/p32-3/running-B-1280x800.png)
2. [1440×900 A/B streaming](../.shots/p32-3/running-B-1440x900.png)
3. [1920×1080 A/B streaming](../.shots/p32-3/running-B-1920x1080.png)
4. [Stop A，B 继续](../.shots/p32-3/A-stopped-B-running.png)
5. [独立 Browser 右栏打开](../.shots/p32-3/scoped-browser-open.png)
6. [Browser 关闭](../.shots/p32-3/scoped-browser-closed.png)
7. [125% 页面缩放](../.shots/p32-3/running-B-zoom125.png)
8. [A 崩溃，B 继续](../.shots/p32-3/A-crashed-B-running.png)

真实 Electron 输入检查 Tab/Shift+Tab 焦点循环、Escape 关闭、A streaming 切 B 发任务、A Stop 不停 B；offline UI 另外验证草稿隔离、迟到 Stop/history/approval、共享审批 ID 不串线。三个尺寸检测 document scrollWidth/Height 不超 viewport；125% 缩放另截图。现有 palette/search/project/history 等完整整合保留经典路径，独立会话完整导航属于 P32.4。

### 真实 Pi / coding / 压力测试：未通过

`test:runtime-live` 是 opt-in，全部写入临时 Git repo/worktrees、agentDir、sessions/dataDir；读取已有模型定义/凭据，仅在进程 env 中使用 key，不复制用户认证文件、不刷新 OAuth、不改真实项目。

2026-10-06 实际官方 Pi 1.0.4 两个 child 分别完成 RPC ready，原生 session IDs 不同。当前默认 `magpie / gemini/gemini-3.8-flash` 两路请求均出现 HTTP 502，各重试四次，没有 coding tool 执行、没有目标文件产生。日志 runtime-live.log、报告 runtime-live.json；失败后 cleanupConfirmed=true。

这只证明真实 child 启动/身份分离及失败清理；**不证明真实 A/B coding、热修改隔离、真实模型 Stop 或 30 分钟压力测试**。尚需用户指定可用的已配置 Provider/Model，或选择重试当前默认模型；不会自行猜另一模型。

## 关键文件与已知限制

新增核心：server/runtime-registry.js、session-runtime.js、pi-supervisor.js、runtime-routes.js、runtime-browser-launch.js；extensions/pi-gui-process/runtime-child.cjs；electron/browser-runtime-host.cjs；public/runtime-store.js、runtime-sessions.js。

组合与兼容：server.js、router.js、worktrees.js、rpc-bridge.js、sessions.js、sse.js、planner/index.js、process-bridge.js、managed-processes.js；electron/main/preload/browser-view；public/api/app/worktrees/browser-pane/styles。专项 suite 经 package.json 接入唯一 npm test 入口。

限制：本阶段窄入口位于 worktree 菜单/独立会话 modal，未实现 P32.4 完整侧栏、历史搜索、模型选择 UI、attention 通知整合。第三方 Extension/MCP/全局 memory 不是 OS sandbox，可能共享内部状态；不承诺其完全隔离。当前拒绝与 Planner/维护共存，属于保守 writer 安全策略。清理无法证明时保留 lease，需要人工恢复；不自动 stash/reset/强制移除。

真实模型和 30 分钟验收缺项、POSIX 真机缺项必须保留，不能以 fixture/Electron 截图或 npm test 替代。当前阶段不宣告完成，后续阶段未启动。
