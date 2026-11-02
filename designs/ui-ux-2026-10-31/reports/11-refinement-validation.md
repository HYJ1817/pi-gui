# 统一修订版：变更与视觉验收记录

最新入口和批注后验证见 [13 浏览器批注修订](13-browser-comment-revision.md)。本文保留381项/84图这一轮历史记录；当前同一预览地址已经更新，不以本文旧布局说明覆盖用户后续决定。

日期：2026-11-01（Asia/Shanghai）。本轮根据 08/09 报告及用户“优化吧”修订设计成果。**状态：可操作原型与验收证据已提供，等待人工验收；没有开始生产实施。**

## 1. 访问与文件

- [新版验收页：实图、首轮对照和图库](http://127.0.0.1:8120/review-refined.html)
- [新版交互原型](http://127.0.0.1:8120/exports/refined/Refined.dc.html)
- [可编辑源画板](../canvas/project/Refined.dc.html) · [离线导出 ZIP](../exports/refined.zip) · [导出摘要](../exports/refined-manifest.json)
- [设计系统](../system/project/README.md) · [Tokens](../system/project/tokens.json)

双击目录内 `打开设计预览.cmd`，或运行：

```powershell
node designs/ui-ux-2026-10-31/tools/start-preview.cjs --open
```

当前机器的签名策略拒绝未签名 `.ps1`；新的双击入口直接运行 Node，启动本地隐藏预览辅助进程，保持系统执行策略不变。端口可用 `--port=8121` 调整。没有安装服务、计划任务或自启动。

启动复验：在8121新端口实际启动独立进程，验收页、原型和结果JSON均HTTP200；核对命令行身份后只关闭该测试辅助进程。8120预览继续运行。

## 2. 这次实际改了什么

| 对照问题 | 统一修订版 |
| --- | --- |
| Rail + 会话栏 + 全宽底栏，层级分散 | 一条264px侧栏，常用导航与会话集中；底部收纳设置、主题和演示标记 |
| 冷蓝底色与强边界 | 深色中性炭黑/灰，浅色白底/浅灰；灰阶选中，蓝色留给链接及聚焦 |
| 元信息和完整工具列表抢占正文 | 正文15/27，完成元信息在末尾；工具活动先摘要，用户可展开列表与详情 |
| 模型、思考与附属信息挤在左侧 | 附件和引擎在左，模型、等级与发送在右；模型菜单向上锚定右侧入口 |
| 设置保留会话栏又加分类栏 | 设置分类直接替换会话栏，搜索分类，返回恢复原会话 |
| 三条简化资源数据不足以判断布局 | Skills/Extensions/MCP/Capabilities分别有资源，保留来源、范围与独立状态；搜索、项目过滤、详情和加载反馈可操作 |
| 右栏内重复卡片与技术说明 | 统一面板标题/工具栏/内容层级，保留独立滚动与尺寸调整 |

资源均为明确的演示数据，不代表本机已安装列表。配置/授权等复杂操作继续作为已有业务入口示意，没有模拟真实凭据保存或文件写入。A/B 首轮源文件、DS 快照和 ZIP 保留，不能把新版检查数字套到旧方案。

## 3. 真实渲染和操作记录

命令：

```powershell
node designs/ui-ux-2026-10-31/tools/inspect-prototype.cjs
node designs/ui-ux-2026-10-31/tools/sync-design-system.mjs
node designs/ui-ux-2026-10-31/tools/refinement-ops.mjs export
node designs/ui-ux-2026-10-31/tools/verify-refinement.mjs
$env:DESIGN_VERIFY_OUT='verification-v2'
node designs/ui-ux-2026-10-31/system/project/verify-previews.cjs
node designs/ui-ux-2026-10-31/tools/check-refinement-delivery.mjs
```

使用现有 Electron Chromium 的真实布局与渲染；sandbox/contextIsolation 开启、nodeIntegration关闭，临时 profile，网络请求限制为本地地址。操作经 Chromium 输入事件，截图来自 `capturePage`，不是 HTML 拼图或 jsdom 布局推断。

| 证据 | 实际结果与身份 |
| --- | --- |
| 首次原型运行 | 377/377，84图；原始结果保存在 round1-results.json；该轮资源分类选中态尚缺视觉差异 |
| 修复后完整原型运行 | 381/381，失败0，84图；新增双主题资源选中背景与旧通知清除断言，未删除原有断言 |
| 组件预览 | 388/388，40图；新版输出 verification-v2，首轮 verification 保留 |
| 新配色对比度 | 78组按当前v2 Tokens重新计算，详见 Contrast-Checks 与 contrast-results.json；不继承v1值 |
| 独立审查 | 首轮 Important 1，修复后未解决 Blocker 0 / Important 0；独立静态复查，不冒充独立GUI运行 |

结果以 [当前原型记录](../evidence/refined/results.json)、[首轮记录](../evidence/refined/round1-results.json)、[组件记录](../system/project/verification-v2/results.json)、[对比度](../evidence/refined/contrast-results.json)和[交付检查](../evidence/refined/delivery-results.json)为准。各检查覆盖不同对象，不相加为“总通过数”。导出 sourceSha256 和 ZIP摘要用于绑定本轮文件。

交互覆盖：会话切换及行序坐标、独立草稿、任务往返滚动恢复、侧栏折叠、模型搜索/选择/空结果/Escape、思考等级、工具详情、停止中/已停止、跨会话操作身份、错误重试、菜单关闭、重命名Dialog焦点/Tab/Escape、页面标题焦点、资源搜索/范围/详情/加载、设置分类搜索、Enter偏好、Classic/Runtime附件差异、系统及主动减少动态。

## 4. 窗口与 DPI 证据

请求1280×800 / 1440×900 / 1920×1080；本机 Windows 与 Electron 取整后，实际 CSS viewport 为1280×801 / 1440×901 / 1920×1081，DPR1。125%与150%页面zoom在1440×900外壳中实际为1152×721与960×601，DPR1.25与1.5；逐图记录以JSON为准。

两种主题和三种窗口均覆盖：正常聊天、空会话、Agent运行、展开Thinking/工具详情、长会话滚动、Diff、Browser、错误。另有菜单、Dialog、设置各分类、资源和缩放截图。页面zoom不等于获得所有 Windows 物理屏幕缩放资格。

## 5. 实图目视检查与迭代

作者实际打开并查看新版设置、资源、模型菜单、1280 Diff、1920空态及150%缩放等图；结合完整矩阵总览检查双主题和三尺寸。确认侧栏/主区/面板分界、输入区可见性、正文阅读带、浮层边界和独立滚动；不以断言通过替代观感判断。

双主题关键状态总览：[深色](../evidence/refined/dark-overview.jpg) / [浅色](../evidence/refined/light-overview.jpg)。字体另通过 Chromium platform fonts 核对：正文与输入区实际使用本机 Segoe UI Variable 和 Microsoft YaHei UI，非自定义网络字体；[最终独立渲染/字体记录](../evidence/refined/final-font-smoke.json)。

| 观察到的问题 | 处置及复验 |
| --- | --- |
| 通用按钮字体继承压过局部字号 | 降低基础继承选择器优先级，组件字号恢复；重新导出与实图检查 |
| 设置导航离开后焦点没有新目的地 | 进入次级页面聚焦其标题，返回会话仍恢复输入/滚动 |
| 资源分类只有aria-pressed，没有灰阶选中 | 补明确选中样式，双主题比较computedStyle，实图确认 |
| 资源页残留上一次停止提示 | 页面和会话切换清除非关键Toast；阻断错误仍属于内容区 |
| 正文实现15/27，首轮Tokens仍14/24 | 同步Tokens、生成CSS、组件规范；正文和ChatMessage消费同一变量 |
| 部分面板尺寸Token仍为首轮值 | 同步320–560预算、1100/800断点；既有A/B快照保留 |

关键截图（点击查看原图）：

| 页面/状态 | 深色 | 浅色 |
| --- | --- | --- |
| 正常聊天 | [1440聊天](../evidence/refined/dark-1440-chat.png) | [1440聊天](../evidence/refined/light-1440-chat.png) |
| 空会话 | [1920空态](../evidence/refined/dark-1920-empty.png) | [1920空态](../evidence/refined/light-1920-empty.png) |
| Agent与工具 | [1280运行](../evidence/refined/dark-1280-running.png) / [工具展开](../evidence/refined/dark-1280-tools.png) | [运行](../evidence/refined/light-1280-running.png) / [工具展开](../evidence/refined/light-1280-tools.png) |
| 长会话 | [1920滚动](../evidence/refined/dark-1920-long.png) | [1920滚动](../evidence/refined/light-1920-long.png) |
| Diff | [1280面板](../evidence/refined/dark-1280-changes.png) | [1280面板](../evidence/refined/light-1280-changes.png) |
| Browser | [1440面板](../evidence/refined/dark-1440-browser.png) | [1440面板](../evidence/refined/light-1440-browser.png) |
| 模型菜单 | [1440菜单](../evidence/refined/dark-1440-model.png) | [1440菜单](../evidence/refined/light-1440-model.png) |
| 菜单/Dialog | [菜单](../evidence/refined/dark-1440-menu.png) / [重命名](../evidence/refined/dark-1440-dialog.png) | [菜单](../evidence/refined/light-1440-menu.png) / [重命名](../evidence/refined/light-1440-dialog.png) |
| 设置 | [常规](../evidence/refined/dark-1440-settings.png) / [模型](../evidence/refined/dark-1440-settings-models.png) | [常规](../evidence/refined/light-1440-settings.png) / [模型](../evidence/refined/light-1440-settings-models.png) |
| 资源 | [列表](../evidence/refined/dark-1440-resources.png) / [加载](../evidence/refined/dark-1440-resource-loading.png) | [列表](../evidence/refined/light-1440-resources.png) / [加载](../evidence/refined/light-1440-resource-loading.png) |
| 错误 | [1440内联错误](../evidence/refined/dark-1440-error.png) | [1440内联错误](../evidence/refined/light-1440-error.png) |
| 150%zoom | [模型](../evidence/refined/dark-zoom-1.5-model.png) / [面板](../evidence/refined/dark-zoom-1.5-changes.png) | [模型](../evidence/refined/light-zoom-1.5-model.png) / [面板](../evidence/refined/light-zoom-1.5-changes.png) |

总览和首轮对照在 review-refined.html；页面参数与原图像素值均保存在结果JSON。画布编辑器的上游runtime仍有 tabindex/tabIndex提示；最终原型运行记录保留console原文，未将编辑器警告当作产品错误或伪装为零日志。

完整结果的driver console累积了初次导出时因“画布/聚焦视图”按钮选择器不同而产生的一条null.click错误；该导出选择器已修正，历史未抹除。最终另外新建临时profile重新加载原型，字体/渲染记录只保留上游tabindex警告，没有该异常。验收页真实渲染确认381/381、图片已载入24张、损坏0；见 [验收页截图](../evidence/refined/review-portal.png)。

## 6. 功能映射与下一阶段约束

原有 [F01–F60映射](05-feature-map.md)继续有效：会话类在单侧栏及其菜单；任务/审阅、资源在侧栏；设置在底部且进入后替换分类；Changes/Browser在顶栏；Specs/协同/开发进程在工作工具菜单；历史与分支在会话菜单及正文入口。原型未实现的高级流程保留“仅入口映射”身份，不能声称已完成全部业务。

实施计划仍见 [06计划](06-implementation-plan.md)，视觉基线应从首轮A改为本次Refined；第一阶段先抽取统一组件/Tokens及外壳，不变更state owner、接口或数据模型。其余安全/Runtime/Browser/更新验收不因本次设计检查而省略。本轮没有执行该计划。

## 7. 限制与停止点

尚未验证真实模型E2E、实体中文IME、读屏器、原生Browser attach/detach与遮挡、真实供应商配置、安装升级及全部物理DPI。浏览器只是本地页面示意，Diff是合成数据；资源搜索仅作用于演示列表。

没有运行生产完整 `npm test` 或重建应用：生产文件、接口、模型和依赖没有改动，设计检查不能替代canonical。工作区仍有用户原有未跟踪治理计划，本轮未改。没有提交、推送、合并或发版。

回滚：继续打开首轮 A/B；Refined、system v2及对应导出/证据独立可定位，首轮Token与README快照在 revisions/2026-11-01。当前停在人工设计验收，不进入生产实施。
