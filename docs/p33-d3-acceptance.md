# P33-D3：持久化单文件恢复服务与异常恢复验收

日期：2026-10-13 至 2026-10-14。阶段授权：本轮用户提供的 P33-D3 指令，仅后端隔离开发；没有批准生产 Q1/Q2/Q3，没有批准 D4、提交、推送或发版。

后续授权：2026-10-14 用户在验收交付后明确要求“提交”，仅授权本次 D3 改动的本地 Git 提交。未授权推送、发版或扩大生产能力；按后端代码、测试与 canonical 入口、验收文档三个回滚边界分别提交。

**验收状态：已满足本轮授权的 D3 后端隔离实现与验证条件，等待人工验收。** 最新冻结源码完整 canonical 退出0，离线重建与 packaged 检查通过；生产 B 仍关闭。本文不将状态字符串、Mock 数量或本机跳过的 SACL 用例当作生产资格。

## 1. 开发前后 HEAD 与发布基线

开发前与代码验证交付时 HEAD 均为 `f6d476474b76d1579dd221c9ab86ea352be688eb`，分支 main；该时点修改尚未提交。这个 HEAD 已包含 D2 严格 CI 补证的独立文档提交。D2 实际产品源码基线是 `672b3edbaf6aab2b81d1a34e9bf223d2e518e312`。后续用户授权的 D3 本地提交见 Git 历史，不改变这里记录的测试基线。

授权后的本地代码提交为 `bb1c6a1`，测试与 canonical 入口提交为 `a34d24c`；本文另作独立验收文档提交。提交前重新核验冻结源码哈希、完整测试退出记录和 diff，未改代码、未再次扩大验证范围。

本地 v0.24.0 仍为 `ec546d5a3711a21d2dbc911d661eb52742774be0`，package 版本仍为 0.24.0。本轮没有联网更新远端状态，也没有修改 tag/发布资产。既有未跟踪 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/` 未处理。

## 2. 实际修改文件

- 新增 `server/session-revert-object-service.js`、`session-revert-object-routes.js`：独立服务编排和固定关闭的未来路由结构。
- 新增 `server/session-revert-object-contract.js`：版本化计划、scope、ref 和元数据观测契约。
- 新增 `server/session-revert-object-recovery-reader.js`、`session-revert-object-material-reader.js`：独立只读日志前缀与材料校验。
- 修改 `server/session-change-store.js`：受信任 capability 专用 B API、持久状态转换、日志读回、额度和重启分类。
- 修改 `server/session-revert-service.js`：仅增加 A/B plan 拒绝及 A 列表过滤；原 `metadataCheck` 与 A writer 不变。
- 新增 `tests/fixtures/session-revert-object-service-harness.cjs`、三个 `tests/session-revert-object-{store,service,recovery}.cjs` 套件。
- 修改 `package.json`：原 test 命令全部保留，加入三个新套件；新增本文。

没有修改 public、server.js 组合根、D1 profile/observer、D2 writer/helper、Git restore、资源清单或权限策略；没有新增依赖。

## 3. 新服务架构与可执行边界

正式导出 `createSessionRevertObjectService()` 忽略开关、配置和注入，六个业务方法都固定拒绝 `production_allowlist_empty`。未来 object 路由也自行构造关闭的服务，不接受调用者传入可执行 service，不在 server.js 注册。

真正的 `createObjectServiceCore` 不导出。只有仓库 TEMP harness 将已审阅源码的相对 import 固定到当前 checkout，并在内存 data URL 添加私有测试 export。harness 自己新建 TEMP 项目，持有 root 集合和 WeakSet capability；Store 与 native authority 均绑定该 root 与完整 owner。没有 env、renderer、HTTP、普通用户配置或 production allowlist 入口。

D3 调用 D2 的原 `createIsolatedWriter`。harness 在执行前核对 helper 字节；服务核对 Ready 的实际 hash、C digest、对象 ID 和 attempt 绑定。D2 Native 代码、权限 mask 和协议未变。

## 4. 持久状态机

| 转换 | 条件及含义 |
|---|---|
| 创建 → prepared | 内容/profile 通过，实际 C/R 可读取，refs/owner/预算有效；尚未发 commit |
| prepared → replacing | Native Ready；固定 request/attempt/binding；intent 已 fsync 且读回核验 |
| replacing → applied_verified | Native verified、进程收束、实际 R/对象/元数据后验，并持久完成日志 |
| prepared → not_applied | 取消、TTL、重启、提交前拒绝；本功能没有开始正文写入 |
| replacing → recovery_required | 不确定返回、失败、协议异常、后验失败或重启；禁止重放 |

B 的 replacing 是原对象写入 intent，不是 rename/replacement。B 记录使用独立 `object_apply_v1 / plan` 事件。所有终态不能通过更新改成别的 provider/动作；成功恢复仅派生“祖先异常已处理”，旧失败记录和备份仍保留。

## 5. Prepare 完整检查

服务从可信 authority 取得路径与完整九字段 runtimeOwner，不接收客户端路径、字节或任意 refs。复核 workspace/epoch/fingerprint/session/generation 和 revision/gap；只允许一个既有单链接普通文件，settled `intent_verified` 且新 objectEvidenceVersion=1，拒绝缺失、新建、删除、rename、多文件、跨 owner、已消费及 attributionGap。

正常 R 由真正的 P33.3 worker 逆合并计算，要求 `candidate/contentEligible/replace`。实际测试中 Agent 行 `agent` 恢复为 `base`，用户独立的 `user-new` 保留。C/R 均 ≤2 MiB；UTF-8/BOM/换行不由服务重新编码，diff 仅展示且超预算整体拒绝。

成功恢复后同一文件的新 Agent 操作是新的证据区间：完整历史仍传给 P33.3；服务的 consumed/owner/D1 资格检查覆盖最早 selected sequence 及之后的相关历史，避免旧已消费记录误拒新操作，同时仍拒绝后续跨 owner 修改。当前及 fresh 观测绑定本次证据的 operationId，异常文件封锁不按这个历史区间缩减。真实 TEMP 新回归先复现 `incomplete_evidence`，再验证二次原对象恢复及跨 owner 拒绝。

只读真实 TEMP 反例证明：Node 能创建 `file.txt` 与 `file.txt.` 两个不同对象，Win32 观测后者却可能落到前者；内容相同不能区分它们。D3 因此拒绝每个路径组件尾随点/空格及 DOS 设备别名，且用 BigInt 卷号/文件 ID 比较 Node 打开的句柄与 Win32 观测，读后再次比较句柄/名字身份。修补前尾随点准入反例实际 RED；同字节双对象的正确/错误观测匹配成为新回归。没有修改 D2 helper。第一次115命令回归退出0、2171.276秒；这项修补后另外运行最终完整链，以最新源码为验收依据。

D1 `evaluateObjectProfile` 所有负向规则原样执行。只有其最终仍为 `production_allowlist_empty` 的 TEMP 观测，才经过另外的可信测试资格函数；函数不将 SACL unknown 改为 known/supported，不允许其他拒绝原因变成通过。

## 6. C/R 备份、实际分配与预算

复用内容寻址私有对象库。restorePut 包含 fsync；再 restoreRead、descriptor 验证注册 owner、无链接/单链接、实际身份、长度、digest 和私有权限。返回 backupReady 前再观察当前 C、对象及元数据，并复核 revision。字节对象去重不免除重新读回。

已有默认 allocationProbe 实测分配，charge 取逻辑/实际分配保守值；Store 单元测试的 4096-byte 分配与 privacy 为明确注入，不能当作实测 ACL。服务另外预留 262144 字节材料逻辑额度；Store 每个 B plan 独立预留 262144 字节 journal 逻辑额度，所有 A/capture/其他 workspace 追加都尊重现有预留。日志按保守最大序列化行长收费，避免额度十进制位数改变使日志与内存计划不一致。

相关 refs 由 backup/plan 集合 pin；正常 GC 不删除 uncertain 代际。重启对未解决计划保守重建日志额度，近容量上限时正常写入关闭，材料仍保留供只读读取。**这些是应用逻辑配额，不是 OS 空间预分配，更不保证磁盘不会 ENOSPC/EIO。**

记录 replacing 之前还检查实际 intent envelope 加上有界最坏 completion envelope（完整 consumed IDs、最多64 KiB Native JSON 测量的双层转义余量及4096字节余量）。无法同时容纳时，intent 不追加、plan 仍 prepared，Native 不 commit。新增128条完整记录/每条256字符ID的大合法计划实测拒绝这一边界，日志保持不变。

## 7. Ready → Intent → Commit 顺序

Native Ready 持有原对象及父链句柄并复核 C、可观测元数据和私有 C/R。服务在 Ready 后再次 revalidate/检查 revision，创建 intent：attemptId、bindingDigest、helperHash、requestId、C digest/对象 ID、确认时间和实际 journalRevision。

Store 的 objectUpdate CAS 在队列内执行；append/fsync 后有界读回完整哈希链与最后一条计划、文件和名字身份，成功返回后服务再次检查 authority/revision/额度，才调用 attempt.commit。新测试在真正 Win32 commit 前直接读取 journal，核对最后状态 replacing 和实际 attempt/binding。

Native 协议的 `intentRevision=1` 是每次新 attempt 的协议序号，明确与真实 journalRevision 分开；没有把日志 revision 随意塞进 D2 协议。intent 追加或读回失败时零 commit，取消/等待 helper 收束。

## 8. 成功后的验证

必须同时满足 D2 `verified`、实际 process close、R digest/长度、原对象 ID、metadataEqual=true、额外当前文件实际读回及可观测元数据一致。随后 CAS 持久 `applied_verified` 才返回成功，并消费原 undo 的 selected 操作。

目标等于 R 不足以成功：真实 Native 已写 R、但 pipe result 被故障适配器损坏时，服务持久 recovery_required。Native 后完成日志部分写入的实测，即使 R 完全正确也不返回成功。

## 9. 失败状态、资源与材料

提交前资格/当前 D/身份/预算拒绝不写正文；关闭服务等待进行中的 prepare，不允许随后新返回 token/保留 lease。TTL/cancel 持久 not_applied。Apply 的 admission pin 直到 helper 实际 close；并发重复请求共享原 task，等待授权期间 task 已完成也不会重新获取失效 map 项。不同 request/token 不能复用原 commit。

intent 后所有不确定性走 recovery_required，无自动 retry、rollback 或写 C。日志还能写时实际持久异常；日志损坏/不可写时返回 `durable:false`，有效前缀中的旧 intent 是 durable 证据，不能伪称失败尾记录已保存。正常重启未完成 intent 追加 recovery_required；损坏账本不被修复。

失败封锁按物理 workspace fingerprint、Windows 路径大小写与文件 ID 执行，跨 epoch/generation/session 不能绕过。不同已知根 fingerprint 可以隔离；未知时保守阻塞。当前 ledger 健康时只阻塞异常文件，不永久持有 workspace admission；ledger 不健康时证据服务整体拒绝写，不阻塞聊天/其他功能。

## 10. Journal 尾部损坏

服务测试在持久 replacing 后，向真实 journal 写入半条完成记录并 fsync，随后模拟 EIO。正常 Store 重新打开实际拒绝 `evidence_integrity_failed`，不截断、不重建账本。独立 Reader 找到原合法 intent 前缀，可以读回 C/R；测试向 TEMP 中两个全新 `wx` 文件显式导出，逐字节比对，并检查 journal bytes/mtime 完全不变。

另有缺失/损坏对象、缺少合法前缀、非法 owner/ref/namespace/revision/转移等负向测试；不能依据坏尾中的 plan/ref 查询材料。

最新 canonical 的保留材料另作只读复核：3个独立 TEMP 根、5个计划、10份 C/R 引用均实际读回并核对 digest/长度，journal bytes/mtime 不变。两次失败计划为 recovery_required；坏尾计划只能从前缀读到 replacing；真实 Native 异常和重新确认恢复的两代记录分别为 recovery_required / applied_verified。后两代使用真实 Windows 私有 ACL 核查；前三代明确使用测试 privacy DI，不算 ACL 资格。结果保存在 `.probe/p33-d3-retained-verified.json`；失败根与材料未删除。

## 11. Recovery Reader 授权与完整性

Reader 默认拒绝 authorize。可信调用者须授权精确 plan/历史 owner；Reader 仍强制完整 owner、persistent scope、备份登记、版本化 B namespace、plan/event revision、合法转移及不可变字段一致。旧 A 事件允许共存，却不能作为没有完整 owner 的 B 材料资格。

只采用完整 LF、UTF-8、envelope/previous/hash/body 验证成功的前缀。默认 journal≤32 MiB、事件≤20000、单事件≤1 MiB、节点≤20000/事件、深度≤16、每对象≤2 MiB、总材料≤4 MiB、deadline≤30秒；预算只能收紧。读材料反复检查祖先、root/child 私有 ACL、handle/name 身份、长度/digest。

返回 `readOnly:true / applyEligible:false`。没有写句柄、没有 journal 修复、没有自动创建计划；Node/ACL 多点观测不是 OS 原子路径与 ACL 快照。实际 Store 新事件、reserve 递减与合法重启重建额度的链条都单独核对。同一持久 scope 下的新 generation 可以重新登记相同 digest；ref 索引仍按完整 owner 分开，既不误报合法链损坏，也不允许借用旧 owner 的材料。

## 12. D→C 新计划与第二次确认

从授权的 recovery_required source 沿 ≤16 个合法同对象代际找到原始 C。观察当前 D、确认同对象/内容/profile/元数据资格，把 D 持久保存并读回，再读原始 C。创建新的 sourcePlanId、refs、revision、token 和确认；不复用旧 token，也不将旧失败计划改成成功。

实测两次模拟失败保存 C/R、第一次 D/第二次 D，均可重开读取。真实 Native 协议异常后的外部新 D，也通过新确认真实恢复至原 C，D 仍在备份中；成功仅解除完整已解决祖先链封锁，独立失败分支不解除。

旧 generation 的 apply token 失效。跨真实应用重启/new backend owner 的产品授权移交尚属 D4 接线范围；当前 isolated Store 重开保留原 owner。独立 Reader 只能在可信历史授权下导出原材料，不因此赋予新 generation 写入资格。不能把本轮同 owner 的重开测试当作真实产品全部重启流程已交付。

## 13. A/B provider 隔离

A authorizedPlan 拒绝 provider 字段或 write_original，列表滤掉 B。Legacy applyCreate 原拒绝仍在；applyUpdate 拒绝 B。B object API 需要服务端函数验证 capability，默认拒绝；B 拒绝 A、旧 unknown、缺失/不完整 D1 证据，provider/profile/proof/helper/refs/文件类型不可变。

原 A `metadataCheck` 从 HEAD 提取逐字比较相同，`metadata_audit_unavailable` 不变，A writer 文件未修改。Git restore 没有改动，没有 silent fallback。正式 object HTTP 测试传 approved、测试 proof、任意路径/DI 都是固定403拒绝。

## 14. P32 authority、Stop/drain

直接复用 `createSessionRevertMutationAuthority` 与 admission：先解析并释放生命周期 authority，再 Stop/drain 已知 writer，重新获取完整 scope 并 revalidate。测试 harness 对 Stop 时 authorityActive=false 作运行时断言，覆盖 Stop 失败、generation 变化、并发 apply/dispose 和 admission 释放。

现有组合根的 planner/CLI busy、managed process cleanupConfirmed、同 root runtime abort/drain 拒绝不变，本轮没有接入 B 绕过这些门槛。真实 classic/managed product 接线、多 runtime 及 packaged Native 服务闭环留在 D4；本轮相应 P32 原有 canonical 回归需实际全部执行。

## 15. 旧客户端与旧证据

B 使用新事件 `object_apply_v1`，旧 v0.24.0 Store 在读取阶段遇到未知事件失败关闭，不自动将 prepared B 修成旧 A 状态。测试实际用 git show 提取 v0.24.0 Store 源码在内存加载，打开新 B 账本拒绝，journal 字节/mtime 不变。没有修改旧 tag。

新的 Store 与 Reader 都明确拒绝旧 `apply` 中伪装的 B 草稿和未知 schema；旧 evidence 查询仍兼容 A/D1，只不升级成 B 资格。B 原型账本仅在测试新建 TEMP，正式用户账本没有本轮 B mutation。

## 16. 测试结果与分层

最新冻结源码 `npm test` 完整115命令退出0，耗时2249.2639376秒（37分29秒）。26个 P33 相关套件752/752，失败0；权限跳过18项独立列明，不进入分子分母。新增 D3 三套件合计119/119：

| 套件 | 本轮结果 | 分层 |
|---|---|---|
| Object Store | 38/38，失败0、跳过0 | 真 TEMP 持久文件；privacy/allocation 与观测为明确注入；真实 v0.24.0 源码降级拒绝 |
| Object Service | 30/30，失败0、跳过0 | 真 Windows helper 正常/协议异常/新确认恢复；真实日志损坏/导出；路径/同字节不同对象及再次恢复；标明模拟/DI 的故障 |
| Recovery Reader | 51/51，失败0、跳过0 | 真文件系统、两组真 Windows ACL、实际 Store 链及新 generation 登记；其他权限失败为注入 |

| 既有套件 | 本轮实际结果 | 边界 |
|---|---|---|
| P33.2 Store / Bridge / Tools | 36/36、24/24、31/31 | 持久 TEMP、fixture 工具边界 |
| P33.3 逆合并 / worker integration | 67/67、19/19 | 真算法与 worker；不代表 Agent 归因已全面覆盖 |
| A restore Store / HTTP / writer | 14/14、65/65、22/22 | 原 provider 回归 |
| A recovery / admission / apply | 24/24、15/15、29/29 | apply 为 fixture metadata，不能充当 Win32 元数据资格 |
| Windows faults / 原位 / 原位 safety | 13/13、28/28、43/43 | Win32、故障注入及研究；原位另跳过2个 SACL |
| P33.5a query / UI / startup | 34/34、27/27、11/11 | 只读功能回归；UI fixture 不证明布局，前端未修改 |
| D1 profile / evidence | 55/55、12/12 | 保留 unknown 和生产拒绝 |
| D2 writer / faults | 19/19、45/45 | 同 helper 的真实 Win32 与明确故障注入；D2 状态自身不代替 D3 持久事务 |
| 旧 SACL witness / D2 object witness | 0/0、0/0，各跳过8 | 本机无 SeSecurityPrivilege，不是通过；严格特权 CI 证据见§18 |

原有 P33 已执行检查633/633，没有减少；新增119项。完整链另有既有 Session search 的符号链接5i用例因本机权限无法构造而未验，未将其算通过。所有未通过平台边界仍按§19记录。

本轮完整测试链由112增至115命令，原命令零删除且顺序不变。首次开发前基线在326.860秒遇到既有安全测试端口7797 `EACCES`，退出1；使用该测试已有 SEC_PORT=17897，独立安全测试36/36通过。最终 canonical 使用同覆盖的新端口及新建 TEMP 根；没有关闭原断言。最终日志 `.probe/p33-d3-verified.log`、exit/seconds 和 `.probe/p33-d3-test-summary.json`，冻结 source hashes逐一核验未变；较早中间全链/独立日志保留，不代替最终源码证据。

最后源码冻结后，一次全链启动在26.858秒退出1，既有 `ux-state` 历史工具告警 DOM 断言14/15；此前两次全链该套件通过，未修改源码的独立复跑15/15。测试采用固定280ms会话切换等待，瞬时调度是可能原因，未证明唯一根因；没有修改该测试或产品。失败日志保留为 `.probe/p33-d3-verified-ux-failure.log`，随后重跑完整115命令，以 `.probe/p33-d3-verified.log` 的实际最终结果为验收依据。

WriteFile/EOF/flush 真 Win32 access-denied 注入、实际中途退出/timeout/ADS-DACL-属性外部竞争，来自本轮 canonical 重跑的 D2 faults，同 helper 核心。D3 对 durable 编排的部分覆盖和提交前 EIO 是明确模拟；完成半条日志是真实文件系统故障适配；pipe-result 故障是真实 Native 写 R 后的协议适配。没有将这些故障注入称作自然磁盘故障。

## 17. Source / packaged 范围

Source：独立 TEMP 后端服务执行真正 P33.3 worker、D1 observation 和 D2 Win32 writer。没有真实 Pi/model→GUI B 点击闭环。

`npm run build:app -- --rebuild` 使用本地 Electron 44.4.3 zip 离线完成，退出0，12.531秒，应用整包328.0 MB。`node tests/app-check.cjs` 在新 TEMP、fixture Pi 下26/26通过，退出0，11.736秒；验证内嵌后端、RPC ready、静态页面、无 node_modules 的 PDF/docx/image 上传、数据目录隔离及无项目拒绝。首次19/21失败是新 TEMP 缺少 PDF 固件，保留失败日志，执行既有 `npm run fixtures` 后重跑全部检查，没有删断言。

打包的 observer/write helper hash 分别仍为 `230eade3a3611f2340b8ecb3d536b61d2adb88deabc44b44d7c59ec065a2063f` / `7d773b63777d97a6a78d9a81c37cf946929062b22028425889258becd3aa39ef`，与源码一致。额外检查实际 server.cjs：包含新的 `object_apply_v1` Store 支持，不包含私有 service/routes/Reader 执行图。不能因 rebuild 就声称 packaged B 服务已接通。打包只验证现有产品和 A/D1 边界、资源完整性及关闭状态；不扩大 D4 运行范围。

## 18. 生产仍关闭与 SACL 证据复用

PRODUCTION_OBJECT_ALLOWLIST 仍空，正式 writer `openOriginalAttempt` 仍固定拒绝，GUI 没有 B apply。测试 authority/私有 core 没有成为生产 export或 HTTP 依赖。

helper SHA-256 仍为 `7d773b63777d97a6a78d9a81c37cf946929062b22028425889258becd3aa39ef`，API/mask/实现未变。复核已缓存严格 CI run38383762389/job115250354430：Windows Server2025/10.0.26100.0/NTFS，目标源码672b3ed，8组8/8失败0跳过0，每格C→R→reopened持久C、两轮17项全true。详见 [D2 §11](p33-d2-acceptance.md#11-后续授权的特权-ci-八组补证)。本轮不重复已通过的特权八组，也没有获取新权限。当前普通令牌 SACL 不可读仍记 unavailable/null；本机 skip 不算认证。

## 19. 未验证的平台及残余风险

首版讨论范围仍是已验证本地 Windows x64/NTFS、新 D1 profile、既有单链接普通 UTF-8、≤2 MiB、无 ADS/可靠空 EA、已验证四属性组合。OS26100 特权与 OS26200 普通证据不是每个OS/补丁/令牌全面配对；POSIX、网络文件系统、特殊 ACL/SACL/MIC、自然 ENOSPC/EIO/断电、长时 soak 未认证。

原位 WriteFile/EOF 不是整文件原子操作；崩溃可以部分覆盖，未采到的新外部 D/未保存编辑缓冲可以丢失。备份仅覆盖已读回的 C/R/各 D 正文字节；不承诺重建完整安全元数据、ADS、EA或时间。外部 ACL/SACL/属性并发变化无法完全排除；unknown 保持 unknown。完成后的外部修改也可能发生，后验只是有限观测。

## 20. 验收结论与停止点

**满足本轮 D3 验收条件，建议人工验收这个后端隔离交付。** 最新源码的持久 intent、真实 Native 编排、持久异常、坏账本合法前缀材料读取、新 D 新计划/确认、A/B 隔离及旧版失败关闭均有对应实测；完整 canonical 与离线 packaged 检查通过。没有发现要求停止本轮实现的 intent 顺序、前缀完整性或测试能力泄漏阻塞。

这不是生产风险契约批准或 D4 完成。生产 allowlist/正式服务/writer 仍关闭，GUI 无 B apply；实际产品重启历史 owner 授权移交、真实 Pi→GUI→确认→恢复、classic/managed 多 runtime 及 packaged B 闭环仍未交付，见§12/14/17。阶段完成时停止且未自动提交；后续仅执行用户明确授权的本地提交，不推送、发版或进入 D4，等待人工验收和下一阶段独立授权。

特别问题：intent 成功读回前没有 commit；部分覆盖后 C/R 仍可从持久对象读回；坏 journal 只允许授权合法前缀材料导出；新 D 没有自动覆盖；重复同 request 没有第二个 commit；A 不执行 B；普通 HTTP/GUI 无 B capability；持久 recovery_required 经 Store 重开核对，而非只打印状态字符串。坏尾无法持久追加时明确 durable:false，保留旧 durable intent。
