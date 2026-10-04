# Model Capability 实施计划

目标：按附件的模型能力范围实现统一数据层和能力感知 UI，不改变 Pi/Auth/Quota 的职责。

采用现有安全模型出口 `publicModel`，保留 legacy 字段，附加纯白名单 `capability`。
共享纯逻辑放在可直接由浏览器加载的 `public/model-capabilities.js`，`lib/model-capabilities.js`
作为后端入口，避免复制逻辑、额外静态路由或前端构建。合并按字段固定优先级
Pi → 用户配置 → Provider metadata；仅相同结构化 identity 合并，无证据 null。

- [x] 新建 `tests/model-capabilities.cjs`：先验证缺少统一模型和 UI 行为时失败。
- [x] 实现 normalize/merge/identity/安全投影；接入 models-api、Provider 配置和 SSE 模型出口。
- [x] 保留模型选择折叠和 RPC 队列，收口思考不可用、图片入口与发送防护。
- [x] 新增 UI、过期应答、旧配置与安全回归，加入 package.json 的 npm test 链。
- [x] 更新 README、architecture 与 model-capabilities 文档，说明证据及边界。
- [x] 全量回归、真实浏览器截图、离线重建、diff 安全检查后独立提交；不推送不发版。

验证命令：`node tests/model-capabilities.cjs`、`npm test`、`npm run build:app -- --rebuild`、`npm run test:app`。
视觉验收使用隔离 fixture，不启动真实账户或写入用户会话。
