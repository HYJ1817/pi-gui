# 供应商管理 P2 验收报告

设计基线 `docs/provider-management-rebuild-plan.md`（P2 行，Codex 负责，文件边界一致）。实现分支 `codex/provider-management-p2`，基于 main 合并 PR#59 后的 `61aba82`。本报告交付提交可用 `git log -1 --format=%H -- docs/provider-management-p2-acceptance.md` 查询。

**修订 2（独立验收修复后）**：首轮交付（`ed47000`…`011c7e0`，PR #60 CI run 42389222994）经独立验收发现 6 类问题，全部在本分支修复；修复内容见第 9 节。

## 1. 完成功能及源码位置

| 功能 | 位置 |
| --- | --- |
| CredentialSheet 受限输入窗（modal 子窗、独立非持久化 partition、显式隔离参数、固定本地文档 + strict CSP/nonce、提交守卫、四种 purpose 模式、延迟销毁与焦点恢复、深浅主题/窄窗） | [electron/provider-credentials.cjs](../electron/provider-credentials.cjs)、[electron/provider-credential-page.cjs](../electron/provider-credential-page.cjs)、[electron/main.cjs](../electron/main.cjs)（P2 区块） |
| sheet 专属 preload（submit/cancel/status/info/onState + getTarget/getPurpose 经函数跨桥） | [electron/provider-credential-preload.cjs](../electron/provider-credential-preload.cjs) |
| 主窗口安全入口（open/cancel/status/onState，无密钥字段） | [electron/preload.cjs](../electron/preload.cjs) |
| backend 私有桥（epoch 握手、flow/nonce 绑定与单飞、维护互斥、async capability 快照） | [server/provider-credential-bridge.js](../server/provider-credential-bridge.js)、[server.js](../server.js) 的 `provider-credential` IPC 分发 |
| 凭据生命周期（暂存/取消/清除/authorize-target，全程复用 P1 worker） | [server/provider-credential-bridge.js](../server/provider-credential-bridge.js) + [server/provider-credential-sdk.js](../server/provider-credential-sdk.js)（新增只读 `qualified()` 探测）+ [server/provider-credentials.js](../server/provider-credentials.js)（新增 `probe` 动作一行） |
| 发现网络基础（受限 transport、DNS/私网策略、重定向禁止、限额、真实 Abort、输出白名单） | [server/provider-network.js](../server/provider-network.js) |
| 授权绑定存储（consent 15 分钟 TTL、撤销、连接代次撤旧、内存 rememberTarget） | [server/provider-discovery-consent.js](../server/provider-discovery-consent.js) |
| 快照能力参数化（async `desktopCapabilities` 注入；未握手恒关） | [public/provider-management/contract.js](../public/provider-management/contract.js)、[server/provider-management.js](../server/provider-management.js) |
| P2 专项测试 | [tests/provider-network-policy.cjs](../tests/provider-network-policy.cjs)、[tests/provider-credential-desktop.cjs](../tests/provider-credential-desktop.cjs)，经 `npm run test:provider-p2`（canonical 链 238 leaves） |

`PI_GUI_PROVIDER_KEY_INPUT` 仅供联调，**默认关闭**；与 `PI_GUI_PROVIDER_MANAGEMENT` 相互独立。

## 2. 实际安全边界

- **原文路径只有一条**：sheet 密码框 DOM → sheet preload → main（具名 handler）→ main↔backend 私有 `provider-credential` IPC → P1 worker 内存暂存。主窗口 preload 无 submit；HTTP/Web/SSE/日志/诊断/console 无原文入口；stage 成功帧的 nonce 即作废。
- **操作模式由可信侧决定**：purpose 经 prepare 应答→ main → 有序 send + sheet 主动 `info()` 拉取；页面不自报（clear 窗口连密码框都隐藏，提交不带 input 也构不成 stage——之间是独立帧动作）。
- **打开资格**（main 侧）：直属 backend 子进程 `connected`、非远程调试、非 `--no-sandbox`；backend 关闭/重启即 epoch 作废。**SDK 不合格时 stagingEnabled=false → open 拒绝 set/replace/clear**（快照位与 open 门同时关闭）。
- **提交三重校验**：main（sender/frame/固定 URL/nonce/TTL）→ 合同帧校验 → backend 桥（epoch/flow/nonce/草稿 revision/维护互斥）。
- **输入窗隔离**：独立 partition 无令牌；`protocol.handle` 只回固定文档；CSP `default-src 'none'` + nonce 脚本样式；导航/子框架/下载/权限/弹窗双端拒绝；`setContentProtection` 尽力防截屏（非绝对，如实声明）。
- **网络策略**：public 必须 HTTPS；私网/链路本地/元数据/CGNAT/文档段/240/4/组播全拒（含 IPv4 映射十六进制写法还原分类）；DNS 解析后逐地址分类、socket 钉桩只用已校验地址；拒绝一切重定向；GET-only 模型目录候选（≤8）、总时限 30s（单次超时截到总剩余）、4MiB、3000 模型；无秘密时 loopback 仅显式授权；错误闭集（无原始响应/异常；密钥不出现在 URL/日志/错误）。
- **模型目录输出白名单**：只有 `id/name/contextWindow/maxTokens/reasoning/input` 六项可映射；条目含白名单外键（apiKey/headers/token/任意嵌套对象）**整条丢弃**；id/name 回显当前密钥的条目丢弃；字符串长度/控制字符/非对象条目过滤。
- **consent 失效**：transport 端核对 `credentialRevision`，与签发时不即拒（换 key 后旧授权不可用）；draft 关闭/连接变化/目标代次变化即时撤销；15 分钟 TTL。

## 3. Electron 真机测试结果

`node tests/provider-credential-desktop.cjs`（Windows x64，本机 Electron 44.4.3 真窗口 + 直属 backend 子进程 + 真实 P1 worker 加假 SDK 1.5.0 包）：

- **阶段 A 桥模块：24 断言全过**（新增：SDK 不合格快照关、capability 解析恒非 Promise）。
- **阶段 B 真 Electron：34/34 检查通过**（新增：clear 模式隐藏密码框/确认清除→clear-staged、authorize-target 模式展示真实目标/签发无密钥授权、全凭据 provider 授权 source 'none'）。
- 截图证据：`sheet-dark.png`、`sheet-light-narrow.png`、`sheet-clear-mode.png`（world/evidence）。
- 环境适配如实记录：本开发机执行器的 Windows 受完整性令牌无法启动 Chromium 沙箱，测试按仓库既有 live 测试惯例（`tests/app-update-electron.cjs` 等）退 `--no-sandbox` 重跑；正常沙箱仍为首选路径。**打包产物运行资格会拒绝 `--no-sandbox`**（`isDesktopQualified` 检查命令行），该退路不影响生产。

## 4. 凭据泄露负向测试（均过）

- staged 后 `agentDir/auth.json` 不存在；取消不落盘。
- 受攻陷的外部 renderer（自带 preload 的 `evil` BrowserWindow）对 open/submit/status 三通道全部 `forbidden`；错误 origin 的帧被拒。
- 主窗 DOM/innerHTML 零哨兵（`sentinel-key-E2E-1`、`oauth-sentinel`）。
- 模型目录恶意 fixture：apiKey/headers/token/嵌套对象条目整检丢弃；密钥回显条目丢弃；错误对象不含上游原始 body（`transport strips` 用例断言）。
- 关闭/禁用/无 SDK 资格时一切动作 `unsupported`；快照能力未握手恒为 false。

## 5. 网络策略与取消测试（均过，16/16）

- 未授权目标/跨界路径/非候选路径 `policy_rejected`；loopback 授权嗅探密钥即拒；私网解析结果整体拒绝；DNS 混入保留段（203.0.113.5）整体拒。
- hex 映射 `::ffff:7f00:1 / a9fe:a9fe / c0a8:101` 分类为 loopback/linklocal/private，大小写不绕过。
- 302 即拒；401/403/429 闭集映射；候选 ≤8；体大小截断；非 JSON 拒；挂起 → timeout；**总时限严格 30s**（专测：两次挂起 attempt 总耗时 ≤ maxTotalMs + 余量）。
- DNS 钉桩断言：socket 只见过已校验地址列表；真实 loopback socket 链路走通只读目录。
- **凭据代次轮换**：transport 传入新 credentialRevision 时旧 consent 串回 `policy_rejected`。

## 6. Web 与异常环境降级

- Web/reused backend：`isDesktopQualified` 不满足 → open 返回 `{ok:false,code:'unsupported'}`；快照能力恒关（真机「受攻陷窗口」与打包烟测均验证）。
- 后端死亡：open 显式拒绝（真机构造）；重启后 epoch 重置自动恢复。
- 远程调试/`--no-sandbox`：资格拒绝（代码路径检查）。
- SDK 缺失/版本不符：`qualified()` false → staging 全链 `unsupported`、快照 null。

## 7. 尚未验证的风险（如实列出）

- **正常 Electron 沙箱环境未验证**（开发机受完整性令牌无法启动 Chromium 沙箱，测试以 `--no-sandbox` 完成）。**该结果不作为正常沙箱安全的证据**；标准沙箱环境下的窗口/协议/隔离行为需在正常桌面环境或标准沙箱 runner 验证后才可视为已验证。
- 打包 exe 的完整端到端输入流程（双击 exe → 打开 sheet → 提交）未在本阶段验证；打包烟测只覆盖后端快照与能力默认关闭。测试链的阶段 B 覆盖同样的代码路径（源码版 Electron 真机）。
- 真实供应商网络发现未发生（无真实调用、无费用）；transport 的 TLS/证书与 CDN 重定向行为以 fixture 与真实 loopback 验证。
- 同用户高权限进程/键盘记录/系统剪贴板的内存面风险保留（设计声明）。
- 最终落盘（persist）属于 P3 保存编排；本阶段只验证到暂存与暂存隔离。

## 8. P3 可以调用的真实接口

| 接口 | 说明 |
| --- | --- |
| `createDiscoveryTransport({ consentStore, ... })( { consentId, url, key, credentialRevision, signal } )` | 绑定 consent 的受限 transport；`credentialRevision` 必须与授权时一致（换 key 后旧授权拒用）；成功返回已白名单化的 `models`。 |
| `pickModelList(json, secrets)` / `sanitizeModelEntry(item, secrets)` | 输出白名单；secrets 传当前密钥与请求头值。 |
| `createDiscoveryConsentStore().issue/get/revoke/revokeDraft/revokeDraftConnection/matchRemembered/forgetDraft/dispose` | 授权签发与撤销；`matchRemembered` 供重开核对。 |
| `createProviderCredentialBridge(...)` 的 `handle(frame)` / `desktopCapability()`（async，须 await） | 具名帧入口；`desktopCapability` 返回 Promise，provider-management 已按 await 接线。 |
| `sdk.stageNativeLogin/stageClear/persistNative/clearNative/disposeDraft/inspect/qualified` | P1 适配器。 |
| `createProviderCredentialDesktop(...)` 的 `open/cancel/status`（ipcMain）/`info`（sheet 主动拉取）/`resetHandshake/dispose/openForTest` | 桌面侧生命周期。 |
| `/api/provider-management` 快照 `capabilities`（desktop 四位）与双开关 | 能力门由「管理路由开关 + 联调开关 + 私桥握手 + SDK 资格」共同决定，快照路径全程 await。 |

## 9. 独立验收发现的问题与修复（修订 2）

| # | 原有问题 | 原因 | 修复 | 测试 |
| --- | --- | --- | --- | --- |
| 1 | CI `tests/provider-network-policy.cjs:156` 红 | happy-path 依赖执行环境的 DNS 对 `.invalid` 域行为；assertion 环境敏感 | 用例注入确定 `publicLookup` fixture；授权校验与网络策略断言全部保留，真实 loopback socket 用例保留 | 网络套件 16/16（CI core 绿） |
| 2 | clear / authorize-target 无法完成（sheet 强制 API Key） | 页面只实现 set 一种模式 | 页面按可信 purpose 选模式（clear/authorize 隐藏密码框、显式确认文案与标签）；purpose 经 prepare 应答→main→有序 send + sheet `info()` 拉取双通道，页面不自报；controller 按 flow.purpose 分派 stage/clear-stage/authorize-target 帧 | 真机 34/34（clear→clear-staged、authorize→consentId、全凭据 provider source 'none'） |
| 3 | `desktopCapability()` 的 Promise 未被 await | provider-management 的 snapshot 是同步函数 | snapshot 改 async 并 `await`（异常降级 null）；GET handler await；shell 侧传函数时同样正确 | 桥 24 断言（disabled/unqualified/永不返回 Promise） |
| 4 | IPv4 映射 IPv6 十六进制写法（`::ffff:7f00:1` 等）归 public | unwrapMapped 只认点分形式；保留段（TEST-NET 等）未分类 | v6 分支 `::ffff:` 双组 hex 还原为点分 IPv4 再按 IPv4 语义分类；新增 IANA 保留段（192.0.0/24、TEST-NET-1/2/3、192.88.99/24、198.18/15、224/4、240/5、255.255.255.255）→ private；大小写不绕过 | 新分类矩阵 13 例 + 保留段 8 例 + DNS 混合拒发 |
| 5 | `pickModelList` 返回原始条目（apiKey/headers/token 可透传） | 只做形状护栏 | 输出白名单：条目键全在白名单内才投影（未知键**整条丢弃**）；id/name 长度与控制字符限制；secrets 回显检测；transport 自动传密钥与请求头哨兵 | 恶意 fixture 专测 14 变体 + transport 端 strip 用例 |
| 6 | 旧授权可绑定替换后的 API Key；总超时可能突破 30s | transport 未核对 credentialRevision；单次超时未截到总剩余 | transport 新增 `credentialRevision` 参数与 consent 绑定核对；单次 attempt 超时 = min(timeoutMs, 总剩余) | 轮换专测 + 总时限专测（2 次 attempt ≤ 2000ms + 余量） |

## 10. 交付与许可状态

- 开发完成：首轮 4 提交 + 修复 3 提交（见分支 log）。
- 修复后定向验证：`npm run test:provider-p2`（16/16 + 桥 24 + 桌面 34/34）、`npm run test:provider-management`（21/0）、`npm run test:auth`（107/107）、modules 120/120、server-security 39/39、electron-guard 123/123、models-api 50/50、dev-server 30/30、P1 套件全绿。
- 完整 canonical（238 leaves）未本地全量运行——**待验证**，由本 PR CI（修复提交后的 run）证明。
- 正常 Electron 沙箱：**未验证**（如上第 7 节）；不得以 `--no-sandbox` 结果证明正常沙箱安全。
- 推送：已获授权推送分支；合并需用户审批，不直接合并 main，不发版。`providerKeyInputEnabled` 保持默认关闭。
- P3 接口可用性：第 8 节接口行为已验证；P3 使用 transport 时**必须传与授权一致的 credentialRevision**，保存编排（persist/sync）未包含在 P2。
