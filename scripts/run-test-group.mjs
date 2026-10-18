import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function runCommand(command, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', (error) => resolve({ exitCode: 1, signal: null, error: error.message }));
    child.once('exit', (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal, error: null }));
  });
}

function writeResults(file, group, startedAt, finishedAt, results) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    group,
    sha: process.env.GITHUB_SHA || null,
    startedAt,
    finishedAt,
    results,
  }, null, 2)}\n`, 'utf8');
}

async function main() {
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
  const startedAt = new Date().toISOString();
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
  const results = [];
  console.log(`test-group: ${options.group}; ${commands.length} leaves; TEMP=${tempRoot}`);

  for (const [index, command] of commands.entries()) {
    const commandStartedAt = new Date().toISOString();
    const start = process.hrtime.bigint();
    console.log(`[${index + 1}/${commands.length}] ${command}`);
    const result = await runCommand(command, { cwd: root, env: childEnv });
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    results.push({
      index: index + 1,
      command,
      startedAt: commandStartedAt,
      durationMs,
      status: result.exitCode,
      signal: result.signal,
      error: result.error,
    });
    if (result.exitCode !== 0) {
      const finishedAt = new Date().toISOString();
      writeResults(options.results, options.group, startedAt, finishedAt, results);
      throw new Error(`test group ${options.group} failed at ${command} (exit ${result.exitCode})`);
    }
  }

  const finishedAt = new Date().toISOString();
  writeResults(options.results, options.group, startedAt, finishedAt, results);
  console.log(`test-group: ${options.group} passed ${commands.length}/${commands.length}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
