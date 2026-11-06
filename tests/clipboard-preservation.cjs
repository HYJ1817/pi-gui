const assert = require('node:assert/strict');
const { preserveClipboard } = require('./fixtures/preserve-clipboard.cjs');
let passed = 0;
class Item {
  constructor(values) { this.values = values; this.types = Object.keys(values); }
  async getType(type) { return this.values[type]; }
}
function fixture(items = []) {
  return { items, writes: 0, clears: 0,
    async read() { return this.items; },
    async write(items) { this.items = items; this.writes++; },
    clear() { this.items = []; this.clears++; },
  };
}
async function check(name, run) { await run(); passed++; console.log('PASS ' + name); }
(async () => {
  const text = new Blob(['original fixture']), html = new Blob(['<p>fixture</p>']);
  await check('restores text, HTML, opaque data and bookmark in one atomic write', async () => {
    const clip = fixture([new Item({ 'text/plain': text, 'text/html': html, 'electron application/osclipboard;format="fixture"': new Blob([new Uint8Array([1, 2])]), 'electron application/bookmark': { title: 'fixture', url: 'https://example.invalid/' } })]);
    const restore = await preserveClipboard({ clipboard: clip, ClipboardItem: Item });
    clip.items = []; await restore();
    assert.equal(clip.writes, 1); assert.equal(clip.items[0].types.length, 4);
    assert.equal(await (await clip.items[0].getType('text/plain')).text(), 'original fixture');
    assert.equal(await (await clip.items[0].getType('text/html')).text(), '<p>fixture</p>');
    assert.deepEqual(await clip.items[0].getType('electron application/bookmark'), { title: 'fixture', url: 'https://example.invalid/' });
  });
  await check('materializes values before test mutations and restores at most once', async () => {
    const item = new Item({ 'text/plain': text }), clip = fixture([item]);
    const restore = await preserveClipboard({ clipboard: clip, ClipboardItem: Item });
    item.values['text/plain'] = new Blob(['later']);
    await restore(); await restore(); assert.equal(clip.writes, 1);
    assert.equal(await (await clip.items[0].getType('text/plain')).text(), 'original fixture');
  });
  await check('empty original clipboard is restored by clearing', async () => {
    const clip = fixture(), restore = await preserveClipboard({ clipboard: clip, ClipboardItem: Item });
    clip.items = [new Item({ 'text/plain': text })]; await restore();
    assert.equal(clip.items.length, 0); assert.equal(clip.clears, 1);
  });
  await check('finally restoration survives an interrupted scenario', async () => {
    const clip = fixture([new Item({ 'text/plain': text })]);
    const restore = await preserveClipboard({ clipboard: clip, ClipboardItem: Item });
    try { clip.items = []; throw Error('fixture interruption'); } catch {} finally { await restore(); }
    assert.equal(clip.items.length, 1);
  });
  for (const [name, items] of [
    ['oversize', [new Item({ 'text/plain': { size: 9 * 1024 * 1024 } })]],
    ['too many formats', [new Item(Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['fixture-' + i, new Blob([])])))]],
    ['too many items', Array.from({ length: 5 }, () => new Item({ 'text/plain': text }))],
    ['unpreservable format', [new Item({ 'text/plain': {} })]],
  ]) await check(name + ' refuses before any clipboard write', async () => {
    const clip = fixture(items);
    await assert.rejects(preserveClipboard({ clipboard: clip, ClipboardItem: Item }));
    assert.equal(clip.writes + clip.clears, 0);
  });
  console.log(`Clipboard preservation: ${passed}/${passed}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
