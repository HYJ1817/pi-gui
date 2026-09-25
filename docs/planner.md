# Planner / 多 Agent 编排

侧栏的**任务**是 Pi GUI 自己的编排层：写一个较大的目标 → 拆成带依赖的任务 →
指定执行 Agent → 按依赖串行跑 → 状态实时进面板。

## 一、先说清楚：这不是 pi 的能力

**pi 没有原生 sub-agent，也没有 plan mode。** `docs/usage.md` 把它和
「没有内置 MCP」并列写明是**有意不做**的东西。

所以这一层是 Pi GUI 在 pi 之上做的编排。界面和文档里都不会写成「pi 的多 Agent」
—— 那是冒领别人的能力。

## 二、Planner 和 Executor 是两个按钮

```
写目标 → [生成计划] → 看到任务列表 → 可以改 → [开始执行]
```

**不存在「一生成就自动开跑」这条路。** 生成之后你可以在运行前改标题、改描述、
换 Agent、调依赖、删任务、加任务。运行中结构会锁定（只允许停止 / 重试 / 跳过），
因为执行中途改依赖图会让调度器复杂度立刻失控。

即使 AI Planner 完全不可用，**手工新建空计划 + 自己加任务**这条路照样能跑 ——
这本身就是「Planner ≠ Executor」的证明。

代码上这两块也是分开的：`server/planner/index.js`（生成/编辑计划）与
`scheduler.js`（只执行已确认的计划）。

## 三、Agent

每个任务指定一个 Agent，必须来自内置 registry（`server/agents/`）——
**那是唯一认识各 CLI 的地方**，Planner 不直接 spawn 任何东西。

| Agent | 非交互调用方式 | 流式 | 可取消 | 可续会话 | 工具级事件 |
|---|---|---|---|---|---|
| `pi` | `--print --mode json --approve` + 独立 `--session-dir` | ✅ | ✅ | ✅ | ✅ |
| `codex` | `exec --json` | ✅ | ✅ | ✅ | ✅（item 级） |
| `gemini` | `-p --approval-mode auto_edit` | ✅ | ✅ | ✅ | ❌ 只有文本 |
| `claude` | `-p --output-format stream-json` | ✅ | ✅ | ❌ | ✅ |
| `opencode` | **未适配调用方式** | — | — | — | — |

**可用性在运行时探测**，不写死在文档里：本机有没有装、装得完不完整
（「装了但入口文件缺失」和「压根没装」是两种不同的原因），界面上会给出
可核对的原因。所以这里不记录某台机器的状态。

几条实现约束：

- npm 装的是 `.cmd` shim，**不能直接 spawn**。适配器会解析出包里真正的入口 ——
  `.js` 用 `process.execPath` 跑，`.exe` 直接跑。
- **`stdin` 必须关**（`stdio: ['ignore', …]`）。不给 stdin 又让它空着，
  pi 会永久挂起。
- **判定成败不能只看退出码**：实测 pi 在模型报 402 时**仍然 exit 0**，
  失败只体现在事件里（`message_end.message.stopReason === "error"` +
  `errorMessage`）。只看退出码会把每次失败都报成成功。
- **进程树 kill**：Windows 上 `child.kill()` 只结束直接子进程，agent 拉起的
  `npm test` 会活下来继续改工作区。用 `taskkill /pid <pid> /T /F`。
- **pi 的 `--session-dir` 真的能隔离**：会话文件落在指定目录，
  `~/.pi/agent/sessions/` 无新增。这点很重要 —— 主聊天用 `--continue` 取该 cwd
  下最近的会话，混进去会让用户下次聊天接上某个任务的上下文。

### `auto` 的规则

**优先 pi，否则按注册顺序取第一个可用的。**
不做评分、不做黑箱排序 —— 你要能自己算出来它会选谁。

### 不可用的 Agent 在开始之前就被拦下

并列出是哪个任务、为什么不可用，然后你可以换成别的。
不会启动到一半才报 command not found。

## 四、依赖是真正的 DAG

```json
[
  { "id": "inspect",  "agent": "pi",    "dependsOn": [] },
  { "id": "backend",  "agent": "codex", "dependsOn": ["inspect"] },
  { "id": "frontend", "agent": "claude","dependsOn": ["inspect"] },
  { "id": "verify",   "agent": "pi",    "dependsOn": ["backend", "frontend"] }
]
```

执行前会校验：id 唯一、依赖存在、没有自依赖、**没有环**（报出环路径）、
至少有一个入口任务、agent 存在、工作目录在项目内。
**任何一条不过就不许执行** —— Planner 的输出一律视为不可信输入。

## 五、默认串行

`dependsOn` 全 success → 就绪；任一依赖 failed / cancelled / skipped → **阻塞**。
默认并发是 **1**（可配到 2，不能再高）。

为什么第一版串行：多个 coding agent 同时改同一个工作区会互相覆盖文件、
把 git diff 混成一团、跑测试互相干扰、抢 `index.lock`，出了问题还说不清是谁改的。
DAG 结构上支持并行，但默认不用。

**同一时间只允许一个计划在跑**，而且**计划运行期间不能切换项目** ——
否则「某个任务的输出属于哪个项目」就得靠猜。要切就先停计划。
（这条闸门在 `server/projects.js` 的 `beforeActivate` 里。）

## 六、失败 / 停止 / 重试

- **失败就暂停整个计划**，不自动跳过、不自动重试、不把失败当成功往下跑。
  界面给你三个选择：重试 / 跳过 / 停止。
- **跳过不会自动放行依赖者** —— 依赖它的任务仍然「被阻塞」，要跑就得先改依赖。
- **重试是 `attempt++`，历史 attempt 全部保留**，失败证据不会被覆盖。
- **取消不是失败**：`cancelled` 用灰色，`failed` 才用红色。你自己按的停止，
  标红会让你以为出错了，然后去重试一个刚放弃的任务。
- ⚠️ **失败暂停前要再 `refreshStatuses` 一次**，否则下游任务停在 `pending`
  而不是 `blocked` —— UI 上「等待」和「被阻塞」是两件不同的事。

## 七、每个任务都能看到

Agent、状态、耗时、退出码、结果摘要、attempt 历史、
**执行期间观察到的工作区变化**。

最后一条的措辞是刻意的：**不写「Agent 修改了这些文件」**。
用户自己、编辑器、其它工具都可能在同一时间段改文件，
把 git diff 全记在 Agent 头上是在编造因果。

## 八、崩溃恢复

计划存在 **`<PI_GUI_DATA>/plans/`**：

- **不在项目仓库里** —— 执行历史属于本地运行状态，写进仓库会弄脏你的 working tree
- **也不放进 `.pi-gui/config.json`** —— 那是「项目偏好」，计划是「执行实例」，
  两者生命周期完全不同

只在状态真的变了的时候写盘（任务状态变化 / attempt 起止 / 计划状态变化），
不按 token 写；写盘是临时文件 + rename 的原子写。

App 重开时如果看到某个任务还是 `running`，**不会假装它还在跑** ——
原进程已经不存在了，它会恢复成 `interrupted` 并允许重试。

> ⚠️ **崩溃恢复只在进程启动时做**（`store.recoverAll()`）。曾经写成「每次 load
> 都恢复」，结果前端一轮询详情就把**正在跑**的任务翻成 interrupted ——
> 光看文件分不出「上个进程死了」和「本进程正在跑」。

## 九、边界

- **不自动创建 git commit / push / reset / clean**。Agent 可以改工作区，
  但提交由你决定。
- `verification` 字段只保存描述，**由 Agent 执行**，Pi GUI 不自己 shell 执行它 ——
  「谁执行」这件事必须只有一个答案。
- 所有 Agent 都经过适配器调用：**`shell:false` + 参数数组**，没有一处拼接
  命令字符串。Agent 的 stdout 是不可信文本，前端渲染路径一次 `innerHTML`
  都不用（见 [security.md](security.md)）。
- 不提供「客户端传任意可执行文件」或「把 shell 命令当 agent」的入口。

## 十、当前限制

- 只在**一个工作区串行**跑，没有并行、没有跨机器、没有云端队列。
- Agent 之间不会互相通信，也不会递归创建任务。
- `claude` 的调用方式按**官方 CLI 文档**实现，**尚未在真实 CLI 上端到端验证过**；
  首次真跑时可能需要微调一两个 flag。
- `opencode` **只做探测、没有写调用参数** —— 缺可核对的 CLI 样本，
  照印象写参数比报「不可用」更危险（错参数会以「跑起来但结果不对」的形式出现）。
- `gemini` 没有 JSON 事件流，Timeline 只能显示 stdout 文本摘要
  （**不伪造工具事件**）。

## 十一、相关测试

`npm run test:planner`（115 条）：Plan / Task 模型、DAG 校验（id 唯一 / 依赖存在 /
无自依赖 / 无环 / 有入口 / 未知 agent / cwd 逃逸）、Scheduler 状态机（依赖解锁 /
失败暂停 / 取消≠失败 / 重试 attempt++ / 单活跃 / 崩溃恢复）、Agent registry 探测、
进程层（真子进程打 ENOENT / 超时 / 取消 / 进程树 kill / stdout 截断 /
args 不被 shell 解释）、持久化与隔离、SSE 事件字段，外加 fake-agent 的完整
Scheduler E2E。全程 `os.tmpdir()`，不联网、不消耗模型额度。

> Agent 探测那几条是**用 fixture 驱动**的（造一个假的全局 npm 目录，
> 把 `env.APPDATA` 指过去），不依赖「跑测试这台机器装了什么」。
