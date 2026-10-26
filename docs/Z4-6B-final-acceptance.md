# Z4-6B 最终集成、完整验收与发布准备

本报告是作者自验材料。**独立代码复验、Z4-6A 合并后的正式集成、最终提交的 PR CI 与发布决策分别独立。**
唯一执行者：Codex；未调用其他 Agent。日期：2026-10-26（上海时间）。

## 1. 功能集合

Z4-1 原型确立结构化流程图与受控操作；Z4-2 将纯协议、Owner authority、安全存储、事务及面板接入生产；Z4-3 接通现有 Pi RPC 的可信建议来源和预览/接受/拒绝；Z4-4 提供布局预览、显式确认及 SVG/PNG；Z4-5 增加多选、批量移动/删除、内部复制粘贴、对齐和快捷键；Z4-6A 修复慢轮询、导出释放定时器及过大 PNG 分配。本轮不增加功能、不重构画布或 Pi 通信。

## 2. 基线与 Z4-6A 合并状态

- 已验收分支 `codex/z4-6-stability`，本轮开始 fetch 后本地/远端均为 `db2bbf2e88801c01940484e6ba4ea920e0256722`，没有未经审计的新提交。
- 开始时 [PR #35](https://github.com/HYJ1817/pi-gui/pull/35) **open，merged_at=null**；main=`adbff9da03350623e4e81e5b11bf9b75cdbbe923`。
- 执行期间PR35于**2026-10-26 19:32:42（上海时间）**实际合并，merge SHA=`c7fbad65500e1c20b6084f421c7920d8f77ffbc6`。已重新fetch并核对父提交与完整树；任务输入确认的A独立验收不替代本轮B独立复验。
- 最新正式 Release 仍为 [v0.29.0](https://github.com/HYJ1817/pi-gui/releases/tag/v0.29.0)，本轮只读核对；未改版本号。
- 远端证据：[开始快照](evidence/z4-6b/remote-snapshot.json)、[收尾快照](evidence/z4-6b/final-remote-snapshot.json)；本地集成与原工作区状态见[integration.json](evidence/z4-6b/integration.json)。

## 3. 独立分支与精确身份

Worktree：`C:\Users\21022\.codex\worktrees\z4-6b-final-integration\pi-GUI`。
分支：`codex/z4-6b-final-integration`，从上述已验收 HEAD 创建，未修改 Z4-6A 原 Worktree。
被测生产代码 tree：`c2a8b1ae49ac759690ebf355bff8f4946aede514`。
最终交付 HEAD 为包含本报告的本地提交，解析命令：

```powershell
git log -1 --format=%H -- docs/Z4-6B-final-acceptance.md
```

报告不能包含自身提交哈希；最终消息给出实际 SHA。行为基线、验证入口提交与证据提交分列，不将基线 CI 冒称新 SHA CI。

## 4. 与 main 的关系及 B6 门槛

开始时 `git rev-list --left-right --count origin/main...HEAD`=`1 4`：main 独有 PR34 merge，本分支继承 Z4-6A 四提交。`d919fc90a59d8d83aebabfd6bddbc727f9e4ee90` 与 main tree 相同；Z4-6A 稳定性差异完整保留。
本轮未重复 cherry-pick 这些提交，未 rebase、reset、force push 或提前合并本分支到 main。

**B6现已完成。** 实际merge `c7fbad6`的父为`adbff9d`和已验收`db2bbf2`，tree仍为`c2a8b1ae49ac759690ebf355bff8f4946aede514`；`git diff db2bbf2 origin/main`为空，已验收代码是main祖先。分支安全`git merge --ff-only origin/main`成功，无冲突、无重复提交，未重写历史。
集成后`npm run test:collab` **21/21套件**退出0，50,486ms；`npm run test:collab:packaged` **40/40**退出0，2,001ms，App/SEA各14项资源仍与源文件相同。证据：[integrated-collab.log](evidence/z4-6b/integrated-collab.log)、[integrated-packaged.json](evidence/z4-6b/integrated-packaged.json)。没有变化的文件树不要求无故重复79分钟完整运行；本地完整证明覆盖相同生产代码及canonical链，但不冒充新main push CI。

## 5. 本轮改动及回滚边界

- `scripts/verify-collab-packaged-gui.mjs`：显式执行的 Windows 打包窗口验证入口，复用 candidate-pi、现有网络 guard 和原生 Inspector/CDP，无新增依赖。
- 验证入口本地提交：`c209832314b4f52ff9225c24ae3cdf01acb7d24e`。测试时文件SHA256=`2ce8897f79a5ad40f5d889e18de27be3b0262945bbd50d103e991b8cb2f99ed4`，与提交内容一致。
- `docs/Z4-6B-feature-audit.md`：逐功能实现/入口/最新结果/Electron/Pi/模型/风险。
- 本报告、执行计划及 `docs/evidence/z4-6b/`：本轮日志、JSON、截图、同 attempt CI artifacts。
- **没有修改生产模块、package.json、锁文件、工作流、依赖或 Electron 版本。** 没有数据迁移。

打包验证依赖本机明确构建的产物，是 opt-in 环境资格脚本，类似现有真实 Pi 探针；不是新增默认 canonical 测试套件，不另抄测试叶清单。

## 6. 完整功能审计

见 [39项逐项审计](Z4-6B-feature-audit.md)。本轮重新读过服务/路由/authority/store、review authority、proposal source/queue、纯数据协议、panel/canvas/productivity/export 和实际测试入口。
所有模型栏为未验证；控制面、fake Pi、真实模型分别标记。已有抽象足够，无需新存储或第二套状态机。

## 7. 真实 Electron 最终回归

环境：Windows x64，宿主 Node24.22.1；独立 Worktree `npm ci --offline --no-audit --no-fund` 恢复93包，未升级锁文件。Electron44.4.3，Chromium152.0.7977.130。

| 命令 | 本轮结果 | 证据层 |
| --- | --- | --- |
| npm run test:collab:electron | **55/55**；observed9/residual0；errors=[] | 生产server/renderer/preload/Registry + fake Pi |
| npm run test:collab:productivity-electron | **35/35**，21次成功PNG及超大图拒绝 | 实际Chromium装配窗口；无Pi |
| npm run test:collab:advanced-electron | **6/6** | 实际Chromium装配窗口；高级多选使用人工dispatch |

三套均正常 sandbox=true、contextIsolation=true、nodeIntegration=false，没有 `--no-sandbox`。没有拿旧截图作本轮证据。
canonical中既有的`ui2-visual.cjs`/`cdp-shot.cjs`使用带`--no-sandbox`的headless Chrome；本轮没有修改该配置，也不把那些布局结果当作正常Electron沙箱证明。正常沙箱资格仅来自上面三套及另外明确读取偏好的打包窗口。

E覆盖Classic/Runtime编辑保存、生成预览/明确接受、A/B/A、关闭恢复、CAS冲突、760/1200/1536px、深浅主题和真实pointer单节点拖动。P覆盖布局预览/单批确认/撤销、导出与URL。A的6项不能冒称完成系统鼠标框选或批量拖动。
E本轮100节点/200边载入实测**575ms**（门槛5000ms），仅为该夹具中的窗口载入，不是模型响应或极限压力测量。
本轮截图：[Runtime](evidence/z4-6b/electron/collab-runtime.png)、[760px](evidence/z4-6b/electron/collab-760.png)、[浅色](evidence/z4-6b/electron/collab-light.png)、[建议预览](evidence/z4-6b/electron/collab-agent-proposal.png)。已实际打开检查窗口截图；P窄窗图仅证明工具条换行，旧夹具恢复的大跨度图处于画外，不将空stage当作可见图形证明。

## 8. 真实 Pi 控制面及上游兼容

实际命令与结果见 [commands.jsonl](evidence/z4-6b/commands.jsonl)、[real-pi.json](evidence/z4-6b/real-pi.json)。Pi仍为 **1.4.0**，**9/9**，3710ms，modelCalls=0。
Classic启动/get_state、空闲Stop、新会话、异常进程退出→恢复→bridgeRun增长通过；Runtime production session-runtime adapter独立会话、空闲Stop、guardian cleanupConfirmed=true。两个Classic子进程均退出。
本机官方安装包 `docs/json.md:36-56` 和 `rpc-commands.md:37-40` 再核对：assistant终值在message_end.message，agent_settled含aborted，prompt disposition=started/queued/handled仍兼容当前来源契约。未修改上游程序或schema。
真实模型活跃事件顺序、运行中取消、完整Registry模型链路仍未验证；R不能替代它们。

## 9. 真实模型状态与人工 smoke

**未验证，未运行。** 用户没有授权本轮向当前模型发送测试prompt；未添加密钥、切换提供商、购买额度或产生模型调用。
后续取得明确授权后，在TEMP合成Git项目、独立应用数据中，Classic和Runtime各执行：

1. 创建三个初始节点，记录revision及文档摘要。
2. 请求Agent增加判断分支。
3. 核对真实Pi的agent_start、assistant message_end、agent_settled归属。
4. 查看建议，确认预览前后权威文档摘要完全相同。
5. 明确拒绝；文档不变，旧proposalId再次接受必须拒绝。
6. 重新生成，并核对新的来源与proposalId。
7. 明确接受；保存后revision仅推进一次，变更与预览一致。
8. 关闭并重开核对已保存节点/边；区分新editor的空历史。
9. 在同一editor里撤销、重做并核对字节/版本。
10. 再次生成中Stop，确认权威终态与迟到帧无法应用。
11. 两个通道分别验证，旧Owner/session/generation不可污染另一文档。
12. 退出并核对自有进程、URL、定时器和监听器清理。

## 10. 打包后完整 GUI

独立构建已完成，未覆盖安装应用，未安装或升级。App26/26、SEA49/49、collab-packaged40/40均退出0；App/SEA各14项前端资源SHA256与当前源文件一致，均实际启动后端验证Token、Origin和无Owner拒写。
产物版本0.29.0；App入口234.9MiB，整包约329.1MiB。构建使用本机既有Electron ZIP，`build:app -- --rebuild`同时重建SEA；没有下载或更换Electron。

实际桌面窗口已通过显式脚本验证：无系统输入握手的自动完整流程**27/27**、24,766ms；附加Windows系统输入后完整流程**28/28**、72,212ms，均退出0。结果：[自动流程](evidence/z4-6b/packaged-gui-verified/results.json)、[系统输入完整流程](evidence/z4-6b/packaged-os-input/results.json)。源码窗口和产物后端检查均不替代这个结论。该脚本使用TEMP HOME/userData/data/Git及fake Pi、真实打包exe；读取主进程实际偏好，保留正常沙箱。
已实际验证：创建三节点、原生文本输入保存、Shift框选、Ctrl多选、多节点拖动相对位移、单批对齐、Ctrl C/V、批量删除及精确节点/边撤销、布局预览不写盘/确认单批、SVG/PNG实际下载字节、无Owner拒写、面板重开历史清空和真实App重启文档完全恢复。系统输入成功运行的两个进程族observed=8/11，residual=0/0，exitCode=0/0；最终残留0。守卫installed=20、blocked=1。
网络处理：Chromium使用本脚本拥有的回环拒绝代理；打包Electron忽略NODE_OPTIONS的--require，因此通过主进程Inspector在入口执行前，仅向精确匹配的内嵌server.cjs启动命令前置现有离线guard。生产文件和Owner/RPC契约不变，证据范围明确为带此测试前置守卫的真实打包App。不是未经调试仪器的人工安装验收。
Windows Computer Use（`@oai/sky` SendInput）在唯一返回的TEMP窗口实际鼠标选择n2并按Right；磁盘x增加10、revision增加1、可信mouse/key各增加1。完整运行总可信mouse=18/key=5；其余多选、框选及快捷键由CDP Input驱动。不是物理硬件/HID实验。截图：[系统输入后](evidence/z4-6b/packaged-os-input/packaged-os-input.png)、[重启恢复](evidence/z4-6b/packaged-os-input/packaged-restarted.png)。已实际打开检查截图。
SEA仅完成后端与资源层，未另做其浏览器完整GUI。默认复验无需前台驱动：`node scripts/verify-collab-packaged-gui.mjs <绝对证据目录>`；`--os-input`另等待人工/Computer Use选择TEMP节点n2并按Right，再写本证据目录的`os-input-done.json`，脚本仍独立核对真实持久化变化；不能仅创建标志文件冒充系统输入。

## 11. Classic/Runtime 隔离

E真实生产Registry窗口已证明独立文档、Runtime编辑/接受建议不改Classic字节、关闭后旧Owner不可写、恢复新editor空历史。R仅证明真实Pi的两个适配器有独立native session。真实模型的跨通道运行及取消不由上述结果推定。

## 12. 安全与故障回归

本轮协同链实际结果：doc56/56（135断言）、store53/53（149，另skip1）、authority24/24（68）、service13/13（58）、queue10/10（53）、source32/32（170）、flow12/12（73）、HTTP8/8（41）。
覆盖Owner完整身份、session/generation、CAS原子批次、来源认证、拒绝终态、失效proposal、>50全批拒绝、路径替换/损坏/锁/权限相关故障、未经接受不写文档、源码字节不变。PNG在Blob/Image/canvas之前拒绝超限；没有放宽安全判据。
symlink权限skip单列，不计入53/53；0600/0700不是额外Windows ACL全面资格。关键Z4安全测试与独立安全审查不是同一结论。

## 13. 稳定性与资源回收

本轮canonical中的稳定性 **4/4、843断言**：40轮四文档混合Classic/Runtime拒绝/接受/撤销/重做及新service重开；40轮面板导出销毁与被跟踪资源归零；40轮画布复制/粘贴/布局。队列与attempts有界。
E正常退出自有进程残留0；P全部内部URL释放。补充`node --expose-gc tests/collab-stability.cjs` **4/4、843断言**退出0，命令19,720ms，循环16,825ms；第10/20/30/40轮GC后heapUsed分别**27,633,936 / 27,484,144 / 27,635,048 / 27,602,768字节**，rssBefore111,222,784/rssAfter217,497,600。见[GC日志](evidence/z4-6b/stability-gc.log)。短程循环不能宣布小时级长期运行或系统断电资格。

## 14. canonical / CI 身份

本轮从GitHub下载并本地重新运行现有summarizeResults校验五份artifact，**同run40287018398 / attempt1 / pull_request / checkout a4a13b168219abc48694b30e0f02d8dfc80a4ad1**：

| 组 | 完成/计划 |
| --- | --- |
| core | 145/145 |
| ui | 24/24 |
| security | 27/27 |
| native | 4/4 |
| faults | 21/21 |

合计 **221/221**，0 failed/cancelled/interrupted/skipped/unexecuted，allPassed/dataComplete=true，计划digest `4107868905bd69489a6f04b105d99170e944a0545d83f49ac043beda5b29a3fc`。8个job包括build和gate全部success。没有拼接attempt。
临时merge父为main adbff9d与Z4-6A db2bbf2，tree=c2a8b1ae49ac759690ebf355bff8f4946aede514，与本轮生产基线完全相同。不是Z4-6B最终SHA的CI，更不是正式main push。
本地完整`npm test`本轮**一次运行退出0**，4,790,986ms（79分50.986秒），未中断/续跑/拼接。唯一清单仍为package.json的test链及生命周期，递归展开**221叶**；本轮未删断言、未改canonical配置。完整日志和命令身份见[canonical.log](evidence/z4-6b/canonical.log)、[commands.jsonl](evidence/z4-6b/commands.jsonl)。运行起点db2bbf2；随后实际main合并树相同，新增opt-in脚本另以27/28项及文件摘要验证。
**内部断言skip不是叶命令未执行。** 本机明确记录：collab-store symlink1、candidate-adoption symlink1、日志symlink1、旧SACL witness8、inplace非空SACL2、新Object witness8；均不计入各套件通过分子分母。两个witness各0/0、skip8，未取得真实审计资格，未调整权限或将非空SACL冒充空SACL。详见[skip摘要](evidence/z4-6b/local-skip-observations.json)。其他实测包含Object writer19/19、Object faults45/45、Object service30/30、Runtime真实组合26/26；不据此授予P33生产资格。
最新main push CI [run40315861760](https://github.com/HYJ1817/pi-gui/actions/runs/40315861760)绑定精确`c7fbad6`、attempt1，最后核对仍进行中，**未验证**。最终B PR尚未创建，其实际checkout同attempt完整canonical与gate仍须执行。未自行创建PR或触发远端重跑。

## 15. 失败、未解决事项与风险

本轮保留**7次开发中探针失败**及其非零退出；最终27/27、28/28来自各自完整成功运行，不拼接失败运行中的通过项。汇总及测试脚本/CI ZIP摘要校验见[final-verification.json](evidence/z4-6b/final-verification.json)。

| 未解决资格项 | 风险等级 | 当前处置 |
| --- | --- | --- |
| 真实模型输出与运行中取消 | 高（完整模型链路发布资格缺口，不是确认缺陷） | 未授权不调用，人工smoke已准备 |
| 独立功能/安全复验与最终B PR CI | 高（验收与合并门槛） | 待独立复验及后续用户授权；不能宣布完全具备发布资格 |
| 新main push CI | 高（正式发布门槛） | 精确c7fbad6的run40315861760仍进行中；未验证 |
| 长期运行、安装升级、完整SACL及物理HID | 中（未取得对应环境资格） | 单列未验证；不扩大本轮范围或修改系统权限 |

- B6正式main集成：已随PR35实际合并解除并完成，无文件冲突。
- 真实模型输出/拒绝/接受/运行中Stop：未验证；重要资格缺口，不能宣称完整模型链路通过。
- 最终B分支PR/main精确SHA CI与独立功能/安全复验：待执行；不冒用A的完整证明。
- 打包探针首次全局require缺失已通过Inspector绑定调查确认；改用process.mainModule.require。曾有一次页面早期求值异常，具体异常未完全定位，后续等待DOM/绝对导入；保留结果，不宣称产品根因已修复。
- Inspector未脱离导致退出观察超时、NODE_OPTIONS未安装打包后端guard，均为本轮探针问题；原失败JSON和后续修正分别保留，不删除失败。
- 入口暂停时awaitPromise求值超时；改用同步注入后取得两次后端guard安装与完整窗口通过。早期缺失backend guard的失败尝试没有全离线证明，不能声称其中不存在自动更新的外网尝试；未运行真实Pi模型。
- 首次Windows系统方向键被Computer Use以检测到用户输入拒绝，作者过早结束握手导致durable-operation超时；此失败保留于packaged-gui-final-v2。重新唯一定位窗口并确认实际按键后才结束握手，最终28/28；未把被拒绝的按键计成通过。
- A历史UnknownVizError本轮三套E未复现，不等于已定位修复；长期稳定、安装升级、完整Windows ACL与断电故障资格仍无新证明。

## 16. 最终 PR 建议

本轮不创建PR。正式集成已完成，独立Worktree保留；下一步仅建议安排独立验收，复核新增opt-in脚本的进程/临时目录/前置guard边界。最终B PR应只描述A合并后的真实增量、具体证据与模型限制，不重复引入A提交。准备稿见[Z4-6B-pr-draft.md](Z4-6B-pr-draft.md)，不是已创建的PR。

## 17. 发布准入结论与收尾

**当前不能宣布完全具备发布资格。** B6真实集成已完成；真实模型、独立复验与最终SHA CI仍未满足。开发、验收、合并、发布各自独立。

| 结论 | 状态 |
| --- | --- |
| 开发完成 | **是**（本轮已授权开发、集成和验收准备范围；外部资格另列） |
| 代码验收通过 | **待独立复验** |
| 关键安全测试 | **通过（已执行的Z4范围）**；symlink skip与真实SACL未验证单列 |
| 本地完整canonical | **通过**，一次npm test退出0，221叶声明完整执行 |
| 完整CI | **最终B PR未执行**；A同树基线221/221已通过，新main push进行中未验证 |
| 真实模型E2E | **未验证**，未获调用授权 |
| 打包GUI | **通过**，实际App正常沙箱+TEMP+fake Pi+测试前置guard，27/27及系统输入28/28 |
| 允许合并B | **待授权** |
| 允许发布 | **待授权** |

本地验证入口提交c209832与包含本报告的证据提交按回滚边界分开。无push、无新PR、无远端合并、无tag、无发布；本分支仅对已由外部合并的main执行了本地安全快进。

## 18. 回滚与保留

本轮没有生产行为变化或数据迁移；可单独`git revert c209832314b4f52ff9225c24ae3cdf01acb7d24e`回滚新增验证入口，证据文档可保留供审计。不删除原Worktree、已安装应用、真实项目或历史验收材料。测试fixture仅清理自身经realpath确认位于TEMP的目录；异常残留按进程创建身份核对，不以PID序号单独判定。
Z4-6A三个生产修复继续保留；不把回滚本轮文档/验证入口当成回滚A功能。独立Worktree保留，等待后续集成与独立验收指令。
