'use strict';
const { Readable } = require('node:stream');
const address = require('node:net');
const net = require('electron').net;

function headersView(source = {}) {
  const entries = Object.entries(source);
  return { get(name) {
    const match = entries.find(([key]) => key.toLowerCase() === String(name).toLowerCase());
    if (!match) return null;
    const value = match[1];
    return Array.isArray(value) ? value.join(', ') : String(value);
  } };
}

// Electron's fetch implementations reject `redirect: manual` with
// "Redirect was cancelled". The updater must inspect the Location itself,
// re-run its release-host allow-list, then issue the next request.
function createSessionFetch({ request = net.request, session } = {}) {
  if (typeof request !== 'function' || !session) throw new TypeError('session request transport required');
  return (input, options = {}) => new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : input?.url);
      const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      const loopback = host === 'localhost' || address.isIPv4(host) && host.startsWith('127.') || host === '::1';
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback) || url.username || url.password) throw Error('invalid_update_url');
    } catch { reject(Error('invalid_update_url')); return; }
    let client;
    try {
      client = request({ url: url.href, method: options.method || 'GET', headers: options.headers || {}, session,
        credentials: 'omit', useSessionCookies: false });
    } catch { reject(Error('update_transport_unavailable')); return; }
    let settled = false, responseBody = null, stopped = false, bodyEnded = false;
    const signal = options.signal;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const dispose = error => {
      cleanup();
      if (stopped || bodyEnded) return;
      stopped = true;
      try { responseBody?.destroy(error); } catch { /* Native request must still be aborted. */ }
      try { client.abort(); } catch { /* Already closed; disposal is idempotent. */ }
    };
    const finish = (error, value, keepSignal = false) => {
      if (settled) return false;
      settled = true;
      if (!keepSignal) cleanup();
      if (error) reject(error); else resolve(value);
      return true;
    };
    const abort = () => {
      const error = Error('The operation was aborted'); error.name = 'AbortError';
      finish(error); dispose(error);
    };
    client.on('redirect', (status, _method, _target, responseHeaders) => {
      // Do not call followRedirect. The caller owns redirect validation.
      const body = Readable.from([]);
      if (finish(null, { status, ok: false, headers: headersView(responseHeaders), body, dispose: () => dispose() })) dispose();
    });
    client.on('response', response => {
      // Headers may be rejected before an iterator exists. Keep an error
      // listener even after disposal so a late native error cannot escape.
      // An active iterator still receives the stream's error normally.
      response.on('error', cleanup);
      if (settled) { response.destroy(); return; }
      responseBody = response;
      response.once('end', () => { bodyEnded = true; cleanup(); }); response.once('close', cleanup);
      finish(null, { status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: headersView(response.headers), body: response, dispose: () => dispose() }, true);
    });
    client.on('error', error => {
      const failure = error?.name === 'AbortError' ? error : Error('update_transport_failed');
      finish(failure); dispose(failure);
    });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try { client.end(); } catch { finish(Error('update_transport_failed')); dispose(); }
  });
}

module.exports = { createSessionFetch };
