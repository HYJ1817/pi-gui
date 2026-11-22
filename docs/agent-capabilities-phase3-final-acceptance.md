# Skills、Extensions、MCP 第三阶段验收

**当前结论：有条件通过，尚未达到正式收尾条件。** 技能与扩展是真实产品页面改版；MCP 是只读版式参照。定向验证与全量证明分开记录。未合并、未发布。

- 分支：`feat/agent-capabilities-phase3-final`，独立工作树。基线：`5ed42f3e43881dc7b353452dac3abb506a2c0c52`（已含 [#103](https://github.com/HYJ1817/pi-gui/pull/103)、[#104](https://github.com/HYJ1817/pi-gui/pull/104)、[#105](https://github.com/HYJ1817/pi-gui/pull/105)）。[main push CI 45004352564](https://github.com/HYJ1817/pi-gui/actions/runs/45004352564)，attempt 1 成功，仅证明基线。
- 本次续作从 `15d3eff2` 起。`8afeb76a` 已撤销 `bb5b4b38` 的 MCP 外观改动，`15d3eff2` 将对应测试恢复到原界面。相较外观改动之前的 `05b5cdd1`，`public/mcp*` 仅多了 `f08bff84` 的一行状态失效与注释；`public/mcp.css` 与 `public/mcp-market.js` 均与 `origin/main` 一致。不能因此称**整个 MCP 模块**与 main 相同：分支原有的两处运行状态修复见下表。
- 独立回滚边界：技能 `44aca1cc`、扩展 `5eb65555`、两页选用的徽标对比度 `ff85c316`、UI 回归及跨页验收 `298d703b`。
- 验收材料提交的完整 SHA 可用 `git log -1 --format=%H -- docs/agent-capabilities-phase3-final-acceptance.md` 定位。完整运行日志及全部截图留在本地 `.shots/`，只把代表图和测量带进仓库。没有引入依赖、修改 Pi 本体或改变日常安装。

## 功能、发现与处置

| 模块 | 问题或验收边界 | 结果 |
| --- | --- | --- |
| Skills 加载 | RPC 报告的是同名项目技能，磁盘上的全局条目也曾被标为已加载；配置启用不等于实际加载。 | 依 RPC 路径匹配已加载项，保留尚在运行但已离开磁盘的条目。开关读配置，徽标读实际状态；未知不折算为停用。见 `df983dba`、`05b5cdd1`。 |
| Skills 写入 | 旧项目启停路径没有走已有管理入口的信任检查。 | 复用写入目标和信任检查，异常设置文件拒绝写入；定向测试用临时目录。创建/编辑、BOM/换行/frontmatter、文件/整包导入、外部扫描、同名冲突、只读、删除及撤销均有离线回归。 |
| Extensions | 关闭或切走市场时，在线目录确认可能留在页面。安装、启用、运行观察不可混为一个状态。 | 旧确认随所属页面释放；取消不发写请求。更新、重复安装、卸载、离线目录、网络错误、恢复及维护锁分层验证。原生启停继续交由 `pi config`，不造 GUI 开关。 |
| MCP 运行状态（先前修复，不是本轮改版） | 同目录重启及 A→B→A 后，旧连接观测不应继续显示；展开的能力报告不应沿用旧 Pi 的数据。 | `df983dba` 绑定运行身份，`05b5cdd1` 在 Pi 就绪后重读已有状态。只读刷新不等于自动测试连接。`f08bff84` 补齐报告先返回时旧原生摘要的失效。相对 main，两个前端脚本共新增 19 行就绪处理（含注释），另有 `server/mcp-native.js` 缓存修复；未改市场、代理、配置或页面布局。 |
| 技能页和市场 | 原页头很小、操作单独占一行，列表与设置里的 MCP 不是同一种版式。市场首次读取失败有两处重试，未读取到目录也能点「加载目录」。 | 纯文字标题和页头动作、独立工具栏、作用域及路径、行尾状态和开关；缺少描述不填占位文字。市场保留一次只读恢复入口，加载与确认仍是显式手势；刷新保留分类节点和选中态。 |
| 扩展页和市场 | 安装清单按小卡片铺开，只有一个条目的分组留下大块横向空白；旧市场三列卡片和独立色带与参照不符。 | 已安装项使用整宽行，分组、错误、更新/卸载、详情在自己的条目内；空简介不挤占错误说明。市场宽窗两列、窄窗一列，保留下方操作和包管理原有确认。 |

## 真实 Pi 与跨模块矩阵

Windows，Pi 1.6.0。`tests/skills-live.cjs`、`tests/agent-capabilities-live.cjs` 是 opt-in：HOME、agent、项目 A/B、npm 配置与缓存隔离；只安装回环 Registry 提供的无依赖、无生命周期脚本自制包。通过 RPC 的命令/工具发现核对加载事实，而不是据安装退出码推断。

| 场景 | 证据与限制 |
| --- | --- |
| A · 创建技能 → 安装扩展 → 返回技能 | 生产 API 创建项目技能，实际安装后 Pi 自动重启；RPC 按路径找到技能，也找到扩展注册的命令。前端返回/重读另有页面测试。 |
| B · 全局与项目共存 | A→B→A 两边项目技能与扩展各自可见，全局资源不变；MCP 配置字节一致。 |
| C · 重启恢复 | 安装、更新后重新加载；同目录重启清除旧 MCP 连接，显式重连成功。页面就绪通知与迟到响应另有离线检查。 |
| D · 切换/关闭中有请求在途 | 编辑、导入、扫描、市场的晚到成功/失败均检查项目与页面身份；扩展目录和 MCP 报告同样覆盖迟到结果。 |
| E · Skills 失败隔离 | 同一 Electron 窗口中给技能导入框一个内存里的 `notes.txt`，确认错误且不能提交；取消后打开已安装扩展详情，再进入 MCP 管理，旧错误不残留。包操作前后配置字节一致另由真实 Pi 测得。 |
| F · RPC/网络/配置故障 | 离线 RPC 不可达、配置异常和超时；本地 npm 503 后重试成功。**未覆盖**三个页面在同一场真实 Pi 启动失败中的端到端恢复。 |
| G · 模态焦点 | Electron 扩展详情 → 确认 → Escape 回焦；Chromium 技能编辑/导入/市场返回、MCP 新增及错误重试。关闭页面/切换项目后旧确认不写。 |
| H · 同一 Pi 使用三项能力 | 同一隔离配置发现技能、注册命令，并从本地 stdio MCP 取得 `fixture_ping`。**未调用远端模型**，不声称验证了模型回合。 |

## 视觉依据：分别看原图和对应源码

PI-Desktop 对照锁定到 [`7b8c3169`](https://github.com/vastsa/PI-Desktop/tree/7b8c316906ed49871f5ef0db1b3ae9bd52fe82ba)。这是本次核验时的 upstream main；**仓库里保存的图片不等于这一提交重新运行的截图**。

| 对照对象 | 阅读的原图、源码 | 借鉴与有意不同 |
| --- | --- | --- |
| 技能管理 | [上游技能列表原图](https://github.com/vastsa/PI-Desktop/blob/7b8c316906ed49871f5ef0db1b3ae9bd52fe82ba/.github/pr-assets/skill-market/06-skill-list.png)、本地 [REF-008](ui/pi-desktop-reference/01-screenshot-inventory.md)；[AgentSkillsPage](https://github.com/vastsa/PI-Desktop/blob/7b8c316906ed49871f5ef0db1b3ae9bd52fe82ba/apps/desktop/src/components/settings/AgentSkillsPage.tsx#L661-L695) | 保留作用域、项目选择、发现路径、分组导入、名称/描述与行尾开关。按 pi-GUI 原版 MCP 的主次顺序把「市场 / 新建」收入页头，扫描与项目选择相邻；不造上游产品的内置技能。 |
| 技能市场 | [市场原图](https://github.com/vastsa/PI-Desktop/blob/7b8c316906ed49871f5ef0db1b3ae9bd52fe82ba/.github/pr-assets/skill-market/01-skill-browse.png)、本地 REF-009；[SkillMarketPanel](https://github.com/vastsa/PI-Desktop/blob/7b8c316906ed49871f5ef0db1b3ae9bd52fe82ba/apps/desktop/src/components/settings/SkillMarketPanel.tsx#L767-L841) | 按原图核对返回、来源、搜索、分类、两列图标卡片与预览。只保留一个市场标题；标签不伪造「已验证」。已装条目仍可查看，安装须先预览。 |
| 已安装扩展 | [上游已安装原图](https://github.com/vastsa/PI-Desktop/blob/7b8c316906ed49871f5ef0db1b3ae9bd52fe82ba/docs/public/screenshots/app/zh/plugins-live.webp)；[PluginsPage](https://github.com/vastsa/PI-Desktop/blob/7b8c316906ed49871f5ef0db1b3ae9bd52fe82ba/apps/desktop/src/pages/PluginsPage.tsx#L49-L181) | 对照分页签、搜索、整宽分组行、异常文字、尾部操作。标题跟 pi-GUI MCP；不复制上游宿主的作用域菜单或自动更新。 |
| 插件市场 | [上游市场原图](https://github.com/vastsa/PI-Desktop/blob/7b8c316906ed49871f5ef0db1b3ae9bd52fe82ba/docs/public/screenshots/app/zh/plugins-market.webp)；[MarketplacePanel](https://github.com/vastsa/PI-Desktop/blob/7b8c316906ed49871f5ef0db1b3ae9bd52fe82ba/apps/desktop/src/features/plugins/MarketplacePanel.tsx)、[网格 CSS](https://github.com/vastsa/PI-Desktop/blob/7b8c316906ed49871f5ef0db1b3ae9bd52fe82ba/apps/desktop/src/styles/plugins.css#L1101-L1105) | 上游归档图是旧版三列，源码以可用宽度排网格；这里对齐本项目 MCP 市场的双列/单列。保留作者、版本、类别、详情和同意流程，不添加 npm 数据不能证明的评分/宿主权限。 |

原版 MCP 标题的实际值为 30px/700，大于设计系统一般页面的 20px/600。按用户指定的参照，仅这两个目标页面沿用大标题；不为统一而倒改 MCP，也不新增全局覆盖。控件沿用 `.btn`、Segmented、Select、Badge 和 Switch。实测浅色下旧成功徽标仅 2.86:1，故共享 Badge 提供可选文字色混合，**仅由技能、扩展及相应技能弹层选用**，其他调用点及 MCP 原色不变。合成真实前景与祖先底色后，「已加载」浅色为 6.02:1、深色为 7.43:1；技能 5 种和扩展 5 种常见标签在四组分别断言至少 4.5:1，详见下方测量，不外推到所有状态。

### 本次真实渲染（离线夹具、DPR 1）

| 尺寸 / 主题 | 技能列表 · 市场 | 已安装扩展 · 市场 | MCP 管理 · 市场（参照） |
| --- | --- | --- | --- |
| 1320×820 深 | [列表](ui/evidence/agent-capabilities-phase3/skills/1320-dark-list.png) · [市场](ui/evidence/agent-capabilities-phase3/skills/1320-dark-05-market.png) | [已安装](ui/evidence/agent-capabilities-phase3/extensions/1320-dark-installed.png) · [市场](ui/evidence/agent-capabilities-phase3/extensions/1320-dark-market.png) | [管理](ui/evidence/agent-capabilities-phase3/mcp/1320-dark-management.png) · [市场](ui/evidence/agent-capabilities-phase3/mcp/1320-dark-market.png) |
| 1320×820 浅 | [列表](ui/evidence/agent-capabilities-phase3/skills/1320-light-list.png) · [市场](ui/evidence/agent-capabilities-phase3/skills/1320-light-05-market.png) | [已安装](ui/evidence/agent-capabilities-phase3/extensions/1320-light-installed.png) · [市场](ui/evidence/agent-capabilities-phase3/extensions/1320-light-market.png) | [管理](ui/evidence/agent-capabilities-phase3/mcp/1320-light-management.png) · [市场](ui/evidence/agent-capabilities-phase3/mcp/1320-light-market.png) |
| 700×600 深 | [列表](ui/evidence/agent-capabilities-phase3/skills/700-dark-list.png) · [市场](ui/evidence/agent-capabilities-phase3/skills/700-dark-04-market.png) | [已安装](ui/evidence/agent-capabilities-phase3/extensions/700-dark-installed.png) · [市场](ui/evidence/agent-capabilities-phase3/extensions/700-dark-market.png) | [管理](ui/evidence/agent-capabilities-phase3/mcp/700-dark-management.png) · [市场](ui/evidence/agent-capabilities-phase3/mcp/700-dark-market.png) |
| 700×600 浅 | [列表](ui/evidence/agent-capabilities-phase3/skills/700-light-list.png) · [市场](ui/evidence/agent-capabilities-phase3/skills/700-light-04-market.png) | [已安装](ui/evidence/agent-capabilities-phase3/extensions/700-light-installed.png) · [市场](ui/evidence/agent-capabilities-phase3/extensions/700-light-market.png) | [管理](ui/evidence/agent-capabilities-phase3/mcp/700-light-management.png) · [市场](ui/evidence/agent-capabilities-phase3/mcp/700-light-market.png) |

- Skills：Chrome 真实 Renderer，44 张、0 页面异常；[测量](ui/evidence/agent-capabilities-phase3/skills/render.json)。各组技能标题 30px/700，分组 16px，页头按钮 32px，列表和市场内容区横向溢出 0px。[编辑](ui/evidence/agent-capabilities-phase3/skills/700-dark-02c-editor-edit.png) · [导入](ui/evidence/agent-capabilities-phase3/skills/700-light-03-import.png) · [扫描](ui/evidence/agent-capabilities-phase3/skills/700-dark-04b-external.png) · [预览](ui/evidence/agent-capabilities-phase3/skills/1320-dark-07-preview.png) · [成功](ui/evidence/agent-capabilities-phase3/skills/1320-dark-11-notice.png) · [空组](ui/evidence/agent-capabilities-phase3/skills/700-dark-05-empty.png) · [错误](ui/evidence/agent-capabilities-phase3/skills/700-light-06-error.png)。
- Extensions：Electron 离线真实窗口，22 张；[测量](ui/evidence/agent-capabilities-phase3/extensions/render.json)。补测使用扩展通知真实入口注入两条合成长诊断，不含用户截图里的实际路径或消息。四组默认只占 **34px**；首条扩展从桌面 y=254.5px / 窄窗 y=284.5px 开始。Enter 展开原文、Tab 进入正文、PageDown 只滚正文，收起后不丢全文；没有提示时不占位。[桌面展开](ui/evidence/agent-capabilities-phase3/extensions/1320-dark-run-notices.png) · [窄窗展开](ui/evidence/agent-capabilities-phase3/extensions/700-light-run-notices.png)。两列/一列，市场卡片高 176px、圆角 12px、紧凑按钮 28px，横向溢出 0px。[筛选](ui/evidence/agent-capabilities-phase3/extensions/700-light-filtered.png) · [空结果](ui/evidence/agent-capabilities-phase3/extensions/700-light-empty.png) · [详情](ui/evidence/agent-capabilities-phase3/extensions/1320-dark-detail.png) · [确认](ui/evidence/agent-capabilities-phase3/extensions/1320-dark-confirm.png) · [安装中](ui/evidence/agent-capabilities-phase3/extensions/700-light-installing.png) · [安装失败](ui/evidence/agent-capabilities-phase3/extensions/700-light-install-failed.png)。
- MCP：`MCP_VISUAL_MATRIX=1 MCP_MARKET_PAGINATION=1 MCP_MARKET_PROGRESS=1 node tests/mcp-visual.cjs`。原版管理页四组标题 **30px/700**、按钮 32px、管理页溢出 0px；[测量](ui/evidence/agent-capabilities-phase3/mcp/render.json) · [新增](ui/evidence/agent-capabilities-phase3/mcp/700-dark-add.png) · [分页](ui/evidence/agent-capabilities-phase3/mcp/05d-market-narrow.png) · [安装预览](ui/evidence/agent-capabilities-phase3/mcp/04-install-preview.png) · [加载](ui/evidence/agent-capabilities-phase3/mcp/06-market-loading.png) · [不匹配](ui/evidence/agent-capabilities-phase3/mcp/700-light-empty-search.png) · [读取失败](ui/evidence/agent-capabilities-phase3/mcp/700-light-read-error.png)。管理页的测量不证明 MCP 市场在所有数据下无溢出。

## 测试、构建与审查

| 层次 / 命令 | 通过 | 失败 | 跳过 / 说明 |
| --- | ---: | ---: | --- |
| `npm run test:skills`，8 套件 | 1130 | 0 | 5 个环境 skip 不计入分母：2 个 POSIX 权限位、3 个无文件符号链接权限；UI 43/43 |
| `npm run test:extensions`，3 套件 | 310 | 0 | 0 |
| `npm run test:mcp`，7 套件 | 411 | 0 | 0（44+24+72+19+14+35+203） |
| `node tests/agent-capability-pages.cjs` | 49 | 0 | 三页结构、状态和生命周期 |
| `npm run test:primitives`，4 套件 | 116 | 0 | 具名检查；包括真实 Electron 样式 |
| `node tests/server-security.cjs` / `capability-install.cjs` / `high-risk-regressions.cjs` | 44 / 83 / 28 | 0 | 隔离夹具 |
| `node tests/extension-market-electron.cjs` / `node tests/shortcut-electron.cjs` | 48 / 103 | 0 | 22 / 35 张图，测试窗口不作为正常原生沙箱证明 |
| `PI_BIN=… node tests/skills-live.cjs` | 32 | 0 | 真实 Pi 1.6.0，仅临时数据 |
| `PI_BIN=… node tests/agent-capabilities-live.cjs` | 27 | 0 | 源码 HTTP 后端；另指定 `PI_GUI_LIVE_BACKEND` 实测打包后的 `server.cjs` |
| `npm run build:app -- --rebuild` | — | 0 | 本机 Electron 44.4.3 ZIP 离线重建；Windows x64 整包 335.3 MB |
| `npm run test:app` / `npm run test:exe` | 27 / 50 | 0 | Electron 打包后端与 SEA 单文件分别验证；非安装/升级验证 |

产物位于本分支工作树 `dist-app/Pi GUI-win32-x64/`，不覆盖日常安装。把两模块全部文件、`app.js`、共享原语 CSS 和 MCP 参照资源同打包目录比对，**23/23 逐字节相同**；打包 `server.cjs` 与构建结果 SHA-256 都是 `f73859da6231c03ef39f094a3a372faf22eb792b567d11eb20ee33b087efb7d2`。

首轮回归校正：扩展清单旧用例仍要求「没有简介」占位，48/49；改为断言无空段落但加载错误仍可见，49/49。旧桌面几何用例要求同组条目左右并列，按新需求等价替换为「整宽上下排列、展开详情不遮挡下行」，保留原 100 项，再加同一窗口从失败导入进入扩展和 MCP 的 3 项（103/103）。设计系统守卫拦下一处在技能页直接选择共享分段类的 CSS；改为仅给此实例安排换行，不放宽规则，四套件 116 项通过。

### 独立复审与处置

独立静态审查覆盖 `5ed42f3e..15d3eff2` 的状态与授权边界；另一次独立 UI 审查看了相对 `15d3eff2` 的页面、四组截图和上游依据。没有报告已证实的 Blocker。逐项对比 PR 实际代码，而非直接采纳审查摘要：

| 发现 | 处置与证明 |
| --- | --- |
| MCP 报告与服务器摘要乱序（Important） | **已修复 `f08bff84`。** 测试扣住 `/api/mcp/servers`，让 `/api/mcp` 先返回：修前显示旧的「生效中」导致 34 通过 / 1 失败；修后先显示「原生状态未知」，随后显示新一轮「被扩展接管」，无额外 POST，35/35。未改布局。 |
| 技能详情按钮/开关无法读到行尾加载状态 | **已修复 `3fa3d0f1`。** 两个焦点目标的 `aria-describedby` 指向本行已有徽标；配置开关的 `aria-checked` 不变。回归从 48/49 到 49/49。另在真实 Chromium 可访问性树读取了 button、switch 的 `description`，深浅主题均为「已加载」，未使用真实读屏软件。四组共 44 张，15 张归档图逐字节未变，测量未变。 |
| 市场分类刷新时重建节点丢焦点 | **已核实，对本 PR 版本不成立。** 服务端返回固定的 `MARKET_CATEGORIES`，本版本 `syncControls` 仅在首次成功读取时创建分类。新增断言在刷新未完成时把键盘焦点放到「文档」；刷新后仍是同一焦点节点、同一选项和对应结果，43/43。未改市场业务代码。 |

新增回归提交 `24fbc2b9`；独立审查不等同于合并批准。

运行提示增量（产品 `2b04c3c1`、测试 `5523c8cb`）：旧页面的长消息用例先红（页面回归 48/49，期望折叠控件、实际是平铺 section）；改后 49/49，另外通知路由/生命周期 10/10、扩展三套件 310/310、共享原语 116 项通过。Electron 首轮键盘驱动只发送键码，没有模拟原生 Enter 的字符事件，未能展开；与仓库已有原生 `summary` 测试对齐输入方式，不更改产品键盘语义，该轮四组 45/45。

**运行提示增量复审（Important，已修复）。** 对 `74955f2e..618c6c95` 的独立静态审查指出：提示区持有焦点时若因 Pi 重启而隐藏，焦点不再落在可见控件上。作者在真实 Electron 中复现；页面回归修前 48/49。`221b92b3` 只在提示区持有焦点时将其交还当前页签；`82b350c6` 覆盖摘要、正文、搜索三条路径以及切换项目。修后页面回归 49/49、真实 Electron 48/48（22 张图）、通知行为 10/10；没有改版式或全局通知路由。桌面重新构建后资源比对 23/23，打包后端 27/27、SEA 50/50。

**完整证明待验证。** 首次本地 `npm test` 停在 `tests/high-risk-regressions.cjs` 的普通文件名 `report%20final.txt`：断言 `result.ok` 为 `false`（27/28）。上传模块、路由和该用例均不在分支 diff 内；单独复跑为 28/28。失败日志未给出具体请求错误，不能推定根因，也不能把重跑单套件当作全量通过。本地第二次 `npm test` 启动于复审增量之前，在 `tests/provider-config-store.cjs` 的 3 项 Windows 原生凭据文件保护断言失败，不记作通过。[完整 PR CI 45033732461](https://github.com/HYJ1817/pi-gui/actions/runs/45033732461) 对 `74955f2e` 已成功，但不替代随后「运行提示折叠及已安装列表精简」的完整证明。后者已通过本地定向和真实渲染，最终提交的完整 CI 另记。

边界：没有真实远端模型、OAuth、外部 Registry 安装、第三方 MCP 或安装程序升级测试；未在同版本上实际操作 PI-Desktop（使用了上游原图与当前源码）；未逐项覆盖任意字体放大、所有瞬时交互或所有可见颜色的 WCAG 对比度。Windows 文件符号链接的跳过项仍待有权限的环境复验。文件系统对象的外部并发替换保留[安全规范](security.md#技能写入与市场2a)所述边界。

回滚：页面、UI 测试和材料可按提交分别反向回退；全分支撤销时在相同基线重新构建 `npm run build:app -- --rebuild`。不单独反转 MCP 的 `8afeb76a`（否则会把已撤销的外观重新引入）。代码回退不会修改用户已用 Pi 完成的包操作或技能文件。未经用户明确许可，不合并、不打 tag、不发布。
