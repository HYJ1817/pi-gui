/* SSE 事件总线。
 *
 * 后端 → 浏览器的唯一推送通道：pi 的事件、bridge_status、bridge_stderr
 * 全部从这里走。
 *
 * 三件事必须保持不变（有测试盯着）：
 *   1. 每条事件带单调递增的 _seq —— 断线重连时服务端补发 backlog，
 *      客户端据此去重，避免历史事件被重复渲染。
 *   2. backlog 有上限，超了从头丢。
 *   3. 新连接**先补 backlog 再入列**，顺序不能反 —— 反了会漏掉
 *      这中间产生的事件。
 */

/** 事件总线的默认 backlog 上限。 */
export const DEFAULT_BACKLOG_MAX = 800;
export const DEFAULT_BACKLOG_BYTES_MAX = 8 * 1024 * 1024;
export const DEFAULT_FRAME_BYTES_MAX = 96 * 1024 * 1024;
export const DEFAULT_CLIENT_QUEUE_BYTES_MAX = 128 * 1024 * 1024;
export const DEFAULT_CLIENTS_MAX = 8;

export function createEventBus({ backlogMax = DEFAULT_BACKLOG_MAX, getBridgeSnapshot = null,
  backlogBytesMax = DEFAULT_BACKLOG_BYTES_MAX, frameBytesMax = DEFAULT_FRAME_BYTES_MAX,
  clientQueueBytesMax = DEFAULT_CLIENT_QUEUE_BYTES_MAX, clientsMax = DEFAULT_CLIENTS_MAX } = {}) {
  const limit = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  backlogMax = limit(backlogMax, DEFAULT_BACKLOG_MAX);
  backlogBytesMax = limit(backlogBytesMax, DEFAULT_BACKLOG_BYTES_MAX);
  frameBytesMax = limit(frameBytesMax, DEFAULT_FRAME_BYTES_MAX);
  clientQueueBytesMax = limit(clientQueueBytesMax, DEFAULT_CLIENT_QUEUE_BYTES_MAX);
  clientsMax = limit(clientsMax, DEFAULT_CLIENTS_MAX);
  const clients = new Set();
  const states = new Map();
  const backlog = [];
  const backlogSizes = [];
  let backlogBytes = 0;
  let seq = 0;

  function frame(event) {
    return `data: ${JSON.stringify(event)}\n\n`;
  }

  function cleanup(res) {
    const state = states.get(res);
    if (!state) return;
    clearInterval(state.ping);
    res.removeListener?.('drain', state.drain);
    res.removeListener?.('close', state.close);
    state.req.removeListener?.('close', state.close);
    state.queue.length = 0; state.bytes = 0;
    states.delete(res); clients.delete(res);
  }

  function disconnect(res) {
    cleanup(res);
    // Fixed reason only; raw events and their payloads never become errors.
    try { if (typeof res.destroy === 'function') res.destroy(); else res.end(); } catch { /* closed */ }
  }

  function buffered(res) {
    return Number.isFinite(res.writableLength) && res.writableLength > 0 ? res.writableLength : 0;
  }

  function flush(res, state) {
    while (!state.blocked && state.queue.length && states.get(res) === state) {
      const item = state.queue.shift(); state.bytes -= item.bytes;
      if (buffered(res) + state.bytes + item.bytes > clientQueueBytesMax) { disconnect(res); return; }
      try { state.blocked = res.write(item.line) === false; } catch { disconnect(res); return; }
      if (buffered(res) + state.bytes > clientQueueBytesMax) { disconnect(res); return; }
    }
  }

  function deliver(res, line) {
    const state = states.get(res);
    if (!state) return;
    const bytes = Buffer.byteLength(line);
    if (bytes > frameBytesMax || buffered(res) + state.bytes + bytes > clientQueueBytesMax) {
      disconnect(res); return;
    }
    state.queue.push({ line, bytes }); state.bytes += bytes;
    flush(res, state);
  }

  /** 广播一条事件。会就地给事件挂上 _seq —— 调用方传进来的对象会被改写。 */
  function publish(event) {
    event._seq = ++seq;
    const line = frame(event);
    const bytes = Buffer.byteLength(line);
    if (bytes <= backlogBytesMax && bytes <= frameBytesMax && backlogMax > 0) {
      backlog.push(event); backlogSizes.push(bytes); backlogBytes += bytes;
      while (backlog.length > backlogMax || backlogBytes > backlogBytesMax) {
        backlog.shift(); backlogBytes -= backlogSizes.shift();
      }
    }
    for (const res of clients) {
      deliver(res, line);
    }
  }

  /** 处理 GET /api/events：开一条 SSE 长连接。 */
  function subscribe(req, res) {
    if (clients.size >= clientsMax) {
      res.writeHead(503, { 'Retry-After': '1', 'Cache-Control': 'no-store' });
      res.end(); return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const state = { req, queue: [], bytes: 0, blocked: false, ping: null };
    state.close = () => cleanup(res);
    state.drain = () => { if (states.get(res) !== state) return; state.blocked = false; flush(res, state); };
    states.set(res, state); clients.add(res);
    req.on('close', state.close);
    res.on?.('close', state.close); res.on?.('drain', state.drain);
    deliver(res, ': pi-gui event stream\n\n');
    for (const evt of backlog) {
      if (!states.has(res)) return;
      deliver(res, frame({ ...evt, _replay: true }));
    }
    // Synchronous replay + snapshot + subscription cannot interleave with live
    // event callbacks. The current fact is not inserted into history or numbered.
    if (getBridgeSnapshot) deliver(res, frame({ ...getBridgeSnapshot(), type: 'bridge_snapshot' }));
    if (!states.has(res)) return;

    state.ping = setInterval(() => deliver(res, ': ping\n\n'), 25000);
  }

  /** 关闭时把所有连接收掉 —— 否则 server.close() 会一直等它们自然结束。 */
  function closeAll() {
    for (const res of clients) {
      cleanup(res);
      try {
        res.end();
      } catch {
        /* noop */
      }
    }
    clients.clear();
  }

  return {
    publish,
    subscribe,
    closeAll,
    backlog: () => backlog,
    clientCount: () => clients.size,
  };
}
