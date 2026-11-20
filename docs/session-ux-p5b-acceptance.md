# P5-B 统一执行时间线验收

## 交付范围

- 起始提交为 `af0432a0bc3b04c717a63ede3cc457e859401833`，P5-A 由 #99 合入。该提交的 main push CI 已完成。开发位于 `codex/session-ux-p5b-timeline`。 [基线 CI](https://github.com/HYJ1817/pi-gui/actions/runs/44753076800)
- 本地行为提交为 `3e5a9e1cc244ddbc7f6ac3925c01b76fc41e1176`。Chromium、桌面产物和最终受影响路径复验对应这棵代码树。验收记录的独立提交可用 `git log -1 --format=%H -- docs/session-ux-p5b-acceptance.md` 定位。
- Classic 与 Runtime 对能够验证原生会话、分支、起始输入和活动归属的实时轮次挂载同一时间线。现有历史读取路径接管证据不完整、历史或不支持的情况。刷新、重连和跨进程恢复统一时间线属于 P5-C。 [实施计划](session-ux-p5-implementation-plan.md)
- Classic 展开时复用已有授权工具节点。Runtime 使用既有白名单内的摘要、状态和子项信息，展开区明确标识受限详情。当前阶段没有启用 Runtime 明细读取动作。 [权限与数据契约](session-ux-p5-architecture.md)

## 行为与文件

| 范围 | 交付 |
| --- | --- |
| 共享视图与样式 | `execution-timeline-view.js`、`agent-execution.css` 提供六行任务预览、原生键盘开合、真实计划、单一活动组、有界分页、过程/终答分区和统一逐响应账本。任务和工具开合可保留焦点，关闭活动组会卸载活动行和明细。 |
| Classic 接入 | `app.js`、`classic-execution-view.js`、`messages.js`、`plan-live.js`、`tools.js` 依据同一接收事件保留原节点及原位置。计划、Markdown、附件、工具输出、子代理及消息动作复用现有组件。折叠组中的旧工具节点移出已挂载 DOM，降级时可按原位恢复。 |
| Runtime 接入 | `runtime-state.js`、`runtime-store.js`、`runtime-conversation.js` 用接收路径内的所有者、分支和事件序号绑定节点。用量账本沿用录得的逐响应原值，含真实零值、Plan-only 和流式累计状态。 |
| 消息与阅读 | `ui/user-message-body.js` 抽出原用户消息体渲染，用于共用 Markdown 与附件。 `reading-position.js`、`conversation-nav.js` 保留嵌套锚点并在定位补充输入时打开过程区。编辑重发确认前保留原视图，确认后使用原生顺序处理旧尾部。 |
| 模型回退 | `execution-timeline-adapter.js`、`execution-timeline-state.js` 提供当前已验证的自动回退回声证据。两端给该回声保留 Pi 原生下标，同时复用第一次提交的任务卡和编辑目标。 `fallback.js` 驱动 Classic 终态在回退协调期间等待，候选选择失败后恢复原终态。 |
| 回归 | `package.json` 从唯一 canonical 测试入口注册共享视图、Classic 和 Runtime 三个套件。 `tests/session-ux-p5-shots.cjs` 使用离线夹具和真实 Chromium 测布局、对比度与操作。 |

后端路由、审批授权、Stop 闸门、Pi 会话文件与工具载荷协议沿用原路径。可见思考文本沿用原渲染和数据。 `public/thinking-dots.js`、`public/thinking-dots.css` 与 `public/scroll-button.js` 相对基线的文件 diff 为空，Classic 和 Runtime 的运行指示调用与宿主位置沿用原实现。

## 证据

Windows x64，Node v24.22.1，npm 11.19.1。测试使用离线夹具。输出保存在当前工作树的 `.shots/session-ux-p5b/`。

| 检查 | 结果 |
| --- | --- |
| P5-A 模型和权限 | `npm run test:session-ux-p5-model` 退出 0。25 组 adapter 检查、61 条 model 断言、7 组后端检查。 |
| P5-B 行为 | 共享视图 6/6，Classic 17/17，Runtime 1/1 集成场景。覆盖不同 UI 来源、逐响应统计、无可靠归属的回退、精确回声、同文本独立任务与原生下标。 |
| 既有行为 | P1–P4、Classic/Runtime 显示及用量共 10 次定向命令全部退出 0，见 `adjacent-3e5a9e1c.log`。其中 P1 81/81、P2 96/96、P3 128/128、P4-A 110/110、P4-B 108/108、P4-D 14/14、P4-E 60/60、用量 51/51。另有消息编辑 42/42、模型回退 74/74、思考动画 90/90、审批 84/84、审批与历史切换回归 32/32。 |
| Chromium | 八组（两端、两种主题、1320×820 与 700×600，DPR 1），横向溢出为 0 px。活动行约 28.19 CSS px，125% 字号约 33 CSS px。测得活动文字最低 7.01:1、键盘焦点最低 15.94:1。通过键盘开合和裁剪区链接的 Tab 排除检查。 `measurements.json` 和 10 张 PNG 可回查。 |
| 完整 canonical | 本机 `npm test` 退出 1。第一次运行暴露组件导入触发最小 DOM 初始化的问题，抽出消息体后 `review-regressions.cjs` 32/32。第二次运行通过 P5-A、P5-B 和其前的会话回归，在 `test:provider-management` 的 185 条中通过 182 条、失败 3 条，后续未执行。 `provider-config-store.cjs` 单独复跑 17 通过、同 3 条失败。诊断确认 Windows 临时夹具祖先目录含额外写入权限，既有凭据 ACL 检查以 `config_unsafe` 拒绝。该测试与 `server/`、`lib/` 相对合并基线无改动。日志 `canonical-initial.log`、`canonical.log` 和 `provider-config-standalone.log`。最终改动的受影响路径已定向补验，完整 canonical 仍待验证。 |
| 桌面包 | `npm run build:app -- --rebuild --output-root <独立目录>` 退出 0，整包 334.3 MB。入口为 `.shots/session-ux-p5b/verified-desktop/dist-app/Pi GUI-win32-x64/Pi GUI.exe`。8 个前端资源逐文件 SHA-256 与工作树一致。以打包内静态资源重复 Chromium 离线取证，8 组通过。日志 `build-3e5a9e1c.log`，取证目录 `packaged-ui-3e5a9e1c/`。可执行文件 SHA-256 为 `0b57af703a66e11a07e51645847cde933c48954f7ca6c83326b5a7499af63b89`。 |
| 独立复审 | 首轮发现活动分页、补充输入锚点、失败编辑导致视图解绑，以及模型回退吞掉原生下标。Runtime 的分支替换同时校正后续原生下标，两种确认顺序均通过复验。纯图片编辑在 HTTP 先确认时保留合法空文本，在原生回声后保留原节点和图片。独立审查确认 Runtime 权限和事务所有者仍沿用原闸门。 |

## 系统设置分支冲突检查

提交态采用 `git merge-tree --write-tree --name-only HEAD feat/system-settings` 试合并。`package.json` 的 canonical 测试链存在文本冲突，`public/app.js` 与 `server.js` 自动合并。未改动系统设置分支或其本地工作区。在两条分支后续整合时，需要同时保留系统设置和 P5-B 的测试入口。

## 边界和回滚

- P5-C 负责持久化、旧会话原生历史绑定、可靠重连恢复与性能准入。本文的长活动检查针对当前浏览会话内的有界 DOM。
- Chromium 检查针对真实应用样式和会话渲染，以离线事件替代真实模型。未验证真实模型请求或覆盖安装升级。
- 回滚按本阶段行为变更的提交边界恢复旧渲染路径。已保存的 Pi 消息、权限、设置与用户文件沿用原契约。
