# 原有功能与设计方案入口映射

**2026-11-01修订：**当前视觉基线为 [Refined输入辅助修订版](15-input-assistance-validation.md)。下表60项能力、owner与资格不变；“推荐A”列保留首轮名称，当前入口按下述对应读取。未实现的高级流程仍仅映射，不能当作可执行原型能力。

| 首轮位置 | Refined 当前入口 |
| --- | --- |
| 52px全局Rail + 项目栏 | 合并为264px单侧栏；聊天保留会话入口；任务与审阅、Skills与扩展归入设置“工作区”组 |
| Rail设置 | 侧栏底部设置；进入后分类替换会话列表，返回工作区恢复上下文 |
| Skills顶部类型Tabs | 设置→Skills与扩展，内容区类型Tabs、名称搜索、范围筛选、来源/状态及详情 |
| 项目头+、并行会话末项 | 项目三点菜单中的添加文件夹、工作区管理、新建并行会话 |
| 标题前分支 | 会话More中的分支树、行菜单/回复末尾的分支入口 |
| 输入区左侧模型/等级 | 输入区右侧模型/等级与发送组；附件及引擎在左 |
| 全宽底栏主题/引擎 | 侧栏底部主题；输入区引擎演示切换；演示标记在侧栏底部 |
| Changes/Browser/工作工具 | 顶栏工作面板开关→右面板首页/导航；Specs/协同/开发进程保留在右面板工作工具菜单 |
| 工具逐条常驻 | 正文内活动摘要 → 展开列表 → 单项详情；不删除任何活动 |

日期：2026-10-31。代码基线：`9694339`（`codex/fix-bugs-8-11`）。本表以当前代码为事实源；历史设计文档中已经过期的入口说明不覆盖当前实现。

本阶段只设计，不迁移接口、修改状态模型或删除功能。推荐 A 使用 52px 全局 Rail、248px 项目/会话侧栏和会话顶栏右侧工作面板入口。任务、Skills 与扩展保留一级导航；设置使用分组目录；高级会话操作保留 More。Changes、Specs、协同、Browser 为右栏工作面板。

覆盖列的「核心」表示本阶段交互原型的核心场景设计目标，**不是生产实现已迁移或后端功能已验证的声明**；「仅映射」表示入口、状态、能力边界已经纳入重构方案，但原型不执行其完整业务。实际原型截图与交互验证以最终验收记录为准。所有原型数据均为演示，不能把模拟更新、撤销、执行、认证或浏览器页面当成真实动作。

## 全量功能映射

除显式标明的 `server/`、`docs/` 路径外，表内前端文件均相对仓库的 `public/` 目录。源位置提供最小定位；实现阶段须重新核对 HEAD。

| ID | 原有能力与旧入口 | 推荐 A 新入口 | 现有 owner / 关键位置 | 能力与状态约束 | 原型覆盖 |
| --- | --- | --- | --- | --- | --- |
| F01 | 对话主页：Global Rail | 一级「对话」 | `index.html:31`；`app.js:1063`；`ui/workspace-surface.js:38` | 隐藏并保留现有 Chat DOM、草稿与流式输出，不反复重建 | 核心 |
| F02 | 项目列表、展开/折叠与切换 | 左侧项目分组 | `projects.js:152,167,364`；`sidebar-expansion.js:2` | 名称、chevron、三点分别操作；激活仍遵循原 lifecycle/generation | 核心 |
| F03 | 添加文件夹：项目菜单、无项目欢迎区 | 项目头「+」与无项目空状态 CTA | `index.html:53,156`；`projects.js:405` | 由用户选择 Pi 读写/执行目录，不擅自猜目录 | 仅映射 |
| F04 | 项目设置：当前项目三点菜单 | 当前项目菜单「项目设置」 | `projects.js:250-263`；`project-config.js` | 非当前项目不能直接修改当前项目配置；项目切换不是菜单副作用 | 仅映射 |
| F05 | 移除项目 | 项目三点菜单危险项 | `projects.js:308-346` | 只从 GUI 列表移除；不删除磁盘项目文件，运行中仍由既有闸门判定 | 仅映射 |
| F06 | 工作区 / Worktree 管理 | 项目菜单「工作区管理」 | `projects.js:260`；`worktrees.js:14-92` | 保留 prepare→确认→nonce；外部工作区只读；移除受健康、干净、合并状态约束 | 仅映射 |
| F07 | 新建并行会话 / 独立会话管理 | 项目会话列表末项及工作区管理 | `runtime-nav.js:202,208-286`；`worktrees.js:24` | 真实 Git 归属才有入口；新 worktree 不带未提交改动；不新增 spawn 路径 | 仅映射 |
| F08 | 新建会话 | 侧栏顶部「新对话」 | `index.html:47`；`app.js:1280`；`session-navigation.js` | 不删除旧会话；pending→落盘身份交接沿原实现 | 核心 |
| F09 | 历史会话列表、选中、稳定排序 | 项目下固定顺序会话行 | `sessions.js:392-464`；`server/sessions.js:83-104,370`；`runtime-nav.js:94-95` | 点击与后台事件不重排；保持 Classic sessionId 与 Runtime conversationId 的独立身份 | 核心 |
| F10 | 会话搜索与结果定位 | 侧栏「搜索会话」 | `session-search.js:44,113,326`；`app.js:1232` | 保留作用域、查询状态、结果定位；空查询恢复列表；不新建内容索引 | 仅映射 |
| F11 | 会话归档、还原、软删除、改名 | 行三点 / 右键菜单 | `sessions.js:254,512,605,623` | 归档不改 Pi 文件；软删除保留可恢复语义；危险项单独确认 | 核心（菜单与演示反馈） |
| F12 | 分支树及分叉 | 会话标题前分支入口；More 中可有别名 | `index.html:93`；`tree.js`；`app.js:1054` | 复用原生会话分支，不改 session schema | 仅映射 |
| F13 | Classic 正常聊天与 Markdown | 主阅读区 | `messages.js:323,367,440,474,606,665`；`markdown.js` | 保留段落、列表、代码、表格、引用、链接、附件语义；长行局部滚动 | 核心 |
| F14 | 空会话、无项目、工作区恢复 | 主阅读区空状态 | `index.html:130-160`；`messages.js:56`；`shell.js` | 恢复中、已就绪、无项目不能混为一种状态；无项目禁用发送 | 核心 |
| F15 | Thinking 文本折叠 | 消息内「思考过程」折叠行 | `messages.js`；`docs/conversation-ui.md`；`runtime-conversation.js:258-264,663-670` | 没有真实文本就不造内容；流式结束保留手动展开；历史缺失不补造 | 核心 |
| F16 | 工具执行与复杂时间线 | 消息内连续 Tool Activity | `tool-view.js:76,159,336,374`；`tools.js`；`tool-history.js:43` | 实时/历史复用 ToolEntry；成功、失败、运行、未完成、未知有文本/形状，不只颜色 | 核心 |
| F17 | Web Activity | 工具时间线对应类型 | `web-activity.js`；`web-access.js`；`web-capabilities.js` | 仍来自既有 Pi Extension；不为原型新增联网/安装 | 仅映射 |
| F18 | 外部 Browser Use Activity | 工具时间线对应类型 | `browser-activity.js`；`browser.js`；`browser-capabilities.js` | 与内置 Browser Agent Control 分开；无审批协议时不画允许/拒绝 | 仅映射 |
| F19 | Subagent Activity | 工具时间线子任务展开 | `subagent-activity.js`；`subagents.js` | 与 Planner 的 DAG / Attempt 分开；不虚构子代理来源 | 仅映射 |
| F20 | Pi Memory Activity | 工具时间线对应类型 | `memory-activity.js`；`memory.js` | 长期记忆与会话搜索分开，不增加 Memory browser | 仅映射 |
| F21 | MCP Activity 与资源活动 | 工具时间线对应类型 | `mcp-activity.js`；`mcp-observer.js` | 保留 server 与来源证据；不建立第二套 MCP runtime | 仅映射 |
| F22 | Approval / Permission | 原请求所属会话中的确认内容 | `approval.js:313,571`；`approval-model.js`；`ui/modal.js:246` | 只有真实 Extension 协议请求可应答；不伪造全局权限开关 | 仅映射 |
| F23 | 多行输入、键盘、IME | 稳定底部 Composer | `index.html:166-200`；`composer.js`；`app.js:955-979` | Enter发送、Shift+Enter换行、合成输入不发送；textarea有界增长 | 核心 |
| F24 | 附件、图片/PDF/Word/文本解析 | Composer 附件按钮与托盘 | `attachments.js:43,103,109,202` | Classic既有 loading/error/blocked/unreadable/truncated；Runtime未接相同附件链路，不给假功能 | 核心（Classic演示） |
| F25 | 模型选择 | Composer Model Picker | `app.js:709`；`ui3-model-picker.js:259`；`runtime-models.js` | providerId+modelId；切换等待 Pi 回读；未知能力不当“不支持” | 核心 |
| F26 | 思考等级选择 | Composer Thinking Picker | `app.js:723`；`ui3-model-picker.js:388`；`thinking-availability.js` | 候选仅来自 Pi；pending/unknown/unsupported/no-model有区别；切模型清旧候选 | 核心 |
| F27 | 上下文、用量、远端额度、会话统计 | Composer已用百分比→详情；More「上下文与统计」；Slash用量命令 | `index.html:59,179`；`usage.js`；`app.js:832,921` | 会话统计与Provider额度不同owner；数字未知保留未知；避免侧栏重复常驻同摘要 | 核心演示：容量/用量/额度未知、加载/错误/重试；合成数值不代表真实账户，见15报告 |
| F28 | Agent运行、追加指令、停止与停止待确认 | Composer主要动作+消息内状态 | `docs/composer-ui.md`；`app.js:955-979`；`state.js:199-210` | Classic运行中支持steer；Runtime运行中send禁用；停止未确认不解除保护，草稿保留 | 核心 |
| F29 | 提问导航 / Minimap | 阅读列边缘提问目录 | `index.html:163`；`conversation-nav.js:341-378` | 只索引User turn；只滚动stream；不创建正文副本 | 核心 |
| F30 | Classic草稿恢复 | 对应会话Composer | `draft.js:37-42,67,86-132,157-245` | workspace/session键、20,000字、400ms debounce、本地存储降级 | 核心（演示态独立保存） |
| F31 | Runtime实时视图、历史与恢复 | 同形会话壳+明确实时/只读标签 | `runtime-conversation.js:181,462,560,584-707` | 独立owner；历史可有只读工具摘要但无Thinking/usage；位置未确认单列；不补完整执行记录 | 仅映射 |
| F32 | Runtime草稿、滚动、模型、生命周期 | 同形Composer与会话More；保留能力差异 | `runtime-draft.js:38,80,104,185`；`runtime-conversation.js:182-191,243-253,504,697-763` | 稳定locator与易变owner分开；运行时不可发送；当前无Classic附件链路 | 仅映射 |
| F33 | Git工作区文件变更 | 顶栏「变更」→右栏 | `index.html:103`；`git.js:429,450,544` | Git为事实源；badge始终总数；全部/本会话过滤含义不改；非Git不是错误 | 核心 |
| F34 | 文件列表、Diff、hunk折叠与上下文 | 变更右栏文件列表/详情 | `diff.js:180,270,275,297`；`git.js:1371` | 长行仅Diff内部滚动；改变上下文仍问后端，前端不补裁掉行 | 核心 |
| F35 | 单文件/全部撤销及未跟踪/暂存权限 | 变更面板二级操作→计划确认 | `git.js:488`；既有Git API与确认模块 | 维持计划、授权、冲突与写闸门；不能改成无确认的一键应用或撤销 | 仅映射 |
| F36 | Diff单行/多行评论与持久化 | Diff gutter与评论区域 | `diff-comments.js:150,199,254,384`；`review-comment-persistence.js` | 保留scope、anchor、fingerprint、stale、版本兼容与草稿；不改评论存储 | 仅映射 |
| F37 | 准备修改任务、候选执行、审查、采纳 | 评论工具条有条件入口 | `review-task.js:47`；`review-task-preview.js:22`；`candidate-review.js:9` | 固定输入快照、受控worktree、真实diff、采纳确认与恢复许可独立 | 仅映射 |
| F38 | 本会话变更及撤销对象 | 会话More「本会话变更」 | `app.js:916`；`session-changes-panel.js:47`；`session-revert-object-ui.js` | 当前资格、目标身份、清单与确认不丢；不扩大支持平台/对象 | 仅映射 |
| F39 | Specs只读浏览 | 顶栏工作工具「Specs」→右栏 | `index.html:104`；`specs-panel.js:33,50` | 根SPEC.md/specs Markdown，保留安全路径、锚点与只读边界 | 仅映射 |
| F40 | 内置Browser及历史/地址/刷新 | 顶栏「浏览器」→右栏 | `index.html:112`；`browser-pane.js:24,108,337` | 仅Electron bridge可用；原型页面是本地演示，不能算实际导航或网页执行 | 核心（模拟面板） |
| F41 | 内置Browser Agent Control | Browser面板内独立控制 | `gui-browser-activity.js`；`gui-browser-capabilities.js`；Electron Browser owner | 默认关闭、loopback-only、独立授权，不控制用户Chrome；与外部Browser Use分开 | 仅映射 |
| F42 | 开发进程与脱敏日志 | 顶栏「工作工具 → 开发进程」→右栏 | `app.js:917,1266`；`process-panel.js:23`；`runtime-secondary.js:78` | 独立授权、按工作区清理，日志脱敏；不扩大Browser权限 | 仅映射 |
| F43 | Specs+Changes / Browser+Changes分屏 | 右栏标题布局操作 | `ui/split-workbench.js`；`app.js:298`；`browser-pane.js:277` | 复用原mount/controller；低高度单面板tab回退；不是任意三面板IDE | 仅映射 |
| F44 | 协同流程图与建议/撤销/导出 | 顶栏工作工具「协同文档」→右栏 | `index.html:107`；`collab-panel.js:22,31`；`collab-canvas.js` | 自动保存、来源revision、undo/redo、导出保留；不造真实Agent建议来源 | 仅映射 |
| F45 | 消息交互图表与参数引用 | 消息图表卡「打开」→右栏；More可放仅当有当前图表的别名 | `viz-integration.js:19-47`；`viz-panel.js:228,256` | 当前实际入口是[data-viz-open]；不是现有全局命令。保留来源消息/scope校验，不加空图表入口 | 仅映射 |
| F46 | Planner创建/编辑/DAG/执行 | 一级「任务」 | `index.html:32`；`planner.js:424,579,718,1881,2092` | 保留计划草稿、未保存确认、依赖与执行闸门；原型不能触发真实CLI | 仅映射 |
| F47 | Planner Attempt/会话关联/人工Review/Verification/Evidence | 任务详情分区与关联会话链接 | `planner.js:974,1127,1289,1340,1459,1551,1774,1808`；`session-plans.js` | 接受、需修改、验证通过、证据与允许合并不是同一状态，不把它们合为绿色成功 | 仅映射 |
| F48 | Skills发现、详情、启用/停用 | 一级「Skills与扩展」默认Skills | `extensions.js:155-216,272,1012` | installed/configured/loaded/observed区分；必要重启确认；不把目录发现等于已加载 | 仅映射 |
| F49 | Extensions Registry、Capabilities与固定安装 | 扩展一级页五过滤器：All/Capabilities/Extensions/Skills/MCP | `extensions.js:880,944,1012`；`capability-view.js`；`ui/capability-setup.js` | 未知扩展仍显示；四个固定allowlist安装，不是Marketplace，不加评分/任意包搜索 | 仅映射 |
| F50 | Native MCP管理 | 扩展页MCP；设置→扩展与MCP可直达 | `extensions.js:441-835`；`mcp-capabilities.js` | 官方CLI add/remove/login/logout；enable/reconnect/exposure无接口时提示Pi管理器，不画假开关 | 仅映射 |
| F51 | 自定义模型供应商/模型列表 | 设置→模型与账户→供应商 | `index.html:65`；`providers.js:197,275` | 复用现有配置与模型读取，不新建账户后端 | 仅映射 |
| F52 | OAuth/API Key/环境变量认证 | 设置→模型与账户→认证 | `index.html:66`；`providers.js:248`；`provider-auth.js:27` | Pi公开SDK负责OAuth、凭据与刷新；GUI不回显原始密钥；未知能力如实说明 | 仅映射 |
| F53 | 自动备用模型 | 项目设置→模型备用 | `project-config.js`；`fallback.js`；`model-fallback.js` | 默认关闭；未输出且可靠生成故障才重放；模型以Pi回读为准，不静默覆盖用户选择 | 仅映射 |
| F54 | Pi GUI与Pi检查/更新 | 设置→应用与更新，分开两段 | `settings.js:31`；`app-update.js:14`；`pi-update.js:437,472` | 版本、缓存、下载/安装/重启与Pi runtime维护各自独立；不弱化确认与忙闸门 | 仅映射 |
| F55 | 运行诊断、兼容探测、复制摘要 | 设置→诊断 | `diagnostics.js:377,541,554`；`schema-drift.js` | 保留结构化脱敏，缺证据为未知，不存原payload | 仅映射 |
| F56 | 日志浏览、筛选、故障报告导出 | 设置→日志与故障报告 | `logs.js:100,445,533` | 保留范围/预览/隐私选项，不上传真实数据；导出也是写操作 | 仅映射 |
| F57 | 主题、系统偏好、浅色/深色 | 设置→外观 | `settings.js:7`；`theme.js:19-30`；`tokens.css` | 系统/浅/深；Electron titlebar与主题同步需后续桌面验收 | 核心（浅/深） |
| F58 | 命令面板、行内Slash、键盘帮助、导航快捷键 | 行内 / 菜单；Ctrl+K/Ctrl+Shift+P及设置→键盘与命令 | `app.js:961,1251-1295,1319`；`ui/inline-command-menu.js`；`palette.js`；`shortcuts.js` | 复用注册表与handler；候选键盘先于发送；保留IME和焦点边界 | Slash核心演示，12种既有命令ID；全局命令面板仍仅映射，不宣称覆盖全部注册表，见15报告 |
| F59 | 会话导出HTML、压缩上下文、统计、重命名 | 会话More高级操作 | `app.js:915-924` | 实际导出/压缩不在原型执行；已有能力不删除，只调整层级 | 仅映射 |
| F60 | Toast、持续状态条、加载/失败/重试 | 原操作就地反馈；跨页需要处理的问题用全局状态 | `ui/toast.js:7-9,84-105`；`index.html:121-124`；`ui/notice.js` | replay不重发、30s去重；普通成功静默；跨会话旧通知动作失效 | 核心 |

## Classic / Runtime 统一视觉时必须保留的差异

| 领域 | Classic当前行为 | Runtime当前行为 | 设计约束 |
| --- | --- | --- | --- |
| 输入与运行中发送 | handleFiles附件、多行、运行中steer；停止待确认禁用 | 运行中send禁用，未接Classic附件链路 | 可以同形，不能给未实现能力画可用按钮；禁用状态解释原因 |
| 模型/推理 | Provider分组Popover，Pi回读 | 原生select，独立runtime-models owner | 复用展示组件时注入各自action，不能直接接同一全局S |
| 草稿身份 | workspaceHash/sessionHash | project/workspace/epoch/conversation/nativeSession稳定locator | 不能用可变owner/generation代替永久键，也不能串会话 |
| 正文与工具 | Markdown、ToolEntry实时/历史共用 | 当前实时输出pre；历史正文+受限工具摘要 | 高保真目标可规范统一呈现，但正文/工具位置证据不足时明确降级 |
| 历史Thinking/用量 | 依真实get_messages与已有投影 | Runtime历史无Thinking/usage；工具摘要有预算和位置未知 | 不补造思考耗时、用量、tool参数/输出或完整执行顺序 |
| 生命周期与右栏 | Classic bridge与原Browser controller | 每会话owner、runtime secondary | 必须保留owner/generation、失效结果拒绝、detach/dispose等边界 |

## 设计映射审查规则

1. F01–F60记录的是能力保留与入口设计，不宣称原型已执行60项业务。核心场景最终通过项应能对应截图与交互结果；仅映射项实施前另行验收。
2. 原型不能增加任意Extension市场、云任务、假权限开关、假认证、假模型联网、空图表页或未接线的Browser功能。
3. More中的「可视化」只能在当前消息存在合法图表时作为别名；消息卡仍是实际来源。无图表时隐藏，不做一个看起来可用的空按钮。
4. 右栏重做只改变布局与视觉，不接管Browser viewport几何、Git事实、Specs读取、进程权限或协同文档存储。
5. 高风险动作仍使用原确认、身份、快照、nonce、路径、写入、恢复和维护闸门；设计批准不等于后续代码合并或发布授权。

## 当前UI证据与范围

[实际窗口采集记录](../evidence/current/capture-results.json)注明入口为生产 `electron/main.cjs + public renderer`，后端为既有 `tests/visual-harness.cjs` 与离线TEMP fixtures。这是当前生产渲染器的fixture界面证据，不是真实用户数据、模型运行或全部业务资格证明。

已直接查看聊天、Changes与Skills截图，确认这些页面当前实际形态与本表入口一致：

- [当前聊天](../evidence/current/dark-1440-chat.png)
- [当前文件变更右栏](../evidence/current/dark-1440-navChanges.png)
- [当前Skills与扩展](../evidence/current/dark-1440-navExtensions.png)

采集记录显示1440×900、DPR 1.5时sidebar为236 CSS px，Changes/Browser/Specs右栏为420 CSS px；推荐A侧栏248px是设计选择，不是假称当前值。DPR截图不能单独替代原生Windows多档系统缩放资格。
