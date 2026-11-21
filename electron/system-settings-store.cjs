'use strict';

// Desktop preferences are main-owned, like theme/update preferences, but have a
// separate schema: no renderer storage, update authorization or Pi configuration.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { randomUUID } = require('node:crypto');
const DEFAULTS = Object.freeze({ keepAwake: false, preventDisplaySleep: false, closeBehavior: 'quit' });
const KEYS = Object.keys(DEFAULTS);
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function validSetting(key, value) {
  return KEYS.includes(key) && (key === 'closeBehavior' ? ['quit', 'tray'].includes(value) : typeof value === 'boolean');
}
function validSettings(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === KEYS.length && KEYS.every(key => validSetting(key, value[key]));
}

async function createSystemSettingsStore(options = {}) {
  return createSystemPreferenceFile({ ...options, fileName: 'system-settings.json', defaults: DEFAULTS, validate: validSettings });
}

// Main-only helper shared by the two fixed system preference files. No IPC
// caller can supply these options; in particular it is not an arbitrary writer.
async function createSystemPreferenceFile({ directory, io = fs, fileName, defaults, validate, maxBytes = 4096 } = {}) {
  if (!path.isAbsolute(directory || '') || !/^[a-z][a-z-]+\.json$/.test(fileName || '')
    || typeof validate !== 'function' || !validate(defaults) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16384) {
    throw new TypeError('invalid main-owned preference file');
  }
  const root = path.resolve(directory), file = path.join(root, fileName);
  const prefix = fileName.slice(0, -5);
  let settings = { ...defaults }, status = 'default', error = '', rootIdentity = null;

  async function guard() {
    let current = root;
    while (true) {
      const stat = await io.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('unsafe_settings_path');
      if (current === root && rootIdentity && rootIdentity !== identity(stat)) throw Error('settings_directory_changed');
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (!samePath(await io.realpath(root), root)) throw Error('unsafe_settings_path');
    const stat = await io.lstat(root);
    rootIdentity ??= identity(stat);
    if (rootIdentity !== identity(stat)) throw Error('settings_directory_changed');
  }
  async function regularFile() {
    try {
      const stat = await io.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw Error('unsafe_settings_file');
      return stat;
    } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }
  async function load() {
    let handle;
    try {
      await guard();
      const stat = await regularFile();
      if (!stat) { status = 'default'; return; }
      handle = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      if (identity(await handle.stat()) !== identity(stat)) throw Error('settings_file_changed');
      const text = await handle.readFile('utf8');
      if (Buffer.byteLength(text) > maxBytes) throw Error('unsafe_settings_file');
      await guard();
      if (identity(await regularFile()) !== identity(stat)) throw Error('settings_file_changed');
      let document;
      try { document = JSON.parse(text); } catch { status = 'corrupt'; error = '系统设置损坏，已使用默认值。重新保存可恢复。'; return; }
      const { schemaVersion, ...values } = document || {};
      if (schemaVersion !== 1 || !validate(values)) {
        status = 'corrupt'; error = '系统设置格式不受支持，已使用默认值。重新保存可恢复。'; return;
      }
      settings = { ...values }; status = 'saved'; error = '';
    } catch {
      status = 'unavailable'; error = '无法安全读取系统设置；未修改配置，请检查目录权限后重启应用。';
    } finally { await handle?.close().catch(() => {}); }
  }
  await load();

  async function save(next) {
    if (!validate(next) || Buffer.byteLength(JSON.stringify({ schemaVersion: 1, ...next }, null, 2) + '\n') > maxBytes) return { ok: false, code: 'invalid_settings' };
    if (status === 'unavailable') return { ok: false, code: 'settings_unavailable', error };
    const temporary = path.join(root, `.${prefix}-${randomUUID()}.tmp`);
    let handle;
    try {
      await guard();
      await regularFile();
      handle = await io.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, ...next }, null, 2) + '\n');
      await handle.sync();
      await handle.close(); handle = null;
      await guard();
      await regularFile();
      await io.rename(temporary, file);
      settings = { ...next }; status = 'saved'; error = '';
      return { ok: true };
    } catch {
      error = '系统设置保存失败，未应用此次更改。请检查磁盘空间和目录权限后重试。';
      return { ok: false, code: 'settings_save_failed', error };
    } finally {
      await handle?.close().catch(() => {});
      // Only unlink our unique temporary file, never recursively clean a directory.
      try { await guard(); await io.unlink(temporary); } catch { /* preserve uncertain paths */ }
    }
  }
  return { save, snapshot: () => ({ settings: { ...settings }, status, error }) };
}
module.exports = { createSystemSettingsStore, createSystemPreferenceFile, DEFAULTS, validSetting, validSettings };
