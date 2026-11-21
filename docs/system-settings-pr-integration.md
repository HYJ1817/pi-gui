# 系统设置 PR 集成记录

## 基线与范围

- 第一父提交（feature）：`f523af1a32675291077ca112a5b527cf4c45b5dd`。
- 第二父提交（本次合入的 main）：`a7cb5c70e2f82c3ba64e8d36ad0fc444b1bab4c2`。[main push CI 44863791310](https://github.com/HYJ1817/pi-gui/actions/runs/44863791310) attempt 1，test-plan、五组测试、Electron build check 和 CI gate 均 success。该证明只覆盖这一 main SHA。
- 在独立的 `t3/integrate-system-settings` checkout 执行 `git merge --no-commit --no-ff origin/main`，不重写分支历史。定向测试与重建使用解冲突后的树 `eeaf40de977182976534fe10ccc2f06f417f564a`；提交前只追加本记录。交付合成提交可由 `git log -1 --format=%H -- docs/system-settings-pr-integration.md` 定位。
- **远端漂移**：验证后只读复核时，feature 仍在第一父提交，远端 main 已前进 5 个提交到 `9eaefba56dc0cb6d8614b87e7af9aff198f3fc11`。P5-C 又改了 `package.json`、两处 Stop 夹具及前后端装配；[该 SHA 的 main CI](https://github.com/HYJ1817/pi-gui/actions/runs/44884926405) 在查询时仍在运行。以下证据不覆盖新 main，暂不推送或创建 PR。

## 冲突处置与复核

| 路径 | 保留的两侧接线 |
| --- | --- |
| `package.json`（手工） | feature 的 `test:system-settings`、桌面专项 alias 和 `test:app-update` 首项 `app-update-fetch`；main 的 P5 model 叶命令、P5 UI 链及两条 alias。未改 `pretest`、分组器、workflow、依赖、锁文件或版本。 |
| `tests/gui-browser-stop.cjs`（手工） | `createSystemStorage`、`MODELS_JSON` 和 `path`/`process`/`runningInSea` 夹具注入，与 main 的 `observeClassicSubmission() {}` 并存。仍执行生产 Router 装配片段，不替换 Stop 断言。 |
| `public/app.js`（自动） | 系统设置导航 `navSystem`、命令 `app.system`；Classic 执行观察、投影退出与 Runtime 游标/重放。页面继续加载 Token、公共原语以及双方已有 CSS；没有手工改变 UI 样式或交互。 |
| `server.js`（自动） | 系统网络许可/撤销、MCP 市场代理边界、存储路由及 storage/update IPC owner；P5 的 Classic 观察、编辑重发/普通命令接受后记账及 SSE 投影。原 HTTP 认证、写入闸和 Stop 屏障保留，未改 IPC 或数据权限契约。 |
| `tests/stop-barrier.cjs`（自动） | 存储装配形状与 `observeClassicSubmission` 替身同时保留。 |

四个共享装配文件分别与两父相对共同祖先的变更行对拍，未发现丢线或额外业务行为变动。`node --check` 检查这四文件，`git diff --check` 通过。合成包含网络/凭据和冷迁移边界，故仍按高风险交付处理；本记录为作者自验，不替代独立功能、安全审查或人工批准。

## 本次定向验证

Windows 11 10.0.26200、Node `24.22.1`、npm `11.19.1`。只读复用与锁文件版本相符的已有依赖并复制到独立 checkout；测试用 fresh TEMP/profile、替身或本地回环服务，不安装或下载依赖，不启动真实 Pi，不调用模型，不写真实项目/配置。npm 命令均加 `--offline --logs-max=0 --no-update-notifier`。本机日志根：`%TEMP%/pi-system-settings-integration-VjzXxR/logs`。

| 命令 | 实测结果 |
| --- | --- |
| `npm run test:stop` | 3 个入口 exit 0（3.25 s）；`stop-barrier` **17/17**，`gui-browser-stop` **13/13**，另 1 个真实 Pi 入口未启用（opt-in skip，不计入通过）。 |
| `npm run test:session-ux-p5-model` | exit 0（1.18 s）；**25 adapter groups / 61 model assertions / 7 backend groups**，按套件原始口径，无失败或跳过。 |
| `npm run test:session-ux-p5-ui` | 3 个入口 exit 0（8.57 s）；view **6/6**，Classic UI **17/17**，Runtime **1/1**；0 fail / 0 skip。jsdom，不是视觉证明。 |
| `npm run test:system-settings` | 12 个叶命令 exit 0（113.30 s）；**299 pass / 0 fail / 1 skip**（21+20+16+13+16+11+16+8+18+31+122+7 通过）。仅缓存的文件 symlink 用例因 Windows `EPERM` 跳过；真实 ADS、故障恢复和冷迁移检查照跑。 |
| `node tests/modules.cjs`；`npm run test:security` | 模块 **121/121**，后端认证/监听边界 **41/41**；均 exit 0，未报告失败或跳过。 |
| `node tests/app-update-fetch.cjs` | **8 pass / 0 fail / 0 skip**，exit 0；注入 transport，不访问 GitHub 下载。 |
| `node scripts/run-test-group.mjs --validate`；`node tests/ci-test-plan.cjs`；`node tests/ci-workflow.cjs` | 均 exit 0；**304 leaves / 5 groups**（core 228 / ui 24 / security 27 / native 4 / faults 21），覆盖精确。用 `scripts/test-group-plan.mjs` 从 `package.json` 递归展开并验证为两父计划（feature 300、main 291）的无重复并集，两父叶命令相对顺序和分组均不变。计划的有序 leaves JSON SHA256：`7fa22de981c5f6cf684049e494dc06838d2606f0a73226a44c6fb34ac8917d7f`。Workflow 的 build-readiness **5/5**、fail-closed gate 矩阵 **15/15**。 |

本次没有回归测试失败；上述计划验证不算实际执行了 304 个 canonical 叶命令。减少的断言：无；条件跳过单列。

## 隔离重建与待验证项

- `npm run build:app -- --rebuild --output-root <fresh TEMP>` exit 0，**17.45 s**。显式复用现有 Electron `44.4.3` 离线 ZIP，核对 SHA256 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`，未下载。构建报告 **424 个资源 / 334.7 MB Electron / 101.0 MB SEA**；日志 `build-app.log`。没有覆盖父 checkout、旧 `build` 或 `dist-app`。
- 产物根 `%TEMP%/pi-system-settings-integration-VjzXxR/app-output`。Electron 在 `dist-app/Pi GUI-win32-x64`，其 `resources/app/server.cjs` **3,425,738 B**，SHA256 `04a98c380eb155daf52d489a264d730bfe5dc0d1e03e953f82bfd654344b9757`；生成 metadata schema **15,535 B**，SHA256 `76caa2c2e2ccb75ac3d4d4350d94be9ce50b27c7f9e323effa22b6e01c07a5a5`；`build/Pi GUI.exe` **105,870,848 B**，SHA256 `910eab908232655eb99e673214cba68a85cdfad786ce9df4ebfece2ee16cc63c`。实际对拍了包内 `app.js`、设置和执行时间线及公共样式等 9 份前端资源，与源码摘要相同。SEA 有 `The signature seems corrupted!` 警告；构建不作签名、安装或升级证明。
- **未运行**：合成状态本地完整 `npm test`（遵守停跑要求）、完整 `test:app` / `test:exe` 运行套件、源码/包两路 Electron 视觉与正常沙箱、安装升级、真实 Pi/供应商调用。解冲突没有新增 UI 设计；实际渲染与本次桌面专项仍待验证，不继承 feature 的历史源码/打包各 81 检查及截图。
- [旧 feature canonical 记录](system-settings-p2-final-fix.md#66-本地完整-canonical) 仅为历史：累计 **293/300** 个唯一命令 exit 0，在第 **294** 个 `node tests/session-revert-object-faults.cjs` 中断，后 **6** 个未运行。合成状态完整 canonical **待当前 PR CI**（精确源码/合成身份、完整五组、打包及 CI gate），不是旧结果续算；当前尚无本分支 PR CI。

## 回滚与授权

集成回滚只涉及本次 merge 和记录，不重写已共享历史，不修改父 checkout。未推送时保留集成分支取证，可另从第一父提交继续；若随后共享且获回退授权，在 feature 上用 `git revert -m 1 <该合成提交>` 撤销该次集成，并为回退树独立重建。若实际数据已迁到 managed 根，先停止写者并保全 bootstrap、新旧根；新根有写入时不得直接回指旧根或运行只认旧根的旧包。测试夹具和独立构建与真实配置分离，不是数据迁移回滚工具。

相对第二父提交的集成开发完成；总体代码验收仍待当前 PR CI、合成状态桌面证据和独立复核。用户授权的是处理冲突、提交、推进 feature 以创建 PR；当前因 main 漂移暂停推送，不能视为允许合并到 main、打 tag 或发布。
