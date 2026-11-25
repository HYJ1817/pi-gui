'use strict';
// Production renderer/native owners with trusted input; not a visual mock.
module.exports = async function (t, group) {
  const { webContents } = require('electron');
  const { check, read, until, shot, click, key, type, open, sleep, win, notes } = t;
  const manager = code => read(`import('/ui/secondary-surface.js').then(m=>${code})`);
  const select = view => `.work-surface-tab[data-surface="${view}"] .work-surface-tab-select`;
  const newTool = async tool => { await click('#workPanelNew'); await click(`.work-tools-surface:not([hidden]) .work-panel-launcher-row[data-tool="${tool}"]`); };
  /* #btnWorkPanel is a TOGGLE: clicking it while the pane is open HIDES the
   * pane. After close-all the pane is already open with the tabless empty-state
   * Launcher (the F3 contract), so driving the toggle is inherently
   * order-dependent. This helper is idempotent: it only invokes the toggle when
   * the pane is actually closed, then waits for the Launcher to be visible. */
  const ensurePaneOpen = async () => {
    if (await read("document.querySelector('#rightPane').hidden")) await click('#btnWorkPanel');
    await until(() => read("document.querySelector('#rightPane').hidden===false"), 'pane-open');
  };
  await group('surface-launcher', async () => {
    await manager('m.secondaryTabs().forEach(tab=>m.closeSecondarySurface(tab.id))');
    /* Close-all leaves the pane OPEN with the tabless empty-state Launcher (F3).
     * A bare #btnWorkPanel click here would hide it; ensure-open is idempotent. */
    await ensurePaneOpen();
    await until(() => read("!!document.querySelector('.work-panel-launcher-list')"), 'surface-launcher');
    check('old permanent tool icons and card-grid navigation are completely absent', await read("!document.querySelector('#navChanges,#btnTerminal,#btnFiles,#btnSpecs,#btnTree,#btnBrowser,#btnCollab,#workPanelHome,.work-panel-launcher-grid,.work-panel-launcher-more,.work-panel-tool-strip')"));
    for (const width of [1320, 700]) for (const theme of ['dark', 'light']) {
      win.setContentSize(width, width === 700 ? 600 : 820);
      await read(`import('/theme.js').then(m=>m.setThemePreference(${JSON.stringify(theme)}))`); await sleep(180);
      const measure = await read("(()=>{const e=document.querySelector('.work-panel-launcher-list'),r=e.getBoundingClientRect(),p=e.closest('.rp-body').getBoundingClientRect(),rows=[...e.querySelectorAll('button')].map(x=>{const b=x.getBoundingClientRect(),s=getComputedStyle(x);return{x:b.x,width:b.width,height:b.height,border:s.borderWidth,bg:s.backgroundColor,icon:!!x.querySelector('svg'),label:!!x.querySelector('.work-panel-launcher-label')}});return{centerOffset:Math.abs((r.left+r.right-p.left-p.right)/2),within:r.top>=p.top&&r.bottom<=p.bottom&&r.left>=p.left&&r.right<=p.right,overflow:document.documentElement.scrollWidth-innerWidth,rows}})()");
      check(`centered compact single-column real Launcher ${width}-${theme}`, measure.within && measure.centerOffset < 3 && measure.overflow <= 1 && measure.rows.length >= 5 && measure.rows.every(row => row.icon && row.label && row.height <= 44 && Math.abs(row.x - measure.rows[0].x) < 1), measure);
      await shot(`surface-launcher-${width}-${theme}`);
    }
    win.setContentSize(1320, 820);
    /* A single trusted click is an asynchronous input event that can occasionally
     * miss its target (the row may still be settling after the geometry-measurement
     * window resizing above), and openSecondarySurface only runs when the click
     * actually lands on the row. Retry the click until the specs tab exists so the
     * escape count below is evidence about the product, not about input timing.
     * openSecondarySurface is idempotent for an already-open singleton, so a
     * redundant click is harmless. */
    {
      const specsRow = '.work-tools-surface:not([hidden]) .work-panel-launcher-row[data-tool="specs"]';
      const deadline = Date.now() + 15000;
      let opened = false;
      while (Date.now() < deadline && !opened) {
        if (await read(`!!document.querySelector(${JSON.stringify(specsRow)})`)) await click(specsRow);
        opened = await manager("m.secondaryTabs().some(t=>t.view==='specs')");
        if (!opened) await sleep(120);
      }
      if (!opened) throw Object.assign(Error('qualification timeout'), { testLabel: 'specs-opened' });
    }
    notes.push({ kind: 'escape-probe-after-specs-click', tabs: await manager('m.secondaryTabs()') });
    await click('#workPanelNew');
    notes.push({ kind: 'escape-probe-after-plus', tabs: await manager('m.secondaryTabs()') });
    await key('Down');
    check('Launcher arrow navigation stays in a real enabled tool row', await read("document.activeElement.matches('.work-panel-launcher-row:not(:disabled)')"));
    await key('Escape');
    const escapeState = { paneHidden: await read("document.querySelector('#rightPane').hidden"), tabCount: await manager('m.secondaryTabs().length') };
    notes.push({ kind: 'escape-probe-final', ...escapeState, tabs: await manager('m.secondaryTabs()') });
    check('Launcher Escape hides panel without deleting its tabs', escapeState.paneHidden && escapeState.tabCount >= 2, escapeState);
    await click('#btnWorkPanel'); await click('#workPanelNew');
    await key('F');
    check('Launcher type-ahead focuses Files without opening it prematurely', await read("document.activeElement.matches('.work-panel-launcher-row[data-tool=files]')"));
    await key('Return');
    await until(() => read("!!document.querySelector('.files-surface:not([hidden])')"), 'launcher-letter-files');
    check('focused Launcher letter opens singleton Files through registered owner', await manager('m.secondaryTabs().filter(tab=>tab.view==="files").length===1'));
    const focusInFiles = () => read("(()=>{const e=document.activeElement;return !!e&&e!==document.body&&!e.closest('[hidden],[inert]')&&(e.matches('.work-surface-tab[data-surface=files] .work-surface-tab-select')||!!e.closest('.files-surface:not([hidden])'))})()");
    check('trusted Launcher keyboard conversion hands focus to visible Files successor', await focusInFiles());
    await shot('surface-launcher-keyboard-files-focus');
    await click('#workPanelNew'); await key('F'); await key('Return');
    check('trusted Launcher singleton reuse does not leave focus in hidden Launcher', await focusInFiles() && await manager('m.secondaryTabs().filter(tab=>tab.view==="files").length===1'));
  });
  await group('surface-lifecycle', async () => {
    await open('long-lines.js', '.fp-text-line');
    const beforeCount = await manager('m.secondaryTabs().length');
    await click('#workPanelNew');
    check('plus creates an independent blank tab without replacing Files', await manager(`m.secondaryTabs().length===${beforeCount + 1}&&m.secondaryTabs().some(tab=>tab.view==='files')&&m.secondaryTabs().find(tab=>tab.active)?.view==='work-tools'`));
    await click('.work-tools-surface:not([hidden]) .work-panel-launcher-row[data-tool="changes"]');
    check('tool choice converts only its blank Launcher', await manager(`m.secondaryTabs().length===${beforeCount + 1}&&m.secondaryTabs().find(tab=>tab.active)?.view==='changes'`));
    await click(select('files'));
    await until(() => read("!!document.querySelector('.fp-text-line')&&!document.querySelector('.fp-loading')"), 'surface-files-return');
    const innerCount = await read("document.querySelectorAll('.files-tab').length");
    await manager("(m.openSecondaryTool('files'),true)");
    check('singleton reuse preserves independent Files internal file tabs', await manager('m.secondaryTabs().filter(tab=>tab.view==="files").length===1') && await read(`document.querySelectorAll('.files-tab').length===${innerCount}`));
    await newTool('terminal');
    await until(() => read("!!document.querySelector('.terminal-tablist')"), 'terminal-owner');
    if (!await read("!!document.querySelector('.terminal-tab')")) await click('.terminal-new');
    await until(() => read("!!document.querySelector('.terminal-tab[data-terminal-id]')&&!!document.querySelector('.xterm')"), 'real-pty', 25000);
    const terminalId = await read("document.querySelector('.terminal-tab').dataset.terminalId");
    await shot('surface-terminal-live');
    await click(select('files')); await sleep(250); await click(select('terminal'));
    check('switching Surface keeps the same live PTY owner and terminal DOM', await read(`document.querySelector('.terminal-tab')?.dataset.terminalId===${JSON.stringify(terminalId)}&&!!document.querySelector('.xterm')`));
    await newTool('browser');
    await until(() => read("!!document.querySelector('#browserAddress')"), 'native-browser-toolbar');
    const http = require('node:http');
    // This is ordinary Browser content, not a replacement application renderer.
    let browserRequests = 0;
    /* Chromium refuses to navigate to its restricted "unsafe ports" list
     * (ERR_UNSAFE_PORT) — e.g. 4045 (lockd). Binding to port 0 lets the OS pick
     * any ephemeral port, so a run can randomly land on a blocked one and fail
     * for environmental reasons unrelated to the product. Rebind until the
     * assigned port is not in Chromium's restricted set. The list below is the
     * subset of well-known blocked ports that overlap the IANA ephemeral range;
     * the classic low-numbered ones (21, 23, 25, ...) can never be assigned by
     * the OS ephemeral picker, but the mid-range ones can. */
    const chromiumBlocked = new Set([1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697]);
    const makeServer = () => http.createServer((_request, response) => { browserRequests++; response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><title>Offline Browser state</title><h1>Native Browser fixture</h1><input aria-label="Browser draft" style="width:260px;height:40px;margin:20px">'); });
    let server, port;
    for (let attempt = 0; attempt < 16; attempt++) {
      server = makeServer();
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
      if (!chromiumBlocked.has(port)) break;
      await new Promise(resolve => server.close(resolve));
      server = null;
    }
    if (!server) throw new Error('could not bind a Chromium-safe ephemeral port');
    const url = `http://127.0.0.1:${port}/`;
    try {
      await type('#browserAddress', url); await key('Return');
      let browser;
      try {
        await until(() => { browser = webContents.getAllWebContents().find(item => item.getURL() === url); return browser && !browser.isLoading(); }, 'native-browser-load', 20000);
      } catch (error) {
        let direct = null;
        try { direct = await read(`(async()=>{const open=await window.piGuiDesktop.browser.open();const nav=await window.piGuiDesktop.browser.navigate(${JSON.stringify(url)});return{open,nav}})()`); }
        catch (probe) { direct = { probeError: probe?.message || 'probe-failed' }; }
        notes.push({ kind: 'native-browser-load-failure', requests: browserRequests, direct,
          pane: await read("(()=>{const e=document.querySelector('#browserError');return{errorHidden:e?.hidden??null,errorText:e?.textContent??'',address:document.querySelector('#browserAddress')?.value??'',reload:document.querySelector('#browserReload')?.getAttribute('aria-label')??''}})()"),
          addressMatchesTarget: await read(`document.querySelector('#browserAddress')?.value===${JSON.stringify(url)}`),
          contents: webContents.getAllWebContents().map(item => ({ id: item.id, type: item.getType(), target: item.getURL() === url, blank: !item.getURL() || item.getURL() === 'about:blank', loading: item.isLoading() })),
          children: win.contentView.children.map(view => ({ id: view.webContents?.id || null, bounds: view.getBounds() })) });
        throw error;
      }
      const point = await browser.executeJavaScript("(()=>{const r=document.querySelector('input').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
      // A child WebContentsView does not hold window focus just because its page
      // loaded. Focus the real view, let the trusted click land on the input,
      // and only then insert text — otherwise the typing goes nowhere.
      browser.focus();
      browser.sendInputEvent({type:'mouseMove',...point});
      browser.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point}); browser.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
      await until(() => browser.executeJavaScript("document.activeElement===document.querySelector('input')"), 'browser-input-focused');
      await browser.insertText('保留 Browser draft');
      await until(() => browser.executeJavaScript("document.querySelector('input').value==='保留 Browser draft'"), 'browser-input-typed');
      const browserId = browser.id;
      await click(select('files')); await click(select('changes')); await click(select('browser'));
      await until(() => read("!!document.querySelector('#browserAddress')&&!document.querySelector('#browserAddress').closest('[hidden]')"), 'browser-visible-again');
      check('Browser switch preserves native instance, URL and typed form state', !browser.isDestroyed() && browser.id === browserId && browser.getURL() === url && await browser.executeJavaScript("document.querySelector('input').value==='保留 Browser draft'"));
      let nativeView;
      await until(() => {
        nativeView = win.contentView.children.find(view => view.webContents?.id === browserId);
        const bounds = nativeView?.getBounds();
        return bounds && bounds.width > 0 && bounds.height > 0;
      }, 'browser-native-reattached');
      check('returning Browser reattaches its original native view with nonzero bounds', !!nativeView);
      // BrowserWindow capture omits child WebContentsView pixels. Keep the real
      // native capture separately; never composite a fake application screenshot.
      const nativeCapture = await browser.capturePage();
      check('restored native Browser produces actual rendered pixels', !nativeCapture.isEmpty());
      t.fs.writeFileSync(t.path.join(t.out, 'surface-browser-native-restored.png'), nativeCapture.toPNG());
      t.screenshots.push('surface-browser-native-restored.png');
      notes.push({ kind: 'native-browser-capture', bounds: nativeView.getBounds(), separateChildCapture: true });
      await shot('surface-browser-restored');
      await click('.work-surface-tab[data-surface="browser"] .work-surface-tab-close');
      await until(() => browser.isDestroyed(), 'browser-owner-closed');
      check('closing Browser destroys its native resource instead of merely hiding it', browser.isDestroyed());
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await click(select('files'));
    await until(() => read("!!document.querySelector('.fp-text-line')"), 'files-still-live');
    const fileTabs = await read("document.querySelectorAll('.files-tab').length");
    await click('#workPanelClose'); await click('#btnWorkPanel');
    await until(() => read("!!document.querySelector('.fp-text-line')&&!document.querySelector('.fp-loading')"), 'hide-show-files');
    check('panel hide/show preserves Files tabs and restores its preview', await read(`document.querySelectorAll('.files-tab').length===${fileTabs}`));
    const width = await read("document.querySelector('#rightPane').getBoundingClientRect().width");
    await click('#workPanelMaximize');
    check('common maximize retains chat DOM but makes it inert', await read("document.querySelector('#rightPane').dataset.maximized==='true'&&!!document.querySelector('#input')&&document.querySelector('#input').closest('[inert]')!==null"));
    await shot('surface-files-right-tree-maximized'); await click('#workPanelMaximize');
    check('common restore returns the saved normal panel width', Math.abs(width - await read("document.querySelector('#rightPane').getBoundingClientRect().width")) < 2);
    await shot('surface-multiple-live-tabs');
    notes.push({kind:'surface-owner-continuity', terminalIdentityPreserved:true, browserIdentityPreserved:true, fileTabCount:fileTabs});
  });
  await group('surface-tab-operations', async () => {
    // Keep the tools above alive until this explicit close-all boundary.
    await click(select('files')); await key('F10', ['shift']); await key('End'); await key('Return');
    await until(() => manager('m.secondaryTabs().length===0'), 'surface-close-all');
    // Boundary diagnostics: the exact state the close-all contract leaves behind.
    notes.push({ kind: 'surface-close-all-state', paneHidden: await read("document.querySelector('#rightPane')?.hidden"),
      launcherRows: await read("document.querySelectorAll('.work-panel-launcher-row').length"),
      emptyStatePresent: await read("!!document.querySelector('.rp-body > .work-tools-surface')") });
    /* After close-all the pane is already open with the tabless empty-state
     * Launcher (the F3 contract). #btnWorkPanel is a toggle — clicking it here
     * would HIDE the pane, not show it. Whether the pane is open at this point
     * depends on which Launcher path the earlier Escape took, so driving the
     * toggle is inherently order-dependent. Instead assert the F3 empty-state
     * contract directly, then use the pane's own explicit controls. */
    check('close-all leaves the pane open with the tabless empty-state Launcher',
      await read("document.querySelector('#rightPane').hidden===false")
        && await manager('m.secondaryTabs().length===0')
        && await read("!!document.querySelector('.rp-body > .work-tools-surface .work-panel-launcher-list')"),
      { paneHidden: await read("document.querySelector('#rightPane')?.hidden"), launcherRows: await read("document.querySelectorAll('.work-panel-launcher-row').length") });
    await click('#workPanelNew');
    await click('#workPanelNew');
    /* The tabless empty-state Launcher is NOT a tab record (by design it cannot
     * be closed into itself), so it never appears in secondaryTabs(). close-all
     * leaves 0 tabs; each '+' creates one independent blank Launcher tab, so two
     * clicks yield exactly 2 — not 3. The earlier '3' expectation double-counted
     * the tabless empty state, which the assertion two lines above proves is
     * present yet tab-less. */
    check('independent Launcher tabs coexist', await manager("m.secondaryTabs().filter(tab=>tab.view==='work-tools').length===2"));
    const ids = await manager('m.secondaryTabs().map(tab=>tab.id)');
    const first = `.work-surface-tab[data-tab-id="${ids[0]}"] .work-surface-tab-select`;
    await click(first); await key('Right', ['alt', 'shift']);
    check('trusted keyboard reorders outer Surface tabs without changing their identities', await manager(`JSON.stringify(m.secondaryTabs().map(tab=>tab.id))===${JSON.stringify(JSON.stringify([ids[1], ids[0]]))}&&m.secondaryTabs().find(tab=>tab.active)?.id===${JSON.stringify(ids[0])}`));
    await key('Left', ['alt', 'shift']);
    check('reverse Surface reorder restores the original ordered descriptor set', await manager(`JSON.stringify(m.secondaryTabs().map(tab=>tab.id))===${JSON.stringify(JSON.stringify(ids))}`));
    await click(first); await key('Right');
    check('Surface arrow key activates next real tab and roving focus', await read(`document.activeElement.closest('[data-tab-id]')?.dataset.tabId===${JSON.stringify(ids[1])}&&document.activeElement.getAttribute('aria-selected')==='true'`));
    await key('Delete'); check('Delete closes the focused Surface tab', await manager('m.secondaryTabs().length===1'));
    await click('#workPanelNew');
    await click(first); await key('F10', ['shift']); await key('Down'); await key('Down'); await key('Return');
    check('close-right acts on the original ordered tab set', await manager('m.secondaryTabs().length===1'));
    await click('#workPanelNew'); await click('#workPanelNew');
    await key('F10', ['shift']); // Launcher row is focused: select tab before menu.
    await click('.work-surface-tab:last-child .work-surface-tab-select'); await key('F10', ['shift']); await key('Down'); await key('Return');
    check('close-others keeps only its target Surface', await manager('m.secondaryTabs().length===1'));
    await shot('surface-close-others');
  });
  await group('surface-lazy-restore-focus', async () => {
    await manager('m.secondaryTabs().forEach(tab=>m.closeSecondarySurface(tab.id))');
    // Same toggle hazard as above: close-all already left the pane open with
    // the tabless Launcher, and #btnWorkPanel would hide it. The Launcher row
    // is already right there — click it directly.
    await click('.work-tools-surface:not([hidden]) .work-panel-launcher-row[data-tool="files"]');
    await newTool('specs');
    // A real renderer reload exercises persisted descriptors, not an injected
    // tab object. The TEMP project, owner and server are unchanged.
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    await until(() => read("document.querySelector('#connText')?.textContent.includes('已连接')"), 'restore-connected', 30000);
    await until(() => read("import('/state.js').then(({S})=>!!(S.legacyOwner?.workspaceId&&S.legacyOwner?.workspaceEpoch&&S.legacyOwner?.sessionId&&S.legacyOwner?.backendInstance))"), 'restore-current-owner');
    await until(() => manager('m.secondaryTabs().length===2&&m.secondaryTabs().some(tab=>tab.view==="specs")'), 'restored-descriptors');
    check('renderer reload restores Files as a lazy descriptor before first activation', await manager('m.secondaryTabs().find(tab=>tab.view==="files")?.mounted===false'));
    await click(select('specs')); await key('Home');
    await until(() => read("!!document.querySelector('.files-surface:not([hidden])')"), 'restored-files-first-mount');
    check('trusted Home first-mounts restored Files and focuses its selected visible tab', await read("(()=>{const e=document.activeElement;return e.matches('.work-surface-tab[data-surface=files] .work-surface-tab-select')&&e.getAttribute('aria-selected')==='true'&&!e.closest('[hidden],[inert]')})()"));
    await shot('surface-restored-files-keyboard-focus');
  });
};
