# Pi GUI

给 [pi](https://github.com/earendil-works/pi) 套一个本地桌面界面：选一个文件夹当项目，
在输入框里说要做什么，文件改动与命令执行实时显示在窗口里。

后端是个纯 Node 的 HTTP 服务，前端是原生 JS（没有构建步骤、没有框架），
Electron 只负责装一个窗口 —— 不联网、不开浏览器，全部跑在本机。

## 前置条件

**本机要先装好 pi，并且 `pi` 在 PATH 里。** 这个仓库只是界面，不含 pi 本体：

```bash
npm i -g @earendil-works/pi-coding-agent   # 需要 Node >= 22.19.0
pi --version                                # 能打印版本就对了
```

pi 本身还要配好模型供应商（API Key 之类），否则界面能打开但发出去的消息会报错。
不在 PATH 的话可以用环境变量指定：`PI_BIN=C:\...\pi.exe`。

## 下载安装

从 Releases 里挑一个：

| 文件 | 说明 |
| --- | --- |
| `Pi-GUI-Setup-<版本>.exe` | 安装程序。约 100 MB，装完建好开始菜单和桌面快捷方式 |
| `Pi-GUI-<版本>-portable.zip` | 便携版。解压后直接跑 `Pi GUI.exe`，不用装 |

安装程序是**单用户**的：装在 `%LOCALAPPDATA%\Programs\Pi GUI`，不弹 UAC、不写系统目录。
卸载走「添加或删除程序」，只删程序文件 —— `%APPDATA%\pi-gui` 下的项目列表和窗口布局会保留，重装接着用。

下载后建议核一下 `SHA256SUMS.txt`：

```powershell
(Get-FileHash Pi-GUI-Setup-0.1.0.exe -Algorithm SHA256).Hash
```

## 从源码跑

```bash
npm install
npm start          # 只跑后端，用浏览器开 http://127.0.0.1:7788
npm run app        # 桌面窗口（Electron 会自己拉起一份后端，不用先 npm start）
```

改前端时用 `npm start` 更快（改完刷新页面即可）；`npm run app` 每次都要重启进程。

## 从源码构建

```bash
npm run build:dist      # 应用目录 + 安装程序 + 便携版 → dist-installer/
```

改了 `server.js` 或 `public/` 之后要加 `--rebuild`，否则后端产物 `build/server.cjs` 会被复用，
改动不会进包：

```bash
npm run build:app -- --rebuild
```

## 测试

```bash
npm test                # 前端冒烟 + 消息体完整性 + 后端接口
npm run test:app        # 打包后的应用目录（抽取、静态资源、无项目时的行为）
npm run test:exe        # 单文件 exe
npm run test:portable   # 便携版 zip：解压 → 直接跑 → 页面能开
npm run test:installer  # 真装一遍 → 启动 → 卸一遍（会写注册表、建快捷方式，测完卸掉）
```

后两条要先把 `npm run build:dist` 跑过一遍。

## 目录说明

- `server.js` — 后端。转发 pi 的 RPC、静态资源、附件抽取
- `public/` — 前端（`index.html` / `app.js` / `styles.css`）
- `electron/main.cjs` — Electron 主进程，拉起内嵌后端
- `installer/pi-gui.nsi` — 安装程序脚本（用 NSIS 编）
- `scripts/` — 构建脚本；`scripts/util.mjs` 是几个脚本共用的小工具
- `tests/` — 上面那几组测试

`dist-installer/` 不进仓库（上百 MB 的二进制）。要分发就传到 GitHub Release 的附件里。
