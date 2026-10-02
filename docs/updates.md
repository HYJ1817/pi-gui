# 版本检查与更新

Pi GUI 能告诉你「有没有新版本」，并把发布说明摆出来，再让你自己点开 GitHub 的
Release 页面或安装包。

**它不会替你下载、不会替你安装、不会静默升级。** 第一部分第十一节解释为什么。

这里其实是**两件不同的事**，本文分成两部分写，因为把它们混在一句话里迟早会出事
（「Pi 更新」和「Pi GUI 更新」说的不是同一个对象）：

| | 管什么 | 端点 | 会不会执行命令 | 官方来源 |
|---|---|---|---|---|
| **第一部分：Pi GUI 更新** | 这个界面要不要升级 | `/api/update` | **不会** —— 只把用户带到 GitHub | GitHub Release |
| **第二部分：Pi 运行时更新** | 它驱动的那个 `pi` 要不要升级 | `/api/pi-update` | 只会在用户确认后跑 `pi update --self` | `https://pi.dev/api/latest-version` |

两者的**状态、相位、缓存、文案、代码模块**（`server/update-check.js` 对
`server/pi-update.js`、`public/update.js` 对 `public/pi-update.js`）各有一套，
**绝不互相复用**。命名也刻意分开：`update` 只指 Pi GUI 自己，`pi-update` 只指运行时。

# 第一部分：Pi GUI 更新（`/api/update`）

## 一、数据源

固定的一个公开接口：

```
GET https://api.github.com/repos/HYJ1817/pi-gui/releases/latest
```

`/releases/latest` 按 GitHub 的定义**只返回最新的非草稿、非预发布 Release**，
所以「稳定版用户拿到的是稳定版」这件事首先由数据源保证，代码里再判一次
（见下面的稳定版策略）只是双保险。

**renderer 不直接访问 GitHub。** 链路是：

```
Renderer
   ↓  GET /api/update[?force=1]
server/router.js
   ↓
server/update-check.js
   ↓  GET https://api.github.com/…
GitHub
```

这么绕一层的理由有两个，都不是洁癖：

1. **CORS 与令牌**。页面直连 api.github.com 会撞 CORS，而且要把
   GitHub 域名加进后端的 Origin 白名单 —— 那等于为了让一个可选功能可用，
   把主边界放松一点。走自己的后端就没有这个问题。
2. **过滤要在边界上做**。响应里的 `html_url` / `browser_download_url` 是
   **外部数据**，后端先过一遍白名单再交给前端（见「外链安全」）。

### 接口

```
GET /api/update              走缓存（30 分钟内直接复用）
GET /api/update?force=1      绕过缓存（用户主动点「检查更新」时用）
```

有更新：

```json
{
  "ok": true,
  "currentVersion": "0.11.1",
  "latestVersion": "0.12.0",
  "updateAvailable": true,
  "cached": false,
  "release": {
    "name": "Pi GUI v0.12.0",
    "tag": "v0.12.0",
    "publishedAt": "2026-09-30T09:00:00Z",
    "notes": "…",
    "notesTruncated": false,
    "url": "https://github.com/HYJ1817/pi-gui/releases/tag/v0.12.0",
    "assets": [
      { "name": "Pi-GUI-Setup-0.12.0.exe", "size": 105020429, "url": "https://github.com/…", "kind": "installer" }
    ],
    "droppedAssets": 0
  }
}
```

无更新：只有 `ok / currentVersion / latestVersion / updateAvailable / cached`，
**不带 `release`** —— 前端没有可展示的东西，少传一份外部内容就少一份暴露面。

检查失败：

```json
{ "ok": false, "error": "暂时无法连接 GitHub", "code": "network" }
```

`code` 是内部错误类型（`timeout` / `network` / `rate-limit` / `github-error` /
`invalid-response` / `no-release`），**不是**技术细节：没有状态码、没有 header、
没有堆栈、没有 GitHub 的原文。前端用它选文案，用户看不到它。

失败也回 **HTTP 200**：HTTP 层这次调用是成功的，「检查失败」是业务结果。
用 5xx 表示会让前端把它当成后端故障。

## 二、版本比较

自己实现，**不引入 `semver`**。只需要两条规则，而引入一个包要付随包分发与
许可证的成本（本项目零运行时依赖是硬约束）。实现在 `server/update-check.js`：

```js
parseVersion('v0.11.0')   // → { major:0, minor:11, patch:0, prerelease:[] }
compareVersions('0.11.0', '0.12.0')   // → -1
```

规则：

1. **major > minor > patch**
2. **有 prerelease 的小于同版本正式版**（`0.12.0-rc.1 < 0.12.0`）
3. prerelease 逐段比：数字段按数值、**数字段小于字母段**、其余按字典序
   （`0.12.0-beta.1 < 0.12.0-rc.1`）

接受的写法：`0.11.0` / `v0.11.0` / `1.0.0` / `0.12.0-beta.1` / `0.12.0-rc.1`，
也容忍缺段（`1` 等于 `1.0.0`）。

**非法版本不会把流程弄崩**：`parseVersion()` 回 `null`，
`compareVersions()` 对非法输入回 **`null` 而不是 `0`** ——
「不知道」和「一样大」是两件事，混起来会把一个奇怪的 tag 判成「已是最新」。
GitHub 上出现一个解析不了的 tag 时，结果是 `invalid-response`，用户看到的是
「GitHub 返回了无法识别的 Release 信息」，而不是一片空白或一个错误结论。

## 三、稳定版策略

**稳定版用户不会被提示升级到 prerelease。**

```
0.11.0  →  0.12.0          有更新
0.12.0  →  0.12.0          无更新
0.12.0  →  0.12.1          有更新
0.12.0  →  1.0.0           有更新
0.12.0  →  0.13.0-beta.1   不提示
```

最后一条在代码里显式判一次（`latest.prerelease.length && !current.prerelease.length`
→ 不提示）。数据源本身已经排除了 prerelease，所以这是双保险；它挡的是
「有人把预发布发成了正式 Release」以及以后换成 `releases` 列表接口的情况。

自己就在 prerelease 轨道上的人不受这条限制（同轨道内的前进照常提示）。

## 四、缓存

**内存缓存，TTL 30 分钟。** 只缓存**成功**结果。

- 普通 `GET /api/update` 在 TTL 内直接复用，`cached: true`
- `?force=1` 绕过缓存（手动检查用）
- **失败不写缓存** —— GitHub 抽风一次不该让用户接下来 30 分钟都点不动

不落盘：这是可再生的公开信息，写盘只会多一个需要清理的状态。

## 五、single-flight

同一时刻**只允许一个真实请求在飞**。后到的请求（不论带不带 `force`）
复用同一个 Promise。

```
/api/update?force=1  ┐
/api/update?force=1  ├─→ 只真正请求 GitHub 一次
/api/update?force=1  ┘
```

两层各自独立有效：前端在 `status === 'checking'` 时直接忽略重复点击，
后端再用 single-flight 兜住所有来源（多个窗口、脚本直连）。

## 六、自动检查

启动后**延迟 8 秒**跑一次。

- **不阻塞启动** —— 它是个 `setTimeout`，不在启动路径上（那时 pi 桥接正在拉起，
  并发只会互相干扰）
- **不在启动瞬间请求** —— 同上
- **失败完全静默** —— 连状态都不留，回到 idle；用户没请求过的事不该显示成错误
- **无更新完全静默**
- **不自动弹 Modal** —— 只有真的发现新版时给**一次**轻提示
  （`Pi GUI v0.12.0 已发布 —— 详情见侧栏「诊断」`），同一个版本不重复弹
- 侧栏「诊断」入口上的小点会亮起，作为持久的提醒

自动检查与手动检查**共用同一套状态与缓存**：自动走普通请求（吃缓存、避开限流），
手动走 `force=1`。

## 七、手动检查

侧栏「诊断」→ 顶部「版本」小节 → `[检查更新]`。

状态是**单一字段**，五种取值：

| 状态 | 显示 |
|---|---|
| `idle` | `Pi GUI v<当前版本>` + `[检查更新]` |
| `checking` | `正在检查更新…`（按钮禁用） |
| `latest` | `当前已是最新版本` + `v<当前版本>` |
| `available` | `发现新版本 v0.12.0` + 当前版本 + 发布时间 + 发布说明 + `[查看 Release]` `[安装版]` `[便携版]` `[校验和]` |
| `error` | `暂时无法检查更新` + 具体原因 + `[重试]` |

（本节里的版本号是**示例**，不代表当前版本；当前版本以「诊断」面板显示的为准。）

刻意**不用几个互相冲突的 boolean 拼状态** —— `loading && hasUpdate && !error`
有 8 种取值，其中一半没有意义，而「网络失败显示成已是最新版」正是从这种
状态拼装里长出来的。所以：

> **「暂时无法检查更新」和「当前已是最新版本」是两句话，永远不会互相顶替。**

### Release 说明

GitHub 的 `body` 是**不可信外部 Markdown**，所以：

- 复用项目已有的安全渲染器 `public/markdown.js`（**先整体转义，再插入自己
  生成的白名单标签** ⇒ XSS 在语法层面不成立），**绝不** `innerHTML = release.body`
- 最大展示 4000 字，超出截断并提示「完整内容见 Release 页面」
- 说明里的**链接按 host 白名单在渲染时就收口**（见第八节的
  「Release Notes 里的链接为什么不是 `<a>`」）—— 否则一条
  「[点这里领奖](https://evil.example)」就能把用户引到站外

### 资产识别

按**真实命名**识别，不写死 `installer.exe` / `portable.zip`：

| 规则 | 标签 |
|---|---|
| `/setup\|installer/i` 且 `.exe` | 安装版 |
| `/portable/i` 且 `.zip` | 便携版 |
| `/sha256sums/i` | 校验和 |

**识别不出来的资产不给下载按钮**，只在下面写一行「另有 N 个文件未自动识别，
请在 Release 页面查看」。宁可只留「查看 Release」，也不猜一个可能错的下载文件。

## 八、外链安全

Release / 下载链接必须 **`https:` + GitHub 官方 host**：

```
github.com
api.github.com
githubusercontent.com        （含 objects. / raw. 等 *.githubusercontent.com）
```

`http:` / `file:` / `javascript:` / `data:` / `ftp:` 与任意第三方 host 一律拒绝，
**连响应里都不会出现**（后端先过滤）。

判定在**三个位置**各做一遍，而且**语义完全相同**：

| 位置 | 作用 |
|---|---|
| `server/update-check.js` | 过滤 API 响应，不让站外 URL 进 DOM |
| `public/update.js`（渲染时） | Release Notes 里的链接按 host 收口：白名单外的**退化成纯文本**，白名单内的也不渲染成真 `<a>` |
| `electron/net-probe.cjs` | 主进程在 `shell.openExternal` 之前再拦一次 |

三处都做，因为它们是**三个不同的边界**：后端保护的是「不进 DOM」，
前端保护的是「网页版没有主进程时的最后一道」+「真 `<a>` 的所有触发方式」，
主进程保护的是「即便页面被注入脚本，也打不开站外地址」。

三份实现必须一致，且**两两对拍**（`tests/update-check.cjs` 对后端 ↔ 主进程，
`tests/smoke.cjs` 对前端 ↔ 主进程，传递出三份一致）。
为什么不共享一份：浏览器只能加载 `public/` 下的模块，另外两份分别在
`server/` 与 `electron/` 里、且后者是 CJS —— 跨这三种运行时共享一个模块的代价
比这十行大。

> ⚠️ 这份名单与通用导航用的 `isSafeExternal`（只卡 scheme）**是两回事**，
> 不要合并：收窄通用导航会改变既有行为（对话里的链接会打不开）。

### 谁来决定「能不能打开」

**桌面版是主进程；网页版是前端自己。** 两种形态下都是同一套白名单。

```js
// public/update.js
isSafeReleaseUrl(url)      // ① 先过白名单（两种形态都执行）
  ├─ 有 piGuiDesktop  → bridge.openExternal(url)   // 经 preload 的 contextBridge
  │                     // → ipcMain.handle('pi-gui:open-external')
  │                     // → isSafeReleaseUrl(url) 通过才 shell.openExternal
  └─ 没有（npm start） → 新标签页
```

页面里没有 `shell`、没有 `ipcRenderer`、也不用 `window.open` ——
`tests/electron-guard.cjs` 有几条结构性断言盯着这件事。

**网页版不是「浏览器自己是边界」。** 它没有主进程可转发，所以它**自己**就是
最后一道边界，执行的是同一套 `https + GitHub 官方 host` 白名单 ——
安全语义不因为少了一层而变松。`tests/smoke.cjs` 有专门一组断言在**没有**
`piGuiDesktop` 的条件下验证：站外 host 被拒且**没有真的去打开**、
`javascript:` / `file:` / `data:` / `http:` 全拒、GitHub 官方链接正常放行。

### Release Notes 里的链接为什么不是 `<a>`

`md()` 会把任意 `http(s)` 链接渲染成 `<a href target="_blank">`，而真 `<a>` 的
导航**不止左键一种**：中键走 `auxclick`、右键菜单「在新标签页打开」根本不经 JS。
只在 `click` 上拦，其余路径会落到 Electron 的 `will-navigate`
（那里的判据是宽松的 `isSafeExternal`）或浏览器的默认行为上 —— 语义就漏了。

所以渲染完立刻做一次收口（`sanitizeNoteLinks`）：

- **白名单外** → 退化成纯文本 `文案（URL）`，用户看得见原文但点不动
  （与 `markdown.js` 处理危险 scheme 的做法一致）
- **白名单内** → 换成 `<span data-release-href>`，于是所有触发方式都得走
  `openExternal`

结果：Release Notes 里**一个真 `<a>` 都没有**，绕不过校验。

## 九、无网时会发生什么

**主功能完全不受影响。** 更新检查是纯附加功能：

- `server.js` 启动、Electron 启动、pi bridge、会话、Git、Planner、Diagnostics、
  附件、供应商 —— 一条链路都不依赖它
- 请求有 **8 秒超时**（`AbortController`），不会挂住任何东西
- DNS 失败 / timeout / 403 / rate-limit / 404 / 5xx / 非 JSON / 缺 `tag_name` /
  没有 Release / assets 为空 —— 每一种都被收成一个结构化结果，
  在模块内部处理掉，**绝不向上抛**
- 手动检查明确说「暂时无法检查更新」，并提示「其它功能不受影响」
- 自动检查完全静默
- 网络恢复后点「重试」即可，不需要重启

## 十、隐私

**更新检查只读取公开的 GitHub Release 元数据，不上传 Pi GUI 使用数据。**

请求里**只有**两项 header，都是 GitHub API 必需的：

```
User-Agent: pi-gui/<当前版本>
Accept: application/vnd.github+json
```

没有、也不会有：

- `Authorization` / GitHub token（**不需要认证**，读的是公开仓库）
- Cookie、`X-Pi-Gui-Token` 或任何本地凭据
- cwd、项目名、会话、prompt、模型、供应商
- Agent 信息、Diagnostics 内容
- 用户名、安装 ID、设备 ID
- 任何 telemetry

`tests/update-check.cjs` 用一组哨兵值（假 cwd、假令牌、假 session id、假模型名…）
扫整个请求对象，其中任何一项出现就红。

## 十一、为什么 P5 不自动下载安装

**这一轮明确不做**：自动下载、静默升级、自动覆盖 exe、自动重启安装、
delta update、自定义更新服务器、telemetry、强制更新。

理由按重要性排：

1. **安全边界最简单。** 「下载」按钮只是把用户带到 GitHub 官方 asset URL，
   由系统浏览器下载。后端不代下载、Electron 不写 Downloads 目录、
   不自动运行安装程序 —— 于是这条链路上**没有任何一处**是「程序按外部数据
   决定要执行什么」。一旦做自动安装，就必须回答签名校验、回滚、部分写入、
   升级到一半断电、安装包被替换……每一个都是真正的高危面。
2. **用户自己的决定。** 这是本地开发工具，用户可能正开着会话、正在跑计划。
   「重启完成升级」在什么时候发生，该由用户挑时间。
3. **本轮的价值在「发现」，不在「安装」。** 知道有新版本、能读到发布说明、
   一键打开下载页，已经覆盖了绝大多数需求；自动安装的边际收益远小于它引入的
   复杂度与风险。
4. **它不需要联网之外的任何新能力**，所以以后想加也有清晰的位置：
   下载与安装会是独立的一层，不会把现在的「发现」逻辑改乱。

## 十二、测试

```bash
npm run test:update        # 版本检查（87 项）
```

覆盖：SemVer 边界（含非法版本与 prerelease 优先级）、13 种 GitHub 响应形态、
缓存与 TTL、并发 single-flight、请求隐私、路由与鉴权、外链白名单
（含与主进程实现的一致性对拍）。

**默认测试绝不访问真实 GitHub** —— 所有请求都走注入的假 fetch，
而且有一条断言盯着「假 fetch 真的被用上了」。

前端部分在 `tests/smoke.cjs` 的「版本检查与更新体验」一节（61 项）：
状态机五种取值、连点、关闭再开、恶意 Release Notes（含「一个真 `<a>` 都没有」）、
**网页版 fallback 的白名单**（站外 host 被拒且没有真的去打开）、
前端白名单与主进程实现的对拍、自动检查的静默与轻提示。
主进程外链判定在 `tests/electron-guard.cjs`。

# 第二部分：Pi 运行时更新（`/api/pi-update`）

**这一部分管的是「本机装着的那个 pi」** —— Pi GUI 驱动的外部 runtime ——
不是 Pi GUI 自己。上面那部分的 GitHub Release、`/api/update`、`public/update.js`
与它**不共用任何状态、任何缓存、任何一条文案**：它的模块是
`server/pi-update.js` + `public/pi-update.js`，端点是 `/api/pi-update`。

**为什么原则恰好相反。** 上游 pi 是外部程序，升级它会改变 RPC / MCP / Extension
契约（P23 那套 probe 矩阵的前提）。所以这里：**检查可以自动，安装必须由人点** ——
`自动检查 yes / 自动安装 never`。

## 十三、检查（`GET /api/pi-update`）

```
GET /api/pi-update              走缓存（30 分钟内直接复用）
GET /api/pi-update?force=1      绕过缓存（用户点「检查 Pi 更新」时用）
```

固定的一个公开接口：

```
GET https://pi.dev/api/latest-version
```

- **超时 8 秒**，**TTL 30 分钟**，**single-flight**（并发调用只打一次公网），
  **只缓存成功结果**（失败不写缓存，点「重试」立刻可以重来）。
- 请求里**只有** `User-Agent: pi-gui/<GUI 版本>` 与 `Accept: application/json`；
  `redirect: 'error'`（`packageName` 这类判据不能被一次跳转绕过去）。
  没有 cookie / token / cwd / 项目名 / 会话 / 模型 / provider。
- 响应只取白名单字段。其中 **`packageName` 必须严格等于
  `@earendil-works/pi-coding-agent`**，否则整条判失败（`foreign-package`）——
  版本接口换个包名就等于「这批信息不是给这份 pi 的」，绝不能据此去执行更新。
- **永不抛**：失败一律收成结构化结果，HTTP 层仍然回 200（业务失败不用 5xx）。
  `errorCode` 是内部类型：`offline` / `no-fetch` / `timeout` / `network` /
  `http-error` / `invalid-response` / `foreign-package`。
- `reason` 说明「为什么现在不能更新」，给人看的一句话由前端按码选文案：
  `latest`（已是最新）、`version-unknown`（读不到本机版本号）、
  `no-proven-entry`（证明不到官方安装入口）。**「读不到」不等于「不支持」**。
- `canUpdate` 只有同时满足「真的有新版」**且**「官方入口证明得出来」才为 true。

### 相位（只有这几个字符串）

```
idle → checking → available → updating → verifying → restarting → latest
                     └──────────── failed ────────────┘
```

前端**只认这几个值**，不自己拼 `loading && hasUpdate && !error` 那种状态 ——
拼装的取值空间里必然长出「按钮说可以更新、其实正在更新」这类自相矛盾的界面。

### 自动检查

启动后**延迟 12 秒只检查一次**（比 Pi GUI 自己的 8 秒再晚一点：pi 的版本探测要走一次
pi 包的读盘）。它**不阻塞启动、不轮询、绝不安装**，吃 TTL 缓存；自动那一次失败
**完全静默**（连状态都不留），同一个 `latestVersion` 在整个应用生命周期里**只轻提示一次**
（`Pi <版本> 可用 —— 在侧栏「诊断」里可以更新`），并点亮诊断入口上的小点。

### 离线

`PI_OFFLINE=1`（或 `PI_GUI_OFFLINE=1`）时**完全不发请求**，直接回
`{ok:false, code:'offline'}`。这个变量是本轮为「公网检查」新加的 ——
仓库里以前没有离线开关，旧的 GUI 版本检查只是「失败了也不抛」。

## 十四、执行更新（`POST /api/pi-update`）

```json
{
  "action": "update",
  "confirm": true,
  "expectedCurrentVersion": "0.99.2",
  "expectedLatestVersion": "1.0.0",
  "__expectedCwd": "C:\\项目"
}
```

**`confirm: true` 是硬要求**，缺了就是 `confirm-required`，一个字都不执行。
`__expectedCwd` 是既有的工作区过期守卫（切换项目会让 pi 以新 cwd 重启，
在那次重启里替换 runtime 文件正是要避免的）：对不上是 `workspace-stale`。

**renderer 不能传执行参数。** 只认上面这五个字段；`command` / `args` /
`packageName` / `version` / `url` / `env` **一律忽略** ——
所以这个端点不可能是「任意命令执行器」。

**目标版本不采信前端口述。** 服务端重新确认一次最新版本，并把前端带上来的
`currentVersion` / `latestVersion` 各自再校一遍：对不上就是 `stale-current` /
`stale-target`（不更新，请刷新再来）。

**闸门在后端，前端的 disabled 按钮不算数。** 服务端自己再查一遍，命中任何一条都拒绝：

| 闸门 | code | 判据来自 |
|---|---|---|
| 正在生成的回合 | `busy-turn` | pi 自己的事件（`turnActive`） |
| 在飞的 Pi CLI 动作（例如 MCP 登录） | `busy-cli` | CLI 动作计数 |
| 跑着的 Planner 任务 / 独立验证 | `busy-plan` | planner 的 `projectSwitchBlockReason()`（规则只有一份） |
| 另一条更新正在跑 | `update-running` | 模块自己的单飞锁 |
| 工作区正在切 | `workspace-stale` | `__expectedCwd` |
| 判不出忙不忙 | `busy-unknown` | 上面那条查询抛错 → **fail closed** |

**只跑官方 self-update，而且只跑证明过的那一份 pi。** 唯一会被执行的命令是：

```
<当前 launch identity 的官方入口> update --self
```

入口由 `piLaunch.packageDir()` → `buildPiEntry()` 派生，并且**在闸门那一步解析一次之后
一路带下去**（执行时用的就是闸门解析出来的那个 entry 对象，不是重新找的一份）——
身份同源，不存在「检查的是 A、更新的是 B」。证明不了就是 `unsupported`：
「当前这份 Pi 无法通过官方 self-update 更新」—— **绝不退回 PATH 上的另一份 `pi`**
（P20.5「两份 identity」的老坑），不 `npm install -g`、不 pnpm / bun / curl、
不下载执行安装包、不更新 Extension / Node / `models.json`。

**异步执行。** 确认与闸门都过了之后立刻回 **202 accepted + `phase: 'updating'`**，
前端按 2 秒一次轮询相位（上限 150 次 ≈ 5 分钟，与后端 `updateTimeoutMs` 同量级）。
非 GET / POST 是 **405**；请求体不是合法 JSON 是 **400 `bad-body`**。

更新这条路上的失败码分两层，**两层都不是「已更新」**：

- **闸门层**（还没有暂停 bridge，一个字节都没改）：`confirm-required` / `bad-action` /
  `update-running` / `workspace-stale` / `offline` / `stale-current` / `stale-target` /
  `no-update` / `check-failed` / `busy-*`（`busy-turn`、`busy-cli`、`busy-plan`、
  `busy-unknown`）/ `unsupported`。
- **执行层**（bridge 已经被暂停）：`pause-failed`（**没停成，所以不 resume** ——
  那不是我们停的 bridge，掀掉别人的维护态只会更糟）/ `update-timeout` /
  `update-spawn-failed` / `update-failed` / `verify-failed`（这几个都在 `finally` 里
  恢复 bridge）。

失败时界面说的是「Pi 更新没有成功」并给出原因，**不会把状态清成「已是最新」**
（那正是「失败与无更新必须说成两句话」这条既有原则）。

## 十五、维护暂停（bridge maintenance）

更新期间 pi 子进程必须先停下来（正在被替换的文件不能同时是「正在跑的那个程序」），
所以 `server/rpc-bridge.js` 提供了两个动作：

```
rpc.pauseForMaintenance(reason)     // 停掉当前 child，等它真的退出
rpc.resumeFromMaintenance()         // 恢复正常启动 —— 只启动一次
```

暂停期间的语义（这几条是更新流程的地基，改动前先读 `rpc-bridge.js` 的文件头）：

- `send()` 抛、`request()` 回 `null`（挂起请求立刻安全 settle，没人干等到超时）
- `restart()` 是 no-op；child 退出**不触发自动重启**
- **`crashStreak` / backoff 一个都不动** —— 维护不是崩溃
- 广播 `bridge_status {state:'maintenance', phase:'pausing'|'stopped', reason}`
- 已经在维护中再调一次 → `{ok:false, code:'already-in-maintenance'}`（不嵌套）
- `getState().maintenance` 暴露 `{reason, at}`，所以**刷新页面之后仍能渲染维护态**

它**刻意不复用** `runtime.shuttingDown`：那个的意思是「Pi GUI 要退出了」，
两种状态的原因、持续时间和恢复路径都不一样，混用会让界面说出错误的原因。

**已经暂停之后的任何失败路径都会 `resumeFromMaintenance()`**（`finally` 里做）：
更新失败、超时、updater 起不来、复验不通过 —— 一律恢复，GUI 不会永久停在维护态；
旧的那份 pi 还能起来就继续能用。`resume` 自己抛错也不会盖掉真正的失败原因。

## 十六、成功判定：退出码 0 ≠ 更新完成

官方 updater 正常结束**不构成成功证据**。顺序是固定的：

1. 清掉**所有与 pi 包 identity 绑定的缓存**（顺序即语义：`piLaunch` → `piVersion` →
   `piBuiltins` → `probes` → `mcpNative` → `piCompat`）—— 不清就会拿着旧 pi 的结论
   继续显示；
2. 用**同一个 launch identity** `force: true` 重新读一次版本；
3. 读到的版本**等于**目标版本才报「Pi 已更新至 x」；否则 `verify-failed`
   （`installedVersion` 如实带出来，不写成功）。

这样「UI 说更新成功、实际还是旧版本」在结构上不成立。

## 十七、诊断里的它

诊断快照里的 `piUpdate` 块与 `bridge.maintenance` 都是**只读投影**，
**一个网络请求都不发**（只看缓存与最近一次结果）。字段与含义见
[diagnostics.md](diagnostics.md)。

## 十八、测试

```bash
npm run test:pi-update        # 81 项（已纳入 npm test）
```

覆盖：检查的 TTL / single-flight / `force` / 超时 / 网络失败 / 离线 / 响应形状 /
包名不符 / 请求隐私；更新动作的确认、过期、no-op、**固定参数
`['update','--self']`**、任意参数被忽略、闸门与并发；维护态不自动重启、只 resume 一次、
`crashStreak` 不动；identity 的解析次数有界、**执行用的是闸门解析出的那个入口对象**、
没有 PATH fallback；缓存失效与版本复验；静态边界扫描（这个模块里不可能出现第二种
安装方式）；HTTP 层的 405 / bad-body / 202 / 离线。细节见 [testing.md](testing.md)。

**默认测试绝不访问 `pi.dev`，也绝不跑真 pi 的 updater** —— 检查用的 `fetch` 与
执行用的 runner 全部是注入的替身，请求没走到替身上 A 段直接就红。

## 相关文档

- [architecture.md](architecture.md) — 模块地图
- [security.md](security.md) — 安全边界（含外链、渲染进程权限与「Pi 运行时更新边界」）
- [diagnostics.md](diagnostics.md) — 诊断面板里的「版本」小节与 `piUpdate` 快照
- [testing.md](testing.md) — 测试分层（`test:update` 与 `test:pi-update`）
- [upgrade-playbook.md](upgrade-playbook.md) — 升级 pi 的完整流程（内置更新器只是它的便利层）
- [pi-compatibility.md](pi-compatibility.md) — 更新之后「这个版本我们核过没有」
- [development.md](development.md) — 发版流程（发完版更新检查就能看到）
