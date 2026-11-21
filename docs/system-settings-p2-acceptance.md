# 系统设置 P2 验收记录

> **后续收尾状态（2026-11-21）**：[P2 最终定向修复](system-settings-p2-final-fix.md) 记录 `b2acedc7` 之后的本地端点授权、供应商元数据迁移与外部 Pi 代理边界。修复、独立审查与两版桌面专项已完成；完整 canonical 按用户要求在 293/300 个命令正常退出后停止，未通过完整验收。下文仍是 `b2acedc7` 的历史证据，当前结果与限制以上述报告为准；本次仅获 P2 提交和推送授权。

- **目标**：在 P1 上实现应用内网络配置、冷启动数据迁移和多桶缓存；保留电源、托盘、同窗口恢复、后台任务及更新退出协调。没有新增依赖、修改 Pi 本体、正式版本号或 CI 配置。
- **身份**：分支 `feat/system-settings`；before HEAD `9d1fd4e76b6cb2fb412a4a447b2ba6043c58e15e`。产品提交 `1ab11970db392abf2b2685973eec598e5b94de33`，测试提交 `9cd9c39f0fc42980ebf153c8bd9efa9448f4f975`；测试时的 P2 文件字节与这两项提交一致。本报告交付提交用 `git log -1 --format=%H -- docs/system-settings-p2-acceptance.md` 定位，最终 SHA 在交付消息中另列。不把基线 CI 或文档提交当作新行为的完整证明。
- **远端核对**：开发中已 fetch；`origin/main` 为 `af0432a0bc3b04c717a63ede3cc457e859401833`，P1 基线相对其 ahead 2 / behind 6。该 main SHA 的 [CI run 44753076800](https://github.com/HYJ1817/pi-gui/actions/runs/44753076800) 已完成且 success（push，attempt 1），只证明 main，不证明本轮 P2。main 新增 P5-A；本任务没有依赖其新执行模型，未在含其他未提交工作的工作区强行合并、覆盖同名未跟踪文档或清理其他产物。后续统一 PR 仍须核对合并结果与 CI。
- **风险 / 阶段**：高（网络能力、路径写入与恢复、维护退出）。初版证据与整改后证据分开记录；末轮受影响专项及 Source/Packaged P2 正常沙箱已通过，增量独立复核已收敛、未确认新 Blocker/Important，可按原授权提交/推送。**完整 canonical 待统一 PR CI**，本轮未运行完整本地 `npm test`；不创建 PR、不合并、不发版。

## 1. 勘察结论与实现取舍

沿用 Main-owned 设置 IPC、固定偏好文件写入原语、现有市场网络窄桥、provider discovery 的授权与 pinned transport，以及更新的后端维护闸门。没有建立第二套设置后端、通用文件操作 IPC 或任意 URL 代理 IPC。

参考固定在 [PI-Desktop `48a65582678ec04e018f90f8bc075253bad27085`](https://github.com/vastsa/PI-Desktop/tree/48a65582678ec04e018f90f8bc075253bad27085)：`docs/adr/0177-user-configurable-outbound-proxy.md`、`apps/desktop/electron/main/network-proxy.ts`、`packages/shared/src/network-policy.ts`、`packages/agent-runtime/src/system-proxy-relay.ts`。借鉴分离 Chromium / Node transport、系统代理解析及端点授权的思路，不复制其 runtime patch、React/CSS、默认宽松政策或代理失败后的 DIRECT fallback。

主要偏离及原因：

1. **独立网络文件**：P1 `system-settings.json` 的 v1 精确字段契约保持不变，网络另用固定 `userData/system-network.json`；复用安全原子写入，不粗暴扩充旧 schema。
2. **不是全局代理/VPN**：Chromium Sessions、Main/backend Node、受管 SDK worker 与外部 Pi 分别处理。Main 的 HTTP(S)/Node worker 使用冻结 resolver 与鉴权回环 gateway；外部 Pi/工具不继承 gateway bearer capability，system/PAC 不宣称控制外部 Pi。custom/direct 可按显式、无认证的代理环境策略投影，但仍不是任意程序的网络沙箱。不修改系统代理、Clash、VPN、TUN、路由或用户 Git/Pi 配置。
3. **不热改活跃 Agent**：保存应用于受管 Chromium Sessions；backend/SDK 和更新下载使用本次启动快照。外部 Pi 只得到 custom/direct 的明确环境投影，不把私有 gateway credential 交给可执行任意工具的 Pi；system/PAC 对 Pi 的覆盖明确不宣称。重启后生效项明确提示，不因保存而停止 Agent。
4. **不移动整棵目录**：原生选择 → 维护闸门 → 旧写者实际退出 → 下次启动冷复制 → 校验 → 原子切换。固定 profile、Pi、原始项目、Git、安装 runtime 不移动，原业务目录不删除。
5. **官方清理 API，不递归删除 Chromium 树**：磁盘文件只读计量；实际清理使用 Session 官方方法，不能把逻辑容量、磁盘占用与卷可用空间混为一谈。

## 2. 代码与所有者

| 职责 | 实现与边界 |
| --- | --- |
| 网络值契约 | [lib/system-network-policy.cjs](../lib/system-network-policy.cjs)：4 字段、代理地址/绕过列表校验、Chromium 配置与 direct env 投影。 |
| 网络 Main owner | [system-network.cjs](../electron/system-network.cjs)、[system-network-test.cjs](../electron/system-network-test.cjs)、[system-proxy.cjs](../electron/system-proxy.cjs)、[system-proxy-transport.cjs](../electron/system-proxy-transport.cjs)；Main 提前恢复，测试用临时 Session，gateway 生命周期随实例。 |
| Node/SDK 适配 | [system-network-agent.js](../server/system-network-agent.js)、[child-env.js](../server/child-env.js)、[provider-network.js](../server/provider-network.js)、Auth/标题/凭据 SDK worker 及 [mcp-market.js](../server/mcp-market.js)。Main capability 启动时交付 backend 后消费，绝不留在任意命令的环境中。 |
| 冷迁移 | [migration](../electron/system-storage-migration.cjs)、[boot](../electron/system-storage-boot.cjs)、[fs](../electron/system-storage-fs.cjs)、[inventory](../electron/system-storage-inventory.cjs)、[policy](../electron/system-storage-policy.cjs)、[Windows 检查](../electron/system-storage-windows.cjs)、[startup](../electron/system-storage-startup.cjs)、[desktop](../electron/system-storage-desktop.cjs)。 |
| 维护闸门 | [system-maintenance.cjs](../electron/system-maintenance.cjs)、更新控制器的独占 lease、后端既有维护入口与终端写者计数。 |
| 缓存 | [system-cache-p2.cjs](../electron/system-cache-p2.cjs)、[system-cache-disk.cjs](../electron/system-cache-disk.cjs)；旧 [system-cache.cjs](../electron/system-cache.cjs) 保留 P1 fallback。 |
| UI / IPC / 构建 | [network card](../public/system-settings-network.js)、[storage controls](../public/system-settings-storage.js)、原系统页与 CSS；preload 9 个具名能力；[main](../electron/main.cjs) 组合与收尾；构建复制共享 policy。 |

## 3. 网络行为与安全

### 配置、测试与生效

默认 `system` / `relaxed:false`。custom 支持**无认证** HTTP、HTTPS、SOCKS5、SOCKS5H；SOCKS5 在本实现中由代理解析域名。拒绝 userinfo、query/hash、额外 path 与不合法端口；Renderer 粘贴含用户名/密码的地址立即清空，不发送 IPC、不持久化或回显。绕过列表最多 2048 字符 / 64 项，仅域名、后缀、IP 及可选端口，不支持 CIDR、裸 `*` 或 `<-loopback>`。

保存先配置受管 Sessions，再原子持久化；失败尝试恢复，无法确认恢复则明确要求停止发起新操作并重启。启动时配置或原生代理应用无法确认，阻止后端启动，不静默 DIRECT。新 Runtime Session 的首个页面请求之前等待配置；旧连接不强制中断，**不能保证所有在途 socket 立即换线**。

Main-only 连接测试固定为 `HEAD https://registry.npmjs.org/-/ping`：无 key、无模型、无响应正文消费和重定向；Renderer 不能传 URL、header、CA 或 credential。实测使用 TEMP TLS endpoint/CA 与本机 recording proxy 注入，未访问真实 registry。strict 检查全部 DNS 答案并连接已验证 IP，TLS 使用原 hostname/SNI；relaxed 仅在 proven-proxy 且 DNS 答案为 public/benchmark 的受限组合中允许远端 hostname 解析，不声称掌握代理最终 IP。

回环 gateway 仅监听 `127.0.0.1` 随机端口、实例随机鉴权、有超时和连接上限，拒绝 Origin 请求、407 和不支持线路，不静默直连；不做 TLS MITM。仅对“受支持代理前缀 + 尾随 DIRECT”的 PAC 列表兼容：去掉 DIRECT 后最多尝试 4 个代理，仍须全量 public DNS 并 pinned-IP；原始列表的 unknown 不被改为 proxied，不能取得 relaxed/Fake-IP 许可，其他 unknown 仍拒绝。随机 bearer capability 只在 Main 与启动时直接创建的 backend 之间短暂传递；backend 启动时从环境移除，只保留在进程/受管 SDK worker 的内存传输初始化中。不会通过标准代理环境变量传入 Pi、终端或安装子进程，也不进入 Renderer、日志或源站 header。普通 gateway 目标在任何 CONNECT 前检查完整 DNS 答案并固定到实测公网地址；Fake-IP 仅对 proven proxy 且独立 relaxed 已启用的答案（至少一个 benchmark 地址，且全部答案均为 public/benchmark）保留 hostname 远端解析。回环控制请求独立保护，不依赖用户 bypass。宽松模式不授权任意私网、metadata、本机服务、重定向或 agent 浏览器权限，TLS 校验始终开启。

### 实际通道覆盖矩阵

“线路实测”指离线 fixture 中确实记录到请求/CONNECT/TLS，不代表真实供应商认证或所有协议均通过。“源码/条件”不能当成线路通过。Main-owned 代理参数通过 gateway 转成 HTTP，不能把 SOCKS 配置直接塞给不支持它的外部客户端。

| 通道 / owner | 当前接入及证据级别 | 保留边界 / 未验证范围 |
| --- | --- | --- |
| 主窗口 / default Session | Main `setProxy`；真实 Electron 保存、DIRECT 与内部 API 可达 | GUI token 仍只向精确应用 origin 注入；不将主窗口变为任意代理 API。 |
| legacy Browser | 实际 `pi-gui-browser` Session 配置；原生缓存及页面生命周期实测 | 原有导航、GUI 自身地址隔离不放宽；导航守卫不是所有子资源防火墙。 |
| Runtime Browser | 既有与新 partition 配置，创建前 await；登记对象参与缓存 | Session 接线/生命周期回归，不宣称实测所有外站协议；agent 回环授权保持。 |
| 凭据输入窗 | 本地自定义 scheme，保持不联网 | 不新增外网通道；`connect-src 'none'`、沙箱资格保持。 |
| GUI 健康/浏览器控制/readiness | 回环直连；真实 backend 子进程 fetch 的 loopback 实测 | 私有控制 token 不得经过外部代理；不依赖用户填写 NO_PROXY。 |
| backend Node fetch / http / https | Main capability 启动时交付，backend 消费后初始化 Node 原生 transport；真实 Node HTTP/HTTPS 经网关 fixture | capability 从环境移除且不传任意子进程；本机 Node 24 / Electron 44 证明，不泛称其他 Node 或自定义 dispatcher。 |
| 新 provider discovery | 私有 worker 仅接收校验后的 Main capability；专用 pinned agent；实际授权 GET / TLS / checked-IP CONNECT 实测 | consent、credential revision、全部 DNS、路径、取消、响应上限、拒 3xx 保持。relaxed 不绕过此更严格策略。 |
| 市场 DIRECT / proxied | 沿用 pinned Node 与 Main 窄桥；own-gateway、strict/relaxed Fake-IP、mixed-private 回归 | 仅 proven proxy 放宽 benchmark DNS；第三方记录不获得任意内网权限；不扩大 bridge 请求能力。 |
| Classic / Runtime 外部 Pi | 显式 custom/direct 启动变量投影；Main 私有 gateway capability 不传给 Pi | system/PAC 模式无法安全地把带鉴权的 Main gateway credential 交给可运行扩展/工具的外部 Pi，故不宣称 Pi 已使用应用系统/PAC 决策；保留其继承环境/自有配置。未跑真实 Pi/模型。HTTP fetch 源码不证明 WS、Bedrock、各 provider 或扩展实际通过。 |
| Auth/OAuth SDK worker | 导入 SDK 前用公开 `http.setGlobalProxyFromEnv()` 初始化；真实 worker 内 fetch / http 线路实测 | fake SDK 返回离线结果；未验证真实 OAuth、刷新、系统浏览器授权页或各 provider 的特殊 transport。 |
| AI 标题 SDK worker | 同上；真实 `generate()` → fake SDK → 本机请求实测 | 不调用模型；保留无工具/无会话写入及输出投影。 |
| 原生额度 adapter | 同 Auth worker transport，53/53 相邻回归 | 未访问真实额度 endpoint；不等同 discovery 的 DNS pinning/逐跳拒绝。 |
| 配置额度 / NewAPI、旧 models API | 后端默认 fetch 经 Node 启动策略；源码接线、通用线路 fixture | 旧端点沿用自己的信任与重定向契约，不宣称已升级为新 discovery 的 consent/pinning。 |
| Node / MinGit 下载 | 后端 https 默认 transport；19/19 下载边界回归 | 未真实下载；每跳 HTTPS allowlist、size、digest、取消与解压权限不变。 |
| GUI / Pi 版本检查 | 后端默认 fetch，启动配置继承；源码接线 | 未访问真实 GitHub/pi.dev；各自 metadata/redirect 契约保持。 |
| 桌面更新资产/摘要 | 使用冻结专用 Electron Session 的 `net.request` adapter；redirect 事件交由 updater 逐跳检查，不使用会取消 manual redirect 的 Session.fetch | adapter 状态/Location、stream、Cookie、abort 单测；真实隔离 Session redirect 实测；未真实下载/安装。原 host allowlist、大小、SHA 与授权保持。 |
| 环境安装 npm、Pi self-update、能力安装 | 私有 Main gateway 不传入这些可继续产生任意子进程的安装器；custom/direct 仅按显式外部代理投影 | 未运行真实安装；system/PAC 与需 SOCKS/应用私有 transport 的实际兼容性未证明；npm/Git/helper 可用自身配置，不视为强制统一线路。 |
| Pi MCP HTTP | Pi 1.5.2 源码确认默认 fetch 可接 CLI dispatcher | 未对真实 MCP transport、流式/WS、认证与 redirect 实测。 |
| MCP stdio / npx / uvx | 仅条件环境继承 | server/config.env 可覆盖；程序自行支持，不承诺其请求经过 GUI guard。 |
| Git HTTPS / SSH | 不修改任何用户 Git 配置 | HTTPS 可有独立 proxy/helper；SSH 不受 HTTP env 保证，均未作真实线路证明。 |
| PTY / 任意命令 | 仅环境继承；113 项文件/终端相邻回归 | shell profile/程序可改写，不是网络沙箱。 |
| 受管开发进程 | 不为追求统一而放宽既有 env 白名单 | 明确未纳入强制代理；readiness 仍限回环。 |

外部 Pi 只读审计：本机包 `@earendil-works/pi-coding-agent@1.5.2` / undici `8.12.3`；上游 `v1.5.2` 为 `b4afdddf44e059c67ccf5097e5317d913521b470`，未做安装包与 tag 全量 digest 对比。Pi CLI 读取 HTTP(S)_PROXY / NO_PROXY，小写优先；不能据 ALL_PROXY 推断 fetch 支持。其 `httpProxy` 设置通过 `??=` 回填，direct 因此明确提供空 HTTP(S)/ALL proxy 及 `NO_PROXY=*`，不修改 Pi 设置。根 SDK 不等于 CLI 初始化，故 worker 另接公开 Node API。凭据 SDK 的精确 Pi 1.5.0 资格保持，未因本机 1.5.2 放宽。

## 4. 数据迁移及恢复

唯一固定引导是 `userData/system-storage-bootstrap.json`；优先级为显式 `PI_GUI_DATA` → managed pointer → 原 Electron 默认目录。override 不读写 managed 引导，UI 不允许覆盖。引导损坏、身份不符或无法读取时保守阻止，不猜测新根。

- Main 原生 picker 返回短时票据；Renderer 只能确认票据，不能提供任意复制/删除路径。目标须已存在、空、非重叠、非项目/Pi/安装/固定 profile；检查 ancestor、链接、hardlink、Windows reparse 和实际目录身份。
- 复用 backend maintenance；与 updater 独占 lease。任务、审批、活跃终端、浏览器等未排空不迁移，不为了预检通过强停活跃 Agent。prepare 后先写不可执行的 `intent`；只在同一 backend 返回 shutdown ack 且 parent 观察 exit code 0 后，将其原子 arm 为 `ready`；下次启动只有 `ready` 才冷复制。启动遇到残余 `intent` 会失败关闭并保留原根/空目标。
- 下次启动在日志、浏览器和后端之前冷执行；限制 12000 entries、总 16 GiB、单文件 2 GiB，256 KiB 块，`wx`、flush、集合/size/SHA/身份复核，最后原子切 pointer。后端报告实际 DATA_DIR 与新根一致才记 active。
- **白名单**：`projects.json`、`session-flags.json`、`session-titles.json`、`session-title-settings.json`、`conversations.json`、`mcp-market-sources.json`、`mcp-registry-catalog.json.gz`、`environment.json`；目录 `plans`、`planner-sessions`、`trash-sessions`、`review-comments`、`collab-documents`、`.uploads`，内部形状也校验。
- **排除**：Pi Agent/原始项目/Git、Electron profile 与登录状态、固定设置/网络/窗口/主题/更新偏好、日志、安装 runtime、引导本身。不是把 `.pi` 搬家。
- **保守拒绝**：Worktree/candidate、provider 跨目录 authority、真实 revert/review 证据、未知文件和事务。正常空 `revert-evidence/v1/objects` 骨架仅在递归证明确实空后排除；0 B 的 journal/object 也不能当空骨架。

| 中断/失败阶段 | 权威根与恢复纪律 |
| --- | --- |
| intent 前或预检失败 | 原根不变；不复制、不切换。 |
| durable intent，尚未收到旧 backend 的成功退出见证 | 启动拒绝冷复制并记录失败；原根权威、目标不写。 |
| shutdown ack + parent 观察旧 backend exit code 0 后 `ready` | 才能在下次启动、所有业务 writer 创建前执行冷复制。 |
| intent 已存、旧写者未确认退出 | intent 不可执行；启动拒绝复制并将交易标记失败。当前进程若无法确认撤销 intent 或恢复 backend，则保持 recoveryBlocked，不继续写或进入更新安装。 |
| ready 尚未写入或 arm 失败 | 未授权任何冷复制；目标保持空、原根权威。旧 backend 已停止时提示用户人工重启/检查，不回退或删除原数据。 |
| ready 复制到 staging 中断 | 不续写或删除未知半成品；记录失败，原根仍权威，原目录保留。 |
| verified，未切 pointer | 再次完整校验后才允许切换；不凭上次成功跳过复核。 |
| committed / 新根启动失败 | pointer 已是新根；不自动回旧根造成双写分叉，保留明确失败状态供恢复。 |
| active | 新根权威，原根为保留备份；后续有新写入后不能盲目回旧根。 |

configured port probe 不是任意外部写者探测器；同账户恶意程序在最后检查与系统调用间的竞态，不是本实现的 OS-handle 级沙箱保证。拒绝路径与故障注入、子进程阶段强杀分别验证，不将注入 EIO/ENOSPC 当成真实磁盘耗尽或断电。

## 5. 缓存桶与保护数据

| 固定桶 | 统计 / 清理 |
| --- | --- |
| default Session HTTP 磁盘缓存 | 官方 `getCacheSize()` 逻辑量 + 固定 `Cache` 文件树实际占用；只用 `clearCache()` 清理。 |
| legacy Browser HTTP 内存缓存 | 同一个非持久、无 storage path Session 的 `getCacheSize()` / `clearCache()`。 |
| Runtime Browser HTTP 内存缓存 | 所有已登记、尚未 retire 的 Session，包括关闭/隐藏 view，不按当前焦点挑桶。 |
| default Session Code Cache | 可验证时只读固定 `Code Cache` 并用 `clearCodeCaches({})`；无法确认则明确排除，不假 0。 |

GPU 无已证明安全官方清理 API、MCP registry 未接 backend owner adapter，均明确排除。没有通用递归删除接口、Renderer 目录参数或无差别 `clearStorageData()`。Cookie、LocalStorage、IndexedDB、登录状态、业务文件、供应商凭据、Pi 会话、撤销/恢复证据、更新文件及日志不清。

单飞统计/清理，60 秒一次性票据；集合、Session/文件树身份、容量增长和到期逐步复核。unknown 保持 null；`bytes = diskBytes + memoryBytes`，官方逻辑 payload 另列。只有清后实际文件占用下降才 `diskReleaseConfirmed:true`。文件/目录元数据、pending OS handle 或运行中再生可令结果 partial，不宣称卷空闲空间一定增加或总容量归零。

## 6. 整改前实测与交付证据（历史）

环境：Windows 11 Home China `10.0.26200`；Node `24.22.1` / npm `11.19.1`；Electron `44.4.3`（Node `24.21.0`）。写入全部在独立 `os.tmpdir()` fixture，fake Pi/SDK，不读写用户真实业务、不调用模型、不下载依赖；主后端/Chromium 离线守卫独立确认。

| 命令 / 范围 | 实际结果与证据范围 |
| --- | --- |
| `npm.cmd run test:system-settings` | 预整改历史 **165 项执行通过、1 skip、0 失败**，不代表整改后。 | task `b9zm7rkt5`；整改后 serial run `b12u3szn3`：183 passed / 1 permission skip / 0 fail，exit 0。 |
| `npm.cmd run test:app-update` | 历史基线 11 套 / 145 项；整改后 12 套 / 151 项，单独更新 suite exit 0。 |
| `npm.cmd run test:session-title-ai` | 5 套分别 58 / 44 / 64 / 35 / 72 项通过，共 273，exit 0，离线模型替身。 |
| `node tests/provider-auth.cjs`、`node tests/native-provider-quota.cjs`、`node tests/provider-credential-sdk.cjs` | 110/110、53/53、12/12，exit 0；最后一套增加私有 capability 环境白名单证明。 |
| `node tests/files-terminal.cjs`、`node tests/runtime-browser.cjs` | 实际文件/终端 113、Runtime Browser 48 项通过；准确 Runtime 入口与最终日志见联合报告。 |
| `node tests/mcp-market.cjs`、`node tests/mcp-market-network.cjs` | 72 项 / 19 条通过，exit 0；另有 agent 套件的 Main gateway/Fake-IP 回归。 |
| `node tests/environment-install.cjs`、`node tests/environment-download.cjs`、`node tests/server-security.cjs` | 26/26、19/19、41/41，exit 0；不作真实安装或网络证明。 |
| `node tests/ci-test-plan.cjs`、`git diff --check` | 整改后 **297 leaves / 5 groups / coverage exact**；diff check exit 0。新增 updater transport 回归被 canonical alias 展开；计划检查不是执行完整测试。 |
| 正常沙箱源码 `node tests/system-settings-electron.cjs` | 120 checks / 8 次真实启动，exit 0；`%TEMP%/pi-system-desktop-AAGPsU/evidence`。 |
| 同上 `--p2-only` | 整改前历史 19 checks / 3 次真实启动，exit 0；`%TEMP%/pi-system-desktop-4NTdUH/evidence`。最新整改后 24 checks / 3 次启动见 §6.1。 |
| `npm.cmd run build:app -- --rebuild` | 离线构建 exit 0；416 资源、334.5 MB 整包；最新产物与打包运行证据见联合报告。 |

P2 源码磁盘占用值为整改前历史 **6,999,334 → 837,908 B**，partial；整改后实测值见 §6.1。262,144 B 附件迁移前后 SHA256 均为 `bb30230b4a79b25f8db24b49b7e3b385d8e9b623a74f7be79fcc6e2a9d44fb3e`；固定网络/引导未进入目标根，源附件仍存在。

最终正常沙箱打包验收、最小截图、产物 digest、独立审查处置和最终测试数字统一记录在 [P1 + P2 联合验收](system-settings-final-acceptance.md)，不把运行中的检查写成通过。

## 6.1 审查整改后复验

- 冷迁移新增 `intent → ready` arm checkpoint：启动时只有确认授权的 `ready` 才能复制；`intent` 会失败关闭。故障注入覆盖 commit rename 后丢失确认，重启不写目标。维护只有收到原 backend 的 graceful shutdown ack 并观察 exit code 0 后才 arm；异常/取消不会自动启动副本。源码 P2 三阶段最新结构化报告留在本机 `%TEMP%/pi-system-desktop-Ee6N0L/evidence/`；最新 latest packaged 对照报告留在 `%TEMP%/pi-system-packaged-h15ylv/evidence/`。仓库只归档代表截图和最小 JSON，不复制 profile 或运行日志。
- 网络 Session registration / save 以代际顺序等待，新增“注册先开始、save 中途发生”回归；在途注册完成后同次 save 仍将其配置到新策略。连接测试复用一个固定的非持久内存 Session；超时未完成的原生 route task 结束前拒绝重用，避免命名 Session 累积。
- gateway/Node private capability 从启动环境消费，不进入 Pi、terminal、安装进程及其后代；只有 Main-owned backend / 明确受管 SDK worker 启动 transport 时使用。外部 Pi system/PAC 覆盖不作保证；custom/direct 是无密钥代理投影。Gateway 普通 DNS 在 CONNECT 前检查全部答案并 pinned public IP；mixed-private/loopback/internal 均拒绝；proven-proxy + relaxed 才允许 public/benchmark 答案组合中的远程 Fake-IP hostname 解析。
- 外部 updater 的 frozen Electron Session 使用 `net.request` adapter，以同步 redirect 事件向现有 updater 返回 `status`/`Location`，不自动 follow；allowlist 仍由既有 updater owner 在每一跳重新校验。适配器测试覆盖未跟随、stream、Cookie 禁用及 abort。
- 维护 gate 按 owner 区分 update/storage；idle terminal 不会无谓阻止普通 updater admission，且更新 owner 不能被 storage release。无 updater 实例时可继续进行独立 storage 维护；更新仍保持现有 busy、installer 与 recovery gates。
- 整改后专项：`npm.cmd run test:system-settings` **183 passed / 1 permission skip / 0 fail**；`npm.cmd run test:app-update` **12 suites / 151 pass / 0 skip / 0 fail**；`npm.cmd run test:session-title-ai` **5 suites / 273 pass**；`npm.cmd run test:mcp` exit 0；`node tests/files-terminal.cjs` **113 checks**；`node tests/modules.cjs` **121/121**；`node tests/runtime-browser.cjs` **48/48**，`node tests/gui-browser-host.cjs` **18/18**，`node tests/gui-browser-stop.cjs` **13/13**，`node tests/stop-barrier.cjs` **17/17**；Worktree/revert/startup suites **56/56、14/14、15/15、11/11**；`node tests/ci-test-plan.cjs` **297 leaves / 5 groups / exact**。`provider-auth`、native quota、credential SDK 为 110/110、53/53、12/12，exit 0。Provider-P2 的 network policy 40/40、credential opening 5/5 通过；desktop qualification 在默认 TEMP ACL 下 2/4 fail（`key_input_unqualified`）；沿用本轮已有离线 wrapper，仅给系统 TEMP 新建 fixture 设置私有 DACL 后，task `bme9bp75t` **43 桥断言 + 50/50 桌面检查**、exit 0。未绕过生产资格，首次失败保留；fixture 仍不证明真实 Pi SDK 或完整生产 Main 资格。
- 整改后正常沙箱源码 Electron：P1 **120 checks / 8 launches**，P2 **24 checks / 3 launches**，各 exit 0；latest packaged bytes：P1 **120/8**、P2 **24/3**，各 exit 0。首次 packaged P1 cleanup capture 有 10 个 residual identity、exit 1；在同一代码/产物上隔离重跑后残留 0。P2 三阶段均无残留捕获进程；源/profile 和目标都在 TEMP fixtures。
- Source cache 实测 `6,999,159 → 837,908 B`，减少 `6,161,251 B`，`partial` 且 disk release confirmed；latest packaged 为 `6,999,407 → 837,980 B`，减少 `6,161,427 B`，同为 `partial`。迁移在两版中均确认旧 backend exit 后才请求 relaunch；目标前仍为空，验证后 managed/active，源附件 SHA256 不变。实际截图现列在 [证据目录](ui/system-settings-p2-evidence/README.md)。
- Worktree lifecycle **56/56**、session-revert store **14/14**、revert admission **15/15**、session-change startup **11/11**，task `b6ggp1e53` 整条 exit 0。Runtime Browser **48/48**、Browser Host **18/18**；两份 Stop 装配 VM 增补真实只读 storage factory，原有停止时序断言不变，`bb1zyysd3` **13/13 + 17/17**、exit 0。
- 本节前述数字为首次整改证据，末轮当前结果已更新在 [联合报告 §1.1](system-settings-final-acceptance.md#post-remediation)：系统设置 **185 pass / 1 permission skip / 0 fail**、更新 **12 suites / 155 pass**，task `buc09u7xi` exit 0；市场网络 19/19、provider policy 40/40、canonical 计划 297 leaves/5 groups/exact。原生 source `%TEMP%/pi-system-desktop-sd9kZJ/evidence`、packaged `%TEMP%/pi-system-packaged-Fqc5LH/evidence` 各 **26 checks / 3 launches**、exit 0；末轮 build `bv7vk39hd` exit 0。源码磁盘 `6,999,334 → 837,908 B`、包 `6,999,230 → 837,980 B`，均 honest partial。
- 末轮 PAC gateway 只尝试去掉 DIRECT 的受支持代理前缀，禁止直连降级，且 unknown 不获得 relaxed/Fake-IP 授权。Updater owner 为提前拒绝/读取退出统一 dispose；native adapter 关闭 body/request，保留迟到错误收尾，WHATWG response 则 cancel。正常沙箱两版实测 header 拒绝保留 `checksum`、body 销毁、连接关闭、缓存目录 0 文件；合成迟到错误不逃逸。
- `npm test` 完整本地 canonical 按用户要求未运行；PR CI 尚待用户统一创建。两份初始审查任务已中断且不算通过；后续星驰窄复核已返回 3 条 Important：迁移双 EIO 由此前 guard 修复并在本轮加强真实 storage/maintenance 联测，PAC 与 updater 两项在本轮修复。仅对这些增量进行一次独立复核，实际模型 `xingchiapi/gpt-6.1-sol` 已确认：三项原发现均已修复，范围内确认 Blocker 0 / Important 0；复核未执行测试，不冒充作者实测的独立重跑或整个 P2/full canonical 通过。处置、夹具首次失败与最新产物摘要统一见联合报告。

## 7. 首次失败、取消及未验证

- P1 deferred quit 的微任务时序回归已修：单 pending 直接等待，双 pending 才聚合，原退出断言保留。
- 实机 fixture 修正：真实 session-title schema；Chromium 44 精确 profile 文件名；空 revert 骨架；等待页面网络 authority、缓存统计及确认框真正可见。磁盘扫描与合法写盘竞争时只做有界只读重测，不把 unknown 当 0，不降低容量等式、增长、取消或清理守卫。
- 多个抢焦点 Electron 测试曾取消其中一个，取消不计通过；最终桌面测试串行。旧 lifecycle-only 缺前置阶段、默认 Electron 路径启动异常、错误 `tests/terminal.cjs` 入口均保留失败，正确 `files-terminal.cjs` 已通过。
- 旧 provider-credential 桌面运行默认路径异常，自动 `--no-sandbox` 降级按正式资格被拒，未计正常沙箱通过。随后正常沙箱因用户 TEMP 继承权限被既有存储资格正确拒绝；仅在系统 TEMP 新建私有 fixture，不改用户目录权限。临时观察器曾因数字 SID 缺 `*` 前缀而准备失败；修正后最终 **43 项模块断言 + 50/50 桌面检查，exit 0**。完整失败记录与既有 harness 的资格证明限制见 [联合报告](system-settings-final-acceptance.md#凭据输入相邻专项及环境资格)，未放宽生产安全资格。
- 旧网络安全委派 API 400 没有审查结论，不作通过证明；最新两份独立审查及发现处置另列。
- Windows 文件 symlink 创建权限不足的 1 项 skip 单列；junction/hardlink/其他路径拒绝实测照常执行。代理套件曾去掉一处完全重复的 mixed-private 三条断言，唯一行为覆盖保留，并新增实际 Worker、Origin 与 gateway PAC 回归；未删除已有独立安全用例或降低断言标准。末轮套件数量只增加。
- 未验证完整本地 canonical / 当前 PR CI、真实 Pi/供应商/模型、任意第三方程序网络、系统浏览器 OAuth、真正 OS relaunch/关机/注销、真实签名/安装/原位升级、其他平台与恶意同账户末端竞态。测试拦截 `app.relaunch()` 并由 parent 在旧进程实际退出后启动下一进程，不能冒充 OS relaunch 全资格。

## 8. 回滚与决策

按业务代码、测试基建、证据文档的提交边界回退并重建，不 reset 共享分支或删除其他未提交工作。**已有 managed 新根时先停止所有写者并保全两根与固定 bootstrap，不能直接运行只认旧 userData 的 P1 包。** 若新根尚无新写入，可人工核验后选择根；若已有新写入，必须先做经过核验的恢复/合并，不能靠回旧 pointer 丢弃新数据。旧根从未自动删除，失败半成品也不自动递归清理。

禁用网络时先通过受控保存选择 system/direct 并正常重启；无法读取配置时保留原文件，在所有实例停止后人工修复。回退版可保留固定偏好文件，不能把它们或用户浏览器登录数据作为缓存删除。已清缓存可再生，不承诺恢复原缓存字节。

开发实现、专项证明、完整代码验收、合并和发布是不同阶段；最终状态见联合报告。用户选择 P1/P2 统一 PR，目前只授权本任务范围提交/推送，不含 PR、合并、tag 或发布。
