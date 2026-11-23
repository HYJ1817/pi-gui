# 紧凑附件 UI 与文件引用验收

## 范围与身份

- 基线：`6b38415c59a4818177fa706bb3e6086af0e802be`（v0.35.1 最新 main），本地分支 `feat/compact-attachments`。
- 本轮验收对象：`21a0f621`（音频分类、主流格式映射与静态文件信息行）、`165a8ec6`（音频／主流格式／真实 MP4 测试）、`089a3c14`（音频行真实渲染检查）与后续本文档提交。此前附件提交为 `91f0740c`、`38e249ac`、`e022482a`。
- 基线完整 CI：[45136803834](https://github.com/HYJ1817/pi-gui/actions/runs/45136803834)，push，attempt 2，五个 canonical 组、Electron build、CI gate 均成功。只证明基线。
- 本次完整 canonical：用户于本任务预先选择后续 PR CI；本地只跑受影响套件，完整链 **待验证**，不用定向结果替代完整证明。分支含本文档提交后推送，未创建 PR。
- 范围：Classic Composer 附件 intake、紧凑呈现、音频／视频／图片与普通文件分类、本地媒体预览、发送守卫与共用 `<pi-file>` 名称显示。不改变服务端落盘／解析器、Pi schema、模型／发送入口或 Runtime 独立 Composer 的功能范围。
- 未增加依赖、网络访问、文件执行／任意文件读取接口、音频转写或 Office 预览。正常图片／PDF／DOCX／文本功能保留；PPT／Excel／ZIP／视频／音频等以有效原文件引用附加，不声称模型已读取其内容。
- 风险：中（UI、异步附件生命周期和发送状态），上传路径／权限边界仍由原模块持有；额外验证本地 URL、恶意文件名和失败发送边界。

## 官方 T3 源码对照

公开源码核对固定到 [`d63b9c4c76384c447ded5ff791ebb9dde25ec5f3`](https://github.com/pingdotgg/t3code/commit/d63b9c4c76384c447ded5ff791ebb9dde25ec5f3)，2026-11-23；同时按用户截图对照密度、预览与行内文件布局。

| 参考 | 借鉴与适配 |
| --- | --- |
| [ComposerAttachmentStrip](https://github.com/pingdotgg/t3code/blob/d63b9c4c76384c447ded5ff791ebb9dde25ec5f3/apps/web/src/components/chat/ComposerAttachmentStrip.tsx#L140-L603) | 64×64 媒体缩略图、播放标记、右上移除；普通文件图标＋名称＋大小。pi-GUI 采用原生 JS 与公共 Token，不复制 React/Tailwind 组件。 |
| [文件分类](https://github.com/pingdotgg/t3code/blob/d63b9c4c76384c447ded5ff791ebb9dde25ec5f3/apps/web/src/components/chat/composerAttachmentFiles.ts#L158-L175)、[videoMimeType](https://github.com/pingdotgg/t3code/blob/d63b9c4c76384c447ded5ff791ebb9dde25ec5f3/packages/shared/src/video.ts#L3-L25) | 区分本地可预览和模型输入；明确 MIME 优先，通用 MIME 才补扩展名。Pi 已有 PNG/JPEG/GIF/WebP/BMP 白名单独立于媒体展示。 |
| [首帧选择](https://github.com/pingdotgg/t3code/blob/d63b9c4c76384c447ded5ff791ebb9dde25ec5f3/apps/web/src/lib/videoFirstFrame.ts#L1-L27) | 取靠近开始的帧，避免空白初始帧；T3 直接展示 video，本实现仅保留至多 160px 的 canvas 缩略图并释放后台解码器，5 秒超时退图标。 |
| [Intake](https://github.com/pingdotgg/t3code/blob/d63b9c4c76384c447ded5ff791ebb9dde25ec5f3/apps/web/src/components/chat/useComposerAttachmentIntake.ts#L147-L399) | 首个 await 前登记整个批次、稳定 ID、检查附件是否仍归当前 owner。pi-GUI 使用既有工作区世代和会话切换事件，不另建 registry。 |
| [上传状态](https://github.com/pingdotgg/t3code/blob/d63b9c4c76384c447ded5ff791ebb9dde25ec5f3/apps/web/src/lib/attachmentUploadState.ts#L6-L67)、[发送复核](https://github.com/pingdotgg/t3code/blob/d63b9c4c76384c447ded5ff791ebb9dde25ec5f3/apps/web/src/components/chat/chatViewSend.ts#L399-L435) | 区分 pending、传输失败与真实可用引用；现有接口无上传进度，故显示轻量「上传并解析中…」，不伪造百分比。 |
| [文件预览](https://github.com/pingdotgg/t3code/blob/d63b9c4c76384c447ded5ff791ebb9dde25ec5f3/apps/web/src/components/files/AttachmentFilePreview.tsx#L287-L408) | 当前公开源码确实支持多格式预览，但其 Office／HEIC 等依赖不带入本项目。本次只做用户要求的图片／视频预览，复用 `openModal` 与回焦。 |
| [T3 Pi adapter](https://github.com/pingdotgg/t3code/blob/d63b9c4c76384c447ded5ff791ebb9dde25ec5f3/packages/provider-pi/src/server/adapter.ts#L3322-L3345)、[路径提示](https://github.com/pingdotgg/t3code/blob/d63b9c4c76384c447ded5ff791ebb9dde25ec5f3/packages/provider-core/src/server/attachmentPrompt.ts#L160-L183) | 官方自身也以路径／可选提取文本及单独图片字节驱动 Pi，不存在由本地视频预览自动推导出的原生 video RPC block。pi-GUI 继续用 `message + images?`。 |

T3 仓库许可证为 MIT、Copyright © 2026 T3 Tools Inc.；本次借鉴机制并自行用原生 JS 实现，没有移植其组件或第三方依赖。新增三个媒体 glyph 为仓库自绘几何；其它图标复用已存在的本地图标映射。

## 实现与边界

- `public/attachments.js`：批次预占、稳定客户端 ID、原始 File 名称／大小、上传／解析状态、移除及迟到结果隔离、消息组装。每次上传持有 `AbortController`；页面隐藏、移除、工作区／会话切换在作废世代的同时中止在途请求，未完成项标为真实失败；恢复时只重建本地预览。
- `public/attachment-types.js`：纯 MIME／扩展名展示分类，原生图片格式与发送失败守卫。图片能否进入 `ImageContent` 由文件头字节决定，扩展名/MIME 只用于分类；BMP 还要求结构合法的文件头／DIB 头，而不是只认 `BM` 两字节。
- `public/attachment-view.js`：媒体优先、普通文件自然排列，状态仅在真实 pending／错误／截断时出现；hover、触屏、键盘移除和焦点恢复。
- `public/attachment-preview.js`：独占 Blob URL、真实视频帧、错误占位、公共模态预览及释放。视频在 `seeked` 后等待浏览器呈现新帧（`requestVideoFrameCallback`，250ms 兜底）再绘制，避免负载下抓到黑帧；预览 URL 不进入发送正文，不接受传入任意 HTTP/file URL。
- `public/attachments.css`：附件唯一几何所有者；移除两份旧卡片样式。普通文件的文件信息与移除键固定在首行，状态文字独占第二行。原有输入框、模型按钮与发送控件不重绘。
- `composer.js` 与 `rpc.js`：同一纯守卫在按钮和直接提交两层执行；无路径的上传失败不能发送「未知路径」，有路径的解析失败仍可发送文件引用。
- `ui/user-message-body.js`：名称／meta 的转义往返；新格式带 `esc="1"` 标记，旧消息无标记时按字面显示，避免把历史文件名里的 `&amp;` 误改写。继续使用 `textContent`，保持 Classic／Runtime 共用消息展示。
- 新单元入口加入 `package.json` canonical；真实 Electron 与打包专项保持单独 opt-in，不改变 CI workflow。

文件类型图标沿用 `--ds-error`、`--ds-purple`、`--ds-warning`、`--ds-success`、`--ds-info` 与中性墨色，仅用于类型识别，不冒充错误状态；实际错误另有文字和 ARIA。预览缩略图／播放控件是媒体的局部表面，不为普通文件添加内层边框或卡片。

## 本轮收尾（音频、格式分类与文件信息行）

| 项目 | 实现与证据 |
| --- | --- |
| 音频格式 | `MIME_BY_EXT` 增加 MP3／WAV／M4A／M4B／AAC／FLAC／OGG／OGA／OPUS／WEBA／WMA／AIFF；`attachmentFileType` 在 image 之前识别 `audio/*`，使用仓库自绘音频 glyph 与「音频」标签（`--ds-info`）。jsdom 覆盖 7 种音频 fixture；Electron 真实上传 `示例音频.mp3` 后实测行为 `type=audio`、`icon=audio`、静态 `DIV`、`title="音频 · 示例音频.mp3 · 74 B"`、无媒体预览，发送正文只有原文件引用。仍按原文件引用上传和发送，未增加转写、播放或模型音频输入。 |
| 主流文件分类 | 补齐 DOC／PPT／XLS 旧格式、ODF、RTF、CSV／TSV、TXT／LOG／JSON／JSONL／XML／YAML／HTML／CSS、RAR／7Z／TAR／GZ／TGZ／BZ2／XZ 及更多图片／视频扩展名。分类只决定呈现图标、标签与媒体行；是否已解析仍由服务端 `kind`／`text`／`error` 决定，PPTX／XLSX／压缩包／音视频不会因扩展名被描述为已读取。 |
| 文件信息行 | 普通文件信息行改为静态 `DIV`，类型 · 名称 · 大小放在 `title`；点击不再打开内容重复的 Popover。媒体缩略图仍是唯一预览入口；静态行不进入 Tab 顺序。发送守卫、状态行 `aria-describedby` 与移除回焦保持。 |
| 真实 MP4 | Electron 用 Chromium `MediaRecorder` 真实录制 H.264 MP4（`video/mp4;codecs=avc1.42E01E`），上传后核对原字节与 `ftyp`，缩略图 160×90、像素差 min 7／max 200，预览 `videoWidth=320` 且时长约 1 秒；移除后回焦 Attach，发送正文只含原文件路径，不产生图片内容。 |
| 不支持编码降级 | 对同一真实 MP4 只把 `stsd` 内样本项 fourcc 改为未知值 `zzzz`。本机 Chromium 探针显示 `zzzz`／`encv` 触发 `MEDIA_ERR_SRC_NOT_SUPPORTED`，而 `hvc1`／`av01` 仍可经 `avcC` 解码，因此选用未知 fourcc。托盘回退视频图标、无 `<img>`、不生成缩略图，文件仍保留路径并可发送；点击预览显示本地「无法预览」错误。该 fixture 是真实 MP4 的受控损坏，不是真实 HEVC 文件。 |

## 第一轮独立复审与修复

第一轮独立复审（Codex `gpt-6.2-sol`，独立上下文，只读）结论为**不通过**：1 项阻断、3 项应处理、2 项非阻断建议。逐项处置如下，均未改变 Pi RPC 协议或服务端落盘边界：

| 发现 | 处置 |
| --- | --- |
| 文本文件改名为 `fake.png` 后会被当作 PNG 的 `ImageContent` 发出 | `attachment-types.js` 按文件头嗅探 PNG／JPEG／GIF／WebP／BMP；`imageContent()` 只按真实字节返回，MIME 跟随字节。`attachments.js` 在读取后校验，不匹配则丢弃 dataUrl、保留路径引用并显示准确说明；上传完成后 `kind` 才可能为 `image`。正例换成真实 1×1 PNG，伪装文本保留为反例。 |
| `pagehide` 后仍在途的批次可以继续上传、并在清理后重建 Blob URL | `pagehide` 先递增 intake 世代使旧批次失效，未完成项转为真实的 `uploadFailed`（「页面已离开，请重新添加此附件」）；`pageshow(persisted)` 用保留的原始 File 重建图片／视频本地预览，已上传路径引用不受影响。 |
| 图片读取失败但上传成功时，纯文本模型仍被图片能力守卫误拦 | 读取失败或字节不符时 `kind` 落为 `binary`；只要已有 `path`，`buildMessage()` 与发送守卫都按文件引用处理，不再要求图片能力。 |
| 普通文件出现状态文字时，移除键被 Grid 自动放置到第三行 | `attachments.css` 显式把 `.att-info`／`.att-x` 放在第一行、`.att-meta` 放在第二行；真实 Electron 以矩形断言三者位置（移除键 26×26 与信息行垂直居中，状态从信息行底边开始）。 |
| 新解码器可能改写旧消息里字面含 `&amp;` 的文件名 | 新格式在打开标签写 `esc="1"`；只有带标记的属性才解码。旧消息按字面显示，新消息仍能还原真实名称。 |
| Electron 的「上传拒绝」证据其实是注入的 fetch 响应 | 用例改名为 `injected upload rejection`，不再暗示服务端真实限额验证。 |

第二轮复核由独立上下文（同一可用 WorkBuddy 通道，Codex/Devin 额度不可用）完成：**0 阻断、4 项非阻断建议**，逐项处置如下：

| 发现 | 处置 |
| --- | --- |
| BMP 只校验 `BM` 两字节，`BMW...` 文本可冒充图片 | `attachment-types.js` 校验 30 字节以上结构：保留字节为零、DIB 头属于已知集合、文件大小／像素偏移自洽、宽高非零且在界内、planes=1、bpp 属于合法集合。反例 `BMW is a car maker...` 与正例 58 字节 1×1 BMP 均入测。 |
| `TINY_PNG_BASE64` 的 IDAT CRC 无效 | 换成 CRC 全部正确的 68 字节 1×1 PNG；本地用 `lib/zip.cjs` 的 `crc32` 逐块核对 IHDR／IDAT／IEND，解码器不再面对损坏的 IDAT。 |
| `pagehide` 只作废结果，不中止在途 `fetch`，可能留下服务端孤儿 | `attachments.js` 为每次上传建立 `AbortController`，`releaseAttachment()`（pagehide、移除、工作区／会话切换共用）调用 `abort()`；`api.js` 不把 `AbortError` 记为网络故障。测试捕获实际传入的 `options.signal` 并断言 pagehide 与移除都会触发中止。 |
| 移除同 role 的最后一项时焦点跳出托盘 | `attachment-view.js` 同 role 无候选时，先在所有可用的 `.att-preview, .att-info, .att-x` 中按 id／索引回退，只有托盘为空才回到 Attach；不可聚焦的禁用媒体控件会被排除，不能吞掉回退。两个方向的 jsdom 用例及「禁用媒体＋最后文件」用例覆盖。 |

复核期间另观察到 Electron 首帧检查在一次运行中抓到全黑帧（65/66）；这是 `seeked` 与合成帧呈现的竞态，不是上传或附件状态缺陷。`attachment-preview.js` 改为在 `seeked` 后等待 `requestVideoFrameCallback` 再绘制、250ms 兜底，随后两次真实 Electron 运行均为 **66/66**；没有放宽或删除该断言。

## 验证证据

Windows 11 x64，Node 24.22.1，Electron 44.4.3 / Chromium 152.0.7977.130。所有读写 fixture 均为独立 TEMP；没有调用真实 Pi／模型、写真实会话、改变用户安装或下载依赖。

| 检查 | 实测结果 |
| --- | --- |
| `npm run test:attachments` | **53/53**（本轮新增 18 条，原 35 条全部保留）；新增主流格式分类表、音频图标／标签／静态行／发送引用、bogus `.pptx`／`.xlsx`／`.zip`／`.opus` 不得声称已解析、音频与压缩包真实 HTTP 上传字节核对、非法 OOXML 保留二进制引用；原有 BMP／pagehide／AbortController／焦点回退断言未删 |
| `node tests/ui3-composer.cjs` | **34/34**；断言数量不变 |
| `node tests/review-regressions.cjs` | **32/32** |
| `node tests/model-capabilities.cjs` | **36/36** |
| `node tests/model-fallback.cjs` | **74/74** |
| `node tests/high-risk-regressions.cjs` | **28/28**，离线 fixture |
| `node tests/ui3-integration.cjs` | **23/23** |
| `node tests/modules.cjs` | **121/121** |
| `node tests/smoke.cjs`（隔离副本：基线 HEAD＋本轮附件文件） | **1339/1339**；附件断言与旧消息 `esc` 回归全部保留 |
| 原地 `node tests/smoke.cjs` | **1332/1339**；7 条失败均为工作区另一路未完成的 `tool-view.js`／`classic-execution-view.js` 时间线 SVG／HTML 注入，与本 diff 无关，不计入通过结论 |
| 隔离副本 `node tests/ui2-classic.cjs` | **55/55**；原地 **52/55**，3 条失败同样是另一路时间线折叠状态／焦点改动 |
| `node tests/ci-test-plan.cjs` | 319 个 canonical leaves 精确覆盖 5 组，无重复／漏项 |
| `npm run test:attachments:electron` | **80/80**，33 张真实截图；证据 `%TEMP%/pi-attachments-MddyQu/evidence/results.json`。新增真实 MP4 缩略图／预览／移除／发送、未知 fourcc 降级和音频行渲染／真实字节／发送检查，原有 WebM／文档／布局／对比度断言全部保留 |
| 本轮 `npm run build:app -- --rebuild` 与 App/SEA 打包 | **未运行**。工作区仍混有另一路未完成的 `public/tool-view.js`、`classic-execution-view.js`、`runtime-conversation.css` 等改动，现在重建会把那一路带进产物；最终源码仍需跑源码版。上一轮 38/38 的打包证据早于本轮，不能代表最终状态 |
| 第一轮独立复审 | **不通过**；1 阻断 + 3 应处理 + 2 建议，已逐项修复，见上表 |
| 第二轮独立复核 | **0 阻断 + 4 项非阻断建议**，已全部处置；修复后附件／创作器／模型／回归套件复跑通过 |
| 第三轮窄范围独立复核 | **未完成**：OpenCode Go 月度额度 429，无审查结论。本轮再尝试独立复审，Devin 周额度 429 失败，仍无结论；不计作通过 |
| 本次完整 canonical / PR CI | **待验证**，用户选择后续 PR CI；本轮未创建 PR，本地未运行完整链 |

### 真实渲染矩阵

改造前截图：`%TEMP%/pi-attachments-YC2jaw/evidence/before-dark.png` 与 `before-light.png`。

当前源码截图与测量（本轮 80 项检查）：`%TEMP%/pi-attachments-MddyQu/evidence/results.json`，33 张全界面截图，另有直接 `capturePage(rect)` 的 Composer 区域截图（未合成像素）；代表：

- `reference-three-dark.png`、`reference-three-light.png` 与 `reference-composer-dark.png`、`reference-composer-light.png`：对齐用户截图的「视频＋PDF＋Word」场景，不出现托盘滚动。

- `single-video.png`、`single-pdf.png`、`single-mp4.png`、`single-audio.png`、`video-preview.png`、`mp4-preview.png`、`mp4-codec-fallback.png`、`mp4-preview-failure.png`、`image-preview.png`。
- `dark-1320-mixed.png`、`light-1320-mixed.png`、`dark-700-mixed.png`、`light-700-mixed.png`。
- `dark-file-hover.png`、`light-file-hover.png`、`dark-keyboard-focus.png`、`light-keyboard-focus.png`。
- `*-many-zoom-0.8/1/1.25/1.5.png`、`font-scale-150.png`：24 个中文／英文长名称，局部滚动。
- `loading.png`、`parse-error-and-video-fallback.png`、`video-preview-failure.png`、`upload-failure.png`、`empty-after-removal.png`。

几何：1320×820 混合 8 附件时托盘 148 CSS px、Composer 258px；700×600 时托盘 144px、Composer 254px；24 附件同样受上限控制，不随数量无限增高。普通 PDF 行不超过 32px；媒体缩略图 64px，输入最小高度与控制区不被附件挤掉。带错误状态的 PDF 项实测高 43.4px：信息按钮 28px 位于首行，26×26 移除键与首行垂直居中（top 440.4，信息行 439.4–467.4），状态文字从 467.4（信息行底边）开始，宽度覆盖整项。

实际颜色经 canvas 解析并在真实 Composer 背景上合成：深色文字最小 8.48:1、图标最小 5.66:1；浅色文字最小 7.27:1、图标最小 3.36:1。达到普通文字 4.5:1／非文本 3:1，未用截图猜测对比度。

文件选择经 CDP 注入真实临时文件后触发产品 change；拖拽和粘贴为真实浏览器中的 DataTransfer／ClipboardEvent fixture，不冒称 OS 级拖入或真实系统剪贴板。预览、关闭、移除和发送使用受信鼠标／键盘。视频包含本地 canvas + MediaRecorder 生成的真实 VP8 WebM，以及本机 Chromium 真实录制的 H.264 MP4；不支持编码用例由真实 MP4 的样本项 fourcc 受控改为未知值，不冒充真实 HEVC／MOV 文件。未验证所有 MP4／MOV 编解码器组合。

### 首次失败与环境说明

- 修复前新增回归运行 7/21，14 项失败；后续增加 3 项负向边界，当时最终 24/24。第一轮复审后补 4 项，第二轮复审后补 7 项（`BMW` 反例、结构合法 BMP 正例、pagehide 中止、移除中止、双向跨 role 焦点、禁用媒体不吞焦点），当时 35/35。本轮再补 18 条格式／上传／静态行用例，现为 53/53；既有 Composer 和 smoke 的断言总数没有减少。
- 默认仓库内 Electron 可执行文件首次 GUI 启动 exit 3；复制为唯一 TEMP 私有运行时后正常沙箱通过，未禁用沙箱。两者 electron.exe SHA256 均为 `bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`。
- Electron 脚本先因等待自己扣住的 upload Promise 超时，修正只等待真实阶段；再修正 executeJavaScript 不可克隆函数返回值与 RGBA luminance 夹具计算。没有删检查或把失败改成 skip；首个成功完整矩阵为 62/62（`pi-attachments-Fr4ddx`）；补充参考截图三附件检查与真实缩略图像素检查后为 65/65，没有修改产品行为。第一轮复审修复后复跑为 66/66（`pi-attachments-XtX5pQ`），新增的是状态行几何检查，旧检查未删。
- 第二轮修复后首次 Electron 运行 65/66：首帧缩略图在负载下抓到全黑画面（`min=0,max=0`），其余 65 项通过。按代码路径定位为 `seeked` 与合成帧呈现的竞态，未放宽断言；产品改为等待 `requestVideoFrameCallback`、250ms 兜底后再绘制。随后运行 66/66（`pi-attachments-2a6n8V`、`pi-attachments-g8uBIx`），补齐禁用媒体焦点边缘后最终源码再次 66/66（`pi-attachments-3GJt39`）。
- 本轮真实 MP4 首次降级用例失败：把 `stsd` 样本项从 `avc1` 改成 `hvc1` 后，Chromium 仍通过 `avcC` 解码并生成缩略图（15/17，细节为 `thumbnail:true, placeholder:false`）。按用户要求没有把失败改成跳过；另写 TEMP Electron 探针逐项加载变体，确认 `zzzz`／`encv` 返回 `MEDIA_ERR_SRC_NOT_SUPPORTED`，而 `hvc1`／`av01` 仍可解码，随后把 fixture 改为未知 fourcc `zzzz`，完整运行 **80/80**；音频行真实渲染检查在同一轮通过。
- 默认仓库内 Electron 可执行文件在当前会话再次以无输出方式退出；改用上一轮已校验的 TEMP 私有运行时（SHA256 相同）后正常完成，未禁用沙箱。
- SEA 在系统 TEMP 的六种上传均被环境拒绝：`EPERM ... mkdir .../sea/.uploads`。App 同处正常。按既有测试政策，仅该专项设置独立仓库内 TEMP/TMP/TMPDIR 后 App/SEA 均 38/38，未修改产品路径守卫。成功证据位于 `.probe/attachment-package-temp-aGLNJZ/pi-attachments-packaged-brDP1i/results.json`；首次失败保留于系统 TEMP 的 `pi-attachments-packaged-NQQ5Ht`。
- 离线构建使用已有 Electron 缓存，ZIP SHA256 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`；包内 electron.exe 与已实测运行时摘要一致。既有 SEA 注入工具输出签名警告，构建 exit 0；这些开发产物不是已签名正式发布。

## 限制、回滚与结论

- 图片／视频预览仅当前本地草稿内存可用；未新增附件持久化、发送后视频播放器、Office 预览、OCR、自动安装转换器或原生视频模型能力。
- 原上传 32 MiB 限制不变；大视频会准确报告超限。已落盘的文件继续由既有缓存清理负责；从草稿移除不删除服务器文件，不破坏已经发送的引用。
- 图片格式判定只嗅探文件头，不做完整解码；BMP 额外校验文件／DIB 头结构，但伪造了合法头部的非图片仍可能在模型侧解码失败。BMP 仅接受常见 Windows DIB 头（40/52/56/64/108/124 字节）；OS/2 12 字节头等少见变体会保留为普通文件引用，不会作为 `ImageContent`。误标扩展名的真实图片会按实际字节的格式发送，消息里的文件名保持原样。
- `pagehide`、移除、工作区／会话切换会中止在途上传并释放本地视频缩略图与预览；从 bfcache 恢复时用草稿里的原始 File 重建。服务端若已写完文件，仍由既有缓存清理负责。真正卸载页面后草稿不从磁盘恢复，这是原有边界。
- 本次未验证真实模型、所有媒体编解码器、macOS/Linux、安装器／正式升级；正常沙箱证明仅限所记录私有运行时和这台机器。MP4 只覆盖本机 Chromium 可录制的 H.264 组合；HEVC／AV1／MOV 等真实文件、以及“未知 fourcc”之外的真实损坏形态未验证。
- 音频验证了分类、图标、标签、真实 Electron 行渲染、真实字节上传与文件引用发送；没有音频播放器、转写、波形或模型音频输入，也没有逐一渲染全部 13 个音频扩展名。SVG／HEIC／AVIF／TIFF 显示为图片类型但只有本地预览，仍按文件引用发送。
- **本轮未重建 App/SEA。** 当前 `dist-app` 与 `build` 产物仍是本轮修复前的附件源码；工作区另有与本次无关、尚在变化的 `public/tool-view.js`、`public/classic-execution-view.js`、`public/runtime-conversation.css` 与未跟踪 `public/conversation-work-log.js`，现在重建会把那一路未完成改动一起带进产物，因此未执行。修复后的效果需跑源码版，或等那一路稳定后再重建；上一轮 38/38 的打包摘要不再代表最终源码。
- 回滚：本次无数据 schema 迁移；提交后回退 `21a0f621`、`165a8ec6`、`089a3c14` 与本文档提交再重建即可。不执行整仓 reset/clean，不删除用户原有未跟踪文件。
- 开发完成：实现与本地定向验证已完成，代码与测试已提交。
- 代码验收：第一轮**不通过**（1 阻断 + 3 应处理 + 2 建议，已修复）；第二轮**0 阻断 + 4 项非阻断建议**（已全部修复并复跑）；第三轮窄范围独立复核**未完成**（OpenCode Go 429），本轮独立复审再次因 Devin 周额度 429 未取得结论。因此本轮新增代码只有作者自查＋ jsdom／真实 Electron 回归，**未经独立复审**；`requestVideoFrameCallback` 首帧等待与「禁用媒体不吞焦点」仍是作者自查项。结论出来前不写「代码验收通过」。另有用户选择的完整 PR CI 待验证。
- 合并许可：未取得。发布许可：未取得。本轮只按用户指示提交并推送分支，未创建 PR、未合并、未打 tag、未发布。
