// Actual Node dev servers under separate production session-runtime managers.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-process-scopes-')); let checks = 0;
  const check = (value, name) => { assert.ok(value, name); checks++; console.log('  ok  ' + name); };
  const pkg = path.join(root, 'node_modules/@earendil-works/pi-coding-agent'); fs.mkdirSync(path.join(pkg, 'dist/core/extensions'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.4', bin: { pi: 'cli.cjs' } }));
  fs.writeFileSync(path.join(pkg, 'dist/core/extensions/types.d.ts'), 'getAllTools() registerTool<'); const cli = path.join(pkg, 'cli.cjs');
  fs.writeFileSync(cli, `require('readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:c.type==='get_state'?{sessionId:require('path').basename(process.cwd()),isStreaming:false}:{}}));});`);
  const { createSessionRuntime } = await import('../server/session-runtime.js'); const runtimes = [], urls = [];
  async function until(fn) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } throw Error('process_scope_timeout'); }
  try {
    for (const name of ['A', 'B']) {
      const cwd = path.join(root, name); fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(cwd, 'worker.cjs'), `const server=require('http').createServer((_q,res)=>res.end(${JSON.stringify(name)}));server.listen(0,'127.0.0.1',()=>{console.log('READY '+server.address().port);console.log('Authorization: Bearer fixture-secret');});`);
      const runtime = await createSessionRuntime({ context: { cwd, owner: { conversationId: name }, isCurrent: () => true }, emit() {}, piBin: cli, dataDir: path.join(root, 'data-' + name), env: { ...process.env } });
      runtimes.push(runtime); runtime.start();
    }
    await until(() => runtimes.every(r => r.getState().state === 'ready'));
    const managers = runtimes.map(r => r.managed.manager), generations = managers.map(m => m.snapshot().generation);
    check(managers.every(m => !m.snapshot().enabled), 'Process权限逐session默认关闭');
    await Promise.all(managers.map((m, i) => m.enable(true, generations[i])));
    const results = await Promise.all(managers.map((m, i) => m.action('start', { command: process.execPath, args: ['worker.cjs'], ready: { type: 'log', marker: 'READY', timeoutMs: 5000 } }, generations[i])));
    const starts = results.map(result => result.process);
    await until(() => managers.every(m => m.snapshot().processes[0]?.state === 'ready'));
    check(results.every(s => s.ok) && starts[0].id !== starts[1].id, '两受控服务真实ready且id不同');
    for (let i = 0; i < 2; i++) { const logs = await managers[i].action('logs', { id: starts[i].id, revision: starts[i].revision, cursor: 0 }, generations[i]);
      urls.push('http://127.0.0.1:' + logs.lines.find(l => /^READY \d+/.test(l.text)).text.split(' ')[1]);
      check(!JSON.stringify(logs).includes('fixture-secret'), '日志脱敏 ' + i);
    }
    check(await (await fetch(urls[0])).text() === 'A' && await (await fetch(urls[1])).text() === 'B', '服务HTTP响应与各自cwd一致');
    await assert.rejects(() => managers[0].action('stop', { id: starts[1].id, revision: starts[1].revision }, generations[0]), error => error.code === 'stale_process'); checks++;
    const old = starts[0]; await managers[0].action('restart', { id: old.id, revision: old.revision }, generations[0]);
    await until(() => managers[0].snapshot().processes[0]?.state === 'ready');
    check(await (await fetch(urls[1])).text() === 'B', 'restart A不重启B');
    const a = managers[0].snapshot().processes[0]; await managers[0].action('stop', { id: a.id, revision: a.revision }, generations[0]);
    check(await (await fetch(urls[1])).text() === 'B', 'stop A不停止B');
    await runtimes[0].dispose(); check(runtimes[0].cleanupConfirmed() && await (await fetch(urls[1])).text() === 'B', 'dispose A整树清理B继续RPC和HTTP');
    await runtimes[1].dispose(); await until(async () => { try { await fetch(urls[1]); return false; } catch { return true; } });
    check(runtimes[1].cleanupConfirmed(), '退出清理B服务实际关闭');
    console.log(`Runtime Process real ${process.platform}: ${checks}/${checks}`);
  } finally { await Promise.allSettled(runtimes.map(r => r.dispose())); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
