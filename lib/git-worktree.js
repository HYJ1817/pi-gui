import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git.js';
import { normalizeForCompare } from './safe-path.js';

export const samePath = (a, b) => Boolean(a && b && normalizeForCompare(a) === normalizeForCompare(b));
export function failure(code) { return Object.assign(new Error(code), { code }); }
export function fileIdentity(target) {
  const stat = fs.statSync(target, { bigint: true });
  if (!stat.isDirectory()) throw failure('workspace_unavailable');
  return `${stat.dev}:${stat.ino}`;
}
export async function worktreeGit(cwd, args, { okCodes = [0] } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' });
  const result = await runGit(cwd, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', ...args],
    { timeout: 10000, maxBytes: 1024 * 1024, okCodes, env });
  if (!result.ok || result.truncated || result.timedOut) throw failure(result.noGit ? 'git_unavailable' : 'git_failed');
  return result.stdout;
}
export async function repository(project) {
  let root, common;
  try {
    root = fs.realpathSync((await worktreeGit(project, ['rev-parse', '--show-toplevel'])).trim());
    common = fs.realpathSync((await worktreeGit(project, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  } catch (e) { throw failure(e.code === 'git_unavailable' ? e.code : 'not_git'); }
  const prefix = path.relative(root, fs.realpathSync(project));
  if (prefix.startsWith('..') || path.isAbsolute(prefix)) throw failure('invalid_project');
  return { root, common, prefix };
}
export function parseWorktrees(text) {
  const records = []; let record = null;
  for (const field of text.split('\0')) {
    if (field.startsWith('worktree ')) { if (record) records.push(record); record = { path: field.slice(9), locked: false, prunable: false }; }
    else if (record && field.startsWith('HEAD ')) record.head = field.slice(5);
    else if (record && field.startsWith('branch ')) record.branch = field.slice(7).replace(/^refs\/heads\//, '');
    else if (record && /^locked(?: |$)/.test(field)) record.locked = true;
    else if (record && /^prunable(?: |$)/.test(field)) record.prunable = true;
  }
  if (record) records.push(record);
  return records;
}
export async function inventory(root) { return parseWorktrees(await worktreeGit(root, ['worktree', 'list', '--porcelain', '-z'])); }
export async function sourceCommit(root, source = 'HEAD') {
  if (typeof source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/@^~+-]{0,199}$/.test(source)) throw failure('invalid_source');
  try { return (await worktreeGit(root, ['rev-parse', '--verify', '--end-of-options', `${source}^{commit}`])).trim(); }
  catch { throw failure('invalid_source'); }
}
export async function validBranch(root, branch) {
  if (typeof branch !== 'string' || branch.length > 160 || branch.startsWith('-') || /[\s\x00-\x1f\\]/.test(branch)) throw failure('invalid_branch');
  try { await worktreeGit(root, ['check-ref-format', `refs/heads/${branch}`]); } catch { throw failure('invalid_branch'); }
  const refs = await worktreeGit(root, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`]);
  if (refs.split(/\r?\n/).includes(`refs/heads/${branch}`)) throw failure('branch_conflict');
}
export async function dirtyStatus(root) { return worktreeGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none']); }
export async function branchName(root) { return (await worktreeGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [0, 1] })).trim() || null; }
export async function adminDirectory(root) { return fs.realpathSync((await worktreeGit(root, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim()); }
