import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGroupRecord, saveRecord } from './ci-results.mjs';
import {
  GROUPS,
  createTestGroupPlan,
  validateTestGroupPlan,
} from './test-group-plan.mjs';

const GROUP_PORTS = Object.freeze({
  core: { TEST_PORT: '17881', GUARD_PORT: '17882', SEC_PORT: '17883', GIT_PORT: '17884' },
  ui: { TEST_PORT: '17891', GUARD_PORT: '17892', SEC_PORT: '17893', GIT_PORT: '17894' },
  security: { TEST_PORT: '17901', GUARD_PORT: '17902', SEC_PORT: '17903', GIT_PORT: '17904' },
  faults: { TEST_PORT: '17911', GUARD_PORT: '17912', SEC_PORT: '17913', GIT_PORT: '17914' },
  native: { TEST_PORT: '17921', GUARD_PORT: '17922', SEC_PORT: '17923', GIT_PORT: '17924' },
});

function parseArgs(argv) {
  const options = { group: null, results: null, githubOutput: null, list: false, validate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--group') options.group = argv[++index];
    else if (arg === '--results') options.results = argv[++index];
    else if (arg === '--github-output') options.githubOutput = argv[++index];
    else if (arg === '--list') options.list = true;
    else if (arg === '--validate') options.validate = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function writeGithubOutput(file, groups) {
  if (!file) return;
  fs.appendFileSync(file, `groups=${JSON.stringify(groups)}\n`, 'utf8');
}

function printPlan(plan) {
  for (const group of plan.groups) {
    const commands = plan.byGroup.get(group);
    console.log(`${group}: ${commands.length}`);
    if (plan.listCommands) {
      for (const command of commands) console.log(`  ${command}`);
    }
  }
}

function runCommand(command, { cwd, env }, onChild) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
    });
    onChild(child);
    child.once('error', (error) => resolve({ exitCode: 1, signal: null, error: error.code || 'spawn_error' }));
    child.once('exit', (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal, error: null }));
  });
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const plan = createTestGroupPlan({ root, packageJson });
  plan.listCommands = options.list;
  validateTestGroupPlan(plan);

  if (options.githubOutput) {
    const groups = [...plan.groups];
    writeGithubOutput(options.githubOutput, groups);
  }
  if (options.validate) {
    console.log(`test-plan: ${plan.leaves.length} canonical leaves; groups ${plan.groups.join(', ')}`);
    printPlan(plan);
  }
  if (!options.group) return;

  if (!GROUPS.includes(options.group)) throw new Error(`unknown test group: ${options.group}`);
  const commands = plan.byGroup.get(options.group);
  const stamp = `${process.pid}-${Date.now()}`;
  const tempRoot = process.env.PI_GUI_CI_TEMP
    || path.join(os.tmpdir(), `pi-gui-ci-${options.group}-${stamp}`);
  fs.mkdirSync(tempRoot, { recursive: true });
  const childEnv = {
    ...process.env,
    CI_TEST_GROUP: options.group,
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
    HARNESS_PORT: process.env.HARNESS_PORT || '0',
    ...Object.fromEntries(
      Object.entries(GROUP_PORTS[options.group]).filter(([name]) => !process.env[name]),
    ),
  };
  const record = createGroupRecord(options.group, plan);
  if (!record.sha) {
    try { record.sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); }
    catch { /* A non-Git isolated test fixture keeps sha unknown. */ }
  }
  saveRecord(options.results, record);
  let activeChild = null;
  let cancelled = false;
  const save = () => saveRecord(options.results, record);
  const interrupt = (status, signal) => {
    if (record.finishedAt) return;
    record.status = status;
    record.finishedAt = new Date().toISOString();
    const running = record.results.find(row => row.status === 'running');
    if (running) Object.assign(running, { status, signal, finishedAt: record.finishedAt });
    save();
  };
  const cancel = signal => {
    if (cancelled) return;
    cancelled = true;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    try { interrupt('cancelled', signal); }
    finally {
      if (activeChild && activeChild.exitCode === null) {
        if (process.platform === 'win32') {
          // This PID is the still-owned child spawned above, never an ambient
          // process name or a user application discovered on the machine.
          execFileSync('taskkill', ['/pid', String(activeChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else activeChild.kill(signal);
      }
    }
  };
  const onInt = () => cancel('SIGINT');
  const onTerm = () => cancel('SIGTERM');
  const onExit = () => { if (!record.finishedAt) interrupt('interrupted', null); };
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  process.on('exit', onExit);
  console.log(`test-group: ${options.group}; ${commands.length} leaves; TEMP=${tempRoot}`);
  try {
    record.status = 'running';
    for (const [index, command] of commands.entries()) {
      const row = record.results[index];
      Object.assign(row, { startedAt: new Date().toISOString(), status: 'running' });
      save();
      const start = process.hrtime.bigint();
      console.log(`[${index + 1}/${commands.length}] ${command}`);
      const result = await runCommand(command, { cwd: root, env: childEnv }, child => { activeChild = child; });
      activeChild = null;
      if (cancelled) return;
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      Object.assign(row, {
        finishedAt: new Date().toISOString(), durationMs,
        exitCode: result.exitCode, signal: result.signal, error: result.error,
        status: result.signal ? 'interrupted' : result.exitCode === 0 ? 'passed' : 'failed',
      });
      save();
      if (result.exitCode !== 0) {
        record.status = row.status;
        record.finishedAt = row.finishedAt;
        save();
        throw new Error(`test group ${options.group} failed at ${command} (exit ${result.exitCode})`);
      }
    }
    record.status = 'passed';
    record.finishedAt = new Date().toISOString();
    save();
    console.log(`test-group: ${options.group} passed ${commands.length}/${commands.length}`);
  } finally {
    try { if (!record.finishedAt) interrupt('interrupted', null); }
    finally {
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('exit', onExit);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
