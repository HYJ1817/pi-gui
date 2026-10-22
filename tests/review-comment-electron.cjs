'use strict';
/* Four separate real Electron + production backend processes, one isolated
 * app-data/native-session fixture. No user projects, real Pi or model calls. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.T3B_EVIDENCE_DIR || path.join(ROOT, '.probe', 't3-b-electron'));
const PHASES = ['save', 'restore-edit', 'restore-delete', 'confirm-deleted'];
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!process.versions.electron) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-t3b-electron-'));
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(world, 'project')); fs.mkdirSync(path.join(world, 'data'));
  const git = (...args) => execFileSync('git', args, { cwd: path.join(world, 'project'), windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(world, 'gitconfig') }, stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(world, 'project', 'a.js'), 'export const value = 1;\n');
  git('add', '.'); git('commit', '-m', 'fixture');
  fs.writeFileSync(path.join(world, 'project', 'a.js'), 'export const value = 2;\n');
  // Match the upstream v3 native session header and cwd directory layout.
  fs.writeFileSync(path.join(world, 'fake-pi.cjs'), `
const fs=require('node:fs'),path=require('node:path');
const cwd=process.cwd(), sessionId='t3b-native', parent=process.ppid;
const sessionFile=path.join(process.env.PI_CODING_AGENT_DIR,'sessions','--'+cwd.replace(/[\\\\/:]/g,'-')+'--','2026-01-01T00-00-00-000Z_'+sessionId+'.jsonl');
fs.mkdirSync(path.dirname(sessionFile),{recursive:true});
if(!fs.existsSync(sessionFile))fs.writeFileSync(sessionFile,JSON.stringify({type:'session',version:3,id:sessionId,cwd,timestamp:'2026-01-01T00:00:00.000Z'})+'\\n');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;let i;while((i=input.indexOf('\\n'))>=0){const line=input.slice(0,i);input=input.slice(i+1);try{const cmd=JSON.parse(line);fs.appendFileSync(process.env.T3B_COMMAND_LOG,cmd.type+'\\n');process.stdout.write(JSON.stringify({type:'response',command:cmd.type,id:cmd.id,success:true,data:{sessionId,sessionFile,sessionName:'T3B Fixture',messages:[],models:[],thinkingLevels:[]}})+'\\n');}catch{}}});
setInterval(()=>{try{process.kill(parent,0);}catch{process.exit(0);}},300);
`);
  fs.writeFileSync(path.join(world, 'fake-pi.cmd'), '@echo off\r\n"%FAKE_PI_NODE%" "%~dp0fake-pi.cjs" %*\r\n');
  const results = { sandbox: process.env.T3B_TEST_NO_SANDBOX === '1' ? 'disabled-test-only' : 'normal', phases: [], checks: 0, failed: 0, skipped: 0 };
  try {
    for (const phase of PHASES) {
      const env = { ...process.env, T3B_WORLD: world, T3B_PHASE: phase }; delete env.ELECTRON_RUN_AS_NODE;
      const run = spawnSync(require('electron'), [__filename, ...(results.sandbox === 'normal' ? [] : ['--no-sandbox'])],
        { env, stdio: 'inherit', windowsHide: true, timeout: 150000 });
      const result = JSON.parse(fs.readFileSync(path.join(OUT, phase + '.json'), 'utf8'));
      results.phases.push({ phase, exit: run.status, ...result }); results.checks += result.checks;
      if (run.status !== 0 || result.failed) { results.failed++; break; }
    }
    results.generatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`Review comments Electron (${results.sandbox}): ${results.checks}/${results.checks}; failed=${results.failed}; skipped=0`);
    process.exitCode = results.failed ? 1 : 0;
  } finally { fs.rmSync(world, { recursive: true, force: true, maxRetries: 5 }); }
} else {
  const { app, BrowserWindow } = require('electron');
  const assert = require('node:assert/strict'), net = require('node:net');
  const world = process.env.T3B_WORLD, phase = process.env.T3B_PHASE;
  app.setPath('userData', path.join(world, 'electron-data'));
  let backend, win, checks = 0;
  const check = (name, value) => { assert.ok(value, name); checks++; console.log('  ok ' + phase + ': ' + name); };
  app.whenReady().then(async () => {
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const base = `http://127.0.0.1:${port}`, project = path.join(world, 'project');
    const before = digest(path.join(project, 'a.js'));
    backend = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), PI_CWD: project, PI_GUI_DATA: path.join(world, 'data'),
        PI_GUI_OPEN: '0', PI_GUI_OFFLINE: '1', PI_OFFLINE: '1', PI_BIN: path.join(world, 'fake-pi.cmd'), FAKE_PI_NODE: process.execPath,
        PI_CODING_AGENT_DIR: path.join(world, 'agent'), T3B_COMMAND_LOG: path.join(world, 'commands'), TEMP: world, TMP: world, TMPDIR: world } });
    // Consume bounded diagnostic output so a full pipe cannot block the fixture.
    let diagnostic = ''; for (const stream of [backend.stdout, backend.stderr]) stream.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-6000); });
    for (let i = 0; ; i++) {
      try { if ((await (await fetch(base + '/api/health')).json()).app === 'pi-gui') break; } catch {}
      if (i > 200 || backend.exitCode !== null) throw Error('fixture backend unavailable: ' + diagnostic); await sleep(50);
    }
    win = new BrowserWindow({ width: 1200, height: 850, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const read = code => win.webContents.executeJavaScript(code, true);
    const until = async (code, label) => { for (let i = 0; i < 300; i++) { if (await read(code)) return; await sleep(25); } throw Error(label + ' timeout'); };
    await win.loadURL(base);
    await until("document.querySelector('#connText')?.textContent.includes('已连接')", 'native session');
    await read("document.querySelector('#navChanges').click()");
    await until("document.querySelector('#btnReviewStorage')?.textContent==='评论已同步'", 'comment recovery');
    check('renderer keeps sandbox/context isolation', win.webContents.getLastWebPreferences().sandbox === true && win.webContents.getLastWebPreferences().contextIsolation === true);
    const storage = path.join(world, 'data', 'review-comments');
    if (phase !== 'save') {
      check('prior confirmed revision is present on disk', fs.readdirSync(storage).filter(n => n.endsWith('.json')).length === 1);
      await read("document.querySelector('#btnChangesReview').click()");
      await until("document.querySelector('.review-summary-body')", 'summary');
      if (phase === 'confirm-deleted') {
        check('deleted comments stay deleted after full process restart', await read("document.querySelectorAll('.review-item').length===0"));
      } else {
        const expected = phase === 'restore-edit' ? '跨重启保存的意见' : '跨重启修改后的意见';
        check('restored text matches the last confirmed mutation', await read(`document.querySelector('.review-item-text')?.textContent===${JSON.stringify(expected)}`));
        check('restored anchors start unverified before reading current Diff', await read("document.querySelectorAll('.review-unverified').length===1"));
      }
      await read("[...document.querySelectorAll('#modalCard button')].find(b=>b.textContent==='关闭').click()");
    }
    if (phase !== 'confirm-deleted') {
      await read("document.querySelector('.chg-main').click()");
      await until("document.querySelector('.d-row[data-line-type=add] .d-gutter')", 'current Diff');
      if (phase !== 'save') check('the current Diff confirms the restored anchor', await read("document.querySelectorAll('.d-row.has-comment').length===1"));
      await read("document.querySelector('.d-row[data-line-type=add] .d-gutter').click()");
      await until("document.querySelector('.d-review-editor textarea')", 'editor');
      if (phase === 'restore-delete') {
        await read("[...document.querySelectorAll('.d-review-editor button')].find(b=>b.textContent==='删除').click()");
      } else {
        const text = phase === 'save' ? '跨重启保存的意见' : '跨重启修改后的意见';
        await read(`(()=>{const t=document.querySelector('.d-review-editor textarea');t.value=${JSON.stringify(text)};t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.d-review-editor .primary').click()})()`);
      }
      await until("!document.querySelector('.d-review-editor')", 'confirmed mutation');
      const record = JSON.parse(fs.readFileSync(path.join(storage, fs.readdirSync(storage).find(n => n.endsWith('.json'))), 'utf8'));
      check('acknowledged UI mutation agrees with disk', record.comments.length === (phase === 'restore-delete' ? 0 : 1));
      if (phase === 'restore-edit') fs.writeFileSync(path.join(OUT, 'restored-edited.png'), (await win.webContents.capturePage()).toPNG());
    }
    check('comment recovery never sends an Agent message', !/^(prompt|steer|follow_up)$/m.test(fs.readFileSync(path.join(world, 'commands'), 'utf8')) && await read("document.querySelector('#input').value===''") );
    check('source content remains untouched', digest(path.join(project, 'a.js')) === before);
  }).then(() => finish(0), error => { console.error(error); finish(1); });
  async function finish(failed) {
    fs.writeFileSync(path.join(OUT, phase + '.json'), JSON.stringify({ checks, failed, skipped: 0, electron: process.versions.electron, chrome: process.versions.chrome }));
    if (win && !win.isDestroyed()) win.destroy();
    if (backend && backend.exitCode === null) { backend.kill(); await Promise.race([new Promise(resolve => backend.once('exit', resolve)), sleep(5000)]); }
    app.exit(failed);
  }
}
