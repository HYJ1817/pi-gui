import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const OWNER_KEYS = ['backendInstance', 'projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'conversationId', 'runtimeId', 'runtimeGeneration', 'sessionId'];
const COMMANDS = new Set(['prompt', 'steer', 'follow_up', 'abort', 'get_state', 'get_messages', 'get_tree', 'get_session_stats', 'get_available_models', 'get_commands', 'set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'set_session_name', 'extension_ui_response', 'compact']);
const TURNS = new Set(['prompt', 'steer', 'follow_up']);
const MAX_PENDING_TURNS = 32;
const fail = code => Object.assign(Error(code), { code });
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const rootKey = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);

// A registry owns lifetimes, not Pi's session schema. All executable adapters and
// workspace admission/health are injected by the composition root.
export function createRuntimeRegistry({ dataDir, factory, resolveWorkspace, validateWorkspace = async () => {},
  publish = () => {}, externalCount = () => 0, beforeStart = () => null, beforeCommand = () => null,
  admission = (_args, action) => action(), onFocus = async () => {}, maxEvents = 200, maxBytes = 1024 * 1024,
  logEvent = null } = {}) {
  const diagLog = typeof logEvent === 'function' ? logEvent : () => {};
  const safeLog = (event, details = {}) => { try { diagLog(event, details); } catch { /* observation only */ } };
  const backendInstance = randomUUID(), records = new Map(), lives = new Map(), leases = new Map(), revisions = new Map();
  let revision = 0, contextRevision = 0;
  fs.mkdirSync(dataDir, { recursive: true });
  const dataRoot = fs.realpathSync(dataDir), manifest = path.join(dataRoot, 'conversations.json');
  const rootIdentity = fs.statSync(dataRoot);
  let queue = Promise.resolve(), disposed = false, invalid = false, focused = null;
  try {
    if (fs.existsSync(manifest)) {
      if (fs.lstatSync(manifest).isSymbolicLink() || fs.statSync(manifest).size > 1024 * 1024) throw Error();
      const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > 256) throw Error();
      for (const r of value.items) {
        if (!closed(r, ['conversationId', 'workspace', 'sessionId', 'sessionLocator', 'sessionIdentity', 'sessionName', 'createdAt']) || typeof r.conversationId !== 'string'
          || !/^[\da-f-]{36}$/.test(r.conversationId) || records.has(r.conversationId)
          || !closed(r.workspace, ['projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'cwd', 'root', 'branch'])
          || (r.sessionName !== undefined && (typeof r.sessionName !== 'string' || r.sessionName.length > 200))
          || (r.sessionIdentity != null && (!closed(r.sessionIdentity, ['dev', 'ino', 'birthtimeMs'])
            || !['dev', 'ino', 'birthtimeMs'].every(k => typeof r.sessionIdentity[k] === 'number' && Number.isFinite(r.sessionIdentity[k]))))
          || !['projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'cwd', 'root'].every(k => typeof r.workspace[k] === 'string')) throw Error();
        records.set(r.conversationId, r);
      }
    }
  } catch { invalid = true; records.clear(); }
  function guardStore() {
    try {
      const now = fs.statSync(dataRoot);
      if (disposed || invalid || fs.realpathSync(dataRoot) !== dataRoot || now.dev !== rootIdentity.dev || now.ino !== rootIdentity.ino
        || (fs.existsSync(manifest) && fs.lstatSync(manifest).isSymbolicLink())) throw Error();
    } catch {
      safeLog('runtime.owner_rejected', { operation: 'guard', reason: 'registry_unavailable' });
      throw fail('registry_unavailable');
    }
  }
  function save() {
    guardStore(); const tmp = path.join(dataRoot, `.conversations-${randomUUID()}.tmp`);
    try { fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: [...records.values()] }), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, manifest); }
    catch { throw fail('metadata_write_failed'); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  function serialize(action) { const task = queue.catch(() => {}).then(action); queue = task.catch(() => {}); return task; }
  function owner(live) { return { backendInstance, ...Object.fromEntries(['projectId', 'repoId', 'workspaceId', 'workspaceEpoch'].map(k => [k, live.record.workspace[k]])),
    conversationId: live.record.conversationId, runtimeId: live.id, runtimeGeneration: live.generation, sessionId: live.sessionId }; }
  function belongs(live) { return !disposed && lives.get(live.record.conversationId) === live && !live.retired; }
  function resolve(expected, allowRetired = false) {
    if (!closed(expected, OWNER_KEYS) || OWNER_KEYS.some(k => !Object.hasOwn(expected, k))) {
      safeLog('runtime.owner_rejected', { operation: 'resolve', reason: 'owner_shape' });
      throw fail('stale_runtime');
    }
    const live = lives.get(expected.conversationId);
    if (!live || (!allowRetired && !belongs(live)) || OWNER_KEYS.some(k => owner(live)[k] !== expected[k])) {
      safeLog('runtime.owner_rejected', { operation: 'resolve', reason: 'owner_stale' });
      throw fail('stale_runtime');
    }
    return live;
  }
  function disposeResource(live, resource) {
    resource.invalid = true;
    if (resource.disposal) return resource.disposal;
    resource.disposal = Promise.resolve().then(() => resource.dispose()).then(() => {
      live.resources.delete(resource);
    }).catch(() => { resource.disposal = null; throw fail('cleanup_pending'); });
    return resource.disposal;
  }
  function invalidateResources(live) {
    const resources = [...live.resources];
    for (const resource of resources) resource.invalid = true;
    return Promise.allSettled(resources.map(resource => disposeResource(live, resource))).then(results => {
      if (results.some(result => result.status === 'rejected')) throw fail('cleanup_pending');
    });
  }
  function settleResources(live) {
    // Focus may happen inside a resource's preparing operation. Waiting here
    // would make focus -> dispose -> prepare -> focus a lifecycle deadlock.
    // Revocation is synchronous; retire still awaits every retained disposal.
    void invalidateResources(live).catch(() => {
      if (belongs(live)) { live.error = 'cleanup_pending'; changed(live); }
    });
  }
  function bindResource(expected, resource) {
    const live = resolve(expected);
    if (!closed(resource, ['dispose']) || typeof resource.dispose !== 'function') throw fail('invalid_request');
    if (live.resources.size >= 32) throw fail('runtime_resource_limit');
    const binding = { expected: { ...expected }, dispose: resource.dispose, invalid: false, disposal: null };
    live.resources.add(binding);
    return Object.freeze({ isCurrent() {
      if (binding.invalid) return false;
      try { return resolve(binding.expected) === live; } catch { return false; }
    }, dispose: () => disposeResource(live, binding) });
  }
  function summary(record) {
    const live = lives.get(record.conversationId);
    return { conversationId: record.conversationId, workspace: { ...record.workspace },
      /* P32.4：侧栏要按**创建时间**排会话，且点击不得让行换位。排序键必须来自
       * 后端持久记录（record.createdAt），不能由前端按「最近活动」猜 ——
       * 那正是「点一下行就跳位置」的来源。 */
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
      nativeSessionId: record.sessionId || null, sessionName: record.sessionName || null, title: record.sessionName || record.workspace.branch || '并行会话',
      revision: revisions.get(record.conversationId) || 0,
      owner: live ? owner(live) : null, lifecycle: live?.lifecycle || 'dormant', activity: live?.activity || 'idle',
      attention: live?.attention === true, focused: focused === record.conversationId, historyRequired: live?.historyRequired === true,
      error: live?.error || null, stop: live?.adapter?.getState().stop || null };
  }
  function snapshot() { return { ok: !invalid, backendInstance, focusedConversationId: focused, liveCount: lives.size,
    totalCount: lives.size + externalCount(), limit: 2, hardLimit: 3, items: [...records.values()].map(summary) }; }
  function touch(live) { revisions.set(live.record.conversationId, ++revision); }
  function changed(live) { if (belongs(live)) { touch(live); publish({ type: 'runtime_state', owner: owner(live), item: summary(live.record) }); } }
  function emit(live, event) {
    if (!belongs(live) || !event || typeof event.type !== 'string') return;
    if (Number.isInteger(event.bridgeRun)) {
      if (event.bridgeRun < live.bridgeRun) return;
      if (event.bridgeRun > live.bridgeRun) { live.bridgeRun = event.bridgeRun; if (live.everReady) {
        live.generation = randomUUID();
        settleResources(live);
      } }
    }
    if (event.type === 'bridge_status') {
      live.lifecycle = event.state === 'ready' ? 'ready' : ['error', 'exited'].includes(event.state) ? 'error' : 'starting';
      if (event.state === 'ready') {
        live.everReady = true;
        const generation = live.generation;
        void refreshSession(live).catch(() => {
          if (!belongs(live) || generation !== live.generation) return;
          // A failed private read cannot establish native identity. Keep the
          // child, slot and lease owned until explicit close/restart; publish
          // only a fixed code, never upstream request error or worker payload.
          live.lifecycle = 'error'; live.error = 'session_state_unconfirmed'; live.attention = true;
          changed(live);
        });
      }
      else { live.activity = 'idle'; live.agentActive = false; live.pendingTurns.clear(); if (!live.everReady) live.sessionId = null; }
      if (['error', 'exited'].includes(event.state)) { live.error = 'runtime_unavailable'; live.attention = true; }
    }
    if (event.type === 'agent_start') { live.agentActive = true; if (live.activity !== 'stopping') live.activity = 'running'; }
    if (event.type === 'agent_settled') { live.agentActive = false; live.pendingTurns.clear(); live.approvals.clear(); if (live.activity !== 'stopping') live.activity = 'idle'; if (focused !== live.record.conversationId) live.attention = true; }
    // A response settles only its captured request. Other requests may still be
    // awaiting acknowledgement, even before the first agent_start arrives.
    if (event.type === 'response' && typeof event.success === 'boolean' && TURNS.has(event.command) && live.pendingTurns.get(event.id) === event.command) {
      live.pendingTurns.delete(event.id);
      if (event.success === true && event.data?.disposition !== 'handled') live.agentActive = true;
      if (!live.agentActive && !live.pendingTurns.size && live.activity !== 'stopping') live.activity = 'idle';
    }
    if (event.type === 'stop_state') { live.activity = event.pending ? 'stopping' : 'idle'; if (!event.pending) { live.agentActive = false; live.pendingTurns.clear(); live.approvals.clear(); } }
    if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
      if (!live.approvals.has(event.id) && live.approvals.size >= 32) live.approvals.delete(live.approvals.keys().next().value);
      live.approvals.set(event.id, event);
    }
    if (event.type === 'bridge_status' && event.state !== 'ready') live.approvals.clear();
    if (event.type === 'extension_ui_request' || event.type === 'extension_error') live.attention = true;
    if (event.generationResult?.outcome === 'failed') { live.error = 'generation_failed'; live.attention = true; }
    // Diagnostic raw lines are never retained in parallel conversation buffers.
    if (event.type === 'bridge_stderr' || event.type === 'bridge_parse_error') { changed(live); return; }
    const frame = { type: 'runtime_event', owner: owner(live), eventSequence: ++live.sequence, event };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (bytes <= maxBytes) { live.events.push({ frame, bytes }); live.bytes += bytes; }
    else live.historyRequired = true;
    while (live.events.length > maxEvents || live.bytes > maxBytes) { live.bytes -= live.events.shift().bytes; live.historyRequired = true; }
    publish(frame); changed(live);
  }
  async function refreshSession(live) {
    const generation = live.generation;
    const state = await live.adapter?.request({ type: 'get_state' });
    if (!belongs(live) || generation !== live.generation || typeof state?.sessionId !== 'string' || !state.sessionId || state.sessionId.length > 128) return;
    if (live.record.sessionId && live.record.sessionId !== state.sessionId) {
      // Resume must select the proven disk session. Do not silently attach --continue.
      live.error = 'session_mismatch';
      safeLog('runtime.session_switch_failed', { phase: 'binding', code: 'session_mismatch' });
      void close(owner(live)).catch(() => {}); return;
    }
    for (const other of lives.values()) if (other !== live && other.sessionId === state.sessionId) {
      live.error = 'session_in_use';
      safeLog('runtime.session_switch_failed', { phase: 'binding', code: 'session_in_use' });
      void close(owner(live)).catch(() => {}); return;
    }
    live.sessionId = state.sessionId;
    // The factory must prove any path against the scanner/header before persistence.
    const locator = live.adapter.sessionLocator ? await live.adapter.sessionLocator(state) : null;
    if (!belongs(live) || generation !== live.generation) return;
    live.record.sessionId = state.sessionId; live.record.sessionLocator = locator;
    live.record.sessionIdentity = null;
    if (locator) try { const st = fs.statSync(locator); live.record.sessionIdentity = { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs }; } catch {}
    if (typeof state.sessionName === 'string') live.record.sessionName = state.sessionName.trim().replace(/\s+/g, ' ').slice(0, 200);
    try { save(); } catch { live.error = 'metadata_write_failed'; }
    changed(live);
  }
  async function launchRecord(record, options = {}) {
    guardStore(); const blocked = beforeStart(); if (blocked) throw fail(blocked);
    if (!options.workspaceChecked) await validateWorkspace(record.workspace); guardStore();
    if (beforeStart()) throw fail(beforeStart());
    const key = rootKey(fs.realpathSync(record.workspace.root));
    if (leases.has(key)) throw fail('workspace_in_use');
    const total = lives.size + externalCount();
    if (total >= 3 || (total >= 2 && options.allowThird !== true)) throw fail('runtime_limit');
    const live = { record, id: randomUUID(), generation: randomUUID(), sessionId: null, lifecycle: 'starting', activity: 'idle', agentActive: false, pendingTurns: new Map(),
      sequence: 0, events: [], bytes: 0, bridgeRun: 0, everReady: false, attention: false, historyRequired: false, error: null, retired: false, key, resources: new Set(), approvals: new Map() };
    leases.set(key, live); lives.set(record.conversationId, live); changed(live);
    try {
      live.adapter = await factory({ cwd: record.workspace.cwd, workspace: { ...record.workspace }, owner: owner(live),
        sessionId: record.sessionId, sessionLocator: record.sessionLocator, isCurrent: () => belongs(live), getOwner: () => owner(live) }, event => emit(live, event));
      if (!belongs(live)) throw fail('stale_runtime');
      live.adapter.start();
      return { ok: true, conversationId: record.conversationId, owner: owner(live), item: summary(record) };
    } catch (e) {
      live.lifecycle = 'error'; live.error = 'runtime_start_failed';
      safeLog('runtime.start_failed', { phase: 'factory', code: e && e.code ? e.code : 'runtime_start_failed' });
      if (!live.adapter) { lives.delete(record.conversationId); leases.delete(key); }
      else await retire(live).catch(() => {});
      throw fail(e.code || 'runtime_start_failed');
    }
  }
  function start(args) {
    if (!closed(args, ['id', 'epoch', 'project', 'allowThird'])) return Promise.reject(fail('invalid_request'));
    return serialize(() => admission(args, async admitted => {
      guardStore(); if (records.size >= 256) throw fail('conversation_limit');
      const workspace = admitted || await resolveWorkspace(args);
      const record = { conversationId: randomUUID(), workspace, sessionId: null, sessionLocator: null, createdAt: new Date().toISOString() };
      records.set(record.conversationId, record); save();
      try { return await launchRecord(record, { ...args, workspaceChecked: Boolean(admitted) }); }
      catch (e) { if (!lives.has(record.conversationId)) records.delete(record.conversationId); save(); throw e; }
    }));
  }
  function resume(id, options = {}) {
    return serialize(async () => { const record = records.get(id); if (!record) throw fail('unknown_conversation');
      if (lives.has(id)) throw fail('workspace_in_use');
      return admission({ id: record.workspace.workspaceId, epoch: record.workspace.workspaceEpoch }, admitted => {
        if (admitted && ['projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'cwd', 'root', 'branch'].some(k =>
          ['cwd', 'root'].includes(k) ? rootKey(admitted[k]) !== rootKey(record.workspace[k]) : admitted[k] !== record.workspace[k])) throw fail('stale_workspace');
        return launchRecord(record, { ...options, workspaceChecked: Boolean(admitted) });
      }); });
  }
  async function command(expected, cmd) {
    let live = resolve(expected);
    if (!cmd || !COMMANDS.has(cmd.type) || typeof cmd.id === 'number' || Object.hasOwn(cmd, 'sessionPath') || Object.hasOwn(cmd, '__owner')) throw fail('invalid_command');
    if (cmd.type !== 'abort') { await validateWorkspace(live.record.workspace); live = resolve(expected); }
    const blocked = beforeCommand(cmd, live); if (blocked && cmd.type !== 'abort') {
      safeLog('runtime.owner_rejected', { operation: 'command', reason: 'before_command' });
      throw fail(blocked);
    }
    if (live.lifecycle !== 'ready') {
      safeLog('runtime.owner_rejected', { operation: 'command', reason: 'runtime_not_ready' });
      throw fail('runtime_not_ready');
    }
    if (cmd.type === 'abort') {
      live.activity = 'stopping'; changed(live);
      const result = await live.adapter.abortAndWait(cmd);
      live = resolve(expected); if (result.ok) { live.activity = 'idle'; live.agentActive = false; live.pendingTurns.clear(); live.approvals.clear(); } changed(live); return result;
    }
    if (TURNS.has(cmd.type) && live.activity === 'stopping') throw fail('stop_in_progress');
    if (cmd.type === 'prompt' && (live.agentActive || live.pendingTurns.size)) throw fail('runtime_busy');
    if (TURNS.has(cmd.type)) {
      cmd = { ...cmd, id: typeof cmd.id === 'string' ? cmd.id : randomUUID() };
      if (live.pendingTurns.has(cmd.id)) throw fail('invalid_command');
      if (live.pendingTurns.size >= MAX_PENDING_TURNS) throw fail('runtime_request_limit');
      live.pendingTurns.set(cmd.id, cmd.type);
      live.error = null; live.activity = 'running'; changed(live);
    }
    try { await live.adapter.send(cmd); resolve(expected); if (cmd.type === 'extension_ui_response') live.approvals.delete(cmd.id); }
    catch (error) {
      if (belongs(live) && TURNS.has(cmd.type)) {
        live.pendingTurns.delete(cmd.id);
        if (!live.agentActive && !live.pendingTurns.size && live.activity !== 'stopping') live.activity = 'idle';
        changed(live);
      }
      throw error;
    }
    changed(live); return { ok: true };
  }
  async function read(expected, cmd) {
    if (!['get_state', 'get_messages', 'get_session_stats', 'get_available_models', 'get_available_thinking_levels', 'get_commands'].includes(cmd?.type)) throw fail('invalid_command');
    const live = resolve(expected); await validateWorkspace(live.record.workspace); resolve(expected);
    const result = await live.adapter.request(cmd); resolve(expected);
    if (cmd.type === 'get_state' && result?.sessionId === live.sessionId && typeof result.sessionName === 'string') {
      const name = result.sessionName.trim().replace(/\s+/g, ' ').slice(0, 200);
      if (live.record.sessionName !== name) { live.record.sessionName = name; save(); changed(live); }
    }
    return result;
  }
  function events(expected, cursor = 0) {
    const live = resolve(expected);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      safeLog('runtime.owner_rejected', { operation: 'events', reason: 'invalid_cursor' });
      throw fail('invalid_cursor');
    }
    return { ok: true, owner: owner(live), cursor: live.sequence, bytes: live.bytes,
      historyRequired: live.historyRequired || (live.events.length > 0 && cursor < live.events[0].frame.eventSequence - 1),
      events: live.events.filter(e => e.frame.eventSequence > cursor).map(e => e.frame),
      approvals: [...live.approvals.values()], item: summary(live.record) };
  }
  function focus(expected) { return serialize(async () => { const live = resolve(expected), previous = focused;
    const prior = previous && previous !== live.record.conversationId ? lives.get(previous) : null;
    if (previous !== live.record.conversationId) contextRevision++;
    if (prior) for (const resource of prior.resources) resource.invalid = true;
    try { await onFocus(owner(live)); resolve(expected); }
    catch (error) { if (prior) settleResources(prior); throw error; }
    focused = live.record.conversationId; live.attention = false;
    if (prior) settleResources(prior);
    /* 焦点是**单值**：换了焦点必须把旧的那条也广播出去。只广播新的，旧会话的
     * item.focused 会一直留在前端 —— P32.4 的侧栏正是按这个字段画高亮的，
     * 于是会同时出现两行「当前」。 */
    if (previous && previous !== focused) { const prior = lives.get(previous); if (prior) changed(prior); }
    changed(live); return { ok: true, item: summary(live.record) }; }); }
  function blur(expected) { return serialize(async () => {
    const live = resolve(expected); if (focused !== live.record.conversationId) return { ok: true };
    contextRevision++; for (const resource of live.resources) resource.invalid = true;
    try { await onFocus(null); resolve(expected); }
    catch (error) { settleResources(live); throw error; }
    focused = null;
    settleResources(live); changed(live); return { ok: true };
  }); }
  function retire(live) {
    if (live.retirePromise) return live.retirePromise;
    live.closedOwner ||= owner(live);
    if (!live.retired) { live.retired = true; live.generation = randomUUID(); }
    live.lifecycle = 'disposing';
    live.retirePromise = (async () => {
      const cleanup = await Promise.allSettled([invalidateResources(live), Promise.resolve().then(() => live.adapter?.dispose())]);
      if (cleanup.some(result => result.status === 'rejected')) throw fail('cleanup_pending');
      if (live.adapter?.cleanupConfirmed && !live.adapter.cleanupConfirmed()) throw fail('cleanup_pending');
      if (leases.get(live.key) === live) leases.delete(live.key);
      if (lives.get(live.record.conversationId) === live) lives.delete(live.record.conversationId);
      if (focused === live.record.conversationId && !lives.has(live.record.conversationId)) { focused = null; contextRevision++; }
      touch(live);
      publish({ type: 'runtime_closed', backendInstance, owner: live.closedOwner, conversationId: live.record.conversationId, item: summary(live.record) });
    })().catch(e => { live.retirePromise = null; live.error = 'cleanup_pending';
      safeLog('runtime.cleanup_failed', { phase: 'retire', reason: 'cleanup_pending' });
      touch(live);
      publish({ type: 'runtime_state', owner: owner(live), item: summary(live.record) }); throw fail('cleanup_pending'); });
    return live.retirePromise;
  }
  function close(expected) { const live = resolve(expected, true); live.retired = true; return serialize(() => retire(live)); }
  async function restart(expected) { const live = resolve(expected, true), id = live.record.conversationId; await close(expected); return resume(id, { allowThird: true }); }
  async function invalidateWorkspace(id) { const results = await Promise.allSettled([...lives.values()].filter(l => l.record.workspace.workspaceId === id).map(l => retire(l))); if (results.some(r => r.status === 'rejected')) throw fail('cleanup_pending'); }
  async function healthCheck() { for (const live of [...lives.values()]) { try { await validateWorkspace(live.record.workspace); } catch { await retire(live).catch(() => {}); } } }
  async function dispose() { disposed = true; await queue.catch(() => {}); const results = await Promise.allSettled([...lives.values()].map(retire)); if (results.some(r => r.status === 'rejected')) throw fail('cleanup_pending'); }
  return { start, resume, close, restart, command, read, focus, blur, events, snapshot, dispose, healthCheck, invalidateWorkspace, bindResource,
    contextRevision: () => contextRevision,
    inUse: root => leases.has(rootKey(root)), liveCount: () => lives.size, runningCount: () => [...lives.values()].filter(l => l.activity !== 'idle').length,
    busy: () => [...lives.values()].some(l => l.activity !== 'idle' || l.lifecycle !== 'ready'),
    async closeAll() { const results = await Promise.allSettled([...lives.values()].map(retire)); if (results.some(r => r.status === 'rejected')) throw fail('cleanup_pending'); },
    getAdapter: expected => resolve(expected).adapter, getOwner: id => lives.has(id) ? owner(lives.get(id)) : null,
    /* P32.4：只给**后端**用的历史定位 —— **不进 snapshot**，也不出现在任何 SSE 帧里。
     * locator 是绑定时已证明过的绝对路径；读历史只读它，不需要、也不接受
     * Renderer 传路径。这样 dormant 会话也能看历史而不必 spawn 一个 child。 */
    historyTarget: id => { guardStore(); const record = records.get(id); return record ? historyTarget(record) : null; },
    searchTargets: projectId => { guardStore(); return [...records.values()].filter(r => r.workspace.projectId === projectId && r.sessionLocator && r.sessionId).map(historyTarget); },
    /* 持久记录只提供身份，不能授权 Git 访问。实际 cwd/root 及 lifecycle lock
     * 由 P32.2 withWorkspace 验证和持有，dormant 会话也走同一 authority。 */
    workspaceIdentityOf: id => { guardStore(); const workspace = records.get(id)?.workspace;
      return workspace ? { id: workspace.workspaceId, epoch: workspace.workspaceEpoch } : null; } };

  function historyTarget(record) {
    const w = record.workspace;
    return { sessionId: record.sessionId || null, sessionLocator: record.sessionLocator || null,
      sessionIdentity: record.sessionIdentity || null, cwd: w.cwd,
      title: record.sessionName || w.branch || '并行会话', createdAt: record.createdAt,
      locator: { projectId: w.projectId, workspaceId: w.workspaceId, workspaceEpoch: w.workspaceEpoch,
        conversationId: record.conversationId, nativeSessionId: record.sessionId || null } };
  }
}
