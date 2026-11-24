# 文件引用桌面验收证据

由 `node tests/file-links-desktop.cjs` 在 Windows 11 26200 上运行打包后的
`dist-app/Pi GUI-win32-x64/Pi GUI.exe` 生成。运行使用：

- `os.tmpdir()` 下的两个工作区（project-a / project-b）与一个工作区外目录
  `外部 资料`，不读写用户真实项目；
- 隔离的 `PI_GUI_DATA`、`PI_GUI_RUNTIME_DIR` 与 Electron
  `--user-data-dir`（`%TEMP%/pi-gui-file-links-desktop-data-*`），不写用户真实
  `%APPDATA%\Pi GUI`；
- 真实 Electron 原生确认窗口（Windows SendKeys），真实 `Ctrl+Click` 启动已安装的
  Visual Studio Code。

`results.json` 是完整检查明细（27/27）。截图与对应场景（共 17 张）：

| 文件 | 场景 |
| --- | --- |
| `01-dark-conversation.png` | 暗色会话：行内代码、纯文本路径、工作区外引用与图标 |
| `02-hover.png` | 悬停显示规范路径、真实大小与行号 |
| `03-internal-viewer.png` | 单击在既有右侧 Files 查看器打开并定位第 18 行 |
| `04-same-name-picker.png` | 同名文件选择器：类型图标 + 可区分相对路径 |
| `05-picked-file.png` | 选择 `tests/index.js` 后在既有查看器打开对应内容 |
| `06-external-hover.png` | 未授权外部文件的悬停提示；无 metadata 请求 |
| `07-external-dialog.png` | 原生 Electron 授权窗口（仅此文件 / 本次目录 / 长期目录 / 取消） |
| `08-external-authorized.png` | 授权后外部 Markdown 在同一右侧查看器打开 |
| `09-folder-dialog.png` | 目录授权窗口（本次运行 / 记住 / 取消） |
| `10-external-image.png` | 授权目录内图片通过受控 asset 端点内联显示 |
| `11-editor-and-access-settings.png` | 设置 → 通用：编辑器与访问卡片、授权列表 |
| `12-light-settings.png` | 同一界面亮色主题 |
| `13-workspace-b.png` | 工作区 B 打开自己的同名文件，不串 A |
| `14-workspace-b-settings.png` | 工作区 B 的设置：编辑器偏好恢复，不继承 A 的授权 |
| `15-restored-grant.png` | 重启后长期目录授权恢复，外部图片无需再次确认 |
| `16-after-external-editor.png` | Ctrl+Click 后应用仍停留在会话，编辑器已独立启动 |
| `17-vscode-editor.png` | 真实 VS Code 窗口打开 `app.ts:18`（第 18 行高亮） |

说明：

- `07/09` 是从全屏截图裁剪出的原生对话框区域，去掉了用户桌面与其它应用内容；
  原始全屏图只留在本机被忽略的 `.shots/`。
- `17` 是 PowerShell 脚本抓取的 VS Code 顶层窗口截图，已不含桌面。
- 验收要求运行前没有已打开的 VS Code 实例；脚本会先检查，若已有实例则明确失败，
  避免单实例交接让 `--goto` 命令行无法被验证。截图中的 VS Code 进程在检查完成后
  由脚本按本次临时文件路径精确清理，不影响用户自己的编辑器实例。
- 截图的完整提交身份以包含本目录的交付提交为准：
  `git log -1 --format=%H -- docs/file-links-evidence/README.md`。
