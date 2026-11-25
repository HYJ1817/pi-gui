# 第二阶段精选渲染证据

2026-11-25；before HEAD `032b96659faee5d2a1252fbb744b2da4c5f3ef3d` 上的工作区产品状态，包含 I1–I3、字面文件名、旋转 PDF 锚点、HTML 无效 CSP 和 PDF ResizeObserver 修复。均为离线 TEMP fixture，没有用户文档、凭据或模型调用。图片已逐张实际打开审阅；不是合成、jsdom 或模拟预览。

## 来源及步骤

| 代表图 | 实际入口与动作 | 视口/主题及边界 |
| --- | --- | --- |
| [Files 窄窗](files-700-dark.png) | 重建 resources/app 的生产 renderer；真实指针打开 guide.md 后失焦 | CSS 700×600、DPR 1.5、深色；树/标签使用中性选中背景和 semibold，无持久白弧线；中文/英文 Markdown、KaTeX、实际本地 PNG |
| [Files 宽屏](files-1320-light.png) | 同上，实际主题桥切换浅色 | CSS 1320×820、DPR 1.5、浅色；与窄窗同一业务/样式路径 |
| [键盘焦点](keyboard-700-dark.png) | 同一重建资源，真实 Tab/Shift+Tab 导航至标签 | CSS 700×600、DPR 1.5、深色；单道 2px focus-visible 是保留的无障碍指示，不是持久选中装饰 |
| [PDF 恢复](pdf-reading-restored.png) | TEMP manifest 观察 bootstrap 加载字节不变的正式 main；打开旋转第4页、手动缩放，跨标签再返回 | CSS 1320×820、DPR 1.5、深色；保存/恢复均69%、pageOffset 均 `0.4007937476748512`。截图取在断言后的观察时点，随后适宽动作可能已更新工具栏为44%；不得用截图数值代替状态断言 |
| [PPTX 第2页](pptx-page2.png) | 同一正式 main 观察专项；真实解析两张幻灯片，切至第2页和75%后跨标签返回 | CSS 1320×820、DPR 1.5、深色；实际文字/shape，opaque allow-scripts iframe；局部横向滚动；不代表全保真或分发许可获准 |
| [ZIP 内 TSV](zip-tsv-member.png) | 同一正式 main 观察专项；从 tabular.zip 成员入口打开 table.tsv | CSS 1320×820、DPR 1.5、深色；实际 Worker 表格显示中文TSV和84，不是文本摘要；嵌套ZIP仍拒绝 |

## 运行身份

- Files/焦点：`%TEMP%/pi-preview-desktop-trczoU/evidence`，155 项 renderer 检查 + 1 项父进程清理 = **156/156**；33,433ms，正常 sandbox，观察12个进程身份、残留0。
- PDF/PPTX/ZIP：`%TEMP%/pi-preview-packaged-p4nq4U/evidence`，79项生产交互 + 9项父资源/进程检查 = **88/88**；交互21,310ms，正常 sandbox，观察11个进程身份、残留0。
- Electron44.4.3 / Chromium152.0.7977.130；正式 main/preload/backend/public 字节保持不变，无 CDP 或沙箱绕过。后者不是无观察 bootstrap 的原样 manifest 启动、安装或升级证明。
- 其余宽窄×深浅组已实际运行并目视审阅，完整35张/17张及结构诊断留在上述 TEMP；不整套入库。
- 源码安装生成入口的后续变更不改变这些产品渲染逻辑；最终构建身份、测试/审查覆盖与未验证项以[验收材料](../../unified-file-viewer-acceptance.md)为准。历史白框首次失败见[专项记录](../../unified-file-viewer-selection-fix.md)。

本目录只证明图中实际画面及对应运行。完整 canonical、法律批准、合并和发布各自独立。
