> 2026-11-06 第二轮瘦身：本页移除的历史截图/完整日志链接固定到清理前提交 `2e70463183218ddf3a10972789667d6be5c294df`；原始结果和失败记录保留，不能作为当前代码通过证明。

# 阶段 C 实施与视觉验收记录

## 交付身份与范围

基线 `6036ceb9d5303eb9653f39b9c54a4c9405a3a815`；分支 `codex/pi-desktop-phase-c`。开始时工作区干净，fetch 后 main 与本地一致。准确基线的完整 CI 为 [41592806846](https://github.com/HYJ1817/pi-gui/actions/runs/41592806846)，push、attempt 4、CI gate success；它只证明基线。

本次实现主外壳、顶栏项目/会话层级、项目与会话行、侧栏折叠与共用菜单入口。没有改变 Pi RPC、后端执行、会话排序、Runtime Registry 或磁盘数据格式。没有新增依赖、框架或网络能力。D/E/F 未提前实施，欢迎区、消息、Composer 和工作台内部保留现状。

生产改动提交：`5b1f954e0e3a37bf8a39e81c3f6f40bc40b4ecf6`；既有后台 Electron 测试修正提交：`5fcdc6681407a5b6917b1e613e0c11a39e89b3ff`。验证覆盖这两次提交的相同文件内容（在提交前按最终工作区运行，提交后通过源码摘要再次核对）。

最终交付 SHA 以包含本报告的本地交付提交为准，可运行 `git log -1 --format=%H -- docs/ui/pi-desktop-reference/13-phase-c-acceptance.md` 定位；最终消息另列实测 SHA。本轮不推送、不合并、不发版，用户验收尚未作出。

## 文件与责任边界

| 文件 | 本次用途 |
| --- | --- |
| `public/app-shell.css` | 集中侧栏、折叠恢复、标题层级、会话动作簇与窄窗几何；不新增 `!important` |
| `public/styles.css` | 删除被替代的 P14/P30 侧栏覆盖；唯一动作菜单改用既有 ds 令牌与视口高度限制 |
| `public/index.html` | 复用导航 ID，新增展示性项目层级和已有新建/搜索的顶栏入口；底部连接状态并入工具带 |
| `public/app.js` | 原折叠函数增加外壳 class；顶栏按钮委托原导航 handler |
| `public/shell.js` | Classic/Runtime 标题与所属项目的派生投影，无独立可编辑业务 store |
| `public/runtime-conversation.js` | 原 `onTitle` 回调同时传当前 record 的 `workspace.cwd`，防止后台 Classic cwd 污染顶栏 |
| `public/projects.js` | 渲染项目路径供名称投影；右键调用原三点菜单；渲染完成同步项目显示 |
| `public/sessions.js` | 右键调用同一菜单；经典运行点读取已有 `pi-gui:classic-activity` 事件 |
| `public/tokens.css`、`electron/theme.cjs` | 仅对齐原标题栏桥接颜色与原生 overlay 为深色 `#181818` / 浅色 `#ffffff` |
| `tests/app-shell.cjs` | 真实模块图的标题归属、迟到 Classic 更新、返回、无项目和安全文本投影 |
| `tests/app-shell-electron.cjs` | 生产渲染器、preload、theme 与离线 API fixture；正常沙箱、真实输入、几何、截图和原生窗口捕获 |
| `tests/sidebar-menu.cjs` | 原静态样式守卫同时读取实际加载的两份生产样式表，37 项保留 |
| `tests/session-background-electron.cjs` | 修正历史失效停止按钮定位，fixture 改到 os.tmpdir；不改断言语义 |
| `package.json` | 新增 shell 单元测试到 canonical；注册真实 Electron 专项入口 |

`app.js`、`styles.css`、`runtime-conversation.js`、`projects.js`、`sessions.js` 均为已有大型文件，本次只调整其既有职责，没有借机拆业务状态。新增 CSS 是唯一阶段 C 外壳消费层，A/B 原语和设置内容表单没有重写。

## 源码证据与逐区域差异

参考仓库本地 HEAD 已确认为 `92ae661f1e399e69d514086b46029b4c34ba1a92`。以下路径均相对该版本的 `apps/desktop/src/`，参数来自真实源码，截图来自原始目录；没有复制参考组件或样式文件。

| 区域 / 原图 | 参考实现与参数 | 原 pi-GUI 差异 | 修改位置与实际结果 | 判定 |
| --- | --- | --- | --- | --- |
| 外壳 / REF-001、002、021 | `features/app/AppShell.tsx:153,201,364`、`styles/chrome.css:282,512`；275px 侧栏、46px 顶栏、主区 flex | 展开侧栏仍消费旧宽度；折叠有独立 48px 竖轨 | `app-shell.css`、`app.js`：展开实测 275px，折叠 `workspace.x=0`，恢复按钮只占顶部；两态顶栏均 46px | 已达到本阶段参考几何 |
| 连续顶栏 / REF-001、002 | `ConversationTopbar.tsx`、`chrome.css:571,588,618,738,787`；项目 11px、会话 12.5px、6px 间距、28px 图标座及 12px 控件圆角，无底线 | 单一标题，没有所属项目层级；旧原生 overlay 深浅背景异于主画布 | `index.html`、`shell.js`、`theme.cjs`：文件夹/项目/分隔符/标题分层，原生及页面背景一致；顶栏右侧至少避让 138px | 已达到层级、背景、间距；保留业务按钮差异 |
| 项目导航 / REF-001、020、021 | `Sidebar.tsx:2312`、`sidebar-threads.css`、`sessions.css:1120`；28px 项目头、12px 文件夹、4px 当前项目点 | 文件夹被旧 CSS 隐藏；项目 margin-top 10px；绝对定位折叠箭头 | `app-shell.css`、`projects.js`：文件夹恢复，箭头在行内，项目头实测 28px，取消每项目额外上边距 | 已达到密度与层级 |
| 会话导航 / REF-016、020、021 | `sidebar-threads.css:6,33,95`；28px 行、13px 标题、18px 行高、10px 行圆角、悬停/选中语义底色 | 旧 30/36px 覆盖交错；运行中的经典会话无可见点 | `app-shell.css`、`sessions.js`：实际行高 28px；Classic 事件与 Runtime store 各保留原来源，运行点 `rgb(255,133,73)`，结束清除，不排序 | 已达到行节奏与反馈；保留明确的 Runtime 状态文字 |
| 动作菜单 / REF-020 | `ContextMenu.tsx`、`SidebarMenuPanel.tsx`、`styles/ui-kit.css:255`；min-width 184px、5px padding、约 32px 行、14px 外框/10px 菜单行圆角、实底、细边与下沉阴影 | 已有一套功能完整菜单，缺少行上右键入口 | 原 `ui/action-menu.js` 不替换；`projects.js`、`sessions.js` 右键委托三点；`styles.css` 采用 ds 表面/阴影；截图中实际宽 184px、视口内定位、Escape 归还焦点 | 已达到容器与入口；菜单项按真实能力保留 |
| 底部工具带 / REF-001、021 | `theme-overrides.css:110`；透明单行底带，28px 左右控件与右端状态 | 设置文字行、主题按钮和连接页脚分成两层 | `index.html`、`app-shell.css`：设置/外观图标与连接状态同带；上下文仍可展开 | 合理业务差异：不伪造定时任务/通知/版本快捷键 |
| 设置 A/B / REF-004、007、021 | 原 A/B 已验收 275px 分类轨与卡片流 | 原有独立 settings surface 生命周期 | CSS 排除 settings-mode 的主侧栏背景/宽度；设置品牌尺寸恢复原值；真实截图标题在 y≥46，轨宽 275px，旧表单仍工作 | 回归通过，不重做设置内容 |

参考的顶栏内联重命名可以作用于更广泛的本地会话；pi-GUI 的经典重命名仅允许当前会话、Runtime 还有各自 owner 边界，所以继续使用已有侧栏编辑器。本轮没有为视觉还原增加不安全的第二套改名路径。

## 真实 Electron 截图与尺度校准

命令：`npm run test:shell:electron`。最终运行 **26/26，0 失败**；Electron **44.4.3**、Windows、zoom=1、`devicePixelRatio=1.5`、`sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`。API 数据是本地 fixture，所有项目/配置/profile 写入路径在 `os.tmpdir()`；没有调用真实 Pi/模型或写用户项目。

原参考为 1808×1204/1205 物理像素。本轮常规 CSS 视口实测约 1205–1206×803，渲染截图 1808–1809×1205；原生整窗截图 1810×1205，窄窗为 CSS 700×650 / 物理 1050×975。Windows DPI/边框取整带来 1–2 个物理像素差异，没有拉伸图像掩盖差异。比较以 CSS 几何和 1.5 DPR 为主，不能把两种捕获范围直接按整图像素判同。

渲染截图由真实 `webContents.capturePage()` 采集；原生截图由 `desktopCapturer` 精确匹配**本 fixture 窗口**的 `mediaSourceId`，未保存其他窗口、未合成像素。普通渲染截图不包含原生按钮，两类证据分开。

| 场景 | 实际截图 | 对照及目视结论 |
| --- | --- | --- |
| 深色展开 | [01 渲染](../screenshots/phase-c/01-dark-expanded.png)、[原生整窗](../screenshots/phase-c/01-dark-expanded-native.png) | REF-001：侧栏/主区比例、连续顶栏、项目位置接近；原生三键均可见且避让。欢迎正文与 Composer 属 D，保持旧布局 |
| 深色折叠 | [02](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/02-dark-collapsed.png) | REF-002：无残留全高 rail，标题左侧恢复按钮；主区自适应全宽 |
| 项目与会话展开 | [03](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/03-project-sessions.png) | REF-020/021：项目树层级、28px 行、选中与截断可辨；保留归档折叠入口 |
| 项目菜单 | [04](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/04-project-context-menu.png) | REF-020：实底细边菜单、不被侧栏裁切，危险项文字红色；条目为工作区管理/项目设置/移除，没有假功能 |
| 会话菜单 | [05](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/05-session-context-menu.png) | REF-020：共用同一菜单；当前会话归档/删除受限并说明原因，键盘关闭归还焦点 |
| 正在运行 | [06](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/06-running.png) | REF-016：真实活动事件驱动橙点与文字；没有无依据动画；任务结束后清除 |
| 浅色展开 | [07 渲染](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/07-light-expanded.png)、[原生整窗](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/07-light-expanded-native.png) | REF-021：#f3f3f3 侧栏、#fff 主区、语义文字/状态反转正常；原生标题栏同色 |
| 窄窗 | [08](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/08-narrow-light.png) | CSS 700×650：侧栏 240px，标题截断，四个真实顶栏动作仍在原生按钮左侧，文档无横向溢出；该尺寸无原始参考图，不宣称像素对照通过 |
| A/B 设置 | [09 总览](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/09-settings-overview-dark.png)、[10 外观深色](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/10-settings-appearance-dark.png)、[11 供应商](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/11-settings-providers-dark.png)、[12 外观浅色](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/12-settings-appearance-light.png) | REF-004/007/021及 A/B 基线：分类轨、标题、卡片未被 C 外壳覆盖；表单与返回导航正常。供应商非空态对照 A/B 已验收基线；REF-008 实为技能列表，不将其当作供应商逐图证明 |
| 关联任务压力 | [13](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/13-linked-tasks-dark.png) | pi-GUI 特有业务差异：长任务条受 45% 宽度约束，标题仍≥80px，没有与右侧动作重叠 |
| 长会话列表滚动 | [14](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/docs/ui/screenshots/phase-c/14-sidebar-scroll-dark.png) | 真实生产列表加 28 条 fixture 后可独立滚动；底部工具带与顶栏位置不动，没有文档横向滚动 |

机器实测记录见 [results.json](../screenshots/phase-c/results.json)，原图 pHYs 元数据约 143.993 DPI，核对记录见 [reference-calibration.json](../screenshots/phase-c/reference-calibration.json)，与规范给出的 1.5 DPR 校准一致。已逐张查看上述图片；截图存在本身不等于符合参考，结论按表逐项给出。

本阶段已达到：外壳比例、连续顶栏、标题层级、行节奏、深浅背景、折叠几何、菜单表面和真实状态反馈。

合理业务差异：原生 Windows 三键占 138px（参考自行绘制控制簇约 120px）、保留 More/工作面板、归档/上下文/连接状态，以及受限菜单项。项目识别提升至顶栏，底部只保留连接信息，不重复项目名称。

仍存在的非阻断视觉差异：图标沿用 pi-GUI 的自绘路径，局部笔形及新对话行的图标与参考不逐像素一致；长列表滚动时“项目”分组头仍随树滚动，参考将该标签放在项目滚动区外。折叠沿用原显隐切换，没有移植参考的宽度动效或新增侧栏拖拽调宽。会话操作、底部工具带和窗口顶栏均保持可达，未将这些差异记为完全还原。

尚未验证：macOS/Linux 原生外壳、真实模型长时间负载、人工拖动/双击原生标题栏及三键的手动点击、安装升级。未发现本轮外壳的已知视觉阻断问题。欢迎区、消息与 Composer 的旧视觉差距是明确未实施的 D 范围；A/B 外层卡片差异沿用其收尾记录，不在本轮重新宣布全界面像素一致。

## 功能回归与自动化证据

原始日志目录：本机 `%TEMP%/pi-gui-phase-c-evidence/`，已复制到 `C:/pi-GUI/.shots/phase-c-validation-d7j_iaqa`。完整命令序列、起止时间、退出码与日志摘要见 [canonical-results.json](../screenshots/phase-c/canonical-results.json)。定向数字为实际运行输出，不沿用 A/B 旧报告：

| 命令 / 范围 | 结果 |
| --- | --- |
| `node tests/app-shell.cjs` | 10/10；修改前 3/10、7 项失败，修改后 10/10 |
| `node tests/sidebar-menu.cjs` | 37/37；所有原断言保留 |
| `node tests/stable-session-order.cjs` | 41/41；点击不重排 |
| `node tests/session-background-ui.cjs` | 9/9；后台 Classic 保留，Runtime 导航不串 owner |
| `node tests/runtime-nav.cjs` | 38/38 |
| `node tests/runtime-conversation.cjs` | 106/106 |
| `node tests/ui-ia.cjs` | 26/26 |
| `node tests/theme.cjs` | 47/47 |
| `node tests/settings-acceptance.cjs` | 15/15 |
| `node tests/primitives.cjs` | 退出 0，原脚本未输出断言总数，不人为编造 |
| `node tests/ui2-visual.cjs` | 57/57，真实浏览器原视觉回归 |
| `node tests/smoke.cjs` | 1338/1338；包括原项目/会话改名、归档、删除、确认等生产点击链 |
| `node tests/dev-server.cjs` | 30/30；包含标题栏令牌/原生调色板一致性 |
| `npm run test:settings:electron` | 退出 0；设置标题、46px 拖拽区与隐藏会话工具项检查通过，原脚本未输出断言总数 |
| `npm run test:shell:electron` | 26/26，14 张渲染截图 + 2 张原生整窗截图，正常沙箱；包含折叠恢复按钮显式 no-drag |
| `node tests/session-background-electron.cjs` | 16/16；独立专项沿用其 `--no-sandbox` 启动，不能替代上方正常沙箱证明；A/B 往返、同时 RA/RB、Stop/审批归属、切项目、真实 reload 恢复均通过 |
| 本地完整 canonical | **234/234 条叶命令累计验证完成**：首次 `npm test` 成功前缀 106 条，在第 107 条因 Windows fixture 启动策略退出 1；同一 canonical 清单从第 107 条续跑 128 条均退出 0。不是单次 `npm test` 成功；末次 CSS 以本节专项补证覆盖最终状态 |

会话并行专项图片与记录见 [phase-c-background/report.json](../screenshots/phase-c-background/report.json)。运行中截图的数据来自生产模块的活动事件和 fixture RPC，不调用外部模型；因此证明本地状态隔离与界面行为，不证明真实模型服务资格。

失败与修复历史：

1. 新标题测试首次 3/10，补上正确项目投影后 10/10。
2. 首轮 Electron 会话行测得 29.45px，来源为继承行高；消费既有 `--leading-row` 后实测 28px。最初 rAF 等待在遮挡窗口停住，改为关闭测试窗口后台节流并等待稳定帧；不改产品渲染。
3. 菜单“无请求”断言最初把独立诊断/读取流量也计入；改为核对真正的项目/会话/abort 变更命令，未放宽功能要求。
4. 原生 CopyFromScreen 身份/覆盖守卫拒绝保存，不能计通过；未放松守卫或更改系统执行策略。最终使用精确窗口源的原生 `desktopCapturer` 成功采集，包含三键并已目视检查。
5. 既有后台 Electron 套件首次 9/10，报 `missing #stopRA`；基线源码中停止按钮早已位于 `.rtc-composer-actions`，测试还查旧 `.rtc-controls`。仅修正定位和 tmp fixture 路径后 16/16，断言未删减。
6. 首次打包摘要探针假设副本仍在 `electron/theme.cjs`，得到 9/10；核对现有构建映射后确认实际文件为产物根部 `theme.cjs`。修正探针路径后 10/10 一致，没有为此修改打包脚本或重复构建。
7. 完整入口首次停在 `session-revert-sacl-witness.cjs`，原生辅助脚本没有启动、输出 `witness_unavailable`。直接探针确认 Windows 拒绝未签名脚本；仅给测试子进程设置 `PSExecutionPolicyPreference=Bypass` 后，真实结果为 `auditEnabled:false,auditError:1300`。没有修改系统/用户执行策略、授予权限、跳过命令或改产品。参照仓库既有 [同机环境记录](../../remaining-review-fixes-20261019.md)，按测试政策从失败处续跑同一 canonical 清单，完整结果单列为累计验证；两个审计 witness 各有 8 个未验证用例，共 16 个，不计通过断言。对象 writer 19/19、faults 45/45；其他套件自身标注的 skip 亦保留在原始日志中，不汇成虚假的全仓断言总数。
8. 最终拖拽边界检查发现折叠恢复按钮覆盖 `.stage-head`，却不在该 DOM 下，原 `.stage-head button` 的 no-drag 规则没有覆盖它。新增真实 computed-style 断言后为 23/24（region=none）；只补一条 `-webkit-app-region:no-drag` 后 24/24。随后补跑 UI2 视觉 57/57、设置 Electron、dev-server 30/30、file-size-report 并重建最终产物。既有业务 JS、权限、协议均未变化；完整 canonical 的未受影响部分与这些最终状态检查合并为累计证明，不冒称一次不可变状态的 `npm test` 全绿。前后摘要与补验证据见 [validated-source-sha256.json](../screenshots/phase-c/validated-source-sha256.json)。
9. 固定源码圆角别名复核发现行圆角与菜单圆角仍沿用了较小数值；新增断言在修改前为 24/26（两项失败）。采用 A 阶段已有 `--radius-sm=10px`、`--radius-md=12px`、`--radius-md-plus=14px`，并将顶栏动作簇改用源码证实的 `--ds-tile`、图标采用 `--ds-text-secondary` 后 26/26。最终再次补跑菜单 37/37、UI2 视觉 57/57、设置 Electron、dev-server 30/30、file-size-report 并重建交付产物；业务代码未变化。折叠恢复按钮另按 `chrome.css` 的 12px lead inset 修正，修改前真实记录为 x=8，最终 26/26 包含 x=12 的断言；随后再跑 UI2 视觉并重建当前交付产物。

## 构建、审查与回滚

本地最终执行 `npm run build:app -- --rebuild --output-root C:/pi-GUI/.shots/phase-c-final-app-20261104` 成功。使用本机 Electron 44.4.3 缓存 ZIP，未下载依赖；缓存内 `electron.exe` 与安装的运行时 SHA-256 同为 `bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`。独立输出避免覆盖正在使用的安装版。

可运行产物：`C:/pi-GUI/.shots/phase-c-final-app-20261104/dist-app/Pi GUI-win32-x64/Pi GUI.exe`。构建输出入口 234.9 MB、整包 329.3 MB；抽查全部 10 个本轮生产文件与打包副本字节摘要一致，见 [build-verification.json](../screenshots/phase-c/build-verification.json)。这证明重建及资源一致，不代替安装升级或打包后真实业务资格。

本轮早期的三个独立构建目录保留：可选清理被自动审批审核按策略拒绝（工具仅返回 `blocked by policy`）。最终交付以本节的 `phase-c-final-app-20261104` 为准。

独立 Agent 首轮只读审查结论：中风险、有条件通过，Blocker 0 / Important 0 / Nit 0 / Pre-existing 0；独立运行 shell 10/10、menu 37/37、Runtime conversation 106/106、stable order 41/41，合计 194/194。第二轮增量复审确认后台 Electron 定位修正合理、未删断言；第三轮只检查恢复按钮 no-drag 与对应真实 Electron 断言，新增发现 0。三轮已经收敛。最后的参考圆角别名、控件文字与动作簇表面对齐属于无状态的 CSS 参数修正，由作者按固定源码再核对并以 26/26 Electron、37/37 菜单、57/57 既有视觉及设置回归补证；未增加第四轮自动审查循环。独立审查没有替代本任务的截图、全量测试或用户批准。

回滚：按本地提交回退阶段 C 的生产提交并重建产物即可；测试证据提交可独立保留或回退。本轮不迁移用户数据，不需要数据格式恢复，也没有自动升级已安装版本。用户原来启动的安装版不会自动变成此分支产物。

阶段 D 后续应继续消费同一语义变量和现有会话 owner，处理欢迎区/消息/Composer；不要重新建立标题或菜单状态。E 再处理工作台内部，F 才做全局视觉收尾。本轮没有借取这些阶段的完成结论。

## 交付结论

阶段 C 本地开发及作者功能/视觉验收已完成；完整 canonical 为累计验证 234/234 条命令，最终样式专项 26/26，独立审查未发现可证实的阻断问题。保留上文列出的非阻断视觉差异及未验证环境。用户验收仍待作出，本轮没有推送、合并或发版授权及操作。

## 合并后 CI 跟进（2026-11-04）

上节是最初本地交付时的状态。用户随后授权推送、建立 PR 和合并；[PR #50](https://github.com/HYJ1817/pi-gui/pull/50) 的 [完整 CI](https://github.com/HYJ1817/pi-gui/actions/runs/41818760845) 成功后合并为 `773c1f8157e1bdbfe7328ee79f632ac0954d792d`，未发版。

该 main 提交的 [CI run 41821465381](https://github.com/HYJ1817/pi-gui/actions/runs/41821465381) 尚未通过，不能沿用 PR 成功结论：

- attempt 1、3：`tests/app-update-desktop-regressions.cjs` 的真实助手 `ready` 断言失败。该文件及生产助手均未被阶段 C 修改；测试仅等待约 3 秒，生产调用方已有 15 秒等待上限。日志没有保留助手的终态，因此冷启动耗时是可复现的原因，不能声称已排除所有助手错误。
- attempt 2：core 全部通过，但其余四组仍来自 attempt 1；汇总严格拒绝不同 `runAttempt` 的证据。保留这一守卫，不放宽证据身份要求；修复后必须完整重跑所有 job。
- 定向复现：TEMP 中的 Node preload 只给真实 PowerShell 助手启动增加 3.5 秒延迟；修改前同一 `ready` 断言失败，修改后 1/1 通过，约 4.96 秒。注入提前退出 42 时仍在约 0.52 秒失败并显示退出码，未等待满上限或伪造就绪；预期失败不计通过。诊断注入未加入生产代码或 canonical 测试清单。
- 修复只将此测试的就绪等待对齐 15 秒，增加助手退出/信号检测；原有取消后 2 秒退出、父进程存活、无备份及 `cancelled` 结果断言全部保留。未改变更新、安装、UI、权限、工作流或依赖，无须重建未变化的生产产物。
- 本地 `npm run test:app-update`：七个生产模块测试套件共 43/43、0 跳过；`node tests/ci-summary.cjs`：30/30。独立增量审查：Blocker 0 / Important 0 / Nit 0，独立重跑助手回归 6/6，`git diff --check` 通过。
- 修复提交的完整远端 CI 尚待验证；本节不将定向测试、旧 PR 或跨 attempt 累计结果写成当前 main CI 成功。
