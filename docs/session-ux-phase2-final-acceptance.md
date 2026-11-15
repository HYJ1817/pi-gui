# 会话过程 UI/UX P2 最终验收

验收日期为 2026-11-16（Asia/Shanghai）。目标分支为 `feat/session-ux-phase-2`，整改基线为 `97b4139db87f3dd313304d8b43ef06911eb0a3a0`，实现与测试为 `2ba149d25b5ac3e0ddfded47679fc776ba258cc7`。本轮范围为 Classic 阅读书签、锚点、工具展开和 P2 测试。

整改、定向测试、Chromium 几何和离线打包已完成。按用户后续指示停止全量测试并推送分支，全量验收结论为未完成。

## 根因与修复前后行为

| 问题 | 整改前 | 整改后 |
| --- | --- | --- |
| 书签被覆盖 | 切换和重建都调用含隐式保存的 `clearThread()`，可把空线程或旧线程位置记给新会话。 | 切换按已渲染线程的原生 `sessionId` 保存。清空只重置线程，重建仅在同一会话且有内容时保存现位置。空线程及过期滚动回调跳过保存。 |
| 历史与状态响应乱序 | `get_messages` 直接读当时的状态。普通切换、新建和 fork 可能读到旧身份。 | 使用同一次读取的 RPC 请求 ID 配对消息和状态，按确切会话归属恢复。旧请求按读取批次、工作区及 Bridge 运行身份判定。取消的新建或 fork 保留线程。 |
| 搜索定位被覆盖 | 历史完成回调可被切换确认前的旧历史消费，旧线程排队的贴底操作也可覆盖位置。 | 搜索定位由确认切换后目标会话的历史回调消费。回调在导航重建后执行。搜索定位优先于书签，书签优先于默认贴底。 |
| 实时锚点缺失或重复 | 历史和实时消息各自从零计数，实时工具组和 Plan 卡在部分路径缺锚点。 | 用户消息、助手消息和轮次终态复用历史重建推进的计数。工具组按助手声明的首个普通工具调用标识，Plan 取首个有效计划调用。同一 `turnId` 的 steer 更新原 Plan 锚点。 |
| 阅读几何偏差 | 截图漏传内容容器，只证明 `scrollTop` 回填。修正夹具后复现消息入场位移导致 1.65–2.00px 误差。 | 按直属内容节点的锚点及静止布局偏移恢复，锚点缺失时回退到数值 `scrollTop`。入场动效保持原样。 |
| 工具展开选择丢失 | Classic 展开状态只存在当时的 DOM。 | 显式展开与收起按原生会话 ID 及组、工具标识隔离。内存最多 100 个会话、每会话 500 条选择。删除会话时清理，超过容量时按最近使用顺序淘汰。 |

## 修改文件

| 文件 | 内容 |
| --- | --- |
| `public/messages.js`、`public/reading-position.js` | 保存、清空、重建生命周期，线程归属、共享消息计数、锚点几何与滚动回调 |
| `public/rpc.js`、`public/sessions.js` | 关联状态与历史 RPC，普通切换、新建、fork、搜索定位及删除清理 |
| `public/app.js`、`public/planner.js`、`public/projects.js` | 延续和 Planner 入口传递原会话，切项目时显式保存阅读位置 |
| `public/tools.js`、`public/tool-view.js` | Classic 工具组锚点及组、详情的展开恢复。Runtime 继续使用原有按会话展开逻辑。 |
| `public/plan-live.js`、`public/plan-model.js` | 实时与历史 Plan 统一锚点及 steer 归并 |
| `tests/session-ux-phase2.cjs`、`tests/session-ux-phase2-shots.cjs` | 修复空转断言，增加端到端切换夹具、锚点、展开选择和实际 Chromium 几何 |
| `tests/review-regressions.cjs`、`tests/smoke.cjs` | 对齐 Runtime 容器滚动断言及 Classic 带请求 ID 的历史回包，保留原断言数量 |

## 行为与几何验证

- Classic 夹具经过普通切换入口、`afterSessionSwitch()`、实际清空和 RPC 历史重建。A → B → A → B 采用两种响应顺序并注入过期历史。A、B 的阅读位置和展开选择分别恢复。新建的空历史及后续滚动事件保持书签为空，fork 和被取消的 fork 分别覆盖成功与取消路径。
- 历史后追加实时用户、助手、工具组、Plan 与轮次终态。锚点集合大小等于元素数。历史插入未实际执行的工具组后，后续组仍命中原锚点。实时 steer 的两次 Plan 调用重建后保留一张卡与第一次调用的锚点。
- Chrome 157.0.8103.78，截图实际为 1298×666 和 700×600，实测 **13/13**。A（`user-7`）、B（`user-9`）、实时工具组（`tools-live-tools`）和实时 Plan（`plan-live-plan`）均通过实际 `#stream` 与 `.thread` 捕获，重建前后相对偏移误差为 **0px**。四次恢复的 `scrollTop` 均移动 **119px**，可区分锚点恢复和旧数值回填。
- 工具组、工具详情及 Plan 折叠位移为 **0px**，视口上方折叠后的可见目标位移为 **0.19px**。Runtime 搜索只滚动输出容器，居中误差及三个祖先滚动量均为 **0px**。
- 证据含 [13 项测量及原始坐标](ui/session-ux-phase2-final-evidence/report.json)、[Classic A 深色](ui/session-ux-phase2-final-evidence/01-classic-reading-position-restored-dark.png)、[实时工具组](ui/session-ux-phase2-final-evidence/live-tools-anchor-restored-dark.png)、[实时 Plan](ui/session-ux-phase2-final-evidence/live-plan-anchor-restored-dark.png)、[700px 浅色](ui/session-ux-phase2-final-evidence/10-narrow-700-classic-light.png)等 12 张 PNG。

## 测试与构建

环境为 Windows x64、Node 24.22.1、npm 11.19.1。基线分支与远端一致，准确 SHA 查询未返回 CI 运行。基线 `npm run test` 在 `review-regressions` 停止（30/32），两条失败均为旧 `scrollIntoView` 桩与 P2 容器内定位契约不一致。整改后该套件 32/32。新增的 Classic 行为断言在修复前复现书签覆盖、展开丢失和实时锚点缺失。Smoke 的旧静态检查将 `findScrollContainer` 的 DOM 形参误识别为全局 `el`，形参改名后原断言通过。

| 命令 | 结果 |
| --- | --- |
| `npm run test` 第一轮 | 按用户指示在 `test:review-comments` 阶段中止。最后一条完整套件结果为 `Review comment authority: 15/15`。 |
| `npm run test` 第二轮 | 排队任务按用户指示取消，命令尚未启动。 |
| `node tests/session-ux-phase2.cjs` | 96/96 |
| `node tests/review-regressions.cjs` | 32/32 |
| `node tests/smoke.cjs` | 1345/1345 |
| `node tests/thinking-dots.cjs` | 90/90 |
| `node tests/ui2-classic.cjs` | 55/55 |
| `node tests/runtime-conversation.cjs` | 106/106 |
| `node tests/agent-execution-ui.cjs` | 221/221 |
| `node tests/modules.cjs` | 121/121 |
| `node tests/model-capabilities.cjs` | 36/36 |
| `node tests/session-ux-phase2-shots.cjs` | 13/13，12 张截图 |
| `node scripts/run-test-group.mjs --validate` | 259 条 canonical 命令，五组 |
| `npm run build:app -- --rebuild --output-root <临时目录>` | 使用本机 Electron 44.4.3 缓存离线打包，退出 0。11 个修改的前端资源与打包副本 SHA-256 全部一致。 |

## 冻结证明与残余风险

`git diff --exit-code 97b4139 -- public/thinking-dots.js public/thinking-dots.css public/scroll-button.js` 退出 0。冻结文件对应的基线与验收 Git blob 哈希一致。

| 冻结路径 | Git blob |
| --- | --- |
| `public/thinking-dots.js` | `02aa11c32e4d4720dafda8730d9d3440131bc998` |
| `public/thinking-dots.css` | `b9862cf93d3b71c38d040a10712e3264487636fa` |
| `public/scroll-button.js` | `5329ea74dc76da928a7aecd8de6d5a59f3703a4c` |

独立复审覆盖历史工具组插入、steer、工作区迟到失败、搜索确认前旧历史和 Chromium 入场位移。整改后的相关路径均有定向验证。Runtime 时间线生产文件、并行会话执行机制、依赖清单和工具数据契约沿用基线。

书签和展开选择保留在当前渲染进程，刷新、重启或容量淘汰后回到默认行为。历史压缩及记录裁剪可能移除锚点，届时按旧数值回退。历史消息成功但状态请求失败或 3 秒内未返回时，仍显示历史，按默认位置降级。早期无 `turnId` 的 Plan 历史按用户消息归并。几何证据来自离线 Chrome 夹具，打包校验覆盖资源内容，已安装应用、其他平台、签名以及真实模型长会话未作为本轮验收项。

回滚时可在目标分支回退实现与测试提交 `2ba149d` 及验收材料提交，随后重建客户端产物。
