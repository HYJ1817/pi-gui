# 开发文档导航

每次任务必读 [AGENTS.md](../AGENTS.md) 和 [REVIEW.md](../REVIEW.md)，再按下表选择相关文档。
先核对当前代码和调用边界，复用既有模块；无需无差别通读全部文档。

## 规则与文档职责

| 入口 | 职责 |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | 开发规则、安全硬约束与操作授权 |
| [REVIEW.md](../REVIEW.md) | 代码审查、验收结论与合并门槛 |
| [architecture.md](architecture.md) | 系统结构、依赖方向、状态归属与模块地图 |
| [development.md](development.md) | 日常开发与构建 |
| [testing.md](testing.md#测试执行政策) | 测试执行政策、分层与证据范围 |
| [releasing.md](releasing.md) | 唯一正式发版流程与发布证明 |
| [reviews.md](reviews.md) | 产品内 Planner 的人工审阅功能，与仓库代码审查不同 |

## 按任务选择

| 任务 | 优先阅读 | 按影响追加 |
| --- | --- | --- |
| UI 与布局 | [工作区与生命周期](work-surfaces.md)、[应用外壳](app-shell.md) | [会话界面](conversation-ui.md)、[输入区](composer-ui.md)、[能力展示](capability-ux.md) |
| Git Changes 与 Diff | [Git Changes](git-changes.md)、[工作区](work-surfaces.md) | [架构](architecture.md)、[安全](security.md)；行级评论当前设计见 [持久化说明](git-changes.md#九行级评论持久化t3-b)，历史 [T3-A 验收](T3-A-acceptance.md) 与 [T3-B 验收](T3-B-acceptance.md) 仅证明各自提交 |
| Planner、Review、Verification | [Planner](planner.md)、[工作流与数据契约](workflows.md)、[人工审阅](reviews.md) | [审批](approvals.md)、[测试政策](testing.md#测试执行政策) |
| Runtime、Worktree、多会话 | [会话](sessions.md)、[Worktree](worktrees.md)、[架构](architecture.md) | [运行恢复](runtime-recovery.md)、[进程管理](p31-managed-process.md)、[安全](security.md) |
| Browser 与 Electron | [Browser](browser.md)、[Agent Control](agent-browser.md)、[工作区](work-surfaces.md) | [架构](architecture.md)、[安全](security.md)、[构建](development.md) |
| 安全、路径及权限 | [安全](security.md)、[架构](architecture.md) | [审批](approvals.md)、相关功能的写入/恢复设计；历史 P33 材料见下文 |
| CI 与测试 | [测试政策与分层](testing.md)、[开发构建](development.md) | 当前 `package.json`、`scripts/test-group-plan.mjs`、`scripts/run-test-group.mjs` 和相关 workflow/测试；不从旧验收报告抄测试清单 |
| 安装、更新及发布 | [发版](releasing.md)、[更新](updates.md)、[应用内更新](windows-in-app-update.md) | [构建](development.md)、[签名](code-signing.md)、[兼容升级](upgrade-playbook.md)、[安全](security.md) |
| Pi、供应商与扩展兼容 | [Pi 兼容](pi-compatibility.md)、[兼容升级](upgrade-playbook.md) | [供应商认证](provider-auth.md)、[MCP](mcp.md)、[扩展](extensions.md)、[项目配置](project-config.md) |

## 当前设计、历史方案和验收记录

- **当前设计入口**是上表中的功能文档。文档若包含历史段落，先读其当前实现说明，再核对正在使用的代码与边界。
- **历史方案**记录当时的设想，不代表已实现或已批准。例如 [P32 设计探索](p32-design-spike.md)、[T2-B 计划](T2-B-plan.md)、[Windows 更新计划](windows-in-app-update-plan.md)。
- **验收记录**绑定当时的提交、环境和验证范围。例如 [T2-A](T2-A-acceptance.md)、[T2-B](T2-B-acceptance.md)、[T3-A](T3-A-acceptance.md) 和 [CI 优化验收](ci-optimization-acceptance.md)。其中的数字和通过结论不能直接用于新的行为提交。
- **P33 写入/撤销边界**涉及长期安全资格：[安全回退设计](p33-1-safe-session-revert-design.md)、[安全验证记录](p33-4b-safety-validation.md)、[后续安全契约提案](p33-4d-security-contract-proposal.md) 与 [D6 最终验收](p33-d6-final-acceptance.md) 均保留各自阶段范围。后续修改须沿代码核对当前资格，不能凭设计或旧报告推定已开放写入能力。

本导航只提供阅读路径，不赋予推送、合并、修改仓库设置或发布权限；授权以 [AGENTS.md](../AGENTS.md) 为准。

Diff 区间评论的当前语义与 v1 兼容见 [T3-C 功能说明](git-changes.md#十多行区间评论t3-c)，
[T3-C 验收](T3-C-acceptance.md) 仅证明对应提交；不替代后续提交的验证。
