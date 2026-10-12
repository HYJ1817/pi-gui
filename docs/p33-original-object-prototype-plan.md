# P33 原文件对象隔离原型研究计划

日期：2026-10-11；基线 f47c5a6。用户已明确批准隔离原型研究，不批准生产资格变更、自动提交/推送、发版或 P33.5。

## 已批准设计及取舍

沿用 p33-4a-metadata-design-delta.md 方案 C，仅在 fresh os.tmpdir NTFS 项目运行。实验使用 OPEN_EXISTING 打开原文件，持有原句柄，校验 C，再以 WriteFile/SetEndOfFile/FlushFileBuffers 写入 R；不使用候选 rename。文件对象身份是需要实测的性质，不是 SACL 保持或 OS 全局排他的证明。原位部分写入风险由持久 C/R、意图和恢复分类显式展示，不自动回滚。

只新增测试夹具、实验套件与研究报告；复用现有 session-change-store 的对象和 apply journal。生产 server/public/extensions 和现有恢复资格不改；不安装依赖、不改变系统权限、证书或审计策略。具有权限的测试子进程可以启用已分配权限；不自动提升进程。缺少权限时 SACL 必须标未验证。

## 文件和执行任务

- [x] 1. 只读核对 HEAD/契约/相关实现，运行变更前 npm test，查微软官方 CreateFileW、WriteFile、SetEndOfFile、FlushFileBuffers 和安全描述符资料。
- [x] 2. 先新增 tests/session-revert-inplace.cjs 的字节恢复、文件 ID 保持、stale C 拒绝断言，运行确认缺少原型；再在 tests/fixtures/session-revert-inplace-native.ps1 实现只允许 fresh TEMP 夹具的受限实验。native 必须在 Node 已完成备份和持久意图后收到 commit 握手才写入。
- [x] 3. 普通 NTFS protected/inherited DACL、owner/group、ADS、非空 EA、属性及 BOM/混合换行逐字节比较；R 后通过新的 C 备份/计划再次确认恢复原版本。SACL 显式/继承非空用例仅在真实具备权限时执行，否则单独计跳过，不当空值。
- [x] 4. 验证真实打开句柄、父目录替换、持久意图前拒绝、首段写入/长度调整/flush 后进程退出、备份材料重开可读、不会自动重试或覆盖新的 D；测试已有 writable memory mapping 和 metadata writer 的边界，实际现象不预设为排他。
- [x] 5. 将无外部 Pi 的实验测试接入 npm test；运行完整回归。只读验证生产元数据拒绝仍在、无生产引用原型、无新 HTTP 出口；改动未涉及 server/public，不需要改变生产打包产物。
- [x] 6. 新增 docs/p33-original-object-prototype-research.md，更新设计差异的“仅研究已批准”状态和验收报告的研究链接，记录普通权限事实、未验证 SACL、崩溃/并发风险及是否有依据进入下一轮设计评审。

## 可验证结果

研究完成意味着实验和风险材料可复现，不能等同 P33.4 通过。若完整 SACL 保持无法观测，或者属性/安全信息竞争仍无可接受边界，生产仍拒绝。不以 C/R 正文备份声称完整元数据备份，不以 flush 声称断电事务，不以 share mode 或文件 ID 不变声称 strict。
