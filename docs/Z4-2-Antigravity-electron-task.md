# 桌面 Antigravity：Z4-2 Electron 验收修正任务

用户已授权更多使用桌面协作 Agent；禁止启动任何子代理。主 Agent 为 Codex。

只修改 C:\Users\21022\.codex\worktrees\z4-2-backend\pi-GUI 中的三个文件：
- tests/collab-electron.cjs
- tests/fixtures/z4-collab-electron.cjs
- tests/fixtures/z4-collab-scenarios.cjs
当前分支 antigravity/z4-2-electron，代码基于集成提交 f66ef8b5eb57c289d6731f0b27277eed0a48948c，三个测试草稿已复制进来。
生产源码只读。禁止修改 C:\pi-GUI、integration 工作区、package.json、生产模块、用户真实数据或全局 npm。无需提交，由 Codex 检查 diff 后集成并记录来源。

只用文件阅读/编辑工具，不通过终端执行任何命令/测试；Codex 将统一执行真实测试，避免资源争用。禁止 push/PR/merge/tag/release、下载依赖、模型调用、网络操作或启动其他 Agent。

现有 Electron 在正常 sandbox 下已验证到 Runtime close/resume 成功；参考结果 C:\Users\21022\AppData\Local\Temp\pi-gui-z4-electron-run4\results.json（只读），失败于 second actual project ready。失败不是已证实产品缺陷：fixture 直接调用 api.activateProject，却未进入实际前端工作区切换状态机，workspaceGeneration 不会自动增加。请查 public/projects.js activateProject、public/session-navigation.js 的 browseProject 背景会话规则、public/app.js bridge snapshot 协调。

目标：最小修正真实项目 A-B-A 验收，不伪造 Owner、document、RPC、业务状态或成功响应。优先走已有公开的生产前端流程；确需直接调用后端激活时，按生产状态机调用同一 beginWorkspaceSwitch/状态协调入口，并说明该测试路径的资格限制，不能直接给 S.cwd/Owner 赋值假装切换。

特别注意：当前 runtimeStore 留有 dormant Runtime 行，session-navigation.hasBackground 依照 owner 判断，projects.activateProject 可能有意打开 history 而非停止后台切换 cwd。不要为测试修改产品行为或清空 runtimeStore。可以先真实验证项目浏览行为，再使用明确的既有激活入口验证后端项目代次隔离。

保留已经通过的真实鼠标 sendInputEvent 拖动、持久化/CAS、三档宽度、主题、Runtime close/resume、Browser 原生遮挡、进程创建身份清理。不得降低断言、忽略超时、关闭 sandbox 或伪造截图。

请用文件工具完成修正，给出改动路径、根因、仍需 Codex 实测的条目。若发现产品问题，只报告证据，别改生产模块。预计后续 Codex 会请你做最终第三轮增量功能复审；本次是测试实现任务。

补充视觉验收问题：run4 的 collab-light.png 仍显示深色，现有断言只检查 display，并未证明浅色。请通过生产 theme 接口或真实 dataset 切换，等待两个 requestAnimationFrame 后断言 computed 背景/文字颜色确实变化，再 capturePage；不要沿用当前这张图当浅色证据。需保留深浅主题/三档宽度的真实截图。也检查 labels stroke='none' 回归仍保留。
