# 桌面 ZCode：Z4-2 第二轮安全增量复核

请只读审查 C:\Users\21022\.codex\worktrees\z4-2-integration\pi-GUI，基线 c9ac555a43c7b72216f347a63ddeeb52afa6c72c，最新生产行为 f66ef8b5eb57c289d6731f0b27277eed0a48948c。用户希望更多使用桌面 ZCode；禁止启动子代理。

仅用文件阅读工具，不运行终端命令、不测试、不编辑文件、不下载依赖、不访问外网、不调用其他 Agent，不 push/PR/merge/tag/release。避免争用正在运行的 canonical 和构建资源。

请先读 AGENTS.md、REVIEW.md、docs/Z4-2-contract.md、docs/Z4-2-reviews.md。第一轮已覆盖存储/取证主体；本轮集中于新增变更和受影响边界，避免重报已证伪的问题。

重点：
1. 03b4749 对真实 Windows 8.3 路径的修复：必须先检查 raw 祖先链，不能 realpath 后抹掉 junction；同实体短名/长名兼容不放宽文件身份、硬链、替换、损坏、容量检查。tests/collab-store.cjs 真实短名用例53/53 assert149 skip1（文件 symlink EPERM）。
2. server.js 创建固定 DATA_DIR 存储、protectedRoots、完整 Classic/Runtime authority，source 仍未注入。
3. server/router.js 新路由必须在 Origin+Token 之后，Classic-only guard 之前，传入可信 authority。真实 Router HTTP7/7 assert28。
4. package.json 新 canonical alias8叶 + tests/modules.cjs 依赖方向守卫，canonical 总208；完整 npm test 正在运行，不能声称已通过。
5. public/collab-panel.js：Runtime signature 不受无关 Classic bridgeRun 影响；session-switch/workspace-generation 同步失效；异步迟到响应与 orphan editor close；确认框归属；保存未知结果与冲突拒写。
6. public/app.js/index.html/CSS 的真实挂载：没有全局 rail 新入口、不改 Z3 schema，SVG stroke 覆盖不影响其他图标。
7. stale .writer.lock 仍保守拒写，无自动解锁；文案与验收明确维护者离线检查，不谎称等待即可恢复。同用户恶意原生竞态/断电/所有平台未获资格。
8. 阶段3生产 proposal source=null；fixture 注入接口不代表不可变可信队列/content digest 已实现，不能对外演示真实 Agent 闭环。

按 Blocker/Important/Nit 给出有证据发现：文件位置、触发条件、影响、是否本次引入。若无阻断请明确本轮范围通过/零发现，同时写未运行测试与残余资格。不要把作者提供的数据称为你亲自实测。最多三轮收敛；本轮为你的第二轮独立安全审查。
