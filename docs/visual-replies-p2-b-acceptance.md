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
