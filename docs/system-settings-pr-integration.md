# 系统设置 PR 集成记录

> **后续更新（2026-11-21）**：main P5-C `9eaefba56dc0cb6d8614b87e7af9aff198f3fc11` 已合入 `419dcbf093532364742a998355b15fba754f4702`，并修复独立复核发现的历史索引冷迁移集成缺口 I1。canonical 保持 308 叶；最新字节的定向验证、隔离重建及 App/SEA 检查见 §7。完整 PR CI、源码/打包正常沙箱桌面及实际渲染仍待验证，历史证明不自动继承。

## 首轮（合入 main a7cb5c70）基线与范围

- 第一父提交（feature）：`f523af1a32675291077ca112a5b527cf4c45b5dd`。
- 第二父提交（本次合入的 main）：`a7cb5c70e2f82c3ba64e8d36ad0fc444b1bab4c2`。[main push CI 44863791310](https://github.com/HYJ1817/pi-gui/actions/runs/44863791310) attempt 1，test-plan、五组测试、Electron build check 和 CI gate 均 success。该证明只覆盖这一 main SHA。
- 在独立的 `t3/integrate-system-settings` checkout 执行 `git merge --no-commit --no-ff origin/main`，不重写分支历史。定向测试与重建使用解冲突后的树 `eeaf40de977182976534fe10ccc2f06f417f564a`；提交前只追加本记录。交付合成提交可由 `git log -1 --format=%H -- docs/system-settings-pr-integration.md` 定位。
- **远端漂移**：验证后只读复核时，feature 仍在第一父提交，远端 main 已前进 5 个提交到 `9eaefba56dc0cb6d8614b87e7af9aff198f3fc11`。P5-C 又改了 `package.json`、两处 Stop 夹具及前后端装配；[该 SHA 的 main CI](https://github.com/HYJ1817/pi-gui/actions/runs/44884926405) 在查询时仍在运行。以下证据不覆盖新 main，暂不推送或创建 PR。

## 首轮冲突处置与复核

| 路径 | 保留的两侧接线 |
| --- | --- |
| `package.json`（手工） | feature 的 `test:system-settings`、桌面专项 alias 和 `test:app-update` 首项 `app-update-fetch`；main 的 P5 model 叶命令、P5 UI 链及两条 alias。未改 `pretest`、分组器、workflow、依赖、锁文件或版本。 |
| `tests/gui-browser-stop.cjs`（手工） | `createSystemStorage`、`MODELS_JSON` 和 `path`/`process`/`runningInSea` 夹具注入，与 main 的 `observeClassicSubmission() {}` 并存。仍执行生产 Router 装配片段，不替换 Stop 断言。 |
| `public/app.js`（自动） | 系统设置导航 `navSystem`、命令 `app.system`；Classic 执行观察、投影退出与 Runtime 游标/重放。页面继续加载 Token、公共原语以及双方已有 CSS；没有手工改变 UI 样式或交互。 |
| `server.js`（自动） | 系统网络许可/撤销、MCP 市场代理边界、存储路由及 storage/update IPC owner；P5 的 Classic 观察、编辑重发/普通命令接受后记账及 SSE 投影。原 HTTP 认证、写入闸和 Stop 屏障保留，未改 IPC 或数据权限契约。 |
| `tests/stop-barrier.cjs`（自动） | 存储装配形状与 `observeClassicSubmission` 替身同时保留。 |

四个共享装配文件分别与两父相对共同祖先的变更行对拍，未发现丢线或额外业务行为变动。`node --check` 检查这四文件，`git diff --check` 通过。合成包含网络/凭据和冷迁移边界，故仍按高风险交付处理；本记录为作者自验，不替代独立功能、安全审查或人工批准。

## 首轮树（`d7a4d758c830a38aa3677421ba4336c8319df8a2`）定向验证

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

相对最新第二父提交的集成开发完成；总体代码验收仍待当前 PR CI、合成状态桌面证据和针对新 P5-C 重叠边界的独立复核。用户授权的是处理冲突、提交、推进 feature 以创建 PR；不包含合并到 main、打 tag 或发布。

## 6. P5-C 漂移的增量处理（2026-11-21）

- 最新 main：`9eaefba56dc0cb6d8614b87e7af9aff198f3fc11`，包含 P5-C 恢复能力；其 [push CI 44884926405](https://github.com/HYJ1817/pi-gui/actions/runs/44884926405) attempt 1 最后核对为 completed / success，仅证明 main 精确 SHA。本轮以首轮合成提交 `d7a4d758c830a38aa3677421ba4336c8319df8a2` 为第一父，新 main 为第二父普通 merge，不重写历史。
- `package.json` 再次解决冲突，保留系统设置、更新下载适配、P5 model/UI/recovery 链。`tests/gui-browser-stop.cjs` 再次合并系统 storage 依赖和 P5 的 Classic submission / execution-history 观察替身。P5-C 前后端 execution-history 接线与 router Stop 兜底、stop test 替身保留。
- 第二次合成 commit 为 `419dcbf093532364742a998355b15fba754f4702`；下述 I1 修复前测试绑定 tree `6b4b3ca75f438a0d7da9bb4fde1d1dc734008b86`，第一/第二父分别为 `d7a4d758c830a38aa3677421ba4336c8319df8a2` / `9eaefba56dc0cb6d8614b87e7af9aff198f3fc11`。这些产物和测试不作为 §7 新修复字节的证明。
- 测试计划按 `scripts/test-group-plan.mjs` 从两个父提交 `package.json` 分别展开，再核对无重复集合、父顺序和分组保持：精确 **308 leaves / 5 groups**（父计划 304 与 295 的并集；core 232、ui 24、security 27、native 4、faults 21）。有序叶摘要 SHA256 `d868c3a9402738b88e0cb5f8fd30a2ba8b0ad8e3537d934e3b3f732a79c5a375`。未执行全部 308 叶。
- 最新树局部回归：Stop 两叶分别 **17/17、13/13**；真实 Pi 入口只返回 opt-in 提示，未启用。P5 recovery 四叶 Node TAP **9/9、8/8、1/1、2/2**；系统设置/端点/网络四个文件串行 TAP **65/65**，0 失败、0 skip。`runtime-http` **13/13**、`modules` **121/121**、`server-security` **44/44**；canonical `ci-test-plan`、`ci-workflow`、`run-test-group --validate` 均 exit 0，其中 workflow readiness 5/5、fail-closed gate 15/15。所有已运行命令 exit 0；没有减少断言。
- 最新树离线隔离重建 exit 0、**13.11 s**，Electron ZIP SHA256 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`，未下载。构建日志报告 426 项资源，Electron **334.9 MB**、SEA **101.1 MB**；包内 backend 3,542,267 B / SHA256 `3d54d10441ed2fed5462e3b9a2c63ffe7b31417b878517b2cf0b213e4ba719c2`，metadata 15,535 B / SHA256 `76caa2c2e2ccb75ac3d4d4350d94be9ce50b27c7f9e323effa22b6e01c07a5a5`，SEA 106,021,888 B / SHA256 `6284c66edba97ba17123b2f2f7fc6c75ce6a846b6480ea7fa819806257ea2d90`。已保留 `The signature seems corrupted!` 警告；不代表签名通过。产物根 `%TEMP%/pi-system-pr-p5c-Zm021U/app-output`，日志及结果 JSON 在同级 `logs/` 与 `results.json`。验证期间 `git write-tree` 始终未变。
- **本阶段未运行**：合成状态完整 `npm test`、App/SEA 运行套件、源码/包正常沙箱 Electron 与实际渲染/截图。App/SEA 后续在 §7 的修复后字节上补验；旧 293/300、首轮 304 leaves 及各 81 次桌面检查均不计本轮。独立集成复核返回 **0 Blocker / 1 Important（I1）/ 0 Nit**：P5-C 正常落盘 `execution-timeline.json` 后，P2 迁移白名单将其误判为 unknown_data。处理与新证据见下节，不能将文本冲突已解决当作产品集成已验收。

## 7. I1 历史索引迁移修复与最新定向证明

### 实现与边界

- 保留 P5-C 原生内容仍由 Pi 持有的契约；只迁移程序拥有的 `execution-timeline.json`。将原 store 的无 I/O schema 抽至 `lib/execution-timeline-schema.cjs`，server 与 Main 复用同一校验、role 和大小上限，避免另写近似格式。未改 Pi schema。
- 白名单、inventory 和业务校验共同接入；源文件在分配缓冲前限 **4 MiB**，同一 `readBound` 缓冲同时参与摘要与校验。迁移要求真实 store 的 `JSON.stringify(normalized)` 原字节，拒绝未来版本、未知或重复字段、非法 UTF-8 和非 canonical 内容；不改写源文件。
- 原独占复制、对象身份、链接/ADS/硬链接、完整集合、摘要再验、维护闸与 fixed bootstrap 不放宽。新增失败原因不包含 payload；缺校验组件 fail-closed。打包平铺同一 CJS 文件，不依赖源码目录。
- 新增真实 store 写入后冷迁移的正例，验证副本字节和摘要一致、重开可读、源内容及对象身份不变；补齐未来/未知/重复/超限索引、冷启动失败持久化及包内缺 schema 的负例。没有删既有断言或新增 canonical 叶命令。

### 失败历史与修正

- 首次存储 final：**74 pass / 4 fail / 0 skip（78 tests）**。抽取漏带 `MAX_SCOPES`、超限预期错误（产品正确返回 `inventory_limit`），已分别补共享常量和修正断言。
- 第二次：**77 pass / 1 fail / 0 skip**；缺资源探针仍命中 Node 模块缓存，删除夹具 schema 前同步清缓存。随后实际 **78/78**。
- 作者检查抽取的原生 matcher 时另修复遗留 `ROLES` 引用，改用共享 role 判定。以下最终 P5 recovery 四叶及整组存储证明均包含该修正，不用前面 78/78 代替。

### 最终运行身份与结果

验证环境仍为 Windows 11、已有离线依赖、fresh TEMP/profile，不启动真实 Pi、不调用模型、不下载。结果根 `%TEMP%/pi-system-pr-final-mcENEc`，含 `results.json`、`logs/`、`app-output/`。验证脚本以目标 checkout 为 cwd，记录 tracked 文件和新增 schema 的逐文件 SHA256；有序工作树清单摘要 **`0cda87afe1a3dba41febc7d28cd9c7e766977e5b07f4d2c060ab4926de5edf2c`**，运行前后相同。该清单包含当时文档；后续仅更新提交记录与 PR 材料，产品及测试字节保持。

| 实际命令 / 层 | 实测结果 |
| --- | --- |
| `test:session-ux-p5-recovery` 四个原始 node 入口 | **9/9、8/8、1/1、2/2**，合计 **20 pass / 0 fail / 0 skip** |
| `node --test --test-concurrency=1 tests/system-storage-final.cjs tests/system-storage-p2.cjs tests/system-storage-p2-crash.cjs tests/system-storage-desktop-p2.cjs` | **136 pass / 0 fail / 0 skip**，87.96 s；包含真实 Windows ADS 拒绝、硬退出恢复及 I1 |
| `runtime-http` / `modules` / `server-security` | **13/13、121/121、44/44**，exit 0 |
| `ci-test-plan` / `ci-workflow` / `run-test-group --validate` | exit 0；**308 leaves / 5 groups**，两父计划精确并集、顺序与分组不变；readiness **5/5**、fail-closed gate **15/15**。计划验证不是执行全部 308 叶 |
| 五个修改模块 `node --check` | 5 个命令 exit 0 |
| `node scripts/build-app.mjs --rebuild --output-root <fresh TEMP>` | exit 0，**14.04 s**，426 assets，Electron **334.9 MB**、SEA **101.1 MB**；复用前述同摘要 Electron ZIP，未下载 |
| `fixtures` 后 `app-check --output-root` / `exe-check --output-root` | **27/27、50/50**，exit 0，20.12 / 14.38 s；仅 TEMP 内假 Pi 和本地测试服务，不是桌面 GUI、安装或真实 Pi 证明 |

最新产物：

- backend：**3,544,165 B**，SHA256 `64e11532ad5660b2fcf4e720155281d53b0ff966d479e18549d065a68f522afb`。
- execution schema：**4,397 B**，SHA256 `8de434ddc4631079ecd1f09688ab7c221b6b84729eed8549e3ece30d0d63daae`；与源文件逐字节一致。包内 policy、inventory 同样与源码逐字节一致。
- metadata schema：**15,535 B**，SHA256 `76caa2c2e2ccb75ac3d4d4350d94be9ce50b27c7f9e323effa22b6e01c07a5a5`。
- SEA：**106,023,936 B**，SHA256 `f6e9cb20520659959ac7f8aadec815e6ec9b30929b35bd87a58e4c10bdac13a9`。保留 `The signature seems corrupted!` 警告，不作签名通过结论。

### 审查、剩余证明与回滚

I1 限定独立功能/安全增量复审正在进行；作者测试通过不自动关闭独立审查。完整当前 PR CI、源码/包正常沙箱桌面及新增错误文案的实际渲染仍待验证；本轮不重跑全量本地 `npm test`，遵守用户的尽快交付/停跑要求。原 checkout 的未跟踪文档、日志、编译产物及旧 build/dist-app 均未覆盖。

I1 业务代码与回归测试单独提交，记录另提交；可独立逆序 revert 并重建。仅撤回 I1 会恢复「存在合法历史索引时拒绝迁移」的安全拒绝，不应删索引来绕过检查。已在新 managed 根产生数据时仍先停写者、保全 bootstrap 与新旧根，禁止直接回指旧根。用户只授权推进 feature 和创建 PR；没有合并 main 或发版授权。
