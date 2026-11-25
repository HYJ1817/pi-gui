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
| L1 | PDF 随附的四个 LiberationSans 字体有独立 GPLv2+字体例外原文，来源/源码交付义务尚无充分核验材料；不能由包顶层 Apache 或 PPTX 移除推导分发许可 | 许可待核验，不作侵权定罪 | 保持发布阻断：生成器继续输出显式警告 `pdfjs-dist Liberation fonts: source-distribution obligations remain unverified (GPLv2 with font exceptions)`，不删除字体、不改写许可原文；本轮不结案，也不计为新增产品缺陷 |
| R0 | 初始文件树迟到时，历史恢复覆盖刚打开的附件 tab；安全审查在当前与精确基线两个版本都复现 | Pre-existing | 不混入本次修复；打包桌面场景的组顺序明确避开该已知竞态，不把它当作 common-maximize 布局验收的失败或通过 |

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
- **L1：仍待核验，保持发布阻断。** `legalReviewRequired` 逐字保留 `pdfjs-dist Liberation fonts: source-distribution obligations remain unverified (GPLv2 with font exceptions)`，vendor 30/30 测试锁定该警告、四字体清单、`sourceDistributionVerified=false` 与 `copied` 状态；生成器明示“生成不等于再分发批准”。但字体 GPLv2 源码分发义务本身仍未核验，任何桌面/打包/单元绿灯都不构成许可通过。
- **P1：证据资格通过（含残余边界）。** `package.json`/`package-lock.json` 中 `pptx-preview` 出现 0 次；source、`build/electron-app/public`、`dist-app` 三棵树各 652 文件逐字节一致，三树均无旧 `pptx-preview.js` 与旧许可目录；SEA 对 652 个文件逐一 HTTP 抓取并比对 sha256；`build/Pi GUI.exe` 与 `dist-app` exe 的 sha256 与 summary 工件逐字节相同。**残余边界**：未对 117 MB exe 内部做逐字节静态枚举，只能证明“被服务的字节全部正确”，不能证明 exe 内不存在不被服务的旧死字节。
- **Nit（不阻断）**：`large-media-main.cjs:256` 的 `boundary`/`revocationBoundary` 为英文、与报告其余中文注释风格不一；不影响证据效力，本轮不改。

## 当前结论

## 当前结论

F1–F6、E1 已由独立上下文复现确认修复；第二轮唯一新引入的 I2-01 已修复并通过第三轮增量复核（0/0/0）；HTML 竞态、媒体 SSE 证据与旧 PPTX 产物边界均经独立增量复审通过（分别 0/0/0 与 0/0/1 非阻断 Nit）。定向与相邻 canonical、源码桌面、正式产物桌面、真实大媒体均有最终通过记录。**仍在的边界**：R0 为预先存在的恢复竞态，单独跟踪；L1 的字体源码分发义务未结案，保持发布阻断；P1 的 SEA 内部字节未全量枚举，只能证明实际服务集合；完整 canonical 依用户选择交由当前 PR CI，未完成前是待验证。用户仅授权提交、推送并更新既有 PR #112，未授权合并、tag 或发版。
