/* Keep a bounded, eager in-memory snapshot. Never serialize clipboard payloads. */
async function preserveClipboard({ clipboard, ClipboardItem }) {
  const original = await clipboard.read();
  let bytes = 0, formats = 0;
  const snapshot = [];
  if (original.length > 4) throw Error('Clipboard snapshot exceeds test safety limit');
  for (const item of original) {
    const values = {};
    for (const type of item.types) {
      if (++formats > 32) throw Error('Clipboard snapshot exceeds test safety limit');
      const value = await item.getType(type);
      if (type === 'electron application/bookmark') {
        values[type] = { title: value.title, url: value.url };
        bytes += Buffer.byteLength(value.title) + Buffer.byteLength(value.url);
      } else {
        if (!Number.isFinite(value.size)) throw Error('Clipboard snapshot cannot be preserved safely');
        bytes += value.size;
        values[type] = value;
      }
      if (bytes > 8 * 1024 * 1024) throw Error('Clipboard snapshot exceeds test safety limit');
    }
    snapshot.push(new ClipboardItem(values));
  }
  let restored = false;
  return async () => {
    if (restored) return;
    if (snapshot.length) await clipboard.write(snapshot);
    else clipboard.clear();
    restored = true;
  };
}
module.exports = { preserveClipboard };
