import http from 'node:http';

const fail = code => Object.assign(Error('HTML visualization unavailable.'), { code });
const CODES = new Set(['invalid_request', 'stale_runtime', 'html_bridge_unavailable', 'html_cancelled',
  'html_immutable_conflict', 'html_storage_full', 'html_too_large', 'html_store_unavailable',
  'html_preview_unavailable', 'html_preview_timeout', 'html_preview_busy', 'html_preview_failed',
  ...['invalid', 'url', 'blocked', 'offline', 'proxy', 'unsupported', 'reference', 'dns', 'network', 'timeout',
    'cancelled', 'redirect', 'response', 'encoding', 'type', 'too_large', 'busy'].map(code => 'html_resource_' + code)]);
const htmlParameter = { type: 'string', minLength: 1, maxLength: 2097152,
  description: 'Complete HTML document (maximum 2 MiB UTF-8).' };
const resourceParameter = { type: 'array', maxItems: 8,
  description: 'Optional public HTTPS raster images. Declare each URL used verbatim in a quoted HTML or CSS value. Each image is fetched and embedded by the host.',
  items: { type: 'object', properties: { type: { type: 'string', enum: ['image'] }, url: { type: 'string', maxLength: 2048 } },
    required: ['type', 'url'], additionalProperties: false } };
const supportsImages = ctx => ctx.model?.input?.includes('image') === true;

export function htmlTransport(connection, action, body, { signal, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(connection.url);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || !connection.token) throw Error();
    } catch { reject(fail('html_bridge_unavailable')); return; }
    if (signal?.aborted) { reject(fail('html_cancelled')); return; }
    const payload = Buffer.from(JSON.stringify(body));
    let done = false, timer;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { finish(fail('html_cancelled')); req.destroy(); };
    const req = http.request(new URL('/' + action, target), { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': payload.length, 'x-pi-gui-html-token': connection.token,
    } }, res => {
      const chunks = []; let size = 0;
      const limit = action === 'preview' ? 4 * 1024 * 1024 + 16384 : 4096;
      res.on('data', chunk => { size += chunk.length; if (size > limit) { finish(fail('html_bridge_unavailable')); req.destroy(); } else chunks.push(chunk); });
      res.on('error', () => finish(fail('html_bridge_unavailable')));
      res.on('aborted', () => finish(fail('html_bridge_unavailable')));
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks));
          if (res.statusCode !== 200 || value.ok !== true) return finish(fail(CODES.has(value.code) ? value.code : 'html_bridge_unavailable'));
          finish(null, value);
        } catch { finish(fail('html_bridge_unavailable')); }
      });
    });
    req.on('error', () => finish(fail('html_bridge_unavailable')));
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { finish(fail('html_bridge_unavailable')); req.destroy(); }, timeoutMs);
    req.end(payload);
  });
}

export function installHtmlRender(pi, connection) {
  let state = null;
  const images = new Map();
  const start = ctx => {
    state?.controller.abort();
    images.clear();
    state = { native: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, controller: new AbortController() };
    return state;
  };
  function current(s, ctx) {
    if (state !== s || s.controller.signal.aborted || s.native !== ctx.sessionManager.getSessionId() || s.cwd !== ctx.cwd) throw fail('stale_runtime');
  }
  const post = (s, action, body, options) => (connection.post || ((action, body, options) => htmlTransport(connection, action, body, options)))(action, { sessionId: s.native, ...body }, options);
  async function hello(s, ctx, signal) {
    current(s, ctx);
    // session_start starts this without awaiting: Pi 1.6 installs the stdin RPC
    // reader only after session_start handlers return. Execute awaits a bounded
    // strict hello before allowing any bytes to be published.
    await post(s, 'hello', {}, { signal: signal || s.controller.signal, timeoutMs: 5000 });
    current(s, ctx);
    if (signal?.aborted) throw fail('html_cancelled');
  }
  function ownerMessage(ctx, toolCallId, name) {
    const leaf = ctx.sessionManager.getLeafId();
    const branch = ctx.sessionManager.getBranch(leaf);
    const entry = [...branch].reverse().find(row => row.type === 'message' && row.message?.role === 'assistant');
    const calls = entry?.message?.content?.filter(part => part.type === 'toolCall' && part.id === toolCallId);
    if (!entry?.id || calls?.length !== 1 || calls[0].name !== name) throw fail('invalid_request');
    return entry.id;
  }
  function dispose() { state?.controller.abort(); state = null; images.clear(); }
  pi.on('session_start', (_event, ctx) => {
    const s = start(ctx);
    void hello(s, ctx).catch(() => { /* execute performs its own bounded strict verification */ });
  });
  pi.on('session_shutdown', dispose);
  pi.on('agent_end', () => { images.clear(); });
  // Pi appends native tool results to its session file. Its context hook runs
  // on a separate copy, so an image can reach the model without a disk copy.
  pi.on('context', ({ messages }, ctx) => {
    if (!images.size || !supportsImages(ctx) || state?.native !== ctx.sessionManager.getSessionId()) return;
    return { messages: messages.map(message => {
      const image = message.role === 'toolResult' && message.toolName === 'html_preview' && images.get(message.toolCallId);
      return image ? { ...message, content: [...message.content, image] } : message;
    }) };
  });
  pi.registerTool({
    name: 'html_preview', label: 'Preview visual reply',
    description: 'Inspect a temporary rendering before publishing. Returns size, layout, console and resource diagnostics. Vision models receive a screenshot. Static preview checks layout only because page JavaScript is disabled.',
    promptSnippet: 'Use html_preview to check complex layouts or interactive visuals. Fix material issues, then publish the final HTML with html_render.',
    parameters: { type: 'object', properties: {
      html: htmlParameter, resources: resourceParameter,
      width: { type: 'integer', minimum: 240, maximum: 1600, default: 800, description: 'Preview width in CSS pixels.' },
      height: { type: 'integer', minimum: 80, maximum: 4096, default: 600, description: 'Initial preview height in CSS pixels.' },
      theme: { type: 'string', enum: ['light', 'dark'], default: 'dark', description: 'Color scheme to inspect.' },
    }, required: ['html'], additionalProperties: false },
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      try {
        const s = state || start(ctx);
        const combined = signal ? AbortSignal.any([signal, s.controller.signal]) : s.controller.signal;
        await hello(s, ctx, combined);
        const messageId = ownerMessage(ctx, toolCallId, 'html_preview');
        const value = await post(s, 'preview', { messageId, toolCallId, html: args.html, width: args.width,
          height: args.height, theme: args.theme, resources: args.resources }, { signal: combined, timeoutMs: 48000 });
        current(s, ctx);
        if (combined.aborted) throw fail('html_cancelled');
        const { width, height, contentWidth, contentHeight, diagnostics, screenshot } = value;
        if (value.schemaVersion !== 1 || screenshot?.mimeType !== 'image/png' || typeof screenshot.data !== 'string'
          || ![width, height, contentWidth, contentHeight].every(Number.isSafeInteger)
          || !['console', 'errors', 'resources', 'warnings'].every(key => Array.isArray(diagnostics?.[key]))) throw fail('html_preview_failed');
        if (supportsImages(ctx)) {
          if (images.size >= 2) images.delete(images.keys().next().value);
          images.set(toolCallId, { type: 'image', mimeType: screenshot.mimeType, data: screenshot.data });
        }
        const diagnosticCounts = Object.fromEntries(Object.entries(diagnostics).map(([key, rows]) => [key, rows.length]));
        const staticPreview = diagnostics.warnings.includes('page_javascript_disabled');
        const mode = staticPreview ? 'static' : 'interactive';
        const heading = staticPreview ? 'Static preview (page JavaScript disabled)' : 'Interactive preview';
        const diagnosticsText = `${heading} ${width}×${height} CSS px. Content ${contentWidth}×${contentHeight} CSS px.\n${JSON.stringify(diagnostics)}`;
        return { content: [{ type: 'text', text: diagnosticsText }], details: { kind: 'html_preview', schemaVersion: 1,
          ok: true, mode, width, height, contentWidth, contentHeight, diagnosticCounts } };
      } catch (error) {
        const code = CODES.has(error?.code) ? error.code : 'html_preview_failed';
        return { isError: true, content: [{ type: 'text', text: `HTML preview unavailable (${code}). Check the HTML directly and publish with html_render if useful.` }],
          details: { kind: 'html_preview', schemaVersion: 1, ok: false, code } };
      }
    },
  });
  pi.registerTool({
    name: 'html_render', label: 'Visual reply',
    description: 'Publish a self-contained HTML visualization in the conversation. Returns an immutable snapshot reference, not a URL.',
    promptSnippet: 'Use html_render when a chart, comparison, process, architecture, timeline, table, or interactive UI would materially improve the answer, even when the user did not request a visual.',
    promptGuidelines: [
      'Choose visuals when they clarify real data, relationships or interactions. Keep simple questions, routine edits and translations in text. Publish simple visuals directly. For complex visuals, inspect an html_preview, correct material issues, and repeat only when needed. Continue the normal answer after publishing.',
      'Use inline CSS, SVG and JavaScript. Keep interactions local and use DOM methods such as createElement, textContent and replaceChildren. Declare optional public HTTPS images in resources; remote scripts, styles, fonts and page network access are unavailable.',
      'Use theme CSS variables: --background, --foreground, --muted, --muted-foreground, --border, --primary, --accent, --destructive, --warning, --success, --info, --chart-1 through --chart-6, --radius, --font-sans, --font-mono. Supply CSS fallbacks. Use --foreground or --muted-foreground for text, not chart colors. Pair every colored series with visible labels or a data table; light-theme --chart-3, --chart-4 and --chart-5 do not provide 3:1 contrast on the background. Do not add an outer card or a meaningless repeated title. Avoid 100vh and unbounded height; fit content to the provided initial height.',
    ],
    parameters: { type: 'object', properties: {
      title: { type: 'string', minLength: 1, maxLength: 160, description: 'Short accessible visualization title.' },
      html: htmlParameter, resources: resourceParameter,
      height: { type: 'integer', minimum: 80, maximum: 2048, default: 320, description: 'Initial display height in CSS pixels.' },
    }, required: ['title', 'html'], additionalProperties: false },
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      try {
        const s = state || start(ctx);
        const combined = signal ? AbortSignal.any([signal, s.controller.signal]) : s.controller.signal;
        await hello(s, ctx, combined);
        current(s, ctx);
        const messageId = ownerMessage(ctx, toolCallId, 'html_render');
        const value = await post(s, 'publish', { messageId, toolCallId, title: args.title, html: args.html,
          height: args.height ?? 320, resources: args.resources }, { signal: combined, timeoutMs: args.resources?.length ? 22000 : 8000 });
        current(s, ctx);
        if (combined.aborted) throw fail('html_cancelled');
        const details = value.details, ref = details?.artifact;
        if (details?.kind !== 'html_artifact' || details.schemaVersion !== 1 || details.ok !== true || !/^[a-f0-9]{64}$/.test(ref?.id)
          || ref.sessionId !== s.native || ref.messageId !== messageId || ref.toolCallId !== toolCallId) throw fail('html_bridge_unavailable');
        return { content: [{ type: 'text', text: `HTML: ${ref.title} (${ref.id})` }], details };
      } catch (error) {
        const code = CODES.has(error?.code) ? error.code : 'html_bridge_unavailable';
        return { isError: true, content: [{ type: 'text', text: `HTML visualization unavailable (${code}).` }],
          details: { kind: 'html_artifact', schemaVersion: 1, ok: false, code } };
      }
    },
  });
  return { dispose };
}

export default function htmlRenderExtension(pi) {
  if (process.env.PI_GUI_HTML_URL && process.env.PI_GUI_HTML_TOKEN) installHtmlRender(pi, {
    url: process.env.PI_GUI_HTML_URL, token: process.env.PI_GUI_HTML_TOKEN,
  });
}
