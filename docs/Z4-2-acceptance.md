# Z4-2 生产协同编辑器验收材料

状态：开发与自动验证已累计完成。完整新代码 canonical `npm test`（208 叶）已按累计验证完成（`complete: true`，`failure: null`，`uniquePassed: 208`；前缀 152 叶复用 run2 成功记录 + 本轮 65 次全部 exit 0）。本报告尚不表示代码验收通过、允许合并或允许发布（用户验收仍待决定；未 push、未提 PR、未合并、未发版）。唯一审查标准见 [REVIEW.md](../REVIEW.md)，证据提交规范见 [acceptance.md](acceptance.md)。

## 交付范围与当前边界

Z4 文档是节点/连线结构化数据，与 Z3 的 line/bar 受控图表独立。纯数据事务、应用数据存储、Owner 取证、受控画布与建议组件、前后端适配器已全部实现；生产组合根已挂载（包含 `server.js`、`server/router.js`、`public/app.js`、`public/index.html`）。

- **HTTP 接口边界**：服务仅提供单一 HTTP 路由 `POST /api/collab-documents`，所有协同交互通过请求体 `body.action` 分发，支持 9 种动作：`open`、`create`、`operations`、`undo`、`redo`、`preview`、`accept`、`reject`、`close`。不存在单独的 GET `/api/collab/*` 等子路由。
- **图协议操作边界**：`lib/collab-doc.js` 定义闭集操作类型 `OP_TYPES`，仅包含 6 种原子操作：`node.add`、`node.update`、`node.remove`、`edge.add`、`edge.update`、`edge.remove`。平移（pan）与缩放（zoom）为前端画布本地视口行为，不进入协同协议与持久化日志。
- **身份与锁机制**：`sessionId` 为 64 字符十六进制 SHA-256 摘要；`token` 为基于 Owner 取证派生的能力 token，用于校验会话一致性与写入鉴权，并非单纯的只读权限。`.writer.lock` 为跨进程排他文件锁（基于 `openSync(..., 'wx')`），在多进程并发写入时保证单一写者。
- **前端入口与交互模式**：画布组件仅支持单选（选中单个节点或单条连线编辑/删除），不支持多选；协同工具面板的触发入口为会话 stage 工具栏右侧按钮 `<button id="btnCollab">`，在 `public/app.js` 中直接监听并作为 `secondary-surface` 挂载于 `#rightPane .rp-body`（`surface: 'collab'`）。
- **打包产物验证**：离线 App 与 SEA 构建已完成并通过自检（`tests/app-check.cjs` 26/26、`tests/exe-check.cjs` 49/49、`tests/collab-packaged.cjs` 28/28 均 exit 0）。
- **正常沙箱 Electron 专项**：run7 取得 49/49（48 场景 + 1 进程清理）通过，测试运行基于源码 `server.js`，测试专用预载网络守卫拦截了 1 次 GUI 自动更新 fetch。
- **建议来源边界**：真实 Pi RPC 建议来源未接入：生产服务 `proposals` 保持为 `null`，HTTP 端点不能提交自述为 Agent 的建议，UI 面板原文明确标注：“`Agent 建议来源尚未接入；当前支持用户编辑与保存。`”（`public/collab-panel.js:35`）。建议组件显式提供 `onAccept`、`onReject` 与 `onRegenerate` 回调，UI 中的“重新生成”在当前生产未接入真实来源时仅提示“可信 Agent 建议来源尚未接入。”，不冒充生产已实现重新生成闭环。来源设计与协议研究见 [A4 来源研究](Z4-2-agent-source-research.md)。

## 基线、分工与提交来源

- 初始 main / origin/main：`c9ac555a43c7b72216f347a63ddeeb52afa6c72c`。已执行 fetch、tag/Release 查询与全部现有 Worktree 核对；原主目录有 4 项既有未跟踪内容，未清理。
- 精确基线完整 CI：[40161132851](https://github.com/HYJ1817/pi-gui/actions/runs/40161132851)，push、attempt 1、SHA `c9ac555a...`、conclusion success、CI gate success，8 个 job。开始时 canonical 为 200 个叶命令。
- 本地补充参考基线：`npm test`，日志 `%TEMP%/pi-gui-z4-2-baseline.log`，退出码 0，200 个 canonical 叶命令完成；结尾原生 witness 跳过 8 项（existing_token_sacl_unavailable），未冒充资格通过。运行开始于 C0 文档提交；期间新增了尚未接线的模块/定向测试，server.js、router.js、app.js、index.html 的原行为入口保持原基线。不把它充作最终集成提交的完整证明。
- 当前主集成工作区：独立 `codex/z4-2-integration`；准确路径由 Worktree 附件提供。未推送、创建 PR、合并 main、打 tag 或发版。
- 提交状态：最终生产行为与代码固定提交为 `5388c1be155a0b86f9ed2c903669d31d63ce50d1`；最终测试与夹具集成提交为 `bfb9a2afc19a5de8f9ba5b6273713047e661df76`；包含本报告的最终文档交付提交 SHA 按 [docs/acceptance.md](acceptance.md) 规则可用 `git log -1 --format=%H -- docs/Z4-2-acceptance.md` 解析。

| 实际执行者 | 分支 | 来源提交 | 主工作区集成/状态 | 说明 |
|---|---|---|---|---|
| Codex 主 Agent | codex/z4-2-integration | C0 `0f2340ee6bfd492bc5dea4adb2008bb7cbe40b0f` | 契约与分工冻结 | 契约文档与任务分配 |
| Codex 主 Agent | 同上 | C1 `183aa39b38fc2d937c99655dd3783d625313e486` | 严格协议、持久化日志 | 修复 `1955926` |
| 内置 Codex 后端协作 Agent（初期） | antigravity/z4-2-backend | `06c8b9ffc0890103df65a7da7220c79d5dd3dfff` | cherry-pick `53de929` | A1–A4 后端骨架，已停止使用子代理 |
| 内置 Codex 画布协作 Agent（初期） | zcode/z4-2-canvas | `a2a1c41c8c8710793d191f9a84bb4a032de371aa` | cherry-pick `f85a2f3` | 独立画布组件骨架，已停止使用子代理 |
| Codex 主 Agent | 同上 | 服务/面板 `aa67bc58d5c5126630f0f47be8f0c4b093c7d338` | 集成与两轮审查修复 | 状态机、LRU、跨 scope 与旧请求防护 |
| Codex 主 Agent | 同上 | 适配器 `03b47498f9d5a704172458725b749a63810f451d` | 生产挂载准备 | 生命周期、长路径与短路径支持 |
| Codex 主 Agent | 同上 | 生产挂载 `f66ef8b5eb57c289d6731f0b27277eed0a48948c` | 组合根挂载与构建接线 | server.js/app.js/index.html 生产接入 |
| 桌面 ZCode | zcode/z4-2-evidence | `f4d1b0e4b010fbb457e77d6b9404cdded4e7e908` | 集成 `51a47f1c3ec503361e448f33cc10741ed5136027` | 机械改名 `el` → `domNode`，消除 smoke 静态全局误触 |
| 桌面 ZCode | 同上 | `ad65e14c1469dd62ac2478ac1163f1ae5bb53ccc` | 集成 `705a1d77e6b0416c62c63ccae92486bd9de802c5` | 产物探针与覆盖率审计 |
| 桌面 Antigravity | antigravity/z4-2-electron | `1e3c48dbb667116e11b6d95202b6f6cb762dc354` | 集成 `0939919753745a994e099f4bbd82ed8e5fc0a748` | 修正 Electron 测试（浅色 computed、A-B-A 真实原语），alias `5388c1b` |
| 桌面 Antigravity | antigravity/z4-2-electron | `2e04a04ad0e4349341ef06d7558bde95b6c45bf0` | 集成 `bfb9a2afc19a5de8f9ba5b6273713047e661df76` | Stop VM 夹具依赖补齐（真实 import 4 个协同构造器，12/12、17/17 cases 通过） |
| 桌面 ZCode | zcode/z4-2-evidence | `401eacbcb2c01d6ed1d4c7ada33ec236dddaee81` | 集成 `b772e0eb5150b7ab1d06fce6d897391245013451` | 离线网络预载守卫与 spy 预检夹具 |
| 桌面 Antigravity | 独立只读审查会话 | 无代码提交 | 功能第 1、2、3 轮审查完成 | 第 1 轮报 F1-F5/N1-N2，处置后第 2 轮通过；第 3 轮集中挂载与生命周期：0 B / 0 I / 2 Note（未运行测试） |
| 桌面 ZCode | 独立只读审查会话 | 无代码提交 | 安全第 1、2 轮审查完成 | 第 1 轮报 S1-S3/SN1，处置后第 2 轮安全：0 B / 0 I / 1 Nit（切 scope 后 best-effort close 依赖 TTL/LRU 回收，未运行测试） |

## 实现与文件归属

根据集成工作区实际 `git diff --name-status c9ac555a..bfb9a2a` 完整比对清单（共 35 个文件），完整清单亦归档于 [code-file-list.txt](assets/z4-2/code-file-list.txt)，归属分类如下：

| 文件类别 | 文件路径 | 状态 | 职责与变更说明 |
|---|---|---|---|
| **核心协议** | `lib/collab-doc.js` | 新增 (A) | 闭集图操作（6 种 `OP_TYPES`：`node.add/update/remove`、`edge.add/update/remove`）、严格 JSON Schema 校验、CAS revision 乐观锁、有界规范指纹操作日志、完整建议比对与接受、单操作可逆 undo/redo 历史 |
| **服务端实现** | `server/collab-store.js` | 新增 (A) | 固定应用数据目录 `collab-documents/`、跨进程排他写锁 `.writer.lock`（`openSync 'wx'`）、双重身份与安全路径核对（拒绝软链接/目录穿越/项目内路径）、fsync 临时文件原子 rename、数据损坏/容量超限拒写 |
| | `server/collab-authority.js` | 新增 (A) | 包装现有 Classic 与 Runtime 取证体系，派生独立 namespace、64 字符十六进制 `sessionId` 与鉴权 `token`；代次更新时立即使旧 token 失效 |
| | `server/collab-service.js` | 新增 (A) | 有界 editor capability（30 分钟 TTL / 32 容量 LRU 淘汰）、历史快照生成、用户操作与后端建议分流、统一固定错误码出口 |
| | `server/collab-routes.js` | 新增 (A) | 单一 HTTP 端点 `POST /api/collab-documents`：解析 9 种 `action` 并调用 service 执行 |
| | `server.js` | 修改 (M) | 生产组合根装配注入协同 store、authority、service 与 routes |
| | `server/router.js` | 修改 (M) | 挂载 `/api/collab-documents` 路由 |
| **前端实现** | `public/collab-canvas.js` | 新增 (A) | 受控 SVG/DOM 单选画布组件：单节点/连线选择、节点拖拽移动、文字编辑、连线创建/删除、本地缩放平移、只读与禁用态、独立于全局 SVG icon 样式的文本排版 |
| | `public/collab-proposal.js` | 新增 (A) | 建议对比预览浮层：只读差异呈现，显式提供 `onAccept/onReject/onRegenerate` 回调；“重新生成”在当前生产未接入真实 Agent 来源时仅提示状态文案，不冒充生产已实现重新生成闭环 |
| | `public/collab-panel.js` | 新增 (A) | 右侧协同工具面板适配器：作为 `secondary-surface` 挂载于 `#rightPane .rp-body`，处理保存确认前更新阻断、面板关闭/重开生命周期、Owner/代次守卫、未保存草稿与 Classic 对话框共存 |
| | `public/collab-panel.css` | 新增 (A) | 协同面板布局与抽屉样式 |
| | `public/collab.css` | 新增 (A) | 画布与图元素样式，对齐既有 `--ui-*` 变量体系，支持深浅色主题 |
| | `public/api.js` | 修改 (M) | 封装 `collabDocumentAction` 统一向 `POST /api/collab-documents` 发送带 Owner 头部的请求 |
| | `public/app.js` | 修改 (M) | 接入 stage 工具栏按钮 `<button id="btnCollab">` 及面板联动逻辑 |
| | `public/index.html` | 修改 (M) | 会话工具栏新增 `<button id="btnCollab">` |
| **项目配置** | `package.json` | 修改 (M) | 注册 `test:collab`、`test:collab:electron`、`test:collab:packaged` 脚本并接入测试链 |
| **测试套件** | `tests/collab-doc.cjs` | 新增 (A) | 数据层协议与操作测试 |
| | `tests/collab-store.cjs` | 新增 (A) | 存储故障注入与 Windows 边界测试 |
| | `tests/collab-authority.cjs` | 新增 (A) | 权限取证与代次隔离测试 |
| | `tests/collab-service.cjs` | 新增 (A) | 服务层历史、淘汰与端点测试 |
| | `tests/collab-http.cjs` | 新增 (A) | 真实 Router POST 端点与挂载测试 |
| | `tests/collab-canvas.cjs` | 新增 (A) | 画布组件受控行为与 DOM 测试 |
| | `tests/collab-panel.cjs` | 新增 (A) | 面板适配器与生命周期测试 |
| | `tests/collab-electron.cjs` | 新增 (A) | 正常沙箱 Electron 真实端到端测试入口 |
| | `tests/collab-packaged.cjs` | 新增 (A) | 打包产物（App 与 SEA）离线自检脚本 |
| | `tests/gui-browser-stop.cjs` | 修改 (M) | Stop 浏览器端时序测试（VM 注入协同依赖） |
| | `tests/stop-barrier.cjs` | 修改 (M) | Stop 权威屏障测试（VM 注入协同依赖） |
| | `tests/modules.cjs` | 修改 (M) | 依赖方向与无环守卫（含 collab 纯度检查） |
| **测试夹具** | `tests/fixtures/z4-collab-electron.cjs` | 新增 (A) | Electron 夹具后端拉起与通信桥 |
| | `tests/fixtures/z4-collab-scenarios.cjs` | 新增 (A) | 48 项桌面端交互测试场景定义 |
| | `tests/fixtures/z4-network-guard-probe.cjs` | 新增 (A) | 离线网络守卫 Preflight 预检探测器 |
| | `tests/fixtures/z4-offline-network.cjs` | 新增 (A) | Node/Electron 离线网络预载守卫实现 |
| **文档与审计** | `docs/Z4-2-contract.md` | 新增 (A) | C0 协同编辑协议与接口契约文档 |
| | `docs/Z4-2-coverage-audit.md` | 新增 (A) | ZCode 需求与安全覆盖审计报告 |
| | `docs/Z4-2-agent-source-research.md` | 新增 (A) | A4 Agent 建议来源与阶段 3 设计研究 |

## 实测测试记录

环境：Windows 11、Node v24.22.1（Electron 附带 Node 24.21.0）；严格复用现有依赖，无任何新增网络或运行依赖。写入类测试一律使用 `os.tmpdir()` 临时沙箱，绝无修改用户真实工作区、会话文件或全局 npm。

下表明确区分“检查项”（套件内逻辑判定点）与实际 API 断言调用数（assert 次数）；跳过项（skip）单独列出，绝不计入成功分母。

| 测试套件 / 命令 | 退出码 / 检查项 | assert 调用 / skip | 核心验证内容与当前证据 |
|---|---|---|---|
| `node prototype/z4-1-collab/collab-test.mjs` | 0；49/49 | 49 项检查 | 初始原型逻辑回归；原型文件保持原状未改 |
| `node tests/collab-doc.cjs` | 0；56/56 | 135 / 0 | 严格 schema 信封、重放前状态校验、操作日志持久化、混合非法批次拒绝、CAS revision、事务原子性与逆操作 |
| `node tests/collab-store.cjs` | 0；53/53 | 149 / 1 | 真实 Windows 8.3 别名核对、双进程并发 CAS 竞态、强杀/SIGKILL 恢复、锁文件排他性、Windows FileShare.Read 独占阻塞重试、路径穿越/项目内路径拒写（skip 1 为实录 Windows 文件 symlink 创建报 EPERM） |
| `node tests/collab-authority.cjs` | 0；24/24 | 68 / 0 | 可信 Owner 与 Runtime 身份取证、代次更新隔离、旧 token 立即失效、跨工作区权限阻断 |
| `node tests/collab-service.cjs` | 0；13/13 | 58 / 0 | 保存失败不污染历史、跨 scope 不误删活跃 editor、过期请求不丢弃有效历史、32 容量 LRU 淘汰与 30 分钟 TTL 清理 |
| `node tests/collab-canvas.cjs` | 0；72/72 | 72 / 0 | 单选节点与连线增删、原生拖拽坐标计算、只读与禁用态、非法输入拦截、组件销毁与监听器清理 |
| `node tests/collab-panel.cjs` | 0；11/11 | 58 / 0 | 面板展开/收起、未确认更改阻断更新、Owner 变更时销毁画布、A-B-A 切换隔离、迟到响应抑制 |
| `node tests/collab-http.cjs` | 0；7/7 | 28 / 0 | 真实生产 Router 挂载测试；未挂载时取得 404 红测，挂载后 7/7；Origin+Token 校验、单一 POST `/api/collab-documents` 语义、权限与持久化落盘 |
| **协同核心定向检查汇总** | **0；285/285** | **各套件自计** | **仅上述 8 个协同组件定向套件（prototype 49 + doc 56 + store 53 + authority 24 + service 13 + HTTP 7 + canvas 72 + panel 11 合计 285 项检查；此处为算术更正：此前汇总计算多算 100，套件与用例数无任何减少），不含 modules/smoke/Stop** |
| `node tests/gui-browser-stop.cjs` | 0；12/12 cases | 12 cases | 浏览器确认前不进 Pi、clear_queue 必先于 abort、503 安全文案返回；VM 依赖补齐后实测通过 |
| `node tests/stop-barrier.cjs` | 0；17/17 cases | 17 cases | 权威停止屏障、fake Pi 应答暂停、idle 确认后解除屏障；VM 依赖补齐后实测通过 |
| `node tests/modules.cjs` | 0；120/120 | skip 0 | 模块图依赖方向守卫；lib/collab-doc 纯净无外部依赖，整体依赖无环 |
| `tests/smoke.cjs`（全量冒烟） | 0；1338/1338 | skip 0 | 1338 项断言无一删除；局部 `domNode` 变量修复后守卫完全绿化 |
| `npm run build:app -- --rebuild` | 0；完成 | 不适用 | 本地 ZIP 缓存离线打包，零网络下载；生成独立 SEA 与完整 App exe |
| `node tests/app-check.cjs` | 0；26/26 | skip 0 | 临时目录启动打包后随包后端，无外部 node_modules 回退 |
| `node tests/exe-check.cjs` | 0；49/49 | skip 0 | 临时目录启动独立单文件 SEA，资源完整可运行 |
| `npm run test:collab:packaged`（`tests/collab-packaged.cjs`） | 0；28/28 | skip 0 | 验证 App 与 SEA 产物资源逐字节摘要匹配；401/403/405/409 安全阻断与拒写验证；负向测试（只读目录 exit 1、缺构建 exit 1/setup）已验证 |
| `node tests/collab-electron.cjs`（run7） | 0；49/49 | skip 0 | 正常沙箱 Electron 真实 E2E 专项：基于源码 `server.js`，48 场景 + 1 进程清理通过，预载网络守卫拦截 1 次外部更新请求 |
| `npm test`（最终全量 Canonical 208 叶） | **0；208/208（累计完成）** | 208 成功 / 0 失败 | `complete: true`，`failure: null`，`uniquePassed: 208`。基于 [canonical-cumulative.json](assets/z4-2/canonical-cumulative.json) 记录：前缀 152 叶复用 run2 成功记录（前缀日志 SHA256 `fa81a6e2588430d8eaec58583971d46fd410873cfa80a349db6acbdc7e28a84b`），本轮由调度脚本执行 9 前置 + 56 剩余 = 65 次全部 exit 0，去重去环完整覆盖 208 叶。本轮耗时 59m42.262s（上海时间 2026-10-25 19:17:02 至 20:16:44）。本项为**累计验证（cumulative canonical）**，非单次 `npm test`，非当前 SHA 远端 CI。末尾 Object writer 19/19、faults 45/45；witness 0/0 skip 8（`existing_token_sacl_unavailable`，未冒充资格通过；链内其他 skip 详见 [canonical-skip-lines.json](assets/z4-2/canonical-skip-lines.json)，全链不止 8 skip）。原生回归不升级 Z4 Node 路径 IO 的独占资格。 |

### 产物详细指纹与体积

- 单文件 SEA：`build/Pi GUI.exe`，大小 `102,860,800` 字节，SHA-256：`3d0409b02e7b6ba336287e0c5e2eb54306d3bb5e296e23b6a1b30f2a91408fbf`。
- 完整应用主程序：`dist-app/Pi GUI-win32-x64/Pi GUI.exe`，大小 `246,324,736` 字节。
- 打包核心脚本：`dist-app/Pi GUI-win32-x64/resources/app/server.cjs`，大小 `2,498,545` 字节，SHA-256：`72e79f5fa9b274a4adbd09995c88e54f16eb1e18fd044face39db6474927972b`。
- 离线 Electron 缓存核验：版本 44.4.3 ZIP 文件为 `158,247,567` 字节，完整 CRC 核验通过；解压出的 `electron.exe` SHA-256 为 `bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`。构建过程通过 `PI_GUI_ELECTRON_ZIP_DIR` 显式引用该离线缓存，无任何下载行为。

## 正常沙箱 Electron (run7) 与离线网络守卫资格

本次验收使用真实正常沙箱 Electron 进行完整端到端测试，实测结果文件位于 `%TEMP%/pi-gui-z4-electron-run7/results.json`，运行基于源码 `server.js`，全部证据已归档于 `docs/assets/z4-2/`。

### 1. 核心实测数据

- **运行模式**：`qualification: "normal-sandbox"`，`sandbox: true`，`contextIsolation: true`，`nodeIntegration: false`。
- **通过数量**：48 项业务场景 + 1 项进程彻底清理 = **49/49 全部通过**，0 失败，0 跳过，进程退出码 0。
- **进程树治理**：共监控 9 个受控进程（主进程、渲染进程、后端进程、fake Pi 进程等），测试退出后**残留进程为 0**，无孤儿进程遗留。
- **性能基准**：100 个节点与 200 条有向边图结构完整渲染耗时 **1179 毫秒**（断言上限 5000ms）。
- **实测证据索引（12 张截图、累计账本与结构化结果）**：
  - 累计 Canonical 账本 JSON：[canonical-cumulative.json](assets/z4-2/canonical-cumulative.json)
  - 累计调度脚本：[canonical-continuation.mjs](assets/z4-2/canonical-continuation.mjs)
  - 全链跳过项明细：[canonical-skip-lines.json](assets/z4-2/canonical-skip-lines.json)
  - 代码变动文件清单：[code-file-list.txt](assets/z4-2/code-file-list.txt)
  - 延续运行完整日志：%TEMP%/pi-gui-z4-2-canonical-continuation.log
  - 资产清单与哈希记录：[manifest.json](assets/z4-2/manifest.json)
  - 桌面 E2E 完整输出数据：[electron-results.json](assets/z4-2/electron-results.json)
  - 产物自检探针完整输出：[packaged-results.json](assets/z4-2/packaged-results.json)
  - 需求与覆盖审计参考：[docs/Z4-2-coverage-audit.md](Z4-2-coverage-audit.md)
  - 典型分辨率有界布局：[collab-760.png](assets/z4-2/collab-760.png)、[collab-1200.png](assets/z4-2/collab-1200.png)、[collab-1536.png](assets/z4-2/collab-1536.png)
  - 浅色主题 computed 计算与绘制：[collab-light.png](assets/z4-2/collab-light.png)
  - 100 节点高负载渲染：[collab-100-nodes.png](assets/z4-2/collab-100-nodes.png)
  - Runtime 会话与 Classic 字节隔离：[collab-runtime.png](assets/z4-2/collab-runtime.png)
  - 冲突拒绝提示：[collab-conflict.png](assets/z4-2/collab-conflict.png)
  - 原生视图互斥与 Modal 置顶：[collab-browser-occlusion.png](assets/z4-2/collab-browser-occlusion.png)、[smoke-modal.png](assets/z4-2/smoke-modal.png)、[smoke-native.png](assets/z4-2/smoke-native.png)、[smoke-1200.png](assets/z4-2/smoke-1200.png)、[smoke-760.png](assets/z4-2/smoke-760.png)

### 2. 界面与交互状态机验证

- **自适应视口**：760px、1200px、1536px 三种典型分辨率下画布容器与内部元素均处于有界可视范围内，断言 `overflow: false` 无水平文档溢出。此项证明容器布局与无溢出，不代表 100 个图元素在无平移/缩放下单屏全量可见。
- **浅色主题**：通过真实的 `computed` 样式（计算文本颜色、画布底色与 stroke 无边框）及截图验证，浅色主题下文字与连线清晰可见，全局 SVG 图标样式未污染节点文字排版。
- **项目 A-B-A 切换隔离**：通过真实 `projects.activateProject` 公开切换原语，从项目 A 切换至项目 B 再切回项目 A。断言原生 session 变更、代次递增、画布按需清理与重载，且 A 项目未保存草稿与源码文件字节保持 100% 绝对一致，杜绝跨项目借用数据。
- **原生 Browser 视图互斥**：打开协同编辑器时自动清理内置 Browser 原生视口，确保原生层不会覆盖编辑器；关闭协同后重开 Browser 保持全新的代次语义；Modal 弹窗显式置顶，原生视图无法遮挡。

### 3. 离线网络预载守卫与真实外部请求拦截

为了在测试过程中隔离外部网络，run7 引入了测试专用离线网络预载守卫（`tests/fixtures/z4-offline-network.cjs`）：
- **预载机制**：启动源码 `server.js` 和 fake Pi 时，通过 `node --require tests/fixtures/z4-offline-network.cjs` 在业务模块加载前完成安装。
- **Preflight 隔离自检**：`guardPreflight` 执行 21 组针对性输入测试用例（包括伪装对象、IPv6 括号前后缀、裸 IPv6、URL 参数覆盖、纯 options 等），21/21 均符合预期；对 `missingTrace` 和 `unsafeTrace` 严格执行拒载保护（refused）；`linkedTrace` 为文件 symlink 预检跳过（skipped，未取得该项资格，JSON 结果中无单独 error code）。Preflight 检查与真实 E2E 的审计日志严格隔离。
- **真实拦截实证**：在源码后端 `server.js` 运行期间，GUI 自动更新检查模块尝试向外部网络发起 `fetch` 请求，被预载守卫**精准拦截 1 次**，审计日志完整记录 21 行 trace。
- **守卫边界明确界定**：
  > [!IMPORTANT]
  > 该离线守卫为 Node/Electron 测试专用的预载拦截层，拦截范围覆盖后端与 fake Pi 中的 `globalThis.fetch`、CommonJS `http.request/get`、`https.request/get` 以及渲染进程中通过 session `webRequest` 阻止的非 loopback 请求。
  > **这不属于操作系统内核级的全进程防火墙或网络沙箱**。它无法拦截 ESM 命名导入的 `node:http(s)`、Electron 主夹具进程自身的网络调用，以及 fetch/http(s) 以外的底层套接字/系统调用。报告据实界定其为测试专用守卫，不作超范围承诺。

### 4. 历史运行与资格演化说明

- **run4**：因 A-B-A 测试直接绕过前端状态机调用后端 API 导致超时，且浅色主题未验证 computed 样式，exit 1。
- **run5**：浅色 computed 样式与截图已成功，但因测试误假设“已关闭的 Runtime 必然持有 owner 且项目按钮会打开 history”而失败，exit 1；排查确认 `runtime_closed` 时 `owner=null` 为正确产品行为。
- **run6**：47/47 通过，100 节点渲染耗时 878ms（非整轮耗时）。排查发现该轮仅依靠 Renderer `webRequest`，未能覆盖源码后端 `server.js` 的外部更新请求，且全进程 offline 宣称过宽，资格不完整。
- **run7**：**最终有效验收版本**。49/49 exit 0，100 节点渲染耗时 1179ms，补齐后端预载网络守卫并捕获外部更新请求拦截，测试基于源码 `server.js`，进程清理与几何状态全部通过。

## 故障矩阵、首次红测与独立审查证据

### 1. 存储与异常故障矩阵

在 [存储测试](../tests/collab-store.cjs) 中构造了完整的真实极端边界用例：
- **并发 CAS 竞态**：双进程对同一 baseRevision 发起写入，严格保证一胜一负；胜者 revision+1，负者被安全拒绝并抛出 `collab_conflict`（若读取落后于新 revision）或 `collab_storage_busy`（若遭遇写锁占用），绝无静默覆盖。
- **意外中断恢复**：数据落盘前模拟 `process.exit(37)` 及外部 `SIGKILL` 强杀；残留临时文件与锁文件在下次启动时正确识别；fsync 临时文件 + 原子 rename 机制保证文档在异常退出时保留原有效状态或完成原子提交。
- **数据损坏防护**：模拟非法 UTF-8、JSON 截断、反序列化结构缺失与日志指纹断裂；损坏文件返回稳定错误码 `collab_storage_corrupt` 并保留原文件，停止写入。
- **Windows 专属边界**：覆盖目录 junction、NTFS 硬链接及文件替换探测；真实测试 8.3 格式短路径别名，确保大小写与短路径指向同一目录时不被误判为非法穿越；测试 Windows 专有的 `FileShare.Read` 文件句柄独占，当 rename 被占用阻塞时保留原字节，句柄释放后重试写入成功。

### 2. 首次红测与演进记录

遵循先红后绿原则：
- 数据层：原型移植初期 24/52；补充建议信封与严格日志后升至 52/52；补充混合批次与逆操作回归后达 56/56。
- 服务与面板：针对“旧请求清空后续有效历史”、“错误 scope 误删其他 editor”、“活跃状态淘汰”、“重复接受缺少 expectedRevision”、“长 opId 截断碰撞”、“自己的确认框残留”、“session-switch 先于 owner 更新”等 7 类典型缺陷均建立了红绿回归用例。
- 组合根挂载：HTTP 端点先在未接线状态下取得 404 真实红测，接入 `server.js` 后取得 7/7 绿测。
- Stop 夹具：首次 canonical 在第 153 叶 `tests/gui-browser-stop.cjs` 因缺少协同构造器抛出 `ReferenceError: createCollabStore is not defined`；真实补齐依赖后 `gui-browser-stop` 12/12、`stop-barrier` 17/17 cases 全部通过。

### 3. 独立审查结果与闭环

根据 [REVIEW.md](../REVIEW.md) 规则，本次改动经独立桌面 Agent 进行了多轮只读复审，详细处置见 [Z4-2-reviews.md](Z4-2-reviews.md)：
- **桌面 Antigravity 功能复审**：
  - 第 1 轮：报告 F1 Blocker 与 F2–F5 Important、N1–N2 Nit。经主 Agent 复核，F1（先被 stale-base 拦截）与 F4（存储读写严禁 null）证实为误报；F2（跨 scope 误删）、F3（旧请求清历史）、F5（FIFO 淘汰活跃 editor）已红绿复现并修复；N1 移除无用分支；N2 保留双重校验设计。
  - 第 2 轮：增量复核 `1955926` 与 `aa67bc5`，0 Blocker / 0 Important / 0 Nit。
  - 第 3 轮（最终挂载与生命周期）：0 Blocker / 0 Important / 2 Note（均为已知边界：Note 1 指出旧 scope close 依赖 TTL/LRU 回收；Note 2 确认真实的 Agent proposal source 保持为 null）。
- **桌面 ZCode 安全复审**：
  - 第 1 轮：报告 S1–S3 Important 与 SN1 Nit。S1（未注册/未挂载）与 S2（8.3 路径误拒）已通过集成与别名支持修复；S3（异常退出残留锁持续 busy）作为明确的 fail-closed 设计后果保留，文案已修正为提示人工检查锁；SN1 冲突重新 open 保留。
  - 第 2 轮安全复审：0 Blocker / 0 Important / 1 Nit（切 scope 后 best-effort close 依赖 30 分钟 TTL 或 32 容量 LRU 回收，作为已记录的资源生命周期限制保留）。
- 所有审查均为只读检查，未运行命令或测试，未将作者数据冒充为自身测试数据；发现项均已妥善处置或作为已知边界保留。

## 残余风险与人工决策

1. **真实 Agent 建议闭环未接入**：
   生产服务明确不注入 proposal source，HTTP 端点不能接收自述为 Agent 的建议，不从正文围栏或客户端报文推断权限。后端队列不可变性与预览摘要绑定属阶段 3 研究范围，当前生产保持 null。UI 明确标注“Agent 建议来源尚未接入；当前支持用户编辑与保存。”。
2. **操作系统同用户本地进程竞态边界**：
   当前存储基于 Node 路径规范化、时间戳与文件身份核对（ino/dev/birthtime），不代表针对同 OS 用户的恶意内核级抢占具有强制独占性；未包含断电或任意系统调用中断的强制原子性证明。
3. **全局写锁 `.writer.lock` 的人工恢复策略**：
   在发生硬崩溃或异常退出后，残留的 `.writer.lock` 存在时，只读调用（`store.read`）仍可成功读取文档，但后续写操作（`store.write`）会保守地 fail-closed 阻止写入并返回 `collab_storage_busy`。系统没有设计自动解锁或自动采纳临时文件的机制（避免破坏损坏现场）。
   > [!WARNING]
   > 人工恢复必须由维护者介入：先关闭所有实例，对 `collab-documents/` 进行离线物理备份，人工核对锁文件与文档的一致性，确认无进程占用后再行清理。
4. **Editor 内存历史的有界性**：
   撤销重做历史仅保存在内存中，重启、切换 scope 或外部 revision 变更后历史即清空；已保存确认的文档完整持久化。每个 scope 对应一份文档，系统全局硬限制为最多 20 个 scope、每文档最多 200 节点/400 边、撤销历史深度 100 步、幂等操作缓存 500 条。旧 editor 依赖 30 分钟 TTL 与 32 上限 LRU 淘汰，关闭请求为 best-effort。
5. **应用数据目录与项目隔离**：
   协同文档存储在独立的应用数据目录中；如果尝试将应用数据目录配置在用户项目源码目录内部，将被严格拒绝。系统不具备任意项目文件的导出或覆盖能力。

## 回滚与交付门槛

### 1. 回滚执行指南（供操作参考，非执行动作）

本次开发工作完全在独立分支与独立 Worktree 中进行，**未合并至 main 分支**，未发布新版本，未覆盖安装版。
- **用户环境恢复**：直接启动原安装版即可立即恢复到原版本行为；用户现有的会话、配置及数据完全不受影响。切勿随意删除 `collab-documents/` 协同文档目录。
- **开发分支代码完整回滚方案**：若需撤销本次完整交付分支，维护者需在确认工作区干净的前提下，通过以下由 PowerShell 驱动的可执行指令完整逆序撤销并重建（严禁在当前会话执行）：
  ```powershell
  # 1. 确认当前工作区干净且位于待回滚的交付分支 HEAD
  git status
  if ($LASTEXITCODE -ne 0) { throw "git status 失败" }

  # 2. 获取从新到旧的完整提交序列（精确范围 c9ac555a..HEAD）
  $z4Baseline = "c9ac555a43c7b72216f347a63ddeeb52afa6c72c"
  $z4RevertCommits = @(git rev-list --first-parent "$($z4Baseline)..HEAD")
  if ($LASTEXITCODE -ne 0) { throw "获取回滚提交列表失败" }

  # 3. 逐个提交逆序 revert，遇非 0 立即中断以保留现场供人工处理冲突
  foreach ($commit in $z4RevertCommits) {
      git revert --no-commit $commit
      if ($LASTEXITCODE -ne 0) {
          throw "git revert --no-commit $commit 遇到冲突或失败，已停止后续操作，请人工核查现场。"
      }
  }

  # 4. 审核工作区暂存状态与整体回滚 diff（使用 --cached 查看 no-commit 暂存的变更）
  git diff --cached

  # 5. 按 AGENTS.md 规范定位元数据目录并写入 UTF-8 无 BOM 的中文提交信息
  $commitMsgPath = (git rev-parse --git-path COMMIT_MSG_TMP.txt).Trim()
  $commitMsg = "revert: 撤销 Z4-2 协同编辑全部改动恢复至 c9ac555a 基线"
  [System.IO.File]::WriteAllText($commitMsgPath, $commitMsg, [System.Text.UTF8Encoding]::new($false))
  git commit -F $commitMsgPath
  if ($LASTEXITCODE -ne 0) { throw "git commit 失败" }

  # 6. 重新执行离线构建恢复干净产物
  npm run build:app -- --rebuild
  ```

### 2. 交付门槛核对

依照 [REVIEW.md](../REVIEW.md) 的严格定义，自动验证、证据完备性与人工审批彼此独立：
- **开发完成**：全部业务代码、定向测试、构建产物、测试夹具已全部落实。
- **自动验证状态**：**已累计完成**。全量 canonical 208 叶命令去重全通（`complete: true`，`failure: null`，`uniquePassed: 208`，无新增失败）；各项截图、产物自检、离线网络拦截与累计账本证据已完整归档。
- **代码验收通过**：**用户验收待决定**。自动测试通过与证据完备仅为验收提供依据，不可将自动验证结果冒充为用户代码验收批准。
- **允许合并**：**未授权**（用户与维护者尚未发出合并指令，严禁自行 merge/push/PR）。
- **允许发布**：**未授权**（禁止打 tag、推送发布 tag 或触发发版流程）。

文档集成来源：桌面 Antigravity 报告提交 `019637a389ded9bf3cb583b2abf4b9d421ca6fcc`（antigravity/z4-2-electron）；桌面 ZCode 覆盖审计提交 `b96ca1a38695b348311ef3edb5c8fcfca9723d88`（zcode/z4-2-evidence）。Codex 复制核对后在最终文档提交集中归档报告、导航、原始 PNG、JSON ledger 与摘要；没有改动 bfb9a2a 的产品/测试行为。完整运行日志保留在本机 TEMP，仓库仅归档结构化记录与摘要。
