> 2026-11-06 第二轮瘦身：本页移除的历史截图/完整日志链接固定到清理前提交 `2e70463183218ddf3a10972789667d6be5c294df`；原始结果和失败记录保留，不能作为当前代码通过证明。

# 阶段 F：浅色与全局视觉收尾验收

## 提交、范围与状态

基线 `5d8d9d02f5f760a17bca3f61042872bba6c85dac`，main push CI [42016791631](https://github.com/HYJ1817/pi-gui/actions/runs/42016791631)，attempt 1，准确 head 对应该基线，completed/success；它不作为 F 新代码证明。分支 `codex/pi-desktop-phase-f`，固定参考 `vastsa/PI-Desktop@92ae661f1e399e69d514086b46029b4c34ba1a92`。

生产样式提交 `a43a9d692569003b976c86e92e1db0d7a72f8ec2`；测试提交 `d7261986e3b9ea2a299c044d7dfb484036d1a80a`。最终 7 个行为/测试/脚本文件身份见 [validated-source-sha256.json](../screenshots/phase-f/validated-source-sha256.json)。文档提交可用 `git log -1 --format=%H -- docs/ui/pi-desktop-reference/19-phase-f-acceptance.md` 定位，并在交付消息中记录。

本轮仅收敛现有样式，生产 JavaScript、Electron 控制器、Pi RPC、存储、会话/项目架构、权限、依赖和版本均未修改。canonical 已完成同一冻结状态的累计验证：首轮中断，第二轮端口占用失败后，从原清单失败项续跑，234 条唯一命令成功覆盖；没有单次完整 `npm test` 退出 0 的记录。未推送、建 PR、合并或发布；用户验收待进行。遵照用户要求未使用子代理，独立复审未运行；作者自查不代表独立审查或用户批准。

## 源码勘察与文件清单

勘察与计划见 [18](18-phase-f-implementation.md)。保留 `theme-init.js` / `theme.js` / `electron/theme.cjs` 的首屏、偏好与原生按钮所有权；保留命令菜单、用量、模型、附件、Settings Surface 和右栏的真实状态与交互。

| 文件 | 变化及边界 |
| --- | --- |
| `public/styles.css` | 删除 44 行重复开关规则，让 A 的 `ui/primitives.css` 成为唯一实现；分组标题改用 muted；外观错误/警告及供应商按钮复用已有语义变量 |
| `public/ui3-inline-commands.css` | 移除 320px 上限，保留视口上限；语义文字、选中、提示及焦点颜色；不改候选、键盘、IME 或定位逻辑 |
| `public/ui3-model.css` | 模型/用量浮层使用语义文字和选中色；中性详情明确排除 `.tip-warn`，保留警告含义 |
| `tests/app-shell-electron.cjs` | 在既有正常沙箱工具末尾增加可选 F hook，原有 C/D/E 场景继续执行 |
| `tests/theme-convergence-electron.cjs`、`tests/fixtures/theme-convergence-scenarios.cjs` | 专项入口及真实生产模块/CSS 回归，使用 TEMP、离线数据和真实原生 Browser |
| `package.json` | 注册独立 `test:theme-convergence:electron`，canonical 仍从原链递归生成 234 条命令 |
| `docs/composer-ui.md`、08/README/18/19、截图与 JSON | 当前行为说明、差异及证据身份，不扩展业务 |

没有新增生产模块、配色体系、依赖或 `!important`。只清理已证实覆盖原语的旧规则；其余历史样式不做无依据的全局抹除。

## 逐区域视觉与源码对照

参考路径以 `apps/desktop/src/` 为根，pi-GUI 路径以 `public/` 为根。

| 区域 / 参考图 | 固定参考实现与参数 | 修改后真实结果 | 分类及差异 |
| --- | --- | --- | --- |
| 主界面 / REF-021 | `styles/tokens.css` light；`composer.css`、`messages.css`：侧栏 #f3f3f3、主画布/Composer #fff、正文 #1a1c1f，46px 顶栏、275px 导轨 | f01/f12；沿用 C/D 几何、原生按钮和输入节点，深墨发送按钮、白色浮动 Composer，折叠/主题切换均保留草稿 | 背景层级达到；内容、项目/会话与业务按钮不同，不宣称逐像素一致 |
| Slash / REF-022 | `styles/composer-autocomplete.css:1–33` 为完整 Composer 宽度，白色 opaque 浮层、中性文字与 hover；原源码状态聚焦保留 textarea | f02/f10/f13；320px 错误上限移除，实测宽度跟随原输入区（宽窗 736 CSS px、窄窗 388 CSS px），真实上下键/Escape 保留焦点与草稿 | 核心宽度/主题达到；参考卡片随 760px 外框，本项目锚定内侧输入区；保留真实中文命令与逐项分组胶囊，没有参考的分组标题/底部提示条 |
| 上下文 / REF-023 | `styles/messages.css:1651–1677` 的 opaque 表面与语义文字；参考还有更多耗时/模型分析字段 | f03/f04/f11/f14；深墨主值、中性详情、已有输入/输出与上下文；unknown 显示“—/暂无上下文数据”；真实 unavailable 额度警告保留状态色 | 表面与可读性达到；保留本项目用量结构、原宽度/圆角/锚点及远端额度，不捏造耗时或 Token |
| 文件提及 / REF-024 | `Composer.tsx`、`composer-autocomplete.css` 的文件候选及路径插入 | f05 是真实普通 `@` 草稿，f06 是既有附件托盘，删除附件仍保留原输入节点和草稿 | **未实现，未通过该功能验收**；当前 Composer 没有对应入口与状态所有者，不伪造补全列表、不新增文件索引/权限 |
| 设置标题/控件 / 无浅色原图 | `styles/settings.css:240–247` 分组标签用 muted；A 的 `primitives.css` 与 token：38×22 开关、白色 off/on 滑钮和 off 细环 | f08/f09 分组标签由 #afafaf 改为 #5d5d5d；生产原语真实 Electron 组件断言验证 38×22、off 白色/细环、on 深墨和 disabled 行为 | 源码/渲染核对达到；原语目前没有业务调用，测试节点在截图前已移除，没有设置新业务开关 |
| 设置反馈 / 无浅色原图 | 当前产品已有 danger/warning 语义 token；不要求用无依据强调色 | 外观错误由 #f87171 改为 #b91c1c，警告由 #fbbf24 改为 #854d0e；供应商主要按钮随主题反转 | 可读性修复；外观错误/警告 CSS 类为显式注入测试，只证明状态样式，不冒称真实存储故障已实测 |
| 原生右栏与菜单 / E 延续、无浅色 Browser 原图 | 参考原生承载与本项目既有权限/几何边界；禁止仅靠 z-index 覆盖原生视图 | f15 原生整窗：真实附着 WebContentsView，扩大后的 slash 右边缘仍在 native bounds 左侧；原工具、Agent 状态与分屏保留 | 原生边界达到；未向网页或原生空视图注入应用主题，原空视图仍是深色，属于保留的原生内容差异，不能宣称全窗口无深色像素 |
| A/B/C/D/E 回归 | 已验收组件及各自状态所有者 | 同次进程重跑菜单、稳定排序、运行投影、设置、Classic/Runtime、Markdown/复制、模型/用量、Specs/Changes/Browser/分屏与主题 | 回归通过；离线生命周期/消息投影不等于真实 Pi 或付费模型长负载 |

[contrast-measurements.json](../screenshots/phase-f/contrast-measurements.json) 按实际计算色作 WCAG sRGB 核算：正文白底 17.076:1，muted 白底 6.585:1；设置分组标题在 #f3f3f3 上由 1.977:1 提升为 5.934:1；外观警告由 1.669:1 提升为 6.851:1，错误由 2.766:1 提升为 6.470:1。不将文字抗锯齿像素或 disabled 状态混入正文对比度结论。

## 真实 Electron 图与尺度

[results.json](../screenshots/phase-f/results.json)：**97/97，66 张 renderer + 7 张原生整窗图**；其中 F 为 15 张 renderer、2 张原生整窗，其余是本轮新采 A/B/C/D/E 回归。Electron 44.4.3，正常 sandbox/contextIsolation 开启、nodeIntegration 关闭。F CSS 1205×803、DPR 1.5、PNG 1808×1205；窄窗 700×600 / 1050×900。继承 C 的部分图为 1206×803 或 700×650，按每图 geometry 区分，原生整窗含 DWM，不与 renderer 捕获混算。

参考 4 张原始图尺寸、pHYs 和摘要见 [reference-calibration.json](../screenshots/phase-f/reference-calibration.json)。1.5 DPR 采用已提供校准条件，不冒称独立探测参考 OS。73 张最终图的身份见 [screenshot-manifest.json](../screenshots/phase-f/screenshot-manifest.json)；摘要只绑定身份，不表示视觉符合。

| 场景 | 实际截图 |
| --- | --- |
| 浅色主界面 / REF-021、折叠 | [f01](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f01-conversation-light.png)、[原生整窗](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f01-conversation-light-native.png)、[f12](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f12-collapsed-light.png) |
| Slash / REF-022、窄窗、深色回归 | [f02](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f02-slash-light.png)、[f10](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f10-slash-narrow-light.png)、[f13](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f13-slash-dark.png) |
| 上下文 / REF-023、unknown、窄窗、真实警告投影 | [f03](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f03-context-light.png)、[f04](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f04-context-unknown-light.png)、[f11](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f11-context-narrow-light.png)、[f14](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f14-quota-warning-light.png) |
| REF-024 未实现的普通草稿、实际附件与模型 | [f05](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f05-at-draft-light.png)、[f06](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f06-attachment-light.png)、[f07](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f07-model-light.png) |
| 设置/供应商浅色规范核对 | [f08](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f08-appearance-light.png)、[f09](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f09-providers-light.png) |
| 真实 native Browser 与 slash 边界 | [f15](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f15-slash-browser-light.png)、[原生整窗](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-f/f15-slash-browser-light-native.png) |
| 既有界面回归 | 同目录 01–14（C/A/B）、d01–d19（D）、e01–e18（E）；均由本轮最终运行新采，不改历史证据目录 |

## 测试、失败历史与完整证明

| 实际命令 | 结果 |
| --- | --- |
| `node tests/theme.cjs` | 47/47，含偏好持久化、首屏、模拟 system、IPC 与迟到事件；非布局证据 |
| `node tests/primitives.cjs` | 退出 0；5 组输出成功，但无统一断言总计，不自行编造总数 |
| `node tests/settings-acceptance.cjs` | 15/15 |
| `node tests/ui3-inline-commands.cjs` | 46/46 |
| `node tests/ui3-integration.cjs` | 23/23 |
| `node tests/runtime-conversation.cjs` | 106/106 |
| `node tests/context-reference-ui.cjs` | 10/10 |
| `node tests/session-search.cjs` | 额外清晰日志复核 72/72；5i 符号链接场景未验，不计通过 |
| `node tests/ui-visual-finish.cjs`、`node tests/app-shell.cjs` | 各 10/10 |
| split / Specs / Browser UI | 分别 30/30、25/25、14/14 |
| `npm run test:theme-convergence:electron` | 最终 97/97，正常沙箱，包含真实 native Browser 菜单边界 |
| `npm run test:ui3` | 最终 243/243、0 跳过，正常沙箱；[结果](../screenshots/phase-f/ui3-integration-results.json) |
| `npm test` / canonical 续跑 | **累计 234 条唯一命令成功**：第二轮原入口前 159 条正常结束，第 160 条因端口占用退出 1；原清单第 160–234 条的 75 条续跑全部退出 0；[完整身份、覆盖来源及失败记录](../screenshots/phase-f/canonical-results.json) |

[directed-verification.json](../screenshots/phase-f/directed-verification.json) 记录实际定向命令、日志摘要与退出码。原始日志及失败图保留在本机 TEMP `pi-gui-phase-f-f91c4bb28f1f4ac0892b953dda663225`。没有减少原有断言；新 Electron 26 项包含 2 项原生捕获检查，原 71 项继续执行。234 是 canonical 命令数，不是断言数。

第二轮原入口于 2026-11-05 22:29:43–22:57:41（UTC+8）执行，1678.277 秒，退出 1；续跑于 23:04:08–23:55:38 执行，3089.608 秒，75 条逐项退出 0。前 159 条依据已验证的递归 `&&` 链到达失败命令推定正常结束，没有为此前缀伪造逐项耗时；续跑保留实际逐项退出码/耗时。7/7 输入摘要最终不变，清单由当前 package 和生命周期重新生成校验，不维护第二份测试入口。复跑不重复计入 234。

权限与未验项单列：Collab store / Candidate adoption / logging-leaks 各有 1 个符号链接场景跳过；SACL witness 0/0、跳过 8，inplace 28/28、跳过 2，Object witness 0/0、跳过 8。搜索 5i 的首段中文日志受转码影响，额外定向复核明确显示该场景未验。跳过不计入断言通过分子/分母，两个 0/0 witness 不代表审计资格通过。

失败与收敛记录：

1. 首次新 fixture 字符串转义错误，70/71；F 未执行，不作为产品红灯。修正并先检查语法。
2. 未改生产样式时 84/92，8 项真实失败：320px 宽度上限、旧文字色、原语颜色/细环和错误/警告备用色；修复后 92/92。
3. 截图复查发现设置分组标签过浅，补回归为 93/94（#afafaf）；按固定源码改为 muted 后 94/94。
4. 作者发现中性详情规则可能覆盖 quota 警告。首个补测 77/78 因测试直接重开 Tip 与离开触发器的延迟关闭时序冲突，查询到空节点；改用真实按钮入口并等待实际警告节点，不修改产品计时器。随后 96/97 确认警告错误地为 #5d5d5d；选择器排除 `.tip-warn` 后最终 97/97。
5. 初次重建成功但早于最终警告选择器修复；复用同一个独立产物目录被构建脚本的“必须 fresh”保护拒绝（退出 1，未变更脚本）。改用新的 `phase-f-verified-output-20261105` 目录，最终重建退出 0，3/3 包内样式摘要一致。旧产物不能作为最终构建。
6. 首轮完整 `npm test` 没有写出退出记录，进程已停止；日志停于 candidate adoption 用例，最后写入时间为 2026-11-05 20:21:14（UTC+8）。原因未确定，不计作通过。保留 `canonical-attempt-1-interrupted.log/json`，确认 7/7 输入不变后重新执行完整入口（attempt 2），不将首轮片段冒充完整成功，也不拼接成单次执行。
7. 第二轮隐藏 helper 的部分中文原生输出出现转码字符；与 E 的 UTF-8 控制台日志对照可见差异，后台 helper 未显式设置控制台 UTF-8，具体文本丢失不做重建。原日志保持不变并记录摘要，命令名、英文计数、JSON 键和退出元数据可核对；不能据此声称所有中文日志均可读。
8. 第二轮于第 160 条 `node tests/dev-server.cjs` 启动服务失败，退出 1，错误为 `listen EACCES 127.0.0.1:7791`。只读检查确认已有 `mihomo` 进程占用该端口，未终止或修改该进程。该测试已支持 `TEST_PORT`，现有 CI 分组也使用 TEST/GUARD/SEC/GIT 四个端口变量；续跑使用空闲夹具端口，生产与测试文件均不修改。第 1–159 条成功依据原递归 `&&` 链已到达第 160 条，后续逐条执行当前 package 生成的原命令清单并记录退出码；最终必须标“累计验证”，不能标单次 `npm test` 成功。

## 构建、审查、风险及回滚

最终离线命令：`npm run build:app -- --rebuild --output-root C:/pi-GUI/.shots/phase-f-verified-output-20261105`，退出 0，使用现有 Electron 44.4.3 缓存。产物为 `.shots/phase-f-verified-output-20261105/dist-app/Pi GUI-win32-x64/Pi GUI.exe`，入口 234.9MB、整包 329.3MB。[build-verification.json](../screenshots/phase-f/build-verification.json) 绑定日志和 3/3 修改样式的包内摘要；正常沙箱截图跑源码应用，不冒称打包 GUI、安装或升级已验收。

作者风险判断为中：全局 stylesheet 中既有控件的局部覆盖清理、浮层显示与可读性。已检查全部增量、引用、状态色与释放；警告覆盖问题已修复。当前未处理的新增 Blocker 0 / Important 0。Pre-existing 1：E 已记录的旧 `ui4-pane` 420/392 夹具问题本轮不改，也不计为本轮通过；另有排除业务 1（REF-024 当前无入口）。canonical 累计覆盖完成，独立复审未运行，用户验收待进行。

未验证：macOS/Linux、真实 OS IME/显示缩放切换、真实 Pi/模型长负载、完整协同画布人工交互、真实远端额度供应商、打包 GUI 与安装升级。原生网页/空视图不由 renderer 主题重绘；历史 A/B 其他 `!important` 未全仓清理。没有发现要求继续改业务状态或添加参考独有功能的依据。

回滚本轮行为：`git revert d726198 a43a9d6`，并在新的独立目录重建。同步恢复或修订当前功能说明；历史报告/图片可保留并标记已回滚。无数据迁移或用户文件写入，不需要恢复项目文件。后续若做文件提及、重新组织用量业务或原生空页主题，应另做业务与权限设计，不从本轮视觉完成推导已授权。

当前结论：F 样式、作者自查、定向及 Electron 专项、canonical 累计证明、重建完成；没有单次完整 `npm test` 成功记录，失败与未验项完整保留。用户验收待进行；本轮没有推送、合并或发版权限。
