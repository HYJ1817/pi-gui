# Pi Memory / 长期记忆（P18）

Pi GUI 对「历史」有三类，来源、生命周期、权限都不同，**不合成一套状态机**：

| | 谁提供 | 是什么 | 存在哪 | 入口 |
|---|---|---|---|---|
| **Session History**（会话历史） | Pi session + Pi GUI | 历史会话、当前会话消息、过去的提问 | `~/.pi/agent/sessions/**/*.jsonl` | 侧栏会话列表 / 会话搜索 / 提问导航 |
| **Agent Memory**（长期记忆） | **Pi Extension**（默认 `pi-memory`） | durable facts、偏好、决策、daily log、scratchpad、可选语义检索 | Extension 自己决定（pi-memory 是 `~/.pi/agent/memory/`） | Pi / 模型调用 Memory 工具 → 本文的 Tool Activity |
| **Project History**（项目历史） | Git / 仓库本身 | commits、文件演进、写在仓库里的决策 | 仓库 | 侧栏「文件变更」/ Git diff |

三条硬边界：

- 会话搜索结果**不会**自动写进 Memory；
- Memory 条目**不会**变成会话；
- Git commit **不会**变成 Memory。

Pi GUI 也不做「统一搜索全部」：三者权限不同、生命周期不同、结果语义不同，
合起来只会得到一个说不清来源的混合列表。需要统一检索时另开一阶段设计。

## 一、当前适配的 Extension

2026-09-30 核对 npm 当前发布版 **`pi-memory` 0.4.2**（无 beta/next tag）：

| | |
|---|---|
| 包 | [`pi-memory`](https://www.npmjs.com/package/pi-memory)（**不带 scope** 的那个） |
| 仓库 | [jayzeng/pi-memory](https://github.com/jayzeng/pi-memory)（MIT） |
| 发布 | 2026-08-11，`gitHead 39e6b998a2279c8fad4a2c6c64e26828c1d6023e` |
| 入口 | `main: index.ts`，manifest `"pi": { "extensions": ["./index.ts"] }` |
| 运行依赖 | **0 个**；peer 是 `@earendil-works/pi-ai` / `pi-coding-agent` >= 0.81.1 |
| 安装 | `pi install npm:pi-memory` |

> ⚠️ 同名包不止一个：`@zhafron/pi-memory`（仓库 `tickernelz/pi-memory`）、
> `@henryqw/pi-memory`、`@chendpoc/pi-memory` 都是**别的**包。
> `pi install npm:pi-memory` 装的是 jayzeng 那个。
> 本文所有 tool schema / details 形状都来自 **0.4.2 的发布 tarball**
> （`index.ts`，`npm pack pi-memory` 取的 6 个文件之一），不是 README 摘要，
> 也不是仓库 `main`（`main` 已领先发布版约 6 周，多了**未发布的** `refresh`
> snapshot 模式等）。契约只按 v0.4.2 钉：`v0.4.2` tag 与 npm 发布包指向同一个
> commit `39e6b998a2279c8fad4a2c6c64e26828c1d6023e`，tag 上的 `index.ts` 与
> 发布 tarball **逐字节相同**。
> 核对方式与文件清单见本文末「复现核对」。
>
> 契约核对版本**不是** GUI 的安装要求：GUI 不检查版本号，只按工具名投影。

## 二、安装策略

沿用 P16 / P17：**第一版不自动安装**。

Extensions 页的 Pi Memory 区块只给：

- 状态（见下）
- 固定命令 `pi install npm:pi-memory` + 「复制安装命令」
- 「安装后重启 Pi」——复用现有确认框与 `POST /api/restart`（`rpc.restart()`）

不做：`npm install`、改 `node_modules`、写 `~/.pi/agent/settings.json`、
clone 仓库、自动装 / 启用 / 配置 qmd、自动建索引。Pi GUI 不接管第三方包管理器。

## 三、状态模型

四个状态分开表达，谁都不要替谁说话：

| 状态 | 证据来源 | 缺证据时 |
|---|---|---|
| `installed` | Extension Registry 在磁盘上发现 `pi-memory` | `null`（未知），**不**因为 `~/.pi/agent/memory/` 存在就推断 |
| `configured` | Registry 的 `enabled` 证据 | `null`（存在 ≠ 已启用） |
| `loaded` | Registry 的 `loaded` 证据 | `null`（Pi RPC 没有权威 tool list，也不报告加载成功） |
| `runtimeObserved` | 当前 workspace generation / bridge run 内真实收到过该工具的 `tool_execution_start/update/end` | 一律 `false` |

- 只有真实 tool event 才算观察到；历史重建（`toolCall` / `toolResult` 消息）
  **不**产生运行时观察。
- restart / 切项目 / 退出 / 错误 / 无项目一律清空观察。
- 切换工作区同步期间，旧 bridge run 的事件被丢弃（`acceptMemoryEvent`）。
- `qmdAvailable` / `semanticSearchAvailable` **不**在 GUI 里单独建模：
  它只有出现在真实 tool result 里（`memory_status` 的 `details.qmd` / `collection` /
  `embeddings`）才展示，见第六节。

## 四、真实工具清单（0.4.2）

7 个 `pi.registerTool`，名字**不加前缀**。下表参数与 details 全部照源码抄。
GUI 按**工具名**匹配（不绑定包名），并且只投影 allowlist 字段。

| 工具 | 参数（TypeBox，无声明默认值） | result `details` | Activity |
|---|---|---|---|
| `memory_write` | `target` enum `long_term`/`daily`；`content`；可选 `mode` enum `append`/`overwrite`（默认 append，daily 恒 append） | `path`、`target`、`mode`、`sessionId`、`timestamp`、`qmdUpdateMode`、`existingPreview` | Saving memory… → Saved to memory / Added to daily log |
| `memory_read` | `target` enum `long_term`/`scratchpad`/`daily`/`list`；可选 `date` (`YYYY-MM-DD`) | `list`→`files[]`；`daily`→`path`+`date`；`scratchpad`/`long_term`→`path`；**soft-failure 是 `{}`** | Reading memory… → Read long-term memory / Read scratchpad / Read daily log / Listed daily logs（缺证据时 → Memory read result unavailable）|
| `memory_search` | `query`；可选 `mode` enum `keyword`/`semantic`/`deep`（默认 keyword）；可选 `limit`（代码 clamp 到 1–25，默认 5） | `mode`、`query`、`count`、`needsEmbed`（零结果 + semantic/deep 时另有 `embedStarted`） | Searching memory… → Searched memory |
| `memory_forget` | `match`；可选 `target` enum `long_term`/`daily`（默认 long_term）；可选 `date` | `path`、`target`、`removed`、`recoveryId`、`recoveryPath`、`removedPreview`；无匹配时只有 `path` + `removed: 0` | Forgetting memory… → Removed from memory / No matching memory |
| `memory_restore` | `recoveryId` | `recoveryId`、`target`、`path`、`restored`；已恢复过则是 `recoveryId` + `restoredAt` | Restoring memory… → Restored memory entries / Memory already restored |
| `memory_status` | 无参数 | `dir`、`longTermChars`、`scratchpadOpen`、`scratchpadTotal`、`dailyCount`、`latestDaily`、`qmd`、`collection`、`embeddings`、`snapshotMode`、`qmdUpdateMode` | Checking memory status… → Checked memory status（一条白名单字段都没有时 → Memory status result unavailable）|
| `scratchpad` | `action` enum `add`/`done`/`undo`/`clear_done`/`list`；可选 `text` | `list`→`count`+`open`+`preview`；`add`/`done`/`undo`→`action`+`sessionId`+`timestamp`+`qmdUpdateMode`+`preview`；`clear_done`→`action`+`removed`+`qmdUpdateMode`+`preview`；**soft-failure 是 `{}`** | Updating scratchpad… → Added to scratchpad / Checked off scratchpad item / Reopened scratchpad item / Cleared done scratchpad items / Read scratchpad（缺证据时 → Scratchpad result unavailable）|

未适配的工具（例如别的 Extension 也叫 `memory_*`，或 `memory_export`）继续走
`tool-view.js` 的 **generic fallback**（显示「执行工具 <原始名>」）。
不为「通用化」提前发明不存在的工具名。

### 请求参数不是成功证据

Activity 的 running 文案描述**在做什么**（`Saving memory…` / `Reading memory…`），
用 args 就够了。但 success 文案只说**发生了什么**，所以必须有真实的 result `details`：

| 工具 | success 需要的证据 | 没有证据时 |
|---|---|---|
| `memory_write` | `details.target` ∈ {`long_term`,`daily`} | Memory write result unavailable |
| `memory_read` `long_term` | `details.path` | Memory read result unavailable |
| `memory_read` `scratchpad` | `details.path` | Memory read result unavailable |
| `memory_read` `daily` | `details.path` **且** `details.date` 合法 `YYYY-MM-DD` | Memory read result unavailable |
| `memory_read` `list` | `Array.isArray(details.files)` | Memory read result unavailable |
| `scratchpad` `add`/`done`/`undo` | `details.action` 等于该 action | Scratchpad result unavailable |
| `scratchpad` `clear_done` | `details.action === "clear_done"` 且 `removed` 是非负整数 | Scratchpad result unavailable |
| `scratchpad` `list` | `count` 或 `open` 是非负整数 | Scratchpad result unavailable |
| `memory_search` | `details.count` 是非负整数 | Memory search result unavailable |
| `memory_forget` | `details.removed` 是非负整数 | Memory forget result unavailable |
| `memory_restore` | `details.restored` 是非负整数，或 `restoredAt` 存在 | Memory restore result unavailable |

`memory_read` 的 soft-failure 是**真实存在**的分支：`MEMORY.md` / `SCRATCHPAD.md`
不存在、那天没有 daily log、`list` 没有任何日志，0.4.2 都返回 `details: {}`。
所以「`args.target = daily`」只说明模型请求读 daily，**不能**推出
「Read daily log」；`args.date` 同理（它只作为 `Requested date:` 展示，
真正的 `Date:` 只来自 result）。scratchpad 的 `{}` 出现在空清单、
没有匹配项、缺 `text`、以及未知 action 这些分支。

**不解析 raw result 文本**去区分 `No daily log for …` 这类文案：那既是正文/路径
的泄露面，文案本身也不是稳定 API。details 不够就是「结果不可用」。
`args.text`、`details.preview`、`existingPreview`、`removedPreview` 一律不进 DOM。

> 对于 pi-memory 0.4.2 的某些 soft-failure，Pi 0.87.0 可能仍把
> `tool_execution_end` 表现为非 error。Pi GUI 因此**要求结构化 details 证明成功**；
> 缺证据时显示「结果不可用」，而不是根据请求参数猜成功。这也意味着 GUI 不会
> 把「没有成功证据」强行改判成失败 —— 它只能断言证据不足。

### pi 0.87.0 的一个事实：Extension 自己返回的 `isError` 到不了 GUI

`pi-memory` 在若干分支里 `return { content, isError: true, details: {} }`
（空 `match`、非法日期、qmd 缺失、collection 建不起来、search 抛错……）。
但 pi 的 agent loop 只要 `execute` **正常 return** 就写 `isError: false`
（`@earendil-works/pi-agent-core/dist/agent-loop.js`：`return { result, isError: false }`），
只有 `execute` **抛异常**才走 `createErrorToolResult` 并置 `isError: true`。
`pi-coding-agent` 的 `afterToolCall` 也只从 `tool_result` hook 里取 `isError`
（`pi-memory` 没有注册这个 hook）。

**结论**：GUI 的 status 权威只有 `tool_execution_end.isError`，
它反映的是「工具抛异常」，不是「Extension 在 result 里说自己失败」。
所以当已知工具**成功返回但没有该 schema 必有的结构化字段**时
（memory_search 的 `count`、memory_forget 的 `removed`、memory_write 的 `target`……），
Activity 降级成「…结果不可用 / Result metadata unavailable」，
**不猜成失败，也不猜成 0 条**。历史与实时同一条规矩。

## 五、scope：只有 global

`resolveMemoryDir()` 只认 `PI_MEMORY_DIR`，否则用
`HOME` / `USERPROFILE` / `HOMEDRIVE`+`HOMEPATH`，落点是 `~/.pi/agent/memory`。
源码里**没有** cwd / project scope，所以 UI 里也不会出现「项目记忆」。

```
~/.pi/agent/memory/
  MEMORY.md              # 长期记忆（决策、偏好、事实）
  SCRATCHPAD.md          # 待办清单
  daily/YYYY-MM-DD.md    # 每日 append-only 日志（按本地日历日）
  recovery/<uuid-v4>.json# memory_forget 的恢复记录
```

日期用**本地日历日**，不是 UTC。`PI_MEMORY_DIR` 可以改掉整个位置。

Pi GUI **不读这个目录**（不扫描、不索引、不复制、不进 localStorage、
不扫描 `recovery/`），也不因为目录存在就推断 Extension 已加载。
布局写在这里只是为了说明「路径来自哪里」，不是给 GUI 的读取清单。

## 六、qmd 边界

qmd 是 Extension 的**可选外部依赖**（`npm install -g @tobilu/qmd`
或 `bun install -g https://github.com/tobi/qmd`），只有 `memory_search` 需要它；
`memory_write` / `memory_read` / `scratchpad` 等纯文件操作不需要。

- 检测方式：Extension 用 `execFile("qmd", ["collection","list"])` 探 PATH
  （不是环境变量、不是配置文件）。Windows 上会绕开坏掉的 npm shim，
  直接 `node <PATH>/node_modules/@tobilu/qmd/dist/cli/qmd.js`。
- 模式 1:1 映射到 qmd 子命令：`keyword`→`search`、`semantic`→`vsearch`、
  `deep`→`query`。**没有自动跨模式 fallback**；唯一的自愈是 embeddings：
  stderr 出现 `need embeddings` 时后台跑 `qmd embed` 并让模型重试。
- 自动建 collection：`session_start` 时 `qmd collection add <MEMORY_DIR> --name pi-memory`，
  并做一次 catch-up `qmd embed`。

**Pi GUI 不管理 qmd**：不安装、不配置、不改 PATH、不检测系统包管理器、
不跑 `qmd index/update/embed`、不读 qmd DB。
Activity 里 `Mode:` 只在 result 明确给出 `details.mode` 时显示 ——
**不因为「装了 qmd」就猜某次检索是 semantic**。
`qmd` / `collection` / `embeddings` 只在 `memory_status` 的真实结果里展示；
`qmd: unavailable` 时只补一句源码支持的「memory_search requires qmd」，
不编造 fallback 档位。

## 七、自动发生的事（GUI 只当背景）

这些**不是** GUI 行为，也不需要 GUI 展示：

- **每轮注入**：`before_agent_start` 把 memory 快照拼进 `systemPrompt`
  （`# Memory` 段落 + 一段固定说明）。`PI_MEMORY_SNAPSHOT` 在 **v0.4.2 只认两个值**：

  | 取值 | v0.4.2 的真实行为 |
  |---|---|
  | `stable`（**默认**） | 复用上一次算好的快照；只有 `memorySnapshot === null`（首次）、`snapshotDirty`、或本地日期翻转（`snapshotTakenOnDate !== today`）时才重算。目的是让注入块字节稳定，不打掉 prompt prefix cache |
  | `per-turn` | 每轮重新 `buildMemoryContext()`，并按 `PI_MEMORY_NO_SEARCH` 决定是否先做一次关键词检索（`searchRelevantMemories`，取前 3 条、3 秒超时） |
  | 其它取值（含 `refresh`） | **回落到 `stable`** —— `getSnapshotMode()` 的实现是 `mode === "per-turn" ? "per-turn" : "stable"` |

  谁是「authority-changing」、谁会让 `stable` 快照在下一轮变新，按 v0.4.2 源码是：

  | 操作 | 是否立刻反映到注入块 |
  |---|---|
  | `memory_write` `target=long_term` | 是 —— 置 `snapshotDirty`，下一轮重算 |
  | `memory_write` `target=daily` | **否** —— 源码注释明确说 daily 写入高频、已由工具调用回显，**故意不置位**；要等日期翻转或一次 compaction |
  | `memory_forget` | 是 —— 置 `snapshotDirty`（「被忘掉的事实也必须离开注入快照」）|
  | `memory_restore` | 是 —— 置 `snapshotDirty` |
  | `session_before_compact` | 是 —— 无条件 `refreshMemorySnapshot("session_before_compact")`：compaction 会丢掉工具历史，快照必须追上磁盘 |
  | `session_start` | 是 —— 每次都重算 |

  所以 `stable` 不等于「永远不变」，也不等于「写入必刷」：长期记忆写入、forget、
  restore 会在**下一轮**生效，daily 写入不会。

  > `refresh` 是仓库 `main` 上**尚未发布**的第三种模式，v0.4.2 的 tag 与 npm 发布包
  > （同一 commit `39e6b998`，`index.ts` 逐字节相同）里都没有它。
  > `memory_status` 的 `details.snapshotMode` 因此只可能是 `stable` / `per-turn`；
  > GUI 的 `Snapshot:` 也只认这两个值，别的取值保持未知（不为未发布字段提前适配）。

  注入优先级：scratchpad > 今天的 daily > 检索结果 > MEMORY.md > 昨天的 daily，
  各部分与整体都有字符/行数上限，整体上限 16000 字符。
- **退出摘要**：`session_shutdown` 用 LLM 生成摘要写进**今天的 daily log**
  （默认开启，`PI_MEMORY_EXIT_SUMMARY=0` 关闭；`/reload`、`/new`、`/resume`、
  `/fork` 这类生命周期切换默认跳过）。需要真模型，GUI 不触发也不复制。
- **压缩前 handoff**：`session_before_compact` 把 open scratchpad + 今天日志最后 15 行
  追加进 daily log。

`pi-memory` **没有注册任何 slash command**（只读 `/quit` 用来标注退出摘要）。
所以文档与 UI 都不提「Memory 命令」。

**GUI 不把这些注入内容复制进对话时间线**，也不每轮显示「Injected memory N KB」：
P18 第一版只关心**显式的 Memory tool activity**。

## 八、Tool Activity 数据流

```
Pi RPC/SSE → workspace/run guard（acceptMemoryEvent）
           → ToolEntry（实时事件或历史 toolCall/toolResult，同一形状）
           → memoryActivity(entry)  ← 白名单语义投影
           → Tool Timeline DOM
```

- 实时与历史共用 `memoryActivity(entry)`，**历史不另写解析**；
  两边渲染出的文案与 facts 必须一致（`tests/memory.cjs` 有对拍断言）。
- 历史缺 details 时安全降级成「…结果不可用」；status 不在已知集合里
  （以及缺 status）降级成中性文案 `Memory operation`。**不猜。**
- 并发按 `toolCallId` 独立，不按工具名合并；逆序结束不会串结果。
- Stop / 中断沿用 Pi 原有机制：`settleRunning()` 把还在 running 的条目收成
  `incomplete`，Activity 显示「…已停止」，不遗留 spinner。
  GUI 不会自动 retry qmd 或重建索引。
- **Git 不刷新**：memory 工具不是 `MUTATING_TOOLS`，其参数里没有项目文件路径，
  `details.path` 指的是记忆文件本身而不是仓库文件。按「无法可靠判断就不刷新」，
  P18 不接 `scheduleGitRefresh()`，也不往 Changes 账本记一笔。

## 九、安全投影

默认**不全文铺开**。允许进 DOM 的只有这些（全部来自真实 schema）：

- `memory_write`：`target`、`mode`
- `memory_read`：`target`、合法 `date`、`files` 的**条数**
- `memory_search`：`query`（≤200 字符、单行）、`mode`（枚举内）、`count`、
  `needsEmbed`、`embedStarted`、请求里的 `limit`
- `memory_forget`：`match`（≤200、单行）、`target`、`removed`、
  「有 recoveryId」这个**事实**（不显示 ID）
- `memory_restore`：`restored`、`target`、「有 restoredAt」
- `memory_status`：`longTermChars`、`scratchpadOpen/Total`、`dailyCount`、
  合法 `latestDaily`、`qmd`、`collection`、`embeddings`、`snapshotMode`、`qmdUpdateMode`
- `scratchpad`：`action`（枚举内的才写具体动作）、`count`、`open`、`removed`

**明确排除**（即使出现在 args / details / result 文本里也不进 DOM）：

| 字段 | 原因 |
|---|---|
| `path`、`recoveryPath`、`dir` | 绝对路径，含用户名 |
| `files[]` 的元素 | 日志文件名（只给条数） |
| `existingPreview`、`removedPreview`、`preview`、`removedContent` | 记忆原文 |
| `sessionId`、`timestamp` | 标识与时间，对用户没有价值 |
| `content`、`markdown`、`raw`、`fullText`、`memory` | 记忆正文 |
| `env`、`token`、`apiKey`、`credential` | 凭据 |
| `embedding`、`vector` | qmd 内部数据 |
| tool result 文本全文 | `memory_read` 的文本就是**整个** MEMORY.md / daily log / scratchpad |

做法上不是黑名单：`tool-view.js` 一旦识别为 Memory 语义工具，
`entry.output` 被替换成 facts、`argsText` 置空 —— 原始 result 文本与
raw args/details 根本没有进 DOM 的机会。渲染一律走 `textContent`，
所以 `<img onerror>`、`<script>` 之类只是文本。
响应里也不会出现绝对路径：Activity 只投影白名单。

Pi 仍然保存原始 tool result 并交给模型使用 —— GUI 只是不显示它。

## 十、明确不做

- 不实现 Memory 引擎：没有 vector DB、embeddings、SQLite、qmd wrapper、
  语义索引、summarization pipeline、自动抽取 / 合并 / 排序
- 不做 Memory Browser / 编辑器 / Daily Log 浏览器 / Scratchpad 编辑器 /
  Recovery UI / Trash UI / vector DB inspector
- 不做自动 remember / forget / summarize，不把会话或 Git history 写进 Memory
- 不做 Permission system、Quota、FleetView、cloud sync、ChatGPT Memory 同步
- **不把 Scratchpad 和 Planner 连起来**：`SCRATCHPAD.md` 不等于 Planner task，
  两个方向都不桥接，用户明确要求以后再设计
- 不做统一「搜索全部」（Sessions + Memory + Git + Files）

关于命名：这里的 Memory 是**本地 Pi Extension 的 agent memory**，
不是 ChatGPT Memory / OpenAI 账号记忆 / 云端记忆。UI 里写的是
「Pi Memory（长期记忆）」，不写模糊的「Memory」。

`pi-memory` 也不等于 OpenAI 的账号记忆；它与 Pi GUI 的会话搜索是两套东西。

## 十一、验证

`npm run test:memory`（已并入 `npm test`，完全离线）：

- 7 个真实工具的识别与 start/success/error/settled/unknown 文案
- **请求意图 ≠ 成功证据**：`memory_read` 四个 target 与 `scratchpad` 五个 action
  各自「有证据 → 成功文案 / 只有 `{}` → …result unavailable」成对断言；
  `memory_write` 也不拿 `args.target` 顶成功
- **soft-failure 形状**（`details: {}`）不被误报成 success，也不被强行改成 error
- memory_search：query 的边界与单行、`count` 的真实性（缺字段不写成 0）、
  `mode` 只信 result、`needsEmbed` / `embedStarted`
- memory_write / read / forget / restore / status / scratchpad 各分支，
  含 `removed: 0`（不是删除）、recovery「可恢复」但 ID 与路径都不出现
- `snapshotMode` 的 `stable` / `per-turn` 会展示；`refresh` 不是 v0.4.2 的值，
  仍按未知处理（不为未发布字段提前适配）
- 敏感字段（`path`/`recoveryPath`/`dir`/`preview`/`env`/`token`/`apiKey`/
  `embedding`/`vector`/`content`…）在投影与 DOM 里都不出现
- raw args / details / result 文本不进 DOM；hostile HTML 惰性；
  soft-failure 的 raw 文本（含路径、SECRET、`<img onerror>`、`<script>`）同样不进 DOM
- runtime observation：初始未观察、按工具独立、generation / bridge run 隔离、
  restart 与 no-project 清空、其它 Extension 不能污染
- installed / configured / loaded 三值，Registry 失败保持未知，无自动安装
- 历史与实时同一投影、缺 details 降级、无伪造 duration；
  history 的 read / scratchpad soft-failure 与实时同一结论
- 回归：Session Search / Planner / Web / Subagent / Extension Registry /
  Changes 账本 / git 刷新都不受影响

`tests/smoke.cjs` 的 P18 段落走**真实 SSE**：并发 id 隔离、逆序完成、
raw args/details 为空、不额外刷新 Git、不进 Changes 账本、不发 RPC、
Runtime evidence 显示、切项目期间丢弃旧事件、Stop 收尾、重启清空观察、
旧 workspace 的确认框不重启。

`npm run shots:harness` 的 **160 / 161 / 162** 三条真实 Chrome 场景：
写入 + 检索（正文与绝对路径都不在 DOM 里）、忘记 + 状态 + scratchpad
（recovery ID 与路径不展示）、Extensions 页的 Pi Memory 设置区
（运行观察来自真实事件、只有「复制安装命令」与「安装后重启 Pi」两个按钮）。

> 顺带修了一个 harness fixture 的失真：真实 SSE 会给事件带 `bridgeRun`，
> 而 harness 以前不带 —— 于是 Extensions 页的 runtimeObserved 在真实浏览器里
> **永远**显示「尚未观察到调用」，谁也验不出来。现在按真实形状补上。

默认测试**完全离线**：不安装 `pi-memory`、不安装 qmd、不调用真实 embedding、
不联网、不读 `~/.pi/agent/memory`、不修改 / 删除真实记忆、不跑真实索引、
不消耗模型 quota —— 全部 fixture。

### 复现契约核对

```
npm view pi-memory version dist-tags time gitHead repository.url
npm pack pi-memory            # 6 个文件：package.json / index.ts / README.md /
                              # CHANGELOG.md / LICENSE / scripts/postinstall.cjs
```

然后读解压出来的 `index.ts`：7 个 `registerTool` 的 `parameters` 与每个分支的
`details` 就是本文第四节的来源。**不要**拿仓库 `main` 当依据 —— 它多了未发布的
`refresh` snapshot 模式等。要按 tag 核对就取 `v0.4.2` 指向的那个 commit
（=`gitHead`），再比对 tag 上的 `index.ts` 与发布 tarball 是否一致。

### 手工 live 验收（不属于默认 CI，本阶段未执行）

前提：`pi install npm:pi-memory`，重启 Pi，选择可用模型。

| | 步骤 | 确认 |
|---|---|---|
| A | 「Remember that this project uses pnpm, not npm.」 | 模型真实调用 `memory_write`，GUI 显示 Saved to memory；**不**显示 MEMORY.md 全文 |
| B | 新会话问「What package manager does this project use?」 | 观察 Extension 是否靠注入答对。**答对不等于 GUI 观察到 `memory_search`** —— 只有真实 tool event 才算 runtimeObserved |
| C | 「Search memory for package manager decisions.」 | 确认 `memory_search` Activity：Query / Matches / 有则 Mode |
| D | 若支持 forget：删掉测试条目 | 显示 Removed from memory / Recovery available，**不**暴露 recovery path；没有 Memory Trash UI |
| E | 重新打开历史会话 | Memory Activity 语义与实时一致；重启后 Extensions 页观察归零 |

qmd 可选：装了才可能有 `semantic` / `deep`，没装时 `memory_search` 需要 Extension
自己报告状态。**没有现场安装与真实模型时不能声称 live 通过。**

## 十二、相关文件

- `public/memory-activity.js` —— 白名单语义投影（无 DOM、无 IO）
- `public/memory-capabilities.js` —— installed/configured/loaded 三值与运行观察
- `public/memory.js` —— SSE 观察入口 + Extensions 页设置区
- `public/tool-view.js` —— 语义适配器分发（`memoryActivity`）
- `tests/memory.cjs` —— 离线契约（233 条）
- [extensions.md](extensions.md) / [architecture.md](architecture.md) /
  [security.md](security.md) / [testing.md](testing.md) /
  [pi-compatibility.md](pi-compatibility.md)
