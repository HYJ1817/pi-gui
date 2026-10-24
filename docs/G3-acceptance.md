# G3 CI 性能优化与合并保护准备

日期：2026-10-24（Asia/Shanghai）。本地交付报告；**最终 G3 代码验收、远端性能结论与合并条件均待真实 PR CI 和独立验收**。
风险依 [REVIEW](../REVIEW.md) 为高：涉及 CI 调度及未来减测分类，不能以作者自查替代独立功能/安全审查。

## 身份、授权与执行计划

- before HEAD：`3ced819f2abd51fb73d8244f7e172e57d49b1b5d`。重新 fetch 后的最新 origin/main；
  [main CI 40074245381](https://github.com/HYJ1817/pi-gui/actions/runs/40074245381)，push / attempt 1，completed / success，8 个 job 全部成功。
- 分支：`codex/g3-ci-optimization`；独立 Worktree：`C:\Users\21022\.codex\worktrees\g3-ci-optimization\pi-GUI`。
  从 origin/main 创建并初始干净；一个 Coding Agent，无子 Agent，未进入或修改其他 Worktree。
- 调度/故障回归提交：`a9a4a59304f0a72bcb2d145f418d1c3ef5db3366`；分类器/测试注册提交：
  `21cfe3906b181aafd164c0dcc776c4f88c25ad0d`。定向验证覆盖这两个提交的文件树，执行时为 before HEAD 加工作树 diff，提交未改变被验证的字节。
  after HEAD 为随后只含文档/证据的交付提交，可用 `git log -1 --format=%H -- docs/G3-acceptance.md` 解析，交付消息固定最终完整 SHA。
- 仅本地修改、验证和提交获授权；本轮不 push、建 PR、合并、启用保护、改 tag/Release 或进入 G4。
- Jev 的低风险建议不覆盖 REVIEW 的 CI 高风险判断。现有离线依赖通过忽略的 node_modules junction 复用，未安装/新增依赖。

实施前已读取 AGENTS、REVIEW、文档导航、testing/acceptance、G2 报告与历史 JSON、当前分组/执行器/汇总器、workflow、相邻测试及 Native fixture。
最小执行计划是：核对真实耗时与隔离边界；为调度及分类先补失败回归；并行独立打包，保留重型安全矩阵；
分类器先作只读诊断、不启用减测；运行定向/集合/故障检查；记录保护建议和尚未取得的远端证明。

## 实际修改与行为

| 文件 | 范围 |
| --- | --- |
| [.github/workflows/ci.yml](../.github/workflows/ci.yml) | build-check 的 needs 从 test 改为 test-plan；其余执行步骤、原最终 gate 不变 |
| [scripts/classify-doc-pr.mjs](../scripts/classify-doc-pr.mjs) | 原生 Node/Git 只读、精确 SHA/白名单文档候选分类；始终 requiredMode=full |
| [tests/ci-doc-scope.cjs](../tests/ci-doc-scope.cjs) | TEMP Git fixture，分类/编码/类型/范围/故障/只读回归 |
| [tests/ci-workflow.cjs](../tests/ci-workflow.cjs) | 独立打包依赖、全量路径、唯一 gate 及实际 gate 故障矩阵 |
| [tests/ci-summary.cjs](../tests/ci-summary.cjs) | 增加五组各自失败、取消、跳过、缺证据的 20 种拒绝场景；保留所有原断言 |
| [package.json](../package.json) | 仅将新增分类测试加入既有 test:ci；版本 0.28.0、依赖与生命周期保持 |
| [G3-ci-baseline.json](G3-ci-baseline.json) | 已成功 main 的 8 job/5 artifact 白名单投影与计时；不含原始日志或 payload |
| [G3-main-ruleset.proposed.json](G3-main-ruleset.proposed.json) | 仅配置草案，enforcement=disabled，未提交到 GitHub |
| [evidence/g3/electron-smoke.json](evidence/g3/electron-smoke.json) | 本次正常沙箱实测结构化记录，截图另留本机 TEMP，未复制历史图冒充本次 |
| [testing.md](testing.md)、[README.md](README.md)、本报告 | 使用范围、导航和证据边界 |

没有修改产品代码、Native helper、重型测试/fixture、分组计划/端口/TEMP、G2 持久化/汇总实现、锁文件或 Release workflow。

## 性能调查：同一基线、分开口径

历史 [G2 20 run / 22 attempt](G2-ci-baseline.md) 只用于选择调查热点。当前基线为上述精确 SHA 的 main push，
不是把历史中位数当作当前回归。下载 artifact 后确认 schema v2、精确 SHA/run/attempt、196 条全部成功、完整性为 true。
下表中的叶累计时长来自结果 JSON，job 与步骤来自 Actions；两者不可互换。

| 组/检查 | 叶累计秒 | canonical 步骤秒 | job 秒 | G3 后实测 |
| --- | ---: | ---: | ---: | --- |
| core | 444.553 | 446 | 475 | 未验证 |
| ui | 107.974 | 109 | 147 | 未验证 |
| security | 1138.257 | 1139 | 1184 | 未验证 |
| native | 1012.087 | 1012 | 1051 | 未验证 |
| faults | 878.819 | 880 | 926 | 未验证 |
| Electron build check | 不适用 | 构建 30、产物验证 13、SEA 验证 10 | 98 | 未验证 |
| Validate complete test plan | 不适用 | 不适用 | 27 | 未验证 |
| CI gate | 不适用 | 不适用 | 32 | 未验证 |

同口径整体 wall 为首个可见 job 开始到最后 job 结束：1350 秒（22 分 30 秒）；runner 占用之和 3940 秒。
没有 job 可靠入队时点，queueWaitMs=null；不将依赖等待或 run createdAt 的差值冒充 runner 排队。
本样本 test group 的安装分别 5～10 秒；build 的安装 9 秒、fixture 生成 6 秒。afterMeasurement=null，真实 wall 收益和百分比均**未验证**。

慢项实测：faults 的 object-faults 634.864 秒；native 的 object-writer 424.962、object-runtime 393.492、candidate-apply 187.195 秒；
security 的 SACL witness 346.757、object-service 277.701、inplace 120.538、object-confirmation 119.742 秒。

按源码区分耗时来源：

- Native observation/write helper 每个进程执行 PowerShell Add-Type；fixture、权限观测和清理也有独立系统调用。
  G2 叶计时不能进一步精确分摊 setup/编译/执行/cleanup；这些分量明确为未验证，不凭总时长猜占比。
- object-faults 故意注入真实 Win32 写入、进程崩溃、协议故障；timeout 场景保留 60000ms 注入与 20000ms 执行预算。
  重复启动和重新打开是安全证据的一部分，没有缩短等待、减少矩阵或缓存元数据观测。
- object harness 的 fresh TEMP root、activeRoots、attempt.close/服务 dispose 和原始字节/恢复材料验证均保留。
  进程就绪/Stop 长尾的历史症状不等于确认根因，本轮没有修改 guardian 或补无目的重试。

### 实施的最低风险优化

build-check 只读同提交源码，在独立 runner、checkout、依赖安装与 fixture 后自行生成 SEA/Electron 产物；
不下载、不消费测试组 artifact，不需要另一个测试组的可变文件、端口、句柄或进程。
因此仅移除 test→build 的串行边，保留 test-plan→test、test-plan→build，及两者→CI gate。
测试组内仍完全串行，五组 max-parallel=5，Native/TEMP 仍在 C: profile 下。

可证实的变化是打包在计划成功后即可排队，不再等最慢测试结束；基线中原串行打包跨度为 98 秒。
这不是“已节省 98 秒”的证明：现在最多会有五组加一个 build 共六个可运行 job，账号 runner 并发配额/排队可能影响实际收益。
任一测试失败时，已经启动的 build 可能消耗本来可省的计算资源；本轮以成功路径延迟为目标，未自动重试或掩盖失败。
如果 PR 实测存在明显 runner 竞争、wall 退化或异常隔离问题，回退这一条 needs 即可恢复原串行行为。

### 未实施的优化

不重平衡分组：当前没有迁移后实际 runner/安全矩阵证明，五组原命令及顺序保持。
不跨测试共享 Native 进程、Add-Type 缓存、ACL/SACL fixture 或历史结果；相关身份、句柄、故障注入和审计环境会变化，缺少安全证明。
不提前并行同一组中的重型用例、不缩短故障等待、不重复跑至成功、不新增依赖或缓存系统。

## 文档 PR 轻量路径：完成分类器，生产仍全量

审计发现 Markdown 不能一概视为无行为输入：`tests/usage-quota.cjs` 实际读取 `docs/usage-quota.md` 做编码断言；
Pi probes 测试和生产探测读取外部 Pi 包的 docs 文本；fixture 中也有 Markdown。构建遍历 public、扩展与固定 Native 资源，
第三方 LICENSE 必须随包；所以不允许 README、LICENSE、fixture 或 docs/** 通配减测。

唯一候选白名单为两篇已封存的视觉说明，不含当前政策、权限契约或构建/测试输入：

1. `docs/claude-ui-redesign/UI-1-acceptance.md`
2. `docs/claude-ui-redesign/UI-5-visual-audit.md`

按精确路径查找当前 scripts/tests/lib/server/electron/.github 消费者，未发现读取这些文件的代码；
另读构建的目录遍历和固定拷贝清单核对没有隐式收录。此审计绑定本轮基线，未来新增消费者时须重新审计。

分类只接受 pull_request、两个完整 commit SHA、base 为 head 祖先、非空 diff、仅上述既有普通 100644 UTF-8 文本的 M 修改。
差异来自禁用 replace/external-diff/textconv/rename heuristics 的 Git 对象；不扫描或跟随工作区符号链接、不联网、不运行文档正文。
每篇大小需在 1～256KiB 且无 NUL。新增/删除/重命名/类型或 mode 变化、未知/混合/敏感文件、非祖先范围默认 full。
非法参数、缺失对象、Git 错误非零；CLI 仍输出 requiredMode=full。作者标签、描述、DOCS_ONLY 等变量不能决定候选范围。

只读用法：

```powershell
node scripts/classify-doc-pr.mjs --event pull_request --base <完整可信baseSHA> --head <完整可信headSHA>
node tests/ci-doc-scope.cjs
```

输出 docs-candidate 是本地诊断，**不是必要文档检查通过、不是可信 PR 身份认证、不是减测许可**。
显式 SHA 由调用者负责来源；未来接入必须从可信 GitHub PR 元数据取得并绑定当前 checkout/实际 head/base，不能由标签、任意输入或作者环境指定。
尚未证明受信任 base 版本分类代码、完整变更枚举/权限、必要文档链接和格式检查、真实纯文档 PR 及其 gate 全链路。
因此 workflow 完全不调用分类器，所有输出均 requiredMode=full；代码 PR、候选文档 PR、main push 都执行原完整测试及构建。
**当前不具备安全启用文档减测的证据**，按用户第四节允许的保守交付路径收口，而非为形式收益降低 CI。

## Gate、G2 与发布证明

CI gate 仍是单个非 matrix、always 的稳定检查名；needs 仍为 test-plan、test、build-check。
没有引入 skipped 许可、paths-ignore、continue-on-error、自动重试或第二份测试计划。
G2 原子逐叶保存、SHA/run/attempt/event/计划摘要、完整性拒绝、always artifact、Step Summary、7 天保留均未改变。
新增五组分别 failed/cancelled/skipped/missing 的 20 种证据拒绝回归；原 PowerShell gate 的 15 种输入实际执行。

Release 的精确 main SHA/push CI/gate 证明和 Node 24.22.1 固定值保持。正常沙箱 Electron smoke 源码/10 项断言、
build 的 fixtures、build:app --rebuild、test:app、test:exe 均保留，未把启动或构建当正常沙箱交互证明。

## Main 保护建议：只准备、不启用

本轮只读现场核对：branch API 的 protected=false；CLI protection 返回 404 Branch not protected；
Rulesets（含父级）和 main 有效 rules 均为空。GitHub connector 的 protection 读取返回 403，不能据此断言“没有保护”；
随后使用已有 gh 凭据取得上述 404/false 交叉证明。未执行任何设置写操作。

精确 main 的 8 个 check 名称无重复；源码所有 workflow 中 `CI gate` 只出现一次；GitHub Actions app id=15368、slug=github-actions。
建议只要求 `CI gate`，不将动态矩阵名称逐个列成 required check。

[可审阅 JSON 草案](G3-main-ruleset.proposed.json) 仅匹配 refs/heads/main：要求 PR、CI gate 来源绑定 Actions app、严格要求最新 base、
禁止 force push/删除；required approvals=0，不要求 CODEOWNERS、最后推送他人批准、签名、线性历史或 merge queue。
没有 bypass actors，不给机器人自动合并/发版许可；单人开发仍可自行打开 PR、查看证据后合并。

GitHub 规则按 commit SHA 核对 checks；strict 要求最新 base，app 来源减少其他集成同名检查冒充。
G2 的 run/attempt/计划绑定进一步限制不同运行的 artifact 混用；人的最终核对还须确认 PR 当前 head/base、真实 CI event/URL。
原生 Ruleset 不按 PR 编号绑定同一 SHA 上的 check，不能声称仅靠该 JSON 就排除“另一个 PR 恰好同 SHA”的结果。
合并操作前应读取 `gh api repos/HYJ1817/pi-gui/actions/runs/<实际runId>` 的 head_sha、event、run_attempt、pull_requests，
确认其中关联的 PR number/head/base 属于当前 PR，并核对其实际 merge SHA 与 G2 summary；关联缺失或不一致时不合并。
**GitHub 原生 required checks 接受 skipped/neutral**，不能宣称只配置名称就强制“结论必须 success”。
本 workflow 通过无过滤触发、always gate 和全部上游精确 success 检查避免日常意外 skip；
有修改 workflow/同名 Actions 的写权限者仍可改动检查实现，最小 Ruleset 不是对恶意 CI 作者的隔离证明，CI 改动须独立复核、用户最终决定。

启用步骤（均待 G3 代码验收及用户另外授权；本轮未执行）：

1. 先保存现场 rules/protection 快照，核对没有并行新增规则；确认管理员仍可编辑规则，避免配置失误无法恢复。
2. 当前 G3 PR 全部测试、构建、证据和最终 CI gate 成功，核对实际 app id 与唯一 context；保留用户最终批准记录。
3. 在 Settings → Rules → Rulesets 导入草案，先保持 Disabled 审阅；确认 include 仅 main、无旁路、approvals 0。
4. 得到启用授权后再切 Active，保存规则 ID/配置；或在取得 API 写授权后将草案 enforcement 改 active 并提交 create ruleset API。
5. 不破坏 main 地核对既有/下一次正常 PR 的合并框：无 checks、旧 head、失败/取消均不符合；当前成功 PR 不被误锁。
   skipped/neutral 的平台限制按上文保留，不能伪造“拒绝所有 skipped”的实测。
6. 回滚：由管理员将该 ID 的 enforcement 改 Disabled，保留审计快照；先停用而非删除或放宽其他规则。
   branch protection 可作为同等目标的 UI 备选（PR、CI gate 严格模式、应用管理员、0 审批），不要同时叠两套重叠规则。

参数来源：[GitHub Rules REST](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset)、
[可用规则](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)、
[保护分支与 skipped/neutral 语义](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)。

## 验证与待最终验收

| 检查/命令 | 本轮实际结果 |
| --- | --- |
| 修改前 `npm run test:ci` | 退出 0，7 套件；汇总 29/29，完整基线为 196 条 |
| 最终代码树 `npm run test:ci` | 退出 0，8 套件完成，失败 0；持久化 10/10、汇总 30/30、历史统计 21 条断言、文档分类 28/28、实际 gate 15/15、调度就绪 5/5、发布证明 16/16、NSIS 12/12 |
| `node scripts/run-test-group.mjs --validate` | 退出 0，197 条，core 121 / ui 24 / security 27 / native 4 / faults 21 |
| before/current package 递归集合逐项对照 | 退出 0；旧 196 条同序、同组保留，唯一新增 `node tests/ci-doc-scope.cjs`；没有减少旧安全断言 |
| G2 真实 artifact 复核 | 退出 0；旧计划/身份完整通过 196/196；拿旧证据检查 G3 新计划则 allPassed=false/dataComplete=false，不允许旧计划替代新证明 |
| 版本、依赖及受保护路径检查 | 退出 0；版本/依赖对象相同；锁文件、产品代码、Native fixture/helper、分组/执行器/持久化/汇总实现、Release workflow 无差异 |
| JSON 草案/基线与 Markdown 本地路径检查 | 退出 0；草案 Disabled、仅 main、审批 0、来源 app 15368；155 个本地路径均存在 |
| `git diff --check` | 退出 0 |
| `npm run test:electron-smoke`（显式离线私有 Electron） | 退出 0，10/10（9 场景加进程清理），失败 0、skip 0；正常沙箱、renderer errors 0、观测 11 个本次进程身份、残留 0 |

正常沙箱专项本轮实际运行于 Windows x64、宿主 Node 24.22.1、Electron 44.4.3/内嵌 Node 24.21.0。
沿 G2 已确认的共享安装路径环境限制，使用现有 `%TEMP%\pi-gui-g2-electron-44.4.3`，
再次核对 electron.exe SHA256 为 `BF0FE749904CA9F713CCFB2427C519FA39D0BBD0337BA411BA08785802E8D548`。
未下载、未改沙箱或用户安装。仅命令局部设置 ELECTRON_OVERRIDE_DIST_PATH 与 G2_SMOKE_OUTPUT。
本次 [结果 JSON](evidence/g3/electron-smoke.json) 中 9 场景及退出清理均通过；四张本次截图保留于
`%TEMP%\pi-gui-g3-electron-3395a2765c4a4672be2a2ad45edccd97`，不将 G2 图片当作本次图片。
本轮没有修改 UI，不额外归档重复 PNG；GitHub 正常沙箱专项的稳定性仍未验证，原专项入口保持。

可重复的基线核对命令为 `gh run view 40074245381 --repo HYJ1817/pi-gui --json attempt,event,headSha,status,conclusion,jobs,url`，
并 `gh run download 40074245381 --repo HYJ1817/pi-gui --dir <新的TEMP目录>` 读取五组结果及 ci-evidence-summary。
报告的 [固定投影](G3-ci-baseline.json) 保留各 job/步骤起止和前五慢项；artifact 保留期外不假装还能重新下载。

失败与修复历史：新增测试先因缺模块、旧 build 依赖串行边而失败，再实现通过；
首轮分类 fixture 在 Windows 下试图把 Git symlink index 直接 chmod 成普通文件失败，改为只在 TEMP Git 中从已知普通文件树重建 index；
另一断言将 symlink 预期为 M，但 Git 实际报告 T，已改为明确验证保守拒绝 T，未放宽分类器或跳过场景。
首次基线 jobs 命令的 PowerShell/JQ 转义错误已改为读取实际 JSON 核对，不计测试失败或成功样本。
没有远端 G3 失败/重跑历史，因为未触发运行；没有修改或重跑历史 run。

完整本地 `npm test` 未运行，按用户第六节由最终状态远端 PR CI 证明；目前未授权 push/创建 PR，
所以完整 G3 PR CI、真实 runner 并行/排队/性能收益及 GitHub gate 全链路仍**待验证**，没有 G3 run URL。
main 基线和隔离回归不能替代最终状态的 PR 证明。Native/故障重型套件没有本轮新运行：其源码、分组、TEMP、权限及预算均未改，
当前基线已经提供这些套件的完整成功证明；调度变化的最终组合验证由后续 PR CI 覆盖。未重建本地产物，打包步骤原样保留且须在该 CI 成功。

作者全 diff 及增量检查：未发现可证实的未解决 Blocker（0）/Important（0）；独立功能/安全审查均待用户另行组织，未启动子 Agent。
剩余风险为 runner 配额竞争及失败路径额外打包成本、诊断分类器未来接入的可信来源与文档检查缺口、原生 GitHub skipped/neutral 语义。
文档减测保持关闭；保护草案保持 Disabled；没有通过配置声称取得管理保护或最终验收。

回滚边界：先 revert 交付文档/证据提交（上述 after HEAD 解析方式），再按需
`git revert 21cfe3906b181aafd164c0dcc776c4f88c25ad0d` 撤分类器/测试注册；
`git revert a9a4a59304f0a72bcb2d145f418d1c3ef5db3366` 撤打包并行及增量基建回归。
若未来已另行授权启用 Ruleset，则由管理员先将该规则 Disabled，不能用 Git revert 伪装已回滚远端设置。
无用户数据迁移或文件恢复，不使用 reset --hard/clean 或清理其他 Worktree。

结论：本地开发交付具备，可供独立审查并在后续授权后推送、创建一个 G3 PR；当前不具备直接合并条件。
最终代码验收待独立审查和真实 PR CI，性能收益未验证，文档轻量路径不启用，保护启用待单独授权；发布未授权、不进入 G4。
