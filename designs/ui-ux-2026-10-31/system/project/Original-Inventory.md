# 原始清单与新方案的边界

以下为当前基线读取结果，不是未来产品承诺。源码 `9694339` 的 CSS token 层已经存在；`tokens.json` 里的新命名与数值是本轮提案，不覆盖现有文件。

| 类别 | 原值/证据 | 新方案 |
| --- | --- | --- |
| 深色主背景 | #151515，public/tokens.css:5 | surface-canvas #181b20 |
| 浅色主背景 | #fcfcfb，public/tokens.css:103 | surface-canvas #f7f8fa |
| 导航 | #111111 / #fbfbf9，tokens.css:6/104 | #14171c / #eef0f3 |
| 强调 | brand #c6613f，focus #86b6ef / #2a78d6 | blue accent #9abbed / #315f9e，primary中性 |
| UI / 正文 | 13px / 14px，tokens.css:45–46 | 13/20、14/24，增加明确行高 |
| 间距 | 4/8/12/16/24/32，tokens.css:51–56 | 保留基本格，补2/20/40/48/64 |
| 圆角 | control6/card8/composer14/bubble18，tokens.css:57–60 | control6/panel8/composer10 |
| 动效 | 60/120/200/300ms，tokens.css:62–65 | 0/80/120/160/200ms |
| 阅读列 | 768px，styles.css:34 | 780px，随面板约束收缩 |
| Rail | 52px，styles.css:2427 | 保留52px |
| 右栏头 | 46px，ui4-pane.css:34 | 52px，统一到header token |
| 字体 | Segoe UI与Microsoft YaHei等回退，tokens.css:42 | Windows优先系统栈；无下载 |

机器清单 `source-inventory.json` 中 155 声明 / 115 唯一名称，覆盖当前 public 顶层CSS文件并保留位置。颜色含深浅覆盖与别名，因此声明数不等于颜色token数。不解析无CSS声明的硬编码组件值；后续实施需按逐模块清单继续收敛它们。

组件库存：Button / IconButton / Input / Textarea / ModelPicker / Menu / Dialog / Popover / Tabs / Sidebar / Tooltip / StatusIndicator / Progress / EmptyState / ErrorState / Toast / ChatMessage / ToolActivity / WorkPanel。生产现有按钮、popover、modal、right-pane、secondary-surface、split-workbench 与会话 owner 是复用目标，不在设计阶段重写。

资源：未导入外部品牌、图片或字体文件；此系统只用普通名称排字和手写通用SVG。预览为新方案，不声称是生产组件库的built route。
