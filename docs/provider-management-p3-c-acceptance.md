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

P3-C 仍在实施。逐 Runtime 启动代次、权威配置见证、原生模型和思考等级回读、`pending/syncing/applied/error` 逐实例状态及管理 `/sync` 的完整重试合同留在下一段。当前尚未完成 C 的全量 canonical、正常沙箱和独立完整验收。
