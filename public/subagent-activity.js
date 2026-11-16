/* pi-subagents 0.73.1: allowlist projection, never child transcripts or raw args.
 * No script parsing, agent registry, tool execution or orchestration here. */
export const SUBAGENT_TOOLS = Object.freeze(['subagent', 'subagents_enable', 'bg_wait', 'subagent_supervisor']);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value.slice(0, 24) : [];
const text = (value, max = 180) => typeof value === 'string' ? value.replace(/[\s\u0000-\u001f]+/g, ' ').trim().slice(0, max) : '';
const states = new Set(['pending', 'queued', 'running', 'complete', 'completed', 'failed', 'partial', 'paused', 'stopped', 'detached', 'rejected']);
const stateOf = value => states.has(value) ? value : 'unknown';
const MAX_CHILD_ITEMS = 24;
const MAX_CHILD_FACTS = 8000;
function resultState(r, running) {
  if (r.stopped === true) return 'stopped';
  if (r.interrupted === true) return 'interrupted';
  if (r.timedOut === true || typeof r.error === 'string' && r.error || Number.isInteger(r.exitCode) && r.exitCode !== 0) return 'failed';
  if (r.detached === true) return 'detached';
  return running ? 'running' : r.exitCode === 0 || r.success === true ? 'completed' : 'unknown';
}
function lifecycle(entry, d, results) {
  // A missing end / parent Stop wins over the last partial child snapshot.
  if (entry.status !== 'success') return entry.status || 'unknown';
  if (d.stopped === true || results.some(r => r.stopped === true)) return 'cancelled';
  if (results.some(r => r.interrupted === true)) return 'interrupted';
  if (d.timedOut === true || results.some(r => resultState(r, false) === 'failed') || d.workflowChildren?.workflowState === 'failed') return 'error';
  return 'success';
}
function progressOf(value) {
  const p = object(value); const out = {};
  if (text(p.currentTool, 80)) out.currentTool = text(p.currentTool, 80);
  for (const field of ['toolCount', 'turnCount', 'tokens', 'durationMs']) {
    if (Number.isFinite(p[field]) && p[field] >= 0) out[field] = Math.floor(p[field]);
  }
  return Object.keys(out).length ? out : null;
}
function progressFacts(value) {
  const p = progressOf(value); if (!p) return '';
  const bits = [];
  if (p.currentTool) bits.push('Tool: ' + p.currentTool);
  for (const [field, label] of [['toolCount', 'tools'], ['turnCount', 'turns'], ['tokens', 'tokens'], ['durationMs', 'ms']]) {
    if (Number.isFinite(p[field])) bits.push(`${label}: ${p[field]}`);
  }
  return bits.join(' · ');
}
/* Row state is limited to producer evidence. Unlike the parent lifecycle, an
 * explicit success flag can already be true while the parent is still running. */
function resultRowState(r, running) {
  if (r.stopped === true) return 'stopped';
  if (r.interrupted === true) return 'interrupted';
  if (r.timedOut === true || (typeof r.error === 'string' && r.error) || (Number.isInteger(r.exitCode) && r.exitCode !== 0)) return 'failed';
  if (r.detached === true) return 'detached';
  if (r.exitCode === 0 || r.success === true) return 'completed';
  return running ? 'running' : 'unknown';
}
function countChildState(counts, state) {
  if (state === 'completed' || state === 'complete') counts.succeeded++;
  else if (state === 'failed') counts.failed++;
  else if (state === 'running') counts.running++;
}
function childRowWeight(row) {
  return 24 + (row.agent?.length || 0) + (row.model?.length || 0)
    + (row.task?.length || 0) + (row.progress?.currentTool?.length || 0)
    + (row.progress ? 64 : 0);
}
function subagentSummary(counts, shown, total, inventoryComplete) {
  const bits = [`子代理 · ${total} 项`];
  if (counts.running) bits.push('运行 ' + counts.running);
  if (counts.succeeded) bits.push('成功 ' + counts.succeeded);
  if (counts.failed) bits.push('失败 ' + counts.failed);
  if (shown < total) bits.push('显示 ' + shown);
  if (inventoryComplete === false) bits.push('清单不完整');
  return bits.join(' · ');
}
/* Parent tool facts stay untouched; this is a bounded structured view of the
 * same allowlist for the compact child list. No raw args/details, no script
 * parsing, no inferred progress or completion state. */
function subagentChildren(entry, d, status) {
  const running = status === 'running';
  const runId = text(d.runId) || text(d.asyncId);
  const w = object(d.workflowChildren);
  const linked = w.version === 1 && w.parentToolCallId === entry.id && text(w.workflowRunId) && (!runId || w.workflowRunId === runId);
  const build = (items, toRow, source, inventoryComplete) => {
    const counts = { succeeded: 0, failed: 0, running: 0 };
    const rows = []; let total = 0; let used = 0; let full = false;
    for (let i = 0; i < items.length; i++) {
      const row = toRow(items[i], i);
      if (!row) continue;
      total++;
      countChildState(counts, row.state);
      if (full) continue;
      if (rows.length >= MAX_CHILD_ITEMS) { full = true; continue; }
      const weight = childRowWeight(row);
      if (used + weight > MAX_CHILD_FACTS) { full = true; continue; }
      used += weight; rows.push(row);
    }
    if (!rows.length) return null;
    return { summary: subagentSummary(counts, rows.length, total, inventoryComplete), source, rows, total, shown: rows.length, inventoryComplete };
  };
  if (linked) {
    const seen = new Set();
    const built = build(Array.isArray(w.children) ? w.children : [], raw => {
      const child = object(raw); const childId = text(child.childId);
      if (!childId) return null;
      let key = childId;
      for (let n = 2; seen.has(key); n++) key = childId + '#' + n;
      seen.add(key);
      return { key, agent: text(child.agent), model: text(child.model), state: stateOf(child.state), progress: progressOf(child.activity) };
    }, 'workflow', w.inventoryComplete === true);
    // A bound workflow owns the child inventory. If none of its children has a
    // stable childId, do not mix in a secondary source; keep the safe facts row.
    return built;
  }
  // A result row is attributable only when the run and every producer-assigned
  // index are present and unique. Row position is not an identity; without that
  // evidence the parent keeps its existing safe facts row.
  const results = Array.isArray(d.results) ? d.results : [];
  if (runId && results.length) {
    const seen = new Set();
    const attributable = results.every(raw => {
      const index = object(raw).index;
      if (!Number.isInteger(index) || index < 0 || seen.has(index)) return false;
      seen.add(index);
      return true;
    });
    if (attributable) return build(results, raw => {
      const r = object(raw);
      return {
        key: `${runId}/${r.index}`,
        agent: text(r.agent), model: text(r.model), state: resultRowState(r, running),
        task: text(r.task, 320), progress: progressOf(r.progress),
      };
    }, 'results', null);
  }
  return null;
}
/** Parent coordination metadata only. Never inspect raw output, message or paths. */
function supervisorActivity(entry, a, d) {
  const action = text(a.action, 80);
  const status = entry.status || 'unknown';
  const running = status === 'running';
  const labels = {
    status: ['Checking supervisor channel…', 'Checked supervisor channel'],
    pending: ['Checking supervisor requests…', 'Checked supervisor requests'],
    list: ['Checking supervisor requests…', 'Listed supervisor requests'],
    reply: ['Replying to subagent…', 'Replied to subagent'],
  };
  const label = status === 'error' ? 'Supervisor action failed' : Object.hasOwn(labels, action) && (running || status === 'success') ? labels[action][running ? 0 : 1] : 'Subagent supervisor action';
  const facts = ['Action: ' + (action || 'unknown')];
  if (action === 'status') {
    if (typeof d.active === 'boolean') facts.push('Channel active: ' + d.active);
    if (Number.isSafeInteger(d.pending) && d.pending >= 0) facts.push('Pending replies: ' + d.pending);
  } else if ((action === 'pending' || action === 'list') && Array.isArray(d.pending)) {
    facts.push('Pending requests: ' + d.pending.length);
    for (const item of list(d.pending).map(object)) {
      const row = [];
      for (const [field, label] of [['id', 'Request'], ['runId', 'Run'], ['agent', 'Agent'], ['reason', 'Reason']]) {
        const value = text(item[field], field === 'reason' ? 80 : 180);
        if (value) row.push(label + ': ' + value);
      }
      if (Number.isSafeInteger(item.childIndex) && item.childIndex >= 0) row.push('Child index: ' + item.childIndex);
      if (typeof item.expectsReply === 'boolean') row.push('Expects reply: ' + item.expectsReply);
      if (row.length) facts.push(row.join(' · '));
    }
    if (d.pending.length > 24) facts.push('… request display capped at 24');
  } else if (action === 'reply') {
    for (const [field, label] of [['replyTo', 'Request'], ['runId', 'Run'], ['agent', 'Agent']]) {
      const value = text(d[field]); if (value) facts.push(label + ': ' + value);
    }
  }
  return { label, status, known: true, summary: 'Action: ' + (action || 'unknown'), facts: facts.join('\n').slice(0, 8000), sources: [], diffStat: null, gitStat: null };
}
export function subagentActivity(entry) {
  if (!SUBAGENT_TOOLS.includes(entry?.name)) return null;
  const a = object(entry.args), d = object(entry.details);
  if (entry.name === 'subagent_supervisor') return supervisorActivity(entry, a, d);
  const results = list(d.results).map(object);
  const status = lifecycle(entry, d, results);
  const running = status === 'running';
  let label;
  const facts = [];
  if (entry.name === 'subagents_enable') {
    label = running ? 'Enabling Subagents…' : status === 'success' ? 'Subagent tools enabled' : 'Subagent activation failed';
    facts.push('No child launched. Tool selection applies on a following model request.');
    if (Array.isArray(d.enabled) && d.enabled.includes('subagent')) facts.push('Enabled: subagent');
  } else if (entry.name === 'bg_wait') {
    label = running ? 'Waiting for background work…' : 'Background wait returned';
    if (d.wait) facts.push('Wait returned without completing active work: ' + list(d.wait.activeRunIds).map(id => text(id)).filter(Boolean).join(' · '));
    for (const c of list(d.completions).map(object)) {
      facts.push(`Run: ${text(c.runId) || 'unknown'} · ${stateOf(c.state)}${c.success === false ? ' · failed' : c.success === true ? ' · success' : ''}`);
      for (const r of list(c.results).map(object)) facts.push(`${text(r.agent) || 'Agent unknown'} · ${text(r.model) || 'Model unknown'}`);
    }
  } else if (text(a.action)) {
    label = 'Subagent action: ' + text(a.action, 80) + (running ? '…' : '');
    facts.push('Extension management/control call; GUI does not perform this action.');
  } else {
    const background = Boolean(text(d.asyncId)) || d.background === true || results.some(r => r.detached === true);
    label = running ? 'Delegating…' : status === 'success' && background ? 'Background launched · completion unknown' : status === 'success' && a.async === true && !results.length ? 'Background launch unconfirmed' : status === 'success' ? 'Delegation returned' : 'Delegation ' + status;
  }
  const runId = text(d.runId) || text(d.asyncId);
  if (runId) facts.push('Run: ' + runId);
  // Requested id is a control target, never evidence that an execution launched.
  if (text(a.action) || entry.name === 'bg_wait') {
    const target = text(a.id) || text(a.runId); if (target) facts.push('Requested run: ' + target);
  }
  const w = object(d.workflowChildren);
  const linked = w.version === 1 && w.parentToolCallId === entry.id && text(w.workflowRunId) && (!runId || w.workflowRunId === runId);
  if (linked) {
    facts.push(`Parent tool: ${text(w.parentToolCallId)} · Workflow: ${text(w.workflowRunId)} · ${stateOf(w.workflowState)}`);
    const children = list(w.children).map(object);
    facts.push(`Children: ${Array.isArray(w.children) ? w.children.length : 0}${w.inventoryComplete === true ? '' : ' (inventory incomplete)'}`);
    for (const child of children) {
      if (!text(child.childId)) continue;
      facts.push(`${text(child.childId)} · ${text(child.agent) || 'Agent unknown'} · ${stateOf(child.state)} · ${text(child.model) || 'Model unknown'}${text(child.runId) ? ' · Run: ' + text(child.runId) : ''}`);
      const progress = progressFacts(child.activity); if (progress) facts.push(progress);
    }
    if (Array.isArray(w.children) && w.children.length > 24) facts.push('… child display capped at 24');
  }
  for (const r of results) {
    // index is producer-assigned identity only within an evidenced run, not row position.
    const id = runId && Number.isInteger(r.index) && r.index >= 0 ? `${runId}/${r.index} · ` : '';
    facts.push(`${id}${text(r.agent) || 'Agent unknown'} · ${resultState(r, running)} · ${text(r.model) || 'Model unknown'}`);
    if (text(r.task)) facts.push('Task: ' + text(r.task, 320));
    const progress = progressFacts(r.progress); if (progress) facts.push(progress);
  }
  for (const p of list(d.progress)) { const progress = progressFacts(p); if (progress) facts.push(progress); }
  if (!results.length && !linked) facts.push('Model unknown · Child metadata unavailable');
  const summary = text(a.action) ? 'Management/control · ' + (text(a.id) || text(a.runId) || 'Run unspecified') : linked ? `Workflow · ${Array.isArray(w.children) ? w.children.length : 0} children · ${stateOf(w.workflowState)}` : entry.name === 'subagent' ? `${text(a.agent) || 'Agent unknown'} · ${text(a.task) || (text(a.workflow) ? 'Workflow: ' + text(a.workflow) : a.workflowScript || a.workflowScriptPath ? 'Workflow script · Task unavailable' : 'Task unavailable')}` : 'Pi Extension';
  const subagents = entry.name === 'subagent' && !text(a.action) ? subagentChildren(entry, d, status) : null;
  const projection = { label, status, known: true, summary: summary.slice(0, 380), facts: facts.join('\n').slice(0, 8000), sources: [], diffStat: null, gitStat: null };
  if (subagents) projection.subagents = subagents;
  return projection;
}
/** Only terminal successful execution evidence warrants the existing read-only debounce. */
export function subagentNeedsGitRefresh(entry) {
  const p = subagentActivity(entry); if (!p || p.status !== 'success') return false;
  const d = object(entry.details);
  if (entry.name === 'bg_wait') return list(d.completions).some(c => c?.success === true);
  if (entry.name !== 'subagent' || entry.args?.action || d.asyncId || d.background === true) return false;
  return list(d.results).some(r => resultState(object(r), false) === 'completed') || d.workflowChildren?.workflowState === 'completed';
}
