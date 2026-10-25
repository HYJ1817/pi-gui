# Z4-2 接口契约与执行计划

本文件保留 C0 冻结设计、最初分工与执行清单；末尾复选框不是当前完成状态。实际交付、桌面应用协作、验证与剩余边界见 [Z4-2 验收](Z4-2-acceptance.md)。

基线 `c9ac555a43c7b72216f347a63ddeeb52afa6c72c`。Z3 schema 不变；无新增依赖、Pi 修改或项目文件写入。产品验证只用离线 fake Pi；外部协作应用代码审查按用户授权执行。

## C0：冻结的公共协议

纯数据模块 `lib/collab-doc.js` 从原型提炼，保留原型导出及 document/operation/proposal 形状。它不依赖 server/public/DOM/IO。document 为 `{documentId,schemaVersion:1,revision,title,boundSessionId,graph:{nodes,edges},appliedOps}`；revision 从 1 开始，每次非重复事务加 1，必须 safe integer。节点 `{id,label,x,y}`；连线 `{id,from,to,label?}`。ID 最多 64 字符，节点 200、边 400、标签 1–200 字符且非纯空白、批次 50、日志 500、文档 2 MiB。节点/边共用 ID 空间，无自环/同向重复。删除节点必须先删引用边。未绑定 session 的文档仅为纯数据层构造状态；生产创建在服务端绑定已验证 scope.sessionId 后才允许持久化，存储读写均拒绝 null/异 session。

操作 `{opId,type,baseRevision,actor,params}`，type 闭集 `node.add/update/remove`、`edge.add/update/remove`，沿用原型 params；edge.update 以 label:null 清除文字，改端点使用 remove+add 的原子批次。整个批次 baseRevision 必须等于文档 revision；一项失败全部不变。规范指纹与键顺序无关；全批同内容重放返回 duplicate，混合重放拒绝。日志持久化且有界；窗口外由旧 revision 拒绝。

proposal `{proposalId,schemaVersion:1,documentId,baseRevision,sessionId,rationale,ops}`。proposalId 由构造入口生成不透明 UUID，不截断操作 ID 拼接。preview/accept/reject 各自完整校验信封、ID、schema、session、1..50 条操作、agent actor、批内唯一 opId 和每项一致的 baseRevision；包括 duplicate 快径之前。预览只返回 diff，不提交。accept 先校验 expectedRevision 是显式有效整数；完全一致的已接受建议允许在后续 revision 重复确认而不修改状态。模型不能通过自述取得来源权限。

`serialize/deserialize` 为严格规范持久化格式，包含校验后的 appliedOps；拒绝未知字段、损坏日志、未知版本和越界。原型旧无日志格式不自动迁移。`validateDocument(doc)` 返回经严格校验的副本或抛 CollabError；`applyUserOperations(doc,ops)` 校验全批 actor=user 并返回结果。其他结果沿用 `{ok,doc,revision,...}` / `{ok:false,code,detail?,conflict?}`；对外 HTTP 不回传 detail、原始错误或路径。

editorState 为不持久化的 `{undoStack,redoStack}`，历史上限 100。接受建议及用户批次均逐操作计算逆操作；关闭面板、owner/token/revision 外部变化、会话/项目切换或重启即丢弃。落盘成功前只修改历史副本。UI 不反序列化或信任服务器端幂等日志，不另存权威文档。

## 后端边界（A1/A2）

`createCollabStore({dataDir,protectedRoots=()=>[],io?,checkpoint?}) -> {read(scope),write(scope,expectedRevision,doc)}`。read 返回 `{doc:null}` 或 `{doc}`；write 返回 `{doc}`。每个 scope 一份文档。首次 expectedRevision=null，更新须等于磁盘 revision 且 doc.revision=expectedRevision+1；相同快照重试不得改写。内部校验 doc/documentId，安全根固定 `<dataDir>/collab-documents`，与项目/Worktree/Git 元目录分离；有 scope stamp、锁、容量、身份、损坏拒写、临时 fsync/rename，失败保留已有字节。scope 只能来自服务端 authority；不接受 Renderer 根目录、路径、scopeHash。

`createCollabAuthority({classic,registry,withWorkspace}) -> withAuthority(req,action)`。复用现有完整 review-comment-authority 取证流程，使用独立 collab 命名空间。回调 scope 至少 `{key,token,sessionId,assertCurrent,projectRoot,workspaceCwd,gitCommon}`；key/token 为 64 位 hex，sessionId 是服务端根据已验证身份派生的 64 字符以内不透明 ID，不泄漏原生路径。key 稳定用于重开；token 绑定完整活 owner/context，代次变化失效。校验 focused conversation、runtime generation、workspace epoch、backendInstance、原生 session 文件身份。安全错误闭集 `collab_*`，禁止原始 message 泄漏。

## UI 边界（Z1/Z2）

`mountCollabCanvas(host,{document,readOnly=false,onOperations=()=>{},onUndo=()=>{},onRedo=()=>{},confirmDelete?}) -> {update({document,readOnly?,busy?,error?,canUndo?,canRedo?}),destroy()}`。
`onOperations` 只发 `[{type,params}]` 意图；上层补 opId/baseRevision/actor=user。拖动只在结束时提交一次，拖动预览属于临时视图。document 使用 graph 形状；纯 DOM/SVG、textContent，不依赖数据模块/全局状态/HTTP。删除有连线节点需一次提交先删边再删节点。undo/redo 完全由上层回调执行；destroy 清监听。

`mountCollabProposal(host,{onAccept,onReject,onRegenerate}) -> {update({document,proposal,preview,busy?,error?,readOnly?}),destroy()}`。preview 是 `{diff:[{opId,type,summary}],resultingRevision,nodeCount,edgeCount}`。预览与 update 无写回；显式点击才回调 proposalId。不自行申请/应用建议；无建议时显示空状态。

CSS 独立 `public/collab.css`；窄栏/深浅主题/键盘/焦点/冲突覆盖在独立 DOM 测试中验证，Electron 由主 Agent 统一跑。

## C2 集成与依赖

服务端 `server/collab-service.js` 持有有界 editor 运行态；`server/collab-routes.js` 只接受 open/create/operations/undo/redo/close 和服务端队列 proposalId 动作。HTTP 不接受整文档覆盖、磁盘路径或来源自述。路由位于既有 Origin+Token 认证之后、classic-only owner guard 之前，通过独立 authority。客户端 `public/collab-panel.js` 通过 api.js 请求，secondary-surface 挂载；顶部会话工具按钮打开，无新全局导航。所有异步回写需同 surface/workspace/conversation/owner，切换同步禁写。

阶段 3 未取得可信 RPC 来源前，生产建议队列为空，UI 明示未接入；fixture 只用于测试，不伪装生产 Agent 闭环。

## 文件归属与执行顺序

| Worktree 分支 | 独占文件 |
|---|---|
| codex/z4-2-integration | lib/collab-doc.js、tests/collab-doc.cjs、server/collab-service.js、server/collab-routes.js、public/collab-panel.js、集成入口、package.json、tests/modules.cjs、集成/Electron 测试、验收 |
| antigravity/z4-2-backend | server/collab-store.js、server/collab-authority.js、tests/collab-store.cjs、tests/collab-authority.cjs、docs/Z4-2-agent-source-research.md |
| zcode/z4-2-canvas | public/collab-canvas.js、public/collab-proposal.js、public/collab.css、tests/collab-canvas.cjs |

- [ ] 基线：git fetch、精确 CI、原型 49、本地完整 canonical（高风险）。
- [ ] C0 契约提交；三 Worktree 从契约提交起步，之后并行 C1/A1-A4/Z1-Z4。
- [ ] 各自定向红绿测试、中文独立提交；不运行争用资源的全量测试/构建。
- [ ] 主 Agent 逐提交复审集成；HTTP/Owner/存储/生命周期定向测试。
- [ ] 独立功能与安全审查，最多三轮增量修复。
- [ ] 本地完整 npm test，构建 App/SEA 与正常沙箱 Electron 真交互截图；未运行/失败逐项记录。
- [ ] docs/Z4-2-acceptance.md 写入来源 SHA、命令/退出码/实测数量/故障证据/限制/回滚；代码、测试、文档完成后停止，不 push/PR/merge/tag/release。
