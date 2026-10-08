# P33.1 / P33.1a：Safe Session Revert 架构审计与方案设计

日期：2026-10-08。状态：P33.1a 补充设计稿，等待人工验收。本次仅更新本文；不实施 P33.2。

**P33.1a 决策摘要：** 保留严格安全模式；增加用户逐次确认的受限恢复模式，在普通本地工作区直接应用符合条件的撤销。通过 Pi 官方支持的同名工具覆盖，把默认 `write/edit` 接到实际 I/O 证据采集，不要求 Agent 选择新工具。受限模式必须先有持久备份、无冲突候选和当前文件校验；它不具备任意外部进程下的原子 compare-and-swap 保证，也不宣称零数据丢失风险。此摘要替代初稿“整个第一版默认只能导出”的产品结论，细节见 §5–7，本次改动清单见 §10.1。

证据标记：**[事实]** 为本轮阅读当前代码确认；**[推断]** 为从调用链推出的行为或风险，未在真实用户工作区执行破坏性复现；**[设计]** 为推荐的未来实现；**[待验证]** 为实施前必须补足的契约或平台证据。代码位置采用仓库相对路径与一基行号，均针对下述 HEAD；行号范围表示完整相关分支，不表示每行都有该结论。

## 1. 当前仓库与 HEAD 信息

| 项目 | 本轮结果 |
|---|---|
| 工作目录 | `C:\pi-GUI` |
| 当前分支 | `main` |
| HEAD | `41a106d891f394b545d772b1bda69d67962de78a` |
| 提交时间及主题 | `2026-10-08 10:13:07 +0800`；等待 Git 恢复文件时容忍短暂缺失且保留最终隔离断言 |
| 本地缓存的 origin/main | 与 HEAD 相同；没有 fetch，不能据此证明实时远端相同 |
| 版本 | `0.23.0`，`package.json:3`；本地最高版本 tag 为 `v0.23.0` |
| 开始时状态 | tracked changes 为空；已有未跟踪目录 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`，保留不动 |
| 检查方式 | `git status/log/rev-parse/tag/show`、`rg`、读取源文件；解析本机 Pi launch 身份后只读其源码/类型 |
| 未执行 | fetch、远端 Release 查询、安装、测试、构建、任何撤销/快照采集 API、提交/推送/合并 |

本阶段只允许不修改项目状态的检查，因此没有沿用通用约定中的联网 fetch 和 `npm test` 基线步骤。测试会创建 fixture/启动服务，本轮不执行；下文测试矩阵是未来验收要求，**不是本轮通过结果**。`worktreeTree()` 也没有执行，它会向 Git object database 写对象（`lib/git.js:933-969`）。Jev 路由返回 docs、低风险、低测试/联网需求，仅作为分类参考。

P33.1a 再次核实 HEAD 未变；开始时原报告也已存在且未跟踪，本次在原文件上修改。补充检查限本地官方示例/源码/类型与文档结构，没有启动 Pi、调用工具执行或业务恢复 API。Jev 本次把实际功能设计归为 backend 并建议后续测试；这是设计路由，不构成本阶段执行业务测试的授权。

历史记忆曾停在 P32.3 的部分验收状态；本轮以当前源代码为准。当前存在 P32.4 的 scoped Changes 和完整运行时 UI 接线（`server.js:376-389,787-815`，`public/runtime-store.js:9-69`），不能拿旧记忆推断这些实现缺失。本文不重新认证 P32 的真实模型、压力或跨平台验收结果。

## 2. P32 后的实际架构

### 2.1 身份与隔离

| 已确认事实 | 当前代码证据 | 对 P33 的约束 |
|---|---|---|
| GUI conversationId 由 `randomUUID()` 生成并持久化；不是 native sessionId | `server/runtime-registry.js:164-172` | 证据不可只按 Pi UUID 或路径归档 |
| registry 的完整 owner 有九字段：backendInstance、projectId、repoId、workspaceId、workspaceEpoch、conversationId、runtimeId、runtimeGeneration、sessionId | `server/runtime-registry.js:5,54-61` | 运行中采集/应用复用完整 owner，禁止 PID 授权 |
| backend、runtime、generation 有独立 UUID；启动时 sessionId 为空，私有 `get_state` 回读后绑定 | `server/runtime-registry.js:17,118-138,148-153` | 未证明 native 身份前不能产生可自动撤销证据；跨代事件失效 |
| native UUID 来自 Pi；registry 会拒绝 resume UUID 不符和两个 live runtime 绑定同一 UUID | `server/runtime-registry.js:120-128` | 不能自己发明 Pi session ID 或改其 schema |
| `conversations.json` 记录 workspace、session locator/文件身份、标题及创建时间，使用临时文件原子替换 | `server/runtime-registry.js:20-51,129-137` | 复用身份索引，但不把内容 blob 塞进 manifest |
| canonical root lease 拒绝同 workspace 的第二条 live 会话；默认 2、硬上限 3 | `server/runtime-registry.js:140-150` | 当前托管路径已减少同文件并发，不需要第二套 runtime registry |
| classic cwd 落在目标 worktree 内时拒绝独立会话 admission | `server.js:794-800` | 保留现有 classic/runtime 隔离规则 |
| 每条 runtime 拥有自己的 bridge、supervisor、activity、generation、managed process；独立 session 禁用隐式 continue | `server/session-runtime.js:45-88` | 采集桥应随 adapter 构建和销毁 |
| focus 只切当前记录/Browser；close 等待 dispose 和 cleanup，再释放 lease，持久 conversation 保留 | `server/runtime-registry.js:218-248` | 关闭、切换不可删除撤销证据；恢复沿用会话记录，重新认证运行 owner |
| resume 校验 workspace 身份；周期 healthCheck 失败会 retire | `server/runtime-registry.js:175-182,249-250`，`server.js:822` | 不按相同路径静默迁移证据 |
| SSE 有 owner、eventSequence，内存环默认 200 条/1 MiB，超限标记 historyRequired | `server/runtime-registry.js:16,80-116,212-216` | SSE 环不是可靠持久化 journal |
| renderer store 按 conversation 分区，检查 owner、sequence、revision；跨 backend 重建 | `public/runtime-store.js:9-63` | 前端只投影证据摘要，不持有恢复正文 |

**session ID 的三种含义必须区分。** classic 列表 ID 为文件路径 SHA-1 前 16 位（`server/sessions.js:42-46`）；native session UUID 从 JSONL header.id 读取（`server/sessions.js:165-171,221-225`）；GUI conversation UUID 见 registry。classic 切换使用已验证 target 的 `switch_session`（`server/sessions.js:648-660`），P33 不应把列表 ID 当 native UUID。

### 2.2 Worktree authority

**[事实]** `server/worktrees.js:35-36,65-85,150-172` 保存 `worktrees.json`、受控目录、repoId、projectId、workspace UUID/epoch 和根/admin 目录身份。repoId 是 common Git directory 路径的 SHA-256 前 24 位，projectId 是规范项目路径的同类哈希（`:9,85`），不是跨机器不变的仓库内容 ID。

**[事实]** 健康检查核对 root/admin 身份、Git inventory/common/branch，丢失健康状态会换 epoch 并失效；`withWorkspace` 在共享 lifecycle lock 内验证 authority、提供 root/cwd（`server/worktrees.js:115-135,244-255`）。移除拒绝 in-use、dirty、submodule、未集成工作并再次检查（`:197-215`）。

**[推断]** 正常托管会话 A/B 在不同 worktree，相同相对路径不是同一个磁盘文件；但先后恢复/不同会话重用 workspace、外部编辑器、shell 写绝对路径、硬链接、第三方工具/子进程仍可能接触同一实际文件。root lease 只管 GUI admission，不是 OS 写锁（`server/runtime-registry.js:144-150`；上游 write 接受绝对路径，见 §3.3）。

**[设计]** 持久证据键使用 `(projectId, repoId, workspaceId, workspaceEpoch, conversationId, nativeSessionId, evidenceEpoch)`；每条操作另记录完整运行 owner。关闭后通过持久身份重新取得 `withWorkspace` authority，不要求旧 backendInstance 仍有效；旧运行 owner 不能直接授权新进程。路径/epoch/admin 身份变化时只允许读旧证据和导出，不自动重绑定。

## 3. 文件变更追踪审计结果

### 3.1 当前事件链

1. **[事实]** bridge 从 Pi stdout JSONL 收到消息，经内部 request 配对后发布 `bridgeRun/cwd`；没有等待 renderer 快照的握手（`server/rpc-bridge.js:371-427`）。
2. **[事实]** classic `onToolEnd` 查 start 时保存的 entry，`!evt.isError` 才调用 `recordToolChange`；`write/edit/bash` 成功结束会安排 Git 刷新（`public/tools.js:54,154-168`）。
3. **[事实]** 可计账工具集合只有 `write/edit`（`public/tool-model.js:69-70`）；路径只取 args.file_path 或 args.path。账本只存 `{path,tool,at,count}`，重复路径计数，模块内存保存（`public/changes.js:23-31,49-75`）。它没有 sessionId、before/after 字节、digest、操作 ID、删除/rename 关系。
4. **[事实]** classic `sessionFileSet` 将账本路径转为项目相对路径，与 Git status 列表求交；独立 runtime 直接返回空集合（`public/git.js:194-201,337-357`）。当前 UI 实际标签是“本会话编辑”，并说明终端修改看“全部”（`:388-395`），不是完整会话变更账本。
5. **[事实]** classic 切会话调用 `clearChanges`；历史重建走 `planHistory`/DOM 重建，不调用账本写入（`public/rpc.js:357-375`，`public/messages.js:630-676`，`public/changes.js:73-76`）。账本不能作为重启后的恢复证据。
6. **[事实]** runtime 事件投影去掉工具 args/result，toolResult content 清空，toolCall 只保留 id/name（`server/session-runtime.js:19-41,77-86`）；runtime store 只留工具 ID/name/state（`public/runtime-store.js:56-57`）。不能从它重建完整文件操作，更不能为了 P33 把 raw args/result 发回 renderer。

**[推断，重要]** “工具失败就没修改磁盘”的注释不是安全契约（`public/tools.js:161-164`）。本机上游 write 在完成 `writeFile` 后仍检查 abort，可能写成功但结果报错（§3.3）。遗漏 error/end 丢失/崩溃路径会漏记实际修改。P33 必须记录执行结果与磁盘结果两个维度。

### 3.2 已有快照与数据层能复用多少

**[事实]** Planner 在 attempt 执行前采 `preTree`、结束后采 `postTree` 并计算 tree diff/numstat（`server/planner/scheduler.js:478-493,526-535`，`server/planner/evidence.js:183-220`）。这是真实的“操作前快照”先例，但粒度是 attempt 时间窗口，不是每条普通聊天工具，也不是用户/Agent 归因证明。

**[事实]** `worktreeTree` 用独立临时 index，`read-tree HEAD` 后按项目范围 `add -A`、`write-tree`；不会修改真实 index/ref/工作区，但会产生 dangling Git objects，忽略文件不会全部纳入（`lib/git.js:906-969`）。Git add 也不是原始文件字节保存机制，转换过滤器/换行规则需要另审计。`changeEvidence` 保存的是有总量/单文件预算、可能截断的 patch 摘要（`server/planner/evidence.js:103-169`，`server/planner/model.js:450-487`），不是可持久回滚的完整 B/A。

**[设计]** 复用组合根注入方式、identity、authority、固定错误码和预算模式；Planner 证据仍供 review。不要复用 dangling object SHA 作为长期恢复唯一来源，不把有限 patch 升格为恢复证据，不在 Planner store 新建聊天会话状态。仅新增一个从属的 P33 evidence store，引用既有身份。

### 3.3 本机上游核查（仅本机版本，不能外推所有 Pi）

通过 `server/pi-launch.js` 的只读 `packageDir()` 找到安装包，本轮未启动 Pi。记 `PI_LOCAL` 为该包根目录；本机实际为 `C:\Users\21022\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent`，仅用于审计定位，不得硬编码到产品。

| 确认的上游事实 | 本机代码位置 |
|---|---|
| 本机包版本 1.0.4 | `PI_LOCAL/package.json:3` |
| `tool_call` 可阻断且输入可变，后续 handler 可再次修改，无重新验证 | `PI_LOCAL/dist/core/extensions/types.d.ts:943-949` |
| 嵌套 `ctx.executeTool` 经 hooks 并带 parentToolCallId；MCP/自定义工具也可有独立执行路径 | `PI_LOCAL/docs/extensions.md:148`，`types.d.ts:939-949` |
| write 调用实际 writeFile 后再检查 abort；result.details 无完整 before/after | `PI_LOCAL/dist/core/tools/write.js:30-51` |
| edit 读 Buffer，去 BOM、归一 LF、应用编辑、恢复换行后写回；result 含 diff/patch，但没有完整双向原始字节 | `PI_LOCAL/dist/core/tools/edit.js:92-137` |
| write/edit 使用同进程文件 mutation queue | `PI_LOCAL/dist/core/tools/write.js:33-47`，`edit.js:95-126`；队列本体 `dist/core/tools/file-mutation-queue.js:1-51` |
| 公开类型入口导出 createWriteTool/createEditTool 及 definitions/operations 类型 | `PI_LOCAL/dist/index.d.ts:20,26`；`dist/core/tools/write.d.ts:17-25`、`edit.d.ts:29-39` |

**[推断]** 上游队列不能约束另一个进程或编辑器；它用 realpath 归一已存在文件，但不能覆盖所有硬链接/不存在路径别名（队列本体 `:11-20,27-43`）。hook 看到的参数也未必是最终执行参数：后续扩展可改输入。

**P33.1a 新确认的官方接入证据：**

| 已确认事实 | 本机上游位置 | 设计含义 |
|---|---|---|
| 官方示例明确允许 Extension 用与 built-in 相同的工具名替换内置实现 | `PI_LOCAL/examples/extensions/tool-override.ts:1-20,68-76` | 可以直接接管 Agent 已使用的 write/edit，无需新增 gui_file 名称 |
| 工具定义和可执行 registry 都先放 built-in，再以扩展同名项覆盖 | `PI_LOCAL/dist/core/agent-session.js:2818-2833,2846-2860` | 不只改声明/提示词，实际调用路径也会替换；这些私有源码仅用于审计，产品不得 import 或调用 |
| 多个 Extension 同名时，第一份注册优先；不能假定后加载的 GUI 扩展获胜 | `PI_LOCAL/dist/core/extensions/runner.js:410-430` | 冲突必须检测、拒绝覆盖不兼容第三方实现，不靠调整顺序偷抢工具 |
| 官方 ToolDefinition 包含 execute 和 executionMode；getAllTools 返回 sourceInfo | `PI_LOCAL/dist/core/extensions/types.d.ts:486-494,1246-1256,1541-1548`；`agent-session.js:1074-1084` | 在执行入口拿最终参数；用来源确认当前生效实现，不仅核对名称 |
| Extension loader 的 registerTool 更新 registry；包装器将 ctx/参数送入 definition.execute | `PI_LOCAL/dist/core/extensions/loader.js:231-240`；`wrapper.js:12-20`；`tools/tool-definition-wrapper.js:2-12` | 可以直接委托本机公开 createWriteToolDefinition/createEditToolDefinition，保持 schema/渲染/参数处理 |
| write operations 支持 writeFile/mkdir，edit operations 支持 readFile(Buffer)/writeFile/access | `PI_LOCAL/dist/core/tools/write.d.ts:17-28`、`edit.d.ts:29-42`；实际使用见 `write.js:30-47`、`edit.js:92-126` | 在真实字节读写边界注入证据，而非从工具 args 猜 edit 的最终文件 |

**[待验证]** 以上为本机 Pi 1.0.4 的官方示例与实现证据，尚未执行端到端测试。公开导出在 Extension 的实际装载、同名来源回读、动态 reload、hook 改参数、嵌套调用、abort/错误后的结算必须在 P33.2 的真实 Pi 临时项目中验证；其他 Pi 版本必须能力探测。不允许通过同名覆盖未经确认就显示“捕获中”。本机 SDK 入口可用不等于 GUI 已实现该功能。

### 3.4 覆盖缺口

| 修改来源 | 当前识别能力 | 能否安全归因 |
|---|---|---|
| classic write/edit 成功 | 工具路径账本 + Git status | 只能证明触碰路径，不能证明具体差异 |
| write/edit 失败、取消、崩溃 | 不记或无 end；Git 刷新也可能不触发 | 否 |
| bash / PowerShell / 外部程序 | bash 成功可触发 status 刷新；PowerShell 不在 REFRESH_TOOLS | status 只能看到工作区差异，不能知道写者 |
| shell delete/rename、构建脚本、后台进程 | status 手动刷新后可能看到最终变化 | 无前态/因果关系；创建后删除可完全无最终差异 |
| MCP、自定义扩展、子 Agent、嵌套工具 | 有无事件取决于执行路径；账本仍只认 write/edit | 不可按工具名称或当前焦点推断写者 |
| 用户编辑器、Git 命令 | status 与 Agent 修改混在一起 | 否 |
| ignored 文件、项目外绝对路径 | status 不提供完整清单；账本能出现路径但项目归一会过滤 | 否，不应扩大 P33 授权到项目外 |
| runtime 所有上述修改 | scoped status 对 workspace 有效，runtime 会话账本为空 | 没有 per-operation 字节证据 |

表中事实依据为 `public/tools.js:54,154-168`、`public/changes.js:23-26`、`public/git.js:194-201`、`server/session-runtime.js:30-41`、`lib/git.js:381-487,919-920`；覆盖缺口为这些白名单/数据结构推出的限制，未声称已枚举所有第三方工具。

## 4. 现有撤销机制及风险清单

### 4.1 实际调用链

**单文件：** `public/git.js:778-828` 的 `restoreFile` 展示确认框 → `server/git-routes.js:94-99` → `lib/git.js:723-743` 的 `gitRestore`，校验路径、重新查 status → `applyRestore`（`:621-707`）。

**批量：** `public/git.js:906-949` 的 `restoreAll` 先取计划再确认 → `server/git-routes.js:75-83` → `restoreAllGit`（`lib/git.js:777-857`），再次读取**整个 workspace**的 status，最多 200 项（`:61,798-805`），串行调用 `applyRestore` 并返回 restored/kept/skipped。

**scope：** conversation header 只映射 workspace authority；没有证据 ID/Agent hunk/session 文件集合（`server.js:376-389`，`server/git-routes.js:77-98`）。runtime scoped Git 用 `workspace.root`，不仅仅是 conversation cwd 的子目录；这是当前行为，P33 的捕获范围应显式声明，不能暗自扩大。

| 文件状态 | 当前动作与证据 |
|---|---|
| 普通 tracked 修改/删除 | `git restore -- path`，旧 Git fallback `checkout -- path`；恢复自 index，`:699-707` |
| staged 修改/删除 | 无 unstage 则拒绝；授权后 `restore --staged`（fallback `reset -q HEAD -- path`），重读 status 再恢复工作区，`:651-696` |
| untracked 新文件 | deleteUntracked 授权后 `fs.unlinkSync(abs)`，`:627-636`；不是回收站 |
| staged 新文件 | 同时要求 unstage/delete 授权，取消暂存后删除，`:662-696` |
| rename/copy、merge conflict | 拒绝，`:639-648`；非暂存 rename 若表现为 D+?? 则可能被当两项分别处理 |
| untracked 目录 | 拒绝，不递归删除，`:625` |

**[事实]** 这条实现没有调用 `git clean`、`reset --hard` 或目录级 checkout；存在的是单路径 Git restore/reset/checkout 与 unlink（`lib/git.js:621-707,837-843`）。不能将“没用 git clean”解释为“安全会话撤销”。

### 4.2 风险分级

| 编号/级别 | 风险与触发条件 | 证据与结论性质 |
|---|---|---|
| R1 **严重：数据丢失** | index=H，用户先改成 U，Agent 再改成 A，点本会话行的撤销会回 H，U 也丢失；Agent 后用户手动改成 C 同样丢失 | `public/git.js:340,528,820-828`；`lib/git.js:699-707`。[推断：调用链直接决定] |
| R2 **严重：数据丢失** | 原本就存在的用户 untracked 文件被 Agent 触碰，撤销直接删文件；无法识别“Agent 新建” | `public/changes.js:50-60`；`lib/git.js:627-636`。[推断] |
| R3 **严重：范围扩大** | 会话过滤开启也不限制“全部撤销”，会恢复当前工作区其他用户/会话文件；二次请求可以纳入确认后新增变更 | `public/git.js:263-270,906-949`；`lib/git.js:788-791,837-843`；planned 只有布尔值，`server/git-routes.js:77-82`。[事实/推断] |
| R4 **高：暂存数据损失** | 确认 unstage 后把用户精心准备的 staged 内容退回 HEAD，再丢弃工作区版本 | `lib/git.js:678-696`。[推断；已有确认但非会话归因] |
| R5 **高：TOCTOU** | status/路径校验后、restore/unlink 前被其他程序写入或替换，操作无 expected digest/file identity 比对 | `lib/git.js:724-742,621-632,699-705`；`lib/safe-path.js:104-142`。[推断] |
| R6 **高：批量非事务** | 前几项成功，后几项失败；取消暂存成功后下一步失败也留下中间状态，无 journal/rollback | `lib/git.js:680-696,837-856`。[事实] |
| R7 中：UI 易误解 | 当前标题“Git 工作区 · 磁盘真实状态”、确认框明确提醒未提交改动丢失，但“本会话编辑”下仍有撤销，容易误认为按会话差异撤销 | `public/git.js:258,388-395,528,810-828`。[事实/产品风险判断] |
| R8 高：证据不足 | error 不计账、runtime 无路径、重启无账本；不能凭“列表里有/没有”作安全判断 | §3 所列调用链。[推断] |

当前不是隐蔽的“安全撤销算法有 bug”，而是**Git 文件恢复功能与会话安全撤销语义不同**。现有确认提示降低误操作概率，但不能保留用户修改。本轮仅标记，不修复。

## 5. 推荐技术方案与取舍

### 5.1 三种方案

| 方案 | 收益 | 缺点/结论 |
|---|---|---|
| session 开始时整树 baseline，结束后整体逆 diff | 接入简单，能看出窗口变化 | 混入用户/后台写入；整文件覆盖会丢失后改；shell 归因不成立。拒绝作为最终方案 |
| watcher + 每文件 first-touch baseline | 成本较低，可提示文件被外部改变 | watcher 会合并/丢事件、无写者身份，收到事件时 pre-image 已消失；只能辅助失效，不能证明所有权 |
| **实际 write/edit 证据 journal + 保守逆三方合并 + 双模式应用** | 明确 B/A/C、可审计、可恢复、复用 P32 身份；普通工作区能逐次确认后直接撤销 | 严格模式要求真正排他 provider；受限模式接受无法排除的外部竞态且明确告知。推荐，不把已知冲突或未知归因交给确认绕过 |

### 5.2 第一版明确能力边界

**[设计]** P33 最终交付必须包含普通本地工作区中可用的“备份后撤销（受限）”，不是只有 preview/export。第一版直接处理受控默认 write/edit 对已有普通文本文件的修改；Agent 新建且未被后改的普通文本文件在同卷条件下可移入私有恢复区。严格模式不满足排他条件则保持只读。两种模式共享同一证据/冲突判据，不能为了覆盖 shell、未知操作或同区域冲突降低资格。旧会话没有证据就是 `no_evidence`，不得从 transcript/HEAD 事后制造 baseline。

每条变化区分：

- `observed`：仅看到前后不同，不能归因，例如 shell/MCP 或普通 hook 窗口。
- `intent_verified`：同名受控执行器记录实际读取 B、最终目标字节 A，写前校验通过、实际写入及 post-read 与 A 相符；没有充分排除外部竞争。满足 §5.6 其他条件时允许用户确认的受限恢复，不能自动升级为严格保证。
- `exclusive_verified`：上述证据齐全，并由经过验收的执行器证明期间路径/文件排他性及实际写入。严格应用还须在撤销提交期间重新取得真正排他能力。
- `incomplete/unsupported`：前/后态缺失、失败未结算、类型/预算不支持，拒绝自动撤销。

等级是证据结论，不是工具名、成功返回或用户勾选的“可信”开关。对任意未纳管进程，不能证明排他性时不能宣称 exclusive_verified。受限模式的确认只接受残余并发风险，**不能**把 observed/incomplete、缺备份、冲突或未知 workspace 升格为可恢复。

### 5.3 默认 write/edit 如何进入证据系统

**[设计]** 使用仓库自带、通过官方 Extension API 显式加载的扩展，保留模型已经使用的 **write/edit 名称**。沿用 `server/process-bridge.js:54` 的私有 loopback/capability 模式与 `extensions/pi-gui-process/index.js:22-35` 的注册方式；在 classic/runtime 的 launch 注入扩展，复用 `server/rpc-bridge.js:320-336` 的扩展准备边界。只用绑定安装包的公开导出，不改变 Pi 本体、不装全局包、不复制 edit 算法。

调用链为：**模型调用 write/edit → 官方 hook/参数处理 → GUI 同名 ToolDefinition.execute → 本机公开 createWriteToolDefinition/createEditToolDefinition.execute → 注入的 operations → 私有证据桥 → 实际文件 I/O → 结算 journal**。委托直接调用本次创建的 definition.execute，不能 `ctx.executeTool('edit', …)` 调回自身递归。每次调用创建独立 operations 闭包，绑定 owner/toolCallId/operation nonce，不能用模块级“当前操作”变量串并发调用。保留官方参数 schema、prepareArguments、promptSnippet/guidelines、结果结构与 renderer，避免改变默认 edit 匹配规则。

具体采集规则：

1. **进入 execute** 才绑定最终参数；普通 tool_call 仅用于未知工具/gap 提示，不作为最终路径证据。后续 hook 改路径后，实际 ops 收到的绝对路径仍需后端重新验证。capture identity 未绑定则不能开始受保护 mutation。
2. **edit.readFile** 读取原始 Buffer B，先持久化并校验 digest，再把同一份字节交给官方 edit 算法；保留 BOM/换行。**edit.writeFile** 收到算法实际生成的 UTF-8 字节 A，持久化 A，再重读目标并核对仍为 B/相同类型与身份，发现不一致拒绝写入，不把新 C 纳入 Agent 证据。
3. **write.writeFile** 在实际写前读取现存 B 或证明 absent，保存 B 与官方给出的 A，并完成 prepared journal；A 是明确的 Agent 写入意图，不是事后扫描混合快照。写前再校验，写后读取观察 P；P=A 且 journal 完整才记 intent_verified。P≠A、I/O 结果不明或路径发生变化标 incomplete/raced，不自动撤销。
4. B/A 对象写入、fsync、可读回 digest 校验和 prepared journal 均在实际写入前完成；备份失败的**已启用受保护写入**直接报固定错误并不写文件。不能悄悄 fallback 原始写入。abort 即使发生在写后，也要在 finally 等正在进行的 I/O 结束后结算，区分 `toolOutcome` 和 `mutationOutcome`；不能提前释放 queue。write 创建父目录不属于可逆文件内容，记为 untracked side effect，撤销时不递归删除目录。
5. 不在官方 withFileMutationQueue 外再套同一队列，以免重入死锁；backend 自己的 per-workspace mutation admission 只管理本桥的入场/排空。对外部程序仍无排他保证。capture 时 B→实际写入之间的外部改动仍可能被 Agent 原始写入覆盖；最后读/写之间无法消除的风险也应明确，而不是把受限撤销包装成给所有 Agent 写入加了 OS sandbox。

**默认接管与冲突处理：** GUI 在支持的 Pi 版本上随 launch 装载该扩展；首次启用内容备份时说明保存位置/保留期，用户无需改提示词或选 gui_file 工具。session_start、reload、每次工具调用前通过公开 getAllTools/sourceInfo 核对 effective write/edit 来源，在真实 execute 及 ops 中再带 nonce 握手。只看到两个名称或一条注册日志不算接管成功。保留用户工具 allowlist；原来禁用的 write/edit 不被强行激活。

若检测第三方同名覆盖、来源漂移、公开 SDK 不支持、扩展加载失败或备份容量不足：显示“未捕获/保护已暂停”，受保护 write/edit 不得继续无证据写；UI 可让用户明确关闭采集后继续原有聊天，但后续变更标不可撤销。不要静默移除用户扩展、改变其顺序、启用 no-extensions 或调用私有 registry。无法拦截未加载扩展的未纳管工具时，不声称阻断了它们；后端 UI 清晰取消会话覆盖认证，未证明调用只有 observed。

嵌套 ctx.executeTool('write'/'edit') 在官方 registry 路径下进入同名接管，按 toolCallId/parentToolCallId 去重；直接 fs、shell、MCP 内部 I/O 和其他进程不经过该路径。它们不因接管成功就自动获得资格，继续按 §5.4 处理。**[待验证]** 各生命周期时点的来源回读和真实接管必须用本机绑定 Pi 跑临时项目；本轮仅确认官方可用路径，未实现这些检测。

### 5.4 shell 等未知范围操作

不能靠解析 shell 命令准确预测重定向、脚本、MCP server、后台子进程写哪些文件。第一版不扫描整个磁盘、不为每条 bash 做整树快照。

未知副作用工具开始前设置 workspace 的 `attributionGap`；受控工具、managed process、nested 工具有明确声明才缩小失效范围。工具名称不认识也按 unknown，而不是默认 read-only。后台任务不能以 shell end 当作结束写入；存在未结算 writer 时 gap 保持。

可按预算扫描 workspace 元数据/采样前后摘要辅助报告，但这些只能称“观察到的变化”。watcher 提示变化可以使证据降级，没提示不能使证据升级。对 gap 影响范围内的既有文件证据，第一版取消严格应用与受限恢复资格；未知范围则保守污染整个 workspace 的未撤销证据。不试图用 mtime 排除外部写入。shell 的恢复路径是人工核对候选/原始快照导出，用户确认也不能绕过归因缺失。gap 不能仅因 shell end、mtime 稳定或用户点“已关闭”而消失；可在确认已终止已知 writer 后开始新的 evidenceEpoch，旧证据仍不可恢复，无法证明停止时新捕获也保持降级。

### 5.5 baseline 粒度与合并

session baseline 只供导航；每文件 first-touch B 是便捷索引；**每次操作的 B/A 原始字节与顺序才是撤销依据**。对象去重减少重复保存，不把三种 baseline 变成三个事实源。

记 `B_i` 为操作前，`A_i` 为操作后，`C` 为撤销时当前文件。逆三方合并以 **A_i 为 base、C 为 ours、B_i 为 theirs**；反过来以 B 为 base 会得到错误语义。只在内存/私有临时目录计算，绝不直接向工作区运行 `git apply -R`。

保守文本算法：以原始字节保存内容，支持严格可往返的 UTF-8（含 BOM）；按保留行结束符的 token 做有界 diff。计算 `A→B` 的 Agent 逆变化与 `A→C` 的外部变化；任一范围重叠、同位置插入、重复上下文导致映射多解、资源超限均拒绝该文件。使用唯一且精确的映射，禁止 fuzz、空白忽略和冲突标记写盘。可用 `git merge-file` 的结果作测试 oracle，但不能把 exit=0 当全部安全证明；生产第一版选择范围可证的保守合并，复杂情况降级。

例：B 已有用户修改 U，Agent 在另一段改成 A，用户之后在第三段改成 C，候选 R 仅消掉 Agent 段，保留 U 和第三段；用户之后改同一段则拒绝。若 Agent 替换了用户原有同一段，B 保留 U，在 C=A 且证据/写入闸门成立时可恢复 U；“用户原有内容与 Agent 同位置”本身不必然冲突，**后续分叉或归因不明才冲突**。

同文件多次操作按 workspace 全局序号记录，选中会话的操作逆序在虚拟 C 上逐条演算，全部可证后一次生成最终候选。中间存在其他 session 的操作时保留其变化；区域重叠、结果依赖被撤销内容、gap 或映射不唯一时整文件拒绝。即使字节能自动合并，也不能证明业务语义无依赖；可疑跨会话依赖默认拒绝。撤销记录作为新 journal 条目，重复 apply 返回既有结果，不能二次逆转。

### 5.6 严格安全模式与用户确认的受限恢复模式

两个模式均先要求完整可验证 B/A、正确 session/workspace 归属、无未结算 mutation/gap、类型/元数据/预算支持、唯一无冲突逆合并、当前 C 与预览一致及 durable C 备份。确认不能越过这些硬条件。严格模式额外要求 exclusive_verified 捕获证据及真正排他的撤销提交能力；受限模式接受 intent_verified，在普通本地文件系统进行逐次确认的直接写回。

**关键限制：Node 标准 fs 的“read/hash → rename”没有 compare-and-swap 语义。** 生命周期锁只能挡 GUI 的 archive/remove，文件锁只能挡遵守协议的写者；atomic rename 只保证可见性，不保证校验后的文件没变。二次 hash、mtime、暂停 Agent、让用户点“我关闭编辑器了”都不构成严格证明。O_EXCL 可防新建目标已存在，但不能解决父目录被替换、既有文件覆盖与打开旧 inode 的写者。

| 模式 | 前提与可承诺事项 | 不可承诺事项/用户流程 |
|---|---|---|
| **严格安全** | 真实排他 provider 覆盖捕获与提交区间；在其经过验证的本地/存储边界内，完整备份和无冲突候选才可应用 | 无 provider 就只读预览/导出；不能将普通 Node fs、Pi 队列或用户确认视为严格能力。第一版不承诺普通共享工作区有此 provider |
| **备份后撤销（受限）** | 默认工具实际 I/O 已记录 intent_verified；本 workspace 的 GUI mutation admission 已冻结并排空，Pi/已知 writer 停止且清理确认；当前 C 稳定检查/预览核对/备份完成；用户逐次确认后直接应用 | 保证保存已采到的 B/A/C 和遵守确定的拒绝条件；**不保证排除任意外部编辑器、已打开句柄、后台进程或父目录替换竞争，不保证零数据丢失或跨文件原子性**。未保存编辑器缓冲区也不在磁盘备份内 |

没有“自动降级并执行”：严格模式 unavailable 时可提供“查看受限恢复方案”入口，必须进入新的预览及确认；不能继承严格计划的确认。普通工作区的主要可用入口直接标注“备份后撤销（受限）”，不是让用户找到设置才能使用；默认不自动执行，也不记住本次风险确认为永久授权。

保留小型 `SafeWriter.capabilities/withExclusive` 接口供严格模式；provider 必须排除实际文件数据写入、路径/父目录替换、删除、新建及已打开句柄写入。不能证明其中一项就 unavailable。Windows share-deny 与 POSIX advisory lock 不能未经验证视为等价；第一版不为此引入 native 依赖/通用文件系统平台。**受限模式使用单独的 BoundedWriter，明确报告 exclusive=false；其可用性不依赖未来严格 provider。**

受限恢复每次确认文案至少包含：目标 workspace/会话、固定文件清单、将移走的新文件数量、C→R diff、备份已就绪和保留期；独立提示“请保存并暂停编辑器、终端和其他写入程序。程序会核对当前文件并先备份；仍无法完全排除外部并发写入，最后校验之后的新修改可能未进入备份并被覆盖。不会修改 Git 暂存区。”用户显式勾选已保存并暂停后点击“备份后撤销这 N 个文件”；勾选是知情确认，不是 OS 排他证明。焦点不默认落在危险主按钮；Escape/取消零应用。

**不可绕过的拒绝条件：** 归因仅 observed、B/A/C 不完整、备份不可读/不足/权限不安全、冲突或映射多解、known writer/Stop/cleanup 未完成、scope/路径/身份/元数据变更、计划过期、检测到最终校验不符、网络/不支持文件系统、unsupported 文件类型、跨会话依赖不明。不得增加 force、忽略冲突、无备份继续或“仍然覆盖”的受限选项。未知编辑器不可能全部枚举，用户确认仅承担未被检测到的剩余窗口风险。

### 5.7 文件种类与元数据

| 种类 | 第一版策略 |
|---|---|
| 修改普通文本（tracked 或原有 untracked） | 第一版可受限直接撤销，包括用户前置 dirty 修改、Agent 后用户在独立区域的修改、同文件多次操作。以 B/A/C 生成 R，绝不按 Git 身份决定删除 |
| Agent 创建普通文本 | before=absent 且 post/当前字节及元数据等于 A、有完整归因才允许受限“移入恢复区”。使用同卷私有目录、唯一目的路径的 rename，不 unlink、不删目录。用户后改任何内容均拒绝整文件移走；跨卷不做 copy+delete fallback，只预览/导出 |
| Agent 删除 | 默认 write/edit 不提供 delete 接管路径；shell 删除归因不明，第一版只读材料/导出，不直接重建缺失路径。即使其他工具提供完整 B/A 也先列 unsupported，避免推测默认覆盖 |
| rename | 第一版两个模式均不直接处理，提供有证据的双端预览；不能凭 Git similarity 猜归属，也不能拆两腿恢复 |
| binary/未知编码 | 原始字节可在预算内保存；第一版不做自动合并/写回，只导出，绝不 UTF-8 替换解码后回写 |
| symlink/junction/hardlink | lstat/各父组件检查；符号链接和多硬链接文件全部不支持自动撤销，不沿链接读取快照，不操作链接目标 |
| 大文件 | 超限不截断存成“完整证据”；明确 oversized，拒绝自动撤销 |
| 权限/ACL/owner/xattr/ADS | 只在小型平台元数据 adapter 能枚举、保留并回读验证的普通权限范围内直接恢复；POSIX 普通 owner/mode、Windows 普通继承 ACL 必须真实测过。显式 ACL、附加流/xattr、只读/特殊属性等未支持时拒绝，不能把 unknown 当 absent。临时候选元数据与 C 不符不得替换；不把 Git executable bit 或 Node mode 当完整 ACL |
| BOM、CRLF/LF、混合换行、末尾换行 | raw bytes+digest 保存；保留外部变化的 token；不能证明原样往返或全局换行变换与内容变化相交则拒绝 |
| staged/index、提交历史 | P33 永不 unstage/reset/add/commit；index 变更不属于本功能。存在冲突/类型/权限未解决则拒绝；候选可与 index 不同，UI 清楚说明 |

**正常使用的预计覆盖范围 [设计预期，非实测百分比]：** 开启采集后，普通代码/配置/文档的默认 write/edit 实际调用应全部到达证据边界；不能只覆盖 Agent 偶尔选择的新工具。满足大小/编码/元数据且没有 shell gap 的既有文件修改，预计是第一版受限撤销的主要可用范围，新文件再受同卷条件限制。常先运行 bash/PowerShell、构建或 MCP 写盘的会话覆盖率可能明显低于纯 write/edit，会在受影响证据上拒绝；不能拿默认工具接管率代替整会话可恢复率。

公开显示三个独立计数：write/edit 实际调用的接管数/总数、完整 B/A 操作数/接管数、本次选择可受限恢复文件数/全部变更数。分母应包含失败、未捕获和未知工具产生的已观察条目；无法知道全部磁盘写入时显示“全部变更数未知”，不得显示 100% 整会话覆盖。P33.5 给出真实 fixture/模型任务分布后再报告比例，本稿不捏造成功率。

### 5.8 保留 Git 文件恢复，明确语义与防误操作

现有 Git restore/unlink 能力见 §4，继续保留，但产品入口拆清：主入口“本会话撤销”走 P33，工具菜单“按 Git 恢复文件（丢弃整个文件未提交改动）”走原语义。会话筛选页不放无范围限定的“全部撤销”；Git 批量入口明确“恢复整个 Git 工作区”，在独立 Git 全部视图展示固定清单和暂存/新建影响，不以当前 session 过滤暗示安全。

安全/受限撤销失败后只能提示冲突、恢复材料或重新预览，不自动转 Git restore。Git 单文件确认明确恢复自 index；取消暂存时明确先退 HEAD，并且会丢失该文件全部未提交内容。未跟踪文件按钮叫“删除未跟踪文件”，区分于 P33 的可恢复移走；不显示“只撤 Agent 改动”。保留取消、已跟踪保留新文件等现有能力。

为防确认范围扩大，未来 Git 批量接口把 planned 布尔值升级为服务端短期计划 token，绑定 workspace、文件清单、status/index/当前内容指纹及选项；确认后新变化/新文件须重新计划，不能自动加入。任何 fingerprint 核对仍不构成 CAS，确认文案保留其破坏性和并发残余风险。增加 P33 与 Git 操作共享的后端 mutation admission，防两个 GUI 恢复互相竞争；不声称它阻止外部 git/编辑器。两个功能复用既有确认基础设施，但 plan/token/API 不混用。

## 6. 数据模型及核心流程

### 6.1 最小从属存储

**[设计，均为新增]** `<PI_GUI_DATA>/revert-evidence/v1/` 中用私有 manifest/journal 和 SHA-256 原始字节对象；独立于工作区、Pi session schema 和 Git objects。最小模块为 `server/session-change-store.js`（持久证据）、`server/session-change-bridge.js`（默认工具接管/采集）、`lib/session-revert.js`（纯候选算法）、`server/session-revert-routes.js`（authority/计划）、`server/session-revert-writer.js`（普通本地受限应用、元数据探测与严格 provider 注入）。受限 writer 是必须交付的真实实现，不能只有拒绝 stub；严格 provider 可保持 unavailable。无需数据库、daemon 或第二套会话状态机。

```text
EvidenceScope:
  version, projectId, repoId, workspaceId, workspaceEpoch,
  conversationId, nativeSessionId, evidenceEpoch
Operation:
  operationId, parentOperationId?, workspaceSequence, scope, runtimeOwner,
  toolCallId, sourceKind, effectiveToolSource, evidenceLevel, state,
  before[], intendedAfter[], observedAfter[], toolOutcome, mutationOutcome,
  affectedRelativePaths[], attributionGapRevision
FileState:
  relativePath, kind(absent|regular|unsupported), blobDigest?, byteLength,
  fileIdentity?, parentIdentities[], supportedMetadata, metadataComplete
JournalState:
  prepared -> observed|committed|incomplete -> reverted
RevertPlan (private):
  planId, scope, journalRevision, operationIds[], gapRevision,
  mode(strict|confirmed_limited), currentFingerprints[], candidateDigests[],
  perFileResults[], backupReady, riskNoticeVersion, expiresAt
ApplyJournal:
  requestId, planId, mode, riskNoticeVersion, confirmationAt,
  preimageDigests[], candidateDigests[], quarantineLocators[],
  perFileState[], observedPostDigests[], completion, residualRacePossible
```

`fileIdentity`/时间戳是辅助判据，digest 是字节判据，二者均不能替代 OS 排他性。workspaceSequence 由 store 串行分配，避免不同 session 自己计数造成次序冲突。原始参数/工具结果不持久化；存经过验证的必要路径/内容证据及固定错误码。对象正文不可进入 SSE、Activity、日志、错误、默认诊断导出、localStorage。

采集目录权限必须真验证：POSIX 0700/0600；Windows 验证有效 ACL 限当前用户，不能把 mode=0600 当 Windows ACL 证明。禁止 symlink store、越界对象路径、digest 拼接穿越。初次启用明确说明保存项目内容；秘密/排除路径不采正文，证据标不可用，不能假装可以安全撤销。用户明确选择导出的内容也应有范围预览，不默认打包整个快照库。

### 6.2 采集、预览、应用

1. **采集准备与结算**：按 §5.3 同名 execute/ops 记录 B、intended A、post P 和来源，不从成功 result 造 A；B/A/prepared journal durable 前不得进行已承诺受保护的 write/edit。完整证据只能证明实际意图和已观察结果，不能抹掉外部竞态限制。
2. **只读预览**：重新取得 authority，在虚拟 C 上逆序演算 R。只回相对路径、固定理由、资格和受限 diff；正文预览需用户明确请求，不把 B/A/C 放进 SSE/诊断。严格/受限资格分别显示。支持 classic 普通本地项目，不能只接 runtime/worktree。
3. **准备恢复与冻结**：用户选择模式/固定子集后，后端关闭本 workspace 的受控 mutation admission，拒绝新 prompt/steer/follow_up 及 GUI Git 写入，排空正在进行的受控 I/O，复用 Stop 屏障并确认所有已知 writer 清理。不能先拿一个等待中工具所需的锁再调用 Stop，避免死锁。失败返回 busy、不进入应用。其他隔离 worktree 不必停止；不能因焦点变化把 gate 转到另一会话。
4. **当前备份和计划就绪**：重新验证 root/父组件/文件身份、类型/权限、journal/gap revision。对每个 C 以 raw bytes 采集，前后 stat/身份检查及再次读取比较发现变化就 stale；保存 C 的 blob+元数据并 fsync、可读回 digest 校验后标 backupReady。计算/核对 R，候选也 durable。只有可用 quota/ACL/本地 writer 条件确认后才让用户最终确认；backupReady 只指这个版本 C，不声称此后不再变化。备份/C 不一致就重新预览。
5. **最终确认**：token 建议 60 秒、单次，绑定 mode、scope、证据/gap revision、固定文件集合、C/R digests、备份引用和 riskNoticeVersion。显示 §5.6 的风险说明及 C→R diff，逐次确认。用户取消/超时释放 gate，不应用；不会把已知冲突变成可点确认项。等待确认不长期持有 worktree lifecycle lock，只持可超时的 admission gate；应用时重新取得 authority。用户在确认期间修改文件必须使 token 失效。恢复操作不会默认保存编辑器缓冲区。
6. **受限应用**：调用下述 BoundedWriter；严格模式调用排他 provider，无 provider 拒绝，禁止静默转模式。apply 一定先写 durable applying 日志，不能以 UI 确认为唯一记录。禁止 index/ref 写入。
7. **结果**：逐文件 `applied_confirmed_limited / applied_strict / conflict / refused / stale / not_applied / recovery_required`；总状态 completed/partial/refused，携带 mode 和 residualRacePossible。重复 requestId 读取既有结果，不重复执行。applied_confirmed_limited 只表示我们执行并验证了目标结果，不表示没有外部数据损失风险。

**BoundedWriter 的具体边界（P33.4 必须实现并实测）：**

- 已有文件修改：在目标同目录以 `wx` 创建唯一候选临时文件，写入 R、fsync，按支持的平台元数据规则复制必要 mode/owner/ACL 并回读验证；保留 durable C 于私有库。临时文件、C 备份、apply journal 任一准备失败都不能触碰原文件。提交前再次打开/读取目标并核对 C digest、身份、父目录身份、metadata、证据 revision；不符就删除自己可证明拥有的临时文件并返回 stale。
- 对已经验证支持的本地文件系统，使用平台实测的单路径 rename-replace 提交，避免 truncate 后部分写入；目标替换失败不得 fallback unlink+rename、直接 writeFile/truncate 或 force。同目录只是避免 EXDEV，不证明没有竞争。Node rename 的具体 Windows/平台行为与 metadata adapter 必须测试通过才启用对应平台；支持范围之外返回 writer_unsupported。
- 新文件撤销：B=absent、C=A 且所有硬条件成立时，将文件 rename 到**同卷、当前用户私有、应用独占的唯一恢复子目录**，不 unlink。应用前准备目录/目的路径和日志，验证同卷及源/目的父身份，不能覆盖恢复区已有条目。跨卷拒绝移动，不做 copy+delete。事后若移入的实际对象与预期 C 不同，保留该对象与 C 备份、标 recovery_required，不静默删除或自动移回；旧打开句柄之后仍可能写入移走的对象，恢复区不能立即 GC。
- 提交后立刻回读目标（新文件移走则检查恢复对象和源不存在）及元数据，写 durable result；不符就停止整个批次并保存能读取到的 post 版本。不能只依赖 rename 返回 0。结果日志失败/后验异常属于 recovery_required，不能报成功。目录持久化能力/断电边界在平台验收报告中单列，不把进程 crash 恢复能力等同于断电事务。
- **明确竞态窗口**：外部程序可能在最后读 C 后、rename 前把原文件改成 D，随后 D 被替换且未进入 C 备份；另有编辑器可能继续写旧句柄或在我们后验之后保存旧缓冲区。最终 hash 相符也不能发现所有这类写入。受限模式减少并检测一部分竞争、备份已观察到的版本，但不能保证找回未观察到的 D。任何测试/文案不得把这一窗口描述为已被 token/哈希/原子 rename 修复。

classic 与 runtime 使用同一候选算法，但 authority 不能混用。runtime 复用 registry workspace identity→withWorkspace；classic 复用已有 activation/generation authority，并补会话切换 native UUID 核对。关闭状态用持久 scope 授权读证据，不能把 dormant 的 null owner 当有写权限。classic fork/branch 切换保留 provenance，但以新的 evidenceEpoch 和显式操作归属界定可选范围，不能把共享 transcript 前缀重复归给新 session。

### 6.3 多文件与崩溃恢复

默认全量 preflight：有一个冲突则本次**零应用**，用户可另建只含无冲突文件的计划。受限模式的子集按钮叫“仅处理这些无冲突文件（受限）”，不叫“安全文件”；token 固定该子集，不动态增加文件。

跨文件原子提交不是普通 fs 提供的能力。即使 preflight 全通过，I/O/磁盘故障仍可能部分完成；此时停止后续项，记录已应用和未应用项。rename 两端作为不可拆分组，第一版拒绝直接应用。**禁止无条件回滚已成功项**：回滚本身也是写操作。严格 provider 可以在其证明的排他区间、当前仍等于 R 时恢复 C；受限模式不能后台自动回滚，必须生成新的“恢复撤销前备份”计划，先备份新的当前 D、核对 D、展示 D→C 并再次确认相同残余风险；D 已变化也不能以旧确认覆盖。新文件恢复区对象若移回，目标已存在则拒绝覆盖，只允许导出到新位置。

应用日志按每文件 `prepared → replacing/moving → applied_verified` 转移，替换前先 fsync 中间状态；失败写 fixed reason，未知结果记 recovery_required。启动只读扫描：capture prepared 无可靠 post → incomplete；apply 日志在 replacing/moving 后中断 → 对比 C/R/恢复对象并标“观察到 R/观察到 C/其他版本”，不仅凭 hash 猜历史是否丢过数据，不自动重试写回，也不标无风险完成。提供 C/R/可得 post/移走对象的私有恢复材料及上述重新确认入口；记录损坏/丢 blob/权限异常只让相关 scope 不可恢复，不能退回 Git restore。新 backend/runtime owner 重新验证 workspace epoch，不沿用旧 token。

### 6.4 预算与清理

初始设计预算：单文件 2 MiB、单操作总正文 16 MiB/最多 32 文件、单 conversation 128 MiB、全库 512 MiB、默认保留 7 天、计划最长 60 秒；这些是待压测的初值，不是当前实现常量。读取/哈希流式并限并发（建议 2），diff 限 token 数、内存和时间（建议 2 秒），不在 UI 线程跑。超额标记不可撤销，不部分截断。

内容寻址去重，session 不复制整个 worktree；受保护 write/edit 的备份失败必须阻断该次写入，不静默降级。用户明确关闭采集后可继续原有工具，但覆盖状态变成 unavailable，不能提供本次撤销。GC 只删无引用对象；未结算操作、active plan、apply journal、待恢复 C 备份和移走对象必须 pin。配额已满而不能安全回收时停止新采集/应用，**不能先删恢复备份再声称写回安全**。成功恢复的 C 备份至少保留默认 7 天，并在确认时告知到期时间；recovery_required 不按时间自动清理，需用户处理。删除 worktree 不连带删证据；按保留策略提示过期与只读导出。SSD 安全擦除不作保证；长期保留与 ACL 风险必须告知。

## 7. P33.2 至 P33.5 实施计划

以下只规定未来修改范围、任务和门槛；未创建模块、未改 API、未运行测试。阶段按安全证据依赖串行，每阶段人工验收后进入下一阶段；不自动提交/推送/发版。

### P33.2：默认 write/edit 接管与持久证据

- **范围**：新增 `server/session-change-store.js`、`server/session-change-bridge.js`、`extensions/pi-gui-revert/index.js`；接线 `server.js`、`server/session-runtime.js`、`server/rpc-bridge.js` 的 launch prepare/dispose；按需扩展现有能力探测。不改 registry 身份 schema。新增 `tests/session-change-store.cjs`、`tests/session-change-bridge.cjs`、`tests/session-change-tools.cjs` 并进入 package.json 的 npm test 链。
- **任务**：官方同名 registerTool + public create*ToolDefinition/operations 接管默认 write/edit；per-invocation 闭包、B/意图 A/post P、toolOutcome/mutationOutcome、来源检查及 reload、owner/gap、预写 durable、abort/异常 finally 结算；预算/ACL/重启恢复。必须真正执行默认工具链，不能只接 hook 或注册无人使用的新工具。此阶段只采集、没有撤销 API。
- **数据/API**：私有 begin/read/write/settle capability 与 nonce；public GET evidence summary 只含 ID、相对路径、来源已验证状态/等级/固定原因、revision；新增 captureReady/paused 摘要，无备份正文出口。
- **兼容**：保留官方参数处理、错误/结果、渲染和 allowlist；third-party 同名覆盖不静默抢占。hook/公开入口缺失或来源不符显示 unsupported，受保护路径 fail-closed；用户明确关闭采集后原有聊天可继续但不可撤销。不重放历史补 B；Browser/Process token 隔离；打包包含 Extension，runtime/classic 均可接入。
- **测试**：tmp fixture 的默认 write/edit、同位置替换用户 dirty 内容、官方 edit 多 edits/BOM/CRLF、hook 改最终参数、nested/codemode、第三方覆盖、reload、跨 owner、写后 abort、对象损坏、ACL、超额/备份失败。真实 Pi 只在临时项目执行工具；模型是否真实触发默认工具与程序化契约测试分开报告。
- **验收**：默认命名 write/edit 的所有纳管测试调用 100% 到达实际 ops；B 精确等于官方 edit 读取 Buffer，A 精确等于实际交给 writeFile 的字节；接管失败不能报捕获成功，未支持调用明确计数。备份/日志失败时该次受保护文件零写；missing P 不升级；无正文/token/绝对路径泄漏；只有 fixture 中预期的 Agent 文件写入，真实工作区/index/ref 零修改。真实 Pi 接管证据缺失不能认证阶段完成；须重建并验证打包资源。

### P33.3：纯撤销候选与冲突预览

- **范围**：新增 `lib/session-revert.js`、`server/session-revert-routes.js`；最小 `public/api.js` 接入预览；新增 `tests/session-revert.cjs`、`tests/session-revert-http.cjs` 纳入 npm test。
- **任务**：B/A/C 逆三方合并、唯一映射、字节往返、同文件逆序、其他 session interleave、gap/预算；明确现有文本修改/新建移走资格，删除/rename/unsupported 拒绝；同时计算 strict 与 confirmed_limited 资格，不能把 strict unavailable 当全部功能不可用。
- **数据/API**：`POST /api/session-revert/preview` 接收既有 scope 或 conversationId、服务端 evidence IDs 和 mode，不收任意绝对路径；返回候选/拒绝原因、模式能力/残余风险、revision。最终可应用 plan 留到 P33.4 的 prepare（有 C 备份）生成；只读 preview 不得伪造 backupReady。
- **兼容**：Git diff/status 保持既有语义；没有 Git 也可处理可信 raw byte 证据；历史 Planner patch 不作为 B/A。候选 preview 不增加 raw tool payload 出口。
- **测试**：矩阵 1–9、17–21、33–35 的候选分支；独立区域属性测试、重复文本/同点插入、空文件、BOM/混合换行、non-UTF8、预算超时；分别构造 intent_verified 与 observed，确认两模式资格不同且用户确认不能越过 observed。
- **验收**：可证独立变化得到逐字节 R；相交/多解/未知归因拒绝，无 fuzz；反复预览 workspace/index/ref 全部原样；同位置前置用户内容在 B 被保留，后置同区域冲突被拒绝；旧证据 no_evidence，不能用 HEAD 补齐。

### P33.4：普通工作区的受限直接撤销与恢复

- **范围**：新增 `server/session-revert-writer.js` 的 BoundedWriter/小型元数据适配，扩展 routes/store、组合根 mutation admission；新增 `tests/session-revert-apply.cjs`、`tests/session-revert-recovery.cjs`、`tests/session-revert-writer.cjs` 纳入 npm test。不增加 native 依赖/通用存储平台。
- **任务**：§6.2 的 prepare→durable C/R/日志→逐次确认→最终校验→同目录候选替换/同卷新文件移入恢复区→post 验证；classic 普通工作区和 runtime/worktree 都能执行。实现固定子集、幂等、模式绑定、Stop/drain/gate、失败恢复计划/导出及 GC pin。严格 SafeWriter 默认 unavailable 不阻塞受限 writer 交付。
- **数据/API**：`POST /api/session-revert/prepare {scope,evidenceIds,mode,selectedFileIds}` 返回有 backupReady 的 planId；`POST /api/session-revert/apply {planId,requestId,confirmation:{mode,riskNoticeVersion,acknowledged:true}}`；`POST /api/session-revert/cancel {planId}` 或服务端 expire 释放 gate；`POST /api/session-revert/recover-preview {applyId,fileIds}` 后重新 prepare 生成恢复备份计划，export 独立。确认字段不是身份认证；后端仍核对已有 token/Origin/owner/scope。禁止 force/unstage/deleteUntracked 绕过安全门。
- **兼容**：普通支持的本地文件系统能 confirmed_limited 写回，无需严格 provider；不支持/网络盘/元数据不明只读降级。既有 untracked 文件不能当 Agent 新建移走；工作区变化/关闭/重启让旧 token 失效，不自动重绑定。
- **测试**：矩阵 10–16、22–30、36–40；用真实本地 fs/独立进程注入最终校验之前/之后写入、父目录/句柄竞争、磁盘满、备份 readback 失败、每个日志/rename 边界 crash；元数据实际枚举保留与同卷/EXDEV 分支。只在临时工作区执行，区分 Windows/POSIX、进程崩溃/断电假设。不能只测试虚拟 provider。
- **验收**：至少 Windows 普通本地工作区真实端到端完成：前置 dirty 修改保留、后置独立修改保留、同区域冲突零应用、同会话多次修改逆序、Agent 新文件同卷可恢复移走；每例 index/ref 不变、C 备份可逐字节取回。不具备实际写回而只导出即**阶段不通过**。严格缺 provider 拒绝，但受限有效计划必须可应用。最终检查前检测到的竞争必拒绝；检查后的不可消除竞争必须有独立测试明确展示风险/可恢复材料边界，不能列“零丢失通过”。日志/后验失败停止后续项，不自动回滚；恢复当前 D 先备份且重新确认。其他平台未证实则只禁该平台写回，不冒报跨平台完成。

### P33.5：产品交互与完整验收

- **范围**：`public/git.js`、`public/api.js`、runtime 选择接线、复用现有 modal/right pane；§5.8 的 Git plan token 需最小扩展 `server/git-routes.js`/`lib/git.js`，保留原恢复能力。仅局部样式；新增 `tests/session-revert-ui.cjs`，扩展 `tests/git.cjs`/scoped Git 回归，均走 npm test；扩展真实 Electron 场景与验收文档。
- **任务**：可见且完整的“本会话撤销”入口，含“备份后撤销（受限）”直接应用按钮、严格能力状态、C→R diff、风险逐次确认、已备份/过期/部分结果/恢复备份入口和三个覆盖计数。Git 恢复单独命名/清单/确认，安全失败不 fallback，Git 批量不跨确认加入新文件，session 视图没有含糊全部撤销按钮。
- **数据/API**：消费 capture summary/preview/prepare/confirmation/apply/recovery；mode/riskNoticeVersion 与 planId 绑定；Git API 用独立 token，不能拿 P33 确认调用 Git restore；选择/await 后核对 workspace generation、owner/selection epoch，renderer 不保存完整 B/A/C。
- **兼容**：classic、runtime、dormant、fork、关闭/恢复、后台会话均不能串线；不会为了显示历史启动 Pi；计划过期重新预览。
- **测试**：完整 npm test；真实 Electron 1280×800、1440×900、1920×1080、125%/150%，Tab/Escape/焦点返回、console errors、确认期间切会话/文件改动、close/restart/cancel/expire 释放 gate；真实 Pi 默认模型任务在临时项目通过原 write/edit 名称触发采集并由真实 UI 受限撤销。shell/MCP 无归因拒绝、Git 功能完整回归。
- **验收**：至少一个支持平台在普通非托管主工作区与受控 worktree 都有“默认工具实际修改→预览→备份→真实用户确认 UI→磁盘直接撤销→恢复备份”的完整证据，不用程序化 nonce 调用代替用户可用性证明。第一目标平台 Windows 必须完成；没有可用受限撤销就不能宣称 P33 完成。§8 矩阵逐项区分受限成功/拒绝/竞态风险、断言/skip/fixture/live/platform，截图和打包产物验证齐全；P33/Git 两入口不会互相误导，未认证平台及不支持类型明确标注。严格 unavailable 是诚实能力边界，不是受限功能缺失的免责理由。

## 8. 测试矩阵

以下均在 `os.tmpdir()` fixture，不能对真实用户项目调用撤销 API。表中“候选”是只读算法结果；场景 1–4、6、8–9、11、14–15 必须进一步在满足受限模式前提、用户逐次确认后真实应用，不能只验证 diff。严格模式只有 exclusive_verified 证据和真实 SafeWriter 才应用，否则拒绝；受限模式允许 intent_verified，但 observed/incomplete 永远不能被确认升级。当前只是设计矩阵，无已通过数字。

统一验证判据：操作前冻结 B/A/C 与元数据、完整目录清单；无外部竞争的成功结果逐字节等于明确构造的 R，非目标文件和 index/ref 的 digest 不变；拒绝时不产生本功能对目标的写入，若外部测试进程自行改动则以其预期 D 为准。受限模式必须验证已备份 C 可原样取回，但这不等于竞态窗口内从未采到的 D 可恢复。竞争测试独立记录各次 write 时点/marker、当前结果和备份集合，不能仅断言文本包含某行或 Git status 干净；严格 provider 的零丢失判据只适用于其已验证边界。

| # | 具体场景 | 预期 | 用户数据未丢失的验证 |
|---|---|---|---|
| 1 | H→用户 U→Agent 在另一区改为 A；C=A | 候选还原 U | R 与 U 全字节相等，含用户 dirty hunk；index=原 index |
| 2 | 干净文件 Agent 独立修改 | 候选消除该操作 | R=B 全字节，其他文件不变 |
| 3 | 用户先改第 5 行，Agent 改第 50 行 | 合并保留第 5 行 | R 精确等于用户前态，不只检查两行 |
| 4 | 用户先改某段，Agent 替换同段，无后改且证据完整 | 可候选恢复操作前用户段 | R=B；若只有 observed 则拒绝应用 |
| 5 | Agent 后用户继续改同段 | conflict，整文件不应用 | C digest 与原始字节不变；不写冲突标记 |
| 6 | Agent 后用户改不同段 | 候选只逆 Agent 段 | R 包含完整后改，与独立构造期望字节相等 |
| 7 | Agent 后用户自行还原 Agent 段 | already_reverted/no-op，或无法唯一证明时拒绝 | C 不变，不二次逆转 |
| 8 | 同会话连续三次改同文件，中间用户在别段编辑 | 逆序保留用户 gap 内容；若 gap 无法证明则拒绝 | 逐步虚拟结果与最终 R 校验，原 C 不被预览改动 |
| 9 | 会话 A→B 先后同 workspace、同文件不同段 | 有完整跨会话顺序才生成保留 B 的候选 | B 操作对应字节完整保留；仅 A evidence IDs 被消费 |
| 10 | A/B 同文件同段交叉改、或 B 内容依赖 A | 拒绝撤 A | 两会话全部 C 内容不变、理由为冲突/依赖不明 |
| 11 | A/B 不同 worktree 同相对路径 | 只对 A 建计划 | B 全目录 digest/元数据不变，不能跨 workspace token |
| 12 | shell 重定向、脚本 delete、后台持续写 | observed/gap，拒绝自动撤销 | 不把窗口变化算 Agent 所有；C 全字节不变 |
| 13 | 自定义 MCP/嵌套工具直接写文件 | unknown 或受控证据，不按焦点归因 | unknown 分支零写；managed 分支核验独立 operation token |
| 14 | Agent 创建新文件且无后改 | before=absent、同卷且确认后移到私有恢复区，不 unlink | backup=A 且恢复对象字节=A；源 absent，用户原有文件不在移走集合 |
| 15 | 用户原有 untracked 文件被 Agent 修改 | 按修改而非创建处理 | B 包含用户原始字节；禁止 unlink，拒绝时 C 不变 |
| 16 | Agent 新文件后用户又增一行 | 拒绝整文件删除 | 保留整个 C，不只保留新增行 |
| 17 | Agent 经 shell 删除用户 dirty 文件；当前仍 absent | 第一版拒绝直接重建；已有材料只能预览/导出，缺 B 显示缺失 | 不造 HEAD baseline，不向缺失路径写盘，导出仅限实际已存 B |
| 18 | 删除后用户重新创建同路径 | 拒绝覆盖 | 重建文件 C 原样、类型/身份不变 |
| 19 | Agent rename old→new，new 后用户编辑 | 第一版拒绝自动，双端材料 | old/new 当前状态与 C 一致；不拆两腿恢复 |
| 20 | binary / non-UTF8 / 超限大文件 | unsupported/oversized，只允许预算内原字节材料 | 不解码回写、不截断装完整；C digest 不变 |
| 21 | symlink、junction、hardlink、多级父目录链接 | 自动拒绝，越界不采正文 | 链接本体/外部目标均不变，外部目标无读取泄漏 |
| 22 | 在最终 hash 后、rename 前独立进程写 D | 严格无 provider 拒绝；受限可发生 D 被替换且未被观察，必须作为已知残余风险测试 | 精确记录 D 写入时序，核对 C/R/备份，明确标记 D 可能不在备份；不得宣称 marker 必保或零丢失通过 |
| 23 | 文件/父目录替换、大小写别名、同路径新 inode | stale/refused | 新对象/目录不被写，旧 token 不可复用 |
| 24 | prepared 后崩溃；提交后 journal 完成前重启 | incomplete/recovery_required，不猜成功/不自动恢复 | 当前内容不被重启覆盖；B/C backup digest 可验证 |
| 25 | 多文件两项安全、一项冲突 | 默认全拒；显式重新选择子集才处理 | 默认所有 C 不变；子集执行后冲突文件原样且范围固定 |
| 26 | 多文件提交中 I/O 故障，成功项又被用户改 | partial，禁止无条件回滚 | 用户新版本保留；各项 C backup pin，结果逐项准确 |
| 27 | CRLF/BOM/末尾换行/普通 mode/继承 ACL；另测特殊 ACL/ADS | 支持的平台精确保留后受限应用；未知/特殊元数据拒绝 | C/R/备份逐字节与权限逐一比较；未知不能当 absent，临时候选元数据不符不得替换 |
| 28 | 重复 apply、过期 plan、跨 session/旧 runtime token | 幂等或 stale 拒绝 | 无二次写入、无跨会话证据消费 |
| 29 | worktree 被移除/移动并在旧路径新建目录 | stale_workspace，只能读旧材料 | 新目录全部原样；不能按路径字符串恢复 |
| 30 | 磁盘满、快照坏块、GC/配额并发 | 停止采集/应用，保留 pinned 备份 | 无不完整 blob 被引用为完整；当前 C 与 index/ref 原样 |
| 31 | write 已写 A 后 abort 报错；另测 post 采集丢失 | 工具 error 与 mutationOutcome 独立；B/A/P 齐全且 P=A 可记 intent_verified，P 缺失则 incomplete | 不能因工具 error 漏掉已写磁盘；仅有成功/失败 result 不制造证据；finally 等 I/O 完成再结算 |
| 32 | 恢复旧会话、fork 共享前缀、无捕获历史 | no_evidence 或新 evidenceEpoch | 不从 transcript/HEAD 推断归属，不重复消费前缀操作 |
| 33 | 模型仍调用默认 write/edit，未被提示使用新工具 | 经官方同名覆盖到达 per-call ops 并产生 intent_verified | 实际 callback 次数/nonce、B/意图 A/post P、磁盘变化一一对齐；不能只验证注册日志 |
| 34 | 第三方更早注册同名工具、动态 reload 改来源 | 来源冲突/漂移取消捕获认证，不静默抢占或继续宣称受保护 | 无本桥 nonce 的调用不能得到可应用证据；用户工具配置未被偷偷改动 |
| 35 | hook 把 edit 的输入路径/内容改为另一项 | 实际 execute/ops 记录最终路径与官方产出 A | B 与真正读取 Buffer 一致，不把 hook 初始参数当修改证据，范围不符拒绝 |
| 36 | C 备份 fsync/可读回失败、quota 满、ACL 不安全 | prepare/apply 拒绝，不能无备份继续 | 当前目标字节/元数据不变，candidate 准备失败无 truncate fallback |
| 37 | 确认期间用户改独立段，或在最终校验之前写 D | stale，重新预览并备份 D 后才能重新确认 | 旧 token 零应用、D 保留；新的 C→R 不是沿用旧 diff |
| 38 | 模式切换、未勾风险、riskNoticeVersion 旧、超时/取消 | confirmed_limited 缺确认拒绝；strict 不静默降级；释放 admission gate | 无应用写入，无永久风险授权，正确 workspace 恢复发送/工具入场 |
| 39 | 新文件恢复区跨卷、目的已存在、旧句柄在移走后写入 | EXDEV/目的冲突拒绝，不 copy+delete；旧句柄风险如实记录并保留移走对象 | 原文件或恢复对象仍可读；移走对象变化不立即 GC；不覆盖已存在恢复条目 |
| 40 | Git 全部恢复确认后新增文件；P33 失败 | Git plan stale 不扩范围；P33 失败不 fallback Git restore | 新文件和原 C 保留，两个 token/API 隔离；保留原 Git 单文件/暂存/删除能力的明确授权回归 |

## 9. 尚未解决的技术风险

1. **受限模式仍有真实数据损失风险。** P32 lifecycle lock、最后 hash 和 rename 都不是 CAS。最后观察 C 后出现的外部 D 可能被替换且没有备份；后续保存旧缓冲区、打开句柄与父目录竞争也未被完全排除。确认、停已知 writer、持久 C 备份减少风险/提供恢复材料，不消除它。严格模式保持 unavailable，不能借受限模式宣传严格零丢失。
2. **默认工具接管已找到官方路径，但尚未实测。** 官方同名 override、公开 definitions/operations 和来源回读证据见 §3.3；真正装载/动态来源变化/参数准备/abort/嵌套路径须 P33.2 实证。hook-only 不达标，第三方同名工具不能强抢。恶意或任意直接 fs 扩展不在可信工具边界内，不能通过给 extension token 证明整个 Pi 进程可信。
3. **语义安全不可由文本合并证明。** B 会话可能引用 A 加入的 API，位置不同也可能依赖；可证明的是字节保留，不能保证撤销后工程仍运行。需要 diff 预览和用户验收，不能自动运行用户工程测试来补足归因。
4. **平台元数据、网络盘和链接复杂。** ACL/ADS/xattr、共享句柄、本地 rename-replace/同卷移动及目录 durability 必须实际验证。第一版以 Windows 普通本地文件为必交付目标；不能因为元数据 adapter 没做就把所有普通文件永远标 unsupported。特殊类型/存储保持拒绝，其他平台未验证则禁其直接恢复，不把 fixture 当平台证明。
5. **快照敏感性。** 原文件可能含密钥；私有权限/排除策略/显式导出不可省。不能把正文附到诊断；保留期与删除不等于介质级擦除保证。
6. **历史能力无法追补。** 当前会话没有 B/A，即使有 Planner patch 或 Git dangling tree 也不能证明来源/原字节。功能只对启用且完整捕获的后续操作提供证据。
7. **预算会降低覆盖率。** 大文件/复杂差异/unknown 工具可能频繁拒绝；必须公开覆盖范围和原因，不能为了提高成功率放松安全判据。
8. **本轮未做运行复现。** R1–R8 是源码事实与调用链推断，不是已经用真实用户数据复现的损失；没有新的 fixture/Electron/real Pi/压力/POSIX 通过数字。当前远端状态也未联网验证。
9. **受限恢复后的备份并不等于长期事务。** 断电可能影响尚未落盘的目录更新；磁盘损坏、用户清理数据目录、超期清理也会影响可恢复性。确认时显示保留期，recovery_required pin 不自动清理；支持平台明确记录 fsync/目录 durability 边界。

## 10. P33.1 / P33.1a 验收结论

**设计结论：现有功能不能保证撤销 Agent 修改时保留用户原有及后续修改。** 已定位整文件 Git 恢复、untracked unlink、会话过滤不限制批量范围、无 B/A/归因/CAS 的严重风险，代码位置见 §3–4。本阶段没有修复这些风险。

推荐复用 P32 owner/workspace authority 与生命周期，通过官方同名 write/edit 覆盖及 operations 注入保存实际 B/意图 A/post P；以 A 为 base 计算保守逆三方候选。严格模式要求真实排他能力；**用户确认的受限模式在普通工作区完成当前版本备份、最终校验与无冲突应用，并如实承认外部竞争残余风险。** 不能把 Git restore、整文件 session baseline 覆盖、未经校验反向 patch、watcher 无事件或二次 hash 冒充安全。

交付内容包含当前 HEAD 审计、新增官方接管证据、双模式技术方案、数据/API/确认及恢复流程、P33.2–P33.5 门槛、40 项测试矩阵和未解决风险。**最终 P33 不允许仅交付 export-only：Windows 普通工作区和托管 worktree 中必须有实际可用的受限直接撤销。** 证据缺失、冲突、备份失败仍硬拒绝；没有严格 provider 只限制严格模式，不取消受限功能。风险确认不是把不可恢复操作一律放行的开关。

### 10.1 P33.1a 本次改动与技术取舍

| 本次修订 | 取舍与理由 |
|---|---|
| §3.3/5.3 增加官方 tool-override 示例、registry 优先级、来源回读与 operations 证据 | 默认工具实际进入捕获，不依赖提示词或没人使用的 gui_file；保留第三方冲突/版本兼容门，未实测事项不冒称通过 |
| §5.2/5.6 从整体 export-only 改为严格/受限双模式 | 交付普通工作区可用功能；受限逐次确认残余竞态，严格保证不偷换为 hash 检查 |
| §5.7 明确直接修改/新建移走与预览导出的边界、三种覆盖计数 | 优先覆盖常见默认 write/edit；不以数字捏造 shell/删除/rename/binary 的覆盖，不因覆盖率压力放开未知归因 |
| §6 补 C/R durable 备份、模式 token、mutation admission、BoundedWriter、post 日志和重新确认恢复 | 实现正常文件实际应用及可恢复材料；不用 truncate/unlink fallback，不自动危险回滚，未采到的外部 D 无恢复保证 |
| §5.8/7 拆清 Git 语义并绑定固定批量计划 | 保留原有 Git 文件恢复能力，避免 session 筛选和全部恢复误导，不将安全撤销失败转为破坏性 Git 恢复 |
| §7/8/9 重写阶段验收，矩阵 32→40 | 默认命名工具真实捕获、普通工作区实际写回及真实 UI 成为硬门槛；并发竞争风险单列，不能把不可能的零丢失断言当通行证或永远不交付的理由 |

P33.1a 状态：仅更新原设计文档，等待人工验收；未开始 P33.2，未修改业务/测试/配置，未提交/推送/合并/发版。本文描述的是拟实施方案，不表示同名接管、受限撤销、备份恢复或平台安全能力已经实现/验收。
