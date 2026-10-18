# UI-2A：Classic 消息、工具摘要与元信息验收

日期：2026-10-16。角色：并行 Agent A。独立目录 `C:/pi-GUI-ui2-classic`，分支 `codex/ui2-classic`，起点为 `d0585b89a81c0a93e894d58b9d078af75aa985b2`。

**结论：Agent A 的 Classic 结构、真实数据与交互专项完成。** 新专项48/48、真实Electron65/65，既有smoke1338/1338、body5/5、quota229/229；实际退出码均为0。共享CSS、Runtime、完整npm test和产物构建留给集成阶段，不宣称最终视觉集成已经验收。

## 1. 文件范围和提交

| 文件 | 实际变化 |
|---|---|
| `public/messages.js` | 在保留助手外壳的前提下附加逐消息footer；Thinking状态/区域标签；异常收尾保留待绘制的流式尾段 |
| `public/tool-view.js` | 原createGroup/addToGroup增加原生button摘要、ARIA、折叠状态与独立状态摘要；条目状态改变时更新分组摘要 |
| 新 `public/message-meta.js` | 只展示对应AssistantMessage.usage的白名单数字，不读任何全局用量状态 |
| 新 `tests/ui2-classic.cjs` | 独立DOM专项；`--electron`模式提供实际渲染、键盘和截图证据 |
| 本报告及 `ui2a-evidence/` | 本任务日志、退出码、截图、范围核对；不覆盖UI-0/UI-1证据 |

`public/tools.js`、`public/tool-history.js`和`public/tool-model.js`无需改动。禁止列表中的styles/tokens/index、Runtime、electron、server、package.json全部未改。没有安装依赖，没有联网、push、merge、rebase或发版；没有切换、重置或清理其他工作区。

本地提交按实现/测试拆分：

- 实现：`29b2f1fcdc88f3d06f1ebe809c47891c63c11274`。
- 测试：`4b96190cdb60d01aa6c25507266b84e39f65d349`，为本报告撰写时的代码HEAD。
- 本报告与证据另作本地文档提交；最终文档提交SHA在交付回复及本分支git log中，避免在文件中伪造自引用SHA。

范围与产品文件hash见 [scope-verification.json](ui2a-evidence/scope-verification.json)。本轮只是独立分支交付，不修改其他Agent文件。

## 2. 勘察与真实数据依据

开始时目标目录/分支均不存在，从指定本地提交创建Worktree。原仓库AGENTS、工作机记忆、UI-0五份文档与UI-1验收均已读取；UI-0文档在原仓库是未跟踪文件，没有擅自复制进新Worktree。遵循本轮更窄的文件所有权，未按旧规划修改CSS或app.js。

| 路径 | 已确认事实与本次处理 |
|---|---|
| `public/app.js:291–305` | 既有message_start/update/end分发保持；最后的message_end.message仍为权威，不改SSE或RPC |
| `public/messages.js:onMessageUpdate/onMessageEnd` | delta按contentIndex组装；最终正文校正和节点复用保留，footer只在该条最终消息有可渲染正文/Thinking/错误/说明时追加 |
| `public/rpc.js:165–166` | get_messages由原有历史重建入口消费，消息级usage直接来自各自历史message |
| `public/tool-history.js:planHistory` | toolCall.id配对toolResult.toolCallId，一条assistant对应一个组，孤儿result在自身位置降级；本次不改 |
| `public/tools.js` / `public/tool-model.js` | 继续通过原start/update/end、dirty回调、settleRunning及Git统计回填重画ToolEntry；不增加第二套执行状态 |

另外只读核对了本机实际安装的 `@earendil-works/pi-coding-agent` **1.3.0**，测试不导入或依赖该安装：

- 其嵌套 `@earendil-works/pi-ai/dist/types.d.ts:279–301` 定义Usage，字段为input/output/cacheRead/cacheWrite/cacheWrite1h/reasoning/totalTokens；reasoning明确是output的子集，真实0有意义。
- 同文件`:362`的AssistantMessage含content、usage、stopReason与请求开始timestamp；没有据此虚构生成耗时。
- `dist/modes/json-event.js:toJsonEvent` 将message_update的usage投影到顶层，移除累积正文快照；最终消息保持原结构。
- `dist/modes/rpc/rpc-mode.js:534–535` 的get_messages返回 `session.messages`，不是会话总量统计。

以上字段形状用于构造离线fixture；没有访问或修改真实会话、凭据、Pi本体和Session Schema。

## 3. 具体行为

### A1 / A4：助手消息与元信息

`renderMessageMeta(message)`只接受assistant、非数组usage对象及白名单中的非负安全整数。真实0显示，缺失/null/字符串/负值/NaN/Infinity省略；全部未知时不创建空footer。显示输入、输出、缓存读取、缓存写入、1小时缓存写入、思考和总计；只显示实际存在的字段，不相加补造totalTokens。思考项标注“含在输出中”，避免重复加算。

实时只绑定该条 `message_end.message.usage`；历史绑定 `item.message.usage`。生成中的顶层update.usage仍由原统计面板处理，本实现不把它或S.localUsage.lastTurn提升为最终消息事实，不把累计统计分配到历史节点。不展示没有来源的duration/cost/model推测值。

footer是 `.msg.assistant` 内 `.msg-body` 后的兄弟节点，不进入正文。原rebuildAssistant的keep判定先执行，tool-only消息仍移除整个空外壳，usage不能把空气泡复活。错误/中断/真正空回复提示保持；错误重试删除空外壳时footer也一起删除，部分正文仍保留。没有新增持久化消息ID或缓存消息副本。

### A2：工具批次摘要

保留原createGroup/addToGroup/ToolEntry/toolCallId与所有配对和分组边界。多项组保留原“操作 N 项”文字，组头改为原生button，默认展开；click及浏览器原生Enter/Space切换同一列表的hidden/aria-expanded，不重建条目。单项组标题和组级状态均隐藏，原条目状态继续可见。

多项组的独立状态节点始终显示实际条目状态计数：运行中、失败、未完成、已中断、已取消、未知、成功。折叠后错误/运行状态仍可发现，后续状态更新或新条目加入不覆盖用户的折叠选择。焦点若在将隐藏的列表内，折叠先交给摘要按钮。ARIA关系使用本次DOM唯一ID，不修改协议。

**取消/中断边界：** 通用Pi工具结果若只给isError=true，即使文本含cancelled，仍保持error；未收到工具结束事件的条目继续由原settleRunning标为incomplete。没有从任意文案伪造cancelled/interrupted。若既有ToolEntry/适配器已经提供明确cancelled/interrupted，则摘要按该真实展示状态计数。两类路径均有测试。

更新只读取经过既有适配器处理后的节点状态，不新增raw args/results来源。相同状态的duration/output/Git重画不重复扫描整组，批次摘要文本没变时不重写live-region。

### A3：Thinking

保留think/head/body、原生button、contentIndex节点复用和默认折叠。新增真实事件驱动的状态：streaming生成中、thinking_end后returned、权威消息后complete、失败error、中断interrupted。body作为region由按钮命名；展开状态不被最终校正和状态更新重置。

原“字”数说明保留为文本长度提示，不改成Token、不换算耗时；只有usage.reasoning提供思考Token，且仅在消息footer展示。错误/中断没有最终content时保留流式节点；补齐了message_end取消pending rAF后尚未绘制的已收尾段，避免丢掉最后一段Thinking/文字。

## 4. 给 Agent C 的结构契约

基础类名全部保持：`.msg.user`、`.msg.assistant`、`.msg-body`、`.think`、`.think-head`、`.think-body`、`.tl-group`、`.tl-group-head`、`.tl-list`、`.tl-item`。

| 新类/属性 | 位置及含义 |
|---|---|
| `.ui2-tool-summary` | `.tl-group > button.tl-group-head`；button type=button，aria-controls/list ID，aria-expanded，aria-describedby/status ID |
| `.ui2-tool-state` | 按钮后的兄弟span，role=status；多工具时保留在折叠区外；单项hidden |
| `.tl-group.is-collapsed` | 已折叠组；真相仍是list.hidden与button aria-expanded |
| `.ui2-msg-meta` | `.msg.assistant > footer`，位于`.msg-body`后；aria-label“本条助手消息用量” |
| `.ui2-msg-meta-item` | footer内span，data-kind取固定字段名；项间有纯文本“ · ”作为无CSS时的可读分隔 |
| `.ui2-think-status` | `.think-head`中的第二个span，状态补充文字，不是token/计时器 |
| `.think[data-state]` | streaming / returned / complete / error / interrupted；可供CSS设置实际状态表现 |

当前按钮继承UI-1的旧div组头样式，浏览器原生button背景/边框仍可见，**不作为最终Claude外观验收**。Agent C应使用已有Token重置button默认外观、校准摘要/状态/元信息字号与间距，保留focus-visible、hidden优先级及原生语义。可用aria-expanded绘制chevron，不要改按钮文字生成数量或在CSS伪造状态。

不改源码布局宽度、scrollBottom的160阈值或全局滚动策略，不加入高级动效。UI-2整体阅读列/间距由Agent C集成处理。

## 5. 测试和真实渲染证据

| 检查 | 起点 | 最终结果及证据 |
|---|---|---|
| `npm run test:ui` | 1338/1338，退出0 | **1338/1338，失败0，退出0**；[smoke.log](ui2a-evidence/smoke.log)、[进程结果](ui2a-evidence/smoke-exit.json) |
| `npm run test:body` | 5/5，退出0 | **5/5，失败0，退出0**；7个分片，2处多字节边界，修复路径替换字符0；[body.log](ui2a-evidence/body.log) |
| `npm run test:quota` | 229/229，退出0 | **229/229，失败0，退出0**；[quota.log](ui2a-evidence/quota.log) |
| `node tests/ui2-classic.cjs` | 新需求首次18/39、21个预期失败 | **48/48，失败0、跳过0，退出0**；[classic.log](ui2a-evidence/classic.log) |
| `node tests/ui2-classic.cjs --electron` | 原生按键夹具修正后运行 | **65/65，失败0，renderer errors 0，退出0；16张截图**；[electron.log](ui2a-evidence/electron.log)、[结构化结果](ui2a-evidence/electron-results.json) |

body/quota/新专项/Electron的实际退出码见 [special-results.json](ui2a-evidence/special-results.json)。保留原smoke/body/quota全部断言，分母未下降。专项覆盖不同助手usage、缺失/零值/畸形值、实时历史一致、单项/多项/跨消息/孤儿工具、运行/失败/取消/中断、折叠状态/焦点/ARIA、Thinking节点复用/异常尾段、tool-only与Thinking-only、错误重试以及HTML/XSS。

补充的异常尾段回归先得到 **47/48、失败1**，修复后48/48；[pending-thinking-red.log](ui2a-evidence/pending-thinking-red.log)保留复现。Electron夹具先等待真实初始RPC历史完成，再注入本次fixture，避免启动重建覆盖测试；原生按钮的CDP按键必须包含Enter/Space字符序列，不能只用无字符keyDown模拟JS监听。

真实Electron为44.4.3。两主题 × 700/900/1200/1536 CSS px × 批次展开/折叠，16张实际capturePage图；每宽验证Enter折叠、Space展开、Tab跳过hidden列表/进入展开列表、Thinking Enter、无页面横向溢出。示例：[dark-1200-expanded.png](ui2a-evidence/dark-1200-expanded.png)、[light-900-collapsed.png](ui2a-evidence/light-900-collapsed.png)。已经目视检查对应场景，但使用的是UI-1 CSS，最终视觉需与Agent C样式合并后再验。

依赖通过本机既有node_modules只读解析（本次设置NODE_PATH），没有npm install或新依赖。测试只使用DOM、离线harness与os.tmpdir用户配置，不依赖真Pi或真模型。

## 6. 未解决问题与集成事项

1. Agent C尚未集成共享样式：批次button默认外观、状态文字/元信息密度和两主题视觉需要最终校准；本轮不越权改styles/tokens。
2. 按并行任务约定未重复完整npm test；package.json不改。集成方将 `node tests/ui2-classic.cjs` 加入canonical链；`--electron`为额外实际渲染专项。
3. 未重建安装产物；**当前变化仅在本Worktree源码版可见**。集成后按AGENTS统一离线构建并验证，不覆盖正在使用的安装包。
4. 没有真模型任务、完整OS DPI/IME、长时性能或Runtime验证；本报告不代表Agent B或整个UI-2完成。
5. 当前协议不能证明的细分工具取消/中断不推断，缺失的历史usage保持省略，不为外观扩大server安全投影。

合并时按实现→测试→文档提交顺序保留变更；新增模块已由messages.js导入，无需改app.js或index.html。不要把footer挪进msg-body而破坏空壳/重试清理判据；不要更改ToolEntry.id、message边界或Git统计回填。回退仅移除本分支对应的展示hunk/新模块和测试，保留其他Agent CSS与Runtime工作，不使用整仓reset/clean。

本轮完成后停止，仅保留本地提交，未push、merge、rebase或进入其他Agent范围。
