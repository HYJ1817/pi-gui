# Windows 应用内更新补齐验收

日期：2026-10-27。开发分支 `codex/windows-in-app-update-7573`，独立 worktree `C:\Users\21022\.codex\worktrees\windows-in-app-update-7573\pi-GUI`。

当前阶段：实现、定向验证、最终 canonical、打包检查和本地自审已完成。高风险功能的独立复审仍待完成；未推送、合并、打 tag 或发布。

## 身份与范围

- before HEAD：`8029c8821d63879a3648cb949396fae9ba05b139`；从 `origin/main` 创建独立 worktree，未复制 Gemini 的未提交修改。
- 基线 CI：[40468275000](https://github.com/HYJ1817/pi-gui/actions/runs/40468275000)，main push、attempt 1、精确 SHA 与上项相同，八项 job 及 CI gate 成功。只证明基线。
- 仓库版本保留 `0.30.0`；TEMP 中下一补丁版本是安装测试产物，不是 tag、Release 或显示版本伪装。
- 不新增 npm 依赖，不修改 Pi RPC 协议，不对原安装、真实项目、真实会话执行写验证。不推送、不合并、不打 tag、不发布。
- 风险：高，涉及程序安装、退出与文件替换。最终人工接受、合并及发布分别决策。

## 根因及实现

1. 本机真实 v0.29.0 注册安装目录包含中文。隐藏 `reg.exe` 的输出被按 UTF-8 解码后出现替换字符，精确 exe 匹配失败，从而误判便携版。改用固定 Registry API 与显式 UTF-8 输出；精确 realpath 和卸载器检查仍保留。只读验证见 [registered-install-readonly.json](in-app-update-20261027-evidence/registered-install-readonly.json)。
2. PowerShell 5.1 默认编码还会破坏 BOM-less UTF-8 请求里的中文安装和 userData 路径；请求和落地 package 均显式按 UTF-8 读取。
3. 真实 Electron 中直接 detached 启动 PowerShell 曾返回 0 却未执行脚本；直接附着虽然可执行，却未通过父进程退出后的存活证明。最终使用隐藏 `Start-Process` 引导，真实生存验证覆盖生产启动器。引导退出不构成安装或取消成功的证据。
4. 缓存创建异常不再使 IPC 全部消失；前端连接和缓存错误均提供重试。官方 URL、版本、资产名、大小、digest/fallback SHA256、下载取消与缓存复验仍由原有主进程负责。
5. 单一主操作按下载、校验、就绪、准备退出、恢复和安装阶段切换。手动资产下载放入展开项；运行版本优先读取主进程 `app.getVersion()`。
6. 原生确认前私有只读预检，确认后再次获取维护锁；加入候选任务收尾与全部浏览器操作/加载检查。活跃 Agent、审批、开发进程等仍拒绝退出，无强制结束或绕过按钮。空闲浏览器页面关闭风险在确认框中明确说明。
7. 准备超时取消迟到的维护操作。浏览器可失败的撤销发生在后端退出之前。退出准备失败独立释放维护状态；取消标记 IO 失败也不能跳过恢复，保持主应用存活并等待助手释放安装锁。后端已退出时重启整个旧应用，重新建立 Browser 与后端。
8. 缓存被改动、消失或官方资产失效时进入失败状态，提供重新下载，不继续宣称已验证或只允许重复重启。

## 支持形态

| 形态 | 本轮行为 |
| --- | --- |
| Windows 当前用户 NSIS 安装版，注册路径与实际 exe/uninstaller 精确匹配 | 应用内下载、进度、SHA256、原生确认、安全退出、安装、重启与运行版本确认 |
| Windows 便携版或无法证实安装身份的打包版本 | 下载并验证便携 ZIP，打开固定下载目录；退出后手动替换，不覆盖运行中 exe |
| 开发模式、其他平台 | 检查版本与手动 Release 入口，不执行安装 |
| 无法使用系统 PowerShell、程序目录不可写、缓存/磁盘故障 | 显示失败与恢复/重试入口；必要时从 Release 手动安装 |

旧 v0.29.0 二进制不能自行获得本次源码修复。受影响用户仍需手动安装包含本修复的版本一次，再使用后续应用内更新。公开 v0.30.0 也不会被本地源码修改。

## 验证证据

全部数字来自本轮实测。skip 单列，不计入通过数。

| 层次与命令 | 目前已取得的结果 | 证据 |
| --- | --- | --- |
| 更新离线专项 `npm run test:app-update` | 36/36，0 skipped（15 + 2 + 6 + 1 + 6 + 6） | canonical 日志第 145–230 行 |
| 真实 Electron UI `npm run test:app-update:electron` | 16/16，正常沙箱；桌面能力为离线夹具 | [UI 结果](in-app-update-20261027-evidence/ui-results.json)、[小窗口](in-app-update-20261027-evidence/restart-ready-small.png) |
| 生产启动器 `npm run test:app-update:helper-startup` | 2/2，真实 Electron → PowerShell → 父进程退出后完成写入；中文/空格/单引号路径 | [生存验证](in-app-update-20261027-evidence/helper-startup.json) |
| 安装器超时故障 `node tests/app-update-windows-faults.cjs` | 6/6；结果不可写时仍等安装器退出，不并发回滚 | [故障结果](in-app-update-20261027-evidence/timeout-fault-results.json) |
| 检测器 / Electron 边界 | 87/87 / 123/123 | canonical 日志；本报告末尾记录 |
| Runtime Browser / Browser host / Stop | 48/48 / 18/18 / 17/17 | canonical 日志；本报告末尾记录 |
| 精确基线本地完整 canonical | 退出码 0，先于业务改动完成 | `%TEMP%\pi-update-7573-baseline.txt`（609,499 bytes） |
| 修改后完整 canonical | 命令运行器报告退出码 0；17 个 npm 套件入口；2026-10-27 20:48:13–22:20:44；5,551.3 秒。保留日志包含完整测试正文且无硬失败，但没有追加 `canonicalExit`/耗时元数据；另有 21 个明确 skip：两组 SACL witness 各 8 项、非空 SACL 2 项、symlink 3 项（collab/candidate/logging 各 1） | 退出码与耗时来自命令运行器输出；测试正文见 `%TEMP%\pi-update-7573-final-code-canonical-20261027.txt`（611,033 bytes） |
| 源码版打包检查 `npm run test:app` | 26/26，退出码 0；内嵌后端、Pi 子进程、RPC、资源和上传缓存通过 | `%TEMP%\pi-update-7573-test-app-20261027.txt` |
| 单文件 EXE `npm run test:exe` | 49/49，退出码 0；启动、内嵌资源、配置、工具、上传和目录穿越检查通过 | `%TEMP%\pi-update-7573-test-exe-20261027.txt` |
| NSIS 安装、失败后旧版恢复、再次升级、实际版本 | 13/13 + 9/9；真实 NSIS、真实 Electron/backend/helper；损坏包重下、退出失败恢复、成功升级、部分写失败回滚 | [成功升级](in-app-update-20261027-evidence/installed-e2e.json)、[失败回滚](in-app-update-20261027-evidence/installed-failure.json) |
| 源码与当前 Electron 产物 | 19/19 源码/打包文件摘要一致；本地安装器 105,590,325 bytes，SHA256 `99a9490c507d64b08dbf772191dd1bfbd3600e0da74012045bdb8aee02c8d056`，签名状态 `NotSigned` | [文件对比](in-app-update-20261027-evidence/build-equality.json)、[产物摘要](in-app-update-20261027-evidence/artifacts.json) |

### 失败历史与资格边界

- 所有新增缺陷均保留了失败信号：中文读路径、缓存初始化、UI 多主按钮、迟到 prepare 锁、助手取消、损坏缓存重下、detached 启动不执行以及附着启动不存活。没有删除原断言；更新专项从基线 24 项增为 36 项。
- 一次早期 canonical 日志路径被策略拒绝，命令没有启动，也没有删除文件；随后使用新的日志路径完成上项唯一有效 canonical。一次 clean-baseline 与一次旧 final-canonical 被主动取消，均不计作证据。
- 首次 NSIS fixture 的 `/D` 参数被 Node 整体引用，未进入预期的中文 TEMP 路径；只创建了独立测试应用目录，未修改原 Pi GUI 注册项、快捷方式或原安装。修正为 NSIS 要求的最后一个未引用参数尾部，所有回退 AppData/Home 均限定在 TEMP。
- 上述首次目录 `C:\Users\21022\AppData\Local\Programs\Pi GUI Update Fixture` 的清理被自动审批拒绝，返回 `blocked by policy` 且未给出更具体原因。未换一种删除方式绕过，目录保留供人工清理。
- 真实原生确认框已调用，但桌面工具不能枚举该隔离窗口，等待确认超时；这一轮不算 E2E 通过。后续显式自动确认只存在于测试 entry 中，结果必须标明确认应答夹具。
- 最终安装专项使用两个分别构建的完整版本、真实 NSIS 文件替换、生产 main/preload/backend、真实 helper 和正常沙箱。测试副本采用独立 exe 名、较快压缩、移除全局注册表/快捷方式写入；安装目录 lookup 和公开 Release 传输是隔离夹具。
- 因此，即使该专项通过，也不能声称正式 v0.29.0 → 公开 v0.30.0、真实签名发布包、真实用户原位置覆盖安装、原生确认人机点击或断电恢复已经验收。正式原位置测试需要专用 Windows VM/桌面；当前机器未发现 Windows Sandbox 可执行入口。
- 签名与发行策略保持原样；本地构建不是正式发行。助手仍校验旧父进程身份、等待实际退出和 exe 排他写打开，持包只读句柄与安装锁；不强杀活跃 Agent 或超时安装器。

## 审查与待决

历史独立功能审查已复验更新专项 36/36，并验证关闭损坏缓存重试问题。历史独立安全审查发现并关闭迟到维护、候选收尾、后端退出后的浏览器恢复、取消 IO 故障等问题。作者在最终代码状态完成了完整 diff 自审，未发现新的可复现 Blocker 或 Important；上述结论不等同于独立复审。

最终隐藏引导启动与安装锁等待已分别由生产启动器专项、真实安装 E2E、部分写失败回滚和安装器超时故障验证。最终 follow-up 独立审查因账号额度限制未完成；按用户要求未启用新的子代理。因此，高风险变更的最终独立功能/安全复审仍为未完成，代码验收保持“有条件通过/待独立复审与用户明确审批”。

回滚：本分支与主仓库隔离；弃用本地候选产物，保留原安装即可。代码尚未推送或合并，回退本 worktree 的业务与测试改动不会迁移或删除用户数据。真实安装失败优先由既有 helper 程序备份恢复；磁盘或恢复本身失败时保留该次 TEMP 备份并手动重装程序，用户数据留在原处。

阶段：开发实现完成；自动验证与作者自审完成；代码验收待最终独立高风险复审和用户明确审批；推送、合并、发布均未授权且未执行。
