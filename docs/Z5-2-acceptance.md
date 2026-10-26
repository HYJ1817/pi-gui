# Z5-2：Classic / Runtime 思考等级合同统一验收

日期：2026-10-27（Asia/Shanghai）。单一执行 Agent；提交给用户独立验收。

## 1. 身份、基线与集成

- 初始 main：`11178ac8c696dcc9c3c675522834286f6c530155`。
- Worktree：`C:\Users\21022\.codex\worktrees\z5-2-thinking-contract\pi-GUI`。
- 分支：`codex/z5-2-thinking-contract`；未修改原工作区或 Z5-1 Worktree。
- 已验证的最终行为/测试 HEAD：`45fb70402430021ed99096342a06cd93097902d4`。
  最终交付 HEAD 为包含本报告的文档提交，可用 `git log -1 --format=%H -- docs/Z5-2-acceptance.md` 解析；其后无生产修改。
- 生产目录 tree：`232582ff8a831a35cb8950b4be1b9e34beec4496`。测试时使用相同生产字节，后续提交只固定测试/证据/文档。
- 初始基线 [CI 40333759700](https://github.com/HYJ1817/pi-gui/actions/runs/40333759700)：push、attempt 1、精确 `11178ac8`，完整分组及 gate success。
- 开始时 [PR #37](https://github.com/HYJ1817/pi-gui/pull/37) 仍 open，先完成无冲突部分 `f8e654f`，没有编辑 `runtime-conversation.js`，也没有复制未合并实现。
- #37 后由外部合并：2026-10-27 00:26:22 +08:00，merge `ec336ad348f3af70e2bf4fd5e3a22dbd70d4c32a`。
  本 Agent 未发出合并动作。fetch 后以本地 merge `3651a88` 集成该 main，再完成 UI 接线。
- #37 的 [PR CI 40355347878](https://github.com/HYJ1817/pi-gui/actions/runs/40355347878) 全部成功；
  集成基线的 [main CI 40359132357](https://github.com/HYJ1817/pi-gui/actions/runs/40359132357) 最终亦为 push / attempt 1 / 精确 `ec336ad3` / success。
  两者都不证明 Z5-2 新代码。
- 已读 AGENTS、REVIEW、测试政策、文档导航、当前模型合同及历史 P32.4 §11。
  两份 Z5 规划初始不在 main，先只读 #37 固定 head `56c671f5` 中版本，合并后随 main 集成。
  Jev 返回 category=backend(0.39)、needs_tests=0.86、risk=low(0.31)；低置信结果未替代人工式代码审查，实际按中风险处理。

## 2. 先红后绿与旧合同处置

输入为 `{provider:'fixture',id:'reason-conflict',reasoning:false}` 和原生 `['off','low','high']`。

- 新回归运行于旧生产代码，exit 1：输出 `Classic=ready, Runtime levels=null`，失败项为
  `same native readback is adjustable in Classic and Runtime despite static false`。
- 新策略/控制器套件初版 **7/23**，exit 1：旧 Classic 忽略 readStatus、接受空白/控制字符档位，旧 Runtime 不输出统一结果且原生等级失败仍可报告读取成功。
- 扩展红测 **31/34**，exit 1：初始 pending、思考设置时模型变化、畸形当前值被 trim 后误作成功。
- UI 红测 exit 1：控制器已修复后，Runtime 视图仍因 reasoning=false 禁用。
- 截图复核另补红测 exit 1：失败时保留的旧值不在选项中，使 select 空白；改为选中原因占位项后通过。
- 最终相关套件结果见第 5 节。历史 Runtime 的三条 false/unknown/失败门禁断言被更强合同替换，
  同时断言 capability 原始三值、原生清单、真实设置和确认值；未简单删除断言。
  `runtime-models` **51→52**、model-capabilities **34→36**、runtime-finish-ui **27→34**；ui3-model **50**、smoke **1338** 保持。

这是用户明确选择的新产品合同，取代历史 P32.4 的保守操作规则，不将原设计分歧追溯定性为遗漏。

## 3. 新合同与生产修改

共享无 DOM 纯策略输出 `{state,levels,usable,label,detail}`。调用方负责 Pi 身份和请求相关性；
纯策略没有 HTTP、模型切换或 Owner 状态，不新增状态管理器。
当前模型须有完整 Provider/model 身份，原生读取成功、有效且当前，至少一个非 off 档位才可调节。
按 Pi 顺序去重、拒绝非法 token，不 trim/修补出新 token，不合成预设；静态 false/unknown 不覆盖原生非 off 清单，capability/evidence 不伪造。

| 生产文件 | 修改职责 |
| --- | --- |
| `public/thinking-availability.js` | 唯一纯可用性与原因策略，沿用既有 Classic 名称校验边界，兼容未知合法等级名 |
| `public/ui3-model-picker.js` | 保留兼容导出、用户提示、弹层和键盘行为，调用共享策略 |
| `public/composer.js` | Classic chip 门禁和 title 使用统一结果 |
| `public/app.js` | 将原生读取状态传给 Classic 弹层及说明入口 |
| `public/state.js` | 在现有 S 中记录轻量读取状态，工作区切换失效 |
| `public/usage.js` | 原生列表校验，模型/会话变化失效 |
| `public/rpc.js` | 既有请求配对中记录成功/失败/pending；思考写入复用策略 |
| `public/runtime-models.js` | 去掉静态门禁，输出 availability，保留完整 Owner/token 相关性及原生确认 |
| `public/runtime-conversation.js` | 仅消费 availability、显示具体原因和合法选中项，无布局或输入流程重写 |

无依赖/lockfile、Pi RPC、后端授权、Provider/OAuth/额度功能、全局缓存或 Z5-3 修改。

## 4. 两视图对照与异步隔离

| 输入/条件 | Classic / Runtime 一致结果 |
| --- | --- |
| 没有完整当前模型 | no-model，不使用即使 Pi 返回的全部档位 |
| 原生读取中 | pending，不允许选择 |
| 原生读取失败 | read-failed，显示刷新原因，不能沿用旧清单授权写入 |
| 尚未确认 / 已失效 | unconfirmed / stale，不可调；调用方按身份和代次失效，无新增 TTL |
| true + 空列表 | unavailable，不合成等级 |
| 仅 off（含静态 false） | unavailable，明确说明仅 off |
| false / unknown + off,low,high | ready；原始能力仍为 false / null |
| 重复、空白、非字符串、控制字符 | 去重、过滤非法项；全非法/非数组为 invalid |
| Owner/generation/token 改变 | 迟到结果拒绝，重置后需要新证据 |
| A 修改模型后立即看 B | A 回读只更新 A；B 模型、输出及草稿不被覆盖 |

Runtime 保留完整九字段 Owner、entry/token 与 store 已接受的 id/command/success 匹配。
HTTP ACK 不报告成功，等待 Pi response 后再读 state/levels；成功还须核对实际值和模型身份。
夹档、忽略、错误模型、失败、超时均不伪造成功；失败保留此前可靠显示，但失败读取撤销写资格。
pending 时第二次 setThinking 及未返回的等级均不发命令。

与 `ec336ad3` 比较，runtime-draft、runtime-store 和 Z5-1 的原测试文件无差异；
runtime-conversation 生产 diff 仅模型渲染区和一条纯策略 import。IME、稳定 locator、draftRevision、ACK 清除守卫均保留。

## 5. 本地定向结果

最终实际运行均 exit 0；本表 10 套共 **457/457**，skip 0。
机器可读记录：[targeted-results.json](assets/z5-2/targeted-results.json)。

| 命令 | 结果 |
| --- | ---: |
| `node tests/runtime-models.cjs` | 52/52 |
| `node tests/ui3-model.cjs` | 50/50 |
| `node tests/model-capabilities.cjs` | 36/36 |
| `node tests/model-fallback.cjs` | 74/74 |
| `node tests/thinking-availability.cjs` | 34/34 |
| `node tests/runtime-finish-ui.cjs` | 34/34 |
| `node tests/runtime-conversation.cjs` | 78/78 |
| `node tests/runtime-store.cjs` | 34/34 |
| `node tests/runtime-draft.cjs` | 42/42 |
| `node tests/ui3-integration.cjs` | 23/23 |

另：`node tests/smoke.cjs` **1338/1338**；`git diff --check` exit 0。
`node scripts/run-test-group.mjs --validate`：**223 canonical leaves**（core147/ui24/security27/native4/faults21）。
新套件已进入 package.json 唯一 test 链，并扩展既有 model-capabilities alias；计划校验不等于执行完整 canonical。

夹具修正保留全部原断言：smoke 最初1335/1338，两处缺 Provider、一处在模型确认前注入档位；
补齐后1337/1338，因完整 Provider 身份产生可选额度行，隔离 quota 后原九行统计断言恢复，最终1338/1338。
这不是额度功能变更。UI3 的直接 S 注入增加成功读取状态或改走 onThinkingLevels，不以未确认数据伪装原生结果。

## 6. 真实窗口与截图

- `G2_SMOKE_OUTPUT=<本Worktree>/docs/assets/z5-2 node tests/thinking-electron.cjs`：**35/35**、exit 0、skip 0、正常沙箱、contextIsolation=true、nodeIntegration=false。
  Electron **44.4.3**；生产 server/renderer/preload，TEMP Git + 两个 Worktree + fake Pi，网络只允许 loopback，无付费模型。
  34 个窗口/流程检查 + 父进程退出校验1项；观察进程身份9个，残留0；renderer errors=[]。
  [结果](assets/z5-2/results.json)。
- `Z51_OUTPUT=<本Worktree>/docs/assets/z5-2/z5-1-regression node tests/z5-runtime-input-electron.cjs`：**15/15**、exit 0，正常沙箱，Chromium152.0.7977.130；
  覆盖组合输入事件、229、Shift+Enter、刷新恢复和容量提示。[结果](assets/z5-2/z5-1-regression/results.json)。这是装配夹具，非实体 OS 输入法证明。
- 复用 harness 的默认模式 `node tests/electron-smoke.cjs`：**10/10**、exit 0、正常沙箱，残留0；新模式未删默认 Browser/几何/清理断言。
- 额外 `node tests/ui3-integration-electron.cjs`：最终 **243/243**、exit 0、skip0；第一次242/243的普通Enter夹具带读取中附件，触发现有发送守卫；
  将布局附件留到原有布局阶段注入后通过，未改发送实现。结果在 `%TEMP%/pi-gui-z52-evidence/ui3-regression`。
- 初次窗口夹具曾因未刷新会话侧栏超时、把 ready 的值 title 当原因比较、连接已就绪但 Owner 尚未绑定而失败；
  分别调用原有 refreshSidebarSessions、仅比较不可用原因并另核对原生选项、等待完整身份；不放松产品边界。
  [初次 Owner 竞态截图](assets/z5-2/initial-owner-race.png) 为失败历史，非最终状态。

| 场景 | 本轮真实截图 |
| --- | --- |
| Classic 静态 false / 原生三档 | [Classic](assets/z5-2/classic-false-ready.png) |
| Runtime 静态 false / 原生三档 | [Runtime](assets/z5-2/runtime-false-ready.png) |
| Runtime unknown 有原生等级 | [unknown](assets/z5-2/runtime-unknown.png) |
| 只有 off | [off](assets/z5-2/runtime-off.png) |
| 原生失败的具体原因 | [Classic](assets/z5-2/classic-read-failed.png)、[Runtime](assets/z5-2/runtime-read-error.png) |
| 没有模型 | [no-model](assets/z5-2/runtime-no-model.png) |
| 宽/窄窗口 | [1200](assets/z5-2/runtime-1200.png)、[760](assets/z5-2/runtime-760.png) |

作者已目视检查 Classic、Runtime ready、读取失败与窄窗口截图；失败原因可读，控件未越界。

## 7. 构建、产物与完整证明边界

本 Worktree 离线 `npm ci --offline --ignore-scripts --no-audit --no-fund` 恢复93个锁定包。
Electron44.4.3从既有本地 ZIP 解压到本 Worktree 的 node_modules，未下载/升级依赖，未改别的 Worktree。

最终生产修改后再次执行 `npm run build:app -- --rebuild`，通过显式 `PI_GUI_ELECTRON_ZIP_DIR` 使用本机缓存，exit0。
构建日志的 SEA signature 警告为注入时观察到的输出，不代表产物已签名。
`npm run fixtures` 已运行；最后一次产物检查 `node tests/app-check.cjs` **26/26**、`node tests/exe-check.cjs` **49/49**，均exit0。
打包 public 的九个生产模块与源码 **9/9 SHA256 相同**；[字节数和完整摘要](assets/z5-2/build-digests.json)。

- SEA：`build/Pi GUI.exe`，103001600 bytes，SHA256 `b2f30efa7e5dd212597662222cb24680c3bb4d9b5a2aa31d19f7eaeb921ac939`。
- App入口：`dist-app/Pi GUI-win32-x64/Pi GUI.exe`，246324736 bytes，SHA256 `c8755f70993aecf1da95a2557234a3fa2b59c876f7419ca62fab41147f01d81b`。
- 产物在当前独立 Worktree；未安装到用户应用目录。

**完整 canonical：待最终 PR CI 验证。** 依用户预先选择，本轮不反复运行全量 npm test。
Z5-2 没有 push/PR，故不存在 Z5-2 PR CI/gate 成功记录。基线成功 CI 不能代替它。

## 8. 审查、风险、回滚和交接

作者自查：中风险（模型操作门禁及异步状态）；完整生产 diff、相关调用和夹具已复核，
当前未发现可证实的剩余阻断问题。独立审查 **未运行**：用户要求唯一执行 Agent，交用户另行安排；不冒称代码验收通过。

未验证：完整 canonical / Z5-2 PR CI、独立功能与安全复审、真实模型/实体输入法、POSIX、打包后的完整窗口交互、安装/签名/升级。
本轮没有写真实 Provider 凭据、没有真实模型调用，不从 fake Pi 结果推断真实供应商兼容性。
`ui-visual-finish-electron.cjs` 只同步夹具读取状态，未单独运行其整个专项；已有真实模型控件和 UI3 窗口证据不冒充它。

本地提交边界：`f8e654f` 共享策略与模型回读；`3651a88` 合入已合并 Z5-1；
`ce564e4` UI集成；`45fb704` canonical注册及窗口夹具；其后文档/证据提交。
回滚时先回退最后的文档提交，再按逆序 `git revert 45fb704 ce564e4 f8e654f`；
**保留 `3651a88` 的 Z5-1 基线**，不整树 restore、不回退用户的 main 或其他 Worktree。
回退后在本 Worktree 重建 App/SEA；无模型配置/数据迁移要回滚。

交付状态：开发完成；本轮定向、窗口、构建证据已提供；独立代码验收与完整canonical待验证。
未 push、未创建 PR、未合并远端、未打 tag、未发布；未开始 Z5-3。
