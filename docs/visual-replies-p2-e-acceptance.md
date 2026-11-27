# Visual Replies P2 · E：规范测试链与 CI 验收

日期：2026-11-27。总体逐项覆盖与真实样例矩阵见 [覆盖索引](visual-replies-p2-coverage.md)。
本报告只证明 E 的测试基建，不代表 A–D 已集成、真实 Visual Replies 已验收或允许发布。

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
3. D 已通知的 `html-artifact-layout.cjs`、`html-artifact-frame.cjs`、`html-artifact-reading.cjs` 在本次 E worktree 尚不存在，**本次未注册、未运行**。这些命名在集成后归 ui。C 的既有 UI 入口保持。
4. `ci-html-artifacts` 会发现新增离线文件并要求在 Artifact alias 和完整链各恰好出现一次；缺注册/重复注册均失败。`--validate` 会拒绝尚不存在的文件，包括 `node --test` 的第二个及以后文件。
5. 集成者运行 `node scripts/run-test-group.mjs --validate --list`、`npm run test:html-artifacts`、`npm run test:ci`，重新记录真实数字、skip、新计划摘要和必要回归；不能沿用本线 358 叶数字为集成后的结果。
6. 完整 canonical 由当前 PR CI 覆盖最终代码状态；独立功能/安全审查由父任务另派新上下文。本线自查不是独立通过。

## 7. 风险、回滚与结论

- 风险：高（涉及 CI/test plan），未削弱主 gate、权限或产品隔离；真实沙箱未完成仍为阻断，完整新计划远端结果 pending。
- 回滚：E 原分支可 `git revert e67b0211623d23a17fb8486a3731509a79d86fb7` 回退本线测试基建；父集成若 cherry-pick，以映射后的 E 提交为回滚对象。报告/索引独立提交可独立回退。没有用户数据、存储 schema 或产物迁移需要恢复。
- 开发：E 规范链/守卫/入口已完成；D 等未来注册仍需集成复检。
- 代码验收：待当前 PR canonical、独立功能/安全审查及真实边界证据；不标整体通过。
- 合并/发布：未获本线授权；本线不 push、不创建 PR、不 merge、不 tag、不 release。
