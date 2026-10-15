# P33-D5：GUI 逐次风险确认与异常恢复交互验收

日期：2026-10-15。仅在本轮 D5 授权内开发；原始本机测试日志包含2026-10-14的执行记录。不批准 Q1/Q2/Q3，不开放正式 B，不进入 D6，不提交、推送或发版。

**结论：D5代码、独立TEMP GUI闭环、最终日常回归及构建验证已完成，可提交人工验收。** Source与Electron测试构建各122/122；最终npm test退出0。该结论限于下述明确边界，不代表正式产品具备B写回资格，不批准Q1/Q2/Q3，也不自动进入D6。

## 1. 基线与现场

开发前与当前交付 HEAD 为 `72b34999613866a06c7974e2b5641f5747bb3d80`，main。版本仍为0.24.0，v0.24.0 tag仍为 `ec546d5a3711a21d2dbc911d661eb52742774be0`。本轮没有执行当前仓库的暂存、提交、Git恢复或ref变更；下文 Git 不变的文件系统对照针对 TEMP 测试仓库。未重新联网刷新 Release，本地发布基线不冒充远端实时状态。

原有未跟踪 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`、既有 build/dist-app 及旧私有证据保留。D4基线完整120命令的退出0记录及冻结哈希已核对，作为开发前基线复用，没有写为本阶段重新执行的基线。

## 2. 修改文件及模块边界

- `public/session-changes-panel.js`：沿用会话变更/历史材料右栏，增加独立对象恢复入口、历史记录与上下文失效接线。
- 新 `public/session-revert-object-ui.js`、`session-revert-object-api.js`：单文件确认、恢复状态机与固定关闭的正式传输；`public/styles.css`只增加局部样式。
- `server/session-revert-object-contract.js`、`session-change-store.js`、`session-revert-object-recovery-reader.js`、`session-revert-object-service.js`：v3风险确认、旧v2只读迁移及有限显示字段。
- 新 `server/session-revert-object-presentation.js`；`server/session-revert-routes.js`只增加只读资格、历史投影和workspaceFingerprint。A的writer、metadata、service及其拒绝规则没有修改。
- 新 `tests/session-revert-object-{presentation,ui,confirmation}.cjs`；`package.json`唯一 test 链由120变123，原命令顺序保留。
- 既有三个 TEMP harness/issuer 及 object history/recovery/store 测试仅迁移确认输入，不升级 evidenceLevel/objectEvidenceVersion/unknown、不删除旧断言。
- 新 `tests/session-revert-object-electron.cjs` 与五个 `tests/fixtures/session-revert-object-d5-*`：独立测试构建、私有IPC、实际Pi RPC、窗口与Native编排；不进入正式组合根或安装包。
- 本文。最终清单以 Git diff 与未跟踪的新文件为准，不包含原有用户目录或私有日志。

## 3. GUI 结构与只读兼容

先使用原有“查看撤销预览”读取后端 C→R Diff，再询问独立 B 资格。Diff 不会解锁写入，A失败不会自动调用B。正式资格恒为 `eligible:false/applyEligible:false`，原因 `production_allowlist_empty`；界面显示“正式产品尚未开放此受限恢复”。

已资格的独立 TEMP 测试显示“备份后恢复该文件（受限）”。Prepare完成实际持久C/R后才打开专门确认层，显示会话、Workspace、相对路径、Provider、字节数、后端Diff、备份就绪与过期时间。前端不计算候选正文，不提交路径或候选字节。

原P33.5a的query、预览、历史比较、A备份导出继续存在，原只读UI27/27保留。没有多文件批量恢复、rename、目录或Git恢复语义变更。

## 4. 风险版本与后端校验

`OBJECT_RISK_VERSION`由2升为3，不在同一个版本号下改变含义。后端严格白名单要求四个独立布尔值都为true：

| 字段 | 本次确认内容 |
|---|---|
| externalWritersPaused | 用户暂停外部写入；程序只尝试停止已知任务 |
| lastCheckRaceAccepted | 最后检查后仍可能有外部竞争 |
| partialOverwriteAccepted | 原位写入非整文件原子，中断可留下部分覆盖，不自动重试 |
| metadataLimitsAccepted | C/R仅是已读正文；未保存缓冲与完整元数据历史不在恢复保证内 |

外层 riskNoticeVersion 必须为当前3，并与服务保存的plan/provider/profile/proof/helper/token、完整scope匹配。GUI私有桥接还比较fileId/objectId；不能由renderer声明supported、风险版本、路径或字节升级资格。确认只属于当前plan，默认四项未勾选，不保存永久同意。

## 5. 旧版兼容与迁移

执行计划验证仅接受v3；持久读取单独使用 `validatePersistedObjectPlan`接受原v2/v3。v2的C/R仍可只读校验和导出；旧token不能Apply，不能objectCreate/objectUpdate升级风险版本，不能直接作为新恢复写入来源。

重启v2 prepared→not_applied、replacing→recovery_required，原风险版本不变。读取器验证完整日志前缀，不自动修复损坏journal。迁移测试使用明确构造的旧版hash-chain快照；不是自然断电证据。新契约套件45/45含实际Native正常确认、四项缺失/假值/多余字段拒绝及四种历史状态材料读取。

## 6. 生产资格与隐私

正式仅新增 `/api/session-revert/object-qualification` 和 `object-history` 两个只读投影，经过既有认证、authority与revalidate。资格不从文件大小、Diff、Windows标志或用户勾选推导。元数据未知不会被改为supported。

历史投影固定字段，不返回C/R正文、refs、token、helper/proof、ACL/SDDL或私有材料路径。限定当前可信完整scope，不能凭历史列表记录重新取得写权限；跨backend/generation的历史材料仍须D4的可信只读授权，不由当前请求补造owner。

正式 transport 的prepare/apply/recovery/export方法固定拒绝，不发现window测试全局、不读环境开关。B执行路由未注册，renderer不能直接访问Native Writer。

## 7. 弹窗、键盘与异步身份

确认初始焦点为取消，Tab在当前确认层循环，Escape关闭并返回原入口；未完成四项确认的Enter不能提交，关闭不发Apply。发送后禁用确认与复选框，重复点击沿用一次操作，不创建第二个requestId/commit。

UI绑定完整context签名、选择revision、plan/provider/file/object/risk版本；新plan要求conversation/workspaceId/epoch/fingerprint/runtimeGeneration全部匹配。会话/项目/Worktree切换、证据变化、TTL或stale结果使旧确认失效，每个await结果返回后重查当前身份。

页面刷新、SSE与Approval历史事件只更新显示/失效状态，不重新确认或提交。请求超时显示不确定结果，不自动重发新的requestId。后端继续复核authority、revision及对象身份，关闭Modal不是唯一保证。

## 8. 完成与异常状态

只有 `ok:true + applied_verified + durable:true` 才显示本次验证完成；缺失/null/矛盾持久性进入恢复检查。成功只描述完成时观察，展示持久记录、备份及对象保持结果，不保证未来内容不变。

`not_applied`、`durable:false`、`recovery_required`分别显示；材料不可读、journal损坏、工作区失效使用固定安全文案。异常无普通“重试”按钮，不把当前字节等于C/R认作历史成功。

补审发现的材料可读取/恢复可执行混淆已以负例复现：`recoveryAvailable:true`不能替代 `recoveryEligible:true`。界面现只在后端明确给出新计划资格时启用创建入口，缺失/false均禁用；收紧后的构建及独立Electron闭环已重新通过，初次完整链只保留为中间证据。

## 9. D→C 与材料导出

重新恢复必须观察当前D、复核对象/资格、保存并读回D、读取原始C，再创建全新plan/token/requestId及四项未勾选确认。D备份不就绪时不打开第二次确认。旧失败记录不删除，第二次失败仍需人工检查，不自动回滚。

测试桥接按有界、同scope/file/object的plan链区分原始C/R与后续D，不能把恢复plan的currentRef（D）误标成原始C。GUI只显示后端列出的实际可用材料。导出为带plan标识的新下载文件名，不接受目标路径、不直接向项目写入；旧/失效响应不能触发下载。

## 10. 独立测试能力与真实 Pi RPC

测试issuer自己新建TEMP Git根、Store、owner和私有WeakSet capability。专用Electron主进程通过匿名父子IPC挑战启动，preload只暴露固定方法；ipcMain核对WebContents、mainFrame、来源及有界白名单。静态HTTP服务不提供写入API；另一个窗口、任意root/path/bytes请求都不能取得资格。

Pi使用真实SDK工具执行器和JSONL RPC循环；fixture stream生成write/edit，通过真实扩展捕获/结算两条新对象证据。owner及测试authority是隔离夹具绑定，不冒充正式Runtime Registry；D4真实Registry/Worktree回归另列。

本机已绑定Pi为1.2.0，生产捕获资格仍限定1.0.4。测试在核对公开API及实际source handshake后，显式DI支持这次实验；没有修改生产版本门槛、全局安装或伪造版本。只使用合成TEMP凭据满足RPC预检，stream不调用外部模型。此证据不是生产Pi1.2兼容资格，也不是真实模型任务。

## 11. Source / Electron / SEA 的证明范围

| 形态 | 状态与范围 |
|---|---|
| Source独立Electron测试 | 最终122/122，失败0、跳过0；两档DPI，正常GUI/Native、两次异常、新确认恢复及材料导出闭环 |
| Electron测试构建 | 最终122/122，失败0、跳过0；复制正式Electron runtime到独立TEMP测试APP，独立测试main读取正式最终包的public/Helper；同一完整闭环 |
| 正式APP后端 | 实际进程四个B入口405，stdin测试issuer无效；没有产品GUI写回能力 |
| 正式SEA EXE | 实际EXE49/49及相同四入口405；本阶段没有SEA GUI Native测试 |

专用测试APP不是普通发布安装包。普通server.cjs不包含私有core或D5 IPC入口；测试构建不得分发。Native Helper使用D4已验证的固定资源/内存字节路径，没有新增共享TEMP可执行缓存。

两种形态均在125%和150%分别61/61；每档正常场景一次commit，异常场景两次真实Native完成后的结果管道故障均进入recovery_required，C/R/D下载字节核对后，第三次全新确认完成恢复C。故障是测试桥注入的结果通信错误，不是自然崩溃，也不是本轮复现了部分覆盖。每代current备份均与该次测得字节一致，最终对象ID与可观测元数据复核通过，TEMP Git index/HEAD/ref对照不变。

四组一致的内容SHA-256：C `b6e76c0ae045490989a70cd1a36bf4f5f08e914fe6d1c3d2c7365e66f708b21b`；R `ab07e2047c424ebbe79ff7d8badf152f4858ffa6ec82611b7a188f17757303f3`；独立D `b144ba9d980aff389bb81f92eee2a2ad16798c596e1a0357571c66ad0e54f6eb`。正常终态digest=R，重新确认恢复的终态digest=C。证据见 `.shots/p33-d5/source-summary.json`、`packaged-summary.json` 和 `.probe/p33-d5-final-electron-summary.json`；两份summary的私有测试源码哈希完全一致，并逐项等于当前文件。

## 12. Helper、源码与产物对应

| Helper | SHA-256 |
|---|---|
| D1 Observer | `230eade3a3611f2340b8ecb3d536b61d2adb88deabc44b44d7c59ec065a2063f` |
| D2 Writer | `7d773b63777d97a6a78d9a81c37cf946929062b22028425889258becd3aa39ef` |

Helper字节、Native API、访问mask和提交协议均未改；风险确认v3是服务契约，不是Native协议升级。特权SACL八组只按D2原环境/同Helper范围复用，没有声称本机普通令牌重新通过八组。本机不可读取的SACL继续unavailable。

日常受测输入清单 `.probe/p33-d5-daily-frozen.json`。最终产物对照为 `.probe/p33-d5-final-build-hashes.json`：四个public文件与两个Helper均与源码逐字节一致；APP与独立SEA构建的server.cjs一致。最终UI SHA-256为 `c344454fdef64a97b1198bdfb06355f3b61f9974d024397042f58ad8cdad9cbb`，server.cjs为 `f52e1a1504b6bf5bb37a7b928e01c873196361e06782b4da9eccd1f00a8f716a`，Electron宿主为 `3ad6e2a8f56f02931f116d707d2ed5f4bdddcafc4f4d5a2afb8bc0d509467925`，最终SEA EXE为 `14009896457bc664697d8d8c378856a48670e3aaf267f401e4ac31281d5bec4e`。输出均在独立TEMP根，具体根及原始构建日志保留于私有证据清单；没有混用初次产物哈希。

## 13. 完整测试与构建记录

| 命令/套件 | 已有实际结果 | 层级与限制 |
|---|---|---|
| object-presentation | 25/25 | 纯投影、HTTP及authority DI |
| object-ui（最终收紧） | 52/52，退出0 | jsdom/DI交互，不证明布局 |
| 原session-change-ui | 27/27，退出0 | 原断言保留 |
| object-confirmation | 45/45，退出0 | 真实Native、持久迁移及明确构造/DI |
| D3 store/service/reader | 38/38、30/30、51/51 | TEMP持久、Native及故障注入 |
| D4 history/runtime | 11/11、25/25 | 文件/授权DI；真实Registry/Worktrees/fixture Pi进程 |
| 独立Source Electron E2E | 122/122，失败0、跳过0 | 实际窗口/鼠标/键盘、Pi RPC fixture、真实Win32及结果管道故障注入 |
| 独立Packaged Electron E2E | 122/122，失败0、跳过0 | 正式包资源及同哈希Electron宿主；专用测试main，不是正式入口开放写回 |
| 初次完整npm test | 123命令，退出0，3004.8613291秒 | 收紧前33个P33套件942/942；权限跳过18另列 |
| 最终完整npm test | 123命令，退出0，2863.109693秒；P33共33套件944/944 | 原120命令顺序不变；权限跳过18另列；冻结20项输入哈希一致 |
| 初次build:app -- --rebuild | 退出0，同时执行build:exe | 离线缓存、独立TEMP输出 |
| 初次test:app / test:exe | 26/26、49/49，均退出0 | 收紧前正式构建检查，不替代最终包 |
| 初次正式B边界 | 2/2，退出0 | 真实SEA及Electron后端，各四路径405 |

收紧后的 `build:app -- --rebuild`、独立 `build:exe` 均退出0；APP26/26、SEA49/49及正式B边界2/2均已重新通过。独立build:exe第一次使用已存在的隔离输出被“必须全新目录”保护拒绝；未清空目录、未绕过保护，另建全新TEMP输出后通过。原始拒绝日志同样保留。

原始日志保留在 `.probe/p33-d5-*`。Electron最终日志为 `p33-d5-source-final4-run.log` 和 `p33-d5-packaged-final4-run.log`；两进程退出0，复核记录为 `p33-d5-final-e2e-verification.json`。环境为Windows NT10.0.26200.0 x64、Electron44.4.3、Node24.21.0、Chrome152.0.7977.130。Source/packaged首次boot至最后Native apply回复的进度跨度为735.302/734.088秒，不含初始构建和末尾报告序列化，不能当作完整进程耗时。

此前夹具错误包括300秒总watchdog不足、object history误接旧history，以及final3两层在第二次失败处提前匹配旧recovery_required、Native尚未结束就断言计数。对应修正为合理的有界超时、接到正确历史投影，以及同时等待确认层关闭和异常终态，再重跑完整两层/双DPI。未削弱断言；失败日志及TEMP根保留。

最终完整回归原始记录为 `.probe/p33-d5-final2-test.log/.exit/.seconds`，解析清单为 `p33-d5-final2-summary.json`。运行 `npm test` 前为该轮新建独立TEMP并设置TEMP/TMP/TMPDIR，SEC_PORT=18011。18项权限跳过分别为旧SACL见证8、原位研究2、新Object SACL见证8；均不计入944/944。相对初次942/942仅新增两项恢复资格负例，没有删除旧断言。尚未验证真实外部模型任务、POSIX、其他Windows版本、系统级缩放切换、普通生产全入口GUI写回；普通B本来就必须关闭。

实际执行构建/检查为 `npm run build:app -- --rebuild --output-root <全新TEMP根>`、`npm run build:exe -- --output-root <另一全新TEMP根>`、准备fixtures、`npm run test:app`、`npm run test:exe`；独立E2E为 `node tests/session-revert-object-electron.cjs` 及同命令追加最终APP的resources/app绝对路径。完整输出根和hash对应关系见 `p33-d5-final-build-hashes.json`，具体调用、日志和退出码保留在 `.probe/p33-d5-*`。

## 14. 尺寸、DPI与截图

六档目标宽720/900/1200/1280/1440/1920，125%/150%使用Electron启动时 `--force-device-scale-factor`，核验实际devicePixelRatio及物理PNG尺寸，而非网页zoom。Windows窗口边框和取整使125%实测CSS宽为722/902/1202/1282/1442/1922，PNG为902/1127/1502/1602/1802/2402 ×1377；并非精确720等CSS像素。布局断言基于实际viewport。没有修改用户系统的Windows显示缩放设置；这证明应用在对应设备比例下的布局，不冒充系统设置切换或全部原生窗口装饰验证。截图来自TEMP合成内容，使用Electron鼠标/键盘输入；DI点击不能替代。

最终两种形态、双DPI均包含六档确认、侧栏收起、完成、异常、历史重开、第二次确认、再次失败、C/R/D导出及恢复完成截图，共56张。150%实测CSS宽正好为720/900/1200/1280/1440/1920，PNG为1080/1350/1800/1920/2160/2880 ×1650。逐张尺寸、devicePixelRatio及路径列于两份summary；真实输入、焦点与溢出断言通过。人工已查看Source125恢复确认、Packaged125窄屏及Source150窄屏等实际截图，四项风险、换行和按钮完整可见。

## 15. 逐项安全答复与阶段决定

| 问题 | 当前结论 |
|---|---|
| GUI能绕过后端资格吗 | 正式无可执行B传输/路由；独立测试还须私有capability和服务重验 |
| 正式APP能执行B Apply吗 | 不能；空allowlist、固定拒绝工厂和实际进程边界保持 |
| 四项风险是否前后端一致 | v3精确四项true；旧v2只能读，不迁移确认 |
| 旧Modal会写错Workspace吗 | 本地context/选择失效加后端完整owner、revision、对象校验；非单靠关Modal |
| Enter/Escape会误提交吗 | 未完成确认Enter、Escape及关闭零提交；四组真实E2E通过 |
| 重复请求会二次WriteFile吗 | D3 requestId幂等、UI一次提交；四组实际双击均仅一次commit |
| SSE/Approval重放会恢复吗 | 没有执行连接，历史只显示，不恢复确认 |
| 是否先保存D | 新plan必须backupReady后才打开新确认；四组实际持久材料逐字节核对通过 |
| 是否自动回滚/重试 | 没有，不确定进入recovery_required |
| GUI实际Native C→R→C是否完成 | 两种独立测试形态、两档DPI均通过；异常结果后仍须新观察/备份/确认，不自动恢复 |
| 哪些属于真实Pi | 实际JSONL RPC与工具执行器，模型输出为fixture stream，不是外部模型 |
| 正式产品是否仍只读 | B仍只读/关闭；原有A与Git功能保持原语义 |

原位写入仍可能部分覆盖；未知外部进程、最后检查后的D与元数据竞争不能完全排除。C/R/D只保存实际读取的正文，不能恢复未保存缓冲或完整安全元数据。本阶段不改变这些风险审批边界。

本轮D5独立Source/Packaged闭环及规定回归已完成，未发现需要开放生产权限才能完成的阻塞，可申请人工验收D5。普通正式Electron完整入口没有被作为可执行B测试入口，正式SEA只做后端/关闭边界检查；这些边界如实保留，不冒充已上线自动撤销或生产全链路资格。人工验收通过后，才可另行申请D6最终资格与生产开放决策。本轮到此停止；未提交、推送、发版或更改tag。
