# P25.2 状态恢复与稳定元数据

`server/rpc-bridge.js` 在发布生命周期事件前更新唯一 snapshot：
`state / bridgeInstance / bridgeRun / bridgeRevision / cwd / hasProject / error / hint / maintenance`。
`getState()` 将 state 映射为 bridgeState，并提供独立的 piRunning/pid；
子进程对象、PID、shell spawn 都不能证明 ready。启动后的私有 `get_state`
应答确认 RPC 就绪，数字 ID 应答继续留在后端。错误使用安全固定措辞。

`/api/status` 可独立恢复生命周期。新 SSE 连接同步重放至多 800 条历史事件，
再发不入 backlog、不带历史序号的 `bridge_snapshot`，随后加入 live stream。
历史生命周期标记 `_replay`，Renderer 不用它覆盖当前事实；run 和 revision
防止过期快照倒退。所有状态来源进入同一个 reconcile；每个 ready run 只 boot
一次，不重复读取历史或覆盖草稿。SSE transport 单独维护，仅表示浏览器与后端通道。
后端实例身份为随机非敏感标识；当前快照可以建立新实例，重置实例内序号与 boot
去重，避免后端重启归零被误判为旧 run。上一实例的 live 事件不能建立新实例。

启动/重启等待时，首次 status 读取之外在 10 秒、20 秒各补偿读取一次。
重复事件不延长期限，不做无限轮询，不自动重启。10 秒后提供重新同步、已有的
带确认重启、诊断三个入口。restart accepted 不代表 ready。

原生额度查询复用 Pi ModelRuntime 的 Provider descriptor 与私有 Auth worker。
worker 内解析凭据并调用已有 DeepSeek / OpenRouter adapter，仅规范化结果跨边界。
缓存身份为 SHA-256，不包含明文 key；额度超时/取消不终止并行 OAuth worker。
自定义 models.json 配置沿用后端解析；NewAPI 必须显式选择 adapter。
OpenRouter 展示的是当前 Key 额度，不是账户 Credits。存储类型不决定额度接口
能力：DeepSeek/OpenRouter 由私有 worker 调用 Pi ModelRuntime.getAuth()，最终
AuthResult 含 apiKey 才请求接口；OAuth 转换仍由 Pi 完成，无 apiKey 才 unsupported。
已存在但没有验证过 adapter 的供应商返回 unsupported。SiliconFlow 保持 unsupported。

普通会话列表按有效 header.createdAt、Pi header.timestamp、严格文件名创建时间
倒序；同时间或未知创建时间按稳定 identity 字典序。mtime/updatedAt/current 不参与。
标准 Pi pending 文件名与最终 header 使用同一时间，落盘前后顺序不变。
任意显式文件名且未落盘的 pending 无创建证据时保持未知；不伪造当前时间。
归档与取消归档恢复创建位置。搜索保留独立的相关性与更新时间排序。

回归入口：`npm test` 内的 bridge-state-recovery、native-provider-quota、
stable-session-order。真实 Chromium 夹具：P25_2_HARNESS=1 启动 visual-harness，
再运行 recovery-shot；它使用生产 SSE bus 验证 >800 事件后的新页面和重连。
