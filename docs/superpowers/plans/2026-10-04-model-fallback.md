# P28 Safe Model Fallback Implementation Plan

**Goal:** 用户显式开启项目备用链后，对无可见输出的可靠生成故障有序切换；Pi 确认后重放原请求。
**Architecture:** 复用 Model Capability 和项目配置；共享纯分类/策略/运行态通过 lib 入口导出。
后端只归属和安全化生成事件，前端协调器复用已有 set_model + state/levels 队列，不伪造模型。
**Tech Stack:** Node HTTP、原生 ESM、现有 jsdom/Chromium fixture；零新增依赖。

- [x] 纯逻辑测试先红：默认关闭、结构身份、去重/主模型过滤、分类闭集、能力过滤、一次尝试。
  `node tests/model-fallback.cjs` 应因缺少 P28 模块断言失败；新增纯 API 为
  normalizeFallbackConfig / classifyGenerationError / nextFallbackCandidate / createFallbackRuntime。
- [x] 实现纯规则和后端 createModelGeneration：仅 owned prompt、started、message_end、agent_settled；
  把错误变成固定 reason，覆盖消息快照/partial/retry/agent_end，工具与其它命令不参与分类。
- [x] 项目 config v2 增加 fallback，v1 只读迁移默认关闭，PUT 继续白名单和原子写。
  现有精确字段断言仅增加 fallback，不删除；增加异常/秘密配置与兼容用例。
- [x] 前端协调器冻结内存请求与会话/项目/bridge 身份，状态 running → switching → replaying →
  completed/stopped/exhausted/cancelled；现有模型切换返回 Pi 确认 Promise，旧应答不能重放。
  prompt queued/handled、steer、可见输出/工具活动、unknown、认证与上下文溢出均不自动重放。
- [x] 项目设置加入有序编辑器：已有 S.models、Provider 分组、能力摘要、移除/上下移、失效显示；
  默认关闭、至少一个备用、即时主模型/重复验证。状态条提供当前原因和轻量可追踪记录。
- [x] 新增真实事件形状集成测试：A→B、A→B→C、耗尽、附件一次清理、stale、stop、手动/项目/
  会话/bridge 失效，native retry 优先与流式输出禁止。进入 npm test 唯一入口。
- [x] 更新 README / architecture / model-fallback 文档；独立审查；真实浏览器截图；
  `npm test`、离线 `npm run build:app -- --rebuild`、`npm run test:app`、diff 检查后独立提交。

边界：不查网络资料、不推送不发版、不改 Auth/Quota，不改 Pi 或真实用户数据。
Pi 的每次 prompt 重放会留下自己的 user 消息，GUI 不改会话 schema；不把自动重放伪装为原请求没有执行过。
