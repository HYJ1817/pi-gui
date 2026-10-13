# P33.4d：受限原对象恢复实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: use executing-plans within the human's stage-specific authorization. D1 may be authorized independently for read-only development; Q1–Q6 are not a blanket prerequisite for D1. D2 requires a separate explicit TEMP-only authorization. Production Q2/Q3 risks require separate approval. Every stage stops for acceptance; no automatic commit, push, release or advance to P33.5b.

**Goal:** 在获准的新契约下，为新版本证据的单个既有文本文件提供受限 R 写回、失败材料和重新确认 C 恢复。

**Architecture:** A 的 writer/metadataCheck 保持，新增独立 B provider、profile、编排服务与路由；复用当前 P33.3 计算、store、P32 authority/admission/Stop。renderer 只提交固定选择和确认，不能提交路径/字节；native 只接受受信任后端的有界私有协议，不接收 HTTP。

**Tech Stack:** 现有 Node HTTP/native ES modules、Windows PowerShell + 受限 Win32 interop、Electron；零新增第三方依赖，无自动提权或联网运行依赖。

**状态：生产契约待审批；D1 已单独授权实现，待人工验收。** 基线 `5f5a7a8`，v0.24.0 源基线 `ec546d5`。本文最初只写方案；后续 D1 的只读模块/字段/测试实现见 [D1验收](p33-d1-acceptance.md)，其余阶段仍是未执行计划。

## 1. 非循环前置与阶段授权

开发前必须有：本阶段明确授权、已有研究证据审阅、当前源码/HEAD 状态核对，以及独立 TEMP fixture 的工作安排。D1 只读观察/证据开发不要求 Q1–Q6 全部批准；D2 另行明确授权，只允许 TEMP 原位写入。生产元数据资格变化与部分覆盖风险仍需 Q2/Q3 单独审批，其他生产条款也不因阶段研究获准。既有八组研究不是生产 helper 资格，不要求未实现的 provider 先通过全部生产测试才能开始获准的隔离开发。

开放前必须有：实际 production helper/hash/权限/协议的平台资格、全部负向拒绝、恢复失败处理、多会话及源码/打包 GUI 闭环。审批开发不等于通过这些门槛。所有阶段都默认 production capability 关闭；D6 的人工验收决定是否允许进入 P33.5b/开放，发版是另一道授权。

本计划不要求重做已覆盖的研究错误案例。将既有案例用于 production adapter 回归，缺少实际 adapter 证据才补测试；Mock、注入与真实平台结果分别计数。新的 canonical suite 必须加入 package.json 的唯一 npm test 链，不在 CI 复制第二套子测试命令。

## 2. 模块地图与接口

| 模块 | 未来改动与责任 |
|---|---|
| 新 `server/session-revert-object-profile.js` | profile/平台 manifest/资格纯判断、observation 规范化；不写目标，不使用 legacy supported 提升资格 |
| 新 `server/session-revert-object-native.ps1` | 生产受限 observe/ready/commit/readback；没有研究 setup/fault/属性修复入口 |
| 新 `server/session-revert-object-writer.js` | 私有 native 进程、协议/身份/预算、stage 生命周期与结果校验；独立注册，exclusive=false |
| 新 `server/session-revert-object-service.js` | B 单文件 prepare/apply/cancel/recovery，风险版本和 proof 绑定；不复用 A.metadataCheck 的例外分支 |
| 新 `server/session-revert-object-routes.js` | 独立认证后的 `/api/session-revert-object/*`；固定字段与原因投影 |
| 新 `server/session-revert-object-recovery-reader.js` | 正常 store 不可打开时，只读验证 journal 完整前缀中的已授权 plan/refs 与私有对象；不修复、不追加、不取得写回资格 |
| `server/session-change-store.js` | additive 新证据字段/不可变 plan 绑定、材料 descriptor、预算/引用 pin；保留同一 ledger 与对象库 |
| `server/session-change-bridge.js`、`server/session-runtime.js`、`server.js` | 实际 capture 前后 B observation 注入、provider 注册/关闭配置、reuse authority/Stop 组合；不改 Pi 本体 |
| `server/session-revert-routes.js` | A/B plan 路由隔离拒绝检查；A 的旧请求语义不变，不改 `session-revert-service.js` 的 metadataCheck 或 writer |
| `public/api.js`、`public/session-changes-panel.js`、`public/app.js`、`public/runtime-conversation.js` | B 能力投影与选中单文件流程，复用现有 pane/modal/菜单；不改 Git restore 语义 |
| `scripts/build-exe.mjs`、`scripts/build-app.mjs`、`lib/assets.js` | native 静态资源/manifest/source-packaged 定位，不下载 helper，不加载用户项目脚本 |
| 新及既有 `tests/session-revert-object-*.cjs`、P33/GUI/打包测试 | canonical fixture 与 opt-in 平台/真实 Pi 产品验证；不减少原断言 |

当前面板入口是 `public/session-changes-panel.js:40` 的 `openSessionChangesPanel`，菜单由 app/runtime-conversation 接入；实施时复用这些边界，不创建重复 UI。本方案的职责划分不授权重构整个 P33。

拟定私有接口（只规定契约，不是生产实现）：

```js
// object-profile: return observations and a separate qualification decision.
evaluateObjectProfile({ evidence, current, platformProof, helperHash });
// object-writer: open original object and hold attempt until server commits/cancels.
openOriginalAttempt({ authority, relativePath, currentRef, candidateRef, expectedObject, proofId });
// store: authorized, private-only, already readback/ACL checked material location.
restoreDescriptor(scope, ref);
// attempt operations, owned by backend, never callable by renderer:
attempt.commit({ planId, attemptId, intentRevision, bindingDigest });
attempt.cancel();
attempt.close();
```

`evaluateObjectProfile` 输出 `{observations, qualification:{eligible,reason,profileId,proofId,helperHash}}`；SACL unavailable/null 保持原值。`openOriginalAttempt` 返回绑定对象身份、C digest、可观察 metadata 和随机 attemptId 的 ready；成功 commit 返回 bounded verified result。接口必须在对应阶段定义和测试，不能在 UI 用接口名字替代后台检查。

## 3. 固定数据与状态契约

- evidence 增加 `objectEvidenceVersion:1`、`beforeObjectEvidence`、`afterObjectEvidence`：profile、helper/proof 版本、volume/file ID/link count、路径链绑定、可观察 Owner/Group/DACL/属性、流枚举/EA 状态、SACL 可见性。旧 beforeMetadata/afterMetadata 保留原义，缺字段只读；不能以当前观察重造旧 capture 元数据。
- B plan 增加 `providerId:'windows-original-object-v1'`、`profileId/proofId/helperHash`、风险版本 2、固定单个 fileId、scope/generation、revision/gap、C/R refs、immutable object binding、TTL≤60 秒。B 采用 `action:'write_original'`；provider/profile/proof/身份/refs 在 plan 更新时不可改。
- 复用 store 的 `prepared → replacing → applied_verified | recovery_required` 和 `not_applied`，不新增“字节等于 R 所以已完成”的终态。B 的 replacing 是持久“原对象 mutation intent”状态，plan.providerId/action 明确区分，UI 不显示成 rename；旧格式 decoder 的中断恢复保持 fail-closed。
- A endpoint 明确拒绝 B plan，B endpoint 拒绝 A plan；旧 v0.24.0 客户端/包不得执行 B plan。B plan 不伪造 legacy currentMetadata supported；必须实测旧包读新材料、拒绝写回与材料可读取边界。若旧包不能读取新 schema，应给出版本不支持而不重写 journal，提供新版本的只读导出退路。
- 公共接口只给 provider 状态、固定原因、相对路径、diff、backupReady、结果及显式材料导出。完整 SDDL/SID、原始 C/R、对象绝对路径、tokenHash 和 child stdout 不进入 SSE/日志/DOM；diff 和用户显式下载材料沿用既有受授权出口。
- 失败材料被持久 plan pin。成功 C 备份最低 7 天；当前 GC 比这个下限更保守，没有按期清理实现，不能在 UI 承诺恰好七天删除。recovery_required 永不自动过期清理。

## 4. D0：契约与执行边界确认

**可修改：**本提案/计划和该阶段独立验收文档；不修改生产代码。

- [ ] 记录当前阶段的明确授权与支持平台候选；Q1–Q6 的生产批准/修改/拒绝另行记录，不将“继续”解释为全部批准。
- [ ] 核对 `git status/log`、本地 v0.24.0、指定代码与已有 8/8/普通令牌证据，记录实际基线，不自动覆盖用户文件。
- [ ] 确定 TEMP fixture、可用特权见证环境与不自动获取权限的规则；新增 helper 后需要同路径重验，当前不重复旧八组。

**验收：**阶段授权可追溯且边界清楚；既有平台证据被分层记录。**停止：**没有 D1 单独授权则不执行 D1；没有 D2 TEMP 授权则不执行 D2；Q1/Q2/Q3 未批准则不开放生产 B。若最终要求仍为整文件原子/每次完整 SACL 读取，选择 C 停止生产 B 路线，不禁止另获准的只读开发。

## 5. D1：只读 profile、证据与负向准入

**前置：**D1 明确独立授权及本阶段边界修订；目标恢复写入禁止，不视为 Q1/Q2/Q3 获准。

**可修改：**新 profile/native 的 observe 模式、store、bridge、runtime/组合根的 opt-in capture 注入、package.json；新 `tests/session-revert-object-profile.cjs`、扩展 store/bridge/tools 测试。

- [ ] 先写负向 fixture：旧字段缺失、profile/hash/manifest 未知、unknown streams/EA/DACL、非 NTFS/网络/链接/非 UTF-8/超额/新建、gap/incomplete/过期全部拒绝；SACL unknown 原样保留、A 拒绝不变。
- [ ] 定义平台 manifest，初始没有 eligible 生产项；候选为实测 26100/26200 x64，记录 OS/补丁、API/权限、helper/proof。枚举失败不是 empty。
- [ ] 用 handle observation 核对卷/ID/链接、路径与 C，完整 stream 枚举与可靠 empty EA 查询；读取 DACL/Owner/Group/属性。将四种 Archive 组合独立列为需验资格，不把 8226 样本推成四格成功。
- [ ] 在真实 capture 前后绑定 expected bytes 和身份，写入 additive 新字段；before/prepare/settle 闭包保持同操作身份，reload/来源漂移拒绝，旧记录不补录。
- [ ] 增加 plan 新绑定字段验证与私有 `restoreDescriptor`，只从经授权的 restoreRef 返回内置对象路径/预算；native 再锁定和校验 digest，不接收 HTTP 任意路径。

**命令：**`node tests/session-revert-object-profile.cjs`，既有 store/bridge/tools 与算法套件，再 `npm test`。新增负向 case 的预期为固定 refusal、目标 digest/index/ref 不变；所有 canonical 场景执行、失败 0，平台 skip 只能记为未资格。

**验收：**真实只读 NTFS observation、完整负向矩阵、旧 evidence 查询与 A 回归；目标没有新 writer 写入；shape/hash/unknown 状态可追溯。**停止：**无法可靠枚举无 ADS/空 EA、只能复用 `:probe`、需 unknown→supported、原捕获回退无保护写、影响现有 A，则不进入 D2。

## 6. D2：独立生产 native 数据路径，仍只用于 TEMP

**前置：**D1 人工验收及 D2 单独明确授权，仅独立 TEMP 原位试验；这不要求先批准所有生产 Q2/Q3 风险，也不代表它们已批准。与正式服务/GUI 未注册，不能通过 HTTP 操作真实工程。

**可修改：**新 native/writer/profile、`tests/session-revert-object-writer.cjs`、`tests/session-revert-object-witness.cjs`、`tests/session-revert-object-faults.cjs`、package.json；不把研究脚本的 setup/fault/attributes 分支复制成生产入口。

- [ ] 定义有界私有协议、启动随机 nonce/attemptId/绑定摘要、stdout phase 顺序/大小/超时。后端根据内置路径/hash启动 Windows PowerShell，hidden、NoProfile/NonInteractive、无 shell 拼接/执行用户脚本；不可用/AppLocker 阻止→unsupported，不下载依赖或提权。同账户恶意进程/管理员篡改整个应用或私有存储不在信任保证内，不把这些 ACL/nonce 描述为 OS 沙箱。
- [ ] 取得主数据受限句柄及从卷根到目标父目录的目录链/输入对象 pin，逐个拒绝 reparse 并复核 identity；不得只 pin workspace 与最近父目录后宣称覆盖全部祖先。请求必要读写 DATA、READ_ATTRIBUTES、READ_EA、READ_CONTROL、SYNCHRONIZE，逐个核实实际权限掩码；无设置 ACL/属性/EA 权限。锁内 C、ID/link、metadata 准入再核验；pin 获取过程仍须实测竞争，不宣称 Windows 路径解析有 CAS。
- [ ] 输入只读 store 的 C/R 私有对象，readback/digest/ACL/链接预算校验；不复制裸 C/R 到环境变量，不创建不计入容量的输入副本。若实现必须复制，先增加真实分配计量/持久回收计费契约，不能偷偷绕过本方案。
- [ ] 提交前 ready 持有句柄；commit 带 attempt 绑定，原位 WriteFile 循环→EOF→flush→同句柄逐字节读回 R，观察 ID 与可观测 metadata。无 rename/ACL/Archive 修复 fallback。
- [ ] 在测试 orchestrator 中复用已有故障边界，用外部注入/测试 adapter 驱动 production native 路径；发布 helper 无接受客户端 fault/setup 参数的入口。
- [ ] 生产 helper 相同 hash/权限/路径完成普通/特权平台对照及八组 C→R→新计划 C；新 witness 比较 complete SDDL/Owner/Group/DACL/SACL/ID/ADS/EA/attrs。非空 ADS/EA 只由研究 harness 验保持，production admission 仍拒绝；不能为了 witness 暴露生产 force。

**命令：**新 writer/fault canonical 测试、既有 inplace/safety，授权特权环境执行 `node tests/session-revert-object-witness.cjs --require-audit`，普通环境执行同写入核心的 fixture 场景，最后 `npm test`。每个开放平台八组必须 8/8 无 skip；需要新的 proof，未改变的旧研究无需为证明数量重复。

**验收：**byte-exact C/R 与同一对象；8226 等开放属性各有真实样本；失效/权限/崩溃保持正确分类；实际 metadata 变化不被缓存修复；平台 manifest 从空到仅实测项。**停止：**任何不可归因为 fixture 的 metadata 保持失败、未获审批的平台外推、普通令牌需新权限、只以 ID 相等证明 SACL、物理错误导致材料无法验证，则不开放 provider。缺特权环境直接记录未资格，不获取权限。

## 7. D3：durable 单文件服务与恢复，默认关闭

**前置：**D2 人工验收、D3 明确授权及 Q1/Q2/Q3 对应生产契约审批；已有至少一个明确 production proof，方可对其平台测试完整服务。D6 前所有生产写回 capability 默认关闭。

**可修改：**新 object-service/routes/writer/recovery-reader、store、现有 routes 的 provider 隔离 guard、server.js；新 `tests/session-revert-object-service.cjs`、`tests/session-revert-object-recovery.cjs`，扩展 admission/authority/store。

- [ ] 单文件 prepare 经 P33.3 compute、完整新 evidence/profile、固定 generation/revision/gap；拒绝 created/missing/rename/delete、多文件和任何 unknown 非 SACL 字段。不修改 A service metadataCheck。
- [ ] C/R 经 restorePut/fsync/restoreRead/ACL 实际核验后创建固定 plan，计量已分配对象和应用配额，检查 bounded journal 余量并为本计划预留逻辑额度；去重不能低估新物理分配。说明预留不是磁盘硬配额，后续 EIO/ENOSPC 仍可能发生。
- [ ] prepare 复用 `createSessionRevertMutationAuthority`：先解析后释放 lifecycle authority，再 Stop/drain，后取得 authority；避免 Stop 期间阻塞 extension settle。managed cleanup 未确认/cli/planner busy→active_writer，不绕过。
- [ ] apply 校验 provider/token/request/风险版本/单文件范围，native ready 后再次 revalidate 与锁内 C/metadata；store 持久 replacing intent 成功才 commit。自行产生 journal revision 要更新 expected，外部变化不得自动接受。
- [ ] EOF/flush/byte/metadata 后验成功且 applied_verified 持久才完成；intent 后 child/协议/日志不明→recovery_required。journal 写坏时不能保证还能追加失败记录，持久旧 intent 重启必须恢复为 recovery_required，材料 pin。
- [ ] 真实模拟 journal 部分尾行/完成追加损坏，而非只在 append 前抛 EIO：正常 store 必须继续拒绝打开。独立 recovery-reader 在 32 MiB/深度/节点/引用预算内验证完整 envelope/hash 前缀，只采用其中合法且当前 authority 授权的 plan/restoreRef，核验私有 ACL、无链接、长度/digest；返回不确定状态与显式材料导出。不截断/改写 journal、不提升全账本 integrity、不调用 apply；没有足够前缀/引用或对象损坏则拒绝具体材料。
- [ ] cancel/TTL/切 scope 在 intent 前零写并释放 lease；intent 后 cancellation 不承诺回滚，等待受控退出/分类，不提前释放活跃 writer admission。重复 transport/request 共用同次结果，无 native 二次启动。
- [ ] recovery read-only 展示当前 D→保存 C；先保护/备份 D，再新 plan/token/确认；旧失败 plan 永不改成“自动恢复成功”。对象/路径/metadata 不支持或权限丢失→停止写，仅显式导出实际材料到新位置。
- [ ] journal 损坏导致正常 store 不可写时，不能创建新的自动恢复计划；先使用上面的只读材料出口，人工处理日志的流程另行批准。只读材料读取不意味着当前 D 已知或 B 恢复资格成立。
- [ ] 同对象 recovery_required 阻止新本功能 apply，直到人工处理；独立对象/聊天按正常生命周期可继续，不能永久全局锁。重启不得自动 replay 原 commit，二次失败保留 C 和各 D。
- [ ] 测试 A/B endpoint 交叉 plan 拒绝；旧 v0.24.0 包对 B plan 的拒绝和 journal 保持。若旧版本不识别 schema，报告兼容边界，不自动“修复”其 journal。

**命令：**新 service/recovery canonical、既有 HTTP/apply/recovery/admission/windows-faults、`npm test`。fixture 验证 source 且实际 native，Mock metadata 另记。生产 helper 被注入 Write/EOF/flush、完成日志/恢复日志失败、崩溃、D 改变、私有对象腐坏、预算用尽与第二次失败。

**验收：**持久 intent→原位数据→后验→durable 结果顺序可证明；失败重启可访问备份且无自动 retry；旧 A/Git/index/ref 不变。**停止：**备份未验证也能 commit、client 任意路径/字节、旧 unknown 可升级、状态靠 C/R 猜成功、未知 D 被覆盖、lease 不能排空、备份被 GC 或跨 provider 可写，均停止进入 D4。

## 8. D4：P32 多会话与 source/packaged 后端边界

**前置：**D3 人工验收；不开放产品按钮。

**可修改：**server/runtime capture/provider 接线、authority/admission 的必要测试补强、build-exe/build-app/assets、native资源 manifest；新 `tests/session-revert-object-runtime.cjs`、扩展 packaged worker/app-check/RPC。

- [ ] classic 与 managed 复用完整九字段 owner；同 workspace 其他会话已知 writer 一并 Stop/drain，另一个 workspace 不受影响。dormant/history 先由既有 P32 authority 解析，旧 owner 不可命令新 runtime；无法证明当前 generation 就只读。
- [ ] 独立 worktree 同相对文件名并行：scope/ref/plan/attempt 全隔离；关闭、移动、移除 workspace 或同路径新建均旧 plan stale，不凭路径重绑。
- [ ] source 从内置 server 资源读取 helper，packaged 从受信任 resources/app 静态资源读取；SEA 复用 asset 读取机制，但为可执行 helper 新建受私有 ACL 保护、无链接、校验 hash/identity 的专用解包路径。现有 `materializeDir` 的固定 TEMP `.ok` 缓存不是可执行来源保证，不直接信任或顺便重写 PDF 资源机制。安装路径含中文/空格、只读 resources/自定义数据目录实测。
- [ ] public.cjs 或 HTTP 静态路由不得提供私有 helper 配置/材料；spawn 来源固定、`windowsHide:true`、没有 shell 输入。用户项目同名脚本无法代替内置 helper，篡改资源哈希不匹配即 unsupported。
- [ ] 实际重新构建 `npm run build:app -- --rebuild`，如提供 SEA 则 `npm run build:exe`，运行源码与两个发布形态的 native TEMP 路径及旧拒绝；重建未过不能声称打包支持。

**命令：**runtime canonical、`npm test`、build/app-check/exe-check、source/packaged 的 object RPC fixture。各包 C/R/失败分类分别留日志，不能用 Electron 的 Node 后端替代 SEA 验证。

**验收：**两个真实隔离 scope、generation 失效、Stop/cleanup、helper 来源和打包路径全部实际证明。**停止：**串 scope、关闭后写新对象、旧 owner 接受、包路径 fallback 用户文件、源码过但包未过，禁止进入 D5。

## 9. D5：逐次 GUI 确认与意外处理，默认关闭

**前置：**D4 人工验收，并明确批准对应 P33.5b GUI 集成阶段；只在独立 TEMP 资格环境启用测试 capability。契约批准不能被解释为已自动开始 P33.5b。

**可修改：**实际 session-changes pane、api/git 菜单最小接线、局部样式；新 `tests/session-revert-object-ui.cjs` 与 opt-in Electron/native E2E。保留 v0.24.0 只读功能。

- [ ] provider 通过后台资格投影显示“备份后恢复该文件（受限）”；单文件选择、C→R diff、scope、backupReady/保留期、过期/不支持原因。内容候选不能直接解锁按钮，A 失败不自动选 B。
- [ ] 风险版本 2 逐次确认字段明确包含 externalWritersPaused、lastCheckRaceAccepted、partialOverwriteAccepted、metadataLimitsAccepted、riskNoticeVersion；仅固定 allowed keys，绑定 plan/provider/files。风险主按钮不默认聚焦，Escape/取消零提交，确认不是永久授权。
- [ ] 提示原位失败可部分覆盖、后来变化可能未备份、metadata 不作完整备份；禁止“无损/原子恢复/保证保留所有修改”。显示未保存编辑器缓冲不在材料中。
- [ ] 任何 awaited 返回前核对 selection/session/workspace epoch；确认中切会话、关闭、过期或外部 C 变化让旧 plan stale。不得延用 modal 的旧 token 发新选择。
- [ ] failure 展示 recovery_required 与已保存材料；“查看恢复方案”只读，恢复 C 必须另一次 D 备份/预览/确认；不提供重试原 apply 或忽略资格按钮。导出到新位置不直接覆盖目标。
- [ ] 真实 Electron 测试键盘 Tab/Escape/焦点返回、1200/900/720 与侧栏折叠，补 P33 完整验收所需 1280/1440/1920、125%/150%；console 无新错误，截图来自 TEMP 合成内容。Approval/SSE 历史确认重放问题必须验证不会触发 B 实际写入。

**命令：**新 UI canonical、`npm run test:session-changes-ui`、`npm test`、重建 app 后 source/packaged 真实 Electron/native E2E。API/jsdom 用例与实际鼠标/键盘/像素/磁盘读回单独计数。

**验收：**完整真实 Pi 默认 write/edit（先 fixture stream provider、另记真实模型）→预览→实际 UI 逐次确认→R byte-exact→新 UI 确认→C byte-exact；index/ref 不变、原对象 ID 与允许 metadata 保持。不能用程序化 nonce apply 代替 UI 验收。

**停止：**旧 replay 自动确认、UI 绕过 backend、错误 scope 提交、失败材料不可访问、恢复无新 D 备份、文本把风险说成全保证，停止开放。

## 10. D6：最终资格、停止/开放决策

**前置：**D5 人工验收；只有此阶段通过并获得明确开放批准，才允许开放已实现的 P33.5b 产品写回能力。

**可修改：**独立最终验收文档、经人工批准的 feature 配置和已完成模块的必要缺陷修复；每项修复重跑受影响资格。生产默认值变更仍需明确批准，提交/推送/发版不属于阶段默认动作。

- [ ] 汇总每个 OS/helper/proof 的特权八格、普通令牌、ACL/四属性子集、negative ADS/EA、注入/Mock/崩溃数据；不合资格项从 allowlist 移除，用户看到只读原因，不删断言求过。
- [ ] source、packaged app 与要分发的 SEA 各自完成正常/异常/重启/恢复 native 闭环；installer/portable按实际分发范围验证。资源hash/输出摘要独立核对。
- [ ] 至少一个已资格 Windows 环境完成 classic 普通非托管 TEMP 项目和 managed worktree 的真实 Pi 模型 write/edit→实际 GUI→R→重新确认 C。模型不可用则记录此产品门槛未过；程序分发成功不替代真实模型任务。
- [ ] 普通/特权证据、并发/属性变化、失败材料 pin/访问与不自动 retry 全部保留；全套 `npm test` 退出 0、旧断言不减少；长期 soak 和 POSIX 若未跑明确不主张。
- [ ] 人工决定：开放已资格子集 B；或继续默认关闭待具体缺口；或拒绝契约/实现成本转 C 停止自动撤销。不许把不确定状态列成“通过但提醒”。

**验收：**可重现且可审阅的限定产品能力，资格与 UI 风险一致；P33.4/P33.5b 状态由人工结论记录。**停止：**真实元数据不保持、无可用普通权限平台、未知外部 D 被自动回滚、无法可靠保存/访问材料，或用户不能接受部分覆盖/不可见 metadata 变化，关闭 B、保留 C，不扩展为特权 daemon 或平台重写。

## 11. 初拟方案交付核查与后续 D1

P33.4d 初拟方案交付时只新增本计划及契约提案，HEAD/tag 不变，既存发布目录保留；未增加模块/运行未来实施命令。用户随后单独授权 D1，并明确未批准生产 Q1/Q2/Q3 或 D2–D6。D1 的实际交付、测试、只读副作用与停止状态见 [D1验收](p33-d1-acceptance.md)。阶段清单仍需人工验收后推进，不能因部分模块已实现就自动勾选后续生产授权。
