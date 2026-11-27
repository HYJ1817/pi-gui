'use strict';
// Benign observation bootstrap: production main owns window/preload/backend.
const functions = {
  async state() {
    const { S } = await import('/state.js');
    return { owner: S.legacyOwner, cwd: S.cwd, streaming: S.streaming,
      connected: document.querySelector('#connText')?.textContent.includes('已连接') === true,
      artifacts: [...document.querySelectorAll('.html-artifact')].map(n => ({ id: n.dataset.artifactId, state: n.dataset.state })),
      followup: [...document.querySelectorAll('.assistant-text')].some(n => /OFFLINE_FIXTURE_FOLLOWUP|VR_LIVE_FOLLOWUP/.test(n.textContent)) };
  },
  visitPendingArtifact() {
    // Like a user browsing the timeline: distant references stay lazy until
    // visited. Never manufacture IO delivery or relax the ready assertions.
    const node = [...document.querySelectorAll('.html-artifact')].find(n => n.dataset.state !== 'ready');
    node?.scrollIntoView({ block: 'center', behavior: 'instant' });
  },
  point(selector) {
    const e = document.querySelector(selector); if (!e) throw Error('target_missing');
    e.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e.getBoundingClientRect();
    if (!r.width || !r.height) throw Error('target_hidden');
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  },
  frameRect(title) {
    const e = [...document.querySelectorAll('iframe.html-artifact-frame')].find(n => n.title === title);
    if (!e) return null;
    e.scrollIntoView({ block: 'start', behavior: 'instant' }); const r = e.getBoundingClientRect();
    const stream = document.getElementById('stream').getBoundingClientRect();
    const bottom = document.getElementById('chatComposer').getBoundingClientRect().top;
    const visibleHeight = Math.max(0, Math.min(r.bottom, stream.bottom, bottom) - Math.max(r.top, stream.top));
    return { x: r.x, y: r.y, width: r.width, height: r.height, visibleHeight };
  },
  frameState() {
    const b = document.getElementById('sample-action'), r = b?.getBoundingClientRect();
    return { id: document.body?.dataset.sample, ready: document.documentElement.dataset.sampleReady === 'true',
      interacted: document.documentElement.dataset.interacted, text: document.querySelector('#sample-state')?.textContent,
      height: document.documentElement.scrollHeight, width: innerWidth, scrollY,
      imageDecoded: [...document.images].every(i => i.complete && i.naturalWidth > 0),
      action: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null };
  },
  async selectedModel(provider, model) {
    const { S } = await import('/state.js');
    return S.state?.model?.provider === provider && S.state.model.id === model;
  },
  async beginObservation() {
    window.__vrEvents?.close();
    const facts = { toolStarts: 0, htmlStarts: 0, htmlSuccesses: 0, textDeltasAfterHtml: 0, settled: false };
    const events = new EventSource('/api/events');
    window.__vrFacts = facts; window.__vrEvents = events;
    events.onmessage = e => {
      let value; try { value = JSON.parse(e.data); } catch { return; }
      if (value._replay) return;
      if (value.type === 'tool_execution_start') {
        facts.toolStarts++;
        if (value.toolName === 'html_render') facts.htmlStarts++;
      }
      if (value.type === 'tool_execution_end' && value.toolName === 'html_render'
        && value.isError !== true && value.result?.details?.ok === true) facts.htmlSuccesses++;
      if (value.type === 'message_update' && value.assistantMessageEvent?.type === 'text_delta'
        && facts.htmlSuccesses > 0) facts.textDeltasAfterHtml++;
      if (value.type === 'agent_settled') facts.settled = true;
    };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { events.close(); reject(Error('observation_timeout')); }, 10000);
      events.onopen = () => { clearTimeout(timer); resolve(); };
      events.onerror = () => { clearTimeout(timer); events.close(); reject(Error('observation_unavailable')); };
    });
  },
  endObservation() {
    window.__vrEvents?.close();
    return window.__vrFacts;
  },
  async refreshSessions() { await (await import('/sessions.js')).refreshSidebarSessions(); },
  async theme(mode) { return (await import('/theme.js')).setThemePreference(mode); },
  geometry() { return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, theme: document.documentElement.dataset.theme }; },
};
const source = fn => fn.toString().replace(/^(async\s+)?[\w]+\(/, '$1function(');
function validate() {
  for (const fn of Object.values(functions)) new (require('node:vm').Script)('(' + source(fn) + ')');
  return Object.keys(functions).length;
}
module.exports = { functions, validate };
if (process.versions.electron && process.env.VISUAL_REPLIES_OBSERVER === 'functional') start().catch(() => require('electron').app.exit(1));
async function start() {
  const fs = require('node:fs'), path = require('node:path');
  const { app, BrowserWindow } = require('electron');
  const h = require('./visual-replies-support.cjs');
  const { renderer: base } = require('./visual-replies-electron.cjs');
  const world = h.validateWorld(process.env.VISUAL_REPLIES_WORLD, process.env.VISUAL_REPLIES_TEMP_ROOT);
  const phase = process.env.VISUAL_REPLIES_PHASE, mode = process.env.VISUAL_REPLIES_MODE;
  const samples = require('./visual-replies-functional-support.cjs').samplesFor(mode);
  if (!['generate', 'restore'].includes(phase) || !['offline', 'live'].includes(mode)) throw Error('invalid_phase');
  for (const [name, dir] of Object.entries({ home: 'home', appData: 'appdata', userData: 'profile', sessionData: 'profile', temp: 'tmp', logs: 'logs', crashDumps: 'logs' })) app.setPath(name, path.join(world, dir));
  const file = path.join(world, 'evidence/functional-' + phase + '.json');
  const report = { schemaVersion: 1, mode, phase, completed: false, failed: 0, checks: [], shots: [], observations: [],
    visualRepliesAcceptance: false, realModelVerified: false,
    unverified: ['original-A-security', 'final-integrated-packaged-app', 'fullscreen-zoom-matrix'] };
  let win, stage = 'production-main';
  const save = () => h.saveJson(file, report);
  const check = (id, pass, details) => {
    report.checks.push({ id, pass: Boolean(pass), ...(details ? { details } : {}) });
    save(); console.log((pass ? 'PASS ' : 'FAIL ') + id); if (!pass) throw Error('check_failed');
  };
  const read = (fn, ...args) => win.webContents.executeJavaScript('(' + source(fn) + ')(...' + JSON.stringify(args) + ')', true);
  const until = async (fn, label, ms = 30000) => {
    stage = label; const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await h.sleep(100); }
    throw Error('condition_timeout');
  };
  const pointer = async point => { for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }); };
  const click = async selector => pointer(await read(functions.point, selector));
  const shot = async name => {
    await read(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
    const png = (await win.webContents.capturePage()).toPNG();
    fs.writeFileSync(path.join(world, 'evidence', phase + '-' + name + '.png'), png, { flag: 'wx' });
    report.shots.push({ file: phase + '-' + name + '.png', bytes: png.length, sha256: h.hashText(png), ...await read(functions.geometry) }); save();
  };
  const sampleFrame = async id => {
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      if (frame === win.webContents.mainFrame || frame.url !== 'about:srcdoc') continue;
      try { const value = await frame.executeJavaScript('(' + source(functions.frameState) + ')()', true); if (value.id === id && value.ready) return { frame, value }; } catch {}
    }
    return null;
  };
  const interact = async row => {
    await until(async () => Boolean(await sampleFrame(row.id)), 'frame-' + row.id);
    const selected = await sampleFrame(row.id);
    await selected.frame.executeJavaScript('scrollTo(0,0)', true);
    let rect, before, point, previous, stable = 0;
    await until(async () => {
      rect = await read(functions.frameRect, row.title);
      before = await selected.frame.executeJavaScript('(' + source(functions.frameState) + ')()', true);
      if (!rect || !before.action) return false;
      point = { x: rect.x + before.action.x, y: rect.y + before.action.y };
      const identity = JSON.stringify([rect, point]);
      stable = identity === previous ? stable + 1 : 0; previous = identity;
      return stable >= 3;
    }, 'stable-action-' + row.id);
    report.observations.push({ id: 'pointer-' + row.id, rect, point, action: before.action }); save();
    await pointer(point);
    await until(async () => (await sampleFrame(row.id))?.value.text === row.expected, 'interaction-' + row.id);
    const after = (await sampleFrame(row.id)).value;
    check((phase === 'restore' ? 'restart-js-interaction-' : 'actual-js-interaction-') + row.id,
      after.interacted === '1' && after.text === row.expected);
    return { before, after };
  };
  const submit = async text => {
    await click('#input'); await win.webContents.debugger.sendCommand('Input.insertText', { text });
    await until(() => read(() => !document.querySelector('#btnSend').disabled), 'send-enabled');
    await click('#btnSend');
  };
  app.once('will-quit', () => { report.quitObserved = true; save(); });
  save(); require(path.join(h.ROOT, 'electron/main.cjs'));
  try {
    await app.whenReady();
    await until(() => {
      win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:' + process.env.PORT + '/'));
      return Boolean(win);
    }, 'production-window', 60000);
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.debugger.attach('1.3');
    const prefs = win.webContents.getLastWebPreferences();
    check('normal-sandbox', prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false
      && prefs.webSecurity !== false && !app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('disable-web-security'));
    report.runtime = { electron: process.versions.electron, sandbox: prefs.sandbox, webSecurity: prefs.webSecurity,
      contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, entry: 'source-observer-requires-unmodified-production-main' };
    await until(async () => { const s = await read(functions.state); return s.connected && s.owner?.sessionId; }, 'production-ready');
    check('production-preload', await read(() => window.piGuiDesktop?.isDesktop === true && typeof require === 'undefined'));
    if (mode === 'live') check('explicit-model-selected', await read(functions.selectedModel, process.env.PI_PROVIDER, process.env.PI_MODEL));
    const checkpoint = path.join(world, 'checkpoint.json');
    let original;
    if (phase === 'generate') {
      original = (await read(functions.state)).owner.sessionId;
      for (const [index, row] of samples.entries()) {
        const prompt = mode === 'offline' ? '请创建交互可视化 sample:' + row.id
          : require('./visual-replies-functional-support.cjs').livePrompt(row);
        await read(functions.beginObservation);
        await submit(prompt);
        await until(async () => {
          await read(functions.visitPendingArtifact);
          const s = await read(functions.state);
          return !s.streaming && s.artifacts.length === index + 1 && s.artifacts.every(x => x.state === 'ready') && s.followup;
        }, 'artifact-' + row.id, mode === 'live' ? 240000 : 30000);
        const events = await read(functions.endObservation);
        check('tool-then-streamed-text-' + row.id, events.toolStarts === 1 && events.htmlStarts === 1
          && events.htmlSuccesses === 1 && events.textDeltasAfterHtml > 0, events);
        const { before, after } = await interact(row);
        if (row.id === 'raster-image') check('data-raster-decoded', after.imageDecoded);
        if (row.id === 'long-table') report.observations.push({ id: 'long-table-height', before: before.height, after: after.height, host: await read(functions.frameRect, row.title) });
        await shot(row.id + '-interaction');
      }
      const saved = { sessionId: original, ids: (await read(functions.state)).artifacts.map(x => x.id) };
      fs.writeFileSync(checkpoint, JSON.stringify(saved), { flag: 'wx' });
      check('multiple-artifacts-and-followup', saved.ids.length === samples.length && (await read(functions.state)).followup);
      await click('#btnTopbarNew');
      await until(async () => { const s = await read(functions.state); return s.owner?.sessionId !== original && !s.artifacts.length; }, 'new-session-clears-artifacts');
      check('session-switch-clears-old-artifacts', true);
      await read(functions.refreshSessions);
      await click('.pj-sess[data-session-id="' + original + '"] .pj-sess-primary');
      await until(async () => { await read(functions.visitPendingArtifact); const s = await read(functions.state); return s.owner?.sessionId === original && s.artifacts.length === samples.length && s.artifacts.every(x => x.state === 'ready'); }, 'session-return');
      check('session-return-native-artifacts', true);
    } else {
      const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8')); original = saved.sessionId;
      await read(functions.refreshSessions);
      if ((await read(functions.state)).owner.sessionId !== original)
        await click('.pj-sess[data-session-id="' + original + '"] .pj-sess-primary');
      await until(async () => { await read(functions.visitPendingArtifact); const s = await read(functions.state); return s.artifacts.length === samples.length && s.artifacts.every(x => x.state === 'ready'); }, 'restart-native-artifacts');
      check('restart-native-ref-identities', JSON.stringify((await read(functions.state)).artifacts.map(x => x.id)) === JSON.stringify(saved.ids));
      check('restart-followup-text', (await read(functions.state)).followup);
      for (const row of samples) { await interact(row); await shot(row.id + '-restored-interaction'); }
    }
    const actions = JSON.parse(process.env.VISUAL_REPLIES_VIEWER_ACTIONS || '{}');
    const full = ['open', 'close', 'zoomIn', 'zoomOut', 'reset', 'fit'].every(key => typeof actions[key] === 'string');
    report.matrix = [];
    for (const theme of ['dark', 'light']) for (const width of [700, 1320]) {
      win.setContentSize(width, width === 700 ? 600 : 820);
      await read(functions.theme, theme);
      await until(async () => { const g = await read(functions.geometry); return Math.abs(g.width - width) <= 1 && g.theme === theme; }, 'theme-size');
      for (const row of samples) {
        let target;
        await until(async () => { target = await read(functions.frameRect, row.title); return target?.visibleHeight >= 80; }, 'matrix-target-visible');
        await until(async () => Boolean(await sampleFrame(row.id)), 'matrix-frame');
        const value = (await sampleFrame(row.id)).value;
        const name = row.id + '-' + theme + '-' + width;
        await shot(name + '-inline');
        report.matrix.push({ sample: row.id, theme, requestedWidth: width, ...await read(functions.geometry), mode: 'inline', executed: true, frameWidth: value.width, target });
        if (full) {
          const artifactId = await read(title => [...document.querySelectorAll('.html-artifact')].find(n => n.querySelector('iframe')?.title === title)?.dataset.artifactId, row.title);
          const action = key => click(actions[key].replaceAll('{id}', artifactId));
          await action('open'); await h.sleep(150); await shot(name + '-fullscreen');
          await action('zoomIn'); await action('zoomOut'); await action('reset'); await action('fit'); await shot(name + '-zoom');
          await action('close');
          report.matrix.push({ sample: row.id, theme, width, mode: 'fullscreen/zoom', executed: true });
        } else report.matrix.push({ sample: row.id, theme, width, mode: 'fullscreen/zoom', executed: false, reason: 'viewer-action-contract-not-supplied' });
      }
      check('inline-matrix-' + theme + '-' + width, true);
    }
    report.realModelVerified = mode === 'live' && phase === 'generate'
      && report.checks.some(x => x.id === 'explicit-model-selected' && x.pass)
      && report.checks.some(x => x.id === 'tool-then-streamed-text-filter-panel' && x.pass)
      && report.checks.some(x => x.id === 'actual-js-interaction-filter-panel' && x.pass);
    if (full) report.unverified = report.unverified.filter(x => x !== 'fullscreen-zoom-matrix');
    report.completed = true;
  } catch (error) {
    report.failed = 1; report.failure = { stage, code: ['check_failed', 'condition_timeout'].includes(error.message) ? error.message : 'functional_observer_failed', name: error.name };
    try { if (win) await shot('first-failure'); } catch {}
  } finally {
    try { report.cleanup = await read(base.closeOwners); } catch { report.cleanup = { confirmed: false }; }
    if (!report.cleanup.confirmed) { report.failed++; report.completed = false; }
    report.passed = report.checks.filter(x => x.pass).length;
    fs.writeFileSync(path.join(world, 'functional-ready-for-cleanup-' + phase), 'ready', { flag: 'wx' });
    try { await until(() => fs.existsSync(path.join(world, 'functional-processes-' + phase)), 'parent-process-witness', 30000); }
    catch { report.failed++; report.completed = false; }
    report.endedAt = new Date().toISOString(); save(); app.quit();
    setTimeout(() => app.exit(1), 20000).unref();
  }
}
