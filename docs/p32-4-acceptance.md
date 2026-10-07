# P32.4 Multi Session UI：最终实施与复验记录

日期：2026-10-07。完成实施，等待 ChatGPT 最终验收。passed、failed、not executed、environment blocked 与 fixture / real Electron / real Git / real Pi 分别标记。

## 1. Baseline

- 本轮 before HEAD：`09182a26479bb6fbf97b139826b03e6629a01c4c`；分支 `codex/p32-multisession-ui`，开始时 fetch 核实本地与远端一致。
- main / merge-base：`cbee9b83ef13efa5ac2dc67e784785044ad4030b`。保留既有 A/B；不在旧 P32.3 分支重做。
- 版本仍为 0.22.0；未合并 main、改版本、打 tag、发布 Release 或开始 P32.5。
- 接手前已有未跟踪目录 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`，本轮未修改、删除或提交。最终 tracked changes 为空；完整 status 仍会列出此既有目录。
- 阅读项目 memory、架构/安全/测试文档和实际代码。Jev 只作路由建议，最终方案由代码复核决定。

## 2. Architecture

`runtime-state.js` 持有单一 store，侧栏、中央和旧工作区对话框都是视图。registry 提供完整 owner、revision/eventSequence、状态和资源数；前端只持有草稿、滚动、选择意图和安全模型元数据。

Changes：conversation → backend workspace identity → `worktrees.withWorkspace({id,epoch}, operation)`，锁覆盖整个 Git 操作。Browser/Process 通过已有 scoped API 和 `runtime-secondary.js` 跟随中央选择。历史路径由 registry 私有记录提供，不接受 renderer 文件路径。

沿用原生 ES modules、Node HTTP、P30 right pane 与现有 Electron controllers。无新增依赖、框架、provider/auth 系统或第二套 registry；不修改 Pi 本体、native session schema 或 P32.3 核心 identity 架构。

## 3. P32.4-A

保留当前项目侧栏、新建入口、后台 attention 和状态。projectId 来自 worktrees authority；排序按持久 createdAt/conversationId，点击和后台输出不重排。列表读取/dormant 点击不 spawn。

新建仍编排 prepare→create→start，失败不进入后续动作；工作区已建而启动失败如实提示。后端 focus 同时广播旧/新记录。新增读取合并、选择意图代次和键盘导航，原创建/归属检查保留。

## 4. P32.4-B

中央保持输出、工具、审批和发送/停止/重启/关闭/恢复。动作捕获完整 owner，草稿/滚动按 conversationId 分离；后台事件进自己的 store，不抢焦点。dormant 只读历史不占 slot，显式恢复才启动 child。

恢复 focus 等待 ready 和非空 native sessionId；selection epoch 使 A→B→A、离开中央等旧意图失效。旧 generation、迟到 Stop/审批与后台 streaming 回归保留。

## 5. P32.4-C

**passed，自门完成后进入 D。** 阶段 runtime 348/348、worktrees 86/86、smoke 1338/1338、Process UI 17/17；real Electron 109/109，27 张截图，exit 0。最终数字见第 14 节。

- Changes 不再用 record.root 授权；无 scoped header 才走经典路径。空/未知/失效会话以及 stale/archived/removed/locked workspace 均拒绝，不回落。
- Browser A/B 独立原生 WebContentsView、权限、viewport/CDP。后台操作不显示在当前会话；切换 detach/hide 而不销毁后台 view；重复同 owner focus 保留绑定。
- Process 注入已有 panel transport，切换取消旧 polling/results；权威 status 返回前禁用权限 checkbox；stop/restart A 不影响 B。
- 右栏保留 surface kind，B 无 Browser 时显示空态，dormant 不启动；返回经典恢复经典 scope。

## 6. P32.4-D

**passed，自门完成后进入 E。** 阶段 runtime 415/415；real Electron 133/133，32 张截图，exit 0。

共享 runtime-resources preflight 适用于侧栏、中央恢复、旧工作区对话框。第三个名额先确认 CPU/内存/模型成本；取消不发 start/resume，确认仅对捕获动作 allowThird。第四个请求实际到达后端并收到 runtime_limit。

totalCount 来自完整后端快照并包括经典 child；unknown 不显示为 0。cleanup_pending 保留 count/lease，等待 Pi、Browser、Process 全部清理。快照请求合并并防旧响应覆盖，100 个 delta 不触发资源 GET。

## 7. P32.4-E

live conversation 独立模型控制器，native readback 确认模型/thinking；历史搜索使用明确 locator。标题优先 proven native sessionName，缺失时 branch fallback，createdAt 顺序稳定。

侧栏 ArrowUp/Down/Home/End 移动焦点、Enter 选择；重绘保留焦点而不抢输入。中央 Enter 发送、Shift+Enter 换行、IME 不提交；Escape/Tab 经 real Electron 验证。runtime/classic 标题缓存分离，经典后台事件不覆盖 runtime 标题。

保留现有样式/P30 控制器，局部调整 runtime 表单、换行与右栏分配宽度。实测 1280×800、1440×900、1920×1080、125%、150%，含中央模型/composer 与右栏边界及原生 Browser viewport。

## 8. Owner / identity rules

完整 owner 九字段：`backendInstance/projectId/repoId/workspaceId/workspaceEpoch/conversationId/runtimeId/runtimeGeneration/sessionId`。PID 不作为 owner；store accepted event 的 revision/eventSequence 防护保留。

动作在点击时捕获身份，await 后用 token/selection epoch 和 owner 再确认。旧 backend/runtime/generation/session/选择意图结果不得修改新会话。native sessionId 未绑定时不 focus。

历史五字段 locator 与运行 owner 职责不同，不需恢复 child。私有 locator/cwd/文件证明不进 snapshot/SSE/DOM。原始工具参数、worker error、credentials 不进入诊断；错误为固定安全码/文案。对话正文是有意显示的内容。

## 9. Browser / Process / Changes

**real Electron + real Git + fixture Pi：passed。** OS-temp 真实 repo/worktrees 分别改动，status/diff/open/restore/restore-all 验证 A 不改 B 或经典 workspace，覆盖锁、失效、root/metadata replacement。

Browser 实测独立原生 view、后台 CDP、不抢焦点、权限 revision、旧回调与关闭/重启。main capturePage 不含原生 view 内容，需看配对 native capture。

Process 使用真实 Node HTTP 服务和 Windows 进程树，由 fixture Pi 经生产 private bridge 发起；权限默认关、日志隔离、A stop/restart、B RPC/HTTP 继续与最终清理均验证。没有把 fixture model 回复当作 real Pi。

## 10. Resource limits

后端默认 2、显式第三个、硬上限 3，含经典 child。前端不造第二套 limit；第四拒绝、workspace lease 和 cleanup barrier 仍由后端执行。

确认取消无 child；历史无 slot。cleanup_pending/failure 仍占名额并保留 lease；Pi/Browser 完成但 Process 未确认时不可复用。全清理后才释放。重启后的持久记录 dormant，不自动启动。

## 11. Model isolation

复用 modelIdentity/modelCapability，保留 true/false/unknown，不从名字猜 reasoning。只有 reasoning=true 且 native Pi levels 明确返回时允许 thinking；false/unknown 禁用。

先注册等待者再发 scoped mutation。HTTP ack≠成功；需 store 已接受的 native SSE response 匹配 full owner/id/command/success，再 get_state/readback。切 A→B、旧 generation、失败/超时不得污染 B 或替换已确认旧选择。

private RPC null/__error 不投影为成功；get_available_thinking_levels 使用既有 read 白名单。thinking failure 移除原始 error/data。provider/auth 沿用共享实现，不另存 key/auth。

## 12. History/Search

复用现有 parser/预算与经典归属；runtime candidates 来自当前 projectId registry。公开 locator 恰为 `projectId/workspaceId/workspaceEpoch/conversationId/nativeSessionId`。项目/locator/native identity/后端记录变化使迟到结果失效。

同 fd bounded read，前后验证 native header id/cwd，验证 canonical path 和 dev/ino/birthtimeMs。同 inode 等长身份改写拒绝，正常追加兼容；旧 manifest v1 无文件证明时仍检查 native header。新增私有字段不改 Pi schema。

live 搜索打开只读历史，可返回运行输出；dormant/removed workspace/重启记录可读已证明 session，不 spawn。只展示 user/assistant text，无 tools/thinking/images。搜索每文件 8 MiB、总 48 MiB、最多 30 结果/每会话 5 命中/160 字符 snippet；历史最近 4 MiB、最多 800 消息。

## 13. Electron scenarios

最终 frozen source `npm run test:runtime-electron`：**170/170，exit 0，43 截图，renderer errors=[]**。独立 `P32_RUNTIME_CLASSIC_SHOT=1`：**2/2，exit 0，1 截图，errors=[]**。退出后按 fixture 命令行身份检查 owned Electron/Node/cmd 为 0。

保留全部 A/B/C/D 检查，覆盖发送/停止/草稿/后台输出、审批/迟到结果、Browser/Process/Git、第三取消/确认、第四后端拒绝、cleanup slot、模型响应/readback、三态 reasoning、native history 搜索、键盘和全部尺寸。

Electron 44.4.3、生产 server/renderer、real Git worktrees、real native Browser/Node 服务；Pi/model 回复为 fixture。没有模型网络调用。

## 14. Test results

最终 canonical `npm test`：**passed，exit 0，89 个链脚本全部完成**。package.json 唯一入口包含 89 个链脚本；新增套件在此登记，未复制到 CI。

| 最终 runtime 套件 | 实际结果 |
|---|---:|
| registry / HTTP / store / UI | 32/32、12/12、25/25、16/16 |
| nav / conversation | 38/38、48/48 |
| Changes / secondary / Git UI | 60/60、17/17、6/6 |
| resources / cleanup | 45/45、16/16 |
| models / history-search / finish UI | 51/51、35/35、27/27 |
| session runtime / supervisor | 5/5、24/24 |
| Browser / Process budget / events / real Process | 48/48、4/4、14/14、10/10 |
| **20 套件合计** | **533/533** |

其他受影响检查：smoke 1338/1338、modules 117/117、worktrees 86/86、经典 search 71/71、Process UI 17/17、browser-pane 52/52、UI IA 12/12。Electron 170/170；经典 capture 2/2、app-check 26/26 单列，不混入 runtime。

未删除断言。阶段 runtime 348→415→533，Electron 109→133→170；历史最终新增 3 条并发文件回归。经典 search Windows symlink 检查因权限跳过，实际执行 71；跳过不计分子分母，旧其他环境 72/72 不是当前数字。

## 15. Build/package

`npm run build:app -- --rebuild`：**passed，exit 0，13.534 秒**。显式使用既有 Electron 44.4.3 本机 zip 离线构建，无下载/新增安装。版本 0.22.0。

- 入口 `dist-app/Pi GUI-win32-x64/Pi GUI.exe`：246,324,736 字节；整包 343,661,959 字节；server.cjs 1,954,077 字节。
- exe SHA256：`3FA1209BC80D67DF26ACD9EF7D616DD7874D8642A8C333F0017AA1F9511CF894`。
- server.cjs SHA256：`0182E1D6FF7D991C78277C2F71A66368D983E1286FD58A14F19D52B6F81029AB`。
- runtime-models/conversation、right-pane、shell、styles、main、browser-runtime-host 源码与随包文件 SHA256 一致。

app-check 首次 **environment blocked / failed，exit 1**：127.0.0.1:7799 listen EACCES。确认 24790/24791 可 bind 后，既有 CHECK_PORT=24790 重跑 **passed 26/26，exit 0**，无测试实现改动。OS-temp 隔离随包 app、无 node_modules，验证 private RPC ready、资源/PDF/docx/路径拒绝/无项目不启动；Pi 为 fixture。

SEA 辅产物 injector 的既有 signature warning 保留；成功注入不等于签名。未执行 installer/签名/Release。

## 16. Screenshots

最终 44 张 real Electron 截图随提交保存在 `docs/evidence/p32-4/`。最小场景映射：

| 场景 | 图片 |
|---|---|
| 单经典会话 | [classic](evidence/p32-4/classic-ui.png) |
| A/B、attention | [central](evidence/p32-4/e-central-1280x800.png) |
| A running / B focused | [running-focused](evidence/p32-4/sidebar-a-running-b-focused.png) |
| error / dormant | [error](evidence/p32-4/A-crashed-B-running.png)、[dormant](evidence/p32-4/sidebar-dormant.png) |
| A/B Browser | [native A](evidence/p32-4/c-browser-native-a.png)、[native B](evidence/p32-4/c-browser-native-b.png)、[B chrome](evidence/p32-4/c-browser-b-native-owner.png) |
| Process A/B | [A](evidence/p32-4/c-process-a.png)、[B](evidence/p32-4/c-process-b.png) |
| Changes A/B | [A](evidence/p32-4/c-changes-a.png)、[B](evidence/p32-4/c-changes-b.png) |
| 2/2 resource | [two](evidence/p32-4/d-two-regular-slots.png) |
| third confirmation / active | [confirm](evidence/p32-4/d-third-confirmation.png)、[active](evidence/p32-4/d-third-active.png) |
| fourth rejection | [fourth](evidence/p32-4/d-fourth-rejected.png) |
| A/B different model | [reasoning A](evidence/p32-4/e-model-a-reasoning.png)、[text B](evidence/p32-4/e-model-b-text.png) |
| 1280×800 / 1440×900 / 1920×1080 | [1280](evidence/p32-4/e-central-1280x800.png)、[1440](evidence/p32-4/e-central-1440x900.png)、[1920](evidence/p32-4/e-central-1920x1080.png) |
| 125% / 150% | [125](evidence/p32-4/e-central-zoom125.png)、[150](evidence/p32-4/e-central-zoom150.png) |
| Browser 150% bounds | [chrome](evidence/p32-4/e-browser-zoom150.png)、[native](evidence/p32-4/e-browser-native-zoom150.png) |
| live / dormant search | [live](evidence/p32-4/e-search-live-history-a.png)、[dormant](evidence/p32-4/e-search-dormant-history-b.png) |

原始本机日志在 `.shots/p32-4/electron-{c,d,e}-run.log`、electron-report.json、classic-report.json，未跟踪。提交中的 [delivery index](evidence/p32-4/delivery.md) 保留安全摘要和图片清单；harness 可复现完整日志。main capture 不含 native view，原生内容须看配对图片。

## 17. Bugs found/fixed

- C：record root 非授权；旧 Browser/Process/Git 结果；权限返回前 checkbox；重复 focus 破坏 native view；重复归属读取。均以实际隔离/拒绝检查修复。
- D：恢复 focus 早于 native sessionId，A→B→A 旧恢复抢焦点。真实 Electron 暴露后，ready+sessionId 与 selection epoch 修复。
- E：native null/__error 当成功；新增异常后 ready probe 未 catch。固定错误保留 slot/lease，防旧 generation 污染。
- E 首轮 **failed visual review**：166/166 功能检查通过，但 150% 右栏覆盖模型/composer，原 overflow 检查漏报。修复 runtime 宽度分配并增加中央/pane/native 边界检查，最终 170/170 与截图复核通过。
- 独立复核 **P2 failed**：同 inode 等长 native header/body 替换绕过旧校验。确定性 RED→同 fd 读后 header 校验→35/35 GREEN，独立复核确认无剩余 E blocker。
- harness 的 checkbox、READY 时序、confirm layer、host lookup、zoom 坐标问题经生产行为核实后修 fixture/等待/测量，未删断言绕过产品缺陷。
- app-check EACCES 初次失败与端口重跑均记录于第 15 节。

## 18. Known limits

历史只回放文本，不回放 tools/images/thinking，大文件会截断。搜索前部 8 MiB 与历史尾部 4 MiB 不相同；超预算记录的 userIndex 未必在历史片段内，可能无法滚到命中，但不显示别的身份或自动 spawn。

旧 manifest 无文件身份时用 native header/canonical proof；新绑定增加文件证明。本次验证正常追加及可复现替换/改写，未宣称跨进程文件事务锁。

模型信息来自 Pi/shared capability，缺信息保持 unknown，刷新失败需重试。更窄于支持尺寸时仍沿用 P30 overlay；只证明指定尺寸/zoom。原生与主窗口截图分开。未签名本地产物不等于 installer/Release。

## 19. Unverified items

| 项目 | 状态 |
|---|---|
| real Pi / real model 完整任务 | **not executed**；fixture 不能替代 |
| 30 分钟真实模型并行 stress | **not executed** |
| POSIX | **not executed / unverified**，Windows 证据不外推 |
| 当前远端 CI | **unverified**；未查询/等待最终 CI，旧阶段 CI 状态不作为现状 |
| GitHub Release 列表 | **not executed**；未查询/创建/发布 |
| installer / 签名 / 正式发布 | **not executed** |
| Windows symlink 检查 | **environment blocked / skipped**，不计分母 |

以上为证据边界，最终是否通过由 ChatGPT 复验决定。

## 20. Final HEAD

最终 HEAD 为包含本记录的分支 tip，以 `git rev-parse HEAD` / `git ls-remote origin refs/heads/codex/p32-multisession-ui` 核对。本文件避免写自身自引用 SHA；交付回复提供实际完整 after HEAD。

提交清单/文件边界见 [delivery index](evidence/p32-4/delivery.md)。业务、测试、测试入口和文档/截图按回滚边界拆分，中文提交。只 push 指定分支，不 merge/tag/Release。既有未跟踪目录例外见第 1 节。

P32.4 implementation complete, waiting for ChatGPT acceptance.
