# 旧版审查问题第一批修复记录

范围：基于 v0.26.0 / cbcd6c2 修复编号 1、4、7、10。用户要求不使用子代理，
本轮由同一 agent 实施和自审，没有独立复审。未修改 CI 工作流、版本号或外部 Pi。

风险级别：高，涉及上传文件写入及运行/停止状态；未合并或发布，等待人工审阅。

结论：首批修复已实现并通过相应验证；验收有条件通过。末尾上传前缀调整只做
受影响的专项与打包复测，单次全量不是完全冻结的最终树，具体边界见下文。

## 修改与边界

- `server/uploads.js` 直接使用 URLSearchParams 已解码的名称，保留字面的 `%`
  与 `%20`；上传 ID 使用原生密码学随机数（96 位、24 个十六进制字符），
  与原时间戳前缀等长，避免 UUID 叠加使原本可用的多字节文件名超限。
  使用 `wx` 排他创建，碰撞最多重试五次，不覆盖已有文件。
  HTTP 字段和附件原始名称语义保持一致。
- `public/runtime-store.js` 为内存草稿添加编辑版本；中央会话和独立会话弹窗
  同时捕获原始草稿、版本和 owner。成功回调只清除仍属于该次提交的草稿，
  包括“编辑后又改回同样文字”的情况；失败、换会话与 owner 换代保留内容。
- `server/runtime-registry.js` 按请求 ID/命令类型结算待确认请求，区分尚未
  确认的原请求与已经开始/排队的任务。失败或 handled 追加不结束原任务；
  旧响应不结算新请求。Stop 屏障只由既有权威停止结果解除。
  缺少明确 success 布尔值的应答保持未知，不删除待确认请求或改为空闲。
  待确认表只保留 ID/类型，最多 32 条；超额拒绝为 `runtime_request_limit`，
  相同待确认 ID 拒绝为 `invalid_command`。settled、桥重置及确认 Stop 清理。

## 已完成验证

- 初始 24 个专项用例在旧代码上 7/24，通过修复后 24/24。
  后续增加碰撞耗尽、停止屏障、启动前乱序响应、真实 bridge/guardian 夹具，
  以及长中文文件名预算。最终 `node tests/high-risk-regressions.cjs`：29/29，exit 0。
- 为验证新增状态边界确实能发现旧问题，将 HEAD 原版 registry 写入临时
  模块，其他模块保持修复后版本，执行当时的 28 项组合：19/28，9 个状态用例失败。
  没有回滚或改写工作区源码来制造红灯。
- 相关现有套件：runtime-store 25/25、runtime-ui 16/16、runtime-conversation
  48/48、runtime-registry 32/32、runtime-events 14/14、session-runtime 5/5、
  runtime-http 12/12、model-fallback 74/74、modules 117/117，总计 343/343。
- 自审补测缺少 success 的应答，先得到 27/28 的预期失败；收紧应答校验后
  恢复 28/28，并重新运行 registry 32/32、全量入口及离线构建。
- `node tests/high-risk-electron.cjs`：12/12，exit 0。真实 Electron 鼠标和
  文本输入、实际 renderer/CSS、fixture API；两处输入面各六种情形，四张截图。
  该测试显式使用 `--no-sandbox`，没有验证沙箱安全，也没有调用真实 Pi。
- 离线 `npm run build:app -- --rebuild --output-root <隔离构建根>`：exit 0。
  Electron ZIP 来自本机已有缓存，没有下载依赖。入口 234.9 MB，整包 328.4 MB。
- 三个修改的 renderer 文件与包内副本逐字节一致；包内后端包含新上传分配
  及请求状态逻辑。`node tests/app-check.cjs --output-root <隔离构建根>`
  最终 26/26，exit 0；测试目录没有 node_modules 祖先，假 Pi 可启动，
  公开/私有 RPC、PDF、DOCX、图片与无项目降级通过。
- 最终打包后端另做实际 HTTP 专项 5/5：百分号、字面 %20、中文名称、长中文
  名称，以及固定同毫秒下 30 次同名上传；30 个 ID 全部唯一，逐个磁盘正文与
  原请求一致。
  该验证启动重建的 Electron Node 后端，不依赖源码模块替代打包程序。
- 长中文文件名新增用例先得到 28/29 的预期失败，随后改为等长随机前缀，
  恢复 29/29，并重建桌面包、复测打包检查与实际打包上传。该末尾改动只涉及
  server/uploads.js；其他产品文件摘要与全量主运行输入相同。全量主运行的
  首个专项当时为 28 项；末尾这一个前缀调整后执行受影响的定向复测，
  没有再次从头重复整个 Native 矩阵，不能声称单次全量来自完全冻结的最终树。
- 修改的七个 JS/CJS 文件 `node --check` 通过，`git diff --check` 通过。

全量主运行 `npm test`：exit 0，3196.113 秒（约 53 分 16 秒），当前入口的
138 个串行步骤执行完毕，展开 npm 子脚本为 144 条命令。该轮首个专项为
28/28；末尾上传文件名前缀调整后另做最终 29/29 与打包复测，没有再次完整
重跑。因此不声称最终完全冻结树的一次性全量通过。没有删除既有断言。

该轮显式环境跳过包括：session-revert-sacl-witness 0/0、skipped=8；
session-revert-inplace 28/28、skipped=2；Object witness 0/0、skipped=8。
跳过不计入通过数，不能据此宣称 SACL 或生产恢复写入已获资格。
本轮环境为 Windows / Node v24.14.0 / Electron 44.4.3；未运行真实 Pi/模型、
Node 22、POSIX 真机或长时间真实编码压力验收。

本机可复查证据保存在忽略目录 `.probe/high-risk-fixtures-20261018/`：

- `npm-test-final-outside.log`：完整主运行日志。
- `filename-budget-red.log`：新增长中文名称用例修复前 28/29 的失败证据。
- `app-check-final-filenames.log`：最终产物 26/26。
- `packaged-upload-final.json`：最终产物实际上传 5/5。
- `source-digests.json` / `source-digests-final.json`：全量输入与末尾单模块修正
  的归属，其他产品文件没有变化。
- `pi-high-risk-electron-wRXkDr/report.json` 及四张 PNG：真实 Electron 12/12。
- `final-build-root.txt`：唯一用于本次最终交付的构建根目录；该目录的
  `dist-app/Pi GUI-win32-x64` 是新桌面包，未替换现有安装。

## 本机验证环境记录

首次默认环境在 SACL witness 中断。进一步确认 PowerShell 拒绝执行未签名的
仓库测试夹具；只对测试子进程设置执行策略后，权限探测正常返回
`auditEnabled:false / auditError:1300`，SACL 环境限制不冒充验证通过。

本机临时目录的低完整性写入限制导致首次 Electron 截图 EPERM。改用独立
可写 fixture 后交互通过。临时目录嵌套于仓库还导致 Git 非仓库用例向上发现
真实 checkout，初次为 159/161；进程级 GIT_CEILING_DIRECTORIES 隔离后
独立复测 161/161。没有修改真实仓库的 Git 配置。

后续固定端口 7791 被 Windows 拒绝绑定，改用套件现有端口环境变量后，
dev-server 30/30、models-api 50/50、server-security 39/39、electron-guard
123/123。Worktree 用例的 Git 环境刻意隔离外部配置，仍会识别嵌套目录的
真实父仓库；最终使用仓库外、具有独立可写权限的临时目录，单独复测
worktrees 56/56，并在同一环境完整运行 npm test。没有改产品或断言避开拒绝。

打包检查第一次使用嵌套临时目录，按预期被“无 node_modules 祖先”断言拒绝，
25/26。后来使用仓库外的独立可写临时 fixture，最终 26/26。没有放宽测试断言，
也没有改变系统执行策略或产品启动权限。所有写操作只针对专用 fixture，
未对用户真实项目/会话做验证性写入。

## 剩余范围与回滚

编号 2、3、6、9、11 尚未修复；编号 8 的真实切换端到端复现仍待完成；
编号 5 原有修复保持不变。CI 优化留在后续独立改动。

后续 CI 的只读线索：当前 ci.yml 在 Windows Node 22/24 各跑完整 npm test，
打包 job 等待两者完成；当前入口为 138 个串行步骤，展开 npm 子脚本为 144 条
命令。已有 npm 下载缓存及取消旧提交运行的配置，不能再把它们当成新增优化。
`tests/session-change-store.cjs` 的 100-operation replay 先循环构造 100 条
操作，再开始打印重放耗时；那一个重放数值不包含 fixture 构造，后续应分别
量化构造与被测行为。上述是源码和本轮本地观察，不代表已测得 GitHub runner
的具体瓶颈；本轮没有修改工作流或删减覆盖。

当前变更未提交、推送、合并或发版；隔离产物没有替换用户安装。
回滚可将本批七个已有文件恢复至 cbcd6c2，并移除本批新增测试/文档；
只针对本批 diff 操作，不覆盖用户原有文件或未跟踪目录。

自动批准审查拒绝删除本轮旧临时构建目录，返回原因仅为 `blocked by policy`。
旧目录已保留，没有改用其他方式删除；最终交付只使用 final-build-root.txt
指向的目录，不使用旧构建。
