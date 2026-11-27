# Visual Replies P2 · C2 消费端验收材料

日期：2026-11-27。本文是 **C2 作者自验与交接**，不替代独立复审、完整 canonical、A 安全验收或用户批准。

## 1. 身份、范围与勘察结论

- 工作树：`C:/Users/21022/.t3/worktrees/pi-GUI/t3-42a3f710-a8d3a837c8d7e7ac`；分支 `feat/visual-replies-p2-c`。
- before HEAD：`1d4bec0d607c8d1039c543d3f75f66d2e1eda573`。接手时 viewer/dialog/interactions 另有约 +62/-12 的未提交半成品，不能当作已验收实现。未重启原 C 代理。
- 产品提交：`393324644c8b419dab9811702d13961c3f4ecea7`。
- 测试提交：`1ba42ed02fbd09717d4d3f8bed313b9ce5ed287c`。
- 本文交付提交：首次交付后用 `git log -1 --format=%H -- docs/visual-replies-p2-c-acceptance.md` 解析；准确 SHA 同时见交接消息。本文之后的修改不得据此继承本次验证。
- 实际验证不是 C 分支旧 D 实现的单树证明：在唯一 TEMP 中固定集成树 **`e02828f7a178264129a3917d6e2701459657458c`（含 D2）**，再覆盖 C2 的消费端与专属测试。产品/测试提交后摘要核对一致，没有用后来推进的集成 HEAD 替换被测身份。
- 阅读了 AGENTS、REVIEW、文档导航及相关 UI、测试政策、安全、编码、证据文档，以及集成计划与 D2 验收材料。依用户明确的离线范围，没有 fetch、访问外网、下载依赖或查询远端 CI。计划所记基线 CI `45952490979` / push / attempt 1 / `dfdc1ddea060d8c369e5e0932d052655baa3d772` 仅作既有文档记录，不冒称本轮重新核验或 P2 证明。

### 既有抽象与半成品处置

既有实现已将 viewer 的资源/身份、dialog 的几何/焦点、controls 的公共按钮及 interactions 的宿主动作拆开；D2 layout 还负责 100ms 限流和可见性，reading-position 负责宿主阅读锚点。继续复用这些边界，不新增第二套挂载、缩放或高度调度器。

半成品的 feedback 门控方向可保留，但仅有异步展开准备不足以满足协议：必须同时有 viewer 对匹配 ACK 的消费、过期处理、关闭后的恢复等待和取消路径。接手时原 20 项 UI 测试实际为 **17 pass / 3 fail / skip 0，145 次已到达断言，exit 1，3852.2951ms**；三处失败分别是展开、兄弟 dialog、展开尺寸，不能信任为完成证据。最终替换了不完整的准备协调，保留原地 native dialog、同 iframe 和原有缩放实现。

本次不照搬 T3 的第二 iframe 弹窗，也不以 65536px 上限充当 RD-2 修复；原因分别是当前产品的同 realm/表单状态约束与已证实的反馈增长链。没有改 CSS/controls：页面已加载 tokens.css、ui/primitives.css、html-artifact.css，既有公共图标按钮、token、原生 dialog 与布局适用，不需要平行样式。

### 实际修改

| 文件 | 用途 |
| --- | --- |
| [html-artifact-viewer.js](../public/html-artifact-viewer.js) | presentation 序号、pending/deadline、严格匹配 ACK、生命周期清理 |
| [html-artifact-dialog.js](../public/html-artifact-dialog.js) | 已接受高度、等待保存再展开、先收回几何再恢复、阻止恢复中重开 |
| [html-artifact-interactions.js](../public/html-artifact-interactions.js) | feedback/六字段 ACK 校验；图片与链接取消待展开 |
| [html-artifact-ui.cjs](../tests/html-artifact-ui.cjs) | 保留旧测试、适配异步协议，增加六项消费者回归 |
| [html-artifact-viewer-electron.cjs](../tests/html-artifact-viewer-electron.cjs) | 12000px、真实滚动往返、反馈保持、ACK 丢弃与完整运行身份 |
| 本文 | T3 源码对照、证据、失败历史、限制与交接 |

没有修改 D 的 frame/theme/activity/measure/layout/runtime/scroll/reading-position，或 messages.js、后端、package/CI、Electron 主进程、A/A2 文件。没有新增依赖。风险按 REVIEW **高**处理：涉及跨 iframe 协议与恢复时序；未扩大 iframe 权限，但仍需父任务安排独立功能与故障/安全边界复审。

## 2. RD-2 / RD-3 的实现语义

### RD-2：raw telemetry 不再绕过 feedback hold

- `resize.feedback === false` 才允许用有界 `naturalHeight` 更新展开高度；仍保留 80..65536px 的分配上限。
- `feedback === true` 时保留已接受的 `expandedHeight`，即使 raw naturalHeight 继续变化也不改变展开高度。
- 缺字段是旧 v1，只采用 `height`；不是默认批准 raw naturalHeight。非 boolean feedback 被拒绝。
- 几何函数读取 `expandedHeight`，不再直接读取 raw naturalHeight。初次展开以当前已接受快照初始化；D2 的 100ms 限流仍是唯一 host resize 调度。
- 上限只是资源边界；真正修复证据是反馈期间高度不再跟随 raw 值增长，而非最终碰到上限。

### RD-3：保存确认先于几何变化

严格沿用 D2，不另起协议。`presentation` / `presentation-ready` 都只有六个自有字段：`schemaVersion/id/nonce/type/expanded/sequence`；schemaVersion=1，expanded 为 boolean，sequence 为正安全整数且请求严格递增。ACK 还须经过既有 source、opaque origin、id、nonce 校验，并匹配当前 pending 的 expanded/sequence。

1. 点击展开只进入 opening，发送 true；**收到当前有效 true ACK 前，不 showModal、不改宽高或占位几何**。D2 在自己的 realm 同步保存 scrollX/Y 后回 ACK。
2. 通过 ACK 才把原先已在 DOM 中的同一个 dialog 提升到 native top layer。没有移动/重建 iframe，没有第二份 HTML，没有重载。
3. 关闭先同步恢复 inline 几何，再发送更大序号的 false。D2 使用预先捕获的双原生 rAF 在自身 realm 恢复内部滚动，再回 ACK。
4. false ACK 未完成时禁止新展开，避免新的 true 取消 D2 正在进行的恢复。保留可聚焦的返回按钮，等待态用 aria-busy/aria-disabled 与入口 guard；恢复失败才禁用展开。
5. 每次请求 1200ms 上限，同时核对单调时钟 deadline。过期/不匹配 ACK 不切换几何，也不能解锁下一轮。true 失败仍留 inline，并发送更高序号的 false 清理；false 超时则保留 inline、明确提示恢复未确认，直到重挂载前不再展开。
6. Escape、兄弟 dialog、链接、图片可取消 opening。dispose/pagehide、移除/替换 frame 会结清 pending、使异步 generation 失效；迟到 ACK 不能复活 modal，原注册在移除 iframe 后释放。

宿主只操作自己的 viewport 滚动以维持缩放/布局；**没有新增对 opaque iframe 的滚动能力、坐标命令或 scroll RPC**。Electron 测试中的 `child.executeJavaScript` 是既有测试观察能力，用于造良性阅读位置和取证，不是产品接口。D2 的 native rAF/localScroll 和暂停资源策略不由 C2 修改。

## 3. T3 的实际本地源码对照

只读参考：`C:/Users/21022/AppData/Local/Temp/pi-gui-p2-c-t3-reference-afc8ce7c41644f07a39ac2b688c3ef71/source`。用 `GIT_NO_LAZY_FETCH=1 git rev-parse HEAD` 实测为 **`d20571f9b9fa35da087e916713f6bac05ac9d1f4`**。未运行该第三方仓库的脚本、应用或测试，未查询在线 PR/issue。

以下位置均相对该固定 SHA：

| T3 源码与观察 | C2 对照与有意差异 |
| --- | --- |
| `apps/web/src/components/chat/HtmlRenderFrame.tsx:23-35,52-99`：按 attachmentId 保存最后测量高度，内存 Map 最多 200 条；保持首次资源 URL，续签不重载 | 复用“存活 iframe 不为 UI 状态重载”的原则；pi-GUI 不新增 HTML 或尺寸跨会话缓存，session 返回仍按 scope 重新读取 |
| 同文件 `:74-84,134-140`：expandedSrc 控制独立 HtmlRenderDialog；effect 在关闭/卸载释放 timeline pin | 复用生命周期收口的目标；不复制独立文档，保持当前原地 native dialog 与同 realm 状态 |
| `HtmlRenderDialog.tsx:25-39,51-71,78-103`：0.5..2、步长 .25；CSS zoom，布局宽度除以 zoom，有意 reflow；宽上限 1176px，卡片内部滚动 | 保留既有 pi-GUI 0.5..2/.25 控件；fit 为响应式，独立缩放为 transform，避免每次缩放改变文档布局；同 iframe 的内部阅读位置按 D2 ACK 处理，不声称与 T3 缩放语义相同 |
| `apps/web/src/components/files/BrowserDocumentFrame.tsx:302-320,412-469`：HtmlRenderDocument 保留 initial src、postMessage 更新主题，按 event.source 校验；height 在焦点/activation gate 前消费，宿主动作在 gate 后 | 同样区分布局遥测与用户动作；保留 pi-GUI 更严格的 id/nonce/origin/exact-key、链接宿主确认。**不复制** T3 的 allow-forms / fullscreen 权限 |
| 同文件 `:211-295`：FileDocument 修订使用新旧两 iframe；新页接受旧位置并回 ACK，双 rAF 后 reveal；load 卡住有 5s fallback | 这是文件修订链，不是 HtmlRender 全屏链。可参考“恢复确认后再揭示”的时序，但不复制其宿主持有 scroll 坐标协议，也不拿它证明同 realm 全屏恢复 |
| `packages/shared/src/htmlRender.ts:10-14,85-119,410-418`：初始高度最多 2000、live fit 最多 20000；bootstrap 用 ResizeObserver 上报根尺寸；contained scrollIntoView 在文档内终止 | T3 的 capped live-fit 不能代替本次 feedback hold；此处没有 D2 的 feedback/六字段 presentation。保留 pi-GUI 的 D2 实现，不只移植数字上限 |
| `HtmlRenderFrame.browser.test.tsx:35-82`：覆盖展开时卸载释放 pin，以及重挂载用最后测量高度 1500px | 这些源码断言不是本次运行结果，也不覆盖 pi-GUI 的 >4096 内部阅读往返；本次另做实际 Electron 证明 |

本地还读取了两条提交的元数据：`4c679a21e73f998832d2c32f9e16078aca28e2c5`（#38832，inline 页面脚本不再滚动聊天）和 `70e4319da82f75240cba6b47956e77b5bde611ee`（#38458，切回线程保留测量高度）。只核读本地 log 与上述当前实现，没有据此宣称已审完整历史 diff、在线 PR 或 T3 的运行表现。shared 源码关于发布时拒绝 vh 的注释不等于本轮已运行其发布校验。

## 4. 离线定向测试与回归前后对照

环境：Windows 11 10.0.26200，Node **v24.22.1**，npm **11.19.1**，复用 `C:/pi-GUI/node_modules`，没有安装/下载。验证根目录：

`C:/Users/21022/AppData/Local/Temp/pi-gui-c2-acceptance-nm9Xaj`

其中 `baseline` 是 C before HEAD，`integrated` 是固定 D2 集成树加 C2；`sources.json` 记录来源，`targeted-final.json` 记录每条实际命令与计数。D 套件未修改；TEMP preload `assertions.cjs` 仅计数 assert 调用，对 UI 的计数与其既有计数器同为 282。失败时未到达的断言不计作通过。

实际命令形态（suite 为 ui/frame/layout/reading，各单独执行；baseline 只跑 ui）：

```powershell
$verify = 'C:/Users/21022/AppData/Local/Temp/pi-gui-c2-acceptance-nm9Xaj'
$env:NODE_PATH = 'C:/pi-GUI/node_modules'
node --require "$verify/assertions.cjs" --test --test-reporter=spec "$verify/integrated/tests/html-artifact-ui.cjs"
node --require "$verify/assertions.cjs" --test --test-reporter=spec "$verify/integrated/tests/html-artifact-frame.cjs"
node --require "$verify/assertions.cjs" --test --test-reporter=spec "$verify/integrated/tests/html-artifact-layout.cjs"
node --require "$verify/assertions.cjs" --test --test-reporter=spec "$verify/integrated/tests/html-artifact-reading.cjs"
```

| 被测状态 / 套件 | pass | fail | skip / cancel / todo | 实际断言调用 | exit | Node duration_ms | 验证根目录内日志 |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
| before HEAD / UI | 20 | 0 | 0 / 0 / 0 | 169 | 0 | 4773.8455 | `baseline-ui-final.log` |
| C2 + D2 / UI | 26 | 0 | 0 / 0 / 0 | 282 | 0 | 9038.4908 | `integrated-ui-final.log` |
| C2 + D2 / frame | 19 | 0 | 0 / 0 / 0 | 180 | 0 | 975.2413 | `integrated-frame-final.log` |
| C2 + D2 / layout | 13 | 0 | 0 / 0 / 0 | 71 | 0 | 880.1463 | `integrated-layout-final.log` |
| C2 + D2 / reading | 12 | 0 | 0 / 0 / 0 | 39 | 0 | 938.8200 | `integrated-reading-final.log` |

最终四套件 **70 pass、fail/skip/cancel/todo 均 0，572 次断言**；不是完整 npm test。原 20 项/169 断言全部保留，原同步展开步骤改为等待有效 ACK，原采用自然高度的样例明确 feedback:false。共增加 6 项、总计增加 113 次实测断言调用，没有通过删除旧断言或 skip 收敛。新增覆盖：feedback hold/v1、保存前几何与恢复中重开、exact keys/过期 ACK、恢复超时、pagehide/dispose、图片/链接取消待展开。

### 修复前失败、修复后通过

TEMP control 保持 D2 与 C2 transport/validator 不变，只换回 before HEAD 的 dialog，运行两个新回归，隔离消费者缺陷：

```powershell
node --require "$verify/assertions.cjs" --test --test-reporter=spec '--test-name-pattern=expanded feedback holds|12000px geometry waits' "$verify/integrated/tests/html-artifact-ui.cjs"
```

| 对照 | pass / fail / skip | 已到达断言 | exit | duration_ms | 日志 |
| --- | --- | ---: | ---: | ---: | --- |
| 仅旧 dialog，位于 `C:/Users/21022/AppData/Local/Temp/pi-gui-c2-before-i5OD4M` | 0 / 2 / 0 | 4 | 1 | 1620.6091 | `before-dialog-regression.log` |
| 最终 C2 dialog | 2 / 0 / 0 | 30 | 0 | 2400.5307 | `after-dialog-regression.log` |

旧 dialog 在 feedback:true 下使用 340px 而非已接受 330px；未收到 ACK 时 dialog 已 open（true，而预期 false）。新消费者两个回归均通过。断言 4→30 是旧版早败中断后续断言，不是测试删减。`regression-dialog-control.json` 保存两个命令/fixture 身份。

更早的“全部旧消费者”对照也保留于 `regression-control.json`：0 pass/2 fail/skip 0、4 次已到达断言、exit 1、1434.6216ms；修后 2/0/0、30 断言、exit 0、2385.7928ms。其 RD-2 首败为旧校验器拒绝 feedback，停在 320px，因此后来补上了上述只换 dialog 的更精确对照，没有把协议适配失败冒称为单独的 hold 证明。

五个改动的 JS/CJS 文件 `node --check` 均 exit 0；`git diff --check` exit 0。`source-final-check.json` 记录工作树、TEMP 被测树、Electron 报告摘要对比：**changed=[]，reportMismatch=[]**。提交后 `handoff-check.json` 再比对测试提交中的七个消费端/测试文件：**7/7 摘要一致**；本文相对文件链接 **5 个、missing 0**，UTF-8 BOM 不存在。

## 5. 实际正常沙箱 Electron 视觉与滚动证据

### 入口与环境

使用未改动的生产 `electron/main.cjs`、preload 和原生 frame 注册；仅注入 C 专属 renderer read fixture，启动外部程序用 fake Pi。所有项目、session/profile、日志和截图在新建 `os.tmpdir()` world 内，不写真实项目/session。驱动实际点展开/缩放、发送 Escape/Tab，并用 capturePage 取图，不以 jsdom 证明布局。

```powershell
$env:NODE_PATH = 'C:/pi-GUI/node_modules'
$env:ELECTRON_OVERRIDE_DIST_PATH = 'C:/Users/21022/AppData/Local/Temp/pi-parallel-electron-dist-uB45iF'
$env:ARTIFACT_VIEWER_SOURCE_MANIFEST = "$verify/sources.json"
node "$verify/integrated/tests/html-artifact-viewer-electron.cjs"
```

- Electron **44.4.3** / Chromium **152.0.7977.130**，win32。
- 私有离线 electron.exe 与既有 node_modules 版本摘要相同：`bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`，不是新下载。
- 实测 `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`、`webSecurity=true`。没有 `--no-sandbox` 或 `--disable-web-security`；附加开关只有 TEMP user-data-dir 和 disable-background-networking。
- 最终运行 `2026-11-27T10:03:29.464Z` → `10:03:49.061Z`，**19597ms**；**40 pass / fail 0 / skip 0，18 张截图，启动器 exit 0，Electron child exit 0 / signal null**。这 40 项是驱动 checks，不和 Node assert 调用混算。
- 报告 `completed=true`、`sourceChanged=[]`。本次没有 renderer-gone 记录；无此记录本身不是跨环境稳定性证明。
- 完整报告和逐图 bytes/SHA256：`C:/Users/21022/AppData/Local/Temp/pi-visual-replies-2sygqR/evidence/viewer.json`。报告明确 `securityAcceptance=false`、`realPiOrModel=false`。

### 四组实际结果

长内容为 min-height:12000px、270 行双语表格，inline 实际 cap=4096px；不是前次约 4008px 的不足样例。每组先把 iframe 内部阅读位置设为 7904，再用实际按钮展开、缩放和关闭。

| 主题 / 宽度 | 请求 CSS 视口 | 截图记录的实际 innerWidth×innerHeight / DPR | 内部 scrollY：inline→expanded→restored | expanded 宿主滚动内容 / viewport | 同 realm、输入、按钮计数 |
| --- | --- | --- | --- | --- | --- |
| dark / wide | 1320×820 | 1320×820 / 1.5 | 7904→0→7904 | 12000 / 744 | 保留 |
| dark / narrow | 700×600 | 701×602 / 1.5 | 7904→0→7904 | 12000 / 526 | 保留 |
| light / wide | 1320×820 | 1320×820 / 1.5 | 7904→0→7904 | 12000 / 744 | 保留 |
| light / narrow | 700×600 | 701×602 / 1.5 | 7904→0→7904 | 12000 / 526 | 保留 |

宽屏 dialog 1176×788、left=72/top=16；窄屏约 669.333×570、left=16/top=16。保留原 `scrollHeight > viewportHeight` 检查，最终为 12000>744/526，没有删除父任务此前失败的 bounds 断言。缩放 125% 为 transform；关闭回焦点、焦点在 iframe 中按 Escape、Tab/Shift+Tab 留在 modal、dispose 关闭 native dialog/移除 iframe 均实际通过。

另用良性 `height:calc(100vh + 10px)`：展开后 600ms 取早值，再过 1300ms 取晚值。dark wide **350→350px**，dark narrow **380→380px**，light wide **420→420px**，light narrow **450→450px**。各组保持不增长且远低于上限；不同组有宽度/主题/前轮测量历史，不把组间数值变化当作同次展开增长，也不声称永久无需重新测量。

丢弃保存 ACK 的真实 message 注入：在 viewer 监听器前注册拦截器，实际拦到 **1** 个 true ACK；1400ms 后 modal 仍关闭，iframe 几何 **419×460px→419×460px**。没有丢到 ACK 就不能算超时场景通过。

### 已查看的最终代表图

根目录为 `C:/Users/21022/AppData/Local/Temp/pi-visual-replies-2sygqR/evidence/`。已打开查看以下五张最终截图：

| 文件 | bytes | 观察 |
| --- | ---: | --- |
| `expanded-dark-wide.png` | 98828 | 双语标题、输入及表格正常；展开有宿主滚动与底部缩放/关闭控件，无第二套容器样式 |
| `restored-dark-wide.png` | 128630 | 回到 Row 187 附近，按钮有返回焦点轮廓，长文没有回顶部 |
| `restored-light-narrow.png` | 95260 | 浅色窄屏同一阅读段；正常宿主 composer 遮罩边界，没有全屏遗留 |
| `viewport-expanded-dark-wide.png` | 34662 | 视口相关样例可见，native modal 与控件正常，不是白屏或只启动 |
| `save-ACK-timeout-inline.png` | 46999 | 仍为 inline，没有迟到弹层遮挡 |

其他 13 张图及全部摘要见 JSON；没有把未逐张查看写成已逐张人工检查。与 UI 规范对照：复用 token/公共按钮，深浅与宽窄实际渲染、焦点/原生模态/内容滚动均有证据。没有运行完整可访问性审计或其他操作系统矩阵。

## 6. 首败与重跑历史

- 接手半成品：UI 17/20、3 fail、145 次已到达断言、exit 1，见 §1；单独还原 committed HEAD 后为 20/20、169 断言。没有把半成品当作旧版绿色基线。
- C2 第一轮 Electron：`C:/Users/21022/AppData/Local/Temp/pi-visual-replies-FlxlFL/evidence/viewer.json`；**32 pass / 1 fail / skip 0，14 图，7904ms，启动器 exit 1、child exit 0**。四组长文恢复已通过，但 Tab 后立即读取 host activeElement 得到 BODY。首败截图显示 opaque frame 内的焦点；修为等待跨进程焦点传播落定，再执行原 containment 断言，没有移除该断言。表格从 90 增至 270 行，让 7904px 的截图有真实可读行而非空白 padding。
- 第二轮：`C:/Users/21022/AppData/Local/Temp/pi-visual-replies-dNID4z/evidence/viewer.json`；**39 pass / 1 fail / skip 0，18 图，19026ms，启动器 exit 1、child exit 0**。超时注入的 listener 注册晚于 viewer，不能撤回已消费的 ACK；结果真的展开（419×470→659×480，open=true），因此不能称产品超时通过。将过滤器提前到 mount 前、记录实际 dropped=1，并等待最后一次 inline 测量落定，再重跑。
- 第三轮最终为 §5 的 **40/40、19597ms、exit 0**。两个首败目录保留，不用最终报告覆盖。修复前消费者 control 的预期失败另见 §4，不算最终未处置失败。
- 首次 TEMP 完整 archive 因无关中文文件名被 Windows tar 拒绝，之后按运行所需目录归档并用 prepared 哨兵区分完整快照；这是准备失败，不记作产品测试失败或通过。

## 7. A2 session-return 补充实证的职责对照

父任务提供的集成证据：`C:/Users/21022/AppData/Local/Temp/pi-visual-replies-wCQcf4/evidence/functional-generate.json`，**17 pass / 1 fail，completed=false，failure.stage=session-return / code=condition_timeout**。C2 只读取报告、`generate-first-failure.png` 和源码；没有修改/重跑 A2 驱动，更没有触碰 A 安全 suite。

能确认的源码事实：

- `tests/fixtures/visual-replies-functional-electron.cjs:4-9` 的 state() 读所有 `.html-artifact` 的 dataset.state；`:17-24` 的 frameRect() 会滚动目标进入视口，生成阶段互动逐个调用它。
- 同文件 `:187-193`：切走后确认旧 artifact 清除，再点回原 session；line 192 直接等待 owner 匹配、数量为六、**每一个 state 都 ready**，这段等待没有逐个访问恢复后的 artifact。重启阶段 line 199 也有类似 all-ready 预期，本次未执行/下结论。
- 既有 `public/html-artifact-layout.js:71-109` 的 IntersectionObserver 使用 rootMargin `600px 0px`；不在近视口或隐藏的 wrapper 不发 visible=true。viewer `mount():253-267` 只在 visible=true 且未加载时启动 scoped load。这是原有懒挂载策略，本次未修改。
- 历史渲染调用方 `public/messages.js:242-250,374-388,1909,2014` 负责 owner/generation 与离开销毁/返回挂载；本次没有改它。C UI 的既有 Runtime 往返测试证明 scoped 重新读取，不证明真实 IO 下离屏条目全 ready。

因此，**“无需访问离屏条目即全部 ready”的驱动条件与既有懒挂载语义存在可定位差异**，值得父任务对照；但报告缺少超时时逐 artifact 的 state/nearby/read/register/ready 观察，不能证明它就是该次失败的唯一根因，也不能据此排除真实 owner、读取、注册或 hydration 问题。截图中 raster 页面有标题、按钮与 Ready 字样，仅能证明可见部分已渲染，不证明全部六项已恢复，也不宜称所有 iframe 都未 hydration。

职责划分：C viewer 负责新实例的 scoped read/register、ready、abort/dispose 与错误呈现；D helper 只给可见性信号、测量/资源暂停，D frame 的 presentation 保存只属于**已经加载的同一个 realm**。A2 的 session-return 是销毁后重新投影/挂载，等待中没有主动发起 fullscreen，故 **C2 的 presentation ACK 不能直接修复或证明这条 hydration 链**。驱动预期是否应适配懒挂载、或产品是否另有返回缺口，由父任务按逐项观察复测；此处维持“待定/未验证”，不越权改 A、D、messages 或后端。

## 8. 未验证边界、审查状态与回滚

| 项目 | 本次状态 |
| --- | --- |
| C2 开发与作者定向验证 | 已完成；RD-2 hold 与 RD-3 保存/恢复时序有 Node 和实际正常沙箱良性证据 |
| 独立功能/故障注入/安全边界复审 | **待验证**；本次为作者自查，没有启动子代理，也没有把自查当作独立通过；父任务须对 C2 增量及 C/D 边界复审 |
| 完整 canonical / 当前 PR CI | **未运行、待验证**；按集成计划由父任务收口，70 项不替代 npm test；没有创建 PR/查询 CI |
| 最终产物构建、一致性与打包运行 | **未运行、待验证**；未执行 build:exe 或 build:app -- --rebuild。父任务仍需正式重建；当前改动 **跑源码版才看得到** |
| A 安全 suite / 旧安全失败 | **没有运行或重试**，未获安全资格；既有失败/服务限制不被本次良性检查覆盖 |
| 真实 Pi/模型/tool/store、重启持久化与安装升级 | **未验证**；fake Pi + read fixture 不是这些链路的证据，没有真实模型调用 |
| A2 session-return | 父测失败仍待定；本次未重跑，不宣称修复 |
| T3 运行表现、其他 OS/DPR、完整无障碍审计 | **未验证**；仅指定本地源码与 Windows/DPR 1.5 良性矩阵 |
| 推送、PR、合并、tag、发版 | **均未执行、未授权**；本次只有按回滚边界的本地提交 |

C2 分支仍保留旧 D 文件，这是所有权约束的结果：**交付必须和已固定的 D2 协议生产端一同集成**。不能只在旧 D 的 C 分支跑新 UI 测试后把协议超时当作最终集成结论，也不能仅复制 C2 文件而忽略 D2 依赖。

源码摘要是证据与提交间的桥梁，`source-final-check.json` 已比对 C2 五个改动文件及未改 CSS/controls 与 TEMP；Electron JSON 另固定 D 模块、reading-position 和 driver。提交之后仅增加本文，不冒称在文档提交 SHA 上又跑了一轮 CI。

回滚：在本 C 分支若需撤销行为，按测试→产品逆序 `git revert 1ba42ed02fbd09717d4d3f8bed313b9ce5ed287c 393324644c8b419dab9811702d13961c3f4ecea7`；集成 cherry-pick 后使用对应集成 SHA，单独决定是否回退文档。保留 D2 与其他线改动，不 reset 或覆盖工作区。无 schema/用户文件迁移需要撤销；但回退会重新暴露已知的旧消费者协议缺口，不应当作合格发布状态。若产物已经构建，父任务另行恢复/重建对应源码版本，不能只回退源码而沿用不明产物。

最终分阶段结论：**开发完成；作者定向与正常沙箱良性 UI 验证通过；代码验收待独立复审及父任务完整证明；不表示允许合并或发布。**
