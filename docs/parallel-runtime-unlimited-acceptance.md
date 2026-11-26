# 多会话无数量上限 · PR #113 增量验收

## 范围与产品契约

- 日期：2026-11-26；分支 `fix/parallel-session-runtime`，继续现有 PR #113，不新建 PR。
- before HEAD：`dbe8168385fe2bfe109eaa60fd8f4833a5872308`。
- 用户可以自由创建、打开和同时运行任意数量的合法会话。pi-GUI 不设置会话总量、独立
  Runtime 或并行模型任务数量上限，也不增加软上限、可配置上限、隐藏上限或并发设置项。
- 实际结果由操作系统资源、供应商服务能力以及必要的身份、安全、维护和共享写资源协调
  决定；资源计数只用于展示、诊断，不参与准入。
- 本轮不重构 Runtime 架构、不新增依赖，不修改 CSS、图标、布局、思考动画、消息或输入框
  视觉及无关交互。
- 授权范围包含本轮代码、测试、最终 Windows Electron 重建、隔离 TEMP 真实模型验收、
  文档、提交、推送及更新 PR；不包含合并、tag 或发版。

## 已定位并移除的限制

行号指 before HEAD（`dbe81683`）。兼容字段只在传输边界接受后丢弃，不再咨询。

| 原位置 | 原行为 | 现行为 |
| --- | --- | --- |
| `server/runtime-registry.js:238` | 快照返回 `limit: 2, hardLimit: 3` | 只返回真实 `liveCount/totalCount` |
| `server/runtime-registry.js:440-442` | 总数 ≥3 或 ≥2 未确认时 `runtime_limit` | 删除准入配额；租约/身份校验保留 |
| `server/runtime-registry.js:482-484`、`:508` | `start`/`openProjectSession` 记录数 ≥256 拒绝 | 删除记录数上限 |
| `server/runtime-registry.js:877` | 重启内部传 `allowThird` | 内部不再构造该参数 |
| `server/runtime-registry.js:54`、`:56` | manifest >1 MiB 或 >256 条即判损坏 | 只校验 schema/重复/路径/符号链接 |
| `server/runtime-routes.js:4` | 公开 `runtime_limit`/`conversation_limit` | 从错误码集合删除 |
| `server/runtime-routes.js:38`、`:44` | 顶层/nested `allowThird` 进入 `resume` | 边界接受后丢弃，不传给后端 |
| `server/ordinary-sessions.js:110`、`:121` | `allowThird` 透传到 admission | 仅兼容接收，不再转发 |
| `server/candidate-runs.js:61` | 已有 3 条执行线时 `candidate_busy` | 删除；候选执行走同一无配额启动 |
| `server/candidate-runs.js:65`、`:93` | 计划/启动携带 `allowThird` | 删除字段 |
| `server/worktrees.js:41`、`:43` | manifest >1 MiB 或 >256 条判损坏 | 只校验 schema/身份 |
| `server/worktrees.js:144` | 第 257 个 Worktree `workspace_limit` | 删除数量上限（消息同步删除） |
| `server/sessions.js:44-45`、`:362`、`:458` | 扫描 800、列表 200、flags 5000 截断 | 扫描/列出全部；flags 不再截断（截断会让旧状态复活） |
| `public/runtime-resources.js` | 第三个会话确认、`allowThird`、`runtime_limit` 重试、`x / 2` 名额文案 | 单次发送 + 只读回读；只显示真实运行数 |
| `public/runtime-store.js` | 要求 `limit/hardLimit` 才更新计数 | 只要求非负 `liveCount/totalCount` |
| `public/app.js`、`runtime-nav.js`、`runtime-conversation.js`、`runtime-sessions.js` | 名额提示/确认/“不占名额”文案 | 改为通用动作提示与中性文案 |
| `public/sessions.js:84`、`:636-638` | 已归档只显示 50 条 | 全部渲染 |
| `public/candidate-review.js:32` | “本次增加一条，上限 3” | 删除“上限 3” |
| `electron/browser-runtime-host.cjs:37` | 已销毁 scope 墓碑超过 256 后拒绝新 scope | tombstone 数量不再成为准入条件 |
| `electron/browser-runtime-host.cjs:38` | 同时最多 2 个 Runtime Browser scope，第 3 个 `browser_limit` | 删除；每个合法 Runtime 都可分配自己的 Browser scope |

> Browser scope 上限是真实验收发现的**间接会话上限**：它发生在 Runtime 工厂里，
> 第三个 Runtime 的 `allocate` 失败会变成 `runtime_start_failed`，表现为“第三条会话
> 起不来”。`tests/runtime-browser.cjs` 原先把它当作预期行为断言，现已改为第三条及
> 更多 scope 可分配、错误 scope 仍被拒绝，并覆盖 300 次打开/关闭后的新 scope。

`server/quota.js` 的 `hard_limit_usd` 是供应商账单字段，不是会话配额，未改动。

## 保留的安全与资源边界

本轮取消的是数量准入，不是取消安全资格：

- Registry 继续拥有每个 conversation 的 Runtime、完整 owner、generation、native
  sessionId、事件序号和生命周期；每会话仍使用独立 Pi 进程和 RPC 通道。
- 同一原生会话不得被两个实例持有；历史恢复继续验证登记项目、workspace epoch、原生文件
  和目录身份，不能凭缓存或旧 owner 放行。
- 同/重叠工作区的写工具仍由既有工具协调器和写租约互斥；只协调冲突工具，不等待整个
  模型回合，不串行独立会话的模型执行。
- RPC mutation 命令账本、未知结果 fail-closed、权限归属、Stop 屏障、独立取消、迟到事件
  拒绝和异常恢复不放宽。
- 维护态、工作区身份、安全路径、单请求大小、每 Runtime 事件/消息缓冲及资源绑定保护
  保留；这些边界不按会话总数拒绝任务。
- 关闭/退出复用既有 retirement、adapter dispose、guardian 整树确认、订阅/定时器/私有
  协调通道释放和租约收口。未经确认的清理不伪装成功，不为开新会话杀掉已有任务。
- Browser 控制器为每个合法 Runtime 建立独立 scope；`retired` 集合只保留已销毁
  owner 的身份键，用于拒绝迟到的 allocate/调用，不再作为数量准入阈值。
- 不引入全局模型任务队列、全局信号量、固定进程池、空闲任务强杀或新的调度架构。控制面
  原子登记和必要的共享写资源协调不等于模型执行数量预算。

## 批量 Browser 控制连接

独立复审在取消 Browser scope 上限后暴露了一个**批量清理缺陷**：Browser 控制面
listener 保留 `maxConnections=16`，而 Registry 的 `closeAll()`/`dispose()` 会对所有
live 同时发 `dispose`。用真实 gateway + host 探测 40 个 scope：16 个成功，24 个
`ECONNRESET`，24 个 scope 留在 records 中，Registry 只能报 `cleanup_pending`。

修复没有提高连接上限（那只是把压力推迟到更大规模），而是在
`server/runtime-browser-launch.js` 让 Browser 生命周期请求复用 Browser host 本身的
串行 `chain`：同一时刻只发一个控制请求，不堆连接、不丢请求。排队只针对
allocate/focus/dispose 控制面，不参与模型回合调度，也不限制会话总数；`maxConnections=16`
作为私有监听的本机防护保留。

修复后同一探测：40 个并发 allocate 全部成功，40 个并发 dispose 全部成功，records
归零。`tests/runtime-browser.cjs` 新增 40 scope 并发 allocate/dispose 回归，并继续
断言 dispose 失败时不会把旧 owner 当成成功。

## 生命周期与资源失败

- HTTP `start`（新建会话）在全局生命周期队列内完成身份复核、记录和租约预留，
  `adapter.start()` 的等待在队列外进行；慢启动只占自己的 HTTP 请求，不阻塞无关
  工作区的启动、focus、close 或 resume。
- 生产适配器的 spawn 失败通过结构化结果（`runtime_start_failed`）传回 Registry，
  HTTP start 拒绝并回滚新增记录；不再只发异步 `bridge_status` 事件后按成功返回。
- `openProjectSession` / `resume`（历史恢复）在适配器就绪后立即返回，启动过程由事件推进；
  这样同项目的共享启动准入不会把多个会话的完整启动串行化。
- 非阻塞启动的异步拒绝必须被观察：只把该 live 标为 `runtime_start_failed` 并 retire，
  不产生未处理 rejection，不清理其它 Runtime。
- 已有回归覆盖：单个 factory 失败、异步 start 失败、生产 adapter spawn 失败、慢启动与
  无关工作区启动并行，五个/十个既有会话的 owner、native 身份和运行回合均不受影响。

## 实施与验收证据

### 基线

- before HEAD 精确 PR CI：`45809938265`（运行时仍在进行，见 PR）。
- 作者未改安全模块前的本地定向基线：`provider-auth-runtime` 75/75、
  `session-tool-scheduler` 9/9、`session-tool-bridge` 52/52、`stop-barrier` 19/19、
  `session-runtime` 9/9、`server-security` 44/44，合计 **208/208，exit 0**。
  日志：TEMP `pi-gui-unlimited-main-rgCYTX/baseline.log`。

### 本轮定向回归（最终代码状态）

| 套件 | 结果 |
| --- | --- |
| `runtime-registry` | 51/51（含慢启动不阻塞无关 Runtime 的回归） |
| `runtime-http` | 16/16 |
| `session-runtime` | 10/10（含生产 adapter spawn 失败 rejection） |
| `bridge-state-recovery` | 62/62（含结构化启动失败结果） |
| `ordinary-session-runtime` | 18/18 |
| `ordinary-session-resolver` | 8/8 |
| `candidate-runs` | 35/35 |
| `worktrees` | 58/58（win32，真实 Git fixture） |
| `runtime-resources` | 50/50 |
| `runtime-store` | 43/43 |
| `runtime-nav` | 54/54 |
| `runtime-conversation` | 119/119 |
| `runtime-finish-ui` | 48/48 |
| `runtime-resource-cleanup` | 18/18 |
| `runtime-browser` | 54/54（第三条 scope、300 次 scope 轮换、40 scope 并发 allocate/dispose、错误 scope 仍拒绝） |
| `sessions` | 99 passed, 0 failed |

主要新增覆盖：270 条持久记录跨普通/Worktree 形态、>1 MiB manifest 完整读回、五个 Runtime
同时恢复、五条模型命令并行进入各自 adapter、重启单个不影响其余；慢启动不阻塞无关
Runtime 的登记与启动；生产 adapter 的同步 spawn 失败以 `runtime_start_failed` 拒绝并
回滚；806 个会话全部列出并可打开；5000+ 归档 flags 不截断；758 条 Worktree 记录不阻止
预检；40 个 Browser scope 并发 allocate/dispose 全部确认。旧“第三确认/第四拒绝”断言已
替换为“第三到第十无需确认、owner 不被替换”的正向断言。

### 十真实子进程压力

`node tests/parallel-runtime-integration.cjs` → **48/48**，使用生产 Registry、
session-runtime、guardian/RPC 子进程、bundled guard、共享工具调度：
十个真实子进程（同项目 A/B + 不同项目 C–J）、十个独立原生身份与 PID、九条工具同时执行、
同项目写等待、60 次焦点切换与同 ID 并行读取、单次启动失败隔离、Stop 只影响 A、
B 独立前进、相同请求/工具/审批 ID 不串线、三轮九子进程压力、同时关闭三条忙碌子进程、
resume/restart、后端重启后 10+ 条 dormant 记录与旧 owner 拒绝。
十个是回归的最低负载，不是产品上限。

驱动离线自检：`--check-driver` **44/44**（22 个原生模板）；`--check-safety` **38/38**。

### 最终 Windows Electron 产物

`npm run build:app -- --rebuild` exit 0：`dist-app/Pi GUI-win32-x64`，整包 349.8 MB，
`Pi GUI.exe` 234.9 MB（246,324,736 字节），SHA-256
`71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f`。
Electron 外壳 exe 本身是固定二进制，两次构建哈希相同不代表资源旧；产物新鲜度以
`resources/app` 逐字节比对源码为准：`server.cjs` 与 `build/server.cjs` 一致
（SHA-256 `ca9b9234e9046a43e429b64d3f2b91f195f3683788e16036f7395ab22105ab47`，
3,899,446 字节），`resources/app` 下全部 48 个 `electron/*.cjs`（含本轮修改的
`browser-runtime-host.cjs`，SHA-256 `7aaee7e1…`）与源码逐字节一致，
`public/app.js`、`public/runtime-store.js`、`public/runtime-resources.js` 亦一致。
构建日志：TEMP `pi-gui-unlimited-build3.log`。

### 真实模型验收

- **preflight（最终打包产物 + 真实 Pi + `xingchiapi/gpt-6.1-sol`）：10/10，failed=0**。
  真实 `get_state` 确认所选模型；纯输出回合有真实 start/exact output/settled/idle 且无工具；
  原生 write/read 回合成功，文件字节与 digest 精确匹配；进程族在清理前被父进程观察，
  生产 sandbox/contextIsolation/preload 检查通过。
  TEMP：`pi-parallel-live-SZecVS`（复审修复前的三次旧构建 preflight 分别为
  `pi-parallel-live-3jr2LJ`、`pi-parallel-live-TkyCNZ`、`pi-parallel-live-NyyQ0D`，
  均 10/10，保留作历史）。
- **full（exercise + recovery，五会话实际重叠）：47/47 + 42/42 = 89/89，failed=0，
  exit 0，`fullLiveAcceptance=true`。** TEMP：`pi-parallel-live-dao8s6/evidence`。
  使用同一最终打包产物（backend `ca9b9234…`）和真实 `xingchiapi/gpt-6.1-sol`：
  - A（Classic）与 B/C/D/E 五个真实 Pi 进程同时运行，`totalCount=5`、五个独立
    native sessionId/runtimeId；C/D/E 均为第三条以上会话，无确认、无替换。
  - 五个真实模型任务有实际时间重叠；SSE 对五个 owner 都记录真实 `agent_start`；
    B/C/D/E 都实际执行 native write/read/bash，文件字节与 digest 精确匹配。
  - A/C 的工具 shell 运行期间 B/D/E 的写入按同根写协调等待，不是 Runtime 准入；
    Stop A 后 B/C/D/E 继续流式输出，B 的排队写入随后完成，A 的延迟写入未执行。
  - Electron reload 后 B/C/D/E 的 owner/native session 恢复且不自动重放；显式
    restart B 不替换 C/D/E；recovery 真实重启 Electron/backend，B/C/D/E 历史保持
    dormant，显式 resume 后恢复原生身份并完成新一轮真实 write/read 模型回合。
  - 退出前父进程观察到全部 live 进程族，公开 close 全部确认。
  - 修复前同一 exercise 曾在 Browser 第 3 个 scope 上限处失败；旧证据保留在
    `pi-parallel-live-u0CMJh`（stop 阶段测试竞态）与更早的失败记录中。

### 独立复审

第一轮增量复审（claudeAgent `xingchiapi/gpt-6.1-sol`，effort max）发现 3 项 Important，
均已修复并补回归：

- 慢启动被纳入全局生命周期队列，阻塞无关工作区启动。改为在队列内完成身份复核、记录和
  租约/factory 预留，`adapter.start()` 在队列外等待；`runtime-registry` 增至 51/51，
  新增“slow-A 未完成时 fast-B 仍可登记并启动”的回归。
- 生产适配器在 spawn 失败时只发异步事件、HTTP start 仍按成功返回。`rpc.start()` 现在
  返回脱敏的结构化 `{ok:false, code:'runtime_start_failed'}`，生产 adapter 转为
  rejection，Registry 拒绝并回滚新增记录；`session-runtime` 10/10、
  `bridge-state-recovery` 62/62。
- 集成测试恢复场景只等 `lifecycle=ready`，未等 `owner.sessionId` 原生身份绑定，存在
  竞态。等待条件已同时校验持久原生 sessionId；`parallel-runtime-integration` 48/48。

复审同轮报告的 Browser 批量关闭缺陷（40 scope 并发 dispose 时 16 连接上限导致 24 个
`ECONNRESET`）也已修复：Browser 生命周期控制改为复用宿主既有串行链，40/40 全部确认，
`runtime-browser` 54/54。

最终增量复审针对修复后提交的结论见本节末（提交后补记）。

## 未验证与边界

- 本文件不把旧 2/3 配额证据改写成新契约通过；历史报告保留原始数字与失败。
- 完整 canonical `npm test` 由最终 PR CI 提供；本地只运行定向与专项。
- 真实模型验收不能替代 PR CI，PR CI 也不能替代真实模型重叠证据。
