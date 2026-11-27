// Copied into an isolated fake package by html-artifact-process.cjs. It implements
// Pi 1.6 RPC envelopes and v3 message entries, never loads a model or credentials.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const readline = require('node:readline');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const cwd = process.cwd(), resumed = arg('--session');
const native = resumed ? JSON.parse(fs.readFileSync(resumed, 'utf8').split('\n')[0]).id : randomUUID();
const dir = arg('--session-dir') || path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', '--' + cwd.replace(/[\\/:]/g, '-') + '--');
fs.mkdirSync(dir, { recursive: true });
const file = resumed || path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '_' + native + '.jsonl');
if (!resumed) fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: native, cwd, timestamp: new Date().toISOString() }) + '\n');
let entries = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map(line => JSON.parse(line));
let leafId = entries.at(-1)?.id ?? null, streaming = false, active = null;
const hooks = new Map(), tools = new Map();
const ctx = { cwd, sessionManager: { getSessionId: () => native, getLeafId: () => leafId, getBranch: () => entries } };
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const response = (c, data = {}) => send({ type: 'response', id: c.id, command: c.type, success: true, data });
const append = message => {
  const entry = { type: 'message', id: randomUUID(), parentId: leafId, timestamp: new Date().toISOString(), message };
  entries.push(entry); leafId = entry.id; fs.appendFileSync(file, JSON.stringify(entry) + '\n'); return entry;
};
const api = {
  on(type, fn) { const handlers = hooks.get(type) || []; handlers.push(fn); hooks.set(type, handlers); },
  registerTool(tool) { tools.set(tool.name, tool); },
  getAllTools: () => [{ name: 'write', sourceInfo: { source: 'builtin', path: 'builtin:write', scope: 'temporary', origin: 'top-level' } }],
};
const notify = async (type, event = {}) => { for (const fn of hooks.get(type) || []) await fn(event, ctx); };
const ready = (async () => {
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] !== '--extension' || !/pi-gui-(html|tool-guard)[\\/]/.test(process.argv[i + 1])) continue;
    const extension = await import(pathToFileURL(process.argv[++i]).href); extension.default(api);
  }
  await notify('session_start');
  fs.appendFileSync(path.join(cwd, 'fixture-launches.jsonl'), JSON.stringify({ native, file, pid: process.pid, guardianPid: process.ppid,
    htmlPort: Number(new URL(process.env.PI_GUI_HTML_URL).port) }) + '\n');
})();
async function settle(run, aborted = false) {
  if (active !== run) return;
  streaming = false; active = null; await notify('agent_settled'); send({ type: 'agent_settled', aborted });
}
async function run(c) {
  const own = active = { controller: new AbortController() }; streaming = true;
  append({ role: 'user', content: [{ type: 'text', text: c.message }], timestamp: Date.now() });
  const html = '<!doctype html><html><body>PROCESS_HTML_CANARY_' + path.basename(cwd) + '</body></html>';
  const args = { title: 'Offline fixture ' + path.basename(cwd), html, height: 320 };
  const assistant = append({ role: 'assistant', content: [{ type: 'toolCall', id: 'reused-call', name: 'html_render', arguments: args }], timestamp: Date.now() });
  send({ type: 'agent_start' }); response(c, { disposition: 'started' });
  send({ type: 'message_update', message: assistant.message, assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0,
    delta: JSON.stringify(args), partial: assistant.message } });
  send({ type: 'tool_execution_start', toolName: 'html_render', toolCallId: 'reused-call', args });
  const result = await tools.get('html_render').execute('reused-call', args, own.controller.signal, undefined, ctx);
  if (active !== own) return;
  send({ type: 'tool_execution_end', toolName: 'html_render', toolCallId: 'reused-call', result, isError: result.isError === true });
  // A real extension result can precede persistence: hold exactly that boundary.
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(path.join(cwd, 'fixture-allow-native')) && active === own && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  if (active !== own) return;
  append({ role: 'toolResult', toolCallId: 'reused-call', toolName: 'html_render', ...result, timestamp: Date.now() });
  await settle(own);
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => { void (async () => {
  await ready; const c = JSON.parse(line);
  if (c.type === 'prompt') { void run(c).catch(() => process.exit(31)); return; }
  if (c.type === 'abort') {
    if (active) { const own = active; own.controller.abort(); await settle(own, true); }
    response(c); return;
  }
  if (c.type === 'get_state') return response(c, { sessionId: native, sessionFile: file, isStreaming: streaming, isCompacting: false });
  if (c.type === 'get_entries') return response(c, { entries, leafId });
  if (c.type === 'get_messages') return response(c, { messages: entries.filter(row => row.type === 'message').map(row => row.message) });
  if (c.type === 'new_session' || c.type === 'switch_session' || c.type === 'fork')
    return send({ type: 'response', id: c.id, command: c.type, success: false, error: 'fixture mutation unsupported' });
  response(c);
})().catch(() => process.exit(32)); });
