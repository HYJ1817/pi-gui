# 系统设置 P1 验收记录

- **基线 / 分支**：`c444b7c8d1df6735bd998d24b111559b99d63e93`（开发前核对的 `origin/main`），`feat/system-settings`。基线 [CI 44673633963](https://github.com/HYJ1817/pi-gui/actions/runs/44673633963) 为取消，不是成功证明。
- **交付身份**：`git log -1 --format=%H -- docs/system-settings-p1-acceptance.md` 定位本报告的交付提交；`git diff c444b7c8..HEAD --stat` 查看范围。最终本地测试及重建发生在基线加待提交 P1 代码的工作区，报告和代表图不改变产品行为。产品版本仍为 `0.34.0`。
- **风险与结论**：风险高（配置写入、IPC、原生退出）。开发完成；定向测试、真实 Windows Electron 和本地打包通过，完整 canonical、人工 P1 验收及真实安装升级仍待验证。没有合并或发布许可。

## 对照与实际页面

参考 [vastsa/PI-Desktop `50b73f618d99fd82d577ae3f8f813c11969003d5`](https://github.com/vastsa/PI-Desktop/tree/50b73f618d99fd82d577ae3f8f813c11969003d5)。对照真实设置截图、源码与有效样式，不移植 React 组件、CSS、存储后端或退出协调器：

| 参考实现（相对上游根目录） | pi-GUI P1 |
| --- | --- |
| `apps/desktop/src/features/settings/pages/SystemSettings.tsx`、`NetworkProxySection.tsx`、`StorageSettingsSection.tsx`、`developer-sections.tsx` | 沿用网络 → 存储 → 电源 → 关闭行为。「系统」放在「系统与应用」组内、「信息」之前；显示器图标与中英文搜索关键词接入既有导航。代理、宽松模式与更改路径均真正禁用，不写配置。 |
| `apps/desktop/src/features/settings/primitives.tsx`、`apps/desktop/src/styles/{settings,providers,globals}.css`、`packages/i18n/src/locales/{zh-CN,en}/index.ts` | 用本地设置卡、行、开关、分段选择、帮助浮层和确认框；保留本地尺寸、视觉 Token 和状态。标题 20px / 600。英文长标签只用于窄窗排版验证，不代表新增语言切换。 |
| `apps/desktop/electron/main/storage/ipc.ts`、同目录存储维护实现与 `apps/desktop/test/storage-maintenance.test.mjs` | 借鉴容量预览、明确确认和结果复测；不照搬上游目录维护或迁移。本地只清一个已证明的 HTTP 内存缓存。 |
| `keep-awake.ts`、`ipc/settings-ipc.ts`、`bootstrap/{startup,app-lifecycle,shutdown,close-behavior}.ts`（均在 `apps/desktop/electron/main/`），以及 `apps/desktop/test/keep-awake.test.mjs` | Main 管理两个独立 blocker、一个 Tray 及退出。上游首次关闭可询问；本地保持默认退出，不添加首次询问。偏好独立原子保存，而不是照搬上游主设置快照或 JSON 写入。 |

[页面与交互](../public/system-settings.js) / [布局](../public/system-settings.css) / [导航](../public/index.html) / [设置接线](../public/app.js) / [图标](../public/ui/icons.js)。显示器为本地图标映射中的 [Lucide Monitor](https://lucide.dev/icons/monitor)（ISC），不访问外部图标服务。

## 数据、清理和授权边界

- `GET /api/system/storage` 在既有认证、Origin 与 loopback Host 检查内；`Cache-Control: no-store`，其他方法拒绝。直接投影 [server.js](../server.js) 解析完成的 `DATA_DIR` 与 `path.dirname(MODELS_JSON)`，不再调用 `resolveDataDir()`。源码/SEA 沿用既有默认目录与显式 `PI_GUI_DATA` 优先级；Electron 安装或便携共用主进程注入规则：有覆盖则据实标记，否则使用 Electron 的实际 `userData`，不猜测注册表、打包位置或 `%APPDATA%` 子目录。Pi Agent 有独立来源；主窗口 Session 的浏览器数据路径由 Electron 原样报告；用户项目目录由工作区管理，不读取其内容。Web 看得到后端目录事实，桌面操作明确不可用。
- 唯一白名单是 `browser-memory-http-cache`：既有 `pi-gui-browser` Session，必须同时是非持久且无存储路径。统计和清理使用同一对象的 `getCacheSize()` / `clearCache()`；没有目录枚举、磁盘空间回收、任意路径、可变 partition 或 `clearStorageData()`。默认资料、独立 Runtime 浏览器、MCP 目录、日志和更新缓存都未纳入。路径穿越、硬链接、符号链接、Junction、重解析点及磁盘目标替换不在此原生桶接口的授权能力内；Session 资格在异步边界重验。缓存操作单飞，确认票据 60 秒且只用一次，容量增长须重新确认；结果为清理成功、空、部分或失败，统计未知不显示 0 B。运行中出现新缓存不承诺全部变为零。
- **保护清单**：Pi 会话 JSONL、会话标题/重命名/历史/标记、供应商配置/API Key/OAuth、项目登记和 Worktree 文件/登记、附件、设置、MCP/插件数据、已下载模型、撤销证据和恢复数据、Agent 在用临时文件、更新安装/失败恢复文件及诊断日志；另保留 Chromium Cookie、LocalStorage、IndexedDB 和登录状态。
- [主进程偏好](../electron/system-settings-store.cjs) 固定 `userData/system-settings.json`，与 `PI_GUI_DATA` 分离。v1 校验、4096 B 读取上限、检查目录与文件身份并拒绝链接，独占同目录临时写、同步、原子替换；损坏/未来版启动不覆盖，显式保存可恢复；不安全/不可读状态禁写。失败不投影未确认值。已提交但原生应用失败时保留实际行为并提示；其他设置成功不会抹掉该项警告。该保护不是针对恶意同账户并发写者的 OS 沙箱。
- [preload](../electron/preload.cjs) 仅在主窗口 opt-in 暴露五个具名操作。 [Main](../electron/system-settings.cjs) 核对 webContents、顶层 frame、精确 HTTP origin、参数数目和字段白名单。Renderer 没有通用 IPC、文件删除或网络策略接口，保持 sandbox / contextIsolation，禁用 nodeIntegration。此变更未增加依赖、修改 Pi 或改动更新授权核心文件。

## 电源与退出

[电源](../electron/system-power.cjs)：两个默认关闭的独立 ID 分别对应 `prevent-app-suspension` / `prevent-display-sleep`。即时应用、独立保存、重启恢复；托盘隐藏仍有效，正常退出释放；异常退出遵循 Electron 原生资源语义。不禁止主动休眠、关机或合盖。

| 场景 | 结果与边界 |
| --- | --- |
| X / Alt+F4，默认退出 | 沿用窗口保存、真正退出及必要更新预检；关闭行为不变。 |
| X / Alt+F4，托盘 | 只隐藏原 HWND、webContents、DOM；仍保持后台定时器、后端、Pi、Classic SSE/RPC、Runtime 待审批和编辑草稿。在更新恢复/预检已阻止关窗时保留原 veto；只是存在 ready 候选不会触发安装。 |
| 托盘单击/双击、菜单显示、第二实例 | 同一个 Tray 与窗口，恢复/显示/聚焦，不新建窗口、后端或会话。托盘无从建立时不把窗口留在不可见状态。 |
| 托盘退出、Ctrl+Q、系统页确认退出、窗口销毁兜底 | 都回到 `app.quit()` 与已存在的更新/Windows 安装维护和资源清理。普通退出等待已受理的原子偏好写完成，只重入一次，不接受新的竞争写入。 |
| 自动更新与「重启以更新」 | `canQuit` / `shouldDeferClose` / `beforeQuit` 继续按原协调器决策。实测使用真实协调器、生产主进程事件和合成 ready/恢复/预检/安装回调，检查恢复与预检 veto、托盘隐藏不安装、获准退出一次。未下载或启动实际安装器。 |
| Windows `query-session-end` / `session-end` | 可取消的查询保留既有更新保守抑制，但不锁托盘或设置 IPC；确定结束时立即释放桌面资源，完整有界清理移出会话通知回调并幂等执行。OS 可终止回调后的工作；未实测真实关机延时、注销或文件系统中断。 |

## 测试、产物与证据

Windows 11 `10.0.26200`，Node `24.22.1` / npm `11.19.1`，实际 Electron `44.4.3`（内嵌 Node `24.21.0`）。下表为实际通过数，非完整 `npm test` 总数。

| 命令 / 证据层 | 测试结果 |
| --- | --- |
| `npm.cmd --offline --logs-max=0 --no-update-notifier run test:system-settings` | 主进程/后端 **20/20**，jsdom **12/12**，失败/跳过均 0，exit 0。覆盖固定桶负向授权、缓存失败/并发/部分、写入故障、重启、关窗等待、不同偏好错误保留、确认互斥。无桌面专项已接 `package.json` canonical 链。 |
| `node tests/ui-ia.cjs`；`node tests/app-update-quit.cjs` | 最终变更 **30/30**、**17/17**，exit 0。原导航断言保留并增加系统页。 |
| `npm.cmd run test:app-update` 与相邻定向 | 生命周期收尾修正前：11 套/142 项更新通过；theme 47/47、about-info 41/41、app-shell 10/10、electron-guard 128/128、server-security 41/41、standalone-datadir 63/63。最终更新协调器另见上一行。 |
| `node tests/runtime-registry.cjs`、`node tests/runtime-resource-cleanup.cjs`、`node tests/files-terminal.cjs` | Runtime **42/42**、资源回收 **16/16**、文件/终端 **113/113**，组合 exit 0（最终收尾前的相邻回归）。真实托盘夹具验证了任务、审批和编辑保留；终端有注入 PTY 回归，未实操真实 PTY 托盘场景。 |
| `npm.cmd run test:system-settings:electron` | 收尾修正**前**正常沙箱源码版 **104 项 / 7 次启动**，exit 0；不是最终源码复跑。 |
| `npm.cmd --offline --no-update-notifier run test:system-settings:electron -- --packaged` | **最终产物 113 项 / 8 次 Electron 启动**，整条、各阶段均 exit 0，无信号。阶段序列：功能主场景、重启/托盘退出、默认退出、Ctrl+Q、会话结束、更新闸门、原子保存中退出、视觉状态；退出前观察到的进程身份数为 `8,15,15,15,15,15,15,8`，残留、blocker、Tray 均为 0。 |
| `npm.cmd run build:app -- --rebuild` | 最终离线重建 exit 0。`dist-app/Pi GUI-win32-x64/Pi GUI.exe` **246,324,736 B**，整包 334.3 MB；SEA 100.7 MB、414 项资源；Tray ICO 125,779 B。未签名、本地可运行产物；SEA 注入有签名警告，不能当作签名检查通过。 |

最终包身份（SHA-256）：

- `Pi GUI.exe`：`0b57af703a66e11a07e51645847cde933c48954f7ca6c83326b5a7499af63b89`
- `resources/app/main.cjs`：`2deaa02d4e0e6ced8fdaf50e0cbc3dec1d9c1a4a70a597f8b3e99f2026d0dc67`
- `resources/app/server.cjs`：`97c8c6fd798345ccd91d5ba20d1c79748517b5dbb196601112ac0d948029b59f`
- `resources/app/icon.ico`：`131e06d54b20b26cc61efea22bef8a0371f2956d809f914ecb0a6a8f7f96a484`

桌面试验在独立 TEMP profile、项目和离线 Pi RPC fixture 上进行；不调用模型、不写用户项目，也不以 fixture 证明真实 Pi 兼容性。打包 runner 只改 TEMP 复制品的入口清单以装观察钩子，逐字节核验 Main/Preload 模块、受影响静态资源及托盘图标，用实际打包后端运行；未从原始 manifest 入口再直接启动。真实 Chromium 内存缓存 **480,575 → 0 B**，另一次指针确认 **323 → 0 B**，取消及 Esc 均不清，Cookie/LocalStorage/IndexedDB 保留。电源原生记录：启用 ID `0`/`1`，停 `0` 保留 `1`，再启 `2`，退出释放 `1`/`2`。后台同 owner 的当前 `approvals` 在隐藏前、隐藏中及恢复后均验证，SSE 序列继续推进。进程证明只覆盖测试捕获的 PID + CreationDate，不代表失败兜底能回收已经脱离树的进程。

### 实际渲染

两张代表图来自最终打包的生产页面：[深色宽窗](ui/system-settings-p1-evidence/dark-wide.png) · [浅色窄窗](ui/system-settings-p1-evidence/light-narrow.png)。完整上下截图与 `summary.json` 在本机 `%TEMP%\pi-system-packaged-d1HCP1\evidence`，可用上列打包专项再生成；不要将临时 profile、日志或原始 payload 上传。Windows DPI 为 1.5；宽 `1320×820` CSS px / `1980×1230` 图像，窄实际 `701×602` / `1052×903`。覆盖深浅×宽窄、混合中英文长路径、窄窗 120% 字体、真实指针 Hover/Pressed、Tab/Shift+Tab、搜索方向键/Enter、取消与回焦。额外窄窗英文长标签、Loading、错误和空态使用合成桥 + 真实生产 CSS，不冒充真实 I/O 故障。系统与常规的开关/分段实际高度、字号、字重、圆角一致。

普通文字样本达 4.5:1；焦点环深/浅 **16.26 / 15.94:1**，错误文字 **6.42 / 6.47:1**。共同开关的 off 边框低于非文本 3:1：深色合成前景 RGB 81/81/81 对背景 32/32/32，**2.05:1**；浅色约 203/204/204 对 247/247/247，**1.51:1**。P1 复用公共实现且不单独覆写，保留为共享组件的无障碍待处理项，不宣称所有状态 AA。

### 审查、失败与待验证

- 独立功能审查：原报告 Important 5 / Nit 2，无 Blocker。取消关机查询锁托盘、写入中退出、恢复警告被覆盖已修并回归；更新期间的既有 veto 按要求保留并实测，非误拦真实退出。会话结束回调不再同步等待进程树，但后续有界清理仍可阻塞，该 OS 时序风险待验证。缓存提示明确排除 Runtime；晚到的预览不再覆盖其他确认框。
- 独立安全/故障审查：已保存未应用的首轮 Important 和跨设置掩盖警告的后续 Important 已修。原试验的 Git 配置继承改为清除 `GIT_*` 并验证实际工作树/元数据均为夹具；待审批断言改查当前审批集合而非历史事件。最后增量由作者核对并运行故障注入和最终打包场景，无第三轮独立通过声明。
- 失败保留：早期路由动态端口、UI 帮助读取、Electron 键盘、Pi 夹具资格、视觉脚本及打包离线钩子均修正后复测。最后收尾曾因本地缺 `jsdom`/`@electron/packager` 退出 1，普通 offline install 缓存缺元数据也退出 1；按锁文件 `npm.cmd ci --offline --include=dev --ignore-scripts --no-audit --no-fund` 恢复后定向及重建退出 0，未改依赖清单。此前旧 `window-state` 被超时停止，未计通过；它的旧产物/无沙箱不是本证明。打包运行仍有 Electron 对 `NODE_OPTIONS` 的警告，main 显式 require、后端 CLI `--require` 及执行标记独立验证离线守卫；合成更新入口未挂更新 UI state handler 的日志不代表正式更新 UI 通过。
- **未验证**：完整本地 `npm test`（按任务不运行）；当前提交的 PR/main canonical；真实 Windows 通知区人工输入、OS 关机/注销、真实安装版/便携签名和原位升级、真实 Pi/模型以及其他平台。最终源码 Electron 未重跑；初期默认运行时路径启动异常，早期源码证据使用相同版本的隔离运行时。抓取的代表图和最终正常沙箱包不代替以上证据。

## 回滚与下一阶段

在共享分支上用 `git revert` 回退 P1 交付范围并重建桌面产物；不要删除、重置真实用户目录或用旧包覆盖测试证据。`system-settings.json` 在回退版中不再使用，可保留；缓存仅为可再生内存数据，已清的内存内容不承诺恢复。代理/网络宽松模式待 P2 在网络配置所有者内独立定权；路径迁移需要独立预检、事务和恢复设计。等待人工 P1 验收，不开始 P2，不建 PR、不合并、不打 tag、不发布。
