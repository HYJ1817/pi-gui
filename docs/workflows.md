# 项目级任务工作流（任务 ↔ 会话 / 任务 ↔ 文件）

一个开发目标从「生成计划 → 执行任务 → 产生会话 → 修改文件 → 验证结果」串成一条
**可追踪**的线。这一篇讲的就是那条线上的三段关系是怎么存的、怎么查的、以及**没做什么**。

**这不是新的 Agent 框架。** 它是在现有 Planner 之上补关系，没有引入任何平行的
`WorkflowEngine` / `JobEngine`。数据模型也没有新建一层 —— 计划本身就是项目级工作项：

```
Project
  └─ Plan            ← 就是 Planner 里那个 Plan，没有另造 WorkItem
       ├─ Tasks
       │    └─ Attempts   ← 每次尝试各自带 sessionId / filesChanged
       ├─ Sessions        ← 从 attempt.sessionId 反查，不另存一份索引
       └─ Files changed   ← 从 attempt.filesChanged 汇总
```

## 一、三段关系

| 关系 | 存在哪 | 谁写 | 谁读 |
|---|---|---|---|
| Task/Attempt → 会话 | `plan.tasks[].attempts[].sessionId` | Scheduler | Planner UI、`/api/plans/relations` |
| Task/Attempt → 文件 | `plan.tasks[].attempts[].filesChanged` | Scheduler（前后快照差集） | Planner UI |
| 会话 → Task | **不存**，运行时反查 | —— | `/api/plans/relations?sessionId=` |

### 1. 会话 id：只存稳定 id，绝不存路径

`sessionId` 是 pi 的会话 id（形如 `pi-gui-plan-xxx-t1-a1`，或 claude 自己报的 UUID），
**不是** `C:\...\xxx.jsonl`。理由有两条，都很实际：

- **路径会失效。** 项目被搬走、会话被归档、用户改了目录名，路径就指向不存在的东西；
  而 id 跟着会话走。
- **路径不该出现在元数据里。** Planner 的元数据可能被贴进 issue（见
  [diagnostics.md](diagnostics.md) 的同一条思路）。所以 `lib/session-id.js` 里的
  字符集（`[A-Za-z0-9._-]`）天然排除了 `/`、`\`、`:` —— 「不接受路径」是它的副产品。

这个字符集**不是我们自己定的**，是从 pi 抄的（`assertValidSessionId`）。必须遵守的原因是：
pi 的 `validateSessionIdFlags` 在 `--session-id` 非法时**直接 `process.exit(1)`** ——
传一个带非法字符的 id 会让任务在启动阶段就死掉，而报错看起来跟会话毫无关系。
所以 id 在**拼接时**就要保证合法（`model.js` 的 `taskSessionId`），不是等到传给 pi 才检查。

### 2. 会话 id 是**执行前**就确定的

`taskSessionId(planId, taskId, attempt)` → `pi-gui-<planId>-<taskId>-a<attempt>`。

两个刻意的决定：

- **确定性**：不依赖解析 Agent 的输出。执行前就知道这次尝试会用哪个会话。
- **attempt 进 id**：每次重试拿到**不同**的会话。否则重试会续进上一次那个会话，
  Attempt 1 / Attempt 2 的关系就分不开了（见下面「重试」一节）。

但**记下来的是事实、不是期望**：适配器能报回真实 id 时以它为准
（pi 的 `--mode json` 第一行就是 `{"type":"session","id":…}`）。pi 没收到
`--session-id` 时会自己生成一个，那种情况下只有观察值是对的。

### 3. 能力驱动，不写 `if (agent === 'codex')`

适配器自报 `capabilities.sessionLinking`：

| Agent | sessionLinking | 说明 |
|---|---|---|
| `pi` | ✅ | `--session-id` 会直接成为新会话的 id；也能从 `session` 事件回读 |
| `claude` | ✅ | 只**能报回来**（事件里的 `session_id`），我们并不能指定一个 id 给它 |
| `gemini` | ❌ | 文档里有 `--session-id`，但本机无法验证它是否生效 —— 按「不伪造」处理 |
| `codex` | ❌ | 我们的调用方式是「一次执行」，没有会话概念 |
| `opencode` | ❌ | 尚未适配调用方式 |

不支持的适配器：`sessionId` 记 `null`，界面显示「无可关联会话」。
**不伪造一个 id 出来** —— 一个假的关联比没有关联更糟，因为它会把人引到错误的会话上。

## 二、文件变化：语义是「执行期间」

每个 task 执行前后各取一次 Git 工作区快照，差集就是**执行期间观察到有变化的文件**。

⚠️ **这不是「这个 Agent 改了什么」。** 用户可能同时在编辑、watcher 可能写文件、
另一个并行 task 也可能在跑。所以：

- 界面用词是「**执行期间变更**」，不是「该 Agent 修改」；
- 两个并行 task 同时运行，**同一个文件可以同时出现在两边的列表里** —— 这是允许的，
  也是正确的（两边的「执行期间」确实重叠了）。串行的 task 则不会互相包含；
- 完整 diff **不复制进元数据**（它马上就会过期，而且体积大）。元数据里只有文件名，
  diff 仍然走「文件变更」面板。

`filesChanged` 一律是**项目相对路径 + 正斜杠**（`gitStatus` 给的就是这个形状，
`normalizeFilesChanged` 再挡一道）。绝对路径、`..` 逃逸、非字符串一律剔除。

**采集不到时不猜。** 不是 git 仓库、或者进程被中断时拿不到 after 快照，
这时 `filesChanged` 记 `[]` 并置 `changeCaptureIncomplete: true`，
界面说「采集不到」，**不会**伪装成「没有变化」。

## 三、界面

### Planner（任务 → 会话）

每条 attempt 一行：状态 → **会话**（标题 + 「打开会话」）→ **执行期间变更**（文件名）。

- 会话标题由后端在计划详情里一次注解好（`planView`），前端不做 N+1 查询；
- 三种「没有会话」分开说：`无可关联会话` / `关联会话已删除` / 有会话；
- **点「打开会话」的切换动作全在后端**：前端只发 `planId/taskId/attempt`，
  后端解析真实路径、核对归属、然后复用现有的 `switch_session`。
  前端这一侧只负责切完之后走 `afterSessionSwitch()` 收尾（清对话区、重建历史、
  重画会话列表）—— 和侧栏点会话走的是同一条路。

Plan 详情顶部有汇总：`关联会话 N`（去重）、`执行期间涉及 M 个文件`（去重）。
两个都能展开，会话那栏每一行都能直接打开。

### 会话头部（会话 → 任务）

会话标题旁一条窄条：`关联任务 · 计划名 · 任务名 · [查看任务]`。

- **没有关联就整块不显示**（默认 `hidden`）—— 绝大多数会话不属于任何任务，
  常驻一行「无关联任务」是噪声；
- 多条时显示 `关联 N 个任务` + 展开；
- 点「查看任务」直接打开 Planner 并**滚到那个任务**（高亮），不新开一层弹层；
- 窄窗口（< 1100px）直接隐藏：正文才是主体。

## 四、几件必须说清的事

### 打开一个**正在执行**的任务的会话会被拒绝

那条会话文件此刻正被 Agent 进程追加写。主聊天的 pi 一旦切过去，就是**两个进程写同一个
jsonl**，会把它写坏。所以后端硬拦，并说明原因 —— 比让用户点开一个正在被写的文件、
过一会儿发现历史错乱要好得多。

### 重试不覆盖历史

每次 attempt 各自带自己的 `sessionId` 与 `filesChanged`，**追加**不覆盖。

这里顺带修掉了一个 P7 之前就存在的缺陷：`filesChanged` 原先只存在
`task.result.changes` 上，而 `retryTask()` 会 `task.result = null` ——
**重试一次就把上一次的文件变化证据抹掉了**。

### 项目隔离

- 计划按 `projectRoot` 隔离（既有规则）；
- 「从任务打开会话」额外核对**会话确实属于当前项目**；
- 反查 `sessionId` 时也只在当前项目的计划里找。

任务的工作目录可以是子目录（`workingDirectory: 'src'`），那种会话的 `header.cwd`
是 `<项目>/src`，所以这条解析路径的归属判定是「**在项目内**」而不是「完全相等」。
它**只作用于这一条路径** —— 侧栏会话列表用的仍是原有的严格规则。

### 删除 / 归档语义

- **删计划**：只删 Planner 自己的数据，不动会话、不动文件。会话头部的关联随之消失。
- **删/归档会话**：**不改 task 历史**。任务仍然记着那个 `sessionId`，
  界面显示「关联会话已删除」。会话正文归会话系统管，Planner 只保存关系。
- 归档的会话照常能打开（归档只是 Pi GUI 列表里的组织动作，文件原地不动）。

### 元数据里不存什么

可以存：`sessionId`、项目相对文件路径、`agent`、时间戳、状态。
**不存**：prompt 全文、模型输出、工具输出、API key、绝对 cwd、会话文件绝对路径、环境变量。

⚠️ **一条既存偏差，如实记下**：`task.result.summary` / `attempts[].summary` /
`plan.source` 在 P7 **之前**就已经在持久化模型文本（各自有长度上限，界面依赖它们显示
「这个任务做了什么」）。P7 **没有新增**任何模型正文 —— 新增字段只有 id / 相对路径 /
时间戳 / 状态。要不要把既存那几处也收掉，是一个独立的决定，不该混在 P7 里偷偷改。

## 五、人工审阅的数据契约（P8-A）

> P8-A 只做**后端数据契约**：没有界面、没有按钮、没有汇总 UI（那些在 P8-C）。
> 这一节记的是字段与规则，界面部分等做出来再补。

### 5.1 一条不能破的语义

```
执行状态  ≠  人工审阅状态
```

| | 谁写 | 取值 | 回答的问题 |
|---|---|---|---|
| **执行状态** | Scheduler | `success` / `failed` / `cancelled` / `interrupted` | 机器跑出来什么 |
| **人工审阅** | 人 | `pending` / `accepted` / `needs_changes` | 我认不认这个结果 |

两者同时存在、各答一个问题：

```
execution = success  +  review = needs_changes   ← 合法（跑通了，但我不满意）
execution = failed   +  review = accepted        ← **必须拒绝**
```

**审阅永远不改执行状态。** 保存 `needs_changes` 不会触发重试、不会暂停计划、
不动 DAG、不改 `task.status`、不调 Agent、不碰 Git。

审阅状态只有三个，刻意不含 `approved` / `rejected` / `done` / `verified` ——
语义一扩散，界面就没法用一句话说清「现在是什么状态」。

### 5.2 审阅属于**某一次尝试**，不属于任务

```
Plan
└─ Task
   └─ Attempt        ← review 挂在这里
```

`planId + taskId + attempt` 唯一定位。**不新增** `task.review` / `plan.review` /
`reviews.json` / 任何索引文件 —— 一份数据只有一个位置。

为什么必须挂在 attempt 上：重试之后「第一次的结果我接受了」和「第二次的结果还要改」
是两个独立判断。放在 task 顶层，重试一次就把它冲掉了。

### 5.3 字段

```json
{
  "attempt": 2,
  "success": true,
  "outcomeStatus": "success",          // P8-A：稳定执行结论
  "verificationSnapshot": { "command": "npm test" },
  "review": {
    "status": "accepted",
    "note": "测试已人工确认",
    "reviewedAt": 1234567890,
    "revision": 1
  }
}
```

- **`outcomeStatus`**：`success` / `failed` / `cancelled` / `interrupted`，认不出的值记 `null`。
  为什么要它：`success: false` 分不出「失败」「被取消」「被中断」，而**从 `error` 文案里
  猜**（`error.includes('取消')`）是把业务语义建在给人看的字符串上，改一次文案就静默失效。
  老 attempt 没有这个字段时退到 `success` 布尔 —— 它足以回答「成功还是不是」，
  而另外三种的审阅资格完全相同（都不可接受），所以不需要区分就能正确判定。
- **`verificationSnapshot`**：这次尝试**开始时**任务要求的 verification 是什么。
  只保留 `command` / `description` 两个键，**绝不**把 `task.description`、完整 prompt、
  `plan.goal`、模型输出、cwd、model/provider、env 一起复制进来。
- **`review`**：永远存在（归一化后）。`note` 上限 **1000 字**，由后端校验；
  `reviewedAt` 由**后端**生成（不信客户端传的时间）；`revision` 从 0 开始。

### 5.4 `pending` 就是「清除」

用**同一个接口**把状态写回 `pending`，不新增 `DELETE /review`：
`reviewedAt` 清成 `null`、`note` 清空，`revision` 继续递增（不归零）。

### 5.5 资格

| 这次尝试的结论 | `accepted` | `needs_changes` | `pending` |
|---|---|---|---|
| `success` | ✅ | ✅ | ✅ |
| `failed` | ❌ | ✅ | ✅ |
| `cancelled` | ❌ | ✅ | ✅ |
| `interrupted` | ❌ | ✅ | ✅ |
| 还在跑 | ❌ | ❌ | ❌ |

判定**只看这条 attempt 自己的历史结论**，不看 task 当前状态 ——
「Attempt 1 failed、Attempt 2 success」时 task 是 success，但这不能推出
「Attempt 1 可以接受」。判定逻辑是 `model.js` 里的纯函数，route 只调用不判断。

### 5.6 `revision`：防止两个窗口互相覆盖

每次成功写入 +1（改状态、只改说明、改回 pending 都算）。

```
窗口 A 读到 revision = 2
窗口 B 读到 revision = 2
B 保存 needs_changes  → 磁盘变成 3
A 还拿着 2，保存 accepted → **409 review-conflict**（不是 last-write-wins）
```

冲突响应带 `currentRevision`，界面据此提示重新加载。**不自动合并说明** ——
两条人工判断没有「合并」这回事，猜一个结果等于替用户做决定。

⚠️ 这里有一条**容易写错**的实现要求：`读 → 校验 → 写` 必须在**同一个同步块**里完成。
请求路径上只要夹着一个 `await`（比如 `await readBody(...)`），两个并发请求就会
都拿着同一个旧 revision 通过检查，后写的把先写的无声覆盖。所以保存前会**重新读一次**
计划，而且从重读到 `store.save()` 之间没有任何 await。

### 5.7 三个写者：谁拥有哪些字段

计划是**一个文件装着一堆互不相同的所有权**，所以「谁写谁的字段」必须说清楚：

| 写者 | 拥有 |
|---|---|
| **Scheduler** | 执行状态 / attempt 创建 / `result` / `sessionId` / `filesChanged` / `verificationSnapshot` / `outcomeStatus` |
| **Review API** | `attempt.review` |
| **PUT /api/plans/:id** | 计划结构（标题、目标、任务、依赖、verification、concurrency） |

**一个写者保存自己的变化时，不该覆盖一个它不拥有的字段。**

这不是理论洁癖，是一条会**静默丢数据**的路径：

```
计划还在跑
  → 任务 A 先结束，用户审阅了 A（写进磁盘）
  → 任务 B 跑完，Scheduler persist() 整份写盘
  → A 的审阅被内存里那份陈旧副本冲掉      ← 用户看不到任何报错
```

两处必须做（都已实现并有回归守卫）：

1. **Scheduler 的 `persist()` 先合并外部字段**：`mergeExternalAttemptState()` 重读磁盘，
   把 `attempt.review` 按「只采纳 revision 更大的那个」合回内存副本，再落盘。
   ⚠️ 刻意**只合并这一个字段**，不做通用 merge engine —— 通用的那种要么写不对，
   要么把「谁拥有什么」这件事变得不可读。
2. **`PUT /api/plans/:id` 在合并历史前重读**：它进入分支时 load 过一次，但那之后夹着
   一条 `await readBody(...)`；不重读就会用陈旧快照去「保留历史」。

两者与 Review API 的 `revision` 检查遵循同一条规矩：**读—改—写不能跨异步边界**。
只要中间有一个 `await`，两个写者就能都通过检查、后写的无声覆盖先写的。

### 5.8 老数据

P8-A 的字段全是 additive：老 attempt 缺 `review` → 归一化成
`{status:'pending', note:'', reviewedAt:null, revision:0}`；缺 `verificationSnapshot` → `null`；
缺 `outcomeStatus` → `null`。

`PLAN_SCHEMA_VERSION` **仍然是 1**。理由和 P7 那次一样：bump 会给每一个既存计划
挂一条「格式版本是 1，当前支持 2」的提示，而那句提示是假的（v1 文件完全可读）。
只有「旧 reader 会错误解释新结构」时才需要 bump，这次不是。

## 六、重试与历史（P8-B）

> **Retry = 新的 Attempt，不是重写历史。** 这是整条工作流里最容易写错的一步。

允许重试的状态：`success` / `failed` / `cancelled` / `interrupted` / `skipped`。
`running` 拒绝（先停止），`pending` / `ready` / `blocked` 拒绝（还没有可重试的结果）。

### 计划还在跑的时候（运行期所有权）

计划执行期间，同一个 Plan 在内存里有**两份对象图**：

```
active.plan        Scheduler 持有的执行态 —— pump / runTask / finishTask 改的是它
HTTP 请求里 load 的  每次请求 store.load() 出来的新副本
```

于是运行期允许的生命周期操作（`cancel` / `skip` / `stop`）**必须作用于 `active.plan`**，
而不是外部重新 load 出来的副本。改副本只会把副本写进磁盘，Scheduler 收尾时
`persist(active.plan)` 会把整个文件**再盖一遍** —— 改动无声消失，界面一刷新任务又
变回 `pending`；更糟的是 pump 看到内存里它还是 `pending`，会**真的把它启动**。

**`retry` 是例外，不能照抄这一条。** 它会把任务改回 `pending`，而 pump 的下一轮
立刻把它标成 `ready` 并**自动执行** —— 「Retry 不自动执行」就不成立了。所以：

| 操作 | 计划仍 active 时 |
|---|---|
| `cancel` / `skip` | **作用于 `active.plan`**（唯一判定处：Scheduler 的 `planForMutation`） |
| `retry` | **拒绝**，`code: 'plan-active'` —— 等计划结束，或先停止整个计划 |

这就是「计划里谁拥有哪一部分」在**运行期**的延伸，和 5.7 那条（`attempt.review`
只归 Review API，Scheduler 不许覆盖更高 revision 的 Review）是同一条规矩的两面：

```
运行期执行态    →  active.plan
attempt.review  →  Review API
Retry           →  只允许计划不再 active 时
```

⚠️ 判定只在 Scheduler 里做一份，路由**不重复判断** `active` —— 规则有两个来源就
迟早有两个真相。

### 重试动什么、不动什么

| | |
|---|---|
| **只重置当前态** | `task.status` / `result` / `error` / `startedAt` / `endedAt` |
| **一个字节都不动** | `attempts[]` —— 里面的 `outcomeStatus` / `verificationSnapshot` / `sessionId` / `filesChanged` / `review` 全部原样 |

新的 Attempt 要等它**真的开始执行**时才产生，`verificationSnapshot` 也还是那时候冻结。

### 旧 `accepted` 的含义不变

它始终只表示「用户曾接受那次尝试的结果」，**不表示它仍是当前最新结果**。
当前/最新由 Attempt 顺序表达 —— 所以 P8 刻意**没有** `superseded` / `stale` /
`obsolete` 这类状态。新 Attempt 出现不会把旧的 `accepted` 改成别的。

### 下游要重新评估

`A → B` 都成功、计划 completed，用户重试 A：

- B 的**历史 Attempt 与它的 Review 全部保留**；
- B 的**当前状态**回到 `pending` —— 不能再宣称「基于旧 A 的成功结果」，
  因为新的 A 结果可能完全不同；
- `retryTask()` 把被重置的 id 放在返回值的 `invalidated` 里，界面据此刷新；
- **下游正在跑就拒绝重试上游**（不能在飞行中把它的输入抽掉）。

### Plan 状态要回到可执行

终态的计划（completed / failed / cancelled）在重试后回到 `ready`。
不这么做就会出现「Plan completed + Task pending」这种自相矛盾的状态，
而且 `start()` 会直接拒绝。

**重试不会自动执行** —— 用户仍然要自己点开始。

### 重试不碰的东西

不清 Git 工作区（第二次执行面对的是**当前真实工作区**）、不删除旧会话、
不删除旧审阅说明、不改写旧 `outcomeStatus`、不复用旧 `sessionId`。

## 六之二、前端怎么消费这些字段（P8-C）

界面语义的完整说明见 [reviews.md](reviews.md)。这里只记**前端解释规则** ——
即哪些判断是前端做的、边界在哪。

**① 审阅状态。** 前端只认三个值，认不出的当 `pending`（与后端归一化同一套）。
`pending` 就是「清除」，所以它**不带**说明与时间 —— 展示时也强制清空，
不会出现「待审阅却挂着上次说明」这种自相矛盾的画面。

`revision` 是乐观并发的凭据：保存时带**当前渲染那一版**的值（不是写死的 0），
成功后用服务端返回的新 revision 更新本地。

**② 哪个 attempt 允许「接受」。** 前端用与后端 `canAcceptAttempt` **同一条**规则：
看 attempt 自己的稳定结论（`outcomeStatus`，老记录退到 `success` 布尔），
**绝不看 task 的当前状态、也绝不从 `error` 文案猜**。前端挡这一道只是不让人
点了白点一次；即使绕过，后端也会拒绝。

**③ current Diff 的语义。** attempt 里那个入口给的是**当前工作区**的差异
（复用「文件变更」面板，不新做 `reviewDiff` / `historicalDiff`）—— P7/P8 从没
存过历史 diff。所以前端还要处理两种如实说明：

| 情形 | 界面 |
|---|---|
| 文件现在还有未提交差异 | 给「查看当前 Diff」按钮 |
| 文件已 clean | **仍然列出**，说明「当前工作区已无该文件的未提交差异」 |
| git 状态还没加载 / 不是仓库 | 按「未知」处理（给按钮），**不用「没观察到」推断「不存在」** |
| `changeCaptureIncomplete` | 标「未完整采集」，且**不说**「没有文件变化」 |

**④ latest Attempt 汇总。** Plan 顶部两行数字**只看每个任务的最新一次 attempt**
（按 `attempt` 号取最大，不按数组顺序）。只有「最新一次成功」的任务进人工审阅的
分母；失败 / 取消 / 被中断的最新结果不进；没有 attempt 的任务算「尚无结果」。
历史的 `accepted` 仍然留在它自己那张 attempt 卡片里，但**不进这个汇总**。

**⑤ stale response。** 保存是异步的，回来时用户可能已经切了项目 / 切了计划 /
在看别的 attempt。所以每个响应在写 DOM 之前都要过三道身份确认：

```
① 工作区代号没变（S.workspaceGeneration）
② 还是同一个计划（current.id === planId）
③ 目标 attempt 仍在当前计划里（按 taskId + attempt 现查）
```

任一条不成立就**直接丢弃、一个字都不写**。这也是为什么回写用的是
「按 taskId + attempt 现查出来的那一条」，而不是闭包里捕获的节点引用 ——
Attempt 1 的响应在结构上就改不到 Attempt 2 的界面。

## 七、接口

| 接口 | 用途 |
|---|---|
| `GET /api/plans/:id` | 计划详情。每个 attempt 附带 `sessionAvailable` / `sessionTitle`（视图字段，**不写回文件**） |
| `GET /api/plans/relations?sessionId=` | 会话 → 任务 的反查。**没有第二份索引**，直接扫当前项目的 plan 文件 |
| `POST /api/plans/:id/tasks/:taskId/open-session?attempt=` | 打开某次尝试的会话。校验计划归属 + 任务非运行中 + 会话可解析 |
| `PUT /api/plans/:id/tasks/:taskId/attempts/:attempt/review` | 写/清除某次尝试的人工审阅（P8-A）。body：`{status, note, expectedRevision}`；冲突返回 **409 + `code:review-conflict`** |

刻意**没有**新增 `/api/workflow/*` / `/api/task-links/*` 这类平行概念 ——
关系是 Planner 数据的一部分，就挂在 Planner 的接口上。

## 八、本轮没做的增强（明确记下，不含糊过去）

规格里列为「增强项、可暂缓」的三条，P7 第一版**都没做**：

- **从 Git Changes 回看任务**（在「文件变更」的每一行旁标「关联任务 2」）。
  需要把每个工作区文件反查到 task，成本明显大于它带来的价值。
- **搜索结果里显示任务标签**（「Task · 修复后端」）。
- **侧栏会话标题下显示「Plan · 修复 SSE」**。侧栏本来就窄，
  而且会话标题已经要跟时间戳抢位置 —— 优先保住了两条跳转本身。

## 九、刻意不做

看板、拖拽排序、标签、优先级矩阵、截止日期、评论、成员、云同步、通知中心、
Git commit 自动归属、AI 自动总结会话、embedding / RAG / SQLite、新的 Agent runtime。

这是开发工具，不是 Jira。
