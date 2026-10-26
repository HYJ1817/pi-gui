# Z4-6A 真实环境验证与稳定性收口

状态：**本地开发与可运行的离线定向/窗口/产物后端验证完成，等待独立验收。真实模型、完整canonical、打包后完整窗口流程未验证；不能宣布Z4系列全面验收通过。**

## 身份、范围与提交

- 仓库 HYJ1817/pi-gui；单Agent顺序工作，未调用子Agent。
- 基线/Z4-5 HEAD：`d919fc90a59d8d83aebabfd6bddbc727f9e4ee90`。
- 开始时main为`0ec517a17b041b857fc1f83afc1040d0c9fb90e0`，PR34尚未合并；收尾检测到PR34于2026-10-26 15:10:50（上海时间）合并，最新main为`adbff9da03350623e4e81e5b11bf9b75cdbbe923`。远端Z4-5最终HEAD仍为上述d919fc9。
- 分支：`codex/z4-6-stability`；独立Worktree：`C:\Users\21022\.codex\worktrees\z4-6-stability\pi-GUI`。没有修改Z4-5原Worktree及其产物。
- 最终HEAD：本报告交付提交，精确解析 `git log -1 --format=%H -- docs/Z4-6A-acceptance.md`。行为/测试与证据后补文档分别记录，不声称文档HEAD有新CI。

| 本地提交 | 文件与回滚边界 |
| --- | --- |
| `b54fd253f7e7325342ca780b9998df4e1fec0b20` | public/collab-panel.js、collab-export.js、collab-canvas-productivity.js：慢轮询、定时器与PNG分配上限 |
| `c115c16fe569fafba8a4281637715bb7d6a661bf` | package.json、scripts/verify-collab-real-pi.mjs、tests/collab-stability.cjs、panel-agent/productivity/packaged与两个Electron runner、两个fixture：回归和验证基建 |
| `d4e8a336898df4046bd35f7f7e219bc5f1f6e1e9` | 测试退出同时核对exitCode/signalCode，生命周期监听器按事件类型计数；补最终GC取样 |
| 本报告交付提交 | 本报告、矩阵、findings、docs/testing.md、docs/evidence/z4-6/证据 |

全部变更清单：`git diff --name-status d919fc9..HEAD`。零新依赖、零依赖版本更新、零数据迁移；未修改server/Pi/身份/CAS/存储事务/图形协议。

## 调查结论与最小修复

现有authority、存储、source/queue、Runtime Registry与panel生命周期足以承担本轮需求，未重建抽象。完整A→F验证范围与12项安全映射见 [矩阵](Z4-6-test-matrix.md)。

确认并修复3项产品缺陷，均有修复前失败、修复后通过的回归：

1. 慢于1.5秒的查询被重叠轮询不断判为过期，Runtime建议ready却不预览；改为每面板一次在途查询。
2. 销毁面板只revoke下载URL，没有clearTimeout；现同步清理两者。
3. 合法大跨度坐标可导致PNG巨额分配；现分配前拒绝单边>16384或总像素>16Mi，提示先整理或导出SVG。SVG与文档坐标协议不变。

另修复生产力Electron夹具不执行入口、裸await、两个runner失败路径清理与证据目录隔离。原成功PNG模拟使用超大图的两处正向夹具改为可光栅化的种子图；保留renderer scale透传、异步快照绑定断言，新增超限拒绝断言。没有删除旧断言或放宽Owner/事务/沙箱条件。

问题→复现→根因→最小修复→回归及未解决事项见 [findings](Z4-6-stability-findings.md)。

## 六层证据与Classic/Runtime矩阵

| 场景/层 | Classic | Runtime | 范围说明 |
| --- | --- | --- | --- |
| 单元/服务/实际存储/HTTP | 通过 | 通过 | 复用collab及Runtime测试；TEMP IO、注入事件 |
| 正常窗口用户编辑/保存/切换/恢复 | 通过 | 通过 | 生产server/renderer/preload/Registry，Pi为fake |
| 建议生成→预览→明确接受/撤销 | 通过 | 通过 | 真实Electron55/55中的两个通道；不证明模型 |
| 新Owner/代次、工作区、停止与队列隔离 | 通过 | 通过 | authority/source/flow、Runtime/Stop、窗口关闭/恢复/项目切换 |
| 真实Pi控制面 | 通过 | 通过（直接session-runtime adapter） | 启动、get_state、空闲Stop；Classic异常进程退出后恢复；Runtime监督进程清理。未运行真实模型Registry E2E |
| 真实模型输出/运行中取消 | **未验证** | **未验证** | 没有确认已授权且无需额外费用的环境；零prompt、零模型API费用 |
| 打包App/SEA后端 | 通过无Owner拒写与资源摘要 | 通过无Owner拒写与资源摘要 | 无有效Owner，不等于会话生成或打包窗口测试 |
| 打包后完整窗口/安装升级 | **未验证** | **未验证** | 无发布/安装授权；产物后端不冒充完整桌面流程 |

### 真实Pi RPC

本机Pi **1.4.0**，Node入口由既有pi-launch确认；读取安装包官方 `docs/cli.md`、`docs/json.md:36-56`、`docs/rpc.md`、`docs/rpc-commands.md`。**agent_settled是此版本上游正式事件，含aborted；bridgeRun则是GUI桥接盖章，不是Pi字段。** 不能将一个版本的事实泛化给未知Pi版本。

命令（已执行，退出0，9/9控制面检查，4142ms）：

```powershell
node scripts/verify-collab-real-pi.mjs C:\Users\21022\AppData\Roaming\npm\pi.cmd "$env:TEMP\pi-gui-z46-evidence\real-pi.json"
```

TEMP HOME/agent/session，白名单子进程env、禁用资源发现/MCP、`--offline`和既有网络preload。guard安装20项记录、blocked=0；没有读写真实会话或注入认证。Classic两次子进程已退出；Runtime cleanupConfirmed=true。探针初版有Windows NODE_OPTIONS反斜杠解析与将signal退出误记为未退出的夹具错误，均已修正，未修改Pi或产品桥接。

没有模型run，所以没有观测agent_start/message_end/agent_settled运行顺序，也没有证明真实生成中的取消、迟到消息或异常恢复。相应自动化证明来自fake事件/进程，人工真实模型smoke清单见矩阵。

## 定向回归（实际运行，退出0）

环境：Windows x64 / 10.0.26200，宿主Node24.22.1；独立本地依赖目录。原Worktree node_modules为空导致首次基线在jsdom导入处中断；随后 `npm ci --offline --no-audit --no-fund` 按锁文件恢复93包。无依赖升级。

`npm run test:collab`：**21/21套件**，具体检查数如下。日志与结构化摘要见 [test-summaries.json](evidence/z4-6/test-summaries.json)。

| 套件 | 检查数 | 断言/skip |
| --- | --- | --- |
| Z4-1原型 / doc / store | 49/49、56/56、53/53 | doc135；store149，skip1（symlink权限） |
| authority / service | 24/24、13/13 | 68、58 |
| queue / source / agent-flow | 10/10、32/32、12/12 | 53、170、73 |
| HTTP / canvas / panel | 8/8、72/72、11/11 | 41、72、58 |
| panel-agent | 9/9 | 97；单独绿测98，fetch mock每次调用计断言，轮询时序差异，不是删除断言 |
| auto-layout / layout-preview / export | 51/51、44/44、48/48 | 51、44、48 |
| productivity / panel-productivity | 61/61、14/14 | 61、71 |
| selection / advanced / z45-regressions | 37/37、89/89、41/41 | 37、96、41 |
| stability | 4/4 | 843，40轮有界循环 |

本轮重跑的未修改基线20套件中queue/source/flow也是10/32/12；旧Z4-5文字中的12/21/32不能作为断言减少的证据。新增panel-agent 8→9、productivity60→61、stability4项；旧功能断言全部保留。skip不计入通过分子分母。

| 其他命令 | 实测结果 |
| --- | --- |
| npm run test:runtime | 20/20叶命令退出0，约85s。registry35、HTTP12、store25、UI16、nav38、conversation48、changes60、secondary24、Git UI6、resources45、cleanup16、models51、history35、finish27、session-runtime7、supervisor24、browser48、budget4、events14、真实Win32 process10，各自分子=分母 |
| npm run test:stop | stop-barrier17/17 + gui-browser-stop12/12 |
| npm run test:logging | 32+7+9+8+11=67项通过，0失败，另skip1 |
| npm run test:session-concurrency | scheduler9/9、bridge6/6、resolver7/7、ordinary-runtime5/5 |
| npm run test:ci | 221 leaves / 5 groups coverage exact；ci-results10/10、summary30/30、history21、doc-scope28/28、release-proof16、NSIS12/12；退出0。不等于执行221叶 |

首次F运行collab在两处超大PNG正向夹具失败（TypeError后续访问未产出的结果），更正正向数据并补超限断言后完整collab链重新运行退出0。原失败与复跑分别保留，[targeted-results.json](evidence/z4-6/targeted-results.json)不是单次全部成功的伪装。

### 正常sandbox Electron

默认独立目录Electron **44.4.3**、Chromium152.0.7977.130、内嵌Node24.21.0。正常sandbox/contextIsolation，nodeIntegration=false；没有no-sandbox、没有关闭系统安全设置。历史共享目录0x80000003的Windows根因仍未知；当前新目录版本探针退出0、三个窗口专项已取得证明。

| 命令 | 实测 | 证据 |
| --- | --- | --- |
| npm run test:collab:electron | **55/55**（54业务+1进程清理），observed9/residual0；errors=[] | [结果](evidence/z4-6/electron/results.json)、[Runtime截图](evidence/z4-6/electron/collab-runtime.png) |
| npm run test:collab:productivity-electron | **35/35**，含21次成功PNG、超大图拒绝、URL回收 | [结果](evidence/z4-6/productivity-electron/results.json)、[PNG](evidence/z4-6/productivity-electron/z44b-export-light.png) |
| npm run test:collab:advanced-electron | **6/6**，宽窗/多选/760px实际窗口 | [结果](evidence/z4-6/advanced-electron/results.json)、[多选截图](evidence/z4-6/advanced-electron/z45-multiselect-active.png) |

曾有一次原生Browser capturePage的UnknownVizError；未改截图或加重试，后续完整运行通过。此项保留“尚未确定”风险，未冒称修复。窗口循环不等于小时级长期运行。

### 长会话与资源

- 40轮混合Classic/Runtime、4份文档：生成/拒绝后不可接受、重新生成/接受、撤销重做、关闭/新service重开。队列size≤32、attempts≤33；dropAll后0/0/0。
- 40轮面板挂载、SVG导出、交替会话失效和销毁：被跟踪URL/timeout/interval/文档生命周期监听器均归零。
- 40轮画布挂载、结构化复制/粘贴、自动布局确认、销毁；脱离DOM的按钮不能提交。总90秒超时与finally TEMP清理。
- 默认测试RSS由约117MB升至262MB，不能单凭RSS推断泄漏；补 `node --expose-gc tests/collab-stability.cjs`：4/4、843断言、26271ms。第10/20/30/40轮GC后heapUsed分别 **27,617,640 / 27,464,336 / 27,617,312 / 27,576,960字节**，短程未见线性增长。RSS约231MB，仍不是长期内存上限证明。见 [GC证据](evidence/z4-6/stability-gc.log)。
- 正常窗口100节点/200边载入测得 **1099ms**（门槛5000ms）。不是模型延迟或极限负载测量。
- 既有store故障注入本轮重跑：flush后异常exit/外部kill、双真实进程CAS、锁残留、损坏UTF8/journal/版本、路径替换、真实Windows文件占用等；保持原字节、无自动接受。没有新核心安全协议修改。

### 构建与产物

```powershell
$env:PI_GUI_ELECTRON_ZIP_DIR='C:\Users\21022\AppData\Local\electron\Cache\bb424f9061e7a2927a7fcc04709593fe81ac4633e2cd40456f2ef431743b1ee7'
npm run build:app -- --rebuild
npm run fixtures
node tests/app-check.cjs
node tests/exe-check.cjs
npm run test:collab:packaged
```

均退出0；App26/26、SEA49/49、协同产物40/40。构建仅使用本机既有Electron ZIP；新产物在本Worktree的build/dist-app，不覆盖主Worktree或安装应用。App exe246,324,736字节，构建报告整包329.1MB。
协同产物检查扩展为14个前端资源摘要（新增export/productivity等），App/SEA均与当前源文件一致，认证/Origin/无Owner拒写保持。完整摘要见 [packaged.json](evidence/z4-6/packaged.json)。此处实际启动了两个产物后端，不只是静态字符串检查；没有运行打包后的完整窗口或安装升级。

## 普通Windows终端精确复验

在上述Worktree中执行，不改系统设置；不需要真实模型：

```powershell
Set-Location 'C:\Users\21022\.codex\worktrees\z4-6-stability\pi-GUI'
$env:Z4_COLLAB_OUTPUT="$env:TEMP\z46-manual-electron"
npm run test:collab:electron
$env:Z44B_OUTPUT="$env:TEMP\z46-manual-productivity"
npm run test:collab:productivity-electron
$env:Z45_OUTPUT="$env:TEMP\z46-manual-advanced"
npm run test:collab:advanced-electron
```

如启动失败，先保留各results.json/runner日志和fixture输出目录；记录node版本、electron/package.json版本、electron.exe的SHA256、进程exitCode/signal及创建时间、操作系统build、会话是否交互式，和ELECTRON_RUN_AS_NODE/ELECTRON_OVERRIDE_DIST_PATH这两个变量的值。只记录这些白名单，不dump全部环境或任何key。用 `node -e "const c=require('node:child_process');const r=c.spawnSync(require('electron'),['--version'],{encoding:'utf8',timeout:15000});console.log({exit:r.status,signal:r.signal,version:r.stdout,error:r.error?.code})"` 比较最小进程；需要时再收集同时间范围的Windows Application Error/模块信息。不要通过no-sandbox或反复重装取得假通过。

## canonical、集成与剩余门槛

- **Z4-6完整canonical仍待验证**：没有运行本轮完整 `npm test`；遵照任务书留最终PR CI。本轮test:ci只验证221叶编排。
- 开发前PR34的attempt1失败，不能沿用旧报告；收尾已核验同run的 **attempt5成功、220/220叶**，五组与gate全部success，所有下载JSON均绑定run40278098767/attempt5/pull_request，allPassed/dataComplete=true。见 [基线CI证据](evidence/z4-6/baseline-ci-attempt5/ci-summary.json)。没有拼接不同attempt，也没有由本Agent触发重跑。
- 注意SHA区别：run的PR head是d919fc9，artifact实际checkout为PR临时merge **1a813c302e9c4ddcd7e3ceecd88131b0553dd1ae**，不能称为d919fc9或真实main的直接exact-SHA运行。已从GitHub核对临时merge父提交0ec517a+d919fc9；它、d919fc9与真实main adbff9d的Git tree均为 **626f23b5003ee89223c30ff1de8aaf0eb9b94a93**。因此可复查为基线相同文件树的完整证明，不能代替Z4-6增量或真实main push CI。
- **Z4-6B只读准备已完成，未执行集成**：实际merge SHA为adbff9d；fetch后 `git diff d919fc9 origin/main`为空，d919fc9是main祖先，本地三个提交完整继承Z4-5全部修复。收尾文档提交前图关系为main独有1个merge提交、本地独有3个提交。没有新增main文件差异可被本轮覆盖；按当前树预计没有内容冲突，但未通过实际合并来宣称冲突解决。
- 必要集成步骤：由用户安排正式集成分支；重新fetch并核对main是否继续推进，对比panel/productivity/export/package测试链及Electron fixture；若Z4-5或后续main有修复，按逐项diff保留。**不自动rebase/merge/force push/创建PR**。当前原分支与本地提交保留，等待用户安排。
- 正式集成还需最新main回归、完整同attempt canonical CI、独立功能/安全审查、普通终端Electron复验、必要的打包窗口测试，以及真实模型的另行明确授权和实际证据。
- 用户明确单Agent，本轮仅作者自审；没有独立Agent通过意见。所有core安全边界原实现保持，但本轮不能自批验收。

## 回滚与交付结论

保留现有基线分支即可回到原行为；如需撤销已集成本地提交，按回滚边界依次revert测试补验d4e8a33、测试提交c115c16，再revert行为提交b54fd25；不使用会覆盖未提交工作的reset/整文件restore。回退行为后重新执行离线 `npm run build:app -- --rebuild`，不涉及数据迁移；已存文档保留。文档证据提交可保留用于审计。

| 阶段 | 结论 |
| --- | --- |
| 开发完成 | 是，Z4-6A本地范围；已列真实环境/最终集成缺口 |
| 代码验收通过 | **待独立验收** |
| 测试完成 | 离线定向、上述窗口与产物后端完成；完整canonical/真实模型/打包完整窗口未完成 |
| 允许合并 | **未授权** |
| 允许发布 | **未授权** |

本轮仅本地提交：未push、未创建PR、未合并、未打tag、未发布。交付后停止，等待独立验收。
