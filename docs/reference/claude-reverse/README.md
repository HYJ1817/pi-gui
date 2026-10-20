# Claude 逆向参考资料（供 AI 规划使用）

本目录是 **Claude 桌面应用 + Claude Code CLI 的实测逆向结果**，按「AI 能直接消费」组织：
数字是实测值，名字是真实标识符，来源可复现，边界显式标注。

**用它可以回答：** 窗口尺寸该是多少、侧栏多宽折叠、标题栏多高、快捷键绑什么、
菜单有哪些项、主题怎么切、有哪些工具/命令/env 开关。
**不能回答：** 聊天界面内部组件结构（不在本地，见 [边界](#边界)）、Claude 的系统提示词原文。

---

## 1. 十条硬数字（先看这个）

| 项 | 值 | 含义 |
|---|---|---|
| 侧栏宽度 | **288 px** | 展开态 |
| 折叠阈值 | **700 px** | 视口宽度 < 700 时侧栏折叠 |
| 主窗标题栏 | **44 px** | `titleBarOverlay.height` 基准 |
| 覆盖层标题栏下限 | **24 px** | `max(24, round(base × zoom))` |
| 本地 shell 标题栏（CSS 默认） | **36 px** | 与上面 44 是两层不同东西 |
| 缩放步长 | **0.5**，并对齐 **0.5** 网格 | 不是连续缩放 |
| Quick Entry 浮窗 | **606 × 470**，`alwaysOnTop: "pop-up-menu"`，`closable: false` | 全局热键唤出 |
| Artifact 弹窗 | 最小 **320 × 240**，默认 **800 × 600**，`useContentSize: true` | |
| 命令面板 | `CmdOrCtrl+K` | 走 `before-input-event` 拦截 |
| 深链白名单 | 仅 `claude.ai/new?q=`、`cowork/new?q=`、`claude.ai/chat/<uuidv4>`、`claude.ai/project/<uuidv4>` | 其余一律拒绝 |

---

## 2. 文件路由（按问题找文件）

| 你想知道 | 读这个 |
|---|---|
| 窗口/侧栏/标题栏/浮窗的精确尺寸、首帧骨架、overlay 颜色 | [`spec/layout.md`](spec/layout.md) |
| 全新规划一个 Claude 风格外壳，要知道运行时拓扑、窗口模型、安全基线 | [`reports/A-desktop-asar.md`](reports/A-desktop-asar.md) |
| 菜单树、26 个快捷键、全局热键、命令面板 vs Quick Entry、主题管线、路由枚举 | [`reports/C-interaction.md`](reports/C-interaction.md) + [`data/shortcuts.json`](data/shortcuts.json) |
| `--cds-*` 设计 token、8 个未解析变量的结论、图标字体事实 | [`reports/B-tokens-icons.md`](reports/B-tokens-icons.md) |
| 395 个图标 glyph 的码位 → 语义名 | [`data/icons-codepoints.json`](data/icons-codepoints.json) |
| Claude Code 有哪些工具、参数语义、能力字段 | [`data/cli-tools.json`](data/cli-tools.json) + [`reports/D-cli-inventory.md`](reports/D-cli-inventory.md) |
| 斜杠命令全表（含别名/参数提示/门控） | [`data/cli-commands.json`](data/cli-commands.json) |
| 环境变量、遥测事件、hook 事件 | [`data/cli-env-telemetry.json`](data/cli-env-telemetry.json) |
| 这些数据怎么来的、哈希、如何复现 | [`SOURCES.md`](SOURCES.md) |

---

## 3. 建议的阅读顺序（给做规划的 AI）

1. 先读本文件 §1，拿到 10 个硬数字 —— 多数布局决策到这一步就够了。
2. 要动外壳 → `spec/layout.md`（含首帧骨架与窗口层级）。
3. 要动交互 → `reports/C-interaction.md` 的「快捷键总表 / 菜单树」，再查 `data/shortcuts.json` 里的原文加速键。
4. 要动视觉 → `reports/B-tokens-icons.md` 的变量表 + `data/icons-codepoints.json` 取名。
5. 只有要设计 CLI 能力面时，才需要 `data/cli-*.json`。

**读的时候请注意**：`reports/` 是完整取证记录（中文，含论证过程、反例、死路），
`spec/` 和 `data/` 是可直接引用的结论（数字/名字/JSON）。规划时引用后者，追证时查前者。

---

## 4. 边界

- **本地只有外壳。** 主窗是 `BrowserWindow` + `WebContentsView` 加载 `https://claude.ai`，
  聊天界面的组件树、斜杠命令补全、`@` 提及等**不在本地包里**，本目录没有也不可能有。
  要那份数据只能走 CDP 抓运行时 DOM。
- **推断值已标注。** 例：`--_prose-leading = 1.5` 是推断（缺值只退化不崩），不是官方值。
- **`~` 三态。** `data/cli-tools.json` 里能力字段用 `null` / `"dynamic"` / `true|false` 三态，
  `"dynamic"` 表示该能力按输入计算，**不能当成「是」或「否」**。
- 应用版本：Claude Desktop `@ant/desktop` v2.42304.0；Claude Code CLI `2.1.301`。细节见 `SOURCES.md`。

---

## 5. 不含什么（合规）

本目录**只发布事实与度量**：尺寸、名字、数量、枚举、白名单、结构。

刻意**不**包含：原始二进制、`app.asar`、提取出的字体文件、图标 SVG path（只有码位→名字）、
Claude 系统提示词原文、任何可识别的用户数据。见 `SOURCES.md` §4。
