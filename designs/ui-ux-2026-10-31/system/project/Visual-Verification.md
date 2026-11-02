# 设计系统预览验证

**2026-11-01 v2补充：**中性灰Tokens、正文15/27及灰阶选中重新渲染，输出在 `verification-v2/`，388/388、40图。对比度按当前值重新计算78/78；见 [修订验收](../../reports/11-refinement-validation.md)。下文为首轮历史过程，`verification/`保留，没有用旧结果替代v2验证。

日期：2026-10-31（Asia/Shanghai）。本记录只覆盖本设计系统的原生 HTML/CSS 演示，不能代替产品集成或全量 canonical 测试。

## 命令、环境与数量

```powershell
node designs/ui-ux-2026-10-31/system/project/verify-previews.cjs
node <baoyu-design>/skills/claude-design-system/scripts/artifact.mjs check designs/ui-ux-2026-10-31/system
```

使用现有 Node v24.22.1 / Electron 44.4.3；Chromium Offscreen 真正渲染，sandbox/contextIsolation 开启、nodeIntegration 关闭，临时 userData，HTTP 只允许 loopback。未安装依赖、未调用 Pi 或模型、未读写真实用户会话。

- `artifact.mjs check`：**0 problems**；1条普通 note：meta 是来源记录，不显示为 token family。
- 预览检查：**388 / 388**，失败0、跳过0、renderer错误0。
- 其中：266项为19组件×2主题×7种模拟状态标记；76项为真实页面渲染与水平边界；46项为组件操作结果与焦点/实例验证。模拟状态不被计为真实业务接口测试。
- 覆盖模型pending→回读、字段错误、多行高度上限、菜单边界与还焦点、native Dialog、Popover、Tabs关联、会话顺序不变、Tooltip键盘、状态文字、进度、重试、Toast去重、正文选择、工具展开、面板关闭/恢复同一节点。
- 原始结果：[verification/results.json](verification/results.json)。
- 实际截图 **40张**，19组件×2主题 + Cover×2。组件截图1000×622 CSS px；Cover直接 capturePage 裁切960×288，没有后期合成。
- 截图索引：[可视图库](verification/index.html)。截图总量703,429 bytes（最终本轮生成时）。
- Token实色对比度配对：[78 / 78](Contrast-Checks.md)。

## 视觉查看与迭代

实际打开查看 Dialog light、Menu light、WorkPanel dark、ChatMessage dark、Tooltip light、Cover dark 的截图；确认文字/控件层级、深浅背景、菜单边界、模态排版与代码排版。其余组件逐页真实渲染、边界/操作检查和截图已保留，供人工完整视觉验收；不声称40图已逐像素人工审查。

1. 初次文字配色检查发现 text-muted 在 hover/pressed 背景不足4.5:1，已改为 #536171 / #a7b4c4。
2. 隐藏窗口最初抓到了较早的合成帧，改为 Offscreen 原生渲染、双 requestAnimationFrame、合成刷新与状态事实记录；最终截图的模拟状态均为default，交互selected/focus由真实控件保留。
3. Tooltip 预览初次和演示结果行重叠，已为该组件预览保留40px展示空间；不增加产品布局补丁。
4. 面板重新打开后反馈仍写“已隐藏”，已修正为“已重新打开”；实例与滚动容器仍同一节点。
5. 本次先前失败来自验证器字符串转义与合成帧/Tooltip等待判据，均保留为迭代说明；最终结果不是沿用先前失败的局部数字。

## 截图

| 组件 | 浅色 | 深色 |
| --- | --- | --- |
| Cover | [查看](verification/Cover-light.png) | [查看](verification/Cover-dark.png) |
| Button | [查看](verification/Button-light.png) | [查看](verification/Button-dark.png) |
| IconButton | [查看](verification/IconButton-light.png) | [查看](verification/IconButton-dark.png) |
| Input | [查看](verification/Input-light.png) | [查看](verification/Input-dark.png) |
| Textarea | [查看](verification/Textarea-light.png) | [查看](verification/Textarea-dark.png) |
| ModelPicker | [查看](verification/ModelPicker-light.png) | [查看](verification/ModelPicker-dark.png) |
| Menu | [查看](verification/Menu-light.png) | [查看](verification/Menu-dark.png) |
| Dialog | [查看](verification/Dialog-light.png) | [查看](verification/Dialog-dark.png) |
| Popover | [查看](verification/Popover-light.png) | [查看](verification/Popover-dark.png) |
| Tabs | [查看](verification/Tabs-light.png) | [查看](verification/Tabs-dark.png) |
| Sidebar | [查看](verification/Sidebar-light.png) | [查看](verification/Sidebar-dark.png) |
| Tooltip | [查看](verification/Tooltip-light.png) | [查看](verification/Tooltip-dark.png) |
| StatusIndicator | [查看](verification/StatusIndicator-light.png) | [查看](verification/StatusIndicator-dark.png) |
| Progress | [查看](verification/Progress-light.png) | [查看](verification/Progress-dark.png) |
| EmptyState | [查看](verification/EmptyState-light.png) | [查看](verification/EmptyState-dark.png) |
| ErrorState | [查看](verification/ErrorState-light.png) | [查看](verification/ErrorState-dark.png) |
| Toast | [查看](verification/Toast-light.png) | [查看](verification/Toast-dark.png) |
| ChatMessage | [查看](verification/ChatMessage-light.png) | [查看](verification/ChatMessage-dark.png) |
| ToolActivity | [查看](verification/ToolActivity-light.png) | [查看](verification/ToolActivity-dark.png) |
| WorkPanel | [查看](verification/WorkPanel-light.png) | [查看](verification/WorkPanel-dark.png) |

## 资格边界

预览事件由 DOM click/change 和 Chromium原生语义触发，不是实体鼠标/键盘的全路径认证。native Select 的系统弹出列表、物理Windows缩放/显示器切换、实体IME、屏幕阅读器、生产Browser WebContentsView、真实模型/OAuth/文件写入、安全回滚和安装更新均未在此验证。主原型的三尺寸与交互证据见本轮总设计交付。

用户验收、生产实施、代码验收、合并与发布是独立阶段；本系统只供本阶段人工设计验收。
