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

## 五、接口

| 接口 | 用途 |
|---|---|
| `GET /api/plans/:id` | 计划详情。每个 attempt 附带 `sessionAvailable` / `sessionTitle`（视图字段，**不写回文件**） |
| `GET /api/plans/relations?sessionId=` | 会话 → 任务 的反查。**没有第二份索引**，直接扫当前项目的 plan 文件 |
| `POST /api/plans/:id/tasks/:taskId/open-session?attempt=` | 打开某次尝试的会话。校验计划归属 + 任务非运行中 + 会话可解析 |

刻意**没有**新增 `/api/workflow/*` / `/api/task-links/*` 这类平行概念 ——
关系是 Planner 数据的一部分，就挂在 Planner 的接口上。

## 六、本轮没做的增强（明确记下，不含糊过去）

规格里列为「增强项、可暂缓」的三条，P7 第一版**都没做**：

- **从 Git Changes 回看任务**（在「文件变更」的每一行旁标「关联任务 2」）。
  需要把每个工作区文件反查到 task，成本明显大于它带来的价值。
- **搜索结果里显示任务标签**（「Task · 修复后端」）。
- **侧栏会话标题下显示「Plan · 修复 SSE」**。侧栏本来就窄，
  而且会话标题已经要跟时间戳抢位置 —— 优先保住了两条跳转本身。

## 七、刻意不做

看板、拖拽排序、标签、优先级矩阵、截止日期、评论、成员、云同步、通知中心、
Git commit 自动归属、AI 自动总结会话、embedding / RAG / SQLite、新的 Agent runtime。

这是开发工具，不是 Jira。
