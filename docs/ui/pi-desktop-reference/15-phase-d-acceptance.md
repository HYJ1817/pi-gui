# 阶段 D：对话流与 Composer 验收记录

## 身份与边界

分支 `codex/pi-desktop-phase-d`，基线 `5214c4368d740e41bb7dc6adb9c7e889ee55c1c2`：main 阶段 C 加 PR #51 的测试修复。开始实施时 #51 已通过 [完整 PR CI](https://github.com/HYJ1817/pi-gui/actions/runs/41826807584)，尚未合并；本阶段不擅自合并该 PR。D 的代码和证据按文件 SHA-256 绑定，不把该基线 CI 声称为 D 的成功 CI。

固定参考版本：`vastsa/PI-Desktop@92ae661f1e399e69d514086b46029b4c34ba1a92`，原始 PNG 位于 `C:/Users/21022/OneDrive/图片/pi-desktop`。勘察与组件对应见 [14-phase-d-implementation.md](14-phase-d-implementation.md)。本轮只实施 D，没有改 Pi RPC、后端、存储、原生会话架构、依赖或 A/B/C 的业务模块，没有提前开展 E/F。

基线 CI 身份已复核：run `41826807584`，event `pull_request`，attempt `1`，head `5214c4368d740e41bb7dc6adb9c7e889ee55c1c2`，状态 `completed/success`；它只作为开发前的基线证明。

用户明确要求不使用子代理，本轮没有调用子代理；由作者自查和实际自动化提供证据。**独立 Agent 审查未运行，不能将作者自查写成独立审查或用户验收。**

## 修改文件与职责

| 文件 | 职责 |
| --- | --- |
| `public/messages.js`、`public/runtime-conversation.js` | 在原渲染路径接入只读复制；Runtime 发送/停止补静态图标与可访问标签，原按钮和 handler 保留 |
| `public/ui/message-actions.js` | 新增共享叶模块，仅处理剪贴板与可见成功/失败反馈；不引入状态副本或会话写入 |
| `public/styles.css`、`public/runtime-conversation.css` | 原消息和 Runtime 组件范围内的宽度、排版、气泡、代码、动作、滚动及菜单外观；Specs/更新说明共用的基础正文规则保留，D 覆盖限定在 `#stream` / `#runtimeView` |
| `public/ui3-composer.css`、`public/ui3-model.css`、`public/ui3-inline-commands.css` | 改既有组件表面与令牌消费，不重复创建输入或菜单 |
| `public/ui/popover.js` | 补齐触发按钮焦点下的 Escape 关闭；继续使用唯一共享浮层 |
| `tests/ui2-classic.cjs`、`tests/ui3-model.cjs`、`tests/ui2-runtime-display.cjs` | 实际模块复制、键盘与注入回归，均属于原 canonical 套件 |
| `tests/ui2-visual.cjs` | 保留 57 个真实浏览器检查，修订五项过时视觉参数 |
| `tests/app-shell-electron.cjs`、`tests/conversation-electron.cjs`、`tests/fixtures/conversation-scenarios.cjs` | 复用正常沙箱验收工具，新 D 场景作为独立 Electron 专项；保留 A/B/C 场景 |
| `package.json` | 注册 `test:conversation:electron` 专项，不改依赖或 canonical 命令集合 |
| `docs/composer-ui.md`、`docs/conversation-ui.md`、本目录 08/README/14/15、截图与结构化证据 | 当前行为、源码依据、实际差异、失败与验证记录 |

最终行为及测试文件逐项摘要见 [validated-source-sha256.json](../screenshots/phase-d/validated-source-sha256.json)，不将文档后续提交误算成新的行为验证。

## 逐区域参考与实际结果

表中参考源码均位于 `apps/desktop/src/`：CSS 在 `styles/`；`MessageRow`、`AssistantTurn`、`ActivityGroup`、`TurnUsageCapsule` 在 `features/chat/transcript/`；`ComposerToolbar`、`ComposerModelPicker`、`ComposerModelList`、`ThinkingLevelSlider` 在 `features/chat/composer/`；`Composer`、`ComposerAutocomplete`、`ContextUsageInspector` 在 `components/`；`useSessionTiming.ts` 在 `features/chat/context-usage/`。pi-GUI 的实现路径以 `public/` 为根。

| 区域 / 截图 | PI-Desktop 固定源码 | pi-GUI 实现 | 原差异、方案与修改后的实测 |
| --- | --- | --- | --- |
| 正文 REF-016/017/021 | `styles/chat-shell.css`、`styles/prose.css`、`AssistantTurn.tsx` | `styles.css`、`runtime-conversation.css` | **达到核心参数**：760px 内容带，内距 32px，实际正文 696px；正文 14px / 22.4px 行高，透明、无外框；保留已存在的 Markdown/工具/用量路径，没有重复实现透明正文 |
| 用户气泡 REF-017/021 | `styles/chat-shell.css:14`、`styles/messages.css`、`MessageRow.tsx` | 两个既有消息渲染器、`ui/message-actions.js` | **达到核心参数**：82%/600px 上限，10/15px 内距，18px 圆角、右下角 8px，8% 中性表面；短提示实测宽 156px，不铺满。复制动作在 hover/focus 显示；Classic 实时/历史、Runtime 历史均复制原始文本，原生剪贴板读回通过 |
| 浮动 Composer REF-001/015/016/021 | `composer.css`、`composer-menus.css`、`theme-overrides.css`、`ComposerToolbar.tsx` | `ui3-composer.css`、Runtime 既有 Composer | **达到核心参数**：760px 宽、20px 圆角、0px 外框、A 阶段 composer 阴影、28px 圆形发送/停止；Classic 初始高度 110px、底边距约 16px。最终移除有效级联并不使用的焦点加深阴影；保留原自动增高、停止确认及 Runtime 草稿 |
| 滚动边界 REF-017/021 | `chat-shell.css:229` | `#stream`、既有 `composer.js` 测量 | **达到结构效果**：按真实 `--composer-reserved-height` 留白，渐隐开始为预留区前 16px，结束为区内 2px；末条消息能滚到浮层上方，正文和多行输入各自滚动，没有页面横向溢出 |
| 模型菜单 REF-015 | `ComposerModelPicker.tsx`、`ComposerModelList.tsx`、`ThinkingLevelSlider.tsx`、`composer-menus.css` | `ui3-model.css`、`runtime-picker.js` 原控制器及其既有样式 | **表面接近，存在业务与视觉差异**：20px 外圆角、5px 内距、原模型阴影、搜索与分组保留；Classic 保留 320px 菜单和额外 Provider 身份，Runtime 保留其模型所属信息。思考档位仍独立选择，不把参考滑块强加到 Pi 原生档位三态上；未复制玻璃模糊效果，不宣称菜单完全一致 |
| Thinking / 状态 REF-016/017 | `AssistantTurn.tsx`、`ActivityGroup.tsx`、`TurnUsageCapsule.tsx` | `messages.js`、`runtime-display.js`、Runtime 原展示投影 | **合理业务差异**：沿用现有默认折叠、实时字数、失败/中断、真实 usage。Pi 没有对应的完整计时数据，不伪造“运行完成 · 3s”或 tokens/s；Runtime 历史没有 Thinking/usage 时不补假内容 |
| 命令菜单 REF-022 | `ComposerAutocomplete.tsx`、`composer-autocomplete.css` | 唯一 `ui/inline-command-menu.js` 与 `ui3-inline-commands.css` | **表面与焦点达到要求**：语义面、20px 外圆角、模型菜单阴影；输入焦点、IME 守卫、上下键、Enter/Escape 与现有命令来源保持。菜单项目和分组因 pi-GUI 功能不同，不硬编码参考命令 |
| 用量浮层 REF-023 | `ContextUsageInspector.tsx`、`useSessionTiming.ts` | 原 `usage.js` 与唯一 `ui/popover.js` | **合理业务差异**：沿用真实上下文/累计/最近一轮/额度；环仍表达“已用”而非参考的“剩余”，文案与数值一致。扩大统计层级，修复触发按钮保留焦点时 Escape 不关闭的问题；无耗时瀑布的真实来源，未添加第二个 inspector |
| 附件 REF-024 的相关输入区 | `Composer.tsx`、`ComposerAutocomplete.tsx` | 既有 `attachments.js` / 附件托盘 | **保留业务**：真实附件卡片、删除、状态及输入增高继续可用。本轮没有把普通附件伪装成未实现的 `@` 原子文件引用；不宣称 REF-024 完整还原 |
| A/B/C 回归 | REF-001/002/004/005/007/020 | 原设置、Shell、Sidebar 和菜单 | **实测通过**：原 26 项正常沙箱外壳检查保留；设置、深浅主题、折叠、右键、稳定顺序、原生顶栏及菜单边界未因 D 删除或重建 |

细微差异保留：原“Pi/助手”角色标签、工具时间线和实际用量文案；Runtime 的生命周期工具条、只读提示与手动调整输入高度；Classic 可 steer 时保留发送入口，Runtime 运行时保留禁用发送与可用 Stop。它们对应真实能力，未为截图删除。系统字体回退与具体内容换行没有按字符宣称逐像素一致。

顶部留白存在结构与视觉差异：参考 `chat-shell.css:413–419` 为绝对定位顶栏预留 46px，消息行另有内距；pi-GUI 的 46px 顶栏已在正常布局中占位，线程采用基础 20px 顶距（D 实测首条气泡 y≈66px）。没有叠加第二份标题栏预留，也未改变原滚动 owner；首条消息与参考截图不逐像素同位，不计入“位置完全一致”。这不影响上方核心宽度、控件参数或末条消息可见性结论。

## 实际截图与尺度

[results.json](../screenshots/phase-d/results.json) 包含 **47/47** 正常沙箱检查、**33 张渲染截图 + 2 张原生整窗截图**。Electron 44.4.3，`sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`；D 场景 CSS 视口 1205×803，实测 DPR 1.5，渲染 PNG 1808×1205。D 窄窗 CSS 视口 700×600，对应 1050×900。沿用的 C 回归图 01–07 为 1206×803 / 1809×1205，08 为 700×650 / 1050×975，设置等其余图为 1205×803；以各张 geometry 为准。两张原生整窗图为 1810×1205，含 DWM 外框，不能与网页捕获混算尺寸。

原始参考 PNG 的大小、pHYs、SHA-256 与本轮尺度见 [reference-calibration.json](../screenshots/phase-d/reference-calibration.json)。元数据与已提供的 1.5 DPR 校准条件一致，不冒称独立探测了参考应用的系统设置。

| 实际图片 | 场景与对照 |
| --- | --- |
| [d01](../screenshots/phase-d/d01-dark-completed.png)、[d08](../screenshots/phase-d/d08-light-completed.png) | 深/浅对话完成，REF-017/021 |
| [d02](../screenshots/phase-d/d02-user-actions.png)、[d03](../screenshots/phase-d/d03-thinking-expanded.png) | 原始文本复制与 Thinking 展开，REF-017 |
| [d04](../screenshots/phase-d/d04-model-picker-dark.png)、[d05](../screenshots/phase-d/d05-thinking-picker.png) | 模型菜单与真实档位，REF-015 |
| [d06](../screenshots/phase-d/d06-context-dark.png)、[d19](../screenshots/phase-d/d19-context-light.png) | 用量浮层，REF-023；深色按同一语义规范核对，不冒称存在同场景原始深色截图 |
| [d07](../screenshots/phase-d/d07-streaming-dark.png) | 流式正文、Thinking 与 Stop，REF-016 |
| [d09](../screenshots/phase-d/d09-slash-light.png) | 命令补全与保留焦点，REF-022 |
| [d10](../screenshots/phase-d/d10-multiline-light.png)、[d11](../screenshots/phase-d/d11-narrow-light.png)、[d12](../screenshots/phase-d/d12-model-narrow-light.png) | 多行输入、700px 窄窗、菜单边界 |
| [d13](../screenshots/phase-d/d13-runtime-running-dark.png)、[d14](../screenshots/phase-d/d14-runtime-model-dark.png)、[d15](../screenshots/phase-d/d15-runtime-light.png) | Runtime 实时与模型菜单 |
| [d16](../screenshots/phase-d/d16-attachment-dark.png)、[d17](../screenshots/phase-d/d17-runtime-narrow-light.png)、[d18](../screenshots/phase-d/d18-runtime-history-light.png) | 附件、Runtime 窄窗、只读历史与复制 |
| [09-settings](../screenshots/phase-d/09-settings-overview-dark.png)、[12-settings](../screenshots/phase-d/12-settings-appearance-light.png) | A/B 设置回归；其余 C 场景保留在同目录 |

这些截图由实际生产 renderer/CSS/preload 在 Electron 内运行并采集，不是静态重绘。测试使用 TEMP 项目与离线协议 fixture；截图和通过数字不证明真实模型、外部供应商或长期负载资格。

## 自动化与失败历史

| 命令 / 证据 | 实际结果 |
| --- | --- |
| `node tests/ui2-classic.cjs` | 55/55（原 49，新增复制与纯图片边界 6） |
| `node tests/ui3-model.cjs` | 54/54（原 53，新增触发按钮 Escape 1） |
| `node tests/ui2-runtime-display.cjs` | 83/83（原 82，增加 SVG 注入载荷断言 1；原防护保留） |
| `node tests/ui3-composer.cjs` | 34/34 |
| `node tests/runtime-conversation.cjs` | 106/106 |
| `node tests/ui2-visual.cjs` | 57/57；五项旧视觉参数按固定源码修订，未删除断言 |
| `npm run test:conversation:electron` | 47/47，正常沙箱；包含原 A/B/C 26 项 |
| `npm run test:ui3` | 243/243，0 跳过，正常沙箱；最终作用域补验图片在 `.shots/phase-d-ui3-scoped-final-20261105`，原始结果副本见 [ui3-integration-results.json](../screenshots/phase-d/ui3-integration-results.json) |
| `node tests/session-background-electron.cjs` | 16/16；沿用该专项的 `--no-sandbox`，不能代替上方正常沙箱证明；见 [并行专项记录](../screenshots/phase-d-background/report.json) |
| canonical 234 条命令 | 累计 234/234 唯一命令退出 0，完整有序清单与日志摘要已核验；环境跳过如下，不计入通过断言。见 [canonical-results.json](../screenshots/phase-d/canonical-results.json) |

完整入口首次执行约 1472.34 秒，前 95 条通过，在第 96 条 `ui2-runtime-display.cjs` 的旧“整个视图不能有 SVG”断言失败。新发送/停止图标是静态 SVG，不是输出注入。修订后只允许这两个明确所属的静态图标，给不可信正文/Thinking/工具/审批加入 `<svg onload>` 载荷，验证仍保持文本且没有新增节点；定向 83/83 后从第 96 条续跑同一 canonical 清单。最终 234 条唯一命令全部退出 0，顺序及计划摘要 `617b6ca0abdaf1cc7b1a16e3fcae1b0414b126254bf74fcf02fc514a4f2edf4c` 与当前 `package.json` 展开结果一致；原始总日志和每个续跑日志的 SHA-256 均已核对。结论是累计验证，不能写成单次 `npm test` 成功。

环境跳过仍为未验证：Collab store、Candidate adoption、logging-leaks 各 1 项符号链接检查，`session-search.cjs` 的 5i 符号链接检查；SACL witness 8 项、in-place 非空 SACL 2 项、Object witness 8 项因现有 token 缺少 `SeSecurityPrivilege` 未执行。两个 witness 均为 0/0，通过断言不含这些跳过，不代表取得原生审计资格。测试子进程仅局部设置 `PSExecutionPolicyPreference=Bypass`，未提升权限或更改系统策略。

续跑断点均保留：第 114 条因工具会话重置只留下 `running`、实际进程已不存在，未计通过，保留中断记录后重跑；第 124 条发现作者写 CSS 时产生 CRLF，导致既有设置源码断言失败。恢复仓库原 LF 后原测试 15/15，未改设置断言，并从该条继续；这些失败不是产品设置功能通过的替代证据。

其他失败与修复均未隐藏：

1. 复制回归先为 49/54，再实现共享动作后 54/54；Popover 新 Escape 回归为 53/54，修复同一系统后 54/54。
2. 初轮 Electron 的字符串转义、隐藏旧 Runtime DOM 定位和历史 API fixture 路由错误均留有失败记录；只修测试夹具，最终分别定位实际生产节点与真实 `/api/runtime-sessions?conversationId=` 路由。
3. 剪贴板探针最初把 Electron 44 的异步 API 当成同步 API，导致错误判失败；核对本机 `electron.d.ts`，补 `await` 后同时验证浏览器和原生读回，未改生产复制逻辑。
4. 旧视觉检查初次 52/57：15px/1.8 正文、16px 气泡内距、76% 宽度、8px 有描边代码框和 Runtime 旧字号与 D 设计冲突。五项全部改为固定源码证实的参数，最终 57/57，没有减断言。
5. 中性链接新 Electron 检查先为 46/47；移除旧蓝色链接并采用源码下划线参数后 47/47。逐个复核有效 CSS 级联和 token 值，最终为 18/8px 气泡与 15px 内距；文中不再沿用早期 18px 四角、14px 内距假设。
6. 作者末次边界自查发现纯图片消息会出现复制空文本入口；新增真实消息渲染回归为 54/55。共享动作模块在无文本时不提供该入口后 55/55，并补跑 Runtime 106/106、展示投影 83/83 及真实 Electron 47/47；没有更改图片或消息数据。
7. 最终作用域审查发现 `.msg-body` 也供 Specs 与更新说明使用。恢复其共享基础排版规则，将 D 的标题/代码/链接参数限定在 `#stream` / `#runtimeView`；未改工作台业务。随后再次视觉 57/57、UI3 正常沙箱 243/243、D Electron 47/47（刷新全部截图）、A/B 设置 15/15，并重建新的独立产物。

最终状态的证明按影响组合：纯图片复制保护由 55/55、106/106、83/83 和再次 Electron 47/47 补证；最终限定作用域的视觉参数由 Electron 47/47、旧视觉 57/57、模型/命令等既有集成 243/243 与原设置测试 15/15 覆盖。最终专项日志摘要见 [supplementary-verification.json](../screenshots/phase-d/supplementary-verification.json)。其余未受影响的 canonical 命令复用本轮实际通过记录。运行期间的源码收敛与测试修订均可定位，不冒称某个最终 SHA 下单次、完全不变状态的 `npm test` 成功。

定向基线九套件均退出 0。原始日志保存在 TEMP 的 `pi-gui-phase-d-718da565091f4d8ab660e7a1c67ef65c`；UI3 集成测试原本会重写历史截图目录，已先归档本轮结果，再还原已跟踪的历史证据，未混入旧报告的大量图片更新。

## 构建、审查与交付状态

最终产物：`C:/pi-GUI/.shots/phase-d-scoped-final-output-20261105/dist-app/Pi GUI-win32-x64/Pi GUI.exe`。使用本机缓存 Electron 44.4.3，缓存 ZIP 内 exe 与已安装 exe 的 SHA-256 均为 `bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`；未下载依赖。入口 234.9 MB，整包 329.3 MB。9 个修改的生产文件与当前源码逐字节 SHA-256 核对全部一致，见 [build-verification.json](../screenshots/phase-d/build-verification.json)；源码 Electron 验收与打包副本核对是两种证据，不冒称完成安装升级验收。重复使用旧的独立输出目录时，构建脚本按设计拒绝非空目标；保留该守卫，改用新目录完成重建，没有删除既有交付产物。

作者自查范围为全部生产增量、测试、安全文本处理、草稿/会话 owner 调用边界；目前未发现未处理的阻断问题。独立审查按用户要求未运行；人工验收、推送、合并及发布均未发生。未验证：macOS/Linux、真实操作系统 IME、真实模型长负载、安装/升级链路。现有 UI3 的合成 composition 检查不能代替真实 IME。

作者自查风险为中（前端视觉、只读复制及键盘交互），未解决发现：Blocker 0 / Important 0；独立审查结论仍为未验证。阶段 D 开发及本地验证完成，等待用户验收；本报告不授予合并或发布资格。

本地提交边界：`c218d9e` 为生产与匹配的功能断言，`18f7735` 为 Electron 专项工具，文档/证据独立提交。回退行为可按 `git revert 18f7735 c218d9e` 撤销后重建产物，证据可以单独保留。没有数据迁移，不改用户会话文件。最终文档提交可通过 `git log -1 --format=%H -- docs/ui/pi-desktop-reference/15-phase-d-acceptance.md` 定位，最终答复另列实际 SHA。

后续 E 应继续沿用现有右侧 work surface 与 owner，不另建消息/模型/菜单状态；F 再统一剩余全局视觉差异。D 不把运行视图聚合文本改造成另一套消息存储，也没有预先重构工作台。
