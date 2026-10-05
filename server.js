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
 *   server/pi-launch.js   **launch identity**：spawn 的命令、`--version` 与能力
 *                         探测读的那个包，全部同源于这一处（P20.5）
 *   server/sse.js         事件总线：clients / backlog / seq
 *   server/projects.js    项目列表、目录浏览、切换项目
 *   server/providers.js   ~/.pi/agent/models.json 的读写与模型拉取
 *   server/project-config.js  <project>/.pi-gui/config.json 的读写与 pi 启动参数
 *   server/skills.js      Skills 的发现 / 详情 / 启停（只读 pi 的官方机制，不自造一套）
 *   server/mcp.js         MCP 能力报告（**读本机那份 pi 包**给证据：0.87.0 没有
 *                         built-in `mcp`、0.99.x 有；不列 Server，如实回三值）
 *   server/sessions.js    会话列表与切换（pi 有 switch_session 但没有「列出会话」的 RPC）
 *   server/update-check.js 版本检查：只读 GitHub Release 元数据（不下载、不安装、不联网以外无副作用）
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
import { createAuthSdk, sanitizeModelEvent } from './server/provider-auth-sdk.js';
import { createModelGeneration } from './server/model-generation.js';
import { createProviderAuth } from './server/provider-auth.js';
import { createAuthRuntimeSync } from './server/provider-auth-runtime.js';
import { createQuotaManager } from './server/quota.js';
import { createRouter } from './server/router.js';
import { createSessionExport } from './server/session-export.js';
import { createRpcBridge } from './server/rpc-bridge.js';
import { createGuiBrowserLaunch } from './server/gui-browser-launch.js';
import { createProcessBridge } from './server/process-bridge.js';
import { projectProcessEvent } from './server/process-activity.js';
import { createExtensionRegistry } from './server/extension-registry.js';
import { createRuntime } from './server/runtime.js';
import { createDiagnostics } from './server/diagnostics.js';
import { createMcp } from './server/mcp.js';
import { createMcpNative, buildPiEntry } from './server/mcp-native.js';
import { createPiBuiltins } from './server/pi-builtins.js';
import { createPiLaunch } from './server/pi-launch.js';
import { createPiVersion, createPiVersionProbe } from './server/pi-version.js';
import { createApprovalProbe } from './server/approval-probe.js';
import { createSessions } from './server/sessions.js';
import { createSessionSearch } from './server/session-search.js';
import { createPiCompat } from './server/pi-compat.js';
import { createPiProbes } from './server/pi-probes.js';
import * as piCompatMatrix from './server/pi-compat-matrix.js';
import { createSkills } from './server/skills.js';
import { createUpdateCheck } from './server/update-check.js';
import { createPiUpdate } from './server/pi-update.js';
import { createCapabilityInstall } from './server/capability-install.js';
import { createPiActivity } from './server/pi-activity.js';
import { createAgentRegistry } from './server/agents/index.js';
import { createPlanStore } from './server/planner/store.js';
import { createScheduler } from './server/planner/scheduler.js';
import { createVerifier } from './server/planner/verifier.js';
import { createPlanner } from './server/planner/index.js';
/* P9：独立验证要真的跑一条命令，而全项目唯一的 spawn 出口在 cli.js。
 * planner/ 下的模块不许跨目录 import（tests/modules.cjs 的守卫），
 * 所以执行能力**在这里注入**过去 —— 与 scheduler 拿 gitStatus 是同一种装配。 */
import { runShellCommand, runCli, killTree } from './server/agents/cli.js';
import { gitStatus, worktreeTree, treeDiff, treeNumstat } from './lib/git.js';
import { createUploads } from './server/uploads.js';
import { probeOccupiedPort } from './server/port-owner.js';

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
const agentDirOverride = process.env.PI_CODING_AGENT_DIR;
const MODELS_JSON = path.join(agentDirOverride ? path.resolve(agentDirOverride.replace(/^~(?=[\\/]|$)/, os.homedir())) : path.join(os.homedir(), '.pi', 'agent'), 'models.json');

// 本应用自己的项目列表
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

// ---------- 装配 ----------

/* 共享运行态。currentCwd 的唯一权威 —— 见 server/runtime.js 的说明。 */
const runtime = createRuntime({ initialCwd: resolveInitialCwd(PROJECTS_FILE) });

/* ---------- launch identity（P20.5 Blocker A）----------
 *
 * 「现在启动主聊天 Pi，实际会执行哪个入口、那个入口属于哪个包」——
 * **整个后端只有这一个答案**，由 `server/pi-launch.js` 算，这里建一次、
 * 注入给所有要问它的模块：
 *
 *   rpc-bridge      → 真正 spawn（`launch` 参数直接吃它的 `bin`）
 *   pi-version      → `packageDir()` 当版本真值；`launcher()` 出 `--version` 命令
 *   pi-builtins     → `packageDir()` 当 built-in / ExtensionAPI 检视的包
 *   mcp / approval  → `packageDir()` 当能力探测的包
 *   diagnostics     → `summary()`（脱敏）当「启动的到底是哪个 pi」
 *
 * 为什么必须这么收：**spawn 看 PATH，而两份旧的包目录清单都不看 PATH。**
 * 机器上同时装着全局 0.99.1 与 `PI_BIN` 指向的另一份时，RPC 起的是 A、
 * 版本探测读的是 B —— 于是「运行中 Pi 的版本」报的是别的安装。
 * 现在两件事出自同一个对象，不可能各走各的。
 *
 * `packageDir()` 拿不到就回 null —— 不回退到「常见全局安装位置」清单，
 * 那正是这个 bug 的来源。少知道一点也比说错强（见该模块文件头）。
 *
 * 放在 runtime 之后建，是因为 `getCwd` 要读 runtime（惰性求值，但顺序上
 * 紧跟着它更好懂）。 */
const piLaunch = createPiLaunch({ piBin: PI_BIN, env: process.env, getCwd: () => runtime.getCurrentCwd() });

const sse = createEventBus({ getBridgeSnapshot: () => rpc.getState() });

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

/* Pi 版本真值（P20.5）。
 *
 * 在这之前「当前跑的是哪个 pi」是隐式的：文档写着「兼容基线 0.87.0」，
 * 用户机器上却可能装着 0.99.1 —— 于是「文档说没有原生 MCP」被当成了
 * 「你的 pi 没有原生 MCP」。这个模块把它变成一个有出处的状态：
 * `{ value, source, status, updatedAt }`。
 *
 * 取值顺序（越靠前越无副作用）：
 *   1. **属于 launch identity 的那个** pi 包的 `package.json`（纯文件读）；
 *      `resolvePackageDir` 就是 `piLaunch.packageDir()` —— 与 bridge 实际
 *      spawn 的入口**绑定**（P20.5 Blocker A）。证明不了它回 null，
 *      于是第 1 步不成立，**绝不会退回去读另一份全局安装的 package.json**；
 *   2. 受控的 `pi --version`（`piLaunch.launcher()`）：与 bridge **同一个
 *      launch spec**，只多一个 `--version`；
 *   3. 都拿不到 → unknown。
 *
 * 惰性求值 + TTL 缓存：`read()` 才会真的去读文件。
 *
 * （旧版这里有两条路径：先问 agent registry 的 npm 扫描，再退回
 * `locatePiPackage()` 的「常见全局位置」清单 —— 两份都**不看 PATH，而 spawn 看**。
 * 那就是身份分叉的根源，现在整条删掉。） */

const piVersion = createPiVersion({
  resolvePackageDir: piLaunch.packageDir,
  probeVersion: createPiVersionProbe({ launcher: piLaunch.launcher }),
  /* P20.5 收口：version cache 以 launch identity 为 key 的一部分。
   * 同一 target 内走 TTL；切项目导致实际入口变化时不等 TTL 立即重算。
   * key 是内部不透明串，永不进 API / Diagnostics / renderer。 */
  identityKey: piLaunch.identityKey,
  /* P23：兼容矩阵只用来回答「这个版本我们核过没有」（verifiedAgainst）。
   * **不参与能力判定** —— 能力走 pi-probes。 */
  matrix: piCompatMatrix,
});

/* Pi built-in 能力探测（P20.5）。
 * built-ins（`llama.cpp` / `codemode` / `tool-search` / `mcp`）编译在 pi 包里，
 * **不是**用户装的 npm extension —— 所以它们既不该被 Registry 的目录扫描发现，
 * 也不该被硬编码成「当前一定启用」。这里只读 pi 包的源码文本给证据。 */
const piBuiltins = createPiBuiltins({ resolvePackageDir: piLaunch.packageDir, env: process.env });

/* Pi 兼容层（P4）。
 *
 * 它在**最前面**建，因为 rpc-bridge 与 sessions 都要把它当观察者注入进去。
 * 它只累积证据、不参与判断，所以谁先谁后不影响行为。
 *
 * 版本探测是**惰性**的（report() 被调用时才求值），所以这里引用后面才建的
 * agentRegistry 不会踩 TDZ；万一真求值失败，pi-compat 自己会把它当「版本未知」，
 * 而那**不是**判不兼容的理由（见该模块头部的规矩 1）。 */
const piCompat = createPiCompat({
  piVersionProbe: () => {
    // 走规范版本状态，拿不到就回 null（pi-compat 会显示「版本未知」）
    const state = piVersion.read();
    return state && state.value ? state.value : null;
  },
  versionSourceProbe: () => {
    const state = piVersion.read();
    return state ? { source: state.source, status: state.status, updatedAt: state.updatedAt } : null;
  },
  /* P23：版本有没有被兼容矩阵核对过。与「值从哪来」分开摆 ——
   * 升级之后最常见的状态就是「读到了新版本，但矩阵里还没有它」。 */
  versionVerifiedProbe: () => {
    const state = piVersion.read();
    return state
      ? { verification: state.verification, verifiedAgainst: state.verifiedAgainst, relative: state.relative }
      : null;
  },
});

/* pi 桥接。projectLaunch 就是 projectConfig 本身 —— rpc-bridge 只认
 * prepareLaunch()（spawn 前，允许写文件）与 launchArgs()（纯读）两个方法，
 * 不知道配置里有什么。见 server/rpc-bridge.js 的参数说明。 */
let extensionRegistryRef = null;
/* P23：probe 表在 mcpNative 之后才建（它要读原生摘要），但 bridge 的 publish
 * 回调在那之前就装好了 —— 所以同样用「先声明、运行期回填」的引用占位。 */
let probesRef = null;
let providerAuthRef = null;
const authRuntimeListeners = new Set();
/* Pi 更新的后端闸门要用的两个「后端自己的」忙信号（不信前端的 disabled）：
 *   - piActivity：主会话有没有在干活（规则在 server/pi-activity.js —— 按 Pi 1.0.0
 *     的真实事件语义：agent_start → agent_settled，agent_end **不算结束**；
 *     以及「prompt 已提交、agent_start 还没到」的竞态）
 *   - cliInFlight：正在跑的 Pi CLI 动作（MCP add/remove/login/logout 等）
 * 两者都只增删计数，不读任何用户数据。 */
const piActivity = createPiActivity();
const modelGeneration = createModelGeneration();
let cliInFlight = 0;
const guiBrowserLaunch = createGuiBrowserLaunch({ launch: piLaunch });
const managedProcesses = createProcessBridge({runtime,launch:piLaunch,getRpcState:()=>rpc.getState(),guiPort:()=>server.address()?.port});
const rpc = createRpcBridge({
  runtime,
  browserLaunch: guiBrowserLaunch,
  processLaunch: managedProcesses,
  /* Pi 更新前的暂停要确认**整棵进程树**都退出了（Windows 上经 npm .cmd 启动时，
   * 只 kill 外层包装不足以说明 pi 本体已停）。原语在这里注入：rpc-bridge 自己
   * 不认识业务模块（有架构守卫钉着），复用的是 agents/cli.js 里验证过的 killTree。 */
  killProcessTree: killTree,
  publish: (event) => {
    event = projectProcessEvent(event);
    managedProcesses.observe(event);
    extensionRegistryRef?.observe(event);
    /* bridge 生命周期一变，runtime probe（RPC / 工具事件 / 原生 MCP）就没有意义了 ——
     * 旧 run 的结论不许留在表里。维护态也算：那一刻 runtime 正要被换掉。 */
    if (event?.type === 'bridge_status'
      && ['starting', 'restarting', 'exited', 'error', 'no-project', 'maintenance'].includes(event.state)) {
      probesRef?.reset();
    }
    /* 主会话活动状态：真实事件语义见 server/pi-activity.js 的文件头。
     * 这里只转发，规则只有一份（可测）。 */
    piActivity.observe(event);
    for (const listener of authRuntimeListeners) listener(event);
    providerAuthRef?.observeRuntime(event);
    sse.publish(modelGeneration.observe(event?.type === 'extension_error'
      ? { ...event, error: '扩展执行或加载错误；详情请查看本机 Pi 日志。' }
      : sanitizeModelEvent(event, event?.type === 'response' && ['get_state', 'get_available_models', 'set_model', 'cycle_model'].includes(event.command) ? providers.readModelsConfig() : null)));
  },
  piBin: PI_BIN,
  launch: piLaunch,
  isWin: IS_WIN,
  projectLaunch: projectConfig,
  compat: piCompat,
});

/* 依赖方向：projects → rpc 通过**注入回调**表达，而不是 import ——
 * 否则 projects ↔ rpc-bridge 会成环。
 *
 * 切项目时先同步该项目的指令文件再重启：pi 只在启动时读那个文件，
 * 顺序反了就是「这次不生效、下次才生效」。此刻 runtime.cwd 已经是新项目
 * （activate 里先 setCurrentCwd 再调这里），所以同步到的是新项目的那份。 */
/* Planner 的引用占位。projects 的闸门要用到它，但 planner 依赖 runtime / sse，
 * 只能排在 projects 之后 —— 所以先声明、后回填（闸门只在请求时被调用）。 */
let plannerRef = null;
/* P9 收口：Verifier 的引用占位，同一个理由 —— Scheduler 的闸门要问
 * 「现在有没有独立验证在跑」，而 verifier 自己又要拿 scheduler（问「有没有计划在跑」）。
 * 两边都不 import 对方，只在这里互相拿到一个**只读**的轻量函数。 */
let verifierRef = null;

const projects = createProjects({
  projectsFile: PROJECTS_FILE,
  runtime,
  restartPi: () => {
    projectConfig.syncInstructionsFile();
    rpc.restart();
  },
  isWin: IS_WIN,
  /* §40：有计划正在执行时拒绝切项目。plannerRef 稍后才赋值，所以这里用
   * 惰性读取 —— 闸门只在用户真的点「切换」时才会被调用，那时它已经就位。
   * P9 收口：**独立验证也算「正在这个工作区里干活」**，规则与两条文案都在
   * planner 那边（`projectSwitchBlockReason`）—— 放那边才测得到，
   * 这里只做一行透传，规则只有一份。 */
  beforeActivate: () => piBusyReason(false)?.error || null,
});

const providers = createProviders({ modelsJson: MODELS_JSON });
const authSdk = createAuthSdk({ resolvePackageDir: piLaunch.packageDir, identityKey: piLaunch.identityKey });
const quota = createQuotaManager({ readModelsConfig: providers.readModelsConfig, nativeAdapter: authSdk });
const uploads = createUploads({ dataDir: DATA_DIR });
const gitRoutes = createGitRoutes({ runtime });

/* Skills 与 MCP。
 *
 * 依赖方向照旧：两者都只读 runtime，Skills 额外通过注入拿到 rpc —— 因为
 * 「pi 实际加载了哪些 skill」只有 pi 自己说了算（RPC get_commands），
 * 而这个答案不能靠 Pi GUI 猜。rpc 只在 server.js 里装配，模块之间不互相 import。
 *
 * env 传 process.env 是有意的：pi 的 agent 目录（PI_CODING_AGENT_DIR）与主目录
 * （HOME）决定了去哪找 skill，必须和 spawn pi 时用的是同一份环境，否则会出现
 * 「界面说有一堆 skill、pi 一个都没加载」。 */
const skills = createSkills({ runtime, rpc, env: process.env });
/* P20.6 Native MCP 状态与受控动作。
 *
 * 状态真相只有两条官方路：`pi mcp list --json`（显式刷新才跑，会启动用户
 * 的 stdio servers，所以绝不轮询）与两处 mcp.json 的安全结构解析。
 * 跑的入口从 launch identity 派生（与 bridge 同一份包），经 agents/cli.js
 * 的 runCli（shell:false + args 数组）—— 与 planner 注入 runShellCommand
 * 同一种装配，不新增 spawn 出口。 */
const mcpNative = createMcpNative({
  runtime,
  env: process.env,
  resolvePackageDir: piLaunch.packageDir,
  /* P20.6-Fix：runtime / replaced 缓存的第二个分键维度。
   * 「A 项目里 MCP 全连上」与「这个 pi 包里 builtin:mcp 被扩展接管」都是
   * **当前 workspace + 当前这份 pi** 的事实 —— 换项目或换 pi 实例后必须失效。
   * identityKey 是不透明哈希（不含路径原文），只参与内部比较，永不进响应。 */
  resolveLaunchIdentity: piLaunch.identityKey,
  readTrust: async () => (await skills.readIndex()).trust,
  rpc,
  runCli: async (entry, args, opts) => {
    /* 记在飞的 CLI 动作数：Pi 更新前要确认没有别的 pi 进程正在跑
     * （MCP login/logout 这类动作与替换 runtime 文件互斥）。 */
    cliInFlight += 1;
    try {
      return await runCli({
        entry,
        args,
        cwd: opts && opts.cwd,
        env: {},
        timeoutMs: opts && opts.timeoutMs,
        maxStdoutBytes: 64 * 1024,
      });
    } finally {
      cliInFlight -= 1;
    }
  },
  piBuiltins: (cwd) => piBuiltins.read({ cwd }),
  /* P23：schema 漂移的观察出口 —— 上游给了闭集之外的运行时状态 / exposure 时，
   * 记一条「来源 + 字段名 + 类型」（没有值）。 */
  onDrift: (source, field, value) => piCompat.observeUnknownEnum(source, field, value),
});
const mcp = createMcp({
  runtime,
  env: process.env,
  piBin: PI_BIN,
  /* 包目录与版本都来自同一个 launch identity —— `/api/mcp` 说的「这个 pi」
   * 必须是 bridge 正在跑的那个，而不是另一份安装（P20.5 Blocker A）。 */
  resolvePackageDir: piLaunch.packageDir,
  piVersion: () => piVersion.read(),
  // 与 /api/mcp 共用同一份 built-in 探测（它自己带 cwd 维度的缓存）
  piBuiltins: (cwd) => piBuiltins.read({ cwd }),
  // 原生摘要（上次算出的，不触发 spawn；没算过就是 null）
  nativeSummary: () => mcpNative.peekSummary(),
});
/* P19：approval 能力报告（只读本机 pi 包，不执行它的代码）。 */
const approvalProbe = createApprovalProbe({ env: process.env, piBin: PI_BIN, resolvePackageDir: piLaunch.packageDir });
const extensions = createExtensionRegistry({
  runtime, rpc, env: process.env,
  extraReport: () => ({ guiBrowser: guiBrowserLaunch.report() }),
  readTrust: async () => (await skills.readIndex()).trust,
});
extensionRegistryRef = extensions;

/* P23：能力 probe 表。**汇总，不是新事实源** —— built-in 清单复用
 * `pi-builtins` 的解析，MCP 原生结论取 `mcpNative` 的摘要，RPC / 工具事件取
 * `piCompat` 的能力三值。只读、限长、不执行 pi 的代码、不联网。 */
const probes = createPiProbes({
  resolvePackageDir: piLaunch.packageDir,
  identityKey: piLaunch.identityKey,
  compat: piCompat,
  mcpNative,
});
probesRef = probes;

/* Planner 用 pi 跑任务时的独立会话目录。
 *
 * 这个常量要**在三个地方用同一个值**，所以只算一次：
 *   - 给 pi 适配器当 `--session-dir`（任务的会话落在这里）；
 *   - 给 sessions 当 extraSessionRoots（P7 的「从任务打开会话」要能定位到它们）；
 *   - 给测试与诊断引用。
 * 三处各写一遍 path.join(DATA_DIR, 'planner-sessions') 迟早会漂，而漂掉的症状是
 * 「会话明明存在却打不开」——极难查。 */
const PLANNER_SESSION_DIR = path.join(DATA_DIR, 'planner-sessions');

/* 会话列表。pi 的 RPC 里有 switch_session 却没有「列出会话」——
 * 它的 TUI picker 不对外，所以列表得我们自己扫 <agentDir>/sessions/。
 * 归属判定只认每个会话文件 header 里的 cwd，不信目录名。
 * 归档 / 回收站是 Pi GUI 自己的状态，落在 <PI_GUI_DATA>/（不进 pi 的目录）。
 *
 * P7：extraSessionRoots 把 Planner 的会话目录也交给它 —— 只用于「按会话 id
 * 精确定位」（从任务跳到会话），**不进侧栏的会话列表**。 */
const sessions = createSessions({
  runtime,
  rpc,
  env: process.env,
  dataDir: DATA_DIR,
  compat: piCompat,
  extraSessionRoots: [PLANNER_SESSION_DIR],
  getProjects: () => projects.read().items,
});

/* 会话全文搜索（P3）。**注入** sessions 实例而不是 import —— 模块之间不许互相
 * import，而搜索必须复用同一处归属判定（见 server/session-search.js 的文件头）。
 * 它只回答「关键词命中哪些会话的哪些消息」，切会话仍然走 sessions.switchTo。 */
const sessionSearch = createSessionSearch({ runtime, sessions });

/* Planner / Multi-Agent 编排层（P5）。
 *
 * 说清楚一件事：**pi 没有原生 sub-agent / plan mode**，所以这一层是
 * Pi GUI 自己的编排，不是 pi 的能力。界面文案也不许写成「pi 的多 Agent」。
 *
 * 依赖方向（照旧：server.js 装配，模块之间不互相 import）：
 *   Agent Registry  ← 唯一认识各 adapter 的地方
 *   Plan Store      ← 计划持久化（<DATA_DIR>/plans/）
 *   Scheduler       ← 只执行，不认识「怎么生成计划」
 *   Planner（路由） ← 只生成/编辑，不认识「怎么执行」
 *
 * sessionDir 给 pi 适配器一个**独立会话目录**：Planner 任务用 pi 跑时
 * 会话落在那里，不会混进 ~/.pi/agent/sessions/。这一点很关键 —— 主聊天用的是
 * `--continue`（取该 cwd 下最近的会话），混进去就会让用户下次聊天莫名其妙
 * 接上某个任务的上下文。
 *
 * gitStatus 注入给 scheduler 用：每个 task 前后各取一次工作区快照，
 * 差集就是「执行期间观察到的工作区变化」（不声称是 Agent 改的）。 */
const agentRegistry = createAgentRegistry({
  env: process.env,
  piLaunch,
  sessionDir: PLANNER_SESSION_DIR,
});
const planStore = createPlanStore({ dataDir: DATA_DIR });
/* 崩溃恢复**只在进程启动时做一次**（§31）。早先写成「每次读计划都恢复」，
 * 结果前端一轮询详情就把正在跑的任务翻成了 interrupted —— 光看文件分不出
 * 「上个进程死了」和「本进程正在跑」。 */
const planRecovery = planStore.recoverAll();
const scheduler = createScheduler({
  store: planStore,
  registry: agentRegistry,
  runtime,
  publish: sse.publish,
  gitStatus,
  /* 「现在有没有独立验证在跑」—— 只注入这一个**只读**函数，Scheduler 不认识
   * Verifier。verifierRef 稍后才回填，闸门只在请求时被调用，那时它已经就位。 */
  /* P10：历史变更证据的采集原语（临时 index + 两棵树比 diff）。注入而不是让
   * Scheduler import —— 与 gitStatus 同一种做法。 */
  gitEvidence: { worktreeTree, treeDiff, treeNumstat },
});
/* P9 独立验证执行器。放在 scheduler 之后建 —— 它要问「这个计划现在是不是
 * 正在执行」（`scheduler.activePlanId()`），那条规则只写在 Verifier 里，
 * route 不重复判一次。 */
const verifier = createVerifier({
  store: planStore,
  runtime,
  scheduler,
  runShell: runShellCommand,
  publish: sse.publish,
});
/* 回填上面那个占位 —— Scheduler 的闸门从这一刻起能问到「有没有验证在跑」。 */
verifierRef = verifier;
/* projects 在 planner 之前建好了，所以用上面那个可变引用回填 —— 避免为了
 * 一个闸门把装配顺序搅乱（projects 需要 planner，planner 又需要 runtime）。
 *
 * P7：planner 额外拿到 sessions —— 「从任务打开会话」要复用现有的会话切换
 * （switch_session + 前端 afterSessionSwitch 的重建链路），不能另起一套。
 * 这里同样是**注入**而不是让 planner import sessions（模块之间不互相 import）。
 *
 * P9：planner 再拿到 verifier —— 验证的路由挂在 Planner 的接口下，
 * 但「能不能跑、跑什么」的判断全在 Verifier 里。 */
const planner = createPlanner({
  runtime,
  registry: agentRegistry,
  store: planStore,
  scheduler,
  verifier,
  env: process.env,
  sessions,
});
plannerRef = planner;

/* P2 diagnostics：只读运行态与能力摘要，不读取会话正文、配置文件内容或环境变量。
 * 输出还会在模块内部做路径与 secret 脱敏，适合后续直接用于故障报告。 */
const diagnostics = createDiagnostics({
  runtime,
  rpc,
  agentRegistry,
  mcp,
  compat: piCompat,
  /* P20.5：诊断里的「pi 是哪个」要和真正跑起来的那个同源。
   * `launch` 给脱敏摘要（source / basename / known），`piVersion` 给规范版本状态。 */
  launch: piLaunch.summary,
  piVersion: () => piVersion.read(),
  /* P23：能力 probe 表 / 兼容矩阵摘要 / Native MCP 状态 / 关键 Extension 版本。
   * 全部惰性求值 —— 诊断面板打开时才去算，且只读。 */
  probes: () => probes.report(),
  compatMatrix: () => piCompatMatrix.matrixSummary(),
  mcpNative: () => mcpNative.peekSummary(),
  extensions: () => extensions.peek(),
  /* Pi 运行时更新：只读缓存/最近一次结果，**不发请求**（诊断不该打公网）。 */
  piUpdate: () => piUpdate.snapshot(),
  dataDir: DATA_DIR,
  version: VERSION,
  env: process.env,
});

/* P5 版本检查：只读公开 GitHub Release 元数据，判断有没有新版。
 *
 * 版本号**从上面那个 VERSION 注入** —— 那是全项目版本号的唯一真相
 * （打包期由 esbuild 写死，开发期读 package.json）。这里刻意不自己再读一次
 * package.json：两份来源迟早会漂，而「诊断说 0.11.1、更新检查说 0.11.0」
 * 这种自相矛盾极难排查。
 *
 * fetch 用全局的（Node ≥ 22 自带），不注入就代表走真实网络；
 * 测试一律显式注入假 fetch，所以**默认测试不访问公网**。 */
const updateCheck = createUpdateCheck({ version: VERSION });

/* Pi 运行时更新（Built-in Pi Updater）。
 *
 * 与上面那个 `updateCheck` **完全分离**：那个管 Pi GUI 自己的 Release，
 * 这个管本机装着的 pi。两者各有自己的状态、端点（`/api/update` vs
 * `/api/pi-update`）与文案，绝不互相复用缓存。
 *
 * 三条装配要点，每一条都是这一轮的安全边界：
 *   1. **目标从 launch identity 派生**：`piLaunch.packageDir()` → `buildPiEntry()`
 *      给出「这份 pi 自己的官方 CLI 入口」。解析不出来就拒绝更新（`unsupported`），
 *      **不退回 PATH 上的 `pi`** —— 那会重新制造「两份 pi identity」。
 *   2. **闸门在后端**：前端按钮 disable 只是体验，这里再查一遍
 *      （生成中 / Planner 任务 / 独立验证 / 在飞的 CLI 动作 / 工作区切换）。
 *   3. **成功后清掉所有与 Pi 包 identity 绑定的缓存**再重新读版本；
 *      读到旧版本就判失败（exit 0 ≠ 更新完成）。 */

/* ---------- 三个「当前这份 Pi」的共享原语 ----------
 *
 * Pi 自更新与 Capability 安装是**两条独立的写路径**（一个换 pi 本体、一个装
 * Extension），但它们对「当前这份 Pi」的认定必须完全一致，否则又会绕回 P20.5
 * 的「两份 identity」。所以下面三件事各只写一遍，两个模块都从这里取：
 *
 *   1. `resolvePiCliEntry()` —— 官方 CLI 入口（`packageDir` → `buildPiEntry()`）；
 *   2. `runPiCliCommand()`  —— 跑一条官方 CLI 命令（`agents/cli.js` 的 runCli，
 *      shell:false + args 数组 + 超时 + 有界输出 + 记在飞的 CLI 动作数）；
 *   3. `piBusyReason()`     —— 「现在忙不忙」的**唯一服务端判据**（Pi Updater 与
 *      Capability 安装共用；前端 disabled 只是体验，闸门是这一个）。
 *
 * `invalidatePiCaches()` 同理：identity 一失效，所有按 identity / cwd 分键的
 * 结论（版本 / built-in / probe / 原生 MCP / compat）都必须重新解析。 */

function resolvePiCliEntry() {
  let entry = null;
  try {
    entry = buildPiEntry(piLaunch.packageDir());
  } catch {
    entry = null;
  }
  return entry && entry.ok ? { ok: true, entry } : { ok: false, code: 'no-proven-entry' };
}

function runPiCliCommand(args, opts = {}) {
  const entry = (opts && opts.entry) || (() => {
    const r = resolvePiCliEntry();
    return r.ok ? r.entry : null;
  })();
  if (!entry || !entry.ok) {
    return Promise.resolve({ ok: false, spawnFailed: true, error: '没有证明到这份 Pi 的官方入口' });
  }
  cliInFlight += 1;
  return Promise.resolve(runCli({
    entry,
    args,
    cwd: runtime.getCurrentCwd() || undefined,
    env: {},
    timeoutMs: (opts && opts.timeoutMs) || 5 * 60 * 1000,
    maxStdoutBytes: (opts && opts.maxStdoutBytes) || 4000,
  })).finally(() => {
    cliInFlight -= 1;
  });
}

/** 清掉所有与 Pi 包 identity 绑定的缓存。**顺序即语义**：identity 先失效。 */
function invalidatePiCaches() {
  piLaunch.reset();
  piVersion.reset();
  piBuiltins.reset();
  probes.reset();
  mcpNative.reset();
  piCompat.reset();
  probesRef?.reset();
}

/**
 * 「Pi 现在忙不忙」—— Pi 更新与 Capability 安装**共用这一份**判据。
 * 顺序无所谓，但每一条都是「现在改 Pi 的运行时 / 跑一条会动 Pi 的命令」时
 * 必须先确认没有的事：
 *   - 主会话在生成（规则在 server/pi-activity.js，按 Pi 1.0.0 的真实事件语义）
 *   - 有在飞的 Pi CLI 动作（MCP add/remove/login/logout，见 cliInFlight）
 *   - Pi 自更新正在跑
 *   - 另一次 Capability 安装正在跑
 *   - Planner 任务或独立验证在跑（规则只有一份：projectSwitchBlockReason）
 * `piUpdate` / `capabilityInstall` 在下面才建 —— 这里是**惰性**读取，
 * 闸门只在请求时被调用，那时它们已经就位。
 */
function piBusyReason(includeAuth = true) {
  if (includeAuth && providerAuthRef?.inFlight()) return { code: 'busy-auth', error: '供应商认证或模型同步正在进行，请稍后再试' };
  const turn = piActivity.busy();
  if (turn) return turn;
  if (cliInFlight > 0) return { code: 'busy-cli', error: '有一个 Pi CLI 动作正在执行（例如 MCP 登录），请稍后再试' };
  if (piUpdate && piUpdate.isRunning()) return { code: 'busy-pi-update', error: 'Pi 更新正在进行中，请稍后再试' };
  if (capabilityInstall && capabilityInstall.isRunning()) return { code: 'busy-install', error: '另一个扩展安装正在进行中，请稍后再试' };
  if (plannerRef) {
    /* 规则只有一份（planner 的 projectSwitchBlockReason：计划在跑 / 独立验证在跑） */
    const reason = plannerRef.projectSwitchBlockReason();
    if (reason) return { code: 'busy-plan', error: reason };
  }
  return null;
}

const piUpdate = createPiUpdate({
  env: process.env,
  guiVersion: VERSION,
  readVersion: (opts) => piVersion.read(opts),
  currentCwd: () => runtime.getCurrentCwd(),
  resolveUpdaterTarget: () => resolvePiCliEntry(),
  runUpdater: (args, opts) => {
    /* 参数由 pi-update 固定为 ['update','--self']；entry 也由它一路带过来
     * （闸门检查过的那一份）。这里只负责接到与 MCP 动作同一条 runCli 上
     * （shell:false + args 数组 + 超时 + 有界输出）。 */
    return runPiCliCommand(args, opts);
  },
  pauseBridge: (reason) => rpc.pauseForMaintenance(reason),
  resumeBridge: () => rpc.resumeFromMaintenance(),
  invalidateCaches: invalidatePiCaches,
  busyReason: piBusyReason,
});

/* Known Capability 一键安装（P24 收口）。
 *
 * 与上面那个 piUpdate **完全分离**：那个换 pi 本体，这个装 Extension；
 * 端点、allowlist、文案、状态各有一套。共用的只有三件事，且都来自上面那三个
 * 共享原语：**当前这份 Pi 的入口**、**同一条 runCli 出口**、**同一份忙判据**。
 *
 * 三条装配要点：
 *   1. **renderer 只能送 capabilityId**：source 由 `server/capability-install.js`
 *      的固定 allowlist 决定，未知 id fail closed ⇒ 它不是任意包安装入口。
 *   2. **固定 argv**：`['install', <allowlisted source>, '--no-approve']` ——
 *      不带 `-l` / `--local`（用户级安装，跨项目可用），不带 `--approve`。
 *   3. **维护期间才动 Pi**：与自更新同一套 pause / resume 与失败语义；
 *      退出码 0 只说明命令跑完，**装没装由 Registry 重新发现回答**。 */
const capabilityInstall = createCapabilityInstall({
  currentCwd: () => runtime.getCurrentCwd(),
  busyReason: piBusyReason,
  resolveInstallTarget: () => resolvePiCliEntry(),
  runInstall: (args, opts) => runPiCliCommand(args, opts),
  pauseBridge: (reason) => rpc.pauseForMaintenance(reason),
  resumeBridge: () => rpc.resumeFromMaintenance(),
  invalidateCaches: invalidatePiCaches,
});

const providerAuth = providerAuthRef = createProviderAuth({
  adapter: authSdk,
  startBlocked: () => cliInFlight > 0 || piUpdate.isRunning() || capabilityInstall.isRunning(),
  busyReason: () => piBusyReason(false),
  customProviders: () => Object.keys(providers.readModelsConfig().providers || {}),
  readModels: async () => {
    if (!runtime.getCurrentCwd() || !rpc.getState().piRunning) return null;
    const result = await rpc.request({ type: 'get_available_models' });
    return Array.isArray(result?.models) ? result.models : null;
  },
  synchronize: createAuthRuntimeSync({
    rpc, getCwd: () => runtime.getCurrentCwd(), busyReason: () => piBusyReason(false),
    subscribe: listener => { authRuntimeListeners.add(listener); return () => authRuntimeListeners.delete(listener); },
  }),
});

const route = createRouter({
  processes: managedProcesses,
  auth,
  sse,
  /* 给 router 的 rpc 包一层：**命令被 bridge 接受之后**通知活动状态。
   * 这是「prompt 已经发出去、agent_start 还没到」那个窗口的唯一来源 ——
   * 只靠 pi 的事件会在这段窗口里误判成空闲，从而允许更新。
   * send 抛错（桥没接受）时不标记：没发出去的命令不该让人以为在跑。
   *
   * `abortAndWait` 走同一套前置检查与记账（它不会写进 pi 的 stdin 之外的地方，
   * 但同样是「用户下的一条命令」）—— 这里显式列出来，别让 `...rpc` 把它
   * 悄悄漏过守卫。 */
  rpc: {
    ...rpc,
    send: (cmd) => {
      if (providerAuth.snapshot().sync.state === 'syncing') throw new Error('认证后的模型状态正在同步，请稍后再试');
      modelGeneration.guardCommand(cmd);
      const { __fallbackOwner, ...wire } = cmd;
      const result = rpc.send(wire);
      modelGeneration.noteCommandAccepted(cmd);
      piActivity.noteCommandAccepted(cmd);
      return result;
    },
    abortAndWait: (cmd) => {
      if (providerAuth.snapshot().sync.state === 'syncing') {
        return Promise.resolve({ ok: false, code: 'auth-syncing', error: '认证后的模型状态正在同步，请稍后再试' });
      }
      modelGeneration.guardCommand(cmd);
      const { __fallbackOwner, ...wire } = cmd;
      modelGeneration.noteCommandAccepted(cmd);
      piActivity.noteCommandAccepted(cmd);
      return rpc.abortAndWait(wire);
    },
  },
  providers,
  providerAuth,
  sessionExport: createSessionExport({ rpc, runtime, resolvePackageDir: piLaunch.packageDir }),
  projects,
  projectConfig,
  skills,
  mcp,
  mcpNative,
  approvalProbe,
  extensions,
  sessions,
  sessionSearch,
  planner,
  gitRoutes,
  uploads,
  diagnostics,
  updateCheck,
  piUpdate,
  capabilityInstall,
  quota,
  compat: piCompat,
});

const server = http.createServer(route);

// ---------- 生命周期 ----------

async function shutdown() {
  if(runtime.isShuttingDown())return;
  providerAuth.dispose();
  runtime.setShuttingDown(true);
  /* 有计划在跑就先收尾：abort 当前 Agent，并把 running 的 task 标成 interrupted
   * 再落盘。不这么做的话它们会以 running 留在盘上，下次启动才被恢复 ——
   * 中间那段时间界面会显示一个永远不会动的「运行中」。 */
  try {
    scheduler.shutdown();
  } catch {
    /* 收尾失败不能挡住退出 */
  }
  /* P9：正在跑的独立验证也要收口。它和上面那条是同一个理由 ——
   * 进程一走，那条「正在验证…」就永远不会有下文了，留在盘上就是撒谎。
   * 这里是**同步**做法（SIGINT 里没有第二次机会），能顺带记下真实耗时。 */
  try {
    verifier.shutdown();
  } catch {
    /* 同上：收尾失败不能挡住退出 */
  }
  sse.closeAll();
  rpc.stop();
  try { await managedProcesses.dispose(); } catch { /* Pipe EOF / Job close is also an exit cleanup boundary. */ }
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
server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    runtime.setShuttingDown(true);
    rpc.stop();
    const owner = await probeOccupiedPort(PORT);
    if (owner === 'pi-gui') {
      console.log(`端口 ${PORT} 上已有 Pi GUI。直接使用 http://127.0.0.1:${PORT}`);
      if (AUTO_OPEN) openBrowser(`http://127.0.0.1:${PORT}`);
      setTimeout(() => process.exit(0), 400);
      return;
    }
    console.error(`端口 ${PORT} 已被其他程序占用。请关闭占用程序，或设置 PORT 使用其他端口。`);
    process.exit(1);
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

    /* 扩展能力摘要。
     *
     * Skills 这段是异步的 —— 「哪些真的被 pi 加载了」要问 pi（RPC get_commands），
     * 不能靠数文件。所以它会在下面那几行之后才打印出来。
     * 项目未被信任时必须显式说出来，否则用户只会觉得「我明明放了 skill 怎么没生效」。 */
    skills
      .readIndex()
      .then((idx) => {
        const loaded = idx.skills.filter((s) => s.state === 'enabled').length;
        console.log(
          `  → Skills: 发现 ${idx.skills.length} 个，pi 已加载 ${idx.piReachable ? loaded : '？（pi 未应答）'}  [${idx.agentDir}]`,
        );
        for (const r of idx.roots) {
          if (r.scope === 'project' && r.exists) {
            console.log(`      ${r.blockedByTrust ? '（未加载：项目未被信任）' : ''} ${r.dir}`);
          }
        }
        if (idx.trust.requiresTrust && !idx.trust.trusted) {
          console.log('  ! 项目未被信任：pi 在非交互模式下不加载项目级 Skills / Extensions');
        }
      })
      .catch(() => {
        /* 摘要打不出来不影响服务 */
      });

    const mcpReport = mcp.readReport();
    console.log(
      `  → MCP: ${mcpReport.supported === false ? 'pi 无原生 MCP 支持' : mcpReport.supported === true ? '检测到 MCP 相关模块（Pi GUI 尚未适配）' : '无法检测'}${mcpReport.piVersion ? `  [pi ${mcpReport.piVersion}]` : ''}`,
    );

    /* Planner / Agent 编排。必须说清「这是 Pi GUI 自己的编排，不是 pi 的能力」——
     * pi 0.87.0 没有原生 sub-agent / plan mode。 */
    const agentList = agentRegistry.list();
    const okAgents = agentList.filter((a) => a.available);
    console.log(
      `  → Agent: ${okAgents.length ? okAgents.map((a) => `${a.id} ${a.version || '?'}`).join(' / ') : '本机没有可用的 Agent'}${agentList.length > okAgents.length ? `（不可用：${agentList.filter((a) => !a.available).map((a) => a.id).join(' ')}）` : ''}`
    );
    console.log(`  → Planner: Pi GUI 自己的编排层（pi 没有原生 sub-agent / plan mode）`);
    if (planRecovery.recovered > 0) {
      console.log(`  ! 计划恢复：${planRecovery.recovered} 个计划上次被中断，已标成 interrupted（可重试）`);
    }
  }
  console.log(
    auth.isDevMode
      ? '  → 访问控制: 开发模式（未配置令牌，仅校验请求来源；仅供本机开发使用）'
      : '  → 访问控制: 令牌校验已启用（由桌面端注入，浏览器直连会被拒）'
  );
  console.log('');
  if (AUTO_OPEN) openBrowser(`http://127.0.0.1:${PORT}`);
});
