# T4-B：候选 Worktree 与真实 Diff 的安全勘察设计

## 当前结论

**本轮停在设计和可复核的临时 fixture 实验，不开放候选写入或 Agent 启动入口。T4-B 尚未实现、未通过验收。**
这不是因为 Worktree 没有 OS 沙箱而一概拒绝实现。具体缺口是：现有创建确认没有绑定 dirty 内容，
现有建树会自动纳入未选择文件并可能运行 Git filter，现有时间窗口证据不能区分外部写入。
直接拼接这些模块会违反本任务的输入授权及结果可信度要求；不能把用户未批准的语义降级当作完工。
下文是候选执行的设计约束，**不是已生效 API 或安全能力**。

## 1. 基线与勘察范围

- 基线 `03a223d7ac5f69f33a359e51f95905bfb07253b8`，包含 T4-A PR #20 head
  `139f5de617af60f4fbf86760372b286186f6faed`。
- [T4-A PR](https://github.com/HYJ1817/pi-gui/pull/20) 已合并；
  [PR CI 39817859759](https://github.com/HYJ1817/pi-gui/actions/runs/39817859759) 与
  [main push CI 39823004520](https://github.com/HYJ1817/pi-gui/actions/runs/39823004520)
  attempt 1 均成功。main 的 test-plan、五测试组、build、gate 共 8 job 均 completed/success。
- 本轮独立分支 `codex/t4-b-candidate-diff`，从上述最新 origin/main 创建；没有修改主工作区。
- 已读 [AGENTS](../AGENTS.md)、[REVIEW](../REVIEW.md)、[导航](README.md)，并沿
  [Worktree](worktrees.md)、[ADR](adr/0032-worktree-multisession.md)、[工作台](work-surfaces.md)、
  [会话](sessions.md)、[恢复](runtime-recovery.md)、[安全](security.md)、[审批](approvals.md)、
  [Git Changes](git-changes.md)、[工作流](workflows.md)、[人工审阅](reviews.md)、
  [测试政策](testing.md#测试执行政策)、[T4-A 验收](T4-A-acceptance.md) 核对实际代码。
- `worktrees.md` 开头描述 P32.2 历史阶段；当前是否有独立执行线以 Runtime Registry 和组合根为准，
  不能由该历史段落推断“当前仍只有一个 child”。也没有把 P33 写回资格移植为 T4-B 的资格。

## 2. 复用地图与实际能力

| 责任 | 现有模块 | 可以复用 / 不能推定 |
| --- | --- | --- |
| 创建、身份、归档和安全移除 | [server/worktrees.js](../server/worktrees.js)、[lib/git-worktree.js](../lib/git-worktree.js) | 后端路径、nonce、generation、root/admin identity、串行控制、无 force 移除；创建只检出提交，不复制 dirty |
| 执行线和完整 owner | [runtime-registry.js](../server/runtime-registry.js)、[session-runtime.js](../server/session-runtime.js) | workspace lease、conversation、native session 回读、生命周期；不能把可变 runtime ID 当永久任务 ID |
| RPC、Stop、进程清理 | [rpc-bridge.js](../server/rpc-bridge.js)、[pi-supervisor.js](../server/pi-supervisor.js) | 原有 abort/idle 确认和整树清理；`agent_end` 或进程 spawn 不证明完成 |
| 协作写者调度 | [session-tool-scheduler.js](../server/session-tool-scheduler.js)、[session-tool-bridge.js](../server/session-tool-bridge.js) | 同应用协作工具的排队/lease；没有外部进程排他或逐文件写入来源证明 |
| 评论权威与任务文本 | [review-comment-authority.js](../server/review-comment-authority.js)、[review-task.js](../public/review-task.js)、[review-task-preview.js](../public/review-task-preview.js) | 后端稳定 scope/CAS 与前端预览失效；前端 `verified` 不能单独授权后端执行 |
| 路径与 Git 读取 | [safe-path.js](../lib/safe-path.js)、[git.js](../lib/git.js)、[git-routes.js](../server/git-routes.js) | 安全路径、结构化 argv、超时/容量、真实 Diff；普通查询不是 dirty 输入复制事务 |
| 历史前后 Diff | [planner/evidence.js](../server/planner/evidence.js)、`worktreeTree/treeDiff/treeNumstat` | 使用执行前工作区而非 HEAD、rename/binary/截断；只是时间窗口证据，不能直接充当完整输入或 Agent 归因证明 |
| 显示与焦点 | [diff.js](../public/diff.js)、[git.js](../public/git.js)、[runtime-conversation.js](../public/runtime-conversation.js)、[secondary-surface.js](../public/ui/secondary-surface.js) | 现有 Diff 渲染、弹层/分屏/native Browser 遮挡；关闭显示层不应销毁候选执行 |

组合根仍是 [server.js](../server.js)。不增加第二套 Worktree Registry、Agent Executor 或通用命令入口。

## 3. 三种方案与选择

1. 直接从 HEAD 建 Worktree，再发原任务：代码少，但 dirty 评论的输入不存在，拒绝。
2. 将 Planner 的临时 index 建树与现有创建直接组合：能得到前后真实 Diff，但未经选择的 untracked、
   clean/smudge filter、内容漂移及外部写入来源未解决，拒绝作为已完成实现。
3. 在既有生命周期内补受限输入事务、执行确认与结果证据契约：方向可行，保留现有 Registry/RPC/Stop；
   在输入及结果资格未满足前阻止写入。本轮选择此设计，交付实验和阻塞清单。

没有新增一个“永远成功”的预检，也没有用空壳按钮掩盖执行能力尚未完成。

## 4. 候选身份、确认与会话绑定

拟议运行记录只引用现有 workspace ID/epoch、来源持久 scope、来源 conversation/native session、
独立 `candidateRunId`、快照摘要与实际候选 conversation。瞬时完整 owner 仅用于当次授权，不作为永久归属。
运行元数据应放在既有应用数据边界，不写评论 schema 或用户源文件；路径只能由 Worktree 后端生成。

预检展示来源项目/工作区、focused conversation、评论数/文件、HEAD、五类 Git 状态、忙碌主体、
预计目标及写入清单、弱隔离说明。预检阶段不得创建候选、调用 `worktreeTree`、写 Git 对象或启动 child。
现有 `prepareImpl` 会建立受控父目录，因此也不能未经调整就声称预检是完全只读。

用户明确确认后，以单次短时 nonce 绑定完整来源 owner/contextRevision、评论存储 revision/选中原文摘要、
Diff 证据和磁盘输入摘要；消费 nonce 后不自动重试。实际创建、输入落地、启动前分别重新验证。
来源切换后旧确认失效，不因切回同一会话恢复效力。

创建沿 `worktrees.create/withWorkspace`；会话沿 `runtimeRegistry.start` 与现有 factory、
`get_state` 回读、完整 owner 校验。不得借用原会话直接 `prompt`，不得启动后凭 focused 会话猜目标。
候选会话应明确选择并显示其审批，不静默抢原 Composer；来源草稿与候选草稿分开。
原 T4-A 文本保留为引用任务数据，执行说明明确候选 cwd 和输入快照；原路径不能成为写原项目的授权。

## 5. dirty 输入事务

输入至少分三层：HEAD commit、真实 index 各 stage/mode/blob、working 原始字节/删除状态；
untracked 单独列出并逐项确认。第一版可拒绝 untracked，不可静默遗漏后仍称完整输入。
ignored 只计数/提示，不读取正文、不复制；疑似凭据或需额外上下文而未授权的文件拒绝该任务。
staged 评论针对 index，working 评论针对 index→working；混合选择必须分别重验，不能用一棵树冒充两层。

拟议受限格式：整仓库项目、有效 HEAD、普通 stage-0 文件、可验证目录；先设置例如最多 256 文件、
单文件 1 MiB、合计 8 MiB 的上限并在预检展示，超限拒绝而非截断输入。数值尚非产品规则。
空 HEAD、冲突 stage、sparse/skip-worktree、子模块/嵌套仓库、路径别名冲突、链接/junction/hardlink、
特殊文件、未知编码或属性转换无法无损表示时保守拒绝。Unicode/CRLF/无末尾换行必须按原始字节校验。

必须先安全枚举 HEAD/index 和路径/对象身份，再读取有界字节；拒绝仓库 filter/process filter、
外部 attributes、未知 checkout 转换等可执行/不等价配置。不能仅靠 `--no-ext-diff` 保护 checkout/add。
安全判断覆盖整次 checkout 的 HEAD 文件，不能只看选中评论路径。Git admin/common/config/index/目录对象
在异步读取后、实际创建/落地前重验，任何 Git lock/来源变化即拒绝，不 stash/reset/commit 原工作区。

完整读取并复核后才形成不透明快照 ID；候选工作区在现有 lifecycle 锁和 lease 下落地已授权的原始内容，
同时保持 index 与 working 的差别。候选落地后的字节与清单必须等于输入快照，才能记 `pre` 并启动。
失败保留已登记候选及失败记录，不强删、不自动回滚原项目。

**现有接口没有这个输入事务。** P01～P11、P16～P18 实验说明缺口；不能仅把 `dirtyStatus` 字符串
或临时 tree SHA 当成上述完整原始字节/授权清单。

## 6. 执行权限与结果资格

Worktree 只隔离 Git 工作目录；同用户 Agent 仍可用绝对路径、shell、扩展访问原项目、共享 Git common
及用户其他文件。现有审批只应答实际 `extension_ui_request`，没有问询就没有 GUI 审批。
tool guard 是协作调度，不是权限扩展；不能在界面上杜撰“所有写入均已拦截”。
保留现有工具审批/Stop/全局忙碌屏障，不自动安装权限扩展或授予网络/命令/文件权限。

拟议启动顺序：有效评论及输入快照 → 候选身份和 cwd 验证 → 忙碌与 Stop 屏障 → 已消费的本次确认 →
可信 pre → 精确 owner 的一次 prompt。未知应答保留“不确定/中断”，不自动再发。

可信 Diff 分为两个问题：

- `pre → post` 可证明某段时间内实际字节变了什么；初始 dirty 已包含在 pre，因此不计入本次变化。
- “Agent 真正产生的修改”还需写入来源/完整性证据。P12/P13 中无 Agent 写入，外部 Node 进程仍能
  在 tool lease 持有时写入，而 `captureEvidence` 返回 available。这不能升级成归因成功。

当前没有覆盖任意外部写者、shell/未知工具副作用的来源证明。即使两次扫描稳定、fs.watch 没报告变化、
用户确认“不编辑”，也不能证明无外部写入。P33 的捕获摘要也明确返回 `externalConcurrencyUnexcluded`。
因此本设计没有符合完整规格的结果资格；**不启动一个最终只能假称可靠的可写流程**。
这并非宣称今后绝不可能实现，而是当前证据不足。继续完整实现需可验证的来源/并发失效机制；
若改为只显示“执行期间观察到的真实变化，来源未确认”，那是降低归因要求，须另行明确任务语义，不能自动替换本规格。

## 7. Diff、故障与保留

前后快照资格满足后，复用 treeDiff/treeNumstat 的比较与现有渲染器；构树须避免未授权内容/filters。
post 应在真实结束及进程清理确认后取得，完整目录清单包含关联修改而非仅选中文件。
改回 pre 的文件应无变化；新增/删除/纯 rename/binary 分别表达；容量/分页/截断单列，不能写成完整。
只有统计没有 patch、对象身份变化、外部冲突或采集失败均显示“结果无法可靠确认”。

| 事件 | 必须保持的行为 |
| --- | --- |
| 双击/nonce 重放 | 只有一次创建/一次发送；未知应答不再次启动 |
| 项目/评论/HEAD/index/working 漂移 | 实际写入前拒绝，要求重新预检；不能复用旧确认 |
| 切会话/项目、关闭面板 | 撤销旧 UI 请求，不结束已确认执行；审批仍归候选完整 owner |
| Stop | 沿原 abortAndWait/进程树清理；屏障确认前不释放 writer lease 或显示停止完成 |
| RPC 断开/崩溃/重启 | 旧 running 只恢复为中断或待核实；不重发、不用重启后的磁盘补造当时 post |
| 工作区删除/替换、Git lock、身份异常 | 撤销操作资格，保留记录及仍存在文件；不回退原 cwd 继续执行 |
| 执行失败、Diff 失败 | 分开记录执行状态与证据状态；不把有 Diff 当执行成功 |
| 结束预览/放弃 | 只结束显示；候选文件与分支保留，删除另走现有确认 |

持久状态拟议为待启动、执行中、已完成、失败、已停止、中断，结果资格独立为可用/截断/不可用。
`agent_settled` 只用于收口活动，仍要排除生成失败并核对 native 状态及清理；“已完成”不等于人工验收。
运行元数据落盘失败不自动重开执行；未知未来格式保留并拒绝覆盖，不存完整任务/源码/模型消息到诊断。
可信输入材料应独立有界保存并遵循现有数据保护，不能把源码塞入诊断 JSON。

本阶段永不应用到原项目。候选 Worktree 沿现有归档/保留策略；dirty、ignored、身份未知、未证明整合的结果
不会强制删除。不得用 reset --hard、clean -fd、worktree remove --force 简化恢复。

## 8. 安全停止边界与继续顺序

1. 先实现并独立审查受限只读输入清单及原始内容证据；用内容漂移、filter、凭据/未选 untracked、
   symlink/junction、Git admin 替换和混合 index/working 的失败 fixture 验证拒绝。
2. 解决结果归因契约：提供真实可验证的写入来源及并发失效证据，或由用户另行决定只做来源未确认的时间窗口 Diff。
   不把此选择转成“是否开启 OS 沙箱”的错误二选一，也不自动变更现有权限机制。
3. 条件满足后，在现有 Worktree 生命周期内添加确认事务及输入落地；fake Pi 验证 cwd、审批、Stop、
   双击/重放、关闭面板、A/B、崩溃后不重发；再接真实 Diff 与既有 Changes UI。
4. 最终行为 SHA 的 canonical、正常沙箱 Electron、App/SEA、独立功能及安全/故障审查分别验收；
   没运行不得引用 T4-A 数字填充。不得推送/合并/发布。

本轮只执行前置勘察与实验，未把上述尚缺的能力写为已完成。
复核入口：[临时实验](evidence/t4-b-feasibility/probe.mjs)、[观察结果](evidence/t4-b-feasibility/observations.json)、
[交付与未验证项](T4-B-acceptance.md)。
