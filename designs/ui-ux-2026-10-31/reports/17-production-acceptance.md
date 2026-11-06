> 2026-11-06 第二轮瘦身：本页移除的历史截图/完整日志链接固定到清理前提交 `2e70463183218ddf3a10972789667d6be5c294df`；原始结果和失败记录保留，不能作为当前代码通过证明。

# Refined 生产实施与验收记录

> 第二轮 Runtime、设置详情与最终验证见 [21-completion-acceptance.md](21-completion-acceptance.md)。本文件保留首轮生产改造和证据历史。

日期：2026-11-01。用户已在设计审阅后授权开始生产实施。本记录与此前仅设计阶段分开；原型的 435/435、200/200、388/388 不作为产品证明。

## 范围与身份

- 分支：`codex/ui-refined-implementation`；before/after HEAD 均为 `eac79cab793cff26c6cb6aa01cc9d9276ce06606`，变更尚未提交。
- 基线：[main push CI 40678496026](https://github.com/HYJ1817/pi-gui/actions/runs/40678496026)，attempt 1；计划、五组完整 canonical、打包及 CI gate 成功。它只证明基线。
- 现有 `designs/` 与未跟踪的 `docs/superpowers/plans/2026-10-22-project-development-governance.md` 均保留；未合并其他开发分支，未改业务接口、数据模型或依赖。
- 最终测试输入身份由 [input-snapshot.json](../evidence/production-canonical-frozen/input-snapshot.json) 绑定；[run.json](../evidence/production-canonical-frozen/run.json) 记录完整测试的实时状态、最终退出码与输入是否变化。未结束或无结果均不能认定通过。

## 实际交付

| 部位 | 变更 | 保留的 owner |
| --- | --- | --- |
| 全局样式 | 中性浅深主题，Windows 系统字体，15px 正文 / 760px 阅读轴，一体化 18px Composer，选中/焦点/禁用状态 | 现有 tokens、各所属组件样式、Electron theme bridge |
| Shell | 展开时一列 264px 侧栏；折叠后显示展开入口；项目/会话行排序不变 | projects、sessions、runtime-nav、workspace-surface |
| 设置 | 目录替换会话列表，任务与审阅、Skills 与扩展归入工作区组；返回保留聊天节点、草稿、阅读位置 | workspace-surface；资源与 Planner 原 mount/dispose |
| 设置叶子 | 供应商、认证、更新、日志、诊断、外观等继续调用原表单和确认层 | 各业务模块与 modal，不劫持认证/异步生命周期 |
| Runtime 往返 | captured-owner focus 重新绑定后端焦点与原右栏/Git scope；拒绝时留在设置提示重试；迟到响应不能替换新导航 | runtime-nav、runtime-secondary、runtime-conversation、Git scope |
| 工作面板 | 顶栏统一开关；Changes、Browser、Specs、协同、分支树在右栏内；关闭回可见总入口；设置页亦保留该入口 | right-pane、secondary-surface、既有分屏与原生 Browser 控制器 |
| 模型菜单 | 无装饰性下箭头；按名称、ID、Provider 本地过滤；空结果、键盘与焦点恢复 | 原模型列表、Provider+ID、Pi 回读、popover；不发搜索请求 |
| 工具活动 | 多项默认折叠，保留真实状态计数；展开不重建工具节点，后续事件不重置手动选择 | ToolEntry、tool-view、实时与历史原边界 |
| 输入辅助 | 保留真实 `/` 注册表与上下文已用百分比、统计详情 | inline-command-menu、usage；未复制原型演示数据，未新增 @ 能力 |

完整入口映射见 [18-production-feature-map.csv](18-production-feature-map.csv)，共 60 项。该表区分入口复用与实际专项验证，不声称每项均已跑真实模型 E2E。

## 实际验证

| 证明层 | 命令 / 入口 | 已取得的结果与边界 |
| --- | --- | --- |
| 导航回归 | `node tests/ui-ia.cjs` | **18/18**；包括 Classic 节点/草稿/滚动，Runtime blur/focus、拒绝、迟到返回，以及设置内工作面板关闭焦点 |
| 模型视图 | `node tests/ui3-model.cjs` | **53/53**；原 50 项保留，新增过滤/折叠恢复、键盘、无匹配/Escape 3 项 |
| 输入集成 | `node tests/ui3-integration.cjs` | **23/23**；Slash、IME 事件守卫、模型身份与发送路径 |
| 其他定向 | 现有 composer、theme、stable-session-order、Runtime、Browser、split、UI4、modules、body 等 | 首轮 20 套中 18 套通过；smoke 与 split 的旧入口/宽度断言迁移后分别 **1338/1338、30/30**；最终累计 canonical 已覆盖。早期证明不冒充最终整包证明 |
| 布局检查 | `node tests/ui2-visual.cjs` | 更新已批准的 760px / 15px / 中性色预期后 **57/57**；原 57 个检查保留。最终累计 canonical 已再次执行 |
| 源码 Electron | `tools/verify-production-ui.cjs` | 正常沙箱；生产 main/preload/renderer + TEMP 离线可视 fixture；三尺寸双主题、菜单、设置、任务、扩展、上下文、Slash、长内容、工具折叠、页面 zoom；**49/49、49 张主窗口截图**；最终结果见 [capture-results.json](../evidence/production-refined-verified/capture-results.json) |
| Diff / 运行与失败补验 | 同一驱动 `--supplement` | **10/10**；三尺寸双主题实际 Diff，加运行中 Stop、工具失败，以及原生 insertText 输入模型搜索/无匹配。补充 10 个去重页面；记录见 [supplement-results.json](../evidence/production-refined-verified/supplement-results.json) |
| 色彩检查 | `tools/audit-production-contrast.cjs` | **52/52**；文字4.5、焦点与控件边界3阈值；排除禁用文字与装饰性细线，不等于完整可访问性认证 |
| 原生 Browser | 同一源码 Electron QA | 独立 loopback 页面，经原地址框 handler → preload → 控制器实际导航；单独保存原生页截图；额外矩阵 **11/11**，覆盖三目标尺寸、760px、125%/150%页面zoom、Modal遮挡与表单恢复、设置detach，见 [矩阵结果](../evidence/production-browser-matrix/capture-results.json)。地址框为 DOM keydown，不冒充实体键盘或 IME 证明 |
| 打包 | `npm run build:app -- --rebuild --output-root <独立目录>` | 使用现有 Electron ZIP 离线重建。未覆盖安装目录；日志见 [production-build-final.log](../evidence/production-build-final.log) |
| 打包真实窗口 | `tools/verify-production-package.cjs` | 实际新 exe + 随包 renderer/preload + TEMP 离线 fixture；**147 个前端资源摘要相同，5/5 检查，3 张真实截图**。不冒充真实后端或模型 E2E |
| 打包后端 | `node tests/app-check.cjs --output-root <最终目录>` | **26/26**；缺失的 TEMP PDF fixture 用既有 `npm run fixtures` 离线生成后重跑。源码/打包 UI、打包后端、安装升级分别判断 |
| 交付摘要复核 | 只读 SHA256 比对 | **699 个冻结输入文件未变化、147 个前端资源一致**；exe、server.cjs、main.cjs 与构建清单一致，见 [最终摘要检查](../evidence/production-final-integrity.json)。这不是重复的窗口或后端测试 |
| 完整 canonical | `npm test` + 同清单累计续跑 | **累计 231 条命令执行完成；不是单次 npm test 成功**。原始完整运行退出码1、1215.881秒，前106条完成后遇环境阻断；第107–231条按同清单续跑，**125/125 条退出码0、3189.601秒**，2026-11-01 15:35:58 +08:00结束。前后输入摘要相同。见 [续跑记录](../evidence/production-canonical-continuation/run.json)；[原始日志](https://github.com/HYJ1817/pi-gui/blob/2e70463183218ddf3a10972789667d6be5c294df/designs/ui-ux-2026-10-31/evidence/production-canonical-frozen/npm-test.log) 与 [run.json](../evidence/production-canonical-frozen/run.json) 保留初始失败。SACL和符号链接跳过场景不计入成功断言，明细见第14项 |

### 截图与人工视觉检查

使用 [生产截图图库](../production-review.html) 查看。源码版正文、模型、面板、设置与任务页覆盖 1280×800、1440×900、1920×1080，浅/深两主题；125%/150% 为页面 zoom 专项，不能等同所有物理 DPI。当前 Windows DPR 1.5，PNG 的物理像素大于 CSS 客户区；每张实际尺寸在 observations 中保留。

作者已实际查看正常聊天、展开工具、模型菜单、设置、窄右栏及打包窗口截图，检查阅读轴、按钮可见性、弹层边界与对齐。修复了窄右栏标题/按钮挤压及重复关闭入口；重新截图。原生页图片单独保存，未把父窗口和子页像素合成。

## 失败、修复与审查历史

1. 入口新回归先失败，迁移后通过。原 smoke 的全局危险元素扫描被新的持久工具栏 SVG 命中，改为扫描原业务 `.rp-body` 范围；恶意文件名注入覆盖保留，未删除断言。
2. UI2 视觉检查首轮 47/57；旧字号/阅读宽度/中性色及“工具初始展开”的预期与已确认设计冲突。更新预期并实际展开工具后 57/57。Classic 工具测试由 48 增至 49，未减少覆盖。
3. 独立审查共三轮：Runtime 返回最初只恢复 DOM，随后发现后端 blur/focus 也需恢复；通过原 focus 路径修复并增加拒绝/迟到回归。Composer 焦点环、浅色 Specs 标记对比度同时修复。第三轮无未处置 Blocker/Important。审查者当时独立模型测试 51/51，之后作者新增两项键盘回归达到 53/53，两者范围分开。
4. 此后额外发现设置内总开关被隐藏会使程序化工作工具入口的关闭焦点落到隐藏元素。恢复原先各工作视图均可访问工具的语义，一行修复；新增红/绿回归，导航由 17 增至 18。该一行后未另开第四轮自动审查，保留人工验收；完整链按修复后的固定输入重新启动。
5. 早期 `npm test` 会话与 TEMP 日志不可用，结果未知、不复用。持久日志运行 `production-canonical-final` 为冻结最后一行修复而主动取消；有效完整运行是 `production-canonical-frozen`，不得累计旧前缀冒充单次完整通过。
6. 首次离线构建选错 Electron ZIP 目录（41.1.1，而当前依赖为44.4.3），无下载；改用本机匹配 ZIP。早期构建已过期，最终构建路径单独记录。
7. 源码截图驱动曾捕获旧帧；改为聚焦窗口、等待两帧并检查真实 Surface。普通会话 fixture 注入曾有字符串换行语法错误，修复驱动后重拍。旧失败记录保留，不计入最终图集资格。
8. 原生 Browser fixture 起初误用应用自己的回环端口，被既有安全策略正确拒绝。改用独立端口，没有放宽产品策略。
9. 最终打包后端首轮 **19/21**，原因是 TEMP PDF fixture 不存在，导致上传步骤未执行、缓存目录亦不存在。离线 `npm run fixtures` 成功后完整重跑 **26/26**；新增数量来自恢复执行的 PDF/DOCX/图片断言，不是放宽或删除检查。
10. Diff 补验首次在重开面板时将已恢复展开的条目再次点成收起；修正驱动尊重原有恢复状态后六档均通过，没有修改产品。
11. 既有 `node tests/electron-smoke.cjs` 两次在原生页 capture 阶段报 `UnknownVizError`，只有此前三个检查执行，专项整体失败；记录在 production-native / production-native-retry。源码可视 fixture 的正常沙箱原生页截图、几何与 detach 另有成功证明，但不能将前述生产后端专项改称通过。

12. 原始固定输入完整链在 `session-revert-sacl-witness.cjs` 停止，`witness_unavailable`。已复现为本机 PowerShell 签名策略阻止 fixture（无结构化输出），没有修改产品或系统策略。仅在受控测试子进程使用 `PSExecutionPolicyPreference=Bypass` 后，真实 witness 返回 auditError=1300、0/0、8 skipped。结束时 `Get-ExecutionPolicy -List` 确认 LocalMachine=RemoteSigned，Process/CurrentUser/MachinePolicy/UserPolicy=Undefined；不提权，不将8个场景计为通过。随后直接复用现有 `createTestGroupPlan` 从同一 package.json 展开的第107条续跑，共231条叶命令；完整来源、失败、重跑与环境差异均保留，最终只能称累计验证。
13. 可选 `node tests/ui3-model.cjs --real` 为 **124/132**（53 个契约检查 + 79 个真实渲染检查中的71个）。8条失败均查询 `.pop-provider-chev` 后直接读 textContent；已核对基线 HEAD 的 renderer 也只 `header.append(name,count)`，从未创建该装饰箭头，故为历史过期断言。本轮没有为满足它重新添加箭头或删除检查；未改该非canonical测试文件，完整输入保持冻结。新增搜索在实际 Electron 中通过原生 insertText 验证匹配与空结果。此可选套件不能称为全部通过。
14. 环境跳过按套件单列，不计入成功断言：原始前缀中 collab-store 的文件符号链接 1 项、candidate-adoption 的文件符号链接 1 项、诊断日志的符号链接 1 项因当前令牌无创建权限跳过；累计后段原 SACL witness 为 **0/0、skipped=8**，研究用原地恢复检查为 **28/28、skipped=2**（protected/inherited 非空 SACL），对象 writer witness 为 **0/0、skipped=8**。后三者没有取得审计权限，不据此升级生产资格。日志共明确列出 **21 个环境跳过场景**，所有命令的退出码不能代替这些未执行场景的证据。

## 限制、验收与回退

- 未调用真实模型，未写用户真实项目/会话，未验证实体中文 IME、读屏器、全套物理125%/150%/200% DPI、长期使用与真实安装升级。
- Classic 与 Runtime 保留实际差异：Runtime 原生 select/实时 pre 输出与附件能力未伪装为 Classic 同等能力；本轮统一 tokens、导航与生命周期，不重写 RPC 或历史投影。
- 设置叶子仍为真实 Modal，未迁成原型中的纯演示内嵌表单。分支树实际位于工作面板；开发进程仍由会话 More/Runtime 原入口调用。入口差异在 60 项映射中明确记录。
- 生产功能代码可按本分支所列 UI 文件逐项回退至 before HEAD；操作前先区分其他用户改动。没有执行自动回滚、提交、推送、合并、tag、发布、安装或替换用户正在使用的程序。
- 本地验收入口是 [最终构建路径](../evidence/production-build-final-path.txt)。退出旧版后手动运行新 exe 才会看到新界面；现有已安装程序不会因修改源码自动升级。
- 首轮生产 UI 已实施，实际截图、构建与累计 canonical 记录已归档，可进行人工验收；保留上述环境跳过、两个未全通过专项与真实模型/实体 IME等未验证范围。当前停止，不自行进入提交、安装或发布阶段。
