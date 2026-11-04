/* Title projections use the production module graph; no copied renderer logic. */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
const root = path.resolve(__dirname, '..');
const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), {
  url: 'http://127.0.0.1/', runScripts: 'outside-only', pretendToBeVisual: true,
});
const w = dom.window;
w.eval(bundle(path.join(root, 'public/shell.js')).code);
let passed = 0, failed = 0;
function check(name, ok) { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
const title = w.document.getElementById('title');
const workspace = w.document.getElementById('workspace');
const crumb = () => w.document.getElementById('titleProject');
w.S.cwd = 'C:/fixtures/Classic project';
w.S.hasProject = true;
w.S.bridgeState = 'ready';
w.S.switching = false;
w.applyProjectState();
w.setTitleText('Classic task');
check('classic project is derived from its cwd', crumb()?.textContent === 'Classic project');
check('classic title stays intact', title.textContent === 'Classic task');
workspace.dataset.workspaceView = 'runtime';
w.setRuntimeTitle('Background task', 'D:/fixtures/Runtime project');
check('runtime crumb belongs to its own workspace', crumb()?.textContent === 'Runtime project');
w.setTitleText('A later classic title');
check('background classic title cannot overwrite runtime', title.textContent === 'Background task');
w.applyProjectState();
check('background classic status cannot overwrite runtime project', crumb()?.textContent === 'Runtime project');
workspace.dataset.workspaceView = 'chat';
w.document.dispatchEvent(new w.CustomEvent('pi-gui:workspace-view', { detail: { view: 'chat' } }));
check('return restores classic title and project', title.textContent === 'A later classic title' && crumb()?.textContent === 'Classic project');
// The actual renderer supplies project labels; user text is always textContent.
const row = w.document.createElement('div'); row.className = 'project'; row.dataset.projectPath = w.S.cwd;
const name = w.document.createElement('span'); name.className = 'pj-name'; name.textContent = '<Project & custom name>';
row.append(name); w.document.getElementById('projects').replaceChildren(row);
w.applyProjectState();
check('uses the real project label without HTML interpretation', crumb()?.textContent === name.textContent && crumb()?.children.length === 0);
w.S.cwd = ''; w.S.hasProject = false; w.applyProjectState();
check('no-project state hides the entire project crumb', w.document.getElementById('titleProjectContext')?.hidden === true);
workspace.dataset.workspaceView = 'runtime'; w.setRuntimeTitle('Unknown project');
check('runtime with no workspace never borrows classic project', w.document.getElementById('titleProjectContext')?.hidden === true);
check('title remains a draggable heading, no unsupported rename editor', title.tagName === 'H1' && !title.querySelector('input,button'));
console.log(`App shell: ${passed}/${passed + failed}; failed=${failed}`);
dom.window.close(); process.exitCode = failed ? 1 : 0;
