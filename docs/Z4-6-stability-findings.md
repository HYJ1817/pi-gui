# Z4-6 稳定性发现与处置

所有写入验证均使用 TEMP 合成项目/应用数据。基线 `d919fc9`；没有更改 Pi、Owner authority、CAS、事务、图形协议、依赖版本或 Electron 安全设置。

## F1：慢响应使建议轮询饥饿（已确认产品缺陷，已修复）

- 位置：`public/collab-panel.js` 的 `pollStatus`。Runtime 正常沙箱真实窗口复现：HTTP 返回 ready，generation 与 head 均含合法 proposalId，但没有 preview 请求，界面停在已保存；当状态查询超过 1500ms，每次新 interval 都推进 pollSequence，上一请求被当作过期丢弃。
- 最小复现：`tests/collab-panel-agent.cjs` 新增慢请求场景；测试 interval=10ms、响应延迟40ms，500ms 有界等待。修复前未显示“慢响应建议”，退出1；修复后显示且峰值在途查询=1，9/9，退出0。
- 最小修复：面板局部 `pollPending` + finally 释放。仍保留上下文签名、pollSequence、同步失效和 busy 门控。没有放宽 Owner/CAS 或接受条件。
- 实窗复核：生产后端/renderer/Runtime Registry + fake Pi 正常 sandbox **55/55**；Classic/Runtime 建议均经过预览及明确接受，进程残留0。

## F2：面板销毁遗留下载释放定时器（已确认产品缺陷，已修复）

- 位置：`public/collab-panel.js` 的 `scheduleRevoke/revokeDownloads`。旧代码只清空 URL Set 并 revoke URL，没有保存和取消60秒 timeout，反复开关导出面板会暂时保留已销毁面板的闭包。
- 红态：`tests/collab-stability.cjs` 第一轮导出/销毁后，URL已释放但残留 timeout=1（预期0）。
- 修复：Map 保存 URL→timer；失效/销毁先 clearTimeout 后 revoke；自然到期仍只释放一次。
- 绿态：40轮面板挂载、SVG导出、交替会话失效和销毁，URL/timeout/interval/被跟踪的文档生命周期监听器每轮均归零。不是对所有浏览器内部资源的枚举，也不等于长期内存资格。

## F3：合法大跨度图导致巨额 PNG 分配（已确认产品资源边界缺陷，已修复）

- 位置：`public/collab-export.js`。坐标协议允许±100000，默认scale=2。历史生产力夹具撤销回跨度约17452×11960的图后，PNG尝试约835百万像素（仅RGBA约3.34GB）；实窗未产出PNG，夹具超时。旧默认renderer直接分配canvas，无像素/边长预检。
- 红态：合成边界文档在替换的 createObjectURL 被调用前没有拒绝，得到 png-render-failed（预期 png-size-limit）。
- 修复：PNG分配前限定单边≤16384、总像素≤16Mi、实际宽高≥1。只限制光栅资源，SVG仍可导出完整合法图，文档坐标/schema不变。16Mi像素约64MiB原始RGBA，并非总进程内存上限。工具条明确提示先自动整理或导出SVG。
- 绿态：无Blob/Image/canvas分配；实窗先验证大图明确拒绝，再显式整理后使用默认renderer导出PNG及连续20次导出，检查魔数、IHDR尺寸、原文档与URL释放。生产力专项35/35。

## T1：生产力 Electron 夹具入口/脚本错误（测试夹具缺陷，已修复）

- `tests/fixtures/z4-4b-productivity-electron.cjs` 用 require.main===module 作入口判断。最小真实Electron44.4.3探针返回 `{type:"browser",mainIsModule:false}`；原入口不执行，runner在180s超时。改为 process.type==='browser'，与既有高级编辑夹具一致；Node require 导出的静态服务仍不启动窗口。
- 进入场景后两段 executeJavaScript 裸await不能执行，改为async IIFE，保持原SVG断言。
- 两个runner现支持本轮独立证据目录、传递已有离线dist覆盖参数，启动/断言失败也进入finally清理自有TEMP和仍在运行的子树；清理路径先验证在TEMP内。未修改CI、未加no-sandbox。
- 原有SVG、布局、撤销、PNG魔数与尺寸断言保留。增加超大PNG拒绝及循环回收断言，未为了通过删除断言。

## E1：历史共享 Electron 运行目录失败（环境相关；根因未完全确定）

- 历史文档记录0x80000003及退出3，只能证明当时那条运行路径失败。本轮主工作区node_modules为空，首次定向测试在jsdom缺失处中断；独立Worktree执行锁定依赖的 `npm ci --offline --no-audit --no-fund` 后恢复。
- 新目录Electron44.4.3 `--version`退出0；exe SHA256 `bf0fe749904ca9f713ccfb2427c519fa39d0bbd0337ba411ba08785802e8d548`，与历史G2记录一致。当前正常sandbox窗口实测通过，不能沿用“当前Agent禁止一切Electron”结论，也不能据此断言旧目录根因已修复。

## U1：独立一次 native capturePage UnknownVizError（尚未确定）

- 修复轮询前的一次诊断运行已通过Runtime生成/接受/恢复，但在原生Browser导航后截图处出现UnknownVizError；无renderer console error。后续未更改截图代码、未重试截图、未降低sandbox，完整55/55通过。
- 仍保留首次失败，不把单次重跑通过写成根因修复；本轮没有定位Chromium内部Viz原因。普通终端若再次触发，应保留run目录、进程/版本/窗口尺寸/系统事件证据，独立复验前仍为剩余风险。

## U2：基线 CI 与 canonical（独立于本轮代码）

- PR34第一次attempt的core在 `tests/ci-results.cjs` 的 kill witness 等待超时；gate记录79叶通过、1叶失败、140未执行。证据：[run 40278098767](https://github.com/HYJ1817/pi-gui/actions/runs/40278098767)。
- 本轮只读查询时该run已由外部发起attempt5；本Agent未触发重跑、未修改workflow或gate。收尾attempt5已成功，220/220；artifact checkout是临时merge 1a813c3，与d919fc9和真实merge adbff9d的文件树一致，具体核对见验收报告。旧attempt的其他成功job不得拼成新attempt完整证明。
- 最终完整canonical依任务书留最终PR CI；本轮定向测试不代替完整证明。
