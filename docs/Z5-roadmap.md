# Z5 产品路线图

日期：2026-10-26；审计基线 `c7fbad65500e1c20b6084f421c7920d8f77ffbc6`。
依据：[产品审计](Z5-0-product-audit.md)、[本轮验收](Z5-0-acceptance.md)。这是待用户独立验收的建议，**没有启动任何 Z5 实现**。

## 1. 方向及取舍

优先让已有的并行开发闭环可靠：写任务 → 正确发送 → 保住未发送文本 → 看清模型状态 → 恢复执行上下文。

比较过三种方向：

| 方向 | 收益与代价 | 结论 |
| --- | --- | --- |
| 先修高频链路的确定缺口 | 已有可重复模块证据；可沿现有 owner/Surface/存储原语局部交付 | 推荐，形成下列3个阶段、4项工作 |
| 合并 Classic/Runtime 并整体改版 | 可能降低长期重复，但触及权限、生命周期、Browser、恢复等大量边界；缺少收益量测 | 不进入 Z5，漂移策略按需小范围共用 |
| 继续大图协议、编辑器、MCP Apps/协作平台扩张 | 能力范围扩大，但当前需求频率及上游合同不足，增加迁移与安全成本 | 暂缓，不将历史方案的“下一代”措辞当授权 |

只有 F1 是本轮确认的功能缺陷；O1/O2 是已确认限制的改进机会，D1 是有历史依据的合同分歧。先修 F1，并在同一 Composer 阶段交付 O1；不为达到8项上限填任务。

## 2. 筛选清单（4项）

### R1 / F1：防止并行会话输入法误发送

- **问题**：Runtime 未拦截 keyCode229 兼容事件及显式 composition 生命周期，可能把候选确认作为 Enter 提交。
- **当前证据**：`runtime-conversation.js:219-225`；Classic `app.js:959-965` 已有 keyCode229 守卫。离线生产视图探针：兼容 Enter 触发1次prompt；标准 composing/Shift+Enter各0次。不宣称特定实体输入法已复验。
- **用户收益**：中文任务写完前不会因输入法确认键提前提交给 Agent。
- **方案**：本地 textarea composition 标记 + isComposing/keyCode229 检查，继续调用现有 captured owner 的 send 动作；离开/切换会话重置局部状态。
- **模块**：`public/runtime-conversation.js`；`tests/runtime-conversation.cjs` 及现有 Electron fixture。
- **复杂度 / 回归风险**：低 / 低。只改变不应提交的键盘事件，不扩大执行权限。
- **验收**：普通Enter只发1次；Shift+Enter、composing、keyCode229不发；IME确认后下一次普通Enter可发；busy/历史/切会话不误发；真正输入法场景记录环境和事件序列。
- **依赖**：无 PR #36 依赖。与 R2 共用 Composer 文件，建议同阶段单 Worktree 执行。

### R2 / O1：并行会话未发送文本恢复

- **问题/机会**：当前 Runtime 草稿只在 renderer store 内存中；刷新或重建 store 为空。Classic 已有纯文本持久化，背景新会话草稿也有不同适配，live Runtime 未覆盖。
- **当前证据**：`runtime-store.js:11,19,34`、`runtime-conversation.js:220,253-264`、`draft.js`；本轮探针 freshStoreDraftEmpty=true、localStorageKeys=0，既有A/B切换测试48/48仍通过。
- **用户收益**：应用重开后可继续已写的任务，减少丢字和重写。恢复文本永远不自动发送。
- **方案**：新增很小的 Runtime UI 草稿适配器，复用 `readDraftText/writeDraftText/removeDraft`，以 backend 已验证的稳定 locator 标识分区；不使用 Classic 全局绑定函数。保留草稿revision和发送ACK归属规则。
- **模块**：拟增 `public/runtime-draft.js`；修改 runtime-conversation、runtime-store/state 的最小必要接线、测试及文档。避免将文本写入 Registry manifest 或 Pi session schema。
- **复杂度 / 回归风险**：中 / 中。风险集中在身份分区、异步ACK与存储失败，详细规则见 [第一阶段计划](Z5-1-implementation-plan.md)。
- **验收**：A/B、普通项目会话/Worktree会话互不串稿；页面刷新、退出重开可恢复符合身份及容量边界的纯文本；不恢复到新workspaceEpoch/nativeSessionId；旧ACK不删新草稿；空白和确认发送版本正确清除；隐私模式/配额满不阻断发送。保留262144字符输入能力，超过持久化上限必须明确反馈，禁止静默截断后冒称完整恢复。
- **依赖**：不依赖 R1 的逻辑，也不依赖 Z4-6B；同文件冲突决定一起交付，不是假造技术串行依赖。

### R3 / D1：统一思考等级的产品合同（条件项）

- **问题**：有当前模型且Pi回读提供多个档位时，Classic可用、Runtime可能因静态reasoning=false/unknown而禁用；两种现有说明相互冲突。
- **当前证据**：`ui3-model-picker.js:103-134`、`runtime-models.js:48-66,109`；[model-capabilities](model-capabilities.md)和[P32.4 §11](p32-4-acceptance.md)；本轮5项对比断言。
- **用户收益**：同一模型不会因进入不同会话视图而出现矛盾的可用性解释。
- **推荐方案**：用户接受此产品合同后，以已确认的当前模型 + 原生成功回读档位为操作依据；抽出小型纯 availability 策略供两视图使用。保留静态 capability 原始三值，不伪造reasoning=true，不生成新档位。
- **备选**：保留 Runtime 更保守合同并明确解释差异。若用户选择该备选，则取消本阶段统一代码任务，仅更新说明；不能把旧行为当必须修复的回归。
- **模块**：`public/runtime-models.js`、runtime-conversation、ui3-model-picker及一个无DOM纯策略；runtime-models/ui3-model/model-capabilities测试；两份冲突说明。
- **复杂度 / 回归风险**：中 / 中。涉及可用性与迟到模型回读，保留owner/id/command相关性，HTTP ACK仍不等于Pi切换成功。
- **验收**：相同模型/levels/pending输入得相同状态；无模型/读取失败/空/仅off不可用；只发送原生给出的档位；过期owner/切A→B不污染B；失败保留已确认值；真实窗口可辨识不可用原因。
- **依赖**：**用户的合同选择**。不依赖R2数据格式；与Z5-1在runtime-conversation冲突，因此错开提交窗口。

### R4 / O2：恢复工作时的只读工具摘要

- **问题/机会**：关闭会话后的历史仅正文，用户难以判断做过哪些执行/修改；不是磁盘历史损坏。
- **当前证据**：`session-history.js:23-27,77-105`、`runtime-conversation.js:113,427`、P32.4 §12；与live recovery有界事件恢复明确区分。
- **用户收益**：重开会话即可追踪工具执行，不必重复运行命令或重新让模型解释。
- **方案**：先核对目标Pi官方session/toolCall/toolResult真实形状；在已有同fd限量读取与locator证明后，投影只读工具名、明确可证明的状态及截断提示。优先复用现有tool-model/tool-history纯解析，不导出原始参数或工具输出；暂不补完整thinking/usage附件。
- **模块**：`server/session-history.js`、Runtime历史与会话导航视图、现有工具投影、runtime-history-search/conversation与安全测试。
- **复杂度 / 回归风险**：中 / 高。历史内容投影及私有数据边界要求专项审查，不能混入R1小修。
- **验收**：符合真实嵌套message/父子分支的fixture；无凭据/路径/命令参数泄漏；异常/缺失/截断显示未知；大文件预算不扩大；搜索定位不漂；dormant查看不spawn、不恢复审批、不执行工具；跨locator迟到结果拒绝；TEMP真实文件与Electron检查通过。
- **依赖**：已核对的Pi形状与安全投影合同；**不依赖R1/R2/R3**。若无可靠来源或不能安全限定，阶段交付为明确NO-GO及缺口，保留正文历史，不用猜测补字段。

## 3. 阶段安排与交付

| 阶段 | 范围 | 可独立验收的成果 | 顺序/并行约束 |
| --- | --- | --- | --- |
| Z5-1 并行会话输入可靠性 | R1+R2 | IME事件不误发送；符合边界的未发送文本能恢复；模块/故障/窗口证据、构建及验收报告 | 首先建议实施，待用户独立验收本规划。一个独立 `codex/z5-1-runtime-input` Worktree，避免两人同时写Composer |
| Z5-2 思考等级合同统一 | R3条件项 | 用户认可的统一合同、最小纯策略与UI表现、隔离/回读回归 | 与Z5-1无业务依赖，但共同修改runtime-conversation，等该文件的改动稳定后再从最新main创建Worktree；不为它重写模型选择器 |
| Z5-3 历史上下文恢复 | R4 | 安全的只读工具摘要及真实格式/身份/预算证明；不满足条件则NO-GO | 可在Z5-1期间于独立 `codex/z5-3-history-context` Worktree先做只读契约核对/后端测试；修改Runtime历史视图的提交与Z5-1/2错开。不是依赖Z5-2才可解析历史 |

阶段编号表示推荐交付优先级，不是所有工作必须串行。若未来授权并行，每项有独立checkout、依赖目录、TEMP夹具与build输出；不能共用dist-app或修改另一个Worktree。本轮只有一个Agent，不创建这些未来工作区。

每阶段分别记录：开发完成、约定测试/独立审查完成、用户验收、允许推送、允许合并、允许发布。采用现有canonical与专项测试政策；未来用户可预先选择当前PR CI提供完整证明，在结果出来前写待验证。禁止本轮规划自动获得这些权限。

## 4. 持续门槛及暂缓项

- **现有高风险资格**：T4-C独立功能/安全、P33 allowlist、SACL、更新原位升级等沿既有报告继续登记；这比视觉美化重要，但不是一个自动开启的新基础设施阶段。新发现可复现的安全缺陷立即优先重排；未取得资格不得扩展写权限。
- **PR #36**：已有打包窗口脚本及证据不重做。若合并，只在后续实施前fetch核对差异及最终CI，不能把B证据归为Z5新开发。
- **不立项**：全文编辑器、MCP Apps宿主、云协作、任意Gen UI执行、全局状态重构、第三套调度器、依赖升级、CI减测系统、纯美化。
- **大图布局**：当前>50条操作明确拒绝；需真实需求与独立原子协议资格后另案，不用提高全局上限或自动分批绕过。
- **指标不伪造**：输入错误用请求数/草稿字节一致性验证；恢复用身份及文本对照；没有任务时间/CPU基线时不承诺“提效百分比”或“性能提升”。

首阶段完整目标、文件、步骤、测试和风险见 [Z5-1 实施计划](Z5-1-implementation-plan.md)。路线图到此为止，不开始实现。
