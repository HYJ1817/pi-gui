# T4-C：候选修改采纳、冲突检测与恢复

C2 续作基线 `092716e24d739a7857ab338604e9084f1b0f0bd3`。2026-10-24 复审在 `2dfde86` 合入 v0.28.0/G0-B，并修复恢复确认前置异常。以下为当前行为；末尾保留 C1 历史勘察，旧阻塞说明不再代表 C2 状态。

## 当前实现

可信材料和来源冲突规则沿用 C1。`checkCandidateAdoption` 默认只读，仅后端内部 `materialize:true` 返回受限原始字节；Renderer 不提供路径、字节或命令。
候选须 completed、reliable、完整证据及 Registry 身份有效。来源 HEAD、逻辑 index、全部原文件内容/身份/权限、目录、Git admin/common 和 config 必须与输入一致；任一漂移拒绝整次采纳。

`server/candidate-apply.js` 提供两阶段授权。准备返回 120 秒单次 nonce，绑定完整 scope/owner 和计划。确认先消费 nonce，再复核候选、来源和互斥状态。整次候选仅更新 working tree，不写暂存内容，不执行 Git add/commit 或 Agent。原生事务期间 Git index 被只读句柄固定；普通 GUI 查询在事务外可能刷新恢复后干净文件的 stat 缓存，逻辑暂存项（路径、mode、OID、stage）保持不变。
`server/candidate-write-native.ps1` 由固定 stdio 协议调用，不引入任意 shell 入口。它仅支持 Windows 本地 NTFS、已有父目录和有界普通文件；修改保持原文件对象，新增使用 CREATE_NEW，删除以 no-replace 原句柄 rename 保留对象。目标和其他来源文件禁止 write/delete sharing，目录链禁止 delete sharing，固定 Git 文件另持有只读句柄。句柄锁定后重跑来源/候选校验，权限冲突保守拒绝。

## 事务及恢复

`server/candidate-transactions.js` 在应用数据目录保存独立的追加日志：计划、来源身份、原文、输出、步骤 intent 和实际结果。第一处源码写入前完成文件 flush/readback；每步先记录 intent，再写入/flush/读回，最后保存 verified。全部输出与逻辑 index 验证通过，并持久记录 applied 后才显示成功。
执行锁使用独占创建；native active.lock 排除跨进程写者。不按 PID 自动清锁。重启看到未完成 intent、损坏记录或遗留执行锁时拒绝继续自动采纳，保留材料供人工核实。
恢复确认若在取得事务对象前失败，直接保留原始错误码并执行清理，不访问空事务 ID；已取得事务后的错误仍保守记录为恢复待确认。
多文件不具全局原子性。完整验证步骤之间失败时，可通过单独恢复预检和新 nonce 明确授权恢复；仅恢复身份、当前字节和原来源上下文均符合已记录步骤的对象。发生部分原生写入、结果未知、外部改动、材料损坏或恢复再次失败时，进入 recovery_required/uncertain 并拒绝自动重试。

## 产品边界

普通文件默认数据流写入保留原对象；不恢复缓存 ACL/SACL/ADS/EA，也不宣称元数据的完整事务性。拒绝链接、多链接、特殊属性、mode 变化、新父目录、远程文件系统。删除保留对象必须同卷。
FlushFileBuffers 与文件 fsync/readback 用于进程崩溃下的保守恢复，不宣称目录 fsync、断电持久性或跨文件原子性。来源中新增非目标对象可能使最终检查失败，失败后仍须按恢复资格判断，不能覆盖外部数据。
不修改 P33 生产 allowlist。旧 T4-B 历史缺证据时保持可查看、不可采纳。T3 评论和 T4-A 任务合同不变。采纳后旧评论可变 stale，不能用其启动新任务。

## UI 与接线

原候选弹窗依次展示准备采纳、来源与完整文件范围、确认采纳、已验证数量和事务 ID；恢复是另一轮明确授权。迟到响应按原 epoch/owner 丢弃。真实 Diff、原审批、Stop、Specs 和 Browser 原生遮挡机制复用。
固定 HTTP 动作为 adoption-prepare / adoption-confirm / adoption-cancel / adoption-recovery-prepare / adoption-recovery-confirm；拒绝额外目标字段及 force 动作。C1 内部只读检查保留，旧只读 HTTP action 不再暴露。

验证、剩余缺口及回滚见 [验收记录](T4-C-acceptance.md)。单 Coding Agent，独立功能与安全验收待外部完成。

---

## C1 历史设计记录

### 原 C1 设计

基线：`6db4159f69630f8f33b1dbaa1a073d8612d90af0`（包含已合并 T4-B）。
开发分支：`codex/t4-c-safe-apply`，独立 Worktree；不跟随 v0.28.0 发布分支。

## 勘察结论

本次采用任务第十五节允许的拆分：**C1 可信材料和只读冲突检查；C2 写入与恢复阻塞**。
只读检查通过不等于可采纳，不签发写入 nonce，不显示确认采纳按钮，也不宣称完整 T4-C 完成。
这是以下已存在的技术缺口决定的，不是用风险提示替代安全保证。

1. `server/session-revert-writer.js` 的末次检查后直接 `rename(stage, absolute)`。
   其 `capabilities` 明确 `exclusive:false`、`residualRacePossible:true`、
   `directoryFsync:false`、`powerLossAtomic:false`。现有
   `tests/session-revert-writer.cjs` 的 `independent child final-window D lost and absent from C backup`
   会在独立子进程写入 D 后覆盖成 R，原 C 恢复材料也不包含 D。
   T4-C 禁止静默丢失用户新修改，不能复用该 limited writer 作为合格后端。
2. `server/session-revert-object-writer.js::openOriginalAttempt` 与
   `server/session-revert-object-service.js::createSessionRevertObjectService` 的所有生产动作均拒绝
   `production_allowlist_empty`。未导出的隔离研究实现不是生产 API，不得通过测试导出或环境开关启用。
3. 原对象研究针对单个已存在文件，不能直接提供新增/删除/父目录变化的多文件提交和崩溃恢复合同。
   普通 Node 文件句柄和 GUI admission 不能排除其他同用户进程或 Git 写者。
   重新检查、备份和事后 digest 无法修复已被覆盖但未观察到的 D。

## T4-B 实际材料

`server/candidate-runs.js` 在内存中保存来源 `source`、候选 `pre/latest`、工具 begin/end 和未知原因。
执行线关闭并确认清理后读取 post，再计算真实 Diff；completed 与 reliable 分开。
这些判定和限制全部保留，不改变 T4-B 成功标准。

`server/candidate-store.js` 的 v1 JSON 保存 run、编码后的候选 pre（原字节、HEAD、逻辑 index、
root/admin/common 和文件身份）及 result。result 只有有界 patch、文件统计、inputId/outputId 和可靠性。
post 原字节、post 文件身份、原 source 文件身份没有持久保存；原 source 在候选输入落地后不等于 pre 的身份。
读取旧记录时还将 input 正文丢弃。不能从 patch/HTML/Agent 总结恢复缺失原字节或原始身份。

旧记录继续查看 T4-B Diff，但缺少新证据时只读检查明确返回“该候选结果暂不支持安全采纳”。
不为旧记录事后补造身份，也不重新认领已替换的 Worktree。

## C1 数据合同和复用

沿用原候选私有存储、24 MiB/记录和 20 条记录上限；不创建第二套 Worktree Registry。
新记录增加可选 `adoptionEvidence`（最多 1 MiB），独立 version 和摘要，绑定 run ID、sourceScope、
Worktree ID/epoch/分支、可靠性和未确认原因、输入/输出 ID、原来源观察、发送前的候选输入观察和清理后的候选输出观察。
观察只含受限文件 path/digest/bytes/mode/permissions/identity、HEAD、完整逻辑 index、
Git config 摘要、root/admin/common 身份、完整目录清单（包括空目录）与 Git 指针身份，不重复保存源码。
文件、目录和 Git 指针另用 BigInt 的 dev/ino/birthtimeNs 字符串避免 Number 舍入。
已有候选对象/父目录被替换、未解释的新空目录和 Git 指针替换会阻止 C1，不能继承 T4-B 的 reliable。
输出字节仍仅在有效候选 Worktree；检查必须从该 Worktree 重新读取原始文件并与完整输出摘要和身份比较。
此扩展不改 T3、T4-A、T4-B result 格式；扩展采集失败或超限只缺少 C1 资格，不改 T4-B 的执行成功判断。
缺失或损坏扩展不能使旧 Diff 变成可靠采纳材料。摘要用于检测材料不一致，不是同权限恶意进程不可伪造的认证签名。

复用 `captureCandidateInput` 的容量、原始读取、路径/链接/Git policy、前后复读；
复用 `worktrees.withWorkspace` 校验登记 ID/epoch、Git inventory、branch、root/admin/common，
复用原 review authority 验证当前完整 owner、generation、原生会话及 scope。
查询仅接受 run ID，目标由后端记录和当前 scope 决定，拒绝客户端 cwd/path/contents/patch。

## 来源冲突与采纳范围

先要求 completed、reliable=true、无 unconfirmedReasons、Diff 未截断且证据完整。
来源必须是同一 sourceScope 和原工作区，不能从候选自身或同仓库另一 Worktree 反向操作。
检查原来源 HEAD、逻辑 index、config、root/admin/common、Git 指针和全部原文件字节/身份/模式。
相同 status 不能代替字节和身份；只刷新 index cache 不等于逻辑 staged 变化。
新增路径占用、删除目标新改动、来源/候选同字节替换、链接和特殊路径均拒绝。
C1 同时比较 Git mode 和 Node 暴露的文件权限位；这不是 Windows ACL、ADS、EA、SACL、
属性或持久性的完整证明，这些未证明项继续阻止 C2，不能因 C1 观察一致而获得写入资格。
C1 进一步保守拒绝任何 ignored 路径（T4-B 没有保存 ignored 正文）；来源 untracked 继续拒绝。
不只检查 delta 目标；来源其他文件变化也使整次计划冲突，不做三方合并。

由完整前后文件清单计算整次新增/修改/删除，重命名拆成删除和新增。
历史 Diff 在原 T4-B 收尾时由候选 pre/post 原字节计算，C1 将它的摘要和输入/输出 ID 同时封装冻结。
检查重新读取全部实际字节、对象身份，并核对历史 Diff 摘要；不为只读检查再创建 Diff 临时文件，
也不将渲染 patch 当作可信写入材料。文件计划直接由实际文件摘要/模式的差集计算。
预检展示 run、来源、分支、输入/输出 ID、文件清单和 staged/working 数量；
原 index 永远不写，未来 C2 也应只写 working tree。

## 生命周期、权限与只读界面

C1 成功返回当次观察 `checked_readonly` 和 `canApply:false`；拒绝用固定错误 code 区分资格阻塞与冲突。
不持久修改 T4-B run 的 completed，不伪造 applying/applied/recovered 等未发生的状态。
同一个已确认候选可重复只读检查；没有 apply、recover、force、Git add、commit 或 Agent 调用。
复用既有 busy 判据（Runtime、Planner、Verifier、Stop、工具 Scheduler、mutation admission），
检查前和所有异步读取后复核 scope 与 busy。同实例并行检查只允许一个，拒绝未知执行线。
遗留跨实例 writer.lock 阻止检查，不猜 PID 破锁。

在候选弹窗保留真实 Diff，新增“检查采纳条件（只读）”。检查界面显示范围、冲突或阻塞原因，
明确“尚未采纳，源文件和暂存区未修改”。无写入后端时不生成 nonce、不呈现“确认采纳”。
返回 Diff/取消仅结束显示；会话切换、关闭、重开用原 epoch/isCurrent 生命周期丢弃迟到响应。
沿用模态 native Browser 遮挡，不新增权限或 Diff 渲染器。

## C2 必须解决的写入和恢复合同

生产实现前需要可用的受控写入 provider，证明每个目标的原对象/父目录在最后一次检查与写入间不会被替换或修改，
或安全拒绝所有无法保证的目标类型。不能把未解决竞态转成用户默认承担的确认选项。
需定义新增 no-replace、删除保留对象、多文件锁顺序、同卷受保护恢复区、ACL/ADS/EA/SACL 支持范围。

确认前只读，确认时重新验证完整 owner/generation、TTL 单次 nonce、计划摘要、全体 source/output、
Registry、admission、Stop/工具/Verifier/Planner 互斥和 OS 写权限。
第一次写入前持久化并验证事务 ID、用户确认计划、原始字节/原对象、候选字节、全体身份和逐步 intent。
每步实际读回 bytes/identity，全部文件与未变 index 验证通过且完成记录持久确认后才报成功。
多个普通文件操作不具全局原子性；目录 flush/断电持久性不支持时明确拒绝相应资格。

崩溃重启从 durable intent 保守进入 recovery_required，绝不自动继续 apply。
只有可以证明本事务仍占有目标、且内容/元数据精确对应已记录步骤，新的明确恢复授权才允许回写。
外部 D、损坏材料、未知对象/写入阶段或恢复再次失败时停止、保留全部材料、标记人工恢复，禁止重试覆盖。
不以 digest 相同推断写入未发生或持久完成，不以 PID/文件名推断可删除材料。

## 实施与验证计划

- [x] 先补临时 Git 回归：来源三层状态、内容/身份/Git 漂移、候选重新读取与旧材料兼容。
- [x] 实现有界观察/可选证据/只读检查；原结果成功判定与存储 v1 保持兼容。
- [x] 原认证路由及候选 UI 接线；无写入口或 nonce，拒绝原因固定、无源码错误输出。
- [x] 定向测试 → 正常沙箱 Electron 四档窗口/分屏/重启 → 行为冻结 canonical。
- [x] 离线 App/SEA 构建及资源检查，验收记录明确 C1 范围、C2 阻塞和未运行的写入故障矩阵。

不启动子 Agent。作者自审不代替独立功能、安全和故障审查；不 push/PR/合并/tag/发布。
