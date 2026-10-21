# T2-A Split Workbench 验收

## 基线

- 基线：`origin/main` / `main` = `048d2c7`（T1 只读 Specs 已合入）。
- 开发分支：`codex/t2-a-split-workbench`。
- 本地提交：`06cb541` 功能，`483d5f3` 测试；验收证据独立提交。
- 独立 Worktree：`C:\Users\21022\.codex\worktrees\t2-a-split-workbench\pi-GUI`。
- 主工作区已有的未跟踪目录 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/` 未触碰。
- 本轮没有推送、合并、修改 `main`、打 tag 或发布。

## 实现

### 复用

- 右栏宽度、dock/overlay、焦点回收、46px 标题带继续由 `public/right-pane.js` 与
  `public/ui4-pane.css` 提供；没有第二套右栏宽度记忆。
- Specs 的发现、Markdown 安全渲染、标题锚点、相对链接和请求身份守卫继续由
  `public/specs-panel.js` / `public/specs-tree.js` / 后端 Specs 路由负责。
- Changes 的 Git status、Diff、撤销、过滤和工作区身份守卫继续由 `public/git.js`
  与既有 Git 路由负责；分屏没有创建第二份 Git 状态。
- Browser 继续由现有 `WebContentsView` 独占右栏，没有进入分屏。

### 新增与扩展

- 新增 `public/ui/split-workbench.js`：只负责上下布局、分隔条、比例持久化和窄高回退。
- `public/specs-panel.js` 导出 `mountSpecsPanel()`；单面板与分屏共用同一套树、正文和事件逻辑。
- `public/git.js` 导出 `mountChangesPanel()`；单面板与分屏共用同一套 `S.changes`、
  `panels.changes`、Diff 和撤销逻辑。
- `public/ui/secondary-surface.js` 保留原有单实例 API，将 dispose 扩为有界集合，
  允许一个工作台可靠释放两个子面板；新增实例级 `close()`。
- 单面板标题带提供明确的「分屏」入口；分屏顶部提供「退出」恢复来源单面板。
- 窗口宽度小于 900px 或右栏内容高度小于 448px 时降级为 Specs / Changes 页签，两个子实例保留状态但只显示一个；
  不压缩聊天区，也不把两个面板强压到不可用高度。
- 比例只写入 `pi-gui.workbench.split.v1`；不保存文档正文、Diff、选中项或路径。

## 安全与隔离

- 没有新增后端路由、文件系统读取、任意路径参数、写文件能力或权限入口。
- Specs 仍只接受后端索引中的不透明文档 ID；Changes 仍复用它原有的路径和 Git 授权校验。
- 切换 workspace generation 时两面板立即清掉旧内容；Specs 重载，Changes 由既有
  `resetChanges()` 清空。
- focused conversation scope 变化时，两面板都跟随同一 `X-Pi-Gui-Conversation` 来源；
  迟到的旧 scope 响应不能覆盖新 scope。
- 切换 Browser、Process、单面板或关闭右栏时，工作台、子面板、ResizeObserver 和拖动监听器
  统一 dispose。

## 测试结果

以下均为本轮实际执行结果，不是计划值。

| 命令 | 结果 |
| --- | --- |
| `npm run test:specs` | 43/43（后端 18 + UI 25） |
| `npm run test:split` | 30/30，有效执行所有断言回调 |
| `node tests/git.cjs` | 161/161 |
| `npm run test:worktrees` | 86/86（56 lifecycle + 14 HTTP + 16 UI） |
| `node tests/runtime-changes.cjs` | 60/60 |
| `node tests/runtime-secondary.cjs` | 17/17 |
| `node tests/runtime-git-ui.cjs` | 6/6 |
| `node tests/smoke.cjs` | 1338/1338 |
| `node tests/modules.cjs` | 119/119 |
| `node tests/ui4-integration.cjs` | 55/55 |
| `node tests/ui4-pane.cjs` | 280/280 |
| `npm run test:split:electron` | 32/32，12 张真实 Electron 截图 |
| 同上，`T2A_FORCE_DEVICE_SCALE_FACTOR=1.25` | 32/32，应用缩放另测 125% |
| `npm run build:app -- --rebuild --output-root C:\pi-GUI\.probe\t2a-build-final` | 最终 CSS 修复后退出 0，328.6 MB，6 个变更资源与源码逐字节相同 |
| `npm run fixtures` + `node tests/app-check.cjs --output-root C:\pi-GUI\.probe\t2a-build-final` | 26/26 |
| `npm test` + 从相同清单继续执行余项 | canonical 164/164 叶套件通过、最终失败 0；单次 npm test 退出 1 的环境中断另记，非单次全绿 |

基线首次全量尝试曾因 worktree 内临时目录上的 esbuild `Access is denied` 中断。
一次 `npm test` 重跑通过前 82 个 canonical 叶套件，在 `verification.cjs` 的临时 JSON
rename 上遇到 EPERM；该套件随后在默认外部 TEMP 中通过 136/136。余下套件从
`package.json` 经现有 `createTestGroupPlan()` 动态展开继续执行，不维护第二份清单。
详细最终结果以同目录证据中的 `validation-results.json` 为准；不能将中断的单次命令记成通过。
前 82 个套件与后续 82/82 的合集覆盖全部 164 个 canonical 叶套件；
修改过的 Specs UI、Split UI、smoke 在修正后另行有效重跑。后续 Native writer 450.9s、
Native faults 659.2s 均以退出 0 完成。SACL 无权限等既有跳过断言不计入通过数。

定向验证发现新增 Split UI 与既有 T1 Specs UI 的辅助函数均未执行断言回调。
本轮修正辅助函数，并修正 Specs 折叠断言（重新查询已重建的按钮，检查子树 hidden）；
有效重新运行 Specs UI 25/25 与 Split UI 30/30。修正前的显示数字不作为验收证据。

## Electron 证据

真实 Electron 使用临时 Git 仓库和 fake Pi，不使用用户项目或模型。截图位于
`docs/evidence/t2-a-split-workbench/`：

- `01-single-panel-specs.png`：单面板 Specs。
- `02-split-1536.png`、`02-split-1200.png`、`02-split-900.png`：Specs + Changes 分屏。
- `02-split-720.png`：720px 窗口单面板页签回退，沿用右栏原有 overlay 行为。
- `03-short-window-fallback.png`：短窗口窗口降级页签。
- `04-short-window-changes-tab.png`：回退页签切换到 Changes，Diff 展开状态保留。
- `05-split-zoom-125.png`：应用缩放 125% 下的分屏。
- `06-single-panel-restored.png`：退出分屏恢复单面板。
- `07-device-scale-125.png`：Electron `--force-device-scale-factor=1.25` 下的分屏。
- `08-worktree-b.png`、`09-worktree-a-return.png`：真实临时 Git Worktree A/B 的项目激活切换。
- `10-wide-specs.png`：右栏拉宽到 560px 以上时，文档树/正文并排且利用完整内容高度。
- `results.json`：32/32 检查、截图清单、Electron/Chromium 版本和测试夹具说明。
- `device-scale-results.json`：同样的 32/32 检查在强制 device scale 1.25 下的记录。
- `device-scale-125/` 保存完整 device scale 1.25 运行的截图和原始 results.json。
- `validation-results.json` 保存全部 canonical 命令、结果、最终产物摘要和截图校验值。

## 多会话与 Worktree 证据

- `tests/split-workbench-ui.cjs`：30 条中覆盖 workspace generation 清空、
  focused scope 重载、A 旧响应晚到不覆盖 B、Changes 单独失败不打断 Specs、
  Browser 切换 dispose、重复打开/关闭监听器归零。
- `tests/runtime-changes.cjs`：60 条真实临时 Worktree / Registry 断言，覆盖 A/B
  Changes 隔离、archived/removed/stale workspace fail-closed、迟到写入拒绝。
- `tests/specs.cjs`：18 条覆盖 junction、超限、删除、另一 Worktree、旧 generation
  和 unknown scope。
- `tests/worktrees.cjs` / `worktrees-http.cjs` / `worktrees-ui.cjs`：86 条覆盖
  真实 A/B Worktree、activation、generation、busy remove 和 stale UI。

## 独立复审

已进行完整 diff/新增模块审查，并针对修复做定向复核。发现与处置：

- Important：进入短窗口回退时焦点停在隐藏的 Specs 关闭按钮；已转移到可见页签并补测试。
- Important：从回退恢复分屏时焦点停在隐藏的模式条；已转移到可见分隔条并补测试。
- Important：宽栏下两行规则覆盖既有 >=560px 并排布局，334px 内容区域仅使用 113.55px；
  已限定在窄容器中，独立 Chrome 复核恢复单行 334px，真实 Electron 新增回归断言通过。
- Nit：验收文档与证据链接在开发中尚未生成；现已补齐。
- 最终定向复核确认上述宽栏问题已解决，未发现新的有证据的 Important/Blocker。

复审使用固定目录快照，未修改业务代码；完整测试和 Electron 结果由作者另行验证。

## 已知限制

- 本轮只提供固定的 Specs（上）+ Changes（下）分屏，不做任意面板拖放或 Browser 分屏。
- 分屏比例是全局偏好，不按 workspace/session 分别记忆。
- 窗口宽度小于 900px 或内容高度低于 448px 时是单面板页签回退；两个子实例仍保持挂载，因此隐藏面板仍可能有
  自己的请求和状态，只是不显示。
- Worktree A/B 有真实 Electron + 实际项目激活截图；并行 focused 会话的隔离证据来自
  有效 jsdom 与真实临时 Git/Registry 后端夹具，没有声称验证真实模型的并发运行。
- Windows 系统缩放不修改本机设置；通过 Electron `--force-device-scale-factor` 和
  `webContents.setZoomFactor(1.25)` 做可控缩放验证，未覆盖所有 DPI 组合。

## 回滚

1. 在接受本轮变更的分支执行 `git revert --no-commit 483d5f3 06cb541`，审查并提交回滚。
   同时回退功能和新增测试，避免保留指向已移除模块的测试入口；验收文档可保留作历史记录。
2. 重新运行 `npm run build:app -- --rebuild`，恢复 `dist-app` 构建产物。
3. 可删除本地 `pi-gui.workbench.split.v1`；它只含比例，不包含文档或 Git 内容。

可直接运行本次独立产物：
`C:\pi-GUI\.probe\t2a-build-final\dist-app\Pi GUI-win32-x64\Pi GUI.exe`。
主工作区 `main` 未变更；产物位于独立输出根，避免覆盖主工作区已有应用。

## T2-B 建议

- 增加可选的 Browser 分屏宿主，但仍保持原生 `WebContentsView` 的 bounds/occlusion 单一所有权。
- 把比例按 workspace/session 记忆，并为隐藏回退面板做可选的懒加载/暂停刷新。
- 将本轮真实 Electron Worktree A/B 脚本扩展至两个并行 focused 会话的 Stop/Close 切换。
- 评估横向分屏、面板大小快捷键和可访问的拖拽替代方案，但不引入任意停靠系统。
