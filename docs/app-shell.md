# P14-A App Shell

界面分为三列：52px 的 Global Rail、项目与会话侧栏、工作区。700px 窗口下 Rail 收至 46px，项目侧栏收至 190px；侧栏也可手动折叠，折叠只改变 DOM 可见性，不写入项目或会话状态。展开后仍定位同一项目和会话。

Global Rail 只调用已有功能：对话返回主工作区；任务打开 Planner；文件变更打开 Git Changes；扩展打开 Skills / MCP；更多菜单提供诊断和模型供应商。版本检查仍在诊断面板里，发现新版本时 Rail 更多入口显示提示点。分支树和会话操作保留在工作区顶部的原有入口。没有 Voice、Automations、Worktree、Cloud Tasks 或 PR Review 入口。

项目侧栏顶部是新对话和会话搜索；搜索仍调用既有当前项目搜索模块。项目分组里直接列出当前项目的 Session，切换项目仍按原逻辑重启 pi。添加文件夹与项目设置移入项目操作菜单；删除项目保留在项目行的悬停或键盘聚焦动作里。归档列表和会话操作沿用原来的会话模块。用量常态只显示上下文摘要，展开显示输入、输出、缓存、成本；数据仍由原来的 `get_session_stats` 更新。

本阶段没有修改 Planner DAG、Attempt、审阅、Git Changes、会话存储与分支、provider / diagnostics API 或 pi RPC。工作区仅调整外层尺寸和背景，消息流、工具时间线与输入框内部保持原样。

P14-D 将任务、文件变更、扩展改为 Global Rail 的 Stage 一级视图；Chat 与 Composer 切出时仅隐藏，原 DOM 和流式处理继续保留。二级弹窗仍由独立的 Modal 管理。实现与生命周期见 [work-surfaces.md](work-surfaces.md)。

验证入口：`npm test` 覆盖导航 DOM、handler、项目与会话切换、搜索等；`npm run harness` 加 `npm run shots:harness` 用真实 Chrome 验证 57–66 场景，以及 900、1200、1536px 三个宽度场景，包括展开、折叠、项目与会话、Rail 激活、More、用量和 700px 宽度。每张场景都带结构或视口数值判据。
