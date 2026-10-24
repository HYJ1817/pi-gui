# G2 CI 证据、性能与 Electron smoke 验收材料

日期：2026-10-24。**本地交付已具备，完整 G2 验收待真实 PR CI 和独立审查。** 依 [REVIEW](../REVIEW.md) 为高风险 CI 基建变更；不以作者自查代替独立功能/安全审查或用户合并授权。

## 身份、基线与范围

- before HEAD：`e97ecf36f5bc2babdcd9785f9efbf9324ff34326`，执行前 fetch 后的最新 origin/main，含 G1/T4-C；[main push CI 40065343782](https://github.com/HYJ1817/pi-gui/actions/runs/40065343782) attempt 1 最终成功。开始勘察时它仍 in_progress，完成后才登记成功；不是 G2 CI。
- 分支：`codex/g2-ci-evidence-electron`；独立 Worktree：`C:\Users\21022\.codex\worktrees\g2-ci-evidence-electron\pi-GUI`，从上述 main 创建且初始干净。主工作区和 T4-C 工作树均未操作；没有子 Agent。
- 行为/测试提交：`5e36a1991732e7d545b6f5040056fc4b25224093`。下列本地命令覆盖该提交的文件树，运行时是 before HEAD 加对应工作树 diff，随后提交未改变这些字节。
- after HEAD：包含本报告的文档/证据提交，用 `git log -1 --format=%H -- docs/G2-acceptance.md` 定位，最终交付消息固定实际完整 SHA；后续报告修订应保留本次身份。
- 用户授权仅含本地修改、测试和提交；本轮未 push/建 PR、合并、删分支、修改仓库设置、tag 或 Release。Jev 分类仅作建议，CI 边界按 REVIEW 高风险处理。

| 文件 | 作用 |
| --- | --- |
| [run-test-group.mjs](../scripts/run-test-group.mjs) | 复用既有执行器，增加逐步持久化及信号/退出收口 |
| [ci-results.mjs](../scripts/ci-results.mjs) | schema v2、计划摘要、原子写入、v1 只读兼容 |
| [summarize-ci-results.mjs](../scripts/summarize-ci-results.mjs) | 精确身份/集合校验、状态与慢项汇总、Markdown/JSON、缺失证据非零 |
| [report-ci-history.mjs](../scripts/report-ci-history.mjs) | 只读 gh API 采样与可离线复算的统计 |
| [ci.yml](../.github/workflows/ci.yml) | 保留五组/原 gate，always 上传、分组及最终 Summary、7 天结构化证据 |
| [package.json](../package.json) | 三个基建回归进入原 test:ci；新增独立 test:electron-smoke |
| [ci-test-plan.cjs](../tests/ci-test-plan.cjs)、[ci-workflow.cjs](../tests/ci-workflow.cjs) | 保留旧检查语义，补 T4-C 分组、schema v2 和实际 PowerShell gate 矩阵 |
| [ci-results.cjs](../tests/ci-results.cjs)、[ci-summary.cjs](../tests/ci-summary.cjs)、[ci-history.cjs](../tests/ci-history.cjs) | 隔离中断/失败/原子替换、汇总 CLI、统计边界回归 |
| [electron-smoke.cjs](../tests/electron-smoke.cjs)、[fixture](../tests/fixtures/g2-electron-smoke.cjs) | 复用现有桌面模块和假 Pi 的最小 smoke 及进程身份收尾 |
| [性能报告](G2-ci-baseline.md)、[结构化聚合数据](G2-ci-baseline.json) | 20 个真实历史 run、22 个 attempt，非本轮新代码证明 |
| [桌面结果](evidence/g2/results.json) 与同目录 4 PNG | 正常沙箱、真实几何/原生页面/模态和退出证据 |
| [testing.md](testing.md)、[README.md](README.md)、本报告 | 口径、命令、导航及授权边界 |

## 证据 schema 与中断语义

v2 组记录含 group、sha、runId、runAttempt、event、nodeVersion、os、arch、planDigest、planTotal、startedAt、updatedAt、finishedAt、completedCount、status、results。
sha 为 Actions `GITHUB_SHA`（PR 可能是 merge ref）；本地可从 Git HEAD 读取，未知仍为 null。计划摘要为完整有序 canonical 命令和分组的 SHA256，不维护第二份执行清单。

每个叶记录含 index（从 1 开始）、command、startedAt、finishedAt、durationMs、exitCode、signal、error、status。初始化即写全计划 pending；开始前 running；终态为明确 passed/failed/cancelled/interrupted，skipped 仅保留显式状态语义，本实现不自动跳过任何叶。

| 隔离 fixture 的观测 | 保存的状态与计数 |
| --- | --- |
| 第一条已结束、第二条仍挂起 | group running；`[passed, running, pending, pending]`，completedCount 1 |
| 第二条结束后第三条退出 17 | group failed；`[passed, passed, failed, pending]`，completedCount 3；下一条从未执行 |
| 强杀执行器树 | 文件仍为有效 JSON；第一条 passed、第二条仍未完成；重复读取不改写，不补成 passed |
| 处理 SIGINT | 第一条 passed、第二条 cancelled/signal SIGINT、其余 pending；执行器退出 130 |
| 全部完成 | 仅所有叶有明确成功终态后写 group passed 和 finishedAt |

保存使用同目录唯一临时文件、文件 fsync、rename 替换；Windows 替换失败时不先删除旧文件。EPERM 注入实测旧 JSON 字节完整保留。持久化失败会使执行器非零退出，不能伪装成功。不能保证断电或不可处理强杀时执行收尾，也不能保证 GitHub 硬取消后 upload step 有机会运行；缺失 artifact 保持缺失/未完成，不能通过证据检查。

v1 的数字 status 映射到 exitCode 和明确叶终态，可只读解析；没有 finishedAt 的组为 interrupted。v1 缺少 run attempt/完整计划摘要，不认证为本次完整证明。未知 schema 拒绝。新结果不倾倒环境变量、命令 stdout、用户正文或模型请求；错误仅保留结构代码，汇总不输出任意 error payload。

## CI 汇总与 gate

现有测试顺序、组内串行、五个独立 runner、TEMP/端口隔离、失败短路及执行器“成功 0 / 失败非零”保持。每组仍 always 上传 `test-results-<group>/results.json`，保留 7 天；随后在 Step Summary 展示局部证据。

原 `CI gate` 仍 needs `[test-plan, test, build-check]` 且 always；原 PowerShell 逐项 `success` 检查原文保留并在失败后也执行。增加下载组证据、精确 SHA/run/attempt/计划/顺序校验和汇总上传，必要结果缺失或身份不匹配时非零；汇总生成成功不能覆盖任一上游失败。没有 continue-on-error、自动重试、额外测试分组或 Release gate 修改。

汇总分开给每组状态/耗时/完成数，失败/中断/取消、未执行和显式 skip，最慢 10 条及退出信息、完整性和无终态记录；错误身份的“passed”不会计入本次成功数。测试时间跨度与叶耗时有明确字段；Actions runner/wall/排队/重跑等待若缺少可用元数据则 unavailable，不估成 0。历史统计按 job/attempt 时间戳另行计算。CLI 真实 fixture 已验证完整 artifact 退出 0、缺一个组退出 1，原 PowerShell gate 的 15 种输入组合实际运行，不能仅靠 YAML 字符串认定远端正确。

## Canonical 集合及本地验证

使用现有 `createTestGroupPlan` 比较 before HEAD 的 package 和交付树：旧 193 条全部按原顺序保留且组别相同，无删除/重复；新增恰为 `ci-results.cjs`、`ci-summary.cjs`、`ci-history.cjs`，共 196 条。core 120（原 117）、ui 24、security 27、native 4、faults 21。分组脚本未改；原 Native、SACL/DACL、故障、T4-C 采纳/恢复断言均未修改。

| 命令/检查 | 实际结果 |
| --- | --- |
| `git diff --check`、`git diff --cached --check` | 退出 0 |
| `node scripts/run-test-group.mjs --validate` | 退出 0，196 leaves，五组 120/24/27/4/21 |
| `npm run test:ci` | 退出 0，7 套件完成；持久化 10/10、汇总 19/19、历史统计 21 条断言、实际 gate 15/15、发布证明 16/16、NSIS fixture 12/12；失败 0，无新增 skip |
| canonical 原集合逐项对照 | 退出 0，193 条旧命令同序、同组；版本/依赖对象一致；锁文件和产品源码无 diff |
| 文档与证据检查 | 162 个本地 Markdown 路径有效；20 run 身份唯一/22 attempt；4 PNG 非空，JSON 结果 sandbox/失败数/残留数匹配 |
| `node scripts/report-ci-history.mjs --repo HYJ1817/pi-gui --limit 20 --output <TEMP报告>` | 退出 0，20 unique run / 22 attempt；未触发新运行 |
| `--input docs/G2-ci-baseline.json --output <临时报告>` | 可按固定样本复算；只读输入、聚合输出，无原始日志入仓 |
| `npm run test:electron-smoke`（显式私有同版本 Electron，见下文） | 最终退出 0，10/10；正常沙箱，无 renderer error；观测 11 个本次进程身份，残留 0 |

旧 `ci-test-plan` 的“失败后只运行一条”和“子退出码 17”断言语义保留：v2 全计划长度改为 2，另断言仅一个 startedAt、exitCode 17、failed/pending 状态，断言未减少。基建统计场景均在临时目录；真实仓库只读检查。基线成功 CI、历史样本和本地定向不能替代本轮完整 canonical。

## Electron 真实证据与失败历史

Windows x64、Electron 44.4.3（内嵌 Node 24.21.0）、宿主 Node 24.22.1；正常 sandbox/contextIsolation，nodeIntegration false，无 `--no-sandbox` 或外部 CDP 端口。使用 os.tmpdir 临时 Git、假 Pi 包/shim、隔离 home/userData 与白名单子进程环境；生产后端、renderer/CSS、preload、Browser 控制器和 Agent 宿主均实际执行。只访问本地 loopback 页面，不读取真实账号、不调用模型或修改已安装应用。

复用评估：现有 candidate/review-comment/browser-workbench 专项已有正常沙箱、真实后端或原生 Browser/geometry/生命周期框架；另一些旧专项显式 no-sandbox，不能继承其资格。G2 复用既有 Browser/Agent 宿主、父进程关闭 IPC 与 candidate-pi fixture；未改写大型历史专项，也不宣称其全量场景由 smoke 覆盖。

- 第一次默认共享 Electron 路径启动，进场景前异常退出 `2147483651`；`electron --version` 亦同样失败。没有把它记为 sandbox 通过。
- 将本机既有 dist 原样复制到 `%TEMP%\pi-gui-g2-electron-44.4.3`，两个 electron.exe SHA256 均为 `BF0FE749904CA9F713CCFB2427C519FA39D0BBD0337BA411BA08785802E8D548`；显式 `ELECTRON_OVERRIDE_DIST_PATH` 后版本和正常沙箱启动成功。未下载依赖、未改原路径、未降低 sandbox。原因定位到运行目录相关环境差异，不推断已证明 Windows 根因或默认路径也通过。
- 第二次场景本身通过，但 fixture 漏装 Browser Agent IPC 宿主并出现后端退出超时；补装既有宿主，沿生产父进程专用 prepare/shutdown IPC 关闭 owned guardian 后收口，不再依赖强杀作为成功退出证据。
- 修复后三次连续 10/10；随后补原生页面独立截图和启动失败记录，最终同一代码树再次 10/10，残留 0。没有通过自动重试掩盖失败；每次均保留本机独立输出目录（evidence-1 为启动失败、evidence-2 为收尾失败、最终为 evidence-final）。

最小入仓证据：[1200px 父窗口](evidence/g2/smoke-1200.png)、[760px 父窗口](evidence/g2/smoke-760.png)、[真实原生页面](evidence/g2/smoke-native.png)、[模态遮挡](evidence/g2/smoke-modal.png)、[结构化结果](evidence/g2/results.json)。parent capturePage 不含原生子页面像素，所以两者分别保留，未合成截图。实际 nativeBounds 与 CSS viewport×zoom 误差不超过 1 像素；关闭后旧 webContents 销毁，重开新 generation 且 URL 为空。进程收尾用 PID+CreationDate 核对本次进程家族，避免单凭 PID 重用作结论。

当前没有降级交互通过记录；不支持的平台或启动失败为 environment-blocked/未验证，非零退出。GitHub Windows runner smoke 稳定性尚未验证，故保留 `test:electron-smoke` 专项入口，暂不改现有 build-check 或新增不可靠 required job。后续授权远端阶段可按最小路径评估，不能将本地三次成功宣称为远端稳定通过。

其他首轮回归：新增模块尚未实现时测试报 ERR_MODULE_NOT_FOUND；workflow 新增汇总守卫先失败，再接入实现；汇总补测暴露错误身份仍计入 passed 数、历史补测暴露 skipped 时间戳被当执行耗时，均已修复并重跑通过。没有删除安全断言或将失败改 skip。

## 性能、限制与最终状态

[性能基线](G2-ci-baseline.md) 分开记录 20 个真实 run、22 attempt、首次成功 90%、失败 5%、取消 5%；security 中位 1117 秒最高，faults 均值受一次 cancelled 长尾影响。一个失败有 pi_connect_timeout、另一个取消 run 有 stop_unconfirmed 症状；根因与取消来源仍 unknown，不伪造产品/环境分类。P90/P95 是小样本经验值，Electron 首次 attempt 耗时样本仅 18，分位数 unavailable。

完整本地 `npm test` 未运行：本任务要求真实更新后 PR CI，授权边界又禁止当前推送/建 PR；本轮完成本地定向与静态验证后按附件第十四节停止，请求后续推送授权。G2 新代码的真实 artifact 上传、GitHub Summary、取消后的部分 artifact 和最终 CI gate、完整 canonical 均**待远端验证**。没有新 G2 run URL，不能借用 main `40065343782` 冒充。后续取得授权后须记录首次远端失败/修复/attempt、实际 artifact、精确 SHA/merge ref 和全部检查，再补最终证据。

作者增量自查未发现可证实的未解决 Blocker/Important；独立功能与安全审查均待执行（遵守一个 Coding Agent 约束）。本轮不改产品、安全写入实现、Pi RPC、版本/依赖、Release workflow/gate、Rulesets 或保护规则；没有提前实施 G3。G3 候选仅为 guardian/Stop 诊断、Native 细粒度计时及有隔离证明后的调度评估，未实现。

回滚边界：经授权先 revert 本报告所在文档/证据提交，再 `git revert 5e36a1991732e7d545b6f5040056fc4b25224093` 撤销 CI、脚本和测试；保留后续无关改动。无用户数据迁移或安装恢复，不使用全仓 reset/clean。

开发本地交付：具备；G2 最终完成/代码验收：待真实 PR CI 与独立审查；允许合并：未授权；正式发版：不需要，未授权。此处停止，等待推送及后续独立验收指令。
