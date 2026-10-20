/* Session navigation safety: only temporary native-session fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
let passed = 0;
async function check(name, run) { await run(); passed++; console.log('PASS ' + name); }
(async () => {
  const { createSessions } = await import('../server/sessions.js');
  const { readSessionMessages } = await import('../server/session-history.js');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-background-'));
  try {
    const a = path.join(world, 'A'), b = path.join(world, 'B'), agent = path.join(world, 'agent');
    fs.mkdirSync(a); fs.mkdirSync(b);
    let busy = true; const calls = [];
    const sessions = createSessions({ runtime: { getCurrentCwd: () => a }, dataDir: path.join(world, 'data'),
      env: { PI_CODING_AGENT_DIR: agent }, getProjects: () => [{ path: a }, { path: b }],
      switchBlocked: () => busy, readHistory: (file, expected) => readSessionMessages(file, { expected }),
      rpc: { request: async command => { calls.push(command); return {}; } } });
    function fixture(cwd, text) {
      const id = randomUUID(), dir = path.join(agent, 'sessions', sessions._internals.dirNameFor(cwd));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, '2026-10-20T00-00-00-000Z_' + id + '.jsonl');
      fs.writeFileSync(file, [JSON.stringify({ type: 'session', version: 3, id, cwd }), JSON.stringify({ type: 'message', id: 'u', message: { role: 'user', content: [{ type: 'text', text }] } })].join('\n') + '\n');
      return { id: sessions._internals.sessionId(file), file };
    }
    const one = fixture(a, 'A private body'), two = fixture(b, 'B private body');
    await check('busy legacy switch is rejected before writing switch_session', async () => {
      const result = await sessions.switchTo(one.id);
      assert.equal(result.code, 'session_running'); assert.equal(calls.length, 0);
    });
    await check('read-only background history keeps the original runtime and cwd untouched', async () => {
      const result = await sessions.history(two.id, b);
      assert.equal(result.ok, true); assert.equal(result.messages[0].text, 'B private body');
      assert.equal(calls.length, 0); assert.ok(!JSON.stringify(result).includes(two.file));
    });
    await check('a valid session ID cannot read a different registered project', async () => {
      assert.equal((await sessions.history(two.id, a)).ok, false);
      assert.equal((await sessions.history(two.id, path.join(world, 'unknown'))).ok, false);
    });
    await check('background completion remains on the same native file and is visible on reread', async () => {
      fs.appendFileSync(two.file, JSON.stringify({ type: 'message', id: 'answer', message: { role: 'assistant', content: [{ type: 'text', text: 'finished B' }] } }) + '\n');
      const result = await sessions.history(two.id, b);
      assert.equal(result.messages.at(-1).text, 'finished B'); assert.equal(calls.length, 0);
    });
    await check('idle handoff still uses the original native switch protocol', async () => {
      busy = false; assert.equal((await sessions.switchTo(one.id)).ok, true);
      assert.equal(calls.length, 1); assert.equal(calls[0].type, 'switch_session');
    });
  } finally { fs.rmSync(world, { recursive: true, force: true }); }
  console.log(`Session background: ${passed}/${passed}; failed=0`);
})().catch(error => { console.error(error); process.exitCode = 1; });
