# T4-A 修改任务预览验收

## 范围与基线

- 基线 `062c87c155984ba9bddab52cac59234300fb498d`，已含 T3-C PR #19。
  [main push CI 39796797262](https://github.com/HYJ1817/pi-gui/actions/runs/39796797262) attempt 1：
  run / 五组 canonical / CI gate 成功。API 的 build job 状态字段与已完成步骤不一致，
  不把该字段表述为单独核实的 8/8 job 成功；本轮另有本地重建和产物证明。
- 独立 Worktree：`C:\Users\21022\.codex\worktrees\t4-a-review-task-preview\pi-GUI`，
  分支 `codex/t4-a-review-task-preview`。原主工作区及未跟踪文件保留。
- 功能 `ceb1994`，测试入口 `69489a4`，局部命名守卫修正 `0f769d4`，
  键盘焦点修复 `2e149b1`、回归 `4502429`；最终行为/验证提交
  **`45024299bd64dfa157a86559a14db58f55e178a6`**；之后只补文档与证据。
- 开发与本地自验完成，最终行为已取得完整 canonical 证明。
  作者自审与独立验收分开：依用户要求未使用子代理，独立外部验收待后续安排。
  不授予推送、合并、版本/tag 或发布许可。

## 改动文件

| 职责 | 文件 |
| --- | --- |
| 纯任务投影与共享容量 | `public/review-task.js`、`public/review-comment-limits.js` |
| 弹窗两步选择/预览 | `public/review-task-preview.js`、`public/git.js`、`public/styles.css`；`public/ui/modal.js` 的 Tab 候选排除隐藏控件 |
| 临时证据状态 | `public/diff-comments.js`；既有锚点匹配逻辑不变 |
| 新测试 | `tests/review-task{,-ui,-electron}.cjs`、`tests/fixtures/review-task-electron.cjs` |
| 回归与入口 | `tests/diff-comment-ranges-ui.cjs`、`tests/diff-comments-electron.cjs`、`package.json` |
| 文档/证据 | 本报告、[计划](T4-A-plan.md)、`docs/{README,git-changes,security,testing}.md`、下方少量截图/JSON |

没有后端、schema、稳定 scope、区间匹配算法、Pi RPC、Planner、Browser 权限、依赖、workflow/gate 或版本改动。

## 数据流与确认

既有审查弹窗 → 临时 ID 集合（按文件选择/全选/取消）→ 纯函数投影 → 只读完整任务 →
用户点击复制或调用既有 `fillReviewComposer()`。选中/返回/预览不保存、编辑或删除评论。
默认仅选择 `verified === true && !stale`；过期、待确认意见显示原文和原因，不能强行纳入。
同一位置的单行与区间按不同 ID 保留；同文件归组但不合并正文。

任务明确是拟交付的指令文本，不是已生成代码/实际 Git Diff。包含项目、实际 Worktree、会话、文件、
staged/working、准确旧/新坐标、原意见和确认状态；复杂区间复用 T3-C 的双侧行号表达。
混合分区有提示。路径和正文逐项 JSON 引用，换行不能逃出数据字段，DOM 用文本节点。
共享原 12000 字反馈上限，超限整体拒绝，不截断。引用格式不是阻止模型忽略要求的权限机制。

快照绑定当前 scope、项目/实际 Worktree、会话/owner、workspace generation、存储状态/revision、
全部所选评论元数据/正文与临时 Diff 证据代号。编辑、删除、重新验证（即使证据值相同）、
刷新开始和存储变化都会撤销预览；复制/填入前还重新比对快照。刷新进行中有独立读屏障，
迟到保存确认不能把旧位置重新当成可生成任务的证据。旧 detached Diff 不会清掉新确认。
作用域切换沿原生命周期立即关闭；旧闭包检查 dispose、连接与作用域，不能填入新会话。

复用 `review-fill.js` 的经典就绪/可写检查、并行 focused ID/owner/DOM 归属检查、容量检查和原样追加。
原草稿（含尾部空白）保留，原 input 事件更新原草稿 owner；不调用发送、Pi、Executor 或 Scheduler。
界面与任务明确告知：填入本身不改代码；用户随后发送可能让 Agent 在真实工作区执行；文本约束不是写入隔离。

## 兼容与验证

v1/v2 读取、CAS、事务锁/原子写入、后端 scope、区间规则均沿用 T3-B/C。没有迁移或新磁盘数据。
Windows / Node 24.22.1 / Electron 44.4.3；沿用本机离线依赖与 Electron ZIP。
写盘 fixture 全在 TEMP，真实项目只读；准确基线使用 main CI，本地另跑受影响基线，不重复全量基线。

| 验证 | 实测结果 |
| --- | --- |
| 新模型 / UI | 25/25、35/35，失败 0、skip 0；既有审批交互 44/44，无审批决策/权限变化 |
| 评论回归 | 模型 51/51、UI 51/51、分屏 10/10、区间模型 29/29、区间 UI 22/22；原断言保留，区间 UI 增 1 |
| 持久化边界 | store 49/49、authority 15/15、Worktree/Registry 8/8、HTTP 18/18、异步协调 16/16、升级故障 17/17 |
| smoke 定向修复复验 | 1338/1338；没有减少断言 |
| 正常沙箱真实 Electron | 最终状态 93/93（production 59、native 34），失败 0、skip 0；含三种布局实际 Tab/Shift+Tab |
| 完整 canonical | **179/179 项命令退出 0**（core 108 / ui 24 / security 27 / native 2 / faults 18），绑定 `4502429`，墙钟 **1016.58 秒**；从 npm test/lifecycle 动态展开的完整本地分组证明，非单次 npm test 或 GitHub CI |
| 重建 / 产物 | 最终冻结提交离线重建退出 0，App 26/26、SEA 49/49；10 项前端/后端资源 SHA256 相同 |
| 链接与空白 | **152/152** 个相对链接/锚点、`git diff --check` 通过 |

完整运行中的既有环境 skip **19 项**：日志 symlink EPERM 1、SACL witness 8、in-place 非空 SACL 2、
object witness 8；权限不可用，未计入通过断言分子分母，也未开放任何原写入资格。新模型/UI/专项 skip 0。
完整唯一命令、分组状态/耗时、环境 skip、真实 Electron 和资源哈希见
[结构化证明](evidence/t4-a-review-tasks/validation.json)。原始日志与中断/失败历史保留在本 Worktree `.probe/`。

真实 Electron 使用临时 Git 项目，实际添加单行/区间评论、选部分、预览、返回全选再生成、填入保留草稿。
Specs 与 Browser 两类分屏、720/900/1200/1536px 均检验 modal 布局；真实原生 Browser 在任务 modal 中 detach，
关闭后恢复。生产/Specs 的 fake Pi 命令类型记录未出现 prompt/steer/follow_up，任务操作前后 fixture 源文件字节一致。
A/B 切换由实际 focused-scope 事件验证关闭与旧按钮拒绝；并行 Composer 的实际 owner/草稿归属另由上述 UI35 回归覆盖，
不冒充真实模型、安装升级或 T4-B 隔离执行验收。

代表截图均为临时 fixture，逐张检查可见内容：
[选择列表](evidence/t4-a-review-tasks/t4-selection.png)、
[720px 任务预览](evidence/t4-a-review-tasks/t4-production-720.png)、
[Browser 分屏弹窗](evidence/t4-a-review-tasks/t4-browser-1200.png)、
[Specs 分屏弹窗](evidence/t4-a-review-tasks/t4-specs-1200.png)。仅保留四张，总计约 0.52 MB。

失败历史保留在 `.probe/`：新模块先缺失失败再实现；刷新窗口、迟到确认和旧回应覆盖确认均先复现失败后修复。
Electron 夹具曾有脚本引号错误、误等旧 DOM 标记删除，以及刷新完成前读取旧编辑器；均修正夹具后重验，未删断言。
首轮完整验证 `69489a4` 的 smoke 为 1337/1338，文本扫描误认局部 `el` 为全局控件表；其余组停止，不计最终证明。
局部变量改名后定向 1338/1338，再冻结新 SHA 完整验证。任何首次失败/停止均不写成通过。
`c39fb86` 完整 canonical 曾通过 179/179，但补充实际键盘审计发现：隐藏的旧汇总操作仍被 Tab 循环纳入。
先保留真实 Electron 与 UI 失败复现，再使焦点候选跳过隐藏步骤，新增双向键盘回归；
最终 `4502429` 已重新完成上述完整证明，不将修复前通过结论继承给后续行为。

## 自审、限制与回滚

作者自审功能、安全与故障路径，已处置：刷新中重复生成旧证据、迟到保存绕过读屏障、旧 Diff 回应撤销新确认、
并行工作区路径说明、复选框重绘焦点、预览双向 Tab 隐藏步骤陷阱、快照失效后按钮禁用与文本清空。没有可证实的未处置 Blocker/Important；
自审不是独立功能/安全审查。独立外部验收仍待后续，不能声称已满足全部合并门槛。

限制：不纳入过期参考意见；任何相关重新核验会要求重新生成。任务不自动去重追加，重复填入会重复追加。
已经请求的系统剪贴板写入无法撤回；点击当刻先验证，异步返回后再次核对且不更新过期界面。
临时预览不跨关闭/重启恢复；未承诺多窗口评论实时同步、持续监视未刷新磁盘文件或强制写入隔离。
T4-B 前需独立确认隔离工作区/执行授权、真实 Diff 证据、冲突/撤销与用户确认边界，不能用这里的 Prompt 替代。
未做 POSIX、安装、升级、签名或发布验证。

回滚按 `4502429` → `2e149b1` → `c39fb86` → `0f769d4` → `69489a4` → `ceb1994` 逆序撤销（后续文档单独撤销），
再用同样离线缓存参数重建 App/SEA。保留现有 review-comments 数据，无 schema 回滚或用户项目文件恢复需求。
