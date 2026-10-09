# P33.4：受限会话恢复实现与验收记录

日期：2026-10-09。阶段：P33.4。**结论：实现与回归验证已交付，但尚不满足 P33.4 整体验收条件。** 当前 Windows 进程没有可启用的 `SeSecurityPrivilege`，无法确认完整 SACL；生产元数据适配器拒绝 `metadata_audit_unavailable`。未完成真正符合该元数据契约的生产 writeback→R→再次确认恢复 C，不以 fixture 成功代替此门槛，不进入 P33.5。

本文中的“确认事实”来自本次源代码、执行结果；“边界”说明已知实现限制；“未验证”不是通过，也不是被计入通过数量的跳过用例。

## 1. 开发前后 HEAD、工作区与执行前检查

- 开发前后 HEAD 均为 `02cee312249a8e75566543abf586e9d6b4382119`，分支 `main`；没有提交、推送、合并、版本变更或发版。
- 初始工作区只有既有未跟踪 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`；未读取其用户材料、未清理它。交付工作区包含本阶段代码、测试和文档变更，等待人工审阅。
- 已阅读 AGENTS、README、P33.1a/P33.2/P33.3 报告及指定实际代码。遵守项目不联网规定，没有 fetch 或查询外部文档，没有依赖变更或 Pi 安装包修改。
- 最初启动的基线测试在运行期间发生并行开发，且在 Stop VM fixture 缺少新增组合根导入时失败，**不能称为干净 HEAD 的完整基线**。之后补齐该 fixture 的实际形状，不删除旧断言；最终完整测试退出 0。
- P33.3 实际契约仍为 `status/contentEligible/candidate/action` 的私有 Buffer 计算结果；HTTP 只读摘要另有严格/受限资格，始终 `backupReady:false`。没有把此前候选当成授权计划。位置：`lib/session-revert.js:8`、`server/session-revert-routes.js:23`、`:233`。
- 既有 Stop 和 authority 是 GUI 生命周期能力，不能排除外部写入。新增 gate 复用实际 workspace 根、默认工具 I/O 与既有 Stop；不是 OS 锁。位置：`server/session-revert-authority.js:63`、`server.js:893`。
- 旧 P33.2 证据只有完整内容、没有完整历史元数据；本次新增 before/after 元数据，旧记录 null 保留。位置：`server/session-change-store.js:217`、`:433`；验证：`tests/session-revert-recovery.cjs:49`。

## 2. 修改与新增文件

新增：

- `server/session-revert-writer.js`、`server/session-revert-metadata.js`、`server/session-revert-service.js`、`server/session-revert-admission.js`。
- `tests/session-revert-writer.cjs`、`tests/session-revert-recovery.cjs`、`tests/session-revert-admission.cjs`、`tests/session-revert-apply.cjs`。
- `docs/p33-4-implementation-plan.md`、本报告。

修改：`server/session-change-store.js`、`server/session-change-bridge.js`、`server/session-revert-authority.js`、`server/session-revert-routes.js`、`server/session-runtime.js`、`server/process-bridge.js`、`server/git-routes.js`、`server.js`、`extensions/pi-gui-revert/index.js`、`lib/session-revert.js`、`public/api.js`、`package.json`；测试为 `gui-browser-stop.cjs`、`stop-barrier.cjs`、`session-change-tools.cjs`、`session-revert.cjs`、`session-revert-http.cjs`、`session-change-live.cjs`、`session-change-rpc.cjs`。

没有完整恢复 UI。`public/api.js:106` 仅提供协议调用 helper。新增四个 fixture 套件已接入唯一测试入口 `package.json` 的 `test`。

## 3. BoundedWriter

`server/session-revert-writer.js:20` 提供 inspect/apply/ensureRecoveryRoot。inspect 限制相对路径、普通单硬链接文件、2 MiB；检查 descriptor 与路径身份、父目录至卷根的身份和链接，有限长度读取后重新检查。当前位置：`:13`、`:31`、`:38`。

已有文件恢复使用目标同目录唯一 `wx` 临时文件：先设置已捕获安全描述符，再写 R、fsync、重设写入可能改变的属性、再次 fsync，独立回读字节与元数据。提交前重读 C，检查 authority/revision/父目录/源文件身份，先记录 replacing 意图，再使用 Node Windows rename 替换；之后独立读取验证 R。没有 truncate 原文件、unlink+rename、直接覆盖或 rename 失败降级。位置：`:54`、`:75`、`:105`、`:121`。

失败在提交前仅清理已核对身份的 staging 文件；进入提交后返回 recovery_required，不无条件恢复 C。边界：`fs.rename` 的普通文件系统语义不是 compare-and-swap；最后校验与提交之间仍有竞争。

## 4. Windows 替换与元数据契约

生产 profile 为 `windows-local-ntfs-v1`。仅本地固定 NTFS 卷；拒绝 UNC、其他平台/文件系统、链接、多硬链接、未知属性、readonly、ADS 和非零/无法确定 NTFS EA。支持的属性掩码仅 Hidden/Archive/Normal/NotContentIndexed。完整元数据包含 owner/group/DACL/SACL 的 SDDL、属性和卷身份；时间戳会因恢复操作变化，不宣称保留历史文件 ID 或全部时间信息。位置：`server/session-revert-metadata.js:29`、`:33`、`:48`、`:57`。

辅助进程仅尝试启用**已分配**的审计权限，没有提升权限或更改系统策略。无法启用时明确拒绝，不将未知 SACL 当成空 SACL、不按 DACL-only 偷换契约。本机实际探测：`native profile: metadata_audit_unavailable`。普通代码文件的完整元数据写回仍需在具有该权限的真实 Windows 环境重新验证；这不是已解决的覆盖率问题。

Native `MoveFileExW(flags=0)` 用于新文件移走/移回，禁止覆盖目标、禁止跨卷 copy fallback。已有文件替换与 native move 均有真实临时文件系统测试，但**完整元数据的替换成功未被生产适配器验证**。位置：`server/session-revert-metadata.js:63`；native 无覆盖 move 成功/目标已存在拒绝见 `tests/session-revert-writer.cjs`。

## 5. prepare/apply/cancel/recovery/export API

沿用 router 认证、Origin 和 P32 authority。所有以下接口仅 POST，16 KiB 请求上限、闭合字段；不接收绝对路径。位置：`server/session-revert-routes.js:105`、`:110`。

| 接口 | 主要输入与结果 |
|---|---|
| `/api/session-revert/prepare` | owner/conversation、evidenceIds、selectedFileIds、mode、evidenceRevision；重新计算资格、备份 C/R，返回 planId、一次 token、到期时间、revision、固定文件清单、限定 C→R diff、backupReady、riskNotice |
| `/api/session-revert/apply` | planId/requestId/token、原 mode/文件集合、逐次 confirmation；返回整体 completion 与逐文件 state/reason，隐藏私有路径、对象引用与正文 |
| `/api/session-revert/cancel` | planId；未应用计划取消并释放 gate，不修改目标文件 |
| `/api/session-revert/recover-preview` | 无 sourcePlanId 时只列当前授权范围计划；指定来源和文件时比较当前 D、备份 C、原候选 R，返回 observedMatches、uncertainHistory、needsPrepare；始终 backupReady=false |
| `/api/session-revert/export` | 明确 sourcePlanId/fileId/exportName；返回该备份的下载附件，basename 白名单；不支持指定服务器任意落盘绝对路径 |

API 是本阶段后端交付，正式保存位置选择与确认界面属于 P33.5；export 明确下载请求而非后台主动导出。默认摘要、结果与恢复列表没有正文。prepare 是明确选择文件、生成确认差异的内容访问请求，diff 总预算 32 KiB，超限拒绝，不能当作 apply 输入。

确认字段恰为 `riskNoticeVersion:1`、`externalWritersPaused:true`、`lastCheckRaceAccepted:true`，并绑定原 mode 和固定 selectedFileIds。token 32 字节随机值，服务端仅持久保存 hash；计划绑定完整 scope、操作集合、revision/gapRevision、C/R 对象 digest、指纹、备份和风险版本，寿命不超过 60 秒。没有 force、无备份继续或永久授权。位置：`server/session-revert-service.js:46`、`:108`、`:121`、`:138`。

strict 始终返回 exclusive_provider_unavailable。受限模式的确认只承认剩余竞争风险，不升级 observed/incomplete/缺损/attributionGap 证据。备份 C 的恢复是**明确恢复一个历史版本**，必须先备份当前 D，再重新 prepare/确认；不能沿用旧确认 token。

## 6. 持久备份、ApplyJournal 与消费

复用 P33.2 私有内容寻址对象和哈希链 journal。`restorePut/restoreRead` 在同一存储层完成 fsync、回读 digest、权限、配额和 scope 校验；非空备份事件精确增加一次 revision，即使内容去重。位置：`server/session-change-store.js:134`、`:151`、`:194`、`:288`。

ApplyJournal 记录 planId/requestId/scope/mode/files、C/R 引用及 digest、metadata/fingerprint、确认时间/风险版本、逐文件状态、观察后 digest、completion、residualRacePossible。计划字段不可重绑定，状态转换受验证；requestId 在该授权 scope 幂等。位置：`:305`、`:329`。

逐文件状态：prepared→replacing/moving→applied_verified；不确定操作 recovery_required，未执行 not_applied。文件应用验证后只消费其自身 operationIds；私有 snapshot 和算法拒绝重复消费，位置：`server/session-change-store.js:349`、`lib/session-revert.js:104`。

任一目标资格或备份失败，prepare 不产出可确认的子集。apply 提交前预检全部文件；执行中失败停止后续文件，整体 partial/refused/recovery_required，并保留所有备份，不自动回滚已成功文件。位置：`server/session-revert-service.js:153`、`:164`、`:184`；实测三文件结果为 applied_verified/not_applied/not_applied。

## 7. 多会话、Stop 与 mutation admission

物理根 realpath 规范化后的 workspace gate 跨 classic/managed 同根生效，独立 worktree 不共享 gate。先解析并释放生命周期 authority，再关 gate、Stop/drain，再重新进入 authority；避免等 Stop 时占着其 settle 所需锁。位置：`server/session-revert-admission.js:6`、`server/session-revert-authority.js:63`。

默认工具即使关闭采集也要 begin-io/end-io，finally 释放；未知/失联 writer 不靠“文件稳定”清除。prompt/steer/follow_up、process admission、planner/CLI 与 GUI Git 恢复受同根 gate 协调。位置：`extensions/pi-gui-revert/index.js:106`、`server/session-change-bridge.js:120`、`server/session-runtime.js:114`、`server/process-bridge.js:16`、`server/git-routes.js:43`、`server.js:455`、`:893`、`:966`。

计划取消/过期/prepare 异常释放 gate；有效 apply 开始后 pinForApply 禁止 60 秒计时器在 OS 提交期间解锁。前端断连不会取消正在记录日志的 apply。gate 不是外部编辑器锁，不能消除 OS 竞争。旧 owner 立即不能继续授权；已遗留 gate 最迟超时释放。classic 未确认停止的 writer latch 可能需要重启后端，不能擅自清除。

## 8. 异常、并发和残余风险

writer 22/22 包含备份前置、stale C、journal/元数据复制失败、staging 篡改、rename 失败无 unlink fallback、写后 journal 失败、路径越界、hardlink、ADS/readonly、native 无覆盖 move、写后外部 D 检测。

**实测数据损失窗口，不是零损失通过：**独立 Node 子进程在最后校验后把 C=`C` 写成 D=`D`；随后 rename 将其替换为 R=`R`。保存的备份仍只有 `C`，不包含 D。测试明确断言 residualRacePossible=true、exclusive=false。位置：`tests/session-revert-writer.cjs:36`。该测试证明风险存在，不证明排他性。

三文件故障测试在第二个 staging 阶段注入 I/O 失败，第一文件保留已验证 R，其余仍为 C；部分成功后用户新写 D，recover-preview 仅显示 other，不写回。位置：`tests/session-revert-apply.cjs:65`。重复并发 apply 一次提交：`:66`。

用户要求的 45 项中，正常/拒绝/状态故障有组合覆盖，但以下**专门场景尚未全部独立验证**：备份 fsync 的底层定点故障、实际 ENOSPC、native Windows 打开句柄/共享标志竞争、真实跨卷 EXDEV、替换父目录的独立进程、完整继承 ACL/SACL/EA 复制成功、真实电源中断、classic 与 managed 的生产恢复闭环。不能把已有同类 fixture 推论成全部 45 项通过。

## 9. 真实文件恢复、新建文件和隔离

恢复功能不是 export-only：使用真实 Windows 临时文件系统、受控完整元数据 fixture，prepare→确认→同目录 rename→独立读取已恢复 R；有新增文件移走和再次确认移回。**metadata fixture 不等于真实 Windows 完整权限资格**。位置：`tests/session-revert-apply.cjs:13`、`:38`、`:58`、`:59`。

新建文件仅 B=absent 且 C=A，采用同卷私有恢复移动，原有 untracked 走 replace。移走对象放在现有私有证据目录的 recovery 子目录，按 workspace 派生范围；不在项目生成恢复目录、避免出现在 Git Changes；跨卷拒绝，不删除父目录，不覆盖新占用路径。位置：`server/session-change-store.js:404`、`server/session-revert-service.js:171`、`server/session-revert-writer.js:21`；验证：`tests/session-revert-apply.cjs:59`、`:60`。

所有测试写入均在 fresh os.tmpdir 项目；没有对 `C:\pi-GUI` 的用户工程文件执行撤销测试。已有 Git Changes 恢复语义未改，仅共享 admission。没有改 index/ref 的恢复实现。

## 10. B/A/P/C/R 逐字节验证

| 场景 | 实际验证 |
|---|---|
| 用户原有 dirty + 后续独立编辑 | B=`user original\nanchor\ntail\n`、A=`agent\nanchor\ntail\n`、C=`agent\nanchor\nuser later\n`；实际 R=`user original\nanchor\nuser later\n`；备份 C 与原字节 Buffer 相等（apply:38） |
| 原有 untracked / Agent 替换用户内容 | 恢复 B；action=replace，不移动原有 untracked（apply:43） |
| BOM/CRLF/混合换行 | 使用 Buffer 等值断言实际 R；不做换行规范化（apply 套件 BOM 用例；算法 67/67） |
| 同会话三次、其他会话独立区域 | 使用真实持久 journal 和逆序内存候选，写后读取预期内容；同区域冲突拒绝（apply 套件多次/跨会话用例） |
| Agent 创建 | 私有恢复区读取完整 `created`；原路径 absent，再独立确认恢复同字节，工作区没有恢复材料目录（apply:59） |
| 真实 Pi B/A/P→候选 | 真 Pi 默认 write/edit、fixture stream model、生产私有存储与 native 元数据采集；候选 Buffer=预期 R，预览不写文件；prepare 明确元数据拒绝（live:137 起） |

## 11. 备份 C 的恢复和进程重启

已应用计划的备份 C 可通过 recover-preview→新 prepare→新确认→相同 writer 重新恢复。当前 D 先另行备份；新文件原路径被占用拒绝，材料保持。fixture 实测见 `tests/session-revert-apply.cjs:58`、`:60`。

旧计划的历史查询/导出与备份恢复按持久 scope 校验；新的 apply token 仍绑定新 owner，旧 token 不随 runtime generation 自动升级。重开 store 后新 backend/runtime 身份读取备份并重新确认通过，旧 apply 拒绝 stale_runtime。位置：`server/session-revert-service.js:42`、`:202`、`:219`；测试：`tests/session-revert-apply.cjs:61`。

启动重放将 prepared/replacing/moving 计划标为 recovery_required，不重试危险写入。recover-preview 根据当前 D 对照 C/R 返回 preimage/candidate/other/absent，不能仅因 D=R 断言无中间丢失。位置：`server/session-change-store.js:176`、`server/session-revert-service.js:207`。真实子进程在 moving 意图后退出、重新打开 journal/备份验证通过（恢复套件 11/11）。

文件与 journal 调用了 fsync，但没有验证 Windows 父目录 fsync/断电时重命名与日志持久顺序；仅证明进程异常后的恢复材料识别，不宣称断电事务或多文件原子性。

## 12. 完整测试结果

最终 `npm test`：**100 个套件，退出 0**。P33.2/3/4 相关 11 套件合计 **328/328**；失败 0、这些套件跳过 0。

| 套件 | 通过/失败/跳过 |
|---|---|
| P33.2 store / bridge / tools | 35/0/0；23/0/0；30/0/0 |
| P33.3 algorithm / store / HTTP / worker-integration | 67/0/0；14/0/0；65/0/0；19/0/0 |
| P33.4 writer / recovery / admission / apply | 22/0/0；11/0/0；15/0/0；27/0/0 |
| Browser Stop / Stop barrier | 12/0/0；16/0/0 |
| P32 registry / runtime HTTP / scoped Changes | 32/0/0；12/0/0；60/0/0 |
| opt-in 真 Pi 工具分发 | 25/0/0；fixture stream，无联网模型 |
| opt-in source RPC / packaged RPC | 18/0/0；18/0/0 |
| rebuilt app-check / packaged worker | 26/0/0；19/0/0 |

全套日志还有 **1 条明确环境跳过**：`tests/session-search.cjs:318` 的 5i 真文件 symlink 需要权限/开发者模式；未计入通过。其他用例名里的 skipped 是产品状态断言，不是被跳过的测试。

原断言未删：P33.2 tools 从29增至30；算法66增至67；Browser Stop11增至12；Stop barrier15增至16；真实 live23增至25，RPC14增至18。首轮 native C# EA helper 的 int/uint 条件表达式导致编译失败，修为显式 long 后 writer/apply 通过；首轮 RPC 发现恢复列表遗漏 backupReady=false，补齐并复测。旧 Stop VM fixture 补齐实际新增导入，不屏蔽回归。

测试证据日志在本机 TEMP：`pi-gui-p33-4-full.log`、`-writer.log`、`-apply.log`、`-live.log`、`-rpc.log`、`-packaged-rpc.log`、`-packaged-worker.log`、`-app-check.log`、`-build.log`。日志只记测试名称/固定错误及合成 fixture；原始 Pi 工具内容不进入普通产品日志。

## 13. 真实 Pi 与打包验证

执行 `node tests/session-change-live.cjs`：真实已绑定 Pi **1.0.4** 的公开工具分发与生产存储/ACL；25/25，包含默认 write/edit 的 B/A/P、真实模型 fixture stream、候选字节和 native metadata 拒绝。未使用真实付费/网络模型，未修改 Pi 安装包。

执行 `node tests/session-change-rpc.cjs` 和带 `dist-app/Pi GUI-win32-x64/resources/app/server.cjs` 参数：各18/18；真实 classic 与 managed worktree 启动、extension handshake、owner、preview、strict unavailable、恢复材料发现接口和无证据 prepare 拒绝。

已重建 `npm run build:app -- --rebuild`，退出0；包327.9 MB。app-check26/26；`node tests/session-revert-integration.cjs "dist-app/Pi GUI-win32-x64/resources/app"` 的打包 worker19/19。第一次误传 server.cjs 文件给该 worker 测试，修正为资源目录后通过；不是代码故障，也不记作打包功能通过之前的结果。

**尚未证明：**生产 native metadata +真实 Pi+真正确认写回+备份再恢复、打包 native 恢复、真实 Windows 完整 ACL 复制成功。这些关键门槛阻塞，不能由协议 endpoint 能加载或 fixture rename 成功替代。

## 14. 保留、GC、支持范围和风险

- 成功恢复提示至少7天保留。最小 GC 只删除从未被任何持久事件引用的孤儿对象；已完成和 recovery_required 材料全部永久 pin，不自动按7天删除。位置：`server/session-change-store.js:377`。这是保守容量取舍，不是已交付的成熟过期清理策略。
- 单文件2 MiB、每操作16 MiB、conversation128 MiB、对象全局512 MiB沿用 P33.2（store:8）；备份落盘失败/配额不足拒绝。私有移动对象额外占用保留空间，尚未纳入对象目录 globalBytes 的完整物理统计；需要补齐恢复区容量核算，不能把512 MiB宣称为全数据目录硬上限。
- 删除/rename/shell/MCP未知归因、损坏/不完整证据、metadata unknown、冲突、二进制、危险链接、超限、网络文件系统拒绝恢复；用户确认不能绕过。旧元数据不足仍只读预览，不伪造历史。
- 除 Windows NTFS profile 外生产拒绝；POSIX 没有真实写回平台验收。strict 没有 provider。
- 没有已验证的 OS 排他或 CAS；重复读取/GUI gate 不能排除外部进程。最后校验后 D 可能被覆盖且不在备份中；新文件打开句柄可能在移动后继续写；批量不原子。
- 核心 protocol 已可实写，当前机器 native 资格未达到，普通低权限 Windows 环境的实际覆盖率仍是关键产品问题。不得在 P33.5 掩盖此拒绝或提供强制按钮。

## 15. P33.4 验收结论

已确认交付：现有 journal 内的备份与应用状态、持久消费、scope 校验、一次确认、workspace Stop/gate、受限 writer、部分失败、历史备份独立恢复与导出、保守 pin-GC、完整回归与重新打包。临时文件系统中的实际字节替换/移走/恢复和外部竞争窗口已有可复现证据。

**P33.4 当前不通过整体验收。** 必须补齐具有可验证完整元数据权限的真实 Windows 临时项目 native 恢复闭环、classic/managed/打包恢复证明及上述故障/容量缺口，才能满足用户第十二、十六节的关键条件。未将 metadata_unsupported 绕过以提高覆盖率，未将 fixture 宣称为生产排他能力。

停止本阶段开发，提交本地报告与可审阅变更，等待人工验收/环境条件处理；不自动提交、推送、发版或进入 P33.5。

### 后续授权交付记录

用户在上述本地交付后明确指示“推送”。因此将本阶段变更按业务、测试、报告三个回滚边界提交并推送当前 main；开发前后 HEAD/未提交状态是该指示之前的审计快照。业务提交 `dba4c9e`，测试提交 `50b1f60`，报告提交以本文件所在最终 Git HEAD 为准。此次交付授权不改变“P33.4 尚未通过整体验收”的结论，也不包含发版或 P33.5。

## 16. P33.4a：普通权限元数据阻塞与补强验收

本节更新日期：2026-10-09。前述章节保留 P33.4 历史实测；本节容量统计和故障证据取代第 8、14 节对应缺口描述，**不改变第 15 节整体验收未通过的结论**。

### 16.1 基线、范围与安全契约

开发前及本轮交付 HEAD 均为 `24637010df1eea09ce80e76bdbbed18267a135cc`、main；本轮未提交、推送、发版。开发前仅有既存未跟踪 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`，未改动。改动是本地待审阅工作区变更。

修改：`server/session-change-store.js`、`server/session-revert-metadata.js`、`server/session-revert-service.js`、`tests/session-revert-apply.cjs`、`tests/session-revert-recovery.cjs`、`package.json`、本报告。新增：`server/session-revert-storage.js`、`tests/session-revert-windows-faults.cjs`、`tests/session-revert-metadata-research.cjs`、`docs/p33-4a-implementation-plan.md`、`docs/p33-4a-metadata-design-delta.md`。没有实现新 writer profile、修改 Pi 或进入 P33.5。

**已确认事实：**当前 profile 仍需要完整 before/after/current 元数据；读取不到审计 SACL 就拒绝。新增元数据修复只是在 hidden 文件枚举 ADS 时使用 `-Force`，并在审计权限拒绝之前分类非零/未知 EA；没有把 SACL unknown 当空，也没有移除检查。位置：`server/session-revert-metadata.js:34`、`:40`、`:41`、`:42`。

### 16.2 官方接口评估与真实 NTFS 实验

微软 [SACL Access Right](https://learn.microsoft.com/en-us/windows/win32/secauthz/sacl-access-right) 要求启用 SeSecurityPrivilege；[GetNamedSecurityInfoW](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getnamedsecurityinfow) 的 READ_CONTROL/owner 能力不等于审计 SACL 读取能力。[AdjustTokenPrivileges](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-adjusttokenprivileges) 不能赋予令牌原先没有的权限。本轮没有自动提升权限或修改系统策略。

[ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew) 明确列出 DACL、security resource attributes、部分流等保持性；没有据此推定完整审计 SACL 保持性。最终文件对象来自 candidate，部分错误可能留下中间状态；不使用 ignore merge/ACL flags，不称为 CAS。其他 move/handle API 的存在也不构成不可读 SACL 的证明。

真实临时 NTFS 试验使用官方 ReplaceFileW flags=0，构造保护 DACL、命名 ADS、非空 EA、Hidden/Archive/NotContentIndexed 属性。实际结果：

| 项目 | 原生结果及边界 |
|---|---|
| 内容及备份 | R=`R`，backup C=`C`，均逐字节正确 |
| DACL | 单次构造的保护 DACL 前后相等；不是完整继承 ACL 矩阵 |
| ADS | 原合成 `probe` 流在 R 中保留 |
| EA | **R 中未保留原 EA**；backup 保有原 EA；不能批准整体元数据资格 |
| 属性 | 8226→8226；不推论未测试属性 |
| SACL | auditReadable=false，saclEqual=null、backupSaclEqual=null；**不可读/未验证，非空值或空值均未证明** |

可复现：`npm run test:revert-metadata-research`，实现 `tests/session-revert-metadata-research.cjs:33`、`:37`、`:41`、`:44`；生产拒绝断言 `:56`。实验的通过数表示内容、DACL、ADS、备份及拒绝分类断言通过，不把 EA 保持失败或 SACL 未验证记为元数据安全通过。本实验独立 opt-in，不要求 CI 具有审计权限。

**技术判断：**在已验收的“候选替换+完整枚举/复制/回读”契约下，本机没有普通权限生产恢复的充分证明。不能用一次 ReplaceFileW 成功替代它。详见 [设计差异与风险](p33-4a-metadata-design-delta.md)：保持原文件对象、仅修改数据的原型需要改变禁止原位覆盖的契约，并增加中途失败风险；目前仅提出待批准研究，不接入生产。用户第 5 项明确要求安全契约变更先批准，已请求该批准及独立审计权限环境信息；未收到答复前不执行依赖步骤。

### 16.3 恢复材料容量与保留

对象与 recovery 文件使用 Windows handle 的 `FileStandardInfo.AllocationSize`，并同时考虑逻辑字节，取 max；不使用 Node blocks 猜测 NTFS 分配。依据：[FILE_STANDARD_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info)、[GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex)。同一 handle 查询流表，未知/命名流拒绝，不默默遗漏 ADS。实现：`server/session-revert-storage.js:18`、`:22`、`:70`。分配单元探测检查真实证据目录及祖先，拒绝 EFS、压缩、reparse 和未知属性；目录身份不以兄弟活动改变的 mtime/size 判断。位置 `:29`、`:93`；真实祖先 junction 拒绝和 sibling activity 用例 `tests/session-revert-recovery.cjs:258`。未创建 EFS 证书或在真实用户证书库写入；真正 EFS 加密目录未验证。

全库预算包括实际去重对象、不同副本的恢复文件、未记录但仍存在的恢复材料和待移动预留；新对象按文件系统分配单元估计，已存在对象以实测计费。私有遍历最多 20000 节点，15 秒预算，固定层级，拒绝危险链接、硬链接、未知分配或权限变化。位置：`server/session-change-store.js:213`、`:221`、`:225`。prepare 新建文件移走前占用预留；apply 提交前复查，取消/超时/失败释放预留及 GUI admission，成功改计实际保留材料。位置：`server/session-revert-service.js:26`、`:109`、`:187`、`:199`、`:209`；store API `:458`、`:466`、`:472`。

128 MiB conversation 仍是逻辑证据预算，512 MiB global 是上述正文材料预算；journal 另有 32 MiB 上限。目录/MFT 等文件系统内部开销、任意外部程序的提交后增长不构成严格全盘配额保证。新对象预估与检查不能替代操作系统磁盘保留或排他；空间不足安全拒绝，保留 pin，不为腾空间删除备份。实际 NTFS 样本 logical=2、AllocationSize=8、allocationUnit=4096，说明不能把所有小文件都描述为实际分配 4096。证据：`tests/session-revert-recovery.cjs:204`。

### 16.4 故障、竞争与重启补充

新增 `tests/session-revert-windows-faults.cjs`：独立进程替换源父目录/恢复父目录后拒绝；Windows 独立进程打开 FileStream、不共享 Delete，验证 native replace/move 失败保留 C；真实子进程在 afterStage/持久 intent/afterRename 三边界退出，重开 store 识别 recovery_required，C/R 可读且不重试。位置分别 `:46`、`:81`、`:89`、`:112`。

ENOSPC、两次 staging fsync、EXDEV 使用定点故障注入，来源在测试名称明确标注；**不是实际满盘或跨卷实测**。位置 `:55`、`:68`、`:74`。真实父目录与打开句柄测试仍使用 metadata fixture；不能据此宣称完整 SACL 复制通过。原独立进程最后校验后写入 D 被 R 覆盖的测试继续保留（writer:36），备份范围仍只到 C。这是已展示的数据丢失窗口，未把它改成零风险测试。

尚缺：真实 ENOSPC 卷、真实跨卷、具备权限的非空及继承 SACL 全矩阵、断电测试、普通权限 native classic/managed/打包 R→重新确认→C 闭环。进程退出证据不等于断电持久性。

### 16.5 回归、真实 Pi 与打包结果

变更前独立完整基线：100 套件、退出 0；确认之后才允许生产代码改动。本轮最终 `npm test`：**101 套件、退出 0**，P33 相关 12 套件合计 **356/356、失败 0、跳过 0**。全套另有 1 项既有环境跳过：session-search 的 5i 符号链接权限/开发者模式用例，不计入通过。测试入口保留原 100 套件，只新增 Windows faults；未删除旧断言或修改旧测试预期。

| 套件/证据 | 通过/失败/跳过 | 类型和实测边界 |
|---|---|---|
| P33.2 store / bridge / tools | 35/0/0；23/0/0；30/0/0 | fixture、真实临时文件；store 旧断言不变；100-op reopen 570 ms，object privacy checks=2，这不是全部写操作耗时 |
| P33.3 algorithm / store / HTTP / worker | 67/0/0；14/0/0；65/0/0；19/0/0 | 逆三方、完整归属与只读链路 |
| P33.4 writer / recovery / admission / apply | 22/0/0；24/0/0；15/0/0；29/0/0 | 真实临时文件系统；写回资格使用 metadata fixture |
| 新 Windows faults | 13/0/0 | 独立进程/native sharing；部分故障为注入 |
| 最终真实 Pi 默认工具 | 25/0/0 | 实装 Pi 1.0.4；fixture stream model，没有网络模型 |
| 最终源码 RPC / 打包 RPC / packaged worker / app-check | 18/0/0；18/0/0；19/0/0；26/0/0 | classic/managed protocol 与后端加载；native 恢复仍拒绝 |
| 原生 ReplaceFileW 研究 | 6/0/0 | 6 项断言通过；EA 保持失败、SACL 不可读另行明确记录，不能称为元数据保持性通过 |

恢复套件 11→24，apply 27→29，新增 faults 13；P33 合计 328→356，旧断言均保留。红测试包括服务尚未建立 move 预留、祖先 junction 未拒绝、hidden ADS/EA 分类问题，均先复现再修复；不是通过删检查或改预期变绿。未发现新增功能回归。

最终源码与重建包分别验证，`npm run build:app -- --rebuild` 退出 0、整包 327.9 MB。最终真实 Pi B/A/P→候选→preview→prepare 仍给出 `metadata_audit_unavailable` 并保留 C；两个实装 Pi 隔离 workspace 的采集、重载/恢复及私有目录 reopen 检查通过。classic/managed RPC 18 项证明身份、extension、preview、strict unavailable 和资格拒绝协议，**不证明 R 写回和 C 再恢复**。打包 worker 同样不代替 native 元数据资格。

本机 TEMP 可复核日志：`pi-gui-p33-4a-baseline.log`、`pi-gui-p33-4a-full.log`、`pi-gui-p33-4a-live-final.log`、`pi-gui-p33-4a-metadata-final.log`、`pi-gui-p33-4a-build.log`、`pi-gui-p33-4a-rpc-final.log`、`pi-gui-p33-4a-packaged-rpc-final.log`、`pi-gui-p33-4a-packaged-worker-final.log`、`pi-gui-p33-4a-app-check-final.log`。测试仅操作 fresh 临时项目，日志仅记录合成测试及固定错误，不向产品日志输出快照正文。Native allocation 新扫描有额外 PowerShell/ACL 成本，大量材料可能触发 15 秒拒绝；尚未完成长期、大规模性能验收，不删除 pin 来换性能。

只读复核确认：新容量队列不递归获取自身、不新增 authority 锁顺序；lease finally 清理不依赖 journal 健康；没有新增 HTTP/SSE/Activity/localStorage 或原始证据出口。语法与 diff 检查通过。没有实现或验证任何新的 OS 排他 provider。

### 16.6 P33.4a 门槛结论

| 门槛 | 本轮状态 |
|---|---|
| 官方接口研究、未知 SACL 不放行 | 已完成；仍拒绝 |
| ordinary user 元数据保持及 native 直接恢复 | **阻塞**；本机 SACL 不可读，没有足够替代证明 |
| 恢复区实际分配及容量限制 | 已补齐受限正文材料统计与预留；不宣称 OS 硬配额 |
| 父目录/句柄/进程崩溃边界 | 已有真实 Windows 临时测试；元数据为 fixture |
| 真实 ENOSPC、EXDEV、断电、完整继承 SACL | 未验证；注入测试不替代 |
| classic/managed/打包完整 native R→C | **阻塞**；不能以只读预览或 fixture 写回来宣称通过 |
| 契约替代方案 | 设计差异已交付，待用户批准与独立验证环境 |

**P33.4a 最终验收仍未通过。** 当前是契约内的安全补强和可复核阻塞报告；不通过删检查、unknown 放行或调整测试预期增加资格。等待人工验收及必要设计/环境决策，不自动提交、推送、发版或进入 P33.5。

### P33.4a 后续授权交付

用户在本轮本地报告交付后明确要求“推送”，据此按业务、测试、报告边界提交并推送 main。上述 HEAD/工作区描述保留开发与本地交付时的审计快照；交付后的报告提交以本文件所在 Git HEAD 为准。推送授权不代表通过最终验收，也不批准元数据契约变更、发版或 P33.5；既存未跟踪发布目录不纳入提交。
