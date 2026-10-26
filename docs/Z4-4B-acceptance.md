# Z4-4B 验收材料：协同图形编辑工具正式集成（自动布局 / SVG-PNG 导出 / 面板接入）

- 目标与交付：B1 自动布局（左右/上下、预览确认、CAS 保存、撤销、超限提示）、B2 SVG/PNG 导出
  （用户触发下载、双主题、中文长文本、不写项目目录）、B3 面板与 UI 接入（复用 adapter、最小改动面）、
  测试注册与执行、产物重建——全部完成。未交付：Electron 专项实测（本会话环境阻断，已补真实 Chromium
  浏览器验证并留证，Electron 入口待可启动环境重跑）；完整 canonical `npm test` 按任务约定留待合并后。
- 身份：before HEAD `6a8dc6b3aee87a3e505487cf17e73ad0e6bda20a`（Z4-4A 交付提交）；
  after HEAD `4c02a2c`（真实 Chromium 证据提交）；本报告交付提交以
  `git log -1 --format=%H -- docs/Z4-4B-acceptance.md` 解析。
  分支 `codex/z4-4b-integration`（基于本地 Z4-4A 分支，未基于未合并的 Z4-3）；
  工作区 `C:/Users/21022/.codex/worktrees/z4-4b-integration/pi-GUI`。
- 环境说明：Worktree 的 `node_modules` 为主仓库目录联接（既有惯例，零下载）。

## 一、提交与修改文件

| SHA | 内容 |
| --- | --- |
| `46dd0c9` | B1/B2/B3 集成：collab-panel.js 挂载 adapter（与画布共用意图补全路径 submitIntents、
onExport 用户下载、提示合成、生命周期销毁）；adapter 增加布局方向与导出背景选择器；index.html 引 CSS；
新增 tests/collab-panel-productivity.cjs；package.json 注册测试 |
| `3340dce` | Electron 验收 runner/fixture（自包含 loopback、正常沙箱、真实 canvas PNG）+ 本次环境阻断取证 |
| `4c02a2c` | 真实 Chromium 浏览器补充验证通过 + 三处夹具修正 + 全部证据文件 |
| （本提交） | docs/Z4-4B-acceptance.md |

`git diff --name-status 6a8dc6b..HEAD` 的非新增文件：`package.json`、`public/collab-panel.js`、
`public/index.html`（三处修改均在任务 B3 允许范围内）。新增：`tests/collab-panel-productivity.cjs`、
`tests/collab-productivity-electron.cjs`、`tests/fixtures/z4-4b-productivity-electron.cjs`、
`docs/assets/z4-4b/*`（6 个证据文件）。Z4-4A 的模块与测试仅在 collab-productivity.cjs 上做了
正式化更新（去掉原型标注、补选择器行为断言）。

## 二、功能完成情况

- **B1 自动布局**：工具条位于画布与建议区之间；「布局方向」选择从左到右/从上到下；
  点击后先展示预览（移动数、基线版本），确认才经 `onOperations` → 与画布完全相同的
  意图补全（opId/baseRevision/actor=user）→ 既有 `request('operations')` 通道提交，
  服务端 CAS/Owner 校验全部保留（jsdom 测试断言 `X-Pi-Gui-Owner` 头与单批原子性）；
  取消零提交零变化；60 节点超限给明确提示并禁用确认，无部分提交；布局后画布「撤销」
  经服务端 editor 历史恢复原坐标（jsdom 与真实 Chromium 均验证）。
- **B2 导出**：SVG/PNG 按钮由用户点击触发；下载经 `a[download]`（SVG 用 Blob URL 并在
  点击后 revoke，PNG 用 dataUrl），文件名 `标题-r版本.扩展名`（非法字符过滤），不写项目
  目录、不改文档；浅色/深色/透明三背景选择；中文与长文本折行由模块保证；无外部资源、
  无新依赖。真实 Chromium 下：深色 SVG 含 #151515 与中文标签，浅色含 #ffffff 且无
  外部引用，PNG 魔数与 IHDR（1512×320=紧凑布局×scale2）核验通过、20338 字节。
- **B3 面板与 UI**：复用 `mountCollabProductivity`，未重写画布；窄窗口 760px 工具条
  flex-wrap 换行（截图留证）；Classic/Runtime 隔离沿用面板既有 invalidate
  （jsdom 断言 session-switch 同步销毁工具条，既有 panel 套件无回归）；面板关闭/重开、
  项目/会话切换走既有生命周期（onDispose 销毁）；busy/只读禁用（jsdom 断言）；
  连续/重复点击零重复提交（jsdom 断言）；导出失败（环境缺失）报错可恢复重试成功
  （jsdom 断言）；与建议预览 UI 共存（DOM 顺序断言 + 既有 collab-panel 套件回归）。
- 发现并修复的产品缺陷：adapter「导出完成」通知会覆盖面板「已开始下载」状态——
  面板改为把下载去向并入同一条状态并区分失败（46dd0c9 内）。

## 三、测试证据（HEAD `4c02a2c` 实测）

环境：Windows 10.0.26200 x64、Node v24.22.1、Git Bash。

| 证据层 | 命令 | 退出码与实测结果 |
| --- | --- | --- |
| 本地定向（canonical 链注册后全链） | `npm run test:collab` | 0；末段输出：Collab service 13/13(58)、Collab HTTP 7/7(28)、collab-canvas 72/72(72)、Collab panel 11/11(58)、collab-auto-layout 51/51(51)、collab-layout-preview 44/44(44)、collab-export 48/48(48)、collab-productivity 39/39(39)、Collab panel productivity 14/14(58)；含前段 prototype/doc/store/authority 全绿 |
| 面板集成专项 | `node tests/collab-panel-productivity.cjs` | 0；14/14；断言 58（预览→单批保存→撤销恢复、取消、重复点击、超限零提交、CAS 冲突只读、busy、会话切换销毁、SVG 下载与失败恢复） |
| 打包产物（ELECTRON_RUN_AS_NODE，可运行） | `npm run test:collab:packaged` | 0；Z4 packaged 28/28 |
| 产物重建 | `npm run build:app -- --rebuild` | 0；dist-app 产物含 collab-productivity.css / 全部新模块 / index.html 引用 / collab-panel.js 集成代码（逐一核验） |
| 真实 Chromium 浏览器（补充） | 共享装配页 + 浏览器自动化（loopback 127.0.0.1） | 通过；明细见 [chromium-results.json](assets/z4-4b/chromium-results.json)：预览零保存、确认单批（坐标 40/292/544）、撤销恢复、双主题 SVG、PNG 魔数+IHDR、超大画布正确失败、窄窗口换行；截图 2 张、SVG 2 份、PNG 1 份入库 |
| Electron 专项 | `npm run test:collab:productivity-electron` | **未验证（environment-blocked）**：本会话无法启动任何 Electron 进程（最小 `electron --version` 亦退出 0x8000003/3；白名单环境、清除 CHROME_CRASHPAD_PIPE_NAME、cmd start 均无效；既有 `test:collab:electron` 同会话同样失败，证明为环境阻断而非本轮代码问题）。runner 按仓库惯例落 [results.json](assets/z4-4b/results.json)（environment-blocked）且退出码 1。在可启动 Electron 的普通终端重跑该命令即可产出 Electron 版截图与 PNG |
| 完整 canonical | `npm test` | 未运行（按任务三约定留待与 Z4-3 合并后或 PR CI；本轮以 test:collab 全链 + packaged + 构建 + 双轨 UI 验证覆盖） |
| UI 截图 | 真实 Chromium 2 张 | [z44b-chromium-preview-wide.png](assets/z4-4b/z44b-chromium-preview-wide.png)（预览面板）、[z44b-chromium-narrow-760.png](assets/z4-4b/z44b-chromium-narrow-760.png)（760px 窄窗口换行）；Electron 版截图待重跑 |

## 四、与 Z4-3 的冲突检查

- 文件交集：`package.json`、`public/collab-panel.js`（`git merge-tree --write-tree` 退出码 1，
  冲突恰为这两个文件；其余全部新增文件零交集）。
- 解决方式（合并 Z4-3 时）：
  1. `package.json` 的 `test:collab` 行：两侧都是追加套件，合并为并集
     （Z4-3 的 proposal-queue/source/agent-flow/panel-agent + 本轮 5 个套件）。
  2. `collab-panel.js`：Z4-3 加了 agentRow（指令输入+生成按钮）、generating/polling 状态与
     render 文案分支；本轮加了 productivityHost、submitIntents 抽取、下载与提示合成、
     两处生命周期销毁。合并时保留双方：`body.append(status,controls,agentRow,canvasHost,
     productivityHost,proposalHost,source)`；canvas 的 onOperations 统一走 submitIntents
     （或保留 Z4-3 内联块再让 productivity 复用，二选一）；invalidate/onDispose 增加
     `productivity?.destroy()`；render 保留 Z4-3 的 generating 文案并追加 productivity 更新。
  3. 合并后按任务要求**在合并代码上重跑** `npm run test:collab` 与两个面板套件，
     并核对 busy 与 Z4-3 的 generating 旁路互不干扰（本轮工具条 busy 只读面板 busy 位）。
- Z4-3 工作区（`z4-3-agent-collaboration`）本轮零访问零修改。

## 五、后续同步 main 的具体步骤

1. 等待 Z4-3 合入 main（用户授权后）。
2. 从新 main 建 Worktree，`git merge codex/z4-4b-integration`，按上节解决两处冲突。
3. 重跑 `npm run test:collab`（现含 Z4-3 + 本轮全部协同套件）。
4. 在可启动 Electron 的环境跑 `npm run test:collab:electron`（既有全量冒烟）与
   `npm run test:collab:productivity-electron`（本轮专项），把 results.json 与截图入库。
5. 视需要跑完整 `npm test`，然后按 REVIEW 走审查与用户合并/发布决策。

## 六、未验证事项与残余风险

- Electron 专项（正常沙箱窗口内的预览/导出/截图）：环境阻断，待重跑；已有真实 Chromium
  浏览器同等验证兜底，且 Electron 夹具与 runner 已就绪并 require-safe。
- 打包产物的真窗口 UI 实测未做（同因 Electron 阻断）；packaged 套件（RUN_AS_NODE）已过。
- 完整 canonical `npm test` 未运行（任务约定留待合并后/CI）。
- 大图（>50 移动）自动整理仍为明确 over-limit 状态（Z4-4A 既定边界，未变）。

## 六·补：Z4-3 合并后的集成核对（2026-10-26 追记）

Z4-3 已经 PR #32 合入 main（`942fe6f`）。按第五节步骤执行集成核对：

- 从 `942fe6f` 建 Worktree 与分支 `codex/z4-4b-main-merge`，`git merge codex/z4-4b-integration`。
- 冲突与预测完全一致，仅 `package.json` 与 `public/collab-panel.js` 两处，按第四节方案解决
  （测试链并集；agentRow 与 productivityHost 并存、状态变量与销毁行并集），合并提交 `fb8896a`。
- 合并代码上 `npm run test:collab` **退出码 0**，三套面板视角并存全绿：
  Collab panel 11/11(58)、Collab panel agent 8/8(87)、Collab panel productivity 14/14(58)；
  另 Collab production document 56/56(135)、store 53/53(149,skip 1)、authority 24/24(68)、
  service 13/13(58)、HTTP 8/8(41)、canvas 72/72(72)、auto-layout 51/51、layout-preview 44/44、
  export 48/48、productivity 39/39，以及链前段的 prototype/doc/proposal-queue/source/agent-flow 全绿。
- Electron 在核对会话中仍无法启动（`electron --version` 退出码 3，与 3340dce 取证相同），
  专项重跑指引不变；完整 canonical `npm test` 仍按约定留待 PR CI 或用户指示。

## 六·补 2：最后一轮定向修复（2026-10-26，提交 `2bacb30`）

修复提交 `2bacb30`（基于 `f56ea8d`），四项修复均以红绿回归驱动（新断言修复前红、修复后绿）：

1. **布局确认门控**：确认按钮受 busy/只读/会话状态禁用；`confirmLayout` 增加 usable 守卫；
   `onOperations` 返回 `false`（宿主未受理，panel `submitIntents` 现返回受理布尔）时保留预览、
   给出 warn 提示、不显示提交成功。回归：busy/只读期间确认禁用且点击零提交、解除后恢复；
   拒收后预览保留且回调仍收到一次意图。
2. **导出版本绑定**：`runExport` 开始时绑定 `{documentId,revision,title}` 快照随结果透出，
   面板文件名改用该快照（策略：使用原始快照而非取消旧导出）。回归：异步 renderer 挂起期间
   文档 revision+5 且改标题，结果与文件名仍绑定开始时快照，内容不含改后标题。
3. **Blob URL 生命周期**：不在 click 内同步 revoke；登记后 60 秒定时器兜底释放，
   `invalidate`/`onDispose` 立即释放全部未决 URL。回归：导出后 URL 未提前释放、
   存在 ≥30s 清理定时器且回调最终释放、会话切换立即释放第二个未决 URL。
4. **只读图形预览**：预览面板按建议坐标渲染静态 SVG（节点矩形+文字、连线，纯 textContent，
   无事件、无新协议、不改权威文档）；取消/确认/版本变化/销毁时随预览清理。回归：
   预览 SVG 3 节点 2 连线含文字与 aria-label、无交互元素，取消/版本变化/销毁均清理。

实测（HEAD `2bacb30`）：

- `npm run test:collab` 退出码 **0**：Collab panel 11/11(58)、**Collab panel agent 8/8(87)**（Z4-3
  流程无回归）、Collab panel productivity **14/14(断言 71，原 58)**、collab-productivity
  **60/60(60，原 39)**、canvas 72/72、auto-layout 51/51、layout-preview 44/44、export 48/48，
  及链前段 prototype/doc/store/authority/service/HTTP/proposal-queue/proposal-source/agent-flow 全绿。
- 真实 Chromium 浏览器：新图形预览渲染正确（3 矩形 2 连线、aria-label「自动布局预览图」、
  含节点文字），取消后即时清理；截图 [z44b-graph-preview-1200.png](assets/z4-4b/z44b-graph-preview-1200.png)。
- `npm run build:app -- --rebuild` 退出码 0；dist-app 产物核验含 `renderPreviewGraph`/
  `scheduleRevoke` 修复代码。
- **Electron 专项：环境阻断（未通过）**——本轮再次尝试 `npm run test:collab:productivity-electron`
  （exit 1，夹具未能启动，results.json 已更新 environment-blocked 取证）与既有
  `npm run test:collab:electron`（exit 1，同样 0x8000003 崩溃）；最小 `electron --version`
  亦退出码 3。两个 runner 在本会话的失败形态一致且发生在进程启动前，属环境阻断而非本轮代码
  问题；按任务要求不以普通 Chromium 浏览器结果替代 Electron 结论，Electron 版仍需在可正常
  启动 Electron 的终端重跑上述两条命令。
- 完整 canonical `npm test` 依任务约定留给 PR CI。

剩余风险：与第六·补一致（Electron 真窗口实测、完整 canonical、大图 over-limit 边界）。
- 该分支仅为本地集成核对，未 push、未合并 main；用户合并/发布决策另行。

## 七、回滚方法

- 合并前：删除 Worktree 与分支即可，main 与 Z4-3 不受影响。
- 合并后：revert 对应合并提交；无数据迁移、无存储格式变化；协同文档字节不受影响；
  前端回滚仅需同时回退 index.html 一行 CSS 引用。dist-app 为本地构建产物（gitignored），
  回滚代码后重跑 `npm run build:app -- --rebuild` 即恢复旧产物。

## 八、结论

- 开发完成：是（B1/B2/B3 + 测试注册 + 产物重建，见第一、二、三节）。
- 代码验收通过：未验证（等待独立审查与 Z4-3 合并后的统一核对）。
- 允许合并：未授权。
- 允许发布：未授权。
- 本轮仅本地提交（4 个），未 push、未建 PR、未合并、未发版；Z4-3 工作区与主仓库均未改动。
