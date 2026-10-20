# 布局度量真值（可直接用于实现）

来源：Claude Desktop `@ant/desktop` v2.42304.0 的 `app.asar` 解包 + 反混淆。
每个值都是**从代码里读出的常量或默认值**，不是猜的；推断值单独标注。
完整取证见 [`../reports/A-desktop-asar.md`](../reports/A-desktop-asar.md)。

---

## 1. 窗口与侧栏

| 项 | 值 | 说明 |
|---|---|---|
| 侧栏宽度 | `288` | 展开态；写死在窗口状态默认值里 |
| 侧栏默认折叠 | `false` | |
| 折叠阈值 | `700` | 视口宽度 < 700 自动折叠 |
| 主窗标题栏高度 | `44` | Electron `titleBarOverlay.height` 的基准值 |
| 覆盖层标题栏下限 | `24` | `max(24, round(base × zoom))` |
| 本地 shell 的 CSS 标题栏 | `36` | 注意：这是 renderer 里 `titleBarHeight` 的默认值，与 44 分属两层 |
| 缩放步长 | `0.5` | 缩放不是连续的，按 0.5 跳 |
| 缩放网格对齐 | `0.5` | 缩放后的尺寸对齐到 0.5 网格 |

**可派生的实现规则：** 标题栏高度不能写死 —— 它是 `max(24, round(44 × zoom))`。
缩放 100% → 44；缩放 50% → 24（被下限截断）；缩放 80% → 35。

## 2. 浮窗

| 窗口 | 尺寸 / 属性 | 说明 |
|---|---|---|
| Quick Entry（全局热键唤出） | `606 × 470` | `alwaysOnTop("pop-up-menu")`、`closable: false`、无边框 |
| Quick Entry 清理延迟 | `30` ms | 关闭后延迟释放，避免闪烁 |
| Artifact 弹窗 | min `320 × 240`，默认 `800 × 600` | `useContentSize: true`（尺寸指内容区，不含边框） |
| 弹窗存活检查 | `2000` ms | 定时探测宿主是否还在 |
| 弹窗关闭延迟 | `250` ms | 宿主消失后延迟关闭 |

## 3. 主题 overlay

原生标题栏覆盖层（`titleBarOverlay`）的两套配色：

| 模式 | 背景 | 符号色 |
|---|---|---|
| 浅色 | `#f9f8f4` | `#000` |
| 深色 | `#141412` | `#fff` |

管线：`userThemeMode("system"|"light"|"dark")` → `nativeTheme.themeSource` →
`titleBarOverlay{color,symbolColor,height}` + `backgroundColor`；
renderer 侧同步 `<html class="cds-root" data-mode="system">` 与 `prefers-color-scheme`。
overlay 更新按 `JSON.stringify` 去重，失败进黑名单（注释原文：`this is probably expected`）。

## 4. 首帧骨架（Boot Placeholder）

主窗在 Web 内容到达前先画一个**与真实布局同构的灰块骨架**，避免白屏跳变。
参数如下（全部实测）：

| 元素 | 位置/尺寸 |
|---|---|
| 第 1 行（标题占位） | `top: 188, left: 14, w: 88, h: 10` |
| 导航行 `i`（i = 0..4，共 5 行） | `top: 218 + i × 26` |
| 行内图标 | `top: +3, left: 19, 6 × 6, radius 3` |
| 行内文本起点 | `left: 38` |
| 文本宽度比 | `[.68, .54, .44, .68, .54]`（随行变化，模拟真实文案长度） |
| shape 上限 | `160`（超过即停止绘制，防卡） |
| 骨架变体标记 | `data-boot-placeholder-frame ∈ {sidebar, collapsed}` |
**实现要点：** 行高 26、图标 6×6 圆角 3、文本从 38px 起 —— 这三个数与真实列表项一致，
所以骨架换成真实内容时不会有位移。

## 5. 本地 shell 的 DOM 骨架

```
#root
└─ MainWindowPage
   ├─ TitleBar            h = 36, 含 .nc-drag / .nc-no-drag 拖拽区标记
   ├─ BootPlaceholder     §4 的骨架，Web 内容就绪后移除
   ├─ ErrorOverlay        icon "Warning"
   ├─ ErrorDetailsPanel
   └─ webview 宿主         实际被 WebContentsView 覆盖（不渲染这里的内容）
```

本地 shell 只带 3 个图标（`Menu` / `Spinner` / `Warning`），837 个文案 key，747 条 CSS 规则。
**聊天界面主体不在这里**（见 `../README.md` §4 边界）。

## 6. 与实现无关但常被误用的两个值

- `narrowViewportMaxWidth = 700` 是**视口宽度**判断，不是窗口宽度，也不含缩放系数。
- `titleBarHeight = 36` 是 renderer CSS 变量，Electron 原生 overlay 用的是 44 —— 两者不能混用，
  混用会导致视觉上 8px 的错位。
