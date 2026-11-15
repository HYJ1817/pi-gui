# 会话过程 UI/UX 第一阶段对照证据

本目录是第一阶段（运行中工具组、轮次终态、Token 摘要、重试摘要）的真实渲染截图，不是产品资源。截图由 `tests/session-ux-phase1-shots.cjs` 在真实 Electron + Chromium 中生成；页面由离线 `tests/visual-harness.cjs` 提供固定夹具，不启动真 pi、不读取用户会话、不写真实项目。

## 生成方式

```bash
# 当前实现
SESSION_UX_SHOTS_LABEL=after node tests/session-ux-phase1-shots.cjs

# 基线 c43fc3f 的 public/（另外准备一份 worktree，指向同一 node_modules）
SESSION_UX_SHOTS_LABEL=before \
  VISUAL_PUBLIC_ROOT=<baseline-worktree>/public \
  node tests/session-ux-phase1-shots.cjs
```

- 基线：`c43fc3f21ae72a8948bb9b8b13dc01d304205c88`（v0.34.0 合并后）。
- 当前：`feat/session-ux-phase1` 分支，具体提交见 [第一阶段验收报告](../../session-ux-phase1-acceptance.md)。
- 视口：默认 `1320 × 820`；窄窗 `700 × 600`。深、浅主题各一张。
- 截图是物理像素；CSS 视口以报告中的 `after-report.json` / `before-report.json` 为准。

## 文件对照

| 场景 | before（基线） | after（当前） | 观察点 |
| --- | --- | --- | --- |
| 工具组默认状态（两个已结束 + 一个运行中） | `before-01/02/03-*` | `after-01/02/03-*` | 基线默认折叠，只剩组头；当前活跃组保持展开，能看到运行中/失败/成功三类行与组耗时 |
| 单条消息 Token 元信息 | `before-04/06-*` | `after-04/05/06-*` | 基线是 5 项平铺的一行；当前默认是“总量 · 思考 + 明细”，完整字段在原生 `<details>` 中 |
| 轮次终态 | `before-07/08-*` | `after-07/08-*` | 基线没有轮次级结束行；当前在回答/工具之后显示“已完成 · 时长 · 工具数 · 工具失败数” |
| 自动重试摘要 | `before-09/10/11-*` | `after-09/10/11-*` | 基线撤掉错误块后对话只剩用户消息；当前保留“触发限流 · 第 1/3 次重试…”与可展开的原始错误 |

## 边界与已知问题

- 700px 截图中阅读列右侧被 `.stage` 裁切，是基线已有的窄窗布局问题（`before-03` 同样存在），不是本阶段引入；本阶段未修改外壳与阅读列布局。
- 截图只覆盖夹具会话，不代表真实 pi 的完整事件时序；真实事件时序由 `tests/smoke.cjs`、`tests/agent-execution-ui.cjs`、`tests/session-ux-phase1.cjs` 与 `tests/thinking-dots.cjs` 断言。
- 证据 JSON 只记录视口、主题、版本与截图名，不记录会话内容。
