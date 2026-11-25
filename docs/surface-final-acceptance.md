# Surface 与统一文件预览：最终整改验收

日期：2026-11-25。此报告记录本轮实际证据，不继承历史验收的通过结论。

## 身份、范围与当前门槛

- 分支：`feat/unified-file-viewer`；既有 PR [#112](https://github.com/HYJ1817/pi-gui/pull/112)，不新建 PR。
- before HEAD：`78ca4dcb9dd3e4293e9dcb0f7507a0a6d51d7d5d`。基线完整 CI run `45551821141` 成功仅证明该 SHA。
- 证据代码状态：上述 HEAD 之上的本轮待提交工作区；提交后核对产品、测试与构建文件树，不把提交前运行冒称新 SHA 的 CI。交付提交按 `git log -1 --format=%H -- docs/surface-final-acceptance.md` 解析，最终交付消息另记完整 SHA。
- 风险：**高**。涉及跨会话恢复、资源生命周期、受控文件读取、复杂文档解析及依赖/构建来源。
- 当前门槛：源码桌面、重建产物桌面、真实大视频与后端故障专项、受影响 canonical 与独立复审均已有最终通过记录；**完整 canonical 依用户选择交由当前 PR CI，CI 未完成前标为待验证，整体代码验收尚未通过**。
- 用户仅授权提交、推送当前分支并更新 #112；未授权合并、tag 或发布。

## 实际改动与所有者

| 范围 | 本轮行为与边界 |
| --- | --- |
| `public/ui/secondary-surface.js`、Launcher、app/runtime 入口 | 外层有序工具 tabs、独立空 Launcher、单例复用、切换/关闭/批量关闭/重排、有界描述符恢复；删除永久工具按钮、隐藏 source-button、旧卡片和“更多工具” |
| `public/right-pane.js`、split、Browser、Terminal、tree 的必要适配 | 公共几何/最大化；聊天保留且 inert；隐藏与显式关闭分开；稳定导航 scope 与瞬时 owner identity 分开；split 借同一业务 host |
| `public/files-*.js`、预览公共菜单和格式叶子 | Files 内层仍唯一持有文件 tabs/活动文件/阅读状态；树在右侧、左缘分隔条、窄窗 overlay；低频动作进现有 action-menu；隐藏时保存并 dispose 重预览，返回重新验证 |
| `public/file-link-model.js`、`file-links-ui.js` / CSS | 外部引用可见文本仅文件名加行列范围，完整路径留 tooltip/必要无障碍名称；不提前读取未授权元数据 |
| `pptx-model.js`、`pptx-shapes.js`、Office 投影 | 自有有界 OOXML 模型绘制实际文本、形状、图片、基础页布局；保留分页/缩放/适配/恢复，不用纯文本提取替代幻灯片 |
| package/lock、`sync-preview-vendor.mjs` | 移除 `pptx-preview@1.0.7` 及其独占子图和 opaque 预打包文件；实际源码依赖、完整通知、大小和摘要可追溯；无新增依赖 |
| 专用单元/集成、legacy 入口 fixture、desktop/large-media | 新增生命周期与故障回归；迁移真实菜单/几何/导航合同，不为测试保留隐藏旧控件，不复制 canonical 测试清单 |

当前合同见 [work-surfaces.md](work-surfaces.md) 和 [统一预览契约](unified-file-viewer-contract.md)。T3 Code 精确 SHA、调用链、MIT/品牌边界与必须保留的本地差异见 [参考研究](surface-final-reference.md)。[旧验收](unified-file-viewer-acceptance.md) 固定保留原阶段失败与许可未决，不能覆盖成本轮通过记录。

未重构思考动画、工作记录、轮次耗时、用量 Popover、消息操作栏、AI 标题、左侧会话业务、模型/供应商设置、MCP/Skills/扩展系统；跨模块仅作统一 Surface 所必需的接口适配。

## 本地定向证据（最终状态）

环境：Windows 11；源码 Node v24.22.1；Electron 44.4.3 / Chromium 152.0.7977.130。桌面使用正常 sandbox/contextIsolation、无 renderer Node globals、无 `--no-sandbox`，TEMP 项目、fake Pi、离线网络门控；没有真实模型调用或用户项目写操作。Chromium、视口/DPR 与实际几何保存在各运行 JSON。日志根：系统 TEMP `final-suites/`；下列数字均为最后一次完整运行，不是中途部分成功。

| 命令/套件 | 最终实测结果 | 证据位置（系统 TEMP） |
| --- | --- | --- |
| `npm run test:file-preview` | exit 0；core 62 tests + ESM 7，backend 31 checks / 270 assertions（14,845 ms），panel 70 checks，office 91/91，PPTX 20/20，media-archive 44/44，PDF 15/15，entry 35/35，vendor 30/30 | `final-suites/file-preview.log` |
| `node tests/surface-tabs.cjs` | **174/174 assertions，47 类，0 skipped**（含新增 close-others 借用子工具契约） | `final-suites/work-surfaces.log` |
| `node tests/surface-lifecycle.cjs` | **257/257 assertions，56 类，0 skipped** | 同目录 |
| `node --test tests/files-surface-lifecycle.cjs` | 13/13 | 同目录 |
| `npm run test:work-surfaces` | exit 0；files-terminal 113 checks、files-terminal-ui 95、terminal-job-object 10，加 Surface 三套 | 同目录 |
| 相邻 canonical 批次 | ui4 44/44 + 27/27 + 57/57；Specs 18/18 + 25/25 + 14/14；browser-workbench 17/17 + viewport-safety 36；file-links 链 243 checks（模型 72、backend 24、grant 26、external 20、editor 22+8、UI 51、runtime 8、highlight 12）；session-change-ui 27/27；shortcut-settings 29/29；runtime-secondary 26/26；runtime-git-ui 6/6；process-ui 19/19；gui-browser-ui 24/24；attachments 53/53；ui-ia 32/32；split-workbench-ui 31/31；smoke **1339/1339** | `final-suites/{ui4,specs,browser-workbench,file-links,session-change-ui,shortcut-settings,runtime-secondary,runtime-git-ui,process-ui,gui-browser-ui,attachments,ui-ia,split-workbench-ui,smoke}.log` |
| `node tests/file-preview-desktop.cjs` | **156/156**（155 项 renderer 断言 + 1 项退出清理），35,661 ms，正常沙箱，残留 0；Electron 可执行文件 SHA-256 `bf0fe749…`，`override=false` | `pi-preview-desktop-ZYGwsX/evidence/results.json` |
| `node tests/file-preview-packaged.cjs --output-root <build-root>` | **120/120**（9 外层 + 111 桌面）；public 652 files / 14,756,099 bytes；48 个桌面模块字节一致；观测 11 个进程身份，残留 0；资格 `packaged-production-main-normal-sandbox`；`open-guide.md` 在自然 close-all/reopen 顺序下成功（`openError:null、activeFileTab:guide.md`），Launcher Escape 通过。本轮为 R0 树合并修复后的最终重建运行 | `pi-preview-packaged-79Haa0/evidence/{summary,desktop}.json` |
| `node tests/large-media-desktop.cjs --fixture <TEMP>/media --app-root <built-app>` | **24/24**，33,138 ms；真实原生播放/seek/撤权/关闭 | `pi-large-media-shAP8t/evidence/report.json` |
| `node tests/large-media-backend.cjs --fixture <TEMP>/media` | **57/57**；撤权后 65,536 B / 75 ms 内停止，scope 退休 65,536 B / 66 ms 内中断 | `pi-large-media-fault-0avrCJ` |
| `npm run test:ci` | exit 0；344 leaves / 5 groups，coverage exact；readiness 5/5、gate 15/15、results 10/10、summary 30/30、history 21 assertions、doc-scope 28/28、release-proof 16/16、NSIS fixture 12/12 | 较早任务输出；它验证 CI 机制，不执行全部 344 leaves |

新 Surface 与 Files lifecycle 已经沿 `test:work-surfaces → test:surfaces` 进入 `npm test` 唯一 canonical 链；PPTX 沿 `test:file-preview:office` 进入。大媒体是 Windows Electron/TEMP 离线生成专项，backend alias 必须显式传 `--fixture`，不把需参数的脚本无参加入 canonical。

## 真正运行了什么

### 文件查看器与 Surface

源码 156 项覆盖宽窄窗 × 深浅主题、树选中/焦点/AA、真实菜单、编码、引用区间复制、真实 Changes diff，以及 Markdown/KaTeX/授权图片、opaque HTML、PDF Worker/canvas/搜索/缩放/位置恢复、DOCX、XLSX、CSV、PPTX、图片、WAV、MP4、ZIP 和故障降级。

正式产物专项使用 TEMP 复制包，在 **TEMP manifest 中选择观察 bootstrap**，再加载字节不变的 production main/preload/backend/public（原始 manifest SHA-256 `f300f9…`，`bootstrapManifestOverride=true`）。不是“未修改 manifest 的普通双击启动”证明；未注入替代 renderer、未用 CDP 或 sandbox 绕过。验证 SEA 认证/隔离与全部 652 个 served public 文件字节、48 个桌面模块，随后通过真实输入驱动预览和 Surface：

- 四组居中单列 Launcher、键盘 type-ahead 仅聚焦、Enter 执行、Escape 隐藏；旧入口缺失。
- `+` 建独立空标签、选择转换、Files 单例复用与内层文件 tabs 保留。
- 真 PTY/xterm 切 Surface 不重建；Browser 原生实例、URL 与输入值在 Files/Changes 切换后保留。子 `WebContentsView` 不因页面加载而持有窗口焦点，驱动脚本先聚焦真实视图、可信点击输入框、等待 `activeElement` 后才键入；产品断言仍同时检查未销毁、同一 id、同一 URL、同一表单值。
- Browser 返回时原生子视图重新 attach 且 bounds 非零，关闭后 native webContents 销毁。
- 隐藏/重开 Files 恢复预览；公共最大化保留聊天 DOM 且 inert，restore 宽度误差小于 2px；四组公共几何误差均不超过 2px。
- 外层工具 tabs 真实键盘重排及反向恢复、roving focus、Delete、关闭其它/右侧/全部。
- renderer 真实 reload 后 Files 以懒描述符恢复，可信 Home 首次挂载并把焦点交给选中且可见的 Files 工具 tab。
- production quit coordinator 清理按 PID **和创建身份**观测的后端/fake Pi/PTY 家族，11 个身份全部退出，残留 0。

打包场景的组顺序为自然顺序：Surface 场景先关闭全部顶层 tab，`packaged-layout` 随后带着排队文件请求重开 Files —— 这正是 F2 修复前会触发 R0 恢复竞态的 close-all/reopen 交错。本轮用注入运行时副本的 open-chain spy（不碰产品字节）把 R0 的真实根因定案为 **session 身份 settle 触发的过度 reset**：sessionId 在 bridge ready 后总是异步settle（`app.js` 注释明确"bridge ready 可能先于会话身份到达"），从空 sessionId settle 到真实 UUID 时 `onContext` 误判为 scope 变化而调用 `reset()`，把用户已经开始的 open 一并销毁；而 backend `fileIdFor` 的 hash 只覆盖 workspace.id+conversationId+路径+文件身份，**不含 sessionId** —— sessionId 只是 per-session 历史命名空间，不是访问绑定。修复为 `settleSession`：cwd+conversationId 稳定时仅就地采纳 settle 的 session 并合并该会话历史，不做 reset；真正的 workspace/conversation 变化仍全量 reset。最终打包运行实测 `layout-after-open` 的 `openError:null`、`activeFileTab:guide.md` —— 用户的排队打开在 settle 中存活并成为活动 tab，四组几何断言通过。没有场景被删除。F2 的恢复竞态由 `tests/files-restore-race.cjs` 19/19 锁定（含 tombstone 复活回归，及本轮新增的八条 session-settle 回归：session-only settle 不销毁已开 tab、in-flight open 在 settle 中存活、真正 workspace 变化仍销毁、settle 应用目标 session 树状态、空 session tombstone 不被 settle 复活、settle 合并去重、in-flight 在 tree 未决时存活、cwd-only 变化使 pending open 失效；revert 修复后目标测试变红、安全对照仍绿，证明非假绿）。

BrowserWindow 截图不包含子 WebContentsView 像素，因此 Browser 原生内容单独通过真实 `webContents.capturePage()` 保存为 `surface-browser-native-restored.png`，与外壳截图分开；未合成伪造应用截图。跨会话/epoch 退休与恢复的专项证据目前来自定向生命周期集成，不把它写成桌面跨会话人工点击证明。

### 大于 100 MB 的真实视频

离线 fixture 为 **180,850,509 bytes** 的 VP8 WebM，960×540、12fps、360 帧、30 秒：180,817,713 bytes 实际新编码 frame payload + 32,796 bytes 容器。生成器由 canvas 噪声和帧号经 WebCodecs 编码并写合法 duration/SeekHead/Cues，不靠空洞/零填充凑大小。frame payload SHA-256：`1ee774c68eb6299cbffe0bd5ca554428fc72185cffd9e97714c26a822b330a08`。

- 连续播放跨 62 个记录在案的 Range 请求、至少三个完整 8MiB 206 响应；每个成功响应不超过 8MiB，无整文件 200。
- 原生 controls timeline 在 0.73、0.23、0.88 比例真实拖动；`seeking.isTrusted`、currentTime 与 decodedFrames 推进共同证明，不以设置 currentTime 代替拖动。
- 调试器只临时读取 UA shadow timeline 的 box，detach 后才发送原生输入；不是完整流程未 attach debugger。
- hide/close/文件 tab 关闭/撤权分别 8/9、6/58、12/64、7/10 ms 释放 decoder 与 descriptor；观察窗 1.2 秒内不再请求/读取；返回不 autoplay，旧授权拒绝 403。
- renderer whole-file fetch 0、媒体 ObjectURL 0；backend opened==closed==63，readCalls=5,820，actualBytes=377,396,711，单次 read 不超过 64KiB，wholeFileReads=0。
- 撤权由 **真实 SSE** 驱动：native `EventSource` 观察到 `sequence=10, replay=false`；同一事件下 capture-before-owner 记录同步 document 事件拆除；不以 403 回退冒充 SSE 成功。
- 后端 fault 专项在首个 64KiB write 后故意 backpressure，不 emit drain；撤权和 generation 退休后结束读取、销毁响应。
- 无 renderer crash、无远程请求；final 前与 final 时 opened/closed/active 均为 63/63/0。

媒体运行使用 **test-owned BrowserWindow**，但加载经字节比较的 built production renderer/preload/backend；**不冒充 production-main 媒体证明**。授权采用仅限生成 TEMP 文件的 test-private grant IPC，未覆盖系统原生文件授权对话框。原生浏览器和生产 main 的证明来自上一项，不能混合层级。

## 离线双构建与产物身份

先以 `node scripts/build-app.mjs --rebuild --output-root <fresh TEMP root>` 在 `%TEMP%/pi-surface-final-build-70Ie6I` 构建并验证，随后在删除死 DOM 引用及 tree/git 遗留徽标路径、冻结产品源码后执行 **`node scripts/build-app.mjs --rebuild`**，更新目标 worktree 的默认 `build/` 与 `dist-app/`（均内部先重建 SEA）。本轮最终收口（I2-01 恢复、Browser 驱动与打包场景顺序）之后再次完整重建默认双产物并重跑 desktop/packaged/媒体，下表是**这次最终重建**的实际身份，不沿用清理前字节摘要。使用已存在的 Electron 44.4.3 ZIP，先对本地安装 checksum 核验 SHA-256 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`，再以 `PI_GUI_ELECTRON_ZIP_DIR` 离线构建；没有下载运行时。

| 对象 | 实测大小/摘要 |
| --- | --- |
| preview vendor | 355 files / 10,029,375 bytes / 32 source packages |
| vendor manifest SHA-256 | `d7767a9f567b508c32c9e83cb000c8314d82f2c0ea0a72cfd8ce3411ba018ab5` |
| vendor tree SHA-256 | `c6f71e017374a6605fff9bafd560b5659e44859979060da4860e6edb246a6545` |
| public 资产清单摘要（652 文件，逐文件 `路径\|大小\|内容SHA-256` 行串联后再取 SHA-256） | `41523a1cb9e5145c422cfaf93665eef5e8a70bbbdc2ba3c68dfaf5c58cc62f03`；合计 14,756,099 bytes（R0 树合并修复使 files-panel/files-tree 增大，字节总数较此前 14,723,319 上升） |
| SEA | 117,296,128 bytes；`6586143cf0e9861bc267eb5d68d75437a4ff86ac8c693d6576f511f940a028d2`（R0 树合并修复后最终重建） |
| Electron executable | 246,324,736 bytes；`71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f` |
| Electron backend bundle | SHA-256 `35a0a4618080194001463d2c3fc4ba6e4d9e418ab1137f36e38bef35ac6905e5` |
| Electron runtime（源码桌面实际启动） | SHA-256 `bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`，`override=false` |
| node-pty / conpty.node | 1.1.0；`fe61108b40fcf0c1172d6e193f482e6ef2e0d9b1a447468b6a1eb7c67ca80271` |

默认可运行产物位于目标 worktree 的 `dist-app/Pi GUI-win32-x64/Pi GUI.exe`，SEA 位于该 worktree 的 `build/`；不是另一分支根目录 `C:/pi-GUI` 的产物。重建后实际启动的是此默认产物的 TEMP 字节相同副本。SEA 注入仍出现既有 `The signature seems corrupted!` warning，未隐藏；不据此宣称代码签名或发布资格。许可清单 `legalReviewRequired=[]` 只是生成器结果，**不代替独立许可核验**；本轮 F9 已对 pdfjs-dist Liberation 字体完成实际核验（证据链见下），生成器相应记录 `sourceDistributionVerified=true` 而非未核验警告。

## 失败、修复与数量变化

较早轮次保留的失败（均已处置或明确降级）：

1. 早期源码 desktop 因旧常驻按钮、窄窗隐藏树与旧私有最大化几何 fixture 中断（104 通过 / 8 失败）。改走真实阅读菜单、树 toggle/Escape 和公共 pane/body 几何后完整执行。
2. Changes 的宽泛 button 选择器命中外层 tab；改定位实际 `.chg-main > .chg-path` 文件行并真实点击，仍要求 `.d-row` 真 diff。
3. 正式产物先后在隐藏旧 Launcher 行、动作返回 Surface 对象的 Electron 序列化，以及不存在的 `.rp-url` 地址栏选择器失败。分别改为活动 Launcher host、仅返回 serializable true、实际 `#browserAddress`，生产代码不为这些 fixture 修改。
4. Files 实测暴露的真实修复为原始 File 的空 fileId 形式归一、过期阅读菜单动作守卫，以及 HTML 恢复后的动作名与 aria-label 同步；非空对象身份变化和权限重验未放宽。
5. Surface 实测修复首次 Specs split 业务头部准备、公共 max 的 inert/focus、stable scope 与 instant owner identity 分离、Terminal 恢复不创建 PTY/抢焦点，以及旧菜单/批量关闭不 mount dormant 资源。
6. 静态契约定位到 state 中读取已删除 branchCount/changesCount 的遗留引用：最终删除这两个查询，以及 tree/git 中无消费者的旧徽标逻辑，不加白名单/null 占位，不影响树状态或 Changes 权威总数/过滤计数。
7. 并发编辑中曾编译到 countNodes 函数与调用不同步的瞬态 bundle；该次启动 ReferenceError 保留为失败记录，之后在冻结源树上重建并重跑。

本轮最终收口新增：

8. **I2-01（第二轮独立审查发现的唯一 Important，本轮新引入）**：`public/collab-panel.js:94` 导出文件名清洗正则丢失 `'-'` 替换串与 `\\` 转义。单行恢复为 HEAD 逐字节内容，并在 `tests/collab-panel-productivity.cjs` 增加拦截真实 `<a download>` 文件名的阶段 D 断言。换入坏正则时套件 exit 1（实际 `my docundefinedv1undefined sub\final draft-r2.svg`），恢复后 15/15 checks、76 assertions。第三轮增量复核确认 0/0/0。
9. **close-others 借用子工具契约**：第二轮指出实现自洽但该组合只有文字契约。`tests/surface-tabs.cjs` 新增显式断言（子工具保持 current、host 归还 `.rp-body`、layout 正常关闭、实例身份不变），套件最终 174/174。
10. **打包 Browser 键入失败**：首跑（`pi-preview-packaged-aiL7w5`）子 `WebContentsView` 未持有焦点，`insertText` 未落入输入框。修正驱动为先 `focus()`、可信点击、等待 `activeElement` 与值落地；产品断言未删减。最终 119/119。
11. **打包 `open-guide.md` 在 close-all 后失败（R0 根因本轮定案并修复）**：早期定位为预先存在的 R0 恢复竞态后，本轮用 open-chain spy 把精确根因定为 session 身份 settle 触发的过度 `reset()`（详见上段）。修复 `settleSession` 后，自然顺序下 `open-guide.md` 成功、`activeFileTab:guide.md`；不再有"调整场景顺序规避竞态"的处置，场景保持自然 close-all/reopen 顺序作为生产环境回归证明。另修复同组一个场景驱动层缺陷：Launcher Escape 的 specs 行可信点击是异步派发的，原驱动在点击效果落地前探测 tab 条会偶发读到 0 tab（非产品缺陷），改为等待 specs tab 实际挂载再探测。
12. **打包退出超时**：失败的 Browser 导航留下 `state.loading=true`，production quit coordinator 依设计拒绝退出。导航成功后最终运行由 production coordinator 清理 11 个身份、残留 0；这是失败现场诊断，不是绕过。

计数变化：源码桌面 **156/156 = 155 项 renderer + 1 项清理**（`results.json` 的 `passed` 为 155）；打包 **120/120 = 9 外层 + 111 桌面**（open-guide 修复后 packaged-layout 不再提前中断，后续几何/最大化断言得以执行，故桌面断言总数较此前 110 增加）；Surface tabs **174/174 / 47 类**；Surface lifecycle 最终 **257/257 / 56 类**（fixture 动态循环展开）；files-restore-race 由 11 升至 **22/22**（新增八条 session-settle 回归 + 二轮复审后三条树合并回归：无快照保留手势 / dirty-off 胜过快照 / 未碰仍采纳快照）；大媒体由 20 升至 **24**（新增撤权/关闭/边界断言）；backend 故障 **57/57**。没有通过删除断言换取绿色；总数只增不减。跳过的断言不计入分子分母，本报告只引用各套件自己打印的分母。

## 独立审查、限制与交付状态

五个首轮独立上下文分别检查：Surface 架构/生命周期与原功能、文件/恢复安全、PPTX 许可与实际 vendor、媒体与证据资格、真实 UI PNG 与规范。全部报告已返回并逐项处置，账本见 [surface-final-reviews.md](surface-final-reviews.md)。第二轮由另一独立上下文复核六项修复，结论 Blocker 0 / Important 1（I2-01，已修复）/ Pre-existing 0；I2-01 修复与新增契约断言经第三轮增量复核 0/0/0；HTML 读取竞态与桌面就绪判据复核 0/0/0。媒体 SSE 证据与许可标记/旧 PPTX 产物的最终增量复审为 Blocker 0 / Important 0 / Nit 1（英文边界文案风格，不阻断）：E1 证据资格通过，P1 通过并保留 exe 内部未逐字节枚举的边界。L1 字体许可本轮已实际核验定案、阻断解除（见下）。本轮新增：office scanner 第三轮复审唯一 Important（startAt=0 投影/渲染不一致）已修复并经星驰定向复核 0/0/1（1 条非阻断 Nit 已收窄）；F9 许可核验定案；Surface 打包场景失败定位为场景驱动层陈旧期望而非产品缺陷，已修正。

未验证：当前 PR 完整 canonical（待 CI）；未改 manifest 的普通启动；原生外部授权对话框与晚期撤权响应；真实 Pi/供应商/模型；其它 OS/全部 codec；长时间内存稳定性；OS 窗口拖动缩放与多显示器 DPI；安装/原位置升级/签名/发布。PPTX 仅基础只读投影，不保证动画、SmartArt、高级图表、母版/主题及复杂字体全保真；PowerPoint 对 startAt=0、悬挂缩进 cap 分支（-indent > marL）的桌面应用实测未验证，源码证据不冒充应用实测。R0 恢复竞态本轮已根因修复并经二轮独立复审闭环：session 身份 settle 不再销毁 open，且二轮发现的「`installTree` 无条件重建树覆盖用户树操作」Important 已修复为逐字段合并（`files-tree` dirty 追踪 + `mergeTreeState`，用户碰过的字段以 live 为准、未碰的回落快照、无快照保留 live、expanded 取并集），最终打包运行 `openError:null、activeFileTab:guide.md`。残余边界：(a) settle 之外更复杂的跨会话/workspace 交错未逐一穷举；(b) 复审指出的 P2 既有时序 —— `session-evidence-context` 通知先于 `S.state.sessionId` 写入到达的排序下，in-flight open 仍可能被 scopeCurrent 丢弃；因 surface scope 本身含 sessionId、补发通知会触发 surface 级 reset（副作用大于收益），该窄边界未修、如实保留；复审者另提出更窄方向（Files 在已确认当前 Classic owner 可用时采用其 sessionId），作为建议记录、不计入本轮已修；(c) 目标历史存在待合入标签时当前预览会经 `restoreTabs → activate` 重挂载 —— 复审分类为 Pre-existing（基线既有重激活路径，非本轮新增），故验收口径为「活动标签未变」而非「预览实例未变」；P1 的 SEA 内部字节未全量枚举，只覆盖实际服务集合。

**L1 字体许可核验定案（本轮 F9）**：实际解析四个 Liberation Sans TTF 的 name 表得版本串 `Version 1.07.4`（不凭字体名推断）；上游 mozilla/pdf.js#21746/#21750 核实为未修改 1.07.4 发布件；1.07.x 适用 GPLv2+Liberation 字体例外（2.x 起才是 OFL-1.1）；随附 LICENSE_LIBERATION 与上游逐字一致。1.07.4 无独立字体源工程，TTF 本身即对应源码，逐字节分发未修改件同时满足 object-code 分发与源码提供，mere aggregation 不让主程序落入 GPL，渲染产物依字体例外 (a) 不被 GPL 覆盖。三项落实义务（不改字节、双份许可文本、不声称 Apache 覆盖）均已满足，**发布的字体许可阻断解除**。完整证据链与义务清单见 [pdf-font-license-verification.md](pdf-font-license-verification.md)；该文档是核验证据而非法律意见，分发形态变化须重核。

回滚按业务/测试基建/文档的提交边界 revert 本轮提交，再从锁定依赖离线重建；不 reset 用户其它工作，不清理根目录未跟踪文件，不删除真实会话或文件。既有只读文件授权账本和 Pi schema 未更改，不需要数据迁移。

| 阶段 | 当前状态 |
| --- | --- |
| 开发完成 | 已完成；已知发现均处置，受影响套件与真实运行通过 |
| 代码验收通过 | **待验证**：当前 PR 完整 canonical CI 未完成；其余本地证据已通过 |
| 提交 / 推送 | 已授权；本文档所在提交完成后执行，最终 SHA 见交付消息 |
| 合并许可 | 未授权，不合并 |
| 发布许可 | 未授权，不打 tag、不发布 |
| L1 字体许可 | 已核验定案，阻断解除（证据链见 pdf-font-license-verification.md）；分发形态变化须重核 |
