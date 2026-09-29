# P14-D Stage Work Surfaces

Global Rail 的 Home、任务、文件变更、扩展是四个一级视图。`public/ui/workspace-surface.js` 只管理当前视图、Stage 容器、唯一激活的 Rail 项和实例生命周期；各业务模块继续渲染自己的唯一一套内容。`#workspace[data-workspace-view]` 供样式、测试与排查读取，真实状态保存在模块内存中。

切出 Chat 时只隐藏 `#chatView` 和 `#chatComposer`。Conversation、Composer、附件及输入草稿的 DOM 不重建；SSE 消息继续写入同一消息流。返回 Home 即恢复原节点、滚动和当前流式状态。项目切换先回到 Chat，沿用 `workspaceGeneration` 清掉旧项目数据。

每次打开工作视图都会创建实例 token，先 dispose 上一个实例并清空 Stage host，再 mount 新实例。Planner 的 `plannerAlive()` 同时检查项目代号与 Surface 实例；Git 离开时清除 `panels.changes`，旧 diff response 由实例身份拦截；Skills 与 MCP 的异步结果也只允许当前实例落地。此状态只在前端运行时存在，不进入 Plan、Session 或后端配置。

Planner、Changes、Extensions 是一级 Stage 页面。危险操作确认继续用 `confirmModal`；Planner 历史 Diff、诊断、供应商等临时内容继续用 `openModal`。关闭二级 Modal 不切换当前一级视图。Planner DAG、Attempt、Review、Verification、Git 安全授权、Skills 发现和启停语义均沿用原业务模块。

布局使用同一 Stage 背景、轻分隔的列表与详情。桌面列表和详情并排，700px 转为上下排列；窄屏及低高度下滚动发生在 Surface 内部，不让页面整体横向溢出。Plan 和 Skill 列表项使用原生 button，选中项提供 `aria-current`；Tab 提供 `aria-selected`，Rail 继续使用 `aria-current="page"`。颜色之外仍保留状态文字。

验证：`npm run test:ui` 的 P14-D 段检查节点身份、草稿、附件、滚动、后台流式更新、唯一激活态和二级 Modal；`npm run harness` 加 `npm run shots:harness` 的 105–124 场景在真实 Chrome 中检查 Stage bounds、列表与详情、Diff、MCP、700/900/1200/1536px 和低高度窗口。完整回归以 `npm test` 为准。
