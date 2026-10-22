# T4-B：安全勘察与受阻交付记录

## 结论与提交范围

**结论：T4-B 功能未完成，验收不通过；本轮交付设计与隔离临时实验。**
未增加候选创建/执行 API、按钮、写入器或自动任务；没有将作者自审写成独立审查。
阻塞依据是 [设计](T4-B-design.md) 中可复现的输入授权/完整性和结果归因缺口，不是测试耗时或缺少 OS 沙箱。
按用户第十四节允许的受阻交付路径停止可写产品实现，没有降低约束继续启动 Agent。

- 开发基线及未变的最终产品行为 SHA：`03a223d7ac5f69f33a359e51f95905bfb07253b8`。
  本轮没有新的产品行为提交；后续本地提交仅包含下列文档和 opt-in 实验材料。
- T4-A PR #20 已正式合并，head `139f5de617af60f4fbf86760372b286186f6faed` 的
  [PR CI](https://github.com/HYJ1817/pi-gui/actions/runs/39817859759) attempt 1 成功。
- 最新 origin/main 正是上述基线；[main CI](https://github.com/HYJ1817/pi-gui/actions/runs/39823004520)
  为 push / attempt 1 / completed / success，8 个 job 均 success（含五组测试、测试计划、build、gate）。
  这证明基线，不是尚未实现的 T4-B 功能证明。
- 独立 Worktree：`C:\Users\21022\.codex\worktrees\t4-b-candidate-diff\pi-GUI`；
  分支 `codex/t4-b-candidate-diff`。主工作区保持原 HEAD `724bd48119dd7ba5ba7e1327da12353bd0339ea7`，
  原有四项未跟踪内容保留。不推送、不合并、不改版本/tag、不发布。

## 真实修改文件

| 文件 | 内容 |
| --- | --- |
| [T4-B-design.md](T4-B-design.md) | 模块复用、输入事务/身份/运行/真实 Diff/恢复设计和停止边界；明确区分拟议能力 |
| [README.md](README.md) | 增加未开放的 T4-B 勘察入口，避免误读为当前功能 |
| [probe.mjs](evidence/t4-b-feasibility/probe.mjs) | 显式 opt-in 的安全勘察实验，只创建自有 TEMP 仓库，不接受项目路径，不调用模型 |
| [observations.json](evidence/t4-b-feasibility/observations.json) | 19 项实际边界观察；不含源码、任务正文或绝对路径 |
| [validation.json](evidence/t4-b-feasibility/validation.json) | 准确 CI、定向回归、初始环境失败及未运行项目 |
| 本文件 | 受阻交付、未验证项、审查状态及回滚 |

没有修改 public/、server/、lib/、extensions/、tests/、package.json、锁文件、CI/release 或产物。
实验不是新增 canonical 套件，不改变测试入口，不计入功能通过数；完整日志保留在本 Worktree `.probe/`。

## 设计结果与阻塞证据

| 编号 | 已验证事实与代码入口 | T4-B 影响及处理 |
| --- | --- | --- |
| B1 输入内容确认 | `server/worktrees.js:142` 的 prepare 和 `:166` 的确认比较 HEAD/branch/dirty 状态；P01～P06 中 dirty 文件内容变了但状态字符串未变，仍可创建，候选只有 HEAD | 这是原“从提交创建”的既有契约，不是本轮引入的产品回归；不能当成 T4-B dirty 输入确认。需有界原始字节/index/路径对象证据和落地事务，当前未实施 |
| B2 未授权内容和 Git 转换 | `lib/git.js:933` 的 worktreeTree 用临时 index + add -A；P08～P11 验证真实 index 未动，但一棵树只含 working、自动包含未选 untracked；P16～P18 验证 clean/smudge 确实执行，tree 可与原字节不同 | 不能直接作为经用户选择的输入材料；须先审查整棵 checkout 树、转换及文件类型，并拒绝无法无损表示/需额外授权内容。当前未开放复制或 checkout 产品路径 |
| B3 外部变化来源 | `server/session-tool-scheduler.js:8` 只协调协作写者；P12/P13 让外部进程在 lease 期间实际写入，`server/planner/evidence.js:183` 返回 available；`session-change-bridge.js:251` 仍标外部并发未排除 | 前后树能证明时间窗口变化，不能证明均为候选 Agent 所写。现有契约不能满足“真正产生的修改”及并发失效判断；不将其包装成可靠归因结果 |

B1/B2 是可继续补强的工程缺口；B3 还涉及结果语义和证据契约。
弱 Worktree 隔离本身不是额外门槛：设计明确允许复用现有审批并披露剩余权限风险，
但不能把“无外部写者证据”推断成“没有外部写入”。没有擅自把规格改成仅提供来源未确认的时间窗口 Diff。
若按原规格继续，应先补可验证的来源/并发失效能力；另一种结果语义需用户另行决定。

已确认可复用的安全部分：P07 的一次性 nonce 拒绝重放、P08 的真实 index 不变、
P14 的初始 dirty 不计入 pre→post、P15 的改回输入快照得到空 Diff、P19 的真实 junction 越界拒绝。
实验过滤器是只在自有 TEMP 写 marker 的确定性 fixture，不是恶意命令或真实项目测试。
没有启动真实 Pi、发 Agent 消息、使用用户会话文件或复制账户数据。

## 要求覆盖与未交付能力

- **受控 Worktree/运行身份**：已设计复用现有 Registry、epoch、完整 owner、独立 run ID；候选产品记录/确认事务未实现。
- **dirty 输入**：已证实现有原语不足并定义拒绝规则；实际 dirty 输入导入未实现，不能宣称 staged/working/untracked 全覆盖。
- **执行权限/隔离**：沿现有 Pi RPC、工具审批和 Stop 的复用路径已核对；Worktree 不阻止同权限工具访问原项目。
  不新增全批准、shell 入口、权限旁路或 OS 沙箱承诺。未启动候选 Agent，故无候选权限实测通过结论。
- **真实 Diff**：临时实验采用真实 Git pre/post tree，验证初始 dirty 排除和外部写入混入；没有向用户提供可用的候选 Diff 功能。
- **Stop/崩溃/冲突/恢复**：设计列出中断而非成功、未知应答不重发、身份失效、清理屏障及保留结果；仅原机制的定向回归通过，
  候选关闭面板/跨重启端到端尚未实现验证。
- **UI/兼容**：没有 UI 变更；T3-B/C schema、T4-A 预览、原审批/Stop/Browser/Planner 状态均未修改。
  不引用旧阶段截图或通过数冒充本轮 Electron 证据。

## 本轮实际验证

Windows / Node `v24.22.1`。所有写入试验在 `os.tmpdir()` 自有 fixture；运行完清理 fixture，未保留产品候选工作区。
新开发 Worktree 仅建立指向既有离线 node_modules 的 junction，没有安装或下载依赖。

| 命令 | 本轮结果 | 证明范围 |
| --- | --- | --- |
| `node docs/evidence/t4-b-feasibility/probe.mjs --temporary-fixtures` | 19/19 观察，失败 0、skip 0，退出 0 | 上述缺口及现有正向能力，不是功能验收 |
| `node tests/worktrees.cjs` | 56/56，失败 0、skip 0，退出 0 | 真实临时 Git、身份/nonce/安全移除；本机 8.3 检查实际执行 |
| `node tests/runtime-registry.cjs` | 35/35，失败 0、skip 0，退出 0 | 原 Registry/owner/生命周期 |
| `node tests/evidence.cjs` | 100/100，失败 0、skip 0，退出 0 | 原前后 Diff 与 bounded evidence |
| `node tests/stop-barrier.cjs` | 最终 17/17，失败 0、skip 0，退出 0 | 原 fake RPC/停止与发送屏障 |
| `node --check docs/evidence/t4-b-feasibility/probe.mjs` | 退出 0 | 实验语法 |
| Markdown 相对链接/锚点、`git diff --check` | 120/120 链接/锚点，失败 0；空白检查通过 | 文件导航和空白，不验证候选功能 |

四套现有回归合计 **208 项断言**，未修改/删减旧断言。另计 19 项观察，不合并为功能总数。
首轮 Stop 命令因新 Worktree 缺少 jsdom 在加载阶段退出 1，**0 项断言运行**；
确认原因为本地依赖未连接后复用离线依赖并重跑 17/17。初始失败单列，未当成通过或 skip。

**未运行**：T4-B 完整 canonical、候选功能真实 Electron、候选启动/执行/重启/Stop 完整流程、
Browser/Specs/四档窗口布局、App/SEA 重建和产物验证、POSIX。没有 UI/业务/构建输入变更，
按 [纯文档政策](testing.md#测试执行政策) 不重复本地完整 npm test 或重建；
勘察实验不构成功能行为提交，不以基线 CI 替代未实现功能的证明。无截图，因为没有可诚实展示的候选 UI。

## 自审与独立审查

作者自审：3 项已验证的 T4-B 复用阻塞，0 项被本轮引入并确认的产品回归；全部保持未解决/不开放状态。
核对了 nonce/内容漂移、原 index 和源字节、filter 执行、外部写入混入、路径越界与无 Agent 副作用。
没有将“现有机制按原设计工作”误报成 T4-A 产品缺陷；没有要求用户授权后即可忽略安全缺口。

**独立功能审查：未进行。独立安全/故障审查：未进行。**
沿用户不自行启动子代理/自动并行审查 Agent 的要求，未调用这类审查，也未调用旧的独立 Agent。
本报告不是独立验收；完整 T4-B 未具备合并门槛。

## 回滚、保留和下一步

本轮设计、实验材料及验收说明属同一回滚边界，作为一次本地提交；用 `git log origin/main..HEAD` 定位。
需要撤销时，撤销该文档/勘察提交即可，没有评论 schema、用户文件或版本迁移。
保留开发 Worktree、分支、`.probe/` 原始记录；本轮临时 fixture 已清理，不存在待采纳的候选代码。
未来候选若已写入，关闭预览必须保留，归档/移除继续走原受控确认；dirty/未知身份不得强删。

继续顺序见 [设计第 8 节](T4-B-design.md#8-安全停止边界与继续顺序)。先解决输入事务与结果证据契约，
再实现候选执行/UI，完成独立审查及对应行为 SHA 的完整证明；不能把这份受阻报告当作允许推送、合并或发布。
