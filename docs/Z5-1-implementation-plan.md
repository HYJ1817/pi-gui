# Z5-1：并行会话输入可靠性实施计划

> 本文件是可审阅的未来实施方案。当前 Z5-0 **不执行任何步骤**。用户独立验收并明确启动后，由执行 Agent 使用 executing-plans 逐项推进；本计划不要求或授权子 Agent、推送、PR、合并、安装或发布。

**目标**：并行会话中，中文输入法确认不会提前发送；身份匹配、容量内的未发送纯文本能在刷新/重开后恢复。

**架构**：沿用 runtime-state 的唯一 store、runtime-conversation 的 captured owner 发送链及 draftRevision；增加小型 UI 文本存储适配，复用 Classic 已有的存储原语，不复用 Classic 全局输入绑定。不更改后端执行、Registry manifest、Pi session schema 或权限。

**技术栈**：原生 ES modules、DOM、localStorage、现有 jsdom/fake Pi/Electron fixture；零新增依赖。

基线：审计使用 `c7fbad65500e1c20b6084f421c7920d8f77ffbc6`；实施必须重新核对最新main及PR #36。事实依据见 [F1/O1审计](Z5-0-product-audit.md)，阶段安排见 [路线图](Z5-roadmap.md)。

## 1. 范围与非目标

范围包含 Runtime textarea 的IME守卫、文本草稿保存/恢复/清除、身份与存储失败边界、对应用户内联反馈和离线回归。不改变当前262144字符输入上限。

非目标：统一Classic/Runtime所有Composer功能；模型/思考策略（Z5-2）；自动发送恢复文本；附件持久化；Slash命令/图片/文件拖入的新增支持；富文本编辑器；跨设备同步；全文日志；历史工具摘要；Pi/依赖升级；P33/T4-C资格扩展；CI修改或发版。

## 2. 复用边界与拟修改文件

以下是**计划路径**，不是本轮已经创建的生产文件。

| 文件 | 计划修改及限制 |
| --- | --- |
| 新增 `public/runtime-draft.js` | 只处理草稿key、捕获文本的防抖、恢复/清除及安全状态；调用draft.js已有read/write/remove与容量常量；不import后端、不维护新Runtime事实源 |
| `public/runtime-conversation.js:219-225,253-264,show/leave/dispose` | composition监听、切换状态复位、草稿适配接线、只对提交版本清理、内联存储提示；保留owner/pending/历史及焦点保护 |
| `public/runtime-store.js:25-35`（按回归需要最小修改） | 在seed的原记录更新、新记录继承、无owner记录更新路径中区分稳定会话身份与进程身份；禁止跨原生会话/epoch继承草稿及旧版本的清理权限，不重构其他事件状态 |
| `tests/runtime-conversation.cjs` | 在现有真实模块DOM夹具中新增IME序列、A/B身份、异步ACK和恢复用例；原48项保留 |
| 新增 `tests/runtime-draft.cjs` | 测key身份、容量/损坏/禁用存储、captured timer、清理幂等；不以源码字符串代替交互 |
| `tests/runtime-store.cjs`、`tests/session-background-recovery.cjs` | 补同conversationId下Owner/sessionId/workspaceEpoch变化的内存继承及恢复边界，覆盖原记录/新记录/无owner路径；保留原25项store检查与旧Owner拒绝 |
| `tests/fixtures/z5-runtime-input-electron.cjs`（拟新增）及 `tests/z5-runtime-input-electron.cjs`（拟新增） | 专项正常沙箱离线窗口、生产Runtime输入视图、fixture transport、真实键盘/重载与截图；遵循已有Electron runner模式，不复制整套runtime-electron夹具 |
| `package.json` | 新离线草稿套件进入唯一test链或已有alias；增加显式Electron入口；不改依赖、锁文件或workflow |
| `docs/daily-use.md`、`docs/sessions.md`、拟增 `docs/Z5-1-acceptance.md` | 明确Classic/Runtime恢复能力、容量和失败提示、证据与剩余限制 |

当前 `seed()` 会在新记录中无条件复制prior.draft/draftRevision，也可能直接保留原记录中的草稿；仅隔离持久key不足以满足下述合同。实施先补红测，必要时允许最小范围修改 `public/runtime-store.js` 的草稿继承分支，并在验收中说明diff及回归证据；不把“保持store不变”作为硬约束。`runtime-state.js`仍复用唯一store及现有广播，不能顺便重构Registry、其他事件状态或后端会话协议。

## 3. 关键行为合同

### 3.1 输入法与发送

Runtime textarea 在本地维护 `composing` 布尔值；compositionstart=true、compositionend=false；show切目标/leave/dispose清理。keydown判定顺序：

```js
// 拟议守卫；插入现有input.onkeydown，而非另建发送链。
if (event.isComposing || event.keyCode === 229 || composing) return;
if (event.key === 'Enter' && !event.shiftKey) {
  event.preventDefault();
  if (!send.disabled) send.click();
}
```

禁止用compositionend后的任意延时窗口吞掉所有Enter；这会使正常下一次发送失效。若真实输入法复验显示不同顺序，记录原生事件后补有证据的处理。Escape/Stop继续原有语义，不在本轮新增全局拦截。

### 3.2 草稿身份

持久key只取**后端快照已证明**的 locator 字段：projectId、workspaceId、workspaceEpoch、conversationId、nativeSessionId。它们必须是非空、有界的不透明标识；不取绝对路径、模型名称、DOM标题或当前Classic的S.state.sessionId。

```js
// key设计：与Classic的两段hash格式分开，字段先通过有界字符串校验。
const key = 'pi-gui.draft.v1:runtime:' + [
  projectId, workspaceId, workspaceEpoch, conversationId, nativeSessionId,
].map(encodeURIComponent).join(':');
```

- backendInstance/runtimeId/runtimeGeneration是易变执行身份，**不进持久key**；否则重开后读不到。每次动作仍必须验证当前完整owner，持久key不提供执行权限。
- nativeSessionId缺失、workspace证明缺失：只保留内存草稿，提示尚未具备恢复身份；禁止落入共享`nosession`。首次null→已证明身份可保存同conversation当前文本；已有native身份变化不得迁移旧草稿。
- 重启后同一已证明locator可恢复；workspaceEpoch/nativeSessionId任一不同则不恢复。dormant历史查看不spawn、不发送，打开历史不能清掉live草稿。
- 使用可编码的不透明标识，避免将32位FNV哈希作为草稿隔离的唯一判据。localStorage不是可信执行输入，恢复的文本须经用户再次明确提交。

**相同conversationId不等于相同草稿身份。** 同一隔离规则必须覆盖内存继承、正在聚焦的textarea、持久副本及迟到回调，不能只约束localStorage读取。身份比较从切换前捕获的记录和新权威记录取得；live记录的owner.sessionId与item.nativeSessionId都存在时必须一致，冲突/缺失证据不当作“同一身份”。

| 同一conversationId下的变化 | 草稿处理合同 |
| --- | --- |
| 仅runtimeId/runtimeGeneration变化，project/workspace/epoch/nativeSessionId均相同且已证明 | 属于同一原生会话的进程重启，允许保留草稿；旧执行Owner的ACK仍失效 |
| backendInstance变化，但新快照重新证明同一稳定locator | 不绕过store的backend清空；只允许按新快照的locator恢复对应持久副本，禁止重用旧Owner/回调 |
| 已绑定sessionId/nativeSessionId改变，或workspaceEpoch/project/workspace改变 | 属于新身份；禁止将旧draft/draftRevision复制或保留为新身份草稿。旧文本只留在旧分区，不重标记后写入新key；新身份只能展示自己的已有草稿或空值 |
| Owner变为null或由null恢复，稳定locator完整且相同 | 按稳定locator判断，不仅比较owner是否同为null；允许同一会话关闭/恢复保留草稿，且不自动spawn |
| 首次未绑定→已证明sessionId | 仅在原先确实未绑定、同一backend/工作区epoch/conversation/runtimeId/runtimeGeneration的首次绑定链上允许接续内存文本；不得套用于旧nativeId→新nativeId或迟到的旧绑定 |
| 身份冲突或无法证明上述关系 | 不迁移、不展示旧身份文本到新记录，保留可核对的旧分区；待权威身份明确后只恢复匹配分区 |

`seed()`的新建分支、同runtimeId/generation的原记录更新分支、owner均为null的更新分支都要测试。隔离时新身份建立自己的草稿版本域，不能用复制的旧draftRevision获取删除权限。即使用户始终聚焦输入框、conversationId不变，也须在稳定身份变化时同步切换输入归属并移走旧文本；不能依赖draw原有“失焦才回填”的条件完成隔离。

### 3.3 内容、容量与失败

- 复用draft.js的 `{v:1,text,at}`，只存纯文本；不存附件、路径、owner token、工具结果、网页内容、模型响应或认证数据。
- `DRAFT_MAX_CHARS=20000`为恢复上限，现有textarea的262144字符输入能力保留。短草稿使用现有read/write/remove；`readDraftText`已校验payload版本/文本类型，适配器再拒绝超长文本，不把畸形值填回DOM。`at`仅为存储元数据，不作为身份或自动过期依据；不为读取它重复实现另一套JSON解析器。
- 大于20000字符的当前文本**不调用会截断的writeDraftText**，清除该key旧的持久副本并保留完整内存文本；就地提示“草稿超过本地恢复上限，请复制保存完整文本”。不得仅保存前缀后显示“草稿已保存”。用户缩短到范围内后可再次保存。
- localStorage被禁用/配额满：保留现有有界内存降级，不阻止输入/发送；内联提示“草稿仅在本次窗口保留”。不新增反复Toast，不记录草稿正文到诊断。
- 400ms防抖捕获key/text/版本，执行时不得重读“当前会话”重新归属；切换前、leave、beforeunload同步flush捕获版本；dispose清timer并移除本实例监听器。
- 保存状态不获得执行锁，不改Registry；只在UI显示当前会话自己的提示。

### 3.4 发送与恢复竞态

现有发送捕获 `target/owner/draft/draftRevision`。保留以下判据，并在成功分支同步清理对应持久副本：

```js
result.ok && same(still?.owner, owner)
  && still.draftRevision === submittedRevision
  && still.draft === submittedText
```

旧ACK在A→B后不得清B；A发送后用户又编辑A不得清新文本。若持久副本已不同于提交文本，也不得删除。失败或不确定ACK保留文本且不自动重发。恢复只在该记录当前内存草稿为空且scope仍匹配时进行；迟到恢复不覆盖用户新输入。

同一conversationId发生Owner或稳定locator变化时，每次发送、恢复及防抖任务必须保留捕获的完整Owner（若有）、稳定locator和草稿版本，并在写回/清理前复核当前归属。即使新旧文本相同、draftRevision数值碰巧相同，旧Owner的ACK也不能清新身份的内存或持久副本；旧恢复结果不能覆盖新身份草稿。旧timer最多flush已捕获的旧key，不能以当前记录生成新key或将旧文本重新注入当前textarea；身份变化须使旧实例的恢复/清理任务失效。

“发送成功”沿现有HTTP接受语义，不扩大为模型完成；不修改原prompt/Stop/RPC合同。

## 4. 实施步骤（未来执行清单）

### 步骤1：确认最新基线与现有抽象

- [ ] fetch最新main、查看PR #36最终状态、记录精确基线SHA及完整CI/attempt/gate；在独立`codex/z5-1-runtime-input` Worktree开始，禁止修改Z5-0或Z4-6B工作区。
- [ ] 阅读AGENTS/REVIEW/testing、本文、Runtime store/恢复/发送链、draft.js的返回与降级语义。核对package-lock，按需只离线恢复现有依赖。
- [ ] 跑下面既有5类定向基线并保存exit/实际数量；不把Z5-0结果继承为新基线。没有可信完整基线或出现产品失败，先定位原因。

### 步骤2：先补F1失败回归，再加最小IME守卫

- [ ] 在现有DOM夹具seed合规ready/idle记录；输入后派发`KeyboardEvent('keydown',{key:'Enter',keyCode:229,isComposing:false,bubbles:true,cancelable:true})`；记录mock transport的prompt数组，断言长度为0。修复前应实测失败（当前为1）。
- [ ] 增加compositionstart→isComposing=false的Enter→compositionend序列、标准composing、Shift+Enter、普通Enter、切A/B、busy/历史禁用场景。测试必须调用真实视图，不直接测试一份复制条件。
- [ ] 按3.1修改现有handler，仍走send.click；运行同套件确认新断言通过且原48项保留。保存红/绿日志；不靠延时或删断言过关。

### 步骤3：先补O1恢复失败回归，再接入草稿适配

- [ ] 建立完整locator的A/B及普通项目/Worktree夹具，typing→等待防抖→重建renderer/store→同locator seed→显示A；断言完整文本相同、B未变化、网络prompt计数0。修复前文本为空，作为红测。
- [ ] 对同一conversationId先写旧draft及draftRevision，再分别seed：仅进程重启、同进程内nativeId变化、新进程且nativeId变化、同进程/新进程的workspaceEpoch变化、owner为null时locator变化。逐项验证3.2合同；当前跨身份继承应先取得红测，不能只测新建store或A→B。
- [ ] 新增runtime-draft适配器，按3.2—3.4处理身份、文本与timer；注入可抛错存储以验证降级，不写真实用户localStorage。
- [ ] 若适配器无法阻止seed的内存继承，在runtime-store的对应草稿分支最小修复；同时验证聚焦textarea在同conversationId换身份时不继续显示旧文本、不将其归到新记录。不改其他消息、审批、cursor或资源生命周期合同。
- [ ] 在show/leave、输入与发送成功边界接线；内存store仍是当前草稿唯一可编辑状态，持久副本仅用于恢复；不要在每次draw中覆盖草稿。
- [ ] 补入下节矩阵的存储、竞态、容量和隔离测试；注册新套件进入package.json唯一链。原草稿A/B、Owner拒绝、draftRevision断言均保留。

### 步骤4：真实窗口与构建证明

- [ ] 使用TEMP项目、fake Pi和离线guard，运行新专项正常沙箱Electron入口；实际偏好contextIsolation=true/nodeIntegration=false，并确认启动参数没有`--no-sandbox`。已有默认降沙箱的runtime-electron入口不能直接充当该证明。
- [ ] 验证A/B输入、真实键盘Enter/Shift+Enter、重载和窗口重开；用受控composition事件验证兼容序列，额外人工Windows中文IME场景另列真实输入法证据，不将合成事件冒称OS输入。
- [ ] 截图700/900/1200宽、亮暗主题，输入法/存储内联提示可见、无横向溢出，不抢焦点；捕获异常、请求数、scope及文本一致性结果，不把草稿正文放公开报告。
- [ ] 修改public后运行`npm run build:app -- --rebuild`，按构建策略同时覆盖SEA；运行`npm run fixtures`后验证app/exe。完整打包窗口专项确认草稿逻辑来自新资源，不只看源码窗口。

### 步骤5：收敛验收与交付

- [ ] 稳定后按testing政策完成一次完整canonical；若用户预先选择当前PR CI，则到结果完成前明确标待验证。不得自动推送/创建PR来获取CI。
- [ ] 让具备独立上下文的审查者检查身份分区、发送ACK、存储隐私与回滚；若未来仍要求单Agent，明确缺少独立审查并交用户安排，不冒称独立通过。
- [ ] 更新使用说明及Z5-1验收，记录首次失败、红绿、skip、截图、产物、未测IME/环境及最终SHA。中文提交按回滚边界拆分，先写Git元数据COMMIT_MSG_TMP.txt再commit -F；不自动进入推送/合并/发布。

## 5. 测试要求与命令

以下是**将来执行命令**；其中新增套件本轮不存在，本轮未执行这些新增测试。

```powershell
node tests/runtime-conversation.cjs
node tests/runtime-store.cjs
node tests/daily-use.cjs
node tests/session-background-ui.cjs
node tests/session-background-recovery.cjs
node tests/context-reference-ui.cjs
node tests/runtime-draft.cjs
node tests/z5-runtime-input-electron.cjs
node scripts/run-test-group.mjs --validate
npm run build:app -- --rebuild
npm run fixtures
node tests/app-check.cjs
node tests/exe-check.cjs
```

| 矩阵 | 必须断言的结果 |
| --- | --- |
| IME true、keyCode229、composition生命周期、结束后普通Enter | 前三类0次prompt；结束后普通Enter1次；没有重复触发 |
| Shift+Enter、空白、busy、history | 换行保留；不提交、不切换owner、不自动Stop |
| A/B互切、同项目不同会话、不同Worktree | 文本和持久key隔离；只读浏览不激活项目；切换时防抖捕获文本仍归旧scope |
| reload/app重开、同locator/different backend | 同一已证明稳定locator恢复；不要求旧runtimeId复用；不自动resume/prompt |
| 同conversationId，仅runtimeId/runtimeGeneration变化 | 同一已证明nativeSessionId/epoch的草稿保留；旧执行Owner的ACK拒绝，不能为了隔离而清掉合法重启草稿 |
| 同conversationId，sessionId/nativeSessionId或workspaceEpoch变化 | 同进程原记录更新、新进程新记录、owner为null路径均隔离；新身份不继承旧draft或版本清理权限；聚焦textarea同步移走旧文本，旧分区不改写成新分区 |
| 未绑定→首次绑定、已绑定→其他nativeId、身份字段冲突 | 只有可证明的首次绑定链允许接续；其余拒绝迁移。owner.sessionId与item.nativeSessionId冲突不放行 |
| epoch/native ID改变、无native身份、locator畸形 | 不串稿，不写通用空身份key，不从DOM/Classic补身份 |
| 发送成功/失败、发送后继续编辑、迟到A ACK | 只清确认提交版本；失败/后续编辑保留；B完全不变 |
| 同conversationId换身份后的旧ACK/迟到恢复/防抖timer | 新旧文本和revision数值相同也不误删/覆盖；比较捕获Owner及稳定locator；旧timer不得向新key或当前textarea写旧文本 |
| 0、20000、20001及更长文本 | 空白清副本；边界完整；超限保留内存全量并明确不可完整恢复，不静默截断；输入上限不缩小 |
| 配额满/隐私模式、坏JSON/版本/类型/超长值 | 不崩溃、不阻断发送；不恢复畸形内容；内联降级状态且不刷Toast |
| dispose/重复mount、切换前最后一次输入 | timer/listener回收；最后版本按捕获keyflush；旧实例不覆盖新实例文本 |

新测试数以实际执行为准，不预报未来N/N。现有断言不减少；若合并重复断言，逐项说明替代证据。skip不计分子分母。

## 6. 风险、验收及回滚

整体复杂度中、回归风险中；R1本身低风险，R2主要风险为恢复到错误身份、旧ACK清新稿、容量降级误导和额外文本落盘。上述矩阵分别对应这四类风险。localStorage为现有本机用户边界，不承诺加密或跨账户隔离，不为此新增密钥管理系统。

验收必须同时满足：F1红绿可复查；范围内文本字节/字符一致且身份隔离；同conversationId下合法进程重启保稿、新原生会话/epoch变化隔离及旧ACK/恢复拒绝均有红绿证据；不会自动发送/启动；失效边界有测试；正常沙箱窗口与重建产物证据存在；完整canonical覆盖最终行为状态；独立审查及用户验收状态如实记录。任何跨会话泄漏、自动发送、Owner校验放宽、未解释断言减少都阻断验收。

仅查看DOM/纯策略绿测不能替代真实窗口；合成IME事件不替代实体输入法。缺少哪层就标哪层待验证。

回滚按业务提交revert，重建产物；不删除用户Pi session/Registry或强制清全量localStorage。新增命名空间可不再读取，保留文本待用户处置；没有后端格式迁移。测试/文档回滚独立，不回退无关Z4修复。
