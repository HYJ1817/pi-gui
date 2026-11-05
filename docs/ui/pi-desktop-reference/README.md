# PI-Desktop 视觉与交互逆向分析与 pi-GUI 设计规范文档库

## 1. 总体项目背景与任务目标

本项目旨在通过对 **PI-Desktop**（官方 Electron 桌面客户端）的真实运行截图（24 张高清完整截图）以及官方前沿源码（Git Commit [`92ae661f1e399e69d514086b46029b4c34ba1a92`](https://github.com/vastsa/PI-Desktop/commit/92ae661f1e399e69d514086b46029b4c34ba1a92)，版本 `v0.21.0`）进行系统性逆向分析，建立一套完整、精确、可落地、可检验的 UI/UX 设计规范。

最终目标：让 **pi-GUI** 在视觉语言、分栏布局、基础组件、交互手感与深浅色模式上**尽可能逼近 PI-Desktop 的工业级专业水准**，同时**100% 完整保留 pi-GUI 自身所有已有的功能特性**（包括 Planner、审批流、撤销恢复、Collab 画布、Git 管理、诊断日志等），并保证 pi-GUI 现有的原生 JavaScript + Electron + Node.js 架构不被破坏。

---

## 2. 证据基准与资料版本说明

### 2.1 本地参考截图与尺度校准
- **存放路径**：`C:\Users\21022\OneDrive\图片\pi-desktop`
- **文件数量**：共 **24 张**（`Snipaste_2026-10-31_23-10-09.png` 至 `Snipaste_2026-11-01_10-42-22.png`）
- **图片规格与实测尺度**：物理像素为 `1808 × 1204`（3 张）与 `1808 × 1205`（21 张）PNG；经对全部 24 张 PNG 的 `pHYs` 块解析及 Electron 实测，DPI 为 **143.99 DPI (≈ 144 DPI)**，系统缩放比例为 **150% (devicePixelRatio = 1.5)**。
- **换算基准**：**`物理像素 = CSS 像素 × 1.5`**。设置导轨 275 CSS px 对应 412.5~413 物理 px，顶栏 46 CSS px 对应 69 物理 px，控件 28 CSS px 对应 42 物理 px。
- **主题分布**：深色 20 张 (`REF-001` ~ `REF-020`)，浅色 4 张 (`REF-021` ~ `REF-024`)。
- **编制标识**：在文档中统一编目为 `REF-001` 至 `REF-024`。

### 2.2 目标项目与参考源码基线
- **目标项目**：`HYJ1817/pi-gui` @ Commit SHA: `f4e6591e22206a4a0b2447292003fdf4eaf21c03`
- **参考项目**：`vastsa/PI-Desktop` @ Commit SHA: `92ae661f1e399e69d514086b46029b4c34ba1a92` (版本 `v0.21.0`)
- **源码永久链接格式**：`https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/...`
- **开源许可证边界**：PI-Desktop 为 LGPL-3.0，pi-GUI 为 MIT。严格实施独立净室重构，仅提取设计事实参数与交互规格，以原生 ES Modules 及原生 CSS 独立全新编写，严禁复制代码。

---

## 3. 文档体系索引与导航

本参考规范库共包含以下 10 份专项规范文档、1 份结构化参考代币表以及 1 份人工审查处置追踪表：

| 序号 | 文档名称 | 核心内容概述 |
|---|---|---|
| **01** | [`01-screenshot-inventory.md`](01-screenshot-inventory.md) | 全部 24 张参考截图清单、尺寸、主题、界面状态、可见元素与 6 大场景分类编目 |
| **02** | [`02-source-mapping.md`](02-source-mapping.md) | 穿透至深层实现组件的逐张截图源码映射表、证据等级全景表 (19 已验证 / 5 部分验证) |
| **03** | [`03-design-tokens.md`](03-design-tokens.md) | 完整色彩代币（保留/补齐/修改/推断说明）、D297 无分割线细化准则、排版标尺与圆角阶梯 |
| **04** | [`04-layout-specification.md`](04-layout-specification.md) | 46px 连续标题栏、275px 侧边栏、弹性主舞台、浮动 Composer、工作面板及全屏设置布局 |
| **05** | [`05-component-specification.md`](05-component-specification.md) | 基础控件（Button、Input、Toggle、SegmentedControl）与复杂业务构件规范及 GitHub Permalinks |
| **06** | [`06-interaction-specification.md`](06-interaction-specification.md) | 页面切换、会话管理、悬停动作、右键菜单、折叠动效、斜杠/文件补全、Token 检查器与快捷键矩阵 |
| **07** | [`07-pi-gui-gap-analysis.md`](07-pi-gui-gap-analysis.md) | 对照 pi-GUI 真实实现 (`settings-surface.js`, `workspace-surface.js`)、三级功能映射矩阵与净室边界 |
| **08** | [`08-implementation-roadmap.md`](08-implementation-roadmap.md) | 六阶段渐进重构路线图，详尽规定复用模块、新增模块、废弃旧样式、状态影响、回归测试与截图验收 |
| **09** | [`09-visual-acceptance-criteria.md`](09-visual-acceptance-criteria.md) | 确认环境参数 vs 估算参数区分、浅色模式双轨验收准则（截图比对 vs 源码规范比对）、阻断性判定 |
| **10** | [`10-audit-resolution.md`](10-audit-resolution.md) | 人工审查（含终审源码一致性与工程事实核验）逐项核查处置记录与统计表 |
| **11** | [`11-phase-ab-wrapup.md`](11-phase-ab-wrapup.md) | A/B 收尾、PR #49 基线与已验收边界 |
| **12** | [`12-phase-c-implementation.md`](12-phase-c-implementation.md) | 阶段 C 源码勘察、复用取舍与执行记录 |
| **13** | [`13-phase-c-acceptance.md`](13-phase-c-acceptance.md) | 阶段 C 测试、真实 Electron 截图、逐区域视觉差异与交付状态 |
| **14** | [`14-phase-d-implementation.md`](14-phase-d-implementation.md) | 阶段 D 源码勘察、业务取舍与单代理实施记录 |
| **15** | [`15-phase-d-acceptance.md`](15-phase-d-acceptance.md) | 阶段 D 实测、逐区域视觉对照、构建及未验证边界 |
| **16** | [`16-phase-e-implementation.md`](16-phase-e-implementation.md) | 阶段 E 工作台源码勘察、取舍与单代理实施计划 |
| **17** | [`17-phase-e-acceptance.md`](17-phase-e-acceptance.md) | 阶段 E 真实 Electron、原生 Browser、视觉差异与验证边界 |
| **附录** | [`tokens.reference.css`](tokens.reference.css) | 提取自 PI-Desktop 源码并完成审计补齐的独立纯 CSS 代币表，附带完备分类与工程说明 |

---

## 4. 后续开发 Agent 使用指南

1. **设计采集与正式实施分开**：本目录最初的采集阶段只交付规范；A/B 已通过 PR #49 合并，阶段 C 按用户正式授权实施。后续阶段仍须有明确任务范围，不能从本目录推导额外业务、推送、合并或发布许可。
2. **严格按序分阶段推进**：
   - 必须先完成 `Phase A`（代币与基础原语），方可开启 `Phase B`（设置中心）与 `Phase C`（主外壳）；
   - 禁止在未建立 `--ds-*` 代币体系前去零敲碎打地修改某个按钮颜色。
3. **真实运行截图验收**：每一个阶段重构结束后，必须在 `1808 × 1204` 窗口下截取实际运行界面，对照 [`09-visual-acceptance-criteria.md`](09-visual-acceptance-criteria.md) 中的条目自查，并在验收报告中出具确凿证据。
4. **功能零丢失与禁增伪入口**：针对 pi-GUI 特有的 Planner、Approvals、Collab 等功能，开发 Agent 必须严格按照 [`07-pi-gui-gap-analysis.md`](07-pi-gui-gap-analysis.md) 的适配方案进行视觉升级，严禁删改其底层的业务与通信逻辑；严格禁止在 pi-GUI 中堆砌无后端支持的死按钮或虚假界面。
