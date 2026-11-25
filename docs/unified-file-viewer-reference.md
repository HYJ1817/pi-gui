# 统一文件查看器第二阶段：独立参考调研

> 调研日期：2026-11-25。任务只读取参考源码、归档最小现成媒体并写本文，不运行参考项目、不安装包、不修改产品代码。T3 Code 为主要交互参考，PI-Desktop 为补充；pi-GUI 的 [全局 UI 规范](ui/design-system.md)、[文件授权与打开边界](file-links.md) 优先，不把外部产品的写权限、安全模式或品牌照搬过来。
>
> **取证状态：T3 与 PI-Desktop 的 main 分支浅 sparse checkout 均已完成。PI-Desktop 全历史/全仓库 blobs 未下载（`--filter=blob:none`），仅 checkout 与任务相关的 file-manager 插件、host work panel 代码、ADR 和现成媒体；克隆/checkout 过程中未运行参考代码或安装依赖。**

## 1. 基线、方法与可复查路径

pi-GUI 调研起点为 `032b96659faee5d2a1252fbb744b2da4c5f3ef3d`，`feat/unified-file-viewer` 初始工作区干净。已执行 `git fetch origin`；当次 `origin/main` 与该 SHA 相同，最新 Release 为 `v0.35.1`。准确 SHA 的 CI [45455659169](https://github.com/HYJ1817/pi-gui/actions/runs/45455659169) 在查询时仍为 `in_progress`，**不是已通过证明**。本任务只改调研文档和静态参考媒体，按文档验证跳过完整 `npm test`，不要求构建应用；不对并行实施代理的修改作验收。

遵循的入口：`AGENTS.md`、`REVIEW.md`、`docs/README.md`、`docs/ui/design-system.md`、`docs/file-links.md`、`docs/security.md`；另核对 `public/index.html` 的实际 CSS 加载顺序、现有 `files-panel.js` / `file-preview/*` / `files-tree.js` / `files-tabs.js` / `files-layout.js`、`server/files.js` / `lib/file-preview-policy.js` 和第二阶段协作契约。

| 项目 | 本次取得的 main SHA | 本地只读参考目录 | 取得方式 |
| --- | --- | --- | --- |
| T3 Code | `6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17` | `C:\Users\21022\AppData\Local\Temp\unified-viewer-t3-dVduNL` | `git clone --depth 1 --single-branch --branch main --no-recurse-submodules` |
| PI-Desktop | `8ac4a9f495d5b1e5fa7957acdf157aa9567462bc` | `C:\\Users\\21022\\AppData\\Local\\Temp\\unified-viewer-pi-desktop-sparse-GjECV1`（clone 元数据 + 取证需要的源码/API 文件） | 首次 shallow clone 超时；第二次 `--filter=blob:none --no-checkout` 已创建正确 shallow HEAD，但 checkout 稀疏大树时 fetch promisor blob 因 60 秒低速限制而失败；随后只读获取精准目标源码文本与媒体 |

两仓库使用 `os.tmpdir()` 下各自全新的空目录，没有复用 `.t3-ref`。从当前 pi-GUI worktree 运行系统 Git/gh 和仅用 Node 内置模块的文件复制/摘要计算；未从参考仓库 cwd 启动解释器、构建、测试、安装或应用。参考仓库的 README/脚本只是被调查对象，不是执行指令。

证据等级：

- **源码已核实**：实际读取该精确 commit 的分派函数及其 renderer/worker，不只看扩展名、图标或 README 宣传。
- **仓库现成视觉资料**：只归档上游已经存在的图片，保留原字节；不声称它们是本次运行截图。
- **未运行**：外部应用真实渲染、格式 fixture 的运行测试、不同 OS/codec 兼容性均未验证；源码可进入某 renderer 不等于每个文件都能保真渲染。

## 2. 先给实施结论

1. **复用 pi-GUI 现有入口，不另起文件授权系统。** `openFileReference`、Files Surface、tabs、树选中/祖先展开、行定位、grant 账本及过期请求守卫已存在。第二阶段最合理的增量是独立“受控资源读取 + 类型门控 + 懒加载 renderer + 生命周期”层，而不是重写外部打开/授权。
2. **T3 的“完整”是多个真实 renderer，不是一个 iframe。** 工作区与附件最终共享格式组件，专用分支包括 Office、PDF、图片、媒体、归档、SQLite、字体、Mermaid 等。Office 内部还分 OpenXML worker/canvas 与扩展文档投影，不能把“支持 Office”笼统写成支持任意 DOC/XLS/PPT。
3. **主视觉应借鉴信息层级而非品牌皮肤。** 文件 tabs → 面包屑/少量上下文动作 → 主内容；文件树可调整/可关闭。T3 当前代码把树放在预览**右侧**，不要凭 IDE 印象宣称是左侧树。pi-GUI 可以按现有 Surface 保留自己的方向和窄窗行为。
4. **必须偏离 T3 的写路径与 HTML 执行模式。** T3 有文本编辑、自动保存、Markdown task checkbox 写回，以及可运行脚本的 HTML sandbox；pi-GUI 本阶段只读，普通 HTML/SVG 不得获得受信 DOM 或应用能力。附件的“保存/移除草稿”、远端执行/WSL/SSH、跨 Surface 浏览器也不是默认可移植功能。
5. **实现前先找对 CSS 所有者。** 基线 `public/index.html:25` 加载 `ui4-pane.css`，`:37` 后加载 `file-links.css`。面板布局/树实际在 `ui4-pane.css:696–734`，tabs/preview 覆盖在 `file-links.css:160–357`；不是凭文件名推测的 `work-surfaces.css`。新增样式仍用公共 Token/按钮/菜单，不创建第二套控件体系。

## 3. T3：许可证、声明和移植边界

- [LICENSE，L1–21](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/LICENSE#L1-L21)：MIT，版权 **Copyright (c) 2026 T3 Tools Inc.**。复制代码或实质性片段时应保留版权、完整 MIT 许可及免责条款，不能只写一个“参考 T3”链接。
- [README 的许可证/品牌说明，L106–121](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/README.md#L106-L121) 和 [TRADEMARK，L1–25](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/TRADEMARK.md#L1-L25)：MIT 只覆盖源码，不授予名称、wordmark、logos、应用图标、branding 或 trade dress 权利。公开派生产品使用自己的品牌，清楚声明非官方/无隶属/无背书；本文是事实性工程对照，不授予外观/媒体复用许可。
- 本次没有向产品复制 T3 代码。后续若实际移植 MIT 片段，建议在对应源码注明项目、精确 SHA、原始路径/修改情况，并把完整许可收进本项目既有第三方声明体系；依赖本身的许可证须单独核对，不能推定 `@betteroffice/*`、PDF.js、解码器、字体等都随根 MIT 一起授权。
- 已归档的 README 媒体只作来源明确的本机工程对照，不作 pi-GUI 的产品素材、logo 或发布宣传；上游未在根许可中单独授予品牌/媒体权利，公开再分发图片需额外核实权利，不因“存在于开源仓库”就扩大解释。
- 交付整理：两张上游媒体留在本机被忽略的 `docs/unified-file-viewer-evidence/reference/`，**不提交/推送图片**；公开 PR 只保留下方精确上游链接、尺寸、摘要及取证说明。本项目自己运行生成的 TEMP fixture 验收截图另行归档，两者不能混为一类。

## 4. T3：打开、树、tabs、附件调用链

以下链接全部锁定本次 SHA，不指向浮动 `main`。

| 边界 | 实际路径与源码证据 | 核实的行为 |
| --- | --- | --- |
| 消息文件引用 | [MarkdownFileLink.tsx L122–132](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/chat/MarkdownFileLink.tsx#L122-L132) | 有 thread/panelPath 时进面板，媒体可进直接预览，无法内部预览时走外部编辑器；不是一律系统打开。 |
| 统一 Surface 身份 | [rightPanelStore.ts L312–328](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/rightPanelStore.ts#L312-L328)、[L1006–1080](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/rightPanelStore.ts#L1006-L1080) | 工作区文件 id 是 `file:${relativePath}`，附件是 `attachment:${id}`，同属 `kind:file`；打开保留 thread/environment scope，重复文件更新 reveal request。附件名不是磁盘授权路径。 |
| Surface 装配 | [RightPanelSurfaceContent.tsx](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/chat/RightPanelSurfaceContent.tsx)、[FilePreviewPanel.tsx L1707–1937](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/FilePreviewPanel.tsx#L1707-L1937) | 文件/附件 Surface 在既有右面板中呈现；workspace 分支会复用 `AttachmentFilePreview` 处理文档资源。 |
| 文件树 | [FileBrowserPanel.tsx L306–344](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/FileBrowserPanel.tsx#L306-L344)、[L570–706](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/FileBrowserPanel.tsx#L570-L706) | compact、初始关闭、空目录链压平、hide-non-matches 搜索、加载目录图标；选择文件单击打开，重复点已选文件仍可打开；右键菜单与拖入 Composer 的 mention 链独立，不允许拖放移动磁盘文件。 |
| 树与内容同步 | [FileBrowserPanel.tsx L510–566](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/FileBrowserPanel.tsx#L510-L566) | 外部打开文件会展开祖先并揭示选中项；刷新不重复夺焦/关搜索。wheel/pointer/touch/key 会停止自动追踪，避免用户滚动时被强制拉回。 |
| 面包屑与动作 | [FilePreviewPanel.tsx L1580–1687](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/FilePreviewPanel.tsx#L1580-L1687)、[FileBreadcrumbs.tsx](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/FileBreadcrumbs.tsx) | 可横向滚动的路径列；外部编辑器/文件管理器、源码/渲染、换行、复制、浏览器、树开关按当前类型出现，非所有文件堆同一排功能。 |
| Tabs 交互 | [RightPanelTabs.tsx L908](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/RightPanelTabs.tsx#L908)、[L1101–1122](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/RightPanelTabs.tsx#L1101-L1122)、[L1287–1398](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/RightPanelTabs.tsx#L1287-L1398) | 6px 指针位移才开始拖动重排；中键关闭；右键含关闭/关闭其它/关闭右侧/全部关闭，工作区文件可复制路径。它是多种 Surface 共用 tabs，不宜把整个 store 引入 pi-GUI。 |
| 草稿附件 | [ComposerAttachmentStrip.tsx](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/chat/ComposerAttachmentStrip.tsx)、[AttachmentFilePreview.tsx L100–177](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/AttachmentFilePreview.tsx#L100-L177) | `Blob` 或授权 asset，两种 transport 复用一种 renderer；本地 URL 创建时就注册清理，卸载 revoke。草稿可移除，已有附件通过 id 取资源，不从附件原始 path 读磁盘。 |
| 内容获取与释放 | [AttachmentFilePreview.tsx L178–243](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/AttachmentFilePreview.tsx#L178-L243) | 新请求清空前一个 URL/error、迟到结果丢弃、AbortController 取消；远端 URL 可刷新；大文本与有限文本分流。 |
| 外部编辑器 | [OpenInPicker.tsx](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/chat/OpenInPicker.tsx)、[externalLauncher.ts](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/server/src/process/externalLauncher.ts) | “内部预览”与“交给其它程序”是独立动作。pi-GUI 已有对应第一阶段实现，应复用自己的结构化 argv/安全白名单，而非搬远程启动链。 |

### 4.1 源码可量化的几何与交互

数值为源码 CSS/Tailwind 默认 rem=16 换算，不是本次浏览器测量；系统缩放或根字体改变时实际像素可变化。

| 元素 | T3 当前源码值 | 证据 |
| --- | --- | --- |
| 整个内联右面板 | 默认 540px，最小 360px；最大 `min(视口 × .7, 容器 - 360px)` 后保证不少于 360px | [usePreviewPanelInlineSize.ts L13–18、68–73](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/hooks/usePreviewPanelInlineSize.ts#L13-L73) |
| 文件树列 | 默认 256px、最小 160px、最大 560px；内容预留 256px；树在正文右侧，有独立可调宽度偏好 | [FileExplorerPane.tsx L9–60](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/FileExplorerPane.tsx#L9-L60)、[FilePreviewPanel.tsx L1902–1937](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/FilePreviewPanel.tsx#L1902-L1937) |
| 树宽键盘调整 | 分隔条可 Tab 聚焦；ArrowLeft/Right 每次 16px、Home 最小、End 最大，带 aria-valuemin/max/now | [FileExplorerPane.tsx L80–110](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/FileExplorerPane.tsx#L80-L110) |
| 文件 subheader | 标准 40px；inline 模式 28px、底部分隔线透明、下留 12px；横 padding 12px、动作 gap 8px | [fileSurfaceChrome.tsx L11–12](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/fileSurfaceChrome.tsx#L11-L12) |
| 树工具栏 | 标准 40px，inline 模式 36px；padding-x 8px，gap 4px；搜索字段 28px；刷新和展开/折叠 | [FileBrowserPanel.tsx L94–138、597–637](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/FileBrowserPanel.tsx#L94-L138) |
| 文件 tab | 高 24px、最大宽 144px、12px 字号，active 中性 accent 面；横向溢出滚动，尊重 reduced-motion | [RightPanelTabs.tsx L1112–1116、1196–1203](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/RightPanelTabs.tsx#L1112-L1203) |
| 图标动作 | 14px 图标，Ghost button/toggle + tooltip，有 aria-label/pressed/disabled；不是自定义大按钮 | [fileSurfaceChrome.tsx L62–102](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/fileSurfaceChrome.tsx#L62-L102) |
| 树文字/状态 | 树字体 `.75rem`（12px）、currentColor 12% 选中/7% hover；超长名称保留完整 accessible label，截断才加 native title | [pierre-tree-theme.ts L3–45](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/pierre-tree-theme.ts#L3-L45) |
| 附件 Markdown 阅读列 | max-w-4xl（896px），padding-x 24px、padding-y 20px；不保留工作区 cwd 以免附件相对路径冒充工作区授权 | [AttachmentFilePreview.tsx L317–324](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/AttachmentFilePreview.tsx#L317-L324) |
| 图片工具栏与缩放 | 工具栏 min-height 40px；fit 给图像留 32px 总缓冲且不默认放大原图，缩放步长 ×1.25、范围 5%–800%；fit/实际大小/点击大图对话框 | [PreviewImageContent.tsx L38–143](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/PreviewImageContent.tsx#L38-L143) |
| PDF 工具栏与页面 | min-height 40px、允许换行；当前页/总页、上一页/下一页、缩放、fit-width、112px 搜索输入；白纸在 muted 阅读底面，页左右至少 16px；只渲染可见页 | [PdfViewer.tsx L470–635](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/PdfViewer.tsx#L470-L635) |
| 扩展文档阅读页 | 15px/1.65 正文、最大 860×zoom px；常规 padding 32px，≤420px 时 20px；阅读字号缩放 50%–200%、步长 25% | [DocumentPages.tsx L96–149](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/DocumentPages.tsx#L96-L149) |

迁移时**不硬抄数值**：pi-GUI 工具栏公共 `.icon-btn` 为 28×28、标准/紧凑按钮 32/28px，字号、焦点、颜色取现有 Token；保留四组宽/窄×深/浅真实渲染验收要求。尤其 T3 源码 12px 弱色不能自动当作 pi-GUI 已满足对比度。

### 4.2 实际格式矩阵：逐个核对分类和消费端

分类权威为 [filePreview.ts L15–169、186–241](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/packages/shared/src/filePreview.ts#L15-L241)，实际分派为 [AttachmentFilePreview.tsx L288–407](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/AttachmentFilePreview.tsx#L288-L407) 和 [FilePreviewPanel.tsx L1725–1898](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/FilePreviewPanel.tsx#L1725-L1898)。MIME 不是随意忽略的：rich format 的明确 MIME 优先，generic/空 MIME 才主要按后缀推断；分类不是字节安全校验。

| 格式 | 本次源码确认的实际预览 | 边界/不可扩大宣称 |
| --- | --- | --- |
| 文本与源代码 | `ReadOnlySourcePreview` / `@pierre/diffs`，大文本用 worker 索引/虚拟表；换行和复制；1MiB 普通文本阈值 | [UTF-8 decoder](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/packages/shared/src/filePreview.ts#L135-L183) 拒绝 NUL、非 UTF-8；不是通用编码查看器。workspace 同时有可写编辑分支，不能照搬。 |
| Markdown `.md/.markdown/.mdown/.mkd/.mdx` | 渲染/源码切换，沿用 ChatMarkdown；workspace 大文档分块 | MDX 按 Markdown 阅读，不编译执行 React；workspace task checkbox 能写回，pi-GUI 只读需剔除。 |
| Mermaid `.mmd/.mermaid`、`text/vnd.mermaid` | lazy `MermaidFilePreview`，源码/图形切换 | 不因存在图标就当任意 diagram 都支持。 |
| CSV/TSV | `filePreviewDelimiter` → `DelimitedTablePreview` → `LargeTextViewer` → `VirtualTablePreview`，可切源码/表格 | 属于分隔文本，不是 XLS；不能只 split 行/逗号，需正确处理引号和跨行。 |
| HTML `.html/.htm` | `BrowserDocumentFrame`，源码/页面切换，普通文件与 `htmlRender` 是不同模式 | 普通 frame 允许 scripts/forms/popups/downloads 但无 same-origin；pi-GUI 安全策略更严格，不能直接复用 permissions。 |
| PDF | 浏览器原生 PDF plugin 或 lazy PDF.js；Electron 不启用插件，走 PDF.js、canvas/text layer、可见页虚拟化、页/缩放/搜索、页内/外链 | [BrowserDocumentFrame L119–145](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/BrowserDocumentFrame.tsx#L119-L145) 排除 iOS 原生路径；PDF.js 最多 2000 页，搜索有 4MiB 文本预算；不是 Office iframe。 |
| DOCX | `OfficeFilePreview` → `OfficeViewer` → `OpenXmlOfficeViewer` → `office/WordDocument` → document worker，`@betteroffice/docx` layout/render，canvas + 可选文本层 | 源码存在真实页/字体/图片处理，不是只读 document.xml 的粗略文本；不表示支持 `.doc/.docm`、任意宏或绝对保真。 |
| XLSX | 同上 → `office/Spreadsheet` / `spreadsheet.worker`，`@betteroffice/xlsx`，可视区域绘制、sheet 导航 | 只读预览引擎，不表示 `.xls/.xlsb`/宏执行；协议上限 250000 行/1024 列，不保证所有图表/公式一致。 |
| PPTX | 同上 → `office/Presentation` / presentation worker，`@betteroffice/pptx`，幻灯片/页面绘制 | 不是 `.ppt/.pptm`；不宣称播放动画、视频或演讲者功能。 |
| ODT/ODS/ODP | `officePreview.worker` → `extendedDocumentPreview.openDocument`，ODT 页/ODP slide HTML 投影、ODS sheets/虚拟表 | 与 OpenXML 三种**不同 renderer**，ODF 表格投影上限 500行×50列；不是 LibreOffice 级原版排版。 |
| RTF | `openRtf` 解析与文档页；`application/rtf` / `text/rtf` / `.rtf` 的 rich 路径 | 是有界纯解析，不启动系统 RTF 程序；不是 DOC。 |
| EPUB | `openEpub` 读取 ZIP container/package/spine，章节导航，经净化 HTML 页面阅读 | 不执行 EPUB scripts/远端资源；不表示支持 PDF 以外其它电子书如 MOBI/AZW。 |
| IPYNB | `openNotebook` → lazy `NotebookPreview`，markdown/code/raw cells 和已保存 text/image/HTML output | 展示已有结果，不运行 kernel、不重算 Notebook；不是任意 JSON。 |
| 常规图片 | `.avif/.bmp/.gif/.ico/.jpeg/.jpg/.png/.svg/.webp` → `PreviewImage`/`img`，fit/actual/zoom/大图 | SVG 放 `img` 不是 innerHTML；AVIF 等仍取决于浏览器解码。 |
| HEIC/HEIF/TIF/TIFF | 同一 `AttachmentImage`，原生失败再 lazy `decodeImagePreview` → image worker | [AttachmentImage L9–62](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/media/AttachmentImage.tsx#L9-L62) 明确有解码兜底，不可当浏览器天然支持；worker 30s 超时且卸载 terminate。 |
| 音频 | `.mp3/.wav/.ogg/.oga/.flac/.aac/.m4a/.opus/.aiff/.webm-audio/.weba` → `AudioPreview` | [mediaPreview L54–66](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/packages/shared/src/mediaPreview.ts#L54-L66) 是候选列表，codec 依浏览器/OS，不保证每一项播放。 |
| 视频 | `.avi/.m4v/.mkv/.mov/.mp4/.ogv/.webm` 或明确 `video/*` → workspace MediaVideoPlayer / attachment 原生 `video controls playsInline` | [video.ts L3–25](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/packages/shared/src/video.ts#L3-L25) 只作分类；没有看到通用容器转码承诺，MKV/AVI 更不能写“已验证可播放”。 |
| ZIP/JAR/TAR/GZIP/TGZ | `BinaryFilePreview` → `BinaryViewer` → binary worker，归档目录/大小/时间；成员打开 UTF-8 文本或图片 | [binaryPreview.worker L225–260](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/binaryPreview.worker.ts#L225-L260)：ZIP/JAR、TAR 和 gzip/tgz 有实际分支；不支持 RAR/7z；成员里的 HTML/Markdown/Mermaid 按源码显示，不递归执行 renderer。 |
| SQLite `.sqlite/.sqlite3/.db` | binary worker 内 lazy sql.js/WASM；表选择/50条分页、最多100表、最多50列、单元文本截到1024字符，blob显示大小 | [binaryPreview.worker L167–224](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/binaryPreview.worker.ts#L167-L224)：`query_only=ON`、`trusted_schema=OFF`，无 SQL 编辑执行器；`.db` 后缀并不证明内容为 SQLite。 |
| 字体 `.ttf/.otf/.woff/.woff2`、`font/*` | lazy `FontFilePreview` → `FontViewer`，FontFace 实际校验/样张 | 不能把 `.otf` 的 MIME 混淆（Linux 可判为 ODF formula template）当作成功读取；字体解析自身仍是攻击面。 |
| 其它 | 明确 No preview + 保存/其它程序打开 | 扩展名图标、多媒体 MIME 前缀或操作系统关联，不等于当前内联 renderer 支持。 |

关键 renderer 入口：[OfficeViewer L31–69](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/OfficeViewer.tsx#L31-L69)、[OpenXmlOfficeViewer L13–149](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/OpenXmlOfficeViewer.tsx#L13-L149)、[officePreview.worker L10–44](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/officePreview.worker.ts#L10-L44)、[extendedDocumentPreview](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/extendedDocumentPreview.ts)、[PreviewImageContent](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/PreviewImageContent.tsx)、[LargeTextViewer](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/LargeTextViewer.tsx)。

### 4.3 安全与资源模式：哪些可借鉴、哪些不能直接照搬

| 模式 | 已核实的实现证据 | 对 pi-GUI 的约束 |
| --- | --- | --- |
| 格式分类与真实 bytes 分开 | [filePreviewKind](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/packages/shared/src/filePreview.ts#L38-L95) 只按 name/MIME，worker 再解析 | 后缀只能选 renderer；文件头、类型、大小、归档预算必须独立 gate，不把分类结果当授权。 |
| 有期限 exact-file asset | [AssetAccess.ts L75–167](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/server/src/assets/AssetAccess.ts#L75-L167)、[验签/过期 L975–988](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/server/src/assets/AssetAccess.ts#L975-L988) | T3 有 1h TTL、workspace/media/attachment 不同 claims；不是 pi-GUI 的原生人工 grant 账本。pi-GUI 保留自己的会话绑定、撤销即失效、对象身份复核，不引入另一套签发权。 |
| 同一已检查 descriptor 读媒体 | [MediaFile.ts L47–98、126–139](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/server/src/assets/MediaFile.ts#L47-L139) | lstat → O_RDONLY/O_NOFOLLOW → fstat/realpath → 再 lstat；identity/dev/ino 检查，revision 含 size/mtime/ctime；这与 pi-GUI 的既有守卫方向相同，仍不是消除 TOCTOU 的证明。 |
| 小入口 + lazy 重模块 + worker | [AttachmentFilePreview L52–66](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/AttachmentFilePreview.tsx#L52-L66)、[OfficeViewer L96–162](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/OfficeViewer.tsx#L96-L162)、[decodeImagePreview L9–39](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/decodeImagePreview.ts#L9-L39) | 可借鉴一次预览实例拥有请求、worker、timer、ObjectURL 的释放；文档解析不进 Electron main；切换/关闭/撤销都 terminate/abort/revoke，旧异步响应不得重新挂载。 |
| 有界 Office/归档 | [officePreviewProtocol L4–6](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/officePreviewProtocol.ts#L4-L6)、[boundedZip L5–73](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/packages/client-runtime/src/zip/boundedZip.ts#L5-L73) | 50MiB 原文件/展开总量、2048 entries、压缩比 200，流式累计而非仅信 central directory；单成员 UI 10MiB。pi-GUI 仍需自身更严格的路径穿越/设备名/符号链接/加密/重复头验证，不能宣称 T3 所有路径策略自动继承。 |
| ODF/EPUB 输出净化 | [extendedDocumentPreview L42–74](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/extendedDocumentPreview.ts#L42-L74)、[DocumentPages L9–64、97、129–149](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/DocumentPages.tsx#L9-L149) | 拒绝不受支持的 XML 声明/实体、不解析外部 DTD，XML 长度/深度/节点数有上限；DOMPurify 白名单，只留 data raster images；iframe CSP `default-src 'none'`。这类“投影 + inert 展示”比直接塞原始 HTML 更适合本阶段。 |
| HTML sandbox | [BrowserDocumentFrame L278](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/BrowserDocumentFrame.tsx#L278)、[L445–459](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/BrowserDocumentFrame.tsx#L445-L459) | T3 普通文件用 opaque-origin frame，但允许 scripts/forms/popups/downloads；htmlRender 允许 scripts/forms。**不适合无决策照搬**：pi-GUI 普通文件用无脚本、无导航、无外网、无 host bridge 的隔离/净化模式，相对引用也走受控授权。 |
| HTML postMessage | [BrowserDocumentFrame L55–77、445](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/BrowserDocumentFrame.tsx#L55-L77) | 它明确把页内键盘转发限制成“改变可见阅读界面”的命令；页面可伪造任意 key。pi-GUI 不可把 postMessage 当可信用户手势，不允许创建 grant/执行/写文件。 |
| PDF.js 本地资源 | [pdfDocument L1–49](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/apps/web/src/components/files/pdfDocument.ts#L1-L49) | worker、CMaps、标准字体和 WASM 走构建产物本地资源；不能把 T3 的 Vite `?url`/glob 配置照抄进 pi-GUI 零构建 ESM；须做本地 vendor/worker 路径并保留第三方许可，无 CDN。 |

### 4.4 可直接借鉴的抽象

- **资源描述不携带特权**：workspace、external grant、attachment Blob 是不同来源；把读取能力注入 renderer。renderer 不自己拼磁盘路径、不查全局当前会话、不签发授权。
- **统一 Surface chrome，格式只贡献工具区/内容区**：标题路径、tabs、打开方式属于面板；图片/PDF/sheet/slide 的导航动作按类型显示，错误/加载/空态由同一公共层呈现。
- **一份 owner + 一份 dispose**：切换前读阅读状态，释放实例，再创建新实例；记住页/缩放/scroll，不在 tabs/localStorage 长期保留原始内容/Blob/grant。
- **类型覆盖要有三个状态**：已有实际 renderer、明确不支持、未验证 codec/保真；在说明与测试中分开，不能“后缀在列表里 = 全部通过”。
- **导航不会偷偷编辑**：T3 的阅读/编辑相邻，pi-GUI 要把文本 contenteditable、Markdown checkbox、autosave、文件树 mutation、附件保存写盘功能从本阶段边界中排除。

## 5. PI-Desktop：许可证、文件管理器边界及与 T3 的不同取舍

- **根仓库 LGPL-3.0，不等于整个 PI 桌面应用或截图的许可。** 精确 main 的 [根 LICENSE](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/LICENSE) 是 GNU LGPL v3。需使用、改编、链接或打包 PI 项目代码时，须由维护者逐个确认具体文件/依赖的许可与 LGPL 对派生/链接/再分发的义务，按要求提供对应源码、许可通知及可替换/重新链接机制；不能把整个 PI 应用称为 MIT，或只按 UI “灵感”认定仓库一律可复制。建议本轮将 PI 用作行为/几何事实参考，避免复制插件实现。
- PI 内置 vendored `pi.file-manager` 插件自身 `apps/desktop/resources/plugins/pi.file-manager/LICENSE` 为 MIT，Copyright (c) 2026 Tioit-Wang；可读核验的正文 SHA-256 `ebaec3ae096498a39f6b86e3ac8017e39818fb5aaff80b452349f94bc275ec0d`。这是插件子目录许可，不替换根仓库许可；插件视图中的 PDF.js另有第三方 notice：`views/assets/pdfjs-LICENSES.txt`。任何复制都要保留插件声明并逐项审核捆绑 PDF.js/CodeMirror/其它库，不要把整个 minified `assets/index.js` 当“MIT 单文件”拿来改。
- `apps/desktop/resources/plugins/pi.file-manager/UPSTREAM.md` 将仓库插件 pinned upstream main 说明为源版本 `0.13.0`，bundled copy 有本地补丁/桌面差异（包含 runtime/checksum），所以 main 不是未改动的原始上游插件快照。可复核 [UPSTREAM.md](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/UPSTREAM.md) 的插件上游来源和构建说明。

参考仓库实际路径：

| 边界 | 精确源码 | 核实事实 |
| --- | --- | --- |
| Bundled 插件主进程 | [main.js L1–40](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L1-L40) | 插件明确自己承担路径/真实路径包含、拒绝 symlink/junction escape、敏感凭据排除、写入原子性与冲突检查；不把 host broker 误当做插件进程 Node 文件访问的强制沙箱。项目 root group 是“一个当前 root 一把窄门”，不是 root 全组并集。 |
| 文件 transport/type 列表 | [main.js L42–139](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L42-L139) | `node:fs/promises` 从插件主进程读 workspace；图片 SVG 只放到 img-context；image/media 类型由明列 extension allowlist 选，不能因为扩展广宣称支持更多 codecs。 |
| 状态和目录树偏好 | [main.js L142–160](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L142-L160)、[prefs validation L3797–3800](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L3797-L3800) | splitRatio 初值 `.32`，clamp `0.15..0.7`；树默认展开、打开文件请求能收起树；以插件用户 prefs 保存。此为独立用户设置，不能覆盖 pi-GUI 已有 surface/sidebar/tabs 状态所有者。 |
| 读取分支与大小策略 | [main.js L2824–2955](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L2824-L2955) | SQLite 检查魔数后只给 DB metadata/paged API，可很大；XLSX 限 8MiB 并只投影表格文本；PDF 24MiB，普通图片 8MiB，音视频 24MiB，文本 2MiB；`kind` 是 text/image/media/pdf/sqlite/tooLarge/binary 一类的小集合，并非完整 Office renderer 注册表。 |
| XLSX 解包 | [main.js L54–68](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L54-L68)、[L2716 onwards](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L2716-L2810)、[read branch L2856–2900](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L2856-L2900) | 8MiB 压缩包、单 part 解压 32MiB、最多8 sheets/5000 rows/60 columns/80,000 cells/单格2000字符/派生文本2MiB；不读 VBA、不运行宏；读取源与 derived preview 明确只读。较 T3 的“视觉 Office renderer”更保守：它是数据投影，不做 Word/PowerPoint 高保真排版。 |
| 文件写操作 | [main.js L2995–3070](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L2995-L3070) | PI file manager 是可写产品：atomic temp+fsync+rename；mtime/size 冲突门控；XLSX derivation 第二道 READ_ONLY 拒绝。pi-GUI 当前阶段明确不引入这些 write/create/rename/move/delete 入口。 |
| Workspace group / remote | [README L3–24](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/README.md#L3-L24)、[L51–89](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/README.md#L51-L89)、[remote-workspace.js](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/remote-workspace.js) | PI 特有路径：会话可以切项目组根；SSH 通过 Host `pi.fs.list/readPreview` 而非此机 Node 文件系统，文本512KiB/图片5MiB、remote read-only 且禁 search/git/watch/edit/local-app；failed list 显示 Retry。pi-GUI 没有同类 SSH/Host root 契约，不应抽取装饰性入口或把路径 fallback 到本地。 |
| Viewer 构建/依赖 | [README L135–156](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/README.md#L135-L156)、[`views/index.html`](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/views/index.html) | 源码是 React/TS/Tailwind/CodeMirror 6，IIFE 将动态 import 内联，解决 Electron `file://` 下 module/crossorigin 问题。不能整段复制其 React UI、Tailwind/CodeMirror/PDF bundle 进 pi-GUI 的原生零构建 ESM、无新增依赖约束。 |
| Host tabs | [work-panel-tabs.ts L1–50](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/src/lib/work-panel-tabs.ts#L1-L50)、[L185–237](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/src/lib/work-panel-tabs.ts#L185-L237)、[L298–347](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/src/lib/work-panel-tabs.ts#L298-L347) | 文件 tab id 基于规范化 path、重复文件复用；mime、line、column 为请求元数据；工作区文件 Surface 与 plugin singleton 分离；session context 独立保存 tabs。适合对照 keyed identity，但并非拿它覆盖 pi-GUI 当前 `openFileReference` 生命周期。 |
| Tab reorder | [work-panel-tab-reorder.ts L1–40](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/src/lib/work-panel-tab-reorder.ts#L1-L40) | 8px arm threshold，左右 edge 32px、每帧 max 12px autoscroll；pi-GUI 自己选用现有 pointer/keyboard 可访问约定即可，不必复刻数字。 |
| Dock / resize | [work-panel.css L8–30、L88–127](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/src/styles/work-panel.css#L8-L127)、[work-panel-resize.ts L1–40、L128–179](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/src/lib/work-panel-resize.ts#L1-L40) | 最低 panel 244px、默认360px，聊天主区 floor 450px，fit budget 时先收左侧 sidebar；dock 与 conversation 的边界靠 token surface 而非 divider；10px hitbox、32px visual drag handle、hover/focus-visible/active 可见。 |
| PI file-manager 内树/内容分割 | [main.js L142–160](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L142-L160)、[prefs clamp L3797–3800](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L3797-L3800)、[README L64](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/README.md#L64) | 左文件列表初始占插件视图宽度的 32%，按偏好比例限在15%–70%；拖动记住比例，左树可隐藏/恢复并保留先前宽度；宿主发起打开文件可主动收树。它与外层 work-panel 宽度（默认360/min244）是两级不同 resize owner。bundle 中没有公开的未编译 view CSS/source 子树，故未从压缩后的 UI bundle 推断行高/分隔条像素。 |
| Host tabs menu / sizes | [work-panel-tabs.ts](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/src/lib/work-panel-tabs.ts)、[work-panel.css L180–240](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/src/styles/work-panel.css#L180-L240) | Host 主面板 tab strip 高32px；surface tab 92–180px×28px，gap6；这里是多 Surface header，不要同文件内容内的 file tabs 混淆。 |

### 5.1 PI-Desktop 实际格式清单（按 main.js 和 README 逐条取证）

PI 当前 bundle 与 README 描述可核实的**文件管理器**格式包括：

- **常规文本/代码**：2MiB 上限、NUL 检查/UTF-8 读取；README 声称离线语法高亮覆盖 TypeScript/TSX、JavaScript/JSX、JSON、Markdown、CSS family、HTML/Vue/XML、YAML/TOML、Python/Go/Rust/Java/C-family/Kotlin/Scala/Dart/Objective-C/PHP/Ruby/Lua/Shell/PowerShell/SQL/Dockerfile/Diff（README 的项目功能说明；当前 reader 文本事实不能单独证明每个 language plugin 的 token 行为）。
- **Markdown**：只在用户选 Markdown preview 时渲染；源码目录相对图片通过受控 bounded bridge 取；README 明确远端图片 URL、绝对路径、文档外部旁边图片留 alt placeholder，文档预览不自动授予网络或新路径访问。
- **CSV/TSV**：解析进表格，README 说明支持 quote/escaped quote/字段内换行/CRLF/ragged rows，默认表头；可回源码；只读/可编辑行为按文件类型不同。不能从截图推断 parser。
- **JSON/JSONC/JSON5**：源码视图可切 JSON folding tree；parse 失败时保留错误与源码，不把格式化当数据源。
- **XLSX/XLSM/XLTX/XLTM**：reader 真正只分支 `.xlsx`，限制压缩/展开预算和表规模，派生表格文本 read-only；对“支持 xlsm”不可照 README 宽泛描述：源码的 `.xlsm` 出现在写入拒绝集合，不代表 `.xlsm` 有解析 renderer；传统 `.xls` 没此分支。
- **PDF**：24MiB reader 上限；bundle 内置 pdf.js worker/CMaps/fonts/WASM/ICC，连续页、single/double/two-page-cover layout、页导航/缩放 10%–400%、fit-width、缩略页/目录/metadata sidebar、文字层选择复制与全文搜索；扫描页无 OCR。PDF.js 资源离线捆绑见 [README L68–70、144–150](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/README.md#L68-L70)。README 为具体能力来源，未由本次运行复验。
- **图片**：`.png/.jpg/.jpeg/.gif/.webp/.avif/.bmp/.ico/.svg`；8MiB。TIFF/HEIC 未在 allowlist，不应按 T3 能力替 PI 宣称支持。SVG 经 `<img>` 上下文，不能作为可信 HTML DOM 插入。
- **音视频**：视频 `.mp4/.m4v/.mov/.webm/.ogv/.mkv`、音频 `.mp3/.m4a/.aac/.wav/.flac/.ogg/.oga/.opus/.weba`，24MiB；播放器不自动播放，实际 codec 仍取决于环境，README 的格式名单不等于此 Windows 本次 codec 实测。
- **SQLite**：SQLite header magic 判定，独立 paged API/只读状态；项目源码还列出 query/read APIs。README 声称只读 query tab 与上下限。本机未运行 worker、未装模块、不验证 SQLite 解析库行为。
- **二进制/其它**：README 明示 ZIP/APK/EXE 提示不支持内联解包；没有通用 Office/ODT/EPUB/字体/压缩归档 renderer。README 的格式视觉图标也不代表可预览。

源码顶部的实际容量常量见 [main.js L47–77、L88–116](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L47-L116)，主文件类型 dispatch 见 [main.js L2824–2955](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/apps/desktop/resources/plugins/pi.file-manager/main.js#L2824-L2955)。README 的 PDF/表格/UI 功能不是本任务现场运行验证；PI 与 T3 格式矩阵不能合并成“二者皆支持”。

### 5.2 PI-Desktop 对照后的具体取舍

- PI 在 PDF 上展示远强于 T3：可双页、导航缩略图/书签、更多搜索规则，并约束文档 24MiB；能借鉴的是工具栏层级、页导航和生命周期合同，不是直接移植 PDF bundle 或重新引入 pdf.js 包。
- PI `.xlsx` 与 T3 是两种值得保留的方案：PI 用主进程有限解包投影、无 Office renderer、更严格缩减格式/资源复杂性；T3 用 worker 与 canvas 显示 docx/xlsx/pptx/ODF 专用页面。pi-GUI 的实施契约提 Office renderer 时，应按依赖体积/离线产物/威胁面决策，不要声称“PI 也支持 DOCX/PPTX”或“所有 Office 只需列个扩展名”。
- 两者皆展示树 + 阅读区 + 独立文件 Surface，但 PI 插件为“文件管理器”而不只是 viewer：编辑、Git、watch、搜索、写入/重命名/移动/删除；这些整体功能与权限不能作为 viewer 细节顺手引入。
- PI 的插件主进程拥有实际 Node fs 能力，并为此自担 jail；这跟 pi-GUI server 内部已有授权后端/主进程 grant 账本的所有者模型相反。不要从插件里复制 `node:fs` 读取模式到 pi-GUI renderer 或加第二条 backend bypass。
- PI 根仓库 LGPL-3.0 的法律分析应由维护者/法律顾问按具体复用方式确认；本调研不能给完整衍生作品许可意见。调研/视觉事实和源码代码复制是不同问题；最安全的参考方式是照 pi-GUI 设计规范重写，而不是把 PI code/content/css/image 字节带进产品。

## 6. 上游现成视觉材料（不是本次运行截图）

### REF-T3-01：README 主媒体

- 本机取证档案：`docs/unified-file-viewer-evidence/reference/t3-readme-hero.webp`，不入 Git；公开读者使用下一行精确上游链接。
- 精确来源：[上游 `.github/readme/hero.webp`](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/.github/readme/hero.webp)，由 [README L20–23](https://github.com/pingdotgg/t3code/blob/6c0621f78aeb574f139a1ee1a7bdcdc239a2bb17/README.md#L20-L23) 直接引用。
- 原始尺寸 **2000×1367**，文件 **145746 bytes**；SHA-256 `b7a242afa2f4bec419cd0403f21e2ee1c75cc47e6e6af9d675bec39ab6a2fbc1`；与临时克隆源字节对比 `identical=true`。
- 用途：对照 T3 整体中性表面、阅读层级、附件/文件引用与工作区连续性。**图里没有打开文件查看器**，且为桌面+手机的 README 合成媒体，不可拿它量出文件树、tabs、PDF 或 Office 的实际尺寸，也不当作当前 commit 真实运行验收。
- 本次只原样复制，没有裁剪、标注、缩放后另存或重绘。DPR/截屏环境未知，页面显示可等比缩小，不能拿图片物理 px 冒充 CSS px。

### REF-PI-01：文件管理器页

- 本机取证档案：`docs/unified-file-viewer-evidence/reference/pi-desktop-panel-files-zh.webp`，不入 Git；公开读者使用下一行精确上游链接。
- 精确来源：[PI-Desktop `panel-files.webp`](https://github.com/vastsa/PI-Desktop/blob/8ac4a9f495d5b1e5fa7957acdf157aa9567462bc/docs/public/screenshots/app/zh/panel-files.webp)，Git blob `a4629324d2b40e73b8c5fe6ab378b3af72343c93`。Web API 原文件为 26,094 bytes；本地 SHA-256 `8c8e445a336bba782fd4986964f73c6c19c71141466a4e5c1035a9eb643492e1`，尺寸 1600×1067。
- 它是源码库中的正式界面媒体（非本任务实际运行截图），截图里文件管理入口处于**未打开项目的空态**（“打开项目后即可浏览文件”），没有展示树、表格或文件预览器；仅可对照 PI-Desktop 的整体 light chrome、右工作面板及空状态比例，不可据此声称它证明了文件面板布局，更不可用作新版本/本地环境截图验收或从像素猜 CSS px/DPR。
- 媒体权限与传播范围受益素材权利约束；请将它仅用于本仓库内调研，不假设 PI-Desktop 根许可证或 vendored plugin MIT 对截图本身授予再分发权。没有访问既有档案引用的 OneDrive 私有图，没有合成截图。

## 7. 与当前 pi-GUI 实现的核对（移交给实现/审查代理）

当前 worktree 已有较完整的第二阶段骨架；下列事实是从本地源码直接核对的，不是 T3/PI 猜测：

| 当前抽象 | 本地证据 | 结论/实施提示 |
| --- | --- | --- |
| 统一入口与单 live preview | [files-panel.js L47–130](../public/files-panel.js)、[file-preview/index.js L9–130](../public/file-preview/index.js) | `openFileReference` → Files Surface；tabs 只保留 bounded request/reading state；切换时 `dispose`，AbortController、owned disposers、ObjectURL 统一释放；这正是可借鉴的 T3 owner/dispose 结构，不要在格式插件里另存原始 bytes。 |
| 类型到插件 | [file-preview/access.js L4–18、21–49](../public/file-preview/access.js)、[index.js L9–18](../public/file-preview/index.js) | 当前实际注册 text/markdown/html/pdf/office/image/media/archive；Office 明确只分 docx/xlsx/csv/tsv/pptx；archive policy 只直接预览普通 ZIP；不是把 T3/PI 的完整格式列表自动合并。 |
| 文本阅读 | [file-preview/text.js L4–48](../public/file-preview/text.js) | 目前有 100,000 行上限、虚拟窗口 180 行、搜索 10,000 matches、行号/换行/编码/复制/行定位；属于真实已实现能力，需接入本阶段截图和回归。 |
| 图片/媒体 | [image.js L3–21](../public/file-preview/image.js)、[media.js L1–69](../public/file-preview/media.js) | image parser 有 header/dimension/frame/pixel budget；media 不自动播放、恢复位置、释放 decoder/Range；当前策略扩展名比 T3/PI 更宽的部分仍必须以 header/codec 实测为准。 |
| PDF | [pdf.js L3–8、26–67](../public/file-preview/pdf.js) | 32MiB、1200 页、page/resident/text/search/time budgets；本地 vendor PDF.js，源码里有单页/缩放/fit/search/outline 状态，接近 T3/PI 的 shared viewer 目标。 |
| Office | [office.js L4–71](../public/file-preview/office.js)、[office-policy.js](../public/file-preview/office-policy.js) | Worker 解包/解析，DOCX/PPTX 页面、XLSX/CSV/TSV grid；active content/external links/XML/timeout 有错误码；不能把 Office MIME 识别当作 parser 成功。 |
| HTML/Markdown 安全 | [html.js L44–121](../public/file-preview/html.js)、[markdown.js L41–112](../public/file-preview/markdown.js) | HTML 走 DOMPurify allowlist + empty sandbox + CSP no script/network/form/navigation，仅授权相对图片；Markdown 清除危险 tags/attrs，图片走 bounded relative read；这里明确偏离 T3 普通 HTML 可运行 scripts 的模式，是本项目安全要求。 |
| Archive | [archive.js L4–15、61–107](../public/file-preview/archive.js)、[zip-policy.js L1–18、55–80](../public/file-preview/zip-policy.js) | 仅普通安全 ZIP（文本/图片成员），不递归 Office/嵌套 archive；64MiB archive/total，16MiB entry，4096 entries，ratio 200，并校验路径/设备名/符号链接/加密/重复/CRC；对 PI “不解压 ZIP”与 T3 的多 archive 分别记录，当前契约优先。 |
| Tree | [files-tree.js L16–60、107–157、163–185](../public/files-tree.js) | workspace-only、目录逐层加载、bounded server search、ARIA tree/keyboard roving、迟到响应按 epoch/identity 丢弃；外部 grant 不参与搜索/遍历。 |
| Tabs/state/layout | [files-tabs.js L8–130](../public/files-tabs.js)、[files-state.js L34–105](../public/files-state.js)、[files-layout.js L3–140](../public/files-layout.js) | 24 tabs；中键/右键/键盘/drag reorder；持久化只存 workspace fileId 和阅读状态，不存 external grant/archive bytes；宽度 140–480，窄于620时树 overlay/inert 内容，符合本次调研“复用现有 owner、不要复制外部 store”。 |
| Server final gate | [lib/file-preview-policy.js L7–165](../lib/file-preview-policy.js)、[server/files.js L630–697](../server/files.js) | 类型/大小/魔数/可执行头/Range 不是 renderer 自己决定；每次 content 读复核 workspace/grant/fileId、realpath/lstat/fstat reader、CSP `script-src none`/`nosniff`/`no-store`/attachment；外部 grant 失效返回拒绝。 |

**对当前实现的关键提醒**：`lib/file-preview-policy.js` 的 archive set 和 media set 比已实现 archive/media renderer 的实际能力更宽时，页面必须显示明确不支持/降级，不能因为 `typeFor` 选到 archive/media 就宣称 `.rar/.7z/.gz/.avi` 已内联可读；backend header policy 与 plugin parser 必须双重门控。Office `office.js` 目前实际只接受 `docx/xlsx/csv/tsv/pptx`，与 T3 的 ODF/RTF/EPUB/IPYNB 清单不同，后者不可写入本阶段已支持格式表。

## 8. 验证清单与移交

本调研已经执行的检查：

- 已读项目规则与安全/设计入口；准确基线/remote/Release/CI 状态只作事实记录。
- T3 源码链从引用、Surface store、树/tabs、附件读取，追到 renderer/worker 和资产读取，不运行外部代码。
- PI-Desktop main ref 和 shallow sparse HEAD 均核对为 `8ac4a9f495d5b1e5fa7957acdf157aa9567462bc`；只 checkout 本任务相关路径（`git sparse-checkout`），工作目录中不相关路径会显示 sparse 删除，这是 sparse worktree 的预期效果；未修改它们的 Git 索引或引用项目状态。跨平台页面源码用 exact-SHA GitHub API/raw 只读获取，以解决下载全库 Git blobs 网络低速限制。
- PI plugin README、manifest、主进程 reader/size/type dispatcher、许可证、work-panel CSS/resize/tab state、关联 ADR 及现成文件管理器入口媒体逐个核实。
- 两张参考图片原字节复制并计算尺寸、byte count、SHA-256、PI Git blob SHA；T3 源/目标对比 `identical=true`；PI 本地 blob SHA 与 GitHub API `sha` 相同。
- 调研当时本地 Markdown 链接24项、缺失0；本机新增产物仅本调研Markdown与两张来源图片。公开交付整理后图片不入Git，文档保留精确上游链接；最终链接检查见本阶段验收材料。

**未运行**：外部仓库 npm/pnpm/bun 安装、外部项目测试/应用、pi-GUI canonical 测试、任何新 UI 的真实渲染验收；这些不属于本只读调研任务，不能据本文宣布第二阶段产品验收通过。

后续实施/审查优先检查：同名与跨会话身份不串用、已撤销外部文件的 byte/Range/缓存/在途请求立即失效、对象替换、HTML/SVG/Office/归档主动内容、ZIP bomb/路径穿越/实体膨胀、关闭后的 worker/ObjectURL/媒体读取释放，以及四组宽窄深浅真实截图与键盘回焦。公开交付的调研回滚只回退本文及对应忽略规则；本机媒体未入 Git，不随 PR 再分发，也不影响产品行为。
