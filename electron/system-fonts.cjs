'use strict';
/* Installed system font families for the Appearance font picker.
 *
 * Windows enumeration follows the approach PI-Desktop v0.22.0 already
 * validated: PowerShell + PresentationCore's SystemFontFamilies. No native
 * addon, no renderer-supplied command, path or argument ever reaches here.
 * The renderer only receives a bounded, deduplicated string list.
 */
const { execFile } = require('node:child_process');

const WINDOWS_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  'Add-Type -AssemblyName PresentationCore',
  '$zh = [Windows.Markup.XmlLanguage]::GetLanguage("zh-cn")',
  '$en = [Windows.Markup.XmlLanguage]::GetLanguage("en-us")',
  'foreach ($family in [Windows.Media.Fonts]::SystemFontFamilies) {',
  '  $text = ""',
  '  if (-not $family.FamilyNames.TryGetValue($zh, [ref]$text) -or [string]::IsNullOrWhiteSpace($text)) {',
  '    $text = ""',
  '    if (-not $family.FamilyNames.TryGetValue($en, [ref]$text) -or [string]::IsNullOrWhiteSpace($text)) { $text = "" }',
  '  }',
  '  if ($text) { [Console]::Out.WriteLine($text) }',
  '}'
].join('; ');

const MAX_FONTS = 4096;
const MAX_NAME_LENGTH = 120;
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

function stripBidi(value) {
  return [...value].filter((ch) => {
    const code = ch.codePointAt(0);
    return !((code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069));
  }).join('');
}

function stripControl(value) {
  return [...value].filter((ch) => {
    const code = ch.codePointAt(0);
    return code > 0x1f && code !== 0x7f;
  }).join('');
}

function normalizeFamily(raw) {
  if (typeof raw !== 'string') return '';
  return stripControl(stripBidi(raw)).trim().slice(0, MAX_NAME_LENGTH);
}

function compareFamilies(left, right) {
  return left.localeCompare(right, 'zh-CN', { sensitivity: 'base' }) || left.localeCompare(right);
}

/** Turn raw PowerShell stdout into the list offered by the picker. */
function parseFontFamilies(stdout) {
  const families = [];
  const seen = new Set();
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const family = normalizeFamily(line);
    if (!family) continue;
    if (family.startsWith('.') || family.startsWith('@')) continue;
    if (!/[\p{L}\p{N}]/u.test(family)) continue;
    // Windows exposes family names that differ only by case on some installs.
    const key = family.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    families.push(family);
    if (families.length >= MAX_FONTS) break;
  }
  return families.sort(compareFamilies);
}

function enumerateWindowsFonts({ execFileImpl = execFile, timeout = EXEC_TIMEOUT_MS, maxBuffer = EXEC_MAX_BUFFER } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
      { timeout, maxBuffer, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseFontFamilies(stdout));
      }
    );
  });
}

/**
 * Cached enumerator. Success is cached for five minutes; failures for thirty
 * seconds so a transient PowerShell failure can recover without a restart.
 */
function createFontEnumerator({ platform = process.platform, execFileImpl = execFile, now = Date.now } = {}) {
  let cache = null;
  let pending = null;
  async function list() {
    const time = now();
    if (cache && cache.expiresAt > time) return cache.fonts;
    if (pending) return pending;
    pending = (async () => {
      if (platform !== 'win32') return [];
      try {
        return await enumerateWindowsFonts({ execFileImpl });
      } catch {
        /* Failure is a real state, not an empty list: callers can tell the
         * difference from the IPC response and keep their fallback options. */
        return null;
      }
    })().then((fonts) => {
      cache = { fonts, expiresAt: now() + (fonts === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS) };
      return fonts;
    }).finally(() => { pending = null; });
    return pending;
  }
  function clear() { cache = null; pending = null; }
  return { list, clear };
}

function createSystemFontIpc({ ipcMain, getWindow, origin, enumerator = createFontEnumerator() }) {
  let registered = false;
  function trusted(event) {
    const win = getWindow();
    if (!win || win.isDestroyed() || event?.sender !== win.webContents || !event.senderFrame || event.senderFrame !== win.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
  }
  function register() {
    if (registered) return;
    registered = true;
    ipcMain.handle('pi-gui:fonts-list', async (event) => {
      if (!trusted(event)) return { ok: false, code: 'forbidden' };
      const fonts = await enumerator.list();
      return fonts === null
        ? { ok: false, code: 'font_enumeration_failed' }
        : { ok: true, fonts };
    });
  }
  function dispose() {
    if (!registered) return;
    registered = false;
    ipcMain.removeHandler('pi-gui:fonts-list');
  }
  return { register, dispose };
}

module.exports = {
  parseFontFamilies,
  enumerateWindowsFonts,
  createFontEnumerator,
  createSystemFontIpc,
  WINDOWS_SCRIPT,
  MAX_FONTS
};
