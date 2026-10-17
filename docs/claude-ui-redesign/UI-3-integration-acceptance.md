# UI-3 集成与联合验收

日期：2026-10-17，Asia/Shanghai。工作区 `C:/pi-GUI-ui3-integration`；分支 `codex/ui3-integration`；共同基线 `d1524cb02f010cf9d474727c212f4048fc9abf75`。

状态：三个分支的生产接线、自动化联合验收、完整回归与隔离离线构建已完成。交付用户验收；真实 Windows 中文 IME 手工终验仍未关闭，不以合成事件替代。没有进入 UI-4。

## 1. 输入分支和预检

| Agent | 真实最终提交 | 集成 merge 提交 |
|---|---|---|
| A Composer | `3da7d5f3add70a4c6a50a77a656eaa3b26fd3bae` | `02ce1bf416ad807abf870759baa683652fdf89ce` |
| B Model / Thinking | `c780d69ae670a46da5f0eaa95acef6e4427678c4` | `a91f57c7794a34247e54c6fb967659f6e871fa1c` |
| C Slash | `e6c08f764252c9169f888c0520f97217351bf6fe` | `79c31fc70f470fdf96111d8f45c60c45137b2b84` |

三个 merge-base 均为共同基线，预检及后续核查 A/B/C 工作区均无未提交修改。B 的模块、CSS、两份测试、验收文档和 32 张参考证据均可从最终提交追踪；报告内 `??` 清单是旧的阶段记录，没有将其当作已提交的证明，也没有从其工作区复制文件。A/B/C 原工作区没有被切换、重置或写入。

读取原仓库 AGENTS、机器约定、UI-2 集成验收与 UI-0/1 设计契约，以及三份最新 UI-3 报告。原仓库仍在 `d0585b8`，保留原有未跟踪素材与构建目录。指定集成目录/分支起初不存在，按指定基线创建；A→B→C 使用 `git merge --no-ff`，没有文本冲突，历史完整保留。没有访问远端、安装依赖、推送、合并 main、升级版本或发版。

前测三个新增单元套件实际为 A 34/34、B 50/50、C 46/46，退出码 0；日志 `baseline-*.log`。完整 UI-2 既有测试记录来自共同基线报告；本轮完整 npm test 实测另见第 6 节。

## 2. 文件范围与安全审查

相对于共同基线的全部产品文件：

- A：`public/composer.js`、`public/attachments.js`、`public/ui3-composer.css`。
- B：`public/ui3-model-picker.js`、`public/ui3-model.css`。
- C：`public/ui/inline-command-menu.js`、`public/ui3-inline-commands.css`。
- 集成共享入口：`public/app.js`、`public/index.html`、`public/ui/popover.js`；`package.json` 仅测试脚本。

测试含三个 Agent 原套件、`tests/ui3-model-real.cjs`，新增 `tests/ui3-integration.cjs`、`tests/ui3-integration-electron.cjs`、`tests/ui3-cdp.cjs`；调整 `tests/visual-harness.cjs` 的可选资源根/临时上传目录，及 `tests/cdp-shot.cjs` 中四个宽度共用的一条旧设计判据。所有原测试断言保留，未删除套件。其余变化是原 Agent 报告/证据及本报告/联合证据。

`server/`、`lib/`、`electron/`、`extensions/`、server.js、RPC、Runtime store/conversation/models/state、model-capabilities、palette-model、styles.css、tokens.css、package-lock.json 与共同基线无差异。没有修改 Pi RPC/SSE、模型回读协议、owner/revision/sequence、安全审批、P33 闸门、Browser 安全配置或附件解析/组装协议。

[source-audit.json](ui3-integration-evidence/source-audit.json) 保存分支、提交链、保护路径、测试链和包内哈希。未增加依赖，版本未变化。所有测试项目、会话、进程与上传为隔离夹具；没有对真实用户会话或项目做写操作。运行时仍保留 Classic 与 Runtime 各自模型权威。

## 3. 生产接线

### Composer

index 静态加载 `ui3-composer.css`，没有夹具临时注入才能生效的问题。继续只有一个 `--composer-reserved-height` 高度事实源和 Composer 外层 ResizeObserver；输入/滚动/窗口 resize 复用 A 的同步器。未再初始化 Composer observer。附件状态和真实 disabled 来自原模块，没有新的发送政策。

### Model / Thinking

index 静态加载 `ui3-model.css`；app 的 `openModelPicker()` / `openThinkPicker()` 委托给 B 的两个 render 函数，传入 S.models、S.state.model、S.thinkingLevels、modelSwitchPending 与既有 provider 折叠 Set。onSelect 仍调用原 setModel/setThinkingLevel；模型身份与摘要继续由 B 直接使用 modelIdentity/modelCapabilitySummary，不在 app 另造注册表或缓存。

原 Thinking 按钮继续原 disabled 门禁；新增同级原生按钮 `#btnThinkInfo.chip.ui3-thinking-info`（“思考说明”）在已选项目、桥接可用且选择按钮不可用时显示，打开同一个 popover 的只读事实说明。无档位、unknown、unsupported、pending 分开解释，未启用任何假档位。原 setThinkingLevel 的 pending/levels 守卫保持原样；注入回调也核对真实按钮 disabled。

独立只读审查发现并修复两处 P2：无启用项时说明弹层原先无法用 Escape 关闭，现将焦点交给现有 dialog；回读后说明入口失效时关闭过期说明并将焦点交给可用按钮。接线单元从 19 条增加到 23 条，原断言全保留。状态变化由现有控件渲染的 DOM 变化触发只读同步，不复制模型事实或增加 RPC。

### Slash / 独立命令面板

index 静态加载带固定 ID/data 标记的 `ui3-inline-commands.css`，创建菜单时 `injectStyles:false`；仍兼容模块原 ensureStylesheet 幂等检查。没有重复 stylesheet。

命令注册完成后创建/attach 一个 createInlineCommandMenu，不 bind 第二个键盘监听。在原 textarea keydown 的最前面调用 handleKeydown 并在消费后 return；随后统一检查 isComposing、keyCode 229 和 composition 生命周期，再进入原发送/停止分支。独立 Ctrl+K / Ctrl+Shift+P 走原 palette 实现；包装入口先关闭内联菜单/现有 pop，不复制注册表或命令执行逻辑。

接受命令后按 C 原语义仅移除对应 `/token`，保留同一文本框的其余正文；取消菜单则保留草稿。未知/过期候选不发伪造命令。app 仅将执行错误显示为固定提示。

## 4. 联合检查与发现的修复

| 场景 | 实际结果与证据 |
|---|---|
| 十行输入、多附件、模型选择 | 生产 DOM 与整套 CSS；模型弹层内部滚动，长名称两行/窄屏三行，不越视口 |
| Slash / Enter | 受信 CDP Enter 执行注册表夹具命令恰好一次，token 清除，prompt/abort 为 0；关闭菜单后普通 Enter 走原 submit 恰好一次 |
| Escape | Slash 关闭且草稿保留，未 abort；模型/说明 dialog 通过既有 Escape 关闭并还焦点 |
| Ctrl+K | 真实 CDP 打开原独立 palette，Slash 已关闭；原快捷键与注册表保留 |
| IME | jsdom 和真实 Chromium 内的合成 isComposing、229、compositionstart/end 均不误发；**没有真实 Windows 候选窗手工终验** |
| 会话 / Planner / Runtime | session/workspace 同款生命周期事件关闭菜单；另实际点击 Planner 和调用原 Runtime surface 切换，菜单关闭、Classic 草稿保留；未伪造 Runtime owner |
| 跨 Provider 同名模型 | 实际点击 beta/same 仅一次 set_model，provider+modelId 正确；pending 禁用 Thinking/Send |
| 失败 / 权威回读 | 实际注入匹配原请求 ID 的失败应答，再完成 get_state 与 levels 两腿；展示保留 Pi 的 alpha 模型，Thinking 无可用档位、图片门禁按真实返回更新，草稿保留；后续支持图片/推理的回读恢复控件 |
| Dark / Light、四档宽度、右栏、缩放 | 见第 5 节真实渲染矩阵 |
| reduced-motion | 实际 computed style 确认菜单动画、Composer transition、附件 spinner 都关闭 |

集成问题及处理：

1. C 的 `import.meta.url` 使现有 jsdom app 链接器不能加载，改为基于文档根路径解析自己的 stylesheet。没有改测试链接器来忽略非法代码。
2. C 的 attach 局部参数 `el` 被既有全局 el 引用扫描当作 DOM 表；改名 targetHost，保留旧断言。首轮 npm test 因此在 smoke 1337/1338 停止，退出 1，原日志保留。
3. 真实矩阵发现模型菜单被窄屏原生 Browser 覆盖。只调整共享 popover 的展示边界，使其在既有右栏左侧；没有扩大任何原生遮挡或 Browser 权限协议。
4. 根变量 `--rp-width` 在右栏关闭后仍记忆宽度，C 原定位会错误扣除；现仅在右栏真实展开时消费该宽度。
5. 多附件截图显示 Slash 会覆盖附件卡。定位改为整个 composer-box 上方，并限制可滚动菜单高度；测试判据现要求菜单底部在整个外壳上边界之上。
6. Electron 起初未保证前台焦点，键盘测试无法投递；现先检查 document.hasFocus，再通过当前 webContents 的 CDP 分发受信键。未使用过早 Runtime.enable，也未关闭 sandbox。
7. 采集发现普通发送合法清空附件后，后续矩阵夹具没有重建附件；已明确恢复 6 个附件并增加前置断言。最终截图等待动画结束，避免将半透明的过渡帧当静态配色。

## 5. 真实截图与渲染证据

全部为集成后的生产 index/app 渲染，不复用 A/B/C 分支截图。源码目录和最终包内资源各跑一套，sandbox:true、contextIsolation:true、nodeIntegration:false。Browser 使用原 preload/controller/agent host，访问范围限离线夹具。

- [electron/results.json](ui3-integration-evidence/electron/results.json)：源码渲染结果；[packaged-electron/results.json](ui3-integration-evidence/packaged-electron/results.json)：最终包内前端结果。
- 各套 **107 张截图**：Dark/Light × 700/900/1200/1536 CSS px × 左栏展开/折叠 × closed/Changes/Browser × Slash/Model = 96；80/125/150% 应用 zoom 的两种菜单 6；Thinking 三种原因 3；失败回读 1；reduced-motion 1。
- 矩阵含十行中文/英文、6 个附件（长文件名/解析中/失败/截断）、跨 Provider 同名及长模型名。断言覆盖真实几何、菜单可见、横向溢出、与右栏和附件/操作的关系。
- capturePage 是真实 Electron 网页像素，不包含原生子视图内容。窄屏原有右栏 overlay 仍可能覆盖聊天/输入框；这里没有把关闭/缩窄右栏伪装成验证，菜单边界按真实 paneLeft 检查。
- 这一轮未改标题栏；UI-2 的原生标题栏实拍结论保持。上述图片不作为 OS 窗口控制、真实 DPI/中文 IME 或实际模型证明。

原 CDP 大回归实际通过 **1761 条检查**，归档 **270 张不同 PNG**，见 [cdp/manifest.json](ui3-integration-evidence/cdp/manifest.json)。4 条旧规格要求单行 ellipsis；根据 B 的明确设计及 Chromium 实测改成“两行/窄屏三行 line-clamp、真实多行高度、overflow-wrap:anywhere、条目/弹层无横向溢出”。只替换同一谓词，四档宽度、取景和其余全部断言保留，数量不减少。原始失败日志、修正后的日志均归档。

## 6. 测试结果

| 实际命令 / 层级 | 结果 | 失败 | 跳过 | 退出码 |
|---|---|---|---|---|
| `node tests/ui3-composer.cjs` | 34/34 | 0 | 0 | 0 |
| `node tests/ui3-model.cjs` | 50/50 | 0 | 0 | 0 |
| `node tests/ui3-inline-commands.cjs` | 46/46 | 0 | 0 | 0 |
| `node tests/ui3-integration.cjs` | 23/23 | 0 | 0 | 0 |
| `npm test`（最终完整运行） | 135 条入口命令全部执行完成；120 条逐套数字摘要 | 0 | 19 | 0 |
| `node tests/ui3-integration-electron.cjs`（源码） | 243/243，107 张截图 | 0 | 0 | 0 |
| 同上，`UI3_ASSETS_ROOT=<最终包内 public>` | 243/243，107 张截图 | 0 | 0 | 0 |
| `node tests/ui3-cdp.cjs` | 1761/1761，270 张不同截图 | 0 | 0 | 0 |
| `node tests/app-check.cjs --output-root <最终目录>` | 26/26 | 0 | 0 | 0 |

最终全量实际运行时间：2026-10-17 **13:48:26.840—14:38:15.597（+08:00）**，**2988.756 秒**。独立进程记录 [npm-test-final-process.json](ui3-integration-evidence/npm-test-final-process.json)，原始 [npm-test-final.log](ui3-integration-evidence/npm-test-final.log)，逐套 [test-summary.md](ui3-integration-evidence/test-summary.md) / [test-results.json](ui3-integration-evidence/test-results.json)。

与 UI-2 的 **116 条原有数字摘要通过/总计序列完全一致**，没有既有断言下降；新增四套共 153 条单元/联调断言，数字摘要 116→120。smoke 保持 1338/1338。135 是入口命令数量，不冒称全局断言总数；未打印数字的通过标记及 JSON 结果分别记录，不重复相加。

实际环境跳过 **19 项**，与 UI-2 相同：SACL witness 8、非空 SACL 保持 2、Object witness 8（权限不足），会话符号链接 1。两个 witness 的 0/0 不算通过；SACL 未知不当作空值，不产生 P33 生产资格。没有新增 UI-3 单元或桌面测试跳过。

canonical 从 UI-2 的 131 条命令增加到 135：A/B/C 三套跨机器单元 + 本轮联调单元置于原链前，原 131 条链及顺序逐字保留。需要图形环境的 Electron/Chrome 留在 `test:ui3`、`test:ui3:visual`，不强迫无图形 CI 执行。

完整日志保留，不把权限跳过算作通过，不将 P33 生产资格或真实模型资格从这些 UI 测试中推导出来。最终全量进程在布局代码冻结后重新启动，用独立本地进程持久记录退出码；最终结论只依据 `npm-test-final.log` 与 `npm-test-final-process.json`。初次 smoke 失败记录是 `npm-test-initial.log` / `npm-test-initial-process.json`（`npm-test-process.json` 为同次旧结果）；两次交互中断的部分日志单列为 `npm-test-interrupted*.log`，没有完整退出码，不计全量通过。未因中断丢弃诊断证据。

本机原生命令输出转码使部分中文测试标题在日志中乱码，原始记录未改写；ASCII 套件标识、数字摘要与独立进程退出码用于核查。源码及截图中的中文不依赖这份终端日志。

最终格式复核：`git diff --check d1524cb HEAD -- public tests package.json` 退出 0。包含所有原始证据的 `git diff --check d1524cb HEAD` 退出 2，仅 `cdp.log`、`cdp-before-ui3-spec.log`、`cdp-before-metric-fix.log` 中 51 处取景文本行尾空格；保留原始采集内容，没有为消除格式提示改写证据。此项是日志格式提示，不混记为测试通过或产品失败。

## 7. 隔离离线构建

实际 `node scripts/build-app.mjs --rebuild --output-root <临时独立目录>`，使用已存在的本机 Electron ZIP 离线缓存，退出 0。路径在 [build-root.txt](ui3-integration-evidence/build-root.txt)，构建日志 [build.log](ui3-integration-evidence/build.log)。整包约 328.1 MB，入口约 234.9 MB。未覆盖既有安装产物。

最终 resources/app/public 的 **104 个文件 SHA-256 均与源码一致**，包括三个新模块与 CSS、app/index 和 popover；静态 stylesheet 正确引用且只加载一次。随后 Electron 通过离线 harness 直接服务这些包内前端文件，运行同一 243 项交互/布局检查，没有运行时注入 CSS。

另在独立 TEMP/TMP/TMPDIR 生成 PDF/Word/PNG fixture，`node tests/fixtures.mjs` 退出 0；`node tests/app-check.cjs --output-root <最终目录>` 退出 0，**26/26，失败0、跳过0**。app-check 是桌面内嵌后端/资源检查；与包内 renderer 检查分开报告，不将它独立称为完整 Electron UI 验收。未做安装/升级覆盖或真实模型联调。

## 8. 提交与回退

集成产品接线提交：`feec781bab71311cf3f1ebce14319f6f977ce983`；测试入口/基础设施提交：`fbda6d6429bfbf17da5e1308fcf7e00dd7e656fa`。报告与证据另行本地归档；包含本文的最终 HEAD 是归档提交（自指哈希无法写入自身内容），见最终交付消息与本分支 `git log -1`。未提交修改在交付前核查为 0。产品/测试完整变更路径见 [integration-files.txt](ui3-integration-evidence/integration-files.txt)，本报告及 `ui3-integration-evidence/` 为本次新增归档。

回退共享接线需协调 revert 测试接线与产品接线两个提交，避免保留依赖新接线的测试入口；回退 Agent 成果可按相反顺序 revert 对应 merge（需保留主线父提交），不 reset/clean 或修改原 A/B/C worktree。不需要迁移 Session Schema 或用户数据。证据可保留。

## 9. 未关闭项与结论边界

1. **真实 Windows 中文 IME 候选窗/上屏时序未手工验证**。已覆盖真实 Chromium 中的合成 composition 信号和受信普通键盘，不能替代真实输入法。
2. 无真实 Pi/模型、用户 PDF/Word、OS DPI/OS 主题、安装升级验证。所有写操作在夹具中；Runtime owner/readback 行为仍由既有 Runtime 回归检查。
3. 极低窗口高度、更大 zoom、完整真实项目长时使用超出此次矩阵；现有窄屏右栏 overlay 规则保留。

UI-3 的三套模块生产接线、真实数据/能力门禁、键盘防误发送、联合渲染与离线打包标准已通过本轮自动化检查，可交用户独立验收。**真实 Windows 中文 IME 人工验收尚未完成，因此不声称所有人工终验已通过。** 既有窄屏右栏覆盖规则及上述未验证范围已明确保留；没有发现必须扩大安全协议的需求。是否接受这些范围并进入后续阶段由用户决定，本轮不自行推进。

完成后停止，交用户验收；不自行进入 UI-4。
