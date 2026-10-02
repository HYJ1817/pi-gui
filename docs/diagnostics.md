# 诊断

Pi GUI 的“诊断”面板用于把故障排查需要的运行状态收敛成一份可复制的 JSON。
入口在侧栏底部“诊断”。

## 收集什么

当前诊断快照包括：

- Pi GUI 版本
- 操作系统类型、版本、架构
- Node.js 版本
- 当前是否选择项目，以及项目目录的 basename
- 项目目录与 Pi GUI 数据目录是否可读 / 可写
- pi bridge 是否运行、bridgeRun、启动参数
- pi 是否可用及版本（**优先取规范版本状态** `pi.version.source`：`package.json` /
  `pi --version` / `none`）
- **版本核对状态**（P23）：`pi.verification` —— 这个版本在不在兼容矩阵里
  （`verified` / `unverified` / `unknown` / `unchecked`）与核对基线。
  与「版本从哪来」分开摆：一个是值的来源，一个是「这个值我们认不认识」
- **能力 probe 表**（P23）：每条 probe 的 id / 类型（source / runtime）/ 名称 /
  三值 / **出处**（读了哪个文件的哪一行，相对路径），以及概览计数与
  「还没法下结论的核心 probe」清单
- **兼容矩阵摘要**（P23）：已验证的 Pi 版本（含核对日期与范围）、关键 Extension release、
  已知上游差异。**只有版本号与日期**
- **Native MCP 状态**（P23）：原生状态 / server 条目数 / 项目信任。
  **只有状态与计数，没有 server 名字**（诊断不需要它）
- **关键 Extension 版本**（P23）：只列 `package.json` 里读到版本号的那些，带作用域。
  上限 20 条 —— 诊断不是扩展清单
- **启动中的 pi 是哪一个**（`pi.launch`：解析来源 `env`（显式 `PI_BIN`）/ `path`（按
  PATH 解析）、入口 basename、包目录是否已绑定。**只有枚举与 basename，
  没有绝对路径**）—— 用来一眼看出「版本和实际启动的不是同一份」
- **Pi 运行时更新快照**（`piUpdate`）：`phase` / `currentVersion` / `latestVersion` /
  `updateAvailable` / `canUpdate` / `verification` / `reason` / `running` /
  `cached` / `errorCode`。它说的是「本机装着的那个 pi 有没有新版、能不能更新」，
  与 Pi GUI 自己的版本块（`app.version`）是两件事，**别读串**。
  **这一块是只读投影：`piUpdate()` 只看检查缓存的最近一次结果，
  一个网络请求都不发**（快照里也没有 command / args / 绝对路径 / updater 原始输出）
- **bridge 维护态**（`bridge.maintenance`）：Pi 正在被官方 self-update 替换时，
  这一段是 `{reason}`（不在维护中是 `null`）。它只投影 `reason` ——
  bridge 内部那份 `{reason, at}` 里的时间戳不进快照
- 已适配 Agent 的可用性、版本、不可用原因与 capability
- MCP 能力检测的摘要
- **Pi 兼容性报告**：pi 版本、兼容状态、九个能力的支持情况（支持 / 不支持 / 未验证）、
  缺少的能力，以及最近若干条**协议异常**（只记操作名、字段名与类型）。见
  [pi-compatibility.md](pi-compatibility.md)
- 一组结构化健康检查

接口为：

```
GET /api/diagnostics
```

返回的 `schemaVersion` 用于以后扩展字段时区分结构版本。

## 明确不收集什么

诊断功能不读取或返回：

- 会话正文
- 用户 prompt / 模型回答
- 工具输出
- `models.json` 内容
- `settings.json` 内容
- 项目配置正文
- 环境变量列表
- API Key
- `PI_GUI_TOKEN`
- Cookie / Authorization header
- PID
- 项目绝对路径
- Pi GUI 数据目录绝对路径
- HOME 绝对路径

兼容性报告里的**协议异常也只记结构**：操作名、问题类型、字段名、以及「实际是什么
类型 / 有哪些键」—— 对象只记键名、数组只记长度、其余只记 `typeof`。
**从不记录原始 payload**，所以 prompt、模型回复、工具输出、密钥都不会进来。
（那条规矩钉在 [pi-compatibility.md](pi-compatibility.md) 第六节。）

**schema 漂移记录（P23）更严**：只有来源、**我们自己代码里的字段路径**、以及 `typeof`
（对象连键名都不给）。`privacy.schemaDriftValuesIncluded` 永远是 `false`。
前端观察到的漂移（`public/schema-drift.js`）同样只有这三样，且在
**浏览器里就地生成**、随 bridge 重启清空 —— 它不上传，也不进后端。

Agent 的底层探测 detail 也不进入诊断快照，因为其中可能包含本机安装路径，而故障定位通常只需要 `available / version / reason / capabilities`。

## 脱敏

快照在返回前还会统一经过递归脱敏：

- 名字看起来像 `apiKey` / `token` / `authorization` / `password` / `secret` 的字段直接替换为 `[REDACTED]`
- `Bearer ...` 替换
- 常见 `sk-...` token 替换
- `*_API_KEY=...` / `*_TOKEN=...` / `*_SECRET=...` / `*_PASSWORD=...` 形式替换
- 当前项目、数据目录与 HOME 路径分别替换成 `<project>` / `<data-dir>` / `<home>`

这层脱敏是兜底。更重要的原则仍然是：敏感源数据默认就不进入 diagnostics 对象。

## 前端

诊断面板提供：

- **「版本」小节**（顶部）：当前 Pi GUI 版本 + `[检查更新]`。
  版本号来自上面的诊断快照（后端 `VERSION` 是唯一真相），前端不硬编码。
  五种状态：`idle` / `checking` / `latest` / `available` / `error` ——
  **「已是最新版」与「检查失败」永远是两句不同的话**。见 [updates.md](updates.md)
- **「Pi」区块**（紧跟「版本」之后）：本机装着的 pi 的版本 + `[检查 Pi 更新]`，
  发现新版时给 `[更新到 x.y.z]`（只在真能更新时出现，禁用按钮不发灰按钮骗人点）。
  它读的是 `piUpdate` 快照 + 当前 `/api/pi-update` 的相位，**当前版本用 `pi.version`
  兜底** —— 与下面「版本真值」说的是同一个东西，两处不会各说各话
- 基础版本与运行状态
- **版本真值**（P23）：pi 版本 / 版本来源 / 核对状态 / 核对基线
- **能力 probe 表**（P23）：每条带出处；三值分得开（支持 / 不支持 / 未知）
- **兼容矩阵**（P23）：当前基线、已验证版本、已登记 Extension release、已知差异
- **Native MCP**（P23）与**关键 Extension 版本**（P23）
- 目录 / bridge 健康检查
- Agent 状态
- 脱敏后的完整 JSON
- 刷新
- **「复制诊断摘要」**（P23）：一段给人读的纯文本（版本 / 核对 / 兼容 / probe /
  MCP / Extension / 健康检查 / 漂移 / 隐私声明）。它**只由白名单字段拼出来**，
  与面板显示的是同一份已脱敏快照 —— 比整份 JSON 更适合贴进 issue。
  摘要里有一行 `Pi 更新`（相位 / 当前版本 → 目标版本 / 能不能自动更新 /
  是不是在跑 / 是否来自缓存 / 未验收状态 / 错误码），与面板里那块**说的是同一份快照**，
  不许各说各的
- 复制诊断 JSON
- 导出 `pi-gui-diagnostics.json`

复制或导出的 JSON 适合在提交 Issue 时附上。导出完全在浏览器本地完成，不会先上传到后端或第三方服务。

当前阶段没有自动上传，也不会把诊断发送到任何服务器。

> 更新检查**不读也不写**诊断内容：它只发一个带 `User-Agent` 与 `Accept`
> 的 GitHub 请求，请求里没有 cwd、没有诊断快照、没有任何凭据。
>
> 反过来同样成立：**诊断只是读快照，不会触发任何网络请求** ——
> `piUpdate` 块是 `GET /api/pi-update` 那次检查留在内存里的结果，
> 打开诊断面板（或导出 JSON）**不会**顺手去打 `pi.dev`，也不会执行更新。
> 面板打开时若这一块还什么结论都没有，**前端**会自己静默补一次检查
> （`force:false`，失败不留状态）—— 那是前端的一次独立动作，
> 不是「诊断在联网」。见 [updates.md](updates.md)。

## 测试

```bash
npm run test:diagnostics
npm run test:probes        # P23：probe / 矩阵 / 漂移 / 诊断集成的离线契约
npm run test:update        # 版本检查（含「诊断里的版本来自快照」那类断言在前端 smoke 里）
```

测试会覆盖：

- secret key 递归脱敏
- 兼容性块：状态、三值能力、缺失清单（未验证的不进 missing）
- 协议异常**不含 secret、不含绝对路径**，且异常对象的字段在白名单内
- **P23**：probe 表 / 矩阵摘要 / Native MCP / Extension 版本进诊断，各自只有白名单字段
  （probe 只给 `id/kind/label/state/evidence`、Native MCP 只给状态与计数、
  Extension 只给有版本号的、上限 20 条）
- **P23**：schema 漂移只记来源 + 字段名 + 类型，**不含值也不含对象键名**
- **P23**：不注入新块时它们是 `null`（老调用方 / 老后端不受影响）
- Bearer / sk token / 环境变量式 secret 脱敏
- 项目和数据目录绝对路径不外泄
- PID 不外泄
- 环境变量值不进入快照
- 有项目 / 无项目两种状态
- 目录可读写健康检查

> ⚠️ **`piUpdate` 投影与 `bridge.maintenance` 目前没有被断言钉住**（如实记下来，
> 免得下次以为这块测过了）：`tests/diagnostics.cjs` 不注入 `piUpdate` ——
> 它走的是 `null` 分支（「不注入就是 `null`」那条断言仍然有效）；
> `tests/pi-update.cjs` 断言的是**模块自己的** `snapshot()`（相位、`running`、
> 清除缓存后的复验），不经过 `server/diagnostics.js` 那一层字段白名单。
> 所以「诊断里只出现那十个字段 / 维护态只出现 `reason`」这件事目前靠读代码保证，
> 不靠测试；前端那两处（面板里的「Pi」区块、摘要里的 `Pi 更新` 行）同理。

前端侧（`npm run test:ui` 的 P23 段）另有 16 条：五个新小节都渲染、
版本来源与核对状态分开摆、probe 三值与出处、矩阵基线、Native MCP 不含 server 名字、
Extension `name@version`、「复制诊断摘要」按钮存在且内容脱敏、
摘要与面板口径一致、剪贴板内容正确、漂移记录（未知工具名 / 闭集外状态 / 去重 /
只记字段名与类型）与 bridge 重启清空。

该套件已进入默认 `npm test`，因此每次 CI 都会执行。
