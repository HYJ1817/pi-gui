# G4 下一正式版本发布前审查与验收材料

日期：2026-10-24（Asia/Shanghai）。**第 1～15 节保留首轮只读审查；后续用户已批准 v0.29.0 并要求发布。当前执行状态和最终证据见第 16 节，不能将首轮授权状态误读为当前状态。**

## 1. 授权、工作区与精确身份

本轮允许只读 GitHub/源码核对、离线 TEMP fixture 定向验证和报告，不允许自行定版、推送、PR、合并、tag、draft、publish dry-run、正式发布或修改保护。
按用户第三节，版本获批后才创建唯一的 `codex/g4-release-prep` 独立版本准备 Worktree/分支。
当前没有创建 G4 版本分支；本报告暂存于本地 artifact 的 `docs/G4-acceptance.md`，获批后迁入该 Worktree，继续维护同一份报告，不另建 CHANGELOG。
仅一个 Coding Agent，无子 Agent。本轮没有提交或修改现有源码、版本文件或正式摘要，没有操作用户安装或真实项目数据。

- 最新 main：`efa6933963fde0552c6830099abff4c4dcfe13ef`，执行前重新 fetch。
- main CI：[40080538058](https://github.com/HYJ1817/pi-gui/actions/runs/40080538058)，event=push、branch=main、attempt=1、completed/success，8 job 全部成功。
- 本轮使用既有独立 G3 checkout 只读源码并运行 TEMP fixture：HEAD `8946ce4a9ab011ead8b223bf5bc12e8dae516088`。
  它与上述 main 的 tracked diff 为空，两者 tree 均为 `27f8afe725473d583e63c46d8c35855ac79952a6`；不将 G3 的旧 CI 当作本轮 main CI。
- 当前公开 Release：[v0.28.0](https://github.com/HYJ1817/pi-gui/releases/tag/v0.28.0)，非 draft、非 prerelease，发布于 2026-10-23 09:12:43 UTC。
- `v0.28.0` 为 annotated tag：tag object `74de49217a587c0867eb21e01a5aef7416e46950`，实际 commit 为 `f542aece54a06eef1cc2d13bf4b93531a47b3997`。
  diff 以 peeled commit 为基线，不将 tag object 或 Release 的 targetCommitish=main 当成发布源码 SHA。
- 候选版本尚未准备，故没有新版本 after HEAD/PR SHA/发布 tag；本报告的证据绑定上述 main 和同 tree 的 checkout。

必读材料已核对：AGENTS、REVIEW、docs 导航、releasing/testing/acceptance、G3 报告、两个发布 workflow、正式摘要、release-check、产物守卫、精确 SHA 证明器和 publish 编排；另读 T4-C 安全合同、生产接线、更新与安装边界。
Jev 将任务归为高风险测试/审查；仅作路由，不改变仓库和用户授权。

## 2. v0.28.0 至当前 main 的实际变更

实际范围：25 个提交（18 个非 merge）、87 个文件。复现：

```powershell
git log --oneline v0.28.0..origin/main
git diff --name-status v0.28.0..origin/main
```

| 类别 | 当前候选内容及主要位置 |
| --- | --- |
| 用户新能力 | `lib/candidate-adoption.js`、`server/candidate-apply.js`、`candidate-transactions.js`、`candidate-writer.js`、`candidate-write-native.ps1`：可信候选预检、明确确认后采纳、事务记录及单独授权恢复 |
| 用户界面 | `public/candidate-review.js`：采纳范围、确认及事务/恢复状态；不是新一轮会话或主题重构 |
| 明确 Bug 修复 | `0232aa18172e20226a7a6f11dc1307d0b4f79b3f` 修复恢复确认在取得事务前失败时访问空 tx.id，保留原始存储错误；新增恢复错误回归 |
| 安全/可靠性 | 来源与候选对象/完整内容复核、冲突拒绝、单次确认、busy/admission、Windows NTFS 句柄约束、逐步持久记录；新增故障/强杀验证，保持未知状态拒绝覆盖 |
| 工程交付 | G0-B 代码/验收规范，G1 PR 模板/EditorConfig/软行数报告，G2 增量 CI 证据/完整性/性能基线/离线 smoke，G3 独立打包并行/文档候选分类及未启用的保护草案 |
| 构建资源 | App 和 SEA 新增 `candidate/write.ps1` 资源，需在新版本构建中重新核对，不能给旧包改名 |

Specs、分屏工作台、Diff 单行/区间评论、修改任务预览与 T4-B 候选执行已在 v0.28.0 摘要中，不应作为本版新增重列。
G0-A 已属于发布基线；本次新增的治理差异从 G0-B 起。`public/review-task-preview.js` 的另一处变化仅是等价换行，不包装成用户 Bug 修复。
`electron/`、更新检查/安装 helper、NSIS、会话/项目格式和 package-lock 相对 v0.28.0 无变更；未发现本范围的依赖升级或外部 Pi 协议变更。

## 3. 版本建议及批准状态

**建议 v0.29.0，批准状态：未批准。**
相对 0.28.0 出现用户可感知的受控采纳与恢复能力，使用 minor 增量比将其称作纯补丁更清楚。
仓库要求完整三段稳定版本，正式发布拒绝 prerelease；版本比较复用现有 SemVer 实现。
仓库没有另外规定 0.x 的正式兼容性承诺；因此这是基于新增能力的版本建议，不声称自动满足 1.x 稳定 API 保证。
执行 `git ls-remote --tags origin refs/tags/v0.29.0` 时未见现有该 tag；这仅说明当时名称未占用，不是定版授权。

若 T4-C 不能完成发布资格复核，不应仅靠“实验性”措辞把实际默认暴露的写入能力视为可发布。
应保留发布阻断，由用户决定补齐验收或另定范围；本轮未修改功能开关、回退产品代码或擅自改推荐版本。

## 4. Release Notes 草案

以下为未发布草案，仅在 T4-C 发布资格通过、版本获得批准后，才可写入唯一的 `.github/release-summary.md`。
当前正式文件的 `0.28.0` marker 和正文均原样保留；此处不创建正式版本 marker。

- **候选修改采纳（实验性）**：在 Windows 本地 NTFS 环境下，可先查看候选修改范围，再经明确确认写回来源工作区；不会自动提交或合并 Git。
- **冲突检查**：来源或候选内容、文件身份发生变化，或检查材料不足时，拒绝采纳并保留候选结果供检查。
- **失败恢复（受限）**：增加采纳事务记录及另行确认的恢复入口；遇到未知写入、外部改动或遗留锁时停止自动操作并保留材料，不保证多文件原子性或断电恢复。
- **候选恢复稳定性**：修复恢复确认早期失败时的异常处理，保留原始错误及可核查的事务状态。
- **交付可靠性**：改进测试结果持久保存与完整性校验，让独立打包与测试并行，补充离线桌面回归；不承诺固定的提速比例。

保留“本版摘要 → GitHub 自动 notes/Full Changelog → 固定交付物和前置条件”的现有结构。
不重复内部阶段编号，不声称无条件安全、全平台支持、完整生产恢复资格或已签名；仍需本机已有 pi 和模型配置，候选 Worktree 不是 OS 沙箱。

## 5. 版本一致性与构建输入

本轮 `npm run version:check` 退出 0：package、lock 顶层、lock 根包、摘要 marker 均为 **0.28.0**。
这证明当前基线内部一致，不是新版本准备已完成。
现有静态扫描器检查 0.26.2、0.27.0、0.28.0 及候选 0.29.0，在其规定的构建/发布目录中均未发现匹配的硬编码应用版本。
构建中的 App metadata、SEA define、NSIS `/DVERSION=`、正式资产文件名均从 package 版本派生。
宿主及 workflow Node 为 24.22.1；产品 engines 仍为 `>=22.19`。没有更新依赖、锁文件或外部 pi。

批准版本后仅按 [releasing.md](https://github.com/HYJ1817/pi-gui/blob/efa6933963fde0552c6830099abff4c4dcfe13ef/docs/releasing.md) 执行：
从重新 fetch 的最新 main 建唯一 G4 Worktree/分支，`npm run version:set -- <批准版本>` 同步 package/lock，
编辑唯一摘要及其 marker，再运行 `npm run version:check`。set-version 本身不改摘要，不为此另造版本脚本或手改多个 JSON 源。

## 6. T4-C 安全资格与受限能力

当前后端和 UI 已接通采纳动作，不是只有文档设想。后端以 run ID/当前 authority 解出目标，客户端不能指定任意目标或 force 参数；
预检和 120 秒单次 nonce 绑定来源/候选及会话身份，确认后再次复核。只改变 working tree，逻辑 index 不变；普通 GUI 查询可能刷新 index stat 缓存。
Windows 本地 NTFS、普通有界文件、已有父目录是当前允许范围；不接受链接/多链接、特殊模式或网络文件系统。
未知 intent、部分写入、遗留锁、损坏材料、外部新改动或再次恢复失败均需保留材料并拒绝自动覆盖；不自动按 PID 清锁。

| 证据层 | 已有事实与本轮范围 |
| --- | --- |
| 当前源码及 canonical | main 197/197 命令成功；本轮 TEMP store 14/14、恢复错误 3/3，无真实用户写操作 |
| 当前正常沙箱源码 Electron | 本轮在上述 main 同 tree 上实跑采纳模式 49/49，退出 0，sandbox=true、failed=0、skip=0；真实写入与 index 保持、冲突拒绝、事务重启和 nonce 消耗均通过，全部目标为 TEMP Git fixture |
| 历史真实 Windows/Electron | T4-C 文档对应 e8ac4bb/18a995a 范围记有 49/49、默认 25/25、强杀 40/40 与重启检查 15 条；属于历史证据，不冒充 G4 新运行 |
| 历史打包专项 | 文档记有 App/SEA/打包候选检查；本轮只复核当前 main 的 App/SEA CI，不称为新版本安装验证 |
| 未证明的资格 | 现有 T4-C 验收材料仍标“作者自验、待独立功能/安全验收”；PR #24 已合并，但 GitHub reviews/comments 均为空，未找到替代该缺口的独立验收记录 |

**发布阻断：必须补齐/取得可复核的 T4-C 独立功能与安全发布决策。** 合并授权不自动等于发布许可，作者补测和实验性标签不能代替这一决定。
任意原生系统调用内部中断、断电、已安装主入口完整强杀、所有真实用户场景和跨平台资格仍不在本轮证明范围。

P33 与 T4-C 是不同路径。`openOriginalAttempt`、生产 object service/profile 仍返回 `production_allowlist_empty`；
不得启用测试导出、环境开关或放宽 allowlist。当前测试成功不提升 P33 完整生产撤销/恢复资格。

本次 Electron 44.4.3 使用已存在的同摘要离线私有目录 `%TEMP%\pi-gui-g2-electron-44.4.3`，
electron.exe SHA256 再核为 `BF0FE749904CA9F713CCFB2427C519FA39D0BBD0337BA411BA08785802E8D548`；
仅命令局部设置 ELECTRON_OVERRIDE_DIST_PATH、T4C_APPLY_ADOPTION=1 与指向 TEMP 的 T4B_EVIDENCE_DIR，未改共享安装、未下载或关闭沙箱。
本轮 [结果 JSON](evidence/g4/candidate-electron.json) 与 [确认前预检](evidence/g4/t4c-source-apply-preflight.png)、
[采纳成功](evidence/g4/t4c-applied.png)、[来源冲突拒绝](evidence/g4/t4c-source-conflict.png) 已保留；采纳成功截图已目视检查。
全套 11 张本次截图在 `%TEMP%\pi-gui-g4-candidate-electron-4875daef0ebb444d9a56035d8bc6d6fc`，没有拿历史图冒充新验证。

## 7. 数据与降级兼容

版本差异没有修改项目/历史会话、设置、日志、更新模块的既有 schema 或存储路径，也没有发现批量迁移入口。
T4-C 沿用候选 v1，新增可选 adoptionEvidence；旧历史缺证据仍可查看但不能采纳，损坏可选扩展不隐藏合法旧历史。
新事务独立保存于应用 dataDir 的 candidate-transactions，不改写旧候选结果；启动读取/列示不自动继续写来源文件。
本轮 store 14 项覆盖旧历史/可选扩展/损坏/锁/链接及目录身份；恢复错误 3 项核对失败前文件、index、证据不变。
这些是 TEMP fixture 证明，不能宣称真实旧用户目录、真实原位置升级已经实测通过。

备份/回滚准备：在隔离副本中保存项目列表、设置、会话/评论/候选记录、完整 candidate-transactions、来源工作区及相关 Git 状态；
恢复材料和候选目录不得删除或只备份一半。确认所有任务停止且无未决事务后再考虑程序降级。
降级应用不撤销已经采纳的源码修改，旧版也可能不理解新事务，不能承诺无条件双向数据兼容。
当前没有迁移执行，不触碰用户真实数据或正在运行的安装。

## 8. 安装、便携和更新边界

NSIS 为 RequestExecutionLevel user，默认安装到 `%LOCALAPPDATA%\Programs\Pi GUI`，HKCU 卸载记录；
卸载针对程序目录/快捷方式/安装注册信息，不删除 `%APPDATA%\Pi GUI` 用户数据。
应用内更新用精确官方仓库/版本/文件名/大小/摘要校验，区分安装版/便携版/开发模式，并拒绝忙碌会话；本轮测试使用假响应和注入 launch，不执行真实 EXE。

既有风险（Pre-existing，v0.28.0 至 main 无差异）：`installer/pi-gui.nsi` 的交互安装经确认后，以及卸载函数，仍存在按映像名 taskkill /F /T 的路径；
静默安装遇到已运行实例则退出 20。应用内更新自己的 drain/prepare 不能等同于手工卸载也具备同等活跃任务保护。
这是可定位的既有边界，不声称本轮新引入漏洞；真实旧版原位置覆盖升级和忙碌实例场景仍须在一次性 Windows 环境验证，由用户知情决定。
本轮不运行安装/卸载，也不停止任何用户实例或修改该历史行为。

## 9. 当前 main CI 与未来版本证明

本轮下载 main run 40080538058 的五组 artifact 和 summary，并按实际当前 canonical 重新调用汇总器，退出 0：
可复核的 [本轮下载 summary](evidence/g4/main-ci-summary.json) 保存于报告旁；原五组结果保留本机 TEMP，不含 stdout 或用户正文。

| 检查 | 本轮核实结果 |
| --- | --- |
| 身份 | SHA efa6933963fde0552c6830099abff4c4dcfe13ef / push / main / ci.yml / attempt 1 |
| canonical | core 121、ui 24、security 27、native 4、faults 21，合计 197/197 |
| 结构化完整性 | allPassed=true、dataComplete=true、unfinished=false；命令级 failed/cancelled/interrupted/skipped/pending/running/unexecuted 均 0 |
| 打包 | Electron build check 成功；原始 job 日志实际 App 26/26、SEA 49/49 |
| 最终门 | 唯一 CI gate completed/success，完整证据汇总及所有上游 success 检查均成功 |

命令数量不是断言总数；不能据此声称每个平台条件断言均没有 skip，尤其不能提升 P33/SACL 资格。
本轮没有为未批准的新版本创建 tag，因此没有运行正式 tag/checkout 证明。16 项证明器回归使用注入 API，不伪造真实 tag 通过。

未来版本准备 PR 必须获得自己的完整 PR CI；合并后还必须取得版本合并提交的**精确 main push SHA** 成功证明及 G2 完整 artifact。
当前 main 或 PR #27 的成功只能证明各自状态，不能替代未来修改版本/摘要后的状态。
按正式流程，Release 会在构建前、draft 前和发布前重新验证 tag/checkout/event SHA 与 main push CI/gate。

## 10. 本轮定向验证

| 命令/场景 | 实际结果及限制 |
| --- | --- |
| `npm run version:check` | 退出 0，四处现有标识 0.28.0 一致；未改版本 |
| `npm run test:version` | 退出 0，34/34；setVersion 仅操作 TEMP fixture，不是版本准备操作 |
| `npm run test:release` | 退出 0，77/77；资产和发布编排均为 TEMP/假 gh，不是真发布或有副作用的 publish dry-run |
| `node tests/release-ci-proof.cjs` | 退出 0，16/16；覆盖旧/错 SHA、错 event/branch/workflow、未完成、失败、重复/缺失 gate 和 API 错误 |
| `npm run test:update` | 退出 0，87/87；假 fetch，不访问真实更新 API |
| `npm run test:app-update` | 退出 0，4 套件，共 24/24（15+2+6+1），失败/取消/skip 均 0；下载、launch 和安装均被注入替代 |
| `node tests/candidate-store.cjs` | 退出 0，14/14 |
| `node tests/candidate-recovery-errors.cjs` | 退出 0，3/3，失败 0、skip 0 |
| `T4C_APPLY_ADOPTION=1 node tests/candidate-electron.cjs`（命令局部环境，见第 6 节） | 退出 0，49/49、正常沙箱、失败 0、skip 0；不是已安装程序或真模型测试 |
| `node tests/ci-workflow.cjs` | 退出 0，实际 gate 15/15、打包就绪 5/5；Node pin、发布权限和精确 SHA 编排守卫通过 |
| `node scripts/run-test-group.mjs --validate` | 退出 0，197 条，五组覆盖完整 |
| 当前 main 下载证据的 `summarize-ci-results --require-complete` | 退出 0，197/197、精确身份及计划匹配 |
| 实际旧标签更新器 + 模拟 0.29.0 响应 | 退出 0，8 项兼容断言；更新可发现、三类资产识别、安装版选择正确，无公网新版本/下载/安装 |
| `git diff --check` / tracked tree 对照 | 退出 0；checkout 与 main 同 tree，工作区未修改 |

本轮尚无产品代码修复或失败后放宽断言；采集时的文件名探查、过宽历史文档检索不作为测试通过证据。
完整 npm test 未重复：准确 main 已有可信完整 CI，当前没有代码/版本变化；后续变更仍需新的 PR/main 证明。

## 11. 正式产物状态与三资产契约

**本次候选产物尚未构建，不能进入 release:verify、不能声称 MZ/ZIP/metadata/SHA256 通过。**

| 正式附件（批准版本后的派生名） | 候选 0.29.0 示例 | 当前状态 |
| --- | --- | --- |
| 安装程序 | Pi-GUI-Setup-0.29.0.exe | 未构建、未执行、未校验 |
| 便携包 | Pi-GUI-0.29.0-portable.zip | 未构建、未打开/解压/运行、未校验 |
| 校验文件 | SHA256SUMS.txt | 尚无候选二进制摘要，未生成 |

Release 只附这三个文件，SEA 仍是构建/验证中间产物；不复制旧附件改名。
现有守卫复用更新器 classifyAsset，检查白名单/命名/非空/EXE MZ/ZIP PK+EOCD/摘要覆盖/App metadata；
77 项 fixture 通过不等于未来真实资产通过。ZIP 可读性/CRC/内含内容、App/SEA 实际版本、无 fake Pi/fixture/日志/凭据/调试文件，仍需对最终已验证构建实际检查。

旧 v0.28.0 仅作发布契约参照：API 看到恰好三个 uploaded 资产，Setup 105507849 字节、portable 149048571 字节、SHA256SUMS 183 字节。
本轮只下载旧校验文件，其实际 SHA256 为 `e8748b63cd836790b36b4f67cf381f45f7b73438cff00f2792af0cd9afbd75ca`，与 API digest 一致。
文件内 portable 摘要 `571d733e2b058e8f8806ae08b83f94bb5c5ca7895268611cd40ca36acd2c80ff`、
Setup 摘要 `ffa778ab55d476350af20a209d14362db65d0554da3a91f388760fd906c71602` 与对应 API digest 一致。
没有下载/复算这两个旧二进制，不把旧资产元数据或校验文件核对冒充新版本资产验证。

## 12. 旧版升级与缺失验证

已实际完成旧 tag 更新器的离线模拟发现/分类；更新代码、Electron 更新器及 NSIS 相对 v0.28.0 未改。
仍未验证真实 v0.28.0 安装到新版本的原位置升级、用户数据保留、活跃任务处置、重启后历史数据及卸载恢复；
一次性 runner 新装/卸载通过也不能自动等同于上述覆盖升级资格。
没有操作真实用户安装，未联网调用模型或更改全局 npm/pi。

## 13. 发布流程、未执行项与成本

唯一步骤来源仍为 docs/releasing.md；本报告不创建平行发布系统。
授权后路径为：批准版本 → 唯一 Worktree 本地 version:set/摘要/定向检查 → 经授权推送一个版本准备 PR → PR 完整 CI/审查 →
获准合并 → 等待版本 main 精确 SHA 完整 push CI/G2 证据 → 单独 tag/正式发布授权 → 推 v* tag 自动触发 release.yml →
只读 verify job 构建及 disposable runner 安装/卸载/portable/metadata/校验 → 跨 job 再验资产 → 写权限 publish job 在证明通过后 draft/上传/复核/发布。

未运行 release:check、release:prepare、release:collect、真实 release:verify、build:installer、test:installer 或 publish CLI（包括 dry-run）。
未触发 release-check.yml：它重复 npm test、App/SEA，installer job 还会再次构建；正式 tag 流程已包含同类发布验证。
如果需要在正式发布授权前先取得安装/覆盖升级证据，应另行批准一次隔离 runner/VM 验证，并说明重复构建的价值；本轮不擅自触发。
未创建远端 draft、tag、PR 或版本分支，未使用个人 PAT 绕过权限，未改 Release 或保护设置。

## 14. 发现、限制与回滚

本轮未发现可复现的新增代码 Blocker；发布就绪判断不是“没有代码 Bug 就可以发”。

| 编号 | 类型/处置 | 当前结论 |
| --- | --- | --- |
| R1 | 版本及范围授权前置条件 | v0.29.0 未批准，不能改版本或正式摘要 marker |
| R2 | 发布阻断 / Important：高风险资格证据缺口 | T4-C 独立功能/安全验收与发布决策缺失；默认可见写入不能仅靠实验性文字放行 |
| R3 | 发布阻断：最终提交及真实资产未验证 | 新版本 PR、合并后精确 main CI、安装/portable/metadata/SHA256/上传后独立核对尚未产生 |
| R4 | Pre-existing Important / 用户决定 | 手工交互安装/卸载的映像名强杀路径、旧版原位置覆盖升级及真实用户数据验证缺口；本轮不改历史行为 |
| R5 | 持续受限能力 | P33 生产 allowlist 空；非 Windows 本地 NTFS、任意中断/断电、多文件原子性及全平台资格未提供 |

独立功能/安全审查尚未执行；一个 Coding Agent 的自查不能替代，历史报告中的作者结论不能作本轮独立验收。
代码发现计数：新增已确认 Blocker 0；发布 Important 证据项 1（R2）；另列 Pre-existing Important 1（R4）。R1/R3 为尚未完成的发布条件，不伪称产品漏洞。

当前没有产品/版本改动可回滚，丢弃本报告不影响仓库。后续版本准备回滚仅 revert 自己的版本/摘要及报告提交，保留其他主线工作；
在未发布前不要推 tag。若未来已发布错误，不覆盖已公开附件或重打 tag，应停用该次发布推进、保留构建/摘要证据并由用户决定修正版。
程序降级不撤销已写源码，先停工作并保存数据/事务/源码备份；未决事务不得自动删锁或由旧程序猜测恢复。
不执行 reset --hard、clean、删除其他 Worktree 或接触用户安装。

## 15. 结论与下一步批准项

本轮授权范围内的发布前审查、版本建议和草案已具备；**尚未达到正式发布条件（NO-GO）**。
当前成功 main CI 不等于下一正式版本已具备全部资格，特别是不能替代 R2/R3。

下一步首先由用户明确批准或更改建议版本 v0.29.0；批准后才创建唯一 G4 版本准备 Worktree/分支，
将本报告迁入仓库 docs/G4-acceptance.md，使用既有脚本本地改版并写摘要，继续验证而不自动推送。
还需用户安排/提供 T4-C 独立验收证据，并决定 R4 的隔离升级验收及可接受限制。
推送/创建 PR、合并、隔离高成本验证、tag/正式发布、保护启用均保留各自独立授权；本轮到此停止，等待验收。

## 16. 用户批准后的版本准备与正式发布执行

用户在收到上述版本建议、49/49 Electron 与发布缺口说明后回复“可以，发吧”。本轮据此批准版本 **v0.29.0**，
并授权为该版本完成版本分支推送/一个准备 PR/合并、精确 main CI、发布 tag 及正式 Release 流程。
未授权或执行保护规则修改、历史附件覆盖、个人 PAT 绕过或用户本机安装/卸载。

独立功能/安全审查与旧版原位置覆盖升级仍未执行，不能写成验收通过。用户发布决策记录为允许在已明示范围内交付受限实验能力，
不提升 T4-C 的独立安全资格、P33 allowlist 或断电/多文件原子性保证；正式摘要明确保留这些缺口。
R2 的“未取得用户发布决策”已由本次批准处置，独立审查证据缺口仍作为限制保留；R4 也仍为既有、已告知的升级边界。

新建唯一 G4 Worktree：`C:\Users\21022\.codex\worktrees\g4-release-prep\pi-GUI`，分支 `codex/g4-release-prep`，
从重新核对的 `efa6933963fde0552c6830099abff4c4dcfe13ef` 创建。首轮报告和本次截图/结构化证据迁入本仓库，未修改其他 Worktree。
使用 `npm run version:set -- 0.29.0` 同步 package/lock，再更新唯一正式摘要为 6 条及 0.29.0 marker；不改变产品、依赖、Release workflow。

本节执行中：准备提交、PR CI、合并后的精确 main CI、正式 tag/Release、真实三个附件和安装/portable 结果分别在完成后记录。
未取得的证据仍是未验证，不能使用初始 main 的成功替代新版本提交。

批准后的本地版本树验证：version:check 退出 0（package/lock 两处/摘要均 0.29.0）；
test:version 34/34、test:release 77/77、test:ci 的 8 套件均退出 0（持久化 10、汇总 30、历史 21、分类 28、实际 gate 15、调度 5、发布证明 16、NSIS 12）。
canonical 仍为 197，五组 121/24/27/4/21；git diff --check 退出 0；JSON 逐字段对照确认仅三个应用版本字段改变，依赖与 lock 条目完全一致。
本地日志位于 `%TEMP%\pi-gui-g4-prep-tests-21ec85023e3445088ecfc55a13424cbe`；未运行真实安装或 publish dry-run。
版本/正式摘要提交：`4fe96afd53e3580bf7af73336fc2cd5dc36321a0`；随后报告/证据提交可用 `git log -1 --format=%H -- docs/G4-acceptance.md` 定位。
