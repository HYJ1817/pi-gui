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

export function createEventBus({ backlogMax = DEFAULT_BACKLOG_MAX } = {}) {
  const clients = new Set();
  const pings = new Map();
  const backlog = [];
  let seq = 0;

  function frame(event) {
    return `data: ${JSON.stringify(event)}\n\n`;
  }

  /** 广播一条事件。会就地给事件挂上 _seq —— 调用方传进来的对象会被改写。 */
  function publish(event) {
    event._seq = ++seq;
    backlog.push(event);
    if (backlog.length > backlogMax) backlog.shift();
    const line = frame(event);
    for (const res of clients) {
      try {
        res.write(line);
      } catch {
        /* 连接已断，close 回调会清理 */
      }
    }
  }

  /** 处理 GET /api/events：开一条 SSE 长连接。 */
  function subscribe(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': pi-gui event stream\n\n');
    for (const evt of backlog) {
      try {
        res.write(frame(evt));
      } catch {
        break;
      }
    }
    clients.add(res);

    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* noop */
      }
    }, 25000);
    pings.set(res, ping);

    req.on('close', () => {
      clearInterval(ping);
      pings.delete(res);
      clients.delete(res);
    });
  }

  /** 关闭时把所有连接收掉 —— 否则 server.close() 会一直等它们自然结束。 */
  function closeAll() {
    for (const res of clients) {
      clearInterval(pings.get(res));
      try {
        res.end();
      } catch {
        /* noop */
      }
    }
    clients.clear();
    pings.clear();
  }

  return {
    publish,
    subscribe,
    closeAll,
    backlog: () => backlog,
    clientCount: () => clients.size,
  };
}
