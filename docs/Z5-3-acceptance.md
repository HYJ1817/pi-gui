# Z5-3 历史工具摘要：后端阶段验收

日期：2026-10-27（Asia/Shanghai）。单一执行 Agent，无子 Agent。结论：**来源审计 GO，后端与定向验证完成；PR #38 未合并，按约定停在后端，UI 未集成。** 待用户独立验收，不进入下一阶段。

以上及第1～8节记录首轮 `ade68c1` 交付时的状态。**位置合同修复见第9节；创建PR后的主线集成与最新验证以第10节为准**。原证据保留，不把旧 SHA 的结果当作新行为验证。

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

## 9. 位置关联 Important 反馈处置（2026-10-27）

**结论：已验证并局部修复。** 用户转交反馈指出每项只有工具名/状态/source，无法为未来按消息附近展示工具提供位置。旧生产代码跑新增回归失败：两条调用预期位置 `[2,2]`，实际 `[undefined,undefined]`。原需求确实允许“正文后紧凑只读区”，因此末尾布局本身不构成违约；本次修复的是安全位置合同能力，不改 UI 布局。

### 身份与范围

- 修复基线 / 已推送分支 HEAD：`ade68c1a64fe2fb6f6bef77147946e83bfda7b15`，本轮开始工作区干净。
- 行为提交：`fbdd1443b5e09e910478837367696fabffb3c43a`；测试提交：`c01c05635965b7e7d9ed2bbc2d5de3fcf4ce0b03`；最终交付为包含本节的文档/证据提交，可通过本报告 git log 查询。
- fetch 核对最新 main 为 `300717f6b59a106d1dd01910d82d3096cdb0a182`；PR #38 已由外部于2026-10-27 11:01:06（上海）合并，head 当时为 `ccd6484b409dd98e144d013c2f6abc27109fef33`。这是首轮之后的新状态，本次没有合并动作、未将其未审阅改动混入位置修复。
- 在原 Worktree 单 Agent 顺序修改，仅两个生产文件及对应测试；未调用子 Agent、未写其他 Worktree、未改 public/。后端读取、权限、状态配对及容量预算不扩展。Jev category=backend(0.41)、risk=medium(0.3)，低置信分类不替代实际边界核对。

### 新合同

每项新增 `messagePosition: integer | null`。整数是**当前响应** `messages[]` 的插入边界：0表示首条正文之前，N表示 messages[N] 之前，等于 messages.length 表示末尾；同位置保持原工具顺序。无正文调用仍有物理插入位置，同条 assistant 内的 text 不拆开，所有工具在该条聚合正文后。

正文读取循环只另记私有数字行位置；同一 fd/同一 text 窗口产生正文与摘要，无额外读盘。对实际返回的最后800条正文重算位置；已被裁掉正文范围内的工具返回 null，不附着于第一个新轮次。100条摘要上限不改变位置含义；4096行摘要窗口不重置正文序号。位置不表示父子/分支归属，状态配对仍执行原 ID/名称/顺序/父链证明。

不输出原生调用 ID、原始文件行号或任何新增路径/参数/输出；仅本响应内有效，不作为跨请求/跨会话身份。原正文的顺序、messageId、userIndex 及搜索定位不变；原消费者可忽略新字段。完整说明见 [来源与合同](Z5-3-source-audit.md)。

### 本轮验证（均 exit0，skip0）

[15套定向结果](assets/z5-3/position/targeted-results.json)，验证生产字节对应 fbdd144，后续仅测试和文档：

| 套件 | 当前结果 | 与首轮比较 |
| --- | ---: | --- |
| history-tool-summary | 36/36场景，161/161实际断言 | 原29场景/126断言保留，新增7场景/35断言 |
| history-tool-summary-http | 14/14场景，49/49实际断言 | 原47断言保留，新增2条响应位置断言 |
| runtime-history-search | 37/37 | 原35保留，新增2条真实搜索定位/正文不增行检查 |
| review-regressions / session-search / pi-compat / runtime-http | 32/32、72/72、57/57、12/12 | 保留 |
| runtime-conversation / runtime-draft / runtime-models / runtime-finish-ui | 78/78、42/42、51/51、27/27 | 当前分支原合同，非合并后Z5-2新合同验证 |
| session-background / server-security / runtime-registry / modules | 5/5、39/39、35/35、120/120 | 保留 |

新增场景覆盖同条多工具及顺序、工具/思考无正文、800正文与100摘要双重截断、旧正文已丢失、跨分支重复 ID、4096行窗口、字节窗口，真实搜索命中继续使用原messageId/userIndex。未删除旧断言；原三字段精确白名单断言扩大为四字段。

[容量实测](assets/z5-3/position/projection-results.json)：100项未知工具及三位正文位置的摘要9,324字节，仍小于12 KiB；5,243,551字节文件实际读4,194,304字节，单次本机样本4.178ms。无为补位置扫描全文件。

最终生产修改后离线 `npm run build:app -- --rebuild` exit0（包含SEA），使用原同版本本机Electron ZIP；`npm run fixtures` exit0；App检查26/26、SEA检查49/49。
打包后端专项由16增加到 **18/18**，新增App/SEA各一条位置断言；[结果](assets/z5-3/position/packaged-results.json)中 messagePosition=1，对应同一响应的一条正文，liveCount=0、Pi启动数0、原生文件字节不变。产物摘要与字节数见 [build-digests](assets/z5-3/position/build-digests.json)。
正常沙箱生产窗口 smoke **10/10**、renderer errors=[]、残留进程0，[报告及同目录截图](assets/z5-3/position/electron-smoke/results.json)。没有摘要 UI 改动，不把基础 smoke 当成新布局证明。

### 验收边界与回滚

本次只有后端位置反馈修复。PR #38 合并后主线同步、摘要 UI、前端新位置消费与新合同集成均未在本修复中执行；原Owner/token迟到保护继续由既有回归验证。完整 canonical 依原约定留待未来PR CI，当前仍待验证；未重新执行完整npm test，不拿旧smoke1338/1338当本次新行为证明。用户提供的反馈不等于已完成全部独立功能/安全审查。

本地分阶段提交后保持干净工作区；本次未自动追加推送、创建PR、合并、tag或发布。先前“推送”已针对 ade68c1 完成，不用于推定新修复的远端授权。
回滚本节文档证据提交、c01c056与fbdd144，重建App/SEA即可回到已推送的ade68c1；无数据迁移或会话写回。不要重置主线或其他Worktree。

## 10. PR #39 主线集成与冲突处理（2026-10-27）

用户先后明确授权推送位置修复、创建PR。已创建 [PR #39](https://github.com/HYJ1817/pi-gui/pull/39)，初始head为30c850f；GitHub报告CONFLICTING，尚无CI。只读merge-tree确认唯一冲突为package.json：Z5-2与Z5-3都追加同一行test链。为使PR能执行约定CI，在本分支同步已合并main；未合并GitHub PR、未改主线分支。

- 集成提交：`086d2e07b354419dce1cfc4a6e8e31f244572e6c`，包含main `300717f6b59a106d1dd01910d82d3096cdb0a182`；后续只补本节与证据。
- 冲突以main的package.json为基础，仅追加Z5-3两套canonical/Runtime入口及打包专项alias，保留Z5-2思考策略全部测试。`node scripts/run-test-group.mjs --validate`为**225叶**（core149/ui24/security27/native4/faults21）；未缩减CI清单。
- public/与该main逐字节相同；集成继承Z5-2，不新增Z5-3 UI或修改其模型/思考/输入合同。后端摘要与位置仍为fbdd144实现，权限边界未扩展。
- [12套集成定向](assets/z5-3/pr-integration/targeted-results.json)，全部exit0、skip0：摘要36场景/161断言、HTTP14场景/49断言、历史搜索37/37、conversation78/78、draft42/42、models52/52、thinking-availability34/34、finish-ui34/34、ui3-model50/50、ui3-integration23/23、model-capabilities36/36、modules120/120。
- `npm run test:ci`八叶exit0，[输出](assets/z5-3/pr-integration/ci-tests.txt)。这是测试调度器回归；225叶计划校验不等于完整canonical执行。
- 合并后重新离线 `npm run build:app -- --rebuild` exit0；fixtures exit0；App26/26、SEA49/49、打包后端18/18。摘要/位置、鉴权、liveCount=0、Pi启动数0、原生文件不变均通过。[打包结果](assets/z5-3/pr-integration/packaged-results.json)、[源代码/产物摘要](assets/z5-3/pr-integration/build-digests.json)。
- 正常沙箱生产窗口smoke10/10，renderer errors=[]、残留进程0；[报告与同目录截图](assets/z5-3/pr-integration/electron-smoke/results.json)。没有新增摘要布局，不作摘要UI证明。

完整canonical仍等待本PR CI，独立功能/安全审查、摘要UI及其前端隔离专项仍待验证。当前授权含推送及建PR，不含GitHub合并、tag或发布；无数据迁移。未来回退本PR应保留main已合并的Z5-2，按PR相对main的增量撤回Z5-3并重建产物，不能用整体文件还原覆盖Z5-2。
