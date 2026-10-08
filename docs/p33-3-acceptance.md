# P33.3：安全会话撤销候选与冲突预览验收报告

日期：2026-10-08。范围：持久证据读取、内存候选计算、只读 HTTP 预览；等待人工验收，不进入 P33.4。

## 1. 开发前后 HEAD 与工作区

- 开发前及交付时 HEAD 均为 `b384a028e3cab717d403f10409e135c9ea446031`，分支 `main`。未提交、推送、合并、发版或修改版本号。
- 开发前除原有未跟踪目录 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/` 外无改动；该目录保留。交付改动见 §2。
- 已阅读 AGENTS、README、P33.1a 设计、P33.2 报告及实际 store/bridge/extension/P32 runtime/worktree/router/Git 代码。没有以设计中的拟议接口冒充已实现接口。
- 遵守仓库禁止联网约束，未 fetch、查询远端或安装依赖；基线判断来自本地 HEAD 与用户确认。Jev 仅用于任务分类，实际安全决策由代码审查完成。
- 本报告的「事实」指代码或实测；「边界」和「待验证」不代表已经具备相应能力。

## 2. 修改与新增文件

新增：

| 文件 | 责任 |
| --- | --- |
| `lib/session-revert.js` | 纯字节候选算法、唯一映射、资格与操作链判断 |
| `server/session-revert-routes.js` | 只读预览、预算、当前文件读取及二次验证 |
| `server/session-revert-authority.js` | 复用 classic / P32 runtime / dormant workspace authority |
| `server/session-revert-compute.js` | 有限并发、可终止 Worker、随包计算代码加载 |
| `server/session-revert-worker.mjs` | 私有 Worker 入口，结构化克隆后恢复 Buffer |
| `tests/session-revert.cjs` | 算法、资格、多会话与属性组合测试 |
| `tests/session-revert-store.cjs` | 持久证据、归属、预算、损坏与重开隔离 |
| `tests/session-revert-http.cjs` | 真实 HTTP/临时文件系统/认证/只读性测试 |
| `tests/session-revert-integration.cjs` | Worker、身份生命周期、打包资源测试 |
| 本报告 | 验收证据与边界 |

修改：`server/session-change-store.js` 增加私有快照和 revision 读取；`server/session-change-bridge.js` 暴露私有 authority 回调；`server.js`、`server/router.js` 最小接线；`public/api.js` 增加明确请求的预览 helper；`scripts/build-exe.mjs`、`scripts/build-app.mjs` 打包计算资产；`package.json` 接入四个套件；`tests/session-change-live.cjs`、`tests/session-change-rpc.cjs` 增加真实 Pi 链路；`tests/gui-browser-stop.cjs`、`tests/stop-barrier.cjs` 补充新增组合依赖的 VM fixture。

未修改 Pi 本体、P33.2 extension、Git restore 实现或既有 Git Changes 界面。没有新增依赖、session registry、第二套证据存储、文件恢复接口或候选持久正文出口。

## 3. B/A/P/C/R 与算法

代码：`lib/session-revert.js:19`（无损解码）、`:36`（唯一 LCS）、`:73`（逆三方）、`:102`（证据）、`:131`（操作链）。

- **B**：P33.2 默认工具在操作前实际确认的字节，`null` 明确表示原先不存在；空 Buffer 表示原有空文件。
- **A**：该操作记录的目标字节。
- **P**：实际写入后的独立观察字节。仅在实际 journal 状态 `observed`、`toolResultObserved === true`、完整 B/A/P、P 与 A 逐字节一致且证据等级合格时使用 A。
- **C**：预览时通过受限文件描述符读取的当前字节。
- **R**：在虚拟内容上逆序推演得到的候选字节，始终不写入工作区。

这里 journal 的状态 `observed` 与证据等级 `observed` 是不同概念；后者不具备候选资格。真实状态结构直接来自 P33.2，而非另造 `completed` 状态（`lib/session-revert.js:102`，`tests/session-revert.cjs:73` 附近的负向测试）。

## 4. 核心合并流程

1. 校验原始字节可严格 UTF-8 往返，保留 BOM、CRLF、LF、单 CR、混合换行与末尾换行，不归一化、不忽略空白。
2. 对原有普通文本，以 A 为 base，分别计算 A→B 与 A→C。行 token 包含原始换行；同一行内的独立字符变化仍保守视为冲突。
3. 前缀/后缀 LCS 矩阵枚举所有最优映射中的匹配边；可接受映射必须唯一。重复上下文出现多解时 `ambiguous_mapping`，不用任意 tie-break、模糊 patch 或字符串替换。
4. 逆向 hunk 与后续 hunk 相交、同点插入或插入边界不明确时拒绝。互不相交时在 A 的坐标上组合两组变化，重新编码得到 R。
5. C=A 且证据完整时，B 是可证明的精确逆像；允许 Agent 替换原有用户内容后恢复 B。该分支不是一般性的 baseline 覆盖方案，C≠A 时仍必须通过三方判据。
6. C=B 则 `already_reverted`；整条已确认操作链当前精确等于首个 B 时也无操作。无法证明的部分撤回不会猜测成功。

拒绝结果无正文候选，也不产生冲突标记。算法不导入 filesystem/Git，不调用 restore/checkout/reset/apply（`lib/session-revert.js:1`）。

## 5. 连续修改与跨会话

事实：`server/session-change-store.js:198` 在原有 journal 单队列中取一致快照，按 workspace 全局 sequence 收集所选路径的全部交叉操作；无关路径不加载。所选 IDs 必须全部属于被授权的持久 session scope。引用对象校验 digest、隐私权限和链接，原始数据只送后端私有计算。

`lib/session-revert.js:131` 对指定操作逆序作用于虚拟 C，不使用最后一次 B 覆盖。对记录间 A_i 与 B_(i+1) 不一致，必须能证明唯一、独立的外部变化；无法证明则拒绝整个文件，保留冲突 operationId。后续其他会话的未完成、重叠操作也会阻断该文件。

跨会话独立行修改可保留。除此之外，`:117` 对所选变化两侧及后续变化两侧的标识符交集进行保守依赖拒绝，包含单字符、Unicode、既有变量值变化和后续删除引用，避免显而易见的「删除定义但保留依赖」。该检查可能误拒绝，**不证明任意业务语义独立**；反射、跨文件依赖、没有共同标识符的语义联系仍待解决。候选资格表示已满足本文的内容判据，不能宣传为程序行为一定不变。

身份：`server/session-revert-authority.js:9` 复用完整 owner；classic 的原生 session、managed 的 generation/native session、关闭后持久 conversation/native/workspace identity 均重新校验。`server/session-change-bridge.js:192` 复用既有 workspace authority。关闭历史不伪造 live owner；重新打开或 epoch 改变使在途预览失效。

fork 相同 native history 不自动获得原 conversation 的 operation 所有权（store 按 conversation + native + workspace scope 匹配）；共享历史没有证据继承机制，因此不能跨 conversation 选取原操作。实际 Pi fork 后全流程尚未专门实测，不能把 fixture 的 scope 隔离视为这项实测。

## 6. attributionGap 与资格

`lib/session-revert.js:102`、`:153` 附近执行以下门槛：

| 证据/状态 | 行为 |
| --- | --- |
| 完整 `intent_verified`、P=A、最终事件存在 | 可计算受限模式内容候选，仍无写回资格 |
| `exclusive_verified` | 纯算法保留该等级；HTTP 不宣称现有 provider，严格模式仍不可用 |
| 证据等级 `observed`、`incomplete`、`unsupported` | 不可升级为候选；保留等级，返回 `incomplete_evidence` 等原因 |
| 缺失/旧历史 | 算法 `no_evidence`；API `evidence_not_found`，不伪造 baseline |
| 任意正 workspace gap / 相关 operation gap | `attribution_gap`，包括操作捕获时与当前 gap 数值相等的情况 |
| 未结算 writer、缺最终事件、P≠A | `active_writer` 或 `incomplete_evidence` |
| 对象缺失、损坏、隐私验证失败 | 固定完整性错误，整个请求失败关闭 |
| workspace/owner/revision/C 改变 | 对应 stale 错误，要求重新预览 |
| 已精确撤回 | `already_reverted`，无操作，不重复逆向 |

P33.2 没有实际独占 provider，也没有可靠 gap 清除。工具结束、文件稳定、用户确认均不能清除未知工具 gap。shell/MCP 等未知写入不因为运行结束而升级。测试专门覆盖「record gap=workspace gap>0」和「caller gap=0 但 record gap>0」（`tests/session-revert.cjs:51`、`:76` 附近）。

## 7. 文件边界

- 原有 tracked/untracked UTF-8 文本按实际 B 识别，B 非 null 就是原有文件；不以 Git 状态推断创建。
- before=absent 的 Agent 新建文本，只有虚拟当前精确等于该创建链的目标，才生成未来 `move_to_recovery` 动作；当前缺失无操作，用户加内容则拒绝。本阶段没有移动/删除文件。
- 删除、rename、二进制、非 UTF-8、缺失原有文件、超预算、大复杂 diff、特殊路径均拒绝。链接、junction、hardlink、目录等在读 C 前拒绝（`server/session-revert-routes.js:39`、`:56`）。
- P33.2 没有足够的 before/after 权限/ACL/特殊元数据证据。即使普通文件内容候选成立，HTTP `limited.applyEligible=false`、`reason=metadata_unsupported`；当前 stat 不能补造历史元数据。P33.4 必须实现并验证元数据写回契约。
- 多文件逐项给出内容候选/冲突；总体 limited.contentEligible 仅在全部文件合格时为 true。不涉及部分实际恢复或自动回滚。

## 8. 只读 API 契约

接线：`server.js:882`、`server/router.js:171`；helper：`public/api.js:102`。只提供 **POST `/api/session-revert/preview`**，沿用 token + Origin 认证；namespace 内 raw/apply 等返回 404，GET 返回 405。

请求封闭字段：

```json
{
  "conversationId": "optional-managed-or-dormant-conversation",
  "owner": {
    "backendInstance": "backend-id", "projectId": "project-id", "repoId": null,
    "workspaceId": "workspace-id", "workspaceEpoch": "epoch-id",
    "conversationId": "conversation-id", "runtimeId": "runtime-id",
    "runtimeGeneration": "generation-id", "sessionId": "native-session-id"
  },
  "evidenceIds": ["operation-id"],
  "mode": "confirmed_limited",
  "evidenceRevision": 12,
  "includeDiff": false
}
```

实际 owner 字段只能是 `backendInstance/projectId/repoId/workspaceId/workspaceEpoch/conversationId/runtimeId/runtimeGeneration/sessionId`；示例值需替换为服务端实际确认的完整身份。classic 可用现有 owner header；managed 用 body 的完整 owner；dormant 不接收旧 live owner。客户端不得指定路径、root、nativeSessionId、正文或任意 scope。`evidenceRevision` 可选，提供则必须匹配；mode 仅 strict / confirmed_limited，内容冲突判据相同。

响应固定范围（`server/session-revert-routes.js:184` 起）：

- target 仅 conversationId/workspaceId/workspaceEpoch；revision、gapRevision、retentionDays。
- files：相对路径、operationIds、conflictOperationIds、evidenceLevel、status、固定 reason、action、contentEligible、strict/limited 资格。
- 合格文件 changeSummary：currentBytes、candidateBytes、selectedOperationCount、action。新建移出候选 candidateBytes=null；无操作为当前字节数；拒绝无候选摘要。
- strict 始终 `exclusive_provider_unavailable`；limited 可表示内容成立，但 **applyEligible 始终 false**，requires 包含 metadata_validation、prepare_backup、confirmation、bounded_writer。
- **backupReady=false**，没有确认 token 或 apply plan。成功的 needsRepreview=false 只表示本次末次校验未发现变动，不授权稍后写回；`externalConcurrencyUnexcluded=true` 明示没有排除外部写入。
- 默认不返回完整 B/A/P/C/R、digest、native session、capability token、绝对路径或私有存储路径。只有 includeDiff=true 才给限定 C→R 文本预览；单请求总额 32KiB，超出时整份该文件 diffUnavailable，不截断成误导 patch。预览是单个包围变化区的显示片段，并非可应用 patch。

典型文件拒绝：`ambiguous_mapping / overlapping_changes / cross_session_conflict / unproven_continuity / attribution_gap / incomplete_evidence / unsupported_operation / unsupported_text / oversized / unsupported_path / diff_budget_exceeded`。请求级错误使用固定 code；stale 系列标记 needsRepreview=true。没有通过错误文本泄漏内部异常。

## 9. 逐字节结果与测试矩阵

核心实测不是对照 HEAD：真实 Pi 场景前置文件 B 为用户未提交内容（49 bytes），两次默认 write/edit 后，外部 fixture 再改独立尾行得到 C（53 bytes），候选 R（55 bytes）恢复 B 的 Agent 修改区域并保留用户后来尾行。`Buffer.deepEqual` 校验 R，预览后磁盘仍是 C（`tests/session-change-live.cjs:137`—`:192`）。fixture 内容摘要：

| 状态 | SHA-256 |
| --- | --- |
| B | `d8cc4c37b0e315e206efb6397f950c4f1838be644033143d19d0cc925fe6c11e` |
| C | `b6e76c0ae045490989a70cd1a36bf4f5f08e914fe6d1c3d2c7365e66f708b21b` |
| R | `ab07e2047c424ebbe79ff7d8badf152f4858ffa6ec82611b7a188f17757303f3` |

以下对应实际自动化用例；A=`tests/session-revert.cjs:11` 起，S=`tests/session-revert-store.cjs:25` 起，H=`tests/session-revert-http.cjs:40` 起，I=`tests/session-revert-integration.cjs:12` 起，L=`tests/session-change-live.cjs:137` 起。所有写盘 fixture 在临时目录；算法不写盘，HTTP/L 在请求前后对比文件或 journal/index/ref，拒绝时不产生恢复写入。

| # | 场景 | 预期、数据保留验证 | 证据 |
| --- | --- | --- | --- |
| 1 | 用户原有 dirty 修改 | 恢复实际 B，逐字节相等 | A、L |
| 2 | 干净文件 Agent 修改 | 正确逆向候选；C 不变 | A、H |
| 3 | 同文件独立区域 | 合并为期望 R | A，240 组属性组合 |
| 4 | Agent 后用户独立编辑 | 保留用户尾行 | A、L |
| 5 | 后续同区域编辑 | 拒绝，外部当前字节不变 | A、L |
| 6 | Agent 替换前置用户内容 | C=A 可恢复 B | A、L |
| 7 | 用户已自行撤回 | already_reverted，不重复逆操作 | A、H |
| 8 | 连续三次同会话编辑 | 逆序还原首个 B | A |
| 9 | 连续操作中间用户独立修改 | 唯一映射时保留，否则 unproven_continuity | A |
| 10 | 两会话同文件独立区域 | 保留另一会话内容 | A、S |
| 11 | 两会话同区域/可疑依赖 | 拒绝，附冲突 operationId | A |
| 12 | 不同 workspace 同名文件 | 不加载/返回其他 workspace 证据 | S、H、P32 回归 |
| 13 | shell/未知工具 gap | gap 永不因稳定自动清除，拒绝 | A、L 原有 nested tool 实测 |
| 14 | observed/incomplete/P≠A/未结算 | 不因确认升级 | A、H、S |
| 15 | Agent 创建未再改文本 | 仅未来 move_to_recovery 候选，磁盘保留 | A、H |
| 16 | 创建后用户添加内容 | creation_modified，保留当前文件 | A |
| 17 | 原有 untracked | replace 内容候选，绝不当新建删除 | A |
| 18 | 删除/rename | unsupported_operation | A |
| 19 | 二进制/非法 UTF-8/超限 | unsupported_text/oversized/预算拒绝 | A、H |
| 20 | BOM/CRLF/LF/混合/末尾换行 | 字节与预期一致，无归一化 | A、L 原有 BOM 实测 |
| 21 | 重复文本有多解 | ambiguous_mapping | A |
| 22 | 同点插入/边界冲突 | 拒绝 | A |
| 23 | 对象缺失/损坏/隐私失败 | 固定错误，不返回正文 | S、H |
| 24 | workspace epoch/generation 改变 | 失效/隔离，不读旧归属 | S、I |
| 25 | 旧会话无证据 | no_evidence/evidence_not_found | A、真实 RPC |
| 26 | 未授权跨会话/token/Origin | 读取前拒绝或 scope 拒绝 | S、H、I |
| 27 | 复杂 diff/CPU 超预算 | 矩阵拒绝或终止 Worker | A、H、I |
| 28 | 重复预览 | 响应确定、不消费 journal | A、H、L |
| 29 | 默认摘要内容/token 泄漏 | 无正文/绝对路径/私有引用 | H、L |
| 30 | 预览只读 | 文件/journal/index/HEAD/tree 相同 | H、S、L |
| 31 | 预览中外部编辑/owner 改变 | stale_current/stale_runtime；外部内容保留 | H、I |
| 32 | hardlink/junction/目录 | unsupported_path，拒绝跟随 | H |
| 33 | 多文件部分冲突 | 第一文件候选、第二文件冲突，总体不合格，两文件均不变 | H 专项用例 |
| 34 | 关闭恢复/程序重开 | 持久 scope 可读；旧 live owner 不被复用 | S、I、真实 RPC、L 重开 |
| 35 | 新版随包 worker | 代码字节绑定 data URL，不用旧提取缓存 | I、打包 Worker 实测 |

## 10. 测试结果

执行日志保留在本机临时目录，前缀 `pi-gui-p33-3-`（baseline/full/live-final/rpc/packaged-rpc/build/app）；报告只引用测试结果，不把原始工具 payload 放入日志或仓库。

| 检查层次 | 通过 | 失败 | 跳过 | 说明 |
| --- | ---: | ---: | ---: | --- |
| 开发前 npm test | 92 套件，exit 0 | 0 | 1 | 既有 session-search 5i 文件 symlink 权限不足 |
| 开发后完整 npm test | 96 套件，exit 0 | 0 | 1 | 原有 symlink 5i；完整运行 HTTP 为 64/64，后补 1 项见下行 |
| 新算法 | 66/66 场景 | 0 | 0 | 包含 240 个独立编辑组合，不额外当成 240 场景计数 |
| 新持久 store | 14/14 | 0 | 0 | 真实临时文件；隐私 adapter 注入，生产 ACL 见真实 Pi |
| 新 HTTP 最终定向运行 | 65/65 | 0 | 0 | 完整回归后仅补多文件部分冲突测试；生产代码未再修改 |
| 新 Worker/authority integration | 19/19 | 0 | 0 | CPU 终止/并发/身份；含 data URL 代码加载 |
| 打包资产 Worker integration | 19/19 | 0 | 0 | 条件分支加载实际 resources/app 的 worker/algorithm |
| 真实已安装 Pi 1.0.4 默认工具 | 23/23 | 0 | 0 | fixture 流式模型 provider，生产 Windows ACL |
| 真实 Pi 源码后端 RPC | 14/14 | 0 | 0 | classic/managed/dormant 实际接线 |
| 真实 Pi 打包后端 RPC | 14/14 | 0 | 0 | 实际 server.cjs，由 Node 启动 |
| Electron 打包 app-check | 26/26 | 0 | 0 | 隔离应用目录与数据目录，实际打包后端启动 |
| Stop 受影响 fixture | 11/11、16/16 | 0 | 0 | gui-browser-stop / stop-barrier 数字未减少 |

新增四套件最终共 **164 个场景/检查**；完整 npm test 当次为 163，之后补充的多文件部分冲突用例及其 HTTP 全套 65/65 已定向通过。完整回归之后没有生产代码变化，无须重建产物。开发期间捕获并修复：缺失模块的初始红测；正 gap 错误放行；短标识符/既有变量/Unicode/删除引用依赖遗漏；路由 snapshot 前并发准入；随包执行缓存。Stop 两个 VM fixture 最初缺新增组合依赖，现已补齐实际依赖，无删除断言。真实 Pi 重开用例从 operationCount=11 改为 13，是新增两次默认 write/edit 所致，无减少断言。

完整回归重点：worktree lifecycle 56/56、HTTP 14/14、UI 16/16；runtime registry 32/32、HTTP 12/12、store 25/25、conversation 48/48、changes scope 60/60、secondary 17/17、Git UI 6/6、resources 45/45、cleanup 16/16、history/search 35/35、finishing 27/27；session-runtime 5/5；真实 Windows Pi supervisor 24/24、process scope 10/10；P33.2 store 35/35、bridge 23/23、tools 29/29，均失败 0、跳过 0。完整入口既有 session-search symlink 5i 为唯一明确跳过，不计入通过分母。未减少旧套件断言。

没有以 fixture 模型冒充真实远端模型任务，没有真实 UI 视觉改版，本阶段未增加按钮或页面。

## 11. 真实 Pi → 只读预览端到端

`tests/session-change-live.cjs:18` 导入实际安装的 Pi SDK，真实 Extension runner/default tool dispatcher 经 P33.2 bridge/store 写入 B/A/P（并非手造 journal）。`:137` 后增加默认 write + edit 两次执行，外部 fixture 用户独立尾行修改，再从私有持久快照读取证据、实际 Worker 计算、真实认证 HTTP 预览，最后模拟同区域冲突。

新增五项检查实际通过：R 的 Buffer 精确比较；HTTP 内容资格与写回禁用；显式 diff 重复一致；同区域后改拒绝；所有预览 journal/index/refs 不变。完整真实 Pi 套件 **23/23**，包含旧 P33.2 重复工具源、dynamic drift、未知工具 gap、生产隐私及重开验证。模型输出受控，无远端模型请求。

`tests/session-change-rpc.cjs:12` 启动实际后端与真实 Pi CLI。新增 classic/managed/dormant 的真实 authority 请求，缺证据时均明确拒绝；源码与重建的打包后端均 **14/14**。这些 RPC 检查证明实际接线，非完整候选 E2E 的替代；完整候选 E2E 由上一段提供。

## 12. 性能、安全与打包边界

预算：`lib/session-revert.js:2`、`server/session-revert-routes.js:9`、`server/session-revert-compute.js:15`。

- 文件 2MiB；沿用 store 每操作 16MiB、conversation 128MiB、全局 512MiB、保留 7 天。preview 进一步限定 32 文件/128 操作/128MiB 原始引用字节，重复引用保守重复计费。
- 算法 20,000 行 token、总 2,000,000 矩阵单元、750ms；Worker heap old=128MiB/young=16MiB，最多两项活动计算、2s 终止上限。HTTP snapshot 前亦最多两个预览，不积累无限原始证据队列；多文件共享 2s 计算预算。
- 1,201 行独立修改 fixture 在当前机器 **1.62ms** 因矩阵预算拒绝；这是拒绝成本样本，不是普遍性能承诺。无限循环 fixture 用 60ms watchdog 终止，测试要求总耗时 <2.5s。
- 30s 是 **协作式 I/O 截止检查**，不是硬 HTTP 响应上限。Windows 原生 ACL adapter 在 await 内可能超过截止时间后才拒绝；最多 128 操作仍可能有较长延迟，并暂时占用原 store 队列。没有把该限制隐藏为原子事务或零延迟保证。
- 不递归扫描工程推测 Agent 修改，不碰 Git index/ref/workspace 内容；读取只针对已授权证据路径。默认摘要、SSE、Activity、localStorage 不新增原始证据出口。
- 当前文件用 lstat、受限 descriptor、stat/父目录身份及内容 hash 前后检查，并在返回前再次读取与校验 revision/owner。它们用于**检测变化**，不构成排他锁、CAS 或原子写入；最后一次检查之后仍可变化。只读阶段不覆盖文件，P33.4 必须重新 prepare/备份/确认。
- 计算在后端 Worker，不占 renderer diff 主线程。Worker 执行代码直接取随包 bytes 并使用 data URL，不走通用 `.ok` 提取缓存，避免升级继续执行旧算法及该缓存的替换风险（`server/session-revert-compute.js:6`）。同一用户可修改安装文件/进程的攻击不在此保证内。
- `npm run build:app -- --rebuild` exit 0：应用入口约 234.9MB，整包约 327.8MB。新资产分别写入 SEA asset 表和 Electron resources/app；Electron 资产/后端已实测。独立 SEA exe 启动尚未专门实测，data URL 执行路径由 integration 覆盖，不宣称独立 SEA 全链路验收。
- Windows 实测 junction/hardlink 拒绝；一般文件 symlink 创建受本机权限限制的旧测试仍跳过。POSIX、真实编辑器高强度竞争、长时间 soak、真实模型完整编码任务与实际 fork 生命周期均未验证。

## 13. P33.4 接口准备

稳定输入：服务端确认的 operation IDs、scope、revision/gapRevision、mode；稳定输出：文件状态/action、冲突 IDs、固定拒绝原因、摘要及受限 diff。`server/session-change-store.js:233` 的私有快照可复用，禁止向 renderer 暴露原始对象。

P33.4 的 prepare 必须重新验证身份、证据、gap 与 C，校验历史/当前元数据，在写入前持久备份当前 C，再生成有限期确认计划。**本阶段没有备份、backupReady、确认 token、应用日志、消费 operation 状态或 BoundedWriter。** 重复 preview 不消费操作；未来已恢复 operation 的持久消费/防重放必须由实际应用 journal 记录，而不能以 preview 的 already_reverted 代替。

严格模式需真正 exclusive provider 及排他写回能力；受限模式需明确用户确认残余外部并发风险。相同冲突门槛、未知归因及损坏证据不得因用户确认降低。多文件 prepare/apply 的部分失败策略、可恢复日志和元数据保护仍属于 P33.4，不提前实现。

## 14. 验收结论与未解决风险

**P33.3 在本文明确边界内满足验收条件，待人工验收。** 完整 npm test exit 0，补充 HTTP 用例 65/65，真实 Pi 候选链路与打包验证均通过。核心功能已实现为只读内容候选：保留前置 dirty 和后置独立字节修改；连续操作与跨会话按持久证据推演；冲突、未知归因、多解、损坏、特殊类型均拒绝。没有增加真实恢复能力。

主要残余风险：文本判据不能证明任意语义独立；行级与标识符依赖检查会保守拒绝；没有真实独占 provider/gap 清除；历史元数据不足；外部并发不能排除；I/O 截止不是硬取消；独立 SEA/POSIX/真实 fork/竞争 soak 尚未实测。上述边界不得在 P33.4 中被静默升级为安全保证。

人工验收后另行授权 P33.4。本阶段停止于候选和只读预览，不自动提交、推送或继续实现。
