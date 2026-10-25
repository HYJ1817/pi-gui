# Z4-2 A4：Agent 建议来源研究与后端专项证据

本轮实际执行者为 **Codex 内置协作 Agent**；没有调用外部 Antigravity，也不将任务包文件名视为其执行证明。
只读源码研究以冻结契约 `0f2340ee6bfd492bc5dea4adb2008bb7cbe40b0f` 为基础；数据协议依赖主 Agent 的
`183aa39b38fc2d937c99655dd3783d625313e486`，本工作树 cherry-pick 对应 `797594d`。
本报告不声称真实 Pi、模型、外部 Antigravity、生产建议闭环或完整安全资格已通过。

## 结论

现有代码具备后端验证过的 owner、bridgeRun、runtime generation、原生 session 文件身份，
可以作为未来建议适配器的**传输与生命周期依据**。本轮检查的生产组合根、RPC、Runtime 与 Z3
投影中没有现成的 Z4 proposal 来源适配器。消息文本或 Z3 JSON 自述的 actor/sessionId 不构成来源证据。
Z4-2 应保持生产建议队列为空，明确显示未接入；fixture 只能验证受控测试链路。

## 源码证据

| 证据 | 当前行为 | 对建议来源的含义 |
| --- | --- | --- |
| `server/rpc-bridge.js:408-475` | 只处理当前 child、当前 cwd 的 stdout；有界 LF JSON 解码；最后以服务端捕获的 `bridgeRun:run,cwd` 覆盖上游同名字段 | transport run 来自后端闭包。正文里写 bridgeRun/owner 不会变成该闭包身份 |
| `server/rpc-bridge.js:455-460` | 后端私有请求根据 pending id 消费应答，不直接经 publish 流出 | 不能把普通公开消息中的 response/id 当作后端已确认请求结果 |
| `server/rpc-bridge.js:578-581` | 命令可带后端期望 `__bridgeRun`，检查后剥离再发 Pi | 未来生成请求需要捕获期望 run，并让重启后的旧请求失效 |
| `server.js:374-396`、`server.js:987-993` | Classic 组合根统一投影事件并附 `legacyOwner:primaryOwner()`；owner 包括 backendInstance、workspace epoch、bridge instance/run、session | Classic 来源应从这个后端位置捕获，不能从 Renderer 回传 owner 取得权限 |
| `server/session-runtime.js:80-110` | 私有 runtime 的 publish 检查 disposed/context.isCurrent；RPC request 前后都复核当前 context | 适配器应复用该有效性检查；不能从稍后重绘的聊天 DOM 提取权限 |
| `server/session-runtime.js:23-44` | Runtime tool 事件只保留 toolCallId/name/isError/run；toolResult 正文被置空；消息正文作为对话文本保留 | 当前安全投影之后不再有完整工具参数/结果，不能据它恢复结构化 proposal；不得为本功能扩大公开工具 payload |
| `server/runtime-registry.js:5,63-76` | owner 字段闭集，resolve 逐项匹配 backendInstance/project/repo/workspace/epoch/conversation/runtime/generation/session | 未来后台队列必须绑定完整 owner；只认 conversationId 不够 |
| `server/runtime-registry.js:129-137,175-179` | 旧 bridgeRun 事件丢弃；run 增长会更新 generation 并清理资源；事件封装服务端 owner+sequence | 可用来阻断旧 run 与旧 runtime 代次建议；sequence 是递增事件依据，不是模型可自述的身份 |
| `server/runtime-registry.js:182-205,399-412` | 私有 get_state 确认 session；scanner/adapter 证明定位器后保存 sessionId/locator/文件身份；historyTarget 只给后端 | 绑定应依赖这些定位和身份检查；原生绝对路径不进入 proposal/UI |
| `server/review-comment-authority.js:40-45,47-99` | Classic/Runtime 完整取证、workspace 生命周期锁、焦点/context revision/原生文件与目录身份复核 | 本轮 collab authority 包装此流程派生独立 key/token/opaque sessionId，避免另一套 owner 模型 |
| `public/runtime-store.js:38-77` | 拒绝 replay、backend/owner/generation/sequence 不匹配帧，然后拼接 text_delta 正文 | 前端投影具备展示防陈旧机制，但不是后端建议权限源 |
| `public/runtime-conversation.js:51-80`、`public/markdown.js:116` | Z3 从闭合的 pi-gui-viz 文本围栏生成展示卡片 | 围栏是可视化展示输入，不能凭 JSON 里的 actor/session 字段进入 Z4 队列 |
| `public/viz-integration.js:20-49`、`public/viz-panel.js:32-151` | 从卡片原始 JSON 打开展示面板，绑定当前 UI 会话/owner/generation 与存活消息 DOM | 适合展示/引用生命周期；不提供后端 proposal 来源证明 |
| `public/viz-schema.js:17-34,48-79` | Z3 目前支持 line/bar 的独立有界数据协议 | 本轮保持 Z3 schema/API 不变；Z4 graph/operation 不是它的第二个可接受 schema |

以上行号是本轮所读工作树的定位；未读取他人正在实现的前端目录，未假设上游 Pi 尚未检查的能力不存在。
“当前缺少适配器”只指本仓库此次检查的实际接线路径，不是对 Pi 所有扩展能力的否定。

## 下一阶段的最小可信接入点（研究建议，未实现）

1. 在后端当前 run 的已验证事件入口，接一个显式 allowlist 的建议提取器；明确允许的原生事件种类、
   assistant 角色及完整终值边界。不要用流式 text_delta 的半个 JSON 或 Renderer 复制的围栏作为最终建议。
   若采用工具产物，先确认真实上游形状和专用工具注册来源；不能只看 toolName 文本。
2. 发起生成时捕获完整 owner、authority token、opaque sessionId、documentId、baseRevision 与后端请求身份。
   建议信封中的 session/actor 由此后端上下文派生/核对，不能由模型文本获得权限。
3. 完整建议进入有界后端队列，先校验冻结信封及全部 agent 操作，再做只读 preview。
   不接整文档覆盖、不自动 accept、不写项目文件；HTTP 只引用后端 proposalId。
4. 项目/会话/focus/owner/backend/run/generation/epoch 改变即废弃旧排队和未完成生成结果；关闭面板也不保留旧 undo。
   重试保留可判定的 opId 内容与请求身份；混合重放/同 opId 异内容必须拒绝。
5. 接受动作重新取得 authority、核对 expectedRevision 与磁盘 CAS；冲突时返回明确冲突并保留原文档。
   用户触发重新生成应基于最新 revision，不自动重放旧建议越过冲突。
6. Z3 保留展示协议；未来若有显式 Z3→Z4 转换器，必须披露不可映射字段，走新文档/受控操作授权，
   不从 Z3 面板的本地配置写入协同权威文档。

## A1/A2 已实现边界

- 固定 `<dataDir>/collab-documents/<authority key>.json`，磁盘信封为严格规范 `{version:1,scope,doc}`。
  只依赖生产 `validateDocument/serialize/deserialize`；已保存日志不丢弃或自动迁移。
- 全局 `wx` 排他锁，最多 20 scope、512 目录项，每个 doc 最多 2 MiB（信封预算另加 256 bytes）。
  已观察文件消失、损坏、非法 UTF-8、非规范格式或异 session 均拒绝覆盖。
- 首建 null CAS/revision1；后续 revision 必须恰好加一；documentId/session 绑定保持。
  完全一致的已提交快照重试直接返回，不 rename、不改 inode/字节。
- 同目录随机 `wx` 临时文件、0600、完整写入、fsync、内容/身份复核、目标身份+完整字节快照重验后 rename。
  rename 是提交点；成功后不再抛一个“未写入”的后验检查错误。
- 数据/root/祖先目录禁止链接；root/data 绑定本 store 实例的目录身份；文件拒绝 symlink、hardlink、替换。
  写前后检查当前 authority。清理只移除身份仍属于本事务的文件，保留替换物/遗留锁/不确定材料。
- authority key/token/sessionId 分别从已验证 review scope 的 key/token 派生独立 SHA-256 命名空间，
  opaque sessionId 为 64 hex，不含原生路径。key/sessionId 可跨重开保持；token 随完整活 owner 变化。
  固定 collab_* 异常重新构造，不泄漏上游 message/detail/path。

## 专项验证（Windows / Node，临时 fixture）

| 命令 | exit | 场景通过 | 实际断言调用 | skip |
| --- | --- | --- | --- | --- |
| `node tests/collab-authority.cjs` | 0 | 24/24 | 68 | 0 |
| `node tests/collab-store.cjs` | 0 | 52/52 | 145 | 1 |
| `git diff --check` | 0 | 无空白错误 | 不适用 | 0 |

所有写入均位于 `os.tmpdir()` 独立 fixture。通过数不包含 skip。固定安全预期由实际文件读回验证，
不是用源码字符串或模拟成功代替落盘。最初两个套件都因新模块尚不存在而 exit1；
新增临时内容篡改回归在补守卫前明确失败（Missing expected exception），补守卫后通过。
测试开发中还发现/修复了读取中替换的错误分类和 Windows 打开 lock handle 阻止目录重命名的夹具可执行性：
锁的排他性来自 wx 文件存在，取 identity 后关闭 handle 仍保留锁文件，最终检查它的身份，故可真实测试目录替换。
生产日志重放测试曾误断言 duplicate 布尔字段，核对生产返回形状后改为 `status:'duplicate'`；这不是产品缺陷。

| 故障/拒绝矩阵 | 证据 |
| --- | --- |
| 两独立 store 的旧 CAS、不同 doc/session、非法 revision/schema | 拒绝且原字节保持 |
| 两真实 Node 进程争同一 CAS | 恰好 1 个 committed；另一个 conflict 或 busy，磁盘 revision2 |
| `process.exit(37)` 于 temp-written | 子进程 exit37；原文件完整；临时文件与锁遗留；重开可读旧状态、写入 busy |
| 外部 SIGKILL 于 temp-written | 等待子进程写 ready 后实际 kill；原文件完整；重开可读、锁仍阻止写入 |
| write/fsync/rename 的 EACCES、ENOSPC | 6 个故障注入场景；原字节保持，属于事务的 temp/lock 清理 |
| 真实 Windows FileShare.Read 占用目标 | rename 失败，原字节保持；释放占用后同 CAS 可成功 |
| flush 后 owner 失效、目标替换、同 inode 同 revision 内容改变 | 拒绝；保存原提交或外部写入物，不覆盖外部字节 |
| 临时内容篡改、临时/锁文件替换 | 拒绝；保留原文档及不属于本事务的替换物 |
| 读取中目标替换、root/data 替换、flush 后 root 替换 | 拒绝；新目录与旧提交不被错误覆盖 |
| 真实 hardlink、root/祖先 junction | 均执行并拒绝；链接目标保持 |
| Windows 文件 symlink | EPERM，单列 skip1；不计通过。目录 junction 与文件硬链接/替换用例已执行 |
| 损坏/truncated/未知版本/异 scope/非法 UTF-8/损坏日志/oversize/文件消失 | 拒绝写回并保留已有字节/外部移走文件 |
| scope/目录项容量、遗留锁与 foreign temp | 容量拒绝、不自动清锁、不采纳 foreign temp |

## 尚未证明与交接

- 本专项不运行完整 npm test、共享构建、Electron/UI，也不修改 package.json；由主 Agent 统一注册并执行。
  `server/` 源码更新需要主 Agent 重建后才会进入 App/SEA 产物；目前专项只证明源码。
- symlink 文件权限测试未验证；没有断电、介质损坏、真实 ENOSPC 或所有平台文件系统专项。
  fsync 临时文件 + rename 不等于已证明断电后的目录项持久化；没有新增目录 fsync 成功承诺。
- 路径级 Node IO 的最终检查与 OS rename 之间仍有系统调用级竞态；wx 锁约束本应用的协作写者，
  不提供对同用户恶意进程/父目录可写攻击者的 OS 级独占能力。0600/0700 也不被宣称为完整 Windows ACL 证明。
  发生不确定的遗留锁/材料后 fail closed，当前没有自动恢复或过期锁接管。
- 源码研究未调用真实 Pi/模型，不构成 Agent proposal 来源资格。完整 integration、独立功能/安全审查与用户决策仍由主 Agent 收口。
- 回滚边界：回退本后端提交并移除主 Agent 的集成接线；本轮不删除或迁移已有应用数据。
  未 push、PR、merge、tag 或 release。
