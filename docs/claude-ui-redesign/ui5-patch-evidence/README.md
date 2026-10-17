# UI-5 补丁证据索引

本目录是 [UI-5 补丁验收报告](../UI-5-patch-acceptance.md) 的原始证据。
所有测试写盘均在 `os.tmpdir()`；没有对用户项目/会话做写操作。

## 修复前复现

- `repro-baseline.cjs`：从 git 对象读取基线 `8f0178e...` 的 `lib/` 与 `public/`
  文件到临时目录，复现 P1-A 的 JSONL 泄漏和 P1-B 的永久失效。
- `p1-baseline-repro.log`：实际输出。P1-A 显示同一 secret 交替放行并写入
  `app-20261017.jsonl`；P1-B 显示一次网络失败后 `failing:true`，后端恢复后
  `logRendererEvent` 仍返回 `false`，60 秒内没有新请求。

## 修复后专项

- `p1a-after-fix.log`：`logging-secret-state` **9 passed, 0 failed**。
- `p1b-after-fix.log`：`logging-client` **8 passed, 0 failed**。
- `full-npm-test-rerun.log` / `full-npm-test-rerun.exit`：最终完整 `npm test`，
  退出码 **0**，约 **3020 秒**，0 条 FAIL/not ok；汇总中 environment skip 19 条。

## 环境假红现场

- `full-npm-test.log` / `full-npm-test.exit`：第一次全量运行因遗留
  `visual-harness.cjs`（PID 26628）占用 `127.0.0.1:7799`，`tests/git.cjs` 得到
  138/161，退出码 1。日志里的 `projectRoot` 指向 `C:\pi-GUI`，不是该套件 fixture。
- `git-after-port-clean.log` / `.exit`：停止遗留进程后 `tests/git.cjs` **161/161**。
  没有修改任何产品代码或断言来“修绿”。

## 隔离构建与打包

- `build-root.txt`：临时输出根（验证后已删除）。
- `build-app.log` / `.exit`：构建退出码 0，整包 328.5 MB。
- `build-artifacts.txt`：入口 exe 246,324,736 字节 / SHA-256
  `4277314c...`；SEA exe 99,748,352 字节 / SHA-256 `be6ebcde...`。
- `logging-packaged.log` / `.exit`：打包后端 **15/15**。
- `app-check.log` / `.exit`：**26/26**。
- `exe-check.log` / `.exit`：**49/49**。
