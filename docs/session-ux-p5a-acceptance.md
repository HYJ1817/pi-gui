# P5-A 统一执行数据模型与事件适配验收

P5-A 将同一个任务级模型接到 Classic 和 Runtime 的现有事件路径。用户可见的会话仍使用原渲染器。本阶段交付实时投影、原生分支取证和受控详情验证，为 P5-B 提供可消费的快照。

## 源码基线与分支

| 项目 | 实测 |
| --- | --- |
| 基线 | `origin/main` 的 `c444b7c8d1df6735bd998d24b111559b99d63e93` |
| 分支 | `feat/session-ux-p5a-execution-model`，独立 worktree |
| 基线 CI | 当前 main 精确 SHA 的 CI 已取消。上一条成功运行属于 `66586aa`。按要求先推送分支，暂缓 PR。完整 canonical 待对应 PR CI 运行。 |
| 行为提交 | `499c22689fa2b2dfd474497c85553aaa6c39af55`。本报告为独立文档提交。 |
| P5-0 输入 | 四份规划文档从系统页工作树按名称复制，逐文件对照 SHA-256。 |

[精确基线 CI](https://github.com/HYJ1817/pi-gui/actions/runs/44673633963) · [先前成功的 main CI](https://github.com/HYJ1817/pi-gui/actions/runs/44547191813) · [P5-0 架构](session-ux-p5-architecture.md)

## 公共接口与实体

| 接口 | 行为 |
| --- | --- |
| `createExecutionTimeline(scope)` | 构造无 DOM、网络和文件访问的归约器。作用域保留完整 Runtime owner，或 Classic bridge 实例、运行代次、工作区及原生会话 ID。另保留 GUI 分支 epoch。 |
| `apply(event)` | 接收 scoped `ExecutionEvent`，以 `eventId`、位置和事实顺序归约。用量按响应而非 delta 计数，助手终值校正分段，工具完成更新原行。 |
| `snapshot()` | 返回 `{scope, turns, groups, items, completeness}`。每轮包含输入与补充输入、尝试、Plan、AssistantPart 和逐响应 usage，组、活动、计划项均含身份、父级、位置和可信时间。子代理从已核验的 P4-A facts 提供子项摘要与状态。 |
| `mergeHistory(cut)` | 接收 scoped branch/leaf 证据、覆盖游标、实体及别名。已证实 cut 可替换水位内已终结内容；未认证或无法证明范围时仅做局部补充，保留更新的实时事实。 |
| `getClassicExecutionTimeline()` / `getRuntimeExecutionTimeline(owner)` | P5-B 在现有状态观察点读取旁路快照。附 `resolveClassicExecutionMessage(scope, ref)` / `resolveRuntimeExecutionMessage(scope, ref)`，用于访问同作用域临时保留的原始用户消息和图片附件。过期内容可使用 bounded preview 和附件元信息，历史正文按后续分支读取契约提供。 |
| `readExecutionBranch(...)` / `bindExecutionEntries(after, {checkpoint, messages})` | 后端私有取证使用 Pi 的 `get_state` 和 `get_entries`。从原生 leaf 沿 parent 回查，读取后复核会话和叶节点。绑定所需消息见证可从同一适配器的 `nativeWitnesses(turnId)` 获取。证据不足时给出 partial。 |

`ActivityDetail` 在本阶段由受控 registry API 返回经过筛选的参数、范围、数量和增删数据。普通 Runtime 活动保留稳定的受限引用。可读详情句柄由测试开启的 `captureExecutionDetail(owner, target)` 产生，用同一 owner、call ID 和 ref 向 `readExecutionDetail` 读取。接口未挂 HTTP 路由，P5-B 不能把内部验证句柄直接用于用户操作。

## 事件映射与顺序

| 来源事件 | Classic / Runtime 共用事实 |
| --- | --- |
| 既有命令接纳，`message_start/end user` | 服务端接纳元数据提供提交身份；实际用户回声落成一条输入。相同文本的不同提交互相独立。已真实送达的 steer/follow-up 作为本轮补充。编辑重发根据新分支和已接受事务的原生 entry 认领回声。 |
| `agent_start` / `agent_end` / `agent_settled` | 已活动的任务重用 turn；`agent_end` 保留为内层边界；`agent_settled` 或已知 Stop/退出证据结算。未确认的 Stop 结态等权威停止，工具失败单独落到该条。 |
| `message_start/update/end` | bounded text 和公开 Thinking 按 content index 更新，终值优先。过程文字、最终答复、部分答复分别标识；用量只取被接受的真实响应值。 |
| `tool_execution_start/update/end` / `tool_wait_state` | 以首次开始位置创建活动。活动属于捕获的任务和尝试，工具名明确不符时拒绝更新，兼容旧 end 无 toolName。结束次序不会影响列表。 |
| `gui_plan` | start 的窄参数可形成待确认 Plan；end 的结构化 details、revision 与 producer turnId 决定最终版本；失败撤销待确认状态。计划调用不重复产生普通工具行。 |
| auto retry / fallback / compaction | 自动重试仍在本轮，fallback 仅在后端认可的前次失败链上继续，压缩只消费真实事件。 |
| bridge/generation/branch 换代、断线或裁剪 | 用当前授权身份建独立流。Classic 的不可证实断线段标记 partial，避免后续输入被归入旧任务。Runtime 在旧 store 之前独立维护连续游标，同一现有 recovery 请求可获取低序号补帧。 |

Runtime 起始游标取服务器声明的该代前置水位，允许首帧大于 1。首次 native session ID 补齐需要同代、同工作区和后端绑定序号。在缺失连续前缀时仅保留已见事实与局部状态。每条工具完成、计划 revision、会话身份及原生别名都由各自证据校验，文本、时间戳和单独 call ID 不作为跨会话匹配条件。

真实测试输出取自 `node tests/session-ux-p5-model.cjs --json`。两端在全部比较字段上相等，下面是共享投影的 JSON 摘录：

```json
{
  "turns": [{
    "status": "completed",
    "plan": [["inspect", "completed"], ["verify", "in_progress"]],
    "parts": [["thinking", "Visible thought"], ["progress-text", "Progress"], ["answer", "Final answer"]],
    "usage": [["model-a", 13], ["model-a", 13], ["model-b", 13]]
  }],
  "items": [["A", "completed"], ["B", "failed"]]
}
```

## 安全边界和预算

- 工具摘要只保留允许的文件名、证实的行范围/命中、受限命令类别、真实耗时、每次调用 diff 计数及结构化子代理事实。详情从同一分支中匹配的原生 assistant/toolResult 条目提取，查找键不授予访问权限。未知、敏感或原始 stdout/文件内容保持受限。
- Runtime 的 `agent_end.messages`、`turn_end.toolResults`、`entry_appended`、`message_update` 和 entries/tree 回复原本有较宽结构。动态 canary 验证了专用工具投影之外的路径，现按对应封装重建消息和可展示字段。Classic 的既有工具载荷继续由原渲染路径拥有，P5 摘要由服务端重新生成。
- Runtime 补帧预算 200 帧 / 1 MiB / 2 秒的事件时间窗口，超限标记 partial。调用、提交和消息见证索引有界，tombstone 上限 2048，超限的完成证据保守处理。归约器保留至多 240 个任务和全局 240 个响应、2000 条活动、8192 个去重事件键及 1 MiB 正文预算；逐响应最多 100 个分段。
- 用户富内容临时缓存每个流 32 条 / 512 KiB；受控 Runtime 详情索引 64 条 / 1 MiB / 120 秒，绑定 owner、workspace、runtimeGeneration、branch epoch、leaf、响应/结果条目及调用。从原生读取得到的原文未写入新增索引或广播。P5-0 的 32 KiB 输出预览是后续内容准入上限，本阶段的详情不提供原始输出。

## 本地验证和复审

| 验证 | 结果 |
| --- | --- |
| `node tests/session-ux-p5-model.cjs --json` | 22 组适配器场景、61 条纯模型断言、5 组后端场景通过。覆盖反序完成、重复与晚到、旧 store 补帧、首次 native 绑定、两端活跃分支和编辑回声、Stop 交错、越权、恶意载荷与限额。 |
| Runtime 与 Stop | events 14/14、store 34/34、session-runtime 7/7、HTTP 12/12、registry 42/42、stop-barrier 17/17、gui-browser-stop 13/13。 |
| P1–P4 与动画 | P1 81/81、P2 96/96、P3 128/128、P4-A 110/110、P4-B 108/108、P4-D 14/14、P4-E 60/60、Thinking 90/90。 |
| 相邻路径 | background recovery 6/6、message-edit HTTP 10/10、service 49/49、Runtime history/search 37/37、历史摘要 HTTP 49/49 断言、server security 41/41、fallback 74/74、UI2 Classic 55/55、Runtime display 83/83、dev-server 38/38、modules 121/121。 |
| Canonical 清单 | `node scripts/run-test-group.mjs --validate` 确认 288 个叶命令和五组完整覆盖。完整 `npm test` 由 PR CI 代验，本地未运行。 |
| 单文件产物 | 在独立临时目录执行 `PI_GUI_SKIP_LIBREOFFICE=1 npm run fixtures`（PowerShell 设置同名环境变量），随后 `npm run build:exe`、`npm run test:exe`，通过 50/50。EXE 105,720,832 字节，SHA-256 `f4fed7bd5c1dc5001d7560fcb20285b26e314d48cdb16cf9a5ac40addd008434`。首次因新 worktree 缺 PDF 夹具得到 44/45，生成离线夹具后重跑成功。该结果证明单文件 EXE 路径；Electron 打包和签名未作本地验收。 |
| 冻结检查 | `git diff --exit-code origin/main -- public/thinking-dots.js public/thinking-dots.css public/messages.js public/runtime-conversation.js public/scroll-button.js` 通过。没有新 UI 像素或动画节奏差异需要视觉验收。 |

独立功能复审复现 Classic 断线后错并任务、工具名不符仍更新、Legacy Stop 先 settle 后确认，以及私有编辑回声早于提交观察四类问题。修复分别由断线 partial、工具身份校验、Stop 收口和事务归属夹具覆盖。编辑导航发出前即轮换旁路分支，防止应答丢失时继承旧尾部。编辑 prompt 丢应答且缺少可核对关联时保留 partial，不合成原生 ID。独立安全复审复现 Runtime 旧封装载荷、分支见证及详情来源边界问题，验证闭集投影、二次叶节点取证、原生详情来源与授权过期。最终增量的独立安全复跑受评审工具用量限制，作者已重跑后端场景与 Runtime 回归。开发中出现的 P4-B jsdom 缺少 TextEncoder、Stop 夹具装配和模块导入策略失败已分别修复并定向重跑。

## 后续对接与回滚

P5-B 可按任务、组和明细 ID 更新 DOM，结合已有 Markdown、附件、Plan、工具行及状态组件。若数据只包含受限引用、旧内容仅有 preview 或轮次为 partial，以当前可用证据展示。正式 Runtime 内容详情仍需独立验收授权读取和允许的输出形态。

P5-C 实施持久化元数据索引、生产快照与 cut 生成、负载下完整重连和跨进程恢复、历史分页与旧分支回退。没有可验证原生 ID 的多用户/无工具消息保持 partial。在 P5-A 的受控样例中，合并接口接受已证实映射，历史读取不会自动替换现有 UI。

`server.js`、`public/app.js`、`package.json` 与系统页并行开发共享，P5-A 分别只接入观察、追加 P5 测试叶。系统页分支及其变更由原工作树保有。回滚时撤销 P5-A 行为和 canonical 注册的同一提交即可，P5-0 规划可继续保留。Pi 原生历史无需迁移，产物按目标代码状态重建。
