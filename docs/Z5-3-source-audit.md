# Z5-3 历史工具摘要：来源审计与实施合同

日期：2026-10-27。唯一执行 Agent；只读核对本机安装源码，没有读取用户会话内容、启动 Pi 或发送 prompt。

## 1. 审计结论：GO（有限的记录结果摘要）

基线 `ec336ad348f3af70e2bf4fd5e3a22dbd70d4c32a`。PR #38 当前 open / 未合并，因此本阶段只做后端及测试，禁止修改 `public/runtime-conversation.js`。
本机 `pi.cmd` 指向 `@earendil-works/pi-coding-agent/dist/bundle/cli.js`，包版本 1.4.0。
以下路径以该安装包为根；这是实际安装源码的静态证据，不是仅凭文档或用户真实 JSONL 推断。
人工 TEMP fixture 按这些代码构造，不要求测试机器安装 Pi。

| 问题 | 结论与可复核证据 |
| --- | --- |
| 1 原生记录有可辨识调用吗 | 有。`node_modules/@earendil-works/pi-ai/dist/types.d.ts:271` 定义 `ToolCall`；`dist/core/agent-session.js:755-767` 将 assistant 和 toolResult 的 message_end 存入 SessionManager；`dist/core/session-manager.js:831-840` 以嵌套 `message` 写入 JSONL。 |
| 2 工具名称从哪里读 | `message.role=assistant` 的 `content[]` 中 `type=toolCall` 的 `name`；结果的 `toolName` 只能用于交叉核对。`pi-ai/dist/types.d.ts:271-275,420-430`、`pi-agent-core/dist/agent-loop.js:662-674`。 |
| 3 有稳定调用 ID 吗 | 原生 `toolCall.id` 被原样复制至结果 `toolCallId`（agent-loop:665）。它不是全局唯一证明，不能跨文件或仅靠 ID 配对；条目自身 `id/parentId` 由 SessionManager 分配（session-manager:831-840）。重复或畸形 ID 降级。 |
| 4 哪种终态可证明 | 正确关联且 `isError === false` 的独立结果证明“记录了非错误结果”；`isError === true` 证明“记录了错误结果”。agent-loop:662-679 与 agent-session:755-767。不能由此证明磁盘变更、任务成功或工具底层一定执行。 |
| 5 能安全关联吗 | 可以在同一有界窗口内以唯一调用 ID、相同原始名称、唯一条目 ID、先调用后结果、可信 parentId 链共同关联。session-manager:826-840、getBranch/buildSessionContext 的父链（:129-145,282-300）。不同分支的相同 ID、重复结果、链缺失或逆序均不得认定完成。 |
| 6 失败/取消/中断能区分吗 | 不能完全区分。agent-loop:435-445,493-543 把 abort、拦截等也转成 `isError:true`；结果没有可靠的独立 cancelled/interrupted 字段。状态采用 `completed / error / unknown`，error 文案应为“结果报错”，不输出 interrupted/failed 来假装已区分执行失败原因，也不解析输出文本猜原因。 |
| 7 局部窗口会误判吗 | 会：调用或结果可能在窗口外，分支父链可能缺失。只报告窗口中可证明的局部结果；缺失为 unknown，窗口/条目截断明确标记。原正文是文件顺序而非当前分支重建（仓库 `session-history.js:90-107`），摘要也表示文件窗口中记录的调用，不声称是当前活动分支。 |
| 8 现有读取预算 | `session-history.js:33-69,81-107`：尾部最多 4 MiB，正文最多 800 条；头部身份校验每次至多 64 KiB、前后各一次，同 fd 复核，错误不抛路径。没有独立墙钟超时/原始行数上限；本阶段不增加扫描字节，摘要另限最后 4096 行、最多 100 调用。不是无限扫描。 |
| 9 原始数据可能含什么 | `ToolCall.arguments`、`thoughtSignature`、结果 `content/details/nestedCalls` 可含命令、文件、路径、凭据、Browser 内容；assistant thinking 也在原始 content 中。types.d.ts:271-283,420-434。现有正文只取 text，不代表原文件已脱敏。 |
| 10 能仅输出受控摘要吗 | 可以。白名单投影仅输出固定工具名和固定状态/source，拒绝输出参数、输出、ID、路径、原始错误、原始 JSONL。现有 `public/tool-history.js`/`tool-model.js` 会保留参数/输出并按 ID 取首结果，不适用于本摘要的安全边界，故新增小型纯模块而不复用其全量模型。 |

可信形状示例（全部人工占位，省略非投影字段；不是用户记录）：

```json
{"type":"session","version":3,"id":"fixture-session","cwd":"<TEMP>"}
{"type":"message","id":"a","parentId":null,"message":{"role":"assistant","content":[{"type":"toolCall","id":"call-1","name":"read","arguments":{}}]}}
{"type":"message","id":"r","parentId":"a","message":{"role":"toolResult","toolCallId":"call-1","toolName":"read","isError":false,"content":[]}}
```

## 2. 现有权限及生命周期边界

- `server/session-runtime.js:134-136` 从后端 scanner/header 已验证目标取得 realpath；registry `:199-203` 保存 locator 和文件身份；`historyTarget():406-413` 仅给后端，前端不传文件路径。
- `server/session-history.js:39-67` 前后校验同 fd 的 header.sessionId/cwd、dev/ino/birthtime、realpath 与当前路径身份；读取失败不返回正文或摘要。不修改此证明。
- `server/router.js:170-179` 在 Runtime route 前执行 `auth.denyRequest`；`server/auth.js:47-63` 保留同源及共享令牌边界。GET 是应用授权的只读历史，不要求活 Runtime Owner，也不新增当前 Classic 项目 cwd 过滤；它已有完整 project/workspace/native-session locator，不能错误禁止浏览已关闭或已移除 Worktree 的历史。
- `server/runtime-routes.js:18-26` 捕获 target，读取后复核 locator 与文件身份。正文和摘要一起过同一检查；不调用 start/resume/command/read RPC、不经过写入/审批 admission。已有 history admission 就是这条证明链，不能发明第二套权限。
- `public/runtime-conversation.js` 的 loadHistory 捕获 record/stamp/token，写回前核对，切换/恢复时失效；本阶段不修改。旧 UI 忽略新增字段且仍明确表示仅正文，摘要 UI 尚未交付。

## 3. 投影合同与最小实施计划

使用 writing-plans / executing-plans 方法在本轮顺序执行，用户已明确授权审计通过后的最小实现，无需再次询问；禁止子 Agent。

1. 先运行原历史、搜索、兼容、HTTP、输入/草稿基线。写本审计，固定 GO 条件与真实形状。
2. 添加 `tests/history-tool-summary.cjs`，先通过 `readSessionMessages` 验证新字段缺失而失败；再添加 `server/history-tool-summary.js` 并在原解析循环接线，同一 fd 读取不重复扫描文件。最后在现有 Runtime HTTP 中透传。
3. TEMP 测试覆盖正常/错误/缺失、ID/父链/顺序/分支/重复隔离、敏感/恶意名称、异常 JSONL、窗口/行/调用预算和原文兼容。扩展真实 Router HTTP 测试，验证认证、迟到身份、无写盘/无 Pi/无审批副作用；既有测试全部保留。
4. 每个边界先红后绿，注册 package.json canonical 链。只读复核 PR #38；未合并则停止 UI，重建 App/SEA、验证产物，交付验收报告并分阶段本地提交。完整 canonical 留待未来 PR CI，当前待验证。

候选比较：直接复用全量工具时间线会携带敏感字段并错误采用“首结果”；扩建原生完整树解析器超出范围；选择仅保存结构白名单的小型纯投影，缺证据就保守降级。

返回 `toolSummary`：

```json
{"items":[{"toolName":"read","status":"completed","source":"confirmed"}],"returned":1,"limit":100,"truncated":false,"historyTruncated":false,"unavailableReason":null,"uncertain":false}
```

- status `completed`：唯一可信配对结果 `isError=false`；`error`：同条件 `isError=true`，包括失败、取消、拦截，不能进一步细分；`unknown`：最终结果不明。source 分别为 `confirmed` 或 `unconfirmed`，仅表示记录证据。
- 工具名须 ASCII 字符白名单、1～32 字符且在已核实的内置闭集中：read/bash/powershell/edit/write/grep/find/ls（安装包 `dist/core/tools/index.js:1-34`）。其他一律固定 `unknown_tool`，即使未知名称字符合法也不回显；不截短或改写恶意字符串成另一个真实工具。
- `returned` 是实际项数，`limit=100`；仅返回最近最多 100 次调用。`truncated` 表示摘要行/调用预算截断；`historyTruncated` 继承正文原标志。`uncertain` 表示存在未知终态或记录/窗口缺口。空历史 `unavailableReason=no_tool_calls`，损坏/不支持/孤儿/预算缺口使用受控原因，不伪造工具调用。
- 摘要每项只含三个短字段，JSON 摘要预算 < 12 KiB（测试精确核对）；原正文上限与 JSON 转义后的既有体积合同不变。无额外索引、后台任务、数据库、依赖或新网络行为。
- 结果的 parentId 必须沿窗口内更早条目回溯至该调用的 assistant 条目，遇到另一条 assistant/user 或损坏/重复节点即停止。关联不修复旧记录、不迁移 schema、不证明 Agent 的 Git 归因。

## 4. 证据资格与缺口

GO 只授权以上有限摘要：不是完整日志、当前分支视图、执行副作用证明或真实外部模型集成资格。来源审计为作者只读核对；独立功能/安全审查依用户单 Agent 要求未运行，留待用户独立验收。原生 v1、无 id/parentId 的旧/自定义形状可继续显示正文，但工具终态不作确认。
