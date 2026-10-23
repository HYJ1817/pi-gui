# T4-C2 实施计划

续作基线 `092716e24d739a7857ab338604e9084f1b0f0bd3`；续作勘察时远端 main/tag 记录为
`f542aece54a06eef1cc2d13bf4b93531a47b3997`，不合并或变基。单 Agent。

目标：从 C1 的可信计划进入单次确认、真实源文件写入、可验证的逐步事务和显式恢复。

## 选择及边界

不使用旧 limited rename writer（末次检查竞态），不开放 P33 研究入口。
新增候选专用 Windows helper，使用原句柄写入与拒绝 write/delete sharing；目录链拒绝 delete sharing。
Microsoft CreateFileW 文档明确：不允许 FILE_SHARE_WRITE 时，已有写入句柄或可写映射导致打开失败。
来源所有现存普通文件被锁定后重新进行 C1 检查，Git index/HEAD/config 由额外只读句柄锁定。
新文件以 CREATE_NEW 创建；删除以原句柄 no-replace rename 保留对象。所有目标父目录必须已存在。
只支持本地 NTFS；拒绝链接、多链接、只读/压缩/加密/特殊属性、执行位变化和跨卷删除恢复。
修改仅写默认数据流，不恢复 ACL、SACL、ADS、EA 或属性；原对象与其他流保留，不套用缓存元数据。

多文件不全局原子。恢复原文、输出、身份和确认计划必须在第一次源码写入前 flush/readback。
每步先持久 intent，再操作，再持久结果；未知中间状态绝不自动继续或猜测恢复。
文件 Flush(true)/FlushFileBuffers 是进程崩溃恢复边界，不宣称目录 fsync 或断电原子性。
恢复仅对实际身份及字节与已确认步骤一致的对象进行；外部改动、材料损坏或部分写入不明则保留材料、人工恢复。

## 顺序

- [x] `tests/candidate-writer.cjs`：先失败的存在性断言；真实 TEMP NTFS 成功、多文件、独立写者/替换、占位新增、拒绝路径；可写映射场景尚未验证。
- [x] `server/candidate-write-native.ps1`、`server/candidate-writer.js`：有界 stdio 固定操作协议、句柄与路径身份、写后 digest、子进程退出不继续写入。
- [x] `server/candidate-transactions.js`：独立有界存储、持久步骤、重启发现、单次恢复、损坏保留及未决事务阻断。
- [x] `tests/candidate-apply.cjs`：nonce TTL/重放/owner/scope、互斥、重启、逐步失败、恢复再次失败、外部 D 保留。
- [x] `server/candidate-runs.js`、`server/candidate-routes.js`、`server.js`：复用 C1、原权限、mutation admission、Registry；历史结果保持不变。
- [x] `public/candidate-review.js`：准备、明确确认、实际结果/事务 ID、恢复预检及再次确认；迟到响应与会话切换隔离。
- [x] 真实沙箱 Electron TEMP fixture 验证、App/SEA 重建和资源校验；行为冻结后完整 canonical；更新 T4-C 设计与验收。

产品、测试、文档分别提交。用户后续已授权推送当前分支；不创建 PR、不合并、不打 tag 或发布，不改版本及发布逻辑。

实现和定向验证已完成。构建、canonical 与独立审查的实际状态以 T4-C-acceptance.md 为准，不以勾选代替验收证据。
