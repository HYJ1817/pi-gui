'use strict';
const { randomUUID } = require('node:crypto');
/* 供应商管理 P2：CredentialSheet 受限输入窗的桌面控制器。
 *
 * 调用链（设计 §5.2）：主窗口普通 preload（open/cancel/status）→ 这里 →
 * 直属 backend 的私有 IPC（type:'provider-credential'）→ P1 SDK worker。
 * 密钥原文只出现在「输入窗 DOM → 本文件一次性转发 → backend 桥」这一条链上；
 * 主窗口页面、HTTP、日志、诊断拿不到任何值。
 *
 * 窗口隔离：
 *   - 独立非持久化 partition（无 persist: 前缀 = 内存 session），权限全拒、
 *     下载禁止、经自定义协议只提供固定本地文档——该 session 永远不持有后端令牌。
 *   - contextIsolation/sandbox/nodeIntegration:false/nodeIntegrationInSubFrames:
 *     false/webviewTag:false/webSecurity:true/devTools:false/spellcheck:false。
 *   - CSP default-src 'none'；导航/弹窗/下载/权限在 webContents 与 session 两层都拒。
 *
 * 提交守卫：sender 是本 sheet 的 webContents、senderFrame 是其 mainFrame、
 * 精确固定 URL、一次性 nonce（成功即作废）、flow TTL、全局单飞；全部通过才
 * 转发 backend，backend 侧还会再验一次 epoch/flow/nonce 绑定。
 */

const SHEET_HOST = 'sheet';
const SHEET_URL = 'pi-gui-credential://sheet/index.html';
const PARTITION = 'pi-gui-credential-sheet';
const ACTIONS = new Set(['set', 'replace', 'clear', 'authorize-target']);
const OPEN_TIMEOUT_MS = 25_000;

function opaqueId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value) && value !== '.' && value !== '..';
}

function createProviderCredentialDesktop({ app, BrowserWindow, ipcMain, protocol, session, nativeTheme,
  getMainWindow, getBackend, isDesktopQualified, page, preloadPath, logEvent = () => {}, now = Date.now }) {
  let sheet = null;
  let flow = null; // { flowId, promptId, nonce, purpose, expires, consumed, action }
  let flowTarget = '';
  let opening = null; // 当前 open 独占的取消控制器
  let handshake = null; // { epoch, stagingEnabled, child }
  let disposed = false;
  let sessionReady = false;
  let sequence = 0;
  const stateListeners = new Set();
  const handlers = new Map();

  const qualified = () => {
    try { return isDesktopQualified() === true; } catch { return false; }
  };

  function publish(update) {
    const window = getMainWindow();
    const payload = { ...update, open: Boolean(sheet), hasFlow: Boolean(flow) };
    if (window && !window.isDestroyed()) window.webContents.send('pi-gui:provider-credential-state', payload);
    for (const listener of stateListeners) listener(payload);
  }

  /* ---------- backend 私有通道 ---------- */

  function backendCall(frame, { child = getBackend(), signal } = {}) {
    if (signal?.aborted) return Promise.resolve({ ok: false, code: signal.reason });
    if (!child || child.connected !== true) return Promise.resolve({ ok: false, code: 'backend_unavailable' });
    const id = ++sequence;
    return new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.removeListener('message', onMessage);
        child.removeListener('exit', onExit);
        child.removeListener('disconnect', onExit);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onMessage = message => {
        if (message?.type === 'provider-credential' && message.id === id) {
          const { type, id: _ignored, ...result } = message;
          finish(result);
        }
      };
      const onExit = () => finish({ ok: false, code: 'backend_unavailable' });
      const onAbort = () => finish({ ok: false, code: signal.reason });
      const timer = setTimeout(() => finish({ ok: false, code: 'backend_timeout' }), OPEN_TIMEOUT_MS);
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.once('disconnect', onExit);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        child.send({ type: 'provider-credential', id, ...frame }, error => {
          if (error) onExit();
        });
      } catch { onExit(); }
    });
  }

  async function ensureHandshake(signal) {
    const child = getBackend();
    if (handshake && handshake.child === child && child && child.connected) return handshake;
    handshake = null;
    const reply = await backendCall({ action: 'capability', requestId: `cap-${++sequence}`, backendEpoch: 'handshake' },
      { child, signal });
    if (signal.aborted || child !== getBackend() || !child?.connected ||
        reply?.ok !== true || typeof reply.epoch !== 'string') return null;
    if (handshake?.child === child && handshake.epoch === reply.epoch) return handshake;
    handshake = { epoch: reply.epoch, stagingEnabled: reply.stagingEnabled === true, nativePersistence: reply.nativePersistence === true, child };
    return handshake;
  }

  function cancelOpening(reason) {
    const operation = opening;
    opening = null;
    operation?.abort(reason);
  }

  function dropFlow(flowId, owner) {
    void backendCall({ action: 'cancel', requestId: `drop-${++sequence}`, backendEpoch: owner.epoch, flowId },
      { child: owner.child });
  }

  function resetHandshake(reason) {
    cancelOpening('backend_unavailable');
    handshake = null;
    closeSheet('backend_unavailable');
    if (reason) logEvent('electron.provider_credential_reset', { reason });
    publish({ state: 'unavailable' });
  }

  /* ---------- 输入窗生命周期 ---------- */

  function ensureSession() {
    if (sessionReady) return;
    sessionReady = true;
    const s = session.fromPartition(PARTITION);
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    s.setPermissionCheckHandler(() => false);
    s.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    s.on('will-download', event => event.preventDefault());
    if (protocol?.handle) {
      /* 声明 standard+secure 后 handler 可以同步注册；但 Electron 的部分版本
       * 只有在协议处理器**完成注册并 flush** 之后才接受新 session 的首次
       * 同 scheme 导航。openSheet 走 readyToApollo 前的时序由调用方 await。 */
      s.protocol.handle('pi-gui-credential', request => {
        const path = new URL(request.url).pathname;
        const body = path === '/' || path === '/index.html' ? page.html : null;
        if (body === null) return new Response(null, { status: 404 });
        return new Response(body, { status: 200, headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': page.csp,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        } });
      });
    } else {
      logEvent('electron.provider_credential_protocol_missing', {});
    }
  }

  function closeSheet(reason) {
    if (!sheet) return;
    const target = sheet;
    const previous = flow;
    sheet = null;
    flow = null;
    clearTimeout(expiryTimer);
    expiryTimer = null;
    if (previous && !previous.consumed) dropFlow(previous.flowId, previous.owner);
    /* staged 路径延迟销毁：页面的 invoke 应答要先送到（同步 destroy 会让
     * renderer 的 promise 以「Script failed to execute」失败，而且用户暂时
     * 看不到「已应用到草稿」的反馈）。其他路径立即销毁。 */
    const delayed = reason === 'staged';
    const destroy = () => { try { if (!target.isDestroyed()) target.destroy(); } catch { /* already gone */ } };
    if (delayed) setTimeout(destroy, 250); else destroy();
    if (reason) logEvent('electron.provider_credential_sheet_closed', { reason });
    /* 关闭后焦点一律回到主窗口（设计 §4：关闭回到触发器）。staged 路径的
     * 销毁延后在子窗口上，聚焦主窗可以先发生。 */
    const parent = getMainWindow();
    if (parent && !parent.isDestroyed()) parent.focus();
    publish({ state: reason === 'staged' ? 'staged' : reason ?? 'closed' });
  }

  function openSheet({ flow: prepared, theme, targetSummary }) {
    ensureSession();
    const parent = getMainWindow();
    if (!parent || parent.isDestroyed()) return { ok: false, code: 'no_main_window' };
    const parentWidth = parent.getContentBounds().width;
    const sheetWindow = new BrowserWindow({
      parent,
      modal: true,
      width: Math.min(460, Math.max(320, parentWidth - 32)),
      height: 380,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Pi GUI 凭据输入',
      show: false,
      backgroundColor: theme === 'light' ? '#f4f5f7' : '#141519',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        devTools: false,
        spellcheck: false,
        partition: PARTITION,
        additionalArguments: [
          `--pi-gui-credential-theme=${JSON.stringify(theme)}`,
          ...(prepared.oauthConflict === true ? ['--pi-gui-credential-oauth'] : []),
        ],
      },
    });
    sheet = sheetWindow;
    try { sheetWindow.setContentProtection(true); } catch { /* best effort */ }
    /* 这一层比全局 hardenWebContents 更严：目标必须始终是固定本地文档，
     * 不放行任何 URL（包括自家 ORIGIN），也不给 openExternal 的机会。 */
    sheetWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    sheetWindow.webContents.on('will-navigate', event => event.preventDefault());
    sheetWindow.webContents.on('will-attach-webview', event => event.preventDefault());
    sheetWindow.webContents.on('did-finish-load', () => {
      // 目标摘要与操作模式经有序消息推给 preload，页面渲染前已可读。
      try { sheetWindow.webContents.send('pi-gui:provider-credential-target', targetSummary ?? ''); } catch { /* closing */ }
      try { sheetWindow.webContents.send('pi-gui:provider-credential-purpose', prepared.purpose); } catch { /* closing */ }
    });
    sheetWindow.once('ready-to-show', () => sheetWindow.show());
    sheetWindow.on('closed', () => {
      if (sheet === sheetWindow) closeSheet('closed');
    });
    sheetWindow.webContents.loadURL(SHEET_URL).catch(() => {
      if (sheet === sheetWindow) closeSheet('load_failed');
    });
    return { ok: true };
  }

  /* ---------- 主窗口 preload 入口（open/cancel/status） ---------- */

  function mainWindowAllowed(event) {
    const parent = getMainWindow();
    if (!parent || parent.isDestroyed()) return false;
    if (event.sender !== parent.webContents) return false;
    if (event.senderFrame !== event.sender.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === new URL(parent.webContents.getURL()).origin; }
    catch { return false; }
  }

  async function openHandler(event, request) {
    /* openForTest（诊断/测试直调）不携带真实 webContents；任何经 IPC 到达的
     * 调用仍必须通过 mainWindowAllowed 的 sender/frame/origin 校验。 */
    const trusted = event && event.testBypass === true ? true : mainWindowAllowed(event);
    if (!trusted) return { ok: false, code: 'forbidden' };
    if (disposed) return { ok: false, code: 'unavailable' };
    if (!qualified()) return { ok: false, code: 'unsupported', reason: 'desktop_unqualified' };
    const valid = request && typeof request === 'object' && opaqueId(request.draftId)
      && Number.isSafeInteger(request.draftRevision) && request.draftRevision >= 1 && ACTIONS.has(request.action);
    if (!valid) return { ok: false, code: 'invalid_request' };
    // 同步占位，取消后允许重开。旧操作只能释放自己持有的位置。
    if (sheet || flow || opening) return { ok: false, code: 'busy', reason: sheet || flow ? 'sheet_open' : 'opening' };
    const parent = getMainWindow();
    if (!parent || parent.isDestroyed()) return { ok: false, code: 'no_main_window' };
    const operation = new AbortController();
    opening = operation;
    const onClosed = () => operation.abort('no_main_window');
    parent.once('closed', onClosed);
    try {
      return await openFlow(request, parent, operation.signal);
    } finally {
      parent.removeListener('closed', onClosed);
      if (opening === operation) opening = null;
    }
  }

  async function openFlow(request, parent, signal) {
    /* 竞态兜底：上一窗口可能还在 250ms 延迟销毁窗口内（staged 路径）。
     * open 是显式用户动作，先完成销毁再开新窗。 */
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== getMainWindow() && !window.isDestroyed() && String(window.webContents?.getURL() ?? '').startsWith('pi-gui-credential:')) {
        try { window.destroy(); } catch { /* already gone */ }
      }
    }
    const handshakeNow = await ensureHandshake(signal);
    if (signal.aborted) return { ok: false, code: signal.reason };
    if (!handshakeNow) return { ok: false, code: 'unsupported', reason: 'bridge_unavailable' };
    if (!handshakeNow?.stagingEnabled && request.action !== 'authorize-target') {
      return { ok: false, code: 'unsupported', reason: 'key_input_disabled' };
    }
    if (!qualified()) return { ok: false, code: 'unsupported', reason: 'desktop_unqualified' };
    const purpose = request.action;
    const flowId = randomUUID();
    const prepared = await backendCall({ action: 'prepare', requestId: `open-${++sequence}`, backendEpoch: handshakeNow.epoch,
      draftId: request.draftId, draftRevision: request.draftRevision, purpose, flowId }, { child: handshakeNow.child, signal });
    if (signal.aborted || prepared?.ok !== true || handshake !== handshakeNow ||
        handshakeNow.child !== getBackend() || !handshakeNow.child.connected) {
      dropFlow(flowId, handshakeNow);
      return { ok: false, code: signal.aborted ? signal.reason : prepared?.code ?? 'unavailable', reason: prepared?.message };
    }
    const expires = prepared.expiresAt;
    if (getMainWindow() !== parent || prepared.flowId !== flowId || !Number.isFinite(expires) || expires <= now()) {
      dropFlow(flowId, handshakeNow);
      return { ok: false, code: 'unavailable' };
    }
    flowTarget = prepared.targetSummary?.baseUrl || prepared.targetSummary?.providerId || '';
    const theme = nativeTheme?.shouldUseDarkColors === false ? 'light' : 'dark';
    let opened;
    try { opened = openSheet({ flow: prepared, theme, targetSummary: flowTarget }); }
    catch { closeSheet('load_failed'); opened = { ok: false, code: 'unavailable' }; }
    if (opened.ok !== true) { dropFlow(flowId, handshakeNow); return opened; }
    flow = { flowId, promptId: prepared.promptId, nonce: prepared.nonce,
      purpose, expires, consumed: false, owner: handshakeNow };
    logEvent('electron.provider_credential_open', { action: request.action, oauthConflict: prepared.oauthConflict === true });
    scheduleExpiry();
    publish({ state: 'open', action: request.action });
    return { ok: true, state: { action: request.action, oauthConflict: prepared.oauthConflict === true,
      credential: prepared.credential ?? null, expiresAt: expires } };
  }

  let expiryTimer = null;
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    expiryTimer = null;
    if (!flow) return;
    const remaining = flow.expires - now();
    if (remaining <= 0) { closeSheet('expired'); return; }
    expiryTimer = setTimeout(() => { if (flow) closeSheet('expired'); }, remaining);
    expiryTimer.unref?.();
  }

  function cancelHandler(event) {
    if (!mainWindowAllowed(event)) return { ok: false, code: 'forbidden' };
    cancelOpening('cancelled');
    closeSheet('cancelled');
    return { ok: true };
  }

  async function statusHandler(event) {
    if (!mainWindowAllowed(event)) return { ok: false, code: 'forbidden' };
    const current = qualified() ? await ensureHandshake(new AbortController().signal) : null;
    if (!mainWindowAllowed(event)) return { ok: false, code: 'forbidden' };
    return { ok: true, open: Boolean(sheet), hasFlow: Boolean(flow),
      action: flow?.purpose ?? null, expiresAt: flow?.expires ?? null, nativeCredentialPersistence: current?.nativePersistence === true && qualified() };
  }

  /* ---------- 输入窗 preload 入口（submit/cancel/status） ---------- */

  function sheetAllowed(event) {
    if (!sheet || sheet.isDestroyed()) return false;
    if (event.sender !== sheet.webContents) return false;
    if (event.senderFrame !== event.sender.mainFrame) return false;
    try { return event.senderFrame.url === SHEET_URL; } catch { return false; }
  }

  async function submitHandler(event, payload) {
    if (!sheetAllowed(event)) return { ok: false, code: 'forbidden' };
    if (!flow || flow.consumed) return { ok: false, code: 'stale' };
    if (now() >= flow.expires) { closeSheet('expired'); return { ok: false, code: 'expired' }; }
    const submitting = flow;
    const input = typeof payload?.input === 'string' ? payload.input : '';
    const handshakeNow = submitting.owner;
    if (handshake !== handshakeNow || getBackend() !== handshakeNow.child) return { ok: false, code: 'unavailable' };
    const actionName = flow.purpose === 'clear' ? 'clear-stage' : flow.purpose === 'authorize-target' ? 'authorize-target' : 'stage';
    const frame = { action: actionName, requestId: `submit-${++sequence}`, backendEpoch: handshakeNow.epoch, flowId: flow.flowId, promptId: flow.promptId, nonce: flow.nonce };
    if (actionName === 'stage') {
      frame.input = input;
      frame.allowDiscovery = payload?.allowDiscovery === true;
      frame.rememberTarget = payload?.rememberTarget === true;
    } else {
      frame.confirmed = true;
      if (actionName === 'authorize-target') frame.rememberTarget = payload?.rememberTarget === true;
    }
    const reply = await backendCall(frame, { child: handshakeNow.child });
    if (flow !== submitting) return { ok: false, code: 'stale' };
    if (reply?.ok !== true) {
      /* 失败时 nonce 保持可用：OAuth 同槽的替换/清除都需要在同一受限窗内
       * 读提示后二次确认；backend 的固定文案随应答带给页面。 */
      const code = reply?.code ?? 'unavailable';
      logEvent('electron.provider_credential_stage_failed', { action: actionName, code });
      return { ok: false, code, ...(reply?.message ? { message: reply.message } : {}) };
    }
    flow.consumed = true; // 成功即作废：这一帧不能被重放
    const result = { ok: true, credentialState: reply.credentialState ?? null, consent: reply.consent ?? null };
    closeSheet('staged');
    logEvent('electron.provider_credential_staged', { action: actionName, allowDiscovery: frame.allowDiscovery === true });
    return result;
  }

  function sheetCancelHandler(event) {
    if (!sheetAllowed(event)) return { ok: false, code: 'forbidden' };
    // 输入窗取消：保留已存在的暂存值（backend 侧 flow 作废即可），不销毁 worker 暂存。
    closeSheet('cancelled');
    return { ok: true };
  }

  function sheetStatusHandler(event) {
    if (!sheetAllowed(event)) return { ok: false, code: 'forbidden' };
    return { ok: true, state: flow?.consumed ? 'staged' : 'editing', purpose: flow?.purpose ?? null,
      targetSummary: flowTarget ?? '', expiresAt: flow?.expires ?? null };
  }

  /* ---------- 装配 ---------- */

  function install(channel, fn) {
    ipcMain.handle(channel, fn);
    handlers.set(channel, fn);
  }

  function register() {
    install('pi-gui:provider-credential-open', openHandler);
    install('pi-gui:provider-credential-cancel', cancelHandler);
    install('pi-gui:provider-credential-status', statusHandler);
    install('pi-gui:provider-credential-submit', submitHandler);
    install('pi-gui:provider-credential-cancel-sheet', sheetCancelHandler);
    install('pi-gui:provider-credential-sheet-status', sheetStatusHandler);
  }

  function dispose() {
    disposed = true;
    cancelOpening('unavailable');
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
    handlers.clear();
    stateListeners.clear();
    closeSheet('disposed');
    handshake = null;
  }

  register();
  return {
    dispose,
    resetHandshake,
    sheetUrl: SHEET_URL,
    /* 仅测试/诊断用：绕过 mainWindowAllowed 的直接 open（主进程内直调，
     * 不经 IPC）；生产路径仍走 ipcMain.handle 的 handler。 */
    openForTest: request => openHandler({ testBypass: true }, request),
    onState: listener => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    get flow() { return flow; },
    get handshake() { return handshake; },
  };
}

/* 必须在 app ready 之前调用：自定义协议要声明为 standard+secure，
 * 否则 sheet 的固定 URL 无法作为顶层文档加载、CSP 的 scheme-source 也不生效。 */
function registerCredentialScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'pi-gui-credential', privileges: { standard: true, secure: true } },
  ]);
}

module.exports = { createProviderCredentialDesktop, registerCredentialScheme, SHEET_URL, PARTITION };
