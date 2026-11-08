# 供应商管理 P3-A 实施与验收记录

基线为 `857322c1b806ada8d2e4704befa3016cbfbbee75`。[该提交的 main CI](https://github.com/HYJ1817/pi-gui/actions/runs/42469744156) 8/8 通过。P3-A 开发验证与基线 CI 分开记录。本阶段的目标是将可信暂存、配置提交、Pi 原生凭据写入与安全回读接通。

## 实施边界

- [提交编排](../server/provider-management-commit.js) 先保存 P1 配置并记录派发阶段，再把私有暂存交给 SDK worker。相同请求共享或重读持久回执。原生调用失败时，回执仍保留配置保存事实，区分确定失败、结果待确认和凭据已确认。Runtime 生效另由后续协调器处理。
- [配置存储](../server/provider-config-store.js) 让 OAuth 和原生凭据保存复用同一锁。未决记录保留在私有 sidecar，其中不含密钥或密钥散列。无匹配停止回执时，同槽 OAuth、凭据保存和配置改绑保持隔离。若收到同一 worker 和请求的停止回执，还要在租约内重验存储资格并安全回读才能解除隔离。原操作仍记为待确认。失去证明的记录保留，维护者停写恢复流程尚未工具化。
- [凭据桥](../server/provider-credential-bridge.js) 只接受当前可信窗口和草稿绑定的暂存代次。模型编辑保留上一份有效暂存，目标变化、表单关闭和过期撤销授权。替换取消时丢弃迟到的候选。普通 HTTP 只传 P0 的非秘密请求字段。
- [桌面接线](../server.js) 保持 feature flag 默认关闭。持久化只在直属私有 IPC、可信暂存与存储资格都成立时开放。Windows 核查 ACL、祖先的路径替换权限与 reparse，Linux 核查所有权、权限和链接。其他平台在取得相应 ACL 证据前关闭原生持久化。自定义服务的新密钥需要 HTTPS 和可证实的认证目标。内置服务的 Endpoint 无法由当前 SDK 证据精确证明，保持既有 OAuth 路径。

Pi 1.5.0 的原生 `AuthStorage.read` 会解码 API Key 的字面转义，公开 `readStoredCredential` 返回未解码的存盘值。worker 在写入前转义，回读时在内存内核对等值或明确空槽。Pi 的外部进程使用自身文件锁，GUI 的锁只能协调使用同一权威配置的 GUI 进程。外部 Pi 或手工编辑仍存在检查后竞争窗口。

## 验证记录

| 证据 | 结果 |
| --- | --- |
| 管理专项 | `npm run test:provider-management` 90/90，零跳过。覆盖配置已保存但凭据失败、并发幂等、两个崩溃边界、超时隔离和回执回放。SDK worker fixture 完成暂存、设置、回读及清除。 |
| OAuth 和服务器防护 | `npm run test:auth` 109/109，`tests/server-security.cjs` 39/39，`tests/electron-guard.cjs` 123/123。另有模型 API 50/50、既有 OAuth Runtime 36/36。 |
| 桌面权限拒绝 | 用户临时目录的祖先 ACL 含有额外的删除或替换权限。真实 Electron 拒绝原生持久化，且配置和凭据文件均未生成。桌面 44/44 检查通过。 |
| 桌面持久化成功 | 以进程级 `TMP`/`TEMP` 选择权限合格的系统临时目录，worker 使用隔离 fixture 自己的临时目录。`npm run test:provider-p2` 的网络 37/37、开窗 5/5、私桥 28/28、真实 Electron 47/47。真实后台子进程和假 Pi 包完成暂存、保存、回执重传与清除。 |
| 沙箱 | 两组桌面运行的正常沙箱启动失败，均使用现有 `--no-sandbox` 回退。正常沙箱验收待验证。 |
| 打包 | `npm run build:app -- --rebuild --output-root <临时目录>` 以本机 Electron ZIP 离线重建 SEA 和桌面包。打包后端的 OAuth 专项 119/119。打包 `resources/app/server.cjs` 的 SHA-256 为 `500d9248966a9a5cc3168f69aa4837f127af60c890129e32192cdab7a597ae6b`。 |
| canonical 累计验证 | 行为提交 `e3a867f555ecff5a2f54bafae958c8646a0f68dd` 的 240 条命令均取得退出码 0。core 164/164、UI 24/24、安全 27/27、native 4/4、故障 21/21。逐组记录已与 `package.json` 展开的有序清单和同一计划摘要比对。这组证据来自本机分组和续跑。 |

修复前的定向回归显示，缺少共享租约时 OAuth 在锁冲突下仍会调用适配器，缺少可信停止回执时不能正确恢复写入权限。修复后，未决记录跨实例保留，旧结果无法重放。第一次 Electron 持久化成功路径因低完整性测试 worker 不能在系统临时目录根创建注册文件而失败，收据正确记录配置部分成功。随后将测试子进程的临时路径设到已隔离 fixture，成功路径通过。

本机 PowerShell 执行策略拒绝原工作区的既有未签名测试脚本，首次安全组、故障组和 native 组分别在 `session-revert-sacl-witness`、`session-revert-inplace-safety` 和 `session-revert-object-writer` 失败。复跑使用同一行为提交的干净工作树，安全和故障两组完整通过，native 组最后一条命令续跑为 19/19，前三条沿用首次通过记录。保留首次与复跑日志于 `%TEMP%/pi-gui-p3a-e3a867f-canonical` 和 `%TEMP%/pi-gui-p3a-e3a867f-qualified`。计划摘要为 `308984a0269d875c6a0c8746e71718abcb9e1be7bfe90419a8d8554831c98c60`。

环境跳过按套件分别记录。SACL 见证 8 项、原地写入 2 项和对象见证 8 项缺少 `SeSecurityPrivilege`。协作存储与候选采纳另各有 1 项环境跳过。退出码证明未触发断言失败，跳过的断言仍未验证。

Claude Code 使用 DeepSeek V4.1 Flash 独立核对 OAuth worker 的提前结束路径和凭据迟到回执。结果验证了按 worker 实例与请求 ID 配对的边界。复核限定在这两类竞态，完整安全验收仍需独立审查。

## 回滚与剩余验收

关闭 `PI_GUI_PROVIDER_KEY_INPUT` 停止新输入和原生持久化。若存在未决写入，先保持隔离并停止同一存储权威下的写入者，核验无活跃 SDK 锁、路径权限和当前槽位状态。保留配置与凭据的独立事实。禁止通过回放旧请求或直接修改 `auth.json` 恢复。尚需在正常沙箱验收，核对失去 worker 停止回执后的维护恢复，并在后续阶段接线真实 UI 与 Runtime 状态。
