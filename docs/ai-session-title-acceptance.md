# AI 会话标题验收材料

- 目标：实现 AI 自动 / 手动会话标题，并保证**顶部标题、侧栏、搜索、Runtime
  视图、重启后的历史**始终是同一个权威答案；支持在任意会话行上独立改名，
  不需要先打开或激活目标；后台标题生成失败 / 中断 / 多模型切换时不误判首轮回复。
- 身份：本轮修复基线 `73e30cf3`（`docs(session-title): 更新验收记录为已推送状态`），
  分支 `feat/ai-session-title`。本报告所在提交可用
  `git log -1 --format=%H -- docs/ai-session-title-acceptance.md` 解析。
  本轮未合并 `main`、未创建 Release、未修改正式版本号（`package.json` 仍为
  `0.34.0`）。
- 证据范围：`73e30cf3` 之后的工作区 diff（`git diff --name-status 73e30cf3`
  加上新文件 `public/title-revision.js`）。未跟踪的构建产物、`spike/`、临时日志
  不属于本功能证据，也不进入提交。
- 修改文件：
  - 后端：`server/session-title-store.js`（持久化 revision / 原生名快照 /
    容量清理）、`server/session-title-context.js`（终态成功判定、首轮有效回复、
    尾部原生名解析）、`server/session-titles.js`（自动 / 手动 / 重命名 /
    提案共用修订契约、跨项目受信解析、HTTP 路由）、`server/session-title-sdk.js`
    （auth / models 配置指纹变化重建 worker）、`server/sessions.js`
    （大文件尾部确认原生名、`titleRevision` 投影）、`server/runtime-registry.js`
    （Runtime 标题修订）、`server.js`（接线）。
  - 前端：新增 `public/title-revision.js`（列表 / 切换应答 / SSE / Runtime store
    共用的修订门槛）；`public/session-titles.js`（事件应用、手动生成、统一重命名）、
    `public/sessions.js`（任意经典行行内改名、列表快照裁决、顶部投影）、
    `public/runtime-nav.js`（Runtime 行行内改名）、`public/runtime-store.js` /
    `public/runtime-state.js`（Runtime 标题快照与修订）、`public/usage.js`
    （`get_state.sessionName` 只在没有权威快照时占位，不再覆盖确认标题）、
    `public/session-title.js`（顶部投影只认后端裁决后的当前条目）、
    `public/app.js`（顶栏改名走同一服务）、`public/api.js`、`public/projects.js`。
  - 测试：`tests/session-title-{store,context,service,sdk,ui}.cjs`、
    `tests/session-title.cjs`、`tests/sessions.cjs`、`tests/runtime-{registry,nav,store}.cjs`、
    `tests/session-search.cjs`、`tests/sidebar-{menu,project-interaction,toggle}.cjs`、
    `tests/stable-session-order.cjs`、`tests/smoke.cjs`、`tests/modules.cjs`、
    `tests/settings-acceptance.cjs`、`tests/session-title-visual.cjs`、
    `tests/visual-harness.cjs`。
  - 文档：`docs/sessions.md`、`docs/provider-auth.md`、`docs/architecture.md`、
    `docs/testing.md` 与本文。
- 行为与安全边界（沿用并加强）：
  - 只写 `<DATA_DIR>/session-titles.json` 与
    `<DATA_DIR>/session-title-settings.json`，**从不写 Pi 的 JSONL**；
    Pi 的 `session_info` 仍由 Pi 自己维护。改名只写 pi-GUI 元数据，
    不调用 `switch_session` / `new_session` / Pi 重启 / 工具取消 / 停止 Agent。
  - Renderer 只提交稳定身份（项目路径 + 会话 id，或 conversationId）与
    `expectedRevision`；**不接受任意会话文件路径**。真实目标由后端
    `sessions.resolveProjectSession`（项目必须在受信项目列表里，header cwd
    必须精确一致）或 Runtime registry 证明。
  - 独立模型调用复用 Pi 公开 `ModelRuntime`、同一 `auth.json` / `models.json`；
    不登录、不新增 API Key、不复制供应商客户端。worker 剥离 `PI_GUI_TOKEN`，
    只回传标题文本、`stopReason` 与三个数字 usage；SDK 错误原文、stdout/stderr、
    凭据、完整回复不跨线程，也不进入日志 / 诊断 / DOM。
  - 不新增依赖；不改 Composer、思考动画、全局按钮设计、项目折叠、搜索开关、
    自动更新、Pi RPC 生命周期、供应商业务逻辑或并行执行机制。

## 一、此前验收发现的根因与本轮修复

1. **顶部与侧栏各有一个标题权威**：前端曾把 Pi `get_state.sessionName` 当成
   无条件最高优先级，于是用户确认过的 AI 标题 / 手动标题在刷新、切换或重启后
   被旧原生名顶回；侧栏与顶部会分叉。
   修复：后端统一裁决并返回 `title` / `titleSource` / `titleRevision`；
   `public/session-title.js` 只投影列表里后端裁决后的当前条目；
   `public/usage.js` 仅在**没有权威快照**时用原生名占位；`get_state` 的
   原生名变化改为触发侧栏刷新，而不是直接写顶部。
2. **修订机制不完整**：自动生成、手动生成、确认与改名没有统一的
   `expectedRevision`，旧任务 / 旧 SSE / 旧列表响应可能覆盖新标题；修订只存在
   Renderer，重启即丢。
   修复：存储持久化 `revision` 与原生名快照；所有写入携带 `expectedRevision`，
   冲突返回 `revision_conflict` 与权威标题；前端 `title-revision.js` 对列表快照、
   切换应答、SSE、Runtime store 统一按修订门槛丢弃迟到数据。A→B→A 时旧任务
   仍因 `baseRevision` 不匹配被拒。
3. **重命名只能作用于当前会话**：历史行禁用并提示「请先打开」，Runtime 没有
   手动改名入口，顶栏改名又绕过标题服务直连 Pi。
   修复：新增 `POST /api/session-titles/rename`；经典 / Runtime 全部走同一
   `session-titles.js` 服务与同一存储；当前、未打开历史、已归档、其它项目预览、
   Runtime、后台运行 / 已关闭会话都可在行内改名；顶栏改名复用同一服务，
   仅 pending（尚未落盘）当前会话保留 Pi 原生改名兼容退路。
4. **首轮失败 / 中断被误判为有效回复**：旧解析只要看到 assistant 文本就可能
   当成首轮回复，部分输出、工具过程、截断输出会污染标题素材，并可能读取后面
   无关轮次的模型选择。
   修复：只认 `stopReason`/`stop_reason === 'stop'`、无 `errorMessage` 的
   assistant 最终回复；工具过程、thinking、toolResult、`aborted` / `error` /
   `length`、缺终态字段的旧消息都不算。首轮失败时等后续第一条正常完成回复，
   provider/model 只取那条回复实际使用的值。
5. **容量与截断边界**：旧的 1000 条上限会按数量删掉有效旧标题；大文件头部读取
   被截断时可能把「尾部还有新原生名」误判为「没有改名」。
   修复：只清理「只有 attempt、没有有效标题」的记录，有效的自动 / 手动标题
   不因条数删除；头部截断时读尾部 512KB 确认最新 `session_info.name`，
   确认不到则传 `nativeConfirmed=false` 交给裁决保守处理，并**跳过自动标题**
   （后台写入不能赌「用户没改过名」），等一次完整读取或用户显式生成。
   512KB–4MB 的文件可能把 `session_info` 放在头尾两个窗口之外：这种改名会
   记录「写入时原生名未知」，后续列表确认到旧原生名时只补快照、不删除用户
   刚改的标题；Runtime 打开经典会话时写入的显示标题同样不再被误当成原生名。
   自动标题在**最终应用前**会再次要求原生名可确认：生成期间文件继续增长、
   最新 `session_info` 掉出头/尾窗口时同样放弃写入。
6. **持久化失败留下脏内存**：`writeEntry()` 先改内存再写盘，写盘抛错时
   新标题与修订号已经留在内存里，出现「提示失败 → 刷新却是新标题 → 重启恢复
   旧标题」的三处不一致。
   修复：写入前保存条目 Map 的完整快照（含 `prune` 会删除的旧 attempt）；
   持久化失败时先完整回滚再抛出，调用方仍按失败处理，同一修订可原样重试。

## 二、统一标题所有权与修订契约

**存储键**：经典 `classic:<Pi session UUID>`；Runtime `runtime:<conversationId>`。
**优先级**（`server/session-title-store.js` 唯一裁决）：

1. pi-GUI 手动标题（用户手动改名，或确认采纳的 AI 标题）；
2. Pi 原生手动名（`session_info.name`；当前确认到的原生名与手动标题记录时的
   快照一致才让手动标题继续获胜，原生名一旦变化就让旧手动快照失效）；
3. AI 自动标题；
4. 首条用户消息兜底；
5. 默认标题。

**修订语义**：每条记录持久化 `revision` 与 `nativeName` 快照；任何权威标题
或原生名变化都递增 `revision`。没有标题记录、只有原生名的会话也会在第一次
确认到原生名时建立修订锚点（之后原生名再变继续递增），避免「同修订的旧列表 /
旧切换应答」把新原生名顶回去。自动生成捕获 `baseRevision`，手动生成 / 改名 /
确认携带 `expectedRevision`；应用前重读文件核对 header id、原生名与文件身份，
并比较修订。不匹配返回：

```json
{ "ok": false, "code": "revision_conflict", "title": "当前权威标题", "revision": 7 }
```

前端 `public/title-revision.js`：权威快照 `>=` 本地修订才采纳；SSE 事件必须
`>` 本地修订（同修订只有同标题幂等）；低修订、同修订不同内容一律丢弃。
列表响应、`switch_session` 应答、Runtime store seed、SSE 都经过同一门槛。
后端列表 / 切换 / Runtime 摘要都输出 `titleRevision`，因此重启后仍从磁盘恢复
同一个答案。

**「原生名未知」不是「原生名为空」**：手动标题 / 改名 / 确认在截断且尾部
未确认的文件上写入时，`manual.nativeNameConfirmed=false`。之后完整读取或列表
确认到旧原生名，只把该名字补成新快照并保留手动标题；只有再发生一次真实的
原生改名，旧手动快照才失效。这保证「读不到」不会导致用户标题被误删。

**HTTP**：

- `GET/PUT /api/session-titles/settings`
- `POST /api/session-titles/generate`（classic / runtime）
- `POST /api/session-titles/apply`（确认提案）
- `POST /api/session-titles/rename`（本轮新增）

重命名请求体：

```json
{ "scope": "classic", "id": "0123456789abcdef", "project": "C:\\\\work\\\\proj",
  "title": "新标题", "expectedRevision": 3 }
```

```json
{ "scope": "runtime", "conversationId": "12121212-1212-4212-8212-121212121212",
  "title": "新标题", "expectedRevision": 3 }
```

`file` / `path` 等 Renderer 字段被忽略；`id` 必须是 16 位十六进制稳定 id，
`project` 必须来自受信项目列表且与会话 header 的 cwd 完全一致。Runtime 无
locator 时仍可只写显示标题（不落盘、不激活）。

## 三、任意会话重命名

- **入口**：经典会话三点菜单（AI 生成标题 / 重命名 / 归档或取消归档 / 删除会话）
  与 Runtime 行三点菜单（AI 生成标题 / 重命名）。当前、未打开历史、已归档、
  其它项目预览行均可用；pending 会话没有稳定身份，不显示菜单。
- **交互**：点重命名直接在行内出现输入框，值为当前标题、聚焦并全选；
  Enter 保存，Escape 取消，失焦保存合法改动；空白 / 未变化不提交；
  保存期间输入框禁用，重复 Enter / blur 不会发第二个请求；失败恢复原标题并
  给出可重试反馈；修订冲突采纳后端权威标题与修订，下一次重试使用新修订。
- **就地更新**：目标行、目标为当前会话时的顶栏、搜索结果、Runtime 行与
  aria-label 同步更新；不重画列表、不改变排序、不重置侧栏滚动、不重载聊天。
- **不激活目标**：后端只读会话文件 + 写标题元数据；不调用 `switch_session` /
  `new_session`，不重启 Pi，不取消工具，不停止 Agent。后台运行中的会话也
  只改显示标题。
- **兼容退路**：只有 pending（Pi 尚未落盘）的当前会话在顶栏改名时仍调用 Pi
  原生 `set_session_name`；一旦有稳定 sessionId，立即走统一元数据服务。

**外部 Pi 可见性限制**：pi-GUI 手动标题是自有元数据，不写入 Pi 的 JSONL。
因此在外部 Pi CLI 里看不到 pi-GUI 改的名字；Pi 自己仍显示它的
`session_info.name`。这是有意的安全取舍：不改正在被 Pi 写入的文件。
若用户在 Pi 里改名，原生名变化会使旧手动快照失效并按优先级重新裁决。

## 四、真实模型验证

**已确认（只读检查安装的 Pi 1.5.2）**：

- `ModelRuntime.create(options)` 接受 `authPath` / `modelsPath` /
  `modelsStore` / `allowModelNetwork` / `refreshOnCreate`；
- `getModel(providerId, modelId)` 存在；
- `completeSimple(model, context, options)` 存在，worker 使用的
  `maxTokens` / `reasoning` / `cacheRetention` / `disableContinuation` /
  `maxRetries` / `timeoutMs` / `signal` 选项在 Pi 1.5.2 的类型与打包产物中可见；
- worker 在 auth / models 文件 `mtimeMs:size` 变化后重建（离线测试 3h），
  不继续持有过期凭据或旧模型表。

**未验证（真实账户端到端）**：本轮没有得到明确的真实模型调用授权，
也没有可合法使用的隔离账户；因此**没有运行真实 provider 调用**，不能把
离线 mock / 桩当作真实模型验证。以下步骤供用户在本机执行：

1. 在 Pi GUI / pi CLI 中确认已登录（OAuth / 订阅 / 自定义 provider 任一），
   不要导出或打印 `auth.json`。
2. `npm start`（源码版）或运行 `dist-app/Pi GUI-win32-x64/Pi GUI.exe`
   （最新构建产物）。
3. 在 `os.tmpdir()` 下的临时项目新建会话，发送一条短消息并等待正常完成；
   观察自动标题是否在回复后出现，侧栏与顶栏是否一致。
4. 打开三点菜单 →「AI 生成标题」，确认若是手动标题先弹替换确认；采纳后
   刷新列表 / 切换走再回来 / 重启应用，标题不应回退到旧原生名。
5. 对未打开的历史行、已归档行、Runtime 行分别执行重命名；确认目标不切换、
   排序不变、当前会话不受影响。
6. 检查该会话 JSONL 只增加正常聊天消息，没有标题生成产生的额外消息；
   标题元数据只出现在 `<DATA_DIR>/session-titles.json`。
7. 在 Pi CLI 里 `--continue` 查看该会话：pi-GUI 手动标题不会出现在 Pi 原生
   标题里（符合上述限制）。

真实调用会消耗少量模型用量；不要在验收中批量生成或遍历供应商。

## 五、测试证据

| 证据层 | 命令 | 实际结果 |
| --- | --- | --- |
| 标题 AI 全链 | `npm run test:session-title-ai` | **273 passed, 0 failed**，exit 0：store 58、context 44、service 64、sdk 35、ui 72 |
| 顶部投影 | `node tests/session-title.cjs` | 11 组投影用例全部通过，exit 0 |
| 会话列表 / 大文件尾部 | `node tests/sessions.cjs` | **93 passed, 0 failed**，exit 0（含 4MB+ 尾部原生名、尾部无 session_info 的 safe degrade） |
| 受影响回归 | `node tests/runtime-registry.cjs` | 37/37，exit 0 |
| 受影响回归 | `node tests/runtime-nav.cjs` | 46/46，exit 0（含 Runtime 行内改名、不 focus / start、连续第二次改名使用新修订） |
| 受影响回归 | `node tests/runtime-conversation.cjs` | 110/110，exit 0 |
| 受影响回归 | `node tests/runtime-store.cjs` | 34/34，exit 0 |
| 受影响回归 | `node tests/session-search.cjs` | 72/72，exit 0 |
| 受影响回归 | `node tests/sidebar-menu.cjs` | 37/37，exit 0 |
| 受影响回归 | `node tests/sidebar-project-interaction.cjs` | 26/26，exit 0 |
| 受影响回归 | `node tests/stable-session-order.cjs` | 41 passed, 0 failed，exit 0 |
| 受影响回归 | `node tests/sidebar-toggle.cjs` | 10/10，exit 0 |
| 受影响回归 | `node tests/ordinary-session-runtime.cjs` | 7/7，exit 0（Runtime 显示种子 ≠ Pi 原生名；get_state 确认后升级） |
| 受影响回归 | `node tests/modules.cjs` | 121/121，exit 0 |
| 受影响回归 | `node tests/settings-acceptance.cjs` | 19 项全部通过，exit 0 |
| UI 全链路 | `node tests/smoke.cjs` | **1338/1338 通过**，exit 0（含当前 / 历史行内改名、Escape、统一服务请求体、旧 get_state 不覆盖确认标题、`sessionNaming` 降级不再禁用改名） |
| 真实 Electron 视觉 | `npm run test:session-title:visual` | **54/54 checks passed，exit 0**；26 张 PNG；4 组真实 CSS 视口（1320×820 dark/light、700×600 light/dark，DPR=1）；0 条 renderer console error |
| 打包产物 | `npm run build:app -- --rebuild` | exit 0；`dist-app/Pi GUI-win32-x64/Pi GUI.exe` 234.9 MB，整包 334.0 MB（最终一次构建在全部源码改动之后） |
| 完整 canonical / PR CI | 未运行 | 按本轮范围只跑定向与受影响套件；完整 `npm test` 交由 PR CI，结果出来前标记「待验证」 |
| 真实模型 E2E | 未运行 | 未授权 + 无隔离凭据；不能以 mock 冒充；本机步骤见上 |

**关键实测输出**：

- `session-title-service.cjs`：7n 路由用例证明 `POST /api/session-titles/rename`
  只接受稳定身份，Renderer 传入的 `file` / `path` 被忽略；7p 证明冲突原样带回
  `revision` 与权威 `title`；7q–7q5 覆盖 512KB–4MB 中间段（`session_info`
  不在头尾读取窗口内）的改名：写入时记录「原生名未知」，之后列表确认到旧原生名
  不会删掉用户刚改的标题，只有再发生一次真实原生改名才让手动标题失效。
- `session-title-store.cjs`：8j–8l 证明没有标题记录的原生名也会建立修订锚点、
  原生名再变时递增、未确认读取不建锚点；8m–8n 证明「写入时原生名未知」的
  手动标题在后续确认时补快照并保留，之后再改名才失效。9a–9d 证明磁盘写入
  失败时内存中的标题、修订号与 prune 删除的旧 attempt 一起回滚，失败后同一
  修订号仍可正常重试并落盘。
- `session-title-service.cjs`：7r / 7r2 证明开始生成时文件可完整读取、生成期间
  增长到头部与尾部都读不到最新 `session_info` 时，最终应用会放弃自动写入，
  不留下 auto 记录、不发标题事件、不覆盖旧快照。
- `ordinary-session-runtime.cjs`：证明 `openProjectSession` 写入的显示标题
  只是种子（`nameSource=seed`），不会被当成已确认的 Pi 原生名；只有
  `get_state` 读到原生名后才升级为 `native`。
- `runtime-nav.cjs`：Runtime 行改名成功后立即再从菜单发起第二次改名，请求体
  携带的是成功应答里的新修订（`expectedRevision=2`），不是第一次渲染时捕获的
  旧 `item`；成功应答同时就地补写 runtime store，避免中间没有事件时拿旧修订。
- `session-title-ui.cjs`：E1–E4 证明低修订 SSE、同修订不同内容、旧列表快照都
  不会覆盖新标题；E5–E18 证明空白 / Escape / 未变化不提交、保存期间切换目标
  不污染新行、冲突后重试使用新修订、历史 / 预览 / 归档 / Runtime 改名都不激活会话。
- `sessions.cjs`：2e1 证明 4MB+ 文件从尾部读到最新原生名；2e2 证明尾部没有
  `session_info` 时 `nativeConfirmed=false`。`session-title-service.cjs` 7m2
  证明同样的截断文件不会触发自动标题（不调用模型、不写 auto 记录）。
- Electron：`1320-dark-session-rename-input` / `1320-light-session-rename-input` /
  `700-light-session-rename-input` / `700-dark-session-rename-input` 展示真实
  行内输入框与选中态；`1320-dark-runtime-rename-input` 展示 Runtime 行；
  `1320-dark-session-renamed` / `1320-dark-runtime-renamed` 展示成功后标题原位更新；
  reload 后设置与改名结果都从服务端恢复。截图位于 `.shots/session-title/`，
  `results.json` 记录视口、DPR、检查项与 console errors。

## 六、未验证与残余风险

- 真实 provider / OAuth / 订阅 / 自定义 provider 的标题调用未实测；离线测试
  只证明 worker 投影、配置变化重建与错误边界。
- 完整 `npm test` / PR CI 未运行；本轮只跑直接受影响套件与定向回归。
- 真实 Electron 只覆盖 Windows 11 + Electron 源码 harness；未在打包后的
  `dist-app` 里执行真实项目 / 真实 Pi 流程（构建产物已重建，但没有以它做
  真实模型调用）。
- pi-GUI 手动标题对**外部 Pi CLI 不可见**（有意不写 Pi JSONL）；若用户要求
  双向可见，需要另行设计并取得授权，不能直接改正在被 Pi 写入的文件。
- 大文件尾部确认只覆盖最后 512KB；若最后一条 `session_info` 落在更早的位置，
  会安全降级为 `nativeConfirmed=false`，可能暂时保留旧手动标题，需要一次
  显式改名或列表刷新来收敛 —— 这是保守取舍，不是静默覆盖。
- `/api/session-titles/rename` 的跨项目解析依赖受信项目列表与会话 header cwd；
  临时不可访问的项目不会被误判为永久删除，但也无法在离线时证明最新原生名。

## 七、独立审查

- 本轮已请具备独立上下文的 Agent 复审 `73e30cf3` 之后的完整 diff（含未跟踪
  `public/title-revision.js`），重点检查修订竞态、跨项目解析、重命名目标、
  首轮失败判定、安全边界与范围保护。
- 复审结论：**阻断项 0，High 2，Medium 1，Low 2**。全部有证据的发现均已修复
  并补回归；复审在首轮完整检查后收敛，没有反复报告同类问题。
- 交付后补充复审又报告 **P1 2 条**（均为局部修复，不需要调整架构），已修复、
  补回归并重新跑受影响套件。

| 严重性 | 发现 | 处置 | 回归证据 |
| --- | --- | --- | --- |
| High | 512KB–4MB 中间段的 `session_info` 不在头/尾读取窗口内时，改名写入的 `nativeNameAt` 实际是「未知」；之后列表确认到同一原生名会被误判为「用户在 Pi 里改名」，删掉刚写的手动标题 | 手动记录增加 `nativeNameConfirmed`；未知时后续确认只补快照并保留手动标题，真正再改名才失效 | `session-title-service.cjs` 7q–7q5、`session-title-store.cjs` 8m–8n |
| High | `openProjectSession` 把 pi-GUI 自己的显示标题（种子）写进 runtime 记录的 `sessionName`，随后被当成已确认原生名；`get_state` 的原生名会覆盖手动改名，或让手动标题被错误失效 | runtime 记录区分 `nameSource: 'seed' \| 'native'`；只有 `get_state` 观察过的名字才算原生确认，`titleFor` 按此传 `nativeConfirmed` | `ordinary-session-runtime.cjs` 7/7、`runtime-registry.cjs` 37/37 |
| Medium | 只有原生名、还没有标题记录的会话没有修订锚点；列表扫描与生成之间发生原生改名时无法被检测到 | `resolve` 为已确认原生名建立内存修订锚点（rev 1），原生名再变时递增；锚点只随后续写入落盘，`prune` 可回收 | `session-title-store.cjs` 8j–8l |
| Low | 7m2「截断文件不触发自动标题」的 fixture 首轮回复无效，可能因别的原因跳过而假绿 | fixture 增加一条合法首轮回复，只让「原生名未确认」成为唯一跳过原因 | `session-title-service.cjs` 7m2 |
| Low | Runtime 行捕获的 `item.titleRevision` 可能过期，紧接着的第二次改名会带旧修订并冲突（冲突路径会带回权威修订，可自愈） | 提交时从 store 取最新 item；成功应答就地补写 store 的标题与修订 | `runtime-nav.cjs` 46/46（连续第二次改名 `expectedRevision=2`） |
| P1（补充） | `writeEntry()` 先改内存再写盘；写盘失败虽然抛错，但内存里的新标题与修订号没有回滚。界面提示失败、刷新却显示新标题、重启又恢复旧标题 | 写入前保存整个条目 Map 的快照（含 `prune` 会删除的旧 attempt），持久化失败时完整还原后再抛出 | `session-title-store.cjs` 9a–9d（失败后无新标题/新修订、旧 attempt 保留、同一修订可重试落盘） |
| P1（补充） | 自动标题只在任务开始时检查原生名可确认；生成期间文件增长可能把最新 `session_info` 推到头部/尾部窗口之外，最终写入时不再校验 | 最终应用前对 auto 再次要求 `nativeConfirmed`；无法证明原生名未变就放弃写入。手动生成/改名仍允许未确认快照 | `session-title-service.cjs` 7r / 7r2（增长后头尾都读不到 → 不写 auto、不发事件） |

- 残余：没有已知阻断项。Low 1 的冲突路径本身仍会返回权威标题与修订供前端重试，
  即使未来出现同类的过期快照也不会静默覆盖新标题。

## 八、回滚

- 回退本轮提交即可恢复旧的标题投影 / 改名行为；删除
  `<DATA_DIR>/session-titles.json` 与 `session-title-settings.json` 可清除
  标题元数据与开关，Pi 会话文件无需恢复（本功能从未写入）。
- 本轮没有数据库迁移、没有新增依赖、没有修改正式版本号。

## 九、结论与合并建议

开发与定向验收完成；统一标题权威、持久修订、任意会话重命名、首轮失败判定、
容量与截断边界均有自动化回归和真实 Electron 视觉证据。真实模型 E2E 与完整
PR CI 尚未验证，按「待验证」处理。**建议在 PR CI 通过、独立审查无阻断项后合并**；
本报告不构成合并、发版或真实模型调用的授权。
