# CI 性能优化审计

## 结论

基线提交为 `cbcd6c21a147fb71946af61e2ea16a94973b0a9f`。本审计在 Windows、Node.js 24.14.0 下按
`package.json#scripts.test` 递归展开并串行执行，共 143 个叶子套件，全部退出码为 0，
实测总耗时 52.8 分钟。

最新成功 CI 实际墙钟为 55 分 46 秒：Node 24 的 `npm test` 为 46 分 14 秒，
Node 22 为 53 分 11 秒，Electron build check 为 1 分 45 秒。两遍完整测试约消耗
102 分 36 秒 runner 时间。Release 的完整预检耗时 63 分 43 秒。

真正需要优先处理的不是 Electron，而是 P33 Native 文件安全链。最慢的 20 个套件如下；
其中故障注入超过 11 分钟、Writer 接近 8 分钟，说明不能把多个 Native 套件放进同一
runner 内并发。

| # | 套件 | 秒 | 组 | 模块 |
|---:|---|---:|---|---|
| 1 | `session-revert-object-faults.cjs` | 699.831 | faults | P33 撤销/Native |
| 2 | `session-revert-object-writer.cjs` | 478.724 | security | P33 撤销/Native |
| 3 | `session-revert-object-runtime.cjs` | 451.052 | security | P33 撤销/Native |
| 4 | `session-revert-object-service.cjs` | 307.287 | security | P33 撤销/Native |
| 5 | `session-change-store.cjs` | 152.299 | faults | P33 会话变更 |
| 6 | `session-revert-object-confirmation.cjs` | 133.719 | security | P33 撤销/Native |
| 7 | `session-revert-inplace.cjs` | 129.365 | security | P33 撤销/Native |
| 8 | `session-revert-store.cjs` | 119.729 | security | P33 撤销/Native |
| 9 | `session-revert-apply.cjs` | 82.094 | security | P33 撤销/Native |
| 10 | `smoke.cjs` | 70.065 | ui | UI |
| 11 | `session-revert-inplace-safety.cjs` | 62.821 | faults | P33 撤销/Native |
| 12 | `worktrees.cjs` | 34.071 | core | Runtime/进程 |
| 13 | `evidence.cjs` | 28.221 | core | 工作流/审阅 |
| 14 | `planner.cjs` | 27.676 | core | 工作流/审阅 |
| 15 | `git.cjs` | 26.304 | core | Git |
| 16 | `session-revert-object-history.cjs` | 23.731 | security | P33 撤销/Native |
| 17 | `runtime-changes.cjs` | 22.579 | core | Runtime/进程 |
| 18 | `review-gate.cjs` | 20.552 | core | 工作流/审阅 |
| 19 | `session-revert-object-recovery.cjs` | 18.331 | faults | P33 撤销/Native |
| 20 | `attempt-lifecycle.cjs` | 16.224 | core | 工作流/审阅 |

## 现有 CI 步骤耗时

数据来自 [CI run 39122342714](https://github.com/HYJ1817/pi-gui/actions/runs/39122342714)：

| Job / step | 实际耗时 |
|---|---:|
| Node 24 checkout | 12s |
| Node 24 setup（缓存） | 13s |
| Node 24 `npm ci` | 21s |
| Node 24 `Run core tests` | 46m14s |
| Node 22 checkout | 15s |
| Node 22 setup（缓存） | 9s |
| Node 22 `npm ci` | 9s |
| Node 22 `Run core tests` | 53m11s |
| Electron build job 总计 | 1m45s |
| Electron packaged app | 12s |
| SEA single-file exe | 11s |

## 分组建议

分组不新增第二份测试清单。统一编排器递归读取 `package.json#scripts.test`；
未知的新套件默认进入 `core`。矩阵只消费编排器输出的组名，作业再用同一编排器执行该组。

| 组 | 套件数 | 串行执行秒数 | 分钟 |
|---|---:|---:|---:|
| core | 73 | 293.2 | 4.9 |
| ui | 23 | 104.7 | 1.7 |
| security | 29 | 1793.8 | 29.9 |
| faults | 18 | 976.0 | 16.3 |

- `core`：普通功能、模型、Provider、日志、Approval、Browser、Runtime 接口、发布守卫。
- `ui`：UI-2/3/4、smoke、主题、DOM 与交互测试。
- `security`：P33 Session Revert、Session Changes、Native Writer、Win32 身份/权限、SACL/DACL 与正式写入边界。组内严格串行。
- `faults`：故障注入、异常退出、句柄占用、恢复、Stop Barrier、Runtime/Owner 生命周期。组内严格串行。

## 并行隔离

每个 matrix 作业使用独立 GitHub runner，因此 PID、句柄、文件身份和端口命名空间互不相交。
作业内再创建独立 `TEMP` / `TMP` / `TMPDIR` 和结果目录；Git fixture 位于该临时根内；
Electron fixture 使用独立 userData；测试启动器只在组内串行执行。固定测试端口变量按组分配；
使用随机端口的套件继续使用 `listen(0)` / `HARNESS_PORT=0`。

P33 Native 不假定可以并发共享目标文件。所有 Native 用例留在同一个串行安全组；
跨组并行只依赖 runner 级隔离，不使用关闭用户进程、共享 Writer 目标或共享可变 fixture 的办法。

## 安全覆盖

以下链路不删除、不转 skip、不扩大超时：Session Revert；Native Writer；Win32 文件身份与
DACL/SACL；会话变更存储；故障注入；Crash Recovery；进程异常退出与恢复；
Runtime/Owner/Stop Barrier；Approval；Browser/Electron 隔离；日志脱敏与 ZIP 导出。
SACL 因权限不足产生的跳过仍由套件自己的输出报告真实分子/分母，编排器不会把它们改写为通过。

## 全量套件耗时表

说明：

- “实际耗时”是本次 Node 24.14.0 串行审计的进程墙钟，不是从文件名推断。
- “Native”表示代码路径检测到文件系统或 Native 操作；不把整个套件误称为纯函数。
- 所有套件都保留 `npm test` 中的原始顺序；组内顺序不变。跨套件没有显式执行依赖；
  若未来新增依赖，必须改成显式 fixture 或编排器依赖，不能靠运行顺序。
- CI 失败时组内按 `npm test` 原有的短路语义停止；成功时必须恰好覆盖下表全部套件。

| # | 套件 | 秒 | 模块 | Native | 独占资源 | Fixture | 顺序依赖 | 并行判断 | 失败安全影响 | 组 |
|---:|---|---:|---|---|---|---|---|---|---|---|
| 1 | `logging.cjs` | 0.396 | 日志/脱敏/ZIP | 是（TEMP） | Electron fixture / loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 2 | `logging-leaks.cjs` | 0.209 | 日志/脱敏/ZIP | 是（TEMP） | loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 3 | `logging-secret-state.cjs` | 0.216 | 日志/脱敏/ZIP | 是（TEMP） | Electron fixture / loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 4 | `logging-client.cjs` | 2.390 | 日志/脱敏/ZIP | 是（TEMP） | loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 5 | `logging-ui.cjs` | 1.432 | 日志/脱敏/ZIP | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 6 | `ui4-approval.cjs` | 5.679 | Approval 权限 | 是（TEMP） | Electron fixture / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 7 | `ui4-feedback.cjs` | 1.493 | UI | 是（TEMP） | Electron fixture / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 8 | `ui4-integration.cjs` | 3.332 | UI | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 9 | `ui3-composer.cjs` | 0.575 | UI | 是（TEMP） | Electron fixture / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 10 | `ui3-model.cjs` | 0.622 | 模型/供应商/能力 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 11 | `ui3-inline-commands.cjs` | 0.571 | UI | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 12 | `ui3-integration.cjs` | 0.943 | UI | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 13 | `ui2-classic.cjs` | 0.688 | UI | 是（TEMP） | Electron fixture / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 14 | `ui2-runtime-display.cjs` | 0.873 | Runtime/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 15 | `ui2-visual.cjs` | 10.795 | UI | 是（TEMP） | Electron fixture / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 16 | `theme.cjs` | 0.534 | UI | 是（TEMP） | Electron fixture | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 17 | `session-revert-fixture-retention.cjs` | 0.113 | P33 撤销/Native | 是（TEMP） | 进程内 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 18 | `session-revert-object-session-binding.cjs` | 0.092 | P33 撤销/Native | 是（TEMP） | 进程内 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 19 | `session-revert-object-d6final-classic.cjs` | 2.830 | P33 撤销/Native | 是（TEMP） | 子进程 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 20 | `exe-diagnostics.cjs` | 0.093 | 发布/构建守卫 | 是（TEMP） | 进程内 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 21 | `session-revert-object-qualification.cjs` | 16.203 | P33 撤销/Native | 是（TEMP） | 进程内 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 22 | `session-revert-object-presentation.cjs` | 0.193 | P33 撤销/Native | 是（TEMP） | loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 23 | `session-revert-object-ui.cjs` | 0.823 | P33 撤销/Native | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 24 | `session-revert-object-confirmation.cjs` | 133.719 | P33 撤销/Native | 是（TEMP） | 进程内 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 25 | `session-revert-sacl-witness.cjs` | 0.759 | P33 撤销/Native | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 26 | `session-revert-object-profile.cjs` | 5.810 | P33 撤销/Native | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 27 | `session-revert-object-evidence.cjs` | 10.215 | P33 撤销/Native | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 28 | `runtime-models.cjs` | 1.624 | 模型/供应商/能力 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 29 | `model-fallback.cjs` | 1.869 | 模型/供应商/能力 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 30 | `model-capabilities.cjs` | 0.718 | 模型/供应商/能力 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 31 | `ux-state.cjs` | 7.636 | Core | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 32 | `bridge-state-recovery.cjs` | 1.154 | Core | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 33 | `native-provider-quota.cjs` | 0.648 | 模型/供应商/能力 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 34 | `stable-session-order.cjs` | 0.155 | 会话/项目 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 35 | `hotfix.cjs` | 0.791 | Core | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 36 | `hotfix-ui.cjs` | 0.954 | UI | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 37 | `provider-auth.cjs` | 1.193 | 模型/供应商/能力 | 是（TEMP） | loopback HTTP/测试端口 / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 38 | `provider-auth-runtime.cjs` | 0.216 | 模型/供应商/能力 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 39 | `ui-ia.cjs` | 1.085 | UI | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 40 | `smoke.cjs` | 70.065 | UI | 是（TEMP） | Electron fixture | 仓库 fixtures（只读） | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 41 | `daily-use.cjs` | 0.104 | UI | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 42 | `git.cjs` | 26.304 | Git | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 43 | `modules.cjs` | 0.182 | Core | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 44 | `reliability.cjs` | 0.149 | Core | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 45 | `interactions.cjs` | 0.519 | Core | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 46 | `sidebar-menu.cjs` | 0.529 | UI | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 47 | `port-owner.cjs` | 0.995 | Core | 否 | loopback HTTP/测试端口 / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 48 | `project-config.cjs` | 0.485 | 会话/项目 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 49 | `skills.cjs` | 0.586 | Skills/扩展/MCP | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 50 | `extensions.cjs` | 0.738 | Skills/扩展/MCP | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 51 | `capability.cjs` | 0.123 | 模型/供应商/能力 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 52 | `capability-install.cjs` | 0.101 | 模型/供应商/能力 | 否 | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 53 | `web-access.cjs` | 0.531 | Skills/扩展/MCP | 否 | Electron fixture | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 54 | `subagents.cjs` | 0.629 | Skills/扩展/MCP | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 55 | `memory.cjs` | 0.544 | Skills/扩展/MCP | 否 | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 56 | `browser.cjs` | 0.514 | Browser/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 57 | `approvals.cjs` | 5.130 | Approval 权限 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 58 | `planner.cjs` | 27.676 | 工作流/审阅 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 59 | `workflow-relations.cjs` | 12.730 | 工作流/审阅 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 60 | `reviews.cjs` | 11.629 | 工作流/审阅 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 61 | `review-gate.cjs` | 20.552 | 工作流/审阅 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 62 | `verification.cjs` | 10.381 | 工作流/审阅 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 63 | `evidence.cjs` | 28.221 | 工作流/审阅 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 64 | `attempt-lifecycle.cjs` | 16.224 | 工作流/审阅 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 65 | `sessions.cjs` | 0.546 | 会话/项目 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 66 | `session-search.cjs` | 1.943 | 会话/项目 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 67 | `pi-compat.cjs` | 0.098 | Core | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 68 | `pi-probes.cjs` | 0.453 | Core | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 69 | `pi-update.cjs` | 0.476 | Core | 否 | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 70 | `pi-version.cjs` | 0.545 | 发布/构建守卫 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 71 | `mcp-native.cjs` | 0.284 | Skills/扩展/MCP | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 72 | `usage-quota.cjs` | 0.571 | 模型/供应商/能力 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 73 | `body-integrity.cjs` | 0.144 | Core | 否 | loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 74 | `dev-server.cjs` | 1.286 | Core | 是（TEMP） | Electron fixture / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 75 | `models-api.cjs` | 1.330 | 模型/供应商/能力 | 是（TEMP） | loopback HTTP/测试端口 / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 76 | `server-security.cjs` | 5.469 | Core | 是（TEMP） | loopback HTTP/测试端口 / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 77 | `diagnostics.cjs` | 0.101 | Core | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 78 | `update-check.cjs` | 0.443 | Core | 否 | Electron fixture | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 79 | `version-consistency.cjs` | 0.136 | 发布/构建守卫 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 80 | `release-artifacts.cjs` | 0.321 | 发布/构建守卫 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 81 | `electron-guard.cjs` | 1.454 | 发布/构建守卫 | 是（TEMP） | Electron fixture / loopback HTTP/测试端口 / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 82 | `gui-browser-policy.cjs` | 0.088 | Browser/进程 | 否 | Electron fixture | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 83 | `gui-browser-controller.cjs` | 5.294 | Browser/进程 | 否 | Electron fixture | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 84 | `gui-browser-bridge.cjs` | 0.362 | Browser/进程 | 否 | Electron fixture | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 85 | `gui-browser-tools.cjs` | 0.151 | Browser/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 86 | `gui-browser-ui.cjs` | 0.530 | Browser/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 87 | `gui-browser-host.cjs` | 0.159 | Browser/进程 | 否 | Electron fixture | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 88 | `gui-browser-stop.cjs` | 0.689 | Browser/进程 | 是（TEMP） | loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 89 | `stop-barrier.cjs` | 0.970 | Runtime/进程 | 是（TEMP） | loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 90 | `managed-processes.cjs` | 0.125 | Runtime/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 91 | `process-tools.cjs` | 0.228 | Runtime/进程 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 92 | `process-stop.cjs` | 0.130 | Runtime/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 93 | `process-ui.cjs` | 1.664 | Runtime/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 94 | `process-runner.cjs` | 0.103 | Runtime/进程 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 95 | `worktrees.cjs` | 34.071 | Runtime/进程 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 96 | `worktrees-http.cjs` | 5.306 | Runtime/进程 | 是（TEMP） | loopback HTTP/测试端口 / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 97 | `worktrees-ui.cjs` | 0.636 | Runtime/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 98 | `runtime-registry.cjs` | 0.289 | Runtime/进程 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 99 | `runtime-http.cjs` | 0.215 | Runtime/进程 | 是（TEMP） | loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 100 | `runtime-store.cjs` | 0.371 | Runtime/进程 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 101 | `runtime-ui.cjs` | 0.524 | Runtime/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 102 | `runtime-nav.cjs` | 7.741 | Runtime/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 103 | `runtime-conversation.cjs` | 0.528 | Runtime/进程 | 否 | Electron fixture | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 104 | `runtime-changes.cjs` | 22.579 | Runtime/进程 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 105 | `runtime-secondary.cjs` | 0.543 | Runtime/进程 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 106 | `runtime-git-ui.cjs` | 0.518 | Runtime/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 107 | `runtime-resources.cjs` | 4.922 | Runtime/进程 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 108 | `runtime-resource-cleanup.cjs` | 0.149 | Runtime/进程 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 109 | `runtime-history-search.cjs` | 10.408 | Runtime/进程 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 110 | `runtime-finish-ui.cjs` | 0.520 | Runtime/进程 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | UI/交互回归；失败即阻断 | ui |
| 111 | `session-runtime.cjs` | 1.128 | Runtime/进程 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 112 | `pi-supervisor.cjs` | 3.214 | Runtime/进程 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 113 | `runtime-browser.cjs` | 0.142 | Browser/进程 | 否 | Electron fixture | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 114 | `process-budget.cjs` | 0.120 | Runtime/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 115 | `runtime-events.cjs` | 0.089 | Runtime/进程 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 116 | `runtime-processes.cjs` | 2.559 | Runtime/进程 | 是（TEMP） | loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 117 | `session-revert-object-assets.cjs` | 2.561 | P33 撤销/Native | 是（TEMP） | Electron fixture / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 118 | `session-revert-object-authority.cjs` | 5.910 | P33 撤销/Native | 是（TEMP） | 进程内 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 119 | `session-revert-object-history.cjs` | 23.731 | P33 撤销/Native | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 120 | `session-revert-object-runtime.cjs` | 451.052 | P33 撤销/Native | 是（TEMP） | 进程内 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 121 | `session-revert-object-store.cjs` | 5.441 | P33 撤销/Native | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 122 | `session-revert-object-service.cjs` | 307.287 | P33 撤销/Native | 是（TEMP） | loopback HTTP/测试端口 / 子进程 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 123 | `session-revert-object-recovery.cjs` | 18.331 | P33 撤销/Native | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 124 | `session-change-store.cjs` | 152.299 | P33 会话变更 | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 125 | `session-change-bridge.cjs` | 0.244 | P33 会话变更 | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 126 | `session-change-tools.cjs` | 0.294 | P33 会话变更 | 是（TEMP） | loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 127 | `session-revert.cjs` | 0.111 | P33 撤销/Native | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 可与其他 runner 独立并行 | 核心功能/发布守卫；失败即阻断 | core |
| 128 | `session-revert-store.cjs` | 119.729 | P33 撤销/Native | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 129 | `session-revert-http.cjs` | 4.394 | P33 撤销/Native | 是（TEMP） | loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 130 | `session-revert-integration.cjs` | 0.448 | P33 撤销/Native | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 131 | `session-revert-writer.cjs` | 4.640 | P33 撤销/Native | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 132 | `session-revert-recovery.cjs` | 13.739 | P33 撤销/Native | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 133 | `session-revert-admission.cjs` | 0.336 | P33 撤销/Native | 是（TEMP） | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 134 | `session-revert-apply.cjs` | 82.094 | P33 撤销/Native | 是（TEMP） | loopback HTTP/测试端口 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 135 | `session-revert-windows-faults.cjs` | 8.535 | P33 撤销/Native | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 136 | `session-revert-inplace.cjs` | 129.365 | P33 撤销/Native | 是（TEMP） | 子进程 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 137 | `session-revert-inplace-safety.cjs` | 62.821 | P33 撤销/Native | 是（TEMP） | 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 138 | `session-change-query.cjs` | 5.403 | P33 会话变更 | 是（TEMP） | loopback HTTP/测试端口 / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 139 | `session-change-ui.cjs` | 0.578 | P33 会话变更 | 否 | 进程内 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 140 | `session-change-startup.cjs` | 10.994 | P33 会话变更 | 是（TEMP） | loopback HTTP/测试端口 / 子进程 | 测试自建 TEMP | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 141 | `session-revert-object-writer.cjs` | 478.724 | P33 撤销/Native | 是（TEMP） | 进程内 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
| 142 | `session-revert-object-faults.cjs` | 699.831 | P33 撤销/Native | 是（TEMP） | 子进程 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | 故障注入/恢复证据；失败即阻断 | faults |
| 143 | `session-revert-object-witness.cjs` | 0.801 | P33 撤销/Native | 是（TEMP） | 进程内 | 仓库 fixtures（只读） | 无显式跨套件依赖 | 仅跨 runner 并行；组内串行 | P33 安全证据；失败即阻断 | security |
