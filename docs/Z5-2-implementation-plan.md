# Z5-2 思考等级合同实施计划

日期：2026-10-27。单一执行 Agent；用户已确定合同并授权实施，无额外设计审批。

基线 `11178ac8c696dcc9c3c675522834286f6c530155`，分支 `codex/z5-2-thinking-contract`。
PR #37 未合并；Z5-roadmap/Z5-0-product-audit 在其固定 head
`56c671f565d83b8713dfc695a5777d0f668dd10a` 只读检查，不复制未合并生产实现。

采用小型无 DOM 策略，复用 Classic 的 availability 返回形状与提示。与复制两套判断相比，
共享策略能直接对照；与合并状态管理器相比，保留各自请求和身份生命周期，改动更小。
原生非空非 off 档位可以覆盖静态 false/unknown 的操作判断，不改变 capability 三值。

- [x] 跑四个指定基线套件；新增相同输入合同分歧及读取失败/非法数据红测。
- [x] 新增 `public/thinking-availability.js`：检查模型、pending、readStatus，验证和去重原生字符串；
  通过 `{state,levels,usable,label,detail}` 返回原因。无 HTTP、无 Owner 状态。
- [x] Classic picker 保留兼容导出；composer、rpc setter 和 usage 回读复用纯策略；
  在现有 S 中记录读取状态，模型/会话变化清掉旧证据，不新增状态管理器。
- [x] Runtime Models 保留 full Owner/token 及 ACK+native response 匹配；去除静态 reasoning 门禁；
  pending 禁止重复思考写入，失败不写新值，state/levels 回读验证后才成功。
- [x] 定向测试覆盖静态三值、空/off/非法/重复、失败、ACK、回读、A/B、旧 Owner/generation/token；
  替换旧保守断言时保留同等或更强的三值和原生数据检查。
- [x] 再查 PR #37。若仍未合并，不改 `runtime-conversation.js`，记录 UI/集成/Electron 待办并停止。
  若已合并，先同步最新 main，再做 UI 最小接线与 Z5-1 回归、TEMP fake Pi 正常沙箱窗口验证。
- [x] 离线重建本 Worktree 产物并校验；canonical 留待最终 PR CI（未推送前明确待验证）。
- [x] 自查完整 diff，生成 `docs/Z5-2-acceptance.md`，按功能边界本地中文提交。
  用户要求唯一 Agent，独立复审交用户另行安排；不自动 push/PR/merge/tag/release。

执行结果：PR #37 后续由外部合并，已按条件同步并完成 UI、Z5-1 回归和窗口验证。
完整 canonical 与独立验收保留待验证，详见 [验收报告](Z5-2-acceptance.md)。
