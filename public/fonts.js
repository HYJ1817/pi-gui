/* Global UI font preference and optional system-font enumeration.
 *
 * A selection is stored as a complete CSS font-family stack in
 * `pi-gui.font-family.v2`; an empty string is the built-in system stack.
 * Every custom stack ends with platform CJK faces so choosing an English-only
 * family cannot turn Chinese text into missing-glyph boxes. Code, terminals
 * and diffs keep their own `--font-mono` / `--ui-font-mono` stacks.
 */

export const FONT_STORAGE_KEY = 'pi-gui.font-family.v2';
export const LEGACY_FONT_STORAGE_KEY = 'pi-gui.font-family.v1';
export const FONT_SCALE_KEY = 'pi-gui.font-scale.v1';

export const CJK_FALLBACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Microsoft YaHei UI", sans-serif';
export const LEGACY_MONO_STACK = 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", "Microsoft YaHei", monospace';
export const LEGACY_SANS_STACK = '"Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

export const FONT_SCALE_MIN = 80;
export const FONT_SCALE_MAX = 150;
export const FONT_SCALE_STEP = 5;
export const FONT_SCALE_PRESETS = Object.freeze([100, 110, 120, 130]);

const MAX_STACK_LENGTH = 512;
const MAX_FONTS = 4096;

function clampText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/** Quote a bare family name for use inside a CSS font-family stack. */
export function cssFamilyForName(name) {
  return `'${clampText(name, 120).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Extract the first readable family name from a CSS stack. */
export function readableFontFamily(stack) {
  const first = clampText(stack, MAX_STACK_LENGTH).split(',')[0]?.trim() ?? '';
  return first.replace(/^['"]|['"]$/g, '').replace(/\\'/g, "'");
}

export function systemStackForFamily(family) {
  return `${cssFamilyForName(family)}, ${CJK_FALLBACK}`;
}

const CJK_MARKERS = ['pingfang sc', 'hiragino sans gb', 'microsoft yahei', 'microsoft yahei ui'];

/** Keep a reliable CJK tier at the end of every custom UI stack. */
export function withCjkFallback(stack) {
  const value = clampText(stack, MAX_STACK_LENGTH);
  if (!value) return '';
  const lower = value.toLocaleLowerCase();
  if (CJK_MARKERS.some((marker) => lower.includes(marker))) return value;
  const trimmed = value.replace(/,\s*(sans-serif|system-ui|ui-sans-serif)\s*$/i, '');
  return clampText(`${trimmed}, ${CJK_FALLBACK}`, MAX_STACK_LENGTH);
}

/** Normalize a stored stack without inventing a family that is not installed. */
export function normalizeFontValue(value) {
  if (typeof value !== 'string') return '';
  return withCjkFallback(value);
}

export function legacyFontValue(token) {
  if (token === 'mono') return LEGACY_MONO_STACK;
  if (token === 'sans') return LEGACY_SANS_STACK;
  return '';
}

function resolveStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** Read v2, then migrate the v1 tokens in memory. Never writes during read. */
export function readFontPreference(storage = null) {
  const store = resolveStorage(storage);
  let current = null;
  try { current = store?.getItem(FONT_STORAGE_KEY) ?? null; } catch { /* Storage may be disabled. */ }
  if (typeof current === 'string') return { value: normalizeFontValue(current), migrated: false, source: 'v2' };
  let previous = null;
  try { previous = store?.getItem(LEGACY_FONT_STORAGE_KEY) ?? null; } catch { /* Storage may be disabled. */ }
  if (typeof previous === 'string') {
    return { value: legacyFontValue(previous), migrated: true, source: 'v1', legacyToken: previous };
  }
  return { value: '', migrated: false, source: 'default' };
}

/** Persist v2 and retire the legacy key. Throws when the write is refused. */
export function writeFontPreference(value, storage = null) {
  const normalized = normalizeFontValue(value);
  const store = resolveStorage(storage);
  if (!store) throw new Error('font storage unavailable');
  store.setItem(FONT_STORAGE_KEY, normalized);
  try { store.removeItem(LEGACY_FONT_STORAGE_KEY); } catch { /* The v2 value is authoritative. */ }
  return normalized;
}

/** Apply only the sans/UI variables; mono lookups stay untouched. */
export function applyFontPreference(value, root = globalThis.document?.documentElement) {
  if (!root?.style) return;
  const normalized = normalizeFontValue(value);
  if (normalized) {
    root.style.setProperty('--font-sans', normalized);
    root.style.setProperty('--ui-font-sans', normalized);
  } else {
    root.style.removeProperty('--font-sans');
    root.style.removeProperty('--ui-font-sans');
  }
}

export function resolveFontScale(value) {
  if (value === null || value === undefined || value === '') return 100;
  const number = Number(value);
  if (!Number.isFinite(number)) return 100;
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, number));
  return Math.round(clamped / FONT_SCALE_STEP) * FONT_SCALE_STEP;
}

export function applyFontScale(value, root = globalThis.document?.documentElement) {
  const scale = resolveFontScale(value);
  root?.style?.setProperty('--font-scale', (scale / 100).toFixed(2));
  return scale;
}

export function readFontScale(storage = null) {
  try {
    const raw = resolveStorage(storage)?.getItem(FONT_SCALE_KEY);
    if (raw === null || raw === undefined || raw === '') return 100;
    const value = Number(raw);
    if (!Number.isFinite(value)) return 100;
    return resolveFontScale(value);
  } catch { return 100; }
}

export function writeFontScale(value, storage = null) {
  const scale = resolveFontScale(value);
  const store = resolveStorage(storage);
  if (!store) throw new Error('font storage unavailable');
  store.setItem(FONT_SCALE_KEY, String(scale));
  return scale;
}

function cleanFamily(value) {
  if (typeof value !== 'string') return '';
  const family = clampText(value, 120);
  if (!family || family.startsWith('.') || family.startsWith('@')) return '';
  return /[\p{L}\p{N}]/u.test(family) ? family : '';
}

export function normalizeFontList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const fonts = [];
  for (const item of value) {
    const family = cleanFamily(item);
    const key = family.toLocaleLowerCase();
    if (!family || seen.has(key)) continue;
    seen.add(key);
    fonts.push(family);
    if (fonts.length >= MAX_FONTS) break;
  }
  return fonts.sort((a, b) => a.localeCompare(b, 'zh-CN', { sensitivity: 'base' }) || a.localeCompare(b));
}

/**
 * Build the picker model. The selected value that no longer matches an
 * installed family is kept as a `custom` option so a stale preference is
 * visible and removable rather than silently rewritten.
 */
export function buildFontOptions(systemFonts, selectedValue) {
  const selected = normalizeFontValue(selectedValue);
  const options = [{ value: '', label: '跟随系统', family: '', group: 'default' }];
  const known = new Set(['']);
  for (const family of normalizeFontList(systemFonts)) {
    const value = systemStackForFamily(family);
    if (known.has(value)) continue;
    known.add(value);
    options.push({ value, label: family, family, group: 'system' });
  }
  options.push(
    { value: LEGACY_SANS_STACK, label: '系统无衬线（旧设置）', family: '"Segoe UI"', group: 'builtin' },
    { value: LEGACY_MONO_STACK, label: '等宽优先（旧设置）', family: 'ui-monospace', group: 'builtin' }
  );
  for (const option of options) known.add(option.value);
  if (selected && !known.has(selected)) {
    const label = readableFontFamily(selected) || '当前字体';
    options.splice(1, 0, { value: selected, label, family: label, group: 'custom' });
  }
  return options;
}

export function filterFontOptions(options, query) {
  const needle = String(query ?? '').trim().toLocaleLowerCase();
  if (!needle) return options;
  return options.filter((option) => {
    const haystack = `${option.label} ${option.group === 'default' ? '默认 系统' : ''}`.toLocaleLowerCase();
    return haystack.includes(needle);
  });
}

let cachedFonts = null;
let pendingFonts = null;

/**
 * Read installed families once per renderer process. The web build has no
 * bridge, so it reports `unavailable` instead of pretending enumeration ran.
 */
export async function loadSystemFonts({ bridge = globalThis.window?.piGuiDesktop?.fonts } = {}) {
  if (!bridge || typeof bridge.list !== 'function') return { status: 'unavailable', fonts: [] };
  if (cachedFonts) return cachedFonts;
  if (!pendingFonts) {
    pendingFonts = Promise.resolve(bridge.list())
      .then((result) => {
        if (!result || result.ok !== true) return { status: 'failed', fonts: [] };
        return { status: 'ok', fonts: normalizeFontList(result.fonts) };
      })
      .catch(() => ({ status: 'failed', fonts: [] }))
      .finally(() => { pendingFonts = null; });
  }
  const result = await pendingFonts;
  if (result.status === 'ok') cachedFonts = result;
  return result;
}

export function resetSystemFontsCache() {
  cachedFonts = null;
  pendingFonts = null;
}
