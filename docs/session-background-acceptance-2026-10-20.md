# 会话后台运行与导航验收

日期：2026-10-20。基线：main `eb399823b8cf8057085473552b6dfa8b0f8c59bd`。本地分支：`codex/session-background-navigation`。

## 结果与执行边界

执行期间点击其它会话、项目或新对话，切换查看历史或编辑草稿；原有 Pi 子进程、cwd、聊天 DOM、流式消息和工具状态保持归属。返回当前会话可继续查看输出。移除了旧的“正在生成回答，等这一轮结束再切”通知。

**这是安全分阶段实现，不是任意普通会话的同目录并发。** 普通 Pi 的 `switch_session` 会替换执行线；直接删除 busy 判断会中断旧任务。已有 Registry 又明确禁止两个 writer 占同一工作区，因此保留此保护。同目录普通历史可查看、存草稿，原执行线空闲后可交接；需要同时执行时，显式使用现有“在独立工作区新建并行会话”流程。不会自动复制、迁移历史到另一目录，也不会自动启动后台记录。

已登记的其它项目可浏览；不会为查看而激活项目、改变后台 cwd。另一个项目的草稿执行仍需独立工作区流程，或关闭现有 Runtime 后使用原项目激活流程。保留原有默认并发名额及第三条显式确认、硬上限机制。

## 修改清单

| 文件 | 改动 |
| --- | --- |
| `public/session-navigation.js`（新增） | 分离历史查看与执行交接；保留主聊天；按项目/会话存草稿；过滤迟到历史响应；新会话草稿依据关联应答、原生 session ID、workspace generation 转交。 |
| `public/runtime-recovery.js`（新增） | SSE 初连/重连读取 Registry、所属事件及 native messages；以完整 owner 和 cursor 拒绝迟到覆盖；按后端当前待审批集合过滤历史审批，不发送决定或恢复命令。 |
| `public/app.js` | 注入导航、新会话、项目和 Planner 查看入口；装配 Runtime 恢复；休眠会话点击只读历史；后台完成刷新列表；全局 Stop 快捷键只在主聊天作用。 |
| `public/sessions.js` | 会话行打开视图；当前行可返回实时聊天；移除前端阻塞通知；搜索结果传递会话身份；保留原生交接。 |
| `public/projects.js` | 后台时先走只读项目/会话浏览及草稿入口，避免激活操作改变执行环境。 |
| `public/rpc.js` | 新对话入口支持导航注入；空闲时沿用原 RPC。 |
| `public/approval.js` | “稍后处理”、主会话待审批入口；后台请求不抢弹窗；离开视图暂存而非取消；恢复同一请求及输入草稿，保留单次投递和过期保护。 |
| `public/messages.js` | 广播主会话活动变化；后台完成不抢走其它会话输入焦点。 |
| `public/runtime-conversation.js` | 当前 Runtime 运行时禁止第二条普通 prompt；保留自己的 Stop；中断工具显示“未完成”。 |
| `public/runtime-nav.js` | 待审批状态；复用并行会话创建并打开；异步创建前捕获项目，避免使用变动后的项目路径。 |
| `public/runtime-store.js` | owner/cursor 校验下恢复待审批；结束、退出、确认停止时清理遗留运行状态；原生消息同时兼容字符串/文本块形式。 |
| `public/runtime-state.js` | 恢复完成广播同一 store 的视图变化。 |
| `public/runtime-resources.js` | 同一 Runtime 重复提交返回所属视图内的可读原因。 |
| `public/api.js` | 只读会话历史 API；Planner 会话预览参数。 |
| `public/ui/workspace-surface.js`、`public/styles.css` | 复用既有工作区承载历史页，仅增加正文换行样式。 |
| `public/planner.js`、`server/planner/index.js` | 主会话执行时打开任务历史走只读预览，不调用 native switch。 |
| `server/sessions.js` | 稳定 ID + 已登记项目查找历史；注入现有有界 same-fd/header 身份验证读取器；忙碌时阻止真实执行交接。 |
| `server.js` | 注入历史读取/活动判断；拦截执行或停止屏障期间的 new_session/switch_session/fork。 |
| `server/runtime-registry.js`、`server/runtime-routes.js` | 独立 Runtime 的重复 prompt 保护、当前待审批快照、确认停止后的待处理清理；保留固定 cwd、writer lease 和完整 owner 校验。 |
| `tests/session-background.cjs`、`tests/session-background-ui.cjs`、`tests/session-background-recovery.cjs`（新增） | 后端安全、视图/草稿竞态、恢复与审批归属回归。 |
| `tests/session-background-electron.cjs`（新增） | 生产模块/CSS、原生鼠标/键盘、真实窗口刷新；全部使用离线夹具。 |
| `tests/runtime-registry.cjs`、`tests/session-runtime.cjs` | 重复提交窗口；真实 guardian 下两个 fixture RPC 子进程，分别输出、统计、工具、审批、Stop 和落盘。 |
| `tests/approvals.cjs`、`tests/ui4-approval.cjs`、`tests/smoke.cjs` | 新增暂存/后台审批测试；按钮和键盘焦点预期包含“稍后处理”。没有删除或跳过旧断言，smoke 总数仍 1338。 |
| `package.json` | 新增三套回归接入既有 npm test 链；增加独立窗口验证命令，不改版本/依赖。 |

## 场景验收

| 场景 | 证据与结论 |
| --- | --- |
| A：A 运行时切 B 再回 A | 窗口原生点击/Enter；主聊天 DOM 保持同一对象，后台增量继续；不发送 switch/abort。通过。 |
| B：A/B 同时执行 | 两个独立工作区的真实 fixture RPC 子进程；输出分别标识 A/B、Token 输入 11/22；同名 tool/request ID 仍独立。通过。普通同目录会话仍受 writer 保护，**不属于已放开的并发范围**。 |
| C：停止 A 不影响 B | 真实 guardian/RPC 检查 A 的停止屏障，B 仍 streaming 并可继续完成；窗口 Stop 仅携带 RA owner。通过。 |
| D：审批归属 | 主会话暂存不取消，回到原请求仅投递一次；Runtime 同 ID 审批只回应 RB，RA 仍待处理；重连仅恢复后端尚待处理项。通过。 |
| E：项目/cwd 隔离 | 浏览另一项目无激活写请求；后台 cwd 不变；读取稳定 ID 不能跨已登记项目边界；两个真实子进程在各自临时 cwd 落盘。通过。 |
| F：快速切换 | 真实窗口连续六次 A/B 往返；同一 DOM、session ID、streaming 保留，无破坏命令。单测另覆盖 B/C 历史响应反序，以及已有 Runtime focus 反序。通过这些夹具场景。 |
| G：刷新/重新打开 | 窗口实际 reload 后自动读取 RB 原生结果；RA 后端记录为 dormant，无 owner，不启动、不误标运行；点击读取 RA 已证明的历史。Registry 重启记录发现测试也通过。真实应用退出会终止子进程，本轮不实现退出后继续执行。 |

## 实测命令与结果

没有运行全量 `npm test`，按用户的耗时要求执行以下相关叶子套件。所有命令 exit 0。日志位于 `.shots/session-background/*.final.log`，本轮没有新增网络依赖、调用真实模型或写用户真实会话。

| 命令（均为 `node tests/<名称>.cjs`） | 结果 |
| --- | --- |
| session-background / session-background-ui / session-background-recovery | 5/5、8/8、6/6 |
| runtime-registry / runtime-store / runtime-conversation / runtime-nav | 35/35、25/25、48/48、38/38 |
| runtime-http / runtime-events / runtime-resources / runtime-ui / runtime-finish-ui | 12/12、14/14、45/45、16/16、27/27 |
| runtime-history-search / session-runtime / stop-barrier | 35/35、7/7、17/17 |
| approvals / ui4-approval | 84/84、44/44 |
| sessions / session-search / planner / modules | 91/91、72/72、124/124、117/117 |
| ui3-composer / ui2-classic / smoke | 34/34、48/48、1338/1338 |
| ci-test-plan | 153 leaves / 5 groups，coverage exact（不是断言通过数） |

窗口命令：`node tests/session-background-electron.cjs`，以及设置 `VISUAL_ASSETS_ROOT=dist-app/Pi GUI-win32-x64/resources/app/public` 后再次运行。分别 **15/15**，renderer/harness errors 均 0。测试启动参数 `--no-sandbox` 仅用于本机 Electron 夹具环境，产品主进程安全配置未改。TEMP/TMP 指向仓库 `.shots/visual-temp`，避免本机原生工具临时文件权限陷阱；每个测试再创建自己的独立临时子目录。

构建：`npm run build:app -- --rebuild` exit 0，使用已有本机 Electron zip 离线缓存。构建日志记载内嵌资源 309 项、后端代码 2.16 MB、Electron 整包 328.5 MB，同时重建了 build 下的 SEA 依赖产物。SEA 注入工具报告移除原签名的既有 warning，没有新增签名或发布；本轮不声称通过了独立 SEA 全套验收。

`npm run fixtures` 后，使用空闲 CHECK_PORT、系统临时目录运行 `node tests/app-check.cjs`：**26/26**。该检查拷贝应用到无 node_modules 祖先的临时目录，验证打包后端/内嵌资源及 fake Pi，不写用户项目。

产物：`dist-app/Pi GUI-win32-x64/Pi GUI.exe`。版本仍为 0.26.2，未覆盖已安装副本，未发版。

SHA256：

- 源码及打包后的 `session-navigation.js` 均为 `A1D9148833778E8F9B0EFC64AA10F9BBF605C1D7A18E655890C9349E6C7F51E3`。
- 源码及打包后的 `runtime-recovery.js` 均为 `B646EA9D311BEF25B5D0100AADF5BABF1CC9E0D67FC73F72DAB8CD1CBB0EB64D`。
- 打包后 `server.cjs` 为 `F60AAB26CADC32871DB63AD99DC0C60077D832BD0B316F5085C552F762BF110D`。

## 真实截图

以下来自重建后 public 产物和实际 Electron 窗口，使用合成数据；不是 jsdom 布局推断。

- [亮色：查看 B、主会话 A 待审批](evidence/session-background-2026-10-20/light-background-history.png)
- [暗色：相同后台与审批状态](evidence/session-background-2026-10-20/dark-background-history.png)
- [RB 独立输出、Token 与审批](evidence/session-background-2026-10-20/runtime-B-owner-isolation.png)
- [刷新后读取已保存结果](evidence/session-background-2026-10-20/reload-persisted-result.png)
- [源码窗口检查记录](evidence/session-background-2026-10-20/electron-source.json)、[打包前端窗口检查记录](evidence/session-background-2026-10-20/electron-packaged.json)

## 剩余风险与审查状态

1. 同目录普通会话仍不能同时执行；后台时的新对话首先是草稿。不能将本轮称为任意普通 A/B 会话的并发迁移已经完成。
2. 只读原生历史接口只含 user/assistant 正文；不会伪造历史工具、思考、Token。仍在内存中的实时会话保存原有丰富状态。
3. 有界事件环及流式历史请求有 cursor 防护；迟到历史不会覆盖新块。极长断连且持续流式时，可能只保留有界尾部并显示截断状态，不保证任意离线时长的逐事件重建。
4. 外部真实模型、第三方审批扩展和长时间压力测试未运行；本轮验证的是离线协议夹具、真实子进程/guardian 和窗口路由，没有以真实用户任务作写入验证。
5. 已做作者 diff/边界检查；遵照用户不使用子代理的要求，未做独立 Agent 功能/安全复审。本次按用户要求提交并推送功能分支，不合并、不发版，不宣称满足 REVIEW.md 的独立复审合并门槛。

原有未跟踪 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/` 保留，不纳入提交。本轮在独立分支按实现、测试、验收证据拆分提交。推送前再次运行五套核心回归，5/5、8/8、6/6、35/35、7/7，均 exit 0；没有重跑全量 npm test。回滚时可整体 revert 本轮对应提交，再执行同一重建命令。不可对原有未跟踪目录或用户数据执行清理，也不可用全仓 `git reset --hard` 代替回滚。
