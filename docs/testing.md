# 测试分层与 CI

这份文档回答一个问题：**改了代码之后，该跑哪些测试、在哪里跑。**
具体每条测试覆盖什么，README 的「测试」一节有更细的说明；这里只讲分层与边界。

## 一、总览

| 层 | 命令 | 需要什么 | 跑在哪 |
|---|---|---|---|
| **A. 基础测试** | `npm test` | 只要 Node ≥ 22.12 | 每次 push / PR（CI）+ 本地 |
| **B. 打包验证** | `npm run test:exe` / `test:app` | 先跑 `build:exe` / `build:app` | CI 的 build-check job |
| **C. 安装程序验证** | `npm run test:portable` / `test:installer` | 先跑 `build:installer`，且本机有 NSIS | 手动（release-check）或本地 |
| **D. 真 pi 验证** | `npm run test:skills-live` / `test:reliability-live` / `test:inject` | 本机装了 `pi` | 只在本地 / 手动 |
| **E. 界面视觉核对** | `npm run harness` + `shots` / `test:window` | 真浏览器 / 真窗口 | 只在本地 |

## 二、`npm test` 的定位

**`package.json` 的 `test` 脚本是测试入口的唯一真相。** CI 只调 `npm test`，
不把子测试抄进 workflow —— 抄一份就会有两个真相，以后加了新套件漏改一处，
就是「本地跑了、CI 没跑」的假绿。

`npm test` 里现在有 15 个套件，全部是**纯自动化**：

```
smoke 555 · git 151 · modules 114 · reliability · interactions · port-owner
project-config 115 · skills 182 · planner 111 · sessions 77 · body-integrity 5
dev-server 19 · models-api 50 · server-security 36 · electron-guard 50
```

它们的共同约束（新加测试时要守住）：

- **不联网。** 上游接口一律打桩（`models-api` 自己起一个假供应商）。
- **不 spawn 真 pi。** 需要 pi 的地方用桩 rpc，或者把 `PI_BIN` 指到不存在的命令。
- **不碰真实用户目录。** 数据目录、agent 目录、HOME 一律用 `os.tmpdir()`；
  写盘的用例（改 settings、会话改名/删除）**必须**走临时 fixture。
- **不需要模型额度。** 一条 prompt 都不发。
- **不需要显示器。** jsdom 跑前端，打包验证用 `node` 直接跑打包后的 `server.cjs`。

## 三、CI 里跑什么

`.github/workflows/ci.yml`，触发：push 到 main / PR 到 main / 手动。

| job | 内容 | 为什么存在 |
|---|---|---|
| `test` | `npm ci` → `npm test`（matrix：Node 22 与 24） | 守住 A 层 |
| `build-check` | `needs: test` → `build:app --rebuild` → `test:app` → `test:exe` | 守住 B 层：打包链路坏掉时，测试全绿也照样发不出去 |

`build-check` 刻意**不**跑 `build:installer` / `build:dist`：那要 NSIS 和 ~430MB 产物，
属于发布前验证。见下一节。

### Node 版本：为什么是 22 而不是 20

`package.json` 里写的是 `engines.node >= 20`，但**依赖树要求 ≥ 22.12**：

| 包 | 声明 | 类型 |
|---|---|---|
| `pdfjs-dist` | `>=22.13.0 \|\| >=24` | **运行时依赖** |
| `electron` / `@electron/packager` / `@electron/asar` 等 13 个 | `>= 22.12.0` | 开发依赖（打包链路） |

在 Node 20 上 `npm ci` 会刷 15 条 `EBADENGINE`，而 PDF 抽取用的 `pdfjs-dist`
明确声明不支持 20。所以 CI 取「依赖树真正的地板」**22**，再加一个最新版 **24**
（也是开发机在用的版本）。

`engines` 那行与实际不符是**已知问题**，改它会影响 npm 对使用者的提示行为，
所以没有在这次 CI 改造里动 —— 见「已知风险」。

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
npm run test:exe                  # 单文件 exe（45 项）
npm run test:app                  # Electron 应用目录（25 项）
npm run build:installer -- --zip  # 安装程序 + 便携版 + SHA256SUMS.txt
npm run test:portable             # 便携版 zip（11 项）
npm run test:installer            # 真装一遍再卸（20 项，本机 5 条跳过）
```

等价的手动入口：GitHub Actions 里跑 **Release check**（`workflow_dispatch`）。

发版还要做两条独立核实（附件摘要 + git ref），步骤见 README 的「从源码构建」一节
与 `.probe/release-notes-*.md` 的历史记录。

## 六、环境隔离（改测试时的硬要求）

测试跑在开发机上，所以**任何一处忘了隔离都会打到真实数据**。已经踩过的坑：

- 为了验证会话改名，对着用户真实项目跑了一次 `set_session_name` —— pi 往他的会话
  文件里追加了一行。**写盘的用例一律用 `os.tmpdir()` 的 fixture。**
- `tests/dev-server.cjs` 一度没设 `PI_GUI_DATA`，于是 `server.js` 把仓库根当数据目录、
  读到了开发机上的 `projects.json`，把上次的项目当初始 cwd，**真的拉起了一个 pi 会话**。
  现在它显式隔离，并且有一条守卫断言「工作目录为空」盯着这件事。

CI 上这些坑大多不会触发（干净检出里没有 `projects.json`），但**「靠一个未跟踪的本地
文件碰巧不触发」不算隔离** —— 行为必须在任何机器上都一样。

## 七、已知风险

1. **`engines.node` 与实际不符**：写的是 `>= 20`，依赖树要求 `>= 22.12`。
   CI 因此显式钉 22/24。要么把 `engines` 改成 `>=22.12`，要么把 `pdfjs-dist` 与
   Electron 工具链降到支持 20 的版本 —— 后者是产品变更，需要单独决策。
2. **部分测试套件硬编码端口**（`tests/*.cjs` 里的 `7791`–`7799`）。
   这些端口落在**某些机器**的 Windows 动态端口范围里（本机是 1024–15000），
   被别的进程当临时源端口占掉时 `listen` 会报 `EACCES`，表现为随机假红。
   GitHub 的 windows runner 用默认动态范围（49152 起），所以 CI 上不会撞到；
   但本机如果频繁出现 `EACCES`，需要把端口改成动态分配。
