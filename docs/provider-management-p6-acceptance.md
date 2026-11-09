# 供应商管理 P6 最终验收与发布准备报告

P6 从 P5 合并基线 `cd243fb78e304c9666849ab983baf5b02b564ac0`（`origin/main` 顶端，PR #67）
建立独立分支 `codex/provider-management-p6`。本轮只做独立验证、证据收集、有证据的缺陷
修复与发布预检：不新增功能、不重构 UI、不修改版本号、不打 tag、不推送、不合并、不发布。
风险等级按 [REVIEW.md](../REVIEW.md) 计为**高**：验收对象包含 API Key 私有凭据链路、
`auth.json` 写入、受限网络发现、供应商配置文件写入与跨 Runtime 同步。

## 一、P0–P6 最终完成矩阵

| 阶段 | 内容 | 合并证据 | 本轮状态 |
| --- | --- | --- | --- |
| P0 | 冻结合同、目录、草稿/提交/发现/同步接口与非秘密客户端 | `b58674a` 之前历程，见 [P0＋P1 验收](provider-management-p0-p1-acceptance.md) | 完成（历史） |
| P1 | 无损配置仓储、双文件事务、原生凭据 SDK 适配 | 同上 | 完成（历史） |
| P2 | Electron 受限凭据输入窗、私有桥、网络策略、授权存储 | PR #60/#62 链路，[P2 验收](provider-management-p2-acceptance.md) | 完成（历史） |
| P3-A | 暂存→配置提交→原生凭据写入编排与回执 | [P3-A 验收](provider-management-p3-a-acceptance.md) | 完成（历史） |
| P3-B | 授权后发现/连接测试 202 操作、缓存与取消 | [P3-B 验收](provider-management-p3-b-acceptance.md) | 完成（历史） |
| P3-C | 逐 Runtime 只读同步、身份/版本见证、Graceful 失效 | [P3-C 验收](provider-management-p3-c-acceptance.md) | 完成（历史） |
| P4 | 完整管理 UI（选择器/双栏/高级/兼容模式/主题/窄窗） | [P4 验收](provider-management-p4-acceptance.md) | 完成（历史） |
| P5 | 真实接线、受限窗/发现/测试/同步集成、FIX-01/02/03 竞态整改 | [P5 验收](provider-management-p5-acceptance.md)，合并 `cd243fb` | 完成（历史） |
| P6 | 最终独立验收、缺陷修复、完整 canonical、打包与发布预检 | 本报告 | 见下文 |

P5 合并提交 `cd243fb` 已确认位于 `origin/main` 顶端；P6 分支基于该提交，原始基线可追溯。

## 二、GitHub CI 已知状态与精确提交

| 提交 | 事件 / Run | 结论 | 说明 |
| --- | --- | --- | --- |
| `cd243fb`（P5 合并） | push main / [42606329154](https://github.com/HYJ1817/pi-gui/actions/runs/42606329154)，attempt 1 | **failure** | 仅 `Tests (core)` 因 `tests/thinking-dots.cjs` 时序假红失败；其余组、计划与构建通过；CI gate 正确拦截 |
| `13f660a`（P6 的修复） | — | — | thinking-dots 自动交替改为虚拟时钟驱动（确定性） |
| `0171455`（并行修复合并，含同一 `13f660a`） | push main / 42639509745，attempt 1 | **failure** | 失败命令为 `node tests/ci-results.cjs`（`fixture timeout: second leaf running`，20s 等待窗口在 runner 负载下超时）。该测试与供应商管理无关，本地连续 3/3 通过；属于 CI 基础设施时序抖动，归并行 CI 修复工作流跟进 |
| `codex/provider-management-p6` HEAD | 未推送 / 无 PR CI | **待验证** | 本轮未获推送与建 PR 授权；最终完整证明以本地 `npm test` 加后续 PR/main CI 为准 |

**P5 基线失败定性（已关闭）**：`tests/thinking-dots.cjs` 用两条独立 `setTimeout`
链做墙钟竞速（检查点名义余量 20ms），产品语义本身正确；P6 已改为虚拟时钟驱动，
90/90 确定性通过，并被并行 CI 分支采用（同一提交 `13f660a`）。
**并行 CI 修复整合**：`origin/main` 的 `0171455` 已安全合并为 `2eac7a2`
（无冲突、无重复修复、未丢弃提交）；合并后 main 暴露的 `ci-results` 抖动
不属于供应商管理代码，本轮未修改该测试。

## 三、历史遗留问题完整台账（P0–P6）

分类：A＝已真正修复；B＝已记录未修复；C＝已实现缺测试；D＝受系统权限/真实账户/外部服务限制；
E＝误报或已失效/按设计不是缺陷。本轮已对全部 B/C 项完成整改；D 项给出准确原因。

| 来源 | 记录项 | 类别 | 本轮核对与处置 |
| --- | --- | --- | --- |
| P2 | 正常 Electron 沙箱未验证 | A | 已用 `ELECTRON_OVERRIDE_DIST_PATH`（同版本同摘要 Electron 44.4.3 副本）在正常沙箱完成：凭据窗 47/47、供应商 UI 夹具 38/38；无 `--no-sandbox` 回退 |
| P2 | 打包 exe 的凭据端到端输入未验证 | D | 打包 GUI 无法在无调试端口时自动驱动；而调试端口按设计会关闭密钥输入资格，故无法在打包 GUI 内同时满足「可自动化」与「凭据资格」；打包后端/worker/前端一致性与真实后端行为已在打包探针 34/34 中覆盖 |
| P2 | 真实供应商网络、TLS/CDN 行为 | D | 需真实外部授权/费用；本轮只用回环真实 HTTP 与隔离 fixture |
| P2/P3-B | 外部 Pi/手工编辑的跨进程竞争窗口 | E/D | 按设计声明保留（SDK 无跨进程 CAS）；非本轮可修复缺陷 |
| P3-A/B/C | 正常沙箱待验证 | A | 同 P2：正常沙箱完成并通过 |
| P3-A/P5/P6 | `auth.json` 成功持久化（存储资格见证） | D | 本轮在隔离目录尝试设置私有 DACL 时被宿主沙箱拒绝（`SetAccessControl` UnauthorizedAccess），无法构造合格目录；产品的资格判定会被正确拒绝（store 套件覆盖），P3-A 曾在权限合格系统临时目录完成成功路径。保留为环境未验证 |
| P3-A | 失去 worker 停止回执后的维护恢复未工具化 | D | 需要人工停写恢复流程，非用户路径；回执保留隔离，未自动重放 |
| P4 | `selectedModelIds:null` 继承语义需合同扩展 | E/B | 现行为是**显式确认后固定选择**，不会静默改语义；属于合同限制而非缺陷。如果未来要「只改名称仍保持继承」，需要独立合同提案 |
| P4 | 页面打开期间管理开关变化仍打开管理编辑器 | E | 开关是后端启动时读取，变化需重启后端；提交会以 422 失败且绝不降级旧接口写入（fail-closed） |
| P4/P5 | 自动推荐（最多 3 个聊天模型）未实现 | B/D | 计划同时要求「不能以模型 ID 猜能力」，而当前没有可信的聊天能力来源；缺省不自动选择是安全行为。保留为计划增强，未在本轮臆造实现 |
| P5/P6 | 真实供应商认证、真实 OAuth、真实安装升级 | D | 需要外部授权/凭证/安装环境；发布预检不执行安装 |
| P6 | UNVERIFIED：fixture 祖先不满足存储策略 | D | 同上，环境 DACL 限制 |
| P6 | PRE-01 调试/无沙箱资格判定不全 | A | FIX-04 修复并回归 |
| P6 | 编辑缓存首屏缺失（Important） | A | FIX-01 修复并回归 |
| P6 | 预设环境变量缺失后授权终态无可重试入口（Nit） | A | FIX-02 修复并回归 |
| P6 | `displayValues` 掩盖 configured/builtin-override 的显式清空（Nit） | A | FIX-03 修复并回归 |
| P6 | 内置供应商静默忽略端点变更（非安全观察） | A | FIX-05 修复并回归 |
| P6（本轮新发现） | 关闭弹窗后焦点落到页面容器而非服务行（键盘可用性） | A | 已修复并真实 Electron 验证 |
| P6（本轮新发现） | 缺数值时无「未知」占位徽标 | E/Nit | 外观信息细节，不影响编辑/保存语义；保留记录 |

**结论**：历史记录中不存在尚未处置的 Blocker/Important；所有可复现、可修复的功能缺陷已关闭。
剩余 D 项均需要真实外部授权、真实安装环境或操作系统 ACL 权限。

## 四、完整测试清单与实际数字

### 定向套件与专项（最终代码状态）

| 命令 / 专项 | 结果 |
| --- | --- |
| `npm run test:provider-management` | **164/164**（合同/仓储/HTTP 24/SDK/P4 UI 67/P5 44；0 fail、0 skip） |
| `npm run test:provider-p2` | 网络策略 **39/39**、开窗 **5/5**、凭据桥阶段 A **42** 条断言、真实 Electron 桌面 **47/47**（最终 HEAD `d70d0fb` 重跑；正常沙箱，无 `--no-sandbox` 回退；1 条存储资格 UNVERIFIED 为环境限制） |
| `node tests/electron-guard.cjs` | **124/124**（含 32b：凭据受限窗按 Session 实例排除、分支内无 `openExternal`） |
| `node tests/provider-auth-runtime.cjs` | **50/50** |
| `node tests/smoke.cjs` | **1345/1345** |
| `node tests/thinking-dots.cjs` | **90/90**（虚拟时钟确定性） |
| 多 Runtime 真实进程专项（`.shots/p6/multi-runtime-evidence.cjs`） | **40/40**（最终 HEAD `d70d0fb` 重跑；A/B/C 三个独立假 Pi 进程、并发同步不重复回读、只读纪律、身份/代次失效、OAuth 共存） |
| 真实 Electron 供应商夹具（正常沙箱） | **38/38**（最终 HEAD `d70d0fb` 重跑，7 张截图；含缓存端点命中、内置 env 创建、停用/启用、焦点恢复） |
| 仅安全资格单元/接线（`provider-credential-desktop` 阶段 A） | **42** 条断言（含每种调试/无沙箱启动方式；`hasSwitch` 抛错 fail-closed） |
| `node scripts/run-test-group.mjs --validate` | `241 canonical leaves; groups core, ui, security, native, faults` |

### 完整 canonical

- 提交：`d70d0fb`（本报告除外的全部代码/测试/文档改动均已提交；工作区仅有本报告）。
- 命令与结果：`npm test`（含 pretest）**退出码 0**，2026-11-10 00:24:12 → 01:45:29
  （约 81 分钟），日志 `.shots/p6/npm-test-final4.log`；全部套件 0 failed。
- pretest：`file-size-report` 11/11；`test:ci` 计划 **241 canonical leaves / 5 groups**
  （`coverage exact`），`ci-results` 10/10、`ci-summary` 30/30、`ci-doc-scope` 28/28。
- 关键套件实测：`test:provider-management` **164/164**（fail 0、cancelled 0、skipped 0）；
  `test:provider-p2` 凭据桥 **42 条断言**、真实 Electron **47/47**；`electron-guard`
  **124/124**；`smoke` **1345/1345**；`thinking-dots` **90/90**；`provider-auth-runtime`
  **50/50**。
- 环境性跳过（不计入通过分子/分母，均为本机权限限制）：`collab store` 53/53
  skipped=1、`candidate adoption` 45/45 skipped=1（不能创建 symlink）、`logging-leaks`
  7 passed skipped=1（symlink EPERM）、`session-revert-sacl-witness` 0/0 skipped=8、
  `session-revert-inplace` 28/28 skipped=2、`session-revert-object-witness` 0/0 skipped=8
  （`SeSecurityPrivilege`/既有 token SACL 不可用）。
- 说明：canonical 内的 `test:provider-p2` 阶段 B 在本机未设置
  `ELECTRON_OVERRIDE_DIST_PATH`，正常沙箱启动失败后按套件既定逻辑回退
  `--no-sandbox` 并 47/47 通过；**正常沙箱**证据来自 7.2 的专项 run
  （`ELECTRON_OVERRIDE_DIST_PATH` 指向同摘要 Electron 副本，无回退，47/47）。

## 五、FIX-01…FIX-05 修复证据

### FIX-01 模型缓存首屏（Important，已关闭）

- 服务端：成功发现后写入内存**目标缓存**，键严格包含 `providerId`、规范化目标
  （协议/host/port/完整 basePath）、API、认证来源与凭据代次；60 秒新鲜，过期后
  最多保留 15 分钟并以 `cacheStale:true` 标记；后端重启即消失，不落盘、不含秘密。
- 新增只读 `GET /api/provider-management/services/:serviceId/cache`：服务端按
  当前权威配置与认证来源解析目标（客户端不能指定目标），只查内存缓存，不联网、
  不写草稿；环境变量来源用受控预设变量计算代次，`pi-credential` 只接受可证明的
  字面量原生凭据快照，未知/不可读/OAuth/暂存来源一律不命中。
- 前端：编辑已有服务打开时拉取匹配缓存并入候选（仅展示，不改变选择/顺序），
  显示「匹配缓存/已过期」横幅与逐条「缓存已过期」徽标；新鲜远端结果把**未被
  编辑**的缓存候选升级为 remote；已移除候选不会因再次保存而复活；关闭/重开与
  快速切换以目标身份隔离。缓存请求的迟到响应必须同时匹配发起时的服务 ID
  （`sourceServiceId` 与服务端回显）、目标身份键与生命周期代次，否则丢弃——防止
  切换服务/改目标后把旧服务模型并进新草稿。
- 证据：HTTP 24/24（不同 provider 与同 provider 不同 API/basePath/host/port/
  协议分区、60s→stale、15min 丢弃、凭据轮换失效、恢复原目标重新命中、显式撤销
  只停止联网且缓存仅按 cache 展示、全程零新增网络）；UI 67/67（服务切换/凭据
  引用变更后的迟到缓存丢弃、移除后改引用保存不复活、合并/过期/升级/显示回退）；
  真实 Electron 38/38（真实后端缓存命中且读取时模型目录请求数不变）。

### FIX-02 环境变量缺失授权与重试（Nit，已关闭）

- 服务端把原来的笼统 `unsupported` 拆为 `environment_missing`（变量缺失/取值
  不可用，`fieldErrors.environmentReference`）与 `environment_target_unsupported`
  （非目录审核预设端点）；文案不含变量值。
- 前端保持 `unapproved` 可重试状态并显示可操作原因；修复后端环境后重新点击
  「授权并发现」即可继续，不需要重建供应商；无轮询、不绕过授权/SDK/凭据隔离。
- 证据：HTTP「缺失/取值不可用 422 → 设置可用变量后 200」与目标不支持 422；
  错误体不回显已存在但不可用的变量取值；控制器「失败保持可重试并在恢复后取得
  consent」。

### FIX-03 高级参数显示回退（Nit，已关闭）

- `displayValues` 展示回退仅用于 remote/cache 来源；configured/builtin-override
  的显示服从当前草稿编辑状态：清空名称/上下文/输出后立即反映继承/默认，
  不再被旧值遮盖；`baseline`、`editableOverrides` 与 `unsetFields` 保存语义不变。
- 证据：UI 四种来源测试（configured/builtin-override 清空后无旧徽标且保存补丁为
  `unsetFields`；remote/cache 仍显示可信发现元数据）。

### FIX-04 Electron 调试与无沙箱资格加固（PRE-01，已关闭）

- 新增 `electron/desktop-qualification.cjs` 纯函数：直属后端缺失、远程调试
  port/pipe、`--inspect`/`--inspect-brk`、`--no-sandbox`、`--single-process`、
  `--disable-web-security`、`ELECTRON_DISABLE_SANDBOX`、`NODE_OPTIONS` 调试参数
  全部 fail-closed 并返回固定原因码；main 委托该函数，原因透传到页面（准确
  禁用文案）。正常沙箱不受影响；sender/frame/origin/nonce/TTL/epoch 未放宽。
- 凭据受限窗（独立 partition）从全局 `hardenWebContents` 的「站外链接交给系统
  浏览器」路径中排除：该窗口只允许拒绝导航/重定向/弹窗，永不调用 `openExternal`。
  排除按 **Session 实例**比较（Electron 的 `Session` 没有 `getPartition` 方法；
  最终安全复审发现的死分支已修复，`electron-guard` 32b 做接线回归）。
- 证据：每种启动方式 14 条单元/接线断言（新增 `hasSwitch` 抛错 fail-closed）；
  凭据桥阶段 A 42 条；真实 Electron 47/47（正常沙箱，无回退）；
  `electron-guard` 124/124（32b 变异验证：改回 `getPartition` 时失败）。

### FIX-05 内置供应商静默端点忽略（已关闭）

- 内置分支在 `guardExistingTarget` 放行后仍显式检查 `targetChanged`：请求携带
  不允许的端点变更返回 409 `credential_target_conflict`，不再静默忽略后返回
  `saved:true`；同目标名称/模型/环境变量引用修改不受影响；未知字段保留。
  仅含 `modelOverrides`、没有端点字段的旧记录与目录预设比较，同目标更新不再
  被误拒；预设未知时保守拒绝。
- 证据：HTTP「换端点 409 且配置不变、同目标 env 更新 200」；用例改用
  `builtIn:false` 使新增检查成为唯一拒绝点，并覆盖「仅模型覆盖」记录的同目标
  更新 200 与换端点 409；删除显式检查/改回 previous 比较两种变异均使用例失败。

### 其他本轮修复

内置 env 引用保存（Blocker）、内置首次模型覆盖确认重试、OAuth/订阅服务重新启用
（对称 `enable`）、发现候选名称/容量展示、移除→刷新→重选补丁冲突、锁图标 SVG、
关闭弹窗焦点恢复、thinking-dots 确定性计时器。

## 六、凭据与网络安全审查结果

### 4.1 凭据安全专项（独立安全审查 + 本机实证）

- **原文唯一路径**：受限输入窗 DOM → sheet preload（只白名单 `input/allowDiscovery/rememberTarget`）
  → main（sender/mainFrame/固定 URL/一次性 nonce/TTL/单飞）→ 私有 IPC（backendEpoch/flow/nonce/
  draftRevision）→ credential worker。普通 preload 只有 `open/cancel/status/closeDraft/onState`，
  无 submit、无通用 invoke。主窗口 DOM 无 `input[type=password]`（真实 Electron 断言通过）。
- **重放/伪造/过期/跨草稿**：nonce 成功即作废、失败保留供同窗 OAuth 二次确认；伪造来源帧
  被 `mainWindowAllowed`/`sheetAllowed` 拒绝；过期 flow 由 TTL 与 backend 双重执行。
- **槽位纪律**：set/replace/clear/authorize-target 各自 purpose 绑定；OAuth 同槽替换/清除
  需受限窗内二次确认（`oauthConfirmOffered`/`clearConfirmOffered`）；`clear-native` 与
  `{type:'none'}` 语义分离；`close-draft` 撤销 flow/授权/暂存。
- **SDK 写入**：literal 编码（`$`→`$$`、首 `!`→`$!`）与回读等值验证；`CredentialSynchronizationError`
  不序列化（classification 仅 `sdk_sync_pending`）；失败/不确定三态（saved/`saved-credential-error`/
  `credential-unconfirmed`），不自动重试。
- **事务语义**：配置先落盘、凭据后写入；回执持久化且字段收敛；跨目标修改要求
  `present:false && builtIn:false`，新 ID 身份证据不足拒绝。
- **文件安全**：`auth.json` 所有权/权限/文件身份见证（Windows ACL / Linux uid+mode；其他平台关闭）；
  worker 路径 lstat（拒链接/非普通文件/nlink≠1/超大），前后身份一致；journal 恢复校验
  before/after digest；backend 重启 epoch 变化撤销握手/flow。
- **降级**：Web/reused backend/远程调试/`--no-sandbox` 时资格拒绝；`PI_GUI_PROVIDER_KEY_INPUT`
  默认关闭（真实 Electron 中凭据触发器禁用并说明原因，已断言）。
- **独立安全审查结论**：Blocker 0 / Important 0 / Nit 0 / Pre-existing 1。唯一 Pre-existing
  Nit 为 `electron/main.cjs:899-902` 的资格判定未覆盖 `--remote-debugging-pipe`、`--inspect`、
  `ELECTRON_DISABLE_SANDBOX`（防御纵深建议；威胁主体与设计声明的同用户调试器例外重合，
  本轮不改产品代码，列入发布后备忘）。

### 4.2 网络与模型发现专项

- 未授权零请求：真实 Electron 中授权前模型服务器请求数 0（断言），授权后发现请求
  仅 `GET /v1/models`（无推理调用）。
- 授权绑定：服务端 consent 绑定 `(draftId,connectionRevision,providerId,launchIdentity,
  scheme+host+port+basePath,API 类型,候选路径,credentialSource,credentialGeneration)`；
  DNS 后与每候选发包前重查；凭据代次轮换使旧授权失效。
- SSRF：公网 HTTPS-only；私网/链路本地/元数据/CGNAT/文档/保留段/240/4/IPv6 特殊段拒绝；
  IPv4 映射十六进制还原；DNS 钉桩 + `agent:false` 直连；拒绝一切重定向；30s 总时限含 DNS；
  4MiB/3000 模型/候选≤8；输出白名单（未知键整条丢弃、密钥回显条目丢弃）。
- 错误与重试：401/403/429 停止并展示固定码；429 携带受限 `retryAt`。
- 迟到隔离：P5 FIX-02 的 8 条回归在 `provider-management-p5.cjs` 内通过；本轮复核
  `discovery.js` 的 abort/revoke/身份守卫结构完整。

## 七、多 Runtime 安全专项（离线真实进程）

本轮自建证据脚本 `.shots/p6/multi-runtime-evidence.cjs`（开发期证据工具，Git 忽略），
使用生产模块 `server/rpc-bridge.js`（真实 spawn/stdio RPC）、`server/provider-config-store.js`
（真实双文件事务）与 `server/provider-config-sync.js`（真实协调器），三个独立假 Pi 进程
（A/B/C 各自会话文件与控制文件，跨代次 A2/A3/A4/B4）。**40/40 检查通过**，实际数字：

- A 正在执行任务时提交新配置：A 进程未被杀、启动次数 1，同步保持 `pending`。
- B 用新配置启动（独立进程），只读回读确认后 `applied`；A 恢复（显式关闭后按新代次重启）
  并具备可信证据后 `applied`；忙碌时保持 `pending` 且不做回读。
- 全程命令日志只含 `get_state`、`get_available_models`、`get_available_thinking_levels`；
  无重启/切模型/改思考等级/任何破坏性命令。
- 多次同步幂等：已 `applied` 目标零新增 RPC。
- `sessionFile` 被替换（同路径新文件身份）→ 旧 `applied` 证据失效回 `pending`。
- `models.json` 原生代次变化 → 全部旧证据失效；旧 revision 的同步请求不产生新回读。
- OAuth 写入持锁期间同步 `pending`；停止回执推进 `authGeneration`；认证代次变化使旧证据
  全部失效，新代次重启后两运行时恢复 `applied`。
- 结果不确定的 OAuth 操作（`unconfirmed`）：写入进行中 `pending`，非进行中
  `error/credential_unconfirmed`，不会被当成已同步。

## 八、真实 Electron 与视觉验收

### 6.1 正常沙箱

- 环境：Windows x64；Electron 44.4.3；`ELECTRON_OVERRIDE_DIST_PATH` 指向 TEMP 中同版本
  `electron.exe` 副本（SHA-256 `bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`，
  与 P2 记录一致）。共享安装路径在本机无法启动 Chromium 沙箱属宿主限制，使用仓库既有
  离线开关不改变被测代码与版本。
- **供应商管理 Electron 夹具 38/38 检查通过**（正常沙箱；`sandbox:true/contextIsolation:true/
  nodeIntegration:false`，无 `--no-sandbox`），console error 0，进程族 9、残留 0，截图 7 张。
  覆盖：启动与主窗口、供应商页、选择器（自定义端点固定在 API Key 组首位）、未授权零请求、
  凭据触发器默认禁用、授权→自动发现（真实回环 HTTP，仅 `GET /v1/models`）、勾选入右栏、
  保存落盘（TEMP `models.json` + 元数据）、编辑（端点只读、显示名写入、模型保留）、
  复制（不携带凭据、新 provider、无 apiKey）、停用（保留 Pi 配置）、删除（确认文案含
  `auth.json` 边界；只删目标）、760px 窄窗（无横向溢出、保存按钮在视口内）、Esc 关闭、
  5 次快速开合单实例、关闭/重开管理页、零 console error；另含**真实后端缓存端点命中
  且读取不触发模型目录请求**、**内置 openai env 引用经真实 UI 落盘**、**内置停用/启用**与
  **关闭弹窗后焦点回到服务行**。
- **凭据受限输入窗（真实 Electron 正常沙箱）47/47 checks 通过**，无 `--no-sandbox` 回退；
  1 条 `UNVERIFIED`（成功持久化路径的 fixture 祖先存储策略不满足见证条件；P3-A 已在
  权限合格的系统临时目录完成该成功路径的实证）。截图 3 张（深色、浅色窄窗、清除模式）。

### 6.2 本轮修复的 UI 缺陷

真实 Electron 的 console error 检查发现：凭据区每次渲染报
`<path> attribute d: Expected moveto path command`，锁体不显示。根因是
`public/provider-management/dom.js` 的 `icon()` 只处理 `circle/path`，`lock` 图标的
`rect:5,10,14,10,2` 被写进 path 的 `d`。已修复为创建真实 `<rect>` 并补回归
（`tests/provider-management-ui.cjs`，修复时 54/54，最终 67/67）。提交 `fb5c7ca`、`d3fe10d`。

### 6.3 截图索引

| 文件（`.shots/p6/`，Git 忽略） | 字节 | 场景 |
| --- | --- | --- |
| `electron/01-providers-list-dark.png` | 45,248 | 真实 Electron 供应商列表（深色） |
| `electron/02-setup-unauthorized-dark.png` | 141,136 | 自定义端点配置：未授权、零请求（深色） |
| `electron/03-discovery-ready-dark.png` | 146,030 | 授权后发现两个候选、已选两个模型（深色） |
| `electron/04-list-saved-dark.png` | 128,526 | 保存后列表（深色） |
| `electron/05-advanced-light.png` | 127,450 | 高级设置改名（浅色） |
| `electron/06-list-after-delete-light.png` | 138,043 | 删除副本后列表（浅色） |
| `electron/07-narrow-760-light.png` | 102,372 | 760px 窄窗弹窗（浅色） |
| `credential/sheet-dark.png` | 37,972 | 受限凭据窗（深色，正常沙箱） |
| `credential/sheet-light-narrow.png` | 37,304 | 受限凭据窗（浅色窄窗，正常沙箱） |
| `credential/sheet-clear-mode.png` | 38,653 | 清除模式确认（正常沙箱） |
| `packaged-window.png` | 103,526 | 打包应用真实页面（CDP 截图；供应商管理页，调试端口运行） |
| `electron-smoke/smoke-1200.png` 等 | 见运行目录 | normal-sandbox Electron smoke（源码外壳，1200/760/模态遮挡） |

P4/P5 的 Chromium 真实渲染截图（选择器四列、双栏、主题、管理关闭兼容路径等）保留在
各自报告中，本轮不重复采集；本轮 Electron 截图证明真实外壳与真实调用链。

## 九、打包与发布前预检

### 7.1 构建与打包（离线）

- `PI_GUI_ELECTRON_ZIP_DIR` 指向本机 Electron 44.4.3 缓存 zip，`npm run build:app -- --rebuild`
  **退出码 0**（内含 `build:exe`）；无新增下载、无新增依赖（最终代码状态重建，
  `01:46:34 → 01:46:49`，日志 `.shots/p6/build-final.log`）。
- 产物：`dist-app/Pi GUI-win32-x64` **345,971,813 bytes / 417 files**；
  `build/Pi GUI.exe` **103,762,944 bytes**，SHA-256
  `57719257b6591a7748cfc9f7bd04f52438a912b287635052d536983fd14a3ba5`；
  打包后端 `resources/app/server.cjs` 2,763,569 bytes，SHA-256
  `00d8903ec17c16193e46bf890d61721f81c1aeae3a0c03f701d78c5cde3e41a3`；
  私有凭据 worker `private/provider-credentials.cjs` 50,213 bytes。

### 7.2 打包专项与真实运行

以下四项均在**最终构建产物**（01:46 重建）上重跑，全部退出码 0：

- `npm run test:app`：**26/26 通过**（打包 Electron 内嵌后端在无 `node_modules` 下运行）。
- `npm run test:exe`：**49/49 通过**。环境适配（如实记录）：本机对该新构建的未签名 SEA
  进程存在目录创建限制（`PI_GUI_DATA` 位于用户 TEMP 时无法创建目录；对照实验证明
  `node build/server.cjs` 与仓库内路径均正常，属宿主沙箱限制），因此本轮把测试进程的
  `TMP/TEMP` 指向 `gitignore` 的 `.shots/p6/exe-tmp` 并复用既有 PDF 固件后运行；
  测试与产物本身未做任何修改。同一 exe 在数据目录预先存在时可直接启动并返回
  `/api/status` 200。
- **打包应用启动探针 34/34**（`.shots/p6/packaged-provider-probe.cjs`）：
  - 真实 `dist-app/Pi GUI.exe` 启动，暴露主页面目标、进程族含内嵌后端、页面显示
    「已连接」、可在页面内打开供应商管理页并读取管理快照（`rawKeyInput/keyStaging=false`）；
    页面截图 `packaged-window.png`（103,442 bytes，最终构建实拍）。该运行使用调试端口（按设计会关闭
    凭据输入资格；本轮不在打包 GUI 中测试凭据），且本执行环境下 Win32 ``MainWindowHandle``
    对任何 Electron 窗口均为 0（已用源码 Electron 做过对照），故采用打包应用自身 CDP 取证。
  - 打包后端 `server.cjs` 真实启动：custom 创建、**内置 openai env 引用创建（P6 修复）**、
    disable→enable（P6 对称动作）、TEMP 配置与 GUI 元数据落盘、11 个前端/Electron 文件与源码
    **逐字节一致**、私有凭据 worker 在包内。
- `npm run test:electron-smoke`：**11/11，正常沙箱，残留进程 0**（源码 Electron + 生产
  server/renderer/preload + 假 Pi，含 1200/760px 与原生 Browser 遮挡）。

发布前检查项（预检，不构成发布授权）：

1. 构建/打包流程：`npm run build:app -- --rebuild`（内含 `build:exe`）使用本机 Electron 44.4.3
   离线 zip，不新增网络行为。**已通过**（退出码 0，产物与哈希见 7.1）。
2. 供应商新增资源包含在正式桌面包：`resources/app/public/provider-management/*`、
   `public/providers.js`、`provider-credentials.cjs`、`provider-credential-preload.cjs`、
   `preload.cjs` 与源码**逐字节一致**（11 个文件，打包探针实测）；`private/provider-credentials.cjs`
   在包内；后端以单文件 `server.cjs` bundle 交付，其内置 env/enable 新行为已在打包产物上实测。
3. 旧版本配置与认证文件安全读取：TEMP 兼容性探针通过——旧 `models.json` 的 env 引用、
   未知顶层/供应商/模型扩展字段、模型 capabilities 均无损保留；GUI 元数据写入后上述字段
   原样保留；sidecar 独立创建。
4. 更新安装后旧会话/配置保留：由 canonical 中的 app-update 套件覆盖（fixture 级）；真实
   安装升级未在本轮执行（发布预检不安装）。
5. 回滚与 P3/P5 元数据：GUI 元数据只存在于 `DATA_DIR/provider-management.json`（不含秘密），
   旧版本忽略该文件；`models.json` 中的 `modelOverrides` 与模型配置是 Pi 原生格式，回滚
   无需迁移；`auth.json` 由 Pi 管理，GUI 不写回。回滚步骤见第九节。
6. 管理功能关闭：`PI_GUI_PROVIDER_MANAGEMENT` 默认关闭；关闭时旧 `/api/providers` 兼容路径
   由既有测试覆盖（P4 兼容编辑器、真实 HTTP 旧路由、FIX-07 错误不降级），本轮未改动该路径。
7. 高风险凭据输入：`PI_GUI_PROVIDER_KEY_INPUT` 默认关闭（未在本轮默认开启）；真实 Electron
   断言触发器禁用并给出原因。
8. docs/releasing.md 正式发布条件：版本一致（`npm run version:check` 通过，0.32.0）；正式发布
   仍需发布提交自身的成功 main push CI 与用户明确授权。

## 十、独立审查意见

### 8.1 安全与故障注入审查（独立上下文）

- 基线 `13f660a`（`origin/main` `cd243fb` + 测试修复），生产供应商代码与 main 完全一致。
- 结论：**Blocker 0 / Important 0 / Nit 0 / Pre-existing 1**，未发现可证实的阻断问题。
- PRE-01（Pre-existing，Nit）：`electron/main.cjs:899-902` 资格判定未覆盖
  `--remote-debugging-pipe`、`--inspect`、`ELECTRON_DISABLE_SANDBOX`。与设计文档的防御
  纵深承诺有差距；威胁主体属设计排除的同用户调试器，本轮记录不修改。
- 附注（非发现）：全局 `hardenWebContents` 对凭据 sheet 的 `will-navigate` 同样生效，
  外部 URL 会走 `shell.openExternal`；因 sheet 页面无导航入口与 sink（CSP `default-src 'none'`、
  `form-action 'none'`、纯 textContent），无可达攻击路径；建议后续从全局外部打开逻辑中
  排除该 session 或修正注释。**已在最终收尾轮修复**：原排除分支使用不存在的
  `Session.getPartition`（死代码），现改为 Session 实例比较并由 `electron-guard` 32b
  固化（见 8.3 F1）。

- **修复后聚焦复审（`7af518b`，builtin env/enable）**：Blocker 0 / Important 0 / Nit 0 /
  Pre-existing 0。核验：env 新建只写预设端点且要求原生槽 `present===false`（未知证据 fail
  closed）；更新不落盘请求端点、只替换 apiKey 引用且保留未知字段；enable 仅写
  `metadata.services[id].enabled`，不触碰 models.json/auth.json/凭据/发现授权，带草稿或不存在
  服务分别 400/404；密钥链、网络授权、配置事务与只读同步无回归。
  非安全观察（不计发现）：builtin 更新在既有记录“安全且无原生凭据”时，draft 请求的端点被
  静默忽略（返回 saved:true，目标保持原值，fail-safe）；界面不会触发该形态。建议后续显式
  拒绝或提示。

### 8.2 功能审查（独立上下文）

- 基线 `d3fe10d`（生产供应商代码与 main 一致）；只读审查，另运行纯函数/后端事务探针。
- 结论：**Blocker 1 / Important 5 / Nit 1 / Pre-existing 0**。全部位于 P0–P5 既有代码，
  不是 P6 提交引入；属于本次重构交付范围。
- 处置（均有复现与回归）：

| # | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| 1 | Blocker | 目录卡片预填 `$NAME` 的内置 API Key 供应商在管理界面保存被 422 `unsupported`（builtin 分支只收 keep），而旧 `/api/providers` 同一写入可用 | 已修复 `7af518b`：builtin 接受 keep/env/none；env 新建沿用旧入口「预设端点 + 原生凭据槽为空」两条守卫；更新只换引用；apply-staged/clear-native 仍拒绝。回归：`provider-management-http` 内置 env 用例（含非预设 409、有凭据 409、原生 422） |
| 2 | Important | 内置 provider 已有 models、无 overrides 时首次模型编辑不发送 `confirmBuiltinOverride`，保存 400 且无补确认入口 | 已修复 `799527a`：commit 返回该字段错误时弹出「覆盖内置模型配置？」确认，确认后只重试一次。回归：UI 用例断言第二次草稿带确认标记 |
| 3 | Important | 「编辑先显示匹配缓存」未实现（`cachedModels` 无读取方；新草稿无 consent；`matchRemembered` 无生产调用方） | **未修复（遗留）**：需要新的缓存/记住目标状态机（跨弹窗缓存分区、凭据代次失效、撤销语义），属功能级工作；管理功能默认关闭且无数据/安全影响。列入遗留并需用户决定 |
| 4 | Important | OAuth/订阅服务停用后无法从 GUI 重新启用（菜单禁用启用；订阅服务无 connection，无法走 update 草稿） | 已修复 `7af518b`：新增与 `disable` 对称的无草稿 `enable` 动作（只改 GUI 元数据）；菜单不再禁用启用。回归：HTTP disable→enable 对称（不触碰 Pi 配置、缺失 404、混用草稿 400）与 UI 启用用例 |
| 5 | Important | 发现/缓存候选的 name/contextWindow/maxTokens/reasoning/input 被丢弃，候选行只剩 ID | 已修复 `7403c30`：新增 `displayValues` 仅作展示回退（不进入 baseline/覆盖/补丁）；候选与已选行统一渲染。回归：UI「发现元数据只展示不落盘」 |
| 6 | Important | 移除模型 → 刷新带回 → 重新勾选后，同一 ID 同时出现在 `selectedModelIds` 与 remove 补丁，保存 400 | 已修复 `7403c30`：选中时撤销待删除记录。回归：UI「刷新后重新勾选撤销 remove」（含后端可接受的 upsert 补丁） |
| 7 | Nit | 预设环境变量缺失时授权进入无重试入口的终态 UNSUPPORTED | **未修复（遗留）**：需要区分「缺少环境变量」的固定原因码/文案并允许重试，属小 UI 状态改进；记录为后续项 |

- **修复后聚焦复审（HEAD `75224f4`）**：原 5 项可修发现全部确认修复，未发现阻断问题
  （新增 Blocker 0 / Important 0 / Nit 1）；复审独立复跑 `test:provider-management` 150/150、
  `provider-management-http` 20/20、`provider-management-ui` 58/58。
  新增 Nit N1：`displayValues` 回退对 configured/builtin-override 模型也生效，编辑会话中
  用户显式清空名称/容量后，行标题仍显示旧值（高级输入已空、保存补丁的 `unsetFields` 正确、
  落盘数据正确；保存刷新后显示恢复为真实有效值）。本轮按“只修 Blocker/Important”的范围
  要求记录为遗留；建议后续把回退限制在 remote/cache 来源（两行改动）。
- 复审对遗留处置的意见：同意发现 3（缓存首屏）与 Nit 7 作为遗留，但要求验收报告明确
  “未修复”，并作为用户的显式决定项；不能据此宣称计划第 6 项或缓存首屏已完成。

### 8.3 最终收尾轮独立安全审查（`2eac7a2..HEAD`）

- 范围：FIX-01…05、桌面资格与凭据窗隔离、缓存端点、P0–P6 边界；只读审查，
  探针全部使用临时目录/fixture，未触碰真实凭据或真实项目数据。
- 结论：**Blocker 0 / Important 2 / Nit 3 / Pre-existing 0**；审查期间新增的缓存
  修复（`1da8241`）已关闭其在旧 HEAD 上复现的迟到缓存跨服务/认证来源合并（F2）。
- 处置：
  - F1（Important）凭据窗 session 排除按不存在的 `Session.getPartition` 判定，
    分支永不命中：已改为 Session 实例比较（`c00d7b0`）；`electron-guard` 32b
    固化「实例比较 + 分支无 `openExternal`」，改回 `getPartition` 时 123/124
    失败（变异验证），恢复后 124/124。
  - F3（Important，证据类）FIX-05 用例用 `builtIn:true` 时旧的凭据目标守卫会
    先行拒绝，新增检查未被覆盖：已改用 `builtIn:false` 并补「仅模型覆盖」记录
    用例；删除显式检查、改回 `previous` 比较两种变异都会让用例失败（`7d68158`）。
  - N1 `hasSwitch` 抛错不 fail closed：已改为 `desktop_unqualified`，阶段 A 增加
    断言（42 条）。
  - N2 仅含 `modelOverrides` 的内置记录被误判改端点：改为与目录预设比较，
    同目标更新 200、换端点 409。
  - N3 迟到响应丢弃时不清 `cacheBootstrapKey`：已在丢弃路径清空；缓存身份补上
    暂存凭据动作/草稿标识（不含密钥值）。
- **聚焦复审（安全，`4919901..d70d0fb`，只读）**：F1/F3/N1/N2/N3 全部确认关闭，
  未发现新的可证实问题（Blocker 0 / 开放 Important 0 / 新增 Nit 0）。复审独立复跑
  `electron-guard` 124/124、`test:provider-management` 164/164（92s）、UI 67/67，
  并对修复做临时副本变异（删除显式端点检查 → 由 409 变 `saved:true`；预设比较改回
  `previous` 比较 → 由 200 变 409），鉴别力与本报告一致；复审未修改工作区。
  复审同时确认 `f59ceb3`/`d70d0fb` 的 `draft.removed` 过滤逻辑正确。
- 记录但未新增测试的风险：`pi-credential` 来源的目标缓存命中路径没有专门用例；
  代码要求 `storedEvidence` 同时满足 `present/literal/opaque revision`，异常、
  未知、OAuth、暂存来源一律不命中（fail-closed），未发现缺陷。
  客户端缓存身份不含原生凭据代次：首屏请求在途时轮换原生凭据，旧代次模型元数据
  可能被并入展示（仅展示、无秘密、绝不自动选择）；未实测触发。
  `electron-guard` 32b 为源码级断言，未在真实 Electron 中运行时验证
  `wc.session` 与凭据窗 partition 的实例相等（沿用生产 `browser-view` 写法）。
- 审查者本机正常沙箱启动失败并以 `--no-sandbox` 复跑阶段 B；本报告的正常沙箱
  证据使用同版本 Electron 副本（SHA-256 `bf0fe749…`），两者环境差异如实记录。

### 8.4 最终收尾轮独立功能审查（`2eac7a2..HEAD`）

- 首轮结论：Blocker 0 / Important 1 / Nit 3；Important 为迟到的 `GET /services/:id/cache`
  响应可并入切换后的新服务/新目标草稿（跨服务模型 ID 数据完整性）。
- 修复与复验：`1da8241` 固定发起时的 serviceId、缓存身份键、目标签名与生命周期代次，
  并核对服务端回显；`4919901` 补切换服务/改凭据引用两条回归。复审确认 Important 已关闭，
  原三条 Nit（合同撤销语义、分区/撤销证据、错误体不回显断言）处置成立。
- 复审新增 Nit：改凭据引用会重置已合并集合，保存响应中的同一缓存列表会把刚移除的
  候选重新加回（保存补丁仍是显式 remove）。已修 `f59ceb3`：合并时跳过 `draft.removed`；
  `d70d0fb` 补「移除 → 改引用 → 保存」回归，移除过滤后用例失败（变异验证）。
- 复审一次聚合运行出现的单次 409 未能复现；发生窗口与本地变异验证（临时改坏同一
  分支）重叠，之后多次单测与聚合（163/163、164/164）均通过。保留日志，最终以
  本 SHA 的 canonical 与后续 CI 为准。
- 焦点恢复仍只有真实 Electron 证据（被 git 忽略的 `.shots/p6/provider-electron-fixture.cjs`），
  未纳入 canonical；复审意见为非合并阻断项。原因：jsdom 中管理弹窗复用同一
  `modalCard`，关闭后页面节点被替换，无法忠实复现真实设置面（settings surface）的焦点恢复。

## 十一、缺陷与遗留问题统计

| 级别 | 数量 | 处置 |
| --- | --- | --- |
| Blocker | **0** | 历史 Blocker（内置 API Key 供应商无法保存）已修复并有回归 |
| Important | **0** | 历史 5 个 Important（缓存首屏、内置覆盖确认、OAuth 重新启用、发现元数据显示、重选补丁冲突）全部修复；最终轮独立审查另发现 3 项（迟到缓存跨服务合并、凭据窗 session 排除死分支、FIX-05 回归无鉴别力），均已修复并做变异验证 |
| 影响使用的 Nit | **0** | 环境变量授权终态、显示回退、焦点恢复、锁图标、thinking-dots 假红均已修复；最终轮 4 项 Nit（合同撤销语义、分区/撤销证据、错误体不回显断言、移除后改引用复活）全部关闭 |
| 需要真实环境的未验证项 | 5 类 | 真实供应商网络/TLS、真实 OAuth/账户、真实安装升级、存储资格成功路径（宿主禁止改 DACL）、打包 GUI 内凭据输入（调试端口会按设计关闭资格） |
| 计划增强（非缺陷） | 2 | 自动推荐（缺可信聊天能力来源）、缺数值「未知」占位徽标（外观）；均有安全缺省行为 |

## 十二、需要用户批准的事项（发布前）

1. **推送 P6 分支并创建 PR，运行其 PR CI 与 CI gate**：本轮未推送、未建 PR（按授权边界）。
   最终 GitHub CI 状态见第二节；本地完整 canonical 结果见第四节。
2. **合并 P6 到 main**：合并许可未授予。
3. **版本号决定与正式发布**：版本由维护者决定；打 tag/推送 tag/正式发布均需单独明确授权。
4. **真实环境验证范围**：真实供应商网络/OAuth/账户、真实安装升级、存储资格成功路径需要
   外部授权或操作系统 ACL 权限；本轮按 D 类保留并给出准确原因。
5. **计划增强取舍**：自动推荐与「未知」占位徽标是否需要在默认开启管理功能前补齐
   （本轮未实现，均不影响当前安全与数据正确性）。

## 十三、安全回滚方案

- **代码回滚**：按提交反向回退 P6 分支（`d3fe10d` → `fb5c7ca` → `13f660a`）。`13f660a` 仅为
  测试；`fb5c7ca` 为图标渲染；回退后行为回到 P5 合并基线。无需数据迁移。
- **功能回滚（运行期）**：关闭 `PI_GUI_PROVIDER_MANAGEMENT`（管理路由返回 `unsupported`，
  旧入口继续使用同一配置仓储）；`PI_GUI_PROVIDER_KEY_INPUT` 默认本关闭，关闭即禁用受限
  窗/SDK 暂存与原生持久化。不得回滚写 `auth.json`。
- **数据回滚**：GUI 元数据在 `DATA_DIR/provider-management.json`，不含秘密，旧版本忽略；
  `models.json` 仍是 Pi 原生格式。若存在未完成的配置事务，先停止 GUI 写入并保留现场，
  按事务日志核对 before/after 摘要后恢复；冲突时保留双方并人工处理。凭据变更无法通过
  配置备份恢复（OAuth 需重新登录；原生 key 需重新输入）。
- **同步回滚**：`/sync` 只读，不产生进程重启；回滚不需要撤销同步状态。旧版本读取同一
  `models.json`，未知 GUI 字段不影响 Pi。

## 十四、结论

- **开发完成**：是。P0–P5 已合入 main；P6 最终收尾完成全部可修复遗留整改，并与最新
  main（含并行 CI 修复）安全整合。
- **P6 代码和安全验收通过**：**有条件**——历史台账中的可修复 Blocker/Important/Nit 全部
  关闭；完整 canonical（`d70d0fb`，退出码 0）与最终构建/打包结果见第四节/第九节；
  独立功能与安全审查（含最终聚焦复审）见第十节。剩余为需要真实外部授权或操作系统
  权限的 D 类未验证项。
- **允许合并**：**未授予**（等待用户独立复验与明确授权）。
- **允许发布**：**未授予**（未修改版本号、未打 tag、未触发 Release；正式发布条件见第九节）。

## 十五、本次提交与实际文件改动

分支 `codex/provider-management-p6`（基于 `cd243fb`，已合并 `origin/main` `0171455` 为 `2eac7a2`）：

| 提交 | 内容 |
| --- | --- |
| `13f660a` | thinking-dots 自动交替测试确定性化（已被并行 CI 分支采用） |
| `fb5c7ca` / `d3fe10d` | 锁图标 rect 渲染修复与回归 |
| `7af518b` | 内置供应商 env 引用保存 + 对称 `enable` 动作 |
| `799527a` | 首次内置模型覆盖确认后重试 |
| `7403c30` | 发现候选显示元数据 + 重新勾选撤销待删除 |
| `75224f4` | 上述功能缺陷回归 |
| `7621960` | P6 第一轮验收报告 |
| `2eac7a2` | 合并最新 main（含并行 thinking-dots CI 修复，无冲突） |
| `ebfc0ea` | FIX-04 桌面安全资格加固与凭据窗外链隔离 |
| `9024721` | FIX-01/02/03 缓存首屏、环境变量重试、显示回退 |
| `c85bf25` | FIX-05 内置端点显式拒绝 + 关闭弹窗焦点恢复 |
| `e8b6ea6` | 本轮回归测试（HTTP/UI/P5/资格） |
| `35dbafc` | 前端合同：服务缓存端点与语义 |
| `1da8241` | 丢弃不属于当前服务与凭据代次的迟到缓存响应 |
| `4919901` | 迟到缓存/目标分区/错误体不回显回归 |
| `c00d7b0` | 凭据窗 Session 实例排除、资格探测 fail-closed、内置端点边界 |
| `7d68158` | 凭据窗排除/内置端点边界/资格探测回归（含变异验证） |
| `f59ceb3` | 已移除的缓存候选不被保存响应复活 |
| `d70d0fb` | 移除后改凭据引用的复活回归 |
| 本报告更新提交 | `docs/provider-management-p6-acceptance.md`（SHA 见分支历史） |

生产文件：`electron/{desktop-qualification,main,provider-credentials}.cjs`、
`public/{api,providers}.js`、`public/provider-management/{contract,credentials,dialog,
discovery,model-panes,state}.js`、`server.js`、`server/{provider-management-discovery,
provider-management,provider-config-records}.js`、合同文档。测试：`provider-management-{http,p5,ui}`、
`provider-credential-desktop`、`electron-guard`。未修改版本号、未新增依赖、未改 CI 配置。

