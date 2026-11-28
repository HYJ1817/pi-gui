const assert = require('node:assert/strict');
const { once } = require('node:events');
const os = require('node:os');
const test = require('node:test');

test('native preview prepares resources, returns model feedback and cancels without publication', async t => {
  const { createHtmlRenderBridge } = await import('../server/html-render-bridge.js');
  const { installHtmlRender } = await import('../extensions/pi-gui-html/index.js');
  const cwd = os.tmpdir();
  const sessionId = 'preview-session';
  const args = { html: '<p>Example</p>', width: 420, height: 200, theme: 'light' };
  const assistant = { type: 'message', id: 'assistant', parentId: null, message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'preview-call', name: 'html_preview', arguments: args },
  ] } };
  let request;
  let hold = false;
  const started = new AbortController();
  const stopped = new AbortController();
  const bridge = createHtmlRenderBridge({
    supported: true, launch: { identityKey: () => 'fixture' }, getCwd: () => cwd,
    capture: () => ({ sessionId, owner: { sessionId: 'logical', runtimeId: 'runtime', epoch: 1 } }),
    isCurrent: () => true, scopeForWitness: () => ({ kind: 'classic', bridgeInstance: 'bridge', workspaceKey: 'workspace',
      bridgeRun: 1, workspaceGeneration: 1, sessionId }),
    readState: async () => ({ sessionId }), readEntries: async () => ({ entries: [assistant], leafId: assistant.id }),
    store: { publish: () => assert.fail('preview must never publish') },
    prepareHtml: async html => html.replace('Example', 'Prepared'),
    preview: async (input, { signal }) => {
      request = input;
      if (hold) {
        started.abort();
        if (!signal.aborted) await once(signal, 'abort');
        stopped.abort();
        throw Object.assign(new Error(), { code: 'html_cancelled' });
      }
      return { schemaVersion: 1, ok: true, width: 420, height: 200, contentWidth: 420, contentHeight: 100,
        diagnostics: { console: [], errors: [], resources: [], warnings: ['page_javascript_disabled'] },
        screenshot: { mimeType: 'image/png', data: 'aW1hZ2U=', width: 420, height: 200 } };
    },
  });
  t.after(() => bridge.dispose());
  const { env } = await bridge.prepare();
  const tools = new Map();
  const hooks = new Map();
  const extension = installHtmlRender({ on: (name, handler) => hooks.set(name, handler),
    registerTool: tool => tools.set(tool.name, tool) }, { url: env.PI_GUI_HTML_URL, token: env.PI_GUI_HTML_TOKEN });
  t.after(() => extension.dispose());
  const ctx = { cwd, model: { input: ['text', 'image'] }, sessionManager: {
    getSessionId: () => sessionId, getLeafId: () => assistant.id, getBranch: () => [assistant],
  } };
  assert.ok(tools.has('html_render'));
  assert.ok(tools.has('html_preview'));
  const run = (signal, context = ctx) => tools.get('html_preview').execute('preview-call', args, signal, undefined, context);
  const result = await run();
  assert.equal(result.details.ok, true, result.content[0].text);
  assert.deepEqual(request, { ...args, html: '<p>Prepared</p>' });
  assert.equal(result.details.kind, 'html_preview');
  assert.equal(result.details.mode, 'static');
  assert.equal(result.details.ok, true);
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /Static preview \(page JavaScript disabled\)/);
  assert.match(result.content[0].text, /runtime errors were NOT evaluated/);
  const message = { role: 'toolResult', toolName: 'html_preview', toolCallId: 'preview-call', content: result.content };
  const modelContext = await hooks.get('context')({ messages: [message] }, ctx);
  assert.deepEqual(modelContext.messages[0].content[1], { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' });
  assert.equal(message.content.length, 1, 'the native session result contains only text');
  const textModel = { ...ctx, model: { input: ['text'] } };
  assert.equal((await run(undefined, textModel)).content.length, 1);
  assert.equal(await hooks.get('context')({ messages: [message] }, textModel), undefined);
  hold = true;
  const cancelled = run();
  if (!started.signal.aborted) await once(started.signal, 'abort');
  bridge.pause();
  if (!stopped.signal.aborted) await once(stopped.signal, 'abort');
  assert.equal((await cancelled).details.code, 'html_cancelled');
});
