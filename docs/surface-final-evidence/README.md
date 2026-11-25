# 历史证据：2026-11-25 代表性真实截图

> **这些图片是历史证据，不是最新提交的运行效果。** 最新代码状态的代表图与来源记录在
> [2026-11-26/](2026-11-26/README.md)；该目录来自之后的正式产物运行
> `pi-preview-packaged-qIxTSC`，并覆盖字体许可整改、树滚动/折叠修复与会话身份时序修复。
> 本目录保留原始记录，不据此宣称当前验收结论。

2026-11-25；Windows 11，Electron 44.4.3 / Chromium 152.0.7977.130。只归档自有 TEMP fixture 的 10 张代表图（2,612,141 bytes），不含用户文件、T3 截图或品牌素材。源运行、字节与 SHA-256 见 [manifest.json](manifest.json)；完整运行资格、失败历史和限制见 [验收报告](../surface-final-acceptance.md)。提交前工作区比较基线为 `78ca4dcb9dd3e4293e9dcb0f7507a0a6d51d7d5d`，不是该旧 SHA 的 UI。

全部图片从最终运行重新导出，不复制历史文件。Launcher、Files 与 PPTX 的像素恰好与上一轮相同（该部分渲染未变），但 manifest 记录的是最终运行 `pi-preview-packaged-F9IKLx` 的实际字节，不是旧运行搬运；大媒体与源码桌面窄窗图来自最终 `pi-large-media-shAP8t` / `pi-preview-desktop-ZYGwsX`。

| 图 | 真实操作与资格 |
| --- | --- |
| [Launcher 宽/深](launcher-1320-dark.png)、[宽/浅](launcher-1320-light.png)、[窄/深](launcher-700-dark.png)、[窄/浅](launcher-700-light.png) | 最终正式产物专项 `pi-preview-packaged-F9IKLx`；production main，正常 sandbox；请求窗口 1320×820 / 700×600，DPR 1.5。居中偏差、行高与页面溢出均有实测断言 |
| [Files 公共最大化、右树与双层 tabs](files-right-tree-maximized.png) | 同次正式产物；保留左侧项目栏、聊天 DOM inert；工具 tabs 与文件 tabs 各归其 owner；正常宽度 restore 另有 <2px 断言 |
| [PPTX 第二页](pptx-page2.png) | 同次正式产物；真实 Worker/OOXML→SVG/DOM，页码、文本、形状、图片与缩放恢复有交互断言；不是文本占位图 |
| [原生 Browser 恢复](browser-native-restored.png) | 同次正式产物的原始 `webContents.capturePage()` 子视图截图；URL、原生实例与真实输入框表单值经 Files/Changes 切换后保留。BrowserWindow capture 不含 native child 像素，所以此图单独保存，未合成到外壳；网页自身是离线 fixture |
| [Files 窄窗深色](files-700-dark.png) | 最终源码 desktop `pi-preview-desktop-ZYGwsX`，正常 sandbox；右树 overlay、工具栏局部滚动和选中/键盘焦点专项另有完整四组测量；不冒充 production-main 图 |
| [真实大视频拖动后播放](large-media-seek.png) | 最终 `pi-large-media-shAP8t`；180,850,509-byte 真 VP8 WebM（sha256 `0c9c13…6edb9`），在原生时间轴真实拖到 0.88 后继续解码。test-owned main + built production renderer/preload/backend，不冒充 production-main 大媒体证明 |
| [重载后恢复的 Files 键盘焦点](restored-files-keyboard-focus.png) | 同次正式产物；真实 renderer reload 后 Files 以懒描述符恢复，可信 Home 首次挂载并把焦点交给选中且可见的 Files 工具 tab；不是注入 tab 对象或脚本 focus |

入口和步骤：工作面板 → 空 Launcher → 工具；Files 打开真实 TEMP 文件；通过工具 tab 切换、公共最大化按钮和真实键盘重排/菜单操作；大媒体通过原生 controls timeline 的可信输入拖动。所有截图保留原始尺寸/像素，不缩放、裁切或拼接。UI 证明不能替代授权、安全、完整 canonical、其它平台/codec 或安装升级证明。
