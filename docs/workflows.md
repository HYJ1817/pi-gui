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
- `filesChanged` 只记**文件名**（很轻）。执行期间的**内容证据**（每个文件的
  bounded patch）是另一份字段 `changeEvidence`，见 §二之二；

`filesChanged` 一律是**项目相对路径 + 正斜杠**（`gitStatus` 给的就是这个形状，
`normalizeFilesChanged` 再挡一道）。绝对路径、`..` 逃逸、非字符串一律剔除。

**采集不到时不猜。** 不是 git 仓库、或者进程被中断时拿不到 after 快照，
这时 `filesChanged` 记 `[]` 并置 `changeCaptureIncomplete: true`，
界面说「采集不到」，**不会**伪装成「没有变化」。

## 二之二、历史内容证据：执行前 → 执行后（P10）

`filesChanged` 只回答「**哪些**文件变了」。它答不了「**变成了什么样**」，而且
它答不了的那个问题会随着工作区继续变动而**越来越答不准**。P10 补的就是这一半。

### 三种 Diff，别混

| 说法 | 说的是什么 | 会不会变 |
|---|---|---|
| `filesChanged` | 这次执行期间**哪些文件**被观察到有变化（一列文件名） | 写完不变 |
| `changeEvidence`（本次 Diff） | 这次执行 **执行前 → 执行后**观察到的工作区变化（每个文件的 bounded patch） | 写完不变 |
| 当前 Diff | 工作区**此刻**相对 Git 基线是什么样 | 随工作区漂移 |

### 基线是「执行前的工作区」，**不是 HEAD**

这是 P10 最核心的一条。两者在 dirty workspace 下完全不同：

```
HEAD               const x = 1;
执行前（用户已改）   const x = 2;
执行后              const x = 3;
```

要的历史 diff 是 `2 → 3`；`git diff HEAD` 给的是 `1 → 3` —— 把**用户在执行开始前
就已经改好**的东西算进了这次尝试。所以采集走的是「把工作区本身写成两棵 tree 再比」，
而不是 `diff HEAD`。

做法：用一个**独立临时 index**（`GIT_INDEX_FILE` 指到系统临时目录里）对工作区
`add -A` 再 `write-tree`，执行前后各一次，然后 `diff <pre> <post>`。
⚠️ **绝不碰用户真实的 `.git/index`** —— 不 add、不 reset、不 checkout、不 commit、
不 stash。临时索引建在**仓库之外**、用完即删。`tests/git.cjs` 的静态守卫盯着这两点。

### 各类型的处理

- **untracked 新文件**：`add -A` 会把它们写进 tree，所以「执行前不存在、执行后出现」
  就是一个 `added`，patch 里带内容。`.gitignore` 里的文件**不进**证据（`add -A`
  尊重 ignore）—— 记的是「这个仓库眼里的工作区」，不是磁盘上的全部文件。
- **deleted**：`change=deleted`，patch 里是被删掉的内容。
- **renamed**：`-M` 让 git 自己识别，认得出就记 `change=renamed` + `oldPath`，
  证据里**只有一条**（不是新旧各一条）。认不出就退化成 `deleted` + `added` —— 准确
  优先于漂亮。
- **binary**：**不把内容塞进计划**。记 `binary: true` + 空 patch，界面说
  「二进制文件已变化，不展示文本 Diff」。判据以 `numstat` 为准（`-` 就是二进制）。
- **非 git 项目**：`status: 'unavailable'` + 说明原因。

### 上限（计划是整份读写的 JSON，不能让它膨胀）

单文件 patch `24 KB`、单次 attempt 合计 `64 KB`、最多 `50` 个文件。
超了就**按顺序留前面几个**并置 `truncated: true`（单文件级与 attempt 级都有标记），
界面显式写「历史 Diff 已截断」。**不悄悄裁掉。**

刻意比「直觉值」小：Scheduler 每次状态变化都整份写盘，一次 attempt 几百 KB
会让一个 24 任务的计划到十几 MB，而它会被**反复重写** —— 那不是存证据，是拖垮运行期。

### 采不到 ≠ 任务失败

证据是附加物，不是任务的前提。git 不可用、超时、树建不出来、非 git 项目 ——
一律 `unavailable` + 写明原因，**任务的 outcome 不受影响**（该成功还是成功）。

同样地，**中断与硬崩不伪造**：执行被中断 / 应用崩溃时没有机会采集结束状态，
就如实记 `unavailable` + 「未完成结束状态采集」，**绝不**在重启后拿「当前工作区」
补一份 post 快照 —— 那时间边界已经错了。

### 归属

`changeEvidence` 由 **Scheduler** 在 attempt 结束时写入并落盘。Verifier、Review API、
`PUT /api/plans/:id` 都**不许覆盖**它（见 §5.7 的字段所有权）。Retry 只新增 attempt，
不动旧的：`Attempt 1 / 2 / 3` 各自的证据互相独立。

更早版本产生的 attempt 没有这个字段 —— 归一化成 `null`，界面如实说「这次执行没有
变更证据（更早版本没有采集）」，**不假装有 Diff**。`schemaVersion` 仍是 1（纯新增字段）。

## 三、界面

### Planner（任务 → 会话）

每条 attempt 一行：状态 → **会话**（标题 + 「打开会话」）→ **执行期间变更**（文件名）
→ **本次 Diff** → 验证要求 / 独立验证 → 人工审阅。

- 变更那一栏有两个**分开**的入口，措辞不混：「查看**当前** Diff」（工作区此刻相对
  基线的差异，每个文件一个）与「查看**本次** Diff」（这次执行前后冻结下来的证据，
  一条）。没有历史证据的 attempt 不给后者，如实说「没有采集到 / 更早版本没有采集」；
- 「本次 Diff」面板顶部写明「这是该 Attempt 执行前后观察到的工作区变化。之后的修改
  不会改变这里的内容。」文件默认**收起**（几十个文件全展开会把几 MB 塞进 DOM），
  另有「全部展开」；

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

### 5.7 四个写者：谁拥有哪些字段

计划是**一个文件装着一堆互不相同的所有权**，所以「谁写谁的字段」必须说清楚：

| 写者 | 拥有 |
|---|---|
| **Scheduler** | 执行状态 / attempt 创建 / `result` / `sessionId` / `filesChanged` / `changeEvidence`（P10）/ `verificationSnapshot` / `workingDirectorySnapshot` / `outcomeStatus` |
| **Review API** | `attempt.review` |
| **Verifier**（P9） | `attempt.verificationResult` |
| **PUT /api/plans/:id** | 计划结构（标题、目标、任务、依赖、verification、concurrency） |

> `verificationSnapshot` 与 `workingDirectorySnapshot` 都在 **attempt 开始时**由
> Scheduler 冻结（前者是「要求验证什么」，后者是「在哪个目录执行」）—— 两个都是
> **执行前就确定的值**，之后改 task 不影响它们。`verificationResult` 才是
> 「后来真的跑了什么」，归 Verifier。

**一个写者保存自己的变化时，不该覆盖一个它不拥有的字段。**

这不是理论洁癖，是一条会**静默丢数据**的路径：

```
计划还在跑
  → 任务 A 先结束，用户审阅了 A（写进磁盘）
  → 任务 B 跑完，Scheduler persist() 整份写盘
  → A 的审阅被内存里那份陈旧副本冲掉      ← 用户看不到任何报错
```

P9 之后同一条路径对验证证据也成立（只是方向反过来）：

```
用户点「运行验证」→ 命令跑完，Verifier 把结果写进磁盘
  → 紧接着 Scheduler 收尾整份写盘（内存里那份没有 verificationResult）
  → 刚拿到的验证证据被冲掉，界面回到「尚未独立确认」
```

三处必须做（都已实现并有回归守卫）：

1. **Scheduler 的 `persist()` 先合并外部字段**：`mergeExternalAttemptState()` 重读磁盘，
   把 `attempt.review` 按「只采纳 revision 更大的那个」合回内存副本，
   再把 `attempt.verificationResult` 按「**磁盘上有就以磁盘为准**」合回来
   （Scheduler 从不写它，所以内存里那份永远只会更旧，不需要比谁更新）。
   ⚠️ 刻意**只合并这两个字段**，不做通用 merge engine —— 通用的那种要么写不对，
   要么把「谁拥有什么」这件事变得不可读。
2. **`PUT /api/plans/:id` 在合并历史前重读**：它进入分支时 load 过一次，但那之后夹着
   一条 `await readBody(...)`；不重读就会用陈旧快照去「保留历史」。
3. **Verifier 保存前重读**：它跑命令要跨好几秒（甚至十分钟）的 await，
   落盘时**必须重新 load 一次**、只改目标 attempt 的 `verificationResult`、再 save ——
   改的是刚读出来的那一份，所以这期间别人（Review API / Scheduler）写进去的东西都在。

四者与 Review API 的 `revision` 检查遵循同一条规矩：**读—改—写不能跨异步边界**。

> `changeEvidence`（P10）归 Scheduler，而且只在 attempt 结束时写一次 —— 所以**不需要**
> 上面那种合并：它没有第二个写者。要守住的是它的**反面**：Review、Verifier、
> `PUT /api/plans/:id` 这三条路径都**不许**把它覆盖掉（带着一份旧任务副本提交时，
> 「保留历史」分支必须把它原样留着）。`tests/evidence.cjs` 的 E 段盯着这四条路径。

### 5.7b 运行期排他：同一时间只有一个「实际执行者」（P9 收口）

字段所有权管的是「谁能写哪个字段」。还有一条**运行期**的规矩：
**同一个 Pi GUI workspace 同一时间只允许一个会实际执行工作区命令的主体。**
验证命令和 coding agent 同时跑，会一起改同一个工作区、抢 `index.lock`、
把测试结果搅成一团 —— 出了问题说不清是谁的。

```
Scheduler 在跑（**任意**计划）  →  任何验证都起不来          → plan-active
验证在跑                        →  起不了计划 / 起不了第二条验证 → verification-active
                                   不能 Retry                → verification-active
                                   不能 PUT / DELETE 计划     → verification-active（409）
                                   不能切项目                 → 闸门给理由
Review 保存 / 清除              →  **不受影响**（见 5.7）
纯读取 + 停止验证               →  **不受影响**
```

两件实现上的事：

1. **两条闸门对称，但方向相反地注入。** Verifier 拿 `scheduler.activePlanId()`
   判「有没有计划在跑」；Scheduler 拿一个注入的 `hasActiveVerification()`
   判「有没有验证在跑」。**谁也不 import 谁**（`server/` 下的模块不互相 import），
   都在 `server.js` 里装配 —— 与 scheduler 拿 `gitStatus` 是同一种做法。
   `verifierRef` / `plannerRef` 用惰性引用解「两个对象互相需要」的顺序问题。
2. **切项目的理由在 planner 里、不在 server.js 里。** `projectSwitchBlockReason()`
   返回拒绝原因或 null；server.js 的 `beforeActivate` 只做一行透传。放那边才**测得到**
   （server.js 一 import 就起服务，测不了），而且规则只有一份。
   前端也有 `workspaceGeneration` 守卫，但那是 **stale UI 防护**，管不了这个 ——
   这里要的是后端生命周期安全。
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

**③ 变更那一栏的两种 Diff。** attempt 上有**两个分开**的入口，措辞不能混：
「查看**当前** Diff」给的是**当前工作区**的差异（复用「文件变更」面板，每个文件一个）；
「查看**本次** Diff」给的是 P10 冻结下来的 `changeEvidence`（一条）。后者**不在打开时
重算** —— 它随 attempt 一起落盘，之后不再变（数据契约见 §二之二）。没有它
（采不到 / 更早版本的 attempt）就**不给按钮**，如实写原因。当前 Diff 那边要处理
这几种如实说明：

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

**第 ① 条（项目换了）要额外做一件事：把这个面板实例的临时状态整体作废** ——
`reviewDrafts`（连带草稿里的 `saving` 标记，不清就会永久停在「正在保存…」）、
`clearingReview`、`filesExpanded`。它们都属于旧 workspace，项目一切就都不该再存在。
然后旧面板被收成「项目已切换，请重新打开 Planner」，里面的审阅控件随之消失，
旧实例不可能再对旧项目发出任何写操作。

⚠️ **收尾刻意不调 `closeModal()`。** modal 只有一个槽位
（`public/ui/modal.js` 的 `closeHook`）且**没有实例 token** ——
从旧实例关掉它会**把用户刚打开的新 Planner 一起关掉**。所以旧实例只清自己的状态、
只往**自己那份** detailWrap 里写提示；若 modal 已被新实例重建，旧节点早已脱离文档，
那些写入是空操作。`renderDetail` / `renderList` / `refreshCurrent` / `reload`
以及审阅的三个入口都受同一条身份（`openedGeneration`）保护。

## 七、接口

| 接口 | 用途 |
|---|---|
| `GET /api/plans/:id` | 计划详情。每个 attempt 附带 `sessionAvailable` / `sessionTitle`（视图字段，**不写回文件**） |
| `GET /api/plans/relations?sessionId=` | 会话 → 任务 的反查。**没有第二份索引**，直接扫当前项目的 plan 文件 |
| `POST /api/plans/:id/tasks/:taskId/open-session?attempt=` | 打开某次尝试的会话。校验计划归属 + 任务非运行中 + 会话可解析 |
| `PUT /api/plans/:id/tasks/:taskId/attempts/:attempt/review` | 写/清除某次尝试的人工审阅（P8-A）。body：`{status, note, expectedRevision}`；冲突返回 **409 + `code:review-conflict`** |
| `POST /api/plans/:id/tasks/:taskId/attempts/:attempt/verify` | **启动**一次独立验证（P9）。跑的是那条 attempt 冻结的 `verificationSnapshot.command`、在它冻结的 `workingDirectorySnapshot` 里；`ok:false` 时带稳定 `code`（`no-command` / `plan-active` / `already-running` / `verification-active` / `invalid-cwd` / `workspace-stale` / `attempt-not-found`） |
| `POST …/attempts/:attempt/verify/stop` | 停止正在跑的那次验证；取消后收成 `interrupted`（不是 `failed`） |

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
