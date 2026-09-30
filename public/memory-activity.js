/* pi-memory 0.4.2 的语义投影。
 *
 * 契约核对方式：**v0.4.2 tag** 与 npm 发布包指向同一个 commit
 * （`39e6b998a2279c8fad4a2c6c64e26828c1d6023e`），tag 上的 `index.ts` 与发布
 * tarball 逐字节相同。下面每条规则都来自那份源码，不来自 README，也不来自
 * 仓库 main（main 已领先，含未发布字段）。
 *
 * 只做一件事：把一条 memory 工具的 ToolEntry 投影成**白名单事实**。
 * 不读 memory 目录、不碰 qmd、不建索引、不做第二份数据库，
 * 也没有任何「记住 / 忘记 / 搜索 / 恢复」的动作。
 *
 * ---------- 五条来自真实源码的约束 ----------
 *
 * 1. **请求参数不是成功证据。** args 只说「在做什么」（running 文案、请求的
 *    target / action / date），details 才说「发生了什么」。0.4.2 的 soft-failure
 *    一律返回 `details: {}`：
 *      memory_read    MEMORY.md / SCRATCHPAD.md 不存在、daily 没有那天、list 没有日志
 *      memory_write   （成功分支总带 target；缺字段只可能是异常结果）
 *      scratchpad     空 scratchpad、没有匹配项、缺 text、未知 action
 *    这些情况下「没有结构化证据」就只能说结果不可用 —— 既不拿 args 顶成成功，
 *    也不改判成失败。
 *
 * 2. **pi 0.87.0 不传播 Extension 自己返回的 isError。**
 *    agent-core 的 execute 包一层：正常 return 就是 `isError: false`
 *    （见 pi-agent-core/dist/agent-loop.js 的 `return { result, isError: false }`），
 *    Extension 在 result 里写的 `isError: true` 不会到达 tool_execution_end。
 *    所以 status 只认 entry.status；「没有成功证据」不等于「失败」。
 *
 * 3. **返回值里没有结构化命中列表。** memory_search 的 details 只有
 *    `{ mode, query, count, needsEmbed }`；命中正文（含 `**File:** <绝对路径>`）
 *    全在 result 文本里。所以这里**不投影任何正文或预览** —— 语义适配后
 *    entry.output 会被替换成这些事实，原始文本没有进 DOM 的机会。
 *    同样**不解析 raw result 文本**去区分「No daily log」这类文案：那是正文/路径
 *    泄露面，而且文案不是稳定 API。
 *
 * 4. **绝对路径与记忆原文是 details 的一等字段。** memory_write / memory_read /
 *    memory_forget / memory_restore 的 details.path、memory_forget 的
 *    details.recoveryPath、memory_status 的 details.dir 都是绝对路径（含用户名）；
 *    existingPreview / removedPreview / preview 是记忆原文。一律不投影。
 *
 * 5. **没有 project scope。** resolveMemoryDir 只认 PI_MEMORY_DIR 与
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
const pick = (table, v) => (typeof v === 'string' && Object.hasOwn(table, v) ? v : '');

/* ---------- 真实枚举（都来自 v0.4.2 的 TypeBox schema / details） ---------- */

const WRITE_TARGETS = { long_term: 'Long-term memory', daily: 'Daily log' };
const READ_TARGETS = { long_term: 'Long-term memory', scratchpad: 'Scratchpad', daily: 'Daily log', list: 'Daily log list' };
const WRITE_MODES = new Set(['append', 'overwrite']);
const SEARCH_MODES = new Set(['keyword', 'semantic', 'deep']);
const EMBEDDING_STATES = new Set(['ready', 'missing', 'unknown', 'n/a']);
/* v0.4.2 的 getSnapshotMode()：`mode === "per-turn" ? "per-turn" : "stable"`，
 * 即 PI_MEMORY_SNAPSHOT 只认这两个值，其它（包括 "refresh"）一律回落到 stable。
 * "refresh" 是仓库 main 上尚未发布的第三种模式 —— 没有发布就不写进适配器。 */
const SNAPSHOT_MODES = new Set(['stable', 'per-turn']);
const UPDATE_MODES = new Set(['background', 'manual', 'off']);
/* memory_forget 的 recovery 文件名就是 v4 UUID；只有格式成立才说得出「可恢复」。 */
const RECOVERY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* 每个 action 的 running 文案；success 文案由 details 证据决定，不在这里。 */
const SCRATCHPAD_RUNNING = {
  add: 'Updating scratchpad…',
  done: 'Updating scratchpad…',
  undo: 'Updating scratchpad…',
  clear_done: 'Updating scratchpad…',
  list: 'Reading scratchpad…',
};
const SCRATCHPAD_SUCCESS = {
  add: 'Added to scratchpad',
  done: 'Checked off scratchpad item',
  undo: 'Reopened scratchpad item',
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
  /* 成功证据只有 details.target（成功分支必带）；args.target 只是请求。 */
  const reported = pick(WRITE_TARGETS, d.target);
  const requested = pick(WRITE_TARGETS, a.target);
  const mode = WRITE_MODES.has(d.mode) ? d.mode : '';
  const success = reported === 'daily' ? 'Added to daily log'
    : reported ? 'Saved to memory'
      : 'Memory write result unavailable';
  const facts = [];
  if (reported) facts.push('Target: ' + WRITE_TARGETS[reported]);
  else {
    facts.push('Target metadata unavailable');
    if (requested) facts.push('Requested target: ' + WRITE_TARGETS[requested]);
  }
  if (mode) facts.push('Mode: ' + mode);
  facts.push('Content not shown in Activity');
  return result(status, labelOf(status, {
    running: 'Saving memory…',
    success,
    error: 'Memory write failed',
    stopped: 'Memory write stopped',
  }), WRITE_TARGETS[reported] || WRITE_TARGETS[requested] || 'Memory write', facts);
}

function readActivity(status, a, d) {
  const requested = pick(READ_TARGETS, a.target);
  /* v0.4.2 的四个成功分支：long_term/scratchpad → { path }，daily → { path, date }，
   * list → { files }。soft-failure 是 {}（含 daily 的空日期分支）。 */
  const path = typeof d.path === 'string' && d.path ? d.path : '';
  const date = dateStr(d.date);
  const files = Array.isArray(d.files) ? d.files : null;
  const success = requested === 'long_term' && path ? 'Read long-term memory'
    : requested === 'scratchpad' && path ? 'Read scratchpad'
      : requested === 'daily' && path && date ? 'Read daily log'
        : requested === 'list' && files ? 'Listed daily logs'
          : 'Memory read result unavailable';
  const facts = [];
  if (requested) facts.push('Target: ' + READ_TARGETS[requested]);
  if (date) facts.push('Date: ' + date);
  /* args.date 只是请求日期，不能证明「读到了那天」—— 所以它单独成一条。 */
  else if (dateStr(a.date)) facts.push('Requested date: ' + dateStr(a.date));
  if (requested === 'list') facts.push(files ? 'Daily logs: ' + files.length : 'Daily log count unavailable');
  else if (success !== 'Memory read result unavailable') facts.push('Content not shown in Activity');
  if (!requested) facts.push('Target metadata unavailable');
  return result(status, labelOf(status, {
    running: 'Reading memory…',
    success,
    error: 'Memory read failed',
    stopped: 'Memory read stopped',
  }), requested ? READ_TARGETS[requested] : 'Memory read', facts);
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
  /* 成功证据是 details.removed（无匹配时是 0，也是真实结果）。 */
  const reported = pick(WRITE_TARGETS, d.target);
  const requested = pick(WRITE_TARGETS, a.target);
  const removed = int(d.removed);
  const success = removed == null ? 'Memory forget result unavailable'
    : removed === 0 ? 'No matching memory'
      : 'Removed from memory';
  const facts = [];
  if (match) facts.push('Match: ' + match);
  if (reported) facts.push('Target: ' + WRITE_TARGETS[reported]);
  else if (requested) facts.push('Requested target: ' + WRITE_TARGETS[requested]);
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
  /* 成功证据是 details.restored 或「已恢复过」的 restoredAt。 */
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
  /* snapshotMode 是三态：认识的取值直接展示；**给了值但不在白名单**（例如仓库 main 上
   * 尚未发布的 refresh）说明我们确实收到了一个不认识的模式 —— 说「unrecognized」，
   * **绝不回显原始值**，也不假装它是已知模式；字段缺失则完全不显示这一行。
   * 这样上游一旦发布新模式，界面会明说「有个我不认识的模式」，而不是静默少一格。 */
  if (SNAPSHOT_MODES.has(d.snapshotMode)) facts.push('Snapshot: ' + d.snapshotMode);
  else if (typeof d.snapshotMode === 'string' && d.snapshotMode) facts.push('Snapshot: unrecognized');
  if (UPDATE_MODES.has(d.qmdUpdateMode)) facts.push('Update mode: ' + d.qmdUpdateMode);
  /* details.dir 是绝对路径 —— 永远不投影。 */
  const hasEvidence = facts.length > 0;
  if (!hasEvidence) facts.push('Memory status metadata unavailable');
  return result(status, labelOf(status, {
    running: 'Checking memory status…',
    success: hasEvidence ? 'Checked memory status' : 'Memory status result unavailable',
    error: 'Memory status failed',
    stopped: 'Memory status stopped',
  }), 'Local memory files and optional qmd search', facts);
}

function scratchpadActivity(status, a, d) {
  const requested = pick(SCRATCHPAD_RUNNING, a.action);
  const reported = pick(SCRATCHPAD_RUNNING, d.action);
  const count = int(d.count);
  const open = int(d.open);
  const removed = int(d.removed);
  /* list 的 details 没有 action 字段，证据是 count / open。 */
  const listEvidence = count != null || open != null;
  /* success 只由 details 决定：add/done/undo 回写 action，clear_done 另带 removed，
   * list 带 count/open；soft-failure 一律 {}。 */
  let success;
  if (reported === 'add' || reported === 'done' || reported === 'undo') success = SCRATCHPAD_SUCCESS[reported];
  else if (reported === 'clear_done') success = removed != null ? 'Cleared done scratchpad items' : 'Scratchpad result unavailable';
  else if (listEvidence) success = 'Read scratchpad';
  else if (requested || reported) success = 'Scratchpad result unavailable';
  /* 未适配的 action 仍走专用投影：中性文案，不回退到 raw JSON。 */
  else success = 'Scratchpad action';
  const facts = ['Action: ' + (reported || requested || 'unknown')];
  if (count != null) facts.push('Items: ' + count);
  if (open != null) facts.push('Open: ' + open);
  if (removed != null) facts.push('Removed: ' + removed);
  const named = requested || reported;
  return result(status, labelOf(status, {
    running: requested === 'list' ? SCRATCHPAD_RUNNING.list : 'Updating scratchpad…',
    success,
    error: 'Scratchpad action failed',
    stopped: 'Scratchpad action stopped',
  }), named ? 'Action: ' + named : 'Scratchpad', facts);
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
