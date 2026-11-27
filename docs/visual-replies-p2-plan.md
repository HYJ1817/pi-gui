# Visual Replies P2：集成计划与证据门槛

## 基线与授权

- 任务日期：2026-11-27。
- 集成分支：`feat/visual-replies-p2`，从 `origin/main` 的 `dfdc1ddea060d8c369e5e0932d052655baa3d772` 创建。
- 保留 P1 架构；不开发 MCP Apps，不提前开发 P3（preview/headless/自动截图反馈/外部资源代理）。
- 用户授权完整 P2、并行子 Agent、提交及最终推送本次分支；未授权合并、发布、修改全局 Pi、增加依赖或使用未明确授权的模型凭证。
- 原根工作区不动。所有会写入的测试使用 `os.tmpdir()` fixture，不修改真实项目、原生会话、全局配置或凭证。
- 禁止 `--no-sandbox`、关闭 webSecurity、打开 nodeIntegration、放宽安全策略。不能把启动、fake Pi、语法检查或静态截图当作真实模型/安全/Visual Replies 验收。

## 执行阶段

1. 核对基线、活跃开发、准确 SHA 的 CI 和定向基线，输出各领域勘察结论。
2. 五条实现线并行工作，各自 worktree 和有界文件所有权；先报拟用接口与偏离，后写代码。
3. 主 Agent 仅统筹架构/接口/集成/冲突，不替代子 Agent 实现。
4. 按回滚边界集成，经真实 Electron、真实 Pi 契约及授权可用模型、正式构建、定向和核心回归取证。
5. 新上下文独立功能与安全审查，最多三轮收敛；阻断项不得隐瞒。
6. 推送分支，最终报告逐项说明完成、未验证和阻塞；无批准不得合并/发版。

## 阶段状态与阻断记录

- 已核对准确基线 CI `45952490979`：push / attempt 1 / head SHA `dfdc1ddea060d8c369e5e0932d052655baa3d772`，五组、build 和最终 gate 成功。该证明只覆盖基线，不覆盖 P2。
- D 的首个接口提交 `52900f2b310670f16566f9b69c6faa48bb669a06` 已集成为 `7b82599f`；仅代表最小消息、host 高度限流和可见性接口，不代表 D 已完成。
- C 已重新取得 T3 main 源码 `d20571f9b9fa35da087e916713f6bac05ac9d1f4`，具体对照与限制由 C 报告，不从旧 P1 参考继承结论。
- A 使用同版本同摘要的离线 Electron 副本，在正常沙箱执行首轮实际安全测试，报告为 **28/29，completed=false、failed=1**。`self-navigation-denied-blank` 未通过；报告位于 `C:/Users/21022/AppData/Local/Temp/pi-html-artifact-security-ymlgeK/report.json`。这不是安全验收通过，也不是最终 P2 产物证据。
- A 后续运行被模型服务明确拒绝：`API Error: Request blocked by cyber policy.`。该安全执行线已停止；不得通过换模型、代理或改写同一测试规避拒绝。未完成的隔离问题和安全矩阵保留阻断状态。
- A1 另行负责未被阻断的普通功能：真实 Pi 无模型契约、带显式授权门控的 live 驱动、六类良性样例及普通交互验证。**不接替 A 的恶意 HTML、逃逸或外传研究**；A1 结果不能算安全专项通过。
- E 测试基建与证据文档已集成（`b4792be4`、`2152728b`）；原 355 个 canonical 叶命令全部保留，新增 backend/process/CI 注册守卫后为 358 叶。主 Agent 核读基线结构化摘要，确认 355/355、失败/跳过/未完成均为 0；这仍只证明 P1 基线。
- 集成检查补正手动工作流的临时目录初始化顺序（`99d8ac82`）：新增断言修复前 8/9、修复后 9/9，skip 0、exit 0。仅证明配置守卫，不证明实际沙箱安全。D 等新套件到齐后仍需补注册与集成回归。
- 未执行的工作流、真实模型、最终 canonical 和正式构建均不得填为通过。新增 workflow_dispatch 文件尚未进入默认分支时，不能声称可以在当前 PR 中已完成 dispatch。

## 续接记录（2026-11-27）

- 原父会话因服务 100 轮上限停止；续接仅恢复既有 P2 工作树，不修改根目录设置分支及其未跟踪文件。
- 用户在续接初期明确：A1 仅普通功能边界，不碰 A 安全 suite/文件，当时不调用模型。C 继续现有实现和正常沙箱良性验证，不重启 A 安全研究。此前 `about:blank` 首次失败及服务拒绝保持未解决，不换代理绕过。
- 用户随后明确追加“可以调用模型”，现已授权 P2 正常真实模型闭环；此授权不解除 A 安全研究阻断，不准擅换供应商/端点、下载依赖、复制 auth 文件、泄漏凭证或写真实用户会话。先只读核验已配置模型与可用凭据来源（仅 metadata/有无），在 TEMP 会话进行有界短请求，不能把合成声明或 fakePi 算作真实模型。
- 用户误关闭后，已恢复被中断的 B2、D2、E2 原线程；C 原任务继续，不重复启动。A1 原线程达到服务 100 轮上限且驱动未提交，新增 A2 接管其原工作树，先完成并提交入口/授权门控/普通驱动及调用就绪条件，再在最终产品集成后安排真实模型闭环；不对旧 P1 树重复消耗额度。
- D 后续四个原始提交按顺序集成为 `7224c87a`、`9d946b4f`、`d1cb0581`、`2d818cc4`；已集成的 `52900f2` 不重复获取。D 的 75/75、98/98、23/23、17/17 仅为其交付文件树的定向证据，不等同最终集成结果。
- C 首个产品提交 `7a30c5f0` 集成为 `98ee052c`；普通 UI 测试适配与独立良性 Electron 驱动 `1d4bec0d` 集成为 `0aacdb53`。C 交付普通 UI 20 项/169 断言，原 13 项/111 断言保留；联合 D 38 项报 58/58。这是修复 R-D 发现前的定向证据；T3 对照与最终真实视觉文档仍待交付。
- B3 专属分支读取回归报告 17/17（16 行为子项+父容器）、372 断言；组合 backend/model 63/63，相邻 edit-target 20/20、service 49/49、HTTP 11/11。提交及主树注册仍待交付。父核对 `session-navigation.js` 后保留其有意的 bounded text-only 只读预览契约，不扩成执行时间线；该页的可视化 UI 是 P1 既有范围差异，不能以 API 历史读取+共享 viewer 回归宣称该页已支持。活动 Classic 恢复及 Runtime live/dormant 的实际渲染链与它分别记录。
- A1 良性样例提交 `a6247de7` 集成为 `a2cdaeb0`。真实 Pi 无模型契约 13/13 的 TEMP 证据由 A1 收尾，明确包含 synthetic assistant setup，不是模型调用验收。
- B 原代理结束时尚未产生提交，不能按界面 completed 当作开发完成。新增 B2 收尾存储/锁/维护/性能，B3 独占新增分支读链回归测试；共享 B 工作树但文件所有权分离，不替对方提交。
- E2 首批登记已直接提交到集成树 `3584bcd2`：新增 D 三套及 A1 normal 共四叶，canonical 358→362，原叶删除/重复/换组均 0。新增测试 45/45、CI 守卫 12/12、test:ci 10 叶 exit 0；Store 135/135 场景、529 assertions、另 skip 3。该运行当时旧 UI 10 pass/3 fail 原样记录，之后才集成 C 适配 `0aacdb53`，不得混称同一次运行通过。B/A1/C 后续新入口仍须逐项登记。
- E2 后续文档收尾 `51412bbb3ab1226a3dea3a9831fdda197b2cedd9` 已在主集成树，父已核对 ancestry 与 diff check；被测行为 HEAD `0aacdb53` 的 UI 单叶仅运行一次：20 pass / fail 0 / skip 0、169 assertions、exit 0。旧 10 pass/3 fail 保留为历史，文档本地链接 5、标题锚点 3、missing 0；本批 canonical 仍 362，branches 尚未注册。E2 任务结束，不循环等候其他线。
- R-D 已完成首轮只读独立审查，四项 Important 待修，见下节。另已启动 B 的两项独立只读首轮审查：功能审查关注当前分支授权/恢复与系统存储接入，安全/故障审查关注锁/维护/配额；均在 B 工作树记录所读文件身份，B2 在途变化须交付前局部核对，不接替 A 的 Electron 研究。
- 最终完整 canonical、真实视觉、正式构建及整体独立验收仍待完成。

### 首轮独立功能审查（R-D）

- 审查范围：`dfdc1dde` → `a2cdaeb01ad50ed4cad5f82f08361d5f707546a4` 的 D 模块与当前 C dialog 调用边界；结论 **不通过**，Blocker 0 / Important 4 / Nit 0 / Pre-existing 0。均为良性普通功能复现，不是安全资格结论。
- RD-1：自然高度反馈 hold 误锁 CSS transition；200→600px 的内容最终 frame 207px/capped，基线 frame 600px。**未解决**，D2 负责。
- RD-2：全屏消费者用 naturalHeight 绕过 hold；静态 `calc(100vh + 10px)` 在全屏持续增高。**未解决**，C 负责，不得仅以 65536px 上限当作修复。
- RD-3：12000px 长内容全屏往返，iframe 内部 scrollY 7904→0→0，同 realm 和输入状态仍存。**未解决**，C 与 D2 配合 presentation 协议；宿主发消息后立即改尺寸存在先 clamp 后保存的竞态，必须保证保存完成再切换，不授予宿主滚动能力。
- RD-4：`clearInterval(String(handle))` 未按原生接口转换句柄，interval 残留。**未解决**，D2 负责。
- 证据：`C:/Users/21022/AppData/Local/Temp/pi-gui-rd-review-zhpvD1/report-final.json` 与同目录 `benign-functional-probe.cjs`；Chrome 158.0.8127.88、页面异常 0、源摘要无变化。R-D 未运行 Electron/A 安全 suite/Pi/模型/产物或完整 canonical。
- C 首轮正常沙箱良性 UI 报 22 checks、9 截图，生产 main/preload/native 注册、四组宽窄深浅及 DPR 1.5；证据 `C:/Users/21022/AppData/Local/Temp/pi-visual-replies-zhKjh1/evidence/viewer.json`。其中样例约 4008px，**不能覆盖 RD-3 的 >4096px 场景**；修后须补相应良性回归及增量独立复审，不能沿用本次通过数字。
- 新增 D2 在原 D 工作树修复 RD-1/RD-4，并与 C 对齐最小协议：resize 可选 `feedback:boolean`；仅显式 false 才消费原始 naturalHeight，true 保持全屏高度，缺字段 v1 仅采用 height。presentation/presentation-ready 均严格六字段 schemaVersion/id/nonce/type/expanded/sequence（正安全整数）；true 在本 realm 同步保存后 ACK，C 等 ACK 后才改几何；false 先恢复内联几何，再由 frame 双原生 rAF 恢复内部滚动后 ACK，不受受控 runtime 暂停影响。该契约待实现与回归，不等于发现已修复。超时/过期 ACK 不得继续切换几何或污染下一次展开。
- D2 首个产品候选修复 `6989cecc82a737414e692573a25fc364b8d17534` 已集成为 `fd88630d`（measurement/feedback、layout 字段保留、frame presentation 握手）。作者的接口 Node 过滤测试仅 6/6、skip 0、601.1942ms；新增测试尚未提交，RD-4 及真实 Chromium/正常沙箱验证仍待完成。C 消费端还在修改，不能把本次仅生产端集成算作完整握手或 RD 发现验收通过。
- D2 后续 `bcd0fa9b125691d4b381fda66c4983b4ecfe775a`、`96818f9f88211b24589566b58e9b7a800fb08e03` 依序集成为 `321ce11d`、`45135b80`：原生 long 句柄转换及 timer 清理互换、rAF 类别分离，新增六项回归，未删除旧断言。D 作者的修前新回归 26/32、fail 6/skip 0，以及其旧 UI+D 联合 57/57，均单列，不冒充主树运行。
- 主 Agent 在行为 HEAD `45135b80`、Windows/既有 Node 环境、`NODE_PATH=C:/pi-GUI/node_modules` 实际执行 `node --test --test-reporter=spec tests/html-artifact-layout.cjs tests/html-artifact-frame.cjs tests/html-artifact-reading.cjs`（使用三个主树绝对路径）：**44 pass / fail 0 / skip 0 / cancel 0 / todo 0、exit 0、1018.5402ms**。仅证明三个 Node 专属套件；不证明 C 消费端、真实过渡渲染/原生内部滚动或正常沙箱，四项发现仍待修后完整证据与独立增量复审。
- 最多三轮审查原则不变，未修复 Important 不得验收通过。
- 父在 HEAD `18766afe` 用原 R-D probe 原样复测主集成树（Chrome/158.0.8127.88、pageErrors 0，证据 `C:/Users/21022/AppData/Local/Temp/pi-gui-rd2-repl-iTBC/report-final.json`）：**RD-1 修复与协议如实生效**——transition 200→600 最终 frame 600、末次写入 feedback:false、growth 期 feedback:true 未锁死；**RD-2/RD-3 仍未修复且属实**——`calc(100vh+10px)` 全屏持续 340→470 增长（协议正确标记 feedback:true，但 fixture 消费端未实现 hold），12000px 全屏往返 scrollY 7904→0→0、同 realm/input 保留（协议存在但消费端未走 ACK 握手）。证实 D2 生产端不是空协议，缺口确实在 C 消费端，与 C2 任务分工一致；**增量独立复审仍须在 C2 落地后进行**，本次父测不替代复审。
- 父同日在 `18766afe` 运行既有良性 viewer Electron 驱动（正常沙箱校验通过、 Electron 44.4.3 同摘要离线副本）：**2/3，`dialog-bounds-dark-wide` FAIL**——expanded 时 `scrollHeight 744` 不再大于 `viewportHeight 744`（C 原证据同断言 4008>744 PASS）。原因待查：D2 capped/反馈语义使超 4096 长内容不再撑高 iframe，驱动断言可能已过时，也可能暴露全屏内部滚动接入缺口；已列入 C2 证据校准任务，不把 FAIL 直接等同产品缺陷。证据 `C:/Users/21022/AppData/Local/Temp/pi-visual-replies-s3qT0M/evidence/viewer.json`。

### B3 测试交付依赖

- B3 测试 `2cd34ec2e855c71364e4b58ca78dc642347b6832` 已随 B2 产品成组集成为 `4094729c`，仅获取一次。B2 按依赖顺序映射：`5b69c52a`→`e90bfcf9`（Store/lock）、`00e22156`→`fcaaee59`（Classic scope）、`d009d05b`→`441bcfc5`（候选维护/统计/接入）、`23e82c91`→`4649ac53`（专项测试）。集成 diff check exit 0；当前不是独立安全或主树测试通过结论。
- 新增 branches 叶为 `node --test tests/html-artifact-branches.cjs`，另三个 B2 叶为 `node tests/html-artifact-lock.cjs`、`node tests/html-artifact-maintenance.cjs`、`node tests/html-artifact-performance.cjs`；fixture、benchmark/baseline 参数不注册到默认 CI。E3 已接手 package 唯一测试链、守卫和主树一次离线 Artifact 子链回归，完整 canonical 仍待当前 PR CI。
- B 首轮独立功能静态审查有条件通过：Blocker 0 / Important 0 / Nit 0，Pre-existing 范围差异 1；未实跑功能测试，七个主审文件在作者提交前后摘要变化 0/7，不能将作者数字冒称审查者实测。锁/GC/维护故障的首个独立安全审查执行因 `Claude API unknown.` 中断，仅有勘察、没有审查结论，不能记为通过或产品缺陷；已用新独立上下文对主集成树 B 产品重做同范围首轮审查，不扩大到 A/Electron，也不继承任何通过结论。
- B2 最终作者证据：store 135/135 场景、529 assertions、另 skip 3；lock 14/14、103 assertions、skip 0；maintenance 20/20、119 assertions、skip 0；performance 默认 16/16 assertions、skip 0；相邻 storage metadata 1/1。原有断言未减少。其同口径性能新样本以 P1 `dfdc1dde` 为 before：三轮 6723.485/6898.081/6823.011ms，中位 6823.011；B2 三轮 3990.662/3735.489/3337.113ms，中位 3735.489。每轮历史 HTML 读取 268616500/268879092/269141684 B→65648 B；同 digest、64 份 33554496 B、8 sessions、每轮 8×4103 B、每侧 26 assertions。旧 5449.461→2627.149ms 仅为历史，不混用。Win/Linux gate 支持不代表 Linux 实机/网络共享存储已验证，其他 OS fail-closed。
- B3 最终同树组合 backend/model/branches 为 63/63、exit 0、9216.1951ms；branches 17/17、372 实际断言、8623.2296ms，skip/fail/cancel/todo 0；相邻 target 20/20、service 49/49、HTTP 11/11。**该证据包含 B2 当前未提交产品树，不证明单独获取测试提交后的主集成树已通过**；必须取得 B2 产品提交后在主树补验。
- B2 验收文档 `df866d7a` 集成为 `597d8335`；D2 验收文档 `081b32ea` 集成为 `20e67cfa`。E3 交付：canonical 362→366 叶（原 362 全保留、新增 4、删除/重复/换组 0），守卫 15/15；一次十六叶离线 Artifact 子链全部 exit 0（各套件计数详见 E 验收 §10）；测试链 `403e0cf9`；E3 文档经 BOM 重写后准确 SHA 为 `2134c58b`（首段）、`bdb1ad8a`（I1 补记）、`6648a15e`（E3 收尾，独占已解除）。**完整 canonical 仍待当前 PR CI。**

### A2 交付与真实模型闭环勘察（父实证）

- A2 命中模型服务 100 轮上限死亡前已提交两个测试提交，原树干净：`1c66c6b6`（真实 Pi 无模型契约）与 `f78e40a0`（普通 functional Electron 驱动 + 显式模型门控）。父按序集成为 `8cba3ad4`、`e02828f7`，扩展既有 check-driver canonical 叶。**登记决策已定**：`tests/visual-replies-electron.cjs` 的 `--offline`/`--live` 模式直接委派给 `visual-replies-functional.cjs`（该文件 26 行），因此既有独立入口 `test:html-artifacts:electron`/`test:html-artifacts:live` 已在跑 A2 的 functional 驱动——ci-html-artifacts 守卫（173-223 行）精确钉住这两条入口、其安全约束（无 --no-sandbox、无 live 授权泄漏）及"live 无 opt-in 必须 exit 2"语义。**不需要新增注册**；real-pi-contract 属手动定向证据，与其它手动专项（security:electron/packaged/live）同级、不进默认 canonical 366 叶链，符合"测试不依赖真 pi"硬约束。决策记录于此，不再另派登记。
- 父在当前集成树实测：**check-driver 28/28**；**真实 Pi 无模型契约 13/13**（真实安装 pi 1.6.0，TEMP 会话，合成 assistant setup 明确非模型验收）；**离线 functional 17/18**——六类 artifact、JS 交互、多 artifact、会话切换清理全 PASS，唯一失败是 generate 阶段 **session-return 条件超时**（切回原会话时 artifact 未在时限内全部 ready；性质待定：会话 hydration 生命周期缺口或驱动过时，已交 C2 对照）。证据 `C:/Users/21022/AppData/Local/Temp/pi-visual-replies-wCQcf4/evidence/`。
- **真实模型闭环（用户已批准用本机 magpie 网关，TEMP 会话、单次短 prompt）打通到真实生产级缺陷**：显式门控注入（pi.cmd、xingchiapi/gpt-6.1-sol、openai-responses、127.0.0.1:3425 网关，key 经专用 env 不落盘/不进证据）后 `normal-sandbox`/`production-preload`/`explicit-model-selected` 全 PASS，真实模型被选中并实际收到 prompt。但**生成开始即崩溃**：`server/html-artifact-projection.js:30` `node.type?.startsWith is not a function`，uncaught TypeError → backend exit 1 → SSE 断开 + pi 孤儿流产（会话记录 stopReason:aborted、durationMs 29、usage 全 0）。离线 fakePi 永不触发（合成 wire 的 type 皆字符串）——**fixture 形状偏离上游真实形状的盲区实例**。逐项排除实证：直接 pi probe（同 env/args/flags/扩展/shell 包装）全部成功完成生成，唯一失败路径是生产 backend 进程内。repro 脚本 `C:/Users/21022/AppData/Local/Temp/pi-probe-shell/backend-repro.cjs` 可重复（exit 1、完整堆栈）。证据 `C:/Users/21022/AppData/Local/Temp/pi-visual-replies-ElQgvm/`（含 generate-first-failure.png 显示后端断开）。**已交 B4b 修复（含 I1），模型闭环在修复后重跑**；A2 的驱动本身证明可用，不需重写。
- 探查过程另确认：gateway 拒绝非编程客户端 UA（client_not_allowed），但 pi 原生 UA 与凭据可用；key 为 6 字符本地标记，全程未打印/未落证据。

### 父侧 crash 热修与验证（集成前 stash）

- B4b 取证前其执行通道故障（自报"无客户端工具"），无法完成 crash 修复；为避免整个闭环停摆，父直接承担 `server/html-artifact-projection.js` 的防御修复——该文件属 server/ 共享所有权（B 表亦含 `server/html-artifact-*.js`），父作为集成方修复不违反线所有权，但**独立增量复审不可省略**。
- 修复（单行 + 注释）：`const execution = typeof node.type === 'string' && node.type.startsWith('tool_execution_')`；fail-closed——非字符串 type 一律按非 execution 处理，不改变任何正常投影语义，HTML 隐藏逻辑不受影响。
- **load-bearing 证明**：当前 HEAD（旧码）对非字符串 type 形状抛 `TypeError: node.type?.startsWith is not a function`（与生产崩溃原文一致）；修复后同形状原样投影、不崩。
- 回归测试（html-artifact-backend.cjs 新增一例）：对象/数字/null/布尔/数组 type 载荷嵌入 message_update partial、agent_end messages 等真实上游嵌套位置，断言投影逐字节恒等且不崩 + HTML 字节仍被隐藏。**39/39 pass**（原 38 + 新 1），fail/skip 0。
- **真实闭环实证**（repro2，生产 server.js + 真实 pi.cmd + magpie 网关、TEMP world）：修复后 backend 全程存活 40s+，prompt submit 200，pi 会话实际完成生成——assistant `stopReason:"stop"`、usage 七键齐全（input/output/cacheRead/cacheWrite/reasoning/totalTokens/cost），content parts `[thinking, text]`；零 crash 行。**这是修复后真实模型闭环打通的直接证据**，与修复前 stopReason:aborted/usage 全 0/durationMs 29 形成对照。
- 相邻套件：html-artifact-process 8/8 pass（含修复）；离线 functional 18 项中 17 PASS（唯一失败仍是 generate 阶段 session-return 超时，与修复无关、属 C2 对照范围）。**注意**：functional 运行时修复在工做区内、stash 前；canonical 态（stash 后干净树）未重跑——集成落盘后须以落地码为准补验。
- 取证分工：B4b 收缩为纯取证（确认非字符串 type 的准确字段路径/typeof 分布 + fakePi fixture 与真实形状偏差清单），不再承担修复。持久化会话扫描（原 crash world 8 份会话）非字符串 type 命中 **0**——违规形状仅存在于流式 wire 事件（streaming partial），不落盘，与"离线 fakePi 永不触发"一致。
- stash：`78b7d76d503eb636f7ca91537e4d3e51494de23e`（tag `parent-hotfix-projection-crash-20261127`），含修复 + 回归测试两文件；集成时以 SHA apply（不用 pop），落地为独立回滚边界提交。

### R-B 首轮独立安全审查（重试后完成）

- 审查范围为主集成树 B 产品（HEAD `e4468695`），结论 **不通过，Important 1**：I1「恢复入口在自身锁释放失败时仍确认成功」。`server/html-artifact-store.js` 的 release 吞掉 `ownedUnlink` 失败（约 186 行），`recoverLock()`（约 481 行）在自身 `.writer.lock` 删除失败时仍返回 `{ok:true}`；`server.js` 启动恢复（约 465 行）与维护入口同样报假成功。实证：注入一次 EACCES 后 live owner 的锁残留，后续 read/recoverLock 永久 busy（owner 存活，身份门控不能合法清除）；快照无损坏/丢失，但可用性卡死且 API 撒谎。历史：基线 publish 在 `dfdc1dde` 已吞释放错误，新增暴露面是 recovery API/startup/maintenance 的假成功。
- 证据：`C:/Users/21022/AppData/Local/Temp/pi-b-review-aewurq/review-report.md`、`manifest-end.json`、`probe-results.json`；探针 8 场景 7 pass/1 fail，累计 78/79 断言；30 个被审文件在审查期间变化 0。
- 审查者另记录：直接 `store.collect({releasePending:true})` 可删除 pending 快照，Store 自身不强制 candidates-only；生产中维护入口强制 dry-run、Reconciler 无 provider 即退出，信任调用者契约成立，**不计为已确认绕过**，但属设计边界。
- 修复要求：「已确认自身锁但释放失败」必须返回固定脱敏失败，不得报成功；不得引入 force-unlock 或放宽身份门控。已派 **B4** 在原 B 工作树修复并补回归；修复须经独立增量复审后 I1 才可关闭。

### R-B 续审新发现（zombie 线程 c5122ef6 迟交，父 task_status 回收）

- 该线程 ordinal:2 实际**早已完成**（含 B4 修复在树期间的局部复核），因父 compaction 未送达。结论 Blocker 0 / Important 1（新）/ 审查范围覆盖至 B4 修复树 `3f22f3d3`：
- **B-SAF-01（Important，未解决）**：新增 `.writer.lock` owner 写入/fsync 发生在业务动作**之前**，而 html-artifact-store.cjs 既有刷盘/短写故障用例**全局替换** `io.fsyncSync`/`io.writeFileSync` 不分 fd——故障首先命中锁而非标称目标（pending 重刷/快照写入）。实测命中表：pending-fsync→`.writer.lock`、snapshot-fsync→`.writer.lock`、短写→`.writer.lock`；原 1/1 通过的那次 flush 统计的是锁的 flush。**529 断言数不变但业务故障覆盖已退化**——高风险持久化验收证据缺口。同时限定 `.pending` 的最小注入确实被拒绝，**不能扩大解读为"产品已漏刷盘"**。修复要求：按 fd/文件名定向注入并断言目标命中次数，恢复业务目标覆盖后定向补验。
- 同报告**正面核对**（否定证据，非空）：B4 释放重试语义正确（原 Store 精确内存证明有界重试、同 PID 跨 Store 无权接管、foreign 字节拒绝）；授权闭合/身份/gate/崩溃保留/配额/digest/索引恢复/collect 入口闭合/显式 TEMP 清理均未见失守；生产维护层 collect 恒拒绝、无生产路径注入 native 排斥。**I1 修复本身经此续审局部复核通过**（5+2+6+3+2 场景探针共 107 断言全过，4 组定向 filter 各全过），但 I1 正式关闭仍待集成落地后的增量复审（复审对象须含集成树身份，不能仅以 B 树身份为准）。
- **待派**：B-SAF-01 修复（B 所有权：tests/html-artifact-store.cjs 故障注入目标定向）。轮次纪律：首轮 R-B 已闭合，此为第二轮增量；B-SAF-01 修复后复审为同一第二轮的收尾，不得扩散范围。

### 集成落地记录（父，2026-11-27 第二批）

- B4b 命中 100 轮上限死亡前 I1 四提交已完成；父 dry-run 验证干净后按序 cherry-pick：`38afdcb1`（store 释放语义）、`52da53fc`（启动/维护如实上报）、`3d1a1db5`（回归测试）、`b6961179`（验收文档）。B4b 死亡后新派 **B5**（同树）接手 B-SAF-01 注入修复 + wire 形状取证。
- crash 修复落盘为独立回滚边界 `939eff61`（projection typeof 守卫 + backend 回归一例），stash 已 drop。
- **集成态定向实测**（HEAD `939eff61` 组合状态，NODE_PATH 本地依赖）：backend **39/39**、lock **33/33 场景 270 断言**、maintenance **30/30 场景 189 断言**、store **135/135 场景 529 断言 skip 3**、process **8/8**、performance 默认 **16/16 断言**（median 1141.492ms，htmlReadBytes 65648/32calls，digest 一致）。全部 exit 0；skip 不计入分母。
- 真实模型闭环（用户授权的 magpie 网关路径）已在集成态重跑——结果待补记于此。
- I1 正式关闭、B-SAF-01 关闭仍待第二轮增量独立复审（审查对象须含集成树身份 `939eff61` 及后续，不能仅以 B 树身份为准）。

### C 线交接

- 原 C 代理命中模型服务 100 轮上限死亡（runs 2–5 均失败，不得重启）。其工作树留有未提交的 RD-2/RD-3 半成品（viewer/dialog/interactions 约 +62/-12），无任何完成证据。已派 **C2** 接手同一工作树：评估半成品、按 D2 唯一契约完成消费端、补 T3 对照、>4096px 真实正常沙箱 Electron 全屏往返良性证明与验收文档。A2（真实 Pi 驱动与模型闭环准备）、E3 后续登记仍在各线进行；E3 首节交付见上。

## 子 Agent 文件所有权

| 线 | 所有权 | 禁止无序交叉修改 |
| --- | --- | --- |
| A：真实 Pi / Electron / 安全 | `tests/visual-replies-electron.cjs`、`tests/html-artifact-electron.cjs`、其专属 fixture、新的真实契约/安全测试、`electron/html-artifact-security.cjs`、必要的 Electron 主进程局部改动、A 证据文档 | 不改 package/CI、后端 Store、公共 viewer/frame。需要新协议先报告。 |
| B：Store / 分支 / 维护 / 锁 / 性能 | `server/html-artifact-*.js`、`server.js` Artifact 初始化局部、`public/messages.js` 中 Artifact 授权 scope 的最小改动、必要的后端会话引用读取调用点、Store/backend/process 专属测试、B 文档 | 不改公共 viewer/frame/CSS、package/CI、Electron。 |
| C：T3 对照 / 全屏 / 缩放 / 图片链接宿主 | `public/html-artifact-viewer.js`、`public/html-artifact.css`、新增 viewer/dialog/controls 模块、对应 viewer/UI 专属测试、T3 参考文档 | 不改 frame/theme/activity、reading-position、会话流/后端、package/CI。 |
| D：iframe / 高度 / 滚动 / 主题 / 生命周期 | `public/html-artifact-frame.js`、`public/html-artifact-theme.js`、`public/html-artifact-activity.js`、`public/reading-position.js`、必要的既有滚动模块局部、独立 layout/lifecycle helper、新的 D 专属测试、D 文档 | 不改 viewer/CSS、messages.js、Electron、package/CI；先输出供 C 使用的接口契约。 |
| E：canonical / CI / 基线 / 覆盖矩阵 | `package.json`、必要的 CI 及 `scripts/test-*` 局部、CI 回归测试、新的覆盖验证测试、总体验收索引及 E 文档 | 不改 A-D 的产品实现/专属测试。最终独立审查另派新 Agent，不能自审通过。 |

每条线必须先读本 worktree 的 AGENTS.md、REVIEW.md、docs/README.md 和相关规范。UI 线先读 design-system。每个子 Agent 自己执行，不再分派。只提交自己所有的文件，不推送、不建 PR、不合并。提交中文信息，使用 `git rev-parse --git-path COMMIT_MSG_TMP.txt` + 写文件 + `git commit -F`；末行 attribution 按本轮宿主规则。

## 不可退让的接口与安全约束

- Artifact 身份（id、原始 session、摘要、不可变 HTML）与当前授权引用 scope 分离。分支读取由后端依据有效原生引用授权，不复制 HTML，不移除身份检查。
- iframe 保持 opaque origin、最小 sandbox、CSP/Permissions Policy、Electron 原生请求/导航拦截。全屏不增加权限。
- 跨 iframe 消息必须严格验证 source、origin、schema/type、Artifact id、nonce、字段类型、长度；高度消息须有界且限流。图片/链接不能成为通用 IPC 或请求代理。
- C/D 在写入前说明接口：frame bootstrap 提供何种 resize/escape/image/link 消息，viewer 负责何种 host 校验；谁持有 resize、lazy mount、dispose。保持兼容现有消费者和测试。
- 优先保留可见 iframe 实例及交互状态。全屏、主题、缩放不能强制跳到底部；持久快照与临时交互状态需明确区分。
- GC 只有完整引用+回收站/可恢复分支+Agent 发布窗口+并发互斥得到证明才可删。否则提供 fail-closed 的显式静默维护与可操作路径，禁止假装自动 GC 已安全开放。
- 锁恢复不能只依赖 PID 存在或年龄；可靠进程身份/所有权无法证明时拒写且给出恢复办法。
- Store 性能先测后改，优化不得取消读取摘要校验；提供前后同口径测量。

## 验收矩阵

### P1 遗留（逐项证明）

- 真实 Pi 驱动：工具发现、真实模型实际 html_render、发布、Electron 展示、JS、后续流式文字、会话切换、应用重启。无明确可用模型时完成真实 Pi 工具契约+可重复 live 驱动，并标真实模型未完成。
- Electron 安全：宿主 DOM/preload/IPC/Node/文件/凭证存储；localhost/私网/外网；Fetch/XHR/WS/RTC；Worker/SW；嵌套 realm；导航/重定向/弹窗/下载；伪造消息；跨 Artifact/session；滚动/资源攻击。网络采用受控监听器+已到达的正向对照，禁止只看函数返回值。
- 全局请求拦截：不破坏正常 Browser、文件预览、认证、代理等既有功能。
- 分支继承：branch/copy/edit-resend/history switch/original deletion/inherited restore/illegal cross-session；前后端真实读取链回归。
- GC：活跃引用、垃圾箱、运行中、发布未持久化、中断孤儿、扫描删除竞争、容量统计、合理错误。
- 锁：正常退出/崩溃/强杀/中断/临时文件/PID 复用/同时启动/旧 owner 存活/无法确定身份。
- 性能：大量历史、多会话并行、before/after 数据、完整性恢复。
- CI：backend/process 纳入唯一 canonical 链；新测试分组可发现；Electron 和 live 独立入口，条件与结果不混淆。

### P2 功能

- T3：重新核对当前可用仓库，记录 SHA；HtmlRenderFrame/BrowserDocumentFrame/Dialog/Timeline/协议/滚动/图片缩放/测试/历史 issue PR。源码实际路径为准，无法获取运行效果不得假造。
- 轻量悬浮展开，无新大工具栏/重复标题/多层卡片；全屏关闭/Escape/焦点/窗口适配/长内容/主题/清理/多个 Artifact。
- 放大/缩小/重置/适配宽度、窄宽屏、DPI；区分页面响应式与查看器缩放。
- 动态高度：首次、字体/图片、JS/折叠/表格、连续更新、宽度、全屏、隐藏恢复、超过 4096 的明确内部滚动；合并与限流。
- 滚动：生成跟底、主动阅读停止、iframe 滚轮、内外长滚动、变高锚定、多 Artifact、全屏返回、主题、历史分页、原跳底按钮。不得改满意的思考动画/跳底按钮视觉。
- 图片/SVG/Tooltip/表单按钮/动画/表格交互，安全且需用户动作的链接；无 CDN/外部资源代理。
- 深浅主题、首屏背景、图表对比及冗余系列标记；复用 Token/Icon/Button/Modal。
- 多 Artifact/并行会话/后台/分页/历史 iframe/切换/最小化/全屏/退出资源；不得添加 Agent 并发数量限制。

### 真实样例与证据

七类：仓库整理前后报告；bar/line/pie；SVG 架构；筛选器/按钮面板；长表动态展开；内嵌图片；恶意 HTML。
正常样例矩阵：会话内/全屏/缩放 × 宽窄 × 深浅 × 动态高度/滚动/多 Artifact/会话切换/重启。
证据必须来自实际 Electron，优先正式产物。每次运行记录 SHA/未提交差异、平台、真实安全参数、入口、视口/DPR、步骤、数字、退出码、首次失败与截图。任何未做的组合写未验证。

## 交付报告必须包含

T3 SHA/路径/差异；P1 每项状态；新功能与关键文件；安全模型和实际安全证据；真实 Agent 记录；深浅/会话内/全屏/响应式截图；性能前后；测试命令/实际计数/skip；canonical/CI；分支/提交/PR（未创建则明示）；未完成/阻塞/影响/后续；P3 衔接；可执行回滚。
