# Visual Replies P2 · 总体覆盖与未验证索引

日期：2026-11-27；这是 **E 交付时的证据快照**，不是最终 P2 通过声明。
实现线仍在集成，后续新增 diff、截图和专项结果必须以各自准确 SHA 追加，不能继承旧状态。
基线身份、逐叶 CI 证据、定向数字、注册机制与回滚见 [E 验收](visual-replies-p2-e-acceptance.md)。
总体计划由父任务维护在 `docs/visual-replies-p2-plan.md`；本索引不更改 A–D 所有权。

## 1. 状态与证据层不能混用

- `pass(E)`：E 执行并记录的指定代码状态，不是全产品通过。
- `baseline pass`：准确 dfdc1dde main push CI，仅原有 355 叶，不能证明新功能。
- `pending`：未执行或无可核验证据。文件存在、语法通过、fake Pi 启动不能改变此状态。
- `failed / blocked`：已有失败或验证被阻断，不能当作无失败放行。
- `N/A`：确实不适用，不能代替本应完成的验证。

| 层 | 含义 | 不可替代的其他证据 |
| --- | --- | --- |
| simulation | Node/jsdom/策略替身/受控 HTTP/真实后端+fake Pi/离线驱动自检 | 真 Pi、真模型、Chromium 沙箱、布局、产物 |
| real Pi contract | 实际 Pi 的工具注册/发现/参数/返回契约 | 模型实际调用、Electron UI、打包 |
| real model | 明确授权的供应商/模型实际发现并调用 html_render，保留脱敏摘要 | 其他模型、安全、重启、打包 |
| real Electron sandbox | 实际正常沙箱 Electron/Chromium，真实交互/布局/网络见证 | 真实模型、无插桩正式入口、产物一致性 |
| packaged | 准确源码重建后产物摘要、实际运行和相应场景 | 安装升级或其他未跑组合 |

## 2. P1 遗留 3.1–3.7 逐项覆盖

simulation 数字仅指 E 基线产品 + E 基建 `e67b0211623d23a17fb8486a3731509a79d86fb7`。
B/C/D 后续实现需其提交和父集成记录重新证明。

| 任务 | 责任线 / 必须核验的边界 | simulation 已有证据 | real Pi contract | real model | real Electron sandbox | packaged / 当前结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 3.1 真实调用闭环 | A：启动→发现→模型实际调用→发布→时间线→JS→继续流式→切换→重启 | process 8/8；模板7/7、驱动安全32/32；不是闭环 | pending | pending；E未调用模型 | pending 生产时间线真实交互 | pending；未完成真实闭环 |
| 3.2 Electron安全 | A：DOM/preload/IPC/Node/文件/凭证；网络/Worker/realm/导航/消息/跨权限/资源；保留正常功能 | policy24/24；listener自检不证明iframe封网 | N/A | N/A | **failed / blocked**：A首轮28/29、exit1；self-navigation-denied-blank；后续执行被策略阻断 | pending；发布安全资格阻断 |
| 3.3 分支继承 | B：branch/copy/edit-resend/history switch/原始删除/继承恢复/非法跨会话；前后端真实读取 | backend38/38含原始fork形状；不证明P2 Classic修复 | pending相关上游契约 | pending与3.1联验 | pending实际会话链 | pending；B修复待集成证明 |
| 3.4 GC/容量 | B：所有引用/回收站/Agent运行/发布未持久化/孤儿/扫描删除竞争/统计/错误 | Store135场景、529断言；backend含拒绝不完整扫描 | pending原生排他资格 | pending运行中发布窗口 | pending维护入口实测 | pending；未经证明不启自动删除 |
| 3.5 锁恢复 | B：正常/崩溃/强杀/中断/临时文件/PID复用/并发启动/旧owner/unknown | 既有Store拒绝遗留锁与故障路径；非P2恢复资格 | N/A | N/A | pending真实退出/重启 | pending；B身份恢复方案待证 |
| 3.6 性能 | B：先测再改、大量历史、多会话并发、完整性、索引恢复 | E没有优化前后同口径数据；一次process耗时不是基准 | N/A | N/A | pending UI/后端响应 | pending；不得填已优化 |
| 3.7 canonical/CI | E：backend/process注册；发现/分组；桌面与live独立；结果真实 | pass(E)：358叶精确覆盖、8叶Artifact+10叶CI exit0；无删除 | pending独立契约入口集成 | opt-out exit2；真正调用pending | 独立安全命令已注册；专项failed，手动workflow未执行 | 基线CI通过；新PR完整CI pending |

A 首轮报告已由 E 读取核验：
`C:/Users/21022/AppData/Local/Temp/pi-html-artifact-security-ymlgeK/report.json`。
实际 `completed=false`、`failed=1`、launch code `1`、28/29，Electron44.4.3 / Chromium152.0.7977.130 / win32。
这是集成fixture而非生产UI；同摘要离线runtime临时副本、正常sandbox，不是沙箱降级。
该首轮并未覆盖完后续攻击集合；E不接替或绕过被阻断执行。失败保留、阻断未解除。

## 3. P2 正式功能 4.1–4.7 逐项覆盖

T3 当前参考 SHA/路径/历史修复与可得运行对照由 C 提供，**本快照 pending**，不抄P1参考当P2新证据。

| 任务 | 所有者与必须覆盖的边界 | simulation | real Pi contract | real model | real Electron sandbox | packaged |
| --- | --- | --- | --- | --- | --- | --- |
| 4.1 全屏 | C：轻量悬浮入口；关闭/Escape/焦点/适窗/长内容/主题/释放/多Artifact；返回不跳底；不增权限 | 既有UI13/13非P2全屏；新覆盖pending | N/A | 与3.1联验pending | pending会话/全屏及阅读位置 | pending |
| 4.2 缩放响应式 | C：放大/缩小/重置/适宽；窄宽/全屏/DPI；SVG/Canvas/长表；不双重缩放 | pending新控件/协议 | N/A | 样例实际发布pending | pending每档尺寸/DPR/清晰度/滚动 | pending |
| 4.3 动态高度 | D：首次/字体/图片/JS/折叠/表格/连更/宽度/全屏/隐藏恢复/>4096内部滚动/限流 | 三个新D套件尚未集成E，pending | N/A | 样例实际发布pending | pending测量/抖动/无截断 | pending |
| 4.4 滚动阅读 | D：生成跟底/主动阅读停止/iframe滚轮/内外长滚/变高锚定/多Artifact/全屏返回/主题/分页/原跳底按钮 | pending阅读位置增量 | N/A | streaming联验pending | pending受信滚轮/键鼠/几何/位置差 | pending |
| 4.5 图片交互/链接 | C/D：图片/SVG/Tooltip/按钮/筛选/输入/动画/展开；严格source/origin/schema/id/nonce/URL/长度；用户动作与确认 | 既有source/id/nonce模拟不证明新协议；pending | N/A | 正常交互样例pending | pending实际图片/链接安全与可用性 | pending |
| 4.6 主题/视觉 | C/D：T3对照、Token/Icon/Button/Modal；无多层卡片/重复标题；深浅/首屏背景/图表对比与冗余标记 | 既有UI主题模拟通过；P2新主题pending | N/A | 样例配色实际输出pending | pending真实深浅/首屏/对比度截图 | pending |
| 4.7 多会话资源 | D：同会话多件/并行后台/分页/大量iframe/切换/最小化/全屏/退出；可见实例不重建；不加Agent数量限制 | 既有UI生命周期模拟通过；新资源机制pending | pending实际Pi生命周期 | pending多真实调用 | pending窗口/iframe计数、清理和交互状态 | pending |

## 4. 七类真实样例 × 必须组合

全部组合需要实际 Electron，优先正式产物。以下每格 `P` = **pending / 未运行**，不是推定失败或通过。
会话/全屏 × 深浅 × 宽窄的八格必须逐个给证据；不得用一张同图或一次API返回填整行。
宽窄须记实际viewport，不能只用标签；图表还须分别包含bar/line/pie。

| 样例 | 会话·深·宽 | 会话·深·窄 | 会话·浅·宽 | 会话·浅·窄 | 全屏·深·宽 | 全屏·深·窄 | 全屏·浅·宽 | 全屏·浅·窄 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 仓库整理前后对比报告 | P | P | P | P | P | P | P | P |
| S2 bar / line / pie（三个子例各登记） | P | P | P | P | P | P | P | P |
| S3 SVG架构/流程 | P | P | P | P | P | P | P | P |
| S4 筛选器/按钮交互面板 | P | P | P | P | P | P | P | P |
| S5 长表/动态展开 | P | P | P | P | P | P | P | P |
| S6 内嵌图片报告 | P | P | P | P | P | P | P | P |
| S7 恶意HTML | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked |

S7 的局部 28/29 首轮失败不是以上任意八格的完整证明，保持阻断。不得因新增workflow可执行就补成通过。

| 样例 | Zoom放大/缩小/重置/适宽+DPR | Height首次/加载/JS/连更/隐藏/>4096 | Scroll跟底/主动阅读/内外/变高/返回 | Multi同会话/并行/后台/分页 | Switch交互态/引用恢复 | Restart持久HTML/临时态语义 |
| --- | --- | --- | --- | --- | --- | --- |
| S1 对比报告 | P | P | P | P | P | P |
| S2 bar/line/pie，各子例 | P | P | P | P | P | P |
| S3 SVG | P | P | P | P | P | P |
| S4 交互面板 | P | P | P | P | P | P |
| S5 长表动态展开 | P | P | P | P | P | P |
| S6 内嵌图片 | P | P | P | P | P | P |
| S7 恶意HTML | blocked | blocked | blocked | blocked | blocked | blocked |

后续证据须按 `(样例, 子例, layer, 深浅, viewport, DPR, 会话/全屏, zoom, height, scroll, multi, switch, restart)`
记录实际覆盖元组；只做某组合，便只更新那一组合。持续交互状态与不可变快照分别判断，重启不能伪造恢复内存筛选器。

## 5. 最小证据登记与最终门槛

每次实际运行至少记录：

- 准确源码/集成SHA与未提交差异；平台/Node/Electron/Chromium；入口是源码、观察bootstrap还是正式产物。
- 正常sandbox参数及runtime摘要；viewport/DPR、主题、Artifact数量、步骤与真实操作。
- 实际通过/失败/skip、退出码、首次失败与重跑；skip不计分子分母，计数减少逐条解释。
- 截图路径及查看结论；必要的几何/滚动位置/资源计数/完整性摘要，不只说图片存在。
- Pi契约/真实模型授权及调用结构摘要、发布ref/恢复结果；不留key、用户内容或原始模型payload。
- 日志/报告路径及证据层；打包另记构建命令、产物版本/摘要、实际运行，不用源码结果替代。

最终仍需：A–D准确集成后定向回归、最终canonical当前PR CI、真实普通交互/真实Pi契约/授权模型、正常沙箱安全、正式重建/产物、新上下文独立功能与安全审查。
本线不重复完整基线、不运行付费模型或新下载、不修改远端设置/branch protection、不push/PR/merge/release。

**快照结论：** E规范链修补已有本地定向证据；基线355叶CI通过。当前P2完整canonical为pending；真实视觉/模型/打包矩阵pending；安全专项failed/blocked。
开发完成、代码验收、合并许可、发布许可四阶段分开，不能由本表推导后一阶段。
P3的preview/headless/自动截图反馈/外部资源代理和MCP Apps均不在本期覆盖，不能填成已完成。
