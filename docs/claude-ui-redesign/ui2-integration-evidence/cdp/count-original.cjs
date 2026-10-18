// Run the original integration-HEAD test with reporting-only counters.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../../../..');
let source = execFileSync('git', ['show', '50d20dd:tests/cdp-shot.cjs'], { cwd: root, encoding: 'utf8' });
source = source.replace('const shotFailures = [];', 'const shotFailures = []; let shotChecks = 0;');
source = source.replace('    if (!probe) {', '    shotChecks += 2 + (must?.length || 0) + (mustTrue?.length || 0);\n    if (!probe) {');
source = source.replace('const uxCheck = (name, ok, detail) => {', 'const uxCheck = (name, ok, detail) => { shotChecks++;');
source = source.replace("  console.log('\\n完成');", "  console.log('取景断言数量: ' + shotChecks + '；失败 ' + shotFailures.length);\n  console.log('\\n完成');");
const filename = path.join(root, 'tests/cdp-shot.cjs');
const runner = new Module(filename, module);
runner.filename = filename;
runner.paths = Module._nodeModulePaths(path.dirname(filename));
runner._compile(source, filename);
