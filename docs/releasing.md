# 发版

一条可以照着敲的流程。目标是「人决定版本，机器验证并发布」——
版本号由人定，其余（构建、测试、打包、校验和、上传、核对）全部交给脚本与 CI。

```bash
# 0. main 上全绿、工作区干净
git status -sb && git pull

# 1. 改版本号（同步 package.json + package-lock.json）
npm run version:set -- 0.13.0

# 2. 更新本版摘要（首行版本标记也要同步）
#    编辑 .github/release-summary.md，写 3–6 条用户能看懂的变化

# 3. 本机跑完整发布预检（版本 + 摘要 + 全部测试 + 两条打包链路 + 产物验证 + 校验和）
npm run release:check -- --with-installer
#   → 最后一行必须是 READY TO RELEASE

# 4. 提交并推送
git add package.json package-lock.json .github/release-summary.md
git commit -m "v0.13.0"
git push

# 5. 打 tag 并推送 —— **这一步才会触发发布**
git tag v0.13.0
git push origin v0.13.0

# 6. 等 GitHub Actions 的 Release workflow 跑完（约 10-15 分钟）

# 7. 核对 Release
gh release view v0.13.0 --json isDraft,assets -q '.isDraft, (.assets[] | .name)'

# 8. 用**旧版本**的 Pi GUI 手动点一次「检查更新」，确认能发现 0.13.0
```

> 版本号示例用 `0.13.0`。实际以你决定的下一个版本为准。

## 一、版本号必须在 tag **之前**进仓库

这是整条流程里最容易被忽略、也最要紧的一条：

> tag 只是证明「**这个 commit 就是 0.13.0**」，它不负责把代码改成 0.13.0。

所以 workflow **不会**根据 tag 去改 `package.json`。如果 tag 是 `v0.13.0`
而 `package.json` 还是 `0.12.0`，预检会直接失败：

```
✗ tag 与 package.json 的版本不匹配：tag="v0.13.0"，期望 "v0.12.0"
```

**不要「猜一个版本然后继续」。** 那样 release 的 source code 与 tag 声称的
内容就不一致了 —— 用户下到的源码包里写着别的版本号，而这件事没有任何地方会报错。

## 二、版本号只有一个来源

`package.json` 是唯一需要手改的地方（`version:set` 会连同 `package-lock.json`
一起改）。其余全是**派生**的：

| 地方 | 怎么来的 |
|---|---|
| `package-lock.json` 的两处 | `version:set` 同步（顶层 `version` + `packages[""].version`） |
| Electron 应用的 `package.json` | `scripts/build-app.mjs` 构建时从 `package.json` 写 |
| `/api/health`、Diagnostics、更新检查 | `server.js` 的 `VERSION`（打包期 esbuild `--define:__PI_GUI_VERSION__` 写死，开发期读 `package.json`） |
| 安装程序的版本 | `/DVERSION=` 传给 NSIS（`installer/pi-gui.nsi` 有 `!ifndef → !error` 守卫） |
| 产物文件名 | 构建脚本拼（`Pi-GUI-Setup-<v>.exe` / `Pi-GUI-<v>-portable.zip`） |

`scripts/check-version.mjs` 会反过来扫一遍**构建 / 发布链路**
（`installer/*.nsi`、`.github/workflows/*.yml`、`scripts/*.mjs`、`electron/*.cjs`），
发现谁把版本号写死了就失败 —— 写死一份就等于多了一个版本源，而它不会跟着走。

刻意**不**扫 `tests/` 与 `docs/`：测试里的版本号是桩值（`tests/smoke.cjs` 明确
写了「故意不跟 package.json 联动」），文档里的历史版本是叙述。

`.github/release-summary.md` 也不是版本源，它只是“本次准备发布什么”的短文案。
首行必须写 `<!-- pi-gui-release-summary: <版本> -->`，版本一致性校验会要求这里的
版本与 `package.json` 完全相同。这样 bump 版本后忘记改摘要会直接报错，不会把
上一版的说明带进下一版。

### 只支持稳定版

```bash
npm run version:set -- 0.13.0-beta.1     # 允许（本地迭代）
npm run version:check -- --tag=v0.13.0-beta.1   # 拒绝（发布时）
```

理由：P5 的应用内更新检查读的是 GitHub 的 `/releases/latest`，它按定义
**不含 prerelease** —— 发一个 beta 出去，应用内根本发现不了，
用户会以为「发布成功了但没生效」。所以宁可明确拒绝，
也不要发一个「发得出去但看不到」的版本。

## 三、正式资产与命名契约

Release 上**只有三个附件**：

| 文件 | 类型（P5 的 `classifyAsset`） |
|---|---|
| `Pi-GUI-Setup-<版本>.exe` | `installer` → 应用内显示「安装版」 |
| `Pi-GUI-<版本>-portable.zip` | `portable` → 应用内显示「便携版」 |
| `SHA256SUMS.txt` | `checksums` → 应用内显示「校验和」 |

⚠️ **便携版必须是真正的 zip。** 打包走 bsdtar（Windows 10+ 自带的
`C:\Windows\System32\tar.exe`）并显式传 `--format=zip` ——
**不能用 PATH 上的 `tar -a`**：Git for Windows 的 GNU tar 不支持 zip，
`-a` 对 `.zip` 既不报错也不压缩，会**静默产出一个普通 tar**，
Windows 用户双击打不开。发布守卫除了查开头 `PK\x03\x04`，
还会查末尾的**中央目录结尾记录（EOCD）**，就是为了拦这个形态。

⚠️ **改文件名必须同步 `server/update-check.js` 的 `classifyAsset()`。**
不同步的后果是：Release 发得很成功，而用户那边的更新面板只有「查看 Release」、
没有「安装版 / 便携版」按钮 —— 这个失败**在用户那边**才暴露。

所以 `scripts/check-release-artifacts.mjs` 直接**复用** `classifyAsset()` 来验
正式资产：命名契约与 P5 的分类规则漂了，发布预检就会红。

`build/Pi GUI.exe`（Node SEA 单文件）**不是** Release 资产，不进 `dist-release/`。
它仍然是构建链路的一环（`build:app` 内部会跑 `build:exe`），只是不作为附件发布 ——
多一个含义模糊的附件只会让人不知道该下哪个。

## 四、发布目录 `dist-release/`

```
dist-app/           构建中间产物（Electron 应用目录）
dist-installer/     构建中间产物（Setup.exe / portable.zip / 本地用的校验和）
dist-release/       ← 只放要上传的那三个文件
```

`npm run release:collect` 会**清空重建** `dist-release/`，从 `dist-installer/`
按期望文件名精确取两个二进制，然后在**目标目录**重新算一遍 `SHA256SUMS.txt` ——
覆盖的就是「真正要上传的那几个字节」，而不是源目录那份。

`release.yml` 只上传 `dist-release/*`，不对整个项目 glob。
`dist-release/` 与 `dist-installer/` 都在 `.gitignore` 里。

## 五、`release:check` 做了什么

一条命令，顺序钉在代码里（`scripts/release-check.mjs`）：

1. **版本一致性** —— package / lock /（可选）tag，外加「构建链路里有没有写死版本号」
2. **`npm test`** —— 全部 24 个套件
3. **`build:app --rebuild`** → `fixtures` → `test:app` → `test:exe`
4. **`build:installer --zip`** → `test:portable` →（`--with-installer` 时）`test:installer`
5. **`release:collect`** —— 集中到 `dist-release/` 并重算校验和
6. **产物守卫** —— 见下
7. **独立复算 SHA256** —— 模拟「用户拿到文件之后会做的事」

通过时最后一行是 `READY TO RELEASE`。

### `--with-installer` 为什么是显式开关

`test:installer` 会**真的安装** Pi GUI（写注册表、建快捷方式），测完再卸掉。
在一次性 runner 上没问题，但开发机上可能装着一份**你自己在用的** Pi GUI ——
跑一遍就把它卸了。所以本机默认不跑，CI 显式传。

代价是：不带这个开关时，安装程序**没有被真正执行过**。半截的 `Setup.exe`
（名字、大小、校验和全都正常）只有真去装才会暴露。脚本会把这件事明确打出来。

## 六、产物守卫查什么

`npm run release:verify`（`scripts/check-release-artifacts.mjs`）：

- **白名单**：`dist-release/` 里只允许那三个文件，多一个都不行
- **存在 + 非空 + 魔数**：`.exe` 必须是 `MZ`、`.zip` 必须是 `PK\x03\x04` ——
  挡「下载失败把 HTML 错误页存成 .exe」和「被中断的构建留下的半截文件」
- **版本一致**：文件名里的版本必须等于 `package.json`（上次的产物没清会在这里红）
- **语义唯一**：不允许两个文件都被 `classifyAsset` 认成 `installer`
- **P5 兼容**：三个资产必须分别被识别成 `installer` / `portable` / `checksums`
- **校验和**：格式合法、无绝对路径、与文件逐一对得上、且**反向覆盖完整**
  （目录里的正式文件必须都在清单里 —— 防止「传了但没登记」）
- **构建 metadata**：`dist-app/.../resources/app/package.json` 的版本必须一致
  （产物是旧版本打的会在这里红）

明确不许出现的形态（会给出看得懂的原因）：`fake-pi.*`、`test-fixtures*`、
`*.log` / `*.dmp` / `*.tmp`、`.env`、`*.pdb` / `*.map`、源码文件。

## 七、Release workflow（tag 触发）

```yaml
on:
  push:
    tags: ['v*']
permissions:
  contents: write      # 只开这一个
```

**不挂 `push main`** —— 每次合并都发版不可接受，而且版本号必须由人决定。

顺序（**全部验证通过之后才碰 GitHub**）：

```
checkout → setup-node → npm ci → 装 NSIS
  → npm run release:check -- --tag=<tag> --with-installer   ← 任何一步失败：还没有 Release
  → node scripts/publish-release.mjs --tag=<tag>            ← 下面这些全在这个脚本里
      · 判断 tag 上 Release 的状态（没有→create draft / 只剩 draft→复用 / 已发布→**失败**）
      · 上传 dist-release/*
      · 核对 GitHub 报告的 sha256 / 大小 / 附件数与本地是否一致
      · 追加「交付物 / 前置条件」说明
      · 最后才 --draft=false，然后再确认一次已发布且附件数正确
```

**业务逻辑在 `scripts/` 里，YAML 只做编排** —— 因为 YAML **没法单元测试**，
而「已发布必须拒绝 / 只剩 draft 才复用 / 核对不过绝不 publish / publish 排最后」
这几条正是最容易错的分支。挪进脚本之后，注入一个假 gh 就能把分支表全测一遍
（见 `tests/release-artifacts.cjs` 的「发布编排」一节）。
`.probe/validate-workflows.cjs` 还有一条断言守着：**release.yml 里不许出现裸的
`gh release` 命令** —— 防止有人图省事把逻辑搬回 YAML。

### 为什么用 draft 兜上传

上传可能中途失败，而 GitHub 没有事务。draft 对用户不可见，
上传 + 核对全过了才 publish —— 所以**不会出现「正式 Release 页面已经发布、
但便携版没传成功」**。

### 重复执行

| tag 上的状态 | 行为 |
|---|---|
| 没有 Release | 创建 draft，正常走 |
| 只有 draft（上次失败留下的） | **复用**它继续上传（`--clobber`） |
| 已经有**已发布**的 Release | **直接失败**，提示人工处理 —— 绝不覆盖已发布的二进制 |

### 上传之后的核对

`gh release upload` 的退出码是 0 只说明「这条命令跑完了」，
不说明「Release 上现在有三个正确的文件」。所以上传后比对 GitHub 报告的
附件名 / 大小 / `sha256` 摘要与本地是否逐项一致（逻辑在
`scripts/verify-uploaded-release.mjs`）。GitHub 的摘要值是**它自己**对收到的
字节算的 —— 一致才说明「用户下载到的就是本地验证过的那份」。

发布之后再确认一次 `isDraft === false` 且附件数为 3。
**不把「publish 命令退出 0」当成完整成功判据。**

想只彩排到「核对通过」而不发布，可以手动跑：

```bash
node scripts/publish-release.mjs --tag=v0.13.0 --dry-run
```

⚠️ 它不是零副作用 —— `gh release create` 会按需在远端创建 tag，
所以它仍会留下一个 **draft**（draft 对用户不可见，后续真发布会复用它）。

## 八、Release Notes

Release 页面现在分三层，顺序固定：

1. `.github/release-summary.md` 的“本版摘要” —— 只写 3–6 条用户最关心的变化。
2. GitHub 自动生成的 notes（`gh release create --generate-notes`）—— 保留完整提交范围与 Full Changelog。
3. 脚本追加的固定交付说明 —— 三个附件分别是什么、怎么核对 SHA-256、前置条件是什么。

摘要文件只维护**当前准备发布的版本**，历史版本不在仓库里重复保存；一旦发布，
那一版文字已经永久保存在 GitHub Release 页面。下一次发版直接覆写这一个文件即可，
所以它不是第二套 CHANGELOG。

摘要首行的版本标记会被 `version:check` 校验。正文由人写，版本由机器核对：
既避免自动 notes 只有一个 Full Changelog 链接，也避免把上一版摘要误发到下一版。

发布脚本给“本版摘要”和“交付物”各加了内部 HTML marker。复用 draft、先 dry-run
再正式发布时会先剥掉旧的 managed block 再重写，所以不会越跑越多、重复叠加。

固定交付文案继续使用 `<版本>` 占位，不把具体版本号写死在发布脚本里。

## 九、权限与供应链

- `permissions: contents: write`，**只有这一个**。不要 issues / pull-requests /
  actions / packages。
- 用内置的 **`GITHUB_TOKEN`**，**不用个人 PAT**（PAT 会绕过分支保护、
  无法随仓库转移、也容易过期）。
- Actions 只用 `actions/checkout` 与 `actions/setup-node`（钉 `v5`，与 ci.yml
  一致；选 v5 的理由见 ci.yml 头部）。
- zip 与 SHA-256 都用 Node 自带能力（`tar` / `node:crypto`）解决，
  **不引入陌生的第三方 Action**。
- workflow 里不 `curl | bash` 任何东西。唯一的 CI 专用依赖是 NSIS，
  通过 `choco install nsis` 装。

## 十、发完之后

1. `gh release view <tag> --json assets` —— 三个附件都在
2. 用**旧版本**的 Pi GUI 手动点「检查更新」，确认能发现新版本、
   并且有「安装版 / 便携版」按钮（不是只有「查看 Release」）
3. 应用内更新检查有 **30 分钟缓存** —— 刚发完自己测要点 `[检查更新]`
   （它带 `?force=1`），自动检查走的是缓存

## 十一、本机手工验证（不打 tag）

不想触发发布、只想确认「这批东西能发」时：

```bash
npm run version:check                     # 版本一致
npm run release:prepare                   # 构建 + 产物验证 + 守卫（不跑 npm test）
npm run release:verify                    # 只看产物守卫
node scripts/make-checksums.mjs --dir=dist-release    # 重新生成校验和
```

手工核一个文件的 SHA-256 与 `SHA256SUMS.txt` 是否一致：

```powershell
certutil -hashfile dist-release\Pi-GUI-Setup-0.13.0.exe SHA256
```

## 十二、已知问题：v0.11.1 及更早的便携版不是 zip

**发到 v0.11.1 为止的 `Pi-GUI-<版本>-portable.zip` 实际上是 tar 归档**，
只是扩展名写成了 `.zip`。成因见 [development.md](development.md) 的「坑」一节
（`build-installer` 用了 GNU tar 的 `-a`，而 GNU tar 不支持 zip 且不报错）。

影响：**Windows 资源管理器双击打不开**，系统自带的解压会报
「找不到中央目录结尾记录」。文件本身没坏 —— 内容完整，只是格式与扩展名不符
（`SHA256SUMS.txt` 与它是对的上的：算的就是这份字节）。

**v0.11.1 的 Release 页面已经加了一段同样的说明**（含临时办法）——
只改了页面文字，**没有动任何二进制**：三个附件的 `size` 与 sha256 都还是发布时的值，
（`download_count` 是 0，没有用户受影响）。要不要换成正确的 zip 由维护者决定；
不换的理由是「不覆盖已发布的二进制」这条原则（见第七节）。

临时办法（任选其一）：

1. 用系统自带的 `tar` 解 —— 它能读 tar：`tar -xf Pi-GUI-0.11.1-portable.zip`
2. 用 7-Zip / WinRAR 解 —— 它们按内容识别，不看扩展名

**v0.12.0 起已修复**，而且顺带把体积从 342 MB 降到 141 MB ——
旧产物是**零压缩的 tar**，新产物是正常 deflate 压缩的 zip。

发布守卫现在会验「开头是 `PK\x03\x04` 且末尾有中央目录结尾记录（EOCD）」，
这个形态不会再发出去。`test:portable` 也补了同样的断言 ——
它以前解压用的是同一个 GNU tar，所以看不出来（**造和验用同一把错误的尺子**）。

## 十三、相关文档

- [development.md](development.md) — 三种构建形态、离线 / 代理构建
- [testing.md](testing.md) — 测试分层（哪一层在哪个 workflow 里跑）
- [updates.md](updates.md) — 应用内怎么发现新版本（资产命名为什么不能乱改）
