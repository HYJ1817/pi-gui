// Serialized into the opaque frame, never executed in the host. This manages
// cooperative animation/timer resources; it is not an OS CPU sandbox. Native
// Electron frame/network policies remain mandatory for hostile HTML.
export function installHtmlArtifactRuntime(view) {
  const nativeSet = view.setTimeout.bind(view), nativeClear = view.clearTimeout.bind(view);
  const nativeRaf = view.requestAnimationFrame.bind(view), nativeCancel = view.cancelAnimationFrame.bind(view);
  const now = view.performance.now.bind(view.performance);
  const records = new Map(), listeners = new Set();
  const MAX_CALLBACKS = 256;
  let sequence = 0, visible = true, disposed = false;
  function cancel(record) {
    if (record.native === null) return;
    if (record.kind === 'frame') nativeCancel(record.native);
    else nativeClear(record.native);
    record.native = null;
  }
  function arm(record) {
    if (!visible || disposed || record.native !== null) return;
    if (record.kind === 'frame') record.native = nativeRaf(time => run(record, time));
    else {
      record.due = now() + record.remaining;
      record.native = nativeSet(() => run(record), record.remaining);
    }
  }
  function run(record, time) {
    record.native = null;
    if (!visible || disposed || !records.has(record.id)) return;
    if (record.kind !== 'interval') records.delete(record.id);
    try {
      if (record.kind === 'frame') record.callback.call(view, time);
      else record.callback.apply(view, record.args);
    } finally {
      if (record.kind === 'interval' && records.has(record.id)) {
        record.remaining = record.delay; arm(record);
      }
    }
  }
  function add(kind, callback, delay, args) {
    if (disposed || typeof callback !== 'function' || records.size >= MAX_CALLBACKS) return 0;
    const duration = Math.max(kind === 'interval' ? 32 : 0, Math.min(2147483647, Number(delay) || 0));
    const record = { id: ++sequence, kind, callback, args, delay: duration, remaining: duration, native: null, due: 0 };
    records.set(record.id, record); arm(record); return record.id;
  }
  function clear(id, frame) {
    // Web IDL long (timers) / unsigned long (rAF), including numeric strings,
    // valueOf, truncation and modulo. Unary + also rejects Symbol/BigInt like
    // native conversion; Number(id) would incorrectly accept BigInt.
    const key = frame ? +id >>> 0 : +id >> 0;
    const record = records.get(key);
    // Timeout and interval clearers share one pool; animation frames do not.
    if (record && (record.kind === 'frame') === frame) { cancel(record); records.delete(key); }
  }
  function setVisible(value) {
    if (disposed || value === visible) return;
    visible = value;
    for (const record of records.values()) {
      if (!visible) {
        if (record.kind !== 'frame' && record.native !== null) record.remaining = Math.max(0, record.due - now());
        cancel(record);
      } else arm(record);
    }
    for (const listener of listeners) listener(visible);
  }
  // Lock before model code gets references. Resume without a catch-up storm;
  // this helper manages callbacks only and does not create a browsing context.
  const replacements = {
    setTimeout: (callback, delay, ...args) => add('timeout', callback, delay, args),
    setInterval: (callback, delay, ...args) => add('interval', callback, delay, args),
    clearTimeout: id => clear(id, false), clearInterval: id => clear(id, false),
    requestAnimationFrame: callback => add('frame', callback, 0, []),
    cancelAnimationFrame: id => clear(id, true),
  };
  for (const [name, value] of Object.entries(replacements)) {
    try { Object.defineProperty(view, name, { value, writable: false, configurable: false }); }
    catch { return null; } // fail closed: never parse model bytes after failure.
  }
  return {
    setVisible,
    onVisibility(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const record of records.values()) cancel(record);
      records.clear(); listeners.clear();
    },
  };
}
