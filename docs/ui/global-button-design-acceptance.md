# 全局按钮设计系统验收

- 分支：`feat/global-button-design`（基线 `49071b10`，未合并 `main`）
- 日期：2026-11-19
- 范围：全局文本按钮的语义变体、共享实现、全站迁移、设计规范、回归测试与真实 Electron 渲染证据
- 不包含：Composer 交互、会话流程、更新状态机/下载器/安装器、供应商业务逻辑、Pi RPC、主题品牌调整、新依赖

## 1. 结论

本轮把原先「透明背景 + 细线边框」的 `.btn` 基线改为 PI-Desktop 风格的中性灰填充 Secondary，并建立五种语义变体：Primary、Secondary（默认）、Ghost、Danger、Outline（仅例外）。共享实现集中在 `public/ui/primitives.css`，由 `public/tokens.css` 的 `--ds-button-*` Token 驱动；`.pm-btn` 保留为同源别名。

全站已迁移到共享变体：信息、模型供应商、供应商认证、MCP 配置/市场、Skills/扩展、环境与依赖、常规设置、快捷键、诊断、日志、任务与审阅、Git/Changes、Runtime 会话、确认框和表单。Composer 发送/停止、会话列表行内动作、侧栏图标按钮、工具栏图标按钮、Tabs、分段控件、开关、选择器、菜单项、帮助图标和原生窗口按钮保留各自设计，仅清理了会误伤它们的背景覆盖。

信息页验收目标全部满足：检查更新、检查 Pi 更新、重启 Pi、打开日志、导出故障报告、打开诊断、打开 GitHub 均为填充 Secondary，无明显边框，文字完整；`更新到 1.0.0` 保持唯一 Primary。深/浅主题、700×600、125% 字体缩放及 Default/Hover/Pressed/Focus-visible/Disabled/Loading 均已实机检查。

## 2. 勘察结论

改动前的实现存在三套并行按钮系统：

1. `styles.css` 的 `.btn`：30px 高、透明背景、1px 可见边框、12.5px/400；`.tiny` 24px。
2. `provider-management.css` 的 `.pm-btn`：自带 geometry 与 ghost/small/danger-ghost 规则。
3. `styles.css` 的 `.ds-btn-secondary` / `.prov-btn-main`：第三方/供应商页局部体系，覆盖共享按钮的几何与配色。

由此产生的实际问题：普通独立按钮默认是「透明 + 描边」，与 PI-Desktop 的次级按钮不一致；同一页的普通动作、工具栏动作和危险动作缺少统一语义；页面通过更高优先级覆盖公共规则；`styles.css` 在 `primitives.css` 之后又定义了 `.btn.danger` / `.btn.alt` / disabled，形成第二真相。

本轮按「以现有代码为准」处理：保留 `.btn`、`.pm-btn` 及测试依赖的选择器；把 `.pm-btn` 收敛为 `.btn` 的同源别名；删除 `.ds-btn-secondary` 与 `.prov-btn-main` 的独立外观；页面只选择变体与尺寸。

## 3. 语义变体

| 变体 | 类名 | 用途 |
| --- | --- | --- |
| Primary | `.btn.primary` | 保存、确认、提交、安装、应用、更新到 X；每个区域至多一个 |
| Secondary | `.btn`（基类） | 普通独立文本动作；填充中性灰、无明显边框 |
| Ghost | `.btn.ghost` | 工具栏、行内辅助动作、行内取消/稍后/忽略、面板关闭 |
| Danger | `.btn.danger` | 删除、清空、移除、撤销；淡红填充；确认框内保持中性底 + 危险文字/边框 |
| Danger ghost | `.btn.danger.ghost` | 行内删除/移除等低视觉重量危险动作 |
| Outline | `.btn.outline` | 仅当按钮所在表面与 Secondary 填充无法区分且有明确业务理由 |

几何：基类 32px 高 / 12px 横向内边距 / 10px 圆角 / 13px 500（Primary 560）；`.tiny` 28px / 10px / 8px / 11.5px；`.micro` 24px / 8px / 8px / 11px。图标与文字间距 6px。

状态：Hover 使用 `--ds-button-*-hover`；Pressed 使用 active Token 并 `scale(.98)`；Focus-visible 统一 2px `--ds-focus` 外偏移 2px；Disabled 透明度 .45 且不响应指针；Loading 使用 `aria-busy="true"`，透明度 .6、`cursor: progress` 并显示 `::before` 旋转指示。`prefers-reduced-motion` 取消位移与旋转；`forced-colors` 保留 `ButtonText` / `Highlight`。

完整规则、示例与反例见 [全局 UI/UX 设计规范](design-system.md#按钮语义系统)。

## 4. 共享实现

- `public/tokens.css`：新增 `--ds-button-*` 语义 Token（高度、内边距、圆角、字号、字重、间距、焦点、禁用/忙碌透明度、五个变体的背景/文字/边框）。
- `public/ui/primitives.css`：新增 `.btn` / `.pm-btn` 基类（Secondary）与 Primary、Ghost、Danger、Danger ghost、Outline、`.tiny`、`.micro`、reduced-motion、forced-colors。
- `public/styles.css`：删除旧 `.btn,.pm-btn` 透明基线、旧 `.btn.primary` / `.btn.danger` / `.btn.alt` / disabled 规则、`.btn.tiny`、`.btn.ds-btn-secondary`、`.prov-btn-main` 几何与 `.prov-reload-btn` 几何；保留图标按钮焦点环和页面布局选择器。
- `public/provider-management.css`：删除 `.pm-btn` / `.pm-btn-ghost` / `.pm-btn-small` / `.pm-btn-danger-ghost` 的重复实现，指向 `primitives.css`。
- `public/viz.css`：删除 `.viz-open-btn` 的独立填充/边框/Hover，以及 `.viz-toggle-raw` 的固定文字色和 `.viz-toggle-btn` 的页面圆角；普通卡片动作回到共享 Secondary，切换类动作回到 Ghost。
- `public/mcp.css`：删除 `.mcp-page-actions .btn.primary` 的 14px 内边距覆盖，Primary 使用共享 12px。
- `public/provider-management/model-panes.js`：两处直接构造的按钮补上 `pm-btn` 基类，避免失去共享样式。
- 页面尺寸修饰（`.rp-btn`、`.session-change-row > .btn`、`.specs-error .btn`、`.rtc-controls > .btn`）只保留几何，不再设置背景或文字色。

## 5. 迁移清单

| 范围 | 文件 | 调整 |
| --- | --- | --- |
| 信息页 / 更新 | `about.js`、`update.js`、`pi-update.js`、`app-update.js` | 检查更新/检查 Pi 更新/重启/日志/导出/诊断/GitHub 保持 Secondary；安装/下载/重启更新用 Primary；忽略/稍后及对话框取消等辅助路径用 Ghost（下载中的取消下载保留 Secondary，作为该状态区唯一独立动作）；危险确认用 Danger |
| 供应商 | `providers.js`、`provider-management/model-panes.js`、`provider-management.css` | 添加/保存用 Primary；重载配置、刷新模型、测试、授权等 Secondary；取消/高级设置 Ghost；移除配置 Danger ghost |
| 扩展 / MCP | `extensions.js`、`mcp-settings.js`、`mcp-market.js` | 刷新/登录/退出/扫描/授权等 Ghost；安装/保存 Primary；删除/移除 Danger 或 Danger ghost |
| 环境 / 项目 | `environment-setup.js`、`project-config.js`、`projects.js`、`worktrees.js` | 安装/保存/创建 Primary；后台继续/取消/恢复默认 Secondary；打开诊断/稍后设置 Ghost；取消安装 Danger |
| 诊断 / 日志 | `diagnostics.js`、`logs.js` | 打开日志/复制/刷新/关闭 Secondary；导出/确认 Primary；清理日志 Danger；日志条目复制/引用 Ghost |
| 任务 / 审阅 | `planner.js`、`approval.js`、`candidate-review.js`、`review-task-preview.js`、`session-revert-object-ui.js` | 生成/确认/提交 Primary；跳过/关闭诊断/展开/返回/取消 Ghost；危险/拒绝保留对应语义 |
| Git / Changes | `git.js`、`session-changes-panel.js`、`ui4-pane.css` | 审查/复制 Primary；刷新/编辑/评论/标记/对比/下载/查看对象 Ghost；全部撤销 Danger |
| Runtime / 会话 | `runtime-conversation.js`、`runtime-secondary.js`、`runtime-sessions.js`、`session-navigation.js`、`terminal-panel.js`、`terminal-tabs.js`、`process-panel.js`、`specs-panel.js`、`viz-panel.js`、`markdown.js`、`ui/split-workbench.js` | 发送/启动/恢复/确认 Primary；刷新/停止/重启/关闭/退出分屏/Browser/开发进程/更多/图表切换 Ghost；保留 Composer 发送与停止原设计 |
| 通用弹层 / 控件 | `ui/modal.js`、`ui/capability-setup.js`、`ui/fallback-settings.js`、`tree.js`、`appearance.js`、`app.js` | 延期/第三路径 Ghost；确认/安装/保存 Primary；关闭且为唯一动作或弹层普通取消用 Secondary；危险确认沿用中性底 + 危险文字 |

旧类映射：`.ds-btn-secondary` → `.btn`；`.pm-btn` → `.btn` 同源别名；`.pm-btn-ghost` → `.btn.ghost`；`.pm-btn-danger-ghost` → `.btn.danger.ghost`；`.btn.alt` 保留为 Ghost 旧别名；`.prov-btn-main` 仅保留测试/装配选择器，不再拥有独立几何或配色。

## 6. 受保护控件与例外

- Composer 发送/停止/附件、会话列表行内动作、侧栏图标按钮、工具栏图标按钮、Tabs、分段控件、开关、选择器/下拉、菜单项、帮助图标、原生窗口按钮：未改设计与类名；只检查 `.btn` 规则未误伤。
- 链接式控件与紧凑返回导航保留各自外观：环境向导的 `.env-link-button`（打开诊断、稍后设置）和 MCP 市场的 `.mcp-back-btn`（我的服务）不套用文本按钮填充，也不构成新的页面级按钮体系。
- 图表卡片的「打开可视化」使用共享 Secondary；「JSON」与图表形态切换使用 Ghost，形态切换仅在选中时使用 accent。它们复用共享按钮 Token，不再在 `viz.css` 中维护独立填充、边框、圆角或文字色。
- 对话框取消的层级：确认框、通用弹层和审批弹层使用 Secondary；行内审批行的取消使用 Ghost；「稍后处理」等第三路径使用 Ghost。
- 确认框内 `.modal-actions .btn.danger` 使用中性 `--ds-tile-deep` 底 + 危险文字/边框，保留 P14-E 的「无大面积饱和红」要求。
- `.btn.alt` 作为确认框第三条路径的 Ghost 别名保留，未新增使用。
- `.btn.outline` 已定义但当前没有调用点；它是例外入口，不作为默认样式。
- `ui4-approval.css` 的审批按钮保持 `min-height: 32px` 与 `--ui-focus`：该文件有独立的「只使用 UI-1 语义 Token」测试，未修改测试来迁就新 Token。

## 7. 回归测试

新增 [tests/design-system-buttons.cjs](../../tests/design-system-buttons.cjs)，并加入 `package.json` 的 canonical `test` 链（`core` 分组）及 `test:primitives`：

- 阶段 A（纯 Node，5 项）：基类必须是非透明 Secondary、Ghost 必须透明、Primary/Danger 使用共享 Token、页面不得重新引入 `.ds-btn-secondary` / 旧 `.btn.danger` / `.btn.alt` / `.pm-btn` 基础样式。
- 阶段 B（真实 Electron + 离线 visual-harness，34 项）：深/浅主题计算样式（填充、边框、32px/10px/13px、`.tiny` 28px、Disabled、`aria-busy`、Hover、Pressed、键盘 Focus-visible）；信息页七个目标按钮的 Secondary 语义、Pi 更新 Primary、浅色主题、700×600 布局与渲染进程零错误。

执行结果（本轮实际运行）：

首次 PR CI 在 `tests/diff-comments-ui.cjs` 捕获审查任务预览的 `done` 初始化顺序错误（TDZ `ReferenceError`）。已把 Ghost 变体设置移到 `done`/`history` 声明之后，并复跑该套件 51/51。随后 CI 又在新增 Electron 测试中暴露浅色主题误采到指针残留 hover 的基线；测试内先把指针移出探针后连续复跑 3 次通过。其余受影响套件结果如下。

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `node tests/design-system-buttons.cjs` | phase A 5/5，phase B 34/34 | 0 |
| `node tests/primitives.cjs` | 全部通过 | 0 |
| `node tests/settings-acceptance.cjs` | 19/19 | 0 |
| `node tests/about-info.cjs` | 41/41 | 0 |
| `node tests/app-update-ui.cjs` | 22 pass | 0 |
| `npm run test:viz` | viz-schema 22/22，viz-ui 68/68 | 0 |
| `node tests/app-shell.cjs` | 10/10 | 0 |
| `node --test tests/provider-management-ui.cjs` | 79/79 | 0 |
| `node tests/mcp-management-ui.cjs` | 31 passed | 0 |
| `node tests/ui4-approval.cjs` | 44/44 | 0 |
| `node tests/diff-comments-ui.cjs` | 51/51 | 0 |
| `node tests/ui4-feedback.cjs` | 27/27 | 0 |
| `node tests/ui4-integration.cjs` | 57/57 | 0 |
| `node tests/specs-ui.cjs` | 25/25 | 0 |
| `node tests/runtime-secondary.cjs` | 24/24 | 0 |
| `node tests/process-ui.cjs` | 17/17 | 0 |
| `node tests/logging-ui.cjs` | 11 passed | 0 |
| `node tests/session-change-ui.cjs` | 27/27 | 0 |
| `node tests/split-workbench-ui.cjs` | 30/30 | 0 |
| `node tests/worktrees-ui.cjs` | 16/16 | 0 |
| `node tests/extensions.cjs` | 52/52 | 0 |
| `node tests/capability.cjs` | 74/74 | 0 |
| `node tests/git.cjs` | 161/161 | 0 |
| `node tests/planner.cjs` | 124 passed | 0 |
| `node tests/runtime-conversation.cjs` | 110/110 | 0 |
| `node tests/approvals.cjs` | 84/84 | 0 |
| `node tests/project-config.cjs` | 115/115 | 0 |
| `node tests/environment-setup.cjs` | 21/21 | 0 |
| `node tests/smoke.cjs` | 1335/1335 | 0 |

本地未运行完整 `npm test`。PR [run 44461353359](https://github.com/HYJ1817/pi-gui/actions/runs/44461353359) 在代码提交 `196b8949` 上完成五组全量执行并通过，8/8 checks：Validate plan 26s、Electron build 1m42s、core 13m31s、ui 2m20s、security 18m58s、native 17m2s、faults 13m0s、CI gate 24s。本报告后续仅更新文档，不改变代码。没有删除或跳过任何既有断言；本轮新增 39 项检查。

## 8. 真实渲染证据

证据目录：[global-button-design-evidence](global-button-design-evidence/)。全部由真实 Electron 加载生产 `public/` 与离线 visual-harness 采集，1320×820（另有 700×600 与 125% 字体缩放），深/浅主题，渲染进程错误 0。

信息页关键按钮的实测计算样式（深色主题，DPR 缩放使 1px 计算为 0.666667px）：

| 指标 | 改动前 | 改动后 |
| --- | --- | --- |
| 背景 | `rgba(0,0,0,0)` | `oklab(… / 0.06)` 中性填充 |
| 边框 | `0.667px solid rgba(255,255,255,.1)` | `0.667px solid rgba(0,0,0,0)`（不可见） |
| 高度 | 30px | 32px |
| 圆角 | 8px | 10px |
| 字号/字重 | 12.5px / 400 | 13px / 500 |
| 内边距 | 0 15px | 0 12px |

图表卡片与右栏（补充取证，深色）：`打开可视化` 为 28px 高、8px 圆角、11.5px/500，背景 `oklab(… / 0.06)`，边框透明；`JSON` 为 Ghost，背景 `rgba(0,0,0,0)`；图表形态切换未选中为 Ghost，选中态使用 accent 背景和对比文字。浅色主题同样实测通过。

代表截图：

- 信息页：[改动前](global-button-design-evidence/before-info-dark.png) · [改动后深色](global-button-design-evidence/after-info-dark.png) · [改动后浅色](global-button-design-evidence/after-info-light.png) · [Hover](global-button-design-evidence/after-info-secondary-hover-dark.png) · [Pressed](global-button-design-evidence/after-info-secondary-pressed-dark.png) · [Focus-visible](global-button-design-evidence/after-info-focus-ring-dark.png) · [700×600](global-button-design-evidence/after-info-dark-700x600.png) · [125%](global-button-design-evidence/after-info-dark-font125.png)
- 图表卡片：[深色](global-button-design-evidence/after-viz-card-dark.png) · [浅色](global-button-design-evidence/after-viz-card-light.png)；图表右栏：[深色](global-button-design-evidence/after-viz-panel-dark.png) · [浅色](global-button-design-evidence/after-viz-panel-light.png)
- 模型供应商：[改动前](global-button-design-evidence/before-providers-dark.png) · [改动后](global-button-design-evidence/after-providers-dark.png)
- MCP：[改动前](global-button-design-evidence/before-mcp-dark.png) · [改动后深色](global-button-design-evidence/after-mcp-dark.png) · [浅色](global-button-design-evidence/after-mcp-light.png) · [新增表单](global-button-design-evidence/after-mcp-form-dark.png)
- 日志/诊断/任务：[日志](global-button-design-evidence/after-logs-dark.png) · [诊断](global-button-design-evidence/after-diagnostics-dark.png) · [任务与审阅](global-button-design-evidence/after-planner-dark.png)
- 确认框：[深色](global-button-design-evidence/after-confirm-danger-dark.png) · [浅色](global-button-design-evidence/after-confirm-danger-light.png)
- 环境向导：[深色](global-button-design-evidence/after-environment-wizard-dark.png)
- Composer / 会话回归：[应用外壳](global-button-design-evidence/after-app-shell-dark.png)
- 计算样式原始数据：[改动前](global-button-design-evidence/before-info-dark-buttons.json) · [改动后](global-button-design-evidence/after-info-dark-buttons.json) · [状态](global-button-design-evidence/after-states-dark-buttons.json)

说明：离线 harness 不提供供应商管理 API，供应商页显示「供应商管理暂时不可用」是夹具限制，不是本次按钮改动引入的缺陷；供应商表单的实际行为由 `provider-management-ui` 79/79 覆盖。环境向导在 harness 中按设计显示「无法读取环境状态，请重试」。

## 9. 构建产物

`npm run build:app -- --rebuild` 退出码 0：

- 应用目录：`dist-app/Pi GUI-win32-x64`（333.9 MB）
- 入口：`dist-app/Pi GUI-win32-x64/Pi GUI.exe`（234.9 MB）
- 已包含本轮 `public/` 改动，可直接双击验证；无需安装 Node。

未执行安装包/发布签名；本轮不创建 Release、不改正式版本号。

## 10. 未运行项与残余风险

- 本地未重跑完整 `npm test`；PR CI run 44461353359 已完成五组全量执行并通过（8/8 checks）。中间一轮 Electron build check 的打包应用 PTY 树杀用例出现一次冷启动计时失败（`子树子进程没有启动`），随后绿色 run 与本机 `npm run test:app` 27/27 均通过，未修改该测试或产品代码。
- `about-info-electron`、`ui5-visual-electron` 等既有 Electron 专项本轮未重跑；已用新增 Electron 计算样式测试与视觉取证覆盖本轮改动面。
- `.btn.outline` 目前无调用点，若后续启用须在验收中记录业务理由。
- 页面仍保留少量只读几何修饰（`.rp-btn`、`.specs-error .btn` 等），这是既有布局合同；它们不再拥有背景/文字色。
- 浅色主题的 MCP/供应商页已截图检查；未对每个二级页面单独跑 700×600，窄窗重点验证了信息页动作区。

## 11. 回滚

本轮只改视觉与共享样式组织，不触碰更新状态机、安装安全、供应商业务逻辑、Pi RPC、会话流程或数据写入。回滚方式：撤销本分支提交（或 `git revert` 本提交）并重新执行 `npm run build:app -- --rebuild`；无数据迁移、无配置变更、无新依赖。
