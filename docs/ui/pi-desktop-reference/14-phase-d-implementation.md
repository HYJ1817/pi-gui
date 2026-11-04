# 阶段 D：对话流与 Composer 实施记录

基线：`5214c4368d740e41bb7dc6adb9c7e889ee55c1c2`，即 main 的阶段 C 加已通过完整 CI、尚未合并的 PR #51。D 分支 `codex/pi-desktop-phase-d` 依赖该修复；不擅自合并它。固定参考源码 `92ae661f1e399e69d514086b46029b4c34ba1a92`。

## 勘察与取舍

- Classic `messages.js` 已有透明助手正文、右侧用户气泡、Thinking 折叠、工具时间线、Markdown、附件与滚动锚点。调整既有样式，不重新实现消息存储或流式状态。
- Runtime `runtime-conversation.js` / `.css` 已有 Markdown、会话所属草稿、模型与思考选择器；实时聚合输出与历史消息的能力不同，保留真实边界。
- Classic `composer.js` 已有自动增高、实测底部预留及发送/停止保护；`usage.js` 已有真实上下文浮层。复用，不新增第二套 inspector。
- 模型浮层继续复用 `ui3-model-picker.js`、`ui/popover.js` 与 `runtime-picker.js`。不将参考项目的滑块硬套到原生 Pi 的可用档位三态之上。
- 固定参考源码中用户消息由 `features/chat/transcript/MessageRow.tsx` 承载；早期规范的 `UserTurn.tsx` 不存在。原生 Pi 无对应的消息删除、编辑重发业务，本轮只增加有真实剪贴板能力的复制动作，不模拟改写会话。

## 源码证据与方案

| 区域 / 参考 | 固定源码 | pi-GUI 落点 | 参数、差异与方案 |
| --- | --- | --- | --- |
| 阅读列 REF-016/017/021 | `styles/chat-shell.css:282`、`styles/prose.css` | `styles.css`、`runtime-conversation.css` | 760px 内容带，线程内横向 32px；14px 正文；已有 920px 阅读列收窄，助手继续透明 |
| 用户消息 REF-017/021 | `styles/chat-shell.css:14`、`styles/messages.css:1972`、`MessageRow.tsx` | `messages.js`、Runtime 历史、共享复制动作 | 按有效级联：18px 圆角、右下角 `--radius-xs=8px`、10/15px 内距、82%/600px 上限；动作栏 hover 与键盘 focus 可见；仅复制 |
| Composer REF-001/015/016/021 | `styles/composer.css:166`、`:396`、`:449` | `ui3-composer.css`、Runtime 既有 Composer | 20px 圆角、语义 composer 面与阴影、28px 圆形发送/停止、底部 16px；保留 Classic steer 与停止确认保护 |
| 模型浮层 REF-015 | `styles/composer-menus.css:73` | `ui3-model.css`、Runtime picker | 20px 外圆角、5px 内距、model-menu 阴影；pi-GUI 保留 provider 身份、独立可用档位与防过期选择 |
| 补全 REF-022 | `styles/composer-autocomplete.css` | `ui3-inline-commands.css` | 复用唯一补全系统、键盘及 IME；只调表面与间距 |
| 上下文 REF-023 | `ContextUsageInspector.tsx` | `usage.js` 原浮层 | 视觉统一；只显示已有上下文与真实用量，不伪造网络/模型/工具耗时 |

## 执行与验证计划（单代理）

- [x] 在真实生产渲染模块的既有测试中增加复制动作、实时/历史一致性及失败状态回归，先确认失败。
- [x] 修改既有消息与 Composer 样式，沿用 A/B 语义变量；不改变 Pi RPC、后端、草稿或会话 owner。
- [x] 为 Classic 与 Runtime 增加共享、无写盘副作用的消息复制入口；保留所有既有能力。
- [x] 扩展既有正常沙箱 Electron 验收工具；检查 DPR 1.5、深浅、流式/完成、Thinking、模型/补全/用量浮层、附件、窄窗和 A/B/C 回归。
- [x] 运行定向回归及完整 canonical 累计验证（234 条唯一命令退出 0）；保留首次失败、重跑、最终状态补验及环境跳过，详见 15。
- [x] 重建独立产物并核对当前 9 个生产文件副本；自审增量，独立 Agent 审查按用户要求不执行并明确为未验证。
- [x] 形成逐项实际结果与合理差异报告，交付等待验收；本轮不推送、合并或发版。
