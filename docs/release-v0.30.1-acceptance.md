# v0.30.1 发布验收

日期：2026-10-28（Asia/Shanghai）。用户明确要求“发一版”，发布 v0.30.1，包含已合入的 #42（Bug 8～11）和 #43（应用内更新与失败完整回滚）。

## 身份与交付

- 版本准备基线：`8ebe0ad97003955dbb30e70909d2c5d86f538821`，基线 main CI [40647270442](https://github.com/HYJ1817/pi-gui/actions/runs/40647270442) 成功。
- 准备提交：`3ac05db75547380f690898c03239f06bf054450f`；[PR #44](https://github.com/HYJ1817/pi-gui/pull/44)。只修改 `package.json`、`package-lock.json` 的根版本和 `.github/release-summary.md`，无依赖、业务、测试链、workflow 或签名策略变化。
- 正式代码及 tag 解析结果：`eac79cab793cff26c6cb6aa01cc9d9276ce06606`；注解 tag `v0.30.1` 对象 `6f2cea2d09471057c688f4eb57cd3ec72dd1cb82`。合并提交与版本准备提交的文件树一致。
- [正式 Release](https://github.com/HYJ1817/pi-gui/releases/tag/v0.30.1)：非 draft、非 prerelease；2026-10-28 19:40:19 +08:00 发布。公开 latest 响应为 v0.30.1，三个附件齐全。
- 本报告及相邻证据是发布后的文档提交，保存在版本准备分支；不改已发布 main/tag 或任何公开二进制。报告提交可用 `git log -1 --format=%H -- docs/release-v0.30.1-acceptance.md` 解析。

## 精确 CI 与验证

| 层次 | 身份、实测与边界 |
| --- | --- |
| 版本与发布定向检查 | `version:check` 成功；`test:version` 34/34；`test:release` 77/77；完整计划 231 leaves（155/24/27/4/21），未删除断言 |
| PR CI | [40675946532](https://github.com/HYJ1817/pi-gui/actions/runs/40675946532)，pull_request、attempt 1、head `3ac05db`，测试 merge SHA `2874088a4c5c7a9369c382751f5b4206e2a52ef4`；231/231、8 checks 成功 |
| 精确 main CI | [40678496026](https://github.com/HYJ1817/pi-gui/actions/runs/40678496026)，main push、attempt 1、精确 SHA `eac79ca`；231/231、8 checks 成功；完整同轮证据，无未执行或失败 leaf |
| 本地 `release:prepare` | 退出码 0，约 405 秒；App 26/26、SEA 49/49、portable 12/12、三个资产守卫及独立摘要成功。显式跳过本地全量测试和安装器执行，不冒充完整正式预检或原用户安装验收 |
| 正式发布 workflow | [40680788304](https://github.com/HYJ1817/pi-gui/actions/runs/40680788304)，tag push、attempt 1、SHA `eac79ca`；verify、publish 两个 job 均成功 |
| runner 构建与真实安装 | 正式 `release:check --tag=v0.30.1 --ci-sha=<eac79ca> --with-installer`：精确 main CI 证明后复用全量测试；App 26/26、SEA 49/49、portable 12/12、真实安装/卸载 20/20；READY TO RELEASE |
| 上传前后守卫 | 只上传 Setup、portable、SHA256SUMS 三个文件；跨 job artifact 摘要一致；创建 draft 前、公开前重新核对 tag/SHA/CI gate，上传后逐项比对 GitHub 大小与 SHA256 |
| 独立公开附件核验 | 重新下载全部三个公开资产；用 Python hashlib/zipfile 复算摘要、完整 CRC 与路径检查；运行仓库资产守卫成功；主 EXE 与安装器 ProductVersion/FileVersion 均为 0.30.1 |

“231/231”是 canonical 命令 leaf 数，不是内层断言总数；结构化证据的 leaf skipped 为 0，不据此声称所有平台权限相关断言均执行。

## 公开资产

| 附件 | 字节数 | SHA256 |
| --- | ---: | --- |
| `Pi-GUI-Setup-0.30.1.exe` | 105592104 | `4f38ea954d51c84b61b3170feb3c9c132aa7474429a090465554949409284807` |
| `Pi-GUI-0.30.1-portable.zip` | 149173229 | `53c2c61bfab8968a311602f405e110edf048e53b7419fb23afdf9716f1f4f0a0` |
| `SHA256SUMS.txt` | 183 | `36b25bc589da38b472e0ba83b05ed230f2fccbb65c27f00f196b1cca37ab6645` |

三个下载文件分别与公开 GitHub API digest/size 一致；校验和清单恰好覆盖两个二进制。正式 runner 使用固定核验版本 NSIS；本地预备产物不是这些公开字节，未用本地摘要替代公开摘要。

便携 ZIP 有 406 个条目，CRC、路径检查成功；生产入口 `resources/app/main.cjs`，package 版本 0.30.1，无测试 entry 或 installed-target 夹具。包内更新助手与正式 tag 源码逐字节一致，SHA256 为 `8d8d2953ca580c1d6042b2a08900a25903f1f22b4b95e15acebe052479ed09c4`。

用未修改的 v0.30.0 更新检查模块处理实际公开 latest JSON，确认发现 0.30.1，且 installer、portable、checksums 三类入口齐全。网络传输用 gh 采集真实响应后注入；这只证明旧检查器对真实发布响应的发现/分类，不冒充旧安装版的 UI 点击或原位置升级。

## 失败记录、限制与数据边界

- 正式 PR CI、main CI、Release workflow 都在 attempt 1 成功，无自动重跑、门槛下调或发布覆盖。
- 独立 ZIP 校验脚本首次误将 EXE 假定在归档顶层，入口定位断言失败；实际根目录是 `Pi GUI-win32-x64/`。改为从真实 package 路径确定归档根后通过，未修改或重发资产。此前摘要、CRC、助手核对已通过。
- 安装器 Authenticode 实测 `NotSigned`，沿用仓库既有未接入签名状态；未关闭、绕过或替换任何已有签名验证。不得称本版已签名。
- 真实安装/卸载在一次性 Windows runner 中执行；本机没有运行正式安装器，没有写入用户真实安装、会话或项目。不能据此宣称用户原位置升级、签名生产包升级、断电恢复、原生确认人工点击已经验收。更新功能的 TEMP 正常沙箱安装与失败恢复证据另见 [定向补修验收](in-app-update-20261028-rollback-acceptance.md)。
- 旧版若只显示下载入口而没有“重启以更新”，需先手动安装本版一次；后续可确认身份的 Windows 安装版使用应用内下载/重启更新。便携版仍需退出后手动替换。Release 页面已补充该说明。

## 证据与回滚

持久证据在 [evidence/v0.30.1](evidence/v0.30.1/)：PR/main 汇总、Release run、公开附件独立验证、PE 元数据及旧版发现验证。完整 Actions 日志使用上表永久 run 链接；本地预备日志位于 `%TEMP%/pi-gui-v0301-release-audit/local-release-prepare.log`。

回滚遵循不覆盖已发布二进制的策略：若发现发布缺陷，保留当前 tag/资产证据，另做修正版或经用户决定撤回，不静默移动 tag 或替换附件。用户程序恢复异常时保留更新备份和 userData，按恢复说明人工检查/重装；不清空用户数据。

结论：版本准备、精确完整验证、已授权合并、tag、正式发布和公开资产独立核验均完成；已披露的环境/签名限制保留。文档证据提交不触发新版本发布。
