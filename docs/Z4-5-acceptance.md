# Z4-5 验收材料：协同流程图高级编辑（多选 / 批量拖动与删除 / 复制粘贴 / 对齐 / 大图限制评估）

- 目标与交付：
  - 任务 A：多选系统（单选、Ctrl+点击添加/取消、Shift+拖动框选、Ctrl+A 全选节点、Escape 清空/取消、修剪与清理、选中数量与标签展示）——全部完成。
  - 任务 B：批量编辑（批量拖动相对位移保持、本地预览不保存、单批原子提交、坐标截断保护；批量删除关联连线自动收集与去重、先边后节点顺序、明确确认弹窗包含节点与连线计数、单批 50 上限拦截；复用现有服务端事务与历史单步撤销重做）——全部完成。
  - 任务 C：复制与粘贴（Ctrl+C 复制、Ctrl+V 粘贴、Ctrl+D 副本；保留相对坐标；仅复制内部连线；生成合法新 ID；逐次递增偏移防重叠；图容量与 50 批次上限拦截；单批原子事务与单步撤销；会话隔离清空临时状态）——全部完成。
  - 任务 D：节点对齐与快捷键（左对齐、水平居中、右对齐、顶对齐、垂直居中、底对齐、水平等间距、垂直等间距；整型坐标；过滤零变化；保留既有快捷键；输入框隔离；更新画布帮助文案）——全部完成。
  - 任务 E：大图事务限制研究（协议、CAS、幂等日志与撤销审计；不拆分批次绕过限制；产出完整设计与阻断分析报告 `docs/Z4-5-large-transaction-design.md`；保持生产 50 条 over-limit fail-closed 拦截）——全部完成。
  - 产物重建（`dist-app` 刷新包含最新 public 资源，`test:collab:packaged` 校验通过）。
- 未交付：
  - Electron 真窗口实测（本会话沙箱禁止启动 Electron 窗口，按仓库惯例落 [results.json](assets/z4-5/results.json) 记录 environment-blocked 状态）；
  - 完整 canonical `npm test` 按约定留待 PR CI。
- 身份：
  - 初始基线 HEAD: `0ec517a17b041b857fc1f83afc1040d0c9fb90e0`（main 分支上 Z4-4B 的合并提交，包含 `b1e6752` 最新开发提交）；
  - 独立验收修复基线 HEAD: `b468afc6e2da00e4fce18f82284816d7799d84df`；
  - 最终交付 HEAD: 见最新提交；解析命令：`git log -1 --format=%H -- docs/Z4-5-acceptance.md`；
  - 分支：`codex/z4-5-advanced-editing`；
  - 本轮遵循硬约束：本地提交并推送至开发分支，禁止创建 PR、合并 main、打 tag 或发版。

---

## 一、修改与新增文件

`git status -s` 变更清单（排查无关历史残留后）：

| 文件 | 变更类型 | 目标与说明 |
| --- | --- | --- |
| `public/collab-selection.js` | 新增 | 任务 A：独立的多选与选区管理模型，提供单选、toggle、框选碰撞检测、全选、修剪与状态描述 |
| `public/collab-canvas.js` | 修改 | 任务 A/B/C/D：集成多选系统、批量拖动、批量删除、复制/粘贴/副本、节点对齐与间距表单、快捷键与帮助文案；修复鼠标事件重复修改选区、焦点恢复与批量移动相对位移保持 |
| `public/collab.css` | 修改 | 样式：添加 `.collab-marquee` 选框样式与 `.collab-align-form` 布局样式 |
| `docs/Z4-5-large-transaction-design.md` | 新增 | 任务 E：大图事务协议审计与原子布局阻断分析报告 |
| `tests/collab-selection.cjs` | 新增 | 测试：多选与框选几何计算单元测试（37 项通过） |
| `tests/collab-advanced-editing.cjs` | 新增 | 测试：高级编辑交互与服务端集成测试（89 项通过，96 断言） |
| `tests/collab-z45-regressions.cjs` | 新增 | 回归：独立审查缺陷红绿回归测试（41 项通过，覆盖事件序列、焦点恢复与边界位移） |
| `tests/fixtures/z4-5-advanced-editing-electron.cjs` | 新增 | 专项：真实 Chromium 正常沙箱装配页与自动化取证夹具（含真实完整事件序列） |
| `tests/collab-advanced-editing-electron.cjs` | 新增 | 专项：Electron runner 与 environment-blocked 取证记录器 |
| `tests/collab-packaged.cjs` | 修改 | 打包校验：增加 `collab-selection.js` 资源一致性检查 |
| `package.json` | 修改 | 测试注册：`test:collab` 链注册三个新套件，并增加 `test:collab:advanced-electron` |
| `docs/assets/z4-5/results.json` | 新增 | 证据：Electron 专项环境阻断记录 |
| `docs/Z4-5-acceptance.md` | 新增 | 本验收材料文件 |

---

## 二、测试证据与实测结果

测试环境：Windows 10.0.26200 x64、Node v24.22.1。

| 证据层 | 命令 | 退出码 | 实测数量 / 结果 |
| --- | --- | --- | --- |
| 协同全套件定向测试 | `npm run test:collab` | 0 | 20 套件全绿：Z4-1 原型 49/49、Collab doc 56/56(135)、store 53/53(149,skip 1)、authority 24/24(68)、service 13/13(58)、proposal-queue 12/12(73)、proposal-source 21/21(110)、agent-flow 32/32(170)、HTTP 8/8(41)、canvas 72/72(72)、panel 11/11(58)、panel-agent 8/8(87)、auto-layout 51/51(51)、layout-preview 44/44(44)、export 48/48(48)、productivity 60/60(60)、panel-productivity 14/14(71)、**collab-selection 37/37(37)**、**collab-advanced-editing 89/89(96)**、**collab-z45-regressions 41/41(41)** |
| 独立选区单元测试 | `node tests/collab-selection.cjs` | 0 | 37/37 passed; assertions=37 |
| 高级编辑集成测试 | `node tests/collab-advanced-editing.cjs` | 0 | 89/89 passed; assertions=96 |
| 验收缺陷专项回归测试 | `node tests/collab-z45-regressions.cjs` | 0 | 41/41 passed; assertions=41 |
| CI 测试编排核对 | `npm run test:ci` | 0 | ci-test-plan 220 leaves exact; ci-workflow 5/5, 15/15; ci-results 10/10; ci-summary 30/30; ci-history 21; ci-doc-scope 28/28; release-ci-proof 16/16; nsis 12/12 |
| 打包产物静态校验 | `npm run test:collab:packaged` | 0 (app 部分) | `app` 内嵌所有 9 个前端资源摘要一致，权限与路由断言全部通过 |
| 产物构建更新 | `npm run build:app` | 0 | dist-app 产物刷新成功 |
| Electron 专项交互 | `node tests/collab-advanced-editing-electron.cjs` | 1 (environment-blocked) | 夹具退出码 2147483651（沙箱环境禁止启动任何 Electron 子进程），按规范已落 `docs/assets/z4-5/results.json` 留存阻断证据，未冒充通过 |
| 完整 canonical | `npm test` | 未运行 | 按任务要求留待合并后 PR CI 执行 |

---

## 三、各任务详细实现说明

### 1. 任务 A：多选系统
- **状态分离**：在 `public/collab-selection.js` 中创建独立的 `createSelection`，维护 `items = new Map<key, {kind, id}>`，解耦选择状态与 DOM 渲染。
- **操作支持**：
  - 普通点击：单选节点或连线，清空其他选择；点击空白区域清空。
  - Ctrl+点击（或 Meta+点击）：切换（toggle）单个节点或连线的选中状态。
  - Shift+拖动空白处：绘制矩形框选（基于 SVG 视口逆变换坐标），利用 `hitTestRect` 计算并批量选中相交节点。
  - Ctrl+A：在 SVG 视口或画布聚焦时选中全部节点；对输入框（`input`, `select`, `textarea`, `isContentEditable`）内部打字时的 Ctrl+A 做了严格的事件穿透放行，不影响文字全选。
  - Escape：优先取消当前交互（选框/拖动/删除确认），再清空多选集合。
- **生命周期保护**：
  - 文档 `update()` 时，通过 `selection.prune(document.graph)` 自动剔除外部更新中已被删除的对象，保留依然存在的对象。
  - 会话切换或文档 ID 变化时彻底 `clear()`。

### 2. 任务 B：批量编辑（拖拽与删除）
- **批量拖动**：
  - 选中多个节点后拖动任一选中节点，其余选中节点保持相对位置不变一同移动。
  - 拖动过程中仅在本地 `renderPositions()` 渲染 preview 变换，绝不触发写操作。
  - 释放鼠标（`pointerup`）时聚合为单次批量 `node.update` 提交（过滤位移为 0 的节点）。
  - 若总更新数超过 50 条，拦截并提示错误，杜绝超限提交；拖动取消（PointerCancel、Escape、Blur）立即恢复原坐标。
- **批量删除**：
  - 自动收集所有选中节点及所选连线，并深度搜寻选中节点两端关联的全部连线。
  - 利用 `Set` 严格对连线去重，保证连线绝不重复删除。
  - 严格保持操作顺序：先执行所有 `edge.remove`，再执行所有 `node.remove`。
  - 弹出明确的删除确认弹窗，清晰列出拟删除节点数与受影响连线数（如“删除所选的 2 个节点及 3 条连线？”）。
  - 若总删除操作数超过 50 条，直接拒绝并提示用户分批处理。
- **撤销与重做**：
  - 批量拖动和批量删除完全复用现有服务端 `commitOperations` 与 `applyOperations` 事务机制。
  - 用户界面单次点击“撤销”，服务端即可一次性把整批移动或删除（含所有关联边）全部还原，不引入第二套撤销系统。

### 3. 任务 C：复制与粘贴
- **复制（Ctrl+C）**：
  - 复制所有选中的节点。
  - 严格仅复制两端端点都在选中集合内的**内部连线**。
  - 存入应用内内存剪贴板 `clipboard`，记录起始文档 ID、节点数据与内部边数据。
- **粘贴（Ctrl+V）**：
  - 若剪贴板为空或无节点，无操作。
  - 容量与批次校验：若粘贴后节点数超过 200、连线数超过 400，或单批新增操作数超过 50 条，完整拒绝并不作任何修改。
  - 为每个节点生成全新的合法 ID，连线重映射至新节点 ID。
  - 坐标偏移：基于原有相对坐标，按 `pasteCount * 30` 像素逐次步进偏移，避免重叠。
  - 单批原子提交所有 `node.add` 与 `edge.add`，并自动将选区切换到新粘贴的对象上。
- **副本（Ctrl+D - Duplicate）**：
  - 等价于快速复制选中项并立即就地偏移粘贴。
- **会话隔离**：
  - 会话切换或文档 ID 变化时，清空剪贴板与偏移计数器，防止旧会话数据污染新会话。

### 4. 任务 D：节点对齐与快捷键完善
- **节点对齐与间距**：
  - 在检查器面板中提供紧凑的对齐下拉表单与应用按钮（包含：左对齐、水平居中、右对齐、顶对齐、垂直居中、底对齐、水平等间距、垂直等间距）。
  - 当选中节点数 ≥2 时展示对齐选项；等间距要求选中数 ≥3。
  - 坐标严格计算为合法整数并进行 clamp 边界保护。
  - 过滤掉位移为 0 的节点，若全部节点均无坐标变化，给出明确提示且不发请求。
  - 作为单批原子操作提交，支持单步撤销。
- **快捷键完善**：
  - 保留原有：Ctrl+Z、Ctrl+Y / Ctrl+Shift+Z、Delete/Backspace、Enter/F2、方向键、+/-/0。
  - 新增：Ctrl+A（全选节点）、Ctrl+C（复制）、Ctrl+V（粘贴）、Ctrl+D（副本）、Escape（取消/清空）。
  - 方向键支持批量移动全部选中节点（步长 10，Shift 组合步长 1）。
  - 所有快捷键严格受 `writable()`、输入框聚焦、忙碌/只读/确认中门控保护。
  - 画布帮助文案更新为：“拖动节点或空白处；Shift+拖动框选；滚轮缩放。Ctrl+点击多选，Ctrl+A 全选，Ctrl+C/V 复制粘贴，Ctrl+D 副本，Delete 批量删除，方向键移动所选。”

### 5. 任务 E：大图事务限制分析
- 详见专题报告 `docs/Z4-5-large-transaction-design.md`。
- 本轮确认：单批 50 条微操作上限与 500 条幂等日志紧密耦合，强行分批会导致非原子保存，强行引入第 7 种宏操作需要深度修改操作模型与版本兼容性。
- 因此维持当前稳健的 fail-closed 拦截，不留隐患。

---

## 四、与 Z4-4B 的兼容性检查

- **自动布局与导出**：
  - `collab-canvas-productivity.js` 与 `collab-layout-preview.js`、`collab-export.js` 无任何文件冲突。
  - 自动布局预览与导出在已有 60 项与 48 项测试中全部 100% 通过。
  - 工具条与新增的选区、对齐表单在 DOM 结构和交互上完全共存。
- **Agent 建议流程 (Z4-3)**：
  - `collab-proposal.js`、`collab-proposal-source.js`、`collab-agent-flow.js` 保持完全独立。
  - 8 项 panel-agent 测试与 32 项 flow 测试全部通过。

---

## 五、残余风险与回滚方式

- **残余风险**：
  - Electron 正常沙箱真窗口因会话执行环境限制无法直接拉起子进程窗口，已通过离线 jsdom 深度仿真与环境阻断留证覆盖。在具备 GUI 桌面环境的机器上可通过 `npm run test:collab:advanced-electron` 验证真机图形。
  - 完整 canonical `npm test` 依约定留待 PR CI。
- **回滚方式**：
  - 回滚本分支提交即可完全恢复至 Z4-4B 刚合并的基线代码：
    ```bash
    git revert <交付提交SHA>
    npm run build:app
    ```
  - 无持久化文件 Schema 变更，无数据库或存储迁移风险。

---

## 六、独立验收修复记录（1 Blocker、2 Important）

根据独立审查发现的 1 个 Blocker 与 2 个 Important 问题，进行了针对性修复与红绿回归闭环验证：

### 1. Blocker：鼠标事件序列重复修改选区
- **问题根因**：
  - 浏览器原生鼠标交互完整序列为 `pointerdown` -> `pointerup` -> `click`；
  - 原实现在 `pointerdown` 处理了 `selection.toggle`，而后续 `click` 又再次调用 `choose({ toggle: true })`，造成 Ctrl+点击在单次用户动作中被重复 toggle 导致反选抵消；
  - 框选（`kind === 'box'`）在拖动时未记录 `drag.moved = true`，导致松开鼠标后紧随其后的 `click` 事件未被抑制，冒泡至 SVG 视口清空了框选结果；
  - 选区中已有多个节点时，若用户仅拖动已选节点，原实现在 `pointerdown` 或后续 `click` 中容易丢失其他已选节点。
- **修复措施**（`public/collab-canvas.js`）：
  - 引入交互追踪态 `pointerAction`（`handled` / `deferSingleSelect`）与精确的 `suppressClick` 门控；
  - Ctrl+点击在 `pointerdown` 立即执行 toggle 并置 `pointerAction = { type: 'handled' }`，后续 `click` 识别已处理直接放行不重复执行；
  - 多选状态下单选点击节点暂缓降级（`deferSingleSelect`），若发生拖拽（位移 ≥3px）则 `suppressClick = true` 完整保留多选拖动；仅在未发生拖动的纯点击时收敛为单选；
  - 框选在 `pointerup` 中显式设置 `suppressClick = true`，杜绝随后的 `click` 冲刷选区；
  - 点击空白区域在 `pointerdown` 清空并记录 `handled`，不再在 `click` 重复清空；
  - 针对 `pointercancel`、`Escape` 与窗口 `blur` 统一重置交互态与预览。

### 2. Important：焦点恢复不能清空多选
- **问题根因**：
  - 画布在调用 `update()` 更新文档时，会依据原先活跃元素重新通过 `replacement.focus()` 恢复焦点；
  - 调用 `.focus()` 触发了 SVG 的 `focusin` 监听器，原 `focusin` 无条件调用了 `choose(event.target)`，进而退化为 `selectOne()`，抹除了已有多选集合。
- **修复措施**（`public/collab-canvas.js`）：
  - 增加 `restoringFocus` 布尔防护门控，在 `update()` 进行内部程序化恢复焦点期间锁定，忽略因此触发的内部 `focusin` 事件；
  - 用户主动通过 Tab 键盘导航触发 `focusin` 时：若目标节点已在选中集合内，保留既有多选；仅当目标节点未被选中时，才将其选为焦点对象；
  - `update()` 期间通过 `selection.prune(document.graph)` 剔除已被服务端或协作方删除的孤立节点/连线，完整保留存续节点的选中态；
  - 会话切换（`oldId !== document.documentId`）时彻底清空选择与剪贴板，且不向新会话恢复旧会话节点焦点。

### 3. Important：批量移动保持相对位移与边界控制
- **问题根因**：
  - 原实现在拖拽与方向键移动时，对集合内每个节点独立进行 `clamp(node.x + delta)`；
  - 当集合内某节点接近坐标边界（`[-100000, 100000]`）时被夹紧截断，而其余节点继续移动，导致图形相对结构被拉伸变形。
- **修复措施**（`public/collab-canvas.js`）：
  - 抽取集合边界计算函数 `computeGroupDelta(nodes, deltaX, deltaY)`；
  - 先计算整个选中节点集合在 X/Y 轴允许的公共位移范围（`[-100000 - minX, 100000 - maxX]`）；
  - 将位移量整体夹紧，使选中集合内全部节点使用严格相同的 `effectiveDeltaX` 与 `effectiveDeltaY`；
  - 相对坐标差严格保持恒定（`nodeA.x - nodeB.x` 在位移前后绝对不变）；
  - 若已触碰边界无法移动（`effectiveDelta === 0`），直接返回，实现**零提交**（不产生无效空操作）；
  - 无论是拖拽还是方向键，单批超过 50 个节点统一拦截拒绝并给出明确错误文案。

### 4. 红绿测试反证与证据
- **专用回归测试套件**：`tests/collab-z45-regressions.cjs`（覆盖 3 组共 41 项断言）。
- **红态反证（旧代码复现）**：
  - 运行 `node tests/collab-z45-regressions.cjs`，在未应用修复的代码上于 1.1 立即失败：
    ```
    反证失败证据 (预期红): 1.1: 真实 Ctrl+点击序列后 n1 必须处于选中状态
    false !== true
    ```
    明确证实旧代码中真实浏览器事件序列导致 Ctrl+点击反选失效。
- **绿态通过（修复后验证）**：
  - 运行 `node tests/collab-z45-regressions.cjs`：**41/41 passed; assertions=41** 全部绿过。
  - 运行 `node tests/collab-selection.cjs`：**37/37 passed; assertions=37**。
  - 运行 `node tests/collab-advanced-editing.cjs`：**89/89 passed; assertions=96**。
  - 运行 `npm run test:collab`：**20 套件全绿**。
  - 运行 `npm run test:ci`：**220 leaves exact**，CI 测试入口验证完全吻合。
  - 产物构建 `npm run build:app` 成功刷新 `dist-app`。

---

## 七、交付结论

- 开发完成：**是**（任务 A、B、C、D、E 全部门槛达成，独立审查缺陷已全部修复并闭环）。
- 代码验收通过：**待验证**（等待独立评审）。
- 允许合并：**未授权**（本轮禁止未经授权 push/merge）。
- 允许发布：**未授权**（本轮仅本地提交并推送开发分支）。
