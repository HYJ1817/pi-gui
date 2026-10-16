# 打包启动上下文错误：有界对照调查

2026-10-17（本地时间）。本次只新增诊断测试及新证据，不修改产品、安全参数、原构建包、原 ABC 工作区或此前证据；不联网、不使用真实项目/Pi/模型。

## 结论与归属边界

在本机 Electron 44.4.3、相同已打包生产 main/preload 上，可以将旧错误稳定地与“初始空文档阶段首先发送 `Runtime.enable`”这一操作联系起来：该负对照 **2/2 次复现**，每次两条相同错误；不开 CDP、仅开端口、仅连接 WS、仅 Page 指令、Page 指令先行再启 Runtime、production 页面完成后再启 Runtime，六臂各 **2/2 次没有观察到错误**。

这比“内部栈所以是环境问题”提供了更具体的证据：生产主进程自身 console-message 与外部 CDP 独立观测到了同两条错误，发生于同一窗口的初始空文档，早于 production 导航提交、早于观察器调用任何 renderer JavaScript、早于关窗。原错误真实发生，没有从日志中删除或忽略。可见的触发操作是过早启用 CDP Runtime；Electron 内部为什么在该阶段重新初始化 sandbox bootstrap、`binding.startupData` 为什么已为空，尚未通过 Electron 内部源码/断点证明，不能把本次操作层归因扩大成普遍的上游缺陷机制结论。

产品无需为此关闭沙箱、修改 preload 或降低 contextIsolation。后续普通启动/主题验收宜先等待 production 主框架完成导航、页面加载和原生桥可用，再启用 Runtime；负对照须保留，不能把它改成“错误也算正常零错误”。本次调查可以解释此前烟测结果的顺序差异，但两次无 CDP 启动不能替代长时间或全平台稳定性证明。

## 隔离与观察方法

诊断入口：`tests/ui2-startup-diagnostic.cjs`。它复制此前独立构建的桌面包到操作系统临时目录，**原打包 exe、main.cjs、preload.cjs、server.cjs 的 SHA-256 在副本中一致**，见每轮 `setup.json`。仅 fixture 副本 package.json 的 main 指向新增观察器入口，入口注册只读生命周期/console 观察，再 require 未改的 production main。每个 arm 使用全新 userData、PI_GUI_DATA、agent 目录和无效 Pi fixture 路径；产品 BrowserWindow 仍保留 sandbox=true、contextIsolation=true、nodeIntegration=false。该入口包装是测试观察器，不冒称原始未包装 exe 入口的完整桌面验收。

主进程从 `web-contents-created` 起记录 console-message、导航、DOM ready、加载完成、关闭和退出。为避免真实自动更新联网，所有 arm 都在 production `did-finish-load` 后调用已存在的 `cancelUpdateAuto` / `cancelPiUpdateAuto`。随后查询无项目、Pi 未运行和 production preload 桥状态。没有覆盖、屏蔽或改写 console，没有添加/更改生产安全参数。

外部 CDP 仅连接本 arm 的本机随机端口。记录每条指令发出时间、WS 连接时间、所有收到的事件顺序、context 创建与清空、错误原时间戳。no-cdp arm 完全不打开调试端口；port-only 只开端口不连接；无 CDP 时不能获得 context id，这部分只报告主进程事件和文档 URL，不伪造 context 数据。

## 实际命令与结果

工作目录：`C:\pi-GUI-ui2-integration`。

```powershell
node --check tests/ui2-startup-diagnostic.cjs
node tests/ui2-startup-diagnostic.cjs --repeats=2
node tests/ui2-startup-diagnostic.cjs --modes=early-runtime-first --repeats=2
```

均退出 0。退出 0 表示诊断夹具按时完成、生产页面就绪、隔离条件成立且应用退出正常；**不是把负对照中的 renderer 错误判为零错误通过**。

第一条矩阵命令执行时默认包含六臂；新增严格回归后当前默认已收敛为 no-cdp、late-runtime、early-runtime-first。现在重跑上述首轮六臂应显式使用 `--modes=no-cdp,port-only,early-attach,early-page,early-runtime,late-runtime`，不能把当前默认三臂误写成旧六臂。

| Arm | 指令/连接时机 | 次数 | 无错误启动 | 观察结果 |
|---|---|---:|---:|---|
| no-cdp | 无外部 CDP、无调试端口 | 2 | 2 | 主进程 console 错误 0 |
| port-only | 只开本机调试端口，不连 WS | 2 | 2 | 主进程 console 错误 0 |
| early-attach | 初始导航中连接 WS，不发指令 | 2 | 2 | 主进程 console 错误 0 |
| early-page | 先发 Page.getFrameTree，不启 Runtime | 2 | 2 | 主进程 console 错误 0 |
| early-runtime | Page.getFrameTree 完成后 Runtime.enable | 2 | 2 | 只报告 production contexts；两路错误 0 |
| late-runtime | production 完成后 300ms，再 Page/Runtime | 2 | 2 | 只报告 production contexts；两路错误 0 |
| early-runtime-first | 首指令 Runtime.enable，再 Page | 2 | **0** | 主进程各 2 条，CDP 对应各 2 条，context 2 / origin :// |

合计 14 次启动，全部完成 production preload/无项目/无 Pi 验证并正常退出 0；12 次未观察到错误，2 次负对照明确复现错误。各臂仅 2 次，数字不能外推成零风险。

首矩阵证据：`run-2026-10-16T16-13-30-887Z/summary.json`。针对性负对照证据：`run-2026-10-16T16-14-46-414Z/summary.json`。每个 arm 目录下 `observer.json` 为主进程视角、`cdp.json` 为外部调试器与归并事实；完整记录保留在新目录，未覆盖原两轮桌面烟测。

## 关键时间线

相对本轮观察器 require production main 的毫秒数：

| 事件 | runtime-first 第 1 次 | runtime-first 第 2 次 |
|---|---:|---:|
| production 窗口开始导航 | 396 | 454 |
| 外部发送 Runtime.enable | **405** | **464** |
| 主进程记录空 URL 的两条 sandbox 错误 | **486 / 487** | **537 / 538** |
| production 主框架导航提交 | 489 | 645 |
| production did-finish-load | 617 | 761 |
| 观察器首次 renderer JS 调用 | 617 | 762 |
| 观察器关闭窗口 | 2471 | 2608 |

两次错误均为：

```text
Electron sandboxed_renderer.bundle.js script failed to run
TypeError: Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null.
```

CDP 将其定位至 context 2（Electron Isolated Context、origin `://`）；同一 frame 随后收到 `Runtime.executionContextsCleared`，再建立 production 的 default context 3 与 isolated context 4，origin 均为该 arm 的 `http://127.0.0.1:<端口>`。负对照错误发生时主进程 wc.getURL() 仍为空，因此不是 production 主题切换、关窗后的迟到事件或另建测试页错误。

Page-first 的 Runtime.enable 分别发生于 +486ms 和 +453ms，已接近 production 提交 +488ms / +454ms；此前等待 Page.getFrameTree 返回约 60–80ms，因此它与 Runtime-first 并非同一上下文时机。此前烟测“补了 Page.getFrameTree 之后干净”的现象与此吻合；**应依赖明确 production 就绪信号，而不是把 Page.getFrameTree 当成稳定的等待承诺**。

## 尚未证明与推荐停止点

- 解释到可重复操作层：早期 Runtime 首指令可触发空文档 sandbox 错误。未修改 Electron、未联网搜索或宣称其内部机制已修复。
- 无外部 CDP 两次均干净；带观察器的副本与未包装原 exe 入口并不完全相同，保留此归属限制。
- 主产品所有安全参数和源码保持不变；建议仅修正后续验收夹具的附加调试时机，保留早期负对照证据。
- 本诊断不覆盖聊天工作流、真实模型、长跑或 POSIX，不可称完整桌面验收。

## 最终可重跑回归与启动/主题闭环

在上述归因后，只增强本轮新增脚本，没有修改任何产品文件。当前默认三臂各两次：

```powershell
node --check tests/ui2-startup-diagnostic.cjs
node tests/ui2-startup-diagnostic.cjs --repeats=2
```

最终实际退出 **0**，共 **82/82 条断言**，证据为 `run-2026-10-16T16-17-37-838Z/` 和本目录 `final-verification.json`。本组与此前 Runtime 展示专项恰好同为 82 条，是两个不同测试，不应混为一组。

| 最终 arm | 次数 | 每次断言 | 全程 console 错误 | 应用退出 |
|---|---:|---:|---|---|
| no-cdp | 2 | 10/10 | 两次均 0 | 两次均 0 |
| late-runtime | 2 | 16/16 | 主进程完整启动观察和 CDP 均 0 | 两次均 0 |
| early-runtime-first 负对照 | 2 | 15/15 | **每次确实发生两条已知错误**，主进程和 CDP 互证 | 两次均 0 |

正常组均从 `web-contents-created` 的初始空文档起观察到应用退出，故延后附加 Runtime 没有丢失启动前段 console。late-runtime 在 production 完成后才连接，并实际通过 production renderer `theme.js` → native preload IPC 依次切换 Dark/Light；验证 renderer/native snapshot 同步、native `theme-preferences.json` 每次实际写入正确偏好，且保存两张真实打包窗口截图。两轮 late-runtime 合计四张截图位于各自 arm 目录，Dark 截图已肉眼检查为实际非空界面。

负对照断言严格要求：首指令为 Runtime.enable；主进程仅出现已知两条完整错误文本且来源为 sandbox_bundle、URL 为空；两条均在 Runtime 发出后、production 主框架提交及观察器首次 JS 注入前；CDP 精确归属于空文档 isolated context，并与随后 production isolated context 使用同一 frame。未命中窗口会明确输出 `negativeControlVerified=false`，相应 `UNVERIFIED` 断言失败并退出非 0；未知 console 错误、preload failure、renderer crash、观察器错误或未捕获异常同样失败，不以已知错误白名单忽略其他错误。

因此，本项收口为“明确了验收夹具早期 Runtime 首指令的触发关系，并以完整主进程观察证明正常启动/延后 Runtime/真实主题 IPC 的限定验收通过”。**不是所有启动均零错误，也不是 Electron 内部问题已修复。** 没有为消除诊断错误而调整产品沙箱或 preload。
