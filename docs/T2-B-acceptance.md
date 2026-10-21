# T2-B Browser + Changes 验收

## 基线与范围

- 开发基线：`origin/main = 7db69cdc24debc28dfb7f9c91cdfcfa65b0df849`，已包含 T2-A。
- 分支：`codex/t2-b-browser-workbench`；独立 Worktree 位于
  `C:\Users\21022\.codex\worktrees\t2-b-browser-workbench\pi-GUI`。
- 基线 main CI `39573386227` 已成功；为遵守本轮先定向、最后一次 canonical 的要求，
  开发前不重复跑另一轮耗时全量，先运行 T2-A、Runtime Secondary、Browser UI 定向基线。
- 不修改主工作区源码，不推送、合并、打 tag 或发布；原未跟踪 Release 目录保留。
- 结论：功能与自动化验证通过，整窗视觉/正常沙箱运行仍为环境验收缺口；不是无条件的桌面安全资格证明。
- 本地提交按功能、测试、文档证据三个回滚边界拆分，提交记录见文末。

## 代码变更

| 文件 | 改动 |
| --- | --- |
| `public/ui/split-workbench.js` | 在原布局中加入有界 Browser 顶部 adapter，默认 Specs 保持兼容 |
| `public/browser-pane.js` | 同一 Browser chrome 在独占/分屏之间移动；注入原分屏 opener；防迟到权限响应 |
| `public/runtime-secondary.js` | scoped Browser 分屏挂载、owner 重绑定、失败/关闭空态，不复制控制器 |
| `public/right-pane.js` | 观察实际 viewport；统一隐藏/弹层/拖动遮挡；先 bounds 后 reveal；宽栏拖动 blur 清理 |
| `public/app.js` | 原入口接线与激活态同步，不增加全局导航 |
| `public/ui4-pane.css` | Browser 顶部面板的最小 flex/工具栏适配，沿用现有灰阶样式 |
| `electron/browser-view.cjs` | CSS 坐标按主窗口 zoom 转 DIP 后 clamp；有效新矩形到达前不 attach |
| `tests/browser-workbench-ui.cjs` | 新增 Browser 分屏状态、监听器与遮挡交互回归 |
| `tests/browser-viewport-safety.cjs` | 新增主进程几何与 attach/detach 安全回归 |
| `tests/browser-workbench-electron.cjs` | 新增真实 Electron/WebContentsView、临时 Git Worktree 与本地 HTTP 验证 |
| `tests/runtime-secondary.cjs` | 增加 scoped 分屏、迟到事件、重复切换和 owner 关闭断言 |
| `tests/runtime-browser.cjs` | 原 fixture 补齐真实 zoom 和 viewport，不再把零矩形当有效视图 |
| `tests/gui-browser-ui.cjs` | 增加权限撤销后的迟到状态与关闭后 follow-up 防护 |
| `package.json` | 两个新离线叶套件接入 canonical；真实 Electron 为独立 opt-in 入口 |

无新增依赖；未改 Pi、RPC、会话存储、Git 授权、Browser 导航策略、localhost 范围或 Session 策略。

## 原生视图方案

`createBrowserController()` 仍是唯一 WebContentsView 宿主。分屏仅移动已有 Browser
chrome，不新建控制器、不导航、不复制 Cookie。Browser 工具栏提供分屏/退出操作。
Specs + Changes、Browser 独占模式继续保留；窗口 <900px 或内容高度 <448px 回退页签。
比例仍只保存到 `pi-gui.workbench.split.v1`，不保存 URL、正文、Diff、凭据或选中路径。

`right-pane.js` 统一量取实际 Browser viewport，ResizeObserver + rAF 合并更新；
弹窗、隐藏页签、宽度拖动和分屏拖动合并成一个遮挡事实。解除遮挡前先送新 bounds。
主进程读取 GUI `getZoomFactor()`，只转换一次 CSS→DIP，不乘 devicePixelRatio；
NaN/Infinity/非正尺寸、没有新几何、后台 owner 或遮挡状态均不挂载原生视图。

### 关闭语义

- 独占/分屏转换与回退页签保留 native webContents、导航历史和页面输入。
- Browser 工具栏关闭会销毁页面并撤销 Agent Control。
- 经典项目切换关闭旧 Browser，避免旧页面被误当新项目页面。
- Runtime 右栏折叠/Escape 沿用原有隐藏语义：卸载 UI 监听器并 detach，保留该 owner 的
  native 页面；不宣称折叠会撤销该 owner 的授权。关闭会话由既有 resource dispose 销毁。
- Stop/工作区换代仍由原 bridge 的 epoch、凭据轮换和撤销路径负责，本轮不重写。

## 定向验证

以下是本轮实测数字；跳过断言不计入通过数。

| 命令 | 结果 |
| --- | --- |
| `node tests/browser-workbench-ui.cjs` | 14/14 |
| `node tests/browser-viewport-safety.cjs` | 36/36 |
| `npm run test:split` | 30/30 |
| `npm run test:specs` | 43/43 |
| `npm run test:agent-browser` | 153/153（21+22+25+31+24+18+12） |
| `node tests/runtime-secondary.cjs` | 24/24（原 17 + 新增 7） |
| `node tests/runtime-browser.cjs` | 48/48 |
| `node tests/runtime-changes.cjs` | 60/60 |
| `node tests/runtime-git-ui.cjs` | 6/6 |
| `node tests/runtime-store.cjs` | 25/25 |
| `node tests/runtime-resources.cjs` | 45/45 |
| `node tests/runtime-resource-cleanup.cjs` | 16/16 |
| `node tests/worktrees.cjs` / HTTP / UI | 86/86（56+14+16） |
| `node tests/git.cjs` | 161/161 |
| `node tests/electron-guard.cjs` | 123/123 |
| `node tests/modules.cjs` | 119/119 |
| `node tests/ui4-integration.cjs` | 55/55 |
| `node tests/smoke.cjs` | 1338/1338，无断言减少 |
| `npm run test:browser-workbench:electron` | 最终 64/64；独立复审另跑其前版 61/61 |
| T2-A `npm run test:split:electron` | 32/32，真实项目/Worktree 激活回归 |
| 既有 `tests/ui4-pane.cjs` Electron | 280/280，35 张截图 |
| `npm run build:app -- --rebuild --output-root C:\pi-GUI\.probe\t2b-build-verified` | 退出 0，328.6 MB |
| `npm run fixtures` + `node tests/app-check.cjs --output-root C:\pi-GUI\.probe\t2b-build-verified` | 26/26 |
| 唯一一次 `npm test` + 同清单环境中断续跑 | canonical 166/166 叶套件累计通过，最终未通过 0；非单次命令成功 |

7 个变更的前端/主进程资源与最终构建逐字节一致，见 `packaged-assets.json`。
本机真实 Electron 的复现环境（只对当前测试进程生效）：

```powershell
New-Item -ItemType Directory -Force C:\pi-GUI\.probe\t2b-electron-temp | Out-Null
$env:TEMP = 'C:\pi-GUI\.probe\t2b-electron-temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:T2B_TEST_NO_SANDBOX = '1'
$env:T2B_EVIDENCE_DIR = 'C:\pi-GUI\.probe\t2b-browser-evidence'
npm run test:browser-workbench:electron
```

唯一一次 `npm test` 运行 204.04s 后在第 56 叶套件的 esbuild 写 TEMP 阶段退出 1；
前 55 个叶套件完成。`native-provider-quota` 隔离 TEMP 后通过；继续到 `project-config`
出现同类输出拒绝，已保留首次 110/111 结果，隔离后有效重跑 111/111。剩余项均从原
canonical 清单继续展开，前 55 + 后 111 = 166 个唯一叶套件最终全部退出 0。
Native Runtime 417.723s、Service 329.473s、Writer 518.6s、Faults 655.082s 均已完成；
权限不足等既有 skipped 断言不计入通过数。不能将中断的单次命令说成成功。
`validation-results.json` 保存 166 条实际命令及最终结果，`canonical-attempts.json`
保留中断后的每次尝试，`canonical-logs/` 保留逐套件原始输出与失败/重跑证据。

## Electron 证据与隔离

最终真实夹具使用产品 ES modules、完整现有 CSS/DOM、preload、实际 WebContentsView
与 Browser/Runtime/Agent controllers。本地 HTTP 页面及 Git 仓库、真实 Worktree A/B
均为临时 fixture；Git status 使用注明 scope 的 HTTP adapter，Diff 正文来自真实 Git。
它不是完整生产后端、真 Pi 或真实模型的并发 E2E。T2-A 回归另覆盖实际项目激活。

64 条覆盖独占/分屏/Specs 切换、四个宽度、短窗口、125% zoom、真实鼠标与键盘调整、
页签和弹窗的真实 detach、前进/后退/刷新、页面输入保留、真实 Agent snapshot/fill/disable、
20 次布局切换、20 次 native 关闭重开、A/B/A native owner 与 Changes scope、不同 partition
及会话 dispose。未声称完成所有 DPI、全模型并发或无界内存增长测试。

截图与 `results.json` 位于 `docs/evidence/t2-b-browser-workbench/`：

- `01-browser-single.png`：原独占布局；
- `02-browser-changes-1536/1200/900/720.png`：实际 renderer 布局与 Changes；
- `*-native-page.png`：对应实际 WebContentsView 的本地网页截图；
- `03-narrow-changes.png`、`04-modal-occlusion.png`：页签隐藏与弹窗遮挡；
- `05-zoom-125.png`、`06-short-window.png`：缩放与低高度；
- `07-focused-A.png`、`07-focused-B.png` 及对应 native-page：隔离工作区页面。

### 必须保留的环境限制

1. 本机 Electron 连 `--version` 都因 sandbox 启动返回 `0x80000003`；仅夹具使用
   `T2B_TEST_NO_SANDBOX=1`。产品 sandbox 配置未改，但本轮**不构成真实沙箱运行证明**。
2. Electron/打包工具写用户 TEMP 或 Codex Worktree 某些目录会遭 EPERM/Access denied。
   Electron 夹具临时根与产物用独立 `C:\pi-GUI\.probe\` 子目录；完整 Native 测试不统一
   使用仓库内 TEMP，避免污染“非 Git 项目”等判据。
3. Windows WGC 整窗截图被拒，PrintWindow 返回黑图，均不作为证据交付。renderer capture
   不包含原生子视图，因此交付的是**两张分别真实捕获的界面/网页图，不是整窗合成图**。
   几何与遮挡通过真实 native bounds/attachment 验证；整窗视觉人工验收仍有缺口。
4. 既有 `agent-browser-live-main.cjs` 的 CDP pointer 断言在当前代码和原 main controller
   均失败（前 7 项后 cdp_error/timeout）。记录为既有/环境限制，不修改 Agent 协议掩盖；
   新夹具的真实 Electron native pointer、Agent CDP snapshot/fill/disable 均已通过。

## 独立复审

三轮收敛：完整审查 → 修复定向复核 → 新 Electron/Native 证据的最终窄复核。
唯一有证据 Important 是宽度拖动丢失 mouseup 时 `rp-resizing` 永留，导致 Browser 永久
occlude；新增回归先复现失败再修复，blur/重复拖动/关闭统一清理。独立验证 60 次清理，
临时 mousemove/mouseup/blur 监听器均归零。最终 Blocker 0 / Important 0。
报告与 scope hash 见同目录 `independent-review.md`、`final-review.md`。
第三轮后仅增加 native pointer、隐藏 webContents 释放与 session 销毁的三条实测断言，
无产品代码变更；最终 64/64 不冒充独立复审的 61/61。

## 回滚与后续

验收前可弃用此独立分支；接受后执行 `git revert --no-commit 034ae54 5c7880b`，
审查回滚后提交，再重建应用产物（不在本轮自动执行）。
只移除布局功能，不修改用户项目、会话、Pi 安装或 Browser 授权策略。
后续优先在允许正常 sandbox/桌面捕获的本机环境补整窗视觉与真实 Agent CDP pointer 复验，
再扩展完整后端两会话 Stop/Close E2E；不扩展到任意 dock、终端或三面板。

## 本地提交记录

- `5c7880b`：功能：增加 Browser 与 Changes 原生分屏工作台。
- `034ae54`：测试：验证 Browser 分屏几何、权限与生命周期。
- 本验收文档、架构说明、截图与日志独立作为第三个文档提交；不推送、合并或发布。

最终独立应用：
`C:\pi-GUI\.probe\t2b-build-verified\dist-app\Pi GUI-win32-x64\Pi GUI.exe`。
这是验收构建，不覆盖已安装版本，也不把功能代码合入本地主工作区 main。
