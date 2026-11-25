# 2026-11-26 最终复验：代表性真实截图

Windows 11，Electron 44.4.3 / Chromium 152.0.7977.130，正常 sandbox。
本目录 11 张图全部来自**同一次**最终产物运行 `pi-preview-packaged-oZyex5`
（production main / preload / backend，字节一致；只替换 TEMP 副本的 manifest 观测入口），
不是从历史运行搬运，也不是源码版或 jsdom 渲染。源运行资格
`packaged-production-main-normal-sandbox`：132/132 通过，123 条桌面交互断言，
33 张原始 `webContents.capturePage()` 截图，11 个受观察进程退出后残留 0，32,995 ms。

产物与代码状态：

- 采集时 Git HEAD：`cba8398260a7272eca14a3a57d027dc3634f3ca1`，**加上本次未提交的修复**
  （文件树滚动/折叠、会话身份时序、许可与构建脚本、测试与验收文档）。最终提交 SHA 见
  [验收报告](../../surface-final-acceptance.md)，不以本目录自引用。
- `build/Pi GUI.exe`：121,608,704 bytes，SHA-256
  `68737337527d508e2e80bd9b4ccb2b0cf6988e5cf57d0555eff0f4d4efb3b3b8`
- `dist-app/Pi GUI-win32-x64/Pi GUI.exe`：246,324,736 bytes，SHA-256
  `71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f`
- App 内 backend bundle：3,873,898 bytes，SHA-256 `35a0a4618080194001463d2c3fc4ba6e4d9e418ab1137f36e38bef35ac6905e5`
- `public/`：660 files / 19,067,121 bytes，树摘要
  `f0efbf678d8a9573683c379dcab28984210db802cc179046f2868ffdc1a3dcb3`
- 字体许可原始归档在 staging、打包 App 与源 `public/` 三处字节一致；发布仍被
  字体对应源码未闭合阻断（见 [字体许可核验](../../pdf-font-license-verification.md)）。

| 图 | 覆盖要求 | 真实操作与证据 |
| --- | --- | --- |
| [01 Launcher 深色](01-launcher-dark.png) | 深色空面板；标题居中、紧凑工具列表、键帽背景；无旧固定工具图标、无空标签 | 请求 1320×820，DPR 1.5；断言 `titleAlign=center`、键帽有填充、`.work-surface-tab` 数量 0、无多余说明文案 |
| [02 Launcher 浅色](02-launcher-light.png) | 浅色同上 | 同次运行切换主题后重测，断言相同 |
| [03 顶部无旧工具/空标签](03-top-no-old-tools.png) | 顶栏不残留旧固定工具图标或空 Surface 标签 | Launcher 获得可信键盘焦点后的顶栏；与 01/02 的 0 tab 断言同源 |
| [04 多 Surface 标签栏](04-multi-surface-tabs.png) | 多个 Surface 同时存在时的标签栏 | Files + Specs + Terminal + Browser 均为真实活动实例；重排、方向键、Delete、关闭右侧/其它均有独立断言 |
| [05 关闭最后一个 Surface](05-last-close-launcher.png) | 关闭最后一个 Surface 后回到 Launcher，不留下空标签 | 真实关闭最后一个 tab；断言面板仍打开、`.work-surface-tab` 为 0、Launcher 出现 |
| [06 正常宽度查看器 + 右树](06-viewer-1320-dark.png) | 统一查看器正常宽度、右侧文件树、紧凑工具栏 | 打开 TEMP 内真实 `guide.md`；公共最大化几何误差 ≤2px，文档无横向溢出，聊天 DOM inert |
| [07 700px 窄窗](07-viewer-700-dark.png) | 窄窗查看器与工具栏，无突兀横向滚动条 | `toolbarOverflow ≤ 1` 且 overflow-x 不为 auto/scroll；活动 tab 无底边线、无 `::after` |
| [08 真实 PPTX 项目符号](08-pptx-real-bullets.png) | 自建 PPTX 项目符号在真实 Office 软件中也可用 | 真实 LibreOffice 生成并保存的 `libreoffice-bullets-mixed.pptx`；渲染出实际圆点标记，记录文件 SHA-256 |
| [09 真实 PPTX 多级编号](09-pptx-real-multilevel.png) | 多级项目符号/自动编号 | `libreoffice-autonum-multilevel.pptx`；断言 1./a./i./2./3./•/◦/▪ 各级标记真实绘制 |
| [10 真实幻灯片第二页](10-pptx-real-slide.png) | 幻灯片预览不是文本占位 | 同次运行打开第二页；真实 OOXML→SVG/DOM，页码/文本/形状/图片与缩放恢复均有断言 |
| [11 PDF 未嵌入字体](11-pdf-unembedded-font.png) | 未嵌入字体 PDF 正常显示 | fixture 只含 `/BaseFont /Helvetica` 且无 `/FontFile[23]?`；打包产物中实际渲染 |

全部 PNG 保留原始像素，不缩放、裁切或拼接。字节数与 SHA-256 见 [manifest.json](manifest.json)。
上一级目录中 2026-11-25 的图片与说明是**历史证据**，已被本目录取代，不得当作最新提交的运行效果；
旧 manifest 的源运行 `pi-preview-packaged-F9IKLx` 与当前代码状态不同。
