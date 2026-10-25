# 可独立复制的 Antigravity 任务包

你负责 pi-GUI Z4-2 A1–A4 后端安全任务。此文件是可复制的任务包，不表示 Antigravity 已被调用。本轮若由内置协作 Agent 执行，验收必须记录其实际身份。

只在分支 `antigravity/z4-2-backend`、独立 Worktree 开发。起点是 `0f2340ee6bfd492bc5dea4adb2008bb7cbe40b0f` 的冻结契约 `docs/Z4-2-contract.md`。先读 AGENTS.md、REVIEW.md、docs/README.md、契约、Z4-1 设计、architecture/security/testing 相关章节、review-comment-store/authority、runtime-registry/rpc-bridge 当前实现。不得使用他人正在写的目录。

文件所有权仅限 `server/collab-store.js`、`server/collab-authority.js`、`tests/collab-store.cjs`、`tests/collab-authority.cjs`、`docs/Z4-2-agent-source-research.md`。不改 lib/collab-doc.js、server.js、router、package.json、tests/modules.cjs 或前端。数据模块依赖未就绪时可读原型研究，但最终必须依赖契约的生产模块，不复制另一套协议。接口调整发给 Codex 决定。

实现契约中的 store 和 authority：应用自有固定数据目录，可信 scope 寻址，schema+revision CAS，排他锁，安全临时文件+fsync+原子 rename，损坏拒写、容量与目录/文件身份守卫、失败保留字节。参考评论模式但独立存储；不接受 Renderer 路径或 scopeHash。authority 复用既有完整 Classic/Runtime 取证流程，以独立命名空间导出经过服务端验证的 scope/key/token/sessionId；确保旧 owner、generation、项目、Worktree、focus、native session 及迟到操作拒绝。

测试只写 os.tmpdir fixture。覆盖并发 CAS、进程写入中断/遗留临时与锁、损坏、链接、文件/目录替换、写入失败、容量、错误 owner/session、重开完整性、每个失败后原文件字节不变。权限限制下的 symlink 测试必须单列 skip，不算通过；至少保留可运行的替换守卫验证。不得用模拟成功代替真实文件持久化。只跑自己的定向测试，禁止全量 npm test、共享构建、下载依赖、真实 Pi/模型或用户数据写入。

A4 只读研究当前 RPC/Runtime 投影：可信来源、bridgeRun/generation、提取位置、避免文本伪造身份、失效/重试/冲突与 Z3 关系。给文件:行号证据，未具备可靠来源就明确建议暂不接入。不得改 Pi/MCP 或提前搭生产来源。

交付中文独立提交（消息写 Git 元数据 COMMIT_MSG_TMP.txt 再 commit -F），准确 SHA、变更文件、命令/退出码/实际断言数、故障矩阵与限制。不得 push/PR/merge/tag/release。Codex 会复审并 cherry-pick，保留来源。遇阻塞只停依赖任务，继续独立安全测试或研究。
