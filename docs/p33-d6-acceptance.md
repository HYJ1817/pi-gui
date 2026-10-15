# P33-D6：最终资格、产品闭环与生产开放决策

日期：2026-10-15。D5基线及开发前HEAD：`d04fe44bc12882a000d9097b1b343c6741f7df86`，main。本阶段只授权资格审查、独立TEMP验证及必要缺陷修复；不批准Q1/Q2/Q3，不提交、推送、发版，不改v0.24.0 tag。

开发后HEAD仍为同一提交；交付为未提交源码、测试和本文，具体字节由冻结manifest绑定，不能将HEAD简称当作已包含D6改动的提交。v0.24.0仍指向`ec546d5a3711a21d2dbc911d661eb52742774be0`。

**结论：NO-GO，保持正式B关闭。** 同平台普通/特权资格配对和完整产品装配仍有明确缺口。历史证据不计作本轮重跑，最终技术验证不代表生产风险批准。

## 1. 修改与执行边界

- 新 `tests/session-revert-object-qualification.cjs`：D6只读资格回归；验证固定拒绝、实际内置Helper字节、当前TEMP观察、未知SACL保留与旧证据拒绝。Owner/Group/DACL差异为显式DI，不冒充实际改权限。
- `package.json`：唯一日常链123→124命令，旧123条顺序保留；不新增依赖或CI重复列表。
- `tests/fixtures/session-revert-object-packed-launcher.mjs`、`tests/session-revert-object-packaged.cjs`：补上先前SEA缺失的独立D→C新计划/新确认和逐代材料验证。原9项专项断言保留，新增2项；执行步骤增加后，将有界进程超时300秒改为600秒。
- `tests/planner.cjs`：本轮完整链暴露§34依赖本机Claude安装状态，改为测试自己的registry固定不可用adapter；原“失败且说明不可用”断言保留并加强为start调用次数0。未修改生产Planner/Claude适配器。
- `server/session-change-bridge.js`、`tests/session-change-bridge.cjs`：捕获版本精确增加Pi1.2.0，仍要求公开API入口和write/edit声明、实际Extension握手，不扩大到其他版本；新增11项默认门槛回归。B资格不变。
- `tests/session-revert-object-service.cjs`：回环HTTP测试使用已有node:http，保留四个状态及四个响应体断言。Windows动态端口包含Fetch禁止端口，确定性复现6000端口的bad port；不改变生产HTTP行为。
- 新 `tests/fixtures/session-revert-object-d6-model-rpc.mjs`、`session-revert-object-d6-issuer.mjs`：显式外部模型专用TEMP编排，模型请求计数与匿名IPC授权；不进入日常模型测试或正式组合根。
- 本文。两个Native Helper、GUI代码及A/Git语义没有修改；新增可执行测试不得被正式组合根导入。

保留原有未跟踪 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`、旧build/dist-app、`.probe`和恢复材料。全部Native写入只发生在仓库harness自己新建的TEMP根。没有提权、调整审计策略或安装新运行时。

## 2. 本机与资源现场

本轮只读探测 `.probe/p33-d6-platform-audit.json`：Windows 11 25H2，OS基础版本`10.0.26200.0`，注册表build26200 / UBR9457，x64；C:为本地固定NTFS卷（driveType3）。当前令牌非管理员角色，无SeSecurityPrivilege，未尝试启用或分配权限。

命令行Node为24.14.0、win32/x64；本轮实际Source Electron为44.4.3、内嵌Node24.21.0（Chrome152.0.7977.130）。这两种Node运行时分别记录，不能把普通Node资源测试当成实际Electron进程。

当前可信PATH绑定Pi为1.2.0。用户已授权现有DeepSeek配置和独立TEMP合成内容，限制总计8次请求、每项目4次、每次输出不超过1024 token；不重试。选用安装包实际定义的deepseek-flash，默认magpie配置不冒充已验证模型。认证仅在内存读取和匿名IPC传递，不进入配置文件、环境变量、日志或报告；实际结果见§7。

| 项 | 固定身份 |
|---|---|
| Profile | `windows-original-object-v1` |
| Observer SHA-256 | `230eade3a3611f2340b8ecb3d536b61d2adb88deabc44b44d7c59ec065a2063f` |
| Writer SHA-256 | `7d773b63777d97a6a78d9a81c37cf946929062b22028425889258becd3aa39ef` |
| Native请求协议 | version1；open/ready/绑定commit/result；每次nonce/attempt/plan/intent绑定 |
| 目标mask | `0x12008b` |
| 父目录/输入材料/审计读取mask | `0x80` / `0x120089` / `0x01020080` |
| 核心数据API | CreateFileW、GetFileInformationByHandle、ReadFile、WriteFile、SetFilePointerEx、SetEndOfFile、FlushFileBuffers |
| 风险契约 | v3，四项均必须精确true |
| 当前生产Proof/allowlist | 没有生产Proof；allowlist=[] |

目标、父链、流、EA和安全描述符还有各自查询API；上表七个核心API不是完整元数据API清单。Helper字节固定不等于所有宿主加载链、OS补丁或安全描述符形状都已认证。读取可能改变访问时间，也可能触发PowerShell编译缓存，不能宣称零文件系统副作用。

## 3. D1～D5既有证据复核

| 阶段 | 本轮确认的既有证据 | 复用范围与限制 |
|---|---|---|
| D1 | 版本化只读观察；完整owner/path/ref绑定；原unknown不升级 | 同字节Observer来源；不提供生产保持证书 |
| D2 | 新Helper特权SACL八组真实8/8；普通26200四属性及故障研究 | 原始CI是26100；两个native及witness/harness自672b3ed未变；不当作本轮重跑 |
| D3 | 持久C/R、Ready→intent→commit、损坏日志合法前缀与新恢复 | 本轮完整回归复核实现；旧报告数字另列，不外推断电可靠性 |
| D4 | Registry、双Worktree、generation/Stop-drain、固定资源/SEA内存执行 | 已有测试中包含真实进程、Native和DI；不等于真实模型全链 |
| D5 | 两种专用Electron形态各122/122、双DPI56截图、fixture Pi RPC | supported:true及fixture stream；不是正式Pi1.2资格、真实模型或正式App写回 |

旧特权原始材料为 `.probe/p33-d2-ci-38383762389/d2-sacl-witness.log`、`run.log`及`verified-summary.json`。本轮直接解析原始JSON，确认8个唯一SACL/DACL组合，双轮各17项保持性检查均true，backupVerified=true、stage=complete、每格coreHelperHash等于当前Writer。受测源码为`672b3edbaf6aab2b81d1a34e9bf223d2e518e312`，原结果明确productionQualified:false。

旧原始manifest没有proofId、UBR/补丁、架构、固定卷资格、全部权限mask或独立协议摘要；D4还改变了JS资源和解释器加载路径。因此可复用同Native核心既有八组保持证据，不能称当前完整平台/产品链已经取得生产Proof。

## 4. 最终资格矩阵的规则

QUALIFIED必须同时具备同平台普通/特权实测、完整负向、当前加载链与资源、真实模型、相应Classic/Managed和产品形态闭环。已发现缺口的候选为UNQUALIFIED，未实际测试的组合为UNTESTED；两者都禁止进入未来allowlist。即使某个组件8/8，也不能把候选环境升为QUALIFIED。

| OS / 权限 | Source | Electron Packaged | SEA executable | 生产资格 |
|---|---|---|---|---|
| 26100 / 普通token | UNTESTED | UNTESTED | UNTESTED | 否：缺同OS普通令牌及当前链证据 |
| 26100 / 特权token | UNQUALIFIED：仅旧同核心8/8 | UNTESTED | UNTESTED | 否：旧manifest不完整，产品与模型门槛缺失 |
| 26200.9457 / 当前普通token | UNQUALIFIED | UNQUALIFIED | UNQUALIFIED | 否：缺同平台特权与完整产品装配；模型独立门槛见§7 |
| 26200.9457 / 特权token | UNTESTED | UNTESTED | UNTESTED | 否：本机无权限，没有自动提权 |

Classic/Managed各自的本轮Runtime/Worktree测试及真实模型范围另见§7；没有任一组合取得生产QUALIFIED。26100的历史UBR未知，不能补写成某个已资格补丁。其他Windows build、ARM64、非NTFS、网络/移动卷、POSIX一律无开放资格。

## 5. 普通与特权见证

本轮 `node tests/session-revert-object-witness.cjs --require-audit`：退出2，passed0、failed0、skipped8，原因existing_token_sacl_unavailable。日志 `.probe/p33-d6-strict-audit.log/.exit/.seconds`。这是严格门槛未满足，不是8/8通过，也没有继续尝试获取权限。

八种组合为显式/继承/受保护/混合SACL × 受保护/继承DACL。旧26100特权证据包含C→R→从持久C材料新attempt恢复、完整SDDL、SACL、DACL、Owner/Group、ID、ADS、EA和属性对照；本机普通SACL不可读保持unavailable/null。文件ID相等不替代安全元数据比较。

本机当前加载链的普通Native实测、四属性32/34/8224/8226及负向测试以本轮完整链日志为准；它们不能与旧26100特权样本拼成“26200双令牌资格”。

## 6. 负向安全与元数据边界

| 场景 | 现有实施/本轮复核入口 | 证据级别与边界 |
|---|---|---|
| 不同ID、同字节不同对象、父链替换、链接/reparse | object-service/runtime、object-faults、profile | TEMP真实对象/进程及DI分列；不能凭内容重新绑定 |
| ADS新增、DACL/属性变化 | object-faults外部进程；object-profile | 真实变化可被提交前检查拒绝；最后检查后竞争未完全排除 |
| EA非空/失败，ADS未知 | object-profile、object-faults | 实际非空及形状/失败注入；未知不当空 |
| Owner/Group变化 | 新qualification及现有profile | 字段差异DI，未在本轮真实改变Owner/Group；不能称真实并发权限修改证明 |
| 非NTFS、网络、特殊属性、无效编码、旧profile | profile、object-faults | 真实本机卷外的平台多为DI，不算该文件系统实际保持证据 |
| Helper篡改、来源替换、同名用户脚本 | object-assets及实际packed专项 | 固定源/hash；不走用户项目脚本或共享TEMP执行缓存 |
| 无审计权限 | 严格witness与普通observer | unavailable，严格见证未资格；不自动升级supported |
| 特殊ACL/ACE类型 | 仅既有矩阵中的常见形状有保持样本 | 当前known字符串/相等检查不是特殊ACE白名单证明；首批生产支持形状仍未形成可执行Proof |

以上不足没有被转换成生产支持。正式B关闭使未资格ACL无法取得生产写权限；不能把这一固定关闭误称为“已经验证每种特殊ACL会被专门分类拒绝”。

Native的metadataEqual仅表示该协议规定的身份、安全描述符可读部分、流/EA和受测属性等比较通过，不表示全部NTFS元数据逐项相等。正文写入会更新时间戳，读取也可能改变访问时间；没有整文件所有时间戳不变的承诺。无SACL读取权限时仍是unavailable/null。

## 7. Pi版本、真实模型与Runtime范围

开发前`server/session-change-bridge.js`仅允许Pi1.0.4，实际1.2.0返回pi_api_unverified。本轮检查本机可信安装包的公开SDK、默认write/edit、sourceInfo、Extension事件、SessionManager/AgentSessionRuntime与JSONL RPC；离线真实SDK启动及新会话重绑定核对成功。必要修复仅将捕获门槛精确增加1.2.0，未知版本、缺API、错误入口仍拒绝。未修改全局Pi、原始Session schema或B平台资格。

该最小修改先记录1.2.0默认prepare拒绝的RED，再取得bridge35/35、tools31/31、startup11/11，合77/77、退出0；日志`p33-d6-capture120-{red,green,tools,startup}.*`。桥接原24项保留，新增11项；prepare可用时sourceVerified仍false，必须真实握手才变true，不将声明存在当作捕获完成。

D5私有issuer显式supported:true且使用fixture stream；这些旧编排在本轮重跑时仍只证明fixture工具流。新D6 issuer不用supported覆盖，不手写Session header，调用实际SDK默认工具与捕获Extension；真实模型请求由父进程非退款许可和子进程HTTPS目标/模型/输出预算双重约束。`--build-only`不读凭据、不发送请求。实际模型结果单列，不能与fixture数字相加后声称真实模型门槛通过。

Classic与Managed通过既有实际Session Runtime/Registry/Worktree/fixture Pi进程复核完整九字段owner、nativeSessionId、root/fingerprint、generation/context、Stop/drain及Admission。D4 Runtime harness使用TEMP手写JSONL CLI、Changes supported:false、直接Store.prepare/settle/amendOutcome生成合成capture；不能与D5实际SDK工具fixture流拼成真实模型产品链。新D6 issuer的Managed使用真正Registry和独立Git Worktree，Classic使用createSessionRuntime适配Classic身份，仍非server.js正式Classic组合根。两者为匿名IPC凭据交付而注入测试supervisor，实际Pi SDK/RPC不等于正式guardian进程链。历史session存在不赋予当前owner写权限，跨backend/generation旧计划不能静默提升。

另需纠正日志标题的解读：`Registry process restart rediscovers dormant history...`用例实际调用harness的reopenRegistry，仅在同一Node进程内dispose并重建Registry；不能单凭这个标题声称后台OS进程重启。受控Pi子进程退出、runtime重建及同进程Registry重开分别保留为其真实证据层级。

### 本轮真实DeepSeek结果

实际使用deepseek/deepseek-flash，非fixture stream；两个项目分别4次HTTP请求，共8次，无退款、无自动模型重试，达到本轮上限后停止请求。每次输出预算1024 token。匿名IPC测试supervisor及私有主进程由`.probe/p33-d6-run-model.cjs`、`p33-d6-model-main.mjs`编排，未注册到正式server/Electron入口。

| 模式 | 实际观测 | 验收状态 |
|---|---|---|
| Classic / Source Electron125% | 两个真实默认工具write/edit；2条intent_verified、toolResultObserved=true、对象前后observed、九字段owner一致、gap=0；GUI实际R及独立D→C恢复完成 | 运行器31项后收尾失败，退出1、183.1969451秒；不记整套通过 |
| Managed真实Git Worktree / Source Electron150% | 完整捕获；两次真实Native、首次verified结果管道注入损坏进入recovery_required；独立D备份/新计划/四项新确认后applied_verified；C/R/D及对象metadata验证、Git index/ref不变 | 37/37、失败0、skip0，退出0、218.6878225秒 |

Classic持久账本实际保留3个计划：取消的not_applied、首次写入的recovery_required、新恢复的applied_verified。旧私有汇总错误地要求总数2；修复私有汇总为明确保留取消计划后，仅继续尚未运行的Managed项目，不重跑Classic、不增加调用预算。原catch未保留异常栈，因此不能唯一证明Classic最终throw必为该断言，不能把退出1改写成退出0。

独立只读RecoveryReader后验 `.probe/p33-d6-classic-postcheck.json` 验证完整23事件前缀、所有C/R/D材料字节/长度/digest、最终C、两个不同attempt持久intent与终态，且journal字节/mtime未变。它不独立证明Native调用/管道包次数；Classic没有持久初始Git快照，不能仅凭后验声称index逐字节未变。Managed成功汇总与Classic后验不可拼成“双模式完整测试全部通过”。

两个模式相同合成内容的C SHA-256为`b6e76c0ae045490989a70cd1a36bf4f5f08e914fe6d1c3d2c7365e66f708b21b`，R为`ab07e2047c424ebbe79ff7d8badf152f4858ffa6ec82611b7a188f17757303f3`。R保留人工预置和独立user later修改；恢复C的最终digest回到C。Managed保存三代状态、最终metadataEqual=true、对象ID相同。SACL仍unavailable，不变成完整安全描述符证明。

原始记录：`.probe/p33-d6-real-model.*`、`p33-d6-real-model-managed.*`、`p33-d6-model-budget-classic.json`、`p33-d6-model-budget.json`、`.shots/p33-d6-model/managed-summary.json`及两模式截图。实际工具与证据门槛已取得实测，**完整双模式产品真实模型门槛仍未全部验收**，不能据此给GO。另有私有Managed首次hello与sessionId绑定的静态竞态未在本轮触发；后续应复用生产装配已有的有界等待，不能靠延时猜测当前owner。

## 8. Source / Electron / SEA及GUI证据

本轮Source GUI使用原D5独立窗口编排。为保留历史截图，私有启动包装只将固定证据目录`.shots/p33-d5`改为`.shots/p33-d6-final`，不改变测试断言、IPC、Native、Pi或UI逻辑；原始/执行runner摘要在 `.probe/p33-d6-final-gui-runner-hashes.json`。早期`.shots/p33-d6`另留为中间证据，不冒充最终资源验证。不得把原始runner哈希等同输出目录变换后runner哈希。

Packaged GUI使用本轮全新正式APP的public/Helpers和同字节Electron宿主，单独TEMP测试main；正式server.cjs不导出测试core，不接收测试capability。测试窗口的真实鼠标/键盘与磁盘结果不等于正式安装包已经开放GUI写回。

SEA新增闭环直接执行测试SEA EXE，使用正式SEA相同内嵌Helper与原服务核心；两次真实Win32完成后注入结果管道损坏，再用独立D和新确认恢复C，逐代核对材料、ID及可观测metadata。Store/core重开仍发生于同一进程，**不是SEA进程重启、不是新backendInstance授权验证**。该产品门槛继续列为缺口，不新增任意root/RPC入口补绿。

正式SEA与APP后端分别执行B路由拒绝及stdin issuer无效测试；普通正式Electron主入口、Installer/Portable安装形态、真实Classic/Managed GUI链不由专用测试main代替。

GUI审查覆盖单文件、后端资格、C→R Diff/备份、四项v3确认、取消默认焦点、Enter/Escape/Tab、双击、异常后新D备份与新确认、C/R/D显式导出。会话/Workspace/generation/TTL/Approval/SSE/刷新失效中的DOM/DI断言与实际窗口用例分别标注；未把每个失效场景都写成真实多会话Electron实测。

最终Source再次122/122、失败0、skip0；125%和150%各61项，六种宽度与28张截图。人工实际查看720px真实模型确认框和150%恢复后窗口，风险文字、四项控件及按钮可见；未用jsdom推断布局。真实模型另有独立截图，不能把fixture的全排列覆盖写成真实模型全排列。

配置宽度为720/900/1200/1280/1440/1920；125%窗口实际CSS宽度为722/902/1202/1282/1442/1922，150%与配置一致，不能声称两个缩放的客户区都精确等于配置值。最终Source/Packaged各28图，逐图尺寸及摘要见`.probe/p33-d6-final4-gui-summary.json`；另人工查看最终Packaged125%的C/R/D导出界面。

## 9. 持久事务、异常与恢复

现有顺序：可信证据/逆合并→私有C/R落盘、读回/身份/配额→Native Ready→再次Authority/revision→持久replacing intent→绑定commit→Win32写/EOF/Flush与后验→持久applied_verified。任何不确定状态不通过C/R字节相等猜测成功。

Store/Service/Reader/faults回归涵盖材料损坏、额度不足、append失败、部分尾行、intent后进程/协议失败、EOF/Flush/Write访问失败注入、结果丢失、旧attempt、二次恢复失败、workspace失效。C/R和已验证各代D被pin，损坏Journal正常打开拒绝，Reader只验证完整合法前缀，不修复日志或赋予apply资格；读不到具体材料则拒绝导出。

Native故障证据区分访问权API注入、进程/协议注入、真实部分目标字节和Mock；本轮GUI/packed的两次故障发生于真实Native verified回复之后，不能说它们复现了部分写入崩溃。自然断电、自然ENOSPC/EIO、真实OS重启未验证。应用逻辑预留不是系统硬配额，fsync/读回也不是断电全保证。

没有自动重试/回滚或覆盖未知D。新恢复必须重新观察当前对象、持久当前D、验证来源C、创建新plan/token/requestId及四项新确认；二次失败保留代际，不循环恢复、不长期锁住全应用。

## 10. 本轮测试与构建账本

最终日常冻结清单 `.probe/p33-d6-frozen-source.json`，HEAD为D5基线，416项输入；前两轮414项清单及第三轮清单另行保留。私有Electron真实模型runner的字节摘要单独记录，不当作正式生产代码。所有结果以本轮原始日志/退出码为准：

| 项 | 本轮状态 | 证据 |
|---|---|---|
| D6资格专项 | 最终链结束后再次17/17、失败0、skip0，退出0，13.3954809秒；真实只读观察+合成capture/metadata DI | p33-d6-final4-qualification.log/.exit/.seconds |
| 严格特权SACL | 0/0、skip8、退出2，权限阻塞 | p33-d6-strict-audit.* |
| 最终npm test | 退出0，2794.1584028秒；124条命令，旧123条完整保留；P33共34套、972/972实执行通过，另18项跳过 | p33-d6-final4-test.*、p33-d6-final4-summary.json |
| Source独立GUI | 122/122、失败0、skip0、退出0，700.105995秒；fixture模型 | p33-d6-final3-source-gui.* |
| 实际SEA/APP backend专项 | 11/11、失败0、skip0、退出0，665.656348秒 | p33-d6-final3-packed.log/.exit/.seconds |
| 正式APP构建/检查 | 构建退出0，14.6481318秒；检查26/26，退出0，12.6500262秒 | p33-d6-final4-build-app.*、p33-d6-final4-test-app.* |
| 正式SEA独立构建 | 退出0，10.8046528秒 | p33-d6-final4-build-exe.* |
| 正式SEA检查 | 49/49，退出0，11.3804537秒 | p33-d6-final4-test-exe.* |
| Packaged独立GUI | 122/122、失败0、skip0、退出0，673.6985739秒；fixture模型 | p33-d6-final4-packaged-gui-rerun.*；本轮固定resources/app来源 |
| 外部真实模型 | 总8次：Classic退出1并经独立只读后验；Managed37/37、退出0；不记双模式整套通过 | p33-d6-real-model.*、p33-d6-real-model-managed.*、classic-postcheck.json、model-source-hashes.json |

packed新增断言先对旧实际测试EXE验证RED：缺少recovery字段，不是生产功能失败；旧日志保留为 `.probe/p33-d6-sea-recovery-red.log/.exit`，缺口源码快照 `p33-d6-sea-gap-before.json`。随后仅补测试编排，没有修改Helper或删旧安全断言。

第一次完整链在Planner报告123 passed/1 failed并退出1，耗时302.2705033秒，原日志 `p33-d6-final-test.*` 保留。§34误用process.env探测，实际启动本机CLI后在参数解析处报unknown option --permission-prompts；未进入模型任务。修正后独立Planner124/124、退出0，`p33-d6-planner-fixed.*`，原断言总数不变。第二轮退出0，但执行期间加入Pi捕获修复，故仅作中间回归，不作为最终冻结链。

第三轮 `p33-d6-final3-test.*` 在Object service回环fetch处退出1，935.4048168秒；该次未保留底层cause，不能唯一确认原因。独立探测实证本机动态端口1024～15000可分配6000，Fetch在请求到服务之前报bad port，同端口node:http收到精确403。只调整该测试的HTTP客户端，四个状态及四个响应体断言均保留；聚焦Object service30/30、失败0、skip0、退出0，283.5560295秒。最终第四轮另行冻结并完整执行，不用聚焦结果代替它。

最终第四轮的416项输入在结束后逐项SHA-256复核无漂移。P33的972分母不含18个权限跳过：旧SACL8、原位SACL2、Object witness8；普通npm链退出0不等于独立严格witness的退出2已消除。新资格17和bridge新增11项解释了P33相较D5的944项增加到972项，没有删除旧断言。其他非P33套件也随同124条唯一canonical链实际执行至退出0，不虚构全仓统一断言总数。

本轮构建摘要为 `.probe/p33-d6-final4-build-hashes.json`，4个public文件及2个Helper与正式APP逐字节一致，APP与独立SEA的server.cjs一致。packed专项使用`node scripts/build-app.mjs --rebuild --output-root <freshTEMP>`；最终APP另外重建，独立SEA实际执行`npm run build:exe -- --output-root <另一freshTEMP>`。包检查前在自己的TEMP设置TEMP/TMP/TMPDIR并执行`npm run fixtures`；检查为`npm run test:app -- --output-root <本轮APP根>`、`npm run test:exe -- --output-root <本轮独立SEA根>`。

上述packed专项的精确入口是`node tests/session-revert-object-packaged.cjs`。最终另外执行`npm run build:app -- --rebuild --output-root <freshTEMP>`，最终GUI入口为`node .probe/p33-d6-final-run-gui.cjs [resources/app]`；完整逐条argv、环境、时间、退出码和证据层级以`.probe/p33-d6-final4-command-ledger.json`为准。通用阶段日志不提供的子构建独立耗时保持未记录，不推算。

保留两次打包GUI未通过记录：中间快照在启动时ENOENT，未发生Native；最终APP初次窗口测试在fixture等待agent_settled处超时，退出1、44.9504325秒，未取得捕获验收。原20秒等待断言未放宽，后续在减少并行窗口负载后单独重跑；初次未记录足够证据证明超时根因，不能断言一定是机器负载。

| 本轮产物 | SHA-256 |
|---|---|
| APP/SEA server.cjs | `e96c3f9aac7c6fe27e15a50872748c1f17ca2d381b20647e6c5836b35226c05a` |
| 正式Electron宿主 | `3ad6e2a8f56f02931f116d707d2ed5f4bdddcafc4f4d5a2afb8bc0d509467925` |
| packed专项正式SEA | `bb235eb2475c65ec3ea6bc73d2ccdd9fa87eff3ec57da72c2d1c30de5be0de6b` |
| TEST-ONLY SEA | `58a69767606d2ff0f04e658b3ff6816cf74f658eeba94617374ed8ffffdae294` |
| 另行独立正式SEA | `297412b4f5395bf814ffff64b854790dd7ed14836a7c5dfa0745af06ac8f3d4b` |

两个独立构建的正式SEA包摘要不同，本轮不主张逐字节可重现构建，也不把其中一个包的检查伪装成另一个包；实际Native专项对应bb235e…来源，49/49检查对应297412…实际EXE。两者server.cjs和内嵌资源同源；这不等于正式B已可执行。默认历史build/dist产物没有替换。

## 11. 最终阶段验收矩阵

| Requirement | Evidence | Verified Environment | Result | Residual Risk | Production Eligible |
|---|---|---|---|---|---|
| 固定关闭/测试隔离 | qualification17/17、formal process boundary | 当前源码、实际APP backend/SEA | 固定拒绝已验证 | 同用户恶意进程不属应用沙箱保证 | 否 |
| 同平台普通/特权保持 | 旧26100八组；当前26200普通 | 两个平台，非配对 | UNQUALIFIED | 无UBR/proof完整绑定、特殊SACL不可观察 | 否 |
| 当前版本Pi捕获 | 精确版本/API门槛回归；实际SDK/RPC和两种真实模型捕获 | 当前可信Pi1.2、独立TEMP | 捕获路径已验证，生产B仍UNQUALIFIED | 不是全部Pi API/正式guardian资格 | 否 |
| Classic/Managed真实模型GUI链 | Classic31项后退出1+独立后验；Managed37/37 | Source Electron测试main，真实Worktree/模型，guardian DI | 双模式完整门槛未全部通过 | Classic收尾/Git初始证据不足，非正式组合根 | 否 |
| Source/Packaged GUI Native | 最终各122/122，56截图及实际磁盘核对 | 专用TEMP测试main/fixture模型 | 限定测试通过，生产UNQUALIFIED | 不是正式产品入口 | 否 |
| SEA新确认恢复 | 本轮actual TEST-ONLY EXE，专项11/11 | 当前26200、内嵌Helper | 限定测试通过，生产UNQUALIFIED | 同进程材料重开≠实际重启 | 否 |
| 持久intent与材料pin | Store38/38、Service30/30、Reader51/51、faults45/45等 | TEMP、真实Win32及DI分列 | 对应限定测试通过 | 自然断电/EIO未验证 | 否 |
| A/Git/旧v2/只读GUI/P32 | 完整canonical退出0及包检查 | 本机与fixture | 回归通过 | 不提供B资格 | 否 |

## 12. Q1/Q2/Q3逐项建议

| 风险 | 实现保证、证据及最坏情形 | 缓解措施 | 审批建议 |
|---|---|---|---|
| Q1 原对象主流非原子写 | 先C/R与intent、后读回/持久结果；API/进程故障可留下部分正文，工程可能暂不可用 | 单文件≤2MiB、UTF-8、对象锁/校验、材料pin及新确认恢复 | 可以考虑批准这种限定契约，但必须单独明确接受部分覆盖；不等于批准当前生产开放 |
| Q2 普通权限不可完整观察SACL | 已有同Native26100八组保持样本；本机26200无特权配对、补丁/Proof不完整；隐藏特殊SACL/并发安全描述符无法逐文件排除 | 同平台矩阵、可观察metadata比对、不重建ACL、不提升unknown、严格限定ACL形状 | 证据不足，当前不建议批准生产Q2 |
| Q3 外部竞争及未捕获D丢失 | 已知writer Stop/drain；C/R只保存实际采到的正文，最后检查后外部D可能永久丢失，材料不能恢复未保存缓冲/完整metadata | 提示暂停外部writer、短TTL、重复身份/内容校验、失败关闭；这些不是全局排他保证 | 不能按“保留全部修改”批准；只有明确接受未捕获D可能永久丢失时才可另行审议 |

上述仅为建议，Codex无权代替用户批准。C/R/D正文备份不包括完整SACL/ADS/EA/Owner/Group/DACL/属性历史，且备份自身损坏时可能无法恢复。

本轮测试窗口中的四项勾选仅确认harness新建TEMP事务，不能解释为用户批准生产Q1/Q2/Q3。后续人工审批须分别确认：是否接受主流部分覆盖；是否接受指定Proof下普通权限SACL不可逐文件观察；是否接受提交窗口内未捕获D可能永久丢失。当前Q2证据不足，三项均没有取得生产批准。

## 13. 决策、最小后续任务与停止点

当前建议 **NO-GO，保持B关闭**，没有可提交开放的生产子集，allowlist草案仍为空。没有证据要求立即废弃B全部研究，但不继续用更多Mock数量规避以下门槛：

1. 在一个指定OS build/UBR、x64本地固定NTFS上，取得同当前加载链/Helper/API/mask/protocol的普通与特权完整对照，形成可追溯Proof及ACL/属性范围；未测试环境不纳入。
2. 保留已取得的Pi1.2真实捕获和Managed37/37；为Classic修正后的收尾断言取得完整一次通过及初始Git快照、固定安全错误定位，处理私有Managed首次hello绑定竞态。原8次授权预算已用完，不自动追加模型请求；后续复测须有新的次数授权。不能用后验或fixture stream替代整套通过。
3. 证明限定TEMP执行与正式装配足够一致，补实际SEA进程重启后的历史材料只读/新owner写拒绝、以及对应产品生命周期GUI门槛；不得通过正式开关或任意root接口补测试。
4. 逐条审批Q1/Q2/Q3，并界定未支持的ACE/metadata形状；上述证据即使完成，也仍要单独批准生产开放，不能自动修改allowlist。

若用户坚持整文件原子、每次完整SACL验证或保证保留全部后来D，则建议 **STOP-B，采用C路线**：保留P33.5a预览、已授权且经验证的材料导出、A已合格功能与既有Git能力。没有材料时不能承诺可导出，也不能把C路线说成自动撤销。

当前正式Object transport的exportMaterial也固定拒绝，Recovery Reader未作为普通产品材料HTTP入口注册。因此上句“已验证材料导出”指独立授权Reader/隔离编排能力，不能说v0.24.0或当前正式GUI已经具备B材料下载。若选C产品路线，仍需独立审议最小只读导出入口和历史scope授权，不顺带授予写回权限。

D6本轮验证完成后停止等待人工验收；当前不具备申请P33.5b生产开放的条件。正式B Writer、HTTP、renderer传输与GUI写回继续关闭，Q1/Q2/Q3未获批准。

## 14. 后续推送授权记录

用户在验收报告交付后明确要求“推送”。按回滚边界新增：`a6d2205`为Pi1.2捕获兼容及版本门槛回归，`0846a74`为D6验证工具、真实模型fixture及测试环境修复；本文另行提交。此前记录的开发前后HEAD指技术验收冻结时点，不是后续交付提交。

提交前再次核对416项受测输入无漂移，复用同字节最终测试及构建证据，没有将提交动作写成重新执行测试。此次仅交付main上的代码、测试和报告；不改变NO-GO、不批准Q1/Q2/Q3、不开放B、不发版、不移动v0.24.0 tag。私有日志、TEMP材料、截图和已有未跟踪发布目录不纳入提交。
