'use strict';
/* T3-A real Electron proof.
 *
 * Two phases run in two separate Electron processes because each one owns a
 * BrowserWindow with its own userData directory:
 *
 *   1. production - the real app + fake pi shim against a temporary Git repo:
 *      line comments, summary, fill, stale state, four window widths.
 *   2. native     - the T2-B harness, so a comment is written while a real
 *      WebContentsView sits above it in the Browser + Changes split.
 *
 * Nothing here touches a user project, the user's Git config or a real Pi.
 * The launcher merges both phases' results.json into evidence/results.json.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.T3A_EVIDENCE_DIR || path.join(ROOT, 'docs', 'evidence', 't3-a-diff-comments'));
const BASE = process.env.T3A_BASE || os.tmpdir();

function stage(name) {
  if (process.env.T3A_DEBUG) console.log('  stage ' + name);
}

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  fs.mkdirSync(BASE, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const phases = [
    { name: 'production', script: __filename },
    { name: 'native', script: __filename },
  ];
  const summary = { electron: null, chrome: null, phases: [], checks: 0, failed: 0 };
  let status = 0;
  for (const phase of phases) {
    const world = fs.mkdtempSync(path.join(BASE, `pi-gui-t3a-${phase.name}-`));
    const env = { ...process.env, T3A_WORLD: world, T3A_PHASE: phase.name };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [phase.script];
    if (env.T3A_TEST_NO_SANDBOX === '1') args.push('--no-sandbox');
    const result = spawnSync(require('electron'), args, { env, stdio: 'inherit', windowsHide: true, timeout: 300000 });
    const file = path.join(OUT, `results-${phase.name}.json`);
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { payload = null; }
    if (!payload || result.status !== 0) status = 1;
    summary.phases.push({ name: phase.name, exit: result.status, result: payload });
    if (payload) {
      summary.checks += Number(payload.checks) || 0;
      summary.failed += Number(payload.failed) || 0;
      summary.electron = summary.electron || payload.electron || null;
      summary.chrome = summary.chrome || payload.chrome || null;
    }
    try { fs.rmSync(world, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  }
  summary.screenshots = summary.phases.flatMap((phase) => phase.result?.screenshots || []);
  summary.fixture = 'temporary Git repositories; fake pi shim; no user project, no real model';
  summary.generatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2));
  for (const phase of phases) {
    try { fs.rmSync(path.join(OUT, `results-${phase.name}.json`)); } catch {}
  }
  if (status) {
    console.error('Diff comments Electron failed; see ' + path.join(OUT, 'results.json'));
    process.exit(1);
  }
  console.log(`Diff comments Electron: ${summary.checks}/${summary.checks}; screenshots=${OUT}`);
  process.exit(0);
}

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const { createBrowserController } = require('../electron/browser-view.cjs');
const { createBrowserAgentHost } = require('../electron/browser-agent-host.cjs');
const { createRuntimeBrowserHost } = require('../electron/browser-runtime-host.cjs');

const WORLD = process.env.T3A_WORLD;
const PHASE = process.env.T3A_PHASE || 'production';
const screenshots = [];
let checks = 0;
let checkFailures = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, value) => {
  assert.ok(value, name);
  checks++;
  console.log('  ok  ' + name);
};

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUp(base, child) {
  for (let i = 0; i < 200; i++) {
    try {
      const body = await (await fetch(base + '/api/health')).json();
      if (body?.app === 'pi-gui') return;
    } catch { /* still starting */ }
    if (child.exitCode !== null) throw new Error('backend exited before health check');
    await sleep(100);
  }
  throw new Error('backend health timeout');
}

const gitEnv = (world) => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(world, 'gitconfig'),
  GIT_TERMINAL_PROMPT: '0',
});

function makeRepo(world, name) {
  const project = path.join(world, name);
  fs.mkdirSync(project, { recursive: true });
  const git = (...args) => execFileSync('git', args, {
    cwd: project, encoding: 'utf8', windowsHide: true, env: gitEnv(world), stdio: ['ignore', 'pipe', 'pipe'],
  });
  git('init', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  return { project, git };
}

/* The fake pi answers every command successfully and exits with its parent. */
const FAKE_PI = [
  'const parentPid = process.ppid;',
  'const fs=require("node:fs"),path=require("node:path"); const sessionId="t3a-fixture",cwd=process.cwd(); const sessionFile=path.join(process.env.PI_CODING_AGENT_DIR,"sessions","--"+cwd.replace(/[\\\\/:]/g,"-")+"--","2026-01-01T00-00-00-000Z_"+sessionId+".jsonl"); fs.mkdirSync(path.dirname(sessionFile),{recursive:true}); if(!fs.existsSync(sessionFile))fs.writeFileSync(sessionFile,JSON.stringify({type:"session",version:3,id:sessionId,cwd,timestamp:"2026-01-01T00:00:00.000Z"})+String.fromCharCode(10));',
  'let input = ""; process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", chunk => { input += chunk; let i; while ((i = input.indexOf(String.fromCharCode(10))) >= 0) { const line = input.slice(0, i); input = input.slice(i + 1); try { const cmd = JSON.parse(line); process.stdout.write(JSON.stringify({ type: "response", command: cmd.type, id: cmd.id, success: true, data: { sessionId, sessionFile, sessionName: "T3-A Fixture", messages: [], models: [], thinkingLevels: [] } }) + String.fromCharCode(10)); } catch {} } });',
  'setInterval(() => { try { process.kill(parentPid, 0); } catch { process.exit(0); } }, 400);',
].join('\n');

async function phaseProduction(world) {
  stage('production start');
  const { project, git } = makeRepo(world, 'Comment Worktree');
  write(project, 'SPEC.md', '# Comment Worktree\n\n[Guide](specs/guide.md)\n');
  write(project, 'specs/guide.md', '# Guide\n\nLine comment fixture.\n');
  write(project, 'src/app.js', 'export function rate(x) {\n  return x * 1;\n}\n\nexport const keep = true;\n');
  write(project, 'src/other.js', 'export const other = 1;\n');
  git('add', '.');
  git('commit', '-m', 'fixture baseline');
  write(project, 'src/app.js', [
    'export function rate(x) {',
    '  if (x < 0) return 0;',
    '  return x * 2;',
    '}',
    '',
    'export const keep = true;',
    '',
  ].join('\n'));

  const data = path.join(world, 'data');
  fs.mkdirSync(data, { recursive: true });
  const fakePiScript = path.join(world, 'fake-pi.cjs');
  fs.writeFileSync(fakePiScript, FAKE_PI, 'utf8');
  const fakePi = path.join(world, 'fake-pi.cmd');
  fs.writeFileSync(fakePi, '@echo off\r\n"%FAKE_PI_NODE%" "%~dp0fake-pi.cjs" %*\r\n', 'utf8');

  app.setPath('userData', path.join(world, 'user-data-production'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const backend = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      PI_CWD: project,
      PI_GUI_DATA: data,
      PI_GUI_OPEN: '0',
      PI_GUI_OFFLINE: '1',
      PI_OFFLINE: '1',
      PI_BIN: fakePi,
      FAKE_PI_NODE: process.execPath,
      PI_CODING_AGENT_DIR: path.join(world, 'agent'),
      TEMP: world, TMP: world, TMPDIR: world,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let backendOutput = '';
  backend.stdout.on('data', (chunk) => { backendOutput += chunk; });
  backend.stderr.on('data', (chunk) => { backendOutput += chunk; });
  let win;
  try {
    await waitUp(base, backend);
    stage('backend ready');
    win = new BrowserWindow({
      show: true, useContentSize: true, autoHideMenuBar: true, width: 1200, height: 850,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    const rendererErrors = [];
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' && !String(event.message).includes('Electron Security Warning')) rendererErrors.push(event.message);
    });
    await win.loadURL(base + '/');
    const read = (code) => win.webContents.executeJavaScript(code, true);
    const until = async (code, label = 'T3-A Electron state') => {
      for (let i = 0; i < 300; i++) {
        if (await read(code)) return;
        await sleep(50);
      }
      throw new Error(label + ' timeout');
    };
    const shot = async (name) => {
      await sleep(200);
      const file = path.join(OUT, name + '.png');
      fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
      screenshots.push(name + '.png');
      check(name + ' screenshot exists', fs.statSync(file).size > 0);
    };
    await win.webContents.debugger.attach('1.3');
    const clickPoint = async (x, y) => {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };
    const clickSelector = async (selector) => {
      const point = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
      if (!point) throw new Error('missing element ' + selector);
      await clickPoint(point.x, point.y);
    };

    await until("document.querySelector('#connText')?.textContent.includes('已连接')", 'Pi fixture ready');
    await until("document.querySelector('#projects') && !document.querySelector('#projects').textContent.includes('加载中')");
    await read("document.querySelector('#navChanges').click()");
    await until("document.querySelector('.chg-row')", 'Changes list');
    check('real app shows the temporary repository change count', await read(
      "document.querySelectorAll('.chg-row').length===1 && document.querySelector('.chg-path').textContent==='src/app.js'"
    ));
    await shot('01-single-panel-changes');

    await clickSelector('.chg-row .chg-main');
    await until("document.querySelector('.d-row[data-line-type=\"add\"]')");
    const lineNumbers = await read(`(()=>[...document.querySelectorAll('.d-row')].map(r=>[r.dataset.lineType,r.dataset.oldLine,r.dataset.newLine]))()`);
    check('real Git patch exposes old and new line numbers', lineNumbers.some((row) => row[0] === 'del' && row[1] && !row[2]) &&
      lineNumbers.some((row) => row[0] === 'add' && !row[1] && row[2]));

    await clickSelector('.chg-row .d-row[data-line-type="add"][data-new-line="2"] .d-gutter');
    await until("document.querySelector('.d-review-editor textarea')");
    await read(`(()=>{const t=document.querySelector('.d-review-editor textarea');t.focus();t.value='这一行要先校验负数边界，并补一条测试。';t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await clickSelector('.d-review-editor .btn.primary');
    await until("document.querySelector('.d-row.has-comment') && !document.querySelector('.d-review-editor')");
    check('a line comment is saved without sending it to the chat', await read(
      "document.querySelector('#input').value==='' && document.querySelector('#btnChangesReview').textContent.includes('1')"
    ));

    await clickSelector('.chg-row .d-row[data-line-type="add"][data-new-line="3"] .d-gutter');
    await until("document.querySelector('.d-review-editor textarea')");
    await read(`(()=>{const t=document.querySelector('.d-review-editor textarea');t.focus();t.value='乘数不要硬编码，抽成常量。';t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await clickSelector('.d-review-editor .btn.primary');
    await until("document.querySelectorAll('.d-row.has-comment').length===2");
    check('two comments can be attached to one file', await read(
      "document.querySelectorAll('.d-row.has-comment').length===2 && document.querySelector('#btnChangesReview').textContent.includes('2')"
    ));
    await shot('02-two-line-comments');

    await clickSelector('#btnChangesReview');
    await until("document.querySelector('.review-feedback-preview')?.value.includes('负数边界')");
    check('the summary preview is a bounded plain-text feedback block', await read(
      "(()=>{const v=document.querySelector('.review-feedback-preview').value;return v.includes('src/app.js')&&v.includes('工作区')&&v.indexOf('C:'+'\\\\')<0&&v.split(String.fromCharCode(10)).length<40})()"
    ));
    await shot('03-review-summary');
    await read("[...document.querySelectorAll('#modalCard .btn')].find(b=>b.textContent==='关闭').click()");

    await read("document.getElementById('input').value='用户原有的聊天草稿'");
    await clickSelector('#btnChangesReview');
    await until("document.querySelector('.review-feedback-preview')");
    await read("[...document.querySelectorAll('#modalCard .btn')].find(b=>b.textContent==='填入当前会话').click()");
    await sleep(300);
    check('fill appends to the existing draft and never sends', await read(
      "(()=>{const v=document.getElementById('input').value;return v.startsWith('用户原有的聊天草稿')&&v.includes('代码审查意见')&&document.getElementById('statusText').getAttribute('aria-busy')!=='true'})()"
    ));
    await shot('04-fill-composer');

    /* A real file change, then the existing manual refresh. */
    write(project, 'src/app.js', [
      'export function rate(x) {',
      '  if (x < 0) return 0;',
      '  return x * 3;',
      '}',
      '',
      'export const keep = true;',
      '',
    ].join('\n'));
    await read("document.querySelector('#btnChangesRefresh').click()");
    await until("document.querySelector('.chg-row')", 'refresh');
    /* The list refreshed but no diff was re-rendered yet, so the anchors are
     * unproven - the summary must say so instead of claiming validity. */
    await sleep(250);
    await clickSelector('#btnChangesReview');
    await until("document.querySelector('.review-unverified')");
    check('a refresh without a re-rendered diff reports anchors as unverified', await read(
      "document.querySelectorAll('.review-unverified').length===2 && document.querySelectorAll('.review-stale').length===0"
    ));
    await shot('05-unverified-after-refresh');
    await read("[...document.querySelectorAll('#modalCard .btn')].find(b=>b.textContent==='关闭').click()");
    await read("(()=>{const row=document.querySelector('.chg-row');if(row.querySelector('.chg-diff').hidden)row.querySelector('.chg-main').click();return true})()");
    await until("document.querySelector('.d-row[data-line-type=\"add\"]')");
    await sleep(250);
    await clickSelector('#btnChangesReview');
    await until("document.querySelector('.review-stale')");
    check('a changed diff marks the comments stale instead of rebinding them', await read(
      `(()=>{const stale=[...document.querySelectorAll('#modalCard .review-item')].filter(i=>i.dataset.stale==='true');
        const live=[...document.querySelectorAll('#modalCard .review-item')].filter(i=>i.dataset.stale==='false');
        return stale.length===1 && live.length===1 &&
          stale[0].textContent.includes('return x * 2') &&
          live[0].textContent.includes('if (x < 0) return 0;')})()`
    ));
    check('a still-identical line keeps its marker while the changed one loses it', await read(
      "document.querySelectorAll('.d-row.has-comment').length===1"
    ));
    await shot('05-stale-comments');
    await read("[...document.querySelectorAll('#modalCard .btn')].find(b=>b.textContent==='关闭').click()");

    for (const width of [1536, 1200, 900, 720]) {
      win.setContentSize(width, 850);
      await sleep(260);
      const facts = await read(`(()=>{const r=document.querySelector('#rightPane').getBoundingClientRect();const head=document.querySelector('#rightPane .chg-head');const buttons=[...head.querySelectorAll('button')];const hb=head.getBoundingClientRect();return {width:r.width,overflow:document.documentElement.scrollWidth>innerWidth+1,inner:innerWidth,headHeight:hb.height,buttons:buttons.map(b=>{const x=b.getBoundingClientRect();return {id:b.id||b.className,visible:x.width>0&&x.height>0,inHead:x.top>=hb.top-1&&x.bottom<=hb.bottom+1}})}})()`);
      check(`${width}px Changes layout keeps every header action on one visible row`,
        !facts.overflow && facts.width > 240 && facts.headHeight <= 48 && facts.buttons.length >= 3 &&
        facts.buttons.every((button) => button.visible && button.inHead), facts);
      await shot(`06-changes-${width}`);
    }

    win.setContentSize(1200, 850);
    await sleep(200);
    await read("document.querySelector('#btnSpecs').click()");
    await until("document.querySelector('#rightPane').dataset.surface==='specs'");
    await read("document.querySelector('#btnSpecsSplit').click()");
    await until("document.querySelector('.workbench-split') && document.querySelector('#workbenchChangesPane .chg-row')", 'Specs + Changes split');
    /* A background Git refresh can replace the row between the click and the
     * diff request. Expand again only while the row is genuinely collapsed. */
    let splitDiffReady = false;
    for (let i = 0; i < 60; i++) {
      splitDiffReady = await read("!!document.querySelector('#workbenchChangesPane .d-row')");
      if (splitDiffReady) break;
      await read(`(()=>{const row=document.querySelector('#workbenchChangesPane .chg-row');if(row&&row.querySelector('.chg-diff').hidden)row.querySelector('.chg-main').click();return true})()`);
      await sleep(100);
    }
    check('the split Changes pane eventually shows its diff', splitDiffReady);
    check('Specs + Changes split keeps both panes alive after a diff is expanded', await read(
      "document.querySelectorAll('.workbench-pane').length===2 && document.querySelector('#workbenchChangesPane .chg-row')!==null && !!document.querySelector('[data-spec-path]')"
    ));
    if (process.env.T3C_RANGES === '1') {
      await read(`(()=>{const a=[...document.querySelectorAll('#workbenchChangesPane .d-row[data-line-type=add] .d-gutter')];a[0].click();a.at(-1).dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}));document.querySelector('.d-review-range-action button').click()})()`);
      check('Specs split supports a focused range editor alongside the original single',await read("(()=>{const e=[...document.querySelectorAll('.d-review-editor')].find(e=>JSON.parse(e.dataset.anchor).range);return !!e&&document.activeElement===e.querySelector('textarea')})()"));
    }
    await shot('07-specs-changes-split');
    check('real Electron renderer has no error-level console entries', rendererErrors.length === 0, rendererErrors.slice(0, 5));
  } catch (error) {
    try {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, 'production-failure.json'), String(error?.stack || error));
      if (win && !win.isDestroyed()) fs.writeFileSync(path.join(OUT, 'production-failure.png'), (await win.webContents.capturePage()).toPNG());
    } catch {}
    if (backendOutput) console.error(backendOutput.slice(-4000));
    throw error;
  } finally {
    win?.destroy();
    try { backend.kill(); } catch {}
  }
}

let fixtureServer;
let pageServer;
let browserWindow;
let browserController;
let runtimeHost;
let agentHost;

async function phaseNative(world) {
  stage('native start');
  app.setPath('userData', path.join(world, 'user-data-native'));
  const { project, git } = makeRepo(world, 'native-project');
  write(project, 'example.js', 'const value = 1;\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  write(project, 'example.js', 'const value = 2;\nconst added = true;\n' + (process.env.T3C_RANGES === '1' ? 'const long = "'+'x'.repeat(500)+'";\n' : ''));
  const diff = execFileSync('git', ['diff'], { cwd: project, encoding: 'utf8', windowsHide: true, env: gitEnv(world) });

  pageServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><style>body{font:16px sans-serif;padding:16px;background:#eef2ef}article{height:600px}</style><h1>Local preview</h1><p>Native view above a commentable diff.</p><article>Scrollable page body.</article>');
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  const page = `http://127.0.0.1:${pageServer.address().port}`;

  const fixtureModule = `
import {S} from '/state.js';
window.addEventListener('unhandledrejection', e => console.error('UNHANDLED ' + (e.reason?.stack || e.reason)));
window.addEventListener('error', e => console.error('WINDOW ERROR ' + (e.error?.stack || e.message)));
import {initRightPane} from '/right-pane.js';
import {configureSecondaryPane} from '/ui/secondary-surface.js';
import {attachBrowserPane} from '/browser-pane.js';
import {openSplitWorkbench} from '/ui/split-workbench.js';
import {setGitConversationScope} from '/api.js';
S.workspaceGeneration=1;S.switching=false;S.bridgeState='ready';S.hasProject=true;S.submitting=false;S.stopping=false;
document.getElementById('projectSidebar').hidden=true;
const pane=initRightPane();configureSecondaryPane(pane);
const browser=attachBrowserPane(pane,{openWorkbench:openSplitWorkbench});
window.test={pane,browser,setGitConversationScope};
window.fixtureReady=true;
`;
  const nativeComments = require('./fixtures/review-comment-backend.cjs')();
  fixtureServer = http.createServer((req, res) => {
    try {
      const route = new URL(req.url, 'http://localhost').pathname;
      if (route.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        if (route === '/api/review-comments') {
          let raw=''; req.on('data',chunk=>{raw+=chunk;});
          req.on('end',async()=>{ const headers={}; for(const [k,v] of Object.entries(req.headers))if(k==='x-pi-gui-conversation')headers['X-Pi-Gui-Conversation']=v;
            const response=await nativeComments.response({method:req.method,headers,body:raw});res.end(JSON.stringify(await response.json())); }); return;
        }
        if (route === '/api/git/status') {
          return res.end(JSON.stringify({ ok: true, isRepo: true, files: [{ path: 'example.js', status: 'M', additions: 2, deletions: 1 }] }));
        }
        if (route === '/api/git/diff') {
          return res.end(JSON.stringify({ ok: true, staged: '', working: diff, binary: false, truncated: false }));
        }
        return res.end(JSON.stringify({ ok: true }));
      }
      if (route === '/fixture.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return res.end(fixtureModule);
      }
      const file = path.resolve(ROOT, 'public', route === '/' ? 'index.html' : '.' + route);
      if (!file.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        return res.end();
      }
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8');
      let data = fs.readFileSync(file);
      if (route === '/') data = data.toString().replace('src="/app.js"', 'src="/fixture.js"');
      res.end(data);
    } catch (error) {
      console.error('fixture error ' + req.url + ': ' + (error?.stack || error));
      try { res.writeHead(500); res.end('fixture error'); } catch {}
    }
  });
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixtureServer.address().port}`;
  browserWindow = new BrowserWindow({
    title: 'T3-A native verification', width: 1200, height: 850, useContentSize: true, show: true,
    webPreferences: {
      preload: path.join(ROOT, 'electron/preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  browserController = createBrowserController({ origin, getWindow: () => browserWindow, ipcMain, isVisible: () => !runtimeHost || runtimeHost.isLegacyVisible() });
  browserController.register();
  /* The pane's preload always asks for Agent Control status, so the host must
   * exist even though this suite never enables it. */
  agentHost = createBrowserAgentHost({
    browser: browserController,
    origin,
    getWindow: () => browserWindow,
    ipcMain,
    extensionPath: path.join(ROOT, 'extensions/pi-gui-browser/index.js'),
  });
  await agentHost.start();
  runtimeHost = createRuntimeBrowserHost({ origin, getWindow: () => browserWindow, ipcMain, onFocus: (flag) => browserController.setOccluded(flag) });
  await runtimeHost.start();
  browserWindow.webContents.on('preload-error', (event, file, error) => {
    console.error('preload error ' + file + ': ' + (error?.stack || error));
  });
  await browserWindow.loadURL(origin);
  stage('page loaded');
  const read = (code) => browserWindow.webContents.executeJavaScript(code, true);
  const until = async (code, label = 'native state') => {
    for (let i = 0; i < 240; i++) {
      if (await read(code)) return;
      await sleep(50);
    }
    throw new Error(label + ' timeout');
  };
  /* Main-process conditions (native view identity) cannot be evaluated in the
   * renderer, so they get their own poller instead of a code string. */
  const untilMain = async (fn, label = 'native main state') => {
    for (let i = 0; i < 240; i++) {
      if (await fn()) return;
      await sleep(50);
    }
    throw new Error(label + ' timeout');
  };
  const native = () => browserWindow.contentView.children.find((view) => view.webContents === browserController.getWebContents());
  const boundsMatch = async () => {
    const rect = await read(`(()=>{const r=document.getElementById('browserViewport')?.getBoundingClientRect();return r&&{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    const view = native();
    if (!rect || !view) return false;
    const bounds = view.getBounds();
    const zoom = browserWindow.webContents.getZoomFactor();
    return ['x', 'y', 'width', 'height'].every((key) => Math.abs(bounds[key] - rect[key] * zoom) <= 1);
  };
  const shot = async (name) => {
    await sleep(200);
    fs.writeFileSync(path.join(OUT, name + '.png'), (await browserWindow.capturePage()).toPNG());
    screenshots.push(name + '.png');
    const child = native();
    if (child) {
      fs.writeFileSync(path.join(OUT, name + '-native-page.png'), (await child.webContents.capturePage()).toPNG());
      screenshots.push(name + '-native-page.png');
    }
    check(name + ' screenshot exists', fs.statSync(path.join(OUT, name + '.png')).size > 0);
  };
  const clickSelector = async (selector, shift = false) => {
    const point = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    if (!point) throw new Error('missing ' + selector);
    browserWindow.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1, modifiers:shift?['shift']:[] });
    browserWindow.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1, modifiers:shift?['shift']:[] });
  };

  await until('window.fixtureReady===true', 'fixture renderer');
  stage('fixture ready');
  await read('test.setGitConversationScope(null)');
  await read('test.browser.open()');
  stage('browser opened');
  await untilMain(() => browserController.getWebContents(), 'native creation');
  stage('native created');
  browserController.navigate(page);
  await untilMain(() => browserController.getState().url === page + '/' && !browserController.getState().loading, 'local page');
  await untilMain(boundsMatch, 'single bounds');
  await read('test.browser.openSplit()');
  await until("document.querySelector('.workbench-pane-browser') && document.querySelector('#workbenchChangesPane .chg-main')", 'Browser + Changes split');
  await untilMain(boundsMatch, 'split bounds');
  check('Browser and Changes are simultaneously visible in real Electron', await read(
    "!!document.querySelector('.workbench-pane-browser') && !!document.querySelector('#workbenchChangesPane .chg-main')"
  ));
  await shot('08-browser-changes-split');

  await clickSelector('#workbenchChangesPane .chg-main');
  await until("document.querySelector('#workbenchChangesPane .d-row[data-line-type=\"add\"]')");
  const before = native().getBounds();
  const rangeMode = process.env.T3C_RANGES === '1';
  if (rangeMode) check('long code keeps horizontal Diff scrolling',await read("(()=>{const d=document.querySelector('#workbenchChangesPane .diff');return d.scrollWidth>d.clientWidth+100})()"));
  if (rangeMode) await clickSelector('#workbenchChangesPane .d-row[data-line-type="add"][data-new-line="1"] .d-gutter');
  await clickSelector('#workbenchChangesPane .d-row[data-line-type="add"][data-new-line="2"] .d-gutter',rangeMode);
  if (rangeMode) { await until("document.querySelector('.d-review-range-action button')");await clickSelector('.d-review-range-action button'); }
  await until("document.querySelector('#workbenchChangesPane .d-review-editor textarea')");
  check('the comment editor opens below the native Browser without covering it', await read(
    `(()=>{const e=document.querySelector('#workbenchChangesPane .d-review-editor').getBoundingClientRect();
      const b=document.getElementById('browserViewport').getBoundingClientRect();
      return e.top >= b.bottom - 1 && e.height > 0})()`
  ));
  await read(`(()=>{const t=document.querySelector('#workbenchChangesPane .d-review-editor textarea');t.focus();t.value='分屏状态下，这一行需要显式处理空值。';t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await clickSelector('#workbenchChangesPane .d-review-editor .btn.primary');
  await until(rangeMode ? "document.querySelector('#workbenchChangesPane .d-row.has-range-comment')" : "document.querySelector('#workbenchChangesPane .d-row.has-comment')");
  check('comment markers render in the lower pane while the native view stays attached', await read(
    `document.querySelector('#workbenchChangesPane .d-row.${rangeMode?'has-range-comment':'has-comment'}')!==null && document.querySelector('#btnChangesReview').textContent.includes('1')`
  ));
  check('the native view keeps the same identity and bounds during commenting', (() => {
    const now = native().getBounds();
    return ['x', 'y', 'width', 'height'].every((key) => Math.abs(now[key] - before[key]) <= 1);
  })());
  await shot('09-browser-split-comment');

  await read("document.getElementById('modal').hidden=false");
  await untilMain(() => !native(), 'modal detach');
  check('a modal detaches the native view away from the comment workflow', true);
  await read("document.getElementById('modal').hidden=true");
  await untilMain(boundsMatch, 'modal restore');
  /* Narrow the window first: only the fallback layout hides one pane, and only
   * hiding the Browser pane should detach the native view. */
  browserWindow.setContentSize(720, 850);
  await until("document.querySelector('.workbench-split').classList.contains('is-fallback')", 'fallback layout');
  await read("document.querySelector('[data-workbench-tab=changes]').click()");
  await untilMain(() => !native(), 'fallback detach');
  check('the narrow fallback detaches the native view but keeps the comment', await read(
    `document.querySelector('#workbenchChangesPane .d-row.${rangeMode?'has-range-comment':'has-comment'}')!==null`
  ));
  await shot('10-browser-split-fallback');

  for (const width of [720, 900, 1200, 1536]) {
    browserWindow.setContentSize(width, 850);
    await sleep(200);
    check(`${width}px native split has no horizontal overflow`, await read('document.documentElement.scrollWidth<=innerWidth+1'));
    if (rangeMode) {
      if (await read("!!document.querySelector('[data-workbench-tab=changes]')")) await read("document.querySelector('[data-workbench-tab=changes]').click()");
      await read("document.querySelector('.d-review-range-marker').click()");
      const geometry=await read("(()=>{const e=document.querySelector('.d-review-editor').getBoundingClientRect(),p=document.querySelector('#workbenchChangesPane').getBoundingClientRect();return {editor:e.toJSON(),pane:p.toJSON(),active:document.activeElement?.tagName}})()");
      const fits=geometry.editor.width>100&&geometry.editor.left>=geometry.pane.left&&geometry.editor.right<=geometry.pane.right+1;
      if(!fits){console.error('range editor geometry',geometry);await shot('range-editor-overflow');}
      check(`${width}px range editor fits its Changes pane`,fits);
      await read("[...document.querySelectorAll('.d-review-editor button')].find(b=>b.textContent==='取消').click()");
    }
  }
  browserWindow.setContentSize(1200, 850);
  await sleep(200);
  await read("document.querySelector('[data-workbench-tab=browser]').click()");
  await untilMain(boundsMatch, 'browser tab restore');
  check('restoring the Browser tab keeps a single native view after commenting', browserWindow.contentView.children.length === 1);
}

async function main() {
  assert.ok(WORLD && path.isAbsolute(WORLD), 'T3A_WORLD must be absolute');
  await app.whenReady();
  let failure = null;
  try {
    if (PHASE === 'native') await phaseNative(WORLD);
    else await phaseProduction(WORLD);
  } catch (error) {
    failure = error;
  } finally {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `results-${PHASE}.json`), JSON.stringify({
      phase: PHASE,
      generatedAt: new Date().toISOString(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      checks,
      failed: failure ? 1 : 0,
      error: failure ? String(failure?.stack || failure) : null,
      screenshots,
      fixture: 'temporary Git repositories; fake pi shim; no user project, no real model',
    }, null, 2));
    browserWindow?.destroy();
    try { fixtureServer?.close(); } catch {}
    try { pageServer?.close(); } catch {}
  }
  if (failure) {
    console.error(failure);
    process.exitCode = 1;
  } else {
    console.log(`Diff comments ${PHASE}: ${checks}/${checks}`);
  }
  app.exit(process.exitCode || 0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
