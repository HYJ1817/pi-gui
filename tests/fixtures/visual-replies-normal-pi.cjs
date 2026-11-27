'use strict';
// OFFLINE fake Pi, deliberately labelled as such. Real bundled extensions and
// private bridge execute, but every assistant/token/tool event here is synthetic.
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const cwd = process.cwd(), dir = arg('--session-dir') || path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', '--' + path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--');
fs.mkdirSync(dir, { recursive: true });
let native, file, entries, leafId, streaming = false;
const hooks = new Map(), tools = new Map();
function open(resume) {
  native = resume ? JSON.parse(fs.readFileSync(resume, 'utf8').split('\n')[0]).id : randomUUID();
  file = resume || path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '_' + native + '.jsonl');
  if (!resume) fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: native, cwd, timestamp: new Date().toISOString() }) + '\n');
  entries = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map(JSON.parse); leafId = entries.at(-1)?.id ?? null;
}
open(arg('--session'));
const ctx = { cwd, sessionManager: { getSessionId: () => native, getLeafId: () => leafId, getBranch: () => entries } };
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const response = (c, data = {}) => send({ type: 'response', id: c.id, command: c.type, success: true, data });
const append = message => {
  const entry = { type: 'message', id: randomUUID().slice(0, 8), parentId: leafId, timestamp: new Date().toISOString(), message };
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
    (await import(pathToFileURL(process.argv[++i]).href)).default(api);
  }
  await notify('session_start');
})();
function assistant(content, stopReason = 'stop') {
  return { role: 'assistant', api: 'offline-fixture', provider: 'fixture', model: 'no-model', content, stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function run(c) {
  streaming = true; response(c, { disposition: 'started' });
  append({ role: 'user', content: c.message, timestamp: Date.now() }); send({ type: 'agent_start' });
  const samples = JSON.parse(fs.readFileSync(process.env.VISUAL_REPLIES_SAMPLES, 'utf8'));
  const id = /sample:([a-z-]+)/.exec(c.message)?.[1];
  const chosen = id ? samples.filter(row => row.id === id) : samples;
  for (const row of chosen) {
    const call = randomUUID(), args = { title: row.title, html: row.html, height: row.height };
    const msg = assistant([{ type: 'toolCall', id: call, name: 'html_render', arguments: args }], 'toolUse');
    append(msg); send({ type: 'message_start', message: msg }); send({ type: 'message_end', message: msg });
    send({ type: 'tool_execution_start', toolName: 'html_render', toolCallId: call, args });
    const result = await tools.get('html_render').execute(call, args, undefined, undefined, ctx);
    append({ role: 'toolResult', toolCallId: call, toolName: 'html_render', ...result, timestamp: Date.now() });
    send({ type: 'tool_execution_end', toolName: 'html_render', toolCallId: call, result, isError: result.isError === true });
    if (result.isError) throw Error('fixture_publish_failed');
  }
  const text = 'OFFLINE_FIXTURE_FOLLOWUP：可视化之后的文字仍可继续。';
  const msg = assistant([{ type: 'text', text: '' }]);
  send({ type: 'message_start', message: msg });
  for (const delta of [text.slice(0, 25), text.slice(25)]) {
    msg.content[0].text += delta;
    send({ type: 'message_update', message: msg, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: msg } });
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  append(msg); send({ type: 'message_end', message: msg });
  streaming = false; await notify('agent_settled'); send({ type: 'agent_end', messages: [] }); send({ type: 'agent_settled', aborted: false });
}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => { void (async () => {
  await ready; const c = JSON.parse(line);
  if (c.type === 'prompt') { void run(c).catch(() => process.exit(31)); return; }
  if (c.type === 'get_state') return response(c, { sessionId: native, sessionFile: file, isStreaming: streaming, isCompacting: false,
    pendingMessageCount: 0, messageCount: entries.length, model: { provider: 'fixture', id: 'no-model' } });
  if (c.type === 'get_entries') return response(c, { entries, leafId });
  if (c.type === 'get_messages') return response(c, { messages: entries.filter(row => row.type === 'message').map(row => row.message) });
  if (c.type === 'get_tree') return response(c, { tree: [], leafId });
  if (c.type === 'get_commands') return response(c, { commands: [] });
  if (c.type === 'get_available_models') return response(c, { models: [] });
  if (c.type === 'new_session' || c.type === 'switch_session') {
    await notify('session_shutdown'); open(c.type === 'switch_session' ? c.sessionPath : null); await notify('session_start'); return response(c, { cancelled: false });
  }
  if (c.type === 'abort') streaming = false;
  response(c);
})().catch(() => process.exit(32)); });
