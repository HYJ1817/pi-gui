# Refined 生产界面实施计划

> 执行方式：本会话逐项实施；保留现有业务 owner，不提交、推送、合并或发布。

**Goal:** 将已确认的 Refined 布局与中性双主题应用到真实 pi-GUI。

**Architecture:** 原生 ES modules、现有 tokens 与组件样式；workspace-surface 保留聊天 DOM，right-pane 继续独占原生 Browser 几何与生命周期。设置导航承载任务和扩展；账户、诊断和更新保留原弹窗与确认所有权。

**Tech Stack:** 现有 HTML/CSS/JavaScript、jsdom、Electron；不新增依赖。

## 基线与范围

- 实施分支 `codex/ui-refined-implementation`，从当前 `origin/main=eac79cab793cff26c6cb6aa01cc9d9276ce06606` 创建；设计勘察基线 9694339 是历史证据。
- 当前精确 SHA push CI 40678496026 attempt 1 success，计划、五组 canonical、打包及 CI gate 均成功；40680788304 为后续发布验证，不混作测试矩阵。开发前已核对 fetch、Release v0.30.1。新基线本地 IA 12/12、composer 34/34；旧勘察基线 model 50/50、theme 47/47 单列。
- 已有两个未跟踪路径保留：设计目录与 `2026-10-22-project-development-governance.md`。
- `/` 与上下文统计使用真实现有模块；不增加未经确认的 @ 引用，不复制演示数据。

## 执行项

- [x] 1. 入口回归先行：更新 `tests/ui-ia.cjs`，验证任务/扩展位于设置、工作工具在右栏、关闭焦点回到存活入口、草稿/滚动/聊天节点不变。先观察失败。
- [x] 2. `public/index.html`、`public/app.js`、`public/ui/workspace-surface.js` 和新增 `ui/settings-surface.js`：单侧栏；设置目录及返回；原 handler 不复制；导航生命周期回归。
- [x] 3. 右栏添加持久工具导航与总开关。复用 secondary-surface，所有关闭路径回主标题开关；`right-pane.js` 保留几何算法与 Browser 遮挡。
- [x] 4. 修改所属样式表中的 tokens、shell、消息、工具、composer、模型菜单与 Runtime 控件；不添加后置全局覆盖文件。正文 760px / 15px，输入区一体化 18px 圆角；双主题一致。
- [x] 5. 定向运行 IA、composer、model、inline commands、theme、稳定会话排序、workspace/Runtime、pane/Browser 和相邻测试；旧位置断言迁移到新可见入口，保留行为覆盖。
- [x] 6. TEMP 离线 fixture 下真实 Electron 交互、三尺寸双主题截图，检查菜单、设置往返、长文、右栏与缩放。独立审查整个生产 diff 并收敛。
- [x] 7. 执行最终完整 `npm test`，保留环境阻断后按同清单累计续跑的记录，不把累计验证称为单次通过。重建 App 并验证资源摘要与真实打包窗口。累计231条命令执行完成，环境跳过单列；不是无条件完整通过。
- [x] 8. 保存实际结果、原版/改版对照与未验证资格。停止等待人工验收。

## 验收与回退

业务 API、数据模型、权限、真实模型与安装更新行为均不变。UI 回退单位为本分支生产 diff，设计证据保留。普通设置叶子继续用真实弹窗；完整嵌入式表单迁移不通过重定向 modal 来实现，以免改变异步实例与认证确认合同。实体 IME、全套物理 DPI、真实模型与用户安装升级单列未验证。

2026-11-01 执行状态：1–8 已执行并归档。canonical 原始前106条完成，环境阻断后续125条均成功退出，输入摘要未变；21个环境跳过不计入成功断言。63张去重截图、最终构建资源、打包窗口与后端已分别验证。两个未全通过专项、真实模型/实体IME等限制见 17-production-acceptance.md。停止等待人工验收；未提交、推送、安装或发布。
