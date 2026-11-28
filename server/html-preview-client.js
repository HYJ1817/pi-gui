const REQUEST = 'html-preview-request';
const RESULT = 'html-preview-result';
const CANCEL = 'html-preview-cancel';
const ERROR_CODES = new Set([
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
  diagnostics: 20,
  clientTimeoutMs: 31_000,
});
const KNOWN_RESOURCE_TYPES = new Set([
  'mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'xhr', 'fetch', 'other',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const failure = code => Object.assign(new Error(code), { code });

function normalizeInput(input) {
  if (!object(input) || Object.keys(input).some(key => !['html', 'width', 'height', 'theme'].includes(key))
    || typeof input.html !== 'string' || !input.html.length
    || Buffer.byteLength(input.html, 'utf8') > LIMITS.htmlBytes) return null;
  const width = input.width === undefined ? 800 : input.width;
  const height = input.height === undefined ? 600 : input.height;
  const theme = input.theme === undefined ? 'dark' : input.theme;
  if (!Number.isInteger(width) || width < LIMITS.minWidth || width > LIMITS.maxWidth
    || !Number.isInteger(height) || height < LIMITS.minHeight || height > LIMITS.maxHeight
    || !['light', 'dark'].includes(theme)) return null;
  return { html: input.html, width, height, theme };
}

function validDiagnostics(value) {
  if (!exactKeys(value, ['console', 'errors', 'resources', 'warnings'])
    || !['console', 'errors', 'resources', 'warnings'].every(key => Array.isArray(value[key])
      && value[key].length <= LIMITS.diagnostics)) return false;
  if (value.console.some(item => !exactKeys(item, ['level', 'text'])
    || !['log', 'info', 'warning', 'error'].includes(item.level) || item.text !== 'console_message')) return false;
  if (value.errors.some(item => !object(item) || Object.keys(item).some(key => !['code', 'type', 'reason'].includes(key))
    || !['resource_blocked', 'document_load_failed', 'resource_load_failed', 'render_process_gone', 'script_error'].includes(item.code)
    || item.type !== undefined && !KNOWN_RESOURCE_TYPES.has(item.type)
    || item.reason !== undefined && !['crashed', 'oom', 'killed', 'launch-failed', 'integrity-failure', 'gone'].includes(item.reason))) return false;
  if (value.resources.some(item => !exactKeys(item, ['type', 'outcome'])
    || !KNOWN_RESOURCE_TYPES.has(item.type) || item.outcome !== 'blocked')) return false;
  return value.warnings.every(item => typeof item === 'string' && item.length <= 80
    && (['font_or_image_readiness_timeout', 'layout_feedback_limited', 'content_height_capped',
      'content_width_overflows_viewport', 'page_javascript_disabled'].includes(item) || /^\d{1,3}_images_unavailable$/.test(item)));
}

function readResult(message) {
  if (!exactKeys(message, ['type', 'id', 'schemaVersion', 'ok', 'width', 'height', 'contentWidth', 'contentHeight', 'screenshot', 'diagnostics'])
    || message.type !== RESULT || message.schemaVersion !== 1 || message.ok !== true
    || ![message.width, message.height, message.contentWidth, message.contentHeight].every(Number.isFinite)
    || !Number.isInteger(message.width) || !Number.isInteger(message.height)
    || message.width < LIMITS.minWidth || message.width > LIMITS.maxWidth
    || message.height < 1 || message.height > LIMITS.maxHeight
    || message.contentWidth < 0 || message.contentWidth > 1_000_000
    || message.contentHeight < 0 || message.contentHeight > 1_000_000
    || !exactKeys(message.screenshot, ['mimeType', 'data', 'width', 'height'])
    || message.screenshot.mimeType !== 'image/png' || message.screenshot.width !== message.width
    || message.screenshot.height !== message.height || typeof message.screenshot.data !== 'string'
    || !validDiagnostics(message.diagnostics)) return null;
  const encoded = message.screenshot.data;
  if (!encoded.length || encoded.length > Math.ceil(LIMITS.pngBytes / 3) * 4 || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const png = Buffer.from(encoded, 'base64');
  if (png.length < 24 || png.length > LIMITS.pngBytes || png.toString('base64') !== encoded
    || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || png.toString('ascii', 12, 16) !== 'IHDR'
    || png.readUInt32BE(16) !== message.width || png.readUInt32BE(20) !== message.height) return null;
  return {
    schemaVersion: 1,
    ok: true,
    width: message.width,
    height: message.height,
    contentWidth: message.contentWidth,
    contentHeight: message.contentHeight,
    screenshot: { mimeType: 'image/png', data: encoded, width: message.width, height: message.height },
    diagnostics: message.diagnostics,
  };
}

/** Client for the Electron main process's private child-process IPC preview bridge. */
export function createHtmlPreviewClient({ processRef = process } = {}) {
  const pending = new Map();
  let nextId = 1;
  let disposed = false;

  function settle(id, fn, value) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    clearTimeout(item.timer);
    item.signal?.removeEventListener('abort', item.onAbort);
    fn(value);
  }

  function send(value, callback) {
    try {
      if (!processRef || processRef.connected === false || typeof processRef.send !== 'function') {
        callback?.(failure('html_preview_unavailable'));
        return;
      }
      processRef.send(value, error => callback?.(error || null));
    } catch {
      callback?.(failure('html_preview_unavailable'));
    }
  }

  function onMessage(message) {
    if (!object(message) || message.type !== RESULT || !Number.isSafeInteger(message.id)) return;
    const item = pending.get(message.id);
    if (!item) return;
    if (message.ok === false) {
      const code = exactKeys(message, ['type', 'id', 'ok', 'code']) && ERROR_CODES.has(message.code)
        ? message.code : 'html_preview_failed';
      settle(message.id, item.reject, failure(code));
      return;
    }
    const result = readResult(message);
    if (!result) settle(message.id, item.reject, failure('html_preview_failed'));
    else settle(message.id, item.resolve, result);
  }

  function removeListeners() {
    processRef?.removeListener?.('message', onMessage);
    processRef?.removeListener?.('disconnect', onUnavailable);
    processRef?.removeListener?.('exit', onUnavailable);
  }

  function onUnavailable() {
    if (disposed) return;
    disposed = true;
    for (const [id, item] of pending) settle(id, item.reject, failure('html_preview_unavailable'));
    removeListeners();
  }

  processRef?.on?.('message', onMessage);
  processRef?.once?.('disconnect', onUnavailable);
  processRef?.once?.('exit', onUnavailable);

  function preview(input, options = {}) {
    if (disposed) return Promise.reject(failure('html_preview_unavailable'));
    if (!object(options) || Object.keys(options).some(key => key !== 'signal')) {
      return Promise.reject(failure('html_preview_failed'));
    }
    const { signal } = options;
    const request = normalizeInput(input);
    if (!request) return Promise.reject(failure('html_preview_failed'));
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
      return Promise.reject(failure('html_preview_failed'));
    }
    if (signal?.aborted) return Promise.reject(failure('html_cancelled'));
    if (!processRef || processRef.connected === false || typeof processRef.send !== 'function') {
      return Promise.reject(failure('html_preview_unavailable'));
    }
    const id = nextId;
    nextId = nextId >= Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, timer: null, onAbort: null };
      item.onAbort = () => {
        send({ type: CANCEL, id }, () => {});
        settle(id, reject, failure('html_cancelled'));
      };
      item.timer = setTimeout(() => {
        send({ type: CANCEL, id }, () => {});
        settle(id, reject, failure('html_preview_timeout'));
      }, LIMITS.clientTimeoutMs);
      pending.set(id, item);
      signal?.addEventListener('abort', item.onAbort, { once: true });
      send({ type: REQUEST, id, ...request }, error => {
        if (error) settle(id, reject, failure('html_preview_unavailable'));
      });
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [id, item] of [...pending]) {
      send({ type: CANCEL, id }, () => {});
      settle(id, item.reject, failure('html_preview_unavailable'));
    }
    removeListeners();
  }

  return { preview, dispose };
}

export const HTML_PREVIEW_CLIENT_LIMITS = LIMITS;
