# UI-4C 验收：全局状态反馈与通知组件统一

日期：2026-10-17
分支：`codex/ui4-feedback`
独立工作区：`C:\pi-GUI-ui4-feedback`
共同基线：`17f855f01fedb7b13a13496ba45ebf8d28e465ac`
实现提交：`a016f53103af035c8e79fee106c67aec31fc8b37`
最终 HEAD：见本分支 `git rev-parse HEAD`（验收文档提交只追加本文件与证据）

## 1. 实现范围

只改允许的文件：

| 文件 | 内容 |
|---|---|
| `public/ui/toast.js` | 四类 Toast（info / success / warning / error）、别名校验、队列、去重、长文本、暂停/恢复计时、关闭、Esc、ARIA、持久错误、可选 action、避让位置计算 |
| `public/ui/notice.js` | 统一 `bad / warn / info / ok / busy / unknown`，未知状态保持中性；图标、标题/说明层级、既有 action 注入、关闭、ARIA、幂等重绘 |
| `public/ui4-feedback.css` | Toast/Notice 与既有空状态/错误状态的视觉统一；全部新类使用 `.ui4-feedback-*` 前缀；主题走既有 Token；`prefers-reduced-motion` 回退 |
| `tests/ui4-feedback.cjs` | jsdom 契约测试 + 真实 Electron（离线 fixture、隔离 userData）布局/截图 |

未修改：Server、Electron、Pi RPC、安全协议、`package.json`、`index.html`、共享 CSS/Token、A/B 文件。

当前 `index.html` 只读，因此样式表由 `ensureFeedbackStyles()` 在首次导入 Toast/Notice 时注入一次
`/ui4-feedback.css`。集成时建议在 `index.html` 显式加一行（见 §7），注入器保留也不会重复加载。

## 2. 旧 API 兼容

| API | 兼容性 | 说明 |
|---|---|---|
| `toast(msg, kind)` | 保持 | 默认 `info`；`ok` → success，`warn` → warning；未知 kind 归入 info，不会伪装成成功/失败 |
| `toast(msg, kind, options?)` | 新增可选参数 | `{ duration, persistent, action }`；旧调用不传第三参数，行为仍可用 |
| Toast DOM | 保持 | 仍为 `#toasts > .toast`，错误/警告仍带 `.error` / `.warn`；`textContent` 仍是消息本身 |
| `withNotificationSource` | 保持 | 历史回放仍不产生通知 |
| `showNotice(model)` | 保持 | 仍接收 `{id,tone,title,detail,actions:[{label,title,run}]}`；`tone` 新增 `ok/busy/unknown` 与常见别名 |
| `hideNotice()` | 保持 | 清空并隐藏同一条 `#stageNotice` |
| `currentNoticeId()` | 修正 | 源码注释一直声明返回 id，旧实现返回内部对象且仓库内无调用方；现返回 `string|null` |
| `.notice-close` / `.notice-actions` / `.btn tiny` | 保持 | 旧选择器与 smoke 用例继续可用；仅叠加 `.ui4-feedback-*` 类 |

没有建立第二套全局通知系统。Notice 仍只有 `#stageNotice` 一层，后到的状态替换先前的。

## 3. 状态来源矩阵

| 状态 | 既有事实源 | 现在由谁呈现 | UI-4C 处理 |
|---|---|---|---|
| 没有项目 | `S.hasProject`；`shell.applyProjectState()`；`welcomeNoProj` | shell / 欢迎区 | 空状态层级与 CTA 样式；仍由既有 `btnPickProject` 执行 |
| Pi 未就绪 | `S.bridgeState`；`status-copy.connectionCopy/startupNotice` | shell 连接文案 + 输入区 placeholder；常驻条 | Notice 支持 `busy/info/bad`；不把启动中画成失败 |
| Pi 启动失败 / 已退出 | `bridge_status.error/hint`；`startupNotice` | `#stageNotice` + 错误卡片 | `bad` 常驻、`role=alert`、只调用既有 `restart/diagnostics` |
| 维护态 | `maintenance.reason`（`pi-update` / `capability-install`） | `startupNotice` | `info`，不伪装成故障，不给「重启」 |
| 模型不可用 | `runtime-models` 的 `model/models/notice`；`ui3-model-picker` 三值能力 | Runtime 模型行 / Composer | Notice/Toast 支持 `warn` 与 `unknown`；不伪造模型状态 |
| 服务不可用 | HTTP/API `ok:false`、`runtimeLimitNotice`、bridge error | 调用方 toast / `.rtc-notice` | 错误 Toast 默认持久；不自动重试 |
| 正在切换 Workspace | `S.switching`（`beginWorkspaceSwitch`）、`S.desiredCwd`、`setBridgeState('restarting')` | 输入区 placeholder（既有） | `busy` Notice 模型已支持；需要集成方在 `app.js/projects.js` 接线（§7） |
| 读取中 | `SURFACE_COPY.loading`、`.rtc-state`「读取历史…」 | 各面板 | 中性 loading 样式；无百分比、无假进度 |
| 可以重试 | 既有 `resync/restart/diagnostics`、`loadHistory` 等 handler | 调用方注入 action | Notice action 只调用注入的 `run`；无后台自动修复 |
| 无权限 / 不支持 | `compat.missing`、Capability 三值判定 | 诊断 / Capability 面板 | `warn` 或 `unknown`；unknown 不画成 success/failure |
| 数据未知 | `reasoning`/capability 的 `unknown`、历史不可读 | 模型行、Runtime notice | `unknown` 中性虚线图标；不猜成 false 或失败 |

`unknown` 在 Notice 上是独立的中性态（`data-tone="unknown"`，无 `ok/bad/warn` 类）；Toast 的未知 kind 归入 info，不会显示成功或失败样式。

## 4. 行为细节

### Toast

- 默认时长：info/success 4.2s，warning 7s，**error 持久**；`persistent:false` 可退回定时关闭，`duration` 可覆盖。
- 多个通知按到达顺序堆叠；容器限制最大高度并可滚动，不静默丢弃。
- 导航离开悬停/焦点会暂停计时，离开后恢复。
- 关闭按钮有 `aria-label`，不改变消息 `textContent`；Esc 关闭当前焦点所在 Toast 并把焦点还给 Composer。
- 容器为命名 region，单条为 `role=status` / 错误为 `role=alert`。
- 位置由 Composer 实际顶边与右栏实际左边计算，避免覆盖 Composer 与右栏；窄屏与右栏打开时限制宽度。
- 文本全部 `textContent`，action 标签也是文本；不做 HTML 解析。

### Notice

- 单层常驻；`bad` 为 `alert`，其余为 `status`。
- `bad/warn/info/ok/busy/unknown` 各有独立图标与语气；busy 为静态可识别 spinner，reduced-motion 下停转。
- 同 id + 同签名不重建；签名现在包含 action 文案，避免动作变化后仍显示旧文案。
- 动作仍由装配层注入；`unknown` 不会自动变成失败，也不触发重试。

## 5. 测试与结果

独立工作区没有复制 `node_modules`；以下命令在开发机用
`NODE_PATH=C:\pi-GUI\node_modules` 指向主工作区依赖执行（不写入产品、不影响 CI 合并后的直接调用）。

| 命令 | 结果 |
|---|---|
| `node tests/ui4-feedback.cjs` | **27/27**，failed=0，skipped=0 |
| `node tests/ui4-feedback.cjs --electron` | **9/9**，failed=0，skipped=0 |
| `node tests/smoke.cjs` | **1338/1338** |
| `node tests/interactions.cjs` | passed |
| `node tests/ux-state.cjs` | **15/15** |
| `node tests/bridge-state-recovery.cjs` | **55/55** |
| `node tests/daily-use.cjs` | **31/31** |
| `node tests/modules.cjs` | **117/117** |
| `node tests/runtime-conversation.cjs` | **48/48** |
| `node tests/runtime-nav.cjs` | **38/38** |
| `node tests/ui-ia.cjs` | **12/12** |
| `node tests/gui-browser-stop.cjs` | **12/12** |
| `node tests/theme.cjs` | **47/47** |
| `node tests/ui2-classic.cjs` | **48/48** |
| `node tests/ui2-runtime-display.cjs` | **82/82** |
| `node tests/ui3-integration.cjs` | **23/23** |
| `node tests/session-change-ui.cjs` | **27/27** |
| `node tests/runtime-ui.cjs` | **16/16** |

UI-4C 套件覆盖：成功/失败/警告/未知、队列与重复通知、持久通知与关闭、Workspace 切换、
长中文/长英文、XSS 文本安全、键盘与 ARIA、窄屏与右栏打开、Dark/Light、reduced-motion、
旧调用兼容、失败必须真实可见、真实 `startupNotice` 模型（error/exited/maintenance/compat/overdue）。

证据：

- `docs/claude-ui-redesign/ui4c-evidence/unit.json`
- `docs/claude-ui-redesign/ui4c-evidence/electron.json`

## 6. 真实截图

Electron 1440×900，`visual-harness` 离线 fixture，隔离临时 `userData`；700×600 用于窄屏。
没有接触用户项目或真实会话。

| 截图 | 内容 |
|---|---|
| [ui4-toasts-dark.png](ui4c-evidence/ui4-toasts-dark.png) | 四种 Toast、右键关闭、持久错误、避开 Composer |
| [ui4-toasts-light.png](ui4c-evidence/ui4-toasts-light.png) | 同一组件的浅色主题 |
| [ui4-notice-dark.png](ui4c-evidence/ui4-notice-dark.png) | `bad` 常驻条、两个既有动作、关闭 |
| [ui4-notice-light.png](ui4c-evidence/ui4-notice-light.png) | `unknown` 中性态，不画成成功/失败 |
| [ui4-empty-state-dark.png](ui4c-evidence/ui4-empty-state-dark.png) | 真实 `applyProjectState()` 驱动的无项目空状态 |
| [ui4-narrow-right-pane.png](ui4c-evidence/ui4-narrow-right-pane.png) | 700×600、右栏打开：Toast 换行且不压 Composer/右栏 |

布局断言同时覆盖：页面无横向滚动、Toast 底边在 Composer 顶边之上、右栏打开时 Toast 右边不超过
右栏左边、Notice actions 不溢出。jsdom 只证明语义与事件，排版结论来自 Electron。

## 7. 需要集成方修改的共享文件（建议）

1. **`public/index.html`**：在 `styles.css` 与 UI-3 样式之后显式加载：
   ` <link rel="stylesheet" href="/ui4-feedback.css">`
   当前 `ensureFeedbackStyles()` 是无 `index.html` 修改权限时的兜底，二者幂等，不会重复应用。
2. **`public/app.js` + `public/status-copy.js`（Workspace 切换常驻提示）**：
   在 `syncNotice()` 里基于**既有** `S.switching` 增加一条 `busy` 模型，不要新建状态：
   ```js
   if (S.switching && S.bridgeState === 'restarting') {
     return { id: 'workspace-switching', tone: 'busy',
       title: '正在切换 Workspace…',
       detail: '等待 Pi 确认新的工作区；确认前发送保持禁用。',
       actions: ['resync', 'diagnostics'] };
   }
   ```
   动作仍走现有 `NOTICE_HANDLERS`；`ready/error/no-project` 路径已经会 `hideNotice()` 或换成真实结果。
3. **`public/runtime-conversation.js`（模型/服务/历史错误）**：
   - 只在真实 `result.ok === false` 或 catch 时给 `.rtc-notice` 加 `data-state="error"`；
     `runtimeLimitNotice` 是容量提示，保持 `warn`，不要混成失败。
   - 历史读取失败时已有「打开历史」入口；如需更明确，可把同一 `loadHistory()` 作为 action，
     不新增自动重试。
4. **Planner / Extensions / Capability 的空状态**：
   `.ext-empty`、`.ev-empty` 同时用于 loading、empty 和 error。若要按语义着色，需由各调用方
   在现有节点上加 `data-state="loading|empty|error|unknown"`；UI-4C 没有文本猜测，所以当前只统一
   中性层级。不要用类名或文案反推状态。
5. **`package.json`**：集成时把 `node tests/ui4-feedback.cjs` 加入测试脚本；本分支按任务要求未改。
6. **共享 CSS/Token**：本分支没有修改；所有颜色/间距来自现有 `tokens.css`，无需新增 Token。

## 8. 遗留与限制

- Electron fixture 记录到一条既有的 `ResizeObserver loop completed with undelivered notifications.`
  console warning；本套件未屏蔽 console，也未把它当作产品状态。UI4C 断言全绿，页面无横向滚动。
  该 warning 在移除本分支的 ResizeObserver 后仍出现，因此判断来自既有 Composer/布局观察链，
  不在本任务文件所有权内。
- 右栏打开的真实 Electron 几何验证使用 fixture 中手动打开的面板（网页版无 preload 的 Browser
  入口）；验证的是 Toast 的布局避让，不是 Browser 权限或原生 view 行为。
- `#stageNotice` 仍按原设计只保留一条，不支持 Notice 堆叠；多个同时问题仍需先解决最紧急的一条。
- 错误 Toast 默认持久是行为变化：调用方若已有常驻错误来源（如 `app.js` 的 bridge error），
  不应再重复弹同一条。现有 `app.js` 已经用 `syncNotice()` 的返回值避免重复。
- UI-4C 没有新增进度百分比、token、配额、响应时间或模型状态；`unknown` 一律保持中性。
