/* Pi 版本真值（P20.5）。
 *
 * ---------- 这个模块解决什么 ----------
 *
 * 「当前跑的是哪个 pi」在这之前是**隐式**的：文档里写着「兼容基线 0.87.0」，
 * 而用户机器上装的可能是 0.99.1。两件事被混成了一句「pi 版本」，于是
 * 「文档说没有原生 MCP」被当成了「你的 pi 没有原生 MCP」。
 *
 * 这里把它拆成一个**规范状态**：
 *
 *   { value, source, status, updatedAt }
 *
 *   value      '0.99.1' 或 null
 *   source     'package.json' | 'pi --version' | 'none'   —— 这个值是从哪来的
 *   status     'known' | 'malformed' | 'unknown'
 *   updatedAt  ISO 时间戳（这个状态是什么时候求出来的）
 *
 * ---------- 取值的优先级（越靠前越权威、越无副作用）----------
 *
 * 1. **属于**这次 launch target **的那个 pi 包的 `package.json`。** 纯文件读：
 *    不执行任何代码、不启动进程、不碰用户状态。它是权威来源 —— **但前提是
 *    `resolvePackageDir()` 能证明这个包目录就是 bridge 实际启动的那份 pi**
 *    （见 `server/pi-launch.js`）。证明不了它就回 null，这里也就不会读到
 *    另一份安装的 `package.json`。
 * 2. **受控的 `pi --version`。** 只在第 1 步拿不到时兜底（包目录证明不了，
 *    例如 `PI_BIN` 指向一个独立安装 / fork）。它执行的是**与 bridge 同一个
 *    launch spec**（`server/pi-launch.js` 的 `formatLaunch`），只多一个
 *    `--version`：不加载 Extension、不开会话、不改配置；有超时、有输出上限，
 *    失败就是失败。
 * 3. 都拿不到 → `unknown`。**不猜**，也不从别处（另一份全局安装、文档、
 *    CHANGELOG）推 —— 「另一份 Pi 的版本」不是「运行中 Pi 的版本」。
 *
 * ---------- 三条纪律 ----------
 *
 * - **版本号只是证据，不是判据。** 能力判定一律走 probe 或真实事件（见
 *   `server/pi-builtins.js` 与 `server/pi-compat.js`）；这个模块只回答
 *   「装的是什么版本」，不回答「所以它支持什么」。
 * - **畸形就是畸形，不四舍五入。** `version` 字段是 `"not-a-version"` 时
 *   状态是 `malformed`，`value` 保持 null —— 绝不把它当版本号往下传。
 * - **不联网。** 不查 npm registry / GitHub / 官网。远端最新版是另一件事
 *   （`server/update-check.js` 只查 Pi GUI 自己的 Release）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 版本形状：`0.99.1`，允许 prerelease / build 后缀。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** 版本字符串的字符上限（防止把一整段文本当版本号带进报告）。 */
const MAX_VERSION_CHARS = 64;

/**
 * 把原始字符串规范成版本号。纯函数，便于单测。
 * @returns {{ value: string|null, status: 'known'|'malformed'|'unknown' }}
 */
export function parsePiVersion(raw) {
  if (typeof raw !== 'string') return { value: null, status: 'unknown' };
  const text = raw.trim();
  if (!text) return { value: null, status: 'unknown' };
  if (text.length > MAX_VERSION_CHARS) return { value: null, status: 'malformed' };
  return VERSION_RE.test(text) ? { value: text, status: 'known' } : { value: null, status: 'malformed' };
}

/** 从 `pi --version` 的输出里抠出版本号（可能带前后噪声，如 `pi 0.99.1`）。 */
export function parseVersionOutput(raw) {
  if (typeof raw !== 'string') return { value: null, status: 'unknown' };
  const direct = parsePiVersion(raw);
  if (direct.status === 'known') return direct;
  const m = /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(raw.slice(0, 4096));
  if (!m) return { value: null, status: raw.trim() ? 'malformed' : 'unknown' };
  return parsePiVersion(m[1]);
}

/**
 * @param resolvePackageDir 返回本机 pi 包目录（找不到回 null）。注入是为了单测。
 * @param probeVersion      兜底探测，返回原始输出字符串或 null。注入是为了单测。
 * @param now               时间源（单测固定时间用）。
 * @param ttlMs             缓存时长；探测有成本，不要在每次请求里重来一遍。
 * @param identityKey       launch identity 的内部 key（`() => string`，如
 *                          `piLaunch.identityKey`）。同一个 key 内走 TTL；
 *                          key 一变就立即重算，不等 TTL —— 切项目后不会再把
 *                          上一个 Pi 的版本带过来。它只认识「identity 变没变」，
 *                          不认识 project / runtime / cwd。
 */
export function createPiVersion({
  resolvePackageDir = null,
  probeVersion = null,
  now = () => Date.now(),
  ttlMs = 30_000,
  identityKey = null,
} = {}) {
  let cache = null; // { key, value, source, status, at }

  function currentKey() {
    if (typeof identityKey !== 'function') return '';
    try {
      const k = identityKey();
      return typeof k === 'string' ? k : String(k ?? '');
    } catch {
      return '';
    }
  }

  function fromPackage() {
    if (typeof resolvePackageDir !== 'function') return null;
    let dir = null;
    try {
      dir = resolvePackageDir();
    } catch {
      return null;
    }
    if (typeof dir !== 'string' || !dir) return null;
    let pkg = null;
    try {
      // 同步读、限长：一个坏 package.json 不该把整个状态搞崩
      const file = path.join(dir, 'package.json');
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 256 * 1024) return null;
      pkg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
    if (!pkg || typeof pkg !== 'object') return null;
    const parsed = parsePiVersion(pkg.version);
    // 包读到了、但 version 字段畸形 —— 这是**有信息**的畸形，别退回兜底探测
    return { ...parsed, source: 'package.json' };
  }

  function fromProbe() {
    if (typeof probeVersion !== 'function') return null;
    let out = null;
    try {
      out = probeVersion();
    } catch {
      out = null;
    }
    if (typeof out !== 'string' || !out.trim()) return null;
    const parsed = parseVersionOutput(out);
    return { ...parsed, source: 'pi --version' };
  }

  function compute() {
    const viaPackage = fromPackage();
    if (viaPackage && viaPackage.status !== 'unknown') {
      return { ...viaPackage, at: now() };
    }
    const viaProbe = fromProbe();
    if (viaProbe && viaProbe.status !== 'unknown') {
      return { ...viaProbe, at: now() };
    }
    return { value: null, source: 'none', status: 'unknown', at: now() };
  }

  /** 取规范状态。同一 identity 内带 TTL 缓存；identity 一变就立即重算。`force` 用于显式刷新。 */
  function read({ force = false } = {}) {
    const t = now();
    const key = currentKey();
    if (force || !cache || cache.key !== key || t - cache.at >= ttlMs) {
      cache = { key, ...compute() };
    }
    const { at, ...rest } = cache;
    const { key: _k, ...out } = rest;
    return { ...out, updatedAt: new Date(at).toISOString() };
  }

  /** 不触发探测，只看当前缓存（给「顺手带上」的路径用）。内部 key 不出去。 */
  function peek() {
    if (!cache) return null;
    const { at, key: _k, ...rest } = cache;
    return { ...rest, updatedAt: new Date(at).toISOString() };
  }

  /** 给测试用：清缓存。 */
  function reset() {
    cache = null;
  }

  return { read, peek, reset, _internals: { parsePiVersion, parseVersionOutput } };
}

/**
 * 兜底探测：跑一次 `pi --version`。
 *
 * 只在「包目录读不到」时才被用到，所以它可以是**慢一点、但有独立证据**的一条路。
 * 安全边界与 `server/agents/cli.js` 一致：
 *   - **`shell: false` + args 数组**，永不拼命令字符串；
 *   - 入口由调用方解析好（`resolveEntry()` 回 `{cmd, baseArgs}`）——
 *     Windows 上的 `.cmd` shim 由那一层负责转发，这里不自己拼 shell；
 *   - 有超时、有输出上限；任何失败都回 null（= unknown），不抛。
 *
 * **`launcher` 是与 bridge 同源的那条路（P20.5）**：给它就优先用它 ——
 * 它返回 `{command, spawnArgs, shell}`，与 `server/rpc-bridge.js` spawn
 * 主聊天 Pi 用的是同一个 `formatLaunch()`。所以「跑 `--version` 的那个进程」
 * 与「跑 `--mode rpc` 的那个进程」出自同一个 launch spec，
 * 不会再出现「版本读的是另一份安装」。
 *
 * @param launcher  `(args) => {command, spawnArgs, shell}`。注入是为了单测。
 * @param resolveEntry 返回 `{cmd, baseArgs}` 或 null。注入是为了单测与复用
 *                     agent registry 已经解析好的入口（老路径，保留给调用方）。
 * @param run          真正执行的那一步，默认 spawnSync。注入是为了单测。
 */
export function createPiVersionProbe({
  launcher = null,
  resolveEntry = null,
  run = spawnSync,
  env = process.env,
  timeoutMs = 8000,
  maxOutputChars = 4096,
} = {}) {
  return () => {
    let spec = null;
    if (typeof launcher === 'function') {
      try {
        spec = launcher(['--version']) || null;
      } catch {
        return null;
      }
      if (!spec || typeof spec.command !== 'string' || !spec.command) return null;
      if (!Array.isArray(spec.spawnArgs)) return null;
    } else {
      if (typeof resolveEntry !== 'function') return null;
      let entry = null;
      try {
        entry = resolveEntry();
      } catch {
        return null;
      }
      if (!entry || typeof entry.cmd !== 'string' || !entry.cmd) return null;
      const baseArgs = Array.isArray(entry.baseArgs) ? entry.baseArgs : [];
      spec = { command: entry.cmd, spawnArgs: [...baseArgs, '--version'], shell: false };
    }
    try {
      const opts = {
        env,
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      };
      if (spec.shell) opts.shell = true;
      const res = run(spec.command, spec.spawnArgs, opts);
      if (!res || res.error) return null;
      const out = `${res.stdout || ''}`.trim() || `${res.stderr || ''}`.trim();
      return out ? out.slice(0, maxOutputChars) : null;
    } catch {
      return null;
    }
  };
}
