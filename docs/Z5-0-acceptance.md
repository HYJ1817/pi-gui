# Z5-0 审计与规划验收记录

日期：2026-10-26（Asia/Shanghai）。本轮唯一执行Agent：Codex；未启动子Agent。

**结论：四份规划文档已形成，等待用户独立验收。没有实现Z5-1，也没有取得产品代码验收、推送、PR、合并或发布许可。**

## 1. 交付范围与身份

| 项目 | 记录 |
| --- | --- |
| 仓库 | HYJ1817/pi-gui |
| before HEAD / 审计及本轮测试覆盖源码 | `c7fbad65500e1c20b6084f421c7920d8f77ffbc6` |
| 分支 | `codex/z5-0-roadmap` |
| Worktree | `C:\Users\21022\.codex\worktrees\z5-0-roadmap\pi-GUI`，由原生create_worktree从origin/main创建，再建立指定分支 |
| 初始状态 | 新Worktree跟踪/未跟踪文件均干净；未继承原工作区未提交内容 |
| 规划内容提交 | `4a6ad4e91f48565e535903ddb07289fba897852b`，含产品审计/路线图/Z5-1计划；不是行为提交 |
| 最终验收记录提交 | `git log -1 --format=%H -- docs/Z5-0-acceptance.md` 精确解析含本报告的提交；最终交付回复同时给出固定SHA。文件不尝试嵌入包含自身内容的Git提交哈希 |
| 内容边界 | 仅下列4个Markdown；public/server/lib/electron/tests/package/lock/workflow零修改 |

交付：

1. [产品与技术审计](Z5-0-product-audit.md)：12模块、UI及工作流、代码/证据、缺陷/限制/风险分层。
2. [路线图](Z5-roadmap.md)：4项工作、3个阶段、依赖/并行/验收和暂缓项。
3. [Z5-1实施计划](Z5-1-implementation-plan.md)：范围/非目标、拟修改文件、身份/容量/ACK合同、步骤/测试/风险/回滚。
4. 本验收记录：文件与模块覆盖、实测及未测边界、远端/Git身份、复现方式。

生产行为、依赖、现有测试与CI均无变化，因此依testing政策跳过完整npm test及构建；用户也明确要求本轮避免完整测试。

## 2. 远端快照与PR #36去重

20:35上海时间收尾复核：`git ls-remote origin refs/heads/main`仍为上述c7fbad6；未移动本分支基线。

| 对象 | 本轮查询结果 |
| --- | --- |
| main CI | [40315861760](https://github.com/HYJ1817/pi-gui/actions/runs/40315861760)，push / attempt1 / head及gate SHA均c7fbad6，8/8作业成功 |
| main gate | Complete evidence=true；Passed221、failed/cancelled/interrupted/skipped/running/unexecuted均0；core145、ui24、security27、native4、faults21 |
| PR #36 | [Z4-6B最终集成验收](https://github.com/HYJ1817/pi-gui/pull/36)，OPEN、mergedAt=null、head `465762951c52a56c3eabdc49a3b4003f20e03855`；本轮不合并 |
| PR #36 CI | 初查core/ui/build已完成，其他组运行中；收尾[40319458611](https://github.com/HYJ1817/pi-gui/actions/runs/40319458611) completed/success，pull_request / attempt1，8/8作业及gate成功 |
| PR实际测试身份 | API head为4657629；gate日志checkout为合成merge `2f1fdf86bd0a062dc8f3303d5add5af8791977c0`，不是已合并main；gate 221/221、其他状态0 |
| PR差异核对 | main…PR head共103文件：docs102、scripts1。`git diff --quiet origin/main origin/codex/z4-6b-final-integration -- public server lib electron package.json package-lock.json .github tests`退出0 |
| Issues | GitHub连接器search_issues与`gh issue list --state open --limit 100 --json number,title,url`均返回空数组；无开放Issue，不等于无缺陷 |
| Tag/Release | tag排序与`gh release list --limit 5`交叉核对最新v0.29.0；没有打tag、下载更新包或发布 |

main及PR结论来自本轮API/作业/gate日志读取。没有下载并独立重算这两次run全部artifact ZIP摘要，不声称完成独立artifact provenance认证，也不把PR SHA混同main。PR #36的39项索引、已有打包窗口/系统输入验证不列成Z5新开发。

## 3. 检查过的文件与模块

这是实际阅读/定位的模块清单，表示抽样核对各边界，不声称逐行审查所有生产代码。

| 类别 | 已检查范围 |
| --- | --- |
| 规则/文档 | AGENTS、REVIEW、README核心能力/安装/会话/Git部分；docs/README、architecture、testing、coding-style、acceptance、daily-use、work-surfaces、model-capabilities、pi-compatibility、diagnostic-logging、windows-in-app-update |
| 规划/历史验收 | P32.4、后台会话2026-10-20、UI-visual-finish、Z1、Z3-A、Z4-5-large-transaction-design、Z4-6-stability-findings/test-matrix/acceptance、T4-B-design、T4-C-acceptance、P33-D6-final、G3/G4；PR #36的固定SHA feature-audit/integration记录/PR说明 |
| 装配/身份 | server.js、server/router、server/auth；public/app/index/state/api、runtime-state/store/recovery、session-navigation；Runtime Registry记录/summary/owner及ordinary-sessions；draft.js |
| 项目/会话/Pi | public/projects/sessions、runtime-conversation/models；server/projects/sessions/session-history、rpc-bridge、runtime-registry、ordinary-sessions、provider-auth/SDK及pi-compat-matrix的相关边界 |
| 文件/扩展/认证 | public/git/specs-panel/attachments/messages/markdown、ui3-model-picker/settings/extensions/provider-auth；server/git-routes/specs/uploads/providers/skills/extension-registry/mcp-native；lib/extract入口 |
| 执行/安全/恢复 | Planner组合与scheduler/verifier接线、candidate/transactions/review authority接线、session-revert-object writer/profile/routes的关闭闸门；Electron main openPath/Browser边界；相关设计及测试 |
| 协同/资源 | lib/collab-doc常量/闭集；collab-panel轮询/销毁、source/service/store等生产接线；process-panel refresh单飞/日志/revision/dispose；runtime模型异步相关性 |
| 测试/构建/CI | package.json及生命周期、scripts/test-group-plan/run-test-group、ci.yml完整gate/分组/build结构、runtime-conversation/store/models、daily-use、ui3-model、runtime-electron runner及现有协同Electron证据 |
| 看过的真实历史截图 | UI-5 packaged-current-final的light-700-pane.png、native-dark-1300.png；P32.4 A-stopped-B-running.png。没有生成新截图或拿历史图冒充当前窗口 |

工作区相关只读检查：git status/log/worktree list/fetch/tags/remote及差异。原工作区位于codex/z4-5-advanced-editing，HEAD d919fc9，保留原4项未跟踪内容：`$null`、`.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`、`.t3a-run/`、`docs/superpowers/plans/2026-10-22-project-development-governance.md`。没有修改其他checkout或其产物；共享Git对象/ref因fetch及新增分支发生正常更新。

## 4. 本轮实际运行与证据边界

Windows、Node v24.22.1。新Worktree执行`npm ci --offline --no-audit --no-fund`，退出0，恢复93包；仅忽略的node_modules变化，无锁文件/依赖版本更新、无联网下载。npm显示既有whatwg-encoding弃用及esbuild install-script提示；不因这些提示修改依赖或安装策略。Electron dist不存在，未下载补齐。

| 命令/检查 | 实测结果 | 说明 |
| --- | --- | --- |
| node tests/runtime-conversation.cjs | exit0，48/48 | DOM/owner/草稿/滚动/迟到响应，非布局 |
| node tests/runtime-store.cjs | exit0，25/25 | 唯一store隔离及事件合同 |
| node tests/daily-use.cjs | exit0，31/31 | 命令/快捷键/状态文案等，不能据此宣称Runtime草稿已持久化 |
| node tests/runtime-models.cjs | exit0，51/51 | 当前保守Runtime模型合同 |
| node tests/ui3-model.cjs | exit0，50/50 | Classic模型视图合同 |
| node scripts/run-test-group.mjs --validate | exit0，221叶、145/24/27/4/21 | 只验证canonical清单覆盖，没有执行221叶 |
| 现状刻画探针 | exit0，8+5=13项断言 | 验证F1/D1/O1当前行为仍存在，**不表示修复**；代码见下一节 |
| 文档/范围检查 | 收尾记录在第8节 | 本轮无产品代码、测试或CI修改 |

5套合计205/205项，无本轮skip、无断言删减。部分首次终端输出被显示长度截断，随后在同一未改行为树重读最终行并显式保存exit；不是将两次失败运行拼成成功。定向日志保留在`%TEMP%\pi-gui-z5-0-audit\`，无需依赖临时目录也能用命令和下述代码复查。

本轮探针初版有两类工具/夹具问题：模型对比初次未先创建DOM，import state.js抛`document is not defined`；加jsdom环境后5/5。输入探针摘要最初手写checks=7，实际8条assert，已纠正并完整重跑8/8。另有Windows rg通配路径、猜测不存在模块路径及gh --jq引号失败，均改为真实路径/PowerShell对象读取；没有将它们报成产品失败，也未修改产品以迎合探针。

## 5. 可复查的离线现状探针

在审计基线、已装锁定jsdom的仓库中执行以下PowerShell here-string。只写jsdom内存存储、mock请求；不启Pi、不联网、不修改用户数据或现有测试文件。13条assert刻画现状，Z5修复后相应“当前错误行为”断言应失败，未来回归要改验正确合同。

```powershell
@'
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<div id="host"></div><div id="modal" hidden><div id="modalCard"></div></div><div id="confirmLayer" hidden><div id="confirmCard"></div></div><div id="toasts"></div>', {url:'http://127.0.0.1/'});
Object.assign(globalThis, {window:dom.window, document:dom.window.document, localStorage:dom.window.localStorage});
const {runtimeStore} = await import('./public/runtime-state.js');
const {createRuntimeStore} = await import('./public/runtime-store.js');
const {createRuntimeConversation} = await import('./public/runtime-conversation.js');
const {createRuntimeModels} = await import('./public/runtime-models.js');
const {thinkingAvailability} = await import('./public/ui3-model-picker.js');
const owner = {backendInstance:'fixture-backend',projectId:'p',repoId:'r',workspaceId:'w',workspaceEpoch:'e',conversationId:'A',runtimeId:'rt',runtimeGeneration:'g',sessionId:'native-A'};
const item = {conversationId:'A',workspace:{branch:'fixture',projectId:'p'},owner,lifecycle:'ready',activity:'idle',revision:1};
const snapshot = {ok:true,backendInstance:owner.backendInstance,items:[item]};
const calls = [];
globalThis.fetch = async (_url, opts={}) => ({json:async()=>{if(opts.body) calls.push(JSON.parse(opts.body)); return {ok:true};}});
runtimeStore.seed(snapshot);
const view = createRuntimeConversation({host:document.querySelector('#host')});
view.show('A');
const input = document.querySelector('#host textarea');
const type = text => {input.value=text; input.dispatchEvent(new dom.window.Event('input'));};
const key = async init => {input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...init})); await new Promise(r=>setImmediate(r));};
type('fixture composing'); await key({isComposing:true}); assert.equal(calls.length,0);
type('fixture shift'); await key({shiftKey:true}); assert.equal(calls.length,0);
type('fixture legacy ime'); await key({keyCode:229,isComposing:false});
assert.equal(calls.length,1);
assert.equal(calls[0].command.type,'prompt');
assert.deepEqual(calls[0].owner,owner);
type('fixture unsent'); assert.equal(runtimeStore.get('A').draft,'fixture unsent');
const fresh = createRuntimeStore(); fresh.seed(snapshot);
assert.equal(fresh.get('A').draft,'');
assert.equal(localStorage.length,0);
view.dispose();
const model = {provider:'fixture',id:'reason-conflict',reasoning:false};
const levels = ['off','low','high'];
const request = async ({command}) => ({ok:true,data:command.type==='get_state'?{model,thinkingLevel:'low'}:command.type==='get_available_models'?{models:[model]}:{levels}});
const models = createRuntimeModels({store:fresh,request,subscribe:()=>()=>{}});
assert.equal(await models.refresh('A'),true);
assert.equal(thinkingAvailability({model,levels}).state,'ready');
assert.equal(models.get('A').reasoning,false);
assert.equal(models.get('A').levels,null);
assert.equal(await models.setThinking('A','high'),false);
models.dispose(); dom.window.close();
console.log('Z5-0 characterization: 13/13; fixes NOT implemented; native IME NOT tested');
'@ | node --input-type=module
```

## 6. 问题、决策与阶段结论

| 编号 | 结论/状态 | 安排 |
| --- | --- | --- |
| F1 | Important、Pre-existing、未解决：Runtime条件IME事件可误发；本轮仅确认模块条件，非实体IME必现 | Z5-1 R1 |
| O1 | 已确认限制：live Runtime草稿不跨renderer恢复；非已承诺能力的回归 | Z5-1 R2 |
| D1 | 已确认Classic/Runtime思考合同分歧；P32历史有意保守，不能直接定性回归 | Z5-2 R3，待用户选择统一合同或保留差异 |
| O2 | 已确认限制：dormant历史无工具摘要；与live恢复分开 | Z5-3 R4，先核对真实形状/安全合同 |

未确认风险单列U1—U6于产品审计：Pi全面兼容、真实模型运行恢复、独立安全/更新资格、长期/DPI/罕见截图错误、大图原子事务、纯视觉/入口效率假设。没有以猜测增加阻断缺陷。

Z5-1为同一Composer范围内的可靠性交付，复杂度/整体回归风险中；Z5-2合同选择后才实施；Z5-3后端契约核对可与前阶段在独立Worktree并行，Runtime视图改动错开。不新建大型基础设施、不重复Z4功能、不预先创建后续Worktree。

## 7. 明确未运行及权限边界

- 未运行完整npm test、build:app/build:exe、安装升级、发布检查；本轮没有public/server变化，故无需重建。
- 未运行新Electron/OS IME/DPI/长期稳定性；没有新截图。旧runner的降沙箱证据不升格；PR #36正常沙箱打包证据只作为B引用。
- 未运行真实模型/外部MCP/OAuth请求，未读真实认证材料/用户日志/会话正文，未写真实项目。
- 未独立审查T4-C/P33/更新或本轮文档；遵守单Agent，本轮作者自查不能代替用户独立验收。
- 未改生产代码、依赖、现有测试或CI；未push、建PR、合并、tag、Release；未实现Z5-1。

## 8. 文档自查、Git收尾与回滚

自查：4份文档、23个本地链接、15处完整源码引用均通过核对；其中1处脚本只在PR #36固定SHA存在，已用git cat-file验证并保留B标记，不要求其在main存在。代码块闭合、F1/D1性质及阶段依赖已自查；规划三文件的git diff --cached --check退出0。已发现并修正文档初稿把不存在doc-preview模块当预览实现的引用，最终改为实际attachments/messages及上传提取路径；不以描述臆造模块。

规划内容提交为`4a6ad4e91f48565e535903ddb07289fba897852b`，随后本报告单独本地提交；最终验收提交用第1节命令精确解析。验收提交前再次检查暂存区空白及范围；提交后使用`git status --porcelain`确认干净、`git diff --name-status c7fbad65500e1c20b6084f421c7920d8f77ffbc6..HEAD`确认仅上述4个Markdown新增、`git diff --check c7fbad6..HEAD`核对完整交付差异。最终命令输出与固定验收SHA在交付回复给出。node_modules保持忽略；没有把临时探针或构建输出加入Git。

初次交付可回退上述两笔文档提交；下节审查补充是独立文档提交，可单独回退。不需要恢复用户数据或重建产物。内容等待用户独立验收；后续是否启动Z5-1、是否接受Z5-2合同均由用户另行决定。

## 9. 审查补充：同conversationId下的草稿身份隔离

2026-10-26收到用户提供的审查截图：Z5-1计划遗漏Runtime Owner变化时的内存草稿继承边界。截图是待核实的审查意见，不作为实施Z5-1或扩大生产修改范围的授权。本次修改前HEAD为`335b15bc952f9b9a26d7d13d342c84110ec22fb8`，工作区干净；fetch后origin/main仍为c7fbad6，审计基线不变。

**核对结论**：意见成立，是实施计划遗漏，不是Z5-0文档变更新引入的产品缺陷。`public/runtime-store.js:25-35`有三种相关路径：新建记录时复制prior.draft/draftRevision；同runtimeId/generation时更新原记录并保留草稿；owner均为null时只更新item，同样保留草稿。因此仅隔离持久key不能阻止旧内存文本进入新身份。现有发送ACK已检查完整owner，但新持久副本和迟到恢复仍需在实施中补边界。

本次仅修改本报告及`Z5-1-implementation-plan.md`，不重排路线图，不增加工作项：

1. 明确稳定locator与易变进程Owner的区别：相同已证明native会话/epoch下的进程重启可以保稿；nativeSessionId或工作区身份改变必须隔离；首次未绑定→已证明身份仅允许有连续证明的首次绑定链。
2. 将runtime-store的必要最小修改纳入候选文件和红绿步骤，取消“现有接口已足够、保持store不变”的假定，不改其他事件/Registry/执行合同。
3. 补同conversationId下Owner/sessionId/workspaceEpoch变化、原记录/新记录/无owner、聚焦textarea及版本清理权限的测试矩阵。
4. 补旧ACK、迟到恢复、防抖timer的捕获Owner+稳定locator+草稿版本复核；即使文本/revision数值相同，也不能删除或覆盖新身份草稿。

**本次实际验证**（只读生产模块、离线合成数据）：

| 检查 | 结果及证明范围 |
| --- | --- |
| Owner变化现状探针 | 7种组合14/14断言：同身份进程重启、native变化的原记录/新记录、epoch变化的原记录/新记录、转dormant的相同/不同身份，当前均保留旧draft与revision；这是现状刻画，非修复成功 |
| owner均为null补充探针 | 2/2断言：同conversationId、native/epoch变化后旧draft与revision仍在，覆盖ownerUnchanged分支 |
| `node tests/runtime-store.cjs` | exit0，25/25；没有修改套件或删减断言，不表示新隔离合同已有实现 |
| 文档自查 | 核对补充合同、步骤、矩阵、验收一致；提交前检查本次只改2个Markdown及git diff --check、本地链接/代码块闭合 |

探针均使用createRuntimeStore、合成完整owner/locator和递增revision；在内存记录写入fixture-draft及draftRevision=7后seed新记录，断言当前结果仍为该文本/7。无用户数据、文件写入、Pi或网络请求。本次未重跑原5套205项，未运行完整npm test/Electron/构建，因为仅修改规划文字；原数字继续仅绑定初次审计。

该Important审查意见状态：**已在计划中补足处理原则和测试要求；生产行为未修改，新隔离合同待Z5-1实施验证**。本次作者复核不冒称独立复审通过。最终本地提交SHA仍由第1节的Git命令解析并在交付回复固定；没有push/PR/合并/发布，继续等待用户验收。
