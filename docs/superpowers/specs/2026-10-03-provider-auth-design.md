# P25 Provider / Authentication 设计

设计已由用户以“继续”确认。基线 c7b7b5d，Pi GUI 0.18.1；本机 Pi 1.0.0。

Provider 描述可供选择的模型与认证方法；Auth 描述 Pi 确认的本地凭据状态，不能推断远端有效性。GUI 仅接收白名单 descriptor，未知值保持 null。Pi 公开 ModelRuntime SDK 是认证入口；RPC 实测没有 login/logout，也没有刷新认证快照的管理命令。

认证 adapter 绑定主聊天 Pi 的 launch identity，动态解析同一安装包公开入口。隔离 worker 调用 ModelRuntime，由 Pi 保存凭据、处理 callback、PKCE、token refresh 和 API Key resolution。worker 输出先投影，stdout/stderr 丢弃。缺公开 API 时返回未知状态并提供官方交互式 /login、/logout 说明，不读写 auth.json 原文。

用户级 Auth Flow 独立于 workspace / Composer model generation，单航班运行，带 flow ID、prompt ID、revision 和取消信号。URL、device code、文本授权码、方法选择、进度、取消、超时、失败均采用闭合状态。秘密输入不进 renderer：API Key 原文改为在 Pi /login 配置，GUI 仅允许环境变量引用。

登录、退出及失败均重新读 Pi 状态。凭据变化后聊天 Pi 安全重载，保留当前会话；运行中延迟同步，不打断任务。切项目与相同 launch identity 的重启不重启认证；Pi 包身份改变使旧 flow 失效。模型、当前状态、思考档位继续由聊天 Pi RPC 回读，不由 SDK adapter 选择。

现有 /api/providers 与模型 RPC 的凭据字段改为白名单投影；配置保留原有磁盘密钥，不回显、不接受来自 GUI 的新原文密钥。OAuth Provider 不显示 Key 输入。多方法 Provider 展示 Pi 实际发现的方法，ChatGPT 优先 openai，legacy openai-codex 保留，不复制协议常量。

离线 fake SDK/provider 覆盖安全、24 类认证场景、模型同步及生命周期；真实 Chrome 截图验证灰阶状态与窄屏；完整 npm test、test:ui、Windows Electron 重建后收口，不 bump/tag/release。
