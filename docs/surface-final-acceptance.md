# Surface 与统一文件预览：最终整改验收

日期：**2026-11-26**。本文以当前代码状态为准；2026-11-25 的报告内容保留在 Git 历史中，
其中字体许可「已核验定案、阻断解除」的结论**已撤回**。历史状态与当前状态在下文分开记录，
不把旧基线的 CI、旧运行或旧截图继承为当前证明。

## 一、当前身份、范围与结论

- 分支：`feat/unified-file-viewer`；既有 PR [#112](https://github.com/HYJ1817/pi-gui/pull/112)，不新建 PR。
- 本轮基线：`cba8398260a7272eca14a3a57d027dc3634f3ca1`（远端分支当时的 HEAD）。
  证据代码状态 = 该 SHA **加上本文所在的未提交整改**；最终提交 SHA 见交付消息，本文不自引用。
- 风险：**高**。涉及跨会话恢复、Surface 生命周期、文件访问绑定、第三方字体许可与发布门槛。
- 当前结论：
  - 定向功能/回归、受影响 canonical 检查与**重建后的正式产物桌面验收通过**；
  - **完整 canonical 交由最终提交的 PR CI，尚未完成 → 代码验收整体仍为待验证**；
  - **L1 字体许可阻断保留**（对应源码未闭合）；不合并、不打 tag、不发布。
- 用户仅授权提交、推送当前分支并更新 #112；合并与发布须另行明确授权。

## 二、外部验收 F1–F9（与内部 F1–F6 编号不同）

| 编号 | 外部验收要求 | 当前证据（本代码状态） | 状态 |
| --- | --- | --- | --- |
| F1 | 完整 CI 回归与旧 Surface 合同迁移 | `npm run test:ci` 346 leaves / 5 groups，coverage exact；`npm test` 唯一入口未改写。完整运行交由最终提交的 PR CI | **待验证**（CI 未完成） |
| F2 | 文件 tab 恢复竞态（R0） | restore-race 37/37；正式产物自然 close-all/reopen 顺序 `openError:null`、`activeFileTab:guide.md` | 通过（本地 + 生产产物） |
| F3 | 关闭最后一个 Surface 的行为 | surface-tabs 174/174（47 类）；打包 `surface-last-close-launcher` 断言面板仍开、0 个 `.work-surface-tab` | 通过 |
| F4 | PPTX XML 属性顺序 | office 119/119 + PPTX 50 tests；真实 SVG/DOM 投影断言 | 通过（本地定向） |
| F5 | Office 超链接兼容 | office 119/119 覆盖；代码未在本轮改动 | 通过（本地定向） |
| F6 | 自建 PPTX 日常兼容（项目符号/自动编号/多级/真实软件文件） | 真实 LibreOffice 保存的 `libreoffice-bullets-mixed.pptx`、`libreoffice-autonum-multilevel.pptx` 实际渲染并断言标记；第二页真实幻灯片。PowerPoint / WPS 桌面应用未实测 | 通过（有限范围） |
| F7 | Changes 文件条目身份绑定 | changes-file-identity 9/9；workspace/epoch/session/worktree 替换均不读旧文件 | 通过 |
| F8 | T3 Code 风格 UI 收尾 | 最新正式产物 11 张真实截图；居中偏差、紧凑工具栏、无底边线、无溢出均有断言 | 通过（视觉） |
| F9 | 第三方依赖许可（PDF 字体） | 对应源码机制与 fail-closed 门槛成立；**PDF.js 四字体与历史 TTF 的准确对应关系未闭合** | **发布阻断** |

## 三、当前定向测试（实际数字）

环境：Windows 11；Node v24.22.1；Electron 44.4.3 / Chromium 152.0.7977.130。
桌面使用正常 sandbox/contextIsolation、无 renderer Node globals、无 `--no-sandbox`；
TEMP fixture、fake Pi、离线网络门控；没有真实模型调用或用户项目写操作。

| 命令/套件 | 实测结果 |
| --- | --- |
| `node --test tests/files-restore-race.cjs` | **37/37**（新增 3 条滚动/折叠回归 + 1 条同名文件工作区替换回归） |
| `node --test tests/files-surface-lifecycle.cjs` | **13/13** |
| `node --test tests/surface-tabs.cjs` | **174/174 assertions，47 类，0 skipped** |
| `node --test tests/surface-lifecycle.cjs` | **257/257 assertions，56 类，0 skipped** |
| `node tests/changes-file-identity.cjs` | **9/9** |
| `node tests/context-reference-ui.cjs` | **13/13** |
| `node --test tests/file-preview-backend.cjs` | **31 checks / 270 assertions**（连续三次通过，7.1–7.4 s；更早一次曾出现一次未复现失败，见第五节） |
| `node tests/file-preview-vendor.cjs` | 默认空缓存 **39/39**（357 files / 10,038,557 bytes）；独立复审用真实缓存 **40/40** |
| `node tests/release-artifacts.cjs` | **77/77** |
| `node tests/ci-workflow.cjs` | **5/5 + 15/15** |
| `npm run test:ci` | exit 0；**346 leaves / 5 groups**，coverage exact；gate fail-closed matrix 15/15 |
| `npm run test:file-preview` | 见下方分项；核心/后端/面板/Office/PPTX/媒体/PDF/入口/vendor 全部通过 |
| `node tests/file-preview-packaged.cjs --output-root <worktree>` | **132/132**（9 外层 + 123 桌面）；33 张截图；11 个进程身份残留 0；资格 `packaged-production-main-normal-sandbox` |

`npm run test:file-preview` 分项：core 62 tests + ESM 7、backend 31 checks / 270 assertions、
panel 70 checks、office 119/119、PPTX 50 tests、media-archive 44 tests、PDF 15/15、
entry 35/35、vendor 39/39。跳过的断言不计入分子分母；本文只引用套件自己打印的分母。

未运行：完整 `npm test`（按用户选择由 PR CI 完成）；未修改 manifest 的普通双击启动；
原生外部文件授权对话框；真实 Pi/供应商/模型；其它 OS、全部 codec、长时间内存稳定性；
安装/升级/签名。未执行不等于通过。

## 四、最新桌面产物与证据

离线双构建：`npm run build:app -- --rebuild`，使用已存在的 Electron 44.4.3 ZIP
（`PI_GUI_ELECTRON_ZIP_DIR`），未下载运行时。构建后实际启动的是默认产物的 TEMP 字节相同副本，
只替换 TEMP 副本的 manifest 观测入口，production main/preload/backend/public 字节不变。
SEA 注入仍有既有 `The signature seems corrupted!` warning，未隐藏；不据此宣称代码签名。

| 对象 | 实测大小/摘要 |
| --- | --- |
| `build/Pi GUI.exe` | 121,608,704 bytes；`68737337527d508e2e80bd9b4ccb2b0cf6988e5cf57d0555eff0f4d4efb3b3b8` |
| `dist-app/Pi GUI-win32-x64/Pi GUI.exe` | 246,324,736 bytes；`71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f` |
| App 内 backend bundle | 3,873,898 bytes；`35a0a4618080194001463d2c3fc4ba6e4d9e418ab1137f36e38bef35ac6905e5` |
| `public/`（源 = staging = 打包 App，逐文件 660 项全部一致） | 660 files / 19,067,121 bytes；清单摘要 `f0efbf678d8a9573683c379dcab28984210db802cc179046f2868ffdc1a3dcb3` |
| preview vendor（`versions.json`） | 362 files / 14,040,820 bytes；manifest `2805fddb0888bf14e48cdd873e8b1aa78e0648f06fd9b2cf86842b94723a89ba` |
| node-pty / conpty.node | 1.1.0；`fe61108b40fcf0c1172d6e193f482e6ef2e0d9b1a447468b6a1eb7c67ca80271` |

产物验收运行 `pi-preview-packaged-oZyex5`：132/132、123 条桌面交互断言、33 张原始
`webContents.capturePage()` 截图、32,995 ms；SEA 服务的 660 个 public 文件逐字节与源一致；
48 个桌面模块字节一致；11 个观察到的进程身份退出后残留 0。

代表性截图与来源记录已归档到
[`docs/surface-final-evidence/2026-11-26/`](surface-final-evidence/2026-11-26/README.md)：
深/浅 Launcher、顶部无旧工具空标签、多 Surface 标签栏、关闭最后一个 Surface、1320/700
查看器、真实 PPTX 项目符号/多级编号/第二页、未嵌入字体 PDF。每张图的源运行、字节与
SHA-256 见该目录 `manifest.json`。上一级目录 2026-11-25 的图片是历史证据，不冒充当前运行。

关键 UI 断言（打包产物）：Launcher 标题居中、键帽有背景、0 个 `.work-surface-tab`、
无多余说明文案；活动 tab 底边 `0px` 且无 `::after`；工具栏 `toolbarOverflow ≤ 1` 且
overflow-x 不为 auto/scroll；1320/700 × 深/浅四组公共几何误差 ≤2px，聊天 DOM inert。

## 五、本轮代码改动与失败修复

本轮相对 `cba83982` 的未提交改动集中在：

| 范围 | 行为与边界 |
| --- | --- |
| `public/files-tree.js` | 滚动意图与 DOM 分离；只在刷新恢复窗口忽略占位符 clamp，窗口结束后每个滚动事件都是用户意图；折叠父目录后只报告可达的 `expanded`，刷新不复活隐藏子展开 |
| `public/files-panel.js` / `files-state.js` | 已确认且仍属当前工作区/运行代的 Classic owner 优先提供 sessionId；known→known 才是真实会话边界；树状态逐字段合并，用户手势优先 |
| `scripts/preview-font-source.mjs`（新）等 | 锁定 PDF.js/字体身份；原始归档内容寻址缓存；vendor/App 法务材料；`release-check`/`publish-release` 在任何构建或 GitHub 操作前 fail closed |
| 测试与文档 | restore-race 新增滚动/折叠/工作区替换回归；vendor 新增许可 fail-closed 与 notice 定位断言；验收与复审文档更新 |

失败与处置：

1. **复审 Important（本轮新引入，已修）**：上一版 `expectedScroll` 用“值相等”吞掉滚动事件。
   用户滚动后事件尚未派发时发生重绘，重绘把同值写回，随后到达的用户事件被误吞；主动回 0
   同样受影响。修复为只在刷新恢复窗口忽略滚动；新增两条回归锁。换回旧逻辑时分别实测
   `280 !== 120`、`120 !== 0`，恢复修复后 37/37。
2. **复审 Pre-existing 1（已修）**：父目录折叠后子目录仍在 `expanded` 并集，刷新会把父目录
   重新展开。`files-tree.js` 只报告从根可达的展开目录；新增折叠→刷新回归锁。
3. **复审 Pre-existing 2（保留并披露）**：owner 在 Files 挂载**之后**才建立时，外层 Surface
   的正常 context 通知仍会先退役旧实例。修复覆盖的是“owner 已建立、state 投影未到”的窗口；
   外层 scope 迁移属于禁止重写的 Surface 架构，未做，不宣称全链路已解。
4. **字体许可复审 Nit（已修）**：根 `THIRD-PARTY-NOTICES.txt` 复制的 SOURCE-INFO 相对引用
   指向不存在的位置；现在在文本前明确写出实际 vendor 路径，并由 vendor 测试锁定。
5. **font license 旧结论撤回**：2026-11-25 曾称“1.07.4 无独立源工程、TTF 即完整源码、
   阻断解除”。实际上游有源码与独立 TTF 归档，PDF.js 四字体与历史 TTF 字节/glyph 数不同，
   对应关系 **unresolved**。详见 [pdf-font-license-verification.md](pdf-font-license-verification.md)。
6. **打包 Browser 焦点偶发**：较早一次运行（116 通过 / 1 失败，stage `browser-input-focused`）
   子 `WebContentsView` 未持有焦点，属已知驱动层偶发；同一产物重跑 132/132。该失败保留记录，
   不计为产品通过。
7. **backend 一次未复现失败**：更早一次运行在第 375 行“mid-read replacement”得到 200 而非 409；
   随后连续三次 31 checks / 270 assertions 通过，代码未改。原因未定位，如实保留，不写成已修。
8. **数量变化**：restore-race 22 → 33 → 36 → **37**（新增会话窗口、滚动、折叠、工作区替换）；
   vendor 31 → **39**（默认，含真实缓存时 40）；打包 119/120 → **132**（完整桌面交互与几何）；
   surface-tabs 163 → **174**；surface-lifecycle **257**。没有删除断言换取绿色。

## 六、PR #112 CI 未触发：实际原因与当前状态

**原因已定位**：`cba83982` 的推送时间（2026-11-25T16:03:07Z）落在 GitHub 官方事故
[qn8mfv6q5hlx](https://www.githubstatus.com/incidents/qn8mfv6q5hlx) 窗口内
（15:55:19Z–16:52:16Z，涉及 Git Operations/Webhooks/API/Pull Requests/Actions）。
分支 ref 与 `git ls-remote` 已是新 SHA，但 PR 的 `head.sha`、GraphQL `headRefOid`、
`refs/pull/112/head` 仍停在 `8f565f72`；该 SHA 的 Actions run 数为 0，check-runs 与
commit statuses 为空。已排除 fork/跨仓、关闭重建、base 变更、路径过滤、skip-ci、权限/审批、
workflow 语法与分支保护；actions 已启用，CI workflow active，同 blob 曾被成功解析。

这不是本地推错，也不是“已有最新 run 未关联”：最新 SHA 根本没有 run。旧 SHA 的成功
（`45551821141`）或失败（`45607097340`）run 都不冒充当前验证。最终提交正常推送后，
须重新核对 PR head、commit 数与新 run 的 `event=pull_request`/`head_sha`/PR 关联；
run 出现不等于通过，以最终 CI gate 为准。完成前本文保持 **待验证**。

## 七、独立审查（2026-11-26）

三个独立上下文，模型 `xingchiapi/gpt-6.1-sol`（星驰），effort max；账本见
[surface-final-reviews.md](surface-final-reviews.md#2026-11-26-最终复审当前)。

- **字体许可整改复审**：通过；Blocker 0 / Important 0 / Nit 1（notice 相对定位，已修）。
  独立复算归档/字体/SFD/glyph；故障注入伪造成功字段、清空警告、跳过参数均仍被拒绝，
  前置门槛网络 0 / 子进程 0 / 文件写入 0。L1 阻断保留是正确保护。
- **会话身份与文件树复审**：首轮不通过；Blocker 0 / Important 1（滚动回显，已修）/
  Pre-existing 3（折叠刷新已修、reveal 标记保留、外层 Surface 退役时序披露）。
  指定六套实测通过；修复后 restore-race 37/37，红→绿见第五节。
- **CI 调查**：定位为 GitHub 服务事故导致 PR head 同步未完成；未修改仓库、未触发 workflow。

## 八、限制与发布阻断

- **L1 发布阻断（必须保留）**：PDF.js 四字体与 1.07.4 历史源码/TTF 的准确对应关系未闭合；
  差异在 `glyf/post/GSUB/hmtx/cmap` 等表，不只是时间戳。分发机制已随包携带完整已知上游归档
  与许可，但 `correspondence:'unresolved'`、`sourceDistributionVerified:false`；
  `release-check` 与 `publish-release` fail closed。缓存可用、测试通过或附带许可文本都不是
  合规批准；不得把布尔值改成 true 解禁。详见
  [pdf-font-license-verification.md](pdf-font-license-verification.md)。
- **完整 canonical**：最终提交的 PR CI 未完成前为待验证；本地只跑定向与受影响套件。
- **Surface 时序**：owner 晚于 Files 挂载建立时的外层实例退役未修，保留严格隔离并披露；
  `reveal()` 的滚动仍计为导航意图（基线行为）。
- **范围外未验证**：PowerPoint/WPS 桌面应用、其它 OS、全部 codec、长时间内存稳定性、
  安装/原位置升级/签名、未改 manifest 的普通启动、原生授权对话框与晚期撤权响应。
- **SEA 边界**：打包验收覆盖 SEA 实际服务的 660 个 public 文件与 48 个桌面模块，逐字节一致；
  未对 exe 内部全部字节做静态枚举。
- 本文与字体文档是工程证据，不是法律意见。

## 九、回滚

按业务代码 / 测试基建 / 许可与构建 / 文档的提交边界分别 revert 本轮提交，再从锁定依赖
离线重建。不 reset 用户其它工作，不清理根目录未跟踪文件，不删除真实会话或文件。
既有只读文件授权账本与 Pi schema 未更改，不需要数据迁移。

## 十、阶段状态

| 阶段 | 当前状态 |
| --- | --- |
| 开发完成 | 已完成；已知发现均处置或如实披露 |
| 代码验收通过 | **待验证**：本地定向与正式产物通过；最终提交 PR CI 未完成 |
| 提交 / 推送 | 已授权；本文提交后执行，最终 SHA 见交付消息 |
| 合并许可 | 未授权，不合并 |
| 发布许可 | 未授权，不打 tag、不发布 |
| L1 字体许可 | **发布阻断保留**；对应源码未闭合 |
