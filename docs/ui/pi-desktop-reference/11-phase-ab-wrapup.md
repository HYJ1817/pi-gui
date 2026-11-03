# PI-Desktop 阶段 A 与阶段 B 最终工程收尾与核验报告

## 一、任务背景与解决概况

本轮完成阶段 A、B 的最终工程收尾工作（验收基线 `d853aa4f`）。严格保持既有 UI 不再重构，重点完成：
1. **消除硬编码路径**：在 `tests/settings-headings-electron.cjs` 中消除硬编码路径 `C:\pi-GUI`，改用基于 `__dirname` 的项目相对路径与标准 `require('electron')` 模块解析。
2. **增加 npm 测试脚本**：在 `package.json` 中添加 `"test:settings:electron": "node tests/settings-headings-electron.cjs"`，保证在任意检出目录均可一键运行。
3. **窗口控制与原生拖拽保障**：对顶部原生拖拽区域（`-webkit-app-region: drag`）与系统窗口控制覆盖层（`titleBarOverlay`）完成自动化与运行时双重验证，确认未受任何破坏。
4. **全量自动化验证**：定向运行 `npm run test:primitives`、`npm run test:theme`、`npm run test:auth`、`npm run test:settings:electron`、`npm run test:ui` 及 `npm run test:ci`，记录准确数字。
5. **记录外观页外层容器差异**：对比并记录当前 pi-GUI 外观页与 PI-Desktop 原版在外层容器层级上的差异，留待后续统一视觉收尾，本轮不擅自扩大修改范围。

---

## 二、测试脚本跨环境支持与硬编码修复

在 `tests/settings-headings-electron.cjs` 中：
- **消除绝对路径**：原 `require('c:\\pi-GUI\\node_modules\\electron')` 与 `const ROOT = 'c:\\pi-GUI'` 替换为：
  ```javascript
  const ROOT = path.resolve(__dirname, '..');
  const child = spawn(require('electron'), [__filename, '--no-sandbox'], { env, stdio: 'inherit', windowsHide: true });
  ```
- **工作区与测试环境隔离**：使用相对于项目根目录的相对解析，使该脚本无论在任何盘符、任何目录、工作树（Worktree）或 CI 沙箱下均可直接由 `node` 或 `npm run` 驱动。
- **package.json 接入**：在 `scripts` 中注册：
  ```json
  "test:settings:electron": "node tests/settings-headings-electron.cjs",
  ```

---

## 三、窗口控制区与拖拽行为验证（无破坏确认）

根据 Electron 配置与样式规范：
1. **原生拖拽区（`-webkit-app-region: drag`）**：
   - 顶部 46px 的 `.stage-head` 元素继续保留全局定义的 `-webkit-app-region: drag`，计算样式实测 `appRegion: "drag"`、高度精确为 `46px`、`top: 0`。
   - 在设置模式下，`.stage-head` 的背景设置为无缝透明融入背景 `var(--ds-bg-primary)`，无底边框或阴影；
   - 内部仅渲染窗口控制避让，原工作面板面包屑与面板切换按钮在设置模式下已设为 `display: none !important`，不会在顶部形成无法拖拽的残留按键区域。
2. **原生窗口控制区（`titleBarOverlay`）**：
   - Windows/Linux 系统的原生最小化、最大化、关闭三键由 Electron 的 `titleBarOverlay` 在顶层接管绘制（位于窗口右上角宽约 138px、高 46px 区域）；
   - 页面内的任何文本、卡片或交互按钮均严格避开该区域，大标题处于 `y = 66px`（完全在 46px 原生条下方），窗口控制按钮完全可点，交互与系统双击放大/还原行为不受任何影响。

---

## 四、当前外观页与 PI-Desktop 原版的外层容器差异备忘

为保持阶段 A、B 收尾边界，不在本轮擅自重构架构，特记录外观页容器层级现状与原版差异，供后续阶段统一视觉收尾：

| 维度 | PI-Desktop 原版 (`features/settings/SettingsPage.tsx`) | 当前 pi-GUI 实现 (`public/settings.js` + `public/ui/settings-surface.js`) | 后续统一收尾建议 |
| :--- | :--- | :--- | :--- |
| **页面布局模型** | **全屏单路由一体化组件**：整页包含左侧固定宽度设置导航轨（`.settings-rail`，275px）与右侧统一滚动正文区（`.settings-content`），点击左侧各 Tab 仅切换右侧内嵌 React 组件，外层容器不重挂。 | **工作区表面切换模型**：复用既有工作区多视图生命周期（`openWorkSurface('settings')`），先展现总览磁贴表面（`.settings-surface`），点击后由 `presentDetail` 在 `#workSurface` 中挂载 `.settings-detail`，并令项目侧边栏附加 `.settings-mode`。 | 后续在阶段 C/D 可考虑将设置表面直接固定为双栏常驻布局，减少切入详情页时的容器切换感知。 |
| **外层卡片封装** | 直接在右侧内容流中使用独立 `<section class="settings-card">` 分组，外层**无**任何 Modal 遗留类名。 | 复用既有通用弹层与页面结构，在 `.settings-detail` 容器下挂载了带有 `modal-card settings-detail-card` 的 `<section>`，并通过 CSS（`background: transparent !important; box-shadow: none !important; border: none !important;`）将其弹层属性完全抹平为纯流式容器。 | 后续可将 `.modal-card` 历史类名从 `presentDetail` 模板中彻底解耦，改用专用 `.settings-detail-canvas`。 |
| **主题选择器控件** | 使用带深/浅色界面缩略图的大尺寸可点击分段卡片（Segmented Theme Cards / Radios）。 | 使用原生圆角下拉选择框 `.ds-select`（`dark` / `light` / `system`），与下方字体、缩放行保持一致的行级键值控件。 | 保留行级控件，后续在视觉大收尾阶段可引入带微缩示意图的段落式单选卡片。 |
| **滚动容器持有者** | 由右侧正文面板容器 `.settings-content` 独立持有 `overflow-y: auto`。 | 由上层工作表面容器 `#workSurface` 统一承接纵向滚动。 | 现有方式符合 pi-GUI 工作区统一滚动模型，无需变动。 |

---

## 五、自动化测试完整执行记录

所有套件均使用生产配置在本地执行，实测数字如下：

| 测试指令 | 包含范围 / 模块 | 实际执行数字 | 状态 |
| :--- | :--- | :--- | :--- |
| `npm run test:primitives` | Primitives 单元测试 + 设置验收测试 | 6/6 基础单测通过，15/15 真实模块集成断言通过 | **PASS (100%)** |
| `npm run test:theme` | 主题控制器、渲染器同步与系统事件响应 | 47/47 全部通过，0 失败 | **PASS (100%)** |
| `npm run test:auth` | 供应商凭据防泄露、安全投影与 OAuth 状态 | 105/105 全部通过，0 失败 | **PASS (100%)** |
| `npm run test:settings:electron` | 真实 Electron 页面标题、层级位置与拖拽区域实测 | 5/5 全部通过，大标题精确在 y=66px，拖拽区正常 | **PASS (100%)** |
| `npm run test:ui` | 前端全流程 Smoke 冒烟套件 | 1338/1338 全部通过，0 失败 | **PASS (100%)** |
| `npm run test:ci` | CI 计划 233 节点覆盖、契约、工作流与 NSIS 检查 | 233 节点精确通过，30/30 汇总，28/28 文档范围，16/16 发版证明，12/12 安装编译器 | **PASS (100%)** |
