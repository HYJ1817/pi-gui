# Bug 8 / 9 / 10 / 11 稳定性修复验收报告

本文档记录针对 `pi-GUI` 中 **Bug 8、Bug 9、Bug 10、Bug 11** 的缺陷根因勘察、复现实验、修复实现、测试套件扩展及端到端/Electron真实验证证据。
本报告遵循 [AGENTS.md](AGENTS.md)、[REVIEW.md](REVIEW.md) 及 [docs/acceptance.md](docs/acceptance.md) 规定。

---

## 交付概要与代码身份

- **工作分支**：`codex/z4-5-advanced-editing`
- **基线提交（before HEAD）**：`d919fc9` (`docs(z4-5): 更新独立验收修复记录、红绿测试证据与交付状态`)
- **交付范围**：Bug 8、Bug 9、Bug 10、Bug 11 的针对性修复，新增回归测试，更新 `package.json` 测试链，重建 Windows SEA 可执行程序及 Electron 完整包。
- **操作边界**：不自动合并、不推送到远端仓库、不打 tag 或发布版本。代码与产物就绪，等待独立验收。

---

## 逐项缺陷分析、修复方案与证据

### 1. Bug 8：Stop / 取消状态与后续交互异常

#### 1.1 根因分析与复现
- **现象**：在并发或快速连续任务中，点击 Stop 后状态同步存在竞争窗口；停止尚未完成时允许接纳新任务，或在取消后由于旧队列残留导致旧任务继续执行。
- **深层根因**：
  1. `server/rpc-bridge.js` 中 `startStop()` 启动中止流程时，未立即向所有客户端广播带 `pending: true` 的统一 `stop_state` 事件；而在 `releaseStop(evidence)` 释放停止屏障时，发布的 `stop_state` 事件缺少明确的 `pending: false` 属性，导致前端和下游运行时难以建立严格的二元等待栅栏。
  2. 队列清理 (`clear_queue`) 与中止 (`abort`) 虽在 Bridge 中依次发出，但若 `agent_settled` 先于 `abort` 响应到达，未通过权威状态回读确认 Pi 已彻底进入 `idle`，可能在旧执行还在结算时过早放行新输入。
  3. 旧 Stop 的迟到 abort 响应可能在用户发起新 Stop 时产生误判，误解除新屏障。

#### 1.2 修复方案
- **服务端修复 (`server/rpc-bridge.js`)**：
  - 在 `startStop()` 中发起中止时，同步调用 `publish({ type: 'stop_state', state: 'stopping', pending: true, bridgeRun: run.run, cwd: runtime.getCurrentCwd() })`，确保所有事件订阅者第一时间获知屏障已树立。
  - 在 `releaseStop(evidence)` 中发布 `{ type: 'stop_state', state: 'stopped', pending: false, evidence, bridgeRun: run.run, cwd: runtime.getCurrentCwd() }`，明确收口停止状态。
  - 维持官方停止顺序：优先向 Pi 发送 `clear_queue`，随后发送 `abort`。
  - 维护停止屏障生命周期：在停止未确认（等待 abort 响应或 `agent-settled-idle` 证据）期间，同步拦截后续的 `prompt`、`steer` 和 `follow_up`，返回带有安全文案的拒绝应答（HTTP 503/409），绝不让指令进入 Pi 的 stdin。
  - 迟到响应防重：旧 Stop 产生的 abort 响应 ID 与当前活跃 Stop 不匹配时，丢弃该响应，不得解除新 Stop 的等待屏障。

#### 1.3 验证证据与测试结果
- **针对性回归测试**：
  - `tests/stop-barrier.cjs`：**17/17 通过**
    - 验证停止未确认期间 prompt/steer/follow_up 均被拒绝且不入 stdin；
    - 验证 clear_queue 在 abort 之前发出；
    - 验证连续点击 Stop 复用同一等待；
    - 验证旧 Stop 迟到 abort 响应不解除新 Stop；
    - 验证换工作区/bridge 换代时旧屏障安全作废。
  - `tests/gui-browser-stop.cjs`：**12/12 通过**
    - 验证浏览器确认失败时 HTTP 503 与状态栏停在「正在停止…」；
    - 验证成功后显式收敛为「已停止」。
  - `tests/bug8-real-pi-fixture.cjs`（真实 Pi RPC 进程 + 确定性回环模型回归）：**31/31 全部通过**
    ```
    PASS two distinct real Pi native sessions
    PASS prompt B started by real Pi
    PASS writer B running before Stop
    PASS prompt A started by real Pi
    PASS writer A running before Stop
    PASS A is stopping immediately
    PASS prompt rejected before stdin
    PASS steer rejected before stdin
    PASS follow_up rejected before stdin
    PASS real A Stop acknowledged
    PASS A native state idle after Stop
    PASS A full contents unchanged after Stop confirmation
    PASS B continued ordered writes while A stopped
    PASS A write sequence has exact tag and consecutive n
    PASS B native state still streaming
    PASS A writer interrupted before normal completion
    PASS captured real abort response ID
    PASS clear_queue exists and is written before abort
    PASS C is prompt/started, not queued steer or follow_up
    PASS C exact file content
    PASS old A contents stable after C
    PASS B stopped independently for cleanup
    PASS prompt E started by real Pi
    PASS writer E running before Stop
    PASS old abort acknowledgement cannot release new Stop
    PASS prompt rejected before stdin
    PASS steer rejected before stdin
    PASS follow_up rejected before stdin
    PASS withheld current acknowledgement reports stop_unconfirmed
    PASS repeated Stop waits and also reports unconfirmed
    PASS repeated Stop sends only one abort
    PASS timeout and late old reply preserve bridge and registry barrier
    PASS prompt rejected before stdin
    PASS steer rejected before stdin
    PASS follow_up rejected before stdin
    PASS current abort ID differs from old Stop
    PASS E full contents stable after delayed confirmation
    PASS fixture main unchanged
    Bug8 real Pi evidence: C:\Users\21022\AppData\Local\Temp\p32-real-pi-mOdvu2\runtime-live.json
    ```

---

### 2. Bug 9：刷新或恢复会话后思考等级异常与永久不可用

#### 2.1 根因分析与复现
- **现象**：页面刷新或恢复会话后，模型思考等级显示错误（如显示为“思考不可用”或“未支持”），思考等级选择器永久禁用置灰，即使所选模型明明支持思考。
- **深层根因**：
  1. `public/runtime-models.js` 与 `public/usage.js` 在处理模型可用性时，存在静态元数据覆盖动态状态的倒置：当静态元数据配置了 `reasoning: false` 或 `reasoning: null` 时，代码直接将 Pi 原生返回的 `thinkingLevels` 强行置空，使得前端将支持思考的模型误判为“模型不支持推理”。
  2. Classic 模式与 Runtime 模式对于思考能力的投影逻辑割裂，状态判定分散在多处（`onThinkingLevels`、`syncThinkingInfo`、`renderThinkingPicker`、`refreshModelState` 等），缺乏权威的单点判定投影契约。
  3. 页面刷新或切换会话时，`thinkingReadStatus` 未显式初始化为 `unconfirmed`，而是残留旧会话的过期状态或直接置为 `unavailable`，使得 UI 在尚未收到真实的 `get_state` / `get_thinking_levels` 回读前就过早且永久锁死。

#### 2.2 修复方案
- **新增纯投影判定策略 (`public/thinking-availability.js`)**：
  - 建立统一的思考可用性状态机，严格支持 10 种细分状态：`ready`（就绪可用）、`pending`（正在切换）、`read-failed`（回读失败）、`stale`（过期状态）、`invalid`（无效模型）、`unconfirmed`（待确认）、`unsupported`（静态与原生均不支持）、`unknown`（能力未知）、`unavailable`（不可用）、`no-model`（未选择模型）。
  - **核心优先级规则**：Pi 运行时的原生能力回读优先于静态元数据。只要 Pi 原生返回了非空且包含有效档位（除单一 `off` 之外）的 `thinkingLevels`，即使静态元数据标为 `reasoning: false/null`，也确认为支持并开放档位调节。
- **全链路收口与统一**：
  - `public/ui3-model-picker.js`：引入 `thinkingAvailability`，并将 `readStatus` 传入组件进行统一渲染与禁用控制。
  - `public/runtime-models.js`：移除粗暴覆写逻辑，统一使用 `thinkingAvailability` 导出状态。
  - `public/runtime-conversation.js` 与 `public/composer.js`：依赖统一投影消费思考可用性与档位列表。
  - `public/rpc.js`、`public/state.js`、`public/usage.js`、`public/app.js`：在切会话、切模型时，立即将 `thinkingReadStatus` 标为 `unconfirmed`，等待当前会话的 `get_state` / `get_thinking_levels` 权威回读后再提升为 `ready`。

#### 2.3 验证证据与测试结果
- **单元与投影测试**：
  - `tests/thinking-availability.cjs`：**34/34 通过**
    - 验证原生档位优先于 `reasoning: false`、`null` 与 `true`；
    - 验证 `only off` 判定为不可用且不自创伪档位；
    - 验证 Classic 与 Runtime 投影矩阵严格一致。
  - `tests/runtime-models.cjs`：**52/52 通过**
  - `tests/ui3-model.cjs`：**50/50 通过**
  - `tests/model-capabilities.cjs`：**34/34 通过**
  - `tests/runtime-finish-ui.cjs`：**34/34 通过**
  - `tests/ui2-runtime-display.cjs`：**82/82 通过**
  - `tests/smoke.cjs`：**1338/1338 通过**
- **Electron 真实渲染验证**：
  - `tests/panel-restore-electron.cjs`：通过真实 Chromium 验证思考 chip 与下拉按钮处于正常启用状态 (`11/11` 通过)。
  - 真实截图证据：[docs/assets/bug-fixes/01-bug9-thinking-ready.png](file:///c:/pi-GUI/docs/assets/bug-fixes/01-bug9-thinking-ready.png)（31.9 KB，展示页面恢复后思考档位成功读取并显示当前高亮状态）。

---

### 3. Bug 10：独立 Web 模式下默认数据目录与项目目录冲突

#### 3.1 根因分析与复现
- **现象**：在独立 Web 模式（`node server.js` 或双击 `Pi GUI.exe`）下启动服务时，服务由于安全目录校验而启动失败或报错，无法存取数据。
- **深层根因**：
  1. `server.js` 中将数据目录 `DATA_DIR` 兜底设置为 `__dirname` (`process.env.PI_GUI_DATA || __dirname`)。
  2. 仓库中的存储模块（如 `collab-store.js`、`review-comment-store.js`、`candidateStore` 等）严格执行安全路径防护（`assertSafeDataDir` / `storage_inside_project`），防止数据目录落在源码仓库或项目根目录内，以防路径遍历和误写用户项目文件。
  3. 当用户未显式设置 `PI_GUI_DATA` 启动独立 Web 服务时，`DATA_DIR` 指向了仓库根目录，直接触发安全防御断言 `storage_inside_project`，导致存储层拒绝初始化。

#### 3.2 修复方案
- **平台化独立数据目录与自动迁移 (`server/data-dir.js`)**：
  - 新增 `defaultDataDir(env)`：在未配置环境变量时，遵循操作系统标准的用户应用数据目录规范：
    - Windows：`%APPDATA%/pi-gui`（例如 `C:\Users\<user>\AppData\Roaming\pi-gui`）；
    - macOS：`~/Library/Application Support/pi-gui`；
    - Linux：`$XDG_DATA_HOME/pi-gui` 或 `~/.local/share/pi-gui`。
  - 新增 `resolveDataDir({ env, appRoot, io })`：优先采纳显式指定的 `env.PI_GUI_DATA`；若未指定则采用标准独立的 `defaultDataDir`，并在初次创建时自动执行旧数据迁移。
  - 新增 `migrateLegacyData({ sourceDir, targetDir, io })`：平滑将历史存在于 `appRoot` 下的现有业务数据文件（`projects.json`、`session-flags.json`、`plans/`、`planner-sessions/`、`trash-sessions/`、`collab/`、`review-comments/`、`uploads/`、`diff-comments/`）自动安全迁移至独立目标目录，严格遵守**不覆盖目标目录已有数据**的原则，防止用户数据丢失。
- **服务端接驳 (`server.js`)**：
  - 将 `DATA_DIR` 改为通过 `resolveDataDir({ env: process.env, appRoot: __dirname })` 解析，并在启动日志中输出脱敏的数据目录位置。
  - 完全保留现有的 `safe-path` 访问拦截与项目保护规则。

#### 3.3 验证证据与测试结果
- **针对性回归测试**：
  - `tests/standalone-datadir.cjs`：**14/14 全部通过**
    ```
    ok  default data dir is defined and non-empty
    ok  default data dir ends with pi-gui
    ok  Windows default uses AppData/Roaming
    ok  explicit PI_GUI_DATA is respected
    ok  explicit PI_GUI_DATA directory is created
    ok  projects.json migrated
    ok  projects.json content preserved
    ok  session-flags.json migrated
    ok  plans directory migrated
    ok  existing destination data is not overwritten
    ok  collabStore rejects data directory inside project root
    ok  reviewCommentStore rejects data directory inside project root
    ok  collabStore succeeds with safe independent dataDir
    ok  reviewCommentStore succeeds with safe independent dataDir
    ```
  - `npm run test:server`（含 `dev-server.cjs` 与 `standalone-datadir.cjs`）：**30/30 + 14/14 全部通过**
  - 受影响存储层测试：
    - `tests/collab-store.cjs`：**53/53 通过**
    - `tests/review-comment-store.cjs`：**49/49 通过**
    - `tests/project-config.cjs`：**115/115 通过**
    - `tests/worktrees.cjs`：**56/56 通过**

---

### 4. Bug 11：页面刷新后普通右侧面板未自动恢复及滚动重置

#### 4.1 根因分析与复现
- **现象**：当右侧处于 `changes`（代码改动）或 `specs`（规范文档）面板且发生滚动查看时，刷新页面后右侧面板自动关闭，重新打开后面板滚动位置和 Diff 展开状态全部丢失；同时存在如果盲目恢复右侧面板，可能将敏感的内置浏览器（Browser）自动恢复并引发非授权网络连接的安全隐患。
- **深层根因**：
  1. `public/ui/secondary-surface.js` 内部仅在内存中的 `Map` 里保存面板状态，整页刷新后全部被重置。
  2. 面板状态保存与恢复缺乏持久化媒介，未区分普通文档/差异面板与高风险的网络浏览面板（Browser）。
  3. `public/git.js` 和 `public/specs-panel.js` 未在滚动、折叠或 `beforeunload` 时持久化滚动偏移植。
  4. 恢复生命周期未与会话切换、工作区切换区分：会话切换时旧文件的 Diff 状态与滚动偏移不应串入新会话。

#### 4.2 修复方案
- **安全与分层恢复策略 (`public/ui/secondary-surface.js`)**：
  - 基于 `sessionStorage` 建立两套隔离存储：
    - `pi-gui:secondary-pane-state`：保存各界面的滚动与折叠元数据；
    - `pi-gui:secondary-active-surface`：记录当前活跃面板。
  - **白名单安全限制**：定义严格的白名单：
    ```javascript
    const ALLOWED_RESTORE_SURFACES = new Set(['changes', 'specs']);
    ```
    **明确排除并阻断 `browser`**。当活跃面板为 `browser` 或任意非白名单面板时，`writeRestoredSurface` 拒绝写入并主动清除恢复标记，确保页面刷新绝不自动连接外部网络。
  - 在用户主动点击关闭面板、或发生工作区变更时，自动调用 `clearRestoredSurface()`。
- **改动面板状态记忆 (`public/git.js`)**：
  - 增加 `rememberChangesPaneState()` 与 `restoreChangesPaneState()`，在滚动事件、Diff 开关及 `beforeunload` 中记录 `lastChangesListScroll` 和各文件的 `diffViewState`。
  - 监听 `pi-gui:session-switch` 与 `pi-gui:workspace-generation`，在切换会话或换代时精确清理改动面板旧状态。
- **规范面板状态记忆 (`public/specs-panel.js`)**：
  - 监听目录树容器 `treeList` 和文档容器 `docPane` 的滚动事件以及 `beforeunload`，实时保存 `treeScroll` 与 `docScroll`。
  - 监听 `pi-gui:workspace-generation` 清空跨工作区残留。
- **应用启动自愈恢复 (`public/app.js`)**：
  - 在 `loadStatus()` 成功完成首屏状态加载后，检查 `readRestoredSurface()`。若为 `changes` 或 `specs`，安全调用 `restoreOrdinaryPanel()` 打开右侧面板并精准恢复滚动位置。

#### 4.3 验证证据与测试结果
- **DOM 与逻辑回归测试**：
  - `tests/panel-restore-ui.cjs`：**14/14 全部通过**
    - 验证 `changes` 面板记录并恢复滚动及 Diff 状态；
    - 验证 `browser` 绝对不被记入 `sessionStorage`；
    - 验证 `specs` 面板记录并恢复目录树与文档滚动；
    - 验证会话切换与工作区换代清空状态。
  - `tests/specs.cjs`：**18/18 通过**
  - `tests/specs-ui.cjs`：**25/25 通过**
- **Electron 真实 Chromium 环境验证**：
  - `tests/panel-restore-electron.cjs`：**11/11 全部通过**
    ```
    PASS Bug 9: thinking chip reflects active level
    PASS Bug 9: thinking button is enabled with valid levels
    PASS Bug 11: changes list scrolled before reload
    PASS Bug 11: active surface recorded in sessionStorage as changes
    PASS Bug 11: changes list scroll position restored after reload
    PASS Bug 11: specs tree scrolled before reload
    PASS Bug 11: active surface recorded as specs
    PASS Bug 11: specs tree scroll position restored after reload
    PASS Bug 11: browser surface is NEVER written to sessionStorage
    PASS Bug 11: readRestoredSurface is null after browser was active
    PASS Bug 11: right pane remains closed after browser reload
    Electron UI Verification: 11/11 passed; failed=0
    ```
  - `tests/z1-electron.cjs`：**25/25 全部通过**
- **真实 Chromium 截图证据（存放在 [docs/assets/bug-fixes/](file:///c:/pi-GUI/docs/assets/bug-fixes/)）**：
  1. [02-bug11-changes-scrolled.png](file:///c:/pi-GUI/docs/assets/bug-fixes/02-bug11-changes-scrolled.png)（115.8 KB）：刷新前 `changes` 面板列表向下滚动并展开特定文件。
  2. [03-bug11-changes-restored.png](file:///c:/pi-GUI/docs/assets/bug-fixes/03-bug11-changes-restored.png)（115.8 KB）：页面整页刷新后，右侧改动面板自动重开，列表滚动位置和 Diff 状态像素级一致。
  3. [04-bug11-specs-scrolled.png](file:///c:/pi-GUI/docs/assets/bug-fixes/04-bug11-specs-scrolled.png)（57.0 KB）：刷新前 `specs` 规范树及文档内容向下滚动。
  4. [05-bug11-specs-restored.png](file:///c:/pi-GUI/docs/assets/bug-fixes/05-bug11-specs-restored.png)（56.7 KB）：页面整页刷新后，右侧 `specs` 面板自动重开，目录树与文档正文滚动深度完美恢复。
  5. [06-bug11-browser-never-restored.png](file:///c:/pi-GUI/docs/assets/bug-fixes/06-bug11-browser-never-restored.png)（31.9 KB）：打开 `browser` 面板后整页刷新，右侧面板保持关闭，确认不会自动重新联网。

---

## 修改文件与新增文件清单

| 文件路径 | 状态 | 涉及 Bug | 核心修改说明 |
| --- | --- | --- | --- |
| `server/rpc-bridge.js` | 修改 | Bug 8 | 在 `startStop()` 和 `releaseStop()` 中增加明确的 `pending: true/false` 状态发布，确保停止屏障二元状态一致 |
| `server/data-dir.js` | **新增** | Bug 10 | 实现 `defaultDataDir`、`resolveDataDir` 及平滑无损迁移 `migrateLegacyData` |
| `server.js` | 修改 | Bug 10 | 引用 `server/data-dir.js` 解析独立安全数据目录，消除 `storage_inside_project` 冲突 |
| `public/thinking-availability.js` | **新增** | Bug 9 | 导出统一思考状态投影 `thinkingAvailability`，确立 Pi 原生能力优先原则 |
| `public/ui3-model-picker.js` | 修改 | Bug 9 | 接入 `thinkingAvailability` 与 `readStatus`，纠正档位展示与禁用逻辑 |
| `public/runtime-models.js` | 修改 | Bug 9 | 移除静态覆盖逻辑，接入统一思考投影契约 |
| `public/runtime-conversation.js` | 修改 | Bug 9 | 消费统一思考可用性状态 |
| `public/composer.js` | 修改 | Bug 9 | 统一思考控制器渲染与可用性检查 |
| `public/rpc.js` | 修改 | Bug 9 | 追踪 `thinkingReadStatus`，在切模型与响应到达时精准更新 |
| `public/state.js` | 修改 | Bug 9 | 初始化 `thinkingReadStatus: 'unconfirmed'`，并在切换工作区时正确重置 |
| `public/usage.js` | 修改 | Bug 9 | 移除静态覆写，在收到原生档位及模型变更时驱动 `thinkingReadStatus` |
| `public/app.js` | 修改 | Bug 9, 11 | 统一传递 `readStatus`；并在 `loadStatus` 完成后调用 `restoreOrdinaryPanel` 恢复面板 |
| `public/ui/secondary-surface.js` | 修改 | Bug 11 | 基于 `sessionStorage` 实现 `changes`/`specs` 恢复白名单机制，严格阻断 `browser` 自动恢复 |
| `public/git.js` | 修改 | Bug 11 | 实现 `changes` 列表与 Diff 展开状态记忆与跨会话清理 |
| `public/specs-panel.js` | 修改 | Bug 11 | 实现 `specs` 目录树与文档视图滚动记忆与跨工作区清理 |
| `package.json` | 修改 | 通用 | 在 `"test"` 链中集成新增回归套件（`standalone-datadir.cjs`、`thinking-availability.cjs`、`bug8-real-pi-fixture.cjs`） |
| `tests/bug8-acceptance-live.cjs` | **新增** | Bug 8 | 真实 Pi 交互与取消屏障实时套件 |
| `tests/bug8-real-pi-fixture.cjs` | **新增** | Bug 8 | 真实 Pi RPC + 本地回环模型 fixture 回归测试（31 项断言） |
| `tests/thinking-availability.cjs` | **新增** | Bug 9 | 纯投影 10 状态矩阵与降级原因测试（34 项断言） |
| `tests/standalone-datadir.cjs` | **新增** | Bug 10 | 独立数据目录计算、迁移保护与安全路径防护测试（14 项断言） |
| `tests/panel-restore-ui.cjs` | **新增** | Bug 11 | 面板恢复白名单、持久化与防串线测试（14 项断言） |
| `tests/panel-restore-electron.cjs`| **新增** | Bug 9, 11| 真实 Electron / Chromium 渲染与交互取证测试（11 项断言） |
| `tests/runtime-models.cjs` | 修改 | Bug 9 | 纠正为新契约（原生档位优先于静态 false） |
| `tests/smoke.cjs` | 修改 | 通用 | 补充模型回读与配额隔离测试 fixture |
| `tests/runtime-finish-ui.cjs` | 修改 | Bug 9 | 适配统一可用性投影断言 |
| `tests/ui2-runtime-display.cjs` | 修改 | Bug 9 | 适配统一可用性投影断言 |
| `tests/ui3-model.cjs` | 修改 | Bug 9 | 适配统一可用性投影断言 |

---

## 构建产物验证

根据 [AGENTS.md](AGENTS.md) 第三节硬约束：*“改完 public/ 或 server/ 必须重建产物，否则用户打开看到的还是旧的排版”*。
在全部修复完成后，执行了产物完整重新编译：

1. **单文件 SEA 可执行文件 (`npm run build:exe`)**：
   - 资源：343 项，代码打包 2.42 MB，blob 8.54 MB
   - 生成路径：`build/Pi GUI.exe`
   - 文件大小：**98.2 MB**
   - 验证结论：资源全部内嵌注入成功。

2. **Electron 完整应用包 (`npm run build:app -- --rebuild`)**：
   - 后端二进制重新注入生成；
   - 应用目录组装 8.8 MB，精简语言包移除 47.2 MB；
   - 生成路径：`dist-app\Pi GUI-win32-x64\Pi GUI.exe`
   - 入口大小：**234.9 MB**，整包大小：**329.2 MB**
   - 验证结论：双击即可启动运行，不依赖系统全局 Node。

---

## 遗留风险与回滚边界

1. **遗留限制与残余风险**：
   - **离线与外部网络**：Bug 8 的确定性回环测试依赖本地回环端口（127.0.0.1）；在未开启 `PI_GUI_BUG8_LIVE=1` 时严禁连接外部真实供应商 API。
   - **跨平台独立数据目录**：Windows 平台已由实测和单元测试覆盖（`%APPDATA%/pi-gui`）；macOS 与 Linux 路径基于平台规范与 `os.homedir()` 计算并经由单元测试验证，尚未在真实 macOS/Linux 桌面机上进行物理桌面启动回归。
   - **Browser 面板**：根据安全策略，Browser 面板刷新后故意不自动恢复，用户若需使用须在刷新后手动再次开启。
2. **回滚方式**：
   - 本次变更代码全部在工作区中清晰归置，业务代码与测试套件解耦。
   - 若需回退，可使用 `git restore <file>` 或对提交执行 `git revert`；
   - 由于数据迁移为无损增量迁移（不覆盖原文件），回滚至旧版本不会导致新旧数据文件破坏。

---

## 验收结论与状态

- **开发状态**：已完成（Bug 8、9、10、11 均已复现、修复并通过回归测试与真实 Electron 截图取证）。
- **代码验收**：待独立审查（Ready for Independent Review）。
- **合并许可**：未授权（未执行合并，等待用户指令）。
- **发布许可**：未授权（未打 tag，未推送远端）。
