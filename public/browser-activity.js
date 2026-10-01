/* P23：schema 漂移的观察出口（只记来源 + 字段名 + 类型，不记值）。 */
import { noteUnknownEnum } from './schema-drift.js';

/* Browser tool semantics only —— 不含 CDP / Chrome / 包名 / 安装实现。
 *
 * 契约来源：pi-browser-harness **0.11.0** 的 `src/util/tool.ts` + `src/domains/*`。
 * 该 Extension 的每个工具都经 `registerTool` 注册，成功时 result 是
 *   { content:[{type:'text',text}], details:{ ok:true, ... } }
 * 失败时是
 *   { isError:true, content:[…], details:{ ok:false, kind, message, ... } }
 * `kind` 是**闭集**：not_connected | cdp_error | timeout | invalid_state | io_error | internal。
 * 所以「成功 / 失败」有结构化证据，不需要（也不允许）去解析正文。
 *
 * ---------- 投影纪律（沿用 P16/P18 的两条硬规则） ----------
 *
 * ① **请求参数不是成功证据。** `args.url` / `args.seconds` / `args.query` 只用于
 *    running 文案与「Requested …」；success 必须由 `details.ok === true` 证明。
 *    没有这个字段就显示「Result details unavailable」，既不拿参数顶成成功，
 *    也不改判成 error。
 * ② **只投影 allowlist 字段。** 浏览器工具的结果里混着大量原始内容与凭据：
 *    execute_js 的 `full`/`pretty`（页面里求值出来的任意值）、read_page 的
 *    `render.body`（整页正文）、network_requests 的 `requests`（URL/请求头/响应体）、
 *    console 的 `records`、fill 的 `value`（**刚输入的内容**）、upload/download/pdf
 *    的 `filePath`（本机绝对路径）。这些**一个都不进 DOM**，也不进诊断报告。
 *
 * ---------- 输入内容的默认策略 ----------
 *
 * 输入框内容默认**完全不投影**：type/fill/fill_form 的 text/value 一律不显示，
 * 连长度都不显示。select 是唯一例外，而且必须过一道保守 allowlist
 * （短、无邮箱/冒号/路径字符、无连续 5 位以上数字、无敏感词）才显示选项文案；
 * 过不了就只显示「Selected option」。**不从 DOM 文本猜「这是密码」** ——
 * 只对结构化字段做标记，默认策略仍然是不显示。 */

/** pi-browser-harness 0.11.0 的 40 个工具名（`src/registry.ts` 的 ALL_TOOLS）。
 *  名字不匹配的工具走 generic fallback —— 宁可少一层语义，也不猜。 */
export const BROWSER_TOOLS = new Set([
  'browser_setup',
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_fill_form',
  'browser_select_option',
  'browser_set_checked',
  'browser_focus',
  'browser_press_key',
  'browser_dispatch_key',
  'browser_scroll',
  'browser_page_info',
  'browser_wait',
  'browser_wait_for',
  'browser_wait_for_load',
  'browser_handle_dialog',
  'browser_screenshot',
  'browser_navigate',
  'browser_open_urls',
  'browser_go_back',
  'browser_go_forward',
  'browser_reload',
  'browser_list_tabs',
  'browser_current_tab',
  'browser_switch_tab',
  'browser_new_tab',
  'browser_close_tab',
  'browser_upload_file',
  'browser_download',
  'browser_print_to_pdf',
  'browser_viewport_resize',
  'browser_drag_and_drop',
  'browser_http_get',
  'browser_network_requests',
  'browser_console',
  'browser_snapshot',
  'browser_execute_js',
  'browser_run_script',
  'browser_web_search',
  'browser_read_page',
]);

const MAX_URL = 2048;
const BAD_CHARS = /[\s\u0000-\u001f\u007f]/;

/** 结构化 URL 也是不可信输入。只认 http/https，拒绝凭据、控制字符、空白、超长值。 */
function parseHttpUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL || BAD_CHARS.test(value)) return null;
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) return null;
    if (u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

/** 页面地址 → 主机名。只用于「Opened <host>」这类纯文本，永远不当链接用。 */
export function browserHost(value) {
  const u = parseHttpUrl(value);
  return u ? u.hostname : null;
}

/** 可点击的页面地址。
 *
 * 比 P16 的 `safeWebUrl` 更严：**再拒掉带 query / fragment 的地址**。
 * 理由很直接 —— 令牌、一次性链接、OTP 回调都挂在 query 上，
 * 「token 永远不进 DOM」这条约束在这里必须落到 URL 层面。
 * 被拒不影响主机名照常以纯文本显示。 */
export function safeBrowserUrl(value) {
  const u = parseHttpUrl(value);
  if (!u || u.search || u.hash) return null;
  return u.href;
}

/* ---------- 保守 allowlist ---------- */

const SENSITIVE_OPTION_RE = /pass|pwd|token|secret|otp|pin|cvv|ssn|iban|account|card|auth|cookie|bearer|api[\s_-]?key/i;

/** select 的选项文案。过不了这道闸就返回 null（= 不显示）。 */
export function nonSensitiveOption(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 40) return null;
  if (/[\u0000-\u001f\u007f]/.test(v)) return null;
  if (/[@:;/\\<>"']/.test(v)) return null;
  if (/\d{5,}/.test(v)) return null;
  if (SENSITIVE_OPTION_RE.test(v)) return null;
  return v;
}

/** 具名按键才显示。单个可打印字符可能是密码的一位，一律不显示。 */
const NAMED_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', ' ',
]);

function safeKey(value) {
  if (typeof value !== 'string') return '';
  if (value === ' ') return 'Space';
  return NAMED_KEYS.has(value) ? value : '';
}

const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

/** 闭集枚举才回显原值；不认识就不显示（不回显上游原值）。 */
const oneOf = (v, allowed) => (allowed.includes(v) ? v : null);

/** 只接受标准 mime 形状，别的（含上游自由文本）不显示。 */
function safeMime(value) {
  const m = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*/i.exec(str(value, 100));
  return m ? m[0] : '';
}

const ERROR_KINDS = ['not_connected', 'cdp_error', 'timeout', 'invalid_state', 'io_error', 'internal'];/* ---------- 动作表 ---------- */

/* [running, done, failed]。done 为 null 表示「由证据决定」，
 * 没有证据时退回 T[2] 之外的通用说法（见 labelOf）。 */
const T = {
  browser_setup: ['Initializing browser…', 'Initialized browser', 'Browser setup failed'],
  browser_navigate: ['Opening…', null, 'Navigation failed'],
  browser_open_urls: ['Opening…', null, 'Opening pages failed'],
  browser_go_back: ['Going back…', 'Went back', 'Going back failed'],
  browser_go_forward: ['Going forward…', 'Went forward', 'Going forward failed'],
  browser_reload: ['Reloading…', 'Reloaded page', 'Reload failed'],
  browser_click: ['Clicking…', null, 'Click failed'],
  browser_focus: ['Focusing…', null, 'Focus failed'],
  browser_type: ['Entering text…', 'Entered text', 'Entering text failed'],
  browser_fill: ['Entering text…', 'Entered text', 'Entering text failed'],
  browser_fill_form: ['Filling form…', null, 'Filling form failed'],
  browser_select_option: ['Selecting option…', 'Selected option', 'Selecting option failed'],
  browser_set_checked: ['Setting checked state…', null, 'Setting checked state failed'],
  browser_press_key: ['Pressing key…', null, 'Pressing key failed'],
  browser_dispatch_key: ['Dispatching key…', null, 'Dispatching key failed'],
  browser_wait: ['Waiting…', null, 'Wait failed'],
  browser_wait_for: ['Waiting…', null, 'Wait failed'],
  browser_wait_for_load: ['Waiting for page…', null, 'Waiting for page failed'],
  browser_screenshot: ['Capturing screenshot…', 'Captured page screenshot', 'Screenshot failed'],
  browser_snapshot: ['Reading page structure…', 'Read page structure', 'Reading page structure failed'],
  browser_read_page: ['Reading page…', 'Read page', 'Reading page failed'],
  browser_page_info: ['Checking page…', null, 'Checking page failed'],
  browser_current_tab: ['Checking current tab…', null, 'Checking current tab failed'],
  browser_list_tabs: ['Listing tabs…', null, 'Listing tabs failed'],
  browser_new_tab: ['Opening tab…', null, 'Opening tab failed'],
  browser_switch_tab: ['Switching tab…', 'Switched tab', 'Switching tab failed'],
  browser_close_tab: ['Closing tab…', 'Closed tab', 'Closing tab failed'],
  browser_scroll: ['Scrolling…', 'Scrolled page', 'Scrolling failed'],
  browser_viewport_resize: ['Resizing viewport…', 'Resized viewport', 'Resizing viewport failed'],
  browser_drag_and_drop: ['Dragging…', 'Dragged element', 'Drag failed'],
  browser_handle_dialog: ['Handling dialog…', null, 'Handling dialog failed'],
  browser_execute_js: ['Running page script…', 'Ran page script', 'Page script failed'],
  browser_run_script: ['Running page script…', 'Ran page script', 'Page script failed'],
  browser_http_get: ['Fetching URL…', null, 'Fetch failed'],
  browser_network_requests: ['Reading network activity…', 'Read network activity', 'Reading network activity failed'],
  browser_console: ['Reading console…', 'Read console', 'Reading console failed'],
  browser_upload_file: ['Uploading file…', 'Uploaded file', 'Upload failed'],
  browser_download: ['Configuring downloads…', 'Configured downloads', 'Configuring downloads failed'],
  browser_print_to_pdf: ['Printing to PDF…', 'Saved page as PDF', 'Print to PDF failed'],
  browser_web_search: ['Searching…', null, 'Browser search failed'],
};

/** 这些动作会把页面地址作为可点击来源挂出来 —— 其余动作不给链接。 */
const LINK_ACTIONS = new Set(['browser_navigate', 'browser_open_urls', 'browser_new_tab', 'browser_read_page']);

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

/** 元素摘要：只用 ref（快照句柄）或坐标，不用 selector ——
 *  selector 是模型写的自由文本，属于不可信输入，不进 DOM。 */
function elementLabel(d, a) {
  const ref = str(d.ref, 32) || str(a.ref, 32);
  if (/^e\d{1,6}$/.test(ref)) return `[${ref}]`;
  const x = int(d.x, 0, 100000);
  const y = int(d.y, 0, 100000);
  if (x !== null && y !== null) return `(${x}, ${y})`;
  return '';
}

/** 允许挂链接的地址（仅在动作属于 LINK_ACTIONS 时调用）。 */
function linkSources(name, d, a) {
  if (!LINK_ACTIONS.has(name)) return [];
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const url = safeBrowserUrl(value);
    if (!url || seen.has(url) || out.length >= 10) return;
    seen.add(url);
    out.push({ url, hostname: new URL(url).hostname, title: '' });
  };
  push(d.url);
  push(obj(d.page).url);
  push(a.url);
  /* 只挂真正打开成功的那些标签页。 */
  for (const t of arr(d.tabs).slice(0, 10)) if (obj(t).ok === true) push(obj(t).url);
  return out;
}

/** 具体事实。**只读 allowlist 字段**；调用方保证「已结束且 proven」时才调用。 */
function factsOf(name, a, d) {
  const f = [];
  const add = (s) => { if (s) f.push(s); };
  const page = obj(d.page);

  switch (name) {
    case 'browser_navigate': {
      const w = int(page.width, 1, 100000), h = int(page.height, 1, 100000);
      if (w && h) add(`Viewport: ${w}x${h}`);
      const kind = oneOf(obj(d.outcome).kind, ['in_place', 'new_tab_created']);
      if (kind) add(kind === 'new_tab_created' ? 'Opened in a new tab' : 'Navigated in place');
      const dlg = oneOf(obj(d.dialog).type, ['alert', 'confirm', 'prompt', 'beforeunload']);
      if (dlg) add(`Dialog open: ${dlg}`);
      break;
    }
    case 'browser_open_urls': {
      const tabs = arr(d.tabs);
      const ok = tabs.filter((t) => obj(t).ok === true).length;
      if (tabs.length) add(`Opened ${ok}/${tabs.length} URLs`);
      break;
    }
    case 'browser_click':
    case 'browser_focus':
    case 'browser_fill':
    case 'browser_select_option':
    case 'browser_set_checked':
    case 'browser_dispatch_key': {
      const el = elementLabel(d, a);
      if (el) add(`Element: ${el}`);
      if (name === 'browser_click') {
        const x = int(d.x, 0, 100000), y = int(d.y, 0, 100000);
        if (x !== null && y !== null) add(`Coordinates: (${x}, ${y})`);
      }
      if (name === 'browser_fill') {
        const tag = str(d.tag, 24);
        if (/^[a-z]+$/i.test(tag)) add(`Field: <${tag.toLowerCase()}>`);
      }
      if (name === 'browser_set_checked' && typeof d.checked === 'boolean') add(`Checked: ${d.checked}`);
      if (name === 'browser_select_option') {
        const opt = nonSensitiveOption(d.label);
        if (opt) add(`Option: ${opt}`);
      }
      if (name === 'browser_dispatch_key') {
        const matched = int(d.matched, 0, 100000);
        if (matched !== null) add(`Matched: ${matched}`);
      }
      break;
    }
    case 'browser_fill_form': {
      const rows = arr(d.results);
      const ok = rows.filter((r) => obj(r).ok === true).length;
      if (rows.length) add(`Fields: ${ok}/${rows.length} filled`);
      break;
    }
    case 'browser_press_key': {
      const mods = int(a.modifiers, 0, 15);
      if (mods) add(`Modifiers: ${mods}`);
      break;
    }
    case 'browser_wait': {
      const s = num(a.seconds, 0, 600);
      if (s !== null) add(`Waited: ${Math.round(s * 10) / 10}s`);
      break;
    }
    case 'browser_wait_for':
    case 'browser_wait_for_load': {
      const ms = num(d.ms, 0, 3600000);
      if (ms !== null) add(`Waited: ${Math.round(ms / 100) / 10}s`);
      break;
    }
    case 'browser_screenshot': {
      const fmt = oneOf(d.format, ['png', 'jpeg']);
      if (fmt) add(`Format: ${fmt}`);
      break;
    }
    case 'browser_snapshot': {
      const n = int(d.nodeCount, 0, 10000000);
      if (n !== null) add(`Elements: ${n}`);
      const summary = str(d.summary, 120);
      if (summary) add(`Structure: ${summary}`);
      if (d.truncated === true) add('Truncated: yes');
      break;
    }
    case 'browser_read_page': {
      const words = int(d.wordCount, 0, 100000000);
      if (words !== null) add(`Words: ${words}`);
      break;
    }
    case 'browser_page_info': {
      const w = int(d.width, 1, 100000), h = int(d.height, 1, 100000);
      if (w && h) add(`Viewport: ${w}x${h}`);
      const sx = int(d.scrollX, -10000000, 10000000), sy = int(d.scrollY, -10000000, 10000000);
      if (sx !== null && sy !== null) add(`Scroll: (${sx}, ${sy})`);
      break;
    }
    case 'browser_current_tab': {
      if (typeof d.owned === 'boolean') add(`Owned by this session: ${d.owned ? 'yes' : 'no'}`);
      break;
    }
    case 'browser_list_tabs': {
      const scope = oneOf(d.scope, ['owned', 'all']);
      if (scope) add(`Scope: ${scope}`);
      const tabs = arr(d.tabs);
      if (tabs.length) add(`Tabs: ${tabs.length}`);
      break;
    }
    case 'browser_scroll': {
      const x = int(d.x, 0, 100000), y = int(d.y, 0, 100000);
      if (x !== null && y !== null) add(`At: (${x}, ${y})`);
      const dx = int(d.deltaX, -100000, 100000), dy = int(d.deltaY, -100000, 100000);
      if (dx !== null && dy !== null) add(`Delta: (${dx}, ${dy})`);
      break;
    }
    case 'browser_viewport_resize': {
      const w = int(d.width, 1, 100000), h = int(d.height, 1, 100000);
      if (w && h) add(`Viewport: ${w}x${h}`);
      const s = num(d.deviceScaleFactor, 0.1, 10);
      if (s !== null) add(`Scale: ${s}`);
      break;
    }
    case 'browser_handle_dialog': {
      if (typeof d.accept === 'boolean') add(`Dialog: ${d.accept ? 'accepted' : 'dismissed'}`);
      break;
    }
    case 'browser_execute_js':
    case 'browser_run_script': {
      const len = int(d.valueLength, 0, 100000000);
      if (len !== null) add(`Result size: ${len} chars`);
      break;
    }
    case 'browser_http_get': {
      const status = int(d.status, 100, 599);
      if (status !== null) add(`HTTP status: ${status}`);
      const mime = safeMime(d.contentType);
      if (mime) add(`Content type: ${mime}`);
      const len = int(d.length, 0, 1000000000);
      if (len !== null) add(`Size: ${len} bytes`);
      break;
    }
    case 'browser_network_requests':
    case 'browser_console': {
      const returned = int(d.returned, 0, 1000000);
      const total = int(d.total, 0, 1000000);
      if (returned !== null && total !== null) add(`${name === 'browser_console' ? 'Messages' : 'Requests'}: ${returned}/${total}`);
      else if (total !== null) add(`${name === 'browser_console' ? 'Messages' : 'Requests'}: ${total}`);
      if (d.includeBodies === true) add('Bodies included: yes');
      break;
    }
    case 'browser_upload_file': {
      const mode = oneOf(d.mode, ['cdp', 'js']);
      if (mode) add(`Mode: ${mode}`);
      break;
    }
    case 'browser_web_search': {
      const engine = oneOf(d.engine, ['google']);
      if (engine) add(`Engine: ${engine}`);
      const n = arr(d.results).length;
      if (n) add(`Results: ${n}`);
      break;
    }
    default:
      break;
  }
  return f;
}

/** 一句话摘要（.tl-arg 那一列）。同样是 allowlist。 */
function summaryOf(name, a, d, proven) {
  switch (name) {
    case 'browser_navigate':
    case 'browser_new_tab':
    case 'browser_read_page':
    case 'browser_http_get': {
      const host = browserHost(str(d.url, MAX_URL)) || browserHost(str(a.url, MAX_URL));
      if (host) return host;
      return proven ? 'Page unavailable' : '';
    }
    case 'browser_open_urls': {
      const tabs = arr(d.tabs);
      if (tabs.length) return `${tabs.filter((t) => obj(t).ok === true).length}/${tabs.length} URLs`;
      return arr(a.urls).length ? `${arr(a.urls).length} URLs requested` : '';
    }
    case 'browser_click':
    case 'browser_focus':
    case 'browser_fill':
    case 'browser_set_checked':
    case 'browser_dispatch_key':
      return elementLabel(d, a);
    case 'browser_select_option': {
      const opt = nonSensitiveOption(d.label);
      return opt || elementLabel(d, a);
    }
    case 'browser_fill_form': {
      const rows = arr(d.results);
      return rows.length ? `${rows.filter((r) => obj(r).ok === true).length}/${rows.length} fields` : '';
    }
    case 'browser_press_key':
      return safeKey(a.key);
    case 'browser_wait': {
      const s = num(a.seconds, 0, 600);
      return s !== null ? `${Math.round(s * 10) / 10}s` : '';
    }
    case 'browser_wait_for':
    case 'browser_wait_for_load': {
      const ms = num(d.ms, 0, 3600000);
      return ms !== null ? `${Math.round(ms / 100) / 10}s` : '';
    }
    case 'browser_list_tabs': {
      const tabs = arr(d.tabs);
      return tabs.length ? `${tabs.length} tabs` : '';
    }
    case 'browser_web_search': {
      const q = str(a.query, 200) || str(d.query, 200);
      return q;
    }
    default:
      return '';
  }
}

function labelOf(name, status, d, a) {
  const row = T[name];
  const running = status === 'running';
  if (running) return row[0];
  if (status === 'error') return row[2];
  if (['cancelled', 'interrupted', 'incomplete'].includes(status)) {
    return row[0].replace(/…$/, '') + ' stopped';
  }
  // 已结束但没有结构化成功证据：说清楚「结果不可用」，不拿请求参数顶成成功。
  // 措辞必须同时区别于 running（尾随 …）与 failed（failed），所以用破折号。
  const proven = d.ok === true;
  if (!proven) return row[0].replace(/…$/, '') + ' — result unavailable';
  if (name === 'browser_navigate') {
    const host = browserHost(str(obj(d.page).url, MAX_URL));
    return host ? `Opened ${host}` : 'Opened page';
  }
  if (name === 'browser_open_urls') {
    const tabs = arr(d.tabs);
    const ok = tabs.filter((t) => obj(t).ok === true).length;
    return ok ? `Opened ${ok} page${ok === 1 ? '' : 's'}` : 'Opened pages';
  }
  if (name === 'browser_new_tab') {
    const host = browserHost(str(d.url, MAX_URL));
    return host ? `Opened ${host}` : 'Opened tab';
  }
  if (name === 'browser_read_page') {
    const host = browserHost(str(d.url, MAX_URL));
    return host ? `Read ${host}` : 'Read page';
  }
  if (name === 'browser_click') {
    const el = elementLabel(d, a);
    return el ? `Clicked ${el}` : 'Clicked element';
  }
  if (name === 'browser_focus') {
    const el = elementLabel(d, a);
    return el ? `Focused ${el}` : 'Focused element';
  }
  if (name === 'browser_handle_dialog') {
    return typeof d.accept === 'boolean' ? `Handled dialog (${d.accept ? 'accepted' : 'dismissed'})` : 'Handled dialog';
  }
  if (name === 'browser_http_get') {
    const host = browserHost(str(a.url, MAX_URL));
    return host ? `Fetched ${host}` : 'Fetched URL';
  }
  if (name === 'browser_wait' || name === 'browser_wait_for' || name === 'browser_wait_for_load') {
    const ms = num(d.ms, 0, 3600000);
    if (ms !== null) return `Waited ${Math.round(ms / 100) / 10}s`;
    const s = num(a.seconds, 0, 600);
    return s !== null ? `Waited ${Math.round(s * 10) / 10}s` : 'Waited';
  }
  if (name === 'browser_page_info') {
    const host = browserHost(str(d.url, MAX_URL));
    return host ? `Checked ${host}` : 'Checked page';
  }
  if (name === 'browser_current_tab') {
    const host = browserHost(str(d.url, MAX_URL));
    return host ? `Checked tab on ${host}` : 'Checked current tab';
  }
  if (name === 'browser_snapshot') {
    const n = int(d.nodeCount, 0, 10000000);
    return n !== null ? `Read page structure (${n} elements)` : 'Read page structure';
  }
  if (name === 'browser_fill_form') {
    const rows = arr(d.results);
    const ok = rows.filter((r) => obj(r).ok === true).length;
    return rows.length ? `Filled ${ok}/${rows.length} fields` : 'Filled form';
  }
  if (name === 'browser_set_checked') {
    return typeof d.checked === 'boolean' ? `Set checked state (${d.checked})` : 'Set checked state';
  }
  if (name === 'browser_press_key') {
    const key = safeKey(a.key);
    return key ? `Pressed ${key}` : 'Pressed key';
  }
  if (name === 'browser_dispatch_key') {
    const key = safeKey(a.key);
    return key ? `Dispatched ${key}` : 'Dispatched key';
  }
  if (name === 'browser_list_tabs') {
    const n = arr(d.tabs).length;
    return n ? `Listed ${n} tabs` : 'Listed tabs';
  }
  if (name === 'browser_web_search') {
    const n = arr(d.results).length;
    return n ? `Searched the web (${n} results)` : 'Searched the web';
  }
  return row[1] || row[0].replace(/…$/, '');
}

/**
 * 一条 ToolEntry → 浏览器 Activity。不是已适配的浏览器工具就返回 null
 * （调用方落回 generic fallback）。
 *
 * @returns {{label:string,status:string,known:boolean,summary:string,facts:string,sources:Array}|null}
 */
export function browserActivity(entry) {
  const name = entry?.name;
  if (!BROWSER_TOOLS.has(name)) return null;

  const a = obj(entry.args);
  const d = obj(entry.details);

  let status = entry.status || 'running';
  if (status !== 'running') {
    // 结构化证据优先：details.ok === false 就是失败，不管 pi 的 isError 怎么说。
    if (d.ok === false) status = 'error';
    else if (d.cancelled === true) status = 'cancelled';
  }
  const settledOk = status !== 'running' && status !== 'error' && d.ok === true;

  const facts = [];
  let summary = '';
  if (status === 'error') {
    const kind = oneOf(d.kind, ERROR_KINDS);
    /* P23：闭集外的失败种类不是错误，但**要看得见** —— 只记字段名与类型，不记值。 */
    if (!kind && typeof d.kind === 'string' && d.kind) noteUnknownEnum('browser', 'details.kind', d.kind);
    facts.push(kind ? `Error: ${kind}` : 'Result details unavailable');
    // 失败时允许显示「请求的目标」（主机名 / 元素句柄）—— 这不是成功声明。
    summary = summaryOf(name, a, d, false);
  } else if (status === 'running') {
    facts.push(...factsOf(name, a, d));
    summary = summaryOf(name, a, d, false);
  } else if (settledOk) {
    facts.push(...factsOf(name, a, d));
    summary = summaryOf(name, a, d, true);
  } else {
    /* 已结束但没有结构化成功证据：一个具体字段都不给，避免「看起来像成功」。 */
    facts.push('Result details unavailable');
  }

  return {
    label: labelOf(name, status, d, a),
    status,
    known: true,
    summary,
    facts: facts.join('\n'),
    sources: settledOk ? linkSources(name, d, a) : [],
  };
}
