#!/usr/bin/env node
/**
 * Pi GUI —— 后端装配层。
 *
 * 这个文件只负责「把各模块接起来」，不再承载具体业务处理：
 *
 *   1. 读环境变量、算路径与版本号
 *   2. 建共享运行态（runtime）与事件总线（sse）
 *   3. 按依赖顺序装配各模块（auth / rpc-bridge / projects / providers / uploads / git-routes）
 *   4. 交给 router 组成请求分发
 *   5. 启动 pi 桥接、listen、管生命周期
 *
 * 业务实现按职责分在 server/ 下：
 *   server/auth.js        访问控制（令牌 + Origin）与身份探测
 *   server/rpc-bridge.js  pi 子进程：spawn / JSONL 解析 / stdin / 重启
 *   server/sse.js         事件总线：clients / backlog / seq
 *   server/projects.js    项目列表、目录浏览、切换项目
 *   server/providers.js   ~/.pi/agent/models.json 的读写与模型拉取
 *   server/project-config.js  <project>/.pi-gui/config.json 的读写与 pi 启动参数
 *   server/uploads.js     附件上传与落盘
 *   server/git-routes.js  Git 接口的 HTTP 适配（业务在 lib/git.js）
 *   server/router.js      路由表与静态资源
 *   server/runtime.js     共享运行态（cwd / shuttingDown）的唯一权威
 *   server/http-utils.js  json / readBody / readRawBody
 *
 * 协议要点（摘自 pi 官方 docs/rpc.md）见 server/rpc-bridge.js。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isSea } from './lib/assets.js';
import { createAuth } from './server/auth.js';
import { createEventBus } from './server/sse.js';
import { createGitRoutes } from './server/git-routes.js';
import { createProjects, resolveInitialCwd } from './server/projects.js';
import { createProjectConfig } from './server/project-config.js';
import { createProviders } from './server/providers.js';
import { createRouter } from './server/router.js';
import { createRpcBridge } from './server/rpc-bridge.js';
import { createRuntime } from './server/runtime.js';
import { createUploads } from './server/uploads.js';

// 数据目录：projects.json 和上传缓存放这里。
//
// 默认用「代码/exe 所在目录」—— 开发时是项目根；单文件 exe 是便携模式，
// 拷走 exe 数据一起带走。但桌面版（Electron）装在 Program Files 之类的地方
// 时那个目录不可写，所以主进程会用 PI_GUI_DATA 指到用户数据目录去。
//
// 这是**唯一**计算数据目录的地方，其余模块一律由这里注入 —— 打包形态
// （源码 / SEA / Electron）变化时只改这一处。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PI_GUI_DATA || __dirname;
const PORT = Number(process.env.PORT || 7788);
const PI_BIN = process.env.PI_BIN || 'pi';
const IS_WIN = process.platform === 'win32';

/* 应用身份。
 *
 * Electron 启动时要判断「7788 上跑的到底是不是 Pi GUI」，而不是
 * 「7788 上有没有人监听」—— 后者会把任何一个恰好占了这个端口的程序
 * 当成自己的后端，然后加载出一个别人的页面。判断依据就是这两个字段。 */
const APP_ID = 'pi-gui';
const PROTOCOL = 1;

/* 版本号。
 *
 * 构建脚本用 esbuild `--define:__PI_GUI_VERSION__` 注入 —— 打包后没有
 * package.json 可读（SEA 里根本没有这个文件，Electron 的 resources/app
 * 那份是构建时另写的精简版）。直接 `node server.js` 开发时没有这个常量，
 * 退回读磁盘上的 package.json。
 * 注意 `typeof` 对未声明的标识符是合法的，不会抛 ReferenceError。 */
const VERSION = typeof __PI_GUI_VERSION__ === 'undefined' ? readOwnVersion() : __PI_GUI_VERSION__;

function readOwnVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// pi 的用户级自定义供应商配置。
// 注意：这是「用户配置」，与 pi 自身的 models-store.json（模型目录缓存）不是一回事。
const MODELS_JSON = path.join(os.homedir(), '.pi', 'agent', 'models.json');

// 本应用自己的项目列表
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

// ---------- 装配 ----------

/* 共享运行态。currentCwd 的唯一权威 —— 见 server/runtime.js 的说明。 */
const runtime = createRuntime({ initialCwd: resolveInitialCwd(PROJECTS_FILE) });

const sse = createEventBus();

const auth = createAuth({
  token: process.env.PI_GUI_TOKEN,
  port: PORT,
  appId: APP_ID,
  protocol: PROTOCOL,
  version: VERSION,
});

/* 项目配置。它的读写目标永远是 runtime 里的 cwd，不接受任何调用方传路径，
 * 所以这里不用注入「项目从哪来」—— runtime 就是唯一来源。 */
const projectConfig = createProjectConfig({
  runtime,
  env: process.env,
  restartPi: () => rpc.restart(),
});

/* pi 桥接。projectLaunch 就是 projectConfig 本身 —— rpc-bridge 只认
 * prepareLaunch()（spawn 前，允许写文件）与 launchArgs()（纯读）两个方法，
 * 不知道配置里有什么。见 server/rpc-bridge.js 的参数说明。 */
const rpc = createRpcBridge({
  runtime,
  publish: sse.publish,
  piBin: PI_BIN,
  isWin: IS_WIN,
  projectLaunch: projectConfig,
});

/* 依赖方向：projects → rpc 通过**注入回调**表达，而不是 import ——
 * 否则 projects ↔ rpc-bridge 会成环。
 *
 * 切项目时先同步该项目的指令文件再重启：pi 只在启动时读那个文件，
 * 顺序反了就是「这次不生效、下次才生效」。此刻 runtime.cwd 已经是新项目
 * （activate 里先 setCurrentCwd 再调这里），所以同步到的是新项目的那份。 */
const projects = createProjects({
  projectsFile: PROJECTS_FILE,
  runtime,
  restartPi: () => {
    projectConfig.syncInstructionsFile();
    rpc.restart();
  },
  isWin: IS_WIN,
});

const providers = createProviders({ modelsJson: MODELS_JSON });
const uploads = createUploads({ dataDir: DATA_DIR });
const gitRoutes = createGitRoutes({ runtime });

const route = createRouter({
  auth,
  sse,
  rpc,
  providers,
  projects,
  projectConfig,
  gitRoutes,
  uploads,
});

const server = http.createServer(route);

// ---------- 生命周期 ----------

function shutdown() {
  runtime.setShuttingDown(true);
  sse.closeAll();
  rpc.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* 双击启动时自动打开浏览器（PI_GUI_OPEN=1 或 --open）。
 * 打包成 exe 后默认就开 —— 它本来就是给双击用的。
 * 注意 Windows 的 start 是 cmd 内建命令，必须经 cmd /c 调用。 */
const AUTO_OPEN =
  process.env.PI_GUI_OPEN === '1' ||
  process.argv.includes('--open') ||
  (isSea() && process.env.PI_GUI_OPEN !== '0');

function openBrowser(url) {
  const [bin, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(bin, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* 打不开就算了，控制台里印了地址 */
  }
}

// 端口被占用：多半是已经开着一个，直接把浏览器指过去，别报一堆错吓人
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  端口 ${PORT} 已被占用，说明已经有一个 Pi GUI 在跑。`);
    console.log(`  直接用它：http://127.0.0.1:${PORT}`);
    console.log(`  （想开新的：set PORT=7799 && node server.js）`);
    if (AUTO_OPEN) openBrowser(`http://127.0.0.1:${PORT}`);
    setTimeout(() => process.exit(0), 400);
    return;
  }
  console.error('\n  启动失败：' + err.message + '\n');
  process.exit(1);
});

rpc.start();
/* 显式绑定回环地址。
 *
 * 不要依赖 Node 的默认行为，也不要写 '0.0.0.0' —— 这个服务能驱动 pi 执行
 * 任意命令，一旦暴露到局域网就是一台无认证的远程 shell。
 * 日志里也只用 127.0.0.1，不给任何「可以从别的机器访问」的暗示。 */
server.listen(PORT, '127.0.0.1', () => {
  const currentCwd = runtime.getCurrentCwd();
  console.log('');
  console.log('  Pi GUI 已启动');
  console.log(`  → http://127.0.0.1:${PORT}`);
  console.log(`  → 工作目录: ${currentCwd || '（未选择 —— 在界面里「添加文件夹」）'}`);
  if (currentCwd) console.log(`  → pi 子进程: ${PI_BIN} ${rpc.buildArgs().join(' ')}`);
  if (currentCwd) {
    // 配置读不出来不是致命问题（会退回默认值），但启动日志里得看得见，
    // 否则用户只会觉得「我设的模型怎么没生效」。
    const cfg = projectConfig.read();
    const bits = [];
    if (cfg.config && cfg.config.model) bits.push(`模型偏好 ${cfg.config.model.provider}/${cfg.config.model.id}`);
    if (cfg.config && cfg.config.thinking) bits.push(`思考 ${cfg.config.thinking}`);
    if (cfg.config && cfg.config.instructions.trim()) bits.push(`项目指令 ${cfg.config.instructions.length} 字`);
    console.log(`  → 项目配置: ${bits.length ? bits.join('，') : '（未设置）'}  [${cfg.path}]`);
    for (const w of cfg.warnings) console.log(`  ! ${w}`);
  }
  console.log(
    auth.isDevMode
      ? '  → 访问控制: 开发模式（未配置令牌，仅校验请求来源；仅供本机开发使用）'
      : '  → 访问控制: 令牌校验已启用（由桌面端注入，浏览器直连会被拒）'
  );
  console.log('');
  if (AUTO_OPEN) openBrowser(`http://127.0.0.1:${PORT}`);
});
