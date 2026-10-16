# UI-2B：Runtime 聊天显示适配 — 验收报告

状态：Agent B 交付（2026-10-16）。基线 `d0585b89a81c0a93e894d58b9d078af75aa985b2`（UI-1 收尾）。
工作区 `C:\pi-GUI-ui2-runtime`，分支 `codex/ui2-runtime`。**未推送、未合并、未发版。**

本轮只动 Runtime 中央聊天视图的**展示**；server、Pi 协议、安全投影、Workspace owner 校验一行未改。

---

## 1. Runtime 可用数据矩阵

三分类按任务要求：① 已有且可直接显示；② 已有但需纯展示处理；③ 当前接口不提供（**不为视觉完整而伪造**）。

| # | 数据 | 类别 | 来源（证据） | 本轮处置 |
|---|---|---|---|---|
| 1 | 会话标题（native sessionName → branch 回退） | ① | `runtime-registry.js:104,320` | 保留 |
| 2 | lifecycle / activity / error / stop | ① | `runtime-registry.js:106-107` | 保留（状态行） |
| 3 | 工具名 + 状态（running/done/error） | ① | `runtime-store.js:56-57` | 改为逐项元素 + `data-state` |
| 4 | 助手正文流（1 MiB 有界） | ① | `runtime-store.js:9,54,63` | 保留 |
| 5 | 审批（id/method/title/options） | ① | `runtime-store.js:58-61` | 保留 |
| 6 | 模型 / Provider / 推理能力（true/false/未知） | ① | `runtime-models.js:57-66`、`model-capabilities.js` | 保留 |
| 7 | 运行名额（totalCount/limit/hardLimit） | ① | `runtime-registry.js:110-111` | 保留 |
| 8 | 只读历史正文（800 条 / 4 MiB 有界） | ① | `server/session-history.js:77-99` | 保留 + 状态行注明范围 |
| 9 | **正文截断标志** | ② | `runtime-store.js:63` `r.truncated` | **新增显示**（此前中央从不显示） |
| 10 | **thinking 文本（流式）** | ② | `session-runtime.js:40` 只收窄 `toolcall_*`；`thinking_delta.delta` 原样转发 | **新增显示**（折叠块） |
| 11 | **thinking 文本（权威终值）** | ② | Pi `docs/json.md`：`message_end.message.content` 的 `{type:'thinking',thinking}` | **新增显示**（覆盖流式累积） |
| 12 | **单轮 usage** | ② | Pi `docs/json.md:67,95`：`message_update.usage` 为该回复累计值 | **新增显示**（只显示报过的数字） |
| 13 | 工具 args / result 正文 | ③ | `projectRuntimeEvent`（`session-runtime.js:30-31`）刻意剥掉 | **不显示、不恢复、不解析正文猜** |
| 14 | 历史 thinking / 工具 / usage | ③ | `session-history.js:23-27` 有意只取 text 片段 | **不显示**，状态行注明「只含正文」 |
| 15 | 逐消息时长 / token 明细 / 上下文占用 | ③ | 并行会话路径无 `get_session_stats` 等价接口 | **不显示**，不做假展开按钮 |

**判定依据**：③ 一律**省略**。任务要求「不得通过解析不可验证的文本输出伪造消息、工具或思考过程」——
本轮没有任何一处从正文文本反推结构。

---

## 2. 实际实现范围

### 2.1 新增 `public/runtime-display.js`（只读展示投影）

为什么单独一个模块而不是改 `runtime-store.js`：任务规定 `runtime-store.js` 原则上只读。
投影**只订阅 `onRuntimeChange`** —— 也就是 store **接受并广播**的那些帧。store 拒掉的帧
（owner 不符 / `eventSequence` 不前进 / 旧 `runtimeGeneration` / `_replay`）根本到不了投影。
因此它不可能接受一条 store 不认的帧，也不复制 lifecycle/tools/approvals，**不构成第二个事实源**。

| 能力 | 说明 |
|---|---|
| `thinking_delta` / `thinking_end` | 按会话累积；`message_start`（assistant）重置 |
| `message_end.message.content` | 取权威 thinking（`thinkingText()`），**无 thinking 块时保留流式那份** |
| `message_update.usage` / `message_end.message.usage` | `readUsage()` 只留 Pi 报过的数字；`source` 区分流式/终值 |
| 有界 | 每会话 thinking 上限 64 KiB（按字节截尾，不切半个字符）；最多保留 64 条会话记录 |
| owner 换代 | 权威快照**不带帧**（`runtime-state.js:25` 的 `broadcast()` 无参）→ 主动 `reconcile()` 核对 |
| 关闭语义 | owner 变 null 时**保留**记录 —— 与 `runtime-store.js:47` 保留 text/tools 一致 |
| `shouldFollow()` | 导出纯函数，近底 160px 判定（与 Classic `messages.js:78` 同一条规则） |

### 2.2 `public/runtime-conversation.js`

- **DOM 语义**：新增 `<details class="ui2-runtime-thinking">`（原生折叠，键盘可达）、
  `<p class="ui2-runtime-usage">`、工具行改为逐项 `<span class="ui2-runtime-tool" data-state>`。
- **历史诚实性**：历史视图隐藏 thinking/usage/工具块，状态行写明 `历史只含正文（无工具、思考、用量）`。
- **截断可见**：正文被 store 截断时状态行补 `仅显示最近输出`。
- **滚动修复**（真实缺陷）：原实现每次 `draw` 都把 `scrollTop` 写回保存值，导致
  「用户上滚读上文 + 后台流式」时每帧被拽回。现改为：切会话恢复保存位置；
  同会话内仅在近底 160px 时跟随，一旦上滚就归用户。
- **工具分隔**：项间用**纯空白文本节点**（不是 `' / '`）—— `.rtc-state` 是 `pre-wrap`
  所以现在每项一行；Agent C 若改成 flex+gap，纯空白文本节点按规范不生成 flex item，自动消失。
- 保留全部原类名：`.runtime-conversation` `.rtc-head` `.rtc-output` `.rtc-controls`
  `.rtc-models` `.rtc-notice`（另有 `.rtc-title` `.rtc-state` `.rtc-model-notice`
  `.rtc-approvals` `.rtc-approval` `.rtc-model-field` `.runtime-resource-count`）。

### 2.3 新增 `tests/ui2-runtime-display.cjs`（74 项断言）

任务点名的每一条都有对应用例（见 §6）。

---

## 3. 与 Classic 仍存在的合理差异

| 差异 | 原因 | 是否本轮可补 |
|---|---|---|
| 工具无展开、无参数/结果正文 | ③ 已被 `projectRuntimeEvent` 剥掉 | 否，需先改 server 安全投影（任务禁止） |
| 无工具批次分组 | store 只有扁平 `tools[]`，无轮次边界 | 否，需改 store 结构（任务要求先记录） |
| 无逐消息 usage / 上下文占用 | 并行路径无对应 RPC | 否 |
| thinking 是单块，不是逐轮块 | 投影按「当前这一条助手消息」累积 | 否 |
| 历史无 thinking/工具/usage | ③ 接口有意只取正文 | 否（已在 UI 上说明） |
| 正文是单一文本流，非逐消息气泡 | store 只有一个 `text` 缓冲 | 否，需改 store 结构 |
| 无「Thought Xs」时长 | ③ 无真实 duration（任务明确禁止用字数换算） | 否 |

**「Runtime 视觉深度差异」是本轮 UI-2 的未达项**（见 §7）。

---

## 4. 文件改动

| 文件 | 状态 | 说明 |
|---|---|---|
| `public/runtime-display.js` | **新增** | 只读展示投影（thinking / usage / `shouldFollow`） |
| `public/runtime-conversation.js` | 修改 | DOM 语义、历史诚实性、截断显示、滚动修复 |
| `tests/ui2-runtime-display.cjs` | **新增** | 74 项断言 |
| `docs/claude-ui-redesign/UI-2B-acceptance.md` | **新增** | 本文件 |

**未改动**（任务禁止）：`public/messages.js`、`public/tool-view.js`、`public/tools.js`、
`public/styles.css`、`public/tokens.css`、`public/index.html`、`package.json`、`server/`、`electron/`。
`runtime-store.js` / `runtime-state.js` 保持只读（未改一行）。

---

## 5. CSS 类名（交付给 Agent C）

新增，统一 `.ui2-runtime-*` 前缀：

| 类名 | 元素 | 现状（无 CSS 时） | 建议 |
|---|---|---|---|
| `.ui2-runtime-thinking` | `<details>` | 原生折叠三角 + 内容 | 对齐 Classic `.think-body` |
| `.ui2-runtime-thinking-head` | `<summary>` | 纯文本 `思考过程 · N 字` | 次要色、可点 |
| `.ui2-runtime-thinking-body` | `<pre>` | **不换行**（见下方 ⚠️） | `white-space:pre-wrap;overflow-wrap:anywhere` |
| `.ui2-runtime-usage` | `<p>` | 纯文本一行 | 小字号、次要色；`[hidden]` 已由全局规则覆盖 |
| `.ui2-runtime-tools` | `<div>`（**同时带 `.rtc-state`**） | 每项一行 | 可改 flex+gap（空白节点会自动消失） |
| `.ui2-runtime-tool` | `<span>` | 纯文本 `名字 · 状态` | 按 `[data-state="running\|done\|error"]` 着色 |

> ⚠️ **必须补的一条 CSS**：`.ui2-runtime-thinking-body` 目前**不换行**。
> Classic 的 `.think-body`（`styles.css:451`）自带 `white-space:pre-wrap;overflow-wrap:anywhere`，
> 而 `<pre>` 默认 `pre` 不换行。真实 Chromium 截图确认：长思考内容会让中央列出现**容器内横向滚动条**
> （页面本身无溢出，`scrollWidth === innerWidth`）。这是 Agent C 的样式工作，本轮不改 `styles.css`。

---

## 6. 安全约束与回归测试结果

### 6.1 保护项逐条

| 保护项 | 本轮如何保证 |
|---|---|
| A、B 多会话独立状态 | 投影按 `conversationId` 分记录；视图态全部按会话存（沿用 P32.4-B 约定） |
| A→B→A 迟到事件 | 帧由 store 按 owner+sequence 先判；投影只收已接受的帧 |
| 完整 Workspace owner | 未改；动作仍用开始时捕获的 owner（`owned()` / `action()`） |
| runtimeGeneration / revision / eventSequence | 未改判定；投影额外挡一次非递增序号（纵深防御） |
| 草稿隔离 | 未改（`views` 按会话存 `draft`） |
| 滚动位置隔离 | 未改（`scrollTops` 按会话）；只修了「同会话内流式抢视口」 |
| 历史读取不启动新 Runtime | 未改；测试断言 `requests.length === 0` |
| 运行中/停止中/错误/历史态动作可用性 | 未改判据；新增用例断言关闭态禁用 |
| 有界内存与截断 | store 1 MiB 不变；投影 64 KiB/会话、64 会话上限 |
| XSS / 不可信输出 | 全部 `textContent`；用例断言注入节点数为 0 |
| 不新增第二个事实源 | 投影只订阅 store 已广播的帧，不复制 lifecycle/tools/approvals |

### 6.2 实测数字

| 命令 | 结果 |
|---|---|
| `node tests/ui2-runtime-display.cjs` | **74/74**，退出 0 |
| `npm run test:runtime` | **退出 0**，394 项 `ok`，0 失败 |
| `node tests/smoke.cjs` | **1338/1338**（改动前基线同为 1338/1338 —— **断言总数未变少**） |
| `node tests/modules.cjs` | **117/117** |
| `node tests/runtime-conversation.cjs` | 48/48 |
| `node tests/runtime-finish-ui.cjs` | 27/27 |
| `node tests/runtime-store.cjs` | 25/25 |
| `node tests/runtime-ui.cjs` | 16/16 |
| `node tests/runtime-resources.cjs` | 45/45 |
| `node tests/runtime-history-search.cjs` | 35/35 |
| `node tests/runtime-nav.cjs` | 38/38 |
| `node tests/runtime-models.cjs` | 51/51 |
| `node tests/usage-quota.cjs` | 229/229 |
| `node tests/web-access.cjs` | 66/66 |
| `node tests/subagents.cjs` | 141/141 |
| `node tests/memory.cjs` | 236/236 |
| `node tests/browser.cjs` | 215/215 |
| `node tests/approvals.cjs` | 80/80 |
| **真实 Electron** `node tests/runtime-electron.cjs` | **170/170，退出 0，43 张截图，无 renderer console error** |

> 环境说明：worktree 内无 `node_modules`（`npm test` 的既有约定），jsdom/Electron 经
> `NODE_PATH=C:\pi-GUI\node_modules` 解析。未改 `package.json`，新套件留给集成阶段注册。
> 本机既有红（`test:installer` / `test:app` / `test:exe` 的环境限制）与本轮无关，未去追。

### 6.3 真实 Chromium 证据（非 jsdom）

用生产 server + 真实 Electron 渲染，注入 thinking / usage / 混合工具状态：

```
thinking  : 155 字
head      : 思考过程 · 155 字
usage     : 本轮 · 输入 12,480 · 输出 317 · 缓存读 9,000 · 推理 88 · 预估成本 0.0123（流式中，Pi 仍在累计）
tools     : ["read · 完成 [done]", "bash · 失败 [error]"]
overflow  : scrollWidth 1266 === innerWidth 1266（无页面横向溢出）
```

**已知排版缺口**：思考块长文本在容器内横向滚动（§5 ⚠️）——属 Agent C 的样式范围。

### 6.4 本轮修掉的一个真实缺陷

滚动：原 `draw()` 每次无条件 `output.scrollTop = scrollTops.get(id)`。用户上滚读上文时，
后台每来一帧就被拽回切过来那一刻的位置，**根本读不了**。现按「近底 160 才跟随」处理，
并用纯函数 `shouldFollow()` 把边界（含恰好 160 不跟随）直接断言，不依赖 jsdom 的假布局。

### 6.5 测试过程中发现并修正的一处自相矛盾

初版投影在 `runtime_closed` 时删除记录，导致「关闭后 thinking/usage 消失，但 store 仍留着
text/tools」。这与 `runtime-store.js:47`（关闭只清 approvals、保留 text/tools）**不一致**。
已改为与 store 同一语义，并把这条一致性本身写成断言
（`关闭后正文与工具与 store 保持一致`）。另外补上 `seedRuntimeSnapshot` **不带帧**这条路径的
换代核对（真机上就是「刷新会话列表」）。

---

## 7. 未实现项及原因

| 未实现 | 原因 | 需要什么才能做 |
|---|---|---|
| 工具 args/result 正文 | server 安全投影刻意剥掉（`session-runtime.js:30-31`） | 独立的安全设计审查 + 改 server 白名单 |
| 工具批次分组 / 逐消息气泡 | store 只有扁平 `tools[]` 与单一 `text` 缓冲 | 改 `runtime-store.js` 结构（本轮只读，任务要求先记录需求） |
| 历史 thinking/工具/usage | `session-history.js:23-27` 有意只取正文 | 改 server 历史投影（任务禁止） |
| 逐消息 usage / 上下文占用 | 并行路径无对应 RPC | 需要新协议或后端聚合 |
| thinking 真实时长 | ③ 无 duration | 上游提供才有；**不用字数换算** |
| 模型/Composer 深度适配 | 属 UI-3 | — |
| 右栏/审批视觉统一 | 属 UI-4 | — |
| Runtime 视觉深度差异 | 上述缺项的合并结果，**列为 UI-2 未达项** | 按计划：独立数据展示方案审查后再扩大 |

---

## 8. 分支与提交 SHA

- 分支：`codex/ui2-runtime`
- 基线：`d0585b89a81c0a93e894d58b9d078af75aa985b2`（UI-1 收尾）
- 工作区：`C:\pi-GUI-ui2-runtime`
- 提交：分支上**唯一**一个提交，subject 为 `UI-2B：Runtime 聊天的安全展示投影`；
  SHA 用 `git rev-parse HEAD` 取（**本文件本身就在这个提交里**，自指 SHA 写进来就会变，
  所以不写死）。本地提交，**未推送、未合并、未发版**。
- 提交内容（4 个文件，一个回滚边界，可整体回退，不需要动 store / server）：
  `public/runtime-display.js`（新增）、`public/runtime-conversation.js`（改）、
  `tests/ui2-runtime-display.cjs`（新增）、`docs/claude-ui-redesign/UI-2B-acceptance.md`（新增）。

---

## 9. 集成注意事项

1. **注册测试**：`tests/ui2-runtime-display.cjs` 需加进 `package.json` 的 `test` 链与
   `test:runtime` 链（本轮按任务要求未改 `package.json`）。
2. **Agent C 必做**：给 `.ui2-runtime-thinking-body` 加
   `white-space:pre-wrap;overflow-wrap:anywhere`（§5 ⚠️），否则长思考内容横向滚动。
3. **类名契约**：新类名一律 `.ui2-runtime-*`；`.ui2-runtime-tools` **同时保留 `.rtc-state`**
   （继承旧样式，避免无 CSS 时塌掉）。不要给工具项之间加分隔符 CSS 内容
   （`::before`/`content`）—— 项间是纯空白文本节点，加了会在 flex 布局下重复。
4. **不要**把 Runtime 绑到 Classic 的全局 `S`：本轮所有数据来自 runtime store 与
   runtime-display 投影，两个视图各自独立。
5. **历史诚实性**是刻意行为：历史视图隐藏 thinking/usage/工具并写明原因。
   若将来后端历史接口补齐这些字段，应同时改 `HISTORY_NOTE` 与相关断言，不要只删提示。
6. **投影所有权**：`createRuntimeConversation` 默认自建投影并随 `dispose()` 释放；
   传入 `display` 时所有权在调用方。新增视图请沿用这一约定，避免订阅泄漏。
7. **回退边界**：本阶段可整体回退（`runtime-display.js` + `runtime-conversation.js` 的
   UI-2B 部分 + 新测试）。原 P32.4-B 契约（owner/sequence/草稿/滚动隔离/历史 vs 恢复）
   一条未改，回退不需要动 store 或 server。
