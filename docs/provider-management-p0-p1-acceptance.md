# 供应商管理 P0＋P1 验收报告

生产基线为 `750dee491ae0a0b3b499916b014e161f46ef6f75`，最终设计为 `558f90eed24fb8e39be2474ce4e9a3ea371f948b`。独立分支 `codex/provider-management-p0-p1` 的实现提交为 `b3b126684b87ceed6663084e41596db5e7c101d7`，最终行为提交为 `135ad7a4d83145126b46ea023ab89829eb06e3af`。报告交付提交可用 `git log -1 --format=%H -- docs/provider-management-p0-p1-acceptance.md` 查询。[最终设计](provider-management-rebuild-plan.md)

## 交付范围

| 阶段 | 行为 | 主要文件 |
| --- | --- | --- |
| P0 | 冻结服务目录、草稿与版本、发现与授权、连接检查、模型参数、保存与同步、凭据和 OAuth 状态。新增应用级 HTTP 路由和非秘密客户端。未接通的接口返回 HTTP 422 `unsupported`。 | [HTTP 后端](../server/provider-management.js)、[共享校验](../public/provider-management/contract.js)、[客户端](../public/api.js)、[前端合同](provider-management-frontend-contract.md)、[状态 fixture](../tests/fixtures/provider-management-scenarios.json) |
| P1 配置 | 新增、编辑、复制、删除和停用使用同一配置仓储。保留原生 Pi 格式、既有凭据引用和未知扩展字段。复制仅携带允许的模型字段。旧接口复用仓储及 Endpoint 保护。 | [配置仓储](../server/provider-config-store.js)、[合并规则](../server/provider-config-records.js)、[兼容路由](../server/providers.js) |
| P1 凭据 | 独立 worker 内使用公开 Pi 1.5.0 SDK 暂存、替换、清除与回读。适配器独立报告 `credentialSaved` 与同步状态。 | [适配器](../server/provider-credential-sdk.js)、[worker](../server/provider-credentials.js) |

## 安全、兼容和回滚

- HTTP 沿用令牌和 Origin 校验，供应商路由检查回环 Host。现有 OAuth 流程继续使用既有接口和单飞约束。原文 API Key 仅可进入受信任的私有适配器。生产进程以 `providerKeyInputEnabled=false` 装配，且存储授权默认拒绝。普通 renderer、Web、HTTP、SSE、日志和诊断均无原文入口。P2 的专用输入窗和 IPC 尚未接通。
- 新管理路由默认关闭，可用启动变量 `PI_GUI_PROVIDER_MANAGEMENT=1` 联调。关闭时旧路由仍访问同一仓储。旧 DELETE 保留磁盘删除语义，但如果删除可能恢复另一个内置 Endpoint，且不能证明供应商是自定义的，则拒绝该次操作。原生槽为空也可能存在 Pi 环境凭据。新版已确认的内置服务可以停用并保留磁盘覆盖。
- 内存 `CredentialStore` 按草稿、供应商 ID、连接版本和目标绑定，支持过期与取消。同槽 OAuth 替换需单独确认并检查版本。写入使用 Pi 原生登录或登出和安全回读。字面量转义避免把输入解析为环境变量或命令。临时自定义注册只含目标和空模型列表，SDK 网络禁用，worker 环境变量采用白名单。原生存储沿用 Pi 的 `auth.json` 及其权限，属于本地文件明文信任边界。公开 SDK 没有跨进程凭据 CAS，回读无法消除其他 Pi 进程的竞态。P2 开放输入前仍需验证真实 auth 目录、文件权限与调用者。
- `models.json` 保持 Pi 原生格式。GUI 元数据仅存显示、选择、排序、覆盖所有权、同步标记与最近 128 个幂等收据。写入使用进程锁、双文件 CAS、私有暂存、原文件备份与分文件 rename。启动或下一次写入在验证目录身份、权限及摘要后重放。如果遇到未识别的外部更改、坏日志或损坏的锁票据，停止自动恢复并保留文件。Windows 的 Node 目录句柄不支持 fsync，断电持久性取决于文件系统。非协作编辑器与最终 rename 之间仍存在系统调用级竞态。
- 用户回滚可回退行为提交和报告提交。若存在未完成事务，先停止 GUI 写入并保留现场，在对照事务中两份受保护的原文件和当前两文件后恢复相应版本。成功事务会清理日志和内部备份，已完成的数据变更只能按用户自己的备份或逐项修订恢复。旧版本可继续读原生模型配置，GUI 元数据仅供新版使用。凭据的变更与回滚分别经 Pi 官方 SDK 操作。

## 实际验证

Windows x64，Node v24.22.1。生产基线的 main push CI（attempt 1）完整通过。本地基线全量在末段 P33 对象 witness 返回 `witness_unavailable`，退出 1。[基线 CI](https://github.com/HYJ1817/pi-gui/actions/runs/42236631542)

| 命令或场景 | 结果 |
| --- | --- |
| `npm run test:provider-management` | 21/21，退出 0，跳过 0。覆盖双文件中断恢复、恶意事务、重复进程强杀、外改、权限和格式错误、幂等、DTO、应用鉴权、回滚开关、删除时的目标约束和私有 SDK 状态。 |
| `node tests/models-api.cjs`、`node tests/provider-auth.cjs`、`node tests/provider-auth-runtime.cjs`、`node tests/server-security.cjs` | 依次为 50/50、107/107、36/36、39/39，全部退出 0。 |
| 实际公开 Pi SDK 1.5.0 专项 | 在 TEMP 用合成输入验证原生和自定义 ID 的暂存、保存、替换、回读和清除，22/22 断言通过。canonical 测试仍以隔离 SDK fixture 运行。 |
| `npm run build:app -- --rebuild --output-root <TEMP>` | Windows 离线构建退出 0，Electron 44.4.3。用隔离配置启动打包 SEA 后端，验证默认关闭时旧读接口仍可用，并验证显式开启时的快照、草稿、提交、双文件和待同步状态。后端 SHA-256 为 `6DA1F19B690220DA3B45931A0220F8112C34B6EA33818E7C6E01BC20AA22473D`。 |
| `node scripts/run-test-group.mjs --validate` | 236 条 canonical 命令，五组覆盖完整。 |
| 本地完整 `npm test` | 最终行为提交的本地运行已启动，出报告时仍在执行。日志为 `%TEMP%/pi-provider-p01-canonical-135ad7a.log`。 |
| 独立复审 | 仓储及凭据各由独立上下文复审。已复测未保护事务日志拒绝、连续中断恢复、同模型扩展保留、路径精确比较、内置身份未知拒绝和临时注册隔离，增量复审无新增阻断。 |
| UI 视觉、真实账户及真实安装升级 | 本轮无 UI 布局改动，未采集截图。未使用真实密钥、OAuth 凭据、付费推理或真实 Pi 配置。未验证真实安装升级。 |

仓储权限专项覆盖 Windows ACL、目录和文件安全限制，并注入读取权限错误。Windows 真机只用 TEMP 文件验证。定向测试初次有一条 fixture 把未知能力名当成可写字段，改用合同内 `streaming` 后通过；原断言仍验证未知扩展字段无损。

## 后续实施条件

- P2 可以基于冻结的私有合同和 P1 适配器开发专用输入窗、IPC 及真实存储授权，并实现同源无重定向、限额和无付费探测等网络策略。主进程身份、窗口隔离、凭据生命周期和跨平台权限通过专项验收后再决定是否启用。
- P3 可以接通发现授权、缓存、凭据与配置分阶段保存以及 Runtime 同步。原生暂存凭据的发现和应用依赖 P2 的可信绑定和安全传输。
- DeepSeek 可以依据合同及 fixture 直接开发 P4 完整布局和状态，运行时根据 `capabilities` 禁用未接通能力。真实发现、原文输入和 Runtime 同步的联调分别等待 P2、P3。

开发交付待用户独立验收，PR CI 与代码验收分别记录。合并和发布均需另行授权。
