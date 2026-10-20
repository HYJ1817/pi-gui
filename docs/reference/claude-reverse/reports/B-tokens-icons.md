# 报告 B — token 缺口与图标映射（已闭合）

目标：把 `claude-design-tokens` 里 **8 个未解析 CSS 变量**和**图标 glyph 映射**补齐。
结论：**8/8 全部定位**，其中 6 个可以给出确定性兜底值，2 个属于设计上的"故意不声明"。图标侧从"395 个匿名码位"变成 **395/395 已命名 + 可用的 SVG 路径**。

---

## 一、8 个未解析变量

数据源：`desktop/design-tokens/data/report.json → unresolved`（原始 16 个 CSS / 1142 变量 / 8 个 unresolved）。

| 变量 | 引用数 | 原始写法 | 归属 | 处理 |
|---|---|---|---|---|
| `--cds-rem-scale` | **295** | `calc(<值> * var(--cds-rem-scale, 1))` | **运行时注入** | 钉 `1` |
| `--_prose-leading` | 5 | `calc(var(--_prose-leading) + .1875rem)` | **运行时注入** | 钉 `1.5`（推断） |
| `--tw-empty` | 3 | `var(--tw-empty, )` | **Tailwind 空值技巧** | 不声明 |
| `--cds-font-mono-override` | 2 | `var(--cds-font-mono-override,)` | **JS 内联样式注入** | 钉 `initial` |
| `--font-anthropic-mono` | 2 | `var(--font-anthropic-mono,"SF Mono")` | 可选覆盖钩子 | 钉 `"SF Mono"` |
| `--font-anthropic-sans-display` | 1 | `var(--font-anthropic-sans-display,var(--font-sans))` | 可选覆盖钩子 | 钉 `var(--cds-font-sans)` |
| `--placeholder-reveal-delay` | 1 | `var(--placeholder-reveal-delay,.5s)` | 可选调参钩子 | 钉 `.5s` |
| `--cmp-chin-row-h` | 1 | `var(--cmp-chin-row-h,var(--cds-h-control))` | 可选覆盖钩子 | 钉 `var(--cds-h-control)` |

可直接用的兜底文件：**`reports/token-patches.css`**。

### 1.1 `--cds-rem-scale`（295 处，最重要的一个）

**它从来没有被声明过，也从没被 JS 写过。** 证据：

- 16 个 CSS 文件全文搜 `--cds-rem-scale:` → **0 处声明**；
- 431 个 JS 文件搜 `setProperty("--cds-rem-scale"` / `remScale` 标识符 / `--cds-rem-scale:` 赋值 → **0 处**；
- 全部 295 处都是 `calc(<尺寸> * var(--cds-rem-scale, 1))`，fallback 恒为 `1`。

所以它是**消费方/运行时设定的密度乘数**：claude.ai 在 `html` 上按用户偏好（缩放、密度）写入一个数，整套 `--cds-*` 尺寸随之等比缩放。由于本仓库里的 CDS 样式表只导出了 `[data-density=comfortable]` 一种密度块，本地既无声明也无 `compact` 对照，**默认值就是 1**。

设计含义（值得记一笔）：CDS 的所有尺寸都写死为 `rem 值 × rem-scale`，而不是依赖根字号 —— 这样浏览器的字号设置不会破坏布局，密度只由应用自己控制。

### 1.2 `--_prose-leading`（5 处）

只出现在这一条规则里：

```css
.cds-root [data-cds-bubble-stack] [data-cds=Prose]:not(...) {
  --_prose-h1-leading: calc(var(--_prose-leading) + .1875rem);
  --_prose-h3-leading: var(--_prose-leading);
  ...
}
```

同一条规则里 h1/h2/h3/h4/h5/h6 的 size 与 leading 都被本地定义了，唯独基准 `--_prose-leading` 没有 → **由 claude.ai 的 Prose 渲染层注入**（正文行高）。缺失后果不是崩，而是这几条 leading 计算为无效值、退回继承行高 —— 属于优雅降级。

### 1.3 `--tw-empty`（3 处）

```css
[type=checkbox]:focus { --tw-ring-inset: var(--tw-empty, ); ... }
```

Tailwind v4 的内建技巧：`var(--tw-empty, )` 的 fallback 是**空**，用来把自定义属性置成空值。`--tw-empty` 如果被真的赋值，反而会改变语义。**不要补它。**

顺带说明 `--cds-font-mono-override` 的 `var(--cds-font-mono-override,)` 是同一个技巧，但它**真的有写入方**：

```js
function Si(e){
  if (e === null) return {"--cds-font-mono-override":"initial"};
  const t = e?.trim();
  return t ? {"--cds-font-mono-override": `"${t.replaceAll(/[\u0000-\u001f\u007f]/g,"")
                .replaceAll("\\","\\\\").replaceAll('"','\\"')}",`} : {};
}
```

即：**用户设置里可以指定自定义等宽字体**，通过 React 内联样式写成 `"<字体>",`（注意尾部逗号 —— 和 `var(--x,)` 配合起来当"追加到字体栈首位"用）。这解释了两处 `var(--cds-font-mono-override,)` 的怪写法。

### 1.4 三类归因小结

| 类别 | 变量 | 为什么"未解析" |
|---|---|---|
| 运行时注入 | `cds-rem-scale`、`_prose-leading` | 值由远程 claude.ai 决定，本地包不含 |
| 空值技巧 | `tw-empty`、（`cds-font-mono-override` 的写法） | 故意不声明 |
| 可选钩子 | `font-anthropic-mono`、`font-anthropic-sans-display`、`placeholder-reveal-delay`、`cmp-chin-row-h` | 本来就靠 fallback 工作 |

**结论：这 8 个不是抽取器的漏洞，而是抽取器正确地把"没有声明"报告了出来。** 前两类永远不该被"补"，第三类补不补等价。

---

## 二、图标 glyph 映射

### 2.1 现状：字体在，名字不在

| 事实 | 值 |
|---|---|
| 字体文件 | `.vite/renderer/find_in_page/assets/anthropicons-variable-cvFTkbeX.woff2`，102,544 B |
| family | **Anthropicons RVRN** |
| 字形 | **395 个，全部在私用区 U+E000–U+E18C**（该区间 397 个码位，缺 E0CE、E114） |
| 字形名 | 只有 `uniE000` 这种机械名，**无语义** |
| 变量轴 | `wght 400–700`、`opsz 12–32`、**`ANIM 0–100`**、**`ANM2 0–100`** |
| 单位 | unitsPerEm 1000，ascent 1000，advance 恒 1000 |

关键否定证据：在 **431 个 JS 文件里搜 `Anthropicons` → 0 处命中**；搜 PUA 转义字面量（`\uE0xx`、`'e0xx'`）→ 0 处图标引用。

> **名字→码位的映射表不在本地包里**，在远程 claude.ai 的图标注册表。所以只能靠视觉识别。

顺带印证：`design-tokens/data/icon-animation.json` 早已分析过这批字形（869 个 glyph 槽 / 395 个 cmap 项 / **24 个带 ANIM 动画** / archetype `morph` 22 + `pulse` 2）。**图标动画是字体本身编码的**，不是 CSS 动画。

### 2.2 本次补齐的产物

| 文件 | 内容 |
|---|---|
| `reports/anthropicons.json` (477 KB) | 395 个字形：码位、**语义名**、advance、bounds、**完整 SVG path `d` 字符串**。viewBox `0 0 1000 1000`、transform `translate(0 1000) scale(1 -1)` |
| `reports/anthropicons-atlas.html` (485 KB) | 单页视觉图集，395 格，每格一码位。直接用浏览器打开 |
| `analysis/icon_names.py` | **命名表源文件**，395 条，手工视觉核读 |
| `analysis/icons_atlas.py` | 从字体导出路径 + 生成图集（`fontTools` + `SVGPathPen`，**不复制字体二进制**） |
| `analysis/icons_sheets.py` | 6 张 contact sheet，用于分批阅读命名 |
| `analysis/icons_merge.py` | 合并命名 + 生成对齐校验图 |
| `analysis/verify_glyphs.py` | 用独立渲染路径复核 SVG 方向（matplotlib 版） |

命名覆盖率：**395 / 395**（`unnamed=0`），并做了逐格对齐校验。

### 2.3 命名约定与内容分布

规则：小写连字符；`-filled` 实心；`-off` 斜线禁用；`-circle` / `-square` 外框变体。

| 区间 | 内容 | 例 |
|---|---|---|
| U+E000–E047 | 导航 / 方向 / 对话 | `calendar-chart` `route` `arrow-in-square` `split-branch` `messages` `check-check` `cloud-off-filled` |
| U+E048–E08F | 开发 / 文件 / git | `code` `terminal-filled` `git-network` `git-merge` `hierarchy` `folder-plus` `ghost` `owl` |
| U+E090–E0D8 | 媒体 / 输入 / 状态 | `key` `keyboard` `zap` `radar` `prohibited` `archive-tray-x` `form-submit` `gear` |
| U+E0D9–E121 | 布局 / 控件 / 排版 | `sidebar-left` `panel-right` `layout-corner-bl` `panels-x` `bookmark` `battery` |
| U+E122–E139 | 语义图标续 | `scan-frame` `tomato` `heart` `scales` `bank` `owl` `github`（在末段） |
| U+E13D–E18C | **积木，不是图标** | `heading-1/2/3` `paragraph` `lines-3` `bar-vertical` `corner-bracket-tl` `dash-long` `sigma` `slash` |

最后一段很关键：`heading-1/2/3`、`pipe`、`line-height`、`dash-*`、`corner-bracket-*`、`bars-*` 这些不是"图标"，而是**排版与骨架的组成件**（首帧占位、prose 排版、骨架屏用它拼形状）。仿写时不要当成 icon set 用。

几个 Anthropic 风格的彩蛋：`ghost` / `ghost-filled` / `ghost-alt`（3 个）、`owl`、`tomato`、`robot`、`flask`、`coffee`、`smiley` / `smiley-plus`。

---

## 三、复现

```bash
cd C:/claude逆向素材/desktop/analysis

# token 缺口
python token_gaps.py        # → reports/token-gaps-raw.json（每处声明/引用/JS 的原始上下文）
python probe_b2.py          # → reports/icon-glyphs.json（字形规则、类名、字体族清点）

# 图标
python icons_atlas.py       # → reports/anthropicons.json + anthropicons-atlas.html
python icons_sheets.py      # → 6 张 contact sheet（%TEMP%/atlas/sheet*.png）
python icons_merge.py       # 合并 icon_names.py 的命名 + 对齐校验图
python verify_glyphs.py     # 独立渲染复核方向
```

依赖：`fontTools` + `brotli`（解析 woff2）、`matplotlib`（图集/校验图）。字体二进制**不外发**，只导出几何路径。

---

## 四、仍未闭合

1. **图标名与 Anthropic 官方命名不一定一致** —— 本文档的名字是我按形状起的规范名，官方内部名字（很可能也是 kebab-case）无从获取。要精确对齐只能拿运行时 DOM 的 `data-icon="..."` 反查。
2. `--_prose-leading` 的 `1.5` 是推断值，不是原值；真实值只有 claude.ai 运行时知道。
3. `--cds-rem-scale` 在 `compact` 密度下的具体取值不可知（本地只有 `comfortable` 一种密度块）。
4. `icon-animation.json` 记录了 24 个带动画的字形及其 morph/pulse 原型，但**每个字形在 ANIM=50 时的具体轮廓**属于运行时数据，本次未导出（只导了默认实例）。
