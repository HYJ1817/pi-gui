'use strict';
// Test-only descriptor counters; no payload/path retained or access decision changed.
require('./system-settings-offline.cjs');
const fs = require('node:fs');
const path = require('node:path');
const fsp = require('node:fs/promises');
const world = process.env.LARGE_MEDIA_WORLD;
if (!world || !path.isAbsolute(world)) throw Error('fixture_world_required');
const root = path.resolve(world) + path.sep;
const watched = value => typeof value === 'string' && path.resolve(value).startsWith(root) && value.endsWith('.webm');
const stats = { opened: 0, closed: 0, active: 0, readCalls: 0, actualBytes: 0, maxReadRequest: 0, maxReadResult: 0, wholeFileReads: 0, peakHeapBytes: 0, peakArrayBufferBytes: 0, peakRssBytes: 0 };
const take = () => { const m = process.memoryUsage(); stats.peakHeapBytes = Math.max(stats.peakHeapBytes, m.heapUsed); stats.peakArrayBufferBytes = Math.max(stats.peakArrayBufferBytes, m.arrayBuffers); stats.peakRssBytes = Math.max(stats.peakRssBytes, m.rss); return { ...stats }; };
for (const [owner, name] of [[fs, 'readFileSync'], [fs, 'readFile'], [fsp, 'readFile']]) {
  const original = owner[name];
  owner[name] = function (file, ...args) { if (watched(file)) stats.wholeFileReads++; return original.call(this, file, ...args); };
}
const open = fsp.open;
fsp.open = async function (file, ...args) {
  const handle = await open.call(this, file, ...args);
  if (!watched(file)) return handle;
  stats.opened++; stats.active++;
  const read = handle.read.bind(handle), close = handle.close.bind(handle);
  let closed = false;
  handle.read = async (...values) => {
    const length = typeof values[0] === 'object' && !ArrayBuffer.isView(values[0]) ? values[0].length : values[2];
    stats.readCalls++; stats.maxReadRequest = Math.max(stats.maxReadRequest, Number(length) || 0);
    const result = await read(...values);
    stats.actualBytes += result.bytesRead; stats.maxReadResult = Math.max(stats.maxReadResult, result.bytesRead); take(); return result;
  };
  handle.close = async () => { try { return await close(); } finally { if (!closed) { closed = true; stats.closed++; stats.active--; take(); } } };
  return handle;
};
process.on('message', message => { if (message?.type === 'large-media-observe' && Number.isSafeInteger(message.id) && process.connected) process.send({ type: 'large-media-observe-result', id: message.id, stats: take() }); });
