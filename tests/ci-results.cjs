const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const runner = path.join(ROOT, 'scripts/run-test-group.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
async function check(name, action) {
  await action();
  checks++;
  console.log(`ok ${name}`);
}
async function until(read, label) {
  for (let index = 0; index < 200; index++) {
    const value = read();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`fixture timeout: ${label}`);
}
function stop(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGKILL');
}
async function main() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'scripts/ci-results.mjs')));
  const { createGroupRecord, saveRecord, readRecord, atomicWriteJson, planDigest } = mod;
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ci-evidence-中文 空格-'));
  try {
    const file = path.join(world, '证据 空格.json');
    const plan = { leaves: ['node tests/pass.cjs', 'node tests/hold.cjs'], byGroup: new Map([['core', ['node tests/pass.cjs', 'node tests/hold.cjs']]]) };
    const record = createGroupRecord('core', plan, {
      GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_EVENT_NAME: 'pull_request',
      SECRET_FIXTURE: 'NEVER_PERSIST_THIS',
    });
    await check('initial record includes identity, plan, environment and pending leaves', () => {
      saveRecord(file, record);
      const saved = readRecord(file);
      assert.equal(saved.schemaVersion, 2);
      assert.equal(saved.sha, 'a'.repeat(40));
      assert.equal(saved.runId, '123');
      assert.equal(saved.runAttempt, '2');
      assert.equal(saved.event, 'pull_request');
      assert.equal(saved.nodeVersion, process.version);
      assert.equal(saved.arch, process.arch);
      assert.equal(saved.os, process.platform);
      assert.equal(saved.planDigest, planDigest(plan));
      assert.equal(saved.completedCount, 0);
      assert.equal(saved.finishedAt, null);
      assert.deepEqual(saved.results.map(row => row.status), ['pending', 'pending']);
      assert.ok(!JSON.stringify(saved).includes('NEVER_PERSIST_THIS'));
    });
    await check('partial running record is not successful, repeated reads do not mutate bytes', () => {
      record.status = 'running'; record.results[0].status = 'running';
      saveRecord(file, record);
      const bytes = fs.readFileSync(file);
      assert.equal(readRecord(file).status, 'running');
      assert.equal(readRecord(file).completedCount, 0);
      assert.deepEqual(fs.readFileSync(file), bytes);
    });
    await check('atomic replacement failure preserves the last valid JSON', () => {
      const before = fs.readFileSync(file);
      assert.throws(() => atomicWriteJson(file, { changed: true }, { ...fs, renameSync() { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } }), /locked/);
      assert.deepEqual(fs.readFileSync(file), before);
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
    });
    await check('v1 numeric statuses retain success/failure without inventing completeness', () => {
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, group: 'core', sha: 'b'.repeat(40), startedAt: '2026-10-24T00:00:00Z', finishedAt: null,
        results: [{ index: 1, command: 'node tests/pass.cjs', status: 0, durationMs: 2 }, { index: 2, command: 'node tests/fail.cjs', status: 17, durationMs: 4 }] }));
      const old = readRecord(file);
      assert.equal(old.sourceSchemaVersion, 1);
      assert.equal(old.status, 'interrupted');
      assert.deepEqual(old.results.map(row => row.status), ['passed', 'failed']);
      assert.equal(old.results[1].exitCode, 17);
      assert.equal(old.planDigest, null);
    });
    await check('unsupported schema is refused', () => {
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99 }));
      assert.throws(() => readRecord(file), /schema/);
    });

    fs.mkdirSync(path.join(world, 'tests'));
    const names = ['pass.cjs', 'hold.cjs', 'fail.cjs', 'not-run.cjs', 'ui-fixture.cjs', 'session-revert-fixture.cjs', 'session-revert-object-runtime.cjs', 'stop-barrier.cjs'];
    fs.writeFileSync(path.join(world, 'package.json'), JSON.stringify({ scripts: { test: names.map(name => `node tests/${name}`).join(' && ') } }));
    for (const name of names) fs.writeFileSync(path.join(world, 'tests', name), '');
    fs.writeFileSync(path.join(world, 'tests/hold.cjs'), "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync('release'))clearInterval(t)},20);setTimeout(()=>process.exit(9),8000).unref();");
    fs.writeFileSync(path.join(world, 'tests/fail.cjs'), 'process.exitCode = 17;');
    fs.writeFileSync(path.join(world, 'tests/not-run.cjs'), "require('node:fs').writeFileSync('must-not-exist','bad')");
    const resultFile = path.join(world, 'results.json');
    const child = spawn(process.execPath, [runner, '--group', 'core', '--results', resultFile], { cwd: world, windowsHide: true, stdio: 'ignore' });
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
      await until(() => fs.existsSync(resultFile) && JSON.parse(fs.readFileSync(resultFile)).results?.[1]?.status === 'running', 'second leaf running');
      await check('first success is durable while second command is still running', () => {
        const partial = readRecord(resultFile);
        assert.equal(partial.status, 'running');
        assert.equal(partial.results[0].status, 'passed');
        assert.equal(partial.results[0].exitCode, 0);
        assert.ok(partial.results[0].finishedAt);
        assert.equal(partial.results[1].status, 'running');
        assert.equal(partial.results[2].status, 'pending');
        assert.equal(partial.completedCount, 1);
      });
      fs.writeFileSync(path.join(world, 'release'), 'yes');
      assert.equal(await exited, 1);
      await check('failure keeps preceding successes and never starts following command', () => {
        const failed = readRecord(resultFile);
        assert.equal(failed.status, 'failed');
        assert.deepEqual(failed.results.map(row => row.status), ['passed', 'passed', 'failed', 'pending']);
        assert.equal(failed.results[2].exitCode, 17);
        assert.equal(failed.completedCount, 3);
        assert.equal(fs.existsSync(path.join(world, 'must-not-exist')), false);
      });
    } finally { stop(child); }
    fs.unlinkSync(path.join(world, 'release'));
    const killed = spawn(process.execPath, [runner, '--group', 'core', '--results', resultFile], { cwd: world, windowsHide: true, stdio: 'ignore' });
    const killedExit = new Promise(resolve => killed.once('exit', resolve));
    try {
      await until(() => readRecord(resultFile).status === 'running' && readRecord(resultFile).results[1].status === 'running', 'kill witness');
      stop(killed); await killedExit;
      await check('forced termination retains valid incomplete evidence without promoting it on read', () => {
        const snapshot = fs.readFileSync(resultFile);
        const partial = readRecord(resultFile);
        assert.notEqual(partial.status, 'passed');
        assert.equal(partial.results[0].status, 'passed');
        assert.notEqual(partial.results[1].status, 'passed');
        readRecord(resultFile);
        assert.deepEqual(fs.readFileSync(resultFile), snapshot);
      });
    } finally { stop(killed); fs.writeFileSync(path.join(world, 'release'), 'yes'); }
    fs.unlinkSync(path.join(world, 'release'));
    fs.writeFileSync(path.join(world, 'signal-runner.mjs'), `import fs from 'node:fs';import {main} from ${JSON.stringify(pathToFileURL(runner).href)};const timer=setInterval(()=>{try{if(JSON.parse(fs.readFileSync('results.json')).results[1].status==='running'){clearInterval(timer);process.emit('SIGINT')}}catch{}},25);try{await main()}finally{clearInterval(timer)}`);
    fs.unlinkSync(resultFile);
    const cancelled = spawnSync(process.execPath, [path.join(world, 'signal-runner.mjs'), '--group', 'core', '--results', resultFile], { cwd: world, windowsHide: true, encoding: 'utf8', timeout: 12000 });
    await check('handled cancellation records cancelled, preserves success, and exits nonzero', () => {
      assert.equal(cancelled.status, 130, cancelled.stderr);
      const saved = readRecord(resultFile);
      assert.equal(saved.status, 'cancelled');
      assert.equal(saved.results[0].status, 'passed');
      assert.equal(saved.results[1].status, 'cancelled');
      assert.equal(saved.results[1].signal, 'SIGINT');
      assert.equal(saved.results[2].status, 'pending');
    });
    fs.writeFileSync(path.join(world, 'release'), 'yes');
    fs.writeFileSync(path.join(world, 'tests/fail.cjs'), '');
    fs.writeFileSync(path.join(world, 'tests/not-run.cjs'), '');
    const successful = spawnSync(process.execPath, [runner, '--group', 'core', '--results', resultFile], { cwd: world, windowsHide: true, encoding: 'utf8', timeout: 12000 });
    await check('only a complete successful group writes final passed', () => {
      assert.equal(successful.status, 0, successful.stderr);
      const saved = readRecord(resultFile);
      assert.equal(saved.status, 'passed');
      assert.equal(saved.completedCount, 4);
      assert.equal(saved.results.filter(row => row.status === 'passed').length, 4);
      assert.ok(saved.finishedAt);
    });
    console.log(`ci-results: ${checks}/${checks} passed`);
  } finally {
    fs.rmSync(world, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
