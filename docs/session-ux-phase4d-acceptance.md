# 会话执行体验 P4-D 验收记录

日期：2026-11-17。分支：`feat/session-ux-p4d-performance`，
基线 `origin/main` = `df102d1`（PR #94 合并提交）。
本记录冻结当次的代码、fixture、浏览器与测量范围；后续行为变化不沿用这里的结果。

- 已实现 Classic 长历史的分块构建与分块挂载：首屏不再同步重建完整时间线，
  过期批次可取消，阅读位置、Minimap、跳转、复制与打印仍基于完整 DOM。
- 已修复 Runtime 只读历史搜索命中被裁剪时的虚假定位：保留命中正常落位，
  裁剪外命中明确显示「无法定位」，不再把「历史已打开」当成「目标已定位」。
- 真实 Chromium 基准 5 轮（`after-final-clean`）：Classic 首屏同步段中位数
  141.9 → 26.4 ms，最慢任务 211 → 88 ms；长会话同步段 311.2 → 27.4 ms，
  最慢任务 447 → 163 ms。65 个首屏/切换样本中 0 个 ≥100 ms。
- 真实 Chromium 视觉验收 20/20，1320×820 / 700×600、深色 / 浅色共 8 张截图。
- 只运行相关定向测试，未运行完整 `npm test`；不自动合并、不发版。
  本记录不构成合并或发布授权。

## 1. 前置与范围

- 用户要求一次完成 P4-D 的基准、实际修复、Runtime 定位修复、回归测试与验收记录；
  从最新 main 建独立分支后提交、推送并创建 PR。
- 复用既有 Classic 渲染、`conversation-nav.js`、阅读书签、Runtime 历史投影与
  owner/revision/eventSequence 保护；不引入虚拟化、不扩大 Runtime 保留上限。
- 冻结 `public/thinking-dots.js`、`public/thinking-dots.css` 及其动画调用行为；
  未修改这两个文件，未新增依赖、网络行为或用户数据写盘路径。
- `git diff --check` 无输出；冻结文件无 diff。

## 2. 基准方法与夹具

基准脚本：`tests/session-ux-phase4d-perf.cjs`
（`npm run test:session-ux-phase4d:perf`）。真实 Chromium 157.0.8103.78，
headless，`--disable-gpu --no-sandbox`，同一浏览器 profile、同一场景顺序。
每个 after / baseline-recheck 均为 5 次独立浏览器运行；每项计时包含两次 rAF。
验收表使用 `after-final-clean`（最终代码、测量期间无并发主机命令）。

固定合成夹具（不启 Pi、不读用户会话、不写真实项目）：

| 夹具 | 消息 | 用户提问 | 说明 |
| --- | ---: | ---: | --- |
| A / B | 829 / 829 | 300 / 300 | 工具调用、Thinking、Plan、子代理、长工具输出 |
| Long | 1,653 | 600 | 更长会话与更多滚动锚点 |

夹具 A 的 Classic DOM：16,165 个元素；Long：32,229 个。Runtime 历史投影为
240 block（76 助手 / 75 用户 / 11 工具 / 75 Thinking / 3 Plan），`truncated=true`。

原始数据：`docs/ui/session-ux-phase4d-evidence/<label>/run-N.json` 与 `summary.json`。
本轮保留五组：

- `baseline/`：改动前记录（更早时间点，机器负载较低）。
- `baseline-recheck/`：同一工作树关闭分块阈值后，紧邻最终 after 复测的同步路径
  （17:40Z；最终 after 为 17:50Z）。
- `after-final-clean/`：最终代码的验收数据（无并发主机命令）。
- `after/`：复审修复后、实时守卫加入前的实现。
- `after-final/`：实时守卫完成后的最终代码复跑；测量期间有轻量主机命令并发，
  切换同步段出现一个 112 ms 样本。同代码无并发复跑（`after-final-clean`）最大
  同步段为 82.3 ms，因此验收采用后者；`after/` 与 `after-final/` 保留作方差参考。

同一台机器、同一脚本、相隔约两小时的 `baseline-recheck` 比 `baseline` 慢
15%–16%（首屏 274.8 / 236.4 ms，长会话 549.7 / 476.6 ms），说明冻结基线与本次
after 不在同一负载状态。下表同时给出两组对照，不把环境漂移包装成门槛通过。

## 3. 原始瓶颈

改动前，829 条消息的 Classic 重建中位 236.4 ms，单次最慢任务 211 ms；
1,653 条消息中位 476.6 ms、最长任务 447 ms。用户可交互之前存在完整的同步段：
`baseline-recheck` 的 65 个首屏/切换样本中，**65/65** 都 ≥100 ms
（首屏中位 172.8 ms、长会话 349.3 ms、切换 176.7 ms）。

CPU profile（`baseline/profile-run-1.json`）显示耗时不在 Markdown 解析：

| 热点 | self time |
| --- | ---: |
| `conversation-nav.js:buildFrom` | 99.2 ms |
| `getClientRects`（Minimap 读取全部 `.msg.user`） | 117.9 ms |
| `composer.js:reserve` | 52.3 ms |
| `clearThread` | 8.6 ms |
| 消息节点构建（`thinkingBlock` / `appendChild` 等） | 个位数 ms |

也就是说，主要成本是「完整历史挂进 DOM 后，Minimap 在同步收尾里读取全部提问
位置所触发的整棵线程布局/样式重算」，以及 Composer 高度预留。只优化 Markdown
或单个卡片不会解决首屏长任务；虚拟化也不是第一优先。

## 4. 实际修改

### 4.1 Classic 分块构建与挂载

`public/messages.js`：

- 800 条消息以下保持原来的同步路径，不改变既有小会话测试与首屏时序。
- 800 条起按顶层节点数分批：每批约 160 个节点，挂载后 `scheduler.yield()` /
  `setTimeout(0)` 让出主线程；批大小逐次翻倍到 1,024 封顶。
- 每批渲染完立即挂到 `.thread` 并保持贴底；用户在此期间主动滚轮/触摸/键盘时
  不再抢回滚动位置，最终位置交给 `finishHistoryRender` 的书签恢复/保留逻辑。
- `clearThread` 或下一次重建递增 `threadGeneration` 后，旧批次在下一个让出点
  退出，不会把旧会话内容写进新线程。
- 单条消息渲染抽成 `renderItem`，同步与分块两条路径共用同一份实现；Plan 锚点
  查重同时检查已挂载线程和当前未挂载批次，保持原来的唯一锚点语义。
- 分块挂载期间暂停滚动驱动的书签采集，避免半截历史覆盖用户原来的阅读位置。
- 挂载让出窗口内到达的实时写入（`onMessageStart`、`renderUser`、
  `createAssistant`、`showWorking`、`finalizeTurn`、读取失败/重试提示，
  以及 `tools.js` 的工具组与计划卡）先调用
  `finishClassicHistoryBeforeLive()`，由 `complete()` 同步补齐剩余历史并收尾，
  实时节点永远追加在完整历史之后。否则实时消息会插进历史中间，还会提前占用
  `user-55` 这类锚点序号，重建后书签会指到别的消息。计划卡直接 append 到
  thread、不经过 `ensureThread`，所以 `ensureThread` 与 `onToolStart` /
  `onToolEnd` 都显式调用这个守卫；同步补齐只在挂载窗口内真的来了实时事件时
  发生，正常浏览仍走分块。
- `clearThread` 同时清掉 `aria-busy`；`sessionId` 缺失的降级环境里，用户在
  挂载期间滚动后也保留位置，不再被收尾拉回底部。
- `public/conversation-nav.js` 的 `scrollToEntry()` 在跳转这一刻从目标元素重算
  位置，并按 `ui2-rise-in` 的动画进度扣掉入场动效的 3px 位移。分块挂载让
  「导航重建」更容易发生在最后一批动画尚未结束时；不补偿会让跳转在动画
  结束后稳定偏 3px。补偿只读跳转目标一个节点：若在 `layout()` 里逐条读
  `getComputedStyle`，830 条诊断夹具（415 个提问）在动画并发时会被拖到
  约 4.8 s（同一夹具的静止路径约 130 ms）。`layout()` 本身仍是原来的整表
  一次 rect 读取。功能测试把跳转容差从 ±4px 收紧到 ±2px。

### 4.2 Runtime 历史定位反馈

`public/runtime-conversation.js`、`public/runtime-timeline.js`：

- 助手正文 block 携带 `messageId`，历史行落 `data-history-message-id`；
  搜索命中助手消息时可按 `messageId` 真正定位，而不只依赖 `userIndex`。
- 新增独立状态行 `.rtc-history-locate`（`role="status"`），与读取/身份错误分开。
- 命中行存在：滚动到行、`historyMatchState="found"`、状态行清空。
- 命中不在当前投影且历史 `truncated`：显示
  「搜索命中位于已裁剪的只读历史之外，当前仅保留最近内容，无法定位。」，
  `historyMatchState="trimmed"`，**不滚动、不标记成功**。
- 命中不在当前投影且未截断：显示「当前只读历史中找不到这次搜索命中的内容
  （可能已被改写或删除）。」，`historyMatchState="missing"`。
- 不重读历史、不跨会话、不扩大 240 block / 1 MiB 保留上限；Runtime 的
  owner、revision、eventSequence 与历史视图切换保护未改。

## 5. 性能结果

### 5.1 与紧邻同步基线对比（同机、同脚本、同一负载状态）

| 指标（中位） | baseline-recheck | after-final-clean | 变化 |
| --- | ---: | ---: | ---: |
| 首屏 829 条 · 总就绪 | 274.8 ms | 231.5 ms | **−15.8%** |
| 首屏 829 条 · 同步段 | 172.8 ms | 26.4 ms | **−84.7%** |
| 首屏 829 条 · 最慢任务 | 254 ms | 88 ms | **−65.4%** |
| 首屏 1,653 条 · 总就绪 | 549.7 ms | 509.2 ms | −7.4% |
| 首屏 1,653 条 · 同步段 | 349.3 ms | 27.4 ms | **−92.2%** |
| 首屏 1,653 条 · 最慢任务 | 507 ms | 163 ms | **−67.9%** |
| A/B 切换 · 总就绪 | 288.1 ms | 231.9 ms | **−19.5%** |
| A/B 切换 · 同步段 | 176.7 ms | 26.3 ms | **−85.1%** |
| A/B 切换 · 最慢任务 | 253 ms | 87 ms | **−65.6%** |
| 快速连续切换 20 次 · 合计 | 3,579.2 ms | 780.0 ms | **−78.2%** |
| 快速连续切换 · 最慢任务 | 3,526 ms | 603 ms | **−82.9%** |
| 交互式快速切换 · 合计 | 5,493.8 ms | 5,043.7 ms | −8.2% |
| 交互式快速切换 · 最慢任务 | 363 ms | 121 ms | **−66.7%** |
| 书签恢复 | 264.7 ms | 257.2 ms | −2.8% |
| 书签偏移 | 0 px | 0 px | 不变 |

P95：首屏同步段 239.5 / 455.5 ms、切换 226.8 ms → 47.9 / 33.1 / 56.9 ms；
after 的 65 个首屏/切换样本中 **0/65** 达到 100 ms（最大 82.3 ms；
baseline-recheck 为 65/65）。最慢任务 P95 首屏 319 / 666 / 329 ms →
114 / 214 / 136 ms。

规划里的 30% 门槛按「首屏/切换中位数或最慢任务」判定：最慢任务
−65.4%～−67.9%、同步段 −84.7%～−92.2%，满足。**总就绪包含分块让出后的
rAF/入场动画尾部，只改善 7.4%～19.5%，不宣称它也达到 30%**；它没有回退到
基线水平，且相对同环境同步复测仍有改善。

### 5.2 与冻结原始基线对比

| 指标（中位） | baseline（更早） | after-final-clean | 变化 |
| --- | ---: | ---: | ---: |
| 首屏 829 条 · 总就绪 | 236.4 ms | 231.5 ms | −2.1% |
| 首屏 829 条 · 同步段 | 141.9 ms | 26.4 ms | **−81.4%** |
| 首屏 829 条 · 最慢任务 | 211 ms | 88 ms | **−58.3%** |
| 首屏 1,653 条 · 总就绪 | 476.6 ms | 509.2 ms | +6.8% |
| 首屏 1,653 条 · 同步段 | 311.2 ms | 27.4 ms | **−91.2%** |
| 首屏 1,653 条 · 最慢任务 | 447 ms | 163 ms | **−63.5%** |
| A/B 切换 · 总就绪 | 263.0 ms | 231.9 ms | −11.8% |
| A/B 切换 · 同步段 | 150.0 ms | 26.3 ms | **−82.5%** |
| A/B 切换 · 最慢任务 | 226 ms | 87 ms | **−61.5%** |
| 快速连续切换 20 次 · 合计 | 3,670.6 ms | 780.0 ms | **−78.8%** |
| 快速连续切换 · 最慢任务 | 3,655 ms | 603 ms | **−83.5%** |
| 书签恢复 | 300.2 ms | 257.2 ms | −14.3% |
| 书签偏移 | 1.7 px | ~0 px | 改善 |

对冻结基线，首屏总就绪 −2.1%、长会话 +6.8%，都在规划里「总就绪不比基线
恶化超过 10%」的候选门槛内。即便如此，这两个绝对值仍混有环境差异：同一
工作树关闭分块后的 `baseline-recheck` 在这台机器上已是 274.8 / 549.7 ms，
比冻结基线慢 16% / 15%；紧邻 A/B 对照见 5.1。原始数据五组都保留，便于复核。

### 5.3 关键非目标场景对照（无功能回退）

| 指标（中位） | baseline | after-final-clean | 说明 |
| --- | ---: | ---: | --- |
| 工具组展开 / 折叠 | 68.3 / 36.4 ms | 50.4 / 43.4 ms | 展开 −26.2%；折叠 +7.0 ms，复测 35.2 → 43.4，但 P95 76.1 → 66.0，同 DOM 路径，判为噪声 |
| Thinking 展开 / 折叠 | 42.4 / 35.2 ms | 33.8 / 34.0 ms | 无回退 |
| Runtime 历史加载 | 64.2 ms | 64.1 ms | 无回退（复测 62.0 → 64.1，+2.1 ms） |
| Runtime A/B 切换 | 81.6 ms | 65.2 ms | 无回退 |
| Runtime 保留命中定位 | 64.4 ms | 49.0 ms | 无回退 |
| Runtime 裁剪命中定位 | 65.2 ms | 49.2 ms | 无回退 |
| 搜索冷 / 热缓存 | 13.8 / 8.6 ms | 16.0 / 9.4 ms | 前端未改搜索路径；三组 after 为 12.7–16.4 / 8.5–9.4 ms，绝对差 +2.3 / +0.8 ms，判为运行间噪声并保留 |
| Classic 跳转到首/中/尾 | 1,567.2 ms* | 1,566.0 ms | −0.1% |

* 跳转中位由浏览器平滑滚动动画时长主导（个别样本 114.8 ms 为瞬时落位）；
  两轮同为 1.5 s 量级，分块没有改变跳转落点（±2 px 用例见第 7 节）。

Runtime 历史与搜索路径没有扩大读取范围或改变缓存策略；DOM 节点数保持
3,522（Runtime 历史）与 16,165 / 32,229（Classic），没有为性能删除内容。
表中工具组折叠与搜索冷缓存的绝对差值为 7.0 / 2.3 ms，方向与更早 after 或
P95 不一致，判为运行间噪声；没有功能回退，也没有为此调参掩盖。

## 6. 未实施或被测量否决的方案

| 方案 | 结论 |
| --- | --- |
| 列表虚拟化 / 窗口化 | 未实施。完整 DOM 是复制、打印、浏览器查找、Minimap 与书签锚点的既有契约；本轮瓶颈在同步布局而非节点驻留，分块已把最慢任务中位数压到 163 ms。强行窗口化需要重建完整的选择/打印/定位语义，超出安全范围。 |
| `content-visibility:auto` | 未启用。Minimap 需要全部 `.msg.user` 的真实位置，离屏内在高度估算会直接破坏 300 个锚点与书签偏移；打印与浏览器查找也要求内容完整。基线 profile 也显示布局发生在 Minimap 收尾，而不是离屏消息的 paint。 |
| 整棵线程 `contain:layout style` | 实测回退：首屏 309.7 → 367.2 ms，长会话 531.8 → 749.1 ms，未采用。 |
| `MessageChannel` / `postTask` 让出 | 实测比 `scheduler.yield()` 慢（首屏 445 / 342 ms，长会话 1,349 / 772 ms），弃用。 |
| 尾块优先、从后向前插入 | 功能正确，但总就绪更差（首屏 380 ms、长会话 961 ms），弃用，改为正向分块。 |
| 更小批次（512 节点封顶） | 实测总就绪更差（首屏 321.3 ms、长会话 756.2 ms），虽然最慢任务更低；最终保留 1,024 封顶。 |
| 延迟重建 Minimap | 未采用。`afterHistoryRendered`、搜索跳转与书签恢复都依赖导航在完成信号前就绪；把布局挪到 idle 只会把同一段成本移到用户点击之后。 |

## 7. 回归与功能验证

`tests/session-ux-phase4d.cjs`（真实 Chromium，13/13）覆盖：

- 829 条消息分块首屏：首批可见时 DOM 未完整，结束后 300 用户 / 300 助手 /
  工具组 / 工具行 / 12 张 Plan / 300 Thinking / 子代理 / 轮次终态 / 300 个
  Minimap 条目齐全，正文顺序与锚点 ID 正确，最终贴底，不混入 B 会话。
- 阅读位置在分块重建后恢复，布局偏移 0 px（扣掉 3 px 入场动效）。
- Minimap 跳转挑一个**仍在播放入场动效**的提问，落到真实位置且偏移 ≤2 px；
  当前项唯一，`.stage` 不滚动。不补偿时会稳定偏 3 px。
- Thinking 与工具详情在分块后仍可展开/收起。
- 全选文本包含首尾消息、最后回答与 Plan 卡；折叠内容仍在 DOM。
- 分块期间用户滚动后不被贴底或旧书签覆盖；`sessionId` 为 `null` 的降级
  路径同样保持位置。
- A 开始后立刻切 B：旧批次不写入 B，B 完整且无 A 文本。
- 连续 8 次快速 A/B 切换后最终会话完整、DOM 节点与完整渲染相差 ≤2%。
- Classic 重建不触碰独立 Runtime 输出节点。
- 1,643 条消息的 Long 会话同样完整、顺序正确、贴底。
- 挂载让出窗口内调用真实入口 `onMessageStart` 插入用户/助手消息：实时节点
  排在 300 条历史之后，用户序号 301 的锚点为 `user-301`，视口仍贴底；
  同一窗口内 `onToolStart` 的工具组与 `gui_plan` 计划卡也都落在完整历史之后。
- 取消挂载后 `clearThread` 立即清掉 `aria-busy`，线程为空。
- 打印媒体下完整历史仍在 DOM，`printToPDF` 管线成功产出 >50 KB PDF。

定向回归（逐项 `node tests/<套件>.cjs`）：

| 套件 | 结果 |
| --- | ---: |
| `session-ux-phase4d` | 13/13 |
| `session-ux-phase4d-shots` | 20/20 |
| `runtime-conversation` | 110/110 |
| `session-ux-phase3` | 128/128 |
| `session-ux-phase4a` | 110/110 |
| `session-ux-phase4b` | 108/108 |
| `session-ux-phase4e` | 60/60 |
| `ui2-classic` | 55/55 |
| `agent-execution-ui` | 221/221 |
| `runtime-history-search` | 37/37 |
| `history-tool-summary` | 38/38 cases；168/168 assertions |
| `ui2-runtime-display` | 83/83 |
| `high-risk-regressions` | 28/28 |
| `session-search` | 72/72 |
| `ui-visual-finish-electron` | 28/32（见下） |

`ui-visual-finish-electron` 在真实 Electron 下运行：本次改动相关的长列表
（1,000 条消息）完整挂载、Minimap 跳转、500 个 marker、700/900/1536px 无溢出
与「无 renderer/harness 错误」均通过；4 项失败集中在未改动的 UI3 模型 /
Thinking 选择态（`.ui3-think-item.on` 未命中、选择背景色断言），未归因于 P4-D，
在此记录不隐瞒。该套件首次运行时 Electron 子进程无法在系统临时目录创建输出，
改用仓库内 `VISUAL_FINISH_OUT` 后完成；临时目录已删除。

独立复审（只读 diff + 真实 Chromium 复现）发现 1 项 Important：挂载窗口内
到达的实时消息会插进历史中间，并提前占用 `user-55` 这类锚点序号；已在
`messages.js` 用实时写入前的同步补齐修复，并由第 11 条用例覆盖。复审另报
两项 Nit（`sessionId` 为空时滚动被拉底、取消挂载后 `aria-busy` 残留）也已
修复并纳入第 6 / 12 条用例。复审未发现 Blocker；过期批次取消、Plan 锚点与
Runtime 定位未发现问题。复审后按同一思路自查实时入口，发现 `tools.js` 的
工具组与 `plan-live.js` 的计划卡同样能在挂载窗口内直接 append，已一并加守卫
并扩到第 11 条用例（工具组与 `gui_plan` 卡都排在完整历史之后）。

`runtime-conversation` 新增 4 条定位断言（110/110，原 106/106）：

1. 目标被裁剪：不滚动、`trimmed`、提示包含「已裁剪 / 无法定位」。
2. 历史截断但命中仍在：正常滚动、`found`、提示为空。
3. 未截断且目标缺失：`missing`、提示不是「已裁剪」。
4. 助手正文 block 带 `messageId`：按消息 id 命中真实行。

`session-ux-phase3-perf` 也运行完成，其夹具 770 条消息仍在 800 阈值以下，
走原同步路径，行为与数据未变。完整 `npm test` **未运行**；跳过断言不计入
上面的分子分母。

## 8. 真实 Chromium 视觉验收

`node tests/session-ux-phase4d-shots.cjs`：**20/20 通过**。使用 CDP
`Emulation.setDeviceMetricsOverride` 精确设置 1320×820 与 700×600，深色与浅色
各 4 张，共 8 张：

- `classic-{1320x820,700x600}-{dark,light}.png`：829 条消息的 Classic 中段，
  含消息、Thinking、工具组、Plan 卡、Minimap 与 Composer。
- `runtime-locate-{1320x820,700x600}-{dark,light}.png`：Runtime 只读历史，
  顶部显示「搜索命中位于已裁剪的只读历史之外……无法定位」。

关键实测：

- 四种矩阵下 Classic 用户数 300；1320 下 Minimap 显示 300 个 marker，
  700 下按既有 `@media (max-width:900px)` 规则隐藏（不是本轮引入的回退）。
- 页面、聊天流、Runtime 输出横向溢出均为 0；700×600 下正文列与 Composer
  没有重叠。
- 深色 / 浅色正文对比度 12.35 / 13.26，角色标签 8.19 / 6.29；
  Runtime 定位提示 8.67 / 6.67（12 px 小字，均 ≥4.5）。
- 截图见 [shots 目录](ui/session-ux-phase4d-evidence/shots/)，
  测量汇总 `shots-summary.json`。

## 9. 构建产物

`npm run build:app -- --rebuild` 退出 0，
`dist-app/Pi GUI-win32-x64/Pi GUI.exe` 246,324,736 字节（234.9 MB），
整包 333.6 MB。构建产物在 `.gitignore` 内，不进入提交。
用户运行源码版即可看到本分支改动。

## 10. 未验证与残余风险

- 未运行完整 `npm test`；未在真实 Electron 打包应用、真实 Pi 长会话或真实读屏下
  复验（Electron 渲染器套件见上，4 项 UI3 选择态失败未归因于本改动）。真实滚轮、触控板惯性滚动与连续多次 A→B→A 的长时间跟踪未做。
- 未对真实模型调用做端到端历史搜索定位，只使用真实投影形状与真实视图。
- 分块让出点之间仍可能有 >100 ms 的批次布局任务（after 中位 163 ms、
  P95 214 ms），但发生在首屏已可见、可交互之后，且低于冻结基线的 447 ms；
  没有把后续批次强行压到 100 ms 以下，因为更小批次会让总就绪明显变差（见第 6 节）。
- 总就绪相对冻结基线 −2.1% / +6.8%，在 10% 门槛内；相对同环境同步复测
  −15.8% / −7.4%。总就绪没有达到 30% 改善，差额来自分块让出后的
  rAF 与入场动画尾部，本轮没有为这个数字牺牲完整 DOM 契约。
- 工具组折叠中位 +7.0 ms、搜索冷缓存 +2.3 ms 与同环境复测/更早 after 的
  方向不一致，P95 或绝对量不支持「代码回退」：两者路径未改，且搜索三组
  after 横跨 12.7–16.4 ms。原始数据均保留，不挑有利的一组。
- 环境漂移已保留在原始数据里，不把它归因于分块代码；`after-final/` 的
  112 ms 同步段样本与 `after-final-clean/` 的 82.3 ms 最大值也一并保留。
- 本分支不合并、不发版；合并与发布需另行授权。

## 11. 回滚边界

- Classic 分块：回滚 `public/messages.js` 的 `HISTORY_CHUNK_*` / `renderItem` /
  `mountHistoryInChunks` 改动即可恢复同步重建；书签、导航与 DOM 契约不变。
- Minimap 动效补偿：回滚 `public/conversation-nav.js` 的入场动效进度补偿即可
  恢复原布局读取方式；`public/reading-position.js` 未改动。
- Runtime 定位提示：回滚 `public/runtime-conversation.js`、
  `public/runtime-timeline.js` 的 `locateNotice` / `messageId` 改动即可恢复
  原来的「找不到目标行」行为；不涉及保留上限与读取范围。
- 测试与文档：`tests/session-ux-phase4d*.cjs`、`docs/session-ux-phase4d-acceptance.md`
  可独立回滚；`package.json` 只新增测试入口，不影响运行时。

## 12. P4 收尾结论

P4-D 已完成：Classic 长会话的最慢任务与同步段均改善 >55%，其中同步段
−81.4%～−91.2%（同环境 −84.7%～−92.2%）、最慢任务 −58.3%～−63.5%
（同环境 −65.4%～−67.9%），满足 30% 门槛；总就绪同环境 −7.4%～−19.5%，
未达到 30%，原因与未实施的进一步优化见第 5、6、10 节。Runtime 裁剪命中
不再虚假定位；完整 DOM、复制、打印、书签、Minimap、跳转、实时插入、
工具/Thinking/Plan/子代理展开与 P1–P4-E 行为均通过定向回归。

P4-A / P4-B / P4-C / P4-E 已在此前合并，P4-D 作为最后一个阶段完成实测与验收。
**P4 达到整体收尾条件**：没有遗留需要继续开发的功能项；剩余限制是未跑完整
`npm test`、未做真实 Electron 打包应用 / 真实 Pi 长会话验收，以及上述环境漂移下的
总就绪门槛说明，均不构成新的 P4 开发计划。
