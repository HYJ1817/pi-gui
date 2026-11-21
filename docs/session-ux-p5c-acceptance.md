# P5-C 历史恢复与整体验收

## 交付与基线

- 基线为 `a7cb5c70e2f82c3ba64e8d36ad0fc444b1bab4c2`，由 PR #100 合入 `main`。该 SHA 的 main push canonical 和 CI gate 已通过。 [基线 CI](https://github.com/HYJ1817/pi-gui/actions/runs/44863791310)
- 本地分支 `codex/session-ux-p5c-recovery`。恢复实现提交为 `d59f61b88cd2d3385a7a58c57478f444cd28d0db`，最终行为树为 `3153c0bc3d97dab3d692df8e477f6f90c37ea7e1`，包含超长会话首批挂载优化。报告提交可通过 `git log -1 --format=%H -- docs/session-ux-p5c-acceptance.md` 定位。
- 可重新证明原生会话和轮次归属的 Classic、Runtime 在线恢复及 Runtime 只读历史复用 P5-B 执行时间线。检查点不足时沿用原生历史视图。 [P5 实施计划](session-ux-p5-implementation-plan.md)

| 文件范围 | 行为 |
| --- | --- |
| `server/execution-timeline-{capture,store,history}.js` | 复用 P5-A reducer 和私有分支见证，按起始输入、原生叶节点、连续条目及工具配对保存应用侧索引。并行工具按已观测开始顺序恢复。 |
| `server.js`、`server/{router,runtime-registry,runtime-routes,session-runtime,session-history}.js` | Classic 使用同一 owner、bridge、分支和内容切片补充结构。Runtime 只读端使用 registry 绑定的原生文件和稳定文件身份，在线端核对 owner、workspace、branch、cursor、idle 和审批状态。 |
| `public/{rpc,messages,classic-execution-view,tool-history}.js` | Classic 恢复原生消息、计划、工具、附件和最终 Markdown，按原有分块机制挂载，并保留阅读锚点与编辑下标。 |
| `public/{runtime-recovery,runtime-store,runtime-conversation,runtime-timeline}.js` | 补齐缺帧后的历史回读，拒绝迟到或跨会话结果，按原生消息 ID 定位并恢复阅读位置。图片不可恢复时保留输入和提示，编辑及重生成预检再次核对原生 ID。 |
| `public/{execution-timeline-view,execution-view-preferences}.js` | 明确的开合选择按会话、工作区、Runtime conversation 和已验证轮次保存。仅迁移有原生映射的实时选择。 |
| `package.json`、`tests/` | 新增四组 P5-C 定向叶测试，保留既有测试。扩展鉴权回归及离线 Chromium 取证入口，复用 P4-D 长会话基准。 |

## 数据和权限边界

- 按 [审查准则](../REVIEW.md) 的高风险范围验收。此次变更涉及原生会话身份、授权读取、旁置持久化和故障恢复。
- 应用索引 `execution-timeline.json` 保存原生 ID、角色、时间、状态、范围和开合映射。上限为 128 个作用域、每个 80 个轮次、索引 4 MiB。采用独占临时文件、同步刷新后替换。无效版本、损坏或写入失败时保留原有数据并降级。Pi 的会话格式与原生内容由 Pi 持有。
- 两种入口继续依赖既有令牌和来源校验。Classic 只采用同一权威切片中与既有授权 `get_messages` 完全一致的内容。Runtime 只投影白名单内的摘要和已公开正文，不授予工具参数、原始输出的读取权限。历史回读不发送提示、审批、Stop 或恢复会话命令。
- Runtime 在线恢复要求同 owner 与分支，以及完成事件补读后确认的空闲游标。分支有压缩或上下文编辑时，原有读取器继续持有编辑下标。归档读取校验已注册路径、文件身份、会话头、末尾节点以及读前读后状态。只证明持久化叶节点，无法证明关闭前未落盘的内存分支。
- 缺少唯一原生锚点的无工具轮次、部分自动回退、超出条目预算及旧记录可能保留原视图。Classic 重连发现已挂载的活跃变更时保留该内容，可靠的历史结构在下次正常加载时恢复。重复原生工具 ID 的 Classic 记录沿用原视图，避免相同 ID 绑定到其他轮次的输出。
- `public/thinking-dots.js`、`public/thinking-dots.css`、`public/scroll-button.js` 相对基线无差异，动画调用路径未改动。保留原有后台提示、Plan、编辑与阅读恢复机制。

## 定向、故障注入和独立复审

测试在 Windows x64、Node v24.22.1 与离线临时 fixture 上运行。输出在 `.shots/session-ux-p5c/`。

| 检查 | 实测 |
| --- | --- |
| `npm run test:session-ux-p5-recovery` | 持久化 9/9、原生投影及生产 Runtime registry 8/8、Classic 1/1、Runtime 2/2。覆盖损坏/未知版本、原子替换故障、进程间重读、文件追加、跨分支编辑、漏帧、旧游标、重复工具 ID、A→B→A 与附件。 |
| P5-A、P5-B | 25 个适配组、61 条 model 断言、7 个后端组；共享视图 6/6、Classic 17/17、Runtime 集成 1/1。 |
| 会话回归 | P2 96/96、P4-D 14/14、P4-E 60/60、思考动画 90/90、编辑 42/42、审批与会话切换回归 32/32。 `node tests/smoke.cjs` 1338/1338。 |
| Runtime 和鉴权 | `runtime-conversation` 110/110、`runtime-registry` 42/42、`session-runtime` 7/7、`runtime-http` 13/13、`server-security` 44/44、`runtime-history-search` 37/37、`history-tool-summary-http` 14/14 个用例及 49/49 条断言。新增用例验证令牌、来源、伪造 owner、客户端路径，以及未发送写命令。 |
| Canonical 入口校验 | `node scripts/run-test-group.mjs --validate` 退出 0。295 个叶命令，core 219、ui 24、security 27、native 4、faults 21。 |
| 本地完整 `npm test` | 退出 1。顺序链通过 P5-A、P5-B、P5-C，在 `test:provider-management` 结束，182 通过、3 失败、0 跳过。失败为 `tests/provider-config-store.cjs` 的 Windows 凭据文件创建、迁移和并发创建测试，后续命令未到达。日志 `canonical.log`。 |

独立复审分别核对了原生身份、事件回读缺口、工具开始顺序、详情权限、编辑目标、偏好隔离和旧历史渲染。修复回读期间文件增加、运行环丢包、已错过终态、同文原生编辑目标错位、复用 call ID 与旧节点闭包后复验。最后增量独立复跑 Runtime HTTP 13/13、服务端安全 44/44。没有未处置的可复现代码阻断项。

并行工具回归先证明恢复曾使用声明顺序，再修复为已观测开始序。重发测试同时检查界面提示和实际出站动作。相同正文、原生 ID 不同的预检结果禁止重发，允许用户重新查询预检。独立复审也核对了 `3153c0bc` 的分块预算调整以及原有会话隔离、实时插入和锚点顺序。

全量命令在末轮性能优化前启动，在最终代码下执行了 P5 套件。既有凭据套件独立复跑 17 通过、3 失败。单项诊断确认临时夹具的目录权限触发 `ancestor-danger`，试用专用临时目录后仍有上级目录触发同一保护。凭据代码及该测试与基线一致。先前的候选文件及日志套件各跳过了一项本机没有权限创建的符号链接夹具，未计入通过数。未改动系统目录权限。 `provider-config-qualification.log`、`provider-acl-*.log` 可回查。

## Chromium 与桌面产物

- `P5C_SCREENSHOTS=.shots/session-ux-p5c/accepted-chromium` 运行 `node tests/session-ux-p5-shots.cjs`，以最终打包目录的 `resources/app/public` 提供真实静态资源。原生投影生成离线数据，Classic 展示原工具详情，Runtime 展示受限说明。
- Classic、Runtime 在深色 1320×820、浅色 700×640 各一组。四组横向溢出为 0 CSS px，行高约 28.19 CSS px，活动文字最低对比度 7.01:1。2,000 条活动折叠时行和详情节点均为零，展开挂载 40 行，首帧 16.0 ms。在组展开、详情延迟挂载、组收起时锚点偏移均为 0 CSS px。四张图和测量数据在 `accepted-chromium/`。
- `npm run build:app -- --rebuild --output-root <独立目录>` 退出 0。Windows x64 整包 334.5 MB，入口位于 `.shots/session-ux-p5c/build-accepted/dist-app/Pi GUI-win32-x64/Pi GUI.exe`。13 个变更前端文件的 SHA-256 与源文件一致，打包后端 `server.cjs` 的 SHA-256 为 `0b9a248203b3ca2710bbc0056af825c0cc8433922f7781e507442c6aae443604`。保留 `build-accepted.log`。
- 独立启动 App 内嵌后端及 SEA。两种产物均返回 2,146 字节的已认证 Runtime 只读恢复结果，核对了原生任务与终答 ID、活动耗时、用量、原始载荷排除和原生文件的逐字节一致。Runtime 启动数保持为 0。首次夹具 ID 未达到 registry 要求的 UUID 格式，返回 `registry_unavailable`，修正夹具后两种产物均通过。复现脚本与输出为 `packaged-proof-accepted.cjs`、`packaged-proof-accepted.log`。
- Chromium 与产物后端取证使用离线夹具。未启动打包 Electron 窗口、未执行真实模型调用或安装升级。

## 长会话性能

同一 Windows 主机、Chrome 157、1298×666，使用 P4-D 的 829 / 1,653 条消息、20 次快速切换和保留/裁剪历史定位。原始五轮数据在 `perf-baseline/`、`perf-candidate/`、`perf-final/`。不同时间段分开运行的测量出现明显耗时漂移，以下保留后续按 AB/BA 交替运行的五对对照，加载和页面绘制口径相同。对照脚本和明细见 `perf-paired.cjs`、`perf-paired/`。

| 场景 | 基线同步 p95 → P5-C | 基线可见就绪中位数 → P5-C |
| --- | ---: | ---: |
| Classic 829 条首载 | 64.2 → 64.1 ms（−0.2%） | 387.1 → 390.4 ms（+0.9%） |
| Classic 1,653 条首载（优化后，40 样本） | 67.6 → 38.0 ms（−43.8%） | 846.5 → 865.8 ms（+2.3%） |
| Classic A/B 切换 | 59.6 → 65.4 ms（+9.7%） | 405.5 → 442.4 ms（+9.1%） |
| Classic 20 次快速切换 | 1,274.6 → 1,273.3 ms（−0.1%，20 次同步合计） | 见原始记录 |
| Runtime 历史载入 | — | 98.6 → 96.9 ms（−1.7%） |
| Runtime 历史切换 | — | 99.1 → 99.4 ms（+0.3%） |

五对的快速切换均保留正确会话，Runtime 搜索命中超出裁剪范围时保留原提示。首轮 1,653 条配对同步 p95 为 65.3 → 93.6 ms。扩大到 40 样本后为 64.8 → 95.2 ms，确认超过相对 10% 的建议目标。优化将超长会话首批从 160 减至 80 个顶层节点，保留之后批次的节奏。按同口径再跑五对及 40 样本，得到表中最终结果。其他表项为优化前配对值，后续提交未调整对应场景的批次预算；直接受影响的 Classic、P4-D、Smoke 和动画已复跑。两次长会话明细在 `perf-paired-long/` 与 `perf-paired-long-tuned/`。

## 共享文件和回滚

- `git merge-tree --write-tree --name-only HEAD feat/system-settings` 的只读试合并报告 `package.json` 和 `tests/gui-browser-stop.cjs` 冲突。基线 `a7cb5c70` 试合并命中同样两项。本阶段没有修改系统设置分支。
- 回滚先反向应用首批挂载优化，再回退恢复实现。应用侧可选索引保持旁置，旧版本会忽略它，原生会话与设置继续由已有组件读取。

本地实现、定向回归、独立复审、浏览器、性能和产物检查已完成。完整 canonical 尚待当前代码提交的 CI 验证。分支仅在本地提交，远端操作保持待授权状态。
