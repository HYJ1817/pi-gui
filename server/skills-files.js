/* 技能文件的落盘原语：包校验、读目录、安装、原子写、回收站、短期令牌。
 *
 * 这一层不知道「哪个目录允许写」—— 那是 skills-manage.js 的判定。这里只保证：
 *   - 一个「技能包」（相对路径 + 字节）在落盘前被完整校验：没有穿越、没有绝对路径、
 *     没有 Windows 上会出事的名字、大小与数量有上限；
 *   - 安装是「先在同一目录下的临时目录里写完，再一次 rename 进去」，
 *     中途失败不会留下半个技能；
 *   - 删除与覆盖都是「挪进回收站」，不是真删；
 *   - 从磁盘读别的工具的技能目录时只读、不跟随内部的符号链接。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BUNDLE_LIMITS = Object.freeze({
  maxFiles: 200,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  maxDepth: 8,
  maxPathLength: 240,
  maxSegmentLength: 120,
  /** 校验前允许扫过的原始条目数（含会被跳过的），只为给工作量封顶。 */
  maxRawEntries: 5000,
});

const SKILL_FILE = 'SKILL.md';
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_ILLEGAL = /[<>:"|?*]/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const TEMP_DIR_PATTERN = /^\.pi-gui-tmp-\d+-[0-9a-f]{12}$/;
const STALE_TEMP_MS = 60 * 60 * 1000;
const TRASH_ID_PATTERN = /^(?:del|edit-[0-9a-f]{16})-\d{17}-[0-9a-f]{8}$/;
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** 被跳过的条目给人看的说明（界面直接显示这一句）。 */
const SKIP_NOTES = Object.freeze({
  hidden: '隐藏文件',
  node_modules: 'node_modules 目录',
  'unsafe-name': '文件名在 Windows 上不合法',
  'too-deep': '目录层级太深',
  'too-long': '路径太长',
  symlink: '符号链接',
  special: '不是普通文件',
});

const skippedEntry = (rawPath, reason) => ({ path: displayPath(rawPath), reason, note: SKIP_NOTES[reason] || reason });

export const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function codeError(code, message, extra = {}) {
  return Object.assign(new Error(message), { skillCode: code, ...extra });
}

/**
 * 给人看的失败原因。自己抛的错（带 skillCode）直接用它的话；
 * 系统错误只留错误码 —— Node 的原始消息是一长串带绝对路径的英文，既难读，也不该原样进界面。
 */
export function describeError(err) {
  if (err && err.skillCode) return err.message;
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') return `没有权限，或文件正被别的程序占用（${code}）`;
  if (code === 'ENOSPC') return '磁盘空间不足（ENOSPC）';
  if (code === 'EROFS') return '目标位置是只读的（EROFS）';
  return code ? `系统错误 ${code}` : '未知错误';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 报错与列表里显示的路径：去掉控制字符并截断，别让一个恶意文件名污染界面。 */
export function displayPath(raw) {
  const text = String(raw ?? '').replace(/[\x00-\x1f\x7f]/g, '?');
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

/**
 * 判定包里的一个相对路径。
 *   fatal  → 明显在试图逃出技能目录（.. / 绝对路径 / 盘符 / 反斜杠 / 控制字符），整包拒绝；
 *   skip   → 只是不适合带进来（隐藏文件、node_modules、Windows 上不合法的名字、太深），跳过并报告。
 */
export function classifyBundlePath(raw, limits = BUNDLE_LIMITS) {
  if (typeof raw !== 'string' || raw === '') return { ok: false, fatal: true, reason: 'empty' };
  if (CONTROL_CHARS.test(raw)) return { ok: false, fatal: true, reason: 'control-char' };
  if (raw.includes('\\')) return { ok: false, fatal: true, reason: 'backslash' };
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return { ok: false, fatal: true, reason: 'absolute' };
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { ok: false, fatal: true, reason: 'traversal' };
  }
  if (raw.length > limits.maxPathLength) return { ok: false, fatal: false, reason: 'too-long' };
  if (segments.length > limits.maxDepth) return { ok: false, fatal: false, reason: 'too-deep' };
  for (const segment of segments) {
    if (segment.startsWith('.')) return { ok: false, fatal: false, reason: 'hidden' };
    if (segment === 'node_modules') return { ok: false, fatal: false, reason: 'node_modules' };
    if (segment.length > limits.maxSegmentLength) return { ok: false, fatal: false, reason: 'too-long' };
    if (WINDOWS_ILLEGAL.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment)) {
      return { ok: false, fatal: false, reason: 'unsafe-name' };
    }
  }
  return { ok: true, path: raw, segments };
}

/**
 * 校验一个技能包。输入：[{ path, bytes, executable? }]（path 用 /，相对技能目录）。
 * 通过后返回规范化的文件表；任何致命问题都返回 { ok:false, code, error }，不抛。
 */
export function validateBundle(inputFiles, limits = BUNDLE_LIMITS) {
  const fail = (code, error) => ({ ok: false, code, error });
  if (!Array.isArray(inputFiles) || inputFiles.length === 0) return fail('empty', '没有可导入的文件');
  if (inputFiles.length > limits.maxRawEntries) return fail('too-many-files', `文件太多（上限 ${limits.maxFiles} 个）`);

  const files = [];
  const skipped = [];
  const seen = new Set();
  let totalBytes = 0;
  let caseVariant = '';
  for (const entry of inputFiles) {
    const rawPath = entry && entry.path;
    const verdict = classifyBundlePath(rawPath, limits);
    if (!verdict.ok) {
      if (verdict.fatal) return fail('unsafe-path', `文件路径不安全，已拒绝整个导入：${displayPath(rawPath)}`);
      skipped.push(skippedEntry(rawPath, verdict.reason));
      continue;
    }
    const bytes = entry.bytes;
    if (!Buffer.isBuffer(bytes)) return fail('bad-data', `文件内容不合法：${displayPath(rawPath)}`);
    if (bytes.length > limits.maxFileBytes) {
      return fail('file-too-large', `${displayPath(rawPath)} 超过单个文件 ${formatBytes(limits.maxFileBytes)} 的上限`);
    }
    const key = verdict.path.toLowerCase();
    if (seen.has(key)) return fail('duplicate-path', `有两个只差大小写的同名文件：${displayPath(rawPath)}`);
    seen.add(key);
    if (key === SKILL_FILE.toLowerCase() && verdict.path !== SKILL_FILE) caseVariant = verdict.path;
    totalBytes += bytes.length;
    if (totalBytes > limits.maxTotalBytes) return fail('too-large', `技能超过 ${formatBytes(limits.maxTotalBytes)} 的总大小上限`);
    files.push({ path: verdict.path, bytes, executable: entry.executable === true });
    if (files.length > limits.maxFiles) return fail('too-many-files', `文件太多（上限 ${limits.maxFiles} 个）`);
  }
  // 「a」是文件、同时又有「a/b」—— 落盘时一个要当目录、一个要当文件，必然冲突
  for (const file of files) {
    const parts = file.path.toLowerCase().split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (seen.has(parts.slice(0, depth).join('/'))) {
        return fail('duplicate-path', `文件与目录同名：${displayPath(file.path)}`);
      }
    }
  }
  if (!files.some((file) => file.path === SKILL_FILE)) {
    return fail(
      'no-skill-md',
      caseVariant ? `文件名必须是大写的 SKILL.md（找到的是 ${displayPath(caseVariant)}）` : '顶层没有 SKILL.md，这不是一个技能目录',
    );
  }
  files.sort((a, b) => (a.path === SKILL_FILE ? -1 : b.path === SKILL_FILE ? 1 : a.path.localeCompare(b.path)));
  return { ok: true, files, skipped, totalBytes };
}

/**
 * 只读地把磁盘上的一个技能目录读成「包」。不跟随内部的符号链接，
 * 跳过隐藏条目与 node_modules；超出上限直接失败（抛 codeError），不做「读一半」。
 */
export function readSkillTree(rootDir, limits = BUNDLE_LIMITS) {
  const files = [];
  const skipped = [];
  let totalBytes = 0;
  let visited = 0;
  const walk = (abs, rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      throw codeError('unreadable', `读不了目录：${displayPath(rel || '.')}`);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > limits.maxRawEntries) throw codeError('too-many-files', `文件太多（上限 ${limits.maxFiles} 个）`);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.')) {
        skipped.push(skippedEntry(childRel, 'hidden'));
        continue;
      }
      if (entry.name === 'node_modules') {
        skipped.push(skippedEntry(childRel, 'node_modules'));
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped.push(skippedEntry(childRel, 'symlink'));
        continue;
      }
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 >= limits.maxDepth) {
          skipped.push(skippedEntry(childRel, 'too-deep'));
          continue;
        }
        walk(full, childRel, depth + 1);
        continue;
      }
      const stat = lstatOrNull(full);
      if (!stat || !stat.isFile()) {
        skipped.push(skippedEntry(childRel, 'special'));
        continue;
      }
      if (stat.size > limits.maxFileBytes) {
        throw codeError('file-too-large', `${displayPath(childRel)} 超过单个文件 ${formatBytes(limits.maxFileBytes)} 的上限`);
      }
      if (files.length + 1 > limits.maxFiles) throw codeError('too-many-files', `文件太多（上限 ${limits.maxFiles} 个）`);
      totalBytes += stat.size;
      if (totalBytes > limits.maxTotalBytes) throw codeError('too-large', `技能超过 ${formatBytes(limits.maxTotalBytes)} 的总大小上限`);
      let bytes;
      try {
        bytes = fs.readFileSync(full);
      } catch {
        throw codeError('unreadable', `读不了文件：${displayPath(childRel)}`);
      }
      files.push({ path: childRel, bytes, executable: process.platform !== 'win32' && (stat.mode & 0o111) !== 0 });
    }
  };
  walk(rootDir, '', 0);
  return { files, skipped, totalBytes };
}

/** Windows 上杀毒 / 索引服务会短暂占着刚写完的文件，rename 偶发 EPERM —— 稍等再试。 */
async function renameWithRetry(from, to, rename = fs.renameSync) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      if (attempt >= 4 || !err || !RETRYABLE.has(err.code)) throw err;
      await sleep(25 * (attempt + 1));
    }
  }
}

/** 清掉本模块上次崩溃留下的临时目录（只认自己的命名，且要足够旧）。 */
function sweepStaleTemp(rootDir, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(rootDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TEMP_DIR_PATTERN.test(name)) continue;
    const full = path.join(rootDir, name);
    try {
      if (now - fs.lstatSync(full).mtimeMs > STALE_TEMP_MS) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* 清不掉就留着：它是点开头的目录，pi 不会把它当技能 */
    }
  }
}

/**
 * 把一个已校验的包装进 rootDir/name。
 * 先写进同一目录下的临时目录（点开头，pi 的扫描会跳过），全部写完再 rename ——
 * 任何一步失败都把临时目录删掉，目标位置要么是完整的技能，要么什么都没有。
 */
export async function installBundle({ rootDir, name, files }) {
  fs.mkdirSync(rootDir, { recursive: true });
  sweepStaleTemp(rootDir);
  const dest = path.join(rootDir, name);
  if (lstatOrNull(dest)) throw codeError('exists', `「${name}」已经存在`);
  const temp = path.join(rootDir, `.pi-gui-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(temp);
  try {
    for (const file of files) {
      const target = path.join(temp, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.bytes, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
    }
    if (lstatOrNull(dest)) throw codeError('exists', `「${name}」已经存在`);
    await renameWithRetry(temp, dest);
  } catch (err) {
    try {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 留下的是点开头的临时目录，下次安装时会被清掉 */
    }
    throw err;
  }
  return dest;
}

/** 原子地覆盖一个已有文件：同目录临时文件 + rename，保留原文件的权限位。 */
export async function writeFileAtomic(file, bytes) {
  const stat = lstatOrNull(file);
  const mode = stat ? stat.mode & 0o777 : 0o644;
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx', mode });
    await renameWithRetry(temp, file);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* 临时文件可能根本没建出来 */
    }
    throw err;
  }
}

/** 精确到毫秒：回收站条目按名字排序就是按时间排序。 */
function timestamp(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    pad(date.getUTCFullYear(), 4) + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate()) +
    pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + pad(date.getUTCMilliseconds(), 3)
  );
}

/**
 * 回收站：<dataDir>/skills-trash/<id>/{meta.json,payload}。
 *
 * 删除、覆盖、编辑前的备份都落在这里。删除类条目不自动清理（那是用户的数据）；
 * 编辑备份每个文件只留最近几份。dataDir 没配时整个回收站不可用，
 * 调用方必须拒绝删除 —— 这个模块从不做「真删」。
 */
export function createSkillsTrash({ dataDir = null, now = () => new Date(), rename = fs.renameSync, editBackupsPerFile = 5 } = {}) {
  const root = dataDir ? path.join(dataDir, 'skills-trash') : null;

  function entryDir(id) {
    if (!root || typeof id !== 'string' || !TRASH_ID_PATTERN.test(id)) return null;
    return path.join(root, id);
  }

  function newEntry(prefix, meta) {
    if (!root) throw codeError('trash-unavailable', '回收站不可用，为避免无法恢复，本次操作已拒绝');
    const id = `${prefix}-${timestamp(now())}-${crypto.randomBytes(4).toString('hex')}`;
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, id, trashedAt: now().toISOString(), ...meta }, null, 2) + '\n', 'utf8');
    return { id, dir, payload: path.join(dir, 'payload') };
  }

  /** 跨盘时 rename 会 EXDEV：先完整拷进回收站，再把原件改成隐藏名后删除。 */
  async function moveAcrossDevices(source, payload) {
    fs.cpSync(source, payload, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    const hidden = path.join(path.dirname(source), `.pi-gui-del-${crypto.randomBytes(6).toString('hex')}`);
    await renameWithRetry(source, hidden);
    try {
      fs.rmSync(hidden, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 删不干净也已经从技能目录里消失了（点开头，pi 不认），回收站里有完整副本 */
    }
  }

  async function moveInto(source, payload) {
    try {
      await renameWithRetry(source, payload, rename);
    } catch (err) {
      if (!err || err.code !== 'EXDEV') throw err;
      await moveAcrossDevices(source, payload);
    }
  }

  /** 把一个技能目录或单文件技能挪进回收站。 */
  async function put({ source, kind, meta }) {
    const entry = newEntry('del', { kind, ...meta });
    try {
      await moveInto(source, entry.payload);
    } catch (err) {
      fs.rmSync(entry.dir, { recursive: true, force: true });
      throw err;
    }
    return entry.id;
  }

  /** 编辑前的备份：存旧字节，只留每个文件最近的几份。 */
  function putBackup({ bytes, pathHash, meta }) {
    const entry = newEntry(`edit-${pathHash}`, { kind: 'backup', ...meta });
    try {
      fs.writeFileSync(entry.payload, bytes, { flag: 'wx' });
    } catch (err) {
      fs.rmSync(entry.dir, { recursive: true, force: true });
      throw err;
    }
    try {
      // 刚存的这一份永远留着（它对应的撤销令牌刚发出去）；其余的只留最近几份
      const older = fs.readdirSync(root)
        .filter((name) => name !== entry.id && name.startsWith(`edit-${pathHash}-`) && TRASH_ID_PATTERN.test(name))
        .sort();
      for (const name of older.slice(0, Math.max(0, older.length - (editBackupsPerFile - 1)))) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
    } catch {
      /* 清理旧备份失败不影响这次保存 */
    }
    return entry.id;
  }

  function read(id) {
    const dir = entryDir(id);
    if (!dir) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      if (!meta || typeof meta !== 'object' || meta.id !== id || typeof meta.originalPath !== 'string') return null;
      const payload = path.join(dir, 'payload');
      if (!lstatOrNull(payload)) return null;
      return { meta, payload, dir };
    } catch {
      return null;
    }
  }

  /** 把回收站里的条目放回 dest（dest 必须是空位），成功后条目消失。 */
  async function restore(id, dest) {
    const entry = read(id);
    if (!entry) throw codeError('trash-missing', '回收站里已经没有这一项了');
    if (lstatOrNull(dest)) throw codeError('exists', '原来的位置已经有别的东西了');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      await renameWithRetry(entry.payload, dest, rename);
    } catch (err) {
      if (!err || err.code !== 'EXDEV') throw err;
      fs.cpSync(entry.payload, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    }
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }

  function discard(id) {
    const dir = entryDir(id);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }

  return { available: Boolean(root), root, put, putBackup, read, restore, discard };
}

/**
 * 有上限、会过期的令牌表：导入暂存、市场预览、撤销句柄都放这里。
 * 令牌是随机数，前端只能把它原样带回来，带不了路径也带不了内容。
 */
export function createTokenStore({ ttlMs, maxEntries, maxBytes = Infinity, now = Date.now } = {}) {
  const entries = new Map();
  let totalBytes = 0;

  function drop(id) {
    const entry = entries.get(id);
    if (!entry) return;
    totalBytes -= entry.bytes;
    entries.delete(id);
  }

  function sweep() {
    const cutoff = now() - ttlMs;
    for (const [id, entry] of entries) if (entry.at < cutoff) drop(id);
  }

  function put(value, bytes = 0) {
    sweep();
    const id = crypto.randomBytes(12).toString('hex');
    entries.set(id, { value, bytes, at: now() });
    totalBytes += bytes;
    // Map 保持插入顺序：最旧的先走。刚放进去的这一条永远留着
    for (const oldest of entries.keys()) {
      if (entries.size <= maxEntries && totalBytes <= maxBytes) break;
      if (oldest === id) break;
      drop(oldest);
    }
    return id;
  }

  function get(id) {
    sweep();
    const entry = typeof id === 'string' ? entries.get(id) : null;
    return entry ? entry.value : null;
  }

  function take(id) {
    const value = get(id);
    if (value !== null) drop(id);
    return value;
  }

  return { put, get, take, delete: drop, get size() { return entries.size; } };
}
