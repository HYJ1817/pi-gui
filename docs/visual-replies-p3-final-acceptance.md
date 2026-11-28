# Visual Replies P3 收尾验收

## 范围与身份

- 日期：2026-11-28；分支：`feat/visual-replies-p3`。
- before HEAD：`f045155def1b2fe4639425926509abed9a3e6823`。
- 本轮运行记录的身份是该 HEAD 加收尾工作区 diff，不是已提交 SHA 的 CI。验证后只拆分提交、补报告，产品/测试字节未改变：产品提交 `6fd24998ebcb331da2847c3796903dd035bd93c5`，测试提交 `4e34a8353167913967d2c1e569d868529c6b9d54`；提交后这些目录没有未提交 diff。交付 SHA 以包含本报告的提交为准，可用 `git log -1 --format=%H -- docs/visual-replies-p3-final-acceptance.md` 定位。
- 交付：复用私有预览桥接与截图回注，完善闭集诊断、静态降级说明、真实模型观察及源码/打包应用验收驱动。未新增依赖，未改 P1/P2 UI，未开展 P4 或正式快照 GC。
- 风险：高（隔离边界、私有截图与模型上下文）；用户实际验收、合并和发布仍是独立门槛。

## 行为与安全边界

- `lib/html-preview-diagnostics.cjs` 统一有界协议：四类诊断各最多 20 条；页面错误只返回允许的错误类型、原因、固定描述与渲染文档行号，不返回错误原文、标识符、URL、stack 或 console 参数。
- `electron/html-preview-service.cjs` / `html-preview-static.cjs` 补图片、字体、布局溢出和稳定等待反馈；`server/html-preview-client.js` 校验闭集协议；正式构建带上平铺的诊断模块。
- 原生网络隔离资格不能被证明时，继续使用独立的页面 JavaScript 禁用静态预览。必须明确动态 DOM、Canvas、运行时 SVG 和脚本错误没有被执行验证，不能把静态截图称为交互预览。
- `extensions/pi-gui-html/index.js` 保持私有截图上下文注入，并向模型说明静态限制；公开 SSE/时间线不接收截图或任意页面诊断原文。
- 不放宽 sandbox、webSecurity、contextIsolation、Node、iframe 权限或网络隔离；不修改外部 Pi、用户全局 npm 或真实用户数据。

## 本轮实测

环境：Windows 11 10.0.26200、Node v24.22.1、Electron 44.4.3 / Chromium 152.0.7977.130。所有应用写入均在新建 `os.tmpdir()` fixture。

| 证据层 | 命令/场景 | 实际结果 |
| --- | --- | --- |
| 定向测试 | `npm run test:html-preview` | 最终 249/249，失败 0、跳过 0；4095.7039 ms；退出 0；修复前本轮基线 248/248 |
| 驱动自检 | `node tests/html-preview-live.cjs --check-driver` | 25/25；退出 0；不启动 Electron/Pi/模型 |
| 源码应用 | `node tests/html-preview-live.cjs --offline` | 功能 20/20；整体 20/21，退出 1：仅交互预览资格未通过 |
| 正式构建 | 使用已有 Electron ZIP 缓存，`npm run build:app -- --rebuild` | 退出 0；`dist-app/Pi GUI-win32-x64` 约 350.1 MB；未下载依赖 |
| 产物一致性 | public、extensions、Electron 模块、8 个共享 CJS、后端 bundle/manifest 字节比较 | 747/747 一致，差异 0；这不是全包所有文件的计数 |
| 源码 + 打包应用 | 设置 `PI_GUI_VISUAL_REPLIES_PACKAGED_ROOT` 后运行 `node tests/html-preview-live.cjs --offline` | 功能 40/40；整体 40/41，退出 1；`functionalCompleted=true`、`interactivePreviewQualified=false`；85,777 ms |
| 完整 canonical / CI | 未运行 `npm test`；未创建 PR | 按本次用户要求仅跑定向；准确基线 SHA 未查到可复用 CI，完整证明未验证 |

定向套件相对原始 244 项新增 5 项：前轮新增 4 项，本轮独立审查后新增未知异常回归 1 项。原有“自定义异常应丢弃”的单条断言被新的通用错误契约替换，其余原有测试未删除，套件总数 248→249。整体应用报告的失败项没有删去、跳过或改标为通过。

源码与打包应用各覆盖：preview→render 顺序、后续文字、正式 Artifact 交互、切换/返回会话、多会话引用隔离、深浅主题和宽窄窗口、全屏、125%/100% 缩放、重置/适应宽度/关闭、重启恢复且不重放模型工具。两端都仅观察到静态预览；各自原生会话持久化预览图片 0，正式发布 1，引用链有效，重启会话 digest 不变。四个阶段正常退出，进程身份检查确认无残留。

打包验收使用正式包的 TEMP 副本，只在副本添加观察入口再加载未改动的 production main/preload/backend/viewer；不是零插桩启动证明。离线 fixture 不是实际模型验收。

- 最新应用报告：`%TEMP%/pi-visual-replies-eWpVTE/evidence/acceptance.json`。
- 源码单独报告：`%TEMP%/pi-visual-replies-us9mDU/evidence/acceptance.json`。
- 已实际查看代表截图：最新报告同目录的 `packaged-zoom-dark-wide.png`、`packaged-light-narrow.png`、`packaged-restart-interaction.png`，以及源码宽屏、窄屏、全屏、缩放与恢复截图。
- 包内 `server.cjs` SHA-256：`20eb3382bcf1df18482633be02c8f35042e389f6729b36bf9121bcbdbb709351`。
- 包内诊断模块 SHA-256：`4bbac5f41e1fae6114a7ff8f85330b536bdb2b753b75490c110101b5874f06a8`。

## 首次失败与修复

前轮源码应用报告 `%TEMP%/pi-visual-replies-sAAP2g/evidence/acceptance.json` 为 19/20，停在 `viewer-open`。本轮只修驱动：显示/聚焦 production 窗口、bring-to-front，复用既有 viewer 专项的原生鼠标移动，再等待渲染帧后真实点击。随后源码及打包全屏/缩放均成功；未修改产品按钮、CSS 或权限。此前错用第二会话摘要的问题也已通过返回原会话、重启引用和 digest 检查复验。

## 真实模型与公网图片：保留前轮结果，不冒充本轮重跑

- A：前轮 `xingchiapi/gpt-6.1-sol` 在未明确要求 HTML、图表或工具的分析任务中自主 `html_render` 1 次，成功发布并继续文字。
- B：前轮真实模型得到 760×711、47,594 字节的静态预览 PNG，digest 与实际供应商请求相同且 HTTP 200；但 240 秒预算内没有完成，读图理解、诊断修正及最终发布未通过。不能用更早任务的随机码成功证明替代本轮收尾任务。
- C：前轮 DeepSeek 文本配置遭限流，未调用预览/发布；未通过，不继续重试消耗额度。
- 图片：前轮两个公开 HTTPS 域名均被 Fake-IP/非公网资格拒绝，0/2，`html_resource_blocked`。未绕过策略；实网成功、内联后发布和离线恢复仍未验证。本轮没有再次调用模型或公网图片。
- 历史原始证据：`%TEMP%/pi-visual-replies-xYZ2iZ/evidence/acceptance.json`、同目录 `provider-image-4a1870482c8435bc0c4f25c2324148cb5beda5547f039e739c2659b0180fd845.png`；图片结果 `%TEMP%/pi-visual-replies-Bfe0el/evidence/public-resources.json`。

## T3 实际源码对照

本地原有 `.t3-ref/` 只有树索引，独立审查没有假称读到缺失正文。随后作者只读获取固定提交 [`a7a6126a7d9b364c0fbef3f7fe1a087c4b004393`](https://github.com/pingdotgg/t3code/tree/a7a6126a7d9b364c0fbef3f7fe1a087c4b004393) 的三个指定文件，隔离保存到 `%TEMP%/pi-gui-t3-reference.YtLqcq`，三个下载文件的 Git blob 均与本地固定树索引一致（3/3）；没有运行其源码或增加产品网络能力。

- [headlessChrome.ts L178–222](https://github.com/pingdotgg/t3code/blob/a7a6126a7d9b364c0fbef3f7fe1a087c4b004393/apps/server/src/htmlRender/headlessChrome.ts#L178-L222)：T3 用独立 Chrome 子进程、`--headless=new`、CDP pipe 和临时 profile，浏览器流量配置本地 SOCKS `publicProxy`；Pi-GUI 复用 Electron 隐藏窗口和非持久 Session，不另装浏览器服务。
- [同文件 L421–526](https://github.com/pingdotgg/t3code/blob/a7a6126a7d9b364c0fbef3f7fe1a087c4b004393/apps/server/src/htmlRender/headlessChrome.ts#L421-L526)：T3 创建 browser context/target，运行页面 JS，启动前注入 RTC 名称删除、限制文档导航；等待字体及两帧绘制后测量并截图，截图高度上限 4000、总超时 20 秒。不能把这些机制视为本项目三种 realm 的原生资格证明；本项目资格不足时静态降级，因此不会声称能验证动态 DOM/Canvas。
- [同文件 L135–158、L321–330](https://github.com/pingdotgg/t3code/blob/a7a6126a7d9b364c0fbef3f7fe1a087c4b004393/apps/server/src/htmlRender/headlessChrome.ts#L135-L158)：T3 取得 console 参数、异常描述和部分日志 URL，再裁至最多 20 条、每条 500 字符；Pi-GUI 根据自身隐私约束只传固定闭集描述/计数和有界位置，不复制这一原文反馈方式。
- [HtmlRender.ts L270–356、L501–597](https://github.com/pingdotgg/t3code/blob/a7a6126a7d9b364c0fbef3f7fe1a087c4b004393/apps/server/src/htmlRender/HtmlRender.ts#L501-L597)：T3 内联识别出的本地图片（含更多图片类型），preview 不建立正式 attachment；publish 才写 HTML 并记录 thread reference，测高失败可发布。Pi-GUI 不开放路径读取，使用已有受限 HTTPS 栅格资源声明准备器；临时预览与正式发布也继续分离。
- [HTML handlers L25–84](https://github.com/pingdotgg/t3code/blob/a7a6126a7d9b364c0fbef3f7fe1a087c4b004393/apps/server/src/mcp/toolkits/html/handlers.ts#L25-L84)：T3 `html/path` 必须二选一，只有 full-access thread 可传路径；preview 返回 PNG+反馈，render 需要 thread scope 并返回发布引用。本项目通过原有私有桥接及 Pi 官方扩展接口实现，不修改 Pi schema。
- T3 在 `HtmlRender.ts` 中默认保留沙箱，但支持显式环境 opt-out 后传 `--no-sandbox`；本项目不采用该例外。本次没有审计 T3 的 `publicProxy` 和全部 host 配置，不能宣称任一实现整体安全或两者安全等价。

## 审查、限制与交付状态

- 独立功能审查：Blocker 0 / Important 1，确认未知 `DOMException`、自定义异常或非 Error 抛出值会被新增白名单丢弃。作者补测试先得到 0/1（退出 1），再保留 `{ code: 'script_error' }` 通用降级，不输出名称/值；完整定向复验 249/249。该小修由作者处置，未宣称已再次独立复审。
- 独立安全审查：本次产品 diff 新增确认安全发现 0，离线服务/公开投影测试 29/29；这不是原生隔离证明。独立功能审查另跑桥接/服务 24/24、自检 25/25，审查者没有启动 GUI、网络专项或模型。
- 历史 P2 28/29、P3 24/25 与监听器意外连接记录继续未通过，不能归为普通 CI 环境问题；本轮没有重复受阻专项或扩大权限。
- 构建仍提示既有 PDF 字体许可来源对应问题，不能把本次构建视为再分发/发版批准。
- 回滚：按产品变更与验收驱动的独立提交分别 `git revert`，再使用已有缓存执行 `npm run build:app -- --rebuild`；不删除用户会话、Artifact 或本轮开始前的无关文件。
- 开发：收尾代码及良性应用功能已实现；模型完整闭环、交互与整体安全资格仍未通过。代码验收：独立审查已返回并处置确认问题，但完整门槛仍未通过，等待用户实际验收。合并许可：未授权。发布许可：未授权。
