const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
let pass = 0, fail = 0;
async function check(name, fn) { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error(' FAIL ' + name + ': ' + e.message); } }
const sleep = () => new Promise(r => setTimeout(r, 35));
async function main() {
  const pub = path.resolve(__dirname, '../public');
  const dom = new JSDOM(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), { url: 'http://localhost:7788', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; let cwd = 'C:\\fixture-A', items = [], calls = [], desktopCalls = [];
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.EventSource = class { constructor() { w.hotfixEvents = this; } close() {} emit(event) { this.onmessage({ data: JSON.stringify(event) }); } };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = async (url, options = {}) => {
    const u = String(url); calls.push([u, options]);
    let value = { ok: true };
    if (u === '/api/status') value = { ok: true, cwd, hasProject: Boolean(cwd), bridgeRun: 1 };
    else if (u.startsWith('/api/projects')) { if (options.method === 'DELETE') { cwd = ''; items = []; value.closedWorkspace = true; } else value = { ok: true, active: cwd, items }; }
    else if (u === '/api/git/status') value = { ok: true, isRepo: true, projectRoot: cwd, files: [{ path: 'a.txt', status: 'M', working: 'M' }] };
    else if (u.startsWith('/api/git/diff')) value = { ok: true, path: 'a.txt', working: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new', staged: '' };
    else if (u === '/api/sessions') value.sessions = [];
    else if (u === '/api/provider-auth') value = { ok: true, capability: {}, providers: [], flow: null, sync: {} };
    else if (u === '/api/session-export') return { ok: true, blob: async () => new w.Blob(['<p>fixture</p>'], { type: 'text/html' }) };
    return { ok: true, json: async () => value };
  };
  w.eval(bundle(path.join(pub, 'app.js')).code); await sleep();
  await check('H1 numeric response IDs never throw', () => { for (const id of [1, 9, null, {}, 'ordinary']) w.onResponse({ command: 'get_available_models', id, success: true, data: { models: [] } }); });
  await check('H6 empty sidebar CTA invokes existing directory picker', async () => { await w.loadProjects(); const button = w.document.querySelector('#projects button'); assert.ok(button); assert.ok(button.textContent.includes('添加文件夹')); button.click(); await sleep(); assert.ok(w.document.querySelector('#modalCard').textContent.includes('选择项目文件夹')); assert.ok(calls.some(([u]) => u.startsWith('/api/fs'))); });
  await check('H6 populated sidebar keeps compact menu', async () => { items = [{ path: cwd, name: 'A' }]; await w.loadProjects(); assert.equal(w.document.querySelector('#projectEmptyAdd'), null); assert.ok(w.document.querySelector('.pj-row-menu-trigger')); });
  w.S.hasProject = true; w.S.bridgeState = 'ready'; w.S.cwd = cwd;
  await check('H8 Web rows expose diff and restore, no dead open action', async () => { w.openChangesPanel(); await w.refreshGitNow(); await sleep(); const row = w.document.querySelector('.chg-row'); assert.ok(row); assert.ok(![...row.querySelectorAll('button')].some(b => b.textContent === '打开')); row.querySelector('.chg-main').click(); await sleep(); assert.equal(row.querySelector('.chg-diff').hidden, false); assert.ok(row.textContent.includes('new')); });
  await check('H3 filter explains terminal edits directly', () => { assert.ok(w.document.querySelector('#chgFilterSession').textContent.includes('本会话编辑')); assert.ok(w.document.querySelector('#rightPane').textContent.includes('终端命令产生的文件修改请在「全部」中查看')); });
  await check('H8 Electron rows use desktop bridge', async () => { w.piGuiDesktop = { openPath: async p => { desktopCalls.push(p); return { ok: true }; } }; await w.refreshGitNow(); w.openChangesPanel(); await sleep(); const row = w.document.querySelector('.chg-row'); const button = [...row.querySelectorAll('button')].find(b => b.textContent === '打开'); assert.ok(button); button.click(); await sleep(); assert.deepEqual(desktopCalls, ['a.txt']); });
  await check('H5 shared HTML export downloads through safe endpoint', async () => { let clicked = false, revoked = false; w.URL.createObjectURL = () => 'blob:fixture'; w.URL.revokeObjectURL = () => { revoked = true; }; w.HTMLAnchorElement.prototype.click = function() { clicked = this.download === 'pi-session.html'; }; const result = await w.exportHtml(); assert.equal(result.ok, true); assert.equal(clicked, true); assert.ok(calls.some(([u]) => u === '/api/session-export')); assert.ok(!calls.some(([u, opts]) => u === '/api/command' && opts.body.includes('export_html'))); });
  await check('H7 active deletion clears workspace state and locks composer', async () => { const generation = w.S.workspaceGeneration; w.S.state = { model: { id: 'old' } }; w.S.models = [{ id: 'old' }]; w.S.stats = {}; await w.removeProject(cwd); assert.ok(w.S.workspaceGeneration > generation); assert.equal(w.S.cwd, ''); assert.equal(w.S.hasProject, false); assert.equal(w.S.state, null); assert.equal(w.S.models.length, 0); assert.equal(w.S.stats, null); assert.equal(w.S.bridgeState, 'no-project'); assert.equal(w.document.querySelector('#input').disabled, true); assert.ok(!w.document.querySelector('#welcomeNoProj').hidden); assert.ok(!w.document.querySelector('#title').textContent.includes('fixture-A')); });
  await check('H7 current session relation banner is cleared', async () => { const host = w.document.createElement('div'); w.document.body.appendChild(host); w.mountSessionPlans(host); host.textContent = 'old session task'; host.hidden = false; cwd = 'C:\\fixture-A'; w.S.cwd = cwd; w.S.hasProject = true; await w.removeProject(cwd); assert.equal(host.hidden, true); assert.equal(host.textContent, ''); });
  await check('H7 queued old bridge ready cannot reopen removed workspace', async () => { w.hotfixEvents.emit({ type: 'bridge_status', state: 'ready', cwd: 'C:\\fixture-A', bridgeRun: w.S.bridgeRun || 1 }); await sleep(); assert.equal(w.S.hasProject, false); assert.equal(w.S.cwd, ''); assert.equal(w.S.bridgeState, 'no-project'); });
  dom.window.close(); console.log(`\n${pass}/${pass + fail} 通过`); process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });

