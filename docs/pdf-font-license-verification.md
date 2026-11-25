# PDF 标准字体许可与对应源码核验（L1）

> **状态：正式发布仍被阻断。** 2026-11-26 重核撤回旧版「1.07.4 无独立源工程、TTF 即完整源码、解除发布阻断」结论。
> 已找到完整历史源码包及独立 TTF 发布包，但**尚未证明它们与 PDF.js 随包字体的准确对应关系**。
> 本文记录可复核的工程事实与分发门槛，不是法律意见；缓存可用、测试通过或附带许可文本都不是合规批准。

## 1. 当前分发字体的精确身份

对象为 `pdfjs-dist@6.3.289`，tag 指向 commit
`1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56`。npm lock integrity：

```text
sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw==
```

直接只读解析 TTF `name` 表，四个字体均为 `Version 1.07.4`；copyright 为
`Copyright (c) 2007 Red Hat, Inc. All rights reserved. LIBERATION is a trademark of Red Hat, Inc.`；
name 13/14 指向 Liberation Font License。**这些元数据不足以证明文件与某次发布字节相同。**

| 当前 PDF.js 文件 | 字节数 | 完整 SHA256 |
| --- | ---: | --- |
| LiberationSans-Regular.ttf | 139512 | `f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f` |
| LiberationSans-Bold.ttf | 137052 | `361c61b82d575c5c35fd9157fda8b0194bcfcd0d88ea8521a4fb5dd53d33dddc` |
| LiberationSans-Italic.ttf | 162036 | `832b4406dbef23628800d3aaad21048534ac84d7e3ad955be83b8172ed8ef512` |
| LiberationSans-BoldItalic.ttf | 135124 | `a224075ac17495ad0a3af3bc0a419ac0704a8b3fd1095456201fb9b095fc281d` |

PDF.js 上游 [PR #21750](https://github.com/mozilla/pdf.js/pull/21750) 于 2026-08-10 合并，
commit `deefadb61cedc5b71230739e7b6d30c81b24fc91`；其声明四个字体是未修改的 1.07.4，
并将错误的 OFL 文本改为 GPLv2 + Liberation exceptions。
[本版本 README](https://github.com/mozilla/pdf.js/blob/1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56/external/standard_fonts/README.md)
同时说明 glyph order 已烘焙进 widths/factors 表。
**本次实测与其「未修改、glyph count 完全一致」声明不符，不能照抄该声明为本项目结论。**

## 2. 真实历史源码、构建方法与许可

历史项目入口：[liberationfonts/liberation-1.7-fonts](https://github.com/liberationfonts/liberation-1.7-fonts)。
该仓库的默认分支名是 `liberation-fonts-1_07_3`，不能将默认分支自动当成 1.07.4 发布源码。
本次读取的是 Debian 保存的原始上游归档，不包含 Debian 下游补丁：
[1:1.07.4-9 源码索引](https://sources.debian.org/src/fonts-liberation/1:1.07.4-9/)。

| 原始归档（本地保留原始字节，不重打包） | 字节数 | 完整 SHA256 |
| --- | ---: | --- |
| liberation-fonts-1.07.4.tar.gz | 2937949 | `ad98b7498dc2992f7f0868f79b65ce4a720a3acdb63ab3f1f1cb6881117a5406` |
| liberation-fonts-ttf-1.07.4.tar.gz | 1333593 | `61a7e2b6742a43c73e8762cdfeaf6dfcf9abdd2cfa0b099a9854d69bc4cfee5c` |

获取地址（保存在生成的 `identity.json` / `SOURCE-INFO.txt`，并由独立脚本锁定）：

- 源码：[Debian archive 的 upstream orig](https://archive.debian.org/debian/pool/main/f/fonts-liberation/fonts-liberation_1.07.4.orig.tar.gz)。
  [Debian .dsc](https://archive.debian.org/debian/pool/main/f/fonts-liberation/fonts-liberation_1.07.4-9.dsc)
  的 `Checksums-Sha256` 与上述字节数/SHA256 一致；本次未执行 OpenPGP 签名验证，不声称已验证签名。
- 二进制：[LibreOffice 官方源码缓存保存的历史 TTF 归档](https://dev-www.libreoffice.org/src/134d8262145fc793c6af494dcace3e71-liberation-fonts-ttf-1.07.4.tar.gz)。

源码归档含 **16 个 `.sfd`**（Sans、Serif、Mono、SansNarrow 各四种）、`Makefile`、
`scripts/fontexport.pe`、`scripts/sfd2ttf.pe`、`scripts/ttf2sfd.pe`、`README`、`AUTHORS`、
`License.txt`、`COPYING`、`ChangeLog`、`TODO`。README 明确要求 FontForge 并写有源码构建方法；
Makefile 的 `VER = 1.07.4`、`dist-sfd` 与 `dist-ttf` 分别生成源码包和 TTF 包。
默认 `ttf-dir` 使用 `fontforge -script scripts/fontexport.pe -ttf ...`；该脚本
`Open` SFD 后以 `Generate(..., "", 0x800)` 导出。这里只静态读取，**没有运行这些上游脚本**。

四份 Sans SFD 均带 `Version: 1.07.4`，对应摘要如下：

| SFD | 完整 SHA256 |
| --- | --- |
| src/LiberationSans-Regular.sfd | `27b216a54fb8f46b902f69c4310ac8d4de28bc1b2fb794bc3e7cd93da2492320` |
| src/LiberationSans-Bold.sfd | `433c768b831c1e34d4e0292dc2fd069cb8a2636ca3ca4ffe47681a32f7fdc2c6` |
| src/LiberationSans-Italic.sfd | `ad9034d03d1c1c4e764b7e131891486e31a6c2d6590a3021e8cfa6f967995231` |
| src/LiberationSans-BoldItalic.sfd | `3d547dc11bd35cfc8a59f79911844e3538393e2d169820eeae68fa631498a749` |

其它关键文件 SHA256：

```text
Makefile              78f5441712f066d30a9bd525515cd40f0e956616133b89763c3a4156dc5e6af6
scripts/fontexport.pe  cc3d3bf735b45aa5f1fdd983de140a7d54c4508281b19fc589afb5d9446f7ad5
scripts/sfd2ttf.pe     cad5e8e6ef87a3a80271ede667f07d901aa23cc760ea30a8b8dc46712aac9aaf
scripts/ttf2sfd.pe     ac63c7445ea7e9a0f8312ed4f027e71a31af021380beb07829567053dc65b731
License.txt           c40dd6adebad817defd68c7edad151d9c13d2ac3b4e1790ce2b727b024438b6d
COPYING               ab15fd526bd8dd18a9e77ebc139656bf4d33e97fc7238cd11bf60e2b9b8666c6
AUTHORS               0f056151c210fa1acc8dd8cf1ae3febbba19339322dcd9154c01a5991c001d28
```

原始 `License.txt` 明确为 **GPLv2 + Liberation 字体例外**，包含文档嵌入例外、物理产品条款、
商标/修改限制及无担保声明，copyright 为 `© 2007-2011 Red Hat, Inc.`。
`COPYING` 是 GPLv2 全文；`AUTHORS` 保留 Ascender / Red Hat / Oracle 等贡献者信息。
不能把 Liberation 2.x 的 OFL 或 PDF.js 包级 Apache-2.0 覆盖到这些 1.07.4 字体上。

## 3. 当前不能闭合的对应关系

| 历史 TTF 归档文件 | 字节数 | 完整 SHA256 | glyph count：PDF.js / 历史包 |
| --- | ---: | --- | ---: |
| LiberationSans-Regular.ttf | 139764 | `fc977b8f8a736c45ee4126383d0b8a929af7d4f4a9c4a1c974ed5a32387db822` | 681 / 682 |
| LiberationSans-Bold.ttf | 137372 | `32f8698422f13692f85b57b32b72d726e0aae3190a7cef0b5c10a8e36ef82845` | 681 / 682 |
| LiberationSans-Italic.ttf | 164264 | `36c6d220d11c157f499c0371f2b2aa29a4ef2aa868b6b93564d8d460ae2ffad3` | 681 / 687 |
| LiberationSans-BoldItalic.ttf | 137420 | `cba635aca7f71a00faffe7e89a2301fbb1bb9739b4ac44329ccaf90d622b5fe3` | 681 / 687 |

直接从各 TTF 的 sfnt 目录定位 `maxp` 表，读取其 offset + 4 处的大端 uint16 得到上表。
四文件的 `name` 表内容一致，但 `glyf`、`post`、`GSUB`、`hmtx` 等表不同；Italic / BoldItalic
连 `cmap` 长度也分别为 PDF.js 1778 / 历史包 2998 字节。差异**不只是头部时间戳**。

尚未确定差异来自哪次历史构建、源文件变更、构建工具差别或其它转换；本次不重建字体，
也不把这些可能性当成事实。已知 1.07.4 SFD 包可以完整归档，但它是否是当前四 TTF 的完整对应源码、
是否还需要特定修改及其脚本/构建输入，仍为 **unresolved**。不从“没找到”推断“不存在”。

## 4. 分发机制与发布门槛

依 [GPLv2 §3 原文](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html#section3)，
不能仅以“能编辑 TTF”或“已经带许可”替代完整对应源码核验。本项目选择**随二进制附带完整对应源码**，
不以缓存、上游链接或未经落实的三年书面要约替代。这里不判定 Pi-GUI 主体的派生作品/聚合边界。

实现复用原 vendor staged 输出与 SEA/App `public/` 收集链，不添加运行依赖或第四个 Release 附件：

1. `scripts/preview-font-source.mjs` 锁定 npm 身份、PDF.js 浏览器主文件/worker、许可及四字体的完整 SHA256。
   普通 `postinstall`、vendor 同步和测试**不下载、不执行上游脚本**；PDF.js 版本/integrity、字体清单、
   字体或许可字节变化，生产 materializer 立即失败，保留旧 vendor，不靠测试前缀锁或人工记忆重设阻断。
2. 原始归档保存在 Git 外的内容寻址缓存：
   `~/.cache/pi-gui/third-party/<sha256>/<原始归档名>`；可显式设置 `PI_GUI_THIRD_PARTY_CACHE`。
   每项下载先进入新的空 OS TEMP 目录，限时限长、HTTPS 固定 URL、拒绝重定向，验证大小和 SHA256 后才入缓存；
   导入同样校验，拒绝链接/目录/损坏文件且不覆盖已有缓存。tar 仅在内存读取已钉住内容，不落地解包、不执行脚本。
3. 显式准备命令（维护操作，不在普通测试中联网）：

   ```text
   node scripts/preview-font-source.mjs --download
   # 或离线导入先前保存的两个原始归档：
   node scripts/preview-font-source.mjs --source <源码归档绝对路径> --binary <TTF归档绝对路径>
   ```

4. vendor 生成目录 `public/vendor/file-preview/licenses/pdfjs-dist%406.3.289/liberation-source/`
   随包携带两个**原始归档**、`upstream/{License.txt,COPYING,AUTHORS,README}` 原始字节、
   `identity.json`、`SOURCE-INFO.txt`（版权、许可位置、获取 URL、完整 SHA256、未决状态）。
   全部进入既有 `versions.json` 文件清单/摘要和包 provenance 的 `legalFiles`；完整上游源码不进 Git 或业务源码目录。
   原来的两份 `LICENSE_LIBERATION` 仍保留。App 既有根目录 `THIRD-PARTY-NOTICES.txt` 追加完整字体许可、
   版权与生成的源码获取/未决说明，明确包级 Apache-2.0 不覆盖字体；旧 vendor 缺失说明时拒绝静默省略。
   SEA 中同一法务目录随 public assets 可由既有静态路由读取（tar.gz 使用默认 octet-stream），不新增 HTTP API。
5. 缓存缺失不破坏离线开发安装：仍产生含获取说明的 vendor，`legalReviewRequired` 明确记录缺失与未决，
   `sourceDistributionVerified=false`。缓存齐全时虽附上完整已知上游归档，也**仍为 false**，只去掉“缺失”这一条。
6. `release-check.mjs` 和正式 `publish-release.mjs` CLI 在任何构建/安装或 GitHub 操作前检查不可由
   `--skip-tests`、`--skip-build`、环境变量或生成 manifest 的成功布尔值覆盖的未决门槛。
   预检还接入 App 实际 vendor 的归档/法务文件验证；正式 workflow 显式准备缓存。
   不能只把 `correspondence` / `sourceDistributionVerified` 改成 true 解禁：须补齐差异来源、准确源码及构建输入证据，
   更新身份锁/测试，完成独立功能与安全复审及维护者明确发布决策。

现有 SEA `build-exe.mjs` 递归收集 public、App `build-app.mjs` 递归复制 public，因而具备携带上述目录的路径；
**实际新 SEA/App 产物的字节验收仍由父任务统一重建并执行，不能用源码或 VM hook 测试冒充已验证产物。**
普通源码 vendor 缺少缓存时的产物不可作为满足对应源码义务的正式分发。

## 5. 本次定向验证与残余边界

- 基线 `cba8398260a7272eca14a3a57d027dc3634f3ca1`：vendor 31/31；发布 fixture 77/77。
- 新测试仍在既有 `tests/file-preview-vendor.cjs`，不修改共享 package.json 或 packaged 套件。
  覆盖离线缺失、损坏/失败导入下载不入缓存、缓存 junction、tar 路径/链接/重复/截断、PDF.js/字体漂移、
  保留旧 vendor、伪造 manifest 成功字段、正式预检/发布 CLI 的 fail-closed，以及原打包钩子。
- 本机 Node v24.22.1 / Windows 定向实测：默认空缓存 `node tests/file-preview-vendor.cjs` **39/39**；
  显式 `PI_GUI_FONT_SOURCE_TEST_CACHE` 指向已核验缓存运行同一套件 **40/40**（额外一项实际原始归档正向验证，
  不把未执行的正向验证计入默认分母）；`node tests/release-artifacts.cjs` **77/77**；
  `node tests/ci-workflow.cjs` **5/5 + 15/15**；`npm run version:check` 通过。
  原 31 项 vendor 检查保留，纠正两项错误的许可成功断言并增加八项默认检查及一项显式缓存检查，没有删除安全检查。
  App notices 使用 VM 执行真实 build-app 写入片段，输出只在 TEMP；该 fixture 不执行 Electron 打包，也不冒充最终产物验收。
- 首次新增 tar 截断 fixture 因在截断处补零而意外构成有效 tar，导致“预期拒绝”断言失败；修正 fixture（不补零）后上述两种模式均通过。
- 两个原始归档经新脚本 `--download --cache-dir <全新 OS TEMP 缓存>` 的真实下载验证通过，均与锁定大小/SHA256 一致；
  这项维护验证显式联网，与默认离线 fixture 区分。实际原始归档正向测试只读外部缓存、只写 TEMP。
- 缓存维护是本机受信维护者操作，不是接收不可信 HTTP 路径的产品 API；目录创建前后检查链接，但不声称抵御同一用户持续并发替换所有祖先目录的攻击。
- 按本子任务授权不跑完整 `npm test`；正式重建物由父任务完成并验证（SEA 与 App 均携带两原始归档，
  字节与源一致），完整 canonical 交由最终提交的 PR CI。
- **独立复审已完成（2026-11-26，星驰 gpt-6.1-sol，effort max）：通过，Blocker 0 / Important 0 / Nit 1。**
  复审独立复算两归档、四字体、16 SFD、glyph 数，并注入伪造成功字段、清空警告、成功环境变量与
  `--skip-tests --skip-build`：门槛均拒绝，前置注入计数为网络 0 / 子进程 0 / 文件写入 0。
  唯一 Nit 是根 `THIRD-PARTY-NOTICES.txt` 复制的 SOURCE-INFO 相对定位仍指 vendor 内部；
  已由 `fontDistributionNotice()` 明确写出实际 vendor 路径，并新增断言锁定（vendor 39/39）。
- 基线 SHA 的 CI 未触发原因已查清：推送落在 GitHub 官方事故窗口，PR head 同步未完成；
  与字体代码或 workflow 配置无关。最终提交推送后重新核对。
- **发布阻断 L1 保留**：源对应关系未闭合；人工发布审批仍未完成。
  不删除 PDF.js、不替换字体、不以系统字体或 Liberation 2.x 绕过该边界。
