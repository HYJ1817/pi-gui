# 2026-10-19 原始审查剩余问题修复

## 范围与基线

本轮处理 `pi-GUI_代码问题整理_20261018.docx` 的剩余缺陷。附件是待核实的问题
证据，其中的建议不视为额外操作授权。上传空间管理、运行视图性能重构不在本轮范围。

工作分支：`codex/fix-high-risk-regressions`。开始时保留了首批三提交
`9861f62`、`06fa627`、`8b29455`，再以 `73aee4c7809db77ea39c076f8ef5546732c4ef95`
同步 main 的 CI 优化基线（main `d22af5e54048b1a9fb1f87d5b954dff55423db29`）。
初期基线使用该提交的不可变 `git archive` 副本。迁移测试需要历史 Tag，最终改用
固定在该 SHA 的独立本地 Git 克隆，并复用现有依赖；没有升级依赖。

首批问题 1、4、7、10 的实现与验收见
[首批记录](high-risk-regression-fixes-20261018.md)。本轮不改版本号、Pi、Electron、
依赖、workflow、Tag、Release 或已安装应用。

## 原始问题逐项处置

| 编号 | 原始问题 | 本轮结果与证据 |
| --- | --- | --- |
| 2 | 附件还在解析时可以发送 | 图片 FileReader 预览阶段先登记 loading；按钮与 `submit()` 同时拦截。完成后恢复发送；解析失败与 loading 分开，失败说明仍可显式发送。真实 Enter、按钮与实际异步上传均覆盖。 |
| 3 | DOCX 制表符、软换行丢失 | 按 XML 顺序读取 `w:t`、`w:tab`、`w:br`、`w:cr`，仅解码文本节点；转义的标签文本不会变成控制标签。App/SEA 实际上传验证得到 `A&B\tC\nD`。 |
| 5 | Runtime 状态重画导致滚动跳跃 | 当前基线已经有按贴底意图滚动的修复，本轮未重写。真实 Electron 上滚后再输入 delta，scrollTop 保持；同时确认输出确实可滚动。 |
| 6 | 恢复、继续对话、关闭后历史缓存过期 | 删除按 conversationId 无期限复用的历史 Map。历史展示及在途响应绑定 store 记录、owner、lifecycle、revision、原生会话、workspace、cursor；变化即失效，主动打开重新只读获取。未变化的关闭记录保留身份，取消资源确认不清历史；恢复成功明确作废在途请求。迟到响应不恢复旧历史。 |
| 8 | Classic 400ms 防抖草稿串会话 | 在写入新 state/sessionId 后同步；先将未归档输入保存到内部旧 key，再恢复新 key，避免把旧文本继续留在新会话。localStorage 拒绝写入时改用仅本页内存的纯文本草稿，A/B 切换仍能恢复各自内容；不含附件，刷新即丢弃。覆盖防抖前后、A/B 往返、真实生产 RPC response 路径和存储拒绝边界。 |
| 9 | 长历史返回最早 800 条 | 在有界字节窗口内解析后取最后 800 条；恰好 800 条不虚报截断。保留 messageId 和可证明的绝对 userIndex；字节截断后 userIndex 明确为 null，搜索优先按原生消息 ID 定位。 |
| 11 | Runtime 审批成功后仍可重复提交 | 中央/弹窗共用 store 的请求对象和 submitting 状态。成功仅移除匹配 owner 的那一项；失败恢复重试并显示错误。跨视图重复、旧控件、视图关闭、owner 换代、原生身份补齐均验证。其他审批输入保留，owner 改变时不复用旧控件。 |

## 实现边界

修改文件按回滚边界分组如下（19 个）：

- 业务实现 11 个：`lib/extract.js`、`server/session-history.js`、
  `public/attachments.js`、`public/composer.js`、`public/draft.js`、`public/usage.js`、
  `public/rpc.js`、`public/runtime-conversation.js`、`public/runtime-sessions.js`、
  `public/runtime-state.js`、`public/runtime-store.js`。
- 测试/入口 6 个：`package.json`、`tests/review-regressions.cjs`、
  `tests/review-electron.cjs`、`tests/review-packaged.cjs`、`tests/ui3-composer.cjs`、
  `docs/claude-ui-redesign/ui3a-evidence/unit.json`。
- 验收文档 2 个：本文件和 `docs/testing.md`。

- 继续使用现有 composer/RPC、draft、`sessionMessageBody`、runtime store 和生产 API；
  没有新增依赖、第二份运行状态或第二份后端权限策略。
- 审批提交前、响应后仍核验捕获的 owner；后端继续裁决权限、Stop barrier 和
  `stale_approval`。前端卡片消失不是权限提升，也不是原生 Writer 的安全资格证明。
- owner 补齐 sessionId 期间，旧响应只能释放其对象上的 pending 标记，不能移除新
  owner 的审批。对象已被替换时不修改替代项。
- 历史继续使用原有 same-fd、文件身份、header/cwd 和后端 locator 校验；不 spawn Pi，
  不占运行名额，不接受 Renderer 文件路径。已有字节预算不变。
- 字节预算外或 800 条窗口外的搜索命中不保证展示；没有可证明的索引时不猜测位置。
- 所有写盘验证使用 `os.tmpdir()` fixture、独立数据目录、假 Pi/无项目状态。
  打包验证使用每次新建的私有 fixture token；token 不入报告、源码或日志。

## 测试入口与证据

新增 `tests/review-regressions.cjs`，纳入唯一完整入口 `npm test`。递归展开的完整集合
为 147 个入口（此前 146 个），CI 分组一致性检查通过；没有另维护 workflow 测试清单。
原 UI3 Composer 的 loading 发送断言改成禁止发送，失败附件仍可发送；原 34 项未删减。

| 检查 | 结果 |
| --- | --- |
| 修复前新回归 | 最初 20 个场景中 18 个失败，2 个边界场景通过；逐项确认失败原因 |
| 最终新增回归 | 32/32，失败 0，跳过 0 |
| UI3 Composer | 34/34，未删减原有用例 |
| Runtime conversation / store / display | 48/48、25/25、82/82 |
| Runtime resources | 45/45，保留原“Esc 取消第三会话不发送 resume 且保留历史”断言 |
| 完整清单内的 Runtime 集合 | 按权威清单动态提取的 17/17 个套件全部退出 0，无手工维护第二份清单 |
| Runtime history/search | 35/35，含真实临时 Git/native JSONL 与身份竞争 |
| 配额 / Git 环境探针 | 53/53、161/161 |
| `node tests/review-electron.cjs` | 9/9，失败 0，跳过 0；生产完整 app/CSS、受信鼠标/键盘、离线 API/SSE fixture；9 张截图 |
| 首批 `node tests/high-risk-electron.cjs` | 12/12，冻结源码后重新运行，受信输入；首批草稿修复未回退 |
| `node tests/review-packaged.cjs <构建根>` | 4/4，失败 0，跳过 0；两种产物的真实 DOCX 上传，18 份 Renderer SHA-256 对比 |
| 隔离源码 `npm test` | 退出 0；3403.223508 秒；0 failed；阻塞项 0。这是最终草稿改动前的完整链 |
| `public/draft.js` 最终改动后的受影响验证 | `review-regressions` 32/32、`review-electron` 9/9、UI 分组 23/23 个套件；相对完整链只有 `public/draft.js` 与该两项测试文件发生变化 |
| 不可变基线 `npm test` | 退出 0；3408.3002776 秒；0 failed；与修复版使用相同环境边界 |
| P33 Object Writer / Faults / Witness | 19/19、45/45、0/0 且明确 skipped=8；均对最终源码重新执行 |
| 最终 App / SEA 标准检查 | 26/26、49/49；均对最终隔离构建执行 |
| 最终包内回归 | 4/4；App/SEA 实际 DOCX 上传通过，18 份 Renderer 摘要与源码一致 |

Electron 交互夹具使用 `--no-sandbox`，仅验证交互与真实渲染，不作为沙箱隔离验收。
产品启动参数未更改。未运行真实模型、用户真实会话、全局 Pi 或安装更新。

## 环境失败与处置

所有失败日志保留，不以重复运行本身作为通过理由：

1. 原始 `npm test` 在 187.311 秒以退出码 1 停在 Native witness：Windows 拒绝未签名
   PowerShell 脚本。仅对测试进程设置 `PSExecutionPolicyPreference=Bypass` 后，探针能
   正常执行，明确报告缺少 SeSecurityPrivilege；没有修改系统/用户执行策略或提权。
2. 系统 TEMP 下的 esbuild fixture 写入被拒绝，修复前后均复现。改用仓库内独立
   TEMP/TMP/TMPDIR 后，同一配额探针 53/53；没有改断言、产品代码或扩大超时。
3. 仓库内 TEMP 让“非 Git 目录”发现外层仓库，修复前后 Git 套件都为 159/161。
   为测试进程设置 `GIT_CEILING_DIRECTORIES=<本次 TEMP>` 后 161/161；实际 fixture
   仓库仍在自身 `.git` 中完成正常验证。但 Worktree 安全封装主动清除 Git 环境变量，
   不受这一设置影响：不可变基线运行至 Worktree 后仍以 `storage_inside_project`
   提前退出（498.246 秒）。没有放宽该封装或断言。
4. 同机并行基线与修复版的 Chrome CDP 默认端口发生冲突；最终分别设置独立
   `UI2C_CDP_PORT`。HTTP 测试端口、TEMP、日志及 Git fixture 也分别隔离。
5. Electron 初期的系统 TEMP 访问失败、夹具 DevTools 命令等待和 IPC 不可克隆返回值，
   均保留日志。交互夹具改用独立 TEMP、离线 HTTP 夹具代理及可克隆的执行结果；
   失败退出码独立保存，关闭窗口不会把失败覆盖为成功。首次加载依赖包还出现了运行时
   惰性初始化提示，不能将该次尝试视为完全离线的网络证明；新夹具现直接检查现存运行时，
   缺失即失败，避免调用包入口的自动安装路径。版本与锁文件未改变，产品未因此修改。
   页面加载后的一次夹具等待也未结束，结合本地 Electron 文档推断可能与后台帧节流有关；
   新夹具只对自己的窗口关闭后台节流，并为动画帧等待加入 5 秒失败边界，随后 9/9。
   首批夹具用独立现存运行时进程、后台绘制参数及报告/退出码双重校验重新得到 12/12。
   PowerShell 直接调用 GUI 程序时的提前返回不计作通过。
6. 增补审批输入保留和 owner 绑定边界后，停止了本轮自己的中间完整测试进程树，
   再对冻结源码运行完整入口。只停止了经 PID、父子关系与创建时间核验的自有 fixture
   进程，未终止用户程序。中断运行不计作通过。
7. 冻结树的一次运行在未改动的 Planner 原子 rename 上遇到 EPERM，437.197 秒退出。
   同一文件/用例在不可变基线中通过；换独立仓库外 fixture 后定向 98/98。
   日志保留。尚未确认当时的拒绝原因（包括是否存在持锁者），不能仅凭后续通过宣称此环境从无偶发问题；
   本轮没有给 Planner 加重试、放大超时或删除失败断言。
8. 最终本机环境保持普通 TEMP 在仓库外，只通过独立 `NODE_OPTIONS --require`
   启动文件，为 `native-provider-quota.cjs`、`project-config.cjs` 两个 esbuild 套件
   设置其各自可写的 TEMP/TMP/TMPDIR。该文件不替换函数、不注入测试结果、不改变断言、
   没有写进产品或 CI；Worktree 的 Git 环境清理原样保留。相同环境下定向验证为：
   quota 53/53、project-config 115/115、worktrees 56/56、视觉 57/57、lifecycle 98/98。
9. 完整链捕获本轮历史失效的真实回归：资源预检重复 seed 一个没有 owner 的关闭记录，
   store 原先每次换新对象，导致 Esc 取消第三会话确认也清掉历史。保留原断言并修复
   seed 的同 owner 判定；恢复成功时另行明确递增历史请求 token。相关 45/45、32/32、
   25/25、82/82、48/48 均重新验证，没有把取消断言改成接受历史丢失。
10. 基线文件副本运行到旧 schema 迁移检查时，需要 `git show v0.24.0:...`，因缺少
    Git 历史以退出码 1 结束（1138.791 秒）。最终基线改为独立本地 Git 克隆，确认 HEAD
    固定在 `73aee4c` 且历史 Tag 可读；没有修改原仓库的 Tag、Release 或 main。
11. 后续完整链的原“身份变更拒绝历史”断言发现，本轮提前取消在途请求后丢失了原有
    身份提示。失效时按捕获 locator 明确提示，同时继续丢弃旧正文；原用例不变，
    Runtime finishing UI 恢复 27/27。随后集中执行完整清单中的 Runtime 集合 17/17。
12. 最终 SEA 首次在仓库外 TEMP 启动时只输出“exe 没能启动”。最小探针确认同一
    产物由 PowerShell 启动、以及在可预建目录下由 Node 启动均正常；诊断测试捕获到
    `EPERM: mkdir <PI_GUI_DATA>`，随后上传缓存目录 `.uploads` 也被同一沙箱限制拒绝。
    仅对 `tests/exe-check.cjs` 改用隔离的仓库内 TEMP 后得到 49/49；没有改产品代码、
    断言或超时。`tests/app-check.cjs` 使用仓库外独立 TEMP 已先得到 26/26。
13. 最终源码另起的一次完整链在 P33 Object Writer 阶段被会话切换中断，没有写出
    退出码，因此不计作通过。已保留中断日志并以最终源码重跑受影响的
    `review-regressions`、`review-electron` 和整个 UI 分组，最后单独重跑 Writer、
    Faults 与 Witness。验证边界见上方表格，不把中断或跳过计入通过。

完整链共记录 20 个显式跳过：18 个 SACL 场景（两套 witness 各 8 个、inplace 2 个）
因没有 `SeSecurityPrivilege` 跳过，另 2 个符号链接夹具因当前环境不能建立链接跳过。
跳过不算通过，也不会被改写成空 SACL 或已验通过。

## 剩余安全边界

- P33 Object Faults 的真实外部元数据竞争测量为
  `externalProcessSucceeded=true`、`preCommitRefused=true`、
  `globalMetadataExclusion=false`。Writer 在提交前能观察到竞争并拒绝，但无法
  排除其他进程在窗口内改变 ADS / DACL / attributes；这不构成生产 Writer 的
  全局面安全证明。
- 当前进程没有 `SeSecurityPrivilege`。`session-revert-sacl-witness` 与最终
  D2 Object Witness 各明确跳过 8 个 SACL 场景，`session-revert-inplace` 另跳过
  2 个；全部未计入通过数量，`productionQualified=false`。

## 审查、交付与回滚

按合并后的 `REVIEW.md` 自查本轮全部 diff、异步归属、审批边界、历史定位及测试入口。
用户要求唯一 Agent、不使用子代理，因此没有独立功能/安全 Agent 复审；这是明确的
验收限制，不将作者自查称为独立审查。合并仍需用户决定。

本轮远端写操作：无。没有推送、创建 PR、合并 main、强制推送、修改 Tag/Release 或发版。
已安装版本保持原样；隔离构建不是安装升级。

原始 `origin/main` 为 `d22af5e54048b1a9fb1f87d5b954dff55423db29`；本轮起点为
`73aee4c7809db77ea39c076f8ef5546732c4ef95`（main 加首批修复）。业务提交为
`6dd881b972c7bb8841e6321cec05a1294c36961d`，测试/入口提交为
`04f62f96146c39f5dee91cc09b96d5aa035d8b90`。最终分支提交承载本文档。回滚以业务
提交为边界，合并后使用 `git revert 6dd881b972c7bb8841e6321cec05a1294c36961d`；
无需改写历史或恢复 Tag。测试入口与文档提交独立保留，若同时回退，应按相反顺序处理。

本机证据索引：

- 审计与日志根：`C:\Users\21022\AppData\Local\Temp\pi-gui-remaining-bugs-fca1e7ec8a85407f8d8a5789beca4e18`
- 最终隔离构建：`C:\pi-GUI\.probe\remaining-final-verified-build-0ca317be1af942969d21e59f87b42c57`
- 完整链：`sealed-npm-test.log`、`sealed-npm-test.json`
- 不可变基线：`baseline-git.log`、`baseline-git.json`
- 最终受影响测试：`review-electron-final.log`、`draft-storage-green.log`、`final-ui-group.log`
- 最终 P33：`final-p33-writer.log`、`final-p33-faults.log`、`final-p33-witness.log`
- 最终产物：`final-verified-app-check-shared.log`、`final-sea-workspace-exe-check.log`、
  `final-review-packaged.log`
- 中断的最终全量尝试：`final-npm-test.log`（不构成通过证据）

本次只做本地提交；分支尚未推送，PR、合并、Tag、Release 和安装版均未变更。
