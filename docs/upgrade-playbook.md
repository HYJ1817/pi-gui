# Pi / Extension 升级 playbook（P23）

这份文档回答一个问题：**当 pi（或某个关键 Extension）发新版本时，Pi GUI 怎么安全地跟上去。**

它存在的理由很具体：P20.5 那次迁移之前，仓库里写着「pi 0.87.0 没有原生 MCP，而且是有意为之」，
而用户机器上装着 0.99.1 —— **它自带 `builtin:mcp`**。一句话把四个不同的「版本」混成了一件，
于是能力报告在撒谎。P23 把这种一次性迁移变成**长期、可诊断、可复现**的流程。

> ⚠️ **CI 绿不能认证一个从未验证的新版本。**
> `npm test` 的夹具证明的是「给定这些形状，我们的判定对不对」，
> 它**不证明**「这个版本的 pi 真的这么发」。认证只能来自下面的第 1–6 步。

---

## 〇、先分清四个「版本」（P20.5 的结论，别再混）

| | 是什么 | 谁决定 | 在哪看 |
|---|---|---|---|
| **历史验证基线** | 当时验收过的版本（0.87.0 / 0.99.1） | 已固定的历史事实 | `server/pi-compat-matrix.js` 的 `PI_BASELINES` |
| **当前验证基线** | 最近一次逐项核对过的版本（0.99.2） | 本流程第 6 步的结论 | 同上（`scope: 'current'`） |
| **运行中版本** | 你这台机器上实际跑的那个 pi | `server/pi-version.js` 探测 | 诊断面板「版本真值」 |
| **版本核对状态** | 运行中版本在不在矩阵里 | `verifiedAgainst` / `verification` | 同上 |

**版本号只用来回答「我们核过没有」，永远不用来判断「所以它支持什么」。**
能力一律走 probe（`server/pi-probes.js`）或真实事件（`server/pi-compat.js`）。

---

## 一、获取实际的 release / tag / source

```bash
npm view @earendil-works/pi-coding-agent versions      # 有哪些版本
npm view @earendil-works/pi-coding-agent@<version> gitHead
npm pack @earendil-works/pi-coding-agent@<version>     # 下 tarball 到本地再解
```

**不要**用文档、changelog 或博客当作契约来源 —— 读发布包本身。
关键 Extension 同理（`pi-web-access` / `pi-subagents` / `pi-memory` / `pi-browser-harness`），
基线写在同一张表的 `EXTENSION_BASELINES` 里。

> 记录 `gitHead`：它是「我们核对的是哪一份提交」的唯一凭据，
> 也是本仓库历史上两处误读的纠正依据（见 [pi-compatibility.md](pi-compatibility.md) §〇）。

## 二、diff 关键 contract（照下面这张清单，不要凭印象）

| 面 | 读哪个文件 | 关心什么 |
|---|---|---|
| RPC 命令集 | `dist/modes/rpc/rpc-types.d.ts` | `RpcCommand` 联合有没有增删（**有没有出现工具清单命令**） |
| 扩展 UI 子协议 | `docs/rpc-extension-ui.md`（0.99.2 起）/ `docs/rpc.md`（旧） | 对话框方法是否仍阻塞等待 `extension_ui_response` |
| tool_call 阻断 | `dist/core/extensions/types.d.ts` + `docs/extensions.md` | `block?: boolean` 与文档措辞（**措辞会变**） |
| built-in 扩展 | `dist/extensions/index.js` 的 `builtInExtensions` | 有哪些、哪些 `replaceable` |
| MCP 运行时状态 | `dist/extensions/mcp/runtime.d.ts` | `ServerState` 闭集 |
| MCP CLI / list --json | `dist/extensions/mcp/cli.js` | 子命令、`resources` / `resourceTemplates` |
| MCP 配置语义 | `dist/extensions/mcp/config.ts` | 覆盖规则、信任前提、`validateMcpServerConfig` |
| 会话文件 | `docs/session-format.md` + 真实会话文件 | 条目类型、消息体嵌套形状 |
| wire Usage | `@earendil-works/pi-ai` 的类型 | `{input, output, cacheRead, cacheWrite, totalTokens, cost}` |
| 工具返回值 `isError` | `@earendil-works/pi-agent-core` 的 agent loop | 是否传播 Extension 的 `isError` |

**最容易骗过人的两类漂移（都是本仓库真实踩过的）：**

1. **文档措辞变了，语义没变。** 0.99.2 把 `**Can block.**` 改成
   「`tool_call` can mutate input or block execution.」—— 只认旧措辞的 probe
   会凭空报「不支持」，而类型里明明有 `block?: boolean`。
2. **文档搬了位置。** 对话框阻塞契约从 `docs/rpc.md` 搬到了 `docs/rpc-extension-ui.md`。

⇒ 所以 probe **两版措辞、两处位置都要认**，并且证据里带上真正命中的文件。
`npm run test:probes` 里有两版措辞的 fixture，`tests/pi-probes.cjs` 还会交叉核对
`server/approval-probe.js`（P19）与 `server/pi-probes.js`（P23）对同一份包给出一致结论 ——
两处判定不能各说各话。

## 三、更新 fixtures

新增或更新 `tests/pi-version.cjs` / `tests/pi-probes.cjs` 里的假 pi 包内容。
**fixture 要照真实形状造**（从第 1 步的 tarball 里抄原文，不要凭印象写）——
fixture 形状错了有两个方向的后果，其中**把真实缺陷藏起来**更危险。

## 四、跑契约测试

```bash
npm run test:probes     # P23：probe 三值 / 缓存 / 漂移 / 诊断脱敏
npm run test:compat     # P4：三值能力与信封
npm run test:pi-version # P20.5：版本真值 + built-in 探测
npm test                # 全量回归
```

新增/改动的 probe 必须**同时**有「支持」与「不支持/未知」两侧的断言 ——
只测一条路径等于没测。

## 五、显式 live test（这一步不能省）

```bash
npm run test:probes-live             # 对着**本机真装着的那个 pi** 打一张 probe 表
npm run test:probes-live -- --strict # 版本不在矩阵里 → 退出码 1
```

它不做「本机版本是 X」这种断言（那在别人机器上必红），只断言结构事实，
并把整张表打出来。**升级之后第一件事就是跑它**：哪条 probe 从 ✓ 变成 ·或✗，
哪条就不需要人去猜。

需要真 pi 的其它套件：`npm run test:skills-live`、`npm run test:reliability-live`、
`PI_GUI_BROWSER_LIVE=1 npm run test:browser-live`（见 [testing.md](testing.md)）。

## 六、更新 compatibility docs 与矩阵

1. 把新版本加进 `server/pi-compat-matrix.js` 的 `PI_BASELINES`
   （`version` / `verifiedAt` / `scope` / `note`），并把旧的那条改成 `scope: 'historical'`。
2. 新发现的差异进 `KNOWN_DIFFERENCES`（`id` / `between` / `affects` / `handling` / `probe`）。
3. 同步 [pi-compatibility.md](pi-compatibility.md) 的对照表与本文档。
4. Extension 有新 release 时更新 `EXTENSION_BASELINES` 与各 feature 文档的「核对的公开契约」。

**只有真的逐项核对过才写进矩阵。** 写进去就意味着「我们为这个版本的契约背书」；
写不进去的版本照样能跑，只是诊断里会标成 `unverified`。

## 七、push 后人工验收

- 诊断面板「版本真值」里核对状态应是**已核对**；
- 关键 probe 不应出现意料之外的 `不支持`（出现了就是真差异，必须解释或修 probe）；
- Native MCP 状态与 MCP 标签页一致；
- 「复制诊断摘要」贴出来能自证上面三件事。

---

## 附：状态词汇表（新版本出现意外时看这里）

| 你要判断 | 看什么 | 不要看什么 |
|---|---|---|
| 这台机器跑的是哪个 pi | `pi.version` + `versionSource`（package.json / pi --version / none） | 文档里的基线版本 |
| 这个版本我们核过没有 | `pi.verification`（verified / unverified / unknown / unchecked） | CI 是不是绿的 |
| 某个能力能不能用 | probe 的三值 + `pi-compat` 的能力三值 | 版本号大小 |
| 上游是不是变了 | `probes` 表里哪条翻面 + schema 漂移记录（来源 + 字段名 + 类型） | 猜 |
| 未验证 ≠ 不支持 | `unverified` 列表是「还没用到」，`missing` 才是「证实不可用」 | 把两者混着说 |

**明确不做**：不自动升级 / 安装 / 降级 pi 或 Extension、不查 npm registry 与 GitHub Release、
不改用户全局 npm、不 fork / monkey patch pi、不为找包目录执行任何 shell。
