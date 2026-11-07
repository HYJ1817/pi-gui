import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { resolveAuthSdk } from './provider-auth-sdk.js';
import { credentialWorkerSource } from './provider-credentials.js';
import { isLiteralKeyInput, isOpaqueId, isProviderId, isRecord, validateConnection } from '../public/provider-management/contract.js';

export const providerKeyInputEnabled = false;
const fail = (code, credentialSaved = false) => ({ ok: false, code, credentialSaved,
  credentialState: credentialSaved === null ? 'credential-unconfirmed' : code === 'expired' ? 'expired' : 'none' });
const unknown = () => ({ ok: false, present: null, type: null, builtIn: null, credentialRevision: null });

function authPathAbsent(authPath) {
  const chain = [];
  for (let p = path.dirname(authPath); ; p = path.dirname(p)) { chain.unshift(p); if (p === path.dirname(p)) break; }
  try {
    for (const parent of chain) {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    fs.lstatSync(authPath);
    return false;
  } catch (error) { return error.code === 'ENOENT'; }
}

function normalizeBinding(binding) {
  if (!isRecord(binding) || Object.keys(binding).length !== 4 || !isOpaqueId(binding.draftId) || !isProviderId(binding.providerId) ||
      !Number.isSafeInteger(binding.connectionRevision) || binding.connectionRevision < 1) return null;
  try { return { draftId: binding.draftId, providerId: binding.providerId, connectionRevision: binding.connectionRevision, connection: validateConnection(binding.connection) }; }
  catch { return null; }
}

export function createProviderCredentialSdk({ resolvePackageDir, identityKey, authPath, env = process.env, enabled = providerKeyInputEnabled,
  authorizeStorage = () => false, ttlMs = 15 * 60_000, timeoutMs = 15000 } = {}) {
  const location = path.resolve(authPath);
  let worker, workerIdentity, sequence = 0;
  const pending = new Map();
  function dispose() {
    const retired = worker;
    worker = null;
    workerIdentity = null;
    for (const item of pending.values()) item.finish(fail('unavailable', item.mutation ? null : false));
    return retired?.terminate();
  }
  function ensure() {
    try {
      const identity = identityKey();
      if (!identity) return false;
      if (worker && identity === workerIdentity) return true;
      void dispose();
      const directory = resolvePackageDir();
      const resolved = resolveAuthSdk(directory);
      // Literal semantics and the local-only auth surface were qualified at 1.5.0.
      if (resolved?.version !== '1.5.0') return false;
      const entry = fileURLToPath(resolved.entry);
      const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(entry));
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
      const workerEnv = Object.fromEntries(['SystemRoot','SYSTEMROOT','WINDIR','PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP'].filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
      workerEnv.PI_OFFLINE = '1';
      const current = worker = new Worker(credentialWorkerSource, { eval: true, execArgv: [], env: workerEnv, stdout: true, stderr: true,
        workerData: { entry: resolved.entry, authPath: location, ttlMs } });
      workerIdentity = identity;
      current.stdout.resume();
      current.stderr.resume();
      current.on('message', message => { if (worker === current) pending.get(message?.id)?.finish(message.result); });
      current.on('error', () => { if (worker === current) void dispose(); });
      current.on('exit', () => { if (worker === current) void dispose(); });
      current.unref();
      return true;
    } catch { return false; }
  }
  function call(action, payload, mutation = false) {
    if (pending.size >= 32 || !ensure()) return Promise.resolve(fail('unsupported'));
    const id = ++sequence;
    const current = worker;
    current.ref();
    return new Promise(resolve => {
      const timer = setTimeout(() => { if (worker === current) void dispose(); }, timeoutMs);
      function finish(result) {
        clearTimeout(timer);
        pending.delete(id);
        if (pending.size === 0) current.unref();
        resolve(result);
      }
      pending.set(id, { finish, mutation });
      try { current.postMessage({ id, action, ...payload }); } catch { finish(fail('unavailable', mutation ? null : false)); }
    });
  }
  async function inspect(providerId) {
    if (!isProviderId(providerId)) return unknown();
    const result = await call('inspect', { providerId });
    if (typeof result?.ok === 'boolean' && [true,false,null].includes(result.present)) return result;
    if (authPathAbsent(location)) return { ...unknown(), ok: true, present: false };
    return unknown();
  }
  function stage(action, inputBinding, input, options) {
    if (!enabled) return Promise.resolve(fail('unsupported'));
    const binding = normalizeBinding(inputBinding);
    if (!binding || !isOpaqueId(options?.expectedCredentialRevision) ||
        (action === 'stage' ? !isLiteralKeyInput(input) : options.confirmed !== true)) return Promise.resolve(fail('invalid_request'));
    return call(action, { binding, ...(action === 'stage' ? { input } : {}), expectedCredentialRevision: options.expectedCredentialRevision,
      confirmOAuthReplacement: options.confirmOAuthReplacement === true });
  }
  async function persist(action, inputBinding) {
    if (!enabled) return fail('unsupported');
    const binding = normalizeBinding(inputBinding);
    if (!binding) return fail('invalid_request');
    try {
      if (await authorizeStorage({ binding, authPath: location, action }) !== true) {
        await call('dispose-draft', { draftId: binding.draftId });
        return fail('storage_unqualified');
      }
    } catch { return fail('storage_unqualified'); }
    return call(action, { binding }, true);
  }
  return {
    inspect, readback: inspect,
    stageNativeLogin: (binding, input, options) => stage('stage', binding, input, options),
    stageClear: (binding, options) => stage('stage-clear', binding, null, options),
    persistNative: binding => persist('persist', binding), clearNative: binding => persist('clear', binding),
    disposeDraft: draftId => isOpaqueId(draftId) && worker ? call('dispose-draft', { draftId }) : Promise.resolve({ ok: true }),
    dispose,
  };
}
