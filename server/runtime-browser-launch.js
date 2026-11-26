import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createGuiBrowserLaunch } from './gui-browser-launch.js';

export function createRuntimeBrowserGateway({ env = process.env } = {}) {
  const url = env.PI_GUI_RUNTIME_BROWSER_URL, token = env.PI_GUI_RUNTIME_BROWSER_TOKEN;
  /* Browser host 在 Electron 主进程里已经按单一 chain 串行处理 allocate/focus/
   * dispose。这里同样串行发送，避免批量关闭或恢复较多会话时，把私有控制面的
   * 连接堆到 listener 的 maxConnections 之上——超出的请求会被 Node 直接 reset，
   * 表现为大面积 cleanup_pending。排队只针对 Browser 生命周期控制，不参与模型
   * 回合调度，也不限制会话数量。 */
  let chain = Promise.resolve();
  function action(action, scope) {
    if (!url || !token) return Promise.resolve({ ok: true, unavailable: true });
    const task = chain.catch(() => {}).then(() => send(action, scope));
    chain = task.catch(() => {});
    return task;
  }
  function send(action, scope) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') return reject(Error('browser_unavailable'));
      const req = http.request(new URL('/action', target), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Runtime-Browser-Token': token } }, res => {
        let raw = ''; res.on('data', chunk => { raw += chunk; if (raw.length > 16384) req.destroy(); });
        res.on('end', () => { try { const result = JSON.parse(raw); if (!result.ok) return reject(Error('browser_unavailable')); resolve(result); } catch { reject(Error('browser_unavailable')); } });
      });
      req.on('error', () => reject(Error('browser_unavailable'))); req.setTimeout(5000, () => req.destroy());
      req.end(JSON.stringify({ action, scope, requestId: randomUUID() }));
    });
  }
  return { focus: scope => action('focus', scope),
    async allocate(launch, owner) {
      if (!url || !token) return null;
      // repoId is a backend registry dimension, not a Browser scope dimension.
      const { repoId, ...scope } = owner;
      const result = await action('allocate', scope);
      const adapter = createGuiBrowserLaunch({ launch, env: { PI_GUI_BROWSER_BRIDGE_URL: result.connection.url,
        PI_GUI_BROWSER_BRIDGE_TOKEN: result.connection.token, PI_GUI_BROWSER_EXTENSION: result.extensionPath } });
      return { ...adapter, dispose: () => action('dispose', scope) };
    },
  };
}
