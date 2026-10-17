# UI-4 集成交接（未完成验收）

交接时间：2026-10-17 18:50（Asia/Shanghai）。用户决定交给其他 Agent 继续。本 Agent 已停止启动新测试/构建；没有后台完整测试、构建或桌面任务正在运行。不要把本文件当完成验收报告。

## 工作区与提交

- **继续使用 `C:/pi-GUI-ui4-integration`，分支 `codex/ui4-integration`。** 集成修复仍在未提交工作区，禁止 reset/clean/新建空工作区后漏掉这些修改。
- 共同基线 `17f855f01fedb7b13a13496ba45ebf8d28e465ac`。
- 当前 HEAD `68c9f92ac0920ac35682c08a11ed76c1a460c1e1`，这是第三次 merge；后续修复和测试尚未本地提交。
- A tip `a097b17b26a8a3c6944c6ff2aae401349ee635f1` → merge `7fa6df15b52f5c6d417ef99b58c54a3d0f3d43af`。
- B tip `c2b1044d40aea61f066bfa4845909c266e0f53be` → merge `54a90d37c9dcfde67b3cd79509e084a07514b7a7`。
- C tip `8679740192b39875b08232adf82439307d0aefd0` → merge `68c9f92ac0920ac35682c08a11ed76c1a460c1e1`。
- 三次 `--no-ff` 合并，无文本冲突；合并前再次确认输入工作区 clean、HEAD 未移动、merge-base 正确。
- 原仓库和三个输入工作区未修改，没有 push/main merge/tag/version/release。没有联网或安装依赖。
- `node_modules` 是指向 `C:/pi-GUI/node_modules` 的忽略 junction，不要安装依赖。

用户原始任务见 `C:/Users/21022/.codex/attachments/693f31af-69f9-4542-95f5-d6511baa773a/已粘贴的文本.txt`。继续阅读 AGENTS、UI-2/UI-3/A/B/C 验收及本目录 `UI-4-integration-review.md`。

## 已应用的产品修复

1. `index.html` 按 process.css 之后静态加载三套 UI4 CSS，ID 与 B/C 幂等注入兼容；真实 Electron 已证明只有一份且解析成功。
2. `ui/modal.js`：确认框在决定前/await 后比较 resolve 身份；普通 modal build 的 close 绑定独立实例 token，关闭前先使 token 失效。旧返回不会关闭或授权新卡。
3. `approval.js`：明确区分 sent/failed/unknown。fetch、JSON 丢失、畸形 ack 不能断言未送达；unknown 锁定所有决定，只允许本地关闭。Stop 不补发矛盾取消。过期结果不能 settle/toast 成新请求成功。
4. 审批原卡被其他弹窗替换后，迟到失败/unknown 保留 captured-context **persistent warning**，不重发。原卡没有恢复入口；后台请求可能仍等待 Stop 或真实 timeout，此限制需写入最终报告。
5. `api.js sendCommand(cmd,{notify=true}={})` 仅增加展示参数，wire/返回值不变。审批 deliver 用 notify:false，由卡片/Stop/退场后的 warning 显示一次；其他命令保持默认错误通知。
6. **不接 B 的 renderRuntimeApproval() 到生产。** 保留原控制器和新 CSS。Runtime 两处仅为 extension_ui_response 的异步 notice 写入增加对称 owner 显示校验；普通 Runtime modal 仍执行权威 refresh。未修改 store/owner/revision/sequence 或协议。
7. Classic 有效后台请求不因为导航 Runtime/Planner 就 expire（否则可永久丢失无 timeout 的请求）；卡片明确标注经典会话来源。
8. `session-changes-panel.js`：无身份 fallback 限定 Classic、双方缺少工作区身份；Runtime 和明确 foreign 事件不能泛化匹配；clear 同步移除 aria-busy。P33 资格/写入协议未改。
9. Process 整文件 rewrite 已独立对照；generation/revision/cursor/workspace、1秒串行轮询、dispose、stop/restart 参数和 256行/65536字符限制保留。新4项模拟测试通过，OS能力由原套件另证。
10. Toast：上下文去重、旧持久通知标记与动作失效、hover/focus 任一存在都暂停、堆叠高度限制在 Composer 上方。运行上下文只保存在内存，未写 DOM 原始身份或持久化。
11. `app.js` 给 Toast 提供**只读 getter**，读取已有 runtimeConversation.conversationId 与 runtimeStore.owner 九字段；订阅既有 onRuntimeChange/workspace-view。runtime-nav 只为通知捕获并传回展示 context，业务条件/payload 不变。
12. **最后一轮小修尚未复跑**：全局 Notice 实际生产唯一路径是 app 的 Classic startup/Bridge 模型，因此 Notice 使用 `feedbackContext({runtime:false})`，不因 Runtime A/B 或 owner 改变误清有效 Classic 错误；真实 Classic generation/session 改变仍清理。对应测试已改为保持 Classic 归属。Toast 默认仍包含 Runtime 身份。
13. Browser 在原 toolbar 内补真实 h3“浏览器”，无新标题行；360px 以下视觉隐藏 heading，地址栏优先。原46px空标题带、46px工具条、420px默认宽保留。

独立审查已完成两轮：审批 reviewer 最后未发现新 P1/P2，确认退场失败持久可见；pane/feedback reviewer 确认 Runtime getter 不参与授权，也不复制 owner 生命周期。

## 文件范围（未提交）

- `public/api.js`, `app.js`, `approval.js`, `browser-pane.js`, `index.html`。
- `runtime-conversation.js`, `runtime-nav.js`, `runtime-sessions.js`, `session-changes-panel.js`。
- `ui/modal.js`, `ui/notice.js`, `ui/toast.js`, 三套 `ui4-*.css`。
- `package.json`：canonical 前缀 `npm run test:ui4 && <原 test 原样后缀>`；UI4 jsdom 三套加入，桌面/CDP独立入口。已程序断言原 test 字符串后缀完全保留。
- 修改测试：`runtime-electron.cjs`, `ui4-approval.cjs`, `ui4-feedback.cjs`, `ui4-pane.cjs`。
- 新增测试：`ui4-integration.cjs`, `ui4-integration-electron.cjs`, `ui4-runtime-electron.cjs`, `ui4-cdp.cjs`。
- 新增报告/证据在 `docs/claude-ui-redesign/ui4-integration-evidence/` 及 review/handoff。
- server/、electron/、Runtime store、RPC/SSE、Browser policy、P33 生产门禁未改。

## 已执行结果与证据

证据根 `docs/claude-ui-redesign/ui4-integration-evidence/`。

| 执行 | 实测结果 | 说明 |
| --- | --- | --- |
| pristine UI3 基线 npm test | **退出0，3135.232秒**，17:46:21—18:38:36 | `baseline.log`, `baseline-process.json`。没有在中途改既有产品/测试文件。权限跳过需最终逐项汇总，原19项不算通过 |
| 修复前新增回归 | 11/48，失败37，跳过0，退出1 | `review-red-current.log`。是多个交错用例，不是37独立缺陷 |
| 第一轮集成单元 | 48/48，随后退场失败4例先48/52红后52/52绿 | 日志完整保留 |
| 最近 UI4 三套单元 | **44/44 + 27/27 + 54/54，退出0** | `unit-combined-final.log`。在最后 Notice Classic 归属小修之前；接手后必须复跑，不冒称当前最终绿 |
| npm run test:ui | **1338/1338，退出0，71.200秒** | `ui-related.log` / process JSON；在后续 Runtime Toast getter小修之前，需要最终 canonical 再覆盖 |
| npm run test:ui2 | 退出0 | `ui2-related.log`；末尾 visual 57/57，其他两套见原始日志 |
| npm run test:ui3 | **联合 Electron243/243，107图，退出0** | 注意这个脚本实际是桌面测试，不是三套UI3 unit！日志 `ui3-related.log` |
| UI4 A原套件+新增联合 Electron | **427/427，0失败，75图，退出0，59.650秒** | `electron/results.json`, `electron.log`, process JSON；真实生产入口静态CSS、原生Browser、主题/四宽/侧栏/十行/审批/菜单/拖拽/zoom/reduced motion。最后Notice归属小修之后仍需最终复跑/包内复跑 |
| ResizeObserver | 新联合段 resizeErrors=0，unexpected=0；稳定后callbacks/geometry不再变化 | 原始 facts 内 stableA/stableB；没有屏蔽console、error或observer回调 |
| B 审批 Electron | **43/44，退出1，22图** | 唯一失败是 `tests/ui4-approval.cjs:888` 仍断言“仍在等待”；实际文案为“后端没有接受…”。键盘各项通过。应依据已验证协议事实最小更新断言，不删除用例 |

两次联合 Electron 的失败尝试也保留：attempt1 是缺 Page.enable 导致预加载诊断未生效；在已ready后 Page.enable修复，未使用启动前 Runtime.enable。attempt2 是测试清空 Toast DOM 后重复文本被正确去重，后续取不到节点。已改各场景唯一文本，并强制检查四种Toast、zoom实际节点和真实十行换行；第三轮通过427项。

**UI3原证据已恢复保留**：运行 test:ui3 会默认写原UI3证据目录。本轮生成内容已另存 `ui4-integration-evidence/ui3-regression-electron/`，随后仅恢复了本 Agent 生成覆盖的 `ui3-integration-evidence/electron/` 为 HEAD。已核实原UI3证据 diff为空。后续不要再无环境变量运行该桌面入口；使用 UI3_EVIDENCE_ROOT 指向新目录（核实脚本接口）。

## 接手后的优先顺序

1. 先 status/diff，保留当前全部未提交修复。**没有运行中的任务**，不要重复建 worktree 或重做已完成merge。
2. 复跑 `npm run test:ui4`，验证最后 Notice 归属小修。修 B桌面888行同类陈旧文案断言；保持44项、后端拒绝可重试、网络unknown锁定的严格判据。
3. **GUI套件串行运行**，避免焦点争用。完成 B --electron、C --electron、最新UI4联合重跑、`node tests/ui4-runtime-electron.cjs`。runtime hook 是新写的，**尚未执行**，需排查真实夹具/选择器，不改生产安全契约。
4. Runtime hook 复用原 runtime-electron 的真实Git/Worktrees/server/native Browser与fakePi；新增 FIXTURE_UI4_APPROVAL，仅 fixture 响应后发模拟agent_settled；有 actual native owner restart、held旧审批、同owner否决、真实反馈 getter、A→B同文通知。不能把fixture settled当真实Pi执行证据。
5. `node tests/ui4-cdp.cjs` **尚未运行**。wrapper沿用UI3隔离方式，独立tag/output。注意 run-job 为每次创建新TEMP，CDP附件矩阵需要在**同一TEMP环境**先运行 `node tests/fixtures.mjs`，可在wrapper内显式生成；否则不要因缺附件减少断言。
6. 运行完整受影响专项，或冻结后完整 `npm test`；**UI4最终完整 npm test 尚未启动**。基线实际52分钟，使用 `run-full-test.ps1 -Phase final` 的独立隐藏进程，等 `final-process.json` 真正退出0。不要只看部分日志。比较完整既有摘要/断言数量/19个原权限跳过，不能删除/放宽。
7. 冻结产品代码后隔离离线构建。缓存已核实：`C:/Users/21022/AppData/Local/electron/Cache/bb424f9061e7a2927a7fcc04709593fe81ac4633e2cd40456f2ef431743b1ee7/electron-v44.4.3-win32-x64.zip`。设置 PI_GUI_ELECTRON_ZIP_DIR 为该目录；`node scripts/build-app.mjs --rebuild --output-root <新绝对TEMP目录>`。**构建尚未执行**。
8. 构建需 source/public↔resources/app/public 全文件哈希、三CSS链接/幂等检查、同TEMP fixtures + `tests/app-check.cjs --output-root`、适用 `exe-check`。通过 UI4_ASSETS_ROOT 指向包内public、UI4_EVIDENCE_ROOT指向新包内截图目录，重跑同一UI4联合Electron。不能拿 app-check 代替renderer。
9. 查看真实截图至少深浅宽窄/未知审批/原生边界；还没人工逐图检查。Windows系统原生caption接缝未获得系统窗口捕获，不算关闭。
10. 汇总最终 `UI-4-integration-acceptance.md`（尚未创建），按回滚边界本地提交产品/测试/证据，报告最终SHA与clean状态，停止。**禁止push/main merge/tag/version/release**。

## 现有辅助脚本

- `preflight.json`, `merge.log`, `merges.json`：输入与历史证据。
- `run-full-test.ps1 -Phase baseline|final`：固定当前worktree、新TEMP、真实退出/时间记录；baseline已结束，final未启动。
- `run-job.ps1 -Name <jobs.json中的key>`：每次新TEMP，记录命令/exit/time；当前有 electron、runtime-electron、approval-electron、feedback-electron、cdp。
- helpers 用 Start-Process -WindowStyle Hidden 启动。不要并发GUI。重跑前把旧 attempt 的 log/process/results JSON保留到新名，避免抹掉失败证据。
- B/C/A桌面测试默认输出已改 `.shots` 或 UI4_EVIDENCE_ROOT，防止覆盖其输入报告证据。

全程未安装/覆盖用户正在使用的Pi GUI；本任务也不负责把安装版v0.24切换到此开发分支。
