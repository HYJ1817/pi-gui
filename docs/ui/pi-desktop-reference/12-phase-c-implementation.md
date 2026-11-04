# 阶段 C：外壳、顶栏与项目/会话导航

## 范围与基线

- 基线：`6036ceb9d5303eb9653f39b9c54a4c9405a3a815`，分支 `codex/pi-desktop-phase-c`。
- 基线完整证明：[main CI 41592806846](https://github.com/HYJ1817/pi-gui/actions/runs/41592806846)，push / attempt 4，CI gate success。
- 参考源码：`C:/Users/21022/pi-desktop-ref`，HEAD 精确为 `92ae661f1e399e69d514086b46029b4c34ba1a92`。参数与行为独立实现，不复制参考 TSX/CSS。
- 使用现有原生 JS、CSS 与 Electron；不新增依赖，不改 RPC、磁盘数据、会话调度、Composer 或右侧工作台内容。

## 源码勘察与取舍

| 区域 | 已有能力 / owner | 本次调整 | 不移植的参考能力 |
| --- | --- | --- | --- |
| 外壳 | `index.html`、`app.js` 折叠；`workspace-surface.js` 保持 Chat/Runtime DOM 与生命周期 | 275px 侧栏、46px 顶栏、折叠至 0、恢复按钮并入顶栏空间 | 不新增另一套路由或 Sidebar store |
| 标题 | `shell.js` classic/runtime 标题投影；Runtime 实际 owner 在 `runtime-state.js` | 项目图标/名称与会话名分层；Runtime 项目来自该会话 workspace，而非经典 cwd | 参考允许更广泛改名；pi-GUI 仍由已有侧栏编辑器执行受限改名，不增加顶栏编辑器 |
| 项目 | `projects.js`、`sidebar-expansion.js` 持有真实项目、按路径展开状态 | 恢复文件夹图标、缩进与行节奏、当前项目轻量标记 | 不增加参考的置顶、归档、拖拽排序等新业务 |
| 会话 | `sessions.js`、`runtime-nav.js`、稳定排序与 captured-owner 导航 | 28px 行、悬停菜单与真实活动指示 | 不合并 Classic/Runtime 身份，不重新排序 |
| 菜单 | `ui/action-menu.js` 单例、碰撞处理、键盘、焦点与关闭机制 | 原菜单视觉对齐；项目/经典会话右键复用同一触发入口 | 不建第二套菜单，不伪造 Git/复制等不存在的条目 |
| 设置 | A/B tokens、primitives 与 settings surface 已实现 | 外壳 CSS 排除 settings-mode，保留 A/B 布局 | 不重做设置页容器 |
| 底栏 | 已有设置、外观、上下文、连接状态 | 将设置/外观与连接状态收为紧凑工具带 | 不按路线图硬造通知/定时任务四键组 |

状态影响只涉及 DOM 可见性、标题派生显示和菜单入口；项目激活、会话写操作、并行执行及持久化仍走原函数。主要风险是 Runtime 显示错误项目、折叠后遮挡顶栏、菜单误触会话切换及设置样式外溢，均纳入验证。

## 实施与验证顺序

- [x] 核对 main/远端/tag/release、固定参考源码、A/B 与现有生产边界。
- [x] 定向基线：sidebar-menu 37/37、stable-session-order 41/41、session-background-ui 9/9、runtime-nav 38/38、ui-ia 26/26、theme 47/47、settings-acceptance 15/15、ui2-visual 57/57；primitives 原套件成功（未输出断言总数）。
- [x] 在生产模块测试中先增加项目标题隔离、活动指示与右键入口回归，记录修改前失败。
- [x] 重用现有结构实现外壳样式、标题上下文和菜单入口；清理已确认过期的外壳规则。
- [x] 定向回归与真实 Electron：DPR 1.5、约 1205×803 CSS 视口，展开/折叠/浅色/项目与会话/项目菜单/运行/窄窗/设置。
- [x] 逐图目视检查并修复；保存几何与颜色数据、截图和实际差异报告。
- [x] 完整 `npm test`、本地重建产物、独立 Agent 复审；记录未验证边界，停在本地等待验收。

逐区域证据、最终截图和测试结果在配套阶段 C 验收报告中记录。

最终证据：见 [阶段 C 验收报告](13-phase-c-acceptance.md)。canonical 234/234 为累计验证，首次 Windows fixture 启动失败和两个 witness 的权限缺失均已记录；最终 Electron 26/26、后台并行 16/16，最终独立产物已重建。
