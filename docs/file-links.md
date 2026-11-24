# 会话内文件引用、工作区外访问与外部编辑器

实现参考 T3 Code（MIT）commit `a7a6126a7d9b364c0fbef3f7fe1a087c4b004393`
（2026-11-24 抓取的 `main`）中的实际源码，而不是截图：

- `packages/shared/src/fileLinks.ts` —— `parseFileUrlHref`、`splitFilePathPosition`、
  `resolvePathLinkTarget`、`buildFileLinkParentSuffixByPath`
- `packages/shared/src/markdownLinks.ts` —— 行内代码候选、`EXTENSIONLESS_FILE_NAMES`、
  绝对路径扫描（`absoluteFilePathMatches`）与主机名/版本号排除
- `packages/contracts/src/editor.ts` —— `EDITORS` 目录与
  `EditorLaunchStyle = direct-path | goto | line-column`
- `apps/server/src/process/externalLauncher.ts` —— `resolveCommandEditorArgs`
  （VS Code 系 `--goto`、JetBrains 系 0-based `--line/--column`）与编辑器启动解析
- `apps/shared/src/editor.ts` —— 按平台探测编辑器命令
- `apps/web/src/components/chat/MarkdownFileLink.tsx` —— 单击预览、修饰键打开编辑器、
  右键菜单（预览 / 编辑器 / 文件管理器 / 复制）
- `apps/web/src/hooks/useFileMetadata.ts` —— 只对绝对路径按需取元数据，不发网络请求
- `apps/web/src/editorPreferences.ts`、`editorMenuIcons.tsx`、
  `apps/web/src/routes/chat.settings.general.tsx` —— 编辑器偏好与设置页交互

Pi-GUI 沿用这些交互目标，但按本仓库的零构建 ESM、escape-first Markdown、
工作区身份、右侧 Surface 和本地安全边界重新实现，不引入 React 或新依赖；
T3 的远程 / SSH / WSL 打开路径不在本阶段范围内。

## 一、识别规则

渲染入口是 `public/markdown.js`，路径解析全部在 `public/file-link-model.js`
（纯函数，不碰 DOM、不发请求）。**不对 Markdown 原文做无界全局正则替换**：
只在有明确文件语义的片段上生成占位符/链接，先转义原文，再插入自己生成的标签。

| 来源 | 规则 | 示例 |
| --- | --- | --- |
| Markdown 链接 | 目标必须是文件形状；`<...>` 可含空格；支持 `file:` URI 与 `#L` 行号片段 | `[报告](docs/说明 文档.md)`、`[x](file:///C:/tmp/a.md#L3)` |
| 行内代码（有分隔符/有行号/绝对路径） | 直接生成链接 | `` `src/main.ts:128:10` `` |
| 行内代码（单个文件名） | 先渲染为候选，后端确认存在后才升级 | `` `README.md` ``、`` `main.ts:12` `` |
| 纯文本绝对路径 | Windows / POSIX 绝对路径、`file:///` URI 可识别 | `C:\tmp\报告.md:3`、`/var/tmp/a.log#L8` |
| 纯文本相对路径 | 必须含分隔符或带明确行号；先候选，再经后端存在性校验 | `src/main.ts:128`、`tests/x.cjs#L45` |

行号支持 `:128`、`:128:10`、`:128-145`、`:128:10-145:2` 和
`#L128`、`#L128C10-L145`；Windows 盘符冒号不会被当成行号。

以下内容保持原样：代码块、普通技术术语、npm 包名/模块标识符、`http/https`
链接、裸域名或 URL 形状（如 `example.com/src/a.ts`）、版本号、提交哈希、省略号
路径、UNC/协议相对地址（`\\server\share`、`//host/path`）、含控制字符或 Windows
非法字符的路径，以及无法在后端确认存在性的裸文件名。相对路径必须落在**这条消息
所属会话**的 cwd 内；`..` 越界、`~`、目录路径直接拒绝。

工作区外的**绝对路径**会保留为“外部引用”：渲染成同样的行内链接和类型图标，但
在用户授权前**不读内容、不扫目录、不取真实大小/mtime**；悬停只显示规范化路径、
“工作区外 · 点击后授权”和已有的行号。外部相对路径无法可靠判断归属，按普通文本
处理。

## 二、渲染与交互

- `a.md-file-link` 是行内锚点：左侧 15px 文件类型 SVG，右侧文件名（带行号时显示
  `app.ts:18`）。没有底色、边框、阴影、胶囊或独立容器；字号、行高继承正文，
  图标与文字按 baseline 对齐。长文件名省略号收窄，表格内同样受限。
- 悬停 240ms 后显示 `.ui-tooltip.file-link-tip`：工作区内文件显示
  `绝对路径 · 大小 · L18–24`；外部未授权文件只显示路径与授权提示。浮层挂在
  `body` 上、`position: fixed`，靠近视口边缘时自动翻转/夹取。悬停只对已授权/已
  知工作区文件发一次 metadata GET，不读内容、不执行文件。键盘聚焦立即显示同一
  浮层，Enter 与单击走同一条打开逻辑。
- **单击**复用右侧 Files Surface：按真实路径复用标签页，展开祖先目录、选中文件树
  行，预览区显示路径、大小和内容；行号/行范围会滚动到目标并做克制的高亮，超出
  范围时夹到最后一行。图片通过受控 asset 接口内联显示；PDF/Office/压缩包不伪造
  预览，提供“用系统默认程序打开”。
- **Ctrl/Cmd+单击**交给设置中选定的外部编辑器；未选择/不可用时回退到系统默认程序。
- **右键菜单**：在文件面板中打开、用外部编辑器打开、用系统默认程序打开、在文件
  管理器中显示、复制完整路径；外部未授权文件额外显示“授权所在文件夹…”。
  复制相对路径仅在文件属于当前工作区时出现。菜单、tooltip、确认窗与设置控件沿用
  同一套浮层/菜单样式和暗/亮主题。
- **同名文件**：裸文件名经过有界扫描（深度 8、4000 条目、最多 24 个命中）确认
  恰好唯一时才升级为链接。多个命中时不自动打开第一个；单击弹出紧凑选择器，显示
  类型图标、可区分的相对路径和数量，支持键盘上下/Enter/Esc。选中只对**这一次**
  生效，不写回消息，也不改变其他同名引用；打开后仍进入既有右侧查看器。
- 文件引用不改变代码块、表格、附件、外部链接和“思考 / 工作记录 / 操作栏 /
  用量 Popover / 紧凑附件托盘”的既有渲染；候选升级是原地替换，不重建消息。

## 三、会话身份、缓存与生命周期

- Runtime 会话：`public/runtime-conversation.js` 从 `record.item.workspace.cwd`
  与 `record.item.conversationId` 生成渲染上下文；历史消息使用各自记录的 workspace，
  不使用当前全局选中的项目。Classic 会话使用经典聊天当前的 `S.cwd`；没有 cwd 时
  完全不识别文件。
- 每条链接/候选都携带自己的 conversationId、workspace root、generation。候选查询
  `find` 与元数据查询显式传 conversationId，**API 没有“默认当前会话”的兜底**；
  缓存 key 包含会话身份、工作区身份和 generation，两个项目里的同名文件不会共用
  唯一性结果。
- 工作区切换、会话切换、文件增删/刷新、授权撤销会推进 `cacheEpoch`：缓存条目作废、
  在途请求中止（AbortController），旧响应即使晚到也会被 epoch/身份复核丢弃；
  不会把上一个会话的候选或外部授权状态带进新会话。
- 相同查询并发去重；元数据缓存 TTL 20s / 120 条，查找缓存 TTL 20s / 80 条；瞬时
  网络/后端错误只做短重试，不永久记成“不存在”。自动候选升级按可见节点分批处理，
  用 `requestAnimationFrame`/定时器收敛，避免整页重复磁盘扫描、闪烁或滚动跳动。

## 四、工作区外文件访问

### 4.1 授权通道

授权只能由**可信的用户交互**创建：

1. 渲染进程只能说“我想打开这个绝对路径”（preload 固定字段的 IPC）。
2. Electron 主进程用系统原生 dialog 展示后端 `inspect` 出的规范化目标、访问范围和
   “只读，不提供写入/删除/执行”的说明，取得用户明确选择。
3. 主进程经父子进程私有 IPC 调后端 `create`，后端返回不可伪造的 grant id；渲染
   进程只拿到这个 id，不能自行签发。
4. 后端 HTTP 端点只有 `list` / `revoke` 和使用授权，**没有任何创建授权的入口**。
   模型输出、Markdown、页面脚本、工具调用都不能自动授权。

对话框按目标类型给出选择：

| 目标 | 按钮 |
| --- | --- |
| 文件 | 仅此文件（本次运行） / 此文件夹（本次运行） / 记住此文件夹 / 取消 |
| 目录 | 此文件夹（本次运行） / 记住此文件夹 / 取消 |

默认按钮是“取消”。同一个应用同时只允许一个待确认对话框；关闭窗口、主进程断开或
20 秒无响应都按取消/不可用处理。网页版没有原生通道，明确显示不可用，不伪造授权。
普通文件点击已有覆盖授权时直接复用、不重复弹窗；显式请求目录授权（右键“授权所在
文件夹…”或文件夹选择器）若是会话级，会再弹一次确认，允许升级为长期目录授权。

### 4.2 授权账本

- 授权绑定会话身份：Runtime 会话是 `conversation:<uuid>`；Classic 会话绑定规范化
  的项目根（`classic:<root>`）。另一个会话、另一个工作区不能复用。
- 范围：`file`（仅该文件）、`directory`（目录内的真实文件）；时效：`session`
  （进程内有效）或 `persistent`（仅目录可长期保留）。
- 长期授权复用 Electron 既有的系统设置持久化设施
  `createSystemPreferenceFile`，写入固定用户资料目录下的
  `external-file-grants.json`（`schemaVersion: 1`、仅允许目录/持久记录、主进程
  校验、原子写入、上限 16 KiB、最多 64 条），不另建配置存储。后端只持有运行期
  账本；启动时主进程把保存的记录经私有 IPC 交给后端**逐条重新 realpath / 敏感
  目录 / 符号链接 / 目录对象身份校验**，清理后的集合再回写。目录被删除重建、
  变成符号链接/junction、进入敏感范围、记录损坏或缺少 `dirIdentity` 时只丢弃
  对应记录，不把坏记录变成授权 —— 缺身份的旧记录无法证明“还是同一个目录
  对象”，不恢复成可用授权，让用户走一次重新授权。
- **目录授权绑定对象身份，不只是路径字符串**：记录创建时保存 `dirIdentity`
  （`dev+ino+birthtimeMs`）。每次 `authorizeRead`/`assertStillValid`/`restore`
  都重新核对当前目录对象；删除后原地重建、重命名后被顶替、被换成符号链接/
  junction 时 `dev/ino/birthtime` 已变，旧授权被逐出并通知上层关闭外部标签。
  目录的 `size/mtime/ctime` 会随成员增删变化，不进身份，普通增删子文件不会
  让授权误失效；旧持久化记录没有 `dirIdentity` 时按“无法证明同一对象”处理。
- 单文件授权记录创建时的 `dev/ino/size/mtime/ctime`。文件被替换、大小/身份变化时
  要求重新授权；目录授权的每个文件都在打开时重新 `realpath` 并核对仍在目录内。
- 撤销会推进账本 epoch，并关闭/失效已有的外部标签页、metadata/asset 缓存和在途
  请求；授权对象消失时账本同样自动逐出（`onEvict` → SSE `external_grants`），
  旧 grant id 再访问返回 403，不会“撤销后仍能读一次”。

### 4.3 安全检查（后端为最终权威）

- 只接受本地绝对路径；拒绝 UNC/设备路径、协议相对地址、Windows 保留名
  （`CON`、`NUL`、`COM1`…）、控制字符、ADS/额外冒号与危险特殊形式。
- `realpath` 后再 `lstat`；符号链接/junction 一律拒绝，目录授权只覆盖解析后的
  真实目录内部。读取使用 `O_NOFOLLOW`、`fstat` 复核、再次 `realpath`，缩小检查与
  读取之间的替换窗口。
- 拒绝系统目录、凭据目录（`.ssh`、`.aws`、浏览器 profile 等）、磁盘/用户主目录根
  等过宽范围；不做整个 home/系统盘授权。
- 只读：外部接口没有写入、删除、重命名、执行、修改权限的入口。
- **“用系统默认程序打开”是白名单优先**：`server/open-policy.js` 只放行文档/
  文本/图片/音视频/压缩包等只读查看扩展名；未知类型、无扩展名、可执行文件/
  脚本/快捷方式/安装包、以及白名单扩展名但**文件头是可执行格式**（MZ/PE、
  ELF、Mach-O、`#!`、Java class、.lnk）一律 415。判断只看路径形状 + 有界文件头
  （4 KiB），不依赖用户机器装了什么、也不查注册表关联。
  复审后剔除的执行面：`.svg`（顶层浏览器文档跑内嵌脚本）、`.xsl`/`.xsd`
  （XSLT/`xml-stylesheet`）、`.eps`（PostScript 可执行）、`.doc`/`.xls`/`.ppt`
  （97-2003 VBA 宏）、`.p12`/`.pfx`（证书导入向导）—— 全部按 `unsafe_type` 拒。
  危险文件仍可在内部只读查看器看字节，或交给明确配置的外部编辑器 —— 编辑器
  只读字节不执行；文件管理器定位与复制路径不受影响。
- 外部 document 仍受 256 KiB 预览上限、二进制/类型判断与 `nosniff`/`no-store`
  约束；图片走 8MB 上限的受控 asset 端点。外部文件使用独立的 grant token，不能
  用伪造的“工作区相对路径”绕过工作区守卫。

## 五、外部编辑器配置

设置 → 通用页新增紧凑的“编辑器与访问”卡片（沿用 `createSettingsCard`，不是独立
大卡片/横幅）：

- **外部编辑器**：系统默认程序、Visual Studio Code、Cursor、Windsurf、Zed、
  Notepad++、自定义编辑器。只列出当前平台/实际探测到的选项；“重新检测”重新扫描。
- 探测顺序：Windows 先读 `App Paths` 注册表（`HKCU`/`HKLM`/`WOW6432Node`，兼容
  中文系统代码页输出的本地化路径），再查常见安装目录与 `PATH`；macOS 查 `/Applications`
  与应用内 CLI；Linux 查 `PATH`。探测只做文件存在性判断，不执行编辑器。
- Windows 是首要验收平台；macOS/Linux 保留探测与启动实现，但本阶段未做真实安装
  验收（见限制）。
- 选择保存在主进程的 `editor-settings.json`（既有系统偏好原子写、schema 校验），
  重启后恢复；手选的编辑器若之后被卸载，不阻止保存其它偏好，打开时回退到系统
  默认程序并给出简洁提示。
- 自定义编辑器通过系统文件选择器选可执行文件；保存的是绝对路径，启动时
  `spawn(executable, [file], { shell: false })`，**不拼接 shell 命令**，模型输出
  不参与命令/参数。
- **启动前复核（收窄授权→执行窗口）**：拿到后端授权响应后、真正 `spawn`/
  `shell.openPath` 之前，主进程再做三件事：
  1. 外部授权再问一次后端（`POST /api/files/external/open-target`），授权在响应
     后被撤销/目录被替换就拒绝；
  2. `lstat` 目标仍是普通文件、不是符号链接，且 `dev/ino/size/mtime/ctime`
     与授权响应里的 `identity` 一致 —— 文件在授权后被替换/移动即拒绝；
  3. `realpath` 与授权响应的 `absolutePath` 一致。
  三条都过才启动。撤销与启动的顺序：撤销先到后端的请求后到达即失败。
  这是**尽力收窄**，不是消除 —— OS 层面上 `openPath`/`spawn` 与目标最后一次
  `lstat` 之间仍有微小窗口，见「限制与残余边界」。
- 参数按编辑器能力区分，不假设一致：

| 启动方式 | 编辑器 | 参数 |
| --- | --- | --- |
| `goto` | VS Code / Cursor / Windsurf | 有行号：`--goto <abs>:<line>[:<col>]`；无行号：`<abs>` |
| `line-column` | Notepad++ | `-n<line> -c<col> <abs>`（缺列时省略 `-c`） |
| `direct` | Zed | `<abs>[:<line>[:<col>]]` |
| `direct` | 自定义编辑器 | `<abs>`（不假设支持行号） |

启动使用 detached 子进程且**不隐藏其首个窗口**；Windows 上 `windowsHide: true`
会把 GUI 编辑器的第一个顶层窗口设成不可见（真实桌面验收踩到过）。

## 六、可复用的文件访问接口（下一阶段基线）

本阶段只铺“文件身份 + 统一访问入口”，不重建文件面板，不引入 PDF/Office 引擎：

| 能力 | 工作区内 | 工作区外 |
| --- | --- | --- |
| 文件身份 | 后端签发 `fileId`（workspace.id + realpath + dev/ino/size/mtime 的 SHA-256） | grant id + 实时 `dev/ino…` 复核 |
| 元数据 | `GET /api/files/metadata`（会话头或 root+fileId） | `GET /api/files/external/metadata?grant=…` |
| 内容预览 | `GET /api/files/document`（256 KiB、`O_NOFOLLOW`） | `GET /api/files/external/document?grant=…` |
| 类型识别/图标 | `public/ui/file-icons.js` + 后端图片类型白名单 | 同一套图标；授权后才取 asset |
| 图片字节 | `GET /api/files/asset`（8MB、白名单） | `GET /api/files/external/asset?grant=…` |
| 唯一性查找 | `GET /api/files/find`（有界扫描） | 不支持跨工作区猜测 |
| 打开/编辑器权限 | `POST /api/files/open-target`（action: open/reveal/copy/editor） | `POST /api/files/external/open-target` |
| 授权管理 | — | `GET /api/files/grants`、`POST /api/files/grants/revoke`（仅 list/revoke） |
| 撤销失效 | 工作区 epoch/关闭标签页 | grant epoch、关闭外部标签页、清缓存/中止在途请求 |

内部查看器与外部文件共用同一个右侧 Surface、标签页、行定位和图片预览实现；新增
预览类型只需扩展“类型识别 + 受控读取”，不需要另起一套权限通道。

## 七、模块地图

| 模块 | 职责 |
| --- | --- |
| `public/file-link-model.js` | 路径/行号/URI 解析、工作区包含判断、纯文本扫描、候选标记 |
| `public/markdown.js` | escape-first 渲染并产出带 `data-file-*` 的链接/候选 |
| `public/ui/file-icons.js` | 文件类型 → SVG 图标 |
| `public/file-links-ui.js` | 点击/悬停/右键/键盘、同名选择器、会话缓存与在途请求 |
| `public/files-panel.js` | Files Surface 的标签页、文件树联动、预览、行定位、外部标签页失效 |
| `public/ui/source-highlight.js` | escape-first 轻量语法高亮（200KB 上限） |
| `public/file-actions.js` | 授权、外部打开/编辑器/文件管理器/复制路径的统一动作 |
| `public/editor-settings.js` | 设置 → 通用的“编辑器与访问”卡片 |
| `server/files.js` | 受控只读文件接口、工作区/文件身份校验、外部文件端点 |
| `server/open-policy.js` | “系统默认程序打开”的白名单优先策略 + 有界可执行文件头识别 |
| `server/external-grants.js` | 运行期授权账本、范围/身份/撤销、目录对象身份、启动时恢复校验 |
| `lib/file-identity.js` | dev/ino/birthtime 文件/目录对象身份的统一封装 |
| `electron/external-files.cjs` | 原生确认、私有 IPC、grant list/revoke、系统设置持久化与启动恢复 |
| `electron/editor-settings.cjs` | 编辑器探测/偏好/结构化启动、后端授权桥 |
| `electron/main.cjs` / `electron/preload.cjs` | 主进程装配与固定字段的渲染进程桥 |

## 八、验证与已知限制

`npm run test:file-links` 覆盖模型、后端身份、外部授权、编辑器配置/UI、文件链接
UI、Runtime 与高亮；真实桌面验收入口是 `node tests/file-links-desktop.cjs`
（打包后的 Electron + 真实原生对话框 + 真实 VS Code），截图和结果同时归档在
[docs/file-links-evidence/](file-links-evidence/)。完整数字、产物摘要和未验证项见
[文件引用验收材料](file-links-acceptance.md)。

已知限制：

- 路径形状按 Windows 优先收紧，POSIX 合法但 Windows 非法的 `? * " < > |` 字符不会
  被识别；UNC、设备路径和 Windows 保留名有意不支持。
- 裸文件名/相对纯文本只做有界扫描；更深、被隐藏目录或依赖目录遮住的文件保持普通
  文本，这是有意的保守行为。命中过多时只展示前 12 个供选择。
- 外部编辑器探测是尽力而为：非标准安装位置且未注册 `App Paths` 的编辑器需要用户
  手选自定义可执行文件。macOS/Linux 的启动实现已保留，但未在本机做真实安装验收。
- 自定义编辑器和 Zed 的直传方式不假设支持行号；行定位只在 `goto`/`line-column`
  编辑器上验证。
- 真实 VS Code 启动验收要求运行前没有已打开的 VS Code 实例（否则会走单实例交接，
  无法从命令行确认 `--goto`）；验收脚本会明确检查这个前置条件。
- **OS 层面的启动 TOCTOU 无法完全消除**：主进程在 `spawn`/`shell.openPath` 前
  已做 realpath/对象身份/授权活性三道复核，但从最后一次 `lstat` 到 OS 真正
  拉起目标之间仍存在微小窗口；这是尽力收窄的残余边界，不是声明已消除。
- `.xml` 保留在系统打开白名单（本身是数据），但 `xml-stylesheet` 处理指令
  依赖默认关联的处理器，属于已知残余；`.xsl`/`.xsd` 已剔除。
  白名单内的 `.pdf`/`.docx` 等可含内嵌脚本/宏 —— 默认程序是否执行取决于
  OS 关联应用，不在本层控制范围；文件头嗅探只看前 4 KiB 已知可执行 magic，
  polyglot/无 magic 可执行内容理论上可绕过。**不宣称完全消除执行面**。
- `dev/ino` 在部分文件系统上可能被复用（Windows NTFS FileIndex 删除后立刻
  重建可能拿到同一个 ino）；目录身份用 `dev+ino+birthtimeMs` 三重判定，单文件
  另加 `size/mtime/ctime`。仍非不可伪造的对象 GUID —— 这是 stat 能给到的
  最强近似。
- PDF/Office/压缩包不做页面内渲染；语法高亮是轻量 Tokenizer，不是完整 AST
  高亮器。
- 没有新增依赖、没有修改 pi 本体；验收只写 `os.tmpdir()` 和隔离的 `userData`，
  不写用户真实项目或真实应用配置。
