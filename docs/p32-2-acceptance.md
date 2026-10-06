# P32.2 验收报告

范围：Worktree 生命周期。用户的「继续 p32.2」作为 P32.1 ADR 批准；本阶段不进入 P32.3 / P32.4。没有推送、合并、版本号变更或 Release。

## 版本与交付

- before HEAD：`2477042ed336d54b35b2ff4215fad6fe466c9c74`（P32.1 文档提交）。
- 最新 main 基线：`30ffad882748264866a9c23c663eae302e975f9e` / v0.22.0，执行前 fetch 核实。
- branch：`codex/p32-worktree-multisession`。
- after HEAD：最终答复给出包含实现、测试和本报告的完整提交 SHA；避免把报告自身 SHA 写成循环引用。
- 实现提交：`8cfdbe2a9f5463311228a1a573a01a8ecc4dc6ad`；测试提交：`d67151f002dc3d3c1907ceb7389deef791e4c599`。
- 功能说明：[worktrees.md](worktrees.md)。

## 架构与原有抽象

沿用 `lib/git.js` 的有界 Git runner、`server/projects.js` 的权威 cwd 激活、原有 RPC child restart、Stop barrier、P29 Browser/P31 Process invalidation、原生 modal/action-menu。没有新第三方依赖、Renderer 重写、Pi schema/RPC 修改、Main/preload 产品修改。

新增 `lib/git-worktree.js` 查询与验证 Git 身份；`server/worktrees.js` 管理 manifest/nonce/health/生命周期；`public/worktrees.js` 从项目三点菜单打开管理弹窗。项目激活与删除纳入同一串行边界，避免删除项目与旧创建请求竞争。原项目排序、数量、折叠键保持稳定；实际 cwd 指向被打开的工作区。Worktree 不自动成为第二个项目行。

与原设想的具体取舍：P32.2 使用最小管理弹窗，不提前建设 P32.4 多会话侧栏；外部 worktree 只读发现；目录丢失恢复为保留分支并重新创建，不认领重新出现的未知目录。data/worktrees 根若在源仓库内，明确拒绝并提示迁移 PI_GUI_DATA，保证创建不会增加 main 的未跟踪工作区内容。

## Identity / 状态模型

目录所有权绑定 canonical Git common directory hash、原项目与子目录 prefix、internal workspace UUID、epoch、branch/source/integration commit、root/admin filesystem identity。控制请求验证后端 workspace generation；不信任 UI 当前 tab，也不用 PID 做目录所有权。nonce 为单次确认，五分钟过期；异步校验后修改前再核对 generation/busy。

`creating → healthy / unavailable`，健康探测补充 `locked / changed / missing`，移除保留 `removed` tombstone；archive 为独立标记。健康身份丢失后更换 epoch、锁定 invalidated；当前执行上下文被撤销，Process/Browser 权限按原 lifecycle 失效，不回退到 main。恢复时读取真实 Git inventory/manifest，不信任旧 child。

当前仍是一个 Pi child/bridge、一个聊天执行线。create/list/archive 不启动额外 Pi；open 复用顺序切换。并发 registry、writer lease、per-session Browser/Process scope 和 30 分钟压力测试留到 P32.3。

## 验证结果

| 检查 | 实测 |
|---|---|
| 修改前基线 | npm test 66 套件，exit 0 |
| 最终 npm test | 69 套件，exit 0；新增 3 套，合计 85/85 |
| Worktree lifecycle | 55/55，Windows 临时真实 Git |
| Worktree HTTP | 14/14，真实 router/auth/projects/HTTP |
| Worktree UI | 16/16，状态/nonce/迟到结果/键盘焦点 |
| Worktree Electron | 40/40，Electron 44.4.3，production server + 隔离 RPC shim，11 截图，0 renderer errors |
| P30 Electron/harness | 161/161，37 截图；Browser/Changes、搜索/折叠、palette/快捷键、hover/focus 与缩放 |
| 原 smoke / modules / interactions / sidebar menu | 1338/1338、161/161、117/117、37/37；原断言未减少 |
| P29 Browser Stop / authoritative barrier | 9/9、16/16 |
| P31 Process regressions | manager 28/28、tools 25/25、Stop 10/10、UI 16/16、runner Windows/POSIX protocol 24/24 |
| Electron build | build:app -- --rebuild，exit 0；EXE 234.9 MB，整包 327.6 MB |
| 单文件 EXE build | build:exe，exit 0；94.3 MB |
| 打包后无 node_modules 检查 | app-check 26/26，使用 Windows 动态端口范围外的已验证空闲端口 |

交付产物 SHA-256：Electron `resources/app/server.cjs` 为 `f3ce65c4befaabd03b55d2679adeab0ea275e82d9c3256e91a68a763d06f8c24`；单文件 `build/Pi GUI.exe` 为 `eacff46f9185ff0633de677a4e8ca99faf1841fe41d284edab42eae192749600`。这些是本机本阶段构建证据，不是已发布资产。

生命周期实际覆盖 A/B 分离、主区 dirty/index bytes 不变、staged/untracked/ignored/unmerged/locked/nested Git 拒绝、合并后 clean 移除且保留 branch、duplicate create/remove、branch 冲突、path 占用、源/分支输入注入、stale epoch/generation、异步换代、子目录项目、junction 两向逃逸、manifest 损坏、非 Git、外部只读 worktree、禁用 checkout hook、data 在仓库内拒绝。

HTTP 覆盖 token/Origin、body 上限/格式、authoritative generation、只重启一次、原项目映射、活跃移除拒绝、外部删除后的 prompt 503 且不调用 rpc.send、移除父项目关闭活跃 worktree 而不删除文件。真实 Electron 另验证了后端重启后发现 archived B / missing A，主 cwd 与项目顺序稳定。

## 真机截图与键盘

本地生成于 `.shots/p32-2/`；`report.json` 包含 viewport/卡片 bounds/错误数。截图文件由 opt-in 测试生成，不纳入版本库。

| 关键状态 | 截图 |
|---|---|
| 仅主工作区 | [main-only](../.shots/p32-2/main-only-1440x900.png) |
| dirty main 创建风险 | [create-risk](../.shots/p32-2/create-risk-1440x900.png) |
| A/B 工作区列表 | [workspaces](../.shots/p32-2/workspaces-1440x900.png) |
| 当前工作区 | [current](../.shots/p32-2/current-worktree-1440x900.png) |
| 归档但文件保留 | [archived](../.shots/p32-2/archived-1440x900.png) |
| dirty 移除拒绝 | [dirty refusal](../.shots/p32-2/dirty-remove-refused-1440x900.png) |
| 外部删除 | [missing](../.shots/p32-2/externally-missing-1440x900.png) |
| 分支冲突 | [branch conflict](../.shots/p32-2/branch-conflict-1440x900.png) |

1280×800 / 1440×900 / 1920×1080 三个列表截图均通过页面与 dialog bounds 检查；1280×800 的 125% 缩放（CSS viewport 1024×640）同样无溢出。原 P30 检查还覆盖 150% 缩放。

真实键盘验证：Tab / Shift+Tab 循环、Escape 取消风险而不 create、菜单 Escape 只收菜单并返回触发点、弹窗 Escape 返回项目菜单、异步归档刷新焦点留在弹窗内。修正了 modal 菜单被遮罩遮住，以及从菜单打开弹窗后原触发点焦点丢失的问题。

## 失败样本与修正

- 独立只读审查用真实临时 Git 复现了嵌套 `.git` 删除、外部 alias 归属绕过、异步换代创建和内部 junction cwd 逃逸，4/4 修复并独立复测关闭。
- 旧 smoke 按菜单索引找移除项目、两个 Stop VM fixture 缺少新注入参数：更新作用域/动作定位与注入，1338 / 9 / 16 原断言数量不减少。
- 早期 fixture 的 Windows Git null-device / CRLF 设置、未就绪 Pi shim、首屏尚未完成权威激活以及 resize 后 native pointer 坐标使样本失败；fixture 改为隔离配置、私有 RPC ready、权威 active project 和 CDP 的真实输入派发。没有将这些样本算作通过。
- 两个构建并行清理共享 build 目录导致图标/暂存缺失：改为串行重建后复测。app-check 默认端口占用、随机端口落入本机动态范围导致 EACCES：只换到范围外的已验证空闲端口，不停止未知进程。

## 已知限制与阶段门

本机只运行 Windows 真 Git / Electron；没有实际 POSIX kernel 证据，已有 process runner 的 POSIX protocol fixture 不代表 POSIX 真机。真实模型并行 coding、单 session crash/Stop、独立 Browser/Process 与持续 ≥30 分钟压力测试尚未进行，不能声称 P32.3 已通过。

外部 worktree 不认领；dirty/ignored、nested Git、symlink、未知合并目标默认拒绝删除。部分创建失败保留 journal/分支/目录，不能自动恢复被外部删除的未提交内容。登记包括 tombstone 的 256 上限、100,000 项移除扫描与五秒健康轮询均为保守初版策略，无自动 GC。

本阶段完成后停止，等待 ChatGPT 验收 P32.2，不开始 Multi Session Runtime。
