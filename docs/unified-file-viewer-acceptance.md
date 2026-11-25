# 统一文件查看器第二阶段：验收材料

## 当前结论与身份

- 日期：2026-11-25；分支 `feat/unified-file-viewer`。
- before HEAD：`032b96659faee5d2a1252fbb744b2da4c5f3ef3d`。本材料覆盖该 HEAD 之上的第二阶段变更，不把基线 CI 当作新增变更的通过证明。
- after HEAD：包含本报告的交付提交，以 `git log -1 --format=%H -- docs/unified-file-viewer-acceptance.md` 解析；最终交付消息另给出实测 SHA。以下运行在提交前的同一产品/测试/构建文件树执行，随后验收文字单列，不声称它们是新 SHA 的 CI。
- 行为/测试/构建交付 SHA：`6a0c5cdc953003e9992ce2a759cd6061868c2381`；依赖的独立 ESM 测试基建为此前的 `f38b945b`。其后的验收材料提交不改变产品行为。
- 风险：**高**，涉及受控文件读取、对象身份、撤销、复杂文档解析、依赖和构建入口。
- 功能已实现且默认可用，有定向、真实正常沙箱及重建产物证据；**最终新增 diff 的独立复核和当前 PR 完整 canonical 仍待验证，整体代码验收未通过**。PPTX 二进制再分发许可未决，不能发布。
- 本地完整 `npm test` **未运行，遵照用户明确要求**；完整证明选用当前 PR CI，成功结果出现前为「待验证」。未合并、未发版。

准确旧基线完整 CI：[45455659169](https://github.com/HYJ1817/pi-gui/actions/runs/45455659169)，`push`、attempt 1、head SHA 同 before HEAD、success；只证明基线。

## 实际交付范围与所有者

沿用既有 Files Surface 和 `openFileReference(request)`，没有第二套文件授权体系或完整 IDE。

| 模块 | 变化与边界 |
| --- | --- |
| `public/files-panel.js`、`files-state.js`、`files-tabs.js`、`files-tree.js`、`files-layout.js` | 面板、标签、树、布局和阅读状态的所有者；同文件复用、同名消歧、键盘/指针切换、关闭/排序、刷新/有界搜索、窄窗树 overlay、最大化/还原 |
| `public/file-preview/index.js`、`access.js`、`common.js` 及格式叶子 | 按需加载、单活动预览实例；经受控 access 读取；切换/关闭/撤销时 abort/terminate/revoke；迟到结果不得重新挂载 |
| `public/api.js`、`server/files.js`、`server/router.js`、`lib/file-preview-*.js` | 扩展既有 files owner 的内容与搜索接口，复用 workspace generation、conversation、fileId 和既有 external grant |
| `public/attachment-preview.js`、`attachment-view.js`、`ui/user-message-body.js`、`markdown.js`、`git.js` | 消息引用、原始附件 File、工作区文件与 Changes「查看文件」统一进入；保留上传/发送/移除及 Changes 真正 diff |
| `scripts/sync-preview-vendor.mjs`、`preview-browser-globals.mjs`、`build-exe.mjs`、`package.json` / lock、`.gitignore` | 本地 parser/Worker/字体/CMap/WASM 的锁定来源、许可及生成清单；安装后离线生成，构建前显式刷新，生成 vendor 不入 Git，无 CDN/在线转换 |
| `tests/file-preview-*.cjs` 及相关 fixtures、ESM helper | canonical 定向链、安全/生命周期回归、真实正常沙箱及打包观察专项；不复制第二份 canonical 清单 |

实际格式：

- 文本/源码：行号、语法高亮、包含式行列范围、复制引用、字面搜索、自动/显式编码及有界虚拟化。
- Markdown：源码/阅读切换、目录、表格、KaTeX、重新授权的相对图片与链接；不执行 MDX，不写回任务项。
- HTML：默认源码；静态预览使用净化内容、空 sandbox 和有效 CSP；只读取重新授权的相对图片/安全样式，不执行脚本、表单或导航。
- PDF：本地 PDF.js Worker、真实 canvas/文本层、页码、缩放/适宽、跨页字面搜索、目录、有界驻留/文本缓存；加密、损坏及超预算明确降级。
- DOCX：Mammoth Worker 的真实正文结构、列表、表格和受控图片；不是 Word 全保真排版。
- XLSX：ExcelJS Worker 的真实工作表、显示值/格式、合并单元格、缓存公式值和虚拟表格；只展示，不重算公式。
- CSV/TSV：PapaParse 处理带引号分隔符、跨行和原样公式文本。
- PPTX：实际幻灯片解析、形状/文字绘制、页码和缩放；受控 renderer 在 opaque `allow-scripts` iframe 内运行，无 same-origin/app bridge。动画、高级图表、嵌入媒体和复杂字体可能不支持；二进制再分发许可仍未解决。
- 图片：安全 img 上下文、实际解码、缩放/适配；SVG 不插入主 DOM。
- 音视频：原生 controls，不自动播放；container/codec 受浏览器与 OS 限制。实测 PNG、WAV 和离线生成的真实 H.264 MP4，不能由扩展名候选列表推定所有 codec 成功。
- ZIP：有界目录、完整成员路径、搜索/展开/选择、小文本/Markdown/CSV/TSV/图片成员预览；不落盘解压、不执行、不自动递归二进制 Office 或嵌套归档。
- 不支持、损坏、二进制或超大文件走既有安全打开降级，不伪造正文、摘要或默认关闭功能。

未实现文件编辑、保存、删除、重命名、宏执行、远程数据连接、第三方上传/在线解析；未改 pi 本体或用户全局 npm。外部授权目录不加入 tree/search；搜索最多4000条、深度8、100结果；读取在既有 owner/grant/fileId 边界内重复校验，单 Range 最多8MiB。

## 已确认发现与整改

| 编号 | 根因与修复 | 修前/修后证据 |
| --- | --- | --- |
| 选中态白框 | 四处持久选中态错误使用 inset 白线；改为共享中性 active 背景、主文字、semibold，保留独立 `:focus-visible` | 历史专项修前32通过/20失败；四组真实渲染和键盘现均通过，见[历史专项](unified-file-viewer-selection-fix.md) |
| I1 普通附件撤销 | 原缩略图 Map 只登记图片/视频，普通附件发送后没有撤销；实际打开所有原始 File 时登记轻量生命周期，不创建无用 ObjectURL | entry 29通过/4失败→33/33；panel 锁住附件ZIP父子标签一起撤销；实际 reconciliation 与独立在途读取撤销7/7 |
| I2 ZIP CSV/TSV | 按钮允许表格，byte gate 却因 office 分类拒绝；按钮/access 共用轻量 `archive-policy.js`，保持256KiB文本/8MiB图片预算 | core 54通过/3失败→58/58；真实CSV/TSV Worker表格，HTML/嵌套ZIP/二进制Office仍拒绝 |
| I3 阅读状态 | 通用投影丢 PDF `fitWidth/pageOffset`、PPTX字符串scale、ZIP搜索/展开/选择；按真实契约做精确有界投影 | panel 62→69→70 checks；源码/built/正式main跨标签恢复，无删旧断言 |
| 字面文件名 | 将真实文件名的 `#/?` 误作URL后缀；只有relative所有者解析URL，文件名按字面扩展名分类 | 新回归修前0/1、`archive !== text`；修后core58/58；真正`.zip`仍拒绝 |
| 旋转PDF页内漂移 | 当前页占位几何更新时漏补锚点；条件 `<`→`<=` | 首次built151通过/3失败之一，offset .5183→.6706；现 .4007937476748512→.4007937476748512，未放宽.02容差 |
| ZIP键盘fixture | 恢复后目录已展开，旧fixture点击反而折叠，造成两项light焦点失败 | 仅未展开时点击并等待open，保留原焦点/对比度断言 |
| PDF搜索输入fixture | canvas先就绪、异步outline随后插入工具栏使坐标偏移 | 合法outline fixture先等目录；真实click/type并强断言focus/value，不用程序化focus替代 |
| 无效CSP | Chromium忽略`navigate-to`并报错；删除无效声明，导航隔离仍由净化+空sandbox承担 | 新回归修前0/1；core58/58；实际HTML opaque、无脚本/表单/导航/远程资源，相对PNG真正绘制 |
| PDF ResizeObserver循环 | observer delivery里直接setZoom改变自身布局；改为实例持有、至多一个下一帧RAF，执行前复核current/pdf/fitWidth，dispose取消 | 结构诊断归因旧PDF61字符error；新增真实断言修前154通过/1失败；修后源码156/156、built156/156、真实Chrome PDF67/67 |
| 干净安装/公开生成代码边界 | 可再生vendor不进Git；`postinstall`→`sync:preview`离线生成，既有build前置生成保留 | vendor21→23/23：安装alias+ignore规则、干净TEMP生成器CLI、CLI/direct字节身份一致；许可warning保留。未用实际联网npm ci冒充该fixture |

新状态仍有界：PDF offset clamp [0,1]；PPTX scale固定枚举兼容numeric；ZIP query≤256字符、路径≤1024、expanded去重≤96项/总8192字符且输入扫描有界。仍24 tabs、6 scope LRU、192KiB存储；不持久化document bytes/grantId，外部grant、附件、archive child不跨重启恢复。

## 实际验证

环境：Windows11；Electron **44.4.3** / Chromium **152.0.7977.130**，桌面Node **24.21.0**。正常sandbox/contextIsolation，无renderer Node/CDP/`--no-sandbox`。测试数据、Git、fake Pi、HOME/profile、附件及写盘均在唯一`os.tmpdir()` fixture，不调用真实模型。

| 证据层 | 实际命令 | 实际结果与边界 |
| --- | --- | --- |
| 离线生成入口 | `npm run postinstall` | exit0；369 files / 11,759,833 bytes / 38 packages；不下载、不运行上游构建脚本、不读取用户文档 |
| 预览完整定向链 | `npm run test:file-preview` | core **58/58**、ESM **7/7**、backend **31 checks / 270 assertions**、panel **70 checks**、Office **90/90**、media/archive **44/44**、PDF **15/15**、entry **33/33**、vendor **23/23**；exit0，零失败/skip；包含最终安装入口变更 |
| 后端专项实测 | 上述backend | Range **8,388,608+1,048,576 bytes**；最新stalled-revoke读 **65,536 bytes** 后终止；读前/中/后身份、owner/grant撤销回归通过，非绝对无TOCTOU保证 |
| 相邻附件 | `npm run test:attachments` | **53/53** |
| 相邻文件授权/入口 | `npm run test:file-links` | model66、backend24、external-grants26、external-files20、editor-settings22、editor-settings-ui8、UI51、runtime8、highlight12，均通过 |
| Files/终端 | `node tests/files-terminal-ui.cjs` | **95 checks** |
| CI机制自测 | `npm run test:ci` | **340 leaves / 5 groups、coverage exact**；readiness5/5、gate fail-closed15/15、results10/10、summary30/30、history21assertions、doc-scope28/28、release-proof16/16、NSISfixture12/12；exit0。是机制fixture，不是当前PR远端CI |
| 文件规模 | `npm run test:file-size-report` | **11/11**，exit0 |
| 既有smoke | `node tests/smoke.cjs` | **1339/1339** |
| PDF真实Chrome | `node tests/file-preview-pdf.cjs --browser` | **67/67**，screenshots6、workers21/21、renders53、text86、无远程attempt；覆盖最终PDF RAF修复，不是正式main证明 |
| 源码真实桌面 | `npm run test:file-preview:desktop`，无`PREVIEW_APP_ROOT` | **156/156**、零skip、残留0；包含HTML/PDF最终逻辑，在仅安装准备元数据变更前执行 |
| 最终离线重建 | `npm run build:app -- --rebuild`；已有Electron ZIP | exit0；SEA/Electron均重建、865资源，未下载runtime；缓存ZIP模式不声称本次重新取得上游checksum；保留既有签名/PPTX许可warning |
| 最终built真实桌面 | 同desktop，`PREVIEW_APP_ROOT=dist-app/Pi GUI-win32-x64/resources/app` | **156/156**、零skip；34,490ms，观察12进程身份、残留0；测试自有main+生产renderer/CSS/preload/backend，覆盖最终lock/生成结果 |
| 最终正式main+全部资源 | `npm run test:file-preview:packaged` | **88/88**：79交互+9父检查、零skip；22,032ms、观察11进程身份、残留0；TEMP manifest观察bootstrap，正式main/preload/backend/public不改，无CDP/沙箱绕过 |
| 最终App后端 | `CHECK_PORT=18766 npm run test:app`，offline env | **27/27**，exit0；无node_modules回退，真实PTY、TEMP文档抽取/隔离；产物目录无写入 |
| 最终SEA运行 | `CHECK_PORT=18767 npm run test:exe`，offline env | **57/57**，exit0；实际启动、嵌入资源、TEMP配置/skills/MCP/PDF、真实PTY、无崩栈/产物写入 |
| 本地完整canonical | `npm test` | **未运行，用户要求；当前PR完整CI待验证** |
| 模型/安装升级 | 未运行 | 无真实Pi/模型、安装升级、签名或发布证明 |

最新定向日志：`%TEMP%/pi-preview-final-targeted-YfGmTN.log`；构建：`%TEMP%/pi-preview-final-build-3d6qZF.log`；产物运行：`%TEMP%/pi-preview-final-runtime-dKmaCh.log`。前一轮相邻/完整定向实测另保留于本会话工具记录，不把新postinstall以外的元数据变化扩大为旧测试全树证明。

计数变化：desktop143→155新增附件reconciliation1、PDF恢复2、PPTX恢复/绘制2、ZIP状态2、CSV/TSV offer/表格4、嵌套ZIP拒绝1；155→156新增禁止ResizeObserver循环1。packaged76→88新增同组12项，但**不包含**新desktop console循环断言。vendor21→23新增安装入口2项；panel62→70、core57→58均新增回归。无删旧断言、skip、放宽安全门控或容差。

## UI证据与实际边界

四组CSS **1320×820 / 700×600 × 深/浅**、DPR **1.5**；中英文fixture、真实鼠标/Tab/Shift+Tab/方向键/Esc、标签菜单/排序/关闭、125%字体、最大化/还原、窄树overlay及分隔条。正式main窄窗实测CSS **701×602**、surfaceWidth **701.3333740234375**，不是严格700×600。选中与焦点分开；保留单道2px focus-visible，普通文字≥4.5:1、焦点≥3:1。

文档白纸/内容颜色是只读文档投影，不扩散到应用chrome；工具栏、菜单、树、tabs沿用共享Token/原语。Office/PDF非全保真、codec和预算限制不能由截图推定消失。

已实际打开审阅四组Files及PDF/PPTX第二页/ZIP TSV真实图；最小长期代表图与动作/来源见[精选证据](unified-file-viewer-evidence/stage2/README.md)。它们来自最终产品逻辑、安装元数据改动前的已验证构建；最终同逻辑产物又实测156/88，完整输出不整套入库。

短期证据索引：

- 首次built失败：`%TEMP%/pi-preview-desktop-RXjhtR/evidence`，151通过/3失败。
- 循环断言修前失败：`%TEMP%/pi-preview-desktop-PRPFwx/evidence`，154通过/1失败。
- PDF RAF修后源码：`%TEMP%/pi-preview-desktop-6h38tb/evidence`，156/156。
- PDF Chrome：`%TEMP%/pi-pdf-test-4yUljp`，67/67。
- 精选图来源built：`%TEMP%/pi-preview-desktop-trczoU/evidence`，156/156；正式main：`%TEMP%/pi-preview-packaged-p4nq4U/evidence`，88/88。
- **最终安装/lock重建态**built：`%TEMP%/pi-preview-desktop-mRJH1L/evidence`，156/156；正式main/SEA全资源：`%TEMP%/pi-preview-packaged-iO9kRc/evidence`，88/88。

控制台不隐去：旧PDF的other-error经固定结构分类确认是ResizeObserver循环并修复。最终built **1条error**，仅HTML fixture检查空sandbox iframe遭拒的`sandbox-script-denied`；rendererGone0、blockedNonLoopback0。没有静默过滤原始error数量，也不宣称「零控制台错误」。诊断仅固定分类、长度/来源结构，不存原始message、URL参数、文档payload。

## 最新产物身份

最终packaged专项逐一比较source、staging、Electron public与SEA HTTP响应的全部 **664 files / 16,411,332 bytes**，含Worker、字体、CMap、WASM；正式desktop模块48个字节一致。

| 对象 | 实测bytes / SHA-256 |
| --- | --- |
| public身份清单 | `38ceb2daa4aa13c2cb0e89ca776d5c29effcebc1c0d7234ff52874bdb158084d` |
| SEA `build/Pi GUI.exe` | 118,952,960 bytes；`cffa9acff02b4226b72afd7b64259bf3224a380cc17c880a5433bfdcf72a2296` |
| Electron exe壳 | 246,324,736 bytes；`71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f`，壳digest不单独代表public |
| 随包backend | `35a0a4618080194001463d2c3fc4ba6e4d9e418ab1137f36e38bef35ac6905e5` |
| vendor | 369 files / 11,759,833 bytes / 38 packages；manifest `f0efbefac09f5ff5f7d7d08fc7aad6141decf0f56705d02e9f1882b8c1d3619d`；tree `e6f9a26d3c56b76216577b1dd3557d4c8e1613b4bdabaf85206fae56e88048ab` |

lock增加根`hasInstallScript`后，manifest含packageLockSha256，故身份与旧p4nq4U不同；已重新生成/构建/运行，未沿用旧digest。

## 独立审查、许可与残余风险

- 完整功能首轮相对before HEAD检查tracked+untracked：**Blocker0 / Important3 / Nit0 / Pre-existing0**，发现I1–I3；现均有修前失败、修后回归和独立增量复核，不把初次不通过抹掉。
- 两次安全静态筛查均**0个置信≥8/10的新增HIGH/MEDIUM findings**；覆盖认证/scope、content/Range/search、路径/身份/grant、HTML/Office/SVG/ZIP/PDF及附件撤销。限制：只读静态，未作机械逐hunk全量diff核验、动态利用或逐字审计压缩vendor；不是无条件安全保证。动态身份/撤销和sandbox证据由专项单列。
- 白框历史专项独立复核**Blocker0 / Important0 / Nit2**；两Nit作者修复并补故障注入，见历史记录，不扩大范围。
- I1–I3/PDF锚点及直接调用边界独立增量复核**通过：Blocker0 / Important0 / Nit0 / Pre-existing0**；独立执行core58、panel70、entry33、attachments53、Office90、media44、PDF15、desktop155/155，另在途File撤销故障注入**7/7**。其桌面早于最后CSP/ResizeObserver/安装准备修正，不能冒充156或完整canonical。
- 最后CSP、PDF owned RAF及生成安装边界的独立复核尚待返回；不预填零发现或通过。
- 许可研究任务因供应商API错误失败（`gpt-6.1-sol requires Responses for tool calls; this account only supports Chat Completions`），**未形成独立许可结论**；没有擅换模型/provider或伪造研究通过。
- 作者核对：`pptx-preview@1.0.7` npm元数据是ISC，但包内没有LICENSE，README另区分npm包免费自用/商用和源码公开/修改限制；归档上游正文也存在该区分。当前实际入口是**npm已发布的`dist/pptx-preview.es.js`重新bundle**，不是上游TypeScript源码重建。仍不能由字段ISC或免费使用推定再分发已批准。
- **源码PR策略**：忽略整个`public/vendor/file-preview/`，只交付产品代码、生成器及锁文件；正常完整依赖安装后离线生成，`--ignore-scripts`需手动`npm run sync:preview`，源码开发需要esbuild等dev依赖；构建仍显式生成。PPTX默认可用，未删功能/默认关闭。此策略避免把生成的第三方代码公开入Git，**不解决二进制再分发许可**；manifest的`licenseStatus`、`legalReviewRequired`和构建warning保留，未上传任何二进制。
- 未验证：无观察bootstrap的原样manifest启动、原生external grant对话框端到端、强制颜色、多屏DPI、其他OS/codec、长时内存、真实模型、安装升级、当前PR完整canonical。

## 回滚与操作授权

只读用户文档，无用户数据迁移。按实际测试基建→业务→报告提交的依赖顺序逆序`git revert <明确提交>`，恢复匹配package/lock；安装准备或`npm run sync:preview`后离线`npm run build:app -- --rebuild`。不要整树reset/restore或回退用户项目文件；不以PID序号清理他人进程。仅生成/构建目录可再生，不是用户文件恢复方案。

用户授权完成后提交、推送、创建完整PR；不代替验收、法律、合并或发布门槛。当前分别为：**开发实现完成；最终独立复核/PR canonical待验证，代码验收未通过；合并未授权；发版未授权且PPTX再分发许可未决**。
