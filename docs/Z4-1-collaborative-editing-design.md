# Z4-1：Agent 与用户协同编辑——架构设计与隔离原型

状态：**设计 + 数据层原型**。本文是研究交付物，不是已实现的产品功能。
原型位于 `prototype/z4-1-collab/`（独立目录，不接入生产入口与 npm test 链）。

- 基线：origin/main `c6a44b2`（含 Z1 合并），分支 `codex/z4-1-collab-design`，独立 Worktree。
- 与 Z3-A（`codex/z3-interactive-viz`）完全隔离：未读取其 Worktree 内容，未假设其接口已稳定。
- 运行原型测试：`node prototype/z4-1-collab/collab-test.mjs`（49/49 通过，Node 24，无新增依赖；
  复核方法与逐项对照见 `prototype/z4-1-collab/README.md`）。

**验证状态标注约定**：本文凡标注〔已验证〕的语义均有原型测试证据；标注〔设计约束〕的
是未来生产实现必须遵守的规则，本轮未实现；标注〔待实现〕的属于 Z4-2 及之后阶段。
三者不互相推出。

---

## 1. 项目基线与源码检查结果

按任务要求阅读了 AGENTS.md、REVIEW.md、docs/README.md、docs/architecture.md、
docs/work-surfaces.md、docs/security.md，并核对了相关源码模块。关键事实：

| 领域 | 现状（以代码为准） | 出处 |
|---|---|---|
| 前端架构 | **零构建、零前端依赖**的原生 ES Module，`app.js` 只做装配；零 `innerHTML` 纪律 | architecture.md §六 |
| 代次防护 | `workspaceGeneration`（项目选择）与 `bridgeRun`（pi 运行代次）是两个独立概念；RPC 带期望 bridgeRun，SSE 按 bridgeRun 过滤旧事件 | architecture.md §四 |
| 评论存储（T3-B/T3-C） | `server/review-comment-store.js`：磁盘 revision（随机 UUID）+ CAS 冲突检测（写入前后各核对一次）+ 排他锁 + 原子替换；失败保留原文件 | git-changes.md §九/§十 |
| Owner 身份取证（T3-B） | `server/review-comment-authority.js`：经典/并行会话统一解析**当前完整 owner**（Runtime Registry、focusedConversationId、contextRevision、原生会话文件身份），前端不能选路径或作用域 | security.md §T3-B |
| 修改任务预览（T4-A） | 纯内存组合用户选中的已确认评论 → 预览 → 复制/填入（只追加草稿，不发送）；交付前核对 scope/owner/generation/revision，证据变化即清空旧任务 | git-changes.md §十一 |
| 安全采纳（T4-C） | 两阶段授权（120 秒单次 nonce）→ 确认时**消费 nonce 并重新复核全部来源身份** → 原子性写入由专用 native writer 承担；失败不自动回滚，恢复另行授权 | T4-C-design.md |
| P33 撤销边界 | `session-revert-writer.js` 是 limited writer（`exclusive:false` 等），生产 allowlist 为空；**只针对磁盘文件回退，与内存画布无关** | T4-C-design.md §勘察 |
| 面板承载 | `ui/split-workbench.js`（T2-A/T2-B）是有界布局容器，业务模块经 `mountSpecsPanel()` / `mountChangesPanel()` 挂载并复用原有渲染与安全校验；`right-pane.js` 是 viewport 测量唯一 owner | architecture.md §T2-A/T2-B、work-surfaces.md |
| 会话/数据目录 | `<DATA_DIR>/review-comments/<scopeHash>.json` 是唯一一处「Pi GUI 自有的有界应用数据存储」先例 | git-changes.md §九 |

## 2. 可复用能力和不可复用边界

### 可复用（模式或代码）

1. **revision CAS + 原子提交语义**（T3-B `review-comment-store`）。
   协同文档的 revision 冲突检测、失败保留原文档、损坏不覆盖，与它同型。
   未来落盘存储可直接借用其「排他锁 + 双重 revision 核对 + 临时文件 rename」结构。
2. **Owner/会话身份取证**（T3-B `review-comment-authority`）。
   「建议来自哪个会话」不由前端声明，由后端按当前焦点会话 + 持久 conversation 身份解析。
   协同编辑的 sessionId 绑定必须走同一处取证，否则旧会话的建议可以伪造。
3. **两阶段确认 + 确认时重验**（T4-C）。建议接受流程照搬其形态：
   预览（只读）→ 明确接受动作 → 接受时再核对一次 revision → 原子应用。
4. **代次防护**（workspaceGeneration / bridgeRun）。Agent 建议必须带
   生成它的 bridgeRun/generation，迟到响应不得越过生命周期落到新文档（同 T4-A「证据变化即清空旧任务」）。
5. **面板承载**（T2-A/B split-workbench）。未来编辑器作为右栏面板挂载，
   复用既有 mount/dispose/generation 守卫，不新造布局容器。
6. **配置与数据写入纪律**：原子写、失败降级、不覆盖损坏文件（project-config / session-flags 同型）。

### 必须独立实现

1. **文档数据模型与操作协议**（本文 §5）——仓库内没有结构化图形文档的先例。
2. **幂等操作日志**（appliedOps）——T3-B 的 CAS 只防并发写盘，不防同一操作重放。
3. **撤销/重做**——现有撤销都是 Git 层（`git restore`）或评论重载，没有内存操作级 undo。
4. **建议（proposal）生命周期**——T4-A 是「组合文本任务」，T4-B 是「真实执行产生 diff」；
   都不产生**结构化修改建议**，二者均不能直接套用。
5. **画布 UI**——prototype 未实现，属 Z4-2 范围。

### 不能混用的现有状态

- **不能复用 T4-C 的文件写入逻辑处理内存画布**（任务明令）。T4-C 管的是磁盘字节、
  Git 身份与 NTFS 原对象；内存文档只受数据协议约束，两套边界必须分开。
  未来「保存到项目文件」是**另一条**独立链路，走 safe-path + 用户授权，不与内存操作共享代码路径。
- **不能把 P33 的会话回退资格当作文档撤销资格**。P33 生产 allowlist 为空，是磁盘回退机制。
- **不能把对话消息流（ToolEntry）当作文档状态**。文档是独立业务状态，
  只允许通过面板挂载，不进 Timeline、不进 Composer 正文。
- **不能绕过 owner 取证自行在前端拼 sessionId**（T3-B 明确：前端不能选作用域）。

### 未来接入 Z3-A 而不形成第二套冲突协议

唯一原则：**Z4 协议是变更层，Z3-A 是展示层；二者通过适配器交界，不互相 import 内部状态。**

- Z3-A 的图表对象（形状、位置、样式）若要进入协同编辑，须经一个纯函数转换器
  `z3aToDocument(asset) → { document, 丢弃清单 }`：能映射的进 document，
  不能映射的（自由手绘、复杂样式）保留在 Z3-A 的展示状态里，**不做有损合并**。
- 反向只有一条路：接受建议后的 document 变更事件（仍是结构化操作，不是整图覆盖）。
- Z3-A 的 JSON schema、状态 API、消息身份协议**全部标记为待确认**（见 §8），
  在其 MVP 定稿前，Z4 不定义任何依赖其具体字段名的代码。

### 协同编辑是否必须引入大型前端框架

不需要。论证见 §3：自研轻量编辑器（路线 A）在数据层收益上与重型方案完全等价，
而重型方案与「零构建、零前端依赖」的既有架构直接冲突。

## 3. 编辑器技术选型对比

| 维度 | A. 自研轻量节点编辑器 | B. React Flow (@xyflow/react 12.12) | C. Excalidraw (0.18.1) |
|---|---|---|---|
| 流程图/架构图 | 够用（节点+连线+文字即 MVP 全部需求） | 强，节点系统成熟 | 白板定位，图结构弱（元素非图语义） |
| 节点/连线/文字编辑 | 需自建（工作量主要在此） | 内建完整交互 | 内建但偏手绘 |
| **数据结构利于 Agent 修改** | 完全自控：协议即文档（闭集操作） | 需要把 React 状态↔外部 JSON 双向同步；受控模式可行但多一层 | Excalidraw 的 elements 是绘制元素，Agent 按坐标/类型生成易碎 |
| 差异比较 | 对操作序列天然可解释（本原型已实现） | 需在快照 JSON 间做树 diff | 同左，且元素模型噪声大 |
| 撤销/重做与冲突 | 自建（本原型已验证撤销/冲突模型） | **撤销/重做不是内置通用能力**：官方以示例形式提供，接入与语义适配需自行实现；且与我们的 revision 冲突模型语义不同 | 内建 undo（白板级），同样与 revision 冲突模型语义不匹配 |
| 与现有前端架构适配 | 原生 ESM 直接落地 | **引入 React + react-dom + 构建链**，与零构建零依赖架构冲突 | 同左，另需字体/CSS 接入 |
| 依赖体积 | 0 | React 系全家桶（数十 KB 级库 + React 运行时） | ~1.1 MB min / 344 KB gzip（未含 React） |
| 许可 | 无 | MIT（Pro 仅示例收费） | MIT |
| 维护 | 自担，但协议面小、可测 | 活跃（2026-07 仍有性能版本发布） | 活跃，但版本节奏慢、peer 依赖常报 ERESOLVE |
| 安全边界 | 全部走自家白名单/转义纪律 | 第三方渲染面，需审查节点渲染 XSS 面 | 同左，面更大（含字体与导入导出） |
| Windows Electron 性能 | SVG/DOM 数百节点无压力；上限由协议数量限制（200/400）保证 | 同量级可行，多一层 React 协调开销 | 大画布性能好，但引入成本不值得 |

**推荐：路线 A（自研轻量编辑器），理由按权重：**

1. 本任务是「Agent 与用户交替修改同一份结构化文档」，核心难点在**数据协议**，
   不在绘制效果。三个路线在数据层能力上等价，差异全在 UI 体验。
2. B/C 都要求引入 React——这不是「加一个依赖」，是给零构建代码库增加一条构建链
   与两份运行时分发物。仓库曾为同样理由拒绝 markdown-it（security.md §三）。
3. 操作数量上限（200 节点/400 连线）由协议保证，性能与安全都在受控范围内。
4. 视觉效果不是选择标准；若未来确需高级交互，可在 document 协议之上换渲染层，
   协议不绑定 UI（§5 要求 10）。

## 4. 推荐架构

```
┌─ 右栏（未来 Z4-2）：split-workbench 挂载协同编辑面板 ─────────────┐
│  画布 UI（SVG/DOM）——只渲染 document 投影，不持有第二份业务状态      │
│  用户手势 ──→ 受控操作（闭集）──→ applyUserOperation / commitOperations │
│  建议 UI：预览 diff → 接受/拒绝 ──→ acceptProposal / rejectProposal    │
└──────────────┬───────────────────────────────────────────────┘
               │ HTTP（既有令牌 + Origin 认证）
┌──────────────▼───────────────────────────────────────────────┐
│ 后端（未来 Z4-2+）：文档存储（T3-B 同型的锁+CAS+原子替换）        │
│  owner 取证复用 review-comment-authority；建议与 bridgeRun 绑定    │
│  Agent 建议只来自 Pi RPC 会话产物，经 schema 校验，绝不直接执行      │
└──────────────────────────────────────────────────────────────┘
```

分层职责：

- **document**（可序列化纯数据）：唯一可编辑业务状态，revision 单调递增。
- **editorState**（运行时，不序列化）：撤销/重做栈。〔设计约束〕其生命周期与编辑器实例
  一致：**面板关闭即丢弃、切换会话/项目即失效、应用重启即清零**；不做跨会话或跨重启持久化。
  已接受的修改不受影响——它们已并入文档（revision 已前进），丢失的只是「继续撤销
  历史操作」的能力；重开后从当前 revision 起算新历史。若未来产品要求「关闭面板
  保留编辑且可继续撤销」，必须把撤销栈升级为后端暂存并在 Z4-2 单独验收，不得静默沿用内存栈。
- **proposal**（Agent 产物，短生命周期对象）：基于某 revision 的一批结构化操作，接受前不落盘。
- **persistence**（Z4-2+）：沿用 T3-B 存储形态，另立任务设计权限与路径校验（§9）。

## 5. 文档与操作协议（schemaVersion 1）

### 5.1 文档

```jsonc
{
  "documentId": "doc-1",          // [A-Za-z0-9][A-Za-z0-9_-]{0,63}
  "schemaVersion": 1,             // 闭集；未知版本拒绝读、拒绝覆盖
  "revision": 3,                  // 正整数，每次成功批量应用 +1
  "title": "流程图",
  "boundSessionId": "sess-1",     // Agent 建议归属的会话（先到先得，切换需显式解绑）
  "graph": {
    "nodes": [ { "id": "n1", "label": "开始", "x": 0, "y": 0 } ],
    "edges":  [ { "id": "e1", "from": "n1", "to": "n2", "label": "…" } ]  // label 可省
  },
  "appliedOps": [ { "id": "op-…", "fp": "…" } ]  // 有界幂等日志：opId + 内容指纹，500 条 FIFO，运行时元数据
}
```

约束：节点/连线 id 全局唯一且共用一个命名空间；连线禁止自环与同向重复；
`x/y` 为有界有限数（|v| ≤ 100000）；label 1–200 字符；
容量上限 200 节点 / 400 连线 / 序列化 2 MiB（超限拒绝，不做静默截断）。

### 5.2 操作

```jsonc
{
  "opId": "u-17298…",             // 全局唯一，重复提交幂等
  "type": "node.update",          // 闭集：node.add|node.update|node.remove|edge.add|edge.update|edge.remove
  "baseRevision": 3,              // 前置条件：等于当前 doc.revision，否则 stale-base
  "actor": "user",                // user|agent；agent 只能出现在建议通道
  "params": { "id": "n1", "label": "新文字" }   // 每类型闭集字段，未知字段即拒绝
}
```

各类型前置条件与修改范围（v1 全集）：

| type | 前置条件 | 结果 |
|---|---|---|
| node.add | id 未占用；节点数未达上限 | 新增节点 |
| node.update | 节点存在；label/x/y 至少改一项 | 就地更新 |
| node.remove | 节点存在且**无连线引用**（先删边） | 删除节点 |
| edge.add | 两端节点存在；非自环；同向不重复；id 未占用；连线数未达上限 | 新增连线 |
| edge.update | 连线存在；label 为 string 或 **null**（null = 清除文字，撤销需要） | 更新或清除 label |
| edge.remove | 连线存在 | 删除连线 |

### 5.3 建议（proposal）

```jsonc
{
  "proposalId": "prop-doc-1-3-2-a1…",
  "schemaVersion": 1,
  "documentId": "doc-1",          // 必须等于当前文档，否则 document-mismatch
  "baseRevision": 3,              // Agent 阅读到的文档版本
  "sessionId": "sess-1",          // 必填；与 boundSessionId 不一致即 session-mismatch
  "rationale": "补充缓存层（≤2000 字）",
  "ops": [ /* ≤50 条，actor 强制为 agent，opId 批内唯一 */ ]
}
```

### 5.4 满足的协议要求对照

| 任务要求 | 协议机制 |
|---|---|
| Agent 只提交结构化建议，不执行代码 | 建议是纯数据；操作类型闭集；无任何表达式/脚本字段 |
| 用户与 Agent 同一套变更模型 | 唯一差别是通道（直接操作 vs 建议+接受），落点都是 applyOperations |
| 逐条 schema 验证 | validateOperationSchema + validateAgainstState，未知字段/类型即拒 |
| 前置条件/范围/预期结果 | §5.2 表格；失败返回稳定错误码（schema/exists/missing/referenced/self-loop/duplicate-edge/limit） |
| 未知字段不越权 | exactKeys 逐层精确匹配，多余字段直接 schema 错误 |
| 重复提交不重复修改 | appliedOps 日志 + accept 幂等优先检查；重放返回 duplicate 无操作（边界见 §5.5） |
| 旧 revision 冲突检测 | baseRevision !== revision → stale-base，附 {baseRevision, currentRevision} |
| 失败保留原文档 | 两阶段：先在副本上整体验证并模拟，全部通过才一次性提交 |
| 可解释差异 | describeOperation 生成每条操作的人类可读摘要（preview.diff） |
| 协议与 UI 解耦 | 纯数据 + 纯函数，无 DOM/IO；UI 只消费投影 |

### 5.5 幂等与防重放边界〔已验证，且有明确范围〕

appliedOps 是**有界防重放窗口**（最近 500 条，FIFO 淘汰），**不是永久全局防重放机制**。
三种情形的处理约定（原型测试 4a/4c/4d 覆盖）：

| 情形 | 判定 | 处理 |
|---|---|---|
| 窗口内，同 opId 同内容 | 内容指纹（type + baseRevision + actor + params，**递归键排序的规范化序列化**，与属性插入顺序无关）一致 | `duplicate`：幂等无操作，文档与 revision 不变 |
| 窗口内，同 opId 不同内容 | 指纹不一致（含 baseRevision 不同——被重定基的操作视为新语义） | `opid-reuse`：拒绝执行，文档不变 |
| 窗口外（opId 已被 FIFO 淘汰） | 日志不再认识该 opId | **opId 语义唯一性不再保证**；重放由 revision 单调性兜底——旧操作的 baseRevision 永远追不上单调前进的 revision，必然 `stale-base` |

推论与生产决策点：

- 指纹包含 baseRevision：**「重放」指字节级重发**；同一逻辑改动换了 baseRevision 再提交，
  按 `opid-reuse` 处理而不是按重放静默吞掉。
- 淘汰后的 opId 名额可被新操作复用。若 Z4-2 需要跨会话、跨重启的更强防重放
  （例如防恶意构造的当前 baseRevision + 旧 opId），必须把操作账本持久化并扩大比对范围，
  这是 Z4-2 的显式决策点，本协议不假装已提供该保证。

## 6. Agent 修改建议与冲突处理机制

流程（借鉴 T4-C 两阶段形态）：

1. 用户编辑当前文档（每次成功操作 revision +1）。
2. Agent 基于其阅读到的 `baseRevision` 产出建议（由后端从 RPC 会话产物中提取并校验；
   建议的身份与代次验证见 §6.1——服务端取证，不采信模型自述）。
3. 系统校验建议（文档归属、会话归属、schema、幂等、结构）。
4. 只读预览：生成 per-op 可解释差异与预期 revision，**不改变文档**。
5. 用户接受或拒绝；拒绝是纯声明动作，零状态变化。
6. 接受时**再次核对**：expectedRevision 由调用方显式传入并与 doc.revision 比对，
   随后完整重跑建议校验（确认前重验，T4-C 同型）。
7. 无冲突才原子应用：整批一个 revision，opIds 进幂等日志，记入撤销栈。
8. 冲突（stale-base / session-mismatch / document-mismatch）时：用户当前内容与
   Agent 建议都保留，界面提示重新生成或人工处理；**绝不自动合并、绝不覆盖**。
9. 应用后 revision 前进，新建议必须基于新 revision。
10. 撤销/重做：接受的建议与用户操作共用撤销栈；撤销以逆操作实现（新 opId），
    重做重放前向参数（新 opId——重做是新的逻辑变更，不能复用旧 opId 触发幂等误判）。

v1 不做 CRDT/OT：冲突一律显式失败并保留双方材料，由人决定重新生成。
单用户 + 单 Agent 交替编辑场景下，这比引入合并引擎可靠得多，也符合
「先验证实现方案」的阶段目标。

### 6.1 建议链路的身份与代次验证〔设计约束，原型仅数据层替代〕

**sessionId 与 actor 是模型可以自述的字段，属于不可信输入，绝不采信。**
未来生产链路中必须由服务端完成三件事，原型里的 `bindSession` /
`boundSessionId` 比对只是数据层替代物，不能照搬为安全边界：

1. **真实 owner 取证**：建议归属的会话由服务端按 T3-B
   `review-comment-authority` 同型逻辑解析——当前焦点会话、持久 conversation 身份、
   Runtime Registry 的 workspace ID/epoch；前端与模型自述的 `sessionId` 只能与
   取证结果比对，不能作为事实来源。
2. **Pi 会话代次验证**：建议必须绑定产生它的 bridgeRun / workspaceGeneration；
   服务端按现有 SSE/bridgeRun 过滤纪律丢弃迟到响应，旧代次的建议即使内容合法
   也只能提示重新生成，不得进入新文档的建议队列。
3. **建议来源登记**：建议从哪一次 RPC run 的产物中提取由**服务端**登记并传递，
   客户端不能提交「来源」字段；模型输出中任何形如「我来自会话 X」的内容都不是身份证据。

## 7. 隔离原型及测试证据

位置 `prototype/z4-1-collab/`：`collab-doc.js`（数据层，~600 行）+ `collab-test.mjs`。
零依赖（`node:assert` 之外无 import）、无 DOM、无 IO、无网络，不触碰用户真实数据。

运行结果（Node v24.22.1，Windows，在本 Worktree 内实测）：

```
Z4-1 原型数据层测试：49 通过，0 失败（共 49 项）
```

独立复核方法、文件清单、真实输出与逐项对照表见
`prototype/z4-1-collab/README.md`。断言总数 49 = 初版 33 项 + 审查收尾 2 项
（4c/4d）+ 最终验收修复 14 项（13a–d 批次预览/撤销、14a–d 建议幂等身份、
15a–e 反序列化上限、16 指纹键序无关）。

对任务 §七/E 与 §九 12 项验收点的覆盖：

| 验收点 | 测试 |
|---|---|
| 1 schema 校验 | 1a–1f（documentId、未知字段、未知 schemaVersion、悬空/自环、未知操作字段与类型） |
| 2 正常节点连线 | 2a（3 节点 2 连线样例文档）、2b（改文字/移动/加连线） |
| 3 无效操作拒绝 | 3a–3c（自环、悬空、重复边、非法坐标、超长文字、删除被引用节点） |
| 4 重复操作幂等 | 4a（同 ID 同内容重放 → duplicate）、4b（建议重复接受）、4c（同 ID 不同内容 → opid-reuse）、4d（窗口外重放 → revision 单调性兜底 stale-base） |
| 5 revision 不一致 | 5a（旧 baseRevision 操作）、5b（建议带 conflict 明细） |
| 6 并发修改冲突 | 6a（用户先改 → 建议接受失败 stale-base，用户内容原样保留，建议可重新生成） |
| 7 失败原状态保留 | 7a（批次第二项失败 → 第一项也不生效，序列化逐字节一致） |
| 8 建议接受/拒绝 | 8a（预览差异 + 原子接受 + revision 前进）、8b（拒绝零状态变化） |
| 9 撤销重做边界 | 9a（撤销已接受建议 → 重做回原内容）、9b（空栈报错且不变）、9c（新编辑清空重做栈） |
| 10 超大数据/非法引用 | 10a（201st 节点 limit）、10b（51 操作建议 limit）、10c（2MiB 守卫） |
| 11 旧 owner/会话/文档 | 11a（document-mismatch）、11b（缺 sessionId）、11c（切会话后旧建议拒）、11d（agent 伪装 user 拒）、11e（重复绑定 fail closed） |
| 12 可序列化可复现 | 12a（serialize∘deserialize 幂等）、12b（同操作序列产出同字节）、12c（反序列化后续编辑） |
| 13 同批「先新增、再修改」 | 13a（节点：预览不异常、撤销/重做精确恢复）、13b（无 label 连线加文字：撤销恢复无此连线）、13c（既有无 label 连线两次改文字：撤销恢复为无 label）、13d（带 label 连线改文字：撤销恢复原 label） |
| 14 建议幂等身份 | 14a（伪造 sessionId 拒）、14b（换 documentId 拒）、14c（非法 schema 拒）、14d（同会话同内容仍幂等） |
| 15 反序列化上限 | 15a（节点数）、15b（连线数）、15c（连线 ID 重复/同向重复）、15d（输入体积）、15e（含 label 合法文档往返兼容） |
| 16 指纹键序无关 | 16（同语义不同属性顺序 → duplicate） |

**诚实边界**：以上全部是数据层验证。未做任何真实 GUI 集成、未验证排版或交互，
不应据此宣称「编辑器已完成」。

## 8. 与 Z3-A 的接口依赖（全部待确认）

| 问题 | 当前答案 | 待确认条件 |
|---|---|---|
| 是否共享文档容器 | 不共享。Z3-A 的受控图表 MVP 是**展示状态**（流式渲染、缩放、选中），Z4 的 document 是**可编辑业务状态**。共享容器会迫使两者互相等待 | 仅当 Z3-A 明确需要「用户可直接改图表」时才谈合并 |
| 展示状态 vs 业务状态 | 展示：视口、缩放、流式动画、临时高亮——不进 document、不持久化。业务：节点/连线/文字/位置——进 document | Z3-A 定稿其状态清单后逐项归类 |
| 图表数据 → 编辑文档 | 纯函数转换器，产出 `{document, 丢弃清单}`；转换失败整体降级为只读展示，不猜字段 | **待确认：Z3-A 的图表 JSON schema（未定稿，不得假设）** |
| Agent 如何发起修改建议 | Agent 在会话中产出结构化建议（v1 形态即 §5.3），由后端提取并校验后进入建议队列；**不直接调用前端 API**。建议的身份与代次验证按 §6.1：由服务端取证真实 owner、绑定 bridgeRun/generation、登记来源 run，**不采信模型自述的 sessionId / actor** | 待确认：建议以何种消息形态从 pi RPC 冒出（Z3-A 的消息身份协议未定） |
| 建议关联正确会话 | sessionId 只能与**服务端 owner 取证结果**比对（review-comment-authority 同型：焦点会话、持久 conversation、workspace ID/epoch），前端与模型自述都不是事实来源；文档绑定先到会话，切换显式解绑 | 复用现有取证，无新依赖 |
| 关闭面板后保留未保存编辑 | 编辑中状态按「工作区哈希 + 文档 id」保存在内存级暂存（draft.js 同型思路）；面板关闭仅卸载 UI，document 对象由文档管理器持有。**撤销栈不随之保留**：其生命周期见 §4（面板关闭/切会话/重启即失效，重开从当前 revision 起算新历史） | Z4-2 决定是否升级为后端暂存 |
| 项目/Worktree/会话切换 | workspaceGeneration 变化 → 未保存文档提示保存或丢弃；documentId 含工作区绑定，跨项目文档不可达（同 generation 防护） | 复用现有 generation 机制 |
| 防旧 Agent 响应改新文档 | 建议带 bridgeRun/generation，迟到建议按陈旧丢弃（SSE/bridgeRun 过滤同型）；sessionId + baseRevision 双重校验兜底 | 复用现有机制 |
| 最终安全写入项目文件 | 独立链路：safe-path 校验 + 用户明确确认 + T3-B 式锁/CAS/原子替换；与内存编辑不共享代码，不在本协议内 | 另立任务设计，Z4-2 不实现 |

原则：不为统一架构要求 Z3-A 返工。若 Z3-A 最终选择自己的状态管理，
Z4 适配器只转换数据，不要求 Z3-A 改协议。

## 9. 安全风险及资源限制

| 风险 | 缓解（协议层已实现 / 设计层待实现） |
|---|---|
| Agent 建议夹带执行面 | 操作类型与字段闭集，无函数/表达式字段；Agent 伪装 user 直接操作被拒（测试 11d） |
| 旧会话/旧文档越权操作 | document-mismatch / session-mismatch / 幂等日志三重拒绝（测试 11a–11e） |
| 未知字段注入 | 逐层 exactKeys；deserialize 同样拒绝未知字段（测试 1b/1e） |
| 资源耗尽 | 200 节点 / 400 连线 / 50 操作每建议 / 2 MiB 序列化 / 500 条幂等日志，全部有界（测试 10a–10c） |
| 覆盖用户未保存内容 | 无覆盖语义：建议只能经接受通道生效，冲突时双方材料保留（测试 6a） |
| 未来落盘的路径风险 | 设计约束：走 safe-path + 显式授权 + 原子替换，不与内存操作共享代码；**本轮未实现，不宣称** |
| 诊断/日志泄露 | 建议内容属于用户数据；未来接入日志时按「只记结构不记值」纪律，字段白名单另定 |
| Windows Electron 性能 | 协议数量上限兜底；Z4-2 需在真实窗口验证数百节点渲染（不在本轮证据内） |

## 10. Z4-2 正式开发任务与验收标准

建议拆成 **三个可独立验收的阶段**（不过度拆分）：

### 阶段 1：生产化数据模块（后端为主）
- 将 `prototype/z4-1-collab/collab-doc.js` 提炼为生产模块（建议 `lib/collab-doc.js`），
  纳入 `package.json` 测试链与 `tests/modules.cjs` 依赖方向守卫。
- 服务器端文档存储（T3-B 同型：scopeHash 寻址、排他锁、CAS、原子替换、损坏保留）。
- Owner 取证接入（复用 review-comment-authority）。
- **验收**：canonical 测试含 schema 拒绝、幂等、stale-base、失败保留、会话绑定；无生产入口以外的写路径。

### 阶段 2：最小画布 UI（前端）
- 自研 SVG/DOM 节点编辑器面板，经 split-workbench 挂载；textContent 纪律；
  用户操作走受控操作通道；建议预览/接受/拒绝 UI。
- 面板关闭保留未保存编辑（内存暂存），generation/bridgeRun 守卫。
- **验收**：真实 Electron 截图（jsdom 断言不算排版证据）；用户改文字、接受建议、撤销全链路演示；性能抽样（≥100 节点流畅）。

### 阶段 3：Agent 建议链路
- 从 Pi RPC 会话产物提取结构化建议（等 Z3-A 接口定稿或先用受控 JSON 输出约定），
  建议队列、陈旧丢弃、重新生成提示。
- **验收**：真机会话产出建议 → 预览 → 接受/拒绝/冲突重生成全流程证据；旧 bridgeRun 建议不落新文档。

### 阻断项（开始 Z4-2 前必须解决）
1. **无**（数据层无阻断）。阶段 3 依赖 Z3-A 接口定稿，但阶段 1/2 不被其阻塞，
   可先以「手工构造建议」推进。

## 11. 结论：已验证代码 / 设计约束 / 待实现能力

### 已验证代码（有原型测试证据，49/49）

- 文档协议 v1 语义：schema 严格校验（含未知字段/未知版本拒绝）、闭集操作、
  revision 冲突检测（stale-base 带冲突明细）、事务化批量应用（失败原文档逐字节不变）、
  建议 schema 与结构校验、预览（只读）/接受（显式 expectedRevision 重验）/拒绝（零状态）。
- 批次语义：同批「先新增对象、再修改同一对象」的预览摘要、接受、撤销、重做全程无异常，
  撤销/重做以精确图结构断言验证（测试 13a–13d）；逆操作按批次逐步模拟的
  真实修改前状态生成；`edge.update` 支持 `label: null` 使无 label 连线可逆。
- 建议幂等的身份边界：归属（documentId/schemaVersion/sessionId）与操作 schema
  校验先于幂等快捷路径，伪造会话/换文档/非法 schema 的重复接受明确拒绝（测试 14a–14d）。
- 反序列化上限：节点/连线数量、连线 ID 唯一、同向重复拒绝、输入体积上限，
  合法文档往返兼容（测试 15a–15e）。
- 幂等语义及**明确范围**：窗口内同 ID 同内容重放 → duplicate 无操作（指纹与
  属性键序无关，测试 16）；同 ID 不同内容 → opid-reuse 拒绝；窗口外重放 →
  revision 单调性兜底 stale-base（§5.5，测试 4a/4c/4d）。
- 撤销/重做：接受的建议与用户操作共用撤销栈；空栈报错且不变；新编辑清空重做栈。
- 归属拒绝：document-mismatch、缺 sessionId、切会话后旧建议拒绝、agent 伪装 user 拒、
  重复绑定 fail closed（测试 11a–11e）。
- 资源上限：201st 节点拒、51 操作建议拒、2MiB 序列化守卫（测试 10a–10c）。
- 可序列化复现：serialize∘deserialize 幂等、同操作序列产出同字节、反序列化后可续编辑。

### 设计约束（本轮未实现，生产实现必须遵守）

- 建议**身份与代次由服务端验证**，不采信模型自述的 sessionId/actor（§6.1）。
- 撤销栈生命周期：面板关闭/切会话/切项目/重启即失效，不跨实例持久化（§4）。
- 落盘存储走 safe-path + 显式授权 + T3-B 式锁/CAS/原子替换，与内存操作不共享代码。
- 未知字段闭集拒绝、资源上限、日志只记结构不记值（§9）。
- UI 层 textContent 纪律与零 innerHTML（沿用仓库既有纪律，Z4-2 验收）。

### 待实现能力（Z4-2 及之后）

- 后端文档存储与 owner 取证接入（阶段 1）、画布 UI 与面板挂载（阶段 2）、
  Agent 建议链路（阶段 3）——拆分与验收标准见 §10。
- 关闭面板的编辑暂存、性能实测（≥100 节点真实窗口）、日志脱敏细则。
- 更强防重放（持久化操作账本）——显式决策点，见 §5.5。

### 取决于 Z3-A（接口未定稿，全部待确认）

- 图表→文档转换器的字段映射、建议的消息形态、状态清单归类、是否需要共享容器（§8）。

### 是否具备开始 Z4-2 的条件与阻断项

具备。阶段 1（生产化数据模块）可立即开始，不依赖 Z3-A；阶段 3 建议等 Z3-A
接口定稿后再接。**硬阻断：无。**软条件：阶段 2/3 属生产 UI 变更，按 REVIEW.md
属中等风险，需独立复审与用户审批；阶段 3 涉及 Agent 产物消费，需按不可信输入
边界做安全审查。
