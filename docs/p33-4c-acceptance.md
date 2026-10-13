# P33.4c：Windows 安全撤销最终资格验证

日期：2026-10-13。阶段：隔离验证与契约审阅；没有生产接入授权。

## 1. 结论与执行边界

**结论：仍存在具体阻塞，不能进入生产，当前不允许开始 P33.5b。** 原对象写入路线并非已证明不适合继续投入：同版本特权 SACL 八组已有真实成功证据，普通权限原位内容写入与持久恢复材料也已有实测。但是，这些证据没有满足现行完整元数据资格契约，也没有批准新的平台保持契约。不能用通过数量或用户风险确认填补这些条件。

本阶段结束研究验收，不无限增加原型用例；保留 v0.24.0 只读会话变更能力和所有生产拒绝规则。没有修改生产 writer、metadata adapter、service、GUI、Git 恢复语义、权限策略、版本号或 tag，没有提交、推送或发版。

本轮不需要修复夹具。最新夹具已解决此前审计继承与受保护 DACL 组合的构造问题；本机本轮严格见证未执行的原因是令牌缺少审计权限，不是发现了新的 Windows 元数据保持失败。

## 2. 基线与勘察

开发前 HEAD、main 和本地 v0.24.0 均为 `ec546d5a3711a21d2dbc911d661eb52742774be0`；开发后 HEAD 不变。本轮只新增本文，原有未跟踪发布目录 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/` 未操作。测试对工程文件的写操作全部位于独立 TEMP fixture；报告另存仓库文档，日志保存在被忽略的 `.probe/p33-4c/`。

已读取 AGENTS.md、仓库 memory、P33.1 设计、P33.4/P33.4a/P33.4b/P33.5a 验收文档及本阶段指定的三个生产模块、SACL 工具、安全套件和原生研究脚本。现有 `session-change-store` 已提供 durable 原始字节与 journal，现有原位研究已经覆盖故障与恢复；继续复用这些验证，不重造 writer 或恢复状态机。独立只读安全审阅与本报告结论一致。

AGENTS 的“不联网”约束适用于本阶段；未 fetch 或重新访问 GitHub Release。发布基线依据本地 tag、已保存的同版本 CI/Release 日志和上阶段发布证据核对，属于本地历史快照，不声称本轮重新核实远端状态。Jev 路由建议测试类并判为高风险，最终仍按源码与实测作安全判断。

关键抽象与偏离点：生产 `session-revert-writer.js` 仍为候选文件替换，研究脚本保留原对象后直接写主数据流。后者可能解决替换时的元数据复制困难，但它改变了原设计禁止直接覆盖/truncate 的边界；不能作为现有 writer 的失败 fallback。生产 `session-revert-metadata.js:42-43` 的 `metadata_audit_unavailable` 与 service 的元数据一致性拒绝均保留。

## 3. SACL 八组真实证据

本轮首先执行 `node tests/session-revert-sacl-witness.cjs --require-audit`。本机 Windows `10.0.26200.0`、Node `24.14.0`，当前令牌 AdministratorRole=false。工具报告 `SeSecurityPrivilege enabled=false`、错误 **1300**，严格命令退出 **2**：执行 **0/0**，失败 0，跳过 **8**，八组均为 `unverified/audit_privilege_unavailable`。这不是八组通过；没有修改系统审计策略、获取新权限、UAC 或自动提权，也没有再次尝试取得权限。

已复核此前获授权的 v0.24.0 Release run `38347777118` 同 HEAD 特权 Windows NTFS 真实结果。保存日志 `.probe/p33-5a/release-024-ci.log:208-209`：`SeSecurityPrivilege enabled=true/error=0`，Windows `10.0.26100.0`，**8/8、失败 0、跳过 0**。本轮从该原始 JSON 提取摘要到 `.probe/p33-4c/sacl-prior-release-summary.json`；这属于同版本既有特权证据，不是本轮新增特权运行。

| SACL 构造 | DACL 构造 | 既有特权真实结果 | 本轮普通令牌严格见证 |
|---|---|---|---|
| 显式 | 受保护 | 完成，全部比较 true | 未验证，权限缺失 |
| 显式 | 继承 | 完成，全部比较 true | 未验证，权限缺失 |
| 继承 | 受保护 | 完成，全部比较 true | 未验证，权限缺失 |
| 继承 | 继承 | 完成，全部比较 true | 未验证，权限缺失 |
| 受保护 | 受保护 | 完成，全部比较 true | 未验证，权限缺失 |
| 受保护 | 继承 | 完成，全部比较 true | 未验证，权限缺失 |
| 混合 | 受保护 | 完成，全部比较 true | 未验证，权限缺失 |
| 混合 | 继承 | 完成，全部比较 true | 未验证，权限缺失 |

每组既有成功记录均为 `stage=complete`，fixture 构造、C→R 和从持久 C 备份新建计划恢复 C 的 `setupChecks/checks/restoreChecks` 全部 true；包括可读且非空 SACL、完整 SDDL、DACL、Owner、Group、文件 ID、命名 ADS、EA、属性、保护位、显式/继承审计 ACE 数量和实际构造类型。`backupVerified=true`、`secondPlanHandshake=true`，确认来源仍为 fixture，`productionQualified=false`。

八组 C 的 SHA-256 为 `d2ae42f607faf1bf6baa6864ebef4191e9955041ce51d4f02acbe55b65b50c82`，R 为 `8caec0132593f81a3e18cac5bf25bf8944bd545069473d874b625fbb4b5b4f4e`。均实际完成持久材料读回与内容核对。

最新脚本先在未受保护 DACL 下建立真实审计继承，再保护文件 DACL，保留审计继承；setupShape 在写入前检查，继承/混合要求 auditProtected=false。旧失败发生在夹具形状而非写后保持比较；现在八组 setup 和写后/恢复后比较全部通过，没有削弱旧断言。

本轮 native 脚本 SHA-256：`BD80BE464E9FC4ACD7D76A85B6A3901743D81A8D857616D5EAA43DEECD499B7F`。既有 CI 通过同一提交绑定源码，但其 JSON 未记录 native 文件独立 SHA；不能冒称 runner 原始文件 hash 已单独比对。普通令牌本机 26200 与特权 runner 26100 也不是同 OS 双令牌配对资格。

这些样本证明的是指定 Windows/NTFS/Win32 路径中构造的审计 ACE 及对象元数据保持，不覆盖任意 Owner/Group、MIC/resource/scoped-policy ACE、所有驱动或全部 NTFS 元数据。

## 4. 普通权限写入与元数据证据

复用 `session-revert-inplace.cjs` 与 `session-revert-inplace-safety.cjs` 的同版本真实 Win32 路径，测试均在独立 TEMP 普通令牌运行。先通过 `session-change-store` 持久保存 C/R、校验读回，native 原对象句柄重新核对 ID 与 C，再接收 commit。正常结果逐字节等于 R；新恢复计划从 durable C 读回，先备份当前 R，再恢复 C，保留文件 ID。B/A/P 场景由合成 dispatcher 触发，但实际写入与持久存储不是 Mock；独立前置 dirty 与后置用户字节在候选 R 中保留。

| 项目 | 已有及本轮普通权限实测 | 资格边界 |
|---|---|---|
| 主数据流、C/R 备份 | byte-exact、digest、锁内 C/ID 核对；空文件、BOM、混合换行；新计划恢复 C | 不证明整文件原子性；备份未观察到的新 D 不可重建 |
| 文件 ID | 正常写入、恢复保持；相同字节的新对象拒绝旧身份 | 不覆盖所有祖先替换、ID 复用或句柄释放后的竞争 |
| Owner/Group/DACL | 构造的受保护/继承 ACL 样本保持 | 普通令牌只有可观察值；不是任意所有者/权限资格 |
| SACL/完整 SDDL | 普通令牌不可读时实际记 null/unknown，明确跳过比较 | 特权八组保持不能变成本次普通令牌完整读回比较 |
| ADS | fixture 的非空 `:probe` 保持；外部 ADS 修改可成功且保留 | 研究 observer 只读此命名流，不能证明其他 ADS 不存在 |
| EA | fixture 非空 EA 保持；生产已有 empty EA 探测 | 非空/未知 EA 不纳入首版；完整负向 admission 尚未在新 provider 实现 |
| 文件属性 | 样本 8226（Archive+Hidden+NotContentIndexed）保持 | 外部属性可并行改变；Archive 从未置位到置位确有变化 |

原位写分支只使用主数据写入、EOF、flush，不请求设置安全描述符权限，不调用 ACL/属性修复；native 脚本 `106,153-181,235-249`。研究夹具的 ACL/SACL 构造只属于 setup 分支。保持原对象加上“不设置 ACL”是平台证据的一部分，不能等同每次完整读取、比较并证明没有外部 SACL 修改。

## 5. 三个重点风险与剩余竞争

1. **部分内容是实测事实。** WriteFile 已写部分后失败、EOF/flush 失败、写中崩溃都可能留下部分或已经完整的 R。C/R 持久备份与 recovery_required 能提供已保存的内容材料，但不会使原位写变成整文件原子操作，也不保证断电、磁盘损坏、未保存 metadata 的恢复。
2. **主流共享限制不是全对象排他。** 独立进程主流写/rename/replace 被具体 Windows 错误拒绝，不代表 ADS、DACL、SACL、属性都锁住。已有 ADS/DACL 成功变化与本轮属性变化反例；不可读 SACL 的并发无法由普通令牌检查。新 D 的可观察变化必须拒绝/保留，不能因为确认就覆盖。
3. **Archive 不能回放旧值修复。** 写入原先无 Archive 的文件后属性 8192→8224；研究属性 helper 回放缓存 8192 可丢失外部新增 Hidden（8194→8192）。这是明确反例，不接入生产。首版候选只能从 Archive 已置位的窄属性范围开始，仍须声明外部清除 Archive 与提交窗口风险；不承诺属性绝对不变。

既有真实写映射测量显示预存 writable mapping 情况下本次 writer 未能取得句柄；仅记录该测量，不能推断所有 mapping/内核路径被排除。祖先目录 pin 范围、自然 ENOSPC/短写/断电、特殊 ACE、其他驱动/OS、生产 worker 私有 IPC、Stop/drain、多文件部分结果和打包 provider 都尚无最终资格。

**判断：** 限定支持范围与持久恢复机制可以降低已知内容中断风险，并使已保存字节可人工恢复；不能单独闭合未知 SACL/未知元数据、属性竞争及现行契约冲突。若仍要求普通令牌每次完整 SACL 比较，本路线不能满足该要求；若改为平台保持证明，必须先定义并批准其范围，再提供对应的平台及 admission 证据。风险确认只接受剩余窗口，不提升内容、归因、身份、元数据资格。

## 6. 已有故障覆盖与恢复语义

未重新开发已有 P33.4b 故障用例，未删除断言。

| 场景 | 证据类别与结果 | 必须保留的处理 |
|---|---|---|
| WriteFile / 部分写后 WriteFile / SetEndOfFile / FlushFileBuffers 失败 | 真实 Win32 调用，借只读 DuplicateHandle 注入访问拒绝 5；不是自然磁盘满 | durable intent 后无法确认则 recovery_required；不推断 C 或 R 即成功 |
| 写中崩溃、EOF/flush 边界退出 | 真实 native 进程边界退出与磁盘读回 | C/R 仍可打开，保留失败代际；无自动重试/回滚 |
| 完成日志失败 | journal EIO 故障注入，磁盘实际 R | 重启仍 recovery_required，不凭当前等于 R 伪造完成日志 |
| 部分写后的恢复 C | 新 plan、当前中间 D 另作 durable 备份，真实 native 写回 | 原计划不复用；恢复也需要新的身份/内容检查与确认 |
| 二次恢复失败 | 独立第二次失败注入、原 C 与中间 D 仍可读 | 保留两个失败代际，不清理、不循环自动恢复 |
| 当前已有外部新 D | 真实外部内容修改；重启读取材料后，研究只读分类投影为 uncertain_external_change | 生产持久状态仍 recovery_required；不自动覆盖 D，先保存 D，再重新计算、重新确认 |
| 材料损坏、预备份/intent 失败 | 实际持久对象与日志错误注入 | 拒绝提交，不把损坏对象当完整备份 |
| 状态分类矩阵 | Mock，retryAllowed=false、productionQualified=false | 只是状态规则验证，不能代替平台写入证据 |

研究代码位置：`session-revert-inplace.cjs:82-117,153-163`，`session-revert-inplace-safety.cjs:14-23,87-129,134-168`，native `163-181,386-387`。现有生产 service 仍完整执行 prepare、内容/身份/元数据检查、固定 plan 和逐项失败停止；恢复预览不会写当前文件。

## 7. 最小生产恢复 profile 提案（未获准）

这是供人工判断下一步的边界提案，不是 supported 能力声明，不能追认旧 unknown 证据。

- 仅经明确版本化验收的 Windows、本地固定 NTFS；OS/API/native 源版本绑定，同时补齐同平台普通/特权令牌证据。首版建议单文件操作，作为缩小部分结果复杂性的设计选择。
- 既有单链接普通文件；所有路径/祖先与对象身份可验证；拒绝 symlink、junction、reparse、危险链接或未知路径。tracked 与原有 untracked 使用相同字节资格。
- 可逐字节往返的 UTF-8，含已验证 BOM/换行；不超过现有 2 MiB 单文件及算法/证据预算。拒绝 binary、未知编码、超额、删除、rename、新建移走。
- 完整 `intent_verified`，无 attributionGap、未结算 mutation、内容冲突或不唯一映射；绑定完整 owner/workspace generation。当前 C 与 durable 备份完全一致；确认后最终校验仍不符就拒绝。
- Archive 已置位，只有经验证的 Archive/Hidden/NotContentIndexed 窄属性组合；不修复属性、不回放 ACL/Owner/Group/SACL。只读、特殊、未知属性拒绝。
- 完整枚举确认无 ADS、EA 为空；读取失败与未知都拒绝。研究的非空 ADS/EA 保持样本不扩大生产范围，单独 `:probe=null` 不构成无 ADS 证明。
- 新的版本化 metadata/原对象捕获与 admission 契约；旧 `metadata_audit_unavailable` 记录不升级。SACL 保持资格必须来自获准的平台证明，明确不可见外部修改边界，不伪造 supported/fullSDDL 比较。
- durable C/R、可读回验证、固定 intent、失败材料 pin；出现不确定状态统一 recovery_required，无自动重试或回滚。人工恢复先备份当前 D，创建新候选、新 token、新确认，保留失败代际。

当前禁止生产修改的直接依据是本阶段授权范围及新契约未批准；同平台资格绑定与新的负向 admission 也尚无最终资格。未来契约获准后，可以先开发隔离的新 profile/admission，并提交 provider/捕获 schema/私有 worker/Stop 与恢复/UI/打包验收实施方案；对应平台证据与拒绝矩阵齐备后才开放生产集成。不把“新 admission 尚未实现”当成永远不能开始实现的循环条件，本阶段仍不执行该方案。

## 8. 必须单独批准的安全契约变化

1. 新增原对象原位 provider，允许 WriteFile/EOF 路径，改变 P33.1 `316-317` 的禁止直接覆盖/truncate 规则；保留当前替换 writer，不成为其拒绝后的 fallback。
2. SACL 从“每次完整枚举/保留/回读”改成严格限定的平台保持证明；明确 OS/NTFS/API、不可读值仍 unknown、不可见 SACL 竞态及证据失效边界。不能直接删除或放松旧 `metadata_audit_unavailable`。
3. 新 metadata/对象身份证据版本和负向 ADS/EA admission，旧 unknown 不追认；扩大 OS、Owner/Group、特殊 ACE、属性或 ADS/EA 均需独立资格。
4. 接受原位写可能部分覆盖、EOF/flush/完成日志失败的不确定状态；新的逐次风险文案版本，不承诺整文件/跨文件原子性或断电保证，不允许确认绕过已知冲突。
5. 不做 metadata 回滚或缓存属性修复；明确 Archive 已置位 profile 与外部 metadata 变化可能无法保存的边界。
6. 恢复必须备份当前 D、生成新计划并重新确认；保留失败代际，不承诺恢复未采到的 D 或完整系统审计/metadata 历史。生产身份、私有材料、worker/Stop/GUI/打包还要单独实测验收。

审批不能替代技术证据。本报告不请求直接解除安全拒绝，不把本阶段用户授权解释为已批准上述风险。若不接受契约变化，保留 P33.5a 只读差异与已有安全材料供人工核对；完整特权可信服务是另一个需单独安全设计与授权的路线，不在本阶段自动安装或提权，也不能用 Git 整文件 restore 冒充保留用户修改的会话恢复。

## 9. 测试数据与只读 GUI 回归

本轮完整 `npm test` **107 个串行套件命令全部完成，退出 0，耗时 873.269 秒**。包含全部 18 个 canonical P33 套件，已执行 **500/500**，失败 0，跳过 10；跳过项没有进入分子分母。日志 `.probe/p33-4c/npm-test.log`，退出码与耗时分别保存在 `npm-test.exit`、`npm-test.seconds`。全套没有统一断言总数输出，以下报告相关套件的实际数字，不从文本中的场景编号拼造全仓库计数。

| 套件/分组 | 本轮通过/执行 | 失败 | 跳过 | 证据类别 |
|---|---|---|---|---|
| SACL witness（npm 非严格运行） | 0/0 | 0 | 8 | 本机权限不足，未验证 |
| session-change store / bridge / tools | 36/36、23/23、30/30 | 0 | 0 | 持久存储/私有桥/合成工具 fixture |
| session-revert algorithm / store | 67/67、14/14 | 0 | 0 | 纯算法及持久 fixture |
| session-revert HTTP / integration | 65/65、19/19 | 0 | 0 | HTTP/worker 与 TEMP fixture |
| writer / recovery / admission / apply | 22/22、24/24、15/15、29/29 | 0 | 0 | 真实临时 fs 与 fixture metadata，不是完整原生元数据资格 |
| Windows faults | 13/13 | 0 | 0 | Win32/fs 与故障注入，不是自然 ENOSPC/断电 |
| 原位研究 | 28/28 | 0 | 2 | 真实 Win32；受保护/继承 SACL 比较因权限跳过 |
| 原位安全 | 43/43 | 0 | 0 | 真实 Win32/外部进程、故障注入及 Mock 分类矩阵，见 §6 |
| session-change query / UI / startup | 34/34、27/27、11/11 | 0 | 0 | API/DOM/启动 fixture；布局另由 Electron 验证 |
| 非 canonical ReplaceFileW metadata 研究 | 6/6 | 0 | SACL 未验证 | 原生 TEMP 对照：R 的 EA 不相等，故测试通过不是路线资格通过 |
| 非 canonical 已安装 Pi dispatcher | 26/26 | 0 | 无计数 skip | Pi 1.0.4 实际默认工具/扩展，fixture stream provider，无真实模型 |

严格 SACL 见证的本轮单独命令见 §3；原位安全及其他 P33 canonical 命令由 `npm test` 实际调用完成，不额外重复相同长跑。额外 `node tests/session-revert-metadata-research.cjs` 退出 0，日志 `metadata-research.log`：ReplaceFileW 的 `contentR/backupC/backupEaEqual=true`，`eaEqual=false`、`saclEqual=null`，仍拒绝扩大该替换路径。

额外 `node tests/session-change-live.cjs` 在独立 TEMP 实际运行已安装 Pi 1.0.4 默认 write/edit、nested/reload/resume、并行隔离 scope、来源漂移拒绝与持久证据重开，**26/26、退出 0**。fixture stream provider 只产生规定的工具调用，无联网/真实模型。日志 `installed-pi-dispatcher.log`。真实 B/A/P 生成保留用户独立字节的只读候选；实际生产 prepare 返回 `metadata_audit_unavailable`，当前文件、journal、index 和 refs 在各自对应的只读/拒绝断言中保持原样。该命令的可选 `P33_GUI_E2E` 候选内容 Electron 分支未启用，没有把未运行分支计为通过；实际 app 空态 Electron 另见下文。

旧断言未减少：本轮原位 28、原位安全 43 与 P33.4b 普通令牌相同；store 从历史 35 增至当前 36，是 v0.24.0 已有私有材料读取拒绝回归。本轮没有增加/删除测试。特权 runner 安全套件历史 42/42 跳过 1，是缺权限拒绝用例不适用于其令牌；本机 43/43 跳过 0，不能据此当成修复/回归数量差异。未用特权八组替代本机跳过项。

源码和现有 v0.24.0 打包 server 分别运行 `P33_RPC_GUI=1 node tests/session-change-rpc.cjs [entry]`：**实际安装 Pi RPC 各 24/24，真实 Electron 各 7/7，失败 0、跳过 0、退出 0**。仅在独立 TEMP 项目启动 Pi，调用采集同意命令与只读/拒绝接口，无模型请求、无真实项目写入。覆盖 classic/managed/dormant owner、菜单焦点、窄窗口、Escape 焦点返回、列表顺序与 renderer 零错误。日志为 `.probe/p33-4c/gui-source.log`、`gui-packaged.log`。

当前截图：`.shots/p33-5a/source-empty-1200.png`、`source-empty-720.png`、`packaged-empty-1200.png`、`packaged-empty-720.png`。这证明现有只读空态在源码/打包 Electron 的回归，不是新原位 writer UI、真实模型完整任务、人工确认恢复或全分辨率/DPI 验收。本轮未修改 public/server，故不重建新的产品功能；现有 v0.24.0 打包入口参与上述检查。

未验证的范围：本轮特权 SACL 实跑、同 OS 双令牌最终资格、自然磁盘满/短写/断电、不可读 SACL 外部竞态、所有祖先/身份复用、真实模型完整恢复任务、生产 provider 打包、长期 soak、POSIX。已经通过的 fixture 或历史 CI 不消除这些范围限制。

## 10. 交付状态

仅交付本文与本地隔离测试日志，生产入口和已发布 v0.24.0 保持。开发后 HEAD 与 tag 不变。最终检查确认仅本文是本阶段新增交付，`git diff --check` 通过；生产及测试文件相对 HEAD 无差异。停止于人工验收，不进入 P33.5b，不提交、推送或发版。

## 11. 后续授权交付

2026-10-13，用户在上述研究报告交付后明确要求“推送”，据此将本文作为独立文档提交交付到 main。前文的 HEAD、工作区与未提交状态保留研究完成时的快照；交付后的 HEAD 以本文所在提交为准。此次授权不代表安全资格验收通过、新 writer 契约获准、P33.5b 开始或发版授权。

推送准备时已 fetch origin/main，确认与研究基线 `ec546d5` 一致；只纳入本文，不纳入既存发布目录、忽略日志或截图。生产与测试文件均未修改，未重复运行上一阶段的完整测试，不将报告中的 107 套件证据冒称为推送回合新测；文档内容和 whitespace 检查另行完成。
