# Agent 能力：技能 / 扩展 / MCP 的入口与边界

拆分前，Skills、Extensions、MCP 挤在「设置 › 扩展与 MCP › Skills 与扩展」这一个
Work Surface 里（三个标签，`public/extensions.js` 一个文件 1152 行）。现在是三个独立入口，
各自拥有页面、状态与生命周期；服务端接口、Extension Registry、Skills 扫描与启停、
Pi 原生 MCP 协议都**没有改**，变的只是前端承载。

## 入口与事实来源

| 入口 | 位置 | 前端模块 | 唯一事实来源 |
|---|---|---|---|
| 技能 | 设置 › **Agent 能力** › 技能（`#navSkills`，菜单徽标 `#skillCount`） | `public/skills/`：`model.js` 纯投影、`detail.js` 行内详情、`page.js` 页面、`skills.css` | `/api/skills`、`/api/skills/<id>`（`server/skills.js`） |
| 扩展 | 应用主导航 **扩展**（`#navExtensions`，Work Surface `extensions`，标题「扩展」） | `public/extensions/`：`model.js`、`installed.js`「已安装」、`market.js`「插件市场」、`page.js` 页签壳、`extensions.css` | `/api/extensions`（`server/extension-registry.js`，只读）、`/api/approvals/capability` |
| MCP | 设置 › 扩展与 MCP › **MCP 配置**（`#navMcp`） | `public/mcp-settings.js` 管理页 + 页尾折叠区 `public/mcp-report.js`「MCP 能力报告」 | 管理：`/api/mcp/config`、`/api/mcp/servers`；报告：`/api/mcp` |

- **技能页**：按作用域分组（项目级 / 全局级 / 临时 / 其他），作用域分段筛选带计数（没有临时技能时隐藏「临时」），
  状态筛选与搜索（名称 / 描述 / 路径 / 来源目录）。行内展开看事实行与只读 `SKILL.md`；
  开关 → 确认（写哪个 settings.json、加 / 删哪条规则）→ 写入 → 询问是否重启 pi → 重读。
  筛选只是对同一份数据的投影；展开项的详情在重绘时原样复用，不重复请求。
- **扩展页**：「已安装」默认，内容是只读 Registry 清单 / 详情 + 顶部默认折叠的「已知能力设置」
  （Web Access / Subagents / Pi Memory / Browser Use 的受控安装与运行观察、Approval 协议探测）。
  「插件市场」第一阶段只是占位：不 import `api.js`、不发请求、没有任何按钮。
  旧入口参数 `{ tab: 'extensions' }` 与已移除的 `skills` / `mcp` 都落到「已安装」。
- **MCP 能力报告**：旧 MCP 标签里管理页没有的证据（是否带原生 MCP、版本与出处、built-in 清单、
  RPC / ExtensionAPI 事实、扩展目录与 settings 声明、本次运行的调用观察）。第一次展开才读 `/api/mcp`；
  原生状态取自管理页已经读到的 `/api/mcp/servers`（`setNative`），不再发第二次请求；
  那一次没读到时写「读不到原生 MCP 摘要」，不沿用上一次的结论。
  旧标签里的 server 列表 / 刷新 / 移除 / 添加与管理页重复，已由管理页承接，没有搬第二份。

## 不变的约束

- installed / enabled / loaded / restartRequired / runtimeObserved 仍是独立事实；
  `null` 显示「未知 / 无法确认」，绝不折算成「否」。闭集外的状态显示「状态未知」并记一条
  schema 漂移（只记来源 / 字段 / 类型，不记值）。
- 每个异步结果都过三重校验：Work Surface 实例身份（`instance.isCurrent`）或设置详情卡的
  `onClose`、工作区代号（`S.workspaceGeneration` / `ownsWorkspace`）、页面自己的请求序号。
  换项目后**不自动重读**（后端可能还在切换），列表换成「项目已切换，刷新后查看…」，由用户刷新；
  确认框在换项目或关页之后才被点下，不发写请求。
- 三个入口**互不 import UI**。共享层只有既有的 `api.js` / `state.js` / `ui/*`，
  以及 `ui/resource-dom.js`（只造节点：无状态、无业务文案、不 import 页面）。
- 页面状态只活在页面实例里：没有模块级可变状态，不写 `S`，每次读取整体替换。
- document 级监听：技能页 1 个、扩展页 3 个通知事件 + 「已安装」1 个、能力报告 1 个；关闭后净增为 0。

## 并行开发的文件归属

| 归属 | 独占文件（可自由修改） |
|---|---|
| **Agent A：技能（2A）** | `public/skills/**`、`server/skills.js` 及新增的技能服务端模块、`tests/skills.cjs` 的 Skills 段（同一文件里 `server/mcp.js` 能力报告那段属于 MCP，不改）、`tests/skills-live.cjs`、新增的技能测试 |
| **Agent B：扩展 / 插件市场（2B）** | `public/extensions/**`、`server/capability-install.js`、新增的扩展市场服务端模块、`tests/extensions.cjs`、`tests/capability-install.cjs`、`tests/capability.cjs`、新增的扩展测试 |
| 都不改（除非单独协调） | `server/extension-registry.js`（只读 Registry，B 也只消费它）、MCP 全部文件（`public/mcp-*.js`、`public/mcp.css`、`server/mcp*.js`）、已知能力的 feature 模块（`public/web-access.js` / `subagents.js` / `memory.js` / `browser.js` / `approval.js` 及各自的 `*-capabilities.js`，「已安装」只调用它们的 `render*Setup`）、`public/extension-notices.js`（全局通知路由） |

`server/skills.js` 虽归 A，但它的 `readIndex().trust` 是全仓库唯一的项目信任来源：`server.js`
把它注入 `extension-registry`、`mcp-config`、`mcp-import`、`mcp-native`。A 改动信任判定或
`readIndex()` 的返回形状，等于同时改了扩展与 MCP 的判定，须先协调。

**共享文件：不得并行修改**，同一时间只允许一个分支改动，另一方 rebase 后再动：

| 文件 | 为什么会冲突 |
|---|---|
| `public/index.html` | 主导航、设置分组、样式表链接 |
| `public/app.js` | 入口 import、导航绑定、快捷键、命令列表、徽标 |
| `public/api.js`、`server/router.js`、`server.js` | 两边都要加接口、路由与服务端装配（信任源注入也在 `server.js`） |
| `public/state.js`、`public/ui/workspace-surface.js`、`public/ui/settings-surface.js` | 工作区代号、Work Surface 标题 / 导航投影、设置菜单开合 |
| `public/ui/resource-dom.js`、`public/ui/capability-setup.js`、`public/capability-model.js` | 两个页面共用（`skills/detail.js` 用 `capability-setup.js` 的 `copyButton`） |
| `public/ui/primitives.*`、`public/ui/icons.js`、`public/tokens.css` | 设计系统公共实现（规范见 [design-system.md](ui/design-system.md)） |
| `package.json` | `test` 链与脚本 |
| `tests/smoke.cjs`、`tests/ui-ia.cjs`、`tests/agent-capability-pages.cjs`、`tests/visual-harness.cjs`、`tests/shortcut-electron.cjs` | 两边的断言与 fixture 在同一文件 |
| 本文件、`docs/testing.md`、`docs/README.md` | 文档索引与测试清单 |

## 2A 边界：技能管理

范围：全局 / 项目 / 内置技能的管理、增删改、导入、扫描、市场与诊断。

- 只在 A 的独占文件里实现；需要新接口时在 `api.js` / `router.js`（及 `server.js` 装配）各加一处（按上表串行）。
- 扫描与启停规则继续以 `server/skills.js` 为准（每条规则都注明了 pi 源码出处），不另写一套；
  启停仍然只写 pi 的 settings.json（`-<rel>` 规则），pi 只在启动时读它。
- 「内置技能」先从 pi 上游源码确认是否存在、从哪里来；确认前按「未知」处理，不硬编码。
- 增删改与导入会写用户的真实目录：前端只传稳定 ID 不传路径；写入限定在 pi 的发现根之内，
  原子写、保留未知字段；项目未信任时拒绝项目级写入；导入要防路径逃逸与超大文件。
  测试一律在 `os.tmpdir()` 里造世界。
- 市场意味着新的网络行为：先征得用户同意，离线时明确降级。

## 2B 边界：扩展市场

范围：插件市场浏览、安装、卸载、更新、启用。

- 替换 `public/extensions/market.js` 的占位；目录与安装逻辑放在**新的**服务端模块，
  不写进 `server/extension-registry.js`。
- 安装沿用 `server/capability-install.js` 已验证的路径：renderer 只送目录 ID，source 由服务端解析，
  固定 argv 调官方 `pi install`、执行前确认、暂停 / 重启 Pi，装没装由重新发现的 Registry 回答
  （退出码 0 ≠ 已安装 ≠ 已加载）。卸载 / 更新 / 启用先从 pi 上游源码确认官方命令与 settings 语义，
  没有官方接口的动作不做假开关。
- 网络请求可复用 `server/market-network.js`（MCP 市场已有的代理桥：只 GET、固定请求头、拒绝重定向）；
  新增联网需用户同意。
- 不引入第二套插件运行时：GUI / Electron 进程里永远不执行扩展代码。

## `.piplug` 不是 Pi 原生 Extension

依据 PI-Desktop 源码（@92ae661）：`.piplug` 是 PI-Desktop 的产品级分发包，zip 加根目录
`manifest.json`（ADR 0007）。它的插件跑在 PI-Desktop 自己的进程与权限网关下（ADR 0008）；
`contributes.agentExtensions` 模块跑在 PI-Desktop 的 Agent sidecar 里，面对的是只实现了
`ExtensionAPI` 子集的桌面适配层（`docs/spec/07-plugins/16-trusted-extensions.md` §1）；
PI-Desktop 也从不自动导入 `~/.pi`（D007）。

Pi 原生 Extension 由 pi 自己加载：`~/.pi/agent/extensions`、`<项目>/.pi/extensions`，以及 settings 的
`extensions` / `packages`（`pi install` 安装），在 pi 进程内拿到完整的 `ExtensionAPI`。
所以 `.piplug` 依赖 pi-GUI 没有、也不该重造的宿主（manifest、权限网关、宿主 RPC、sidecar 适配层），
不能直接当成 Pi Extension 安装。2B 只接入 pi 能直接加载的来源；如果目录里出现 `.piplug`，
标成「不兼容」或过滤掉，不解包、不执行。

## 测试

- `tests/agent-capability-pages.cjs`（在 `npm test` 里）：静态边界（无互相 import、只经 `api.js`
  读各自的接口、无模块级状态、市场无安装路径、导出名唯一）、纯投影的三值语义、
  三个页面的生命周期（迟到结果丢弃、换项目提示、监听器净增为 0、页签复用不重复请求）。
- `tests/smoke.cjs` 的「Agent 能力：扩展页 / 技能页 / MCP 配置页」段与 `tests/ui-ia.cjs`：
  导航、选中态、标题、设置搜索、返回会话；`tests/mcp-management-ui.cjs`：摘要读取失败时的页尾报告。
- 真实渲染：`npm run test:shortcuts:electron`（不在 `npm test` 里）在 1320×820 / 700×600、
  深 / 浅色下截图并检查 700px 无横向溢出。
