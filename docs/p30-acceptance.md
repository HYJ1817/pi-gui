# P30 验收报告

验收日期：2026-10-05。本报告针对本机离线 fixture 与重建后的桌面应用。

## 基线、分支与交付

- before HEAD：`50b8c81bbd439257cd5735c4359305bb337a3ee9`（开始时 main 与新 fetch 的 origin/main 一致）。
- branch：`codex/p30-ui-ia-cleanup`。
- after implementation/test HEAD：`dac8eb45b64cade4c71d457520d24f67922a317a`；包含本报告的最终 HEAD 在交付回复中给出。
- 没有推送、合并 main、改版本号或发布 Release。
- 开始时已有的两个未跟踪工作目录保持原样；本次日志、辅助程序在 `.probe/p30/`，截图在 `.shots/`。

## 信息架构与入口

[完整 IA 审计表](p30-ui-ia.md#入口审计)在改产品代码前已输出，列出入口、基线位置、频率判断、常驻要求、决策和新发现路径。
频率为设计判断，不是使用数据。保留现有全局图标栏和可折叠项目侧栏，没有重写 Renderer 或 CSS。

| 分类 | 入口与最终路径 |
|---|---|
| 保留一级 | 对话；新对话；项目/会话及搜索；任务 Planner；Skills 与扩展；设置 |
| 保留项目/会话能力 | 稳定排序、分组/项目折叠、项目/会话三点菜单、归档、删除、重命名、项目配置、会话内导航、分支树 |
| 保留工作流 | Planner、Attempt、Review、验证、门控、历史 Diff；工具 Activity、审批与 Extension UI |
| 保留输入区 | 模型、思考等级、附件、上下文/用量/额度、发送、Streaming、Stop pending、错误恢复 |
| 下沉设置 | 模型供应商 CRUD、Pi 原生认证 → 模型与账户；Capabilities → Agent 能力；MCP → 扩展与 MCP |
| 下沉设置 | Pi GUI/Pi 更新、重启 Pi → 应用与更新；诊断/probe/脱敏导出 → 诊断；快捷键帮助/命令面板 → 键盘与命令 |
| 下沉右栏 | Changes → 顶栏/Alt+3/命令面板；Browser → 顶栏/命令面板/既有 Agent 上下文 |
| 合并重复入口 | 当前项目的新对话、搜索不再与侧栏重复；导出、统计从顶栏收进会话 More，命令仍保留 |

Settings 六个分组只调用既有 owner。Skills 默认打开 Skills 过滤器；其他过滤器仍可进入。
Changes 使用已有 right-pane，保留中央对话、滚动和草稿；与 Browser 互斥，切走关闭原生 WebContentsView。
关闭右栏清空挂载并释放空间。Review 继续使用 Planner 详情，不新增无实现的 Preview。

## 关键修改文件

| 文件 | 修改 |
|---|---|
| `public/index.html`、`public/app.js` | 入口组织、设置分组、既有动作装配、More 按钮、搜索与侧栏焦点 |
| `public/settings.js` | 复用原更新模块的应用与更新弹层 |
| `public/right-pane.js`、`public/ui/secondary-surface.js` | 右栏互斥生命周期、关闭释放、焦点交接、异步结果失效 |
| `public/git.js`、`public/browser-pane.js`、`public/ui/workspace-surface.js` | Changes 迁移、原生 Browser 卸载、一级视图事件 |
| `public/projects.js` | 合并当前项目重复新建/搜索入口，不改排序与持久化 |
| `public/palette.js` | 命令执行不泄漏鼠标事件；保留新菜单/工作面的焦点 |
| `public/composer.js` | Stop pending 的可见停止按钮禁用，沿用原停止屏障 |
| `public/styles.css` | 34px 侧栏行节奏、16px 图标、弱分割线、短空态、右栏布局、状态样式 |
| `public/update.js`、`public/pi-update.js`、`README.md` | 新发现路径文案 |
| `tests/ui-ia.cjs`、`tests/ui-ia-electron.cjs` | 组装行为回归、真实 Electron/键鼠/尺寸/缩放/截图 |
| 既有 smoke/harness/shot-app 测试、`package.json` | 容器语义迁移；新行为套件纳入唯一 npm test 入口 |

无新增第三方依赖，无 Pi RPC、模型路由、进程管理或 Worktree 多会话修改。

## 关键状态截图

截图为实际 Electron renderer/preload 的离线数据。浏览器本体是实际 WebContentsView，另附原生页面截图；主 renderer capturePage 不包含原生子视图像素。

| 状态 | 截图 |
|---|---|
| 无项目 | [1280×800](../.shots/p30/no-project-1280x800.png)；[实际打包应用](../.shots/p30-packaged-1280x800-window.png) |
| 空会话 | [1440×900](../.shots/p30/empty-session-1440x900.png) |
| 普通长会话 | [1920×1080](../.shots/p30/long-conversation-1920x1080.png) |
| Streaming | [1280×800](../.shots/p30/streaming-1280x800.png) |
| Stop pending | [1440×900](../.shots/p30/stop-pending-1440x900.png) |
| Error | [1440×900](../.shots/p30/error-1440x900.png) |
| Browser 打开 | [窗口布局](../.shots/p30/browser-open-1440x900.png)；[原生页面](../.shots/p30/native-browser-1440x900.png) |
| Changes 打开与 Diff | [1280×800](../.shots/p30/changes-open-1280x800.png) |
| 右栏关闭 | [1920×1080](../.shots/p30/right-pane-closed-1920x1080.png) |
| 设置 / 命令面板 | [设置](../.shots/p30/settings-1440x900.png)；[命令面板](../.shots/p30/palette-1440x900.png) |
| Planner / Skills | [任务与审阅](../.shots/p30/planner-review-1440x900.png)；[Skills](../.shots/p30/skills-1440x900.png) |

## 三个尺寸与缩放

| CSS 视口实测 | 覆盖 | 结果 |
|---|---|---|
| 1280×800 | 九个主要状态、原生 Browser 页面 | 文档无溢出，顶栏 46px，关闭右栏释放空间 |
| 1440×900 | 同上，加设置、面板、Planner、Skills | 同上，设置分组可访问，焦点可见 |
| 1920×1080 | 九个主要状态、原生 Browser 页面 | 同上，正文/右栏均在视口内 |

以上为 `tests/ui-ia-electron.cjs` 的真实 `innerWidth/innerHeight`，见 [.shots/p30/results.json](../.shots/p30/results.json)。
页面缩放 80%、125%、150% 也验了 Changes、右栏边界、文档溢出与顶栏；有对应截图。
本机 DPI 会使 PNG 物理像素与 CSS 像素不同。

现有 `shot-app.cjs` 对重建应用额外检查三次：1280×800、1440×900 实测与请求相同；1920×1080 请求受显示器工作区限制，实际为 1707×1019。
三次均为 Electron/44.4.3，原生窗口按钮避让 150px（要求 ≥138px），未捕获异常和 console.error 均为 0；不将最后一次误报成 1920×1080。

## 键盘与交互

真实 Electron CDP 的键盘/鼠标输入确认：

- Ctrl+K 打开命令面板；Tab/Shift+Tab 留在面板；Escape 关闭。
- 鼠标点击和 Enter 执行“设置”，菜单保持打开、焦点交到首项；修复前两用例实际失败，修复后通过。
- 设置 ArrowUp/Down 导航、Escape 回到设置入口。
- 项目/会话三点菜单 Escape 回到各自触发按钮。
- 搜索真实输入；第一次 Escape 清查询，第二次关闭并回到搜索入口。
- 项目分组折叠；侧栏折叠交焦点给展开按钮；折叠后 Shift+Tab 可到设置；展开交回原按钮。
- Changes 关闭返回入口且 aria-pressed 恢复；Browser/Changes 切换不残留旧工作面。
- 实际 hover 背景和键盘 `:focus-visible` 描边有效；Streaming/Stop pending 禁用等级可辨。

独立审查发现并复核了命令面板 → 设置的事件冒泡/焦点问题；修复后未发现其他可确认回归。

## 测试、构建与证据

| 检查 | 最终结果 | 证据 |
|---|---|---|
| `npm test` | exit 0，61 个套件脚本全部完成 | [.probe/p30/npm-test-final.log](../.probe/p30/npm-test-final.log) |
| 新 IA 组装行为 | 12/12 | 同上；[focused log](../.probe/p30/ia-final.log) |
| 原 smoke | 1338/1338，与基线相同 | 同上 |
| hotfix UI / 菜单 | 10/10、37/37 | 同上 |
| Git fixture | 161/161 | 同上 |
| 会话 / 搜索 | 71/71、57/57 | 同上 |
| Provider/Auth / runtime | 105/105、36/36 | 同上 |
| 原 Browser UI / Stop barrier | 22/22、16/16 | 同上 |
| 现有完整 visual harness + cdp-shot | exit 0，276 张截图，全部取景判据通过，页面异常 0 | [visual-clean.log](../.probe/p30/visual-clean.log)；`.shots/p30-final-*.png` |
| P30 真实 Electron | 161/161，37 张截图，console error 0 | [electron-final.log](../.probe/p30/electron-final.log)、[results.json](../.shots/p30/results.json) |
| 现有打包 Browser 原生 UI | 52/52；开关、销毁、再开不留残留 | [browser-autoports.log](../.probe/p30/browser-autoports.log) |
| 现有打包 `shot-app` | 三次 exit 0，实际视口见上表说明 | [packaged-shots-final.log](../.probe/p30/packaged-shots-final.log) |
| `build:app -- --rebuild` | exit 0；SEA + Electron 生成；使用本机 Electron zip，无下载 | [build-final.log](../.probe/p30/build-final.log) |
| `test:exe` / `test:app` 等价原脚本 | 48/48、26/26，exit 0 | [exe-final.log](../.probe/p30/exe-final.log)、[app-final.log](../.probe/p30/app-final.log) |
| 源码/打包静态资源 SHA-256 | 7/7 相同，含新增模块与最终 palette | [asset-digests.json](../.probe/p30/asset-digests.json) |

SEA 为 98,822,144 字节（94.2 MB）；Electron 入口为 246,324,736 字节（234.9 MB），整包 327.5 MB。
桌面入口：`dist-app/Pi GUI-win32-x64/Pi GUI.exe`；单文件源码服务器入口：`build/Pi GUI.exe`。
例如 `index.html` SHA-256：`26B5479410C3F6A65CCBFD72427317EAE0E3F39224ADBB3D047D7A0E765D2B26`。

原 smoke 断言数量保持 1338；迁移 Changes 的容器与状态断言，没有删除 Git/Diff/撤销覆盖。
新 IA 套件从最初 9 项到停止按钮 10 项，再补命令面板交接为 12 项，增加而非减少。
原 More 项数从 5 到 4 是重启入口移到设置，原操作仍有绑定与命令。

中间失败记录保留在 `.probe/p30/`：sandbox 基线 Git 写入失败、旧 Temp/嵌套 Temp 的 EXE EPERM、本机端口 EACCES、复用 harness 内存引起的失败，以及真实发现的 palette 回归。分别用授权运行、workspace 根临时 fixture、探测可用端口、全新内存 harness 和行为修复复核；没有删除失败断言。
Electron 后端 fixture 若嵌套在仓库下会看到仓库的 node_modules，触发 25/26 假红；最终用独立系统临时目录复核为 26/26。

## 已知限制

- Planner 是否日用没有统计依据；保留既有一级入口。Review 继续使用其完整详情承载。
- Settings 是分组动作菜单和已有面板组合，没有新建第二套配置状态。
- 诊断保留原版本/更新模块；Settings 的更新面板复用相同 owner。
- 没有使用真实账号 OAuth、联网更新、真实 Pi/模型任务或用户项目写入来测试；状态/写入用离线内存和临时 fixture。
- Browser 的原生像素另行 capturePage，不把 renderer 截图中的空内容区解释为加载失败。
- 打包应用的最大窗口实测受本机显示器限制；另有真实 Electron renderer 的准确 1920×1080 验证。
- 截图与构建产物是本机交付文件，未加入 Git、未发布。
