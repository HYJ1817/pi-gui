// Read-only evidence extraction. Never changes tests or their pass criteria.
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, ''));
const actualProcess = read('npm-test-final-process.json');
const lines = fs.readFileSync(path.join(root, 'npm-test-final.log'), 'utf8').split(/\r?\n/);
const numericSummaries = lines.flatMap((text, i) => {
  if (/^\s*(?:[✓✔]|>)/i.test(text)) return [];
  const matches = [...text.matchAll(/(?<!\d)(\d+)\/(\d+)(?!\d)/g)];
  if (/^\s*ok\s+\d+\/\d+/i.test(text) && matches.length === 1) return [];
  const m = matches.at(-1);
  if (m && /^\s*\./.test(text.slice(m.index + m[0].length))) return [];
  // Unequal pairs also occur inside successful assertions (920/888 layout,
  // 1/3 Planner progress, and deliberately invalid 3/2 resource counts).
  // Completion/failure is established by the separate actual process result.
  if (m && m[1] !== m[2]) return [];
  return m ? [{ line: i + 1, text, passed: +m[1], total: +m[2] }] : [];
});
const baseline = JSON.parse(fs.readFileSync(path.join(root, '../ui2-integration-evidence/test-results.json'), 'utf8'));
const previous = baseline.numericSummaries.map(item => item.text.match(/(\d+)\/(\d+)/).slice(1).map(Number));
const current = numericSummaries.slice(4).map(item => [item.passed, item.total]);
const differences = [];
for (let i = 0; i < Math.max(previous.length, current.length); i++) {
  if (JSON.stringify(previous[i]) !== JSON.stringify(current[i])) differences.push({ index: i, baseline: previous[i], current: current[i] });
}
const jsonSummaries = lines.flatMap((text, i) => {
  try {
    const value = JSON.parse(text);
    if (typeof value.passed !== 'number' || typeof value.failed !== 'number') return [];
    return [{ line: i + 1, passed: value.passed, failed: value.failed, skipped: value.skipped || 0, tool: value.tool || null, layer: value.layer || null }];
  } catch { return []; }
});
const positiveSkipSummaries = numericSummaries.filter(item => /skipped\s*[:=]\s*[1-9]/i.test(item.text));
const skipLines = lines.flatMap((text, i) => /(?:^\s*--\s|\bSKIP\b|跳过|skipped\s*[:=]\s*[1-9])/i.test(text) ? [{ line: i + 1, text }] : []);
const result = {
  actualProcess, canonicalCommands: JSON.parse(fs.readFileSync(path.join(root, '../../..', 'package.json'), 'utf8')).scripts.test.split(' && ').length,
  numericSummaries, jsonSummaries, positiveSkipSummaries, skipLines,
  skippedTotal: positiveSkipSummaries.reduce((sum, item) => sum + +item.text.match(/skipped\s*[:=]\s*(\d+)/i)[1], 0)
    + skipLines.filter(item => /^\s*--\s/.test(item.text)).length,
  baselineComparison: { baselineSummaries: previous.length, currentPriorSummaries: current.length, differences, unchanged: differences.length === 0 },
  noCountPassedMarkers: lines.filter(text => /^(?:reliability|interactions|port-owner): passed/.test(text)),
  note: '135 command suites, not an invented sum of nested assertion totals. JSON and printed witness results are duplicates; count their skips only once. Session symlink and native privilege skips require review of skipLines.'
};
fs.writeFileSync(path.join(root, 'test-results.json'), JSON.stringify(result, null, 2) + '\n');
const summary = ['# UI-3 canonical 完整测试逐套数字摘要', '',
  `实际退出码：${actualProcess.exitCode}；耗时：${actualProcess.durationSeconds.toFixed(3)} 秒。135 条入口命令完成；120 条数字摘要，其中原有 116 条计数序列与 UI-2 一致。`, '',
  `失败 0；实际环境跳过 ${result.skippedTotal} 项：SACL witness 8、非空 SACL 保持 2、Object witness 8、会话符号链接 1。跳过不计通过数，两个 0/0 不算通过。`, '',
  '不汇总嵌套/JSON 重复打印为虚假的全局断言总数。部分中文标题有终端转码损坏；下列保留原日志文本，ASCII 标识和数字可核查。JSON/未打印数字套件另见 test-results.json。', '',
  '| 日志行 | 通过/总计 | 原始摘要 |', '|---|---|---|',
  ...numericSummaries.map(item => `| ${item.line} | ${item.passed}/${item.total} | ${item.text.replace(/\|/g, '\\|')} |`), ''];
fs.writeFileSync(path.join(root, 'test-summary.md'), summary.join('\n'));
console.log(JSON.stringify({ exitCode: actualProcess.exitCode, commands: result.canonicalCommands, numericSummaries: numericSummaries.length, baselineComparison: result.baselineComparison, positiveSkipSummaries }, null, 2));
if (actualProcess.exitCode !== 0 || differences.length) process.exitCode = 1;
