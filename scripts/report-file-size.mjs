import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CODE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const GENERATED_SEGMENTS = new Set([
  '.git', 'node_modules', 'dist-app', 'dist-installer', 'dist-release', 'build', 'coverage', 'generated',
]);
const TRACKED_ROOTS = ['server', 'public', 'lib', 'electron', 'scripts', 'tests', 'server.js'];
const THRESHOLDS = Object.freeze([
  { limit: 1000, key: 'over1000', notice: 'explicit-exception', text: '需要明确例外说明' },
  { limit: 800, key: 'over800', notice: 'split-or-explain', text: '建议按职责拆分或说明原因' },
  { limit: 500, key: 'over500', notice: 'check-responsibility', text: '提示检查职责、状态归属与依赖' },
]);

function usage() {
  return 'Usage: node scripts/report-file-size.mjs [--json] [--base <git-commit>]';
}

function parseArgs(argv) {
  const options = { json: false, base: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      if (options.json) throw new Error('--json may only be specified once');
      options.json = true;
    } else if (arg === '--base') {
      if (options.base !== null) throw new Error('--base may only be specified once');
      const base = argv[index + 1];
      if (!base || base.startsWith('--')) throw new Error('--base requires a Git commit, tag, or ref');
      options.base = base;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function splitNul(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function isGenerated(relative) {
  return relative.split('/').some((segment) => GENERATED_SEGMENTS.has(segment));
}

function classify(relative) {
  const extension = path.posix.extname(relative).toLowerCase();
  const segments = relative.split('/');
  if (segments.includes('fixture') || segments.includes('fixtures')) return 'fixture';
  if (extension === '.css') return 'style';
  if (!CODE_EXTENSIONS.has(extension)) return null;
  if (relative.startsWith('tests/')) return 'test';
  return 'business';
}

function countLines(buffer) {
  if (buffer.length === 0) return 0;
  const text = buffer.toString('utf8');
  const parts = text.split(/\r\n|\r|\n/);
  return parts.length - (parts.at(-1) === '' ? 1 : 0);
}

function resolveBase(root, requested) {
  return git(root, ['rev-parse', '--verify', `${requested}^{commit}`]).toString('utf8').trim();
}

function readDiffStats(root, base) {
  const changes = new Map();
  for (const record of splitNul(git(root, ['diff', '--numstat', '-z', '--no-renames', base, '--']))) {
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error('Git returned an invalid --numstat record');
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    const relative = record.slice(secondTab + 1);
    if (added === '-' || deleted === '-') continue;
    changes.set(relative, { added: Number(added), deleted: Number(deleted) });
  }
  return changes;
}

function noticeFor(lines, category) {
  if (category !== 'business') return null;
  return THRESHOLDS.find((threshold) => lines > threshold.limit) || null;
}

function createReport(root, options) {
  const tracked = splitNul(git(root, ['ls-files', '-z', '--', ...TRACKED_ROOTS]));
  const resolvedBase = options.base ? resolveBase(root, options.base) : null;
  const diffStats = resolvedBase ? readDiffStats(root, resolvedBase) : new Map();
  const files = [];
  let skippedSymlinks = 0;

  for (const relative of tracked) {
    if (isGenerated(relative)) continue;
    const category = classify(relative);
    if (!category) continue;
    const absolute = path.resolve(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      skippedSymlinks += 1;
      continue;
    }
    if (!stat.isFile()) continue;
    const lines = countLines(fs.readFileSync(absolute));
    const change = diffStats.get(relative);
    const growth = change ? change.added - change.deleted : 0;
    const baselineLines = resolvedBase ? Math.max(0, lines - growth) : null;
    const threshold = noticeFor(lines, category);
    files.push({
      path: relative,
      lines,
      category,
      baselineLines,
      growth: resolvedBase ? growth : null,
      historic: resolvedBase ? baselineLines > 0 : null,
      notice: threshold ? threshold.notice : null,
      guidance: threshold ? threshold.text : null,
    });
  }

  files.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
  const categories = Object.fromEntries(['business', 'test', 'fixture', 'style'].map((category) => [category, { files: 0, lines: 0 }]));
  const thresholds = { over500: 0, over800: 0, over1000: 0 };
  for (const file of files) {
    categories[file.category].files += 1;
    categories[file.category].lines += file.lines;
    if (file.category !== 'business') continue;
    for (const threshold of THRESHOLDS) {
      if (file.lines > threshold.limit) thresholds[threshold.key] += 1;
    }
  }

  return {
    schemaVersion: 1,
    base: resolvedBase ? { requested: options.base, resolved: resolvedBase } : null,
    summary: {
      scannedFiles: files.length,
      skippedSymlinks,
      codeLines: categories.business.lines,
      categories,
      thresholds,
    },
    files,
    largest: files.slice(0, 10),
  };
}

function printText(report) {
  const { summary } = report;
  console.log('File size report');
  if (report.base) console.log(`Baseline: ${report.base.resolved} (requested ${report.base.requested})`);
  console.log(`Tracked files scanned: ${summary.scannedFiles}`);
  console.log(`Business code: ${summary.categories.business.files} files, ${summary.categories.business.lines} lines`);
  console.log(`Tests: ${summary.categories.test.files} files, ${summary.categories.test.lines} lines`);
  console.log(`Fixtures: ${summary.categories.fixture.files} files, ${summary.categories.fixture.lines} lines`);
  console.log(`CSS: ${summary.categories.style.files} files, ${summary.categories.style.lines} lines`);
  console.log(`Over 500 lines: ${summary.thresholds.over500}`);
  console.log(`Over 800 lines: ${summary.thresholds.over800}`);
  console.log(`Over 1000 lines: ${summary.thresholds.over1000}`);
  if (summary.skippedSymlinks) console.log(`Skipped symbolic links: ${summary.skippedSymlinks}`);
  console.log('Thresholds are soft warnings only; this report exits 0 for file size findings.');
  console.log('Largest files:');
  for (const file of report.largest) {
    const baseline = report.base ? `; base ${file.baselineLines}; growth ${file.growth >= 0 ? '+' : ''}${file.growth}` : '';
    const guidance = file.guidance ? `; ${file.guidance}` : '';
    console.log(`  ${file.lines} lines; ${file.category}${baseline}${guidance}; ${file.path}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = createReport(process.cwd(), options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printText(report);
}

try {
  main();
} catch (error) {
  console.error(`report-file-size: ${error.message}`);
  process.exitCode = 1;
}
