# 供应商管理 P3-C 实施记录

C 从 `a1c25e1c4cc5ea05c98abd14a6db3b840a5a5a2a` 开始。P3-B 在 PR #65 合入 `main`，该 PR 的 CI 通过 8/8。 [PR #65](https://github.com/HYJ1817/pi-gui/pull/65) · [B 的 PR CI](https://github.com/HYJ1817/pi-gui/actions/runs/42504861035)

## 首段变更

- 生产 OAuth 路由改读共同的同步状态。认证成功后，Classic 和独立 Runtime 保留当前生命周期。移除供应商同步路径中的 `closeAll`、自动 `rpc.restart` 和全局同步命令阻拦。应用更新和工具安装继续使用各自的维护生命周期。 [服务接线](../server.js) · [OAuth 状态](../server/provider-auth.js)
- 认证写入在原有租约内更新不含秘密的待应用代次。开始过原生调用且已确认停止时保守登记待应用，OAuth 成功仍以原有安全回读为准。未知停止结果保留现有未决记录。重新打开 store 可读取代次，P1 配置 revision 不变。 [配置存储](../server/provider-config-store.js)
- 管理与 OAuth 快照共享状态来源。既无提交变化又无未决认证时返回 `idle`。有待应用版本但无活动 Runtime 时返回 `pending`，OAuth 保留独立的凭据写入结果。显式 OAuth `/sync` 返回当前事实。此首段没有资格判定 Runtime 为 `applied`。 [同步状态](../server/provider-config-sync.js) · [管理投影](../server/provider-management.js)
- 工作区失效可以撞上异步 Runtime factory。Registry 现在先收回 owner，再等迟到的 adapter 完成清理，最后释放工作区租约和进程槽位。 [Registry](../server/runtime-registry.js)

## 验证

离线红灯先复现三项事实。无会话的真实 HTTP OAuth 流返回 `synced`。已结束的 OAuth 写入在重新打开 store 时没有可读取的待应用代次。工作区失效在 factory 未结束前释放了租约。修复后，OAuth 登录和退出分别通过回读确认，运行态仍为 `pending`。迟到的 adapter 不启动，仅清理一次。

| 验证 | 结果 |
| --- | --- |
| OAuth 和管理 | 源码后端离线 OAuth 122/122，含 HTTP 登录、退出、同步状态与显式重试。管理专项 97/97，含跨 store 恢复和配置 revision 断言。 |
| 同步和 Runtime | 认证同步 41/41，Registry 36/36，Runtime HTTP 12/12，Session Runtime 7/7，模型 52/52，Runtime 草稿 42/42，资源清理 16/16。 |
| 防护与测试计划 | 服务器安全 39/39。现有 canonical 计划仍是五组 241 条命令。 |
| 产物 | 使用本机 Electron ZIP 离线重建桌面包和 SEA。打包的 Electron 后端运行离线 OAuth 专项 122/122。 |
| P2 回归 | 网络 39/39、开窗 5/5、私桥 28/28。首次桌面运行在 Chromium 截图处遇到 `UnknownVizError`。使用权限合格的系统临时目录单独复跑，桌面 50/50。两次正常沙箱均启动失败，桌面结果来自 `--no-sandbox` 回退。 |

Claude Code 的定向审计确认了 owner 和文件身份的现有边界，并指出 factory 迟到泄漏。后续逐 Runtime 回读仍须独立证明当前 `sessionFile` 的对象身份，因为 Registry 可以先获得原生会话 ID，再异步核对文件位置。

## 逐 Runtime 同步与重试

- [配置证据](../server/provider-config-store.js) 从一致的权威文件快照提取代次、原生版本与预期目录。凭据文件只读取文件身份元数据。配置事务持久记录新代次和已移除的自定义模型，重启后仍可核验。GUI 选择、排序和显示名变更可以复用已有原生证据。
- [RPC 桥](../server/rpc-bridge.js) 在实际 spawn 边界捕获版本。Classic 绑定工作区代次、bridge run 和会话切换 epoch。Registry 绑定当前 owner 与已固定的会话文件身份。私有回读只接受匹配命令且 `success:true` 的原生应答。
- [协调器](../server/provider-config-sync.js) 逐实例回读状态、可用模型与思考等级，发布前复核 owner、会话文件、版本和目录。旧进程、忙碌会话、缺少正面目录证据或证据过期保持 `pending`。正常启动、恢复和空闲事件驱动核验。同步不启动休眠会话、不重开活跃会话、不改变模型或思考等级。
- [管理 API](../server/provider-management.js) 的 `/sync` 按 revision 和 requestId 幂等受理，HTTP 202 返回 operationId。轮询读取当次 `result.sync`，其中 `pending` 代表本次核验完成后仍有待生效的目标。P25 只有在存在当前目标且全部适用目标确认 `applied` 后才展示 `synced`。 [前端合同](provider-management-frontend-contract.md)

独立审查发现受理阻塞、异步快照混版与 Classic 私有切换复用旧证据三项问题。修复后，同版快照和 202 轮询夹具通过，私有切换的派发与迟到成功回执均使旧证据失效。独立临时夹具还验证了首次回读前替换同名会话文件时拒绝已固定的文件身份。复核未发现剩余阻断项。

实际源码后端配离线 Pi 1.5.0 协议夹具验证三条路径。正常启动后进入 `applied`，GUI 元数据变更后仍保持 `applied`，原生配置变化后旧进程返回 `pending`。夹具进程计数始终为 1。全程使用临时目录与回环管理 API。

另用真实 Registry、Session Runtime 和进程 guardian 启动两个离线 RPC 夹具。提交新代次前启动的 A 保持 `pending`，按新代次启动的 B 进入 `applied`。显式关闭并恢复 A 后两个目标均为 `applied`，B 的进程启动次数始终为 1。只读同步期间，现有会话仍通过原有模型守卫发送，停止仍须等待 Pi 的权威确认。两条既有回归已按此行为验证，分别为 12/12 和 17/17。

## 验证及回滚边界

P3-B 合并提交的 [main CI](https://github.com/HYJ1817/pi-gui/actions/runs/42507004293) 已成功。P3-C 最新行为提交为 `b8414597403435bf066a82848dba18149b0e4d33`。`cb7b9d98348e39bbde6920b301e58317d49ddf1c` 仅更新发送与停止回归。

| 最终专项 | 结果 |
| --- | --- |
| 管理和同步 | `test:provider-management` 复跑 100/100，`provider-auth-runtime.cjs` 50/50。首次管理专项的一项旧凭据隔离用例返回 `config_unsafe`，相同生产代码的复跑未复现。 |
| 桌面与 SEA | 离线重建成功，`test:app` 26/26，`test:exe` 49/49，打包后端 OAuth 122/122。 |
| P2 | 网络 39/39，开窗 5/5，私桥 28/28，CredentialSheet 50/50。正常 Chromium 沙箱启动失败，交互结果来自 `--no-sandbox` 回退。 |

## 最终 canonical

最终五组在同一代码 SHA `cb7b9d98348e39bbde6920b301e58317d49ddf1c` 上完成。每组记录的 `planTotal` 都是 241，计划摘要都是 `17203f3fb0d3ffa839168ccbbe7ed2bacb02545d2542a3e33215c54346a21524`。逐条复核命令顺序、`status=passed`、`exitCode=0`、无 signal、无执行错误和终态时间后，241/241 条 canonical 叶子全部覆盖，没有待执行或 running 记录。

| 分组 | 通过/计划 |
| --- | --- |
| `core` | 165/165 |
| `ui` | 24/24 |
| `security` | 27/27 |
| `native` | 4/4 |
| `faults` | 21/21 |

`node scripts/run-test-group.mjs --validate` 输出 `test-plan: 241 canonical leaves; groups core, ui, security, native, faults`。本地结果没有 GitHub `runId`、`runAttempt` 和 `event`，因此不能冒充 `summarize-ci-results.mjs --require-complete` 的 CI 证明。最终 PR 的 canonical job 与 `ci-gate` 还必须独立通过。

第一次 canonical 预检因主工作区尚未执行 `npm ci`，在 `jsdom` 处出现 `MODULE_NOT_FOUND`。按现有锁文件完成 `npm ci` 后，仓库依赖文件没有变化。首次重跑又遇到本机 PowerShell 执行策略拒绝仓库内固定测试脚本。最终复跑只在测试进程设置 `PSExecutionPolicyPreference=Bypass`，没有修改系统策略或仓库脚本，之后五组全部退出 0。

本机现有套件仍有 21 条断言因环境能力缺失未执行，均不计作通过。其中 3 条是普通用户无法创建 symlink，18 条是当前令牌没有 `SeSecurityPrivilege` 的真实 SACL 研究矩阵及非空 SACL 保留检查。P3-C 的同步、会话身份、版本见证和运行时回读结论不依赖这些跳过项。

当前代码与独立复核未发现 Blocker 或 Important 问题。合并建议以最终 PR CI 的 8/8 成功和精确 SHA 证明为准。

证据不足时保持待同步，用户可在正常生命周期点重新打开会话。手动重试始终只读，运行时不提供自动重开资格分支。关闭管理开关可停用新管理路由，已有 OAuth 同步仍使用非破坏性协调器。代码回滚应保留 C 对新增内部元数据的读取兼容，避免旧版本将 C 生成的 sidecar 误判为不可读。跨进程外部修改仍依赖文件见证，真实供应商认证与推理不属于本地回读结论。
