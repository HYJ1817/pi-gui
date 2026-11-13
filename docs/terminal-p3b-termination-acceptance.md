# 终端 P3-B 验收记录：身份门控与有界终止

日期：2026-11-13  
分支：`feat/terminal-p3b-identity-kill`（已合并为 `5c8c9a4`）；
后续修复分支 `fix/terminal-identity-timeout`
基线：`62eedef`（P3-A / PR #78 合并后的 `main`）  
证据范围：提交前工作区 diff；交付提交可用
`git log -1 --format=%H -- docs/terminal-p3b-termination-acceptance.md` 解析  
风险级别：**高**（Windows 进程终止、PID 复用、应用退出清理；安全优先的失败关闭会改变“停止失败”的表现）

> 本记录只证明下列命令、构建和真实环境。完整 `npm test` 尚未在本地运行，因此不宣称
> canonical 全量已通过；P3-B 的 PR CI 已通过并合并，合并后的 push CI 暴露了一个
> 时序 flake（见第六节后半），修复分支的 CI 将作为最终 canonical，结果出来前保持
> 「待验证」。
> P3-B 消除的是**每个 sweep 都可能误杀**的放大面，不是 PID 复用本身：查询与
> `taskkill` 仍是两步，中间存在 TOCTOU；完整修复仍需 P3-C 的 Job-at-creation。

## 一、实现落点

| 文件 | 责任 |
| --- | --- |
| `lib/process-identity.cjs`（新增） | Windows 进程身份查询：`(pid, FILETIME 创建时间, 映像路径)`；异步/同步身份查询（Windows PowerShell `Get-Process`）；`found` / `gone` / `missing` / `unknown` 四态；解析与比较 |
| `server/terminal-process.js` | spawn 后立即抓取 shell 身份；`createWindowsKillGate` 在 `taskkill` 前重新查询并比对；不匹配/查不到/查询失败一律不杀；Windows 不再回退 `pty.kill()` |
| `server/terminal.js` | 会话级 `killAttempts` / `killInFlight` / `killNextAt` / `killState`；有界重试与单飞；未确认的 kill 保持公开状态 `closing`；keep-alive、workspace、idle 路径复用同一停止入口 |
| `electron/main.cjs` | 后端 spawn 后抓取身份；退出前同步复查，只有 `match` 才 `taskkill /T`，随后仍用 `server.kill()` 按句柄终止根进程 |
| `scripts/build-app.mjs` | 把 `lib/process-identity.cjs` 平铺进打包应用，供 Electron 主进程与后端共用 |

没有新增运行依赖；没有改 node-pty、pi 本体、session schema 或用户全局 npm。

## 二、语义与失败关闭

| 停止前身份判定 | 动作 | 公开状态 |
| --- | --- | --- |
| `match`：创建时间与映像路径都和 spawn 时一致 | 调用 `taskkill /pid <pid> /T /F` | `closing`，直到真实 exit |
| `gone`：该 PID 已不存在 | **不杀**；等待真实 exit；等不到时预算耗尽后 `killUnconfirmed` | 仍是 `closing` |
| `mismatch`：PID 存在但创建时间或映像不同 | **绝不调用 `taskkill`、绝不调用 `pty.kill()`**；立即停止重试 | 仍是 `closing` |
| `unknown`：查询失败/超时/PowerShell 不可用/输出不可解析 | **失败关闭，不杀** | 仍是 `closing` |
| 没有身份（spawn 时抓取失败或尚未完成且无法等待） | 不杀；不猜 | 仍是 `closing` |

- 身份只存在内存，不写日志、不写盘、不进诊断报告；`taskkill` 的 stderr 与身份查询原始输出
  都不记录。
- FILETIME 以十进制字符串保存和比较。当前日期下它约为 `1.3e17`，超过
  `Number.MAX_SAFE_INTEGER`；转成 JS number 会丢掉比较所需的精度。
- 映像路径只用于和 **spawn 时已知的 shell 路径**比较，规范化后比较、从不作为可执行
  路径使用；大小写与 `/`、`\` 差异被吸收。
- PowerShell 使用绝对路径（`SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`），
  不搜索 PATH；`SystemRoot` 不是绝对路径时回退 `C:\Windows`。
- 有界重试：每会话最多 3 次（首次立即，其后按 `killBackoffMs` 退避；默认
  0 → 1 000 → 3 000 ms），`killInFlight` 保证同一会话不并发；`mismatch` / `gone` /
  `unknown` 一次即停。预算耗尽后不再按 PID 杀，公开状态仍是 `closing`，不谎报 `exited`，
  也不释放会话额度。
- POSIX 仍用 `pty.kill()` 发信号（机制不变），但同样受会话级有界重试约束；没有在
  macOS/Linux 实机验证。
- Keep Alive 只豁免空闲计时；`stop` / `close` / workspace 确认失效 / 应用退出 /
  `dispose` 仍走同一个 `stopSession`，P3-A 的边界没有被绕过。

## 三、Electron 后端路径

- 仅在 `win32` 上，spawn 后端后异步抓取 `(pid, 创建时间, 映像路径)`；查询不阻塞启动。
  回调只与 spawn 时的局部 pid 比较，后端在查询返回前退出不会读到已置空的 `server`。
- `killServer()` 退出前用**同步**身份查询复核；只有 `match` 才执行既有的
  `taskkill /T /F`，再调用 `server.kill()` 按 `ChildProcess` 句柄终止根进程。
- `mismatch` / `gone` / `unknown` / 抓取尚未完成：跳过 `taskkill`，只按句柄终止根进程。
  代价是后端的子进程可能成为孤儿，但不会因为 PID 复用而误杀无关进程；跳过原因写入已
  声明的 `electron.backend_kill_skipped`（只记结果分类，不记 PID/命令行/路径）。
- 这仍不是 Job Object：后端崩溃、正常退出与后代 breakaway 的完整覆盖仍属于 P3-C。

## 四、实际测试结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `node tests/files-terminal.cjs` | **111/111 PASS** | 假 PTY 服务端契约；复审修复后重跑通过。新增身份解析/比较、真实查询失败分类、门控四种判决、无身份不杀、`taskkill` 失败、有界重试、单飞、未确认不谎报 exit；后续修复再加 2 条“抓取与停止复查使用独立超时预算”断言；既有 P2/P3-A 回归 |
| `node tests/terminal-source-check.cjs` | **21/21 PASS** | 真实 `node server.js` + 仓库 node-pty + ConPTY；既有 18 项全部保留，另加 3 项真实 PowerShell `Get-Process` 身份测试（见下）。修复后以 2 个实例并发跑了 3 轮，6 次均 21/21 |
| `node tests/files-terminal-ui.cjs` | **84/84 PASS** | 前端未改动；Keep Alive/多终端/面板/标签回归 |
| `node tests/modules.cjs` | **121/121 PASS** | 新增 `lib/process-identity.cjs` 不破坏依赖方向 |
| `node tests/electron-guard.cjs` | **128/128 PASS** | `killServer` 仍先树杀后 `server.kill()`；`killServer` 的身份门控结构断言在 `files-terminal` 同一轮中执行 |
| `node tests/app-check.cjs` | **27/27 PASS** | 重建后的 `dist-app` 内嵌后端在独立临时目录启动 |
| `node tests/terminal-electron-check.cjs --shots docs/terminal-p3b-evidence` | **32/32 PASS** | 真实 Electron 44.4.3；应用退出后所有 PTY 树按身份清理、无 ConPTY 崩溃栈；P3-A UI 回归 |
| `node tests/logging.cjs` | **33/33 PASS** | 新增 `electron.backend_kill_skipped` 日志事件后，日志契约与主进程适配回归；断言事件落盘且未声明的 pid 字段被丢弃 |
| `node tests/logging-packaged.cjs --output-root C:\pi-GUI` | **15/15 PASS** | 重建后的 `server.cjs` 仍可独立启动并写入结构化日志 |
| `npm run build:app -- --rebuild` | exit 0 | 应用目录 13.1 MB，整包 333.5 MB，Electron 入口 exe 234.9 MB |

### 真实 ConPTY 新增的身份测试

`tests/terminal-source-check.cjs` 在既有 18 项之外，直接用真实 PowerShell
`Get-Process` 身份查询与真实 `taskkill` 验证：

1. **match**：对一个带唯一命令行 marker 的无害 sentinel 进程抓取真实身份，门控判定
   `match` 后真实 `taskkill /T /F` 将其结束；断言 `killed`、`taskkill` 只调用一次、
   sentinel 确实退出。
2. **mismatch**：把抓取到的创建时间 +1（这正是 PID 复用后看到的样子），真实身份
   查询判定 `mismatch`；注入的 `taskkill` 计数为 0，sentinel 仍活。
3. **unknown**：查询返回 `unknown`；`taskkill` 计数为 0，sentinel 仍活。

### 打包产物核对

- `dist-app/.../resources/app/process-identity.cjs` 存在（7 631 字节）。
- `resources/app/server.cjs` 含 `classifyProcessIdentity` 与同步查询；
  `resources/app/main.cjs` 含 `queryProcessIdentitySync`、`backend_kill_skipped` 与
  平铺文件的加载候选；`log-contract.cjs` 已包含 `electron.backend_kill_skipped`。
- `build/server.cjs` 与 `build/Pi GUI.exe` 由同一次 `--rebuild` 生成；SEA exe
  104 832 000 字节。打包内 Electron 入口 exe 为 234.9 MB，整包 333.5 MB。

### 断言数量变化

- `files-terminal` 从 97 → 111：P3-B 先**新增 13 条**、**删除 1 条**（到 109）；
  合并后修复再新增 2 条（到 111）。
  - 删除的是 `ptyProcessAlive separates a live shell from a dead pid`。它只证明
    “PID 现在是否存活”，不能证明“这个 PID 是否还是原来的进程”；设计文档 10.2 明确
    要求用身份测试替换。
  - 新增 13 条覆盖身份解析、比较、异步/同步查询失败分类、门控四态、无身份、
    `taskkill` 失败、有界预算、单飞、未确认状态。
  - 后续 2 条覆盖：spawn 抓取保持独立的 2.5 s 紧预算，停止复查可用更大的独立预算；
    门控把 `captureTimeoutMs` 与停止复查的 `timeoutMs` 分别传给捕获与查询。
- `terminal-source-check` 从 18 → 21：既有 18 条全部保留，新增 3 条真实身份测试。
- 三个既有的“wedged stop 会一直被 sweep 重试”断言改为“有界重试后停止”，没有删除
  断言，检查条数不变。这是 P3-B 的预期行为变化：无限重试本身就是误杀放大面。

## 五、需求覆盖

| 设计/任务要求 | 证据 |
| --- | --- |
| spawn 后抓取 PID + 创建时间 + 映像路径 | `server/terminal-process.js` 的 capture；`terminal-source-check` 真实 `Get-Process` match 用例 |
| 停止前重新查询并比较 | `createWindowsKillGate`；假 PTY 四态用例 |
| `mismatch` 绝不调用 `taskkill` / `pty.kill()` | 假 PTY `a reused or unverifiable pid is never taskkilled`；真实 ConPTY mismatch 用例 |
| `gone` 与 `unknown` 区分，失败不当作已退出 | `identity query distinguishes gone, empty output, and a failed probe`、同步查询用例、真实 unknown 用例 |
| Windows 去掉 `pty.kill()` 回退 | `defaultKillPty refuses an unverified Windows pty but keeps POSIX pty.kill()`；结构检查 |
| 有界重试 + 单飞 | `an unconfirmed kill is retried only up to the bounded budget`、`the sweep never overlaps an in-flight kill attempt` |
| 未确认不谎报 `exited` | 预算用例断言预算耗尽后再等 60 ms 仍 `closing` 且 `killState=unconfirmed` |
| 手动停止 / 关闭 / workspace 失效 / dispose 仍生效 | 既有 P2/P3-A 用例全部重跑通过 |
| Electron 后端树杀同样门控 | `files-terminal` 的结构断言（`match` 条件、spawn 时局部 pid、win32 守卫、跳过日志）；Electron 32/32 应用退出进程树清理 |
| 不新增原生依赖 | 实现只依赖 Node 内置 `child_process` 与绝对路径 PowerShell |
| 打包可用 | `build:app -- --rebuild` + 产物核对 + `app-check` 27/27 |

## 六、失败与修复历史

- 有四个既有用例把“sweep 无限重试”当成正确行为（idle 停止、workspace 失效、
  删除会话后的退休、无 exit 的 stubborn kill）。加入有界预算后它们在固定等待窗口内
  看不到“下一轮”重试。已改为等待 `killState=unconfirmed` 并断言尝试次数上界，
  同时保留“不谎报 exit”的原断言。
- 新用例最初使用固定 `tick(160)` 等重试；为避免 CI 事件循环停顿导致假红，改为
  条件轮询 `waitUntil(...)`，并保留最终次数断言。
- 一次全量运行在 surrogate 缓冲用例的 `fetch` 上出现 undici
  `fetch failed: bad port`（尚未执行任何断言）。随后连续两次完整运行均为 109/109，
  该用例不经过本期改动路径；按环境/端口分配瞬态处理，未修改产品代码，但保留在此供复查。
- 没有跳过、取消或删除其它断言；测试未使用真实 PID 复用（不可控且会 flaky），
  mismatch 由注入的创建时间偏移构造。
- **独立复审后的修复（2026-11-13）：**
  - `electron/main.cjs` 的异步身份抓取原先在 `.then` 里读取模块级 `server`；
    后端在查询返回前退出时 `server` 已被置空，`server.pid` 会抛 `TypeError` 并成为
    未处理的 rejection。改为在 spawn 时保存局部 `spawnedPid`，迟到结果只比较该
    pid；补 `.catch`，并在后端 exit 时清空 `serverIdentity`。
  - Electron 身份门控原先没有能让“去掉 `verdict === 'match'` 守卫”变红的断言。
    `files-terminal` 的结构检查已要求 `taskkill` 位于 `match` 分支、其它判决必须
    记录 `backend_kill_skipped`，并检查抓取回调使用 `spawnedPid`、有 `.catch` 与
    Windows 守卫；同时修正验收记录中把它归给 `electron-guard` 的错误表述。
  - Electron 后端的身份抓取只应在 Windows 执行。此前在 POSIX 开发运行中，
    `C:\Windows` 会被当作相对路径拼进 PowerShell 路径；现由
    `process.platform === 'win32'` 守卫，与 `defaultSpawnPty` 一致。
  - `electron.backend_kill_skipped` 原先未在日志契约中声明，`mlog` 会静默丢弃；
    已加入 `lib/log-contract.cjs`。`taskkill` 失败与身份查询失败现在分别记录为
    `taskkill_failed` 和 `identity_query_failed`。
  - 身份查询以 0 退出但输出为空时，旧实现返回 `gone`；这违反“空输出不能证明进程
    不存在”的设计要求。现返回 `unknown`（`empty_output`），并补异步/同步断言。

### 合并后 CI 时序 flake 与修复（2026-11-13）

- **现象。** PR #79 合并后的 push CI（run
  [43354635100](https://github.com/HYJ1817/pi-gui/actions/runs/43354635100)）在
  `Electron build check` 的 `app-check` 中失败：
  `随包 node-pty 启动真实 PTY 并树杀 shell 子进程 → state=closing`，26/27。
  其它 job 全部通过，`CI gate` 仅因此失败。
- **排除回归。** 对失败 job 重跑（attempt 2），`Electron build check` 通过；
  `CI gate` 仍失败只是因为 `--failed` 没有重跑上游测试 job、证据文件缺失，属于
  重跑机制的正常表现。说明不是合并提交引入的确定性回归。
- **本地复现。** 连续运行 `terminal-source-check.cjs` 时偶发 20/21，两个实例并发
  时更易出现。临时诊断（已移除）显示失败路径是
  `capture=captured → query=found → verdict=match → taskkill ok(code 0)`，
  随后会话仍停在 `closing`；日志时间戳显示该次 stop 到真实 exit 共 **5.42 s**：
  旧 CIM 复查约 2.0 s，`taskkill` 约 2.7 s，ConPTY exit 事件约 1.0 s（改用
  `Get-Process` 后 6 并发复查约 1.0 s）。测试只轮询
  5 s，最后一次读取在 5.387 s，exit 在 5.421 s 到达——**只差约 34 ms**。
- **根因。** 不是身份门控误判，也不是 `taskkill` 失败；是停止路径在并发拆卸多个
  shell 时本来就可能超过 5 s，而两条 canonical 测试的固定等待窗口太短。旧的
  2 500 ms 查询预算同时离实测 2.0 s 太近，冷 runner 上可能把“慢”变成 `unknown`，
  那会按设计永久停在 `closing`。
- **修复。**
  1. 把身份探测预算拆开：spawn 抓取保持 `DEFAULT_CAPTURE_TIMEOUT_MS = 2500` 的紧
     预算（扩大它会加宽“shell 退出后 PID 被复用、抓取读到无关进程”的窗口），停止
     复查放宽到 `DEFAULT_QUERY_TIMEOUT_MS = 5000`（结果始终与已抓取身份比较，慢查询
     只会延迟决定），Electron 退出同步复查 `DEFAULT_SYNC_QUERY_TIMEOUT_MS = 2500`；
     任何超时仍是 `unknown`，绝不变成 `gone`。
  2. 查询原语从 `Get-CimInstance` 改为 `Get-Process -Id`：6 个并发查询下 CIM 单次
     需 3.4-4.3 s（CimCmdlets 模块加载是主要成本），`Get-Process` 约 1.0 s。这样
     既不用把抓取窗口放大到 8 s，又能在 2.5 s 内完成抓取。抓取与复查使用同一种
     原语；CIM `CreationDate` 与 Get-Process `StartTime` 精度不同，混用会造成假
     `mismatch`。只有 `NoProcessFoundForGivenId` 映射为 `gone`，其它失败仍是
     `unknown`。
  3. `app-check` 与 `terminal-source-check` 的 exit 轮询从 50 × 100 ms 延长到
     150 × 100 ms；断言仍是**真实 `exited`**，没有把 `closing` 当成成功。
- **验证。** `files-terminal` 111/111；`terminal-source-check` 修复后 2 实例并发
  3 轮共 6 次，均 21/21；重建产物后 `app-check` 27/27；`terminal-electron-check`
  32/32；`files-terminal-ui` 84/84；`modules` 121/121；`electron-guard` 128/128；
  `logging` 33/33；`logging-packaged` 15/15。完整 `npm test` 仍未本地运行，
  以修复分支 CI 为准。
- **未改变。** 仍然只有 `match` 才 `taskkill`；`gone` / `mismatch` / `unknown`
  仍不杀；没有恢复 Windows `pty.kill()` 回退；没有新增依赖、日志字段或 PID 持久化。

## 七、未验证与剩余风险

- **TOCTOU 仍在**：身份查询与 `taskkill` 是两次系统调用，中间 shell 可以退出、PID
  可以复用。P3-B 把窗口从“每次 sweep 都可能”缩到“查询与 taskkill 之间”，没有消除。
- `taskkill /T` 枚举后代仍按 PID/父子关系；某个后代 PID 在枚举时被复用仍可能误判。
  本期没有把整棵树放进 Job。
- 应用崩溃时没有 `KILL_ON_JOB_CLOSE`；这是 P3-C 的范围。
- 身份抓取依赖 Windows PowerShell + `Get-Process`。PowerShell 不可用、被策略禁用或
  查询超时都会降级为 `unknown` → **不杀**；此时 stop 可能停在 `closing`，会话继续占额度。
  这是安全优先的故意选择，需要产品层面接受“宁可留下未确认会话”。抓取预算 2.5 s、
  停止复查 5 s、Electron 同步复查 2.5 s；持续失败（而不是一次慢查询）仍会停在
  `closing`，不会自动释放额度。
- `taskkill` 返回 0 后，ConPTY 的真实 exit 事件仍可能延迟；并发拆卸多个 shell 时
  实测 stop 到 exit 约 5.4 s（旧 CIM 复查 ≈2.0 s、`taskkill` ≈2.7 s、exit ≈1.0 s；
  改用 `Get-Process` 后 6 并发复查 ≈1.0 s）。
  stop 接口先返回 `closing`，界面在真实 exit 前一直显示「停止中」。canonical 测试
  现在最多等 15 s，但断言仍是真实 `exited`；超过窗口仍判失败，不会把 `closing`
  当成功。
- 应用退出时若后端身份抓取尚未完成，跳过 `taskkill /T`，只按句柄终止后端；后端子进程
  可能成为孤儿。正常使用中抓取在启动后数百毫秒内完成，但极快退出仍可能命中。
- **服务端**仍没有新增 `terminal.kill` / `dispose_unconfirmed` 结构化日志；kill 结果
  只保留在会话内部 `killState`，`dispose()` 等待 3 秒超时后清空账本也不留日志。
  加这些事件需要扩展日志契约（新 source/event）与日志 UI 的来源筛选，P3-B 没有做。
  已声明并实际记录的是 Electron 跳过树杀的 `electron.backend_kill_skipped`
  （只带结果分类，不含 pid/命令行/映像路径）。
- `killState` 没有暴露给 renderer。无法确认的会话在界面上仍显示「停止中」，没有单独的
  「无法确认」提示；会话继续占用工作区/全局额度，直到真实 exit。显式 close 只把会话
  标记为退休，仍要等真实 exit 才从账本移除。设计中的「确认强制释放」入口没有实现。
- 本期只改了终端与 Electron 后端两条路径。`server/agents/cli.js`、`lib/git.js` 的
  `killTree`、`installer/pi-gui.nsi` 以及其它测试/工具里的 `taskkill` 仍是裸 PID
  寻址，不在 P3-B 范围。
- 只在 Windows 11 + ConPTY、Electron 44.4.3、Node 24.22.1 验证；POSIX 只跑既有假
  PTY 分支，没有实机验证。
- conhost/OpenConsole 残留（上游 #965）与后代 breakaway 仍是已知边界，未在本期测试。
- 提权进程的身份查询需要更高权限，未自动化验证。
- 完整 `npm test` 未本地运行；P3-B 的 PR CI 已通过并合并，合并后 flake 的修复以
  `fix/terminal-identity-timeout` 的 CI 为准。

## 八、独立审查

由独立上下文的只读 Agent 复审完整工作区 diff（相对 `62eedef`）。复审实际运行了
`files-terminal` 109/109、`files-terminal-ui` 84/84、`modules` 121/121、
`electron-guard` 128/128、真实 ConPTY `terminal-source-check` 21/21，以及 Node 语法、
ESM→CJS 打包互操作、null 解引用复现与结构断言变异检查；**未运行** `npm test`、
`app-check`、`terminal-electron-check` 或任何 Electron/构建启动。结论是**没有
Blocker**，2 个 Important、2 个 Nit；以下均已在最终工作区处置并重跑受影响套件。

| 编号 | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| R1 | Important | `electron/main.cjs` 的异步身份抓取在 `.then` 中读取模块级 `server`；后端在查询返回前退出时 `server` 已为 null，`server.pid` 抛 `TypeError`，且没有 `.catch`，成为未处理的 rejection | 改为 spawn 时保存局部 `spawnedPid` 并只与它比较；补 `.catch`；后端 exit 时清空 `serverIdentity`；结构检查覆盖该回调 |
| R2 | Important | Electron `killServer` 的身份门控没有能在去掉 `verdict === 'match'` 后变红的测试；验收记录还把结构断言错误归给 `electron-guard` | 结构检查改为要求 `taskkill` 位于 `match` 分支、其它判决记录 `backend_kill_skipped`；复审的变异检查（去掉守卫）现在会失败；验收记录改正归属 |
| R3 | Nit | Electron 后端身份抓取没有 `win32` 守卫；POSIX 开发运行时 `C:\Windows` 会被拼成相对路径，`execFile` 按 cwd 解析 | 加 `process.platform === 'win32'` 守卫，与 `defaultSpawnPty` 一致；POSIX 不抓取身份，仍按句柄结束后端 |
| R4 | Nit | `killServer` 的单一 `try/catch` 把 `taskkill` 失败也记成 `identity_query_failed` | 拆分查询与 `taskkill` 的失败分类，分别记录 `identity_query_failed` / `taskkill_failed` |
| R5 | 自查 | `electron.backend_kill_skipped` 未在日志契约中声明，`mlog` 会静默丢弃，与验收记录的描述不符 | 已加入 `lib/log-contract.cjs`；`logging` 33/33（含事件落盘与 pid 字段丢弃断言）、`logging-packaged` 15/15 |
| R6 | 自查 | 身份查询 0 退出但输出为空时返回 `gone`，与设计“空输出不能证明进程不存在”冲突 | 改为 `unknown`（`empty_output`），补异步/同步断言 |

复审确认：`files-terminal` 的 97 → 109 与记录一致（删 1 加 13）；后续合并后修复
又加 2 条超时预算断言，当前 111/111。删除的
`ptyProcessAlive` 正是设计 §10.2 要求替换的 liveness 断言；三个“无限 sweep 重试”
断言是有意改为有界重试，不是删除；服务端门控、`pty.kill()` 回退移除与重试预算都有
会在回归时变红的测试。修复后由本记录作者重跑了上表所有定向套件、重建产物并运行
`app-check` 27/27、`terminal-electron-check` 32/32、`logging` 33/33 与
`logging-packaged` 15/15。完整 `npm test` 仍未本地运行，见第九节。AI 的复审意见
不代替用户审批。

## 九、结论与授权

- **开发完成：是。** 身份抓取、停止前校验、失败关闭、Windows 无 `pty.kill()` 回退、
  有界重试/单飞、Electron 后端门控、打包与定向运行时验证已完成。
- **代码验收：P3-B 的 PR CI 已通过并合并；合并后时序 flake 的修复待
  `fix/terminal-identity-timeout` 的完整 CI 与用户确认。** 独立复审已完成并处置，
  修复分支的本地定向套件已通过，完整结果出来前保持「待验证」。
- **合并许可：未授权。**
- **发布许可：未授权。** 未打 tag、未推送发布 tag、未执行正式发布。

## 十、回滚

撤销本分支的提交即可。P3-B 没有数据迁移、配置格式变化或用户文件写入；回滚后
`defaultKillPty` 恢复旧的 `taskkill` + `pty.kill()` 回退语义。已经处于 `closing` 的
会话在应用退出时仍由既有生命周期清理；不需要迁移状态。

## 十一、证据文件

- [P3-B Electron 回归截图](terminal-p3b-evidence/terminal-p3-keep-alive.png)
- [P3-B Electron 多终端截图](terminal-p3b-evidence/terminal-p2-multi-tabs.png)
- [P3-B Electron 关闭后截图](terminal-p3b-evidence/terminal-p2-after-close.png)
- [Windows 进程终止设计](terminal-p3-process-termination-design.md)
- [P3-A 验收记录](terminal-p3-keep-alive-acceptance.md)
- [终端安全边界](security.md#项目终端)
- [测试分层](testing.md)
