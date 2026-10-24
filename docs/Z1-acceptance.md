# Z1 交互增强与上下文引用 验收材料

- 目标与交付：任务 A 在日志查看器为 ERROR/WARN 增加「引用到对话」，复用
  `review-fill.js` 的受控填入（只追加、不自动发送）；任务 B 让 Changes/Specs
  右栏面板在关闭重开后恢复展开的 diff、列表滚动、Specs 目录展开、选中文档与
  文档滚动，旧作用域数据按身份丢弃。未交付：文件预览选区引用（现有预览无可复用
  的选区机制，按任务要求保持现状）、Browser 跨面板状态恢复（销毁语义是既有安全
  设计，本轮明确不做）、MCP Apps 宿主能力（留待后续轮次）。
- 身份：before HEAD `fd45b7789c`（origin/main，v0.29.0）；after HEAD 为包含本
  报告的交付提交，可用
  `git log -1 --format=%H -- docs/Z1-acceptance.md` 解析；分支
  `codex/z1-context-reference`（worktree `C:\Users\21022\.codex\worktrees\z1-context-reference\pi-GUI`）。
- 证据范围：行为验证覆盖 before HEAD + 工作区 diff（提交前验证记录）；报告
  提交后的文件树已用 `git status` 核对。
- 修改文件：
  `public/diagnostics.js`（新增 `buildLogReference` 白名单摘要）、
  `public/logs.js`（详情区与概览 ERROR/WARN 行的引用入口 + 状态行）、
  `public/ui5-logs.css`（引用操作样式）、
  `public/ui/secondary-surface.js`（面板级轻量状态暂存 `readPaneState`/
  `writePaneState`/`clearPaneState`，上限 8 条）、
  `public/specs-panel.js`（dispose 时快照、按 workspace 身份恢复）、
  `public/git.js`（跨面板 diff 展开状态与列表滚动恢复、clear 时同步推进
  epoch 防止异步写回、restoreOpen 限定在重开面板后的首次状态加载渲染）、
  `package.json`（`npm test` 链加入 `tests/context-reference-ui.cjs`）。
- 行为与安全边界：日志引用只携带时间·级别·来源·事件·代码五个白名单字段，
  不携带 details、correlationId 或原始 payload；填入复用 `fillReviewComposer`
  的焦点归属校验（classic/runtime 身份不一致、未就绪时拒绝并提示，摘要可经
  「复制这一条」兜底），绝不自动发送。面板恢复只存小状态（无 DOM、无业务
  数据），恢复前重新校验 workspace 身份；scope/session/workspace 切换清空
  `diffViewState` 并推进 epoch，在途 `reloadDiff` 的 `rememberDiffView` 按
  epoch/scope/revision 丢弃，旧异步响应不能复活旧作用域的展开状态；diff 锚点
  校验、revision、评论冲突检测与 T4-C 采纳流程未改动。
- 风险：中（常规功能 + UI + 会话/作用域边界复用既有机制；无新增依赖、无网络
  行为、无文件写入路径变化）。

| 证据层 | 命令/场景与代码状态 | 环境、退出码与实际结果 | 日志/截图/run |
| --- | --- | --- | --- |
| 作者自测 / 本地定向 | `node tests/context-reference-ui.cjs`（新增 9 断言：白名单字段、草稿共存追加、跨面板恢复展开与滚动、session-switch 丢弃、Specs 身份快照与恢复）、`node tests/diff-comments-ui.cjs`、`node tests/split-workbench-ui.cjs`、`node tests/browser-workbench-ui.cjs`、`node tests/logging-ui.cjs`、`node tests/specs.cjs`、`node tests/session-change-ui.cjs`、`node tests/review-regressions.cjs`、`node tests/diagnostics.cjs`、`node tests/ui3-composer.cjs`、`node tests/runtime-changes.cjs`、`node tests/runtime-secondary.cjs`、`node tests/runtime-git-ui.cjs`、`node tests/review-comment-persistence-ui.cjs`、`node tests/session-revert-object-ui.cjs`、`node tests/process-ui.cjs`、`node tests/smoke.cjs`、`node tests/interactions.cjs`、`node tests/ui-ia.cjs`、`node tests/daily-use.cjs`、`node tests/git.cjs`、`node tests/modules.cjs`、`node tests/ui2-classic.cjs` | 全部退出码 0：Z1 9/9；Diff comments 51/51；Split workbench 30/30（skipped=0）；Browser workbench 14/14；logging-ui 7 通过 0 失败；Specs 18/18；Session change UI 27/27；Review regressions 32/32；diagnostics 15 通过；UI3 Composer 34/34；Runtime changes 60/60；Runtime secondary 24/24；Runtime Git UI 6/6；Review comment persistence 16/16；Object revert UI 52/52；Process UI 17/17；smoke 1338/1338；interactions 通过；P30 IA 12/12；daily-use 31/31；git 161/161；modules 119/119；UI-2A 48/48。各套件 skip 均为 0（套件自身输出为准），无断言总数下降 | 本报告同目录会话记录；测试运行于 worktree，`NODE_PATH` 指向主仓 `node_modules` |
| 本地完整 canonical | `npm test` 未在 worktree 完整运行（worktree 无独立依赖安装，完整链耗时过长；新套件已按硬约束加入 test 链，受影响套件已定向全过） | 未验证（未运行，原因如左） | 无 |
| 独立审查 | 未执行（本轮无独立上下文复审） | 待用户安排 | 无 |
| PR CI / main CI | 未推送、未创建 PR（用户明确禁止） | 未验证（未运行） | 无 |
| Electron / 产物 | worktree 内 `node scripts/build-exe.mjs`（esbuild `write:false` 规避 worktree ACL 问题；`node_modules` 用指向主仓的 junction 构建后已删除） | 退出码 0；`build/Pi GUI.exe` 102,700,032 字节（97.9 MB），asset-manifest 含 `public/logs.js`、`public/git.js`；`build:app` 未跑（SEA 产物已含本轮前端改动，Electron app 产物未重新打包） | 产物在 worktree `build/` 下 |
| 真实 UI 截图 | 未验证（未运行：本轮未做真实浏览器/Electron 交互截图；jsdom 测试只证明行为契约，不证明布局） | 引用按钮与状态行布局需真机复核 | 无 |
| 模型 / 安装升级 | 不适用（无网络行为、无安装变更） | — | — |

- 失败与修复历史：
  1. `context-reference-ui` 的「session switch drops the retained expanded-diff
  state」失败：`restoreOpen` 的 `queueMicrotask(reloadDiff)` 在 session-switch
  清空 `diffViewState` 之后落地，把 `open:true` 写回。修复：新增
  `diffViewStateEpoch`，`rememberDiffView` 校验 epoch/scope/revision 后才写入；
  重跑 9/9 通过。
  2. `split-workbench-ui` 的「refreshing Specs keeps the Changes diff expanded」
  失败（main 基线 30/30 确认为本轮引入）：`restoreOpen` 在每次重绘生效，分屏内
  点击 Specs 刷新触发 Changes `refreshGitNow()`，重绘自动重新展开 diff，测试的
  后续点击将其折叠。修复：`restoreOpen` 限定为挂载后首次状态加载渲染（
  `renderChangesBody(reopenSerial)`，`reopenSerial` 只在面板重开时传入）；
  重跑 30/30 通过。
- 限制与残余风险：真实 UI 截图与 Electron 交互证据未采集；完整 canonical
  `npm test` 未在本地跑，需按项目政策由准确 HEAD 的 CI 或用户本机补跑；Specs
  文档滚动恢复依赖 jsdom scrollTop 存根，真实渲染几何未验证；日志查看器的
  概览「引用」按钮无独立状态行（反馈走详情区状态行，属既有结构限制）。
- 回滚：回退包含功能与测试链的提交即可整体撤销；`build/` 产物删除后重跑
  `npm run build:exe` 恢复。无数据迁移、无外部状态。
- 待用户决定：是否推送 / 创建 PR；是否安排独立审查与完整 canonical CI；
  是否采集真实 UI 截图作为布局证据。
- 结论：开发完成（作者自测通过，边界按任务约束保留）；代码验收 待独立审查；
  合并许可 待用户决定；发布许可 待用户决定（无版本号 / Release 变更）。
