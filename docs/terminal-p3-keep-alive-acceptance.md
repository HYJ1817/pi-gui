# 终端 P3-A 验收记录：长时间任务保护与 Keep Alive

日期：2026-11-13  
分支：`feat/terminal-p3-keep-alive`  
基线：`4e9d43497b927d25b0680e6a93f13448848b698c`（P2 合并后的 `main`）  
证据范围：提交前工作区 diff（与交付提交内容一致；若行为提交后仅修改本报告，另行标注）  
交付提交：包含本报告的提交，可用
`git log -1 --format=%H -- docs/terminal-p3-keep-alive-acceptance.md` 解析  
范围：每终端显式 Keep Alive、服务端状态归属、空闲豁免边界、工具条与标签 UI、三运行时证据。  
风险级别：中（常规 UI 与状态流转；涉及进程生命周期，但只豁免空闲计时，复用既有停止/关闭/隔离清理边界）。

> 本记录只证明下列命令、构建和真实环境。完整的 `npm test` 尚未在本记录本地运行，
> 因此**不宣称 canonical 全量已通过**；本 PR 的 CI 将作为最终 canonical，结果出来前
> 合并结论仍须以完整 canonical、独立审查和用户明确授权为准。

## 一、实现落点

| 文件 | 责任 |
| --- | --- |
| `server/terminal.js` | 每会话 `keepAlive` / `keepAliveRevision`；`keep-alive` 动作；空闲计时豁免与关闭后重新计时；stop/exit/sweep/dispose 清理 |
| `public/api.js` | `setTerminalKeepAlive`，沿用创建/列出时记录的 conversation scope |
| `public/terminal-session.js` | 会话快照合并与 revision 守卫，拒绝 revision 更旧的迟到响应 |
| `public/terminal-tabs.js` | 标签上的小图钉与 `data-keep-alive`；切换标签时保留各会话自己的状态 |
| `public/terminal-panel.js` | 工具条「保持」按钮、显式开关、失败提示、按目标会话应用响应 |
| `public/ui4-pane.css` | 工具条按钮与标签图钉样式；开启态只用浅底与主文字色，窄栏不新增整行高亮 |

没有新增运行依赖；没有改 pi 本体、session schema、全局 npm 或 `taskkill` 生产逻辑。

## 二、语义与边界

| 事件 | 行为 |
| --- | --- |
| 新建 / 重启终端 | `keepAlive=false`；`create` / `start` 请求体中的同名字段被忽略 |
| 开启 Keep Alive | 只接受当前 workspace 校验通过的、处于 `running` 的会话；立即清除该会话的空闲计时 |
| 保持运行期间 | 输入与新输出仍刷新 `lastActivityAt`，但不会重新安装空闲计时；连续 30 分钟无输入输出也不停止 |
| 关闭 Keep Alive | 从这次请求起重新计算完整 30 分钟窗口，不沿用开启前的剩余时间 |
| 其他终端 | 完全不受影响；各自的计时器与标志独立 |
| 手动停止 / 关闭标签 | 仍然结束进程；标志先被清除，`stop` / `close` 不受 Keep Alive 豁免 |
| 进程真实退出 | `handleExit` 清除标志并进入 `exited`；可原地重启，重启后的新会话默认关闭 |
| workspace 确认失效 | 既有 scope sweep / 请求校验路径照常退休并结束进程树 |
| 应用退出 / 服务 dispose | 既有清理路径照常结束所有 PTY，包括 Keep Alive 会话 |
| 应用重启 | 会话本来就不持久化，标志也不持久化 |
| 伪造 / 跨 workspace / 非法参数 | 分别返回 `terminal_missing` / `stale_workspace` / `invalid_keep_alive`，不改变目标会话 |
| 迟到响应 | 服务端返回单调 `keepAliveRevision`；前端丢弃 revision 更旧的会话快照，避免旧轮询把按钮翻回旧状态 |

Keep Alive 不是心跳、不周期性伪造输入或输出，也没有全局关闭空闲超时。它只对
**单个会话的空闲计时器**做豁免；终端数量上限、workspace 归属校验、进程清理和
缓冲边界均保持原语义。

### 并发与竞态

- 同一会话的并发 `keep-alive` 请求没有保证的完成顺序，但服务端标志、计时器和之后
  观察到的状态必须一致；假 PTY 用例并发发送 `[true,false,true,false,true]` 后等待
  600ms，再断言标志与 `running` / `exited` 状态相符。
- 前端只在响应成功且携带会话时应用服务端返回的会话；失败不臆测开关状态，按钮继续
  显示服务端已知的真实状态。
- 迟到的 `read` / `list` 快照按 revision 丢弃；开关请求按发起时的会话 id 应用，
  即使响应到达时用户已切到别的标签，也不会改到当前可见终端。

## 三、UI 与交互

- 工具条在「清屏」「停止」之前增加一个带图钉图标的「保持」按钮；开启后文字为
  「保持中」，`aria-pressed=true`，并用 `--ui-hover` 浅底与主文字色表示，而不是整条
  高亮。
- 悬停提示明确说明「开启后 30 分钟无输入输出也不会自动停止」；开启后提示可点击恢复
  空闲超时。
- 标签名旁增加一个小图钉，仅在对应会话开启时显示；标签的 `title` 追加「保持运行」，
  背景标签也能看出状态。
- 按钮只在当前终端运行且没有其他操作进行时可点；`transport` 不支持该动作时按钮隐藏，
  保持 P1 兼容。
- 窄窗口下按钮不换行，标签条仍沿用原有横向滚动与长标题省略，不把工具条撑出容器。
- 操作失败只显示一条既有 notice 样式提示，不弹大块高亮，也不改变真实状态。

## 四、环境

- Windows 11 Home China 10.0.26200（真实桌面会话）
- Node.js v24.22.1
- Electron 44.4.3
- node-pty 1.1.0，Windows ConPTY
- 所有会写盘的用例使用 `os.tmpdir()` 下的临时项目 / 数据 / 用户目录；没有对用户真实
  项目或会话文件做写操作

## 五、构建

命令：

```bash
npm run build:app -- --rebuild
```

结果：exit 0（P3-A 生产代码与样式完成后重建）。应用目录 13.1 MiB，整包 333.5 MiB。
已检查打包产物：

- `resources/app/public/terminal-panel.js`、`terminal-tabs.js`、`api.js`、`ui4-pane.css`
  包含 Keep Alive 的工具条、图钉、API 与样式
- `resources/app/server.cjs` 包含 `keep-alive` 动作
- `resources/app/node_modules/node-pty/prebuilds/win32-x64/conpty.node` 与
  `conpty/conpty.dll` 存在

## 六、实际测试结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `node tests/files-terminal.cjs` | **97/97 PASS** | 假 PTY 服务端契约：默认关闭、create/start 注入无效、静默不超时、关闭后重新计满、多终端独立、手动停止/关闭、自然退出清态、workspace 变更、dispose、重启重置、伪造/跨区/非法参数、并发开关、既有 P2 生命周期回归 |
| `node tests/files-terminal-ui.cjs` | **84/84 PASS** | jsdom 面板：按钮默认态/开启态/提示、按会话作用域调用、标签图钉、切换标签、退出清态、重启重置、workspace detach/return、面板重开、迟到轮询、失败保留真实状态、CSS 规则；既有 P2 UI 回归 |
| `node tests/modules.cjs` | **121/121 PASS** | 服务端模块依赖方向与无环 |
| `node tests/terminal-source-check.cjs` | **18/18 PASS** | 真实 `node server.js` + 仓库 node-pty + 真实 ConPTY：会话接受服务端 Keep Alive、`list` 返回标志、可关闭；既有 P2 并行/隔离/树杀回归 |
| `node tests/terminal-electron-check.cjs --shots docs/terminal-p3-evidence` | **32/32 PASS** | 真实 Electron 44.4.3：工具条开关、标签图钉、切换标签后的独立状态、开关前后不重建 PTY、应用退出前保持开启并清理进程树、关闭后恢复；既有 P2 多终端与进程清理回归 |
| `node tests/app-check.cjs` | **27/27 PASS** | 重建后的 `dist-app` 内嵌后端在独立临时目录启动 |
| `node tests/smoke.cjs` | **1345/1345 PASS** | 既有 UI / 状态 smoke 回归；未改动该套件 |
| `node tests/file-size-report.cjs` | 11/11 PASS | 文件规模报告 |
| `node tests/ci-doc-scope.cjs` | 28/28 PASS | CI 文档范围检查 |

上述数字是在最终工作区上重跑的结果；均无 skip，均以 exit 0 结束。未单独运行
`npm test` 全量链，见第八节。测试使用短 `idleMs`（P3 为 1000ms）和等待真实状态变化，
不等待生产 30 分钟窗口。

### 真实 Electron P3 细节

从测试日志与截图核对到：

- 在真实打包应用中创建 3 个终端，点击活动标签后工具条 `aria-pressed` 初始为
  `false`；
- 点击「保持」后，`list` 返回该会话 `keepAlive=true`，按钮变为 `true`，对应标签的
  `data-keep-alive` 为 `true`；
- 切到另一标签，按钮恢复为 `false`，另一标签图钉不显示；切回原标签，按钮和标记恢复
  为 `true`，没有新建 PTY；
- 再次点击关闭，`list` 返回 `keepAlive=false`；
- 两次开关前后，`list` 返回的会话 id 与 `createdAt` 完全一致，没有新建 PTY；
- 应用退出前再次开启其中一个会话的 Keep Alive；关闭应用后，既有的 marker /
  身份检查证明该会话的进程树也被清理；
- 截图中的工具条显示「保持中」，标签 1 显示小图钉，标签 3 不显示。

截图（真实 Electron 窗口，CDP 页面捕获，1980×1323）：

- [terminal-p3-keep-alive.png](terminal-p3-evidence/terminal-p3-keep-alive.png)：
  工具条「保持中」、活动标签图钉与终端内容；227 686 字节
- 同一目录下的 P2 截图由本次最终构建重跑生成
  （`terminal-p2-multi-tabs.png` 204 933 字节、`terminal-p2-after-close.png`
  86 820 字节），仅作 P2 回归佐证，P2 原始验收数字仍以
  [terminal-p2-acceptance.md](terminal-p2-acceptance.md) 为准。

### P2 回归影响

Keep Alive 只增加了一条服务端动作和一个会话字段，没有改变 `create` / `start` /
`read` / `input` / `resize` / `stop` / `close` 的既有语义。P2 的多终端、切换不重建、
关闭一个、面板重开、workspace 隔离、进程树清理断言均在同一批测试中重跑通过；
`smoke` 与 `app-check` 也保持通过。

### 失败与修复历史

- UI 的 workspace 返回用例最初只检查 `host.querySelector('.terminal-tab')`，等待的
  是第一个标签而不是刚重启的活动会话，导致超时；改为扫描所有标签的
  `data-terminal-id` 后通过。
- P3 假 PTY 用例最初使用 `idleMs=400ms`。为避免 CI 事件循环停顿让「关闭后仍运行」
  的检查假红，把窗口提高到 1000ms 并同比放大等待；调整后重跑为 97/97（含后补的自然退出检查）。
- Electron P3 断言在首轮 32/32 后补了「开关前后不重建 PTY」与「应用退出前保持开启」，
  重跑仍为 32/32；这是断言增加，不是失败修复。
- 没有跳过、取消或删除的断言；四个测试文件的新增断言数见上表。

## 七、P3-A 需求覆盖

| 要求 | 证据 |
| --- | --- |
| 1. 普通终端仍按空闲超时停止 | fake 套件 `Keep Alive is independent per terminal`（普通终端到达 `exited`）；P2 空闲用例回归 |
| 2. 开启后静默不停止 | fake `Keep Alive prevents the idle stop for a silent session`（1400ms > 1000ms 窗口） |
| 3. 关闭后重新计算完整窗口 | fake `disabling Keep Alive starts a fresh full idle window`（300ms 仍运行、再 900ms 退出） |
| 4. 多终端互不影响 | fake 同一用例；UI `each terminal keeps its own Keep Alive state` |
| 5. 开启后仍可手动停止 | fake `a Keep Alive terminal can still be stopped by the user`；停止后拒绝再次开启 |
| 6. 开启后仍可关闭标签 | fake `a Keep Alive terminal can still be closed and its tab removed` |
| 7. workspace 失效仍清理 | fake `a confirmed workspace change still retires a Keep Alive terminal` |
| 8. 应用退出清理全部 PTY | fake `app dispose still kills a Keep Alive terminal`；Electron 应用退出后的进程树断言 |
| 9. 重启后 Keep Alive 重置 | fake `stop still works and restart resets Keep Alive to off`；UI 重启用例 |
| 自然退出清除标志 | fake `a natural exit clears Keep Alive and bumps its revision`（直接触发 PTY exit，不经过 stop） |
| 10. 伪造/跨区请求不能修改他人会话 | fake `forged, cross-workspace and malformed requests cannot change Keep Alive` |
| 11. 快速开关无计时器竞态 | fake 并发 `[true,false,true,false,true]` 后等待窗口边界并断言一致性 |
| 12. 迟到响应不能覆盖最新状态 | UI `a late poll cannot overwrite the newest Keep Alive state`；用例同时扣住下一次轮询，避免 60ms 后自动修正掩盖回归 |
| UI：按钮、图钉、标签切换、面板重开、失败恢复 | UI 84/84、Electron 32/32、截图 |
| 窄窗口不破坏标签布局 | 按钮 `white-space: nowrap`，标签条沿用原有横向滚动；Electron 窗口截图 |
| 服务端持有状态、不靠心跳 | `server/terminal.js` 的会话字段与 `keep-alive` 动作；无周期性输入/输出代码 |

## 八、未验证与剩余风险

- **完整 `npm test` 尚未在本地运行。** 本记录覆盖终端定向套件与真实运行时；本 PR 的
  完整 CI 返回前不能记为 canonical 全量通过，最终以该次 CI 结果为准。
- 只在 Windows 11 + ConPTY 验证；POSIX 分支沿用既有单元覆盖，没有在 macOS/Linux
  实机跑真实 PTY。
- 只验证 Electron 44.4.3 与 Node 24.22.1；没有验证其它 Electron/Node ABI 组合。
- 截图是 Chromium 页面捕获，不是 OS 级屏幕录制；能证明真实 Electron 渲染结果，
  但不能证明窗口装饰或系统缩放。
- Keep Alive 不跨应用重启持久化；应用重启后旧终端和标志都不会恢复，这是设计选择。
- Keep Alive 只豁免空闲计时：若进程或 `taskkill` 永久卡住，既有 sweep 仍会重试，
  但没有额外的强制释放额度入口；该限制与 P2 相同。
- Windows `taskkill /T` 仍以 PID 为句柄。PID 复用窗口是 P1 既有风险，本变更没有修改
  生产终止逻辑；P3-B 的 [设计](terminal-p3-process-termination-design.md) 与后续
  [实现验收](terminal-p3b-termination-acceptance.md) 在独立分支，不计入本记录的
  P3-A 验证范围。
- 没有为本期引入原生依赖或新的网络行为。

## 九、独立审查

按 [REVIEW.md](../REVIEW.md) 的常规功能（中风险）要求，由独立上下文的只读 Agent
复审完整工作区 diff；复审也实际运行了后端、UI、source、modules、文档范围和文件规模
套件，但未运行 Electron、`app-check`、`smoke` 或完整 `npm test`。结论是**没有发现
Blocker，也没有确认的产品缺陷**；以下发现均已处置。

| 编号 | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| R1 | Important | 迟到轮询用例在 `releaseRead()` 后等 100ms 才断言；未加 revision 守卫时，下一次 60ms 轮询会把错误状态修正，测试仍通过（复审用去掉守卫的副本复现） | 用例改为同时扣住下一次轮询，并在其返回前断言；临时去掉守卫后复跑得到 `ERR_ASSERTION actual 'true' expected 'false'`，恢复守卫后 UI 84/84，确认测试不再空转 |
| R2 | Nit | 假 PTY 没有覆盖「PTY 自然 exit 时清除 Keep Alive」，删除 `handleExit` 的清态行测试仍全绿 | 新增 `a natural exit clears Keep Alive and bumps its revision`，直接 `emitExit`，并相对**开启后**的 revision 断言退出时确实递增；后端重跑 97/97 |
| R3 | Nit | 验收文档对 Electron 应用退出的 Keep Alive 覆盖描述过宽；复审快照时测试在退出前已把标志关闭 | 复审报告基于较早快照；测试已改为退出前再次开启并断言 `onBeforeExit`，随后既有的 marker/身份检查验证进程树清理；Electron 重跑 32/32 |
| P1 | Pre-existing | revision 只在 Keep Alive 变化时增加；相同 revision 的迟到快照仍可能覆盖较新的 `state`，下一次轮询会修正 | P2 已有行为，本次未扩大；验收文档只声称「revision 更旧的快照被丢弃」，不声称所有迟到快照都不会覆盖状态 |

复审对 R1/R2/R3 的定向复核确认没有新增 Blocker / Important；R2 的 revision 基线精度
建议已采纳（改为对比开启后的 revision）。复审意见只是证据，不代替用户审批；完整
canonical 仍以本 PR 的 CI 为准。

## 十、结论与授权

- **开发完成：是。** P3-A 的默认关闭、显式开启、服务端状态、空闲豁免边界、生命周期
  清理、并发/迟到响应处理与工具条/标签 UI 已实现；文档、打包和定向运行时验证已完成。
- **代码验收：待完整 `npm test`（本 PR CI）与用户确认。** 独立复审完成后按发现处置；
  完整结果出来前保持「待验证」，不能用定向套件或 AI 复审意见代替用户审批。
- **合并许可：未授权。** 本分支提交、推送并创建 PR，不自行合并。
- **发布许可：未授权。** 未打 tag、未推送发布 tag、未执行正式发布。

## 十一、回滚

本变更没有数据迁移、配置格式变更或用户文件写入。回滚时撤销
`feat/terminal-p3-keep-alive` 的提交（若已创建 PR 则关闭 PR）即可；已有后端进程在应用
退出时按现有生命周期清理。Keep Alive 状态本来就不跨应用重启持久化，回滚不遗留需要
迁移的会话数据。

## 十二、证据文件

- [Keep Alive 截图](terminal-p3-evidence/terminal-p3-keep-alive.png)
- [P2 多标签回归截图](terminal-p3-evidence/terminal-p2-multi-tabs.png)
- [P2 关闭一个标签回归截图](terminal-p3-evidence/terminal-p2-after-close.png)
- [P2 验收记录](terminal-p2-acceptance.md)
- [工作区与生命周期说明](work-surfaces.md)
- [终端安全边界](security.md#项目终端)
- [测试分层](testing.md)
- [P3-B Windows 进程终止设计](terminal-p3-process-termination-design.md)（设计；实现与验收在独立分支）
