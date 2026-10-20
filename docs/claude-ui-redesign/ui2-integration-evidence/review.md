# UI-2 集成只读复核（Runtime / Classic 与 CSS 接口）

审查基线：集成提交 `50d20dd`（A、B、C 已合并）；2026-10-16。此报告描述修复前的合并结果，后续集成修复与回归应另列证据。未修改任何产品源文件、原 A/B/C 工作区、继承证据；未联网、提交、推送。结论以集成源码为准。

## 发现与纯展示最小修复建议

1. **[P2] 流式滚动在布局更新后判断贴底。** `public/runtime-conversation.js:366` 先设置正文，`:372-380` 也会改变思考/用量布局，`:435` 才调用 `shouldFollow(output)`。一个较长 chunk 或思考块出现使底部距离达到 160px 时，原本贴底的读者会失去跟随。应在 draw 中任何 DOM 布局变化前捕获贴底状态，更新后用该值决定是否跟随；切会话仍用各自保存位置，用户上滚仍保留位置。动态高度 fixture 调用真实 draw 得到：更新前 top=900、height=1000、client=100；新增 200px 后 top 仍 900、height=1200，正确贴底应为 1100。此证据是布局时机 fixture，**不是实际浏览器布局验收**；还需真实 Electron 长 chunk、展开思考改变输出高度的回归。

2. **[P2] 结束消息缺最终 usage 仍显示进行时。** `public/runtime-display.js:161-162` 没有有效最终 usage 时保留原 `source=message_update`，`:84` 因而继续输出“流式中，Pi 仍在累计”。独立 fixture 依次发送 update(output=4) → assistant message_end(content=[])，结果确为 `本轮 · 输出 4（流式中，Pi 仍在累计）`。建议省略缺少最终数据的 usage，或明确标为“已观察值，终值未知”，不能把旧流式值升级成权威终值。最终缺失、无效、部分字段、真实 0 均应覆盖；下一条 assistant message_start 继续清空上一条。

3. **[P2] 投影把记录已消失与关闭 owner=null 混为一谈。** `public/runtime-display.js:124-127,170-175` 对 `store.get(id)` 不存在也得到 null owner 并保留。实际 store 在 backendInstance 改变时清空记录；fixture 先写 A thinking/usage，再 seed 新 backend + 空 items 并广播，`store.get('A')` 为 undefined，投影仍返回旧 A 思考和用量。同 conversationId 在新 backend 恢复为 dormant/null owner 时也有旧显示风险。最小建议在展示记录保存对应 store record 对象引用：不存在或引用被 fresh 替换就丢弃；原位 runtime_closed 将 owner 设 null 的保留语义不受影响。继续保留完整 owner/generation 判定；不改 store、服务端或安全投影。回归需覆盖 backend reset 空列表、新 backend dormant 同 id、权威 snapshot fresh(null owner)、原有 runtime_closed 保留、重启换代、迟到帧拒绝。

4. **[P2] Runtime usage 接受负数、非整数与不安全整数 token。** `public/runtime-display.js:48,61-63,80-82` 只有 finite 判断。fixture 的 `input=-1, output=1.5, reasoning=9007199254740992, cost.total=-0.01` 全部被保留。Classic `public/message-meta.js:12` 已采用非负 safe integer；Runtime token 应使用同一数字约束，成本用非负 finite（允许小数），两者均保留真实 0。回归应包含负数、分数、超 safe integer、NaN/Infinity、字符串、缺值、真实 0。只收窄展示数字，不推算、不修改原始数据。

## 已核对的正常契约

- 投影默认仅订阅 runtime-state 广播，store 拒绝的 owner/旧 generation/重复 sequence/replay 帧不能进入；`runtime-store.js` 与 `runtime-state.js` 未被 B 修改。投影先订阅、会话 draw 后订阅，展示能读取当前帧投影。
- assistant message_start 清本消息 thinking/usage；用户消息不清。权威 message_end thinking 存在时覆盖，空 thinking 字符串能够清空，缺 thinking 块按既定验收约定保留此前已观察文本，不伪造历史。
- 输入草稿、保存滚动位置、异步请求结果、审批 action owner 继续按 conversationId/captured target 隔离；既有独立测试通过。缺数据不补 0，真实数值 0 原本已保留。
- Classic 实际 `footer.ui2-msg-meta > span.ui2-msg-meta-item[data-kind]` 匹配 CSS `:572-573`；工具摘要为原生 `button.tl-group-head.ui2-tool-summary`，折叠同步 aria-expanded，匹配 `:556-570`，状态摘要 `.ui2-tool-state` 匹配 `:571`；单项隐藏和未知状态回退仍由真实 DOM 决定。
- Runtime `data-state=running/done/error` 匹配 CSS `:2688-2690`；思考 pre 已补 `white-space:pre-wrap;overflow-wrap:anywhere`（`:2679-2683`）。未发现 A/C 或 B/C 的类名、状态选择器组合阻塞。

## 独立执行的验证及限制

- 原始 B 专项 `node tests/ui2-runtime-display.cjs`：**74/74，退出 0**。
- 原有 `node tests/runtime-conversation.cjs`：**48/48，退出 0**。
- 上述缺 usage、非法数字、backend reset 以及滚动时机分别通过临时内存 fixture 复现；未写入真实项目或真实会话数据。
- 未重复 A/B/C 原截图，未覆盖继承报告；未在本审查任务启动实际 Electron/真实模型、整套 npm test 或构建。现有 74/74 覆盖纯 shouldFollow 数值边界，但不能证明其调用时机正确，新增回归应保留全部原断言。

结论：需要先完成上述展示修复及新增回归，再认定 Runtime 集成展示收口。所有建议均可限定在展示层和测试；无需放宽安全白名单、恢复工具参数/结果、改变 owner 校验、修改 Pi 或服务端。

## 集成修复后二次只读复核

主任务已将四项建议落盘。本审查只读检查相对上述基线的实际 diff，并独立重跑：

- `node tests/ui2-runtime-display.cjs`：**82/82，退出 0**。原 74 条保留，新增 8 条；数字增量不是替换、删除旧断言所得。
- `node tests/runtime-conversation.cjs`：**48/48，退出 0**。

源复核：draw 在任何 DOM 变化前采样 `follow` 并在布局更新后执行；token 在 readUsage 与 usageText 两端均要求非负 safe integer，成本要求非负 finite，保留真实 0 和合法小数成本；message_end 缺有效 usage 时清空该条展示，符合“缺终值省略”的选项；投影持有对应 store record 引用，fresh 替换和 backend reset 不再返回旧数据，而原位 runtime_closed 仍保留已观察内容。以上修改未碰 runtime-store、runtime-state、完整 owner 校验、后端安全投影或 Pi；本次复核未发现新增副作用。

新增 8 条回归覆盖非法数字、合法零/成本、临时 usage、缺终值省略、接受帧记录、原位关闭保留、backend 换代同 id dormant、记录移除时禁止返回残留。真实布局下的长 chunk 贴底、用户上滚、思考块展开变化仍应以主任务的 Electron 证据为准，本轮 82 条不能替代该证据。可继续进行独立离线构建；是否满足全部交付门槛由主任务汇总其他验证结果。
