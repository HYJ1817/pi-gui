# Windows 应用内更新验收报告

日期：2026-10-20，Windows x64；独立分支 `codex/windows-in-app-update`。当前修复及验证结果见文末「复审修复补充」；以下首轮记录基于 `31e7f71`，当时尚未推送，之后已按用户授权推送分支。原工作区保留给另一个对话；未将功能合并 main、未创建 Release、未改签名或发布审批。

结论：本地实现和隔离验收完成，可供人工审查。正式签名产物、真实用户安装位置及下一版公网 Release 的全链路升级仍未验证，不能将本报告视为发布批准。本地候选版本仍为 0.26.2。

## 实现

- 主进程复用 `/api/update` 的官方 Release 检测，严格绑定仓库、版本、资产名、大小及 SHA256；拒绝 Renderer URL、路径、argv。支持下载进度/速度、取消、重试和缓存复验。
- 设置区独立滚动说明、固定操作区、稍后、重启确认，保留 Release 和手动下载。便携版验证 ZIP 后手动替换，开发模式仅检查。
- 私有父子 IPC 维护锁检查全部会话、审批、未答 RPC/命令、工具、进程、认证及文件变更 lease；更新退出路径不强杀活动 Agent。
- 外部助手核对父进程身份，等待退出并证明 exe 已解除映射占用，持安装锁及安装包只读句柄，备份程序文件、调用 NSIS、验证版本、失败恢复及重启。诊断结果写入失败不影响控制顺序。

详细设计和错误恢复见 [功能说明](../windows-in-app-update.md)。

## 实测结果

| 命令 / 检查 | 实际结果 |
| --- | --- |
| `npm run test:app-update` / 4 个离线专项文件 | 21/21，0 skipped；最新原始输出见 [unit-results.txt](unit-results.txt) |
| `npm run test:app-update:electron` | 14/14；真实 Electron、生产设置模块和 CSS，桌面能力为离线夹具 |
| `npm run test:app-update:windows -- --previous-zip=<官方0.26.0 ZIP>` | 13/13；真实完整旧/新程序、NSIS、外部助手、退出及重启 |
| `node tests/app-update-windows-faults.cjs` | 6/6；真实 NSIS 超时及结果文件不可写注入 |
| `node tests/update-check.cjs` | 87/87，与基线相同 |
| `node tests/electron-guard.cjs` | 123/123，与基线相同 |
| `node tests/runtime-registry.cjs` | 35/35 |
| `node tests/pi-update.cjs` | 173/173 |
| `node tests/session-tool-scheduler.cjs` | 9/9 |
| `node tests/session-tool-bridge.cjs` | 4/4 |
| `node tests/session-revert-admission.cjs` | 15/15 |
| `node tests/session-runtime.cjs` | 7/7 |
| `node tests/reliability.cjs` | exit 0，输出 `reliability: passed`；该脚本不报告断言总数 |
| `node tests/smoke.cjs` | 1338/1338，无断言数减少 |
| `node tests/ci-test-plan.cjs` | 161 个叶命令，5 组，覆盖完全一致 |
| 源码与 Electron 包文件逐字节比较 | 20/20 相同，见 [build-equality.json](build-equality.json) |
| `git diff --check` | exit 0，仅存在 Git 换行规范提示 |

按用户要求未重复执行完整 `npm test`。新增默认离线专项已进入唯一测试链；需要真实 Windows/桌面的专项保留显式入口。

## Windows 升级证据与边界

官方旧版输入：`Pi-GUI-0.26.0-portable.zip`，148,929,350 bytes，SHA256 `c3f3bdaf0d58967954a515a2ddaef6badf8ae42c38bcf35dedf9771b731bc020`，与官方 GitHub Release API digest 相符。首次下载截断被发现，未用于安装；完整重取并校验后才继续。

验收在 `os.tmpdir()` 中安装完整旧版，确认真实后端为 0.26.0，然后验证：

1. 助手在旧主进程退出前不替换程序文件。
2. 安装器先部分写入再非零退出，旧文件恢复，真实旧版后端重新启动。
3. 备份失败时不安装，旧版本仍自动重新启动。
4. 正常安装后真实新后端和落地 package 都为 0.26.2。
5. 项目、会话、供应商、OAuth、设置、草稿、Runtime 七类合成哨兵的哈希全部保持不变；没有用真实用户数据做写验证。

原始结果见 [windows-results.json](windows-results.json)。该次隔离候选安装器 SHA256 为 `8802fd8faabafc5d33b6085f3e6b053c6bd884e10c9d7a1ef3e2385878b65a6e`，与下面正式构建布局的本地安装器是不同测试产物。

为保护正在运行的用户 Pi GUI，测试复制的 NSIS 脚本只剥离注册表/快捷方式写入，采用独立 exe 文件名及更快的 zlib 压缩；文件提取、运行实例拒绝、错误码和升级逻辑复用真实脚本。旧程序从已验证的官方 ZIP 提取，新程序从最终重建目录复制。最终迭代复用了早先由同一夹具生成的旧版安装器，新版夹具安装器重新编译。

首次使用生产 exe 名称的隔离安装返回 20，因为用户真实应用正在运行：这是预期拒绝，未计作成功升级，也没有关闭用户的应用。生产注册表、快捷方式、正式安装目录和真实签名更新未作写验证。

测试子进程有 Windows Low 完整性限制：仅对新建临时夹具设置 Low 标签，并在测试环境使用 `ELECTRON_DISABLE_SANDBOX=1` / `--no-sandbox`；生产窗口安全设置没有更改。旧实例通过其专属 CDP 端口的 `Browser.close` 正常退出；没有依赖强杀来证明升级退出成功。

## 故障注入与独立审查

独立功能/安全审查共三轮。注册表来源、待审批空闲会话、内部数字 ID 与外部字符串 ID 冲突、checksum fallback 的信任重建均已修复并有针对性回归。

第三轮发现：超时结果记录写失败可能绕过等待并进入回滚。作者定点修复为诊断写入不抛错，停止扩大自动审查；未做第四轮。故障用例将结果路径替换为目录，真实 NSIS 延迟退出，将助手超时阈值仅在测试副本缩短至 500 ms，证实：助手继续等待、安装锁仍持有、NSIS 活着时不回滚、真实退出后才结束、数据不变，6/6。原始结果见 [timeout-fault-results.json](timeout-fault-results.json)。最后一轮审查的发现由作者验证关闭，不能描述成独立审查者已重新批准。

真实安装还发现主进程 handle 未释放时 exe 可能仍被映射，导致回滚写入失败；现已在等待后释放 handle 并检查排他写打开。最终重跑 13/13。PowerShell 夹具没有 `Get-FileHash` 的兼容问题已改为纯 .NET SHA256。早期失败结果没有计入最终通过分母。

独立审查者一次临时 helper 编译验证被自动审批以 `blocked by policy` 拒绝，未提供更详细理由，已停止该路径；本报告的实际验收来自随后单独的 NSIS 隔离测试。

## 构建与产物

`npm run build:app -- --rebuild` 已完整构建后端；此后仅 Electron 助手变动时，用 `npm run build:app` 重新组装，最终 20/20 文件相等。使用本机已存在的 Electron 44.4.3 ZIP 离线打包，没有下载新依赖。由于 esbuild 子进程不能写此工作区，构建改为 `write:false` 后由 Node 写相同输出，作为独立回滚边界提交。

最终 `npm run build:installer` exit 0，耗时 185 秒；LZMA 安装器 105,482,472 bytes，SHA256 `e324b3cbea0076b631059c8e3527aef1e47eb472c923fbf675572cac7f3bcc49`。相对工作区路径：

- `dist-app/Pi GUI-win32-x64/Pi GUI.exe`：328.5 MB 整包。
- `dist-installer/Pi-GUI-Setup-0.26.2.exe` 及同目录 `SHA256SUMS.txt`。

这些是本地未发布候选产物，不是正式 Release。既有 SEA 注入步骤仍打印签名相关 warning，没有改变签名配置或执行签名发布。

截图：[下载中](downloading.png)、[下载失败](download-failed.png)、[重启就绪](restart-ready.png)、[小窗口](restart-ready-small.png)；UI 结果见 [ui-results.json](ui-results.json)。截图中的 0.27.0 是离线 UI 夹具版本，不是已发布版本。

## 剩余风险、回滚和人工决策

- 未验证正式签名后的下一版公网下载 → 原安装位置覆盖 → 用户真实 OAuth/会话的全链路；需发布前在专用 Windows 用户/VM 中确认，不触碰当前用户的数据。
- 系统断电、磁盘损坏、杀死助手或安装器，以及用户在安装中手动再启动应用，可能要求从临时备份恢复或手动重装。超时安装器不会被强杀；未确认其退出时保留锁、不并发回滚。
- 安装包缓存与应用备份占用临时空间，当前保留供恢复；系统清理后需重新下载。GitHub 发布账号本身被接管不在 SHA256 机制能抵御的范围。
- 开发改动按构建适配、业务功能、测试/文档分开提交，可依次回退；用户数据不参与代码回滚。安装失败优先助手恢复，`recovery_required` 时保留备份并手动重装。
- 高风险安装变更仍需用户人工批准后才能合并或发布；本任务没有执行这些操作。
# 2026-10-20 复审修复补充

本节更新上文历史验收结论；历史 13/13 升级夹具仍不代表正式安装位置验证通过。

- 已复现并修复启动恢复缺陷。新增回归在修复前 2/6 通过、4 项失败；修复后活动/恢复套件 6/6，原有 3 项保留，新增 3 项，无断言删减。成功、失败均消费对应 `pending.json`，下次启动不重复；助手排他锁未释放时显示等待、拒绝再次下载/安装，并主动推送最终结果。
- 路径穿越和硬链接诊断文件被拒绝，不删除链接目标。辅助程序、NSIS、任务停止及签名发布规则未作行为调整。
- `origin/main` 的 `c5a1d1c`（包含 `bda1d4a`）已通过合并提交 `f0ee2d0` 同步**进入更新分支**；新增主线差异只有开发服务器断言和 Chrome/Edge 发现测试修复。没有将功能合入 main。
- 本轮按用户要求由同一作者检查新增 diff，没有调用子代理，也没有声称新增 diff 已获独立功能/安全复审批准。高风险变更仍需最终人工决策。

本轮实测（均 exit 0；未重复完整 `npm test`）：

| 命令 | 结果 |
| --- | --- |
| `npm run test:app-update` | 24/24（15 下载/安装控制 + 2 维护 + 6 活动/恢复 + 1 真实后端） |
| `npm run test:app-update:electron` | 16/16，原有 14 项保留，新增等待及失败手动入口 2 项 |
| `node tests/app-update-windows-faults.cjs` | 6/6，真实 NSIS 超时故障注入 |
| `node tests/dev-server.cjs` | 30/30 |
| `UI2C_CDP_PORT=19276 node tests/ui2-visual.cjs`（PowerShell 用环境变量赋值） | 57/57，真实 Chrome |
| `node tests/update-check.cjs` | 87/87 |
| `node tests/electron-guard.cjs` | 123/123 |
| `npm run build:app -- --rebuild` | 成功，本机缓存 Electron 44.4.3 离线构建 |
| `npm run fixtures` 后 `node tests/app-check.cjs` | 26/26；真实打包后端、fixture Pi、临时数据 |
| 打包目录与相关源码 SHA256/内容比对 | 21/21，新增恢复模块已包含，见 `build-equality.json` |
| `npm run build:installer` | 成功，195 秒；原样标准 NSIS 脚本编译，未执行正式安装 |

本轮本地候选 `dist-installer/Pi-GUI-Setup-0.26.2.exe`：105,470,207 bytes；SHA256 `a709f80ea6fb7bbea4bfc1cf3db36ad1ee90439ed6bc6a5d8526eecb68c3c381`。它包含恢复修复，替代上文历史构建数字；未发布、未新增签名操作。

新截图：[助手等待更新](update-waiting.png)；Electron 原始结果：[ui-results.json](ui-results.json)。所有写用例仍使用临时 fixture，未更改当前用户实际安装或数据。

**尚未验证：未改动正式 NSIS 安装程序在独立 Windows 用户或 VM 的原安装位置升级。** 本机为 Windows 11 家庭版，未发现可用的 Hyper-V/VMware/VirtualBox/Windows Sandbox 环境；当前实际应用未被关闭或覆盖。没有自行创建账户或启用系统功能。具体执行和证据要求见 [正式安装验收清单](FORMAL-INSTALL-ACCEPTANCE.md)。本轮不再重复旧的 13 项重型改名夹具测试，因其不能补齐这一缺口。该项继续阻断完整安装升级验收，不能用本轮测试数字替代。

回滚本次恢复修复可撤销对应修复提交；备份、用户数据及旧安装包不参与代码回滚。临时目录损坏、权限异常或安装锁无法确认释放时，仍可能需要关闭后手动检查或重装；不以超时推断安装器已退出。

## 合并前 CI 补充

PR #12 首次 CI 的 faults 组在 `gui-browser-stop.cjs` 的 Router 装配定位处失败，本机复现相同错误；同类搜索发现 `stop-barrier.cjs` 也仍依赖旧的 `http.createServer(route)` 片段结尾，并复现失败。应用更新增加独立维护包装后，测试应在 `createAppUpdateMaintenance` 装配之前结束 Router 取样。只调整这两处测试片段边界，不复制生产 facade、不改变产品代码或删除停止行为断言。

修正后 `node tests/gui-browser-stop.cjs` **12/12**、`node tests/stop-barrier.cjs` **17/17**；合并前另复跑更新专项 **24/24**、Runtime Registry **35/35**、Session Runtime **7/7**。此次仅测试及文档修改，既有打包产物中的产品代码仍一致，不重复构建或本机完整 `npm test`。正式安装验收缺口仍保留，不能因 CI 通过而视为完成。
