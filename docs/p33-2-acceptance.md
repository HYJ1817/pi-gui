# P33.2 默认 write/edit 接管与持久证据系统验收报告

日期：2026-10-08。范围：采集、持久化、来源认证和只读查询；没有实现撤销、逆三方合并、恢复写回 API 或正式恢复 UI。

本文的“确认”指本轮代码或运行证据；“限制”不因测试通过而消失。真实 Pi 工具测试使用本机实际绑定的 Pi 1.0.4，模型输出由 fixture stream provider 提供，不代表真实模型服务、真实账号或网络调用验收。

## 1. 开发前后的 HEAD 与工作区保护

- 开发前、开发后均为 `main`，HEAD `41a106d891f394b545d772b1bda69d67962de78a`。没有提交、推送、合并、发版、安装依赖、修改 Pi 安装目录或联网查资料。
- 开发前已有未跟踪目录 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/` 和设计文件 `docs/p33-1-safe-session-revert-design.md`，均保留。
- 设计文件开发前后 SHA-256 相同：`0D8352456B56AAEA1CEFB111E528CB73D2EE18E6EF941E57691A15D44E45B788`。本报告没有改写已验收设计。
- 会写盘的工具、Git worktree、崩溃、损坏、容量和权限验证均使用系统临时目录 fixture，没有用本仓库真实业务文件做工具写入或恢复测试。构建仅生成项目已有约定的 ignored 产物目录。
- 最终 `git diff --check` 无空白错误；Git 对两个已有 CRLF 工作副本给出下次归一化为 LF 的提示，不代表执行了文件恢复。

## 2. 本次修改文件列表

| 文件 | 作用 |
|---|---|
| `extensions/pi-gui-revert/index.js` | 官方同名工具接管、operations、B/A/P、来源检查、用户知情命令 |
| `server/session-change-store.js` | 私有 CAS、journal、配额、ACL、重启回放和资格降级 |
| `server/session-change-bridge.js` | 每次子进程启动的私有 capability、authority、路径策略和安全摘要 |
| `server.js` | classic / P32 接线、共享 store、只读查询、命令入场检查 |
| `server/router.js` | 已鉴权路由中的证据 GET 与异步命令 admission |
| `server/rpc-bridge.js` | 显式 Extension 参数、私有环境和生命周期失效 |
| `server/runtime-registry.js` | 向 adapter 提供当前真实 owner 的闭包 |
| `server/session-runtime.js` | 独立 runtime 的采集桥、入场和 dispose |
| `scripts/build-exe.mjs` | SEA assets 包含新 Extension；桌面构建沿用已有全部 Extension 拷贝逻辑 |
| `package.json` | 在唯一测试入口末尾加入三个 fixture 套件，无依赖变化 |
| `tests/session-change-{store,bridge,tools}.cjs` | 新增可移植、无需安装真实 Pi 的常规测试 |
| `tests/session-change-live.cjs` | 显式运行真实绑定 Pi 的工具分发、operations、真实 ACL 验证 |
| `tests/session-change-rpc.cjs` | 显式运行源码或打包后端与真实 Pi RPC 的接线验证 |
| `tests/gui-browser-stop.cjs` | 保留原有 9 个场景，增加 admission / disable 场景，共 11 个 |
| `tests/stop-barrier.cjs` | VM fixture 补齐真实依赖形状，保留原有 16 个场景 |
| `docs/p33-2-acceptance.md` | 本报告 |

没有修改 `public/`、Git 恢复逻辑、Pi session schema、原有工具 allowlist 或第三方 Extension 配置。

## 3. 主要实现架构

确认的执行路径：默认 `write/edit` → Pi 官方分发及参数 hook → GUI 同名 ToolDefinition → 公开 `createWriteToolDefinition/createEditToolDefinition` → 注入 operations → 私有桥 → store 持久化 → 实际 I/O → 独立 P → 官方最终工具事件结算。

Extension 在 `session_start` 仅替换当前 builtin 来源，展开官方完整 definition，保留参数 schema、prepareArguments、renderer 及官方 edit 算法。每次 execute 有 UUID 和独立闭包，不通过 `ctx.executeTool` 调回自身，不复制 edit 算法，也没有在官方 mutation queue 外嵌套同一队列。证据：`extensions/pi-gui-revert/index.js:103`、`:180`；测试 `late registration preserves official public metadata`、真实测试 `BOM/CRLF exact B/A/P and upstream diff remain intact`。

共享 store 使用一个串行 journal，从多个会话写入同一 workspace 时分配全局顺序；不新增第二套 session/runtime 生命周期。来源认证只表示当前 `write/edit` 的有效实现属于本扩展，不能推导整个会话或工作区没有其他写者。证据：`server/session-change-store.js:81`、`:170`，测试 `sequences are global across workspace conversations`。

普通用户仍调用 `write/edit`。采集默认关闭；通过 `/gui-capture enable` 进入现有 Pi 确认 UI，取消零启用；`/gui-capture exclude <相对前缀>` 排除路径；`/gui-capture disable` 有后端直接处理路径，即使扩展不兼容或 store 损坏也可以明确关闭本次采集继续正常使用。关闭设置无法持久化时，通过已有通知明确提示重启后再次关闭，不能假装保存成功。证据：`extensions/pi-gui-revert/index.js:208`、`server/session-change-bridge.js:76`、`server.js:880`；真实 RPC 确认与关闭测试。

## 4. 官方 API 接管验证结果

通过现有 `createPiLaunch` 解析实际绑定包，而不是假定全局 npm 路径；能力白名单暂为 **1.0.4**。新版本没有完成相同真实验证前不启用受保护接管。证据：`server/session-change-bridge.js:53`，真实测试入口 `tests/session-change-live.cjs:12`。

| 项目 | 本轮确认结果与证据 |
|---|---|
| 默认同名工具 | 实际 Pi dispatcher 调用覆盖后的 operations，真实 dirty / untracked / 新建 / edit 均产生 B/A/P；`tests/session-change-live.cjs:119` |
| 公开 factory | 从绑定包 `exports['.'].import` 对应的公开入口导入两个 factory；`server/session-change-bridge.js:181`、`extensions/pi-gui-revert/index.js:225` |
| 最终参数 | 后注册的 `tool_call` hook 改路径后，记录真实 operations 路径；真实测试 `later tool_call rewrite captures final operation path` |
| 同名优先级 | 真实 Pi 同名来源冲突被识别，不抢占第三方，启用时阻止冲突调用；真实测试 `real duplicate source fails capture qualification` 和 `enabled capture blocks actual duplicate dispatcher without evidence or mutation` |
| 来源读取 | 使用官方 `getAllTools().sourceInfo`，session start 和每次调用复核；`extensions/pi-gui-revert/index.js:45` |
| reload / resume | 真实 Pi reload 后接管有效；真实 session 文件 resume 后 native scope 正确；对应真实测试均通过 |
| 嵌套调用 | 真实 `ctx.executeTool` 进入覆盖工具，记录 child toolCallId；未被纳管的 parent 不伪造 parentOperationId，并保留 gap |
| 最终结果 hook | 工具写盘后结果 hook 改为 error，B/A/P 不变，最终 toolOutcome 独立改为 error；`tests/session-change-live.cjs:163` |

发现并处理的集成差异：从仓库/打包目录做 bare package import 不能证明解析到实际启动的 Pi，改为父进程绑定公开 exports 入口的 file URL，未导入私有 registry。另一个实际启动问题是 `session_start` 等待需要 RPC `get_state` 的握手会死锁：注册同步完成，启动握手不等待；每次受保护执行再次等待认证。源码和打包版真实 RPC 已证明启动可达 ready。证据：`extensions/pi-gui-revert/index.js:180`、`:225`，`tests/session-change-tools.cjs:56`，`tests/session-change-rpc.cjs:24`。

## 5. B/A/P 采集证据

`edit.readFile` 的有界 descriptor 读取返回原始 Buffer B，先持久化，再把同一字节交给官方算法；官方 `writeFile` 输出编码成实际 UTF-8 字节 A，prepared 完成才允许执行写入。`write` 先读已有文件或记录 B=null（absent）。写前校验路径组件、文件身份、原始字节；写后另开读取取得 P。证据：`extensions/pi-gui-revert/index.js:61`、`:124`、`:131`、`:159`。

以下均是临时项目真实 Pi 1.0.4 工具执行证据，非自制 edit mock：

- tracked 文件在 Git 基线后有 `user dirty\n`，B 精确为该内容，A/P 为 Agent 输出；没有把 HEAD 当 B。
- 原有 untracked 文件 B 为 `user untracked\n`；新文件 B=null；两者明确区别。
- BOM + CRLF 文件的 B 保留原始字节，edit 后 A/P 包含官方保留的 BOM/CRLF，官方 diff 正常。
- 连续操作、路径改写、reload、resume、实际文件 Extension loader 均执行 operations。
- 最终结果失败时磁盘仍存在已写内容，记录 `toolOutcome=error` 与 `mutationOutcome=written`，不以工具错误推断“未修改”。

以上由 `tests/session-change-live.cjs:126` 至 `:171` 逐项逐 Buffer 比较验证；fixture 的写后 abort、P 读取失败、预写失败、并发修改拒绝另见 `tests/session-change-tools.cjs:73` 至 `:91`。

`intent_verified` 只表示已捕获实际意图且独立 P=A；`toolResultObserved` 在最终官方 `tool_execution_end` 后才为 true。最终事件丢失不得伪造成功资格。没有 `exclusive_verified` provider；摘要始终注明 `externalConcurrencyUnexcluded=true`。证据：`server/session-change-store.js:184`、`:206`、`:217`；`eligibility waits for the final Pi tool result`。

## 6. journal 持久化与数据保护验证

结构简化为 `<PI_GUI_DATA>/revert-evidence/v1/objects/<sha256>` 与 `journal.jsonl`。单一 journal 自带 scope、workspace revision、sequence 和 hash chain，不另外维护可漂移的 manifests/journals 双索引。对象和 journal 在受保护 I/O 前 await 写入与 `fsync`；引用对象验证 digest 后才接受 prepared。证据：`server/session-change-store.js:64`、`:112`、`:148`、`:170`。

回放验证 hash chain、完整行、引用大小、digest 和私有权限；未完成 begun/prepared 或缺少最终结果的 observed 转为 incomplete，并追加 restart gap。截断、损坏和大于声明大小的对象 fail closed，不能在错误后继续声称保护成功。证据：`server/session-change-store.js:95`、`:126`、`:139`；测试 `truncated journal fails closed on restart`、`CAS deduplicates matching raw bytes and corruption fails closed`。

具体异常证据：注入 `ENOSPC` 时 prepared 不成立；独立 Node 子进程 prepared 后直接 exit(86)，重开 store 得到 incomplete；工具侧 `/before` 或 `/prepare` 失败不写目标，也不提前创建新目录；写后 settle 失败则报告采集失败，保留已有磁盘结果而不伪称完整。证据：`tests/session-change-store.cjs:228`、`:236`，`tests/session-change-tools.cjs:73`、`:80`、`:81`。

预算维持单文件 2 MiB、单操作 16 MiB / 最多 32 文件、conversation 128 MiB、全局对象 512 MiB；当前官方调用每操作一个文件。对象去重，孤立对象也计全局配额。另限制 journal 32 MiB，避免回放无限内存。7 天后证据不再具备后续资格；**当前没有自动 GC，原始快照不会在第 7 天自动删除**，知情文案已说明至少 7 天与不自动删除。达到上限时拒绝新的受保护写入。证据：`server/session-change-store.js:8`、`:119`、`:158`、`:188`，测试 `unreferenced private objects count against disk quota`。

回放性能 fixture：100 个 operation 复用 2 个内容对象，独立运行约 10 ms，对象 privacy 校验 2 次。该测试注入 privacy checker，只证明去重回放复杂度，不是生产 Windows PowerShell ACL 的性能测量；不据此承诺真实写入延迟。证据：`tests/session-change-store.cjs:244`。

## 7. P32 多会话兼容结果

完整 owner 包括 backendInstance/projectId/repoId/workspaceId/workspaceEpoch/conversationId/runtimeId/runtimeGeneration/sessionId；nativeSessionId 必须与实际 owner 一致。独立 runtime 的 owner 取现有 registry 当前闭包，不用 PID 或当前选中 UI 推断。证据：`server/session-change-store.js:6`、`:11`、`server/runtime-registry.js:153`、`server.js:838`。

新增 root fingerprint（root stat 的 dev/ino/birthtimeMs 摘要）只是已有 workspace authority 的附加拒绝条件，不替代 P32 identity，避免关闭/重启后同一路径被替换仍复用旧证据。证据：`server/session-change-bridge.js:62`，`workspace fingerprint prevents replaced-root evidence reuse`。

| 生命周期 | 证据与边界 |
|---|---|
| classic | 真实源码及打包 RPC 默认关闭、用户确认、关闭与摘要查询均通过；实际 classic repoId=null 合法 |
| managed runtime | 真实后端注册 fixture Git 项目、创建受控 worktree、启动实际 Pi，独立真实 owner/source 握手通过；`tests/session-change-rpc.cjs` |
| 两个 runtime / worktree 同名文件 | 真实 Pi 两个 session 并发执行、实际 Git worktree、各自字节与 scope 分离；`tests/session-change-live.cjs:174` |
| 切换 / native session 变化 | 调用前同步真实 nativeSessionId，旧 token 或错 session 拒绝；tools 与 bridge 套件 |
| 关闭 / reopen / generation | 关闭后通过 registry historyTarget + worktree authority 查持久摘要；旧 owner 不可命令新 runtime；新 generation 可读同一持久历史但不能 settle 老操作 |
| 程序重启 | 完整对象回放可读，未结算记录降级，不自动补造 B；store 与真实 store reopen 测试 |
| epoch / 根路径变化 | epoch 或 root fingerprint 不同不能复用；workspace authority 不可用则拒绝查询 |
| fork / 共享历史前缀 | scopeKey 包含 conversationId 和 nativeSessionId，不因共享 Pi 消息历史复制证据；这是模型/隔离测试确认，没有单独跑真实 Pi fork 命令 |

同一 workspace 未知工具建立单调 attribution gap，P33.2 **没有清除 gap 的接口**。shell/MCP/第三方/子 Agent/后台路径不纳入可信文件捕获，未知副作用不能因工具结束而消除；已有及后续 intent_verified 的“后续候选资格”都被 gap 取消。外部编辑器不能可靠观察，始终保留未排除外部并发标志。证据：`extensions/pi-gui-revert/index.js:186`、`server/session-change-bridge.js:198`、`server/session-change-store.js:188`；`unknown writer gap also degrades later verified captures`。

## 8. 完整测试命令、通过、失败及跳过

所有命令在 `C:\pi-GUI` 执行。常规 `npm test` 不依赖真实 Pi，真实安装验证另行显式执行。

| 命令/层次 | 最终结果 | 跳过 |
|---|---|---|
| 开发前 `npm test` | 原有 89 个套件链退出码 0 | 原有 session-search 符号链接权限场景 1 个 |
| 开发后 `npm test` | **92/92 套件链完成，0 失败，退出码 0** | 同一原有场景 1 个，未计入通过断言 |
| `node tests/session-change-store.cjs` | **35/35，0 失败** | 0 |
| `node tests/session-change-bridge.cjs` | **23/23，0 失败** | 0 |
| `node tests/session-change-tools.cjs` | **29/29，0 失败** | 0 |
| `node tests/session-change-live.cjs` | **18/18，0 失败**，真实 Pi dispatcher + fixture provider + 生产 ACL | 0 |
| `node tests/session-change-rpc.cjs` | **11/11，0 失败**，源码后端 + 实际 Pi RPC | 0 |
| `npm run build:app -- --rebuild` | 退出码 0，桌面入口约 234.9 MB，整包约 327.8 MB | 无测试断言 |
| `node tests/app-check.cjs` | **26/26，0 失败**，重建产物检查 | 0 |
| `node tests/session-change-rpc.cjs "dist-app\Pi GUI-win32-x64\resources\app\server.cjs"` | **11/11，0 失败**，最终打包后端 + 实际 Pi RPC | 0 |
| `git diff --check` | 退出码 0 | 无测试断言 |

常规新增共 **87/87**。92 是 package.json 中命令链的套件数，不是把各套件的不同粒度内部断言混加而成的“总断言数”。原有跳过来自 `tests/session-search.cjs:318`，本机无法创建其所需文件符号链接；新 tools 测试实际创建 Windows junction 并验证拒绝路径，二者不互相替代。

本轮曾出现并已处理的回归：一次引入 classic async send 影响 Browser Stop（5/9），已恢复同步 facade，把异步 admission 放在 router；一次 stop-barrier VM fixture 缺少新增依赖（9/16），补齐真实依赖形状；一次桌面 no-project 检查为 25/26，已在无项目时沿用原有提示与拒绝流程。最终 Browser Stop **11/11**（原 9 个保留，加 2 个）、Stop barrier **16/16**、desktop **26/26**，完整 npm test 重跑退出码 0。没有删除断言、屏蔽失败或把失败当原有基线。

本机运行日志位于系统 TEMP，未把原始工具 payload 或快照加入报告：`pi-gui-p33-baseline.log`、`pi-gui-p33-verified.log`、`pi-gui-p33-live-final.log`、`pi-gui-p33-rpc-final.log`、`pi-gui-p33-build-verified.log`、`pi-gui-p33-app-verified.log`、`pi-gui-p33-packaged-verified.log`。TEMP 日志不作为长期持久验收数据库，自动化入口和明确测试名是可复现证据。

关键测试矩阵（均执行，无新增跳过）：

| 场景 | 预期及验证入口 |
|---|---|
| 1 默认 write 接管 | 真实 dirty B/A/P；live |
| 2 默认 edit 接管 | 官方 BOM/CRLF edit 与 diff；live |
| 3 用户 dirty | B 等于用户 dirty，非 HEAD；live |
| 4 用户 untracked | B 非 absent；live |
| 5 新建 | B=null，A/P 相同；live |
| 6 连续修改 | 独立 operation 与递增 sequence；store/tools |
| 7 BOM/CRLF/LF | 原始字节逐 Buffer 相等；store/live |
| 8 hook 改路径 | 记录最终路径、原路径不误记；live |
| 9 嵌套 | 官方 child dispatch，未纳管 parent 保留 gap；live/tools |
| 10 并发会话 | 两实际 Pi session 隔离；live |
| 11 同名 worktree 文件 | 两实际 Git workspace 的 B/A/P 各自正确；live |
| 12 写后 abort | aborted 与 written 并存；tools/store |
| 13 写成功最终结果失败 | 最终 error 不抹除 P；live/tools |
| 14 prepared 后崩溃 | exit(86) 重开 incomplete；store |
| 15 损坏/缺失/截断 | digest/完整行校验 fail closed；store |
| 16 配额 | 超大 B、对象预算阻止受保护写入；store/tools |
| 17 Windows ACL | 真实私有目录及继承对象检查；store/live |
| 18 第三方同名覆盖 | 未认证且不执行目标写入；live |
| 19 reload | 真实 reload 后 operations 仍经过采集；live |
| 20 版本/能力缺失 | 无有效入口不伪造认证；tools/bridge |
| 21 shell/MCP unknown | workspace gap 持续，不清零、不恢复旧资格；store/tools |
| 22 显式关闭 | store 损坏时 launch 级关闭可继续且提示未持久化；bridge/tools |
| 23 重启 | 重新校验对象与重建索引；store/live |
| 24 旧会话 | 空摘要，不合成历史 B；RPC |
| 25 隐私 | token/origin 拒绝；摘要无 B/A/P/token/绝对工作区；bridge/RPC |
| 26 写前并发改动 | 拒绝 stale overwrite，external 字节保留；tools |
| 27 排除路径 | policy 在 open 与传输原始字节前拒绝；tools/bridge |
| 28 最终事件丢失 | 不授予资格，重启 incomplete + gap；store/tools |
| 29 ENOSPC | prepared 未成立，tools 预写失败不执行 mutation；store/tools 分层验证 |
| 30 路径替换/链接 | junction、hardlink、越界、ADS 拒绝；tools/bridge |

## 9. 真实 Pi 与打包验证结论

真实工具验收并非只有 Mock：使用 `createPiLaunch` 当前绑定 Pi 1.0.4 的公开 SDK、真实 AgentSession/Extension loader/dispatcher、实际工具 I/O、实际 Git worktree 和生产 Windows ACL；fixture provider 只控制工具调用输出，没有真实模型网络请求。真实工具 **18/18** 已证明默认工具实际进入 operations，B/A/P 与磁盘字节匹配。

另外源码后端与最终打包 `server.cjs` 各 **11/11**，覆盖显式 Extension 加载、ready/source 握手、真实确认 UI 请求、持久启用、后端关闭、managed runtime 启动、关闭后持久摘要和 stale owner 拒绝。桌面产物检查 **26/26**。这些不等于真实用户长时间并行模型任务或视觉 UI 验收；本阶段没有新增正式 UI。

## 10. Windows 实际验证情况

生产 store 使用 Windows 原生 ACL 读取/验证，当前用户 SID 为 owner，仅当前用户、SYSTEM、Administrators 的 allow 规则被允许；fresh root 设置受保护 ACL，子对象校验有效继承规则，不能拿 chmod(0600) 当 Windows 私有权限。写 raw bytes 前先校验 root、objects 与空目标文件权限。证据：`server/session-change-store.js:42`、`:52`、`:148`。

已实际修正 PowerShell 7 继承的 PSModulePath 干扰 Windows PowerShell 原生 ACL 模块的问题；子进程移除该变量，未改变用户环境。真实 native ACL 初始化、写入、回放通过。受信任的同用户进程、管理员和 SYSTEM 仍可访问该数据；ACL 不是恶意同用户进程 sandbox。

真实 Windows junction、hardlink、子进程退出、受控 Git worktree、Pi CLI RPC、桌面打包均有执行证据。POSIX 权限分支仅常规 fixture/协议覆盖，**本轮没有在 POSIX 主机做生产 ACL/fsync/打包验收**；Windows 文件符号链接的原有跳过另见 §8。

## 11. 已知限制、取舍及未解决问题

1. **没有零数据丢失或原子性的承诺。** 校验/哈希/官方队列与 GUI workspace authority 均不能排除外部进程在最后校验和 fs.writeFile 之间改动或替换父目录。原始 Agent 写入仍可能覆盖该窗口里的外部修改，P=A 也不能证明期间没有第三方写入。仅记录 intent_verified，未来受限恢复必须另做当前 C 备份、确认和失败恢复设计。
2. fsync 对象与 journal 已做，但没有证明跨文件事务、目录项持久化或突然断电时的存储设备行为；异常 journal/对象重启时拒绝使用，不自动修复或丢弃用户证据。
3. unknown gap 在 P33.2 不清除。常使用 shell/构建/MCP 的 workspace 即使后续 write/edit 捕获完整，也可能长期没有后续恢复资格。这是保守安全取舍，不以伪造新 epoch 提高覆盖率。
4. 默认关闭时普通工具可以写入，但没有历史 B，不能事后补造。启用不追溯已经发生的修改。支持版本暂限本轮验证的 Pi 1.0.4；不兼容时取消来源认证，已启用采集的普通 prompt/steer/follow_up admission 拒绝，用户可明确关闭继续使用。
5. shell、任意 Extension 直接 fs、MCP 内部写入、外部编辑器、后台进程没有实际 operations 捕获。恶意 Extension 与本扩展同进程可访问环境与同用户文件；私有 loopback capability 是路由隔离，不是隔离恶意同进程代码。加载失败时不能声称已阻断所有其他写者。
6. 新建父目录不构成完整文件系统事务，虽允许官方写入但证据标 incomplete/gap，不会为将来撤销递归删除目录。delete/rename 没有新增接管；二进制 B 可以原样保存，不代表已有二进制安全恢复能力。
7. 当前只记录内容与执行结果，尚无 P33.4 所需的完整文件 ACL/ADS/xattr/权限恢复 adapter。不能直接把当前证据视为允许任意元数据写回。
8. 原始快照至少保留 7 天且不自动删除；GC、journal 轮转、多实例同时打开同一 dataDir 的写者协调未实现。设计为一个 GUI backend 的一个共享 store，不能宣称支持多个 backend 共同写同一 journal。
9. 生产 Windows ACL 调用涉及 PowerShell，存在实际延迟；回放对内容去重，但未做完整大规模延迟/长期压力验收。配额扫描当前优先可审计与保守拒绝，不为性能取消隐私校验。
10. 单独的真实 Pi fork 命令、POSIX 生产验证、真实模型服务与长时间并发任务未执行；不纳入本轮已通过项。共享历史不复制证据的结构/隔离已测试，但不能替代未来真实 fork 生命周期补充验收。

本轮没有降低原设计的严格/受限恢复边界，没有用 git restore、整文件 baseline 覆盖或反向 patch 代替尚未实现的恢复功能。

## 12. P33.2 验收结论

**本轮达到 P33.2 的采集与证据系统验收条件，可提交人工验收。** 默认 write/edit 的真实 operations 接管、原始 B、官方 A、独立 P、预写持久化、错误独立结算、保守降级、P32 authority 隔离、重启回放和打包加载均有代码与实际测试证据。最终完整测试无新增失败，原有断言未减少；真实 Pi 工具接管不是仅凭 Mock 推断。

通过范围严格限于本报告；没有实现安全撤销，也没有证明排他文件写入或零数据丢失。所有 §11 限制保留，作为后续阶段的输入。本轮到此停止，等待人工验收，不进入 P33.3。
