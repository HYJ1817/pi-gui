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

```bash
npm test                                  # 全量回归
npm run build:app -- --rebuild            # 必须 --rebuild
npm run build:installer -- --zip          # 安装程序 + 便携版 + SHA256SUMS.txt
node tests/app-check.cjs                  # 25 项
node tests/portable-check.cjs             # 11 项
node tests/installer-check.cjs            # 20 项（本机 reg.exe 被拉黑时 5 条跳过）
node tests/exe-check.cjs                  # 47 项
git tag vX.Y.Z <提交> && git push origin vX.Y.Z
gh release create vX.Y.Z --title "…" --notes-file <发布说明> <3 个附件>
```

> 单跑版本检查那套（不需要构建产物）：`npm run test:update`。

### 发完版之后：应用内就能看到

Release 一发出来，Pi GUI 的「诊断 → 版本」就会读到它（`docs/updates.md`）。
两件事值得知道：

- **缓存 30 分钟**。刚发完版自己测的时候要点 `[检查更新]`（它带 `?force=1`），
  自动检查走的是缓存。
- **版本号只有一个来源**：`server.js` 的 `VERSION`（打包期由 esbuild 写死，
  开发期读 `package.json`），它同时喂给 `/api/health`、诊断快照和更新检查。
  所以发版时改 `package.json` 就够，**不要**在别处再写一份版本号。

`release-check.yml` 里刻意**不跑**需要联网的更新检查用例 ——
`npm test` 里的那套全部走注入的假 fetch，所以 CI 期间不访问真实 GitHub。

### 版本号只有一个来源，但不止一个文件

`package.json` 与 `package-lock.json` 都有 `version`。
用 npm 自带的命令一次改齐，别手改：

```bash
npm version X.Y.Z --no-git-tag-version
```

`--no-git-tag-version` 是必须的 —— 默认行为会顺手 `git commit` 并打 tag，
而「改版本号」与「打 tag」是两步（要先把产物构建并验证过才打 tag）。

**核实要做两条独立路径**，不能只看一条：

1. **附件摘要**：`gh release view --json assets` 返回的 `digest` 与本地
   `sha256sum` 逐位比对
2. **git 侧**：`git fetch origin main --tags` 后比对本地/远端 ref，
   并用 `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` 确认 tag 指向

`git ls-remote` 报 502 **不代表 tag 不存在** —— 那通常是代理没带上
（`git` 读的是 `http.proxy` 配置，摘掉环境变量不会自动生效）。

## 五、这条路上踩过的坑

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

- 构建产物的验收测试：[testing.md](testing.md)
- 模块地图与数据目录：[architecture.md](architecture.md)
- 版本检查与发版之后怎么被看到：[updates.md](updates.md)
