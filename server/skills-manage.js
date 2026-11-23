/* 技能的写入侧：新建、编辑、删除、安装（导入 / 扫描 / 市场共用）与撤销。
 *
 * 这个模块回答三个问题，并且只在这里回答：
 *   1. 能往哪写 —— 只有四个写入目标（见 listTargets），前端传的是目标的 key，
 *      不是路径；项目级目标还要过「项目信任」与「目录没被链接到别处」两道闸。
 *   2. 哪个技能能改 —— 必须真实落在某个写入目标之下，且一路上没有符号链接；
 *      其余来源（上级目录的 .agents/skills、settings 声明的路径、包里的技能）一律只读。
 *   3. 改坏了怎么办 —— 删除、覆盖都是挪进回收站，编辑前先备份旧字节，
 *      每一步都给出一个短期有效的撤销令牌。
 *
 * 不做 HTTP（那在 skills-routes.js），也不碰 pi 的 settings.json（启停仍在 skills.js）。
 * 所有函数返回普通对象：{ ok:true, … } 或 { ok:false, status, code, error }。 */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, normalizeForCompare } from '../lib/safe-path.js';
import {
  composeEditedDocument,
  composeNewDocument,
  decodeSkillBytes,
  encodeSkillText,
  normalizeDescription,
  rewriteFrontmatterKey,
  skillFormView,
  splitSkillDocument,
  summarizeSkillText,
} from './skills-document.js';
import {
  codeError, createSkillsTrash, createTokenStore, describeError, formatBytes, installBundle,
  matchesInstalledBundle, sha256Hex, writeFileAtomic,
} from './skills-files.js';

const SKILL_FILE = 'SKILL.md';
const UNDO_TTL_MS = 30 * 60 * 1000;
const UNDO_MAX_ENTRIES = 64;
const MAX_RENAME_ATTEMPTS = 99;
const MAX_NAME_LENGTH = 64;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

const TRUST_HOW = '在项目目录的终端里运行 pi 并按提示信任它（或输入 /trust）';
const UNTRUSTED_REASON = `当前项目未被信任：pi 不会加载它的项目级技能，Pi GUI 也不改动它。请先${TRUST_HOW}，或改为保存到全局。`;
const DECIDED_UNTRUSTED_REASON = `这个项目已被设为不信任，pi 不会加载写进去的项目级技能。请先${TRUST_HOW}，或改为保存到全局。`;
const FIRST_RESOURCE_NOTICE = `这是该项目的第一个项目级资源。保存后需要${TRUST_HOW}，pi 才会加载它。`;
const NO_TRASH_REASON = '回收站不可用，为避免无法恢复，本次操作已拒绝';

export const fail = (status, code, error, extra = {}) => ({ ok: false, status, code, error, ...extra });

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function directoryIdentity(dir) {
  const stat = statOrNull(dir);
  return stat?.isDirectory() ? JSON.stringify([canonicalPath(dir), stat.dev, stat.ino]) : null;
}

/** canonical(target) 是否正好等于 canonical(root) + 两者的字面相对路径 —— 即 root 之下没有任何链接。 */
function sameRealLayout(root, target) {
  try {
    const want = path.join(canonicalPath(root), path.relative(path.resolve(root), path.resolve(target)));
    return normalizeForCompare(canonicalPath(target)) === normalizeForCompare(want);
  } catch {
    return false;
  }
}

/**
 * @param core     skills.js 注入的只读能力：paths / buildIndex / readTrustState / approve /
 *                 isPiRunning / skillId / pathKey / validateName / maxSkillBytes / maxDescriptionLength
 * @param dataDir  Pi GUI 的数据目录；回收站放在它下面。不传则删除、覆盖、编辑一律拒绝。
 */
export function createSkillsManager({ core, dataDir = null, now = () => new Date() }) {
  const trash = createSkillsTrash({ dataDir, now });
  const journal = createTokenStore({ ttlMs: UNDO_TTL_MS, maxEntries: UNDO_MAX_ENTRIES, now: () => now().getTime() });
  const { pathKey } = core;

  /* 写操作串行执行：两次点击之间的「检查 → 写入」不会交错。 */
  let tail = Promise.resolve();
  function exclusive(task) {
    const run = tail.then(task, task);
    tail = run.then(() => {}, () => {});
    return run;
  }

  /* ---------- 写入目标 ---------- */

  /**
   * 项目级写入的信任判定。
   *   现在就不被信任 → 拒绝；
   *   现在被信任，写入后仍被信任 → 放行；
   *   现在「被信任」只是因为项目里还没有任何需要信任的资源、也没有人做过决定 →
   *     放行，但如实告知：写入后 pi 要先信任这个项目才会加载；
   *   写入后会落到一个明确的「不信任」决定上 → 拒绝。
   */
  function trustVerdict(p) {
    const args = { cwd: p.cwd, agentDir: p.agentDir, homeDir: p.homeDir, trustOverride: core.approve };
    const current = core.readTrustState(args);
    if (current.trusted !== true) return { allowed: false, reason: UNTRUSTED_REASON };
    const after = core.readTrustState({ ...args, assumeResources: true });
    if (after.trusted === true) return { allowed: true, notice: '' };
    if (after.reason === 'ask-no-ui') return { allowed: true, notice: FIRST_RESOURCE_NOTICE };
    return { allowed: false, reason: DECIDED_UNTRUSTED_REASON };
  }

  /**
   * 项目里要写入的目录不能是链接，也不能解析到项目之外。
   * 技能目标要查两级（.pi / .agents 与其下的 skills）；设置文件只有 .pi 一级。
   */
  function projectRootProblem(cwd, dir, { parts = [path.dirname(dir), dir], what = '技能目录' } = {}) {
    const cwdStat = statOrNull(cwd);
    if (!cwdStat || !cwdStat.isDirectory()) return '项目目录不存在';
    for (const part of parts) {
      const stat = lstatOrNull(part);
      if (!stat) continue;
      const shown = path.relative(cwd, part).split(path.sep).join('/');
      if (stat.isSymbolicLink()) return `项目里的 ${shown} 是一个链接，无法保证它指向哪里，已拒绝写入`;
      if (!stat.isDirectory()) return `项目里的 ${shown} 不是目录`;
    }
    return sameRealLayout(cwd, dir) ? '' : `项目的${what}指向了项目之外，已拒绝写入`;
  }

  /**
   * 项目的 pi 设置文件能不能写（技能启停写的就是它）。
   * 闸与项目级写入目标是同一组 —— 父目录不是链接、没有落到项目之外、项目被信任 ——
   * 但只看这次真正要写的位置：旁边的 skills 目录长什么样与这次写入无关。
   * 文件本身是不是普通文件由调用方检查（全局设置文件也要过那一条）。
   */
  function projectSettingsGate(context) {
    const p = core.paths(context.cwd);
    if (!p.cwd || !p.projectSettings) return fail(403, 'project-missing', '没有打开项目');
    const dir = path.dirname(p.projectSettings);
    const problem = projectRootProblem(p.cwd, dir, { parts: [dir], what: '配置目录' });
    if (problem) return fail(403, statOrNull(p.cwd) ? 'unsafe-root' : 'project-missing', problem);
    const verdict = trustVerdict(p);
    return verdict.allowed ? { ok: true } : fail(403, 'project-untrusted', verdict.reason);
  }

  /** 用户级目录可以是用户自己做的链接（pi 也会跟随）；只要求「存在的话是个目录」。 */
  function userRootProblem(target) {
    const stat = statOrNull(target.dir);
    if (stat) return stat.isDirectory() ? '' : `${target.label} 不是目录`;
    return lstatOrNull(target.dir) ? `${target.label} 是一个失效的链接` : '';
  }

  function listTargets(context) {
    const p = core.paths(context.cwd);
    const userAgents = path.join(p.homeDir, '.agents', 'skills');
    const targets = [
      { key: 'user-pi', scope: 'user', mode: 'pi', dir: path.join(p.agentDir, 'skills'), label: '~/.pi/agent/skills' },
      { key: 'user-agents', scope: 'user', mode: 'agents', dir: userAgents, label: '~/.agents/skills' },
    ];
    if (p.cwd) {
      targets.push({ key: 'project-pi', scope: 'project', mode: 'pi', dir: path.join(p.cwd, '.pi', 'skills'), label: '<项目>/.pi/skills' });
      const projectAgents = path.join(p.cwd, '.agents', 'skills');
      // 项目就是主目录时，它的 .agents/skills 就是全局那个 —— pi 把它算作全局，这里也不重复列
      if (pathKey(projectAgents) !== pathKey(userAgents)) {
        targets.push({ key: 'project-agents', scope: 'project', mode: 'agents', dir: projectAgents, label: '<项目>/.agents/skills' });
      }
    }
    let verdict = null;
    return targets.map((target) => {
      const exists = Boolean(statOrNull(target.dir));
      const blocked = (code, reason) => ({ ...target, exists, writable: false, blockedCode: code, blockedReason: reason, notice: '' });
      if (target.scope === 'user') {
        const problem = userRootProblem(target);
        return problem ? blocked('root-unusable', problem) : { ...target, exists, writable: true, blockedCode: '', blockedReason: '', notice: '' };
      }
      const problem = projectRootProblem(p.cwd, target.dir);
      if (problem) return blocked(statOrNull(p.cwd) ? 'unsafe-root' : 'project-missing', problem);
      verdict = verdict || trustVerdict(p);
      if (!verdict.allowed) return blocked('project-untrusted', verdict.reason);
      return { ...target, exists, writable: true, blockedCode: '', blockedReason: '', notice: verdict.notice };
    });
  }

  /* ---------- 单个技能能不能改 ---------- */

  function manageOf(rec, targets) {
    const readOnly = (reason, extra = {}) => ({ target: null, kind: '', unit: '', editable: false, deletable: false, reason, ...extra });
    if (!rec.path) return readOnly('这个技能由 pi 报告，Pi GUI 没有定位到它的文件');
    const key = pathKey(rec.path);
    const target = targets.find((candidate) => key.startsWith(pathKey(candidate.dir) + path.sep));
    if (!target) return readOnly(`它位于 ${rec.rootLabel || '其他目录'}，不在 Pi GUI 管理的技能目录里`);

    const dir = path.dirname(rec.path);
    const isSkillFile = path.basename(rec.path) === SKILL_FILE;
    // dir：<根>/…/名字/SKILL.md；file：单个 .md 技能；root：SKILL.md 直接放在根目录里
    const kind = !isSkillFile ? 'file' : pathKey(dir) === pathKey(target.dir) ? 'root' : 'dir';
    const unit = kind === 'dir' ? dir : rec.path;
    const base = { target: target.key, kind, unit };
    if (!target.writable) return readOnly(target.blockedReason, base);

    const fileStat = lstatOrNull(rec.path);
    if (!fileStat) return readOnly('它的文件已经不在磁盘上了', base);
    if (!fileStat.isFile()) return readOnly('它的技能文件是一个链接，请到原位置修改', base);
    if (kind === 'dir') {
      const unitStat = lstatOrNull(unit);
      if (!unitStat || !unitStat.isDirectory()) return readOnly('这个技能目录是一个链接，请到原位置修改', base);
    }
    if (!sameRealLayout(target.dir, rec.path)) return readOnly('它经由链接指向了技能目录之外，请到原位置修改', base);

    if (kind === 'root') return { ...base, editable: true, deletable: false, reason: 'SKILL.md 直接放在技能根目录里，不能在这里删除' };
    if (!trash.available) return { ...base, editable: false, deletable: false, reason: NO_TRASH_REASON };
    return { ...base, editable: true, deletable: true, reason: '' };
  }

  /** 列表用：写入目标 + 每个技能的可管理标记。 */
  function describe(idx, context) {
    const targets = listTargets(context);
    const manage = new Map();
    for (const rec of idx.skills) {
      const managed = manageOf(rec, targets);
      manage.set(rec.id, { target: managed.target, editable: managed.editable, deletable: managed.deletable, reason: managed.reason });
    }
    return { targets, manage, trashAvailable: trash.available };
  }

  async function resolveManaged(context, id) {
    const idx = await core.buildIndex(context);
    const rec = idx.index.get(id);
    if (!rec) return fail(404, 'not-found', '找不到这个技能（可能刚被删掉或改名，刷新一下列表）');
    const targets = listTargets(context);
    const managed = manageOf(rec, targets);
    return { ok: true, idx, rec, managed, target: targets.find((target) => target.key === managed.target) || null };
  }

  /** pi 正在运行时，全局技能的变化、以及「当前工作区」项目技能的变化要重启才生效。 */
  function restartNeeded(context, scope) {
    if (!core.isPiRunning()) return false;
    return scope === 'user' || context.live === true;
  }

  /* ---------- 校验 ---------- */

  /** 一份完整的 SKILL.md 文本：errors 是「pi 不会加载」，warnings 是「不合规范但能用」。 */
  function validateText(text, { dirName = '' } = {}) {
    const errors = [];
    const warnings = [];
    const summary = summarizeSkillText(text);
    if (text.includes('\x00')) errors.push({ field: 'content', message: '内容里有空字符' });
    if (!summary.hasFrontmatter) {
      errors.push({ field: 'content', message: '开头没有 frontmatter（两行 --- 之间的那一段），pi 不会加载这个技能' });
      return { errors, warnings, summary };
    }
    const description = summary.description;
    if (!description.found) {
      errors.push({ field: 'description', message: 'frontmatter 里没有 description，pi 不会加载这个技能' });
    } else if (!description.readable) {
      warnings.push({ field: 'description', message: 'description 的写法比较特殊，这里无法校验，请确认它是一段非空文字' });
    } else if (!description.value) {
      errors.push({ field: 'description', message: 'description 是空的，pi 不会加载这个技能' });
    } else if (description.nonString) {
      errors.push({ field: 'description', message: 'description 会被 YAML 读成数字或布尔值，pi 不会加载；请给它加上引号' });
    } else if (description.value.length > core.maxDescriptionLength) {
      warnings.push({ field: 'description', message: `description 超过 ${core.maxDescriptionLength} 字符（${description.value.length}）` });
    }
    const name = summary.name;
    if (name.found && !name.readable) {
      warnings.push({ field: 'name', message: 'name 的写法比较特殊，这里无法校验' });
    } else if (name.found && name.value) {
      for (const message of core.validateName(name.value)) warnings.push({ field: 'name', message });
      if (dirName && name.value !== dirName) {
        warnings.push({ field: 'name', message: `name（${name.value}）与目录名（${dirName}）不一致，pi 以 frontmatter 里的为准` });
      }
    }
    return { errors, warnings, summary };
  }

  /** 目录名必须符合 Agent Skills 的命名规则；返回给界面看的问题列表。 */
  function nameProblems(name) {
    if (typeof name !== 'string' || !name) return ['请填写名称'];
    const problems = core.validateName(name).map((message) => message.replace(/^name /, '名称'));
    // con / nul / com1 … 符合命名规则，但在 Windows 上是设备名：建得出来却删不掉、同步不走
    if (WINDOWS_RESERVED_NAME.test(name)) problems.push('名称不能用 Windows 的保留名（con、nul、com1 等），请换一个');
    return problems;
  }

  /** 新建表单：名称按 Agent Skills 规范严格校验（它同时是目录名）。 */
  function checkNew({ name, description, body }) {
    const errors = [];
    const cleanName = typeof name === 'string' ? name.trim() : '';
    for (const message of nameProblems(cleanName)) errors.push({ field: 'name', message });
    const cleanDescription = normalizeDescription(typeof description === 'string' ? description : '');
    if (!cleanDescription) {
      errors.push({ field: 'description', message: '请填写描述，pi 靠它判断什么时候使用这个技能' });
    } else if (cleanDescription.length > core.maxDescriptionLength) {
      errors.push({ field: 'description', message: `描述超过 ${core.maxDescriptionLength} 字符（${cleanDescription.length}）` });
    }
    const rawBody = typeof body === 'string' ? body : '';
    if (body !== undefined && body !== null && typeof body !== 'string') errors.push({ field: 'body', message: '正文必须是文本' });
    if (rawBody.includes('\x00')) errors.push({ field: 'body', message: '正文里有空字符' });
    const text = composeNewDocument({ name: cleanName, description: cleanDescription, body: rawBody });
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > core.maxSkillBytes) errors.push({ field: 'body', message: `内容超过 ${formatBytes(core.maxSkillBytes)}` });
    return { errors, name: cleanName, text, bytes };
  }

  /**
   * 安装前看一眼包里的 SKILL.md：读得出来吗、pi 会不会加载它。
   * 读不出来（太大、不是 UTF-8）直接失败；「pi 不会加载」只作为 problems 报告，由用户决定。
   */
  function inspectBundle(files, { dirName = '' } = {}) {
    const skill = files.find((file) => file.path === SKILL_FILE);
    if (!skill) return fail(400, 'no-skill-md', '顶层没有 SKILL.md，这不是一个技能目录');
    if (skill.bytes.length > core.maxSkillBytes) return fail(413, 'skill-md-too-large', `SKILL.md 超过 ${formatBytes(core.maxSkillBytes)}`);
    const decoded = decodeSkillBytes(skill.bytes);
    if (!decoded.ok) return fail(400, decoded.code, `SKILL.md ${decoded.error.replace(/^文件/, '')}`);
    const verdict = validateText(decoded.text, { dirName });
    return {
      ok: true,
      text: decoded.text,
      name: verdict.summary.name.value,
      description: verdict.summary.description.value,
      problems: [
        ...verdict.errors.map((entry) => ({ level: 'error', message: entry.message })),
        ...verdict.warnings.map((entry) => ({ level: 'warn', message: entry.message })),
      ],
    };
  }

  /** 同名的其他技能（pi 只加载优先级更高的那一个）。exceptDir 是正在被覆盖的那个目录，不算。 */
  function sameNameWarnings(idx, name, exceptDir = '') {
    const except = exceptDir ? pathKey(exceptDir) + path.sep : '';
    return idx.skills
      .filter((skill) => skill.name === name && (!skill.path || !except || !pathKey(skill.path).startsWith(except)))
      .slice(0, 3)
      .map((skill) => `已有同名技能「${name}」（${skill.rootLabel}）。pi 只加载优先级更高的那一个，另一个会显示为「被覆盖」。`);
  }

  /* ---------- 读写单个 SKILL.md ---------- */

  function readEditable(file) {
    const stat = lstatOrNull(file);
    if (!stat) return fail(404, 'missing', '文件已经不在了，刷新一下列表');
    if (!stat.isFile()) return fail(403, 'read-only', '它的技能文件是一个链接，请到原位置修改');
    if (stat.size > core.maxSkillBytes) return fail(413, 'too-large', `文件超过 ${formatBytes(core.maxSkillBytes)}，无法在这里编辑`);
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch (err) {
      return fail(500, 'unreadable', `读不了文件：${describeError(err)}`);
    }
    const decoded = decodeSkillBytes(bytes);
    if (!decoded.ok) return fail(409, decoded.code, `${decoded.error}，无法在这里编辑`);
    return { ok: true, bytes, decoded, hash: sha256Hex(bytes) };
  }

  async function readSource(context, id) {
    const hit = await resolveManaged(context, id);
    if (!hit.ok) return hit;
    const { rec, managed, target } = hit;
    if (!managed.editable) return fail(403, 'read-only', managed.reason);
    const read = readEditable(rec.path);
    if (!read.ok) return read;
    return {
      ok: true,
      id,
      name: rec.name,
      dirName: managed.kind === 'dir' ? path.basename(managed.unit) : '',
      scope: rec.scope,
      target: target.key,
      targetLabel: target.label,
      path: rec.path,
      content: read.decoded.text,
      hash: read.hash,
      eol: read.decoded.eol,
      bom: read.decoded.bom,
      bytes: read.bytes.length,
      form: skillFormView(read.decoded.text),
      limits: { maxBytes: core.maxSkillBytes, maxDescription: core.maxDescriptionLength },
    };
  }

  /** 把编辑器提交的内容变成完整文本。form 只动 description 与正文，raw 整份替换。 */
  function composeEdit(baseText, payload, dirName) {
    if (payload.mode === 'raw') {
      if (typeof payload.content !== 'string') return fail(400, 'bad-request', 'content 必须是字符串');
      return { ok: true, text: payload.content.replace(/\r\n?/g, '\n') };
    }
    if (payload.mode !== 'form') return fail(400, 'bad-request', 'mode 只能是 form 或 raw');
    if (typeof payload.description !== 'string' || typeof payload.body !== 'string') {
      return fail(400, 'bad-request', 'description 与 body 必须是字符串');
    }
    const fallbackName = dirName && core.validateName(dirName).length === 0 ? dirName : '';
    const composed = composeEditedDocument(baseText, { description: payload.description, body: payload.body, fallbackName });
    if (!composed.ok) return fail(409, 'form-unavailable', `${composed.reason}，请改用「源文件」模式`);
    return { ok: true, text: composed.text };
  }

  async function saveSourceNow(context, id, payload) {
    const hit = await resolveManaged(context, id);
    if (!hit.ok) return hit;
    const { rec, managed, target } = hit;
    if (!managed.editable) return fail(403, 'read-only', managed.reason);
    if (!trash.available) return fail(503, 'trash-unavailable', NO_TRASH_REASON);
    if (typeof payload.baseHash !== 'string' || !payload.baseHash) return fail(400, 'bad-request', '缺少 baseHash');
    const read = readEditable(rec.path);
    if (!read.ok) return read;
    if (payload.baseHash !== read.hash) {
      return fail(409, 'changed-on-disk', '这个文件在你编辑期间被别的程序改过了。请重新打开再改，免得覆盖那次修改。');
    }
    const dirName = managed.kind === 'dir' ? path.basename(managed.unit) : '';
    const composed = composeEdit(read.decoded.text, payload, dirName);
    if (!composed.ok) return composed;
    const verdict = validateText(composed.text, { dirName });
    if (verdict.errors.length) return fail(400, 'invalid', verdict.errors[0].message, { errors: verdict.errors, warnings: verdict.warnings });
    const bytes = encodeSkillText(composed.text, { bom: read.decoded.bom, eol: read.decoded.eol });
    if (bytes.length > core.maxSkillBytes) return fail(413, 'too-large', `内容超过 ${formatBytes(core.maxSkillBytes)}`);
    if (bytes.equals(read.bytes)) return { ok: true, changed: false, hash: read.hash, bytes: bytes.length, warnings: verdict.warnings, restartRequired: false };

    let backupId;
    const rootIdentity = directoryIdentity(target.dir);
    try {
      backupId = trash.putBackup({
        bytes: read.bytes,
        pathHash: core.skillId(rec.path),
        meta: { name: rec.name, scope: rec.scope, originalPath: rec.path, reason: 'edit' },
      });
      await writeFileAtomic(rec.path, bytes);
    } catch (err) {
      return fail(500, 'write-failed', `保存失败：${describeError(err)}`);
    }
    // 正文是 pi 用到时才读的；只有 frontmatter（名称、描述、开关）变了才需要重启
    const before = splitSkillDocument(read.decoded.text);
    const after = splitSkillDocument(composed.text);
    const metaChanged = before.hasFrontmatter !== after.hasFrontmatter || before.yaml !== after.yaml;
    const restartRequired = metaChanged && restartNeeded(context, rec.scope);
    const afterHash = sha256Hex(bytes);
    const undo = journal.put({
      kind: 'edit', name: rec.name, file: rec.path, rootDir: target.dir, rootIdentity, scope: target.scope, cwd: context.cwd || '',
      backupId, afterHash, restartRequired,
    });
    return { ok: true, changed: true, hash: afterHash, bytes: bytes.length, warnings: verdict.warnings, metaChanged, restartRequired, undo };
  }

  /** 不写盘的校验：编辑器边输入边调用，也用来在「表单 / 源文件」之间转换。 */
  async function check(context, payload) {
    if (payload.kind === 'create') {
      const result = checkNew(payload);
      const warnings = [];
      const nameOk = !result.errors.some((entry) => entry.field === 'name');
      if (nameOk && typeof payload.target === 'string') {
        const target = listTargets(context).find((candidate) => candidate.key === payload.target);
        if (target && lstatOrNull(path.join(target.dir, result.name))) {
          result.errors.push({ field: 'name', message: `「${result.name}」在 ${target.label} 里已经存在` });
        } else if (target) {
          const idx = await core.buildIndex(context);
          for (const message of sameNameWarnings(idx, result.name)) warnings.push({ field: 'name', message });
        }
      }
      return { ok: true, errors: result.errors, warnings, bytes: result.bytes.length, content: result.text };
    }
    if (payload.kind !== 'form' && payload.kind !== 'raw') return fail(400, 'bad-request', 'kind 不合法');
    let baseText = '';
    let dirName = '';
    if (typeof payload.id === 'string' && payload.id) {
      const hit = await resolveManaged(context, payload.id);
      if (!hit.ok) return hit;
      if (!hit.managed.editable) return fail(403, 'read-only', hit.managed.reason);
      const read = readEditable(hit.rec.path);
      if (!read.ok) return read;
      baseText = read.decoded.text;
      dirName = hit.managed.kind === 'dir' ? path.basename(hit.managed.unit) : '';
    } else if (payload.kind === 'form') {
      return fail(400, 'bad-request', '缺少技能 ID');
    }
    const composed = composeEdit(baseText, { ...payload, mode: payload.kind }, dirName);
    if (!composed.ok) return composed;
    const verdict = validateText(composed.text, { dirName });
    const bytes = Buffer.byteLength(composed.text, 'utf8');
    if (bytes > core.maxSkillBytes) verdict.errors.push({ field: 'content', message: `内容超过 ${formatBytes(core.maxSkillBytes)}` });
    return { ok: true, errors: verdict.errors, warnings: verdict.warnings, bytes, content: composed.text, form: skillFormView(composed.text) };
  }

  /* ---------- 安装（新建 / 导入 / 扫描 / 市场共用） ---------- */

  function nextFreeName(dir, name, taken) {
    for (let n = 2; n <= MAX_RENAME_ATTEMPTS; n += 1) {
      const suffix = `-${n}`;
      const candidate = `${name.slice(0, MAX_NAME_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!lstatOrNull(path.join(dir, candidate)) && !taken.has(candidate)) return candidate;
    }
    return '';
  }

  /** 「保留两者」：目录换了名字，frontmatter 里的 name 也得跟着换，否则 pi 仍认为它们同名。 */
  function retitleBundle(files, name) {
    const index = files.findIndex((file) => file.path === SKILL_FILE);
    const decoded = decodeSkillBytes(files[index].bytes);
    if (!decoded.ok) return { ok: false, error: decoded.error };
    if (!summarizeSkillText(decoded.text).name.found) return { ok: true, files };
    const rewritten = rewriteFrontmatterKey(decoded.text, 'name', name);
    if (!rewritten.ok) return { ok: false, error: rewritten.reason };
    const next = files.slice();
    next[index] = { ...files[index], bytes: encodeSkillText(rewritten.text, { bom: decoded.bom, eol: decoded.eol }) };
    return { ok: true, files: next };
  }

  /** 已存在的那个同名目录能不能被「覆盖」（= 挪进回收站）。 */
  function replaceProblem(target, dest) {
    const stat = lstatOrNull(dest);
    if (!stat || !stat.isDirectory()) return '那里的同名项不是一个普通的技能目录';
    if (!sameRealLayout(target.dir, dest)) return '那里的同名项经由链接指向别处';
    return trash.available ? '' : NO_TRASH_REASON;
  }

  async function installNow(context, { targetKey, name, files, onConflict = 'fail' }) {
    const nameErrors = nameProblems(name);
    if (nameErrors.length) return fail(400, 'bad-name', nameErrors[0], { errors: nameErrors.map((message) => ({ field: 'name', message })) });
    if (!['fail', 'replace', 'rename'].includes(onConflict)) return fail(400, 'bad-request', 'onConflict 不合法');
    const inspected = inspectBundle(files);
    if (!inspected.ok) return inspected;
    const target = listTargets(context).find((candidate) => candidate.key === targetKey);
    if (!target) return fail(400, 'bad-target', '保存位置不合法');
    if (!target.writable) return fail(403, target.blockedCode, target.blockedReason);

    const idx = await core.buildIndex(context);
    let finalName = name;
    let bundle = files;
    let replacedTrashId = '';
    const dest = path.join(target.dir, name);
    if (lstatOrNull(dest)) {
      if (onConflict === 'fail') {
        const taken = new Set(idx.skills.map((skill) => skill.name));
        return fail(409, 'exists', `「${name}」在 ${target.label} 里已经存在`, {
          conflict: { name, target: target.key, replaceable: !replaceProblem(target, dest), suggestion: nextFreeName(target.dir, name, taken) },
        });
      }
      if (onConflict === 'rename') {
        finalName = nextFreeName(target.dir, name, new Set(idx.skills.map((skill) => skill.name)));
        if (!finalName) return fail(409, 'exists', `「${name}」的备用名字都被占用了，请换一个名字`);
        const retitled = retitleBundle(bundle, finalName);
        if (!retitled.ok) return fail(409, 'rename-unsupported', `无法自动改名（${retitled.error}）。请先处理已有的同名技能，或改为覆盖。`);
        bundle = retitled.files;
      } else {
        const problem = replaceProblem(target, dest);
        if (problem) return fail(409, 'replace-blocked', `无法覆盖：${problem}`);
      }
    }

    const finalDest = path.join(target.dir, finalName);
    let rootIdentity;
    let installed;
    try {
      fs.mkdirSync(target.dir, { recursive: true });
      // 目录刚建出来，再确认一次它没有落到链接上
      const rootProblem = target.scope === 'project' ? projectRootProblem(context.cwd, target.dir) : userRootProblem(target);
      if (rootProblem) return fail(403, 'unsafe-root', rootProblem);
      rootIdentity = directoryIdentity(target.dir);
      if (onConflict === 'replace' && lstatOrNull(dest)) {
        replacedTrashId = await trash.put({
          source: dest,
          kind: 'dir',
          meta: { name, scope: target.scope, originalPath: dest, rootDir: target.dir, reason: 'replace' },
        });
      }
      await installBundle({
        rootDir: target.dir, name: finalName, files: bundle,
        onStaged: trash.available ? (identity) => { installed = identity; } : null,
      });
    } catch (err) {
      let recovery = '';
      if (replacedTrashId) {
        // 新的没装上，就把刚挪走的旧的放回去
        try {
          await trash.restore(replacedTrashId, dest);
        } catch {
          recovery = `原来的「${name}」已移入回收站（${path.join(trash.root, replacedTrashId)}），没能自动放回。`;
        }
      }
      return fail(err.skillCode === 'exists' ? 409 : 500, err.skillCode || 'write-failed', `写入失败：${describeError(err)}${recovery ? ` ${recovery}` : ''}`);
    }

    const skillText = decodeSkillBytes(bundle.find((file) => file.path === SKILL_FILE).bytes);
    const declared = skillText.ok ? summarizeSkillText(skillText.text).name.value : '';
    const warnings = sameNameWarnings(idx, declared || finalName, replacedTrashId ? dest : '');
    if (declared && declared !== finalName) warnings.push(`目录名是 ${finalName}，但 frontmatter 里的 name 是 ${declared}，pi 以后者为准。`);
    const restartRequired = restartNeeded(context, target.scope);
    // 撤销安装 = 把装进去的目录挪进回收站；没有回收站就不发令牌，界面也就不会给出「撤销」
    const undo = !trash.available ? '' : journal.put({
      kind: 'install',
      name: finalName,
      scope: target.scope,
      cwd: context.cwd || '',
      rootDir: target.dir,
      rootIdentity,
      path: finalDest,
      installed,
      replacedTrashId,
      restartRequired,
    });
    return {
      ok: true,
      id: core.skillId(path.join(finalDest, SKILL_FILE)),
      name: finalName,
      requestedName: name,
      renamed: finalName !== name,
      replaced: Boolean(replacedTrashId),
      target: target.key,
      targetLabel: target.label,
      scope: target.scope,
      path: finalDest,
      fileCount: bundle.length,
      warnings,
      notice: target.notice,
      restartRequired,
      undo,
    };
  }

  async function createNow(context, payload) {
    const result = checkNew(payload);
    if (result.errors.length) return fail(400, 'invalid', result.errors[0].message, { errors: result.errors });
    return installNow(context, {
      targetKey: payload.target,
      name: result.name,
      files: [{ path: SKILL_FILE, bytes: result.bytes, executable: false }],
      onConflict: 'fail',
    });
  }

  /* ---------- 删除与撤销 ---------- */

  async function removeNow(context, id) {
    const hit = await resolveManaged(context, id);
    if (!hit.ok) return hit;
    const { rec, managed, target } = hit;
    if (!managed.deletable) return fail(403, 'read-only', managed.reason || '这个技能不能在这里删除');
    let trashId;
    const rootIdentity = directoryIdentity(target.dir);
    try {
      trashId = await trash.put({
        source: managed.unit,
        kind: managed.kind,
        meta: { name: rec.name, scope: rec.scope, originalPath: managed.unit, rootDir: target.dir, reason: 'delete' },
      });
    } catch (err) {
      return fail(500, err.skillCode || 'delete-failed', `删除失败：${describeError(err)}`);
    }
    // pi 已经把它列进系统提示词了，文件没了之后要重启才会忘掉它
    const restartRequired = rec.loaded !== false && restartNeeded(context, rec.scope);
    const undo = journal.put({
      kind: 'delete',
      name: rec.name,
      scope: target.scope,
      cwd: context.cwd || '',
      rootDir: target.dir,
      rootIdentity,
      path: managed.unit,
      trashId,
      restartRequired,
    });
    return { ok: true, name: rec.name, scope: rec.scope, restartRequired, undo };
  }

  /** 撤销只接受令牌签发时的物理根目录，并重新判断原项目的信任。 */
  function restorePlaceFailure(entry) {
    const target = entry.path || entry.file;
    if (entry.scope === 'project') {
      const problem = projectRootProblem(entry.cwd, entry.rootDir);
      if (problem) return fail(409, 'undo-blocked', problem);
      const trust = trustVerdict(core.paths(entry.cwd));
      if (!trust.allowed) return fail(403, 'project-untrusted', trust.reason);
    }
    if (!entry.rootIdentity || entry.rootIdentity !== directoryIdentity(entry.rootDir)
      || !sameRealLayout(entry.rootDir, target)) {
      return fail(409, 'undo-blocked', '原来的技能目录已移动或经由链接指向别处');
    }
    return null;
  }

  function requireUndoPlace(entry) {
    const blocked = restorePlaceFailure(entry);
    if (blocked) throw codeError(blocked.code, blocked.error, { undoFailure: blocked });
  }

  async function undoEntry(entry) {
    if (entry.kind === 'batch') {
      const failures = [];
      let restartRequired = false;
      for (const item of entry.items.slice().reverse()) {
        const result = await undoEntry(item);
        if (result.ok) restartRequired = restartRequired || result.restartRequired;
        else failures.push(`${item.name}：${result.error}`);
      }
      if (failures.length) return fail(409, 'undo-partial', `有 ${failures.length} 项没能撤销：${failures.join('；')}`);
      return { ok: true, kind: 'batch', count: entry.items.length, restartRequired };
    }
    try {
      return await undoItem(entry);
    } catch (err) {
      if (err.undoFailure) return err.undoFailure;
      throw err;
    }
  }

  async function undoItem(entry) {
    const verifyPlace = () => requireUndoPlace(entry);
    verifyPlace();
    if (entry.kind === 'edit') {
      const stat = lstatOrNull(entry.file);
      if (!stat || !stat.isFile()) return fail(409, 'undo-blocked', '文件已经不在原处，没有改动');
      if (sha256Hex(fs.readFileSync(entry.file)) !== entry.afterHash) {
        return fail(409, 'changed-on-disk', '这个文件在保存之后又被改过，为免覆盖新的修改，没有撤销');
      }
      const backup = trash.read(entry.backupId);
      if (!backup) return fail(410, 'undo-expired', '编辑前的备份已经不在了');
      await writeFileAtomic(entry.file, fs.readFileSync(backup.payload));
      trash.discard(entry.backupId);
      return { ok: true, kind: 'edit', name: entry.name, restartRequired: entry.restartRequired };
    }
    if (entry.kind === 'delete') {
      await trash.restore(entry.trashId, entry.path, verifyPlace);
      return { ok: true, kind: 'delete', name: entry.name, restartRequired: entry.restartRequired };
    }
    // install：把刚装进去的挪进回收站（不是真删），再把被覆盖的那个放回来
    if (entry.replacedTrashId && !trash.read(entry.replacedTrashId)) {
      return fail(410, 'trash-missing', '回收站里已经没有安装前的版本，没有改动');
    }
    if (!entry.undoTrashId) {
      // 放进回收站之前检查，rename 遇到重试或跨盘时也重新检查。
      entry.undoTrashId = await trash.put({
        source: entry.path,
        kind: 'dir',
        meta: { name: entry.name, scope: entry.scope, originalPath: entry.path, rootDir: entry.rootDir, reason: 'undo-install' },
        verify() {
          verifyPlace();
          const stat = lstatOrNull(entry.path);
          const { dev, ino, manifest } = entry.installed;
          if (!stat?.isDirectory() || stat.dev !== dev || stat.ino !== ino || !matchesInstalledBundle(entry.path, manifest)) {
            const changed = fail(409, 'changed-on-disk', '技能目录在安装后发生了改动，没有撤销');
            throw codeError(changed.code, changed.error, { undoFailure: changed });
          }
        },
      });
    }
    if (entry.replacedTrashId) {
      await trash.restore(entry.replacedTrashId, entry.path, verifyPlace);
    }
    return { ok: true, kind: 'install', name: entry.name, restored: Boolean(entry.replacedTrashId), restartRequired: entry.restartRequired };
  }

  async function undoNow(token) {
    const entry = journal.get(token);
    if (!entry) return fail(410, 'undo-expired', '这一步已经不能撤销了（时间太久，或者已经撤销过）');
    let result;
    try {
      result = await undoEntry(entry);
    } catch (err) {
      const status = err.skillCode === 'exists' ? 409 : err.skillCode === 'trash-missing' ? 410 : 500;
      result = fail(status, err.skillCode || 'undo-failed', `撤销失败：${describeError(err)}`);
    }
    // 批量撤销只成功了一部分也算用掉：已撤销的那些不能再撤一次
    if (result.ok || result.code === 'undo-partial') journal.delete(token);
    return result;
  }

  /** 多次安装合并成一个撤销令牌（批量导入用）。 */
  function mergeUndo(tokens) {
    const items = tokens.map((token) => journal.take(token)).filter(Boolean);
    if (items.length === 0) return '';
    return journal.put(items.length === 1 ? items[0] : { kind: 'batch', name: '', items });
  }

  return {
    describe,
    listTargets,
    projectSettingsGate,
    inspectBundle,
    readSource,
    check,
    saveSource: (context, id, payload) => exclusive(() => saveSourceNow(context, id, payload)),
    create: (context, payload) => exclusive(() => createNow(context, payload)),
    install: (context, request) => exclusive(() => installNow(context, request)),
    remove: (context, id) => exclusive(() => removeNow(context, id)),
    undo: (token) => exclusive(() => undoNow(token)),
    mergeUndo,
    get trashRoot() {
      return trash.root;
    },
  };
}
