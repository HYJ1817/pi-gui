# P33.4a Windows 元数据设计差异：待人工决策

状态：2026-10-11 用户已批准方案 C 的**隔离原型研究**；生产契约变更仍未批准、未接入生产。原生产资格继续要求完整 before/after/current 元数据；读取不到 SACL 时继续拒绝。此文不授权 unknown 放行。

## 1. 当前事实和官方资料

原设计 §5.7/§6.3 要求元数据可枚举、保留、回读，且同目录候选替换，禁止 truncate 原文件或 rename 失败后退化为覆盖。原 profile 在 `server/session-revert-metadata.js` 中将完整 SDDL/SACL 作为硬资格，因此普通令牌没有审计权限时拒绝。

微软 [SACL Access Right](https://learn.microsoft.com/en-us/windows/win32/secauthz/sacl-access-right) 和 [GetNamedSecurityInfoW](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getnamedsecurityinfow) 明确：访问审计 SACL 需要对应权限；owner/READ_CONTROL 可读 DACL，不代表能读 SACL。[AdjustTokenPrivileges](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-adjusttokenprivileges) 只能启用已分配的权限，不能为普通令牌创造权限。没有自动 UAC、赋权或修改系统安全策略。

[ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew) 明确列出 DACL、security resource attributes、部分流等保持性；不能将 resource attributes 或笼统 ACL 措辞扩大成完整审计 SACL 保持证明。其最终文件 ID 来自候选文件；失败存在中间状态，不能视为 CAS。IGNORE_MERGE_ERRORS/IGNORE_ACL_ERRORS 不可使用。

本机 `tests/session-revert-metadata-research.cjs` 真实 NTFS、普通令牌实验：flags=0，C→R 成功，备份 C 相等、DACL 相等、ADS 相等、属性 8226→8226；**原 EA 没有出现在 R 中，备份保有原 EA**。审计权限不可用，SACL 前后值为 unknown，不能将 null 当空。此单样本不认证 ReplaceFileW 的全部元数据语义。

## 2. 方案比较

| 方案 | 能解决什么 | 不能证明什么/取舍 |
|---|---|---|
| A 保持现有完整观测 profile，在已获审计权限的独立 Windows 环境验证 | 契约不变，可证明该环境真实复制/回读 SACL | 普通用户令牌仍不可用；当前没有该环境，不自动提升 GUI |
| B 普通权限改用 ReplaceFileW，以 DACL/属性/ADS 成功推定全部元数据 | 有官方 DACL/流能力、实测内容替换 | 完整 SACL 未证明，EA 实测丢失；**不推荐、不允许直接实现** |
| C 研究保持原文件对象、只修改数据的独立 writer profile | 理论上可利用同一 NTFS 文件对象和不改变安全描述符的官方操作，避免复制不可读 SACL | 改变“候选替换、禁止原文件覆盖”契约；写中断可能留下部分内容，需要更复杂的持久意图与故障处理；尚无完整 SACL 实测证明 |

初次评审时可直接执行的是 A 下的安全拒绝、容量修复和测试补齐。2026-10-11 用户随后批准 C 的隔离研究，结果见 §5；**生产契约变更仍未批准，C 不是现成安全方案**。

## 3. 若选择 C，必须批准的差异及前置门槛

1. 从“完整读取/复制/回读 SACL”改为“保持原文件对象的安全描述符，使用经过平台验证、仅修改数据的官方操作”；保留 DACL/owner/group/类型/属性/ADS/EA 的可观测校验。
2. 现有候选文件替换 profile 保持原样；新增 profile 不用于旧证据，不声称 strict，不将 ordinary-user token 升级为独占 provider。
3. 必须先在有审计权限的独立 Windows 临时环境构造**非空、显式、继承审计 ACE**，逐项证明原对象操作前后完整 SACL/owner/group/DACL/属性/ADS/EA 一致。只验证空 SACL或文件 ID 一致不够。
4. 再在普通令牌下执行同一版本化调用路径。需要可复核的 OS/API/文件系统版本、原对象身份、受限调用范围和测试证明；不可仅标 `supported:true` 或相信一次成功。
5. 数据部分写入/中断风险必须重新设计：先持久保存 C 和候选 R、记录意图，错误归 recovery_required，不自动覆盖新的 D。备份内容不能恢复不了解的安全描述符；不能把写回旧对象等同于完整系统备份。
6. 已有句柄、内存映射写入、外部进程和父目录竞争边界必须实测。普通文件系统、单进程 gate 或分享模式不能被称为无残余竞争。
7. 不能在取得这些证明之前开放 API 资格；若官方语义与实测无法证明保持性，则停止该 profile，继续拒绝。审批研究方向也不是批准无证明写回。

## 4. 初次提交时的人工决定建议（后续批准见 §5）

建议先提供具备已分配审计权限的**独立临时测试环境**，完成 A 的完整元数据矩阵；同时可批准 C 的隔离原型研究。此批准会扩大原设计 writer 的允许实现方式，因此需要用户明确授权。没有授权前本轮不修改原对象数据写回契约，不把“确认风险”当元数据资格。

若不批准 C、也没有独立有权限环境，普通用户生产恢复闭环仍然技术阻塞；P33.4a 不能宣布最终验收通过。当前提交的容量修复和故障测试可以独立审阅。

## 5. 已授权隔离研究的结果

用户随后批准方案 C 的隔离实验。见 [原文件对象研究报告](p33-original-object-prototype-research.md)。真实 NTFS 原对象 C→R→新计划恢复 C、DACL/owner/group/非空 EA/ADS 保持已获得合成临时项目证据；非空 SACL 未验证。实验还观察到首段写入崩溃留下部分内容、独立 ADS/DACL writer 可并行修改元数据、Archive 位可能改变。因此此次研究没有完成生产契约替代证明，没有修改生产 writer 或 unknown 拒绝条件。第 3 节的生产批准及证据门槛继续有效。

## 6. P33.4b 安全收敛（2026-10-12）

见 [P33.4b 安全验证报告](p33-4b-safety-validation.md)。本轮编号为 A=候选替换、B=原对象原位、C=仅材料，与本稿旧编号不同。已交付独立审计环境的八格 SACL 见证工具，但当前 token auditError=1300，八格全未验证。新增真实 Win32 降权故障、2 MiB 输入、重启材料及独立属性竞争实验；官方 FileBasicInfo 恢复 Archive 仍可覆盖外部 Hidden 变化，不能作为安全修复。

生产 A 和 metadata_audit_unavailable 拒绝不改。未来窄 B provider 可作为普通权限可用性的评估方向，但需独立 SACL 证明、原生版本/平台范围、Archive 已设置限定、代际备份/失败人工恢复，以及原位写入和 SACL 保持证明契约的单独批准；不提供自动 fallback。C 只是临时退路，不改变 P33 最终必须可直接恢复的目标。具体审批事项与未验证门槛见新报告 §10，本轮没有批准或实现生产契约变更。
