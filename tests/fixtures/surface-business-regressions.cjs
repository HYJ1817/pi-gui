'use strict';
/* Runs inside canonical surface-lifecycle against the real manager and owners.
 * All server state is in memory; no network, project writes, native Browser or
 * PTY is used here. The Browser bridge is the caller's existing offline fixture. */
module.exports = async function surfaceBusinessRegressions({ surfaces, pane, S, assert, check, tick,
  openSplitWorkbench, specTransport, classic, remountScope }) {
  const empty = () => { for (const tab of surfaces.secondaryTabs()) surfaces.closeSecondarySurface(tab.id); };
  const tabButton = view => document.getElementById(surfaces.secondaryTabs().find(tab => tab.view === view)?.id + '-tab');
  const button = (host, text) => [...host.querySelectorAll('button')].find(item => item.textContent === text);
  const menu = (view, text) => {
    tabButton(view).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    button(document.getElementById('actionMenu'), text).click();
  };
  const key = (target, value) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const previousFetch = global.fetch;
  const savedState = { state: S.state, legacyOwner: S.legacyOwner, hasProject: S.hasProject };
  S.state = { sessionId: 'surface-fixture-session' }; S.hasProject = true;
  S.legacyOwner = { backendInstance: 'surface-fixture-backend', projectId: 'project', repoId: 'repo',
    workspaceId: 'workspace', workspaceEpoch: 'epoch', conversationId: 'classic-chat', runtimeId: 'runtime',
    runtimeGeneration: 'generation', sessionId: S.state.sessionId };
  try {
    empty();
    const { openSessionChangesPanel } = await import('../../public/session-changes-panel.js');
    const { refreshRuntimeViews } = await import('../../public/runtime-state.js');
    const types = new Set(['pi-gui:git-scope', 'pi-gui:session-evidence-context', 'pi-gui:workspace-generation',
      'pi-gui:session-switch', 'pi-gui:session-evidence-changed']);
    const add = document.addEventListener, remove = document.removeEventListener, listeners = [];
    document.addEventListener = function(type, fn, options) {
      if (types.has(type)) listeners.push({ type, fn, active: true });
      return add.call(this, type, fn, options);
    };
    document.removeEventListener = function(type, fn, options) {
      for (const item of listeners) if (item.type === type && item.fn === fn) item.active = false;
      return remove.call(this, type, fn, options);
    };
    let queries = 0, contextReads = 0;
    const options = { context: () => { contextReads++; return { conversationId: 'classic-chat', owner: { ...S.legacyOwner } }; },
      objectTransport: {}, transport: { query: async () => { queries++; return { ok: true, fileCount: 0, operationCount: 0,
        evidenceComplete: true, files: [], capture: { enabled: false } }; } } };
    try {
      const controller = openSessionChangesPanel(options), session = surfaces.secondarySurfaceInstance('session-changes');
      const content = session.host.querySelector('.session-change-body'); await tick();
      check('Session Changes repeated visible, hidden and switched opens reuse one initialized controller', () => {
        assert.equal(openSessionChangesPanel(options), controller);
        pane.close(); assert.equal(openSessionChangesPanel(options), controller);
        surfaces.openSecondaryTool('files'); assert.equal(openSessionChangesPanel(options), controller);
        assert.equal(surfaces.secondarySurfaceInstance('session-changes'), session);
        assert.equal(session.host.querySelector('.session-change-body'), content);
        assert.equal(queries, 1); assert.equal(listeners.filter(item => item.active).length, 5);
      });
      surfaces.closeSecondarySurface('session-changes'); contextReads = 0;
      refreshRuntimeViews();
      document.dispatchEvent(new window.CustomEvent('pi-gui:session-evidence-changed', { detail: S.legacyOwner }));
      check('Session Changes close releases every document and Runtime subscription after repeated opens', () => {
        assert.equal(listeners.filter(item => item.active).length, 0);
        assert.equal(contextReads, 0); assert.equal(session.disposed, true);
      });
    } finally { empty(); document.addEventListener = add; document.removeEventListener = remove; }

    const { openCollabPanel } = await import('../../public/collab-panel.js');
    const { createCollabService, COLLAB_MESSAGES } = await import('../../server/collab-service.js');
    const { createFlowchartDocument, bindSession, validateDocument } = await import('../../lib/collab-doc.js');
    const { confirmSurfaceMeta } = await import('../../public/ui/modal.js');
    const collabScope = { key: 'a'.repeat(64), token: 'b'.repeat(64), sessionId: 'surface-collab-session', assertCurrent() {} };
    let doc = bindSession(createFlowchartDocument({ documentId: 'surface-collab-document' }), collabScope.sessionId);
    const service = createCollabService({ store: { read: () => ({ doc }), write(_scope, revision, value) {
      assert.equal(revision, doc.revision); doc = validateDocument(value); return { doc };
    } } });
    const calls = []; let failOpen = true, uncertainSave = false;
    global.fetch = async (url, request) => {
      assert.equal(url, '/api/collab-documents');
      const payload = JSON.parse(request.body), call = { payload, headers: request.headers }; calls.push(call);
      let answer;
      if (payload.action === 'open' && failOpen) { failOpen = false; answer = { ok: false, code: 'collab_scope_unavailable', error: 'fixture scope unavailable' }; }
      else try { answer = service.execute(collabScope, payload); }
      catch (error) { answer = { ok: false, code: error.code, error: COLLAB_MESSAGES[error.code] || 'fixture refused' }; }
      call.answer = answer;
      if (uncertainSave && payload.action === 'operations') { uncertainSave = false; throw new Error('fixture response lost after commit'); }
      return { json: async () => answer };
    };
    const first = openCollabPanel(); await tick();
    const reload = button(first.host, '重新打开');
    check('Collab failed open exposes an explicit recovery action', () => {
      assert.equal(reload.hidden, false); assert.equal(calls.filter(call => call.payload.action === 'open').length, 1);
    });
    reload.click(); await tick();
    const editor = surfaces.secondarySurfaceInstance('collab');
    check('Collab recovery replaces invalid singleton and obtains fresh server authority', () => {
      assert.notEqual(editor, first); assert.equal(first.disposed, true);
      assert.equal(calls.filter(call => call.payload.action === 'open').length, 2);
      assert.equal(editor.host.querySelectorAll('[data-node-id]').length, 3);
      assert.equal(openCollabPanel(), editor);
      assert.equal(calls.filter(call => call.payload.action === 'open').length, 2);
    });
    const editorId = calls.findLast(call => call.payload.action === 'open').answer.editorId;
    const originalCreateURL = URL.createObjectURL, originalRevokeURL = URL.revokeObjectURL;
    const originalClick = window.HTMLAnchorElement.prototype.click;
    const urls = [], revoked = [];
    URL.createObjectURL = () => { const url = 'blob:surface-collab-' + urls.length; urls.push(url); return url; };
    URL.revokeObjectURL = url => revoked.push(url);
    window.HTMLAnchorElement.prototype.click = function() {};
    try {
      button(editor.host, '导出 SVG').click(); await tick();
      editor.host.querySelector('[data-node-id="n1"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      button(editor.host, '删除所选').click(); await tick();
      check('Collab owns a pending download and deletion confirmation before recovery', () => {
        assert.equal(urls.length, 1); assert.equal(revoked.length, 0);
        assert.ok(confirmSurfaceMeta()?.collabSurface);
      });
      const beforePending = calls.filter(call => call.payload.action === 'operations').length;
      check('Collab pending deletion keeps the existing canvas write gate closed', () => {
        assert.equal(button(editor.host, '新增节点').disabled, true);
        button(editor.host, '新增节点').click();
        assert.equal(calls.filter(call => call.payload.action === 'operations').length, beforePending);
      });
      // Exercise lifecycle replacement directly while the owned modal is pending.
      // Do not synthesize a click through that modal to manufacture a save error.
      const replacement = openCollabPanel({ replace: true }); await tick();
      check('Collab explicit replacement retires pending deletion, captured editor, canvas and download', () => {
        assert.equal(editor.disposed, true); assert.notEqual(replacement, editor);
        assert.equal(calls.filter(call => call.payload.action === 'open').length, 3);
        const closed = calls.filter(call => call.payload.action === 'close' && call.payload.editorId === editorId);
        assert.equal(closed.length, 1); assert.equal(closed[0].headers['X-Pi-Gui-Owner'], JSON.stringify(S.legacyOwner));
        assert.deepEqual(revoked, urls); assert.equal(confirmSurfaceMeta(), null);
        assert.equal(editor.host.querySelector('.collab-canvas'), null);
        assert.equal(replacement.host.querySelectorAll('[data-node-id]').length, 3);
        assert.equal(calls.filter(call => call.payload.action === 'operations').length, beforePending);
      });
      const replacementId = calls.findLast(call => call.payload.action === 'open').answer.editorId;
      button(replacement.host, '导出 SVG').click(); await tick();
      uncertainSave = true; button(replacement.host, '新增节点').click(); await tick();
      const retry = button(replacement.host, '重新打开'); retry.focus(); retry.click(); await tick();
      const fresh = surfaces.secondarySurfaceInstance('collab');
      check('Collab uncertain-save reopen closes captured editor and clears old canvas and URL', () => {
        assert.equal(replacement.disposed, true); assert.notEqual(fresh, replacement);
        assert.equal(calls.filter(call => call.payload.action === 'open').length, 4);
        const closed = calls.filter(call => call.payload.action === 'close' && call.payload.editorId === replacementId);
        assert.equal(closed.length, 1); assert.equal(closed[0].headers['X-Pi-Gui-Owner'], JSON.stringify(S.legacyOwner));
        assert.deepEqual(revoked, urls); assert.equal(confirmSurfaceMeta(), null);
        assert.equal(replacement.host.querySelector('.collab-canvas'), null);
        assert.equal(fresh.host.querySelectorAll('[data-node-id]').length, 4);
        assert.equal(document.activeElement, tabButton('collab'));
      });
    } finally {
      empty(); URL.createObjectURL = originalCreateURL; URL.revokeObjectURL = originalRevokeURL;
      window.HTMLAnchorElement.prototype.click = originalClick;
    }
    global.fetch = previousFetch;

    for (const child of ['specs', 'changes']) {
      const layout = openSplitWorkbench({ specsOptions: { transport: specTransport } }); await tick();
      const top = surfaces.secondarySurfaceInstance('specs'), changes = surfaces.secondarySurfaceInstance('changes');
      surfaces.activateSecondarySurface(child); surfaces.closeSecondarySurface(child);
      check(`closing standalone ${child} also retires its persistent split dependency`, () => {
        assert.equal(layout.disposed, true); assert.equal(surfaces.secondarySurfaceInstance(layout.view), null);
        const sibling = child === 'specs' ? changes : top;
        assert.equal(sibling.isCurrent(), true); assert.equal(sibling.host.parentElement, pane.root.querySelector('.rp-body'));
        assert.equal(surfaces.activateSecondarySurface(layout.view), null);
      });
      empty();
    }
    for (const kind of ['specs', 'browser']) for (const action of ['关闭其它标签页', '关闭右侧标签页']) {
      if (kind === 'browser') classic.openSplit();
      else openSplitWorkbench({ specsOptions: { transport: specTransport } });
      await tick();
      const view = kind === 'browser' ? 'browser-changes-split' : 'workbench-split';
      const layout = surfaces.secondarySurfaceInstance(view), top = surfaces.secondarySurfaceInstance(kind);
      const changes = surfaces.secondarySurfaceInstance('changes');
      surfaces.moveSecondarySurface(view, surfaces.secondaryTabs()[0].id);
      surfaces.openSecondaryTool('files'); surfaces.activateSecondarySurface(view);
      menu(view, action);
      check(`${kind} split ${action} protects its reordered target and full child closure`, () => {
        assert.equal(layout.isCurrent(), true); assert.equal(top.isCurrent(), true); assert.equal(changes.isCurrent(), true);
        assert.equal(pane.isOpen(), true); assert.equal(surfaces.secondaryTabs().length, 3);
        assert.ok(layout.host.contains(top.host)); assert.ok(layout.host.contains(changes.host));
      });
      menu(view, '关闭全部标签页');
      check(`${kind} split close-all still releases the protected group when nothing is retained`, () => {
        assert.equal(surfaces.secondaryTabs().length, 0); assert.equal(layout.disposed, true);
        assert.equal(top.disposed, true); assert.equal(changes.disposed, true);
      });
    }
    classic.openSplit(); await tick();
    const browserLayout = surfaces.secondarySurfaceInstance('browser-changes-split');
    const sharedLayout = openSplitWorkbench({ specsOptions: { transport: specTransport } }); await tick();
    const sharedChanges = surfaces.secondarySurfaceInstance('changes');
    menu(sharedLayout.view, '关闭其它标签页');
    check('closing an alternate split returns no shared host away from the retained layout', () => {
      assert.equal(browserLayout.disposed, true); assert.equal(sharedLayout.isCurrent(), true);
      assert.equal(sharedChanges.isCurrent(), true); assert.ok(sharedLayout.host.contains(sharedChanges.host));
      assert.deepEqual(surfaces.secondaryTabs().map(tab => tab.view).sort(), ['changes', 'specs', 'workbench-split']);
    });
    empty();

    const { openFilesPanel } = await import('../../public/files-panel.js');
    const oldFilesTool = surfaces.secondaryTools().find(tool => tool.id === 'files');
    const filesOptions = { getIdentity: () => ({ cwd: '/fixture/readonly', sessionId: 'files-session', conversationId: null }),
      transport: { list: async () => ({ ok: true, workspace: { id: 'files-workspace', generation: '1' }, entries: [] }) } };
    surfaces.registerSecondaryTool({ id: 'files', label: '文件', icon: 'folder', open: () => openFilesPanel(filesOptions) });
    try {
      for (const pressed of ['Enter', ' ']) {
        surfaces.newSecondaryLauncher(); await tick();
        const row = document.querySelector('.work-tools-surface:not([hidden]) [data-tool="files"]');
        row.focus(); key(row, pressed); await tick();
        const files = surfaces.secondarySurfaceInstance('files');
        check(`real Files Launcher ${JSON.stringify(pressed)} conversion has a visible focused successor`, () => {
          assert.ok(files.host.querySelector('.files-preview'));
          assert.equal(document.activeElement, tabButton('files')); assert.equal(document.activeElement.closest('[hidden]'), null);
        });
        surfaces.newSecondaryLauncher(); await tick();
        const reuse = document.querySelector('.work-tools-surface:not([hidden]) [data-tool="files"]');
        reuse.focus(); key(reuse, pressed); await tick();
        check(`real Files Launcher ${JSON.stringify(pressed)} singleton reuse leaves no hidden trigger focused`, () => {
          assert.equal(surfaces.secondarySurfaceInstance('files'), files);
          assert.equal(document.activeElement, tabButton('files')); assert.equal(document.activeElement.closest('[hidden]'), null);
        });
        empty();
      }
      surfaces.openSecondaryTool('files'); surfaces.openSecondaryTool('specs');
      remountScope(); surfaces.showSecondaryPane();
      check('real Files restored lazy descriptor receives Home focus on its first mount', () => {
        assert.equal(surfaces.secondaryTabs().find(tab => tab.view === 'files').mounted, false);
        const prior = tabButton('specs'); prior.focus(); key(prior, 'Home');
        assert.ok(surfaces.secondarySurfaceInstance('files').host.querySelector('.files-preview'));
        assert.equal(document.activeElement, tabButton('files'));
        assert.equal(document.activeElement.getAttribute('aria-selected'), 'true');
        key(document.activeElement, 'ArrowRight'); assert.equal(document.activeElement, tabButton('specs'));
      });
      empty();
      const composer = document.getElementById('input'); composer.focus(); openFilesPanel(filesOptions);
      check('real Files programmatic creation does not steal unrelated input focus', () => assert.equal(document.activeElement, composer));
    } finally { empty(); surfaces.registerSecondaryTool(oldFilesTool); }
  } finally { empty(); global.fetch = previousFetch; Object.assign(S, savedState); }
};
