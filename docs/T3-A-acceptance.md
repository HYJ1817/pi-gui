# T3-A Diff 行级评论与审查反馈验收

## 一、基线与提交

- 开发基线：`origin/main = 724bd48119dd7ba5ba7e1327da12353bd0339ea7`
  （「合并：增加 Browser 与 Changes 原生分屏工作台（T2-B）」），已包含 T2-A / T2-B。
- 开发分支：`codex/t3-a-diff-comments`。
- 独立 Worktree：`C:\Users\21022\.codex\worktrees\t3-a-diff-comments\pi-GUI`。
- 主工作区 `C:\pi-GUI` 未修改；其未跟踪的 `$null`、`.p25-1-release-*` 未触碰。
- 本轮只做本地提交，未推送、未合并、未修改 `main`、未打 tag、未发布。

## 二、实际改动文件

| 文件 | 改动 |
| --- | --- |
| `public/diff.js` | unified diff 解析真实 old/new 行号、hunk 索引与指纹；行号槽为可聚焦按钮；`commentable:false` 退回旧渲染 |
| `public/diff-comments.js`（新增） | 内存评论状态、逻辑锚点、过期/待确认判定、反馈格式化与容量上限 |
| `public/git.js` | Changes 面板接线：行评论编辑区、标记与过期提示、审查意见汇总弹窗、草稿保留、作用域切换清理 |
| `public/review-fill.js`（新增） | 「填入当前会话」：只追加、不发送、校验会话身份 |
| `public/runtime-conversation.js` | Runtime 根节点写入 `data-conversation-id`，供填入前做身份核对 |
| `public/styles.css` | 行号槽、评论标记、内联编辑区、审查意见汇总与窄容器适配 |
| `public/ui4-pane.css` | 右栏标题带单行不换行；≤620px 隐藏副标题，保证「审查意见 / 刷新」不被裁切 |
| `package.json` | 新增 `test:diff-comments`（离线叶套件）并接入 `npm test` 链；`test:diff-comments:electron` 为独立 opt-in |
| `tests/diff-comments.cjs`（新增） | 解析、行号、锚点、过期、容量上限等纯逻辑 44 条 |
| `tests/diff-comments-ui.cjs`（新增） | jsdom 交互、作用域隔离、草稿、迟到响应、截断降级 37 条 |
| `tests/diff-comments-split.cjs`（新增） | 分屏与右栏生命周期下的评论保留与监听器清理 10 条 |
| `tests/diff-comments-electron.cjs`（新增） | 真实 Electron 渲染、截图、native 分屏与弹窗遮挡 41 条 |
| `docs/evidence/t3-a-diff-comments/` | 16 张真实 Electron 截图 + `results.json` |

无新增 npm 依赖；未改 Pi RPC、会话存储、Planner Review 状态、Browser 导航策略、
Git 授权或撤销路径；没有新增后端路由、文件写入、任意路径读取或 localStorage 持久化。

## 三、评论锚点设计

评论不绑定 DOM 节点或列表序号。每条评论保存一份逻辑锚点：

- `scope`：`conversation:<id>` 或 `classic:<sessionId>`，再加当前 `S.cwd`；
- `path`：项目相对路径（后端既有 Git 路径，不含绝对路径）；
- `section`：`staged` / `working`，暂存区与工作区分别标识；
- `type`：`add` / `del` / `context`；
- `oldLine` / `newLine`：删除行只有旧行号，新增行只有新行号，上下文行两侧都有；
- `hunkIndex` + `hunkHeader`（头文本的 FNV-1a 哈希，不把用户代码写进属性）；
- `codeHash`：该行代码内容的哈希；
- `diffFingerprint`：只由 hunk 内的 `+` / `-` 行算出的版本指纹，不受上下文行数变化影响；
- `snippet`：截断到 160 字的一行上下文，仅用于人工辨认与反馈文本。

匹配规则（`reconcileSectionOptions`）：

1. 类型、旧行号、新行号、内容哈希全部一致且唯一 → 恢复为「当前位置有效」；
2. 完全一致但出现多行（同一段 diff 重复出现）→ 再用 hunk 索引与头哈希消歧，
   仍不唯一则视为不可靠；
3. 位置相同但内容哈希不同 → 判为「原位置已变化」，**不改绑**；
4. 上下文行超出当前上下文数量、但整段改动指纹未变 → 仅标为「待重新确认」，
   不改绑，也不删除；
5. 其余情况 → 过期标记，保留评论供查看、复制、删除。

Diff 截断（后端字节上限）时不做任何重新判定：既不算有效，也不判过期，面板提示
「差异已截断，无法确认完整行号」。二进制与不可显示内容不生成任何行锚点。

## 四、评论状态与过期策略

- 存储：模块内 `Map<scope, comment[]>`，进程内内存；不写项目、不写 Git、
  不写 Planner、不用 localStorage。应用重启后评论不恢复，汇总弹窗明确说明其临时性质。
- 上限：最多保留 20 个作用域；每作用域 200 条；单条 2000 字；反馈文本 12000 字；
  未保存草稿 40 条（超出按最早优先淘汰）。
- 只读查询（计数、汇总、行标记）不创建也不淘汰作用域桶；只有写入才会新建桶，
  且只回收空桶。达到作用域上限时**拒绝新评论**，不丢弃任何已有评论。
- 同一行第一阶段只保留一条可编辑评论；已有过期评论占用该位置时，
  不允许再挂第二条，只能先删除。
- 保存评论不折叠 Diff、不改滚动位置；外部刷新会先捕获未保存草稿，
  在同一锚点上恢复，切换作用域则不恢复（见下）。
- 刷新后状态变化：`refreshGitNow()` 先调用 `beginReviewRefresh()`，
  把所有评论降为「尚未重新确认」，只有真正重新渲染到对应 diff 才恢复为有效。
  文件从 Git 状态中消失时，其评论直接判为过期。

## 五、工作区隔离方案

- 评论作用域由 `gitConversationScope()` 与 `S.cwd` 共同决定，
  与 Changes 的 `X-Pi-Gui-Conversation` 请求来源是同一份事实，没有第二套身份。
- 作用域变化（`pi-gui:git-scope`、`pi-gui:workspace-generation`、
  `pi-gui:session-switch`）时立即清空展开状态、未保存草稿和汇总弹窗；
  经典会话切换额外立刻移除旧评论标记并禁用「审查意见」按钮，
  避免 `S.state.sessionId` 尚未追上时短暂显示旧会话计数。
- 迟到响应：diff 请求返回后仍校验 `surface.isCurrent()` 与 `scopeRevision`，
  不一致直接丢弃，不重绘、不调色。
- 切换 Browser / 关闭右栏：随 `mountChangesPanel()` 的 `onDispose` 释放面板与监听器；
  已保存评论留在各自作用域的内存桶中，回到该作用域可继续看到。
- 「填入当前会话」在写入前再次比较页面记录的作用域与当前作用域；
  经典视图校验 `bridgeState/stopping/switching`，Runtime 视图校验
  `runtime-conversation[data-conversation-id]` 与输入框归属，任一不一致即拒绝填入。
- 反馈文本只含项目相对路径、分区、行号、行类型、截断后的单行代码和评论正文，
  不含绝对路径、整份 Diff 或其他会话内容。

## 六、定向测试（实测）

运行环境：Windows / Node 24，`NODE_PATH=C:\pi-GUI\node_modules`；
Electron 夹具使用 `T3A_TEST_NO_SANDBOX=1`，证据目录指向仓库内 `C:\pi-GUI\.t3a-run\`。
跳过断言不计入分子分母。

| 命令 | 结果 |
| --- | --- |
| `node tests/diff-comments.cjs` | 44/44 |
| `node tests/diff-comments-ui.cjs` | 37/37 |
| `node tests/diff-comments-split.cjs` | 10/10 |
| `npm run test:diff-comments` | 91/91（44+37+10） |
| `node tests/git.cjs` | 161/161 |
| `node tests/runtime-changes.cjs` | 60/60 |
| `node tests/runtime-git-ui.cjs` | 6/6 |
| `node tests/split-workbench-ui.cjs` | 30/30；skipped=0 |
| `node tests/specs.cjs` | 18/18；skipped=0 |
| `node tests/smoke.cjs` | 1338/1338（与基线同一数量，无断言减少） |
| `node tests/diff-comments-electron.cjs` | 41/41（production 27 + native 14） |
| `npm run build:app -- --rebuild` | 退出 0；`dist-app\Pi GUI-win32-x64`，328.7 MB |
| `npm run fixtures` + `node tests/app-check.cjs` | 26/26 |

构建产物核对：`dist-app\Pi GUI-win32-x64\resources\app\public\diff-comments.js`
（12564 B）与 `review-fill.js`（3890 B）均存在，且为最后几处修复后的重建结果。

完整 `npm test` 见第七节（单次命令，退出 0，失败 0）。

## 七、完整 `npm test`

命令：

```powershell
$env:NODE_PATH='C:\pi-GUI\node_modules'
$env:Path='C:\pi-GUI\node_modules\.bin;'+$env:Path
$env:ESBUILD_BINARY_PATH='C:\Users\21022\.codex\tmp\esb2\esbuild.exe'
$env:TEMP='C:\Users\21022\AppData\Local\Temp'; $env:TMP=$env:TEMP
npm test
```

结果：**单次命令跑完全部 169 个叶套件，退出码 0，失败 0**，日志 9369 行保存在
`C:\Users\21022\.codex\tmp\t3a-full\npm-test-canonical.log`。

与本轮相关的套件数字：

| 套件 | 结果 |
| --- | --- |
| `test:ci`（ci-test-plan / ci-workflow / release-ci-proof / nsis-bootstrap） | 169 leaves across 5 groups；coverage exact |
| `test:specs` | 18/18；skipped=0 |
| `test:diff-comments` | 91/91（44+37+10） |
| `split-workbench-ui` | 30/30；skipped=0 |
| `git.cjs` | 161/161 |
| `worktrees.cjs` | 56/56（真实 Git 夹具） |
| `native-provider-quota.cjs` | 53/53 |
| `runtime-changes.cjs` / `runtime-git-ui.cjs` | 60/60 / 6/6 |
| `smoke.cjs` | 1338/1338（与基线同数） |
| `electron-guard.cjs` / `modules.cjs` | 123/123 / 119/119 |
| `planner` / `reviews` / `review-gate` / `verification` / `evidence` / `attempt-lifecycle` | 均通过，未出现失败标记 |
| `session-revert-*`、`Object *` 系列 | 全部通过；`sacl-witness` 0/0 skipped=8、`inplace` 28/28 skipped=2、`Object witness` 0/0 skipped=8 为环境限定跳过，不计入分子分母 |

日志中 `AssertionError` / `ERR_ASSERTION` / `not ok` / `npm error` 出现次数为 0。
跳过的断言不计入分子分母，因此与其它机器上的 `N/N` 不必然相同。

### 让完整套件跑通的两个环境设置

1. **esbuild 只能写仓库内目录。** 本机 `C:\pi-GUI\node_modules\@esbuild\win32-x64\esbuild.exe`
   在仓库外任何位置（用户 TEMP、`C:\Windows\Temp`、`C:\ProgramData`、`C:\temp`、
   `subst` 盘、junction）写输出都返回 `Access is denied`。解决办法是把 esbuild 可执行文件
   复制到一个普通目录并以 `ESBUILD_BINARY_PATH` 指向它（二进制位置变了，行为一致），
   而不是把 TEMP 塞进仓库。
2. **TEMP 必须留在仓库外。** 如果把 TEMP 指到 `C:\pi-GUI` 子树内，
   `tests/worktrees.cjs` 的「非 Git 项目」fixture 会落在父仓库里，
   `git rev-parse --show-toplevel` 返回仓库根，于是报 `storage_inside_project`
   而不是期望的 `not_git`。这是夹具对环境形状的敏感，不是产品缺陷；
   上面第 1 条解决后，TEMP 留在 `%LOCALAPPDATA%\Temp`，该套件 56/56 通过。

### 仍然存在的环境限制（必须一并阅读）

1. Electron 主进程连 `--version` 在本机都会因 sandbox 返回 `0x80000003`；
   夹具使用 `--no-sandbox`。产品 sandbox 配置未改，本轮**不构成真实沙箱运行证明**。
2. Windows WGC 整窗截图被拒、PrintWindow 返回黑图。交付的是 renderer 截图
   与 native `WebContentsView` 截图分别真实捕获的两张图，不是整窗合成图。
3. 上述 `ESBUILD_BINARY_PATH` 只对当前测试进程生效，未写入仓库、脚本或 CI 配置。

## 八、真实 Electron 截图

证据目录：`docs/evidence/t3-a-diff-comments/`（`results.json`：checks 41、failed 0，
Electron 44.4.3 / Chrome 152.0.7977.130；夹具为临时 Git 仓库 + 假 pi shim，
不使用真实用户项目或真实模型）。

- `01-single-panel-changes.png`：单面板 Changes 基线。
- `02-two-line-comments.png`：同一文件两条行级评论（含编辑区与行标记）。
- `03-review-summary.png`：按文件归类的审查意见与反馈预览。
- `04-fill-composer.png`：填入当前会话后输入框内容（未发送）。
- `05-stale-comments.png`：Diff 内容改变后的「原位置已变化」。
- `05-unverified-after-refresh.png`：刷新后尚未重新渲染的「待重新确认」。
- `06-changes-{1536,1200,900,720}.png`：四档窗口宽度，标题带操作不被裁切。
- `07-specs-changes-split.png`：Specs + Changes 分屏中的行级评论。
- `08-browser-changes-split.png` / `08-browser-changes-split-native-page.png`：
  Browser + Changes 分屏的界面与原生页面。
- `09-browser-split-comment.png` / `09-browser-split-comment-native-page.png`：
  分屏中评论与原生视图共存。
- `10-browser-split-fallback.png`：窄窗口降级。

Electron 夹具断言（41 条）覆盖：行号槽可点击与键盘操作、保存/编辑/删除、
汇总复制与只读预览、填入不覆盖草稿且不发送、刷新后过期与待确认、
四档宽度下所有标题带按钮均在 48px 内且不换行、Specs + Changes 与
Browser + Changes 两种分屏、弹窗遮挡时原生视图 detach、窄窗回退，
以及多次开关后无残留监听器。

## 九、回归证据

- Git / Diff：`tests/git.cjs` 161/161；`tests/runtime-changes.cjs` 60/60；
  `tests/runtime-git-ui.cjs` 6/6。Changes 的文件数、增删统计、Diff 展开、
  上下文数量、截图与原有撤销路径行为未变。
- 分屏：`tests/split-workbench-ui.cjs` 30/30；`tests/diff-comments-split.cjs`
  10/10（评论在分屏 dispose/reopen 后仍属原作用域，监听器不累积）。
- Planner / Review：未改 `server/planner*`、`public/planner*`、Review Gate、
  Verification、Attempt 或历史冻结 Diff；完整 `npm test` 中相关套件结果见第七节。
- Browser：未改 `electron/browser-*`、`public/browser-pane.js`、
  Agent Control 权限与 Session 策略；native 分屏行为由 T2-B 套件与本轮 Electron
  夹具共同覆盖。
- 会话：`runtime-conversation.js` 只增加一个 `data-conversation-id` 属性，
  用于填入前身份核对，不改变渲染与事件。

## 十、独立复审

由独立上下文的复审 Agent（Maxwell）对本轮完整 diff 做了一轮功能/边界审查，
提出的问题均已修复并补测：

1. **截断 Diff 误判过期**：原实现用截断后的行清单做 reconcile，会把整节评论
   错误标成「原位置已变化」。改为截断时只显示提示、完全不动状态。
2. **只读查询淘汰作用域桶**：计数/汇总等读操作原本可能创建桶并触发淘汰，
   导致其他作用域的评论丢失。改为读操作不创建、不淘汰；只在写入时回收空桶，
   满 20 个非空作用域时拒绝新评论。
3. **经典会话切换计数残留**：`S.state.sessionId` 追上之前会短暂显示旧会话计数。
   新增 `suspendReviewSurface()`，切换瞬间清标记、禁用按钮，刷新后恢复。
4. **干净工作区未标缺失路径**：`!c.files.length` 早退分支漏掉
   `markMissingPathsStale([])`，会让已删除文件的评论保持「有效」。
5. **草稿尾随空白被改写**：填入逻辑曾对原草稿 `trimEnd()`，
   静默修改用户输入。改为原样保留再追加分隔。
6. **窄右栏标题带裁切（真实视觉阻断）**：右栏约 540px 时「审查意见 / 刷新」
   换行并溢出。`ui4-pane.css` 改为标题带单行、≤620px 隐藏副标题；
   Electron 测试新增「每个按钮都在标题带内且标题带高度 ≤48px」断言。

复审未发现未处置的阻断项。自动检查不能代替用户审批。

## 十一、已知限制

- 评论只在内存中，重启即失；这是本阶段的明确设计，不是缺陷。
- 同一行只允许一条评论；不支持区间评论、回复串、多用户并发合并。
- 截断的超大 Diff 不提供锚点；需调大 `PI_GUI_GIT_DIFF_MAX_BYTES` 后重开。
- 「填入当前会话」只做追加，不做去重；重复点击会重复追加。
- 反馈文本上限 12000 字，超出时明确标注截断，不静默丢弃。
- 未覆盖：真实 DPI 全组合、真实 Pi/模型并发、整窗原生合成截图、
  真实 Windows 沙箱运行证明。
- 完整 `npm test` 在本机依赖第七节的两个环境设置（esbuild 可执行文件位置、
  TEMP 留在仓库外）；这些设置未写入仓库。

## 十二、回滚方法

本轮全部改动集中在前端与测试，可用一次 revert 完整回滚：

```powershell
git revert --no-edit <本轮的三个本地提交>
```

或按文件回滚而不动历史：

```powershell
git checkout 724bd48 -- public/diff.js public/git.js public/runtime-conversation.js `
  public/styles.css public/ui4-pane.css package.json
Remove-Item public/diff-comments.js, public/review-fill.js
```

随后必须 `npm run build:app -- --rebuild` 重建 `dist-app`，否则旧产物仍带新界面。
回滚不影响 Pi、会话存储、Planner 或 Browser，因为它们都没有被修改。

## 十三、T3-B 建议

1. 持久化评论到受控数据目录（按 scope + 路径 + 锚点版本存 JSON），
   仍不写用户项目与 Git；补迁移与损坏降级。
2. 支持区间评论与「应用到建议补丁」的预览，但仍由用户确认后才交给 Agent。
3. 引入 diff 版本历史，让过期评论能显示「原行 → 当前行」的候选映射，
   而不是只给一个过期标记。
4. 为多窗口/多实例提供评论同步（目前每个窗口各自内存，互不可见）。
5. 把审查意见导出为可粘贴的 Markdown 或 PR review 草稿格式。
