# pi-GUI UI/UX 设计审计

审计日期：2026-10-31。结论是保留既有业务与状态边界，统一呈现、组件和入口层级。当前应用已经有双主题 Tokens、稳定排序、草稿、可访问菜单和工作面板生命周期；“全部从零重写”会增加风险，并不能解释目前主要的视觉割裂。

## 基线、方法与证据

- 当前分支 `codex/fix-bugs-8-11`，HEAD `9694339ecee18383c34897fdd98fa79457598a83`。开始时只有未跟踪的 `docs/superpowers/plans/2026-10-22-project-development-governance.md`，本轮保留。
- 已 fetch/tags：`origin/main=eac79cab793cff26c6cb6aa01cc9d9276ce06606`，最新 Release 为 [v0.30.1](https://github.com/HYJ1817/pi-gui/releases/tag/v0.30.1)。没有 checkout、合并、提交、推送或发版。
- HEAD 的成功CI记录：[40640669481](https://github.com/HYJ1817/pi-gui/actions/runs/40640669481)，pull_request，attempt 1，completed/success。它证明基线，不证明本设计原型；本轮未重新下载其完整测试artifact或重新认定每个canonical叶命令。
- 阅读 README、AGENTS、REVIEW、文档导航及架构/UI/Composer/工作区/测试文档；实现与入口以当前HEAD为准。详见 [源码审计](source-audit-notes.md) 与 [60项功能映射](05-feature-map.md)。
- 使用仓库已安装 Electron，实际加载 `electron/main.cjs`、preload和生产 `public/`，后端替换为仓库现有 `tests/visual-harness.cjs`。应用身份proxy只服务本轮离线fixture，日志、上传、userData都在 `os.tmpdir()`。不调用真实Pi、不写用户项目/会话、不访问模型。
- 原版证据：`evidence/current/capture-results.json` 与 `supplement-results.json`，对应PNG均为真实Chromium渲染。不是jsdom布局，也不是手绘的“现状截图”。截图夹具的模型、项目名、日志与任务不是用户当前状态。
- 原版与原型均请求1280×800、1440×900、1920×1080客户区。生产原版 `devicePixelRatio=1.5`，1440×900截图为2160×1350物理像素；最终原型使用真实Chromium离屏渲染，DPR1且高度取整多1 CSS px。各图实际尺寸见04记录，不能把图片像素直接当布局CSS px。
- 本阶段没有修改产品代码、测试入口或构建输入，因此未运行完整 `npm test`、未重建产品安装包；独立原型与设计系统验证单独记录，不能称生产canonical通过。

## 当前实测的形态

1440×900深色聊天：Rail 52px，项目侧栏236px，左侧合计288px；正文/Composer最大约768px。Composer为输入表面加下方工具条，整体75px高。打开Changes时右栏420px，中间Composer缩至658px。页面外宽1440px，没有观察到外层横向溢出。1920×1080时阅读带仍约768px，没有让正文无限拉长。

这些基础比例本身已经接近专业桌面工具。主要改善机会在控件与内容层级：顶栏关联任务长胶囊与多个图标竞争空间，设置的目的地形式不同，工具组边框与嵌套输出使长会话密度增加，Classic/Runtime呈现模式差别明显。

## 审计发现与改进优先级

优先级：P1直接影响主要工作流、状态理解或迁移安全；P2改善一致性、效率与可读性。以下均为本轮变更前已有形态或待实测项，不是本轮引入的生产缺陷。证据列明确区分真实截图、源码确认和未复现。

| ID / 优先级 | 当前状况与证据 | 体验影响 | 改进方案 / 验收 |
| --- | --- | --- | --- |
| A01 P1 | Classic底部Composer，Runtime顶部select/按钮组与pre输出。`runtime-conversation.js:243-274,364-385`；Runtime现场截图未取得 | 切换会话类型时主要操作位置和阅读方式改变 | 共享视觉anatomy，保留不同owner与能力；不能给Runtime伪装附件/steer |
| A02 P1 | 顶栏关联任务摘要、展开/查看动作、分支和多个工具图标同排；`dark-1440-chat.png` | 标题与低频关系信息争抢水平空间 | 标题优先；任务关系缩为数量/状态入口；Changes/Browser有短文字，其余统一工作工具菜单 |
| A03 P1 | 设置菜单7组，目的地分别是modal、中央surface或另一个弹窗；`dark-1440-settings-menu.png`，`index.html:63-88` | 用户难预测打开形式、返回位置和焦点 | 单一Settings Surface及目录；仅保留需要中断的真实确认/编辑Dialog，复用原业务mount |
| A04 P1 | Classic会话More是中心modal列表，项目/行操作是锚定菜单；`app.js:906-950` | 相近操作采用不同浮层范式，More离开触发点遮住聊天 | More使用既有action-menu；表单和危险确认继续Dialog；Escape返回触发器 |
| A05 P2 | 上下文6%同时出现在侧栏与Composer；`dark-1440-chat.png` | 同一指标重复常驻，占用侧栏底部 | 当前上下文仅在Composer摘要，详情保留统计入口；侧栏底部用于工作区身份 |
| A06 P1 | 已有Tokens，但CSS仍有多种近似字号和圆角；源码清单见system/project/Original-Inventory.md | 页面靠累计覆盖维持外观，后续维护难判断组件最终规则 | 按组件owner收口；状态/尺寸命名，不用全局后置覆盖；旧兼容别名分期移除 |
| A07 P2 | Specs与工具状态存在9–10.5px辅助字号；`specs.css:43,127,152,184`、`styles.css:520` | 在低分辨率和缩放下可能难读；不是仅凭数字判定缺陷 | 采用少量caption/UI/prose层级，实际Windows字体和125/150%DPI复验 |
| A08 P2 | icon-btn 26px、项目三点22px、折叠16px；`styles.css:121-123,183-198` | 点击区域和焦点反馈不一致 | 图标16px；常规目标32/36px，密集树可保留小视觉并扩hit-area；不press-scale会话行 |
| A09 P2 | Tooltip多为原生title，历史导航有自定义tooltip；projects/attachments/conversation-nav | 延迟、键盘触发与边缘定位不同 | 一个Tooltip规范；必要信息不能只藏tooltip；长路径保留可访问全称 |
| A10 P1 | Composer主规则与UI3后置规则共同决定布局；`styles.css:602-605`、`ui3-composer.css:2-25` | 改附件、多行或stop状态时容易影响其它几何 | 输入、附件托盘、模型/思考、发送/停止和状态说明各有固定区域；迁移时合并归属规则 |
| A11 P2 | 工具组外框、逐行分隔、展开输出pre边框叠加；`dark-1440-btnModel.png`、`dark-1440-tools.png` | 长调用链的边框比内容更突出，错误与概要难快速扫描 | 连续细时间线；工具名/状态/路径/耗时一行；只有详情和错误使用轻表面 |
| A12 P1 | 模型能力有未知状态，思考以Pi回读为准；已有三值契约 | 纯视觉简化容易把未知写成不可用或假成功 | Picker明确供应商+模型身份；loading/pending/error分开；disabled给原因；保留后端权威 |
| A13 P1 | Runtime历史是受限工具摘要，不含完整Thinking与用量，位置可未确认 | 重新画时间线容易补造敏感内容或成功状态 | 只读/来源/未知/截断明确标识；不造参数输出；承认历史与实时证据不同 |
| A14 P1 | 当前右栏几何/分屏/原生Browser由专有owner控制；`right-pane.js`、secondary/split | 用一般网页drawer替换会破坏DIP、遮挡和生命周期 | 统一外壳外观，继续使用right-pane唯一几何owner和既有detach规则；原生专项单列 |
| A15 P1 | Browser仅桌面bridge可用；外部Browser Use与内置Agent Control权限不同 | 借鉴参考项目时容易加出无实际能力的按钮或假审批 | 桌面能力按真实探测显示；原型持续标“本地示意”，不开外部浏览或控制权限 |
| A16 P1 | Diff可有全部/本会话、行评论、候选执行、采纳、撤销资格 | 为了界面简洁删掉来源/资格会产生错误决策 | 主操作少而清晰；scope、stale、预览/确认保留；低频动作进二级菜单，业务语义不削减 |
| A17 P2 | Skills界面同时呈现发现、启用、加载、项目不信任说明；`dark-1440-navExtensions.png` | 状态信息真实但词语和层级较密集 | 固定名称→说明→来源→启用/观察状态；三值保留；信任问题就地说明；不改成假市场 |
| A18 P1 | 应用更新与Pi更新是独立模块，设置入口同组；`navAppUpdates` | 合并成一个“更新”状态可能掩盖不同确认、下载和重启边界 | 同页分段表达两个版本/状态；安装版与便携行为独立，原模块授权和回滚不变 |
| A19 P2 | 诊断、日志、故障导出含较多结构信息；`dark-1440-navDiagnostics.png`、`navLogs.png` | 技术说明与常用恢复动作可能竞争注意力 | 默认摘要与下一步，详情按需展开；导出先预览范围；不存原始payload或凭据 |
| A20 P1 | 文档含历史入口；源码已有Worktree、协同、可视化、评论/候选高级能力 | 只照任务列表或旧文档会遗漏已有能力 | 以F01–F60逐项映射并审查；可视化从消息卡打开，不造空图表按钮；实施前再核HEAD |

## 用户列出的常见问题：本轮结论

| 关注项 | 结论与下一步 |
| --- | --- |
| 点击会话排列跳动 | 当前已有稳定排序；未在本轮证明仍有缺陷。新原型实际比较四行的identity、顺序与Y坐标，并验证改名/选中不重排 |
| 草稿、滚动与运行状态丢失 | 原实现有恢复合同；不能写成确定缺陷。原型按sid保存并实际验证；产品整合后需覆盖真实Runtime、reload与stop barrier |
| 弹窗定位和遮挡 | action-menu已portal/flip/clamp，不能声称普遍错误。新原型锚定与Dialog焦点已迭代；Browser native遮挡仍属产品专项 |
| 通知重复 | 当前已有30秒去重、replay压制与成功静默；未复现频繁通知。新规范保留这些纪律，错误优先就地显示 |
| 长文本溢出 | 原版三尺寸观察未见外层横向溢出；新原型代码/Diff局部滚动，矩阵记录pageWidth，不把自动几何等同视觉验收 |
| 面板缩放、窗口变化 | 新原型覆盖三尺寸和页面125/150% zoom；本机真实OS DPR1.5。不能推断其它物理DPI、原生Browser或安装版窗口通过 |
| loading/error/disabled反馈 | 原版已有多种状态；重构统一词语、位置与原因。原型实际展示模型确认、运行、停止等待、失败重试和Runtime附件不可用 |

## 方案取舍

推荐A「工作台」为统一方向：52px Rail、248px侧栏、52px顶栏、780px阅读带、420px常规右栏、36px会话行和10px Composer圆角。浅深主题保持几何不变；蓝只用于焦点、选中和链接，主按钮中性，错误/运行有文字。

B「阅读空间」保留为可运行对照：264px侧栏、64px顶栏、860px阅读带、42px会话行、较大的正文行高。它适合长文阅读，但在1280×800与右栏同时打开时首屏信息量较少，工具密集工作中滚动更多。两方向没有增加不同业务入口或新框架。

选择A是本轮设计建议，**不是用户已批准设计**。详细视觉与交互证据见 [04验收记录](04-visual-validation.md)；实施顺序与资格边界见 [06实施计划](06-implementation-plan.md)。
