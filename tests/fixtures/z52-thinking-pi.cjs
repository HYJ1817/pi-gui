// Offline native RPC fixture: current state and levels are returned separately,
// mutations ACK on the real stdio path. Never sends a prompt to a provider.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
if (process.argv.includes('--version')) { console.log('1.3.0'); process.exit(0); }
if (!process.argv.includes('--mode')) process.exit(0);
const sessionId = crypto.randomUUID(), cwd = process.cwd();
const folder = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', '--fixture--');
fs.mkdirSync(folder, { recursive: true });
const sessionFile = path.join(folder, sessionId + '.jsonl');
fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() }) + '\n');
const models = ['false', 'unknown', 'true', 'empty', 'off', 'read-error', 'delayed', 'reject', 'no-model'].map(id => ({
  provider: 'fixture', id, name: 'Fixture ' + id, input: ['text'], ...(id === 'unknown' ? {} : { reasoning: id !== 'false' }),
}));
let current = models[0], thinkingLevel = 'low';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (c, success, data) => console.log(JSON.stringify({ type: 'response', id: c.id, command: c.type, success, ...(data ? { data } : {}) }));
require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
  const c = JSON.parse(line);
  if (c.type === 'prompt') { send(c, false); return; }
  if (c.type === 'set_model') {
    const next = models.find(m => m.id === c.modelId && m.provider === c.provider);
    await sleep(120);
    if (!next || next.id === 'reject') { send(c, false); return; }
    current = next.id === 'no-model' ? null : next; thinkingLevel = next.id === 'off' ? 'off' : 'low'; send(c, true, next); return;
  }
  if (c.type === 'set_thinking_level') { await sleep(180); thinkingLevel = c.level; send(c, true, { level: thinkingLevel }); return; }
  if (c.type === 'get_available_thinking_levels') {
    if (current?.id === 'delayed') await sleep(500);
    if (current?.id === 'read-error') { send(c, false); return; }
    send(c, true, { levels: current?.id === 'empty' ? [] : current?.id === 'off' ? ['off'] : ['off', 'low', 'high'] }); return;
  }
  const data = c.type === 'get_state' ? { sessionId, sessionFile, model: current, thinkingLevel, isStreaming: false, messageCount: 0 }
    : c.type === 'get_available_models' ? { models } : c.type === 'get_messages' ? { messages: [] }
    : c.type === 'get_tree' ? { tree: [] } : c.type === 'get_commands' ? { commands: [] } : {};
  send(c, true, data);
});
