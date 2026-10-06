# P32.3 独立会话运行时实施计划

> 执行方式：按已批准 ADR 0032 分步骤实现；独立监督原语由子任务实现，其余由主任务顺序完成。每步先运行行为回归，再实施并验证。未完成本阶段验收不进入 P32.4。

基线：`698fcab252795d29176aa6c21bc40e3e0e2def52`，分支 `codex/p32-worktree-multisession`。

目标：保留现有单会话路径，新增固定绑定受控 worktree 的独立 Pi child；并行入口使用完整 authoritative owner，不改变 Pi RPC/schema。

## 实施与验证顺序

- [x] 基线：fetch 后核对 main，运行全部 `npm test`，保留日志和失败样本。
- [x] `server/runtime-registry.js`：磁盘 conversation 记录与存活 runtime 分离；默认总 child 2、显式临时 3、硬上限 3。workspace root lease、session locator lease、随机 backend/runtime generation，命令/回读/事件在异步前后核对；200 条/1 MiB 有界事件与历史恢复标记。`tests/runtime-registry.cjs` 用可控 factory、延迟健康检查和 late callback 验证。
- [x] `server/pi-supervisor.js` / `extensions/pi-gui-process/runtime-child.cjs`：复用 P31 Job Object / POSIX guardian，增加私有认证 duplex RPC transport。只接受组合根证明的 node/官方入口。退出、重启在 guardian 整树清理后生效，不按 PID 终止。`tests/pi-supervisor.cjs` 验证分流、晚事件、EOF 和真实临时 Node 后代。
- [x] `server/worktrees.js`：受控 workspace admission 在生命周期锁中校验；in-use 包含后台 lease，健康失效清理该 owner。保留 P32.2 nonce、dirty/unmerged 拒绝与路径验证。
- [x] `server.js`：按 owner 复用 bridge、project config、model generation、Activity、Process manager、sessions scanner。新 `server/runtime-routes.js` 接收 scoped command/state/events/history/close/restart/process/approval 请求。原路由聚合维护和资源闸门，不让 legacy workspace 切换绕过 lease。
- [x] Electron Browser：per-owner 独立 bridge/controller/非持久化 partition，最多 3 个，只有 focused view 挂载。生命周期 master credential 留在 backend/main，Renderer 只拿非敏感 owner；各 owner 默认关闭权限。沿用 P29 localhost-only policy、CDP/ref/document generation。
- [x] `public/runtime-sessions.js`：工作区三点菜单中的窄范围并行会话 surface；focus、发送、Stop、审批、重启/关闭与 bounded message/Tool 摘要。后台事件按 owner 更新有界模型，focus 不重启。完整侧栏/history/search 整合留 P32.4。
- [x] 离线：registry、HTTP、真实 bridge fixture、Browser scope、Process global quota、UI focus/late result；新套件进入唯一 `npm test` 入口。
- [ ] 真机：临时 repo A/B，真实 Pi coding 重叠、Git/文件隔离、独立 Stop/crash、Browser/Process 独立；2–3 会话至少 30 分钟，逐 owner 统计失败、内存和清理证据。不得把假 Pi 算作真实模型证明；缺本机条件如实报告。
- [ ] 交付：全量 test、专项和 Electron harness；`build:app -- --rebuild`、已有 app 检查；报告 before/after/branch、identity/状态/资源/恢复、真机与已知限制。按业务/测试/文档拆提交；不推送、合并或发版。

## 与 P32.4 的分界

现有 renderer 的全局 S 不承担后台会话路由。P32.3 窄范围 surface 有自己的 per-conversation model；经典聊天继续原体验，两者命令和事件不能互相落入。用户明确 focus 独立会话才展示对应输出；不增加主侧栏一级入口。P32.4 才将该 authoritative model 接入完整侧栏与历史导航。

第三方 Extension/MCP/共享用户配置仍不是 OS sandbox；不宣称其全局内部状态完全隔离。若无法证明退出或身份，保留 lease/失败态并拒绝新写者。

## 当前验收记录

实现/离线和 Electron 验证见 [P32.3 验收记录](p32-3-acceptance.md)。真实默认模型两路 HTTP 502，coding 与 30 分钟压测未通过；本阶段仍未验收，不进入 P32.4。
