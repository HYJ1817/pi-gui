# T4-B：候选修改开发与验收记录

## 结论和追溯

本地开发与验证已完成；独立外部功能、安全和故障审查仍未完成。作者自审不能代替独立审查，
本记录不构成允许合并或发布。只在独立 Worktree 本地开发，未推送、合并、修改 main、tag 或版本。

- 开发基线：`03a223d7ac5f69f33a359e51f95905bfb07253b8`。
- [T4-A PR #20](https://github.com/HYJ1817/pi-gui/pull/20) 已合并，head
  `139f5de617af60f4fbf86760372b286186f6faed` 的
  [PR CI 39817859759](https://github.com/HYJ1817/pi-gui/actions/runs/39817859759) attempt 1 成功。
- [main CI 39823004520](https://github.com/HYJ1817/pi-gui/actions/runs/39823004520)：准确基线 SHA，push、attempt 1、completed/success，8 job 成功。
  以上只证明基线，不冒充新增功能证明。
- 产品提交 `9edd29c`，测试与入口提交 `9bcc1fd`；最终行为提交
  `16fd026657e7272532afec1ef94be7eb3c1aeaa8`（`e2b3516` 修复旧 owner，最终沿用静态导航入口）。后续文档提交不改变行为。
- `f88aeb7` 只稳定慢启动夹具，`c82d7d7` / `fdfe3ea` 只补旧 Stop 夹具装配依赖；均不改产品行为或测试链。
- 分支 `codex/t4-b-candidate-diff`；工作区 `C:\Users\21022\.codex\worktrees\t4-b-candidate-diff\pi-GUI`。
- 主工作区保持 `724bd48119dd7ba5ba7e1327da12353bd0339ea7` 及原有四项未跟踪文件。
- 初始设计提交 `4bb1199` 及 [旧勘察实验](evidence/t4-b-feasibility/observations.json) 保留为历史；本次完成后不再以历史阻塞文字代表当前能力。

## 实际改动文件

| 文件 | 作用 |
| --- | --- |
| `lib/candidate-snapshot.js` | 原始输入、Git/文件身份、候选输入落地、实际前后 Diff |
| `lib/candidate-review-model.js`、`public/html-escape.js`、`public/diff.js`、`public/util.js` | 复用原 Diff/区间/任务纯模型及转义，不复制第二套锚点算法 |
| `lib/git.js`、`lib/git-worktree.js` | 既有 Git runner 支持有界 stdin；默认行为不变 |
| `server/candidate-runs.js`、`server/candidate-store.js`、`server/candidate-routes.js` | 预检、单次确认、既有生命周期编排、私有材料、权限路由、恢复与结果资格 |
| `server/worktrees.js` | 后端只读候选 prepare、创建前内容重验回调，沿用原 Registry |
| `server.js`、`server/router.js`、`server/runtime-routes.js` | 组合根接线、同源/owner 授权、忙碌闸门、shutdown |
| `server/review-comment-authority.js` | 私有 scope 附带 workspace cwd；稳定 scope key 不变 |
| `server/session-runtime.js`、`server/session-tool-bridge.js`、`extensions/pi-gui-tool-guard/index.js` | 在原工具 lease 内核对目标/预期结果，不改 Pi 或自动批准 |
| `public/candidate-review.js`、`public/review-task-preview.js`、`public/api.js`、`public/styles.css` | 原弹窗预检/确认/真实 Diff/保留、审批资源同步、失效响应防护 |
| `tests/candidate-{snapshot,store,runs,http,ui,electron}.cjs`、`tests/fixtures/candidate-pi.cjs` | 隔离临时 Git、fake Pi、故障/安全及正常沙箱 Electron |
| `tests/session-tool-bridge.cjs`、`tests/gui-browser-stop.cjs`、`tests/stop-barrier.cjs`、`package.json` | 保留旧断言并补原生包装器、审计顺序及 Stop 夹具依赖；五个候选套件纳入 canonical |
| `docs/T4-B-design.md`、`docs/README.md`、`docs/git-changes.md`、`docs/security.md`、`docs/testing.md`、本文件及 `docs/evidence/t4-b/` | 当前行为、安全、测试入口、导航及少量可追溯证据 |

不改评论 v1/v2、T4-A 语义、Planner 人工验收、Pi RPC schema、原 Stop/审批、Browser 权限、
Git 撤销、安全移除、CI/workflow、release、版本或依赖。

## 数据流、输入和证据

完整设计见 [T4-B-design.md](T4-B-design.md)。选中评论经过后端原 authority/CAS 和完整 Diff 再验证，
绑定 revision、owner、generation、来源原始输入摘要；只读预检不创建任何候选或 Agent。
明确确认后消费一次 nonce，创建前/落地后/发送前重验；原 Registry 提供 workspace ID/epoch，
原 Runtime 提供独立 conversation/native session，run UUID 绑定本次执行。

原 HEAD、index blob/mode、working 原字节分开。仅写候选恢复输入，不改原 source/index。
初始 dirty 为输入而不是 Agent 修改。原 untracked 拒绝，ignored 不复制；边界/链接/属性/凭据/冲突/
容量不明均拒绝。上限为 512 文件、1 MiB/文件、总 8 MiB、遍历 20,000 项。

候选 cwd、原工具审批、Scheduler 和 Stop 均沿既有机制；一次确认只发送一次 prompt，无自动重试。
原生工具的目标、预期字节和实际前后文件可核对，未知 shell、外部/身份变化或证据缺口标为
「结果无法可靠确认」。Worktree 不能阻止同用户进程访问原项目，不是 OS 沙箱，也不声称任意写者完整归因。

Diff 来自输入到清理确认后实际磁盘的 Git 文件比较，含新增/删除/重命名/二进制/权限模式及明确截断。
执行成功与结果资格分开。测试中的 HEAD `1 → 2` 已是 dirty 输入，候选真实结果为 `2 → 3`。
原项目 SHA、原 index 字节、原 Composer 草稿保留；不存在应用/合并按钮。

私有 `candidate-runs` 材料限 20 记录、24 MiB/记录，排他锁、格式/摘要和原子替换，不能作为诊断上传。
关闭面板不删除或停止已批准执行。Stop 要等原屏障，清理未知不显示完成。
重启恢复已持久结果，活跃旧记录改中断，不重发、不补造 post。崩溃 writer lock 不自动清除。

## 验证

| 层次与入口 | 当前结果 |
| --- | --- |
| `node tests/candidate-snapshot.cjs` | 25/25，通过；0 失败、0 skip |
| `node tests/candidate-store.cjs` | 13/13，通过；0 失败、0 skip |
| `node tests/candidate-runs.cjs` | 最终行为 26/26，通过；0 失败、0 skip |
| `node tests/candidate-http.cjs` | 10/10，通过；0 失败、0 skip |
| `node tests/candidate-ui.cjs` | 9/9，通过；0 失败、0 skip |
| `node tests/session-tool-bridge.cjs` | 6/6，通过；原四条保留，增加两条 |
| `node tests/candidate-electron.cjs` | 最终行为 25/25，0 失败、0 skip，正常沙箱 |
| 完整 canonical | **184/184 叶命令成功退出**：core 113/113（第 1～69 项成功记录 + 第 70～113 项续跑）、UI 24/24、security 27/27、native 2/2、faults 18/18。首次失败及补跑过程见下文；其中 8 条环境断言按测试自身规则跳过，不计为通过。这不是宣称此前失败的串行 `npm test` 已通过 |
| 离线 `npm run build:app -- --rebuild` | 最终行为重建成功；同时生成 SEA，325 资源，SEA 97.9 MB、App 整包 328.8 MB |
| `npm run fixtures`、`node tests/app-check.cjs`、`node tests/exe-check.cjs` | 最终 App 26/26、SEA 49/49，0 失败、0 skip |
| `node tests/candidate-packaged.cjs` | App/SEA 实际 HTTP 静态资源摘要、API 授权及随包 guard：21/21，0 失败、0 skip |
| `python docs/evidence/t4-b/check-links.py`、产物摘要 | 六份文档 172/172 相对文件/锚点检查，0 失败；`git diff --check` 通过。产物与新模块摘要见 [结构化记录](evidence/t4-b/artifacts.json) |

所有写入测试仅使用临时 fixture，未用真实用户项目或真 Pi/模型。
Windows 的共享 Electron 位置在 JS 前异常退出；同版本 44.4.3 本地缓存离线解压至本 Worktree 的私有运行目录，
字节摘要一致，通过 command-local `ELECTRON_OVERRIDE_DIST_PATH` 使用，未改共享依赖、ACL、产品沙箱或下载依赖。
正常沙箱为 `sandbox: true`，未使用 `--no-sandbox`。独立 NSIS/真实模型端到端不属于本轮验证，不冒充通过。

Electron 走完整路径：存评论 → T4-A 选择/预览 → 预检 → 明确确认 → 原工具审批 → fake Pi 实际写候选 →
真实 Diff → 重启后恢复 → 再次明确执行 → Stop → 两份候选保留。验证 720/900/1200/1536px，
Specs + Changes、Browser + Changes，原生 WebContentsView 在弹窗期间脱离、关闭后恢复。
代表截图：[预检](evidence/t4-b/01-preflight.png)、[原工具审批](evidence/t4-b/02-approval.png)、
[Browser 分屏实际 Diff](evidence/t4-b/03-browser-diff.png)。
结构化 [Electron 结果](evidence/t4-b/electron.json) 和 [最终产物字节数/摘要](evidence/t4-b/artifacts.json) 可复核；
摘要检查通过不替代真实执行证明。

## 自审发现与处置

本节是作者功能/安全/故障自审，非独立审查。已补失败复现后修复：

1. 后端创建的 Runtime 未先同步资源时，前端按原安全规则丢弃未知帧，审批不可见；改为原资源同步与事件回放。
2. 清理未确认就先显示 completed；改为等待既有执行线清理并持锁到结束。
3. Stop 的 settled 早于权威停止回执；pending Stop 不凭 settled 解除。
4. 最终快照取在清理前会漏掉收尾写入；移到清理确认后，晚写入为不可归因结果。
5. 快照读取期间新出现的 untracked 会遗漏；末次重新枚举和复读（包括缺失文件）后才认为完整。
6. 原生撤销包装器使用 file URL 路径，工具来源识别需标准 fileURLToPath 并只在 Windows 折叠大小写。
7. 仅哈希内容漏掉同字节文件替换和权限位变化；加入文件身份/模式及 Diff mode 头。
8. promisor 配置可能隐式补对象，非 UTF-8 可能渲染替换字符；前者拒绝，后者只显示非文本变化。
9. Git 查询会刷新 index stat/cache 字节；改为执行证据比较完整逻辑 index 和文件身份，缓存刷新不误报，真实暂存变化仍失效。
10. 持久 scope 相同不意味着 owner 相同；确认同时比较后端 HMAC token 并复核原 scope 的完整 owner。
    guarded 复现先失败「old nonce reached create」，修复后在创建之前拒绝。首次完整验证因此主动中止，不计为通过。
11. 已完成记录缺少身份字段不能恢复成功；读取时要求完整 retained 身份，查看时还需既有 Registry 仍登记该候选。
12. 完整 canonical 在 UI3 集成失败：新增动态导入不符合既有测试链接器契约。改为既有静态导航入口，
    不修改链接器或旧断言；UI3 23/23、原 smoke 1338/1338、UI2 48/48 定向通过后重新完整验证。

验证夹具修正另列：等待评论权威 ready 后再打开恢复弹窗；重载用 await loadURL；活动 Stop 先确认 fake Pi
实际收到 prompt，不能把发送前已安全停止误判为漏发；Electron 主进程显式保留失败退出码。
模块检查曾拒绝 server 直接 import public，改由 lib 纯模型入口复用，119/119 回归通过。
截图曾出现帧尚未就绪的 `UnknownVizError`，夹具等待两帧后采集；禁止窗口关闭时覆盖失败退出码。
冻结行为后的串行测试曾因启动等待仅五秒而断言 0 次发送，并被夹具清理 EPERM 掩盖；
用确定的 7.5 秒延迟复现，改为有界状态等待、保留原异常、等待未决操作收口后清理，发送次数断言不变。
分组故障套件还发现两份生产装配 VM 缺新候选依赖，补空闲候选的同形依赖，不扫描共享 TEMP 数据、不改 Stop 守卫；
原浏览器 Stop 12/12、权威 Stop 17/17 定向通过，再续验故障组。

canonical 叶命令全部成功退出，但 security 组的 SACL witness 在本机因缺少 `SeSecurityPrivilege` 跳过 8 条环境断言；
它们不计入通过，也没有被写成已验能力。

完整 canonical 首轮在 core 第 50 项 `native-provider-quota.cjs` 和 faults 第 2、3 项旧 Stop 夹具处失败；
修复测试夹具后，core 从第 1 项重新建立连续 69 项成功前缀，再由 resume 脚本完成第 70～113 项；
security、native、faults 同样只补主日志未完成的断点，最终组内 184 项全部到达成功终态。
早先的 Windows `spawn EINVAL` 是续跑辅助脚本参数问题，修复后重跑该断点，不是产品测试失败；所有原始日志保留。
完整失败/通过日志保留 Worktree `.probe/`，只提交少量结构化摘要和截图。最终验证 SHA `e76ca6c6171f7005b74ded2aa887ad0de368a618` 只包含夹具对齐；产品行为 SHA 仍为 `16fd026657e7272532afec1ef94be7eb3c1aeaa8`。

## 限制、独立审查与回滚

未支持：来源 untracked、非根项目、特殊 Git/属性/链接/凭据/超容量输入；任意 shell/模糊 edit 的可靠写者归因；
自动解除崩溃锁、自动续跑、实时多实例协作、应用到来源项目。只有 Windows/fake Pi 实测，其他 OS/真实模型不冒充验证。
同用户绝对路径/shell 风险继续存在，提示词不是强制权限隔离。

独立功能、安全及恢复审查：**待外部验收**。遵从用户「不用子代理」，没有启动独立 Agent，也没有自审冒名。
代码验收/允许合并/允许发布均尚未取得，不因测试通过自动升级。

回滚：按本地产品、测试入口、文档提交分别 revert，随后重建 App/SEA。候选 Worktree、分支、私有材料保留，
不随代码回滚删除。恢复前先核实 registry/root/admin 身份及不存在运行子进程；未知身份保留不动。
writer lock 只在人工确认相关实例/子进程全部退出并保全证据后处理。候选清理沿既有预检和明确确认，
不得强删 dirty/ignored 或使用危险 reset/clean/force remove。后续采纳/冲突处理留给 T4-C。
