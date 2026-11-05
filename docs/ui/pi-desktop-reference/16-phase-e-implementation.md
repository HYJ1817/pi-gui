# 阶段 E：右侧工作台实施计划与源码勘察

基线 `31b4c4f8ee3165064f710ea6c535a89816478814`，分支 `codex/pi-desktop-phase-e`。基线 main push CI run `41897138436` / attempt 1 / completed-success 已核对；参考仍固定为 `92ae661f1e399e69d514086b46029b4c34ba1a92`。

按 writing-plans 与 executing-plans 单代理执行，用户禁止使用子代理；设计方向沿用既有规范与原始截图，不重复发起设计审批。只做 E，本轮不推送、合并或发版。

## 已有能力与取舍

- `right-pane.js` 已拥有 392px 默认宽度、320px 下限、宽度记忆、dock/overlay、焦点返回、实际 viewport 测量和 Browser 遮挡。保留这些 owner 与边界。
- `secondary-surface.js` 已有唯一实例、异步失效与 disposer；`split-workbench.js` 已有 Specs/Browser + Changes 分屏、比例记忆及低宽/低高度回退。继续复用。
- `index.html#workPanelNav` 与 `app.js` 已有分支树、Changes、Specs、Collab、Browser 实际入口。不是任意多标签模型，不伪造独立标签关闭、重排或最大化按钮。
- 原空白 46px `rp-titlebar` 加工具导航重复占高；以可横向滚动的 46px 工具带替代，控件 28px，并给原生窗口按钮留实际区域。保留业务内部命令条，复杂 Changes 操作允许换行。
- REF-003 实际对应 `WorkPanel.tsx:1149–1184` 的 launcher；不是 `WorkTabEmpty`。按 `work-panel.css:504–589` 的 14/10px 内距、40px 工具行、18px 图标制作列表，委托既有按钮，不另存能力或导航状态。
- `WorkTabEmpty.tsx` 与 `work-panel.css:464–502` 用于真正的工具空态。Specs 已有 `renderEmpty`，只补 38px / 18px 装饰图标及布局，不再造一份空态系统。
- REF-019 文件管理器具有 pi-GUI 未提供的任意文件 CRUD、全局搜索；本轮保留 Specs 的真实只读文档树与 Changes 审阅，明确业务差异，不扩展文件权限。
- 深浅色使用 A 阶段 `--ds-bg-dock`、`--ds-bg-primary`、`--ds-bg-hover`、`--ds-focus` 等语义变量。标题栏与当前 Electron 原生按钮保持连续，Browser 内容保留原生渲染与权限 owner。

## 实施步骤

- [x] 核对远端、main 精确 SHA CI、规范、固定参考源码及 REF-003/018/019。
- [x] 运行初始定向基线；旧 `ui4-pane` 在 E 改动前已出现 420/392 参数及隐藏入口点击失败，保留日志，不作为 E 引入缺陷。
- [x] 在既有 canonical `ui4-integration.cjs` 中添加生产 launcher 委托、可用性同步、安全文本与释放回归，55/56 失败后 56/56 通过。
- [x] 修改现有右栏 CSS/HTML、最小 app 接线和 Specs 空态。新 leaf 仅处理 launcher 展示及资源释放，不接触业务 owner。
- [x] 扩展原正常沙箱 Electron 工具，71/71，51 张 renderer + 5 张原生整窗图；真实 Browser 分屏/遮挡专项 64/64，UI3 243/243。
- [x] 功能稳定后完成一次完整 `npm test`，234 条唯一命令，退出 0，4841.422 秒；明确符号链接/SACL 跳过。重建独立产物，包内改动文件摘要 6/6 匹配，11 个行为/测试输入摘要不变。
- [x] 作者自查完成，独立审查未运行；交付 [17 验收报告](17-phase-e-acceptance.md)、源码对应、实际截图、视觉差异、风险与回滚，等待用户验收。

## 修改边界与测试

生产：`ui4-pane.css`、`index.html`、`app.js`、`ui/work-panel-launcher.js`、`specs-panel.js`、`specs.css`。`right-pane` / `split-workbench` / Browser 原生控制器保留实现。

定向：`split-workbench-ui.cjs`、`browser-workbench-ui.cjs`、`specs-ui.cjs`、`ui4-integration.cjs`、`settings-acceptance.cjs`、`app-shell.cjs` 及受影响的 UI3/对话 Electron。真实 Browser 使用既有 `browser-workbench-electron.cjs`，截图不替代 native 边界断言。测试数据与 userData 均在 TEMP；不调用真实 Pi 或模型。
