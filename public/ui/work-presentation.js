/* Presentation vocabulary shared by Classic and Runtime work rows.
 *
 * The conversation timeline is intentionally flat: a single muted line with a
 * tool-kind glyph, the action label and a trailing disclosure chevron. This
 * module only classifies already-authorized display data (tool name, activity
 * kind, title) and derives a short summary/preview. It never reads a session,
 * requests details, or decides success from the presence of a tool call.
 * The organization follows T3 Code's WorkLog presentation; implementation is
 * native DOM for Pi and contains no React or backend code. */

const READ_TOOLS = new Set(['read', 'read_file', 'readfile', 'cat', 'ls', 'list', 'view', 'open']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'find', 'search', 'search_files', 'searchfiles', 'rg']);
const COMMAND_TOOLS = new Set(['bash', 'powershell', 'shell', 'sh', 'cmd', 'exec', 'command', 'run', 'terminal', 'process']);
const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'applypatch', 'patch', 'create_file', 'createfile']);
const WEB_TOOLS = new Set(['web', 'web_search', 'websearch', 'fetch', 'browser', 'http', 'curl']);

const ACTION_ORDER = ['command', 'read', 'search', 'edit', 'write', 'web', 'compaction', 'subagent', 'other'];

const ACTION = {
  command: { icon: 'terminal', label: count => `运行 ${count} 条命令` },
  read: { icon: 'eye', label: count => `读取 ${count} 次`, identity: 'file', distinct: count => `读取 ${count} 个文件` },
  search: { icon: 'search', label: count => `搜索 ${count} 次` },
  edit: { icon: 'edit', label: count => `编辑 ${count} 次`, identity: 'file', distinct: count => `编辑 ${count} 个文件` },
  write: { icon: 'edit', label: count => `写入 ${count} 次`, identity: 'file', distinct: count => `写入 ${count} 个文件` },
  web: { icon: 'globe', label: count => `浏览 ${count} 次`, identity: 'web', distinct: count => `浏览 ${count} 个页面` },
  compaction: { icon: 'layers', label: count => `压缩上下文 ${count} 次` },
  subagent: { icon: 'conversation', label: count => `运行 ${count} 个子代理` },
  other: { icon: 'tool', label: count => `执行 ${count} 项工具` },
};

function nameOf(value) {
  if (typeof value === 'string') return value.toLowerCase();
  if (!value || typeof value !== 'object') return '';
  const raw = value.toolName ?? value.name ?? value.action ?? '';
  return typeof raw === 'string' ? raw.toLowerCase() : '';
}

function kindOf(value) {
  if (!value || typeof value !== 'object') return '';
  const kind = value.kind ?? value.activityKind ?? '';
  return typeof kind === 'string' ? kind.toLowerCase() : '';
}

/** Map a Pi tool name / execution activity to the small action vocabulary. */
export function workActionKind(value) {
  if (value === 'thinking' || value?.reasoning === true) return 'thinking';
  const kind = kindOf(value);
  const name = nameOf(value);
  const title = typeof value?.title === 'string' ? value.title : '';
  if (kind === 'thinking' || kind === 'reasoning') return 'thinking';
  if (kind === 'compaction' || kind === 'context-compaction') return 'compaction';
  if (kind === 'subagent') return 'subagent';
  if (kind === 'read') return 'read';
  if (kind === 'search') return 'search';
  if (kind === 'command') return 'command';
  if (kind === 'edit') return 'edit';
  if (kind === 'write') return 'write';
  if (kind === 'web' || kind === 'browser') return 'web';
  if (READ_TOOLS.has(name)) return 'read';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (COMMAND_TOOLS.has(name)) return 'command';
  if (EDIT_TOOLS.has(name)) return name === 'write' || name === 'create_file' ? 'write' : 'edit';
  if (WEB_TOOLS.has(name) || name.startsWith('web_')) return 'web';
  if (name === 'subagent' || name === 'task') return 'subagent';
  /* A safe display title can still classify older/unknown tool names. */
  if (title.includes('读取') || title.includes('查看')) return 'read';
  if (title.includes('搜索')) return 'search';
  if (title.includes('写入')) return 'write';
  if (title.includes('编辑')) return 'edit';
  if (title.includes('命令') || title.includes('运行')) return 'command';
  if (title.includes('浏览') || title.includes('网页')) return 'web';
  if (title.includes('压缩')) return 'compaction';
  if (title.includes('子代理')) return 'subagent';
  return kind === 'tool' || name ? 'other' : '';
}

/** Glyph name for a tool/activity row. Status is expressed by color/animation,
 * not by replacing this glyph, so the same row keeps its meaning across states. */
export function workIconName(value) {
  const kind = workActionKind(value);
  if (kind === 'thinking') return 'brain';
  return ACTION[kind]?.icon ?? 'tool';
}

/** One-line reasoning preview, derived only from the already-visible text. */
export function thinkingPreview(text, maximum = 180) {
  const flat = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!flat) return '思考过程';
  const first = flat.split('\n').map(line => line.trim()).find(Boolean) ?? flat;
  const plain = first
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/[*_~]+/g, '')
    .trim() || '思考过程';
  return plain.length > maximum ? plain.slice(0, maximum - 1).trimEnd() + '…' : plain;
}

/** Compact group summary, e.g. "读取 2 次 · 搜索 1 次 · 运行 2 条命令".
 * A distinct file/page count is used only when every call of that kind carries
 * an explicit, reliable target identity. Otherwise the label counts calls, so
 * repeated reads of one file are never reported as multiple files. */
export function workSummary(descriptors = []) {
  const counts = new Map();
  const targets = new Map();
  const incompleteIdentity = new Set();
  let reasoning = 0;
  let total = 0;
  for (const descriptor of descriptors) {
    if (!descriptor) continue;
    total += 1;
    const kind = workActionKind(descriptor);
    if (!kind) continue;
    if (kind === 'thinking') { reasoning += 1; continue; }
    counts.set(kind, (counts.get(kind) || 0) + 1);
    if (!ACTION[kind]?.identity) continue;
    const target = typeof descriptor.targetId === 'string' ? descriptor.targetId : '';
    if (!target) { incompleteIdentity.add(kind); continue; }
    if (!targets.has(kind)) targets.set(kind, new Set());
    targets.get(kind).add(target);
  }
  const parts = ACTION_ORDER
    .filter(kind => counts.has(kind))
    .map(kind => {
      const action = ACTION[kind];
      const distinct = targets.get(kind);
      return distinct && !incompleteIdentity.has(kind)
        ? action.distinct(distinct.size) : action.label(counts.get(kind));
    });
  if (parts.length) return parts.join(' · ');
  if (reasoning) return `思考 ${reasoning} 次`;
  return total ? `${total} 项工作记录` : '';
}

/** Group header glyph: first recognized action, otherwise the activity pulse. */
export function workSummaryIcon(descriptors = []) {
  for (const descriptor of descriptors) {
    const kind = workActionKind(descriptor);
    if (kind && kind !== 'thinking') return ACTION[kind]?.icon ?? 'activity';
  }
  return descriptors.some(descriptor => workActionKind(descriptor) === 'thinking') ? 'brain' : 'activity';
}
