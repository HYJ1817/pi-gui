> 第三轮归档（2026-11-06）：本页移除的历史矩阵/完整输出使用固定提交 `ff6f22e26caae540cd050cbcd89c78f84c1e05cb` 追溯；保留的JSON记录反映当次捕获全集，图片路径可在该提交解析，不能作为最新代码通过证明。当前代表图及验证见[清理报告](../../repository-cleanup-report.md)。

> 2026-11-06 第二轮瘦身：本页移除的历史截图/完整日志链接固定到清理前提交 `2e70463183218ddf3a10972789667d6be5c294df`；原始结果和失败记录保留，不能作为当前代码通过证明。

# 阶段 E：右侧工作台验收记录

## 身份、范围与状态

分支 `codex/pi-desktop-phase-e`，从 main `31b4c4f8ee3165064f710ea6c535a89816478814` 创建。开发前已核验 main push CI [41897138436](https://github.com/HYJ1817/pi-gui/actions/runs/41897138436)，attempt 1，准确 head 为该基线，completed/success。它只证明基线，不作为 E 新代码 CI。

生产与回归提交 `50fc818`，Electron 工具提交 `ddf2413b8121acc0cc6e3898059ecedc4fe7a455`。固定参考 `vastsa/PI-Desktop@92ae661f1e399e69d514086b46029b4c34ba1a92`。完整勘察与计划见 [16](16-phase-e-implementation.md)。本轮仅做 E，不更改 Pi RPC、后端、文件权限、会话 schema、模型调用、依赖或版本，不提前开展 F。

用户明确要求不使用子代理，本轮没有调用子代理。独立 Agent 审查未运行；作者自查、自动化、用户验收分别记录，不以测试或截图代替独立审查。一次完整 canonical 已完成，用户验收待进行。未推送、建 PR、合并或发布。

## 修改文件与所有权

| 文件 | 变化与边界 |
| --- | --- |
| `public/index.html` | 既有工具导航合入 `rp-titlebar`，增加可滚动工具带及真实的返回工具列表按钮；原入口 ID 保留 |
| `public/app.js` | 只做 launcher 挂载/释放及事件接线；各工具同步选中状态后滚动到当前项，不存第二份导航状态 |
| `public/ui/work-panel-launcher.js` | 新展示 leaf：安全文本、复制既有可信图标、委托原按钮、同步 hidden/disabled，离开时断开观察器并解除事件 |
| `public/ui4-pane.css` | 改既有右栏样式，使用 A 语义变量；46px 工具带、28px 控件、无外壳分割线、真实 caption 区域避让；保留业务操作换行、提示与语义状态 |
| `public/specs-panel.js`、`public/specs.css` | 原空态增加装饰图标与 38/18px 几何，复用原状态、文本和 Markdown；未添加文件创建权限 |
| `tests/ui4-integration.cjs` | canonical 原套件增加 1 个真实模块用例，包含委托/焦点/能力变化/安全文本/释放断言 |
| `tests/app-shell-electron.cjs`、`tests/workbench-electron.cjs`、`tests/fixtures/workbench-scenarios.cjs` | 扩展既有正常沙箱工具；使用生产 Browser controller，真实输入前核对文档焦点，保留 A/B/C/D |
| `package.json` | 注册独立桌面专项 `test:workbench:electron`，canonical 集合保持 234 条；没有更改依赖 |
| 当前功能说明、08/README/16/17、截图/JSON | 源码依据、测试身份、逐区域差异及交付状态 |

`right-pane.js`、`secondary-surface.js`、`split-workbench.js`、Browser 原生控制器与所有业务 owner 未改。宽度仍为默认 392px / 下限 320px；它与参考图可变宽度不同，保留用户宽度记忆及既有可用空间判定。焦点、分屏比例、低高度/窄窗回退、Browser 所属 session 与释放沿用原路径。

最终 11 个行为/测试/脚本文件摘要见 [validated-source-sha256.json](../screenshots/phase-e/validated-source-sha256.json)。

## 逐区域源码及视觉对照

参考路径以 `apps/desktop/src/` 为根；pi-GUI 路径以 `public/` 为根。
表中的 `WorkPanel.tsx`、`WorkTabEmpty.tsx`、`FilesTab.tsx`、`ReviewTab.tsx`、`PluginViewTab.tsx` 均在 `components/workpanel/`。

| 区域 / 原图 | 固定参考源码 | pi-GUI 实现与修改后结果 | 分类 |
| --- | --- | --- | --- |
| Dock / REF-003/018/019 | `styles/work-panel.css:8–24`、`WorkPanel.tsx` | `ui4-pane.css` 使用 `--ds-bg-dock`，外壳左边框 0；原宽度、拖拽和双击复位保留 | 核心面与边界达到；宽度保留业务差异 |
| 标题/工具带 / REF-003/019 | `work-panel.css:134–281`、`chrome.css:739` | `index.html#workPanelNav` 代替原空白带，实测顶部 y=0、高 46px，28px 按钮；选中标签 92–180px，可横向滚动。caption 预留按实际 CSS env 计算，拖拽矩形和点击目标均不覆盖原生窗口按钮 | 尺寸/连续性达到；固定工具导航区别于任意多标签 |
| 新建列表 / REF-003 | `components/workpanel/WorkPanel.tsx:1149–1184`、`work-panel.css:504–589` | 原说明文字改为真实工具列表：14/10px 内距、40px 行、18px 图标、10px 行内间隔。五个入口来源于既有按钮，能力缺失时隐藏，不伪造文件管理器 | 达到列表结构和核心参数；内容为 pi-GUI 实际工具 |
| Specs 空态 / REF-019 的空文档区域，规范源码 | `WorkTabEmpty.tsx`、`work-panel.css:464–502` | 原 `renderEmpty` 保留；居中 38px 圆形面、18px 图标、6px 间隔、28/24px 留白、15px 标题、34ch 说明上限 | 参数达到；没有同场景的原始 Specs 截图，不冒称逐像素对照 |
| Specs 树与正文 / REF-019 | `FilesTab.tsx`、文件树/预览相关样式 | 原 Specs 文档树、目录展开、文档切换、独立滚动与 Markdown 保留；有文件名、大小及读取路径的真实交互。pi-GUI 采用上下布局，参考 Files 为左右树/项目搜索 | 合理业务与布局差异，未宣称复刻任意文件管理器 |
| Changes / REF-019 相关工作台框架 | `WorkPanel.tsx`、`ReviewTab` 对应实现 | 原 Changes/status/Diff/审阅/刷新仍在业务面，选中状态留在原 owner；复杂文本按钮可换行，保留 Diff 色与安全提示 | 外壳达到；业务命令条高度及内容不同 |
| 分屏 / REF-018/019 | 参考多工作区承载；pi-GUI 对应真实能力不同 | 原 Specs/Browser + Changes 两面分屏、比例、回退页签与原节点保留；只调整其表面/控件尺寸，无新增分屏状态 | 业务差异，交互实测保留 |
| Browser / REF-018 | `PluginViewTab.tsx`、`WorkPanel.tsx` 及原生视图承载 | 完整应用使用真实 WebContentsView，合并头部后 viewport 与原生 DIP 几何一致；单独专项验证分屏、真实页面输入、缩放、20 次切换/关闭、双 Runtime 隔离 | 原生交互通过；保留 Agent 控制与分屏入口，未假装参考全部功能相同 |
| 深浅与窄窗 / REF-003/018/019 | A 主题 token 与 `work-panel.css` | 同一套语义变量；700×600 下沿用 overlay 与 fallback，选中、关闭、返回入口可达；保留原生 Browser 内容自身主题 | 已验本机；浅色以源码规范对照，参考三图为深色 |
| A/B/C/D | 当前已验收设置、Shell、Sidebar、Conversation | 同一正常沙箱进程重新跑原有场景，包含主题/设置、折叠、菜单、顺序、流式、复制、用量、模型/命令与窄窗 | 回归通过，不重开业务设计 |

颜色差异明确保留：工具标题带用现有 `--ds-bg-primary` 与 Electron 原生窗口按钮连续，Dock 正文用 `--ds-bg-dock`；参考顶部随 Dock 本身同色。Browser 原生内容不由 renderer 的主题样式重绘，浅色应用内的空白原生区域仍遵循原控制器背景。REF-018 的居中“尚未打开页面”提示未实现，当前原生空视图保留原控制器行为；既有 Agent 控制状态另占一行，导致页面起点比参考更低。这些差异保留在 Browser 的业务与原生视图边界，不计作已还原。没有为截图改变页面颜色、删除 Agent 状态条或复制窗口控制系统。

## 实际 Electron 图与尺度

[results.json](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/screenshots/phase-e/results.json)：**71/71，正常沙箱，51 张 renderer + 5 张原生整窗图**。其中 E 有 18 张 renderer 与 3 张原生整窗；其余为 A/B/C/D 新采回归图。Electron 44.4.3，sandbox/contextIsolation 开启、nodeIntegration 关闭。E CSS 1205×803、DPR 1.5，PNG 1808×1205；窄窗 700×600 / 1050×900。继承 C 场景的部分尺寸为 1206×803 或 700×650，按每张 geometry 区分，原生整窗含 DWM，不能混算。

原图尺寸和摘要见 [reference-calibration.json](../screenshots/phase-e/reference-calibration.json)；1.5 DPR 来自已提供的校准条件，不冒称重新探测参考系统。

| 图片 | 场景 |
| --- | --- |
| [e01](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e01-launcher-dark.png)、[原生整窗](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e01-launcher-dark-native.png)、[e16](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e16-launcher-collapsed-dark.png) | 深色 launcher、实际窗口按钮、侧栏折叠，REF-003 |
| [e06](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e06-launcher-light.png)、[原生整窗](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e06-launcher-light-native.png) | 浅色 launcher |
| [e02](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e02-specs-dark.png)、[e08](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e08-specs-light.png)、[e07](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e07-specs-empty-light.png) | Specs 深浅/空态 |
| [e03](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e03-split-dark.png)、[e09](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e09-narrow-fallback-light.png)、[e10](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e10-narrow-changes-light.png) | 分屏与窄窗回退 |
| [e04](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e04-changes-dark.png)、[e05](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e05-changes-light.png) | Changes 深浅 |
| [e11](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e11-narrow-launcher-light.png)、[e12](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e12-resized-launcher-light.png)、[e13](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e13-resized-launcher-dark.png) | 窄窗与真实宽度调整 |
| [e14](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e14-browser-dark.png)、[原生整窗](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e14-browser-dark-native.png)、[e15](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e15-browser-light.png) | 完整应用真实 Browser，REF-018 |
| [e17](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e17-branch-dialog-dark.png)、[e18](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/e18-collab-surface-dark.png) | 既有分支 Modal 与 Collab 的真实可用性提示，不冒称验证完整协同画布 |
| [设置深色](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/09-settings-overview-dark.png)、[设置浅色](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-e/12-settings-appearance-light.png) | A/B 回归；D 的 d01–d19 同目录 |

另有 [Browser 专项结果](../screenshots/phase-e-browser/results.json) 与独立 renderer/native-page 捕获，未合成页面。原工具记录 22 次捕获，其中返回 A 时使用同名路径，实际保留 20 个唯一 PNG，不能计作 22 张独立图片。它用生产 controller 与 TEMP Git、loopback 页面及两份真实隔离 Runtime Browser session；不证明真实 Pi/模型、供应商或远端网站资格。

## 自动化及失败历史

| 验证 | 实际结果 |
| --- | --- |
| `node tests/ui4-integration.cjs` | 56/56，原 55，新增真实 launcher 综合用例 1，未删除断言 |
| `node tests/split-workbench-ui.cjs` | 30/30 |
| `node tests/browser-workbench-ui.cjs` | 14/14 |
| `node tests/specs-ui.cjs` | 25/25 |
| `node tests/settings-acceptance.cjs` | 15/15 |
| `node tests/app-shell.cjs` | 10/10 |
| `npm run test:diff-comments` | 退出 0；七套件分别 51/51、51/51、10/10、29/29、22/22、25/25、36/36 |
| `npm run test:ui3` | 最终状态 243/243，0 跳过，正常沙箱；[结果](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/screenshots/phase-e/ui3-integration-results.json) |
| `node tests/browser-workbench-electron.cjs` | 64/64，正常沙箱，真实原生视图、loopback 页面与 TEMP Worktree |
| `npm run test:workbench:electron` | 最终 71/71，正常沙箱；无 renderer 崩溃，包含原 C/D 与 E 场景 |
| `npm test` 完整 canonical | 一次连续执行退出 0，4841.422 秒；冻结行为/测试提交 `ddf2413`，由当前 package 及生命周期入口展开的 234 条唯一命令全部执行结束；[记录](../screenshots/phase-e/canonical-results.json) |

完整入口于 2026-11-05 16:47:43–18:08:25（UTC+8）运行。展开清单、清单摘要、日志 SHA-256、准确开始/结束时间及最终 11/11 文件摘要不变证明均在上述记录中；234 是命令数，不是断言数，也不是分段重跑累计。仅在测试子进程设置 `PSExecutionPolicyPreference=Bypass`，未提权或修改持久策略。

本机权限相关未验项目单列：Collab store、Candidate adoption、logging-leaks 各跳过 1 个符号链接场景；会话搜索的 5i 因无法创建符号链接未验；`session-revert-sacl-witness` 为 0/0、跳过 8；`session-revert-inplace` 为 28/28、跳过 2 个非空 SACL 场景；`Object witness` 为 0/0、跳过 8。这些跳过不计入断言通过数，两个 0/0 witness 不代表审计资格通过。

失败均保留：

1. 基线 `ui4-pane.cjs` 在 E 任何改动前失败：期待 420px，生产已为 392px；鼠标点击被隐藏右栏中的 `navChanges` 后等待超时。此旧独立专项的入口/预期已过期，不改生产去迎合它，也未将它标为通过。本轮以当前生产入口的正常沙箱 71 项和原生 Browser 64 项覆盖 E 相关边界；旧专项仍需后续单独适配。
2. launcher 新生产模块回归先为 55/56（模块尚不存在），实现后 56/56。
3. 首轮整窗图发现选中 Browser 标签右端被截断，新增真实几何检查为 67/68；在各 owner 完成选中类更新后，仅滚动工具条，最终该断言通过。不更改 nav 的状态 owner。
4. 一次中途复跑中，D 复制场景显示真实“复制失败”反馈并超时，28/29。保留日志和失败截图；输入工具增加 `win.focus`、`webContents.focus` 及 `document.hasFocus()` 前提后整套 71/71，未改生产剪贴板代码，也未证实当次系统拒绝的更细原因。未把这次失败消除成首次全绿。

原始日志位于本机 TEMP `pi-gui-phase-e-5be034af7c824cf2a09938c0464ed805`；早期失败截图已移入该目录保存，最终截图目录以最终 results 引用为准。不会重写之前 A/B/C/D 的历史证据目录。

定向命令、实际数量与日志摘要见 [directed-verification.json](../screenshots/phase-e/directed-verification.json)；56 张主验收图片的身份见 [screenshot-manifest.json](../screenshots/phase-e/screenshot-manifest.json)。图片摘要只绑定证据，不把图存在或摘要相同等同于视觉符合。

## 构建、审查与剩余事项

已离线重建 `.shots/phase-e-final-output-20261105/dist-app/Pi GUI-win32-x64/Pi GUI.exe`，入口 234.9MB，整包 329.3MB。6 个修改的生产文件与包内 SHA-256 全部匹配，见 [build-verification.json](../screenshots/phase-e/build-verification.json)。源码 Electron 与包内文件核对分开，不冒称完成安装/升级或打包 GUI 验收。

作者风险判断为中：前端布局、只读工具入口委托与展示观察器。已自查全部增量、作用域、释放与文本安全；已发现的标签截断已修复。作者自查剩余 Blocker 0、Important 0，Pre-existing 1（旧 `ui4-pane` 夹具）；这不是独立审查通过意见。完整 canonical 已完成；独立审查未运行，用户验收待进行。没有新增依赖、全局配色或大批 `!important`，没有移除已有功能。

未验证：macOS/Linux、真实 OS IME、真实 Pi/模型长负载、完整协同画布在本轮 E 窗口的人工交互、安装升级及发布。浅色原生网页内容不以应用主题自动重绘，这是现有 Browser 边界。独立桌面旧 `ui4-pane` 的过期夹具问题保留为 Pre-existing。

回滚行为按 `git revert ddf2413 50fc818` 后重建，并同步恢复或修订 `docs/work-surfaces.md` 等当前功能说明；历史验收报告与证据可以保留并标注已回滚。没有数据迁移或用户文件写入，因此不需要恢复项目文件。后续 F 可继续统一剩余视觉细节，但不能把本轮保留的真实业务入口、原生 Browser 权限或状态 owner 改为截图模型。

当前结论：E 实现、作者自查、定向验证、一次完整 canonical 与重建完成，未处理的本轮新增阻断项为 0；用户验收待进行，合并及发布未获本轮许可。
