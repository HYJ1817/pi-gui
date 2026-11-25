# 统一文件查看器：实施契约

基线 `032b96659faee5d2a1252fbb744b2da4c5f3ef3d`。本文件协调本阶段模块边界，不另立授权系统。第一阶段 `file-links.md` 的授权、对象身份、撤销与外部打开策略保持权威。只读，不保存/删除/重命名文件。

## 状态与入口

`public/files-panel.js` 持有 surface、工作区令牌、会话级 tabs、顺序、树、布局与活动文件；`public/file-preview/index.js` 持有单个当前预览的加载和释放。标签只保存有界请求描述及阅读状态，不长期缓存文档字节或原始内容。工作区/会话切换、关闭、撤销均释放当前预览。恢复必须重新元数据/对象身份校验；不在 localStorage 保存 grant id/附件字节，外部授权标签不跨重启恢复。

入口统一调用 `openFileReference(request)`，请求沿用 `{path,name,cwd,conversationId,fileId,workspace,generation,external,grantId,line,column,endLine,endColumn,bytes}`。附件额外允许 `{source:'attachment',file:File,name,size,attachmentId}`，只读取该 File；禁止将附件绝对 path 当成授权工作区文件。附件业务/视觉不重构。

## 预览接口（所有实现共同遵守）

`mountFilePreview(host, request, options={})` 从 `public/file-preview/index.js` 导出，**同步**返回 `{ready:Promise, dispose(), getState()}`。options 包括 `{toolbar:HTMLElement, state:Object, transport:Object, onMetadata(file), onOpen(request)}`。面板切换前通过 getState 保存，再 dispose，过期 ready 不得写回。

注册表按扩展名选择懒加载插件，但实际字节头/格式校验是独立门控，不把扩展名当真。插件 `export async function mount(ctx)` 返回 `{dispose?(),getState?()}`。

ctx：
- `host` 内容容器；`toolbar` 当前格式专用工具区域（不是全局操作堆叠）。
- `request` 不可跨 owner 变更的请求；`meta` `{name,path,bytes,fileId,...}`。
- `state` 上次插件阅读位置，默认 `{}`。
- `access.bytes(maxBytes)` → Promise<Uint8Array>，读取统一受控接口；`access.text(maxBytes)` → Promise<string>（UTF-8/BOM UTF-16/GB18030 安全降级）；`access.url()` → 受控媒体 URL。附件 url 只来自自身 File 的 ObjectURL。
- `resources.signal`；`resources.isCurrent()`；`resources.own(disposer)`；`resources.url(blob)` 创建且托管 ObjectURL。资源不跨预览实例共享。
- `open(request)` 文档相对文件链接委托统一入口；`error(message)` 简短统一降级。

公共 UI 辅助为 `public/file-preview/common.js`：`node(tag,className,text)`、`button(label,handler,{icon,title}={})`、`searchControl(toolbar,onSearch)`（返回 input）、`formatBytes`。插件可直接使用公共 `.icon-btn` / `.btn.ghost.tiny` / `.ds-input`，只使用现有 Token。格式相关样式在 `public/file-preview/preview.css`；主面板样式在既有文件面板 CSS 所有者。插件负责人可增加自己的按需样式文件，但不得写共同 preview.css。

插件路径与责任：
- `text.js`、`markdown.js`、`html.js`、`pdf.js`：主代理。
- `office.js`、`office-worker.js` 及 office 私有模块：Office 实施代理；导出 mount，根据 ext 分流 DOCX/XLSX/CSV/TSV/PPTX。
- `image.js`、`media.js`、`archive.js`、`zip-policy.js`：媒体/压缩包代理。zip-policy 导出 `inspectZip(bytes,options={})`，返回 `{entries,read(name,maxBytes)}`；entries 包括 `{name,size,compressedSize,directory}`，拒绝路径穿越/设备名/符号链接/加密/异常头/超条目/比例/总解压预算；read 使用有界流解压并校验实际大小。

重模块只在打开对应类型后动态 import。Office/PDF 解析不得在 Electron main 执行。Worker 必须有超时与 terminate；所有库从本地 vendor 加载，无 CDN，无运行时在线服务。

## 后端增量（只扩展现有 files owner）

新增 `GET /api/files/content` 与 `/api/files/external/content`，保留第一阶段 document/asset 等接口及行为，避免破坏旧消费者。query 沿用 metadata 的身份字段；workspace content 必须 fileId，external content 在已有 grant 基础上还需文件对象 token（元数据 fileId）以防目录授权下标签内容被替换。metadata 返回可用于内容读取的 fileId、bytes/name。可带 `conversation` query，为原生 media URL 明确 owner；用同一 scopeForRequest 解析，不允许客户端指定真实 root。若 header/query 不一致拒绝。

所有内容读均重新 lexical/realpath/lstat/O_NOFOLLOW/fstat/读后对象及scope/grant复核。JSON/错误不回显原始解析 payload。支持单个合法 Range，限制每次响应至8MiB（媒体可以多个Range逐步读取）；Range为206/416有真实Content-Range。不因Range放大可访问路径。非媒体全读取限额由格式策略决定；拒绝可执行 magic伪装为文档/图片/媒体。危险HTML/SVG不可作为可信DOM载入，字节接口带nosniff/no-store/attachment+CSP，不允许任意顶层脚本执行。

文件树搜索：新增 `/api/files/search?q=...`，复用workspace身份/有界遍历，不扫外部授权目录，不无界递归；最多4000条、深度8、结果100。隐藏项显式控制。

后端实施代理拥有 server/files.js、新增 lib/file-preview-*.js 叶子、相关专用tests；不改api.js/package.json/构建脚本（交主代理）。可不修改第一阶段grant账本；需要时报告接口原因。

## 分工与集成约束

- 面板UI代理拥有 files-panel.js、public/work-surfaces.css 中文件面板块（核对实际归属）、新增 files-* UI子模块与相关专用tests；不得实现格式分支，只调 mountFilePreview。
- Office代理拥有 Office插件/worker/私有CSS/tests；不改 package.json/lock或shared common/registry。
- 媒体压缩包代理拥有image/media/archive/zip-policy与私有CSS/tests；不改shared文件。
- 主代理拥有 registry/common/access、轻格式/PDF、api.js、最小入口适配、公共preview.css、依赖与vendor/构建、fixture/桌面验收与最终报告。

需要接口差异先在报告中说明，不能另建授权/复制renderer。各代理直接在本worktree负责路径内实现，不commit/push，不创建子代理。
