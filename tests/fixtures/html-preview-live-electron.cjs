'use strict';

// Observation only: production main/preload/backend/viewer own the app and sandbox.
const { functions: shared } = require('./visual-replies-functional-electron.cjs');
const renderer = { ...shared,
  async state() {
    const { S } = await import('/state.js');
    return { owner: S.legacyOwner, streaming: S.streaming,
      connected: document.querySelector('#connText')?.textContent.includes('已连接') === true,
      desktop: window.piGuiDesktop?.isDesktop === true,
      artifacts: [...document.querySelectorAll('.html-artifact')].map(n => ({ id: n.dataset.artifactId,
        state: n.dataset.state, title: n.querySelector('iframe')?.title || '' })),
      offlineFollowup: [...document.querySelectorAll('.assistant-text')].some(n => n.textContent.includes('OFFLINE_FIXTURE_FOLLOWUP')) };
  },
  async beginObservation() {
    window.__hpEvents?.close();
    const facts = { started: false, settled: false, error: false, tools: Object.create(null), toolOrder: [], toolErrors: [], otherToolStarts: 0,
      previewSuccesses: 0, renderSuccesses: 0, textDeltasAfterRender: 0 };
    const events = new EventSource('/api/events'); window.__hpFacts = facts; window.__hpEvents = events;
    events.onmessage = event => {
      let value; try { value = JSON.parse(event.data); } catch { return; }
      if (value._replay) return;
      if (value.type === 'agent_start') facts.started = true;
      if (value.type === 'agent_settled') facts.settled = true;
      if (value.type === 'agent_error') {
        facts.error = true;
        const text = [value.error?.code, value.error?.message, value.message].filter(Boolean).map(String).join(' ');
        facts.agentErrorCode = text.match(/\b(html_resource_blocked|html_cancelled|html_too_large|html_bridge_unavailable|html_store_unavailable)\b/)?.[1] || 'other';
      }
      if (value.type === 'tool_execution_start') {
        if (['html_preview', 'html_render'].includes(value.toolName)) {
          facts.tools[value.toolName] = (facts.tools[value.toolName] || 0) + 1; facts.toolOrder.push(value.toolName);
        } else facts.otherToolStarts++;
      }
      if (value.type === 'tool_execution_end' && value.isError === true && facts.toolErrors.length < 20) {
        const allowed = ['html_preview_unavailable', 'html_resource_blocked', 'html_cancelled', 'html_too_large', 'html_bridge_unavailable', 'html_store_unavailable'];
        const tool = ['html_preview', 'html_render'].includes(value.toolName) ? value.toolName : 'other';
        const textCode = value.result?.content?.find(part => part?.type === 'text')?.text?.match(/\b(html_resource_blocked|html_cancelled|html_too_large|html_bridge_unavailable|html_store_unavailable)\b/)?.[1];
        const code = value.result?.details?.code || textCode;
        facts.toolErrors.push({ tool, code: allowed.includes(code) ? code : 'other' });
      }
      if (value.type === 'tool_execution_end' && value.isError !== true) {
        if (value.toolName === 'html_preview') facts.previewSuccesses++;
        if (value.toolName === 'html_render') facts.renderSuccesses++;
      }
      if (value.type === 'message_update' && value.assistantMessageEvent?.type === 'text_delta' && facts.renderSuccesses) facts.textDeltasAfterRender++;
    };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { events.close(); reject(Error('event_stream_timeout')); }, 10000);
      events.onopen = () => { clearTimeout(timer); resolve(); };
      events.onerror = () => { clearTimeout(timer); events.close(); reject(Error('event_stream_unavailable')); };
    });
  },
  observation() { return window.__hpFacts || { started: false, settled: false, error: false, tools: {}, toolOrder: [], toolErrors: [], otherToolStarts: 0,
    previewSuccesses: 0, renderSuccesses: 0, textDeltasAfterRender: 0 }; },
  endObservation() { window.__hpEvents?.close(); return window.__hpFacts || null; },
};
const source = fn => fn.toString().replace(/^(async\s+)?[\w]+\(/, '$1function(');
function validate() {
  const vm = require('node:vm');
  for (const fn of Object.values(renderer)) new vm.Script('(' + source(fn) + ')');
  return Object.keys(renderer).length;
}
module.exports = { renderer, validate };
if (process.versions.electron && process.env.HTML_PREVIEW_OBSERVER === '1') start().catch(() => require('electron').app.exit(1));

async function start() {
  const fs = require('node:fs'), path = require('node:path');
  const { app, BrowserWindow } = require('electron'), h = require('./visual-replies-support.cjs');
  const world = h.validateWorld(process.env.VISUAL_REPLIES_WORLD, process.env.VISUAL_REPLIES_TEMP_ROOT);
  const target = process.env.VISUAL_REPLIES_TARGET, mode = process.env.VISUAL_REPLIES_MODE;
  const phase = process.env.VISUAL_REPLIES_PHASE, packaged = target === 'packaged';
  if (!['source', 'packaged'].includes(target) || !['offline', 'live', 'live-text'].includes(mode) || !['generate', 'restore'].includes(phase)) throw Error('invalid_fixture_mode');
  for (const [name, directory] of Object.entries({ home: 'home', appData: 'appdata', userData: 'profile/' + target, sessionData: 'profile/' + target,
    temp: 'tmp', logs: 'logs', crashDumps: 'logs' })) app.setPath(name, path.join(world, directory));
  const main = path.resolve(process.env.VISUAL_REPLIES_MAIN || ''), reportFile = path.join(world, 'evidence', target + '-' + phase + '.json');
  const checkpoint = path.join(world, 'evidence', 'checkpoint-' + target + '.json');
  const report = { target, mode, phase, completed: false, failed: 0, checks: [], prompts: [], shots: [],
    unverified: ['pixel-code-correctness-not-independently-verified', 'external-resource-success-not-tested', 'security-qualification', 'packaged-unless-root-supplied'] };
  let win, stage = 'production-main', watchdog;
  const save = () => h.saveJson(reportFile, report);
  const check = (id, pass, details) => { report.checks.push({ id, pass: Boolean(pass), ...(details ? { details } : {}) });
    save(); console.log((pass ? 'PASS ' : 'FAIL ') + id); if (!pass) throw Error('check_failed'); };
  const read = async (fn, ...args) => {
    const expression = '(' + source(fn) + ')(...' + JSON.stringify(args) + ')';
    try { return await win.webContents.executeJavaScript(expression, true); } catch { throw Error('renderer_evaluation_failed'); }
  };
  const until = async (fn, name, timeout = 30000) => {
    stage = name; const end = Date.now() + timeout;
    while (Date.now() < end) { if (await fn()) return; await h.sleep(100); }
    throw Error(name === 'prompt-settled' ? 'prompt_timeout' : 'condition_timeout');
  };
  const pointer = async point => {
    // Native hover must reach the host even after an opaque iframe owned input.
    // CDP mouseMoved alone can leave the host's hover-only controls inert.
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await read(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
      { type, ...point, button: 'left', clickCount: 1 });
  };
  const click = async selector => pointer(await read(renderer.point, selector));
  const shot = async name => {
    await read(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
    const png = (await win.webContents.capturePage()).toPNG();
    fs.writeFileSync(path.join(world, 'evidence', target + '-' + name + '.png'), png, { flag: 'wx' });
    report.shots.push({ file: target + '-' + name + '.png', bytes: png.length, sha256: h.hashText(png), ...await read(renderer.geometry) }); save();
  };
  const sampleFrame = async sampleId => {
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      if (frame === win.webContents.mainFrame || frame.url !== 'about:srcdoc') continue;
      try {
        const value = await frame.executeJavaScript('(' + source(renderer.frameState) + ')()', true);
        if (value.ready && value.id === sampleId) return { frame, value };
      } catch {}
    }
    return null;
  };
  const interact = async (title, label, sampleId = 'filter-panel') => {
    await until(async () => Boolean(await sampleFrame(sampleId)), 'frame-ready');
    const selected = await sampleFrame(sampleId);
    await selected.frame.executeJavaScript("document.getElementById('sample-action')?.scrollIntoView({block:'center',behavior:'instant'})", true);
    let before, point, previous, stable = 0;
    await until(async () => {
      const rect = await read(renderer.frameRect, title);
      before = await selected.frame.executeJavaScript('(' + source(renderer.frameState) + ')()', true);
      if (!rect || !before.action || rect.visibleHeight < 80) return false;
      point = { x: rect.x + before.action.x, y: rect.y + before.action.y };
      const identity = JSON.stringify(point); stable = identity === previous ? stable + 1 : 0; previous = identity;
      return stable >= 3;
    }, 'stable-page-control');
    if (before.interacted === '1' || before.text === '1 matching task') throw Error('page-control_missing');
    await pointer(point);
    await until(async () => { const value = (await sampleFrame(sampleId))?.value; return value?.interacted === '1' && value.text === '1 matching task'; }, 'page-interaction');
    check(label + '-page-interaction', await selected.frame.executeJavaScript(`(() => {
      const visible = [...document.querySelectorAll('#items li')].filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
      return visible.length === 1 && visible[0].hasAttribute('data-test');
    })()`, true));
  };
  const submit = async text => {
    await click('#input'); await win.webContents.debugger.sendCommand('Input.insertText', { text });
    await until(() => read(() => !document.querySelector('#btnSend').disabled), 'send-enabled'); await click('#btnSend');
  };
  const prompt = async (label, text, budget) => {
    let facts = null, state = null, recorded = false;
    const append = failureCode => {
      if (recorded) return;
      report.prompts.push({ label, started: facts?.started === true, settled: facts?.settled === true, error: facts?.error === true,
        agentErrorCode: facts?.agentErrorCode || null, tools: facts?.tools || {}, toolOrder: facts?.toolOrder || [],
        toolErrors: facts?.toolErrors || [], otherToolStarts: facts?.otherToolStarts || 0,
        previewSuccesses: facts?.previewSuccesses || 0, renderSuccesses: facts?.renderSuccesses || 0,
        textDeltasAfterRender: facts?.textDeltasAfterRender || 0, formalArtifactCount: state?.artifacts?.length || 0,
        ...(failureCode ? { failureCode } : {}) });
      if (state?.owner?.sessionId) report.sessionId = state.owner.sessionId;
      recorded = true; save();
    };
    try {
      await read(renderer.beginObservation); await submit(text);
      await until(async () => { const value = await read(renderer.observation); return value.settled || value.error; }, 'prompt-settled', budget);
      facts = await read(renderer.endObservation); state = await read(renderer.state);
      append(null); return report.prompts.at(-1);
    } catch (error) {
      try { facts ||= await read(renderer.endObservation); } catch {}
      try { state ||= await read(renderer.state); } catch {}
      const safe = ['prompt_timeout', 'condition_timeout', 'event_stream_timeout', 'event_stream_unavailable', 'renderer_evaluation_failed', 'check_failed'];
      append(safe.includes(error.message) ? error.message : 'prompt_failed');
      throw error;
    }
  };
  const matrix = async title => {
    for (const theme of ['dark', 'light']) for (const [name, width, height] of [['wide', 1320, 820], ['narrow', 700, 600]]) {
      win.setContentSize(width, height); await read(renderer.theme, theme);
      await until(async () => { const g = await read(renderer.geometry); return g.theme === theme && Math.abs(g.width - width) <= 1; }, 'theme-size');
      await read(renderer.frameRect, title); await h.sleep(120); await shot(theme + '-' + name);
    }
    // Published-viewer controls must also work when private preview is static.
    const activate = async selector => {
      const point = await read((title, selector) => {
        let node;
        if (selector === '.html-artifact-expand') {
          const frame = [...document.querySelectorAll('iframe.html-artifact-frame')].find(item => item.title === title);
          node = frame?.closest('.html-artifact')?.querySelector(selector);
        } else {
          const surface = [...document.querySelectorAll('.html-artifact-surface')].find(item => item.open && item.getAttribute('aria-label') === title);
          node = surface?.querySelector(selector);
        }
        if (!node || node.disabled) return null;
        node.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = node.getBoundingClientRect();
        return rect.width && rect.height ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
      }, title, selector);
      if (!point) throw Error('viewer_control_unavailable');
      await pointer(point);
    };
    win.setContentSize(1320, 820); await read(renderer.theme, 'dark'); await read(renderer.frameRect, title);
    await activate('.html-artifact-expand');
    const isOpen = () => read(title => [...document.querySelectorAll('.html-artifact-surface')]
      .some(item => item.open && item.getAttribute('aria-label') === title), title);
    await until(isOpen, 'viewer-open'); await shot('fullscreen-dark-wide');
    await activate('[aria-label="放大"]');
    await until(() => read(title => [...document.querySelectorAll('.html-artifact-surface')]
      .some(item => item.open && item.getAttribute('aria-label') === title && item.dataset.zoom === '1.25'), title), 'viewer-zoom');
    await shot('zoom-dark-wide');
    await activate('[aria-label="缩小"]');
    await until(() => read(title => [...document.querySelectorAll('.html-artifact-surface')]
      .some(item => item.open && item.getAttribute('aria-label') === title && item.dataset.zoom === '1'), title), 'viewer-zoom-out');
    await activate('[aria-label="重置为 100%"]');
    await until(() => read(title => [...document.querySelectorAll('.html-artifact-surface')]
      .some(item => item.open && item.getAttribute('aria-label') === title && item.dataset.zoom === '1'
        && item.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed') === 'false'), title), 'viewer-reset');
    await activate('button[aria-pressed]');
    await until(() => read(title => [...document.querySelectorAll('.html-artifact-surface')]
      .some(item => item.open && item.getAttribute('aria-label') === title
        && item.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed') === 'true'), title), 'viewer-fit');
    await activate('[aria-label="关闭全屏"]');
    await until(async () => !(await isOpen()), 'viewer-close');
    check('public-viewer-open-zoom-reset-fit-close', true);
  };
  app.once('will-quit', () => { report.quitObserved = true; if (watchdog) clearTimeout(watchdog); save(); });
  save();
  try {
    if (!main || !fs.existsSync(main)) throw Error('production_main_missing');
    require(main); await app.whenReady();
    await until(() => { win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:' + process.env.PORT + '/')); return Boolean(win); }, 'window', 60000);
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.show(); win.focus();
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.bringToFront');
    const prefs = win.webContents.getLastWebPreferences();
    check('production-entry-target', packaged ? app.isPackaged === true && h.inside(process.env.VISUAL_REPLIES_PACKAGED_COPY, main)
      && h.digest(main) === process.env.VISUAL_REPLIES_EXPECTED_MAIN_SHA256
      : app.isPackaged === false && main === path.join(h.ROOT, 'electron/main.cjs'));
    check('normal-sandbox', prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false
      && prefs.webSecurity !== false && !app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('disable-web-security'));
    report.runtime = { electron: process.versions.electron, chrome: process.versions.chrome, appIsPackaged: app.isPackaged,
      sandbox: prefs.sandbox, webSecurity: prefs.webSecurity, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration,
      entry: packaged ? 'fixture-package-entry-requires-unchanged-copied-resources-app-main' : 'source-fixture-requires-production-main' };
    await until(async () => { const s = await read(renderer.state); return s.connected && s.desktop && s.owner?.sessionId; }, 'production-ready');
    report.sessionId = (await read(renderer.state)).owner.sessionId; save();
    check('production-preload-no-node', await read(() => window.piGuiDesktop?.isDesktop === true && typeof require === 'undefined' && typeof process === 'undefined'));
    const saved = phase === 'restore' ? JSON.parse(fs.readFileSync(checkpoint, 'utf8')) : null;
    if (phase === 'generate') {
      const previousSession = (await read(renderer.state)).owner.sessionId;
      await click('#btnTopbarNew');
      await until(async () => { const s = await read(renderer.state); return s.connected && s.owner?.sessionId
        && s.owner.sessionId !== previousSession && !s.streaming && !s.artifacts.length; }, 'fresh-target-session');
      report.sessionId = (await read(renderer.state)).owner.sessionId; save();
      if (mode.startsWith('live')) check('explicit-model-selected', await read(renderer.selectedModel, process.env.PI_PROVIDER, process.env.PI_MODEL));
      if (mode === 'offline') {
        const result = await prompt('offline-filter-panel', 'sample:filter-panel', 30000);
        report.previewReportedError = result.toolErrors.some(error => error.tool === 'html_preview');
        check('offline-preview-before-render', result.started && result.settled && !result.error && result.otherToolStarts === 0
          && result.tools.html_preview === 1 && result.tools.html_render === 1
          && result.toolOrder.join(',') === 'html_preview,html_render' && result.renderSuccesses === 1
          && (result.previewSuccesses === 1 || report.previewReportedError));
        check('offline-followup-text-after-render', result.textDeltasAfterRender > 0);
      } else {
        if (mode === 'live') {
          const natural = 'Analyze our six-service latency experiment. Baseline/candidate p50 and p95 in milliseconds: Parser 42/30 and 90/70; Renderer 180/122 and 430/250; Storage 89/84 and 210/230; Search 65/51 and 190/155; Network 110/105 and 360/390; Queue 38/25 and 150/90. Each number is the median across five runs with equal traffic. Explain which rollout is most promising, compare relative and absolute gains, and highlight tail regressions and one evidence caveat. Make this easy to compare at a glance.';
          const plain = await prompt('natural-comparison', natural, 240000);
          report.autonomousVisualization = { completed: plain.started && plain.settled && !plain.error,
            htmlRenderCalls: plain.tools.html_render || 0, successfulPublishes: plain.renderSuccesses,
            usedWithoutVisualInstruction: plain.renderSuccesses > 0 };
          check('natural-comparison-completed', report.autonomousVisualization.completed);
        }
        const common = 'Create a compact self-contained interactive comparison dashboard for Parser 42 to 30 ms, Renderer 180 to 122 ms, and Storage 89 to 84 ms, with a static table/SVG fallback, a JavaScript-initialized SVG or DOM chart, and a Canvas drawing. Use body data-sample="p3-live-final", button id="sample-action", output id="sample-state", and ul id="items" with Code, Tests, Docs li rows; mark the Tests row data-test. After setup set document.documentElement.dataset.sampleReady="true". Clicking the button must filter to Tests only, leave exactly one visible task, set output text to "1 matching task", and set document.documentElement.dataset.interacted="1". First draft: put content inside a main element with min-width:1100px and call html_preview at width 760. Then use the actual layout diagnostics to remove that overflow and preview the corrected document once before publishing that exact corrected HTML with html_render. Maximum two html_preview calls and one html_render; use no other tools, files, remote resources or network. Never weaken isolation; if static preview is reported, acknowledge that scripts were not evaluated, keep the authored fallback, and do not try to enable JavaScript. After publishing, send a short text summary and stop.';
        const challenge = JSON.parse(fs.readFileSync(path.join(world, 'evidence', 'vision-challenge.json'), 'utf8'));
        const vision = ' Embed this provided PNG in the first draft as a visible img with alt="verification pattern", never decode it with code or tools. Only after seeing the html_preview screenshot, report its four visible digits in normal assistant text, and put those digits in the final page data-vision-code attribute. If no screenshot is available, say you could not read it; do not invent digits. PNG data URI: data:image/png;base64,' + challenge.data;
        const explicit = common + (mode === 'live' ? vision : ' You are testing text-only model feedback. Rely on the text diagnostics, not a screenshot; briefly state the measured overflow and the static limitations before publishing.');
        const result = await prompt('explicit-preview-and-render', explicit, 240000);
        const renderIndex = result.toolOrder.indexOf('html_render');
        check('explicit-preview-before-render', result.started && result.settled && !result.error && result.otherToolStarts === 0
          && result.tools.html_preview >= 1 && result.tools.html_preview <= 2 && result.tools.html_render === 1
          && renderIndex === result.toolOrder.length - 1 && result.toolOrder.slice(0, renderIndex).every(name => name === 'html_preview')
          && result.previewSuccesses > 0 && result.renderSuccesses === 1);
        check('explicit-text-after-final-render', result.textDeltasAfterRender > 0);
      }
      let state;
      await until(async () => {
        await read(renderer.visitPendingArtifact); state = await read(renderer.state);
        return state.artifacts.length > 0 && state.artifacts.every(a => a.state === 'ready');
      }, 'formal-artifacts-ready');
      if (mode === 'offline') check('one-formal-artifact-not-preview', state.artifacts.length === 1);
      else check('formal-artifacts-exclude-preview-tool', state.artifacts.length > 0);
      const title = state.artifacts.at(-1).title;
      await interact(title, 'final', mode === 'offline' ? 'filter-panel' : 'p3-live-final');
      if (mode === 'offline') check('offline-after-render-ui-text', state.offlineFollowup);
      report.staticPreview = require('../html-preview-live.cjs').nativeSummary(h, world, state.owner.sessionId).previewModes.static > 0;
      const original = state.owner.sessionId, artifactIds = state.artifacts.map(a => a.id);
      await click('#btnTopbarNew');
      await until(async () => { const next = await read(renderer.state); return next.owner?.sessionId !== original && next.connected && !next.streaming && !next.artifacts.length; }, 'new-session-clears-artifacts');
      check('session-switch-clears-artifacts', true);
      if (mode === 'offline') {
        await prompt('offline-second-session', 'sample:filter-panel', 30000);
        await until(async () => { await read(renderer.visitPendingArtifact); const next = await read(renderer.state);
          return next.artifacts.length === 1 && next.artifacts[0].state === 'ready'; }, 'second-session-artifact');
        const second = await read(renderer.state);
        check('multiple-session-references-isolated', second.owner.sessionId !== original && !artifactIds.includes(second.artifacts[0].id));
      }
      await read(renderer.refreshSessions);
      await click('.pj-sess[data-session-id="' + original + '"] .pj-sess-primary');
      await until(async () => { await read(renderer.visitPendingArtifact); const restored = await read(renderer.state);
        return restored.owner?.sessionId === original && JSON.stringify(restored.artifacts.map(item => item.id)) === JSON.stringify(artifactIds)
          && restored.artifacts.every(item => item.state === 'ready'); }, 'session-return');
      check('session-return-reference-identities', true);
      report.sessionId = original; save();
      await shot('session-return');
      fs.writeFileSync(checkpoint, JSON.stringify({ sessionId: original, artifactIds,
        sampleId: mode === 'offline' ? 'filter-panel' : 'p3-live-final' }), { flag: 'wx' });
      await matrix(title);
    } else {
      await read(renderer.beginObservation);
      await read(renderer.refreshSessions);
      if ((await read(renderer.state)).owner.sessionId !== saved.sessionId)
        await click('.pj-sess[data-session-id="' + saved.sessionId + '"] .pj-sess-primary');
      await until(async () => {
        await read(renderer.visitPendingArtifact); const s = await read(renderer.state);
        return s.owner?.sessionId === saved.sessionId && s.artifacts.length === saved.artifactIds.length
          && s.artifacts.every(a => a.state === 'ready');
      }, 'restart-native-artifacts');
      const state = await read(renderer.state), facts = await read(renderer.endObservation);
      check('restart-reference-identities-restored', JSON.stringify(state.artifacts.map(a => a.id)) === JSON.stringify(saved.artifactIds));
      check('restart-does-not-replay-model-or-tools', !facts.started && Object.values(facts.tools).reduce((a, n) => a + n, 0) === 0);
      const title = state.artifacts.at(-1).title; await interact(title, 'restart', saved.sampleId); await shot('restart-interaction');
    }
    report.completed = true;
  } catch (error) {
    report.failed++; report.failure = { stage, code: ['check_failed', 'condition_timeout', 'prompt_timeout', 'renderer_evaluation_failed',
      'page-control_missing', 'event_stream_timeout', 'event_stream_unavailable', 'production_main_missing'].includes(error.message) ? error.message : 'fixture_failed' };
    try { if (win && !win.isDestroyed()) await shot('first-failure'); } catch {}
  } finally {
    try { report.cleanup = await read(require('./visual-replies-electron.cjs').renderer.closeOwners); }
    catch { report.cleanup = { confirmed: false }; }
    if (!report.cleanup.confirmed) { report.failed++; report.completed = false; }
    fs.writeFileSync(path.join(world, 'html-preview-ready-' + target + '-' + phase), 'ready', { flag: 'wx' });
    try {
      const witness = path.join(world, 'html-preview-processes-' + target + '-' + phase);
      await until(() => fs.existsSync(witness), 'parent-process-witness', 30000);
      check('parent-process-witness', fs.readFileSync(witness, 'utf8') === 'confirmed');
    } catch { report.failed++; report.completed = false; }
    report.completed = report.completed && report.failed === 0; save();
    watchdog = setTimeout(() => {
      report.watchdogTriggered = true; report.completed = false; report.failed++;
      report.failure ||= { stage: 'normal-quit-watchdog', code: 'normal_quit_timeout' };
      save(); app.exit(1);
    }, 20000);
    watchdog.unref(); app.quit();
  }
}
