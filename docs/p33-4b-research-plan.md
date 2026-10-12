# P33.4b 隔离安全验证计划

2026-10-12；基线 3d83eb3；用户已授权下列隔离研究，未授权生产契约变更、提交或推送。

## 勘察与约束

复用 tests/session-revert-inplace.cjs 的 TEMP/原生编排及 server/session-change-store.js 的 C/R、对象验证和 journal。生产 store 的 recovery_required 终态不变；uncertain_external_change 是测试工具的只读投影，不是新生产枚举。旧 28 项断言保留。

本轮 A/B/C 与旧元数据设计差异的命名不同：A=现有候选替换、B=原对象原位写入、C=仅材料。旧“方案 C 已批准”仅批准原对象隔离研究，不能解释为本轮生产 B 已批准。

仅编辑隔离 fixture/测试/研究工具、npm test 注册和研究文档；不修改 server/public/lib/extensions。破坏性用例仅由工具自己 mkdtemp 创建的独立 TEMP。权限探测仅启用子进程已分配权限，不自动 UAC、不改账户/审计策略，新 SACL 工具不解除审计保护。没有权限时输出 unavailable、跳过真实 SACL 矩阵，不能用 mock 计作完整元数据证明。

## 执行任务

- [x] 1. 读取实际代码/设计和当前状态，完成修改前完整 npm test；核查 Windows/NTFS/审计权限；只核实相关微软官方接口。
- [x] 2. 新增 RED 测试，扩展原生 fixture 的权限探测、显式/继承/受保护/混合 SACL、降权句柄的真实 API 失败、真实受限请求短写、固定磁盘输入传输和句柄属性实验；旧路径兼容。
- [x] 3. 新研究套件：故障分类、重启读取 C/R/D、完成日志失败、备份/journal 损坏、独立确认的人工 C 恢复和二次失败、外部身份/主流/属性变化。仅输出 digest/布尔/固定原因，不发布原正文或安全描述符。
- [x] 4. 审计见证工具：只创建自身 TEMP，固定 JSON 结果，普通权限可复现 unavailable；独立审计环境比较完整 SDDL/DACL/SACL/owner/group/ID/ADS/EA/属性。输出权限和执行步骤，不自动运行特权系统操作。
- [x] 5. Archive 原属性恢复与竞态实验，比较本轮 A/B/C；保守推荐未来 Archive 已设置且可验证属性不变的限定 profile，不能以属性恢复扩大当前资格。
- [x] 6. 规范审查→质量审查，修复研究范围内问题；运行修改后完整 npm test；生成 docs/p33-4b-safety-validation.md，更新研究设计差异，给出未验证门槛及需要单独批准事项。

## 验证准则

API 注入应明确区分：真实 Win32 对降权/零长度调用的响应，和自然 NTFS 磁盘故障，前者不能证明后者已验证。ShareMode=0 不排除 ADS/安全信息/属性修改；失败或崩溃不自动重放 R。D=R alone 不升级 applied_verified，D=C alone 不证明从未写入。权限与元数据不可验证、故障材料不完整时拒绝；本阶段测试成功仍不代表 P33.4 产品验收通过。
