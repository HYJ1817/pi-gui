# REPORT D — CLI 清单：工具 / 斜杠命令 / 环境变量

靶子：`claude.exe` 2.1.301（271,840,416 B，sha256 `84d61fee…397`）
取数：`bun --compile` 单文件 → unbuned → `cli/extract/modules/` 2414 个 `*.js`
产物：`cli/extract/INVENTORY.md`（人读）、`cli/extract/inventory.json`（机读）、本报告（方法与结论）
脚本：`cli/tools/inventory.py`

---

## 一、先说上一版为什么失败

`cli/tools/inventory.py` v1 只找到 **1 个 tool、2 个 slash command**，正则是这样写的：

```
name:"Bash"        → 0 命中（命中的只有 highlight.js 给 Bash 语言做定义那处）
userFacingName:()=>"X" → 6 命中（全是 MCP 转发工具）
commandName:"x"    → 2 命中（`git`、`rewind`，还是提示语不是定义）
```

真因不是「压缩得太狠」，而是三个形状假设全错：

1. **工具名不是字面量，是压缩后的标识符。** 真实定义是
   `var Oi=Qt({name:We, searchHint:"execute shell commands", …})`，
   `We` 在**另一个模块**里才等于 `"Bash"`。
2. **所有工具都被一个工厂函数包了一层**（`Qt({ … })`），字段本身不是对象字面量的普通值，
   而是 `get inputSchema(){return W2n()}` / `async prompt({model})=>…` / `userFacingName(e){…}`。
3. **同名标识符全库复用。** `We`、`qt`、`so` 在别的模块里分别是 `Bash`、`Write`、`Glob`，
   但 `qt` 同时还是 `NoConfigHomeError`、`anthropic` 等无关值。全局建索引必须带作用域。

## 二、v2 的四个关键手法

| 手法 | 解决什么 | 实现位置 |
|---|---|---|
| 字符串感知的花括号扫描器 `balanced()` | 对象体里含引号、模板串 `${}`、注释，朴素深度计数会切错 | `inventory.py: skip_string/balanced` |
| 顶层键提取 `top_fields()` | 只取深度 1 的键，避免 `create(){…isReadOnly…}` 里的同名标识符污染 | 同文件 |
| 作用域标识符反解 `resolve()` | 先本文件、再全局；全局候选再用「工具名词表」过滤 | `ident_file` / `ident_global` / `VOCAB` |
| 工具名词表 `VOCAB`（1380 个） | 从 `userFacingName` 返回值、`{name:"X"` 字段、大写名字数组里收集，用于消歧 | 同文件 |
| 展开继承 `spread_parent()` | `Qt({...$e, searchHint:"…"})` 这类基对象继承，名字在 `$e` 里 | 同文件 |

`top_fields()` 顺带修掉一个**逻辑错误**：v1 用 `"isReadOnly(" in body` 判只读，
把 `Bash`、`Grep` 全判成只读（因为它们的 `create()` 实现里出现过这个词）。
v2 改为三态：`None` 未声明 / `"dynamic"` 按输入算的方法 / `true|false` 常量。

## 三、工具清单：82 个

`INVENTORY.md` 有全表（tool / displayName / readOnly / 并发 / 远端 / searchHint / 所属模块）。
几个要点：

### 3.1 核心工具集已整体改名（2.1.301）

| 旧名（历史版本 / 文档） | 2.1.301 实际名 | 证据 |
|---|---|---|
| `Task` | **`Agent`** | 同 searchHint `delegate work to a subagent` |
| `BashOutput` | **`GetTask`** | searchHint `check on a background shell command by task ID` |
| `KillShell` | **`TaskStop`** | searchHint `kill a running background task` |
| `LS` / `MultiEdit` | **不存在** | 全库无定义，已并入 `Glob` / `Edit` |

注意：`WebSearch`（display `Web Search`）**仍然存在**；另有一份 snake_case 登记 `web_search`
（同样 searchHint），属 thin-client 侧的重名注册，不是新旧两代。

其余常见工具名保持不变：`Bash`、`Read`、`Write`、`Edit`、`Glob`（display 叫 `Search`）、
`Grep`（display 也叫 `Search`，与 Glob 重名）、`NotebookEdit`（display `Edit Notebook`）、
`TodoWrite`、`WebFetch`、`ExitPlanMode`、`Skill`、`AskUserQuestion`、`PowerShell`。

### 3.2 新增能力面（历史版本没有的）

- **记忆**：`memory_read` / `memory_write` / `memory_list`（多 store，`store:<id>` 参数）。
- **任务**：`TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskStop` / `GetTask`。
- **计划与目标**：`EnterPlanMode` / `ExitPlanMode` / `ProposeGoal`。
- **worktree**：`EnterWorktree` / `ExitWorktree`。
- **cron**：`CronCreate` / `CronDelete` / `CronList` / `RemoteTrigger` / `ScheduleWakeup`。
- **自托管 runner（9 个）**：`self_hosted_runner_{list_runners,list_secrets,list_sessions,read_health,read_metrics,requeue_session,spawn_local,tail_log,get_pool}`。
- **MCP 运维**：`ListMcpResourcesTool` / `ReadMcpResourceTool` / `ReadMcpResourceDirTool` / `RefreshMcpTools` / `WaitForMcpServers` / `SearchMcpRegistry` / `ListConnectors` / `SuggestConnectors`。
- **跨会话 / 多智能体协作**：`SendMessage`（`send messages to agent teammates`）/ `SendFile` / `SendUserMessage` / `SendUserFile` / `FetchInboxMessage` / `SubagentHandback` / `ListAgents` / `PushNotification` / `ReadNotifications` / `Poll`。
- **`Workflow`**：`orchestrate subagents with deterministic JavaScript workflows`
  —— 子智能体编排已进入工具层（与 `Agent` 并存，一个是自由委派，一个是确定性脚本）。
- **`StructuredOutput`**：`return the final response as structured JSON`，且自带 `endsTurn:!0`。
- **`LSP`**：`code intelligence (definitions, references, symbols, hover…)`。
- **Design 线**：`ClaudeDesign` / `DesignSync` / `AppifactRepl`（在 artifact 上跑 SDK JS）。
- **彩蛋/内部**：`TestingPermission`（`isEnabled(){return!1}`，e2e 测试用）、`ToolSearch`、`ObserverReport`、`Monitor`（watch 进程/日志/WebSocket，逐行推送）。

### 3.3 工具对象的能力字段（决定权限与并发行为）

| 字段 | 取值 | 含义 |
|---|---|---|
| `enablesCodeExecution` | bool | 该工具能执行代码（`Bash`/`PowerShell`/`Monitor`/`Agent` 等） |
| `ruleContentField` | `"command"` \| `"file_path"` | 权限规则里取哪个参数做匹配内容（对应 `Bash(cmd)`、`Edit(path)` 语法） |
| `backgrounding` | `never` \| `self` | 能否转后台；`self` 即「运行中可自行转后台」 |
| `maxResultSizeChars` | `1e4` \| `1e5` \| `1.0`(∞) | 结果截断阈值 |
| `remoteExecution` | `{supported, decidingInputFields, refusedInputFields}` | 云端执行支持面；`decidingInputFields` 决定是否必须上云 |
| `strict` | bool | 入参严格校验 |
| `shouldDefer` | bool | 延迟注入工具定义（省 token 的 tool-search 模式） |
| `persistenceThresholdCeiling` | 常量 | `Bash` 输出落盘阈值 |
| `fromAnotherProcess(e,n)` | 方法 | 跨进程（远端/子进程）回放事件 |
| `get outputSchemaAcrossProcesses` | getter | 跨进程输出 schema |

## 四、斜杠命令：123 条定义 / 99 个不同名字

形状：`{type:"local"|"local-jsx"|"prompt"|"builtin", name:"…", description:"…", argumentHint:"…", …}`。

- `local` = 纯逻辑命令；`local-jsx` = 需要渲染 React 的命令（列表、选择器、卡片）。
- **同名双定义普遍存在**（`/add-dir`、`/advisor`、`/color`、`/effort`、`/autocompact` …），
  一个给终端 UI、一个给 thin/twin 客户端，用 `thinClientDispatch:"post-text"|"twin"` 区分。
- **懒加载**：`load:()=>import("B:/~BUN/root/chunk-*.js")` —— 命令体单独成 chunk，按需加载。
- **特性开关门控**：`availability:["claude-ai"|"console"|"console-profile"]`（只此三值）；
  `get isHidden(){return !on("allow_remote_sessions")||!on("allow_quick_web_setup")}`。
  由此直接读到两个 flag 名：**`allow_remote_sessions`**、**`allow_quick_web_setup`**。
- **宿主能力依赖** `requires:{ink:!0, workspace:!0}`：需要 Ink 渲染器 / 需要工作区上下文才能启用
  （`ink` 出现在绝大多数 `local-jsx` 命令上，`workspace` 只在少数命令上）。
- `immediate`（36 条）：不需回车即生效（如 `local-jsx` 选择器类命令）。
  `runsBesideTurns`（1 条，`/artifacts`）：能与对话回合并行运行。
- `thinClientDispatch` 三值：`post-text` / `twin` / `control-request`——决定这条命令在薄客户端里
  是发文文本、转给孪生端、还是发控制请求。
- 描述里自带版本谱系：`/agents` → 「(removed) Ask Claude to create/manage subagents」、
  `/extra-usage` → 「Renamed to /usage-credits」。
- `argumentHint` 直接给出补全占位符（如 `/add-dir <path>`、`/autocompact [auto|<tokens>]`）。
- `aliases` 已能直接读出：`/background→bg`、`/clear→reset,new`、`/config→settings`、
  `/desktop→app`、`/exit→quit`、`/list-agents→peers`。
- `availability` 门控的 8 条：`autofix-pr`、`desktop`、`install-github-app`、`install-slack-app`、
  `remote-env`、`teleport`、`ultraplan`、`upgrade`。
- `supportsNonInteractive` 标记能否在 `-p` 非交互模式下使用。

## 五、附带清点

| 类别 | 数量 | 样例 |
|---|---|---|
| 环境变量 `process.env.*` | **398** | `CLAUDE_CONFIG_DIR`(20 次)、`DISABLE_COMPACT`(13)、`CLAUDE_CODE_ENTRYPOINT`(10)、`CLAUDE_CODE_OAUTH_TOKEN`(9)、`SELF_HOSTED_RUNNER_HOOKS_DIR`(9)、`ANTHROPIC_BASE_URL`(8) |
| 遥测事件 `tengu_*` | **3059** | `tengu_session_resumed`、`tengu_mcp_degraded`、`tengu_bg_agent_action`、`tengu_auto_mode_fallback_to_ask` |
| Hook 事件 | **10** | `PreToolUse`(122)、`PostToolUse`(71)、`Stop`(64)、`UserPromptSubmit`(48)、`SessionStart`(47)、`SubagentStop`(37)、`PostToolUseFailure`(32)、`SessionEnd`(14)、`Notification`(13)、`PreCompact`(9) |

（`SessionEnd` 与 `PreCompact` 名次靠后但确实存在；早期文档里常漏掉 `PostToolUseFailure`。）

## 六、边界与未闭合

1. **6 个工具没有 `searchHint`**（`ObserverReport`、`ScheduleWakeup`、`TestingPermission`、`ToolSearch`、`WaitForMcpServers`、`mcp`），靠 `displayName` 或改用其他字段识别。
2. **`memory_list` 是手工校正**：它的对象体没有 `name` 字段，仅由 inputSchema 描述
   `"Id of the memory store to list…"` 识别，脚本里以 `OVERRIDES` 显式登记（附注释）。
3. **能力字段三态**：`~` 表示「声明为方法、按输入计算」，不代表只读；不要按 `✓` 当安全结论。
4. **`prompt` 正文未抽取**：工具的 `async prompt(){return <大段模板>}` 才是系统提示词的真正来源，
   本报告只记录字段形状，正文留给下一条线（`0206` / `0259` / `0439` 的 prompt 常量拼接）。
5. **`Glob` 与 `Grep` 的 displayName 都是 `Search`**：UI 上靠 searchHint 区分，不是抽取错误。
6. 命令表里 `get isHidden()` 只会被记为 `available`/`None`，未展开求值。

## 七、复现

```bash
cd C:/claude逆向素材/cli
PYTHONIOENCODING=utf-8 python tools/inventory.py
# → extract/inventory.json  extract/INVENTORY.md
```

依赖：仅 Python 3 标准库；读 `extract/modules/*.js`（由 unbuned 从 `claude.exe` 抽出）。
