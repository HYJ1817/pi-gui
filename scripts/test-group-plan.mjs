import fs from 'node:fs';
import path from 'node:path';

export const GROUPS = Object.freeze(['core', 'ui', 'security', 'native', 'faults']);

// These two suites own fresh TEMP roots and do not consume another suite's
// mutable fixture. Keep each suite intact; isolate their expensive Native work
// on a separate runner instead of running assertions concurrently.
const NATIVE_TESTS = new Set([
  'candidate-writer.cjs',
  'candidate-apply.cjs',
  'session-revert-object-runtime.cjs',
  'session-revert-object-writer.cjs',
]);

const FAULT_TESTS = new Set([
  'session-change-store.cjs',
  'session-change-startup.cjs',
  'bridge-state-recovery.cjs',
  'gui-browser-stop.cjs',
  'stop-barrier.cjs',
  'managed-processes.cjs',
  'process-tools.cjs',
  'process-stop.cjs',
  'process-runner.cjs',
  'process-budget.cjs',
  'pi-supervisor.cjs',
  'runtime-resource-cleanup.cjs',
  'runtime-processes.cjs',
  'candidate-write-faults.cjs',
  'candidate-transactions.cjs',
  'session-revert-windows-faults.cjs',
  'session-revert-inplace-safety.cjs',
  'session-revert-recovery.cjs',
  'session-revert-object-recovery.cjs',
  'session-revert-object-faults.cjs',
]);

const UI_PATTERNS = [
  /^ui[234]?-/,
  /^ui-ia\.cjs$/,
  /^smoke\.cjs$/,
  /^theme\.cjs$/,
  /^daily-use\.cjs$/,
  /^sidebar-menu\.cjs$/,
  /^hotfix-ui\.cjs$/,
  /^logging-ui\.cjs$/,
  /^process-ui\.cjs$/,
  /^runtime-.*ui\.cjs$/,
  /^worktrees-ui\.cjs$/,
  /^session-change-ui\.cjs$/,
  /^gui-browser-ui\.cjs$/,
];

function validateGroupNames(groups) {
  if (!Array.isArray(groups) || groups.length === 0) throw new Error('test groups must be a non-empty array');
  if (new Set(groups).size !== groups.length) throw new Error('test groups contain duplicates');
  for (const group of groups) {
    if (!GROUPS.includes(group)) throw new Error(`unknown test group: ${group}`);
  }
}

function splitCommandChain(script) {
  return String(script)
    .split(/\s+&&\s+/)
    .map((command) => command.trim())
    .filter(Boolean);
}

function expandLeafCommands(packageJson) {
  const scripts = packageJson.scripts;
  if (!scripts || typeof scripts.test !== 'string' || !scripts.test.trim()) {
    throw new Error('package.json is missing scripts.test');
  }

  const leaves = [];
  const seen = new Set();

  function expandScript(name, stack) {
    if (stack.includes(name)) throw new Error(`cyclic npm script: ${[...stack, name].join(' -> ')}`);
    const script = scripts[name];
    if (typeof script !== 'string' || !script.trim()) throw new Error(`npm script not found: ${name}`);
    for (const command of splitCommandChain(script)) {
      const alias = command.match(/^npm run ([^\s]+)$/);
      if (alias) {
        expandRun(alias[1], [...stack, name]);
        continue;
      }
      if (seen.has(command)) throw new Error(`duplicate leaf test command: ${command}`);
      seen.add(command);
      leaves.push(command);
    }
  }

  function expandRun(name, stack) {
    if (stack.includes(name)) throw new Error(`cyclic npm script: ${[...stack, name].join(' -> ')}`);
    for (const hook of [`pre${name}`, name, `post${name}`]) {
      if (hook !== name && !(typeof scripts[hook] === 'string' && scripts[hook].trim())) continue;
      expandScript(hook, hook === name ? stack : [...stack, name]);
    }
  }

  expandRun('test', []);
  return leaves;
}

export function classifyTestCommand(command, groups = GROUPS) {
  validateGroupNames(groups);
  const match = String(command).match(/^node tests\/([^\s]+)(?:\s|$)/);
  const name = match ? match[1] : '';
  if (FAULT_TESTS.has(name)) return 'faults';
  if (NATIVE_TESTS.has(name)) return 'native';
  if (/^session-(?:change|revert)-/.test(name)) return 'security';
  if (UI_PATTERNS.some((pattern) => pattern.test(name))) return 'ui';
  return 'core';
}

export function createTestGroupPlan({ root = process.cwd(), packageJson, groups = GROUPS } = {}) {
  validateGroupNames(groups);
  if (!packageJson) throw new Error('packageJson is required');
  const leaves = expandLeafCommands(packageJson);
  const byGroup = new Map(groups.map((group) => [group, []]));
  const groupByCommand = new Map();
  for (const command of leaves) {
    const group = classifyTestCommand(command, groups);
    byGroup.get(group).push(command);
    groupByCommand.set(command, group);
  }
  return { root, groups, leaves, byGroup, groupByCommand };
}

export function validateTestGroupPlan(plan) {
  validateGroupNames(plan.groups);
  if (!Array.isArray(plan.leaves) || plan.leaves.length === 0) throw new Error('canonical test chain is empty');
  if (plan.leaves.length !== new Set(plan.leaves).size) throw new Error('canonical test chain contains duplicate leaves');

  const grouped = [];
  for (const group of plan.groups) {
    const commands = plan.byGroup.get(group);
    if (!commands || commands.length === 0) throw new Error(`test group is empty: ${group}`);
    const canonicalOrder = plan.leaves.filter((command) => plan.groupByCommand.get(command) === group);
    if (commands.some((command, index) => command !== canonicalOrder[index])) {
      throw new Error(`test group order differs from canonical test chain: ${group}`);
    }
    grouped.push(...commands);
  }
  if (grouped.length !== plan.leaves.length) throw new Error('group union length differs from canonical test chain');
  if (new Set(grouped).size !== new Set(plan.leaves).size) throw new Error('group union differs from canonical test chain');

  for (const command of plan.leaves) {
    const match = command.match(/^node tests\/([^\s]+)(?:\s|$)/);
    if (!match) continue;
    const file = path.join(plan.root, 'tests', match[1]);
    if (!fs.existsSync(file)) throw new Error(`canonical test file does not exist: ${match[1]}`);
  }
  return true;
}
