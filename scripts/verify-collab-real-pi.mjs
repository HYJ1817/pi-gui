// Opt-in control-plane qualification. Never part of npm test: requires an
// explicitly supplied local Pi installation, never sends a model prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRuntime } from '../server/runtime.js';
import { createRpcBridge } from '../server/rpc-bridge.js';
import { createPiLaunch } from '../server/pi-launch.js';
import { createSessionRuntime } from '../server/session-runtime.js';

const piBin = process.argv[2], output = process.argv[3];
assert.ok(piBin && path.isAbsolute(piBin) && output && path.isAbsolute(output), 'usage: node scripts/verify-collab-real-pi.mjs <absolute pi.cmd> <absolute result.json>');
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'z46-real-pi-'));
const report = { qualification: 'real-pi-control-only', modelCalls: 0, checks: [], modes: {}, failed: 0 };
const args = ['--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline'];
const env = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { HOME: world, USERPROFILE: world, APPDATA: path.join(world, 'roaming'), LOCALAPPDATA: path.join(world, 'local'),
  PI_CODING_AGENT_DIR: path.join(world, 'agent'), PI_OFFLINE: '1', PI_NO_CONTINUE: '1',
  Z4_NETWORK_TRACE: path.join(world, 'network.jsonl'), Z4_NETWORK_ROLE: 'pi',
  NODE_OPTIONS: `--require="${path.resolve('tests/fixtures/z4-offline-network.cjs').replaceAll('\\', '/')}"` });
const check = (label, value) => { assert.ok(value, label); report.checks.push(label); };
const until = async fn => { const end = Date.now() + 30000; while (!await fn()) { if (Date.now() > end) throw Error('real_pi_timeout'); await new Promise(r => setTimeout(r, 50)); } };
const kill = child => { if (Number.isInteger(child?.pid) && child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 }); };
let classic, runtimeAdapter;
const children = [];
const started = Date.now();
try {
  const launch = createPiLaunch({ piBin, env, getCwd: () => world });
  const entry = launch.cliEntry();
  check('installed Pi Node entry proven', entry?.ok && entry.kind === 'node');
  const version = spawnSync(process.execPath, [entry.entryPath, '--version'], { env, cwd: world, encoding: 'utf8', timeout: 30000, windowsHide: true });
  report.versionProbe = { exitCode: version.status, errorCode: version.error?.code, stderrCode: String(version.stderr).match(/(?:Error: |code: ')([A-Za-z0-9_]+)/)?.[1] ?? null };
  check('installed Pi --version exits successfully', version.status === 0);
  report.piVersion = String(version.stdout).trim();
  const events = [];
  classic = createRpcBridge({ runtime: createRuntime({ initialCwd: world }), piBin: process.execPath, isWin: false, env, autoRestart: false,
    projectLaunch: { launchArgs: () => ({ args }), prepareLaunch: () => ({ args }) },
    spawnProcess: (_command, rpcArgs, options) => { const child = spawn(process.execPath, [entry.entryPath, ...rpcArgs], options); children.push(child); return child; },
    killProcessTree: kill, publish: event => events.push({ type: event.type, state: event.state, bridgeRun: event.bridgeRun }) });
  classic.start();
  await until(() => classic.getState().bridgeState === 'ready');
  let state = await classic.request({ type: 'get_state' });
  check('Classic real RPC state has session identity and is idle', typeof state?.sessionId === 'string' && state.isStreaming === false);
  const firstSession = state.sessionId, firstRun = classic.getState().bridgeRun;
  const stop = await classic.abortAndWait({ type: 'abort' });
  check('Classic idle stop is acknowledged', stop.ok === true && !classic.getState().stop?.pending);
  const reset = await classic.request({ type: 'new_session' });
  state = await classic.request({ type: 'get_state' });
  check('Classic new_session produces distinct identity', reset && !reset.__error && state.sessionId !== firstSession);
  // Simulate unexpected process exit, then explicitly recover the existing bridge.
  kill(children.at(-1));
  await until(() => !classic.getState().piRunning);
  classic.start();
  await until(() => classic.getState().bridgeState === 'ready');
  check('Classic process recovery advances bridgeRun and responds', classic.getState().bridgeRun > firstRun && typeof (await classic.request({ type: 'get_state' }))?.sessionId === 'string');
  report.modes.classic = { events, modelEventsObserved: events.filter(e => ['agent_start', 'message_end', 'agent_settled'].includes(e.type)).length };
  classic.stop();
  await until(() => children.every(child => (child.exitCode !== null || child.signalCode !== null)));

  const cwd = path.join(world, 'runtime'); fs.mkdirSync(cwd);
  const runtimeEvents = [];
  runtimeAdapter = await createSessionRuntime({ piBin, env, dataDir: path.join(world, 'data'), sessionDir: path.join(world, 'sessions'), extraArgs: args,
    context: { cwd, workspace: { root: cwd, cwd, workspaceId: 'fixture-isolated' }, isCurrent: () => true },
    emit: event => runtimeEvents.push({ type: event.type, state: event.state, bridgeRun: event.bridgeRun }) });
  runtimeAdapter.start();
  await until(() => runtimeAdapter.getState().bridgeState === 'ready');
  state = await runtimeAdapter.request({ type: 'get_state' });
  check('Runtime real supervised Pi has independent idle session', typeof state?.sessionId === 'string' && state.sessionId !== firstSession && state.isStreaming === false);
  check('Runtime idle stop is acknowledged', (await runtimeAdapter.abortAndWait({ type: 'abort' })).ok === true);
  await runtimeAdapter.dispose();
  check('Runtime guardian cleanup is confirmed', runtimeAdapter.cleanupConfirmed());
  report.modes.runtime = { events: runtimeEvents, scope: 'production session-runtime adapter; no registry or model generation' };
  report.unverified = ['active generation event order', 'active model cancellation', 'real model proposal parsing', 'production Classic/Runtime registry model E2E'];
} catch (error) {
  report.failed = 1; report.failureCode = error.code || error.message; process.exitCode = 1;
} finally {
  classic?.stop(); await runtimeAdapter?.dispose();
  for (const child of children) kill(child);
  report.elapsedMs = Date.now() - started;
  report.classicChildrenExited = children.every(child => (child.exitCode !== null || child.signalCode !== null));
  try { const lines = fs.readFileSync(path.join(world, 'network.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); report.networkGuard = { installed: lines.filter(x => x.event === 'installed').length, blocked: lines.filter(x => x.event === 'blocked').length, traceLines: lines.length }; } catch { report.networkGuard = { unavailable: true }; }
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  const relative = path.relative(os.tmpdir(), fs.realpathSync(world)); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  fs.rmSync(world, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log(JSON.stringify(report));
}
