# PI-GUI UI Batch 02 验收报告

本批处理文件面板状态（P2-03）、字段对比度（P2-05），以及设置、MCP 和 Provider 的同类控件与反馈。依据为[全局设计规范](design-system.md)、[全项目审计](PI-GUI-UI-FULL-AUDIT.md)及[第一批验收](PI-GUI-UI-BATCH-01-acceptance.md)。

- 基线为 `origin/main` 的 `d9a2cf254593ac607dca99924f4ba009fdf7f0ed`，即 PR #82 的合并提交。[基线 push CI 的 8 项检查通过](https://github.com/HYJ1817/pi-gui/actions/runs/43585666720)。
- 分支为 `codex/ui-batch-02-components`。文件面板提交为 `e6d1ecca0b0c463d873dddfe4d574aa4b0663ffe`，控件提交为 `c4173b0f115d2c1bf11dab812ca15a36c53c9d8d`。报告提交可用 `git log -1 --format=%H -- docs/ui/PI-GUI-UI-BATCH-02-acceptance.md` 定位。

## 文件面板与状态语义

原实现以有无条目和工作区对象推断空态。初次请求失败时两个值都缺失，导致错误提示和「还没有打开项目」同时出现。现在由根请求结果确定状态，工作区身份仍由现有工作区和请求边界管理。读取失败时保留刷新操作和已知身份。根错误在面板顶部显示，子目录错误停留在出错的目录下。

| 状态 | 判定与反馈 |
| --- | --- |
| NoProject | 仅服务端明确返回 `noProject: true` 时显示未打开项目并清理旧选择。 |
| Loading | 根请求发出后显示正在读取，文件树标记 `aria-busy`。 |
| Empty | 根请求成功且列表无条目时显示目录为空。 |
| Error | 根请求失败时显示带 `alert` 的错误反馈，刷新仍可用。子目录错误有独立位置和反馈。 |
| Success | 成功时显示新条目。重试成功即清除旧错误，可继续打开只读预览。 |

Classic 和 Runtime 共用文件面板。切换项目和切换所聚焦的 Runtime 会话均复用既有通知重置读取。根请求编号、epoch、预览请求编号和目录状态对象的身份检查共同拒绝迟到响应。回归测试分别在修复前复现错误被误画为空状态和 Runtime 切换未重读，修复后通过。离线浏览器夹具记录两条入口的请求作用域，并验证加载、错误、空目录、文件列表、预览与无项目。

## 组件和反馈审查

| 项目 | 现状与处理 |
| --- | --- |
| Button | 普通 Provider 文本按钮从独立的 30px 高、12px 水平内边距和 6px 圆角，收敛到设置和 MCP 已用的 30px 基线、15px 水平内边距和 8px 圆角。复用主操作、禁用和焦点反馈，保留危险与 Ghost 变体、禁用原因提示，以及窄窗弹层的紧凑内边距。Provider 列表主入口仍用原有胶囊强调，MCP 窄窗工具栏保留图标缩排。 |
| IconButton | MCP 和 Provider 的普通图标按钮共享对齐、悬停、按下、禁用及焦点规则，采用 28×28 和 8px 圆角。旧 Provider 图标按钮为 26×26 和 4px 圆角。外壳自己的 26px 紧凑变体、MCP 删除色和忙碌动画继续由各自位置持有。 |
| Input | MCP 与 Provider 表单控件复用 32px 高、8px 圆角、10px 水平内边距和现有字段表面色的 `.ds-input`。Provider 模型表格继续用 28px 紧凑字段。普通 Provider 标签、提示和错误与实际输入关联，键盘聚焦使用一道主题轮廓。 |
| SearchInput | 设置、MCP 和 Provider 普通搜索共享 34px 外壳、8px 圆角、对齐和可读颜色。此前 MCP 普通搜索为 32px，Provider 搜索用 6px 圆角。Provider 双栏模型搜索保持原 28px 密度。搜索的单一焦点由 Batch 01 原有 `.ds-search-field` 持有，会话搜索继续原布局，Composer 模型选择器仅采用共同占位色。 |
| Loading / Empty / Error / Success | 文件错误就地展示。MCP 市场载入区增加 `aria-busy`，MCP 配置和市场请求失败保留原恢复动作并用警示图标与 `alert` 区分空态。MCP 空数据和搜索无结果继续使用既有分支。Provider 已有保存中禁用和 `aria-busy`、持久警示与确认成功反馈。设置保存结果沿用状态行。复用了现有反馈区域和语义色。 |

## 对比度与渲染证据

Windows Chrome 157.0.8103.78，DPR 1。通过 `tests/visual-harness.cjs` 和真实浏览器 CDP，分别在 1320×820 与 700×600 验证深浅主题。使用中英文会话、服务字段和文件内容。占位文字用 Chromium Canvas 合成绘制，从页面背景到目标输入逐层应用实际计算的颜色，再合成占位色与不透明度，并计算相对亮度。表中同类多字段报告范围，数值四舍五入到两位。

| 占位文字 | 深色旧 → 新 | 浅色旧 → 新 |
| --- | ---: | ---: |
| 设置搜索 | 5.70 → 9.58 | 5.93 → 6.85 |
| MCP 市场和配置搜索 | 3.49 → 8.26 | 2.19 → 6.85 |
| MCP 表单输入样本 | 未采集 → 7.44 | 未采集 → 6.85 |
| Provider 服务选择搜索 | 3.24 → 7.09 | 1.98 → 6.85 |
| Provider 配置及模型字段 | 3.08–3.57 → 6.52–9.06 | 1.98 → 6.85 |
| Composer 模型选择器搜索 | 4.22 → 9.58 | 3.94 → 6.60 |

全部测得的新占位文字超过 4.5:1。深浅窄窗补验了按钮悬停、按下、转换后的焦点和原生禁用状态。深浅两主题均验证了 Classic 和 Runtime Composer 的原有输入焦点，文件面板实际请求包含预期的会话作用域。

证据目录为 Windows 用户的 `%TEMP%/pi-gui-batch02-evidence`。运行 `node <证据目录>/chrome-probe.cjs <证据目录> final` 可复查最终矩阵。代表截图如下。

- `before-mcp-market-1320-light.png`、`final-mcp-market-1320-light.png`，市场搜索对比。
- `spot-final-mcp-config-700-dark.png`、`spot-final-mcp-form-700-light.png`，MCP 配置及表单。
- `final-provider-chooser-700-light.png`、`final-provider-fields-700-light.png`，Provider 搜索和字段。
- `focus-final-provider-button-focus-700-dark.png`，按钮焦点。
- `final-classic-files-error-700-dark.png`、`final-runtime-files-success-700-light.png`，文件读取错误及重试后的文件树。
- `final-classic-1320-dark.png`、`final-runtime-700-light.png`，两种 Composer 的输入焦点。

## 测试、复核和构建

以 `node tests/<套件>.cjs` 执行 13 个定向套件，退出码均为 0。

| 套件 | 结果 |
| --- | --- |
| `files-terminal-ui`、`files-terminal` | 92/92、113/113 |
| `settings-acceptance`、`primitives`、`theme` | 18/18、5 组、47/47 |
| `mcp-management-ui`、`mcp-market`、`provider-management-ui` | 31/31、72/72、77/77 |
| `ui3-composer`、`ui3-model`、`runtime-conversation`、`session-search` | 34/34、54/54、106/106、72/72 |
| `smoke` | 1345/1345 |

独立复核发现 Runtime 工作区作用域切换时的旧请求问题和危险按钮的悬停颜色变化，两处已修复。复核也验证了 Provider 禁用按钮的原生提示可达性、字段关联，以及 77 项 Provider 回归。无未解决的阻断项。

最终 Chrome 矩阵的首轮有三个入口等待超时。分别将模型按钮和 MCP 入口等待条件对齐到实际可用状态后，1320×820 浅色模型选择器、700×600 深色 MCP 配置和 700×600 浅色 MCP 表单补测通过。原始超时保留在 `final.json`，补测记录在 `spot-final.json`。

`npm run build:app -- --rebuild --output-root <独立输出目录>` 使用本机 Electron 44.4.3 缓存通过。证据目录中的 `build-final.log` 和 `build-final/dist-app/Pi GUI-win32-x64` 对应最终源码。包内 15 项改动的前端资源 SHA-256 与源码全部一致。总包 333.4 MB，`Pi GUI.exe` 的 SHA-256 为 `794b28abd035acc0fe1a2fa342d3fd976c60803534a673009b58a7a8e561b010`。

## 文件清单与回滚

- 文件状态和回归覆盖 `public/files-panel.js`、`public/ui4-pane.css`、`tests/files-terminal-ui.cjs`。
- 设置与公共输入样式覆盖 `public/index.html`、`public/styles.css`、`public/ui/primitives.css` 和 `public/ui3-model-picker.js`。
- MCP 控件和反馈覆盖 `public/mcp.css`、`public/mcp-settings.js`、`public/mcp-market.js`。
- Provider 控件覆盖 `public/provider-management.css` 及其模块目录内的 `advanced.js`、`connection-fields.js`、`dom.js`、`model-panes.js`、`service-chooser.js`。
- 第 17 个文件为本验收报告。

按需回滚时先回退报告提交，再按顺序回退 `c4173b0` 和 `e6d1ecc` 并重建应用。证据来自离线夹具，无真实用户数据需要恢复。

本批可进入人工验收。完整测试留给 PR CI，打包启动、真实 Pi、真实 Provider 和安装升级未在本批执行。控制按钮及状态反馈按代表场景验收，未对每个组合逐一截图。人工合并决定仍待确认。
