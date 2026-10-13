# P33-D1：只读 Object Profile 与版本化证据验收

日期：2026-10-13。状态：D1 本地实现与验证，待人工验收；未获准 D2 或生产 Q1/Q2/Q3。

## 1. 结论与授权

本轮仅开发只读对象观察、严格负向资格判断、P33.2 additive 私有证据和内部材料 descriptor。**生产 allowlist 仍为空，qualification.eligible 始终 false；没有 B writer/provider 注册，没有新增实际恢复写回入口或 GUI 恢复按钮。** 现有 A API 仍存在，但其原有 metadata/SACL/strict 拒绝不变。

**本轮满足 D1 的限定验收标准，可交人工验收。** 完整回归结果见 §14。到此停止，只能申请 D2 的单独 TEMP 授权，不能自动开始，更不能把 D1 通过理解为接受部分覆盖或平台保持替代完整 SACL 读取。

已按用户限定授权修订两份 P33.4d 文档：D1 可单独授权；D2 需另行明确 TEMP 授权；生产 Q2/Q3 等风险单独审批；D6 前 production writeback capability 默认关闭；每阶段停止验收。AGENTS 没有禁止这一限定方式，旧统一批准前提来自上阶段拟议方案，已修正。

## 2. 开发前后 Git 与现状

开发前 HEAD：`5f5a7a89911354e2d006252d154487a8a1007a67`；开发后仍为同一 HEAD。v0.24.0 本地 tag：`ec546d5a3711a21d2dbc911d661eb52742774be0`，未修改。原有未跟踪发布目录未操作；P33.4d 两份未提交文档保留并按本次授权修订，没有重置用户文件。

读取/复核 AGENTS、README、P33.1–P33.5a 的相关设计/验收以及 store/bridge/metadata/writer/service/authority/routes，核对 runtime/worktree/打包组合。以实际 `server.js` 的 classic 与 runtime `createChanges` 工厂注入为准，没有重造 runtime registry。Pi 支持边界仍沿用当前 binding/P33.2 来源校验，本轮实际安装 Pi 为 **1.0.4**，未修改 Pi 本体、全局安装或 schema。

本阶段不联网、不重复旧特权八组。已有特权八组源基线/结果仍见 P33.4c：Windows 26100 NTFS 8/8；普通 26200 研究原位 28/28、SACL 跳过 2，安全 43/43。这是研究证据，没有让新 D1 helper 或任何当前文件获得生产资格。新观察 helper/hash 与旧研究写入 helper 不同，不能复用旧 hash 的资格。

## 3. 实际文件变更

| 文件 | 改动 |
|---|---|
| `server/session-revert-object-profile.js` | 独立纯资格判断、bounded 标准化、完整 owner scope hash、固定拒绝、空生产 allowlist |
| `server/session-revert-object-native.ps1` | 只读 observe；Win32 handle/identity/security/streams/EA/字节观察；没有写回、EOF、ACL/属性修复或提权模式 |
| `server/session-revert-object-source.js` | 从固定源码/随包 asset 读取 helper bytes 与 SHA-256；不走用户项目脚本或 `.ok` 临时解包缓存 |
| `server/session-revert-object-observer.js` | 后端私有 spawn、路径/作用域验证、ASCII JSON stdin、有界输出/timeout、unknown 保留 |
| `server/session-change-store.js` | additive before/after object observation、版本/操作身份验证、同 owner 私有 descriptor；D1 明确拒绝 B plan |
| `server/session-change-bridge.js` | 服务端注入 readonly inspector，before/prepare/settle 绑定真实操作；client 无法提供 object evidence |
| `server.js` | classic/managed 工厂统一注入 readonly observer，无 writer/provider 注册 |
| `scripts/build-exe.mjs`、`scripts/build-app.mjs` | SEA asset/Electron resources 增加 `revert-object/observe.ps1` |
| `package.json` | 两个新 canonical suite 进入唯一 npm test 链，107→109；无依赖/版本变更 |
| `tests/session-revert-object-profile.cjs` | 负向矩阵、真实 NTFS/Unicode/ADS/EA/保持观测 |
| `tests/session-revert-object-evidence.cjs` | 版本/reopen/操作/授权/预算/descriptor/bridge/private projection/B plan拒绝 |
| `tests/session-change-bridge.cjs`、`tests/session-change-tools.cjs` | 各加 1 条 client 假造 object evidence 不被接受的回归，旧断言保留 |
| `tests/session-change-live.cjs` | 实装 Pi fixture stream 默认工具注入真实 observer，新增 1 条持久版本字段实测 |
| P33.4d 两份文档与本文 | 限定授权修订、D1 验收报告 |

未修改 `session-revert-metadata.js`、`session-revert-writer.js`、`session-revert-service.js`、`session-revert-authority.js`、`session-revert-routes.js`、P33.3 算法、public GUI 或 Git 语义。

## 4. Object Profile 结构与资格

接口 `evaluateObjectProfile({evidence,current,platformProof,helperHash})` 返回 `{observations:{before,after,current},qualification:{eligible:false,reason,profileId,proofId,helperHash}}`。profileId 为 `windows-original-object-v1`。

每份私有 observation 包含：version=1、status、source.kind/helperVersion/helperHash；scope/operationId/relativePathHash；platform 的 OS/架构/FS/卷/driveType；file 的 ID/链接/大小/属性/digest/编码；path 的相对路径 hash 与全父链 ID/binding/reparse；security 的 owner/group/DACL/SACL state/value；stream names 状态、EA state/bytes、FILETIME 字符串、nonAtomic=true。不保存绝对目标路径。

`PRODUCTION_OBJECT_ALLOWLIST` 是冻结空数组；26100/26200 仅候选列表。`p33-d1-readonly` 只是已知只读观察来源标签，不是生产保持证书；未知 proof、提供但不匹配的 OS/架构/FS/卷/helper 均拒绝。caller 提供 approved/eligible/acknowledged 不能开资格。8226 的研究保持不扩为四属性组合生产资格。

标准化预算：单 observation≤16 KiB、深度≤10、节点≤4096，拒绝 getter/prototype/不合法 JSON；null/primitive 顶层不是完整 observation。未知/unavailable SACL 的 null 原样保留，known 要求 string，不以 ID 一致判断 SACL 安全。

## 5. Native 只读实现与资源

固定模式仅 observe；输入在 stdin≤16 KiB。目标 handle 用读取 DATA/EA/ATTRIBUTES、READ_CONTROL/SYNCHRONIZE 权限，OPEN_EXISTING、OPEN_REPARSE_POINT/BACKUP_SEMANTICS；不含设置 ACL/属性/EA 的权限，不启用 SeSecurityPrivilege。各父目录 handle 观察并复核 ID/reparse/canonical 路径，目标身份与大小/mtime/属性前后核验。

Native 有界字节读≤2 MiB、64 KiB 分块；父链≤128；ADS FindFirst/NextStream 完整枚举最多 32 项，失败/超额成为 unavailable 而非空；EA 使用只读 NtQueryInformationFile FileEaInformation，失败记录 unavailable，非零单独拒绝。Owner/Group/DACL 从安全描述符读取；现有令牌能读取 SACL 才 known，权限不足就是 unavailable，不请求新权限。

Native 循环观察预算 15 秒，宿主总 timeout 30 秒、stdout≤64 KiB、最终 observation≤16 KiB；系统调用阻塞可能依赖宿主终止，不能称内核级硬 deadline。stderr/失败只返回固定原因，不向产品日志转发 stdout 或描述符。

中文/emoji stdin 首次测试失败：Windows PowerShell 重定向 Console.In 可能使用旧代码页。已以 ASCII JSON Unicode escape 传输修复，不修改用户或进程全局编码设置；真实 Unicode 路径通过。早期 Split overload 夹具/实现错误也先定位后修复，未放宽断言。

## 6. 真实 NTFS 结果与副作用

普通用户 Windows `10.0.26200.0`、x64、NTFS 实测。12 字节 BOM/CRLF UTF-8 fixture，内容 SHA-256：`751c4b9a9da25e33c2cd628bb2c57a4f9f94f967c763d235bc357eb60d65d33b`。

| 比较 | 结果 |
|---|---|
| 内容、文件 ID、单链接 | 全字节/ID保持；links=1 |
| 文件属性、Owner/Group/DACL | 连续观察一致 |
| 全流列表 | 无 ADS 时明确 `['::$DATA']`，非 unavailable |
| EA empty | 明确 known/bytes=0 |
| SACL | unavailable/value=null；未证明本次完整 SACL 保持 |
| 非空 ADS | 真实 `:hidden:$DATA` 被列出，固定拒绝 |
| 非空 EA | TEMP fixture 构造后真实 size=28，被拒绝；EA/ADS/DACL/属性/ID 和正文保持 |
| Unicode 文件名 | 中文、空格、emoji 真实路径与 digest/binding 成功，不输出绝对路径 |
| 访问时间 | **lastAccessEqual=false**，发生读取副作用；不声称完全无文件系统副作用 |

非空 EA/DACL/ADS 的构造复用已有 TEMP fixture 的 setup 模式，不调用其 write/commit 或新的恢复计划。production observer 没有 metadata setter。PowerShell Add-Type 还可能使用运行时编译缓存/TEMP 文件；这些不等于写目标正文，但同样不能宣传为零系统副作用。

新 native helper SHA-256：`230EADE3A3611F2340B8ECB3D536B61D2ADB88DEABC44B44D7C59EC065A2063F`；源码与重建 Electron helper byte hash 一致。证据日志 `.probe/p33-d1-profile-final.log` 与最终 npm log 的 measurement/EA negative；不在报告贴实际 SID/full SDDL/绝对材料路径。

## 7. 完整负向矩阵

| 要求 | 固定拒绝/行为 |
|---|---|
| 旧版本缺字段 | object_evidence_unavailable，旧记录不升级 |
| Profile/helper/proof 未知或不符 | object_profile_unknown / object_helper_unknown / object_proof_unavailable、unknown、mismatch |
| 未验证 Windows、非本地固定 NTFS/网络 | object_platform_unsupported；候选也不能得到生产资格 |
| reparse/junction/symlink、硬链接数、父链 | object_path_unsupported；未知 ID→object_identity_unavailable |
| ID/卷/路径链不同 | object_identity_changed |
| ADS 未知与命名流 | object_streams_unavailable / object_streams_unsupported |
| EA 未知与非空 | object_ea_unavailable / object_ea_unsupported |
| Owner/Group/DACL未知、SACL形状不合法 | object_security_unavailable；unknown SACL保留 |
| 属性无资格 | object_attributes_unsupported；32/34/8224/8226最终都 production_allowlist_empty |
| 编码/字节预算 | object_text_unsupported / object_budget_exceeded |
| 新建、rename、删除/不支持操作 | object_operation_unsupported |
| gap/incomplete/observed/未结算 | attribution_gap / incomplete_evidence |
| 过期/已消费 | expired_evidence / already_reverted |
| owner/workspace/epoch/generation不符 | scope_mismatch |
| operation/path/scope observation binding不符 | object_binding_mismatch |
| refs.length/digest不符 | incomplete_evidence |
| 可观测安全描述符/属性变化 | object_metadata_changed |
| 观察失败 | object_observation_unavailable，没有 empty/supported 推断 |

即使所有形状校验通过，最后也是 production_allowlist_empty。没有 approved caller flag、风险勾选、文件 ID 或历史 8/8 的资格捷径。

上表是单因子负向用例的固定原因；实际记录同时存在多个问题时返回最先发现的拒绝，不承诺绕过前置失败以列出所有原因。例如 Agent 新建前对象不存在，实际 before observation 还可能先返回 unavailable。

## 8. 版本化证据、兼容与失败

新 callback 在 private bridge 服务端生成 beforeObjectEvidence/afterObjectEvidence，客户端新增字段仍被原 closed-body 校验拒绝。store 新增 objectEvidenceVersion=1；复用原 scope/journal/blob/配额/privacy，没有第二个注册中心。

before/prepare/settle 校验 operationId、scope hash、relativePath hash、来源版本/hash；observed 时 digest/长度绑定实际 B/P。两阶段 prepare 保留原 before，不能以当前值覆盖/补造历史；旧 captureBefore 不能改成新版本。旧 record 读/预览原样，缺字段就是缺字段。settle 不能漏版本或跨操作附加 after。

native 返回 unavailable 可以持久记录不完整观察；它不代表 metadata 完整或 B 资格。原有 intent_verified 仍只描述 B/A/P 内容意图，未更改为完整对象认证；profile 在不完整 observation 下拒绝。若 callback 异常、版本/绑定/预算非法，原 protected capture 报固定失败，不静默放行。观察前后若发现原已 observed 身份/内容失配，prepare 拒绝。

Private JSON 各 observation 16 KiB，沿用全局对象/操作、journal 32 MiB、预览 128 操作/128 MiB 等预算；通过小字段扩展而非把大正文塞 observation。hash/source 不符不能使 journal 历史重新“认证”。

## 9. 私有 Descriptor 与 B plan 拒绝

新增 `restoreDescriptor(scope,ref)` 只在 server store 私有 API；无 HTTP/renderer 出口。要求完整有效 runtimeOwner 与登记备份同 owner，ref已由 restorePut 注册，复用 restoreRead/verifyRef 的 ACL、无链接、长度、预算、digest 验证。返回私有对象路径和观察身份，**不是句柄 pin、授权令牌或未来 writer 的免复核证明**。历史不同 generation/dormant descriptor 不自动获得权限；后续需求须另行设计。

错误 scope、未注册/损坏 ref 明确拒绝；真实 Windows private ACL 路径与 fixture 路径分别测试。公共 summary/query不含 observation、helper hash、descriptor路径或 full SDDL。

store.applyCreate 对带 providerId、B profileId 或 write_original action 的计划明确拒绝；本轮没有创建可执行 B plan。A endpoint/router/service 未改；客户端伪造新字段不能进入写回。旧A的 prepare/apply/recovery 功能仍只在原资格下运行。

## 10. Legacy A 与作用域证据

git差异确认 metadata/writer/service/authority/routes 与 HEAD 无变化；metadata_audit_unavailable、完整 metadataCheck、strict unavailable 保留。P33.3算法未改，67/67相关验证；新的 B字段仅私有capture，query/public API仍白名单投影。

classic与managed通过server.js既有工厂注入，同九字段 owner/workspaceFingerprint 绑定。store/bridge测试包含不同 owner/epoch拒绝、journal reopen、来源漂移与旧记录兼容；真实 Pi 两个worktree scope仍隔离。退出/重开不是自动回填历史object metadata；不兼容 Pi 的既有来源拒绝没有放松。

## 11. P33.5a 与打包回归

public GUI无修改。源码及重建打包版分别实际安装 Pi RPC **24/24**、真实 Electron **7/7**、失败0/跳过0/退出0；包括classic/managed/dormant、菜单焦点、窄窗口、Escape焦点返回、列表顺序、renderer零错误。仅独立TEMP，未请求真实模型或恢复按钮。

截图：`.shots/p33-5a/source-empty-1200.png`、`source-empty-720.png`、`packaged-empty-1200.png`、`packaged-empty-720.png`；实际查看打包720截图。证明现有只读空态回归，不冒称全部DPI/内容场景/P33.5b。

已运行 `npm run build:app -- --rebuild`，退出0，入口234.9MB、整包328.0MB，随包observer hash与源一致；新asset也写入SEA manifest。独立fresh TEMP执行 fixtures→app-check **26/26**、退出0。首轮app-check缺PDF fixture产生19/21与上传缓存失败，保留为前置环境失败，未改断言。独立SEA新observer全面链路未验证；本次已完成Electron打包入口与源码的实际回归。只生成本地忽略构建产物，未改已发布资产/版本/tag。

## 12. RED、修复与独立审查

新 profile缺实现：0/1 RED；proof/SACL形状47/49 RED；refs长度/metadata变化51/53 RED；Unicode路径54/55 RED。证据字段缺实现产生 assertion失败后实现。均先复现再修复，没有删旧断言。

按 requesting-code-review 进行独立只读安全复审：修复打包asset缺口、proof来源/匹配、SACL known类型、ref长度与metadata比较。额外真实observer→bridge→store→reopen临时链验证通过；旧store36、bridge24、tools31及revert-store14复审通过。审查不是平台资格，也不替代完整npm测试。

## 13. 已知限制

只读观察不是一致性事务；各metadata在不同瞬间读取，父链/主流内容重核不能证明排他。读取可能更改访问时间，编译缓存是额外系统副作用。没有取得特权SACL读取、本轮特殊ACE/平台/驱动、长期soak、POSIX、实际新B打包writer或自然存储故障证据。

同用户恶意代码/管理员可修改安装文件或私有材料，不把ACL/私有token称为OS沙箱。native不可用、预算不足/超时/不支持时不会开资格；可能增加启用capture时PowerShell读取开销，未做大规模性能资格。未宣称普通用户的完整metadata保持或实际恢复可用。

## 14. 全量测试与最终状态

开发前完整基线107命令，退出0、928.796秒；source hash未变的旧特权研究不重复。新增两个canonical suite使test链109命令。

专门测试：profile55/55（含真实NTFS、ADS/EA、Unicode、副作用）；object evidence12/12（普通Windows真实private ACL另列为真实case）；旧store36/36，bridge23→24、tools30→31，algorithm67/67、revert-store14/14，原断言无减少。真实Pi1.0.4 fixture stream27/27（旧26+新1），没有真实模型。

首次最终全套在新增Unicode边界发现后主动中止，不能当成完整通过。修复后的最终 **109个串行canonical命令全部完成，退出0，耗时910.991秒**；P33 **20套件合计569/569、失败0、跳过10**。500→569来自profile55、evidence12、bridge+1、tools+1，旧断言未减少。

| 最终P33分组 | 实际通过/执行 | 失败 | 跳过 |
|---|---|---|---|
| SACL独立工具（npm默认探测） | 0/0 | 0 | 8：本机无SeSecurityPrivilege，未执行真实八组 |
| D1 profile / evidence | 55/55、12/12 | 0 | 0 |
| P33.2 store / bridge / tools | 36/36、24/24、31/31 | 0 | 0 |
| P33.3 algorithm / store / HTTP / integration | 67/67、14/14、65/65、19/19 | 0 | 0 |
| P33.4 writer / recovery / admission / apply | 22/22、24/24、15/15、29/29 | 0 | 0 |
| Windows faults | 13/13 | 0 | 0 |
| 旧原位 / 安全研究回归 | 28/28、43/43 | 0 | 2：受保护/继承非空SACL比较无权限 |
| P33.5a query / UI / startup | 34/34、27/27、11/11 | 0 | 0 |

全套另外有既有 session-search 5i 文件符号链接创建权限/开发者模式跳过1；总共11项明确环境skip，均不进入通过分子分母。本机没获得新权限，没有以mock补算真实SACL。旧原位回归仍是原研究TEMP用例，不代表D2或生产B获准。

最终日志 `.probe/p33-d1-final-revised.log`，退出码/耗时在同名前缀 `.exit/.seconds`；baseline、RED、专门profile/evidence、live、GUI、build、fixtures/app-check各有独立 `.probe/p33-d1-*` 日志。中止与前置环境失败也保留，不通过关闭测试或删断言得到结果。

HEAD/tag未变，`git diff --check`与新文档/文件格式检查通过；Legacy A核心和public源码相对HEAD无差异。不提交、不推送、不发版。D1停在人工验收；可以申请D2独立TEMP开发的额外授权，未获准生产Q1/Q2/Q3，不自动推进。

## 15. 后续授权推送

上述最终状态是完成开发时的验收快照。2026-10-13 用户随后明确要求“推送”，因此本次将 D1 业务与构建、测试入口与用例、审议与验收文档按回滚边界分别提交并推送 main。推送前 fetch 后本地与 origin/main 均为 `5f5a7a89911354e2d006252d154487a8a1007a67`，无领先或落后提交；原有未跟踪目录不纳入提交。

本次新执行只读 Profile **55/55**、版本化证据 **12/12**，均退出 0，无失败或跳过；真实 NTFS 观察仍报告 SACL unavailable、productionEligible=false，EA 非空负例实际观测 28 字节并拒绝。第 14 节完整 npm test、GUI、打包结果为同一实现的此前验证，本次未重复执行完整全套。

此次授权仅涉及提交与推送，不包含发版、修改 v0.24.0 tag、D2 开发或生产 Q1/Q2/Q3 契约批准；D1 的生产白名单与实际写回入口仍保持关闭。
