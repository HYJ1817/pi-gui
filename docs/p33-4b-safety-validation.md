# P33.4b：Windows 原文件对象恢复安全验证

日期：2026-10-12。范围：隔离研究、安全证据补齐和设计收敛；不接入生产恢复。本轮 A/B/C 是“候选替换 / 原位写入 / 仅材料”，与 P33.4a 文档的旧方案编号不同。旧“方案 C 研究获批”对应本轮 B 的隔离研究，不能视为生产 B 已批准。

## 1. HEAD、工作区与修改范围

开发前 HEAD：`3d83eb36937c54b1aa81967d2b1528e55d86f4f4`，main。仅有既存未跟踪发布目录 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`，保留未操作。开发后 HEAD 不变，无自动提交/推送/发版。没有修改用户工程文件，没有编辑 server/public/lib/extensions。

修改：`tests/fixtures/session-revert-inplace-native.ps1`、`tests/session-revert-inplace.cjs`、`package.json`、`docs/p33-4a-metadata-design-delta.md`、`docs/p33-original-object-prototype-research.md`。

新增：`tests/session-revert-inplace-safety.cjs`、`tests/session-revert-sacl-witness.cjs`、`docs/p33-4b-research-plan.md`、本报告。测试入口保留原 102 个 suite，只追加两个，104 个唯一 suite。旧原型 28 个场景与断言保留；原 helper 仅导出研究编排、增加可选研究参数并保留直接执行行为（`tests/session-revert-inplace.cjs:82-121`）。无需重建生产包；本轮没有打包原位 writer，也不声称产品已获得此功能。

## 2. 环境与权限事实

真实 Windows `10.0.26200.0`、Node `24.14.0`、固定本地 NTFS。`whoami /priv` 中无 SeSecurityPrivilege；新只读子进程探测返回 `auditEnabled=false, auditError=1300`。微软 [AdjustTokenPrivileges](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-adjusttokenprivileges) 说明该 API 不能新增令牌尚未拥有的特权，必须检查未全部分配的错误；[SACL Access Right](https://learn.microsoft.com/en-us/windows/win32/secauthz/sacl-access-right) 解释读取审计信息所需权限。

探测只尝试启用子进程已经分配的权限，不自动 UAC、不修改账户或系统审计策略（原生夹具 `:212-224`）。环境阻塞是**无法实际读/构造/比较完整非空 SACL**，不是 SACL 为空。未知 SACL/fullSDDL 保留 null、auditReadable=false（`:353-374`）；生产 `metadata_audit_unavailable` 仍在 `server/session-revert-metadata.js:42-43`、`server/session-revert-service.js:39-42`。

## 3. 完整 SACL 见证工具与独立环境步骤

工具：[session-revert-sacl-witness.cjs](../tests/session-revert-sacl-witness.cjs)。只允许 `--require-audit`，不接受项目路径、任意绝对路径、已有用户文件或权限提升选项。内部调用 os.tmpdir/mkdtemp 创建自身独立 fixture，原生边界只接受固定 `workspace/file.txt`（原 helper `:64-77`；原生 `:13-43`）。TEMP 必须位于固定本地 NTFS；父 TEMP 不能给新对象继承非空审计 ACE，否则 setup 保守拒绝 fresh_fixture_required，不清空已有审计规则。应使用**已获授权审计权限、满足此 TEMP 条件的独立测试环境**，而非在用户机器修改权限策略。

执行步骤：

1. 在独立环境取得本轮研究文件的同一版本，核对原生脚本 SHA-256。使用预先已授权拥有 SeSecurityPrivilege 的令牌；需要对自己新建 TEMP 对象有读取安全描述符、WRITE_DAC、主流读写、EA/ADS 和属性访问权限。此工具不会配置这些权限。
2. 运行 `node tests/session-revert-sacl-witness.cjs --require-audit`。默认测试入口运行不带此参数版本，缺权限会明确跳过；要求审计的命令缺权限实际 Node 退出状态为 **2**，不能当 CI 审计验收成功。
3. 保存输出第一行固定 schemaVersion=1 JSON 与第二行 suite 数字。输出仅权限状态、OS/NTFS、场景、布尔检查、digest、固定错误；不输出原始 SDDL/SACL、对象正文、私有目录、capability token。
4. 必须获得 8/8、failed=0、skipped=0；每行 checks 全为 true、backupVerified=true、secondPlanHandshake=true，仍有 productionQualified=false。任何 unavailable/unverified/failed 都不能作为完整元数据通过。

8 格为显式 / 继承 / 受保护 / 混合 SACL × protected / inherited DACL（工具 `:7-17`、`:29-48`）。显式构造 ReadData/Success 与 AppendData/Failure；继承构造 WriteData/Success+Failure；混合组合二者；受保护 SACL 无继承 ACE。新 setup 只开启审计保护，不解除保护，不修改系统策略（原生 `:272-319`）。一次性 marker 和初始目录形状限制重复 setup；它们不是通用安全 capability，目录新鲜性来自工具自己 mkdtemp。

本轮原生脚本 SHA-256：`5850b35f23870a403f494e879b4aa04faa54574bccfe7cb05e20ac1d5a03ae50`。独立环境应记录实际 OS/NTFS 与此源版本，不能用另一个 provider 的通过结果替代本路径。

比较文件 ID、完整可读取 SDDL、Owner、Group、DACL、SACL、审计保护/继承计数、非空 EA、ADS、属性 8226。所有检查在 C→R 及从持久 C 新计划返回 C 时重复（工具 `:8-17`、`:34-47`）。完整 SDDL 指本工具构造且可读取的 Owner/Group/DACL/SACL 四部分，不扩展为所有 MIC/resource attribute/scoped-policy ACE 或全部 NTFS 元数据已认证；这些未构造场景仍待验证。

**本机结果：0/0，failed=0，skipped=8；八格均 unverified。** Mock 比较器测试只证明未知不能被当空、字段不一致会拒绝，不是 SACL 保持证据。恢复计划和 commit 都由 fixture 程序化握手，JSON 明确 `confirmationSource=fixture`；没有实际人工 UI 或生产确认 token 证据。

工具结束会清理自身新建的 TEMP 项目，backupVerified 指清理前从持久对象回读验证，不是生产备份保留期或现场可取回材料的证明。本轮没有重试清理上轮被审批拒绝的三个合成旧目录。

## 4. 原生 API 故障：真实响应与注入边界

通过 [DuplicateHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle) 创建同一对象的只读权限副本，然后实际调用 Win32 WriteFile/SetEndOfFile/FlushFileBuffers。不是 mock 返回值，但降权是人为注入条件；不能称自然磁盘故障（原生 `:152-180`；新增测试 `:87-97`）。

| 注入边界 | 实际错误/字节 | 保护与重启结果 |
|---|---|---|
| 首次 WriteFile 降权失败 | 5；C=`CCCCCCCC` | C/R 完整；recovery_required，不凭 C=原版声明从未写入 |
| 首段后 WriteFile 降权失败 | 5；D=`RRCCCCCC` | C/R 完整；部分内容保留，等待人工核对 |
| SetEndOfFile 降权失败 | 5；D=`RRRRCCCC` | 新前缀已写、旧尾部仍在；不继续写或回滚 |
| FlushFileBuffers 降权失败 | 5；D=R=`RRRR` | 读回正确不代表 durable 完成，仍 recovery_required |
| 零长度真实 WriteFile 请求 | 返回 0 字节成功；short_write 防护 | 固定 cause=short_write/nativeCode=0；不循环卡死 |
| 限小的非零真实 WriteFile 请求 | 首次请求 1 字节，再正常循环 | shortWriteCount>0，R 逐字节正确；是请求尺寸注入，不是自然 NTFS 短写 |

部分 D digest：`RRCCCCCC`=`244c9a8b7733da1df7e40e163de2052168e98553da964bb54d774da1cf0776bb`，`RRRRCCCC`=`48eb8d8c2e73fd567e3eb32793af73b4ae4000a6b7d6755cf8f48f06bab65a8d`。R digest=`ad49738ddc9ea282f541a4d462213ce512bde2d3a9aeb89ff414a34398985d30`。均为合成数据。

原位多次 [WriteFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-writefile) 与 [SetEndOfFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setendoffile) 不构成整文件原子替换；[FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers) 不构成对象/journal/多个文件的断电事务。真实 ENOSPC、自然短写、断电均未验证。

## 5. 中断、重启与人工恢复设计

现有 store 的对象 digest/长度/私有权限验证及 fsync journal 可直接复用（`server/session-change-store.js:135-187`、`:342-429`）。生产恢复终态没有 uncertain_external_change，且 recovery_required 不可升级为 applied_verified。本轮测试分类器只返回只读投影（`tests/session-revert-inplace-safety.cjs:14-24`），从不修改生产枚举或终态。

| 研究分类 | 判据与不可扩大之处 |
|---|---|
| not_applied | 有可信未发送 commit/未进入 native mutation 的证据、持久未应用结果、稳定当前 C/身份；单独 D=C 不够 |
| applied_verified | native done/verified/id、独立字节/身份检查、约定可观测元数据及持久 observedPostDigest 都完成；只是该时点的研究结果，不是生产资格或全历史无损证明 |
| recovery_required | 已有意图或写入尝试但错误/崩溃/完成日志失败/材料坏或观察不足；即使 D=R 也不升级 |
| uncertain_external_change | 新身份、明确外部变化或当前 D 与可信上次观察不一致；可能同时 recoveryRequired=true。其他字节不能直接证明全由外部写者产生 |

真实首段/EOF/flush 后退出 73 继续复用旧 28 场景；本轮追加 post-write journal EIO：实际 R 已存在，重启仍 recovery_required。坏对象和截断 journal 拒绝重开，C 不改；外部独立进程在崩溃后写新 D，重启只查询，不重放（新增测试 `:98-125`）。

fixture 恢复实验从持久 currentRef 读取 C，重新读取 D、备份 D、建立不同 planId/新意图，才执行 D→C；原失败计划保持 recovery_required。恢复过程中再失败，原 C 和中间 D 两份材料都保留（`:104-114`）。这证明材料可用于新恢复流程，不证明生产人工确认已经实现。

建议人工流程：停止已知写者并保存/暂停外部编辑器 → 授权读取旧 C/R 与当前 D → 在固定文件清单内选择期望版本 → 持久备份 D 及可验证元数据 → 重新构造候选和新确认 token → 用户逐次确认后使用获批 provider。身份/证据/权限不够则仅导出人工材料，不自动覆盖；恢复失败仍保留全部代际材料，禁止自动重试。C/R 正文可恢复被保存的字节，**不能恢复未保存的 SACL、未知 ADS/EA、权限、审计事件历史、之后外部新 D 或完整文件系统状态**。

## 6. 外部并发与 Archive

| 操作 | 实测分类 | 边界 |
|---|---|---|
| 已有普通数据 reader / writable mapping | 本机阻止获取 writer；旧 `inplace.cjs:279-310` | 映射已关闭原数据句柄，仍拒绝；不推广所有映射/驱动 |
| writer 持有期间新主流 write / 源 rename | 独立 Node 进程返回 EBUSY | 新测试核对实际文件错误，不接受超时或启动失败假绿 |
| 已有目标的 rename-replace | EPERM；候选仍在，最终 R 正确 | 只说明样本期间 Windows 共享限制生效（新增 `:135-146`） |
| 目标父目录 rename | 旧夹具 pin 期间拒绝 | 只固定 root/workspace；并非所有祖先原子固定 |
| 独立 ADS / DACL 修改 | 旧测试真实成功，修改保留 | 主流 share=0 不冻结整个对象；[File Streams](https://learn.microsoft.com/en-us/windows/win32/fileio/file-streams) 明确共享按 stream 管理 |
| 独立属性修改 | 新 attribute-only handle 成功 | 无法用主流共享排除（新增 `:147-149`） |
| 预先 readonly / hardlink / junction | 旧套件继续拒绝 | 不删除属性、不跟随链接；旧断言不变 |
| 新对象身份 / 非法输入材料 | 拒绝旧 ID 或 digest 不符 | pin/哈希不等于通用 CAS 或永久身份 |

Archive 实验使用官方 [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle) 的 [FILE_BASIC_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info)；仅 Read/WriteAttributes、同对象 ID、固定 flags，时间字段 0。它可以将写后 8224 变回 8192，但没有属性 CAS。另一子进程在 attrs_ready 后设置 Hidden（8194），旧 8192 回放会丢失 Hidden；实测 `cachedRestoreLostHidden=true`（原生 `:132-140`、`:225-234`；新增 `:150-155`）。**此结果是风险证据，不是 Archive 已修复。**

建议未来 B 第一版仅考虑历史与当前 Archive 已设置、允许属性一致且不做属性恢复的窄 profile；本机 8226→8226 已验证。Archive 未设置、readonly/特殊属性、外部属性变化拒绝；不得为了还原 Archive 去回放整个过期属性值。此限制仍不是保证外部未修改隐藏信息，也不开放当前生产资格。

## 7. 大小、换行与材料传输

新增 1 KiB / 64 KiB / 2 MiB 的 UTF-8 BOM、混合 CRLF/LF 原始字节验证；同一文件对象且候选逐字节匹配（新增 `:126-134`）。大型 C/R 不再进入环境变量：仅固定 inputs/current.bin、candidate.bin 的预算读取、父目录/文件 pin 和 digest 校验（原生 `:118-131`、`:235-248`）。输入对象被篡改时拒绝，不接受客户端任意路径。内容对象仍复用现有证据 store。

这是研究传输，不是生产 capability/秘密传输方案。目录新鲜性与输入来自可信 fixture；完整祖先竞争、广泛身份复用、ACL 有效访问、私有传输权限与生产 worker 来源还需要单独设计。二进制、未知编码、删除/rename 和旧 metadata unknown 证据没有获得生产支持。

## 8. 测试数字与验证层级

基线 npm test：102 suite、退出 0；P33 384/384、失败 0、SACL 跳过 2，另有既有 session-search 5i 环境跳过 1。新增 RED：0/2、失败 2，原因是旧 helper 不支持 privilege/write_failure，之后实现对应路径。

新增安全套件已复测 **43/43，失败 0、跳过 0**：20 个 Mock 分类/比较器场景，23 个 Windows 探测与真实 TEMP NTFS 场景，其中包含明确标记的 Win32 权限/请求尺寸及 journal 故障注入。多数新增错误用例的 privacyCheck/配额分配为 fixture，正文对象、fsync、独立进程及 native 数据写入是真实；不能证明生产私有存储资格。旧真实私有 ACL C→R→C 流程继续回归，SACL 见证工具在有权限环境会用真实私有 ACL/实际分配测量，但本机未执行八格。

SACL 工具：0/0、失败 0、跳过 8；严格审计命令进程状态 2。没有用 Mock 把这八格记为通过。

**最终完整重跑：104 个唯一 suite、退出 0；P33 的 15 个 suite 合计 427/427、失败 0、跳过 10。** 全套还有既有 session-search 5i 跳过 1，共 11 项显式环境跳过，跳过不计入分子分母。场景数按各套件实际计数口径，不冒称为每个 assert 调用数量。

| 分组 | 通过/失败/跳过 |
|---|---|
| P33.2 store/bridge/tools | 35/0/0、23/0/0、30/0/0 |
| P33.3 algorithm/store/HTTP/integration | 67/0/0、14/0/0、65/0/0、19/0/0 |
| 既有 P33.4 writer/recovery/admission/apply/Windows faults | 22/0/0、24/0/0、15/0/0、29/0/0、13/0/0 |
| 原型套件（旧场景保留） | 28/0/2 |
| 新安全套件 | 43/0/0 |
| 新真实审计工具 | 0/0/8，全未验证 |

第一次修改后完整 npm test 退出 1，第 64 个既有 suite process-tools 的 fetch(state) 出现 `bad port`，前面 63 个 suite 完成、1 suite 失败、后续 40 suite 未执行；`server/process-bridge.js:47` 使用 listen(0) 取动态端口。本机动态 TCP 范围为 1024 起、13977 个端口，包含 Node fetch 禁用端口；独立 6000 端口探测在请求发出前得到同一 bad port，旧 process-tools 单独重跑为 25/25、退出 0。**[技术推断] 高度疑似既有动态端口与 fetch 禁用端口相交；该次失败端口未记录，根因未直接确认**，不猜具体分配端口。未修改旧断言或生产代码。第二次完整运行通过，process-tools 25/25；第一次失败保留为未解决的既有环境/端口选择疑点，不以重跑成功宣称已经修复。未发现本轮新增回归。

日志：`%TEMP%/pi-gui-p33-4b-baseline.log`、`pi-gui-p33-4b-reviewed.log`、`pi-gui-p33-4b-audit-required.log`、`pi-gui-p33-4b-final.log`、`pi-gui-p33-4b-final-retry.log`。规范与质量审查均完成；修复了新 helper 在最终 journal 前遗漏 native done/verified/id 的问题，以及并发测试接受任意子进程错误的问题，未降低旧断言。未修改生产代码，不运行生产打包恢复，也不把 fixture 流程称真实 Pi/managed-worktree/人工 UI 证据。

尚未验证：特权 SACL 八格；其他 Owner/Group 或令牌组合、MIC/resource ACE、更多 OS/NTFS/驱动；自然 ENOSPC/自然短写/断电；不可见 SACL 并发、所有祖先和身份复用竞争；原位 provider 的生产 worker/打包、classic/managed 闭环和实际人工确认。当前 Owner/Group 是合成 fixture 的创建值，比较成功不能覆盖所有所有者与有效权限组合。第一次 bad-port 故障的具体端口和直接根因也未确认。

## 9. 本轮方案 A/B/C 比较

| 维度 | A：候选替换，完整可验证元数据 | B：保留原对象原位写入 | C：候选/备份/人工材料 |
|---|---|---|---|
| 数据保护 | 提交前原 C 留在原路径；最终替换仍有外部 D 窗口 | C/R durable 可辅助恢复，但原位可能留下部分 D | 不自动改工作区，材料权限/完整性仍需保证 |
| SACL/DACL/ADS/EA | 当前生产窄 profile 要完整 ACL，拒绝 ADS/非空或未知 EA | DACL/EA/ADS 样本保留；SACL 八格未验证；不回放旧 metadata | 能保留实际采到的材料，不补造不可读 metadata |
| 故障 | stage 前失败通常不改 C；提交/日志不明需人工 | Write/EOF/flush 失败和崩溃可能部分覆盖；不自动回滚 | 不提供应用能力；人工写入仍可能失误 |
| 外部编辑器 | 最终校验→rename 不能消除竞争 | 主流有共享限制，ADS/DACL/属性仍可并行；关闭句柄后仍竞争 | 查询也要标观察时点，无自动覆盖 |
| 普通权限 | 当前 SACL 阻塞，不可声称普通用户可用 | 内容路径普通权限可运行，但完整保留证明及契约门槛未过 | 当前可提供信息；不能满足 P33 最终直接撤销验收 |
| 多会话/worktree | 现有 P32 authority/gate/journal 复用 | 将来应复用相同 authority、Stop、scope，不新建 registry | 同样授权和作用域，不跨 workspace 读取 |
| 复杂度/覆盖 | 现有实现；完整可验证无 ADS/EA 的窄范围 | 更高的原生 provider/中断恢复成本；预计常见文本有机会，未测覆盖率 | 实现最少，自动恢复覆盖率为 0 |

## 10. 推荐生产路径及单独审批事项

**目前不允许修改生产 writer 契约。** 保留 A 的完整元数据资格和全部拒绝；C 作为环境不满足时的临时退路，不能改最终验收目标。为了使普通 Windows 用户有直接撤销路径，下一步建议继续评估**有平台保持证明的窄 B provider**，而非 unknown 放行或永久只导出。

B 的可交付前置条件是：独立审计环境八格通过并绑定 native 版本/OS/NTFS；普通权限相同受限数据调用路径验证；保留原文件句柄且不请求设置安全描述符权限，不提供 SetACL/属性修复/rename fallback；新的版本化采集保存可观察 metadata/原对象证据，旧 unknown 记录不能追认；第一版仅修改既有文件（含原有 untracked），要求完整 intent_verified、无 gap/冲突、无 ADS/非空 EA、允许的单链接 UTF-8 文本及 Archive 已设置属性 profile。Agent 新建文件的可恢复移走需保留现有流程并独立补齐其 metadata 门槛，不能靠本轮原位实验扩大资格。正常 write/edit 的预计覆盖范围是这些条件的交集，没有实际任务分布前不报百分比。非空 EA/ADS 研究样本的保持成功不扩大第一版生产范围。

生产完整原生 provider 还需要覆盖有审计权限的真实 SACL、自然 I/O 错误/断电保护边界、生产身份/私有权限、停止/排空、多文件部分失败、worker/打包调用和用户确认。这一方向没有 OS 整文件原子性；不得宣称 strict 或零数据丢失。持有主流句柄也不排除 SACL/ADS/属性、内核/驱动及句柄释放后的竞争。

如进入 B 实现，必须**单独批准**：

1. 允许新增原对象 provider，改变原设计禁止 truncate/直接覆盖的规则；保留 A，不作为其失败 fallback。
2. SACL 资格从每次完整读取/复制/回读改为有平台验证证据的原对象保持证明；明确适用 OS/NTFS/API、不可见并发变化和失效边界，不能用 supported=true 或相同 ID 代替证明。
3. 明确部分覆盖、EOF/flush/完成日志失败的风险；升级逐次风险通知版本，确认不能提升归因或冲突资格；材料不足必须拒绝，失败后无自动回滚。
4. 明确 Archive/时间属性和 metadata 不回滚的窄范围，任何属性恢复或扩大 ADS/EA profile 需新增实验与审阅。
5. 人工恢复需备份当前 D、新候选、新 token、新确认，不沿用原计划；保留所有失败代际材料，声明无法重建未保存 metadata/后来外部 D。

当前未完成上述独立环境证明和生产契约批准，**不达到进入 B 生产 P33.4 修复的条件**。本阶段研究工具、失败证据和设计差异可交人工验收；P33.4 产品功能仍未通过。最终 HEAD 仍为 3d83eb3、git diff --check 通过，工作区仅 §1 清单中的 9 个研究相关文件及未操作的既存发布目录。停止开发，不进入 P33.5，不提交/推送/发版。

## 11. 后续授权交付

2026-10-12 用户在研究报告交付后明确要求“推送”，据此将隔离测试和研究报告分开提交并推送 main。以上 HEAD/工作区记录保留研究完成时的快照，交付后的提交以本文件所在 Git HEAD 为准。此授权不代表生产验收通过或 writer 契约批准，不包含发版、P33.5，也不纳入既存发布目录。此前完整 npm test 与首次 bad-port 失败记录均保留，不把推送视为消除环境或审计权限阻塞。

推送前再次验证：安全套件 43/43、失败 0、跳过 0；SACL 工具 0/0、失败 0、跳过 8，均正常完成。日志为 `%TEMP%/pi-gui-p33-4b-push-check.log` 与 `pi-gui-p33-4b-push-witness.log`。此次不重复运行完整 npm test，不将上一轮全套证据冒称为推送回合重新执行。
