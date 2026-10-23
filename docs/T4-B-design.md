# T4-B：候选 Worktree、执行确认与真实 Diff

## 状态与基线

已在 `codex/t4-b-candidate-diff` 实现受限候选执行。实际验证及审查状态见
[验收记录](T4-B-acceptance.md)，不代表允许合并或发布。
基线 `03a223d7ac5f69f33a359e51f95905bfb07253b8` 包含已合并的
[T4-A PR #20](https://github.com/HYJ1817/pi-gui/pull/20)；
[准确 main CI](https://github.com/HYJ1817/pi-gui/actions/runs/39823004520) 成功。
初始勘察提交 `4bb1199` 的缺口通过原始输入事务、独立确认和逐工具证据处理；
[旧实验](evidence/t4-b-feasibility/observations.json) 保留为历史材料，不是新功能证明。
任意 shell 和外部写者的完整归因仍不具备，不能包装成强隔离能力。

## 复用地图

| 职责 | 模块与边界 |
| --- | --- |
| Worktree 身份、创建、保留、安全移除 | [既有 Registry](../server/worktrees.js) 增加后端只读 prepare 和创建前重验回调，仍用原路径和生命周期锁 |
| 运行、owner、RPC、审批、Stop | [Runtime Registry](../server/runtime-registry.js)、[SessionRuntime](../server/session-runtime.js) 及原 guard/调度器；不另造 Executor |
| 评论与任务 | 原 [authority](../server/review-comment-authority.js)、CAS store、[T4-A 模型](../public/review-task.js)、Diff/区间验证；不改 schema 或稳定 scope |
| 输入与差分 | [candidate-snapshot](../lib/candidate-snapshot.js)：原始字节、真实 index、Git/文件身份及既有 Git runner |
| 确认和收尾 | [candidate-runs](../server/candidate-runs.js)：nonce、既有生命周期、结果资格和终态 |
| 私有执行材料 | [candidate-store](../server/candidate-store.js)：有界输入和结果，不是日志或第二套 Worktree Registry |
| UI | [candidate-review](../public/candidate-review.js) 位于既有审查弹窗，复用 Diff、分屏和 native Browser 遮挡 |

Planner `changeEvidence` 是时间窗口证据，不能直接当成完整输入或写者证明。
原 `worktreeTree/add -A` 会加入额外文件并可能触发 filter，本流程不用它构建输入。

## 身份、预检与确认

来源绑定后端持久评论 scope、完整 owner、context generation、评论 revision/选中集合和原始输入摘要。
候选沿原 Registry 使用稳定 workspace ID/epoch，独立 run UUID、conversation/native session。
瞬时 runtime generation 防旧响应，不当作永久归属。

预检只读，不建目录、Git 对象、Worktree 或 child。显示来源、当前会话、HEAD、评论和文件、
staged/working/untracked/ignored 数量、输入容量、预计位置、忙碌/资源、写入和弱隔离说明，
以及最终发送的完整任务。未知或忙碌状态拒绝。当前运行线为两条时明确确认第三条，原上限仍为三条。

点击「确认创建并执行」消费五分钟、一次性 nonce。实际创建、输入落地后、发送前重读来源和评论，
比较内容和文件/Git 身份，不仅比较 dirty 字符串。关闭/返回撤销未消费 nonce，旧 owner/generation 不能确认。
跨实例 writer lock 覆盖创建、执行和清理，重复确认不重试、不重发；新运行必须重新明确确认。

复用 T4-A 文本，外层明确候选 cwd、输入 ID、来源路径仅为引用数据。评论/路径均为不可信数据，
DOM 使用安全文本节点，正文不授予工具权限。后端重验完整 Diff，不相信客户端 `verified`。

## dirty 输入事务

三层分别记录 HEAD、index 的 stage-0 mode/blob/path，以及 working 原始字节/缺失状态。
候选由原生命周期从 HEAD 创建，再仅在候选恢复 index 和 working；不提交、stash、reset 原项目。
落地后 content ID 必须相等才启动；不把 staged 与 working 混成一棵树。

上限：512 文件、单文件 1 MiB、合计 8 MiB、遍历 20,000 项。超限拒绝输入，不截断后继续。
保留 CRLF、二进制及无末尾换行的原字节。枚举、读取、末次复读检查文件/index/admin/common/config 身份；
新出现的 untracked/ignored、内容漂移或索引变化使确认失效。原 index 不刷新、不写入。

第一版拒绝来源 untracked，不隐式复制；ignored 仅枚举计数、不读正文或复制。
非项目根、unborn、冲突、子模块/嵌套仓库、稀疏/skip/assume 索引、链接/junction/hardlink、
特殊文件、疑似凭据、`.gitattributes`、生效的 filter/encoding/diff 属性、partial clone、Git lock 保守拒绝。
候选新文件可以进入 post，但仍受路径和容量验证；ignored 输出不能获得可靠结果资格。

## 权限与实际隔离能力

**Worktree 不是操作系统沙箱。** 相同用户权限的 Agent 可以通过绝对路径、shell 或扩展访问原项目、
共享 Git common 及其他文件。提示词、路径验证、目标证据都不能阻止所有行为，确认前如实展示。
不增加自动批准、任意命令入口、网络权限或权限扩展。审批仍由原协议决定，未请求审批不能杜撰逐操作审批。

沿原 Runtime 启动、回读 native session、确认 guard 就绪后，只向精确 owner 发送一次 prompt。
保留原 Scheduler、审批、全局忙碌和 Stop 屏障；活动候选阻止来源新 turn 和冲突 Runtime 操作。
运行不依赖面板焦点。候选会话通过原资源同步/事件回放显示审批，不向来源会话发送。

可识别的原生 read/write/edit（含既有受信撤销包装器）在原 lease 内提供目标和预期 UTF-8 结果 SHA，
前后原始快照核对目标、字节、index/HEAD 和已知副作用。越界/链接目标在开始前拒绝。
未知工具、shell、无法精确求得结果的 edit、工具外变化、重叠工具或证据异常使结果失去可靠资格。
不放宽权限追求通过率。

这证明有限工具目标、预期字节与实际观察一致，**不证明 OS 级独占写者**；
不能排除恶意同用户进程写出恰好相同结果。任意 shell 的强归因与写入隔离仍不支持。

## 结束与真实 Diff

现有 settled、native get_state 和错误状态相符，并确认执行线清理后才保存已完成。
Stop 等待原屏障，settled 不能提前解除停止。清理无法确认则中断、保留锁，不显示成功。
最终 post 在执行线清理后读取，避免漏掉收尾写入；新增无法归因差异仍为待确认。

Diff 来自输入 pre 与实际文件 post，使用受限 Git `--no-index --no-ext-diff --no-textconv`，
不依赖 Agent 自述、原项目对 HEAD 的变化或 T4-A 文本。初始 dirty 已在 pre，不计入候选 delta。
展示新增/删除/修改/纯重命名、二进制、统计、真实 patch；改回输入得到空 Diff。
最多 50 文件、每文件 24 Ki 字符/总 64 Ki 字符 patch，明确标截断；输入/身份不完整则无结果。

状态分待启动、执行中、已完成、失败、已停止、中断，证据资格独立。
失败或 Stop 的可读 Diff 是观察结果，不是成功证明。本轮无应用、采纳、合并按钮。

## 存储、恢复、保留

`PI_GUI_DATA/candidate-runs` 是专用私有材料，含有限输入和 Diff，不得上传为诊断日志。
限制 20 个记录、每个 JSON 24 MiB；检查身份/链接/格式/摘要，排他锁和临时文件 fsync/rename。
不向日志、HTTP 错误或诊断写任务、源码、密钥或绝对路径。合法预检及私有材料中的路径不是诊断输出。
损坏/未来格式、数据目录落在用户项目内均拒绝候选功能，不损坏应用其他功能。

重启恢复已保存结果；pending/running 变中断，不补造当时 post、不重发 Agent。
崩溃锁保守阻止新运行，无自动破锁：先人工确认相关实例和子进程全部退出、保全材料，再处理专用锁，
不根据 PID 推测安全。外删/替换身份则结果不可用，不退回原 cwd 执行。

候选始终留在原 Worktree Registry；关闭/保留只结束显示，不停止已确认任务或删除代码。
清理沿原受控预检和明确确认，不强删 dirty/ignored/未知身份，不用 reset --hard、clean -fd、remove --force。
回滚产品保留候选和材料；T4-C 再处理采纳、冲突与回滚。

## 验证与审查

临时 Git + fake Pi 验证输入、确认、故障和真实 Diff；正常沙箱 Electron 走生产模块，
验证审批、原文件/index/草稿不变、重启、Stop、四档窗口、Specs 和原生 Browser 分屏。
定向后取得最终行为提交 canonical 证明并重建 App/SEA，结果见[验收记录](T4-B-acceptance.md)。
用户禁止子代理，本轮仅作者自审；独立功能、安全和恢复审查待外部验收，不宣称代码验收通过。
