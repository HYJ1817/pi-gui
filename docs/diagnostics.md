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
- pi 是否可用及版本
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
- 基础版本与运行状态
- 目录 / bridge 健康检查
- Agent 状态
- 脱敏后的完整 JSON
- 刷新
- 复制诊断 JSON
- 导出 `pi-gui-diagnostics.json`

复制或导出的 JSON 适合在提交 Issue 时附上。导出完全在浏览器本地完成，不会先上传到后端或第三方服务。

当前阶段没有自动上传，也不会把诊断发送到任何服务器。

> 更新检查**不读也不写**诊断内容：它只发一个带 `User-Agent` 与 `Accept`
> 的 GitHub 请求，请求里没有 cwd、没有诊断快照、没有任何凭据。

## 测试

```bash
npm run test:diagnostics
npm run test:update        # 版本检查（含「诊断里的版本来自快照」那类断言在前端 smoke 里）
```

测试会覆盖：

- secret key 递归脱敏
- 兼容性块：状态、三值能力、缺失清单（未验证的不进 missing）
- 协议异常**不含 secret、不含绝对路径**，且异常对象的字段在白名单内
- Bearer / sk token / 环境变量式 secret 脱敏
- 项目和数据目录绝对路径不外泄
- PID 不外泄
- 环境变量值不进入快照
- 有项目 / 无项目两种状态
- 目录可读写健康检查

该套件已进入默认 `npm test`，因此每次 CI 都会执行。
