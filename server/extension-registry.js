/* Pi extension discovery is read-only. Never import a candidate or ask Pi to
 * install one: package resolution may itself install and execute third-party code.
 * Pi 0.87 RPC exposes extension commands, but no extension/tool registry. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { json } from './http-utils.js';

const MAX_ENTRIES = 300;
const MAX_JSON_BYTES = 256 * 1024;
const cmp = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const key = (p) => cmp(p);
const idOf = (p) => createHash('sha256').update(key(p)).digest('hex').slice(0, 20);
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const fileExists = (p) => {
  try { return fs.lstatSync(p).isFile(); } catch { return false; }
};
const dirExists = (p) => {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
};
function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return { data: null, error: 'metadata-invalid' };
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { data: null, error: 'metadata-invalid' };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err?.code === 'ENOENT' ? 'missing' : 'metadata-invalid' };
  }
}
function safePackagePath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) return null;
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate)) return null;
  try {
    if (!inside(fs.realpathSync(root), fs.realpathSync(candidate))) return null;
  } catch { /* Missing entries are shown as missing, never followed. */ }
  return candidate;
}
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
    const roots = [{ scope: 'global', base: agentDir, settings: path.join(agentDir, 'settings.json') }];
    if (cwd) roots.unshift({ scope: 'project', base: path.join(cwd, '.pi'), settings: path.join(cwd, '.pi', 'settings.json') });
    let trusted = null;
    if (cwd && readTrust) {
      try { trusted = (await readTrust())?.trusted ?? null; } catch { /* unknown */ }
    }
    function add(file, { scope, type = 'local', packageRoot = null, packageMeta = null, settingsError = null }) {
      if (extensions.length >= MAX_ENTRIES || typeof file !== 'string') return;
      const resolved = path.resolve(file);
      const existing = seen.get(key(resolved));
      if (existing) {
        existing.declarations++;
        return;
      }
      const installed = fileExists(resolved);
      const basename = path.basename(path.dirname(resolved)) === 'extensions' ? path.basename(resolved, path.extname(resolved)) : path.basename(path.dirname(resolved));
      const name = typeof packageMeta?.name === 'string' && packageMeta.name ? packageMeta.name : basename;
      const metadataRead = packageRoot ? { data: packageMeta, error: null } : readJson(path.join(path.dirname(resolved), 'package.json'));
      const metadata = metadataRead.data;
      const version = typeof metadata?.version === 'string' ? metadata.version : null;
      const error = settingsError || (!installed ? 'extension-missing' : null) ||
        (metadataRead.error === 'metadata-invalid' ? 'metadata-invalid' : null) ||
        (packageRoot && !packageMeta ? 'metadata-invalid' : null);
      const record = {
        id: idOf(resolved), name, displayName: name, version,
        description: safeDescription(metadata?.description),
        source: { type, location: resolved }, scope,
        state: { installed, enabled: scope === 'project' && trusted === false ? false : null,
          loaded: null, restartRequired: null, error: error ? { extensionId: idOf(resolved), phase: 'discovery', message: error } : null },
        capabilities: [], configurable: false, declarations: 1,
      };
      extensions.push(record);
      seen.set(key(resolved), record);
    }
    function scanAuto(root) {
      const dir = path.join(root.base, 'extensions');
      if (!dirExists(dir)) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { diagnostics.push({ phase: 'discovery', code: 'directory-unreadable', message: '扩展目录无法读取' }); return; }
      for (const entry of entries.slice(0, MAX_ENTRIES)) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && /\.[jt]s$/.test(entry.name)) add(full, root);
        else if (entry.isDirectory()) {
          const index = ['index.ts', 'index.js'].map((n) => path.join(full, n)).find(fileExists);
          if (index) add(index, root);
          else diagnostics.push({ phase: 'discovery', code: 'entry-missing', message: '扩展目录没有 index.ts 或 index.js' });
        }
      }
    }
    for (const root of roots) {
      scanAuto(root);
      const settings = readJson(root.settings);
      if (settings.error && settings.error !== 'missing') diagnostics.push({ phase: 'config', code: settings.error, message: 'Pi settings.json 无法解析' });
      if (!settings.data) continue;
      const entries = Array.isArray(settings.data.extensions) ? settings.data.extensions : [];
      for (const entry of entries.slice(0, MAX_ENTRIES)) {
        if (typeof entry !== 'string') continue;
        if (entry.startsWith('-') || entry.startsWith('!')) {
          if (entry.startsWith('-')) {
            const disabled = path.resolve(root.base, entry.slice(1));
            const record = seen.get(key(disabled));
            if (record) { record.state.enabled = false; record.state.loaded = false; }
          }
          continue;
        }
        const declared = entry.startsWith('+') ? entry.slice(1) : entry;
        if (/^(npm:|git:|https?:|ssh:)/.test(declared)) {
          diagnostics.push({ phase: 'discovery', code: 'source-unsupported', message: '远程扩展来源需由 Pi 自行解析；GUI 未执行安装' });
          continue;
        }
        let target = path.isAbsolute(declared) ? declared : path.resolve(root.base, declared);
        if (dirExists(target)) target = ['index.ts', 'index.js'].map((n) => path.join(target, n)).find(fileExists) || path.join(target, 'index.ts');
        add(target, { ...root, type: 'local' });
      }
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
        const declared = manifest.data?.pi?.extensions;
        let candidates = Array.isArray(declared) ? declared : [];
        if (!Array.isArray(declared) && dirExists(path.join(packageRoot, 'extensions'))) {
          try {
            candidates = fs.readdirSync(path.join(packageRoot, 'extensions'), { withFileTypes: true })
              .filter((e) => !e.name.startsWith('.') && !e.isSymbolicLink())
              .flatMap((e) => e.isFile() && /\.[jt]s$/.test(e.name) ? [path.join('extensions', e.name)]
                : e.isDirectory() ? ['index.ts', 'index.js'].map((name) => path.join('extensions', e.name, name)) : []);
          } catch { /* unreadable package remains unknown */ }
        }
        for (const rel of candidates.slice(0, MAX_ENTRIES)) {
          if (typeof rel !== 'string' || /[*?{}!]/.test(rel)) {
            diagnostics.push({ phase: 'discovery', code: 'pattern-unresolved', message: 'package 扩展模式无法只读确认' });
            continue;
          }
          const target = safePackagePath(packageRoot, rel);
          if (!target) { diagnostics.push({ phase: 'discovery', code: 'outside-root', message: 'package 扩展路径越过根目录' }); continue; }
          if (!fileExists(target) && !Array.isArray(declared)) continue;
          add(target, { ...root, type, packageRoot, packageMeta: manifest.data });
        }
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
      owner.state.enabled = true;
      const capability = { type: 'command', id: command.name, displayName: command.name };
      owner.capabilities.push(capability);
      capabilityCommands.push({ name: command.name, extensionId: owner.id });
    }
    for (const item of extensions) {
      const failure = runtimeErrors.get(key(item.source.location));
      if (failure && (!observedCwd || (cwd && cmp(cwd) === cmp(observedCwd)))) {
        item.state.loaded = false;
        item.state.error = { extensionId: item.id, ...failure };
      }
      if (item.state.installed === false || item.state.enabled === false) item.state.loaded = false;
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
