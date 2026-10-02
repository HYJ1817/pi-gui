# P14-A App Shell

界面分为三列：52px 的 Global Rail、项目与会话侧栏、工作区。700px 窗口下 Rail 收至 46px，项目侧栏收至 190px；侧栏也可手动折叠，折叠只改变 DOM 可见性，不写入项目或会话状态。展开后仍定位同一项目和会话。

Global Rail 只调用已有功能：对话返回主工作区；任务打开 Planner；文件变更打开 Git Changes；扩展打开 Skills / Extensions / MCP；更多菜单提供诊断和模型供应商。版本检查仍在诊断面板里，发现新版本时 Rail 更多入口显示提示点。分支树和会话操作保留在工作区顶部的原有入口。没有 Voice、Automations、Worktree、Cloud Tasks 或 PR Review 入口。

项目侧栏顶部是新对话和会话搜索；搜索仍调用既有当前项目搜索模块。项目分组里直接列出当前项目的 Session，切换项目仍按原逻辑重启 pi。添加文件夹与项目设置移入项目操作菜单 —— 其中**「项目设置」只出现在当前项目那一行**（`openProjectSettings()` 读的是当前激活项目的配置，对非当前项目开放这个入口等于「点 B 的菜单、改的却是 A 的设置」；要改 B 就先切到 B，而切换会重启 pi，那不该是一个菜单动作顺手造成的副作用）；非当前项目的菜单只有「移除项目」，它按**这一行的 path** 操作。删除项目保留在项目行的悬停或键盘聚焦动作里。归档列表和会话操作沿用原来的会话模块。用量常态只显示上下文摘要，展开显示输入、输出、缓存、成本；数据仍由原来的 `get_session_stats` 更新。

侧栏层级在这一轮 UX 修复里收紧了：**项目行与会话行同高**（34px），绝对路径不再常驻第二行（改挂在行的 `title` 与 `.pj-select` 的 aria-label 上），当前项目行内多了一个折叠箭头 —— 点它只折叠**这个项目下面的会话列表**（`aria-expanded` / `aria-controls` 同步、键盘可用，不影响项目切换与删除）。换项目（列表整体重渲染）后回到展开；折叠状态下点「搜索会话」会自动展开，否则输入框会被藏住。跨进程的标题栏颜色统一到 `--titlebar`：它必须与 `electron/main.cjs` 的 `titleBarOverlay.color` 同值，`tests/dev-server.cjs` 有一条断言盯着这两个值。

本阶段没有修改 Planner DAG、Attempt、审阅、Git Changes、会话存储与分支、provider / diagnostics API 或 pi RPC。工作区仅调整外层尺寸和背景，消息流、工具时间线与输入框内部保持原样。

P14-D 将任务、文件变更、扩展改为 Global Rail 的 Stage 一级视图；Chat 与 Composer 切出时仅隐藏，原 DOM 和流式处理继续保留。二级弹窗仍由独立的 Modal 管理。实现与生命周期见 [work-surfaces.md](work-surfaces.md)。

验证入口：`npm test` 覆盖导航 DOM、handler、项目与会话切换、搜索等；`npm run harness` 加 `npm run shots:harness` 用真实 Chrome 验证 57–66 场景，以及 900、1200、1536px 三个宽度场景，包括展开、折叠、项目与会话、Rail 激活、More、用量和 700px 宽度。每张场景都带结构或视口数值判据。

P14-E 将 Shell 的可点击选中态、悬停态与焦点环统一到中性灰阶。More 与项目菜单在 Escape 后把焦点还给触发按钮；一级工作区替换时若焦点位于被卸载的 Surface，焦点移到新一级导航，回 Chat 时移到可用输入框；无项目导致输入框禁用时回到 Home 导航。用量的正常进度采用灰色，超过阈值才显示警告或错误色。

普通 Modal 每次打开前恢复基础布局类，避免先打开宽 Planner 弹层后，供应商等小弹窗继承其宽度或高度。确认框继续使用独立层与原来的取消语义。

Electron 的最小客户区调整为 700×600，并与保存窗口状态的下限共用同一常量；700px 样式因此也能在真实桌面窗口使用。

Windows 150% 缩放下，请求 700×600 可能得到约 701×602 的实际客户区。窄屏 CSS 阈值留到 720px，确保 DPI 取整后的真实窗口仍采用上下分栏和较窄侧栏。
