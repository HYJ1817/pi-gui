# P33-D6 最终收口验收

日期：2026-10-16。范围：Classic 收尾、Managed 首次绑定、Git 初始证据、平台资格及 SEA 进程重启的统一补验。**结论：NO-GO，正式 B Writer 继续关闭。** 本文不批准 Q1/Q2/Q3，不提交、推送或发版。

## 1. 基线、最终 HEAD 与环境

开发前、技术交付后 HEAD 均为 `ae7deefa91b6cdbddf0e451c49c2b4d7736457fe`，分支 `main`；本轮修改未提交。v0.24.0 仍指向 `ec546d5a3711a21d2dbc911d661eb52742774be0`，未移动。

普通 Windows 11 25H2 x64，build **26200 / UBR 9457**；Native OSVersion `10.0.26200.0`；本地固定 NTFS。Node 24.14.0、Electron 44.4.3、外部 Pi 1.2.0。当前令牌不是管理员，无 SeSecurityPrivilege；没有提权或改变审计策略。环境原始结构记录在 `.probe/p33-d6final-platform-environment.json`。

开发前跟踪文件干净；保留既有 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`。执行过程中出现的 `docs/claude-*`、`docs/素材.zip` 属于其他用户工作，未改动或清理。原 `.probe`、`.shots`、发布目录与 TEMP 恢复材料均保留。

## 2. 修改文件与冻结边界

仅修改测试、测试组合根和 `package.json` 的唯一 test 链；生产 `server/`、`public/`、`lib/`、Electron 正式入口和打包脚本没有变化。

| 文件 | 改动 |
|---|---|
| `tests/fixtures/session-revert-object-d6-issuer.mjs` | 三条事务完整核验；Git 初始持久快照；Managed 有界绑定；逐项幂等清理及最终真实 authority 复核 |
| `tests/fixtures/session-revert-object-d6final-checks.mjs` | 事务、Git 对照、脱敏栈和清理公共测试辅助 |
| `tests/fixtures/session-revert-object-d6final-{main.mjs,model-rpc.mjs,run.cjs}` | 可追踪的独立 Electron/SDK 测试入口、离线模型流、显式未来复测入口 |
| `tests/fixtures/session-revert-object-session-binding.mjs` | 测试侧复用生产 context 身份语义，替换首次 hello 的立即断言 |
| `tests/session-revert-object-{session-binding,d6final-classic}.cjs` | 新日常测试，纳入唯一 `npm test` 链；真实 SDK/Native 为显式 opt-in |
| `tests/fixtures/session-revert-object-packed-build.cjs` | 私有测试 builder 支持限定 fixtures 目录下的固定测试入口 |
| `tests/fixtures/session-revert-object-packed-issuer.cjs` | 允许测试组合根由真实 Registry 签发 owner；原默认测试行为保留 |
| `tests/fixtures/session-revert-object-sea-restart-{build.cjs,launcher.mjs}` | 单独测试 SEA 的构建、持久 intent 与重启编排；不进入正式包 |
| `tests/session-revert-object-sea-restart.cjs` | 父进程实际终止/重新启动 SEA，检查 Native 退出和持久恢复边界 |
| `tests/session-revert-object-authority.cjs`、`tests/fixtures/session-revert-object-service-harness.cjs` | 规范化夹具自身的 TEMP 路径；新增别名路径必须拒绝的断言 |
| `package.json` | 保留原 124 个命令及顺序，新增两个日常测试，合计 126 个命令 |
| 本文 | 一份统一验收报告 |

最终冻结清单 `.probe/p33-d6final-frozen-source.json` 包含 **431 个输入及逐文件 SHA-256**。全部最终测试和构建从该快照执行；文档随后补录实际结果，不改变受测代码。基线复用此前同字节 124 命令、退出 0 的完整链，未再执行一次冗余全量基线。本轮最终全量只执行一轮。

## 3. Classic 退出 1：已确认和不能补造的事实

原真实模型运行已经执行 write/edit、Native 写入和新确认恢复，但收尾假设只有两个计划。实际合法账本有取消的 `not_applied`，以及 `recovery_required` 和 `applied_verified` 两条，因此原 `saved.length===2` 必然失败。离线负向测试重现该错误，不删除取消记录来使测试通过。

原异常处理还可能在 cleanup 抛错时覆盖主异常；这是独立代码缺陷，不能据此断言旧那一次必然发生过 cleanup 异常。现用统一清理器顺序尝试全部步骤，重复调用复用同一个任务；释放失败有独立记录，不能把测试退出当作成功。主异常的阶段、类型、固定错误码、全部脱敏帧保留；异常 message、任意属性、绝对路径和断言 payload 不进入诊断。

原失败没有足够异常栈，无法追溯证明除已确认错误外不存在第二个原因；没有补写历史成功。新冻结 Classic 离线实际 SDK/RPC + GUI + Native 闭环 **37/37、退出 0**，实际清理记录全部成功。

## 4. 三条持久事务

以 planId 唯一性、kind、sourcePlanId、requestId、attemptId 和 intent 逐条核验：

| 记录 | 必须保持的绑定 |
|---|---|
| 取消 | revert / not_applied / 无 source、request、attempt；材料 C/R 保留 |
| 首次写入 | revert / recovery_required / 独立 request 与 attempt；Ready=C、对象 ID 一致、intent request 对应 |
| 重新确认恢复 | recover / applied_verified / source 指向首次写入；新的 request 与 attempt；Ready=D，材料 D/C |

两次 Native open 和两次 commit；第一轮 Win32 已核验 R，测试只破坏结果通道以制造不确定性，没有伪造真实系统写失败。第二轮实际写回 C，最终磁盘逐字节相等。所有 C/R/D 引用的 digest、长度和实际材料逐字节检查；取消记录没有被筛掉或删除。19 项离线契约测试含重复 ID、错误来源、复用 request/attempt、错误 D/R、Ready 身份错误和 intent 不匹配等负向用例。

冻结 Classic/Managed 各自独立 TEMP 的合成正文相同，实测摘要如下；相同摘要不授权跨 scope 消费材料：

| 内容 | 字节 | SHA-256 前16位 |
|---|---:|---|
| C | 53 | `b6e76c0ae0454909` |
| R | 55 | `ab07e2047c424ebb` |
| D | 49 | `b144ba9d980aff38` |
| 最终磁盘 | 53 | `b6e76c0ae0454909`，与 C 逐字节相等 |

完整摘要及两个模式各自的 plan/request/attempt、scope、初始 snapshot digest 位于对应私有 evidence.json。取消和不确定记录的 metadataEqual 为 null，未伪造 verified 结果；恢复成功记录 metadataEqual=true 仅涵盖其可观察比较。

## 5. Classic Git 初始与终态

在模型流及写工具执行前，以 `wx` 创建私有 `git-initial-snapshot.json`，flush 并读回核对；保存主仓库和实际 workspace 的 HEAD、refs、index digest，初始目标 B 的字节/摘要和完整 owner/scope。终态重新通过真实 authority 校验当前根、fingerprint 和 owner，再比较 Git 与身份；目标文件另行必须逐字节为 C。

初始 B 不等于包含用户后来修改的 C，不能要求恢复后的正文等于 B。测试明确分别检查 B 的初始材料、最终 C 和不变的 Git index/ref。旧真实模型 Classic 缺少初始快照的空白仍然保留，不能用新离线快照追认旧运行。

## 6. Managed 首次 hello 竞态

生产 `server.js` 已有 context.getOwner()/isCurrent() 的有界绑定逻辑；私有 D6 issuer 却在首次 get_state 后立即比较 owner.sessionId，当 Registry 还未完成 ready 触发的异步 refreshSession 时可能错误拒绝。本轮修复测试组合根，没有重写 Registry 或放宽正式 authority。

最多 25×20ms 的条件轮询，只在 session 尚未绑定且 context 仍有效时等待，不固定睡眠后直接放行；九字段中其余八字段、根和 workspace 描述必须保持。已绑定的错误 session 立即拒绝；ready 和 native session 第二次读回也必须一致。无法确认、退出、dispose、generation 或 workspace 改变均失败关闭。**23/23 确定性生命周期 DI** 覆盖早 hello、晚绑定、重复 hello、超时、退出、历史会话新 generation 等，不能把这些 DI 数量当作真实进程证据。

真实进程层另行使用当前 SDK/RPC、真实 Managed Registry/Worktree、GUI 和 Native TEMP 流程；其模型流为固定离线 fixture，guardian 为私有 IPC 适配，证据层级在结果中明确记录。

## 7. 真实模型证据与复测授权

原 D6 的 8 次 DeepSeek 请求预算已用完：Managed 37/37；Classic 31 项后退出 1，真实捕获和两次写入事实保留。新代码的实际 SDK 离线流不是新的真实模型证据。本轮 **外部模型请求 0，不读取认证文件或现有凭据**。

状态 **REAL_MODEL_RETEST_PENDING**。未来建议只复测 Classic，一次工程最多 4 次 HTTP 请求、每次最多 1024 输出 token、无自动 retry；仍只发送独立 TEMP 合成内容。可执行入口：

```powershell
node tests/session-revert-object-d6final-classic.cjs --real-model --new-model-authorization=explicit --max-model-requests=4
```

必须先取得新的人工次数/费用授权；该入口仅显式读取调用者提供的 `PI_GUI_D6FINAL_MODEL_KEY`，不搜索 auth 文件。本轮未执行此读取分支。凭据不写入配置、报告或子进程环境，启动子进程前删除该环境项，仅经私有父子 IPC 传入并释放引用。该变量仅传递未来测试凭据，不提供正式资格。命令行标志是独立测试运行器的显式防误触门槛，不能表示 Codex 已取得用户授权，更不能为正式 B 提供资格。离线入口为 `--offline-sdk-native` / `--offline-managed-sdk-native`。

## 8. 同平台普通/特权资格

当前普通环境为 26200.9457。已有 D2 特权八组来自 Windows Server 2025 / 26100、相同 Native writer 字节；二者不是同平台配对，也没有证明当前所有补丁、特殊 ACE/ACL 的保持范围。仓库没有可用自托管特权 runner；没有通过启用旧临时 workflow、权限调整或自动提权绕过。

状态 **PLATFORM_PROOF_PENDING**。最小补证是在一个预先授权、完整记录 OS build/UBR、x64 本地固定 NTFS 的环境，同提交/Helper/API/mask/protocol 分别运行普通和已有特权令牌路径，生成同平台可追溯 proof。在此之前 allowlist 仍为空，不把 unknown 改成 supported。

另有明确实现边界：当前 v1 observation 只有 osVersion 等字段，没有 UBR；evaluateObjectProfile 只接受 `p33-d1-readonly`，它是观察来源标签，不是生产保持证书。因此不仅缺一次特权运行，正式生产 proof 的可信签发/补丁绑定机制也尚未交付。不能把本报告的环境 JSON 当作已接入的生产资格。本轮保持该拒绝，不修改 Helper 字节来临时加入字段，也不借此扩大生产授权。

## 9. SACL 八组真实结果

冻结后执行 `node tests/session-revert-object-witness.cjs --require-audit`，**退出 2，passed=0、failed=0、skipped=8**；八组全部在 privilege 阶段 `existing_token_sacl_unavailable`，未实际进行特权写入，不计算成通过。

| SACL | DACL protected | DACL inherited |
|---|---|---|
| explicit | 本轮未验证 | 本轮未验证 |
| inherited | 本轮未验证 | 本轮未验证 |
| protected | 本轮未验证 | 本轮未验证 |
| mixed | 本轮未验证 | 本轮未验证 |

已有 [D2 严格 CI 38383762389](https://github.com/HYJ1817/pi-gui/actions/runs/38383762389) 的真实 **8/8、失败 0、跳过 0** 仅复用其原范围，详见 `docs/p33-d2-acceptance.md` §11。未重跑或追认成 26200 资格，更未混用 P33.4c 的旧研究 writer。

## 10. 元数据与 ACL 保证边界

同一文件 ID 只证明对象身份的一部分。本轮普通 Native 路径逐次核对卷/文件 ID、祖先对象、Creation、主流 digest/长度、单链接、可观察 Owner/Group/DACL、属性、ADS 枚举和空 EA；SACL 不可读保持 unavailable，绝不填写相等。

最后写入/访问等时间戳不属于这里的“不变”保证；正文写入可能正常改变它们，当前方案不回放完整时间戳历史。不能将仅检查 Creation 的结果表述为全部文件时间或全部元数据保持。

已有特权八组在其原 26100 环境检查完整 SDDL、SACL/DACL、Owner/Group、ID、ADS、EA 和属性。它不能证明所有 ACL 形状、当前 26200 的隐藏 SACL 或提交间隙外部变更均被观察。share=0 不是元数据全对象排他；特殊 ACE/文件系统、未知或非空 EA、ADS、新属性组合继续拒绝。C/R/D 正文备份不包含完整可重建的安全元数据历史，也不能恢复未保存缓冲或未捕获的后来 D。

## 11. SEA 实际进程终止和重启

新测试构建为独立 TEST ONLY SEA，实际在 Node SEA 进程内读取嵌入 Helper，Native 使用同一 D2 Win32 核心。第一进程真实创建 Registry/owner、观察 TEMP、保存 C/R、Native Ready，再由服务持久写入 replacing intent；提交调用处挂起，尚未向 Native 发送 commit。父测试收到检查点后终止整个 SEA，并以 PID + OS 创建时间确认原 Native 进程已退出，磁盘仍为 C。

第二个真正新启动的 SEA 建立新 Registry backend，重开同一 Store 后持久 reconcile 为 recovery_required；Reader 逐字节读 C/R，不修改读取前后的 journal；旧 owner/token/attempt 请求均被拒绝，Native open/commit 为 0，无自动 replay。新增独立 D 后保持 D 未变。**4/4，退出 0**。原始检查点、退出信号、创建身份、EXE/launcher digest 见 `.probe/p33-d6final-sea-restart-summary.json`。

这是真实进程重启，不是 OS 重启、自然断电或写到一半的物理故障；该切点也不是“写入已经提交后被杀”。已有 packed 故障/恢复循环与本切点分别保留，不互相替代。

## 12. 新 backend 的历史只读权限与阻塞

测试历史读取授权由固定私有控制记录、真实 Registry 的 historyTarget/session identity 和完整旧 scope 绑定；回调只授予经过验证的 Reader 读取，不安装旧 owner，不使 dormant 身份变成 active writer。该访问控制回调属于 fixture DI，不宣称正式产品已经提供历史材料 HTTP 下载。

现有服务的计划/材料绑定完整 owner。新 backend 不能以当前请求补造旧 capture 的 owner；旧 token 不能继续执行。第二进程使用真实新 owner 请求旧来源恢复，明确拒绝；没有复制旧 scope 来写 D→C，也没有把 D 恰等于 R 当成功。**跨 backend 的新确认 D→C 为 BLOCKED_CONTRACT**：若产品必须提供它，需要另行审议历史来源只读验证与新当前证据之间的显式转换契约；本轮不默许这种扩权。现阶段可用替代是可信只读材料交人工恢复，正式导出入口仍须独立批准。

## 13. Source / Electron / SEA 一致性与差异

Observer SHA-256：`230eade3a3611f2340b8ecb3d536b61d2adb88deabc44b44d7c59ec065a2063f`。

Writer SHA-256：`7d773b63777d97a6a78d9a81c37cf946929062b22028425889258becd3aa39ef`。

两份 Helper、权限 mask、Win32 API 和协议未改。Source 使用固定内置资源；Electron 使用实际 resources/app；SEA 使用内嵌资源经固定 bootstrap/stdin 提供给 PowerShell，没有新增共享 TEMP 可执行脚本缓存或 PATH/工作区同名脚本回退。打包专项实际检查只读资源、中文/空格路径、同名恶意脚本、篡改资源拒绝及正式产品边界。

| 层次 | 与正式产品相同 | 明确差异 |
|---|---|---|
| Source SDK GUI | 当前 Pi 1.2 SDK/RPC、真实 Registry/Worktree、捕获扩展、生产 GUI/Store/计算/Native 核心 | 固定离线模型流；guardian 私有 IPC；额外私有 core 导出；TEMP 资格 |
| Electron GUI | 正式 Electron 宿主字节、实际 resources/app GUI/Helper、真实 Pi SDK JSONL loop 与默认 write/edit | 专用测试 main/preload、固定 fixture 模型、未采用完整正式 Runtime 组合根；只允许 harness 新建 TEMP 的 capability |
| Electron backend Native | 真实 Electron RUN_AS_NODE 与包内资源 | 独立测试组合根，非正式 Electron 主入口的 B 执行 |
| TEST ONLY SEA | 真 SEA 进程、生产静态资源及同一持久/Native 核心 | 构建期私有导出和测试资格；重启场景 Registry adapter/capture 为 fixture |
| 正式 APP/SEA | 实际产品进程、HTTP/RPC 拒绝和资源读取 | B 被固定关闭，不能把测试进程成功写成正式 B 产品闭环 |

正式 server.cjs 必须不含 createIsolatedWriter/createObjectServiceCore/测试 issuer；测试 EXE 不安装进正式产品。Source 成功不替代 SEA，Node 消费 SEA 资源也不计作实际 SEA。构建与输入摘要另存 `.probe/p33-d6final-build-hashes.json`；不主张不同 SEA 构建字节可重现。

## 14. 正式产品关闭状态

`PRODUCTION_OBJECT_ALLOWLIST=[]`；正式 `openOriginalAttempt()` 和 `createSessionRevertObjectService()` 固定 `production_allowlist_empty`。普通参数、env、renderer 请求、测试 token、客户端路径或 proof 不能启用。正式 HTTP 不新增 B apply；普通 Object transport 的 apply/材料导出保持拒绝，GUI 只读。A Writer 的 `metadata_audit_unavailable` 未改。Git 恢复语义、index/ref 未修改。

本轮没有更改任何生产模块；正式 app/exe 进程边界仍由实际打包测试验证，不能只以“源码没改”代替运行结果。

当前快照的审查定位（代码事实与测试结果分列）：

| 结论 | 代码定位 |
|---|---|
| 正式关闭 | `server/session-revert-object-profile.js:4`、`server/session-revert-object-service.js:14`、`server/session-revert-object-writer.js:12`、`public/session-revert-object-api.js:2` |
| A 的 audit 拒绝 | `server/session-revert-metadata.js:42`、`server/session-revert-service.js:40` |
| 只读 proof 并非生产证书 | `server/session-revert-object-profile.js:7`、`:33` |
| 完整 owner 与文件 ID 绑定 | `server/session-revert-object-profile.js:10`、`server/session-revert-object-contract.js:11`、`:16` |
| 正式首次 session 有界等待 | `server.js:859`、`:862`；异步 Registry refresh：`server/runtime-registry.js:157` |
| 原根拒绝与历史只读 authority | `server/session-revert-object-runtime-authority.js:11`、`:84` |
| 重启持久 reconcile | `server/session-change-store.js:260` |
| 固定 Helper 与解释器加载 | `server/session-revert-object-resources.js:13`、`:23`；SystemRoot 是受信任 OS 环境前提，不是沙箱 |
| 计算 worker 不走持久可执行缓存 | `server/session-revert-compute.js:7`，包内字节通过 data URL 执行 |
| 本轮修复入口 | `tests/fixtures/session-revert-object-d6-issuer.mjs:94`、`:101`、`:124`、`:180`；会话等待：`tests/fixtures/session-revert-object-session-binding.mjs:6` |
| 本轮事务/持久初始快照 | `tests/fixtures/session-revert-object-d6final-checks.mjs:11`、`:31`、`:36` |

## 15. 新增负向测试与故障证据

23 项会话绑定、19 项事务/Git/清理契约和 authority 新别名拒绝均增加覆盖，原 124 命令保留；没有删除既有安全拒绝断言、降低 metadata 条件或用更长任意超时掩盖失败。错误的“两条计划”假设被三条完整事务绑定取代。初始 Git 快照不能覆盖，index/owner 改变必须拒绝。

SEA 实际终止为进程故障；结果管道损坏为故障注入；Write/EOF/Flush、日志故障等继续复用 D2/D3 对应测试，不称为真实磁盘 EIO。自然断电、备份物理损坏、长期 soak、特殊 SACL/ACL 和未覆盖平台仍未验证。

D2 Faults 包含在内存中改写 API 调用边界的专用 Helper 变体：通过只读 DuplicateHandle 使 WriteFile/EOF/Flush 真实返回 Win32 access denied，另有中途进程退出、短写请求、协议/超时注入。它们不是全部 Mock，也不是原分发 Helper 的未注入运行；各自日志明确标记类型。分发 Helper 字节未改，旧 SACL 八组只对应原固定 hash，不被转用于这些故障变体。

本地以 TEMP junction 重现 authority 首项 stale_workspace；将夹具自身根规范化后 **12/12**，且新增别名路径仍必须拒绝。旧远端 CI run `38735029334` 的 Node22/24 均停在同类错误，原日志没有证明具体路径，故只称“可重现的同类 fixture 缺陷”，不声称已唯一定位远端原因。当前修改未推送，**CI_RETEST_PENDING**；没有冒称远端转绿。

当前 `.github/workflows/ci.yml:40` 的 Core job 预算为25分钟，短于本机全链耗时；不能据此断言不同 runner 必定超时，但远端复跑还需验证完整链的实际时间预算。没有删除测试来适应25分钟，也没有在缺乏远端计时的情况下宣称现有 CI 预算充分。

## 16. D1～D6 回归范围

唯一 npm 链包含 P33.2 捕获、P33.3 逆合并、D1 Observation、D2 writer/fault/witness、D3 Store/Service/Recovery Reader、D4 Runtime/Worktree/Stop/admission、D5 presentation/四项确认/旧 v2 只读和 D6 qualification；同时执行 A、Git、P32、权限/隐私、PDF/既有资源及其他原套件。

## 17. 最终命令与实际结果

| 命令/套件 | 证据层级 | Passed/结果 | Failed | Skipped | Exit | 秒 |
|---|---|---|---:|---:|---:|---:|
| `npm test` | 完整唯一链；真实 Native/FS/Runtime、注入与 DI 分列 | 126命令；P33 36摘要 1015/1015 | 0 | 18 | 0 | 3120.502 |
| 新增 binding / Classic contract | 确定性 DI / 真实 TEMP Git | 23/23；19/19 | 0 | 0 | 0 | 随 npm 链 |
| authority（含别名拒绝） | TEMP FS、Registry DI；最后一项用真实 Native 观察 | 12/12 | 0 | 0 | 0 | 随 npm 链 |
| Classic SDK/RPC + GUI + Native | 真实 SDK/进程/Win32；fixture 模型、guardian DI | 37/37 | 0 | 0 | 0 | 183.415 |
| Managed SDK/RPC + GUI + Native | 真实 Registry/Worktree/SDK/进程/Win32；fixture 模型 | 37/37 | 0 | 0 | 0 | 245.594 |
| Source GUI | 真实 Electron/SDK/Win32；125%与150%，fixture 模型 | 122/122 | 0 | 0 | 0 | 732.216 |
| Packaged GUI | 真实打包宿主与资源；125%与150%，私有 test main | 122/122 | 0 | 0 | 0 | 710.062 |
| Packed Native 专项 | 实际 TEST ONLY SEA、Electron backend；正式关闭边界 | 11/11 | 0 | 0 | 0 | 773.188 |
| SEA 终止/重启 | 两次实际 SEA 进程；真实 Registry、fixture adapter/历史授权 | 4/4 | 0 | 0 | 0 | 79.587 |
| `npm run build:app -- --rebuild` | fresh TEMP 正式构建 | 构建成功 | — | — | 0 | 28.562 |
| `npm run build:exe` | 另一 fresh TEMP 正式 SEA 构建 | 构建成功 | — | — | 0 | 20.015 |
| `npm run fixtures` | 本轮独立检查 TEMP 内的固定素材 | 准备成功 | — | — | 0 | — |
| `npm run test:app` | 真实包内后端、干净目录、PDF/静态资源 | 26/26 | 0 | 0 | 0 | 12.914 |
| `npm run test:exe` | 实际正式 EXE、PDF/资源/诊断 | 49/49 | 0 | 0 | 0 | 12.447 |
| 独立 `--require-audit` witness | 当前令牌 privilege 阶段拒绝；未实际特权写入 | 0/0 | 0 | 8 | 2 | 0.900 |

APP/EXE 正式构建和 test:app/test:exe 均带独立 `--output-root`，其他 harness 自建独立 TEMP；精确 argv、TEMP 和端口见 evidence.json。秒列的 — 为未单独记录，不估算。最终全链耗时 3120.502 秒，只有这一轮最终全量；原124个命令顺序完整保留，P33由34个摘要972项增加为36个摘要1015项（+23绑定、+19契约、+1别名拒绝），没有减少旧分母。18个权限跳过分别是旧SACL8、原位研究SACL2、Object witness8，均不计通过。

GUI 56 张、两个 SDK 模式各9张，最终共74张；实际核看720px截图，四个风险控件与按钮在视口内，无重叠。字节和位置断言也由两个缩放下的真实窗口执行。

| 受测产物 | SHA-256 |
|---|---|
| APP/独立SEA server.cjs | `e96c3f9aac7c6fe27e15a50872748c1f17ca2d381b20647e6c5836b35226c05a` |
| APP宿主 | `3ad6e2a8f56f02931f116d707d2ed5f4bdddcafc4f4d5a2afb8bc0d509467925` |
| 独立正式SEA | `0725e3ee4900f545d2349a944fc29ae6aa720ab1c614400cb1767de37d9e0ec0` |
| packed专项正式SEA | `8c5e71ce9a85cf043495a2cf8b00e72f34eee31d28de1fc6d8e7292d6c532971` |
| packed专项测试SEA | `ee592976e16408676c90cc89a909ef68704a92922e4f50ba0fc2f29da1c7584e` |
| 重启专项测试SEA | `a1e0a2a5bd5ffe21d24fe3a9d404662ff256200d15907546ae27cbde0f86b26d` |

不同 SEA 外壳摘要不相同，各检查只对应自己的实际 EXE；内嵌正常 Helper/计算/GUI资源与冻结源一致，不以包摘要差异伪造源码可重现或生产写入资格。


## 18. Passed / Failed / Skipped 解释

仅以最终退出码及对应冻结输入下完整日志计验收；可获取的早期失败与最终日志分别列出。严格 witness 的权限 skip 不计入通过分子/分母，npm 退出 0 也不能取消其退出 2。全仓不同套件分母和证据层级不同，不虚构统一总断言数。

## 19. 可追溯材料与 Hash

各本轮最终命令使用 `.probe/p33-d6final-*` 原始日志和 `.exit`；实际计时的命令另有 `.seconds`，未单独计时项不推算。原始旧 D6 证据保留；本轮一次别名夹具中间失败误用了后来 GREEN 的同名日志，原完整日志已不可用。其退出1、privacy拒绝及工具输出末四行另记 `.probe/p33-d6final-authority-intermediate-note.json`，明确不是完整原始日志，不据此计通过。最初 stale_workspace RED、最终12/12 GREEN及冻结后完整链有各自原始日志；其他 SEA 开发失败使用独立编号保留。

最终统一摘要、日志 Hash、构建位置和 byte-for-byte 对照见 `.probe/p33-d6final-evidence.json`；431 输入逐项复核，受测源码与构建可对应同一未提交快照，而不是虚构新的 commit。

图像保存在 `.shots/p33-d6final-classic-*`、`.shots/p33-d6final-managed-*` 和 `.shots/p33-d6final/`；私有 TEMP 的 C/R/D 与控制记录不提交、不通过产品 HTTP/SSE 暴露。最终测试截图/历史材料不是用户生产确认，也不批准 Q1/Q2/Q3。

## 20. Q1 / Q2 / Q3 建议

| 事项 | 残余风险 | 建议 |
|---|---|---|
| Q1 主流原位写入 | 不是整文件原子性；失败可留下部分正文，工程可能暂不可用 | 可继续审议单文件受限契约，但本轮不批准生产 |
| Q2 普通权限 metadata 资格 | SACL 不可逐文件完整观察；同平台配对不足；隐藏特殊 ACL 未排除 | 当前不建议批准生产 Q2；先补指定平台证据 |
| Q3 外部并发 | 最后检查后的未捕获 D 可能永久丢失；C/R 不能恢复未保存缓冲或完整 metadata | 不得按“保留全部用户修改”批准；必须明确接受具体损失窗口，否则选择只读方案 |

异常时持久 recovery_required、材料 pin、只读查询和新事务确认是可测试的程序措施，不是系统级原子执行、全局外部 writer 排他或操作系统沙箱。跨 backend 的新恢复契约若要扩展，也必须单独审议，不能顺带包含在 Q1～Q3 中。

## 21. 最终资格矩阵

| 标志 | 状态及范围 |
|---|---|
| CODE_VERIFIED | 受限测试工具修复与固定关闭边界按最终本地回归核验；远端 CI 复跑仍待完成 |
| RUNTIME_VERIFIED | 指定真实 SDK/RPC/Registry/Worktree、TEMP Native 和实际 SEA 进程重启；明确保留 guardian/历史授权 fixture 边界 |
| REAL_MODEL_VERIFIED | 原捕获和 Managed 原37/37事实保留；新代码整体 REAL_MODEL_RETEST_PENDING |
| PLATFORM_PROOF_VERIFIED | 否；PLATFORM_PROOF_PENDING，当前严格八组全未验证 |
| PRODUCT_PATH_VERIFIED | 部分；正式关闭边界与打包资源可验证，正式 B 可写闭环没有开放；跨 backend 新恢复 BLOCKED_CONTRACT |
| PRODUCTION_APPROVED | 否；allowlist 为空、Q1/Q2/Q3 未批准 |

## 22. 最终决定

**NO-GO。不能开始生产开放审批执行，不能自动开放 B。** 本轮未发现需要把全部 B 研究立即废弃的证据；也没有用测试通过数量代替平台和授权门槛。若要求整文件原子、逐文件完整 SACL 比较或保证保留全部后来 D，建议 **STOP-B**，保留只读候选与经单独授权的材料导出方案。

本轮没有观察到跨 scope/旧 owner 误写、admission 提前释放或正式 B 被打开的新缺陷。已修复的是私有测试组合根及夹具问题；这不代表排除了所有数据风险。未覆盖平台、真实模型重跑及正式可写产品生命周期仍不能标记为已验证。

## 23. 剩余阻塞与最小解决方法

1. **外部费用授权：**修正后的 Classic 真实模型完整复测尚无新请求预算；建议最多4次/1024输出token，明确授权后单次运行上述入口，不自动追加。
2. **环境资格及未交付机制：**在一个指定 OS build/UBR 上完成同路径普通/已有特权配对；当前无权限不得反复尝试获取。旧26100八组不能替代当前26200配对。当前仅只读 proof，正式可信生产 proof/UBR 绑定机制也未交付；其实施需另行审议，不能用一次 CI 通过替代。
3. **契约/产品缺口：**跨 backend 的历史只读材料无法直接成为当前写回授权；维持拒绝。需新 owner、新当前对象证据/备份、明确来源转换及重新确认的单独契约审议，或采用人工只读材料恢复。
4. **远端验证：**本地 fixture 修复未推送，旧 CI 仍失败；后续获准推送后复跑，不能用本地12/12宣称远端成功。
5. **人工风险决定：**Q1/Q2/Q3 和正式 allowlist 开放均未批准；即使其余技术证据补齐，也只能申请人工审议，不自动实施。

本轮交付后停止，等待一次人工验收；不拆出新的自行执行阶段，不提交、推送、发版或更改 tag。正式 B Writer 保持关闭。

## 24. 后续交付授权记录

2026-10-16，用户在上述报告交付后明确要求“推送”，授权提交并推送本轮代码、测试与报告。测试改动提交为 `a8cbd9e`；本节及报告单独提交。以上测试的冻结基线仍为 `ae7deefa91b6cdbddf0e451c49c2b4d7736457fe` 加本轮列出的改动，不将后续提交时间写成测试执行时间。

推送前重新核对431个冻结输入，漂移为0；既有测试日志、构建资源及哈希一致。本次交付核查未重跑完整测试或调用外部模型。远端 CI 仍须独立确认；此前的未推送状态描述保留为报告形成时的事实。

此次授权仅涉及 Git 交付，不批准 Q1/Q2/Q3、生产 B Writer 开放、发版或修改 `v0.24.0`。最终决定继续为 **NO-GO**。
