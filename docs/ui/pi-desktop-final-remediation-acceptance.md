> 第三轮归档（2026-11-06）：本页移除的历史矩阵/完整输出使用固定提交 `ff6f22e26caae540cd050cbcd89c78f84c1e05cb` 追溯；保留的JSON记录反映当次捕获全集，图片路径可在该提交解析，不能作为最新代码通过证明。当前代表图及验证见[清理报告](../repository-cleanup-report.md)。

# PI-Desktop 最终审计修复与验收材料

日期：2026-11-06。对应 [原审计](pi-desktop-final-audit.md) 和 [R1–R6 修复计划](pi-desktop-final-remediation-plan.md)。原审计保留原结论，不改写历史失败。

**本轮原 AUD-001–014 共14项已完成修复，L01–L07 共7项历史收尾已落实；原问题集合中未解决 P0/P1/P2/P3 均为0。** 这表示本地修复及下述验证完成，不代表取得作者外独立签核、用户验收、最终 main CI 或发布资格。可以进入独立验收和合并前 CI；本报告不授予推送、合并、发版许可。

## 1. 基线、范围与证据边界

| 项目 | 本次事实 |
| --- | --- |
| 仓库 / 分支 | `C:/pi-GUI` / `codex/pi-desktop-final-remediation`，开始时工作区干净 |
| 生产基线 | 本地与 fetch 后远端 main 均为 `326cb3284c5bf67398290ca4cd6ea8bfd5ee8496` |
| 审计文档基线 | `d7e84c57d87bf02fdde075e6b9a62021819340a3`，在生产基线上只增加审计材料 |
| 固定参考 | PI-Desktop `92ae661f1e399e69d514086b46029b4c34ba1a92`，仍使用[原24图摘要](final-audit-evidence/references.json) |
| 基线 CI | [42138148246](https://github.com/HYJ1817/pi-gui/actions/runs/42138148246)，main push、attempt 1、8/8 jobs、234 commands；只证明原基线 |
| 环境 | Windows 10.0.26200 / x64，Node v24.22.1，Electron 44.4.3；正常 sandbox、contextIsolation，renderer 无 Node |
| 修改边界 | 原生 JS、既有 tokens/primitives、Settings/Extensions/RightPane/Browser/Viz/Popover owners；无 RPC、后端、会话 schema、依赖、版本改动 |
| 新证据 | [目录说明](final-remediation-evidence/README.md)、132张真实 PNG、源码摘要、运行记录和失败历史 |
| 数据边界 | TEMP 项目/profile/配置/上传/Git fixture；离线 HTTP fixture 或假 Pi；不调用真实模型，不写真实项目或认证配置 |
| 独立性 | 按用户要求未使用子代理。自查不能替代作者外隔离审查或用户批准 |

开始前重新读取仓库规则、审查与测试政策，核对架构和参考源码。复用现有 `presentDetail`、原供应商保存 handler、Extensions active tab、命令注册表、共享 popover 和 Browser occlusion。没有按路线图再造路由、菜单或 Browser controller。

## 2. 十四项逐项关闭

下表定位指本轮最终源码；原复现步骤、影响和参考来源仍见原审计对应编号。所有“已修复”均有生产模块或真实 Electron 路径证据，不以图片存在代替视觉判定。

| 编号 / 原级别 | 根因与最终修改 | 实测结果与证据 |
| --- | --- | --- |
| AUD-001 · B/F · P1 | 删除 `styles.css` 无条件隐藏 Detail actions 的规则，沿用[原动作布局](../../public/styles.css#L3062)；[空态 Add](../../public/providers.js#L175) 委托现有主 Add 入口，不复制表单/保存逻辑 | 两个入口都有 Save/Cancel；原生 Tab 到 Save、Enter 经真实 API wrapper 恰好一次；缺 ID/原文密钥拒绝，取消无写请求；诊断5项动作可见。[表单](final-remediation-evidence/electron/r02-provider-add-dark.png)、[诊断](final-remediation-evidence/electron/r10-diagnostics-dark.png)、[实际包表单](final-remediation-evidence/packaged/p05-provider-form-light.png) |
| AUD-002 · A/B/F · P2 | 删除旧 `.appearance-body` 边框/底色/内距和失效 fieldset 清理；Detail 使用页面可用宽度；[资源设置页](../../public/styles.css#L318) 统一标题、页边距和 tabs 展示，保留实际两栏详情与信任提示 | 外观 section computed border=0、transparent、padding=0；独立 tile 保留，标题/正文与资源页共用40/48px横向边界。[外观](final-remediation-evidence/electron/10-settings-appearance-dark.png)、[Skills](final-remediation-evidence/electron/r11-settings-skills-dark.png)、[MCP](final-remediation-evidence/electron/r11-settings-mcp-dark.png)。保留的布局差异见第5节 |
| AUD-003 · A/B/F · P2 | 按真实复合控件嵌套修订 [multiline row](../../public/styles.css#L3013)；标签保留可读宽度，尾部整组换行，选项允许换行 | 700/900px × 深浅 × 130% 字号检查标签不逐字竖排、控件在视口内；100%窄窗也通过。[130%窄窗](final-remediation-evidence/electron/r09-appearance-130-narrow-light.png) |
| AUD-004 · B/F · P2 | [Extensions render](../../public/extensions.js#L1042) 将 active tab 派生为实际 nav/title；[workspace projection](../../public/ui/workspace-surface.js#L31) 不持有第二份 tab 状态 | MCP、能力、Skills 外部入口及内部切换具有唯一当前项；ui-ia 27/27；实际包 MCP 当前项正确。[MCP](final-remediation-evidence/packaged/p06-mcp-light.png) |
| AUD-005 · E/F · P2 | [ui4-pane](../../tests/ui4-pane.cjs) 改用 owner 的392px、可见 launcher、持续46px工具导航、当前焦点返回契约；Browser 空态与已导航视图分别检查；原生拖拽最后 move/release 同步入队 | 原280项检查保留并修正过期参数，新增2项空态/重开检查，最终282/282，35截图。未改生产宽度去迎合420px断言。保留[失败](final-remediation-evidence/ui4-first.log)、[最终记录](final-remediation-evidence/ui4-results.json)、[输入事件轨迹](final-remediation-evidence/ui4-input-trace.json) |
| AUD-006 · C/D/F · P2 | 欢迎页视觉统一由 [ui4-feedback.css](../../public/ui4-feedback.css#L348) 负责；清理旧左上小标题覆盖，100px现有π图形、28px居中标题；空线程无内容时不再占底部 padding | Ready/NoProject/Restore owners、原有 CTA 不变；真实检查居中层级、100px图形、空会话无额外滚动；折叠/浅色及包内页面可见。[深色](final-remediation-evidence/electron/01-dark-expanded.png)、[实际包浅色](final-remediation-evidence/packaged/p03-main-light.png) |
| AUD-007 · E/F · P2 | [Browser surface](../../public/browser-pane.js#L137) 从主进程 url 派生应用空态，将 blank 与既有 pane occlusion 合并；空页摘下原生 view，导航后量新 bounds 再显示 | 深浅空页显示地址引导；拒绝 file URL 保留引导/错误；已导航网页、模态、分屏、20次销毁重开与双 Runtime 隔离通过66/66。无 controller/权限/网页注入改动。[浅色](final-remediation-evidence/electron/r08-browser-empty-light.png)、[实际包原生整窗](final-remediation-evidence/packaged/p08-browser-empty-dark-native.png) |
| AUD-008 · D/F · P2 | [viz.css](../../public/viz.css) 将未定义别名替换为现有 DS 表面/文字/边框语义 token，保留表达数据的系列颜色 | 合法 schema → 生产 Markdown card → 实际打开图表；浅色按钮与 tooltip 正文对比度≥4.5:1，深色相邻路径回归通过。[图表](final-remediation-evidence/electron/r03-viz-light-keyboard.png)、viz-ui 68/68 |
| AUD-009 · D/F · P2 | [showTip](../../public/viz-chart.js#L298) 的 focus 从数据点实际矩形定位，指针使用实际坐标；按 tooltip 实测尺寸约束四边 | 键盘 tooltip 完整处于真实 wrapper；单元回归另验偏移面板及右下边界，不复制定位实现。[同图](final-remediation-evidence/electron/r03-viz-light-keyboard.png) |
| AUD-010 · B/F · P2 | [settings menu](../../public/ui/settings-surface.js#L165) 对已消费的冒泡按键直接返回，避免输入框与 menu 各推进一次 | 生产 input 冒泡 Down 单元检查16/16；另用真实Electron可信Down/Up/过滤后Down/Escape复验，[补充31/31结果](final-remediation-evidence/settings-native-results.json)含首项导航及Base URL拒绝 |
| AUD-011 · D/F · P3 | [inline menu](../../public/ui/inline-command-menu.js#L269) 对齐外 Composer；按现有候选顺序展示连续分组标题和键盘提示，不新增命令、不重排注册表 | 宽窗目标760px、窄窗适配，原生 Browser 旁避让；↑↓/Enter/Tab/Escape、composition 语义及243项输入集成通过。[浅色](final-remediation-evidence/electron/f02-slash-light.png)、[Browser边界](final-remediation-evidence/electron/f15-slash-browser-light-native.png) |
| AUD-012 · D/F · P3 | [popover tip 分支](../../public/ui/popover.js#L45) 采用376px可用宽度；[tip CSS](../../public/ui3-model.css#L33) 独立14px圆角/16px padding，不改 model/Thinking mode | 实测376/14/16；窄窗、unknown、额度告警可读并保留真实语义；模型菜单回归通过。[已知用量](final-remediation-evidence/electron/f03-context-light.png)、[unknown](final-remediation-evidence/electron/f04-context-unknown-light.png) |
| AUD-013 · D/F · P3 | [preserveClipboard](../../tests/fixtures/preserve-clipboard.cjs) 使用安装版本 ClipboardItem API，有界即时内存快照、finally 恢复；8MiB/32格式/4 items上限，拒绝不安全快照后不写入 | helper 8/8；真实 Electron text+HTML 在模拟中断后恢复；D复制仍通过，最终恢复原格式。没有把剪贴板正文写日志或报告。[综合结果](final-remediation-evidence/electron/results.json) |
| AUD-014 · C/F · P3 | [group-bar](../../public/app-shell.css#L93) 在原 rail-group 内 sticky，限定项目侧栏作用域，使用原 sidebar token | 40会话、展开完整列表后 scrollTop>0，分组标题坐标保持；原底栏、会话顺序和菜单 owner 不变。[长列表](final-remediation-evidence/electron/r06-sticky-projects-light.png) |

R1 的 provider 校验没有修改；缺 ID、原文 key、有效提交及取消在综合专项实测，缺 Base URL 在补充Electron中经原保存handler复验：无POST请求并显示对应提示。没有以fixture证明真实Provider网络或认证成功。

## 3. 历史遗留清算

| 历史条目 | 本轮处置 | 结论 |
| --- | --- | --- |
| L01 外观旧卡片包框 | AUD-002，移除实际生效的旧 section 展示规则 | 已修复 |
| L02 ui4 420px旧测试 | AUD-005，392px owner、可见入口、当前 header/focus，282/282 | 已修复 |
| L03 Browser 自有空白 | AUD-007，深浅引导、原生遮挡和重新导航 | 已修复 |
| L04 Slash 外形与提示 | AUD-011，外 Composer、分组、键盘提示 | 已修复 |
| L05 上下文浮层外形 | AUD-012，376/14/16 | 已修复 |
| L06 项目组标题滚走 | AUD-014，原 owner 内 sticky | 已修复 |
| L07 欢迎区旧视觉 | AUD-006，统一后加载样式与居中 hero | 已修复 |

这些结论不包含被排除的产品功能，也不把下文未验证资格算作“已解决”。

## 4. 测试、构建和真实性

### 完整 canonical

**2026-11-06 11:25:10–12:45:24（Asia/Shanghai）单次 `npm test` 退出0，235个递归叶命令，80分13.683秒。** 原234个命令保留，新增 `tests/clipboard-preservation.cjs`。命令数不是断言数；没有累计续跑冒充单次成功。[运行结果](final-remediation-evidence/canonical-result.json)、[实际链](final-remediation-evidence/canonical-plan.json)、[原始日志](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/canonical.log)。

原始 `sourceUnchanged:false` **保留**：[摘要复核](final-remediation-evidence/source-verification.json) 确认唯一变化为 `tests/ui4-pane.cjs`，该文件经 `ui4-integration-electron.cjs` 在独立桌面专项运行，不在 canonical 链、生命周期或其模块依赖内。修改是上述原生输入时序，最终另跑282/282。生产、package、canonical 测试及依赖输入均未变；因此这次是覆盖最终生产状态的单次 canonical 成功，不能描述成“整棵工作区从头到尾字节冻结”。[启动摘要](final-remediation-evidence/frozen-source.json) 可独立复核。

使用测试已支持的隔离端口 `TEST_PORT=17881/GUARD_PORT=17882/SEC_PORT=17883/GIT_PORT=17884`；未结束用户的7791服务。PowerShell Bypass 仅为测试子进程环境，没有修改机器执行策略。PDF/DOCX TEMP fixture 通过仓库 `npm run fixtures` 准备；实际包检查首次19/21暴露缺 fixture，准备后完整26/26，没有改断言。[准备记录](final-remediation-evidence/fixtures.log)。

**权限 skip 不计入成功断言数**：Collab store/candidate adoption/日志/冒烟中符号链接权限相关分支未验证；`session-revert-inplace` 有2项非空 SACL 跳过；SACL witness 与 object witness 各8项未验证，后者仍 `productionQualified:false`。这次 npm 退出0不增加这些研究路径的生产资格。[完整日志](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/canonical.log) 保留原原因；筛选日志含测试文案中的“skip”，不当作可直接相加的总数。

### 定向与真实 Electron

| 实际命令 | 结果 / 有效范围 |
| --- | --- |
| [32个原定向入口](final-remediation-evidence/directed-tests.json) | 全部退出0；包括 provider-auth105/105、稳定会话排序41、ui-ia27/27、settings16、viz-ui68；primitives记录5组而非虚构统一断言数 |
| `node tests/clipboard-preservation.cjs` | 8/8；真实 helper 的安全限额、多格式、失败 finally，未直接触碰系统剪贴板 |
| `node tests/final-remediation-electron.cjs` | **126/126**；C/D/E/F原场景及新增修复矩阵，82张 renderer +8张原生整窗图 |
| `node tests/browser-workbench-electron.cjs` | **66/66**；正常 sandbox，实际 WebContentsView/本机网页/双 Runtime/关闭释放，21张图 |
| `node tests/ui4-pane.cjs` | **282/282**，原280+新增2；35图在原 TEMP 证据目录，结果与失败轨迹归档 |
| `node tests/ui3-integration-electron.cjs` | **243/243**，failed=0、skipped=0；宽窄、主题、侧栏、菜单、原生边界、键盘与 reduced-motion |
| [补充欢迎布局探针](final-remediation-evidence/probes/welcome-fixture.cjs.md) | **38/38**（基础26+新增12）：Ready/NoProject/Restore × 深浅 × 1205×803及最小700×600，130%字号；12张补充图，正文/CTA不被Composer遮挡。布局设置经现有入口handler，不替代综合专项的可信键盘/点击证明 |
| [补充设置交互探针](final-remediation-evidence/probes/settings-native-fixture.cjs.md) | **31/31**（基础26+新增5）：Down只进首项、Up回输入、过滤后Down、Escape、缺Base URL拒绝；首个keydown明确记录 `isTrusted:true` |
| `npm run build:app -- --rebuild --output-root <本轮TEMP>/rebuilt` | 退出0；指定既有可信 Electron44.4.3缓存 zip，未下载依赖/运行时；包约329.3MiB，exe约234.9MiB |
| `node tests/app-check.cjs --output-root <本轮TEMP>/rebuilt` | fixture准备后 **26/26**；实际内嵌后端、资源、上传目录及无项目拒绝 |
| [实际打包 GUI 探针](final-remediation-evidence/probes/packaged-gui.cjs.md) | **19/19**；实际 `Pi GUI.exe` 启动生产 main/preload/server/public，TEMP假Pi，实际按钮交互、8张 renderer+1张原生整窗，正常退出0 |

App 包内154个受版本控制前端文件与当前源码全部 SHA-256 相等；[逐文件记录](final-remediation-evidence/packaged/asset-hashes.json)。离线zip中原始Electron exe与已安装测试运行时字节相等，[缓存验证](final-remediation-evidence/build-verification.json)；打包时元数据/图标重写后的实际 exe SHA-256 为 `0f1a6ab8608b8db6c82bf495575ecf63ffd6ef632e61f8f90e92afd84cb4a87a`。[包运行结果](final-remediation-evidence/packaged/results.json)。这层确实启动打包 GUI，不用 RUN_AS_NODE 后端或源码窗口代替它。

可运行产物：`C:/Users/21022/AppData/Local/Temp/pi-gui-final-fix-c41a320354784136ac00435c9373432e/rebuilt/dist-app/Pi GUI-win32-x64/Pi GUI.exe`。这是本轮隔离构建，未安装或覆盖用户当前安装包；TEMP可能被系统清理。

### 失败没有被抹掉

- R1首轮捕获出现一次 `UnknownVizError`；未改生产的重跑能完成，原日志保留，根因未证实，不能据此声称已修复 GPU/环境问题。
- 旧ui4先246/280；修订旧尺寸/入口/标题/焦点契约后280/280。新增空态后两次281/282的拖拽失败保留；[轨迹](final-remediation-evidence/ui4-input-trace.json) 证明 CDP 终点之后插入额外 OS mousemove，修改专项可信 move/release 排队后282/282，未改生产宽度或删除断言。
- 新 fixture 的诊断按钮等待/滚动、键盘 Enter char、合法颜色解析、模块路径、Clipboard44 API等编写错误先后修正；未将这些失败算作产品通过。最终126/126同时验证有效业务提交与无写取消。
- Browser 专项旧重开循环默认空页附着，改为先验证应用空态、再实际导航；正常66/66保留原所有权和安全检查。
- 实际包的首次 CDP `Browser.getWindowForTarget` 在 Electron 不支持；改用已验证 PID 的原生窗口设置。屏幕覆盖检测拒绝保存时没有当作成功；最终使用[原生 PrintWindow](final-remediation-evidence/probes/native-print.ps1.md)，验证 HWND/PID、可见性及非单色真实图，已人工打开核对原生按钮。未拼接/修饰像素。PowerShell进度CLIXML警告仍留原日志，不冒充产品异常或隐藏首次失败。
- 补充欢迎探针首次25/26停在 `document.hasFocus()` 的自动化前台条件；原日志保留。补充场景改为经现有入口handler设置布局，再采真实窗口矩形，最终38/38；没有将这12项称为新增的可信键盘焦点测试。
- 补充设置首轮可信键盘30/30；加入表单检查时未清除保留的MCP搜索条件，29/30停在夹具入口。清除过滤后31/31，原生产搜索状态保留行为没有修改。

新分支没有推送，故**没有本轮 PR/main CI**。原 main 的8/8不替代本轮本地证明，也不替代将来发布提交的精确 SHA CI。

## 5. 24 图视觉复核矩阵

全部继续使用原审计固定文件名/摘要和固定源码映射；下列图均来自最终生产输入的新运行。主要条件为1205×803 CSS目标 / DPR1.5，窄窗700×600；Windows取整时记录 `innerWidth=1206` 或包内 `1206×804`，PNG为1808×1205等实际像素，**不拉伸/补边伪装相同尺度**。[逐图尺寸/摘要](final-remediation-evidence/image-manifest.json)。

“结构对齐”只代表列明的参数和布局，不是逐像素全同。“业务差异”与“未实现”不混用为通过。浅色缺原始图的页面按固定源码语义及实际计算样式对照。

| 原图 | 最终实图 | 对比结果 / 保留边界 |
| --- | --- | --- |
| REF-001 欢迎展开 | [01](final-remediation-evidence/electron/01-dark-expanded.png) | 275px侧栏、46px连续顶栏、100px居中hero与28px标题对齐；保留π品牌和真实欢迎文案，没有伪造参考 onboarding |
| REF-002 折叠 | [02](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/02-dark-collapsed.png) | 侧栏0宽、12px恢复入口、内容自适应；无参考侧栏动画属既有实现差异 |
| REF-003 工具区 | [e01](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/e01-launcher-dark-native.png) | 392px dock、46px工具带、40px条目/18px图标；固定工具而非多标签扩展，业务差异 |
| REF-004 常规 | [10](final-remediation-evidence/electron/10-settings-appearance-dark.png)、[130%](final-remediation-evidence/electron/r09-appearance-130-narrow-light.png) | 独立tile、组溶入页面、40/48px横向边界与复合控件换行已达；本项目既有30px设置标题、46px页头后20px内距保留，参考28px标题/8px顶部间距存在细微差异，不宣称像素全同 |
| REF-005 AI | [配置](final-remediation-evidence/electron/r02-provider-add-dark.png) | 没有独立参考AI偏好页；现有真实模型/认证功能分别位于供应商、认证和Composer，不新增假设置 |
| REF-006 语音 | — | 未实现/排除项，无业务owner；没有伪页 |
| REF-007 快捷键 | [shortcuts](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/r11-settings-shortcuts-dark.png) | 标题/页面边界一致，保留本项目真实按键，未造参考重绑定能力 |
| REF-008 Skills | [skills](final-remediation-evidence/electron/r11-settings-skills-dark.png) | 设置页标题/tabs/边界统一；保留既有列表+详情、信任闸门与作用域过滤，未改成参考全宽开关卡片。这是有状态/操作依据的业务布局差异，不能称参考原样复制 |
| REF-009 技能市场 | — | 未实现/排除项；Skills管理不是市场 |
| REF-010 MCP | [mcp](final-remediation-evidence/electron/r11-settings-mcp-dark.png)、[实际包浅色](final-remediation-evidence/packaged/p06-mcp-light.png) | 当前项/标题正确，页面边界一致；原生MCP来源、状态与显式动作保留，不增加参考市场/代理协议 |
| REF-011 子智能体声明 | [capabilities](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/r11-settings-capabilities-dark.png)仅相关 | 能力状态有正确标题和当前项；独立声明管理器仍排除，unknown保留，不把相关页当等价实现 |
| REF-012 信息/更新 | [updates](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/r11-settings-updates-dark.png) | 页面层级统一、动作可达；Pi与GUI更新两个owner仍独立。离线fixture的 unavailable 不等于远端更新已验证 |
| REF-013 服务选择 | [Add](final-remediation-evidence/electron/r02-provider-add-dark.png) | 两条入口统一现有preset表单，不是参考四列市场；真实认证在认证页，[auth](final-remediation-evidence/electron/r11-settings-auth-dark.png) |
| REF-014 服务配置 | [实际包](final-remediation-evidence/packaged/p05-provider-form-light.png) | Save/Cancel可见且有效，单列表单与环境变量引用属真实能力/安全差异；没有新增模型拖拽双栏 |
| REF-015 模型/思考 | [d04](final-remediation-evidence/electron/d04-model-picker-dark.png)、[d14](final-remediation-evidence/electron/d14-runtime-model-dark.png) | 搜索分组/表面保留，Classic/Runtime既有真实档位与可用性通过；独立思考菜单区别于参考滑块 |
| REF-016 运行/Thinking | [d03](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/d03-thinking-expanded.png)、[d07](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/d07-streaming-dark.png) | 14px正文、22.4行高及Thinking/Stop正确；未虚构耗时瀑布 |
| REF-017 完成/操作 | [d01](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/d01-dark-completed.png)、[d02](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/d02-user-actions.png) | 复制生产原文、历史和Runtime行为保留；角色行/工具时间线与参考不同，编辑/删除/重生成仍未实现 |
| REF-018 Browser | [空态](final-remediation-evidence/electron/r08-browser-empty-light.png)、[本机网页](final-remediation-evidence/browser/01-browser-single-native-page.png) | 自有空页随主题、明确引导；实际网页保持自身主题，原生矩形/焦点/销毁通过。Agent行是合理业务差异 |
| REF-019 Files | [Specs](final-remediation-evidence/electron/e02-specs-dark.png)、[Changes](final-remediation-evidence/electron/e04-changes-dark.png) | 只读Specs上下布局/Changes真实审阅保留；任意文件CRUD与左右Files树排除，未为视觉增加写能力 |
| REF-020 项目菜单 | [项目](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/04-project-context-menu.png)、[会话](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/05-session-context-menu.png) | 原单一菜单系统、14px表面/10px条目/8px碰撞边界保留；长列表标题固定；业务条目不同 |
| REF-021 浅色对话 | [f01](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/f01-conversation-light-native.png) | #f3f3f3侧栏/#fff画布、760px Composer、14px正文保持；角色、首条顶距和业务按钮保留，非全像素一致 |
| REF-022 Slash | [f02](final-remediation-evidence/electron/f02-slash-light.png)、[窄窗](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/f10-slash-narrow-light.png) | 已对齐外Composer，分组标题/键盘提示有据；候选按原注册表顺序，分组标签和命令内容不伪装成参考命令集 |
| REF-023 用量 | [f03](final-remediation-evidence/electron/f03-context-light.png)、[unknown](final-remediation-evidence/electron/f04-context-unknown-light.png) | 376px/14px/16px对齐，已知/unknown/警告保留；没有原始计时数据的字段继续省略 |
| REF-024 @文件 | [f05](final-remediation-evidence/electron/f05-at-draft-light.png)、[附件](https://github.com/HYJ1817/pi-gui/blob/ff6f22e26caae540cd050cbcd89c78f84c1e05cb/docs/ui/final-remediation-evidence/electron/f06-attachment-light.png) | **仍未实现文件提及补全**；附件不是补全。单独产品决策，未纳入本轮Bug修复 |

上述差异明确存在；本轮没有声称24张全都“通过”，也没有把不适用的参考功能当Bug补伪UI。若产品验收要求消除保留的30px标题、两栏Skills、命令分组差异，应明确改变当前边界后另行实施，不能追溯抹掉这些说明。

## 6. 维护性、状态与安全复核

- **状态所有权**：未改项目/会话列表排序、展开存储或Runtime执行，导航只投影当前tab；右侧pane及 Browser native controller仍唯一。blank遮挡由已接收 url 与既有pane遮挡派生，解绑时清空局部投影，导航后要求新bounds。
- **写入边界**：供应商保存继续走原校验与API wrapper，没有内联新持久化；空态Add仅委托既有按钮。Git审阅/撤销、Worktree、Pi RPC及真实API key存储均未改；原安全套件在canonical覆盖。
- **CSS**：移除实际重复的外壳规则而非叠加important；welcome唯一展示责任收敛到ui4-feedback；资源页/项目sticky/Browser引导限定组件作用域。按相同字面口径统计根目录CSS `!important` 从57降至45，[清单](final-remediation-evidence/css-final.json)；45不等于45个Bug，也未宣称全仓优先级债务消失。
- **兼容层**：Detail仍借既有modal-card承载业务表单，但动作不再被通用规则抹掉；保留的hidden、焦点、Markdown及旧modal归一化需要按实际引用理解，未为形式整洁大规模重写。
- **监听/异步**：没有新增全局监听；Extensions原dispose、Browser原取消订阅保留。Clipboard helper只为专项，一次快照一次恢复，不保存正文；超限在任何测试写入前拒绝。
- **性能**：没有新Observer、全局扫描循环、动画系统或依赖。tooltip仅在实际hover/focus读取目标与tip矩形；菜单分组在已有paint中生成。未取得长时间内存/CPU资格，不从短程通过推断长期稳定。
- **文件规模例外**：既有超过1000行的 `public/extensions.js` 本轮只在原render入口增加标题/当前项投影；其内各tab仍持有原状态及dispose，不为少量展示修复拆迁业务owner。现有 `public/viz-chart.js` 等超过500行模块也只改相关tooltip分支；后续拆分须有独立职责收益，本次没有借收尾扩大重构。

## 7. 未验证资格与结束判断

1. 作者外隔离审查、用户人工验收未取得；本轮没有使用子代理，也不称取得独立批准。
2. Windows真实OS中文IME、跨平台原生窗口手工操作、长时间多会话真实模型负载、完整Collab人工流程仍未验证；composition语义、假Pi/离线并行与输入专项有各自证据。
3. 真实Provider登录/联网额度、远端更新下载/安装升级、真实模型没有执行。本轮修复不改变这些边界，也不借fixture宣称验证成功。
4. 权限受限的symlink/SACL/Object witness项目仍准确未验，不提升研究性文件恢复的生产资格。
5. 一次UnknownVizError的环境根因未明；保留原失败与后续通过，不能将它归零为“从未发生”。
6. 新分支精确SHA CI、合并后的main CI、安装包/签名/升级资格需按原流程取得；没有推送、PR、合并或发布。

**本轮实施可交付独立验收。原14项修复与7项历史清算已完成，无本轮已确认的未处理核心功能阻断；UI主要修复路径有定向、单次完整canonical、真实Electron及实际打包GUI证据。** 不再安排一轮无边界的“全局收尾”来掩盖这些已知问题；下一步是审阅本次diff和明确保留的业务差异，然后按授权取得CI。正式结束A–F和进入正式发版测试仍由独立验收及项目发布门槛决定。

## 8. 文件与回滚

生产14文件：`public/app-shell.css`、`browser-pane.js`、`extensions.js`、`providers.js`、`styles.css`、`ui/inline-command-menu.js`、`ui/popover.js`、`ui/settings-surface.js`、`ui/workspace-surface.js`、`ui3-inline-commands.css`、`ui3-model.css`、`ui4-feedback.css`、`viz-chart.js`、`viz.css`。

生产模块定向回归：`tests/settings-acceptance.cjs`、`ui-ia.cjs`、`ui3-inline-commands.cjs`、`viz-ui.cjs`、`browser-workbench-ui.cjs`。桌面与隔离基建：`app-shell-electron.cjs`、`browser-workbench-electron.cjs`、`ui4-pane.cjs`、`fixtures/theme-convergence-scenarios.cjs`、`fixtures/workbench-scenarios.cjs`、新增 `final-remediation-electron.cjs`、`fixtures/final-remediation-scenarios.cjs`、`fixtures/preserve-clipboard.cjs`、`clipboard-preservation.cjs`，以及package中的专项alias/8项clipboard canonical入口。

本地生产/定向回归提交为 `520d7d77d7b58cb1c636eba9c35ed4c377b55758`；桌面测试基建提交为 `058a8e0c7acb9c15c69c014fe20bd74b5b421e02`，与[最终代码摘要](final-remediation-evidence/final-code-state.json)绑定；文档证据另提交。没有版本、锁文件、workflow、后端或RPC变更。回滚时先撤对应文档/测试基建，再撤生产修复；如撤生产需同时撤其对应回归并重新构建，不能只恢复隐藏Save按钮的旧CSS而保留“已修复”结论。
