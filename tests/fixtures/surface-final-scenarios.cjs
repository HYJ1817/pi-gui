'use strict';
// Production renderer/native owners with trusted input; not a visual mock.
module.exports = async function (t, group) {
  const { webContents } = require('electron');
  const { check, read, until, shot, click, key, type, open, sleep, win, notes } = t;
  const manager = code => read(`import('/ui/secondary-surface.js').then(m=>${code})`);
  const select = view => `.work-surface-tab[data-surface="${view}"] .work-surface-tab-select`;
  const newTool = async tool => { await click('#workPanelNew'); await click(`.work-tools-surface:not([hidden]) .work-panel-launcher-row[data-tool="${tool}"]`); };
  await group('surface-launcher', async () => {
    await manager('m.secondaryTabs().forEach(tab=>m.closeSecondarySurface(tab.id))');
    await click('#btnWorkPanel');
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
    await click('.work-tools-surface:not([hidden]) .work-panel-launcher-row[data-tool="specs"]'); await click('#workPanelNew');
    await key('Down');
    check('Launcher arrow navigation stays in a real enabled tool row', await read("document.activeElement.matches('.work-panel-launcher-row:not(:disabled)')"));
    await key('Escape');
    check('Launcher Escape hides panel without deleting its tabs', await read("document.querySelector('#rightPane').hidden") && await manager('m.secondaryTabs().length>=2'));
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
    const server = http.createServer((_request, response) => { browserRequests++; response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><title>Offline Browser state</title><h1>Native Browser fixture</h1><input aria-label="Browser draft" style="width:260px;height:40px;margin:20px">'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
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
    await click('#btnWorkPanel'); await click('#workPanelNew'); await click('#workPanelNew');
    check('independent Launcher tabs coexist', await manager("m.secondaryTabs().filter(tab=>tab.view==='work-tools').length===3"));
    const ids = await manager('m.secondaryTabs().map(tab=>tab.id)');
    const first = `.work-surface-tab[data-tab-id="${ids[0]}"] .work-surface-tab-select`;
    await click(first); await key('Right', ['alt', 'shift']);
    check('trusted keyboard reorders outer Surface tabs without changing their identities', await manager(`JSON.stringify(m.secondaryTabs().map(tab=>tab.id))===${JSON.stringify(JSON.stringify([ids[1], ids[0], ids[2]]))}&&m.secondaryTabs().find(tab=>tab.active)?.id===${JSON.stringify(ids[0])}`));
    await key('Left', ['alt', 'shift']);
    check('reverse Surface reorder restores the original ordered descriptor set', await manager(`JSON.stringify(m.secondaryTabs().map(tab=>tab.id))===${JSON.stringify(JSON.stringify(ids))}`));
    await click(first); await key('Right');
    check('Surface arrow key activates next real tab and roving focus', await read(`document.activeElement.closest('[data-tab-id]')?.dataset.tabId===${JSON.stringify(ids[1])}&&document.activeElement.getAttribute('aria-selected')==='true'`));
    await key('Delete'); check('Delete closes the focused Surface tab', await manager('m.secondaryTabs().length===2'));
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
    await click('#btnWorkPanel');
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
