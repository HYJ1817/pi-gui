# 首次启动环境检测与一键安装 — 验收记录

- 日期：2026-11-15
- 分支：`feat/first-run-environment-setup`
- 基线：`48bc426`
- 产品文档：[docs/environment-setup.md](../../docs/environment-setup.md)
- 安全边界：[docs/security.md](../../docs/security.md)

## 自动化测试

| 套件 | 结果 | 覆盖 |
| --- | --- | --- |
| `tests/environment-download.cjs` | **18/18 通过** | HTTPS 白名单、逐跳重定向、大小上限、取消、摘要解析、解压脚本防护、临时目录、目录替换与清理 |
| `tests/environment-setup.cjs` | **20/20 通过** | 必需/推荐分离、Pi `engines.node`、Pi 身份与兼容性、RPC 握手、受管 PATH、手动路径、脱敏、计划指纹 |
| `tests/environment-install.cjs` | **15/15 通过** | 计划校验、Node → Pi → Git 完整状态机、只装请求组件、摘要不符、配置写入失败回滚、取消、并发、HTTP 适配层 |
| `tests/environment-ui.cjs` | **16/16 通过** | 纯展示模型、jsdom 四页流程、原生确认调用、后台结束后的重开刷新、静态边界 |

合计 **69/69**，全部离线：fixture 在 `os.tmpdir()`，下载 / 命令 / npm 使用注入替身，
不联网、不修改真实 Node / Pi / Git。jsdom **不证明排版**，排版由下方真实截图验收。

相邻套件：

| 套件 | 结果 |
| --- | --- |
| `tests/app-check.cjs` | 27/27 |
| `tests/portable-check.cjs` | 12/12 |
| `tests/modules.cjs` | 121/121 |
| `tests/diagnostics.cjs` | 15 |
| `tests/server-security.cjs` | 39/39 |
| `tests/electron-guard.cjs` | 128/128 |

本次没有在本地运行完整的 `npm test`（canonical 链很长）；按仓库约定交给 PR CI，
在 CI 结果出来前状态为 **待验证**。上面的定向套件与相邻套件均已实际运行。

## 构建结果

命令：`npm run build:app -- --rebuild`、`npm run build:dist`。

| 产物 | 大小 | 结果 |
| --- | --- | --- |
| `dist-app/Pi GUI-win32-x64` | 333.5 MB | 构建成功；`npm run test:app` 27/27 |
| `dist-app/.../Pi GUI.exe` | 234.9 MB | 内嵌后端、随包 node-pty 启动真实 PTY |
| `dist-installer/Pi-GUI-Setup-0.33.0.exe` | 101.7 MB | 编译成功 |
| `dist-installer/Pi-GUI-0.33.0-portable.zip` | 143.9 MB | 构建成功；`npm run test:portable` 12/12 |

SHA256（本轮构建）：

```text
d99357b6c35a22c38cd766a3e9b0d6f3ea9a30a167e3a52d62498c99a12752c4  Pi-GUI-0.33.0-portable.zip
cd1eb19dbbe3158a12b874904ec0cdb7ac4fa1c9021946d5bf80cb26998d3a54  Pi-GUI-Setup-0.33.0.exe
```

便携版验证包含：解压后目录结构、直接启动、后端身份、桌面令牌校验、页面与静态资源、
无崩栈输出、临时目录清理。

安装版 payload 另做过解包启动验证（截图 06/07）：解包出的应用能启动，检查页与确认页
可操作；这不是静默安装验证。

## 界面截图

截图位于 [`evidence/`](evidence/)：

| 文件 | 内容 |
| --- | --- |
| `01-source-check.png` | 源码版首次检查页：必需/推荐分组、缺失项与唯一主动作 |
| `02-source-confirm.png` | 确认页：组件、版本、来源、用户级范围、Git 可跳过 |
| `03-source-installing.png` | 安装进度：组件、阶段、完成数、取消入口，无原始命令输出 |
| `04-source-verified.png` | 验证页：Node / npm / Pi / RPC / Git 逐项结果 |
| `05-settings-entry.png` | 设置 → 应用与更新 → 环境与依赖入口 |
| `06-installer-payload-check.png` | 解包后的安装版 payload 启动并进入检查页 |
| `07-installer-payload-confirm.png` | 解包 payload 的确认页 |
| `08-portable-check.png` | 便携版启动后的检查页 |
| `09-portable-confirm.png` | 便携版的确认页 |

最终代码只改了后台任务刷新、下载取消与来源字段等**行为**，没有改变四页布局、
文案结构或 CSS；截图仍代表当前可见界面。截图使用隔离数据目录与测试项目，
没有对用户真实 Pi 会话做写操作。

## 真实 Windows 11 验证

- **便携版**：`npm run test:portable` 12/12 通过；解压后可启动、后端身份正确、
  无令牌 API 被拒、页面可打开。
- **安装版**：静默安装验证 **未完成**。`npm run test:installer` 在本机被安全软件
  （火绒 HIPS）拦截：安装器进程退出码 21，目标目录没有创建。做过最小复现：
  纯文本 NSIS 安装器可以正常安装；同一个安装器一旦包含 exe payload 就退出 21，
  且安装器文件会被安全软件移走。没有为了通过测试而关闭或修改用户的安全软件。
  因此“至少一次完整安装版验证”这一项应标为 **未验证 / 被环境阻断**。
- 便携版可视为真实 Windows 11 的完整启动验证；安装版仍需在放行安全软件后重跑
  `npm run test:installer`，或由 CI 的安装器任务给出结果。

## 独立审查发现与处置

独立审查（另一起上下文）确认了以下问题，均已在最终代码中处理：

1. **取消可能卡在 `cancelling`**：`downloadText` 没有传 AbortSignal，且两个下载函数
   都没有连接空闲超时。已补 signal、30 秒空闲超时，并让取消时的传输错误统一归为
   `cancelled`；新增“校验文件传输中取消”测试。
2. **后台安装结束后向导仍显示旧报告**：SSE 终态在弹层关闭时只存 job，重开不刷新。
   已让重开时消费未处理的终态、刷新报告并保留失败原因；新增成功/失败两条 jsdom 回归。
3. **受管 Node 的 RPC shim 找不到 node**：npm shim 用 PATH 上的 `node`，而探测用的是
   受管 PATH 生效前的 `baseEnv`。已为 RPC 探测套一份受管 PATH 副本；新增回归测试。
4. **Pi 来源字段把受管/手动路径都标成 `env`**：已按 store 的 `effectivePiBin()` 区分
   `managed` / `override` / `env`；补测试并同步文档顺序。
5. **摘要不符分支没有回归测试**：安装测试新增 `checksum-mismatch` 用例。
6. **下载重定向/取消边界**：`downloadText` 补重定向次数上限；补循环重定向测试。

## 已知限制

- 自动安装仅支持 Windows x64；其它平台只检测并给人工指引。
- Node / Git 使用固定 SHA256，不做 Authenticode 签名校验；Pi 使用 npm registry
  完整性校验并在本机验证入口与版本。
- MinGit 是精简 Git；需要完整 Git Bash 的用户应自行安装官方 Git for Windows。
- 安装后不修改系统 PATH；当前进程立即生效，其它已打开终端需重启。
- 检测使用同步版本探测，首次检查在极慢机器上可能阻塞后端事件循环数秒；
  报告有 5 秒缓存，用户可点“重新检查”刷新。
- 安装版静默安装被本机安全软件阻断，尚未完成真机验收。
- 完整 `npm test` 未在本地运行，PR CI 结果待验证。
