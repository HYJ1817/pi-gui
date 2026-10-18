# UI-5 实施与验收

日期：2026-10-17（Asia/Shanghai）。工作区 `C:/pi-GUI-ui5`，分支 `codex/ui5-diagnostics-polish`，共同基线
`51ee4209514b2a091ded45020ae43edd458fa1a0`（UI-4 集成归档）。

**结论：本地结构化日志、日志管理界面、一键故障报告、真实 Electron/CDP 回归与隔离离线构建均已完成。**
本轮没有使用并行 Agent，没有 push、合并 main、升级版本、打 tag、创建 Release 或替换用户安装产物。
本轮代码/测试 HEAD 与验收归档 HEAD 见第 1 节；真实 OS DPI、原生窗口按钮最终合成像素、真实 Windows
中文 IME 候选窗、真实 Pi/模型和安装器升级仍不在本轮证据中，不能据此宣称完整发布资格。

## 1. 基线、Worktree 与提交

| 项 | 值 |
|---|---|
| 基线 | `51ee4209514b2a091ded45020ae43edd458fa1a0` |
| Worktree | `C:/pi-GUI-ui5`（创建前确认目录不存在） |
| 分支 | `codex/ui5-diagnostics-polish` |
| 依赖 | 复用 `C:/pi-GUI/node_modules` 的 junction；无联网安装、无依赖变更 |
| 版本 | `0.25.0`（未升级） |
| 阶段 1 | `b104c9a` 架构与安全边界 |
| 阶段 2 | `4188db7` 结构化日志与持久化 |
| 阶段 3 | `44c5ebc` Renderer 日志与日志管理界面 |
| 阶段 4 | `9aad92e` 稳定性、安全边界与打包验证收口 |
| 阶段 5 | `0fccae4` 测试稳定性与说明；本报告与证据由后续归档提交保存 |

> 归档提交无法把自身哈希写进自身内容；交付 HEAD 以交付消息与本分支 `git log -1` 为准。本文件记录的
> “代码/测试 HEAD”是加入本报告前的最后一个产品/测试提交，避免文档自引用。

**最终代码/测试 HEAD：`0fccae469ecbb8e75a72d08c2750221ea3c76c3c`**（`UI-5：稳定本机日志 HTTP 测试与测试说明`）。
本报告与 `ui5-evidence/` 是随后单独的归档提交；不把归档提交的自己哈希写入正文。

### 基线测试口径

共同基线第一次运行 `npm test` **退出码 1**：本机端口 `7799` 被一个与此任务无关的遗留
`visual-harness.cjs` 占用，`tests/git.cjs` 连到了它；随后 `server-security` 也出现同类端口/环境异常。
这不是产品基线通过，也没有被改写成通过。最终回归使用空闲端口 `GIT_PORT=7939`、`SEC_PORT=7937`，
基线受影响的 socket/安全套件另在干净端口重跑通过。原始失败日志见
[baseline-npm-test.log](ui5-evidence/baseline-npm-test.log)，最终全量见第 11 节。

## 2. 实际修改文件

（相对基线；完整列表由 `git diff --name-status 51ee420..HEAD` 复核。）

### 新增

- `lib/log-contract.cjs`：事件目录、字段白名单、安全错误名/堆栈帧、敏感 token 过滤。
- `lib/log-core.cjs`：JSONL 写入、轮转、保留期/容量、读取分页、设置、崩溃标记、ZIP 导出。
- `lib/zip.cjs`：只用 `node:zlib` 的固定清单 ZIP 写入器。
- `server/logging.js`：认证 API 适配、Renderer 事件入口、限流、导出响应。
- `electron/logging.cjs`：主进程日志适配与共享设置读取。
- `public/log-client.js`：Renderer 全局异常/SSE/Runtime 拒绝事件的上报队列。
- `public/logs.js`、`public/ui5-logs.css`：日志与故障报告界面。
- `tests/logging.cjs`、`tests/logging-leaks.cjs`、`tests/logging-ui.cjs`、`tests/logging-packaged.cjs`、
  `tests/ui5-logs-electron.cjs`。
- `docs/diagnostic-logging.md`、本报告及 `ui5-evidence/`。

### 修改

- 后端装配/路由：`server.js`、`server/router.js`。
- 既有故障路径插桩：`server/rpc-bridge.js`、`server/runtime-registry.js`。
- Electron：`electron/main.cjs`、`electron/browser-view.cjs`、`electron/browser-runtime-host.cjs`。
- Renderer：`public/api.js`、`app.js`、`approval.js`、`attachments.js`、`rpc.js`、`runtime-state.js`、
  `runtime-store.js`、`usage.js`、`index.html`。
- 测试夹具/安全回归：`tests/visual-harness.cjs`、`tests/server-security.cjs`、
  `tests/gui-browser-stop.cjs`、`tests/stop-barrier.cjs`。
- 构建/测试入口：`scripts/build-app.mjs`、`package.json`（只加测试脚本；依赖和版本不变）。
- 文档：`PRIVACY.md`、`README.md`、`docs/diagnostics.md`、`docs/security.md`。

## 3. 日志架构

真实实现与 [diagnostic-logging.md](../diagnostic-logging.md) 一致：

1. `lib/log-contract.cjs` 只接受已声明事件与字段；未声明字段直接丢弃。标准级别不写 DEBUG；
   详细模式额外写 DEBUG 事件与声明过的技术元信息，并由后端在 24 小时后回标准。
2. `lib/log-core.cjs` 由 Electron 主进程和后端各自实例化：
   - 主进程写 `main-YYYYMMDD.jsonl` / `main-crash-YYYYMMDD.jsonl`；
   - 后端写 `app-YYYYMMDD.jsonl` / `app-crash-YYYYMMDD.jsonl`；
   - Renderer 没有文件系统权限，事件经认证 API 转发，写入 `app-*` 并标 `process:"renderer"`。
3. 日志目录固定：`PI_GUI_LOG_DIR` / Electron `userData/logs` / 独立后端 `PI_GUI_DATA/logs`；
   不写项目、Git 工作区或会话目录，切项目/会话不改变目录。
4. 状态/查看/清理/导出都通过 `/api/logs/*`，经过既有 Origin + `PI_GUI_TOKEN`；不新增任意路径接口。
5. 导出由浏览器请求后端在本机组装固定五文件 ZIP；不自动上传、不自动建 Issue、不联网。

### 事件关联

- 每次进程启动生成 `runId`；关键操作由调用点生成 `correlationId`；开始/失败/耗时共享。
- `stop`、Bridge 请求、Renderer 网络/SSE、跨进程 Stop 都有可关联事件；普通事件仍生成短关联标识，
  用户不需要记住 ID。
- 错误只记 `errorName`、稳定 `code` 和自身模块的安全相对帧；异常 message 不落盘。

## 4. OpenMinis 借鉴与 pi-GUI 差异

实际阅读了 OpenMinis 的 Android `AppLogger`、`LogManagementScreen`、`CrashFileReporter`、
`ExitInfoCollector`、`OAuthLogRedaction`、日志级别/保留测试，以及 iOS `LoggingManager`。

**借鉴：** 按日期文件、级别切换、应用内查看、清理/分享、保留期与容量、崩溃文件独立、启动后仍能看到上次
异常、OAuth 敏感参数在进入日志前替换、空/错误状态。

**刻意不同：**

- 不捕获完整 stdout/stderr/logcat 或 Pi 原始 JSONL；这些可能包含聊天、工具输出和第三方内容。
- 不采用 Android ACRA/tombstone/ExitInfo；改为 Electron 主进程/后端崩溃监控、`render-process-gone`、
  `child-process-gone`、独立 crash 文件和跨启动未清理标记。
- 不采用 15 天/100 MB；pi-GUI 默认 7 天、20 MB 总上限、4 MB 单文件、5000 条/5 MB 导出上限。
- JSONL 结构化事件 + 事件/字段白名单，而不是纯文本；错误堆栈也只保留自身模块帧。
- 导出固定清单并预览确认，不打包整个日志目录；Renderer 只能读取认证 API 投影，不获得任意文件读取。

## 5. 日志安全与脱敏审计

强制边界（详见 [security.md](../security.md#ui-5-本地日志边界)）：

- **默认不收集原始内容**：事件目录中没有 message/stack/url/path/args/stdout/content 等自由文本字段；
  未知事件、未知字段直接丢弃。
- **不记录**：聊天正文、模型回复、工具输入/输出、附件/文件正文、配置原文、环境变量、API Key、OAuth token、
  Cookie、Authorization、`PI_GUI_TOKEN`、项目/HOME 路径、Browser 页面正文/敏感 URL、Git diff、完整命令。
- **三层防御**：事件/字段白名单 → 短 token/错误名/堆栈帧收敛 → 导出前逐文件结构复核。无法确定的
  用户描述/复现文本宁可省略，不声称百分之百脱敏。
- **接口安全**：`/api/logs/*` 经过既有认证；无任意文件路径参数；只读取固定目录、固定文件名模式；
  符号链接/非普通文件不进入读取或 ZIP；导出要求 `confirm:true`；Renderer 事件有大小/条数/速率限制。
- **写入失败隔离**：ENOSPC/EACCES/损坏文件/队列溢出进入 `degraded`，不向聊天、工具、审批或退出流程抛错。

### 泄漏负向测试实际结果

`tests/logging-leaks.cjs` 向隔离环境注入 `sk-…`、Bearer、API Key、OAuth token、Cookie、用户目录、
项目绝对路径、模拟聊天正文/工具输出/Browser URL、环境变量凭据、异常 message/stack，然后检查：

1. 标准与详细日志文件；
2. 崩溃文件；
3. `/api/logs/entries` 与 `/api/logs/status`；
4. 导出 ZIP 的 `README.txt` / `report.md` / `diagnostics.json` / `events.jsonl` / `errors.jsonl`；
5. 诊断快照的导出投影。

结果：**7 passed，0 failed，1 skipped**。跳过项是当前 Windows 环境不允许创建符号链接（`EPERM`），
不计为通过；代码仍对 symlink 做 `lstat` 拒绝。原始日志见 [logging-leaks.log](ui5-evidence/logging-leaks.log)。

## 6. 持久化、轮转、崩溃恢复

- 日志文件写入应用用户数据目录的私有 `logs/`，不写当前项目/Git 仓库；设置文件同目录，
  内容损坏时回退默认值、保留损坏文件并显示状态。
- 单文件超过 4 MB 轮转；轮转时做保留期与总容量清理；每次启动和设置变更也清理。
- 默认保留 7 天；可选 1/3/7/14/30 天；总上限 10/20/50 MB；清理只删匹配的普通日志文件，
  不删设置/会话标记。
- 每个进程角色独立写入文件；Renderer 经认证 API 汇总，绝不并发追加同一文件。
- 启动写 `session-<role>.json`（`clean:false`），正常关闭写 `clean:true`；若发现上次不是 clean，
  下次启动写 `app.previous_unclean_exit`/等价事件，状态显示“上次异常退出”，不暴露路径。
- 崩溃/未捕获异常使用独立 `*-crash-*` 文件；错误 message 不进入，只保留安全错误名与自身帧。
- 写入队列有界；批量同步写入受 64 KiB/批限制，测试中 600 条高频事件的调用+flush 有时限断言；
  磁盘满测试（注入 ENOSPC）只得到 `degraded/lastErrorCode=disk_full`，不抛错。

专项结果：`tests/logging.cjs` **32 passed, 0 failed**，覆盖标准/详细、关联、并发角色、轮转、
保留、损坏行、权限/磁盘满、崩溃重启、分页、ZIP、清理、禁用、跨进程关联等。

## 7. 一键导出完整流程

1. 设置 → 诊断 → “日志与故障报告”。
2. 选择时间窗口与（可选）问题描述/复现步骤，点击“预览摘要”；只显示计数/清单，不把整套日志塞进 DOM。
3. 预览成功后才启用“确认导出 ZIP”；后端再次要求 `confirm:true`。
4. 后端读取固定窗口内最多 5000 条/5 MB 的结构化事件，重新规范化并复核；使用 `node:zlib` 在本机生成 ZIP。
5. 浏览器下载文件；不访问网络、不创建 Issue、不自动上传、不附加截图/聊天/项目文件。
6. 失败返回固定错误码；界面保留错误提示并提供“复制安全摘要（降级）”。

默认窗口最近 30 分钟，可选 2 小时/24 小时；超过上限明确标记 `truncated`。用户填写的文本在包内会经过
已知凭据/路径替换；若文本本身呈现疑似高熵/凭据/路径形态，整段省略并提示重新填写。`README.txt` 提醒
发送前自行复核。

## 8. ZIP 结构与安全验证

```
pi-gui-bugreport-YYYYMMDD-HHmmss.zip
├── README.txt
├── report.md
├── diagnostics.json
├── events.jsonl
└── errors.jsonl
```

- 文件名固定白名单；路径遍历/符号链接/非白名单文件不会进入。
- `diagnostics.json` 直接复用现有诊断快照并做结构复核；没有新增 PID/路径/环境变量/配置字段。
- `events.jsonl`/`errors.jsonl` 只含事件白名单字段；按时间排序，错误含安全错误名/码/帧线索。
- `report.md` 含应用/Electron/Node/OS/Pi 版本、时间范围、用户描述/步骤、错误摘要和隐私声明；
  不注入可执行内容。
- 单独验证：`tests/logging.cjs` 的 ZIP 解压/五文件/错误条目；`tests/logging-packaged.cjs` 在隔离离线
  构建上实际生成/解压 ZIP（15/15）；`tests/logging-leaks.cjs` 扫描 ZIP 每个文件。

## 9. UI-5 视觉与交互修复

- 新增“设置 → 诊断 → 日志与故障报告…”入口和独立日志弹层；Claude Dark/Light、系统 Token、
  700/900/1200/1536 CSS px、原生标题栏保持 UI-1～UI-4 结构，没有新增大面积样式覆盖。
- 真实 Electron 截图检查发现并修复：**700px 日志页三个顶部动作按钮被 `flex:1` 拉成整行、
  主按钮变成整块深色横条**。改为按内容宽度换行；回归新增“窄屏动作按钮自然宽度”断言。
- 日志查看器：错误卡默认展开、稳定 code、详情 JSON、单条复制；来源/级别/搜索/分页；
  长中文、恶意 HTML 只走 `textContent`；空/读取失败/禁用状态可区分。
- 快速切换设置/筛选时加入过期响应保护，避免旧响应覆盖新状态或把 viewer 留在 loading。
- 既有 UI-1～UI-4 由本轮真实 Electron/CDP 联合回归复核（见第 10、11 节），没有改动它们的组件协议。

## 10. Electron 性能与稳定性测试

| 检查 | 实际结果 | 证据 |
|---|---|---|
| UI5 日志界面（源码） | **23/23，失败 0，10 张真实网页截图** | [最终日志](ui5-evidence/ui5-logs-electron.log)、[results](ui5-evidence/electron-logs/results.json) |
| UI5 日志界面（包内 public） | **23/23，失败 0，10 张截图** | [最终日志](ui5-evidence/ui5-logs-packaged-electron.log)、[results](ui5-evidence/electron-logs-packaged/results.json) |
| CDP 视觉矩阵 | **1775/1775 取景断言，失败 0** | [cdp-ui5.log](ui5-evidence/cdp-ui5.log) |
| UI-1 主题 Electron | **489/489，失败 0，65 图** | 本地回归日志 |
| UI-3 联合 Electron | **243/243，失败 0，107 图** | 本地回归日志 |
| UI-4 联合 Electron | **427/427，失败 0，75 图** | 本地回归日志 |
| UI-4 Runtime Electron | **181/181，失败 0，47 图** | 本地回归日志 |
| UI-4 Approval / Feedback | **44/44、9/9，失败 0** | 本地回归日志 |
| 既有 Runtime Electron | **170/170，失败 0，43 图** | 本地回归日志 |
| 日志界面重复开关 | 8 次开关后仍只有 1 个弹层/1 个样式表；无控制台错误 | ui5-logs-electron results |
| Runtime 短时 soak | **26 轮 / 149 checks / 0 失败**；RSS 77→143 MB 后趋平，约 3 分钟，不据此声称长期无增长 | [运行时日志](ui5-evidence/runtime-soak-180s.log)、[JSON](ui5-evidence/soak/runtime-soak-180s.json) |

日志界面矩阵覆盖 Dark/Light × 700/900/1200/1536、日志查看/导出预览、700px 窄屏；
没有用 jsdom 替代真实布局截图。UI-2 的原生标题栏真实 Windows 截图结论沿用既有 UI-2 证据，本轮没有重做
OS 级标题栏/真实 DPI 像素合成。

## 11. 完整 npm test 与原始日志

`npm test` 在最终冻结后运行。**注意：首次全量在加入 UI-5 测试前因本机遗留端口 7799 的
`tests/git.cjs` 失败；修复 VM logging 桩后用空闲端口重跑。** 原始完整日志：
[full-npm-test.log](ui5-evidence/full-npm-test.log)，进程退出码文件
[full-npm-test.exit](ui5-evidence/full-npm-test.exit)。

**最终实际结果：退出码 0；约 3076.259 秒（2026-10-18 00:06:01–00:57:17 +08:00）；**
canonical test 脚本有 **137 个顶层 `&&` 入口**，其中 `test:logging` 展开为 logging / logging-leaks /
logging-ui 三个 suite；完整日志 **0 条 FAIL / not ok**，**20 项环境跳过**。跳过明细：SACL witness 8、
inplace 非空 SACL 2、Object witness 8、sessions symlink 1、logging symlink 1。跳过的断言不计入通过
分子/分母，也不据此赋予 P33 生产资格。

新增日志套件实际数字：`logging` **32/32**、`logging-leaks` **7/7（另 1 skip）**、
`logging-ui` **7/7**；打包版 `logging-packaged` **15/15**。既有 UI-4/136 条入口链没有删除；
`package.json` 只在前面增加 `npm run test:logging`，版本/依赖/lock 不变。

格式复核：`git diff --check 51ee420..HEAD -- public lib server electron tests package.json` 退出 **0**；
全量范围 `git diff --check 51ee420..HEAD` 退出 **2**，差异仅为 `ui5-evidence/cdp-ui5.log` 中原始取景文本的行尾空格（与 UI-3 保留原始日志的做法一致）。没有为消除格式提示改写采集证据，也没有把格式提示混记为测试失败。

日志新增测试的实际命令：

```bash
npm run test:logging
# = node tests/logging.cjs && node tests/logging-leaks.cjs && node tests/logging-ui.cjs
node tests/logging-packaged.cjs --output-root <最终隔离构建根目录>
node tests/ui5-logs-electron.cjs
```

## 12. 离线构建、包内验证

最终隔离构建使用本机缓存 Electron ZIP，未联网安装：

- 输出根：见 [final-build-root.txt](ui5-evidence/final-build-root.txt)。
- `scripts/build-app.mjs --rebuild --output-root <全新绝对目录>`：退出 0；日志
  [final-build.log](ui5-evidence/final-build.log)。
- 包内 `log-core.cjs`、`log-contract.cjs`、`zip.cjs`、`logging.cjs`、`main.cjs` 均存在；
  打包后端日志测试 **15/15**：[logging-packaged.log](ui5-evidence/logging-packaged.log)。
- 包内前端 Electron 日志界面 **23/23**：[ui5-logs-packaged-electron.log](ui5-evidence/ui5-logs-packaged-electron.log)。
- `tests/app-check.cjs`：**26/26，退出 0**：[final-app-check.log](ui5-evidence/final-app-check.log)。
- `tests/exe-check.cjs`：**49/49，退出 0**：[final-exe-check.log](ui5-evidence/final-exe-check.log)。
- 入口 `Pi GUI.exe`：246,324,736 字节，SHA-256 `4277314cc0d4bbd758581055181d770ba8ff024537514e0e70d1e36ad8ec518a`。
- SEA `build/Pi GUI.exe`：99,742,720 字节，SHA-256 `c434fc5959874562a575621c3509f96b47a48b8ff9d83e45f2e0d1a3ce71d87d`。
- 整包目录：344,400,981 字节（脚本报告 328.4 MB）；入口 exe hash 不代表整包 hash。
- 没有替换用户安装产物。

## 13. 未完成项与发布风险

1. **未验证真实 OS 级 DPI/多显示器**：应用 zoom 80/125/150 已在 Electron 主题矩阵覆盖，但不能替代
   OS 100/125/150% + 多显示器下的原生窗口控制像素；原生标题栏沿用 UI-2 已关闭的 17 场景证据，本轮未重拍。
2. **未完成真实 Windows 中文 IME 候选窗/上屏时序手工终验**；UI-3 的合成 composition 与受控键盘证据仍有效。
3. **未连接真实 Pi/模型**：所有 Runtime/日志 UI 联调用离线 fixture；不含真实模型任务、真实工具输出、长期 soak、
   POSIX 或安装器升级/签名/发布。
4. **符号链接泄漏测试跳过**：本机创建 symlink 为 `EPERM`；实现有拒绝逻辑，但没有把跳过当通过。
5. **短时 soak 的 RSS 有增长**：180 秒采样从约 77 MB 到约 143 MB 后趋平；没有做 30 分钟以上 soak，不能把本次采样解释为长期无内存增长。
6. **导出文本边界**：用户主动填写的问题描述/复现步骤无法对所有未知秘密做绝对保证；系统会替换已知形态，
   对疑似高熵内容整段省略，并要求发送前复核。这是设计边界，不是“百分之百脱敏”承诺。
7. **未新增截图附件**：ZIP 不含截图，符合本轮安全要求；未来若加入，必须单独选择并确认。
8. 本轮没有替换用户安装产物、没有修改真实项目/会话数据；构建与测试只在临时目录。
9. UI-5 的日志服务是本地可观测性，不构成 Pi RPC/审批/Browser/P33 安全资格或真实模型能力证明。

## 14. 是否建议作为下一候选版本发布

**代码层面建议作为下一候选版本的基础**：日志 API、持久化、脱敏、导出、认证边界、既有 UI 回归、
打包版验证和离线构建均有实际退出码与证据；没有发现需要修改跨进程协议或降低安全参数的问题。

**不建议直接宣布完整发布就绪**：上述真实 OS DPI/原生窗口最终像素、真实 Windows IME、真实 Pi/模型、
安装器升级/签名与长期 soak 仍未完成。若下一个版本的范围只覆盖本地日志与既有 UI，不再扩大协议，
可以进入候选版本验收；发布前应重新确认这些未验证项和发布渠道。

## 15. 截图与证据

- [日志概览 Dark 1200](ui5-evidence/electron-logs/logs-dark-1200-overview.png)
- [日志概览 Light 700](ui5-evidence/electron-logs/logs-light-700-overview.png)
- [日志查看 Dark 1200](ui5-evidence/electron-logs/logs-dark-1200-viewer.png)
- [导出预览 Dark 1200](ui5-evidence/electron-logs/logs-dark-1200-export.png)
- [导出预览 Light 700](ui5-evidence/electron-logs/logs-light-700-export.png)
- 其余主题/宽度截图与结果见 [results.json](ui5-evidence/electron-logs/results.json)。
- 包内前端结果与截图说明见 [packaged results](ui5-evidence/electron-logs-packaged/results.json)。

所有截图均为真实 Electron `capturePage` 网页像素，不包含原生窗口装饰；不冒充 OS 级截图。
