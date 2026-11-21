# 系统设置 P1 + P2 联合验收

> **后续收尾状态（2026-11-21）**：[P2 最终定向修复](system-settings-p2-final-fix.md) 单列 `b2acedc7` 后新增的显式端点授权、供应商元数据迁移、Pi 实际线路 fixture 与准确覆盖限制。修复、独立审查与两版桌面专项已完成；完整 canonical 按用户要求在 293/300 个命令正常退出后停止，未通过完整验收。下文旧证据不继承到本轮新行为；仅获当前 P2 提交和推送授权，不含合并或发布。

- **范围**：P1 电源、关闭/托盘与系统页，加 P2 应用内网络配置、冷迁移、多桶缓存。详细实现、安全矩阵与恢复策略见 [P2 验收](system-settings-p2-acceptance.md)；[P1 历史记录](system-settings-p1-acceptance.md) 仅证明其当时提交，不把当时的“等待 P2”当作当前状态。
- **身份**：`feat/system-settings`；P1 基线 `9d1fd4e76b6cb2fb412a4a447b2ba6043c58e15e`（P1 产品提交 `6aa09da0`）。本轮测试在该 HEAD 加 P2 工作区进行；随后按相同文件字节拆为产品提交 `1ab11970db392abf2b2685973eec598e5b94de33` 与测试提交 `9cd9c39f0fc42980ebf153c8bd9efa9448f4f975`。用 `git log -1 --format=%H -- docs/system-settings-final-acceptance.md` 定位本报告交付提交；文档提交不改变已验证行为，不把本地运行称为新提交 CI。
- **版本**：仍为 `0.34.0`。不创建 PR、不合并、不打 tag、不发版；只在专项与审查收敛后按用户原授权提交/推送当前分支。
- **完整证明**：按用户预先选择，本轮**未运行完整本地 `npm test`**。当前没有统一 PR，完整 canonical 与最终人工验收仍为**待验证**；不能从专项数量推导完整代码验收已通过。整改后计划核验为 297 leaves / 5 groups / exact。

## 1. 历史基线专项结果（未覆盖整改）

> **证据适用范围**：本节表格只记录审查整改前的基线；不能把旧运行当作整改后证明。整改后 source/packaged 及末轮 P2 沙箱验证均已单列于 [整改后定向复验](#post-remediation) 与后续各节；末轮增量独立复核的范围和结论见第 5 节，不代表完整 canonical 验收。

Windows 11 Home China `10.0.26200`；Node `24.22.1`、npm `11.19.1`、Electron `44.4.3`（内嵌 Node `24.21.0`）。全部业务写入使用新 TEMP fixture；真实项目只读，没有真实 Pi/模型调用、依赖下载或系统代理/VPN 修改。

| 层次 / 实际命令 | 最新结果 | 本机证据索引 |
| --- | --- | --- |
| `npm.cmd run test:system-settings` | 预整改历史：**165 passed / 1 permission skip / 0 fail，exit 0**。 | task `b9zm7rkt5`；整改后当前数字见 §1.1。 |
| `npm.cmd run test:app-update` | 预整改历史：**11 套 / 145 项通过**，0 skip/fail，exit 0。 | task `b83b8df5h`；首次整改 12 套 / 151 项，末轮 155 项，见 §1.1。 |
| `npm.cmd run test:session-title-ai` | 预整改历史 **5 套 / 273 项通过**，exit 0。 | `bgovph247`；58+44+64+35+72。整改后 5 suites / 273 pass 见 §1.1。 |
| Auth / quota / credential SDK | 预整改历史 **110/110、53/53、12/12**，exit 0。 | 旧 task `byqnst0e5`、`bgovph247`；整改后复验见 §1.1。 |
| 文件/终端、Runtime Browser | 历史 **113 项 / 48/48**，exit 0。 | 旧 Runtime Browser 不视为整改后的新证据。当前文件/终端定向复验单列于 §1.1。 |
| MCP market / market-network | 预整改历史 **72 项 / 19 条** 通过，exit 0。 | 旧 task `bjse6o4tl`；整改后套件结果另见 §1.1。 |
| 环境安装 / 下载 / server-security | 预整改历史 **26/26、19/19、41/41**，exit 0。 | `bgovph247`；fake 下载/安装，不证明真实网络或安装资格。 |
| provider-network-policy / credential-opening | **40/40、5/5**，exit 0。 | `bae2paxwk` 前两套；整条后来桌面阶段失败，单列后续正常沙箱复验。 |
| 凭据桥模块 / 正常沙箱桌面 | 整改后离线 fixture 重验 **43 项桥断言、50/50 桌面 checks**，exit 0。 | task `bme9bp75t`；只对 fresh TEMP fixture 设置私有 DACL，生产资格未改；harness controller qualification stub 仍表示不是完整 production Main qualification E2E。 |
| `node tests/ci-test-plan.cjs` | 预整改历史 **296 leaves / 5 groups / coverage exact**。 | 当前新增 updater adapter 后为 297 leaves，见 §1.1；未改 workflow。 |
| `node tests/modules.cjs` | 预整改历史 **121/121 通过**，exit 0。 | 当前重跑结果见 §1.1。 |
| `git diff --check` | 预整改历史 exit 0。 | 当前工作区最终核验另记录于交付摘要。 |
| 整改前报告/产物核验 | 历史检查 **200 个相对链接、15 个锚点、53 个模块/资源、11 项 SHA** 通过。 | 本次追加的 4 张迁移弹层截图及整改后 JSON 校验另列证据目录；旧数量不当作当前检查结果。 |

唯一 skip 为当前 Windows 权限不足以创建**文件 symlink**的子用例；不计入通过分子/分母。真实 junction、hardlink、ADS/reparse 和路径替换等其他用例仍执行。原 P1 settings 20→21、UI 12→19；agent 最终 7→8、credential SDK 11→12、更新 preferences 7→8，均增加而非删减旧断言。

### 历史真实请求与故障证据

> 本节网络与存储 fixture 输出仅为整改前；整改后边界与复验见 §1.1 / §2。

- `system-proxy-p2` 使用真实 TCP、HTTP CONNECT、TLS、HTTPS proxy、SOCKS5、407 和 deadline；固定连接测试只发 HEAD、拒重定向，不调用模型。strict DNS 全答案及 checked-IP、relaxed proven-proxy、mixed-private 拒绝均验证。
- `system-network-agent-p2` 实际启动 Node 子进程验证 fetch / http / https 经鉴权 gateway；回环控制仍直连，HTTPS 默认拒绝不信任证书。只有单请求 fixture CA 被信任，没有全局 insecure flags。
- 实际 Auth/标题 Worker 的公开业务入口导入 fake SDK，SDK 内发本机 HTTP/fetch 探针；没有 GUI token 或代理鉴权 header 到源站。这不能替代真实供应商、WS、MCP 或 OAuth 验收。
- 原生文件计量 fixture **73,728 → 0 B**，protected digest `fd402b6775fd58eff529ccf213aae1d9ca3961f395fe5eccc75eda0f28f3733e` 不变。清理动作由官方形状替身驱动，不能与下一节真实 Chromium 清理混淆。
- 存储 fixture 实际复制 **14 文件 / 1,132 B**；二进制 SHA256 `d03a2e3f16700a6351b2091ca1808f53e2ce4765d84ccf70e24703359d21e2df`。子进程在 staging、copy chunk、verified、committed 四个确定点硬退出后重开，验证权威根、失败/恢复和原目录不变；不是实际断电或 OS 内部 syscall 全覆盖。

<a id="post-remediation"></a>

## 1.1 整改后定向复验

| 命令 / 范围 | 结果 | 证据与边界 |
| --- | --- | --- |
| `npm.cmd run test:system-settings` | **185 passed / 1 permission skip / 0 fail**, exit 0 | 末轮 task `buc09u7xi`；settings 21、UI 19、maintenance 16、network 13、proxy 16、agent 11、cache 31/1 skip、storage/crash 51、storage desktop 7。相较前次 183 增加 2 项 gateway PAC 回归；双重 I/O 失败另增加真实 storage + maintenance 联测断言。Skip 仅为 Windows 无权创建测试文件 symlink。 |
| `npm.cmd run test:app-update` | **12 suites / 155 passed / 0 skip / 0 fail**, exit 0 | 末轮同 task `buc09u7xi`；adapter/owner 回归 4→8，新增未读长度拒绝、错误状态/外来重定向收尾、WHATWG cancel、headers 后 client error。 |
| `npm.cmd run test:session-title-ai` | **5 suites / 273 passed**, exit 0 | task `bmbp6vrgj` 前五套；只用 fake SDK，不调用模型。 |
| `npm.cmd run test:mcp` + `node tests/server-security.cjs` | 两条均 exit 0 | task `b1vh10z71`；MCP catalog、market networking、server access controls。 |
| `provider-auth` / `native-provider-quota` / `provider-credential-sdk` | **110/110、53/53、12/12**, exit 0 | task `bmbp6vrgj`；worker capability 不存在于进程环境或任意子进程。 |
| `node tests/files-terminal.cjs` / `node tests/modules.cjs` | **113 checks / 121 of 121**, exit 0 | task `bldu8i61n`；terminal 与 Pi 子进程 environment scrub 覆盖。 |
| `node tests/ci-test-plan.cjs` | **297 leaves / 5 groups / coverage exact**, exit 0 | 没有改 CI；此检查验证 canonical 展开，不运行所有 leaves。 |
| `npm.cmd run test:provider-p2` 和私有 TEMP 复验 | policy **40/40**、opening **5/5**；默认 TEMP 桌面 **2/4**、exit 1；隔离复验 **43 项桥断言 + 50/50 桌面检查**、exit 0 | `bnocj3c0r` / `bme9bp75t`。默认 TEMP 祖先 ACL 触发现有 `key_input_unqualified`。复验只调整新建 fixture 的私有 DACL，不改生产资格或系统/用户目录权限；仍不等于完整生产 Main 资格 E2E。 |
| Runtime Browser / Browser Host / Stop 装配 | **48/48、18/18、13/13、17/17** | `bdrwhlsb1` Runtime Browser / Host 通过；随后两份 Stop VM fixture 因未注入新只读 storage factory 曾失败，补齐真实工厂依赖后 `bb1zyysd3` 整体 exit 0，Stop assertions 保持。 |
| Worktree / 撤销存储 / 写入准入 / 启动恢复 | **56/56、14/14、15/15、11/11**，exit 0 | task `b6ggp1e53`；临时 Git、对象与恢复日志 fixture，真实项目不写入。 |

`npm test` 完整本地 canonical 仍未运行（按用户预先选择留给统一 PR CI）；当前无 PR，PR CI 仍待后续人工统一创建。高风险独立复核未通过前不提交/推送。

### 末轮缺陷回归与证据范围（2026-11-21）

- 新增回归修复前：6 项中 **1 pass / 5 fail**，exit 1；失败分别为 gateway 拒绝有效 PAC 和 updater 未收尾的四条路径。修复后相关三文件测试 **49/49**，exit 0；随后执行上表完整受影响 alias，没有运行完整本地 `npm test`。
- 同一末轮命令还完成 `node tests/mcp-market-network.cjs` **19/19**、`node tests/provider-network-policy.cjs` **40/40**、`node tests/ci-test-plan.cjs` **297 leaves / 5 groups / exact**，整条 exit 0。没有修改共享市场 classifier 或放宽 Fake-IP/私网许可。
- 原生新增用例不是只测替身：生产 updater owner 使用官方形状的合成 Release 元数据，只有 transport 目的地注入本机 TEMP endpoint。源码及包均得到 `checksum` / `failed`、native `bodyDestroyed:true`、服务端观察连接关闭、缓存目录 0 文件；随后注入的迟到 body error 被安全消费。未下载真实资产或执行安装器。
- 原生夹具首次未声明 MIME，Chromium 等待嗅探导致 deadline（fixture `pi-system-desktop-lQa3se`，exit 1）；第二次诊断因未得到 response 而访问空 body 失败（`pi-system-desktop-zowC4m`，exit 1）。夹具明确 octet-stream/nosniff、提供首个缓冲字节并加 10 秒取消上限后，两版均通过。该字节不由 updater reader 消费，长度校验仍在首次读取前拒绝；未降低任何断言。
- 本轮没有 UI 改动；已归档的 7 张布局/状态截图保留其原运行身份，不伪装为末轮截图。P1 电源/托盘八阶段未因这两处 transport 修复无故重跑，沿用下节明确标注的既有证据。

## 2. 整改后正常沙箱真实 Electron

| 入口 | 结果与 fixture |
| --- | --- |
| 源码 `node tests/system-settings-electron.cjs` | 整改后 **120 checks / 8 次启动**，exit 0；`%TEMP%/pi-system-desktop-HhZbUA/evidence`。使用显式同版本私有 `ELECTRON_OVERRIDE_DIST_PATH`。 |
| 源码同上 `--p2-only` | 末轮修复后 **26 checks / 3 次启动**，exit 0；`%TEMP%/pi-system-desktop-sd9kZJ/evidence`。增加两项真实 updater 早拒/收尾检查；迁移确认弹层深浅主题×宽窄仍执行。 |
| 既有 P1 八阶段包同上 `--packaged` | 首次整改后 **120 checks / 8 次启动**，exit 0；`%TEMP%/pi-system-packaged-V4LblI/evidence`。重跑第一次因 10 个残留进程身份失败，单独串行重试通过；首次失败仍保留在对应 runner 记录。 |
| 最新包同上 `--packaged --p2-only` | 末轮修复后 **26 checks / 3 次启动**，exit 0；`%TEMP%/pi-system-packaged-Fqc5LH/evidence`。包含四组迁移弹层、离线 Session redirect 及生产 updater 未读响应取消。 |

P1 full 的既有任务 `bxjcgyrk5`（120 checks/8 launches）与末轮 P2-only（26 checks/3 launches）分别 exit 0，运行串行且证据范围分开。P1 full 是末轮两处 transport 修复前的回归证据，不宣称新包已重跑八阶段。此前 packaged full 清理一次 transient residual fail 后独立重跑通过，历史 failure 保留。末轮复制重建包到 TEMP，仅修改副本 manifest.main 装载观察 bootstrap；逐字节核对 **54 个 Electron 模块/前端资源**与托盘图标，使用实际打包 `server.cjs`。没有 `--no-sandbox`、CDP 或 Node integration，contextIsolation 为真。不是原 manifest 无观察 bootstrap 的直接启动、真实安装版或 OS relaunch 全资格。

P1 八阶段：功能、重启托盘退出、默认关闭、Ctrl+Q、session-end、更新闸门、保存中退出、视觉状态。最新 packaged 每阶段捕获进程身份数 **8 / 15 / 15 / 24 / 24 / 18 / 26 / 8**，残留全 **0**，blocker 与 Tray 剩余全 **0**。验证真实键鼠、同 HWND/webContents/DOM 恢复、后台 SSE、Runtime 审批与编辑草稿保持；更新场景使用生产协调器与合成候选/安装回调，不下载或运行安装器。

P2 三阶段（整改后 source 与 packaged）均捕获 **8 个**进程身份、残留全 **0**：

1. draft 的真实代理 CONNECT + TLS HEAD 不落网络文件；保存 custom/relaxed 不重启旧 backend；DIRECT 与内部 API 可达。Session `net.request` adapter 实际向 TEMP redirect endpoint 读取 302/Location，未 follow；生产 updater owner 在未读取 body 时拒绝长度头，并实际关闭 native body/连接、保留 `checksum`，合成迟到 body error 不逃逸。
2. default Session 实际磁盘缓存清理保留业务与 Cookie/LocalStorage/IndexedDB。末轮 source **6,999,334 → 837,908 B，减少 6,161,426 B**；末轮 packaged **6,999,230 → 837,980 B，减少 6,161,250 B**；两者 `diskReleaseConfirmed:true`，整体为 **partial**，没有假报总量 0。
3. 真实原生路径选择控件、独立确认与维护入口；relaunch 意图只在旧 backend exit 后出现，冷启动前目标仍为空。parent 在旧进程 exit 0 且无捕获身份残留后启动新进程；校验后新 backend 报告 managed/active。**262,144 B** 附件 SHA256 `bb30230b4a79b25f8db24b49b7e3b385d8e9b623a74f7be79fcc6e2a9d44fb3e`，源备份保留，网络偏好与固定引导未迁移。

进程清理只证明捕获的 PID + CreationDate，不能证明已脱离树的任意进程均被回收；测试拦截 app.relaunch 并串行重启，不声称真实 OS relaunch、注销/关机或中断复制一切时序均已通过。

### 凭据输入相邻专项及环境资格

`b61adpe7z` 正常沙箱复验 **43 项桥模块断言 + 50/50 桌面检查，exit 0**；证据位于 `C:/Windows/Temp/pi-cred-desktop-WzNOUK/evidence`。为保证离线，仅在 TEMP 观察器中预加载仓库已有 socket/DNS 守卫，并为 Electron Session 拦截非回环请求、为真实 backend 附加同一守卫。使用已有 Electron 44.4.3 私有运行时，没有 no-sandbox、CDP、模型调用或真实凭据。

首次同版本正常沙箱运行 `bc3s4fx47` 被既有存储资格正确拒绝：用户 TEMP 祖先继承其他本地账户的修改/删除权限，`open()` 返回 `key_input_unqualified`，桌面 2/4、exit 1。没有放宽生产资格或修改用户 TEMP/profile 权限；仅给该测试进程设置 `TEMP/TMP=C:/Windows/Temp`，对其中新建、尚为空的 fixture 使用当前用户独占 protected DACL。第一次私有 fixture 准备 `be1szcs1x` 因 `icacls` 数字 SID 缺少 `*` 前缀而 status 1332、exit 1，Electron 尚未启动；修正临时观察器参数后才获得上述 50/50，不把失败计为通过。父目录权限未改，真实 SID/账户名不归档。

**证明限制**：既有桌面 harness 的 `isDesktopQualified: () => true` 用于控制器装配测试，本轮未修改；43 项模块断言另测沙箱与调试 flags 资格。50/50 证明受限输入窗、stage/commit/readback/clear、OAuth 二次确认、错误 frame/外来 Renderer 拒绝及 backend epoch 等装配边界，不能冒充完整生产 Main 资格 E2E、真实 Pi SDK 或真实供应商认证。合成宿主未注册 app-update-state handler 的日志保留，不据此认定正式更新页已验证。

## 3. 真实视觉与共享组件

使用生产 CSS 与公共 Settings card/row/toggle/segment、`.btn`、字段、帮助浮层及独立确认框；没有页面级主题色或按钮实现。实际查看最终包深/浅 × 宽/窄 **四张 custom proxy 图**及 P2 磁盘清理图，不只是检查 DOM 字符串。

- 宽 `1320×820` CSS px / `1980×1230` pixels；窄实际约 `701×602` / `1052×903`，DPR 1.5；无页面水平溢出，字段、长路径与动作保持边界。
- 标题 **20px / 600**，公共按钮 **32px**、开关轨道 **22px**、分段 **26px**；System 与 General 几何/字体一致。窄窗 120% 字体、中英长文案 fixture、真实 Tab/Shift+Tab、方向键/Enter/Escape、hover/pressed、取消及回焦均执行。
- Default/selected、Disabled、Loading、Empty、Error、Success、未知与重试用生产 CSS + 合成桥单独检查，不能冒充真实 I/O 故障。真实清理 partial 另有独立实测。
- 文字样本按实际合成色验证 AA；键盘 focus 与错误文字有独立实测。公共开关 off 边框深/浅主题仍有 P1 已记录的非文本对比度不足，本轮复用且未单页覆写；**不宣称所有状态均符合 AA**。精确色值/比值及代表图见最小证据。

已归档 [代表证据说明](ui/system-settings-p2-evidence/README.md)、[深色宽窗自定义代理](ui/system-settings-p2-evidence/dark-wide.png)、[浅色窄窗自定义代理](ui/system-settings-p2-evidence/light-narrow.png)、[磁盘清理结果](ui/system-settings-p2-evidence/cache-disk.png)、[迁移确认深色宽窗](ui/system-settings-p2-evidence/migration-dark-wide.png)、[迁移确认深色窄窗](ui/system-settings-p2-evidence/migration-dark-narrow.png)、[迁移确认浅色宽窗](ui/system-settings-p2-evidence/migration-light-wide.png)、[迁移确认浅色窄窗](ui/system-settings-p2-evidence/migration-light-narrow.png) 及 [最小核验 JSON](ui/system-settings-p2-evidence/verification.json)。没有归档完整 TEMP profile、用户业务/凭据数据或原始服务日志。

## 4. 构建与产物身份

命令：`npm.cmd run build:app -- --rebuild`，`PI_GUI_ELECTRON_ZIP_DIR` 指向本机已有 Electron 缓存；没有联网下载。末轮离线重建 task `bv7vk39hd` exit 0，**416 资源 / 3.21 MB backend / 11.07 MB blob / 100.8 MB SEA / 334.5 MB 整包**。

目录：`dist-app/Pi GUI-win32-x64`；版本 `0.34.0`。`Pi GUI.exe` 为 **246,324,736 B**，图标 **125,779 B**。node-pty `1.1.0` 已随包，conpty.node digest `fe61108b40fcf0c1172d6e193f482e6ef2e0d9b1a447468b6a1eb7c67ca80271`。

| 相对产物路径 | SHA256 |
| --- | --- |
| `Pi GUI.exe` | `0b57af703a66e11a07e51645847cde933c48954f7ca6c83326b5a7499af63b89` |
| `resources/app/main.cjs` | `e87bbde3e9cad3cd87b8b638de2acb3b4cba892ff1b9556b310eabdb759cfd91` |
| `resources/app/server.cjs` | `947ef4bee3e7c532b6569e492fd202ffbf29b3faeb3a30fc63fdc7a8b1d2af85` |
| `resources/app/preload.cjs` | `8a7f8b94cce74e0c4334ddc7cc1e8aeb53ac5a95c28799c244f98802efd2b462` |
| `resources/app/system-network-policy.cjs` | `551caee9b20646fe67b5be8f791cde7b5151ae7e4a90b5aee09d38f05ad76275` |
| `resources/app/system-proxy.cjs` | `db3bf37ecc82e4a568e21a6a4159ab3e55f462d27d1925e66b4bc3c4462c280c` |
| `resources/app/system-proxy-transport.cjs` | `e042474008da35f0914a59e799c00deecbe46e279e1cf1e758dffa61f4904bae` |
| `resources/app/system-storage-migration.cjs` | `7a0aca311d4d82d3535ffb8d743f1d3e114405ac5cae302aa5d2831133b298a6` |
| `resources/app/system-cache-p2.cjs` | `7558db48d282bf15466e30252b3228466f59a190dd88cdf565627b8f0463256e` |
| `resources/app/app-update.cjs` | `06e46c878b787d6ecf0063f4ceb54407f301414296bdfc5ef3fa65307dd544df` |
| `resources/app/app-update-fetch.cjs` | `06e6fead42235811e253cab888ada38c53c5393a3042330509e99b59826ad92b` |
| `resources/app/public/system-settings-network.js` | `9a3d8f79ef5dc7461005e513647e0da0dc14b38452c138cd4f5efdded84d0012` |
| `resources/app/public/system-settings-storage.js` | `b0fb34a987b73c93e0fdecb7a12a68a3b86640d7457edfed5047fa3822cadd25` |
| `resources/app/public/system-settings.css` | `6d0a01d7c7937fd673d2b894aca7b03f6a336374610ce4a8195a7bec89bbd1bf` |
| `resources/app/icon.ico` | `131e06d54b20b26cc61efea22bef8a0371f2956d809f914ecb0a6a8f7f96a484` |

Electron zip SHA256 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`；私有源码测试运行时 electron.exe SHA256 `bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`。打包入口 exe 与 P1 相同不意味着产品未更新：业务在 `resources/app`，其 Main/backend/资源摘要已变化并由最新包实跑。

保留警告：SEA postject 报 `The signature seems corrupted!`，构建成功**不是签名验证通过**；packaged Electron 忽略大部分 NODE_OPTIONS，测试以 Main 显式 require 与 backend CLI preload 的独立标记确认离线守卫。合成 update-gates 宿主未注册 UI state handler 的日志单列，不据此宣称正式更新 UI 已通过。

## 5. 独立审查、发现处置与最终状态

| 已确认发现 | 整改与回归证据 | 状态 |
| --- | --- | --- |
| Durable migration intent 在 backend 停止前可被冷启动执行；rename 后返回 failure 可能留下实际 intent | `intent → ready` 双阶段；只有相同 backend ack + parent exit code 0 后可 arm。crash-after-intent、rename-after-error、dirty exit 和 target-empty 回归。 | 已修复、定向测试通过 |
| 迁移操作期间普通 X / explicit app.quit 被拦后请求丢失 | 记录 close/app.quit 意图，settle 后重新走原 lifecycle；托盘关闭和 explicit quit 优先级测试。 | 已修复、maintenance tests 通过 |
| Runtime Session registration 与代理 save 对撞时漏应用新策略 | 注册/保存顺序与 in-flight set；先注册后保存测试确认旧策略 await 后新策略被应用。 | 已修复、network tests 通过 |
| Main bearer gateway capability 可被 Pi/terminal/installer 环境及后代继承 | Main backend startup 消费并删除私有 env；central child env scrub 所有拼写及代理值；external Pi 使用无密钥 custom/direct projection，system/PAC 不宣称覆盖。 | 已修复、实际 Node child / worker regression 通过 |
| 网关仅依赖“私有”地址标签而未按全部 DNS 答案 pin；HTTPS IP literal 的 SAN 校验不明确 | gateway 全答案 public/benchmark 分类、strict pinned IP、proven-proxy relaxed Fake-IP、private/loopback/internal/self rejection；IP SAN 用原 host 强制 checkServerIdentity。 | 已修复、TLS/CONNECT fixtures 通过 |
| PAC 备选代理不尝试；cache/English/button selector fixture 可能假绿 | bounded proxy-only fallback，遇 DIRECT 不降级；cache outcome、label 映射和 network action selector 收紧。 | 已修复、专项通过 |
| Electron Session `fetch({redirect:'manual'})` 实际会取消 redirect，影响 updater 读取 Location | 以冻结 Session `net.request` adapter 返回 status/Location，updater 仍逐跳检查；真实本机 Session redirect + stream/cookie/abort tests。 | 已修复、P2 Electron 与 updater suite 通过 |
| updater 无 manager/coordinator 时 storage lease 被误报 update_busy；idle terminal 误挡 updater admission | updater 无 owner 仅阻止更新自身；maintenance scope 分离 storage terminal check 与 update policy。 | 已修复、app-update/maintenance tests 通过 |
| BOM 保留导致业务 JSON parse 失败；explicit UNC override 被 migration path validator 拒绝 | fatal UTF-8 decoder 以标准 BOM 语义解码且 source/target bytes 原样复制；override 在 managed-path 校验前独立投影。 | 已修复、BOM/UNC fixtures 通过 |

两份初始独立审查任务已取消且确认中断，旧报告不作通过。其后的 `xingchiapi/gpt-6.1-sol` 窄范围复核已完成并返回 3 条 Important，不再标为“尚未收到”：

| 末轮发现 | 当前处置与可复查证据 | 状态 |
| --- | --- | --- |
| bootstrap rename 成功后返回错误且重读 EIO，旧实现丢失 intentId 并释放维护锁 | 当前 commit 保留尝试 checkpoint 的 intentId；`system-storage-p2-crash.cjs` 将真实双失败 storage 结果接到 maintenance，确认 `recoveryBlocked/busy` 为真、updater lease 保留、backend 无 release/shutdown，重启目标仍空。 | 已修复，51 项 storage/crash 专项通过；本轮仅加强联测，未改该产品 guard |
| PAC `PROXY …; DIRECT` 在 gateway 被误拒 | 仅从受支持代理前缀构建最多 4 个候选，传给 transport 前去掉 DIRECT；原始列表仍为 unknown，不获 relaxed/Fake-IP 许可。鉴权 gateway 实测成功、失败不直连、四候选上限及 mixed-private/Fake-IP/unsupported 拒绝。 | 已修复，proxy 16/16；增量独立复核未确认新 Blocker/Important |
| updater 在读取前拒绝 headers，遗留 native request/body | owner 在 redirect/status/长度拒绝及读取退出时 dispose；adapter 幂等终止 request/body，保留迟到 error listener，active reader 仍收到错误。WHATWG cancel、实际正常沙箱 source/packaged 早拒与清理均通过。 | 已修复，adapter/owner 8/8、更新 155 项；增量独立复核未确认新 Blocker/Important |

末轮只对上述路径进行一次小范围独立复核，指定同一星驰模型、禁止 fanout，不重开全量扫描。[增量复核记录](t3-thread://v2/54c2be41-16aa-490a-8cc2-bfd447f6c2a5/thread:delegated-task:command%3Amcp%3A84d4f6a8-aa8e-46a9-a926-c7c17a5506f6%3Adelegate-task%3Ace1f1179-8b53-4a5c-b00e-f50e7997a25b) 已完成，工具确认实际模型为 `xingchiapi/gpt-6.1-sol`：三项原发现均为已修复，本次范围内确认 **Blocker 0 / Important 0**。该复核只读代码及夹具，没有独立执行定向测试或 Electron；作者实测另见前表，不能混为独立运行证明。复核保留“不支持的 PAC 标记仍拒绝”这一兼容范围，不把它当作已确认的新缺陷。完整 canonical 与用户的合并/发布决定仍独立待办。

早期失败、取消、跳过及修复历史详见 [P2 第 7 节](system-settings-p2-acceptance.md#7-首次失败取消及未验证)。没有放宽正常沙箱/凭据资格、删除独立安全用例、绕过 TLS 或用 no-sandbox 结果替代正常沙箱证明；此前完全重复的三条 mixed-private 断言去重已在 P2 第 7 节说明，唯一行为覆盖保留。完整测试日志位于本机 `%TEMP%/claude/bc7492e6dab9289c/6938f969-c256-45a6-addc-7aedf506f6a9/tasks/<任务ID>.output`，不把原始完整日志长期塞进 docs。

高风险的残余边界：真实 Pi/供应商/任意第三方网络未验证；新 discovery 之外的 legacy quota/models 仍按各自信任模型；不防御同账户恶意末端竞态；真实 OS relaunch、关机/注销、签名、安装/原位升级及其他平台未验证。P1 公共开关 off 边框对比度遗留未全局整改。

| 阶段 | 结论 |
| --- | --- |
| 开发实现 | 末轮两项缺陷已复现并修复；系统设置 185 pass/1 skip、更新 155 pass、Source/Packaged P2 正常沙箱各 26 项通过。增量独立复核已收敛，未确认新 Blocker/Important；可按原授权提交/推送当前分支，不代表允许合并或发布。 |
| 完整代码验收 | **待验证**：作者自验与独立复核分别记录；完整 canonical CI 留待用户统一建 PR。 |
| 允许合并 | **未授权**；没有 PR，测试/审查不等于合并许可。 |
| 允许发布 | **未授权**；没有版本变化、tag、release 或实际安装资格声明。 |

回滚必须按 [P2 第 8 节](system-settings-p2-acceptance.md#8-回滚与决策) 保全 managed 新根与旧根，停止写者后核验，**不能直接回旧 pointer 或启动只认旧根的 P1 包**。本轮不删除原业务数据、失败半成品、固定偏好或浏览器登录状态。
