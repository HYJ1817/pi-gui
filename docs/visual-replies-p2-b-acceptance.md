# P2-B 存储验收

仅操作既有 B 工作树，未推送/PR/合并/发版。风险高；开发完成，独立复审、集成 canonical、真实渲染与产物仍待验证，未授予合并/发布许可。

## 提交身份

基线：dfdc1ddea060d8c369e5e0932d052655baa3d772。父核验 CI 45952490979：push/attempt1/success，355/355 leaf，仅证明 P1。

B3 2cd34ec2 已在分支；其两文件未被 B2 修改或提交。

B2 按序集成：
1. 5b69c52ab02eeb1449e64874d5e016cc90d757a4：配额、索引与身份锁。
2. 00e2215633365cccc492ac57b29bb63bf772a758：Classic 继承 owner。
3. d009d05b29de944e7bd3d8c6f28f8cabf51d822d：维护/CLI/扫描/统计/接线。
4. 23e82c917deff7872c1831a218bbecbf8e256b65：存储专项测试。
5. 本报告仅文字；SHA 用 `git log -1 --format=%H -- docs/visual-replies-p2-b-acceptance.md` 定位。

实测覆盖同内容待提交树，之后只有提交及报告；不是新 SHA 的 CI。

## 行为与安全边界

复用 P1 不可变快照、路径/链接校验、原子发布、pending 与原生分支授权。

- 配额按实际 HTML+metadata+marker 字节核对。元数据缓存绑定文件对象、size/mtime/ctime；不缓存独立容量总数。准入不再重读历史 HTML，但实际读取、重复发布和底层收集仍验证 UTF-8/SHA256。
- 全局64MiB/4096个，每原生session16MiB/256个；不新增会话数上限，不自动淘汰历史，中断TEMP阻止新准入。
- `/api/system/storage` 保留认证，只增加数值统计白名单。未知/异常为unknown，不是假零；known不等于全部HTML完整性已验证。pending不是已证明孤儿数。
- 所有存储操作/恢复者共用物理目录身份派生的内核gate，再持wx锁。Windows用named pipe和FILETIME/映像；Linux用abstract socket和boot ID/start ticks。PID、锁龄、用户口述不构成恢复证明。门闩只协调本机合作实例，不是原生Pi锁或OS沙箱。
- 可证明死亡的v2锁可在启动/显式维护中恢复；未知、旧版、撕裂、空身份、查询失败及foreign替换均保留拒绝。没有force-unlock。启动不再自动清理TEMP证据。
- 默认plan仅给候选，保留HTML/reference/pending；已有store仍会短暂持锁，缺失store不创建。collect恒拒绝native_mutation_unproven，离线确认flag也不能授权删除。自动GC未开启，不能称GC已完成。
- CLI只可显式恢复已证明死亡的锁、清理固定未发布TEMP清单；无HTTP删除入口，父IPC在线仅stats/plan。

## 实测（Windows 11 / Node v24.22.1）

所有写盘均为os.tmpdir fixture；未用真实用户数据写入、Pi、模型或下载依赖。

| 命令 | 实际结果（exit 0） |
| --- | --- |
| `node tests/html-artifact-store.cjs` | 最终135/135场景，529 assertions，skip3；原数量全部保留 |
| `node tests/html-artifact-lock.cjs` | 14/14场景，103 assertions，skip0；通过后锁代码未改，不重复跑 |
| `node tests/html-artifact-maintenance.cjs` | 最终20/20场景，119 assertions，skip0；此前16/16/101为中间证据 |
| `node tests/html-artifact-performance.cjs` | 16/16 assertions，skip0；冷索引、缓存失效和实际读/重复发布损坏拒绝 |
| `node --test --test-name-pattern='storage metadata' tests/system-settings.cjs` | 1/1，fail/skip0，247.3093ms |
| 12个B2 JS/CJS文件 `node --check`；`git diff --check` | exit0 |

store的3个skip为Windows文件symlink权限不足，逐项单列，不计通过场景；529断言未减少。锁测试仅HANDLE强杀自己spawn的fixture，未结束无关进程。

### 首次失败与恢复

- maintenance首跑exit1：口述停机flag竟得到`ok:true, removed:1, nativeExclusionProven:false`。收口为collect恒拒绝后通过。
- lock首跑exit1：`found + identity:''`误判旧owner死亡。补结构校验、空identity、异常query守卫后通过。
- 新maintenance fixture在跑至相关场景前对照真实schema补schemaVersion，并用实际`conversations.json`测试损坏Registry；没有靠删除断言或skip改绿。
- 本线程曾被用户误关闭。恢复时只读查询相关node命令行：无遗留B2子进程；status仅本任务文件，无部分测试进程或他人文件。已通过且代码未变的检查不重复。
- B3独立报告的branches17/17/372、backend+model+branches63/63及edit回归属B3证据，本报告不冒充B2重新执行；Classic非活动readonly页仍text-only，不扩产品契约。

## 性能：同语料实际对照

命令：先`node tests/html-artifact-performance.cjs --benchmark --baseline=dfdc1dde`，再`node tests/html-artifact-performance.cjs --benchmark`。基线模块只读取自准确Git提交并在TEMP重定位依赖，不checkout/reset其他文件。每组26/26断言、skip0、exit0。

64份HTML共33,554,496B，8 sessions；每轮并发8份新HTML，每份4103B，3轮。语料/最终读取digest均为：

`c819e12edf98dc816136e65999ce2b8708f3fd9d04e25bfbf1e8c98e64aaf429`

| 实现 | 三轮ms | 中位ms | 每轮实际HTML读取B |
| --- | --- | --- | --- |
| 准确P1 dfdc1dde | 6723.485 / 6898.081 / 6823.011 | 6823.011 | 268616500 / 268879092 / 269141684 |
| B2 | 3990.662 / 3735.489 / 3337.113 | 3735.489 | 65648 / 65648 / 65648 |

B2仅为8份新HTML各两次验证，HTML read调用每轮32；P1为1112/1240/1368。基线store源码SHA256 `caa580f68e5ef1db3e0e20841919710c076cd05a4084c1f9b88feb39abc3474c`；B2为`cbccb16333dca2c21ce029e12cb2f9159b0288c618f4dae1db10ba96a2bb075f`。

默认小语料8份262152B，本次790.450ms，读取65648B；digest `29fa7412d5e31db4aa0c548abb4797ffcf488677fd958e4d7d2158479e99c674`。耗时受本机负载影响；字节反证比wall-time更稳定，不承诺生产延迟。接手口述5449.461→2627.149ms只属历史，不是本轮结果。

## 可执行人工路径：不删除未知证据

以下由操作人明确选择，不是测试自动执行。PowerShell中将`$DataDir`、`$AgentDir`设为现有存储接口给出的实际目录，在源码根运行：

```powershell
node server/html-artifact-maintenance-cli.js --data-dir "$DataDir" --agent-dir "$AgentDir"
node server/html-artifact-maintenance-cli.js --data-dir "$DataDir" --agent-dir "$AgentDir" --action recover-lock
```

首条仅plan；第二条只在gate+创建身份证明允许时恢复。unknown/legacy/torn仍非零退出，原文件保留；不得手工unlink锁、`rm -r`、清空目录或加force flag。先把整个旧store只复制到独有受保护目录取证，不移动/覆盖原件，不上传HTML或owner映像路径。存在活跃写者时，副本可能不稳定，不能反推可删除资格。

未知锁不能就地强修；若需继续使用，保留整个旧数据根，创建全新空根并先只读检查：

```powershell
$Fresh = Join-Path $env:LOCALAPPDATA ('pi-gui-recovery-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Fresh
node server/html-artifact-maintenance-cli.js --data-dir "$Fresh" --agent-dir "$AgentDir" --action stats
```

然后由人按既有存储设置流程选择新根作为下次启动目标；这不是旧会话恢复/迁移，旧快照可能暂不可用，原目录保持不变。专项20号前的manual场景实际证明新根可publish/read而未知旧锁逐字节不变。

仅在锁恢复成功且取证后，操作人可显式选`--action cleanup-temporary`，只处理固定未发布TEMP；不清理native snapshots。`--action collect`即使加旧确认flag也拒绝。

## 未验证、集成与回滚

- 新leaf由父注册到唯一package canonical链：`node tests/html-artifact-lock.cjs`、`node tests/html-artifact-maintenance.cjs`、`node tests/html-artifact-performance.cjs`。benchmark/baseline参数仅专项。B2不拥有package/CI，尚未注册，不能称完整canonical通过。
- 未运行完整npm test：并行集成由父处理，且不允许替代/重启A被拒安全suite。没有调用模型，也没有修改Electron安全文件或放宽安全资格。
- 独立功能/安全复审、真实UI截图、正常sandbox、打包/安装、Linux实机、网络共享存储均未验证。gate只支持Win/Linux，其它OS保持fail-closed，平台适用性须由父验收。不承诺目录元数据断电持久化，也不是防同权限恶意本机进程的沙箱。
- 未重建产物；**跑源码版才看得到**。父需在集成后重建并验证；源码专项不证明旧可执行产物。
- 回滚按文档→测试→维护→Classic→store/lock逆序revert上述B2提交，保留B3和其他线。没有删除用户原生快照的迁移；旧版本不认识v2残留锁时应继续保留证据，不手工强删。产物另行回退/重建。

结论分开：开发完成；代码验收待独立复审/集成证明；不代表允许合并或发布。**candidates-only已验证，GC没有完成、也没有开放。**

## B4 · R-B I1：锁释放失败不再确认成功（2026-11-27）

本节仅追加本轮事实，不改写以上 B2 历史结论。指定工作树为 `feat/visual-replies-p2-b`，起点 `df866d7a`，开工时 clean；未新建 worktree、未修改根检出或其它树。任务限定离线，所以未 fetch、未核对新的远端 CI；历史 `45952490979` 不作为本轮完整证明。未访问外网、下载依赖、调用 Pi/模型或其它 Agent。

### 修复及错误契约

复用统一 `lock()`、同一物理根的内核 gate、既有路径/文件身份及不可变快照，不新增恢复接口或 force-unlock。

- 新增闭合码 `html_artifact_storage_release_failed`。动作已正常完成但释放文件锁未确认时，publish/read/collect/cleanupTemporary/stats/recoverLock 均拒绝 Promise，不返回完整成功。异常只含固定 message/code；不附系统异常、cause、路径、HTML、owner 或结果 payload。
- **释放失败不是回滚或“确定未执行”**：publish 已 rename 的 HTML/reference/pending 全部保留；相同原生元组的幂等重试返回原 reference，字节、createdAt、digest 和 pending 不变。collect 已完成的 pending 清除、cleanupTemporary 已完成的固定 TEMP 清理也保留，不能据错误再次假定这些效果未发生；不开放自动 GC。
- 同时发生业务/获取失败与释放失败时，保留原固定业务错误（例如 conflict、storage_failed、storage_corrupt），不让 finally 覆盖根因。原实例仍保留未完成释放的私有证明；后续安全操作可显式暴露持续释放失败。
- 只有创建该锁的 Store 实例保留 `{文件身份, 原字节}` 的内存证明。下次调用在原目录身份校验和同一内核 gate 内，至多重试一次该残锁释放，成功后才执行新动作。持续 EACCES 返回 release_failed；不重跑业务、不自旋，也不把自身已知残锁误报为 busy。若确有另一个实例持 gate，仍按真实互斥返回 busy。
- 健康锁要求完整 owner/nonce 字节一致。获取期间 ENOSPC/短写时，只接受已知新建 inode 内、与本次预期 owner 相符的字节前缀，捕获该前缀作精确释放证明；不把其它内容当作自己的部分写。目录、inode 或 owner 字节被替换时拒绝 unsafe，外来文件逐字节保留。缺失锁可确认释放；unlink 空操作或删除后抛错均不能伪装已确认成功。
- 上述证明不共享给同 PID 的其它 Store，不持久化、不依赖 PID 存在或锁龄；进程重启后仍只能使用既有死亡身份证明。没有证明的 torn/legacy/unknown 锁继续拒绝恢复。释放文件锁失败后仍收尾 kernel gate；close 失败单独报告 storage_failed，不重试可能已复用的 fd。
- 维护白名单透传新码为 `{ok:false,code}`，CLI 生产入口据此非零退出。server.js 启动移除空 catch，只输出白名单固定失败码，Artifact 不可用不阻断其它功能启动；不输出恢复成功日志。Bridge/HTTP 的既有安全兜底仍为 html_store_unavailable，系统统计为 unknown、不伪报零值；核对这些消费端及扩展错误白名单后无需增加新的外部码。

本次 Store 超过 500 行，保留集中实现：新增内容均属于既有同一锁生命周期，拆出另一个状态 owner 会扩大审查和回滚范围；不借故重构快照、配额或原生授权。

### 提交及集成顺序

1. `f1bdd35f80b8f7dfd392c4ed247285d1193b15a5`：共享 Store 释放语义与原实例有界重试，同时修正历史 publish 吞错与新增 recoverLock 共因。
2. `9ce0a8597ba4ea098e69c0eef7de05f6571b4dc1`：新增启动/维护报告层，独立于共享 Store 回滚边界。
3. `8030ef7aa19f50ea2258cd979e05883abab5358d`：lock/maintenance 回归；未修改 store/backend/performance 原套件或 package/CI。
4. 本追加报告单独提交；可用 `git log -1 --format=%H -- docs/visual-replies-p2-b-acceptance.md` 定位文档 SHA。

所有提交信息经 `git rev-parse --git-path COMMIT_MSG_TMP.txt` 定位、Bash printf 写入，前三字节经 `head -c 3 | xxd` 确认非 EF BB BF；均带本轮要求的 Co-Authored-By。仅 commit，不 push、PR、合并或发布。

### 本轮实测与证据

Windows 11 / Node v24.22.1；写盘均为 os.tmpdir 下的隔离 fixture，未对真实项目/原生会话做写操作。最终五套命令逐条运行、各 exit 0，**不是一次 npm test 或完整 canonical**。运行时 HEAD 仍为 df866d7a 加本轮未提交改动；被测五个产品/测试文件首尾 SHA256 漂移 0/5，提交后内容与本次证据绑定，不冒称新 SHA 的 CI。

| 命令（均在 B 树） | pass / fail / skip | 实际断言 | 耗时 ms |
| --- | --- | --- | ---: |
| `node tests/html-artifact-lock.cjs` | 33 / 0 / 0 场景 | 270 | 18780.053 |
| `node tests/html-artifact-maintenance.cjs` | 30 / 0 / 0 场景 | 189 | 13845.648 |
| `node tests/html-artifact-store.cjs` | 135 / 0 / 3 场景；skip 不计通过分母 | 529 | 29938.406 |
| `node tests/html-artifact-performance.cjs`（默认） | 16 / 0 / 0，单位为断言 | 16 | 2625.055 |
| `node --require <TEMP>/count-assertions.cjs --test --test-reporter=spec tests/html-artifact-backend.cjs` | 38 / 0 / 0 测试，含 37 子项及 1 父容器 | 162 次运行期 assert 调用 | 1640.409 |

backend 原套件没有断言计数器；TEMP preload 只包裹 node:assert/strict 的方法计数，不改变断言内容或产品，不提交进仓库。Node runner 父进程另记 0，未重复计数。Store 的 3 个 skip 仍为 Windows 文件 symlink 权限不足。lock 比 14/103 基线新增 **19 场景、167 断言**，maintenance 比 20/119 新增 **10 场景、70 断言**；原断言删除 0，store 保持 135 场景/529 断言。

回归覆盖瞬时/持续 EACCES、操作不重入、gate 真实释放、同 PID 无权接管、根/inode/同 inode 内容替换、publish 完整字节及幂等恢复、read/stats/collect/cleanupTemporary 不假成功、close 异常、部分 owner 与双重故障、unlink 空操作和删除后异常、维护固定错误及重试、统计 unknown→known。启动测试在 VM 中执行源码中真实的窄 catch 表达式，**不是完整 server 启动证明**。

另用 TEMP preload 对**生产 `server/html-artifact-maintenance-cli.js` main 入口**直接 spawn，非测试包装器供应输出/退出码：recover-lock、stats、plan、cleanup-temporary 四种动作，各注入自身锁 EACCES，实际 exit 1、固定失败 JSON、快照保留；子进程退出后正常生产 CLI 以死亡身份证明恢复，exit 0，原快照仍可读。专项 **4 pass / 0 fail / 0 skip，36 断言**。

最终默认性能样本：8 份历史、8 sessions、262152 B，每轮并发 8 份 4103 B；新发布段 **917.045ms**，实际 HTML 读取 **65648 B / 32 calls**，仍不重读历史 HTML。语料及最终读取 digest `29fa7412d5e31db4aa0c548abb4797ffcf488677fd958e4d7d2158479e99c674`；Store 源摘要 `2a38660428733d992bf39e4ef183d78848271fec31adde926f7c22d4313e8d18`。本轮不是大语料 before/after benchmark，不替换上文 B2 历史性能数据。

证据目录：`C:/Users/21022/AppData/Local/Temp/pi-b4-evidence-S3JUUH/`。`verified-targeted-results.json`、`verified-*.stdout.log` / stderr 为最终五套结果及首尾摘要；`production-cli-probe.cjs` / `production-cli-results.json` 为生产入口专项。证据在本机 TEMP，不作为永久产物或公开上传材料。

### 首次失败及处置

- 修改前实跑 lock **14/14、103 断言**，maintenance **20/20、119 断言**，fail/skip 0。
- 新回归先在旧产品上运行：lock exit 1，Missing expected rejection；maintenance exit 1，实际 `{ok:true,exists:true}` 而预期固定失败。该红灯确认原 I1，不是环境噪声。
- 首轮修复五套中 lock 30/252、maintenance 30/189、performance 16、backend 38/162 通过；store exit 1，在原 ENOSPC 用例留下自身空锁，后续读报 busy。确认为本轮产品回归：完整 owner 校验错误用于尚未完成的获取。补为已知 inode + 预期字节前缀的收尾，并加入双故障/不同 owner 不得冒充前缀的回归；原断言未修改。首次 store 输出与失败保存在未带前缀的 store 日志及 targeted-results.json。
- 中间补验 32/266 已通过；之后增加 acquisition 同 inode 异主字节的门控/回归，最终重新运行全部五套，以上 verified 结果覆盖该最终状态。没有用旧通过数字冒称新代码通过。
- 5 个变更 JS/CJS 的 node --check、git diff --check 均 exit 0。作者核对完整增量及消费端白名单，未发现需绕过身份门控的路径；这不是独立审查结论。

### 未验证、剩余边界及回滚

- **R-B I1 的作者修复及定向证明完成，待父代理安排独立增量复审后才能关闭发现。** 未再调用模型/其它 Agent；不声称功能或安全独立审查通过。
- 未跑完整 npm test/新 CI；本树仍不拥有 package/CI，也未运行、接替或修改 A 被阻断的安全 suite。完整 canonical 继续由父集成阶段补证，不把五套定向或 4 项 CLI 专项等同完整证明。
- 未验证 Linux 实机、其它文件系统/网络共享盘、真实 Windows sharing violation、真实磁盘耗尽、断电、无法确认 close 是否关闭时的 OS 句柄状态；EACCES/EIO/ENOSPC 为 TEMP 限定故障注入。仅支持既有 Win/Linux gate，其它 OS 仍 fail-closed。
- 未跑完整后端启动、Electron、真实 Pi/模型/渲染/安装；启动只测窄错误处理表达式。未重建产物，**跑源码版才看得到**；父集成后需重建验证。没有放宽 Electron 或外部网络安全资格。
- 无内存证明的原有活 owner 残锁不会被新 Store 接管；需先恢复系统访问、正常停止该 owner，再由既有死亡身份证明路径处理。持续权限失败保持失败，不承诺重启必能修复。unknown/torn/legacy 仍保留，禁止手工强删。
- 回滚顺序：本节文档 → 测试 8030ef7a → 报告层 9ce0a859 → 共享 Store f1bdd35f；由获授权的父集成变更执行，不回滚 B2/B3 或其它线。回滚会重新引入释放吞错，不能视为解决 I1；不需要数据迁移，不删除现有 HTML/reference/pending、未知锁或 TEMP 证据，产物须另行重建/回退。

结论：B4 开发与指定定向回归完成；完整 canonical、独立复审和产物均待验证；未取得合并或发布许可。
