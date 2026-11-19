# 应用更新偏好与安全退出安装 验收材料

- 目标与交付：在既有「设置 → 信息 → 软件更新」卡片内补齐更新偏好（自动/手动）、
  主进程调度、后台下载、取消/暂停、忽略版本、失败恢复、安全退出时自动安装，
  并保留原有 Windows 下载、SHA256、维护锁、安装助手、回滚和版本确认。本轮在既有
  功能上完成三项安全收口：自动安装授权提交边界、偏好写入失败的真实降级、下载目标
  版本事务化；同时补齐真实自动退出安装与分层拒绝场景。未交付推送后的合并、Release、
  正式版本号变更或正式安装包发布。
- 身份：before HEAD `f58d0d19ddae9b76ad91771dc766ceb183ce4ba6`
  （`docs(update): 记录 prerelease 版本的安全降级边界`）；分支
  `feat/app-update-preferences`；after HEAD 为**包含本报告的交付提交**，可用
  `git log -1 --format=%H -- docs/in-app-update-preferences-acceptance.md` 解析。
  报告写入后该命令会指向新的报告提交，因此不在正文伪造自身 SHA。
- 证据范围：以下测试均在上面的基线加本分支工作区 diff 上运行；`dist-app` 用同一
  工作区重新构建。安装专项从未修改用户的真实安装目录、真实用户数据或正在运行的
  正式安装程序。

## 本轮根因与修复

### 1. 自动安装授权竞态（P1）

**根因**：旧实现的安全检查分别发生在退出预检、安装开始和安装流程的异步步骤之后，
但真正的提交动作是安装助手目录里的 `armed` 标记。最后一次授权检查与 `armed` 写入
之间仍可能插入 IPC、偏好切换或系统关机事件；一旦标记落盘，助手就获得了安装资格。

**修复**：

- `electron/app-update-desktop.cjs` 的 `quit()` 把授权检查与
  `fs.writeFileSync(runDir/armed)` 放在同一次同步执行里，二者之间没有 `await`。
- `electron/app-update.cjs` 在助手准备完成后、启动后各再次检查，并把同一授权回调
  传入 `quit()`，由它在 armed 前同步复核；只有 `quit()` 成功返回才视为提交。
- `armed` 写入后的任何失败都标记为 `committed`：保持 `installing`，不再写
  `cancelled`、不删除 `armed`、不强制终止安装；协调器最多补一次真实退出请求，
  让已提交事务完成。未 armed 的助手仍走既有 `release()`/`cancelled` 路径安全退出。
- 系统关机、会话结束、恢复流程和后端维护锁仍优先于自动安装；自动路径没有原生
  确认框，因此打开的浏览器页面也会阻断预检。
- 手动安装保留原生确认框；确认框返回后重新核对目标版本、忽略状态、阶段和安装
  形态，再进入同一同步授权边界。

### 2. 偏好写入失败仍按自动运行（P1）

**根因**：旧实现把「用户请求 automatic」直接当成「本次运行已生效」，写入失败时仍
允许自动下载和自动安装；`Manual` 切换失败也只影响下次启动，当前进程可能继续自动
安装。没有跨进程标记保证重启后的策略，也没有区分请求值、已落盘值和有效值。

**修复**：

- `electron/app-update-policy.cjs` 区分 `requestedPreference`、
  `persistedPreference` 和有效策略；新增 `automaticTrusted()`，要求配置已成功加载、
  已成功写入、偏好与忽略/暂停没有未确认脏值。
- 自动权限只有在 `automaticTrusted()` 为真时才成立。写入失败的 automatic 只算
  请求，本次运行按手动处理。
- 自动切手动失败、忽略/暂停写入失败时，尝试写
  `app-update-preferences.json.manual-override`；下次启动看到标记即降级为手动，
  直到用户重新保存成功并清除。标记本身也写不进去时，界面明确说「重启后可能恢复」，
  不承诺永久关闭。
- 后台「已提醒」书签、发现更高版本后清除旧忽略等非用户动作只改内存
  （`transient`），不会把未落盘的 automatic 顺手写成持久许可。
- `public/app-update.js` 显示主进程的有效策略、失败原因和「重试保存」；保存失败时
  不再把未落盘的选择画成已生效，也不在 ready 状态声称会自动安装。

### 3. 下载目标版本竞态（P2）

**根因**：旧实现用发现层的版本作为下载目标，但下载器会重新读取官方 Release；
实际资产版本可能不同。取消/忽略使用更新器上一笔 `version`，新事务开始前还会短暂
显示旧版本；元数据迟到时可能在被取消后继续启动下载，旧回调也可能覆盖新事务。

**修复**：

- `electron/app-update-manager.cjs` 为每个下载事务分配 `transactionId`，记录
  `expectedVersion`、实际 `targetVersion`、`source` 和取消/作废状态。
- `electron/app-update.cjs` 接受固定字段 `{confirm, transactionId, expectedVersion,
  approve}`；新事务开始时先清空 `version`，元数据返回后先调用 `approve`，再校验
  预期版本；批准绑定实际资产版本。
- 批准回调重新检查偏好、安装形态、忽略、暂停和发现层版本；发现层更高时旧目标
  作废，新目标在旧事务完全结束后启动；实际 Release 更高时收敛发现层，不覆盖新
  事务；重试有上限，迟到回调按 `stale`/`superseded` 拒绝。
- 取消/忽略不再猜旧版本：取消只暂停本事务已解析的实际目标；元数据未返回时取消
  整个事务；忽略使用界面显示的版本或本事务实际目标，并取消整个事务。
- 失败或取消保留其它已校验缓存；只有新事务完成且校验通过才提交 `ready`。

## 修改文件

### 本轮产品代码

| 文件 | 用途 |
| --- | --- |
| `electron/app-update-policy.cjs` | 请求/已落盘/有效策略、`automaticTrusted`、安全字段校验、原子写入、手动覆盖标记 |
| `electron/app-update-manager.cjs` | 有效策略门禁、下载事务、实际目标批准、取消/忽略目标、后台内存更新 |
| `electron/app-update.cjs` | 固定下载请求、事务编号/预期版本、批准绑定实际资产、撤销时软取消、armed 后不可逆提交 |
| `electron/app-update-desktop.cjs` | 同步 armed 提交边界、手动安装对话框后复核、快照字段 |
| `electron/app-update-quit.cjs` | 自动/显式安装授权回调、已提交失败的一次真实退出 |
| `public/app-update.js` | 有效策略、失败原因、重试保存、未知目标版本的下载提示 |

### 测试、文档与产物

- `tests/app-update-policy.cjs`（16）、`tests/app-update-manager.cjs`（35）、
  `tests/app-update-quit.cjs`（17）、`tests/app-update.cjs`（25）、
  `tests/app-update-ui.cjs`（22）、`tests/app-update-desktop-preferences.cjs`（5）、
  `tests/app-update-electron.cjs`（23）及其他既有更新套件。
- `tests/app-update-installed.cjs`：新增 `--auto` 模式，覆盖真实自动下载、正常窗口
  关闭、助手准备、armed、后端退出、主进程退出、真实 NSIS、新版本启动和数据保留；
  另含手动 + ready、自动 + 忽略、预检被浏览器阻断、助手准备失败四个拒绝场景。
  手动路径的提交失败场景改为验证「armed 后一次性退出失败仍完成安装」。
- `tests/fixtures/app-update-installed-entry.cjs`：按场景目录隔离 `quit-events.jsonl`
  等观测文件，仅观测，不修改生产代码。
- `package.json`：新增 `test:app-update:installed-auto`；版本仍为 `0.34.0`。
- 更新 `docs/windows-in-app-update.md`；本报告与
  `docs/in-app-update-preferences-evidence/` 为验收证据。

## 行为与安全边界

### 偏好持久化

主进程把偏好写在 `<userData>/app-update-preferences.json`，不写项目目录、Pi 配置
或会话。文件 schema 固定为：

```json
{"schemaVersion":1,"preference":"manual","ignoredVersion":null,"pausedVersion":null,"lastNotifiedVersion":null}
```

默认 `manual`。只接受 `automatic` / `manual`，只接受严格三段版本号
（`^\d+\.\d+\.\d+$`）。读取拒绝符号链接、目录、非普通文件、超过 4 KiB、损坏 JSON、
未知 schema；安全字段（忽略/暂停）畸形或无法确认时，整份配置按「手动」降级并保留
原文件。后台检查只把「已提醒」书签留在内存，不覆盖损坏文件；用户显式保存偏好、
忽略或取消时才原子修复。写入使用同目录临时文件、`0o600`、`fsync`、`renameSync`。

**有效策略** = 已成功落盘、且忽略/暂停没有未确认脏值的 automatic；否则为手动。
保存失败时：

| 场景 | 本次运行 | 重启后 | 界面 |
| --- | --- | --- | --- |
| 首次请求自动，写入失败 | 手动 | 手动（文件不存在或仍是旧值） | 说明未保存，按手动运行，提供重试 |
| 自动切手动，写入失败 | 手动（立即撤销自动资格） | 手动（覆盖标记存在时）；标记也失败则可能恢复自动，界面如实说明 | 显示降级原因和重试 |
| 忽略/暂停写入失败 | 自动资格立即失效 | 手动（覆盖标记） | 显示降级原因和重试 |
| 后台书签写入失败 | 自动设置不受影响 | 自动设置仍有效 | 提示书签写入失败，不误报偏好丢失 |

### 自动支持矩阵

| 平台/形态 | 自动偏好可用 | 原因 |
| --- | --- | --- |
| Windows + packaged + `mode==='installed'`（注册表 + 真实 exe 身份） | 是 | 有外部安装助手与可替换目录 |
| Windows 便携版或无法确认的安装形态 | 否 | 保持手动替换，不覆盖运行中的 exe |
| 开发模式 | 否 | 只检查和展示 Release |
| 非 Windows | 否 | 无对应安装助手 |

Renderer 的自动选项在不可用时禁用并展示原因；即使伪造 IPC 值，主进程也拒绝。

### 调度、下载事务与取消

- 启动后约 15 秒检查一次，之后每 6 小时一次；`unref` 定时器，不依赖信息页。
- 手动检查 `force` 绕过后端 30 分钟缓存；检查单飞，自动下载单飞。
- 自动下载条件：有效偏好 automatic、安装版、发现可用版本、未忽略、未暂停、
  没有活动阶段。后台失败只发布真实阶段，不循环通知。
- 每个下载事务有独立编号和预期目标；下载器重新读取官方 Release 后，以**实际资产
  版本**再次向主进程申请许可，忽略、暂停、偏好撤销和更高版本都在这一步重新检查。
- 发现层已指向更高版本时旧目标作废，新目标在旧事务完全结束后再启动，重试有上限；
  过期回调不能覆盖新事务。实际 Release 比预期更新时以实际目标为准并收敛展示版本。
- 取消只暂停本事务已解析的实际目标；元数据未返回时取消整个事务，不写猜测版本。
  取消中止网络、删除 `.part`，其它已校验缓存保留。
- 忽略只作用于界面显示的版本或本事务实际目标；下载中点击忽略会取消整个事务，
  迟到响应不能重新开始下载；已 ready 的同版本包也不能自动安装或绕过忽略手动安装。
- 手动模式的发现提醒每个版本只发一次，同一版本不重复弹。

### 退出自动安装与 armed 边界

主进程在 `before-quit` 前置闸门中检查：有效偏好 automatic、安装版、阶段 `ready`、
严格版本更高、未忽略/未暂停、没有活动阶段、非系统关机、非恢复流程、维护预检
通过。满足时 `preventDefault` 并异步预检；返回后**重新读取候选**，再走原有安装
流程。安装流程内仍重新验证官方元数据、包 SHA256、维护状态和助手身份。

**armed 是不可撤销的提交边界。** 助手完成准备后，主进程在写入 `armed` 标记的
同一次同步执行里做最后一次授权检查——检查与写入之间没有任何 `await`。检查失败则
不写 armed，按原有 `cancelled`/`release` 机制让尚未 armed 的助手退出并释放排他锁。
armed 写入后的任何失败都保持 `installing`，不再删除 armed、不写 cancelled、不强制
终止安装；应用只完成正常退出，由助手在旧主进程真正退出后决定安装或回滚。若真正
触发退出的调用本身失败，协调器只补一次真实退出请求，不重试成环，也不撤销 armed。

系统关机、会话结束、后端恢复重启都会抑制自动安装。手动点「重启以更新」保留原生
确认框；确认框停留期间目标版本、忽略状态和运行阶段都可能变化，因此 armed 前用
同一套同步授权回调再次核对，任一项变化都返回 `revoked`，不启动安装，已校验的包保留。

### 未改变的边界

- 固定官方仓库、固定资产名、HTTPS + 每一跳重定向白名单、1 GiB 上限、SHA256、
  官方元数据复读、临时目录 identity/链接检查、安装目录限制、备份/清单/回滚、
  真实版本复核全部保留。
- Renderer 仍不能提供下载 URL、安装路径、argv、更新源或版本目标；事务编号、预期
  版本和资产批准只存在于主进程与更新器之间。
- 未修改 Pi 更新接口、Pi RPC、模型供应商、OAuth、项目/会话数据和用户配置结构。
- 未更新用户正在使用的真实安装程序；未修改正式版本号；未创建 Release。

### 与 PI-Desktop 的对照

本实现参考 PI-Desktop 的**职责划分**，不移植它的 `electron-updater` 依赖或内部
下载器；pi-GUI 继续使用既有固定 Release、SHA256、维护锁、安装助手和回滚。

| PI-Desktop 的职责 | pi-GUI 的落地位置 |
| --- | --- |
| 更新控制器 / 策略：何时检查、是否自动下载 | `electron/app-update-manager.cjs`、`electron/app-update-policy.cjs` |
| 手动提醒：每个版本只提醒一次 | manager 的 `lastNotifiedVersion` 与 `public/update.js` 的一次性通知 |
| 更新偏好设置 | 信息页「软件更新」卡片内的自动/手动单选，主进程持久化到 userData |
| 后台进度与状态展示 | 既有信息卡的文字状态、进度、取消与忽略，不新增第二套更新面板 |
| 退出时安装策略 | `electron/app-update-quit.cjs` 前置闸门，复用 `electron/main.cjs` 退出流程 |
| 下载、校验、安装、恢复 | 原有 `electron/app-update.cjs`、安装助手、维护锁与回滚，不替换 |

## 证据

### 测试结果

| 证据层 | 命令/场景与代码状态 | 环境、退出码与实际结果 | 证据 |
| --- | --- | --- | --- |
| 本地定向 | `npm run test:app-update` | Windows 11 x64、Node 24.22.1；退出码 0；11 套件 **142/142**（16+35+17+25+2+6+1+5+6+22+7） | 终端输出 |
| 本地定向 | `npm run test:info` | 退出码 0；**41/41** | 终端输出 |
| 真实 Electron | `ELECTRON_DISABLE_SANDBOX=1 npm run test:app-update:electron` | 真实 Electron 44.4.3；退出码 0；**23/23**；本机裸 Electron 正常沙箱无法启动，故使用测试脚本允许的禁用沙箱开关；**不能据此声称正常裸沙箱通过** | `ui-results.json`、`update-preferences.png`、`update-preference-error.png`、`restart-ready.png`、`restart-ready-small.png` |
| 真实 Electron | `ELECTRON_DISABLE_SANDBOX=1 npm run test:info:electron` | 退出码 0；**47/47**；窗口 1320×820、700×600、字体 125% | `results.json`、`about-light-1320x820.png`、`about-dark-700x600.png`、`about-dark-1320x820.png`、`about-light-700x600.png`、`about-font-125-dark.png`、`about-update-ready-dark.png`、`about-pi-update-failed-dark.png` |
| 打包产物 | `npm run build:app -- --rebuild` | 退出码 0；产物 `dist-app/Pi GUI-win32-x64`，入口 234.9 MB，整包 333.9 MB；版本 0.34.0 | 终端输出 |
| 真实 Windows 自动退出安装 | `npm run test:app-update:installed-auto` | Windows 11 x64；退出码 0；**61/61**；真实 NSIS 0.34.0 → 0.34.1；安装包 150,895,974 字节，SHA256 `1c8bef38…5a4389`；真实信息页设为自动、无下载点击、真实关窗、真实助手/NSIS，顺序与数据保留断言全部成立；另含四个拒绝场景 | `installed-auto-e2e.json`、`installed-auto-ready.png`、`installed-auto-completed.png` |
| 真实 Windows 手动安装与已提交退出失败 | `PI_UPDATE_E2E_AUTOMATED_CONFIRM=1 PI_UPDATE_E2E_CONTINUE_FAILURE=1 npm run test:app-update:installed` | Windows 11 x64；退出码 0；**12/12**；真实 NSIS 安装 0.34.0 → 完整下载与 SHA256（150,895,978 字节，`2d5db427…369ffe`）→ Win32 真实关窗 → 原生确认 → 助手准备并写 armed → 注入的一次性 `app.quit` 失败后协调器补一次真实退出 → 0.34.1 启动，编译后端独立报告 0.34.1，七个合成用户数据文件 digest 不变 | `installed-e2e.json`、`installed-completed.png` |
| 真实 Windows 失败回滚 | 同上命令内嵌 `--failure=exit` / `--failure=version` | 各 **13/13**；两套均 `phase=rolled_back`，回滚后 0.34.1 可启动、用户数据与旧缓存保留；失败证据在子目录 | `failure-exit/installed-failure.json`、`failure-version/installed-failure.json` |
| 未通过（环境） | `npm run test:app-update:helper-startup` | 退出码 1；本机裸 Electron 正常沙箱启动即退出 `2147483651`（0x80000003）；测试脚本要求 `!no-sandbox`，未执行到助手断言。**不据此声称助手启动器在本机通过；未削弱生产安全设置** | 终端输出 |
| 未运行 | `npm run test:app-update:windows` / `app-update-windows-faults.cjs` | 未运行：需要用户提供的官方 v0.29.0 便携 ZIP；本轮离线验证不下载资产，也不触碰用户安装 | — |
| 未运行 | 完整 `npm test` | 未运行：任务允许桌面定向验证；本报告不把它冒充完整 canonical 或 CI 结果 | — |
| 独立复审 | 作者自审工作区 diff；上一轮独立 AI 复审发现项已修复 | 本轮曾两次启动独立只读复审子代理，均未返回结果（工具环境阻塞），**不计为已完成复审**；不代替人工安全审查或用户验收 | — |

### 真实自动退出安装的步骤与结果

`tests/app-update-installed.cjs --auto` 在 `os.tmpdir()` 创建独立世界，用真实 NSIS
安装 0.34.0 到含中文和空格的 TEMP 目录，使用测试专用 exe 身份、离线官方 Release
传输夹具和真实 Electron。完整流程：

1. 启动已安装的 0.34.0，确认 `mode==='installed'`、离线发现 0.34.1。
2. 确认初始偏好不是 automatic，`automaticTrusted===false`；通过真实信息页点击
   「自动」，等待主进程确认偏好已写入，再等待后台自动下载完成。
3. 不点击「下载更新」，确认完整安装包下载并通过 SHA256，`installOnQuit===true`；
   确认没有原生确认框夹具文件。
4. 真实信息页出现「将在正常安全退出应用时自动安装」。
5. 通过 Win32 `CloseMainWindow()` 发送真实 WM_CLOSE；旧进程进入正常退出协调器。
6. 外部观测时间线：维护预检 → 助手目录 → `ready` → `armed` → 后端退出 → 主进程
   退出 → 新版本窗口；所有顺序断言成立，且只有一个安装事务。
7. 真实安装助手和 NSIS 完成替换；新进程以正常沙箱启动 0.34.1，完成状态为
   `completed`，后端独立报告 0.34.1。
8. 自动偏好文件、Electron localStorage、七个合成用户数据文件全部保留；没有出现
   第二次安装事务，旧进程没有复活。

同一套件还覆盖四个拒绝场景：手动 + ready 关闭不安装；自动 + 忽略不安装；
自动 + 打开的浏览器使预检失败、不准备助手、不写 armed；安装锁使助手准备失败，
不写 armed、不启动新版本、旧应用仍可运行。全部为真实 Electron/NSIS 路径。

场景明细（同一份 `installed-auto-e2e.json`，共 61 项断言）：

| 场景 | 通过/总数 | 验证内容 |
| --- | --- | --- |
| 自动成功安装 | 32/32 | 真实 NSIS 安装 0.34.0、离线官方 Release、信息页点击自动并落盘、无下载点击的后台下载与 SHA256、`installOnQuit`、真实 WM_CLOSE、预检→助手→armed→后端退出→主进程退出→新版本窗口的顺序、0.34.1 与完成状态、偏好/设置/七个数据文件保留、无第二次事务 |
| 手动 + ready 关闭 | 7/7 | 不预检、不启动助手、不写 armed、不启动新版本，安装版本不变 |
| 自动 + 忽略 | 6/6 | 忽略后正常关闭不安装，不写 armed，版本不变 |
| 自动 + 浏览器占用 | 8/8 | 打开页面使维护预检失败，不准备助手、不写 armed、不启动新版本 |
| 自动 + 助手准备失败 | 7/7 | 只尝试一次准备，助手未 ready 即不写 armed，旧应用仍可运行 |
| 启动重建 | 1/1 | 真实打包 0.34.0 从重建产物启动 |

自动成功场景的顺序断言基于外部 `quit-events.jsonl` 与助手目录文件，不靠产品自报。

### UI 截图

均为真实 Electron 渲染（CSS、暗/亮主题、实际布局），不是 jsdom 断言：

- `installed-auto-ready.png`：自动偏好 + 0.34.1 已下载校验，界面说明正常安全退出
  时自动安装，并保留「重启以更新」「稍后」「忽略此版本」。
- `installed-auto-completed.png`：自动退出安装完成后运行 0.34.1，偏好仍为自动。
- `installed-downloading.png` / `installed-ready.png`：真实安装版的下载进度与手动
  ready 状态；手动 ready 不声称退出时自动安装。
- `installed-completed.png`：手动安装路径的已提交退出失败后仍完成安装并运行新版本。
- `about-light-1320x820.png` / `about-dark-700x600.png`：信息页浅色宽窗与深色窄窗布局；
  `about-dark-1320x820.png` / `about-light-700x600.png` 为相反组合。
- `about-font-125-dark.png`：125% 字体下宽窗内容不溢出；`about-update-ready-dark.png`
  与 `about-pi-update-failed-dark.png`：应用更新 ready 与 Pi 更新失败两种状态。
- `update-preferences.png` / `update-preference-error.png`：偏好行与保存失败的真实
  渲染；失败时显示有效手动策略和重试入口。
- `restart-ready.png` / `restart-ready-small.png`：ready 状态在宽窗与窄窗的布局。
- `downloading.png` / `download-failed.png` / `update-waiting.png`：下载中、下载
  失败与助手等待状态的渲染。

### 状态机与恢复路径

```
idle → downloading → verifying → preparing → ready → installing
  │         │            │           │
  └──────── failed / cancelled ←──────┘
                    │
              recovering（撤销准备/等待助手释放锁）
```

偏好/发现/忽略/暂停是主进程快照上的正交字段，不另造第二套状态。自动偏好下，
`ready` 只是自动安装候选，不是安装许可；退出预检和安装流程会各自重新校验。
`armed` 之后不再进入 `cancelled`，失败只保持 `installing` 并完成退出。

## 失败与修复历史

1. 策略测试曾在缺文件时把 `loaded` 设成 true；改为只在合法解析后置位。
2. 调度测试期望 15 秒/6 小时，而 helper 默认 60 秒；统一为 15 秒/6 小时。
3. 自动下载测试的假下载器未发 `downloading`，导致自动单飞看不到活动阶段；
   假下载器补发阶段事件。
4. 偏好保存失败后重绘使用旧快照，界面曾短暂显示错误选择；引入 `appliedValue`
   并按已生效值回退。
5. 首次渲染偏好提示与实际保存值不一致；增加 `applyHint` 并在成功/失败时更新。
6. 信息页同时出现「发现新版本」与偏好状态两行；有偏好行时改为 compact 状态。
7. `about-info-electron` 启动时未主动检查更新，首屏停在 idle；补上
   `await U.checkForUpdate()`。
8. 700×600 截图发现真实布局缺陷：信息卡内 `position:sticky` 操作条固定在滚动容器
   下内边距处，压住版本行与偏好行；在 `.about-update-panel` 内改为静态定位。
9. 安装专项初始复制清单缺少 `vendor`、`assets`，随后发现点击坐标在窗口外、
   首次设置向导覆盖信息页；均属测试夹具问题，补齐并加入滚入视口/向导处理后，
   真实安装与两种回滚通过。产品代码未因此绕过任何安全步骤。
10. 复审发现「已校验旧包 + 发现的更高版本已被忽略」会显示一个必然失败的下载按钮；
    改为提供「取消忽略」，并补 UI 用例。
11. 独立复审发现信息页挂载后 `connectAppUpdate` 的 refresh 回调被替换成单纯重绘；
    改为后台推送也执行 `applyDesktopSnapshot`。
12. 复审发现自动安装开始后不再复核偏好/忽略；更新器 `install` 增加内部
    `authorize` 回调，在每个异步校验/准备步骤后复核。
13. 复审发现手动检查可能与在飞的后台非强制检查合并，吃不到 `force`；现在若在飞
    检查不是强制的，手动请求会等它结束后再补一次强制检查。
14. 复审发现后台「已提醒」书签会修复损坏的偏好文件；后台书签写入改为只更新内存。
15. 复审还发现窗口销毁后系统关机事件无处投递；正常关闭现在先经 `before-quit`
    协调器，关机事件优先放行。
16. 本轮真实自动 E2E 首次失败在渲染文本断言：打包夹具的首个环境向导会短暂覆盖
    信息页。改为在重试循环内先 `ensureInfo()` 再读取实时文本；这是测试稳健性修复，
    产品 UI 在正常信息页上确实渲染了该文案。
17. 真实自动 E2E 第二次失败在解析助手写的 `result.json`：Windows PowerShell 5.1
    写入 UTF-8 BOM，测试直接 `JSON.parse` 报错。生产
    `app-update-recovery.cjs` 已经用 `.replace(/^﻿/,'')` 处理 BOM；测试补上
    同样的读取方式，不修改产物格式。
18. 真实自动 E2E 发现更新器在批准前就用 `expectedVersion` 拒绝了更新的实际
    Release，导致 manager 的「实际目标收敛」路径不可达；改为先调用 `approve`，
    再校验预期版本，且只允许批准明确绑定实际版本时放行，并补更新器用例。
19. 后台收敛最初会把未保存的 automatic 写盘，并把瞬时清除当成脏值；引入
    `transient` 选项，后台只改内存，不产生持久许可。
20. 手动路径的「退出失败后恢复旧应用」E2E 在 armed 提交边界收紧后不再成立：
    armed 已落盘时不能安全撤销。更新测试为「一次性 `app.quit` 失败后协调器补一次
    真实退出，助手仍完成安装」；同时修复显式安装已提交失败时未请求退出的缺口，
    并补协调器单测。首版修复错误地把 `quitIssued`（已尝试退出）当成退出成功，
    真实 E2E 发现应用停在 `installing`；改为对已提交失败无条件补一次退出，并用
    单测模拟真实的先标记后失败顺序。旧应用回滚/恢复仍由两种真实 NSIS 失败套件覆盖。

## 限制与残余风险

- 当前应用版本必须是严格三段号（当前 `0.34.0` 满足），manager 才启用；若未来
  发布 `-rc` 等 prerelease 构建，更新偏好/检查会安全降级为不可用而不是自动更新。
- 自动安装只在确认的 Windows NSIS 安装版启用；未在本机真实用户安装位置执行，
  仅使用 TEMP 隔离副本和测试专用 exe 身份/NSIS 副本。不能据此声称正式签名发布包
  在原位置升级通过。
- 手动安装专项使用测试专用自动确认夹具，**没有人工点击真实原生对话框**；最后一次
  人工交互验收仍需操作者执行。自动专项确认没有出现该夹具文件。
- `test:app-update:helper-startup` 因本机裸 Electron 正常沙箱限制未验证；
  打包应用正常沙箱只在安装专项中覆盖。
- 未注入断电、强杀、真实签名、杀毒软件或系统关机级故障；已覆盖下载损坏、
  提交前助手准备失败、NSIS 非零退出和版本不符回滚。
- 未运行完整 `npm test`、PR/main CI；这些不能由作者自测替代。本轮两次独立只读
  复审子代理都未返回结果（工具环境阻塞），本轮没有新的独立复审结论；上一轮发现项
  已修复，但不代替人工安全审查，也不能替代用户批准。
- 系统关机/注销与窗口关闭、自动预检的事件顺序只在代码和单测层验证；真实 Windows
  关机流程中的 `query-session-end`/`session-end` 时序仍需人工专项验收。
- `test:app-update:electron` / `test:info:electron` 使用
  `ELECTRON_DISABLE_SANDBOX=1`，正常裸沙箱的纯 UI 验收仍未完成。
- 偏好文件被同用户进程在运行期间外部删除/替换时，进程内仍使用已确认的持久状态；
  下一次启动会按文件实际内容安全降级。未做运行期文件监视。
- `armed` 后如果真实退出持续失败，只补一次退出请求；应用可能停留在 `installing`，
  助手等待父进程。该路径未在真实系统中强制注入持续性退出失败。

## 回滚

回退本分支提交即可恢复旧行为；偏好文件位于 userData，不涉及项目、会话或 Pi 配置。
重新构建的 `dist-app`/`build` 是本地产物，可按构建脚本重新生成或删除；
隔离安装专项只写 `os.tmpdir()`，不触及用户程序与真实数据。

## 待用户决定

- 是否安排人工代码/安全审查（上一轮 AI 独立复审已执行并修复发现项；本轮两次独立
  子代理复审均未完成，且不代替人工）。
- 是否允许合并到 main、创建 Release 或更新正式版本号；目前均未执行。
- 是否接受 helper-startup 因本机沙箱环境未验证，或改在支持正常沙箱的 Windows/CI
  环境补跑。
- 是否需要操作者补一次真实原生确认对话框的人工点击验收。
- 是否需要补一次真实 Windows 关机/注销专项，验证事件顺序与不安装边界。

## 结论

- 开发完成：**已完成**（授权提交边界、持久化失败降级、下载事务、真实自动退出
  安装与分层拒绝场景、文档和隔离 Windows 证据）。
- 代码验收：**作者定向验证通过；上一轮独立 AI 复审发现项已修复；本轮两次独立
  子代理复审均未返回结论；用户验收未完成**。
- 合并建议：**建议在人工审查与用户明确授权后合并**；当前未获合并授权，未合并。
- 合并许可：**未授权，未合并**。
- 发布许可：**未授权，未发布、未改正式版本号**。
