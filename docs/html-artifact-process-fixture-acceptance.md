# HTML artifact 进程 fixture 局部修复记录

- 日期：2026-11-28。
- 目标：处理持续阻塞 faults 组首个命令的离线进程测试，不重开 Visual Replies P3 专项。
- 基线：`a6eceeba0763c43f0b3e32fd02cb5b59f298f766`；分支 `fix/html-artifact-process-fixture`。
- 证据范围：基线加 `server/runtime-registry.js`、`tests/runtime-registry.cjs`、`tests/html-artifact-process.cjs` 的本次 diff；行为与 Registry 回归提交为 `c74e115fc634d2cad144aac3ee00c43e7398c50c`。本报告和 process fixture 的交付提交可用 `git log -1 --format=%H -- docs/html-artifact-process-fixture-acceptance.md` 定位；提交前后代码树未改变，不将提交操作计作重新运行测试。
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
