/* pi-subagents 0.73.1: allowlist projection, never child transcripts or raw args.
 * No script parsing, agent registry, tool execution or orchestration here. */
export const SUBAGENT_TOOLS = Object.freeze(['subagent', 'subagents_enable', 'bg_wait', 'subagent_supervisor']);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value.slice(0, 24) : [];
const text = (value, max = 180) => typeof value === 'string' ? value.replace(/[\s\u0000-\u001f]+/g, ' ').trim().slice(0, max) : '';
const states = new Set(['pending', 'queued', 'running', 'complete', 'completed', 'failed', 'partial', 'paused', 'stopped', 'detached', 'rejected']);
const stateOf = value => states.has(value) ? value : 'unknown';
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
function progressFacts(value) {
  const p = object(value); const bits = [];
  if (text(p.currentTool, 80)) bits.push('Tool: ' + text(p.currentTool, 80));
  for (const [field, label] of [['toolCount', 'tools'], ['turnCount', 'turns'], ['tokens', 'tokens'], ['durationMs', 'ms']]) {
    if (Number.isFinite(p[field]) && p[field] >= 0) bits.push(`${label}: ${Math.floor(p[field])}`);
  }
  return bits.join(' · ');
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
  return { label, status, known: true, summary: summary.slice(0, 380), facts: facts.join('\n').slice(0, 8000), sources: [], diffStat: null, gitStat: null };
}
/** Only terminal successful execution evidence warrants the existing read-only debounce. */
export function subagentNeedsGitRefresh(entry) {
  const p = subagentActivity(entry); if (!p || p.status !== 'success') return false;
  const d = object(entry.details);
  if (entry.name === 'bg_wait') return list(d.completions).some(c => c?.success === true);
  if (entry.name !== 'subagent' || entry.args?.action || d.asyncId || d.background === true) return false;
  return list(d.results).some(r => resultState(object(r), false) === 'completed') || d.workflowChildren?.workflowState === 'completed';
}
