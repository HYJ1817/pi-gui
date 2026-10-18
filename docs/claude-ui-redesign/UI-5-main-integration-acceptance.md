# UI-5 主分支集成准备验收

日期：2026-10-18（Asia/Shanghai）。本轮只有一个集成 Agent；未修改 `main`，未 push，
未打 tag、升级版本或发版。

## 1. 提交与 Worktree

| 项目 | SHA |
|---|---|
| 最新 `origin/main` | `8fc16e167240990c84339a50c6449e16057bb5bd` |
| UI-5 来源 `origin/codex/ui5-diagnostics-polish` | `2e2c2cd5fbb757cd96c682619c44f9a162562f81` |
| Merge base | `3e8d7296fc89c21d38e04879ef020c47680d7ce0` |
| 集成 Merge commit | `54549876a9212c61f38adaf04a63499df67f282a` |
| 集成分支 | `codex/ui5-main-integration` |
| 集成 Worktree | `C:\pi-GUI-merge` |

集成 HEAD 之后的文档/证据提交会改变最终 HEAD；最终交付消息给出 `git rev-parse HEAD`
的实际值。`5454987` 是包含全部 UI-1 至 UI-5 历史的 merge commit。

原始测试日志、截图和构建产物哈希见
[ui5-main-integration-evidence/README.md](ui5-main-integration-evidence/README.md)。

开始前重新执行了 `git fetch origin --prune`，远端两个参考 SHA 与任务给出的值一致。
主 checkout 的 `main` 分支仍停在原本地值 `3e8d729`，没有 reset 或切换；原有
`codex/ui-1-theme-shell` 未跟踪素材保持原样。UI-5 Worktree 仍为 `2e2c2cd` 且干净。

### 执行事故与恢复

创建 `C:\pi-GUI-merge` 后，第一批后续命令误沿用了主 checkout 工作目录，短暂把
UI-5 merge 到了现有 `codex/ui-1-theme-shell`（临时 HEAD `6eea4aa`）。发现后立即用
`git reset --keep d0585b89a81c0a93e894d58b9d078af75aa985b2` 恢复该分支，未改动其
原有未跟踪文件。恢复后该分支 ref 回到原 `d0585b8`；没有 push，也没有影响远端或
主分支。真正的集成 merge 随后只在 `C:\pi-GUI-merge` 执行。

## 2. Merge 与冲突

执行：

```text
git worktree add -b codex/ui5-main-integration C:\pi-GUI-merge origin/main
git merge --no-ff origin/codex/ui5-diagnostics-polish \
  -m "Merge UI-1 through UI-5 visual redesign into main"
```

结果为 clean merge，冲突 **0**。merge commit 的第一父提交是 `origin/main`，第二父提交
是 UI-5 HEAD，因此 UI-1 至 UI-5 的提交历史完整保留，没有 squash、cherry-pick 或
`-X ours/theirs`。

main 相对 merge base 只改了 `AGENTS.md`、新增 `REVIEW.md`；UI-5 没有碰这两份文件，
所以不需要人工冲突决议。合并后：

- `AGENTS.md` 与 `origin/main` 的 blob 均为 `a80a5cefc604e175713f6ded176e7a489d9a13f8`；
- `REVIEW.md` 与 `origin/main` 的 blob 均为 `ac6d8a4ec8b384bf6c6670d4d3ac285e8928f3e4`；
- 相对 UI-5 HEAD 的差异只有这两份 main 更新，产品与测试树逐文件相同；
- `git diff --diff-filter=D origin/main..HEAD` 为空，没有删除 main 已有文件。

## 3. 产品、版本与历史完整性

相对 main 的完整变更统计：**3065 个路径，新增 3014，修改 51，删除 0**。其中
`public/` 44、`electron/` 6、`server/` 4、`lib/` 3、`tests/` 39、`docs/` 2964，
其余为 `README.md`、`PRIVACY.md`、`package.json`、`scripts/build-app.mjs`、
`server.js`。这些差异全部来自已验收 UI-5 分支。

- UI-5 日志修复 `c0769cd`、UI-4 集成提交 `51ee420` 均为集成 HEAD 的祖先。
- 集成树相对 UI-5 HEAD：`public/`、`electron/`、`server/`、`lib/`、`tests/`、
  `package.json`、`package-lock.json` 零差异。
- `integration-source.json` 在测试前冻结 460 个产品/测试文件的 SHA-256；全部测试后
  再核对为 0 mismatch。
- `package.json` 与 `package-lock.json` 版本均为 `0.25.0`，与 main 相同；锁文件未被修改。
  在新 Worktree 执行离线 `npm install --package-lock-only --ignore-scripts`，退出码 0，
  没有产生锁文件 diff。
- `public/index.html` 保留 UI-1 至 UI-5 的 tokens/theme、UI-3、UI-4、UI-5 样式入口，
  没有旧版 CSS 或第二套 UI 入口。
- P33 的 session-revert/session-change 核心实现、`public/approval-model.js`、
  `electron/browser-agent-policy.cjs`、`electron/browser-policy.cjs` 相对 main 均无 diff。

## 4. 安全与功能模块审查

按合并后的 `REVIEW.md` 定级：**高**。日志会接触诊断信息；审批涉及执行权限；Electron
preload、Browser 与原生窗口属于隔离边界；P33 涉及文件撤销。混合变更取最高风险。

首轮审查覆盖完整产品/测试 diff、合并树、入口依赖和敏感调用链；第二轮聚焦日志、审批、
Browser/Electron 与失败路径。未进行无限风格审查。由于本轮要求单集成 Agent，未引入
独立外部审查 Agent；这属于条件受限，需由用户在最终验收时知悉。

审查结论：**未发现可证实的 Blocker 或 Important**；发现 1 个既有排版 Nit（见下）。

高风险域的实际检查：

- **日志/敏感信息**：`lib/log-contract.cjs` 的无状态 `SECRET_RE`、字段白名单、
  路径/堆栈收敛和 `lib/log-core.cjs` 的导出上限均保留；`/api/logs/*` 在
  `server/router.js` 的统一 token + Origin 鉴权之后进入，目录来自固定配置而非请求，
  导出 ZIP 只包含五个固定文件名。日志客户端失败只记录数值/固定枚举，不记录 URL
  查询串、请求正文或异常 message。
- **Classic / Runtime 审批**：`public/approval-model.js` 相对 main 无差异；
  `supportsPersistentDecision()` 仍恒为 false，没有新增“总是允许/按作用域允许”。
  `public/approval.js` 只用 workspaceGeneration、bridgeRun、requestId 做陈旧性守卫，
  卡片在提交中、未知投递、失败和 owner 切换时分别保持禁用或可显式重试。
- **P33 撤销**：`lib/session-revert*`、`lib/session-change*`、`server/session-revert*`、
  `server/session-change*` 相对 main 无 diff；本会话变更面板只改展示、空态和刷新，
  没有新增 apply/restore/强制写入入口。
- **Browser / Electron**：Browser 的 `sandbox: true`、`contextIsolation: true`、
  `nodeIntegration: false`、无 preload、地址白名单与 WindowOpen 拒绝逻辑未变；
  `browser-agent-policy.cjs` 和 `browser-policy.cjs` 相对 main 无 diff。新增 Browser
  日志只写固定 operation/reason 枚举。主题 IPC 仅接受允许的 `dark/light/system`，
  并验证 sender、main frame 与 loopback origin。
- **UI 入口**：`public/index.html` 只加载 UI-1 至 UI-5 的新样式和既有 `styles.css`，
  没有第二套旧 CSS；产品树与 UI5 HEAD 逐字节相同。

按 `REVIEW.md` 的发现格式：

```text
Blocker: 0
Important: 0
Nit: 1 -- tests/ui2-native-caption.cjs:98 有既有行尾空白，无行为影响，未为集成重写
Pre-existing: SACL 审计权限与真实模型复测限制，见“未关闭问题”
```

单 Agent 限制意味着没有真正独立的第二审阅者；本轮用源码树对比、两轮代码路径审查
和可运行的故障/边界测试替代。按合并后的 REVIEW 高风险条款，仍需要用户明确接受
风险后才能将其视为可合并。

## 5. 测试

测试环境：

- 所有测试从 `C:\pi-GUI-merge` 的冻结 HEAD 运行，设置唯一的
  `C:\WINDOWS\TEMP\pi-gui-ui5-integration-*`、`TMP`、`TMPDIR`；
- 使用独立随机 Git/Security 端口；没有对用户真实项目、会话或凭据做写操作；
- 新 Worktree 的离线 `npm ci` 因环境 npm cache 缺少 `xmlchars` 返回 `ENOTCACHED`；
  随后只读复用 UI-5 Worktree 的 `node_modules`（junction），package/lock 相同。
  该限制不计为通过任何产品测试。

完整结果：

| 验证 | 结果 |
|---|---|
| `npm test` | **退出码 0**，3031.111 秒，8482 行；`FAIL` / `not ok` 0 |
| UI-5 日志/敏感信息 | 32+7+9+8+7 = 63 passed，0 failed；symlink 1 skipped |
| UI-3 Electron | 243/243，failed=0，skipped=0 |
| UI-3 CDP / 视觉 | 1761 条取景断言，失败 0 |
| UI-4 JS DOM | approval 44/44、feedback 27/27、integration 55/55 |
| UI-4 桌面 | pane 427/427、approval Electron 44/44、feedback Electron 9/9、Runtime 181/181 |
| Approval 核心 | 80/80 |
| Stop Barrier | 16/16；gui-browser-stop 12/12 |
| Runtime 关键回归 | 退出 0；registry 32/32、HTTP 12/12、store 25/25、UI 16/16、finish UI 27/27、Browser 隔离 48/48、Process 10/10 |
| Browser policy / Electron guard | 21/21、22/22、25/25、31/31、22/22、18/18、12/12；guard 123/123 |
| UI-1 Theme（JS DOM） | 47/47 |
| UI-1 Theme（真实 Electron） | 首跑 488/489（Browser 标题 5s 超时）；随后两次独立复跑均 489/489、errors 0、65 图 |
| UI-5 Logs Electron | 23/23，failed=0，10 图 |
| UI-5 Claude 视觉矩阵（source） | 90/90，errors=0 |
| UI-5 CDP 矩阵 | 1775 条取景断言，失败 0，页面异常：无 |
| UI-5 视觉矩阵（打包 public） | 90/90，errors=0 |
| App check | 首跑在 7799 端口收到 `EACCES`（端口由用户已运行的 mihomo 占用，未结束该进程）；换用已确认空闲的 8397/8398 后 **26/26** |
| EXE check | 49/49 |
| packaged logging | 15 passed，0 failed，0 skipped |

跳过项共 19，均不计入通过：logging symlink 1（`EPERM`）、SACL witness 8
（`SeSecurityPrivilege`/1300 不可用）、inplace research 2、Object witness 8。
`theme-electron` 的首跑失败单独保留在 `theme-electron.log`，两次复跑日志为
`theme-electron-retry.log` / `theme-electron-retry2.log`；不把它改写为单次 489/489。
App 首跑端口失败同样保留为 `app-check-port7799-failure.*`。

## 6. 构建与包检查

使用本机 Electron 缓存和 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，输出到全新的
`C:\WINDOWS\TEMP\pi-gui-ui5-main-integration-build-a4abb5fa473f4c07a309de2be2491dab`。
没有覆盖仓库 `build/`、`dist-app/` 或用户安装版。

- `node scripts/build-app.mjs --rebuild --output-root <TEMP>`：退出码 **0**，耗时
  **15.417s**（本机缓存命中），306 项资源、应用目录 8.0 MB、整包 328.4 MB。
- SEA `build/Pi GUI.exe`：99,744,768 bytes，SHA-256
  `50e2d9a5c0042a1d6086e5900df4f82ee499034456fa2e0bbe463723b4b00056`。
- Electron `dist-app/Pi GUI-win32-x64/Pi GUI.exe`：246,324,736 bytes，SHA-256
  `4277314cc0d4bbd758581055181d770ba8ff024537514e0e70d1e36ad8ec518a`。
- `package-assets.json`：source public 110 / packaged public 110，onlySource=[]，
  onlyPackage=[]，mismatch=[]；main/preload/server/logging/log-core/log-contract/zip/theme
  全部存在。
- `package-source-compare.json`：21 个关键 source→package 文件逐字节相同，全部 equal。
- App check 26/26；EXE check 49/49；打包日志 15/15；打包 public 的 Claude 视觉矩阵 90/90。

SEA 注入日志出现既有的 `signature seems corrupted!` 警告，这是把 Node SEA blob 注入
基础 `node.exe` 后的签名提示；本轮没有做签名/发版，不把它宣称为已签名发布包。
所有断言结果以实际退出码与包内测试为准。

## 7. 未关闭问题与合并建议

仍未关闭/未验证：

- `theme-electron` 首跑的 Browser fixture 标题超时未能稳定复现；两次复跑均通过。
  当前判断为既有测试的定时/冷启动敏感性，而不是已证实的产品缺陷，但仍保留为首跑失败。
- 真实 Windows 中文输入法（IME composition）、多显示器跨 DPI/OS 125%、
  caption 按钮的完整鼠标交互、真实 Pi/真实模型长时间 soak、POSIX 和签名安装包
  尚未验证。
- SACL 审计场景因当前 token 无 `SeSecurityPrivilege` 跳过，不能作为生产撤销资格。
- 首次独立专项启动器因 PowerShell 将 Electron stderr 包成 NativeCommandError 而中止；
  该现场保存在 `runner-abort-*`，修正采集器后重跑成功。没有为了通过修改产品断言。
- 新 Worktree 的离线 `npm ci` 因本机 npm cache 缺 `xmlchars` 返回 `ENOTCACHED`；
  测试使用 UI5 Worktree 的同锁 `node_modules` junction。这是依赖存储共享限制，
  不影响源码隔离，但不应被称为完全独立的依赖安装环境。

**合并建议：有条件通过。** 集成树与 UI-5 产品/测试树完全一致，完整测试、桌面测试、
CDP、打包和 App/EXE 均已有证据；没有确认的 Blocker/Important。由于日志、审批、
Browser/Electron/P33 属于合并后 `REVIEW.md` 的高风险类别，且真实 IME、跨 DPI、
真实模型和 SACL 尚有限制，最终合并仍需用户明确验收。本文档不授权、也没有执行
`git merge` 到 main、push、打 tag、升版本或发版。
