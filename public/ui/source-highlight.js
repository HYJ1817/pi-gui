import { esc } from '../html-escape.js';

/* 源码预览的轻量语法高亮。
 *
 * 不是通用着色引擎：只覆盖 Pi-GUI 文件面板实际会遇到的常见语言，目标是
 * 让注释/字符串/关键字/属性一眼可分，而不是做到 IDE 级精确。
 *
 * 安全模型与 markdown.js 相同：**所有源码先切 token，再由本文件生成
 * 白名单 span，token 文本一律 esc()**。源码里的 `<script>` 只能是转义后的
 * 文本，不可能变成活标签。
 *
 * 大文件不在这里做全量着色：超过 MAX_HIGHLIGHT_CHARS 直接返回转义纯文本，
 * 让打开 200KB 日志仍然瞬时完成。 */

export const MAX_HIGHLIGHT_CHARS = 200 * 1024;

const LANG_BY_EXT = Object.freeze({
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html', xml: 'html', svg: 'html',
  md: 'md', markdown: 'md',
  py: 'py', pyw: 'py',
  rs: 'rs', go: 'go', java: 'java', kt: 'java', kts: 'java',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', cs: 'c', swift: 'c', m: 'c',
  sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh', bat: 'sh', cmd: 'sh',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml', ini: 'yaml', conf: 'yaml', env: 'yaml', properties: 'yaml',
  sql: 'sql',
});

const KEYWORDS = {
  js: new Set(('as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public readonly return set static super switch this throw true try typeof undefined var void while with yield type declare namespace abstract keyof infer is asserts satisfies override').split(' ')),
  py: new Set(('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self').split(' ')),
  rs: new Set(('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while').split(' ')),
  go: new Set(('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota').split(' ')),
  java: new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public record return sealed short static strictfp super switch synchronized this throw throws transient try var void volatile while true false null extends permits yield').split(' ')),
  c: new Set(('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace public private protected virtual override template typename using new delete true false null nullptr constexpr noexcept throw try catch').split(' ')),
  sh: new Set(('if then else elif fi for while until do done case esac in function select time true false local export readonly return').split(' ')),
  sql: new Set(('select from where insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset as and or not null is distinct union all exists case when then else end primary key foreign references default').split(' ')),
  yaml: new Set(('true false null yes no on off').split(' ')),
};

const FAMILY = {
  js: 'code', py: 'code', rs: 'code', go: 'code', java: 'code', c: 'code', sh: 'code', sql: 'code', yaml: 'yaml',
};

export function languageForPath(filePath) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(filePath || ''));
  if (!match) return null;
  return LANG_BY_EXT[match[1].toLowerCase()] || null;
}

const MOD = new Set(['com', 'str', 'num', 'kw', 'fn', 'type', 'lit', 'tag', 'attr', 'key', 'meta']);

const cls = (type) => type && MOD.has(type) ? (type === 'key' ? 'tok-attr' : `tok-${type}`) : '';

function toHtml(tokens) {
  let out = '';
  for (const [type, text] of tokens) {
    if (!text) continue;
    out += type ? `<span class="${cls(type)}">${esc(text)}</span>` : esc(text);
  }
  return out;
}

function lineTokens(src, fn) {
  const lines = String(src ?? '').split('\n');
  const tokens = [];
  lines.forEach((line, index) => {
    if (index) tokens.push(['', '\n']);
    fn(line, tokens);
  });
  return tokens;
}

/* ---------- 通用代码 ---------- */

function scanCode(src, lang) {
  const tokens = [];
  const len = src.length;
  let plainFrom = 0;
  const add = (type, start, end) => {
    if (end <= start) return;
    if (start > plainFrom) tokens.push(['', src.slice(plainFrom, start)]);
    tokens.push([type, src.slice(start, end)]);
    plainFrom = end;
  };
  const isHash = lang === 'py' || lang === 'sh';
  const keywords = KEYWORDS[lang] || KEYWORDS.c;
  const literals = new Set(['true', 'false', 'null', 'nil', 'None', 'True', 'False', 'undefined', 'self', 'this']);
  let i = 0;

  while (i < len) {
    const ch = src[i];

    if (!isHash && ch === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = len;
      add('com', i, end); i = end; continue;
    }
    if (!isHash && ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? len : close + 2;
      add('com', i, end); i = end; continue;
    }
    if (isHash && ch === '#') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = len;
      add('com', i, end); i = end; continue;
    }
    if (lang === 'py' && ch === '@' && /[A-Za-z_]/.test(src[i + 1] || '')) {
      let end = i + 1;
      while (end < len && /[\w.]/.test(src[end])) end++;
      add('meta', i, end); i = end; continue;
    }

    if (ch === '"' || ch === "'" || (ch === '`' && lang === 'js')) {
      const triple = lang === 'py' && src.startsWith(ch.repeat(3), i);
      let end;
      if (triple) {
        const close = src.indexOf(ch.repeat(3), i + 3);
        end = close < 0 ? len : close + 3;
      } else {
        end = i + 1;
        while (end < len) {
          if (src[end] === '\\') { end += 2; continue; }
          if (src[end] === ch) { end++; break; }
          if (src[end] === '\n' && ch !== '`') break;
          end++;
        }
      }
      add('str', i, end); i = end; continue;
    }

    if (ch >= '0' && ch <= '9' && !/[\w$]/.test(src[i - 1] || '')) {
      const rest = src.slice(i);
      const m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)/.exec(rest);
      if (m && !/[\w$]/.test(src[i + m[0].length] || '')) {
        add('num', i, i + m[0].length); i += m[0].length; continue;
      }
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < len && /[\w$]/.test(src[end])) end++;
      const word = src.slice(i, end);
      let after = end;
      while (after < len && (src[after] === ' ' || src[after] === '\t')) after++;
      if (keywords.has(word)) add(literals.has(word) ? 'lit' : 'kw', i, end);
      else if (src[after] === '(') add('fn', i, end);
      else if (/^[A-Z]/.test(word) && word.length > 1) add('type', i, end);
      i = end; continue;
    }

    i++;
  }

  if (plainFrom < len) tokens.push(['', src.slice(plainFrom)]);
  return tokens;
}

/* ---------- JSON ---------- */

function scanJson(src) {
  const tokens = [];
  const len = src.length;
  let plainFrom = 0;
  const add = (type, start, end) => {
    if (end <= start) return;
    if (start > plainFrom) tokens.push(['', src.slice(plainFrom, start)]);
    tokens.push([type, src.slice(start, end)]);
    plainFrom = end;
  };
  let i = 0;
  while (i < len) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = len;
      add('com', i, end); i = end; continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? len : close + 2;
      add('com', i, end); i = end; continue;
    }
    if (ch === '"') {
      let end = i + 1;
      while (end < len) {
        if (src[end] === '\\') { end += 2; continue; }
        if (src[end] === '"') { end++; break; }
        end++;
      }
      let after = end;
      while (after < len && /\s/.test(src[after])) after++;
      add(src[after] === ':' ? 'key' : 'str', i, end);
      i = end; continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (m) { add('num', i, i + m[0].length); i += m[0].length; continue; }
    }
    const lit = /^(?:true|false|null)\b/.exec(src.slice(i));
    if (lit) { add('lit', i, i + lit[0].length); i += lit[0].length; continue; }
    i++;
  }
  if (plainFrom < len) tokens.push(['', src.slice(plainFrom)]);
  return tokens;
}

/* ---------- CSS ---------- */

function scanCss(src) {
  const tokens = [];
  const len = src.length;
  let plainFrom = 0;
  const add = (type, start, end) => {
    if (end <= start) return;
    if (start > plainFrom) tokens.push(['', src.slice(plainFrom, start)]);
    tokens.push([type, src.slice(start, end)]);
    plainFrom = end;
  };
  let i = 0;
  while (i < len) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? len : close + 2;
      add('com', i, end); i = end; continue;
    }
    if (ch === '"' || ch === "'") {
      let end = i + 1;
      while (end < len && src[end] !== ch && src[end] !== '\n') { if (src[end] === '\\') end++; end++; }
      if (src[end] === ch) end++;
      add('str', i, end); i = end; continue;
    }
    if (ch === '@') {
      const m = /^@[\w-]+/.exec(src.slice(i));
      if (m) { add('kw', i, i + m[0].length); i += m[0].length; continue; }
    }
    if (ch === '#') {
      const m = /^#[0-9a-fA-F]{3,8}\b/.exec(src.slice(i));
      if (m) { add('lit', i, i + m[0].length); i += m[0].length; continue; }
    }
    if (/[A-Za-z_-]/.test(ch)) {
      let end = i + 1;
      while (end < len && /[\w-]/.test(src[end])) end++;
      let after = end;
      while (after < len && /\s/.test(src[after])) after++;
      let before = i - 1;
      while (before >= 0 && /\s/.test(src[before])) before--;
      const isProp = src[after] === ':' && (before < 0 || '{;'.includes(src[before]) || src[before] === '\n');
      add(isProp ? 'key' : 'attr', i, end);
      i = end; continue;
    }
    if (ch >= '0' && ch <= '9') {
      const m = /^\d+(?:\.\d+)?(?:%|[a-zA-Z]+)?/.exec(src.slice(i));
      if (m) { add('num', i, i + m[0].length); i += m[0].length; continue; }
    }
    i++;
  }
  if (plainFrom < len) tokens.push(['', src.slice(plainFrom)]);
  return tokens;
}

/* ---------- HTML / XML / Vue ---------- */

function scanHtml(src) {
  const tokens = [];
  const len = src.length;
  let plainFrom = 0;
  const add = (type, start, end) => {
    if (end <= start) return;
    if (start > plainFrom) tokens.push(['', src.slice(plainFrom, start)]);
    tokens.push([type, src.slice(start, end)]);
    plainFrom = end;
  };
  let i = 0;
  while (i < len) {
    if (src.startsWith('<!--', i)) {
      const close = src.indexOf('-->', i + 4);
      const end = close < 0 ? len : close + 3;
      add('com', i, end); i = end; continue;
    }
    if (src.startsWith('<!', i)) {
      const close = src.indexOf('>', i + 2);
      const end = close < 0 ? len : close + 1;
      add('meta', i, end); i = end; continue;
    }
    if (src[i] === '<') {
      const tag = /^<(\/?)([A-Za-z][\w:.-]*)/.exec(src.slice(i));
      if (tag) {
        add('tag', i, i + tag[0].length);
        let j = i + tag[0].length;
        while (j < len && src[j] !== '>') {
          const ch = src[j];
          if (ch === '"' || ch === "'") {
            let end = j + 1;
            while (end < len && src[end] !== ch) end++;
            if (end < len) end++;
            add('str', j, end); j = end; continue;
          }
          if (/\s/.test(ch) || ch === '=' || ch === '/') { j++; continue; }
          const attr = /^[^\s=/>"']+/.exec(src.slice(j));
          if (attr) { add('attr', j, j + attr[0].length); j += attr[0].length; continue; }
          j++;
        }
        if (src[j] === '>') { add('tag', j, j + 1); j++; }
        i = j; continue;
      }
    }
    i++;
  }
  if (plainFrom < len) tokens.push(['', src.slice(plainFrom)]);
  return tokens;
}

/* ---------- Markdown ---------- */

function inlineMarkdown(line, tokens) {
  const pattern = /(`[^`\n]+`)|(\[[^\]\n]*\]\([^)\n]*\))|(\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) tokens.push(['', line.slice(last, match.index)]);
    if (match[1]) tokens.push(['str', match[1]]);
    else if (match[2]) {
      const link = /^(\[[^\]\n]*\])(\([^)\n]*\))$/.exec(match[2]);
      if (link) { tokens.push(['', link[1]]); tokens.push(['meta', link[2]]); }
      else tokens.push(['', match[2]]);
    } else tokens.push(['kw', match[3]]);
    last = pattern.lastIndex;
  }
  if (last < line.length) tokens.push(['', line.slice(last)]);
}

function scanMarkdown(src) {
  return lineTokens(src, (line, tokens) => {
    if (/^\s*(```|~~~)/.test(line)) { tokens.push(['meta', line]); return; }
    if (/^\s*#{1,6}\s/.test(line)) { tokens.push(['kw', line]); return; }
    if (/^\s*>/.test(line)) {
      const m = /^(\s*>+\s?)(.*)$/.exec(line);
      tokens.push(['meta', m[1]]);
      inlineMarkdown(m[2], tokens);
      return;
    }
    const list = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/.exec(line);
    if (list) {
      tokens.push(['num', list[1]]);
      inlineMarkdown(list[2], tokens);
      return;
    }
    inlineMarkdown(line, tokens);
  });
}

/* ---------- YAML / TOML / INI ---------- */

function scanYaml(src) {
  return lineTokens(src, (line, tokens) => {
    let body = line;
    let comment = '';
    const hash = line.indexOf('#');
    if (hash >= 0) {
      body = line.slice(0, hash);
      comment = line.slice(hash);
    }
    const section = /^(\s*)(\[[^\]]+\])(.*)$/.exec(body);
    if (section) {
      tokens.push(['', section[1]]);
      tokens.push(['tag', section[2]]);
      tokens.push(['', section[3]]);
    } else {
      const key = /^(\s*)([\w."'-]+)(\s*[:=]|\s+)/.exec(body);
      let rest = body;
      if (key) {
        tokens.push(['', key[1]]);
        tokens.push(['key', key[2]]);
        tokens.push(['', key[3]]);
        rest = body.slice(key[0].length);
      }
      let last = 0;
      const value = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(-?\d+(?:\.\d+)?\b)|\b(true|false|null|yes|no|on|off)\b/gi;
      let match;
      while ((match = value.exec(rest)) !== null) {
        if (match.index > last) tokens.push(['', rest.slice(last, match.index)]);
        tokens.push([match[1] ? 'str' : match[2] ? 'num' : 'lit', match[0]]);
        last = value.lastIndex;
      }
      if (last < rest.length) tokens.push(['', rest.slice(last)]);
    }
    if (comment) tokens.push(['com', comment]);
  });
}

/* ---------- 入口 ---------- */

export function highlightSource(text, filePath) {
  const source = String(text ?? '');
  const lang = languageForPath(filePath);
  if (!lang || source.length > MAX_HIGHLIGHT_CHARS) {
    return { html: esc(source), lang: lang || null, highlighted: false };
  }
  let tokens;
  if (lang === 'json') tokens = scanJson(source);
  else if (lang === 'css') tokens = scanCss(source);
  else if (lang === 'html') tokens = scanHtml(source);
  else if (lang === 'md') tokens = scanMarkdown(source);
  else if (FAMILY[lang] === 'yaml') tokens = scanYaml(source);
  else tokens = scanCode(source, lang);
  return { html: toHtml(tokens), lang, highlighted: true };
}
