# Z4-4A 验收材料：协同流程图编辑体验增强（自动布局 / 安全预览 / 导出 / 集成原型）

- 目标与交付：任务 A 自动布局引擎、任务 B 安全布局预览、任务 C SVG/PNG 导出、任务 D 组件测试、
  任务 E 集成分析与 adapter 原型，全部完成并本地提交。未交付：生产面板挂载、PNG 的 Electron 实测、
  大图（>50 移动节点）事务方案（按任务约定返回明确状态，留待后续设计）。
- 身份：before HEAD `cd80c64042edb0fd239d8b84584547c0e9b9ead5`（origin/main，含 PR #31 Z4-2 成果）；
  after HEAD `850f469`（任务 E 提交）；本报告自身的交付提交以
  `git log -1 --format=%H -- docs/Z4-4A-acceptance.md` 解析。
  分支 `codex/z4-4-canvas-productivity`；工作区
  `C:/Users/21022/.codex/worktrees/z4-4-canvas-productivity/pi-GUI`（独立 Worktree，基于最新 main 创建，
  未基于未合并的 Z4-3 分支）。
- 证据范围：全部结论来自本分支六个提交的实测运行（见下表）；无后续仅补报告的提交。

## 一、新增模块与接口说明

全部为新增文件，`git diff --name-status origin/main..HEAD` 输出 9 行、状态全部为 `A`（零修改既有文件，
任务禁改清单 server.js / server/collab-service.js / server/collab-proposal-source.js /
server/collab-proposal-queue.js / server/collab-authority.js / public/collab-panel.js /
public/collab-proposal.js 一律未触碰；package.json 及 canonical 测试链未改）。

| 文件 | 用途 | 对外接口 |
| --- | --- | --- |
| `public/collab-auto-layout.js` | 任务 A：轻量 Sugiyama 分层布局（去环→分层→中位数减交叉→对齐→分量网格打包）；默认 LR，可选 TB；确定性输出 | `computeAutoLayout(document, options?) → {ok, positions:{id:{x,y}}, stats}` 或 `{ok:false, code, detail}`；`AUTO_LAYOUT_LIMITS`、`AUTO_LAYOUT_DEFAULTS` |
| `public/collab-layout-preview.js` | 任务 B：预览→确认→node.update 批次；revision 显式重验；零变化剔除；over-limit 拒绝 | `createLayoutPreview(document, options?)`；`applyLayoutPreview(preview, document, {makeOpId?}) → {ok, ops(完整信封)}`；`dismissLayoutPreview(preview)`；`LAYOUT_PREVIEW_LIMITS` |
| `public/collab-export.js` | 任务 C：结构化生成自包含 SVG（白名单标签 + 全量 XML 转义）；PNG 经可注入 renderer | `buildFlowchartSvg(document, {theme,padding}) → {ok, svg, width, height}`；`exportFlowchart(document, {format, theme, padding, scale, renderer?, confirm?}) → Promise`；`EXPORT_THEMES`（light/dark/transparent） |
| `public/collab-canvas-productivity.js` | 任务 E：生产力工具条 adapter **原型（未接入）**，与画布同方言（`onOperations` 只发 `[{type,params}]` 意图） | `mountCollabProductivity(host, {document, readOnly, busy, onOperations, onExport, onNotice, layoutOptions?, exportOptions?, confirmExport?}) → {update({document,readOnly,busy}), destroy()}` |
| `public/collab-productivity.css` | 原型独立样式（不改 collab.css / collab-panel.css） | — |
| `tests/collab-auto-layout.cjs` | 任务 D：布局引擎 51 项断言 | `node tests/collab-auto-layout.cjs` |
| `tests/collab-layout-preview.cjs` | 任务 D：预览安全 44 项断言 | `node tests/collab-layout-preview.cjs` |
| `tests/collab-export.cjs` | 任务 D：导出安全 48 项断言 | `node tests/collab-export.cjs` |
| `tests/collab-productivity.cjs` | 任务 E：adapter 原型 35 项断言（jsdom） | `node tests/collab-productivity.cjs` |

边界约定：三个功能模块均为纯客户端模块，无 IO / 网络 / 定时器，不依赖 `lib/`（与 collab-canvas 同边界，
协议常量在模块内声明并注明出处）；布局与预览绝不修改传入文档；导出不下载、不写盘、不上传，由用户点击触发。

## 二、测试证据

环境：Windows 10.0.26200 x64、Node v24.22.1、Git Bash；Worktree 的 `node_modules` 为指向
`C:\pi-GUI\node_modules` 的目录联接（与 z4-3 等既有 Worktree 同惯例，零依赖下载）。

| 证据层 | 命令与代码状态 | 退出码与实测结果 |
| --- | --- | --- |
| 作者自测 / 本地定向 | `node tests/collab-auto-layout.cjs`（HEAD `850f469`） | 0；`51/51 passed; assertions=51`（200 节点实测 3ms） |
| 作者自测 / 本地定向 | `node tests/collab-layout-preview.cjs`（同上） | 0；`44/44 passed; assertions=44`（含生成操作通过 `applyUserOperations` 全链路） |
| 作者自测 / 本地定向 | `node tests/collab-export.cjs`（同上） | 0；`48/48 passed; assertions=48` |
| 作者自测 / 本地定向 | `node tests/collab-productivity.cjs`（同上） | 0；`35/35 passed; assertions=35` |
| 本地定向（既有回归） | `npm run test:collab`（同上） | 0；链内含 prototype z4-1、collab-doc、collab-store、collab-authority、collab-service、collab-http、collab-canvas（`72/72 passed; assertions=72`）、collab-panel（`11/11; assertions=58`） |
| 本地完整 canonical | `npm test` | 未验证（未运行。原因：本轮全部为新增独立文件，未触生产入口与 canonical 链；按任务要求直接运行新增测试并跑受影响的 collab 定向链。完整 canonical 留待合并前按测试执行政策补验） |
| 独立审查 | — | 未验证（本轮为与 Z4-3 并行的独立开发，按任务约定完成后等待 Z4-3 合并与独立验收） |
| PR CI / main CI | — | 未验证（未 push，无 PR） |
| Electron / 产物 | — | 未验证（未运行。PNG 光栅化的默认 renderer 需浏览器 canvas 能力，正式 Electron 验证属 Z4-4B；本轮以注入 renderer 的接口测试覆盖） |
| UI 截图 | — | 不适用（无生产 UI 变化：adapter 原型未挂载任何入口，其 DOM 结构由 jsdom 断言覆盖；正式接入后的真实截图留 Z4-4B） |

### 任务清单 18 项边界 → 实测覆盖

| # | 边界 | 覆盖（套件 · 断言） |
| --- | --- | --- |
| 1 | 三节点直线流程 | auto-layout：直线沿 x 前进 / 同层共线 / 零交叉 |
| 2 | 多分支流程 | auto-layout：分支源在最左 / 同层并列 / 不重叠 |
| 3 | 多分支汇合 | auto-layout：菱形零交叉、汇合居中（median 对齐） |
| 4 | 环路 | auto-layout：3 节点环 + 30 节点全环，不无限循环 |
| 5 | 孤立节点 | auto-layout：与链共存不重叠、components=2 |
| 6 | 无连线 | auto-layout：6 节点零边不重叠；15 孤立节点换列打包 |
| 7 | 空图 | auto-layout：空坐标 + 零 stats；preview：空图 clean |
| 8 | 大量节点 | auto-layout：200 节点 3ms、坐标齐全、不重叠、最长链不越界 |
| 9 | 重复运行布局结果一致 | auto-layout：重复运行 JSON 全等、输入顺序无关、TB 同样确定 |
| 10 | 节点与连线数据不变 | auto-layout：输入文档深比较不变；preview / export 套件同项 |
| 11 | 预览不修改原图 | preview：创建预览后原文档 JSON 全等 |
| 12 | 取消后数据不变 | preview：dismiss 纯声明；productivity：取消零提交、文档不变 |
| 13 | 超过 50 条操作拒绝直接应用 | preview：60 移动 over-limit、无 ops 产出、恰好 50 可单批；productivity：over-limit 禁用确认按钮 |
| 14 | 坐标边界 | auto-layout：整数、±100000、极限间距选项（layerGap/nodeGap=200）仍界内 |
| 15 | 长文本和中文 | export：中文保留、每行 ≤11 字、两行 + 省略号、连线文字 ≤24 字；auto-layout：117 字中文标签 |
| 16 | SVG 安全转义 | export：敌意标签/引号/闭合标签全部转义为文本；DOMParser 结构化断言合法 XML、无 script/foreignObject、无 on* 与 href/src 属性、无外部资源；node title 完整保留原文 |
| 17 | 非法图结构 | auto-layout：缺端点边/自环/重复 ID/同向重复边/空白标签/越界坐标/超 200 节点/错误 schemaVersion/null/未知方向共 10 类拒绝；preview 与 export 各自的 invalid-* 拒绝 |
| 18 | 用户取消导出 | export：confirm 钩子取消时不调用 renderer、不产出数据；productivity：confirmExport 恒否 → 零导出 |

## 三、各阶段提交

| 阶段 | SHA | 内容 |
| --- | --- | --- |
| 任务 A | `467d9d8` | 布局引擎（含冒烟期发现并修复的两处缺陷：分量换列 x 坐标错误、跨层界交叉误计） |
| 任务 B | `c66c6cb` | 安全预览与受控应用 |
| 任务 C | `4305e28` | SVG/PNG 导出模块 |
| C 修复 | `4942f29` | 序列化器纯文本子元素单行输出（textContent 不再混入排版空白） |
| 任务 D | `3d1e938` | 三个组件测试套件 |
| 任务 E | `850f469` | adapter 原型 + 独立样式 + 35 项组件测试 |

## 四、与 Z4-3 的文件冲突检查

- 文件交集：`git diff --name-only origin/main..HEAD` 与 `origin/main...codex/z4-3-agent-collaboration`
  的差集取交集为空（本分支 9 个新增文件 vs Z4-3 的 26 个修改/新增文件，零重叠）。
- 合并模拟：`git merge-tree --write-tree --name-only HEAD codex/z4-3-agent-collaboration`
  退出码 0（干净合并，tree `2b89ff4823b6bb6f23c98beb64b09e8e0479308c`）。
- Z4-3 工作区（`z4-3-agent-collaboration` Worktree）本轮零访问零修改。
- 注意：Z4-3 修改了 `tests/collab-canvas.cjs` 与 `tests/fixtures/*`；本轮未触碰这些文件，
  因此两侧合并后测试互不干扰。Z4-3 如也改 `package.json` 的 `test:collab` 链而本轮未注册新套件，
  合并后 canonical 链自然以 Z4-3 版本为准，新增套件仍按直跑方式执行（Z4-4B 再决定是否入链）。

## 五、已完成与尚未集成

已完成：布局引擎、安全预览、SVG/PNG 导出、四套组件测试、adapter 原型（含独立样式与 jsdom 测试）、
与 Z4-2 协议的全链路对接验证（生成操作通过 `lib/collab-doc.js applyUserOperations`）。

尚未集成（明确不属本轮）：

1. adapter 未挂载：`public/collab-panel.js`、`public/index.html`、`public/app.js` 均未改动，
   生产界面看不到任何新按钮（原型 UI 有「Z4-4A 原型 · 尚未正式接入」标注）。
2. PNG 默认 renderer 的 Electron 实测未做（Node 环境显式返回 `renderer-unavailable`）。
3. >50 移动节点的自动整理只给明确 over-limit 状态，无分批应用、无大图事务。
4. 新测试未注册进 `package.json` canonical 链（按任务要求直跑）。

## 六、Z4-4B 所需的最小改动

1. `public/collab-panel.js`：在挂载 `mountCollabCanvas` 的宿主旁并排
   `mountCollabProductivity(host, {...})`，把画布已有的 `document`/`readOnly`/`busy` 状态与
   操作提交通道（补全 opId/baseRevision/actor 的既有路径）接给 adapter；`onExport` 接下载 UI
   （Blob + `a[download]`），`onNotice` 接面板既有错误条。
2. `public/index.html`：加一行 `<link rel="stylesheet" href="/collab-productivity.css">`
   （或并入构建时的样式清单）。
3. PNG：在 Electron/浏览器环境验证默认 renderer；若需脱离 DOM 的测试，继续用注入 renderer。
4. `package.json`：把四个测试文件加入 `test:collab` 链（单行追加，不改其余链路）。
5. `docs/README.md` 导航补本报告链接（Z4-3 也改该文件，合并时注意次序）。
6. 构建产物：接入 UI 后按 AGENTS 要求 `npm run build:app -- --rebuild` 并附真实截图。

## 七、风险与回滚

- 风险级别：中（常规前端功能；无凭据/执行权限/文件写入边界。布局只产坐标建议，提交走既有
  CAS/Owner 通道；导出无 IO）。残余风险：布局质量为轻量启发式（非最优交叉数）；
  PNG renderer 未在真实 Chromium 验证；adapter 原型未经真实面板联调。
- 回滚：全部为新增文件且未接线 —— 合并前回滚 = 删除 Worktree 与分支；合并后回滚 = revert 对应合并提交
  （无数据迁移、无存储格式变化、无产物变更，协同文档字节不受任何影响）。
- 数据边界：布局/预览/导出全程只读传入文档；测试全部使用内存 fixture，未触真实会话与用户数据。

## 八、失败与修复历史

- 布局引擎冒烟期发现并修复（均在任务 A 提交 `467d9d8` 内）：分量换列后 x 坐标未用列游标导致
  第二列叠回第一列；交叉统计把跨层界的边对误计（菱形虚报 2 交叉）。
- 导出序列化器缺陷：多行排版把缩进空白混进 tspan/title 的 textContent（测试发现），修复于 `4942f29`。
- 测试脚本自身的若干预期/写法错误（种子批次超协议单批上限、tspan 未按节点分组、正则误伤内部
  `url(#id)` 引用等）逐项修正后全绿；均非产品缺陷。

## 九、结论

- 开发完成：是（A–E 全部交付，测试见第二节）。
- 代码验收通过：未验证（等待独立审查；按任务约定等 Z4-3 合并后统一验收）。
- 允许合并：未授权（用户未授权合并；分支停在本地）。
- 允许发布：未授权。
- 本轮未 push、未建 PR、未合并 main、未发版、未调用其他 Agent；所有修改仅存在于
  Z4-4 Worktree 与分支 `codex/z4-4-canvas-productivity`。
