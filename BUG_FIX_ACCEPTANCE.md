# Bug 8 / 9 / 10 / 11 稳定性修复验收报告

本文档记录针对 `pi-GUI` 中 **Bug 8、Bug 9、Bug 10、Bug 11** 的缺陷根因勘察、复现实验、修复实现、测试套件扩展及端到端/Electron真实验证证据。
本报告遵循 [AGENTS.md](AGENTS.md)、[REVIEW.md](REVIEW.md) 及 [docs/acceptance.md](docs/acceptance.md) 规定。

---

## 交付概要与代码身份

- **工作分支**：`codex/fix-bugs-8-11` (已从 `codex/z4-5-advanced-editing` 分离隔离)
- **基线提交（before HEAD）**：`d919fc9` (`docs(z4-5): 更新独立验收修复记录、红绿测试证据与交付状态`)
- **交付范围**：Bug 8、Bug 9、Bug 10、Bug 11 的针对性修复，新增回归测试，更新 `package.json` 测试链，重建 Windows SEA 可执行程序及 Electron 完整包。
- **操作边界**：不自动合并、不推送到远端仓库、不打 tag 或发布版本。代码与产物就绪，等待独立验收。

---

## 逐项缺陷分析、修复方案与证据

---

## 第二轮集成与复审摘要 (Round 2 Review & Integration Summary)

针对第一轮独立验收提出的问题与要求，在指定独立工作分支 `codex/fix-bugs-8-11` 上完成了第二轮深度补修、主线最新基线（`origin/main` v0.30.0，`8029c88`）的合并整合，以及全面端到端与真实 Electron 正常沙箱的集成验收。

### 1. 代码身份与主线整合

- **工作分支**：`codex/fix-bugs-8-11`（归属独立 Worktree，未触碰 `main`、原 `codex/z4-5-advanced-editing` 或外部 Agent 工作区）。
- **主线基线整合**：
  - 合并前落后 `origin/main` 41 个提交。
  - 获取最新 `origin/main`（HEAD: `8029c88`，版本 `v0.30.0`），执行 `git merge origin/main`。
  - 精准解决冲突文件：`public/runtime-conversation.js`、`tests/thinking-availability.cjs`、`package.json`。
  - 完整保留主线所有功能与阶段性成果：Z5-1（Runtime 输入与草稿隔离）、Z5-2（思考等级统一合同）、Z5-3 / Z5-3B（历史工具执行摘要）、以及 v0.30.0 的版本号与生命周期测试脚本。
  - 整合提交：`5acdf57` (`Merge origin/main into codex/fix-bugs-8-11: 整合 v0.30.0 及 Z5 全阶段主线，保留 Bug 8~11 修复`)。

### 2. 第一轮验收发现问题的逐项处置结果

| 缺陷编号 | 第一轮验收发现的缺陷 / 不足 | 第二轮修复与解决措施 | 状态 |
| :--- | :--- | :--- | :---: |
| **Bug 8** | 前端 `onStopState` 未完全对齐 `pending: true`；需要补全会话并发、旧 Stop 迟到响应防护及真实 Pi 回环断言核验。 | 1. 在 `public/rpc.js` 中让 `onStopState` 识别 `evt?.pending === true` 及 `evt?.state === 'stopping'`，立即将前端置于 `S.stopping = true` 并禁用发送按钮。<br>2. 补充多会话并发停止测试（停止会话 A 绝不影响会话 B 的有序写入）。<br>3. 验证旧 Stop 迟到的中止响应绝不释放新 Stop 屏障。<br>4. 执行真实 Pi RPC 回环测试 `tests/bug8-real-pi-fixture.cjs`，实测 **31/31 断言全部通过**。 | **彻底解决** |
| **Bug 9** | 需与 `main` 主线的 Z5-2 思考等级统一可用性合同深度整合，禁止重复状态机与降低断言约束。 | 1. 完全复用主线规范的 `public/thinking-availability.js` 投影合同。<br>2. 确保 Classic 与 Runtime 均遵循“Pi 原生档位优先于静态推理元数据”的铁律。<br>3. 回读失败时显示真实降级原因（如“思考等级读取失败”），不永久置灰，提供重试机制。<br>4. 保留 Z5-2 全量测试断言（`tests/thinking-availability.cjs` 34 项断言全绿）。 | **彻底解决** |
| **Bug 10** | 1. 迁移异常被 `try-catch` 静默吞掉。<br>2. 目标存在时直接跳过，可能导致中断后留下不完整数据。<br>3. 新默认路径可能破坏旧便携版（单文件 EXE）的数据存放行为。 | 1. 重构 `server/data-dir.js`，引入 `detectExecutionMode` 准确区分源码 Web 模式、单文件便携版 (`portable-sea`) 与 Electron 安装版。<br>2. 便携模式下若可执行文件同级或 `data/` 已有数据，严格沿用现有便携目录，不破坏历史存储。<br>3. 引入**原子临时暂存机制 (`.stage-<name>-<ts>-<rand>`)**：先复制至暂存目录，全部成功后原子重命名至目标；启动时自动清理历史残留暂存目录，防止部分迁移被误认完成。<br>4. 严禁静默覆盖已有文件，严禁静默合并冲突目录；详细报告复制与跳过项，生成 `.migration-manifest.json`。<br>5. 显式 `PI_GUI_DATA` 拥有最高优先级，绝不自动迁移覆盖用户显式配置。<br>6. 增加故障注入测试套件（权限拒绝、复制中断、目标冲突、符号链接、嵌套路径防护等，33 项断言全绿）。 | **彻底解决** |
| **Bug 11** | `tests/panel-restore-electron.cjs` 从 `index.html` 移除了 `<script type="module" src="/app.js"></script>`，并在刷新后手动调用 `openChangesPanel()`，无法证明生产环境的真实自恢复行为。 | 1. **重写 `tests/panel-restore-electron.cjs`**：完整保留原生 `index.html` 与 `app.js` 启动逻辑，静态资源与 API 原样服务。<br>2. 打开 Changes 面板、滚动列表并展开 Diff，调用真实的 `win.webContents.reload()` 触发浏览器全页刷新。<br>3. 刷新后测试代码**绝不手动调用任何打开面板的 helper**，验证 `app.js` 自然自启后自动重开 Changes 面板、精准还原列表 `scrollTop` 并自动恢复展开的 Diff。<br>4. 对 Specs 面板验证刷新后自然重开、精准恢复目录树滚动、选中文档及文档 Markdown 正文滚动位置。<br>5. 验证 Browser 面板刷新后绝不自动恢复，绝不触发外部网络重连。<br>6. 验证用户主动点击面板右上角 `×` 关闭后，刷新绝不错误恢复。<br>7. 验证 `pi-gui:session-switch` 与 `pi-gui:workspace-generation` 生产事件驱动的自动状态清理（未调用 `clearPaneState` 代替事件清理）。<br>8. 使用真实 Electron 正常沙箱环境执行并捕获 6 张高分辨率截图。 | **彻底解决** |

---

## 第三轮定向补修与终审摘要 (Round 3 Targeted Fixes & Final Acceptance)

针对第二轮集成后关于 Bug 10 的遗留审查意见，在 `codex/fix-bugs-8-11` 上完成了专项定向补修，不改动已稳定的 Bug 8、9、11：

### 1. 暂存目录精准归属与多实例保护 (`server/data-dir.js`)
- **根除全量误删**：禁止无差别删除所有 `.stage-*` 文件。
- **命名结构化**：定义 `STAGE_PREFIX = '.stage-mig-'`，格式严格遵循 `.stage-mig-<entry>-<pid>-<timestamp>-<rand>`，并通过 `parseStageName` 校验 entry 归属合法的迁移项。
- **并发与存活探测**：清理前提取 PID，调用 `isProcessRunning(pid)`（通过 `process.kill(pid, 0)` 探测并兼容 `EPERM`）。若创建该暂存的实例仍处于运行状态（且 PID != 当前进程），严格保留，绝不误伤并发运行实例的进行中迁移。
- **安全清理孤儿暂存**：仅当暂存目录的所属 PID 明确已终止退出时，才作为历史遗留孤儿安全清理。
- **用户文件绝对隔离**：对于不匹配迁移正则的非迁移文件（例如用户自行创建的 `.stage-notes.txt` 或第三方同名前缀），一律忽略并严密保护。

### 2. 便携版默认数据目录完备兼容
- **Node SEA 原生能力识别**：通过 `node:sea` 的 `isSea()` 及 `process.features.sea` 检测 SEA 运行态，摆脱单一 `Pi GUI.exe` 文件名依赖，即使单文件可执行程序被用户任意重命名仍能精准识别。
- **四种情形完备覆盖**：
  1. **显式 `PI_GUI_DATA`**：最高优先级，直接采纳，绝不被迁移覆盖；
  2. **已有历史便携数据 (v1 同级)**：若同级存在 `projects.json`，返回同级目录，历史数据零漂移；
  3. **已有历史便携数据 (v2 `data/` 子目录)**：若同级 `data/projects.json` 存在，返回 `data/` 子目录；
  4. **全新便携版**：默认分配独立规范的 `exeDir/data` 子目录；
  5. **项目目录防污染安全回退**：若便携可执行文件被放置在仓库根目录（`appRoot`）或用户项目目录（`projectRoot`）内部，自动回退到操作系统标准的用户应用数据目录（Windows 下为 `%APPDATA%/pi-gui`），彻底杜绝仓库污染与 `collab_storage_inside_project` 安全拦截。

### 3. 迁移失败全链路严密处理与诊断脱敏
- **禁止静默忽略**：`resolveDataDir` 接收 `migrateLegacyData` 返回的完整报告，绝不吞掉迁移异常。
- **异常分级处置**：
  - **严重阻断性错误**：目标目录无法创建（`TARGET_DATA_DIR_UNAVAILABLE`）、显式配置目录不可用（`EXPLICIT_DATA_DIR_UNAVAILABLE`）、致命路径非法（`NUL 字节`、`绝对路径相同`、`跨层级目录穿越`），立即抛出结构化错误，阻断非安全启动。
  - **可恢复性非阻断异常**：如特定文件权限拒绝（`EACCES` / `EBUSY` / `EPERM` / `EXDEV`），记录脱敏诊断告警（路径脱敏，隐藏用户主目录），并在 `.migration-manifest.json` 中如实标记 `status: "partial"` 或 `status: "failed"`，绝不将不完整迁移虚假报告为 `completed`。
- **原子重命名与源数据保全**：任何中间复制失败或权限异常均安全回滚清理当前失败暂存，原始数据完好保留在源目录。

### 4. 故障注入与回归测试矩阵扩展
- `tests/standalone-datadir.cjs` 测试用例与断言由 33 项大幅扩展至 **47 项**，覆盖：
  - 双实例并发活跃暂存保护；
  - 异常崩溃后的孤儿暂存清理；
  - 用户无关 `.stage-*` 文件的严格保护；
  - 重命名 SEA 可执行程序的 `isSea` 识别；
  - 便携版放置于项目内部时的安全降级回退；
  - 复制中断、权限不足、数据冲突、原子重命名失败、重复幂等迁移；
  - 目录无法创建时的结构化错误阻断。
- 实测 **47/47 全部通过**。

---

## 逐项缺陷最终修复状态

### 1. Bug 8：Stop / 取消状态与后续交互异常
- **状态**：修复完成，集成验证通过。
- **关键代码位置**：
  - `server/rpc-bridge.js`：建立停止屏障 `pending: true`，官方顺序 `clear_queue` → `abort`，拦截后续任务；
  - `public/rpc.js`：`onStopState` 监听 `evt?.pending === true || evt?.state === 'stopping'`，同步重置 `S.stopping = true` 并更新发送状态；
  - `server/pi-activity.js` & `server/runtime-registry.js`：统一识别停止状态与闸门限制。
- **验证结论**：`stop-barrier.cjs` 17/17 通过，`bug8-real-pi-fixture.cjs` 31/31 通过，`test:stop` 46/46 全部通过。

### 2. Bug 9：刷新或恢复会话后思考等级异常与永久不可用
- **状态**：修复完成，集成验证通过。
- **关键代码位置**：
  - `public/thinking-availability.js`：规范思考等级 10 状态纯投影契约；
  - `public/runtime-models.js`：复用统一合同，去除对静态 `reasoning: false` 的错误降级覆写；
  - `public/composer.js` & `public/ui3-model-picker.js`：统一消费可用性状态，驱动芯片文本与禁用状态。
- **验证结论**：`thinking-availability.cjs` 34/34 通过，`model-capabilities.cjs` 36/36 通过，`test:model-capabilities` 70/70 全部通过。

### 3. Bug 10：数据目录计算、安全路径与迁移安全
- **状态**：修复完成，集成验证通过。
- **关键代码位置**：
  - `server/data-dir.js`：
    - `isSeaRuntime()` & `detectExecutionMode()`：基于原生 `node:sea` 精准识别重命名 SEA 二进制与运行模式；
    - `defaultDataDir()`：源码 Web 模式使用 `%APPDATA%/pi-gui`，便携模式兼容检查同级历史数据与项目防污染回退；
    - `STAGE_PREFIX` & `parseStageName()` & `isProcessRunning()`：基于 PID 存活的多实例活跃暂存保护与孤儿清理；
    - `validatePathSafety()`：防范绝对路径相同、NUL 字节及嵌套路径穿越；
    - `migrateLegacyData()` & `resolveDataDir()`：无损原子暂存迁移、明确失败分级与脱敏诊断。
- **验证结论**：`standalone-datadir.cjs` 47/47 全部通过（包含多实例并发暂存、孤儿清理、故障注入与权限拒绝测试），`npm run test:server` 77/77 全部通过。

### 4. Bug 11：右侧面板真刷新自动恢复与滚动位置记忆
- **状态**：修复完成，集成验证通过。
- **关键代码位置**：
  - `public/ui/secondary-surface.js`：基于 `sessionStorage` 仅放行 `changes` 与 `specs`，严格阻断 `browser` 自动恢复；监听 `pi-gui:workspace-generation` 自动清理恢复状态；
  - `public/git.js`：在挂载时还原 `lastChangesListScroll` 与 `diffViewState`，重绘制列表时按文件状态重新绑定 Diff 展开与横向滚动；
  - `public/specs-panel.js`：记忆并在切换时恢复目录树与文档正文滚动位置；在工作区切换时主动调用 `clearPaneState('specs')`；
  - `public/app.js`：在 `loadStatus` 首屏初始化完成后调用 `restoreOrdinaryPanel()` 自动恢复面板。
- **验证结论**：`panel-restore-ui.cjs` 14/14 通过，`panel-restore-electron.cjs` 25/25 全部通过，`z1-electron.cjs` 25/25 全部通过。

### 4. Bug 11：右侧面板真刷新自动恢复与滚动位置记忆
- **状态**：修复完成，集成验证通过。
- **关键代码位置**：
  - `public/ui/secondary-surface.js`：基于 `sessionStorage` 仅放行 `changes` 与 `specs`，严格阻断 `browser` 自动恢复；监听 `pi-gui:workspace-generation` 自动清理恢复状态；
  - `public/git.js`：在挂载时还原 `lastChangesListScroll` 与 `diffViewState`，重绘制列表时按文件状态重新绑定 Diff 展开与横向滚动；
  - `public/specs-panel.js`：记忆并在切换时恢复目录树与文档正文滚动位置；在工作区切换时主动调用 `clearPaneState('specs')`；
  - `public/app.js`：在 `loadStatus` 首屏初始化完成后调用 `restoreOrdinaryPanel()` 自动恢复面板。
- **验证结论**：`panel-restore-ui.cjs` 14/14 通过，`panel-restore-electron.cjs` 25/25 全部通过，`z1-electron.cjs` 25/25 全部通过。

---

## 真实测试命令与量化验证矩阵

所有测试均在本地环境实际运行，执行结果如下：

| 测试命令 | 退出码 | 通过断言数 | 失败数 | 说明 |
| :--- | :---: | :---: | :---: | :--- |
| `node tests/stop-barrier.cjs` | 0 | 17 | 0 | Bug 8 停止屏障状态机、任务拦截与迟到应答防护 |
| `$env:PI_GUI_BUG8_FIXTURE="1"; node tests/bug8-real-pi-fixture.cjs` | 0 | 31 | 0 | Bug 8 真实 Pi RPC 回环场景、双会话并发停止与状态核验 |
| `npm run test:stop` | 0 | 46 | 0 | Bug 8 综合停止测试链（stop-barrier + gui-browser-stop + fixture） |
| `npm run test:model-capabilities` | 0 | 70 | 0 | Bug 9 模型能力与统一思考等级 10 状态矩阵测试 |
| `npm run test:server` | 0 | 77 | 0 | Bug 10 服务端基础路由(30) + 独立数据目录及并发迁移故障注入(47) |
| `node tests/panel-restore-ui.cjs` | 0 | 14 | 0 | Bug 11 恢复白名单、持久化映射与跨作用域清理 |
| `npm run test:specs` | 0 | 57 | 0 | Bug 11 Specs API + UI 渲染 + 面板恢复 UI 套件 |
| `node tests/z1-electron.cjs` | 0 | 25 | 0 | Bug 11 Changes 面板真实 Chromium 滚动与分屏基线回归 |
| `node tests/panel-restore-electron.cjs` | 0 | 25 | 0 | Bug 9, 11 真实 Electron 原生 app.js 刷新恢复与沙箱交互 |
| `node tests/smoke.cjs` | 0 | 1338 | 0 | 全局核心回归冒烟测试（断言总数保持 1338） |

---

## Electron 截图与测试证据路径

真实 Electron 验证在正常的 Chromium 沙箱环境（`sandbox: true, contextIsolation: true`）中执行，最新生成的证据截图已就绪保存在：

| 证据文件 | 大小 | 说明 |
| :--- | :---: | :--- |
| `docs/assets/bug-fixes/01-bug9-thinking-ready.png` | 45.8 KB | Bug 9：真实 Chromium 中模型思考等级回读显示 `思考 medium` 且按钮处于可用状态 |
| `docs/assets/bug-fixes/02-bug11-changes-scrolled.png` | 142.6 KB | Bug 11：Changes 变更面板在真实 Electron 中向下滚动（`scrollTop >= 350`）并成功展开首个文件 Diff |
| `docs/assets/bug-fixes/03-bug11-changes-restored.png` | 142.6 KB | Bug 11：执行 `win.webContents.reload()` 页面刷新后，由 `app.js` 自然重开面板，精准恢复滚动位置且 Diff 保持展开 |
| `docs/assets/bug-fixes/04-bug11-specs-scrolled.png` | 174.1 KB | Bug 11：Specs 面板在真实 Electron 中目录树滚动、选中第 2 篇文档且 Markdown 正文向下滚动 |
| `docs/assets/bug-fixes/05-bug11-specs-restored.png` | 174.1 KB | Bug 11：执行 `win.webContents.reload()` 页面刷新后，Specs 目录树、选中文档及 Markdown 正文滚动均精准自然恢复 |
| `docs/assets/bug-fixes/06-bug11-browser-never-restored.png` | 45.8 KB | Bug 11 安全铁律：Browser 面板开启状态下刷新，面板保持关闭（`hidden: true`），绝不自动恢复，未发起任何网络导航 |

---

## 关键修改文件清单

| 文件路径 | 状态 | 涉及 Bug | 关键修改说明 |
| :--- | :---: | :---: | :--- |
| `public/rpc.js` | 修改 | Bug 8 | 在 `onStopState` 补充对 `evt?.pending === true` 与 `stopping` 状态的同步识别 |
| `server/data-dir.js` | 重写 | Bug 10 | 区分运行形态，SEA 原生检测，便携模式兼容历史数据与防污染回退，实现基于 PID 的多实例暂存保护与孤儿清理、异常分级与脱敏诊断 |
| `public/ui/secondary-surface.js` | 修改 | Bug 11 | 监听 `pi-gui:workspace-generation` 自动清理激活 surface 与 pane 状态 |
| `public/specs-panel.js` | 修改 | Bug 11 | 在 `workspaceChanging` 时清理 `specs` 状态；在工作区切换中阻断滚动回写 |
| `tests/stop-barrier.cjs` | 修改 | Bug 8 | 增加对 `pending: true` 广播与收敛过程的断言验证 |
| `tests/standalone-datadir.cjs` | 重写 | Bug 10 | 扩展至 47 项断言：运行模式探测、SEA 原生识别、多实例活跃暂存保护与孤儿清理、便携防污染回退、权限降级与目录隔离 |
| `tests/panel-restore-ui.cjs` | 修改 | Bug 11 | 移除手动 `clearPaneState` 调用，完全由 `session-switch` 与 `workspace-generation` 生产事件驱动验证 |
| `tests/panel-restore-electron.cjs` | 重写 | Bug 9, 11 | 保留原生 `app.js` 启动，测试全页真实刷新、Diff 展开恢复、Specs 树与文档滚动恢复、用户主动关闭及作用域隔离 |

---

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
- **运行形态探测与平台化独立数据目录 (`server/data-dir.js`)**：
  - 新增 `detectExecutionMode()`：原生导入 `node:sea` 的 `isSea()` 及检测 `process.features.sea`，结合环境变量与执行路径，精准识别 `portable-sea`、`electron` 和 `source-web`；即使 SEA 可执行程序被用户重命名仍可可靠识别。
  - 新增 `defaultDataDir()`：
    - 源码 Web 模式：标准操作系统用户数据目录（Windows: `%APPDATA%/pi-gui`；macOS: `~/Library/Application Support/pi-gui`；Linux: `$XDG_DATA_HOME/pi-gui`）；
    - 便携版兼容：若同级存在历史 `projects.json`（v1 便携）返回同级；若 `data/projects.json` 存在（v2 便携）返回 `data/`；全新便携版默认分配 `exeDir/data`；
    - 项目防污染回退：若便携版放置于仓库（`appRoot`）或用户项目（`projectRoot`）内部，自动回退到系统标准数据目录，避免仓库污染与 `collab_storage_inside_project` 拦截；
    - 显式 `PI_GUI_DATA`：最高优先级，始终优先。
  - 新增 `resolveDataDir()`：负责目录创建与安全迁移接驳；对不可创建的目标目录抛出结构化严重错误（`TARGET_DATA_DIR_UNAVAILABLE`），不静默继续。
- **原子暂存与多实例并发防护 (`server/data-dir.js`)**：
  - 命名规范：`STAGE_PREFIX = '.stage-mig-'`，格式为 `.stage-mig-<entry>-<pid>-<timestamp>-<rand>`；
  - 暂存安全清理：通过 `parseStageName` 严格验证归属合法迁移项，提取 PID 调用 `isProcessRunning(pid)`；若其他实例进程存活则严格跳过，仅在进程已死时清理孤儿暂存；用户非迁移文件（如 `.stage-notes.txt`）受严格保护；
  - 迁移流程：复制到专用暂存目录，全部成功后原子重命名至目标目录；发生错误时立即回滚清理临时暂存，源数据完好无损；
  - 冲突防御：已有目标文件绝不静默覆盖，冲突目录绝不静默合并，作为 `skipped` 记录在 `.migration-manifest.json`；
  - 异常分级与诊断脱敏：区分阻断性严重错误与可恢复权限错误（`EACCES`/`EBUSY`），诊断日志调用 `sanitizePath()` 替换用户主目录，脱敏记录。
- **服务端接驳 (`server.js`)**：
  - 将 `DATA_DIR` 改为通过 `resolveDataDir({ env: process.env, appRoot: __dirname })` 解析，并在启动日志中输出脱敏的数据目录位置。
  - 完全保留现有的 `safe-path` 访问拦截与项目保护规则。

#### 3.3 验证证据与测试结果
- **针对性回归与故障注入测试**：
  - `tests/standalone-datadir.cjs`：**47/47 全部通过**
    ```
    ok  detectExecutionMode detects source-web by default
    ok  detectExecutionMode detects portable-sea via PI_GUI_PORTABLE
    ok  detectExecutionMode detects portable-sea via execPath name
    ok  detectExecutionMode detects electron via ELECTRON_RUN_AS_NODE
    ok  detectExecutionMode detects renamed SEA binary via isSea runtime capability
    ok  default data dir is defined and non-empty
    ok  default data dir ends with pi-gui
    ok  Windows default uses AppData/Roaming
    ok  portable mode preserves existing portable directory next to exe
    ok  portable mode preserves existing data/ subdirectory
    ok  brand new portable SEA defaults to dedicated exeDir/data
    ok  portable SEA inside user project safely falls back to standard user profile
    ok  explicit PI_GUI_DATA is respected
    ok  explicit PI_GUI_DATA directory is created
    ok  explicit PI_GUI_DATA is NEVER auto-migrated into
    ok  parseStageName extracts entry, pid, timestamp
    ok  parseStageName rejects non-matching filenames
    ok  concurrent active staging folder is strictly preserved and not deleted
    ok  abandoned staging folder from dead process is cleaned up safely
    ok  unrelated user file with .stage- prefix is strictly protected
    ok  migration report reports success and completed status
    ok  projects.json migrated
    ok  projects.json content preserved
    ok  session-flags.json migrated
    ok  plans directory migrated
    ok  migration manifest generated with completed status
    ok  existing destination data is not overwritten
    ok  existing directory is not merged into
    ok  existing items recorded as skipped
    ok  atomic rename failure reports non-ok status
    ok  atomic rename failure reports partial or failed status
    ok  staging file cleaned up on rename failure
    ok  manifest records failed status
    ok  partial directory copy failure reports error
    ok  interrupted staging directory cleaned up on partial failure
    ok  source data preserved completely after partial failure
    ok  faulty migration reports failure without crashing
    ok  error recorded with code EACCES
    ok  source data preserved after fault
    ok  symlink handling verified or skipped on restricted Windows
    ok  nested path prohibited
    ok  resolveDataDir throws TARGET_DATA_DIR_UNAVAILABLE on uncreatable target directory
    ok  second migration run succeeds idempotently
    ok  collabStore rejects data directory inside project root
    ok  reviewCommentStore rejects data directory inside project root
    ok  collabStore succeeds with safe independent dataDir
    ok  reviewCommentStore succeeds with safe independent dataDir
    ```
  - `npm run test:server`（含 `dev-server.cjs` 30 项 + `standalone-datadir.cjs` 47 项）：**77/77 全部通过**
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
  - `tests/panel-restore-electron.cjs`：**25/25 全部通过**
    ```
    PASS Bug 9: thinking chip reflects active level (思考 medium)
    PASS Bug 9: thinking button is enabled with valid levels
    PASS Bug 11: changes list scrolled before reload
    PASS Bug 11: diff expanded before reload
    PASS Bug 11: active surface recorded in sessionStorage as changes
    PASS Bug 11: right pane automatically reopened after reload
    PASS Bug 11: right pane surface restored to changes
    PASS Bug 11: changes list scroll position restored after reload
    PASS Bug 11: expanded diff automatically restored after reload
    PASS Bug 11: specs tree scrolled before reload
    PASS Bug 11: specs markdown content scrolled before reload
    PASS Bug 11: active surface recorded in sessionStorage as specs
    PASS Bug 11: right pane surface restored to specs
    PASS Bug 11: specs tree scroll position restored after reload
    PASS Bug 11: specs doc markdown scroll position restored after reload
    PASS Bug 11: browser surface is NEVER written to sessionStorage
    PASS Bug 11: active surface in sessionStorage remains null after browser reload
    PASS Bug 11: right pane remains closed after browser reload
    PASS Bug 11: browser never auto-reconnected or triggered network navigation
    PASS Bug 11: right pane closed by user close button
    PASS Bug 11: user close button cleared active surface key
    PASS Bug 11: panel does NOT restore after user explicitly closed it
    PASS Bug 11: session-switch automatically clears changes pane state without manual call
    PASS Bug 11: workspace-generation automatically clears restored surface
    PASS Bug 11: workspace-generation automatically clears all pane states
    Electron UI Verification: 25/25 passed; failed=0
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
| `tests/standalone-datadir.cjs` | **新增** | Bug 10 | 独立数据目录计算、SEA 原生识别、多实例暂存保护与故障注入测试（47 项断言） |
| `tests/panel-restore-ui.cjs` | **新增** | Bug 11 | 面板恢复白名单、持久化与防串线测试（14 项断言） |
| `tests/panel-restore-electron.cjs`| **新增** | Bug 9, 11| 真实 Electron / Chromium 渲染与交互取证测试（25 项断言） |
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
   - 资源：344 项，代码打包 2.43 MB，blob 8.57 MB
   - 生成路径：`build/Pi GUI.exe`
   - 文件大小：**98.3 MB**
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
