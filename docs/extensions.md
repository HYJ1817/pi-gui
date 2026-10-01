# 扩展（Skills / Extensions / MCP）

侧栏的**扩展**是 Skills、Extensions 与 MCP 三个标签页。它管的是**你已经装好的**能力，
不是商店 —— 没有下载、没有安装、没有远程代码执行。

**Pi GUI = pi 的 GUI，不是第二套扩展系统。** pi 已有的机制就做 GUI 管理，
MCP 这类能力按**本机实际装着的那个 pi 包**检测后如实报告（历史验证基线 0.87.0 没有原生 MCP，当前验证基线 0.99.1 自带 builtin:mcp —— 见下面 MCP 一节）。

## Extensions（P15 基础设施）

P16 在 Extensions 页增加独立 Web Access 设置区：固定官方安装命令复制、
安装后重启 Pi、当前 bridge 的工具调用观察。没有 GUI 自动安装或任意包名入口。
通用 Registry 不含 Web 专用条件，工具清单仍未知。详情见 [Web Access](web-access.md)。
P17 增加 Subagents 设置区（见 [subagents.md](subagents.md)），P18 增加 Pi Memory 设置区
（见 [memory.md](memory.md)）。三者都是**独立的 feature adapter**，共用同一套
installed / configured / loaded / runtimeObserved 语义，但**不往通用 Registry 里塞
任何专用条件**：`capabilityRegistry.tools` 仍为空、`toolRegistryAvailable` 仍为 false，
Memory 也不改变发现、启用或加载的判定——它只是多了一个固定命令与一份运行观察。

Skill 是给模型阅读的指令，Extension 是在 Pi 进程中执行的第三方代码；两者保持独立。
发现规则在 0.87.0 与 0.99.1 上一致。本机 pi 的 extension 来源是 `~/.pi/agent/extensions/*.ts|*.js`、其中子目录的
`package.json.pi.extensions` 或 `index.ts|index.js`、受信任项目的 `.pi/extensions`、`settings.json` 的
`extensions` / `packages`，以及 CLI `-e`。项目来源受 Pi 的信任判定约束。
Pi package 可以由 npm、git 或本地路径提供；Pi 自己的解析器还支持 manifest
模式和覆盖规则。GUI 只读扫描能安全定位的本地文件与 npm package，不执行
package 解析器（它可能安装缺失包）。共享只读 resolver 先检查目录 manifest，
再取 `index.ts` / `index.js`；无入口的根目录仅扫描直属 JS/TS 文件和子目录入口。
settings 的普通目录条目使用同一规则。重复路径合并，manifest 路径必须留在所属根内。

自动发现项应用 settings 的 `!pattern` → `+exact-path` → `-exact-path`，
精确模式比较相对路径或绝对路径，不匹配 basename 或 glob；`-` 最终优先。
settings 普通 glob 只筛选已发现的本地条目，不作为额外发现来源。
package manifest 的正向 glob 使用 Node 内置 glob 展开（跳过隐藏路径并按词法排序），
再应用 manifest override；普通目录 manifest 按 Pi loader 的字面路径规则解析，不展开 glob。
package 对象的 `extensions` filter 支持 include / exclude / 精确 override，`[]` 明确禁用，
省略属性使用默认结果；filter 只能筛选 package resolver 已得出的集合，不新增路径。
pi 有一个细节（0.87.0 与 0.99.1 同）：显式 package filter 在 manifest extensions 为空或缺失时
回退到约定目录；未带 filter 的空 manifest 不加载资源。fixture 按真实源码固定这一区别。

仍有限制：GUI 拒绝符号链接（Pi 允许部分链接）；git/临时 CLI 来源、旧版全局 npm
回退位置、跨作用域 package 继承与 `autoload:false` delta 尚未完整解析。
`.gitignore` / `.ignore` / `.fdignore` 规则也未完整移植，候选项保留未知启用状态并给出诊断。
无法安全确认的模式或来源不会宣称启用/加载成功。

`GET /api/extensions` 返回统一的 `extensions[]` 与 `capabilityRegistry`。
`installed`、`enabled`、`loaded` 分开表达；缺证据用 `null`，不把“没观察到”
写成“未加载”。版本只读 `package.json`；可验证的 command 来自 Pi RPC
`get_commands` 的 `sourceInfo.path`。**RPC 没有已注册工具清单**：0.87.0 没有，
0.99.1 也没有（33 条命令里一条都没有）；`get_state` 同样没有这些字段。
（ExtensionAPI 有 `getAllTools()`，但那是**扩展进程内**的 API，RPC 客户端拿不到 ——
两者不能混为一谈。）因此当前工具来源保持未知，Capability Registry
只记录已证实的 command；未来若 Pi 提供带来源的工具清单，
`mapRegisteredTools()` 可把多个工具映射到同一个 extension。未知工具继续由现有
Tool Timeline 显示原始名称。

当前页面支持查看、刷新、详情；**不支持**从 GUI 安装、删除或启停 Extension。
Pi 官方有 `pi install` 和交互式 `pi config`，但没有对应的稳定 RPC 管理接口。
GUI 不调用安装命令，也不改用户的 Pi settings。用户在 Pi 外部变更配置后可走
已有的重启 Pi 入口；桥接先停旧进程、再启动新进程，前端在重启期间锁住 Composer，
workspace generation 防止旧请求污染新项目。Registry 在新 bridge run 清除旧错误，
重新请求命令证据。没有证据时 `restartRequired` 保持 `null`。
配置禁用与当前加载证据独立：修改配置但尚未重启时，可以同时出现
`enabled=false` 与 RPC 证实的 `loaded=true`；无 runtime 证据时仍保持 `loaded=null`。

Extension 失败只影响其状态行；发现接口失败会显示重试提示，基础聊天仍可用。
API 的错误只给 phase 与安全文案，不回显可能包含凭据的原始 Pi 错误。
CLI `-e` 是临时来源，但当前 GUI 无法从 RPC 列出它，因此不报告为已发现。

## Skills

Skill 是 **pi 的原生能力**（实现的是 Agent Skills 标准，见 pi 的 `docs/skills.md`）。
Pi GUI 只做发现、查看、启停三件事，**不发明任何 pi 不认识的概念**。

### 从哪发现

与 pi 的 `core/package-manager.js` `addAutoDiscoveredResources` 一致：

| 位置 | 作用域 | 条件 | collect 模式 |
|---|---|---|---|
| `~/.pi/agent/skills` | 用户 | 总是 | `pi` |
| `~/.agents/skills` | 用户 | 总是 | `agents` |
| `<项目>/.pi/skills` | 项目 | **项目被信任** | `pi` |
| `<项目>` 及祖先的 `.agents/skills` | 项目 | **项目被信任** | `agents` |

另外 `settings.json` 的 `skills` 数组里的普通路径条目、package、
以及命令行的 `--skill <路径>` 也是来源。`PI_CODING_AGENT_DIR` 可以改掉
agent 目录的位置。

**两种目录的收集规则不完全一样**，这是 pi 的行为，照搬：`pi` 模式里
**根级的 `.md` 也算一个 skill**；`agents` 模式里**只认子目录**
（根级 `.md` 会被忽略）。两者都是「目录里直接有 `SKILL.md` 就把它当成一个 skill，
不再往里递归」，并跳过点开头的条目与 `node_modules`。

### 同名冲突：项目级胜出

这一点和直觉相反（容易以为用户级覆盖项目级）。

pi 的 `resourcePrecedenceRank` 把 project 排在 user 前面，而加载是
**先到者胜** ⇒ **project 赢**。被抢先的那条在界面上标成**被覆盖（shadowed）**，
并显示是谁占了它 —— 不会两条都显示「已启用」。

> ⚠️ 配对必须按 `sourceInfo.path`，**不能只按名字**。只按名字的话，
> 「同名但被抢先的那条」也会被算成已加载，UI 就同时显示两条 enabled，
> 用户完全不知道为什么自己改的那条没生效。

### 项目信任闸门

pi 用 `--mode rpc` 驱动时是**非交互模式、没有 UI**，项目信任判定会落到
`defaultProjectTrust: "ask"` 的「无 UI」分支 —— 结果是
**项目级资源默认不加载**。

所以界面上会标成「项目未被信任」并说明原因。要让它生效：

- 用 `pi --approve` 启动一次，或
- 在 `~/.pi/agent/trust.json` 里记下这个项目，或
- 把 `defaultProjectTrust` 设成 `always`

`hasTrustRequiringProjectResources` 只认 `.pi/` 下的东西
（`settings.json` / `extensions` / `skills` / `prompts` / `themes` /
`SYSTEM.md` / `APPEND_SYSTEM.md`）与祖先 `.agents/skills` ——
`.pi-gui/` 不算，所以纯 Pi GUI 项目不会触发信任闸门。

### 启停：用 pi 官方的 override 机制

写在 `settings.json` 的 `skills` 数组里：

```json
{ "skills": ["-skills/code-review/SKILL.md", "!*experimental*"] }
```

- `-<路径>` 精确停用，`!<glob>` 按模式停用，`+<路径>` 强制包含
  （`-` 优先级最高）
- 模式匹配的是**相对发现基准目录的 posix 路径**，所以**一定带 `skills/` 前缀**。
  `-code-review` 这种裸名字**不生效** —— 这是最容易踩的坑。
  根级 `.md` 写 `-skills/<name>.md`
- **作用域必须配对**：用户级 skill 只吃全局 `settings.json`，
  项目级 skill 只吃 `<项目>/.pi/settings.json`。用全局设置关不掉项目级 skill

界面上的开关**只增删它自己写的那一条** `-` 模式，保留文件里的一切其它字段和
你手写的通配。如果还有别的模式也在关着它，会明确告诉你「只删掉这条不会生效」。

写盘走 `读 → 合并 → 校验 → 原子写`。文件坏了或 `skills` 不是数组时返回 **409
并一字不改**，让你自己修。

### 改完必须重启 pi

pi 只在启动时读 `settings.json`，**没有文件监听** ——
所以保存后 Pi GUI 会直接重启 pi，不需要你去猜为什么没生效。
反过来，纯查看、搜索、筛选这类操作不会触发重启。

### 正文只读

要看 `SKILL.md` 就点「打开文件」交给系统编辑器 —— 不内置文本编辑器，
避免两边同时写同一个文件。

## MCP

> **P20.5 更正**：本节原来写的是「当前兼容基线 Pi 0.87.0 未提供原生 MCP」。
> 那句话描述的是 **0.87.0**，不是 pi 的现状 —— **0.99.1 自带 `builtin:mcp`**，
> 而且 0.99.1 的 `docs/usage.md` 里那句「不内置 MCP」**已经被删掉了**。
> 现在这页改成读**你本机装着的那个 pi 包**，让证据自己说话。

### 能力由检测决定，不由版本号决定

| 判据 | 出处 |
|---|---|
| pi 包的 `dist/extensions/index.js` 里 `builtInExtensions` 有没有 `mcp` | 0.99.1 有：`{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true }`；0.87.0 没有 |
| `dist/core/extensions/types.d.ts` 有没有 `registerMcpServer` / `getMcpServers` | 0.99.1 有；0.87.0 没有 |

两者任一为真 → `supported: true`；两者都**读到了**且都为假 → `false`（0.87.0 就是这档，
旧版本的安全降级保留）；包读不到 → `null`，不猜。

### built-in 扩展**不是**用户装的 extension

`llama.cpp` / `codemode` / `tool-search` / `mcp` 编译在 pi 包里（`dist/extensions/`），
所以：

- **不拿 Extension Registry 的目录扫描去找它们** —— 那边扫的是
  `~/.pi/agent/extensions` 与 `<项目>/.pi/extensions`，扫不到也不该扫到；
- 也不硬编码「当前一定启用」：`mcp` / `codemode` / `tool-search` 标着
  `replaceable: true`（第三方 extension 注册同名能力时**会接管**），
  `llama.cpp` 在 0.87.0 里甚至是 `hidden: true`。
  所以页面只报「**包里带了它**」，不报「当前启用了它」。

### MCP 标签页仍然是一份能力报告，不是 Server 列表

- 报出**运行中版本**（`value` + `source` + `status` + `updatedAt`）与 built-in 清单，
  每一条都带可核对的原文出处
- 报 **RPC 事实**：33 条命令里没有一条返回已注册工具清单 —— 所以这页不列「已注册工具」
- 报 **MCP 配置文件在不在**（`~/.pi/agent/mcp.json`、`<项目>/.pi/mcp.json`）——
  **只 stat，不读内容**（里面可能有 `Authorization` 头与 `env` 密钥）
- 报**怎么配置**：`pi mcp add` / `pi mcp remove`（原文出自 pi 自己的 `docs/mcp.md`）
- 检测不出来时如实说「无法确定」，**不猜成不支持**
- 列出 pi 官方给的替代路径：`~/.pi/agent/extensions` 与 `<项目>/.pi/extensions`
  下已有哪些扩展，以及 `settings.json` 里声明的 `extensions` / `packages`

> **Server 的读取与管理留给 P20.6。** 这一轮只做「事实修正」：
> 把错的文案改对、把 built-in 与 RPC 事实摆出来、把配置文件的存在性报出来。
> `servers` 字段继续是空数组，前端结构不动。

### 刻意不做的三件事

做了就是撒谎：

1. 不假装有 Server 可以增删改（没有配置文件可读，就没有 Server）
2. 不在 `.pi-gui/` 里自己存一份 MCP 配置 —— pi 不会读它，那是个假开关
3. 不显示「已配置 / 已连接」这种没有数据支撑的状态

`server/mcp.js` **不硬编码「某个版本没有 MCP」**：它去读本机装的 pi 包
（定版本、扫 `dist/core` 找 mcp 模块、从 docs 截原文当证据）。`supported`
可能是 `null`（检测不出来不猜）。将来 pi 真加了支持，报告会自动翻成 true。

## 安全边界

- **不联网、不下载、不安装任何东西**；没有 Skill / MCP 商店
- **不接受客户端传路径**：前端只拿得到 skill 的稳定 ID（路径的哈希前缀），
  真实路径由后端在自己的索引里查。读文件前还会再校验一次「确实落在已知
  发现根之下」
- **Extension 发现只读目录项和限长 `package.json` 元数据，不读源码、不执行** ——
  配置原文和 Pi 原始错误不会进入接口响应；可疑的 description 也不会展示
- 一条 skill 坏了（缺 `description`、读不出来、frontmatter 不合法）
  只影响它自己，在它那一行就地报错，不会让整页打不开

## 哪些能力依赖 pi 版本

发现规则、启停语法、信任判定都跟着 pi 的实现走。如果将来的 pi 改了目录约定或
override 语义，需要同步更新 `server/skills.js` ——
**它里面每一条规则都注明了源码出处**，照着改比重新猜快得多。

## 相关测试

P19 在 Extensions 页增加 **Approval / Permission** 能力块（只读报告，不是新标签页）：
报告 `tool_call` 能否阻断、对话框子协议是否可用、核心有没有自带审批、
RPC 下 `ctx.ui.custom()` 是否退化，每项带出处；见 [approvals.md](approvals.md)。
它不改 Registry 的发现/启用/加载判定，也不往 Registry 里塞 permission 专用逻辑。

P17 增加 Conversation Subagent Activity 与手动安装提示，见 [subagents.md](subagents.md)。
终端执行固定命令 pi install npm:pi-subagents 后确认重启 Pi。
installed/configured/loaded/runtimeObserved 分开；loader 不启动 child。
不读取 Agent 定义，不修改 Registry 的 tools/unknown 语义。

P20 在 Extensions 页增加 **Browser Use** 设置区（固定命令 `pi install npm:pi-browser-harness`
+ 复制 + 安装后重启 Pi + 当前 bridge 的真实工具调用观察），见 [browser.md](browser.md)。
它和 Web Search 是**两件独立的事**，两个设置区互不代劳、观察互不合并。
这个 Extension **没有审批协议**，所以该区块明确写出「这些动作会直接发生，Pi GUI 拦不住它们」，
不提供任何允许 / 拒绝按钮，也不画假 modal。
Registry 仍只按包名做只读发现；**工具语义匹配与 Registry 无关**（按工具名，不按包名）。

P18 增加 Pi Memory Activity 与手动安装提示，见 [memory.md](memory.md)。
终端执行 pi install npm:pi-memory 后确认重启 Pi；GUI 不安装 qmd、不建索引、
不读 `~/.pi/agent/memory`、不建立第二份数据库。长期记忆与会话搜索保持独立，
Registry 的 tools/unknown 语义同样不变。`npm run test:memory`（236 条，离线）。

`npm run test:skills`（182 条）：发现规则（两种 collect 模式）、同名冲突、
信任判定、状态判定（`enabled` / `disabled` / `untrusted` / `invalid` /
`shadowed` / `not-loaded` / `unknown`）、详情与路径逃逸、启停写盘（保留未知字段 /
原子写 / 409 不动坏文件）、真实 router 的令牌与 Origin、MCP 能力报告与密钥不外泄。
全程在 `os.tmpdir()` 里造世界，不 spawn 进程、不联网。

`npm run test:skills-live`（32 条，**要真 pi**，约 2-3 分钟，不在 `npm test` 里）：
拉起真的 pi 子进程，用真的 `get_commands` 对拍 —— 项目级默认不加载 /
`--approve` 才加载、同名冲突项目胜出、停用语法（带 `skills/` 前缀有效、
裸名字无效、glob 有效）、改 settings 不热加载必须重启、
`enableSkillCommands=false` 时 `get_commands` 仍返回、`--no-skills`。

它验证的是「pi **真的会**那样应答」，而单测的桩只能证明「给定应答，
我们的判定对不对」。
