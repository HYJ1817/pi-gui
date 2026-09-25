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

## 工具执行时间线

Agent 的工具调用渲染成**嵌在对话流里的连续时间线**，而不是一张张彼此孤立的卡片：

```
操作 3 项
  ✓ 读取文件   src/app.js                    0.3s   128 行
  ✗ 执行命令   npm test                      12.4s  exit code 1
  ✓ 修改文件   src/util.js                   0.1s   +12 −3
```

每条给出语义名、关键参数（命令原文 / 文件路径 / 搜索词）、状态、时长、
一行最有价值的结果，以及 Git 报的 `+N −M`。点一下展开完整输出与原始参数。

**实时和历史走同一条渲染路径。** 刷新页面之后工具执行从 `get_messages` 重建：
`assistant.content[]` 里的 `toolCall` 与独立成条的 `toolResult` 按 `toolCallId` 配对，
配对结果先归一成同一个中间结构（`public/tool-model.js` 的 `ToolEntry`），
视图只认这个结构。所以「刷新前后语义一致」不是靠对齐两套代码维持的，
而是因为压根只有一套。

几种退化情况都有明确归宿，**都不允许静默消失**：

| 情况 | 呈现 |
|---|---|
| 有 `toolCall` 没有 `toolResult`（中断 / 崩溃 / 会话被切走） | 「未完成」，虚线圆圈图标 |
| 有 `toolResult` 没有 `toolCall`（孤儿） | 在它自己的位置降级成一条，不吞掉 |
| 未知工具（扩展注册的 / 以后新加的） | 「执行工具 + 原始名字」，不报错 |
| `agent_settled` 时还有条目在 running | 收成「未完成」，不让它永远转下去 |
| 只有 `toolCall` 的助手消息 | 整条外壳（含「Pi」角色行）收掉，不留空白 |

几条协议上的事实，都是实测出来的，代码里没有一处靠猜：

- `tool_execution_update.partialResult` 是**累积值**不是增量，所以整体替换；
  但空文本不覆盖已有内容（`bash` 的 `onUpdate` 会先发一次空的）。
- `tool_execution_end` **不保证带 `toolName` / `args`**，工具名与参数在 `start` 时存下来。
- 协议里**没有结构化的退出码**（`bash` 的 `details` 只有 `truncation` / `fullOutputPath`），
  只能从输出文本里解析 pi 自己拼的那句 `Command exited with code N`；解析不到就不显示，
  绝不按 `isError` 猜一个数字。
- `edit` 的 `details.diff` 是工具当场给的**单次**改动量，只作兜底；
  文件级的权威 `+N −M` 由 `git status` 给，刷新回来后覆盖（见下一节）。
- 输出默认折叠，长命令不会把对话撑成一片墙。折叠按钮、悬停提示都跟着状态走。

安全上，工具的一切内容都是不可信输入（命令来自模型，输出来自被执行的程序）。
`public/tool-view.js` **一次 `innerHTML` 都不用**（除自己写死的 SVG 图标常量），
所有文本走 `textContent` —— 于是「记得转义」这件事不需要被记住。

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

## 项目配置

每个项目可以有自己的偏好：默认模型、思考强度、项目指令、忽略规则、常用命令。
切换项目时自动恢复，重开应用也还在。入口在左侧栏「项目分组」标题右边的
**项目设置**。

### 保存在哪

```
<项目目录>/.pi-gui/config.json
```

放在项目里而不是全局数据目录，是因为「配置跟项目走」：把项目目录改名或移动，
配置跟着走；换台机器把项目拷过去，偏好也在。反过来说，全局目录按**绝对路径**
索引项目的话，路径一变配置就等于丢了。

`.pi-gui/` 与 Git 无关 —— 不是 Git 仓库的普通文件夹照样有项目配置，
配置也不会写进 `.git/`。要不要提交由你决定。

### 支持的字段

```json
{
  "version": 1,
  "model": { "provider": "deepseek", "id": "deepseek-v4-pro" },
  "thinking": "high",
  "instructions": "这个项目用 TypeScript\n不要改 generated/",
  "ignore": ["node_modules", "dist"],
  "commands": [{ "name": "测试", "command": "npm test" }]
}
```

| 字段 | 说明 | 上限 |
|---|---|---|
| `version` | 配置格式版本。由后端写，客户端指定不了 | 当前 `1` |
| `model` | 默认模型。**只存 `provider` + `id` 两个键** | — |
| `thinking` | 思考档位。取值就是 pi 的合法档位：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` | — |
| `instructions` | 项目指令，纯文本 | 32 KB |
| `ignore` | 忽略规则，每行一条 | 200 条，单条 300 字 |
| `commands` | 常用命令 | 50 条，名称 60 字、命令 500 字 |

写入时只认这几个字段，其余一律丢弃并给出提示。字段类型不对、超出上限的项
会被忽略或截断（同样有提示），**不会**因为配置写坏就让项目打不开。

### 优先级

从高到低：

1. **环境变量** —— `PI_PROVIDER` / `PI_MODEL` / `PI_THINKING` 显式钉住的值。
   项目配置遇到它们直接让位，界面上会说明「环境变量已固定模型」。
2. **项目配置** —— 本文件。
3. **当前会话** —— 在界面上临时切的模型 / 档位。
4. **pi 的默认值**。

本轮**没有**改变环境变量原有的语义，只是把项目配置插在它下面。

### 切项目时怎么生效

切换项目本来就是「用新的工作目录重启 pi」，项目配置直接搭在这条生命周期上，
不会出现「先按旧配置启动 → 再改 → 再重启一次」：

```
切换项目 → 后端更新 cwd → 读该项目配置 → 算出启动参数 → 启动 pi → 前端回读生效值
```

- **思考强度与项目指令走启动参数**，所以在 pi 起来之前就定了，切过去就是对的。
- **模型不走启动参数**。原因是实测出来的：pi 在非交互模式（含 `--mode rpc`）下，
  任何 error 级启动诊断都会直接 `process.exit(1)`，而「供应商不存在」正是 error 级。
  真把模型当启动参数传，一旦那个引用过期，pi 就会退出 → 桥接每 1.2 秒重启一次 →
  项目彻底打不开。所以模型改成：pi 起来后先跟 `get_available_models` 核对，
  还在就用 RPC 的 `set_model` 落下去 —— 这条路失败只是回一个 `success:false`，
  不退出、不动当前模型。
- **模型失效时安静降级**：沿用当前模型，并给一次轻提示（同一个项目里的同一个失效模型
  只提示一次，不会每次重启都弹）。项目照常打开。

### 项目指令是怎么注入的

`instructions` 不是拼进每条用户消息的（那会污染历史、重复吃 token，而且你在界面上
看不到真实的 prompt），而是落成项目里的 `instructions.generated.md`，
通过 pi 官方的 `--append-system-prompt <文件>` 追加到系统提示词末尾。
清空指令时这个产物会被删掉。

追加的位置是 pi 系统提示词里的 `<addendum>` 段（在 `<docs>` 之后、`<skills>` 之前），
原有内容一个字都不动。这一点有运行时证据：`npm run test:inject` 会挂一个扩展，
在 `before_agent_start`（provider 请求之前）把组装好的系统提示词 dump 出来，
对比「带参数」与「不带参数」两次 —— 指令文本只出现在前者里。

### 忽略规则与常用命令：只保存，不执行

这两项本轮**只保存、只展示**：

- `ignore` 没有接进 Git / 文件树 / pi —— 目前没有任何一处会消费它。
- `commands` 界面上没有运行按钮。现有唯一的执行通道是 pi 的 bash 命令，
  用它跑配置里的命令会把这行命令和输出写进会话记录，等于替用户污染对话。
  没有自然的执行通道就先不做，而不是加一个绕过会话的快捷执行。

### 敏感信息

**不会保存任何密钥。** `API Key`、`PI_GUI_TOKEN`、供应商密钥、其他 secret
一个都不进这个文件 —— 字段白名单里根本没有这些名字，模型只存 `provider` + `id`
两个键，测试里也钉住了「配置文件里不出现 `apiKey` 这个键」。
密钥仍然只存在 `~/.pi/agent/models.json` 和进程环境变量里。

### 配置文件坏了怎么办

不会阻止你打开项目。读不出来（文件不存在 / 空文件 / 不是合法 JSON / 版本不认识 /
权限不足）就按默认值处理，并在「项目设置」里把原因写出来。

**损坏的文件不会被自动覆盖** —— 只有你在界面上点了「保存」，才会被新内容替换。
所以想手工抢救的话，内容还在原处。

写入是原子的：先写同目录的临时文件再 `rename`，中途断电不会留下半个文件。
写失败会明确报错，不会假装保存成功（弹层留着，输入不丢）。

### 恢复默认

「项目设置」里的**恢复默认**只把表单填回默认值，点了「保存」才真正写盘 ——
误点的代价太大，多一步确认。

## 扩展（Skills / MCP）

侧栏的**扩展**是 Skills 与 MCP 两个标签页。它管的是**你已经装好的**能力，
不是商店 —— 没有下载、没有安装、没有远程代码执行。

### Skills

Skill 是 pi 的原生能力（实现的是 Agent Skills 标准）。Pi GUI 只做发现、查看、
启停三件事，**不发明任何 pi 不认识的概念**。

**从哪发现**（与 pi 的 `addAutoDiscoveredResources` 一致）：

| 位置 | 作用域 | 生效条件 |
| --- | --- | --- |
| `~/.pi/agent/skills` | 用户 | 总是 |
| `~/.agents/skills` | 用户 | 总是 |
| `<项目>/.pi/skills` | 项目 | 项目被信任时 |
| `<项目>` 及祖先的 `.agents/skills` | 项目 | 项目被信任时 |

另外 `settings.json` 的 `skills` 数组里的普通路径条目、package、以及命令行的
`--skill <路径>` 也是来源。`PI_CODING_AGENT_DIR` 可以改掉 agent 目录的位置。

两种目录的收集规则**不完全一样**，这是 pi 的行为，照搬：`.pi/skills` 里
**根级的 `.md` 也算一个 skill**；`.agents/skills` 里**只认子目录**（根级 `.md` 会被忽略）。
两者都是「目录里直接有 `SKILL.md` 就把它当成一个 skill，不再往里递归」，并跳过
点开头的条目与 `node_modules`。

**同名冲突：项目级胜出**。这一点和直觉相反（容易以为用户级覆盖项目级）。
pi 的优先级排序把 project 排在 user 前面，而加载是「先到者胜」。
被抢先的那条在界面上标成**被覆盖**，并显示是谁占了它 —— 不会两条都显示「已启用」。

**启停**用的是 pi 官方的 override 机制，写在 `settings.json` 的 `skills` 数组里：

```json
{ "skills": ["-skills/code-review/SKILL.md", "!*experimental*"] }
```

- `-<路径>` 精确停用，`!<glob>` 按模式停用，`+<路径>` 强制包含（`-` 优先级最高）。
- 模式匹配的是**相对发现基准目录的 posix 路径**，所以**一定带 `skills/` 前缀**。
  `-code-review` 这种裸名字**不生效** —— 这是最容易踩的坑。
- **作用域必须配对**：用户级 skill 只吃全局 `settings.json`，
  项目级 skill 只吃 `<项目>/.pi/settings.json`。用全局设置关不掉项目级 skill。

界面上的开关只增删**它自己写的那一条** `-` 模式，保留文件里的一切其它字段和
你手写的通配。如果还有别的模式也在关着它，会明确告诉你「只删掉这条不会生效」。

**改完必须重启 pi**。pi 只在启动时读 `settings.json`，没有文件监听 ——
所以保存后 Pi GUI 会直接重启 pi，不需要你去猜为什么没生效。
反过来，纯查看、搜索、筛选这类操作不会触发重启。

**为什么有些项目级 Skill 是灰的**：Pi GUI 用 `pi --mode rpc` 驱动 pi，
这是非交互模式、没有 UI，pi 的项目信任判定会落到 `defaultProjectTrust: "ask"`
的「无 UI」分支 —— 结果是**项目级资源默认不加载**。界面上会标成「项目未被信任」
并说明原因。要让它生效，用 `pi --approve` 启动一次，或在 `~/.pi/agent/trust.json`
里记下这个项目，或把 `defaultProjectTrust` 设成 `always`。

**正文只读**。要看 `SKILL.md` 就点「打开文件」交给系统编辑器 —— 第一版不内置
文本编辑器，避免两边同时写同一个文件。

### MCP

**pi 没有内置 MCP，而且是有意为之。** `docs/usage.md` 原文：

> It intentionally does not include built-in MCP, sub-agents, permission popups,
> plan mode, to-dos, or background bash. You can build or install those workflows
> as extensions or packages, or use external tools such as containers and tmux.

pi 包里没有任何 MCP 模块，也没有 `mcpServers` / `.mcp.json` 这类配置约定。

所以 MCP 标签页**不是**一个 Server 列表 —— 它是一份能力报告：

- 读你本机真正装着的那个 pi 包，报出版本号、**它到底支不支持 MCP**，
  以及支撑这个结论的**原文出处**（可自己核对）。
- 检测不出来时如实说「无法确定」，**不猜成不支持**。
- 列出 pi 官方给的替代路径：`~/.pi/agent/extensions` 与 `<项目>/.pi/extensions`
  下已有哪些扩展，以及 `settings.json` 里声明的 `extensions` / `packages`。

Pi GUI 在这件事上刻意**不做**三件事，做了就是撒谎：

1. 不假装有 Server 可以增删改（没有配置文件可读，就没有 Server）；
2. 不在 `.pi-gui/` 里自己存一份 MCP 配置 —— pi 不会读它，那是个假开关；
3. 不显示「已配置 / 已连接」这种没有数据支撑的状态。

**扩展目录只列名字、类型、大小、时间，不读内容、不执行。** 所以哪怕扩展文件里
写着密钥，它也不会出现在接口响应里。

### 边界

- 不联网、不下载、不安装任何东西；没有 Skill / MCP 商店。
- 不接受客户端传路径：前端只拿得到 skill 的稳定 ID（路径的哈希前缀），
  真实路径由后端在自己的索引里查。读文件前还会再校验一次「确实落在已知发现根之下」。
- 写 `settings.json` 走 `读 → 合并 → 校验 → 原子写`，保留一切未知字段。
  文件坏了或 `skills` 不是数组时返回 409 并**一字不改**，让你自己修。
- 一条 skill 坏了（缺 `description`、读不出来、frontmatter 不合法）只影响它自己，
  在它那一行就地报错 —— 不会让整页打不开。

### 哪些能力依赖 pi 版本

发现规则、启停语法、信任判定都跟着 pi 的实现走。如果将来的 pi 改了目录约定或
override 语义，需要同步更新 `server/skills.js`（它里面每一条规则都注明了源码出处）。
MCP 部分不硬编码版本结论 —— 它会去读你装的 pi 包，所以 pi 真加了 MCP 支持时，
报告会自动从「没有原生支持」变成「检测到 MCP 模块，但 Pi GUI 还没适配」。

## 从源码构建

```bash
npm run build:dist      # 应用目录 + 安装程序 + 便携版 → dist-installer/
```

改了 `server.js` 或 `public/` 之后要加 `--rebuild`，否则后端产物 `build/server.cjs` 会被复用，
改动不会进包：

```bash
npm run build:app -- --rebuild
```

`--rebuild` 影响的是后端产物；前端 `public/` 每次构建都会重新拷进包里。

打包那一步默认会去 GitHub 取 Electron 发行包（顺带取一份 `SHASUMS256.txt` 校验）。
网络不通时，即使 zip 已经在本机 Electron 缓存里，它也会因为拿不到校验和而判定
「缓存不匹配」、退回重新下载，最后整个构建挂掉。要离线构建就显式指一下本机缓存：

```bash
PI_GUI_ELECTRON_ZIP_DIR="$LOCALAPPDATA/electron/Cache/<hash>" npm run build:app
```

（`<hash>` 是缓存目录名，按 URL 的 sha256 算出来，不同版本不一样，进去看一眼就知道。
这条路跳过校验和，只在本机缓存可信时用。）

## 测试

```bash
npm test                # 前端冒烟 + Git 变更 + 后端模块单测 + 项目配置 + Skills/MCP + 消息体完整性 + 后端接口 + 模型拉取 + 访问控制 + Electron 安全边界
npm run test:ui         # 前端冒烟（jsdom 里跑真模块图，含 Markdown 安全、工具时间线、
                        #   变更面板、diff 渲染；工具时间线那一段还会用
                        #   tests/fixtures/ 里的真实会话 fixture 重建一遍）
npm run test:git        # Git 变更：临时仓库里跑真实的 M/A/D/R/??/中文/空格/二进制、路径越权、
                        #   取消暂存、撤销全部、diff 上下文，外加写路径的静态守卫
npm run test:modules    # 后端各模块的纯单测：auth 判定顺序、SSE 的 _seq/backlog、
                        #   路由分发顺序与静态资源、rpc-bridge 的参数拼装与错误路径，
                        #   外加「模块之间不许成环」的依赖方向检查。不起服务、不 spawn 进程
npm run test:config     # 项目配置：无项目 / 无配置文件 / 默认值 / 原子写 / 非法 JSON /
                        #   未知字段 / 类型错 / 超长截断 / 指令注入载体 / 重启判定 /
                        #   路径不可由客户端指定 / 密钥不进配置 / 真跑一次 esbuild 查产物指纹。
                        #   全程在 os.tmpdir() 里造临时项目，不碰真实项目
npm run test:models     # 单跑模型拉取：桩上游 + 三种 API 形态 + 路径回退 + key 不泄露
npm run test:skills     # Skills / MCP：发现规则（两种 collect 模式）、同名冲突、信任判定、
                        #   状态判定（enabled/disabled/untrusted/invalid/shadowed/not-loaded/
                        #   unknown）、详情与路径逃逸、启停写盘（保留未知字段 / 原子写 /
                        #   409 不动坏文件）、真实 router 的令牌与 Origin、MCP 能力报告与
                        #   密钥不外泄。全程在 os.tmpdir() 里造世界，不 spawn 进程、不联网
npm run test:skills-live # 【要真 pi，约 2-3 分钟】拉起真的 pi 子进程，用真的 get_commands
                        #   对拍：项目级默认不加载 / --approve 才加载、同名冲突项目胜出、
                        #   停用语法（带 skills/ 前缀有效、裸名字无效、glob 有效）、
                        #   改 settings 不热加载必须重启、enableSkillCommands=false 时
                        #   get_commands 仍返回、--no-skills。不在 npm test 链里
npm run test:security   # 后端访问控制：令牌认证、来源校验、只监听回环、密钥不进日志
npm run test:guard      # Electron 侧判定：陌生服务不复用、外部 URL 不导航、preload 桥的形状
npm run test:app        # 打包后的应用目录（抽取、静态资源、无项目时的行为）
npm run test:exe        # 单文件 exe（含打包后项目配置与扩展接口的读写闭环）
npm run test:inject     # 项目指令真的进了系统提示词吗：拉起真 pi，挂扩展在
                        #   before_agent_start dump 组装后的提示词，带/不带参数对照。
                        #   顺带钉住「假 provider 会让 pi exit(1)」这条设计前提
npm run test:portable   # 便携版 zip：解压 → 直接跑 → 页面能开
npm run test:installer  # 真装一遍 → 启动 → 卸一遍（会写注册表、建快捷方式，测完卸掉）
```

`test:git` 全程在 `os.tmpdir()` 下新建临时仓库，**不会碰你自己的仓库** ——
这个套件里有真的会删文件的用例，所以这一点是硬要求。

后三条要先把 `npm run build:dist` 跑过一遍。

## 目录说明

- `server.js` — 后端**装配层**。只做：读环境变量、建共享运行态、按依赖顺序组装各模块、
  创建 HTTP server、启动 pi 桥接、listen、管生命周期。具体业务在 `server/` 下
- `server/` — 后端各职责模块。全部由 `server.js` 装配，模块之间不互相 import
  （唯一例外是 `git-routes` 调 `lib/git.js`），依赖方向永远是 `server.js → 模块`：
  - `auth.js` — 访问控制（令牌 + Origin）与身份探测端点。令牌定长比较，错误信息不回显收到的值
  - `rpc-bridge.js` — pi 子进程：spawn / stdout JSONL 解析（**只按 LF 切分**）/
    stdin 写入 / 崩溃重启。**令牌在这里从 pi 的环境里摘掉**
  - `sse.js` — 事件总线：clients / backlog / `_seq`。断线重连靠 `_seq` 去重
  - `projects.js` — 项目列表、目录浏览、切换项目
  - `project-config.js` — 项目偏好（`<项目>/.pi-gui/config.json`）的读取 / 校验 /
    归一化 / 原子写入 / 默认值，以及「给 pi 的启动参数」。**不存任何密钥**。
    唯一对外暴露的项目来源是 `runtime.getCurrentCwd()` —— 接口不接受客户端传路径
  - `providers.js` — `~/.pi/agent/models.json` 的读写、供应商 CRUD、模型拉取
  - `skills.js` — Skill 的发现 / 详情 / 启停。**移植 pi 自己的规则**（发现位置、
    两种 collect 模式、同名优先级、信任闸门、override 语法），每条都注明源码出处。
    「pi 实际加载了哪些」以 RPC `get_commands` 为准，**按 `sourceInfo.path` 配对**
    （只按名字会让被抢先的那条也显示已启用）。前端只拿得到路径哈希当 ID，
    拿不到也传不了绝对路径。写盘是读-合并-校验-原子写，只增删自己那条 `-` 模式
  - `mcp.js` — MCP **能力报告**（不是 MCP 管理器）。pi 没有原生 MCP，所以这里不列
    Server，而是去读本机装的 pi 包、给出「支不支持」的结论与原文证据，并列出
    官方替代路径 extension 下已有哪些东西。**只读名字，不读内容、不执行**
  - `uploads.js` — 附件上传与落盘
  - `git-routes.js` — Git 接口的 **HTTP 适配层**，业务逻辑全在 `lib/git.js`
  - `router.js` — 路由表与静态资源。**顺序即语义**，几处「必须排在前面」的注释都是踩过的坑
  - `runtime.js` — 共享运行态（`currentCwd` / `shuttingDown`）的**唯一权威**。
    拆模块最容易出的问题是 cwd 漂移，所以这两个变量只在这里存一份
  - `http-utils.js` — `json` / `readBody` / `readRawBody`。被五条链路共用，不能各复制一份
- `lib/git.js` — Git 状态 / diff / 撤销。默认只读；写操作只有「撤销单个文件」
  与「撤销全部」，且两条权限闸门（删未跟踪文件、取消暂存）默认关闭
- `lib/safe-path.js` — 项目内路径校验，被 diff / 打开 / 撤销三条链路共用
- `lib/models-api.js` — 从供应商 `/models` 拉模型列表（路径回退、按 API 类型适配）
- `public/` — 前端。原生 ES Module，`app.js` 只做装配，其余按职责分模块
  （`api.js` 网络、`state.js` 状态、`markdown.js` 渲染、`git.js` 变更面板、
  `diff.js` unified diff 渲染、`changes.js` 会话改动账本、`extensions.js` 扩展面板、
  `ui/` 通用组件……），无构建步骤
  - `extensions.js` — Skills / MCP 两个标签页。列表 + 搜索 + 作用域/状态筛选、
    详情只读、启停带二次确认与重启提示。**刻意不用 `innerHTML`**（全走
    `textContent` / `createElement`），一条坏 skill 不会拖垮整页
  - `tool-model.js` — 工具执行的**数据模型**：实时事件与历史消息都归一成 `ToolEntry`。
    纯数据 + 纯函数，不碰 DOM（所以能单测）
  - `tool-view.js` — 只认 `ToolEntry` 的视图层，实时与历史共用；零 `innerHTML`
  - `tool-history.js` — 从 `get_messages` 的消息数组算出渲染计划（配对、降级、顺序），
    纯函数，不碰 DOM
  - `tools.js` — 实时侧的调度：事件 → 模型 → 视图，批量重画、运行时长 ticker、分组边界
- `electron/main.cjs` — Electron 主进程，拉起内嵌后端、管窗口与导航
- `electron/preload.cjs` — 渲染进程与主进程之间唯一的桥（只暴露「用系统默认程序打开文件」）
- `electron/net-probe.cjs` — 端口探测与 URL 判定（纯逻辑，不依赖 electron，因此可单测）
- `installer/pi-gui.nsi` — 安装程序脚本（用 NSIS 编）
- `assets/icon-src.png` — 应用图标的母图（正方形 PNG）。`scripts/make-icon.mjs`
  会读它、切圆角、编码成 `build/icon.ico`；这个文件不在就退回程序化绘制的 π
- `scripts/` — 构建脚本；`scripts/util.mjs` 是几个脚本共用的小工具
- `tests/` — 上面那几组测试
- `tests/fixtures/tool-history.json` — 从真实会话 jsonl 切出来的一段消息
  （脱敏 + 长正文截断，结构一字未改），用来验证历史重建。
  来源与脱敏规则见 `tests/fixtures/README.md`

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
