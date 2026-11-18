# 应用更新偏好与安全退出安装 验收材料

- 目标与交付：在既有「设置 → 信息 → 软件更新」卡片内补齐更新偏好（自动/手动）、
  主进程调度、后台下载、取消/暂停、忽略版本、失败恢复、安全退出时自动安装，
  并保留原有 Windows 下载、SHA256、维护锁、安装助手、回滚和版本确认。
  本轮交付了功能、UI、测试、文档与重新构建的桌面产物；未交付推送、合并、
  Release、版本号变更或正式安装包发布。
- 身份：before HEAD `68e65b2642f753b49ae6e08dca30b1da16a0fec4`（`merge: 信息页滚动与底部留白修复`）；
  分支 `feat/app-update-preferences`；after HEAD 为**包含本报告的交付提交**，
  可用 `git log -1 --format=%H -- docs/in-app-update-preferences-acceptance.md`
  解析。报告写入后该命令会指向新的报告提交，因此不在正文伪造自身 SHA。
- 证据范围：以下测试均在上述基线加本分支工作区 diff 上运行；`dist-app` 用同一
  工作区重新构建。安装专项从未修改用户的真实安装目录或真实用户数据。

## 修改文件

### 产品代码

| 文件 | 用途 |
| --- | --- |
| `electron/app-update-policy.cjs`（新增） | 严格版本比较、自动安装支持矩阵、偏好文件原子读写与安全降级 |
| `electron/app-update-manager.cjs`（新增） | 主进程唯一状态源：15 秒/6 小时调度、检查与自动下载单飞、忽略/暂停、ready 通知、退出候选 |
| `electron/app-update-quit.cjs`（新增） | 正常退出自动安装闸门、预检后重新校验、失败回落普通退出 |
| `electron/app-update-desktop.cjs` | 接入偏好 store/manager/coordinator；新增固定 IPC；快照与通知；恢复时抑制自动安装 |
| `electron/app-update.cjs` | 下载/安装前强制重新读取官方元数据 |
| `electron/main.cjs` | `readUpdate({force})`；退出事件接入协调器；系统关机/会话结束抑制 |
| `electron/preload.cjs` | 暴露固定的 check/preference/ignore/unignore/download/cancel/install 能力 |
| `public/app-update.js` | 偏好行、阶段状态、进度、取消/忽略、错误与保存失败的真实渲染 |
| `public/update.js` | 桌面订阅主进程快照与一次性通知；网页版保留本地 8 秒检查 |
| `public/ui/primitives.js` | segmented control 支持单项禁用与恢复 |
| `public/styles.css` | 偏好行、状态、错误样式；窄窗布局；信息卡操作栏回正常文档流 |

### 测试与文档

- 新增 `tests/app-update-policy.cjs`（10）、`tests/app-update-manager.cjs`（24）、
  `tests/app-update-quit.cjs`（13）、`tests/app-update-desktop-preferences.cjs`（4）。
- 扩展 `tests/app-update-ui.cjs`（20）、`tests/app-update-electron.cjs`（23）、
  `tests/about-info-electron.cjs`（47）、`tests/about-info.cjs`（41）。
- `tests/app-update-installed.cjs`：补齐 E2E 夹具复制 `vendor`/`assets`，并把信息页
  操作按钮滚入视口、处理首次设置向导；这是为了在隔离 TEMP 环境中稳定复现真实
  Windows 安装路径，不改变产品行为。
- `package.json`：`test:app-update` 链加入四个新套件；版本仍为 `0.34.0`。
- 更新 `docs/updates.md`、`docs/windows-in-app-update.md`、`docs/README.md`；
  本报告与 `docs/in-app-update-preferences-evidence/` 为本次验收证据。

## 行为与安全边界

### 偏好持久化

主进程把偏好写在 `<userData>/app-update-preferences.json`，不写项目目录、Pi 配置
或会话。文件 schema 固定为：

```json
{"schemaVersion":1,"preference":"manual","ignoredVersion":null,"pausedVersion":null,"lastNotifiedVersion":null}
```

默认 `manual`。只接受 `automatic` / `manual`，只接受严格三段版本号（`^\d+\.\d+\.\d+$`）。
读取拒绝符号链接、目录、非普通文件、超过 4 KiB、损坏 JSON、未知 schema；这些
情况保持手动并保留原文件。后台检查只把「已提醒」书签留在内存，不会覆盖损坏文件；
用户显式保存偏好、忽略或取消时才原子修复。写入使用同目录临时文件、
`0o600`、`fsync`、`renameSync`；失败时内存状态继续生效但 `persisted:false`
并在界面明确说明重启后可能回退。

### 自动支持矩阵

| 平台/形态 | 自动偏好可用 | 原因 |
| --- | --- | --- |
| Windows + packaged + `mode==='installed'`（注册表 + 真实 exe 身份） | 是 | 有外部安装助手与可替换目录 |
| Windows 便携版或无法确认的安装形态 | 否 | 保持手动替换，不覆盖运行中的 exe |
| 开发模式 | 否 | 只检查和展示 Release |
| 非 Windows | 否 | 无对应安装助手 |

Renderer 的自动选项在不可用时禁用并展示原因；即使伪造 IPC 值，主进程也拒绝。

### 调度、下载与取消

- 启动后约 15 秒检查一次，之后每 6 小时一次；`unref` 定时器，不依赖信息页。
- 手动检查 `force` 绕过后端 30 分钟缓存；检查单飞，自动下载单飞。
- 自动下载条件：有效偏好 automatic、安装版、发现可用版本、未忽略、未暂停、
  没有活动阶段。后台失败只发布真实阶段，不循环通知。
- 取消：中止网络、删除 `.part`、其它已校验缓存保留，阶段 `cancelled`；写入
  `pausedVersion`，重启后仍在，直到用户重新下载或发现更高版本。
- 忽略：只针对当前严格版本，持久化；阻断自动下载/自动安装/重复提醒；已 ready
  的同版本包也不能自动安装或绕过忽略手动安装。发现更高版本自动清除忽略。
- 手动模式的发现提醒每个版本只发一次，同一版本不重复弹。

### 退出自动安装

主进程在 `before-quit` 前置闸门中检查：有效偏好 automatic、安装版、阶段 `ready`、
严格版本更高、未忽略/未暂停、没有活动阶段、非系统关机、非恢复流程、维护预检
通过。满足时 `preventDefault` 并异步预检；返回后**重新读取候选**，再走原有安装
流程。安装流程内仍重新验证官方元数据、包 SHA256、维护状态和助手身份。
预检失败、状态变化、安装准备失败都会撤销准备并回落到普通退出，保留可恢复缓存；
不强制终止会话或任务。系统关机、会话结束、后端恢复重启都会抑制自动安装。

### 未改变的边界

- 固定官方仓库、固定资产名、HTTPS + 每一跳重定向白名单、1 GiB 上限、SHA256、
  官方元数据复读、临时目录 identity/链接检查、安装目录限制、备份/清单/回滚、
  真实版本复核全部保留。
- Renderer 仍不能提供下载 URL、安装路径、argv、更新源或版本目标；新增 IPC 只接受
  固定操作和允许字段。
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
| 本地定向 | `npm run test:app-update` | Windows 11 x64、Node 24.22.1；退出码 0；11 套件 **109/109**（10+24+13+16+2+6+1+4+6+20+7） | 终端输出；`docs/in-app-update-preferences-evidence/` |
| 本地定向 | `npm run test:info` | 退出码 0；**41/41** | 终端输出 |
| 真实 Electron | `npm run test:info:electron` | 真实 Electron 44.4.3；退出码 0；**47/47**；窗口 1320×820、700×600、字体 125%；测试以 `--no-sandbox` 启动 | `about-info-results.json`、`about-light-1320x820.png`、`about-dark-700x600.png` |
| 真实 Electron | `ELECTRON_DISABLE_SANDBOX=1 npm run test:app-update:electron` | 退出码 0；**23/23**；本机裸 Electron 正常沙箱无法启动，故使用测试脚本允许的禁用沙箱开关；**不能据此声称正常裸沙箱通过** | `app-update-ui-results.json`、`update-preferences.png`、`update-preference-error.png`、`restart-ready.png`、`restart-ready-small.png` |
| 打包产物 | `npm run build:app -- --rebuild` | 退出码 0；产物 `dist-app/Pi GUI-win32-x64`，入口 234.9 MB，整包 333.8 MB；版本 0.34.0 | 终端输出 |
| 真实 Windows 安装 | `PI_UPDATE_E2E_AUTOMATED_CONFIRM=1 npm run test:app-update:installed` | 退出码 0；**13/13**；TEMP 隔离 NSIS 安装、真实 Electron/helper/NSIS；0.34.0 → 0.34.1；安装包 150,889,154 B，SHA256 `676f63…a57a`；normal sandbox 为 true；确认应答为测试夹具，**不是人工点击原生对话框** | `installed-e2e.json`、`installed-completed.png`、`installed-recovered.png` |
| 真实 Windows 失败回滚 | `npm run test:app-update:installed-failure -- --world=<同一 TEMP 世界> --failure=exit` | 退出码 0；**13/13**；真实部分写入 NSIS 后非零退出；恢复 489 个文件、31 个目录，完整清单摘要一致；结果 `rolled_back` | `installed-failure-exit.json` |
| 真实 Windows 失败回滚 | 同上 `--failure=version` | 退出码 0；**13/13**；NSIS 退出 0 但版本不符；同样恢复并 `rolled_back` | `installed-failure-version.json` |
| 未运行 | `npm run test:app-update:helper-startup` | **未通过（环境）**：本机裸 Electron 正常沙箱启动即退出 `2147483651`（0x80000003），测试脚本明确要求 `!no-sandbox`，未执行到助手断言。打包应用正常沙箱已在安装专项中通过，因此这不是产品安装断言失败 | 终端输出 |
| 未运行 | `npm run test:app-update:windows` / `app-update-windows-faults.cjs` | 未运行：需要用户提供的官方 v0.29.0 便携 ZIP；本轮离线验证不下载资产，也不触碰用户安装 | — |
| 未运行 | 完整 `npm test` | 未运行：任务允许桌面定向验证；本报告不把它冒充完整 canonical 或 CI 结果 | — |
| 独立复审 | AI 子代理只读审查工作区 diff | 发现 2 个重要、4 个次要问题；均已修复并补回归用例（见「失败与修复历史」11–15）。**不代替人工安全审查或用户验收** | 复审输出与对应测试 |

### UI 截图

均为真实 Electron 渲染（CSS、暗/亮主题、实际布局），不是 jsdom 断言：

- `about-light-1320x820.png`：信息页浅色，偏好行、单一状态行、说明区与主操作。
- `about-dark-700x600.png`：窄窗深色；修复后版本行、偏好行不再被粘性操作条压住。
- `update-preferences.png`：更新卡内自动/手动偏好。
- `update-preference-error.png`：保存失败时可见错误，选择不伪造成功。
- `restart-ready.png` / `restart-ready-small.png`：ready 状态在宽窗与窄窗的布局。
- `installed-completed.png`：真实隔离安装后运行版本 0.34.1 与「已确认运行版本」。
- `installed-recovered.png`：安装交接失败并回滚恢复后的旧版本界面。

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
   下内边距处，压住版本行与偏好行；在 `.about-update-panel` 内改为静态定位，
   DOM 几何复测操作条回到正常流。
9. 安装专项初始复制清单缺少 `vendor`、`assets`，随后发现点击坐标在窗口外、
   首次设置向导覆盖信息页；均属测试夹具问题，补齐并加入滚入视口/向导处理后，
   真实安装与两种回滚通过。产品代码未因此绕过任何安全步骤。
10. 复审发现「已校验旧包 + 发现的更高版本已被忽略」会显示一个必然失败的下载按钮；
    改为提供「取消忽略」，并补 UI 用例。另修正忽略动作的目标选择：优先当前更新器
    持有的已显示版本，而不是较新的发现版本，避免忽略错包。
11. 独立复审发现信息页挂载后 `connectAppUpdate` 的 refresh 回调被替换成单纯重绘，
    15 秒/6 小时后台检查的结果不再映射到 `status/release`；改为挂载后的回调也执行
    `applyDesktopSnapshot`，并补「后台推送后已挂载页面出现真实操作」用例。
12. 复审发现自动安装开始后不再复核偏好/忽略；更新器 `install` 增加内部
    `authorize` 回调，在每个异步校验/准备步骤后复核，launch 前最后再查一次。
    失败会释放维护锁、保留 ready 缓存并返回 `revoked`。新增 manager/updater/
    coordinator 三层用例。
13. 复审发现手动检查可能与在飞的后台非强制检查合并，吃不到 `force`；现在若在飞
    检查不是强制的，手动请求会等它结束后再补一次强制检查，仍保持单飞。
14. 复审发现后台「已提醒」书签会修复损坏的偏好文件，与「用户保存才修复」不符；
    后台书签写入改为只更新内存，显式保存偏好/忽略/取消才修复。保存失败文案也从
    「偏好写入失败」改为覆盖偏好、忽略、暂停的「更新设置写入失败」。
15. 复审还发现窗口销毁后系统关机事件无处投递；正常关闭现在先经 `before-quit`
    协调器（保持窗口存活到预检），关机事件优先放行，更新器内部的 `authorize`
    也会看到关机标记。未在真实 Windows 关机流程中验证事件顺序，见限制。

## 限制与残余风险

- 自动安装只在确认的 Windows NSIS 安装版启用；未在本机真实用户安装位置执行，
  仅使用 TEMP 隔离副本和测试专用 exe 身份/NSIS 副本。不能据此声称正式签名发布包
  在原位置升级通过。
- 安装专项使用测试专用自动确认夹具，**没有人工点击真实原生对话框**；最后一次
  人工交互验收仍需操作者执行。
- `test:app-update:helper-startup` 因本机裸 Electron 正常沙箱限制未验证；
  打包应用正常沙箱只在安装专项中覆盖。
- 未注入断电、强杀、真实签名、杀毒软件或系统关机级故障；已覆盖下载损坏、
  退出交接失败、安装器非零退出和版本不符回滚。
- 未运行完整 `npm test`、PR/main CI；这些不能由作者自测替代。独立复审是 AI 子代理
  的只读代码审查，不是人工安全审查，也不能替代用户批准。
- 系统关机/注销与窗口关闭、自动预检的事件顺序只在代码和单测层验证；真实 Windows
  关机流程中的 `query-session-end`/`session-end` 时序仍需人工专项验收。
- `test:app-update:electron` 使用 `ELECTRON_DISABLE_SANDBOX=1`，正常裸沙箱的
  纯 UI 验收仍未完成。

## 回滚

回退本分支提交即可恢复旧行为；偏好文件位于 userData，不涉及项目、会话或 Pi 配置。
重新构建的 `dist-app`/`build` 是本地产物，可按构建脚本重新生成或删除；
隔离安装专项只写 `os.tmpdir()`，不触及用户程序与真实数据。

## 待用户决定

- 是否另行安排人工代码/安全审查（AI 只读复审已执行并修复发现项，不代替人工）。
- 是否允许推送该分支、合并到 main、发布或更新正式版本号；目前均未执行。
- 是否接受 helper-startup 因本机沙箱环境未验证，或改在支持正常沙箱的 Windows/CI
  环境补跑。
- 是否需要操作者补一次真实原生确认对话框的人工点击验收。
- 是否需要补一次真实 Windows 关机/注销专项，验证事件顺序与不安装边界。

## 结论

- 开发完成：**已完成**（功能、UI、测试、文档、隔离 Windows 安装/回滚证据）。
- 代码验收：**作者定向验证通过；独立 AI 复审发现项已修复；用户验收未完成**。
- 合并许可：**未授权，未合并**。
- 发布许可：**未授权，未发布、未改正式版本号**。
