const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const run = promisify(execFile);
const profile = { supported: true, profile: 'test-metadata-only', version: 1, attributes: 32, acl: 'fixture' };
const metadata = { inspectFileMetadata: async () => ({ ...profile }), preserveFileMetadata: async () => {}, protectRecoveryPath: async () => {} };
const fault = code => Object.assign(Error(code), { code });

// Real independent Windows handle, with Read/Write sharing but no Delete sharing.
// Stdin is the release handshake; a bounded lifetime also prevents leaked locks.
async function holdWithoutDeleteSharing(file) {
  const script = "$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PI_FAULT_PATH));$h=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::WriteLine('held');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{$h.Dispose()}";
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, PI_FAULT_PATH: Buffer.from(file).toString('base64') }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('held')) resolve(); });
      child.once('error', reject);
      child.once('exit', () => reject(Error('handle holder exited before handshake')));
    });
  } catch (e) { child.kill(); await exited; clearTimeout(timeout); throw e; }
  return async () => { child.stdin.end('\n'); const result = await exited; clearTimeout(timeout); assert.equal(result.code, 0, 'handle holder released normally'); };
}

(async () => {
  const { createSessionRevertWriter } = await import('../server/session-revert-writer.js');
  const { createSessionChangeStore } = await import('../server/session-change-store.js');
  const native = await import('../server/session-revert-metadata.js');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'p334a-faults-'));
  const removeFixture = async location => {
    const resolved = path.resolve(location), relative = path.relative(base, resolved);
    assert.ok(resolved === path.resolve(base) || (relative && !relative.startsWith('..') && !path.isAbsolute(relative)), 'cleanup stays inside fresh fixture');
    await fs.rm(resolved, { recursive: true, force: true });
  };
  let passed = 0, failed = 0, skipped = 0;
  const check = async (name, fn) => { try { await fn(); passed++; console.log('ok', name); } catch (e) { failed++; console.error('FAIL', name, e); } };
  const fixture = async fn => { const dir = await fs.mkdtemp(path.join(base, 'case-')); try { await fn(dir); } finally { await removeFixture(dir); } };
  const setup = async root => { await fs.writeFile(path.join(root, 'a.txt'), 'C'); const writer = createSessionRevertWriter({ metadata }); const observed = await writer.inspect(root, 'a.txt'); return { root, relativePath: 'a.txt', currentFingerprint: observed.fingerprint, currentMetadata: observed.metadata, candidate: Buffer.from('R'), backupVerified: true, stateCheck: async () => {}, recordState: async () => {} }; };
  try {
    await check('independent child replaces parent before final check; C and unrelated D survive (metadata fixture)', () => fixture(async dir => {
      const root = path.join(dir, 'parent'); await fs.mkdir(root); const args = await setup(root);
      const writer = createSessionRevertWriter({ metadata, hooks: { afterStage: async () => {
        await run(process.execPath, ['-e', "const fs=require('fs'),p=require('path');const root=process.argv[1];fs.renameSync(root,root+'-old');fs.mkdirSync(root);fs.writeFileSync(p.join(root,'a.txt'),'D');", root], { windowsHide: true, timeout: 15000 });
      } } });
      await assert.rejects(writer.apply(args), { code: 'stale_current' });
      assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'D');
      assert.equal(await fs.readFile(path.join(root + '-old', 'a.txt'), 'utf8'), 'C');
    }));
    for (const [method, code] of [['writeFile', 'ENOSPC'], ['sync', 'EIO']]) {
      await check(`injected staging ${method} ${code} leaves C; no commit (not actual full disk)`, () => fixture(async root => {
        const args = await setup(root); let commits = 0, injections = 0;
        const injected = { ...fs, open: async (...input) => {
          const handle = await fs.open(...input);
          if (input[1] === 'wx') return new Proxy(handle, { get: (target, key) => key === method ? async () => { injections++; throw fault(code); } : typeof target[key] === 'function' ? target[key].bind(target) : target[key] });
          return handle;
        }, rename: async (...input) => { commits++; return fs.rename(...input); } };
        await assert.rejects(createSessionRevertWriter({ metadata, fs: injected }).apply(args), { code });
        assert.equal(injections, 1); assert.equal(commits, 0); assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'C');
        assert.deepEqual(await fs.readdir(root), ['a.txt']);
      }));
    }
    await check('injected second staging fsync fails after metadata reset; C and cleanup preserved', () => fixture(async root => {
      const args = await setup(root); let syncs = 0;
      const injected = { ...fs, open: async (...input) => { const h = await fs.open(...input); if (!path.basename(input[0]).startsWith('.pi-revert-')) return h; return new Proxy(h, { get: (target, key) => key === 'sync' ? async () => { if (++syncs === 2) throw fault('EIO'); return target.sync(); } : typeof target[key] === 'function' ? target[key].bind(target) : target[key] }); } };
      await assert.rejects(createSessionRevertWriter({ metadata, fs: injected }).apply(args), { code: 'EIO' });
      assert.equal(syncs, 2); assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'C'); assert.deepEqual(await fs.readdir(root), ['a.txt']);
    }));
    await check('injected EXDEV moving retains source and reports uncertain commit (not actual cross-volume)', () => fixture(async root => {
      const args = await setup(root), recoveryRoot = path.join(root, 'recovery'); await fs.mkdir(recoveryRoot); let moves = 0;
      const writer = createSessionRevertWriter({ metadata: { ...metadata, moveFileNoReplace: async () => { moves++; throw fault('EXDEV'); } } });
      await assert.rejects(writer.apply({ ...args, candidate: null, recoveryRoot, recoveryRootVerified: true }), { code: 'recovery_required' });
      assert.equal(moves, 1); assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'C');
      for (const sub of await fs.readdir(recoveryRoot)) assert.deepEqual(await fs.readdir(path.join(recoveryRoot, sub)), []);
    }));
    await check('independent child replaces recovery parent; refuses move and preserves C (metadata fixture)', () => fixture(async root => {
      const args = await setup(root), recoveryRoot = path.join(root, 'recovery'); await fs.mkdir(recoveryRoot); let moves = 0;
      const writer = createSessionRevertWriter({ metadata: { ...metadata, moveFileNoReplace: async () => { moves++; throw Error('must not move'); } }, hooks: { afterRecoveryPrepared: async recoveryPath => {
        await run(process.execPath, ['-e', "const fs=require('fs'),p=require('path');const parent=p.dirname(process.argv[1]);fs.renameSync(parent,parent+'-old');fs.mkdirSync(parent);", recoveryPath], { windowsHide: true, timeout: 15000 });
      } } });
      await assert.rejects(writer.apply({ ...args, candidate: null, recoveryRoot, recoveryRootVerified: true }), { code: 'stale_current' });
      assert.equal(moves, 0); assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'C');
    }));
    const windowsCheck = async (name, fn) => { if (process.platform !== 'win32') { skipped++; console.log('SKIP', name, 'Windows required'); } else await check(name, fn); };
    await windowsCheck('native independent no-delete-share handle blocks Node rename', () => fixture(async root => {
      const source = path.join(root, 'source'), target = path.join(root, 'target'); await fs.writeFile(source, 'R'); await fs.writeFile(target, 'C'); const release = await holdWithoutDeleteSharing(target);
      try { await assert.rejects(fs.rename(source, target), e => ['EPERM', 'EACCES', 'EBUSY'].includes(e.code)); assert.equal(await fs.readFile(source, 'utf8'), 'R'); assert.equal(await fs.readFile(target, 'utf8'), 'C'); } finally { await release(); }
    }));
    await windowsCheck('native sharing conflict at writer commit retains C and staging (metadata fixture)', () => fixture(async root => {
      const args = await setup(root); let release;
      const writer = createSessionRevertWriter({ metadata, hooks: { afterFinalCheckBeforeCommit: async () => { release = await holdWithoutDeleteSharing(path.join(root, 'a.txt')); } } });
      try { await assert.rejects(writer.apply(args), { code: 'recovery_required' }); assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'C'); const stages = (await fs.readdir(root)).filter(f => f.startsWith('.pi-revert-')); assert.equal(stages.length, 1); assert.equal(await fs.readFile(path.join(root, stages[0]), 'utf8'), 'R'); } finally { if (release) await release(); }
    }));
    await windowsCheck('native MoveFileEx no-delete-share conflict retains C without destination', () => fixture(async root => {
      const source = path.join(root, 'source'), target = path.join(root, 'target'); await fs.writeFile(source, 'C'); const release = await holdWithoutDeleteSharing(source);
      try { await assert.rejects(native.moveFileNoReplace(source, target), { code: 'restore_move_failed' }); assert.equal(await fs.readFile(source, 'utf8'), 'C'); await assert.rejects(fs.stat(target), { code: 'ENOENT' }); } finally { await release(); }
    }));
    await windowsCheck('native move sharing conflict through writer preserves C and recovery intent (metadata fixture)', () => fixture(async root => {
      const args = await setup(root), recoveryRoot = path.join(root, 'recovery'); await fs.mkdir(recoveryRoot); let release, intent;
      const writer = createSessionRevertWriter({ metadata: { ...metadata, moveFileNoReplace: native.moveFileNoReplace }, hooks: { afterFinalCheckBeforeCommit: async () => { release = await holdWithoutDeleteSharing(path.join(root, 'a.txt')); } } });
      try {
        await assert.rejects(writer.apply({ ...args, candidate: null, recoveryRoot, recoveryRootVerified: true, recordState: async (state, detail) => { intent = { state, ...detail }; } }), { code: 'recovery_required' });
        assert.equal(intent.state, 'moving'); assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'C'); await assert.rejects(fs.stat(intent.recoveryPath), { code: 'ENOENT' });
      } finally { if (release) await release(); }
    }));
    const scope = { projectId: 'p', repoId: null, workspaceId: 'w', workspaceEpoch: 'e', conversationId: 'c', nativeSessionId: 's', workspaceFingerprint: null };
    for (const boundary of ['afterStage', 'afterIntent', 'afterRename']) {
      await check(`real child exits ${boundary}; durable C/R retained; restart does not retry (metadata fixture)`, () => fixture(async dir => {
        const writerUrl = pathToFileURL(path.resolve(__dirname, '../server/session-revert-writer.js')).href;
        const storeUrl = pathToFileURL(path.resolve(__dirname, '../server/session-change-store.js')).href;
        const script = `import fs from 'node:fs/promises';import path from 'node:path';import {createSessionRevertWriter} from ${JSON.stringify(writerUrl)};import {createSessionChangeStore} from ${JSON.stringify(storeUrl)};
          const root=process.argv[1],boundary=process.argv[2],scope=${JSON.stringify(scope)},meta=${JSON.stringify(profile)};await fs.writeFile(path.join(root,'a.txt'),'C');
          const store=await createSessionChangeStore({dataDir:path.join(root,'data'),privacyCheck:async()=>true});const currentRef=await store.restorePut(scope,Buffer.from('C')),candidateRef=await store.restorePut(scope,Buffer.from('R'));
          let file={fileId:'f',relativePath:'a.txt',operationIds:[],currentRef,candidateRef,state:'prepared'};await store.applyCreate(scope,{planId:'crash',requestId:null,tokenHash:'a'.repeat(64),expiresAt:Date.now()+60000,selectedOperationIds:[],files:[file]});
          const writer=createSessionRevertWriter({metadata:{inspectFileMetadata:async()=>meta,preserveFileMetadata:async()=>{}},hooks:{afterStage:async()=>{if(boundary==='afterStage')process.exit(73)},afterRename:async()=>{if(boundary==='afterRename')process.exit(73)}}});const observed=await writer.inspect(root,'a.txt');
          await writer.apply({root,relativePath:'a.txt',currentFingerprint:observed.fingerprint,currentMetadata:observed.metadata,candidate:Buffer.from('R'),backupVerified:true,stateCheck:async()=>{},recordState:async state=>{file={...file,state};await store.applyUpdate(scope,'crash',{state,files:[file]});if(boundary==='afterIntent')process.exit(73)}});process.exit(99);`;
        await assert.rejects(run(process.execPath, ['--input-type=module', '-e', script, dir, boundary], { windowsHide: true, timeout: 20000 }), e => e.code === 73);
        const expected = boundary === 'afterRename' ? 'R' : 'C'; assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), expected);
        const store = await createSessionChangeStore({ dataDir: path.join(dir, 'data'), privacyCheck: async () => true }); const plan = await store.applyGet(scope, 'crash');
        assert.equal(plan.state, 'recovery_required'); assert.equal(plan.files[0].state, boundary === 'afterStage' ? 'prepared' : 'replacing');
        assert.deepEqual(await store.restoreRead(scope, plan.files[0].currentRef), Buffer.from('C')); assert.deepEqual(await store.restoreRead(scope, plan.files[0].candidateRef), Buffer.from('R'));
        assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), expected); await assert.rejects(store.applyUpdate(scope, 'crash', { state: 'replacing' }), { code: 'invalid_evidence_operation' });
      }));
    }
    console.log(`session-revert-windows-faults: ${passed}/${passed + failed}; failed=${failed}; skipped=${skipped}`);
    console.log('Evidence boundary: native Windows operations + fixture metadata; injected ENOSPC/fsync/EXDEV; no actual full disk, cross-volume, full SACL or power-loss proof.');
    if (failed) process.exitCode = 1;
  } finally { await removeFixture(base); }
})().catch(e => { console.error(e); process.exitCode = 1; });
