# P32.4 Multi Session UI：实施与验收记录

日期：2026-10-06。状态：**已完成 P32.4-A 与 P32.4-B，C–E 未开始**；不宣告 P32.4 通过，由用户交 ChatGPT 复验。

## 一、接手基线与分支

- before HEAD：`cbee9b83ef13efa5ac2dc67e784785044ad4030b`（`main`，已包含通过验收的 P32.3）。
- 已核实 `main` 的提交图：P32.3 验收 HEAD `e2cfe088feeb6172a9458215c3c8b6630525e9f0` 是 `main` 的**祖先**（`git merge-base --is-ancestor` 为真），`origin/main` 与本地一致。
- 基于 `main` 新建分支：**`codex/p32-multisession-ui`**（不在旧 P32.3 分支上继续）。
- after HEAD：以 `git rev-parse HEAD` 为准（本文件所在提交即最终 HEAD，不写死自引用哈希）。
- 未合并 main、未发版、未开始 P32.5。

> **需要如实指出的一点**：`main` 目前**没有观察到绿色 CI**。最后一次运行是 `cancelled`（重跑被并发组取消），再上一次是 `failure`：Node 24 job 停在 `tests/session-runtime.cjs` 的 `fixture_timeout`，Node 22 job 撞上 workflow 的 25 分钟作业上限。这与「P32.3 已验收通过」的表述有出入，我按事实记录，不阻塞 P32.4。

## 二、本次交付范围（重要）

任务书建议内部按 P32.4-A → E 拆分，并写明「验收后再继续」。本轮完成 **A** 与 **B**，各自都做完整（实现 + 确定性测试 + 真实 Electron 验证 + 截图）。

C–E **未开始**，原因见第七节。这是刻意的分阶段交付，不是遗漏。

## 三、P32.4-A 做了什么

### 3.1 单一事实源（先做这一步的理由）

P32.3 的 `public/runtime-store.js` 是一个纯模型（`seed` / `apply` / `history`），
`runtime-sessions.js` 里自己 `createRuntimeStore()` 建了一份实例。P32.4 要在**侧栏**
再加一个视图；如果各自建一份 store，revision / eventSequence / owner 三条防护就会被
拆成两套 —— A 视图漏掉的迟到事件会从 B 视图漏进去。

所以先新增 `public/runtime-state.js`：**只建一次** store，并把「变化广播」也放在这里
（谁 apply 谁广播一次，视图只订阅）。侧栏与 modal 现在都是同一份 store 的视图，
谁都不依赖对方。

### 3.2 侧栏集成

新增 `public/runtime-nav.js`，把并行会话渲染进**当前项目的会话区**（`.pj-sess-list`），
排在经典会话之前：

```
Runtime Fixture
  ├─ runtime-A        就绪      ← focused 时高亮
  ├─ runtime-B        运行中  ●  ← 后台完成时的 attention 小点
  └─ + 新建并行会话
```

- **归属**：只认 `GET /api/worktrees?project=…` 返回的 `projectId`（后端按 Git common-dir
  算出的稳定身份），再筛 registry 快照里 `workspace.projectId` 相同的会话。**不按标题或
  路径字符串猜归属**。非 Git 项目拿不到 `projectId` → 整块不显示（也不摆一个必然失败的入口）。
- **排序**：只按后端持久化的 `createdAt` 升序（同值时用 conversationId 兜底），
  点击与后台事件都不会让行换位。
- **状态**：一个轻量状态点（running / stopping / error / ready）+ 一行小字；
  attention 只是一个 6px 小点。**不显示** runtimeId / runtimeGeneration / workspace UUID /
  sessionId / epoch（有断言把这条钉住）。
- **不 spawn**：列出来只读快照 + worktrees，不发任何 `start`。

### 3.3 focus 语义

- live 会话：点击发**一条** `{action:'focus', owner}`，owner 是**动作触发时捕获**的完整
  owner（backendInstance/projectId/repoId/workspaceId/workspaceEpoch/conversationId/
  runtimeId/runtimeGeneration/sessionId），不是执行结束时再读「当前 focused」。
- dormant 会话：**不发 focus**（没有 live owner 可校验），更不会顺手 spawn 一个。
  只把意图交给中央视图，需要继续执行时由用户显式恢复。
- 点击不改变排序、不发 prompt/abort/start（均有断言）。

### 3.4 「新建并行会话」

是 **P32.2 `prepare`+`create` 与 P32.3 `start` 的编排**，不是第二条创建路径：
`fetchWorktrees` → `worktreeAction('prepare')` → `worktreeAction('create')` →
`runtimeSessionAction({action:'start'})`。后端返回什么就显示什么（dirty / branch 冲突 /
`runtime_limit` / `workspace_busy` 都如实呈现，前端不自己模拟）。工作区建好但 runtime 没起来时，
提示里明确说「工作区已创建，可在工作区管理里重试」，不谎报成功。

### 3.5 一处后端事实源修复

`server/runtime-registry.js` 的 `focus()` 原来**只广播新焦点那一条**，旧会话的
`item.focused` 会一直留在前端 —— 侧栏正是按这个字段画高亮的，于是会同时出现两行「当前」。
改为换焦点时把旧的那条也广播一次（焦点是单值）。这是补齐事实源，不是在前端造第二套状态。

同时给 `summary()` 增加了 `createdAt`（记录里本来就有），作为稳定排序的事实依据 ——
排序键不能由前端按「最近活动」猜，那正是「点一下行就跳位置」的来源。

## 三·B、P32.4-B 做了什么：中央的 focused conversation

### 3.6 中央会话承载

新增 `public/runtime-conversation.js`，中央多了第四种承载
（`#workspace[data-workspace-view='runtime']`）。侧栏点一行 → 中央切到那条会话，
看到它自己的输出/工具/审批，能发送、停止、重启、关闭、恢复。

- 状态一律读 `runtime-state.js` 里**同一份** store，本模块只做投影与动作，
  不缓存 text/tools/approvals。它自己持有的只有**纯视图态**：滚动位置 +
  「正在看哪条」——这两样不属于 runtime 事实，后端也不该知道。
- 发任务/停止/重启/关闭/审批应答都用**动作触发时捕获的完整 owner**。

### 3.7 draft / scroll 隔离

草稿存在 store 记录的 `draft` 上（沿用 P32.3 做法）；滚动位置按 conversationId
存在本模块的 Map 里。切 A → B → A，两边都不串 —— 有断言钉住。

### 3.8 dormant：看历史 vs 恢复 Agent

新增 `server/session-history.js`（只读解析）与 `GET /api/runtime-sessions?conversationId=…`：

- 「打开历史」只读 registry 记录里**后端持有、绑定时已证明过**的 `sessionLocator`，
  **不 spawn**，因此不占 Runtime slot（默认只有 2 个）。Renderer 只传 conversationId，
  **不传任何路径**；`sessionLocator` 也**不进 snapshot / 不进任何 SSE 帧**（有断言）。
- 「恢复会话」是**唯一**会 spawn 的路径，必须用户显式点。
- 读的是尾部（最近的消息在文件末尾），有字节上限；只取 user/assistant 的 text 片段，
  toolResult/图片/thinking/toolCall 参数一律不进 —— 与 `session-search.js` 同一取舍。
  **已知限制：只读历史里看不到工具调用。**
- 原生 locator 已失效时给明确文案，不猜 `--continue`。

### 3.9 为什么不吃经典 sessions 模块

`sessions.js` 的归属判定是「header.cwd 在**当前经典项目**里」，而并行会话的会话文件
落在各自 worktree 的 cwd 下 —— 用那条路只会得到 null。所以这里直接读 registry 里
已证明的 locator。形状判定仍只有一处（复用 `pi-compat` 的 `sessionMessageBody`）。

## 四、验证

### 4.1 确定性测试（离线，进 `npm test` 唯一入口）

新增 `tests/runtime-nav.cjs`（31 条），覆盖验收清单 A 组 + 「新建并行会话」闭环：

| # | 断言 |
|---|---|
| 1 | A/B 两条并行会话都显示 |
| 2 | 排序按后端 `createdAt`，不是字母序（fixture 故意让创建序与字母序相反） |
| 3 | dormant 会话也列出（不因休眠而隐藏） |
| 4 | 列表读取不 spawn Runtime |
| 5 | 提供「新建并行会话」入口 |
| 6 | dormant 行点击不发 focus、不 spawn |
| 7 | live 会话显示就绪态 |
| 8 | 点击只发 focus，且 owner 九个字段齐全 |
| 9 | 点击不改变排序 |
| 10 | 点击不发 prompt / abort / start |
| 11 | focused 行只有一个 |
| 12 | focus 换到 B 之后仍只有一个 focused |
| 13 | 后台完成给出 attention 提示 |
| 14 | attention 不抢 focus |
| 15 | 点击该会话后 attention 清除 |
| 16–17 | 运行中 / 错误 的状态文案 |
| 18 | 非 Git 项目不显示并行会话块 |
| 19–20 | 点「新建并行会话」打开对话框；给出可编辑的分支名默认值 |
| 21–24 | 点「创建并启动」按 **prepare → create → start** 依次发生；prepare 带真实分支名；**start 用 create 返回的 workspace.id + epoch**（不是 UI 猜的）；对话框关闭 |
| 25 | 点「取消」不创建任何东西 |
| 26 | Escape 不创建任何东西 |
| 27 | Enter 与点击行为一致（同样走完 prepare→create→start） |
| 28–29 | **prepare 失败后不 create、不 start**；**create 失败后不 start** |
| 30 | start 失败时如实提示「工作区已创建」，不谎报成功 |

> 第 19–30 条是为一个**真实 blocker** 补的：`askBranchName()` 的「创建并启动」原来写成
> `finish(null)`，任何合法分支名都被当成「取消」，`createParallelConversation()` 直接 return ——
> 按钮看着能点、实际什么都不发生。「按钮存在」这类断言抓不到它，必须真的点下去并检查动作序列。
> 修复后已用**回退验证**确认这套断言确实会红（回退 `finish(null)` → 第 21 条立即失败）。

另在 `tests/runtime-registry.cjs` 增加 1 条后端契约断言（换焦点时两侧都广播、
同一时刻只有一条 `focused`）：31 → **32**。

新增 `tests/runtime-conversation.cjs`（**26 条**），覆盖验收清单 B 组 + dormant 生命周期：

| # | 断言 |
|---|---|
| 7 | A/B 草稿分离（A 打字 → 切 B 为空 → 切回 A 仍在） |
| 8 | A/B 滚动位置分离（按 conversationId 恢复） |
| 9 | A streaming 时切 B，A 的 delta 后台继续（切回能看到迟到 delta） |
| 10 | 切到 B 后 A 的新 delta 不进 B 的 DOM |
| 11 | **旧 generation 的 delta 不进入重启后的 A**（新 generation 的正常进入） |
| 12 | 迟到的 A Stop 响应不改 B 的草稿与输出 |
| 13 | 同 approval id 按 owner 隔离：捕获 A 的确认后切 B，应答仍只发给 A；且不清掉 B 自己的审批 |
| 14 | 切到 dormant 不 spawn、不自动读历史，显示「已关闭」 |
| 14b | dormant 时发送禁用，且给出「恢复会话」「打开历史」 |
| — | 「打开历史」只发只读请求、不 spawn；历史视图标注「未被启动，不占运行名额」且禁止发送 |
| 15 | **只有显式「恢复会话」才发 resume** |
| 16 | 「关闭会话」带 captured owner；关闭后视图回到已关闭并给出恢复入口 |
| — | Stop/送任务都用完整 nine-field owner |

### 4.2 回归（本轮实测）

| 套件 | 结果 |
|---|---|
| `npm run test:runtime`（P32.3 专项 + 新增 nav/conversation） | **242/242**（registry 32、HTTP 12、store 25、UI 14、nav 31、**conversation 26**、factory 5、supervisor 24、Browser 45、Process budget 4、SSE 14、真实 Node HTTP Process 10） |
| `tests/smoke.cjs`（侧栏结构契约） | 1338/1338 通过 |
| `tests/worktrees-ui.cjs` | 16/16 passed |
| `tests/ui-ia.cjs`（P30 IA） | 12/12 passed |
| `tests/sessions.cjs` | 91 passed, 0 failed |
| `tests/session-search.cjs` | 72/72 通过 |
| `tests/hotfix-ui.cjs` | 10/10 通过 |

`npm test` 链脚本数 79 → **81**（新增 `tests/runtime-nav.cjs`、`tests/runtime-conversation.cjs`）。

### 4.3 真实 Electron（`npm run test:runtime-electron`）

**65/65 通过，16 张截图，EXIT 0**（原 36 条 + 新增 29 条 P32.4 断言）。
使用真实 Electron + production server + 临时真实 Git + fixture Pi。

新增断言（真实窗口 + 真实后端）：
- A 段：侧栏列出两条并行会话 / 提供「新建并行会话」/ 不显示 runtime 诊断身份与裸 id /
  点击不改变排序 / 点击既不 spawn 也不 stop / 关闭后仍以「已关闭」留在侧栏；
  **创建闭环**——从侧栏点「新建并行会话」、输入分支名、点「创建并启动」，
  确认 Runtime 真的起来（`lifecycle==='ready'`）、新行出现在侧栏并显示该分支名、
  能用捕获到的 owner 正常关闭。
- B 段：侧栏点一行 → **中央切到那条会话**（`data-workspace-view==='runtime'`）且经典 chat 被隐藏 /
  切到 B 草稿为空（A 草稿不串）/ 切回 A 草稿仍在 / **中央 composer 真的把任务发出去**（A 变为 running）/
  让 B 同时也在跑之后，**中央「停止」只停 A，B 仍在 running** / 离开并行会话后中央回到经典 chat。

新增截图（`.shots/p32-4/`）：`sidebar-a-running-b-focused`、`sidebar-1280x800`、
`sidebar-1920x1080`、`sidebar-zoom125`、`sidebar-dormant`、`sidebar-created`、
`sidebar-focus-a`、`sidebar-focus-a-draft`。

## 三·C、本轮修掉的两个 harness 缺陷（都曾伪装成产品故障）

1. **全局类名冲突**：中央视图一开始复用了 modal 的 `.runtime-output` / `.runtime-controls`，
   而中央的 DOM 在 modal **之前** —— 测试里的 `document.querySelector('.runtime-controls .primary')`
   命中的是隐藏的中央按钮（rect 0×0），点击落到 modal 遮罩上把 modal 关掉，
   后续表现为「`.runtime-output` 是 null」。修法：中央视图全部改用 `rtc-` 前缀自己的类名，
   并把 Electron 测试的 modal 选择器一律限定到 `#modalCard`。
2. **点击前没有滚动到可见区**：modal 卡片可滚动，元素被滚出卡片时它的 rect 落在卡片之外，
   点下去命中的是遮罩 —— 同一个「modal 莫名关掉」的现象，而且**偶发**（取决于内容高度）。
   `click()` 现在先 `scrollIntoView({block:'center'})` 再取坐标，rect 为 0×0 时直接抛明确错误。
   这一条修完，之前记录的「P32.3 段偶发失败」在本轮多次运行中不再出现。

**截图发现并修掉的视觉缺陷**：`新建并行会话` 原来直接用 `<button>` 套 `.pj-sess`，
露出浏览器默认按钮底色（深色主题下是一块白）。已补样式（透明底 + hover 用 `--hover`），
重跑后截图正常。这类问题 jsdom 断言抓不到 —— 正是仓库约定「改了 UI 必须给真实截图」的理由。

**闭环测试暴露的一处时序陷阱（测试侧，不是产品缺陷）**：第一次写闭环时在
`lifecycle === 'starting'` 就捕获 owner，随后 `close` 返回 `stale_runtime` ——
registry 在 child 就绪时会轮换 `runtimeGeneration`（见 `runtime-emit`），
starting 阶段的 owner 自然失效。改为等 `lifecycle === 'ready'` 再取 owner 即通过。
这条断言本身也因此更强：它证明的是「Runtime 真的起来了」，而不只是「注册表里多了一条」。

### 4.4 构建与打包

见第九节。

## 五、明确区分证据类型

| 类型 | 本轮有哪些 |
|---|---|
| **fixture（离线确定性）** | `tests/runtime-nav.cjs` 全部 18 条；`runtime-registry.cjs` 新增 1 条 |
| **真实 Electron** | `runtime-electron.cjs` 46 条（含 10 条 P32.4），真实窗口/真实后端/真实 Git |
| **真实 Pi** | 本轮**没有**；P32.4-A 不涉及模型调用（`runtime-live` 属 P32.3 证据） |
| **未执行** | C–E 的全部验收项（第 25–43 条）；`build:app` 与 `app-check` 见第九节 |

## 六、截图

`.shots/p32-4/`：

1. `sidebar-a-running-b-focused.png` — A focused（高亮）、B 带 attention 小点，两行并行会话 + 「新建并行会话」
2. `sidebar-1280x800.png`
3. `sidebar-1920x1080.png`
4. `sidebar-zoom125.png`
5. `sidebar-dormant.png` — 关闭 Runtime 后会话仍在侧栏、显示「已关闭」

任务书列的 11 张里，`单会话普通状态` / `Browser scoped pane` 由 P32.3 的 `.shots/p32-3/` 覆盖；
`Runtime limit confirmation`（D 未实现）、`A error`（可加但属 B 的中央视图语义）本轮**未产出**。

## 七、为什么停在 A（未做 B–E）

任务书自己写明「P32.4-A … 验收后再继续」，并规定「如果过程中发现某一步实际需要大改 P32.3
架构，停止并报告，不要偷偷扩大任务」。B 需要新设计**中央会话承载**：`#workspace` 目前只有
chat / planner / extensions 三种 `data-workspace-view`，`messages.js` 独占 `#stream`。
把「focused runtime conversation」做成第四种中央视图，牵涉草稿/滚动隔离、历史与 resume 的
分界、以及经典单会话路径的回归面 —— 这是一个独立、需要单独验收的设计决策，不适合塞进 A 里顺手做。

因此本轮**不写**「完成」，明确停在这里。B–E 的具体计划见第八节。

## 八、B–E 计划（未实施）

- **B**：已完成（见第三·B 节）。
- **C**：右栏绑定 focused conversation。Browser/Process 已有 owner scope（P32.3 完成），
  需要把 `right-pane` 的挂载从全局 `currentCwd` 改为 focused owner；Changes 需要
  focused 的 verified workspace root（后端已有 `withWorkspace`，不得接受 Renderer 传路径）。
- **D**：资源 UX（2/2 文案、第三个 Runtime 的显式确认、第四个由后端 `runtime_limit` 拒绝、
  dormant/close/resume 入口）。
- **E**：per-runtime 模型选择、thinking capability、search/history 接入、键盘/焦点/无障碍、视觉收尾。

## 九、构建与打包

本轮修改了 `public/`（新增 `runtime-state.js`、`runtime-nav.js`，改 `sessions.js`、
`runtime-sessions.js`、`styles.css`），按仓库约定**重建了产物**，未引用上一轮结果：

| 检查 | 实际结果 |
|---|---|
| `npm run build:app -- --rebuild`（A+B 之后重跑） | **EXIT 0**；`dist-app/Pi GUI-win32-x64`，入口 `Pi GUI.exe` 234.9 MB，整包 **327.7 MB** |
| 打包后端 `npm run test:app`（app-check） | **26/26 通过**，EXIT 0 |

## 十、已知限制

1. 侧栏并行会话的标题用工作区分支名（新会话还没有可读标题）；会话标题的接入属 E。
2. 点击并行会话目前只改 focus 状态（行高亮由后端广播驱动），中央视图切换属 B。
3. 「新建并行会话」用 `openModal` 要分支名，默认值 `pi-gui/p32/<8 hex>`；完整的工作区
   预检提示（源提交、dirty 提示）仍只在「工作区管理」里展示。
4. 侧栏不显示经典会话与并行会话的先后语义说明，靠视觉分组；文案属 E。
5. 未做 POSIX 真机验证。

## 十一、本轮失败样本与修复

1. **`focus` 只广播新焦点** → 前端按 `item.focused` 画会同时出现两行「当前」。
   修在事实源（`server/runtime-registry.js` 换焦点时两侧都广播），并加后端契约断言。
   不是在前端造第二套状态。
2. **「新建并行会话」按钮露出浏览器默认底色**（深色主题下是一块白）—— jsdom 断言抓不到，
   由真实截图发现。补 CSS 后重跑截图正常。
3. **测试自身的一处笔误**：先用 `conversationId`（随机 UUID）断言「两侧都广播」，
   应为 `workspaceId`。改为按 `workspaceId` 断言后通过。
