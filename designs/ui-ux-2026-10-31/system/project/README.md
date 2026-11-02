# Pi Workbench · 统一修订设计系统

版本：Tokens v2，2026-11-01。用于 pi-GUI 设计原型，不是已接入生产的 UI 库。用户提供的 21 张 PI-Desktop 实机截图及当前 pi-GUI 源码清单共同提供设计依据；不复制外部品牌或业务实现。

## 来源与边界

- 当前源码清单、115 个唯一 CSS 变量与边界说明见 [Original-Inventory.md](Original-Inventory.md) 和 [source-inventory.json](source-inventory.json)。不把原项目描述成没有中央 Tokens。
- 19 个原生 HTML/CSS 组件预览，未复制生产组件、未建立自动业务同步。源代码边界与状态归属仍由现有模块维护。
- A/B 画板及其导出保留首轮系统快照；新 Refined 画板使用 `ds/pi-workbench-refined/`。v1 Tokens 另存 `../../revisions/2026-11-01/baseline-tokens.json`。
- 本机字体栈，不下载字体；无外部品牌、吉祥物或未经许可素材进入产品原型。研究截图仅用于内部对照。
- 所有模型、资源、变更、日志与连接状态均为演示，不调用真实后端，不读取凭据。

## 统一原则

1. 单侧栏组织主工作区；设置页使用分类导航替换会话列表，返回时恢复会话上下文。

   浏览器批注补充：任务与审阅、Skills与扩展位于设置“工作区”组；顶栏只保留工作面板开关，变更与Browser入口在右面板内部。输入区选择器省略装饰下箭头，原交互与语义保持。
2. 助手正文开放排版，完成态元信息置于回复末尾；工具活动先给摘要，再展开列表与详情。
3. 中性表面和灰阶选中承担日常层级；链接与键盘焦点使用 accent/focus；状态配文字和符号。
4. 模型与发送形成输入区右侧操作组。多行、模型名、附件和停止状态不引起横向跳动。
5. 每个等待明确命名。运行、停止中、已停止、需认证、未知不互相替代。
6. 原有能力与授权合同优先。Classic/Runtime、Pi 模型回读、MCP、Browser、撤销与更新均保留既有边界。

## Tokens 与消费

唯一来源是 [tokens.json](tokens.json)。本轮提供本地 `/design-sync` 等价工具 `../../tools/sync-design-system.mjs`，从 JSON 生成 tokens.css 并安装到新画板。不得手改生成 CSS。编辑器仍可编辑 JSON Tokens；编辑完成后运行：

```powershell
node designs/ui-ux-2026-10-31/tools/sync-design-system.mjs
```

先载入 tokens.css，再载入 components/bundle.css；根元素使用 `data-theme="light"` 或 `dark`。组件 CSS 采用 `pw-*` 命名空间；原型布局采用 `pg-*`，没有生产全局覆盖。没有 JS 组件全局或新产品依赖。原型导出使用工具自带 React runtime，仅属于设计查看器。

| 基础 | v2 规范 |
| --- | --- |
| 深色 canvas / nav / input | #181818 / #111111 / #242424 |
| 浅色 canvas / nav / input | #ffffff / #f4f4f4 / #f5f5f5；浅色 Composer 可使用白表面与轻阴影 |
| 文字 | text-primary / text-secondary / text-muted，禁止再用 opacity 降低文字对比 |
| 选中 / 聚焦 | accent-soft + text-primary；2px focus-visible，2px offset |
| 布局 | 单侧栏264，紧凑窗口224；顶栏48；阅读宽760；工作面板392，紧凑窗口360 |
| 面板约束 | 320–560键盘/拖动预算，最大不超过聊天工作区50%；800px以下可overlay |
| 排字 | UI13/20，正文 type-prose 15/27，辅助12/18；使用本机 Segoe UI / 微软雅黑及 Cascadia/Consolas |
| 圆角 | control8 / panel12 / composer18；正文不套外壳 |
| 图标及命中 | 16/18px描边图标；紧凑图标按钮32，常规目标36，触摸44 |
| 间距 | 4px基本格；8/12/16/20/24/32按组件与分组使用 |
| 动效 | hover80–100ms，菜单120ms，面板160ms；系统reduce与原型主动reduce均生效 |

其他颜色、字体、间距、层级、阴影、边框与缓动均在 Tokens 中维护；每个 Token 包含 usage。type-prose 由生成器提供 `--type-prose-font-size` / `--type-prose-line-height`，ChatMessage 与 Refined 正文共同消费。

## 组件与状态

完整清单见 [Component-Coverage.md](Component-Coverage.md)，每个组件有 README 和可操作 preview.html。默认、悬停、按下、选中、聚焦、禁用、错误分别定义；只读内容不制造虚假的禁用或选择语义。

菜单/模型选择器在8px视口预算内，优先向上、必要时翻转/限高；模型菜单330px，独立通用 Popover 可按内容使用360px。菜单关闭恢复触发器，Dialog打开先聚焦输入或首个按钮，Tab循环，Escape返回原触发器。简单Dialog480px，不照搬参考配置Dialog的全屏尺寸。

输入区的 Enter 偏好在原型内可切换，Shift Enter换行，关闭 Enter发送后 Ctrl/Cmd Enter发送；中文组合输入不提前发送。实际实体IME仍需产品阶段验证。

资源列表分别展示来源、全局/项目、安装/加载/观察与信任状态。未知、需认证、不可信不能压成一个启用开关。非关键通知在目的地切换时清除；阻断错误留在所属内容区。

## 验证范围

[Contrast-Checks.md](Contrast-Checks.md) 使用 v2 实际值重新计算；首轮78/78不能自动继承。组件真实渲染的新证据位于 verification-v2/，首轮 verification/ 保留。组件和原型的检查单位不同，不相加成总通过数。

当前资格及真实截图见 [Visual-Verification.md](Visual-Verification.md) 与 [原型修订验收](../../reports/11-refinement-validation.md)。格式检查只检查文件结构；自动布局与交互断言也不能代替目视检查。

Not synced：未生成生产组件或修改数据模型；真实模型、实体IME、读屏器、原生Browser遮挡、安装升级和所有物理DPI未获得资格。后续实施继续沿用现有生命周期与安全模块。
