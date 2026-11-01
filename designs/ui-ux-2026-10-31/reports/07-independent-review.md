# 独立审查：交互原型与功能映射

审查日期：2026-10-31。范围：推荐A `exports/workbench/Main.dc.html`，B方向 `exports/reading/Reading.dc.html`，对应画布源文件，及 `reports/05-feature-map.md`。

这是独立只读审查；没有修改原型、启动服务或浏览器，没有操作真实项目/模型/账户。按要求只将审查结论写入本文件。首轮完整审查最多追加一次针对修复增量的复查，不以风格意见延长轮次。

## 最新状态：一次增量复查

结论：**原4项复现路径均已修复，但IR01的停止/重试时序边界仍有1项Important未解决；不据此宣布核心交互验收通过。** 当前未解决：Blocker 0 / Important 1 / Nit 1。首轮历史记录保留下方供追溯。

本次只检查修复增量、原4项与其直接影响状态，没有扩大为新一轮风格审查。A导出SHA256：`a7643bfcee8d631ec9b19cce834b6fc2f63b4d7f2e2753a3e55d83d91984b8f2`。对应画布Main源SHA256：`1e8cfdc9c146fcc1b5c3ef095726adcda9829bc010aacbd483dbd186c0272506`。

| 原编号 | 增量检查 | 结果 / 当前处置 |
| --- | --- | --- |
| IR01 | s4重试后立即切s2，再执行s4完成回调 | 已修复原跨会话路径；s2保持running，s4目标view变chat；同一会话操作token仍有残余，见下 |
| IR02 | 按钮rect锚点与右键指针坐标，1280×800视口夹紧 | 源码/内存计算已修复；普通锚点(300,380)得到菜单(300,386)，右下角指针(1275,795)得到(1048,552)，224×240菜单保留8px边距。真实像素仍由作者窗口验收 |
| IR03 | 菜单项进入Dialog，取消后焦点 | 已修复；110行判断菜单祖先，保存稳定lastTrigger；stub得到triggerFocus=1、inputFocus=0 |
| IR04 | s2停止确认后侧栏与切出切回 | 已修复；119行700ms停止阶段，126行状态从当前/保存view推导；完成后mode=chat、label=刚刚，切回仍chat |
| IN01 | 停止待确认演示 | 已补齐；stopping时发送/输入禁用，草稿保留，主区显示正在停止，700ms后确认 |
| IN02 | 开发进程入口文档 | 待作者将F42同步为工作工具→开发进程；入口未丢失，非阻断 |

### IR01残余：旧重试在停止确认前结束，提前解除stopping

定位：Main导出119行 `send` 停止回调，与141行 `retryError` 完成回调；两者只校验sid，没有互斥的操作token。

可确定的演示时序：

1. t=0，在s4点重试，重试完成定于t=900ms。
2. t=400ms，点停止，进入stopping，停止确认定于t=1100ms。
3. t=900ms，旧重试完成回调仍直接 `setState({mode:'chat'})`，在停止确认前200ms解除保护。

内存虚拟时钟复验输出：`retryDue:900, stopConfirmationDue:1100, before:stopping, afterRetry:chat`。此为首轮IR01建议“停止/重复操作使旧token失效”的同一状态边界，没有新增不相关审查项。建议停止请求使旧重试token失效；重试完成须同时校验目标sid与操作token，不能用sid代替运行身份。

### 增量验证数字与范围

- 实际提取修复后Component运行8项定向逻辑检查：7通过 / 1失败。通过项为跨会话重试、按钮锚点、右下角夹紧、menu→Dialog焦点、停止保护、停止后侧栏、切回停止会话；失败为上述重试与停止回调时序。
- 四份A/B源/导出的Component逻辑：4/4相同。
- `exports/export-manifest.json` 的hash定义由导出脚本核对：sha256是zip，sourceSha256是画布源。A/B zip与source共4/4 hash匹配；未把zip hash误当HTML hash。
- 未启动浏览器/服务、未写真实配置或用户数据。逻辑通过不能代替几何、键盘、DPI与视觉截图验收。
- 已用完约定的一次增量独立复查；后续作者若修复残余须记录其实际复验和最终hash，不能将此快照的结论继承给未审查版本。

## 首轮结论

结论：**不通过核心交互验收，待修复下列4项Important。** Blocker 0 / Important 4 / Nit 2。此结论只针对设计原型可验收性，不表示生产代码产生了回归。

审查时A导出文件SHA256：`443F7ABDD0DC3B53C19CECCFFAEDE31422C40783BFBA3CF4E8E2ED68BAD94EC9`。A/B及两份画布源文件中的 `text/x-dc` 逻辑代码逐字相同，因此下列逻辑问题同时适用于两方向，不能只修导出A。

### IR01 / Important / P1：重试完成回调会改变后来切入会话的运行状态

- 定位：`exports/workbench/Main.dc.html:141`，返回值中的 `retryError`；相关 `chooseSession` 在107行，`remember` 在106行。
- 触发：打开s4异常会话，点「重试」，在900ms演示计时结束前切入s2运行会话。
- 预期：重试完成只更新s4；s2继续保持running，原草稿和运行控件不变。
- 实际代码：重试计时回调直接 `this.setState({mode:'chat'})`，没有captured sid、请求身份或目标view检查。它会更新当前视图，把s2从running改成chat。
- 影响：违反“停止和重试只作用于当前会话”的原型正文与F09/F28/F31/F32的状态归属设计；用户切会话即可观察到后台状态污染。
- 验证：提取原型 `text/x-dc` Component，用最小内存 `DCLogic` stub运行实际方法，手动执行900ms队列回调。输出 `sid:s2, before:running, after:chat`，已复现。没有运行真实业务或浏览器。
- 建议：回调捕获目标sid与操作token，更新目标会话view；当前仍是该会话才同步展示。停止/重复重试应使旧token失效。
- 首轮状态：未解决。增量处置：原跨会话路径已修，停止/重试时序残余仍未解决，见最新状态。

### IR02 / Important / P1：侧栏右键/项目菜单没有锚定触发位置

- 定位：`exports/workbench/Main.dc.html:22` `.pw-menu{position:absolute;right:12px;top:48px;...}`；109行 `showMenu`；41行会话右键/三点与39行项目三点。
- 触发：在侧栏会话行右键，或点项目三点。
- 预期：菜单出现在触发项附近或右键指针处，并按窗口边缘翻转/夹紧；不远离操作对象。
- 实际代码：所有菜单固定在 `.pw-body` 右上方，`showMenu`不读取trigger rect/指针坐标，也不存定位状态。侧栏触发和顶栏More共用相同固定位置。
- 影响：菜单和当前操作对象脱离；高保真原型不能证明“菜单正确定位”，也偏离已有生产 `ui/action-menu.js` 的anchor/flip/clamp抽象。
- 验证：源码链路确定，尚未在浏览器中测量菜单与触发点坐标；浏览器复测需覆盖会话第1/第4行、项目菜单与右边缘More。
- 建议：保留触发点，使用视口或容器坐标换算，区分pointer context与button anchor；布局变化时夹紧或关闭。
- 首轮状态：未解决。增量处置：源码与锚点/clamp逻辑已修复；三尺寸真实几何仍由作者验收。

### IR03 / Important / P1：菜单进入Dialog后无法把焦点还给原菜单触发按钮

- 定位：`exports/workbench/Main.dc.html:110-112`；会话菜单的rename动作130行。
- 触发：用会话行三点打开菜单，选「重命名」，取消或Escape关闭Dialog。
- 预期：返回该会话行三点，或明确的同对象稳定焦点；继续键盘操作无需重新寻找。
- 实际代码：`showDialog`把当前menuitem存入returnFocus，然后设menu:null卸载该item。`closeDialog`发现returnFocus已断开后直接聚焦input，不尝试已保存的lastTrigger。
- 影响：对话框之后键盘焦点脱离原操作对象，不能满足菜单/弹窗焦点恢复设计；现有action-menu/modal已经有可借鉴的生命周期。
- 验证：用真实Component方法与isConnected=false的菜单项、isConnected=true的触发按钮stub复现：`triggerFocus:0,inputFocus:1`。这是逻辑复现，不替代真实Tab顺序验收。
- 建议：保存稳定菜单触发点；Dialog关闭依次尝试仍连接的dialog trigger、menu trigger、同对象行、页面fallback，避免恢复到卸载节点。
- 首轮状态：未解决。增量处置：稳定菜单触发点恢复已修复并经stub复验；真实键盘仍由作者验收。

### IR04 / Important / P2：停止后侧栏仍永久宣称s2正在运行

- 定位：`exports/workbench/Main.dc.html:126` sessions固定数组与color；119行 `send`停止分支；107行会话恢复。
- 触发：打开s2，点方块停止，观察侧栏；切出再切回也可复现。
- 预期：停止后当前内容、侧栏状态与恢复后的状态一致。
- 实际代码：`send`将mode改成chat，但s2的time固定为「运行」、color固定强调色，不读取当前或已保存view。主区已完成，侧栏仍运行。
- 影响：违反操作状态清晰和会话运行态恢复的核心要求；也会让视觉验收截图出现互相矛盾的状态证据。
- 验证：实际Component方法 `chooseSession('s2');send();renderVals()` 得 `mode:chat,rowLabel:运行`，已复现。
- 建议：sidebar元数据从与主区相同的会话view推导；当前和后台会话都使用同一演示事实源。
- 首轮状态：未解决。增量处置：停止后侧栏/恢复状态已修复并经stub复验；真实窗口仍由作者验收。

## 非阻断映射/演示备注

### IN01 / Nit：停止待确认状态尚未体现在原型中

首轮F28写明“停止未确认不解除保护”，但当时119行点击即从running切chat，原型没有stopping阶段。这是演示范围缺口，不是生产stop barrier被修改。增量已补700ms停止待确认阶段，IN01本项已解决；与旧重试竞争的残余单列于IR01，不重复计数。

### IN02 / Nit：开发进程映射位置与原型菜单不同

F42写新入口为会话More；当前131行More无开发进程，133行工作工具菜单包含它。能力未被删除，属于文档入口不一致。采用其中一个位置并同步映射表即可；不建议为凑表在多个菜单复制同一入口。

## 已核对的正向边界

- 页面底栏明确“设计原型·演示数据”“不连接真实项目或模型”；消息、工具命令、Browser、Diff、设置亦有具体演示说明，没有把示例文件当真实仓库改动。
- Main组件未发现调用生产API、fetch/XHR/WebSocket、系统剪贴板、文件下载或文件系统写入；交互只更新内存演示状态。
- 本地React/ReactDOM vendor文件已存在，Main引用相对路径。support.js存在通用CDN fallback与资源fetch代码；当前预加载成功时不进入React下载分支，不能仅因字符串存在就报告“已联网”。完整离线资格仍以实际请求记录为准。
- Runtime附件按钮禁用，并说明未接附件能力；运行中输入禁用。Classic运行中Enter走追加指令，方块键停止，未把Runtime伪装为Classic能力已接线。
- 会话列表由固定数组映射，不依据选中/更新时间排序；rename只改变labels，未改变排列。
- 草稿按sid存于drafts；scrolls与views按sid保存，页面切换不清空；真实浏览器仍需验证scroll事件与重绘时序。
- Dialog有aria-modal和Tab首尾循环，menu有ArrowUp/Down/Home/End；Escape通过根处理关闭并尝试还焦点。IR03指出的是菜单到Dialog的具体缺口，并非声称全局没有键盘支持。
- reduced-motion CSS取消动画/transition；未发现为了演示而触发真实模型、撤销、安装、认证或更新。
- Specs/协同/开发进程占位面板明确说明本轮仅核心原型、完整能力在映射表中，未伪装完整业务已实现。

## 本轮验证记录

1. 逐行阅读Main模板、CSS、全部Component逻辑及相关映射；读取support.js的资源加载边界。
2. 比较A/B两份导出与两份画布的逻辑脚本：4/4相同。
3. 内存逻辑复现3项：跨会话重试、停止后侧栏状态、菜单→Dialog关闭焦点；3/3复现上述问题。此数字是问题复现数，不是产品回归通过数。
4. 未启动浏览器、服务、真实Pi；菜单几何、Tab顺序、DPI、截图与像素布局由作者真实窗口验收补充。

修复后只进行一次增量复查，集中IR01–IR04及其受影响状态；不重复首轮源码审计或追加无关风格建议。

## 作者最终整改附录（不是新增独立复审结论）

独立审查保留上方首轮及一次增量快照，没有要求Agent无限复审。IR01剩余同会话时序已由作者添加每会话操作身份：retry和stop各自取得operation token，stop使旧retry失效；回调只在token仍有效时写其所属view。

`node tools/verify-async-ownership.mjs` 实际提取最终Component、用确定性时钟执行原方法，9/9通过；旧导出8/9，唯一失败正是retry在stop确认前提前解除stopping。最终完整原型280/280，严格细节补测24/24。记录见 `evidence/prototype/async-ownership.json`、`results.json`、`detail-results.json`；源/导出摘要见 `exports/export-manifest.json`。

IR02锚定菜单、IR03菜单到Dialog的原触发器焦点、IR04停止后侧栏状态均已在真实Chromium中操作并截图。F28已经展示stopping等待，F42映射统一为顶栏工作工具→开发进程，避免复制入口。上述为作者整改与复验事实，不把独立增量7/8改写成Agent全通过；末次操作身份修改仍由人工设计验收核对。
