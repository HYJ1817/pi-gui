import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Historical visual reports only. These are not policies, fixtures, build
// inputs or current security contracts. No directory-wide exemptions.
export const DOC_ALLOWLIST = Object.freeze([
  'docs/claude-ui-redesign/UI-1-acceptance.md',
  'docs/claude-ui-redesign/UI-5-visual-audit.md',
]);
const shaPattern = /^[0-9a-f]{40}$/;
const maxDocumentBytes = 256 * 1024;

export function classifyDocScope({ cwd = process.cwd(), event, baseSha, headSha } = {}) {
  const report = (classification, reason, files = []) => ({
    schemaVersion: 1, baseSha, headSha, classification, reason, files,
    // Deliberately not a CI exemption: production workflow always runs full CI.
    requiredMode: 'full',
  });
  if (event !== 'pull_request') return report('full', 'not_pull_request');
  if (!shaPattern.test(baseSha || '') || !shaPattern.test(headSha || '')) throw new Error('provide full commit SHA values');
  const git = args => {
    try {
      return execFileSync('git', ['--no-replace-objects', ...args], {
        cwd, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { throw new Error('Git scope inspection failed'); }
  };
  for (const sha of [baseSha, headSha]) {
    if (git(['cat-file', '-t', sha]).toString().trim() !== 'commit') throw new Error('Git scope requires commit objects');
  }
  const ancestor = spawnSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', baseSha, headSha], { cwd, windowsHide: true, stdio: 'ignore' });
  if (ancestor.status === 1) return report('full', 'base_not_ancestor');
  if (ancestor.status !== 0) throw new Error('Git ancestry inspection failed');
  // Disable rename heuristics and external diff/text conversion. A rename is
  // seen as deletion/addition, both of which conservatively require full CI.
  const diff = git(['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', baseSha, headSha, '--']);
  const fields = new TextDecoder('utf-8', { fatal: true }).decode(diff).split('\0');
  if (fields.pop() !== '') return report('full', 'malformed_diff');
  if (!fields.length) return report('full', 'empty_diff');
  if (fields.length % 2) return report('full', 'malformed_diff');
  const files = [];
  for (let index = 0; index < fields.length; index += 2) {
    const [status, file] = fields.slice(index, index + 2);
    if (status !== 'M' || !DOC_ALLOWLIST.includes(file)) return report('full', 'non_allowlisted_modification');
    if (files.includes(file)) return report('full', 'duplicate_path');
    for (const sha of [baseSha, headSha]) {
      const tree = git(['ls-tree', '-z', sha, '--', file]).toString('utf8');
      const entry = /^100644 blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(tree);
      if (!entry || entry[2] !== file) return report('full', 'non_regular_document');
      const size = Number(git(['cat-file', '-s', entry[1]]).toString().trim());
      if (!Number.isInteger(size) || size <= 0 || size > maxDocumentBytes) return report('full', 'document_size');
      const bytes = git(['cat-file', 'blob', entry[1]]);
      if (bytes.includes(0)) return report('full', 'binary_document');
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { return report('full', 'invalid_utf8'); }
    }
    files.push(file);
  }
  return report('docs-candidate', 'audited_document_modifications', files);
}

function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!['--event', '--base', '--head'].includes(name) || options[name] !== undefined) throw new Error('invalid classifier arguments');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('missing classifier argument');
    options[name] = value;
  }
  if (!options['--event'] || !options['--base'] || !options['--head']) throw new Error('provide --event, --base and --head');
  console.log(JSON.stringify(classifyDocScope({ event: options['--event'], baseSha: options['--base'], headSha: options['--head'] }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) {
    console.error(error.message);
    console.log(JSON.stringify({ classification: 'full', requiredMode: 'full', reason: 'classification_error' }));
    process.exitCode = 1;
  }
}
