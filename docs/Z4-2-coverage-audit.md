# Z4-2 需求覆盖审计

对照原始任务（`Z4-2 多 Agent 并行开发总任务`，主 Agent 附件原文）逐项核对交付范围。审计人：桌面 ZCode，只读静态核验集成树 `f66ef8b5eb57c289d6731f0b27277eed0a48948c` 与其文档/测试；本审计**不是**第三轮安全审查，也不构成代码验收、合并或发布许可。审查规范见 [REVIEW.md](../REVIEW.md)。

状态四分：**已实现**（我静态核验过代码/接线）、**作者已实测**（数字来自 docs/Z4-2-acceptance.md 的运行记录，非我复跑）、**待验证**（尚无可信证据）、**有意延后**（原始任务明确允许的边界）。文件存在不等于测试通过；我的静态审查不冒充亲测。

## 一、总目标（§一 7 项交互）

| # | 需求 | 状态 | 证据与边界 |
|---|---|---|---|
| 1 | Agent 生成结构化流程图 | 部分实现 | 初始模板由服务端 `createFlowchartDocument` 生成（server/collab-service.js:92-95）；真实 Agent 生成链路=有意延后（见 §四） |
| 2 | 用户直接编辑节点/连线 | 已实现+作者已实测 | 受控意图经 collab-canvas→panel→service 全链 user actor 校验；canvas 72/72、panel 11/11 为作者数据 |
| 3 | 结构化文档而非 SVG/HTML | 已实现 | document 协议与 Z3 viz 独立（lib/collab-doc.js；tests/modules.cjs:831-835 纯度守卫） |
| 4 | Agent 基于当前文档提建议 | 有意延后 | 生产 `proposals=null`（server.js:1014-1015）；仅后端已知 proposalId 可引用 |
| 5 | 预览差异/接受/拒绝 | 已实现（组件与协议） | preview 只读不提交；accept 核 expectedRevision（lib/collab-doc.js:637-682）；真实闭环待阶段 3 |
| 6 | 版本冲突/撤销重做/安全存储 | 已实现+作者已实测 | CAS、逐操作可逆、store 故障矩阵见 acceptance.md:78-80 |
| 7 | 代次变化不致旧覆盖新 | 已实现 | token 绑定 owner/revision（review-comment-authority.js:42-43）；assertCurrent 多点复核；ZCode 两轮审查确认（docs/Z4-2-reviews.md） |

## 二、数据协议与模块（C0/C1）

- **已实现**：闭集操作、严格 schema、事务化批量、CAS、有界规范指纹日志（500）、完整建议信封校验先于 duplicate 快径、accept 显式 expectedRevision、undo/redo 逐操作逆操作、资源上限（200/400/50/2MiB）。原始任务要求的「preview/accept 自行完整校验、幂等路径不可绕过」在 lib/collab-doc.js:559-682 静态核验成立。
- **作者已实测**：collab-doc 56/56（assert135）、原型 49/49（acceptance.md:57-58）。
- **待验证**：以上数字未由独立方复跑；计入完整 canonical 208 后方可作验收证据。

## 三、存储 / Owner / 故障注入（A1/A2/A3）

- **已实现**：A1 全部 12 项要求逐条对应 collab-store.js（固定应用数据根 :17-18、scope 寻址 :162-164、CAS :168-171、wx 排他锁 :155-158、temp+fsync+rename :172-186、损坏拒写 :102-113、身份拒绝 :24-36,63-70、失败保留字节 :189-194）；存储层不接受 Renderer 路径/scopeHash（HTTP 字段闭集，tests/collab-http.cjs:46-50）。A2 复用 review-comment-authority 完整取证并派生独立命名空间（collab-authority.js:17-37）。8.3 短路径修复（03b4749）为原始拼写祖先链禁止链接 + 同实体身份比对，未放宽硬链/替换/损坏/容量判据（collab-store.js:24-36,63-70）。
- **作者已实测**：store 53/53（assert149/skip1，含双进程竞态、exit37、SIGKILL、Windows FileShare、真实 8.3 别名）、authority 24/24（assert68）、http 7/7（assert28，真实 Router）。全部为作者记录，非我复跑。
- **待验证**：完整 canonical；产物 opt-in 探针（tests/collab-packaged.cjs 本轮整理版）尚未由任何人以新版本运行；正常沙箱 Electron 专项（见 §六）。
- **资格边界（不可夸大）**：Node 路径级 IO + 身份/时间戳核对**不是**同 OS 用户恶意进程的强制独占；无断电、全 syscall 中断或其他平台证明；wx 锁只约束本应用协作写者（Z4-2-agent-source-research.md:103-111）。这是设计前提，不是缺陷，但验收表述必须保留此限定。

## 四、Agent 建议来源（A4 与阶段 3）——有意延后

原始任务 Wave 3 与「本轮期望」明确允许：来源研究完成即可，真实闭环在可信接口具备前标待完成、不虚假演示。当前状态与该边界一致：

- 生产 `source=null`（server.js:1014-1015）；HTTP 不能注入自述 Agent 建议（tests/collab-http.cjs:66-69）；UI 明示「来源尚未接入」（collab-panel.js:35）。
- 研究结论与最小接入点已记录（Z4-2-agent-source-research.md:38-54）：后端事件入口提取、owner 绑定、有界不可变队列 + 内容摘要绑定等均为**未实现的阶段 3 设计**；当前 service 的 fixture 注入接口不具备该资格。
- **缺口**：无。属原始任务允许的延后；不得对外演示真实 Agent 闭环。

## 五、画布与 UI（Z1/Z2/Z3/Z4）

- **已实现**：Z1 十二项能力对应 collab-canvas.js 受控回调面（无内部权威文档、无文件系统访问）；Z2 预览组件显式点击才回调、失败保留文档；Z3 主题/焦点/确认框经 collab.css token 与 panel 确认归属实现。Z4 组件测试在 canonical `test:collab` 链内的只有 8 叶：原型 + doc/store/authority/service/http/canvas/panel（package.json:150）；`tests/collab-electron.cjs` 是独立 opt-in Electron 专项（package.json:151），不在 canonical；fixtures/z4-collab-* 为专项辅助材料，不因存在视为通过。
- **作者已实测**：canvas 72/72、panel 11/11（acceptance.md:62-63）。
- **待验证**：正常沙箱 Electron 专项 run4 因项目 A-B-A 直接调后端 API 超时 exit1，浅色截图未证明颜色改变（acceptance.md:88）；Antigravity 正在独立修正，**取得最终 0 退出与真实截图前一律待验证**。jsdom 断言不代表真实 Electron 布局（原始任务 §六 Z4 明示）。
- 集成挂载静态核验：btnCollab 为会话工具按钮（index.html:106-108、app.js:268-281），无新全局 rail/命令面板入口；collab CSS 全部收敛在 `.collab-*` 作用域；未发现 Z3 schema 改动。

## 六、集成与验收回归（C2/C3）

- **已实现（静态核验）**：Origin+Token 之后、Classic-only guard 之前挂载 `/api/collab-documents`（router.js:169-192）；完整组合根（server.js:1010-1015）；`test:collab` 8 叶接入 canonical 链（package.json:17,150）；modules.cjs 依赖方向守卫含 collab-doc 纯度检查（tests/modules.cjs:831-835）。
- **待验证（收口清单，均已在 acceptance.md 自我声明）**：
  1. 完整 `npm test`（208 叶命令，2026-10-25 14:24 起，结果未出）——退出码与实测数量回填前不得声明「全绿」。
  2. `node tests/collab-electron.cjs` 正常沙箱交互 + 真实截图。
  3. 产物 opt-in 探针以整理版脚本运行，结果 JSON 计入 acceptance。
  4. acceptance.md 待补：最终行为 SHA、`git diff --name-status` 清单、Electron 截图、回滚序列。
- **作者已实测（产物构建）**：build:app/--rebuild 退出 0；build/Pi GUI.exe 102860288 bytes（SHA256 见 acceptance.md:72）；离线 Electron ZIP CRC 验证（:74）。

## 七、关键安全约束（§八 15 条）对照

静态核验未发现违反：不动 Pi 本体；无新代码执行面；模型输出不直接执行（建议仅经信封校验的受控操作）；owner/actor/sessionId 不信任自述（authority 服务端取证）；不自动接受建议；无整文档覆盖（HTTP exact-keys 拒绝，tests/collab-http.cjs:58）；冲突显式拒绝；无任意项目文件写入；Z3 未改；无新依赖（package.json 依赖未变）；未动无关 CI/发版配置；未互相覆盖工作区（提交来源表 acceptance.md:18-27）；独立审查记录在 Z4-2-reviews.md；用户数据/正文上传为**静态核验**：本轮未见新增上传通道；错误出口固定码与文案仅证明不回显路径/敏感串（collab-routes.js:20-25），实际运行时无上传行为由作者测试记录证明（acceptance.md），非我亲测。

## 八、有界资源与资格限制（不得夸大表述）

- **editor 生命周期**（ZCode 第二轮 Nit-1）：旧 scope 的 close 可能被 authority 拒绝，服务端 editor 条目滞留至 30 分钟 TTL 或 32 上限 LRU 淘汰（collab-service.js:39-42,65-68）；无 token 不可复用，无安全影响。表述为「有界资源限制」，不得声称「立即后台回收」。
- **遗留锁**：崩溃后全局 `.writer.lock` 保守拒写，读可用；无自动解锁。人工恢复=关闭全部实例、离线备份 collab-documents、维护者核对后处置，不确定时保留只读（acceptance.md:96；collab-service.js:18 文案）。是否接受或另立恢复任务由用户决定。
- **竞态资格**：同用户恶意原生竞态、断电、跨平台未获资格，不得表述为强 sandbox/ACL 保证。
- **容量**：20 scope/512 目录项/2MiB/500 日志，不是无限防重放账本。

## 九、实质缺口与最小下一步

| 缺口 | 路径 | 最小下一步 |
|---|---|---|
| 完整 canonical 未收口 | docs/Z4-2-acceptance.md:66 | Codex 完成 208 叶运行，回填退出码/数量/skip |
| Electron 专项未过 | tests/collab-electron.cjs；acceptance.md:88 | Antigravity 修正 A-B-A 与浅色绘制后取得 0 退出 + 真实截图 |
| 产物探针未以整理版运行 | tests/collab-packaged.cjs（本轮文件） | Codex 在两产物重建后运行，设 `Z4_PACKAGED_OUTPUT` 保存结果 JSON 计入验收 |
| acceptance 待补字段 | docs/Z4-2-acceptance.md:30,49,102 | 最终 SHA、diff 清单、截图、回滚序列 |
| 真实 Agent 闭环 | 阶段 3 | 按 Z4-2-agent-source-research.md:38-54 另立任务；本轮不做 |

无其他实质缺口；未发现需要修改生产代码的问题。本审计不修改任何生产/集成文件（本轮仅新增 tests/collab-packaged.cjs 与本文件）。

> 2026-10-25 状态更新：§九 中「产物探针」「Electron 专项」两项已由主 Agent 实跑收口（见 §十）；「canonical 收口」「acceptance 补字段」的最终状态见本节末尾与总验收；前文表格仅保留历史快照。

## 十、run7 收口证据核对（2026-10-25 附录）

**范围声明**：本节核对基于只读阅读集成树的 [electron-results.json](assets/z4-2/electron-results.json)、[packaged-results.json](assets/z4-2/packaged-results.json)、[manifest.json](assets/z4-2/manifest.json)、集成源码（含 `tests/fixtures/z4-offline-network.cjs`）与主 Agent 提供的提交映射；全部测试数字仍为**主 Agent 实测记录**，本审计未运行任何命令或测试。§一至§九保留为 f66ef8b 时点的只读快照结论，不因本节改写。canonical 已按主 Agent 的最终 ledger 累计完成 208/208，见本节末尾。

**产品冻结与提交映射**（主 Agent 提供，manifest 交叉一致）：
- 最终生产行为固定于 `5388c1be155a0b86f9ed2c903669d31d63ce50d1`（完整 SHA，与 manifest.sourceCommit 逐字符一致）；其后集成提交仅触碰 6 个纯测试文件（collab-electron、fixtures/z4-collab-electron、fixtures/z4-network-guard-probe、fixtures/z4-offline-network、gui-browser-stop、stop-barrier），与续跑 runner 的 6 文件白名单一致。
- 守卫来源 `401eacbcb2c01d6ed1d4c7ada33ec236dddaee81` → 集成 `b772e0eb5150b7ab1d06fce6d897391245013451`；Stop 夹具 `2e04a04ad0e4349341ef06d7558bde95b6c45bf0` → 集成 `bfb9a2afc19a5de8f9ba5b6273713047e661df76`（= manifest.testCommit）。已通读集成树守卫文件，与 401eacb 源内容一致（fetch 形状白名单、精确 hostname 解析、TRACE 固定拒载、安装失败即中止）。

**run7 真实沙箱 Electron（主 Agent 实测，与 electron-results.json / manifest.json 逐项核对一致）**：
- exit 0；48 项场景检查 + 1 项进程家族清理 = 49/49（electron-results.json `checks:48` 与 manifest `electronChecks:49` 的定义注记一致，非矛盾）；9 个受控进程残留 0；100 节点/200 边渲染 1179ms（断言上限 5s）；UI 场景 **0 失败 0 跳过**（electron-results.json `skipped:0`，与本节后述 preflight 的 symlink skip 分列）。
- 截图与 JSON 均按 manifest 相对链接登记，索引共 **12 张 PNG**（下表）；`smoke-native.png` 为独立原生页原图——父窗口 `capturePage` 不含原生子视图（Browser WebContentsView）像素，故单列而不冒充合成截图。

| 截图（相对链接） | 记录内容 |
|---|---|
| [collab-760.png](assets/z4-2/collab-760.png) | 760px 画布有界布局 |
| [collab-1200.png](assets/z4-2/collab-1200.png) | 1200px 画布有界布局 |
| [collab-1536.png](assets/z4-2/collab-1536.png) | 1536px 画布有界布局 |
| [collab-light.png](assets/z4-2/collab-light.png) | 浅色主题（computed 颜色 + 截图） |
| [collab-conflict.png](assets/z4-2/collab-conflict.png) | 冲突拒绝状态 |
| [collab-100-nodes.png](assets/z4-2/collab-100-nodes.png) | 100 节点/200 边渲染 |
| [collab-runtime.png](assets/z4-2/collab-runtime.png) | Runtime/Classic 隔离 |
| [collab-browser-occlusion.png](assets/z4-2/collab-browser-occlusion.png) | Browser 与编辑器互斥遮挡 |
| [smoke-native.png](assets/z4-2/smoke-native.png) | 原生 Browser 页独立原图（非合成） |
| [smoke-1200.png](assets/z4-2/smoke-1200.png) | Browser 原生几何对齐 1200px |
| [smoke-760.png](assets/z4-2/smoke-760.png) | Browser 原生几何对齐 760px |
| [smoke-modal.png](assets/z4-2/smoke-modal.png) | Modal 置顶防原生遮挡 |

每个 PNG 与两份 JSON 的字节/SHA256 见 [manifest.json](assets/z4-2/manifest.json) 的 `files` 索引；结果数据本体为 [electron-results.json](assets/z4-2/electron-results.json) 与 [packaged-results.json](assets/z4-2/packaged-results.json)。

- 网络守卫资格：spy 预检 21/21 输入用例符合预期；`missingTrace`/`unsafeTrace` 固定拒载（refused）；**`linkedTrace` 仅记 `skipped`，preflight 结果未包含具体错误码，本审计不断言其为 EPERM**。该 preflight skip 与 UI 场景 `skipped:0` 分列；存储套件 tests/collab-store.cjs 另有独立 `skip 1`（Windows 文件 symlink 创建权限受限，作者记录有 EPERM 证据），三者互不混算。真实 E2E 中 GUI 自动更新外网 fetch **阻断 1 次**（trace 21 行；backend 与 fake Pi 的安装计数在 observed 中分列）。边界为 Node `globalThis.fetch` + CommonJS `http(s).request/get` + renderer `webRequest` 三层，**不是 OS 级网络沙箱**（与 electron-results.json `networkGuard.limits` 同文）；预检阻止事件不冒充真实自动更新证据。

**产物验证（主 Agent 实测）**：App 自检 26/26、SEA 自检 49/49、`test:collab:packaged`（tests/collab-packaged.cjs，package.json:152）28/28 均 exit 0；packaged-results.json 中 app/sea 两 form 的 8 资源逐字节 SHA256 完全一致，后端/manifest 版本 0.29.0（SEA 侧 manifest 如实记 unknown）。产物内静态上传路径检查不冒充真实上传 E2E。

**检查数口径（更正）**：原附录曾按主 Agent 早期汇总写 **385**，经算术核对有误：八套件为 prototype 49 + doc 56 + store 53 + authority 24 + service 13 + HTTP 7 + canvas 72 + panel 11 = **285 checks**。主 Agent 已向用户明确纠正并在 integration/reviews 与历史任务包加勘误，测试项没有减少。本节以 **285** 为最终口径，不保留 385 结论；不含 modules 120、smoke 1338、Stop 12+17；不跨套件加总 assert 调用次数，也不把 285/49/28 等定向结果加总为 canonical 证明。

**canonical 累计 208：已完成（累计口径）**。[canonical-cumulative.json](assets/z4-2/canonical-cumulative.json) 实录 `complete=true`、`failure=null`、唯一通过 **208/208**：本次续跑 65 叶（前置 9 + 剩余 56）全部 exit 0，加上 run2 已成功的前缀 152 叶，重复的 9 叶经 Set 去重后恰好覆盖 208 个规范索引。主 Agent 已收集全部进程，退出码 0。运行窗口为 2026-10-25 上海时间 19:17:02 → 20:16:44，续跑耗时 59m42.262s；测试 HEAD 精确为 `bfb9a2afc19a5de8f9ba5b6273713047e661df76`，产品仍固定 `5388c1be155a0b86f9ed2c903669d31d63ce50d1`，其后差异仅文档；前缀日志 SHA256 `fa81a6e2588430d8eaec58583971d46fd410873cfa80a349db6acbdc7e28a84b`。runner 与记录文件：[canonical-continuation.mjs](assets/z4-2/canonical-continuation.mjs)、[canonical-skip-lines.json](assets/z4-2/canonical-skip-lines.json)、[canonical-cumulative.json](assets/z4-2/canonical-cumulative.json)。

**这是累计 canonical，不是单次 `npm test` 通过，也不是新的远端 CI**：152 叶复用自第二次运行的已成功前缀（首次 f66 运行止于 smoke 1337/1338，第二次止于第 153 叶 gui-browser-stop 缺构造器，两次失败历史保留见 acceptance/reviews 勘误）。末段 skip 明细：Object writer **19/19**、faults **45/45**、object witness **0/0（skip 8：existing_token_sacl_unavailable）**；其余套件另有各自 skip，**以 [canonical-skip-lines.json](assets/z4-2/canonical-skip-lines.json) 明细为准，不得概括为总共仅此 8 项**。既有 Native 回归的资格仅限其原有范围，不能升级为 Z4 Node 存储层对同用户恶意竞态的独占证明。用户验收、允许合并、允许发布均保持**未授权**。
