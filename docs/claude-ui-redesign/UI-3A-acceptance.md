# UI-3A Classic Composer 与附件验收

日期：2026-10-17，Asia/Shanghai。工作区 `C:/pi-GUI-ui3-composer`，分支 `codex/ui3-composer`。共同基线 `d1524cb02f010cf9d474727c212f4048fc9abf75`。

**结论：Agent A 的实现、专项回归、真实 Electron 布局检查及隔离离线构建完成，可提交 UI-3 联合集成。** 本分支按文件所有权未接入新 CSS、未改 canonical test 脚本；独立启动源码或本轮包不会自动加载新样式。完整 UI-3 验收、真实中文输入法和组合后回归仍由后续集成完成。本轮未 push、未 merge main、未升级版本或发版。

## 1. 基线与隔离

开始检查原仓库及所有 worktree：原仓库在 `codex/ui-1-theme-shell` / `d0585b89a81c0a93e894d58b9d078af75aa985b2`，有原有未跟踪设计素材与构建目录。共同基线 d1524cb 在本地存在。指定目录和分支不存在，使用 `git worktree add -b codex/ui3-composer C:/pi-GUI-ui3-composer d1524cb02f010cf9d474727c212f4048fc9abf75` 创建。没有切换、重置、清理其他 worktree，没有覆盖原仓库未跟踪文件。

读取原仓库 AGENTS、机器约定、UI-0/1 设计与验收、UI-3 规划，以及基线已提交的 UI-2 集成验收。部分 UI-0/规划文档只存在于原仓库未跟踪文件，未复制进本分支或覆盖它们。实际代码为准；没有按照过时记忆假定图片能力门禁缺失。离线、零新增依赖，沿用本机已有 node_modules 的忽略目录 junction。没有 fetch、下载素材或安装依赖。

前测实际执行 `node tests/daily-use.cjs` 31/31、`node tests/model-capabilities.cjs` 34/34，退出码均 0。原始日志见 [baseline-daily.log](ui3a-evidence/baseline-daily.log)、[baseline-model.log](ui3a-evidence/baseline-model.log)。按本轮明确分工不运行完整 `npm test`。

参考原目录的 Claude 截图 `Snipaste_2026-10-15_22-32-06.png` 与 `Snipaste_2026-10-15_22-46-48.png`：采用中性输入表面、圆角外壳、正文与底部操作分层、紧凑辅助信息。不复制专有字体/组件，不新增截图中的 Bypass/Manual、终端等能力。截图的原始物理像素不直接视为 CSS 尺寸。

## 2. 实际修改文件

| 文件 | 变化 |
|---|---|
| `public/composer.js` | 复用 autoGrow、initComposerLayout 和唯一 `--composer-reserved-height`；宽度变化后重新计算换行；滚动条实际宽度用于输入框居中；高度增长仅对原本位于末尾的读者跟随；观察高度立即更新，宽度重排下一帧合并执行；发送禁用/停止状态仅镜像真实按钮与状态 |
| `public/attachments.js` | 保留现有类、缩略图、图标和处理流程；新增明确状态、aria-busy、独立文件大小与未知值区分；保留完整名称/路径及状态 title；重绘保留移除按钮焦点，删除移至相邻项，末项删除回到添加按钮 |
| `public/ui3-composer.css` | 全部规则限定 Composer；仅消费 UI-1 语义颜色/字体/间距/圆角/动效 Token；输入及底部栏、附件卡、警告/失败/解析状态、拖入/焦点/禁用/reduced-motion；附件托盘最大 min(160px,18vh)，窄屏操作组先保留附件按钮再内部换行 |
| `tests/ui3-composer.cjs` | 生产模块单元夹具；`--electron` 运行生产 app/DOM/模块/CSS/preload/Browser controller，临时用户目录及离线接口；真实截图与几何/键盘断言 |
| `docs/claude-ui-redesign/UI-3A-acceptance.md`、`ui3a-evidence/` | 本报告、测试日志、截图、JSON 几何事实和构建审计 |

没有修改 app.js、index.html、styles.css、tokens.css、rpc.js、palette、Runtime、package.json、server、electron 或既有测试断言。只观察 Composer 外层高度；输入/滚动事件复用同一个下一帧同步器，没有第二套底部高度计算机制。

## 3. 业务和数据边界

`imageInputBlocked()`、`renderModelControls()`、`handleFiles()`、`removeAttachment()`、`FILE_BLOCK_RE`、`buildMessage()`、`attachmentImages()` 与基线对应代码块逐字一致，归一化 CRLF 后 SHA-256 结果见 [source-audit.json](ui3a-evidence/source-audit.json)。发送 guard 条件完整保留，新增代码只在判定后镜像 `button.disabled`；没有引入额外“允许发送”的分支，也没有改变 loading/error 附件原有发送政策。

附件状态由现有数据确定，优先级为 loading → error → 图片能力 blocked/ready → 文本 truncated/ready → unreadable。二进制/未知解析结果继续明确“pi 读不了”，失败内容不显示已就绪；图片能力 unknown 不冒充 false。显示 `size=0`，缺失或非法大小隐藏。真实文件大小集中在独立一行，不在图片/二进制说明里重复。文件名、路径和错误以 textContent/title 展示，未注入 HTML。

布局不重建 textarea，不改草稿，不触碰 submit/stop 或 Shift+Enter/IME 原监听。autoGrow 原有 184px / 24vh 上限保留。托盘滚动使多附件不会无限占据聊天；长文件名显示省略但保留完整 title。没有声称增加新的上传进度百分比、模型能力或文件解析能力。

## 4. CSS 与 DOM 契约

新增类完整列表：

- `.ui3-composer`：原 `.composer` 上的组件标记。
- `.ui3-composer-stopping`：原 `.composer-box` 上，镜像真实 stopping。
- `.ui3-attachment-tray`：保留原 `.attach-tray`。
- `.ui3-attachment-card`：保留原 `.att`、`.loading`、`.err`。
- `.ui3-attachment-size`：真实文件大小，未知隐藏。
- `.ui3-attachment-remove`：保留原 `.att-x`，原生 button 键盘行为。

新增属性：composer-box 的 `data-send-disabled="true|false"`；附件卡 `data-state="loading|error|blocked|ready|truncated|unreadable"`、`aria-busy`；移除按钮 `data-attachment-id` 用于焦点认领。

新增 `--ui3-composer-scrollbar-width` 是实际测量的布局量，不是新的设计 Token。唯一高度来源仍为 `--composer-reserved-height`。现有 composer-box/input/attachTray/composer-bar/cb-left/cb-right/模型/Thinking/上下文/发送/停止 ID 和基础类保持，未改模型控制内部结构。

## 5. 自动化结果

最终每个下列命令的退出码均为 **0**，失败 **0**，跳过 **0**。受影响旧套件断言数量没有减少。结果与日志见 [test-results.json](ui3a-evidence/test-results.json)，Electron 完整事实见 [electron.json](ui3a-evidence/electron.json)。

| 实际命令 | 通过 / 执行 |
|---|---:|
| `node tests/ui3-composer.cjs` | 34/34 |
| `node tests/ui3-composer.cjs --electron` | 182/182 |
| `node tests/smoke.cjs`（即 `npm run test:ui`） | 1338/1338 |
| `node tests/daily-use.cjs` | 31/31 |
| `node tests/model-capabilities.cjs` | 34/34 |
| `node tests/body-integrity.cjs`（即 `npm run test:body`） | 5/5 |
| `node tests/usage-quota.cjs`（即 `npm run test:quota`） | 229/229 |
| `node tests/stop-barrier.cjs` | 16/16 cases |
| `node tests/ui2-classic.cjs` | 48/48 |

新套件先在旧代码产生 14/29、15 失败，再实现；后续补足上传实际生命周期、文件 0/未知等覆盖，最终为 34/34。单元包括各发送屏障、图片 false/true/unknown、上传文件对象未变、解析中/提取错误/截断、长路径、XSS、大小、删除与异步重绘焦点、线格式不变、自动增长/收缩/resize。

实际修复过程保留失败证据：

- 首轮 Electron 124/125：ResizeObserver undelivered notifications；重排移到下一帧修复。[原日志](ui3a-evidence/electron-before-observer-fix.log)。
- 原 smoke 曾 1336/1338：异步留白影响旧同步契约，恢复即时高度预留；另一次 1337/1338 暴露观察目标必须仅 Composer，恢复单目标，滚动条同步改为复用输入/滚动事件。没有修改旧断言。[同步前日志](ui3a-evidence/smoke-before-sync-fix.log)、[单目标前日志](ui3a-evidence/smoke-before-single-target-fix.log)。最终 1338/1338。
- 加强短窗口末条消息检查后曾 180/182：400 CSS px 高、150% zoom、侧栏展开、多附件和十行输入下末条文字几乎被顶栏裁掉。收紧托盘并让操作组内部换行，最终同一判据通过。[失败几何](ui3a-evidence/electron-before-short-window-fix.json)。

## 6. 真实 Electron 截图与视觉结论

目录：[ui3a-evidence](ui3a-evidence/)，最终 **59 张 PNG**。这是本分支真实 Electron capturePage，生产模块和样式，未沿用其他 Agent 截图。夹具显式加载本轮 CSS；sandbox:true、contextIsolation:true、nodeIntegration:false，无 --no-sandbox。版本及逐场景 CSS 几何、pane 状态、控件位置、截图名均在 electron.json；最终 renderer/harness errors=[]。

- Dark/Light × 700/900/1200/1536 CSS px × 侧栏展开/折叠 × closed/Changes/Browser = 48 场景，每一场核对真实右栏状态。右栏使用现有生产入口、外壳和 Browser controller；没有访问外部页面或真实模型。
- Dark/Light × 80%/125%/150% 应用 zoom，原生内容窗口 900×600：6 场景；实际 CSS 视口随 zoom 改变（150% 是 600×400）。缩放/尺寸改变后定位至对话末尾检查布局，不将此测试解释为任意缩放过程的滚动锚点恢复证明。
- 5 场补充截图：single-line、ten-lines、stopping-focus、image-unsupported、reduced-motion。
- 真实连续布局检查：单行→十行、长英文无空格、长中文、正文增长留白；末尾读者输入增高时末条仍在输入框上方，上滚读者不被强拉到底。实际 Shift+Enter 换行；Space 移除附件并保留焦点。reduced-motion 通过媒体仿真核对实际 transition/spinner。

代表图：[700 Dark](ui3a-evidence/dark-700-sidebar-true-closed.png)、[1536 Light + Browser](ui3a-evidence/light-1536-sidebar-false-browser.png)、[150% Light 短窗口](ui3a-evidence/light-zoom-1.5-short-window.png)、[不支持图片](ui3a-evidence/image-unsupported.png)。人工查看窄窗、浅色右栏和 150% 短窗：输入与消息同轴，无横向页面溢出，长名称省略，多附件在托盘内滚动，辅助说明颜色区分真实状态，末条文字与主要操作可见。

既有右栏在窄屏会采用 overlay，可能覆盖聊天/输入区；这属于原壳行为，不以隐藏右栏、删除入口或改权限解决。矩阵记录 mode，不能把被 overlay 覆盖的 Composer 算作可点击证明；关闭右栏的对应场景另外验证输入完整可用。原生 Windows 标题栏、OS DPI 与 OS 主题切换不在此次 Composer capturePage 证据范围。没有改变 UI-2 已归档的标题栏结论。

独立只读代码审查未发现阻塞缺陷，确认发送/能力/附件协议、焦点、单一高度来源以及最终 150% 浅色截图；同样指出真实 IME 与 CSS 接入仍须单列。

## 7. 离线构建与产物

实际执行 `node scripts/build-app.mjs --rebuild --output-root <隔离临时目录>`，使用本机已缓存 Electron ZIP 的 PI_GUI_ELECTRON_ZIP_DIR；退出 **0**，没有联网、安装依赖或覆盖用户正在使用的安装目录。具体路径见 [build-root.txt](ui3a-evidence/build-root.txt)，输出见 [build.log](ui3a-evidence/build.log)。日志显示整包约 328.1 MB、入口约 234.9 MB。

先用独立 TEMP/TMP/TMPDIR 运行 `node tests/fixtures.mjs`，生成临时 PNG/PDF/Word 并验证抽取，退出 0；然后 `node tests/app-check.cjs --output-root <同一构建目录>`，退出 **0，26/26，失败0、跳过0**。首次缺少测试 PDF 夹具为 19/21，后续隔离生成夹具后修复环境；未通过修改断言绕过。[初次缺夹具日志](ui3a-evidence/app-check-before-fixtures.log)、[夹具生成](ui3a-evidence/fixtures.log)、[最终 app-check](ui3a-evidence/app-check.log)。

最终 `composer.js`、`attachments.js`、`ui3-composer.css` 源码与 resources/app/public 中文件 SHA-256 三项一致，见 source-audit.json。app-check 是桌面包内嵌后端/资源检查，不是打包后的完整 UI 联合验收。CSS 被收进包，但遵守所有权未在 index 引用；实际 UI 渲染证据来自显式注入该 CSS 的 Electron 夹具。

## 8. 提交、集成、回退与限制

代码与新测试提交：**`b1b795ec85c82e4e6341e41b921af006a115d580`**（`改进 Classic 输入区布局、附件状态与键盘焦点`）。验收报告与全部证据另作归档提交；包含本文的最终 HEAD 是归档提交，自引用 SHA 不写进该提交自身，见交付对话与 `git log -1`。交付前核对本分支无未提交修改。与共同基线相比仅上表四个代码/测试文件及本任务报告/证据，没有其他 Agent 文件或共享入口修改。

集成需要由集成者修改共享 `public/index.html`，在现有样式后加载 `/ui3-composer.css`；把 `node tests/ui3-composer.cjs` 接入 package.json 的 canonical test 链，Electron 专项按集成测试入口运行。本轮未擅自接入。与 UI-3B/C 组合时复核底部模型/Thinking/内联菜单的宽度、弹层定位与 Tab 顺序，再运行完整 npm test 和组合后的 Electron 矩阵。

可按回滚边界 revert 上述代码提交；集成后同时移除 stylesheet 引用和 canonical 测试接入。正文/图片格式及 Session Schema 未迁移，回退不需要处理用户数据。验收文档与证据可保留。没有 reset --hard、clean、push、merge main、tag、版本升级或发版。

已知限制：

1. 真实中文输入法候选窗、真实系统 DPI、真实 Pi/模型、实际 PDF/Word 用户文件未操作；单元和 Electron 仅临时/离线 fixture。
2. 长名称和长状态单行省略，完整值通过 title 保留；多附件需要托盘滚动。极低高度或更大 zoom 超出本次矩阵，仍须独立评估。
3. 右栏窄屏 overlay 继续沿用现有规则；完整组合后菜单、模型控件与附件的交叉体验留给 UI-3 集成。
4. 本分支自身未加载新 CSS；这是一份可集成的 Agent A 成果，不能单独宣称整个 UI-3 或正式安装版已经改造完毕。

完成后停止，等待独立验收。
