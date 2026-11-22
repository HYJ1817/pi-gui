# Extensions 第二阶段 B 验收

基线是 `origin/main` 的 `3850e7811fa33cca9eacf3a01f7c69e0e0b77909`。基线 [CI 44918456748](https://github.com/HYJ1817/pi-gui/actions/runs/44918456748) 为 push、attempt 1，CI gate 成功。

## 页面与操作

- **插件市场**有搜索、分类、排序、24 项一批的分页、目录范围、在线刷新、缓存降级和重试。卡片打开详情，详情显示来源、兼容性、安装范围、安装脚本及本机状态。安装前通过共享确认框确认包来源和执行权限。
- **已安装**将两级 Pi `settings.json` 的包登记与只读 Extension Registry 的入口关联。本机包、启用配置、加载证据和运行观测独立投影。无法确认的状态显示未知。已知能力在已登记包的详情内展示运行观察，缺少对应包时保留既有能力设置入口。Approval 仍由原有协议报告提供。
- 用户级受控 npm 包支持安装、更新、卸载和缺失文件修复。显示项目级、Git 和本地来源的诊断与操作限制。精确固定版本不提供更新。启停在终端运行 `pi config`，按 Tab 切换作用域。已安装页的更多菜单可调用现有重启流程。

## 目录和上游依据

采用 npm Registry 上带 `pi-package` 关键词的公开包，按搜索顺序收录最多四批，每批最多 250 条。内置 Web Access、Subagents、Pi Memory、Browser Use 四项用于离线浏览。推荐顺序将内置项优先，其他项目沿用注册表顺序。名称、最新发布时间和月下载量按有证据的数据排序。包的作者、版本、许可证等缺失时显示未知。资料入口为 [Pi 包文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) 和 [Pi Gallery](https://pi.dev/packages)。

在线目录由用户启用。默认不预取，首次或过期时打开市场才读目录。显式点「在 npm 搜索更多」才发送搜索词。撤回后丢弃缓存并使旧响应作废。网络读取复用现有市场代理、地址、响应大小和超时限制。失败可退回上次缓存或内置目录。

PI-Desktop 的 [市场规范](https://github.com/vastsa/PI-Desktop/blob/main/docs/spec/07-plugins/07-plugin-marketplace.md) 提供页签、筛选、网格和详情布局参考。其 `.piplug` 宿主权限和制品格式与 Pi 原生包不同。Pi GUI 使用原生 Pi 包，并沿用应用的居中弹层、色彩、字号和按钮规范。

Pi 1.6.0 的帮助及本机包源码 `dist/package-manager-cli.js`、`dist/core/package-manager.js`、`dist/config.js` 验证了这些调用：

| 操作 | 固定 argv 形状 | 复核 |
| --- | --- | --- |
| 安装 | `pi install npm:<name> --no-approve` | 确认用户级配置登记与包清单身份 |
| 更新或修复 | `pi update --extension npm:<name> --no-approve` | 复核登记、包文件和版本，保留未知及未变化 |
| 卸载 | `pi remove npm:<name> --no-approve` | 确认用户级登记已移除，报告残留文件 |

安装和更新由本机 npm 通过其配置的 Registry 解析版本并校验下载完整性。市场详情的版本、完整性和签名字段反映公开目录或包清单的元数据。运行时权限取决于 Pi 进程的权限。安装脚本可在 Pi CLI 调用 npm 时执行。

## 安全与复审

- POST 只接收动作、受控 ID、确认标记和预期工作区。服务端解析包名，执行器固定 argv，复用原有 Pi CLI 入口身份与进程内锁。2B 在隔离的空目录执行，校验、执行和复核共用同一个绝对 Pi 用户配置目录。
- 禁止项目内用户目录写入、目录联接和符号链接穿越。查重读取完整的受限配置文件。异常 URL、别名版本和重复登记不可由更新入口执行。npm 标记为不安全的包禁止安装和更新。
- 安装流程先等待旧 Pi 停止。恢复后触发只读发现，磁盘确认和 RPC 加载证据分别显示。
- 独立首轮覆盖功能和安全。第二轮复核了路径归一化、空 cwd、完整配置查重、版本来源、同意撤回、跨项目和分页去重，最终定向通过 341 项。这些检查的写操作均使用临时夹具。
- P24 四个已知能力的旧安装入口仍采用原工作目录语义。Pi 的外部 CLI 可以绕过 GUI 的进程内锁，并发改写同一个 `packages` 列表的行为仍由 Pi 上游决定。

## 实测与截图

| 检查 | 结果 |
| --- | --- |
| `node tests/extension-market.cjs` | 139/139 |
| `node tests/extension-packages.cjs` | 119/119 |
| `node tests/capability-install.cjs` | 83/83 |
| `node tests/agent-capability-pages.cjs` | 46/46 |
| `node tests/server-security.cjs` | 44/44 |
| `node tests/ui-ia.cjs` | 32/32 |
| `node tests/gui-browser-stop.cjs`、`node tests/stop-barrier.cjs` | 13/13、17/17 |
| `node tests/smoke.cjs` | 1345/1345 |
| `npm run test:extensions:electron` | 21/21，实际打开展示页面，20 张截图 |
| 真实 Pi 1.6.0 | 本地 npm Registry 夹具，安装 1.0.0 → 更新 1.1.0 → 卸载。两次 tarball 读取。卸载前 RPC 发现命令，卸载后不再发现。项目配置字节一致，用户主题保留 |
| `node scripts/run-test-group.mjs --validate` | 311 项 canonical 计划，完整运行结果待验证 |
| `npm run build:app -- --rebuild` | Windows x64 构建 335.0 MB，13 项前端资源逐字节匹配，后端 bundle 复算 SHA-256 一致 |
| `npm run test:app` | 打包后端 27/27 |
| `npm run test:exe` | SEA 后端 50/50 |
| 打包市场端点 | 离线目录 4 项，详情无联网同意，空包清单。未确认的安装返回 `confirm-required`，未创建配置。[端点实测](ui/extensions-market-phase2b-evidence/packaged-api.json) |

PR 首轮 [CI 44980047221，attempt 1](https://github.com/HYJ1817/pi-gui/actions/runs/44980047221/job/137078464192) 的故障注入组在第 5 项提前退出。两份 Stop VM 夹具直接执行 Router 装配片段，却未声明新增的扩展端点依赖。本地复现两份夹具的 `ReferenceError`，补齐占位后原断言全部通过。完整证明由当前 PR 的 CI 提供。

视觉证据来自 Electron 的真实应用源页面及离线夹具。Electron 验收进程使用 `--no-sandbox`，正常沙箱启动、真实在线第三方包安装和已安装 Windows GUI 交互未验证。

| 窗口 | 深色 | 浅色 | 卡片 |
| --- | --- | --- | --- |
| 1320×820 | [市场](ui/extensions-market-phase2b-evidence/1320-dark-market.png) · [已安装](ui/extensions-market-phase2b-evidence/1320-dark-installed.png) | [市场](ui/extensions-market-phase2b-evidence/1320-light-market.png) · [已安装](ui/extensions-market-phase2b-evidence/1320-light-installed.png) | 三列，321×176 px |
| 700×600 | [市场](ui/extensions-market-phase2b-evidence/700-dark-market.png) · [已安装](ui/extensions-market-phase2b-evidence/700-dark-installed.png) | [市场](ui/extensions-market-phase2b-evidence/700-light-market.png) · [已安装](ui/extensions-market-phase2b-evidence/700-light-installed.png) | 单列，426×176 px |

| 状态 | 宽窗深色 | 窄窗浅色 |
| --- | --- | --- |
| 分类和排序 | [截图](ui/extensions-market-phase2b-evidence/1320-dark-filtered.png) | [截图](ui/extensions-market-phase2b-evidence/700-light-filtered.png) |
| 详情 | [截图](ui/extensions-market-phase2b-evidence/1320-dark-detail.png) | [截图](ui/extensions-market-phase2b-evidence/700-light-detail.png) |
| 确认 | [截图](ui/extensions-market-phase2b-evidence/1320-dark-confirm.png) | [截图](ui/extensions-market-phase2b-evidence/700-light-confirm.png) |
| 安装中 | [截图](ui/extensions-market-phase2b-evidence/1320-dark-installing.png) | [截图](ui/extensions-market-phase2b-evidence/700-light-installing.png) |
| 超时 | [截图](ui/extensions-market-phase2b-evidence/1320-dark-install-failed.png) | [截图](ui/extensions-market-phase2b-evidence/700-light-install-failed.png) |
| 空结果 | [截图](ui/extensions-market-phase2b-evidence/1320-dark-empty.png) | [截图](ui/extensions-market-phase2b-evidence/700-light-empty.png) |

对照参考图，保留了图标标题、右侧刷新、页签加搜索、分类后结果数、三列卡片和底部右对齐操作。内容区包含应用侧栏，两种宽度下内部可滚动，实测横向溢出均为 0 px。按钮高 28 px，圆角 14 px。卡片显示 npm 发布资料，参考图中的宿主评分和权限徽标在本市场没有对应数据。[布局测量](ui/extensions-market-phase2b-evidence/measurements.json) · [真实 Pi 提要](ui/extensions-market-phase2b-evidence/real-pi.json) · [产物校验](ui/extensions-market-phase2b-evidence/build-check.json)

## 接线、集成和回滚

- 生产共享文件为 `server.js`、`server/router.js`、`public/api.js`、`public/app.js`、`public/status-copy.js`、`public/ui/capability-setup.js` 和 `package.json`。测试共享接线为 `tests/agent-capability-pages.cjs`、`tests/smoke.cjs`、`tests/shortcut-electron.cjs`、`tests/visual-harness.cjs`、`tests/gui-browser-stop.cjs` 与 `tests/stop-barrier.cjs`。
- 与 2A 集成时优先核对 `server.js`、`server/router.js`、`public/api.js`、`package.json` 的邻近接线，以及能力页联合测试，保留两侧各自的入口和测试链。此次基于主干单独验收，尚无 2A 集成实测。
- 如需回退，按相反顺序 revert 验收材料、前端页面与测试接线、后端包与市场模块，再用 `npm run build:app -- --rebuild` 重建。Pi 已执行的包操作由 Pi 配置和包管理命令管理，代码回退不会改变它们。
