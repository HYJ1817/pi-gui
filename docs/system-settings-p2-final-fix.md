# 系统设置 P2 最终定向修复

> **2026-11-21：修复、重建、桌面验收和独立复审已完成；完整 canonical 按用户要求提前停止，P2 未通过完整验收。** §1–§5 保留交接前历史，§6 记录实测结果、停跑位置及本次交付身份。验证基线为 `b2acedc711be4192332889a9a1bbc3b1bcf3e653`；随后按相同已验证文件字节拆分提交，用户已明确授权本次 P2 提交和推送，不含合并或发布许可。

## 1. 范围与基线

- 只修复三项收尾：受控本地端点、供应商元数据迁移、Pi 代理范围与实际流量证据。不重做网络/迁移/缓存/生命周期架构，无新依赖，不改 Pi、本机全局 npm、Windows 代理、Clash/TUN/路由或正式版本号。
- 分支 `feat/system-settings`，before HEAD `b2acedc711be4192332889a9a1bbc3b1bcf3e653`。本轮尚无 after HEAD；完成后用 `git log -1 --format=%H -- docs/system-settings-p2-final-fix.md` 定位本报告的交付提交，行为与测试提交在最终消息单列。
- 精确 before HEAD 没有成功完整 CI 记录。已查明 main 的 `a7cb5c70e2f82c3ba64e8d36ad0fc444b1bab4c2` 为 [push CI 44863791310](https://github.com/HYJ1817/pi-gui/actions/runs/44863791310)，attempt 1、completed/success；它只证明 main，不证明本分支或本轮修改。按用户要求不运行完整本地 `npm test`，不能把这一例外隐去。
- 最新 main 已包含 P5-A/P5-B，核对时本分支相对 main ahead 5 / behind 10。共同改动路径包括 `package.json`、`public/app.js`、`server.js`、`tests/gui-browser-stop.cjs`、`tests/stop-barrier.cjs`；本轮工作区主要接线冲突在 `package.json`/`server.js`。没有合并、重置或覆盖 P5 文档及其他任务的未跟踪产物。统一 PR 必须重新检查合并结果与执行模型/时间线消费者。

## 2. 根因与实际改动

### 2.1 本地端点

旧 discovery transport 只接受公网 HTTPS，或原有显式无凭据 loopback 许可；全局宽松模式只用于可证明代理线路的 Fake-IP，不向 discovery/MCP editor 提供具体端点授权。

本轮复用现有草稿、connection revision、provider ID、目标路径、凭据来源/代次、launch identity 和 consent owner，不增设通用网络权限管理器：

- `lib/local-endpoint-policy.cjs` 仅识别明确的 `localhost`、回环 IP、RFC1918 IP 和 IPv6 ULA；LAN 域名、CGNAT、链路本地、metadata、Fake-IP/保留段不能获得此许可。`localhost` 全部 DNS 答案只能为 `127.0.0.1`/`::1`，IP 字面量必须逐个与授权目标一致。
- `server/provider-discovery-consent.js`、`server/provider-management-discovery.js`、`server/provider-network.js`：宽松开启且用户另行确认后，签发绑定既有草稿和目标的**无凭据目录读取许可**；只请求已有候选路径，仍拒绝重定向、URL 凭据、查询与不可信地址，使用验证后的 pinned socket，不关闭 TLS。关闭宽松后额外 consent 失效。不能跨供应商、草稿、路径或凭据代次复用。
- `public/provider-management/{contract,dialog,discovery}.js`：沿原授权动作弹独立确认，明确只读模型目录、不发送密钥/对话，不授权 Pi 推理及其他端点。无凭据目录成功不等于真实供应商认证成功。
- `lib/mcp-endpoint-permission.cjs`、`server/mcp-{config,manager}.js`、`public/mcp-settings.js`：手工编辑器的一次性 60 秒许可绑定 file/scope/name/revision/完整规范化配置；修改配置、跨服务复用、超时或重放均拒绝。额外许可不落原生配置。携带 headers 或未知认证字段的本地配置不获许可；市场/导入来源不能继承手工编辑器授权。
- `server/provider-config-records.js` 保留明文 HTTP 凭据限制：新增 HTTP 环境密钥引用不能借目录许可写入 Pi 推理配置；原生凭据目标资格仍要求原有可信 HTTPS。
- `electron/system-network.cjs`、`server/system-network-agent.js`、`electron/main.cjs`、`server.js` 只通过既有直属 Main/backend IPC 同步额外端点许可的资格，并确认 request ID。不会热换已有代理 socket 或停止 Agent；未确认 ACK 不返回保存成功。后端 transport 仍用启动快照。

**范围必须区分**：GUI 自己的目录请求可固定 DNS、凭据与重定向；MCP 保存仅证明写入已确认配置，不代表连接、重定向或运行中会话已经由 GUI 网络守卫接管。实际 MCP 与模型推理由外部 Pi 客户端管理，不作应用级网络沙箱声明。

### 2.2 供应商元数据与安全冷迁移

旧策略把 `provider-management.json` 和 Pi 原生文件旁的跨目录授权账本一并视为不可迁移 authority；仅凭文件名整体拒绝使正常元数据也被阻止。

本轮只调整资格层，不改 `intent → ready → cold copy → verified → committed/active` 的状态机：

- 新增唯一纯 schema `lib/provider-management-metadata.mjs`，由 `server/provider-config-store.js` 和迁移侧共享；不新建第二份可漂移 validator。
- `electron/system-storage-{policy,inventory}.cjs` 将 metadata 纳入业务白名单，16 MiB 上限，从同一 `readBound` buffer 验 schema；仅接受 owner 的原始序列化，拒绝重复键/未知字段/未来 schema，不改写排版或内容。现有 size、SHA256、身份、链接/reparse、目标目录及提交前复核保持。
- Pi `models.json`、`auth.json` 不迁移、不重写。其旁的 `.pi-gui-operations.json`、transaction、lock **存在即阻止**，包括 finished/authGeneration 账本，不删除证据来提高通过率。正常 metadata 本身无 credential/reference/path-authority 字段；已知字符串值仍可为用户自定义显示数据，不在报告归档原文。
- exact empty `worktrees.json` 可按原字节复制；只有已证明物理为空的指定 worktree/candidate 骨架可由 owner 在新根重建。UUID 工作树、Git 登记、候选记录、锁、未知后代，以及 0 B 的 journal/object 都继续拒绝。
- `system-storage-{migration,startup,boot,desktop}.cjs` 不按 Main cwd 猜测相对 `PI_CODING_AGENT_DIR`；迁移失败关闭并给出操作原因，但正常旧根 idle 启动不因此被误阻。
- `scripts/build-app.mjs` 用仓库已有 esbuild 从同一 MJS 生成打包所需同目录 CJS schema。无源码树 fixture 已验证加载与资源缺失失败关闭；真实包还需单列运行证明。

失败后仍保留原根、半成品与引导；新根已提交或启动失败时不自动回旧根，防止双写。回滚不能简单切回旧 pointer 或运行只认旧根的 P1 包。

### 2.3 系统代理与外部 Pi

根因是网络 owner 不同：Chromium/Main、backend/SDK 与外部 Pi 不是同一个 transport。Pi 可以运行任意扩展/工具，不能把 Main 私有 gateway capability 当成普通 HTTP_PROXY 交给它。安全收尾是保留现有隔离、验证可验证的真实流量并准确说明剩余限制，不建立未经验证的通用代理服务。

- 系统页分别呈现已保存值、Chromium 当前值、Node 启动快照和 Pi 的继承范围；`routeVerified:false` 不会被保存成功或连接测试抹成“所有 Pi 请求已走代理”。custom/direct 变更正常重启后作用于新的 backend/Pi；活动 Agent 不被中断。
- 只读研究核对本机官方 Pi 1.5.2：CLI 创建 Undici EnvHttpProxyAgent/global dispatcher，默认 fetch 和 Node WebSocket 有接线源码；SOCKS5 由代理解析 hostname，SOCKS5H 投影成客户端支持的 SOCKS5。**Bedrock 独立 transport 只支持 HTTP/HTTPS，不能泛称全供应商 SOCKS 可用**。研究不执行真实 Pi、不改变全局安装，未做安装包与 tag 全量 digest 对拍。
- direct 使用空 HTTP(S)/ALL proxy 和 `NO_PROXY=*`，阻止官方 CLI 的 `httpProxy ??=` 回填；不是绕过 TUN/VPN/系统路由的保证。
- system/PAC 没有把 Chromium 的 Windows resolver 决策送给外部 Pi。Pi 保留普通环境与自有配置；系统代理或 Clash UI 显示开启不等于 Pi 模型流量已使用该路线。

| 证据对象 | 本轮可以证明 | 不能据此推出 |
| --- | --- | --- |
| Classic + Runtime 生产启动链 | TEMP npm-shaped `.cmd`、真实 bridge/registry/guardian，确定性模型 SSE 替身的实际 socket 往返 | 官方 Pi 全 transport、真实账户/供应商或付费模型已通过 |
| HTTP CONNECT、SOCKS5/5H | 两个 owner 均记录目标 hostname/port、源站命中、RPC 返回的模型 marker；拒绝 407/TLS 不降级直连 | Bedrock、Bun binary、任意扩展/stdio/WS/OAuth 都采用同一路线 |
| direct、system 有/无普通代理环境 | 代理命中或零命中与源站请求均有记录；Main capability 不到 Pi 或后代 | 已验证 Windows 系统代理开/关、Clash Party system/TUN 开/关的真实外部出口对照 |
| 活动 Agent 期间保存新策略 | 原 run/进程继续，正在等待的请求沿原线路完成 | 对任意现存连接热换策略或强制网络隔离 |

**未验证**：Windows 系统代理开/关对外部 Pi 的真实出站差异、Clash Party system/TUN 的实际出口/分流、真实官方 Pi 模型请求和各供应商认证、Bedrock/WS/完整 MCP client。这些需要独立授权和适当环境；离线 fixture 不伪装成已完成上述实机验证。

## 3. 已执行验证与失败历史

环境：Windows 11 Home China 10.0.26200、Node 24.22.1、npm 11.19.1、Electron 44.4.3。所有业务写入在 `os.tmpdir()` 新 fixture；不调用模型、不下载依赖、不改真实用户数据。下列数字不是完整 canonical 总数。

| 命令 / 层 | 实测结果 | 证据 / 限制 |
| --- | --- | --- |
| `node --test --test-concurrency=1 tests/system-endpoint-final.cjs tests/system-network-final.cjs tests/provider-network-policy.cjs` | **57 pass / 0 fail / 0 skip，exit 0** | task `bxi0zodzn`。保持原 40 项网络安全断言，新增端点 13、状态同步 4。 |
| 新存储 suite + 原 storage/crash/desktop | **128 pass / 0 fail / 0 skip** | 原 storage/crash 51 + 新增 70 + desktop 7；已在最终 alias 重跑，不以旧子任务结果代替。 |
| `npm.cmd run test:system-settings`（最终 canonical alias） | **290 pass / 1 permission skip / 0 fail，exit 0** | task `beo75xkhw`；原 185 + endpoint 13 + network 4 + storage 70 + 外部流量 18。skip 仅 Windows 文件 symlink 权限。前一轮 `b71vll424` 的 272 不含最后 18 项，分开保留。 |
| `node --test --test-concurrency=1 tests/system-pi-network-final.cjs` | **18/18，exit 0，12.05 秒** | task `bm00w6s6l`。实际生产启动链 + 自写替身 transport，不是官方 Pi 认证。 |
| `npm.cmd run test:app-update` | **12 suites / 155 pass / 0 fail，exit 0** | task `b71vll424`，保留下载 adapter/early body disposal 等边界。 |
| `npm.cmd run test:mcp` | **7 suites / 406 项，exit 0** | 44+24+72+19+14+31+202，task `b71vll424`；配置/市场/导入/UI/native，不是原生 MCP 远端认证。 |
| provider contract/http/UI；server-security；modules | **108/108；41/41；121/121，exit 0** | task `b29m8pu60`。 |
| provider store/credential SDK/P5 | 初次 **75 pass / 3 fail**；私有 fixture store **20/20，exit 0** | task `blujiw9ei` / `bv1rwve9t`。3 fail 为既有 TEMP ancestor ACL 资格，不能忽略；只对本次新建空 fixture 设置当前用户独占 DACL，生产资格和父目录权限不改。SDK/P5 初次已通过。 |
| 自动标题 | **5 suites / 273 pass，exit 0** | task `b6namj2il`，58+44+64+35+72；fake SDK，不调用模型。 |
| 历史消息编辑 target/service/http/UI；files-terminal | **20/20、49/49、10/10、42/42；113 checks，exit 0** | 同 task `b6namj2il`；临时 fixture。 |
| Runtime registry / session runtime；Auth SDK / native quota；环境下载 | **42/42、7/7；110/110、53/53；19/19，exit 0** | task `b4inmz3gj`，仍为离线替身和临时文件，不证明真实供应商认证。 |
| canonical 计划 | **300 leaves / 5 groups / exact，exit 0** | task `beo75xkhw`；计划展开不是完整测试执行。相对原 297 增加 endpoint、network、Pi flow 三个 leaves，storage-final 加在原 storage `--test` leaf。 |
| 完整本地 `npm test` / 当前 PR CI | **未运行 / 待验证** | 用户明确不跑完整本地测试、不创建 PR；不能宣称完整验收通过。 |

失败与修复必须保留：

1. 上轮 endpoint 回归修复前 12 项中 10 fail；本次组合最初 127 项中 126 pass/1 fail，新增 scoped IPv6 guard 抛错被映射为错误的 `dns_failed`；修正后原 40 项与新增套件 57/57。
2. 窄窗首次几何失败并非裁切：150% DPI 下 `innerWidth=701` 而真实 viewport 为 701.333 CSS px。按真实视口的设备像素边界核验，不移除横向 overflow/控件边界断言。失败任务 `btfqlm80k`。
3. 新 IPC listener 使旧短进程 probe 的 IPC channel 保持引用，10 秒到期后 exit null；由测试 owner 在完成后 disconnect 自己的 IPC，并补齐启动状态新增字段断言，不提高超时或关闭生产监听器。首次 alias `b552q1w8m` 失败，修复后 `b71vll424` 成功。
4. 供应商原生凭据 store 在系统 TEMP 仍受本机 ancestor ACL 影响，3 项被既有生产资格拒绝。未放宽校验，仅使用本轮独立的私有空 fixture preload 后 20/20。
5. 外部 Pi fixture 初次 **5/16**、修正中 **8/16**：分别修正自写 SOCKS reader 的暂停/缓冲、Runtime owner 代次、registry 的 runtime_event 外壳与正确 RPC 时序。没有修改产品 Runtime/guardian 来迎合错误夹具；最终 18/18。
6. 增加实际对比度检查后，目录确认的 danger 按钮在深色 hover 为 **4.42:1**，不符合 AA。授权不是删除操作，改为公共 Primary 语义，不覆写共享 danger 色或降低阈值；后续真实四组截图/对比度复验记录在下一节。

## 4. Electron、视觉与重建

本轮源码已完成一轮 **54 checks / 3 launches，exit 0**（task `bgjh3oa91`，TEMP `pi-system-desktop-EDqXiu/evidence`），含实际 provider GET、MCP 原生配置写入/取消、磁盘清理、metadata 原字节复制和 Pi models/auth 原位保留。后续 120% 字体、中英文、键盘及最终包验证仍在执行，不沿用旧截图代替。

离线 `npm.cmd run build:app -- --rebuild` 最终 task `bm1vjecb4` 已 exit 0：416 resources、3.22 MB backend、11.09 MB blob、100.8 MB SEA、334.5 MB 整包。已包含最终 Primary 授权按钮语义；此前 `b80dax61n` 为按钮修正前的一轮，不把它当作最终包。此后仅增强测试夹具和报告，未改产品字节。

- Electron ZIP SHA256 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`；使用已有离线缓存，无下载。
- 正常沙箱、contextIsolation=true、nodeIntegration=false；观察 bootstrap 只在 TEMP 副本，不改用户数据或 dist manifest。真实进程身份/旧 backend exit 后冷启的证据按最终 runner 结果单列。
- SEA 仍有 `The signature seems corrupted!` 警告：构建成功不是签名、安装升级或发布资格通过。

最终代表截图、最小 JSON 与摘要待本轮打包验收成功后归档，不上传整个 TEMP profile、用户凭据或原始服务 payload。

## 5. 独立审查与交付状态

高风险：网络许可/凭据边界、文件复制与恢复及打包资源。一次独立安全/故障复核和一次独立迁移/打包功能复核正在进行；没有把旧 P2 的复核结论继承给本轮新 diff。发现与处置待补，审查尚未收口。

- 开发实现：三项定向实现已接入，最终验证进行中；Pi system/PAC 安全隔离与明确限制是有意保留，不谎称全面覆盖。
- 代码验收：**待验证**，完整 canonical 留待统一 PR CI，独立审查尚未完成。
- 提交/推送：用户已授权本任务范围集中提交并推送 `feat/system-settings`，本轮尚未执行。
- 创建 PR / 合并 / 发布 / 版本号：**未授权，未执行**。

回滚按产品、测试、文档提交边界 revert 并重建，保留其他任务的文件。已有 managed 新根时先停止所有写者并保全新/旧根与固定 bootstrap；新根有新写入时不得直接回旧 pointer。禁用额外本地许可通过系统页关闭宽松模式；外部 Pi 原生配置与会话加载状态仍独立管理。

PR CI 组名以当前 canonical 分组器为准：`core` 包含本轮系统设置/代理/迁移、供应商/MCP、SDK/标题和新外部流量套件，优先观察；`ui` 观察系统页相邻组件、Composer 和会话展示；`security` / `native` / `faults` 分别保留写入撤销、原生 writer、故障与进程回收的完整证明。test-plan、打包检查与最终 `CI gate` 仍须成功。没有在 workflow 或报告中另设第二份测试清单，主链完整展开为 **300 leaves / 5 groups / exact**（task `beo75xkhw`）。

## 6. P2 收尾复核（2026-11-21）

### 6.1 基线与四项发现

- HEAD/分支保持 `b2acedc711be4192332889a9a1bbc3b1bcf3e653` / `feat/system-settings`；无提交、推送、合并、发版或版本改动。保留全部既有修改、P5 文档、spike 与未跟踪产物，不 reset/clean/checkout。
- 本轮 fetch 后 `origin/main=a7cb5c70e2f82c3ba64e8d36ad0fc444b1bab4c2`，本分支 **ahead 5 / behind 10**。上一线程的成功 main CI 44863791310 已重新只读核实：push、attempt 1、全部测试组/打包及 CI gate success；精确 HEAD 的 `gh run list --commit` 返回空。main 证明不能替代 dirty 工作区。
- 第一次 `node --test --test-concurrency=1 tests/system-network-final.cjs tests/system-endpoint-final.cjs tests/system-storage-final.cjs` 实测 **93 tests / 87 pass / 6 fail / 0 skip，exit 1，24.19 秒**。失败并非环境：同值权限保存误报、旧 provider 授权/记住目标复活、MCP 旧 challenge 重放、在途目录 socket 未关闭、HTTP `piRegistrationReference` 可写入、相对 Pi 目录误挡 managed 根。未把中断前 290 项通过继承为当前结论。

| 发现 | 当前实现与边界 | 当前证据状态 |
| --- | --- | --- |
| 权限同步失败后重复保存误报成功 | Main 单独持有 confirmed/unconfirmed；ACK 校验 request ID、ok、实际 relaxed 与 generation；失败同值保存会重试。曾关闭失败后直接重新开启，必须先确认 strict 撤销屏障。页面重开仍允许重试，不靠改一个字段触发。 | 定向、独立安全检查及两版真实桌面同值重试通过 |
| 重新开启宽松复活旧授权 | backend 关闭时递增 endpoint generation，主动撤销 local consent/remembered 并 abort 信号；MCP challenge 指纹绑定同一 generation。重开须重新显式授权，公网 grant 不受影响；代理 transport 仍冻结。 | 作者与独立安全复核均观察到真实 IPC 使在途 HTTP socket 断开，重开旧授权无效 |
| 相对 Pi 目录误挡既有 managed 启动 | 只有现存 bootstrap/目录身份绑定根的打开允许 Pi 相对路径未知；不按 Main cwd 猜 Pi 目录；绝对 Pi overlap、其他保护根、native/identity/runtime 检查仍保留。任何新迁移/cold copy 仍要求可证明 Pi authority。 | 定向与独立存储复核通过；两版桌面完成正常冷迁移，不冒充在桌面重放全部故障分支 |
| 历史 HTTP 注册引用入口 | provider commit 的 `piRegistrationReference` 与环境凭据分支均不能向 HTTP 端点写入新引用；原始凭据不接收、不解析、不传递。页面字段对 HTTP 给出明确校验，HTTPS loopback 的原兼容范围不扩大。既有文件不自动删除/改写。 | 端点、供应商 UI、独立安全检查及两版真实桌面拒绝用例通过 |

### 6.2 本轮已执行与待验证

- 修复后四文件组合（增加 `tests/system-network-agent-p2.cjs`）**104 pass / 0 fail / 0 skip，21.09 秒**。
- `npm.cmd --offline --logs-max=0 --no-update-notifier run test:system-settings`：**296 pass / 0 fail / 1 skip，exit 0，124.21 秒**。仅 skip：Windows 无创建文件 symlink 权限（EPERM）；真实 junction/hardlink/native ADS 与原故障用例照跑。日志 `%TEMP%/pi-p2-closeout-targeted-qRdKgr/output.log`。之后补了同关闭失败→开启屏障和页面重开重试，各增加 1 项；296 不冒充最终 alias 数字。
- `node --test --test-concurrency=1 tests/system-network-final.cjs tests/system-settings-ui.cjs tests/provider-management-ui.cjs`：**108 pass / 0 fail / 0 skip，exit 0，12.36 秒**。新增回归而非减少断言。
- `node tests/modules.cjs` **121/121**；`node tests/server-security.cjs` **41/41**，均 exit 0。
- `node scripts/run-test-group.mjs --validate`：**300 leaves / 5 groups**（core 224 / ui 24 / security 27 / native 4 / faults 21），覆盖精确。实际 `npm test` 已启动，仍为待验证，不把计划当执行结果。
- 源码 Electron 默认路径在到达清理前 **exit 2147483651**，未记通过。新建同版本私有 runtime 副本继续正常沙箱验证；exe SHA256 与原文件同为 `bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`。第一次复制在 mkdtemp 本身使用 errorOnExist 导致 EEXIST、未启动；第二次在新建子目录成功，无旧目录覆盖。
- `npm.cmd --offline --logs-max=0 --no-update-notifier run build:app -- --rebuild --output-root <fresh TEMP build root>` **exit 0，18.69 秒**：416 resources / 3.22 MB backend / 11.10 MB blob / 100.8 MB SEA / 334.5 MB app。产物在 `%TEMP%/pi-p2-closeout-build-9YHm9g`，原仓库 build/dist-app 不覆盖。已有 Electron ZIP SHA256 重新核对为 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`，无下载；SEA 保留 signature seems corrupted 警告，不宣称签名通过。构建日志 `%TEMP%/pi-p2-closeout-build-vE9Az4/output.log`。
- `tests/system-settings-electron.cjs` 仅增加可选 `--output-root` 读取现有独立产物，仍复制到新 TEMP 后运行，并核验新增 state/advanced 资源摘要；不修改原 manifest/包。最终 packaged 串行验收仍待运行。
- 两份独立 review 已启动（同一星驰模型、独立上下文，不 fanout），分别覆盖端点权限/安全和冷迁移/schema/打包故障。未收到结果前不填通过。

本轮全部业务测试写入 TEMP fixture，未调用模型/真实 Pi，未下载依赖，不改全局 npm 或系统代理。首轮验证的源码清单含 965 个 tracked/相关 untracked 文件，SHA256 集合摘要 `d2b83ef409d2781179c01d992026e47e549bcd90988768958d76d5a7af35f440`，本机 `%TEMP%/pi-p2-code-identity-yEPcqN/source.json`；后续新增桌面夹具不在 canonical 链内。若产品行为变化仍须补验。

### 6.3 首轮重建与运行证据

- 首次完整 `npm.cmd --offline --logs-max=0 --no-update-notifier test` 卷入真实 Windows 权限/迁移/故障套件。系统设置段实际 **298 pass / 0 fail / 1 permission skip**（21、20、16、13、16、11、15、8、18、31、122、7 通过）；Classic/Runtime 外部 Pi 流量替身 **18/18** 计在其中。随后第 **154/300** 个叶命令发生 Windows TEMP 祖先 ACL 不符合既有凭据存储资格，供应商管理组合 **184 pass / 3 fail / 0 skip**，整条 npm exit 1（24 分 25 秒）。第 1–153 命令 exit 0，含环境相关子项 skip；后缀不能算已运行。原始日志 `%TEMP%/pi-p2-closeout-canonical-BHHaxX/output.log`。
- 仅在 `C:/Windows/Temp` 下新建空 fixture 并将其 DACL 设为当前用户独占，重验 `node --test tests/provider-config-store.cjs` **20 pass / 0 fail / 0 skip，exit 0**；未修改生产检查或真实目录权限。从第 154 个原 canonical 叶命令继续验证，后续如齐全只称「累计验证」，不称单次 npm test 成功。
- 打包资源/后端/SEA：`PI_GUI_SKIP_LIBREOFFICE=1 npm.cmd run fixtures` 生成英文最小 PDF 与中文 docx/png（中文 PDF 不是该 fixture 的承诺）；`node tests/app-check.cjs --output-root <build root>` **27/27**、`node tests/exe-check.cjs --output-root <build root>` **50/50**，失败/skip 均 0。验证实际授权 HTTP/RPC、内嵌页面/PDF/Docx 和随包 PTY；不能代替桌面 UI。日志下层 `pi-p2-artifact-check-PORGa1`。
- 串行 `node tests/system-settings-electron.cjs --p2-only`（私有同摘要 runtime）与 `node tests/system-settings-electron.cjs --packaged --p2-only --output-root <build root>` 各 **66 项 / 3 launches / 0 fail / 0 skip**，exit 0（191.52 / 175.08 秒）。仅修改 TEMP 包副本的入口装观察器；核对 61 个生产模块/前端资源，另核托盘 ICO。三阶段均 sandbox=true、contextIsolation=true、nodeIntegration=false、捕获 8 个进程身份且残留 0；不是无观察器直接启动或签名/安装验证。
- 源码 `%TEMP%/pi-system-desktop-9Td8YY/evidence` 与包 `%TEMP%/pi-system-packaged-m8X9Ph/evidence` 各 25 张真实图；实际查看了宽/窄深浅、只读目录和迁移确认代表图。截图用生产 Token、原语、设置、MCP 和 provider CSS；以 `visualViewport` 校验 1320×820 / 701×602、DPR 1.5，窄窗 120% 字体，中英文 fixture 同行比对，确认框文字最小对比度深 8.26:1 / 浅 7.34:1。此前公共 off-switch 非文本遗留不在本次 CSS 修复范围。
- 两版缓存清理为 `partial`、`diskReleaseConfirmed=true`：源码实测释放 **6,161,251 B**，包 **6,161,250 B**（`cachePreview` 是早期读取，不拿它与最终差推导清理时释放值）。旧 backend 实际退出后才 relaunch/cold copy；附件 **262,144 B**、SHA256 `bb30230b4a79b25f8db24b49b7e3b385d8e9b623a74f7be79fcc6e2a9d44fb3e`，metadata **197 B**、SHA256 `1b10c0ed73fa2ff1602cf0b984994f1f11233bbdcb79e16fd4fa3d84516aba26`；两个字节见证与原根一致，Pi models/auth 保持原位原字节。
- `resources/app/server.cjs` 3,375,882 B，SHA256 `e89ec6cc54855211d5e5205f4a2ba618723ee76cdfa96586bc624f2740f787e1`；SEA `a05a16e35909e77afd876652d14cc8f133c3872e0592baf6be3bf22969306b2a`。包的 Electron EXE 保持 `0b57af703a66e11a07e51645847cde933c48954f7ca6c83326b5a7499af63b89`；是否含修复看 resources，不能只看该 EXE 摘要。
- 桌面夹具随后增加真实 ACK 投递失败、同值重试及 HTTP 注册字段错误的渲染观测，第一次追加跑在 Electron 焦点事件未观察到处 exit 1；仍保留截图，改为逐次等待真实 Tab/Shift+Tab 移动及焦点状态后串行重验。该轮未跑完整不得继承 66 的结论到新增场景。

### 6.4 独立审查发现和追加修复

- 独立存储/打包功能复核：**0 Blocker / 0 Important / 0 Nit**。存储定向 **129 pass / 0 fail / 0 skip**（原存储三文件与 desktop storage），维护闸 **16 / 0 / 0**。相对 Pi 目录既有绑定、冷复制失败门控、metadata 原字节与生成 schema 缺失时拒绝均核对。该审查不等于完成真实桌面或完整构建。
- 独立网络安全首轮：**1 Blocker / 0 Important / 0 Nit**，四项交接发现未确认仍有缺口，另发现 **B1**：原生 MCP 的 `keepUrl` 恢复已遮蔽的地址后，本地端点挑战可能把受保护路径回传给 renderer。独立网络/端点专项 **62 / 0 / 0**、network agent **11 / 0 / 0**；原测试未覆盖 B1，首轮结论不通过。
- **B1 已修复，独立复审关闭。** `tests/system-endpoint-final.cjs` 先加入合成原生条目：修复前单条 **0 pass / 1 fail / 0 skip**（真实编辑路径、返回敏感路径断言失败；第一次夹具未带 `originalName` 只碰到名称冲突，不作反证）。`server/mcp-config.js` 把详情遮蔽的同一敏感 URL 判定接给 `lib/mcp-endpoint-permission.cjs`，在签发和消费授权前检查最终配置（包括 `keepUrl`）。本地 HTTP 和 HTTPS 都不给受保护值签发挑战或返回目标摘要；临时配置保持原字节，不产生备份或新文件，历史公网 HTTPS 保留原语义。修复后 `node --test --test-concurrency=1 tests/system-endpoint-final.cjs tests/system-network-final.cjs tests/provider-network-policy.cjs` **64 / 0 / 0**，exit 0。反证与通过日志分别在 `%TEMP%/pi-p2-closeout-mcp-protected-regression-baseline-SbopqE`、`%TEMP%/pi-p2-closeout-mcp-protected-regression-after-U69xjk`。
- [P2 MCP URL 保密边界复审](t3-thread://v2/54c2be41-16aa-490a-8cc2-bfd447f6c2a5/thread:delegated-task:command%3Amcp%3A6eccd8a7-e835-4333-b82f-017a9f9ca528%3Adelegate-task%3Afef56b89-85c4-4e1e-9ed3-98903e03d91a)：**0 新增 Blocker / 0 Important / 0 Nit**。独立重跑 `node --test tests/system-endpoint-final.cjs` **16 / 0 / 0**、`node tests/mcp-config.cjs` **44 / 0 / 0**，另五组临时 fixture 核对通过。核对有/无授权句柄、HTTP 保存与批量导入拒绝不回显、无凭据端点可确认、原有公网 HTTPS 编辑和代次/TTL/单次约束仍成立。补充脚本第一次把请求 chunk 误作字符串而非 Buffer，exit 134；只修夹具后五组全部执行通过。复审未跑 Electron／完整 canonical，不把两者并入独立结果。
- 追加桌面曾通过焦点/重试/注册字段检查，随后撞上 `cache_busy`，实际 exit 1，未跑包（`%TEMP%/pi-system-desktop-DXEG2Q/evidence`）。夹具改等 native 测量单飞结束，再实测 UI 刷新；生产缓存限权和确认票保持不变。下一轮通过 **80 源码 / 81 包**，其中源码在真实退出前没记录最后一项；不视为源码已执行该断言。最终在 `will-quit` 实际记录 maintenance 退出与重启见证，并监测 installer helper 的启动入口。实图发现供应商校验完成按钮文案残留「保存中…」，修复为走既有 header 刷新，同时把网络 ACK 未确认分支的反馈改为「重试保存；仍未确认才重启」，不改变 ACK/代理/撤销权限或磁盘语义。

### 6.5 最终工作区的专项、产物和视觉证据

- 最终行为/测试文件清单：HEAD `b2acedc711be4192332889a9a1bbc3b1bcf3e653`，`%TEMP%/pi-p2-final-identity-V2z0xj/source.json`（965 项集合 SHA256 `3f2e1dff464d9884a7dc2cefaca0afe1de2030b8f3a5b368e38e1d465eedd29b`；另记录单独的 `server.js` 摘要）。tracked product diff SHA256 `e6778942909a35bd108e3c09faf5272a6559a6fee06b1a5e7bebbebbf198272e`。相较首轮身份只有 9 个文件内容不同：`electron/system-network.cjs`、`server/mcp-config.js`、`lib/mcp-endpoint-permission.cjs`、`public/provider-management/dialog.js`、三个受影响的 canonical 测试文件及两份桌面夹具；`package.json`、canonical 计划和存储实现不变。
- 按同一 canonical 计划补验受影响 **24 个命令，24 exit 0 / 0 失败 / 0 整叶跳过，345.58 秒**。本机 `C:/Windows/Temp/pi-p2-canonical-ukZJ2Z/pi-p2-canonical-resume-NervCS/results.json` 和各编号日志保留完整命令/状态，派生来源仍为 `package.json`，不另维护清单。系统设置最终 **299 pass / 0 fail / 1 skip**（settings 21，UI 20，maintenance 16，network 13，proxy 16，agent 11，endpoint 16，network-final 8，Pi-network-final 18，cache 31/1 skip，storage 122，storage-desktop 7）。供应商组合 **187 / 0 / 0**；smoke **1338/1338**、modules **121/121**、server-security **41/41**、electron-guard **128/128**。`test:mcp` 七叶依序 **44 / 24 / 72 / 19 / 14 / 31 / 202** 通过，失败/跳过均 0。没有减少断言。
- 最终 `npm.cmd --offline --logs-max=0 --no-update-notifier run build:app -- --rebuild --output-root <fresh TEMP>` **exit 0，27.41 秒**；仍用本机已核对 ZIP、无下载。产物 `%TEMP%/pi-p2-closeout-verified-build-IWG2hE`，日志 `%TEMP%/pi-p2-closeout-verified-build-2KWpCd/output.log`。416 assets，334.5 MB Electron、100.8 MB SEA；签名警告同前，未验证签名。原仓库的旧构建未替换。
- 最终包 `resources/app/server.cjs` **3,376,143 B** SHA256 `f89df648722113f438c90959d7c7d8e9e84c2bd5c265ffa1480b38ef646c940d`；生成 schema **15,535 B**，SHA256 `76caa2c2e2ccb75ac3d4d4350d94be9ce50b27c7f9e323effa22b6e01c07a5a5`；SEA **105,677,312 B**，SHA256 `2e36f9864e5ae08186ba2f741b25bb2cb22b48c4d56f3161233722fcd1b505f2`。Electron shell EXE 与前轮相同不代表资源未更新；本次核对了 61 份模块/页面资源及 ICO。
- 最终 `node tests/app-check.cjs --output-root <fresh TEMP>` **27/27，0 fail / 0 skip**（19.35 秒）；`node tests/exe-check.cjs --output-root <fresh TEMP>` **50/50，0 fail / 0 skip**（15.29 秒）；两个 exit 0，日志在 `%TEMP%/pi-p2-closeout-verified-artifacts-UXwNd5`。
- 最终串行 `node tests/system-settings-electron.cjs --p2-only`（私有同版本 runtime）和 `node tests/system-settings-electron.cjs --packaged --p2-only --output-root <fresh TEMP>`：各 **81 checks / 3 launches / 0 fail / 0 skip**、exit 0，215.49 / 194.29 秒；阶段各 63 / 9 / 6 条，加三条进程回收。每阶段观察 8 个进程身份、残留 0；sandbox=true、contextIsolation=true、nodeIntegration=false。打包入口仅在 TEMP 副本装观察器，外部 Pi 是替身。
- 两路各 34 张实际截图与布局数据：[源码证据](/C:/Users/21022/AppData/Local/Temp/pi-system-desktop-iRHPe2/evidence/summary.json)、[打包证据](/C:/Users/21022/AppData/Local/Temp/pi-system-packaged-NauQmP/evidence/summary.json)。已查看 [权限未确认后可重试](/C:/Users/21022/AppData/Local/Temp/pi-system-desktop-iRHPe2/evidence/p2-network-permission-unconfirmed.png)、[浅色窄窗 MCP 拒绝](/C:/Users/21022/AppData/Local/Temp/pi-system-packaged-NauQmP/evidence/final-mcp-protected-url-light-700.png)、[深色宽窗 HTTP 注册字段错误和按钮恢复](/C:/Users/21022/AppData/Local/Temp/pi-system-packaged-NauQmP/evidence/final-provider-http-reference-dark-1320.png)。实际 Tab/Shift+Tab 与 Esc，确认框对比度最低深 8.26:1 / 浅 7.34:1；不把 DOM 单测当视觉验收。窄窗 120% 及代表性英文使用与生产相同的 CSS，非翻译功能验收。
- 缓存均为 `partial`，实测 `diskReleaseConfirmed=true`、各释放 **6,161,426 B**（清后 **837,908 / 837,980 B**；登录/本地存储和业务文件保留）；重新打开页面时观测到短暂 native `cache_busy`（87 / 60 次拒绝），并不把忙态算成功。迁移均观察到原 backend exit 0、尝试启动 installer helper **0 次**，退出后才启动下一实进程；附件与 provider metadata 的字节数和 SHA256 同 §6.3，Pi native 文件未搬迁或重写。实际由夹具父进程履行 relaunch，未验证操作系统 relaunch 机制。

### 6.6 本地完整 canonical

首次 `npm test` exit 1 和 ACL 夹具修正见 §6.3。续跑第 154 个供应商组合 **187 pass / 0 fail / 0 skip**。应用户要求尽快结束，在第 **294** 个命令 `node tests/session-revert-object-faults.cjs` 进行中停止，不再重跑。累计 **293/300 个唯一命令 exit 0**（首次 153 + 续跑 140；§6.5 的 24 个补验命令不重复计数），1 个中断、6 个未运行。不会把原生故障套件的部分输出、计划覆盖或预期 opt-in skip 当作运行通过。续跑原始记录 `C:/Windows/Temp/pi-p2-canonical-ukZJ2Z/pi-p2-canonical-resume-7LBB3t/results.json` 中第 294 个命令因终止未写终态；已确认续跑与该测试进程退出。

完成的命令中观察到 4 个文件 symlink 子项因权限跳过（系统缓存、Collab store、candidate adoption、logging-leaks），另有 10 个 SACL 见证子项因 Windows 未授予 `SeSecurityPrivilege` 跳过（专项见证 8、in-place 2）。第 300 个可选真实 Pi 入口未到达，不计为已观察的 skip。计划 SHA256 `d82ecafd2a58e9e06c7fd201a7076308e72a3662d0dda083ed6c8f30d45a656b`；本地完整 canonical **未完成**，没有本工作区的 PR／main CI gate，main 精确基线证据只作勘察。

### 6.7 限制与回滚

- 后端未确认窗口内不能假定旧授权已撤销。暂停新本地端点操作，同值保存重试；若持续未确认，正常重启再核对。GUI 授权不接管 Pi 原生连接或重定向，真实 Pi/供应商认证及系统 PAC/TUN 实际出口未验证。本轮未运行完整 P1 八阶段 GUI、真实安装或原位升级、签名、操作系统 relaunch 或其它平台验收。旧公共 off-switch 描边对比度不足不以单页样式掩盖。
- 回滚只处置本次变更并离线重建，不覆盖同工作区其它任务；没有已提交版本可直接 revert。不要单独移除 MCP 敏感 URL 闸门而保留本地确认；暂时停止额外本地许可应关闭宽松模式并核实后端确认。已经迁到 managed 根时先停止所有写者，保全固定 bootstrap 和新旧根；如新根有写入，不回指旧根或启动只认旧根的包，先单独核对迁移恢复与回退。旧仓库构建未覆盖，隔离产物不能视作当前安装。
- 开发完成；定向验证、独立审查、离线重建及桌面实测通过。完整本地 canonical 提前停止，P2 不记完整验收通过。用户后续明确授权本次 P2 提交及推送；没有合并、tag 或发布授权，不把推送当作高风险整体验收批准。

### 6.8 本次授权交付身份

- before HEAD：`b2acedc711be4192332889a9a1bbc3b1bcf3e653`。
- 产品提交：`d8fc33fa2866a019cb2b5addb5628ad7eb458026`（端点许可、凭据保密、metadata 校验与冷迁移边界、随包资源），28 个文件。
- 测试提交：`2a6338939a017234d10ff0f27165c44599626fbd`（canonical 链与回归、离线流量及桌面夹具），15 个文件。提交前逐一核对 §6.5 的 965 项文件摘要及单列 `server.js`，无内容变化；提交拆分没有产生新的行为，未重跑长测试。
- 本报告为第三笔文档提交，其 SHA 用 `git log -1 --format=%H -- docs/system-settings-p2-final-fix.md` 定位，最终推送结果和 SHA 在交付消息中明确列出。文档只更新证据和授权状态，不继承为该 SHA 的 CI 证明。
- 仅推送 `origin/feat/system-settings`，不创建 PR、不合并、不改版本、不打 tag 或发版。P5 文档、`spike/`、临时日志、ConPTY 编译文件及其它旁支未跟踪文件不纳入提交，保留原状。
