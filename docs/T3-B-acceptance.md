# T3-B 验收记录

## 范围与提交

- 基线 main：`d81b3548ad6c93efdba36ee203f37c90f28e7867`；成功 main push CI：[39746424693](https://github.com/HYJ1817/pi-gui/actions/runs/39746424693)。基线证明不代替本轮验证。
- 业务提交：`f66bf45`；测试与 canonical 入口提交：`e17655b18b8c342b85c608d2fc5a0e3f7c802305`；停止测试夹具依赖：`bbbf5618407f30271d47ff463e0105940f6838aa`；最终行为修复与回归：`5230a822a5d43ace1169a40e49882b2f82855179`。后续文档提交不改变行为代码。仅本地提交，未推送、合并、改版本或发布。
- 当前结论：开发与本地自验完成，最终完整 canonical 已取得同一行为 SHA 的分组证明。独立上下文审查未执行，不能宣称已满足全部代码验收门槛。

## 修改清单

| 归属 | 文件 |
| --- | --- |
| 后端 | `server.js`、`server/router.js`、`server/review-comment-{authority,store,routes}.js` |
| 前端与 schema | `public/api.js`、`public/git.js`、`public/diff-comments.js`、`public/review-comment-{data,persistence}.js`、`lib/review-comment-data.js` |
| 新验证 | `tests/review-comment-{store,authority,runtime,http,persistence-ui,electron}.cjs`、`tests/fixtures/review-comment-backend.cjs` |
| 原回归/入口 | `tests/diff-comments-{ui,split,electron}.cjs`、`tests/{gui-browser-stop,stop-barrier}.cjs`、`package.json`（只增测试入口） |
| 文档 | `docs/{README,architecture,git-changes,security,testing}.md`、[设计](T3-B-plan.md)、本记录及下方少量证据 |

## 数据与一致性

存储为 `<DATA_DIR>/review-comments/<SHA256>.json`，schema v1，包含 scope 哈希、随机 UUID revision 和有界评论。
保留 ID、相对路径、分区/行号/行类型、hunk/代码/Diff 哈希、正文和时间；不持久化代码 snippet、完整 Diff、绝对路径或临时 owner。
20 个磁盘作用域（包括删除后的空 revision）、200 条/作用域、2000 字/条、2 MiB/文件；不自动淘汰。

永久键使用后端核验的 cwd/Git root/common/admin 文件对象、原生会话 ID/文件身份；并行模式加持久 conversation 和 workspace ID/epoch。
runtime/generation/backendInstance 只参与当前 owner 与进程内 HMAC token 校验。经典 get_state 与扫描器交叉核验；Runtime Registry 必须是当前焦点，持有原有 Workspace lifecycle lock。
删除重建 Worktree、会话或身份失效不会按路径误认。新原生空会话尚未落盘时保守拒绝恢复，待身份确认后重试。

现有认证/Origin 在接口前执行，前端不能选保存路径。存储拒绝项目内 data、symlink/junction/hardlink、目录替换、非法字段/UTF-8 与超限。
写入采用独占事务锁、磁盘 revision CAS、同目录临时文件、flush、替换前复查和 rename；只在确认后更新 UI。
冲突/失败保留编辑正文；旧加载/保存响应不能落到新作用域。恢复默认未验证，沿用 T3-A 的完整 Diff、隐藏上下文、过期/截断语义，缺失文件不删除评论。

损坏/未知版本原件保留并拒绝空白覆盖。文件占用与写失败保留有效提交；中断残留锁阻止写入，不猜 PID、不自动清除。
人工恢复须退出相关实例、备份目录、确认无写入者；不做自动迁移或重置。源码默认 data 在项目内会明确拒绝，需显式设置项目外专用目录；Electron 默认 userData。

## 验证

Windows，Node `24.22.1`，Electron `44.4.3`；依赖从既有本机目录离线复制，无新依赖或模型调用。全部会写盘的 fixture 位于临时目录。

| 检查 | 实测 |
| --- | --- |
| 新增定向 | store **49/49**、authority **15/15**、真实 Worktree + Registry **7/7**、HTTP **17/17**、异步协调 **15/15**；合计 **103/103**，失败 0、skip 0 |
| T3-A 回归 | 纯模型 **51/51**、Changes UI **50/50**、Specs 分屏 **10/10**；失败 0、skip 0。UI 原 41 条全部保留并增加 9 条 |
| 原 Electron 回归 | 正常沙箱 **41/41**（production 27 + native Browser 14），四档宽度和 Browser 身份/挂载生命周期均通过；失败 0、skip 0 |
| Electron 真实重启 | 最终代码正常沙箱 **25/25**，四次独立 Electron/后端进程：保存→恢复并修改→重启后删除→再次重启确认删除；失败 0、skip 0 |
| 辅助 no-sandbox | **25/25**；单列诊断结果，不能充当正常沙箱证明 |
| 实际打包后端重启 | 正常沙箱 **25/25**，失败 0、skip 0；同一专项夹具仅将后端入口替换为产物 `resources/app/server.cjs`，四次独立进程验证 |
| 重建与产物 | `build:app -- --rebuild` 成功，App 检查 **26/26**、SEA 检查 **49/49**；6 项资源 SHA256 一致，新增模块在 manifest/后端 bundle 中 |
| 最终完整 canonical | 绑定最终行为 `5230a82`；core 103、ui 24、security 27、native 2、faults 18，**174/174 项命令退出 0**，失败 0。是本地完整分组证明，不是单次 npm test 成功或 GitHub CI |
| 文档与链接 | 184 个相对链接（含锚点）检查通过，0 失效；diff 空白检查通过 |

既有权限跳过共 **19 条**：日志 symlink fixture 1、两套审计 witness 各 8、旧 in-place SACL 2；未计入断言通过数，未借本轮扩大任何原写入资格。
结构化证明见 [validation.json](evidence/t3-b-review-comments/validation.json)，仅保留一张 [恢复后截图](evidence/t3-b-review-comments/restored-edited.png)；原始运行日志与失败历史保留在本工作区 `.probe/`。

本地补充基线曾因现有 `worktrees-http.cjs` 的随机端口触发 fetch `bad port` 而中断；未改代码定向重验 **14/14**，再按冻结清单续跑其余 **47/47**，累计覆盖 169 个唯一命令。续跑跨越本轮开发期间，只作环境和未受影响边界的补充参考，不作为纯净基线 SHA 的完整本地证明；准确基线完整证明以 main CI 为准。首轮失败及续跑原始记录保留。
首次完整运行在旧停止装配夹具缺少新增依赖处中断；两份夹具分别恢复 **12/12**、**17/17**，无断言删除。
续跑期间自审再发现：旧编辑器已移除、下一会话恢复后，旧保存回调仍能发起当前 scope 写入。
增加真实 DOM 复现，保存入口补齐 stillHere 校验，回归 **50/50**；该权限边界变化后停止旧续跑协调器，旧结果不作最终完整证明。
最终使用现有 `scripts/run-test-group.mjs` 在独立 TEMP/端口中运行 core/ui/security/native/faults 的完整并集，固定同一行为 SHA；不改 workflow、gate 或 canonical 清单。

新增模块按缺少能力先失败再实现；复核发现的非法 UTF-8 静默替换、owner 换代无 scope 事件导致重试锁住，均先加复现后修复。
真实 Windows FileShare 占用检查与注入的 EACCES/EPERM/ENOSPC 分开；目录替换注入明确释放测试锁以覆盖 OS 正常拒绝之外的身份检查。部分 Electron 进程退出附近出现 Chromium GPU 诊断，断言/退出码仍为 0；不据此宣称日志零错误。首次构建选错本机 Electron 缓存目录，改为已存在的正确版本缓存后成功，没有联网下载。

## 审查、限制与回滚

作者分别自审功能和安全/故障路径，发现 1 个 Important 级旧保存回调隔离问题并修复；UTF-8 和换代后重试等健壮性问题亦已修复。未处置 Blocker 0 / Important 0。重点核对 scope 伪造、跨会话、路径选择、源文件覆盖、CAS、确认时机、损坏保留和敏感数据出口；当前未发现可证实的未处置阻断项。
**这不属于独立审查。用户明确要求“别用子代理”，因此没有派独立 Agent；独立功能/安全审查仍待后续安排。** CI、代码验收、人工合并和发布许可仍相互独立。

不承诺多窗口实时同步、未保存草稿恢复、同权限恶意进程隔离或断电目录元数据持久性。空 revision/孤立作用域和中断锁需要人工维护；容量不自动回收。data 需使用规范长路径，8.3 短名配置可能被保守拒绝。未做安装升级、签名或发布验证，本轮也没有这些授权。

回滚按依赖逆序撤销本轮文档、保存入口修复、夹具/测试入口与业务提交，再用同样离线参数重建；不要删除应用数据。
旧版忽略 `review-comments`，保留 v1 原件可重新切回；不要将旧 revision 的快照强行覆盖新文件。无用户源代码、Git index、Pi JSONL 或 Planner 数据需要回滚。
