# 与 pi 的兼容性

Pi GUI 是 pi 的界面，**不是 pi 的一部分**。这份文档讲清两者的边界、
Pi GUI 依赖 pi 的哪些能力、哪些能力缺失时可以降级、以及 pi 升级后怎么验。

代码在 [`server/pi-compat.js`](../server/pi-compat.js)。

## 一、边界在哪

```
   Pi GUI（本仓库）                     pi（外部程序，本机安装）
   ├─ Electron 窗口                     ├─ 自己管模型供应商与密钥
   ├─ HTTP + SSE 后端                   ├─ 自己的配置文件（~/.pi/agent/）
   ├─ 项目 / 会话列表 / 文件变更          ├─ 自己的会话文件（JSONL）
   ├─ Planner 编排（**自己的**，不是 pi 的）└─ `pi --mode rpc`
   └─ 全部 UI
                    │
                    └─── 唯一的集成边界：**RPC**（stdio 上的 JSONL）
```

- **RPC 是唯一边界。** Pi GUI 通过 `pi --mode rpc` 的子进程 stdio 说话：
  每行一个 JSON 对象；命令写进 stdin，事件与应答从 stdout 出来。
  **没有插件、没有 monkey patch、不 fork pi、不改 pi 的任何文件。**
- **会话文件是第二条（只读的）边界。** 会话列表与搜索要扫
  `<agentDir>/sessions/`，所以会话 JSONL 的形状也算集成面。Pi GUI **只读**它，
  归档 / 删除这些动作只动 Pi GUI 自己的目录。
- **Planner / 多 Agent 不是 pi 的能力。** pi 没有原生 sub-agent、没有 plan mode，
  那是 Pi GUI 自己做的编排层。所以兼容报告里**不会**出现「pi 支持 planner」
  这种说法 —— 它区分的是「Pi GUI 的能力」与「pi 的能力」。

## 二、我们依赖哪些能力

兼容报告里的九个能力，来自代码里**实际用到**的东西（不是照抄一份理想清单）：

| 能力 | 对应什么 | 用在哪儿 |
|---|---|---|
| `rpc` | 能 spawn `pi --mode rpc` 并收发 JSONL | 全部功能的前提 |
| `getState` | `get_state` 应答里有 `sessionFile` | 当前会话指针、模型 / 思考档位显示、归档与删除的「当前会话」判断 |
| `getMessages` | `get_messages` 能返回消息数组 | 历史重建、刷新后恢复对话 |
| `newSession` | `new_session` | 「新对话」 |
| `switchSession` | `switch_session` | 切换会话、搜索结果跳转 |
| `sessionNaming` | `set_session_name`（+ 会话文件里的 `session_info.name`） | 给会话改名 |
| `toolEvents` | `tool_execution_start` / `_update` / `_end` | Tool Timeline |
| `extensionUi` | `extension_ui_request` / `extension_ui_response` | pi 扩展向用户提问时的选择框 |
| `sessionJsonl` | 能认出会话文件（header 里的 `id` / `cwd`） | 会话列表、搜索、归档 / 删除 |

## 三、核心能力 vs 可降级能力

**核心（缺了整个集成就不成立）**：`rpc`、`getState`。
缺任何一个 → 状态判为 `incompatible`。

**其余都可降级**（缺了就局部停用对应功能，聊天照常）：

| 能力缺失 | 降级成什么 |
|---|---|
| `getMessages` | 对话区留一条「无法读取历史消息…」的说明，而不是一片空白 |
| `switchSession` | 侧栏会话行不给点（淡一档 + 悬停说明原因），搜索结果的点击也拦住并提示；**当前会话的聊天不受影响** |
| `sessionNaming` | 藏起改名入口（不做一个按了没反应的按钮） |
| `toolEvents` | Tool Timeline 缺 `tool_execution_end` 的条目显示成「未完成」（虚线圆），**不会一直停在「运行中」** |
| `extensionUi` | pi 扩展的提问框不出现；对话本身不受影响 |
| `sessionJsonl` | 会话列表 / 搜索降级（列不出来），当前会话的 RPC 不受影响 |

> `toolEvents` 的降级不是靠兼容层「判死」，而是**结构性**的：pi 崩溃 / 中断时
> 本来就可能收不到 `tool_execution_end`，所以 `agent_settled` 一收尾，
> 还挂着的条目就会被收成「未完成」。见
> [architecture.md](architecture.md#六前端渲染管线)。

## 四、怎么判断兼容 —— 版本号只是证据

**不要**用版本号判兼容：

```js
// ✗ 错的
if (semverGte(piVersion, '0.90')) compatible = true;
```

理由：

- 同一个版本号可能有不同的构建差异（打包方式、可选的编译特性）；
- 新版本通常仍兼容旧协议；
- **fork / 自定义实现**可能版本号完全不同，却完全兼容 RPC。

所以判定依据只有两条：**实际观察到的 response 形状** + **实际观察到的事件**。

### 三值能力：未验证 ≠ 不支持

每个能力有三种状态：

| 值 | 含义 | 怎么来的 |
|---|---|---|
| `true` | 观察到能用 | 收到了成功的 `get_state` 应答 / 见到了已知事件 / 会话文件解析成功 |
| `false` | **观察到不能用** | pi 明确回 `success:false`；或 spawn 失败 / 从未 ready 就退出 |
| `null` | 还没观察到 | 还没用到那个能力 |

⚠️ **「没观察到」绝不当成「不存在」。** 一个会话里没有 `session_info` 只说明那次
没改过名，不代表 pi 不支持改名 —— 所以文件侧的观察**只能把能力置 `true`**，
`false` 只由明确的失败产生。

这也是验收里那条对称要求的落点：**读不到 pi 版本号 ≠ 不兼容**。
版本读不到只是 `versionKnown: false`，状态照旧按能力判。

### 状态怎么派生

```
incompatible —— 某个核心能力被证实不可用（rpc / getState）
partial      —— 有非核心能力被证实不可用（局部降级）
compatible   —— 至少一个核心能力已证实可用，且没有已知缺失
unknown      —— 还没观察到足够证据（例如还没启动过 pi）
```

## 五、没有 handshake 协议（故意的）

pi 的 RPC 没有版本协商。**不为它造一个协议** —— 兼容证据全部来自现有链路里
本来就会发生的事：

- **收到 pi 的合法消息** → `rpc` = true（那才证明通道真的通了）
- spawn 报错 → `rpc` = false；**起来之后一句话没说就退出** → 也是 false

> ⚠️ `bridge_status: ready` **本身不算证据**。Windows 上 pi 是经 shell 启动的，
> 而 cmd.exe 对**不存在的命令「启动是成功的」** —— 会先报「不是内部或外部命令」
> 再退出，`ready` 照发。只看 ready 会把这种情况判成「兼容」，
> 所以判据是「说过话」。
- 启动时会问 `get_state`、`get_messages`（前端 boot + 会话列表）→ 顺带收集
- 列会话时扫会话文件 → 顺带收集 `sessionJsonl` / `sessionNaming` 的形状证据
- pi 有任何事件上来 → 顺带收集 `toolEvents` / `extensionUi`

所以兼容层是**被动累积**的，它**自己不发任何请求**：不产生模型调用、
不花额度、不改 session、不增加启动延迟。全部证据来自本机，**不联网**
（不查 npm registry / GitHub / 官网）。

## 六、异常记录（有上限、不含 payload）

探测到协议异常时记一条结构化记录，环形缓冲**最多 20 条**，**只记结构**：

```json
{ "at": 1758800000000, "category": "response", "operation": "get_state",
  "issue": "missing-field", "field": "sessionFile" }
```

**禁止**记录原始 payload。这条是硬规矩：诊断报告可能被贴进 issue，
用户正文、prompt、模型回复、密钥一个字节都不能进去。所以：

- 对象 → 只记**键名**（截断、过滤非法字符）
- 数组 → 只记长度
- 其余 → 只记 `typeof`

异常类别：

| category | 什么情况 |
|---|---|
| `envelope` | 半条 JSONL / 不是对象 / 没有 `type` / 应答没有 `command` |
| `response` | 命令被拒（`command-failed`）/ 应答缺了我们依赖的字段（`missing-field`） |
| `event` | **未知事件**（见下） |
| `session-file` | header 认不出来 / 消息体只在顶层 / 坏行 |
| `bridge` | spawn 失败 / 从未 ready 就退出 / ready 之后意外退出 |

## 七、未知字段 / 未知事件的策略

**未知字段 → 忽略，不算异常。** pi 给应答加字段是兼容的加法，Pi GUI 只取自己
要的那几个。测试 fixture E 覆盖这一条。

**未知事件 → 安全忽略，但留一条可见记录。**
前端的事件分发是 `switch (evt.type)` + `default: return` —— 不抛、不重置 bridge、
不清当前会话、不影响 SSE 连接。同时兼容层会记一条 `unknown-event`
（带上事件名），于是 **pi 哪天加了新事件，Diagnostics 里看得见**，
而不是「静默地什么都没发生」。

两者都有专门的回归守卫（`tests/smoke.cjs` 的「未知事件」两段）。

## 八、会话 JSONL 的兼容策略

会话文件是只读的，形状按「**宽松读取、严格归属**」处理：

| 变化 | 策略 |
|---|---|
| 消息体嵌在 `message` 下（pi 的真实形状） | ✅ 支持 |
| 消息体直接摆在顶层（旧 / 自定义形状） | ✅ 也支持（多一层兜底） |
| 出现不认识的条目类型 | 忽略该行，不当坏文件 |
| 出现不认识的 content block | 只取 `type === 'text'` 的，其余忽略 |
| **新增未知字段** | 忽略 |
| 某一行是坏 JSON / 被截断 | 跳过那一行；文件仍可用 |
| header 读不出来 / 没有 `cwd` | 这个文件跳过（**只有它自己受影响**），并计入诊断的 `skipped` |
| 单文件超大 | 只读前 4 MB（列表）/ 8 MB（搜索），标 `truncated` |

**归属判定只认 header 里的 `cwd`** —— 目录名只用来缩小扫描范围。所以 pi 以后
改了目录命名规则也不会让我们把两个项目的对话串起来。

判断消息体形状的那段逻辑**只有一处**（`pi-compat` 的 `sessionMessageBody`），
`sessions.js` 与 `session-search.js` 共用；前端 `public/tree.js` 因为跨进程
另有一份等价实现。

## 九、在 Diagnostics 里怎么看

侧栏底部「诊断」→「Pi 兼容性」区：

```
Pi 兼容性
  Pi 版本        0.87.0
  兼容状态       正常
  RPC           支持
  会话状态       支持
  历史消息       支持
  新会话        支持
  会话切换       支持
  会话重命名      支持
  Tool Events   支持
  扩展 UI       支持
  会话文件       支持
```

- 状态是 `partial` / `incompatible` 时用警示色；`unknown` 用弱化色。
- **未验证**的能力显示「未验证」而不是「不支持」—— 那只是还没用到。
- 有缺失时下面会列出**缺少能力（对应功能已降级）**。
- 有协议异常时列出最近 5 条（操作名 · 问题类型 · 字段名），并在 JSON 里给全量。

「脱敏后的诊断 JSON」里的 `compatibility` 段就是完整报告：

```json
{
  "detected": true, "version": "0.87.0", "versionKnown": true,
  "status": "compatible",
  "capabilities": { "rpc": true, "getState": true, "getMessages": true,
                    "newSession": true, "switchSession": true, "sessionNaming": null,
                    "toolEvents": null, "extensionUi": null, "sessionJsonl": true },
  "missing": [], "unverified": ["sessionNaming", "toolEvents", "extensionUi"],
  "protocol": { "expected": 1, "observed": 1 },
  "issues": []
}
```

> `protocol` 是 **Pi GUI 自己的期望标记**（应答信封该长什么样），不是 pi 声明的
> 版本号 —— pi 的 RPC 没有版本协商。`observed` 在第一次看到合法信封时置为同一个值。

## 十、升级 pi 之后怎么验

自动化测试**不依赖真 pi**（全部 fixture 驱动），所以升级后要人工过一遍：

1. `npm test` —— 基础测试全绿
2. `npm run test:app`（先 `npm run fixtures`）—— 打包链路正常
3. 打开应用 →「诊断」→ 看 **Pi 兼容性**：
   - 状态应是「正常」或「部分兼容」，**不该是「未知」**
   - `unverified` 里有能力是正常的（没用过）；`missing` 里**不该有**核心能力
   - 协议异常应尽量为空；有的话点开看是哪个操作、哪个字段
4. 新建会话
5. 发一条**不重要的**测试 prompt（这一步会花额度）
6. 让它跑一次工具（例如「列一下当前目录」）→ 看 Tool Timeline 是否有 start/end
7. 重开应用 → 历史是否恢复
8. 切换会话 → 是否切得过去、历史是否正确
9. 用侧栏搜索框搜一个词 → 结果、跳转是否正常
10. 有改名需求时点一次铅笔 → 改完刷新是否还在

**这不是自动化测试的替代品**，是 upstream 升级清单 —— 自动化测的是
「给定这些形状，我们的判定对不对」，没法替你确认「这个版本的 pi 真的这么发」。

## 十一、相关测试

```bash
npm run test:compat    # tests/pi-compat.cjs（55 条，纯 fixture）
```

覆盖：完全兼容 / 缺可选能力 → partial / 缺核心能力 → incompatible /
版本未知仍兼容 / 上游新增未知字段 / 未知事件安全忽略 / 畸形数据记异常不崩 /
会话两种消息形状 / 异常缓冲上限 / 报告不含任何原始值 / 三值语义。

前端侧（`npm run test:ui`）另有一组：未知事件不崩、未知 response command 不崩、
按能力局部降级（隐藏改名 / 禁用切换 / 一次性的核心不可用提示 / 历史说明）。

## 十二、不做的事

明确不做（见 P4 规格的禁止项）：自动更新 / 安装 / 降级 pi、查 npm registry、
查 GitHub Release、改用户全局 npm、改 pi 的 session schema、fork 或 monkey patch pi、
telemetry、崩溃上传、新数据库、新第三方依赖。
