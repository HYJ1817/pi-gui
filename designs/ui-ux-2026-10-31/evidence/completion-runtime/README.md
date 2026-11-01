# Runtime Refined 补齐证据

本目录绑定 `8908ff5` 后的当前未提交实现。最终源码摘要见 [results.json](results.json)；根 Agent 负责最终集成、独立审查与重建。

## 实现范围

- 复用原有 owner-scoped Models 控制器，Runtime 独立的可见模型/思考 chips 只投影原生确认值，不接入 Classic 的全局模型状态。
- 菜单支持模型/Provider 文案搜索、方向键、Enter/Space 单次选择、Escape 返回触发器及 Tab 离焦关闭；捕获会话、focusEpoch 和完整 Owner，失效选项不能对当前另一会话提交。
- 原生 select 仅保留为同步实现控件，`hidden`、`tabIndex=-1`、`aria-hidden=true`，不产生重复可交互入口。
- 底部 composer 保留原 textarea 节点、草稿协调器和发送/停止处理；沿用 760px 阅读轴、15px 正文、18px composer 设计 token。
- 实时输出继续是一份可信的助手输出，不猜测回合或角色。Markdown 复用原有 escape-first `md()`；历史仅使用后端已有角色/消息定位，用户正文保持纯文本；Viz 来源 wrapper 保留。
- 菜单优先位于整个 composer 上方，受真实 viewport 约束；层级50低于 modal60/confirm70，无装饰箭头。

## 最终验证

七套源码回归 **430/430**，均 exit0、无删减旧断言：

| 命令 | 结果 |
| --- | ---: |
| `node tests/runtime-finish-ui.cjs` | 48/48（34→48） |
| `node tests/runtime-conversation.cjs` | 106/106（104→106） |
| `node tests/runtime-models.cjs` | 52/52 |
| `node tests/runtime-draft.cjs` | 42/42 |
| `node tests/ui2-runtime-display.cjs` | 82/82 |
| `node tests/viz-ui.cjs` | 66/66 |
| `node tests/thinking-availability.cjs` | 34/34 |

Owner退役时 `models.get()` 返回null触发既有解构错误，见 `retired-model-red.log`；最小修复只在视图调用处回退空对象，不改控制器或模型协议。新增行为先红后绿：原生表单/旧 pre 缺口见 `red-finish-ui.log`、`red-conversation.log`；Enter 单次激活见 `keyboard-enter-red.log`；整个 composer 上方定位的实测旧几何失败见 `composer-anchor-red.log`。

真实 Electron 采用现有 `tests/runtime-electron.cjs` 的新可选 `P32_REFINED_RUNTIME=1` 模式，保留原默认完整场景。最终 **168/168**、exit0、normal sandbox、contextIsolation=true、nodeIntegration=false、renderer errors=[]，**24张真实截图**。

运行环境：TEMP Git、真实 production server/renderer/preload、fake Pi；仅 loopback 网络，未调用真实模型。PowerShell 环境参数：

```powershell
$env:P32_REFINED_RUNTIME='1'
$env:P32_RUNTIME_EVIDENCE='C:\pi-GUI\designs\ui-ux-2026-10-31\evidence\completion-runtime\native-20261101-final-owner-retirement'
$env:PI_GUI_OFFLINE='1'
$env:PI_OFFLINE='1'
node tests/runtime-electron.cjs
```

最终证据仅使用：

- [实际运行日志](native-20261101-final-owner-retirement.log)
- [窗口报告](native-20261101-final-owner-retirement/p32-4/refined-report.json)
- [24组实测几何](native-20261101-final-owner-retirement/p32-4/refined-geometry.json)
- [浅色1440模型菜单](native-20261101-final-owner-retirement/p32-4/light-1440-model.png)
- [深色760思考菜单](native-20261101-final-owner-retirement/p32-4/dark-760-thinking.png)

1280×800、1440×900、1920×1080 三尺寸与额外760×820窄屏，分别覆盖浅/深色和正文/模型菜单/思考菜单。所有16张菜单图实测 `menu.bottom <= composer.top`；菜单未越视口、层级低于权限弹窗、打开菜单 composer 不位移。已目视上述浅色1440模型图和深色760思考图，输入可见且无残留错误提示。

交互走可见 chips 的实际点击、实际模型搜索与原生确认；测试了 A 操作未结束时看 B、原生 high 后物理 Up/Enter 选 low、Escape、Tab离焦、双会话草稿恢复、真实滚轮及新输出不抢离底阅读位置。结束时两条 Runtime 均通过 owned close，退役后的错误检查也明确为0；退出后按测试脚本与 TEMP 前缀查询未见剩余fixture进程；此查询不冒充完整进程创建身份审计。

## 失败历史与边界

`native-first-interrupted.log` 是新场景 check 适配器参数误配后的主动中断，不是有效通过证据。`native-thinking-red.log`、`native-keyboard-red.log`、`native-enter-red.log` 保留 Enter 激活缺口定位历史；最终通过来自明确单次激活合同。

`native-initial-green.log` 与 `native-notice-audit.log` 是旧锚点布局的中间运行。中间截图残留错误提示来自 fixture 将被模型菜单覆盖的 textarea 坐标误当“离焦”点击，实际选中了候选；已改用物理Tab离焦并断言无意外pending/notice。`native-ui-settle-red.log` 是 fixture 只等后端 idle、未等前端 Send 解除pending 导致第二次 Enter 未发送；已补可见 Send 可用守卫。`native-owner-retirement-red.log` 的144条交互断言虽通过，但JSON在close后出现退役TypeError，因此不能作为renderer无错误证明，已补先红后绿和close后检查。`native-send-ready-red.log`、`native-focus-contention-red.log` 保留并行GUI环境下键盘焦点/输入时序失败，不能只凭这些超时归因产品；最终独占窗口并在每次物理键前核对窗口和DOM焦点、enabled，输入后验证精确文本。所有这些中间运行不替代最终168/168和最终截图。

未在本子任务运行：默认完整 Runtime Electron 流程、完整 canonical `npm test`、产物重建/打包GUI、真实Pi/模型。独立代码审查和最终构建由根 Agent 汇总；无提交、推送、合并或发布。
