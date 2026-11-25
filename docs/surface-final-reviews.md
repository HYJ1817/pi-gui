# Surface 最终整改：独立发现与处置账本

日期：2026-11-25。基线 `78ca4dcb9dd3e4293e9dcb0f7507a0a6d51d7d5d`；审查对象是其上的本轮工作区，不将基线成功 CI 继承为新代码证明。总体验收、源码/产物身份及最终数字见 [最终验收](surface-final-acceptance.md)。

## 首轮独立结论与最终处置

五个独立上下文实际完成了只读审查，而不是“报告未返回”或“零问题”。原报告留在系统 TEMP；下表归档可复查的发现、边界与最终结果。功能与 UI 两份报告的 Launcher 焦点问题是同一个问题，不重复计算。F1–F6 的修复均由独立上下文在第二轮逐一复现验证，不是作者自证。

| 编号 | 独立发现与复现 | 首轮等级 | 最终处置 |
| --- | --- | --- | --- |
| F1 | `session-changes-panel` 在已有 singleton 再次打开时 mount 被跳过、局部 head 未初始化却继续访问；关闭后残留本次分配的 document listener | Important | 已修复：重复打开不再 mount/重绑，关闭后 mount 作用域残留 0。第二轮探针实测每重复一次增加同一组 5 类 listener，修复后归零；初测的 2 个“残留”实为 `public/ui/toast.js:293` 模块级常驻订阅，与 panel 生命周期无关，已修正口径 |
| F2 | Collab invalid/error 的“重新打开”只激活旧 singleton，open 请求数保持 1，没有执行真正的恢复请求 | Important | 已修复：`openCollabPanel({replace:true})` 先销毁旧 editor/轮询/下载/确认，再重新发起 open；第二轮实测请求数增加、旧状态不残留 |
| F3 | Specs/Changes split 的子工具独立激活后关闭，borrower 关系已丢失，返回 split 时有一半为空 | Important | 已修复：返回 split 时按记录重新借用同一业务 host；第二轮 split 往返无空半区、无幻影状态 |
| F4 | split 的“关闭其它”关闭其子工具，再沿 borrower 递归退役被保留的 split 本身，最终 0 tab | Important | 已修复：批量关闭先保护目标的依赖闭包，被保留的 split 保留其子工具；被保留的借用子工具不反向保护 layout，layout 释放时把子工具归还原独立 tab |
| F5 | Launcher 键盘转换删除原持焦行，或复用工具后把该行隐藏；焦点落 BODY 或留在隐藏 Launcher | Important | 已修复：转换/复用只服务当前用户操作并把焦点交给可见的继任 tab；程序化打开与后台 ensure 不抢焦点，第二轮正向探针确认 |
| F6 | 首次键盘激活懒恢复 tab，`tool.open()` 后提前返回，选中项已变但焦点仍在旧的未选中 tab | Important | 已修复：懒恢复首次挂载后焦点落到选中且可见的 tab；真实 renderer reload + 可信 Home 的截图另有桌面证据 |
| E1 | 大媒体 fixture 将 private grant revoke IPC 的 `ok` 标为 SSE 证明，但该调用没有发布 SSE；独立探针观察到事件回调 0，后续 403 也可能让停止读取断言通过 | Important（验证资格） | 已修复：fixture 走真实 SSE 通道，最终运行 trusted sequence=10、replay=false，停止读取断言绑定在同一撤权事件之后；24/24 通过 |
| P1 | 首轮许可审查时 staging/dist/SEA 的旧 bundle 字节仍实际存在；不是只根据文件时间推断 | Pre-existing，分发阻断 | 最终双重建后复核：public/package 中无 `pptx-preview`，唯一相关依赖为 `pdfjs-dist`；打包 public 与 652 个实际服务文件逐字节一致。残留边界：未对 SEA 内部全部字节做枚举，只覆盖实际服务集合 |
| L1 | PDF 随附的四个 LiberationSans 字体有独立 GPLv2+字体例外原文，来源/源码交付义务尚无充分核验材料；不能由包顶层 Apache 或 PPTX 移除推导分发许可 | 许可待核验，不作侵权定罪 | **已核验定案，阻断解除**（本轮 F9）：实际解析 TTF name 表得 `Version 1.07.4`（非凭字体名推断）；上游 mozilla/pdf.js#21746/#21750 核实为未修改 1.07.4 发布件；1.07.x 适用 GPLv2+字体例外（2.x 起才是 OFL）；随附 LICENSE_LIBERATION 与上游逐字一致。1.07.4 无独立字体源工程，TTF 本身即对应源码，逐字节分发未修改件同时满足 object-code 与源码提供。三项落实义务（不改字节、双份许可文本、不声称 Apache 覆盖）满足。证据链见 [pdf-font-license-verification.md](pdf-font-license-verification.md) |
| R0 | 初始文件树迟到时，历史恢复覆盖刚打开的附件 tab；安全审查在当前与精确基线两个版本都复现 | Pre-existing | **本轮已根因修复**：open-chain spy 定案真实根因为 session 身份 settle 触发的过度 `reset()`（sessionId 在 bridge ready 后异步settle，`onContext` 误判 scope 变化销毁 in-flight open；backend fileId 不含 sessionId，它只是历史命名空间）。修复 `settleSession` 只就地采纳 settle 的 session 并合并历史，真正 workspace/conversation 变化仍全量 reset。打包自然顺序实测 `activeFileTab:guide.md`；files-restore-race 14/14（含三条新 session-settle 回归，revert 后两条变红证非假绿）。独立复审结论见下节 |

首轮合并后为 **6 项功能问题 + 1 项证据问题**，不把历史问题或未知法律结论计成新增产品缺陷。

## 原始可复查材料

以下文件名均相对于 Windows 系统 TEMP `C:/Users/21022/AppData/Local/Temp/`，不含用户数据；只归档文件名以避免把本机链接当成所有 checkout 都可访问的仓库材料：

- `pi-gui-first-round-surface-review-20261125-6c89e4d2.md`；真实 owner 探针 `pi-gui-surface-review-probes-20261125-6c89e4d2.cjs`。探针 12/12 断言用于确认五项缺陷，不是产品正确性通过。
- `pi-gui-ui-review-78ca4dcb-20261125-72e9b220.md`。实际读取 22 张 PNG，并用真实 Files owner 的离线焦点探针复现；未独立重启桌面。
- `pi-gui-review-e72ee96d-security-report.md`。6 套 289/289 定向、两个版本的恢复竞态复现；没有实际浏览器隔离或大型媒体资格背书。
- `pi-media-independent-review-20261125-a45b5.md`、`pi-media-independent-audit-20261125-a45b5.json`、`pi-media-revoke-check-20261125-a45b5.json`。独立确认 360 个不重复 VP8 帧和实际编码载荷，3/3 生命周期定向通过；同时确认 E1。
- `pr112-pptx-legal-review-sgvnsmmr/review-report.md` 和 `audit-evidence.json`。精确 npm tar/上游原文、32 个 package identity、51 件实际许可材料与旧 SEA 完整 bundle 字节均核对；PPTX 20/20、Office 91/91。该审查发生在后续双重建之前，旧产物发现不能直接继承到新产物，也不能不复核就清掉。
- `pi-gui-incr-review-surface-20261125-r2.md` / `.json` 与探针目录 `pi-gui-review-incr-20261125/`。第二轮独立增量审查，确认 F1–F6 并发现 I2-01。
- `pi-preview-desktop-review-report.md`。HTML 读取竞态与桌面就绪判据的独立复核报告。

## 第二轮独立审查

第二轮由独立上下文只读审查本轮修复 diff 与受影响边界，结论：**Blocker 0 / Important 1（本轮新引入）/ Pre-existing 0**。

**I2-01（唯一阻断项，已修复并复核）**：`public/collab-panel.js:94` 的导出文件名清洗正则被改坏 —— 丢失 `'-'` 替换串与 `\\` 转义，同一标题从 HEAD 的 `my doc-v1-…` 变成 `my docundefinedv1undefined…`，而 SVG/PNG 两条导出路径共用这一处计算。它穿过全套绿测试，是因为此前没有任何 canonical 断言导出文件名内容。处置：

1. 该行按 HEAD 逐字节单行恢复（`git diff HEAD -- public/collab-panel.js` 只剩 `{replace}` 与 `reload.onclick` 两处预期 hunk）。
2. 在 `tests/collab-panel-productivity.cjs` 增加阶段 D 断言：拦截真实 `HTMLAnchorElement.prototype.click`，断言 `<a download>` 的文件名逐字符清洗、状态提示显示同一名称、不出现 `undefined`。
3. 换入/换出证明：坏正则下套件 exit 1，实际值 `my docundefinedv1undefined sub\final draft-r2.svg` 与期望 `my doc-v1- sub-final draft-r2.svg` 不等；恢复后 15/15 checks、76 assertions、exit 0。

另两项来自同一报告：

- **F1 口径修正**：模块级 `toast.js:293` 订阅不属于 panel 泄漏；mount 作用域残留为 0。
- **close-others 直指借用子工具**：实现自洽，但该组合此前只有文字契约、没有断言。已在 `tests/surface-tabs.cjs` 补显式契约测试（用当前存活实例，断言子工具保持 current、host 回到 `.rp-body`、layout 正常关闭、单例身份不变）；最终 163/163 assertions、45 类、0 skipped。

**HTML 读取竞态与桌面就绪判据复核**：通过（Blocker 0 / Important 0 / Nit 0）。复核者亲自把修复前 `html.js` 换入工作树，`file-preview-core` 62 tests 中 59 pass / 3 fail（两条目标回归 + restored 测试），恢复修复版后 62/62；边界未放宽：无 sandbox/CSP/allow 相关改动，opaque origin、`postMessage` 的 `origin==='null'`+key 校验原样，nonce 脚本从三个收紧为一个，wall cap 240→480s 仅为 runner 反挂死。

**I2-01 修复与契约断言的增量复核（第三轮）**：通过，0 Blocker / 0 Important / 0 Nit。复核确认清洗行与 HEAD 逐字节一致、两类坏变体都会让新断言失败、close-others 断言与 `secondary-surface.js` 的 rehome 路径逐行对应；其“未运行打包桌面套件”的信息性说明由父任务补齐 —— 最终打包运行 119/119。

## 执行故障与交接（不是审查通过）

2026-11-25，首个媒体/许可标记增量复审与 Surface 修复执行者均被上游接口拒绝：`gpt-6.1-sol requires Responses for tool calls; this account only supports Chat Completions`。前者没有形成最终审查结论；后者留下部分源码修改，但未完成回归交接。接口失败不等于代码测试失败，也不等于发现已消除；以上 F1–F6 / E1 仍须以实际验证处置。

用户随后明确授权“先重试一次，不行用 SWE2.1”。媒体增量复审已按原配置单次重试；Surface 原执行者退出后，已核对已落盘的 session-changes mount/controller、Collab 显式 replace 和 manager 部分焦点/依赖修改，再交 SWE2.1 从当前树接手。没有回退整个工作树，没有两个 Surface writer 并发覆盖。重试或模型切换本身不计审查轮次通过，不继承中断任务的完成资格。

原 `gpt-6.1-sol` 媒体重试在长时间无终局后仍无报告返回，**不按通过计**；本轮另起 SWE-2.1 窄范围复审（媒体 SSE 证据与许可标记），其结果见下节。超时或模型切换不改变证据本身的资格要求。

## 媒体证据与许可标记的最终复审

SWE-2.1 独立增量复审仅检查 E1 与 L1/P1，不重开整套审查。结论：**Blocker 0 / Important 0 / Nit 1（Pre-existing 0）**。

- **E1 证据资格：通过。** 撤权链为渲染进程 `api.revokeExternalGrant` → 生产 `/api/files/grants/revoke` → 服务端 `grants.revoke` + `publish({type:'external_grants'})` → SSE `_seq` 广播；第二个原生 `EventSource` 观察到 `trusted=true, sequence=10, replay=false`。capture 阶段监听先于 Files 自有监听执行，并用 `queueMicrotask` 取 after 快照（微任务先于任何 defer 清理，能识破伪同步）；实测 before `tabPresent/connected/sourcePresent/readyState=4` → after `false/false/false/0`，`mediaErrors=0`、新请求/响应 0，排除 403 回退。revocation fixture 中没有把 IPC `ok` 当 SSE 证据的断言。
- **暂停空闲断言：通过。** `paused/readyState=4/buffered[[0,30]]` 覆盖当前时间，backend `active=0`（opened 63 = closed 63），readCalls/actualBytes/requests 三键在观察窗不变；setup seek 到 duration−2 只是准备，明确注释非原生输入证据，0.73/0.23/0.88 三条可信拖动证据独立存在（decodedFrames 增量 15/15/14）。
- **L1：仍待核验，保持发布阻断（该轮时点结论）。** `legalReviewRequired` 逐字保留 `pdfjs-dist Liberation fonts: source-distribution obligations remain unverified (GPLv2 with font exceptions)`，vendor 30/30 测试锁定该警告、四字体清单、`sourceDistributionVerified=false` 与 `copied` 状态；生成器明示“生成不等于再分发批准”。但字体 GPLv2 源码分发义务本身仍未核验，任何桌面/打包/单元绿灯都不构成许可通过。**【本轮后续已结】** 该阻断在之后的 F9 核验中定案解除，证据链与最终结论见首节 L1 行与 [pdf-font-license-verification.md](pdf-font-license-verification.md)。
- **P1：证据资格通过（含残余边界）。** `package.json`/`package-lock.json` 中 `pptx-preview` 出现 0 次；source、`build/electron-app/public`、`dist-app` 三棵树各 652 文件逐字节一致，三树均无旧 `pptx-preview.js` 与旧许可目录；SEA 对 652 个文件逐一 HTTP 抓取并比对 sha256；`build/Pi GUI.exe` 与 `dist-app` exe 的 sha256 与 summary 工件逐字节相同。**残余边界**：未对 117 MB exe 内部做逐字节静态枚举，只能证明“被服务的字节全部正确”，不能证明 exe 内不存在不被服务的旧死字节。
- **Nit（不阻断）**：`large-media-main.cjs:256` 的 `boundary`/`revocationBoundary` 为英文、与报告其余中文注释风格不一；不影响证据效力，本轮不改。

## 第三轮 office/scanner 复审与 startAt 修复

由独立上下文（星驰）复审 office scanner 修复 diff（`f3ec0982..HEAD`）。结论：**不通过**，Blocker 0 / Important 1 / Nit 0。

**唯一 Important（已修复并经定向复核）**：`startAt="0"` 在投影（`pptx-shapes.js`）被接受为 `start=0, explicitStart=true`，但渲染（`office-slides-frame.js`）用 `start || 1` 把 0 坍缩成 1 —— 投影值与渲染值不一致。处置：投影改为 `start = Math.max(1, parsed); explicitStart = true`（ECMA-376 `ST_TextBulletStartAtNum` 范围 1–32767，0 是非法但已写出的重启意图；LibreOffice 导入源码同样钳 <1 为 1）。新增回归锁 `startAt=0 clamps to a restart at 1 and keeps projection and render in agreement`：构造 `startAt=4 / startAt=0 / 续号` 三段，断言投影 `start=1/explicitStart=true` 且真实 frame 渲染 `4.,1.,2.`。

**定向复核（星驰，0/0/1）**：投影与渲染已一致；通过 Node 模块加载 hook 仅内存中去掉钳制后回归锁变红（49/1、退出码 1、唯一失败即新用例的投影断言 `0 !== 1`），证明非假绿；全仓搜索未见第二个仍把 0 当独立合法起点的实现。**残余边界**：PowerPoint 桌面应用对 startAt=0 的实际行为未验证、LibreOffice 桌面对该夹具的实际显示未验证 —— 源码证据不冒充应用实测；钳制是可辩护的只读预览选择，不能宣称所有办公软件都如此渲染。Nit（回归注释曾误述旧续号会重置，实际旧 renderer 已是 4→1→2）已收窄为「投影起点与渲染起点不一致」，非阻断。

**复审确认的 scanner 边界核验**（沿用第三轮结论）：`Ex&#9;ternal` 字符引用经 XML 属性值规范化后仍是制表符，DOMParser 与 scanner 一致读到 `Ex\tternal`，闭合枚举拒绝，不构成绕过；`sldSz` 名称匹配正确挡 `<sldSzX>`/`<a:p:sldSz>`；注释/CDATA/PI/DTD 词法边界未发现扫描绕过。悬挂缩进 cap 分支（`-indent > marL`）与 PowerPoint 的几何对照未验证。

## Surface 打包场景期望值修正（非产品缺陷）

最终打包桌面验收首跑 99/104，5 项失败全部集中在 Surface Launcher tab 计数。独立诊断（星驰，含 jsdom 内存追踪实测 Specs→`+`→Escape 标签数 1→2→2）结论：**未发现 `secondary-surface.js` 存在独立产品缺陷**。

- 「独立 Launcher 共存」「键盘重排」「Delete 关闭」三项是同一个陈旧「三标签」假设的断言错误及其级联：tabless 空态 Launcher 按设计不产生 tab 记录（`presentEmptyState` 不创建 record，`secondaryTabs()` 只投影 `tabs` 数组），close-all 后两次 `+` 正确数量是 **2** 不是 3。重排断言曾构造含第三个 `null` 的三元素数组，即使重排完全正确也必失败；Delete 后正确剩余 1 不是 2。
- 「Launcher Escape」一项：确认场景存在 toggle 驱动错误（close-all 后面板已开，再点 `#btnWorkPanel` 反而隐藏）；`tabCount:1` 的精确成因本轮用 escape-probe 实测定案 —— specs 行的可信点击是异步派发的，原驱动在点击效果落地前探测 tab 条，偶发读到 0 个 specs tab（`escape-probe-after-specs-click` 为 `[]`），即 specs 根本没打开，与 Launcher 去重或 Escape 删除标签无关（两者均被证据排除）。属场景驱动的输入同步缺陷，非产品缺陷。

处置（全部为场景驱动修正，不改产品）：`#btnWorkPanel` 裸点击改为幂等 `ensurePaneOpen()`（仅在面板确实关闭时才调用 toggle）；「三标签」计数更正为 2 并同步修正重排/Delete 的级联算术；specs 行点击后等待 specs tab 实际挂载再探测。产品契约单测 surface-tabs 174/174、surface-lifecycle 257/257 全程保持绿色，从未因这些场景失败而变红 —— 进一步印证失败在场景驱动层而非产品层。

## R0 恢复竞态的根因定案与修复（本轮最重要发现）

上述 Launcher 计数失败确为场景驱动层问题，但 **`open-guide.md` 在 close-all/reopen 后反复超时是真实产品缺陷**，与场景驱动无关。首轮诊断曾把它与 Launcher 计数问题一并归为「非产品缺陷」并不准确；本轮按其「不要用没观察到推断不存在、记录结构化运行轨迹而非增加等待」的方法论要求，注入运行时副本的 open-chain spy（只改 `world/application` 一次性副本，产品与字节验证树不受影响），捕获到决定性轨迹：

```
mount:init    mountSess=""   mountConv=null          ← 面板以空 sessionId 挂载
vis:fire      bumped=false                            ← 可见性注册是 no-op，不是元凶
ofr:entry     path=guide.md  openSequence=0
reset:fire    beforeSess="" afterSess="8d2c903d-…"  beforeCwd==afterCwd  beforeConv==afterConv==null
ofr:metaDone  ok=false scopeOk=false seqMatch=false   ← open 被 reset 销毁
restore:choose  chosen=long-lines.js                  ← reset 重新触发恢复，选了历史活动 tab
```

**根因**：`files-panel.js` 的 `onContext` 只要 sessionId 变化就调用 `reset()`（`scopeEpoch++/openSequence++/cancelMetadata()/tabs=[]` 四连，销毁全部 tab 与 in-flight open）。但 sessionId 在 bridge ready 后**总是异步settle**（`app.js:490-492` 注释明确"bridge ready 可能先于会话身份到达"），于是从空 sessionId settle 到真实 UUID 时，用户已经开始的 open 被无故销毁。关键安全事实：`server/files.js` 的 `fileIdFor` hash 只覆盖 `workspace.id + conversationId + 路径 + 文件身份`，**不含 sessionId** —— 文件访问绑定是 cwd+conversationId，sessionId 只是 `readFilesState`/`writeFilesState` 的 per-session 历史命名空间，不是访问边界。因此 session-only settle 销毁 open 既不必要也不正确。这不是 fixture 假象：任何真实会话在面板挂载后身份settle都会命中。

**修复**（`settleSession`）：`onContext` 现在区分两类变化 —— cwd/conversationId 变化（访问绑定变化）仍走全量 `reset()`；仅 sessionId 变化（`sameWorkspace` 为真）则就地采纳 settle 的 session（不 bump scopeEpoch/openSequence、不 cancelMetadata、不清 tabs），并按新命名空间合并该会话历史。`sameWorkspace` helper 加在 `files-state.js`（只含 cwd+conversationId，与 backend 访问绑定一致）。

**验证**：files-restore-race 新增回归，套件最终 19/19；灵敏度双向证明 —— revert 修复后目标测试变红、安全对照（真正 workspace 变化仍销毁）仍绿，证明非假绿。最终干净打包运行在自然 close-all/reopen 顺序下 `layout-after-open` 实测 `openError:null、activeFileTab:guide.md` —— 用户的排队打开在 settle 中存活并成为活动 tab。

**第一轮独立复审（星驰）**确认安全方案成立（backend fileId 不含 sessionId 的核验无误），但正确性验收暂不通过，发现 1 个本次引入的 Important 与 2 个既有未覆盖分支，均已处置：

- **Important（已修复）**：首版 `settleSession` 只消费 tabs、丢弃 tree 状态（hidden/expanded/selection），保留空 session 默认树，随后持久化会覆盖目标 session 的树偏好。修复为 `settleSession` 调用 `installTree(restored?.tree)` —— 与 `reset()` 一样应用目标 session 的树状态，但不做 reset 的破坏半；tabs 恢复留在 onRoot 延迟合并路径。内存对照验证 settle 后 hidden toggle `aria-pressed=true`、根 listing hidden 参数 `[false,true]`，与复审者 HEAD 对照一致。
- **P1 既有分支（已修复）**：`closeTabs` 原来 `if (restored)` 才记 tombstone，空 session 下 `restored===null` 漏记，settle 复活用户已关闭的文件。修复为无条件记录 tombstone（只过滤 restore 合并、不影响显式 open），并验证复审者给的精确场景（目标历史 [a,b]、空 session 开 a 又关、settle 后 a 不复活、b 合入）。
- **P2 既有时序（决策不修，记录为残余边界）**：`session-evidence-context` 通知先于 `S.state.sessionId` 写入到达的排序下，in-flight open 仍可能被 scopeCurrent 丢弃。曾尝试在 `usage.js applyState` 落地后补发通知，但打包验收发现其导致 surface-launcher 的 specs 在打开中被退役 —— 因为 surface scope（`app.js:302`）**包含 sessionId**，补发的通知触发 `syncSecondaryScope` 的 surface 级 reset。该 broader 修复副作用大于收益（P2 非新越权、core 竞态已修复），故 revert usage.js，P2 作为残余边界如实记录。

新增 5 个 settle 回归测试（tree 状态 / 空 session tombstone / 合并去重 / in-flight 存活 / cwd-only 失效）使用生产 mount 形状（空 session 挂载、目标历史预置、含 tree 状态），灵敏度经 revert 验证。

### 第二轮独立复审（星驰）结论与处置

第二轮复审确认原 Important（目标 session 树状态丢失）与 P1（空 session tombstone）**均已修复**，但发现首版修复引入 1 个新 Important：**`installTree(restored?.tree)` 无条件重建树，会覆盖用户在 settle 前已做的树操作**；目标 session 无快照时甚至装回默认树。复审者用真实 `mountFilesPanel` + 纯内存 transport 独立复现：空 session 挂载、目标无快照、用户开「显示隐藏项」后 settle，`aria-pressed` 从 `true` 被回拨成 `false`。这不是真实 workspace 切换，却撤销了用户刚做的选择。

**根因**：`hidden` 这类布尔偏好里 `false` 既是「未碰过的安装默认」又是「用户明确关闭」—— 仅靠值无法在合并时区分二者。修复因此分两半：

- `files-tree.js` 增加**逐字段 dirty 追踪**（`touched` 集合）：只有真实用户手势（点击 hidden 开关、展开/收起目录、滚动）才标记对应字段；程序化的 `reveal`/`expandPath`/`select` 不标记。`touched` 经 `getState()` 暴露，是瞬时合并元数据 —— `files-state.js` 的 `project()` 持久化时只取 `expanded/selected/scrollTop/hidden` 四个已知字段，`touched` 不落盘。
- `settleSession` 改为 `mergeTreeState(liveTree, restored?.tree)`：先 capture 旧树 dispose 前的 live 状态，**用户碰过的字段一律以 live 为准**（回拨它们等于撤销一个刻意手势），**未碰的字段回落到快照**（这样目标 session 的真实偏好仍被采纳，原 Important 不回退）；目标无快照时保留 live 原样；expanded 取并集（展开状态保留两份都不具破坏性）。

**三态验证**（真实 `mountFilesPanel` + 内存 transport）全绿：

| 场景 | settle 后 hidden | 判定 |
|---|---|---|
| 无快照，用户开 hidden | `true`（用户手势存活） | ✅ |
| 快照 `hidden:true`，用户**主动关掉** | `false`（dirty 胜出，快照不复活） | ✅ |
| 用户完全没碰，快照 `hidden:true` | `true`（采纳快照，原 Important 不回退） | ✅ |

**灵敏度证明**：把 `hidden` 合并临时换成朴素 `live||snap`，restore-race 立即 21/22 —— 「主动关掉」用例精确变红；还原正确实现后回到 22/22。回归锁有真实的牙，非假绿。

**测试**：restore-race 增至 **22/22**（新增 3 条合并回归锁：无快照保留手势 / dirty-off 胜过快照 / 未碰仍采纳快照），files-surface-lifecycle 13/13、file-preview-core 62/62、file-preview-panel 70/70、surface-tabs 174/174（47 类）全绿。

复审者另确认两项既有事实**不构成本轮阻断**：(1) 目标历史存在待合入标签时，当前预览会经 `restoreTabs → activate(当前 key)` 重挂载 —— 分类为 **Pre-existing**（基线 `restoreTabs` 本就有此重激活路径，非本轮 `installTree` 新增），故验收文字收窄为「活动标签未变」而非「预览实例未变」；(2) P2 决策（撤回 usage.js broader 通知、暂缓）**可接受但理由收窄** —— surface scope 含 sessionId 的退役在真实 session/owner 变化时是**正确行为**，不能仅凭 Specs 被退役就反证补发通知为错；复审者提出更窄方向（让 Files 在已确认的当前 Classic owner 可用时采用其 sessionId，处理「owner 已定、state 投影迟到」的窄边界，无需全局通知），作为**建议方案**记录，不计入本轮已完成修复。

## 模型偏差披露（如实记录）

本轮 F1–F3 与 F8 的两份独立复审**实际运行在 devin/swe-2-1**，而非用户指定的星驰 gpt-6.1-sol —— 系委托时模型选择错误，发现后已取消并以正确模型重发。为不影响证据有效性，该两份报告的结论仍按实际运行模型如实标注；后续的第三轮 office 复审、startAt 定向复核与 Surface 场景诊断均已在正确的星驰 gpt-6.1-sol 上完成。模型偏差不否定已验证的发现本身，但读者应知晓审查者身份与最初指令不一致。

## 当前结论

F1–F6、E1 已由独立上下文复现确认修复；第二轮唯一新引入的 I2-01 已修复并通过第三轮增量复核（0/0/0）；HTML 竞态、媒体 SSE 证据与旧 PPTX 产物边界均经独立增量复审通过（分别 0/0/0 与 0/0/1 非阻断 Nit）。本轮新增：office scanner 第三轮复审的唯一 Important（startAt=0 投影/渲染不一致）已修复并定向复核通过（0/0/1）；F9 字体许可已核验定案解除 L1 阻断；Surface 打包场景失败定位为场景驱动层陈旧期望，非产品缺陷，已修正。定向与相邻 canonical、源码桌面、真实大媒体均有最终通过记录。**仍在的边界**：R0 为预先存在的恢复竞态（本轮打包已含其生产环境回归证明），单独跟踪；PowerPoint 对 startAt=0、悬挂缩进 cap 分支的桌面应用实测未验证；P1 的 SEA 内部字节未全量枚举，只能证明实际服务集合；完整 canonical 依用户选择交由当前 PR CI，未完成前是待验证。用户仅授权提交、推送并更新既有 PR #112，未授权合并、tag 或发版。
