# 会话内文件引用与右侧文件查看器

实现参考 T3 Code（MIT）commit `ccc1feb15572c422fbdce26ba6077b91459cfd47`：

- `packages/shared/src/markdownLinks.ts` —— Markdown 链接与行号解析
- `packages/shared/src/fileLinks.ts` —— 路径解析与文件元数据
- `apps/web/src/components/chat/MarkdownFileLink.tsx` —— 图标 + 文件名链接
- `apps/web/src/components/WorkspaceEntryIcon.tsx` —— 文件类型图标
- `apps/web/src/hooks/useFileMetadata.ts` —— 悬停按需读取元数据

Pi-GUI 沿用同一套交互目标，但按本仓库的零构建 ESM、escape-first Markdown、
工作区授权和右侧 Surface 体系重新实现，不引入 React、编辑器或新依赖。

## 一、识别规则

渲染入口是 `public/markdown.js`，解析与解析结果全部来自
`public/file-link-model.js`（纯函数，不碰 DOM、不发请求）。**不对 Markdown
原文做全局正则替换**；只有下列带有明确文件语义的位置会生成链接：

| 来源 | 规则 | 示例 |
| --- | --- | --- |
| Markdown 链接 | 目标必须是工作区内文件；`<...>` 可包含空格 | `[README.md](docs/README.md)` |
| 行内代码（含分隔符/绝对路径/行号） | 直接生成链接 | `` `src/main.ts:128` `` |
| 行内代码（单个文件名） | 先渲染成候选 `<code>`，后端确认唯一存在后才升级 | `` `README.md` `` |
| 纯文本 | 只认绝对路径或带行号的相对路径 | `C:/pi-GUI/tests/x.cjs:12` |

行号支持 `:128`、`:128:10`、`:128-145`、`:128:10-145:2` 和
`#L128C10-L145`；Windows 盘符的冒号不会被误当行号。

以下内容保持原样，不生成文件链接：代码块、普通技术术语、npm 包名和模块
标识符、`http/https` 链接、版本号、提交哈希、省略号路径、主机名/裸域名，
以及无法唯一确定存在性的裸文件名。相对路径必须落在**这条消息所属会话**的
cwd 内；`..` 越界、`~`、UNC、含控制字符或非法文件名字符的路径直接拒绝。

## 二、渲染与交互

- `a.md-file-link` 是行内锚点：左侧 15px 文件类型 SVG，右侧文件名；默认只显示
  文件名（带行号时显示 `app.ts:18`），不显示完整路径。
- 没有底色、边框、阴影、胶囊或独立容器；字号、行高继承正文，图标与文字按
  baseline 对齐。长文件名省略号收窄，表格内同样受限。
- 悬停 240ms 后显示 `.ui-tooltip.file-link-tip`：`绝对路径 · 大小 · L18–24`。
  浮层挂在 `body` 上、`position: fixed`，不会被消息容器或右栏裁掉；靠近视口
  边缘时自动翻转/夹取。悬停只发一次 metadata GET，不读内容、不执行文件。
  键盘聚焦立即显示同一浮层，Enter 与单击走同一条打开逻辑。
- 文件类型图标在 `public/ui/file-icons.js`：统一 24×24 描边 SVG，覆盖
  JS/TS/JSX/TSX/CJS/MJS、CSS/SCSS、HTML/Vue/XML、Python/Rust/Go/Java/C/C++、
  JSON/YAML/TOML、Markdown/TXT/日志/配置、图片、PDF/Word/Excel/PPT、压缩包、
  字体/音视频和通用未知类型；颜色走 `--file-kind-*` Token，不依赖 Emoji。
- 单击复用右侧 Files Surface：按路径复用标签页，展开祖先目录、滚动并选中文件
  树行，预览区显示路径、大小和内容。行号/行范围会滚动到目标并做克制的高亮；
  超出范围时夹到最后一行。图片通过受控 asset 接口内联显示；PDF/Office/压缩包
  等不伪造预览，提供“用系统默认程序打开”。
- 右键菜单提供：在文件面板中打开、用系统默认程序打开、在文件管理器中显示、
  复制相对路径、复制完整路径。`Ctrl/Cmd+单击` 直接交给系统默认程序。
  Electron 渲染进程不持有 shell 能力，桌面桥把请求交给主进程，主进程再向
  后端请求授权后的绝对路径。
- 文件引用不改变代码块、表格、附件、外部链接和“思考/工作记录/操作栏”的既有
  渲染；候选升级是原地替换，不重建消息。

## 三、会话与工作区绑定

- Runtime 会话：`public/runtime-conversation.js` 从 `record.item.workspace.cwd`
  与 `record.item.conversationId` 生成渲染上下文；历史消息使用各自记录的
  workspace，不使用当前全局选中的项目。
- Classic 会话：`public/messages.js` 使用经典聊天当前的 `S.cwd`；没有 cwd 时
  完全不识别文件，避免把普通文本缓存成“无链接”。
- 点击、悬停、右键动作都带上链接自己的 conversationId；面板打开前再次校验
  “链接会话 == 当前焦点会话”，并用 metadata 返回的真实路径复核仍在该会话
  cwd 内。工作区切换时已有右键 Surface、标签页、元数据缓存和候选唯一性缓存
  一起作废。
- 同一相对路径在不同项目/Worktree 中有同名文件时，各自绑定自己的 cwd；
  切换会话后再点开，读取的是新会话工作区里的同名文件，不会串项目。

## 四、只读接口与安全边界

`server/files.js` 新增四个只读端点，全部在既有 router token 鉴权之后，并通过
`X-Pi-Gui-Conversation` 由 `runtimeRegistry` 解析会话工作区（无该头时才回退到
经典聊天工作区）：

| 端点 | 作用 | 边界 |
| --- | --- | --- |
| `GET /api/files/metadata` | 路径、真实大小、是否图片 | 不返回内容 |
| `GET /api/files/asset` | 图片字节 | 图片扩展名白名单、8MB 上限、`nosniff`、`no-store`、CSP sandbox |
| `GET /api/files/find` | 裸文件名唯一性 | 深度 8 / 4000 条目预算，跳过符号链接、隐藏目录和依赖/构建目录 |
| `POST /api/files/open-target` | 授权外部打开的目标 | 只返回工作区内已存在文件的绝对路径 |

共同守卫复用 `lib/safe-path.js`：只接受工作区相对路径，拒绝绝对路径、`..`
越界和符号链接/Windows junction；`realpath` 必须仍在工作区根内。图片读取额外
使用 `O_NOFOLLOW`、`fstat` 身份复核、重新 `lstat` 和再次 `realpath`，避免
检查与读取之间的替换。所有端点只读，不写入用户项目。

Markdown 仍保持“先转义、再插入自己生成的标签”的结构：文件链接的 HTML 只由
`markdown.js` 生成，模型文本不会进入属性或标签。悬停、候选升级和右键菜单都
只通过上述受控接口工作；AI 写出一个路径不等于获得读取任意本地文件的权限。

## 五、模块地图

| 模块 | 职责 |
| --- | --- |
| `public/file-link-model.js` | 路径/行号解析、工作区包含判断、候选标记 |
| `public/markdown.js` | Markdown 渲染并产出带 `data-file-*` 的链接/候选 |
| `public/ui/file-icons.js` | 文件类型 → SVG 图标 |
| `public/file-links-ui.js` | 点击/悬停/右键/键盘、metadata 缓存、候选升级 |
| `public/files-panel.js` | Files Surface 的标签页、文件树联动、预览与行定位 |
| `public/ui/source-highlight.js` | escape-first 轻量语法高亮（200KB 上限） |
| `public/file-actions.js` | 外部打开/文件管理器/复制路径的统一动作 |
| `server/files.js` / `server/router.js` | 受控只读文件接口 |
| `electron/main.cjs` / `electron/preload.cjs` | 授权后的系统打开 IPC 桥 |

## 六、验证与已知限制

自动化：`npm run test:file-links`（模型 55、后端 10、UI 31、运行时 8、高亮 12）
已加入 `npm test` 链。真实 Chromium 验收：`node tests/file-links-shots.cjs`
（13 项检查、9 张截图，输出 `.shots/file-links/`）。完整数字、桌面产物和
未验证项见 [文件引用验收材料](file-links-acceptance.md)。

已知限制：

- 路径形状按 Windows 优先收紧，POSIX 合法但 Windows 非法的 `? * " < > |`
  字符不会被识别。
- 裸文件名只有在后端扫描预算内“恰好一个”匹配时才升级；更深、被隐藏目录或
  依赖目录遮住的文件会保持普通代码外观，这是有意的保守行为。
- PDF/Office/压缩包不做页面内渲染；语法高亮是轻量 Tokenizer，不是完整 AST
  高亮器。
- 没有新增依赖、没有修改 pi 本体，也没有使用用户真实项目做写操作。
