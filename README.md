# Pi GUI

给 [pi](https://github.com/earendil-works/pi) 套一个本地桌面界面：选一个文件夹当项目，
在输入框里说要做什么，文件改动与命令执行实时显示在窗口里；改完哪些文件、
具体改了什么，在侧栏「文件变更」里看 diff，然后决定留着还是撤销。

后端是个纯 Node 的 HTTP 服务，前端是原生 JS（没有构建步骤、没有框架），
Electron 只负责装一个窗口 —— 不联网、不开浏览器，全部跑在本机。

## 前置条件

**本机要先装好 pi，并且 `pi` 在 PATH 里。** 这个仓库只是界面，不含 pi 本体：

```bash
npm i -g @earendil-works/pi-coding-agent   # 需要 Node >= 22.19.0
pi --version                                # 能打印版本就对了
```

pi 本身还要配好模型供应商（API Key 之类），否则界面能打开但发出去的消息会报错。
不在 PATH 的话可以用环境变量指定：`PI_BIN=C:\...\pi.exe`。

## 添加模型供应商

侧栏左下角的「模型供应商」可以往 pi 的 `~/.pi/agent/models.json` 里加自定义供应商
（Ollama、vLLM、LM Studio、各种中转站），不用手写 JSON。已有的配置不会被覆盖。

弹层里的「模型列表」可以手填，也可以点**「拉取」**直接从供应商的 `/models` 接口读。
拉取由后端代发（浏览器直连会撞 CORS），并且：

- 按 API 类型自动选对路径和鉴权头（`openai-completions` / `anthropic-messages` / `google-generative-ai`）
- 失败时**逐级回退路径段**重试，所以 base 填成厂商的兼容子路径
  （比如 `https://api.deepseek.com/anthropic`）也能找到真正的模型列表
- 尽量把能力参数一起带回来：上下文长度、输出上限、是否支持推理、能不能收图

**能带回多少取决于供应商的接口**。OpenRouter 和 Google 回得比较全；
OpenAI / DeepSeek / Anthropic 的 `/models` 基本只有一个 id，那就只填 id。

模型列表每行一个：

```
deepseek-chat
qwen3-max|Qwen3 Max
anthropic/claude-sonnet-4|Claude Sonnet 4|contextWindow=200000|maxTokens=64000|reasoning=true|input=text,image
```

`id` 之后是显示名，再往后都是 `key=value` 参数（`ctx` / `max` 是
`contextWindow` / `maxTokens` 的简写）。参数必须带 `=` ——
否则没法区分那到底是显示名还是一个开关。

API Key 可以填字面量或 `$ENV_VAR`。**拉取功能不会执行 `!command` 形式的 key**
（那等于给一个网页界面开了任意命令执行）；这种 key 手填模型列表仍然可用。

## 下载安装

从 Releases 里挑一个：

| 文件 | 说明 |
| --- | --- |
| `Pi-GUI-Setup-<版本>.exe` | 安装程序。约 100 MB，装完建好开始菜单和桌面快捷方式 |
| `Pi-GUI-<版本>-portable.zip` | 便携版。解压后直接跑 `Pi GUI.exe`，不用装 |

安装程序是**单用户**的：装在 `%LOCALAPPDATA%\Programs\Pi GUI`，不弹 UAC、不写系统目录。
卸载走「添加或删除程序」，只删程序文件 —— `%APPDATA%\pi-gui` 下的项目列表和窗口布局会保留，重装接着用。

下载后建议核一下 `SHA256SUMS.txt`：

```powershell
certutil -hashfile Pi-GUI-Setup-0.2.0.exe SHA256
```

## 从源码跑

```bash
npm install
npm start          # 只跑后端，用浏览器开 http://127.0.0.1:7788
npm run app        # 桌面窗口（Electron 会自己拉起一份后端，不用先 npm start）
```

改前端时用 `npm start` 更快（改完刷新页面即可）；`npm run app` 每次都要重启进程。

## 本地访问与安全边界

后端能驱动 pi 执行任意命令，所以它的边界是唯一防线。三条约束：

**1. 只监听回环。** 显式 `listen(PORT, '127.0.0.1')`，不依赖 Node 的默认行为，
也不用 `0.0.0.0`。日志里只出现 `http://127.0.0.1:<PORT>`。

**2. 应用级身份握手。** 端口上「有人在听」不等于「这是我们的后端」。Electron 启动时
会探一次 `GET /api/health`，按返回的 `app` / `protocol` 判成三种状态：

| 状态 | 含义 | 处理 |
| --- | --- | --- |
| `not-running` | 端口空着 | 自己拉起后端 |
| `pi-gui` | 是本应用的后端 | 复用（先验令牌能不能用） |
| `foreign-service` | 端口被别的程序占了 | **直接报错退出，绝不把窗口指过去** |

第三种情况会明确提示「端口 7788 已被其他程序占用，请关闭占用程序或通过 PORT 环境变量
修改 Pi GUI 端口」，而不是加载一个陌生程序的页面 —— 后者只会让用户对着一片
「界面不对 + 所有接口 404」发愣。

**3. 本地令牌。** Electron 每次启动现生成一个 32 字节随机令牌，经环境变量
`PI_GUI_TOKEN` 交给后端；后端据此要求所有 `/api/*` 带
`Authorization: Bearer <token>` 或 `X-Pi-Gui-Token`（`/api/health` 除外，它要用来认亲）。
令牌由 Electron 的 `onBeforeSendHeaders` 统一注入，**从不进入渲染进程**，
也不打印、不写进 URL、不落盘。请求还会校验 `Origin`：非本机同源一律 403。

不带 `PI_GUI_TOKEN` 启动（即 `npm start`）就是**开发模式**：不做令牌校验，
但来源校验仍然生效。这个模式仅供本机开发。

## Markdown 渲染

对话里 Agent 返回的 Markdown 一律**当作不可信输入**。渲染器（`public/markdown.js`）
的做法是「先整体转义，再插入自己生成的白名单标签」—— 也就是说，进入 HTML 的尖括号
只可能来自渲染器本身。这样 XSS 不是「被过滤掉了」，而是在语法层面就不成立：
不需要维护黑名单，也就不存在「漏掉某个向量」的问题。

具体约束：

- 不渲染原始 HTML（原文里的 `<div>` 会变成 `&lt;div&gt;`）
- 链接走 scheme 白名单（只放行 `http` / `https` / `mailto` 与相对路径），
  `javascript:` / `data:` / `vbscript:` / `file:` 一律退化成纯文本
- 从不生成 `on*` 事件属性
- 不渲染远程图片（避免把用户的 IP 暴露给模型随手写的一个地址）

支持范围：段落、标题、有序 / 无序 / 嵌套 / 任务列表、引用、表格（带对齐）、
分隔线、围栏代码块（带语言标签，`diff` 额外逐行着色）、行内代码 / 粗体 / 斜体 /
删除线 / 链接。

**为什么不用 markdown-it 之类的成熟库**：本项目零构建、零前端依赖，引入它要额外随包
分发两个 UMD 文件（含 Apache-2.0 的署名义务），而上面这套结构性防护已经把主要收益
拿到了。渲染完整度上的差距，用增量补齐更划算。

## 文件变更与撤销

侧栏的「文件变更」列出**当前 Git 工作区**里相对 HEAD 有差异的文件：
`M` 修改 / `A` 新增 / `D` 删除 / `R` 重命名 / `C` 复制 / `U` 冲突 / `??` 未跟踪，
外加相对路径和 `+N −M` 行数。点一行就地展开 unified diff，可以「打开」或「撤销」。

Agent 执行 `write` / `edit` / `bash` 之后会自动刷新（防抖 450ms，连续改多个文件
只查一次 `git status`），也可以手动点「刷新」。

**这一版刻意不做的事**：不内置代码编辑器（「打开」交给系统默认程序）、
不做 side-by-side、不做合并冲突编辑、不做 commit / push / branch 管理。
定位是「看清改了什么、决定留还是撤」，不是 IDE。

### 看 diff

- **按 hunk 折叠。** 每个 hunk 有一条可点击的标题栏（带该块的 `+N −M`），
  点一下折叠这一块；工具条上的按钮一键「展开全部块 / 折叠全部块」。
- **上下文可调。** 默认跟随你的 `diff.context` 配置（通常是 3 行），
  也可以切到「20 行」或「全部」。切换会**重新问后端** —— diff 正文是 git 按 `-U`
  现算的，前端没法从已截断的文本里补出被裁掉的上下文行。
- **暂存区与工作区分开显示。** `MM` 这种「既暂存又改了」的文件会给出两段，
  否则看不出到底在跟谁比。
- **有大小上限**（默认 512 KB，`PI_GUI_GIT_DIFF_MAX_BYTES` 可调），超了就截断并提示；
  二进制文件直接说明「看不了文本差异」，不会塞一堆乱码进界面。

### 只看 Agent 改的

列表上方有「全部 / 仅本次会话」两个视角。「本次会话」是 `write` / `edit`
这两个工具碰过的文件（`bash` 改的东西推导不出来，所以不在内），
行上会带一个「本会话」小标记。

**侧栏徽标永远是 Git 的总数**，不受这个视角影响 —— 徽标回答的是
「磁盘上有多少没提交的东西」，那是客观数字，不该被视角改变。

### 撤销

| 文件状态 | 行为 |
|---|---|
| 工作区 `M` / `D` | `git restore -- <path>` |
| 未跟踪 `??` | 删除该文件。确认框明写「撤销将删除该文件」，按钮也是「删除文件」 |
| 已暂存 `M ` / `MM` | 拒绝；点「取消暂存并撤销」才先 `git restore --staged` 再恢复 |
| 已暂存的新增 `A ` | 取消暂存后它会变成未跟踪文件，所以**在动 index 之前**就把「会删掉它」问清楚 |
| 重命名 / 复制 `R` / `C` | 拒绝（只恢复一条腿会让文件处于半吊子状态） |
| 冲突 `U` | 拒绝，请用 git 手动解决 |

「全部撤销」是**两段式**：先干跑拿后端算出的权威计划（恢复几个 / 取消暂存几个 /
删几个），摊给你看清楚再执行。有未跟踪文件时会多给一条路径
「仅撤销已跟踪文件」，因为「撤销改动」和「删掉新文件」是两个不同的意愿。
一次最多处理 200 个文件（`PI_GUI_GIT_RESTORE_ALL_MAX` 可调），
超了就整体拒绝而不是撤销到一半停住。

几条设计上的取舍：

- **以 Git 为准。** 界面上的数字来自 `git status`，不是「Agent 声称改过什么」。
  两者会不一致（Agent 改了又自己撤回、或者你手动 revert 过），这时以后者为准。
- **不是 Git 仓库不是错误。** Pi GUI 允许打开普通文件夹，那种情况下聊天、改代码、
  跑命令全部照常，只是没有变更信息 —— 界面给一句中性说明，不弹错、不自动 `git init`。
- **两条写权限默认关闭。** 删未跟踪文件（`deleteUntracked`）和取消暂存（`unstage`）
  都必须由用户明确授权才生效。没有授权时后端一个字都不动，而是把「还需要什么授权」
  原样返回给界面 —— 所以不存在「静默改了 index」这种状态。
- **批量撤销逐条走同一条动作路径**，不用 `git checkout .` / `git reset --hard` /
  `git clean -fd`。于是「哪些文件不该被自动撤销」只有一处答案。
  这几条禁令有自动化守卫盯着（见 `tests/git.cjs` 第 15 段）。

所有 Git 命令都指定项目目录、走参数数组、`shell: false`，路径经
`lib/safe-path.js` 校验（`../`、绝对路径、符号链接 / junction 逃逸一律拒绝），
并带超时与输出字节上限。

## 从源码构建

```bash
npm run build:dist      # 应用目录 + 安装程序 + 便携版 → dist-installer/
```

改了 `server.js` 或 `public/` 之后要加 `--rebuild`，否则后端产物 `build/server.cjs` 会被复用，
改动不会进包：

```bash
npm run build:app -- --rebuild
```

## 测试

```bash
npm test                # 前端冒烟 + Git 变更 + 消息体完整性 + 后端接口 + 模型拉取 + 访问控制 + Electron 安全边界
npm run test:ui         # 前端冒烟（jsdom 里跑真模块图，含 Markdown 安全、变更面板、diff 渲染）
npm run test:git        # Git 变更：临时仓库里跑真实的 M/A/D/R/??/中文/空格/二进制、路径越权、
                        #   取消暂存、撤销全部、diff 上下文，外加写路径的静态守卫
npm run test:models     # 单跑模型拉取：桩上游 + 三种 API 形态 + 路径回退 + key 不泄露
npm run test:security   # 后端访问控制：令牌认证、来源校验、只监听回环、密钥不进日志
npm run test:guard      # Electron 侧判定：陌生服务不复用、外部 URL 不导航、preload 桥的形状
npm run test:app        # 打包后的应用目录（抽取、静态资源、无项目时的行为）
npm run test:exe        # 单文件 exe
npm run test:portable   # 便携版 zip：解压 → 直接跑 → 页面能开
npm run test:installer  # 真装一遍 → 启动 → 卸一遍（会写注册表、建快捷方式，测完卸掉）
```

`test:git` 全程在 `os.tmpdir()` 下新建临时仓库，**不会碰你自己的仓库** ——
这个套件里有真的会删文件的用例，所以这一点是硬要求。

后三条要先把 `npm run build:dist` 跑过一遍。

## 目录说明

- `server.js` — 后端。转发 pi 的 RPC、静态资源、附件抽取、Git 变更接口、访问控制
- `lib/git.js` — Git 状态 / diff / 撤销。默认只读；写操作只有「撤销单个文件」
  与「撤销全部」，且两条权限闸门（删未跟踪文件、取消暂存）默认关闭
- `lib/safe-path.js` — 项目内路径校验，被 diff / 打开 / 撤销三条链路共用
- `lib/models-api.js` — 从供应商 `/models` 拉模型列表（路径回退、按 API 类型适配）
- `public/` — 前端。原生 ES Module，`app.js` 只做装配，其余按职责分模块
  （`api.js` 网络、`state.js` 状态、`markdown.js` 渲染、`git.js` 变更面板、
  `diff.js` unified diff 渲染、`changes.js` 会话改动账本、`ui/` 通用组件……），无构建步骤
- `electron/main.cjs` — Electron 主进程，拉起内嵌后端、管窗口与导航
- `electron/preload.cjs` — 渲染进程与主进程之间唯一的桥（只暴露「用系统默认程序打开文件」）
- `electron/net-probe.cjs` — 端口探测与 URL 判定（纯逻辑，不依赖 electron，因此可单测）
- `installer/pi-gui.nsi` — 安装程序脚本（用 NSIS 编）
- `scripts/` — 构建脚本；`scripts/util.mjs` 是几个脚本共用的小工具
- `tests/` — 上面那几组测试

`dist-installer/` 不进仓库（上百 MB 的二进制）。要分发就传到 GitHub Release 的附件里。

## 许可证

本项目是 [MIT](LICENSE)。

打包出去的安装程序 / 便携版里还内嵌了这些第三方组件，各自的许可证随包附在
`resources/app/THIRD-PARTY-NOTICES.txt`：

| 组件 | 许可证 | 说明 |
| --- | --- | --- |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | Apache-2.0 | PDF 文本抽取，会打进包里 |
| [Electron](https://github.com/electron/electron) | MIT | 桌面窗口运行时 |
| [esbuild](https://github.com/evanw/esbuild) | MIT | 只在构建期用 |

**界面本身不含 pi 的代码** —— 它是通过 RPC 调用你本机安装的 pi（pi 是 MIT）。
