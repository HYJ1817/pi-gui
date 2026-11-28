# HTML artifact 进程 fixture 局部修复记录

- 日期：2026-11-28。
- 目标：处理持续阻塞 faults 组首个命令的离线进程测试，不重开 Visual Replies P3 专项。
- 基线：`a6eceeba0763c43f0b3e32fd02cb5b59f298f766`；分支 `fix/html-artifact-process-fixture`。
- 证据范围：基线加 `server/runtime-registry.js`、`tests/runtime-registry.cjs`、`tests/html-artifact-process.cjs` 的本次 diff；行为与 Registry 回归提交为 `c74e115fc634d2cad144aac3ee00c43e7398c50c`。原始报告和 process fixture 的交付提交为 `08c8a6cde42262679a393e546ddea4f36e7b681e`；提交前后代码树未改变，不将提交操作计作重新运行测试。
- 风险：高，涉及 Runtime 命令执行状态记账；没有修改认证、权限检查、Pi 本体、会话 schema 或 CI 清单。

## 勘察与改动

原测试实际运行生产 server、Registry、guardian/RPC、bundled HTML 扩展、不可变存储与认证 HTTP。普通 prompt 还会读取文件采集 evidence store；原测试没有声明是否需要采集，因而与 Windows 原生隐私校验耦合。

历史 PR/main CI 在原测试第 141 行得到 `409 !== 200`，但没有记录公开拒绝码或底层原因。本机同基线原用例为 **8/8**；历史 ACL 调查只能作为线索，不能据此认定当前 CI 的具体根因或宣称只是环境问题。

本次保留原有 HTML 发布、原生持久化前 `reference_pending`、精确字节/digest、跨 owner 拒绝、关闭和重启恢复断言，新增：

1. 在 `os.tmpdir()` 的 fixture 中将 `data/revert-evidence` 建为普通文件，真实制造不可用的采集 store；不使用权限 mock、加载钩子或固定成功结果。
2. 证明未显式关闭时普通 prompt 被拒绝，公开采集摘要为 `evidence_privacy_unavailable`，原生会话内容不变。
3. 通过既有 `/gui-capture disable` 用户命令关闭本次采集，再执行全部 HTML artifact 集成路径。关闭设置未持久化的产品告警和重启语义保持不变。
4. 修复这条命令的相邻已证实缺陷：Session Runtime 直接处理关闭命令、不发给 Pi，但 Registry 原来仍登记 pending turn，导致下一条 prompt 永久得到 `runtime_busy`。仅对这条后端本地命令跳过模型轮次记账，保留 owner/workspace、busy、Stop 和编辑事务闸门。
5. 失败诊断只记录公开固定 reason/code，不保存原始错误、HTML、token 或绝对路径。

没有证明原 CI 的 409 必然来自 evidence store；这次改动消除了本测试对该无关 store 的依赖，并验证实际失败时的显式退出路径。GitHub runner 上仍待验证。

## 本地定向证据

环境：Windows 11 `10.0.26200`，Node `v24.22.1`；全部使用离线临时 fixture，不调用真实 Pi、模型，不写用户项目数据。以下最终运行均退出 0：

| 命令 | 实测结果 |
| --- | --- |
| `node tests/html-artifact-process.cjs` | 9/9；16,921.2422 ms；0 skip |
| `node tests/runtime-registry.cjs` | 55/55；容量 fixture 1,305,658 字节、270 条记录、0 个真实 child |
| `node tests/session-runtime.cjs` | 10/10 |
| `node tests/session-change-bridge.cjs` | 35/35 |
| `node tests/session-change-tools.cjs` | 31/31 |
| `node tests/session-change-store.cjs` | 36/36；包含真实本机 ACL 和 foreign child ACL 拒绝；100-operation replay 711 ms、object privacy checks 2 |
| `node tests/runtime-http.cjs` | 16/16 |
| `node tests/runtime-changes.cjs` | 60/60 |
| `node tests/runtime-conversation.cjs` | 119/119 |

合计 9 个定向命令 **371/371**，不代表完整 canonical。HTML process 从 8 项增加到 9 项，Registry 从 51 项增加到 55 项；没有删除断言或增加 skip。

首次失败记录：仅给原 fixture 增加显式关闭命令、尚未修 Registry 时，process 测试为 2 通过 / 6 失败，首错为 `fixture 1 prompt admission: runtime_busy; capture: disabled`，后续为级联失败。修复记账后原集成流程 8/8；增加 store 故障与 fail-closed 断言后最终 9/9。

## 构建与审查

- `npm run build:app -- --rebuild`：使用已有本地 Electron ZIP 离线构建，退出 0；生成 SEA 116.2 MB、Electron 入口 234.9 MB、整包 350.1 MB。
- `build/server.cjs` 与 `dist-app/Pi GUI-win32-x64/resources/app/server.cjs` 字节比较一致，均为 **4,019,328 字节**，SHA-256：`5132645d76b099ee327937cc10cdaa80efa01160e7e2b3ffbbad69f719788ef4`。
- 构建已有的 PDF 字体许可待审提示仍存在，SEA 注入工具也报告原签名警告；本次没有发布或签名资格结论。
- 一次独立只读复审完成：Blocker 0 / Important 0 / Nit 0；明确指出 tool guard 不可用场景与 Windows ACL 慢超时仍未由本 fixture 证明。
- 额外独立安全/故障复核未完成：子代理服务返回 HTTP 429 用量限制；未换模型或反复重试。作者故障注入不替代该项独立审查。
- `git diff --check`：通过。

## 限制、回滚和交付状态

- 未运行完整 `npm test`；完整证明与 GitHub runner 修复效果均为**待验证**，以交付提交后实际 CI 为准。
- 没有 UI/CSS 改动；未运行新一轮 Electron 界面、真实 Pi/模型、安装升级验收，重建与字节一致不等于这些专项通过。
- Runtime 的关闭命令仍须先通过既有 tool guard；本次不改变该顺序，也不放宽安全失败。
- 回滚边界：先回退 process fixture 及本报告交付提交，再回退 `c74e115fc634d2cad144aac3ee00c43e7398c50c`，然后重新离线构建。未改用户数据或持久化 schema，保留原有未跟踪文件；没有需要数据迁移的写入。
- 开发：局部实现完成；代码验收：待额外安全复核与完整证明；合并：用户已授权本次直接合入 main；新 PR/发版：不执行。

## 后续定位：HTML 存储冷启动查询（2026-11-28，本地验证、合并获准）

以下是以 `08c8a6cde42262679a393e546ddea4f36e7b681e` 为基线的后续工作区证据，不改写上面的历史交付结论，也不继承上一次提交、推送或合并授权。

### 远端实际结果

准确 SHA 的 [main CI，run 46119235457，attempt 2](https://github.com/HYJ1817/pi-gui/actions/runs/46119235457) 已结束：core、security、native、ui 与打包检查通过，faults 及 CI gate 失败。faults 的首个命令仍是 process 测试，结果为 **3 通过 / 6 失败 / 0 skip**；首错已从 prompt admission 409 推进到 `production extension must publish a typed ref`，其余缺少引用的错误为级联，不是六个独立产品缺陷。

本轮普通 prompt 的 200 断言与关闭采集子测试已通过，但 Runtime 会删除失败工具结果，旧日志没有 HTML 扩展的固定拒绝码。因此不能声称该轮 CI 的 HTML 失败已被确认为某一个底层原因，也不能声称 `08c8a6cd` 已修复整个 CI。

### 已复现的问题与改动

- Windows HTML store 初次获取自身身份时，原来调用供同步退出路径使用的 `queryProcessIdentitySync`，预算为 2.5 秒，并阻塞事件循环。
- 本机将测试进程及其子进程限制为单核，并运行两个有界 CPU worker：原生同步查询实测 **2,730 ms**，返回 `unknown / query_failed`；同等 3 秒短程负载对比中，旧同步查询为 **2,733 ms**、同样拒绝，新异步真实 store 发布为 **3,490 ms**、成功，期间观察到 **84** 个事件循环 tick。均没有伪造 OS 身份或权限成功。
- 仅将 store 的自身身份获取改为 `await htmlArtifactLockOwner(...)`，Windows 复用既有异步原生查询及其既有 5 秒上限；没有调整任何 timeout 常量、增加无限重试或放宽 unknown。死亡 owner 的恢复判定、kernel gate、文件独占与精确释放证明保持不变。
- 新 await 后重新校验物理根与全部祖先，避免等待期间目录被替换后仍按旧证明写入。
- process fixture 在 TEMP 中保留闭合的扩展 outcome；失败断言只输出预设错误码。未修改公开事件投影、生产错误载荷或日志权限。
- 显式 `PI_GUI_HTML_PROCESS_FAULT=store-path` 只在 TEMP 用普通文件制造真实存储路径冲突；默认不设置。该探针保持原发布断言失败，不标记成功，不跳过下游断言。

限制：更重的 6 秒单核负载下，新路径仍曾得到 `html_artifact_storage_busy`，运行退出 1；未据此继续放大预算或放宽身份检查。该修复解决已复现的短程冷启动同步查询问题，不承诺任意资源耗尽环境也能发布，更不以它代替 GitHub runner 的新验证。

### 本轮定向证据

证据范围为基线加 `server/html-artifact-lock.js`、`server/html-artifact-store.js`、`tests/html-artifact-lock.cjs`、`tests/html-artifact-process.cjs` 和 `tests/fixtures/html-artifact-fake-pi.cjs` 的本轮 diff；报告本身无产品行为变化。产品修复与锁回归提交为 `3911acdce1520d2a4eca4f28cbcc6fecc4dcb20e`；夹具与本节记录的交付提交可用 `git log -1 --format=%H -- docs/html-artifact-process-fixture-acceptance.md` 定位。提交操作未改变已验证的产品代码，不计作重新运行测试。风险为高：涉及存储锁的异步获取边界。

| 命令 / 场景 | 实测结果 |
| --- | --- |
| `node tests/html-artifact-lock.cjs` | 37/37 场景，287 条断言，0 skip，退出 0；新增 4 个场景 |
| `node tests/html-artifact-store.cjs` | 135/135 实际执行场景，542 条断言，另有 3 个 Windows 文件符号链接权限 skip，退出 0 |
| `node tests/html-artifact-backend.cjs` | 39/39，0 skip，1,056.5593 ms，退出 0 |
| `node tests/html-artifact-maintenance.cjs` | 35/35 场景，274 条断言，0 skip，退出 0 |
| `node tests/html-artifact-process.cjs` | 9/9，0 skip，13,759.8427 ms，退出 0 |
| 修复前准确源码 + 新 cold-self 回归 | 在独立 TEMP 复制基线 lock/store 与所需依赖，观察到 `html_artifact_storage_busy`；修复后同一回归通过 |
| 显式存储冲突故障探针 | 预期非零：3 通过 / 6 失败，首错包含固定码 `extension: html_store_unavailable`，不输出工具原文 |
| `git diff --check` | 通过 |

新增场景覆盖真实异步 OS 探针、等待期间 gate 互斥、unknown/gone/畸形/拒绝的失败关闭，以及根或数据目录在 await 期间替换的拒绝。没有删除原场景或减少断言；符号链接 skip 沿用已有宿主权限限制，不计入 135/135。

### 产物、审查与剩余状态

- 再次使用已有本地 Electron ZIP 执行 `npm run build:app -- --rebuild`，退出 0；未新增下载或依赖。已有 PDF 字体许可待审与 SEA 原签名警告仍在。
- `build/server.cjs` 与 `dist-app/Pi GUI-win32-x64/resources/app/server.cjs` 均为 **4,019,556 字节**、字节一致，SHA-256 为 `a5a65217049411c452d0efa522c28e8167ef99273f86cd00b1f49690c57adf69`。
- 默认独立复审服务返回 HTTP 429，未产生审查结论。用户随后明确指定星驰 GPT-6.1 Sol；该模型的独立功能复审与独立安全复审均已完成，各自为 Blocker 0 / Important 0 / Nit 0 / Pre-existing 0。功能复审通过限定静态范围；安全复审仅在限定静态范围有条件通过。两者均未独立重跑测试或验证 runner，不代表完整 canonical、安全专项全部通过或取得合并许可。
- 未运行完整 `npm test`，没有新一轮真实 Pi/模型、Electron UI 或安装升级验收；本轮不是 UI 变更。当前工作区未获新的完整 canonical 或 GitHub 证明。
- 用户于 2026-11-28 明确授权“合并吧”：本节按产品修复与测试诊断两个回滚边界提交，并直接快进推送 `main`；不另建 PR、不手动重跑远程 CI、不发版。新 main push 自动触发的 CI 结果仍待验证，不提前宣称 CI 恢复。
- 回滚边界：先回退本节夹具与记录的交付提交，再回退 `3911acdce1520d2a4eca4f28cbcc6fecc4dcb20e`，然后重建；不需要回滚此前 `c74e115f`、`08c8a6cd` 两次修复，也没有用户数据迁移。保留共享工作区原有未跟踪文件。
