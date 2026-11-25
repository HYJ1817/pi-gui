# PDF 标准字体许可核验（L1）

> 状态：核验已执行，结论为**解除发布的字体许可阻断**（见末节「结论」），
> 合规材料的落实动作列在「必须随分发履行的义务」。本文件是核验证据链，
> 不是法律意见；如分发形态变化（例如改用其它字体、修改字体文件）必须重核。

## 一、对象与精确身份

`pdfjs-dist@6.3.289` 随包的四个 TrueType 字体，经 vendor 同步进入
`public/vendor/file-preview/pdf/standard_fonts/` 并打进分发产物：

| 文件 | 字节 SHA-256（前 32 位） |
| --- | --- |
| LiberationSans-Regular.ttf | `f8ace1f892b2bd9dc1792ba7f097fa75` |
| LiberationSans-Bold.ttf | `361c61b82d575c5c35fd9157fda8b019` |
| LiberationSans-Italic.ttf | `832b4406dbef23628800d3aaad210485` |
| LiberationSans-BoldItalic.ttf | `a224075ac17495ad0a3af3bc0a419ac0` |

字体 `name` 表实测（直接解析 TTF 二进制，platform 3 / UTF-16BE）：

- Copyright: `Copyright (c) 2007 Red Hat, Inc. All rights reserved. LIBERATION is a trademark of Red Hat, Inc.`
- Version string: **`Version 1.07.4`**（四个字一致）
- Unique font identifier: `Ascender - Liberation Sans […]`
- License description: `Licensed under the Liberation Fonts license, see https://fedoraproject.org/wiki/Licensing/LiberationFontLicense`

## 二、上游来源与版本-许可对应（不依赖字体名推断）

1. pdf.js 上游在 `mozilla/pdf.js#21746`（bug）与 `#21750`（fix PR，
   2026-08-10 合并，merge commit `deefadb61cedc5b71230739e7b6d30c81b24fc91`）
   核实：**这些文件是未修改的 Liberation Sans 1.07.4 上游发布件**，
   glyph count、cmap 覆盖与 advance widths 与上游 1.07.4 构建完全一致。
2. 上游修复后的 `external/standard_fonts/README.md` 明确：1.07.4 适用
   **GPLv2 + Liberation 字体例外**；Liberation 2.0 起才是 SIL OFL 1.1。
   即「不能把新版字号的 OFL 套到这份 1.07.4 上」——本核验也未这么做。
3. 本仓库随附的 `LICENSE_LIBERATION`（vendor 与 licenses 档案内）与上游
   修复后的 `LICENSE_LIBERATION` 文本逐字一致——它是 1.07.4 发布件里的
   `License.txt` + `COPYING` 合并体，包含 GPLv2 全文与两条字体例外。
4. Red Hat 上游 1.07.x 时代源码形态：TTF 由 Ascender 交付的成品字体，
   无公开的「字体源工程」（FontForge 工程源码是 2.x 重写后才有的事）。
   1.07.4 的「corresponding source」即这些 TTF 文件本身——它们是
   该版本**唯一的发布形态也是修改所用的首选形态**（二进制字体编辑器直接编辑 TTF）。

## 三、义务分析：Pi-GUI 的两种分发形态

GPLv2 §3：以目标码/可执行形式分发时，须 (a) 随附完整对应源码，或
(b) 附三年有效的书面提供源码要约。字体例外 (a) 只豁免**嵌入字体的文档**
不被 GPL 覆盖；例外 (b) 针对**物理产品**中嵌入的对象码（嵌入式设备场景），
与桌面软件分发基本无关。

**关键事实：TTF 既是 object code 也是 source。**
对 1.07.4 这种「无独立源工程、以 TTF 为唯一发布形态」的字体，
逐字节分发未修改的 TTF 同时满足了「分发 object code」与「提供对应源码」——
因为对应源码就是这同一份字节。这与「编译型程序 target 码与源分离」不同，
也是字体分发在 GPL 文本下的一般理解（FSF 对字体的立场：字体的源代码
即字体文件本身的可编辑形式）。我们分发的是**未修改**字节（SHA-256 与
npm 包内一致，npm 包与上游 1.07.4 一致——见上），因此：

- 没有修改 → 不触发 GPLv2 §2 的修改标注/整体许可义务；
- 字体是**独立可分离的作品**，与 Pi-GUI 主体在存储介质上「mere
  aggregation」（GPLv2 §2 末段），不让 Pi-GUI 整体落入 GPL；
- 随附材料已包含 GPLv2 全文与版权/无担保声明（LICENSE_LIBERATION 已在
  `public/vendor/file-preview/licenses/pdfjs-dist%406.3.289/standard_fonts/`
  与字体同目录 `pdf/standard_fonts/` 各存一份），满足 GPLv2 §1 的
  「随副本 conspicuously 发布版权通知与许可文本」。

**渲染使用不产生额外义务**：pdf.js 把字体注册为文档 FontFace 用于
画布渲染，生成的位图是「文档使用字体」的产物，例外 (a) 明确此类产物
不被 GPL 覆盖；且运行时截图/位图本来就不含字体程序本身。

## 四、必须随分发履行的义务（合规清单）

1. **不得修改这四个 TTF 的任何字节**（修改会触发 §2 与商标条款：
   修改版不得使用 LIBERATION 商标且须改文件名）。vendor 同步按字节复制，
   `provenance.json` 钉住摘要，sync 测试锁定——已满足。
2. 分发物必须继续同时携带：字体同目录的 `LICENSE_LIBERATION` 与
   licenses 档案内的同名单元——已满足（双份均在打包白名单内）。
3. 不得声称这些字体适用 Apache-2.0（包顶层许可不覆盖它们）——
   `provenance.json` 的 `fontLicenseReview` 曾标注
   `sourceDistributionVerified=false`；本核验完成后该字段应随生成器更新
   （见 sync-preview-vendor.mjs 的 legalReviewRequired 逻辑调整）。
4. 若未来升级/替换字体：Liberation 2.x 是 OFL-1.1（义务更轻，但须连带
   更新 pdf.js 宽度表，见第五节）；其它替代字体须重新核验。

## 五、评估过的替代方案（及未采纳原因）

| 方案 | 结论 |
| --- | --- |
| 升级到 Liberation 2.x（OFL-1.1） | **不可行**：pdf.js 的 `liberationsans_widths` 与 per-glyph scale factors 是按 1.07.4 的 glyph order 烘焙进 `src/core/` 的（上游 README 明示「换字体必须重新生成这些表」）。在 pdfjs-dist 预编译产物上替换字体会破坏宽度/排版正确性，且属于修改上游内部状态，超出「不 fork 上游」的边界。 |
| 删除四字并 `useSystemFonts: true` | 不可行：Linux/精简 Windows 环境无度量兼容字体，PDF 无嵌入字体时排版错乱；属于降低产品正确性来规避许可，而许可本身可合规，无必要。 |
| 换 GNU FreeFont / 其它 metric-compatible | 同样受宽度表烘焙耦合约束，且 FreeFont 本身是 GPLv3+字体例外，义务不更轻。 |
| 维持现状 + 完整合规材料 | **采纳**：字体为未修改上游件、许可文本齐、义务清晰可履行。 |

## 六、结论

- 许可身份：GPLv2 + Liberation 字体例外，适用于 **Liberation Sans 1.07.4**
  四个未修改 TTF，证据链为「字体 name 表版本串 → 上游 #21746/#21750 核实
  → LICENSE_LIBERATION 文本逐字一致」。
- Pi-GUI 的源码与二进制分发在「随附许可文本、不修改字节、mere
  aggregation」三点落实后**满足该许可的全部义务**；不存在需要额外提供
  的「缺失源码」——1.07.4 的对应源码就是 TTF 本身，已逐字节随附。
- 据此**解除 L1 发布阻断**；`legalReviewRequired` 生成器警告相应更新为
  已核验状态（保留 provenance 与义务清单，不删除证据）。
- 残留边界：本核验覆盖当前四个字节级身份与当前分发形态；任何字体文件
  变动、pdf.js 大版本升级或分发形态变化（如嵌入式设备预装）须重核。
