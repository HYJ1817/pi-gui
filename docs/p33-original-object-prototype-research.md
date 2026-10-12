# P33 原文件对象写入：隔离原型研究

日期：2026-10-11。用户在 P33.4a 验收“不通过”后，以“可以”批准方案 C 的**隔离研究**。这不是生产 writer 契约变更批准，也不是 P33.4 验收通过。

## 1. 基线、范围与结论

开发前 HEAD：`f47c5a6ab710aaf9f122048bf8308e1142047c67`，main。工作区仅有既存未跟踪发布目录 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`，未操作该目录。本轮不提交、不推送、不发版，不进入 P33.5。

新增实验套件 `tests/session-revert-inplace.cjs`、原生测试夹具 `tests/fixtures/session-revert-inplace-native.ps1`、研究计划和本报告；只在 `package.json` 的 npm test 末尾追加实验套件，并补充设计差异及原验收报告。没有修改 server/public/extensions，不接入 HTTP 或正式工具执行路径，不需要重建生产产物。

**实测结论：保持原文件对象能避免本机 ReplaceFileW 实验的 EA 复制丢失，但仍不能交付符合原契约的生产恢复。** 普通权限下 SACL 仍不可读；原位写入可能留下部分内容；ShareMode=0 没有排除 ADS 和 DACL 变化；写入可能改变 Archive 属性。当前只具备继续设计评审的材料，生产仍保持 `metadata_audit_unavailable` 拒绝（`server/session-revert-metadata.js:42-43`）。

## 2. 官方接口依据与设计判断

使用 [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) 的 OPEN_EXISTING 打开原对象，不在打开时截断；使用 ReadData/WriteData/ReadAttributes/Synchronize 的受限访问，不请求设置安全描述符。原句柄用于内容和文件 ID 校验，固定 root/workspace 目录句柄拒绝删除共享。实现见原生夹具 `:75-108`、`:165-174`。

随后用 [WriteFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-writefile)、[SetEndOfFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setendoffile) 和 [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers) 写入、调整长度和刷新。多次写入及长度改变不构成原子事务；flush 成功也不能证明跨日志/对象的断电原子性。实现见原生夹具 `:111-125`。

微软 [File Streams](https://learn.microsoft.com/en-us/windows/win32/fileio/file-streams) 说明共享模式按 stream 管理。故主数据流的共享限制不能当作 ADS 的冻结证明。本机独立进程 ADS 写入实验证实了该边界。安全信息也必须单独考虑，[SetNamedSecurityInfoW](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setnamedsecurityinfow) 的权限语义不能用“文件内容句柄排他”替代。

**技术推断**：不调用设置安全描述符的 API、保持同一 NTFS 对象，为 SACL 保持提供一个比复制 unknown 更值得验证的方向。**尚未证明**：非空显式/继承/受保护 SACL 的完整保持、并发安全信息变化边界、可接受的生产中断恢复契约。因此没有据此提高证据资格。

## 3. 实验执行路径与持久材料

1. Node 用 `os.tmpdir()`/`mkdtemp` 建立独立合成项目；固定相对路径 `workspace/file.txt`。原生夹具仅允许 TEMP 直属 `p33-inplace-*`、固定本地 NTFS，拒绝 reparse 和多硬链接，正文预算 2 MiB（Node `:64-77`；原生 `:12-35`、`:83-105`）。
2. 复用现有 `session-change-store` 的 restorePut/restoreRead/applyCreate/applyUpdate，持久保存 C/R、校验回读、建立 research_only 计划；没有第二套 session registry 或对象存储（Node `:83-96`；store `:342-418`）。
3. 原生持有句柄、校验当前字节与文件 ID，发出 ready 后等待。Node 持久记录 replacing 意图成功才发送 commit；原生再次校验 C 再写入（Node `:98-114`；原生 `:165-174`）。
4. 完成后独立读取实际文件，逐字节验证 R，并给 journal 写入实际 observedPostDigest。异常退出保留 C/R，重开现有 store 分类 recovery_required，不自动重试或回滚。恢复 C 的第二次实验从首次持久 currentRef 读取 C，重新备份当前 R、创建新计划并重新握手（Node `:148-157`、`:261-275`）。

实验握手用于隔离测试，不是生产确认 token/owner 协议，也不是 native helper 自己验证持久备份的可信边界。多数故障用例注入 privacyCheck fixture；第二计划闭环使用现有真实私有 ACL 验证。内容备份不等于完整 SACL/EA/ADS 元数据备份。

原生 helper 的前缀检查不是安全 capability，Node 的 fresh mkdtemp 才提供本实验的目录新鲜性。祖先 reparse 的路径检查不是全部祖先原子固定；这里只固定 root 和目标父目录，不可宣称通用安全路径解析。C/R 通过环境变量传输，受 Windows 环境块限制；虽然解码有 2 MiB 上限，尚未实现生产 2 MiB 传输覆盖。本实验只验证小型合成文本。

## 4. 真实 NTFS 字节、元数据与竞争结果

环境：Windows `10.0.26200.0`、Node `24.14.0`、固定本地 NTFS；普通令牌缺少可启用 SeSecurityPrivilege。原生 observed 返回实际 OS/文件系统信息（`:241-244`）。

| 场景 | 实测结果及证明范围 |
|---|---|
| dirty 内容、缩短、增长、空 R、UTF-8 BOM 和混合 CRLF/LF | R 与输入逐字节相同，文件 ID 相同，C 备份回读相同；Node `:121-131` |
| protected/inherited DACL | DACL、owner/group、文件 ID、非空 EA、ADS、测试属性 8226 保持；不是全属性认证；`:133-146` |
| SACL | 两组真实非空 SACL 测试跳过，auditReadable=false、sacl=null 表示 unknown。具备权限时可构造显式/继承 ACE，但受保护 SACL 场景尚缺；原生 `:213-236` |
| B/A/P→R→真实写入 | 持久合成工具证据，经现有逆三方算法产生 `user original\nanchor\nuser later\n`，保留原有及后续独立字节；`:159-177`。不是本轮真实 Pi 集成 |
| 新计划恢复备份 C | 从首次对象存储读 C，再备份 R、记录新意图、恢复 C，文件 ID 未替换；`:148-157` |
| stale C、旧 ID/新对象、取消、备份失败 | 不发送 commit，目标不变；`:179-208` |
| ready 后 journal append open/fsync 失败 | 不提交、不改 C；持久材料仍可读取，重开保守 recovery_required；`:210-231`。故障为注入 |
| hardlink、junction、readonly | 拒绝，不删除属性或修改另一个链接名；`:233-259` |
| 独立数据 reader | 原生获取 writer 失败，C 未改；`:277-285` |
| 独立父目录 rename | 原生 pin 持有期间独立进程 rename 被拒绝；不证明所有祖先竞争已排除；`:287-292` |
| 已有 writable mapping，原始数据句柄已关闭 | 本机此真实映射阻止 writer 获取；样本结果不是全面 OS 排他证明；`:294-308` |
| 独立 ADS writer | 主流 share=0 期间 ADS 成功变为 external stream D；原对象写 R 保留该 ADS。证明没有全部元数据冻结；`:310-317` |
| 独立 DACL writer | Access-only FileSecurity 在独立进程修改 DACL 成功，写 R 后外部 DACL 保留；`:319-329`。初始 Set-Acl 探针因额外审计权限失败，诊断后换成明确 DACL-only 调用，没有改变成功判据 |
| Archive 未设置 | 写前 8192，写后 8224，Archive 位新增；没有强行恢复属性。`:331-337`。因此不能说“仅改内容保证全部属性不变” |

B/A/P 内容链 C digest：`3ad36eb25216df19947a07cff6d424418e772319a10d58f48c236102aea5c0d4`；R digest：`ee3614a8f0cc0ac4f20f7d723160839af154e9cb642cc7a432ccdbe25cca56ca`。均为合成测试材料。

## 5. 崩溃边界与备份边界

真实 native 子进程在首段写入、EOF、flush 后主动退出 73。C 为 `CCCCCCCC`，R 为 `RRRR`。首段退出实际 D=`RRCCCCCC`（8 bytes，digest `244c9a8b7733da1df7e40e163de2052168e98553da964bb54d774da1cf0776bb`）；EOF/flush 后实际 D=R（4 bytes，digest `ad49738ddc9ea282f541a4d462213ce512bde2d3a9aeb89ff414a34398985d30`）。

三者重开均 recovery_required，即使 D=R 也不宣布完整成功；C/R 备份回读相同；随后用户写入新的 D，日志查询没有自动覆盖它（Node `:261-275`）。这是进程崩溃试验，不是断电或真实磁盘空间耗尽试验。数据写入期间文件可能部分更新，C 备份只包含备份时字节，之后出现的新字节并不因此有备份。日志和私有内容对象也不提供跨文件事务。

## 6. 测试结果及交付范围

变更前完整 npm test：101 套件，退出 0；既有 session-search 5i 权限环境跳过 1 项。独立实验：**28/28，失败 0，SACL 跳过 2**。最终完整 npm test：**102 个唯一套件，退出 0，无新增回归**；P33 的 13 套件合计 **384/384、失败 0、跳过 2**；全套环境跳过另包括既有 session-search 5i，共 3 项。跳过不计入分子分母。本轮只追加实验 suite，不删除旧 suite/断言，不用跳过失败取得通过。

| 分组 | 通过/失败/跳过 |
|---|---|
| P33.2 store / bridge / tools | 35/0/0；23/0/0；30/0/0 |
| P33.3 algorithm / store / HTTP / integration | 67/0/0；14/0/0；65/0/0；19/0/0 |
| P33.4 writer / recovery / admission / apply / Windows faults | 22/0/0；24/0/0；15/0/0；29/0/0；13/0/0 |
| 新原文件对象实验 | 28/0/2 |

原套件 100-operation reopen：510 ms、object privacy checks=2，只代表重放，不含 100 次采集的总耗时。可复核日志：`%TEMP%/pi-gui-p33-inplace-baseline.log`、`%TEMP%/pi-gui-p33-inplace-prototype-verified.log`、`%TEMP%/pi-gui-p33-inplace-npm-final.log`。最后者包含新增 NTFS 断言及完整测试入口；均仅包含合成测试观察，没有原始用户快照。

早期实验曾因测试 journal 缺 observedPostDigest 失败；既有 store 正确拒绝，修复的是测试夹具，生产校验不改。DACL 失败按真实权限原因定位，没有静默放宽资格。

真实 Windows：实际字节写入、EA/ADS/DACL、独立进程竞争、进程退出、持久对象重开。Fixture：B/A/P 工具分发、隐私注入的故障用例、ENOSPC/EIO 注入。**本轮未验证**：真实 Pi→新原型接入、classic/managed 原型 API、打包原型执行、真实 ENOSPC/断电、全部 Windows/NTFS 版本、完整非空 SACL，以及 native WriteFile/SetEndOfFile/FlushFileBuffers 返回失败。真实进程退出不等于这些 API 错误覆盖。生产路径没有引用该原型，保留原有元数据拒绝；源码检查范围见 Node `:339-344`，这不是通用可达性证明。

独立规范审查及只读质量审查未发现需要阻止隔离实验的实现缺陷；指出的 SACL protection、环境块传输、祖先 pin、握手可信边界及 native API 错误覆盖缺口均保留在本报告，不能以审查结果替代真实证明。

## 7. 后续取舍与未通过门槛

保留原对象解决了 EA 复制问题，却引入原位部分覆盖风险。生产采用此 profile 将改变已验收“候选替换、禁止 truncate”的契约，需要另行设计审阅和批准，不能仅凭本次隔离研究上线。应先取得具备审计权限的独立环境验证完整非空 SACL，并明确 Archive/时间属性、ADS/安全信息并发、恢复材料元数据范围及中断人工恢复的契约。

当前没有充足证据绕过 metadata_audit_unavailable，也不建议仅以相同文件 ID 或普通权限下看不见 SACL 推定保持性。**研究交付不代表 P33.4/P33.4a 验收通过，普通用户生产闭环仍阻塞。**

交付后 HEAD 仍为 f47c5a6，无新提交。工作区修改为本报告列出的 7 个研究相关文件，以及未操作的既存发布目录；`git diff --check` 通过，server/public/extensions/lib 无 diff。隔离研究可交人工审阅；生产契约和资格的下一步仍需要完整证据与单独批准。

测试自己的 fresh TEMP 项目按边界检查后清理。另有原生手工 smoke 三个纯合成目录的递归清理被自动审批审核拒绝，理由仅为 `blocked by policy`；未改用其他机制重试，材料仍保留在 `%TEMP%`：`p33-inplace-nativecheck-f74792c239f74334bd2128b66ce508da`、`p33-inplace-nativecheck-b041d6f8eb404f76bfdc26790aba07f7`、`p33-inplace-nativecheck-077956ea31bf4bb19ad9fbae8cfcb25a`。不包含用户项目数据。

## 8. 后续授权交付

2026-10-12 用户明确要求“推送”，据此将隔离测试及报告分开提交并推送。前述 HEAD 与工作区记录保留研究完成时快照；交付后的提交以本文件所在 Git HEAD 为准。此次授权不改变 SACL 未验证、生产验收未通过的结论，不授权生产接入、发版或 P33.5。既存发布目录不纳入交付。

推送前再次运行完整原型套件：28/28、失败 0、SACL 跳过 2、退出 0；日志 `%TEMP%/pi-gui-p33-inplace-push-check.log`。此次仅新增授权交付记录，测试与生产代码未再改动；不把上一次完整 npm test 表述为此次重新运行。
