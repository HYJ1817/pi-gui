# 终端 P3-C 本机试用版（Job Object）

- 状态：**Windows 11 25H2 本机试用验收通过。**
- 环境：Windows 11 25H2 x64（build 26200.9711）、Node 24.22.1、Electron 44.4.3（源码依赖）。
- 范围：只在本机验证 Plan B+ 与 Job 模式；旧版 Windows 与跨版本矩阵不是本轮门槛。
- 依据：[P3-C0 结论](terminal-p3c0-spike-report.md)、
  [C1 实现规格](terminal-p3c1-implementation-spec.md)、
  [Job Object 设计](terminal-p3c-job-object-design.md)。

## 1. 交付入口

两个入口都使用同一份 `node_modules/node-pty` 补丁；本轮实际验收的是**产物入口**。

| 入口 | 启动方式 | 本轮验收 |
| --- | --- | --- |
| 产物入口（推荐试用） | `spike\terminal-job-object\start-job-trial.cmd` | 等价命令已启动 `build/Pi GUI.exe`，真实创建 Job 终端并执行命令；启动器本身只负责设置同一个环境变量 |
| 源码入口（Electron 窗口） | `npm run app`，启动前设置开关 | **未验收**：本轮没有启动 Electron 窗口 |

产物入口是仓库的便携桌面产物（Node SEA，双击后打开本机页面），
不是 `dist-app` 的 Electron 窗口版。`build/Pi GUI.exe` 已按
[AGENTS.md](../AGENTS.md) 重建，`build/node_modules/node-pty/prebuilds/win32-x64/conpty.node`
与源码树里的补丁产物 **SHA-256 相同**：

```text
9fa9114cb80f0fed1cccc22d3cf2f213b2417794ba236fae036e52c70a6b9276
```

如果要在 Electron 窗口里试用，用源码入口；那需要 `npm run app`，本轮没有把它作为验收产物。

从分支复现便携版时，先准备仓库锁定的 node-pty 1.1.0 依赖，再从仓库根目录执行：

```powershell
$trialPatch = 'spike/terminal-job-object/patches'
Copy-Item "$trialPatch/node-pty/lib/*.js" 'node_modules/node-pty/lib/'
Copy-Item "$trialPatch/node-pty/src/win/conpty.cc" 'node_modules/node-pty/src/win/conpty.cc'
Copy-Item "$trialPatch/node-pty/typings/node-pty.d.ts" 'node_modules/node-pty/typings/node-pty.d.ts'
Copy-Item "$trialPatch/prebuilt/conpty.node" 'node_modules/node-pty/prebuilds/win32-x64/conpty.node'
npm run build:exe
```

## 2. 显式开关

默认关闭。关闭时完全保留 P3-B 行为（身份门控 + `taskkill /T`）。只有值恰好为 `1` 才开启。

### 产物入口

```bat
spike\terminal-job-object\start-job-trial.cmd
```

等价于在同一个命令行窗口里：

```bat
set "PI_GUI_TERMINAL_JOB_OBJECT=1"
"build\Pi GUI.exe"
```

关闭：不要设置该变量，或先清掉再启动：

```bat
set "PI_GUI_TERMINAL_JOB_OBJECT="
"build\Pi GUI.exe"
```

### 源码入口

```bat
set "PI_GUI_TERMINAL_JOB_OBJECT=1"
npm run app
```

关闭：

```bat
set "PI_GUI_TERMINAL_JOB_OBJECT="
npm run app
```

也可以双击 `spike\terminal-job-object\start-job-trial-source.cmd`（同样未做窗口级验收）。

开关打开后，如果原生模块缺失或不支持 Job（旧 prebuild、非 Windows、加载失败），
终端创建会在 **Shell 创建之前**失败：

- HTTP 返回 `503`，`code: "pty_job_unavailable"`；
- 文案：`终端 Job Object 能力不可用，未创建 Shell。`；
- 不会降级到无 Job 的 ConPTY/winpty 路径。

Job 模式下终止只走 `killJob()` → `TerminateJobObject`；
**不存在** PID 终止、身份门控、`taskkill` 或自动降级分支。

注意：如果已经有一个 Pi GUI 在运行，产物会检测到端口被占用并直接打开已有实例，
**新的环境变量不会生效**。试用前先退出正在运行的 Pi GUI。

## 3. 本机验收结果

以下命令都在 `C:\pi-GUI` 下执行。测试使用系统临时目录和
`spike/terminal-job-object/.tmp/` 中的独立 fixture。

| # | 验收项 | 命令 | 实测结果 | 原始证据 |
| --- | --- | --- | --- | --- |
| 1 | Resume 前已属于指定 Job；用户代码在 Resume 后执行 | C0 `bplus-conpty` + 本轮产物状态 | C0：`inJobBeforeResume=true`、`activeBeforeResume=1`、`markerBeforeResume=false`、`markerAfterResume=true`。本轮每次创建后 `jobAssigned=true`、`resumeReturned=true`，字段顺序 `assignedAtMs <= resumeAtMs`，随后 marker 才出现在输出里 | `results/win32-all-v2.jsonl`；`results/p3c-local-backend-*.json` |
| 2a | 两个终端各自独立 Job；停 A 后 A 的 Shell+子进程退出，B 继续输出 | `PI_GUI_TERMINAL_JOB_OBJECT=1 node spike/terminal-job-object/acceptance-backend.mjs` | A（stop）：`ActiveProcesses` 2→0，Shell 和子进程均 `wait=0`。B 在 A 停止后继续写 tick，状态仍 `running`、`ActiveProcesses=2` | [双终端复验](../spike/terminal-job-object/results/p3c-local-backend-2026-11-13T13-11-37-281Z.json) |
| 2b | 关闭 B 后 B 的 Shell+子进程退出 | 同上 | B（close）：Shell 和子进程均 `wait=0`，tick 不再增长，`ptyDisposed=true`、`activeProcesses=0`、`drainedVerified=true` | 同上 |
| 3 | fixture backend 异常退出，事先取得的句柄确认 Shell+子进程都被回收 | `node spike/terminal-job-object/acceptance-crash.mjs` | 驱动以 `process.abort()` 退出（exit 134）；崩溃前 `activeProcesses=2`；崩溃后 Shell `wait=0`、子进程 `wait=0`，tick 5→5 冻结 | [崩溃复验](../spike/terminal-job-object/results/p3c-local-crash-2026-11-13T13-11-37-232Z.json) |
| 4a | Connecting 取消 | `node spike/terminal-job-object/acceptance-connect-errors.mjs` | `killJob` 在 connect 前调用：connect 抛 `pty_aborted`；终态 `final=true`、`gone=true`、`activeProcesses=0` | [启动失败复验](../spike/terminal-job-object/results/p3c-local-connect-2026-11-13T13-11-37-244Z.json) |
| 4b | 启动失败按句柄回收 | 同上 | 无效 PE：`CreateProcessW` 失败 216；connect 抛 `Cannot create process`；终态 `final=true`、`gone=true`、`activeProcesses=0`；随后新终端可正常创建 | 同上 |
| 4c | TSFN/env 拆除 | `node spike/terminal-job-object/acceptance-env-teardown.mjs` | worker 被 `terminate()`（exit 1），Shell `wait=0`、子进程 `wait=0`，tick 4→4 冻结；宿主继续运行 | [Worker 复验](../spike/terminal-job-object/results/p3c-local-env-2026-11-13T13-11-37-234Z.json) |
| 4d | 丢失通知后的对账 | `node tests/terminal-job-object.cjs` | 8/8 通过：只有 native 终态、没有 `onExit` 时会话仍结束；丢失 EOF 也在宽限期后结束 | 终端输出；`tests/terminal-job-object.cjs` |
| 4e | 长时间运行、resize 与停止、输出 EOF | `node spike/terminal-job-object/acceptance-close-output.mjs` | 旧模块在 15.503 s 回归失败。修复后 15.505 s 仍可执行命令，resize 与停止重叠，停止和自然退出均收到 EOF，分别耗时 185 ms 和 164 ms | [输出与长时间运行复验](../spike/terminal-job-object/results/p3c-local-close-2026-11-13T13-13-55-153Z.json) |
| 4f | Resume 失败 | 临时编译故障注入模块，设置 `P3C_TEST_RESUME_ADDON` 后运行 `acceptance-connect-errors.mjs` | 注入错误 5 后返回 `job_resume_failed`，挂起进程退出，HPCON 已释放，下一次正常连接成功 | [注入结果](../spike/terminal-job-object/results/p3c-local-connect-2026-11-13T13-11-15-199Z.json) |
| — | 产物入口真实启动 | `node spike/terminal-job-object/acceptance-artifact.mjs` | `build/Pi GUI.exe`（104,839,168 bytes）启动，`jobMode=true`，15.505 s 后执行命令并获得输出，stop 后 `exited` | [Job 开启](../spike/terminal-job-object/results/p3c-local-artifact-2026-11-13T13-13-55-083Z.json) |
| — | 关闭开关及恢复旧原生模块 | 设置 `PI_GUI_TERMINAL_JOB_OBJECT=0` 跑产物验收，再对临时副本替换为备份 `.node` 复验 | 两种组合均能创建终端、执行命令并停止 | [开关关闭](../spike/terminal-job-object/results/p3c-local-artifact-2026-11-13T13-13-55-082Z.json)、[备份模块](../spike/terminal-job-object/results/p3c-local-artifact-2026-11-13T13-13-55-208Z.json) |

补充回归：

- `node tests/files-terminal.cjs`：**113 checks passed**（原有 Files/Terminal 契约，未减少）。
- `node tests/terminal-job-object.cjs`：**8 checks passed**（新增 Job 后端回归，已加入 `package.json` 的 `test` 链）。
- 上一轮 `node tests/exe-check.cjs`：`31/43`。12 项失败全部是 `%TEMP%` 下 `EPERM`
  （项目配置写入、PDF/上传目录创建），属于本机沙箱的写权限环境问题；
  其中 **`exe 内 node-pty sidecar 启动并结束真实 PTY` 通过**。
  本轮没有把 12 项环境失败当作产品通过。
- 完整 `npm test` **未运行**；本轮只跑了受影响的定向套件与上述专项目标。
- 本机 SEA 构建完成。注入工具报告签名警告，产物仅供本机试用。

## 4. 日志

- 启动时控制台会打印「数据目录」，那是唯一权威值。
- 源码/Electron 默认：`%APPDATA%\pi-gui`，日志在 `%APPDATA%\pi-gui\logs`。
- 便携产物如果被单独拷到别的目录，可能使用 exe 旁的 `data\`；以启动打印为准。
- 如果启动时设置了 `PI_GUI_DATA`，日志在 `<PI_GUI_DATA>\logs`。
- 验收日志与 JSON 在 `spike/terminal-job-object/results/`。公开分支中的证据已隐去本机用户目录和启动日志中的环境细节。
- 验收脚本的临时目录在 `spike/terminal-job-object/.tmp/`，脚本结束后会删除；
  失败时保留现场，便于查句柄/进程。

## 5. 回滚

开关本身是即时回滚：清掉 `PI_GUI_TERMINAL_JOB_OBJECT` 再启动，终端回到 P3-B。

要连原生模块一起回滚：

```bat
copy /Y "spike\terminal-job-object\patches\prebuilt\conpty.node.p3b-backup" ^
  "node_modules\node-pty\prebuilds\win32-x64\conpty.node"
```

然后重建产物：

```bat
npm run build:exe
```

说明：

- 旧的 prebuild 没有 `supportsJobObject` 导出；`lib/index.js` 会捕获加载/探测失败并返回
  `false`，因此即使 JS 补丁还在，开关打开也只会在创建 Shell 前报
  `pty_job_unavailable`，不会走 Job 路径；开关关闭仍是原 P3-B。
- 补丁 JS 在关闭开关时继续使用 node-pty 1.1.0 的原调用签名，备份模块已在临时产物副本验证。
- `node_modules/` 不在 Git 里。补丁快照在
  `spike/terminal-job-object/patches/`，包括：
  - `node-pty/src/win/conpty.cc`
  - `node-pty/lib/{windowsPtyAgent,windowsTerminal,index}.js`
  - `node-pty/typings/node-pty.d.ts`
  - `prebuilt/conpty.node`（本轮产物）
  - `prebuilt/conpty.node.p3b-backup`（回滚用）

## 6. 已知边界

- **只验证 Windows 11 25H2 build 26200。** 旧版 Windows、Electron 窗口产物、
  跨版本矩阵未验证。
- **conhost 不在终端 Job 内**（C0 一致结论）。Job 的 `drained` 只表示
  accounting 连续两次读到 0，不表示 conhost 已退出；conhost 的回收由
  `ClosePseudoConsole` 负责。
- **WMI / 服务 / UAC / AppInfo 创建的后代不保证进入 Job**，Job 模式不能承诺回收它们；
  这是设计声明的边界，不用 `TerminateJobObject` 假装覆盖。
- 本机试用版的原生补丁落在 `node_modules/`，**任何 `npm install` 都可能覆盖它**；
  重建前先用上面的 SHA-256 核对产物。
- 试用分支独立于主分支。PR、合并和发版分别审批。
