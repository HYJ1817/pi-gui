const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
(async () => {
  const { createEventBus } = await import('../server/sse.js');
  let checks = 0;
  class Response extends EventEmitter {
    constructor() { super(); this.lines = []; this.writableLength = 0; this.block = false; }
    writeHead(code) { this.code = code; }
    write(line) { this.lines.push(line); if (this.block) this.writableLength += Buffer.byteLength(line); return !this.block; }
    drain() { this.block = false; this.writableLength = 0; this.emit('drain'); }
    destroy() { this.destroyed = true; this.emit('close'); }
    end() { this.ended = true; this.emit('close'); }
    events() { return this.lines.filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(6))); }
  }
  const connect = bus => { const req = new EventEmitter(), res = new Response(); bus.subscribe(req, res); return { req, res }; };
  const byteBus = createEventBus({ backlogBytesMax: 180 });
  for (let i = 0; i < 6; i++) byteBus.publish({ type: 'unicode', text: '中🙂'.repeat(5), i });
  assert.ok(byteBus.backlog().reduce((n, e) => n + Buffer.byteLength(`data: ${JSON.stringify(e)}\n\n`), 0) <= 180); checks++;
  assert.ok(byteBus.backlog().length < 6); assert.equal(byteBus.backlog().at(-1)._seq, 6); checks++;
  const live = connect(byteBus); byteBus.publish({ type: 'large', text: '🙂'.repeat(80) });
  assert.equal(live.res.events().at(-1).type, 'large'); assert.ok(!byteBus.backlog().some(e => e.type === 'large')); checks++;
  const reconnect = connect(byteBus); assert.ok(reconnect.res.events().every(e => e._replay)); assert.ok(!reconnect.res.events().some(e => e.type === 'large')); checks++;
  byteBus.closeAll();
  const countBus = createEventBus({ backlogMax: 2, backlogBytesMax: 10000 });
  for (let i = 0; i < 4; i++) countBus.publish({ type: 'count', i });
  assert.deepEqual(countBus.backlog().map(e => e.i), [2, 3]); checks++;
  const slowBus = createEventBus({ clientQueueBytesMax: 240, frameBytesMax: 200, backlogMax: 0 });
  const slow = connect(slowBus); slow.res.block = true;
  slowBus.publish({ type: 'one', text: 'a'.repeat(30) });
  slowBus.publish({ type: 'two', text: 'b'.repeat(30) });
  assert.equal(slow.res.events().length, 1); assert.ok(!slow.res.destroyed); checks++;
  slow.res.drain(); assert.deepEqual(slow.res.events().map(e => e.type), ['one', 'two']); checks++;
  slow.res.block = true;
  for (let i = 0; i < 10; i++) slowBus.publish({ type: 'flood', text: '中'.repeat(20), i });
  assert.equal(slow.res.destroyed, true); assert.equal(slowBus.clientCount(), 0); assert.ok(slow.res.writableLength <= 240); checks++;
  const fast = connect(slowBus); slowBus.publish({ type: 'recovered' }); assert.equal(fast.res.events().at(-1).type, 'recovered'); checks++;
  slowBus.publish({ type: 'oversize', text: 'x'.repeat(300) }); assert.equal(fast.res.destroyed, true); assert.equal(slowBus.clientCount(), 0); checks++;
  slowBus.closeAll();
  const capped = createEventBus({ clientsMax: 2 }); const a = connect(capped), b = connect(capped), c = connect(capped);
  assert.equal(capped.clientCount(), 2); assert.equal(c.res.code, 503); assert.ok(c.res.ended || c.res.destroyed); checks++;
  a.req.emit('close'); const d = connect(capped); assert.equal(capped.clientCount(), 2); assert.equal(d.res.code, 200); checks++;
  capped.closeAll(); assert.equal(capped.clientCount(), 0); assert.equal(b.res.ended, true); assert.equal(d.res.ended, true); checks++;
  const replayBus = createEventBus({ getBridgeSnapshot: () => ({ state: 'ready' }), clientQueueBytesMax: 1000 });
  replayBus.publish({ type: 'before' }); const req = new EventEmitter(), res = new Response(); res.block = true; replayBus.subscribe(req, res);
  replayBus.publish({ type: 'after' }); assert.equal(res.events().length, 0); res.drain();
  assert.deepEqual(res.events().map(e => e.type), ['before', 'bridge_snapshot', 'after']);
  assert.equal(res.events()[0]._replay, true); assert.equal(res.events()[2]._replay, undefined); checks++;
  replayBus.closeAll();
  console.log(`Runtime SSE resource budgets: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
