# Files 选中态白线修复记录

## 范围与身份

- 日期：2026-11-25；分支 `feat/unified-file-viewer`。
- before HEAD：`032b96659faee5d2a1252fbb744b2da4c5f3ef3d`。本次证据覆盖该 HEAD 上尚未提交的统一文件预览工作区，加本轮四处样式修复；不是该 HEAD 的完整 canonical 证明。
- after：本专项记录时尚未提交。本报告只记录用户截图所示选中态问题，以下状态、数字与产物身份均限定于本专项时点；后续 I1–I3 等整改及新产物见[第二阶段验收材料](unified-file-viewer-acceptance.md)。
- 风险：中，修改选中态的视觉表达及其桌面回归，不改文件读取、授权、发送、存储或解析逻辑。

## 根因、规范与修改

用户截图中，标签底部和文件树行左侧的白线，是新增选中态的 `inset box-shadow`，不是浏览器默认焦点框。失焦仍存在。此前截图验收漏掉该问题，已有功能测试通过不能证明 UI 符合规范。

按[全局规范](ui/design-system.md#交互状态与焦点)区分选中和键盘焦点，并复用现有外壳导航的中性背景、主文字语义：

| 文件及目标 | 原实现 | 本轮修改 |
| --- | --- | --- |
| `public/file-links.css`：`.files-tab[aria-selected="true"]` | 白色底部内阴影 | 移除阴影，保留 `--ds-bg-active` / `--ds-text-primary`，用 `--font-weight-semibold` 辅助区分 |
| `public/ui4-pane.css`：`.files-entry[aria-selected="true"]` | 白色左侧内阴影 | 同上 |
| `public/file-preview/media-archive.css`：`.fp-archive-entry[aria-pressed="true"]` | 同类左侧内阴影 | 同上 |
| `public/file-preview/office.css`：工作表选中标签 | 同类底部内阴影 | 同上 |

未全局清空 outline，未调用 blur 来掩盖截图，未改焦点事件或移除键盘入口。`:focus-visible` 继续提供规范要求的一道 `2px solid var(--ds-focus)` 提示。表格单元格范围选择、PDF/Markdown 搜索命中、拖放落点不属于本轮导航选中态，不作无差别删除。

入口按实际加载顺序检查：`index.html` 中 `tokens.css` → `ui/primitives.css` → `styles.css` → `ui4-pane.css` → `file-links.css`，Office、ZIP 格式样式由真实 registry 按需加载。没有增加依赖、远端资源或另一套主题 Token。

## 实际验证

Windows 11；Electron **44.4.3**，Chromium **152.0.7977.130**；正常 sandbox、contextIsolation、renderer 无 Node，无 CDP。所有输入数据、Git 仓库、fake Pi、profile 和写操作均在唯一 `os.tmpdir()` fixture，不写真实项目数据，不调用模型。

新增 `tests/fixtures/file-preview-desktop-selection.cjs`，接入既有桌面 runner 的默认完整场景，也可通过 `--selection-only` 单独运行本轮回归。检查使用真实鼠标事件、Tab/Shift+Tab 和方向键，未用强制 CSS 伪状态或程序化 focus 替代本轮焦点检查。

| 证据层 | 命令 | 实际结果与范围 |
| --- | --- | --- |
| 修复前真实渲染 | `node tests/file-preview-desktop.cjs --selection-only` | **32 通过 / 20 失败**；四组各 5 个装饰白线相关断言失败；键盘指示原本通过 |
| 源码真实渲染 | 同上，使用本机已准备的离线 Electron | **53/53**，含进程清理；零跳过，残留 0 |
| 重建资源真实渲染 | 同上，`PREVIEW_APP_ROOT` 指向 `dist-app/Pi GUI-win32-x64/resources/app` | **53/53**，零跳过；观察进程身份 9，残留 0；耗时 18,854ms；consoleErrors 0、rendererGone 0、blockedNonLoopback 0 |
| 重建资源完整桌面专项 | 同一 `PREVIEW_APP_ROOT` 下运行 `npm run test:file-preview:desktop` | 初次 **127/127**；处置独立复核 Nit 后 **143/143**，正常 sandbox，零跳过，进程残留 0；新增 16 项替代选中标记断言，保留所有既有检查 |
| 打包资源与正式 main 专项 | `npm run test:file-preview:packaged` | **76/76**，零跳过，进程残留 0；663 项 public 资源（16,408,604 bytes）在源码、staging、Electron 包与 SEA 实际响应中逐字节一致；TEMP 观察 bootstrap 加载正式 main |
| 本地定向 | `node tests/file-preview-panel.cjs` | 初次 **55 checks**；处置 Nit 后 **62 checks**，新增 7 项控制流故障注入/断言负例，未删除原检查 |
| 本地定向 | `node tests/files-terminal-ui.cjs` | **95 checks** |
| 本地定向 | `node tests/file-links-ui.cjs` | **51 checks** |
| Office 定向 | `node tests/file-preview-office.cjs` | **90/90** |
| 媒体/ZIP 定向 | `node tests/file-preview-media-archive.cjs` | **44/44**，零跳过 |
| 产物构建 | `npm run build:app -- --rebuild`，使用已有离线 Electron ZIP | exit 0，SEA 和 Electron 均重建；未下载运行时 |
| 桌面包后端运行 | `CHECK_PORT=18758 npm run test:app`，离线环境 | **27/27** |
| SEA 实际运行 | `CHECK_PORT=18759 npm run test:exe`，离线环境 | **57/57** |
| 静态检查 | `git diff --check`；三个新增/修改 runner 的 `node --check` | exit 0 |
| 本地完整 canonical | `npm test` | **未运行，遵照用户要求**；当前 PR 完整 CI 尚待验证 |

53 = 48 项状态矩阵 + 3 项启动/隔离边界 + 1 项无 renderer crash + 1 项父进程清理。它不是此前完整桌面专项 79 项的降计数或替代；`--selection-only` 明确仅运行本轮状态回归。随后默认完整桌面专项实际通过 **127/127 = 原有 79 项 + 新增 48 项**（renderer 报告 126 项，加父进程清理 1 项）。无断言被删除或放宽。

处置 Nit 后最新 **143/143 = 原有 79 项 + 48 项白框/焦点矩阵 + 16 项替代选中标记断言**（renderer 报告 142 项，加父进程清理 1 项）。完整桌面运行耗时 32,179ms，观察进程身份 11、残留 0，rendererGone 0、blockedNonLoopback 0；此前 127/127 为 32,988ms、观察 12 个进程身份。两次完整运行诊断均另记录 **2 条 `other-error` console error**，未保留原始消息，尚未归因；因此不将断言通过写成「零控制台错误」。本轮独立选中态专项的 consoleErrors 0 与完整格式场景的该诊断分开记录。

### 失败历史

1. 初次编写状态回归，ZIP 选择器误选了首个中文目录，随后又遗漏真实目录 title 的尾随 `/`，两次分别在前 8 项矩阵后终止，各为 9 通过 / 4 失败。未将这两次当作完整矩阵证据；修正测试定位为真实 `title="a/"` 后再取得完整修前 **32/20**。
2. 产品四处内阴影删除后，同一状态断言源码和重建资源均 **53/53**。产品修复未通过删断言或扩大超时取得通过。
3. 构建保留既有 `The signature seems corrupted!` 警告，注入成功；本轮没有签名或发布。
4. 此前一次完整 desktop 在 PDF 搜索输入处失败。本轮完整桌面与打包正式 main 场景均通过 PDF 字面搜索、缩放和末页导航，但未定位旧失败根因，不能把本次通过当作旧偶发输入问题已经修复。

### 宽度、主题与对比度

四组实际 CSS 视口为 **1320×820**、**700×600** 各自深/浅色，DPR **1.5**。包含中文树项、中文/英文文件与工作表名称、中文/英文 Markdown。鼠标选中、失焦、Tab/Shift+Tab 与方向键均实际执行。检查对象为选中态；未改变的禁用、Loading、Empty、Error 和 Success 语义不由本轮窄专项重新宣称全覆盖。

对比度以实际渲染颜色经 canvas 合成祖先透明背景后按相对亮度计算，以下为对应运行值（比值四舍五入）：

| 视口/主题 | 文件树选中文字 | 文件标签选中文字 | 文件树键盘焦点 | 文件标签键盘焦点 |
| --- | ---: | ---: | ---: | ---: |
| 1320 深色 | 11.90:1 | 11.90:1 | 16.10:1 | 11.90:1 |
| 1320 浅色 | 13.81:1 | 13.94:1 | 16.22:1 | 13.94:1 |
| 700 深色 | 11.90:1 | 11.90:1 | 16.10:1 | 11.90:1 |
| 700 浅色 | 13.81:1 | 13.94:1 | 16.22:1 | 13.94:1 |

选中项同时使用字重与 ARIA 状态，不仅依赖背景颜色。ZIP/工作表的指针选中无阴影且正文对比度 ≥4.5:1；键盘焦点对比度 ≥3:1。实测明细保留在 TEMP `results.json`，未整份归档。

### 截图及证据边界

四组修复后截图均已实际打开查看。最小长期证据：

- [修复前：700 深色](unified-file-viewer-evidence/selection-state/before-700-dark.png)
- [修复后：700 深色](unified-file-viewer-evidence/selection-state/after-700-dark.png)
- [修复后：1320 浅色](unified-file-viewer-evidence/selection-state/after-1320-light.png)
- [键盘导航仍有焦点指示：700 深色](unified-file-viewer-evidence/selection-state/keyboard-700-dark.png)

完整但不入库的短期证据：

- 修前：`%TEMP%/pi-preview-desktop-fqjedn/evidence`
- 源码：`%TEMP%/pi-preview-desktop-TKkWlw/evidence`
- 重建资源选中态专项：`%TEMP%/pi-preview-desktop-Ec56LM/evidence`
- 重建资源完整桌面专项，初次 127/127：`%TEMP%/pi-preview-desktop-KbSuDm/evidence`
- 处置独立复核 Nit 后，143/143：`%TEMP%/pi-preview-desktop-wCBZnT/evidence`；四组 Files 截图已实际打开查看
- 当前产物打包资源与正式 main 专项：`%TEMP%/pi-preview-packaged-rpVNc3/evidence`

选中态 53/53 和完整桌面 127/127、143/143 使用**测试自有 BrowserWindow main + 生产 renderer/CSS/preload/backend**，built 运行从重建 `resources/app` 加载。随后在当前产物上重新运行的打包专项 76/76，通过 **TEMP 副本的 manifest 观察 bootstrap 加载原正式 main**，正式桌面模块及 public 字节保持不变；其中 67 项为实际交互断言，另 9 项为父 runner 的资源/进程检查。该专项不含新增 48 项选中态矩阵，不能代替前者。两者都不是未经观察 bootstrap 的原样 manifest 启动、安装或升级证明，不沿用旧代码状态的通过结论。

## 产物身份

四份修改的 CSS 均逐字节比较源码、`build/electron-app/public` 和 `dist-app/.../resources/app/public`，全部相同：

| 相对 `public/` 的文件 | bytes | SHA-256 |
| --- | ---: | --- |
| `file-links.css` | 7653 | `cc72afe99bf6ed57a7de41f48462db7728734a15b5c35e7049a4330d45290691` |
| `ui4-pane.css` | 41013 | `9ab674af0df9ecc261f453dcf7e4d30b889158d9556da059a46ae7d13837ca21` |
| `file-preview/office.css` | 5247 | `191bf2cbbb685eaa7556d6c94681a3738f96bbe02d812623b774b859836658cb` |
| `file-preview/media-archive.css` | 3919 | `36efc1981b1396fd2de63227db0181202107f3bc2bf9f62174f7bcccd7316e97` |

- SEA `build/Pi GUI.exe`：118,950,400 bytes，SHA-256 `66d73fb7ba0ae7ddd59f0746baecd5cf72e8028d3a08bdb00ca5ebe8ae51a08d`。
- Electron 入口：246,324,736 bytes，SHA-256 `71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f`。入口壳未改变，**不能单用入口 digest 代表随包 CSS**。
- 随包 backend SHA-256 `35a0a4618080194001463d2c3fc4ba6e4d9e418ab1137f36e38bef35ac6905e5`。
- 当前 663 项 public 文件身份清单的 SHA-256：`58c81bf1e2394a37088934ed9a140ea4eae7863ef57ecb5ab3ebe4a12124c30f`。由本轮打包专项重新计算；不是此前样式状态的 digest。

## 独立复核及处置

独立只读复核已完成，范围为四处选中样式、专项 fixture 与 runner 接线；结论为**有条件通过，Blocker 0 / Important 0 / Nit 2 / Pre-existing 0**。审查者检查既有证据，未自己启动桌面或执行完整 canonical。该结论不覆盖统一预览全阶段。

| 编号 | 已验证问题 | 作者处置及验证 |
| --- | --- | --- |
| N1 · Nit | 交互抛错时，正常尾部的状态恢复被跳过，后续场景可能级联失败 | **已修复**：恢复改为 `finally`，条件性关闭标签和还原最大化，正向等待深色/非最大化基线；恢复本身失败则抛出 `selection-restore`，不继续依赖初态的场景。新增内存注入在旧实现中实际失败：残留 `[700,600,light,true,4]`，而非 `[1320,820,dark,false,0]`；新实现验证正常、交互失败和恢复失败三条路径 |
| N2 · Nit | 只断言无白框，没有正向锁住替代选中标记 | **已修复**：四类控件、四组视口/主题新增 16 项断言，检查标签实际字重等于共享 semibold Token，且 ARIA 选中状态为 true；Files 另覆盖失焦后的持续标记。缺字重或缺 ARIA 的内存负例均被拒绝；实际重建资源完整桌面为 **143/143** |

控制流/断言注入放在 `tests/fixtures/file-preview-selection-checks.cjs`，由既有 `test:file-preview:panel` 自动执行，55 → **62 checks**。这些内存探针只证明测试恢复和判据，不冒充产品渲染证据。作者对 Nit 作小范围修复，未再次委派独立复核；原审查结论与修后作者验证分开记录。

当时处置 Nit 只修改测试及本记录，未再修改 `public/`、`server/` 或产物，因此该时点无需重复构建。上述 663 项资源及 76/76 仅证明当时白框专项的产品状态，**不覆盖后续 I1–I3、PDF 锚点和 HTML/CSP 修改**；新资源身份与重新构建/运行证据见[第二阶段验收材料](unified-file-viewer-acceptance.md)。

## 限制与回滚
- 全阶段既有 Important I1（普通附件撤销）、I2（ZIP CSV/TSV）、I3（真实阅读状态投影）尚未在本轮修复；此前 PDF 搜索输入失败的根因及本轮完整桌面 2 条 `other-error` 诊断也未在此专项处置。
- PPTX 上游许可冲突未解决。构建成功与本地测试不构成公开再分发批准。
- 未验证强制颜色模式、其他 OS、多屏 DPI、长时稳定性、真实 Pi/模型、安装升级或完整 canonical。
- 回滚仅恢复四处选中样式及本轮新增状态 fixture/runner接入，再执行离线重建；当前未提交，**不可用全工作区 restore 覆盖其他第二阶段改动**。未改用户数据，无数据迁移需要撤销。
- 状态：本轮白线修复已实现，独立复核未发现阻断项；两项测试 Nit 已由作者修复并定向验证，未二次独立复审。**第二阶段整体代码验收仍未通过**。未提交、未推送、未合并、未发版。
