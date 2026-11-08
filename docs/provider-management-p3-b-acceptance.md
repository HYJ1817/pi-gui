# 供应商管理 P3-B 实施与验收记录

行为提交为 `313ec07c368c917b3e2ca39d1a6fbff6d9a468ad`，从 P3-A 的 `e6a7664de919e2a4f92e893363b3bf82d2b00ff2` 建立。该 A 提交在 PR #64 的 `pull_request` 工作流第 1 次运行通过 8/8 检查。核查时 PR 仍开放，远端 `main` 为 `726fede1f76ce19f557288a9f767538387fc1781`。[P3-A PR](https://github.com/HYJ1817/pi-gui/pull/64) · [基线 CI](https://github.com/HYJ1817/pi-gui/actions/runs/42496170887)

## 实现和合同

| 边界 | 实现 |
| --- | --- |
| 管理 API | 现有授权、撤销、发现、连接测试、轮询和取消路由接到发现服务。发现和连接测试返回 `202 {ok,operationId}`。取消以 URL 的 operation ID 定位，请求体 `requestId` 独立负责幂等。异内容复用 ID 返回 `request_id_conflict`。 [路由](../server/provider-management.js) · [合同](../public/provider-management/contract.js) |
| 操作生命周期 | `pending → running → success/failed/cancelled`。每个供应商单飞，全局最多 8 个在途操作。取消同步撤销准入，最多等 2 秒清理确认。未确认时返回 `timeout`，保留该供应商占位至匹配的 worker 确认或退出。旧窗口代次、旧序号、草稿关闭、连接变化、授权撤销、凭据或 worker 换代使旧结果失效。 [发现服务](../server/provider-management-discovery.js) |
| 连接证据 | HTTP 响应证明可达。合法目录响应证明目录可用，合法空目录为成功且 `count:0`。认证通过保持 `null`，因为目录可能无需认证。`inferenceVerified:false`，仅请求模型目录。401、403、404、429、超时、非 JSON 和其他受限 transport 失败使用固定码。 [证据投影](../server/provider-management-discovery.js) · [网络策略](../server/provider-network.js) |
| 授权与缓存 | 授权只认服务端草稿、精确目标和凭据绑定，TTL 15 分钟。同一授权的目录缓存 60 秒，`force:true` 绕过缓存。仅当前绑定可读缓存与结果。失败可返回同授权的 stale 候选，目录响应只投影候选，配置、手工模型与已有选择继续由 P1 管理。 [授权存储](../server/provider-discovery-consent.js) · [缓存与发布](../server/provider-management-discovery.js) |
| 原生凭据 | 桌面可信窗批准暂存或已存字面量 key。已存 key 需与权威配置的完整目标匹配。OAuth、命令、未转义 env 表达式、内置或未知原生凭据不进入目录请求。Worker 使用私有阶段代次或 Pi SDK 回读证据，密钥只在 worker 内组装请求头。共享准入位先于取消帧关闭，迟到 DNS 无法调用 requester。 [桥](../server/provider-credential-bridge.js) · [适配器](../server/provider-credential-sdk.js) · [Worker](../server/provider-credentials.js) |
| 无凭据与 env | 无凭据可显式批准 HTTPS 目标。无凭据 HTTP 仅限显式批准且所有地址均为回环。env 限审核过的目录 preset、精确 Endpoint、API 类型和指定变量；页面不能提供任意变量名。公开地址使用 HTTPS，保留 P2 的 DNS deadline、全部地址验证、socket 钉桩、TLS、拒重定向和 4 MiB 响应上限。 [网络策略](../server/provider-network.js) · [服务接线](../server.js) |
| 构建 | 源码直接加载模块 worker。Electron 和 SEA 打包共享同一私有 worker bundle，分别从私有资源路径和 SEA asset 读取。 [Electron 构建](../scripts/build-app.mjs) · [SEA 构建](../scripts/build-exe.mjs) |

P5 按现有合同调度授权后的 600 ms 防抖、轮询、取消及展示。P4 的 `discoveryModes` 仍为空，因为现有 controller 不能消费 202。后台只保存本进程的记忆描述，重开和重启均要求重新确认。无已审核绑定的自定义 env 发现保留手工目录路径。浏览器表单离开可用现有撤销和取消；桌面有私有 `close-draft`，草稿 TTL 也会回收操作。P3-C 接收 A 的配置收据和 B 的失效事实，继续完成 Runtime 同步。

## 回归和验证

修复前，新增 HTTP 回归在基线获得 `422 unsupported`。独立复核随后指出，仅靠候选列表不足以证明 `/v1` 和 `/v10` 的段边界。加入伪候选授权视图后，回归在 transport 校验处失败；旧请求序号也能重新占用发现槽。修复后，两项均通过，伪候选和失效序号没有调用底层 requester。

| 检查 | 结果 |
| --- | --- |
| P3-B 管理路由与私有 worker | `npm run test:provider-management` 96/96，零跳过。覆盖未授权 DNS/requester 零调用、完整路径、缓存命中及 60 秒边界、强制刷新、撤销、关闭及换目标、连接状态、取消幂等和无确认隔离。真实 worker fixture 验证暂存及存量字面量，挂起取消帧、DNS 中途替换凭据及换 worker 后请求计数不增长。 [路由测试](../tests/provider-management-http.cjs) · [Worker 测试](../tests/provider-credential-sdk.cjs) |
| P2 专项 | `npm run test:provider-p2` 网络 39/39、开窗 5/5。源码 Electron 在用户临时目录的权限拒绝路径 47/47，在权限合格的系统临时目录成功路径 50/50。网络套件保留 FIX-01 至 FIX-10 回归，并检查 OpenAI、Anthropic、Google 目录投影和段边界。 [网络测试](../tests/provider-network-policy.cjs) · [桌面测试](../tests/provider-credential-desktop.cjs) |
| OAuth、模型与安全 | `npm run test:auth` 109/109；`tests/provider-auth-runtime.cjs` 36/36；`tests/models-api.cjs` 50/50；`tests/server-security.cjs` 39/39；`tests/electron-guard.cjs` 123/123。 |
| 产物 | 从本机 Electron ZIP 离线重建。`npm run test:app -- --output-root …` 26/26，`npm run test:exe -- --output-root …` 49/49。桌面夹具分别驱动打包的 Electron 后端和 SEA，各 50/50，完成原生暂存、提交、清除及实际 loopback 目录请求。Electron 私有 worker SHA-256 为 `979da90155e12b71354e87e49cb5fc233439af64becdab4ad6cff2060204216f`，SEA SHA-256 为 `5bc26519b84af14887e283fae7bcfdfde77211d5285b0de6950cbc1203a96880`。 |
| canonical | 行为提交的五组本地回归共 241/241 条命令退出码为 0。core 165/165、UI 24/24、安全 27/27、native 4/4、故障 21/21。逐组记录已核对 SHA、状态和 `package.json` 展开的有序命令。计划摘要为 `17203f3fb0d3ffa839168ccbbe7ed2bacb02545d2542a3e33215c54346a21524`，日志在 `%TEMP%/pi-gui-p3b-313ec07-canonical`。 |

源码与两种产物的桌面夹具均先尝试正常 Chromium 沙箱，本机启动失败后使用既有 `--no-sandbox` 回退。正常沙箱仍待验证。真实供应商与真实用户凭据不在本轮测试范围。外部 Pi 或手工编辑仍存在文件见证与实际发包之间的竞争窗口。实际运行路径在发包及发布前核对凭据证据，不能把它解释为跨进程原子性。

完整回归的环境跳过包含 18 项缺少 `SeSecurityPrivilege` 的 SACL 场景，以及协作存储、候选采纳和日志各 1 项需要 symlink 权限的场景。这些断言仍待相应环境验证。

Claude Code 的第二轮定向只读复核覆盖 transport、发现服务及三个凭据模块，结论为通过，未发现可复现的 Blocker 或 Important。随后核对了生产装配的严格授权开关、撤销信号、私有桥的校验接线。输入窗取消清理的是窗口 flow，已签发的发现授权由发现撤销或草稿关闭管理。正常沙箱和独立完整验收仍待完成。

回滚可关闭既有 `PI_GUI_PROVIDER_MANAGEMENT` 开关并重启后端，内存授权、操作与缓存随进程释放。也可单独回退行为提交，保留 P3-A 已存配置与原生凭据。P5 开放入口前须验收 202 控制器、正常沙箱和恢复后重新授权。
