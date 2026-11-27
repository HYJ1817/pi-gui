# Visual Replies P2 D：高度、主题、阅读与 iframe 生命周期

## 1. 交付身份与范围

- 日期：2026-11-27；分支：`feat/visual-replies-p2-d`。
- before HEAD：`dfdc1ddea060d8c369e5e0932d052655baa3d772`。工具初始分支保留，未 reset；不能快进时在准确父基线上新建分支。
- 基线 CI：[45952490979](https://github.com/HYJ1817/pi-gui/actions/runs/45952490979)，push、attempt 1、head SHA 同上；core/ui/security/native/faults、Electron build、CI gate 均 success。只证明基线，不证明 D 新行为。
- D 负责 frame/bootstrap、theme、reading-position 与独立 helper/测试。C 唯一持有 viewer 的 mount/register/dispose/fullscreen/zoom；A 负责正常沙箱 Electron，E/父 Agent 负责唯一 canonical。D 未改 viewer、独立 CSS、messages、后端、Electron、package、CI 或 `tests/html-artifact-ui.cjs`，未再分派。
- 无新增依赖、下载、真实 Pi/模型调用、真实用户数据写入或 `--no-sandbox`。D fixture 为内存 DOM/时钟；如需写盘须用 `os.tmpdir()`。

### 提交边界

| 提交 | 内容 |
| --- | --- |
| `52900f2b310670f16566f9b69c6faa48bb669a06` | host 高度/可见性 helper、最小交互协议、初版文档 |
| `7a4a218377aba6ac2a8b1b1308c0bb21170d6533` | 测量、受控 runtime、本 frame 滚动、theme、可见性自身观察 |
| `b6387bd1bb3361e689f4f15dbdd17804b0b7d97d` | 稳定 Artifact 阅读锚与透明线程包装穿透 |
| `5506aaa692d50055648e41f18ea908cdd4b32bf5` | 三个 D 专属套件与确定性时钟 |

本次报告提交仅补证据，无产品行为变化。after HEAD 为包含本版报告的交付提交，用 `git log -1 --format=%H -- docs/visual-replies-p2-d-acceptance.md` 解析；确切 SHA 另见最终交付消息。后续更新须保留上述原行为/测试身份。

最终定向运行发生在 `52900f2b` 加待提交 diff；相同 public/tests 文件随后原样进入上述后续提交。不声称在报告 SHA 上运行过新 CI。

## 2. 勘察结论与实现

复用 P1 opaque srcdoc、前置 CSP/网络与 RTC 锁、v1 消息、Token 快照、reading-position 与 Classic/Runtime 显式 follow owner；不另造 viewer 资源 owner、全局跟随状态或 HTML 缓存。C 原地 dialog/缩放独立集成。

### 高度与双端限流

- `public/html-artifact-measure.js`：序列化到 frame 的测量 helper。读取自然 body box/scrollHeight，不把 documentElement 的视口基数回送宿主。字体、图片 load/error、输入、details toggle、DOM/text/style mutation、ResizeObserver 与窗口宽度变化合并重测。
- v1 envelope 保持 `{schemaVersion:1,id,nonce,type}`；`ready`、host → frame `theme` 不变。`resize.height` 仍为 80..4096 CSS px，新增 `naturalHeight/naturalWidth/capped`，自然尺寸上限 1,000,000。超高内容保留 iframe 内滚动，不裁断 HTML。
- 帧内最多每 100ms 发一次尺寸；相同快照不重发，零宽/非有限尺寸不覆盖正常尺寸。没有内容/字体/宽度修订时，由宿主分配视口引起的尺寸反馈保持原高度，重复观察不解除 hold；余量内部滚动。
- `public/html-artifact-layout.js`：`createHtmlArtifactResizeController({view,apply,isCurrent})` 返回 `accept/flush/dispose`。C 先完成身份校验再交完整对象；兼容仅 height 的 v1。host 同样最多每 100ms apply，保留最终值，重复快照不写 DOM，flush 不绕限流，dispose 幂等取消待办。直接 postMessage 也不能绕过 host 写入限流。
- `apply({height,naturalHeight?,naturalWidth?,capped})` 仍由 C 在自己的 preserveLayout 内执行；全屏/缩放显示高度不充当自然高度。

### 可见性、生命周期与临时状态

`createHtmlArtifactVisibilityController({node,onVisibility,document})` 返回 `refresh/dispose`。IO 的 600px 预热区用于惰性 mount；document hidden、节点/祖先隐藏、折叠 details 通知 false，无 IO 时退为 eager。helper 仅通知，不 mount/unmount/register/release。C 向同一 frame 发 v1 `visibility {visible:boolean}`，**ready 后须重发当前值**；C 仍是唯一销毁 owner。

`public/html-artifact-runtime.js` 管理受控 timer/rAF：每 frame 最多 256 pending callbacks，interval 最小 32ms，隐藏保留剩余延时，恢复不追赶积压；保留 callback this/参数/清除语义。帧内 CSS 与当时运行的 WebAnimations 暂停，测量观察器断连；恢复同 document，不丢筛选/表单。pagehide/unload 清理待办。它是合作式资源管理，**不是 CPU 沙箱**，不承诺冻结同步循环或所有原生异步能力。

持久 HTML 快照与临时交互状态分离：保留 iframe 时保留交互；Runtime 离开后沿用 P1 dispose/重新授权读取，不承诺重建后恢复临时状态，不新增 HTML 缓存或修改全局 Agent 并发。

### 阅读位置与主题

- `public/reading-position.js` 增加 `artifact-<id>` 稳定锚，穿过透明 thread/layout 包装，保存 ID+视口 offset。生成是否跟底仍由 Classic/Runtime 显式决定；用户上读、全屏/缩放/主题布局不因此强拉到底。不进入 iframe DOM。内存 LRU 100、不写持久存储、思考动画与回到底部控件均不变。
- `public/html-artifact-scroll.js` 约束 programmatic scrollIntoView/focus 仅调整本 document 内部容器，处理 nearest/start、margin/padding、内部滚动与 fixed；focus 使用 preventScroll。不是原生跨 frame wheel 的验证结果。
- `public/html-artifact-theme.js` 扩充表面/前景、ring、状态、code 等变量，全部复用 pi-GUI Token；muted-foreground 使用正文辅助色。首屏主题在解析模型内容前设置，后续主题/字体更新不重建 iframe。真实深浅/透明叠层对比与白闪仍待渲染验收，不声称 AA 或任意硬编码模型样式自动合规。

### 最小交互与安全边界

nonce 防串 frame，不认证同 realm 脚本。C 的 source/opaque origin/schema/id/nonce/类型/长度校验、限流与动作授权不能由 bootstrap 替代。

- `escape` 仅请求关闭当前查看器；bootstrap 与 host 各自限流。
- `link {href}` 最多 2048 字符，只绝对 HTTP(S)，无 credentials/控制字符。bootstrap 捕获 trusted click 仅作防御深度；host 再验证与确认，不把消息当点击授权。
- `image {src,alt}`：src 最多 2MiB 字符，仅 data PNG/JPEG/WebP/GIF base64；alt 最多 256。host 再查 magic/像素，不注入 SVG/HTML，不读取 URL。
- **无 wheel 消息或宿主滚动 RPC**。跨 frame 滚轮仅原生 scroll chaining/overscroll auto；不可靠时报告限制。
- CSP、sandbox、网络/RTC 锁保持原边界，在模型字节解析前验证锁；helper 安装失败不解析模型。顶层锁不证明所有新文档安全，native guards 仍必需。

A 报告的 `self-navigation-denied-blank` 失败仍未解决，后续研究被 provider policy 阻断。D 未接替或换模型重做该研究、未做恶意 realm 实验/DOM 插入绕过 monkeypatch，也不以源码/jsdom 回归把该失败放行；本线交付不代表取得安全资格。

## 3. T3 只读对照

复用 C 已取得的参考源码，未另行下载或执行第三方代码：

- main SHA：`d20571f9b9fa35da087e916713f6bac05ac9d1f4`。
- 本机位置：`C:/Users/21022/AppData/Local/Temp/pi-gui-p2-c-t3-reference-afc8ce7c41644f07a39ac2b688c3ef71/source`。
- 读取 `packages/shared/src/htmlRender.ts` 的自然高度/主题变量/contained scroll、`apps/web/src/components/chat/HtmlRenderFrame.tsx` 的高度缓存，以及 pageScrollController/timelineScrollAnchoring 的 container-only、稳定 ID+offset 思路。
- 历史修复：`4c679a21e73f998832d2c32f9e16078aca28e2c5`（#38832，本地 programmatic scroll）；`70e4319da82f75240cba6b47956e77b5bde611ee`（#38458，切回高度缓存）。
- 本线独立实现同类局部边界，不搬 React/品牌/整套滚动控制器；不照搬会重建 iframe 的 dialog/zoom，不改变 P1 私有快照授权或引入 HTML 缓存。

## 4. 定向验证

环境：Windows 11、Node `v24.22.1`；命令仅设置 `NODE_PATH=C:/pi-GUI/node_modules` 复用既有 jsdom，不安装依赖。jsdom 与受控几何只证明行为契约，不证明像素布局、真实 wheel、正常沙箱 Electron 或网络隔离。完整输出留在本会话工具记录，以下是可复核关键摘要。

三个新套件交 E/新父纳入唯一 package test 链（D 不修改 package/CI）：

1. `node --test tests/html-artifact-layout.cjs`：12 个测试用例，host 限流/合并/非法维度/owner/dispose、惰性可见性。
2. `node --test tests/html-artifact-frame.cjs`：14 个，测量/反馈/隐藏/定时器/首屏主题/v1/临时状态/合成点击。
3. `node --test tests/html-artifact-reading.cjs`：12 个，阅读跟随/稳定锚/多会话/分页、本 frame 滚动焦点。

共享 `tests/fixtures/html-artifact-d-clock.cjs` 不独立注册。旧 UI 13 个和 security 24 个用例未删除；新增 38 个。后续只增加回归断言，没有减少用例或丢弃失败。

### 基线、首次失败与修复历史

| 运行 | 实际结果 | exit / 耗时 |
| --- | --- | --- |
| 首次旧 UI 基线 | 缺 jsdom，0 pass / 1 failed file；随后用既有 NODE_PATH | 1 |
| `node --test tests/html-artifact-ui.cjs` 基线 | 13/13，skip 0 | 0 / 2926.3442ms |
| `node --test tests/html-artifact-security.cjs` 基线 | 24/24，skip 0；离线 mock，不是新真实安全资格 | 0 / 245.2025ms |
| bootstrap 修改后旧 UI | 13/13，skip 0 | 0 / 2771.53ms |
| 新 D 三套件首次 | 38/38，skip 0 | 0 / 727.8763ms |
| 中间旧 UI+D 三套件 | 51/51，skip 0 | 0 / 2746.986ms |
| 自查新增 duplicate-RO 回归，filter `viewport-dependent height feedback` | 0/1，`340 !== 330`；确认重复观察释放 hold | 1 / 835.2597ms |
| 修 hold 后，filter `viewport-dependent\|runtime pauses` | 1/2；hold 已过，callback this 为内部 record 而非 window | 1 / 520.6071ms |

修复：反馈状态持续到内容/字体/宽度修订，不被重复观察解除；timer/rAF 用 window 作为回调 this。新增回归均在最终联合运行通过。filter 运行不代表全套用例数量减少。工具 JSON 截断失败均未修改文件，改为较短调用后成功，不属于产品测试失败。

### 最终相同文件树的实测结果

```powershell
$env:NODE_PATH='C:\pi-GUI\node_modules'
node --test tests/html-artifact-ui.cjs tests/html-artifact-security.cjs tests/html-artifact-layout.cjs tests/html-artifact-frame.cjs tests/html-artifact-reading.cjs
```

**75/75 个 node:test 用例，fail/cancelled/skipped/todo 全部 0，exit 0，2808.4209ms。** 其中旧 13+24、新 12+14+12；包含旧 bootstrap 锁失败不解析模型的回归，不等于真实 Electron 隔离通过。

| 相邻定向命令 | 最终实测结果 |
| --- | --- |
| `node tests/session-ux-phase2.cjs` | 98/98 断言，failed=0，exit 0；脚本不输出耗时/skip |
| `node tests/conversation-flow.cjs` | 23/23 用例，skip 0，exit 0，2134.7587ms |
| `node tests/session-ux-p5-ui.cjs` | 17/17 断言，exit 0；脚本不输出耗时/skip |
| 对 7 个变更 public 模块、3 个 D 测试和 clock 逐个 `node --check` | 11 文件，exit 0 |
| `git diff --check` | exit 0 |

较早相邻一轮同样为 98/98、23/23（2148.8249ms）、17/17，exit 0。最终结果如上，不以旧数字代替新行为验证。

## 5. 未验证、风险与回滚

- **完整 canonical 未运行**：D 不改 package/CI；新父负责登记新套件并按 E 方案完成唯一完整证明，结果前标待验证。
- **独立功能/安全复审未运行**：D 未再分派，作者自查不冒充独立审查。涉及 bootstrap/隔离边界，按 REVIEW 属高风险，仍需独立审查与用户明确审批。
- **实际渲染/Electron 未运行**：全屏同实例、缩放、窄宽与深浅四组合、首屏白闪、真实对比度、原生 wheel 链、最小化/后台资源、真实 Pi 与截图均交父/A 集成取证。受控几何中的“fullscreen placeholder”不是 C 真实全屏验收。
- **产物未重建**：D 未运行 build:exe 或 build:app -- --rebuild，父集成后统一构建；当前**跑源码版才看得到**，不宣称现有打包产物已更新。
- A 的 about:blank 失败仍是未解决项，不因本线 75/75 或轮次限制放行；不开展被阻断研究的替代路线。
- runtime 仅合作式暂停，viewport 反馈策略及本 frame 滚动/焦点的真实 Chromium 行为仍需良性集成验收。可见性 helper 观察初始祖先链，若将来移动 frame，C 须刷新/重建该 helper；当前原地 dialog 不移动 frame。

回滚以提交边界反向回退 D 测试、reading 与 runtime 行为；保留不相关工作。C 的 helper import/调用与消息集成须同步回退，维持 v1 ready/theme/resize。随后重建产物；无需迁移 HTML、会话或用户数据。不得用 reset 丢弃其他工作。

结论：**D 普通行为实现与专属定向测试完成；代码验收待验证；未取得推送、PR、合并或发布许可。** 已向父/C 交付提交与 helper 契约。父线程接管后，后续提交和登记通知新父；本报告不替代安全资格。

## 6. D2：R-D 普通功能发现的定向修复（2026-11-27）

本节补后续证据，不把 D 首次交付的「未运行」追记成当时已通过。D2 接手同一既有工作树与分支，before HEAD 为 `dfd2893310c99eb4d3e794578dde1e9850115d74`；未创建工作树、未改根工作树产品文件。fetch/tag/Release 已核对，最新 Release `v0.35.1`；再次只读核对 run [45952490979](https://github.com/HYJ1817/pi-gui/actions/runs/45952490979)：push、attempt 1、head `dfdc1ddea060d8c369e5e0932d052655baa3d772`、success。这仍只证明原始基线，不证明 D2。

### 6.1 勘察与处置

复用 measurement、双端限流、runtime、bootstrap 与 C 的唯一 viewer owner。未改 C dialog/CSS/interactions、Electron 驱动、package 或 CI。先读 R-D 的 `benign-functional-probe.cjs`，确认只写 TEMP profile/report、只访问 loopback、只读生产文件；未执行原文件以免覆盖原证据。出处：`C:/Users/21022/AppData/Local/Temp/pi-gui-rd-review-zhpvD1/report-final.json`，集成树 SHA `a2cdaeb01ad50ed4cad5f82f08361d5f707546a4`。

- **RD1 Important：已修复，作者验证通过，独立复审待验证。** 原报告 body 600 但 frame 207/capped。固定 viewport 下的后续尺寸变化不再视为宿主反馈；transition/animation 完成或取消触发独立修订以保留最终值。重复相同 RO 不释放 hold。
- **RD4 Important：已修复，作者验证通过，独立复审待验证。** timer 清理执行原生 Web IDL long 转换，包括数字字符串、valueOf、截断、模运算与 Symbol/BigInt 抛错。clearTimeout/clearInterval 共用 timer 池，rAF 使用 unsigned long 且清理类别分离。
- **RD2、RD3 Important：C 负责，D 不宣称完整问题已解决。** D 提供 feedback 与本 realm 阅读握手；最小 host 的真实良性证明不能替代 C viewer 全屏集成与复审。

### 6.2 唯一接口（写前已发父/C）

`resize` 增加可选 `feedback:boolean`，measurement 发出明确布尔，layout 校验并保留。`naturalHeight` 仍是原始遥测，不是任何情况下可写回几何的权威值。C 仅在 `feedback===false` 时消费自然高度，`true` 保持已提交 expanded 高度；缺字段旧 v1 只采用 `height`，不由 raw naturalHeight 扩高。未添加第二个 acceptedNaturalHeight/layoutHeight 契约。

host → frame 严格六字段：

```js
{ schemaVersion: 1, type: 'presentation', id, nonce, expanded: true, sequence: 1 }
```

frame → host ACK 仍六字段，只有 `type` 改为 `presentation-ready`，其余回显。`expanded` 为 boolean；sequence 为严格递增正安全整数；frame 检查 parent source、host origin、schema/id/nonce、精确字段。C 须另查 opaque origin/source/id/nonce/strict schema 与 pending expanded/sequence；nonce 不是同 realm 脚本认证。

- true：本 realm **同步保存** scrollX/Y 后立即 ACK。C 收到匹配 ACK 后才 showModal/修改宽高，不能把 postMessage 的发送顺序当作保存已完成。
- false：C 先还原 inline 宽高再发送，frame 双原生 rAF 后用本 realm scrollTo instant 恢复 XY，再 ACK。不传 XY、不操作 host 滚动，无 wheel/通用 scroll RPC。
- 原生 rAF/cancel/scrollTo 在 runtime 安装前捕获，合作式暂停不阻断 ACK/恢复。重复 true 不覆盖原 inline 位置；新序列取消旧待办；pagehide/unload 取消 restore 并清保存值。C 超时不扩尺寸、dispose 清 pending。原生 document hidden 的 rAF 节流仍由浏览器决定，不承诺后台窗口即时 ACK。

### 6.3 D2 提交与证据身份

| 提交（按序，只 commit 未 push） | 回滚边界 |
| --- | --- |
| `6989cecc82a737414e692573a25fc364b8d17534` | measurement/RD1、layout feedback、frame presentation 接口 |
| `bcd0fa9b125691d4b381fda66c4983b4ecfe775a` | runtime/RD4 原生句柄转换 |
| `96818f9f88211b24589566b58e9b7a800fb08e03` | 新增六个测试，保留全部旧断言 |

联合 Node 验证在第二个产品提交加原样测试 diff 上运行；相同 public/tests 文件进入 `96818f9f`。两个真实渲染报告绑定 `96818f9f`，有逐文件 SHA-256，结束 `sourceChanged=[]`。本节只补文档；报告 SHA 用 `git log -1 --format=%H -- docs/visual-replies-p2-d-acceptance.md` 解析，最终交付消息给出实测值。

### 6.4 Node 与真实良性验证

TEMP 根：`C:/Users/21022/AppData/Local/Temp/pi-gui-d2-benign-UNIkh3`。所有 profile、脚本、报告、截图只写该独立 TEMP；没有下载、调用 Pi/模型、修改共享安装或安全文件。正常 Electron 私有目录为 `C:/Users/21022/AppData/Local/Temp/pi-parallel-electron-dist-uB45iF`，局部指定 `ELECTRON_OVERRIDE_DIST_PATH`，删除 `ELECTRON_RUN_AS_NODE`；没有 `--no-sandbox`。该 electron.exe SHA-256 为 `bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`。

Node 命令均局部 `NODE_PATH=C:/pi-GUI/node_modules`，复用既有依赖：

| 运行 | 结果（skip 单列） | 耗时 / 证据 |
| --- | --- | --- |
| 修前旧 UI + D 三套件基线 | 51/51，fail 0，skip 0 | 3185.3341ms |
| 新测试先跑 frame/layout、未改产品 | 26/32，fail 6，skip 0 | 824.9615ms；`node-before.log` |
| 接口过滤 transition/feedback/presentation 首次 | 5/6，fail 1，skip 0 | jsdom 跨 realm 对象原型差异，不是字段值不符；仅在新断言展开对象后比较，未删除断言 |
| 接口过滤复验 | 6/6，fail 0，skip 0 | 601.1942ms |
| 修后旧 UI + D 三套件 | **57/57**，fail/cancel/skip/todo 均 0 | **3072.3845ms**；`node-after.log` |
| timer-clock 精确 96ms | 旧 3 次/pending 1 → 新 0 次/pending 0 | `timer-clock.json` |
| session-ux-phase2 | 98/98 断言，failed 0 | 脚本不输出耗时/skip |
| conversation-flow | 23/23，skip 0 | 2366.972ms |
| session-ux-p5-ui | 17/17 断言 | 脚本不输出耗时/skip |
| 四个变更 public 模块 + 两测试 node --check | 6 文件，exit 0 | `git diff --check` 同为 exit 0 |

旧断言全部保留；51→57 是新增 frame 5、layout 1。新用例覆盖最终过渡/独立增长、稳定 hold 的显式反馈、句柄转换和互换、暂停时六字段握手与双帧恢复、拒绝与 dispose、feedback 投影；没有删除、skip 或减少旧断言。新测试与两产品提交的定向命令：

```text
node --test tests/html-artifact-ui.cjs tests/html-artifact-frame.cjs tests/html-artifact-layout.cjs tests/html-artifact-reading.cjs
```

两个实际浏览器运行仅加载 D 生产模块与 Token，host 是最小良性 fixture，不加载 C viewer、生产 Electron main/preload/native guards 或 A suite。

| 实际运行 | 结果 | TEMP 子目录 |
| --- | --- | --- |
| 已安装 Chrome 158.0.8127.88，headless，无关闭沙箱参数 | **21/21 checks，fail 0，skip 0，9 截图，pageErrors 0** | `chromium-TLzsAr/report.json` |
| 私有 Electron 44.4.3 / Chromium 152.0.7977.130，enableSandbox + sandbox:true/contextIsolation:true/nodeIntegration:false | **21/21 checks，fail 0，skip 0，9 截图，rendererGone 0** | `electron-7oajFG/report.json` |

每次都从 git 只读取得原 D HEAD 的模块作修前对照，再用 `96818f9f`。Chrome/Electron 修前 frame 分别 210/206，body 均为 600；修后在设定 1320×820、700×600 的深浅四组合中 frame/body 全为 600，feedback=false。`calc(100vh + 10px)` 在 ready 后 600ms 与再过 1300ms 比较，两次高度相同（330 或 340），feedback=true、raw naturalHeight 为 height+10；没有回到自增反馈。

原生 String(handle) 清 interval 实钟 96ms 为 0；旧 managed 两次、新 managed 0，实钟调度不要求等于确定性时钟的精确三次。暂停合作式 runtime 时 true save ACK 先于宽高修改；12000px 内容在同 realm/input 中 7904→0→7904；false restore ACK 来自双原生 rAF。无 ACK 超时保持 inline 几何不变。

每套截图为四组合各 transition/viewport，加 reading-restored；已实际读取代表截图，双语 fixture 文本可见，非空白启动。Chrome driver 设 deviceScaleFactor=1；Electron 逐组 DPR 未单独采样，PNG 保留原始像素尺寸。因此这些截图是 D 帧行为证据，**不是 C 产品完整 UI/交互状态验收**，也不是正常沙箱安全资格。完整脚本保留在上述 TEMP 根的 `fixture.cjs`、`chromium.cjs`、`electron.cjs`、`timer-clock.cjs`；重跑时 source 参数指 D 工作树，output 参数必须另给新建空 TEMP 目录，不覆盖原报告。

### 6.5 未验证、风险与回滚

- **完整 canonical、D2 精确 SHA CI、独立增量复审：待验证。** 父负责唯一 canonical；本线未再委派，没有把作者测试当独立批准。
- **A 安全资格仍未通过/本线未运行。** 没有重启 A suite 或开展替代安全研究；旧 self-navigation-denied-blank 问题不因本线普通功能通过被放行。即使父后续另有授权变化，本报告只覆盖这里的良性范围。
- **RD2/RD3 的 C viewer 最终产品证明：由 C/父负责，D 未验收。** 最小 host 的 ACK-before-geometry、暂停 restore、timeout 不变，仅证明本次 D 接口在良性真实浏览器可用。不证明 C 的全部 modal/zoom、原生 wheel、OS 最小化/后台调度、字体/主题白闪、对比度、真实 Pi/模型或恶意 HTML 隔离。
- **产物未重建。** 交父统一构建，本次仍是**跑源码版才看得到**；未运行 build:exe/build:app，不宣称既有包已更新。
- 回滚按边界撤销 D2 测试、runtime、接口提交；C 对 feedback/presentation 的集成须同步回滚，恢复 v1 height-only fallback。不要 reset 丢弃其他工作；无用户数据/会话 schema 迁移，回滚后重建产物。

D2 结论：**RD1/RD4 修复与普通定向验证完成；六字段接口已交父/C；代码验收待独立复审与 canonical；未取得推送、合并或发布许可。**
