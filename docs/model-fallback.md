# 自动模型备用（P28）

项目设置的「自动备用模型」默认关闭。显式开启并添加至少一个备用后，按用户保存的
顺序尝试，每个 providerId + modelId 最多一次。可删除和上下移动，重复与主模型不允许
进入备用链；已经失效的条目保留并显示「模型不可用」，运行时跳过，不静默改配置。
使用既有 .pi-gui/config.json v2，v1 只读迁移为默认关闭，保存才写盘。

## 数据与职责

```js
// 项目配置，只保存结构化身份，不含凭据
fallback: { enabled: false, chain: [{ providerId: 'custom', modelId: 'example' }] }
// ErrorClassifier 的安全证据
{ class: 'rate_limited', retryable: true, reason: '当前模型触发限流',
  source: 'pi-assistant', statusCode: 429 }
// 运行态与记录，只有内存，不存 message/images 或原始错误
{ generation, originalModel, currentModel, attemptedModels, active, exhausted,
  phase, history: [{ from, to, reason, errorClass, source, statusCode,
    unconfirmed, startedAt, result }] }
```

共享纯分类、策略与运行态位于 public/model-fallback.js，lib/model-fallback.js 为后端入口。
复用现有 Model Capability，不复制目录、不猜模型名称。server/model-generation.js 只负责
主聊天生成请求归属与安全出口；public/fallback.js 是唯一自动切换协调器。
server.js 仅装配这些边界，Auth/Quota 仍由原模块负责。

## 错误证据与允许表

本机 Pi 1.0.0 的 RPC prompt 应答在预检查完成时返回 disposition；这不证明模型生成成功。
Provider 生成错误通常通过 message_end.message 的 stopReason=error 和 errorMessage 返回。
Pi 会先执行自己的自动重试、压缩和续跑；agent_end 只结束底层 run，agent_settled 才是
本次自动工作的收尾点。只在收尾时按最后 assistant 结果决定，原生重试成功覆盖早先失败。

Pi 的 pi-ai/utils/error-body.js 将 SDK 状态格式化为「429: body」或「prefix (503): body」，
部分 Provider 保留 SDK 的「429 body」格式；OpenAI/Anthropic SDK 使用固定 Connection error.
和 Request timed out. 文案。RPC 不保留 SDK status 对象，所以 GUI 在后端仅解析认识的
HTTP 前缀、结构化错误 code/type 和少量已核对的固定 SDK 文案。不会扫描任意位置的数字。
不认识的格式保持 unknown；这些支持范围不是所有 Provider 的统一错误协议。

| 错误分类 | 证据 | 自动备用 |
|---|---|---|
| rate_limited | 明确 429，排除认证/输入与额度错误 | 允许 |
| quota_exhausted | 429/402 + 明确 insufficient_quota / quota_exhausted / insufficient_balance 或已识别额度消息 | 允许 |
| provider_unavailable | 明确 502/503/504、固定连接失败/超时或 Pi network_error finish reason | 允许 |
| retryable_provider_error | 其它明确 5xx | 允许 |
| model_unavailable | 404 + 明确 model_not_found / model_unavailable | 允许 |
| auth_error | 401/403，优先否决 | 禁止 |
| request_incompatible | 400/413/422，图片/参数等不兼容 | 禁止 |
| context_overflow | 明确 context_length_exceeded 等上下文证据 | 禁止 |
| user_cancelled | aborted / retry cancelled / 用户停止 | 禁止 |
| unknown | 缺证据、泛化网络文字、普通 404、格式漂移 | 禁止 |

RemoteQuota 面板不是触发证据；不查询额度来决定切换。工具、本地文件、MCP、Skills、
Planner、Git、上传、登录、状态读取、会话切换和 Pi 崩溃均不属于可重放的生成请求。
context overflow 不自动切换，因为已有上下文和未知窗口不保证跨模型兼容；auth error
不自动切换，因为不能用备用 Provider 隐藏配置问题。P29 未在本轮实现。

## 请求归属、安全与状态机

仅独占的普通 prompt 参与。后端在 bridge 接受带 ID 的命令后记录 owner，不保存正文。
started 才形成生成归属；queued 无法独立归属 agent loop，handled 没有模型生成，二者
都沿用正常发送清理而不自动备用。以 / 开头的本地命令、Skill/模板不自动重放。
steer / follow_up 暂不自动备用：它们可能插入现有 loop，不能证明安全切模型。

```text
running
  → Pi 原生重试完成（agent_settled）
  → 成功：completed，清理原始输入/附件一次
  → 禁止/未知/已有输出：stopped，保留输入、附件与已有回答
  → 可重试：策略选候选 → switching
      → 现有串行 set_model 队列
      → 等待 get_state + get_available_thinking_levels
      → 核对实际身份、能力和请求归属
      → 用冻结的同一 message/images 重发 prompt → running
      → 未确认或 30 秒确认超时：stopped
  → 没有未尝试的合适候选：exhausted
任意用户 override / 身份改变 → cancelled
```

原始 message、images、prompt 类型、会话 identity、workspace generation、bridge run/
instance 只留在当前请求的闭包中。每次 await 后重新核对；结束即释放大正文/图片引用。
request ID 含窗口随机前缀，重复 SSE (_replay) 不触发任何自动动作。
set_model 和回读复用现有 model/workspace generation，不直接改 S.state.model。
后端额外验证 __fallbackOwner，旧自动请求在手动操作后不能再送进 Pi；该标记不进入 Pi wire。
出现其它 agent_start 也撤销备用归属，避免续跑与自动重放竞争。

后端在进入 SSE/backlog 前把 prompt 错误、assistant 错误、partial/error 快照、native retry
错误、agent_end、get_messages 与递归树 get_tree 中的 errorMessage 变成固定安全 reason。
历史树采用迭代遍历以支持深会话。原始 Provider body、headers、key/token 不进入新增状态或日志。
一般工具输出仍保持既有安全边界，P28 不声称能脱敏用户工具任意读取并输出的环境变量。

## 能力、输出与用户操作

当前请求的文本和图片要求使用已有三值 capability。明确 false 跳过，unknown 允许尝试
并记录 unconfirmed；同名模型跨 Provider 不合并。Pi 切换回读后再次检查真实能力。
toolCalling=false 不作为硬性淘汰：普通 Pi coding 请求的工具语义由 Pi/runtime 决定，
当前 metadata 不能可靠证明这次必须支持某个远端 tool calling 协议。

整个用户请求累计 hasVisibleOutput，文字、thinking、toolCall、工具开始均按已有输出/活动
处理；压缩和扩展异常也保守阻止备用。原生 retry 不清零它。部分输出后失败不重生成整答，
保留输出与错误。没有可归属的最终结果时不自动重试。

手动选择模型、stop、新建/分叉/切会话、切项目、重启或 bridge 生命周期改变都会立即
失效。停止按钮在等待备用确认时仍可用，不依赖 S.streaming。项目/会话/bridge 切换清掉旧状态卡。
同一输入与附件在开启备用时保留到最终成功，失败/耗尽保留供用户编辑或重试；成功只清理
原始那批附件，过程中新增的附件和修改过的输入保留。

成功后保持 Pi 实际使用的备用模型，不自动切回主模型。耗尽也保留最后实际模型，不循环。
状态条是轻量可展开记录，无自动 Modal，不创建复杂执行时间线。

## 验证与已知限制

tests/model-fallback.cjs 进入 npm test，覆盖纯策略、真实 Pi 事件形状、安全出口、
有序重放、能力回读、深树、stale、用户操作、附件与清理。截图使用离线 fixture 和真实 Chromium。

本阶段未用真实凭据逐 Provider 联调，分类只覆盖已识别格式。未提供 disposition /
agent_settled 的 Pi 版本不会自动备用；未知保持关闭路径。无法确认模型时停止，不继续猜候选。
普通 prompt 的 Pi input extension 可能再次执行，因此不能承诺扩展转换后的正文完全相同。
重放保留原始 GUI 请求，但 Pi 会为每次 prompt 追加自己的 user 消息，失败 user 不去重；
这会增加历史输入。本轮不修改 Pi 会话，不提供 exactly-once 远端请求保证。
界面刷新/关闭会取消内存中的备用流程，历史报告只展示 Pi 已记录的消息，不恢复自动重放。
