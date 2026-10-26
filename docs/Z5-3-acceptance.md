# Z5-3 历史工具摘要：后端阶段验收

日期：2026-10-27（Asia/Shanghai）。单一执行 Agent，无子 Agent。结论：**来源审计 GO，后端与定向验证完成；PR #38 未合并，按约定停在后端，UI 未集成。** 待用户独立验收，不进入下一阶段。

## 1. 基线、Worktree 与提交

- 最新 main / 开发基线：`ec336ad348f3af70e2bf4fd5e3a22dbd70d4c32a`，本轮多次 fetch 核对未变化。
- Worktree：`C:\Users\21022\.codex\worktrees\z5-3-history-summary\pi-GUI`。
- 分支：`codex/z5-3-history-summary`，从 origin/main 创建；未 cherry-pick #38，未修改其他 Worktree。
- 初始 `C:\pi-GUI` 位于 z4-5 分支且有4项既有 untracked；结尾只读核对相同，全部保留。#38 Worktree 仅只读其验收报告。
- `94a458b`：来源审计与实施合同。
- 最终生产行为 HEAD：`08069d18fc7dfc9f4ace7ec41c8909ad566ee06a`。
- 最终测试 HEAD：`2745f6080f3771202f52ffc086dce6afb3653c0e`。
- 最终交付 HEAD 为包含本报告的文档/证据提交：`git log -1 --format=%H -- docs/Z5-3-acceptance.md` 可解析；其后无行为变更。
- server tree：`ca15cc05d0749cdee528cb92586bd20f441596fe`；public tree 与 main 相同：`ee90a9d4d28a167e01febaf79c6317417684d46d`。验证时生产字节与此提交一致。
- 基线完整证明：[main CI 40359132357](https://github.com/HYJ1817/pi-gui/actions/runs/40359132357)，push / attempt 1 / 精确 ec336ad3 / completed success。本轮用 GitHub API 重新确认；不把它算成本次代码证明。
- [PR #38](https://github.com/HYJ1817/pi-gui/pull/38) 结束前仍 open / merged=false，head `7810626d527faef865be1d0f2a4a54f1cc6c16b6`；[CI 40364383360](https://github.com/HYJ1817/pi-gui/actions/runs/40364383360) 最终 gate failure，core/ui failure，security/native/faults/build/plan success。仅核对状态，未改动或重跑该 PR。
- AGENTS、REVIEW、测试政策、文档导航、Z5 roadmap / product audit / Z5-2 acceptance 及调用链已读。Jev 分类 backend(0.31)、needs_tests=0.9、risk=low；低置信分类没有降低本轮安全审查深度。

## 2. GO 依据与实际交付

逐项来源及可信人工 JSONL 示例见 [source audit](Z5-3-source-audit.md)。证据来自本机 Pi 1.4.0 安装源码与 CLI bundle，未读取用户真实会话内容；测试均用人工 TEMP fixture，不依赖真 Pi。

确认存在原生 assistant.content[].toolCall、toolCall.id/name，以及独立 toolResult.toolCallId/toolName/isError；SessionManager 把 message_end 的完整消息嵌套写入 JSONL。调用/结果和 parentId/条目 ID 可在有界窗口内形成可信关联。

| 修改 | 职责 |
| --- | --- |
| server/history-tool-summary.js（81行） | 无 I/O 的白名单摘要投影；只保留关联所需结构；不建立完整日志/原生上下文解析器 |
| server/session-history.js | 沿用同 fd 4 MiB 读取、头部/路径/文件身份复核，附加 toolSummary；正文原顺序、messageId、userIndex、800条上限及 truncated 保持 |
| server/runtime-routes.js | 在原捕获 locator 的读取后复核通过后附加字段；旧 reader 无摘要时兼容 |
| 三个新测试文件与 package.json | 两套新定向进入 npm test 和 test:runtime；打包后端专项以 test:history-summary:packaged 单独运行，因依赖本地 Windows 产物不加入无桌面 canonical |

没有修改 public/、Runtime Registry、Supervisor、Stop barrier、Pi RPC、审批、Git/Candidate/Revert、Z5-1 草稿、Z5-2 思考合同、依赖或 CI workflow。

## 3. 字段、状态与脱敏

`toolSummary` 含 items、returned、limit、truncated、historyTruncated、unavailableReason、uncertain。
每项只含 `toolName / status / source`，source 为 confirmed 或 unconfirmed。

| status | 严格含义 |
| --- | --- |
| completed | 原生形状、唯一调用和结果、同名同 ID、顺序与祖先链有效，且结果 isError === false |
| error | 同条件且 isError === true；只说明记录结果报错，包含无法细分的执行失败、取消或拦截 |
| unknown | 调用存在，但结果缺失、重复、畸形、跨分支、逆序、名称不符或链不明，不能确认最终结果 |

没有输出 interrupted/failed 来推断具体原因；不解析工具输出猜 exit code 或取消；completed 不能证明磁盘变化、任务成功、独占 Agent 归因或工具底层一定执行。

名称使用 ASCII 字符白名单与32字符上限，再匹配已核实的 read/bash/powershell/edit/write/grep/find/ls 闭集。
任何其他值（包括合法字符的未知名称、API Key 样式、路径、HTML、超长或对象）均输出固定 `unknown_tool`，不回显、不截短修补。
参数、命令、工具输出、文件/Browser 正文、thinking、认证信息、环境变量、原始路径/JSONL/调用ID、审批与可重放数据均不进新增摘要。
这不改变原 user/assistant text 的既有正文合同，也不声称清洗了原文件中的所有正文。

## 4. 容量、缺口与只读权限

- 复用原尾部最多4 MiB读取，身份 header 前后各最多64 KiB；正文最多800条。无追加文件扫描、数据库、索引、后台任务或网络请求。
- 摘要只解析该窗口末4096行，返回最近至多100次调用，`returned` 是实际数、`limit=100`。多调用共用一条 assistant 时仍按调用数限制返回。
- `truncated` 表示摘要行/调用预算；`historyTruncated` 继承原正文截断标志；`uncertain` 明示未知结果或损坏/孤儿/窗口缺口。
- 空摘要原因闭集：no_tool_calls、invalid_records、unmatched_results、summary_limit、history_window。孤儿结果不伪造调用；缺少结果不解释为失败或中断。
- 原历史不是当前分支重建，摘要明确属于文件窗口中的调用。通过 parentId 核对配对，不把其他分支结果误配；重复 ID 保守未知。旧/自定义无完整身份记录不作终态确认。
- 原 token/Origin 鉴权、后端 locator、sessionId/cwd、文件身份和读取后捕获 locator 复核全部保留；GET 只需历史授权，不要求正在运行的 Owner，也不新增 Classic 当前项目过滤去破坏历史跨项目浏览。
- TEMP HTTP 证据：已关闭/重建 Registry 后可读；浏览前后 factory 与 RPC 数不增、liveCount=0、旧 Owner 写入仍 stale_runtime、原文件字节相同；任意客户端路径不能替代后端 locator。
- 容量实测：[projection-results.json](assets/z5-3/projection-results.json)：5,243,551字节文件只读4,194,304字节，投影实测4.247ms；100项最长受控字段样本7,124字节，低于12 KiB。时间是本机单次样本，不作性能保证。现有同步读没有独立墙钟超时，本轮以字节/行/项预算约束。

## 5. 红绿与回归

红测均先于对应生产修改，原断言没有减少或替换：

1. 原基线运行新摘要测试，exit1：期望 toolSummary 对象，实际 undefined。
2. 投影通过后 HTTP 新回归仍 exit1：`HTTP must forward the proven safe summary`；增加原权限复核之后的透传后转绿。
3. 自查补畸形结果回归，exit1：content 非数组的结果误得 completed，预期 unknown；核对原生规范化数组来源后只接受数组形状，最终转绿。
4. 初始 HTTP fixture 忘建 A/B root，ENOENT 是 fixture 错误；补 TEMP 目录后才取得产品红测。没有为此修改 Registry。
5. 文档提交消息首次把绝对 git-path 再 Join-Path 导致写消息失败；改用 `git rev-parse --path-format=absolute --git-path COMMIT_MSG_TMP.txt`，无提交丢失。gh.cmd 的带管道 jq 参数曾被 Windows shell 分拆，后续使用结构化连接器核对，不影响代码。

开发前6套定向基线296/296；最终14套结果 [targeted-results.json](assets/z5-3/targeted-results.json)，全部 exit0、skip0：

| node tests/ 下的套件 | 实测 |
| --- | ---: |
| history-tool-summary.cjs | 29/29场景，126/126实际 assert 调用 |
| history-tool-summary-http.cjs | 14/14场景，47/47实际 assert 调用 |
| runtime-history-search.cjs | 35/35 |
| review-regressions.cjs | 32/32 |
| session-search.cjs | 72/72 |
| pi-compat.cjs | 57/57 |
| runtime-http.cjs | 12/12 |
| runtime-conversation.cjs | 78/78 |
| runtime-draft.cjs | 42/42 |
| runtime-models.cjs（main 原合同） | 51/51 |
| runtime-finish-ui.cjs（main 原合同） | 27/27 |
| session-background.cjs | 5/5 |
| server-security.cjs | 39/39 |
| runtime-registry.cjs | 35/35 |

新两套合计43场景、173条实际断言；原12套485项报告检查均保留。不能把场景计数与各旧套件检查计数混称同一层断言总数。
另 `node tests/smoke.cjs` 1338/1338、`node tests/modules.cjs` 120/120；均exit0。
package.json 注册后运行 `npm run test:ci`，8叶全完成exit0（[完整输出](assets/z5-3/ci-tests.txt)）：
ci-test-plan覆盖224叶/5组；workflow两组5/5和15/15；results10/10、summary30/30、history21、doc-scope28/28、release-proof16/16、nsis-bootstrap12/12。
这些是 CI 调度器自身回归，不是完整 canonical 执行。

## 6. UI 与正常沙箱 Electron

PR #38 未合并，**没有修改 runtime-conversation.js 或任何 public 文件**。当前 UI 仍是原正文历史，新增摘要尚不显示；没有声称 Z5-3 用户可见功能全部完成。
新摘要的 A/B/迟到/恢复/只读展示/缺失原因等前端专项、Z5-2 新思考合同回归与摘要真实截图均未运行，须等后续安全同步已合并 main 后补齐，不复用 #38 未合并实现。

- `G2_SMOKE_OUTPUT=<TEMP>/pi-gui-z53-evidence/electron-smoke node tests/electron-smoke.cjs`：10/10，exit0，正常沙箱/contextIsolation，无 Node 集成，TEMP Git + fake Pi，生产 server/renderer/preload；renderer errors=[]；观察11个进程身份，残留0。[报告](assets/z5-3/electron-smoke/results.json)、[1200px截图](assets/z5-3/electron-smoke/smoke-1200.png)、[760px截图](assets/z5-3/electron-smoke/smoke-760.png)。
- `Z51_OUTPUT=<TEMP>/pi-gui-z53-evidence/z5-1-regression node tests/z5-runtime-input-electron.cjs`：15/15，exit0，正常沙箱装配页，Chromium152.0.7977.130；IME事件/229、A/B草稿、刷新、容量提示保留。[报告](assets/z5-3/z5-1-regression/results.json)、[截图](assets/z5-3/z5-1-regression/z5-1-runtime-input-wide-1200.png)。这是合成输入事件，不是实体输入法资格。
- 本机 Electron44.4.3，默认基础 smoke 为生产窗口；Z5-1 为已有装配夹具。两者均是回归，不能当摘要 UI、打包完整窗口或 Z5-2 新合同的验证。

## 7. 离线构建与产物

本 Worktree `npm ci --offline --ignore-scripts --no-audit --no-fund` 恢复93个锁定包；没有下载、升级依赖或修改 lockfile。
Electron44.4.3从本机既有缓存 ZIP 解压到本 Worktree node_modules；通过已有 PI_GUI_ELECTRON_ZIP_DIR 显式离线打包。
最终生产修改后执行 `npm run build:app -- --rebuild`（包含SEA构建）exit0；首次构建后因畸形结果修复重新构建，不把旧产物作最终证据。

- `npm run fixtures` exit0；`node tests/app-check.cjs` **26/26**，`node tests/exe-check.cjs` **49/49**，均exit0，使用 TEMP/fake Pi。
- `Z53_PACKAGED_OUTPUT=... node tests/history-tool-summary-packaged.cjs` / `npm run test:history-summary:packaged`：**16/16**，exit0。
  分别启动实际 App 可执行文件的后端模式与 SEA，原生 TEMP manifest/文件证明，验证200摘要、401鉴权、正文身份、脱敏、liveCount=0、fake Pi 启动标记未生成、文件 digest 不变、后端进程退出。
  [结果](assets/z5-3/packaged-results.json)：App/SEA 各606字节响应，其中摘要184字节。这是打包后端证明，不是打包 UI 摘要证明。
- App 与 SEA 的 server.cjs SHA256 相同：`63656dfd754bac0c27014c3826006cf2ddddd710341206371716ac7b3ccd2197`。
  [完整字节数、源码/产物摘要](assets/z5-3/build-digests.json)。SEA `033d41ff447c5c6a8259392408b94fe2f93050b30d31e8dc7894dd5dd32d395b`。
- 构建日志出现 SEA 注入时的签名警告，不代表已取得代码签名或安装升级资格。本轮未执行安装/更新。

## 8. 自审、剩余风险与回滚

作者检查完整 diff、调用边界和用户18项测试目标：后端目标已覆盖；依赖 #38 的新前端目标按约定暂缓。未发现可证实的剩余 Blocker/Important；这只是作者自审。
风险按高等级数据投影边界处理，未扩大权限。依本轮唯一 Agent 要求，独立功能/安全复审**未运行**；本报告不宣称通过仓库完整验收或允许合并。

- 完整本地 `npm test` **未运行**，按用户要求留待未来 PR 的 canonical CI，当前**待验证**。224叶仅计划校验；本轮无新 PR，因此没有 Z5-3 PR CI。
- UI/前端隔离与摘要真实窗口未集成；Z5-2 新合同未引入。未验证 POSIX、真 Pi/外部模型、旧格式全量资格、实体输入法、安装升级及长期稳定性。
- 原生JSONL非签名审计账本；可信表示通过本地身份/形状/关联证明的记录，不是防本地恶意修改的执行证明。自定义工具真实名称被隐藏；部分可合法关联的重复/旧记录仍会保守 unknown。这些限制不影响原正文。
- 回滚：在本分支逆序回退最终文档证据提交、测试提交2745f60、行为提交08069d1及审计提交94a458b，或在将来集成时只撤回对应业务/测试/文档改动；不要 reset main 或删除其他 Worktree。回退生产改动后重建 App/SEA。无用户数据迁移或原生记录写回。
- 开发完成：后端阶段是，UI阶段暂缓；代码验收通过：待独立审查与canonical；允许推送/PR/合并/tag/发布：本轮均无授权且未执行。保留本 Worktree 和分支供用户独立验收。
