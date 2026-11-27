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
- 真实模型闭环（用户授权的 magpie 网关路径）已在集成态重跑——`normal-sandbox`/`production-preload`/`explicit-model-selected` PASS，真实模型**正确调用 html_render 一次**（args title/height/html 合规、ID 匹配、45ms tool roundtrip），但 toolResult 返回 `html_bridge_unavailable`。**模型行为、崩溃修复、pi 契约全部证明无恙**；失败在 pi↔backend 桥准入层，父正在独立定位（详见下节）。
- I1 正式关闭、B-SAF-01 关闭仍待第二轮增量独立复审（审查对象须含集成树身份 `939eff61` 及后续，不能仅以 B 树身份为准）。

### B5 交付与 wire 取证（父集成，2026-11-27 第三批）

- B5 两提交已集成：`a484b6f2`（B-SAF-01 定向注入修复，store 断言 **529→542**，+13 为恢复的命中断言）、`a6782398`（wire 取证文档）。集成态实测 store **135/135 场景 542 断言 skip 3**、backend **39/39**，exit 0。**B-SAF-01 覆盖缺口已在代码层闭合**，正式关闭待第二轮增量复审。
- **wire 形状取证结论**（真实 pi 1.6.0 + magpie + TEMP，生产 server.js + TEMP loader 换回修复前 projection 复现崩溃）：准确违规路径 `message_start.message.toolsAdded[6].parameters.properties.ready.properties.type`，typeof object（schema 描述对象，`{type,enum}` 两键），父节点为 process 扩展 `ready` 参数的 JSON Schema；上游 pi `dist/core/agent-session.js` 仅 `role==='system'` transcript 消息携带 `toolsAdded`，随 `message_start` 下发。通用违规形状为 `toolsAdded[*].parameters` 中任意嵌套 schema 描述对象。**证实父的 typeof 守卫语义正确**（非字符串 type 按非 execution 处理，这类节点根本不是 execution 事件）。离线 fakePi 不发 system/toolsAdded/turn_start/end/text_start/end，故该形状离线不可见——fixture 偏差已记录，未修改 fixture。证据 `C:/Users/21022/AppData/Local/Temp/pi-wire-forensics-V3NePQ/`。
- **桥准入缺陷已定位并修复（父，`b5c649a3`）**：诊断插桩逐层排除——`prepare()` 成功、hello 两次全过（state-null=false/session-match=true）、publish 抵达 route valid=true，**唯一失败点是 `declaration()` 的 `readExecutionBranch` 返回 null**。根因：真实 pi 生成的 toolCall id 含 **`|`** 管道符（形状 `xxxx-<32hex>|xx<50>`，91 字符；跨 127 个真实会话取证 charset 仅字母数字+DASH/UNDERSCORE/PIPE），而 `execution-timeline.js` 的 `IDS` 白名单不含 `|` → `validId` 拒绝 → 分支读取 null → publish 永远 `html_bridge_unavailable`。**离线 fakePi 永不触发**（合成 id 不含 `|`）——同一 fixture 盲区家族的第二个实例。修复：IDS 加 `|`（纯结构 JSON 标识，不进 shell/路径）。实证：修复前 declaration branch-null=true；修复后**真实模型闭环 toolResult ok=true**。回归：backend 39/39、branches 17/17、process 8/8、store 135/542+skip3、edit-target 20/20、edit-service 49/49。父作为集成方修复共享 server 模块，**独立增量复审不可省略**（与 crash 修复同列）。
- **C2 交付已集成**：`c5208fde`（RD-2 feedback-hold 消费端 + RD-3 ACK 几何切换）、`31af9351`（回归测试，UI 26项/282断言等四套70项/572断言基线）、`ec3d77c3`（验收文档 + T3 对照 SHA `d20571f9b9fa35da087e916713f6bac05ac9d1f4`）。集成态实测四套 **70/70 pass、fail/skip 0**。
- **RD-2/RD-3 已正式关闭（R-D 二轮独立增量复审，`598e2f2d`）**：独立实测与作者证据完全一致——正常沙箱 Electron **40/40 checks/18 截图/exit 0**、12000px 四组合（深浅×宽窄）scrollY 全 **7904→0→7904** 同 realm/input/count 保留、`calc(100vh+10px)` 全屏保持 **350/380/420/450px 固定**（feedback-hold 生效，未消费 raw 高度持续增长）、保存 ACK 超时实际丢弃 1 个 ACK 保持 **419×460px 未展开**、内联 transition 200→600 后连续五次稳定 600 末次 feedback:false、四套 **70 pass/fail/skip 0、UI 282 assertions**、另有独立协议/故障探针 **20/20**。**Blocker/Important/Nit 全 0**。静态与故障路径核对通过（1200ms 超时+单调时钟 deadline、严格递增 sequence、迟到 ACK 拒绝、恢复中重开 guard、dispose 清理、dispose 后 1400ms 无迟到 modal 复活）。同摘要 copyElectron 运行时、无 `--no-sandbox`、源摘要变化 0、进程残留 0。证据 `C:/Users/21022/AppData/Local/Temp/rd2-review-report.md`、`pi-visual-replies-krpV4H/evidence/viewer.json`、`pi-visual-replies-sPP7bt/evidence/independent.json`。复审线程曾因网关方差 interrupted，「中期结论即时落盘 TEMP」纪律使进度可续接，最终独立完成。
- **I1/B-SAF-01 已正式关闭（R-B 二轮独立增量安全复审，`598e2f2d`）**：I1 独立核对——EACCES 后 recoverLock 固定拒绝 `html_artifact_storage_release_failed` 不再假成功、持续失败 21 次调用恰好 21 次 unlink 不自旋、原 Store 凭精确内存证明有界重试/同 PID 跨 Store 无权接管/foreign 字节与 inode 与根替换均拒绝且保留、生产 CLI 四动作 exit 1 ok:false；B-SAF-01 独立核对——helper 抽跑 **78 条 fd/open/rename 事件、10 次业务故障、误中锁 0 次**，注入到达 document.html/reference.json/.pending/rename，锁 I/O 未被误注入。原三套 **lock 33/33/270 + maintenance 30/30/189 + store 135/135/542（skip 3）累计 198/198/1001 断言**、独立 I1+CLI 13/13/296、边界验证 46 断言；store 断言 **529→542 未减少**，11 个产品/测试摘要首尾变化 0/11。证据 `C:/Users/21022/AppData/Local/Temp/rb2-independent-HWp9yB/review-report.md`。
- **RB2-IDS-01（新 Important，复审抓出，父定点修复已实施）**：父的 IDS `|` 修复用共享验证器 `validId` 同时验结构 ID 与展示字段（subagent `row.key`/`row.model`），而凭据/敏感名称正则未把 `|` 当分隔符——合成 `fixture|sk-…`/`fixture|auth` 绕过过滤进入出站 `activity.children`（凭据形态展示过滤回归，非 shell/路径/HTML 执行漏洞）。复审员建议「分离 native-ID 与展示字段验证器」。**父已修复**：新增 `DISPLAY_ID`（不含 `|`）专验展示字段，`validId`（含 `|`）保留给结构 ID（sessionId/toolCallId/entryId）；同时把 `|` 加入 `SENSITIVE_NAME`/`CREDENTIAL_VALUE` 的分隔符类作纵深防御。语义验证 11/11（结构 pipe ID 仍过 validId、展示 pipe 被 displayId 拒、pipe 敏感串被过滤、良性 model 不误伤）。受影响套件无回归：branches+backend **56/56**、runtime-conversation **119/119**、history-tool-summary **38/38/168**。**父作为集成方修复共享 server 模块，此修复同样需独立增量复审，不得自证。** → **RB2-IDS-01 已正式关闭（独立增量复审，2026-11-27）**：独立复审员核对 [execution-timeline.js:18–38](server/execution-timeline.js) 与 [:120–122](server/execution-timeline.js)——结构 `IDS/validId` 保留 `|`、展示 `DISPLAY_ID/displayId` 排除 `|`、字符类 `-` 均保持末尾字面量；`row.key`/`row.model` 两处均已切换 displayId；全文剩余 `validId` 调用均用于结构标识，无展示字段漏网；独立从源码提取正则复现过滤语义。**Blocker/Important/Nit/Pre-existing 全 0，无新发现。** 复审线程 `thread:delegated-task:...ebb34c2f`（独立上下文，未读父结论）。复审增量细节：独立复现 HEAD 旧实现的三个合成 pipe 绕过、修复后拒绝且敏感名/凭据过滤命中；导出 API 验证 **results、workflow 两条出站路径均闭合**，pipe 原生 toolCallId 分支证明仍正常；合成语义 11/11、扩展边界+旧缺陷复现+导出 API 13/13、branches **372 assertions**、history-tool-summary **168/168 assertions**（计数与父报告一致无减少，三条回归退出 0/stderr 0 字节）。**真实来源澄清**：`row.key` 来自 workflow `childId` 或 results `runId/index`，**并非** parent toolCallId；本机 pi-subagents 0.75.0 workflow key 明确禁止 pipe、常规 runId 用 UUID。**兼容范围边界（防止过度概括）**：不能扩大为「所有合法模型名都不含 pipe」——Pi 自定义模型 ID schema 未禁止 pipe，此类模型的可选 `model` 标签会被省略但 child 行保留（合成验证确认）；未获可核查 T3 producer 源码，不声称完成任意 T3/custom 命名方案兼容认证。证据 `C:/Users/21022/AppData/Local/Temp/ids-review-rb2-20261127-report.md`、`ids-review-rb2-20261127-semantic.json` 及 html/runtime/history 三份 stdout 日志。
- C2 对 session-return 的判断：驱动要求"切回会话后全部 artifact 同时 ready"，而既有懒挂载只对视口 600px 内条目启动加载——**存在可定位的语义差异**，但证据不足以断定它是该次超时的唯一根因（缺逐 artifact 观察），也不排除真实 hydration 缺口。C2 未修改该链路，维持"待定/未验证"。dialog-bounds 断言过时性：C2 修后超 4096px 内容不再撑高 iframe（符合 D2 capped 语义），原 4008>744 断言已过时，C2 在新驱动中以 fullscreen 内部滚动覆盖替代。

### 修复后真实模型闭环第一次完整驱动运行（父实证，2026-11-27 晚）

- 运行条件：修复后集成树（crash 修复 `939eff61` + IDS `|` 修复 `b5c649a3` + C 线全集成），显式门控注入同前（pi.cmd、magpie 127.0.0.1:3425、xingchiapi/gpt-6.1-sol、openai-responses，key 仅内存注入不落盘/不进证据）。结果 3/4：`normal-sandbox`/`production-preload`/`explicit-model-selected` **PASS**，失败于 `artifact-filter-panel` 阶段 `condition_timeout`。证据 `C:/Users/21022/AppData/Local/Temp/pi-visual-replies-vxeleN/`。
- **决定性取证（vs 修复前崩溃态）**：pi 会话记录显示 assistant **真实发出了 `html_render` toolCall**（id 83 字符含 `|` 管道，形状与 IDS 修复目标一致），pi 侧未再死于崩溃（修复前 stopReason:aborted/durationMs 29/usage 全 0；本次带真实文本+toolCall 结构）。但 pi assistant stopReason=`error`：`Error reading response: malformed server-sent event JSON.`（错误长度 57 字符，纯网关侧流式解析错误，无产品字段）——**模型在 toolCall 发出后死于 magpie/xingchiapi 网关侧 SSE 解析失败，toolResult 从未返回**。`explicit-model-selected` PASS 证明请求真实抵达模型、模型真实开始生成（选择文本 + html_render 调用结构均真实）。
- **判定**：本次失败为**模型网关方差**（xingchiapi 第三方网关 SSE 流式不稳定，直连 curl 探针显示网关对非客户端请求直接 403 `client_not_allowed`，服务严格限流/限客户端），**不是产品缺陷**——直接后端 probe（handshake-probe，同模型同网关）已实证 `toolResult ok=true` 端到端打通，崩溃修复 + IDS 修复后的产品链路在 pi 真实形状下完整工作。已发起第三次重跑取决定性端到端证据；若再次死于 SSE 解析则将闭环验收锚定在「直接后端 probe toolResult ok=true + 驱动 3/4 PASS（含模型真实被选中并生成 html_render 调用）」组合证据上，并在验收报告中如实标注网关方差为残余风险。
- 会话返回答疑补充：本次超时阶段 `artifact-filter-panel` 与 session-return 无关（生成阶段 artifact 从未挂载），与 C2 的 session-return 待定项独立。

### 真实模型闭环决定性证据（父实证，2026-11-27 晚第三次重跑）

- **真实模型闭环端到端打通：live 22/22 PASS、completed=true**。运行条件同前两次（显式门控 magpie/xingchiapi-gpt-6.1-sol/pi.cmd，key 仅内存注入），同一集成树。证据 `C:/Users/21022/AppData/Local/Temp/pi-visual-replies-HO86dq/evidence/functional-results.json`。
- generate 阶段 12/12：`normal-sandbox`（sandbox=true、webSecurity=true、contextIsolation=true、nodeIntegration=false、无 --no-sandbox）、`production-preload`、`explicit-model-selected`（模型真实选中）、`tool-then-streamed-text-filter-panel`、`actual-js-interaction-filter-panel`（**`realModelVerified=true` 的全部三项锚点全过**）、`multiple-artifacts-and-followup`、`session-switch-clears-old-artifacts`、**`session-return-native-artifacts`（真实模型路径下 PASS——C2 的 session-return 待定项在真实闭环中实证为良性，正式排除 hydration 缺陷假设）**、inline-matrix 四组合（dark/light × 700/1320）全过。restore 阶段 10/10：`restart-native-ref-identities`（重启后 artifact 身份完整保留）、`restart-followup-text`、`restart-js-interaction-filter-panel`、inline-matrix 四组合等。共 5 张真实截图。`realModelVerified=true`、qualification `explicitly-authorized-real-model-benign-functional-only`（如实标注仅良性功能闭环）。
- **第二次 3/4 已确认为网关方差实例**，与第三次全过互为印证：同一树同一驱动，唯一变量是网关 SSE 流式稳定性。残余风险如实标注：xingchiapi 网关偶发 `malformed server-sent event JSON`，重试即可恢复，不属于产品缺陷也不构成验收阻塞。
- **realModelVerified 未验证项收窄为两项**：`original-A-security-unresolved`（A 安全永久阻塞，不重启）、`final-integrated-packaged-app`（待正式构建后最终验收）。`fullscreen-zoom-matrix` 已在之前运行中举证（viewer-action-contract 由 env 显式供给）。
- 离线同树基线复验：连续两次 6/7（world `pi-visual-replies-HcHzEp`、`pi-visual-replies-DlZY8S`），失败点同为 generate 第三样本 `architecture` 的 30s 条件超时——**稳定复现，非随机 flake**。已取证排除后端：失败 world 三次 html_render 全部 toolResult ok:true、三条 followup 完整落盘、存储 3 artifact 齐全；超时是纯前端/驱动时序问题。junction 陷阱已记录：worktree node_modules 是 junction 时直接跑 `node_modules/electron/dist/electron.exe` 静默崩溃（exit 2147483651），探针必须用 copyElectron 的拷贝运行时。
- **根因已由父锁定（probe3–probe7 取证链，证据 world `pi-visual-replies-PFpe2c`/`pjmzcJ`/`5jslGP`）**：超时瞬间第三 artifact `state=loading`、`iframe:false`、`srcdocLen:-1`、rect top=1004 bottom=1036（骨架 32px）——mount 从未触发 `load()`，后端 publish 早已 ok。父链全部 visible、无 hidden/content-visibility 抑制、isConnected=true（`p5-why.json`）。**scrollIntoView 一推 artifact 立刻 ready**（srcdocLen 28510）——链路其余全部健康，唯一缺失是 IntersectionObserver 触发。机制：`mount()` → `createHtmlArtifactVisibilityController`，`nearby` 初值 false，`load()` 唯一触发路径是 IO 回调翻转后 `onVisibility(true)`；mount 在流式期间 append 后立即 attach observer，初始回调那帧 followup 文本两段 80ms 间隔注入推动布局剧烈变化，存在初始报 false 后位置变化未被可靠重估的窗口——**懒挂载依赖单次 IO 翻转，无兜底**。**决定性反转证据**：probe7 给页面装 IntersectionObserver spy 包装后三样本全过——spy 改变回调调度时序恰好避开竞态，证明是真实时序竞态而非确定性几何漏判。简化几何复制品（probe6）里 observer 对同形状 top=804 目标正常报 true——IO 语义本身没问题，差异在真实产品的流式时序。修复方向：mount 除依赖 IO 翻转外主动几何兜底，保持懒挂载语义只补「该挂而漏挂」。**已派修复代理实现+验证**（硬指标：离线驱动连续两次 7/7、jsdom IO 契约保持、补竞态回归测试）。两个复审代理（R-B/R-D 二轮）同死于 xingchiapi 网关 SSE 方差空转，已带「中期结论即时落盘 TEMP」纪律重启。

- **懒挂载修复已实施（修复代理，未提交，验证中）**：`createHtmlArtifactVisibilityController` 改 IO 优先 + 有界几何兜底——`visible()` 在 `isConnected/hidden/[hidden]/display:none/visibility:hidden/contentVisibility` 门控后取 `nearby || measuredNearby()`；`measuredNearby()` 仅在非零真实矩形、全有限值、非零视口下参与，按 viewport+600px 垂直 margin 求交（不对零尺寸 jsdom 矩形猜测、不扩展 hidden/clip 祖先、仅 scroll/auto/overlay 滚动口可预热）；另加 scroll（捕获）/resize 经 RAF 合并重估 + 有界短期几何重查（最多 8×80ms，`last===true` 或 nearby 即停）。测试新增 3 条（jsdom 零矩形不 override、测量几何恢复 IO 漏判、有界重查捕捉晚期布局偏移），layout 套件 **47/47**（基线 44/44）。原始 probe4 前四样本与全六样本探针均通过；**未改完整驱动从 6/7 architecture 失败推进至 12/13 raster 失败**——证实竞态修复有效，但暴露第二语义冲突：第六 raster artifact 在 4224px 深处（viewport 882、预热边界 1482），正确懒挂载不应提前挂载，而驱动逐样本等待 `every(ready)` 不访问远端。**父已授权驱动契约修正**（带四约束：仅加滚入视口步骤、绝不放宽任何 ready/真实点击/followup/切换/矩阵断言、滚动对应真实用户行为、改动显性披露并交独立复审，两轮完整验证须新跑不得复用）。修复代理正实施驱动修正并跑两轮连续完整验证，进度即时落盘 `C:/Users/21022/AppData/Local/Temp/fix-progress.md`。

- **懒挂载修复+驱动契约修正已完成作者验证（修复代理交付，未提交，待独立复审）**：作者自报并经父独立核证证据世界——连续两次完整离线驱动 **36/36、completed=true、退出 0**，两轮之间未改代码（world `pi-visual-replies-qlAwP3`/`pi-visual-replies-tYkYKv`，父独立读取 functional-results.json 确认 completed:true/passed:36/failed:0/skipped:0/failure:null，unverified 仅 `original-A-security-unresolved`+`final-integrated-packaged-app`）。单测 layout/frame/reading **50/50**（基线 44/44，新增 6，无删断言）、backend **39/39**、驱动自检 renderer 18/18 + functional 28/28。作者对照实验：旧 HEAD 实现内存中跑新测试 14 通过 5 失败，当前实现全过——证明新测试非摆设。驱动修正实测为单 `visitPendingArtifact`（真实 `scrollIntoView({block:'center',behavior:'instant'})`，仅滚第一个非 ready artifact）接入提交后/切回/重启恢复三处既有 until 循环；**父逐行核对 diff 确认返回条件一字未改、无任何断言删宽、未制造 IO 事件**，符合授权四约束。修复代理仅改 3 文件（`public/html-artifact-layout.js`、`tests/html-artifact-layout.cjs`、`tests/fixtures/visual-replies-functional-electron.cjs`），未碰并行 docs/`server/execution-timeline.js`，仓库无临时插桩残留。**已派独立复审代理**（xingchiapi/gpt-6.1-sol effort max，独立上下文不给父结论）静态+单元层独立验证八项问题（边界严密性/门控顺序/资源生命周期/性能/懒挂载语义不退化/jsdom 契约/驱动是否放水/对照实验抗fact-check），报告落 `C:/Users/21022/AppData/Local/Temp/lazyfix-review-report.md`。正式产物未重建（跑源码版才可见），待复审通过后随集成重建。

- **懒挂载修复独立复审第一轮：不通过（Important 1，I-1），已派定点修复**。复审员（独立上下文）确认大量正确部分——门控顺序全对、`measuredNearby` 零尺寸/非有限/零视口边界严密、几何重测有界（1 初始+8×80ms，true 即停非无限轮询）、dispose 完整清理 timer/RAF/listener/observer、远端目标仍保持惰性**未退化成全 eager**、**驱动修正未放水**（删 helper+三处调用后与 HEAD 字节相同、23 条 return 行不变、无假 IO 事件）、对照实验真实（HEAD 14 通过 5 失败 / 当前 19 全过，复现作者数字）。**但抓出一项真实 Important（I-1，真实浏览器复现非纸面推测）**：`measuredNearby` 对 `overflow:auto/scroll/overlay` 祖先**无条件**扩展 600px 预热，未检查容器是否真有可滚动范围（`scrollHeight > clientHeight`）——负向偏移被裁切、根本无法滚动抵达的 target，原生 IO=false、旧 HEAD=false，当前实现却=true → 不可达内容被提前挂载/恢复活动，懒挂载/暂停语义回归。复审员用 Edge+原生 IO 实证（`#port{overflow:auto}` 内 `#target{top:-200px}`、clientHeight==scrollHeight、scrollTop 写负仍 0）。测试缺口：`html-artifact-layout.cjs:190` scrollport 测试只 mock rect/overflowY 未设 clientHeight/scrollHeight（jsdom 均 0），建模不出「真实可滚动内容」前提。复审实测：三套单测 50/50、驱动自检 18/18+28/28、独立边界探针 41 通过 3 失败（三失败即 I-1 的 auto/scroll/overlay 反例）、HEAD 内存对照 14/5 vs 当前 19/0。**已派定点修复代理**（xingchiapi/gpt-6.1-sol effort max）按复审员最小方向修复：Y 轴预热须同时满足有效正 clientHeight 且 scrollHeight>clientHeight，无实际可滚动范围按零扩展裁切处理；保留 hidden/clip 零扩展与内外裁切投影顺序；补真实尺寸 fixture+负向不可达反例测试；只改 layout.js+layout.cjs，**不碰** execution-timeline/docs/驱动修正。修复后父另派独立复审收敛，修复者不自证。复审完整报告 `C:/Users/21022/AppData/Local/Temp/lazyfix-review-report.md`。

- **I-1 定点修复已交付（未提交，收敛复审进行中）**：修复按复审员最小方向实施——`layout.js:97-99` Y 轴预热收窄为 `scrolls && axis==='Y' && parent.clientHeight>0 && parent.scrollHeight>parent.clientHeight`，否则 margin=0 且仍执行 overflow 裁切（不跳过）。产品仅 +3/-1；测试仅 +26——`:195-196` 原 scrollport 测试补 clientHeight=836/scrollHeight=2000 fixture（原断言逐字保留），`:209-232` 新增三参数化反例（clientHeight==scrollHeight、负向偏移不可达，断言 mount/负IO/scroll/有界重测后恒 `[false]`）。修复方证据方法严谨：**先红后绿**（先补测试复现 19pass/3fail 三失败即新反例、再修产品转 53/53）；**三路内存对照**（HEAD 17/5 vs pre-I1 19/3 vs current 22/0）——并诚实标注「HEAD 的 5 失败仍是先前几何/调度修复测试、非 I-1 反例；证明反例抓住 I-1 本质的是 pre-I1 三条失败→current 三条通过」，不把 HEAD 其他失败冒充证据。边界探针 6/6（无范围负偏移不可达 `[false]`、有实际范围正常可达 `[true]`）。三套单测 50→**53/53**（layout 19→22）。三禁碰文件（execution-timeline/docs/驱动）初末 SHA 一致未动。抗fact-check 严谨、边界清晰、不宣告通过。**已派收敛复审代理**（xingchiapi/gpt-6.1-sol effort max，独立上下文）只审本轮增量、核验 I-1 是否真实闭合+未引入新边界错误+正例仍工作+计数复现，报告落 `C:/Users/21022/AppData/Local/Temp/i1-recheck-report.md`。修复交付 `C:/Users/21022/AppData/Local/Temp/i1-fix-result.md`。

- **I-1 收敛复审通过（2026-11-27）——懒挂载修复链+驱动契约修正全部验收完毕**。复审员独立实测：三套单测 **53/53**（layout22/frame19/reading12）、修复前快照重放 50/50、三路对照 HEAD 17/5·pre-I1 19/3·current 22/0（pre-I1 三失败精确为本轮三反例）、作者边界探针 6/6、复审方补充合成边界 12/12、**真实 Edge 原生 DOM/IO 对照 15/15 场景**（负偏移 pre-I1 `[true]`→current `[false]`→原生 IO false；正常可滚动预热及无需滚动可见目标仍 true）。确认 `layout.js:97-100` 新条件仅控制 margin、无实际范围时 margin=0 但**仍执行裁切不跳过**；旧 55 条含断言源码行逐字保留、assert 调用位置 69→72、无删改无 skip。**Blocker/Important/Nit/Pre-existing 全 0**。一个良性例外已核销：作者 compare 主入口 exit1 是因为父在复审期间正常更新台账（docs）触发其保护指纹校验在测试启动前停止——属脚本严谨性而非产品缺陷，复审员用独立 harness 直接跑原三 worker 复现全部三路数字，未冒称主入口通过。**至此工作区三个待审改动全部验收**：IDS（execution-timeline，独立复审关闭）、懒挂载+I-1（layout，收敛复审通过）、驱动契约修正（复审确认未放水）。报告 `C:/Users/21022/AppData/Local/Temp/i1-recheck-report.md`。

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

## 终态授权边界（用户 2026-11-27 明确指示）

**做完不 PR，等用户验收。** 终态为本地集成树 + 完整证据链，由用户验收后再决定后续。具体含义：

- **不 push、不建 PR、不合并、不发版**——此前「最终 push feat/visual-replies-p2 + PR + PR CI 作完整 canonical 证明」的预设**已全部撤销**。
- ~~完整 canonical 证明改为本地完整 `npm test`~~ → **用户 2026-11-27 进一步豁免：本地完整 `npm test` canonical 不用跑**（「npm test不用跑」）。完整 canonical 既不跑 PR CI 也不跑本地全量；canonical 证明缺口在交付报告作为**用户知情豁免**显性标注，不冒称已完成。
- 允许的最终动作只剩：本地集成、**受影响范围的定向验证**（懒挂载/驱动/IDS 等本任务改动面的定向测试与真实模型闭环——这些已在各修复/复审环节完成并构成验收证据）、正式产物构建与本地终验、交付报告。**任何把代码送出本机的动作都不在授权范围内。**
- 用户验收是合并/发布的前置门禁，验收结论未出前不推进任何后续阶段。
