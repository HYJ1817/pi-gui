# P33-D4：Runtime、Worktree、生命周期与打包集成验收

日期：2026-10-14。仅执行 D4 集成开发及仓库测试器自己建立的 TEMP 用例。没有生产原文件写回授权，没有提交、推送、发版或进入 D5/D6。

后续交付授权：用户在收到本报告及 EXE 47/48 未通过说明后明确要求“推送”。据此仅提交并推送本轮 D4 代码、测试和报告，不认定 D4 已通过人工验收，不批准 Q1/Q2/Q3、不发版、不进入 D5/D6。按回滚边界拆分：`e623787` 为后端身份/生命周期/资源边界，`8dfe71a` 为构建与测试，本文另作独立文档提交。提交前复核既有完整测试记录与冻结源码哈希一致；未将此前的50分钟测试写成本轮重新执行。

**验收结论：尚未达到 D4 全部验收要求。** 实现与隔离 Native/Runtime/打包闭环已交付，完整 npm test 退出0；正式 APP 回归26/26，EXE回归47/48。EXE的诊断断言失败保留，没有删断言或新增可选渲染依赖来取得通过。生产B仍关闭，不申请进入D5。本文区分实际进程/Native、故障注入与Mock，不以数量代替安全资格。

## 1. 基线、现场与开发前检查

开发前 HEAD 为 `56fcac162af4bc5dd58e269606f3e10e2e8472c6`，分支 main；本轮没有提交，因此交付 HEAD 不变。v0.24.0 为 `ec546d5a3711a21d2dbc911d661eb52742774be0`，package 版本 0.24.0，未改 tag。未联网刷新远端/Release，不能将本地 origin 缓存当作远端实时状态。

D3 的三个回滚边界实际为：`bb1c6a1` 持久 Store、Object Service/Contract、只读 Recovery Reader；`a34d24c` 三套件及 canonical 入口；`56fcac1` 验收文档。正式组合根没有注册 B Provider、可执行 Object Service、Object Apply 路由或 Recovery Reader 的材料读取入口。

原有未跟踪 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/` 保留；既有 build/dist-app、私有 CI 证据和用户项目未清理。所有新增构建使用新建 TEMP 的 `--output-root`，默认构建路径语义不变。

开发期完整旧 115 命令链退出 0、2252.7785501 秒，但执行期间 D4 文件有变化，属于中间回归，不作为严格冻结的开发前源码资格。另有两个旧装配夹具缺依赖导致完整链中断，保留失败日志；修补后原断言分别 12/12、16/16，重新执行最终完整链。

## 2. 修改范围与架构

新增 `server/session-revert-object-runtime-authority.js`：在 P32 Authority 外增加 B 的当前 owner/root/context 复核，以及只读历史授权适配器；没有第二套 runtime 注册中心。

`runtime-registry.js` 增加完整 owner 绑定的有限资源管理和 contextRevision。`session-revert-admission.js` 增加 BigInt 目录对象身份；`session-revert-authority.js` 在 Stop 前后验证 context。`server.js` 只提取原 A 的 Stop/drain 组合为共用工厂，未装配 B 服务。

`session-revert-object-contract.js`、Service 增加不可变 runtimeContext；旧历史 plan 不能凭当前请求获得该上下文。Recovery Reader 增加受信任历史只读方法；未提供历史 Apply。

新增固定资源 loader，Observer/Writer 复用；Store、容量探测、只读材料 ACL 探测使用同一已验证绝对系统 PowerShell。没有修改两个 Native Helper 的字节、权限掩码、Win32 API 或协议。

build-app/build-exe/make-icon 支持独立输出；scripts/util 的构建资源复制改为明确 Unicode 文件系统遍历，拒绝输入链接，避免本机 Node 24.14 cpSync 中文目录损坏。没有重写 PDF 的缓存/字体/抽取机制。app/exe 检查允许选择独立构建产物。

新增四个日常套件 `object-assets/authority/history/runtime`，纳入 package.json 唯一 npm test 链；原 115 命令顺序及断言保留，变为 119 命令。独立 `object-packaged` 使用正式资源及单独测试启动器，不在普通安装包装配。两个既有 Stop 夹具补上实际装配依赖，未删断言。

实际35个交付文件（含新增文件；不包含用户原有未跟踪目录和gitignore私有日志）：

- `package.json`；`scripts/build-app.mjs`、`build-exe.mjs`、`make-icon.mjs`、`util.mjs`。
- `server.js`；`server/runtime-registry.js`、`session-change-store.js`、`session-revert-admission.js`、`session-revert-authority.js`。
- `server/session-revert-object-contract.js`、`session-revert-object-material-reader.js`、`session-revert-object-observer.js`、`session-revert-object-recovery-reader.js`、`session-revert-object-service.js`、`session-revert-object-source.js`、`session-revert-object-writer.js`、`session-revert-storage.js`。
- 新 `server/session-revert-object-resources.js`、`session-revert-object-runtime-authority.js`。
- `tests/app-check.cjs`、`exe-check.cjs`、`gui-browser-stop.cjs`、`stop-barrier.cjs`。
- 新 `tests/session-revert-object-assets.cjs`、`session-revert-object-authority.cjs`、`session-revert-object-history.cjs`、`session-revert-object-packaged.cjs`、`session-revert-object-runtime.cjs`。
- 新 `tests/fixtures/session-revert-object-packed-boundary.cjs`、`session-revert-object-packed-build.cjs`、`session-revert-object-packed-issuer.cjs`、`session-revert-object-packed-launcher.mjs`、`session-revert-object-runtime-harness.cjs`；本文。

## 3. 完整身份与生命周期

绑定九字段：backendInstance、projectId、repoId、workspaceId、workspaceEpoch、conversationId、runtimeId、runtimeGeneration、sessionId。同时校验 nativeSessionId、实际 canonical root、workspaceFingerprint、BigInt 卷/目录对象身份、当前 Registry lifecycle/focus/context、Admission；正文读写另复核文件对象/卷身份。

Classic 使用实际 Session Runtime、Changes Bridge、RPC 原生 session ID 和 primary owner 形状，关闭后清空缓存 session ID；已关闭/重新创建的旧 owner 不取得资格。Managed 使用 P32 Registry 的实际 adapter、owner/generation 和 Worktree 绑定。没有将 history/dormant 记录作为当前 Writer。

focus/blur 先同步使旧资源失效，不等待会反向等待 focus 的 dispose；retire 则等待资源与 Managed cleanup。失败保留 slot/root lease，固定 `cleanup_pending`，只能显式再次清理。资源每个 live owner 至多 32 个。

一项实际测试曾发现全局 Worktrees authority 持有到 Native Ready 会阻塞无关 Workspace，继而形成关闭/写入等待环。本轮 B 适配器改为仅在可信快照和各次 revalidate 时持有原 Authority；异步 Native attempt 由 workspace Admission、runtime resource 及 Native pin 持有。A 的原锁语义不变。

实际 Ready 后关闭 A：立即失效旧 owner，Native 未退出前仍拒绝新 Writer；无关 B 能执行实际 fixture RPC；取消/收束后释放 admission，未发 commit。超时或 cleanupPending 均不被解释为已经停止。recovery_required 只持久状态/材料引用，不长期持有全应用锁。

## 4. 多会话 Stop 与 Worktree

共用 Stop 工厂遍历同物理 root 的 Classic 和 Registry 已知 live Writer；先拒绝 Planner/CLI/Managed process 未清理，再等待各自 abort 确认；后续仍须复核 owner/generation/revision/context。未知外部进程不在该保证中。

真实进程用例验证 A 排空及 B 不受无关 root 阻塞；Authority 套件的同 root 多目标、排空失败、generation/context 变化属于 DI，不冒充真实两 Writer 并发。P32 同 workspace 两个 Managed Runtime 的现有限制仍是 `workspace_in_use`，没有为测试开放它。

真实 TEMP Git 仓库两个 Worktree 使用相同相对路径和独立对象，分别写入不同 R；cross scope 材料 refs 被拒绝，另一边内容保持。通过 revision/gapRevision、scope、owner、token、对象 ID 隔离。Git HEAD/ref/index 的前后实际字节/摘要检查不变。

实际旧 owner 关闭、Worktree 移动/同路径重建、同字节新文件对象反例均拒绝旧计划。focus A→B→A 即使最终 owner 相同，也因 contextRevision 变化拒绝旧请求。不能按路径重新绑定旧对象。

补充独立 TEMP 实测 `.probe/p33-d4-same-workspace-verified.log`：真实 Classic 形态 Session Runtime adapter 与 Registry Managed adapter 同物理 root，两个 fixture Pi 子进程 streaming；共用工厂等待两者 abort 后，A 的原 D3/Native 流程持久 applied_verified，无关 B 仍 streaming，1/1、退出0。活动状态由测试直接驱动 adapter，捕获证据由 harness 建立；这是实际进程/Native 证据，不是模型工具归因证据，也不额外计入 canonical 分母。

## 5. 重启与历史只读

实际 Registry 关闭、后端重建、resume 验证新 backendInstance/generation；旧 Native 已写 R 但结果损坏时持久 recovery_required。新后端的受信任 Session 读取授权、实际 session locator/文件身份/v3 header、原 Workspace/root 指纹通过后，只读读取历史 C/R，journal 内容及时间不变。旧请求仍拒绝，没有重放 commit，没有把当前等于 R 当作成功。

历史 scope 只取 Reader 已校验日志前缀，不能由当前请求补造。默认缺少可信 withReadAuthority 时先拒绝；材料读取不会注册旧 owner/签发 mutation。账本损坏仍只读完整日志前缀，不修复。

Classic 补充独立 `.probe/p33-d4-classic-history.log`：真实 fixture Session header、实际 Native 写入后的损坏结果、关闭和新后端、历史 C 读取、journal 字节不变、旧 Apply 拒绝，1/1、退出0。读取授权 callback 为 DI，实际文件/进程/持久材料为真实测试；不是正式产品历史材料 HTTP 功能。新写回仍须重新捕获完整当前证据并建立新计划。

## 6. Helper 来源与 SHA-256

| Helper | SHA-256 |
|---|---|
| D1 Observer | `230eade3a3611f2340b8ecb3d536b61d2adb88deabc44b44d7c59ec065a2063f` |
| D2 Writer | `7d773b63777d97a6a78d9a81c37cf946929062b22028425889258becd3aa39ef` |

Source 仅固定仓库内置资源；Electron 仅正式包 server.cjs 旁的静态资源；SEA 仅 getAsset 的内嵌资源。每次新读字节并比对固定 hash，缺失/篡改拒绝，无项目/PATH/客户端/helper path/env 选择开关。PowerShell 使用已核查的 SystemRoot 下绝对系统解释器；SystemRoot 是 OS 配置前提，不是同用户恶意进程隔离保证。

SEA **不解包可执行 Helper**：Observer 用内嵌字节的 EncodedCommand；Writer 仍用 D2 的 stdin bootstrap、hash 校验与 ScriptBlock。没有专用共享 TEMP `.ok` 可执行缓存；既有 PDF materializeDir 留在其原用途，不能提供 Native 执行信任。

D2 特权八格资格按既有固定 helper、API、mask、协议复用：run38383762389、实际源码672b3ed、Windows Server2025/26100 NTFS，8/8，失败0、跳过0；本轮没有重新获取权限或改变审计策略。资格只覆盖原样本/平台，不等于本机26200普通令牌能读 SACL，也不等于任意元数据或竞争情况保持。

| 观测项 | 本轮/复用证据 | 不作出的保证 |
|---|---|---|
| 文件 ID、卷身份 | Source 与 packed 真实 Native 前后校验；同字节不同对象负例 | 同文件名/同内容不能替代对象身份 |
| Owner、Group、DACL | 普通 Native 可读项前后后验；复用 D2八格真实完整SDDL | 不能恢复外部独立修改后的 ACL |
| SACL | 本机不可读时保持 unknown；同 Helper 的特权八格8/8复用 | 未声称普通令牌每次比较完整 SACL，不能排除并发修改 |
| ADS、EA | 受限路径只接收无命名ADS、可靠查询为空EA；Native 后验 | 八格非空ADS/EA见证不使生产支持范围扩大 |
| 属性 | 限定既有 Archive 四组合；本轮普通默认文件/后验，D2四组合证据保持其原平台范围 | 任意属性/只读文件/未验证组合不取得资格 |
| 时间信息 | 按现有 Native/observation 契约核验对象；正文修改时间允许变化 | C/R正文备份不是全元数据快照或回放工具 |

文件ID保持只是一项证据，不能推出全部安全元数据保持。Windows26200普通权限与Server2025/26100特权环境分别记录，不宣称同OS/全部令牌已全面配对。

## 7. Source 与实际打包证据层级

Source runtime 日常测试是真实 Registry/Worktrees、fixture Pi guardian 子进程和 Win32 Helper。捕获记录由 harness 建立，**不是实际模型调用 Pi write/edit**。本轮没有改 Pi 本体。

正式 APP/SEA 构建入口保持 B 关闭。另行测试 bundle 只在构建器内追加私有 core export，普通 server.cjs 中没有 createIsolatedWriter/createObjectServiceCore。测试启动器只签发自己新建 TEMP root 的私有 WeakSet capability；固定 stdin challenge/run 协议≤512字节，拒绝 root/path/bytes、旧 nonce、错误版本/命令；不监听写文件端口，不进入普通安装包。

| 形态 | 本轮观察 | 能证明的范围 |
|---|---|---|
| Source | 25/25 runtime；含 C→R、实际 Ready 后取消、真实写入后故障结果及重启材料 | 当前 Source 与独立 TEMP 编排 |
| Electron 后端测试启动器 | Electron RUN_AS_NODE 实际进程，读取正式 APP Helper，正常/协议故障持久闭环 | 正式资源与后端 runtime；不等于窗口 GUI 操作 |
| SEA 测试 EXE | 实际 isSea=true，内嵌正式构建资产，真实 Native 正常/故障闭环 | 实际单文件 EXE；不是普通 Node 模拟 SEA |
| 正式 APP 后端 | 四个 B HTTP 请求均405，stdin issuer 无效 | 普通后端没有测试资格入口 |
| 正式 SEA EXE | 同上 | 普通 EXE 没有测试资格入口 |

正常闭环实际持久 C/R→对象校验→Ready→replacing intent→WriteFile/EOF/Flush→R/元数据后验→applied_verified→重开材料。协议故障注入保留真实 Native verified 回应的计数，再损坏输出，持久 recovery_required；重开 C/R，并证明同请求没有第二次 commit。该故障不是自然断电。

中文+空格输出、同名恶意项目脚本、只读 Helper 文件、hash 篡改、独立 DATA_DIR 已纳入独立打包测试。只读文件属性不等于整个 resources 目录 ACL 的只读安装资格。

补充 `.probe/p33-d4-english-native-verified.log`：完整正式 APP 复制到独立英文 TEMP 目录，实际 Electron 测试启动器正常/故障 Native 闭环1/1；整个 resources/app 使用只读继承 ACL，并实际确认写入被权限拒绝后，同样闭环1/1，退出0。没有恢复或扩大此 TEMP ACL，目录保留。首次 ACL fixture 因继承 PowerShell7 模块路径而失败，修正该子进程 PSModulePath 后完整重跑；未改变系统权限。

`.probe/p33-d4-main-window-final.log`：正式 Electron main、窗口、后端实际启动，renderer exception=0、页面正文126字符、样式表2；通过应用 renderer 发起四个 B 请求均405，1/1、退出0。截图 `.probe/p33-d4-main-window.png` 已查看。首次测试错误地将 ELECTRON_RUN_AS_NODE 设空而未移除，随后外部 Node 请求被正式 token 认证401；两个夹具问题均保留日志，最终从实际 renderer 验证，不取出或输出 token。此截图是无项目首页，不是 P33 GUI 撤销交互；本轮没有该交互授权。

## 8. 正式能力、安全与隐私边界

PRODUCTION_OBJECT_ALLOWLIST 仍为空；正式 openOriginalAttempt 与 createSessionRevertObjectService 固定拒绝，不接受普通参数打开 B。Object 路由未注册，renderer/Pi Tool/环境变量没有测试资格。普通 HTTP/RPC 不读取原始 C/R，GUI 仍为 P33.5a 只读，没有按钮或风险确认交互开发。

A 的 writer、metadata、Service 相比 D3 均无修改，metadata_audit_unavailable 未放宽。旧 unknown/legacy evidence 不升级。未改 Git 恢复语义或 index/ref。

正式响应只固定错误码；test-only nonce、私有资源位置、C/R路径、ACL、SDDL 不进入正式 HTTP/SSE。历史 adapter 未暴露普通材料路由。私有 TEMP/原始日志保留在本机证据，不作为产品输出。

## 9. 风险与恢复

原对象写入仍可能部分覆盖，不具整文件原子性。外部 ADS/DACL/SACL/属性竞争与同用户恶意进程不可完全排除；C/R 是正文备份，不能承诺回放安全元数据。本轮没有批准 Q1/Q2/Q3，也没有生产注册。

Stop/drain 只约束后端已知 Writer，不是操作系统级的全写者排除。已知映射/分享冲突有实际拒绝样本，但不能据此保证所有外部正文竞争被排除。如果独立修改 D 出现在 C 备份后或提交窗口中且被覆盖，C/R 不含该 D，不能保证恢复它。成功的 R digest 也不能单独证明该窗口没有其他写者；用户确认不能消除这一残余风险。

不确定状态进入 recovery_required，不自动覆盖新 D，不自动 retry；材料保留并重新读取。失败的构建/测试材料保留。两次 TEMP 清理动作曾被自动审批拒绝，未绕过或再次清理。

## 10. 完整测试数据与冻结证据

最终冻结源码 `npm test`：119命令，原115命令全部按原顺序保留；退出0，3010.8809316秒（50分10.881秒）。30个P33套件822/822，失败0、权限跳过18另列；新增四个日常D4套件70/70。`verified-source.json`所有输入文件的SHA逐项复核无漂移，汇总 `.probe/p33-d4-test-summary.json`。测试时证据对应HEAD56fcac1加冻结修改清单，尚无D4提交；后续经用户授权提交为e623787和8dfe71a，工作文件哈希复核一致，文档提交不改变受测代码。

| P33套件 | 实际结果 | 主要证据层级 |
|---|---|---|
| 旧SACL witness | 0/0，跳过8 | 本机权限不足 |
| Object profile / evidence | 55/55、12/12 | 纯逻辑/捕获fixture |
| D4 assets / authority / history | 23/23、11/11、11/11 | 实际文件/Observer及标注DI |
| D4 runtime | 25/25 | Registry/Worktree/真实fixture进程、Native |
| D3 Object store / service / reader | 38/38、30/30、51/51 | 持久文件、Native服务、故障注入/DI |
| Session change store / bridge / tools | 36/36、24/24、31/31 | 捕获/持久fixture |
| P33逆合并 / revert store | 67/67、14/14 | 纯逻辑/文件 |
| HTTP / worker integration | 65/65、19/19 | HTTP/实际worker及fixture |
| A writer / recovery / admission / apply | 22/22、24/24、15/15、29/29 | 临时文件、metadata fixture/故障注入 |
| Windows faults | 13/13 | 实际Win32操作及metadata fixture |
| 旧inplace / inplace safety | 28/28跳过2、43/43 | 研究Native/故障注入，非生产资格 |
| P33.5a query / UI / startup | 34/34、27/27、11/11 | 文件/HTTP、jsdom、实际server启动 |
| D2 writer / faults | 19/19、45/45 | 真实Win32、明确标注故障注入 |
| D2 SACL witness | 0/0，跳过8 | 本机权限不足；不替代CI8/8 |

P32相关同一完整链实际结果：Runtime registry32/32、resource cleanup16/16、Session runtime5/5；Worktree lifecycle56/56（真实Git）、HTTP14/14、UI16/16；Managed processes28/28、Process tools25/25、Process Stop10/10；旧Stop装配16/16、浏览器Stop12/12。没有减少原有断言。

最终Unicode产物独立 `object-packaged` **9/9、失败0、跳过0、退出0**。实际测试SEA EXE与Electron后端各有正常 applied_verified 和结果损坏 recovery_required；正式两个后端各四条路由405。生产SEA EXE SHA `3f873378df737f4debf88cbb3d5716763f42711786aa86c7e1daa500a3045ad7`；专用测试SEA EXE SHA `f8c16830e47538b7ca7abcac9153a1307ebb701e85c0d98b8cff4a540e7cadbc`。测试EXE不是普通安装包。

同一最终Unicode构建的 `npm run test:app -- --output-root ...` **26/26、退出0**；`npm run test:exe -- --output-root ...` **47/48、退出1**。唯一失败是“运行期没有崩栈输出”：PDF.js捕获缺少可选 `@napi-rs/canvas` 的异常并输出 Warning，旧 `/Error:|throw/i` 正则匹配其中的 `Error:`。本机只读源码核查及私有进程诊断日志支持这个定位；PDF正文、页数、中文、docx、image实际断言通过。它不是已证明的Native写回缺陷，也不能据此把该检查写为通过。本轮未修改PDF逻辑、依赖、警告或这一断言。

为补齐原始构建stdout留存，最后按同一冻结源码又在两个全新TEMP输出目录直接执行：`npm run build:app -- --rebuild --output-root ...`退出0、13.2249139秒、整包328.0MB；`npm run build:exe -- --output-root ...`退出0、8.7193183秒、EXE94.8MB。原始 `.probe/p33-d4-build-app.log/.exit/.seconds`、`build-exe.log/.exit/.seconds`保留。这次日志构建与Native受测构建的server.cjs、manifest、两个Helper、index/styles字节哈希逐项相同，记录 `build-hashes.json`；没有将未运行Native的重建EXE冒充前述受测EXE。受测APP server.cjs SHA `3f7df69a6b67184ec532b29c1e79c75d6274b8e6150cfe3a28c2c90ae45a69f3`。

权限跳过单列：本机 SeSecurityPrivilege 缺失导致旧 SACL witness8、inplace2、新 object witness8；不计通过。另有 session-search 的无权限 symlink 用例。没有降低权限条件或删断言。

冻结源码清单 `.probe/p33-d4-verified-source.json`；原始 canonical `.probe/p33-d4-verified.log/.exit/.seconds`。打包原始结果 `.probe/p33-d4-packaged-unicode.log/.exit`；私有构建位置和保留材料记录 `.probe/p33-d4-packed-materials.jsonl`、`.probe/p33-d4-retained-materials.jsonl`。前期失败/中断日志同样保留。

## 11. 逐项答复与阶段决定

| 问题 | 结论 |
|---|---|
| 同名 Worktree 文件会串写吗 | 本轮独立真实对象/内容/cross-ref/Git 检查未串写；不把所有路径场景概括为已验证 |
| 旧 generation plan 控制新 Runtime 吗 | 当前 owner/context/revalidate 拒绝；历史只读不提升 |
| Stop 包含同 root 全部已知 Writer 吗 | 工厂遍历包含；DI及补充实际双 adapter/进程同 root 闭环通过；不包括未知外部进程 |
| 关闭 Runtime 会提前释放 Native admission 吗 | 实际 Ready 取消用例未提前释放；cleanup 失败保留 lease |
| 历史 owner 只能读吗 | Managed 与补充 Classic 实际材料只读，授权callback为DI，旧 Apply 拒绝；无正式材料 HTTP入口 |
| Electron/SEA 内置 Helper 实测了吗 | 专用测试启动器/实际 SEA EXE 实测；另有正式窗口和后端关闭实测；没有 GUI Apply |
| 同名用户脚本能替代吗 | 固定 hash/来源/绝对系统解释器拒绝，实际恶意 cwd 用例覆盖 |
| SEA 共享 TEMP 可执行缓存吗 | Native 无磁盘解包，无此缓存；PDF 缓存未作为可执行信任 |
| 正式 HTTP/renderer 能打开 B 吗 | 没有注册或开关；正式四路径405及固定工厂拒绝 |
| Source 通过、目标包未验证能报全通过吗 | 不能；本文明确未达到 D4 全部验收 |

目前不申请进入 D5。明确剩余验收问题是EXE诊断检查47/48；需要有界复核可选PDF警告与崩栈检测契约，不能通过关闭检查或扩大生产Writer权限解决。已有Native、打包和scope证据不因该警告变成生产授权；Q1/Q2/Q3仍待批准。交付本轮代码、测试及报告后停止，等待人工审查，不提交、不推送、不发版、不自动进入下一阶段。
