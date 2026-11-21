# 系统设置 P2 代表证据

来自首次整改后打包版的真实截图，未经拼接/重排。末轮只修 PAC gateway 与 updater transport，没有 UI 改动，保留截图原运行身份，不冒充末轮截图。仅出现隔离 TEMP fixture 路径，没有用户业务数据或代理凭据。

- [深色宽窗：自定义代理](dark-wide.png)
- [浅色窄窗：自定义代理](light-narrow.png)
- [真实磁盘缓存清理后的多桶结果](cache-disk.png)
- [迁移确认：深色宽窗](migration-dark-wide.png)
- [迁移确认：深色窄窗](migration-dark-narrow.png)
- [迁移确认：浅色宽窗](migration-light-wide.png)
- [迁移确认：浅色窄窗](migration-light-narrow.png)
- [最小可核验数据](verification.json)

首次整改后入口为 `node tests/system-settings-electron.cjs --packaged` 和 `--packaged --p2-only`；分别 **120 / 24 checks**、**8 / 3 次**真实启动，正常沙箱下均 exit 0。截图原证据位于本机 `%TEMP%/pi-system-packaged-V4LblI/evidence` 与 `%TEMP%/pi-system-packaged-h15ylv/evidence`；当时源码 P2 在 `%TEMP%/pi-system-desktop-Ee6N0L/evidence`。末轮修复后 source `%TEMP%/pi-system-desktop-sd9kZJ/evidence` 与 package `%TEMP%/pi-system-packaged-Fqc5LH/evidence` 各 **26 checks / 3 launches**、exit 0，增加真实 updater 未读响应取消检查，结果写入 JSON 的 `finalFixes`；旧图不证明这两处网络修复。迁移确认框深/浅 × 宽/窄四组均真实渲染、测量并归档；仓库还保留两张代理布局代表及真实缓存清理图，不复制完整 profile、原始日志或 payload。

宽 `1320×820` CSS px、窄约 `701×602`，DPR 1.5；主题走产品入口。中英长标签/120% 字体和 Loading/Error/Empty 等合成桥场景只证明生产 CSS 与交互，不冒充真实 I/O 故障。磁盘清理图来自实际 Chromium 清理：保留 metadata 时报告 partial，不声称缓存总容量归零。

七张截图均已从其各自首次整改后 packaged TEMP 运行逐字节归档。JSON 仍保留 P1/P2 初版与首次整改的历史摘要，并另附末轮修复复验与原截图 SHA；各证据状态、边界、产物 digest 见 [JSON](verification.json) 及 [联合验收](../../system-settings-final-acceptance.md)。本证据首次归档提交用 `git log --diff-filter=A --format=%H -- docs/ui/system-settings-p2-evidence/README.md` 定位；后续代码/文档修改不自动获得这次证明。

沙箱开启、contextIsolation 开启、nodeIntegration 关闭；仅在 TEMP 包副本的 manifest 中安装观察 bootstrap，54 个生产模块/前端资源及图标逐字节核验。不是无观察器原始入口、真实安装/签名、真实模型或全量 CI 证明。

公共开关 off 边框深/浅主题对比度不足沿用 P1 已登记问题，本次未用页面 CSS 另造一套开关；JSON 保留实际观察，不宣称所有状态都符合 AA。
