# 会话内文件引用验收材料

- 目标与交付：已完成会话内文件引用识别、文件类型图标、悬停元数据、点击打开右侧
  Files 面板、标签页复用、文件树联动、行号/范围定位、图片预览、系统程序打开/
  文件管理器显示/复制路径、会话工作区绑定和受控只读文件接口。未交付：页面内
  PDF/Office/压缩包预览、外部编辑器协议（按任务要求替换为系统默认程序）、
  独立安全审查（额度受限）。功能说明见 [file-links.md](file-links.md)。
- 身份：before HEAD `c1ae4d4a3a8a71e811231c43e52eb8d742d4c905`
  （`文档(conversation)：回填 PR CI 8/8 通过`）；功能提交 `7fda98b3`；测试提交
  `108553fc`；after HEAD 为包含本报告的交付提交，可用
  `git log -1 --format=%H -- docs/file-links-acceptance.md` 解析；分支
  `feat/compact-attachments`。
- 证据范围：以下测试与截图均在 before HEAD + 本功能工作区 diff 的最终状态运行；
  文档提交本身不改变产品行为。提交后如需 CI 证明，以 PR CI 的精确 head SHA 为准。
- 修改文件：
  - 功能：`public/file-link-model.js`、`public/markdown.js`、`public/messages.js`、
    `public/runtime-conversation.js`、`public/files-panel.js`、`public/file-links-ui.js`、
    `public/file-links.css`、`public/file-actions.js`、`public/ui/file-icons.js`、
    `public/ui/source-highlight.js`、`public/api.js`、`public/app.js`、
    `public/index.html`、`public/tokens.css`
  - 后端/桌面：`server/files.js`、`server/router.js`、`electron/main.cjs`、
    `electron/preload.cjs`
  - 测试：`tests/file-link-model.cjs`、`tests/file-links-backend.cjs`、
    `tests/file-links-ui.cjs`、`tests/file-links-runtime.cjs`、
    `tests/source-highlight.cjs`、`tests/file-links-fixture.cjs`、
    `tests/file-links-shots.cjs`、`tests/visual-harness.cjs`、`package.json`
  - 文档：本文件、[file-links.md](file-links.md)、`docs/README.md`
- 行为与安全边界：
  - 只读；新增 `metadata`/`asset`/`find`/`open-target` 四个端点，均在 router
    token 鉴权之后，并通过 `X-Pi-Gui-Conversation` 解析消息所属会话工作区。
  - 只接受工作区相对路径；绝对路径、`..` 越界、符号链接/junction 和 realpath
    越界全部拒绝；图片读取额外使用 `O_NOFOLLOW`、`fstat` 身份复核与再次 realpath。
  - 悬停只请求 metadata，不读内容、不执行文件；外部打开/文件管理器由渲染进程
    发起 IPC，主进程再次向后端授权后才调用 shell。
  - Markdown 保持 escape-first；模型文本不进入链接属性或标签。自审中发现并修复了
    “带空格目标退回原文时未转义 slot”的 XSS 回归，并补充了回归断言。
  - 文件引用绑定消息自己的 cwd/conversationId；历史消息不使用当前全局项目；
    切换工作区会清空标签页、元数据缓存和裸文件名唯一性缓存。
- 风险：**高**。涉及本地文件读取边界、系统程序打开/文件管理器 IPC 和工作区身份。
  自审已完成；独立功能/安全审查未运行（见下表），因此不能宣称“代码验收通过”。

| 证据层 | 命令/场景与代码状态 | 环境、退出码与实际结果 | 日志/截图/run |
| --- | --- | --- | --- |
| 作者自测 / 本地定向 | `npm run test:file-links`；before HEAD + 最终工作区 diff | Windows 11 26200；Node 24.22.1；exit 0；模型 55/55、后端 10、UI 31、运行时 8、高亮 12，合计 116 项，无 skip | 终端输出；套件源码见 `tests/` |
| 回归 | `node tests/smoke.cjs`；同状态 | exit 0；1339/1339，与改动前相同，无断言减少 | 终端输出 |
| 回归 | `node tests/runtime-conversation.cjs`、`node tests/files-terminal-ui.cjs`、`node tests/electron-guard.cjs`、`node tests/theme.cjs`、`node tests/modules.cjs`、`node tests/server-security.cjs` | exit 0；110/110、95、128/128、47/47、121/121、44/44 | 终端输出 |
| 真实 Chromium 验收 | `node tests/file-links-shots.cjs`；真实 public/ 页面 + 真实 `server/files.js` + `os.tmpdir()` 双工作区 | exit 0；13 项检查、9 张截图；含暗/亮、悬停、源码/树/行号、行范围、图片、窄窗口、右键菜单、工作区切换、键盘聚焦与 Enter 打开 | `.shots/file-links/01…09-*.png`、`results.json`（`.shots/` 被忽略，可用命令再生） |
| 本地完整 canonical | 未运行；按用户既定选择交给当前 PR 的完整 CI | **待验证**；本报告不把定向测试当作完整证明 | 待 PR run |
| 独立审查 | 独立 Agent 复审（功能/安全）；同一最终 diff | **未运行**：Agent API 返回 429（DeepSeek weekly usage quota exhausted），此前同类尝试也因额度失败；已改为作者自审并逐项修复下述问题 | 本文件“失败与修复历史” |
| PR CI | 推送 `feat/compact-attachments` 后的 PR；精确 head SHA 待回填 | **待验证**；完成前不宣称完整 canonical 通过 | 待回填 run URL |
| Electron 实测 | `npm run build:app -- --rebuild` 后启动 `dist-app/Pi GUI-win32-x64/Pi GUI.exe`，`PORT=17798`、`PI_GUI_DATA=%TEMP%\pi-gui-desktop-filelinks-proof`、`--remote-debugging-port=19229` | exit 0；UA `PiGUI/0.35.1 ... Electron/44.4.3 Chrome/152.0.7977.130`；`openWorkspaceFile`/`revealWorkspaceFile` 为 function；`.md-file-link`/`.file-kind-icon` CSS 已加载；四个新模块可 import；无 Runtime exception；截图后退出 | `.shots/file-links/10-desktop-build.png` |
| 打包产物检查 | `npm run build:app -- --rebuild`（内部重建 `build/server.cjs` 与 `build/Pi GUI.exe`） | `build/Pi GUI.exe` 106,761,728 B；`dist-app/Pi GUI-win32-x64/Pi GUI.exe` 246,324,736 B；`resources/app` 下 `markdown.js`、`files-panel.js`、`file-links-*.js/css`、`file-link-model.js`、`file-icons.js`、`source-highlight.js`、`main.cjs`、`preload.cjs` 与源码逐字节一致；`server.cjs` 含 `api/files/metadata` | 本文件；构建日志 |
| 模型/真实安装升级 | 不适用：本任务不调用模型，不做安装/升级 | — | — |

- 失败与修复历史：
  1. 截图验收发现 `` [`docs/说明 文档.md`](docs/说明 文档.md) `` 重复 chip 并漏出字面目标；
     原因是行内代码先占位、无尖括号目标含空格未匹配。已修复并加入回归断言。
  2. 行号栏 DOM 顺序在正文之后导致视觉在右；用 `order: -1` 保持选择器/读屏顺序不变。
  3. Chromium 悬停验收一度未检测到提示：`position: fixed` 的 `offsetParent` 为 null，
     改为检测 `hidden` 与真实矩形；产品逻辑未改。
  4. 截图脚本清理 profile 时 EPERM：改为先结束 Chrome、重试清理；产品逻辑未改。
  5. 自审发现 `markdown.js` 带空格目标退回原文时把未转义原文放进 HTML slot，
     可用 `[<img onerror=…>](a b)` 注入；已改为 `esc(original)` 并加回归断言。
  6. 自审发现候选升级只清 metadata 缓存、且超过 24 个候选不会继续批处理；
     已在工作区事件中清空候选缓存，并让自动扫描在剩余候选时继续下一批；补两条测试。
  7. 自审发现 Files 面板在 metadata 请求返回后未复核 epoch/会话，切换工作区时可能
     打开旧请求；已增加 epoch 与会话二次校验。
  8. 独立审查 Agent 因 429 额度未运行；没有把它写成“已通过”，后续可补独立审查。
- 限制与残余风险：见 [file-links.md 的已知限制](file-links.md#六验证与已知限制)；
  另外，独立安全审查和完整 PR CI 尚未完成，合并前必须补足或由用户明确接受残余风险。
  路径形状按 Windows 优先收紧，POSIX 合法但 Windows 非法的字符不识别；裸文件名只在
  有界扫描恰好唯一时升级；PDF/Office/压缩包不内联预览。
- 回滚：按提交边界回退功能提交（`public/`、`server/`、`electron/` 与测试/文档分开），
  不触碰本分支既有的 conversation 工作；删除后重新构建产物即可恢复旧前端。测试与
  桌面验收只写 `os.tmpdir()`/`%TEMP%` 和 `.shots/`，未写用户真实项目；无需恢复用户数据。
- 待用户决定：是否接受高风险的本地文件读取与系统打开能力；是否要求补做独立安全审查；
  是否允许合并与发布（当前均未授权）。
- 结论：开发完成 **是**；代码验收 **待外部验收**（独立审查未运行、完整 CI 待验证）；
  允许合并 **未授权**；允许发布 **未授权**。
