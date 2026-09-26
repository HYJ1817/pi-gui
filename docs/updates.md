# 版本检查与更新

Pi GUI 能告诉你「有没有新版本」，并把发布说明摆出来，再让你自己点开 GitHub 的
Release 页面或安装包。

**它不会替你下载、不会替你安装、不会静默升级。** 这一节的最后一段解释为什么。

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

## 十三、相关文档

- [architecture.md](architecture.md) — 模块地图
- [security.md](security.md) — 安全边界（含外链与渲染进程权限）
- [diagnostics.md](diagnostics.md) — 诊断面板里的「版本」小节
- [testing.md](testing.md) — 测试分层
- [development.md](development.md) — 发版流程（发完版更新检查就能看到）
