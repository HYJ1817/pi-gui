# T4-C 开发与验收记录

## 结论和交付边界

本次按任务第十五节交付 **T4-C1：可信材料与只读冲突检查**。
**完整 T4-C 未完成，C2 真实写入与失败恢复仍阻塞，不允许据此合并或发布。**
任何读取结果都保持 `canApply:false`，没有写入 nonce、确认采纳、apply/recover 或强制覆盖入口。
源码和 index 没有由 C1 写入；T4-B 的 completed、reliable 与历史 Diff 不被改写。
独立功能、安全与故障审查待外部验收，本轮只有作者自审，未启动子 Agent。

## 基线、提交和隔离

| 项目 | 当前事实 |
| --- | --- |
| before HEAD | `6db4159f69630f8f33b1dbaa1a073d8612d90af0`，包含已合并 T4-B PR #21 |
| 产品提交 | `41b356b21f7a40abe2a6cc7b8e1de1f17b17b87d` |
| after HEAD / 行为与测试冻结点 | `b866b385dc16ee1c8e91bcb2f3077dfa36e031ad`，后续只补文档和证据 |
| 分支 | `codex/t4-c-safe-apply` |
| Worktree | `C:\Users\21022\.codex\worktrees\t4-c-safe-apply\pi-GUI` |
| 精确基线 CI | [39915263689](https://github.com/HYJ1817/pi-gui/actions/runs/39915263689)，push、attempt 1、completed/success，8 个 job（含 CI gate）成功 |
| 环境 | Windows NTFS / OSVersion `10.0.26200.0`，Node `24.22.1`，Git `2.53.0.windows.2`，Electron `44.4.3`；普通令牌 |

主工作区最初是 `724bd48119dd7ba5ba7e1327da12353bd0339ea7`，原有未跟踪文件保留。
没有在该目录或 Gemini 的 `release-v0.28.0-prep` Worktree 编辑、构建或验证写入。
版本保持 0.27.0；`package.json` 只修改测试 alias。未修改 workflow、发布脚本、Release Summary、tag，
没有 push、创建 PR、合并 main、rebase、同步发布分支或发布。

收口只读核对发现 v0.28.0 已于 **2026-10-23 17:12:43（Asia/Shanghai）** 发布，远端 main 和 tag 解引用提交均为
`f542aece54a06eef1cc2d13bf4b93531a47b3997`，annotated tag 对象为 `74de49217a587c0867eb21e01a5aef7416e46950`。
本分支没有吸收这些提交。主工作区收口仍为上述 `724bd48`，五项既有未跟踪文件与任务开始时相同。

## 实际修改文件

| 文件 | 作用 |
| --- | --- |
| `lib/candidate-adoption.js` | 有界三份观察、精确对象身份、材料摘要、资格与只读冲突检查、实际文件计划 |
| `server/candidate-runs.js` | 可选材料采集/保存、独立只读检查生命周期和单飞；不改变 T4-B 成功判断 |
| `server/candidate-store.js` | 保留有界可选证据；异常扩展不隐藏旧历史；只读检查遗留 writer lock |
| `server/candidate-routes.js` | 复用原认证与 authority，仅接受 action/id；固定拒绝说明 |
| `public/candidate-review.js` | 原弹窗的只读检查页、实际范围与拒绝状态、迟到响应隔离 |
| `tests/candidate-adoption.cjs`、`tests/candidate-adoption-ui.cjs` | 新临时 Git 和 UI 行为回归 |
| `tests/candidate-runs.cjs`、`tests/candidate-http.cjs`、`tests/candidate-store.cjs` | 新证据、重启、遗留格式、并发、只读与 HTTP 边界；原断言保留 |
| `tests/candidate-electron.cjs` | opt-in 扩展原真实 Electron fixture，全部原断言保留 |
| `package.json` | 将两个新套件加入原 `test:candidates`，canonical 从 184 增至 186 个叶命令 |
| `docs/T4-C-design.md`、本文件、`docs/README.md`、`docs/git-changes.md`、`docs/security.md`、`docs/testing.md`、`docs/evidence/t4-c/` | 设计、当前边界、验收与少量截图/结构化记录 |

没有新增依赖，未修改 T3 评论格式、T4-A 任务格式、Pi RPC、审批、Browser 权限、Stop 或 P33 provider。

## 可信采纳材料与资格

设计和代码依据详见 [T4-C-design.md](T4-C-design.md)。T4-B 原私有材料缺少持久来源身份和候选输出身份，
不能事后从 Diff 或仍存在的文件猜回原始对象。旧记录继续看 Diff，检查返回“该候选结果暂不支持安全采纳”。

新记录在同一 v1 存储中增加最多 1 MiB 的可选证据，绑定 run、最终执行状态、scope、Worktree ID/epoch/分支、
reliable/未确认原因、历史 Diff 摘要及来源/候选输入/候选输出的完整观察。
实际字节仍从后端确认的候选 Worktree 重读；不接收 Renderer 上传的源码或 patch。
字节摘要、Git mode、Node 权限位、BigInt dev/ino/birthtimeNs、Git 指针及完整目录清单共同核对。

只有 completed、reliable=true、无未确认原因、Diff 完整且三份材料匹配，才继续只读检查。
候选已有对象或目录替换、未解释的新空目录、权限/Git 指针变化独立拒绝，不能继承 T4-B 的可靠标签。
损坏、未知版本、超限或缺少扩展均不产生写入资格。SHA 用于检测材料不一致，不是同用户恶意进程不可伪造的签名。

## 来源冲突、权限与互斥

保守比较全部来源，而非只比较目标列表：HEAD、完整逻辑 index、config、root/admin/common、
Git 指针、全部文件字节/对象/模式和目录。相同 status、同字节文件替换或父目录替换均不能绕过。
新增路径占用、删除目标新改动、untracked、ignored、链接、特殊路径和 Git lock 拒绝。
index cache/格式刷新可与逻辑 staged 变化区分，source index 从不刷新或写入。

沿原完整 owner/scope authority 和 Worktree Registry 身份取根，只接受 run ID；同仓库另一 Worktree 不能成为目标。
每个异步读取后重新核对 scope、已知忙碌状态和遗留锁；同实例只允许一次检查。
Planner、Verifier、Runtime、Stop、工具和 mutation admission 的原 busy 判据保留。
重复只读不等于 OS 写者独占，结果只是本次观察；全程不签发写入 token。

## C2 写入事务与恢复：阻塞项

1. `server/session-revert-writer.js:118-122` 的末次检查到 rename 有窗口。
   本机原 `tests/session-revert-writer.cjs` **22/22、退出 0**，其中独立子进程写 D 后被 R 覆盖的用例实际成立，
   C 备份不包含 D。该用例证明 limited writer 的风险存在，不能当成符合 T4-C 的证明。
2. 直接调用当前生产 `openOriginalAttempt` 和 `applyObjectRevert`，二者均返回 `production_allowlist_empty`；
   没有使用未导出的研究工厂或测试开关绕过。
3. 尚无覆盖新增/删除/多父目录、多文件 intent、持久完成、崩溃重启和安全恢复的生产 provider。
   Node 权限位不证明 NTFS ACL/ADS/EA/SACL；多次读取不消除写入窗口，普通多文件操作不具全局原子性。

因此本次真实来源写入事务数为 **0**，没有“采纳中 / 已采纳 / 部分恢复完成”等虚构状态。
本次没有实施自动回滚或恢复；第一处真实写入前的 durable C/R 与逐步 intent、所有权重验、
新的明确恢复确认、外部 D 保留和恢复再次失败的生产流程仍须由 C2 交付。
不使用 reset/clean/stash、字符串 patch、普通复制或自动 Git add/commit 代替它们。

## 验证记录

所有写入测试只在 `os.tmpdir()` 下合成 Git fixture 运行，无真实 Pi/模型调用。
现有离线依赖通过只读使用的 node_modules junction 复用；Electron 从本机同版本缓存离线解压到本 Worktree，
运行时 SHA-256 `bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`。
没有下载依赖、变更共享依赖或调整系统权限。

| 命令 / 层次 | 实测结果 |
| --- | --- |
| 基线 `npm run test:candidates` | 25 + 13 + 26 + 10 + 9 = **83/83**，退出 0 |
| `node tests/candidate-adoption.cjs` | **45/45**，退出 0；文件 symlink 创建因现有权限跳过 1，未计通过 |
| `node tests/candidate-runs.cjs` | **34/34**，退出 0；原 26 条全部保留 |
| `node tests/candidate-http.cjs` | **13/13**，退出 0；原 10 条保留 |
| `node tests/candidate-store.cjs` | **14/14**，退出 0；原 13 条保留 |
| `node tests/candidate-ui.cjs` | **9/9**，退出 0 |
| `node tests/candidate-adoption-ui.cjs` | **9/9**，退出 0 |
| `T4C_CHECK_ADOPTION=1 node tests/candidate-electron.cjs` | 冻结点 **45/45**、0 skip、退出 0；第一轮同为 45/45 |
| 完整 canonical | **186/186 叶命令退出 0**：core 115/115、UI 24/24、security 27/27、native 2/2、faults 18/18；见下方环境跳过 |
| `npm run build:app -- --rebuild` | 离线完成、退出 0，生成 App/SEA；整包约 328.8 MB |
| `npm run fixtures`、App / SEA 资源检查 | fixtures / App **26/26**、SEA **49/49**，退出 0 |
| `node tests/candidate-packaged.cjs` | App/SEA 实际后端、认证、静态资源摘要及随包 guard **21/21**，退出 0 |

补充串行 `npm test` 退出 0、展开旧的 184 个叶命令；其中存在 symlink/SACL 环境断言跳过，详见原始日志。
它启动于基线，但运行后段工作区已有 C1 接线（后段 P33 源码未改），故只保留原始记录，
**不把这次运行冒充冻结点的新实现完整证明**。准确基线证明来自上述 main CI 和 83/83 定向基线。

最终 canonical 于 **17:38:36～17:56:15（Asia/Shanghai）** 执行，五组逐条命令与当前唯一 test 链完全相符，
每个命令 status=0、signal=null、error=null；这是一份完整本地 canonical 分组证明，**不是声称最终串行 `npm test` 成功**。
已核对 588 个冻结输入逐字节摘要未变化，另核对 `server.js` 及全部代码/测试相对冻结 HEAD 无 diff。

环境跳过合计 **21 项**，均未计为通过：`candidate-adoption` 文件 symlink 1、`logging-leaks` symlink 1、
`session-search` 5i symlink 1、旧 SACL witness 8、旧 in-place 非空 SACL 2、新 object SACL witness 8。
没有将跳过改写为通过，没有删除安全断言；C1 新增的 45 条与环境 symlink 分支分别记录。

原始记录在本 Worktree `.probe/t4c-*.log` 和分组 JSON；588 个冻结输入和逐文件摘要在 `.probe/t4c-frozen.json`。
最终 canonical 使用原分组器，隔离 TEMP 和端口，不增删或另抄测试清单，不修改旧断言掩盖失败。
App/SEA 的实际字节数和摘要、冻结结果、完整跳过清单、失败记录及截图摘要见
[结构化证据](evidence/t4-c/verification.json)。本次 manifest 实测为 324 项，未套用历史报告的资源数量。
SEA 为 **102,647,296 字节**，App 整包 **344,793,574 字节**；App 与 SEA 的后端均为 2,414,372 字节、
SHA-256 `530e55face12f8dd47bc4481829e7e22604dcbaeefb30ab1a76e6c6dd9644404`。
相对文件链接 **162/162** 和 `git diff --check` 通过；未将锚点或外链检查计入该数字。

### 实际失败与修复

- 新 API/按钮先分别复现缺失，再接线；控制器 API 缺失也先实际失败，日志保留。
- UI fixture 初始只提供空 body，无法加载原 modal；修正为完整产品 index 后，得到真正的“缺少只读入口”失败。
  最初夹具 TypeError 留在会话工具输出；后续缺功能失败日志保存在 `.probe/t4c-ui-red.log`，没有补造原始文件日志。
- 可选扩展深度损坏导致 `JSON.stringify` RangeError 隐藏整个历史：新临时材料用例先失败，
  再将异常扩展降为无 C1 证据，14/14 通过，磁盘原件和旧结果不改写。
- 一次误启动重复定向 alias，按命令行和创建时间核验后终止自有进程树；两条已退出子进程出现 taskkill 竞态错误，
  后续查询确认已不存在。该运行退出 1/取消，不计通过；正式定向和 canonical 单独记录。

### 真实 Electron 范围

生产前端/后端 + fake Pi + 临时 Git：评论/修改任务 → 明确创建候选 → 原工具审批 → 实际候选写入 →
真实 2→3 Diff → 只读条件检查 → 来源冲突拒绝 → 重启恢复 → Stop。
检查来源原字节、index 和 Composer 草稿保留；720/900/1200/1536px、Specs + Changes、Browser + Changes、
真实 WebContentsView 脱离/恢复及正常 `sandbox:true`。没有使用 `--no-sandbox`。

少量截图：[只读范围](evidence/t4-c/01-readonly-plan.png)、
[Browser 分屏](evidence/t4-c/02-browser-readonly.png)、[来源冲突](evidence/t4-c/03-source-conflict.png)。
它们不是完整写入/崩溃恢复 E2E 的替代品；C2 全部写入及多文件故障矩阵均未运行，因为生产功能未实现。

## 限制、剩余风险和人工恢复

- **C2 未实现，完整 T4-C 不满足最终验收标准第 5、8～10 等真实写入/恢复要求。**
- C1 仅观察，不提供 OS 独占或完整 NTFS 元数据资格；无法排除同权限恶意本机进程。
- legacy 记录不补造身份；源码容量、特殊 Git、路径、untracked 和 ignored 限制继续保守拒绝。
- 文件 symlink 和 SACL 的未验证环境分支不能计为通过；junction/hardlink 已在真实 fixture 验证。
- 只在本机 Windows、fake Pi 验证，POSIX 和真实模型未验证。
- 独立安全、功能和恢复审查尚无证据。作者自审不能替代它们，也不能授权合并。

作者自审覆盖完整产品 diff、旧记录兼容、scope/Registry、所有只读分支与失败路径；未发现可证实的 C1 新增阻断问题。
完整 T4-C 的结论仍是**不通过**：上述两组 C2 技术阻塞没有解除，不能将 C1 的测试通过提升为写入资格。

**是否需要人工数据恢复：否。** C1 没有对用户来源文件或 index 写入。
故障注入、取消的重复测试和恢复材料属于合成临时 fixture；没有删除未知材料或处理用户既有事务。

## 后续合并条件与回滚

本分支不自行合并。先由独立验收确认 C1 边界与证据；若只合并 C1，需用户明确认可这是只读部分交付，
不能将其标为完整 T4-C。若按完整目标验收，必须先解决设计中的 C2 provider、所有权、事务与崩溃恢复缺口，
完成真实写入/失败/重启 E2E 和完整 canonical，再取得独立功能、安全及故障审查和用户合并许可。

回滚按产品、测试入口、文档三个边界分别 revert，再重建 App/SEA。
原候选 Worktree、分支和私有材料保留；旧版忽略可选扩展仍能读取原 v1 Diff。
不因代码回滚清理候选、强删锁或对来源执行 Git 恢复；未知身份或事务材料保持原状。
