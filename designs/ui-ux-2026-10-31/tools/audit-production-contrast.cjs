'use strict';
// Supplementary author audit of production semantic tokens, not canonical tests.
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const css = fs.readFileSync(path.join(root, 'public/tokens.css'), 'utf8');
const colors = text => Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})\s*;/gi)].map(m => [m[1], m[2]]));
const dark = colors(css.match(/:root\s*\{([\s\S]*?)\}/)[1]);
const light = { ...dark, ...colors(css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\}/)[1]) };
function luminance(hex) { const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; }
const rows = [];
for (const [theme, tokens] of Object.entries({ dark, light })) {
  const add = (foreground, background, minimum) => { const a = luminance(tokens['--ui-' + foreground]), b = luminance(tokens['--ui-' + background]); const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05); rows.push({ theme, foreground, background, ratio: +ratio.toFixed(3), minimum, passed: ratio >= minimum }); };
  for (const fg of ['text-primary', 'text-secondary', 'text-muted']) for (const bg of ['canvas', 'nav-surface', 'panel-surface', 'input-surface', 'code-surface']) add(fg, bg, 4.5);
  for (const fg of ['success', 'warning', 'danger', 'running']) add(fg, 'canvas', 4.5);
  for (const bg of ['canvas', 'code-surface']) add('link', bg, 4.5);
  add('text-primary', 'selected', 4.5); add('on-primary', 'primary-surface', 4.5);
  for (const bg of ['canvas', 'input-surface']) add('focus', bg, 3);
  add('border-control', 'input-surface', 3);
}
const report = { scope: 'production tokens; text 4.5 and focus/control boundary 3 thresholds; excludes disabled text, decorative hairlines and external Browser page', passed: rows.filter(r => r.passed).length, total: rows.length, rows };
fs.writeFileSync(path.resolve(__dirname, '../evidence/production-contrast.json'), JSON.stringify(report, null, 2));
console.log(report.passed + '/' + report.total); if (report.passed !== report.total) process.exitCode = 1;
