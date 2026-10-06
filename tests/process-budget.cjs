const assert = require('node:assert/strict'), { EventEmitter } = require('node:events'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
(async () => {
  const { createManagedProcesses } = await import('../server/managed-processes.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-process-budget-')), managers = [];
  const canStart = () => managers.reduce((n, m) => n + (m.snapshot().activeCount || 0), 0) <= 8;
  const launch = () => { const h = new EventEmitter(); h.stop = async () => { h.emit('close'); }; return h; };
  for (const workspace of ['A', 'B']) managers.push(createManagedProcesses({ context: () => ({ cwd, workspace }), launch, canStart }));
  let checks = 0;
  try {
    const generations = managers.map(m => m.snapshot().generation);
    await Promise.all(managers.map((m, i) => m.enable(true, generations[i])));
    for (let i = 0; i < 8; i++) await managers[0].action('start', { command: 'fixture', args: [String(i)] }, generations[0]);
    await assert.rejects(() => managers[1].action('start', { command: 'fixture', args: ['ninth'] }, generations[1]), e => e.code === 'process_limit'); checks++;
    assert.equal(managers.reduce((n, m) => n + m.snapshot().activeCount, 0), 8); checks++;
    const first = managers[0].snapshot().processes[0]; await managers[0].action('stop', { id: first.id, revision: first.revision }, generations[0]);
    await managers[1].action('start', { command: 'fixture', args: ['after close'] }, generations[1]);
    assert.equal(managers.reduce((n, m) => n + m.snapshot().activeCount, 0), 8); checks++;
    await assert.rejects(() => managers[1].action('stop', { id: first.id, revision: first.revision }, generations[1]), e => e.code === 'stale_process'); checks++;
  } finally { await Promise.all(managers.map(m => m.dispose())); fs.rmSync(cwd, { recursive: true, force: true }); }
  console.log(`Global Process budget: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
