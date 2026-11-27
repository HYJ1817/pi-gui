const test = require('node:test');
const assert = require('node:assert/strict');
const model = import('../public/html-artifact-model.js');
const ref = () => ({ schemaVersion: 1, kind: 'html', id: 'a'.repeat(64), contentRef: 'a'.repeat(64),
  title: '交互报告 / Interactive report', sessionId: 'native-session', messageId: 'assistant-entry', toolCallId: 'call-1',
  height: 320, createdAt: '2026-11-27T00:00:00.000Z', bytes: 24, digest: 'b'.repeat(64) });

test('reference projection is closed and contains no content, path, URL or capability', async () => {
  const { projectHtmlArtifactReference: project } = await model;
  const input = { ...ref(), html: '<script>secret</script>', path: '/private', token: 'secret', url: 'https://invalid' };
  assert.deepEqual(project(input), ref());
  assert.notEqual(project(input), input);
});
test('malformed identities and unsupported versions fail closed', async () => {
  const { projectHtmlArtifactReference: project } = await model;
  for (const input of [null, [], {}, { ...ref(), schemaVersion: 2 }, { ...ref(), kind: 'image' },
    { ...ref(), id: '../file' }, { ...ref(), contentRef: 'c'.repeat(64) }, { ...ref(), sessionId: '' },
    { ...ref(), messageId: '' }, { ...ref(), toolCallId: 'x\n' }]) assert.equal(project(input), null);
});
test('title remains untrusted text and is bounded without a raw fallback', async () => {
  const { projectHtmlArtifactReference: project } = await model;
  assert.equal(project({ ...ref(), title: '<img src=x onerror=alert(1)>' }).title, '<img src=x onerror=alert(1)>');
  for (const title of ['', ' ', 'x'.repeat(161), 'a\u0000b']) assert.equal(project({ ...ref(), title }), null);
});
test('HTML resource limits reject empty, oversized and nonintegral snapshots', async () => {
  const { projectHtmlArtifactReference: project, HTML_ARTIFACT_MAX_BYTES: max } = await model;
  for (const bytes of [0, -1, max + 1, 1.5, Infinity, '24']) assert.equal(project({ ...ref(), bytes }), null);
  assert.ok(project({ ...ref(), bytes: max }));
});
test('height accepts only bounded integers and has an explicit input default', async () => {
  const { normalizeHtmlArtifactHeight: height, projectHtmlArtifactReference: project } = await model;
  assert.equal(height(undefined), 320);
  assert.equal(height(80), 80);
  assert.equal(height(2048), 2048);
  for (const value of [0, 79, 2049, 12.5, '320', Infinity]) assert.equal(height(value), null);
  assert.equal(project({ ...ref(), height: undefined }), null);
});
test('snapshot integrity and creation metadata are mandatory', async () => {
  const { projectHtmlArtifactReference: project } = await model;
  for (const change of [{ digest: '' }, { digest: 'z'.repeat(64) }, { createdAt: 'not-a-date' }, { createdAt: '' }]) {
    assert.equal(project({ ...ref(), ...change }), null);
  }
});
test('only an explicit successful typed tool result becomes an artifact', async () => {
  const { htmlArtifactFromToolResult: extract, htmlArtifactToolDetails: details } = await model;
  const result = { details: details(ref()) };
  assert.deepEqual(extract(result), ref());
  for (const value of [{ ...result, isError: true }, { details: { ...result.details, ok: false } },
    { details: { ...result.details, schemaVersion: 2 } }, { details: { artifact: ref() } },
    { content: [{ type: 'text', text: JSON.stringify(result) }] }]) assert.equal(extract(value), null);
});
test('multiple artifacts and repeated events retain stable independent identities', async () => {
  const { htmlArtifactToolDetails: details, htmlArtifactFromToolResult: extract } = await model;
  const first = ref(), second = { ...ref(), id: 'c'.repeat(64), contentRef: 'c'.repeat(64), toolCallId: 'call-2' };
  const ids = new Set([first, second, first].map(value => extract({ details: details(value) }).id));
  assert.equal(ids.size, 2);
});
