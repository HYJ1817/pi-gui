# T3-C 区间评论验收

## 基线与范围

- 基线：`origin/main = 8ae15efa51ad4f7bac907b60b22e06448308929a`，已包含 T3-B 最终实现。PR #18 已合并；[PR CI 39769635804](https://github.com/HYJ1817/pi-gui/actions/runs/39769635804) 成功，[main push CI 39773851353](https://github.com/HYJ1817/pi-gui/actions/runs/39773851353) attempt 1 的 8 个 job/gate 成功。
- Worktree：`C:\Users\21022\.codex\worktrees\t3-c-range-comments\pi-GUI`；分支 `codex/t3-c-range-comments`，从最新远端 main 创建。主工作区及其未跟踪文件保留原状。
- 功能提交 `2882ab2`，测试/入口 `138f556`，最终行为与空编辑器回归 **`c8c65af738fa16a6d20cef3ed1cf52b0bd53aae6`**。后续提交只补文档与证据。
- 开发和本地自验完成，最终行为的完整 canonical 证明已取得；独立外部功能/安全验收待安排，尚不宣称代码验收通过。不使用子代理；未推送、合并、改 main、版本、tag 或发布。

## 文件清单

| 归属 | 文件 |
| --- | --- |
| 前端 | `public/diff.js`、`diff-comments.js`、`git.js`、`styles.css`、`review-comment-{range,data,persistence}.js` |
| 后端 | `server/review-comment-store.js`；authority/routes/稳定 scope 算法不变 |
| 新测试 | `tests/diff-comment-ranges{,-ui,-electron,-split-electron}.cjs`、`tests/review-comment-ranges-store.cjs` |
| 扩展回归 | `tests/diff-comments-{ui,electron}.cjs`、`tests/review-comment-{runtime,http,persistence-ui,electron}.cjs`、`package.json` 测试 alias |
| 文档 | 本报告、[方案](T3-C-plan.md)、`docs/{README,git-changes,security,testing,work-surfaces}.md`、下方少量证据 |

## 选择、证据与兼容

普通行号保持单行评论，Shift 点击/Shift Enter/Space 选择同文件、同分区、同一完整 hunk 内的 **2～20 个视觉代码行**，Esc 取消。独立区间标记负责编辑，单行/区间可共用首行且各留草稿；区间之间任一侧坐标重叠即拒绝，包括过期区间。

原锚点首行字段保留，增加 `range:{version:1,lines:[{type,oldLine,newLine,codeHash}]}`，有序证据覆盖全部行及两个端点；保留原 hunk 哈希/索引与 Diff 指纹。不落盘代码或完整 Diff。纯新增/删除只表达有效的一侧；混合区间分别表达旧/新行号及 Diff 行数，不按视觉行数编造文件范围。

验证只接受原坐标上唯一、连续、同一完整 hunk 的全部哈希。内部变化/歧义判过期，不搜索相似函数；仅缺上下文、可见证据一致且最近完整确认的指纹不变时待确认。重启恢复一律先待确认，截断结果不证明有效或失效。折叠、滚动与缩放不迁移归属。

v1 读取不迁移，单行仍可恢复/编辑/删除；第一次保存区间才在原事务锁、revision CAS、flush 与原子替换内升级 disk v2，保留全部 v1 记录。升级后删空也保留 v2/revision。写入、flush、rename 失败保留有效原件；丢失确认须重载，不能假定失败就没有提交。损坏/未知未来版本、额外字段、超限和非法证据拒绝覆盖。永久 scope、owner/token、路径/链接保护和容量上限不变，未新增 API 或磁盘路径选择能力。

## 验证与证据

Windows，Node 24.22.1、Electron 44.4.3/Chrome 152.0.7977.130。沿用已有离线依赖与本机 Electron ZIP，无新依赖/模型调用；写盘 fixture 全在独立 TEMP，应用构建在本 Worktree。精确基线完整证明来自成功 main CI，本地开发前另跑 T3-A/T3-B 全部相关基线（111 + 103 条，失败/skip 0），不重复基线全量。

| 检查 | 结果 |
| --- | --- |
| 新区间模型/schema、UI、升级故障 | 29/29、21/21、17/17；失败 0、skip 0 |
| 原评论/隔离回归 | 模型 51/51、UI 51/51、Specs 分屏 10/10；store 49/49、authority 15/15、真实 Worktree/Registry 8/8、HTTP 18/18、异步协调 16/16；原断言保留，只增覆盖 |
| 最终行为完整 canonical | **177/177 项命令退出 0**；core 106、ui 24、security 27、native 2、faults 18，绑定 `c8c65af`，总墙钟 **1048.257 秒**。现有执行器动态展开 npm test/lifecycle 的本地完整分组证明，非单次 npm test 或 GitHub CI |
| 正常沙箱重启、分屏与旧单行 | 最终冻结提交的实际打包后端五进程重启 **34/34**；源码 Specs/Browser 区间分屏 **48/48**（29 production + 19 native）；原单行 Electron **41/41**，失败/skip 0。早期源码重启 34/34 仅作开发反馈 |
| 重建与产物检查 | 本机缓存离线 `build:app -- --rebuild` 退出 0；App **26/26**、SEA **49/49**；7 项前端资源与后端 bundle 共 **8 项 SHA256 一致**，无失败/skip |
| 文档链接/锚点、空白检查 | **155/155** 个相对链接（含锚点）通过；`git diff --check` 通过 |

既有环境 skip **19 条**：日志 symlink fixture 1、两套 SACL witness 各 8、in-place 非空 SACL 2；权限不可用，未计入通过分子分母，也未因此开放任何原写入资格。本轮新专项失败/skip 0；UI 原 50 条扩为 51，Runtime/HTTP/协调分别从 7/17/15 扩为 8/18/16，没有断言删除。

最终结构化证明见 [validation.json](evidence/t3-c-range-comments/validation.json)，含 177 个唯一命令的结果、时间和分组。代表截图：[恢复](evidence/t3-c-range-comments/range-restored.png)、[过期](evidence/t3-c-range-comments/range-stale.png)、[Browser 分屏](evidence/t3-c-range-comments/browser-range-comment.png) 与[原生页面](evidence/t3-c-range-comments/browser-native-page.png)。Specs 的交互由真实 Electron 断言证明；其整窗截图捕到加载帧，未作为编辑器视觉证明交付。原始运行记录保留本 Worktree `.probe/`，不上传用户 payload。

失败如实保留：新能力/升级测试先失败再实现；首次区间分屏遇 Chromium 随机禁止端口，属于 fixture 环境；随后曾暴露测试错误查询首个单行编辑器而非区间编辑器，已修正查询。真实窄窗失败与迟到 Diff、隐藏上下文、空编辑器刷新缺陷分别补回归后修复。第一轮 canonical 在发现空编辑器缺陷后停止，**不计最终证明**；最终证明必须覆盖最后行为提交。部分 Electron 退出附近出现 GPU 诊断，不能称日志零错误；不使用 no-sandbox 代替正常沙箱。

## 作者自审与限制

分别自审功能、安全及故障路径；已修复并保留复现证据：旧 detached Diff 响应重新核验评论、加载期间列表重绘丢失展开状态、窄窗编辑器被内容撑出面板、最近确认指纹更新后的隐藏上下文误判、异步刷新丢弃空白区间编辑器/焦点。原 UI fixture 过去可等待 detached 行，本轮改为等待真正连接的当前行，并增加断言；原断言未删除。

尚未发现可证实的未处置 Blocker/Important。**作者自审不是独立审查**；按用户要求未启动子代理/自动并行审查，独立外部验收留待报告后。CI、代码验收、允许合并和允许发布各自独立，本报告不授予后续操作权限。

限制：同 hunk/20 行，区间不交叠；不做补丁、自动发送、Git 写入或 Planner/Pi/Browser 权限更改。不承诺源文件整体移动后的重定位、未保存草稿跨重启恢复、多窗口实时同步、同权限恶意进程隔离或断电目录元数据持久性。重启后若上下文不可见且原存储指纹已变化，保守判过期，完整 Diff 可再次核验。T3-B 原有空会话身份不可用、孤立 scope/残留锁人工维护、20 scopes 容量与规范路径要求继续适用。未验 POSIX、安装升级/签名或发布。

## 回滚

按 `c8c65af`（刷新修复）→`138f556`（测试入口）→`2882ab2`（功能）逆序撤销，再用同样离线参数重建 App/SEA；文档提交可单独撤销。保留应用评论数据，勿删除目录、强改 schema 或强写旧 revision。T3-B 旧版遇 v2 会安全拒绝恢复，恢复 T3-C 后可重新读取；不要用过时 v1 快照覆盖新 v2。用户源文件、Git index、Pi JSONL 与 Planner 数据无需回滚。
