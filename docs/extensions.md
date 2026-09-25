# 扩展（Skills / MCP）

侧栏的**扩展**是 Skills 与 MCP 两个标签页。它管的是**你已经装好的**能力，
不是商店 —— 没有下载、没有安装、没有远程代码执行。

**Pi GUI = pi 的 GUI，不是第二套扩展系统。** pi 已有的机制就做 GUI 管理，
pi 没有的（MCP）**不发明兼容层**，而是如实报告 + 指出官方替代路径。

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

### pi 当前没有原生 MCP，而且是有意为之

`docs/usage.md` 原文：

> It intentionally does not include built-in MCP, sub-agents, permission popups,
> plan mode, to-dos, or background bash. You can build or install those workflows
> as extensions or packages, or use external tools such as containers and tmux.

pi 包里没有任何 MCP 模块，也没有 `mcpServers` / `.mcp.json` 这类配置约定。

### 所以 MCP 标签页不是 Server 列表，是一份能力报告

- 读你本机真正装着的那个 pi 包，报出版本号、**它到底支不支持 MCP**，
  以及支撑这个结论的**原文出处**（可自己核对）
- 检测不出来时如实说「无法确定」，**不猜成不支持**
- 列出 pi 官方给的替代路径：`~/.pi/agent/extensions` 与 `<项目>/.pi/extensions`
  下已有哪些扩展，以及 `settings.json` 里声明的 `extensions` / `packages`

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
- **扩展目录只读名字、类型、大小、时间，不读内容、不执行** ——
  所以哪怕扩展文件里写着密钥，它也不会出现在接口响应里
- 一条 skill 坏了（缺 `description`、读不出来、frontmatter 不合法）
  只影响它自己，在它那一行就地报错，不会让整页打不开

## 哪些能力依赖 pi 版本

发现规则、启停语法、信任判定都跟着 pi 的实现走。如果将来的 pi 改了目录约定或
override 语义，需要同步更新 `server/skills.js` ——
**它里面每一条规则都注明了源码出处**，照着改比重新猜快得多。

## 相关测试

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
