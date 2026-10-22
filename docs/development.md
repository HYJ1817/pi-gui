# 开发与构建

面向维护者：怎么从源码跑、怎么构建三种形态，以及这条路上踩过的坑。
开发规则见 [AGENTS.md](../AGENTS.md)，代码审查见 [REVIEW.md](../REVIEW.md)，
按任务阅读见 [文档导航](README.md)；测试执行政策统一见 [testing.md](testing.md#测试执行政策)，
正式发版步骤统一见 [releasing.md](releasing.md)。命令示例不授予推送、合并或发布权限。

## 一、从源码跑

```bash
npm ci             # 仅在已授权准备依赖时执行；已有依赖不为文档/只读任务重复安装
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
| `npm run release:check` | 构建及收集发布产物；不创建 Release | 默认含完整测试、构建与验证，有写盘等副作用；参数与隔离要求见 [releasing.md](releasing.md) |
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

**唯一正式流程见 [releasing.md](releasing.md)**，版本准备、授权、精确 SHA CI 证明、
tag 触发、打包安装与上传验证均在那里维护。本节只保留开发排查背景与链接。
开发完成、代码验收、允许合并和允许发布的不同含义见 [REVIEW.md](../REVIEW.md#5-验证与合并准则)。

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

- ⚠️ **「本机跑得通」不等于「runner 上跑得通」——盘符布局就不一样，而且方向是反的。**
  本机更**宽松**：仓库与 `TEMP` 都在 `C:`。GitHub runner 更**严格**：
  workspace 在 `D:\`、`TEMP` 在 `C:\`。
  `portable-check.cjs` 里曾有一条「zip 与临时目录必须同盘」的限制（当年为 GNU tar
  加的，GNU tar 会把 `C:` 当成 rsh 远程主机），在本机永远不触发，
  而在 runner 上**必然触发** —— `Verify portable zip` 1 秒钟就抛错退出。
  换用 bsdtar 之后这条前提早就不成立了（bsdtar 原生支持盘符），
  但没人去删它，于是 `release-check.yml` 第一次被真正触发时才暴露。
  → 凡是要在 runner 上跑的东西，**必须真的在 runner 上跑过一次**，
  不能只靠本机绿灯 + 静态校验。本机想复现跨盘可以用
  `subst D: <某个目录>` 造一个第二盘，再把 `TEMP` 指过去。
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
- **上传中断可能留下 Draft**。当前恢复与重复执行规则统一见
  [releasing.md](releasing.md#重复执行)，保留精确 SHA 和资产核验，不用手工发布命令绕过守卫。
- **Release 必须对应 main 上已验证的精确提交**，当前脚本的证明要求见
  [releasing.md](releasing.md#五releasecheck-做了什么)。本地无 ahead 状态不能替代这份证明。
- **`dist-installer/` 不进仓库**（上百 MB 的二进制）。要分发就走
  GitHub Release 的附件。

## 六、相关文档

- **照着敲的发版步骤：[releasing.md](releasing.md)**
- 构建产物的验收测试：[testing.md](testing.md)
- 模块地图与数据目录：[architecture.md](architecture.md)
- 版本检查与发版之后怎么被看到：[updates.md](updates.md)
