/* Pi extension discovery is read-only. Never import a candidate or ask Pi to
 * install one: package resolution may itself install and execute third-party code.
 * Pi 0.87 RPC exposes extension commands, but no extension/tool registry. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { json } from './http-utils.js';
import { readExtensionJson as readJson, resolveExtensionPaths, resolvePackageExtensionPaths,
  applyExtensionPatterns, containedExtensionPath } from '../lib/extension-paths.js';

const MAX_ENTRIES = 300;
const cmp = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const key = (p) => cmp(p);
const idOf = (p) => createHash('sha256').update(key(p)).digest('hex').slice(0, 20);
const fileExists = (p) => {
  try { return fs.lstatSync(p).isFile(); } catch { return false; }
};
function packageName(source) {
  if (typeof source !== 'string' || !source.startsWith('npm:')) return null;
  const spec = source.slice(4);
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ? name : null;
}
function sourcePath(info) {
  const p = info?.sourceInfo?.path ?? info?.path;
  return typeof p === 'string' && path.isAbsolute(p) ? key(p) : null;
}
function safeDescription(value) {
  if (typeof value !== 'string') return null;
  // Metadata is untrusted. Keep suspicious descriptions out of renderer responses.
  if (/(?:api[_-]?key|token|password|credential|secret|authorization|bearer|ghp_)/i.test(value)) return null;
  return value.slice(0, 300);
}

/** Only a future authoritative Pi tool list can supply sourceInfo for tools. */
export function mapRegisteredTools(extensions, registeredTools = []) {
  const byPath = new Map(extensions.map((x) => [key(x.source.location), x.id]));
  const tools = [];
  for (const tool of registeredTools) {
    if (typeof tool?.name !== 'string' || !tool.name) continue;
    const owner = sourcePath(tool);
    tools.push({ name: tool.name, displayName: typeof tool.label === 'string' ? tool.label : tool.name,
      extensionId: owner ? byPath.get(owner) || null : null });
  }
  return { tools };
}

export function hasCapability(registry, type, id) {
  if (!registry || typeof id !== 'string') return false;
  const rows = type === 'tool' ? registry.tools : type === 'command' ? registry.commands : [];
  return rows.some((row) => row.name === id && row.extensionId !== null);
}

export function createExtensionRegistry({ runtime, rpc, env = process.env, readTrust = null }) {
  const home = env.HOME || os.homedir();
  const agentDir = env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
  let runtimeErrors = new Map();
  let observedCwd = null;
  let observedRun = null;

  function observe(event) {
    if (event?.type === 'bridge_status') {
      if (event.state === 'starting' || event.state === 'restarting' || event.state === 'no-project') {
        runtimeErrors = new Map();
        observedCwd = event.cwd || null;
        observedRun = event.bridgeRun ?? null;
      }
      return;
    }
    if (event?.type !== 'extension_error' || typeof event.extensionPath !== 'string') return;
    if (observedCwd && event.cwd && cmp(event.cwd) !== cmp(observedCwd)) return;
    if (observedRun !== null && event.bridgeRun !== undefined && event.bridgeRun !== observedRun) return;
    runtimeErrors.set(key(event.extensionPath), { phase: 'load', message: 'Pi 报告扩展执行或加载错误；详情请在本机 Pi 日志中查看。' });
  }

  async function readIndex() {
    const cwd = runtime.getCurrentCwd();
    const bridgeRun = rpc?.getState?.()?.bridgeRun ?? null;
    const diagnostics = [];
    const extensions = [];
    const seen = new Map();
    const packageScopes = new Map();
    const inheritedPaths = new Set();
    const roots = [{ scope: 'global', base: agentDir, settings: path.join(agentDir, 'settings.json') }];
    if (cwd) roots.unshift({ scope: 'project', base: path.join(cwd, '.pi'), settings: path.join(cwd, '.pi', 'settings.json') });
    let trusted = null;
    if (cwd && readTrust) {
      try { trusted = (await readTrust())?.trusted ?? null; } catch { /* unknown */ }
    }
    function add(file, { scope, type = 'local', packageRoot = null, packageMeta = null, settingsError = null, enabled = null }) {
      if (extensions.length >= MAX_ENTRIES || typeof file !== 'string') return;
      const resolved = path.resolve(file);
      const existing = seen.get(key(resolved));
      if (existing) {
        existing.declarations++;
        return;
      }
      const installed = fileExists(resolved);
      const basename = path.basename(path.dirname(resolved)) === 'extensions' ? path.basename(resolved, path.extname(resolved)) : path.basename(path.dirname(resolved));
      const name = safeDescription(packageMeta?.name) || basename;
      const metadataRead = packageRoot ? { data: packageMeta, error: null } : readJson(path.join(path.dirname(resolved), 'package.json'));
      const metadata = metadataRead.data;
      const version = safeDescription(metadata?.version);
      const error = settingsError || (!installed ? 'extension-missing' : null) ||
        (metadataRead.error === 'metadata-invalid' ? 'metadata-invalid' : null) ||
        (packageRoot && !packageMeta ? 'metadata-invalid' : null);
      const record = {
        id: idOf(resolved), name, displayName: name, version,
        description: safeDescription(metadata?.description),
        source: { type, location: resolved }, scope,
        state: { installed, enabled: scope === 'project' && trusted === false ? false : enabled,
          loaded: null, restartRequired: null, error: error ? { extensionId: idOf(resolved), phase: 'discovery', message: error } : null },
        capabilities: [], configurable: false, declarations: 1,
      };
      extensions.push(record);
      seen.set(key(resolved), record);
    }
    function addRows(rows, root, states, confirmed = true) {
      for (const row of rows) {
        const state = states.get(row.file);
        add(row.file, { ...root, packageRoot: row.metadata ? row.ownerRoot : root.packageRoot,
          packageMeta: root.packageMeta || row.metadata, settingsError: root.settingsError || row.error,
          enabled: state === false ? false : row.uncertain || !confirmed ? null : state });
      }
    }
    for (const root of roots) {
      const settings = readJson(root.settings);
      if (settings.error && settings.error !== 'missing') diagnostics.push({ phase: 'config', code: settings.error, message: 'Pi settings.json 无法解析' });
      const entries = Array.isArray(settings.data?.extensions) ? settings.data.extensions : [];
      const validEntries = entries.every(entry => typeof entry === 'string');
      if (!validEntries) diagnostics.push({ phase: 'config', code: 'metadata-invalid', message: 'Extension 配置数组含无效条目，启用状态无法完整确认' });
      const plain = [];
      for (const entry of entries.slice(0, MAX_ENTRIES)) {
        if (typeof entry !== 'string') continue;
        if (/^[!+-]/.test(entry) || /[*?]/.test(entry)) continue;
        if (/^(npm:|git:|https?:|ssh:)/.test(entry)) {
          diagnostics.push({ phase: 'discovery', code: 'source-unsupported', message: '远程扩展来源需由 Pi 自行解析；GUI 未执行安装' });
          continue;
        }
        const target = entry.startsWith('~/') || entry.startsWith('~\\') ? path.resolve(home, entry.slice(2)) : path.resolve(root.base, entry);
        plain.push(...resolveExtensionPaths(target, { diagnostics, missing: true }));
      }
      const patterns = entries.filter(p => typeof p === 'string' && (/^[!+-]/.test(p) || /[*?]/.test(p)));
      addRows(plain, root, applyExtensionPatterns(plain.map(row => row.file), patterns, root.base), validEntries);
      const auto = resolveExtensionPaths(path.join(root.base, 'extensions'), { diagnostics });
      const autoStates = applyExtensionPatterns(auto.map(row => row.file), entries, root.base, { overridesOnly: true });
      // Absent runtime evidence still leaves default load eligibility conservative;
      // overrides that can prove a state are reported independently of loading.
      addRows(auto, root, autoStates, validEntries && entries.some(p => typeof p === 'string' && /^[!+-]/.test(p)));
      if (!settings.data) continue;
      const packages = Array.isArray(settings.data.packages) ? settings.data.packages : [];
      for (const entry of packages.slice(0, MAX_ENTRIES)) {
        const source = typeof entry === 'string' ? entry : entry?.source;
        const npmName = packageName(source);
        let packageRoot = null;
        let type = 'unknown';
        if (npmName) { packageRoot = path.join(root.base, 'npm', 'node_modules', npmName); type = 'npm'; }
        else if (typeof source === 'string' && !/^(git:|https?:|ssh:)/.test(source)) {
          packageRoot = path.isAbsolute(source) ? source : path.resolve(root.base, source); type = 'local';
        }
        if (!packageRoot) {
          diagnostics.push({ phase: 'discovery', code: 'source-unsupported', message: '该 package 来源无法只读定位' });
          continue;
        }
        const manifest = readJson(path.join(packageRoot, 'package.json'));
        if (manifest.error === 'missing') diagnostics.push({ phase: 'discovery', code: 'package-missing', message: '已配置的 package 未安装或缺少 package.json' });
        if (manifest.error === 'metadata-invalid') diagnostics.push({ phase: 'discovery', code: 'metadata-invalid', message: 'package.json 无法解析' });
        const filtered = typeof entry === 'object' && entry !== null;
        const candidates = resolvePackageExtensionPaths(packageRoot, manifest.data, { diagnostics,
          objectForm: filtered, filtered: filtered && (entry.extensions !== undefined || entry.autoload === false) });
        const identity = npmName ? `npm:${npmName}` : key(packageRoot);
        const prior = packageScopes.get(identity);
        const current = { scope: root.scope, files: candidates.map(row => row.file) };
        if (prior && prior.scope !== root.scope) {
          for (const file of [...prior.files, ...current.files]) inheritedPaths.add(key(file));
          diagnostics.push({ phase: 'config', code: 'package-inheritance-unresolved', message: '同一 package 跨作用域声明，配置继承状态无法完整确认' });
        }
        packageScopes.set(identity, current);
        let states = new Map(candidates.map(row => [row.file, null]));
        if (filtered && entry.extensions !== undefined) {
          const filter = Array.isArray(entry.extensions) ? entry.extensions : null;
          if (!filter || !filter.every(pattern => typeof pattern === 'string')) diagnostics.push({ phase: 'config', code: 'metadata-invalid', message: 'package Extension filter 无法解析' });
          const safeFilter = filter?.every(pattern => typeof pattern === 'string') ? filter.filter(pattern => {
            if (typeof pattern !== 'string') return false;
            const target = pattern.replace(/^[!+-]/, '');
            if (containedExtensionPath(packageRoot, target)) return true;
            diagnostics.push({ phase: 'config', code: 'outside-root', message: 'package filter 路径越过根目录或经过符号链接' });
            return false;
          }) : null;
          states = applyExtensionPatterns(candidates.map(row => row.file), safeFilter, packageRoot, { emptyDisables: true });
        }
        if (filtered && entry.autoload === false) {
          diagnostics.push({ phase: 'config', code: 'autoload-unsupported', message: 'package autoload delta 需要继承解析；启用状态无法确认' });
          states = new Map(candidates.map(row => [row.file, null]));
        }
        addRows(candidates, { ...root, type, packageRoot, packageMeta: manifest.data,
          settingsError: manifest.error === 'metadata-invalid' ? manifest.error : null }, states);
      }
    }
    let commands = null;
    if (cwd && rpc?.request) {
      try { const answer = await rpc.request({ type: 'get_commands' }); if (Array.isArray(answer?.commands)) commands = answer.commands; }
      catch { /* discovery must not affect Pi or chat */ }
    }
    if (runtime.getCurrentCwd() !== cwd || (rpc?.getState?.()?.bridgeRun ?? null) !== bridgeRun) commands = null;
    const capabilityCommands = [];
    for (const command of commands || []) {
      if (command?.source !== 'extension' || typeof command.name !== 'string') continue;
      const source = sourcePath(command);
      const owner = source && seen.get(source);
      if (!owner) continue;
      owner.state.loaded = true;
      const capability = { type: 'command', id: command.name, displayName: command.name };
      owner.capabilities.push(capability);
      capabilityCommands.push({ name: command.name, extensionId: owner.id });
    }
    for (const item of extensions) {
      if (inheritedPaths.has(key(item.source.location)) && !(item.scope === 'project' && trusted === false)) item.state.enabled = null;
      const failure = runtimeErrors.get(key(item.source.location));
      if (failure && (!observedCwd || (cwd && cmp(cwd) === cmp(observedCwd)))) {
        item.state.loaded = false;
        item.state.error = { extensionId: item.id, ...failure };
      }
      if (item.state.installed === false || (item.scope === 'project' && trusted === false)) item.state.loaded = false;
    }
    return { ok: true, hasProject: Boolean(cwd), piReachable: commands !== null,
      extensions, diagnostics,
      capabilityRegistry: { commands: capabilityCommands, tools: [], toolRegistryAvailable: false },
      actions: { install: false, toggle: false, remove: false, refresh: true, restart: true } };
  }
  async function handle(req, res) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '扩展管理动作尚未集成；请使用 Pi 官方 CLI' });
    try { return json(res, 200, await readIndex()); }
    catch { return json(res, 200, { ok: false, error: '扩展发现失败', extensions: [], diagnostics: [] }); }
  }
  return { readIndex, observe, handle };
}
