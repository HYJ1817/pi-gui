/* pi-memory 0.4.2（jayzeng/pi-memory，0.4.2 gitHead 39e6b998）的语义投影。
 *
 * 只做一件事：把一条 memory 工具的 ToolEntry 投影成**白名单事实**。
 * 不读 memory 目录、不碰 qmd、不建索引、不做第二份数据库，
 * 也没有任何「记住 / 忘记 / 搜索 / 恢复」的动作。
 *
 * ---------- 四条来自真实源码的约束 ----------
 *
 * 1. **返回值里没有结构化命中列表。** memory_search 的 details 只有
 *    `{ mode, query, count, needsEmbed }`；命中正文（含 `**File:** <绝对路径>`）
 *    全在 result 文本里。所以这里**不投影任何正文或预览** —— 语义适配后
 *    entry.output 会被替换成这些事实，原始文本没有进 DOM 的机会。
 *
 * 2. **绝对路径与记忆原文是 details 的一等字段。** memory_write / memory_read /
 *    memory_forget / memory_restore 的 details.path、memory_forget 的
 *    details.recoveryPath、memory_status 的 details.dir 都是绝对路径（含用户名）；
 *    existingPreview / removedPreview / preview 是记忆原文。一律不投影。
 *
 * 3. **pi 0.87.0 不传播 Extension 自己返回的 isError。**
 *    agent-core 的 execute 包一层：正常 return 就是 `isError: false`
 *    （见 pi-agent-core/dist/agent-loop.js 的 `return { result, isError: false }`），
 *    Extension 在 result 里写的 `isError: true` 不会到达 tool_execution_end。
 *    因此 status 只认 entry.status；结构化字段缺失时降级成
 *    「…结果不可用」，**不猜成失败、也不猜成 0 条**。
 *
 * 4. **没有 project scope。** resolveMemoryDir 只认 PI_MEMORY_DIR 与
 *    HOME/USERPROFILE/HOMEDRIVE+HOMEPATH，落点是 `~/.pi/agent/memory`；
 *    global 之外的 scope 在源码里不存在，所以这里也不会出现「项目记忆」。
 *
 * 未知 / 未适配的工具继续走 tool-view.js 的 generic fallback（返回 null）。 */

export const MEMORY_TOOLS = Object.freeze([
  'memory_write',
  'memory_read',
  'memory_search',
  'memory_forget',
  'memory_restore',
  'memory_status',
  'scratchpad',
]);

/* ---------- 取值 ---------- */

const object = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
/** 单行化 + 截断。query / match 来自模型，可能带换行或控制字符。 */
const oneLine = (v, max = 200) =>
  typeof v === 'string' ? v.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateStr = (v) => (typeof v === 'string' && DATE_RE.test(v) ? v : '');

/* ---------- 真实枚举（都来自 0.4.2 的 TypeBox schema / details） ---------- */

const WRITE_TARGETS = { long_term: 'Long-term memory', daily: 'Daily log' };
const READ_TARGETS = { long_term: 'Long-term memory', scratchpad: 'Scratchpad', daily: 'Daily log', list: 'Daily log list' };
const WRITE_MODES = new Set(['append', 'overwrite']);
const SEARCH_MODES = new Set(['keyword', 'semantic', 'deep']);
const EMBEDDING_STATES = new Set(['ready', 'missing', 'unknown', 'n/a']);
const SNAPSHOT_MODES = new Set(['stable', 'per-turn']);
const UPDATE_MODES = new Set(['background', 'manual', 'off']);
/* memory_forget 的 recovery 文件名就是 v4 UUID；只有格式成立才说得出「可恢复」。 */
const RECOVERY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SCRATCHPAD_LABELS = {
  add: ['Updating scratchpad…', 'Added to scratchpad'],
  done: ['Updating scratchpad…', 'Checked off scratchpad item'],
  undo: ['Updating scratchpad…', 'Reopened scratchpad item'],
  clear_done: ['Updating scratchpad…', 'Cleared done scratchpad items'],
  list: ['Reading scratchpad…', 'Read scratchpad'],
};

const SETTLED = new Set(['incomplete', 'interrupted', 'cancelled']);

/** 生命周期文案。settled 与 unknown 分开：前者是「跑过但没收尾」，后者是「不知道」。 */
function labelOf(status, labels) {
  if (status === 'running') return labels.running;
  if (status === 'error') return labels.error;
  if (status === 'success') return labels.success;
  if (SETTLED.has(status)) return labels.stopped;
  return 'Memory operation';
}

function result(status, label, summary, facts) {
  return {
    label,
    status,
    known: true,
    summary: summary.slice(0, 380),
    facts: facts.join('\n').slice(0, 8000),
    sources: [],
    diffStat: null,
    gitStat: null,
  };
}

/* ---------- 各工具 ---------- */

function writeActivity(status, a, d) {
  const target = WRITE_TARGETS[d.target] ? d.target : WRITE_TARGETS[a.target] ? a.target : '';
  /* mode 是结果事实，不拿请求参数顶上；只有 details 明确给了才展示。 */
  const mode = WRITE_MODES.has(d.mode) ? d.mode : '';
  /* 没有 target 就没有「写成功」的证据 —— 不拿一句 “Saved to memory” 顶上。 */
  const success = target === 'daily' ? 'Added to daily log' : target ? 'Saved to memory' : 'Memory write result unavailable';
  const facts = [];
  if (target) facts.push('Target: ' + WRITE_TARGETS[target]);
  if (mode) facts.push('Mode: ' + mode);
  if (!target) facts.push('Target metadata unavailable');
  facts.push('Content not shown in Activity');
  return result(status, labelOf(status, {
    running: 'Saving memory…',
    success,
    error: 'Memory write failed',
    stopped: 'Memory write stopped',
  }), target ? WRITE_TARGETS[target] : 'Memory write', facts);
}

function readActivity(status, a, d) {
  const target = READ_TARGETS[a.target] ? a.target : '';
  const success = target === 'long_term' ? 'Read long-term memory'
    : target === 'scratchpad' ? 'Read scratchpad'
      : target === 'daily' ? 'Read daily log'
        : target === 'list' ? 'Listed daily logs'
          : 'Memory read result unavailable';
  const facts = [];
  if (target) facts.push('Target: ' + READ_TARGETS[target]);
  const date = dateStr(d.date) || dateStr(a.date);
  if (date) facts.push('Date: ' + date);
  if (target === 'list') {
    /* 只给条数：details.files 是日志文件名数组，不需要进 DOM。 */
    facts.push(Array.isArray(d.files) ? 'Daily logs: ' + d.files.length : 'Daily log count unavailable');
  } else if (target) {
    facts.push('Content not shown in Activity');
  }
  if (!target) facts.push('Target metadata unavailable');
  return result(status, labelOf(status, {
    running: 'Reading memory…',
    success,
    error: 'Memory read failed',
    stopped: 'Memory read stopped',
  }), target ? READ_TARGETS[target] : 'Memory read', facts);
}

function searchActivity(status, a, d) {
  const query = oneLine(d.query, 200) || oneLine(a.query, 200);
  /* mode 只在 result 明确给出时以 result 为准；args.mode 是「请求的档位」，不是结果。 */
  const mode = SEARCH_MODES.has(d.mode) ? d.mode : '';
  const count = int(d.count);
  const facts = [];
  if (query) facts.push('Query: ' + query);
  if (mode) facts.push('Mode: ' + mode);
  if (count != null) facts.push('Matches: ' + count);
  else facts.push('Result metadata unavailable');
  if (bool(d.needsEmbed) === true) facts.push('Embeddings missing for some documents');
  if (d.embedStarted === true) facts.push('Embedding started in background');
  const limit = int(a.limit);
  if (limit != null) facts.push('Limit: ' + limit);
  return result(status, labelOf(status, {
    running: 'Searching memory…',
    success: count == null ? 'Memory search result unavailable' : 'Searched memory',
    error: 'Memory search failed',
    stopped: 'Memory search stopped',
  }), query || 'Query unavailable', facts);
}

function forgetActivity(status, a, d) {
  const match = oneLine(a.match, 200);
  const target = WRITE_TARGETS[d.target] ? d.target : WRITE_TARGETS[a.target] ? a.target : '';
  const removed = int(d.removed);
  const success = removed == null ? 'Memory forget result unavailable'
    : removed === 0 ? 'No matching memory'
      : 'Removed from memory';
  const facts = [];
  if (match) facts.push('Match: ' + match);
  if (target) facts.push('Target: ' + WRITE_TARGETS[target]);
  if (removed != null) facts.push('Removed: ' + removed);
  else facts.push('Removal count unavailable');
  /* 删除在 0.4.2 里是可恢复的：先写 recovery/<uuid>.json 再改源文件。
   * 只说「可恢复」，不显示 recovery ID，更不显示 recoveryPath。 */
  if (RECOVERY_ID_RE.test(String(d.recoveryId ?? ''))) facts.push('Recovery available');
  return result(status, labelOf(status, {
    running: 'Forgetting memory…',
    success,
    error: 'Memory forget failed',
    stopped: 'Memory forget stopped',
  }), match || 'Match unavailable', facts);
}

function restoreActivity(status, a, d) {
  const restored = int(d.restored);
  const alreadyRestored = typeof d.restoredAt === 'string';
  const success = restored == null ? (alreadyRestored ? 'Memory already restored' : 'Memory restore result unavailable')
    : restored === 0 ? 'Memory already present'
      : 'Restored memory entries';
  const facts = [];
  if (restored != null) facts.push('Entries: ' + restored);
  if (alreadyRestored) facts.push('Already restored');
  if (WRITE_TARGETS[d.target]) facts.push('Target: ' + WRITE_TARGETS[d.target]);
  if (!facts.length) facts.push('Restore metadata unavailable');
  return result(status, labelOf(status, {
    running: 'Restoring memory…',
    success,
    error: 'Memory restore failed',
    stopped: 'Memory restore stopped',
  }), WRITE_TARGETS[d.target] || 'Memory restore', facts);
}

function statusActivity(status, d) {
  const facts = [];
  const longTerm = int(d.longTermChars);
  if (longTerm != null) facts.push('Long-term memory: ' + longTerm + ' chars');
  const open = int(d.scratchpadOpen);
  const total = int(d.scratchpadTotal);
  if (open != null && total != null) facts.push(`Scratchpad: ${open} open / ${total} total`);
  const daily = int(d.dailyCount);
  if (daily != null) facts.push('Daily logs: ' + daily);
  const latest = dateStr(d.latestDaily);
  if (latest) facts.push('Latest daily log: ' + latest);
  const qmd = bool(d.qmd);
  if (qmd !== null) {
    facts.push('qmd: ' + (qmd ? 'available' : 'unavailable'));
    /* memory_search 依赖 qmd；不可用时只有这句话是源码支持的，不编造 fallback 档位。 */
    if (!qmd) facts.push('memory_search requires qmd');
  }
  const collection = bool(d.collection);
  if (collection !== null) facts.push('Collection pi-memory: ' + (collection ? 'present' : 'missing'));
  if (EMBEDDING_STATES.has(d.embeddings)) facts.push('Embeddings: ' + d.embeddings);
  if (SNAPSHOT_MODES.has(d.snapshotMode)) facts.push('Snapshot: ' + d.snapshotMode);
  if (UPDATE_MODES.has(d.qmdUpdateMode)) facts.push('Update mode: ' + d.qmdUpdateMode);
  /* details.dir 是绝对路径 —— 永远不投影。 */
  if (!facts.length) facts.push('Memory status metadata unavailable');
  return result(status, labelOf(status, {
    running: 'Checking memory status…',
    success: 'Checked memory status',
    error: 'Memory status failed',
    stopped: 'Memory status stopped',
  }), 'Local memory files and optional qmd search', facts);
}

function scratchpadActivity(status, a, d) {
  const action = typeof a.action === 'string' && Object.hasOwn(SCRATCHPAD_LABELS, a.action) ? a.action : '';
  const facts = ['Action: ' + (action || 'unknown')];
  const count = int(d.count);
  const open = int(d.open);
  if (count != null) facts.push('Items: ' + count);
  if (open != null) facts.push('Open: ' + open);
  const removed = int(d.removed);
  if (removed != null) facts.push('Removed: ' + removed);
  /* 未适配的 action 仍走专用投影：只给一个 bounded 的 action 名，不回退到 raw JSON。 */
  const labels = action ? SCRATCHPAD_LABELS[action] : null;
  const success = action === 'list' ? 'Read scratchpad'
    : action === 'clear_done' ? (removed == null ? 'Scratchpad result unavailable' : 'Cleared done scratchpad items')
      : labels ? labels[1]
        : 'Scratchpad action';
  return result(status, labelOf(status, {
    running: labels ? labels[0] : 'Updating scratchpad…',
    success,
    error: 'Scratchpad action failed',
    stopped: 'Scratchpad action stopped',
  }), action ? 'Action: ' + action : 'Scratchpad', facts);
}

/* ---------- 入口 ---------- */

/**
 * 把一条 ToolEntry 投影成 Activity。未适配的工具返回 null（继续 generic fallback）。
 * @param {object} entry ToolEntry（实时事件或历史重建，同一形状）
 */
export function memoryActivity(entry) {
  const name = entry?.name;
  if (!MEMORY_TOOLS.includes(name)) return null;
  const a = object(entry?.args);
  const d = object(entry?.details);
  const status = typeof entry?.status === 'string' && entry.status ? entry.status : 'unknown';
  if (name === 'memory_write') return writeActivity(status, a, d);
  if (name === 'memory_read') return readActivity(status, a, d);
  if (name === 'memory_search') return searchActivity(status, a, d);
  if (name === 'memory_forget') return forgetActivity(status, a, d);
  if (name === 'memory_restore') return restoreActivity(status, a, d);
  if (name === 'memory_status') return statusActivity(status, d);
  return scratchpadActivity(status, a, d);
}
