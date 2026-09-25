/* 项目配置（`<project>/.pi-gui/config.json`）。
 *
 * ---------- 这个模块的定位 ----------
 *
 * 它是**项目偏好的持久层**，不是第二套运行时状态系统。
 * 运行中的真实状态仍以 runtime（cwd）+ pi RPC（模型 / 思考档位）为权威。
 * 所以这里只回答两个问题：
 *
 *   1. 这个项目**希望**用什么模型 / 思考档位 / 指令？（读盘，给 pi 的启动参数用）
 *   2. 用户改了偏好没有？（写盘）
 *
 * 它不缓存、不订阅事件、不参与实时渲染，也不回答「现在生效的是什么」——
 * 那个答案只有 pi 的 get_state 能给（不支持的档位会被 pi 自己夹到别的值上）。
 *
 * ---------- 为什么配置放在项目里，而不是数据目录 ----------
 *
 * 备选方案是 `PI_GUI_DATA/projects/<id>/config.json`，用绝对路径做 key。
 * 放弃它的原因是那条路**不满足「配置跟项目走」**：目录一改名或一移动，
 * 绝对路径就变了，配置等于丢了；而项目内的 `.pi-gui/` 会跟着目录一起走。
 * 代价是往用户仓库里写一个目录，用 `.pi-gui/` 这个点目录把影响收窄
 * （点开头，pi 的目录列举不会显示它，也不会被当成上下文文件加载）。
 *
 * ---------- 绝不写入的东西 ----------
 *
 * API Key、PI_GUI_TOKEN、任何供应商密钥。字段白名单（CONFIG_FIELDS）之外
 * 的键在归一化阶段就被丢掉，写盘时只写归一化后的结果，所以「传进来什么就写什么」
 * 这条路不存在。见 tests/project-config.cjs 的密钥相关用例。
 */
import fs from 'node:fs';
import path from 'node:path';
import { json, readBody } from './http-utils.js';

/* 配置格式版本。字段增删改语义时 +1，并在 MIGRATIONS 里补一条升级函数。 */
export const CONFIG_VERSION = 1;

/** 项目内的配置目录名。点开头，避免出现在目录列举里。 */
export const DIR_NAME = '.pi-gui';
export const FILE_NAME = 'config.json';

/* pi 注入项目指令的载体文件。
 *
 * 它由 config.json 的 instructions 字段**派生**出来：每次项目激活 / 保存配置时
 * 重新生成。之所以要落一个文件，是因为 pi 的 `--append-system-prompt` 接受
 * 「文本或文件路径」（见 pi docs/usage.md，实现见 core/resource-loader.js 的
 * resolvePromptInput：existsSync 命中就读文件），而指令是多行文本，
 * 塞进命令行会在 Windows 的 cmd 里被换行截断。
 *
 * 文件名带 `.generated` 是刻意的：它是产物，不是输入，手改会在下次同步时被覆盖。
 */
export const INSTRUCTIONS_FILE_NAME = 'instructions.generated.md';

/* 各字段上限。存在的意义不是「防恶意」（本服务只监听回环），
 * 而是防**手滑**：一个 20MB 的指令会被塞进每次请求的系统提示词。
 * instructions 取 32KB —— 远超正常项目约定，又远小于会拖垮上下文的量级。 */
export const LIMITS = Object.freeze({
  instructions: 32 * 1024,
  ignore: 200,
  ignoreItem: 300,
  commands: 50,
  commandName: 60,
  commandText: 500,
  provider: 100,
  modelId: 300,
});

/* pi 支持的思考档位。**不要自己发明枚举** —— 这份列表来自 pi 自己的
 * dist/cli/args.js（VALID_THINKING_LEVELS），实测 `pi --thinking bogus`
 * 报的合法值就是这七个。
 * 注意 xhigh / max 只在模型支持时才可用；本项目只把它当**偏好**保存，
 * 具体落到哪个档位由 pi 按当前模型决定，界面显示 get_state 回读的生效值。 */
export const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/* 默认配置 —— **唯一的默认值来源**。
 * 后端别处不许再写一份，前端也不许自己写一份（前端一律用接口返回的 config）。 */
export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  model: null,
  thinking: null,
  instructions: '',
  ignore: [],
  commands: [],
});

/** 允许出现在配置文件里的键。其余一律丢弃。 */
const CONFIG_FIELDS = Object.freeze(['version', 'model', 'thinking', 'instructions', 'ignore', 'commands']);

/** 默认配置的深拷贝。数组字段必须每次新建，否则调用方一 push 就污染了默认值。 */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    model: null,
    thinking: null,
    instructions: '',
    ignore: [],
    commands: [],
  };
}

/* 版本迁移表：键 = 源版本，值 = 把该版本的对象升到「键+1」的纯函数。
 *
 * 当前只有 v1，所以这张表是空的、循环体一次都不跑 —— 它是给下一个版本
 * 留的**确定形状的扩展点**，不是占位代码：加 v2 时只需写一条 MIGRATIONS[1]
 * 并把 CONFIG_VERSION 改成 2，migrate 的调用方一行都不用动。 */
const MIGRATIONS = Object.create(null);

/* ---------- 归一化（纯函数，不碰磁盘） ---------- */

function asString(v, max) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

function normalizeModel(v, warn) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    warn('model 必须是 { provider, id } 对象，已忽略');
    return null;
  }
  const provider = asString(v.provider, LIMITS.provider);
  const id = asString(v.id, LIMITS.modelId);
  if (!provider || !id) {
    warn('model 缺少 provider 或 id，已忽略');
    return null;
  }
  // 只取这两个键 —— 模型条目里可能有 apiKey 之类的字段，绝不能顺手带进项目配置
  return { provider, id };
}

function normalizeThinking(v, warn) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') {
    warn('thinking 必须是字符串，已忽略');
    return null;
  }
  const t = v.trim();
  if (!THINKING_LEVELS.includes(t)) {
    warn(`thinking 取值 "${t.slice(0, 40)}" 不在 pi 支持的档位里，已忽略`);
    return null;
  }
  return t;
}

function normalizeInstructions(v, warn) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') {
    warn('instructions 必须是字符串，已忽略');
    return '';
  }
  if (v.length > LIMITS.instructions) {
    warn(`instructions 超过 ${Math.round(LIMITS.instructions / 1024)} KB，已截断`);
    return v.slice(0, LIMITS.instructions);
  }
  return v;
}

/* 单项不合法就丢掉那一项，但**要说出来** —— 静默吞掉用户写的规则，
 * 表现是「我明明加了，怎么没生效」，而这条规则本身又不报错，最难查。
 * 整字段类型错（不是数组）走上面那条分支。 */
function normalizeIgnore(v, warn) {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) {
    warn('ignore 必须是字符串数组，已忽略');
    return [];
  }
  const valid = [];
  let dropped = 0;
  for (const item of v) {
    const s = asString(item, LIMITS.ignoreItem);
    if (!s) {
      dropped++;
      continue;
    }
    if (!valid.includes(s)) valid.push(s);
  }
  if (dropped) warn(`ignore 里有 ${dropped} 项不是有效字符串，已忽略`);
  if (valid.length > LIMITS.ignore) warn(`ignore 超过 ${LIMITS.ignore} 条，已截断`);
  return valid.slice(0, LIMITS.ignore);
}

function normalizeCommands(v, warn) {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) {
    warn('commands 必须是数组，已忽略');
    return [];
  }
  const valid = [];
  let dropped = 0;
  for (const item of v) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      dropped++;
      continue;
    }
    const name = asString(item.name, LIMITS.commandName);
    const command = asString(item.command, LIMITS.commandText);
    if (!name || !command) {
      dropped++;
      continue;
    }
    valid.push({ name, command });
  }
  if (dropped) warn(`commands 里有 ${dropped} 条缺少 name 或 command，已忽略`);
  if (valid.length > LIMITS.commands) warn(`commands 超过 ${LIMITS.commands} 条，已截断`);
  return valid.slice(0, LIMITS.commands);
}

/**
 * 把任意输入归一化成合法配置。**纯函数**，不读盘不抛错。
 *
 * 处理原则（规格第 3、21 节）：
 *   - 未知字段 → 丢弃
 *   - 缺少字段 → 用默认值
 *   - 类型错误   → 用默认值 + 一条警告（不崩、不静默）
 *   - version 高于本程序支持的 → 内容**不猜**，整体退回默认值 + 兼容性警告。
 *     猜的代价是把未来格式的字段误读成今天的语义，比读不出来危险得多。
 *
 * @returns {{ config: object, warnings: string[], unsupportedVersion: number|null }}
 */
export function normalizeConfig(raw) {
  const warnings = [];
  const warn = (m) => {
    if (m && !warnings.includes(m)) warnings.push(m);
  };

  if (raw === null || raw === undefined) {
    return { config: defaultConfig(), warnings, unsupportedVersion: null };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn('配置文件顶层不是对象，已按默认值处理');
    return { config: defaultConfig(), warnings, unsupportedVersion: null };
  }

  // ---- version ----
  let version = CONFIG_VERSION;
  if (raw.version !== undefined && raw.version !== null) {
    const n = Number(raw.version);
    if (!Number.isInteger(n) || n < 1) {
      warn(`version 不是正整数（${JSON.stringify(raw.version).slice(0, 40)}），已按 v${CONFIG_VERSION} 处理`);
    } else if (n > CONFIG_VERSION) {
      return {
        config: defaultConfig(),
        warnings: [
          `配置文件的 version=${n} 高于本程序支持的 v${CONFIG_VERSION}，` +
            `已按默认值显示；直接保存会覆盖它，建议先备份 ${DIR_NAME}/${FILE_NAME}`,
        ],
        unsupportedVersion: n,
      };
    } else {
      version = n;
    }
  }

  // ---- 迁移 ----
  let migrated = raw;
  for (let v = version; v < CONFIG_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (typeof step !== 'function') {
      warn(`缺少 v${v} → v${v + 1} 的迁移函数，未知部分按默认值处理`);
      break;
    }
    migrated = step(migrated);
  }

  const config = defaultConfig();
  config.model = normalizeModel(migrated.model, warn);
  config.thinking = normalizeThinking(migrated.thinking, warn);
  config.instructions = normalizeInstructions(migrated.instructions, warn);
  config.ignore = normalizeIgnore(migrated.ignore, warn);
  config.commands = normalizeCommands(migrated.commands, warn);

  return { config, warnings, unsupportedVersion: null };
}

/* ---------- 路径 ---------- */

export function projectDir(cwd) {
  return path.join(cwd, DIR_NAME);
}
export function configPath(cwd) {
  return path.join(projectDir(cwd), FILE_NAME);
}
export function instructionsPath(cwd) {
  return path.join(projectDir(cwd), INSTRUCTIONS_FILE_NAME);
}

/* ---------- 原子写 ---------- */

/* 先写同目录下的临时文件再 rename。
 * 必须在同一个目录里 —— 跨设备的 rename 不是原子操作（会退化成复制+删除）。
 * 临时名带 pid 与随机后缀，避免两个实例同时写时互相踩。 */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清不掉也没关系，不要用清理失败盖住真正的错误 */
    }
    throw err;
  }
}

/* ---------- 模块 ---------- */

/**
 * @param runtime   共享运行态。**唯一**的项目来源，不接受调用方传路径
 *                  （规格第 8 节：配置只能作用于当前项目）。
 * @param env       环境变量来源，默认 process.env。用来判断哪些开关被环境变量钉住了。
 * @param restartPi 需要重启 pi 时的回调（注入而不是 import，避免与 rpc-bridge 成环）
 */
export function createProjectConfig({ runtime, env = process.env, restartPi = null }) {
  /** 环境变量钉住了哪些开关。只回布尔，绝不回值 —— 免得把模型名甚至密钥漏到前端。 */
  function envPins() {
    const has = (k) => Boolean(String(env[k] || '').trim());
    return { provider: has('PI_PROVIDER'), model: has('PI_MODEL'), thinking: has('PI_THINKING') };
  }

  /**
   * 读当前项目的配置。**任何情况下都不抛**（规格第 21 节）：
   * 文件不存在 / 空文件 / 非法 JSON / 权限不足 / 目录只读，一律退回默认值 + 警告。
   * 调用方拿到的 config 永远是一个可以直接渲染的合法对象。
   */
  function read() {
    const cwd = runtime.getCurrentCwd();
    if (!cwd) {
      return { hasProject: false, cwd: null, path: null, exists: false, config: null, warnings: [] };
    }

    const file = configPath(cwd);
    let text = null;
    let exists = false;
    const warnings = [];

    try {
      text = fs.readFileSync(file, 'utf8');
      exists = true;
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        warnings.push(`读取 ${DIR_NAME}/${FILE_NAME} 失败（${err.code || err.message}），已按默认值处理`);
      }
    }

    if (!exists) {
      return { hasProject: true, cwd, path: file, exists: false, config: defaultConfig(), warnings };
    }

    if (!text || !text.trim()) {
      warnings.push(`${DIR_NAME}/${FILE_NAME} 是空文件，已按默认值处理`);
      return { hasProject: true, cwd, path: file, exists: true, config: defaultConfig(), warnings };
    }

    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      warnings.push(
        `${DIR_NAME}/${FILE_NAME} 不是合法 JSON（${err.message.slice(0, 80)}），已按默认值处理；` +
          '文件没有被改动，保存后才会覆盖它'
      );
      return { hasProject: true, cwd, path: file, exists: true, config: defaultConfig(), warnings };
    }

    const { config, warnings: normWarnings } = normalizeConfig(raw);
    warnings.push(...normWarnings);
    return { hasProject: true, cwd, path: file, exists: true, config, warnings };
  }

  /** 原子写配置。写不进去就抛 —— 调用方负责把它变成明确的报错（规格第 21 节）。 */
  function write(config) {
    const cwd = runtime.getCurrentCwd();
    if (!cwd) throw new Error('还没有选择项目，无法保存项目配置');
    const { config: clean } = normalizeConfig(config);
    // version 由这里定，不接受调用方指定 —— 否则客户端传个 99 就写进去了
    clean.version = CONFIG_VERSION;
    const file = configPath(cwd);
    writeFileAtomic(file, JSON.stringify(clean, null, 2) + '\n');
    return { path: file, config: clean };
  }

  /**
   * 把 config.instructions 同步成 pi 能读的文件。
   *
   * 三个分支都要处理，缺一个就会留下错误行为：
   *   - 有指令 → 写（内容没变就不写，免得每次激活都动 mtime 打扰文件监视器）
   *   - 指令被清空 → **删掉**产物。不删的话 pi 会继续注入用户已经删掉的指令。
   *   - 没有项目 → 什么都不做
   *
   * @returns {{ ok: boolean, path: string|null, changed: boolean, error?: string }}
   */
  function syncInstructionsFile() {
    const cwd = runtime.getCurrentCwd();
    if (!cwd) return { ok: true, path: null, changed: false };

    const { config } = read();
    const text = (config && config.instructions) || '';
    const file = instructionsPath(cwd);

    if (!text.trim()) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          return { ok: true, path: null, changed: true };
        }
      } catch (err) {
        return {
          ok: false,
          path: null,
          changed: false,
          error: `清理 ${DIR_NAME}/${INSTRUCTIONS_FILE_NAME} 失败（${err.code || err.message}）`,
        };
      }
      return { ok: true, path: null, changed: false };
    }

    try {
      if (fs.readFileSync(file, 'utf8') === text) return { ok: true, path: file, changed: false };
    } catch {
      /* 文件不存在或读不了 —— 下面照写 */
    }

    try {
      writeFileAtomic(file, text);
      return { ok: true, path: file, changed: true };
    } catch (err) {
      return {
        ok: false,
        path: null,
        changed: false,
        error: `写入 ${DIR_NAME}/${INSTRUCTIONS_FILE_NAME} 失败（${err.code || err.message}），项目指令本次未生效`,
      };
    }
  }

  /**
   * pi 的启动参数里由项目配置贡献的那部分。**纯读**，可以被反复调用
   * （/api/status 每次都会走到），所以不许在这里写文件 —— 写文件在 syncInstructionsFile。
   *
   * ---------- 为什么没有 --provider / --model ----------
   *
   * pi 在非交互模式（含 --mode rpc）下，任何 type:"error" 的启动诊断都会
   * `process.exit(1)`（源码 dist/main.js 的 hasRuntimeErrors 分支）。而
   * 「provider 不存在」正是 error 级诊断，「--model provider/id 整体不存在」也是。
   * 真按项目配置传启动参数，一旦模型引用过期，pi 就会退出 → 本项目的桥接每
   * 1.2 秒重启一次 → 项目彻底打不开。这正是规格第 9 节要避免的。
   *
   * 这条前提有可复现的运行时证据：`npm run test:inject` 里会拉起真的 pi，
   * 断言 `--provider no-such-provider-xyz --model no-such-model-xyz` 确实
   * 以 exit code 1 结束、stderr 里是 `Unknown provider`。
   * （注意这条诊断是在模型解析阶段才产生的，本机实测约 22 秒才退 —— 判定窗口
   * 开小了会得到「pi 没有退出」这种假绿，那个测试里的超时值是特意放宽的。）
   *
   * 所以模型改走 RPC 的 set_model：它失败只回 { success:false, error:"Model not found" }，
   * 不退出、不改动当前模型，是天然的可失败路径。落点在前端（见 public/project-config.js），
   * 因为「当前模型」这件事只有 pi 的 get_state 说了算，后端不复刻这份状态。
   *
   * 思考档位可以走启动参数：实测 `--thinking bogus` 只打一条 warning，不退出；
   * 不支持该档位的模型由 pi 自己夹到邻近档位，界面显示回读值。这样切项目时
   * 模型与档位在 pi 启动前就定了，不会有「先起来再改」的二次状态。
   */
  function launchArgs() {
    const out = { args: [], warnings: [] };
    const cwd = runtime.getCurrentCwd();
    if (!cwd) return out;

    const { config, warnings } = read();
    out.warnings.push(...warnings);
    if (!config) return out;

    const pins = envPins();

    // 优先级：环境变量 > 项目配置 > 会话里保存的 > pi 默认。
    // 环境变量已经钉住的开关，这里一个字都不加 —— 不改变既有环境变量语义。
    if (config.thinking && !pins.thinking) out.args.push('--thinking', config.thinking);

    if (config.instructions && config.instructions.trim()) {
      const file = instructionsPath(cwd);
      // 只有文件真的在才传：--append-system-prompt 对不存在的路径会当**字面量文本**
      // 拼进系统提示词（实测），那就等于把一条路径当指令注进去了。
      if (fs.existsSync(file)) out.args.push('--append-system-prompt', file);
      else out.warnings.push('项目指令文件缺失，本次未注入（保存一次项目设置即可重建）');
    }

    return out;
  }

  /* 启动参数 + 指令内容的合成指纹。
   * 用来判断「保存这次配置之后 pi 需不需要重启」。
   * 必须带上 instructions 的内容：路径没变但内容变了，pi 也不会知道
   * （它在启动时读一次），只比参数会把「改了指令但不重启」判成不需要重启。 */
  function launchSignature() {
    const { args } = launchArgs();
    const { config } = read();
    return JSON.stringify([args, (config && config.instructions) || '']);
  }

  /**
   * spawn pi 之前该做的那一次：把指令文件同步出来，再取参数。
   * 和 launchArgs 的区别只有一个 —— **这个允许写磁盘**，所以只在一处调用（spawn 前）。
   * 顺序不能反：launchArgs 里会检查指令文件在不在，先取参数就会漏掉刚写的文件。
   *
   * @returns {{ args: string[], warnings: string[] }}
   */
  function prepareLaunch() {
    const sync = syncInstructionsFile();
    const out = launchArgs();
    if (!sync.ok && sync.error) out.warnings.push(sync.error);
    return out;
  }

  /** 只覆盖 payload 里**明确出现**的字段，其余保留磁盘上的值。
   * 整体替换的话，一个只发 { thinking } 的客户端会把模型和指令一起清空。 */
  function mergePayload(base, payload) {
    const out = { ...base };
    for (const key of CONFIG_FIELDS) {
      if (key === 'version') continue;
      if (Object.prototype.hasOwnProperty.call(payload, key)) out[key] = payload[key];
    }
    return out;
  }

  /**
   * HTTP 处理。GET 只读；PUT 合并 + 归一化 + 原子写，必要时重启 pi。
   *
   * 注意：**不接受任何来自客户端的路径参数**。读写目标永远是
   * runtime.getCurrentCwd()，所以 /api/project-config?projectPath=... 或
   * body 里带 absolutePath 都不会改变作用对象（规格第 8 节）。
   */
  function handle(req, res) {
    if (req.method === 'GET') {
      const data = read();
      return json(res, 200, {
        ok: true,
        ...data,
        env: envPins(),
        thinkingLevels: [...THINKING_LEVELS],
        limits: { instructions: LIMITS.instructions },
        defaults: defaultConfig(),
      });
    }

    if (req.method === 'PUT') {
      if (!runtime.getCurrentCwd()) {
        // 没有项目不是错误，但也没有东西可写 —— 明说，不要假装成功
        return json(res, 200, { ok: false, hasProject: false, error: '还没有选择项目，无法保存项目配置' });
      }

      return readBody(req)
        .then((raw) => {
          let payload;
          try {
            payload = JSON.parse(raw || '{}');
          } catch {
            return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          }
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return json(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
          }
          if (payload.__expectedCwd != null && payload.__expectedCwd !== runtime.getCurrentCwd()) {
            return json(res, 409, { ok: false, error: '项目已切换，当前设置未保存。请重新打开项目设置。' });
          }

          const before = launchSignature();
          const current = read();
          const merged = mergePayload(current.config || defaultConfig(), payload);
          const { config, warnings } = normalizeConfig(merged);

          let saved;
          try {
            saved = write(config);
          } catch (err) {
            // 写失败必须明确报错，不能让用户以为存下了
            return json(res, 500, { ok: false, error: `保存失败：${err.code || err.message}`, path: configPath(runtime.getCurrentCwd()) });
          }

          const sync = syncInstructionsFile();
          const after = launchSignature();
          const restartRequired = before !== after;

          if (!sync.ok && sync.error) warnings.push(sync.error);

          if (restartRequired && restartPi) {
            try {
              restartPi();
            } catch (err) {
              warnings.push(`重启 pi 失败：${err.message}`);
            }
          }

          return json(res, 200, {
            ok: true,
            path: saved.path,
            config: saved.config,
            warnings,
            restartRequired,
            restarted: Boolean(restartRequired && restartPi),
          });
        })
        .catch((err) => json(res, 500, { ok: false, error: `保存失败：${err.message}` }));
    }

    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  return {
    handle,
    read,
    write,
    launchArgs,
    prepareLaunch,
    launchSignature,
    envPins,
    syncInstructionsFile,
    // 供装配层与测试使用
    configPath: () => {
      const cwd = runtime.getCurrentCwd();
      return cwd ? configPath(cwd) : null;
    },
  };
}
