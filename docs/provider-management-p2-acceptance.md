# 供应商管理 P2 验收报告

设计基线 `docs/provider-management-rebuild-plan.md`（P2 行，Codex 负责，文件边界一致）。实现分支 `codex/provider-management-p2`，基于 main 合并 PR#59 后的 `61aba82`。本报告交付提交可用 `git log -1 --format=%H -- docs/provider-management-p2-acceptance.md` 查询。

**修订 2（独立验收修复后）**：首轮交付（`ed47000`…`011c7e0`，PR #60 CI run 42389222994）经独立验收发现 6 类问题，全部在本分支修复；修复内容见第 9 节。

**最终安全收尾**见第 10 节。第 1–9 节保留先前各轮验证的环境与结论。

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

## 11. 第二轮独立验收整改（修订 3）

第二轮独立源码审查（针对 `d7b525f`）提出六项问题。逐项**先以可复现探针验证**再修复；六项全部成立（含两项最初仅静态审查的建议——复现证据见下）。修复提交 `aa4dc80`。

| # | 问题 | 复现证据（修复前） | 修复位置 | 新增测试 |
| --- | --- | --- | --- | --- |
| FIX-01 | 字符串模型条目绕过密钥过滤 | `pickModelList({data:[ '<SECRET>' ]},[SECRET])` 返回含密钥 id | [provider-network.js](../server/provider-network.js) `sanitizeModelEntry` 字符串分支统一 secrets 检查（完整与子串） | `FIX-01` 用例：完整/子串回显、恶意字符串（空/超长/控制字符）过滤 |
| FIX-02 | 授权撤销与发包竞态：consent 只在开始读一次 | DNS 钩子内 revoke，伪造慢 DNS 后 `sent===1`（请求照发） | `verifyConsent` 抽出；DNS 后与**每个候选请求前**重查；外部 abort/总超时贯通 DNS（AbortController → lookup signal） | `FIX-02`：DNS 期 revoke/abort 后 `sent===0`；无 sleep 的可控异步 |
| FIX-03 | 凭据代次校验可选 | staged consent 不传 revision 成功发包 | keyed 授权强制核 `credentialRevision`（缺失/不匹配/缺 key 全拒；无凭据授权收代次也拒） | 轮换/缺代次/缺 key/反无 key 四向负向 + FIX-03 内联进既有用例 |
| FIX-04 | OAuth 清除被冲突检查阻断且无提示 | 真 P1 worker：`stageClear({confirmed:true})` → `oauth_conflict`；bridge 未传 `confirmOAuthReplacement` | bridge 首次应答固定文案（flow/nonce 保活）→ 受限窗展示影响 → 二次确认带 `confirmOAuthReplacement` 转发，成功后 consume；页面 clear 模式显示该文案（可信 message 优先） | 桥三段（首按拒绝+文案/再按转发/nonce 拒重放）+ 真机 OAuth clear 端到端 |
| FIX-05 | 异步 open 破坏 single-flight | 静态审查成立：`sheet\|\|flow` 在两个 await 之前，连续 open 双双通过并互相覆盖 flow/窗口（A 窗 closed 回调会清掉 B 的状态） | `opening` 互斥在任何 await 前同步置位、`finally` 释放；prepare 应答核验 handshake/child 一致，epoch 错位拒绝 | 真机：并发第二请求 `busy`（opening/sheet_open）、单窗、打开途中 backend 重启→显式拒绝+新轮握手成功 |
| FIX-06 | DNS 不计入总时限 | 源码顺序 + 探针：`deadline` 在 `await resolveTargetAddresses` 之后 | deadline 从 discovery 开始；DNS 超时经 AbortController；DNS 后余量不足则不再发请求 | `FIX-06`：慢 DNS 吃满额度 → timeout 且 `requested===false` |

**关联收紧**（复现中顺带发现，一并修复）：per-candidate 重查曾把签发时已批准的候选回退路径（如 `/models`）按「超出 basePath 前缀」误拒——verifyConsent 的路径合法性改为「目标（协议/host/port）一致 + URL 在签发批准的候选集合内」，与授权语义一致；此前 builtin 分支的 `consume` 遗漏（OAuth 确认路径成功后未作废 nonce）补上，并加 fixture 同步真实 worker 的 OAuth 清除纪律。

## 12. 修订 3 验证结果

| 命令 | 结果 |
| --- | --- |
| `npm run test:provider-p2` | 网络策略 **19/19**（新增 FIX-01/02/06 + 4 向代次负向）+ 桥 **27 断言** + 桌面真机 **42/42**，exit 0 |
| `npm run test:provider-management` | 21/0 |
| `npm run test:auth` | 107/107 |
| `node tests/models-api.cjs` / `server-security` / `electron-guard` / `modules` / `provider-auth-runtime` / `dev-server` | 50/50、39/39、123/123、120/120、36/36、30/30 |
| `node --test tests/provider-credential-sdk.cjs` / `provider-management-http` / `provider-management-contract` | 5/0、6/0、3/0 |
| `node tests/ci-test-plan.cjs` | 238 leaves，coverage exact |
| assertions 总数变化 | provider-network-policy 16→19（净增 FIX 专测 3，既有 16 项完整保留）；桌面真机 34→42；桥 24→27 |

## 13. 修订 3 后的边界结论

- **凭据泄露**：原文路径仍只有「sheet DOM → sheet preload → main → 私有 IPC → P1 worker」；主窗/SSE/HTTP/日志/诊断零原文（真机真机负向均过）；字符串条目同样过白名单。
- **授权撤销**：DNS 期间与每个候选发包前都重查 consent；abort 中止解析与网络。撤销即时生效且不发包。
- **SSRF**：公网 HTTPS-only；私网/链路本地/元数据/CGNAT/文档段/240/4/hex 映射全拒；DNS 钉桩；30s 总时限含 DNS；重定向全拒；候选 ≤8。
- **Electron 隔离**：opening 互斥覆盖异步打开全程；epoch 错位/后端换代的 stale prepared 拒绝；焦点恢复与 flow TTL 语义不变。

## 14. 未验证项与合并建议

- **正常 Electron 沙箱**：仍未验证（开发机执行器受完整性令牌限制，测试以 `--no-sandbox` 完成）；这不构成正常沙箱通过的证据。CI runner 的标准沙箱将运行网络策略与桥模块套件；窗口隔离项仍待正常桌面环境复核。
- 完整 canonical（238 leaves）本地未全量运行；由修复提交后的 PR CI 证明（待结果）。

## 10. 最终安全收尾（FIX-07、FIX-08、FIX-09）

以远端 `codex/provider-management-p2` 与 PR #60 一致的 `5a94e706d12b5aa176c690448cab9869cb398ec8` 为基线。[基线 CI](https://github.com/HYJ1817/pi-gui/actions/runs/42399611396) 为 `pull_request`、第 1 次尝试，8 项均通过，包含 238 条 canonical 命令、Electron 构建检查与 CI gate。本轮风险级别为高，涉及外部网络、授权撤销及隔离凭据窗口。

| 编号 | 修复前失败证据 | 修复位置及修复后证据 |
| --- | --- | --- |
| FIX-07 | 注入不响应 AbortSignal 的 DNS 时，4 个用例在 deadline 或外部取消后仍观察到 pending。旧 FIX-06 检查的计数器未接入 transport。独立复核另外复现了 302 响应体未结束时连接持续存活，以及 Node 全局代理收到以域名为目标的 CONNECT。 | [provider-network.js](../server/provider-network.js) 的 `resolveTargetAddresses` 竞争 DNS 与取消，`createDiscoveryTransport` 用操作起点计算单调 deadline，贯穿 DNS、候选请求及响应处理。迟到 resolve/reject 都不会发包。实际 requester 计数为 0，DNS 使用 90/100 ms 时只剩 10 ms 给请求。`restrictedFetch` 拒绝重定向后销毁连接，使用独立直连 agent 并维持已校验地址的 socket 钉桩。对应 [网络测试](../tests/provider-network-policy.cjs) 的 FIX-06/07、未结束 302 真 loopback 以及 agent 用例。独立复核的全局代理探针观测到 2 次直连尝试、0 次代理 CONNECT。 |
| FIX-08 | 5 种撤销路径下的迟到响应及一次响应结束竞态仍返回旧模型。用真实 staging worker 和假 SDK 复现了暂存替换不改变原生凭据修订号，旧授权仍可调用 requester。关闭草稿期间的迟到授权也曾重新签发 consent 和记忆记录。 | [provider-discovery-consent.js](../server/provider-discovery-consent.js) 的 `revoke` 统一终止授权生命周期，覆盖单授权、关闭草稿、连接换代、到期和 dispose。[provider-network.js](../server/provider-network.js) 在请求后及发布模型前再次校验授权。五种路径均中止进行中请求，迟到结果无 models，重新签发的授权可独立发现。P2 transport 没有发现缓存。[provider-credentials.js](../server/provider-credentials.js) 生成独立暂存代次，[provider-credential-bridge.js](../server/provider-credential-bridge.js) 替换和清除后撤销旧授权，签发前复核当前 flow、nonce 及草稿。对应 [网络测试](../tests/provider-network-policy.cjs)、[SDK 与桥联测](../tests/provider-credential-sdk.cjs) 及 [桌面桥阶段 A](../tests/provider-credential-desktop.cjs)。 |
| FIX-09 | 生产桌面控制器和真实后端桥的可控 IPC 测试复现 4 项失败，包括取消后仍发送 prepare 或打开窗口、换 backend 后旧握手仍挂起，以及 prepare 超时后留下 1 个有效 nonce。父窗口销毁的原有防护用例通过。 | [provider-credentials.cjs](../electron/provider-credentials.cjs) 的 `openHandler`、`openFlow`、`backendCall` 分别绑定打开身份、原窗口和原后端。旧 finally 只释放自己的占位。[私有帧校验](../public/provider-management/contract.js) 接受 prepare 的可选随机 flow ID，[后端桥](../server/provider-credential-bridge.js) 可在 prepare 前后通过同一个 ID 取消，并保留原 prepare 帧兼容性。[竞态集成测试](../tests/provider-credential-opening.cjs) 5/5，覆盖握手取消、prepare 迟到、立即重开、后端重启交错、超时、窗口销毁与单窗上限。真实 Electron 保留提交、OAuth 二次确认、焦点恢复路径和隔离检查，导航断言实际触发并验证 `will-navigate` 被取消。 |

### 验证结果

Windows x64、Node 24.22.1、Electron 44.4.3。用例仅使用 fixture 和临时目录。

| 命令 | 实测结果 |
| --- | --- |
| `npm run test:provider-p2` | 网络 31/31，开窗竞态 5/5，桥接 28 项，正常沙箱真窗口 42/42，exit 0 |
| `npm run test:provider-management` | 22/22，exit 0 |
| `npm run test:auth` | 107/107，exit 0 |
| `node tests/provider-auth-runtime.cjs` | 36/36，exit 0 |
| `node tests/models-api.cjs` | 50/50，exit 0 |
| `node tests/server-security.cjs` | 39/39，exit 0 |
| `node tests/electron-guard.cjs` | 123/123，exit 0 |
| `node tests/ci-test-plan.cjs` | 239 条 canonical 命令与五组精确覆盖，exit 0 |
| `npm run build:app -- --rebuild --output-root <TEMP>` | 本机缓存 Electron ZIP 离线构建成功，内含重建的 98.5 MB SEA 产物及 329.5 MB Electron 应用包 |

原 Electron 路径曾无法启动正常沙箱，回退运行先遇到 `UnknownVizError`，重跑以 `--no-sandbox` 通过 42 项。最终验证显式使用 `ELECTRON_OVERRIDE_DIST_PATH` 指向临时副本，前后 `electron.exe` SHA-256 均为 `BF0FE749904CA9F713CCFB2427C519FA39D0BBD0337BA411BA08785802E8D548`。本次没有进入无沙箱回退，真实打开、取消、提交及隔离共 42/42。截图 `sheet-dark.png`、`sheet-light-narrow.png`、`sheet-clear-mode.png` 分别为 37,972、37,304、38,653 字节，位于该次运行的临时证据目录。

canonical 从 238 增至 239。对比基线展开的命令，原 238 条及顺序全部保留，唯一新增 `node --test tests/provider-credential-opening.cjs`，workflow、五组划分和最终 gate 未修改。当前提交完整证明以 [PR #60 Checks](https://github.com/HYJ1817/pi-gui/pull/60/checks) 对应 HEAD 为准，本地未取得完整单次 `npm test` 的精确提交证明。

### 审查与剩余验证

- 独立增量安全与功能复核通过，定向复跑 42/42。FIX-07/08/09 范围内未发现可证实的 Blocker 或 Important。
- 基线已有保留地址分类差异。独立探针确认 `198.51.100.64`、`248.0.0.1` 等仍分类为 public，部分 IPv6 特殊地址也存在同类差异。该分类逻辑未纳入本轮三项修复，未验证在目标环境的实际可达性，由独立验收单列评估。
- 本轮未验证打包应用中的凭据端到端流程、安装器、真实供应商或 P3 发现编排。
- 可按提交顺序反向回退本轮提交。合并须等当前 HEAD 的完整 CI 和独立验收，具体决定由维护者作出。
- persist/sync、真实供应商网络、打包 exe 的端到端输入流程不在 P2 范围。
- **当前分支/提交**：`codex/provider-management-p2` @ `aa4dc80`（报告修订提交随后），推送后工作区干净。
- **合并建议：建议合并 PR #60**（在下一轮独立复验确认后由用户决定；`providerKeyInputEnabled` 默认关闭，启用需独立安全验收）。
