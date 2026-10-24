# Z1 交互增强与上下文引用 验收材料

## 本轮验收修复（取代初版的当前结论）

### 身份与证据范围

- 分支 `codex/z1-context-reference`；开始时本地与已推送远端均为
  `bc8a143e3efda029db93d75a81bf2cb4244fe27d`，工作区干净。本轮四笔修复/测试已推送至
  `528aa05564cfe222462db50c2c8c41f349febaf2`，创建[草稿 PR #29](https://github.com/HYJ1817/pi-gui/pull/29)
  取得用户允许的 PR CI 证明；报告及截图随后单独本地提交。未合并、未发布。
- main 基线为 `fd45b7789c395bdb7a776496a93cf0eb5d9e5cc4`（v0.29.0）。
  [CI 40086277137](https://github.com/HYJ1817/pi-gui/actions/runs/40086277137) 为 push、attempt 1，
  8/8 作业和 CI gate 成功，覆盖五组 canonical 与构建。它不证明 Z1 分支新代码。
- 修复提交：`5d6221c`（Z1-1）、`0709c7f`（Z1-2）；测试及专项入口：
  `cc7c4e332030d000551d144901cbe039c5567799`；补充无动画帧环境回退为 `528aa05`。
  最终行为证据绑定 `528aa05564cfe222462db50c2c8c41f349febaf2`。
  本地完整测试启动于 `bc8a143` 加随后提交为 `cc7c4e3` 的 diff，已中断；
  最终完整证明使用 PR CI。文档提交不冒称新 SHA 的 CI。
- PR CI 实际 checkout 合成 merge SHA `d494386686a19cbc08bbee6a077f5237932e6914`。
  已 fetch 对照，其 tree 与分支 head `528aa05` 均为 `c6c4755c0397532c48facd22cb08d63bb799ee5a`，
  因此测试的行为/测试文件与最终分支代码一致；不是拿历史 main CI 代替。
- 本次报告提交用 `git log -1 --format=%H -- docs/Z1-acceptance.md` 解析；初版报告固定为 `bc8a143`。
  全部本轮验证为作者自测；遵守单 Coding Agent 约束，未启动子 Agent、未做独立验收。

### Z1-1 / 问题一：Changes 滚动恢复（Important，已修复）

触发：滚动 Changes，切到 Specs 再返回，或切换单面板与分屏。原代码保存 `.chg-body.scrollTop`，
真实列表在 `.chg-list` 滚动。`ui4-pane.css` 虽也给 `.chg-body` 设置 `overflow:auto`，
本次单面板实际 clientHeight/scrollHeight 为 body 695/695、list 640/3597；
分屏为 body 276/276、list 221/4516，准确值见 [实测 JSON](evidence/z1/electron-after.json)。
Diff 横向容器是内部 `.diff`，`.chg-diff` 本身没有对应纵向滚动范围。

- `public/git.js` 改为监听真实列表，在销毁前和重绘前捕获位置；异步展开的 Diff 全部完成后，
  再在帧回调中恢复，避免占位内容太短时提前 clamp。用户等待期间滚动会取消旧恢复请求。
- 恢复检查列表、surface、epoch；项目/Worktree/会话切换立即丢弃。旧挂载状态请求失效时不再重绘。
  列表缩短由浏览器 clamp，空列表归零，状态失败显示错误，重试保留位置。
- 暂存区、工作区分别保存实际 `.diff.scrollLeft`。只保存数值和展开标记，仍重新读取 Diff，
  不缓存正文或旧锚点有效性；保留既有普通刷新、草稿和冲突检测规则，文件视图状态限 200 条。
- 原报告称“刷新 Specs 触发 Git 刷新”不准确：原测试先刷新 Changes，再点击文件行；
  普通刷新自动展开会让后续点击变成折叠。本轮保留既有普通刷新规则。

### Z1-2 / 问题二：日志概览引用反馈（Important，已修复）

触发：概览“最近错误”点击引用。原调用反馈节点为 `null`，成功与失败均不可见。
`public/logs.js` 为每条可引用概览记录增加 `role="status"` / `aria-live="polite"` 并传给原函数；
`public/ui5-logs.css` 让操作和反馈占一行、可换行。Classic、Runtime、未就绪与身份不匹配均有反馈。
没有新增 Toast；白名单摘要、脱敏、输入归属、草稿和内容上限保持原机制，不自动发送。
失败文案沿用共享填入函数；复制入口仍在“日志查看”的单条详情中，概览未新增复制按钮。

### 本轮验证

| 证据层 | 命令及实测结果 | 范围 |
| --- | --- | --- |
| 定向基线 | Z1 9/9、日志 UI 7/7、分屏 30/30，退出 0 | 说明旧 jsdom 测试漏掉真实滚动节点错误 |
| 作者定向回归 | `node tests/context-reference-ui.cjs` 10/10；`node tests/logging-ui.cjs` 11/11；`node tests/diff-comments-ui.cjs` 51/51；`node tests/split-workbench-ui.cjs` 30/30；退出 0 | 新增 5 条检查，无删减；移除全局 scrollTop 存根。现有 canonical 链自动执行两套扩展回归 |
| 本地 UI 组 | `node scripts/run-test-group.mjs --group ui --results .probe/z1-ui-group.json` 24/24 命令、退出 0 | [结构化记录](evidence/z1/canonical-ui-local.json)，SHA `528aa05`，只是受影响组验证，不替代五组完整证明 |
| 真实 UI 对照 | `npm run test:z1:electron`：旧代码 12/25、13 失败；修复后 25/25、0 失败，skip 均为 0 | 同一脚本，旧代码用 TEMP 内 `git archive bc8a143 public`；[修复前 JSON](evidence/z1/electron-before.json)、[修复后 JSON](evidence/z1/electron-after.json) |
| 本地完整 canonical | `npm test` 串行运行中断，退出 1，不是完整通过 | `.probe/z1-canonical.log`；耗时文件故障 fixture 阶段转用用户允许的 PR CI，无删改或跳过断言 |
| PR / 分支 CI | [run 40104517608](https://github.com/HYJ1817/pi-gui/actions/runs/40104517608)，pull_request、attempt 1；8/8 作业及 CI gate 成功 | head `528aa05564cfe222462db50c2c8c41f349febaf2`；五组 canonical 198/198 命令成功；命令级失败/取消/中断/跳过均 0；[完整汇总](evidence/z1/ci-summary.json)、[run 身份及内部 skip](evidence/z1/ci-run.json) |
| 产物 | `npm run build:exe` 退出 0；`CHECK_PORT=19777 node tests/exe-check.cjs` 49/49、退出 0 | `build/Pi GUI.exe` 102,703,104 字节；SHA256 `a87f8aa73ef2739e77bfb6e0f83d5f79c893d28d1fc50445d0b33d4670b83d40` |
| 独立审查 | 未执行 | 作者自测不替代独立验收 |

真实 UI 为 Electron 44.4.3 / Chromium 152.0.7977.130 正常沙箱、contextIsolation=true，
生产 HTML/CSS/模块加内存 API fixture；窗口 1300×850、760×850，窄窗口页面缩放 125%。
覆盖实际滚动/范围、异步加载与过期响应、列表缩短/空列表/失败重试、分屏往返、Diff 双区横向位置，
以及引用草稿共存、键盘激活、Classic/Runtime、拒绝路径和安全摘要。专项沿用仓库 Electron 独立入口政策，
不加入无桌面 canonical；普通离线回归已在现有 test 链中。

截图：[单面板恢复](evidence/z1/01-single-reopen.png)、[Diff 横向](evidence/z1/02-diff-horizontal.png)、
[分屏恢复](evidence/z1/03-split-reopen.png)、[引用成功](evidence/z1/04-log-success.png)、
[未就绪失败](evidence/z1/05-log-failure.png)、[窄窗口身份不匹配](evidence/z1/06-narrow-feedback.png)。
截图均经实际查看，无用户项目内容。未使用 --no-sandbox；本机已安装 Electron 在进入测试前以
0x80000003 退出，改用已有缓存的同版本 44.4.3 ZIP 解压到 TEMP 后正常通过，未下载依赖。
初步验证在缓存 41.1.1 上也通过；最终证据以上述 44.4.3 为准。

首次补查 `runtime-git-ui` 失败（`requestAnimationFrame is not defined`），原因是无布局 fixture
没有动画帧 API。`528aa05` 保留浏览器帧调度并为无该 API 的环境回退到定时器；原有断言未改。
重跑 Runtime Git 6/6、Runtime secondary 24/24、分屏评论 10/10、区间评论 22/22、评论持久化 16/16、
任务预览 36/36、Browser 分屏 14/14、Z1 10/10、日志 UI 11/11，以及 Electron 25/25，均退出 0。
先前 `cc7c4e3` 的 CI run 40104184304 在 UI 组同样于 `runtime-git-ui.cjs` 因缺少动画帧 API 失败，
随后被新提交取消并替代，不计入最终证明。最终 UI 组额外在本地按 canonical 计划复跑，24/24 命令成功。

最终 canonical 各组实际完成：core 122/122、ui 24/24、security 27/27、native 4/4、faults 21/21。
198 是命令数，不是断言数。内部条件跳过单列：`session-revert-inplace-safety` 为 42/42、skip 1
（令牌具备权限，不适用“缺少权限”的反例）；`session-revert-object-witness` 为 0/0、skip 8
（existing_token_sacl_unavailable）。这 9 项没有计入通过断言，P33 生产资格没有因此改变。
五组结构化原记录保存在 `docs/evidence/z1/ci/test-results-*/results.json`；已用仓库现有
`summarize-ci-results.mjs --require-complete` 按相同 SHA/run/attempt/event 复核，退出 0。
plan digest 为 `04b71c8cde4113cc7baa1635526750ec0e202812d96744539b886ab9cc69e322`；
原服务端汇总与本地重算的身份及完整性结论一致。测试 wall span 1036.717 秒。
[源码与产物摘要](evidence/z1/source-manifest.json)记录最终 7 个行为/测试文件的本地 SHA256。

### 限制与交付状态

- 本地借用 `C:\pi-GUI\node_modules`（临时 junction 已删除，主仓依赖保留），输出位于本 worktree 或 TEMP。未改 Pi、T4-C、P33、Browser、
  CI、Release、版本号、签名配置。没有用户项目写入验证或真实模型调用。
- 真实 UI 验证的是前端加 fixture，不能代表真实后端/Pi 或已安装应用验收；用户手势取消恢复有保护，
  专项未穷举触摸设备与系统缩放组合。Specs 初版机制及 Browser 生命周期不在本轮变更范围。
- 回滚按需 `git revert 528aa05 0709c7f 5d6221c`，测试提交 `cc7c4e3` 可独立回退，然后重建产物。
  无数据迁移，回滚命令未执行。历史原报告未验证项不被沿用为本轮通过结论。
- 两项发现已修复；最终代码完整 canonical 已通过；独立审查待安排，尚不宣称达到全部合并条件。
  合并和发布未获授权。无需为两项修复单独升版，待 Z1 整体验收后由用户决定发布。

## 初版历史记录（bc8a143，仅保存当时证据）

以下数字及未验证项属于初版。本轮身份、修复结果与结论以上方为准；历史内容不代表当前状态。

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
