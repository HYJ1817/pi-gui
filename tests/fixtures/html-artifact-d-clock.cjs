'use strict';
// Deterministic local scheduling fixture. No real data, network, files or sleeps.
exports.clock = function clock() {
  let now = 0, sequence = 0;
  const tasks = new Map();
  const add = (callback, delay, kind) => {
    const id = ++sequence;
    tasks.set(id, { id, callback, due: now + Math.max(0, Number(delay) || 0), kind });
    return id;
  };
  const view = {
    performance: { now: () => now },
    setTimeout: (callback, delay) => add(callback, delay, 'timer'),
    clearTimeout: id => tasks.delete(id),
    requestAnimationFrame: callback => add(callback, 16, 'frame'),
    cancelAnimationFrame: id => tasks.delete(id),
  };
  return {
    view, tasks,
    now: () => now,
    advance(milliseconds) {
      const end = now + milliseconds;
      let count = 0;
      for (;;) {
        const next = [...tasks.values()].filter(task => task.due <= end)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!next) break;
        if (++count > 100000) throw new Error('fixture scheduling did not settle');
        now = next.due; tasks.delete(next.id);
        next.callback(next.kind === 'frame' ? now : undefined);
      }
      now = end;
    },
    attach(window) {
      for (const key of ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame']) window[key] = view[key];
      Object.defineProperty(window.performance, 'now', { value: view.performance.now, configurable: true });
    },
  };
};
