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

## 二、P5 main push CI 证据与失败处置

- 准确 SHA：`cd243fb78e304c9666849ab983baf5b02b564ac0`
- Run：[42606329154](https://github.com/HYJ1817/pi-gui/actions/runs/42606329154)，`push`（main），attempt 1
- 最终结论：**failure**。分组结果：
  - `Validate complete test plan`：success
  - `Electron build check`：success
  - `Tests (ui)`：success
  - `Tests (security)`：success
  - `Tests (native)`：success
  - `Tests (faults)`：success
  - `Tests (core)`：**failure** —— `node tests/thinking-dots.cjs` 退出 1
  - `CI gate`：failure（按设计拦截，未放行）
- **失败定性：测试缺陷（Pre-existing，PR #63 引入），不是产品缺陷、不是环境固定故障。**
  - 失败断言：`重复 start 不重置正在进行的那一段`（`tests/thinking-dots.cjs:220`，断言辅助函数在 `:53`）。
  - 根因：测试用两条独立 `setTimeout` 链做墙钟竞速；检查点名义余量仅 20ms
    （280ms 检查 vs 300ms 段边界），Windows 定时器合并与事件循环负载即可吃掉余量。
    产品语义本身正确（`public/thinking-dots.js:97` 的 `st.auto && !restart` 同步 no-op）。
  - 交叉证据：PR #67 头提交 `e24376b` 的 PR CI（run 42601713543）在同一天通过同一套件；
    本地在该 SHA 上复现约 1/3 概率（6 次运行 2 次失败，同一断言）。
- **P6 处置**：将自动交替一节改为虚拟时钟驱动（接管 Node 全局 `setTimeout/clearTimeout`
  手动推进），全部断言确定性化；原 7 条断言语义保留，新增段中途同步判别与无遗留计时器检查，
  87 → 90；变异验证（临时破坏 no-op 守卫）可同步抓获。提交 `13f660a`。
- 后续影响：P5 合并提交因此**没有有效的 main 精确 SHA 完整 CI 证明**；P6 分支的远程
  完整证明需在推送后由其 PR/main CI 提供（本轮未获推送授权，标为待验证）。

## 三、完整测试清单与实际数字

### 定向套件（本机，最终代码）

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm run test:provider-management` | **150/150**（最终代码；修复前 143/143） | 新增：锁图标回归 1、内置 env 创建/拒绝边界 1、disable→enable 1、UI 功能回归 4 |
| `npm run test:provider-p2` | 网络策略 39/39 + 开窗 5/5 + 桌面 47/47 checks，退出 0 | 桌面在**正常沙箱**下完成（`ELECTRON_OVERRIDE_DIST_PATH` 指向 TEMP 同摘要 Electron 44.4.3 副本）；1 条 `UNVERIFIED`（fixture 祖先存储策略，环境限制） |
| `node tests/provider-auth-runtime.cjs` | 50/50，退出 0 | 含同步协调器（`server/provider-config-sync.js`）与 OAuth 运行时 |
| `node tests/provider-network-policy.cjs` | 已含于 `test:provider-p2`（39/39） | 真实入口为 `node --test tests/provider-network-policy.cjs` |
| `node tests/provider-management-p5.cjs` | 已含于 `test:provider-management`（43 条） | 真实入口为同名文件在 `test:provider-management` 链内 |
| `node tests/smoke.cjs` | 1345/1345，退出 0 | 修复前运行；canonical 将复跑 |
| `node scripts/run-test-group.mjs --validate` | `241 canonical leaves; groups core, ui, security, native, faults` | 计划身份未变 |
| `node tests/provider-config-sync.cjs` | **不存在独立文件** | 同步协调器覆盖位于 `tests/provider-auth-runtime.cjs` 与 `tests/provider-management-http.cjs`（任务清单与实际入口的对应关系） |

### 完整 canonical

- 代码状态：HEAD `75224f4`（工作区仅未跟踪的本报告）；Windows x64，Node 24.22.1。
- 环境适配（如实记录）：仅在**测试进程**内设置 `PSExecutionPolicyPreference=Bypass`
  （未修改系统执行策略、未修改仓库脚本；沿用 P3-C 记录的做法），PATH 前置
  `C:\Windows\System32` 以避开 MSYS `whoami` 遮蔽。P5 曾因执行策略拒绝未签名 fixture
  中断完整链；本轮该阻塞消除。
- 结果：**退出码 0**，`ci-test-plan: 241 leaves across 5 groups; coverage exact`；
  全链无失败；耗时约 104 分钟（19:55–21:39）。
- 环境跳过（不计入通过分子分母，共 24 条，均与供应商管理无关）：
  SACL/SeSecurityPrivilege 18（`sacl-witness` 8、`Object witness` 8、`object-profile` 2）、
  符号链接权限 4（Collab store、Candidate adoption、logging-leaks、session-search 5i）、
  research-only 2（`session-revert-inplace`）。
- 关键套件实测：`test:provider-management` **150/150**；`test:provider-p2` 网络 39/39、
  开窗 5/5、桌面 47/47（本机共享 Electron 路径正常沙箱启动失败一次后按既有惯例回退
  `--no-sandbox`；正常沙箱证据见第六节）；`provider-auth-runtime` 50/50；
  `smoke` 1345/1345；`thinking-dots` 90/90。

## 四、凭据与网络安全审查结果

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

## 五、多 Runtime 安全专项（离线真实进程）

本轮自建证据脚本 `.shots/p6/multi-runtime-evidence.cjs`（开发期证据工具，Git 忽略），
使用生产模块 `server/rpc-bridge.js`（真实 spawn/stdio RPC）、`server/provider-config-store.js`
（真实双文件事务）与 `server/provider-config-sync.js`（真实协调器），两个独立假 Pi 进程
（A/B 各自会话文件与控制文件）。**36/36 检查通过**，实际数字：

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

## 六、真实 Electron 与视觉验收

### 6.1 正常沙箱

- 环境：Windows x64；Electron 44.4.3；`ELECTRON_OVERRIDE_DIST_PATH` 指向 TEMP 中同版本
  `electron.exe` 副本（SHA-256 `bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`，
  与 P2 记录一致）。共享安装路径在本机无法启动 Chromium 沙箱属宿主限制，使用仓库既有
  离线开关不改变被测代码与版本。
- **供应商管理 Electron 夹具 31/31 检查通过**（正常沙箱；`sandbox:true/contextIsolation:true/
  nodeIntegration:false`，无 `--no-sandbox`），console error 0，进程族 9、残留 0，截图 7 张。
  覆盖：启动与主窗口、供应商页、选择器（自定义端点固定在 API Key 组首位）、未授权零请求、
  凭据触发器默认禁用、授权→自动发现（真实回环 HTTP，仅 `GET /v1/models`）、勾选入右栏、
  保存落盘（TEMP `models.json` + 元数据）、编辑（端点只读、显示名写入、模型保留）、
  复制（不携带凭据、新 provider、无 apiKey）、停用（保留 Pi 配置）、删除（确认文案含
  `auth.json` 边界；只删目标）、760px 窄窗（无横向溢出、保存按钮在视口内）、Esc 关闭、
  5 次快速开合单实例、关闭/重开管理页、零 console error。
- **凭据受限输入窗（真实 Electron 正常沙箱）47/47 checks 通过**，无 `--no-sandbox` 回退；
  1 条 `UNVERIFIED`（成功持久化路径的 fixture 祖先存储策略不满足见证条件；P3-A 已在
  权限合格的系统临时目录完成该成功路径的实证）。截图 3 张（深色、浅色窄窗、清除模式）。

### 6.2 本轮修复的 UI 缺陷

真实 Electron 的 console error 检查发现：凭据区每次渲染报
`<path> attribute d: Expected moveto path command`，锁体不显示。根因是
`public/provider-management/dom.js` 的 `icon()` 只处理 `circle/path`，`lock` 图标的
`rect:5,10,14,10,2` 被写进 path 的 `d`。已修复为创建真实 `<rect>` 并补回归
（`tests/provider-management-ui.cjs`，54/54）。提交 `fb5c7ca`、`d3fe10d`。

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

## 七、打包与发布前预检

### 7.1 构建与打包（离线）

- `PI_GUI_ELECTRON_ZIP_DIR` 指向本机 Electron 44.4.3 缓存 zip，`npm run build:app -- --rebuild`
  **退出码 0**（内含 `build:exe`）；无新增下载、无新增依赖。
- 产物：`dist-app/Pi GUI-win32-x64` **345,945,131 bytes / 416 files**；
  `build/Pi GUI.exe` **103,741,440 bytes**，SHA-256
  `5232dd37efd58be6d323be578792538b5ecb99ae0965435734cf7ad69cc0c70b`；
  打包后端 `resources/app/server.cjs` 2,757,640 bytes，SHA-256
  `ba8c6bf462625e5eebe54078df19b0c21f2c722db87dd0fe709302564bff54f0`；
  私有凭据 worker `private/provider-credentials.cjs` 49,804 bytes。

### 7.2 打包专项与真实运行

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
    页面截图 `packaged-window.png`（103,526 bytes）。该运行使用调试端口（按设计会关闭
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

## 八、独立审查意见

### 8.1 安全与故障注入审查（独立上下文）

- 基线 `13f660a`（`origin/main` `cd243fb` + 测试修复），生产供应商代码与 main 完全一致。
- 结论：**Blocker 0 / Important 0 / Nit 0 / Pre-existing 1**，未发现可证实的阻断问题。
- PRE-01（Pre-existing，Nit）：`electron/main.cjs:899-902` 资格判定未覆盖
  `--remote-debugging-pipe`、`--inspect`、`ELECTRON_DISABLE_SANDBOX`。与设计文档的防御
  纵深承诺有差距；威胁主体属设计排除的同用户调试器，本轮记录不修改。
- 附注（非发现）：全局 `hardenWebContents` 对凭据 sheet 的 `will-navigate` 同样生效，
  外部 URL 会走 `shell.openExternal`；因 sheet 页面无导航入口与 sink（CSP `default-src 'none'`、
  `form-action 'none'`、纯 textContent），无可达攻击路径；建议后续从全局外部打开逻辑中
  排除该 session 或修正注释。

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

## 九、缺陷与遗留问题统计

| 级别 | 数量 | 处置 |
| --- | --- | --- |
| Blocker | 0 | — |
| Important | 0 | — |
| 本轮修复的明确缺陷 | 2 | thinking-dots 时序竞态测试假红（`13f660a`，阻断 P5 基线 CI）；锁图标非法 path（`fb5c7ca`/`d3fe10d`，真实 Electron console error + 图标缺失） |
| 功能审查发现（P0–P5 既有） | Blocker 1 + Important 5 + Nit 1 | Blocker 与 4 个 Important 已修复并有回归（`7af518b`/`799527a`/`7403c30`/`75224f4`）；缓存首屏（Important）与 env 缺失终态（Nit）未修复，列为遗留，需用户知情决定 |
| Pre-existing 记录 | 1 | PRE-01 桌面资格判定防御纵深（Nit，建议后续小改） |
| 遗留功能/Nit | 3 | 编辑缓存首屏（Important，功能级，需用户决定）；Nit 7 env 缺失授权终态；Nit N1 编辑期显示回退（保存数据正确） |
| 遗留/未验证 | 见第十一节 | 真实供应商网络、真实 OAuth、真实安装升级、P6 远程 CI |

## 十、需要用户批准的事项（发布前）

1. **推送 P6 分支并运行其 PR/完整 CI**（本轮未推送；远端完整证明缺失）。
2. **合并 P6 到 main**（合并许可未授予）。
3. **版本号决定与发布**：版本由维护者决定；打 tag/推送 tag/正式发布均需单独明确授权。
4. **是否在本轮后修复 PRE-01**（`--remote-debugging-pipe`/`--inspect`/`ELECTRON_DISABLE_SANDBOX`
   资格拒绝）——建议作为独立小改动，附安全审查。
5. **是否在将来默认开启 `PI_GUI_PROVIDER_KEY_INPUT`**：本轮未开启、不建议随本次发布开启；
   开启需要单独的安全决策与用户明确批准。
6. **是否接受「编辑缓存首屏」（Important，P0 计划第 6 项的一部分）延期**：未修复需新的
   缓存/记住目标状态机；默认关闭管理功能时无数据/安全影响。若计划默认开启管理功能或宣称
   计划第 6 项验收完成，必须先实现该能力。请在“接受延期”与“要求本轮/后续修复”之间决定。
7. **是否接受 Nit 7（env 缺失授权终态）与 Nit N1（编辑期显示回退）延期**：均无数据/安全
   影响；N1 建议后续与显示层改动一并修（回退仅限 remote/cache 来源）。

## 十一、安全回滚方案

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

## 十二、结论

- **开发完成**：是（P0–P5 已合入 main；P6 的验收修复与文档在独立分支）。
- **P6 代码和安全验收通过**：**有条件**——功能审查的 Blocker 与 4 个 Important 已修复、
  经聚焦复审确认并独立复跑定向套件；安全审查与聚焦复审无新增问题；完整 canonical
  241/241 条命令退出 0（24 条环境跳过不计入）；构建、`test:app`、`test:exe`、打包应用探针
  与 normal-sandbox Electron 专项均通过。遗留 Important 1 项（编辑缓存首屏，功能级）与
  Nit 2 项未修复，按 [REVIEW.md](../REVIEW.md) 需用户知情决定接受延期或指定后续修复，
  因此本轮不宣布无条件通过。
- **允许合并**：**未授予**（等待用户独立验收与明确授权；本轮不推送、不建 PR、不合并）。
- **允许发布**：**未授予**（未修改版本号、未打 tag、未触发 Release；正式发布条件见第七节）。

## 十三、本次提交与实际文件改动

分支 `codex/provider-management-p6`（基于 `cd243fb`）：

| 提交 | 内容 |
| --- | --- |
| `13f660a` | 修复 thinking-dots 自动交替测试的时序竞态假红（`tests/thinking-dots.cjs`） |
| `fb5c7ca` | 修复锁图标 rect 规格被写成非法 path（`public/provider-management/dom.js`） |
| `d3fe10d` | 锁图标 rect 渲染回归（`tests/provider-management-ui.cjs`） |
| `7af518b` | 内置供应商 env 引用保存 + 对称 `enable` 动作（`server/provider-config-records.js`、`public/provider-management/contract.js`、`public/providers.js`、合同文档） |
| `799527a` | 首次内置模型覆盖确认后重试（`public/provider-management/dialog.js`） |
| `7403c30` | 发现候选显示元数据 + 重新勾选撤销待删除（`public/provider-management/state.js`、`model-panes.js`） |
| `75224f4` | 上述功能缺陷回归（`tests/provider-management-http.cjs`、`tests/provider-management-ui.cjs`） |
| 本报告提交 | `docs/provider-management-p6-acceptance.md`（其 SHA 见分支历史） |

生产代码改动共 8 个文件，测试与文档改动 3 个文件；未修改版本号、未新增依赖、未改 CI 配置。
