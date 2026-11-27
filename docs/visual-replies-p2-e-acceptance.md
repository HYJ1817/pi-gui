# Visual Replies P2 · E：规范测试链与 CI 验收

日期：2026-11-27。总体逐项覆盖与真实样例矩阵见 [覆盖索引](visual-replies-p2-coverage.md)。
第 1–7 节保留 E 原交付的历史身份与证据；第 8–9 节保留 E2 首批登记和 C 测试集成后 UI 单 leaf 复验；**第 10 节是 E3 在 B 成组集成后的当前登记与一次完整 Artifact 离线子链结果**。
历史段落中“文件尚未集成 / 未完整执行 alias”仅对应当时状态，以第 10 节的新证据补充，不倒写历史。
本报告只证明所列测试基建与离线范围，不代表 A–D 全部集成、真实 Visual Replies 已验收或允许发布。

## 1. 身份、范围与勘察

- 准确 before HEAD：`dfdc1ddea060d8c369e5e0932d052655baa3d772`。
- E 分支：`feat/visual-replies-p2-e`；基建提交：`e67b0211623d23a17fb8486a3731509a79d86fb7`。
- 报告提交：包含本报告的首个交付提交，可用 `git log --reverse --format=%H -- docs/visual-replies-p2-e-acceptance.md` 解析；最终 SHA 另见交付消息。
- 工具起初把 worktree 建在 settings 的 `114b52a7`。工作区干净；`merge --ff-only` 拒绝分叉后，保留原 `t3/69cb772b`，新建 E 分支到指定父基线；未 reset、未合入 settings 改动。
- Node `v24.22.1` / npm `11.19.1`，Windows 11；复用 `C:/pi-GUI/node_modules` 的只读依赖内容，经 worktree 的目录 junction 解析；未安装或下载依赖。
- 本线未修改 `public/`、`server/`、Electron 产品代码或 A–D 专属测试；因此未重建产品，不能据本线声明正式产物更新。

勘察发现与处理：

1. 既有 `package.json` → npm 生命周期/递归 alias → `test-group-plan.mjs` → `run-test-group.mjs` → v2 结果/汇总/gate 已具备唯一计划和失败闭合能力，全部复用。
2. 准确基线的 355 个叶命令中确实没有 backend/process；不是从旧验收报告推断，也没有其他 workflow 补跑它们。
3. 计划器此前只提取 `node tests/...`，使 `node --test tests/...` 未参与文件存在性检查、Artifact UI/security 也落在 core。最小修补同时识别这两种既有命令形状；多文件命令保持一个叶子，不拆成另一份执行清单，混合分组回退 core。
4. Electron、真实 Pi 契约、真实模型、打包、模拟必须分层。沿用 offline/live 入口，另给正常沙箱安全专项独立 npm 入口及手动 workflow；不把启动或 check-driver 当真实验收。

## 2. 准确基线的现成完整 CI

| 字段 | 核验事实 |
| --- | --- |
| Run | [45952490979](https://github.com/HYJ1817/pi-gui/actions/runs/45952490979)，workflow `CI` |
| 身份 | event `push`，branch `main`，attempt `1`，head/GITHUB_SHA 均为 `dfdc1ddea060d8c369e5e0932d052655baa3d772` |
| API 状态 | `completed` / `success`，不是先前的 `in_progress` |
| Gate | [140357308989](https://github.com/HYJ1817/pi-gui/actions/runs/45952490979/job/140357308989) `CI gate` success，完成于 `2026-11-27T06:50:12Z` |
| 上游 | test-plan、五组测试、Electron build check 全部 success；gate 实际执行完整证据汇总与全部上游检查 |
| 计划摘要 | `8af2e939283526eb0342fed1ac8f7e4f3c650c7021ff785cf8cd749d9e4c106b` |
| 逐叶证明 | 355 个唯一命令，355 passed 且 exitCode=0；failed/cancelled/interrupted/skipped/pending/running/unexecuted 均 0 |
| 汇总资格 | `allPassed=true`、`dataComplete=true`、`hasUnfinishedRecords=false` |

| 基线组 | 完成/计划叶数 | 组测试跨度 |
| --- | ---: | ---: |
| core | 279/279 | 979.024 s |
| ui | 24/24 | 111.620 s |
| security | 27/27 | 688.563 s |
| native | 4/4 | 799.945 s |
| faults | 21/21 | 710.490 s |

测试组总体跨度 982.899 s；逐叶执行耗时合计 3288.851 s。它们不是 Actions 排队或 runner 总占用时长。
叶命令成功数不是断言数；组级 skipped=0 也不表示各套件内部没有权限 skip。

**完整结构化证据位置（本机 TEMP，不作为永久存档承诺）：**

```text
C:/Users/21022/AppData/Local/Temp/pi-gui-p2-e-baseline-c9700f2aa4d44e70be48db3d6640124b/
  ci-evidence-summary/ci-summary.json
  test-results-core/results.json
  test-results-ui/results.json
  test-results-security/results.json
  test-results-native/results.json
  test-results-faults/results.json
```

来源：`gh run download 45952490979 --dir <本次独立TEMP目录>`。在仍为 **dfdc1dde 准确基线**、尚未改计划时，实际运行：

```text
GITHUB_SHA=dfdc1ddea060d8c369e5e0932d052655baa3d772
GITHUB_RUN_ID=45952490979
GITHUB_RUN_ATTEMPT=1
GITHUB_EVENT_NAME=push
node scripts/summarize-ci-results.mjs --input <上述目录> --require-complete
```

以上是环境变量/命令记录，不是 PowerShell 可直接粘贴的赋值脚本。退出码 0，355/355 完整匹配当时有序计划、run、attempt、SHA 和摘要。
证据 artifact 保留期按既有 workflow 为 7 天。重验旧证据必须使用对应旧计划；不能把它喂给新的 358 叶计划后声称新改动通过。

此 CI **只证明基线原有 canonical**。它不证明缺失的 backend/process、不证明真实 Electron/模型，也不证明 E 或最终 P2 集成。已按协调选择复用，不重复完整基线 `npm test`。

## 3. 交付的规范链与分组证明

修改文件：

- `package.json`：把 `html-artifact-backend.cjs` / `html-artifact-process.cjs` 接到既有 `test:html-artifacts`；把新注册守卫接到 `test:ci`，经既有 `pretest` 进入 canonical；新增独立安全入口。
- `scripts/test-group-plan.mjs`：共用 `testFilesForCommand` 发现直接 Node 和 Node test runner 的文件；检查多文件命令的每个文件；新增最小 Artifact 分组规则。
- `tests/ci-test-plan.cjs`：新增 `node --test` 多文件发现、脚本参数不是第二套件、首/后续测试文件缺失失败的回归；保留生命周期、并集、短路及全部既有检查。
- `tests/ci-html-artifacts.cjs`：9 项注册/分组/授权/独立入口/workflow 守卫；不加载 Electron，不调用 Pi 或模型。
- `.github/workflows/visual-replies-security.yml`：独立手动入口，见下一节。

**修补前后精确比较：** 355 → 358 叶，删除 0、重复 0、额外新增 3：

```text
node --test tests/ci-html-artifacts.cjs
node tests/html-artifact-backend.cjs
node tests/html-artifact-process.cjs
```

原有 355 条命令全部保留。仅两条既有命令换组：`node --test tests/html-artifact-ui.cjs` core → ui，`node --test tests/html-artifact-security.cjs` core → security。
没有减少断言或把失败改成 skip；新增叶数不能解释为新增断言数。

E 交付计划摘要：`50636395c16e63dbd548ef207d33572a7fa2522e160741b50568c566989b8b82`。
`node scripts/run-test-group.mjs --validate` 实际退出 0：358 叶，core 279 / ui 25 / security 28 / native 4 / faults 22。

| Artifact 叶命令（文档索引，不是执行清单） | 分组 | E 的实测证据层 |
| --- | --- | --- |
| `node tests/html-artifact-model.cjs` | core | 纯模型/投影模拟 |
| `node --test tests/html-artifact-ui.cjs` | ui | jsdom，非布局/真实 Electron |
| `node tests/html-artifact-store.cjs` | core | TEMP 存储/故障/完整性 |
| `node tests/html-artifact-backend.cjs` | core | TEMP HTTP/权限/原生形状 fixture |
| `node tests/html-artifact-process.cjs` | faults | 真实后端/guardian/RPC 子进程，fake Pi；非真实 Pi |
| `node --test tests/html-artifact-security.cjs` | security | Electron API 替身/策略模拟，非 Chromium 沙箱 |
| `node tests/visual-replies-electron.cjs --check-driver` | core | 驱动 renderer 模板编译 |
| `node tests/visual-replies-electron.cjs --check-safety` | core | 离线驱动门控/清理/监听器自检，非 iframe 攻击验收 |

CI 主 workflow、组执行器、汇总器、必需 gate、远端设置均未改变；依旧只递归 npm 的唯一链。未知命令默认 core；组内顺序及 Native 独占 runner 不变。

## 4. 独立入口、门控与未运行的手动 workflow

| 入口 | 条件与证据边界 | 本次 E 状态 |
| --- | --- | --- |
| `npm run test:html-artifacts` | 默认离线 canonical 子链；受控 loopback/临时 fixture，不消耗模型额度 | 已执行 8 叶，exit 0 |
| `npm run test:html-artifacts:electron` | 既有 `--offline` 桌面入口；不能凭 fake Pi 启动成功记真实 Visual 通过 | 未运行 |
| `npm run test:html-artifacts:security:electron` | 既有 `tests/html-artifact-electron.cjs`，独立正常沙箱专项 | E 未运行；A 首轮失败单列于覆盖索引 |
| `npm run test:html-artifacts:live` | 必须同时显式 `--live` 和 `PI_GUI_VISUAL_REPLIES_LIVE=1`，另需明确可用模型/凭证授权；真实 Pi 契约与真实模型分别登记 | 无 opt-in 的拒绝路径实测 exit 2；未调用模型，不能计一次通过的模型测试 |
| 手动 `Visual Replies sandbox security` | Windows / 正常 sandbox / 无模型；非主 gate、非自动 PR/push 测试 | **未执行 / pending** |

手动 workflow 只用既有接口：在 `RUNNER_TEMP` 下新建包含 run ID/attempt 的目录，作为 `TEMP/TMP/TMPDIR`。
既有驱动通过 `os.tmpdir()` 在其中建立 `pi-html-artifact-security-*`。不依赖 A 尚未交付的 `HTML_ARTIFACT_EVIDENCE_ROOT` 新接口。
只上传该次合成 fixture 的 `report.json` 和 PNG；不上传 HOME、session、凭证、原始模型 payload 或整套日志目录。
使用现有固定版本 checkout/setup-node/upload-artifact，`contents: read`、checkout `persist-credentials: false`，无 secrets/live 变量、无 `continue-on-error`、无沙箱降级。
缺报告时上传步骤失败；测试非零、取消或未运行都不会变成通过。

**GitHub 可用条件：** 新 `workflow_dispatch` 文件通常需先存在于 default branch。当前仅功能分支新增，未合并、未 dispatch；本任务不通过改远端设置、偷偷加自动触发或合并来执行它。
A 后续安全执行被外部策略阻断并停止，E 不接替或绕过被阻断内容。当前安全专项保持阻断/未验证；新增 workflow 不是已跑 CI，更不是正式发布资格。

**父集成修复（独立于 E 原提交）：** E 提交映射为 `b4792be4` 后，父任务发现 job 级 TEMP 在依赖步骤前尚未建立。
父提交 `99d8ac827db42ef765f70db6adc1e89c7e2aa824` 把建目录移至第一个 step，新增创建顺序守卫；父报告改前 8 pass/1 fail，改后 9/9、skip 0、exit 0。
E 已读取该精确提交 diff 核对改动，但没有把父运行冒充 E 运行；本次仅文档交付不覆盖父已修文件。
**使用手动 workflow 必须同时包含这项顺序修复，不能只部署 E 原始基建提交。** 这仍不是安全专项实际执行证据。

## 5. 本地定向实测及首次失败

基线定向：准确 dfdc1dde 下 `npm run test:html-artifacts` 6 叶、`npm run test:ci` 9 叶，均 exit 0。
修补后同环境实测：Artifact 8 叶、CI 10 叶，均 exit 0。后续只补 opt-out 隔离、workflow TEMP 接口并针对性复跑新增守卫/计划，均 exit 0。
完整日志：`C:/Users/21022/AppData/Local/Temp/pi-gui-p2-e-targeted-cafa98e7fcde48488f27047904b7c971.log`。

| 实测对象 | 实际数字 | 退出码/skip |
| --- | --- | --- |
| Artifact model / UI | 8/8、13/13 Node tests | 各 exit 0，skip 0 |
| Store | 135/135 已执行场景，529 assertions | exit 0；另 skip 3（Windows 文件 symlink 权限，document.html/reference.json/.pending），不计入通过分子分母 |
| Backend / process | 38/38、8/8 Node tests（包含各自顶层父 test） | 各 exit 0，skip 0 |
| Electron policy 模拟 | 24/24 Node tests | exit 0，skip 0；不是实际 Electron 安全证明 |
| Driver syntax / offline safety | 7/7 模板、32/32 检查 | 各 exit 0，skip 0；不是 Visual 真实验收 |
| 新 CI 注册守卫 | 修补前 3 pass / 6 fail → 修补后及最终增量复验 9/9 | 首次 exit 1；修补/复验 exit 0；skip 0 |
| ci-test-plan | 358 叶 / 5 组精确覆盖；故意失败 fixture 保留 exit 17，组返回 1 且后续未执行 | 套件 exit 0；未输出总断言数，不编造 |
| ci-workflow | independent readiness 5/5，实际执行 gate 拒绝矩阵 15/15；另有结构守卫 | exit 0；矩阵次数不是全部断言数 |
| ci-results / ci-summary | 10/10、30/30 | exit 0 |
| ci-history / ci-doc-scope | 21 assertions、28/28 场景 | exit 0 |
| release-ci-proof / nsis-bootstrap | 16/16、12/12 | exit 0；NSIS 下载/安装是注入替身，没有真实下载或系统安装 |
| ci-electron-cache | zip/checksum/retry/mirror 守卫完成，未输出断言总数 | exit 0；注入离线替身 |
| test:file-size-report | 11/11 场景 | exit 0；文档阶段运行，TEMP fixture |

首轮注册守卫的 6 个失败分别对应：backend 未接链、计划器缺 Node test 文件发现接口、未来套件漏注册保护尚未建立、Artifact 分组未设定、安全独立 alias 缺失、手动 workflow 未创建。
原始功能没有因本线测试失败而被“修成 skip”。工具层另有不支持的 `git tag --count` 和安全拒绝分叉的 ff-only；均不是产品测试失败，已改用有效命令/新分支。

代表性实测数据：Store UTF-8 HTML 为 51 bytes，digest `ca917c3438c3e09ad3c87a1c74bd611a36d3aaae3f67885dbee8c36596cc5911`，物理快照 474 bytes；process 单次输出 duration 12342.1493 ms。这些不充当 B 的性能优化前后测量。

`git diff --check` exit 0；三篇本次文档（含导航）本地链接目标 194 个，missing 0，检查 exit 0（首次 shell 引号导致 Node eval 语法错误，修正命令后重验；非产品失败）。锚点及远端链接未由该检查验证。
未运行完整本地 `npm test`、正式构建、打包、真实 Pi、真实模型或本线桌面专项；原因是本线未改产品、基线完整 CI 已复用、用户选择最终当前 PR 的 canonical CI 提供新增/集成完整证明。
**最终 PR canonical：pending，不能用 dfdc1dde 的成功替代。**

## 6. 后续新增测试注册与集成复检

1. A–D 仍各自拥有产品和专属测试；E 不修改它们。新增离线 Artifact 套件使用 `tests/html-artifact-*.cjs`；桌面 `*-electron.cjs` 保持独立。真实 Pi/模型/打包入口必须另命名、另确认门控，不能因扫描器要求而强塞入离线链。
2. 文件实际集成后，仅在 `package.json` 既有 `test:html-artifacts` 追加 `node tests/<文件>.cjs` 或 `node --test tests/<文件>.cjs`；不新增 workflow 清单、第二份执行计划或复制 `npm test` 列表。
3. D 已通知的 `html-artifact-layout.cjs`、`html-artifact-frame.cjs`、`html-artifact-reading.cjs` 在原 E 交付时尚不存在，**原 E 未注册、未运行**。E2 集成后的登记与实测见第 8 节；三者归 ui。C 的既有 UI 入口保持。
4. `ci-html-artifacts` 会发现新增离线文件并要求在 Artifact alias 和完整链各恰好出现一次；缺注册/重复注册均失败。`--validate` 会拒绝尚不存在的文件，包括 `node --test` 的第二个及以后文件。
5. 集成者运行 `node scripts/run-test-group.mjs --validate --list`、`npm run test:html-artifacts`、`npm run test:ci`，重新记录真实数字、skip、新计划摘要和必要回归；不能沿用本线 358 叶数字为集成后的结果。
6. 完整 canonical 由当前 PR CI 覆盖最终代码状态；独立功能/安全审查由父任务另派新上下文。本线自查不是独立通过。

## 7. 风险、回滚与结论

- 风险：高（涉及 CI/test plan），未削弱主 gate、权限或产品隔离；真实沙箱未完成仍为阻断，完整新计划远端结果 pending。
- 回滚：E 原分支可 `git revert e67b0211623d23a17fb8486a3731509a79d86fb7` 回退本线测试基建；父集成若 cherry-pick，以映射后的 E 提交为回滚对象。报告/索引独立提交可独立回退。没有用户数据、存储 schema 或产物迁移需要恢复。
- 开发：E 规范链/守卫/入口已完成；D 等未来注册仍需集成复检。
- 代码验收：待当前 PR canonical、独立功能/安全审查及真实边界证据；不标整体通过。
- 合并/发布：未获本线授权；本线不 push、不创建 PR、不 merge、不 tag、不 release。

## 8. E2：首批集成后的登记与定向结果

本节为 `3584bcd2` 交付的首批快照，旧 UI 三个失败及当时的待交付状态保留；后续 C 适配和本线单 leaf 复验见第 9 节。

### 8.1 代码身份与范围

- 日期：2026-11-27；before HEAD `a2cdaeb01ad50ed4cad5f82f08361d5f707546a4`，分支 `feat/visual-replies-p2`。
- 仅使用 `C:/pi-GUI/.claude/worktrees/visual-replies-p2`。起始已有父任务未提交的 `docs/visual-replies-p2-plan.md`；不编辑、不暂存、不提交它。
- 该 HEAD 已包含 D 的高度/可见性/阅读实现和三套回归、C 首批宿主交互、A 首批六类良性样例。E 原提交映射为 `b4792be4` / `2152728b`；均已读取核对。
- E2 只修改 `package.json`、`tests/ci-html-artifacts.cjs` 和本报告/覆盖索引。实际 guard 名称不是任务简称中的 `html-artifact-ci.cjs`；不新建第二个 guard。
- 证据绑定上述 HEAD 加 E2 的 package/guard diff；四个新套件及产品文件未由 E2 修改。交付 SHA 为提交信息“测试(可视化)：登记首批 P2 集成回归并记录未验证边界”的提交，可用 `git log -1 --format=%H --grep='登记首批 P2 集成回归并记录未验证边界'` 定位；最终消息另给准确 SHA。
- Node `v24.22.1`、npm `11.19.1`、win32 x64、Windows `10.0.26200`；仅以 `NODE_PATH=C:/pi-GUI/node_modules` 读取现有依赖，未安装、下载、调用真实 Pi 或模型。按固定集成 SHA 和本批离线授权执行，未 fetch 或查询远端 Release/CI；当前 PR 完整 CI 未运行的状态不变。

### 8.2 唯一 canonical 链与增量守卫

复用既有 npm 生命周期、递归 alias 和计划器；只在 `test:html-artifacts` 原 8 叶之后追加：

| 新叶命令 | 分组 | 实际测试数 / 证据边界 |
| --- | --- | --- |
| `node --test tests/html-artifact-layout.cjs` | ui | 12；确定性 clock/resize/可见性，非像素布局 |
| `node --test tests/html-artifact-frame.cjs` | ui | 14；jsdom/受控几何/生产 bootstrap，非真实沙箱 |
| `node --test tests/html-artifact-reading.cjs` | ui | 12；阅读锚点/局部滚动，非原生跨 iframe 滚轮 |
| `node --test tests/visual-replies-normal-samples.cjs` | core | 7；六类合成良性样例及交互，不是模型调用或真实 Electron |

精确计划比较：**358 → 362 叶，原 358 叶全部保留、相对顺序不变、删除 0、重复 0、旧叶换组 0**。
Artifact alias 为 8 → 12 叶。包括 backend/process、旧 UI/security、driver/safety 在内的原 8 叶命令逐字保留；其他 alias、`test`、`pretest`、`test:ci` 未修改。
五组为 core **280** / ui **28** / security **28** / native **4** / faults **22**。
计划摘要：`509f720388b3d5b3a2b4bfa61db5540995ae38eaa62e240a23505381c025fa0a`。
`node scripts/run-test-group.mjs --validate --list` exit 0 只证明计划覆盖，不代表 362 叶已执行。

Guard 保留原 9 项，增加 normal-samples 漏注册/重复注册拒绝、四个新 Node test runner 入口、fixture 非独立套件三项，共 12 项。
扫描只读顶层离线套件，normal-samples 纳入同一覆盖检查；不放宽 Electron、真实 Pi/模型、打包及危险 flags 边界。
`tests/fixtures/html-artifact-d-clock.cjs` 和 `tests/fixtures/visual-replies-normal-samples.cjs` 均不注册。
没有改 CI workflow、计划器、产品实现、其他人的测试或断言，也没有把失败改成 skip。

### 8.3 实测命令、准确数量与首次失败

全部在上述工作树执行，环境 `NODE_PATH=C:/pi-GUI/node_modules`。日志根目录为本次唯一 TEMP：
`C:/Users/21022/AppData/Local/Temp/pi-gui-p2-e2-2GMMhp/`。
`environment.json` 记录起始 HEAD/dirty 状态；`after-registration-environment.json` 另记 package、guard 和四套测试的 SHA-256。
每条直接命令有同名 `.json` 退出码/耗时记录，完整输出在下表 `.log`；它们不是永久存档承诺。

| 实际命令（均为定向运行） | pass / fail / skip | exit / 日志 |
| --- | --- | --- |
| `node --test tests/ci-html-artifacts.cjs`，登记前 | 8 / 1 / 0 | 1；`before-guard.log` |
| `node --test tests/html-artifact-layout.cjs` | 12 / 0 / 0 | 0；`layout.log` |
| `node --test tests/html-artifact-frame.cjs` | 14 / 0 / 0 | 0；`frame.log` |
| `node --test tests/html-artifact-reading.cjs` | 12 / 0 / 0 | 0；`reading.log` |
| `node --test tests/visual-replies-normal-samples.cjs` | 7 / 0 / 0 | 0；`normal.log` |
| `node --test tests/ci-html-artifacts.cjs`，登记后及 `test:ci` 内复跑 | 各 12 / 0 / 0 | 各 0；`after-guard.log` / `test-ci.log` |
| `node scripts/run-test-group.mjs --validate --list` | 362 叶精确覆盖；不是测试执行数 | 0；`validate.log`、`plan-comparison.json` |
| `node tests/html-artifact-model.cjs` | 8 / 0 / 0 | 0；`model.log` |
| `node --test tests/html-artifact-ui.cjs` | **10 / 3 / 0** | **1**；`old-ui.log`，保留失败 |
| `node tests/html-artifact-store.cjs` | **135/135 场景，529 assertions；另 skip 3** | 0；`store.log` |
| `node tests/html-artifact-backend.cjs` | 38 / 0 / 0 Node tests，含父 test | 0；`backend.log` |
| `node tests/html-artifact-process.cjs` | 8 / 0 / 0 Node tests，含父 test；fake Pi | 0；`process.log` |
| `npm run test:ci` | 10 叶命令全部 exit 0；未输出完整总断言数，不编造 | 0；`test-ci.log`，42989 ms |
| `node tests/file-size-report.cjs` | 11/11 场景，未报告 skip | 0；`file-size-report.log` |

D 三套为 **38/38**，加 normal-samples 为 **45/45**，fail/skip 均 0；重复执行 guard 不重复计入新增测试数。
四套先于登记直接运行一次，登记完成后又从实际 alias 展开的四条新叶逐条复跑，结果均不变；最终复跑日志为 `registered-html-artifact-{layout,frame,reading}.log` 和 `registered-visual-replies-normal-samples.log`，不重复累计为 90 个测试。
Store 的 3 个 skip 仍是 Windows 文件 symlink 权限（document.html / reference.json / .pending），不计入 135 的分子分母。
代表输出仍为 UTF-8 HTML 51 bytes、物理快照 474 bytes、digest `ca917c3438c3e09ad3c87a1c74bd611a36d3aaae3f67885dbee8c36596cc5911`。
Process duration 为 12569.2947 ms；不是 B 的性能优化前后对照。
自查 `git diff --check` exit 0；两篇拥有文档的 4 个本地链接、其中 2 个标题锚点，missing 0。
Guard 原 9 个 test 名称和原 47 条源码断言行均保留（当前 12 个 test、56 条断言行）；源码行计数不是执行断言总数，证据在 `self-check.json`。

`test:ci` 具体输出：ci-test-plan 362 叶/5 组精确覆盖；ci-workflow readiness 5/5、gate 拒绝矩阵 15/15；
ci-html-artifacts 12/12；ci-results 10/10；ci-summary 30/30；ci-history 21 assertions；ci-doc-scope 28/28；
release-ci-proof 16/16；nsis-bootstrap 12/12。ci-electron-cache 与 ci-test-plan 未报告总断言数。
下载、安装、GitHub API 和故意失败/取消均为这些测试自身的离线替身；没有执行网络下载或真实安装。
Guard 内 `--live` 无授权子进程明确在 import/spawn 前 exit 2，只证明拒绝路径，不是模型或安全专项执行。

首次失败保留：

1. 登记前 guard 为 8 pass / 1 fail，首个断言为 `tests/html-artifact-frame.cjs must execute exactly once in the canonical chain`，实际 0、期望 1。只补登记/守卫后为 12/12。
2. 旧 UI 在当前集成产品上为 10 pass / 3 fail，三处均是实际 `loading`、期望 `ready`：`tests/html-artifact-ui.cjs:131`、`:152`、`:197`；首个失败 test 从 `:116` 开始。C 的旧 UI 适配尚未交付，E2 不修改测试/产品、不改 skip，也不声称根因已修复。
3. 记录中的工具参数 JSON 截断发生在命令/编辑执行前，未构成测试运行或部分写入；不是产品失败。

### 8.4 本批登记集合、后续交接与未验证

- 本批仅完成 **D layout/frame/reading + normal-samples** 四新套件登记及上述定向证据，不等候全部 A/B/C 才交付。
- 待后续实际文件交付再登记：A1 新离线套件、B2 performance/lock/maintenance、B3 branches、C 新套件（如有）。不预注册不存在文件，不猜文件名；C 对既有 UI 的适配也待交付复跑。
- **B2 勘察状态非已通过：** B2 已报告 maintenance/CLI 用 `confirmNativeWritersStopped` 作为删除资格是实际缺陷，正将 collect 收紧为 fail-closed / candidates-only，不依赖口述停写。本批 SHA 不包含这项后续收紧；候选扫描不是自动 GC 或容量回收已完成。旧 Store 135 场景/529 assertions/另 skip 3 只证明旧受控 fixture，不解除该缺陷。
- A 正常沙箱安全首轮 28/29、about:blank 自导航断言失败且后续服务拒绝仍保留 failed/blocked。E2 未运行安全专项、不改 A 文件、不接替或绕过；也未运行纯离线 `html-artifact-security.cjs`。
- 未完整执行 Artifact alias（旧 UI 已有失败，且本批不跑安全相关入口）；现 12 叶已登记不等于该 alias 已通过。
- **完整 canonical：pending。** 用户预先选择当前 PR 完整 CI；本批未运行完整本地 `npm test`，当前 PR 完整 CI 尚未运行，未取得 run/attempt/head 或 merge SHA/gate 证明。不能用历史 355 叶 main CI、362 叶计划检查或本地 `test:ci` 代替。
- 产品整体、真实普通交互/截图、真实 Pi、真实模型、正常沙箱、完整集成、重建/打包及独立功能/安全审查分别 pending；安全已有失败不能被“pending”覆盖。本线不改 public/server，不负责重建，不声称产物更新；最终集成、产物、推送由父任务负责。
- 风险按 CI/test 输入对待；E2 自查不是独立复审。回滚为仅回退本 E2 提交，不动父 plan 或后续产品提交；无用户数据/schema 迁移。
- 本批登记开发已完成；整体代码验收未通过、无合并/发布许可。不 push、不建 PR、不 merge、不发版。

## 9. E2 收尾：C 测试集成后的 UI 单 leaf 复验

### 9.1 身份、执行次数与实际结果

- C 原提交 `1d4bec0d` 已映射为 `0aacdb53ad265edc3b77b08e83721525343f171b`，仅修改 UI 套件并新增独立良性 viewer-electron。E2 首批提交仍为 `3584bcd2fb2e48665fb9ed6c0c2ee98a16613b03`。
- 本次 UI 运行的 before/after HEAD 均为准确 `0aacdb53ad265edc3b77b08e83721525343f171b`，开始于 `2026-11-27T08:09:30.622Z`；当时未提交范围只有 E 的 coverage 与父 plan 文档。父后来仅提交 plan 为 `7bdd3d582db611cbdf17e11c9a941de66e7290b7`，本次收尾不修改它。
- 只执行一次 `node --test tests/html-artifact-ui.cjs`：**20 pass / 0 fail / 0 skip，169 assertions，exit 0**。Node reporter duration **3633.9169 ms**，外层子进程耗时 **3937 ms**；中断后未重复运行。
- 环境：同一指定集成树，Node `v24.22.1`、win32 x64 / Windows `10.0.26200`，`NODE_PATH=C:/pi-GUI/node_modules`。测试与六个相关产品模块的运行前后 SHA-256 全部一致；未改产品、UI 测试、package 或 guard。
- C 的原 13 项/111 断言保留，扩展为 20 项/169 断言；第 8 节修前 **10 pass / 3 fail / skip 0** 和三处 `loading`/`ready` 失败完整保留，不抹除、不改 skip。当前 20/169 是适配后的新证据，不倒写历史。
- C 报告的 UI+D 联合 **58/58** 仍属 C 的证据；本次 E 未重跑 D，也不把不同代码状态的结果相加成一次集成通过。

本次唯一日志根目录：`C:/Users/21022/AppData/Local/Temp/pi-gui-p2-e2-c-handoff-JVaj3c/`。
`current-ui.log` 保存实际输出；`current-ui.json` 保存准确 HEAD、dirty 范围、环境、退出码、耗时和前后源码摘要。
本轮此前轻量检查另有 `guard.log`（12/12、fail/skip 0、exit 0）、`validate.log`（362 叶精确覆盖、exit 0）与 `viewer-syntax.log`（`node --check tests/html-artifact-viewer-electron.cjs` exit 0）；未启动桌面脚本。
canonical 仍为 362 叶，原计划摘要与分组不变。没有重跑完整老套件、整条 Artifact/test:ci 链或完整 `npm test`。

### 9.2 审查、真实边界与后续交接

**定向通过不是审查通过。** 已读取父 plan 的 R-D 首轮记录：Blocker 0 / **Important 4 未解决** / Nit 0 / Pre-existing 0，结论不通过；D2/C 正在修复，E 不接替产品修复或增量独立复审：

1. RD-1：CSS transition 被自然高度反馈 hold 误锁，200→600px 最终 frame 207px/capped。
2. RD-2：expanded 消费 naturalHeight 绕过 hold，`calc(100vh + 10px)` 持续增高；65536px 上限不是修复。
3. RD-3：12000px 内容全屏往返，iframe 内部 scrollY 7904→0→0；同 realm/输入保留不能替代内部阅读位置保存，需保存确认后再切换以避免先 clamp。
4. RD-4：字符串 timer 句柄 `clearInterval(String(handle))` 未按原生接口转换，interval 残留。

C 修前的正常 sandbox **22 checks / 9 图**是其良性桌面证据，不是 E 本次复验或 A 安全资格；约 **4008px** 样例不覆盖 **>4096px / RD-3**。默认共享 runtime 启动失败、同摘要私有离线路径及正常 sandbox 分别披露，不把语法检查充当桌面通过。
`tests/html-artifact-viewer-electron.cjs` 保持独立良性桌面入口，不塞离线 canonical，本次没有运行它。

**既有范围差异：** 父决定保留 `session-navigation.js` 的 bounded text-only 只读 Classic 历史预览契约，不扩 UI；该页可视化是 P1 既有范围差异。`fetchHistory` 加共享 viewer 的回归不能证明该只读预览页面已可视化，活动 Classic 恢复和 Runtime live/dormant 的渲染链分别登记。

B3 的 `2cd34ec2` 报告 branches 17/17、372 断言；父决定随 B2 产品成组集成。当前树无 `tests/html-artifact-branches.cjs`，因此本次不登记该 leaf 或 fixture，也不提前登记未到齐的 B/A 文件；后续新 leaf 全由父统一处理，E 结束本批、不循环等待。
B2 candidates-only/fail-closed 的待办仍不能写作自动 GC/容量回收完成；首批 Store 135 场景/529 assertions/另 skip 3 的旧证据保持原范围。

**仍未验证：** 当前 PR 完整 canonical CI **pending**；产品整体、D2/C 修后复验及增量独立审查、真实普通交互/模型/Pi、正常沙箱资格和正式打包仍各自独立。用户随后允许模型调用不代表本线已运行，E 本线不调用模型。A 安全的首轮 28/29 失败及后续服务拒绝仍 **failed/blocked**，不重启、不接替。
本次只提交 coverage 和本验收两份拥有文档，不改父 plan；本次文档提交可独立回退，无产品或数据迁移。交付提交标题为“文档(可视化)：记录UI单叶复验与未决验收边界”，最终消息给出准确 SHA。
文档自查：`git diff --check` exit 0；本地链接 5 个、标题锚点 3 个、missing 0；当前 UI 测试与六个产品模块共 7 个摘要仍匹配已验证状态，package/guard 未变，branches 文件不存在。证据为同一日志目录的 `documentation-self-check.json`。
文档收尾完成不等于整体验收通过，无合并/发布许可；不 push、不建 PR、不等待其他线。

## 10. E3：B 成组集成后的四叶登记与一次离线子链

### 10.1 身份、所有权与执行边界

- 日期：2026-11-27；工作树仅 `C:/pi-GUI/.claude/worktrees/visual-replies-p2`，分支 `feat/visual-replies-p2`。入口 HEAD `4649ac53`；开始执行前父仅追加 plan 文档提交 `e44686951bc1658109554d6530b54ba858a35027`，二者产品/测试行为树一致。本批未 fetch、查询 Release 或远端 CI：按用户指定集成状态及离线范围收尾，不切换到其他基线。
- B3 `2cd34ec2` → `4094729c`；B2 依序为 `5b69c52a` → `e90bfcf9`、`00e22156` → `fcaaee59`、`d009d05b` → `441bcfc5`、`23e82c91` → `4649ac53`。D2 生产/句柄/六项测试已分别集成为 `fd88630d` / `321ce11d` / `45135b80`，不是本批新增改动。
- 本批实测均绑定 **e4468695 + package/guard diff**；一次 Artifact 子链开始于 `2026-11-27T09:01:42.597Z`，前后 HEAD 均为 e4468695。测试链提交为 `403e0cf9b4573048e8e87da8952a27781f431323`，其行为文件与所测 diff 一致；本节和 coverage 随后仅补文档，文档交付 SHA 见最终消息（可用 `git log -1 --format=%H -- docs/visual-replies-p2-e-acceptance.md` 定位本次交付）。
- 只修改 `package.json`、`tests/ci-html-artifacts.cjs` 和本报告/coverage；不编辑、暂存或提交父独占的 plan，不修改产品、A/C/D/B 专属测试，不另建工作树，不委派审查或子任务。
- 环境：Node `v24.22.1` / npm `11.19.1`，win32 x64 / Windows `10.0.26200`；`NODE_PATH=C:/pi-GUI/node_modules` 只读复用现有依赖，未安装、下载、调用模型/真 Pi 或访问外网。npm 缓存、测试 fixture、日志与报告均在系统 TEMP；源码/提交文件为本批授权改动。
- 执行前读代码核对：`html-artifact-security.cjs` 使用 EventEmitter/API 替身及 VM preload，不启动 Electron；driver `--check-driver` 只编译模板，`--check-safety` 使用 TEMP、合成进程身份、隔离 Git 和受控 loopback HTTP/TCP/UDP listener 自检。后端/分支/process 也只用 loopback 和 fake Pi。这里的本机包见证不是外网请求或实际 iframe 攻击；没有执行 `html-artifact-electron.cjs`、任何桌面/A 专项或 benchmark。

### 10.2 唯一计划增量及守卫

在原 alias 尾部只追加下列四条既有实际文件的叶命令，fixture/helper 不登记；前三类 runner 不互换，性能只登记默认小回归：

| 新叶命令（核对索引，不是第二执行清单） | 分组 |
| --- | --- |
| `node --test tests/html-artifact-branches.cjs` | core |
| `node tests/html-artifact-lock.cjs` | core |
| `node tests/html-artifact-maintenance.cjs` | core |
| `node tests/html-artifact-performance.cjs` | core |

**实测 362 → 366 叶；原 362 叶全保留且相对顺序不变；新增 4、删除 0、重复 0、旧叶换组 0。**
Artifact alias **12 → 16** 叶；分组 core **284** / ui **28** / security **28** / native **4** / faults **22**。
计划摘要 `e562af825067962812c140d723bea155c29f8c874e1a22d5a4279840feb7f615`。
原 `test` / `pretest` / `test:ci`、npm 生命周期/递归 alias、计划器和 workflow 均不变，无第二份默认 CI 清单。

Guard 原 **12 项 test、56 条源码断言行全部保留**，新增三项后为 **15 项、65 条断言行**（源码行数不是执行断言总数）：
精确核对 B 四个 runner 类型与唯一登记；验证 plain Node 和 `node --test` 并存、缺登记/重复拒绝、plain Node 后续脚本参数不算新套件；禁止 canonical 的 `--benchmark` / `--baseline` 及 Artifact fixture 独立执行。
`tests/fixtures/html-artifact-branches-fixture.cjs` 和既有 D/normal helper 均不登记。没有删旧断言或将失败改成 skip。

### 10.3 实测命令、每套数字与首次失败

本次唯一 TEMP 日志根目录：`C:/Users/21022/AppData/Local/Temp/pi-gui-p2-e3-B8tfaD/`。
每条命令保留同名 `.log` / `.json` 与 `*-before.json` / `*-after.json`；后者记录 HEAD、dirty 范围和 **1223 个行为文件** SHA-256。
`before-plan.json` / `after-plan.json` / `plan-comparison.json` 保留精确有序计划；`guard-preservation.json` 保留原断言完整性核对。这些是本机短期证据，不作永久存档承诺。

| 实际命令 | 结果 | exit / 日志 |
| --- | --- | --- |
| `node --test tests/ci-html-artifacts.cjs`，登记前 | **11 pass / 1 fail / skip 0**；branches 未登记，实际 0 / 期望 1 | **1**；`before-guard.log` |
| `node scripts/run-test-group.mjs --validate --list`，登记前 | 362 叶精确覆盖；不是执行证明，也不会主动发现未登记新文件 | 0；`before-validate.log` |
| `node --test tests/ci-html-artifacts.cjs`，登记后 | **15 pass / fail 0 / skip 0**；Node duration 340.8831 ms | 0；`after-guard.log` |
| `node scripts/run-test-group.mjs --validate --list`，登记后 | **366 叶**精确覆盖 | 0；`validate.log` |
| `node tests/ci-test-plan.cjs` | 366 叶 / 5 组精确覆盖；未输出总断言数，不编造 | 0；`ci-test-plan.log` |
| `node tests/ci-workflow.cjs` | readiness **5/5**，gate fail-closed 矩阵 **15/15**，另有结构守卫 | 0；`ci-workflow.log` |
| **`npm run test:html-artifacts`，仅运行一次** | **16 叶全部完成、exit 0**；外层记录 72674 ms（含收尾摘要采集），输出 32510 bytes，前后行为文件变化 0/1223 | 0；`html-artifacts.log` / `.json` |

以下每行均取自上述 **同一次真实 npm alias** 输出，不把作者数字、E2 单跑或父 D 运行相加；各 leaf 进程均成功返回，失败短路未触发：

| Alias 内套件 / 模式 | 实测通过 / 失败；断言口径 | skip（不计分子分母） |
| --- | --- | --- |
| model | **8 / 0** Node tests | 0 |
| UI | **20 / 0** Node tests，**169** assertions | 0 |
| Store | **135/135** 已执行场景，**529** assertions | **另 3**；Windows 文件 symlink 权限，document.html / reference.json / .pending |
| backend | **38 / 0** Node tests，包含父容器 | 0 |
| process | **8 / 0** Node tests，包含父容器；真实后端/guardian + fake Pi，duration **13839.7096 ms** | 0 |
| security | **24 / 0** Node tests；纯 Electron API 策略模拟 | 0 |
| driver `--check-driver` | **7/7** renderer 模板 | 0 |
| driver `--check-safety` | **32/32** 离线驱动检查；非 iframe 攻击 | 0 |
| layout | **13 / 0** Node tests | 0 |
| frame | **19 / 0** Node tests | 0 |
| reading | **12 / 0** Node tests | 0 |
| normal-samples | **7 / 0** Node tests | 0 |
| branches | **17 / 0** Node tests（16 子项 + 父容器），**372** assertions；duration **7926.2892 ms** | 0 |
| lock | **14/14** 场景，**103** assertions | 0 |
| maintenance | **20/20** 场景，**119** assertions | 0 |
| performance 默认 regression | **16/16** assertions；**未运行 benchmark/baseline** | 0 |

D 三套当前 **44/44**，比 E2 历史 38 项增加 6（layout +1、frame +5、reading 不变），没有断言减少；不是 C 握手消费者或四项 RD 的独立复审。
原 E2 UI **10 pass / 3 fail** 保留历史；本次用已集成 C 适配后测试为 20/169，不倒写修前数字。

首失败是登记前 guard 的 `tests/html-artifact-branches.cjs must execute exactly once in the canonical chain`，`ci-html-artifacts.cjs:20`，实际 0、期望 1。补登记和守卫后 15/15；本次 alias 内无失败、无取消、无重跑，没有修改他人文件或改 skip。
工具层另有创建日志目录前的 Node heredoc 转义语法错误（exit 1，解析阶段失败、未产生 fixture），随后纠正；它不是套件或产品失败。

### 10.4 实测数据、证据有效范围与交接

- Store 代表值：UTF-8 HTML **51 bytes**，物理快照 **474 bytes**，digest `ca917c3438c3e09ad3c87a1c74bd611a36d3aaae3f67885dbee8c36596cc5911`。
- 默认 performance：8 历史快照 / 8 sessions，corpus **262152 bytes**；8 并发调用，new HTML **4103 bytes**，该轮 **749.883 ms**；HTML read **65648 bytes / 32 calls**。corpus 与 readback integrity digest 同为 `29fa7412d5e31db4aa0c548abb4797ffcf488677fd958e4d7d2158479e99c674`，实现源码 SHA-256 `cbccb16333dca2c21ce029e12cb2f9159b0288c618f4dae1db10ba96a2bb075f`。这是单轮小回归，不是优化前后 benchmark。
- 作者 B2 转报的同口径 benchmark 中位 **6823.011 → 3735.489 ms**、同 digest，以及每侧 26 assertions 只作对照，**E3 未重复运行、未将其登记为本线实测**。默认 16 assertions 与 benchmark 26 的口径不同，不能算少了 10 条默认断言。
- maintenance 验证已集成的 **candidates-only / fail-closed**：口述停写不能授权 collect，没有原生互斥证明不自动 GC；不再把待收紧的旧缺陷写成仍未集成，也不把只读候选扫描写成自动 GC/容量回收完成。未知/旧格式/torn owner 保留证据，锁恢复只由显式身份门控路径处理；不代表所有平台已证明。
- B 首轮独立功能静态审查转报 **有条件通过，Blocker 0 / Important 0 / Nit 0 / Pre-existing 1**（bounded text-only 历史预览范围差异），未实跑功能测试。B 安全/故障首轮旧执行因服务错误中断，无结论；父已重开独立主树审查，**本节记录时仍在跑，未取得结论**。E3 自查不替代它，也不新增委派。
- D2 修复和父此前 D 三套 **44/44、skip 0、exit 0、1018.5402 ms** 分属父证据；本次 D 在 alias 内的 44/44 是 E3 自己的另一运行。C feedback/presentation ACK 消费端尚在修改，RD-1–RD-4 **四项仍未关闭 / 待修后完整证据和增量独立复审**；不能凭本次模拟通过解除 Important。
- **完整 canonical：待验证。** 用户指定当前 PR 完整 CI，本批未运行完整 `npm test`、未重新执行完整 `test:ci`；只运行上述必要注册/计划/workflow 守卫和一次 16 叶离线子链。当前尚未 push / 建 PR，无对应 run/attempt/head 或 merge SHA/gate；不得用 P1 的旧 355/355 CI 替代 366 叶新行为证明。
- 未运行真实 Electron、A 攻击专项、真实 Pi/模型、视觉/截图、重建/打包；本线没有 UI 或 public/server 改动，无新增渲染验收和重建义务，不声称产物已更新。A 首轮 **28/29** 失败及后续阻断保留；A2 的普通真实驱动另线收尾，不在本次范围。
- 提交前核对：1223 个被测行为文件摘要与子链运行前后完全一致，aggregate digest `1d55e4a868707106eb8fec8bf85d2b6af56938d0131c140928e0411e5fbfd937`；package SHA-256 `2f76473b77307dc533804c9ac4757dd16dcc41ec71003eb2bd1ed9d352ccad6c`，guard SHA-256 `47cfdf6d8fd5f329d467d42077c6a8af9893e24529fa8073e4d2cce60e5d49b7`。后续父若集成 C 行为，应按新增 diff 补验，不能继承本次 e4468695 + diff 为新 C 全通过。
- 风险与回滚：CI/test 输入按高风险边界保留完整 gate；仅回退 `403e0cf9b4573048e8e87da8952a27781f431323` 可撤销本批四叶/守卫，文档提交可独立回退，不回退父产品/plan。无用户数据、schema 或产物迁移。
- 结论分层：**E3 测试链收尾开发完成；产品整体验收未通过；完整 canonical / B 安全审查 / C-D 复审仍待验证；无合并或发布许可**。仅本地提交，不 push、不 PR、不 merge、不 tag、不 release。
