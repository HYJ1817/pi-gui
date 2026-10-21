# T1 Specs 项目文档

T1 提供只读的 Specs 知识入口：发现当前项目的根 `SPEC.md` 与 `specs/` 下 Markdown，
在现有右栏显示文档树和正文。它不创建、修改或删除项目文件，也不进入 Pi RPC、
会话存储、Planner 或 Skills 的数据结构。

## 发现与索引

每次读取都从后端当前的 authoritative workspace 重新发现，不持久化索引，也不需要文件监听：

- 仅接受根目录中实际命名为 `SPEC.md` 的普通文件；
- 仅递归接受 `specs/` 下的 `.md` / `.markdown` 普通文件；
- 不读取 `README.md`、`docs/`、符号链接目录或其他扩展名；
- 后端生成不透明文档 ID；前端在文档请求中只回传 ID，不传文件路径；
- 文档树最多 256 个文件、扫描 4096 个目录项、递归 16 层；超限在界面说明截断。

刷新按钮重新执行发现。文件删除、扩展名变化和新增文档都会在下一次刷新时反映；
不会因为文档变化自动修改任何项目内容。

## 工作区身份

工作区解析复用现有项目与 Worktree 边界：

1. 经典聊天使用 `server/runtime.js` 的当前 cwd 与 workspace generation；
2. focused 并行会话使用与 Changes 相同的 `X-Pi-Gui-Conversation` 请求头；
3. 后端只把 conversation ID 交给 Runtime Registry / Ordinary Sessions，从中取得已登记的
   `workspace.cwd`，前端不能提供绝对路径；
4. 索引响应带不透明 workspace token 与 generation；正文请求必须同时匹配二者，
   不同 Worktree、已删除工作区或迟到的旧请求一律 `stale_workspace`。

因此切换项目、受控 Worktree 或 focused parallel workspace 时，Specs 不会沿用上一个工作区的树或正文。

## 路径与文件读取

正文读取只接受索引中已发现的 ID。后端随后仍重新检查：

- `resolveProjectPath()` 的 lexical、realpath 与 parent-directory 校验；
- 结果必须位于当前项目内，并且仍是 `SPEC.md` 或 `specs/` 下的 Markdown；
- `lstat` / `open` / `fstat` 拒绝符号链接、非普通文件和删除后的迟到文件；
- 单文档上限 256 KiB，文件增长时只读取上限加一字节；
- UTF-8 必须可严格解码，NUL/二进制内容按 `invalid_text` 降级；
- 任何错误只返回稳定 code 与安全文案，不回显绝对项目路径或原始异常。

目录 junction / symlink 不会被索引；索引不跟随到项目外。

## 渲染与链接

正文复用 `public/markdown.js` 的“先转义、再生成白名单标签”渲染器，因此原始 HTML、
危险 URL scheme 和远程图片不会成为可执行 DOM。Specs 只额外启用标题 ID：

- 同一文档内重复标题生成 `slug`、`slug-2` 等唯一锚点；
- `#标题` 在当前文档内聚焦并滚动；
- 相对链接先按当前文档路径解析，再只允许跳到已经索引的 Markdown ID；
- `../`、绝对路径、项目外文件、未索引文件只显示拒绝说明，不发起文件读取；
- HTTP(S) / mailto 外链仍按既有安全链接行为处理。

## 界面生命周期

入口是对话顶栏右栏按钮组中的一个 Specs 按钮，不增加一级全局导航。
`openSpecsPanel()` 复用 `right-pane.js` 与 `openSecondarySurface()`：

- 切换 Changes / Browser / Process 时原 Specs surface 被 dispose；
- workspace generation 变化时立即清空文档正文与树，等待切换完成后自动重载；
- focused conversation scope 变化时重新请求索引；
- 所有索引、正文、锚点和延迟响应都带请求序号与工作区签名，旧响应不能覆盖新视图；
- 无项目、无 Specs、加载失败、文档过大、删除、非法文本与刷新失败都有独立可读降级；
- 空态不占文档树高度，也不影响 Chat、Composer、Changes、Browser、Planner 或并行会话。

## 测试

`npm run test:specs` 运行：

- `tests/specs.cjs`：18 条后端 / HTTP 断言，覆盖发现、认证、不透明 ID、路径拒绝、
  junction、过大、非法 UTF-8、删除、项目间与 generation 隔离；
- `tests/specs-ui.cjs`：25 条 jsdom 断言，覆盖树、折叠、正文、标题锚点、相对链接、
  XSS、刷新、失败保留、workspace/scope 陈旧响应、dispose 和空态。

`npm run test:specs:electron` 在真实 Electron 中通过 production entry 打开 Specs，
验证跨文档链接、未索引路径拒绝、1200/720 布局和空态，并生成
`docs/evidence/t1-specs/` 截图。它不依赖真 Pi 或真实用户项目。

本阶段不实现文档写入、Agent 自动维护、知识图谱、全局索引或新的任务编排。
