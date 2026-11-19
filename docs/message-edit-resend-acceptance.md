# 历史用户消息编辑 / 重新发送与重新生成：验收记录

- 分支：`feat/message-edit-resend`
- 基线：`66586aa0`（`main`，Merge PR #97，2026-11-20）
- 应用版本：0.34.0（未改正式版本号）
- 验证环境：Windows 11 10.0.26200，Node v24.22.1，Electron 44.4.3，Pi 1.5.2
- 范围：Classic 会话与**活动中的** Runtime 会话的历史用户消息编辑 / 重新发送，以及同一机制的「重新生成」
- 不在范围：dormant Runtime 历史只读视图；新会话 / 分叉模拟；文件、git、终端的自动回滚；Pi 本体或会话 JSONL 改写

## 1. 结论

本轮在原会话内实现了历史用户消息编辑、重新发送与重新生成。实现使用 Pi 的公开树导航
`ExtensionCommandContext.navigateTree(targetId, { summarize: false })` 把活动 leaf 移到目标用户
消息之前，再通过普通 RPC `prompt` 在同一原生会话里开始新一轮 Agent run。没有创建新会话、
没有 fork、没有改写 Pi 的 JSONL，也没有修改 Pi。

真实 Pi 1.5.2 与真实 Electron 验收均通过：编辑前后 `sessionId`、会话文件、侧栏条目数量不变；
旧分支仍留在 append-only 文件中，但不在活动路径与模型上下文里；重启后从 Pi 原生活动路径恢复。

## 2. PI-Desktop 调用链对照

参考实现（本地固定副本 `PI-Desktop-ref`）的链路：

1. `apps/desktop/src/stores/slices/transcript-slice.ts` 的 `editUserMessage(messageId, content, attachments)`：
   校验会话未运行、无 pending plan，按 `messageId` 找到 `userIndex`，把消息列表裁剪为
   `kept = messages.slice(0, userIndex)`，插入一条乐观用户消息，然后调用
   `api.prompt({ sessionId, content, messageId, attachments, truncateFromMessageId })`。
2. `apps/desktop/electron/main/ipc/agent-ipc.ts` 的 `agentPrompt`：取消该会话工具、abort 残留
   turn、flush 持久化 outbox，调用 Host 的 `session.truncateFrom`（Host 自己持有的 transcript
   存储），然后 `agent.disposeSession`、重新读取 session，再 `session.beginTurn` 并让 sidecar
   发送 prompt。
3. 重新生成走同一个 `truncateFromMessageId` 字段，但只裁剪、不插入新的用户消息，正文复用目标
   用户消息原文。

pi-GUI 有意不照搬第 2 步的 **Host transcript 截断 + sidecar 重启**：

- 本仓库的硬约束是只通过 `pi --mode rpc` 使用外部程序，不碰 Pi 本体、不改写会话 schema/JSONL。
- Pi 1.5.2 已公开 `navigateTree`，其语义正好是「把 leaf 移到目标之前」；用户消息与
  `custom_message` 会落到 `target.parentId`，其余条目落到 `targetId`。
- 因此 pi-GUI 用一次内部扩展命令完成导航，再发普通 `prompt`；身份、文件与原生树由 Pi 自己
  维护，pi-GUI 只持有稳定目标 ID 与事务状态。
- 差异是有意的：PI-Desktop 由 Host 重写自己的 transcript；pi-GUI 只追加 Pi 原生条目。

## 3. 采用的 Pi 原生能力

- `get_entries` → `{ entries, leafId }`：后端用 `id`/`parentId` 还原活动路径，得到目标用户
  条目的稳定 `entryId`、`parentId` 与当前 `leafId`。
- `get_messages`：同一套投影生成可见用户消息的 `userIndex`、文本、图片与 `hasToolsAfter`；
  与 `session-edit-target.js` 的 `contextEntries` 规则一致（含 compaction、`branch_summary`、
  `context_edit`）。
- 扩展命令：每次启动生成随机命令名 `pi-gui-edit-<12 hex>`，通过 `--extension` 注入
  `extensions/pi-gui-edit`；命令处理器只接受 `entryId + requestId`，校验目标存在、会话空闲、
  `navigateTree` 可用后调用公开 API。命令不存在时能力判定为 `navigate_unavailable` 并失败关闭。
- `prompt`：导航成功后发送编辑文本与原始图片；Pi 在目标父节点下追加新的用户条目，正常开始
  Agent run，工具权限与审批仍走既有流程。
- 回滚 guard：若导航前旧 leaf 是用户消息或 `custom_message`，扩展先 `appendEntry` 一个
  `pi-gui-edit-guard` 自定义条目，使旧 leaf 可被精确恢复；guard 不进入模型上下文。

## 4. 身份契约

一次事务绑定并核对：

| 字段 | 来源 | 作用 |
| --- | --- | --- |
| `nativeSessionId` | `get_state.sessionId` | 拒绝跨会话 requestId / 结果读取 |
| 原生会话文件 | `get_state.sessionFile` | 身份不变；真实 Pi 测试断言文件数不增 |
| `conversationId` | Runtime 记录 | Runtime 事务只作用于该并行会话 |
| `workspace` / `workspaceGeneration` | Runtime registry / 经典 workspace | 拒绝切换工作区后的迟到写入 |
| `bridgeRun` | RPC bridge | 拒绝重启 / 重连后的旧请求 |
| `entryId` + `parentId` | `get_entries` | 目标用户消息的稳定身份 |
| `leafId` | `get_entries` | 提交时历史修订判据 |
| `userIndex` | `get_messages` 投影 | 前端可见序号；提交时重新投影核对 |
| `requestId` | 前端生成 | 幂等、状态查询、跨会话隔离 |

提交时重新读取 `get_state` / `get_entries` / `get_messages` / `get_commands`，任一不匹配即返回
`stale_session`、`stale_history`、`stale_runtime` 或 `edit_in_progress`，不执行导航。

## 5. 生命周期与事务状态

服务端事务状态：

1. `validating`：能力、空闲、身份、目标投影、命令冲突、附件边界。
2. `navigating`：发送内部导航命令；轮询 `get_entries` 直到 leaf 到达预期父节点。
3. `sending`：发送普通 `prompt`，记录 `disposition`（`started` / `handled` / `rejected`）。
4. `accepted`：Pi 已接受；保留新路径，后续生成失败走既有错误流程。
5. `restoring`：提交前失败或 prompt 被拒绝 / handled；导航回原 leaf 并回读确认。
6. `failed`：恢复也失败或事务前置失败；状态带稳定错误码，不伪造完成。

`requestId` 在服务端去重：同一请求重复提交只执行一次；不同请求在事务进行中返回
`edit_in_progress`。状态查询只返回状态、身份与结果摘要，不返回消息正文（测试断言状态 JSON
不包含输入文本）。

## 6. 并发、失败与恢复

- 目标会话 streaming / compacting / queued / stopping 时禁止提交；不自动 abort。
- 其他会话在运行不阻塞本会话；后端按目标会话自己的 bridge / 状态判断。
- 导航没有移动 leaf：视为 `navigate_unverified`，恢复原 leaf 后报错。
- prompt 返回 `rejected` / `handled`：恢复原 leaf 后返回 `prompt_rejected` / `prompt_handled`。
- 旧 leaf 是用户消息或 `custom_message`：先追加 guard，再导航；恢复时回到 guard 条目，保证
  旧路径可精确还原（真实 Pi 测试覆盖「用户消息 leaf 被中断后编辑」）。
- 应答丢失：前端用 `requestId` 轮询状态；`accepted` 视为成功，`failed` 显示失败并保留文本，
  不盲目重试。
- 重启 / 刷新：从 Pi 原生活动路径恢复，不依赖渲染器缓存；真实 Pi 测试用 `--session` 重启后
  断言只剩编辑后的用户回合。

## 7. Classic 与 Runtime 支持范围

- Classic：完整支持，包括普通项目、Worktree 项目、已关闭后重新打开的历史会话（通过
  `get_entries` 投影恢复）。
- Runtime：支持**活动中的** live Runtime 会话（`edit-preflight` / `edit-resend` /
  `edit-status`）；事务额外绑定 `conversationId`、workspace 与 registry 生命周期。
- dormant Runtime 历史是既有只读视图（`server/session-history.js`），没有 live RPC 可导航，
  因此不提供编辑入口；不降级为新建会话，也不伪装成原会话。
- Runtime 的 pending edit 只替换目标 block，不追加重复用户消息；迟到的 HTTP 结果不会删除新
  run 的 block；`agent_settled` 会清理被中断 run 留下的 pending 状态。

## 8. 附件与命令文本边界

- 文本、Markdown、代码块原样提交；图片从目标用户条目的 `image` part 提取并随新 `prompt`
  重发，`imagesPreserved` 计入结果。
- 非文本 / 非图片 part（例如 `file`）在导航前拒绝，返回 `attachments_unsupported`；不把附件
  转成纯文本、不提交旧本地路径。
- 编辑文本为空 / 全空白拒绝；超过 1,000,000 字符拒绝。
- 编辑或重新生成文本若以已注册命令（含扩展命令、prompt template、`skill:<name>`）开头，
  返回 `command_text_conflict`，避免被 Pi 当成命令分发而不是用户消息。
- 重新生成不使用前端传入的文本，只使用后端从目标条目重新投影出的原文与图片。

## 9. 文件 / 工具安全

- 只移动 Pi 的活动 leaf，不自动撤销之前的文件修改、git 状态、终端输出或数据库操作。
- 不调用既有 session revert / 文件撤销服务执行隐式回滚。
- 被替换的后续历史含工具或文件动作时，UI 显示
  「重新发送会替换后续对话，之前已经执行的文件修改和命令操作不会自动撤销。」
- 新 run 的工具权限、审批、stop 屏障沿用既有流程；不重放旧工具调用。

## 10. UI 与交互

- 用户消息 action bar 增加铅笔「编辑并重新发送」；每个 Turn 的最后一条可见 Assistant 增加
  「重新生成」。复用既有 `iconMarkup` / `createIcon`、`.message-action-btn`、tooltip 与
  hover / `:focus-within` 显现；窄窗口与触屏沿用既有可见性规则。
- 编辑器在**原消息位置**内联展开，不弹页面 / 对话框，不占用 Composer：聊天列宽度、中性灰底、
  克制焦点边框、统一圆角与内距；textarea 预填原文并自动聚焦，随内容增长、到上限内部滚动。
- 底部右侧「取消」（低强调）与「重新发送」（Primary）；Escape 取消；中文 IME 组合期间
  Enter 不提交；空白禁止提交；提交中防双击；失败保留文本；不跳到底部。
- 一次会话只允许一个编辑事务；Composer 草稿不受影响；取消恢复原文。
- 重新生成复用同一事务与导航机制，不打开编辑器；成功后只保留一个用户消息与一条新回复。

## 11. 测试命令、退出码与结果

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `node tests/message-edit-target.cjs` | `Message edit target: 20/20` | 0 |
| `node tests/message-edit-service.cjs` | `Message edit service: 25/25` | 0 |
| `node tests/message-edit-ui.cjs` | `Message edit UI: 26/26` | 0 |
| `PI_GUI_MESSAGE_EDIT_FIXTURE=1 node tests/message-edit-real-pi.cjs` | `Message edit real Pi: 12/12` | 0 |
| `PI_GUI_MESSAGE_EDIT_ELECTRON=1 node tests/message-edit-electron.cjs` | `Message edit Electron: 31/31` | 0 |

- 新增的 target / service / UI / real-Pi 套件已加入 `package.json` 的 `test` 链；real-Pi 默认
  打印 SKIP 并以 0 退出（CI 不依赖真 Pi）。Electron 需要图形环境与真实 Electron，未加入
  `npm test` 链，按上面的环境变量单独运行。
- 本轮未运行完整 `npm test`，按任务约定把全局回归交给 PR CI；已运行的定向套件没有断言数下降。
- 真实 Pi 证据：`sessionId=01a1f4ac-9058-77e6-95c3-828a448f77ec`，会话文件 1 个、6555 字节、
  16 行，5 次模型请求；重启后用户消息为 `["edited first question"]`；guard 场景的中断 leaf 为
  `message/user`，guard 后编辑成功，最终用户消息为 `["edited after interruption"]`。

## 12. 真实 Electron 验收

生产后端（真实 `server.js`）+ 真实 Pi 1.5.2 + 回环确定性模型 + 真实 `BrowserWindow`，临时项目 /
会话 / agent / userData 全部在 `os.tmpdir()`：

- `sessionId=01a1f4ab-88ab-7211-88b0-22404a1aea2e`
- 会话文件 1 个、17467 字节；侧栏条目编辑前 1、编辑后 1
- 5 次模型请求；编辑后的模型上下文只含 `["edited first question"]`
- 标题：编辑前 `first question`（首条用户消息 fallback）；通过生产
  `/api/session-titles/rename` 设为 `手工标题·保留` 后，编辑重发与重新生成后仍为
  `手工标题·保留`，`titleSource=manual`
- 渲染器 console error：0

截图（`.shots/message-edit/`，均为真实 `capturePage`）：

| 文件 | 内容 |
| --- | --- |
| `edit-hover-light.png` | 用户消息 hover 后出现编辑 / 复制按钮 |
| `edit-focus-light.png` | 键盘 focus 显现同一 action bar |
| `editor-light.png` | 原位置内联编辑器、工具警告、取消 / 重新发送 |
| `editor-dark.png` | 深色主题下的同一编辑器 |
| `editor-narrow.png` | 560px 窗口下不越界、无横向页面滚动 |
| `after-resend-light.png` | 编辑后的用户消息、新回复、旧工具与旧回复离开活动路径 |
| `regenerate-light.png` | 重新生成后的新回复与保留的用户原文 |

说明：早先一次 Electron 运行使用 `PI_CODING_AGENT_SESSION_DIR` 把会话文件放到 pi-GUI 会话
列表扫描不到的位置，侧栏只剩 pending 占位行；页面显示的 `second question` 是既有
`pi-gui:classic-prompt-sent` 对 pending 行的临时兜底标题，不是标题被清空。改为 Pi 默认会话
目录后，列表行是真实文件，fallback 为首条用户消息；手动标题在编辑与重新生成后保持不变。

## 13. 身份、文件、侧栏与模型上下文证据

- 编辑前后 `sessionId` 相同；会话文件路径与数量不变（真实 Pi 与 Electron 均为 1 个文件）。
- 旧文本与旧回复仍留在 append-only JSONL 中（`first question` 仍可检索），但 `get_entries`
  的 leaf 路径与 `get_messages` 投影不再包含它们。
- 侧栏条目数量不变（Electron 1 → 1）；没有新会话、没有 fork、没有 `new_session`。
- 模型请求体只包含编辑后的历史（真实 Pi 与 Electron 都断言 `editedModelContext` 为
  `["edited first question"]`）。
- 重启 Pi 后从同一会话文件恢复编辑后的活动路径；guard 场景证明用户消息 leaf 可精确恢复。
- 手动标题通过生产标题服务写入 pi-GUI 元数据，编辑 / 重新生成不触碰它；会话标题存储不在
  Pi JSONL 中，符合既有标题设计。

## 14. 未验证项与残余风险

- 未运行完整 `npm test` / PR CI：全局回归与其它套件的交叉影响待 PR CI 验证。
- Electron 验收只覆盖 Windows 11 + Electron 44.4.3；macOS / Linux 的窗口与输入法行为未实测。
- 真实中文 IME 组合在 jsdom 中按 `compositionstart/end` 事件模拟；真实输入法候选窗行为
  未在 Electron 中自动化，建议人工复核。
- dormant Runtime 历史不支持编辑（设计限制，不降级）；需要在 Runtime 重新激活后才能编辑。
- 图片只验证了 `image` part 的原样重发；其它多模态 part（如未来新增类型）会按
  `attachments_unsupported` 失败关闭，未做前向兼容。
- 若 Pi 未来改变 `navigateTree` 对用户消息 / `custom_message` 的 leaf 语义，事务会在
  `navigate_unverified` 失败关闭；需要按新 Pi 版本重新验收。
- 编辑后的标题：手动 / AI 标题不受影响；pending 会话的临时兜底标题仍可能在列表刷新时回到
  默认值，这是既有行为，不属于本功能对标题的覆盖。

## 15. 变更文件与回滚

新增：

- `server/message-edit.js`、`server/message-edit-routes.js`、`server/session-edit-target.js`、
  `server/message-edit-launch.js`
- `extensions/pi-gui-edit/index.js`
- `public/ui/message-edit.js`、`public/message-edit.css`
- `tests/message-edit-target.cjs`、`tests/message-edit-service.cjs`、`tests/message-edit-ui.cjs`、
  `tests/message-edit-real-pi.cjs`、`tests/message-edit-electron.cjs`

修改：

- `server.js`、`server/router.js`、`server/rpc-bridge.js`、`server/child-env.js`、
  `server/session-runtime.js`、`server/runtime-registry.js`、`server/runtime-routes.js`
- `public/api.js`、`public/index.html`、`public/messages.js`、`public/runtime-conversation.js`、
  `public/runtime-store.js`、`public/ui/message-actions.js`
- `scripts/build-exe.mjs`、`package.json`（测试链）
- `docs/conversation-ui.md`（本功能约束）

回滚：删除上述新增文件，还原上述修改文件与 `package.json` 测试链，重新构建
`npm run build:app -- --rebuild`。回滚不触碰用户会话文件；已发生的编辑只留在 Pi 原生
append-only 历史里，按 Pi 自己的分支语义处理。
