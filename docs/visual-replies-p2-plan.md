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
