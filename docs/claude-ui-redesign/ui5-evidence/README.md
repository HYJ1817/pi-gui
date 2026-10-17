# UI-5 证据索引

本目录是 [UI-5 验收报告](../UI-5-acceptance.md) 的原始证据。时间：2026-10-17/18（Asia/Shanghai）。
所有测试使用 `os.tmpdir()` fixture、离线 visual-harness 或隔离构建产物；没有对用户项目/会话做写操作。

## 最终运行

- `full-npm-test.log` / `full-npm-test.exit`：最终完整 `npm test`。退出码 **0**，约 **3076 秒**，
  0 条 FAIL/not ok；环境跳过 **20** 项（SACL 8、inplace 2、Object witness 8、sessions symlink 1、
  logging symlink 1）。运行前用标准大小写 `SystemRoot` 启动，避免 Git Bash 大小写导致的 P33 假红。
- `baseline-npm-test.log`：共同基线首次全量；因本机遗留端口 7799 被 `visual-harness.cjs` 占用而退出 1，
  保留作为环境异常的原始记录，不作为产品失败。
- `final-build.log` / `final-build-root.txt`：隔离离线构建。
- `final-app-check.log`：**26/26**；`final-exe-check.log`：**49/49**。
- `logging-packaged.log`：打包后端日志测试 **15/15**。
- `object-assets-canonical.log`：用标准 `SystemRoot` 复跑 P33 Object assets **23/23**。

## 日志专项

- `logging-core.log`：**32 passed, 0 failed**。
- `logging-leaks.log`：**7 passed, 0 failed, 1 skipped**（本机不能创建 symlink，跳过不计通过）。
- `logging-ui.log`：**7 passed, 0 failed**。
- `ui5-logs-electron.log` / `electron-logs/results.json`：真实 Electron 源码前端 **23/23，10 张截图**。
- `ui5-logs-packaged-electron.log` / `electron-logs-packaged/results.json`：包内 `public` 前端 **23/23，10 张截图**。
- `runtime-soak-180s.log` / `soak/runtime-soak-180s.json`：短时 soak，26 轮、149 checks、0 失败；
  RSS 样本约 77 MB → 143 MB 后趋平，不将其解释为长期无增长证明。

## UI 回归

- `theme-electron.log`：UI-1 **489/489**，65 图。
- `ui3-integration-electron.log`：**243/243**，107 图。
- `ui4-integration-electron.log`：**427/427**，75 图；`ui4-runtime-electron.log`：**181/181**，47 图。
- `ui4-approval-electron.log`：**44/44**；`ui4-feedback-electron.log`：**9/9**；
  `runtime-electron.log`：**170/170**，43 图。
- `cdp-ui5.log`：真实 Chrome/CDP 取景断言 **1775/1775**，失败 0。

截图是 Electron `capturePage` 的网页像素，不包含原生窗口装饰；OS 级 DPI/原生标题栏/中文 IME
的既有未验证范围见验收报告第 13 节。
