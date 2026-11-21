/* Renderer preferences contain only opaque identity and booleans. Execution
 * evidence, rendered text and tool details remain outside browser storage. */
const KEY = 'pi-gui.execution-view.v1';
const MAX_SCOPES = 100;
const MAX_CHOICES = 200;
const MAX_SERIALIZED = 1024 * 1024;
const opaque = value => typeof value === 'string' && /^[a-zA-Z0-9_.:#@-]{1,320}$/.test(value);
const stores = new WeakMap();
const memory = new Map();

export function executionLivePreferenceKey(scope, sequence) {
  const values = scope?.kind === 'classic'
    ? [scope.bridgeInstance, scope.bridgeRun, scope.workspaceGeneration, scope.branchEpoch, sequence]
    : [scope?.owner?.runtimeId, scope?.owner?.runtimeGeneration, scope?.branchEpoch, sequence];
  if (!Number.isSafeInteger(sequence) || values.some(value => !opaque(String(value)) || value == null)) return null;
  return 'live:' + values.join(':');
}

function readChoices(storage) {
  const scopes = new Map();
  try {
    const raw = storage.getItem(KEY);
    if (!raw || raw.length > MAX_SERIALIZED) return scopes;
    const decoded = JSON.parse(raw);
    if (!Array.isArray(decoded)) return scopes;
    for (const pair of decoded.slice(-MAX_SCOPES)) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || pair[0].length > 1200 || !Array.isArray(pair[1])) continue;
      const ids = JSON.parse(pair[0]);
      if (!Array.isArray(ids) || ids.length < 3 || ids.length > 4 || !ids.every(opaque)) continue;
      const choices = new Map();
      for (const choice of pair[1].slice(-MAX_CHOICES)) {
        if (!Array.isArray(choice) || typeof choice[1] !== 'boolean') continue;
        const parts = typeof choice[0] === 'string' && choice[0].split('/');
        if (parts?.length === 2 && parts.every(opaque)) choices.set(choice[0], choice[1]);
      }
      if (choices.size) scopes.set(pair[0], choices);
    }
  } catch { /* Storage denial or corruption keeps preferences optional. */ }
  return scopes;
}

export function executionViewPreferences(scope, turnId, { alias, items = [] } = {}) {
  const { kind, sessionId, workspaceId, conversationId } = scope ?? {};
  const ids = kind === 'classic' ? [kind, workspaceId, sessionId]
    : kind === 'runtime' ? [kind, workspaceId, conversationId, sessionId] : [];
  if (!ids.length || !ids.every(opaque) || !opaque(turnId)) return undefined;
  let storage;
  try { storage = globalThis.localStorage; } catch { /* Privacy mode. */ }
  if (storage && !stores.has(storage)) stores.set(storage, readChoices(storage));
  const scopes = storage ? stores.get(storage) : memory;
  const scopeKey = JSON.stringify(ids);
  const itemAliases = new Map(items.filter(item => opaque(item.id) && opaque(item.viewAlias))
    .map(item => ['activity-item:' + item.id, 'activity-item:' + item.viewAlias]));
  const state = {
    get(part) {
      if (!opaque(part)) return undefined;
      const choices = scopes.get(scopeKey);
      const saved = choices?.get(turnId + '/' + part);
      if (saved !== undefined || !opaque(alias)) return saved;
      const prior = itemAliases.get(part) ?? (part.startsWith('activity-item:') ? null : part);
      const value = prior && choices?.get(alias + '/' + prior);
      if (typeof value === 'boolean') {
        state.set(part, value);
        return value;
      }
      return undefined;
    },
    set(part, expanded) {
      if (!opaque(part) || typeof expanded !== 'boolean') return;
      const choices = scopes.get(scopeKey) ?? new Map();
      const choiceKey = turnId + '/' + part;
      if (choices.get(choiceKey) === expanded) return;
      choices.delete(choiceKey);
      choices.set(choiceKey, expanded);
      if (choices.size > MAX_CHOICES) choices.delete(choices.keys().next().value);
      scopes.delete(scopeKey);
      scopes.set(scopeKey, choices);
      if (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value);
      if (!storage) return;
      try {
        let data;
        do {
          data = JSON.stringify([...scopes].map(([key, values]) => [key, [...values]]));
          if (data.length > MAX_SERIALIZED) scopes.delete(scopes.keys().next().value);
        } while (data.length > MAX_SERIALIZED);
        storage.setItem(KEY, data);
      } catch { /* The selected state is still available in memory. */ }
    },
  };
  return state;
}
