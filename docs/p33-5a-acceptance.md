# P33.5a：安全会话撤销只读 GUI 集成验收报告

执行日期：2026-10-12 至 2026-10-13（Asia/Shanghai 客户端日期）。范围：证据摘要、内容候选预览、既存历史材料查询/比较/主动导出。**实际恢复未在新 UI 开放，P33.4 生产安全验收状态不变。**

## 1. 开发前后 HEAD 与工作区

- 开发前及交付 HEAD：`ab4a6801a18b32da9bb057cf4dde57f09ddc37bf`，没有自动提交、推送、发版、版本号变更或进入 P33.5b。
- 初始工作区仅有既存未跟踪目录 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`；未操作该目录。最终变更见 §2。
- 已核查 AGENTS、README、P33.1/2/3/4/4b 文档和实际 store/bridge/service/authority/API/会话/Git Changes/恢复界面。以实际协议为准。
- 按“不联网”约束没有 fetch、Release 查询、安装依赖或调用外部 Jev API；远端是否领先未验证。本地 HEAD 与用户确认基线相同。
- 首轮原测试链启动时为 104 个脚本，退出 0。开发过程中后半段读取过已修改源码，因此它是开发期间回归记录，不冒称完整独立的修改前快照。最终包含新增套件的链为 107 个脚本。

## 2. 修改文件清单

新增：

| 文件 | 职责 |
| --- | --- |
| `public/session-changes-panel.js` | 独立只读面板、中文原因、会话隔离、受限 diff、历史材料 |
| `server/session-evidence-admission.js` | 仅保存初始化 pending/ready/failed 状态的请求准入；不保存证据或身份 |
| `tests/session-change-query.cjs` | 真实 HTTP、store、认证、分页、历史导出和只读不变量 |
| `tests/session-change-ui.cjs` | DOM 交互、拒绝、迟到响应、共享工作区失效、导出并发 |
| `tests/session-change-startup.cjs` | 慢初始化不阻塞 HTTP、初始化不能由查询触发、实际后端协调边界 |
| `tests/session-change-electron.cjs` | 真实 Electron 输入、布局、截图、真实证据显示；显式 live 测试调用 |
| `docs/p33-5a-plan.md` | 勘察与实施计划 |
| 本报告 | 验收证据、失败重跑、边界 |

修改：`server.js`、`server/session-change-store.js`、`server/session-change-bridge.js`、`server/session-revert-authority.js`、`server/session-revert-routes.js`、`server/session-revert-service.js`；`public/api.js`、`public/app.js`、`public/runtime-conversation.js`、`public/right-pane.js`、`public/rpc.js`、`public/styles.css`；`tests/session-change-live.cjs`、`tests/session-change-rpc.cjs`、`tests/smoke.cjs`、`package.json`。

没有修改 Pi 本体、生产 writer、元数据门槛、Git 恢复语义或增加第三方依赖。service 的改动仅将历史列表的备份标记改为真实引用存在时才为 true，避免 undefined 被误报成可用备份。

## 3. UI 入口、布局与交互

- classic：顶栏“更多 → 本会话变更”（`public/app.js:847`）。
- managed：当前会话控制栏“更多 → 本会话变更”（`public/runtime-conversation.js:138`）。
- 复用 `secondary-surface` 与既有右栏，独立 surface 为 `session-changes`；不重排侧栏、不调整 Git 徽标、不替换 Git Changes 数据。
- 两个标签：“会话变更”“历史恢复材料”，以及“刷新”。沿用字体、颜色、按钮和 unified diff/hunk 折叠渲染。
- 摘要展示已捕获文件/操作数量、证据完整性、归因缺口、过期、内容预览请求资格；文件展示相对路径、创建/修改、证据等级、预览结果、固定拒绝原因和历史材料可用标记。
- 无证据明确写出“不代表文件没有被修改”；捕获关闭、shell/MCP/外部编辑器覆盖限制均有说明。
- 文件按钮明确请求单文件正文预览；最多保留一个展开的候选正文。关闭、换 surface、切换身份或相关 Agent 写入事件会清除正文。
- 顶部说明：“当前支持查看本会话修改与撤销预览。自动恢复仍需完成安全验证。”没有一键撤销、Force Restore 或装饰性禁用恢复按钮。

## 4. 前后端 API 契约

新增 `POST /api/session-revert/query`（`server/session-revert-routes.js`）。沿用 router 的 token/Origin 校验，以及 P32 完整 authority。

请求只允许：

```json
{
  "conversationId": "conversation-a",
  "owner": {
    "backendInstance": "backend-id", "projectId": "project-id", "repoId": null,
    "workspaceId": "workspace-id", "workspaceEpoch": "epoch-id",
    "conversationId": "conversation-a", "runtimeId": "runtime-id",
    "runtimeGeneration": "generation-id", "sessionId": "native-session-id"
  },
  "limit": 25
}
```

示例 ID 必须替换为当前后端实际确认的值；classic 使用 `classic-chat`，关闭的 managed 会话不携带旧 owner。可选 cursor 为上次响应提供的 `revision:offset` 字符串，不能沿用旧 revision。

响应包括：`target`（conversation/workspace/epoch）、服务端确认的 `owner` 或 null、`revision/gapRevision`、总文件/操作数量、完整性/归因/过期/资格、capture 状态、分页文件摘要和 `nextCursor`。文件 `evidenceIds` 就是该授权作用域的 operationIds。

预览继续使用现有 `POST /api/session-revert/preview`：由摘要返回的 owner、target、revision 和 evidenceIds 构造请求，默认 `confirmed_limited`，用户打开文件时才 `includeDiff:true`。严格模式没有 exclusive provider；界面不提供资格升级。

历史继续使用现有 `recover-preview`，主动下载使用 `export`。不增加客户端路径、数据目录、正文、私有引用或 capability 输入。

## 5. 查询、分页与初始化只读边界

`server/session-change-store.js:302` 在既有 journal 队列内投影元数据。精确匹配 project/repo/workspace/epoch/conversation/native session/fingerprint，不从其他 conversation/worktree 列出记录；没有新证据注册中心。

- limit 默认为 25，允许 1..50，非法类型/小数/越界拒绝。
- cursor 的 revision 必须匹配，offset 有格式和结果边界；journal 更新时旧页返回 `stale_evidence`，刷新从第一页开始。
- 单文件最多返回 128 个选择 ID；超过预算不提供部分成功选择，而给出拒绝说明。
- 不读取 B/A/P blob；不追加 journal、消费 operation、创建 plan 或访问任意客户端文件路径。元数据“完整”不替代预览阶段对象隐私、digest 和实际内容校验。
- query 在返回前复核 authority 与 revision。活动 Agent 的摘要可读，但预览/历史比较继续保留原 active_writer 门槛；只读面板不调用 Stop。

审查发现原 store 惰性打开会协调中断记录并追加 journal，因此不能由首次查询触发初始化。最终方案（`server.js:296`）独立启动一次既有初始化，HTTP 监听保持原路径；`session-evidence-admission` 在初始化期间立即拒绝 namespace 请求，返回固定 503 `evidence_initializing`，不进入 store/authority。失败为固定 `evidence_unavailable`；完成后才开放读取。

初始化仍按既有逻辑协调 journal，这是后端生命周期行为，**不是只读接口写操作**。不因初始化慢而延迟整个 GUI 的 HTTP 监听；控制型 unresolved 初始化测试验证请求不等待初始化，实际源/打包后端测试验证准入打开后查询前后 journal 字节一致。

## 6. 候选、冲突与拒绝展示

`public/session-changes-panel.js` 固定映射 overlapping_changes、ambiguous_mapping、attribution_gap、incomplete_evidence、expired_evidence、stale_current、stale_runtime、unsupported_text、metadata_unsupported、already_reverted 等中文原因。未知代码和私有错误统一为通用文案；不显示 error/堆栈/内部路径。

成功内容候选显示 C→R diff、拟撤销/拟恢复的内容解释，以及独立修改仅在算法能够证明时保留的限制；明确“可以计算内容候选；实际恢复未开放”。`contentEligible=true` 不提升为 `applyEligible=true`。候选仅反映本次读取，外部编辑之后仍须重新预览。

拒绝时不渲染假的 diff；stale 提示刷新/重新预览。diff 超限显示拒绝原因，既有后端单次正文总额 32KiB，不截断成可应用 patch。

## 7. 历史材料查询、比较与导出

- 只列当前授权 scope 的既存计划；现有 service 最多展示最近 64 项，每计划沿用 32 文件预算。
- 展示创建时间、completion/state、文件及 applied_verified/recovery_required/not_applied 等状态。不完整记录有人工检查警告。
- 用户点击单文件“比较备份”才请求受限 diff；展示与备份/历史候选一致、当前缺失或内容不同，不把比较结果描述为恢复成功。
- 用户点击“导出备份”才请求已有单文件 currentRef 对应材料。下载到浏览器选择位置，不接受服务器落盘路径，不自动下载或创建备份计划。
- 导出通过身份/surface/视图代校验，与另一个预览请求的序号分离；同会话比较备份不会误取消导出或永久禁用按钮。
- 空会话显示“没有历史恢复材料”。有效引用不代表一定能导出，实际 service 仍检查授权、私有权限及对象完整性。

## 8. 会话与 worktree 隔离

`server/session-revert-authority.js` 继续复用 classic native state、managed 完整 owner、dormant registry/workspace 解析。摘要的 allowActiveWriter 仅跳过忙碌拒绝，未跳过 owner/native/workspace 校验。

前端每次读取当前状态构造身份，不将 owner 存入 localStorage。响应同时检查请求代次、当前 surface 和当前身份；A→B→A、关闭/恢复、generation/epoch 变化均不能认领旧响应。

classic 与 managed 修改事件携带/使用 workspaceId+epoch；只清除同工作区候选，包含 owner=null 的关闭 managed 会话。其他 worktree 的事件不会误清除当前候选。身份变化重新查询；Agent/工具变化清除正文并要求刷新，避免自动反复计算内容。

证据分层：DOM 测试证明迟到响应/拒绝/共享工作区失效；实际 RPC 证明 source/packaged 的 classic、managed worktree、关闭后的 scope 和旧 owner 拒绝；真实 Pi 两会话同名文件捕获证明 worktree 隔离。没有以这些结果冒称所有长期并行模型任务已验收。

## 9. 实际写回不可达与不变性

新面板仅导入 query、preview、recover-preview、export helper，以及当前 conversation 选择与纯 diff 渲染；没有 prepare/apply/recover-prepare/Stop/Git restore 调用。

HTTP 测试比较查询/历史列表/导出前后 journal 原字节，并比较临时 Git index、HEAD 和用户文件。真实 Pi→GUI 预览链比较当前 C、journal、index/ref，均保持不变。

既存后端 P33.4 协议端点仍存在，保留原安全门槛；这里的“不可达”是指**新 UI 操作路径**，不是声称删除了所有服务端写协议。旧测试单独调用 prepare 验证严格/缺证据/metadata 拒绝，不属于新 UI 链路。本阶段没有接入原位 writer、绕过 metadata_audit_unavailable 或自动运行 git restore。

## 10. 完整测试结果与失败重跑

最终完整命令 `npm test`：107 个脚本链，**退出 0，871.682 秒**。原 smoke 仍为 1338/1338；仅将菜单 5 项预期改为 6 项，没有删除断言。新增套件全部进入唯一 npm test 入口。

| 测试 | 通过/执行 | 失败 | 跳过或限制 |
| --- | --- | --- | --- |
| 新 HTTP/query | 34/34 | 0 | 0 |
| 新 UI | 27/27 | 0 | 0 |
| 新初始化准入/源后端 | 11/11 | 0 | 0 |
| 原 evidence store / bridge / tools | 35/35、23/23、30/30 | 0 | fixture |
| 原候选算法 / store / HTTP / integration | 67/67、14/14、65/65、19/19 | 0 | fixture 与实际临时 FS |
| 原 writer / recovery / admission / apply | 22/22、24/24、15/15、29/29 | 0 | fixture 元数据，不是生产 writer 资格 |
| Worktree lifecycle / HTTP / UI | 56/56、14/14、16/16 | 0 | 实际临时 Git + fixture |
| Runtime registry / HTTP / store / UI / nav | 32/32、12/12、25/25、16/16、38/38 | 0 | fixture |
| Runtime conversation / changes / secondary / Git UI | 48/48、60/60、17/17、6/6 | 0 | fixture |
| Git / modules / security | 161/161、117/117、36/36 | 0 | 原套件 |
| Windows faults / 原对象研究 / 安全研究 | 13/13、28/28、43/43 | 0 | 原对象研究跳过 SACL 2 项；研究不能提升生产资格 |
| SACL 独立见证工具 | 0/0 | 0 | 8 项因缺少审计权限跳过，不纳入分子分母 |

其余原套件的逐项原始输出见 `.probe/p33-5a/final-107.log`；退出码与耗时分别保存于 `.exit`、`.seconds`。没有将输出经管道后把过滤器退出码冒称测试退出码。

失败和修正保留：

1. 首次新增查询/UI 测试分别在不存在 queryEvidence/面板时失败，随后实现；审查问题均增加复现测试。
2. 首个最终全套 smoke 为 1337/1338，旧菜单数量断言不适用；改为 6 项后完整重跑。
3. 首次 app-check 为 19/21，缺少 PDF fixture 使上传分支未执行、缓存断言失败；`npm run fixtures` 后及最终重建后均 26/26。
4. 真实 GUI fixture 第一轮静态页面入口失败：router 不接受注入 serveStatic；修正测试 HTTP 外壳后真实工具+GUI 链通过。
5. 完整应用菜单测试曾被已回答的历史捕获确认重放遮住，并受侧栏尚未加载影响。修正测试时序（GUI 先连接、再发确认 RPC，等待会话行加载）后，More 和新菜单项均用原生鼠标输入通过，不用 DOM click 代替最终入口验收。
6. 初版启动协调等待全部初始化，独立复审指出 Electron 25 秒启动期限风险；交付前改为后台初始化+快速拒绝准入，慢初始化与失败状态均有测试。

## 11. 真实 Pi 端到端验证

`P33_GUI_E2E=1 node tests/session-change-live.cjs`：真实安装 Pi **1.0.4，27/27**；额外 Electron 子检查 **11/11**。

该测试使用真实 AgentSession、Extension loader/dispatcher、默认 write/edit、实际 I/O、生产 Windows 私有 ACL 和持久 journal；fixture stream provider 仅控制工具调用，无真实模型或外部网络请求。所有写入在独立 os.tmpdir 项目。

链路：真实 write/edit → P33.2 保存 → GUI query 找到该文件全部 operationIds → 原生鼠标选择文件 → P33.3 Worker 计算 → 生产前端面板显示 C→R → 检查无恢复写入。此链使用隔离的真实 HTTP 外壳与生产前端模块；完整 source/packaged 应用装配另由 §12 验证，不混淆两类证据。

| 字节对象 | 大小 | SHA-256 |
| --- | --- | --- |
| B（用户原有未提交内容） | 49 | `d8cc4c37b0e315e206efb6397f950c4f1838be644033143d19d0cc925fe6c11e` |
| C（Agent 修改后，另有用户尾行修改） | 53 | `b6e76c0ae045490989a70cd1a36bf4f5f08e914fe6d1c3d2c7365e66f708b21b` |
| R（恢复 Agent 区域、保留后来的用户尾行） | 55 | `ab07e2047c424ebbe79ff7d8badf152f4858ffa6ec82611b7a188f17757303f3` |

尺寸/digest 来自当前 fixture 常量，执行中以 Buffer 精确比较 candidate/R 和磁盘/C；GUI 选择和预览后磁盘仍为 C。journal/index/ref 不变的检查同在脚本中。后续单独原有 native prepare 拒绝检查仍为 metadata_audit_unavailable，不计为恢复成功。

## 12. 构建、打包与真实 GUI 回归

- `npm run build:app -- --rebuild` 退出 0。使用本机 Electron ZIP 离线缓存，无下载；重建包括后端与前端。版本仍 0.23.0，整包输出 328.0 MB。
- 最终 `npm run test:app`：**26/26，退出 0**。
- `P33_RPC_GUI=1 node tests/session-change-rpc.cjs`：source RPC **24/24**，完整应用 Electron **7/7**。
- 同命令指定 `dist-app/Pi GUI-win32-x64/resources/app/server.cjs`：packaged RPC **24/24**，打包资源的完整应用 Electron **7/7**。
- `node tests/session-change-startup.cjs <packaged server.cjs>`：**11/11，退出 0**。验证打包后初始化边界没有退化成首次查询写 journal。
- 实际菜单、空状态、侧栏顺序、窄窗口、Escape 返回入口焦点、renderer 无 error；真实证据面板另验证 Tab、正文显示、侧栏折叠、三个窗口宽度。

已生成并人工查看关键截图：

- `.shots/p33-5a/real-pi-diff-1200.png`
- `.shots/p33-5a/real-pi-diff-900.png`
- `.shots/p33-5a/real-pi-diff-720.png`
- `.shots/p33-5a/real-pi-sidebar-collapsed.png`
- `.shots/p33-5a/source-empty-1200.png`、`source-empty-720.png`
- `.shots/p33-5a/packaged-empty-1200.png`、`packaged-empty-720.png`

窗口尺寸为逻辑尺寸；截图像素受本机 DPI 影响。截图正文来自临时项目，不包含用户工作文件。测试脚本可重现；`.probe/`、`.shots/` 和产物是本机忽略目录，不自动纳入 Git。

## 13. 已知问题与安全边界

1. **既有确认重放问题**：新 renderer 在确认已通过 RPC 回答后连接，可能再次展示旧 capture 确认并遮住菜单；测试中有真实截图。未在本阶段扩大范围修改旧 Approval/SSE 重放。最终菜单验收在 GUI 先连接的正常时序执行；不能把它冒称刷新后的所有历史确认问题已解决。
2. 没有真实模型任务、长期并发 soak 或 POSIX 生产实机验证。真实 Pi 分发证明不等于真实模型验收；Windows fixture/native 证据不外推 POSIX。
3. 实测现有深色主题、1200/900/720 及侧栏折叠；没有新增浅色主题或宣称浅色验收。
4. 外部编辑器修改不一定产生 GUI 事件；候选是本次观察，不持续监控当前文件。用户重新打开预览时后端重新校验 C/revision，绝无沿用候选写入路径。
5. 完整应用 GUI 原生菜单测试实际在 classic 视图执行；managed/worktree/dormant 的实际授权由真实 RPC 及 P32/面板隔离测试覆盖，未冒称所有 managed GUI 组合都做了同样的像素实测。
6. 已有 store 的完整初始化可能较慢；当前 GUI HTTP 不等待它，证据面板显示初始化中，用户稍后刷新。没有为提速跳过 ACL、digest、scope 或中断协调。
7. 历史列表沿用最近 64 项边界，没有制造历史备份；更早计划没有新分页 UI。证据列表采用有界分页，单文件超 128 操作拒绝候选。
8. P33.2 只覆盖实际接管的 write/edit；shell/MCP/未知写入不能被描述为完整归因。strict provider 不存在，limited 内容候选始终不等于生产恢复资格。

## 14. 验收结论与停止边界

**P33.5a 只读集成已实现、重建并完成上述验证，可交人工验收。** 查询、候选显示、冲突拒绝、已有材料导出、身份隔离和 UI 不可达写回路径都有代码与实测证据。§13 的既有问题和未覆盖范围随报告一起交付，不自动宣布整套 P33 生产恢复通过。

最终 HEAD 未变；源码改动、测试和报告保持未提交。`git diff --check` 通过。没有提交、推送、发版、原位 writer 接入或进入 P33.5b。到此停止，等待人工验收。

## 15. 后续授权推送

用户随后明确授权“推送”。上节保留为最初验收交付时的状态记录；本次按业务代码、测试、验收文档三个回滚边界提交并推送当前 `main` 分支。

提交前重新执行 `npm run test:session-changes-ui`：query **34/34**、UI **27/27**、startup **11/11**，退出 0，无跳过。`git diff --check` 通过；`git fetch origin` 成功，提交前本地 HEAD 与 `origin/main` 无领先或落后。此前完整 107 套件、重建和打包验收的记录仍见上文，本次没有再次运行完整套件或重建。

本次授权仅涉及提交与推送；没有版本变更、tag、Release、生产 writer 接入或进入 P33.5b。既有未跟踪的发布工作目录不纳入提交。推送是否成功及最终远端提交以本次交付回复中的实测结果为准。
