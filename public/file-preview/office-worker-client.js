import { OFFICE_LIMITS, officeError } from './office-policy.js';

// A new worker per parse: third-party parser caches and document bytes never
// outlive the current preview. A stalled synchronous ZIP/XML reader is killed,
// not merely raced by a timeout while it keeps consuming resources.
export function parseInWorker(ctx, kind, bytes, encoding = 'auto') {
  if (!globalThis.Worker) return Promise.reject(officeError('worker-unavailable'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./office-worker.js', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      ctx.resources.signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(officeError('cancelled'));
    const timer = setTimeout(() => finish(officeError('timeout')), OFFICE_LIMITS.parseMs);
    ctx.resources.signal.addEventListener('abort', abort, { once: true });
    ctx.resources.own(abort);
    worker.onmessage = event => {
      if (!ctx.resources.isCurrent() || ctx.resources.signal.aborted) return abort();
      if (!event.data?.ok) return finish(officeError(event.data?.code || 'invalid'));
      finish(null, event.data.result);
    };
    worker.onerror = event => { event.preventDefault(); finish(officeError('parser-unavailable')); };
    worker.onmessageerror = () => finish(officeError('invalid'));
    if (ctx.resources.signal.aborted || !ctx.resources.isCurrent()) return abort();
    // Transfer a bounded copy, not the access layer's potentially shared cache.
    const transfer = bytes.slice();
    worker.postMessage({ kind, encoding, buffer: transfer.buffer }, [transfer.buffer]);
  });
}
