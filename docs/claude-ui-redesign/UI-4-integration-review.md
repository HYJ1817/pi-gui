# UI-4 集成审查记录

本记录区分输入分支发现的问题与最终验收结果；最终状态以 UI-4-integration-acceptance.md 为准。

## 输入交付

共同基线 `17f855f01fedb7b13a13496ba45ebf8d28e465ac`。A/B/C 的 clean 状态、merge-base、提交链与变更清单见 `ui4-integration-evidence/preflight.json`。

| 分支 | 已核实最终提交 |
| --- | --- |
| codex/ui4-pane | a097b17b26a8a3c6944c6ff2aae401349ee635f1 |
| codex/ui4-approval | c2b1044d40aea61f066bfa4845909c266e0f53be |
| codex/ui4-feedback | 8679740192b39875b08232adf82439307d0aefd0 |

## 审批与弹窗

独立审查输入 B 的 `public/ui/modal.js` 与 `public/approval.js`，并用实际模块的异步 fixture 复现：

1. 旧 confirm 的 onDecide 迟到返回后，调用共享 closeConfirm；它只检查层是否隐藏，不能证明仍是原实例。旧 Allow/Deny 经 Stop、过期、工作区、会话、Bridge 或超时失效，再打开新审批时，旧成功可能结算新 Promise 并触发新请求的决定。
2. 普通弹窗的 build 接收全局 closeModal，`card.isConnected` 不能鉴别复用的 `#modalCard`。旧 select 成功能关闭无关的新弹窗。
3. `api.js sendJSON()` 的 network:true 覆盖 fetch 与 JSON 解析异常。JSON 丢失可能发生在后端已写入 stdin 之后，因此不能断言“没有送达”。Classic 路由没有 Runtime approvals Map 的单次响应去重；不确定时再次允许/拒绝/取消可能形成相互矛盾的决定。
4. 输入 B 的“后端明确拒绝”可以重试；其“网络层失败必定未送达”的断言则不符合真实代码路径。需保留原用例数量、改为严格验证未知与锁定，并另设明确拒绝后的重试用例。

计划边界：每实例关闭与异步校验；投递结果未知只允许本地关闭，不自动补发取消；生命周期后的结果不影响新表面。HTTP accepted 仅证明后端接收并写 stdin，不能证明 Pi 已执行决定。Stop 不能撤回已经发出的决定。

## Runtime 接口取舍

不把 B 的 `renderRuntimeApproval()` 接入生产。现有控制器在 busy/disposed 等情况下也可能返回 null；新 renderer 会把这些全部解释为 owner 已切换。Runtime store 也不提供足以重建 Classic 正文的隐私字段，不扩大投影。

保留现有 renderer，使用新 CSS。另已复现既有显示问题：同一 conversation 换 owner 后，旧审批失败可写入新 owner 的 notice。仅为 extension_ui_response 的异步结果增加显示前 owner 对照；不改变 store、owner、revision、sequence、readback、请求 payload 或权限判定。普通 Runtime modal 的权威 refresh 必须继续执行。

## 本会话变更

输入 A `workspaceMatches()` 的缺省分支只判断 workspace 缺失，未限制 Classic 和事件身份缺失；`!event.detail` 还绕过校验。复现了 Runtime 无 owner 被 Classic 无身份事件失效、Classic/Runtime 无 owner 匹配明确 foreign 工作区。收紧仅限 Classic 且双方缺少工作区维度的局部失效，不改变 P33 资格。

`clear()` 未去掉 aria-busy。证据变化或会话切换取消查询后，serial 正确挡住迟到结果，但 loading 辅助状态永久保留。应在 clear 同步清除。

## Process 整文件对照

独立对照基线与 A 的实际 diff，未发现 transport 或权限扩展。generation/revision/cursor/workspace、1 秒轮询、串行 loading、dispose、stop/restart 参数保持原义。新增 fixture 验证以上行为以及日志 256 行/65536 字符边界、迟到结果和不可信 HTML 文本渲染，4/4 通过。此证据不能替代真实 OS 进程停止验收；由既有 Runtime Process 与 Electron 套件补足。

## 通知

输入 C 的 Toast 去重只按 kind/text，跨工作区相同错误可能被吞；Notice 相同签名只比较文字，会保留过期的 handler。Toast pointerleave 也会在按钮仍有焦点时恢复计时。需添加只读展示上下文、更新同上下文 handler 而保留 DOM/focus、合并 hover/focus 暂停条件。旧持久错误应保留为此前会话通知并使动作失效，不能伪称成功或吞掉新错误。

Toast 的堆叠上限还需遵循已有 Composer 实际顶边，在真实 Electron 中验证；不建立新的 Composer 高度事实源。ResizeObserver 必须实测回调与稳定后几何，不屏蔽异常。

## 已保存的修复前证据

`review-red.log`：30 项中通过 4、失败 26、跳过 0，退出 1。

`review-red-expanded.log`：39 项中通过 4、失败 35、跳过 0，退出 1。后续增加同 owner 正向对照与权威刷新断言，最终计数另报。这些测试从输入工作区只读打包模块，不修改其文件，不使用真实用户会话或真实 Pi。
