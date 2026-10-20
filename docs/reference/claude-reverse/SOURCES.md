# 溯源与复现

## 1. 靶子

| 靶子 | 版本 | 体积 | SHA-256 |
|---|---|---|---|
| Claude Desktop `app.asar` | `@ant/desktop` **v2.42304.0** | 49,338,428 B | `8f4d3dec5e4f3ddffb150321060b18807d83a40f3a65618fe4f29325379da9db` |
| Claude Code `claude.exe` | **2.1.301** | 271,840,416 B | `84d61feeb1a07e5a5b3354d68432591cac18a5d38a419a30d86d0f3ad8cba397` |
| 从中提取的 `claude.js` | — | 46,303,414 B | `0f6c0189d299357d7b454fac22970ecef1b51637ce20748b01f12bd206437063` |

`claude.exe` 是 `bun build --compile` 单文件产物：`.bun` 段 raw=0x618e200、size=169,535,973，
JS 载荷位于 offset 119,054,280，尾部 10,427 B 为 Authenticode 签名。

## 2. 方法（可复现）

**桌面**：`app.asar` → 按 ASAR 格式解包（506 entries / 78 MB，6 unpacked，0 links，
逐文件 sha256 清单）→ 对 431 个 JS 做静态扫描（菜单树、加速键、IPC 通道、CSS 规则、图标集）。

**CLI**：`claude.exe` → 用 `unbuned` 抽出 `.bun` 段 → 2414 个模块（2414/2414 带 JSC bytecode）
+ 252 assets + 2665 embedded files → 静态扫描工具定义 / 命令注册 / env / 遥测。

`.gitignore` 已排除的东西（体积/合规）不入库：`app.asar`、`cli/raw`、提取出的字体、
图标 SVG path、`node_modules`。它们留在本地磁盘，上面的哈希保证可重新取得同一版本。

## 3. 各数据集怎么生成的

| 文件 | 生成方式 |
|---|---|
| `data/shortcuts.json` | 扫描 asar 内全部 `accelerator:` 字符串 + `before-input-event` 比较表，人工去重合并 |
| `data/icons-codepoints.json` | 解析 `anthropicons-variable.woff2` 的 cmap（395 个 PUA 码位），码位→名字由**逐个渲格视觉命名**得出（字体里只有 `uniE000` 式机械名，无官方语义名） |
| `data/cli-tools.json` | 在 2414 个模块里定位工具工厂 `Qt({…})` 的对象体（字符串感知花括号扫描），取**顶层键**：`name` / `userFacingName` / `searchHint` / `isReadOnly` / `remoteExecution` / `backgrounding` / `maxResultSizeChars` / `strict` / `shouldDefer` |
| `data/cli-commands.json` | 匹配 `{type:"local"|"local-jsx"|"prompt"|"builtin", name:"…"}` 对象体，取 `description` / `argumentHint` / `aliases` / `requires` / `availability` / `thinClientDispatch` / `load` |
| `data/cli-env-telemetry.json` | 正则清点 `process.env.X`、`"tengu_*"`、hook 事件名 |

## 4. 刻意不包含（合规边界）

本目录只发布**事实与度量**：数值、标识符、数量、枚举、白名单、结构。

不包含：原始二进制、`app.asar`、提取出的字体文件、图标 SVG path（只给码位→名字）、
Claude 的系统提示词与工具 prompt 原文、任何用户数据。
—— 换句话说：**可复述的事实进来了，可拷贝的表达没进来。**

## 5. 已知不确定项

1. `--_prose-leading = 1.5` 是**推断值**（本地仅 5 处引用，缺值只退化不崩，无法从代码确认真值）。
2. 图标名字是视觉命名，非官方命名（字体内无语义名，映射表在远程前端）。
3. `--tw-empty`、`--cds-rem-scale` 等 2 个 CSS 变量属**故意不声明**（Tailwind v4 空值技巧 /
   运行时注入），补上反而改变语义。
4. 侧栏 288 是默认值；实际运行时若被用户拖拽，值持久化在 `WindowState`。
