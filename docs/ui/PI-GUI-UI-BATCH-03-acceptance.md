# PI-GUI UI Batch 03 验收报告

基线为 `main` 的 `0f7a554afc020d92404cb5f331d56deae32c02d6`，即 [PR #83](https://github.com/HYJ1817/pi-gui/pull/83) 的合并提交。开发分支为 `codex/ui-batch-03-content`。文件预览提交为 `f4ac3f1c2fe3aea3c2654402b7373554f9487494`，页面和回归测试提交为 `f3a8050a8df885530f91a347c45863af5b5b5fcf`，Electron 夹具验收修正为 `49d9d32088a3257566ef08ff719ffc68a3121fe8`。报告提交可用 `git log -1 --format=%H -- docs/ui/PI-GUI-UI-BATCH-03-acceptance.md` 查询。

依据为[全局设计规范](design-system.md)、[全项目审计](PI-GUI-UI-FULL-AUDIT.md)、[第一批验收](PI-GUI-UI-BATCH-01-acceptance.md)和[第二批验收](PI-GUI-UI-BATCH-02-acceptance.md)。

## 六项整改

| 项目 | 变化和实测 |
| --- | --- |
| P2-04 外观 | 移除标题下的通用描述和初始状态区的系统主题说明。主题帮助补上「跟随系统」的行为，保留三个控件及正在保存、成功和失败反馈。四组视口的外观容器仍为 744px 或 524px，初始说明少两处。 |
| P2-06 Provider 操作 | 设置页顶部保留一处「添加服务」，目录区保留一处「重载 pi 配置」。旧空状态有三处添加、两处重载，现为各一处。0、1、2 个服务均有入口。独立 Provider 模态框保留关闭，添加及编辑弹窗保留保存、取消和回焦。重载使用应用原有的二次确认，取消不会请求后端，确认后防重复执行，成功和失败继续显示原有反馈。 |
| P3-01 协同文档 | 顶部副标题显示实际文档名。版本和已保存状态只在面板状态区显示，画布状态区保留节点、连线和只读。快捷键放进标题旁的共享帮助浮层。鼠标点击、Enter、Space 和 Escape 回焦均已验证。700×600 下浮层全文可见，画布和工具栏可见。离线夹具整体滚动高度在宽屏减少 77px、窄屏减少 78px，画布尺寸保持原值。 |
| P3-02 Provider 文案 | 设置页移除配置文件路径，保留 API Key 输入边界以及安全输入窗口、环境变量的说明。验证了窄窗换行和长中英文服务名。 |
| B02-F01 文件预览 | 沿用刷新时清除旧预览的现有策略。文件列表读取失败时，预览区解释为何不可用以及如何恢复。成功刷新后可重新选择和预览。用同工作区失败、项目切换、Classic 到 Runtime 和反向切换验证迟到响应不能重画预览。 |
| B02-F02 无障碍 | 生产 `field()` 原语通过新增专项断言。验证标签控制关联、原有说明保留、提示和错误 ID 指向实际节点、禁用、错误替换和清除、同屏 ID 唯一性。字段原语无需修改。 |

## 实际渲染与失败记录

Windows Chrome 157.0.8103.78，DPR 1，使用项目视觉夹具和 CDP 实际键鼠输入。基线使用同一代码基线归档的 `public/`。1320×820 和 700×600 各测深浅主题，基线和最终版本分别完成 16 个组合。实测覆盖外观设置和公共帮助、Provider 首页和添加模态框、协同画布及保存状态、文件预览及错误恢复。夹具包含中英文名称。重载的请求接收和失败为离线响应。

证据目录为 `%TEMP%/pi-gui-batch03-evidence`。`before.json`、`final-source.json` 记录测量和截图，`chrome-probe.cjs` 可重跑检查。

- `before-appearance-1320-dark.png` 和 `final-source-appearance-1320-dark.png`，外观页面前后。
- `final-source-appearance-help-700-light.png` 和 `final-source-appearance-error-700-dark.png`，帮助及保存失败。
- `final-source-provider-empty-700-light.png`、`final-source-provider-count-2-700-dark.png` 和 `final-source-provider-dialog-700-light.png`，空列表、多服务和添加表单。
- `final-source-provider-reload-confirm-700-dark.png` 和 `final-source-provider-reload-error-700-light.png`，重载确认及请求失败。
- `before-collab-700-light.png`、`final-source-collab-help-700-light.png` 和 `final-source-collab-error-700-dark.png`，协同画布前后、帮助及保存失败。
- `final-source-files-error-700-dark.png` 和 `final-source-files-recovered-700-light.png`，文件面板失败与重试恢复。
- `states-appearance-saving-700-light.png`、`states-collab-after-save-700-dark.png`，延迟响应下的保存中和保存确认。补测记录在 `states.json`。

新增设置和文件回归在修复前分别因重复的三个添加按钮和失败后仍提示选择文件而失败。首轮 Chrome 在两个窄窗 Provider 场景未点中已滚动的重载按钮，改用实际键盘聚焦和激活后复验通过，首次记录保留于 `final.json`。独立复核发现窄面板的通用 CSS 会隐藏协同文档名，已加作用域内覆盖并复验。

## 定向测试与产物

使用 `node tests/<套件>.cjs` 运行以下 17 个定向套件。

| 套件 | 结果 |
| --- | --- |
| `settings-acceptance`、`provider-management-ui`、`files-terminal-ui` | 18/18、79/79、95/95 |
| `collab-panel`、`collab-canvas`、`collab-panel-productivity`、`collab-panel-agent` | 12/12、72/72、14/14、9/9 |
| `collab-advanced-editing`、`collab-stability` | 89/89、4/4 |
| `theme`、`primitives`、`runtime-conversation`、`bridge-state-recovery` | 47/47、5 组、106/106、55/55 |
| `ui3-model`、`ui3-composer`、`mcp-management-ui`、`smoke` | 54/54、34/34、31/31、1345/1345 |

源码 Electron 主壳 26/26。使用 `FINAL_REMEDIATION_ACCEPTANCE=1` 的定向场景 53/53，通过服务选择、键盘保存和成功后的列表更新。早期运行有三个夹具断言失配，分别等待旧 Provider 工具栏、要求服务未选定时显示保存，以及文件根错误时仍要求显示只读占位。已按页面实际阶段修正。工作台扩展场景在基线和本分支均为 33/34，均在终端 xterm 挂载超时。原始日志为 `electron.log`、`electron-retry.log`、`electron-provider.log`，最终结果见 `electron-provider-final.log`、`electron-baseline-workbench.log` 和 `electron-workbench-final.log`。

应用使用 `npm run build:app -- --rebuild --output-root <独立目录>` 和现有 Electron 44.4.3 缓存完成重建。总包 333.4 MB，包内 11 个改动的前端资源与源码 SHA-256 一致。产物在证据目录 `build-final/dist-app/Pi GUI-win32-x64`，日志在 `build-final.log`。

## 文件与回滚

- 外观和 Provider 页面改动涉及 `public/settings.js`、`public/providers.js`、`public/app.js`、`public/styles.css`。
- 协同文档及共享帮助改动涉及 `public/collab-panel.js`、`public/collab-canvas.js`、`public/collab-panel.css`、`public/collab.css`、`public/ui/popover.js` 和 `public/ui/primitives.css`。
- 文件状态改动位于 `public/files-panel.js`。
- 回归测试涉及 `tests/settings-acceptance.cjs`、`tests/provider-management-ui.cjs`、`tests/files-terminal-ui.cjs`、`tests/collab-panel.cjs`、`tests/app-shell-electron.cjs`、`tests/fixtures/final-remediation-scenarios.cjs`、`tests/fixtures/workbench-scenarios.cjs`。
- 第 19 个文件为本报告。

若回滚，依次回退报告提交、`49d9d32`、`f3a8050` 和 `f4ac3f1`，再用同一命令重建应用。无数据迁移。

本批可进入人工验收。完整 `npm test` 交由 PR CI。打包应用启动、实际 Provider 服务和安装升级未经验证。
