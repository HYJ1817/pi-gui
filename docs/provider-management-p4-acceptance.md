# 供应商管理 P4 验收报告

生产基线为 `61aba829b7eb2f280522d3cb17a89f9f6e4fdcae`（`main`，P0＋P1 已合并）。P4 实现在独立分支 `codex/provider-management-p4`，before HEAD 为该基线，after HEAD 是包含本报告的交付提交，可用 `git log -1 --format=%H -- docs/provider-management-p4-acceptance.md` 查询。任务所述固定参考为 [PI-Desktop v0.21.0](https://github.com/vastsa/PI-Desktop/tree/92ae661f1e399e69d514086b46029b4c34ba1a92)。

## 交付范围

| 区域 | 行为 | 主要文件 |
| --- | --- | --- |
| 服务选择器 | 居中 1040×720 弹窗、搜索、订阅组在前、API Key 组在后、自定义端点固定在组首、四列卡片、订阅不可用状态与真实原因、键盘选择与中文输入法保护。 | [service-chooser.js](../public/provider-management/service-chooser.js)、[catalog.js](../public/provider-management/catalog.js) |
| 服务配置 | 服务身份与更换入口、凭据状态、P0 安全触发器、环境变量引用、OAuth 状态、高级设置、双模型栏、保存与冲突处理；复制只显示中性的“不携带凭据”状态。 | [dialog.js](../public/provider-management/dialog.js)、[connection-fields.js](../public/provider-management/connection-fields.js) |
| 模型管理 | 候选/已选双栏、各自搜索、勾选与可见范围全选、增删、拖拽与键盘排序、自定义模型 ID、上下文/输出上限、推理与输入类型、来源与三值能力、空状态与校验。 | [model-panes.js](../public/provider-management/model-panes.js)、[model-visibility.js](../public/provider-management/model-visibility.js)、[state.js](../public/provider-management/state.js) |
| 发现/测试边界 | `capabilities` 未开放时不发 `/discover`、不伪造加载成功；状态条注明 P3 待接通，刷新和连接测试禁用。 | [discovery.js](../public/provider-management/discovery.js) |
| 供应商列表 | 管理快照列表、添加/编辑/复制/删除确认/停用与启用、只读与兼容性标记、旧版密钥状态告警、保存后待 Runtime 同步提示。 | [providers.js](../public/providers.js) |
| 视觉与主题 | 复用现有 Settings、Modal、Design Tokens 与通知；暗/亮主题、940/720/480 响应式、焦点可见、减少动态效果。 | [provider-management.css](../public/provider-management.css)、[index.html](../public/index.html) |

主页面没有 `<input type="password">`，没有原文密钥，也没有私有 IPC。凭据触发器在生产能力为 false 时保持 disabled；环境变量引用只接受 `$NAME` / `${NAME}`。所有文本经 `textContent` 写入。

## 与两张参考图的对照

参考图为任务提供的 REF-013（服务选择器）与 REF-014（服务配置）。截图未归档进仓库，下面是按参考提交源码、参考图和真实 Electron 截图逐项对照的结果。

| 对照点 | REF-013 服务选择器 | P4 实现 | 差异与原因 |
| --- | --- | --- | --- |
| 弹窗 | 1040×720 居中、遮罩、16px 内边距 | 同尺寸与层级，仅正文滚动 | 一致 |
| 搜索与分组 | 搜索框；订阅组在前、API Key 组在后 | 同顺序；自定义端点固定在 API 组首位 | 一致 |
| 卡片网格 | 四列、圆形字母标识、名称与端点 | 四列；名称、端点/环境变量提示、选中与不可用状态 | P0 目录只有 13 个条目；不凭空补参考图中的其它供应商 |
| 订阅能力 | 可登录的订阅直接发起现有 Pi 登录 | 仅当 `oauthLogin` 与对应 auth provider 同时可用才可点；否则显示“待接通” | 不创建假登录；未接通状态是真实能力 |
| 键盘 | 搜索框上下键进入卡片，方向键移动，Enter 选择 | 同交互，并保护中文输入法合成事件 | 额外提供“方向键选择”提示 |
| 服务配置顶带 | 左服务卡（名称、端点、更换），右 API 密钥 | 同样左右双栏；右侧为 P0 凭据状态/触发器与环境变量引用 | 参考图的密钥输入框属于 P2；P4 只保留冻结的安全触发器 |
| 模型双栏 | 候选模型/模型设置，独立搜索、全选、已选顺序、底部自定义模型 | 同结构；已选栏支持拖拽、键盘排序、参数展开与移除 | P3 的远端获取/自动推荐未接通，显示禁用原因而不是 fixture 成功态 |
| 高级设置 | 头部“高级设置”入口 | 独立视图包含名称、启用、Endpoint、API 类型、供应商标识、目录条目、本机注册引用与兼容性 | 端点/API 从主配置页移入高级，主配置页留给模型选择 |
| 复制服务 | 参考图未覆盖 | 保留当前模型与顺序，清空凭据状态，显示“复制不携带凭据”，不提供密钥输入、清除或更换入口 | 合同要求复制使用 `authMode:'none'` + keep，界面不暗示凭据会被继承 |
| 主题与窄窗 | 深色参考图；固定双栏 | 暗/亮截图；940px 以下双栏堆叠、720px 以下顶带单列 | 窄窗允许正文滚动，顶部操作保持可见 |

真实 Electron 截图：

- [服务选择器深色](../.shots/p4/01-chooser-dark.png) · [浅色](../.shots/p4/05-chooser-light.png)
- [服务配置深色](../.shots/p4/02-setup-dark.png) · [浅色](../.shots/p4/03-setup-light.png)
- [高级设置浅色](../.shots/p4/04-advanced-light.png)
- [700×760 窄窗](../.shots/p4/06-setup-narrow-light.png) · [自定义端点](../.shots/p4/09-custom-light.png) · [复制服务](../.shots/p4/10-clone-light.png)
- [供应商列表深色](../.shots/p4/07-list-dark.png) · [浅色](../.shots/p4/08-list-light.png)

这些文件在 `.shots/`（Git 忽略）中，作为本轮验收证据，不进入提交；最终一版在代码冻结后重新采集，报告见 `.shots/p4/report.json`。

## 实际验证

Windows x64，Node v24.22.1，Electron 44.4.3。

| 证据层 | 命令或场景 | 结果 |
| --- | --- | --- |
| 定向功能 | `npm run test:provider-management` | 51/51，退出 0，跳过 0。P4 UI 文件从 22 条增加到 30 条，原有 21 条后端合同测试保留。 |
| 冒烟回归 | `node tests/smoke.cjs` | 1345/1345 通过，退出 0。供应商页与添加流程已改写，断言数未减少。 |
| 设置与集成 | `node tests/ux-state.cjs` / `node tests/ui-ia.cjs` / `node tests/settings-acceptance.cjs` | 15/15、27/27、16/16，退出 0。旧内联表单断言改为最终弹窗选择器，延迟保存不重开旧页的原断言保留。 |
| UI4 回归 | `npm run test:ui4` | 56/56，退出 0，failed=0，skipped=0。 |
| CI 计划与结果链 | `npm run test:ci` | 通过，退出 0；包含 236 个叶子、结果记录与 NSIS 校验。 |
| 本地完整 canonical | `npm test` | 退出 0；全链通过。日志 `.shots/npm-test-final4.log`。首次全量在 `tests/collab-http.cjs` 因 `fetch` 拒绝随机端口 `bad port` 中断；单跑该套件 8/8 通过，第二次全量通过。`Object witness` 按环境跳过 8 项（SACL 不可用），不计入分子分母。 |
| 真实 Electron | 源码页面 + P0 快照 fixture，1205×803；另测 700×760 | 选择器 13 卡、列表 3 行、已选 2 模型、0 个密码输入、凭据触发器 disabled、发现状态 `unsupported`、复制态凭据控件 0、页面异常 0；自定义端点正文 651/651、模型栏 299px、无横向溢出。 |
| 打包产物 | `npm run build:app -- --rebuild` / `npm run build:exe` | `dist-app/Pi GUI-win32-x64` 345,582,874 bytes；`build/Pi GUI.exe` 103,421,952 bytes（98.6 MiB）。 |
| P2/P3 真实能力 | 未验证（未运行） | 未使用真实密钥、OAuth、供应商网络请求或真实 Pi 模型。 |
| Electron 场景文件 | `node --check tests/fixtures/final-remediation-scenarios.cjs` | 语法通过；完整 Electron 场景未运行。该环境 Electron 主进程写结果/截图时返回 `EPERM`，不以语法检查冒充真机通过。 |
| 独立审查 | 独立上下文复审当前工作区 diff | 首轮：1 Blocker / 7 Important / 2 Nit；第二轮发现 2 个残留 Important；第三轮聚焦复核两项均 resolved，未发现直接回归。 |

## 独立审查处置

首轮独立审查发现 1 个 Blocker、7 个 Important 和 2 个 Nit；以下修复均有对应测试或静态核对：

| 问题 | 处置 |
| --- | --- |
| 管理接口默认关闭时整页旧供应商列表被吞掉 | 只有旧路由也失败时才显示错误；管理接口 `unsupported` 不再抑制旧列表。新增 jsdom 回归。 |
| 冲突恢复把不透明字符串 revision 当成安全整数 | `readLatestSnapshot` 接受非空字符串；冲突时恢复“重读并继续 / 重新载入 / 复制”动作。 |
| 移除后再加回同一模型仍发送 `remove` 补丁 | 暂存被移除记录，重新加入时恢复并撤销 remove；新增纯状态回归。 |
| 复制对话框展示源凭据，并允许提交必然失败的凭据动作 | 复制草稿清空 `credentialState`，界面只显示“复制不携带凭据”，隐藏密钥输入、清除与更换入口。 |
| 重试不复用 requestId | 同内容重试复用草稿与提交 ID；草稿成功且内容未变时不再重发草稿。新增网络失败重试回归。 |
| create 的凭据冲突提供没有来源的“复制”动作 | 仅当存在 `sourceServiceId` 时提供复制；自定义 create 可修改供应商标识，其它情况提示返回选择服务。 |
| 行内“更多操作”按 Enter 被行级键盘处理抢开编辑 | 行级 keydown 只处理目标为行本身的事件；新增键盘回归。 |
| `selectedModelIds:null` 被 `modelOrder` 缩窄 | `selectedModelIds` 决定选中集合，`modelOrder` 只排序；新增继承选择回归。 |
| 高级模型字段缺少可访问名称 | 显示名、上下文窗口、最大输出、推理能力补 `aria-label`，并在测试中断言。 |
| Electron final-remediation fixture 从 commit 读不存在的 `draft` | 改为保存 `/drafts` 的草稿负载供 commit 使用，并同步 revision；该环境仍只能做语法核对。 |
| 第二轮：重读并继续后复用旧 draft requestId | requestId 按请求内容/版本键控；丢弃草稿句柄时清空 ID。新增点击“重读并继续”后 revision 变化的回归，断言第二轮 draft/commit ID 均轮换。 |
| 第二轮：复制高级设置仍可写本机注册引用 | clone 强制 `authMode:'none'`、commit keep、payload 不写 `piRegistrationReference`，高级输入 disabled 并显示原因；状态与 UI 均有断言。 |

第三轮独立复核确认上述两项均 resolved，并核对了所有丢弃草稿句柄的路径与 clone payload 构造，未发现直接回归。

## 后续阶段

- **P2**：接通桌面凭据输入窗、私有桥与确认后的凭据保存；P4 已保留 `[data-credential-trigger]` 与 disabled 原因，主页面没有替代输入框。
- **P3**：接通发现授权、缓存/刷新、连接测试、自动推荐与 Runtime 同步；P4 已渲染 `unsupported` 状态并禁用按钮，测试确认不会发起未授权请求。
- **P5**：只做能力接入和缺陷修复；主布局、双栏模型区、选择器与服务列表已在本轮定型，不需要再次重构。

## 限制与回滚

- 真实 Electron 截图使用 `--no-sandbox` 与 P0 fixture；证明的是真实渲染与交互，不是真实供应商连接、真实凭据或打包安装升级。
- 未验证 P2/P3 接通后的失败、缓存和同步画面；`discovery.js` 保留了状态机，但本轮生产分支不会调用远端。
- 管理接口仍受 `PI_GUI_PROVIDER_MANAGEMENT` 门控。关闭时供应商页显示旧列表作为只读回退；新增/编辑使用管理合同，需在 P5 联调时开启能力。旧内联新增表单未保留，避免同时维护两套最终 UI。
- 回滚：回退本分支的 P4 实现、测试与报告提交。P4 没有新增后端写入路径，不修改 P2 Electron 凭据代码、P1 仓储、配置事务或 Runtime owner；不会改动用户真实配置。
- 合并与发布均需另行明确授权。本报告只记录开发、验证与分支推送状态；按用户要求本轮不创建 PR。
