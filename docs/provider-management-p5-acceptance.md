# 供应商管理 P5 验收报告

P5 从 `68b57c4d2ae46dba11d6b842217ccae43377886e`（`main`，P0–P4 与 P3-C 已合并）开始，实现在独立分支
`codex/provider-management-p5`。本轮只做前后端集成、必要的接口适配与测试，不重新实现 P2/P3，
不改变 P4 的视觉与交互基线，不修改版本号，不发布。

风险等级按 [REVIEW.md](../REVIEW.md) 计为**高**：变更触及 API Key 的 Electron 私有桥、`auth.json`
写入编排、供应商配置文件写入与 Runtime 同步。定向测试、canonical 链执行与补跑、独立复核与
正常的 Electron 沙箱验证分别记录，互不代替。

## 一、勘察结论与实现边界

- 复用 P4 的弹窗壳、双栏模型选择、reducer、陈旧结果守卫与兼容模式；新增的只有两个控制器
  （安全凭据入口、只读同步核验）与页面级同步横幅。
- 复用 P2 的 `providerCredentials` 私有桥与受限输入窗。主页面只拿到 `draftId`、状态码与原因码；
  密钥仍只在 `stage` 帧里从输入窗进入私有桥。
- 复用 P3-A 的配置优先提交与 `apply-staged`/`clear-native` 凭据动作；复用 P3-B 的授权 →
  `/discover`/`/test` 202 → 轮询契约；复用 P3-C 的 `/sync` 202 → 逐目标事实。
- 与任务描述设想的三处偏离，均以现有代码为准：
  1. P2 桥没有「关闭草稿」入口，P5 在 Electron 主进程与预加载中补了只携带 `draftId` 的
     `closeDraft`，由后端 `close-draft` 帧继续校验草稿与写入中状态。
  2. P3-A 的草稿投影原先不返回 `consentId`，前端无法把授权句柄绑定到后续 `/discover`/`/test`；
     P5 只投影与当前草稿/目标绑定的不透明句柄，原生凭据值仍不出私有桥。
  3. P3-B 的发现模式是后端真实接线能力，原先快照固定 `discoveryModes: []`；P5 由后端按
     `discoveryService` 与私有桥握手结果计算，前端不再自行猜测。
- 没有新增依赖，没有新增网络行为，没有改动 pi 本体或用户的真实认证文件。

### 集成中发现并修复的缺陷

真实 Chromium 交互暴露了一个被测试替身掩盖的生产接线缺陷：`dialog.js` 的默认 API 映射
缺少 `fetchProviderOperation` 与 `cancelProviderOperation`。测试夹具把这两个函数直接塞进
`api`，所以「授权 → 202 → 轮询」在 jsdom 里能过，真实页面却在 `poll()` 里把调用异常当成
网络抖动，一直重试到超时，界面停在「正在发现模型」。修复为在 `DEFAULT_API` 中接入真实的
轮询与取消函数，并新增一条不注入 `api`、只 mock `window.fetch` 的回归
`dialog polls operations through its production API wiring`，防止夹具再次绕开默认接线。

### 独立复核发现与处置

独立上下文复核了当前分支 diff，结论为**无 Blocker**，发现 1 个 Important 与 6 个 Minor，均核实为 P5
引入并有回归覆盖：

| 发现 | 处置 | 回归 |
| --- | --- | --- |
| Important：凭据失败/未确认时，若服务原有凭据仍在，快照的 `credentialState:'saved'` 会被误当成本次成功，清除失败甚至显示「配置与凭据均已保存」 | 只认提交回执的 `credentialSaved/credentialState`；失败与未确认一律保持错误态，清除过期的「已暂存」横幅，并如实说明 Pi 当前可能仍是操作前的旧凭据；清除失败改用「重新清除凭据」入口 | `a failed native clear is not reported as a successful save just because old credentials remain` |
| 放弃暂存后本地仍保留已被后端删除的草稿句柄，下次保存复用旧 `draftId` 会被 `draft_conflict` 打回 | `revokeDraftArtifacts` 同时撤销当前句柄与暂存草稿、清空句柄和草稿 requestId；放弃暂存改走同一路径 | `discarding a staged key forgets the deleted draft before the next save` |
| 桌面授权句柄缺少 `connectionRevision/targetFingerprint`，被误判为目标变化并清空候选 | 授权句柄补全绑定字段；`applyHandle` 不再把缺失字段当成变化 | `a desktop authorization handle without revision fields does not reset discovered models` |
| 网页模式切换视图只 dispose 控制器，服务端 consent 存活到 15 分钟 TTL | `disposeDiscovery` 先 `revoke` 再 dispose；网页模式同样撤销授权 | `leaving the setup view revokes discovery authorization even without the desktop bridge` |
| 受限窗 `load_failed` 不在终态集合，`open()` 会一直等到 180 秒超时 | `load_failed` 计入终态并映射为可重试的真实原因 | `a failed credential sheet load settles the open wait with an actionable reason` |
| OAuth 服务的「测试连接」仍可点击，实际跳进登录视图 | OAuth 服务禁用该菜单项并说明原因 | `OAuth services do not offer the discovery connection test` |
| 存储资格不足时，暂存状态仍写「保存时写入」，与保存会被阻止不一致 | 状态文案改为「保存时不会写入 auth.json（仅用于发现/测试）」 | 存储资格测试新增断言 |

第二轮复核只检查上述修复及新增测试，确认未发现剩余 Blocker 或回归，并确认没有放宽 P2/P3 的暂存、持久化与撤销条件；当时 P5 套件 24/24 通过。

## 二、交付内容

| 需求 | 实现 | 主要位置 |
| --- | --- | --- |
| 添加/编辑/复制/停用/删除 | 沿用 P4 列表与菜单；保存结果按 P3-A 回执分别展示配置、凭据与 Runtime 三种结果 | [providers.js](../public/providers.js)、[dialog.js](../public/provider-management/dialog.js) |
| 固定/自定义端点 | P4 连接字段与目录；复制不携带凭据 | [connection-fields.js](../public/provider-management/connection-fields.js) |
| 安全录入/替换/清除 API Key | 触发器接入 P2 受限窗；只有私有桥 API、握手、`keyStaging` 与存储资格同时成立才可用；暂存后主页面只显示状态，保存时映射 `apply-staged`/`clear-native` | [credentials.js](../public/provider-management/credentials.js)、[dialog.js](../public/provider-management/dialog.js)、[provider-credentials.cjs](../electron/provider-credentials.cjs) |
| OAuth 原路径 | 订阅账户仍走 Pi 原生登录；OAuth 槽位冲突的二次确认由原有私有桥路径处理，P5 不另建登录 | [dialog.js](../public/provider-management/dialog.js) |
| 授权后获取模型 | 授权 → 202 → 轮询；600ms 防抖、手动刷新、`force`、取消、超时、失败保留已配置/手工模型；迟到结果按 `dialogGeneration/requestSeq/connectionRevision/targetFingerprint/consentId` 丢弃 | [discovery.js](../public/provider-management/discovery.js)、[state.js](../public/provider-management/state.js) |
| 连接测试 | 同一授权与轮询纪律；只展示 P3-B 能证明的「端点可达 / 模型目录可读」，认证是否接受标为未知，明确「未验证推理调用」 | [model-panes.js](../public/provider-management/model-panes.js) |
| 搜索/筛选/选择/排序/手工添加 | 保留 P4 双栏与排序；远端结果只合并候选，只有用户选中的候选才以 `upsert` 进入保存 | [model-panes.js](../public/provider-management/model-panes.js)、[state.js](../public/provider-management/state.js) |
| 高级参数 | 仅合同允许的 `name/contextWindow/maxTokens/reasoning/input` | [advanced.js](../public/provider-management/advanced.js)、[contract.js](../public/provider-management/contract.js) |
| 保存冲突 | 409 保留草稿并提供重读；陈旧 revision 不落盘 | [dialog.js](../public/provider-management/dialog.js) |
| Classic / 多 Runtime 同步 | 页面横幅读取 P3-C 逐目标事实；「重新核验」只发一次只读 `/sync` 202 并轮询；不重启、不结束会话、不改模型或思考等级 | [sync.js](../public/provider-management/sync.js)、[providers.js](../public/providers.js) |
| 关闭/换目标撤销 | 关闭弹窗、换服务、改端点/认证来源时调用 `closeDraft` 并撤销发现授权；主页面立即收回「已暂存」文案 | [dialog.js](../public/provider-management/dialog.js)、[preload.cjs](../electron/preload.cjs) |
| 管理接口关闭 | 只有明确 422 `unsupported` 才使用旧版编辑路径；500/403/网络/合同异常停留在错误态，绝不降级写入 | [providers.js](../public/providers.js) |

## 三、安全边界

- API Key 明文不进入普通 HTTP、SSE、日志、诊断、主窗口 DOM、`localStorage` 或普通设置文件。
  主页面凭证区只有环境变量引用输入框、状态文案与触发器，没有密钥输入框；真实输入只在
  非持久化分区的受限窗口里发生。
- 前端不读写 `auth.json`。凭据的暂存、写入、清除与回读都经 Electron 私有桥与 P3-A 的
  SDK worker；主页面只收发状态码、原因码与不透明句柄。
- Web 模式、私有桥不可信、后端未开启密钥输入、SDK 未通过资格检查或存储资格不足时，
  相关按钮禁用并显示真实原因。P2/P3 的安全条件没有为了「让按钮可用」而放宽。
- `nativeCredentialPersistence` 现在由 `nativePersistence() === true` 计算（`auth.json`
  所有者/权限见证），而不是恒为 `false`；不满足时界面在保存前就阻止把暂存密钥写入。
- 暂存密钥的发现授权绑定到 approved 暂存代次与 worker epoch；`auth.json` 的旧状态不会
  被当成「无凭据」而放行需要认证的目录访问。

## 四、测试证据

### 定向套件

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| `tests/provider-management-p5.cjs` | 43/43 | 原有 24 条 + 本轮 19 条异步竞态回归（FIX-01/02/03，见第七节）：发现 202 轮询/迟到结果、同步事实与迟到守卫、暂存与关闭、未确认/失败凭据的真实文案、存储资格、目标变化、冲突后撤销旧暂存、OAuth 视图与菜单、页面同步横幅、管理关闭、生产 API 接线、草稿 consent 投影边界、发现模式能力过滤、load_failed 终态、旧页面关闭回调隔离 |
| `npm run test:provider-management` | 143/143 | 合同/store/HTTP/SDK/P4 UI/P5 六份套件 |
| `npm run test:provider-p2` | 39/39 + 5/5 + 47/47 | 网络策略、凭据开窗、真实 Electron 桌面；桌面含 1 条 UNVERIFIED 持久化检查，正常沙箱启动失败后回退 `--no-sandbox` |
| `tests/smoke.cjs` | 1345/1345 | 保存提示改为「Runtime 生效状态待核验」后同步更新断言 |
| `tests/provider-auth.cjs` | 109/109 | OAuth 路径未改 |
| `tests/runtime-models.cjs` | 52/52 | 模型展示未改 |
| `tests/model-fallback.cjs` | 74/74 | 回退路径未改 |
| `tests/ui-ia.cjs` | 27/27 | 导航/信息架构未改 |
| `tests/ux-state.cjs` | 15/15 | 状态文案未改 |
| `tests/theme.cjs` | 47/47 | 新增样式均使用既有 `--ds-*` token |

### 完整 canonical

本地 canonical 计划为 241 个叶子（`core 165 / ui 24 / security 27 / native 4 / faults 21`，
`node scripts/run-test-group.mjs --validate`）。完整 `npm test` 在本次整改工作区上运行
（日志 `.shots/npm-test-p5-fix.log`），**退出码 1**。
`pretest` 通过（`file-size-report 11/11`，`test:ci` 校验计划 241 个叶子、覆盖精确）；`test` 链在
`session-revert-sacl-witness` 之前的 36 条命令全部通过（含 `theme 47/47`、`object confirmation 45/45`），
随后停在 `node tests/session-revert-sacl-witness.cjs`，输出 `witness_unavailable` 并以 1 退出。

失败原因是**本机环境**，不是 P5 代码：该套件经 `h.one()` 启动
`powershell.exe -File tests/fixtures/session-revert-inplace-native.ps1`，而本机 PowerShell 执行策略
拒绝加载仓库内未签名的脚本（`UnauthorizedAccess`；此前同一环境也记录过 `NotSigned`）。把同一
脚本复制到 `%TEMP%` 后可以
运行并返回 `{"phase":"privilege","auditEnabled":false,"auditError":1300}`，即本应进入
`audit_privilege_unavailable` 的跳过分支。P5 未修改该套件、fixture 或执行策略；没有为了变绿而修改
断言或放宽系统安全策略。

为区分环境与产品，按 `package.json` 的同一链顺序补跑 `sacl-witness` 之后的 125 条命令（逐条记录
退出码，日志 `.shots/npm-test-p5-tail.log`，15:53–16:31）：**124 条退出 0，1 条退出 1**。唯一失败
是 `tests/session-revert-object-profile.cjs` 的 `54/55`，失败项同样调用上述未签名 fixture 的
`setup`，属于同一环境阻塞。依赖该 fixture 的另外 5 条命令（`session-revert-inplace.cjs`、
`session-revert-inplace-safety.cjs`、`object-writer`、`object-faults`、`object-witness`）未纳入补跑；
其中 `session-revert-inplace.cjs` 单独运行的结果为 `2/28; failed=26`，26 条失败均因原生脚本无法
启动。这些套件与 P5 的文件和功能无交集。

该补跑早于本轮最后几处前端改动；其中与本轮改动直接相关的命令已在最终代码上复跑：
`test:provider-management 143/143`（补跑日志中为 124/124）、`smoke 1345/1345`。其余关键数字：
`test:provider-p2 39/39 + 5/5 + 47/47`（1 条 `UNVERIFIED`）、`runtime-models 52/52`、
`model-fallback 74/74`、`ui-ia 27/27`、`ux-state 15/15`、`theme 47/47`，其余套件见日志。
跳过断言不计入分子分母；这些是各套件自身的输出，未把补跑结果冒充一次完整 `npm test`。

## 五、真实渲染证据

`.shots/p5/`（Git 忽略）由**真实 Chromium 157.0.8103.39 headless + 真实 `public/` 资源 +
真实视觉夹具服务**通过 CDP 采集，供应商管理路由由夹具拦截；其余 `/api` 仍走 `tests/visual-harness.cjs`。
采集脚本为 `.shots/p5-capture.cjs`（仅开发期证据工具，不进产品构建）。

| 截图 | 字节 | 场景 |
| --- | --- | --- |
| `01-page-sync-pending.png` | 71,662 | 页面同步横幅：Runtime A 待同步、Classic 已生效，按钮为「重新核验」 |
| `02-page-sync-applied.png` | 66,251 | 点击一次「重新核验」后，`/sync` 仅一次，横幅变为全部生效 |
| `03-dialog-authorize.png` | 86,109 | 编辑弹窗：未授权发现、双栏模型、凭据区无密钥输入框 |
| `04-dialog-discovery-ready.png` | 91,189 | 授权后 202 轮询返回 2 个远端候选；已选模型与顺序未变 |
| `05-dialog-test-result.png` | 94,052 | 连接测试：端点可达、模型目录可读、认证未知、未验证推理调用 |
| `06-narrow-test-result.png` | 66,707 | 760px 窄窗：双栏堆叠、正文滚动、操作保持可用 |
| `07-dialog-credential-staged.png` | 90,085 | 暂存后：只显示「新密钥已暂存」与「放弃暂存」，没有密钥值（注入假桥，见限制） |
| `08-dialog-credential-web-disabled.png` | 84,353 | 网页模式：凭据触发器禁用并说明「网页版没有 Electron 安全凭据窗口」 |
| `09-page-management-disabled.png` | 58,956 | 管理接口明确关闭：旧版列表仍可用，没有同步或凭据入口 |

截图 SHA-256 前 16 位依次为：`5be21d44d6222f25`、`d36dbbe0abad3212`、`b55e51c4ba153699`、
`53ac05ac022be4ac`、`97fe066ff48d0bc1`、`6af2fd666e25e328`、`9193b5029540fac5`、
`5c1ab13a8abea94c`、`0a085ecb40b46867`。

### 限制（如实记录）

- 这些截图证明的是**真实 Chromium 布局与真实 DOM 交互**，不是 Electron 外壳、不是打包安装、
  也不是正常沙箱运行；Chrome 使用 `--no-sandbox`，不能当作正常沙箱验收。
- 暂存凭据截图使用注入的假预加载桥，只验证主页面状态展示；真实私有桥与受限输入窗的证据来自
  `tests/provider-credential-desktop.cjs` 的 Electron 运行，不是这张截图。
- 没有向真实供应商发起发现或推理请求；候选、测试事实与同步目标均来自离线夹具。

## 六、Electron 与未验证项

`npm run test:provider-p2` 退出 0：网络策略 39/39、凭据开窗 5/5、真实 Electron 桌面 47/47。
运行日志明确记录 `normal sandbox failed to start in this environment; retrying with --no-sandbox`，
随后 47/47 通过；其中 1 条为 `UNVERIFIED P3-A successful Electron persistence:
fixture ancestors do not meet storage policy`。因此安全凭据窗的打开、暂存、取消、替换、清除、
OAuth 同槽二次确认、主题跟随与窄窗在**真实 Electron（`--no-sandbox` 回退）**中实际运行过；
这些结果来自源码入口，不是打包后的安装程序。

**正常沙箱未验证**。按任务要求，`--no-sandbox` 的运行结果不能当作正常沙箱验收；本报告不据此
声称正常沙箱通过。Chromium 截图同样不是 Electron 证据。

构建产物已按 AGENTS.md 重建：`PI_GUI_ELECTRON_ZIP_DIR=... npm run build:app -- --rebuild` 与
`npm run build:exe` 均退出 0（最终日志 `.shots/build-p5-fix2.log`）：

| 产物 | 大小 | 核对 |
| --- | --- | --- |
| `dist-app/Pi GUI-win32-x64` | 345,937,869 bytes（416 files） | `resources/app/public/` 下 4 个本轮变更前端文件与源码逐字节相同 |
| `build/Pi GUI.exe` | 103,734,272 bytes，SHA-256 `4715a49eeafc7c4b32a5976e0dd4a642f0cc63a3fc19e182790b229d72e25950` | 含本轮 `openAttempt`、`liveDraftOwners`、`cancel_unconfirmed`、`providersPageEpoch` |

打包核对：`credentials.js`、`dialog.js`、`discovery.js`、`providers.js` 在 `resources/app/` 下与源码
**逐字节相同**；`electron/preload.cjs`、`electron/provider-credentials.cjs` 与上一轮一致；后端打包在
`resources/app/server.cjs`。打包后的前端文件与 SEA 可执行文件都包含本轮竞态守卫标记。本轮
**没有启动打包后的应用**做交互验收。

首次重打包在下载 Electron 44.4.3 时遇到 GitHub HTTP 504；随后使用仓库既有的离线开关
`PI_GUI_ELECTRON_ZIP_DIR`，指向本机 Electron 缓存中由先前 `npm install` 校验并解压过的
`electron-v44.4.3-win32-x64.zip` 完成打包，没有新增依赖或新的网络行为。本轮整改后的两次重建
继续使用同一离线开关与已验证 zip，没有新的网络下载。

本轮明确未验证或不能作为通过证据的项：

- 正常沙箱下的 Electron 窗口交互与打包安装运行。
- 真实 `auth.json` 成功写入路径：夹具祖先目录的存储策略使一条持久化检查为 UNVERIFIED。
- 真实供应商网络的模型目录、认证失败、限流与推理调用。
- 真实多 Runtime 进程下的 P5 页面同步；P5 只消费 P3-C 已证明的逐目标事实与 202 协议，
  本轮没有重新启动实时 Runtime 复演 P3-C 的进程证据。
- 真实 OAuth 登录流程；P5 未改登录路径，只用回归确认订阅视图不出现密钥入口。
- 继承选择（`selectedModelIds === null`）的已知限制仍由 P4 的确认流程处理，P5 没有改变该行为。

## 七、独立验收后的异步竞态整改（FIX-01/02/03）

独立验收以 `8aa69fcba8fca1dece36eec1717f36110cb22fcb` 为基线，确认 P5 主集成完成，同时指出两组
Important 异步竞态和一处同步控制器复核项。本轮直接在同一 `codex/provider-management-p5` 分支修复，
不改变 P4 视觉与交互基线、不新增阶段、不修改版本号、不发版；P2 私有桥与 P3 的授权、单飞、撤销、
存储安全条件没有放宽。

### FIX-01：关闭/换目标后，迟到的凭据与草稿响应

**可复现行为**

- 点「配置 API Key」后草稿请求迟迟不返回，关闭弹窗；旧响应回来时仍会继续打开受限输入窗。
- 草稿请求在途时修改认证来源（`$NAME` 引用）；旧响应仍把服务端 `draftId` 写回当前弹窗，下一次
  保存复用旧目标句柄。
- 旧弹窗的迟到清理会把新弹窗正在使用的同名草稿 `closeDraft` 掉，连暂存凭据一起删除。
- 连点两次「配置 API Key」，在 `bridge.open()` 返回前会开出两个受限窗。
- 提交请求在途时换目标，旧提交的成功回执会关闭弹窗并显示为当前目标已保存。
- 目标变化时仅调用控制器 `cancel()` 时，仍在 `bridge.open()` 里的旧请求会在返回后重新挂起等待，
  占住凭据单飞槽直到 180 秒超时。

**根因**

- `ensureDraftHandle()` 在 `await saveProviderDraft()` 返回后直接改写 `draftHandle`，没有核对
  关闭/换目标/换草稿代次；`openCredentialSheet()` 与 `authorizeDesktopDiscovery()` 在关键 await
  之后也没有复核身份。
- 凭据控制器只有 `waiter` 单飞，没有覆盖 `bridge.open()` 尚未返回的窗口；`dispose()` 也没有兑现
  等待者；`cancel()` 不会让在途的 `open()` 失效。
- 迟到的服务端草稿没有统一清理入口，也无法区分「旧响应创建的草稿」与「新流程正在使用的草稿」。
- 提交回执没有代次校验，旧结果可以关闭/改写新草稿的状态。

**修复**

- 弹窗级 `lifecycleEpoch` 与目标签名：撤销草稿、换目标、关闭弹窗都递增代次；`ensureDraftHandle`
  在 await 前后核对代次与目标，过期响应只清理自己的服务端草稿，不写回当前界面。
- 草稿写请求通过 `draftSaveChain` 串行化，避免两个在途请求互相覆盖句柄与 revision。
- 模块级 `liveDraftOwners` 登记：草稿句柄被当前流程持有时，迟到的 `closeLateDraft()` 不撤销它；
  新流程接管同名草稿后，旧响应不会再删除新流程的暂存。
- 凭据控制器增加 `opening`、`openAttempt`、`disposed`：`open()` 单飞；`dispose()` 取消并兑现
  等待者；`cancel()` 使在途 `open()` 立即过期，不再重新进入等待。
- 提交回执在关闭后直接丢弃；目标/认证来源在提交期间变化时只显示「保存结果未应用到当前草稿」，
  不关闭弹窗、不宣称新目标已保存。

### FIX-02：取消/关闭后迟到的 discover/test 202

**可复现行为**

- `/discover` 或 `/test` 已发出、202 尚未返回时取消、关窗、切服务、改端点、改认证来源或撤销授权；
  202 迟到后本地丢弃结果，但服务端操作继续运行并占用该 provider 的单飞槽。
- 迟到结果仍可能被轮询或覆盖新的候选/测试事实；旧测试操作在状态里留下无 `operationId` 的
  「正在测试」。
- 取消请求失败（`not_found`、`config_conflict`、网络）可能抛到调用方，或把「已请求取消」
  直接说成「已停止」。

**根因**

- 两处「结果返回后 `isCurrent()` 不成立」的路径只 `return state`，没有取消刚拿到的 `operationId`。
- `abortActiveOperation()` 只处理 discover 槽；`configure()` 只在发现状态为 refreshing/debouncing
  时取消；`revoke()` 与测试流程没有统一撤销测试槽。
- 取消结果被丢弃，无法区分「已请求」与「后端已确认停止」。

**修复**

- `cancelOperation()` 每次使用新的 `newRequestId('cancel')`，返回结果且绝不抛异常。
- discover/test 的迟到 202 立即取消；取消失败时保留保守文案。
- `abortActiveOperations()` 同时撤掉 discover 与 test 两个槽；`configure()` 在目标/认证/能力变化时
  取消两个槽；`revoke()`、`poll()` 身份失效、目标句柄变化也取消；被顶掉的测试状态立即退出 running。
- `cancel()` 先显示「已请求取消，等待后端确认停止」；只有明确 `ok:true`、`not_found` 或
  `config_conflict` 才收敛为「已取消」，网络失败保留「后端未确认停止」。
- 没有缩短后端取消等待、没有放宽单飞或跳过服务端校验。前端只能确认「发出了取消请求」；
  没有停止证明时资源是否释放仍标为未确认。

### FIX-03：Runtime 同步控制器的旧回调

**复核结论与修复**

- 控制器本身已有 `generation` 守卫与 `state.saving` 单飞；页面层缺少生命周期代次：关闭设置页后，
  旧 `/sync` 续体仍可能清掉新页面的 `syncController`、刷新页面、对旧 revision 弹错误 toast，
  或继续写已销毁的标题/原因节点。
- 修复：`providersPageEpoch` 在每次打开/关闭时递增；订阅回调只在当前页且节点仍 `isConnected`
  时写 DOM；核验结束后先确认页面代次，再重读快照；若快照 revision 已变化，旧结果不再触发通知；
  关闭回调只在仍是当前页时才关闭菜单、停止全局控制器并清空列表/状态节点，避免旧页面
  关闭回调停掉或污染新页面。
- 重复点击仍由既有 `syncController` 单飞与 `state.saving` 双重保证；本轮没有改成并行请求。

### 新增回归与结果

全部竞态回归使用可控 Promise（`deferred()`）在任意时刻放行响应，不用固定 sleep 等待竞态；
`waitFor` 只等待可观察状态。新增 19 条：

| 类别 | 测试 |
| --- | --- |
| FIX-01（7） | `closing the dialog while the draft request is pending never opens the credential window`；`changing the authentication target while the draft request is pending cannot revive the old handle`；`a late draft cleanup never revokes the draft a newer dialog is using`；`rapid credential trigger clicks open only one restricted window`；`a save response that arrives after the target changed is not shown as the new draft success`；`disposing the credential controller settles a pending open and refuses a new window`；`cancelling the controller while the window open request is pending settles as cancelled` |
| FIX-02（8） | `a discover 202 that arrives after cancel is cancelled with a fresh request id`；`a test 202 that arrives after the discovery controller is disposed is cancelled`；`closing the dialog while a connection test is pending cancels the late 202`；`revoking discovery authorization while a test request is pending cancels the late 202`；`changing the authentication source while a test request is pending cancels the late 202`；`a new discovery during a pending connection test cancels the test and clears its running state`；`cancel followed immediately by a new discovery isolates the old late operation`；`cancelling after the 202 cancels the running operation and drops its late result` |
| FIX-03（4） | `a sync verification that finishes after the page closes cannot touch the reopened page`；`a sync result for an older revision is not shown as applied on the new configuration`；`a sync failure from an older revision is not reported on the new configuration`；`an old page close callback cannot stop the reopened page sync controller` |

执行结果：

| 命令 | 结果 |
| --- | --- |
| `node tests/provider-management-p5.cjs` | 43/43 |
| `npm run test:provider-management` | 143/143 |
| `node --test tests/provider-management-http.cjs` | 18/18（P3-B 管理路由、发现与连接测试专项，已含于 143/143） |
| `npm run test:provider-p2` | 39/39 + 5/5 + 47/47；桌面 1 条 UNVERIFIED，正常沙箱启动失败后按既有惯例回退 `--no-sandbox` |
| `node tests/smoke.cjs` | 1345/1345 |
| `node tests/provider-auth-runtime.cjs` | 50/50 |
| `node scripts/run-test-group.mjs --validate` | `241 canonical leaves; groups core, ui, security, native, faults` |

`npm run test:provider-p2` 第一次在本会话的 Git Bash 环境中因 PATH 先解析到 MSYS 的 `whoami`
而失败（`whoami: extra operand '/user'`），在测试进程 PATH 前置 `C:\Windows\System32` 后
39/39 + 5/5 + 47/47 通过；这是宿主 shell 的工具解析问题，不是产品代码或测试断言变化。最终代码上的
P2、auth-runtime、smoke 日志分别为 `.shots/test-provider-p2-final.log`、
`.shots/test-provider-auth-runtime-final.log`、`.shots/smoke-p5-final.log`。

### 复跑完整 `npm test`

完整链在本次整改工作区上运行（日志 `.shots/npm-test-p5-fix.log`），前置套件全部通过后停在
`node tests/session-revert-sacl-witness.cjs`：该命令退出码 1，输出只有 `witness_unavailable`，
因此 `npm test` 的最终退出码为 1。该命令单独复跑退出码同为 1；直接运行它使用的 PowerShell
fixture 助手时，本机执行策略拒绝加载仓库内未签名脚本：
`无法加载文件 C:\pi-GUI\tests\fixtures\session-revert-inplace-native.ps1 ... 因为在此系统上禁止运行脚本`，
`FullyQualifiedErrorId : UnauthorizedAccess`。这是宿主环境限制；没有修改系统安全策略、没有删除
测试、没有放宽断言。

失败点之后的 125 条链命令此前已在同一机器逐条补跑（`.shots/npm-test-p5-tail.log`，15:53–16:31），
124 条退出 0；唯一失败是 `node tests/session-revert-object-profile.cjs` 54/55，失败在共用同一
PowerShell fixture 的 `setup`（`bounded native fixture completes`），与主失败同因。该补跑早于
本轮最后几处前端改动；其中与本轮改动直接相关的 `test:provider-management`（143/143）与
`node tests/smoke.cjs`（1345/1345）已在最终代码上重新执行。完整链因 `&&` 在 sacl-witness 处
短路，没有继续执行后续命令；该次完整链在最后几处前端改动完成前启动，但短路点之后才有加载这些
文件的 P5 套件，相关套件已在最终代码上单独复跑。

### 残余风险与未验证项

- 取消是**请求**而非停止证明：后端 `not_found/config_conflict` 或网络失败时，界面保持
  「未确认停止」，不假定单飞槽已释放。迟到 202 到达前前端没有 `operationId` 可取消，此时立即
  发起的新操作仍可能被后端单飞拒绝；本轮没有为此放宽服务端单飞或缩短取消等待。
- 真实供应商网络、真实 `auth.json` 成功写入、正常沙箱 Electron、打包安装后的交互仍未验证；
  定向测试使用离线夹具和假私有桥，不能替代真实供应商或正常沙箱验收。
- 删除/覆盖暂存的安全语义不变：迟到清理只在没有活动流程持有该草稿时执行；安全凭据仍只经
  Electron 私有桥，主页面没有新增明文密钥路径。

## 八、文件与回滚

按回滚边界分成以下提交：

- P5 主集成生产代码：`9b7763472166acde5d97837539e5902559e667af`
- P5 主集成测试与测试入口：`707352a2cc74dcd6f1f7cd436fd82f295bc16180`
- 本轮 FIX-01/02/03 生产代码：`f0536d08095932ce84d432bb4925cda705872e81`
- 本轮异步竞态回归测试：`650e152d88e72d67b9158bdc63ed62f1f762a743`
- 文档与本报告：本节所在的提交（其 SHA 见分支历史）

生产代码：

- `electron/preload.cjs`、`electron/provider-credentials.cjs`
- `public/provider-management/{credentials.js,sync.js,dialog.js,discovery.js,state.js,connection-fields.js,model-panes.js,contract.js,provider-management.css}`
- `public/providers.js`
- `server/provider-credential-bridge.js`、`server/provider-management-discovery.js`、`server/provider-management.js`

本轮 FIX-01/02/03 实际只改 4 个生产文件：
`public/provider-management/{credentials.js,dialog.js,discovery.js}`、`public/providers.js`。

测试与文档：

- `tests/provider-management-p5.cjs`、`tests/provider-management-ui.cjs`、`tests/smoke.cjs`、`package.json`
- `docs/provider-management-frontend-contract.md`（把 P5 已接通的草稿 `consentId`、`closeDraft`、
  桌面能力与同步事实更新为当前实现）
- 本报告

回滚时先移除页面级同步横幅与凭据/发现控制器接线，再撤销 `DEFAULT_API` 的轮询函数与
`closeDraft`；P2/P3 的后端合同与既有数据格式不需要迁移。保留 P3 对新增内部元数据的读取
兼容，避免旧版本把新 sidecar 误判为不可读。

## 九、证据范围与验收状态

- P5 主集成 before HEAD：`68b57c4d2ae46dba11d6b842217ccae43377886e`；本轮整改基线：
  `8aa69fcba8fca1dece36eec1717f36110cb22fcb`；分支：`codex/provider-management-p5`。
- 定向测试与 canonical 链补跑均在上述基线加本分支工作区差异上运行；行为提交与仅补报告的提交
  分别列在第八节，不把旧运行称作新提交的 CI。
- PR CI、main CI、真实安装升级、真实供应商调用：本轮未运行，未验证。
- 开发完成（本地）：实现、FIX-01/02/03 异步竞态整改、定向测试、构建产物核对完成；完整
  `npm test` 因第四节所述本机 PowerShell 执行策略阻塞未取得绿色退出，失败点之后的链命令补跑
  与最终代码上的 P5 定向复跑均已如实记录。
- 代码验收：**待独立验收**；按任务要求推送后停止，不自行判定通过。
- 合并许可：**未授予**；不合并 `main`。
- 发布许可：**未授予**；不打 tag、不发布。

## 十、结论

P5 已把 P4 的供应商管理界面接到 P2/P3-A/B/C 的真实边界：安全凭据窗的暂存、替换、清除与撤销，
配置优先提交与独立凭据结果，授权后的发现与连接测试 202 轮询，以及 Classic/多 Runtime 的只读
同步核验。独立验收后的 FIX-01/02/03 已修复关闭/换目标后的迟到草稿与凭据窗口、取消后迟到的
discover/test 202，以及关闭/换页后的同步旧回调；P5 定向套件 43/43、
`test:provider-management` 143/143、P2 相关 39/39＋5/5＋47/47、smoke 1345/1345 等通过，
构建产物已重建并核对。

不能宣称完整 canonical 通过：本机 PowerShell 执行策略拒绝加载仓库内未签名的 fixture，完整
`npm test` 停在 `session-revert-sacl-witness`；按同一链补跑的 125 条命令中 124 条通过，唯一失败
是同因的 `object-profile` 54/55（补跑早于本轮最后几处前端改动，P5 相关命令已在最终代码上复跑）。
正常沙箱 Electron 与打包应用交互未验证。按任务要求已推送独立分支，等待独立代码验收；未合并
`main`，未发版。
