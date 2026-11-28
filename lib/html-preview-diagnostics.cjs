'use strict';

// Private tool feedback only. Never forward renderer strings, URLs, stacks or
// console arguments: descriptions are generated from this closed vocabulary.
const MAX_ENTRIES = 20;
const RESOURCE_TYPES = new Set(['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'xhr', 'fetch', 'other']);
const ERROR_NAMES = new Set(['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError']);
const SCRIPT_ERROR_FALLBACK = Object.freeze({ code: 'script_error' });
const SCRIPT_DESCRIPTIONS = Object.freeze({
  undefined_identifier: 'An identifier is not defined. Check its declaration and script order.',
  not_callable: 'A value is not a function. Check the called value and initialization.',
  null_property: 'A property was read from null. Check the element lookup and initialization.',
  undefined_property: 'A property was read from undefined. Check the data shape and initialization.',
  syntax: 'Invalid JavaScript syntax. Check the inline script at the reported location.',
  range: 'A value is outside the supported range or recursion limit.',
  script_exception: 'The page script threw an exception. Check the inline script at the reported location.',
});
const WARNING_CODES = new Set(['font_or_image_readiness_timeout', 'layout_feedback_limited', 'content_height_capped',
  'content_width_overflows_viewport', 'page_javascript_disabled', 'native_network_isolation_unavailable',
  'page_scripts_not_executed', 'dynamic_content_not_measured', 'layout_settle_timeout', 'fonts_unavailable']);
const HOST_CODES = new Set(['resource_blocked', 'document_load_failed', 'resource_load_failed', 'render_process_gone',
  'image_decode_failed', 'font_load_failed']);
const REASONS = new Set(['crashed', 'oom', 'killed', 'launch-failed', 'integrity-failure', 'gone']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const exact = (value, keys) => only(value, keys) && Object.keys(value).length === keys.length;
const position = value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;

function scriptDiagnostic(message, line, source) {
  if (typeof message !== 'string' || !message.startsWith('Uncaught ')) return null;
  // Ignore host/wrapper/remote errors. Position is in the rendered srcdoc, not
  // claimed to be an authored HTML line (the shared bootstrap adds a prefix).
  if (source !== 'about:srcdoc') return null;
  const prefix = message.slice(0, 512).match(/^Uncaught (?:\(in promise\) )?([A-Za-z]+Error|Error)\b/);
  // DOMException names, custom exceptions and thrown primitives are still
  // errors, but their names and values must not leave the private renderer.
  if (!prefix || !ERROR_NAMES.has(prefix[1])) return SCRIPT_ERROR_FALLBACK;
  const name = prefix[1];
  let reason = 'script_exception';
  if (name === 'SyntaxError') reason = 'syntax';
  else if (name === 'RangeError') reason = 'range';
  else if (name === 'ReferenceError' && / is not defined\b/.test(message.slice(0, 512))) reason = 'undefined_identifier';
  else if (name === 'TypeError') {
    if (/Cannot read properties of null\b/.test(message.slice(0, 512))) reason = 'null_property';
    else if (/Cannot read properties of undefined\b/.test(message.slice(0, 512))) reason = 'undefined_property';
    else if (/ is not a function\b/.test(message.slice(0, 512))) reason = 'not_callable';
  }
  return { code: 'script_error', category: 'page', name, reason, description: SCRIPT_DESCRIPTIONS[reason],
    ...(position(line) ? { location: { source: 'rendered_document', line } } : {}) };
}

function validDiagnostics(value) {
  if (!exact(value, ['console', 'errors', 'resources', 'warnings'])
    || !['console', 'errors', 'resources', 'warnings'].every(key => Array.isArray(value[key]) && value[key].length <= MAX_ENTRIES)) return false;
  if (value.console.some(item => !exact(item, ['level', 'text'])
    || !['log', 'info', 'warning', 'error'].includes(item.level) || item.text !== 'console_message')) return false;
  if (value.errors.some(item => {
    if (item?.code === 'script_error' && item.category === 'page') {
      return !only(item, ['code', 'category', 'name', 'reason', 'description', 'location'])
        || !ERROR_NAMES.has(item.name) || !Object.hasOwn(SCRIPT_DESCRIPTIONS, item.reason)
        || item.description !== SCRIPT_DESCRIPTIONS[item.reason]
        || item.location !== undefined && (!exact(item.location, ['source', 'line'])
          || item.location.source !== 'rendered_document' || !position(item.location.line));
    }
    return !only(item, ['code', 'type', 'reason']) || ![...HOST_CODES, 'script_error'].includes(item.code)
      || item.type !== undefined && !RESOURCE_TYPES.has(item.type)
      || item.reason !== undefined && !REASONS.has(item.reason);
  })) return false;
  if (value.resources.some(item => !exact(item, ['type', 'outcome']) || !RESOURCE_TYPES.has(item.type) || item.outcome !== 'blocked')) return false;
  return value.warnings.every(item => typeof item === 'string' && item.length <= 80
    && (WARNING_CODES.has(item) || /^\d{1,3}_images_unavailable$/.test(item)));
}

function resourceReadinessScript() {
  // Serialized trusted observation; never reads src, family names or page text.
  return `(()=>{const images=[...document.images];return {width:document.body.scrollWidth,
    height:Math.ceil(Math.max(document.body.scrollHeight,document.body.getBoundingClientRect().height)),
    ready:document.fonts.status==='loaded'&&images.every(img=>img.complete),
    missingImages:images.filter(img=>img.complete&&!img.naturalWidth).length,
    missingFonts:[...document.fonts].filter(font=>font.status==='error').length}})()`;
}

module.exports = { validDiagnostics, scriptDiagnostic, resourceReadinessScript };
