# UI 细节收尾验收记录（2026-10-20）

基线：最新核对的 `origin/main` 为 `3c7a8ac`，版本 v0.26.2。
本地分支：`codex/ui-visual-finish`。原分支落后 main 13 个提交；未改动原分支历史。
原有 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/` 未跟踪目录保留。
本轮未使用子代理，未新增依赖，未修改模型 API、Agent 执行或消息持久化。

## 五项结果

| 要求 | 实现与证据 | 结果 |
| --- | --- | --- |
| 通知降噪 | 普通 info/success/ok 默认不弹；有明确操作入口或显式 important 的通知可保留。30 秒去重，可见的同一错误跨时间仍不堆叠。扩展普通提示只进入状态页，未分类 error 继续弹；已报告的 Memory/qmd 依赖问题进入 Memory 说明及扩展提示区。重复 20 次没有弹窗，状态记录有重复计数。 | 通过 |
| 移除箭头 | 删除上下文 summary 伪元素和 Provider 箭头 DOM；保留 summary/button 原生交互、aria-controls/expanded、整行鼠标命中、方向键和 Space。其余菜单的真实层级和展开入口保留。 | 通过 |
| 选择器平整化 | 当前模型及 Thinking 无彩色竖条、无厚重选中背景，保留中性对勾；hover 轻微，键盘焦点为中性色细框。切换回调与持久化路径未改。 | 通过 |
| 消息导航 | 每个透明按钮 24×12px，间隔 14px，可见线为 9×2px；当前项加长。导航最高 280px，长会话在内部滚动，不压缩或重叠。增加 ↑↓/Home/End；保留全部消息 DOM 锚点和原有内容偏移/scrollTo。真实 500 条验证命中区边缘点击、准确跳转、最后一项、顶栏不移动和预览提示位置。 | 通过 |
| 请求错误 | 去除内外背景、边框及重复装饰图标；标题、建议与具体详情仍为文本。实时错误有一个 alert/atomic，历史恢复不重复播报。retry/fallback 路径未改。 | 通过 |

## 修改文件

截图、测量报告和可复查日志归档在 `docs/evidence/ui-visual-finish/`，随分支提交。

| 文件 | 内容 |
| --- | --- |
| `public/ui/toast.js` | 信息级默认静默、去重、可见错误防堆叠、安全日志回调注入 |
| `public/extension-notices.js`（新） | 当前 workspace/bridge 的有界扩展状态，去重计数、错误分流、纯文本展示；不落盘 |
| `public/app.js` | 接入通知日志及扩展 notify 分流 |
| `public/extensions.js` | 扩展页显示运行提示，切换/关闭时清理监听器 |
| `public/capability-view.js` | 将已报告的 qmd 提示投影到 Memory 说明 |
| `public/memory-capabilities.js` | 更新 qmd 信息来源文案，保留纯能力模型 |
| `lib/log-contract.cjs` | 增加 INFO/ERROR 通知白名单事件，只允许 kind，不记录消息正文、路径、凭据 |
| `public/ui3-model-picker.js` | 移除装饰箭头；保留原有按钮、回调、折叠状态及键盘漫游 |
| `public/ui3-model.css` | 选择态透明、中性对勾、轻 hover、中性焦点框 |
| `public/conversation-nav.js` | 命中区布局、内部滚动跟随、键盘导航与 aria-current、固定预览定位 |
| `public/messages.js` | 去错误图标；区分实时 alert 和历史展示 |
| `public/styles.css`、`public/ui4-feedback.css` | 导航和上下文细节、平整红色错误文本、扩展状态文本 |
| `tests/ui-visual-finish.cjs`（新） | 通知/日志/状态留存/错误语义/500 条导航回归 |
| `tests/ui-visual-finish-electron.cjs`（新） | 真实 Electron 鼠标键盘、亮暗主题、响应式、布局和截图 |
| `tests/smoke.cjs` | 更新 9 条旧视觉/通知预期；未删除或跳过断言 |
| `tests/ui4-feedback.cjs`、`tests/ui4-integration.cjs` | 生命周期测试显式请求重要通知，保留关闭/焦点/重放/去重覆盖 |
| `tests/ux-state.cjs` | 普通扩展 warning 改验收为状态保留、无弹窗 |
| `package.json` | 新回归套件加入唯一的 npm test 链 |
| `docs/plans/2026-10-20-ui-visual-finish.md` | 本轮有限范围及验证计划 |

## 已通过的检查

| 命令/检查 | 实测结果 |
| --- | --- |
| `node tests/ui-visual-finish.cjs` | 10/10；初版修复前 3 个失败已确认 |
| `node tests/ui-visual-finish-electron.cjs` | 最终源码 32/32，失败 0；11 张截图 |
| 同一 Electron 套件，VISUAL_ASSETS_ROOT 指向最终打包 public | 最终打包资源 32/32，失败 0；11 张截图 |
| `node scripts/run-test-group.mjs --group ui` | 24/24 个规范入口通过；Smoke 1338/1338，断言未减少 |
| `node tests/ui3-model.cjs` | 50/50 |
| `node tests/ui3-composer.cjs` | 34/34 |
| `node tests/ui4-feedback.cjs` | 27/27 |
| `node tests/ui4-integration.cjs` | 55/55 |
| `node tests/ux-state.cjs` | 最终 15/15 |
| `npm run test:logging` | 63 个断言通过；1 条环境相关跳过未计入通过数：32 + 7 + 9 + 8 + 7 |
| `node scripts/run-test-group.mjs --validate` | 150 个规范测试叶节点，5 组精确覆盖 |
| `npm run build:app -- --rebuild` | 最终退出 0；离线 Electron 44.4.3 本机缓存；exe 234.9 MB，整包 328.5 MB |
| `npm run fixtures`，然后 `node tests/app-check.cjs` | 最终 26/26，退出 0；使用动态探测端口 CHECK_PORT，fixture 在系统临时目录 |
| `git diff --check` | 无空白错误 |

源码视觉证据：[报告](evidence/ui-visual-finish/source/report.json)、[亮色模型菜单](evidence/ui-visual-finish/source/light-models.png)、[暗色 Thinking](evidence/ui-visual-finish/source/dark-thinking.png)、[简洁错误](evidence/ui-visual-finish/source/light-error.png)、[长会话导航](evidence/ui-visual-finish/source/long-navigation.png)、[扩展状态](evidence/ui-visual-finish/source/extension-status.png)。

打包视觉证据：[报告](evidence/ui-visual-finish/packaged/report.json)。
构建：[日志](evidence/ui-visual-finish/visual-build-final.log)。打包后端：[日志](evidence/ui-visual-finish/visual-app-check-final.log)。

## 未通过及证据边界

- 基线及最终 `npm test` 均在未修改的 `session-revert-sacl-witness.cjs` 停止，输出 `witness_unavailable`，退出 1。额外检查其 PowerShell helper 返回 1 且无 JSON；不把它包装成纯粹缺少审计权限，具体原生原因本轮未解决。[最终日志](evidence/ui-visual-finish/visual-final-npm-test.log)
- 补充分组运行时，系统 TEMP 的 esbuild 输出曾报 Access denied；改用仓库内测试 TEMP 可消除该输出权限问题，但 Git 的 plain 目录会向上发现主仓库，因此 Git 套件出现 2 个 fixture 环境失败（159/161），不是本轮 Git 产品代码变化。[日志](evidence/ui-visual-finish/visual-core-final.log)
- 额外原生专项并未全过：`session-revert-inplace-safety.cjs` 的 attribute identity 断言失败；`session-revert-object-runtime.cjs:121` 预期 applied_verified、实际 not_applied。这些文件/执行路径未修改；未完成独立基线归因，不声称它们已经排除。
- 首次把 app-check fixture 放在仓库内 TEMP 导致“没有 node_modules”断言失败；改回系统临时目录并避开被拒绝的固定 7798 端口后，最终 26/26。没有删除或放宽断言。
- 本机 Electron 默认沙箱启动报 0x80000003。真实界面测试仅对隔离 fixture 使用 --no-sandbox，产品配置不变；因此截图不构成 Electron 沙箱验收。未调用真实 Pi/模型，也未写用户真实会话。
- 用户要求不使用子代理，因此独立 Agent 复审未运行；作者完成了 diff 自查。
- 用户提出时间约束后未继续补跑全量或扩大原生检查，只完成相关 UI、构建和打包验收。

## 合并与回滚

本轮五项 UI 专项通过。完整检查仍有上述未解决结果，独立复审未执行；这些证据边界没有因合并而解除。2026-10-20 用户在知悉验收结果后明确要求推送，随后明确要求合并，本次据此合并到 main，不补跑全量测试。

已将 `codex/ui-visual-finish` 的两个提交（`87e1227` 业务代码、`c1a894e` 测试与验收证据）按用户要求合并到最新 main，并推送 main；不发版。合并未产生产品代码冲突，合并结果复核定向回归 10/10。回滚时针对本次合并使用 git revert -m 1，不要对整个工作区 git restore，以免覆盖既有数据或后续用户修改。旧分支 `codex/fix-high-risk-regressions` 保持原样。
