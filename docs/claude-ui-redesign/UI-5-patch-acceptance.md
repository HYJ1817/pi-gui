# UI-5 补丁验收：日志安全与断线恢复

日期：2026-10-18（Asia/Shanghai）
分支：`codex/ui5-diagnostics-polish`
Worktree：`C:\pi-GUI-ui5`
基线：`8f0178e34153a8043d5c3a661ab7e35e96e499d5`
代码/测试 HEAD：`0add82db422048e30e982a95eef888ebb163564b`
（文档与证据提交紧随其后；最终 SHA 以该提交后的 `git rev-parse HEAD` 为准）

本轮只修三个验收问题：敏感判定漏判（P1-A）、Renderer 日志断线后永久失效（P1-B）、
重复脱敏辅助函数（P3）。没有重构其他 UI、没有合并 main、没有改版本号、没有推送或发版。
所有测试写盘均在 `os.tmpdir()`；没有对用户项目、会话或真实日志做写操作。

## 1. P1-A：敏感信息过滤漏判

### 1.1 实际失败复现

用基线提交的 `lib/log-contract.cjs` / `lib/log-core.cjs` 运行
[`ui5-patch-evidence/repro-baseline.cjs`](ui5-patch-evidence/repro-baseline.cjs)，
输出保存在 [`ui5-patch-evidence/p1-baseline-repro.log`](ui5-patch-evidence/p1-baseline-repro.log)：

```text
连续调用 token/code/id（同一 secret）：
  1: token=null code="sk-abcdefgh12345678" id=null
  2: token="sk-abcdefgh12345678" code=null id="sk-abcdefgh12345678"
  3: token=null code="sk-abcdefgh12345678" id=null
  ...
原始 JSONL 含 secret：true
  ...{"event":"electron.renderer_responsive","code":null,...}
  ...{"event":"electron.renderer_responsive","code":"sk-abcdefgh12345678",...}
```

同一段 secret 在连续调用中交替放行；第二次事件把它写进了真实 JSONL。
这不是测试替身：复现脚本从 git 对象读取基线文件，走的是产品自己的
`createLogCore()` → `normalizeEvent()` → `code()` → 落盘路径。

### 1.2 根因

`SECRET_RE` 带 `g` 标志，`token()` / `code()` / `id()` 用 `.test()` 检测后，
在“匹配到 secret 并提前 return”的分支没有重置 `lastIndex`。下一次对同一字符串
调用时，正则从上一处匹配末尾继续搜索，返回 `false`；再下一次又从头匹配。
`token` / `code` / `id` 共享同一个正则对象，所以还存在跨函数的交错污染。

### 1.3 修复

- `SECRET_RE` 去掉 `g` 标志，只保留 `i`；所有 `.test()` 天然无状态，不再需要
  `lastIndex = 0`。
- `token()`、`code()`、`id()`、`normalizeDetails()` 的 `errorName` 分支、
  `normalizeStored()`（经前三个函数）全部复用这一无状态判定。
- `isSecretText()` 简化为单次 `.test()`。
- 字段白名单、`SUSPICIOUS_TOKEN_RE`、堆栈帧白名单、数值/布尔类型收敛均未放宽。

### 1.4 修复后测试

[`tests/logging-secret-state.cjs`](../../tests/logging-secret-state.cjs)：**9 passed, 0 failed**。

- 连续 6 次 `token/code/id` 同一 secret，全部拒绝；
- 不同函数、安全值与 secret 交错调用，不串扰；
- `normalizeEvent` 连续 6 次同值 `code` / `correlationId`，全部拒绝；
- `normalizeDetails` 两种字段顺序（secret 在 token 字段前后）都不放行 `errorName`；
- `normalizeStored` 连续 6 条事件的 `code` / `runId` / `correlationId`，全部拒绝；
- 原始 JSONL + 崩溃文件 + `status()` + `readEntries()` 不含 secret；
- `buildExport()` 的 ZIP 五个文件逐个扫描，不含 secret；
- 经真实 HTTP `/api/logs/events` 连续/交错提交后，条目 API、状态 API、
  原始文件、崩溃文件和导出 ZIP 均不含 secret。

原始日志：[`ui5-patch-evidence/p1a-after-fix.log`](ui5-patch-evidence/p1a-after-fix.log)。

## 2. P1-B：Renderer 日志断线后永久失效

### 2.1 旧行为复现

同一份基线复现脚本的最后一段输出：

```text
第一次网络失败后： {"queued":0,"failing":true,"installed":false,"seen":1}
后端恢复后再次记录：
  logRendererEvent 返回值=false
  60 秒内请求数=1
  最终快照： {"queued":0,"failing":true,"installed":false,"seen":1}
```

旧实现任何一次网络失败都把 `failing` 永久置 `true`，清空队列，之后
`logRendererEvent()` 直接返回 `false`；后端恢复后也不会再有请求。

### 2.2 分类与恢复策略

| HTTP/结果 | 分类 | 处理 |
|---|---|---|
| fetch 拒绝、`status=0` | 暂时断线 | 指数退避 1s → 30s；只保留一个在飞请求 |
| 408 / 425 / 429 / 5xx | 暂时不可用 | 同上 |
| 400 / 401 / 403 / 404 / 413 等 4xx | 不可恢复 | 停止上报，等显式恢复 |
| 200 但非 JSON / 缺 `ok` 布尔值 | 不可恢复 | 停止上报 |
| 200 `{ok:true, disabled:true}` | 用户关闭日志 | 暂停，等设置界面同步 |
| 200 `{ok:true}` | 成功 | 清零失败计数；补报降级计数 |

关键约束：

- 队列 40 条、批量 10 条、同时只有一个请求；队列满丢最旧的并计数。
- 失败时**已发出但未确认的批次直接丢弃**，不重放；否则一次网络故障会产生两份日志。
- 连续失败 5 次后每次只探 1 条，降低继续丢整批的概率。
- 队列为空时不保留重试计时器；新事件到来后只等剩余退避时间，不空转请求。
- 成功恢复后写一条 `logs.client_degraded`（`WARN`），字段只有
  `reason` / `count` / `failures`；不包含 URL、请求正文、令牌或异常 message。
- 设置界面（`public/logs.js`）在读取状态和保存设置后调用
  `setRendererLoggingEnabled()`，后端仍是启用状态的唯一真相；没有新增业务状态机，
  也没有改动 SSE/Bridge 协议。

### 2.3 修复后测试

[`tests/logging-client.cjs`](../../tests/logging-client.cjs)：**8 passed, 0 failed**。

1. 短暂网络失败 → 只丢在飞批次 → 退避后恢复 → 新事件送达 → 补报丢弃/失败计数；
2. 连续 6 次失败 → 间隔严格为 1/2/4/8/16/30 秒 → 队列空时不发请求；
3. 队列达到 40 条上限 → 保留最新、丢弃最旧、请求数不增加；
4. 后端返回 `disabled` → 暂停上报 → 显式启用后恢复；
5. 4xx 不可恢复 → 停止重试 → 显式恢复后才尝试；
6. 无效 200 响应 → 按不可恢复处理；
7. 页面重新加载 → 新客户端不继承旧失败状态；
8. 真实本地 HTTP 后端重启 → 断线期间批次不重放 → 恢复事件落盘并进入 ZIP，
   且 ZIP 中存在 `logs.client_degraded`。

原始日志：[`ui5-patch-evidence/p1b-after-fix.log`](ui5-patch-evidence/p1b-after-fix.log)。

## 3. P3：重复脱敏辅助函数

`lib/log-core.cjs` 原先在 117–142 行和 164–189 行各定义了一份完全相同的
`scrubShortText()` / `scrubLongText()`。删除第二份，保留第一份；行为不变，
`scrubShortText` 仍从模块导出，现有 32 条核心日志测试、7 条泄漏测试与 ZIP
描述脱敏测试全部通过。

## 4. 源码 diff

```text
lib/log-contract.cjs   +8 -10  无状态 SECRET_RE；新增 logs.client_degraded；failures 数值键
lib/log-core.cjs       +0 -27  删除重复 scrubShortText/scrubLongText
public/api.js          +30 -2  sendLogEvents 专用 fetch；保留 HTTP 状态码；不回显异常正文
public/log-client.js   +180 -21 有界退避恢复、暂停/停止分类、丢弃计数、重载代际保护
public/logs.js         +5 -1   同步后端 enabled 状态
package.json           +1 -1   test:logging 接入两个新套件
tests/logging-secret-state.cjs  246 行（新增）
tests/logging-client.cjs        376 行（新增）
docs/diagnostic-logging.md      +28  安全边界与恢复策略
docs/testing.md                 +6 -3 测试分层
docs/claude-ui-redesign/         补丁验收报告与证据
```

`git diff --check` 在源码/测试子集上无输出；没有空白错误。
没有新增第三方依赖，没有改版本号。

## 5. 测试结果

### 5.1 日志专项（全部通过）

| 套件 | 结果 |
|---|---|
| `tests/logging.cjs` | 32 passed, 0 failed |
| `tests/logging-leaks.cjs` | 7 passed, 0 failed, 1 skipped（Windows symlink EPERM） |
| `tests/logging-secret-state.cjs` | 9 passed, 0 failed |
| `tests/logging-client.cjs` | 8 passed, 0 failed |
| `tests/logging-ui.cjs` | 7 passed, 0 failed |

合计 **63 passed, 0 failed, 1 environment skip**。跳过项不计入通过。

### 5.2 受影响回归

| 套件 | 结果 |
|---|---|
| `tests/server-security.cjs` | 39/39 |
| `tests/modules.cjs` | 117/117 |
| `tests/smoke.cjs` | 1338/1338 |
| `tests/theme.cjs` | 47/47 |
| `tests/ui3-integration.cjs` | 23/23 |
| `tests/ui4-approval.cjs` + `ui4-feedback.cjs` + `ui4-integration.cjs` | 44/44、27/27、55/55 |
| `tests/git.cjs`（端口清理后单独复跑） | 161/161 |

### 5.3 完整 `npm test`

第一次复跑在 `tests/git.cjs` 处得到 **138/161**。失败信息里的
`projectRoot` 指向 `C:\pi-GUI`，而不是该套件自己的 fixture；检查端口发现
`127.0.0.1:7799` 被一个遗留的 `node tests/visual-harness.cjs`（PID 26628，
来自此前被中断的全量运行）占用。停止该进程后单独复跑 `tests/git.cjs` 为
**161/161**。这是环境假红，不修改任何产品/测试断言；随后重新执行完整
`npm test`，原始日志见
[`ui5-patch-evidence/full-npm-test.log`](ui5-patch-evidence/full-npm-test.log)
（假红现场）与
[`ui5-patch-evidence/full-npm-test-rerun.log`](ui5-patch-evidence/full-npm-test-rerun.log)。

最终完整 `npm test`：**退出码 0**，约 **3020 秒**，`FAIL` / `not ok` 计数 **0**。
汇总中明确报告的 environment skip 共 **19** 条：logging symlink 1、SACL witness 8、
inplace research 2、Object witness 8；跳过不计入通过。原始日志：
[`ui5-patch-evidence/full-npm-test-rerun.log`](ui5-patch-evidence/full-npm-test-rerun.log)。
第一次全量运行因中断残留的 7799 端口进程出现一次环境假红；清理后复跑通过，
没有删改任何断言。

### 5.4 隔离构建与打包日志

隔离离线构建：退出码 **0**，整包 **328.5 MB**，入口 `Pi GUI.exe` **246,324,736** 字节，
SHA-256 `4277314cc0d4bbd758581055181d770ba8ff024537514e0e70d1e36ad8ec518a`；
SEA `build/Pi GUI.exe` **99,748,352** 字节，SHA-256
`be6ebcde2402af3fcbd745f385f7ae1e7551b3d5e313d067e2f8a5f76f49b94c`。

- `tests/logging-packaged.cjs`：**15 passed, 0 failed, 0 skipped**；
- `tests/app-check.cjs`：**26/26**；
- `tests/exe-check.cjs`：**49/49**。

原始日志在 [`ui5-patch-evidence/`](ui5-patch-evidence/)：`build-app.log`、
`logging-packaged.log`、`app-check.log`、`exe-check.log`。临时构建产物在验证后删除。

## 6. 安全审计补充

- P1-A 没有引入新的日志字段或内容类别；新增的 `logs.client_degraded` 只接收
  两个数值和一个固定枚举 `reason`，比现有事件更窄。
- P1-B 的恢复逻辑不记录请求正文、URL 查询串、错误 message 或令牌；只记录
  “失败了几次、丢了几条、恢复原因”。
- `/api/logs/*` 的认证、Origin 校验、无路径参数、ZIP 固定清单都没有变化。
- 客户端仍不能枚举或读取日志文件；所有读取/导出仍走已认证 API。
- 没有新增网络目的地址；测试中的 HTTP 只连接 `127.0.0.1` 临时服务器。

## 7. 已知限制

- 退避上限是 30 秒，不是“总共只重试 N 次”：只要 UI 继续产生事件且后端仍不可用，
  每 30 秒最多一个探测请求；队列为空时不会发请求。这是为了后端重启后能自动恢复，
  同时避免日志风暴。
- 已发出但未收到响应的批次按“未确认”丢弃。若后端实际已写入但响应丢失，
  日志会出现缺口而不是重复；这是有意的取舍。
- 设置同步依赖日志设置界面读取/保存状态。若用户在应用外直接改
  `logging-preferences.json`，当前页面不会立即感知，需重新打开日志面板或重载页面。
- `tests/logging-leaks.cjs` 的符号链接用例在本机因 Windows EPERM 跳过，未计为通过。
- 本轮没有重新跑真实 Electron 日志面板截图；P1-B 是数据层/网络层变化，
  没有改动布局或视觉样式。完整 Electron 视觉回归留给最终验收。

## 8. 提交

| 内容 | 提交 |
|---|---|
| 日志安全与恢复修复 | `09f63200062a88ec3891c7699dc1707bb85580a6` |
| 两个回归套件 + `test:logging` | `0add82db422048e30e982a95eef888ebb163564b` |
| 本验收报告、设计说明与原始证据 | 紧随其后的文档/证据提交 |

最终 SHA 以文档/证据提交后的 `git rev-parse HEAD` 为准；该提交不含产品代码变更。

## 9. 结论

P1-A 的泄漏路径已在基线复现，并在事件入口、落盘、读取、崩溃文件和 ZIP 全链路关闭；
P1-B 的永久失效已替换为有界退避、明确暂停/停止分类和真实后端重启恢复；P3 只删除
重复定义。旧断言没有减少或删除。等待验收。
