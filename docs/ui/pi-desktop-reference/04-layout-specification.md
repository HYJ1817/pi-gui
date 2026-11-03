# 04. 页面与布局架构规范 (Layout Specification)

## 1. 全局视口与分栏架构 (Application Shell Overview)

PI-Desktop 采用基于 CSS Flexbox 与绝对定位混合的高性能桌面多栏架构。其核心布局由四层结构嵌套组成：

```text
+-----------------------------------------------------------------------------------------+
| [Top Window Drag Band / Titlebar: 46px] -------------------- [Window Controls: 120px]   |
+------------------------+------------------------------------+---------------------------+
| Sidebar (左侧边栏)      | MainChat (主舞台区)                 | WorkPanel (右侧工作区)     |
|                        |                                    |                           |
| 宽度: clamp(240,275,520)| 宽度: flex: 1 (min-width: 450px)   | 宽度: 动态分配 (min: 344px) |
| 背景: #000000          | 背景: #181818                      | 背景: #212121             |
|                        |                                    |                           |
| - Header (Logo+折叠)   | - Topbar (面包屑+快捷操作)         | - Header (Tabs + 窗口操作)|
| - 会话列表 (可滚动)    | - Transcript (可滚动消息流 / Hero) | - 标签对应工作体          |
| - 项目树 (可展开折叠)  | - Floating Composer (底部悬浮输入) |   (审阅/浏览器/文件管理)  |
| - Footer (工具图标条)  |                                    |                           |
+------------------------+------------------------------------+---------------------------+
| [Viewport-Fixed Overlays Host: #pi-desktop-overlays (模态弹窗 / 浮动菜单 / Tooltips)]    |
+-----------------------------------------------------------------------------------------+
```

> **【尺度校准与像素转换说明 / Scale Calibration】**：
> - 经对 24 张原始参考 PNG 二进制元数据（`pHYs: 5669 pixels/meter = 144 DPI`）及 Electron 真机实测，参考截图均在 Windows 150% 显示缩放（`devicePixelRatio = 1.5`）下捕获。
> - 截图物理像素与 CSS 逻辑像素换算关系为：**`物理像素 = CSS 像素 × 1.5`**。
> - 规范中所有尺寸均以 **CSS 逻辑像素**为唯一标准（如顶栏 46px、侧边栏/设置轨 275px、控制按钮 28px、Composer 圆角 20px）；在 150% 缩放下渲染时，其屏幕物理像素分别对应为 69px、412.5px、42px、30px。

---

## 2. 核心布局区域与尺寸约束

### 2.1 顶部通用工具栏 (ConversationTopbar & Titlebar)
- **对应截图**：`REF-001`, `REF-002`, `REF-003`, `REF-018`, `REF-021`
- **高度规范**：全局统一锁定为 **`46px`** (`var(--ds-toolbar-height)`)。
- **拖拽区域划分 (`-webkit-app-region: drag`)**：
  - 顶部 46px 带作为原生窗口拖拽区，但**严格在交互按钮外围剪切**；
  - 所有按钮（展开、新建、搜索、切换面板、窗口控制）均声明 `-webkit-app-region: no-drag`。
- **平台几何对齐差异**：
  - **macOS**：左侧预留 `88px`（窗口化时通过 `--ds-window-lead-inset` 预留红绿灯区域，全屏时收缩至 `8px`），侧边栏折叠按钮右移或位于首位；
  - **Windows / Linux**：左侧紧贴侧边栏无留白，右侧强制预留 **`120px`** 净空 (`var(--ds-window-controls-width)`) 给原生最小化、最大化与关闭按钮，主界面任何内容或面板拖拽区不得覆盖此 120px 区域。
- **元素排列（从左至右）**：
  1. 折叠展开按钮（侧边栏折叠时呈现于最左侧，展开时隐藏）；
  2. 面包屑导航 (`IconFolder` + 项目名 + `/` + 会话标题)，会话标题支持悬停微变与双击就地重命名；
  3. 右侧操作区：`IconNewSession` (`+`)、`IconSearch` (`Q`)、`IconSidebarRight` (`[|]`)，各按 28×28px 方块排列。

---

### 2.2 左侧会话与项目侧边栏 (Sidebar)
- **对应截图**：`REF-001`, `REF-016`, `REF-020`, `REF-021`
- **尺寸范围**：
  - 默认展开宽度：`275px` (`--ds-settings-nav-width`)；
  - 允许拖拽调节范围：`240px` (`SIDEBAR_WIDTH_MIN`) 至 `520px` (`SIDEBAR_WIDTH_MAX`)；
  - 自动折叠阈值：向左拖动宽度小于 `160px` 时，触发自动完全折叠至视口外 (`0px`)，但记忆用户先前调整的展开首选宽度；
- **垂直层级分布 (Flex Column)**：
  1. **Header (46px)**：左侧品牌图标与字标 (`BrandLogo` 20px + `PI-Desktop`)，右侧折叠按钮；
  2. **会话分组 (Sessions Section)**：固定标题 `会话` (`--text-sm`)，下挂当前活动的无项目临时会话或独立对话项；
  3. **项目树分组 (Projects Tree Section)**：
     - 固定标题 `项目`；
     - 项目条目：带折叠三角、文件夹图标、项目名、活跃运行状态指示灯（橙色呼吸点 / 计数徽标）、右侧 `•••` 悬停更多操作按钮；
     - 展开状态下支持会话子树嵌套排版；
  4. **弹性空白区 (`flex: 1`)**：吸收垂直多余高度；
  5. **Footer (固定底栏)**：
     - 水平对齐工具图标组：设置图标 (`IconSettings`)、插件中心图标 (`IconPlug`)、定时自动化图标 (`IconClock`)、通知中心铃铛 (`IconBell`，带未读小红点)；
     - 右侧版本指示器：`v0.21.0`（有可用更新时变为高亮并提示更新）。

---

### 2.3 中央主舞台与对话流 (MainChat & Transcript)
- **对应截图**：`REF-001`, `REF-016`, `REF-017`, `REF-021`
- **尺寸约束与排版**：
  - 弹性系数：`flex: 1; min-width: 450px;`（当视口宽度极端受压时，主区保护最小 450px，侧边栏优先折叠）；
  - 主内容居中约束容器：`max-width: min(100%, var(--chat-content-max-width, 760px))`，水平自动居中 (`margin: 0 auto`)；
- **模式形态划分**：
  1. **Home 空状态模式 (`home-main-content`)**：
     - 垂直布局：`hero → optional onboarding checklist` 顺次向下排列；
     - 视口高度自适应：窗口较矮时（`<= 760px`），整体顶部对齐并支持内部滚动，禁止内容被输入框遮挡；
  2. **Thread 对话流模式 (`thread-scroll`)**：
     - 垂直滚动列表，底部预留浮动输入框的高度的 `padding-bottom`（约 140px ~ 180px），使最末条消息滚动到底部时完全裸露在输入框上方；
     - 独立右侧用户消息气泡 (`max-width: 720px`) 与左侧全宽助手 Prose 回复。

---

### 2.4 底部浮动输入框 (Floating Composer)
- **对应截图**：`REF-001`, `REF-015`, `REF-016`, `REF-021`, `REF-022`, `REF-024`
- **几何布局与浮动定位**：
  - **Thread 模式**：绝对定位在主区底部 `bottom: 0; left: 0; right: 0;`，内部采用 `padding: 0 24px 16px;`，背景完全透明；
  - **Home 模式**：作为空状态内容滚动区下方的常规 Flow 节点，底外边距 24px；
  - 内部容器居中：`width: min(100%, 768px); margin: 0 auto;`；
- **高度自适应机制**：
  - 初始单行文本：高度约为 `44px`；
  - 随着多行输入：在 `3lh` 至 `7lh` 之间动态自动撑高；
  - 超过 7 行（约 160px）时：输入框高度锁定，内部 textarea 开启垂直滚动条；
- **输入框内部上下两层结构**：
  1. **上层 (Input Stage)**：
     - 文件引用胶囊行（当有 `@path` 引入时挂载于文本上方）；
     - 多行纯净可编辑输入区 (`.composer-input`)，完全消除默认外边框与聚焦外描边；
  2. **下层 (Toolbar Row)**：
     - 左侧功能群：附件添加 (`+`)、智能体模式下拉 (`智能体 v` / `规划 v` / `目标 v`)、权限策略下拉 (`每次询问 v` / `全自动 v`)；
     - 右侧状态群：Token 进度环 (`O 99%`)、模型选择器 (`deepseek-flash v`)、发送/停止按钮 (`28×28px`)。

---

### 2.5 右侧工作面板 (WorkPanel)
- **对应截图**：`REF-003`, `REF-018`, `REF-019`
- **分栏与尺寸控制**：
  - 初始展开宽度：`380px` ~ `480px`，可通过左边缘拖拽把手在 `344px` 至 `视口剩余宽度 - 450px` 之间连续拉伸；
  - 双击拖拽把手：自动恢复至标准推荐宽度；
- **最大化预览模式 (Preview Mode)**：
  - 点击 Tab 右侧 `^/` 按钮进入最大化预览；
  - 此时中间的主对话区暂时卸载，工作面板占据整个右侧可用视口（与侧边栏并排），用于代码 Diff 全屏对比或复杂 Web 应用调试；
- **Tab 条与内容区域**：
  - Tab 头高度 46px，支持横向平滑滚动；
  - 每个 Tab 独立携带关闭图标；
  - 内容区支持多种子视图挂载：`ReviewTab`（代码审阅）、`BrowserTab`（网页与自动化）、`FilesTab`（工程文件树）、`SubagentTab`（子代理执行监控）。

---

### 2.6 全屏接管设置中心 (Full-Page Settings Layout)
- **对应截图**：`REF-004` 至 `REF-012`
- **全屏架构**：
  - 当打开设置时，主界面的三栏结构被完全替换为全屏 `SettingsPage`，彻底消除原有的项目和对话列表；
  - 设置页面由**左侧 275px 固定导航栏**与**右侧全屏滚动内容面板**两部分组成：

```text
+------------------------+----------------------------------------------------------------+
| [Traffic Light / Drag] | [Settings Content Drag Strip: 46px] -------------------------- |
| Settings Nav (275px)   | Settings Content (flex: 1)                                     |
|                        |                                                                |
| - 搜索设置输入框 (32px)| - 页面主标题 (text-2xl, margin-bottom: 28px)                   |
| - 导航分组列表 (滚动区)| - 设置卡片流 (.settings-card-block)                            |
|   - 偏好 (4项)         |   - 组标题 (.settings-card-heading)                           |
|   - 智能体 (5项)       |   - 卡片主体 (.panel-card, --ds-tile)                          |
|   - 工作区 (1项)       |     - 设置行 (.settings-row)                                   |
|   - 系统 (3项)         |       - 标签与说明 (左) + 控件 (右)                            |
| - 底部固定返回按钮     |                                                                |
|   (< 返回应用, 32px)   |                                                                |
+------------------------+----------------------------------------------------------------+
```

- **导航栏与内容对齐规则**：
  - 左侧导航栏与右侧内容区拥有各自独立的顶部 46px 拖拽区域，颜色分别与各自背景保持一致，绝不跨列串色；
  - 底部 `< 返回应用` 按钮（32px）与主界面的 Footer 图标条处于完全相同的物理基线，切换设置时用户视线不跳跃。

---

### 2.7 模态弹窗与浮层系统 (Modals & Floating Overlays)
- **对应截图**：`REF-013`, `REF-014`, `REF-015`, `REF-020`, `REF-022`, `REF-023`, `REF-024`
- **挂载层级规范**：
  - 统一挂载在 DOM 根节点独立容器 `#pi-desktop-overlays`（`z-index: 40 ~ 60`），脱离可能具有 `transform` 或 `overflow: hidden` 的父级，防止定位裁剪；
- **模态弹窗 (Modals, e.g. REF-013, REF-014)**：
  - 全屏遮罩：`position: fixed; inset: 0; background: var(--ds-scrim);`；
  - 弹窗卡片：居中对齐，`width: min(100%, 780px); max-height: calc(100vh - 48px); overflow-y: auto;`；
- **浮动弹出层 (Popovers, e.g. REF-015, REF-022, REF-023, REF-024)**：
  - 采用 Anchored 定位算法，动态计算触发器相对于视口的坐标；
  - 自动边界检测：优先在输入框上方（`bottom: calc(100% + 8px)`）展开；若上方视口空间不足，自动翻转至下方；
  - 水平方向自动对齐或居中，确保不超出屏幕左右边缘至少 8px 安全间距。

---

## 3. 滚动条统一规范 (Scrollbar Geometry)

所有可滚动容器（侧边栏、对话消息流、设置内容区、文件树）遵循统一的**静默隐形滚动条**契约：

```css
/* 仅针对 webkit / chromium 内核定制，杜绝经典双轨道 */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: var(--radius-full);
  transition: background var(--motion-duration-fast) var(--motion-ease-out);
}
/* 仅在鼠标悬停或处于滚动状态时显现 */
*:hover::-webkit-scrollbar-thumb,
*[data-scrolling="true"]::-webkit-scrollbar-thumb {
  background: color-mix(in oklab, var(--ds-text-primary) 18%, transparent);
}
::-webkit-scrollbar-thumb:hover {
  background: color-mix(in oklab, var(--ds-text-primary) 32%, transparent);
}
```
- 禁止在容器上设置 `scrollbar-width` 或 `scrollbar-color`，避免浏览器降级至操作系统原生粗丑滚动条。
- 采用 `scrollbar-gutter: stable` 预留槽位，避免滚动条出现时引起内容宽度抖动。
