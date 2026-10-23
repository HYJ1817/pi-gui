# G1 日常开发交付规范验收材料

日期：2026-10-24。风险：依 [REVIEW](../REVIEW.md#2-按变更风险决定审查力度) 为中：新增只读开发工具和其 canonical 测试入口，不改变产品运行时、权限、数据或发布行为。

## 身份与范围

- before HEAD：`fbbaec7ab7998b5cb7cf08bb185b3287121194e1`。执行前已 `git fetch origin --tags`，`origin/main` 解析为该提交；其 [main CI 39976770700](https://github.com/HYJ1817/pi-gui/actions/runs/39976770700) 成功，只证明基线，不作为 G1 提交的 CI 证据。
- 分支与工作树：`codex/g1-development-workflow`，`C:\Users\21022\.codex\worktrees\g1-development-workflow\pi-GUI`；从最新 `origin/main` 建立，初始干净。主工作区的既有未跟踪文件未触及。
- 工具与测试提交：`fce305c`（`新增文件规模报告工具与隔离测试`）。最终 after HEAD 定义为“包含本报告的文档交付提交”，在提交后用 `git log -1 --format=%H -- docs/G1-acceptance.md` 精确解析；最终交付消息另列完整 SHA。
- 本轮不改产品 Runtime、Git 写入/恢复边界、workflow、Release/tag、版本号、依赖或锁文件；不进入或修改 T4-C 工作树。

| 文件 | 交付 |
| --- | --- |
| [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md) | 可被 GitHub 识别的日常 PR 模板 |
| [.editorconfig](../.editorconfig) | 后续编辑的基础格式约定与兼容例外 |
| [scripts/report-file-size.mjs](../scripts/report-file-size.mjs) | 原生 Node.js、只读的已跟踪文件规模报告 |
| [tests/file-size-report.cjs](../tests/file-size-report.cjs) | 隔离临时 Git fixture 的端到端测试 |
| [package.json](../package.json) | `report:files`、可重复测试命令及 canonical 注册 |
| [README.md](README.md) | 日常交付工具与本报告的导航 |
| 本报告 | G1 证据、历史案例演练与回滚范围 |

## PR 模板与 EditorConfig

模板共 50 行，按 [acceptance.md](acceptance.md) 的证据结构和 [REVIEW.md](../REVIEW.md) 的既有门槛组织：目标与范围、低/中/高风险、可复核验证表、Blocker/Important 与独立审查、残余风险与回滚、开发/验收/合并/发布的分离状态。它明确“勾选不授予 Agent 推送、合并或发版权限”，不复制整套治理规范。

`.editorconfig` 共 33 行，仅约束未来编辑：默认 UTF-8、LF、末尾换行和清理行尾空白；JS/CJS/MJS 与 JSON/YAML 为 2 空格；Markdown 保留行尾空白以支持硬换行。`.cmd`/`.bat` 保持 CRLF。PowerShell 默认 UTF-8/2 空格；`server/session-revert-object-write-native.ps1` 单独保留 CRLF、原始末尾换行和空白，因为 `.gitattributes` 已声明其资源 hash 绑定实际字节。

执行前抽样的现有文件均为 UTF-8 无 BOM、LF；唯一需保持 CRLF 的上述 native helper 有 98 个 CRLF。没有修改 `.gitattributes`、没有格式化历史文件、没有新增 Prettier/ESLint，也没有更改签名或发布产物。

## 文件规模报告

命令：`npm run report:files`，可加 `--json` 供自动化读取；增量比较只接受明确的 `--base <Git SHA/标签/ref>`，不会猜测本地分支。工具只从 `git ls-files -z` 获取已跟踪清单，读取 `server/`、`public/`、`lib/`、`electron/`、`scripts/`、`tests/` 和 `server.js`，不递归扫描工作盘；对符号链接使用 `lstat` 并跳过，不跟随目标。

业务 JS/CJS/MJS 适用 [代码规范](coding-style.md#文件规模软阈值) 的物理行软提示；CSS、测试、fixture 分开统计，不套用业务阈值。`node_modules`、构建/覆盖率目录、Git 内部目录、`dist-*` 和 `generated` 目录排除。超过 500/800/1000 行分别提示职责检查、拆分或解释、明确例外，始终退出 0；Git、参数、文件读取或工具故障才非零退出。

以 before HEAD 为 `--base` 实测：扫描 573 个文件，业务代码 268 个/69,581 行，测试 264 个/73,050 行，fixture 30 个/3,594 行，CSS 11 个/5,526 行；业务文件超过 500 行 38 个、800 行 16 个、1,000 行 12 个。提示均为软告警。

建议关注的历史大文件在该基线的实测物理行数如下，均显示 `historic: true`、增长 0；本轮不重构：

| 文件 | 行数 | 基线说明 |
| --- | ---: | --- |
| `server.js` | 1,304 | 后端组合与接线 |
| `public/app.js` | 1,352 | 前端启动与事件路由 |
| `electron/main.cjs` | 908 | Electron 宿主生命周期 |
| `lib/git.js` | 1,017 | 有界 Git 与路径边界 |
| `public/git.js` | 1,859 | Git 工作区界面逻辑 |
| `public/planner.js` | 2,433 | Planner 交互与状态逻辑 |

## 验证

| 证据层 | 命令/范围 | 实际结果 |
| --- | --- | --- |
| TDD 首次失败 | `node tests/file-size-report.cjs`（工具尚未创建） | 退出 1，`MODULE_NOT_FOUND`；随后实现脚本，不把这次预期失败记为通过 |
| 本地定向 | `npm run test:file-size-report` | 退出 0，11/11；覆盖普通/无末尾换行、CRLF/LF、UTF-8、空格/中文路径、分类与生成目录、历史和新增大型文件、JSON、参数/Git 错误及无写入 |
| 工具实测 | `npm run report:files -- --base fbbaec7ab7998b5cb7cf08bb185b3287121194e1` | 退出 0；573 文件及上述软告警数量；未改源码 |
| JSON 实测 | `node scripts/report-file-size.mjs --json --base <before HEAD>` | 退出 0；PowerShell `ConvertFrom-Json` 成功，最大文件和 `baselineLines`/`growth` 可读 |
| canonical 清单 | `node scripts/run-test-group.mjs --validate` | 退出 0，185 leaves：core 114、ui 24、security 27、native 2、faults 18；新测试自动归 core，未修改 workflow 分组 |
| CI 结构定向 | `npm run test:ci` | 退出 0；测试计划 185 leaves/5 组精确覆盖，CI workflow 静态核对通过，release CI proof 16/16、NSIS bootstrap 12/12 |
| 格式与范围 | `git diff --check`、UTF-8/LF/末尾字节检查、`package.json` JSON 解析、102 个本地 Markdown 链接检查 | 均退出 0；新增模板 50 行、EditorConfig 33 行；无 BOM/CRLF 格式噪音 |

完整 `npm test`、产品构建、Electron/安装/发布、PR CI 和 G1 main CI：未验证（未运行）。本轮只改治理材料和只读开发工具；定向 fixture 测试和 canonical 清单已覆盖新增行为，任务也明确不必为此重建 Electron、SEA 或安装包。基线 main CI 不替代本轮验证。

## 历史案例演练

这是**历史案例演练**，不是本轮新 PR、提交或 CI。以 G0-B 的文档治理提交 `d018743e73128cee682d055be610f6317fd0571e`、合并提交 `fbbaec7ab7998b5cb7cf08bb185b3287121194e1` 和 [PR #23](https://github.com/HYJ1817/pi-gui/pull/23) 填写模板：范围是代码规范、验收材料和导航；明确未改产品、CI、Release；风险为低。其验收记录可定位定向文档检查、`git diff --check`、独立只读审查（Blocker 0 / Important 0）以及未运行的完整 canonical、PR CI、产物检查；回滚是经授权 revert 对应文档提交，无数据恢复。

演练确认提交 SHA、测试结果、独立审查证据、未运行项、版本影响和回滚都能在模板中简洁表达；普通文档修改可把无关运行态项目写“不适用”，无需虚构 CI。模板未因演练调整，也不把审查通过写成合并授权。

## 并行协调、限制与结论

- T4-C 当前独立头为 `2dfde86`。相对 before HEAD，其会修改 `docs/README.md`、`package.json`、`scripts/`、`tests/` 等路径；本轮与其同文件重叠为 `docs/README.md` 和 `package.json`。最小协调方案是在合并时保留 T4-C 的候选写入测试/脚本注册，并追加本轮一条导航、G1 链接、`pretest` 中的文件规模测试和 `report:files`；按当时最新 diff 逐块合并，不能整文件覆盖。
- 未发现本轮要处理的 T4-C 产品冲突；未进入其工作树、未改其断言或文档。
- 不新增依赖、Git hook、严格模式或强制规模 gate；报告不阻断提交、PR 或合并。没有产品、CI workflow、Release、版本、锁文件或用户数据影响。
- 回滚：工具边界可经授权 `git revert fce305c`；文档边界回退包含本报告的最终 G1 文档提交。保留后续无关改动，不使用 `reset --hard`、`clean` 或全仓 restore；无需数据兼容或用户文件恢复。
- 开发完成：是。代码验收：待独立验收（用户要求只使用一个 Coding Agent，故本轮没有把作者自查冒充独立审查）。合并许可：未授权。发布许可：未授权。

作者判断：G1 已满足 PR 模板、EditorConfig、只读规模报告、隔离测试、历史案例演练和证据归档的完成标准；停止在本地提交，等待独立验收，不进入 G2。
