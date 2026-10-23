# T4-C 开发与验收记录

## 当前结论

C2 已实现：可信候选计划 → 120 秒单次确认 → Windows 本地 NTFS 受控写入 → 逐步验证 → 独立事务状态；失败后另行恢复预检与确认。
**当前为作者实现与自验，待独立验收，不等于代码验收通过或允许合并。** 独立功能、安全及完整故障审查未运行，按用户要求只有一个 Coding Agent。
C1 历史记录见 [历史验收](T4-C1-acceptance.md)，旧只读结论和数字仅适用于原提交。

## 基线与隔离

原 T4-C 基线 `6db4159f69630f8f33b1dbaa1a073d8612d90af0`；C2 before HEAD `092716e24d739a7857ab338604e9084f1b0f0bd3`。
产品提交 `74855022211b18eb8bb9b8ee3392845ba1c8eff0`；测试提交 / 已验证代码 HEAD `eafd65bbd1166ca9d750aae0219bcc29b660fd45`。验证绑定的 574 个代码/测试输入文件摘要与提交前一致。
分支 `codex/t4-c-safe-apply`，Worktree `C:\Users\21022\.codex\worktrees\t4-c-safe-apply\pi-GUI`。
此前观察远端 main/v0.28.0 为 `f542aece54a06eef1cc2d13bf4b93531a47b3997`；推送前 fetch 观察到 origin/main 为 `fbbaec7ab7998b5cb7cf08bb185b3287121194e1`，本分支未合并、变基或吸收新的 main 提交。
主工作区及发布 Worktree 未编辑，版本保持 0.27.0。未推送、PR、合并、tag 或发布；无新增依赖。

## 安全合同

- completed/reliable 不单独构成采纳资格；缺证据的旧历史仍可查看但拒绝采纳。后端从登记候选重读全部字节和对象，核对冻结输出与实际 Diff 摘要，不接收 Renderer 源码或目标路径。
- 来源全部文件、目录、HEAD、逻辑 index、config 与 Git admin/common 身份必须仍对应输入。保守拒绝来源新改动、链接、多链接、特殊属性、Git lock、ignored/untracked 风险；无强制覆盖或三方合并。
- 明确确认再次检查 scope/owner/generation、nonce、计划、来源、候选与互斥。复用 mutation admission 和 Stop/Planner/Verifier/工具 busy 判据。原句柄锁定后复验；目标禁止 write/delete sharing、目录禁止 delete sharing，新增 CREATE_NEW，删除保留原对象。只写 working tree，index 不变。
- 第一次源码操作前持久保存计划、原文、预期输出、身份及事务 ID；每步先 intent，后写入/flush/readback，再 step_verified；最终字节和 staged 验证通过并记录 applied 后才报成功。T4-B run/result 历史不改写。
- 多文件不全局原子。已验证步骤之间故障可另行授权恢复；未知 intent、部分原生写入、遗留锁、损坏材料、外部新改动、恢复再次失败均保留材料并拒绝自动覆盖/重试。进程崩溃可能需要人工核实，不猜 PID 清锁。

模块与细节见 [当前设计](T4-C-design.md)。不改 Pi RPC、T3/T4-A 格式、T4-B 成功判断、审批、Browser 权限或 P33 生产资格。

## 实测验证

全部写入为 `os.tmpdir()` 下合成 fixture，无真实 Pi/模型调用。Windows NTFS、Node 24.22.1、Electron 44.4.3；普通令牌，离线复用既有依赖。

| 检查 | 结果 |
| --- | --- |
| `npm run test:candidates` | 210 通过 / 0 失败；symlink 权限跳过 1；退出 0 |
| 分项 | snapshot 25、store 14、runs 34、HTTP 19、UI 9、adoption 45、adoption UI 9、writer 9、faults 9、transactions 9、apply 19、apply UI 9 |
| `node tests/review-task.cjs` / `review-task-ui.cjs` | 25/25、36/36，退出 0；原断言保留，UI 新增同轮 evidence/change 回归 |
| 真实 Electron | 最终 49/49、sandbox true、退出 0；含来源冲突检查，日志 .probe/t4c2-electron-final-text.* |
| App / SEA 构建 | 最终复建退出 0；摘要见结构化证据 |
| App / SEA 检查 | App 26/26、SEA 49/49，退出 0 |
| 打包候选检查 | App/SEA 后端、认证、资源摘要、guard 21/21，退出 0 |
| 完整 canonical | 累计 191/191 叶命令通过：首次 npm test 在第 124 项因端口 7797 EACCES 退出 1；前 123 项通过，剩余 68 项使用原清单和 SEC_PORT=39818 续跑，退出 0。不是单次 npm test 成功 |

App 默认端口 7798 首轮 EACCES；改用既有 CHECK_PORT=39812。SEA 后续构建清理 icon.ico 导致一次 App 24/26，重新运行 make-icon 后 26/26。
多次 Electron 43 项后的失败来自测试用隐藏 `.review-task` 的存在性跳过“准备修改任务”；改为实际点击后通过。删除后的隐藏任务列表仍保留旧 item，改等当前摘要 empty 状态。旧失败记录保留在 `.probe/t4c2-electron-*`，未计为通过。
曾错误将微任务合并当作修复，验证产生回归后撤回；当前任务选择维持原同步语义。未减少旧安全断言。

## 覆盖与剩余风险

原生故障测试覆盖 write/部分 WriteFile/flush/rename 拒绝、只读权限、helper 终止；控制器覆盖多文件中途失败、重启、显式恢复、重复 nonce、外部新改动、损坏日志和恢复再次失败。
磁盘不足使用通用写入失败模型，未实际耗尽磁盘。无目录 fsync/断电原子性保证。崩溃 intent/遗留锁按 fail-closed 人工处理；尚未完成整个应用强杀后所有故障阶段的真实 Electron 矩阵。
Electron 验证真实成功写入、来源冲突、重启已采纳状态、stale 评论、第二条有效意见及 Stop、四档宽度、Specs/Browser 分屏及原生遮挡；故障恢复另由控制器和 UI 套件覆盖，不能把它们声称为完整 Electron 故障验收。
仅 Windows 本地 NTFS、已有父目录、受限普通文本文件；拒绝 mode 变化/特殊属性。不恢复缓存元数据，不宣称完整 ACL/SACL/ADS/EA 事务。文件 symlink 权限分支未验证；同权限恶意本机进程不在完整防篡改保证内。

**人工用户数据恢复：不需要。** 故障材料均为合成 fixture。生产未知事务若出现，须保留应用数据目录 candidate-transactions 与候选材料，由人工核实，不自动删除或重试。

## 自审、后续验收和回滚

作者自审检查完整产品 diff、路径/字节来源、owner/Registry、nonce、互斥、步骤持久化和 fail-closed 恢复。独立审查未运行；不能用作者自审替代独立安全批准。
合并前需独立功能与安全/故障审查、处置阻断项、确认平台及崩溃恢复范围，并由用户明确授权。本任务不推进 T5 或正式发布。
本地提交按产品行为、测试入口、文档三个回滚边界组织。代码回滚后重建 App/SEA；保留 candidate-transactions、候选 Worktree 和历史材料，回滚代码不能替代源文件恢复。不得 reset/clean/stash 或自动删除锁。

## C2 修改文件

- `docs/README.md`
- `docs/T4-C-acceptance.md`
- `docs/T4-C-design.md`
- `docs/T4-C1-acceptance.md`
- `docs/T4-C2-plan.md`
- `docs/evidence/t4-c/04-apply-preflight.png`
- `docs/evidence/t4-c/05-applied.png`
- `docs/evidence/t4-c/06-conflict.png`
- `docs/evidence/t4-c/c1-verification.json`
- `docs/evidence/t4-c/verification.json`
- `docs/git-changes.md`
- `docs/security.md`
- `docs/testing.md`
- `lib/candidate-adoption.js`
- `package.json`
- `public/candidate-review.js`
- `public/review-task-preview.js`
- `scripts/build-app.mjs`
- `scripts/build-exe.mjs`
- `scripts/test-group-plan.mjs`
- `server.js`
- `server/candidate-apply.js`
- `server/candidate-routes.js`
- `server/candidate-runs.js`
- `server/candidate-transactions.js`
- `server/candidate-write-native.ps1`
- `server/candidate-writer.js`
- `tests/candidate-adoption-ui.cjs`
- `tests/candidate-apply-ui.cjs`
- `tests/candidate-apply.cjs`
- `tests/candidate-electron.cjs`
- `tests/candidate-http.cjs`
- `tests/candidate-transactions.cjs`
- `tests/candidate-write-faults.cjs`
- `tests/candidate-writer.cjs`
- `tests/fixtures/candidate-writer-harness.cjs`
- `tests/review-task-ui.cjs`

关键截图：[确认前预检](evidence/t4-c/04-apply-preflight.png)、[已采纳及事务](evidence/t4-c/05-applied.png)、[来源冲突拒绝](evidence/t4-c/06-conflict.png)。

断言数量变化：候选链由 C1 的 149 条增至 210 条，其中 HTTP 13→19，新 writer/faults/transactions/apply/UI 共 55 条；文件 symlink 的 1 个环境分支单列跳过。原 T4-B 默认 Electron 25/25 保留，C2 专项最终 49/49。

最终完整证据：首次 .probe/t4c2-npm-test.log；续跑 .probe/t4c2-canonical-resume.log/.json。Canonical 以原 package test/lifecycle 链递归展开为准，未维护第二份清单。首次运行期间仅修正预检说明文案，其受影响 UI 9/9、Electron 49/49 及重建产物检查已补验。其余代码/测试摘要 574/574 未变化。

环境跳过合计 21 项，均未计入通过断言：candidate-adoption、logging-leaks、session-search 文件 symlink 各 1；旧 SACL witness 8；in-place SACL 2；object witness 8。原生 fault 45/45、writer 19/19、Runtime 26/26 通过不提升 P33 生产资格。

用户后续明确授权“推送”，因此按产品、测试、文档三个边界提交，并准备推送 `codex/t4-c-safe-apply`。此文档提交时推送尚待执行；实际远端结果以分支与交付消息为准。未授权创建 PR、合并或发布。完整应用强杀阶段矩阵与独立安全验收仍为待验证，不宣称完整验收通过。
