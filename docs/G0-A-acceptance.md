# G0-A 开发流程与规则入口优化验收

日期：2026-10-22。范围：开发规则与文档导航；不改变产品、测试脚本、workflow 或发布机制。

## 基线与核心对照

- 基线：`578d8c9daa6c5c3334ce7d6e74bdddcf00b3c8bf`，fetch 后最新 `origin/main`。
- 分支：`codex/g0-a-governance`；独立 Worktree：`C:\Users\21022\.codex\worktrees\g0-a-governance\pi-GUI`。
- 基线 main push [CI 39643761771](https://github.com/HYJ1817/pi-gui/actions/runs/39643761771) 已完成且成功（attempt 2）；仅证明基线，不是本轮文档提交的 CI。
- 最新公开 Release 为 `v0.27.0`；本轮不修改版本。

| 修改前 | 修改后 |
| --- | --- |
| 入口要求读 docs，仍写“9 篇” | 每次必读 AGENTS / REVIEW，通过任务导航选择业务文档 |
| 开发前默认完整 npm test | 准确基线 CI + 必要定向测试；无可信基线或高风险边界补完整基线 |
| 开发过程和最终证明时机不够明确 | 开发循环定向、稳定后完整证明；用户可预选 PR CI，完成前标为待验证 |
| 完整验证后的复用边界不够明确 | 同一状态不无故重复；行为变化补验，历史验收不替代新代码证据 |
| development 含另一套发版步骤，testing 有旧 Release 表述 | releasing 为唯一正式步骤；校准精确 SHA 复用、installer 条件及授权 |
| 开发/验收/合并/发布容易混用 | REVIEW 分别定义结论，测试和审查不授予合并或发布许可 |

## 修改文件

- [AGENTS.md](../AGENTS.md)、[REVIEW.md](../REVIEW.md)：入口、测试政策引用、授权和验收结论；AGENTS“硬约束”整节与基线文本一致。
- [README.md](README.md)：新增任务阅读导航，区分当前设计、历史计划和阶段验收。
- [development.md](development.md)、[testing.md](testing.md)、[releasing.md](releasing.md)：校准执行时机、证明及实际命令，去掉重复发版清单。
- [architecture.md](architecture.md)、[work-surfaces.md](work-surfaces.md)、[reviews.md](reviews.md)：仅必要职责说明、历史范围与交叉引用。
- 本报告；共 10 个 Markdown 文件。

## 验证

- `node scripts/run-test-group.mjs --validate`：退出 0，169 个 canonical leaves；core 98 / ui 24 / security 27 / native 2 / faults 18。是清单校验，不是执行 169 套件。
- `npm run version:check`：退出 0，package/lock 均为 0.27.0，发布摘要一致；版本文件未修改。
- 自包含 Python 检查（标准库、内联执行）：10 个变更文档，210 个本地链接/锚点，问题 0；41 个引用的 npm script 名称全部存在。只核对本地文件与锚点，不访问外部链接。
- PowerShell AST 静态解析发布手册的 4 个 PowerShell 代码块：语法错误 0；未执行其中的发布命令。
- `git diff --check`：退出 0；修改范围白名单检查通过，AGENTS 硬约束全文比对一致。
- 完整 `npm test`、产品构建、Electron/安装/发布：未运行。修改前生效的 AGENTS 第二节第 3 条已允许纯文档变更说明原因后跳过，本轮仅改治理文档，无产品或测试行为变更。
- 手动命令静态核对 package scripts、测试编排、CI/release/release-check workflows 及 release-check/verify-ci-proof/publish-release 脚本；没有执行推送、tag、安装或发布命令。

## 独立审查

独立上下文只读审查（`g0a_independent_review`）结论：通过，未发现可证实的阻断问题。
Blocker 0 / Important 0 / Nit 0 / Pre-existing 0；发现明细：无。
覆盖基线之上的 10 个 Markdown 文件，核对授权、安全硬约束、测试策略、发布实际脚本和导航。
审查者复核 210 个相对链接（含 15 个锚点）、4 段 PowerShell 语法及 diff 检查均通过；
未运行产品测试或联网重查远端事实，远端基线事实由作者另行核验。
审查后仅补齐本报告的验证与审查记录，未更改已审查的规则正文。

## 后续事项与回滚

验收归档政策、代码规模规范、CI 性能与证据改进、桌面专项自动化及 GitHub 强制门，留给后续独立阶段；本轮未实施这些行为。

本轮文档范围验收通过；本地提交按一个文档回滚边界保留，未授权推送、合并、tag 或发布。
合并前仍按 REVIEW 验收当前范围，本报告不声称本轮文档提交已运行远端 CI。
回滚时回退本轮文档提交即可，不涉及数据迁移或产品产物；保留后续无关改动，不用全仓 restore。
