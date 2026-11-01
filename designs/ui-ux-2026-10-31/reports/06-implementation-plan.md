# 后续 UI 重构计划（未开始实施）

2026-11-01：视觉候选更新为 [Refined统一修订版](11-refinement-validation.md)，A/B保留为首轮探索。以下阶段尚未执行；冻结对象改为Refined、v2 Tokens及更新后的60项入口映射。已有owner、安全合同和产品验收边界保持原要求。

本计划以 `9694339ecee18383c34897fdd98fa79457598a83` 为勘察基线。远端 `main=eac79ca`，本地处于 `codex/fix-bugs-8-11`；实际实施前必须重新 fetch、核对差异并选择用户认可的基线。不能把本设计分支上的截图当作 main 或发布版的资格证明。

此阶段只交设计成果。以下所有修改、测试、提交和集成都尚未执行，也不构成合并、推送、发版授权。

## 依赖与实施顺序

| 阶段 | 依赖 | 范围与复用 | 交付 / 退出条件 | 风险与回滚边界 |
| --- | --- | --- | --- | --- |
| 0 设计冻结 | 人工验收本设计包 | 确认 Refined 方向、60项入口映射、Classic/Runtime差异、未实现状态 | 确定统一修订版布局与 v2 Tokens；把仍有分歧的交互逐项记录，不以“看起来不错”通过 | 仅文档与设计文件；保留A/B探索，不影响产品 |
| 1 Tokens 与基础组件 | 0 | 扩充现有 `public/tokens.css`；按 Button/Input/Menu/Dialog 等组件 owner 归并样式；复用 `ui/action-menu`、`ui/popover`、`ui/modal` | 两主题文字/控件对比度；默认、hover、pressed、selected、focus、disabled、error；不改变业务 handler | 现有兼容别名分期保留；按组件提交，可逐个回退。不得用后置全局覆盖压制旧规则 |
| 2 Shell、导航与设置容器 | 1 | 复用 `workspace-surface`、项目/会话导航与实例token；保留 Chat DOM；将设置目的地统一为带目录的 Surface | 52 Rail / 248 Sidebar / 52 Header；三尺寸无外层溢出；菜单锚定；设置往返保留草稿、焦点、阅读位置 | 不新建全局 store，不改排序键；先迁移容器，再逐项迁移原设置mount。可回退单个Surface |
| 3 Conversation、Tool、Composer | 1、2 | 复用 messages、Markdown、ToolEntry、附件链路、draft/runtime-draft、thinking-availability、发送/停止屏障 | 流式、长文、长路径、工具未知/失败、历史截断；Classic steer、Runtime禁用理由；IME与键盘；Pi回读前不显示设置成功 | 停止/迟到响应/owner隔离为关键风险。Classic与Runtime分别迁移，再统一视觉，不把能力差异改没 |
| 4 Work Panel 与复杂内容 | 1、2；聊天布局稳定 | 复用 `right-pane`几何唯一owner、`secondary-surface` disposers、`split-workbench`、原生Browser控制器 | Changes/Specs/Browser/协同/进程共用外壳；单面板与已有受支持分屏；拖动/缩放/遮挡/重新打开 | 先替换无业务外壳，再处理Diff。Browser DIP/zoom、detach/attach须真实Electron专项；不能由网页原型推断 |
| 5 资源页与敏感操作呈现 | 1–4 | 任务DAG/Attempt/Review/Verification，Skills/Extensions/Capabilities/MCP，供应商/认证，更新、诊断、日志 | 每项F01–F60有入口、状态、返回路径和能力原因；不新增假市场，不删除高级功能 | 认证、文件写入/撤销、候选采纳、进程权限、安装更新保持后端原契约；外观改动也核验确认与授权边界 |
| 6 资格验证与交付 | 各迁移阶段定向验证通过 | 完整canonical、独立复审、截图对照、打包、Windows窗口与升级资格分开记录 | 精确SHA完整证明；人工验收；无阻断项；风险有明确处置；生产前端改动重建产物 | 以每阶段可回滚提交为单位；打包与发布是后续独立决策，本计划不授予许可 |

不建议把以上阶段一次性合为一个大 PR。阶段1按共享组件形成可回滚单元；阶段2、3、4、5再分别形成可审阅的功能边界。测试基建、业务呈现、版本号若以后需要改动，按各自回滚边界拆开。

## 状态合同先于视觉替换

| 对象 | 必须保留的事实源 | 呈现要求与验收 |
| --- | --- | --- |
| 会话顺序 | Classic创建时间、Runtime持久createdAt；既有稳定排序 | 点击、hover、焦点、后台事件不改变排列；菜单槽位预留，字体权重不推挤相邻操作 |
| 草稿 | Classic会话/工作区键，Runtime稳定locator；owner/generation只作异步权限 | 切会话/任务/设置/右栏往返恢复文本、附件和阅读位置；刷新恢复依各自既有持久化规则，不套用PI-Desktop内存草稿策略 |
| 运行状态 | 现有Runtime/Classic权威状态与停止屏障 | idle/running/stopping/stopped/error/waiting-approval分开；后台完成不改变当前会话、不抢滚动 |
| 模型与思考 | providerId+modelId、原生Pi回读、三值能力 | 读取中/未知/失败有说明；选择尚未确认时保持pending；禁止仅本地改标签当成功 |
| 历史工具摘要 | 现有后端allowlist、安全投影与messagePosition | 不补造参数、输出、原始ID或Thinking；截断、未知位置与缺失分别说明 |
| Diff与评论 | Git范围、diff fingerprint、评论authority及stale状态 | 全工作区与会话过滤清楚区分；行/区间评论和候选任务资格不被“应用”按钮简化 |
| 撤销与采纳 | 原准备/预览/确认/nonce/冲突与恢复链 | 危险动作保留计划和范围审阅；不因新设计把确认层变成无实际权限的样式开关 |
| Browser | Electron bridge与原控制器、session、原生WebContentsView | Agent控制默认关闭；与外部Browser Use分开；弹窗/拖动/隐藏时遵循既有detach与几何提交 |
| 设置和更新 | 既有provider、auth、app-update、pi-update、diagnostics、logs模块 | 统一容器不合并事实源；应用更新与Pi更新分开；凭据不回显，导出先预览隐私范围 |

## 验证策略

1. 开发前读 AGENTS、REVIEW 与相关文档，记录准确基线的 CI run/event/attempt/gate；跑必要定向基线。没有可信基线或触及高风险边界，按测试政策补完整证明。
2. 开发循环使用现有模块套件与有价值的缺陷回归，不为每个样式数字写镜像断言。不删除原断言来“提速”。新增正式套件只登记到 `package.json` 的 test 链，CI递归展开；此计划不另抄测试清单。
3. 稳定后按仓库政策取得完整 `npm test` 或用户预先选择的当次 PR 完整canonical CI。未得到结果前写待验证，不从本设计原型检查推导生产通过。
4. 真正布局与交互使用真实浏览器/Electron截图，至少1280×800、1440×900、1920×1080，浅深主题；含长标题、长代码/命令/路径、多附件、数百模型、长工具活动、网络失败和不同消息长度。
5. 会话稳定性重点操作：在第8行选中→后台事件→切设置→返回；sA输入草稿→sB运行→sA；sA重试未结束→sB；停止未确认→切换→返回；核对行序、owner、草稿和滚动锚点。
6. 键盘与可访问性：Tab顺序，菜单↑↓/Home/End/Enter/Escape，菜单→Dialog→原触发器，disabled原因，非颜色状态，读屏标签，减少动态偏好。实体中文IME需现场验证，不用程序化事件冒充通过。
7. Windows真实125%/150%/200%缩放及窗口边缘；原生Browser + Dialog遮挡、split切换、拖动、DIP取整；这些是产品资格专项，原型的OS150%DPR和页面zoom不能替代全部条件。
8. 改完生产 `public/` 或 `server/` 后，按要求重建App/SEA并核对资源；源代码、打包后窗口、安装升级、签名是不同证据层。不要为本设计阶段重建或发布产品。

## 额外安全与独立审查

普通呈现变更按风险做作者自验和独立复审。认证、执行权限、文件写入/撤销、候选执行/采纳、安装更新、依赖、上游协议及CI/发版涉及高风险，保留独立功能和安全/故障注入审查，以及用户明确决策。AI意见和CI通过均不自动产生合并或发布权限。

首次完整审查覆盖整个迁移diff；后续集中检查新增修改与受影响边界，原则上最多连续三轮。问题必须有实际代码路径/复现证据；历史问题单列，不从旧截图推断当前生产有相同缺陷。

## 本轮明确未完成、不能冒领的资格

- 没有实施上述阶段，没有生产重构PR、提交或构建。
- 原型输入、模型切换、停止、重试、Diff、评论、浏览器页、设置均为演示状态，不证明真实Pi或业务后端。
- 没有真实模型E2E、实体IME、读屏器、所有物理DPI、原生Browser集成、完整打包窗口、安装升级或签名资格。
- PI-Desktop只研究官方历史运行截图与固定源码，没有本机启动其Rust/Electron应用。
- 下一步是用户验收设计与入口映射。通过后仍需另开实施授权与当时的基线审查。
