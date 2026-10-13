# P33-D2：独立 Windows Native Writer 与隔离验证

日期：2026-10-13。授权：仅 D2，独立 TEMP 文件；生产 Q1/Q2/Q3 未批准。**生产 B 不开放；特权 SACL 八组尚未验证，不能据普通令牌成功认定 D2 全部资格通过或自动进入 D3。**

## 1. 基线、范围与实施安排

开发前 HEAD `103f2ae6af6e6b8e1058f7c1dfd74d46e2bff744`，main；开发后 HEAD 不变（未提交）。v0.24.0 本地 tag `ec546d5a3711a21d2dbc911d661eb52742774be0` 不变。原有未跟踪发布目录未纳入任务、未操作。按 AGENTS 离线要求没有 fetch、查询 Release 或调用联网 Jev；本轮版本核对是本地 Git 快照，不声称新查询了远端。

已审阅 AGENTS、开发机 memory、README、P33.4d 提案/计划、D1/P33.4b/P33.4c 验收，D1 observer/profile/source/native、store、A writer/metadata，以及既有 inplace/safety/SACL witness。D1 生产白名单为空，A 的 metadataCheck 与 metadata_audit_unavailable 未更改；新版本字段仍只有记录意义。

采用已有 D1 descriptor、同一私有 store 与只读 observer，不新建对象库或恢复注册中心。按用户批准的 D2 规格依次：拒绝入口 RED → 私有进程与 native 核心 → 普通令牌 C/R 与元数据 → 故障/竞争/协议负向 → 严格 SACL 探测 → 打包来源与完整回归。D3 intent/Stop/drain/HTTP 不在此安排内。

## 2. 文件清单与生产隔离

| 文件 | 责任 |
|---|---|
| 新 server/session-revert-object-writer.js | 正式 export 固定拒绝；未导出的 TEMP 测试核心、绑定、材料复核、进程协议与结果校验 |
| 新 server/session-revert-object-write-native.ps1 | 独立 Win32 原句柄写入；没有 setup/fault/元数据 setter/提权模式 |
| 新 tests/fixtures/session-revert-object-harness.cjs | 新鲜 TEMP root 登记、WeakSet 能力、测试内存导出、真实 store/descriptor、失败材料保留 |
| 新 tests/session-revert-object-writer.cjs | 普通令牌格式/大小/四属性/C→R→C、元数据、算法与正式图隔离 |
| 新 tests/session-revert-object-faults.cjs | API/进程/协议故障、真实外部进程竞争、材料损坏与二次失败 |
| 新 tests/session-revert-object-witness.cjs | 新核心八格见证；旧工具仅构造/观察元数据 |
| scripts/build-exe.mjs、scripts/build-app.mjs | 仅增加静态 revert-object/write.ps1 asset |
| package.json | 三个日常 suite 进入唯一 test 链，109→112；无版本/依赖变化 |
| 本文 | 限定验收、证据与剩余阻塞 |

正式模块仅导出 `openOriginalAttempt`，任何调用固定抛 production_allowlist_empty；没有 factory、测试 token、环境开关或 executable provider export。`createIsolatedWriter` 未导出、未被 server.js 导入。测试加载受审阅模块源码，在内存增加私有导出，并将固定相对 import 解析到本仓库；这个 loader 不进入产品包。

测试能力只能由 harness 为自己 mkdtemp 的 active TEMP root 签发，WeakSet 身份、冻结 root/scope/plan 及撤销状态在 open/commit 校验。extras admission 只存在该测试 harness；发布 helper 没有 force、ignoreMetadata、privilegedOverride。产品入口及空白名单拒绝命名 ADS、非空 EA；见证 extras 不能产生生产 B plan。

对照 HEAD，A writer/metadata/service/authority/routes、D1 profile/observer/native/source、store/bridge、server.js、public 及 P33.3/Git 实现无差异。既有服务无法创建/执行 B plan，HTTP/renderer/Pi 无新增调用点；不开放实际撤销按钮。

## 3. 协议、来源和资源边界

内部 `open({authority,relativePath,currentRef,candidateRef,expectedObject,proofId})` 返回 attemptId/bindingDigest/ready 及 commit/cancel/close。调用者只在测试中持有 capability；这不是正式产品 API。后端生成 UUID attemptId、32 字节随机 nonce。SHA-256 绑定 plan/revision、完整 scope、相对路径、C/R digest/长度/对象身份、期望 observation、proof 与实际 writer helper hash。

顺序只有 open→ready→一次 commit 或 cancel→result→进程关闭。严格键集合、版本、nonce/attempt/plan/revision/binding 检查；commit 后必须 EOF，第二条指令使 native 在写入前拒绝。JS 也拒绝重复/撤销/跨 attempt/错绑定，异步材料复核后再次检查状态。仅收到 JSON 不够：正常退出、完整 stdout、正确终态、R digest/长度、原 ID/Creation/父链与有限元数据均满足才接受 verified。

系统 PowerShell 使用可信运行环境 SystemRoot 下 System32/WindowsPowerShell/v1.0 的绝对路径，lstat 拒绝解释器祖先 symlink，cwd 固定其系统目录；NoProfile、NonInteractive、windowsHide、shell:false。SystemRoot/安装源属于可信运行环境假设，不宣称抵御能修改整个应用/系统环境的同用户恶意代码。

完整 interop 源首次直接放入 EncodedCommand 超过 Windows 命令行预算（spawn ENAMETOOLONG）。改为固定有界 bootstrap，从 stdin 接受后端固定静态 helper 的 base64 bytes，核对绑定 hash 后创建 ScriptBlock；不执行项目脚本、不接受客户端 PowerShell、不信任共享 TEMP 缓存、不下载 helper。故障 adapter 只在测试内存替换指定 API 边界，输出不同 hash；没有发布故障命令。

helper≤24 KiB，base64 首行≤32 KiB；open JSON≤32 KiB，observation≤16 KiB；总 stdout≤64 KiB，stderr 丢弃，不转发路径/正文。ASCII Unicode escape 保持中文/emoji，不改系统编码。宿主总 deadline 30 秒；stdin 单行解析有界。文件≤2 MiB，64 KiB 分块，父链每条≤128，流≤32/每流≤2 MiB，EA buffer≤64 KiB；ReadBytes 检查 helper WorkingSet≤256 MiB。这是调用点/逻辑预算，不是 OS Job 硬内存沙箱；Add-Type 编译器和系统调用阻塞仍依赖宿主终止。超限或无法确认结果拒绝/进入非持久 recovery_required。

## 4. Native 权限、身份与材料

目标 CreateFileW：OPEN_EXISTING、OPEN_REPARSE_POINT/BACKUP_SEMANTICS、access **0x12008b**（READ_DATA、WRITE_DATA、READ_EA、READ_ATTRIBUTES、READ_CONTROL、SYNCHRONIZE），share=0。不申请 WRITE_DAC/WRITE_OWNER/WRITE_ATTRIBUTES/WRITE_EA。父目录只读属性，share=3 禁止 delete/rename；材料只读 mask0x120089/share=1。另有现有令牌的只读 SACL query mask0x01020080，不调整权限。

API：CreateFileW、GetFileInformationByHandle、GetFinalPathNameByHandleW、GetVolumePathNameW/GetVolumeInformationW/GetDriveTypeW、ReadFile、SetFilePointerEx、WriteFile、SetEndOfFile、FlushFileBuffers；元数据仅 GetSecurityInfo/SDDL conversion、FindFirst/NextStream、NtQueryInformationFile/FileEaInformation 与 NtQueryEaFile。没有 rename/replace fallback、属性缓存回放、ACL/EA setter。

从卷根到目标父目录及两份材料的全部祖先逐个 pin，拒绝 reparse，检查实际 handle 的 canonical path/ID/目录类型，再重新按名字观察身份；目标检查普通文件、单链接、固定本地 NTFS、ID、Creation、容量与字节。ready 父链 ID 必须与 D1 observation 一致。获取整条链不是 Windows 路径 CAS，获取之间及最后检查到写入仍存在竞争；主流 share=0 不代表元数据全对象排他。

使用 store.restoreDescriptor 重新取得同 owner 登记 C/R，核对 dev/ino/birthtime、链接、长度与预算；native 通过只读 pin、64 位 file index、私有 ACL/Owner allowlist 与内容 hash 再核验。材料原句柄保持，commit 前/成功后重查 ACL 与 C/R 内容；后端 commit 前再次调用 descriptor。路径不是永久授权，未复制 C/R 到不计费 inputs 或环境变量。

内容流程：ready 前确认当前 C 与持久 C 一致且 C/R 为有效 UTF-8；ready 持有句柄。commit 再确认 C、身份、路径、有限元数据及材料；逐块处理实际 count/short write，设置 EOF、flush，同句柄完整读回 R，复核对象与元数据。finally 释放句柄，宿主只在进程关闭后返回确认结果。没有整文件原子性或断电事务保证。

## 5. 元数据保持的实际范围

| 元数据 | 本轮证据与边界 |
|---|---|
| ID、卷、单链接、Creation | 实际目标 handle/前后观察复核；同 ID 不用于推导全部元数据保持 |
| Owner/Group/DACL | 普通令牌 protected/inherited fixture，真实 C→R→C 比较；不外推任意 Owner/特殊 ACE |
| SACL/完整 SDDL | 普通令牌 unavailable/null；新八格未验证，不把 unknown 伪造为空或比较成功 |
| ADS | 全枚举；见证真实 :probe 内容 hash 与 old read-only observation 比较；正式 admission 拒绝命名流 |
| EA | 真实非空 28 字节，查询完整 EA buffer digest 与前后 fixture EA 比较；正式 admission 拒绝非空/未知 |
| 属性 | 32/34/8224/8226 分别真实 C→R→C；不回放 Archive 或外部属性 |
| 时间戳 | Creation 纳入一致性；lastWrite、lastAccess 观测但不要求原值保持，写/读可改变这些时间；不修复时间戳 |

Snapshot 的有限 metadata signature 比较 Creation、ID/链接、属性、Owner/Group/DACL/SDDL、可读 SACL 状态/值、EA 长度/hash、ADS 名称/hash。Unknown SACL 只证明仍不可读，**不证明 SACL 没变**。未观测的 MIC/resource/scoped-policy ACE、其他 NTFS 信息、审计事件历史、驱动/映射写与不可读 SACL 变化没有资格。

## 6. 严格 SACL 八组

执行 `node tests/session-revert-object-witness.cjs --require-audit`，使用当前 helper 路径；当前 Windows **10.0.26200.0/x64/固定本地 NTFS**，普通令牌无 SeSecurityPrivilege。最终严格命令 **0/0、失败0、跳过8、退出2**，reason existing_token_sacl_unavailable；八格均 unverified。没有自动提权、尝试赋予新权限或更改审计策略。

| SACL | 受保护 DACL | 继承 DACL |
|---|---|---|
| 显式 | 未验证 | 未验证 |
| 继承 | 未验证 | 未验证 |
| 受保护 | 未验证 | 未验证 |
| 混合 | 未验证 | 未验证 |

新工具只有权限前提满足时才构造八格，然后调用**新 helper 同一核心** C→R→从 reopened store 的持久 C 新 attempt 恢复 C。旧研究工具只调用 setup/observe/compareWitness，没有旧 write/exercise；要求完整 SDDL/SACL/DACL/Owner/Group/ID/ADS/EA/attrs/继承保护位及 C/R SHA。未执行的分支不能计成功。

P33.4c 的 Windows26100 旧研究 8/8 不是本 helper 资格；没有运行新的特权 CI、不能外推同 OS 双令牌、8226 一个样本或旧 source hash。阻塞具体是：缺少已有授权且权限启用的 NTFS 环境，为最终新 helper/hash 提供无 skip 的八格实测。

## 7. 普通令牌、故障、竞争与材料

普通真实场景包括 UTF-8 LF、BOM/CRLF、混合换行、空文件/增长、1KiB/64KiB/2MiB、Unicode 路径、四种属性、单链接既有文件、protected/inherited 元数据以及持久 C 恢复。2MiB C digest `c4692ef80a4902caff3480ac025219af54f826df25ab29ea1c2634b1e958880e`，R digest `8f3a655ca195e10693aee21a54719ca92ce1322938e8a7a25355aaa569e78189`。

P33.3 合成完整 record 测试独立用户修改保留后实际写回，重叠修改拒绝；没有真实模型或 Pi→GUI→确认→恢复生产闭环。首次该 fixture 缺 createdAt/sequence/gap 导致 refused；依据既有算法记录结构补齐夹具，未改算法/断言。

| 故障/竞争 | 新核心验证方式与结果 |
|---|---|
| WriteFile 首次/部分后、EOF、flush | 测试内存 adapter 用只读 DuplicateHandle，真正 API 返回访问拒绝5；不是自然磁盘故障 |
| short write | 限小实际 WriteFile 请求，循环完成 R；非自然 NTFS 短写 |
| 写前/中/完整写后退出 | 真 native 进程退出；commit 已发送但没有可靠完成则 recovery_required，即使 C/R 正确也不升格 |
| timeout/坏 stdout | host deadline/格式拒绝，已发送 commit 的不确定结果保守分类 |
| Native 错 nonce/attempt/版本/字段/命令/重复/超限 | 直接 tamper 子进程 stdin，验证 native 拒绝、C 不变；另有 JS cancel/撤销/重复 guard |
| ready 前 D、替换身份、链接/路径/材料异常 | 拒绝，不覆盖 D，不清除只读属性 |
| 外部 ADS/DACL/属性 | 真实独立进程可改变，提交前 signature 检查拒绝，外部元数据不被回放覆盖 |
| 持有期间主流写/目标/父目录 rename | 新核心真实外部 Node 操作检查共享错误；不推广到全部 NTFS metadata |
| 二次恢复失败 | 新 attempt 备份中间 D，故障再发生；原 C、R、中间及第二次观测材料可重开 |

实际 C=`CCCCCCCC`；部分 D=`RRCCCCCC`（8字节、SHA `244c9a8b7733da1df7e40e163de2052168e98553da964bb54d774da1cf0776bb`）；EOF失败 D=`RRRRCCCC`（8字节、SHA `48eb8d8c2e73fd567e3eb32793af73b4ae4000a6b7d6755cf8f48f06bab65a8d`）；flush/完成返回缺失时可有完整 R=`RRRR`（4字节、SHA `ad49738ddc9ea282f541a4d462213ce512bde2d3a9aeb89ff414a34398985d30`）。都是合成数据，不能称整文件原子恢复。

失败用例将实际 partial/D 再存入**原 store**，保留 TEMP 根中的 C/R/观测对象；私有本地 `.probe/p33-d2-retained-materials.jsonl` 是检查索引，未进入 native stdout、HTTP、Git 或正式产品状态机。用例另模拟外部新 D，重开只读材料，不自动重试/恢复/覆盖 D。成功 fixture 清理自己的 TEMP；保留材料的 root 不自动清理，供人工检查。

新代码只返回 `durable:false` 的保守结果分类。没有生产 intent、completion journal、Stop/drain、恢复确认或 durable recovery_required。既有 P33.4b 日志失败研究由完整 canonical 回归复核，不把测试器的计划/索引冒充 D3。

外部 ADS 初始夹具使用 .NET Framework File.WriteAllText，因 ADS 路径不支持而退出1；未触及 writer。改为已有证据支持的独立 Node 写 ADS，保留拒绝断言。API/进程注入、外部真实操作、Mock/旧 metadata fixture 与自然错误分别记录；未制造真实磁盘满、断电、存储损坏或自然短写。

## 8. 测试、来源与打包证据

开发前 canonical 109 命令退出0，日志 `.probe/p33-d2-baseline.log/.exit`（该次未记录独立 stopwatch）。新增 suite 不删除旧断言。初次 module 缺实现为 RED；初次 helper 缺文件为 RED，之后命令行预算与上述夹具失败保留在本地日志。

修订 standalone writer **19/19、退出0**，日志 `.probe/p33-d2-writer-revised.log/.exit`。首次 faults 运行在 ADS 夹具错误处失败，不能视为完整通过；最终实现和协议新增项以完整 canonical 新运行为准。

最终 **112 个唯一 canonical 命令全部完成，退出0，耗时1939.630秒**，日志 `.probe/p33-d2-final.log/.exit/.seconds`。P33 **23个套件合计633/633、失败0、skip18**；skip 不进入分子分母：旧 SACL8、旧 inplace2、新 SACL8。全仓另有旧 session-search 符号链接权限 skip1，总环境 skip19。旧断言没有减少，569→633来自新 writer19与faults45；新 witness 未执行的八格不计通过。

| 最终 P33 套件 | 实际通过/执行 | skip |
|---|---|---|
| D1 profile / evidence | 55/55、12/12 | 0 |
| P33.2 store / bridge / tools | 36/36、24/24、31/31 | 0 |
| P33.3 algorithm / store / HTTP / integration | 67/67、14/14、65/65、19/19 | 0 |
| A writer / recovery / admission / apply | 22/22、24/24、15/15、29/29 | 0 |
| 旧 Windows faults / inplace / safety | 13/13、28/28、43/43 | inplace2 |
| 旧 SACL witness | 0/0 | 8 |
| query / UI / startup | 34/34、27/27、11/11 | 0 |
| 新 object writer / faults | 19/19、45/45 | 0 |
| 新 object witness | 0/0 | 8 |

新45项包括10个API/进程/协议注入，JS绑定与取消2项，直接Native协议7项，身份/材料/格式/metadata准入21项，外部metadata3项，共享限制1项、二次失败1项；每个case可以包含多个校验，不把Mock校验数量当平台资格。完整 npm test 包含上述真实 Win32、旧研究、纯算法、HTTP/DOM、元数据fixture等不同层次；没有新真实模型或GUI恢复闭环。

最终 helper SHA-256 **7D773B63777D97A6A78D9A81C37CF946929062B22028425889258BECD3AA39EF**，D1 readonly helper 未改。Electron 资源与 SEA manifest 只静态包含 write.ps1；writer 未注册、未进入正式服务执行图。

`npm run build:app -- --rebuild` 最终退出0，入口234.9MB/整包328.0MB，日志 `.probe/p33-d2-build-final.log/.exit`。最终 source/packaged helper 与上列 SHA 完全相同。Node TEMP 编排器消费最终 Electron资源，同核心 C→R→C **3/3、退出0**，日志 `.probe/p33-d2-packaged-core-final.log/.exit`；它不是 Electron/SEA 正式服务入口测试。早期 c2cf0438…/bf0464a7… 的3/3是开发快照，不作为最终 source hash 资格。

该额外 TEMP 样本建立自己的 Git fixture，C→R 与 R→C 后真实 `.git/index` 字节和 HEAD 均保持；index SHA `82139c23180a19e76cde14fcd1b91ac325a99d396bb6a881ba3e379def94216d`。Git初始化/fixture提交只发生在新建 TEMP，未对本仓库提交。此额外 probe 是来源/Git只读对照，不是 canonical计数的新增分子。

保留材料在独立新 Node 进程重新核查：**11条检查索引、10个保留TEMP根、33个引用回读全部正确、退出0**，日志 `.probe/p33-d2-retained-check.log/.exit`；索引记录明确 productRecoveryJournal=false、automaticRetry=false。成功/失败材料与确认仍是测试编排，不宣称生产保留期、磁盘损坏或D3恢复状态机已实现。

完整 Electron source/packaged 写入集成、SEA执行、managed runtime、真实 GUI 闭环留待获准 D4/D5；GUI源码无修改。现有只读GUI query34/UI27/startup11及HTTP65回归通过，既有源码/只读能力未改，不新增本轮恢复按钮截图或冒称人工恢复闭环。

独立 requesting-code-review 审查未发现正式入口泄漏；修正解释器路径和 Native 协议覆盖。复核不替代实测，审查时的资源 hash 属于其快照。

## 9. 验收判断与下一阶段

**实现可提交 D2 人工审阅，完整 D2 安全资格尚未完成：新 helper SACL 八格没有真实执行，不能开始 D3。** 当前唯一新实测平台为普通 Windows26200 x64、本地 NTFS；无新 Windows26100/特权证据，无 POSIX、自然存储错误、长期 soak、特殊安全描述符或系统恢复保证。

需要下一次独立已授权环境交付：最终 helper/hash、相同 core 和权限/协议的八格 C→R→C，无失败/skip；普通/特权适用性明确。D2 人工验收也不自动批准 Q1/Q2/Q3；D3 另行授权与对应契约审批仍必要。若该环境无法获得，保留只读预览及备份材料，不以继续增加 Mock 数量解除阻塞。

本轮停止于 D2：不提交、不推送、不发版、不修改 tag、不进入 D3；材料只包含 harness 自己新建的 TEMP 合成数据，不使用用户真实工程作为 writer 目标。实现、回归及打包生成文件属于本任务授权开发操作，不等于操作真实项目的恢复 API。

## 10. 后续授权推送

上述 HEAD 与停止状态保留 D2 开发交付时的快照。2026-10-13 用户随后明确要求“推送”，据此将业务/构建、测试入口/用例、验收文档分别提交并推送 main；推送前 fetch 后本地与 origin/main 同为 `103f2ae6af6e6b8e1058f7c1dfd74d46e2bff744`，无领先或落后提交。原有未跟踪发布目录与私有 TEMP 失败材料不纳入提交。

此次只授权提交与推送，不代表新 SACL 八组资格通过、Q1/Q2/Q3 批准、D3 授权或发版。前述完整112命令结果来自同一实现的开发验证，本次未重复完整全套。推送前另执行最终 source/packaged 同核心 TEMP C→R→C **3/3**，检查 helper SHA 相同、Git fixture index/HEAD保持，日志 `.probe/p33-d2-push-check.log/.exit`。生产白名单继续为空，正式入口固定拒绝；v0.24.0 tag 不变。

暂存检查发现默认 text/eol 规则会将本轮生成的 helper CRLF 转为 LF，从而改变上述已实测 SHA。推送时额外在 `.gitattributes` 对此单一 helper 设置 `-text`，保留已验证字节；不修改 helper 内容、不禁用文本 diff。该文件的 whitespace 属性保留 blank-at-eol/blank-at-eof/space-before-tab 检查，并明确识别实际 CRLF（cr-at-eol）。重新按属性暂存后，blob 与工作文件的 SHA-256 均核对为 `7d773b63777d97a6a78d9a81c37cf946929062b22028425889258becd3aa39ef`，git diff --cached --check 通过，避免以不同资源字节交付原测试证据。
