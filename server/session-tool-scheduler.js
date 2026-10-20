import fs from 'node:fs';
import path from 'node:path';

const failure = code => Object.assign(Error(code), { code });
const within = (a, b) => { const p = path.relative(a, b); return !p || p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;

// This coordinates cooperating GUI tool dispatch, not external processes or an
// OS sandbox. Unknown tools/shells take a write lease; only proven native reads
// may bypass. Directory overlap matters even for two different project entries.
export function createSessionToolScheduler({ admission = null } = {}) {
  const channels = new Set(), waiting = [];
  let disposed = false;
  const overlaps = (a, b) => within(a.root, b.root) || within(b.root, a.root);
  function validate(c) {
    const st = fs.statSync(c.path), real = key(fs.realpathSync.native(c.path));
    if (st.dev !== c.identity.dev || st.ino !== c.identity.ino || st.birthtimeMs !== c.identity.birthtimeMs || real !== c.root) throw failure('stale_workspace');
  }
  const notify = (c, call, waiting) => { try { c.onState?.({ callId: call.id, waiting }); } catch { /* display only */ } };
  const active = c => [...c.calls.values()].some(call => call.granted && !call.readOnly);
  function grant(c, call) {
    validate(c);
    call.releaseWriter = call.readOnly ? null : admission?.enterWriter(c.path);
    call.granted = true; notify(c, call, false); call.resolve();
  }
  function pump() {
    for (let i = 0; i < waiting.length;) {
      const call = waiting[i], c = call.channel;
      const blocked = [...channels].some(other => other !== c && overlaps(c, other) && active(other));
      const earlier = waiting.slice(0, i).some(other => other.channel !== c && overlaps(c, other.channel));
      if (blocked || earlier && !active(c)) { i++; continue; }
      waiting.splice(i, 1);
      try { grant(c, call); } catch (e) { c.calls.delete(call.id); call.reject(e.code ? e : failure('stale_workspace')); }
    }
  }
  function remove(c, id, cancelOnly = false) {
    const call = c.calls.get(id);
    if (!call || cancelOnly && call.granted) return;
    c.calls.delete(id);
    const index = waiting.indexOf(call); if (index >= 0) waiting.splice(index, 1);
    if (!call.granted) call.reject(failure('tool_wait_cancelled'));
    call.releaseWriter?.(); notify(c, call, false);
  }
  return {
    busy: () => [...channels].some(channel => channel.calls.size > 0),
    channel(root, { onState } = {}) {
      if (disposed) throw failure('tool_guard_unavailable');
      const c = { path: root, root: key(fs.realpathSync.native(root)), identity: fs.statSync(root), calls: new Map(), paused: false, closed: false, onState };
      channels.add(c);
      return {
        async acquire(id, { readOnly = false } = {}) {
          if (disposed || c.closed || c.paused) throw failure('tool_wait_cancelled');
          if (typeof id !== 'string' || !id || id.length > 256 || c.calls.has(id) || c.calls.size >= 128) throw failure('invalid_tool_call');
          validate(c);
          return new Promise((resolve, reject) => {
            const call = { channel: c, id, readOnly, resolve, reject, granted: false }; c.calls.set(id, call);
            if (readOnly) { try { grant(c, call); } catch (e) { c.calls.delete(id); reject(e); } }
            else { waiting.push(call); notify(c, call, true); pump(); }
          });
        },
        release(id) { remove(c, id); pump(); },
        cancel(id) { remove(c, id, true); pump(); },
        pause() { c.paused = true; for (const id of [...c.calls.keys()]) remove(c, id, true); pump(); },
        resume() { if (!c.closed) c.paused = false; },
        settle() { for (const id of [...c.calls.keys()]) remove(c, id); pump(); },
        close(confirmed = false) {
          c.closed = true;
          for (const id of [...c.calls.keys()]) remove(c, id, !confirmed);
          if (!c.calls.size) channels.delete(c);
          pump();
        },
      };
    },
    dispose() {
      disposed = true;
      for (const c of channels) for (const id of [...c.calls.keys()]) remove(c, id);
      channels.clear();
    },
  };
}
