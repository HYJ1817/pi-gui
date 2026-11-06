# PI-Desktop UI 重构 A–F 最终审计

审计日期：2026-11-06。结论：**不通过，不满足正式结束 UI 重构的标准，不建议以当前代码进入正式发版测试。**

已确认问题 **P0 0 / P1 1 / P2 9 / P3 4，共 14 项**。其中有实际使用缺陷：添加供应商的主要入口没有可见的保存按钮，设置搜索键盘导航跳项，部分设置导航状态错误，窄窗文字挤压，以及图表的浅色与键盘提示问题。历史记录中仍需处理的收尾条目为 **7 项**（L01–L07）；排除功能和未验证资格另列，不混进这个数字。

## 1. 基线、方法与限制

| 项目 | 独立核对结果 |
| --- | --- |
| 初始工作区 | `C:/pi-GUI`，main，`git status --short` 为空；没有覆盖用户改动 |
| 本地 / 远端 main | fetch 后均为 `326cb3284c5bf67398290ca4cd6ea8bfd5ee8496` |
| 审计分支 | 从该提交创建 `codex/pi-desktop-final-audit`；只添加本文、修复计划和文档证据附件 |
| 固定参考 | `C:/Users/21022/pi-desktop-ref` 的 HEAD 为 `92ae661f1e399e69d514086b46029b4c34ba1a92` |
| 原始图 | `C:/Users/21022/OneDrive/图片/pi-desktop` 的 24 张 PNG，全部逐张打开；[文件名、尺寸、摘要](final-audit-evidence/references.json) |
| 本机 | Windows，Node v24.22.1，Electron 44.4.3；正常 sandbox/contextIsolation，nodeIntegration 关闭 |
| 新运行证据 | 97/97 外壳/对话/工作台/主题检查；64/64 原生 Browser；243/243 输入集成；32 个定向入口；另外运行独立 TEMP 探针 |
| 审计截图 | [118 张真实截图及摘要](final-audit-evidence/image-manifest.json)：73 张综合专项、20 张 Browser、25 张补充探针；截图数量不代表视觉通过 |
| 数据安全 | 项目、上传、profile、主题偏好及 Git fixture 在 TEMP；HTTP 夹具、离线模型投影；没有调用真实 Pi/付费模型，没有写用户项目或配置 |

审计先读取 AGENTS、REVIEW、文档导航、测试政策、代码规范、验收及安全边界，再检索并阅读参考目录 README、01–10 的相关布局/组件/交互章节、11–19 的阶段实施和验收记录、参考 token 表。阶段报告只用于建立问题线索；结论来自最终 main 的源码、增量、重新运行和截图。历史 A/B、C、D、E、F 图按区域抽查，最终判断使用本次新采图。

复现命令、证据分层及本次实际执行的独立 TEMP 探针原文见 [证据入口](final-audit-evidence/README.md)。这些文档中的探针不进入产品或既有测试链。

**独立性限制：本会话参与过 C–F 实施，未具备隔离的作者外上下文。遵照用户“不使用子代理”的要求，本次没有调用子代理或声称取得第三方独立批准。这里是重新取证的只读审计；如验收要求作者外独立签核，该资格仍未满足。**

Jev 仅给出 testing / low-risk 路由；本审计没有采用其低测试需求评分，而是按用户的真实运行要求执行验证。采用 verification-before-completion 的证据先行规则。没有更改生产代码、既有测试、依赖、版本或发布状态，没有推送、合并。

### 合并历史与变化边界

以下 PR 状态重新通过 GitHub API 获取，原始摘要见 [prs.json](final-audit-evidence/prs.json)。

| 阶段 | PR | 最终合并提交 | 最终生产变化概要 |
| --- | --- | --- | --- |
| A/B | [49](https://github.com/HYJ1817/pi-gui/pull/49) | `6036ceb9d5303eb9653f39b9c54a4c9405a3a815` | tokens、primitives、设置/供应商、字体首屏恢复、设置导航 |
| C | [50](https://github.com/HYJ1817/pi-gui/pull/50) | `773c1f8157e1bdbfe7328ee79f632ac0954d792d` | Shell、标题项目投影、菜单入口、原生标题条颜色 |
| CI 辅助修复 | [51](https://github.com/HYJ1817/pi-gui/pull/51) | `5214c4368d740e41bb7dc6adb9c7e889ee55c1c2` | 更新助手测试等待和终态检测；无生产更新逻辑改动 |
| D | [52](https://github.com/HYJ1817/pi-gui/pull/52) | `31b4c4f8ee3165064f710ea6c535a89816478814` | 消息/Composer 表面、只读用户消息复制、popover Escape |
| E | [53](https://github.com/HYJ1817/pi-gui/pull/53) | `5d8d9d02f5f760a17bca3f61042872bba6c85dac` | 原右栏导航与 launcher、Specs 空态、工作台样式 |
| F | [54](https://github.com/HYJ1817/pi-gui/pull/54) | `326cb3284c5bf67398290ca4cd6ea8bfd5ee8496` | 三个 CSS 文件；补正常沙箱专项，无生产 JS 改动 |

以重构前 `f4e6591e22206a4a0b2447292003fdf4eaf21c03` 至最终 main 的差异核对：`server/`、`lib/`、Pi RPC、Runtime Registry、磁盘格式没有变化；Electron 生产变化仅为 `theme.cjs` 的背景 palette。不能据此保证历史业务无缺陷，但未发现借 UI 改动重写执行/权限链的证据。源码和测试的 [692 文件摘要](final-audit-evidence/source-manifest.json) 固定本次对象。

## 2. A–F 完成情况

| 阶段 | 实际完成 | 尚不满足的部分 | 结论 |
| --- | --- | --- | --- |
| A | 深浅 DS token、兼容桥、原语确实存在；主题 47/47，原语实际模块运行成功 | 全局仍有未定义旧变量、重复 select/容器规则，viz 未消费统一主题；开关无生产调用，不能算业务开关已接入 | 基础层存在，全局统一未完成 |
| B | 275px 分类轨、详情承载、真实表单、主题/字体恢复和认证边界保留 | AUD-001/002/003/004/010；部分页面仍是旧工作区样式 | 不通过 |
| C | 275px 侧栏、46px 连续顶栏、0 宽折叠、既有菜单、稳定排序和所属项目投影均重新验证 | 项目分组标题随列表滚动（AUD-014）；图标路径及原生窗口按钮是保留差异 | 核心布局/既有交互已证实，非完整视觉同一 |
| D | 760px 内容带、14px 正文、透明助手正文、18/8px 用户气泡、20px Composer，原草稿/模型/Thinking 路径保留 | 欢迎布局仍旧版；slash/用量几何未收尾；参考消息编辑/删除/重生成不是现有业务 | 主要对话参数完成，视觉收尾未完成 |
| E | 唯一 right-pane/split owner、真实工具入口、Specs、Changes、native Browser 的布局与释放重新通过 | 原生空页差异、旧 ui4 专项仍红；完整 Collab 交互未由该专项覆盖 | 业务外壳已证实，验收收敛未完成 |
| F | slash 320px 上限已去除；switch 重复规则已删除；设置分组/警告文字已修正 | 全局浅色仍漏掉 viz；AB 容器、旧选择器和页面差异继续存在 | 不通过 |

## 3. 历史遗留清算

“未解决”共 **7 个独立收尾条目**。同一根因不因跨阶段重复记数；新发现的 Bug 不倒填成历史报告已知问题。

| 编号 | 历史线索 | 最终 main 的核验 | 状态 / 处置 |
| --- | --- | --- | --- |
| L01 | 11 的外层 modal-card / 设置容器，留后续统一收尾 | 仍有 `.appearance-body` 边框包裹原语行；样式覆盖实际产生 AUD-001/002 | **未解决**，修复组 R1/R3 |
| L02 | 17/19 的 ui4-pane 420/392 过期断言 | 独立执行再次失败并超时 | **未解决**，AUD-005 / R2 |
| L03 | 17/19 的 Browser 无空态、浅色空视图深底 | 真正的原生整窗仍为 #0d0d0d 大块无引导空区 | **未解决**，AUD-007 / R4；不再笼统视为网页自有主题 |
| L04 | 19 的 slash 内输入区锚定、无组标题/快捷键页脚 | 宽窗仍比 760px 外框窄 24px；结构确实不同 | **未解决**，AUD-011 / R5（低风险） |
| L05 | 15/19 的上下文浮层原宽度/圆角/锚点 | 当前图约 232px 宽；参考为 376px，14px 圆角、16px padding | **未解决**，AUD-012 / R5；字段业务差异保留 |
| L06 | 13 的“项目”标签随树滚动 | 标签位于 `.rail-group` 的滚动 owner 内 | **未解决**，AUD-014 / R5 |
| L07 | 13 留给 D 的欢迎区旧视觉差距 | D/F 未覆盖后加载的 ui4-feedback 欢迎布局 | **未解决**，AUD-006 / R3 |
| H08 | F 前 switch 被重复规则覆盖 | 当前只剩 primitives 实现，97 项含独立原语 computed-style 检查 | 已修复；没有伪造业务开关 |
| H09 | F 前 320px slash 截断、浅色警告/组标题过浅 | 当前真实图和断言复验通过；quota warning 未被中性色规则盖掉 | 已修复 |
| H10 | C 恢复按钮未 no-drag；Runtime 项目标题串属 | 当前 no-drag / 项目投影测试及原生图通过 | 已修复；真实 OS 手动拖动仍另列未验 |
| H11 | D 共享 msg-body 污染 Specs | D 覆盖受 `#stream`/`#runtimeView` 限定，Specs 实际渲染保留 | 已修复该污染；不代表全部 CSS 没有冲突 |
| H12 | C 后 main CI 更新助手 ready 失败 | #51 保留原终态/取消断言，最终 main CI 该叶命令成功 | 已修复该测试等待问题 |
| H13 | 单次 npm test 与累计续跑混淆 | C/D/F 仅可认累计；E 有历史单次成功；最终 main 现有准确 SHA 完整分组 CI | 证据口径已澄清，不虚构最终 main 本地单次成功 |
| H14 | 设置总览→详情、独立工作表面模型 | 当前仍由 workspace/settings surface 持有生命周期；替换 React 路由没有必要 | 合理架构差异；不要求为相似布局改 owner |
| H15 | 主题缩略卡 vs 下拉；Pi 思考滑块 vs 可用档位 | 真实选择器存在，取值和持久化测试通过 | 合理控件/能力差异，无假滑块 |
| H16 | Specs 上下布局 vs Files 左右布局 | 原树/预览/只读边界仍存在；参考是完整文件管理器 | 合理业务差异；不是任意文件管理器缺陷 |
| H17 | 消息时间/耗时、编辑/删除/重生成、Runtime 历史 | 没有完整数据/写业务 owner；用户消息文本复制已存在 | 缺失/排除能力，见产品决策；不补假数字或写盘按钮 |
| H18 | REF-024 @ 文件提及 | 当前只有普通 @ 草稿与附件；未发现路径补全接线 | **仍未实现**，产品决策，不算已完成或 Bug 修复 |
| H19 | 真实 IME、模型长负载、跨平台、安装升级、完整 Collab | 本次没有越过离线边界运行这些资格 | 仍未验证，见第 9 节，不计入 7 个视觉遗留 |

## 4. 已确认问题清单

每项“发现”均针对最终 main。A/B/C/D/E/F 表示责任范围或最终应收口阶段；“既存”不表示由最后一个阶段引入。当前均未修复，本审计没有改生产实现。

### AUD-001 · B/F · P1 · 设置页隐藏主要保存和诊断操作

- **定位**：[styles.css:2983](../../public/styles.css#L2983) `display:none !important`；后面的 3081 非 important `display:flex` 无法恢复。调用链：[app.js:1145](../../public/app.js#L1145) → [settings-surface.js:106](../../public/ui/settings-surface.js#L106) → [providers.js:273](../../public/providers.js#L273)、[600](../../public/providers.js#L600)。诊断 [diagnostics.js:384](../../public/diagnostics.js#L384)、日志 [logs.js:139](../../public/logs.js#L139) 也使用该 actions 容器。
- **复现**：打开设置→模型供应商→右上“添加服务”，填写有效的夹具 ID/Base URL/模型；观察底部操作和 Tab 路径。无需真的提交配置。
- **实际**：保存/取消的 parent display=none、可见性 false、矩形 0×0；诊断的复制摘要/JSON、导出、刷新同样隐藏。空供应商卡的另一个添加入口使用原 modal，保存反而可见，两个入口不一致。
- **预期 / 影响**：所有真实写入与诊断动作可达，不能用视觉规则删除功能；当前主要供应商新增流程不可用。没有观察到数据被写坏。
- **证据**：[probe-results](final-audit-evidence/probe-results.json)、[空卡另一入口](final-audit-evidence/probe2-results.json)、[深色图](final-audit-evidence/probes/audit-provider-add-dark.png)、[浅色图](final-audit-evidence/probes/audit-provider-add-light.png)。blame 定位为 A/B `9880de9d` 引入，C–F 未清除。
- **建议 / 时机**：立即修复。不要全局隐藏 `.modal-actions`；仅显式处理真正重复的展示按钮，并统一现有 presenter 入口。补真实 Electron 可见、Tab 可达及 TEMP/mock 保存断言。R1。

### AUD-002 · A/B/F · P2 · 外观页仍被旧卡片样式二次包裹

- **定位**：[styles.css:6](../../public/styles.css#L6)、[settings.js:145](../../public/settings.js#L145)、[settings-surface.js:106](../../public/ui/settings-surface.js#L106)。`.appearance-body` 原为 fieldset，如今加到新 SettingsCard section，但旧 border/background/padding 仍适用；只清理 `fieldset.appearance-body` 没有清理新 section。
- **复现 / 实际**：常规页，100% 字号，约 1205×803。旧外壳为 800px、带 0.667 CSS px 计算边框、#212121 背景、18/20px padding，再包一层独立行。浅色也保留外框。标题约 x340，而 REF-004 x315 左右；这是布局差异，不是字形差异。
- **预期 / 影响**：参考 `styles/settings.css:349–450` 是外层组溶入页面、组标题在独立 tile 外。当前重复表面、缩进与行宽明显不同，通用原语被业务旧类覆盖；其他 Extensions/MCP 页也仍保留旧工具页层级，不能称设置中心全量统一。
- **证据**：[probe2](final-audit-evidence/probe2-results.json)、[外观实际图](final-audit-evidence/probes/audit-navAppearance.png)、[旧 AB 图](screenshots/settings-appearance-dark.png)、REF-004；历史 11 明确留后续收尾。
- **建议 / 时机**：R3，在核心操作恢复后，按引用范围拆掉外观旧类的展示规则；保留 workspace 生命周期及真实控件，不大规模改路由。

### AUD-003 · A/B/F · P2 · 窄窗字号标签逐字竖排

- **定位**：[primitives.css:280](../../public/ui/primitives.css#L280)、[312](../../public/ui/primitives.css#L312)、[settings.js:123](../../public/settings.js#L123)、[styles.css:3038](../../public/styles.css#L3038)。换行选择器只匹配 control 的直接 `.ds-segmented`，实际中间还有 `.font-size-ctrls`。
- **复现 / 实际**：700×600、侧栏展开、进入常规。字号行约 314px，固定控件约 246px 加 gap，把“字体大小”挤成四行，每行一字；130% 字号也没有合理重排。
- **预期 / 影响**：标签正常一行或按块换行，控件整组换到下一行；影响真实窄窗阅读和使用。不能用“document 没有横向溢出”证明该布局通过。
- **证据**：[截图](final-audit-evidence/probes/audit-appearance-narrow.png)、[probe2 几何](final-audit-evidence/probe2-results.json)。
- **建议 / 时机**：R1/R3，给实际复合控件结构定义窄窗换行边界，保留可读标签宽度；同时验 100/130% 与 700/900px。

### AUD-004 · B/C · P2 · MCP/能力页面错误标成 Skills 当前页

- **定位**：[workspace-surface.js:4](../../public/ui/workspace-surface.js#L4)、[30](../../public/ui/workspace-surface.js#L30)，[app.js:1106](../../public/app.js#L1106)、[extensions.js:1043](../../public/extensions.js#L1043)。一级 view=extensions 被恒映射为 navExtensions，未投影其真实子 tab。
- **复现 / 实际**：设置→MCP 配置，或能力状态。真实 selected 分别为 mcp/capabilities，但唯一 `aria-current=page` 一直在 navExtensions，顶栏都叫 Skills 与扩展。
- **预期 / 影响**：当前导航和页面名称反映实际选中页；现状会误导用户及辅助技术。不是两份业务数据串属，属于已有 view 投影不完整。
- **证据**：[probe6](final-audit-evidence/probe6-results.json)、[MCP 图](final-audit-evidence/probes/audit-navMcp.png)。
- **建议 / 时机**：R1，沿现有 Extensions active tab 投影导航和标题，不建立第二份可写 tab store。这个基础映射早于重构，B/F 未处理。

### AUD-005 · E/F · P2 · 旧真实工作台专项长期不可运行

- **定位**：[tests/ui4-pane.cjs:192](../../tests/ui4-pane.cjs#L192)、[196](../../tests/ui4-pane.cjs#L196)、[198](../../tests/ui4-pane.cjs#L198)，生产 [right-pane.js:33](../../public/right-pane.js#L33) 默认 392。
- **复现 / 实际**：`UI4_EVIDENCE_ROOT=<TEMP> node tests/ui4-pane.cjs`。已打印 4 PASS、2 FAIL，之后点击关闭面板里的隐藏 navChanges，等待 changes 超时并退出 1；未完成剩余场景。420px 断言不是新产品缺陷的证据。
- **预期 / 影响**：专项使用当前生产入口/明确设计尺寸，完整运行真实布局、焦点和滚动边界。它不在 canonical 的 `test:ui4` alias 中，所以 main CI 成功不矛盾；但留下了实际布局测试盲区。
- **证据**：[原始失败日志](final-audit-evidence/ui4.log)、17/19 均已披露；本次未改断言。
- **建议 / 时机**：R2，先区分旧设计断言和有效交互断言，再复用现有当前入口校正专项；禁止删失败检查或把 392 生产改回 420 迎合旧测试。

### AUD-006 · C/D/F · P2 · 欢迎页仍是旧版左上小标题

- **定位**：[ui4-feedback.css:348](../../public/ui4-feedback.css#L348)、[styles.css:3453](../../public/styles.css#L3453)、[index.html:138](../../public/index.html#L138)。后加载的 ui4-feedback 把 welcome 定为左对齐 grid、24px 图标、20px 标题，覆盖前面居中/顶距意图。
- **复现 / 实际**：新会话且项目已就绪；展开与折叠侧栏。真实图在主区左上显示一行“开始一个任务”；REF-001/002 是居中的 hero/引导组合，标题 28px、100px 图标区，空间层级明显不同。
- **预期 / 影响**：沿 pi-GUI 已有欢迎状态做相同空间组织；不要求复制品牌吉祥物或发明 onboarding 完成状态。该差异在最显眼的主页面，不能只以颜色一致关闭重构。
- **证据**：[新主界面](final-audit-evidence/electron/01-dark-expanded.png)、[折叠](final-audit-evidence/electron/02-dark-collapsed.png)，参考 `styles/chat-shell.css:671–774`。
- **建议 / 时机**：R3，确定 welcome 样式唯一负责文件，复用既有 welcomeReady/NoProj/Restore 状态，重新验短窗及溢出滚动。

### AUD-007 · E/F · P2 · 应用自己的 Browser 空页未适配主题与引导

- **定位**：[electron/browser-view.cjs:254](../../electron/browser-view.cjs#L254)、[260](../../electron/browser-view.cjs#L260)，[browser-pane.js](../../public/browser-pane.js) 的原生 viewport 挂载。
- **复现 / 实际**：浅色→打开内置浏览器，尚未输入 URL；整个原生区域为 #0d0d0d，无“尚未打开页面”提示。深色同样缺引导。原生整窗可见，不是 capturePage 漏拍原生视图。
- **预期 / 影响**：应用控制的 about:blank 应有主题一致、可理解的空态；这是现有 Browser 的状态展示，不需要增加新业务。已导航网站的自身主题、Agent 状态行、权限与附着生命周期则是合理差异，不能一并要求重绘。
- **证据**：[实际 native 图](final-audit-evidence/electron/f15-slash-browser-light-native.png)、REF-018；参考 `PluginViewTab.tsx` 与 WorkPanel 的空页承载。17/19 已知该差异。
- **建议 / 时机**：R4，仅处理应用自有空状态；禁止向任意网站注入主题、用 CSS z-index 假装覆盖原生视图，或绕过现有 attach/detach owner。

### AUD-008 · A/E/F · P2 · 图表浅色按钮和提示正文几乎不可读

- **定位**：[viz.css:89](../../public/viz.css#L89)、[328](../../public/viz.css#L328)、[346](../../public/viz.css#L346)，[tokens.css:291](../../public/tokens.css#L291)。`--bg-subtle`、`--bg-card` 未定义，回落深色；`--text` 随浅色切成深文字。
- **复现 / 实际**：浅色会话渲染合法 `pi-gui-viz` 折线 JSON→打开可视化→悬停数据点。按钮 #242424/#2a2a2e，提示正文 #242424/#202024；sRGB 对比度约 1.09:1 和 1.05:1，实际字几乎消失。
- **预期 / 影响**：应用自有图表入口、数值提示随同一语义主题可读；系列数据色可以保留。该模块早于 A–F（`90ad18ad`），是 F 全局收尾漏项，不能称由 F 新引入。
- **证据**：[实际悬停图](final-audit-evidence/probes/audit-viz-hover-light.png)、[probe6 实际颜色](final-audit-evidence/probe6-results.json)、[变量检索](final-audit-evidence/css-inventory.json)。现有 viz-ui 66/66 没覆盖此 CSS。
- **建议 / 时机**：R1，替换该组件的旧未定义别名和深色 fallback，补真实图表按钮/提示 computed-style 与截图，保留安全 schema 和系列含义。

### AUD-009 · E/F · P2 · 图表键盘提示框落到右面板外

- **定位**：[viz-chart.js:298](../../public/viz-chart.js#L298)、[376](../../public/viz-chart.js#L376)。FocusEvent 没有鼠标坐标，showTip 用 0 减 wrapper 左边缘再定位。
- **复现 / 实际**：上个图表场景，Tab 到数据点（探针调用真实节点 focus，走同一生产 focus handler）。wrapper x=830、宽360，提示框 x=12–112；被右栏裁切。真实鼠标悬停则 x=876–976，在面板内。
- **预期 / 影响**：键盘聚焦显示该数据点旁且可见的数值；只用键盘的用户拿不到图形提示。与 AUD-008 的配色根因不同，单独跟踪。
- **证据**：[probe6](final-audit-evidence/probe6-results.json)、[键盘图](final-audit-evidence/probes/audit-viz-keyboard-light.png)、悬停对照图。
- **建议 / 时机**：R1，用目标数据点的真实几何作为 focus 定位锚，鼠标继续用指针，进行面板边界碰撞检查。无需改图表数据/执行逻辑。

### AUD-010 · B/F · P2 · 设置搜索向下键跳过第一项

- **定位**：[settings-surface.js:148](../../public/ui/settings-surface.js#L148)、[166](../../public/ui/settings-surface.js#L166)。输入节点的 handler 先 focus 第一项，事件继续冒泡到 menu，再按当前 activeElement 前进一次。
- **复现 / 实际**：打开设置→搜索框保持空值和焦点→按一次 Down。首个可见项 navAppearance，实际焦点 navShortcutHelp。
- **预期 / 影响**：一次按键进入首个可见结果，不跳项；影响正常键盘导航。旧测试只从按钮向下/向上，没有从输入框开始。
- **证据**：[probe6.searchDown](final-audit-evidence/probe6-results.json)、[实际图](final-audit-evidence/probes/audit-search-arrow-down.png)，15/15 原设置测试仍通过。
- **建议 / 时机**：R1，统一消费入口或正确停止已消费事件，补空搜索/多结果/单结果的真实 keydown 路径，不改过滤业务。

### AUD-011 · D/F · P3 · Slash 几何与分组提示未收尾

**定位**：[inline-command-menu.js:257](../../public/ui/inline-command-menu.js#L257)、[ui3-inline-commands.css:13](../../public/ui3-inline-commands.css#L13)。复现 `/`：菜单 736px 跟输入区，而外框760px；参考贴完整 Composer，且有组标题/底部按键提示。实际 [f02](final-audit-evidence/electron/f02-slash-light.png)；源码 `composer-autocomplete.css:13–33`。不影响现有筛选/IME/执行，是已验证的轻微视觉差异/优化项；中文真实命令内容不同合理。R5 在完整保留注册表/原生边界前提下调整展示，不新增参考独有命令。

### AUD-012 · D/F · P3 · 用量浮层仍是另一种窄卡片

**定位**：[popover.js:46](../../public/ui/popover.js#L46)、[styles.css:1507](../../public/styles.css#L1507)。点击上下文环，实际 [f03](final-audit-evidence/electron/f03-context-light.png) 宽约232px、20px 外圆角，参考 REF-023 / `messages.css:1651` 是376px、14px、16px padding。当前文字可读、unknown 与额度警告真实，非功能损坏；只把无业务必要的外形差异列为优化，不要求耗时/推理等虚构字段。R5 单独给现有 tip 模式布局约束，不能误伤模型/Thinking 共享 popover。

### AUD-013 · D 测试 · P3 · 剪贴板验证不恢复用户原内容

**定位**：[conversation-scenarios.cjs:27](../../tests/fixtures/conversation-scenarios.cjs#L27)、[101](../../tests/fixtures/conversation-scenarios.cjs#L101)。运行 conversation/theme-convergence 专项会写系统剪贴板标记及 Runtime 文本，没有原格式快照和 finally 恢复。实际通过路径留下最后复制的测试文字；不涉及生产会话文件。它是测试副作用，不是生产数据丢失。R2 使用已有 Electron clipboard 格式 API 做有界备份恢复，包含失败退出；不能只覆盖空字符串，也不要把真实剪贴板内容写日志。

### AUD-014 · C/F · P3 · 项目分组标题跟随树滚走

**定位**：[app-shell.css:82](../../public/app-shell.css#L82)、[index.html](../../public/index.html) 的 groupHead 位于该滚动组。长列表滚动时“项目”消失，参考 Sidebar 的标题在列表滚动区外。证据：[14 长列表图](final-audit-evidence/electron/14-sidebar-scroll-dark.png)、13 的历史披露；无会话顺序/状态丢失。R5 在原滚动 owner 下固定标签或轻调结构，保留列表与 footer 边界，不另造树状态。

## 5. 24 张参考图核对矩阵

下面源码路径均相对固定参考的 `apps/desktop/src/`；实现路径相对本仓库 `public/`。每个编号原图均已打开；[对应文件摘要](final-audit-evidence/references.json) 防止错图。REF-008 是 **Skills 列表**，不是历史 B 路线图所称的供应商列表，不能沿用该错映射。

| 参考 | 固定源码 / 实现落点 | 本次真实图 | 参数、差异与判定 |
| --- | --- | --- | --- |
| REF-001 深色欢迎展开 | AppShell、Sidebar、chat-shell.css / app-shell.css、ui4-feedback.css | [01](final-audit-evidence/electron/01-dark-expanded.png) | 275px黑侧栏/46px #181818顶栏达到；欢迎 hero 空间层级未达到 AUD-006；品牌/任务文案可不同 |
| REF-002 折叠 | AppShell、ConversationTopbar / app.js、shell.js | [02](final-audit-evidence/electron/02-dark-collapsed.png) | 侧栏0、12px恢复入口达到；没有参考宽度动画是合理实现差异；欢迎仍未达到 |
| REF-003 工作台新建 | WorkPanel.tsx:1149、work-panel.css:504 / app.js、work-panel-launcher.js、ui4-pane.css | [e01](final-audit-evidence/electron/e01-launcher-dark-native.png) | 14/10px内距、40px行、18px图标达到；392px宽、五个真实固定工具与参考多标签不同，合理 |
| REF-004 常规 | SettingsPage、settings.css / settings.js、primitives.css、styles.css | [常规](final-audit-evidence/probes/audit-navAppearance.png) | 275px轨、30px本项目标题、真实主题/字体；额外外框和缩进 AUD-002、窄窗 AUD-003，未达到 |
| REF-005 AI设置 | SettingsPage、ui.tsx / 原 Composer/权限/Thinking 分散入口 | [Thinking](final-audit-evidence/electron/d05-thinking-picker.png) | 没有独立同构 AI 偏好页；真实思考/权限归属不同。不能把该图登记为整页还原通过 |
| REF-006 实时语音 | Voice 设置分支 / 无等价业务 | 无同场景 | 规范07/09已排除；缺失能力，不添加假开关 |
| REF-007 供应商空态 | SettingsPage、ServiceChooser / providers.js | [空卡](final-audit-evidence/probes/audit-provider-empty.png) | tile/真实添加入口存在；外层位置/描述不同；右上新增入口 AUD-001 使流程不通过 |
| REF-008 Skills | SettingsPage、Skills 设置 / extensions.js | [Skills](final-audit-evidence/probes/audit-navExtensions.png) | 当前旧式树/详情+tab，参考独立圆角卡片；业务启停/信任状态真实，但设置视觉仍不统一（AUD-002范围） |
| REF-009 市场 | SkillMarket / 无市场业务 | 无同场景 | 明确排除，不以本地 Skills 冒充市场 |
| REF-010 MCP | SettingsPage MCP / extensions.js mcpTab | [MCP](final-audit-evidence/probes/audit-navMcp.png) | 原生MCP状态、登录/移除是本项目业务；旧布局显著不同，当前页导航错误 AUD-004；不伪造扫描/市场 |
| REF-011 子智能体声明 | Agent 设置 / 无等价声明管理器 | [能力状态](final-audit-evidence/probes/audit-navCapabilities.png)仅相关 | 排除参考管理器，能力状态不是同一功能；不把“未知”改成“未安装” |
| REF-012 信息/更新 | SettingsPage about / settings.js、update.js、pi-update.js | [更新](final-audit-evidence/probes/audit-navAppUpdates.png) | 当前保留两套产品更新的真实边界；没有参考的大版本/协议卡片；探针未挂更新IPC，错误态不等于更新业务成功 |
| REF-013 服务选择 | ProviderSetupDialog、ServiceChooser / providers.js openAddProvider | [另一modal入口](final-audit-evidence/probes/audit-provider-empty-add-modal.png) | 真实预设横列而非四列服务选择；订阅/OAuth在认证页，合理能力差异；没有完成网格还原，不凭相似按钮宣称通过 |
| REF-014 服务配置 | ProviderSetupDialog、ModelSelectionPanes / providers.js | [配置](final-audit-evidence/probes/audit-provider-add-dark.png) | 当前单列表单，环境变量引用代替原文密钥是安全差异；模型拖拽/双栏未实现，AUD-001 保存不可达是 Bug |
| REF-015 模型选择 | ComposerModelPicker、ThinkingLevelSlider、composer-menus.css / ui3-model-picker、runtime-picker | [d04](final-audit-evidence/electron/d04-model-picker-dark.png)、[d14](final-audit-evidence/electron/d14-runtime-model-dark.png) | 20px表面/原搜索分组有效；Classic320px及独立思考菜单区别于参考滑块，保留原生可用档位，不添加假档位 |
| REF-016 运行/Thinking | AssistantTurn、ActivityGroup / messages.js、runtime-conversation.js | [d03](final-audit-evidence/electron/d03-thinking-expanded.png)、[d07](final-audit-evidence/electron/d07-streaming-dark.png) | 14px正文/22.4行高、18/8气泡、真实停止状态有效；字数/用量与参考计时条不同，不能虚构耗时 |
| REF-017 完成/操作 | MessageRow、AssistantTurn / messages.js、message-actions.js | [d01](final-audit-evidence/electron/d01-dark-completed.png)、[d02](final-audit-evidence/electron/d02-user-actions.png) | 用户复制走真实剪贴板；没有编辑/删除/重生成。首条消息顶距、角色标签、工具时间线不同，不是全像素符合 |
| REF-018 Browser | PluginViewTab、WorkPanel / browser-pane、electron/browser-view | [e14 native](final-audit-evidence/electron/e14-browser-dark-native.png)、[本地网页](final-audit-evidence/browser/01-browser-single-native-page.png) | 46px工具带与实际原生几何通过；Agent行额外占高合理；应用空页 AUD-007 未达到 |
| REF-019 Files | FilesTab、work-panel.css / specs-panel、specs-tree、Changes | [e02](final-audit-evidence/electron/e02-specs-dark.png)、[e04](final-audit-evidence/electron/e04-changes-dark.png) | Specs只读上下布局 vs 全文件左右管理，属于业务差异；38/18空态参数达到，原图无相同Specs空态，不做像素通过结论 |
| REF-020 项目菜单 | ContextMenu、SidebarMenuPanel / ui/action-menu、projects、sessions | [04](final-audit-evidence/electron/04-project-context-menu.png)、[05](final-audit-evidence/electron/05-session-context-menu.png) | 14px面/10px行、8px碰撞留边、唯一菜单已验；条目与层级按现有能力，非参考完整Git子菜单 |
| REF-021 浅色对话 | tokens、messages、composer / tokens、styles、ui3-composer | [f01 native](final-audit-evidence/electron/f01-conversation-light-native.png) | #f3f3f3侧栏/#fff画布、14px正文、760px/20px Composer达到核心参数；角色/首条顶距/业务按钮不同；不代表全局浅色通过 |
| REF-022 Slash | ComposerAutocomplete、composer-autocomplete.css / inline-command-menu | [f02](final-audit-evidence/electron/f02-slash-light.png)、[窄窗](final-audit-evidence/electron/f10-slash-narrow-light.png) | 白色opaque、焦点留输入、键盘与原生边界通过；宽度736vs760、组标题/快捷键提示 AUD-011 |
| REF-023 用量 | ContextUsageInspector、messages.css:1651 / usage、ui/popover | [f03](final-audit-evidence/electron/f03-context-light.png)、[unknown](final-audit-evidence/electron/f04-context-unknown-light.png) | 已用/剩余和unknown语义正确；232vs376、20vs14圆角为AUD-012；缺计时数据合理，不纳入修复 |
| REF-024 @文件 | Composer、ComposerAutocomplete / 当前无路径补全owner | [普通@](final-audit-evidence/electron/f05-at-draft-light.png)、[真实附件](final-audit-evidence/electron/f06-attachment-light.png) | **未实现，未通过**；附件不是该补全功能。单独产品决策 |

### 尺度、颜色与验收方式

按 1205×803 CSS / DPR1.5 运行综合和独立探针，窄窗700×600（部分继承场景700×650）。Windows 取整导致部分记录 `innerWidth=1206`，实际 CSS 宽有1205.333等小数；以每张 geometry/PNG尺寸为准，不把1808/1809的捕获差异拉伸伪装相同。原始图1808×1204/1205，采用用户提供的1.5条件；PNG DPI元数据不是本次独立探测参考系统的证明。

综合图来自真实 webContents.capturePage；带 `native` 的整窗图核对自身 mediaSourceId/窗口身份，不能与 renderer 捕获混算。浅色没有原图的设置/工作台只做固定源码+实际渲染核对；只有021–024能直接浅色逐图比较。118张并非全部逐张全像素评分，本审计按区域核对关键图与几何，未看的辅助捕获不计视觉通过。

没有计算内容不同整页的“相似度百分比”：它会把合理业务差异与真正布局缺陷混合。正文/背景对比合格不代表所有控件合格，AUD-008 是明确反例。

## 6. 功能、状态与安全回归

| 边界 | 本次证据 / 实际结果 | 仍不能推出的结论 |
| --- | --- | --- |
| 项目展开、会话排序/菜单 | stable-session-order 41/41、sidebar-menu 37/37；综合专项真实右键、改名/归档投影、滚动/折叠 | sidebar-expansion 是进程内 Map；没有宣称重启后展开状态落盘 |
| 并行与切换 | concurrency 的 scheduler9/9、bridge6/6、resolver7/7、runtime5/5；background UI9/9、background5/5、runtime-nav38/38 | 离线夹具不是付费模型长负载或本机真 Pi E2E |
| 草稿与身份 | runtime-draft42/42、runtime-store34/34、Runtime conversation106/106，UI3正常沙箱243/243 | 真实OS IME、崩溃恢复中的所有组合没有人工验收 |
| Thinking/流式/历史/消息 | ui3-model54/54、composer34/34、综合97/97含生产Markdown/复制/状态 | 综合中的运行事件是注入投影，不是模型实际执行 |
| 右栏 owner/分屏/释放 | split30/30、runtime-secondary24/24、browser-ui14/14、原生64/64含双Runtime与20次切换 | Collab图只展示不可用状态，不代表完整协同画布验收 |
| Specs/Changes/审阅/撤销 | specs18/18、specs-ui25/25、runtime-changes60/60、diff-comments-ui51/51、object-revert UI52/52；Browser专项操作真实TEMP Git patch | DI撤销界面不是原生写资格；未对真实项目执行撤销 |
| 供应商/认证 | provider-auth105/105，源码仍只接受环境变量引用，原磁盘密钥不回显，OAuth秘密输入保留官方降级 | 未实际远端登录/验证 API Key；AUD-001界面保存仍失败 |
| 主题/持久化/原生按钮 | theme47/47；97专项重复切换保留草稿/输入节点/原生caption；独立字体130%实测生效 | 系统显示缩放切换、安装后的native菜单/更新没有新证明 |
| Browser权限与生命周期 | 原生控制器/权限代码A–F未改；64/64正常沙箱，本地页面输入/Agent控制启停/模态遮挡/关闭释放 | 没有对任意远端站点登录、外部页面权限组合做穷尽验证 |

未发现新的 P0 数据破坏、路径越权或凭据泄露证据；不作不存在其他安全缺陷的保证。UI 的实际功能回归已确认 AUD-001，不能用后端未变化排除它。

## 7. CSS、模块与长期维护

- **明确所有权有效**：right-pane 持有尺寸/显隐，secondary-surface 持有业务挂载/释放，split-workbench 持有分屏，BrowserController 持有原生视图。E launcher 只有39行展示委托，MutationObserver有disconnect；消息复制是23行只读叶模块。未发现这些新增模块建立第二个业务状态源或新循环依赖。
- **全局CSS并未收敛**：去注释后 public 全部CSS有 **55条 `!important`**，styles.css45、primitives3、ui4-pane2、viz3、collab与productivity各1；原始文本含注释为57处，不能混用统计。[清单](final-audit-evidence/css-inventory.json)。`[hidden]` 的优先级守卫有明确用途；不建议机械删除。AUD-001则是可证明的功能性优先级错误。
- **旧类依赖有实际代价**：`modal-card settings-detail-card` 用强覆盖抹掉弹层外形，`.appearance-body` 从fieldset迁到section仍带旧外壳；primitives.css先加载，styles.css再覆盖同名`.ds-select`。AUD-002/003反映维护风险已经落到真实页面。修复应清查引用后定点拆解，不能再堆important。
- **语义层并非处处一致**：DS、UI与legacy桥并存有兼容价值，不能仅按变量数量判错；但viz的`--bg-card/--bg-subtle/--border`以及candidate事实的`--text-muted`没有定义。JS动态定义的composer预留高度及带fallback扩展变量不能被静态扫描误报为Bug。已用真实渲染确认的viz问题才记P2，其他未定义别名是待核对债务。
- **无效覆盖实例**：styles.css中welcome的居中/顶距被ui4-feedback后加载覆盖；fieldset专用清理已不匹配新外观section；3081 display:flex输给2983 important。这些是清理收益明确的局部，不需要全仓组件重写。
- **事件与异步**：settings detail Escape/onThemeChange均有相应释放；E observer释放与split监听释放测试通过；复制异步只写自己的bar，不改会话。设置搜索的双层handler仍发生重复消费（AUD-010）。未进行长时间heap/GC性能资格，不从短测推断无泄漏。
- **魔法数字要按语义判断**：275/46/28、392默认宽度和原生138避让都有当前参考/平台依据，不应一律抽象或删掉。旧ui4的420断言是失效契约，不应反向修改产品迎合它。测试viz-electron仍有本机TEMP路径fallback，本轮未使用它；不能认作跨机器执行证明。
- **测试副作用**：剪贴板未恢复单列AUD-013。本次没有写用户会话、调用真实模型或新增网络行为。没有把测试fixture注入函数当作新业务按钮。

## 8. 测试真实性与 CI 核对

### 最终 main 完整证明

[main run 42138148246](https://github.com/HYJ1817/pi-gui/actions/runs/42138148246)，push / attempt1，head SHA精确326cb328…，8个job全部success。下载五组schema v2 JSON，用当前package递归计划、准确GITHUB身份重新运行 `scripts/summarize-ci-results.mjs --require-complete`，**退出0，234/234唯一命令，dataComplete=true，allPassed=true，unfinished=false**。组数为core158、ui24、security27、native4、faults21；test wall span907.077秒、命令执行耗时合计3047.772秒，后者不是流水线墙钟。

原始[分组证据](final-audit-evidence/ci/)、[重算结果](final-audit-evidence/ci-validated.json)均保存。首次本地重算未设置GITHUB身份，被工具正确拒绝，不是CI失败；补入已核实身份后通过，没有更改汇总器或原记录。

**最终 main 没有本次新执行的单次本地 `npm test` 成功记录。** 历史C/D/F是累计续跑，E为历史单次；当前准确main已有完整CI，因此只读文档审计不再无依据重复约80分钟本地链。CI234命令的skip=0只代表命令覆盖，不代表内部权限断言全部执行。

重新读取该run原日志：SACL witness为**8/8、skip0、productionQualified=false**；in-place为**30/30、skip0，research only**；Object witness为**0/0、skip8，existing_token_sacl_unavailable**。native metadata witness也报告saclState unavailable、productionAdmission false。不能沿用此前本机“两个witness都skip8”的数字概括这次CI，也不能因该CI为success就宣称取得对象写入审计资格。

### 本次本地定向与专项

完整入口/日志摘要见 [directed-tests.json](final-audit-evidence/directed-tests.json)，没有把跨套件重复断言相加为全仓总数。

| 实际入口 | 本次结果 |
| --- | --- |
| theme / settings-acceptance / primitives | 47/47、15/15；primitives退出0，输出5组，无统一断言总数 |
| inline / ui3-integration / composer / model | 46/46、23/23、34/34、54/54 |
| runtime-conversation / context-reference / visual-finish / app-shell | 106/106、10/10、10/10、10/10 |
| provider-auth / stable-session-order / sidebar-menu | 105/105、41/41、37/37 |
| split / specs / specs-ui / Browser UI | 30/30、18/18、25/25、14/14 |
| session-search / runtime-store | 72/72、34/34；search 5i符号链接因本机权限未验，不计通过 |
| session-concurrency | 四个真实模块入口9/9、6/6、7/7、5/5 |
| background / background-ui / runtime-nav / runtime-draft | 5/5、9/9、38/38、42/42 |
| runtime-secondary / runtime-changes | 24/24、60/60 |
| diff-comments-ui / object-revert UI / ui-ia / ui4-integration | 51/51、52/52、26/26、56/56 |
| viz-ui | 66/66，未检查当前确认的浅色和focus几何问题 |
| `node tests/theme-convergence-electron.cjs`，SHELL_OUTPUT指向新TEMP | [97/97](final-audit-evidence/electron/results.json)，66 renderer +7 native；生产模块、样式、preload/主题桥、真实BrowserController |
| `node tests/browser-workbench-electron.cjs`，T2B_EVIDENCE_DIR指向新TEMP | [64/64](final-audit-evidence/browser/results.json)，正常沙箱，20个PNG文件；不把重复捕获文件名累计成更多独立图 |
| `node tests/ui3-integration-electron.cjs`，UI3_EVIDENCE_ROOT指向新TEMP | [243/243、skip0](final-audit-evidence/ui3-results.json)，正常沙箱；合成composition不等于OS IME |
| `node tests/ui4-pane.cjs`，UI4_EVIDENCE_ROOT指向新TEMP | 退出1，4个成功检查/2个失败后超时，未完成；见AUD-005 |
| 独立探针 | 实际生产入口/事件与原CSS，TEMP服务，取得设置/导航/viz复现；不注册为产品测试，不声称是一套通过的回归测试 |

外壳与旧ui4首次运行时间短暂重叠；97专项退出0，旧ui4的392和隐藏入口错误均由确定的源码/几何支持，不以焦点抢占作为其归因。随后UI3、Browser和独立探针分别执行。无端口冲突、无终止用户进程。

### 真实性结论与缺口

1. 抽查新增/修改测试通过真实模块 import、esm bundle或读取生产源执行，没有发现把本次生产算法另抄进测试后只测复制品的证据。原语VM只变换export语法，非重写算法。
2. **真实模块不等于真实完整交互**：设置测试在jsdom检查结构/hidden属性/源码字符串，provider presenter为自建div，不加载真实CSS，恰好遗漏AUD-001。97专项只看供应商列表，没走右上新增保存；viz66不校验主题/keyboard边界。需要补这些生产路径。
3. D的旧视觉57项修订为14px/1.6、18/8、82%/600、12px代码块等有固定源码依据；没有看到通过删除关键安全断言减少数量。后台Electron改定位到实际rtc-composer-actions；#51保留取消/终态约束，不是把失败改skip。
4. 11报告称primitives6/6，当前脚本只输出5组，无法从输出独立证实它的“6个断言”；本审计只报退出0与实际组数。旧报告的通过结论不作为新证据。
5. 正常沙箱97/64/243与历史settings-headings、theme、background Electron的`--no-sandbox`证明分层，后者不能替代前者；本轮未把历史no-sandbox截图算新的正常启动资格。
6. 本地所有未执行的Windows权限用例不借CI成功补写通过；CI的Object witness8项仍未验证。完整模型E2E、安装GUI没有执行。

## 9. 未验证项目与产品决策

| 编号 | 类型 | 本轮边界 / 下一步 |
| --- | --- | --- |
| U01 | 资格 | 作者外隔离审查未运行；本报告不能替代独立验收签核 |
| U02 | 平台 | macOS/Linux及不同Windows显示缩放、真实OS中文IME组合，未验证 |
| U03 | 产品运行 | 真Pi控制面/模型长负载、多供应商远端额度、真实OAuth登录未执行 |
| U04 | 安装产物 | 本次只跑源码Electron；未启动打包GUI、安装、升级、回滚。准确main CI的构建job不替代这些层 |
| U05 | 协同 | 综合的Collab只是不可用状态；完整画布编辑/导出/恢复未在新Electron人工验证，原canonical CI不等于此资格 |
| U06 | OS交互 | 原生拖拽区域与按钮避让实测；手动双击标题栏/三键组合未逐项测试 |
| U07 | 权限 | 本机symlink/search5i和研究型审计资格未重跑；main CI仍有Object witness8项未验，生产资格不开放 |
| U08 | 性能 | 没有长时heap、全部浮层/所有异常组合的穷尽测试；短程监听释放通过不等于长期资格 |
| U09 | 状态语义 | 项目展开仅进程内记忆；若产品要求重启恢复，需单独确认持久化契约，不从“正确保存”泛词推定已经落盘 |
| PD01 | 未实现 | REF-024文件提及/路径索引：继续明确未实现，由产品另行决定，不自动纳入修复 |
| PD02 | 排除 | 语音、在线技能市场、独立子智能体声明管理器、完整Files CRUD、多工作标签扩张，不补伪UI |
| PD03 | 业务差异 | API Key仅环境引用、官方login降级、unknown状态、Pi可用思考档位、Runtime历史只读、Agent控制行，全部保留 |
| PD04 | 能力差异 | 消息编辑/删除/重生成、完整助手级操作与耗时瀑布没有本次端到端业务契约；不以参考存在推导必须新增 |

## 10. 处置顺序与结束标准

执行计划见 [pi-desktop-final-remediation-plan.md](pi-desktop-final-remediation-plan.md)。R1先恢复实际可用性，R2修验收盲区，R3统一剩余主要页面，R4处理应用自有原生空态，R5收低风险差距，R6冻结状态复验。修复须另获实施授权；本审计没有代做。

当前P0=0只是未发现可证实的数据/安全破坏；**P1=1直接不满足用户P1=0的通过标准**。9项P2已有明确处置方案，尚未实施或取得延期验收；主要页面仍有明确视觉缺口。不得以全CI成功、图像数量或此前合并记录宣告UI重构结束。

**最终判断：需要立即修复；需要最后一轮有范围的统一收尾；当前代码不适合进入正式发版测试。** 可以继续做开发回归和修复验证。先清除P1与影响实际使用的P2，再完成主要视觉项及作者外验收，之后才讨论正式发版测试；不建议迁移框架、重写状态架构或扩张未实现的参考功能。
