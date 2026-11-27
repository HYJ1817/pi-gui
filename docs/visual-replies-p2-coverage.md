# Visual Replies P2 · 总体覆盖与未验证索引

日期：2026-11-27；本索引保留 E / E2 历史，追加 **E3：B 成组集成后的四叶登记与一次完整离线 Artifact 子链**，不是最终 P2 通过声明。
E2 历史身份见 [E 验收第 8 节](visual-replies-p2-e-acceptance.md#8-e2首批集成后的登记与定向结果)；E3 实测状态为 `e44686951bc1658109554d6530b54ba858a35027` 加 package/guard diff（行为产品树与任务入口 `4649ac53` 一致，父新增提交仅 plan 文档）。测试链交付 `403e0cf9b4573048e8e87da8952a27781f431323`，完整证据见 [E3 验收](visual-replies-p2-e-acceptance.md#10-e3b-成组集成后的四叶登记与一次离线子链)。
B3/B2 已成组集成；D2 生产与六项测试已集成；C feedback/presentation ACK 消费端仍在修改。C/D 的定向证据与 R-D 四项未决 Important 分开登记，不能把测试通过写成审查通过。
后续新增行为 diff、截图和专项结果必须以各自准确 SHA 追加，不能继承本次被测树的结论。
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

历史范围：E2 首批在 `a2cdaeb0` 加登记 diff 的状态复验 D **38/38**、normal **7/7**；旧 UI **10 pass / 3 fail / skip 0** 保留为修前历史。C 后续交付 UI **20/20、169 断言**（原 13 项/111 断言保留）、联合 D **58/58**；E2 于 `0aacdb53` 单跑 UI 为 20/169，不能将 C 的联合结果冒充 E2 实测。
**本表当前 simulation 采用 E3 的同一次 16 叶 alias 实测**：model8、UI20/169、Store135场景/529断言/另skip3、backend38、process8、policy24、driver7/safety32、D **44/44**（layout13/frame19/reading12）、normal7、branches17/372、lock14/103、maintenance20/119、默认perf16断言；均 exit0，除 Store 既有 skip3 外 fail/skip 均0。不同数字的单位不能混加成总断言数。
R-D 首轮仍为 **不通过，Important 4 未关闭**；D2 的六个新增 Node 回归通过不解除 C 消费端、真实专项和增量复审要求。表中同一套件跨行引用不能重复相加。

| 任务 | 责任线 / 必须核验的边界 | simulation 已有证据 | real Pi contract | real model | real Electron sandbox | packaged / 当前结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 3.1 真实调用闭环 | A：启动→发现→模型实际调用→发布→时间线→JS→继续流式→切换→重启 | process 8/8；模板7/7、驱动安全32/32；不是闭环 | pending | pending；E未调用模型 | pending 生产时间线真实交互 | pending；未完成真实闭环 |
| 3.2 Electron安全 | A：DOM/preload/IPC/Node/文件/凭证；网络/Worker/realm/导航/消息/跨权限/资源；保留正常功能 | policy24/24；listener自检不证明iframe封网 | N/A | N/A | **failed / blocked**：A首轮28/29、exit1；self-navigation-denied-blank；后续执行被策略阻断 | pending；发布安全资格阻断 |
| 3.3 分支继承 | B：branch/copy/edit-resend/history switch/原始删除/继承恢复/非法跨会话；前后端真实读取 | E3 branches **17/17、372断言**，backend38/38；受控原生形状 + 实际API/HTTP/Store/共享viewer，B产品已集成 | pending相关上游契约 | pending与3.1联验 | pending实际会话链 | pending；模拟通过不等于桌面/产物通过 |
| 3.4 GC/容量 | B：所有引用/回收站/Agent运行/发布未持久化/孤儿/扫描删除竞争/统计/错误 | E3 Store **135场景/529断言/另skip3**，maintenance **20/20、119断言**，backend38/38；已验证候选扫描/统计/拒绝无原生互斥删除 | pending原生排他资格 | pending运行中发布窗口 | pending维护入口桌面实测 | **自动GC/容量回收未完成**；candidates-only/fail-closed已集成并定向通过，不再是尚待集成的收紧 |
| 3.5 锁恢复 | B：正常/崩溃/强杀/中断/临时文件/PID复用/并发启动/旧owner/unknown | E3 lock **14/14、103断言、skip0**；TEMP真实自有进程/内核门控与身份故障，旧/unknown/torn记录保留 | N/A | N/A | pending桌面退出/重启 | pending其他平台/产物；不从本机Node资格外推 |
| 3.6 性能 | B：先测再改、大量历史、多会话并发、完整性、索引恢复 | E3默认回归 **16/16断言**，8并发749.883ms、读65648bytes、digest一致；未跑benchmark。作者转报同口径中位6823.011→3735.489ms仅作对照，非E3实测 | N/A | N/A | pending UI/后端响应 | pending大规模/产物；小回归不等于全面性能资格 |
| 3.7 canonical/CI | E：backend/process与已到齐新套件注册；发现/分组；桌面与live独立；结果真实 | E3 **366叶**计划覆盖，原362全保留、新增4、删除/重复/换组0；guard **15/15**，必要计划/workflow守卫exit0；一次离线Artifact **16叶全部exit0** | pending独立契约入口集成 | opt-out exit2；真正调用pending | 独立安全命令保留；专项failed，手动workflow未执行；E3未运行桌面 | 当前PR完整CI **pending**，尚未push/PR；旧355叶CI不能替代366叶 |

**Classic 历史范围差异：** 父已确认 `session-navigation.js` 的 bounded text-only 只读历史预览是有意契约，本批不扩 UI；该页面的可视化展示是 P1 既有范围差异。`fetchHistory` 与共享 viewer 的回归不能证明该只读预览页面已支持可视化；活动 Classic 恢复及 Runtime live/dormant 渲染链分别判断。

A 首轮报告已由 E 读取核验：
`C:/Users/21022/AppData/Local/Temp/pi-html-artifact-security-ymlgeK/report.json`。
实际 `completed=false`、`failed=1`、launch code `1`、28/29，Electron44.4.3 / Chromium152.0.7977.130 / win32。
这是集成fixture而非生产UI；同摘要离线runtime临时副本、正常sandbox，不是沙箱降级。
该首轮并未覆盖完后续攻击集合；E不接替或绕过被阻断执行。失败保留、阻断未解除。

## 3. P2 正式功能 4.1–4.7 逐项覆盖

T3 当前参考 SHA/路径/历史修复与可得运行对照由 C 提供，**本快照 pending**，不抄P1参考当P2新证据。

| 任务 | 所有者与必须覆盖的边界 | simulation | real Pi contract | real model | real Electron sandbox | packaged |
| --- | --- | --- | --- | --- | --- | --- |
| 4.1 全屏 | C：轻量悬浮入口；关闭/Escape/焦点/适窗/长内容/主题/释放/多Artifact；返回不跳底；不增权限 | E3 UI20/169通过，旧10pass/3fail保留历史；D2生产端ACK回归通过不等于C消费端已收尾，R-D全屏/阅读Important未关闭 | N/A | 与3.1联验pending | pending会话/全屏及阅读位置 | pending |
| 4.2 缩放响应式 | C：放大/缩小/重置/适宽；窄宽/全屏/DPI；SVG/Canvas/长表；不双重缩放 | 新控件/协议pending；E3 normal7/7只证合成样例处理器，不证缩放 | N/A | 样例实际发布pending | pending每档尺寸/DPR/清晰度/滚动 | pending |
| 4.3 动态高度 | D：首次/字体/图片/JS/折叠/表格/连更/宽度/全屏/隐藏恢复/>4096内部滚动/限流 | E3 layout **13/13**、frame **19/19**；含D2反馈/握手回归，确定性时钟/受控尺寸，非真实布局或C-D联合验收 | N/A | 样例实际发布pending | pending测量/抖动/无截断 | pending |
| 4.4 滚动阅读 | D：生成跟底/主动阅读停止/iframe滚轮/内外长滚/变高锚定/多Artifact/全屏返回/主题/分页/原跳底按钮 | E3 reading **12/12**；frame19含保存/恢复ACK回归；稳定ID/偏移、局部程序滚动，原生滚轮与C切换pending | N/A | streaming联验pending | pending受信滚轮/键鼠/几何/位置差 | pending |
| 4.5 图片交互/链接 | C/D：图片/SVG/Tooltip/按钮/筛选/输入/动画/展开；严格source/origin/schema/id/nonce/URL/长度；用户动作与确认 | E3 frame19/19含拒绝合成点击申领宿主动作，normal7/7含样例处理器；实际宿主协议pending | N/A | 正常交互样例pending | pending实际图片/链接安全与可用性 | pending |
| 4.6 主题/视觉 | C/D：T3对照、Token/Icon/Button/Modal；无多层卡片/重复标题；深浅/首屏背景/图表对比与冗余标记 | E3 frame19/19含首帧主题/Token词汇/同文档切换；不是像素或对比度证明 | N/A | 样例配色实际输出pending | pending真实深浅/首屏/对比度截图 | pending |
| 4.7 多会话资源 | D：同会话多件/并行后台/分页/大量iframe/切换/最小化/全屏/退出；可见实例不重建；不加Agent数量限制 | E3 layout13/13、frame19/19含可见性/取消回调/同frame与局部状态及timer句柄转换；整体压力pending | pending实际Pi生命周期 | pending多真实调用 | pending窗口/iframe计数、清理和交互状态 | pending |

### 首轮 R-D 独立功能审查：4 Important 未解决

审查范围 `dfdc1dde` → `a2cdaeb0` 的 D 模块与 C dialog 边界；结论 **不通过**，Blocker 0 / Important 4 / Nit 0 / Pre-existing 0。父已分配 D2/C 修复，E 不修改产品或替代增量复审。

| 编号 | 已复现的问题 | 状态 |
| --- | --- | --- |
| RD-1 | transition 内容从 200→600px，反馈 hold 误锁到 frame 207px/capped | **未关闭**；D2修复已集成、Node回归通过，真实过渡与增量复审pending |
| RD-2 | expanded 消费 naturalHeight 绕过 hold，`calc(100vh + 10px)` 持续增高；65536px 上限不算修复 | **未关闭**；C feedback消费端在途，真实验证/复审pending |
| RD-3 | 12000px 内容全屏往返，内部 scrollY 7904→0→0；同 realm/输入保留不等于阅读位置保留 | **未关闭**；D2保存/恢复ACK生产端已集成，C须确认后切换几何，联合真实验证/复审pending |
| RD-4 | `clearInterval(String(handle))` 未按原生接口转换句柄，interval 残留 | **未关闭**；D2句柄转换/互换/类别清理回归通过，独立增量复审pending |

R-D 证据由父登记在 `C:/Users/21022/AppData/Local/Temp/pi-gui-rd-review-zhpvD1/report-final.json`，E 读取父 plan 核对，未重跑探针。
C 修前正常 sandbox 的 **22 checks、9 截图**是 C 的良性桌面证据，不是安全验收或 E 本次复验；约 **4008px** 样例不覆盖 **>4096px / RD-3**。默认共享 runtime 启动失败后的同摘要私有离线路径与正常 sandbox 资格分别披露。
`tests/html-artifact-viewer-electron.cjs` 保持独立良性桌面入口，不纳入离线 canonical；E 本次只检查其语法，不启动 Electron。

## 4. 七类真实样例 × 必须组合

全部组合需要实际 Electron，优先正式产物。以下每格 `P` = **pending / 未运行**，不是推定失败或通过。
会话/全屏 × 深浅 × 宽窄的八格必须逐个给证据；不得用一张同图或一次API返回填整行。
宽窄须记实际viewport，不能只用标签；图表还须分别包含bar/line/pie。
E2 的 normal-samples **7/7** 只验证六类合成 fixture 的静态资源/脚本和处理器（S2 含三个图表子例）；不填以下真实 Electron 任意格，也不声称真实模型生成、发布或重启通过。

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

### E2 登记状态与交接（本批不等候后续线）

- 已登记：D 的 `html-artifact-layout.cjs` / `html-artifact-frame.cjs` / `html-artifact-reading.cjs` 与 `visual-replies-normal-samples.cjs`，各为独立 `node --test` 叶；D clock 和 normal-samples 的 `tests/fixtures/` helper 不登记。
- 原 358 个 canonical 叶全部保留，新增 4、删除/重复/旧叶换组均 0；Artifact 子链 8 → 12 叶。分组 core280 / ui28 / security28 / native4 / faults22，计划摘要 `509f720388b3d5b3a2b4bfa61db5540995ae38eaa62e240a23505381c025fa0a`。
- C 旧 UI 适配已在 `0aacdb53` 集成并由 E 单 leaf 复验 20/20、169 断言；旧三处 `loading`/`ready` 失败保留历史，不改为 skip。viewer-electron 是独立良性桌面入口，不塞离线链。
- B3 在其交付提交 `2cd34ec2` 报告 branches 17/17、372 断言；父决定随 B2 产品成组集成，当前树没有该测试文件，不注册其 leaf 或 fixture。A1/B2 等后续新 leaf 由父按实际文件统一处理；E 本次不等待、不循环登记。
- B2 的勘察不是通过：maintenance/CLI 的 `confirmNativeWritersStopped` 删除资格缺陷尚待其 fail-closed/candidates-only 修复与复验；**候选扫描不等于自动 GC/容量回收完成**。旧 store 的 135 场景、529 assertions、另 skip3 不解除这个缺陷。
- 首批命令/环境/首次失败与日志见 [E2 实测](visual-replies-p2-e-acceptance.md#83-实测命令准确数量与首次失败)；C 适配后的单 leaf 结果见 [本次 UI 复验](visual-replies-p2-e-acceptance.md#9-e2-收尾c-测试集成后的-ui-单-leaf-复验)。未完整运行 Artifact alias；首批 `npm run test:ci` 只是 10 叶基建链，不是当前 PR 完整 CI。

**快照结论：** E2 首批新四套45/45、guard12/12、基建CI链exit0；旧UI10pass/3fail保留为历史，C适配后E于 `0aacdb53` 单跑UI为20pass/0fail/0skip、169断言。C的联合D58/58与良性桌面22checks/9图分别归属于C，均不解除R-D **4 Important未解决 / 审查不通过**。基线355叶CI仅证明旧基线，当前P2完整canonical为 **pending**（当前PR完整CI尚未运行）；最终产品/真实视觉/Pi/模型/正常沙箱/打包各自未完成，A安全首轮失败及服务拒绝仍 **failed/blocked**。用户允许模型调用不代表本线已调用；E不调用模型、不重启A安全。最终集成、产物、新leaf与推送由父任务负责。
开发完成、代码验收、合并许可、发布许可四阶段分开，不能由本表推导后一阶段。
P3的preview/headless/自动截图反馈/外部资源代理和MCP Apps均不在本期覆盖，不能填成已完成。
