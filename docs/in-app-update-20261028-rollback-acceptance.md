# Windows 更新失败回滚完整性定向补修

日期：2026-10-28（Asia/Shanghai）。分支 `codex/windows-in-app-update-7573`，独立 worktree `C:\Users\21022\.codex\worktrees\windows-in-app-update-7573\pi-GUI`。

## 身份、范围和结论

- before HEAD：`edefe7c19915674bd8233d7431ab482eba4e52b3`。本轮只补安装失败恢复与测试，不改变下载、校验、维护锁、助手启动/超时顺序或更新 UI；无新依赖，无版本号改动。
- 业务提交 `0237f7abf1b376b72549c418f4c44e177131f4e4`；测试提交 `74c2967ce81fbc2ef3a36e94bc7a3c895630b893`。报告提交由 `git log -1 --format=%H -- docs/in-app-update-20261028-rollback-acceptance.md` 解析。
- 本地最终证据绑定 `helper-build-equality.json` 中的助手 SHA256，以及业务/测试提交的相同文件树。旧报告的全量 `npm test` 仅证明旧代码。
- 本轮完整 canonical 按用户指定由对应提交的 PR CI 提供；当前状态为待验证。计划来自 `package.json` 的完整测试链，共 228 leaves：core 152、ui 24、security 27、native 4、faults 21；还需 Electron build check 和最终 CI gate。
- 风险：高，涉及程序目录文件恢复/删除。用户已说明原主要功能和退出链路通过代码审查；本轮新增 diff 由作者自审，按用户要求没有使用子代理。最终补修验收与合并仍由用户决定。

## 修改及保护

| 文件 | 本轮用途 |
| --- | --- |
| `electron/update-helper.ps1` | 备份前完整清单、备份复验、失败后观察、Win32 身份绑定恢复、只删除新增集合、最终完整性验证 |
| `tests/app-update-rollback.cjs`、`package.json` | 新增 7 项真实 TEMP/Win32 恢复专项并接入唯一 canonical 入口 |
| `tests/app-update-installed-failure.cjs` | 真实 NSIS 非零退出/零退出但版本不符；新增文件与嵌套目录；完整清单和逐文件 SHA256 比较 |
| `tests/app-update-installed.cjs` | 等待旧测试进程实际退出后衔接两种失败专项，分别保存证据 |
| `tests/app-update-windows-faults.cjs` | 保留原 6 项超时测试，增加真实 NSIS 创建硬链接及 `recovery_required` 验证 |
| `tests/app-update-windows.cjs` | 保留固定 SHA256 的官方 v0.26.0 输入，额外支持既有离线官方 v0.29.0 输入；输出可定向到独立证据目录 |
| 两份验收报告、`docs/windows-in-app-update.md`、本轮证据目录 | 历史范围、恢复契约、命令与本轮实测证据 |

回滚保留成功备份中的所有已有相对路径，不清空安装目录。安装器确实结束后才观察新增集合；后续出现的未知文件、身份变化或内容变化均拒绝自动恢复。文件操作使用同一 Win32 句柄核对最终路径、卷/文件 ID、重解析点和单一硬链接身份；目录句柄在路径操作期间禁止改名。新增目录自深至浅逐个删除，Windows 拒绝删除非空目录，代码无递归删除。

写回前复验完整备份，并通过排他目标句柄再次核对身份/内容；缺失目标只允许 `CREATE_NEW`。恢复结束后比较相对路径集合、类型、大小和 SHA256，完全一致才记录 `rolled_back` 并启动旧应用。无法证明完整性时记录 `recovery_required`、退出码 3，保留备份且不自动启动。

安装锁、父进程启动时间/句柄、armed/cancelled、包只读句柄、SHA256、旧 EXE 排他打开检查和超时不强杀语义保留。userData 等于或位于安装目录时拒绝安装；所有验证写入均为 TEMP 夹具。userData、真实项目和真实安装目录没有写入测试。

## 本轮实测

证据位于 [in-app-update-20261028-rollback-evidence](in-app-update-20261028-rollback-evidence/)。退出码来自本轮工具运行结果；保留日志记录测试正文，不能声称日志包含没有写入的命令运行器元数据。

| 层次 / 命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm run test:app-update` | 43/43，0 fail、0 skip；原 36 项全部保留，新增 Win32 7 项 | `targeted.log` |
| `npm run test:app-update:windows-faults` | 10/10，退出码 0；超时不并发回滚、锁保持、真实 NSIS 硬链接故障返回 recovery_required、用户数据保留 | `windows-faults.log`、`timeout-fault-results.json` |
| `npm run test:app-update:helper-startup` | 2/2，退出码 0；正常沙箱的生产启动器跨真实 Electron 父进程退出 | `helper-startup.log` |
| `npm run build:app -- --rebuild`、`npm run test:app` | 构建退出码 0，26/26；源码助手与当前打包助手 SHA256 一致 | `build.log`、`packaged.log`、`helper-build-equality.json` |
| `PI_UPDATE_E2E_AUTOMATED_CONFIRM=1 PI_UPDATE_E2E_CONTINUE_FAILURE=1 npm run test:app-update:installed` | 退出码 0；正常沙箱：成功安装 13/13、NSIS 非零退出恢复 13/13、NSIS 零退出但版本不符恢复 13/13；每种故障恢复 392 文件、18 目录，清单文件逐字节相同 | `installed.log`、`installed-e2e.json`、`failure-exit/`、`failure-version/` |
| `npm run test:ci`、`node scripts/run-test-group.mjs --validate` | 退出码 0；228 leaves 的覆盖并集精确，未修改 workflow | `ci-plan.log` |
| 本轮完整 PR canonical CI | 待验证；不得沿用旧本地完整运行或其他提交/attempt 的结果 | PR 与运行身份待记录 |

真实安装专项保留损坏包拒绝和重试、中文/空格路径、退出失败恢复、实际主进程及后端版本确认、浏览器活动阻拦、七类用户数据摘要和正常沙箱。故障 NSIS 实际写入旧版不存在的文件与嵌套目录后写执行凭据：非零退出和退出码 0 的版本不符分别验证。每轮将整个安装目录的 `inventory-before.json` 与 `inventory-after.json` 保存供逐项复核，包含更新前已有的自定义项目文件。

最终两种故障的清单摘要均为 `a888ae2c02065e0c2f1c74f279f05a5a220e8cb789eb9f24c23b66b6de47b86b`。源码和打包助手 SHA256 均为 `8d8d2953ca580c1d6042b2a08900a25903f1f22b4b95e15acebe052479ed09c4`；`verification-summary.json` 绑定业务/测试提交和最终实测数量。实际数量均未减少：离线 36→43、安装失败 9→每种 13、Windows 故障 6→10；成功安装保持 13，打包保持 26。

## 失败历史、边界和回滚

- RED：在 `edefe7c` 助手上，真实 NSIS 新增文件并返回非零；助手仍报告 rolled_back、旧版重启可用，但完整 391 文件清单断言失败。保留 `red-inventory-checkpoint.json`；该失败不是通过证据。
- 初次引用的旧 TEMP 目录不存在，测试未进入安装。后续复用进程尚未完全退出的夹具发生启动超时；现测试显式等待 CDP 关闭再衔接下一轮。未把前置失败算作产品通过。
- 中间故障夹具缺少 `CreateDirectory`，没有产生预期新增文件，返回 restart_failed，8/9；最终用真实 NSIS 硬链接替换异常注入，10/10。
- PowerShell 单文件清单被管道展开导致计数误判；真实单文件恢复用例先失败，统一使用数组后通过。新增身份/内容与安装后变更负向检查均已实际执行。
- 旧 Windows 兼容脚本硬编码 0.26.0，试用 0.29.0 时有版本/健康检查前置失败；改为由固定官方摘要选择版本，保留原 0.26.0 支持。中间兼容测试 13/13 只证明其当时状态，不替代最终正常沙箱安装证据。
- 早期删除 RED 夹具新增测试文件被自动审批拒绝，未绕过；旧 TEMP 保留作为失败证据，后续使用新夹具。

支持安装形态保持原契约：可确认身份的 Windows 当前用户 NSIS 安装版应用内升级；便携版仅下载校验 ZIP 后手工替换；开发模式及其他平台使用手动入口。真实安装证明采用独立 EXE、TEMP、去注册表/快捷方式写入的 NSIS 测试副本和本地 Release 传输；原生确认使用显式测试应答。不能声称已完成签名生产包、用户原位置覆盖、原生确认人工点击或断电验证。安装锁不是同权限第三方进程的系统级排他，无法把安装期间任何未知外部写入鉴定为特定进程的行为；已观察之后的变化拒绝处理，异常身份保留材料并要求人工恢复。

本轮没有重建正式 `dist-installer` 发行包；旧报告的正式候选摘要不能作为本轮产物。最终 TEMP NSIS 及其摘要见安装证据。正式发行仍需要单独授权、签名及发布检查。

身份绑定代码只使用系统自带的 PowerShell/.NET、kernel32 与原生句柄，不引入依赖；`Add-Type` 被系统策略禁止或原生文件检查不可用时拒绝该次安装/恢复，不能通过降低执行策略、跟随链接或跳过身份校验放行。

代码回滚：按业务、测试、文档三个提交边界回退本分支，不删除用户数据。程序恢复失败时保留该次 `backup` 和 `backup-manifest.json`，由用户在旧程序完全退出后人工检查/重装程序；不批量删除程序目录，不执行未证实的强制回滚。

## 交付身份与状态

开发补修完成，定向验证和作者自审完成。测试对象为业务 `0237f7a` 与测试 `74c2967` 的同一文件树，后续文档提交无行为变化。完整 PR CI 待验证，PR head/merge SHA、run ID/event/attempt 和最终 gate 在取得后记录于 PR 附带证据或最终交付消息，不能提前声称通过。本轮补修的独立审查未执行（用户禁止子代理）；代码最终验收待 CI 与用户审阅；合并、tag、发布未授权且未执行。
