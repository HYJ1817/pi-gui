/* Offline external-process fixture, not installed Pi. RPC response/message shapes
 * reuse candidate-pi.cjs and message-edit-target.cjs. Advertises the existing
 * tool-guard-qualified 1.3.0 contract, including the private /hello handshake.
 * Keeps real streaming and approval owners alive until an explicit command. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
if (process.argv.includes('--version')) { console.log('1.3.0'); process.exit(0); }
if (!process.argv.includes('--mode')) process.exit(0);
const sessionId = randomUUID(), cwd = process.cwd();
const dir = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', '--' + cwd.replace(/[\\/:]/g, '-') + '--');
fs.mkdirSync(dir, { recursive: true });
const sessionFile = path.join(dir, '2026-11-20T00-00-00-000Z_' + sessionId + '.jsonl');
const entries = [{ type: 'message', id: 'user-fixture', parentId: null, timestamp: 1,
  message: { role: 'user', content: [{ type: 'text', text: 'Offline retained message' }], timestamp: 1 } },
{ type: 'message', id: 'reply-fixture', parentId: 'user-fixture', timestamp: 2,
  message: { role: 'assistant', content: [{ type: 'text', text: 'Offline retained reply' }], timestamp: 2,
    api: 'openai-completions', provider: 'fixture', model: 'offline', stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }];
fs.writeFileSync(sessionFile, [{ type: 'session', version: 3, id: sessionId, cwd, timestamp: '2026-11-20T00:00:00.000Z' }, ...entries].map(JSON.stringify).join('\n') + '\n');
const send = value => console.log(JSON.stringify(value));
const trace = (type, extra = {}) => fs.appendFileSync(process.env.SYSTEM_PI_TRACE, JSON.stringify({ type, sessionId, ...extra }) + '\n');
trace('start');
if (process.env.PI_GUI_TOOL_URL) {
  // Same private child capability used by the real tool-guard extension. Keep
  // its URL/token out of RPC, traces and screenshots; do not bypass admission.
  void fetch(process.env.PI_GUI_TOOL_URL + '/hello', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pi-Gui-Tool-Token': process.env.PI_GUI_TOOL_TOKEN },
    body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(3000),
  }).then(response => response.json()).then(result => trace(result.ok ? 'guard_ready' : 'guard_failed'))
    .catch(() => trace('guard_failed'));
}
let streaming = false, timer, count = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  let command; try { command = JSON.parse(line); } catch { return; }
  trace(command.type);
  const response = data => send({ type: 'response', id: command.id, command: command.type, success: true, data });
  if (command.type === 'prompt') {
    streaming = true; send({ type: 'agent_start' });
    response({ disposition: 'started' });
    if (command.message === 'SYSTEM_APPROVAL') {
      send({ type: 'extension_ui_request', id: 'system-approval', method: 'confirm', title: '离线托盘审批', message: '等待用户明确决定。' });
    } else {
      clearInterval(timer);
      timer = setInterval(() => send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' fixture-tick-' + (++count) } }), 250);
    }
    return;
  }
  if (command.type === 'abort' || command.type === 'extension_ui_response') {
    clearInterval(timer); streaming = false; response({}); send({ type: 'agent_settled' }); return;
  }
  const model = { provider: 'fixture', id: 'offline', name: 'Offline fixture', input: ['text'], reasoning: false };
  response(command.type === 'get_state' ? { sessionId, sessionFile, model, isStreaming: streaming, isCompacting: false, pendingMessageCount: 0, messageCount: 2 }
    : command.type === 'get_messages' ? { messages: entries.map(entry => entry.message) }
      : command.type === 'get_entries' ? { entries, leafId: 'reply-fixture' }
        : command.type === 'get_tree' ? { tree: [] }
          : command.type === 'get_available_models' ? { models: [model] }
            : command.type === 'get_commands' ? { commands: [{ name: process.env.PI_GUI_EDIT_COMMAND, description: 'Fixture edit navigation' }] } : {});
});
process.stdin.on('end', () => { clearInterval(timer); process.exit(0); });
