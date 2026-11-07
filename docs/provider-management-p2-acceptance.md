# 供应商管理 P2 验收报告

设计基线 `docs/provider-management-rebuild-plan.md`（P2 行，Codex 负责，文件边界一致）。实现分支 `codex/provider-management-p2`，基于 main 合并 PR#59 后的 `61aba82`。本报告交付提交可用 `git log -1 --format=%H -- docs/provider-management-p2-acceptance.md` 查询。

## 1. 完成功能及源码位置

| 功能 | 位置 |
| --- | --- |
| CredentialSheet 受限输入窗（modal 子窗、独立非持久化 partition、显式隔离参数、固定本地文档 + strict CSP/nonce、提交守卫、延迟销毁与焦点恢复、深浅主题/窄窗） | [electron/provider-credentials.cjs](../electron/provider-credentials.cjs)、[electron/provider-credential-page.cjs](../electron/provider-credential-page.cjs)、[electron/main.cjs](../electron/main.cjs)（P2 区块） |
| sheet 专属 preload（仅 submit/cancel/status/onState + 只读 initial） | [electron/provider-credential-preload.cjs](../electron/provider-credential-preload.cjs) |
| 主窗口安全入口（open/cancel/status/onState，无密钥字段） | [electron/preload.cjs](../electron/preload.cjs) |
| backend 私有桥（epoch 握手、flow/nonce 绑定与单飞、维护互斥、capability 快照） | [server/provider-credential-bridge.js](../server/provider-credential-bridge.js)、[server.js](../server.js) 的 `provider-credential` IPC 分发 |
| 凭据生命周期（暂存/取消/清除/authorize-target，全程复用 P1 worker） | [server/provider-credential-bridge.js](../server/provider-credential-bridge.js) + [server/provider-credential-sdk.js](../server/provider-credential-sdk.js)（新增只读 `qualified()` 探测）+ [server/provider-credentials.js](../server/provider-credentials.js)（新增 `probe` 动作一行） |
| 发现网络基础（受限 transport、DNS/私网策略、重定向禁止、限额与真实 Abort） | [server/provider-network.js](../server/provider-network.js) |
| 授权绑定存储（consent 15 分钟 TTL、撤销、连接代次撤旧、内存 rememberTarget） | [server/provider-discovery-consent.js](../server/provider-discovery-consent.js) |
| 快照能力参数化（`desktopCapabilities` 注入；未握手恒关） | [public/provider-management/contract.js](../public/provider-management/contract.js)、[server/provider-management.js](../server/provider-management.js) |
| P2 专项测试 | [tests/provider-network-policy.cjs](../tests/provider-network-policy.cjs)、[tests/provider-credential-desktop.cjs](../tests/provider-credential-desktop.cjs)，经 `npm run test:provider-p2`（canonical 链 238 leaves） |

`PI_GUI_PROVIDER_KEY_INPUT` 仅供联调，**默认关闭**；与 `PI_GUI_PROVIDER_MANAGEMENT` 相互独立。

## 2. 实际安全边界

- **原文路径只有一条**：sheet 密码框 DOM → sheet preload → main（具名 handler）→ main↔backend 私有 `provider-credential` IPC → P1 worker 内存暂存。主窗口 preload 无 submit；HTTP/Web/SSE/日志/诊断/console 无原文入口；stage 成功帧的 nonce 即作废。
- **打开资格**（main 侧）：直属 backend 子进程 `connected`、非远程调试、非 `--no-sandbox`；backend 关闭/重启即 epoch 作废（flow/握手/暂存 dispose）。
- **提交三重校验**：main（sender/frame/固定 URL/nonce/TTL）→ 合同帧校验 → backend 桥（epoch/flow/nonce/草稿 revision/维护互斥）。
- **输入窗隔离**：独立 partition 无令牌；`protocol.handle` 只回固定文档；CSP `default-src 'none'` + nonce 脚本样式；导航/子框架/下载/权限/弹窗双端拒绝；`setContentProtection` 尽力防截屏（非绝对，如实声明）。
- **网络策略**：public 必须 HTTPS；私网/链路本地/元数据/CGNAT/IPv4 映射/未指定全拒；DNS 解析后逐地址分类、socket 钉桩只用已校验地址；拒绝一切重定向；GET-only 模型目录候选（≤8）、总时限 30s、单次 15s、4MiB、3000 模型；无秘密时 loopback 仅显式授权；错误闭集（无原始响应/异常；密钥不出现在 URL/日志/错误）。
- **consent**：绑定 draftId/revision/connectionRevision/(scheme+host+port+完整 basePath)/API/凭据来源与代次；撤销即时；rememberTarget 仅内存非秘密描述，启动必须重确认。

## 3. Electron 真机测试结果

`node tests/provider-credential-desktop.cjs`（Windows x64，本机 Electron 44.4.3 真窗口 + 直属 backend 子进程 + 真实 P1 worker 加假 SDK 1.5.0 包）：

- **阶段 A 桥模块：22 断言全过**（epoch/关闭/快照 门、prepare 绑定、互斥、nonce 重放、OAuth 二次确认、连接变化失效、cancel/close-draft/TTL）。
- **阶段 B 真 Electron：24/24 检查通过**（快照默认关、主窗无 submit 通道、HTTP 建草稿、open→sheet、固定协议 URL、CSP 禁 fetch、无 node/process 桥、导航拒、staged E2E 全链、受攻陷外部 renderer 三通道全拒、OAuth 窗内两次提交成功、主窗零哨兵、取消、浅色主题、窄窗与纵排、后端死降级）。
- 截图证据：`sheet-dark.png`、`sheet-light-narrow.png`（world/evidence，随测试产出）。
- 环境适配如实记录：本开发机执行器的 Windows 受完整性令牌无法启动 Chromium 沙箱，测试按仓库既有 live 测试惯例（`tests/app-update-electron.cjs` 等）退 `--no-sandbox` 重跑；正常沙箱仍为首选路径。**打包产物运行资格会拒绝 `--no-sandbox`**（`isDesktopQualified` 检查命令行），该退路不影响生产。

## 4. 凭据泄露负向测试（均过）

- staged 后 `agentDir/auth.json` 不存在；取消不落盘。
- 受攻陷的外部 renderer（自带 preload 的 `evil` BrowserWindow）对 open/submit/status 三通道全部 `forbidden`；错误 origin 的帧被拒。
- 主窗 DOM/innerHTML 零哨兵（`sentinel-key-E2E-1`、`oauth-sentinel`）；模块/网络错误对象不经哨兵替换不出边界。
- 关闭/禁用/无 SDK 资格时一切动作 `unsupported`；快照能力未握手恒为 false。

## 5. 网络策略与取消测试（均过）

- 未授权目标/跨界路径/非候选路径 `policy_rejected`；loopback 授权嗅探密钥即拒；私网解析结果整体拒绝。
- 302 即拒；401/403/429 闭集映射不再自动重试；重试上限（候选 ≤8）；体大小截断；非 JSON 拒；挂起 → timeout，外层 signal → aborted（Abort 贯通 socket destroy，测试用不响应桩验证 promise 必 settle）。
- 真实 loopback socket 链路（`http.Server`）走通只读目录返回。
- DNS 钉桩断言：socket 只见过已校验地址列表。

## 6. Web 与异常环境降级

- Web/reused backend：`isDesktopQualified` 不满足 → open 返回 `{ok:false,code:'unsupported'}`；快照能力恒关（真机与打包烟测均验证）。
- 后端死亡：open 显式拒绝（真机构造）；重启后 epoch 重置自动恢复。
- 远程调试/`--no-sandbox`：资格拒绝（代码路径检查）。
- SDK 缺失/版本不符：`qualified()` false → staging 全链 `unsupported`。

## 7. 尚未验证的风险（如实列出）

- **正常沙箱下未在本机验证**：本机执行器无法启动 Chromium 沙箱（测试回退 `--no-sandbox` 完成）；沙箱开启时的窗口行为在正常桌面环境的实机使用中仍需确认。CI runner（标准沙箱）将运行本套件验证。
- 打包 exe 的**完整端到端输入流程**（双击 exe → 打开 sheet → 提交）未在本阶段验证：打包烟测只覆盖后端快照与能力默认关闭；前端管理界面整体属 P4。测试链的阶段 B 已覆盖同样的代码路径（源码版 Electron 真机）。
- 真实供应商（OpenAI/DeepSeek 等）网络发现未发生（无真实调用、无费用）；transport 的 TLS/证书与 CDN 重定向行为以 fixture 与真实 loopback 验证，未做真实公网探测。
- 同用户高权限进程/键盘记录/系统剪贴板的内存面风险保留（设计声明）。
- OAuth 同槽**替换**流程的最终落盘（persist）属于 P3 保存编排；本阶段只验证到暂存与暂存隔离。

## 8. P3 可以调用的真实接口

| 接口 | 说明 |
| --- | --- |
| `createDiscoveryTransport({ consentStore, timeoutMs, maxBytes, maxTotalMs, lookup })( { consentId, url, key, signal } )` | 绑定 consent 的受限 transport；成功 `{ok,source,models,truncated}`，失败闭集。key 由 P3 在 worker 内解析后传入，本层不解析凭据。 |
| `createDiscoveryConsentStore().issue/get/revoke/revokeDraft/revokeDraftConnection/matchRemembered/forgetDraft/dispose` | 授权签发与撤销；`matchRemembered` 供重开核对（目标+API+来源+代次全一致才认）。 |
| `createProviderCredentialBridge({ sdk, draftLookup, consentStore, mutationBlocked, maintenanceLocked, enabled, flowTtlMs })` 的 `handle(frame)` | 具名帧入口（同现有 server.js 分发）；`stage` 成功应答含该目标新 `consent`。 |
| `sdk.stageNativeLogin/stageClear/persistNative/clearNative/disposeDraft/inspect/qualified` | P1 适配器（未改动的主要合同；`qualified` 为新增只读探测）。 |
| `createProviderCredentialDesktop(...)` 的 `open/cancel/status`（经 ipcMain 句柄）与 `resetHandshake/dispose/openForTest` | 桌面侧生命周期；`openForTest` 仅测试/诊断。 |
| `/api/provider-management` 快照 `capabilities`（本次仅 desktop 四位可变）与 `providerManagementEnabled`/`PI_GUI_PROVIDER_KEY_INPUT` | 能力门由「管理路由开关 + 联调开关 + 私桥握手 + SDK 资格」共同决定。 |

## 交付与许可状态

- 开发完成（实现 `ed47000`、测试 `258d80f`、测试链 `22ed3ea`）。
- 完整 canonical（`npm test` 238 leaves）**未在本地全量运行**（定向回归见上，全绿）；按测试执行政策标注「待验证」，建议由本 PR 的 CI 完整证明。
- 推送：用户未说，未推送；QA/安全验收与合并均待用户独立决策。`providerKeyInputEnabled` 保持默认关闭，含独立安全验收前不启用。
