/* SKILL.md 的文本处理：解码、拆分 frontmatter、生成与局部改写。
 *
 * 全部是纯函数 —— 不碰文件系统、不发请求。写盘在 skills-files.js，
 * 「能不能写」在 skills-manage.js 里判定。
 *
 * 切分规则逐字对齐 pi（dist/utils/frontmatter.js）：
 *   去 BOM → 换行统一成 \n → 必须以 `---` 开头 → 结束于第一个 `\n---` →
 *   yaml = slice(4, end)，正文 = slice(end + 4)。
 *
 * 这里不引入 YAML 库，所以只敢动自己看得懂的写法：
 *   - 生成时只写 name / description 两个单行标量；
 *   - 改写已有文件时只替换那一个顶层键所占的行，其余 frontmatter
 *     （license、allowed-tools、注释、未知键）一个字节都不动；
 *   - 只要 frontmatter 里出现读不懂的写法（流式映射、锚点、跨行的引号标量…），
 *     表单视图就不可用，由调用方退到「源文件」模式 —— 宁可让用户看原文，也不猜着改。 */
import { Buffer } from 'node:buffer';

const BOM = String.fromCharCode(0xfeff);
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** 与 skills.js 的列表解析用同一个顶层键形状，两边看到的键才一致。 */
const KEY_LINE = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;
const BLOCK_HEADER = /^([|>])([+-]?)$/;
const YAML_KEYWORDS = /^(?:true|false|yes|no|on|off|null|~|y|n)$/i;
/** 不加引号也不会被 YAML 误读的文本：字母或汉字开头，只含常见文字与标点。 */
const PLAIN_SAFE = /^[A-Za-z\p{Script=Han}][A-Za-z0-9\p{Script=Han} ,.()（）、，。；！？'"\/_+&%-]*$/u;
/** YAML 会读成数字的写法（pi 要求 description 是字符串，读成数字就不加载）。 */
const NUMERIC_LIKE = /^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:e[-+]?\d+)?|\.\d+|0x[0-9a-f]+|0o[0-7]+|\.inf|\.nan)$/i;

/** 按 UTF-8 严格解码。坏字节、空字符都拒绝 —— 带着替换符存回去会毁掉原文件。 */
export function decodeSkillBytes(bytes) {
  let text;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    return { ok: false, code: 'not-utf8', error: '文件不是 UTF-8 编码' };
  }
  if (text.includes('\x00')) return { ok: false, code: 'binary', error: '文件里有空字符，不是文本文件' };
  const bom = text.startsWith(BOM);
  if (bom) text = text.slice(1);
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return { ok: true, text: text.replace(/\r\n?/g, '\n'), bom, eol: crlf > 0 && crlf >= lf ? 'crlf' : 'lf' };
}

/** 写回时恢复原文件的 BOM 与换行风格（编辑器里永远是 \n）。 */
export function encodeSkillText(text, { bom = false, eol = 'lf' } = {}) {
  let out = String(text).replace(/\r\n?/g, '\n');
  if (eol === 'crlf') out = out.replace(/\n/g, '\r\n');
  return Buffer.from((bom ? BOM : '') + out, 'utf8');
}

/**
 * 输入已去 BOM、换行为 \n。
 * `---\n---` 这种空 frontmatter 里，开头那行的换行同时是结束标记的一部分，
 * 所以单独标成 emptyBlock，拼回去时才不会多出一行。
 */
export function splitSkillDocument(text) {
  const none = { hasFrontmatter: false, emptyBlock: false, open: '', yaml: '', after: text };
  if (typeof text !== 'string' || !text.startsWith('---')) return none;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return none;
  if (end === 3) return { hasFrontmatter: true, emptyBlock: true, open: '---\n', yaml: '', after: text.slice(7) };
  return { hasFrontmatter: true, emptyBlock: false, open: text.slice(0, 4), yaml: text.slice(4, end), after: text.slice(end + 4) };
}

function joinSkillDocument(doc, yaml) {
  if (yaml === '') return `---\n---${doc.after}`;
  return `${doc.emptyBlock ? '---\n' : doc.open}${yaml}\n---${doc.after}`;
}

/** 顶层键各占哪几行：键所在行 + 紧随其后的缩进行（块标量、折行的值）。 */
export function topLevelSegments(yaml) {
  const lines = yaml === '' ? [] : yaml.split('\n');
  const segments = [];
  const stray = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const hit = /^\s/.test(line) ? null : KEY_LINE.exec(line);
    if (!hit) {
      // 既不是空行/注释、又不是顶层键的行首内容 —— 说明用了这里读不懂的写法
      if (line.trim() && !line.trimStart().startsWith('#')) stray.push(i);
      i += 1;
      continue;
    }
    let end = i + 1;
    for (let probe = end; probe < lines.length; probe += 1) {
      if (lines[probe].trim() === '') continue; // 空行只有后面还跟着缩进行时才算进来
      if (!/^[ \t]/.test(lines[probe])) break;
      end = probe + 1;
    }
    segments.push({ key: hit[1], start: i, end, value: hit[2].trim() });
    i = end;
  }
  return { lines, segments, stray };
}

/** 读一个顶层标量。只认单行的普通 / 单引号 / 双引号写法和 `|` `>` 块标量。 */
function readSegmentScalar(lines, segment) {
  const first = segment.value;
  const rest = lines.slice(segment.start + 1, segment.end);
  const block = BLOCK_HEADER.exec(first);
  if (block) {
    const parts = rest.map((line) => line.replace(/^\s+/, ''));
    return { ok: true, value: parts.join(block[1] === '>' ? ' ' : '\n').trim(), style: 'block' };
  }
  if (rest.some((line) => line.trim() !== '')) return { ok: false, reason: '值跨了多行' };
  if (first === '') return { ok: true, value: '', style: 'empty' };
  if (first.startsWith('"')) {
    try {
      const parsed = JSON.parse(first);
      if (typeof parsed === 'string') return { ok: true, value: parsed, style: 'double' };
    } catch {
      /* 不是 JSON 兼容的双引号写法 */
    }
    return { ok: false, reason: '双引号里用了特殊转义' };
  }
  if (first.startsWith("'")) {
    if (first.length < 2 || !first.endsWith("'")) return { ok: false, reason: '单引号没有闭合' };
    const inner = first.slice(1, -1);
    if (/'/.test(inner.replace(/''/g, ''))) return { ok: false, reason: '单引号里有未转义的引号' };
    return { ok: true, value: inner.replace(/''/g, "'"), style: 'single' };
  }
  if (/^[[\]{}&*!|>%@`#,?-]/.test(first)) return { ok: false, reason: '用了 YAML 的特殊写法' };
  if (/:(\s|$)/.test(first)) return { ok: false, reason: '值里有未加引号的冒号' };
  const comment = first.search(/\s#/);
  return { ok: true, value: comment === -1 ? first : first.slice(0, comment).trim(), style: 'plain' };
}

/** 读 frontmatter 里的一个顶层标量；没有这个键时 found 为 false。 */
export function readFrontmatterScalar(text, key) {
  const doc = splitSkillDocument(text);
  if (!doc.hasFrontmatter) return { found: false, ok: true, value: '' };
  const { lines, segments } = topLevelSegments(doc.yaml);
  const hits = segments.filter((segment) => segment.key === key);
  if (hits.length === 0) return { found: false, ok: true, value: '' };
  if (hits.length > 1) return { found: true, ok: false, value: '', reason: `frontmatter 里有重复的 ${key}` };
  return { found: true, ...readSegmentScalar(lines, hits[0]) };
}

/** 单行标量。能不加引号就不加；其余一律 JSON 风格双引号（它本身就是合法的 YAML）。 */
export function yamlScalar(value) {
  const text = String(value ?? '');
  if (text === '') return '""';
  const plain = PLAIN_SAFE.test(text) && !/\s$/.test(text) && !YAML_KEYWORDS.test(text);
  return plain ? text : JSON.stringify(text);
}

/** YAML 会把这个不加引号的值读成布尔 / 空 / 数字，而不是字符串。 */
export function yamlReadsAsNonString(scalar) {
  return Boolean(scalar && scalar.style === 'plain' && (YAML_KEYWORDS.test(scalar.value) || NUMERIC_LIKE.test(scalar.value)));
}

/** 描述只占一行：换行、控制字符与连续空白都收成一个空格。 */
export function normalizeDescription(value) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f\x85\s]+/g, ' ').trim();
}

export function normalizeBody(value) {
  const body = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return body ? `${body}\n` : '';
}

/** 把任意名字收成 Agent Skills 允许的目录名（小写字母、数字、单个连字符，最长 64）。 */
export function sanitizeSkillSlug(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/** name 传空时不写这个键 —— pi 会回退到目录名，比写一个不合规的名字更干净。 */
export function composeNewDocument({ name = '', description, body }) {
  const head = name ? `name: ${yamlScalar(name)}\n` : '';
  const text = normalizeBody(body);
  return `---\n${head}description: ${yamlScalar(normalizeDescription(description))}\n---\n${text ? `\n${text}` : ''}`;
}

function otherSegmentsText(lines, segments, key) {
  return segments
    .filter((segment) => segment.key !== key)
    .map((segment) => lines.slice(segment.start, segment.end).join('\n'))
    .join('\n\x00\n');
}

/**
 * 替换（或插入）一个顶层标量键，然后回读核对：目标键读回来等于新值，
 * 其余键所占的行一个都没变。核对不过就拒绝，调用方应改用源文件模式。
 */
export function rewriteFrontmatterKey(text, key, value, { insertAfter = '' } = {}) {
  const doc = splitSkillDocument(text);
  if (!doc.hasFrontmatter) return { ok: false, reason: '文件没有 frontmatter' };
  const before = topLevelSegments(doc.yaml);
  if (before.stray.length) return { ok: false, reason: 'frontmatter 里有表单读不懂的写法' };
  const hits = before.segments.filter((segment) => segment.key === key);
  if (hits.length > 1) return { ok: false, reason: `frontmatter 里有重复的 ${key}` };
  const lines = before.lines.slice();
  const line = `${key}: ${yamlScalar(value)}`;
  if (hits.length === 1) {
    lines.splice(hits[0].start, hits[0].end - hits[0].start, line);
  } else {
    const anchor = insertAfter ? before.segments.find((segment) => segment.key === insertAfter) : null;
    lines.splice(anchor ? anchor.end : 0, 0, line);
  }
  const next = joinSkillDocument(doc, lines.join('\n'));
  const after = topLevelSegments(splitSkillDocument(next).yaml);
  const readBack = readFrontmatterScalar(next, key);
  const intact = otherSegmentsText(before.lines, before.segments, key) === otherSegmentsText(after.lines, after.segments, key);
  if (!readBack.found || !readBack.ok || readBack.value !== String(value) || !intact || after.stray.length) {
    return { ok: false, reason: 'frontmatter 的写法比较特殊，无法只改这一项' };
  }
  return { ok: true, text: next };
}

/**
 * 表单视图：把文件拆成「名称 + 描述 + 正文」。
 * available 为 false 时编辑器只能用源文件模式，reason 说明原因。
 */
export function skillFormView(text) {
  const doc = splitSkillDocument(text);
  if (!doc.hasFrontmatter) {
    // 没有 frontmatter：整份当正文，保存时补一个标准的 frontmatter（这正是修好它的办法）
    return { available: true, generated: true, name: '', description: '', body: text.replace(/^\n+/, ''), extraKeys: [] };
  }
  const unavailable = (reason) => ({ available: false, reason, generated: false, name: '', description: '', body: '', extraKeys: [] });
  const tail = /^[ \t]*(?:\n|$)/.exec(doc.after);
  if (doc.open !== '---\n' || !tail) return unavailable('frontmatter 的分隔线写法特殊');
  const { lines, segments, stray } = topLevelSegments(doc.yaml);
  if (stray.length) return unavailable('frontmatter 里有表单读不懂的写法');
  const values = {};
  for (const key of ['name', 'description']) {
    const hits = segments.filter((segment) => segment.key === key);
    if (hits.length > 1) return unavailable(`frontmatter 里有重复的 ${key}`);
    const scalar = hits.length ? readSegmentScalar(lines, hits[0]) : { ok: true, value: '' };
    if (!scalar.ok) return unavailable(`${key} 的写法特殊（${scalar.reason}）`);
    values[key] = scalar.value;
  }
  return {
    available: true,
    generated: false,
    name: values.name.trim(),
    description: normalizeDescription(values.description),
    body: doc.after.slice(tail[0].length).replace(/^\n+/, ''),
    extraKeys: segments.map((segment) => segment.key).filter((key) => key !== 'name' && key !== 'description'),
  };
}

/**
 * 表单保存：只动 description 与正文。没改的部分原样保留（连同原来的空行与引号风格），
 * 改了正文才按「frontmatter 后空一行、结尾一个换行」重排。
 */
export function composeEditedDocument(baseText, { description, body, fallbackName = '' }) {
  const view = skillFormView(baseText);
  if (!view.available) return { ok: false, reason: view.reason };
  const nextDescription = normalizeDescription(description);
  const nextBody = normalizeBody(body);
  if (view.generated) {
    return { ok: true, text: composeNewDocument({ name: fallbackName, description: nextDescription, body: nextBody }) };
  }
  let text = baseText;
  if (nextDescription !== view.description) {
    const rewritten = rewriteFrontmatterKey(text, 'description', nextDescription, { insertAfter: 'name' });
    if (!rewritten.ok) return rewritten;
    text = rewritten.text;
  }
  if (nextBody !== normalizeBody(view.body)) {
    const doc = splitSkillDocument(text);
    text = `${joinSkillDocument({ ...doc, after: '' }, doc.yaml)}\n${nextBody ? `\n${nextBody}` : ''}`;
  }
  return { ok: true, text };
}

/**
 * 给校验用的摘要：frontmatter 在不在、name / description 读不读得出来。
 * readable 为 false 表示「有这个键，但写法超出了这里能读的范围」—— 不等于它是坏的。
 */
export function summarizeSkillText(text) {
  const doc = splitSkillDocument(text);
  const name = readFrontmatterScalar(text, 'name');
  const description = readFrontmatterScalar(text, 'description');
  return {
    hasFrontmatter: doc.hasFrontmatter,
    name: { found: name.found, readable: name.ok, value: name.ok ? String(name.value).trim() : '' },
    description: {
      found: description.found,
      readable: description.ok,
      value: description.ok ? normalizeDescription(description.value) : '',
      nonString: description.found && description.ok && yamlReadsAsNonString(description),
    },
  };
}
