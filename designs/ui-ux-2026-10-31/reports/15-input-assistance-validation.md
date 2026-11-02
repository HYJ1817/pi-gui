# Slash 命令与上下文详情原型

日期：2026-11-01。依据用户“先把这俩已有的加上”，仅在 Refined 设计原型补充 **行内Slash菜单、上下文详情**。没有添加@引用，没有修改生产文件、接口、数据模型或依赖；未提交、推送或开始生产实施。

## 如何体验

[打开原型](http://127.0.0.1:8120/exports/refined/Refined.dc.html?revision=input-assistance)。旧页面刷新后可见：

1. 在输入框键入 `/`，按名称/英文关键词筛选。方向键、Home/End选择；Enter或Tab接受，Esc关闭并保留草稿。URL、普通路径和行中斜杠不触发。
2. 点击右下角“已用6%”查看详情；点击外部关闭，Esc/关闭键返回原触发器。加载不会推移输入框。
3. 空会话显示用量未知；错误会话首次读取演示失败，可重试，随后明确显示无数据。切换会话会关闭旧浮层，旧回调不能重新打开。

原有三条批注保持：任务/资源在设置，输入区无装饰下箭头，文件变更/Browser在右侧面板。

## 来源与真实能力边界

- 生产源码 `public/ui/inline-command-menu.js` 的行首/光标片段解析、命令候选优先于发送、IME与注册表边界是本轮依据；命令来自 `public/app.js` 已有ID，不照搬PI-Desktop的goal/plan/agent模式或技能调用格式。
- 原型目录包含12种现有命令ID的代表性动作：新对话、搜索、重命名、变更、Browser、用量、任务、Skills、MCP、设置、压缩、停止。运行资格变化时隐藏不可用候选。并不声称覆盖生产注册表的全部动态命令。
- 可导航的命令在原型内执行导航；压缩等进入明确演示确认，不调用Pi或模型。接受时仅移除光标处命令片段，保留其它草稿文字。
- 上下文沿用 `public/usage.js` 的**已用**语义：样例7,680/128,000=6%，剩余94%。会话累计、最近一轮和供应商额度分组；缺失的成本、缓存写入、远端额度不补成0。
- 所有数字是合成样例，不代表当前模型真实容量、真实账户或供应商余额；不是生产统计模块移植或后端接通。

## 验证与截图

| 范围 | 实际结果 |
| --- | --- |
| 初始目标差距 | [修改前0/2](../evidence/input-assistance/before.json)：原型没有Slash候选与上下文按钮 |
| 新输入辅助 | [200/200，失败0](../evidence/input-assistance/results.json)，28张真实截图 |
| 既有原型回归 | [435/435，失败0](../evidence/input-assistance/regression/results.json)，90张真实截图 |
| 文件资格 | [当前导出摘要](../exports/refined-manifest.json)，source与ZIP由交付检查核对；A/B未改 |

两类检查不同，不相加为一个“总通过数”。使用现有沙箱Electron Chromium、临时profile、本地导出，不运行真实Pi或模型。原生产完整npm test和应用构建未运行，因为生产没有变更。

输入辅助矩阵覆盖双主题、1280×800 / 1440×900 / 1920×1080请求尺寸，另含125/150% zoom与右面板展开。实际viewport受Windows取整影响，逐图记录CSS宽高、DPR和像素尺寸，不能把页面zoom当成所有物理DPI通过。

交互覆盖：筛选/无匹配、ARIA活动候选、菜单内部滚动、候选键盘优先、Esc不误停止、片段替换、路径/URL排除、模拟composition/229、Slash导航与停止待确认、浮层互斥/外部关闭/输入点击、统计加载/错误/重试/未知、旧回调资格、草稿和输入区几何稳定。实体IME与读屏器仍未验证。

| 场景 | 深色实图 | 浅色实图 |
| --- | --- | --- |
| Slash菜单 | [1440](../evidence/input-assistance/dark-1440-commands.png) | [1440](../evidence/input-assistance/light-1440-commands.png) |
| 用量详情 | [1280](../evidence/input-assistance/dark-1280-context.png) | [1440](../evidence/input-assistance/light-1440-context.png) |
| 无匹配 | [候选空态](../evidence/input-assistance/dark-empty-commands.png) | [候选空态](../evidence/input-assistance/light-empty-commands.png) |
| 加载/无数据 | [加载](../evidence/input-assistance/dark-context-loading.png) / [未知](../evidence/input-assistance/dark-context-unknown.png) | [加载](../evidence/input-assistance/light-context-loading.png) / [未知](../evidence/input-assistance/light-context-unknown.png) |
| 错误 | [失败与重试](../evidence/input-assistance/dark-context-error.png) | [失败与重试](../evidence/input-assistance/light-context-error.png) |
| 150%与面板 | [Slash](../evidence/input-assistance/dark-zoom-1.5-commands.png) / [详情](../evidence/input-assistance/dark-zoom-1.5-context.png) | [Slash](../evidence/input-assistance/light-zoom-1.5-commands.png) / [详情](../evidence/input-assistance/light-zoom-1.5-context.png) |

作者实际打开截图核对了深色候选、浅色详情、失败卡片、缩放及双主题布局；没有只靠断言宣布视觉完成。页面仍等待人工验收。

## 缺陷、测试工具修正与独立复核

独立只读审查发现Important 1，涉及同一组新浮层的外部关闭/互斥。初始关闭分支未清usage/slash，Slash打开时也未清旧操作菜单。作者统一状态清理、使usageOp失效；输入框自己的click/edit路径关闭旧浮层，只保留当前有效Slash。

独立逻辑复核确认5个定向条件符合预期，原Important已修复，无未处置该项；审查方未操作作者driver，不能把作者200/200称为独立GUI验证。

测试工具问题单列：

- 光标移动但值未变化时，单派input事件会被React去重；改用选择范围后的click事件刷新候选。
- 以聊天滚动区中心模拟“外部点击”时，坐标实际落在绝对定位候选层，触发搜索Dialog并遮挡后续点击。现先检查elementFromPoint命中，并使用明确的顶栏标题作为外部点。**不能把这次未选中会话归因于产品pointerdown重建。**
- Esc后再次把相同`/stop`值赋给输入，不等于用户重新键入；测试现先清空再输入，避免把继续运行误判为停止缺陷。

失败与修正历史保留：[首次结果](../evidence/input-assistance/first-run-results.json)、[外部关闭复现](../evidence/input-assistance/outside-before.json)、[第二次](../evidence/input-assistance/second-run-results.json)、[第三次](../evidence/input-assistance/third-run-results.json)、[第四次](../evidence/input-assistance/fourth-run-results.json)。这些历史数字不是最终通过资格，部分截图在后续复验中更新，不能用历史结果中的文件名推断当时画面。

## 复现与回滚

```powershell
node designs/ui-ux-2026-10-31/tools/inspect-prototype.cjs
node designs/ui-ux-2026-10-31/tools/refinement-ops.mjs export
node designs/ui-ux-2026-10-31/tools/verify-input-assistance.mjs
$env:DESIGN_QA_OUT='evidence/input-assistance/regression'
node designs/ui-ux-2026-10-31/tools/verify-refinement.mjs
```

源画板在 canvas/project/Refined.dc.html，设计系统Menu/Popover/Textarea规范已补充。加功能前的源、导出ZIP/摘要与回归脚本保存于 revisions/2026-11-01/before-input-assistance。此前批注证据和A/B保留。当前停在设计验收，@引用继续待能力核对，不开始生产重构。
