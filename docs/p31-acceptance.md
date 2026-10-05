# P31 验收报告

基线（before HEAD）：`bc051b0553a7bb7f39833a1b0747dd9075fe6370`，P30 验收后合并的 main。分支：`codex/p31-managed-dev-process`。after implementation/test HEAD：`f4b0a21e168918aa475592451bf624e1e1193769`；含本报告的最终提交 HEAD 随交付消息列出。业务提交 `71960ff`，测试提交 `f4b0a21`。没有新增依赖、改版本、推送、合并或发 Release。

## 勘察与关键实现

先完成只读勘察，再实施；[设计记录](p31-managed-process.md) 保留现有 Extension、RPC、runtime、Browser、平台终止原语、右栏和产物结构的勘察表。继续采用 Pi 官方 `--extension` / `registerTool`，没有修改 Pi 本体或 RPC 协议。采用独立 Process bridge 和 guardian，因为既有记忆 PID 的 killTree 不能满足本功能的所有权要求。

关键文件：`server/managed-processes.js`（状态/ownership/ready/日志）、`server/process-runner.js`（启动协议）、`server/process-bridge.js`（私有工具桥与 Renderer API）、`server/process-activity.js`（安全 SSE 投影）、`extensions/pi-gui-process/`（官方工具和平台 guardian）、`public/process-panel.js` / `public/process.css` / `public/process-activity.js`（右栏与 Timeline）。接入点为 `server/runtime.js`、`server/rpc-bridge.js`、`server.js`、`public/app.js`、`public/state.js` 和现有 right-pane；SEA 资源清单在 `scripts/build-exe.mjs`。

## 工具与所有权

| 工具 | 行为 |
| --- | --- |
| `gui_process_start` | 结构化 command、args[]、cwd、env、ready；返回 ID、revision 和 initial state；同一活跃 spec 去重 |
| `gui_process_status` | 列表或单进程；可 `waitReady` 等待明确 ready 证据 |
| `gui_process_logs` | 有界、已脱敏的日志；cursor、limit、truncated |
| `gui_process_stop` | 验证身份后停止整树；重复 stop 幂等，未确认清理允许重试 |
| `gui_process_restart` | 仅复用原受控 spec，revision 增加，替换私有 spawn identity |

官方 Extension session_start 检查现有工具名称，冲突则整组不注册并提示。Process 权限默认关闭，与 Browser 完全独立；入口是“更多→开发进程”和命令面板，不增加一级侧栏入口。Renderer 可开关权限、查看、停止、重启，不能任意 start。

每个进程绑定后端权威 workspace realpath、单调 workspace generation、bridgeRun、session generation、随机公开 generation、随机 internal ID、revision 和私有 spawn identity。操作同时匹配 generation/ID/revision，再使用实际持有的 guardian 句柄与控制管道。公开摘要不暴露 PID；PID 不能证明 ownership，也不作为终止凭据。A→B→A 仍产生不同身份。

cwd 经 realpath 校验限制在当前 workspace，外部 symlink/junction 拒绝；不拼接 shell string。Windows npm.cmd 解析成 node.exe + npm-cli.js + args，其他批处理和 shell launcher 拒绝。仅继承启动所需环境白名单；显式 env 仅接受 9 个开发键，每次最多 8 个，每值最多 1024 字符，不复制 GUI/Auth/Browser/Process 凭据。Renderer/模型结果没有完整 env。

## 状态、ready 与日志

`start → starting → running`（无 ready 策略）或 `ready`（明确证据）；stop 为 `stopping → exited`；启动失败、非零退出、ready timeout 为 failed，必要时先清理。整树终止无法确认则 `failed / stop_unconfirmed`，不谎报 exited。主进程自然退出也清理后代。

Ready 支持 TCP、HTTP loopback 和完整行中的字面量日志 marker；全部有 timeout。网络策略只接受字面量 `127.0.0.1` / `::1`，HTTP 不跟随重定向、不接受凭据/query/hash；端口预检查拒绝已占用端口和 GUI/私有 bridge 端口。默认 100ms 重试探测，成功依赖实际证据。start 初始状态后，`status(waitReady)` 完成等待。首版不执行任意正则表达式。

每个进程 ring 最多 256 行 / 64 KiB；最多 8 个活跃/未确认进程，最多 64 个保留终态。UTF-8 增量解码，ANSI 控制序列移除；单行超过 8192 字节整行省略。Authorization、Cookie、常见 secret 键赋值整行脱敏，常见 token/JWT、URL 凭据和 query 脱敏；先脱敏，再进入内存 ring。不持久化原日志/spec。Timeline 和 SSE 仅固定标签/状态，绝不将原 env、参数、日志直接投射到 DOM。

## Stop、stale 和退出

| 事件 | 策略 |
| --- | --- |
| Chat Stop | 先取消在途 Process 动作并清理 starting/restarting，再按原 RPC clear_queue/abort 流程；pending barrier 拒绝新动作；已 ready/running 服务保留至显式 stop |
| 工作区 / 会话切换 | 增加 generation，清理旧进程，关闭 Process 权限；前端立即清空旧行；晚响应不能操作新 workspace |
| Pi 重启 / 维护 | 撤销私有令牌、取消旧请求、清理进程，重新授权后再使用 |
| 单请求取消 / 连接断开 | 只取消该 request 的 controller；旧会话取消请求不能影响新会话启动 |
| 应用正常退出 | 等待 manager/bridge 清理；backend 退出会关闭 guardian 管道 |
| backend 突然退出 | guardian 收到 EOF 清理树；Windows guardian 自身退出还由 Job KILL_ON_JOB_CLOSE 兜底 |

清理未确认时保留 cleanupPending，不允许开启新代权限。私有 bridge 有随机令牌、loopback 端口、Origin 拒绝、16 KiB 请求体、并发限额、request UUID 去重和 body 读取后的再次校验；多字节恶意凭据失败关闭。独立审查提出的凭据比较、旧日志晚响应、Stop 重试和旧会话 cancel 问题均已修复，并有行为回归。

## 平台与真实流程

Windows 使用内置 PowerShell/.NET：CreateProcess suspended → Assign Job → Resume。仅继承日志/NUL 句柄，子进程不继承控制管道。stop 用持有的 Job 句柄终止整树并检查 active count，没有 PID fallback。实际验证了后代树清理、主进程退出清理与 backend 突然退出清理。

POSIX guardian 是存活的 session/group leader，子进程不 detached，EOF 后由 leader 终止自身进程组。本机没有 POSIX 内核/WSL，因此只跑注入协议测试；没有声称通过 POSIX 真机验收。主动 setsid/daemonize 的后代不在首版支持范围。

Vite 8.0.16 取自已有安装，只读使用 CLI；项目全部为 os.tmpdir fixture，无下载。实际 `npm run dev → starting → HTTP ready → 修改源文件 → Vite 提供新源 → 同 spec restart/revision 2 → stop → 端口释放`。Electron 再通过真实 Extension HTTP 桥、P29 Browser 完成 open/snapshot/console/network/screenshot，直接观察 Browser DOM 热更新，restart 后再验证。远程 URL 被拒绝。

Python 3.13.14 使用标准库 `http.server`，作为用户允许的 Flask/simple HTTP 替代：TCP ready、HTTP 内容、Browser open/snapshot/screenshot、stop 和端口释放均实际执行。Browser 关闭会撤销自身权限，重新打开 Python 页面前显式重新开启 Browser 权限；Process 权限不代替该授权。

## 检查结果与证据

最终完整离线测试 exit 0。专项与真机证据：

| 检查 | 实际结果 | 本机日志 |
| --- | --- | --- |
| `npm test` | exit 0，66 个脚本全部完成 | `.probe/p31/test-delivery.log` |
| P31 离线专项 | 103/103：manager 28、tools 25、Stop 10、UI 16、runner 24 | `.probe/p31/process-final.log` |
| Windows dev process live | 29/29 | `.probe/p31/live-acceptance.log` |
| Electron Process + P29 Browser | 42/42 | `.probe/p31/live-acceptance.log` |
| P30 Electron 回归 | 161/161，37 张截图 | `.probe/p31/p30-electron.log` |
| P29 Browser live / UI live | 23/23、14/14 | `.probe/p31/browser-last.log`、`browser-ui-live.log` |
| visual harness | 276 张，取景判据通过、页面异常无 | `.probe/p31/visual.log` |
| smoke | 1338/1338，既有断言没有删除 | `.probe/p31/smoke.log` |
| usage-quota 修复回归 | 229/229 | `.probe/p31/quota-final.log` |
| 原 Stop barrier | 16/16 | `.probe/p31/stop-existing-final.log` |
| Electron 产物启动检查 | 26/26 | `.probe/p31/app-final.log` |
| 单文件 EXE 产物检查 | 48/48 | `.probe/p31/exe-complete.log` |
| `npm run build:app -- --rebuild` | exit 0，同时重建 SEA；离线已有 Electron 缓存 | `.probe/p31/build-complete.log` |

产物：SEA `build/Pi GUI.exe` 98,880,000 字节，SHA-256 `918ae774a0b76c9e42eea754d2bc248f2d603ade1d7f8a1d89ab61b0febd4f98`；Electron `dist-app/Pi GUI-win32-x64/Pi GUI.exe` 246,324,736 字节，SHA-256 `95ef4685ebc2f90628436bc8a0f3d707fd00f259054de7be564854112747346f`。七个 Process UI/工作区/Extension/guardian 资源逐一与源码 SHA-256 一致。未制作安装器、未发 Release。

新五个离线套件纳入唯一 `npm test`，从基线 61 个脚本增至 66 个。原 smoke 修改更多菜单数量预期（4→5）与局部 helper 名称；没有删除断言。Stop 专项添加实际计数断言，避免硬编码报告数量。

键盘真机：Tab / Shift+Tab、Escape 关闭并恢复“更多”焦点、Ctrl+K 命令面板；保留焦点 DOM，轮询不会替换当前按钮。三种 CSS viewport 1280×800、1440×900、1920×1080 和 125% zoom 均无 overflow，真实 starting/ready/exited/failed 状态可见，无 Renderer console error。截图物理像素受本机 DPR 影响，不能将 PNG 像素误当 CSS viewport。

| 关键截图 | 本机路径 |
| --- | --- |
| 默认关闭 | `.shots/p31/01-disabled.png` |
| 已开启空列表 | `.shots/p31/02-enabled-empty.png` |
| 实际 starting | `.shots/p31/03-starting.png` |
| ready / bounded logs | `.shots/p31/04-ready-logs.png` |
| Vite Browser | `.shots/p31/05-vite-browser.png` |
| 1280×800 | `.shots/p31/06-ready-1280x800.png` |
| 1440×900 | `.shots/p31/06-ready-1440x900.png` |
| 1920×1080 | `.shots/p31/06-ready-1920x1080.png` |
| exited | `.shots/p31/07-exited.png` |
| failed | `.shots/p31/08-failed.png` |
| 125% zoom | `.shots/p31/09-zoom125.png` |
| Python Browser | `.shots/p31/10-python-browser.png` |

## 已知限制与失败记录

- POSIX 真机未运行；主动 daemonize 不受保证。Windows PowerShell/native API 不可用则安全失败，不降级为猜 PID 的终止。
- 没有 Docker/SSH/云环境/系统服务/并行 Worktree/持久恢复；开发命令本身拥有当前用户权限，不提供沙箱。
- 工具注册采用官方 API 及本机只读源码核对，测试用 fixture 和真实 Extension 执行，不调用真实 Pi/模型/账号；没有真实模型自主调用结果。
- ready 的端口预检查与启动之间仍有外部竞争窗口；不承诺 OS 级端口归属认证。日志脱敏覆盖指定常见模式，不能识别所有应用自定义秘密格式。
- 初次 full test 遇到原有 session-search 缓存耗时波动；随后该套件通过。另一次 full test 揭示 workspace event 的 DOM realm 构造器错误，已改用 window.CustomEvent，229/229 quota 与 103/103 Process 回归通过。
- P29 standalone live 早先出现 Chromium target/click 瞬态失败，未改 Browser 产品代码；最后顺序运行 23/23、14/14，P31 实际 Browser 流程 42/42。不据一次成功断言不存在平台瞬态问题。
- 单文件 EXE 首次新临时目录缺少 PDF fixture；生成 fixture 后检查通过。SEA guardian 代码提取到随机私有临时目录，退出后代码目录可能残留，内容不含 spec/env/日志。
- 原 Stop barrier 测试提取生产 Router 装配到 VM，新依赖需要同步注入 fixture；补入 managedProcesses:null 后原 16/16 用例通过，没有改弱停止语义断言。
- 本机截图与日志在 gitignore 目录，交付机器可直接查看；没有发布上传，也没有把真实项目数据写入测试。

完成后停在独立分支，等待 ChatGPT 验收 P31。
