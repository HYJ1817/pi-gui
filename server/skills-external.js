/* 从其他 Agent 工具扫描技能，把选中的复制进 pi 的技能目录。
 *
 * 只扫已经确认过的位置（不靠猜）：
 *   Claude Code   ~/.claude/skills 与 <项目>/.claude/skills
 *   Codex         $CODEX_HOME/skills（默认 ~/.codex/skills；点开头的 .system 是它自带的，跳过）
 *
 * 对这些目录**只读**：readdir / lstat / stat / readFile，没有任何写、改名或删除。
 * 导入是「读出来 → 校验 → 装进 pi 的目录」，原目录里的东西一个字节都不动。
 *
 * 候选项的 ID 是其目录路径的哈希；导入时服务端重新扫描一遍再按 ID 取，
 * 前端传不了路径，也改不了「从哪读」。 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, isInside, normalizeForCompare } from '../lib/safe-path.js';
import { decodeSkillBytes, sanitizeSkillSlug, summarizeSkillText } from './skills-document.js';
import { describeError, formatBytes, readSkillTree, sha256Hex, validateBundle } from './skills-files.js';
import { fail } from './skills-manage.js';

const SKILL_FILE = 'SKILL.md';
const MAX_CANDIDATES_PER_SOURCE = 128;
const MAX_IMPORT_BATCH = 64;

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function canonicalOrNull(target) {
  try {
    return normalizeForCompare(canonicalPath(target));
  } catch {
    return null;
  }
}

/** 顶层条目是目录，或是指向目录的链接（很多人把同一份技能链接给几个工具用）。 */
function isDirectoryEntry(entry, full) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

export function createSkillsExternal({ core, manager, env = process.env }) {
  function sourcesFor(context) {
    const p = core.paths(context.cwd);
    const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(p.homeDir, '.codex');
    const sources = [
      { id: 'claude-user', tool: 'Claude Code', label: '~/.claude/skills', dir: path.join(p.homeDir, '.claude', 'skills') },
      { id: 'codex-user', tool: 'Codex', label: env.CODEX_HOME ? '$CODEX_HOME/skills' : '~/.codex/skills', dir: path.join(codexHome, 'skills') },
    ];
    if (p.cwd) {
      sources.push({ id: 'claude-project', tool: 'Claude Code', label: '<项目>/.claude/skills', dir: path.join(p.cwd, '.claude', 'skills') });
    }
    return sources;
  }

  /** pi 这边已有的技能：按名字、按真实位置各建一份索引，用来判断「是不是已经有了」。 */
  function localView(idx) {
    const byName = new Map();
    const realDirs = new Set();
    for (const skill of idx.skills) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
      if (skill.dir) {
        const dirName = path.basename(skill.dir);
        if (!byName.has(dirName)) byName.set(dirName, skill);
        const real = canonicalOrNull(skill.dir);
        if (real) realDirs.add(real);
      }
    }
    const roots = idx.roots.map((root) => canonicalOrNull(root.dir)).filter(Boolean);
    return { byName, realDirs, roots };
  }

  function localHash(skill) {
    try {
      const stat = fs.statSync(skill.path);
      if (!stat.isFile() || stat.size > core.maxSkillBytes) return '';
      return sha256Hex(fs.readFileSync(skill.path));
    } catch {
      return '';
    }
  }

  function describeCandidate(source, dirName, dir, local) {
    const candidate = {
      id: core.skillId(dir),
      sourceId: source.id,
      tool: source.tool,
      sourceLabel: source.label,
      dirName,
      dir,
      name: dirName,
      description: '',
      bytes: null,
      suggestedName: sanitizeSkillSlug(dirName),
      importable: true,
      reason: '',
      problems: [],
      // none：pi 这边没有；same：有同名且内容一样；different：有同名但内容不同；linked：就是同一份（链接）
      present: 'none',
      presentIn: '',
    };
    const block = (reason) => Object.assign(candidate, { importable: false, reason });

    const real = canonicalOrNull(dir);
    if (real && (local.realDirs.has(real) || local.roots.some((root) => isInside(root, real)))) {
      candidate.present = 'linked';
      block('它已经链接在 pi 的技能目录里，不需要导入');
    }

    const file = path.join(dir, SKILL_FILE);
    const stat = lstatOrNull(file);
    if (!stat || !stat.isFile()) return block(stat && stat.isSymbolicLink() ? '它的 SKILL.md 是一个链接，没有读取' : '它的 SKILL.md 不是普通文件');
    candidate.bytes = stat.size;
    if (stat.size > core.maxSkillBytes) return block(`SKILL.md 超过 ${formatBytes(core.maxSkillBytes)}`);
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return block('读不了它的 SKILL.md');
    }
    const decoded = decodeSkillBytes(bytes);
    if (!decoded.ok) return block(`SKILL.md ${decoded.error.replace(/^文件/, '')}`);
    const summary = summarizeSkillText(decoded.text);
    if (summary.name.value) candidate.name = summary.name.value;
    candidate.description = summary.description.value;
    if (!summary.hasFrontmatter || !summary.description.found || (summary.description.readable && !summary.description.value)) {
      candidate.problems.push({ level: 'error', message: '没有 description，导入后 pi 不会加载它' });
    }
    if (!candidate.suggestedName) candidate.suggestedName = sanitizeSkillSlug(candidate.name);
    if (!candidate.suggestedName) return block('它的名字无法转换成合规的技能名（只能用小写字母、数字、连字符）');

    if (candidate.present !== 'linked') {
      const existing = local.byName.get(candidate.name) || local.byName.get(candidate.suggestedName);
      if (existing) {
        candidate.present = existing.path && localHash(existing) === sha256Hex(bytes) ? 'same' : 'different';
        candidate.presentIn = existing.rootLabel || '';
      }
    }
    return candidate;
  }

  function scanSource(source, local) {
    const report = { id: source.id, tool: source.tool, label: source.label, dir: source.dir, exists: false, count: 0, truncated: false, error: '' };
    const candidates = [];
    let entries;
    try {
      entries = fs.readdirSync(source.dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') report.error = '读不了这个目录（可能没有权限）';
      return { report, candidates };
    }
    report.exists = true;
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const dir = path.join(source.dir, entry.name);
      if (!isDirectoryEntry(entry, dir) || !lstatOrNull(path.join(dir, SKILL_FILE))) continue;
      if (candidates.length >= MAX_CANDIDATES_PER_SOURCE) {
        report.truncated = true;
        break;
      }
      candidates.push(describeCandidate(source, entry.name, dir, local));
    }
    report.count = candidates.length;
    return { report, candidates };
  }

  async function scan(context) {
    const idx = await core.buildIndex(context);
    const local = localView(idx);
    const sources = [];
    const candidates = [];
    for (const source of sourcesFor(context)) {
      const result = scanSource(source, local);
      sources.push(result.report);
      candidates.push(...result.candidates);
    }
    return { ok: true, sources, candidates };
  }

  /** @param payload { ids:string[], target, onConflict:'skip'|'replace'|'rename' } */
  async function importMany(context, payload) {
    const ids = Array.isArray(payload.ids) ? [...new Set(payload.ids.filter((id) => typeof id === 'string'))] : [];
    if (ids.length === 0) return fail(400, 'bad-request', '没有选择要导入的技能');
    if (ids.length > MAX_IMPORT_BATCH) return fail(400, 'bad-request', `一次最多导入 ${MAX_IMPORT_BATCH} 个技能`);
    const onConflict = payload.onConflict || 'skip';
    if (!['skip', 'replace', 'rename'].includes(onConflict)) return fail(400, 'bad-request', 'onConflict 不合法');
    const target = manager.listTargets(context).find((candidate) => candidate.key === payload.target);
    if (!target) return fail(400, 'bad-target', '保存位置不合法');
    if (!target.writable) return fail(403, target.blockedCode, target.blockedReason);

    const scanned = await scan(context);
    const byId = new Map(scanned.candidates.map((candidate) => [candidate.id, candidate]));
    const results = [];
    const undoTokens = [];
    let restartRequired = false;
    for (const id of ids) {
      const candidate = byId.get(id);
      const failed = (error) => results.push({ id, name: candidate ? candidate.name : '', status: 'failed', error });
      if (!candidate) {
        failed('找不到这个技能了（可能已被移走），请重新扫描');
        continue;
      }
      if (!candidate.importable) {
        failed(candidate.reason);
        continue;
      }
      let tree;
      try {
        tree = readSkillTree(candidate.dir);
      } catch (err) {
        failed(describeError(err));
        continue;
      }
      const checked = validateBundle(tree.files);
      if (!checked.ok) {
        failed(checked.error);
        continue;
      }
      const installed = await manager.install(context, {
        targetKey: target.key,
        name: candidate.suggestedName,
        files: checked.files,
        onConflict: onConflict === 'skip' ? 'fail' : onConflict,
      });
      if (installed.ok) {
        undoTokens.push(installed.undo);
        restartRequired = restartRequired || installed.restartRequired;
        results.push({
          id,
          name: installed.name,
          status: 'imported',
          renamed: installed.renamed,
          replaced: installed.replaced,
          fileCount: installed.fileCount,
          skipped: [...tree.skipped, ...checked.skipped],
          warnings: installed.warnings,
        });
      } else if (installed.code === 'exists' && onConflict === 'skip') {
        results.push({ id, name: candidate.name, status: 'skipped', error: '已有同名技能，已跳过' });
      } else {
        failed(installed.error);
      }
    }
    const count = (status) => results.filter((result) => result.status === status).length;
    return {
      ok: true,
      target: target.key,
      targetLabel: target.label,
      results,
      imported: count('imported'),
      skipped: count('skipped'),
      failed: count('failed'),
      notice: count('imported') ? target.notice : '',
      restartRequired,
      undo: manager.mergeUndo(undoTokens),
    };
  }

  return { scan, importMany };
}
