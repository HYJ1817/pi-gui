# P3-C0 spike：Windows Job Object + ConPTY 生命周期

**测试专用，不是生产代码。** 这里只有 P3-C0（真机 spike）用的验证程序，
不进入 `npm test`，不修改 pi、node-pty、`server/`、`electron/` 或任何产品代码。
结论见 [docs/terminal-p3c0-spike-report.md](../../docs/terminal-p3c0-spike-report.md)。

## 内容

| 文件 | 用途 |
| --- | --- |
| `win32-spike.cpp` | Win32 侧：B+/B 组合、Job accounting、conhost、`ClosePseudoConsole`、kill 时序、WMI、Connecting 取消竞态、后端崩溃、双终端、ConPTY EOF |
| `lifecycle-spike.cc` | N-API 侧：TSFN 引用/关闭/queue-full/finalizer、`napi_add_env_cleanup_hook`、清理线程阻塞、worker env 销毁（mode 4） |
| `run-lifecycle.mjs` | Node / Electron 侧驱动，输出 `[js]` 日志并调用 addon |
| `run-worker-lifecycle.mjs` | worker_threads 环境销毁驱动：Job + tick 子进程 + barrier 清理线程 + 宿主对账 |
| `build.cmd` | 离线构建（本机 MSVC + node-gyp 头文件缓存），无网络、无新依赖 |
| `results/` | 2026-11-13 的原始证据（JSONL 与运行日志） |
| `acceptance-backend.mjs` | **C1 本机试用版**：真实后端 + 双终端 + stop/close 验收 |
| `acceptance-crash.mjs` / `acceptance-crash-driver.cjs` | 产品 node-pty Job 路径的 backend 异常退出回收 |
| `acceptance-env-teardown.mjs` / `...-worker.cjs` | worker env 拆除时的 Job 回收 |
| `acceptance-close-output.mjs` | kill / 自然退出两条路径的尾部输出与 EOF |
| `acceptance-connect-errors.mjs` | Connecting 取消、启动失败资源回收、恢复创建 |
| `acceptance-artifact.mjs` | 启动 `build/Pi GUI.exe` 产物，验证打包后的 Job 终端 |
| `start-job-trial.cmd` | 用产物入口开启 Job 模式（`PI_GUI_TERMINAL_JOB_OBJECT=1`） |
| `start-job-trial-source.cmd` | 用源码 Electron 入口开启 Job 模式 |
| `patches/` | 本轮 node-pty 补丁快照（native/lib/typings/二进制与 P3-B 备份） |

## C1 本机试用版（2026-11-13）

验收命令（在仓库根目录）：

```bash
PI_GUI_TERMINAL_JOB_OBJECT=1 node spike/terminal-job-object/acceptance-backend.mjs
node spike/terminal-job-object/acceptance-crash.mjs
node spike/terminal-job-object/acceptance-env-teardown.mjs
node spike/terminal-job-object/acceptance-close-output.mjs
node spike/terminal-job-object/acceptance-connect-errors.mjs
node spike/terminal-job-object/acceptance-artifact.mjs
```

交付、开关、日志与回滚见
[docs/terminal-p3c-local-trial.md](../../docs/terminal-p3c-local-trial.md)。
这些脚本只写本目录的 `.tmp/`；`acceptance-artifact.mjs` 会给产物注入临时
`PI_GUI_DATA`/`PI_CWD` 和假 pi shim，不碰真实项目或会话。

## 构建（离线）

需要：VS 18 BuildTools（MSVC 14.51 + Windows SDK 10.0.26100）、
Node 24 的 node-gyp 缓存 `%LOCALAPPDATA%\node-gyp\Cache\24.22.1`、
npm 自带的 node-gyp 延时加载钩子。路径不同就改 `build.cmd` 顶部的两个变量。

```bash
cmd.exe //c "C:\pi-GUI\spike\terminal-job-object\build.cmd"
```

`build.cmd` 生成 `win32-spike.exe` 与 `lifecycle-spike.node`。
addon 必须带 node-gyp 的 `win_delay_load_hook.cc` 和 `/DELAYLOAD:node.exe`，
否则只能在 `node.exe` 里加载，Electron 里会崩。

## 运行

```bash
cd spike/terminal-job-object
./win32-spike.exe --all                    # 20 项，退出码 0 表示全部测量完成
./win32-spike.exe connect-race             # Connecting 取消竞态
./win32-spike.exe backend-crash            # 实验 1：真实 ConPTY + 后端异常退出
./win32-spike.exe two-terminals            # 实验 2：双终端独立 Job
./win32-spike.exe conpty-eof-natural       # 实验 4：自然退出后的尾部输出 EOF
./win32-spike.exe conpty-eof-close         # 实验 4：运行中关闭 HPCON 后的 EOF
```

worker_threads 环境销毁（实验 3）：

```bash
node run-worker-lifecycle.mjs win32-spike.exe
ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe \
  run-worker-lifecycle.mjs win32-spike.exe
```

输出 JSON 含 `nativeState`、`watchOpen/watchResult`、`ticks` 与 `order`（native + JS
的逐行顺序日志）。`order` 的每一行由内建 addon 以单次 `FILE_APPEND_DATA` 写入，
时间戳在锁内生成；不要改用 `fs.appendFileSync` 混写，会撕裂行。

Node 24：

```bash
EXIT_AFTER_MS=150 node run-lifecycle.mjs wait
BLOCK_MS=3000 STOP_AFTER_MS=50 EXIT_AFTER_MS=200 node run-lifecycle.mjs closeBlock
STOP_AFTER_MS=50 POST_AFTER_STOP_MS=100 EXIT_AFTER_MS=800 node run-lifecycle.mjs wait
QUEUE_SIZE=2 SPAM_MS=1 POSTS=50000 EXIT_AFTER_MS=300 node run-lifecycle.mjs spam
ACQUIRE_BEFORE_ABORT=1 ABORT_AT_MS=100 EXIT_AFTER_MS=600 node run-lifecycle.mjs wait
```

Electron 44（把 `node` 换成 `ELECTRON_RUN_AS_NODE=1 <repo>/node_modules/electron/dist/electron.exe`）：

```bash
ELECTRON_RUN_AS_NODE=1 EXIT_AFTER_MS=150 \
  ../../node_modules/electron/dist/electron.exe run-lifecycle.mjs wait
```

环境变量：`BLOCK_MS`、`QUEUE_SIZE`、`SPAM_MS`、`POSTS`、`BUSY_MS`、
`EXIT_AFTER_MS`、`STOP_AFTER_MS`、`POST_AFTER_STOP_MS`、`ABORT_AT_MS`、
`ACQUIRE_BEFORE_ABORT`、`UNREF=0`、`STATE_AFTER_MS`、`LIFECYCLE_ADDON`。
worker 驱动只使用 `LIFECYCLE_ADDON`（默认 `./lifecycle-spike.node`）。

## 注意

- fixture 写到本目录的 `.tmp/`。执行沙箱拒绝在 `%TEMP%` 下 `CreateDirectoryW`（错误 5），
  不是产品问题。
- 所有子进程都是 `win32-spike.exe` 自身的 `child` / `crash-helper` /
  `backend-crash-helper` / `watch-child` / `conpty-close` 模式，
  不依赖真实 pi、不写用户数据。
- `results/` 里的数字只属于本机（Windows 11 **25H2**，build 26200.9711、x64），
  不是跨版本保证。pre-24H2 机器上的复现命令见
  [C0 报告 §7](../../docs/terminal-p3c0-spike-report.md)。
