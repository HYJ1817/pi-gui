'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { desktopQualification } = require('./desktop-qualification.cjs');
const { renderStaticPreview } = require('./html-preview-static.cjs');
const diagnosticsPath = fs.existsSync(path.join(__dirname, 'html-preview-diagnostics.cjs'))
  ? './html-preview-diagnostics.cjs' : '../lib/html-preview-diagnostics.cjs';
const { validDiagnostics, scriptDiagnostic, resourceReadinessScript } = require(diagnosticsPath);

const CHANNEL = 'html-preview-request';
const RESULT_CHANNEL = 'html-preview-result';
const CANCEL_CHANNEL = 'html-preview-cancel';
const CODES = new Set([
  'html_preview_unavailable', 'html_preview_timeout', 'html_cancelled',
  'html_preview_busy', 'html_preview_failed',
]);
const LIMITS = Object.freeze({
  htmlBytes: 2 * 1024 * 1024,
  minWidth: 240,
  maxWidth: 1600,
  minHeight: 80,
  maxHeight: 4096,
  pngBytes: 3 * 1024 * 1024,
  consoleEntries: 20,
  diagnosticEntries: 20,
  totalMs: 30_000,
  renderMs: 15_000,
  queueLength: 2,
  imageFontWaitMs: 5_000,
  layoutSettleMs: 3_000,
  cleanupWaitMs: 1_000,
});
const PREVIEW_FRAME_NAME = 'pi-gui-html-preview-frame';
const RTC_PROBE_BLANK_NAME = 'pi-gui-preview-rtc-blank';
const RTC_PROBE_SRCDOC_NAME = 'pi-gui-preview-rtc-srcdoc';
const RTC_PROBE_NESTED_NAME = 'pi-gui-preview-rtc-nested-srcdoc';
const RTC_SURFACE = Object.freeze([
  'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription',
  'RTCIceCandidate', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport',
  'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'WebTransport',
]);
const HOST_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'self' about: data:; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; media-src 'none'; manifest-src 'none'";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateRequest(message) {
  if (!object(message) || message.type !== CHANNEL || !Number.isSafeInteger(message.id) || message.id < 1) return null;
  const allowed = new Set(['type', 'id', 'html', 'width', 'height', 'theme']);
  if (Object.keys(message).some(key => !allowed.has(key))) return null;
  if (typeof message.html !== 'string' || !message.html.length || Buffer.byteLength(message.html, 'utf8') > LIMITS.htmlBytes) return null;
  const width = message.width === undefined ? 800 : message.width;
  const height = message.height === undefined ? 600 : message.height;
  const theme = message.theme === undefined ? 'dark' : message.theme;
  if (!Number.isInteger(width) || width < LIMITS.minWidth || width > LIMITS.maxWidth
    || !Number.isInteger(height) || height < LIMITS.minHeight || height > LIMITS.maxHeight
    || !['light', 'dark'].includes(theme)) return null;
  return { id: message.id, html: message.html, width, height, theme };
}

function isPreviewResult(value) {
  const hasOnly = (item, keys) => object(item) && Object.keys(item).length === keys.length
    && Object.keys(item).every(key => keys.includes(key));
  if (!hasOnly(value, ['schemaVersion', 'ok', 'width', 'height', 'contentWidth', 'contentHeight', 'screenshot', 'diagnostics'])
    || value.schemaVersion !== 1 || value.ok !== true
    || ![value.width, value.height, value.contentWidth, value.contentHeight].every(Number.isFinite)
    || !Number.isInteger(value.width) || !Number.isInteger(value.height)
    || !hasOnly(value.screenshot, ['mimeType', 'data', 'width', 'height']) || value.screenshot.mimeType !== 'image/png'
    || typeof value.screenshot.data !== 'string' || !object(value.diagnostics)) return false;
  if (value.width < LIMITS.minWidth || value.width > LIMITS.maxWidth
    || value.height < 1 || value.height > LIMITS.maxHeight
    || value.screenshot.width !== value.width || value.screenshot.height !== value.height
    || value.contentWidth < 0 || value.contentWidth > 1_000_000
    || value.contentHeight < 0 || value.contentHeight > 1_000_000) return false;
  const encoded = value.screenshot.data;
  if (!encoded.length || encoded.length > Math.ceil(LIMITS.pngBytes / 3) * 4
    || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return false;
  const png = Buffer.from(encoded, 'base64');
  if (png.length < 24 || png.length > LIMITS.pngBytes || png.toString('base64') !== encoded
    || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || png.toString('ascii', 12, 16) !== 'IHDR'
    || png.readUInt32BE(16) !== value.width || png.readUInt32BE(20) !== value.height) return false;
  return validDiagnostics(value.diagnostics);
}

function safeDiagnosticResources(session, resources, errors, staticOnly) {
  const knownTypes = new Set(['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'xhr', 'fetch', 'other']);
  const listener = (details, callback) => {
    const url = typeof details.url === 'string' ? details.url : '';
    const type = knownTypes.has(details.resourceType) ? details.resourceType : 'other';
    // Permit only browser-local wrapper/srcdoc documents and bounded embedded
    // raster/font assets. Never parse or retain an attacker-controlled URL.
    const localDocument = url === 'about:blank' || !staticOnly && url === 'about:srcdoc';
    const inlineAsset = url.length <= LIMITS.htmlBytes && (
      type === 'image' && /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(url)
      || type === 'font' && /^data:(?:font\/(?:woff2?|ttf|otf)|application\/font-woff);base64,/i.test(url));
    if (localDocument || inlineAsset) return callback({ cancel: false });
    if (resources.length < LIMITS.diagnosticEntries) resources.push({ type, outcome: 'blocked' });
    if (errors.length < LIMITS.diagnosticEntries) errors.push({ code: 'resource_blocked', type });
    callback({ cancel: true });
  };
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, listener);
  return () => {
    try { session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, null); }
    catch { /* session is already closing */ }
  };
}

function wrapperDocument(tokensCss, theme, permissions) {
  if (/<\/style/i.test(tokensCss)) throw new Error('unsafe_theme_stylesheet');
  const attach = `function(srcdoc,id,nonce){
    var frame=document.createElement('iframe');
    frame.name=${JSON.stringify(PREVIEW_FRAME_NAME)};
    frame.setAttribute('sandbox','allow-scripts');
    frame.setAttribute('allow',${JSON.stringify(permissions)});
    frame.setAttribute('title','HTML preview');
    frame.style.cssText='display:block;border:0;width:100%;height:100%;';
    var state={ready:false,resize:null,updatedAt:Date.now(),messages:0};
    window.__piGuiHtmlPreviewState=state;
    window.addEventListener('message',function(event){
      if(event.source!==frame.contentWindow||event.origin!=='null')return;
      var value=event.data;
      if(!value||typeof value!=='object'||Array.isArray(value)||value.schemaVersion!==1||value.id!==id||value.nonce!==nonce)return;
      if(value.type==='ready'){state.ready=true;state.updatedAt=Date.now();state.messages++;return;}
      if(value.type!=='resize'||!Number.isFinite(value.height)||!Number.isFinite(value.naturalHeight)||!Number.isFinite(value.naturalWidth))return;
      state.resize={height:Math.max(80,Math.min(4096,Math.ceil(value.height))),naturalHeight:Math.max(0,Math.min(1000000,Math.ceil(value.naturalHeight))),naturalWidth:Math.max(0,Math.min(1000000,Math.ceil(value.naturalWidth))),feedback:value.feedback===true,capped:value.capped===true};
      state.updatedAt=Date.now();state.messages++;
    });
    frame.srcdoc=srcdoc;
    document.body.appendChild(frame);
    return true;
  }`;
  return '<!doctype html><html data-theme="' + theme + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + HOST_CSP + '">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>' + tokensCss + '</style>'
    + '<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:var(--ds-bg-primary);color:var(--ds-text-primary)}body{position:relative}iframe{position:absolute;inset:0}</style>'
    + '<script>window.__piGuiHtmlPreviewAttach=(' + attach + ');</script></head><body></body></html>';
}

function jsLiteral(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
}

async function loadModules(root) {
  const framePath = path.join(root, 'public', 'html-artifact-frame.js');
  const themePath = path.join(root, 'public', 'html-artifact-theme.js');
  const frame = await import(pathToFileURL(framePath).href);
  const theme = await import(pathToFileURL(themePath).href);
  const stylesheet = path.join(root, 'public', 'tokens.css');
  const stat = fs.statSync(stylesheet);
  if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('theme_stylesheet_unavailable');
  const tokensCss = fs.readFileSync(stylesheet, 'utf8');
  if (/<\/style/i.test(tokensCss)) throw new Error('unsafe_theme_stylesheet');
  return { frame, theme, tokensCss };
}

function themeSnapshot(webContents, modules, appearance) {
  const tokens = [...new Set([...Object.values(modules.theme.HTML_ARTIFACT_THEME_TOKENS), '--font-scale'])];
  const expression = `(()=>{const s=getComputedStyle(document.documentElement),out={};for(const key of ${jsLiteral(tokens)})out[key]=s.getPropertyValue(key).trim();return out})()`;
  return webContents.executeJavaScript(expression).then(raw => modules.theme.readHtmlArtifactTheme({
    defaultView: { getComputedStyle: () => ({ getPropertyValue: key => raw?.[key] ?? '' }) },
    documentElement: { dataset: { theme: appearance } },
  }));
}

async function qualifyNativeRtcIsolation(webContents, task) {
  const names = JSON.stringify([RTC_PROBE_BLANK_NAME, RTC_PROBE_SRCDOC_NAME]);
  const nestedHtml = '<!doctype html><script>window.__piGuiPreviewNestedRtcProbe=true;</script>';
  // Escape the embedded close tag from the outer srcdoc script tokenizer; the
  // JS string parser restores it before assigning the nested srcdoc document.
  const nestedHtmlLiteral = jsLiteral(nestedHtml);
  const probeScript = `(()=>{
    window.__piGuiPreviewRtcProbe=true;
    const nested=document.createElement('iframe');nested.name=${JSON.stringify(RTC_PROBE_NESTED_NAME)};
    nested.setAttribute('sandbox','allow-scripts');nested.srcdoc=${nestedHtmlLiteral};document.body.append(nested);
  })()`;
  const probeDocument = '<!doctype html><body><script>' + probeScript + '</script></body>';
  const probeDocumentLiteral = jsLiteral(probeDocument);
  await webContents.executeJavaScript(`(()=>{
    const names=${names};
    const blank=document.createElement('iframe');blank.name=names[0];blank.src='about:blank';
    const srcdoc=document.createElement('iframe');srcdoc.name=names[1];srcdoc.setAttribute('sandbox','allow-scripts');
    srcdoc.srcdoc=${probeDocumentLiteral};
    document.body.append(blank,srcdoc);return true;
  })()`);
  const expression = `(()=>{const out={};for(const key of ${JSON.stringify(RTC_SURFACE)})out[key]=typeof window[key];out.outerScriptRan=window.__piGuiPreviewRtcProbe===true;out.nestedScriptRan=window.__piGuiPreviewNestedRtcProbe===true;return out})()`;
  const deadline = Date.now() + 2_000;
  let blankOk = false, srcdocOk = false, nestedOk = false;
  while (Date.now() < deadline) {
    if (task.signal.aborted) throw Object.assign(new Error('cancelled'), { code: task.cancelCode || 'html_cancelled' });
    const frames = webContents.mainFrame?.framesInSubtree || [];
    const blank = frames.find(frame => frame.name === RTC_PROBE_BLANK_NAME && frame.url === 'about:blank');
    const srcdoc = frames.find(frame => frame.name === RTC_PROBE_SRCDOC_NAME && frame.url === 'about:srcdoc');
    const nested = frames.find(frame => frame.name === RTC_PROBE_NESTED_NAME && frame.url === 'about:srcdoc');
    try {
      if (blank) {
        const surface = await blank.executeJavaScript(expression);
        if (RTC_SURFACE.some(key => surface[key] !== 'undefined')) throw new Error('native_rtc_available');
        blankOk = true;
      }
      if (srcdoc) {
        const surface = await srcdoc.executeJavaScript(expression);
        if (RTC_SURFACE.some(key => surface[key] !== 'undefined')) throw new Error('native_rtc_available');
        srcdocOk = surface.outerScriptRan === true;
      }
      if (nested) {
        const surface = await nested.executeJavaScript(expression);
        if (RTC_SURFACE.some(key => surface[key] !== 'undefined')) throw new Error('native_rtc_available');
        nestedOk = surface.nestedScriptRan === true;
      }
      if (blankOk && srcdocOk && nestedOk) {
        await webContents.executeJavaScript(`(()=>{document.querySelector('iframe[name=${JSON.stringify(RTC_PROBE_BLANK_NAME)}]')?.remove();document.querySelector('iframe[name=${JSON.stringify(RTC_PROBE_SRCDOC_NAME)}]')?.remove();return true})()`);
        return;
      }
    } catch (error) {
      if (error?.message === 'native_rtc_available') throw Object.assign(new Error('native_rtc_available'), { code: 'html_preview_unavailable' });
    }
    await delay(35);
  }
  throw Object.assign(new Error('native_rtc_qualification_failed'), { code: 'html_preview_unavailable' });
}

function createDiagnostics() {
  return { console: [], errors: [], resources: [], warnings: [] };
}

function normalizeConsoleLevel(level) {
  if (level === 1 || level === 'info') return 'info';
  if (level === 2 || level === 'warning' || level === 'warn') return 'warning';
  if (level === 3 || level === 'error') return 'error';
  return 'log';
}

function addBounded(list, item, maximum = LIMITS.diagnosticEntries) {
  if (list.length < maximum) list.push(item);
}

async function renderInWindow(task, { BrowserWindow, session, root, hasSwitch, argv, execArgv, env,
  cleanupWaitMs = LIMITS.cleanupWaitMs, staticOnly = false }) {
  let win = null, previewSession = null, onError = null, removeRequestGuard = null;
  let permissionRequest = null, permissionCheck = null, willDownload = null;
  const diagnostics = createDiagnostics();
  const windowSet = task.setWindow;
  const rootPath = root || path.resolve(__dirname, '..');
  const abortRender = () => {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* already closing */ }
  };
  task.abortRender = abortRender;
  const throwIfAborted = () => {
    if (task.signal.aborted) throw Object.assign(new Error('cancelled'), { code: task.cancelCode || 'html_cancelled' });
  };
  try {
    throwIfAborted();
    const environment = { argv, execArgv, env, hasSwitch: name => hasSwitch(name) !== false, backendConnected: true };
    const unsafeSwitches = ['disable-setuid-sandbox', 'disable-seccomp-filter-sandbox', 'disable-site-isolation-trials'];
    if (!desktopQualification(environment).ok || unsafeSwitches.some(name => {
      try { return hasSwitch(name) !== false || [...argv, ...execArgv].some(value => value === `--${name}` || value.startsWith(`--${name}=`)); }
      catch { return true; }
    })) throw Object.assign(new Error('unsafe_preview_environment'), { code: 'html_preview_unavailable' });
    if (typeof BrowserWindow !== 'function' || typeof session?.fromPartition !== 'function') {
      throw Object.assign(new Error('missing_preview_runtime'), { code: 'html_preview_unavailable' });
    }
    const modules = await loadModules(rootPath);
    throwIfAborted();
    const partition = `pi-gui-html-preview-${crypto.randomBytes(16).toString('hex')}`;
    previewSession = session.fromPartition(partition, { cache: false }); // No persist: private to this task.
    task.registerSession(previewSession);
    permissionRequest = (_contents, _permission, callback) => callback(false);
    permissionCheck = () => false;
    willDownload = event => event.preventDefault();
    previewSession.setPermissionRequestHandler(permissionRequest);
    previewSession.setPermissionCheckHandler(permissionCheck);
    previewSession.on('will-download', willDownload);
    removeRequestGuard = safeDiagnosticResources(previewSession, diagnostics.resources, diagnostics.errors, staticOnly);

    win = new BrowserWindow({
      show: false,
      width: task.request.width,
      height: task.request.height,
      useContentSize: true,
      frame: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: true,
      backgroundColor: task.request.theme === 'dark' ? '#17191d' : '#ffffff',
      webPreferences: {
        partition,
        sandbox: true,
        webSecurity: true,
        contextIsolation: true,
        javascript: !staticOnly,
        offscreen: staticOnly,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        devTools: false,
      },
    });
    windowSet(win);
    const prefs = win.webContents.getLastWebPreferences();
    if (prefs.sandbox !== true || prefs.webSecurity !== true || prefs.contextIsolation !== true
      || prefs.javascript !== !staticOnly
      || prefs.nodeIntegration !== false || prefs.nodeIntegrationInSubFrames !== false
      || prefs.nodeIntegrationInWorker !== false || prefs.webviewTag !== false
      || prefs.allowRunningInsecureContent !== false) {
      throw Object.assign(new Error('unsafe_preview_preferences'), { code: 'html_preview_unavailable' });
    }
    win.setMenu?.(null);
    win.webContents.setAudioMuted?.(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    let qualifying = !staticOnly;
    let initialPreview = !staticOnly;
    win.webContents.on('will-frame-navigate', event => {
      if (qualifying && !event.isMainFrame && ['about:blank', 'about:srcdoc'].includes(event.url)) return;
      if (initialPreview && !event.isMainFrame && event.url === 'about:srcdoc'
        && event.frame?.name === PREVIEW_FRAME_NAME && event.initiator === win.webContents.mainFrame) {
        initialPreview = false;
        return;
      }
      event.preventDefault();
    });
    win.webContents.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame) => {
      if (!qualifying && !isMainFrame && url === 'about:srcdoc') initialPreview = false;
    });
    win.webContents.on('will-redirect', event => event.preventDefault());
    win.webContents.on('will-prevent-unload', event => event.preventDefault());
    win.webContents.on('console-message', event => {
      // Only closed, generated descriptions enter private model feedback. Raw
      // console arguments, source URLs and stacks never leave this listener.
      const level = normalizeConsoleLevel(event.level);
      addBounded(diagnostics.console, { level, text: 'console_message' }, LIMITS.consoleEntries);
      const error = level === 'error' && scriptDiagnostic(event.message, event.lineNumber, event.sourceId);
      if (error) addBounded(diagnostics.errors, error);
    });
    win.webContents.on('did-fail-load', (_event, errorCode) => {
      if (errorCode !== -3) addBounded(diagnostics.errors, { code: 'document_load_failed' });
    });
    onError = details => {
      const type = ['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'xhr', 'fetch'].includes(details?.resourceType)
        ? details.resourceType : 'other';
      addBounded(diagnostics.errors, { code: 'resource_load_failed', type });
    };
    previewSession.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, onError);
    win.webContents.on('render-process-gone', (_event, details) => {
      const reason = ['crashed', 'oom', 'killed', 'launch-failed', 'integrity-failure'].includes(details?.reason)
        ? details.reason : 'gone';
      addBounded(diagnostics.errors, { code: 'render_process_gone', reason });
      task.abort('html_preview_failed');
    });

    await win.loadURL('about:blank');
    if (staticOnly) {
      const { height, width, contentWidth, contentHeight, warnings, errors, data } =
        await renderStaticPreview(win, task.request, modules, LIMITS, task.signal, jsLiteral);
      warnings.forEach(warning => addBounded(diagnostics.warnings, warning));
      errors.forEach(error => addBounded(diagnostics.errors, error));
      return { schemaVersion: 1, ok: true, width, height, contentWidth, contentHeight,
        screenshot: { mimeType: 'image/png', data, width, height }, diagnostics };
    }
    const shell = wrapperDocument(modules.tokensCss, task.request.theme, modules.frame.HTML_ARTIFACT_PERMISSIONS);
    await win.webContents.executeJavaScript(`document.open();document.write(${jsLiteral(shell)});document.close();true`);
    await win.webContents.executeJavaScript('document.documentElement.dataset.theme');
    const theme = await themeSnapshot(win.webContents, modules, task.request.theme);
    // Do not trust CSP or the artifact prefix alone for RTC: a newly-created
    // about:blank/srcdoc child can inherit native constructors differently.
    // Probe executable empty documents before the user HTML is even wrapped;
    // any unsupported Chromium build fails closed instead of rendering content.
    await qualifyNativeRtcIsolation(win.webContents, task);
    qualifying = false;
    const id = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    const srcdoc = modules.frame.htmlArtifactDocument(task.request.html, { id, nonce, hostOrigin: '*', theme });
    await win.webContents.executeJavaScript(`window.__piGuiHtmlPreviewAttach(${jsLiteral(srcdoc)},${jsLiteral(id)},${jsLiteral(nonce)})`);

    const renderStart = Date.now();
    let state = null;
    while (Date.now() - renderStart < LIMITS.renderMs) {
      if (task.signal.aborted) throw Object.assign(new Error('cancelled'), { code: task.cancelCode || 'html_cancelled' });
      state = await win.webContents.executeJavaScript('window.__piGuiHtmlPreviewState||null');
      if (state?.ready && state.resize) break;
      await delay(35);
    }
    if (!state?.ready) throw Object.assign(new Error('frame_not_ready'), { code: 'html_preview_timeout' });

    const frame = win.webContents.mainFrame?.framesInSubtree?.find(item =>
      item !== win.webContents.mainFrame && item.name === PREVIEW_FRAME_NAME && item.url === 'about:srcdoc');
    if (!frame || typeof frame.executeJavaScript !== 'function') throw new Error('preview_frame_unavailable');
    const settleScript = resourceReadinessScript();
    const readinessDeadline = Date.now() + LIMITS.imageFontWaitMs;
    let readiness = await frame.executeJavaScript(settleScript);
    while (!readiness.ready && Date.now() < readinessDeadline) {
      throwIfAborted();
      await delay(35);
      readiness = await frame.executeJavaScript(settleScript);
    }
    if (!readiness.ready) addBounded(diagnostics.warnings, 'font_or_image_readiness_timeout');
    if (readiness.missingImages > 0) {
      addBounded(diagnostics.warnings, `${Math.min(999, readiness.missingImages)}_images_unavailable`);
      addBounded(diagnostics.errors, { code: 'image_decode_failed', type: 'image' });
    }
    if (readiness.missingFonts > 0) {
      addBounded(diagnostics.warnings, 'fonts_unavailable');
      addBounded(diagnostics.errors, { code: 'font_load_failed', type: 'font' });
    }

    const settleStart = Date.now();
    let appliedHeight = task.request.height;
    let lastMessageCount = -1, quietSince = Date.now(), layoutStable = false;
    while (Date.now() - settleStart < LIMITS.layoutSettleMs) {
      if (task.signal.aborted) throw Object.assign(new Error('cancelled'), { code: task.cancelCode || 'html_cancelled' });
      state = await win.webContents.executeJavaScript('window.__piGuiHtmlPreviewState||null');
      if (state?.resize) {
        const targetHeight = Math.max(LIMITS.minHeight, Math.min(LIMITS.maxHeight, state.resize.height));
        if (targetHeight !== appliedHeight) {
          win.setContentSize(task.request.width, targetHeight);
          appliedHeight = targetHeight;
          quietSince = Date.now();
        }
        if (state.messages !== lastMessageCount) { lastMessageCount = state.messages; quietSince = Date.now(); }
        if (Date.now() - quietSince >= 180 && targetHeight === appliedHeight) { layoutStable = true; break; }
      }
      await delay(35);
    }
    if (!layoutStable) addBounded(diagnostics.warnings, 'layout_settle_timeout');
    state = await win.webContents.executeJavaScript('window.__piGuiHtmlPreviewState||null');
    if (!state?.resize) throw Object.assign(new Error('preview_layout_unavailable'), { code: 'html_preview_failed' });
    const contentWidth = Math.max(0, Math.min(1_000_000, Math.ceil(state.resize.naturalWidth)));
    const contentHeight = Math.max(0, Math.min(1_000_000, Math.ceil(state.resize.naturalHeight)));
    const captureHeight = Math.max(1, Math.min(LIMITS.maxHeight, state.resize.height));
    if (state.resize.feedback) addBounded(diagnostics.warnings, 'layout_feedback_limited');
    if (contentHeight > captureHeight || state.resize.capped) addBounded(diagnostics.warnings, 'content_height_capped');
    if (contentWidth > task.request.width) addBounded(diagnostics.warnings, 'content_width_overflows_viewport');

    // Capture only the isolated hidden preview window. The image is returned to
    // the requesting backend process and is never written to disk or renderer IPC.
    let image = await win.webContents.capturePage({ x: 0, y: 0, width: task.request.width, height: captureHeight });
    if (image.isEmpty?.()) throw new Error('empty_preview_capture');
    const imageSize = image.getSize();
    if (imageSize.width !== task.request.width || imageSize.height !== captureHeight) {
      image = image.resize({ width: task.request.width, height: captureHeight, quality: 'best' });
    }
    const png = image.toPNG();
    if (!Buffer.isBuffer(png) || png.length < 8 || png.length > LIMITS.pngBytes) throw new Error('preview_png_limit');
    return {
      schemaVersion: 1,
      ok: true,
      width: task.request.width,
      height: captureHeight,
      contentWidth,
      contentHeight,
      screenshot: { mimeType: 'image/png', data: png.toString('base64'), width: task.request.width, height: captureHeight },
      diagnostics,
    };
  } finally {
    if (task.abortRender === abortRender) task.abortRender = null;
    if (win && !win.isDestroyed()) {
      try { win.webContents.close({ waitForBeforeUnload: false }); } catch { /* already gone */ }
      try { win.destroy(); } catch { /* already gone */ }
    }
    windowSet(null);
    if (previewSession) {
      try { removeRequestGuard?.(); } catch { /* session is already closing */ }
      try { previewSession.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, null); } catch { /* listener already removed */ }
      try { previewSession.removeListener?.('will-download', willDownload); } catch { /* no EventEmitter surface */ }
      try { previewSession.setPermissionRequestHandler?.(null); } catch { /* ephemeral session */ }
      try { previewSession.setPermissionCheckHandler?.(null); } catch { /* ephemeral session */ }
      try {
        await Promise.race([
          Promise.allSettled([previewSession.clearCache?.(), previewSession.clearStorageData?.(), previewSession.closeAllConnections?.()]),
          delay(cleanupWaitMs),
        ]);
      } catch { /* ephemeral session */ }
      task.unregisterSession(previewSession);
    }
    void onError;
  }
}

function createHtmlPreviewService({
  BrowserWindow,
  session,
  root = path.resolve(__dirname, '..'),
  hasSwitch = name => require('electron').app.commandLine.hasSwitch(name),
  argv = process.argv,
  execArgv = process.execArgv,
  env = process.env,
  render,
  staticFallback = true,
  maxQueued = LIMITS.queueLength,
  renderTimeoutMs = LIMITS.renderMs,
  totalTimeoutMs = LIMITS.totalMs,
  cleanupWaitMs = LIMITS.cleanupWaitMs,
} = {}) {
  const ownedSessions = new WeakSet();
  const queue = [];
  const children = new Map();
  let active = null;
  let draining = false;
  let disposed = false;
  let nativeIsolationUnavailable = false;

  async function renderTask(task, options) {
    if (render) return render(task, options);
    if (!nativeIsolationUnavailable) {
      try { return await renderInWindow(task, options); }
      catch (error) {
        if (!staticFallback || task.signal.aborted
          || !['native_rtc_available', 'native_rtc_qualification_failed'].includes(error?.message)) throw error;
        nativeIsolationUnavailable = true;
      }
    }
    return renderInWindow(task, { ...options, staticOnly: true });
  }

  function send(child, value) {
    if (!child || child.connected === false || typeof child.send !== 'function') return;
    try { child.send(value, () => {}); } catch { /* child disconnected */ }
  }

  function finish(task, result) {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.totalTimer);
    clearTimeout(task.renderTimer);
    if (task.child?.connected !== false) send(task.child, { type: RESULT_CHANNEL, id: task.request.id, ...result });
  }

  function cancel(task, code, atTotalDeadline = false) {
    if (!task || task.settled) return;
    const safeCode = CODES.has(code) ? code : 'html_preview_failed';
    task.cancelCode = safeCode;
    if (task.state === 'queued') {
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
      task.abortController.abort();
      finish(task, { ok: false, code: safeCode });
      return;
    }
    task.abortController.abort();
    try { task.abortRender?.(safeCode); } catch { /* window destruction is best effort */ }
    task.cancelResolve({ cancelled: true, code: safeCode });
    // Keep cleanup in the queue while honouring the caller's total deadline.
    if (atTotalDeadline) finish(task, { ok: false, code: safeCode });
  }

  async function runTask(task) {
    active = task;
    task.state = 'running';
    task.renderTimer = setTimeout(() => cancel(task, 'html_preview_timeout'), renderTimeoutMs);
    const renderPromise = Promise.resolve().then(() => renderTask(task, {
      BrowserWindow, session, root, cleanupWaitMs, hasSwitch, argv, execArgv, env,
      registerSession: value => { try { ownedSessions.add(value); } catch {} },
      unregisterSession: value => { try { ownedSessions.delete(value); } catch {} },
      setWindow: value => { task.window = value || null; },
    }));
    // Install both handlers before cancellation can win so a later renderer
    // rejection never becomes an unhandled promise rejection.
    renderPromise.catch(() => {});
    try {
      const outcome = await Promise.race([
        renderPromise.then(value => ({ value }), error => ({ error })),
        task.cancelled,
      ]);
      if (outcome.cancelled || task.signal.aborted) {
        await Promise.race([renderPromise.then(() => {}, () => {}), delay(cleanupWaitMs)]);
        finish(task, { ok: false, code: task.cancelCode || outcome.code });
      } else if (outcome.error) {
        finish(task, { ok: false, code: CODES.has(outcome.error?.code) ? outcome.error.code : 'html_preview_failed' });
      } else if (!isPreviewResult(outcome.value)) {
        finish(task, { ok: false, code: 'html_preview_failed' });
      } else {
        finish(task, outcome.value);
      }
    } finally {
      clearTimeout(task.renderTimer);
      clearTimeout(task.totalTimer);
      task.state = 'settled';
      if (active === task) active = null;
    }
  }

  async function drain() {
    if (draining || disposed) return;
    draining = true;
    try {
      while (!disposed && !active && queue.length) {
        const task = queue.shift();
        if (task.settled) continue;
        await runTask(task);
      }
    } finally {
      draining = false;
      if (!disposed && !active && queue.length) void drain();
    }
  }

  function makeTask(child, request) {
    let cancelResolve;
    const task = {
      child, request, state: 'queued', settled: false, cancelCode: null,
      abortController: new AbortController(),
      cancelled: new Promise(resolve => { cancelResolve = resolve; }),
      cancelResolve,
      abortRender: null,
      setWindow: value => { task.window = value || null; },
      registerSession: value => { try { ownedSessions.add(value); } catch {} },
      unregisterSession: value => { try { ownedSessions.delete(value); } catch {} },
      get signal() { return task.abortController.signal; },
      abort: code => cancel(task, code),
    };
    task.cancelResolve = cancelResolve;
    task.totalTimer = setTimeout(() => cancel(task, 'html_preview_timeout', true), totalTimeoutMs);
    return task;
  }

  function onMessage(child, message) {
    if (disposed || children.get(child) === undefined || !object(message)) return;
    if (message.type === CANCEL_CHANNEL) {
      if (Object.keys(message).length === 2 && Number.isSafeInteger(message.id) && message.id > 0) {
        const task = [...queue, ...(active ? [active] : [])].find(item => item.child === child && item.request.id === message.id);
        if (task) cancel(task, 'html_cancelled');
      }
      return;
    }
    if (message.type !== CHANNEL || !Number.isSafeInteger(message.id) || message.id < 1) return;
    const request = validateRequest(message);
    if (!request) {
      send(child, { type: RESULT_CHANNEL, id: message.id, ok: false, code: 'html_preview_failed' });
      return;
    }
    if (active?.child === child && active.request.id === request.id
      || queue.some(task => task.child === child && task.request.id === request.id)) {
      send(child, { type: RESULT_CHANNEL, id: request.id, ok: false, code: 'html_preview_failed' });
      return;
    }
    if (queue.length >= maxQueued && active) {
      send(child, { type: RESULT_CHANNEL, id: request.id, ok: false, code: 'html_preview_busy' });
      return;
    }
    const task = makeTask(child, request);
    queue.push(task);
    void drain();
  }

  function attach(child) {
    if (disposed || !child || typeof child.on !== 'function' || typeof child.send !== 'function') return () => {};
    detach(child);
    const listener = message => onMessage(child, message);
    const ended = () => detach(child);
    children.set(child, { listener, ended });
    child.on('message', listener);
    child.once?.('disconnect', ended);
    child.once?.('exit', ended);
    return () => detach(child);
  }

  function detach(child) {
    const hooks = children.get(child);
    if (!hooks) return;
    children.delete(child);
    child.removeListener?.('message', hooks.listener);
    child.removeListener?.('disconnect', hooks.ended);
    child.removeListener?.('exit', hooks.ended);
    for (const task of [...queue]) if (task.child === child) cancel(task, 'html_preview_unavailable');
    if (active?.child === child) cancel(active, 'html_preview_unavailable');
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const child of [...children.keys()]) detach(child);
    for (const task of [...queue]) cancel(task, 'html_preview_unavailable');
    if (active) cancel(active, 'html_preview_unavailable');
    // Windows are destroyed synchronously by the task abort handler; this is a
    // final guard for shutdown paths that race the active render's finally.
    try { if (active?.window && !active.window.isDestroyed()) active.window.destroy(); } catch {}
  }

  return {
    attach,
    detach,
    dispose,
    ownsWebContents(webContents) { try { return ownedSessions.has(webContents?.session); } catch { return false; } },
    getState() { return { active: active ? 1 : 0, queued: queue.length, attachedChildren: children.size, disposed }; },
  };
}

module.exports = { createHtmlPreviewService, HTML_PREVIEW_LIMITS: LIMITS };
