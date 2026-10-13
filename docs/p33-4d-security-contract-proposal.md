# P33.4d：生产安全撤销契约提案

日期：2026-10-13。状态：**待人工审批，未批准实施或开放生产**。

后续用户已单独授权 D1 只读开发；完成记录见 [D1验收](p33-d1-acceptance.md)。这不批准生产 Q1/Q2/Q3，也不批准 D2–D6 自动实施；下文生产审批状态保持待定。

## 1. 审议结论

**推荐 B：独立的受限原文件对象 provider，但生产契约须逐条审批。** D1 可以单独授权只读 profile/证据开发；D2 必须另行明确授权且仅 TEMP 原位测试，不能由此推定 Q1/Q2/Q3 或后续阶段已获准。当前仍运行 A 的拒绝规则与 C 的只读界面，本报告不宣布 P33.4 或 P33.5b 已通过。

B 的价值是：对具备新版本完整证据的既有单个文本文件，计算只消除 Agent 修改的 R，在保留原对象的条件下写入，并保存撤销前 C。它避免复制不可读 SACL 的需要，具有已有平台实验支撑。代价是主数据流可能部分覆盖，外部 metadata 变化不能完全观测；备份只提供已经保存的字节材料。它不适用于要求整文件原子性、每次完整 SACL 比较或完整 metadata 历史恢复的用户。

若审批不接受这两项契约变化，选择 C 并停止 B 的自动撤销开发；不继续无限增加研究测试来掩盖要求冲突。A 继续保留用于其已验证条件，不以提升普通用户权限作为交付办法。

## 2. 基线、检查范围与证据分类

本轮开始/结束 HEAD 为 `5f5a7a89911354e2d006252d154487a8a1007a67`，本地 v0.24.0 为 `ec546d5a3711a21d2dbc911d661eb52742774be0`。二者只相差 P33.4c 报告，生产和测试源版本相同。既存未跟踪发布目录未操作。本轮不联网；发布与 CI 状态来自上阶段已核实并保存在本地的快照，不冒称新的远端核查。

已复核 AGENTS、P33.1/P33.4/P33.4a/P33.4b/P33.4c/P33.5a 文档和指定的 witness、原位、故障及 native 工具，重新勘察 writer、metadata、service、authority、store 与组合根/打包接线。原位研究文件相对已验证源版本未改变。Jev 将本轮分类为 docs；其低操作风险不代表拟议生产契约低风险，本报告仍按数据损失边界审议。

| 层级 | 已有证据 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| 特权真实 Win32/NTFS | v0.24.0 Release run 38347777118，Windows 10.0.26100.0，八组 8/8、失败 0、跳过 0 | 显式/继承/受保护/混合 SACL × 受保护/继承 DACL，C→R→持久 C 恢复，各阶段 full SDDL/SACL/DACL/Owner/Group/ID/fixture ADS/EA/属性相等 | 任意 ACL/ACE、所有 OS/驱动、所有者、不可见并发和未来 production helper |
| 普通令牌真实 Win32/NTFS | P33.4c Windows 10.0.26200.0：原位 28/28，跳过 2；安全 43/43 | 锁内 C/ID 核对、R 精确字节、持久材料重开与新计划恢复；可观察样本保持 | SACL 完整读回；本机严格 witness 权限错误 1300、退出 2、0/0、跳过 8 |
| 故障注入与真实调用组合 | WriteFile/EOF/Flush 的只读 DuplicateHandle 权限错误；真实进程边界退出；journal EIO；外部进程竞争 | 这些边界下可能部分内容与 recovery_required；不重试，不覆盖后来的 D | 自然 ENOSPC、真实断电、全存储故障分布 |
| Mock | 原位安全中的 20 个分类/比较器场景 | 未知状态不升格、retryAllowed=false | OS 排他性、真实元数据保持 |
| 产品拒绝与只读链 | P33.4c npm 107 命令退出 0、873.269 秒；P33 500/500、跳过 10；实装 Pi dispatcher 26/26；源码/打包 RPC 各 24/24、Electron 各 7/7 | 现有候选、身份与拒绝没有回归；真实 B/A/P 的 prepare 仍拒绝 unreadable SACL | 生产原位 provider、模型任务/人工确认写回闭环、长期 soak、POSIX |

证据入口：[P33.4c 报告](p33-4c-acceptance.md)、[P33.4b 报告](p33-4b-safety-validation.md)。本地原始日志在 `.probe/p33-4c/`，八组原始结果在 `.probe/p33-5a/release-024-ci.log:208-209`。本轮没有重复这些运行；上表全部明确是已有实测。

研究 native 当前 SHA-256：`BD80BE464E9FC4ACD7D76A85B6A3901743D81A8D857616D5EAA43DEECD499B7F`。CI 通过同一 Git 源版本绑定脚本，但原始 JSON 没有独立 native 文件 hash。未来生产 helper 的代码、权限/调用路径、协议与打包一旦改变，不能沿用这串 hash 的生产资格。

## 3. 原契约与拟修改条款

| 编号 | 原契约/当前实现 | B 拟批准的差异 | 保持不变 |
|---|---|---|---|
| Q1 | P33.1 §6.3 `317`：候选 rename-replace，禁止直接 writeFile/truncate fallback | 增加显式选择的原对象主流 WriteFile→SetEndOfFile→FlushFileBuffers provider | A 的实现、元数据拒绝和 fallback 禁令；strict 仍 unavailable |
| Q2 | P33.1 §5.7；metadata `42-45`、service `39-42`：完整 metadata 可读取并相等 | 新 profile 允许 SACL 不可读，但字段仍 unknown；资格来自批准的平台保持证明和可观测校验 | 不将旧 unknown 改为 supported；未知 EA/ADS/DACL/Owner/Group/属性仍拒绝 |
| Q3 | 替换避免提交前直接改 C，但仍无 CAS/跨文件原子性 | 接受提交开始后的部分覆盖与不确定结果，增加对应逐次风险确认 | 先持久 C/R；已知冲突/身份或 revision 变化不能确认绕过 |
| Q4 | 当前证据保存 beforeMetadata/afterMetadata；计划没有 B provider 绑定 | 新 capture/profile/proof 与计划版本绑定，旧记录只读；B 单文件独立注册与路由 | 原账本、内容寻址对象、scope、预算及 consumed 规则复用 |
| Q5 | 既有恢复需新计划，不能自动回滚 | B 恢复当前 D 也先备份、重新验资格、重新展示 D→C、重新确认；不恢复 metadata | 不恢复未保存 D，不覆盖未知对象，不删除失败材料 |
| Q6 | v0.24.0 GUI 只读 | 分阶段实现后另行验收单文件按钮与风险说明；未通过时保留预览/已有材料导出 | 本轮不开放按钮；批准契约不等于生产开放/发版 |

Q2 是明确降低“每次完整 metadata 观测”的要求，不能用“文件 ID 未变”替代此审批。若用户要求 SACL 一律可读，B 在普通令牌下不成立，保留 A/C。

## 4. 内容保证与不能保证的系统风险

以下都是未来必须实现并验证的条件，不是现在产品已有 B 能力：

1. 新 evidence 的 B/A/P 完整且 intent_verified，toolResult 已结算，无 gap、过期、消费或跨会话冲突；P33.3 唯一逆合并得到 R，UTF-8/BOM/换行逐字节往返。确认不提升 observed/incomplete。
2. authority 解析当前 workspace，Stop/drain 和 admission 冻结已知 GUI writer；验证完整 owner、scope、workspaceEpoch/fingerprint、revision/gapRevision。renderer 不提供任意路径或 R。
3. 观察 C 和原对象，持久保存 C/R、fsync、权限及 readback digest；完成容量检查并固定计划后才显示 backupReady。确认前/后重核 C、身份、路径与资格，不一致则拒绝，备份不能被新 C 替换。
4. native 取得受限主数据句柄、锁内读回 C 和对象身份；server 再检查 scope/revision，持久 intent 成功后发送绑定本进程 attempt 的 commit。裸 stdin `commit` 不足以证明这些条件。
5. native 执行有界写、EOF、flush，持有句柄实际读回 R，核对 ID 与可观察 metadata。server 校验受限输出及持久 applied_verified 后才报该次完成。
6. intent 后任何超时、协议不明、崩溃、后验或日志失败都 recovery_required；即使当前字节等于 C/R 也不猜完成。重复 request 不产生第二次写入，不自动覆盖当前文件。

程序能保证的是：在已验证和未失败的执行链内满足上述校验、保存材料、正确分类、拒绝条件及不自动回写。程序不能保证任意外部进程/驱动/存储没有竞争，不能保证物理断电 durability、未保存编辑器缓冲区、文件全对象或跨文件原子性，也不能保证释放句柄后 R 不再被修改。GUI 的“已核验”必须附本次观察时点，不能持续宣称磁盘等于 R。

## 5. 元数据 profile 与平台边界

拟 profile 名称 `windows-original-object-v1`，使用独立 observation 和 qualification：例如 `observation.sacl={state:'unavailable',value:null}`、`qualification={proofId,profileId,helperHash,eligible:false|true,reason}`。只有新 profile 的平台规则与所有其他门槛通过才可有 B eligible；不得改 legacy metadata 的 supported 字段，也不得将 null 当空 SACL。

**已有平台事实：**特权八组在 Windows NT `10.0.26100.0`；普通令牌本机 `10.0.26200.0`、x64、NTFS。它们构成值得进入获准开发的证据，不构成同平台双令牌生产资格。拟首批候选仅这两个 x64 build，当前生产 allowlist 为空；每个开放项都须有生产 helper 同版本、同 NTFS/API 路径的普通/特权对照。证据 manifest 记录实际 OS build/补丁、架构、NTFS/卷类型、helper 源/hash、权限掩码和协议；未纳入 manifest 的环境返回 unsupported，不自动外推所有 Windows 10/11、ARM64、ReFS、网络盘或驱动。

| 元数据 | B 每次要求 | 平台证明/不能保证 |
|---|---|---|
| File ID/卷/链接数/路径 | handle 查询身份，既有普通文件、单链接、本地固定 NTFS；父路径与 authority 再核对 | ID 相等只证明对象身份；不证明安全描述符保持或所有祖先竞争排除 |
| Owner/Group/DACL | 可读，规范描述符/保护与继承状态比较；未知、变化、未验证 ACE 类型拒绝 | 初版只开放生产矩阵验证的 ACL 形状；不推断所有有效权限组合 |
| SACL/full SDDL | 可读时比较；不可读保持 unknown，不重建、不设置 ACL | 仅 Q2 获准的矩阵范围允许平台保持证明；不可见外部 SACL 修改仍无法发现。特殊审计/MIC/resource/scoped-policy ACE 未获资格 |
| ADS | 完整且有界流枚举，只允许无命名流；失败、超额、特殊流一律拒绝，提交前后再观察 | `:probe=null` 不是无 ADS；主流 share mode 不锁住全部 ADS，新流可能在最后观察后出现 |
| EA | handle 查询，结果可验证且 empty；失败/未知/非空拒绝 | 初版不回放 EA，不用非空 EA 研究样本扩大范围；外部新 EA 不保证完全排除 |
| Archive/Hidden/NotContentIndexed | Archive 必须已置位，仅 32、34、8224、8226 四种候选组合，逐项真实资格后才能开放 | 已有 8226 保持样本不代表四格全部通过；无属性修复。外部改变可使后验失败，清除 Archive 的竞争仍存在 |
| 时间/特殊 flags/FS metadata | 特殊 flags 拒绝；记录可观测时间但不恢复旧时间 | 写入时间可能改变，不承诺 creation/access/write/change 全时间历史、压缩/EFS/稀疏/cloud/offline、对象 ID/审计日志/完整卷 metadata 恢复 |

Native 基础是已研究的 CreateFileW/GetFileInformationByHandle/ReadFile/WriteFile/SetFilePointerEx/SetEndOfFile/FlushFileBuffers 与 NT 查询。生产仅授予读写主数据、必要的读取属性/EA/描述符及 synchronize 权限；无 WRITE_DAC、WRITE_OWNER、WRITE_ATTRIBUTES、WRITE_EA 或权限提升。元数据查询可能要求补充读取权限，必须把实际权限掩码纳入 witness 重测；不能说“仅复制旧脚本”就同路径。

**特殊 SACL 的边界不能掩盖：**可读且发现未验证特殊 ACE 时拒绝；不可读时不能逐文件证明“没有特殊 SACL”。Q2 还意味着接受目标可能包含未测试的隐藏 SACL 类型，现有证明只覆盖矩阵样本，不能称这些特殊类型已经获得保持资格。若要求逐文件排除所有未知特殊 SACL，则普通令牌 B 无法满足，选择 A/C；这项风险须随 Q2 明确批准，不能通过把 OS 加进 allowlist 消失。

## 6. 原位部分覆盖风险、恢复范围与缓解

为何考虑接受：既有对象保持实验覆盖八种安全描述符组合，普通令牌有实际 C→R→C 路径；已有 durable store 与权威/停止机制可复用，能给常见、完整捕获的单文件文本修改提供自动字节恢复。它并不优于 A 的全部失败语义；是以更弱的提交原子性换取普通权限和对象保持能力，须明确选择。

可以恢复：仍可读取且 digest 正确的 B/A/P、C/R，以及另一次恢复前新保存的 D。C 已包含当时用户 dirty 字节，R 的逆合并保留可证明的独立用户修改。仅当私有存储、权限、对象与计划仍可验证，才允许新计划恢复 C。

无法恢复：未被采到的后来 D、编辑器未保存缓冲、不可读/后来变化的 SACL、任意 Owner/Group/DACL/ADS/EA/属性历史、删除后的未备份对象、磁盘/备份自身损坏。后台风险窗口中遗漏的 D 可能永久丢失；部分覆盖也可能临时破坏用户工程。保存字节不等于完整文件或系统备份。

缓解：单文件、≤2 MiB、无命名流/空 EA、Archive 已置位、短计划 TTL（沿用最多 60 秒）、保存并暂停外部 writer 提示、Stop/drain、固定 generation、原对象句柄与路径核对、私有 C/R、应用配额预留、intent、读回、失败 pin、手动恢复。应用预留不是 OS 硬配额，其他程序可用尽磁盘；已 fsync/读回也不构成断电保证。不得缓存属性回放：已有 Hidden 丢失反例，修复本身会覆写外部 metadata。

intent 后失败：显示“恢复需处理”，阻止该对象新的本功能写入，释放/排空句柄和正常生命周期资源，保留所有失败代际；不要把整个聊天永久锁死。重启只核验/展示材料，不自动重放。恢复时先观察 D，支持且可备份才新建 D→C 计划；无权限/未知路径/metadata 或 D 冲突就只读/显式导出已有材料到新位置，不覆盖原文件。二次失败继续 pin，不能自动循环。

当前 store 在 journal 尾部不完整时会整体拒绝打开，故生产计划还需独立只读 recovery-reader：从完整可验证的日志前缀找到当前 scope 已授权材料，重新验证私有对象权限/长度/digest后显式导出，不修改坏日志、不恢复 apply 资格。没有有效前缀或对象损坏就拒绝材料；正常 store 不可写时也不新建自动恢复计划，日志人工处理另行批准。该能力尚未实现，不能把现有前置 EIO 注入等同真实尾行损坏恢复验证。

## 7. A/B/C 路线比较

| 维度 | A 现有候选替换 | B 独立原对象 provider | C 只读预览与已有材料导出 |
|---|---|---|---|
| 内容恢复 | 原契约内的受限替换；不保证最后 C→rename 窗口 D 保存 | 单文件 R 写回及新确认 C 恢复；可能部分覆盖 | 精确候选/冲突/归因说明，人工合并 |
| 普通权限 | 完整 SACL 读/写是当前技术阻塞；缩小 ADS/EA 不能消除 SeSecurityPrivilege 要求 | 通常不需要审计/管理员权限，但必须具备实际数据与可观察 metadata 读取权限 | 不请求写回权限；材料隐私资格仍必须满足 |
| metadata | 完整枚举/复制/回读的窄 profile；未知拒绝 | 保持原对象、不重建；未知 SACL 的特定平台证明与不可见竞争需批准 | 不主动写当前工程；不能凭空补历史 metadata |
| 故障与外部并发 | staging 失败通常保留 C；rename/日志仍可能不确定 | Write/EOF/flush/日志可能部分或完整 R；ADS/ACL/属性竞争仍有 | 无本功能自动覆写；人工操作仍会出错 |
| 范围 | 元数据完整可验证的有限环境；需额外真实平台资格 | 经获准的新证据既有单链接 UTF-8 ≤2 MiB，无 ADS/空 EA/已验证 attrs | v0.24.0 的实际只读价值；没有证据则无候选/备份可导出 |
| 交付成本 | 普通令牌下若坚持原契约需独立可信特权服务/权限方案，超出本阶段，不能自动提权 | 中等到高：native 权限/查询、私有协议、持久契约、GUI、打包与资格维护 | 最低，已交付；无法满足 P33 最终 Windows 实际撤销目标 |

ReplaceFileW 不是已证明更安全且可直接交付的捷径：现有对照研究 R 丢 EA、SACL unknown；不能据 DACL/ADS 相等推断全部 metadata。没有已验证的普通权限替代实现同时满足旧完整 metadata 契约。独立特权服务可能保留完整观测，但新权限信任面及安装维护成本需要另一份设计，当前不推荐默认增加。

## 8. 最小 B 范围与审批后实现原则

只处理已有单个单链接普通 UTF-8 文本，包括可往返 BOM/CRLF/LF，≤现有预算；完整新 capture profile，intent_verified、gap=0、无内容冲突、固定 owner/scope/revision。拒绝旧 unknown 升级、新建、缺失文件、删除、rename、目录、symlink/junction/reparse、硬链接、binary/未知编码、超预算、ADS/非空或未知 EA、特殊属性、未资格 ACL/平台。

新 provider 显式注册 `windows-original-object-v1`，新独立 prepare/apply/recovery 契约和 `riskNoticeVersion=2`；A 未通过时绝不自动调用 B。B 也没有资格就保留只读候选和明确原因。现有 Git restore 是另一种功能，不作替代执行。

版本化 evidence 与平台 proof 是开发任务，不是未实现前必须先通过全部生产资格的循环前置。D1 只需本阶段独立授权与已有证据审阅；D2 另行 TEMP 授权。生产 Q2/Q3 风险仍须单独批准，D6 前所有写回 capability 默认关闭；每阶段完成后停止等待验收。开放前还须取得实际生产 helper 资格、负向拒绝矩阵与产品闭环，见 [实施方案](p33-4d-implementation-plan.md)。

## 9. 仍需验证与可执行资格门槛

| 门槛 | 开发前/开放前 | 判断方法 |
|---|---|---|
| 契约与证据版本边界 | 按阶段/生产前 | D1 可单独只读授权，D2 单独 TEMP 授权；生产条款 Q1–Q6 单独审批；旧证据/old A 拒绝不提升 |
| 生产 helper 平台保持 | 开放前 | 每个 allowlist 平台相同 helper/hash/权限/协议，特权八组实际 C→R→新计划 C；完整比较全 true，skip 不认证 |
| 普通/特权对照 | 开放前 | 同开放环境同写入路径；普通令牌无提权，SACL 不可读保持 unknown；两种令牌数据/ID/可观察属性符合对应资格 |
| 私有备份与预算 | 实现后、开放前 | C/R readback、ACL、实际分配计量、逻辑额度/日志余量、并发预留、损坏/ENOSPC 注入拒绝；材料可重开 |
| 失败与重启 | 实现后、开放前 | Write/EOF/flush 注入与实际 native 退出、完成日志失败、新 D、第二次失败；不自动重试，journal 不健康仍保留旧 intent |
| metadata 并发 | 实现后、开放前 | 独立进程 ADS/DACL/属性操作成功也必须被记录，不能改断言成“全被锁住”；观察到变化→拒绝或 recovery_required，无 stale metadata 修复 |
| 身份/路径/generation | 实现后、开放前 | 同字节新对象、目录替换/链接、workspace 切换、过期/跨 owner、取消/Stop 超时；零错误对象写入 |
| classic/managed 隔离 | 实现后、开放前 | 相同相对路径的两会话/worktree、关闭/重启/旧 token；只影响绑定对象、index/ref 不变 |
| 产品与包 | 实现后、开放前 | 真实 Pi 默认 write/edit→GUI 预览→逐次人工确认→byte-exact R→新确认 C，源码/打包分别实测；模型任务与 fixture 分开 |
| 未主张的保证 | 明确排除 | 不将自然 ENOSPC/断电/soak/POSIX 列为已证明；若新增这些保证必须新增真实验证，而非关闭或 mock 所有测试 |

自然磁盘错误可保留独立压力资格项；首版不承诺抵抗物理断电，不能以需要断电绝对证明的不可达门槛阻止所有有界实现。原有 8/8 不必本轮重跑，未来 production native 变更后必须重验。任何实际保持失败、资格仅靠删断言、普通权限需要提升、无法保护/读回 C/R 或不能阻止失败重放，都停止开放并退回 C。

## 10. 拟批准事项与简明审批摘要

建议逐条明确批准 Q1–Q6，或指出拒绝/修改的项；笼统“继续”不解释为批准全部风险。

- **Q1 原对象写入：**新增独立 B，允许主流 WriteFile/EOF；不是 A fallback，不承诺整文件原子性。
- **Q2 元数据资格变化：**在明确平台矩阵范围接受 SACL 不可读仍 unknown、以原对象保持证明取得 B 资格；接受无法观察全部外部 metadata 变化，也无法逐文件排除未测试的隐藏特殊 SACL。不改 A 拒绝，不声称完整 SACL 资格。
- **Q3 内容损失窗口：**接受失败可能部分覆盖、遗漏的后来 D 可能丢失；只承诺保存/验证已采到 C/R 等字节及不自动覆盖失败后的当前文件。
- **Q4 新 profile 限域：**仅新捕获、经验证平台、既有单文件文本、无 ADS/空 EA/已验证 Archive 组合；旧 unknown 不追认。
- **Q5 恢复边界：**恢复也需新备份 D、新 token、新确认；不恢复完整 metadata/未保存缓冲，不自动 retry/rollback。
- **Q6 分阶段投入：**只在阶段验收后推进；生产 helper/多会话/真实 GUI/打包验证尚未完成，开放按钮和发版另行决定。

相比 v0.24.0，获准并通过实施验收后增加的是单文件内容写回及重新确认恢复 C。意外时进入 recovery_required、保留材料，用户人工处理。当前两份文档只是审批材料；本轮不实施、不提交、不推送、不发版、不进入 P33.5b。
