# 测试分层与 CI

这份文档回答一个问题：**改了代码之后，该跑哪些测试、在哪里跑。**
这份文档讲**分层与边界**：哪些测试进 CI、哪些要真 pi、哪些只在发布前跑。
每条套件具体覆盖什么，README 里只留一句话索引，细节不重复维护。

## 一、总览

| 层 | 命令 | 需要什么 | 跑在哪 |
|---|---|---|---|
| **A. 基础测试** | `npm test` | 只要 Node ≥ 22.19 | 每次 push / PR（CI）+ 本地 |
| **B. 打包验证** | `npm run test:exe` / `test:app` | 先跑 `npm run fixtures` 与 `build:exe` / `build:app` | CI 的 build-check job |
| **C. 安装程序验证** | `npm run test:portable` / `test:installer` | 先跑 `build:installer`，且本机有 NSIS | 手动（release-check）或本地 |
| **D. 真 pi 验证** | `npm run test:skills-live` / `test:reliability-live` / `test:inject` | 本机装了 `pi` | 只在本地 / 手动 |
| **E. 界面视觉核对** | `npm run harness` + `shots` / `test:window` | 真浏览器 / 真窗口 | 只在本地 |

> **B 层要先跑 `npm run fixtures`。** 它生成测试用的 docx / png / pdf
> （放在 `os.tmpdir()/pi-gui-fixtures`）。PDF 以前只能靠 LibreOffice 转，
> runner 上没有 → 那几条断言在干净机器上必然红。现在脚本内置了一个
> **纯 Node 写的最小 PDF**，任何机器都能生成；有 LibreOffice 时仍会用
> 它转出的中文版覆盖掉（本地行为不变）。
> 想强制走最小 PDF 那条路（复现 CI）：`PI_GUI_SKIP_LIBREOFFICE=1 npm run fixtures`。

## 二、`npm test` 的定位

**`package.json` 的 `test` 脚本是测试入口的唯一真相。** CI 只调 `npm test`，
不把子测试抄进 workflow —— 抄一份就会有两个真相，以后加了新套件漏改一处，
就是「本地跑了、CI 没跑」的假绿。

`npm test` 里现在有 15 个套件，全部是**纯自动化**：

```
smoke 555 · git 151 · modules 114 · reliability · interactions · port-owner
project-config 115 · skills 182 · planner 115 · sessions 77 · body-integrity 5
dev-server 19 · models-api 50 · server-security 36 · electron-guard 50
```

它们的共同约束（新加测试时要守住）：

- **不联网。** 上游接口一律打桩（`models-api` 自己起一个假供应商）。
- **不 spawn 真 pi。** 需要 pi 的地方用桩 rpc，或者把 `PI_BIN` 指到不存在的命令。
- **不碰真实用户目录。** 数据目录、agent 目录、HOME 一律用 `os.tmpdir()`；
  写盘的用例（改 settings、会话改名/删除）**必须**走临时 fixture。
- **不需要模型额度。** 一条 prompt 都不发。
- **不需要显示器。** jsdom 跑前端，打包验证用 `node` 直接跑打包后的 `server.cjs`。
- **不依赖「跑测试这台机器装了什么」。** 要探测外部程序的地方用 **fixture 驱动**
  —— 造一个假的全局 npm 目录、把 `env.APPDATA` 指过去；要验「能 spawn 外部命令」
  就给一个假的 `.cmd` shim，而不是断言「本机装了 pi」。

最后一条是真实踩出来的，值得单独讲（三处都让 CI 红过）：

> **① `tests/planner.cjs`** 原来断言「pi 能被探测到，且能力里有 toolEvents」，
> 而它拿的是 `process.env`。结果这条断言**在开发机上是绿的、在干净的 CI runner 上直接红**
> —— 它测的不是 registry 的逻辑，而是那台机器的状态。
>
> 探测逻辑真正依赖的是 `env.APPDATA\npm\node_modules` 这条路径（`server/agents/cli.js`
> 的 `npmGlobalRoots`），而 `env` 本来就是注入进 registry 的 —— 所以这件事**本来就能测**。
> 现在用 fixture 造出「什么都没装」与「装了 pi + codex」两种世界，分别断言
> `not-installed`、`entry-missing`、版本号、入口类型，以及 `auto` 的解析规则。
>
> **② `tests/app-check.cjs` / `tests/exe-check.cjs`** 同样断言「pi 子进程已拉起」。
> 这里要验的其实是**打包出来的应用还能不能 spawn 外部命令并跟踪它的生命周期**，
> 与「本机装没装 pi」无关。现在给一个假的 `.cmd` shim（`PI_BIN` 指过去），
> 它只负责活着 —— 断言因此在任何机器上都确定。
>
> **③ 这两个测试还依赖 PDF 固件**，而固件原本只能靠 LibreOffice 转（见上面 B 层的说明）。
>
> ⚠️ 顺带一个坑：本地模拟 CI 时**只把全局 npm bin 从 PATH 里摘掉是不够的** ——
> 那条路径跟 PATH 无关，`pi` 照样会被探测到，于是模拟是绿的、真 CI 是红的。
> 模拟干净 runner 要把 `APPDATA` / `LOCALAPPDATA` 也一起指走。

## 三、CI 里跑什么

`.github/workflows/ci.yml`，触发：push 到 main / PR 到 main / 手动。

| job | 内容 | 为什么存在 |
|---|---|---|
| `test` | `npm ci` → `npm test`（matrix：Node 22 与 24） | 守住 A 层 |
| `build-check` | `needs: test` → `build:app --rebuild` → `test:app` → `test:exe` | 守住 B 层：打包链路坏掉时，测试全绿也照样发不出去 |

`build-check` 刻意**不**跑 `build:installer` / `build:dist`：那要 NSIS 和 ~430MB 产物，
属于发布前验证。见下一节。

### Node 版本：最低 22.19，CI 测 22 与 24

`package.json` 的 `engines.node` 是 **`>=22.19`** —— 这个下限由依赖链决定，
不是随手定的：

| 来源 | 要求 | 说明 |
|---|---|---|
| `pi-coding-agent`（被 GUI 驱动的那个 pi） | `>= 22.19.0` | 装 pi 本身的要求，也是这里的上限来源 |
| `pdfjs-dist` | `>=22.13.0 \|\| >=24` | **运行时依赖**，PDF 抽取用 |
| `electron` / `@electron/packager` 等 11 个 | `>= 22.12.0` | 开发依赖（打包链路） |

取其中最严的一条 ⇒ **22.19**。

CI 的 matrix 是 **22 与 24**：22 是这条下限所在的大版本，24 是当前最新
（也是开发机在用的版本）。不按 22.19 建 matrix —— 那只会多出一个几乎重复的
runner，而 22.x 内部的补丁差异不是这个项目要防的风险。

## 四、不进默认 CI 的测试

### D. 真 pi 验证

| 命令 | 要真 pi | 会发 prompt | 说明 |
|---|---|---|---|
| `npm run test:skills-live` | ✅ | ❌ | 拉起真 pi 用真 `get_commands` 对拍；启动 6 次 pi，约 2-3 分钟 |
| `npm run test:reliability-live` | ✅ | ❌ | 异步链路与状态审计的真机对拍 |
| `npm run test:inject` | ✅ | ⚠️ 会发一条 `ping` | 断言点在 provider 请求**之前**（扩展在 `before_agent_start` dump 系统提示词），但严格说仍可能产生一次极小的模型调用 |

**为什么不进 CI**：CI 里不装 `pi-coding-agent`（它是被 GUI 驱动的外部程序，
不是这个仓库的依赖）。装了也会让每次 push 多花几分钟，还会因为模型调用产生额度
消耗 —— 而这三条要验的是「pi 真的会那样应答」，属于**发布前 / 改动协议相关代码后**
才需要跑的验证。

### C. 安装程序

`test:portable` / `test:installer` 需要先 `npm run build:installer --zip`，
而 `build:installer` 需要 **NSIS 的 `makensis`**（本机是从 electron-builder 的缓存里
白捡的，见 `scripts/util.mjs` 的 `findMakensis()`）。GitHub 的 windows runner
不预装 NSIS，要现装。

因此它们放在**手动触发**的 `.github/workflows/release-check.yml` 里，
并且可以用输入项关掉（`installer: false`）。

`test:installer` 会真的安装、建快捷方式、启动一次、再卸载。runner 是一次性虚拟机，
所以这是安全的；但它比 CI 慢一个量级，不该挂在每次 push 上。

> ⚠️ 本机开发环境里 `reg.exe` 被安全策略拉黑，`test:installer` 有 5 条注册表断言
> 会被跳过（显示 `15/15 通过（5 条跳过）`）。GitHub runner 上没有这个限制。

### E. 界面视觉核对

jsdom **不做布局**（`getBoundingClientRect()` 恒为 0，也不套用外部样式表），
所以「排版对不对」在 `npm test` 里是测不出来的 —— 断言全绿也说明不了问题。

| 命令 | 用途 |
|---|---|
| `npm run harness` | 起视觉夹具（静态托管真 `public/`，`/api/*` 全换成脚本数据） |
| `npm run shots:harness` | 用无头 Chrome + CDP 截图 |
| `npm run test:window` | 窗口状态记忆（关掉再开，窗口不能每次变大一点） |

改了 `public/` 里的样式或布局之后，**必须真看一眼截图**，不能只看测试是不是绿的。

## 五、发布前验证

```
npm test                          # A 层
npm run build:app -- --rebuild    # 两条打包链路
npm run test:exe                  # 单文件 exe（47 项）
npm run test:app                  # Electron 应用目录（25 项）
npm run build:installer -- --zip  # 安装程序 + 便携版 + SHA256SUMS.txt
npm run test:portable             # 便携版 zip（11 项）
npm run test:installer            # 真装一遍再卸（20 项，本机 5 条跳过）
```

等价的手动入口：GitHub Actions 里跑 **Release check**（`workflow_dispatch`）。

发版还要做两条独立核实（附件摘要 + git ref），步骤见
[development.md](development.md) 的「发版流程」。

## 六、环境隔离（改测试时的硬要求）

测试跑在开发机上，所以**任何一处忘了隔离都会打到真实数据**。已经踩过的坑：

- 为了验证会话改名，对着用户真实项目跑了一次 `set_session_name` —— pi 往他的会话
  文件里追加了一行。**写盘的用例一律用 `os.tmpdir()` 的 fixture。**
- `tests/dev-server.cjs` 一度没设 `PI_GUI_DATA`，于是 `server.js` 把仓库根当数据目录、
  读到了开发机上的 `projects.json`，把上次的项目当初始 cwd，**真的拉起了一个 pi 会话**。
  现在它显式隔离，并且有一条守卫断言「工作目录为空」盯着这件事。
- `tests/planner.cjs` 一度断言「本机装了 pi」—— 见上一节，它让第一次 CI 直接红。

CI 上这些坑大多不会触发（干净检出里没有 `projects.json`、runner 上没装 pi），
但**「靠开发机的偶然状态碰巧不触发」不算隔离** —— 行为必须在任何机器上都一样。
上面第二条与第三条都是**被 CI 抓出来的**，不是靠 code review 看出来的。

## 七、已知风险

1. **部分测试套件硬编码端口**（`tests/*.cjs` 里的 `7791`–`7799`）。
   这些端口落在**某些机器**的 Windows 动态端口范围里 —— 默认动态范围是
   49152 起，但有些机器被改成从很低的端口开始，那就正好覆盖了 7791–7799。
   被别的进程当临时源端口占掉时 `listen` 会报 `EACCES`，表现为随机假红。
   GitHub 的 windows runner 用默认动态范围，所以 CI 上不会撞到；
   但本机如果出现 `EACCES`，需要把端口改成动态分配。
2. **`docs/testing.md` 里的断言数量会随测试增长而过时**。它们只是「这些套件确实
   在断言东西」的量级参考，不参与任何判断 —— 真实数字以 `npm test` 的输出为准。
   不要为同步它们引入脚本生成文档。

## 八、相关文档

- [architecture.md](architecture.md) — 模块地图与数据目录
- [development.md](development.md) — 构建与发版（`test:app` / `test:exe` /
  `test:portable` / `test:installer` 需要先构建）
- [sessions.md](sessions.md) / [planner.md](planner.md) /
  [extensions.md](extensions.md) — 各子系统末尾都列了自己的测试入口
- [security.md](security.md) — 安全守卫由哪些测试盯着
