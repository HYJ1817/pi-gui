# 开发与构建

面向维护者：怎么从源码跑、怎么构建三种形态、怎么发版，以及这条路上踩过的坑。

## 一、从源码跑

```bash
npm install
npm start          # 只跑后端，用浏览器开 http://127.0.0.1:7788
npm run app        # 桌面窗口（Electron 会自己拉起一份后端，不用先 npm start）
```

改前端时用 `npm start` 更快（改完刷新页面即可）；`npm run app` 每次都要重启进程。

## 二、三种形态，三条资源解析路径

**这是最容易踩的坑**：改了 `public/` 之后，只有源码树那条路是「实时」的。

| 你跑的东西 | 静态资源从哪来 | 改 `public/` 后要不要重建 |
|---|---|---|
| `node server.js` / `npm start` / `npm run app` | 直接读项目里的 `public/` | **不用**，刷新即可 |
| `build/Pi GUI.exe`（Node SEA 单文件） | **内嵌在 exe 里**（`sea.getAsset`） | **必须 `npm run build:exe`** |
| `dist-app/Pi GUI-win32-x64/`（Electron） | 构建时**拷到** `resources/app/public/` | **必须 `npm run build:app -- --rebuild`** |

判定代码在 `lib/assets.js`：`IN_SEA` 为真走内嵌，否则读 `ROOT/public/...`
（Electron 下 `ROOT` 就是 `resources/app`）。

> **在说「改完了」之前，要么重建产物，要么明确告诉用户「跑源码版才看得到」。**
> 只跑测试就宣布改完，用户打开打包版看到的还是旧界面 —— 这件事发生过。

验证产物里到底有没有新代码，最快的办法是**直接在文件里搜标记**：

```bash
grep -c "某个新标记" "dist-app/Pi GUI-win32-x64/resources/app/public/xxx.js"
node -e "const fs=require('fs');console.log(fs.readFileSync('build/Pi GUI.exe').includes(Buffer.from('某个新标记')))"
```

## 三、构建命令

| 命令 | 产物 | 说明 |
|---|---|---|
| `npm run build:exe` | `build/Pi GUI.exe`（SEA）+ `build/server.cjs` | esbuild 打后端单文件 → 生成 SEA blob → 注入 node.exe |
| `npm run build:app` | `dist-app/<App>-win32-x64/` | 组装应用目录 + `@electron/packager` 打包 |
| `npm run build:installer -- --zip` | `dist-installer/`（Setup.exe + portable.zip + SHA256SUMS.txt） | 需要 NSIS 的 `makensis` |
| `npm run build:dist` | = `build:app` + `build:installer --zip` | |
| `npm run release:check` | 无（只读产物） | 发布预检一条命令跑完；见 [releasing.md](releasing.md) |
| `npm run release:collect` | `dist-release/`（Setup + portable + SHA256SUMS.txt） | 只收正式资产，上传前跑 |

### `--rebuild` 是什么意思

`build:app` 默认会**复用已有的** `build/server.cjs`。改了 `server.js` 或
`public/` 之后要加 `--rebuild`，否则改动不会进包：

```bash
npm run build:app -- --rebuild
```

`--rebuild` 影响的是后端产物；前端 `public/` 每次构建都会重新拷进包里。

> `build:app --rebuild` 内部会先跑一遍 `build:exe`，所以两条打包链路
> （SEA 与 Electron）一次都能验到。

### 离线 / 代理构建

打包那一步默认会去 GitHub 取 Electron 发行包（顺带取一份 `SHASUMS256.txt`
校验）。网络不通时，即使 zip 已经在本机 Electron 缓存里，它也会因为拿不到
校验和而判定「缓存不匹配」、退回重新下载，最后整个构建挂掉。

**首选解法：让 Node 内置的 fetch 尊重环境代理。**

```bash
NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7890 npm run build:app -- --rebuild
```

Node 内置 `fetch`（undici）默认**不读** `HTTPS_PROXY` / `http_proxy`，
而 `@electron/packager` 正是用它去取校验和 —— 所以代理设得再对也没用。
`NODE_USE_ENV_PROXY=1` 是 Node 24 的开关，开了之后这条链路才认环境变量。
这条路**保留了校验和验证**。

**兜底解法（跳过校验，只在上面那条也不行时用）：**

```bash
PI_GUI_ELECTRON_ZIP_DIR="$LOCALAPPDATA/electron/Cache/<hash>" npm run build:app
```

`<hash>` 是缓存目录名，按 URL 的 sha256 算出来，不同版本不一样 ——
进去看一眼哪个目录里有对应的 `electron-v<版本>-win32-x64.zip` 就知道。

**注意两条链路要分别设**：`git` 走的是自己的 `http.proxy` 配置（不是环境变量），
`gh` 走环境变量。

### 安装程序需要 NSIS

`build:installer` 要找 `makensis`。查找顺序：`--nsis=<路径>` 显式指定 →
PATH → `%ProgramFiles(x86)%\NSIS` → electron-builder 的缓存。
找不到时会给出明确的获取方式。

## 四、发版流程

**完整流程见 [releasing.md](releasing.md)** —— 那一篇是照着敲的步骤清单。
这里只留最短的版本和两条不能忘的规矩：

```bash
npm run version:set -- 0.13.0             # 同步 package.json + package-lock.json
npm run release:check -- --with-installer # 版本 + 全部测试 + 两条打包链路 + 产物守卫
#   → 最后一行必须是 READY TO RELEASE
git add package.json package-lock.json && git commit -m "v0.13.0" && git push
git tag v0.13.0 && git push origin v0.13.0   # ← 这一步才触发发布
```

`release:check` 把原先散在文档里的 8 条命令收成了一条，而且**顺序钉在代码里**
（`scripts/release-check.mjs`）—— 靠记忆执行多步流程，迟早会漏掉
「没验产物就上传」那一步。

两条不能忘的：

1. **版本号必须在 tag 之前进仓库。** workflow 不会根据 tag 改 `package.json`；
   两者不一致时预检直接失败。tag 只是证明「这个 commit 就是 0.13.0」。
2. **`--with-installer` 在 CI 上必须带。** 它会让安装程序**真的装一遍再卸掉**，
   而安装程序是「构建成功但一跑就废」的重灾区 —— 名字、大小、校验和都验不出
   （实测踩到过：被中断的构建留下一个 48 MB 的半截 Setup.exe，而正常是 100 MB）。
   本机默认不带，是因为开发机上可能装着一份你在用的 Pi GUI。

单跑某一环（不需要全量）：

```bash
npm run version:check          # 版本一致性（可加 --tag=v0.13.0）
npm run release:prepare        # 只构建 + 产物验证 + 守卫（跳过 npm test）
npm run release:collect        # 集中正式资产到 dist-release/
npm run release:verify         # 只看发布产物守卫
npm run test:update            # 版本检查那套（不需要构建产物）
```

### 发完版之后：应用内就能看到

Release 一发出来，Pi GUI 的「诊断 → 版本」就会读到它（[updates.md](updates.md)）。
两件事值得知道：

- **缓存 30 分钟**。刚发完版自己测的时候要点 `[检查更新]`（它带 `?force=1`），
  自动检查走的是缓存。
- **版本号只有一个来源**：`server.js` 的 `VERSION`（打包期由 esbuild 写死，
  开发期读 `package.json`），它同时喂给 `/api/health`、诊断快照和更新检查。
  所以发版时改 `package.json` 就够，**不要**在别处再写一份版本号 ——
  `scripts/check-version.mjs` 会扫构建 / 发布链路，写死就红。

### 核实要做两条独立路径

不能只看一条：

1. **附件摘要**：`gh release view --json assets` 返回的 `digest` 与本地
   `sha256sum` 逐位比对（`release.yml` 已经自动做了这件事，
   见 `scripts/verify-uploaded-release.mjs`）
2. **git 侧**：`git fetch origin main --tags` 后比对本地/远端 ref，
   并用 `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` 确认 tag 指向

`git ls-remote` 报 502 **不代表 tag 不存在** —— 那通常是代理没带上
（`git` 读的是 `http.proxy` 配置，摘掉环境变量不会自动生效）。

## 五、这条路上踩过的坑

- ⚠️ **`tar -a -cf x.zip` 打出来的不是 zip —— 而且不报错。**
  Git for Windows 装的是 **GNU tar**，它不支持 zip：`-a` 对 `.zip` 既不压缩也不
  报错，**静默产出一个普通 tar**。于是「便携版 zip」其实是 tar 改了个名：
  前 4 字节是文件名而不是 `PK\x03\x04`，Windows 用户双击打不开
  （`Expand-Archive`：「找不到中央目录结尾记录」）。
  **这个缺陷一直发到了 v0.11.1**，而 `test:portable` 当时是全绿的 ——
  因为它解压用的也是同一个 GNU tar（能读 tar）。
  **造和验用的是同一把错误的尺子，测试全绿而产物用户打不开。**
  → 现在打 / 解 zip 都走 `scripts/util.mjs` 的 `requireBsdtar()`
  （Windows 10+ 自带的 `C:\Windows\System32\tar.exe`，libarchive），
  显式传 `--format=zip`，并且**打完立刻验魔数 + EOCD**。
  验收时也别只用 `tar -tf`：真 zip 用 GNU tar 是列不出来的（会报
  "This does not look like a tar archive"），那正是它正常的证据。
- **重跑 `build:app` 报 `EPERM: rename 'dist-app' -> 'dist-app.trash-…'`** ——
  最常见的原因是**应用还开着**（Electron 一个实例就是 5 个进程），Windows
  锁住目录。构建脚本的报错写得很清楚，照着做就行：关掉应用再重试。
  **不要去 kill 进程** —— 那可能是用户正在用的窗口。
- **`gh release create` 是「先建 Draft → 传附件 → 最后才 publish」**。
  中途被打断会留下一个附件为空的 Draft，而命令本身不报错。
  补救：`gh release upload <tag> <files> --clobber` +
  `gh release edit <tag> --draft=false`。
- **发版后要确认代码在 main 上**：`gh release create` 只推标签，
  不推标签所在的提交到分支。发完版查一次 `git status -sb` 不带 `[ahead N]`。
- **`dist-installer/` 不进仓库**（上百 MB 的二进制）。要分发就走
  GitHub Release 的附件。

## 六、相关文档

- **照着敲的发版步骤：[releasing.md](releasing.md)**
- 构建产物的验收测试：[testing.md](testing.md)
- 模块地图与数据目录：[architecture.md](architecture.md)
- 版本检查与发版之后怎么被看到：[updates.md](updates.md)
