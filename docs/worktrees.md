# P32.2 受控 Worktree 生命周期

本阶段承接已批准的 [P32 ADR](adr/0032-worktree-multisession.md)，只提供工作区生命周期与顺序打开，仍只有一个 Pi child / RPC bridge。不启用并行会话或后台 runtime pool。

## 使用路径

项目行三点菜单 → **工作区管理**。列表展示主工作区、登记的受控工作区和只读的外部 worktree；没有新增一级侧栏入口。归档、取消归档和移除在工作区三点菜单中。

创建输入仅包含源提交/已有本地分支与可选新分支名称。留空名称时后端生成 `pi-gui/p32/<UUID>`。预检返回具体源 commit、分支、dirty 状态与单次 nonce；用户确认后才运行 Git 创建。主区有未提交修改时会明确提示这些内容不会被复制；不自动 stash/reset，不覆盖已有分支或路径，不触发创建提交。

打开复用现有项目切换：保存真实 cwd、重启单个 Pi child，由 Pi 的 `--continue` 恢复该 cwd 的历史。项目列表仍映射到原项目，顺序/数量/折叠键保持稳定，不把每个 worktree 自动添加成独立项目。当前任务、Stop 屏障、维护或 Managed Process 尚未完成清理时拒绝受控切换/修改；请先完成任务并停止相关服务。

归档只改变 GUI metadata，保留目录、分支与 Pi 历史，取消归档后可重新打开。移除使用 `git worktree remove`，从不追加 `--force`，不删除分支。当前工作区、Git lock、dirty/staged/untracked/ignored、子模块、嵌套 `.git`、symlink/junction 或无法证明已合并到创建时整合分支的工作区均拒绝移除。删除扫描最多检查 100,000 项；检查不完整即拒绝。未提交的工作应自行保存或清理，未合并提交应先合并。

非 Git 项目仍支持原来的顺序对话；此面板解释不支持原因，不隐式执行 Git init。

## 所有权和状态

登记保存于 GUI data 下的 `worktrees.json`（版本 1，原子写入），路径只能由后端生成：`<data>/worktrees/<canonical-common-dir hash>/<internal UUID>`。登记保留 repo identity、原项目、子目录 prefix、源 commit、整合分支、目标分支、workspace id、epoch、Git admin directory 与 root/admin 的 filesystem identity；不使用 PID 作为目录所有权。

受控存储根不能位于源仓库或 Git common directory 内，避免把新 worktree 变成 main 的未跟踪内容。源码模式管理 pi-GUI 仓库本身时，若默认 data 在仓库内，请先把 `PI_GUI_DATA` 设置到仓库外再重启；界面给出明确错误与恢复路径，不偷偷移动用户数据。

每次控制均校验登记、epoch、authoritative workspace generation、canonical Git common directory、Git inventory、branch 和 root/admin identity。数据根与父目录拒绝 symlink/junction 与路径逃逸；managed 路径的外部别名拒绝激活，内部 junction 逃逸 cwd 也拒绝。当前目录别名仍被识别为 in-use，不能误删。

创建、打开、归档、移除和项目激活/删除共用串行边界；异步 Git 校验后，在实际修改前再次检查 generation 和 busy 状态。HTTP 控制请求必须携带后端返回的 contextGeneration。nonce 五分钟过期，最多保留 32 个，使用一次即失效。列表读取不启动 Pi child；不会因打开面板无限 spawn。

状态为 `creating → healthy / unavailable`；健康读取可判 `locked / changed / missing`，移除后保留 tombstone `removed`。archive 是独立标记。曾可用的工作区失去身份后更换 epoch 并锁定 invalidated，路径重新出现也不自动接管。启动重新读取 Git 与 manifest，不信任旧 PID。manifest 超限（1 MiB / 256 记录）、损坏或登记不明时保守拒绝且不覆盖文件。

当前 worktree 被外部删除/替换时，控制请求和五秒健康监测撤销 cwd、重启/关闭原执行线并撤销 Managed Process 权限；不自动退回主工作区。保留原分支和登记历史，可切回主区，在丢失行选择「以此分支新建」，确认源 commit 后建立新的受控工作区。此操作恢复已提交内容，不承诺找回外部删除的未提交文件。不会自动 Git prune 或强行清理外部目录。

## 验证入口

- `npm test` 包含 lifecycle / HTTP / UI 三套新回归；仅临时真实 Git、HTTP 与 jsdom fixture，无网络、无真实 Pi/账号。
- `npm run test:worktrees` 聚焦上述三套。
- `npm run test:worktrees-live` 为 opt-in：真实 Git、production server、Electron renderer/preload，隔离的 RPC shim；验证 A/B 创建、打开/切回、归档、dirty 拒绝、外部删除、branch 冲突、Tab/Shift+Tab/Escape/焦点、三种分辨率与 125% 缩放，截图在 `.shots/p32-2/`。

Git 命令使用已有 bounded runner、结构化 argv、shell:false、十秒 timeout、1 MiB 输出限制；移除继承的 `GIT_*` 重定向环境，禁用 hooks/fsmonitor/submodule recursion。错误返回稳定闭集 code/中文说明，不将原始 Git stderr 或用户环境写入 UI/诊断。Browser 和 Process 权限模型保持原实现。

## 已知限制

P32.2 没有并行 coding task、单 session Stop、独立 Browser view/process scope 或 30 分钟并发压力测试；这些是 P32.3 验收内容。本机真机证据仅 Windows，POSIX 需在对应平台运行相同 fixture/Electron 检查。外部 worktree 仅发现，不认领、不移除。detached 整合目标、dirty/ignored 内容、复杂 symlink/submodule 均优先拒绝自动移除。部分创建失败保留 journal、分支/目录供人工检查，不尝试未知路径递归删除。登记 tombstone 也计入 256 上限，尚无自动垃圾回收。
