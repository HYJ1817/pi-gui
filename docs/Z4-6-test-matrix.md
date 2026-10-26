# Z4-6 真实使用验证矩阵

基线：`d919fc90a59d8d83aebabfd6bddbc727f9e4ee90`；单 Agent，A→F 顺序执行，零模型费用、TEMP fixture 写入。本文件先于大规模测试建立；实际数字及结论以 [验收报告](Z4-6A-acceptance.md) 为准。

## 证据层及范围

| 层 | 证明范围 | 不能推出 |
| --- | --- | --- |
| 单元/集成 | schema、状态机、真实 TEMP 存储、jsdom 生命周期 | 原生窗口、真实 Pi、模型质量 |
| fake Pi RPC | 生产桥接/注册表与确定事件、停止和隔离 | 上游版本兼容、真实推理 |
| 真实 Pi RPC | 本机安装包、真实进程、无推理命令和恢复 | 模型生成/运行中取消 |
| 真实模型 | 人工明确授权后的建议生成/拒绝/接受 | 其他模式或产物资格 |
| Electron | 正常 sandbox 的实际 Chromium 窗口/交互 | 打包 App 或安装升级 |
| 产物 | 新建 Worktree 独立离线构建、App/SEA 资源及后端 | 打包窗口、安装升级 |

## A：链路、状态归属、既有覆盖

| 用户步骤 | 服务端与前端归属 | Classic / Runtime 差异 | 优先复用的测试 | 风险与补验 |
| --- | --- | --- | --- | --- |
| 打开项目/会话 | server.js、runtime.js、runtime-registry.js、session-runtime.js | Classic 单 bridge/cwd/workspaceGeneration；Runtime 独立 supervisor/bridge/完整 owner | sessions、runtime-registry、session-runtime、runtime-resource-cleanup | 焦点、代次与物理进程身份分开核对 |
| 打开协同面板 | collab-panel context、collab-authority、review-comment-authority | 无 conversation 头走 Classic；有头须为已验证焦点 Runtime | collab-authority、collab-panel、collab-http | await 前后完整身份一致、旧 open 应答关闭 editor |
| 创建文档 | collab-service create → collab-store write | 按完整 scope 派生 key/token/sessionId；两条链共用存储能力 | collab-service/store/http | protectedRoots、锁/路径身份、不可选择文件路径 |
| 用户编辑/自动保存 | canvas 发 intent，panel 补 user/opId/revision → service → lib/collab-doc → store CAS | 同一 schema 与事务，命名空间隔离 | collab-doc、advanced-editing、z45-regressions | >50 整批拒绝；保存未确认不可盲重试 |
| Agent 生成 | service 在锁内制 pending，routes 锁外 dispatch，proposal-source 武装并确认通道 | Classic request prompt 需 disposition=started；Runtime registry.command 复用 admission/stop | proposal-source、agent-flow、panel-agent、stop-barrier | 锁序自锁、快速事件缓冲、dispatch 前后 owner 更换 |
| 事件采集 | rpc-bridge → server.js tap；Runtime session-runtime → registry 帧 → tap | Classic bridgeRun；Runtime 完整 identity + frame owner | proposal-source、runtime-events | agent_settled 上游事实需本机核查；异常退出及迟到事件 fail closed |
| 预览 | queue head/get → service preview → proposal UI | key/token/revision 绑定，不改磁盘 | agent-flow、panel-agent、collab-canvas | 不信任 HTTP 自述来源，不接受模型自带 actor/opId |
| 接受/拒绝 | service terminal matrix、lib accept/reject、store CAS、queue settle | 相同事务路径；不跨 Owner 复用 proposalId | agent-flow、proposal-queue、http | rejected 不可 accept；superseded/expired 不可解析 |
| 撤销/重做 | service editor 内存 history；clone 后写盘成功才发布 | editorId/key/token/revision 绑定；重启保留文档但不保留历史 | collab-doc/service/advanced-editing | 原子批次一撤销；重开后历史为空属现有契约 |
| 自动布局/导出/复制 | productivity/layout-preview/export/selection/canvas | 都在捕获的当前文档能力下；导出不走写盘事务 | auto-layout、layout-preview、export、productivity、panel-productivity | SVG 文本转义、PNG 异步失效、Blob URL/定时器释放 |
| 切换/关闭/恢复 | panel 同步 invalidation/dispose；authority assertCurrent；store 持久化 | Classic generation / Runtime owner 任一变化使旧能力不可用 | panel-agent、panel-productivity、authority、runtime-resource-cleanup | 保存/生成期间切换；服务重启队列为空；损坏与残留锁保留原字节 |

已读：任务指定实现文件、server.js 装配、Z4-3/Z4-4B/Z4-5 验收材料及 testing/acceptance/coding-style。Z4-3末尾§14.4已补Runtime生成正常窗口E2E；前文§6的缺口描述已过时。历史Z4-3曾以私有同版本Electron通过，Z4-4B/Z4-5默认路径启动失败，均不能转作当前证明。真实模型链路仍有缺口。

## B→F 执行范围（先复用，再补缺口）

| 阶段 | 有界执行 | 判定/清理 |
| --- | --- | --- |
| B Electron | 默认最小启动与三个既有专项；必要时仅一个同版本同摘要离线副本对照 | 不加 no-sandbox、不改系统设置；输出实际 exit、进程创建身份和残留 |
| C1 Pi | 读取本机版本/官方包 docs+dist；TEMP HOME/agent/session，no extension/skill/prompt/theme；get_state/abort/clear_queue/new_session；真实桥接重启 | 不发可调用模型的 prompt；事件顺序/运行中取消没有观测就保留未验证 |
| C2 模型 | 本报告的人工 smoke 清单 | 无已授权免费环境则不运行；fake 不充当真实 E2E |
| C3 双通道 | 既有 source/flow + runtime/stop + TEMP 真实 Pi 控制面 | Classic 和 Runtime 分列；模块测试不冒充生产组合根真实模型 |
| D1/D2 | 复用错误/冲突/锁/损坏测试；补有上限的跨上下文应答、重启与生命周期检查 | 保存前后字节与 revision；所有延迟完成后检查当前文档 |
| D3 | 40 轮文档/建议/撤销重做；40 轮复制布局 SVG；40 轮面板创建销毁和导出资源计数 | 每个进程总超时；finally 回收 TEMP/窗口/句柄；RSS 仅短程观测 |
| E | 12 项安全边界逐一映射现有 doc/store/authority/flow/export/advanced 测试 | 只修已复现问题；核心协议缺陷先记录复现与方案 |
| F | collab + 受影响边界；CI 基线缺可信完整证明时补本地 baseline；最终 canonical 按任务留最终 PR CI | 记录失败分类、skip、命令集合；独立构建，不写 Z4-5 产物 |

## 真实模型人工 smoke（尚未执行）

仅在用户明确确认现有模型无需额外费用后，在 TEMP Git 项目及独立应用数据目录分别执行 Classic 与 Runtime：

1. 新建文档，核对初始三个节点，记录 revision/文档摘要。
2. 输入“增加一个判断分支和两条出边，只返回 pi-gui-collab 建议”，显式生成。
3. 核对 agent_start → assistant message_end → agent_settled，预览前后已存摘要相同。
4. 拒绝；磁盘文档不变，旧 proposalId 再接受须拒绝。
5. 重新生成并明确接受；只增加预览中的对象，revision 单次递增。
6. 保存并重新打开，核对节点/边与摘要；在同一 editor 中撤销/重做。重开 editor/重启不承诺恢复内存撤销历史。
7. 再生成时 Stop、切会话/项目、关闭面板；核对迟到事件不能污染新文档。
8. 记录 Pi/模型版本、Classic/Runtime owner 结构、结果及脱敏截图，退出后核对进程清理。

打包窗口另执行同清单；源码 Electron 或产物后端通过均不代替它。

## D/E：故障与安全边界映射

这些套件本轮随 `test:collab` 实际执行；不重复编写同一功能套件。无新证据的系统级断电、磁盘真实耗尽、长期运行不推断通过。

| 需求 | 验证入口与判据 | 证据局限 |
| --- | --- | --- |
| D1 项目A→B→A / Classic→Runtime→Classic | collab-electron 生产组合根、真实项目激活与Runtime焦点/恢复；检查存储字节与原源码 | Pi为fake；并非真实模型跨项目生成 |
| D1 生成/保存中关闭与切换 | panel-agent、panel、panel-productivity 异步应答/同步失效；source的dispatch身份竞态 | jsdom逻辑与注入延迟，不证明布局 |
| D2 Pi/RPC断开、迟到事件、生成失败/取消 | proposal-source、agent-flow、stop-barrier、真实Pi控制面重启 | 运行中真实模型取消未验证 |
| D2 HTTP不确定结果、冲突 | panel/agent/productivity失败后只读重开；HTTP与双store CAS | 注入错误和TEMP实际文件 |
| D2 服务重启、锁冲突、损坏 | agent-flow、store：新service/source无在途建议；flush后kill、锁残留拒写；非法UTF8/版本/journal保持原字节 | 不是断电/硬盘故障资格 |
| E1 未确认Agent不写文档 | agent-flow、panel-agent、正常窗口preview前后持久化摘要不变 | 明确接受才走CAS |
| E2 被拒绝建议不可再接受 | agent-flow terminal matrix；40轮稳定性实际拒绝后再accept抛错 | 后端守卫，不依赖按钮隐藏 |
| E3 旧proposalId不可用于新Owner | source/queue/authority/agent-flow的key/token、scope、generation隔离 | 权威身份由现有authority保持 |
| E4 旧revision不得覆盖新revision | store双实例/双进程CAS、http、正常窗口外部推进revision冲突 | 实际文件字节核对 |
| E5 Client不可伪造来源 | HTTP额外键/自带proposal/Agent字段拒绝、source只采终值assistant围栏 | 不信任模型自述身份 |
| E6 不可跨项目重放 | authority完整Owner、agent-flow双scope、真实窗口项目切换 | 本轮未改身份协议 |
| E7 不写非授权文件 | store路径/符号链接/目录替换/protectedRoots，窗口检查源文件字节不变 | Windows无symlink权限的一项skip单列 |
| E8 损坏fail closed | store/http损坏版本/UTF8/journal及锁冲突，拒绝保存并保留原件 | 未自动清理残留锁 |
| E9 复制粘贴不执行代码 | advanced-editing/canvas文本投影、应用内结构化剪贴板；40轮canvas复制/粘贴 | 不读取系统富文本剪贴板 |
| E10 导出不执行HTML/JS | export的XML转义、闭集标签、外部资源禁入；真实Chromium默认PNG renderer | 无模型生成任意HTML入口 |
| E11 >50不拆分保存 | doc/advanced-editing/productivity/layout-preview超限整批拒绝，零提交 | 性能夹具为造既有大图显式分批，不是生产自动拆分 |
| E12 多选边界完整一致 | z45-regressions真实完整鼠标事件、相对位移夹紧；advanced-editing批量历史/容量 | 高级专项6项不能替代全部jsdom逻辑断言 |
