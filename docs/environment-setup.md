# 首次启动环境检测与一键安装

用户第一次打开 Pi GUI 时，应用先回答一个问题：**这台机器能不能跑起来 Pi？**

不能时，向导把缺的东西装到当前用户目录，再验证 Node、npm、Pi 与 RPC 是否真的可用。
整个过程不需要命令行，也不需要管理员权限。

这篇文档描述当前实现（`server/environment-*.js`、`public/environment-setup*.js`）。
安装包构建见 [development.md](development.md)，发版步骤见 [releasing.md](releasing.md)。

## 一、它和另外两件更新不是一回事

| 操作 | 管什么 | 入口 | 会不会执行命令 |
| --- | --- | --- | --- |
| Pi GUI 应用更新 | 这个界面本身 | `/api/update` | 用户确认后下载安装包，重启更新 |
| Pi 运行时更新 | 已安装的 `pi` | `/api/pi-update` | 用户确认后 `pi update --self` |
| **首次环境安装** | Node / npm / Pi / Git | `/api/environment*` | 用户点击后按固定参数安装缺失组件 |

三套状态机、缓存和文案各自独立。环境向导**不触发**前两者，前两者也不调用环境安装；
不存在后台轮询。已经可用的组件不会被重装，已有 Pi 永远不会被覆盖。

## 二、首次启动会发生什么

1. 主界面加载后请求一次 `GET /api/environment`。
2. 必需项缺失 → 自动打开向导；必需项齐全 → 不打扰用户，只静默记录一次「已完成」。
3. 上次安装被应用退出打断 → 报告里带 `install.interrupted`，向导说明进度并允许继续。
4. 用户点「稍后设置」后，本次运行不再自动弹出；入口保留在
   **设置 → 应用与更新 → 环境与依赖**，侧栏图标会带提示点。
5. 页面关闭、应用退出不会把任务当成成功；下次启动重新检测，已完成的组件保留。

检测本身失败（例如某个探测抛异常）只会让对应组件显示「检查失败」，
不会让应用崩溃；路由层始终返回结构化 JSON。

## 三、检测什么、从哪里读

所有探测都在后端完成，renderer 只拿脱敏后的报告。

| 组件 | 判据 | 说明 |
| --- | --- | --- |
| Node.js | 版本 ≥ Pi 的 `engines.node` | 最小版本从 Pi 包元数据读取；读不到时退回 `22.19.0`（核对日期 2026-11-15） |
| npm | npm-cli 存在且能报版本 | 不假设 npm 与 Node 同目录；运行 Pi 不依赖它，安装或更新 Pi 时需要 |
| Pi | 启动入口可解析、版本可读、兼容矩阵状态 | **复用 `server/pi-launch.js` 的启动身份**，不另写全局目录扫描 |
| Pi RPC | `pi --mode rpc` 的 `get_state` 握手 | 只认匹配 id 的响应；超时或协议不符记为未通过 |
| Git | 可执行且能报版本 | **推荐项**，缺失只影响 Diff/Worktree 相关功能 |
| 内置 Node | Electron 自带的 Node 版本 | 仅展示；它不等于系统 Node，也不能代替 Pi 需要的运行时 |

报告区分三类：

- **必需**：Node、Pi、Pi RPC。缺一项就不能正常开始对话。
- **推荐**：npm（安装或更新 Pi 需要；Pi 已装好时缺失只影响更新）、Git。
- **可选**：当前不凭空引入 Python、Java、VS Build Tools 等依赖。

路径一律脱敏：`%LOCALAPPDATA%`、`%ProgramFiles%`、用户主目录、数据目录和安装根
会被替换成占位符，末端只留文件名（例如 `…\pi.cmd`）。诊断信息不含完整环境变量。

### 已有 Pi 的识别顺序

1. `PI_BIN` 环境变量（最高优先级，向导只读不写）；
2. 用户在向导里手动指定的路径（存在数据目录的配置里）；
3. 向导自己的托管安装目录；
4. PATH / npm 全局安装（由 `pi-launch.js` 解析出的唯一启动身份）。

这个顺序与 `environment-store.js` 的 `effectivePiBin()` 一致；向导装过 Pi 后，
下一次启动不需要用户再指定路径。

`PI_BIN` 指向一个不存在的入口时，报告会标记 `locked` 与 `action: manual`，
**不会**擅自安装另一份 Pi。用户需要修正环境变量，或清除指定后再由向导安装。
手动路径支持 `PI_BIN` 之外的场景；路径必须指向真实存在的文件。

## 四、一键安装做什么

桌面采用主进程原生确认，网页版采用向导中的明确安装操作。
后端重新检测环境，用 `planId` 与组件白名单核对安装范围。任务全程独占受管安装根目录。

### Node.js

- 官方固定 LTS ZIP：`node-v24.22.3-win-x64.zip`（Krypton），
  下载自 `https://nodejs.org/dist/`。
- 同时核对两份摘要：仓库里钉死的 SHA256，以及官方 `SHASUMS256.txt` 中的同名条目。
- 解压到随机临时目录，确认 `node.exe --version` 与目标版本一致后，
  用同卷 rename 替换 `%LOCALAPPDATA%\pi-gui\runtime\node-v24.22.3-win-x64`；
  失败时恢复旧目录。
- 不写系统 PATH，不申请管理员权限。

### Pi

- 使用官方 npm 包 `@earendil-works/pi-coding-agent`，在**隔离的 staging prefix**
  里执行固定参数：

  ```text
  npm install -g --ignore-scripts --no-audit --no-fund --no-update-notifier
      --registry https://registry.npmjs.org/ @earendil-works/pi-coding-agent
  ```

  不使用 `curl | bash`、`iwr | iex` 或任何远程脚本。
- npm 环境被收紧：清空用户/全局 `.npmrc` 的影响、移除 `NODE_OPTIONS`、
  安装相关前缀变量与关闭 TLS 校验的变量，强制 `strict-ssl=true`，禁止生命周期脚本。
- 下载与请求设置有界：连接空闲超时、重定向次数上限、取消信号会同时结束
  HTTP 请求与写流，避免任务卡在 `cancelling`。
- 安装后从 `package.json` 的 `bin` 解析真实 CLI 入口，运行 `--version`，
  再把 staging 目录替换为托管 prefix。入口路径交给 `pi-launch.js`，不另立第二份身份。
- 已有可用的 Pi 时计划里不会出现 Pi；`PI_BIN` 或手动路径优先。
- 版本低于兼容基线时，优先引导到现有 **Pi 更新**入口，而不是重装。

### Git（可选）

- 固定 Git for Windows 官方 MinGit ZIP（`MinGit-2.56.1-64-bit.zip`），
  来源 `https://github.com/git-for-windows/git/releases/…`。
- 校验仓库钉死的 SHA256（取自该 Release asset 的 `digest`），解压到用户目录，
  再把 `cmd` 目录加入 Pi 子进程的 PATH；不修改系统 PATH。
- 用户已有 Git 时不会安装；Git 缺失不会阻止进入 Pi GUI。

### 安装位置与权限

默认根目录：`%LOCALAPPDATA%\pi-gui\runtime`。
可通过 `PI_GUI_RUNTIME_DIR` 覆盖（测试和隔离试用使用）。整个流程是用户级安装，
**没有静默提权，也不会弹出 UAC**；目标不可写时报告 `targetWritable: false`，
向导给出明确的失败原因，而不是尝试提升权限。

### 下载边界

只允许 HTTPS，且主机必须是：

```text
nodejs.org
github.com
objects.githubusercontent.com
release-assets.githubusercontent.com
```

重定向逐跳重新校验；非 200、超出大小上限、校验值不符都会失败。
临时文件写在安装根下的随机 `.tmp/<token>` 目录，任务结束或失败后清理。

## 五、进度、取消与恢复

任务状态：

```text
queued → running → verifying → succeeded
                    ↘ failed
                    ↘ cancelled
```

- 每个组件带 `status / phase / progress`；界面显示组件、阶段、已下载字节和完成数，
  **不显示原始命令输出或绝对路径**。
- 「取消安装」走 `POST /api/environment/cancel`：abort 下载请求，
  kill npm / PowerShell 的整个进程树；已完成的组件保留。
- 「后台继续」只关闭弹层，任务继续在服务端运行；再打开向导会接回同一个 job。
- Windows 桌面正常退出时，主进程经直属后端 IPC 请求取消并等待清理。若退出等待超时，
  进程树终止后仍可由下次启动清理超过时限的残留临时文件。
- 进程重启后旧 job 不会假装还在跑；store 里留下 `interrupted` 记录，下次检测可见。
- npm 安装步骤有 10 分钟上限；HTTP 传输有 30 秒空闲超时，重定向有次数上限。
  任务本身没有后台自动重试，失败后由用户再次点击。

## 六、验证页

安装成功不等于可用。验证页重新执行一次检测，逐项展示：

1. Node.js 版本；
2. npm 版本（不可用时标「可跳过」，只影响安装与更新）；
3. Pi 版本（附 CLI 入口）；
4. `pi --mode rpc` 的 `get_state` 握手；
5. Git（可跳过）。

必需项全部通过才显示「进入 Pi GUI」；npm / Git 未通过只标「可跳过」。
失败时提供「重试」「重新验证」和「打开诊断」。

向导完成后写入 `completedAt`；之后即使环境再次缺失，也会按需提示，而不是每次启动都弹窗。

主 RPC 在启动前核对可执行的外部 Node、最低版本和 Pi 入口。缺依赖时状态为
`environment-required`，主界面继续运行。有项目且安装复检通过后，桥合并同一轮启动请求。
没有项目时延迟启动。已有依赖的 Pi 进程仍使用原来的启动握手、错误反馈与重试策略。

## 七、API 与 IPC

所有路由都在现有的 Origin + 令牌鉴权之后，只接受固定形状的 JSON：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/environment[?recheck=1]` | 读取检测报告 |
| `POST /api/environment/recheck` | 强制重新检测 |
| `POST /api/environment/install` | Web 安装入口，body 只含 `planId / components / consent`。桌面后端拒绝 |
| `GET /api/environment/job?id=…` | 读取任务快照 |
| `POST /api/environment/cancel` | 取消任务 |
| `POST /api/environment/pi-path` | Web 手动 Pi 路径。桌面使用原生选择或清除确认 |
| `POST /api/environment/ack` | 记录向导完成 / 跳过可选项 |

进度通过现有 SSE 事件 `environment_job` 推送；断线后前端用 `GET job` 轮询补齐。
桌面 renderer 通过 `window.piGuiDesktop.environmentSetup.install(planId, components)` 请求安装。
主进程检查调用窗口、顶层 frame、同源和组件集合，由固定文案的原生对话框获得确认。
确认后，直属后端在私有 IPC 上签发绑定同一计划和组件集合的 30 秒许可，兑换即消费。
后端在创建任务前重新检测环境并检查任务、维护和退出状态。Web 的 `consent` 字段表达网页上的显式操作，
其访问控制沿用本机 HTTP 服务的 Origin 和令牌规则。桌面路径选择只发送原生文件选择器的结果。

## 八、安全边界（实现对照）

| 要求 | 实现 |
| --- | --- |
| 不执行未校验的远程脚本 | 只有官方 ZIP / npm 包；没有 `curl \| bash`、`iwr \| iex` |
| 不拼用户输入构造 shell 命令 | 组件 id 白名单；命令是固定可执行文件 + 固定 args 数组，`shell:false` |
| 下载域名白名单 | 四个固定主机，HTTPS，逐跳校验 |
| 校验安装包 | Node：钉死 SHA256 + 官方 SHASUMS；Git：钉死 SHA256；Pi：npm registry 完整性 + 本机入口验证 |
| 路径穿越 / 符号链接 / 目录替换 | 解压脚本拒绝绝对路径、`..`、盘符、符号链接和超大条目；替换前备份，失败恢复 |
| 安装前展示组件、版本、来源、范围 | 确认页逐项列出 |
| 仅在明确点击后执行 | 唯一入口；桌面版再加原生确认 |
| 可取消，取消杀进程树 | AbortSignal + 进程树 kill |
| 不记录密钥 / 完整环境变量 | 报告只含结构、版本与脱敏路径 |
| 不静默修改用户配置 | 不写系统 PATH、不改用户环境变量、不动已有 Pi |
| 失败不破坏已有安装 | staging + 校验 + rename；失败回滚备份 |
| 失败保留诊断并清理临时文件 | 固定错误码 + 脱敏诊断；任务结束清理 `.tmp` |

这些约束不改变现有 `server/pi-update.js` 的安全边界；环境安装是独立模块，
不复用 Pi Updater 的提权或执行路径。

## 九、测试与验收

定向套件（全部离线，使用 `os.tmpdir()` 与假安装器，不碰真实 Node / Pi / Git）：

```bash
npm run test:environment
```

包含：

- `tests/environment-download.cjs`：URL / 重定向 / 大小 / 校验 / 解压脚本 / 目录替换。
- `tests/environment-setup.cjs`：检测、兼容性、RPC 握手、手动路径、脱敏、诊断。
- `tests/environment-install.cjs`：确认与计划校验、完整安装状态机、取消、失败隔离。
- `tests/environment-ui.cjs`：纯模型 + jsdom 四页流程与静态边界。

真实渲染截图使用 Chrome CDP 驱动源码版，归档在
[`designs/environment-setup-2026-11-15/evidence/`](../designs/environment-setup-2026-11-15/evidence/)；
完整的测试数字、构建产物与安装版阻断记录见
[验收记录](../designs/environment-setup-2026-11-15/README.md)。

## 十、已知限制

- 自动安装目前只支持 **Windows x64**；其它平台只做检测并给出人工指引。
- Node 版本是**钉死的 LTS**，不是「永远最新」。升级需要同时修改
  `server/environment-store.js` 的版本与摘要、本文件和测试。
- Node / Git 校验使用官方 SHA256，不是 Authenticode 数字签名验证。
- MinGit 是精简版 Git，适合 Pi 的 Diff / Worktree 调用，但不包含完整 Git Bash 体验；
  需要完整 Git 的用户应自行安装官方 Git for Windows。
- 安装后不修改系统 PATH。当前进程通过注入环境变量立即使用新路径；
  其它已经打开的终端或程序要重启后才能看到（向导不会要求注销）。
- `PI_BIN` 优先级最高。它指向坏路径时，向导不会自行覆盖，必须由用户修正。
- 检测有短缓存；用户在外部安装 Pi 后，点「重新检查」或调用 `recheck` 才会立即刷新。
