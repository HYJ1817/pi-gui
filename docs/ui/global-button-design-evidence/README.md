# 全局按钮设计系统证据

- 采集时间：2026-11-19
- 采集方式：真实 Electron（`--no-sandbox`，1320×820 content size，另 700×600 与 125% zoom）加载生产 `public/`，后端为离线 `tests/visual-harness.cjs`；无真 Pi、无用户数据。
- 主题：`document.documentElement.dataset.theme` 切换 dark/light。
- 计算样式：`getComputedStyle` 与 `getBoundingClientRect`，原始数据见 `before-info-dark-buttons.json`、`after-info-dark-buttons.json`、`after-states-dark-buttons.json`。
- `before-*` 来自基线 `49071b10`；`after-*` 来自本分支工作区。
- 文件命名对应页面与状态；`after-confirm-danger-*`、`after-environment-wizard-*`、`after-mcp-form-*`、`after-info-focus-ring-dark` 由补充取证脚本采集。
- `after-viz-card-*` 与 `after-viz-panel-*` 由补充取证脚本通过应用自身的 `messages.js` 重建真实会话卡片后采集；对应计算样式在 `viz-card-*.json`、`viz-panel-*.json`。

完整结论、测试数字与未运行项见[验收报告](../global-button-design-acceptance.md)。
