const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const evidence = path.resolve(__dirname, '..');
const runs = {};
for (const name of ['before', 'before-count', 'after', 'final', 'verified']) {
  const log = fs.readFileSync(path.join(evidence, 'cdp-' + name + '.log'), 'utf8');
  const exit = JSON.parse(fs.readFileSync(path.join(evidence, 'cdp-' + name + '-exit.json'), 'utf8'));
  const total = log.match(/取景断言数量: (\d+)/);
  const failureLine = log.split(/\r?\n/).find(line => line.startsWith('取景判据: '));
  const failed = failureLine.match(/✗ (\d+) 条/);
  runs[name] = {
    ...exit, assertions: total ? Number(total[1]) : null,
    failed: failed ? Number(failed[1]) : 0,
    rendererExceptions: log.includes('页面异常: 无') ? 0 : 'inspect log',
    screenshots: log.split(/\r?\n/).filter(line => line.startsWith('  截图: ')).length,
    shotOfInvocations: log.split(/\r?\n/).filter(line => /^ {6}.+ \[.+\] rect=/.test(line)).length,
    uxInvocations: log.split(/\r?\n/).filter(line => /^ {6}.+ \[.+\]$/.test(line)).length,
    failureClaims: failed ? failureLine.split(' 条 —— ')[1].split('；') : [],
  };
  if (total) runs[name].passed = runs[name].assertions - runs[name].failed;
}
const root = path.resolve(__dirname, '../../../..');
const original = execFileSync('git', ['show', '50d20dd:tests/cdp-shot.cjs'], { cwd: root, encoding: 'utf8' });
const current = fs.readFileSync(path.join(root, 'tests/cdp-shot.cjs'), 'utf8');
const footprint = text => ({
  shotOfCallsites: [...text.matchAll(/await shotOf\(/g)].length,
  uxCheckCallsites: [...text.matchAll(/\buxCheck\(/g)].length,
});
const summary = {
  baseline: '50d20dd', runs,
  footprint: { before: footprint(original), after: footprint(current) },
  strictReturnGuard: current.includes('if (v !== true) bad.push'),
  independentAudit: JSON.parse(fs.readFileSync(path.join(__dirname, 'palette-menu-results.json'), 'utf8')),
  limits: ['offline real Chrome fixture; no real model or native caption pixel proof', 'old before/after passes used the original truthy guard; strict final is the acceptance result'],
};
if (runs['before-count'].assertions !== runs.verified.assertions) throw new Error('assertion denominator changed');
if (runs.verified.failed || runs.verified.exitCode || runs.verified.rendererExceptions) throw new Error('final run failed');
fs.writeFileSync(path.join(evidence, 'cdp-results.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ before: runs['before-count'], after: runs.verified, footprint: summary.footprint }, null, 2));
