'use strict';

const path = require('node:path');
const os = require('node:os');
const { absolute, overlaps, samePath, fail, parseJson, object } = require('./system-storage-fs.cjs');

// Names come from their owning stores, not the legacy repository mover's list.
const FILES = new Set([
  'projects.json', 'session-flags.json', 'session-titles.json', 'session-title-settings.json',
  'conversations.json', 'mcp-market-sources.json', 'mcp-registry-catalog.json.gz', 'environment.json',
]);
const DIRECTORIES = new Set(['plans', 'planner-sessions', 'trash-sessions', 'review-comments', 'collab-documents', '.uploads']);
const OWNED = new Map([...FILES].map(name => [name, 'file']).concat([...DIRECTORIES].map(name => [name, 'directory'])));
const BOOT_FILE = 'system-storage-bootstrap.json';
const BOOT_TEMP = /^\.system-storage-bootstrap-[a-f0-9-]{36}\.tmp$/u;
const DESKTOP = new Set([
  'system-settings.json', 'system-network.json', 'theme-preferences.json', 'app-update-preferences.json', 'window-state.json',
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache',
  'Dictionaries', 'blob_storage', 'Network', 'Session Storage', 'Local Storage', 'IndexedDB', 'Partitions',
  'Service Worker', 'WebStorage', 'SharedStorage', 'SharedStorage-wal', 'Shared Dictionary', 'File System',
  'Crashpad', 'Local State', 'Preferences', 'Secure Preferences', 'TransportSecurity', 'Cookies', 'Cookies-journal',
  'QuotaManager', 'QuotaManager-journal', 'DIPS', 'DIPS-wal', 'SingletonCookie', 'SingletonLock', 'SingletonSocket',
  // Chromium 152 / Electron 44 creates these in a fresh Windows profile.
  'declarative_performance_observer.db', 'declarative_performance_observer.db-journal', 'lockfile',
]);
const EXCLUDED = Object.freeze(['system_preferences', 'theme_preferences', 'update_preferences', 'window_state',
  'electron_chromium', 'logs', 'installation_runtime', 'pi_agent', 'projects_on_disk', 'bootstrap']);
const TRANSACTION = /(?:^|[.\-_])(?:lock|tmp|pending|transaction|transactions)(?:[.\-_]|$)|^\.stage-mig-/iu;
const PROVIDER_STATE = new Set(['provider-management.json', 'models.json.pi-gui-operations.json',
  'models.json.pi-gui-transaction', 'models.json.pi-gui-lock']);
const WORKTREE_STATE = new Set(['worktrees', 'worktrees.json', 'candidate-runs', 'candidate-transactions']);
const REVERT_STATE = new Set(['revert-evidence', 'review-evidence']);

function classifyTop(name, mixed, destination) {
  if (OWNED.has(name)) return OWNED.get(name);
  if (destination) fail('verification_failed');
  if (WORKTREE_STATE.has(name)) fail('worktree_or_candidate_present');
  if (PROVIDER_STATE.has(name)) fail('provider_authority_present');
  // session-change-store creates this exact empty skeleton at every startup.
  // Inventory may exclude it only after proving that it has no records/objects.
  if (name === 'revert-evidence') return 'empty-evidence';
  if (REVERT_STATE.has(name)) fail('revert_evidence_present');
  if (name === 'logs' || name === 'runtime' || (mixed && (DESKTOP.has(name) || name === BOOT_FILE || BOOT_TEMP.test(name)))) return null;
  if (TRANSACTION.test(name)) fail('unknown_transaction');
  fail('unknown_data');
}

function classifyChild(store, name, depth, candidateIsDirectory) {
  if (store !== '.uploads' && TRANSACTION.test(name)) fail('unknown_transaction');
  switch (store) {
    case '.uploads': return depth === 1 ? 'file' : null;
    case 'plans': return depth === 1 && /^[a-z0-9_-]+\.json$/iu.test(name) ? 'file' : null;
    case 'review-comments': case 'collab-documents': return depth === 1 && /^[a-f0-9]{64}\.json$/u.test(name) ? 'file' : null;
    case 'trash-sessions': return depth === 1 && /^[a-z0-9_-]+\.jsonl$/iu.test(name) ? 'file' : null;
    case 'planner-sessions':
      if (depth === 1 && candidateIsDirectory && !name.startsWith('.')) return 'directory';
      return depth <= 2 && /^[^.].*\.jsonl$/u.test(name) ? 'file' : null;
    default: return null;
  }
}

function obtainPiAgentDirectory(value = process.env.PI_CODING_AGENT_DIR) {
  if (!value) return path.join(os.homedir(), '.pi', 'agent');
  return path.resolve(value.replace(/^~(?=[\\/]|$)/u, () => os.homedir()));
}

// Resolve aliases of *protected* roots/locators, never of copy/boot targets.
// Even a currently absent project/root protects its canonical existing prefix
// plus the absent tail. No external file contents are read.
async function canonicalProtected(storage, value) {
  const tail = [];
  let cursor = value;
  for (;;) {
    try { return absolute(path.join(await storage.io.realpath(cursor), ...tail)); }
    catch (error) {
      const parent = path.dirname(cursor);
      if (error.code !== 'ENOENT' || parent === cursor || await storage.lstat(cursor)) fail('protected_roots_unavailable');
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function projectFacts(bytes) {
  if (!bytes) return [];
  const doc = parseJson(bytes, 'invalid_projects');
  if (!object(doc) || !Array.isArray(doc.items) || doc.items.length > 2048
      || (doc.active != null && typeof doc.active !== 'string')) fail('invalid_projects');
  return [doc.active, ...doc.items.map(item => {
    if (!object(item) || typeof item.path !== 'string' || !item.path) fail('invalid_projects');
    return item.path;
  })].filter(Boolean);
}

function conversationFacts(bytes) {
  const roots = [], locators = [];
  if (!bytes) return { roots, locators };
  const doc = parseJson(bytes, 'invalid_conversations');
  if (!object(doc) || doc.version !== 1 || !Array.isArray(doc.items) || doc.items.length > 256) fail('invalid_conversations');
  for (const item of doc.items) {
    if (!object(item) || !object(item.workspace) || typeof item.workspace.workspaceId !== 'string'
        || typeof item.workspace.cwd !== 'string' || !item.workspace.cwd || typeof item.workspace.root !== 'string' || !item.workspace.root
        || (item.sessionLocator != null && (typeof item.sessionLocator !== 'string' || !item.sessionLocator))) fail('invalid_conversations');
    if (!item.workspace.workspaceId.startsWith('project-')) fail('worktree_or_candidate_present');
    roots.push(item.workspace.cwd, item.workspace.root);
    if (item.sessionLocator != null) locators.push(item.sessionLocator);
  }
  return { roots, locators };
}

function environmentFacts(bytes, hasRuntime, runtimeDirectory) {
  if (!bytes) {
    if (hasRuntime && !runtimeDirectory) fail('runtime_not_pinned');
    return;
  }
  const doc = parseJson(bytes, 'invalid_environment');
  if (!object(doc) || doc.version !== 1 || (doc.managed != null && !object(doc.managed))
      || (doc.lastJob != null && !object(doc.lastJob))) fail('invalid_environment');
  if (doc.lastJob && !['completed', 'failed', 'cancelled', 'interrupted'].includes(doc.lastJob.state)) fail('unknown_transaction');
  if (!runtimeDirectory && (hasRuntime || Object.values(doc.managed || {}).some(value => value != null))) fail('runtime_not_pinned');
}

function createStoragePolicy({ storage, anchor, legacy, protectedRoots, getProtectedRoots, piAgent, runtimeDirectory }) {
  function baseOverlap(source, target) {
    if (overlaps(source, target)) fail('source_target_overlap');
    // Only the original Electron default may itself be the mixed userData
    // root. A managed target must never be an ancestor, descendant or alias.
    if (overlaps(anchor, target) || overlaps(legacy, target)
        || (overlaps(anchor, source) && !(samePath(anchor, legacy) && samePath(anchor, source)))) fail('protected_overlap');
  }

  async function guardRoots(source, target, added = []) {
    if (source) baseOverlap(source, target);
    else if (overlaps(anchor, target) || overlaps(legacy, target)) fail('protected_overlap');
    const dynamic = await getProtectedRoots();
    if (!Array.isArray(protectedRoots) || !Array.isArray(dynamic) || protectedRoots.length + dynamic.length + added.length > 4096) {
      fail('protected_roots_unavailable');
    }
    const piParent = path.dirname(piAgent);
    const configured = new Set([piAgent, ...(path.basename(piParent) === '.pi' ? [piParent] : []), ...protectedRoots, ...dynamic, ...added]);
    // When the installation fallback is explicitly pinned to the legacy
    // runtime subfolder, preserve it there without walking it.
    const allowLegacyRuntime = source && runtimeDirectory && samePath(source, legacy) && samePath(runtimeDirectory, path.join(legacy, 'runtime'));
    const roots = [...configured].map(root => [absolute(root), false]);
    if (runtimeDirectory) roots.push([runtimeDirectory, allowLegacyRuntime]);
    for (const [root, allowSource] of roots) {
      for (const location of new Set([root, await canonicalProtected(storage, root)])) {
        if ((source && !allowSource && overlaps(location, source)) || overlaps(location, target)) fail('protected_overlap');
      }
    }
  }

  async function checkProvider() {
    // The ledger lives beside Pi's models, not DATA_DIR, but its authority
    // includes DATA_DIR/provider-management.json. Existence alone blocks P2.
    for (const name of ['models.json.pi-gui-operations.json', 'models.json.pi-gui-transaction', 'models.json.pi-gui-lock']) {
      if (await storage.lstat(path.join(piAgent, name))) fail('provider_authority_present');
    }
  }

  async function verifyBusiness(source, target, inventory) {
    const { roots, locators } = conversationFacts(inventory.facts.get('conversations.json'));
    await guardRoots(source, target, [...roots, ...projectFacts(inventory.facts.get('projects.json'))]);
    for (const locator of locators) {
      const location = absolute(locator);
      for (const resolved of new Set([location, await canonicalProtected(storage, location)])) {
        if (overlaps(source, resolved) || overlaps(target, resolved)) fail('runtime_locator_bound');
      }
    }
    environmentFacts(inventory.facts.get('environment.json'), inventory.hasRuntime, runtimeDirectory);
    await checkProvider();
  }

  return { guardRoots, guardManaged: target => guardRoots(null, target), verifyBusiness };
}

module.exports = { createStoragePolicy, classifyTop, classifyChild, obtainPiAgentDirectory, BOOT_FILE, BOOT_TEMP, EXCLUDED };
