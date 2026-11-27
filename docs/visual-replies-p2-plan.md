# Visual Replies P2：集成计划与证据门槛

## 基线与授权

- 任务日期：2026-11-27。
- 集成分支：`feat/visual-replies-p2`，从 `origin/main` 的 `dfdc1ddea060d8c369e5e0932d052655baa3d772` 创建。
- 保留 P1 架构；不开发 MCP Apps，不提前开发 P3（preview/headless/自动截图反馈/外部资源代理）。
- 用户授权完整 P2、并行子 Agent、提交及最终推送本次分支；未授权合并、发布、修改全局 Pi、增加依赖或使用未明确授权的模型凭证。
- 原根工作区不动。所有会写入的测试使用 `os.tmpdir()` fixture，不修改真实项目、原生会话、全局配置或凭证。
- 禁止 `--no-sandbox`、关闭 webSecurity、打开 nodeIntegration、放宽安全策略。不能把启动、fake Pi、语法检查或静态截图当作真实模型/安全/Visual Replies 验收。

## 执行阶段

1. 核对基线、活跃开发、准确 SHA 的 CI 和定向基线，输出各领域勘察结论。
2. 五条实现线并行工作，各自 worktree 和有界文件所有权；先报拟用接口与偏离，后写代码。
3. 主 Agent 仅统筹架构/接口/集成/冲突，不替代子 Agent 实现。
4. 按回滚边界集成，经真实 Electron、真实 Pi 契约及授权可用模型、正式构建、定向和核心回归取证。
5. 新上下文独立功能与安全审查，最多三轮收敛；阻断项不得隐瞒。
6. 推送分支，最终报告逐项说明完成、未验证和阻塞；无批准不得合并/发版。

## 阶段状态与阻断记录

- 已核对准确基线 CI `45952490979`：push / attempt 1 / head SHA `dfdc1ddea060d8c369e5e0932d052655baa3d772`，五组、build 和最终 gate 成功。该证明只覆盖基线，不覆盖 P2。
- D 的首个接口提交 `52900f2b310670f16566f9b69c6faa48bb669a06` 已集成为 `7b82599f`；仅代表最小消息、host 高度限流和可见性接口，不代表 D 已完成。
- C 已重新取得 T3 main 源码 `d20571f9b9fa35da087e916713f6bac05ac9d1f4`，具体对照与限制由 C 报告，不从旧 P1 参考继承结论。
- A 使用同版本同摘要的离线 Electron 副本，在正常沙箱执行首轮实际安全测试，报告为 **28/29，completed=false、failed=1**。`self-navigation-denied-blank` 未通过；报告位于 `C:/Users/21022/AppData/Local/Temp/pi-html-artifact-security-ymlgeK/report.json`。这不是安全验收通过，也不是最终 P2 产物证据。
- A 后续运行被模型服务明确拒绝：`API Error: Request blocked by cyber policy.`。该安全执行线已停止；不得通过换模型、代理或改写同一测试规避拒绝。未完成的隔离问题和安全矩阵保留阻断状态。
- A1 另行负责未被阻断的普通功能：真实 Pi 无模型契约、带显式授权门控的 live 驱动、六类良性样例及普通交互验证。**不接替 A 的恶意 HTML、逃逸或外传研究**；A1 结果不能算安全专项通过。
- E 测试基建与证据文档已集成（`b4792be4`、`2152728b`）；原 355 个 canonical 叶命令全部保留，新增 backend/process/CI 注册守卫后为 358 叶。主 Agent 核读基线结构化摘要，确认 355/355、失败/跳过/未完成均为 0；这仍只证明 P1 基线。
- 集成检查补正手动工作流的临时目录初始化顺序（`99d8ac82`）：新增断言修复前 8/9、修复后 9/9，skip 0、exit 0。仅证明配置守卫，不证明实际沙箱安全。D 等新套件到齐后仍需补注册与集成回归。
- 未执行的工作流、真实模型、最终 canonical 和正式构建均不得填为通过。新增 workflow_dispatch 文件尚未进入默认分支时，不能声称可以在当前 PR 中已完成 dispatch。

## 续接记录（2026-11-27）

- 原父会话因服务 100 轮上限停止；续接仅恢复既有 P2 工作树，不修改根目录设置分支及其未跟踪文件。
- 用户再次明确：A1 仅普通功能边界，不碰 A 安全 suite/文件，**本次不调用模型**。C 继续现有实现和正常沙箱良性验证，不重启 A 安全研究。此前 `about:blank` 首次失败及服务拒绝保持未解决，不换代理绕过。
- D 后续四个原始提交按顺序集成为 `7224c87a`、`9d946b4f`、`d1cb0581`、`2d818cc4`；已集成的 `52900f2` 不重复获取。D 的 75/75、98/98、23/23、17/17 仅为其交付文件树的定向证据，不等同最终集成结果。
- C 首个产品提交 `7a30c5f0` 集成为 `98ee052c`；普通 UI 测试适配与独立良性 Electron 驱动 `1d4bec0d` 集成为 `0aacdb53`。C 交付普通 UI 20 项/169 断言，原 13 项/111 断言保留；联合 D 38 项报 58/58。这是修复 R-D 发现前的定向证据；T3 对照与最终真实视觉文档仍待交付。
- B3 专属分支读取回归报告 17/17（16 行为子项+父容器）、372 断言；组合 backend/model 63/63，相邻 edit-target 20/20、service 49/49、HTTP 11/11。提交及主树注册仍待交付。父核对 `session-navigation.js` 后保留其有意的 bounded text-only 只读预览契约，不扩成执行时间线；该页的可视化 UI 是 P1 既有范围差异，不能以 API 历史读取+共享 viewer 回归宣称该页已支持。活动 Classic 恢复及 Runtime live/dormant 的实际渲染链与它分别记录。
- A1 良性样例提交 `a6247de7` 集成为 `a2cdaeb0`。真实 Pi 无模型契约 13/13 的 TEMP 证据由 A1 收尾，明确包含 synthetic assistant setup，不是模型调用验收。
- B 原代理结束时尚未产生提交，不能按界面 completed 当作开发完成。新增 B2 收尾存储/锁/维护/性能，B3 独占新增分支读链回归测试；共享 B 工作树但文件所有权分离，不替对方提交。
- E2 首批登记已直接提交到集成树 `3584bcd2`：新增 D 三套及 A1 normal 共四叶，canonical 358→362，原叶删除/重复/换组均 0。新增测试 45/45、CI 守卫 12/12、test:ci 10 叶 exit 0；Store 135/135 场景、529 assertions、另 skip 3。该运行当时旧 UI 10 pass/3 fail 原样记录，之后才集成 C 适配 `0aacdb53`，不得混称同一次运行通过。B/A1/C 后续新入口仍须逐项登记。
- R-D 已完成首轮只读独立审查，四项 Important 待修，见下节。最终完整 canonical、真实视觉、正式构建及整体独立验收仍待完成。

### 首轮独立功能审查（R-D）

- 审查范围：`dfdc1dde` → `a2cdaeb01ad50ed4cad5f82f08361d5f707546a4` 的 D 模块与当前 C dialog 调用边界；结论 **不通过**，Blocker 0 / Important 4 / Nit 0 / Pre-existing 0。均为良性普通功能复现，不是安全资格结论。
- RD-1：自然高度反馈 hold 误锁 CSS transition；200→600px 的内容最终 frame 207px/capped，基线 frame 600px。**未解决**，D2 负责。
- RD-2：全屏消费者用 naturalHeight 绕过 hold；静态 `calc(100vh + 10px)` 在全屏持续增高。**未解决**，C 负责，不得仅以 65536px 上限当作修复。
- RD-3：12000px 长内容全屏往返，iframe 内部 scrollY 7904→0→0，同 realm 和输入状态仍存。**未解决**，C 与 D2 配合 presentation 协议；宿主发消息后立即改尺寸存在先 clamp 后保存的竞态，必须保证保存完成再切换，不授予宿主滚动能力。
- RD-4：`clearInterval(String(handle))` 未按原生接口转换句柄，interval 残留。**未解决**，D2 负责。
- 证据：`C:/Users/21022/AppData/Local/Temp/pi-gui-rd-review-zhpvD1/report-final.json` 与同目录 `benign-functional-probe.cjs`；Chrome 158.0.8127.88、页面异常 0、源摘要无变化。R-D 未运行 Electron/A 安全 suite/Pi/模型/产物或完整 canonical。
- C 首轮正常沙箱良性 UI 报 22 checks、9 截图，生产 main/preload/native 注册、四组宽窄深浅及 DPR 1.5；证据 `C:/Users/21022/AppData/Local/Temp/pi-visual-replies-zhKjh1/evidence/viewer.json`。其中样例约 4008px，**不能覆盖 RD-3 的 >4096px 场景**；修后须补相应良性回归及增量独立复审，不能沿用本次通过数字。
- 新增 D2 在原 D 工作树修复 RD-1/RD-4，并与 C 对齐最小协议：resize 可选 `feedback:boolean`；仅显式 false 才消费原始 naturalHeight，true 保持全屏高度，缺字段 v1 仅采用 height。presentation/presentation-ready 均严格六字段 schemaVersion/id/nonce/type/expanded/sequence（正安全整数）；true 在本 realm 同步保存后 ACK，C 等 ACK 后才改几何；false 先恢复内联几何，再由 frame 双原生 rAF 恢复内部滚动后 ACK，不受受控 runtime 暂停影响。该契约待实现与回归，不等于发现已修复。超时/过期 ACK 不得继续切换几何或污染下一次展开。
- 最多三轮审查原则不变，未修复 Important 不得验收通过。

### B3 测试交付依赖

- 测试提交 `2cd34ec2e855c71364e4b58ca78dc642347b6832` 仅含 branches 套件及专属 fixture，尚待与 B2 产品改动成组集成；新增叶为 `node --test tests/html-artifact-branches.cjs`，fixture 不注册。
- B3 最终同树组合 backend/model/branches 为 63/63、exit 0、9216.1951ms；branches 17/17、372 实际断言、8623.2296ms，skip/fail/cancel/todo 0；相邻 target 20/20、service 49/49、HTTP 11/11。**该证据包含 B2 当前未提交产品树，不证明单独获取测试提交后的主集成树已通过**；必须取得 B2 产品提交后在主树补验。

## 子 Agent 文件所有权

| 线 | 所有权 | 禁止无序交叉修改 |
| --- | --- | --- |
| A：真实 Pi / Electron / 安全 | `tests/visual-replies-electron.cjs`、`tests/html-artifact-electron.cjs`、其专属 fixture、新的真实契约/安全测试、`electron/html-artifact-security.cjs`、必要的 Electron 主进程局部改动、A 证据文档 | 不改 package/CI、后端 Store、公共 viewer/frame。需要新协议先报告。 |
| B：Store / 分支 / 维护 / 锁 / 性能 | `server/html-artifact-*.js`、`server.js` Artifact 初始化局部、`public/messages.js` 中 Artifact 授权 scope 的最小改动、必要的后端会话引用读取调用点、Store/backend/process 专属测试、B 文档 | 不改公共 viewer/frame/CSS、package/CI、Electron。 |
| C：T3 对照 / 全屏 / 缩放 / 图片链接宿主 | `public/html-artifact-viewer.js`、`public/html-artifact.css`、新增 viewer/dialog/controls 模块、对应 viewer/UI 专属测试、T3 参考文档 | 不改 frame/theme/activity、reading-position、会话流/后端、package/CI。 |
| D：iframe / 高度 / 滚动 / 主题 / 生命周期 | `public/html-artifact-frame.js`、`public/html-artifact-theme.js`、`public/html-artifact-activity.js`、`public/reading-position.js`、必要的既有滚动模块局部、独立 layout/lifecycle helper、新的 D 专属测试、D 文档 | 不改 viewer/CSS、messages.js、Electron、package/CI；先输出供 C 使用的接口契约。 |
| E：canonical / CI / 基线 / 覆盖矩阵 | `package.json`、必要的 CI 及 `scripts/test-*` 局部、CI 回归测试、新的覆盖验证测试、总体验收索引及 E 文档 | 不改 A-D 的产品实现/专属测试。最终独立审查另派新 Agent，不能自审通过。 |

每条线必须先读本 worktree 的 AGENTS.md、REVIEW.md、docs/README.md 和相关规范。UI 线先读 design-system。每个子 Agent 自己执行，不再分派。只提交自己所有的文件，不推送、不建 PR、不合并。提交中文信息，使用 `git rev-parse --git-path COMMIT_MSG_TMP.txt` + 写文件 + `git commit -F`；末行 attribution 按本轮宿主规则。

## 不可退让的接口与安全约束

- Artifact 身份（id、原始 session、摘要、不可变 HTML）与当前授权引用 scope 分离。分支读取由后端依据有效原生引用授权，不复制 HTML，不移除身份检查。
- iframe 保持 opaque origin、最小 sandbox、CSP/Permissions Policy、Electron 原生请求/导航拦截。全屏不增加权限。
- 跨 iframe 消息必须严格验证 source、origin、schema/type、Artifact id、nonce、字段类型、长度；高度消息须有界且限流。图片/链接不能成为通用 IPC 或请求代理。
- C/D 在写入前说明接口：frame bootstrap 提供何种 resize/escape/image/link 消息，viewer 负责何种 host 校验；谁持有 resize、lazy mount、dispose。保持兼容现有消费者和测试。
- 优先保留可见 iframe 实例及交互状态。全屏、主题、缩放不能强制跳到底部；持久快照与临时交互状态需明确区分。
- GC 只有完整引用+回收站/可恢复分支+Agent 发布窗口+并发互斥得到证明才可删。否则提供 fail-closed 的显式静默维护与可操作路径，禁止假装自动 GC 已安全开放。
- 锁恢复不能只依赖 PID 存在或年龄；可靠进程身份/所有权无法证明时拒写且给出恢复办法。
- Store 性能先测后改，优化不得取消读取摘要校验；提供前后同口径测量。

## 验收矩阵

### P1 遗留（逐项证明）

- 真实 Pi 驱动：工具发现、真实模型实际 html_render、发布、Electron 展示、JS、后续流式文字、会话切换、应用重启。无明确可用模型时完成真实 Pi 工具契约+可重复 live 驱动，并标真实模型未完成。
- Electron 安全：宿主 DOM/preload/IPC/Node/文件/凭证存储；localhost/私网/外网；Fetch/XHR/WS/RTC；Worker/SW；嵌套 realm；导航/重定向/弹窗/下载；伪造消息；跨 Artifact/session；滚动/资源攻击。网络采用受控监听器+已到达的正向对照，禁止只看函数返回值。
- 全局请求拦截：不破坏正常 Browser、文件预览、认证、代理等既有功能。
- 分支继承：branch/copy/edit-resend/history switch/original deletion/inherited restore/illegal cross-session；前后端真实读取链回归。
- GC：活跃引用、垃圾箱、运行中、发布未持久化、中断孤儿、扫描删除竞争、容量统计、合理错误。
- 锁：正常退出/崩溃/强杀/中断/临时文件/PID 复用/同时启动/旧 owner 存活/无法确定身份。
- 性能：大量历史、多会话并行、before/after 数据、完整性恢复。
- CI：backend/process 纳入唯一 canonical 链；新测试分组可发现；Electron 和 live 独立入口，条件与结果不混淆。

### P2 功能

- T3：重新核对当前可用仓库，记录 SHA；HtmlRenderFrame/BrowserDocumentFrame/Dialog/Timeline/协议/滚动/图片缩放/测试/历史 issue PR。源码实际路径为准，无法获取运行效果不得假造。
- 轻量悬浮展开，无新大工具栏/重复标题/多层卡片；全屏关闭/Escape/焦点/窗口适配/长内容/主题/清理/多个 Artifact。
- 放大/缩小/重置/适配宽度、窄宽屏、DPI；区分页面响应式与查看器缩放。
- 动态高度：首次、字体/图片、JS/折叠/表格、连续更新、宽度、全屏、隐藏恢复、超过 4096 的明确内部滚动；合并与限流。
- 滚动：生成跟底、主动阅读停止、iframe 滚轮、内外长滚动、变高锚定、多 Artifact、全屏返回、主题、历史分页、原跳底按钮。不得改满意的思考动画/跳底按钮视觉。
- 图片/SVG/Tooltip/表单按钮/动画/表格交互，安全且需用户动作的链接；无 CDN/外部资源代理。
- 深浅主题、首屏背景、图表对比及冗余系列标记；复用 Token/Icon/Button/Modal。
- 多 Artifact/并行会话/后台/分页/历史 iframe/切换/最小化/全屏/退出资源；不得添加 Agent 并发数量限制。

### 真实样例与证据

七类：仓库整理前后报告；bar/line/pie；SVG 架构；筛选器/按钮面板；长表动态展开；内嵌图片；恶意 HTML。
正常样例矩阵：会话内/全屏/缩放 × 宽窄 × 深浅 × 动态高度/滚动/多 Artifact/会话切换/重启。
证据必须来自实际 Electron，优先正式产物。每次运行记录 SHA/未提交差异、平台、真实安全参数、入口、视口/DPR、步骤、数字、退出码、首次失败与截图。任何未做的组合写未验证。

## 交付报告必须包含

T3 SHA/路径/差异；P1 每项状态；新功能与关键文件；安全模型和实际安全证据；真实 Agent 记录；深浅/会话内/全屏/响应式截图；性能前后；测试命令/实际计数/skip；canonical/CI；分支/提交/PR（未创建则明示）；未完成/阻塞/影响/后续；P3 衔接；可执行回滚。
