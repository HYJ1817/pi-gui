const test = require('node:test');
const assert = require('node:assert/strict');
const raw = 'PRIVATE_PREVIEW_HTML_IMAGE_CONSOLE_CANARY';
const result = () => ({ content: [{ type: 'text', text: raw }, { type: 'image', data: raw, mimeType: 'image/png' }],
  details: { kind: 'html_preview', schemaVersion: 1, ok: true, width: 800, height: 600,
    contentWidth: 800, contentHeight: 1200, diagnosticCounts: { console: 2, errors: 1, resources: 0, warnings: 0 },
    html: raw, diagnostics: { console: [raw] }, screenshot: { data: raw }, arbitrary: raw,
    truncation: { truncated: true, truncatedBy: raw, totalLines: raw }, diff: `+${raw}` } });
const safe = value => assert.equal(JSON.stringify(value).includes(raw), false);

test('preview summary admits only typed status, geometry and diagnostic counts', async () => {
  const { projectHtmlPreviewResult } = await import('../public/html-preview-model.js');
  const input = result(), before = structuredClone(input), output = projectHtmlPreviewResult(input);
  safe(output); assert.equal(output.details.ok, true); assert.equal(output.details.height, 600);
  assert.deepEqual(output.details.diagnosticCounts, { console: 2, errors: 1, resources: 0, warnings: 0 });
  assert.deepEqual(input, before, 'native Pi image and diagnostics must remain intact');
  for (const details of [{ ...input.details, schemaVersion: 2 }, { ...input.details, ok: false }, {}]) {
    assert.equal(projectHtmlPreviewResult({ ...input, details }).isError, true);
  }
  const hostile = projectHtmlPreviewResult({ details: { ...input.details, width: raw, height: Infinity,
    diagnosticCounts: { console: raw, errors: -1, resources: 1001, warnings: 2, arbitrary: raw } } });
  safe(hostile); assert.equal(hostile.details.width, undefined); assert.equal(hostile.details.height, undefined);
  assert.deepEqual(hostile.details.diagnosticCounts, { warnings: 2 });
});

test('classic SSE hides preview source, screenshots, and raw logs but preserves tool identity', async () => {
  const { createHtmlArtifactProjection } = await import('../server/html-artifact-projection.js');
  const project = createHtmlArtifactProjection();
  safe(project({ type: 'tool_execution_start', bridgeRun: 1, toolCallId: 'same', toolName: 'html_preview', args: { html: raw } }));
  const end = project({ type: 'tool_execution_end', bridgeRun: 1, toolCallId: 'same', result: result() });
  safe(end); assert.equal(end.result.details.kind, 'html_preview'); assert.equal(end.result.details.ok, true);
  const next = project({ type: 'execution_branch', bridgeRun: 1 }); safe(next);
  const noWitness = project({ type: 'tool_execution_end', bridgeRun: 1, toolCallId: 'same', result: { content: [{ type: 'image', data: raw }] } });
  safe(noWitness); assert.equal(noWitness.result.isError, true);
});

test('preview native history and tool declarations stay compact without Artifact references', async () => {
  const { projectHtmlArtifacts, htmlReferencesInPath } = await import('../server/html-artifact-projection.js');
  const { projectRuntimeEntry } = await import('../server/execution-timeline.js');
  const assistant = { type: 'message', id: 'assistant', parentId: null, message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'preview-call', name: 'html_preview', arguments: { html: raw } }] } };
  const entry = { type: 'message', id: 'result', parentId: 'assistant', message: { role: 'toolResult', toolName: 'html_preview', toolCallId: 'preview-call', ...result() } };
  const projected = projectHtmlArtifacts([assistant, entry]); safe(projected);
  assert.equal(projected[0].message.content[0].name, 'html_preview');
  assert.deepEqual(projected[0].message.content[0].arguments, {});
  assert.equal(projected[1].message.details.ok, true);
  assert.deepEqual(htmlReferencesInPath([assistant, entry]), []);
  const history = projectRuntimeEntry(entry); safe(history); assert.equal(history.message.details.kind, 'html_preview');
});

test('runtime execution and message results expose only preview summary', async () => {
  const { projectRuntimeEvent } = await import('../server/session-runtime.js');
  const tool = projectRuntimeEvent({ type: 'tool_execution_end', toolName: 'html_preview', toolCallId: 'call', result: result(), durationMs: 200 });
  safe(tool); assert.equal(tool.result.details.ok, true); assert.equal(tool.durationMs, 200);
  const message = { role: 'toolResult', toolName: 'html_preview', toolCallId: 'call', ...result() };
  for (const event of [{ type: 'message_end', message }, { type: 'agent_end', messages: [message] }, { type: 'turn_end', toolResults: [message] }]) safe(projectRuntimeEvent(event));
  const failed = projectRuntimeEvent({ type: 'tool_execution_end', toolName: 'html_preview', toolCallId: 'call', isError: true,
    result: { isError: true, content: [{ type: 'text', text: raw }], details: { kind: 'html_preview', schemaVersion: 1, ok: false, code: raw } } });
  safe(failed); assert.equal(failed.result.isError, true); assert.equal(failed.result.details.code, undefined);
  const outerError = projectRuntimeEvent({ type: 'tool_execution_end', toolName: 'html_preview', toolCallId: 'call',
    isError: true, result: result() });
  safe(outerError); assert.equal(outerError.result.isError, true); assert.equal(outerError.result.details.ok, false);
});

test('preview activity uses existing compact tool row with no raw disclosure', async () => {
  const { htmlArtifactActivity } = await import('../public/html-artifact-activity.js');
  const activity = htmlArtifactActivity({ name: 'html_preview', args: { html: raw }, output: raw, ...result() });
  safe(activity); assert.equal(activity.label, '预览可视化'); assert.equal(activity.kind, 'html_preview');
  assert.equal(activity.args, null); assert.equal(activity.details, null); assert.equal(activity.output, '');
  assert.equal(htmlArtifactActivity({ name: 'html_render' }).kind, 'html_artifact');
  assert.equal(htmlArtifactActivity({ name: 'ordinary' }), null);
  const { makeEntry, applyUpdate, applyEnd, entryFromHistory } = await import('../public/tool-model.js');
  const live = makeEntry({ toolName: 'html_preview', toolCallId: 'call', args: { html: raw } });
  applyUpdate(live, { partialResult: result() }); applyEnd(live, { result: result() });
  safe(live); assert.equal(live.args, null); assert.equal(live.output, ''); assert.equal(live.details, null);
  const history = entryFromHistory({ name: 'html_preview', arguments: { html: raw } }, { ...result(), toolName: 'html_preview' });
  safe(history); assert.equal(history.args, null); assert.equal(history.output, ''); assert.equal(history.details, null);
});

test('ordinary named tool output is not replaced with an HTML preview summary', async () => {
  const { createHtmlArtifactProjection } = await import('../server/html-artifact-projection.js');
  const project = createHtmlArtifactProjection(), original = { content: [{ type: 'text', text: 'ordinary result' }], details: { kind: 'plan' } };
  project({ type: 'tool_execution_start', bridgeRun: 1, toolCallId: 'ordinary', toolName: 'gui_plan' });
  assert.deepEqual(project({ type: 'tool_execution_end', bridgeRun: 1, toolCallId: 'ordinary', result: original }).result, original);
});
