/* Bounded range evidence shared by schema, model and selection. No I/O/DOM. */
export const MAX_REVIEW_RANGE_LINES = 20;
export const rangeRows = anchor => anchor?.range?.lines || [anchor];
export const rangePosition = row => [row.type, row.oldLine, row.newLine];
const samePosition = (a, b) => a.type === b.type && a.oldLine === b.oldLine && a.newLine === b.newLine;
const sameEvidence = (a, b) => samePosition(a, b) && a.codeHash === b.codeHash;

export function continuousReviewRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > MAX_REVIEW_RANGE_LINES) return false;
  let old = null, next = null;
  for (const row of rows) {
    if (!row || !['add', 'del', 'context'].includes(row.type)) return false;
    const valid = n => Number.isSafeInteger(n) && n > 0 && n <= 100000000;
    if (row.type === 'add' ? row.oldLine !== null || !valid(row.newLine)
      : row.type === 'del' ? row.newLine !== null || !valid(row.oldLine)
        : !valid(row.oldLine) || !valid(row.newLine)) return false;
    if (typeof row.codeHash !== 'string' || !/^[a-f0-9]{8}$/.test(row.codeHash)) return false;
    if (row.oldLine !== null) { if (old !== null && row.oldLine !== old + 1) return false; old = row.oldLine; }
    if (row.newLine !== null) { if (next !== null && row.newLine !== next + 1) return false; next = row.newLine; }
  }
  return true;
}

export function selectReviewRange(rows, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0) return null;
  const selected = rows.slice(Math.min(start, end), Math.max(start, end) + 1);
  if (Math.max(start,end) >= rows.length || !continuousReviewRows(selected)) return null;
  const first = selected[0];
  if (selected.some(r => r.rangeComplete !== true || r.path !== first.path || r.section !== first.section
    || r.hunkIndex !== first.hunkIndex || r.hunkHeader !== first.hunkHeader || r.diffFingerprint !== first.diffFingerprint)) return null;
  const { rangeComplete, snippet, ...anchor } = first;
  return { ...anchor, range: { version: 1, lines: selected.map(r => ({ type:r.type, oldLine:r.oldLine, newLine:r.newLine, codeHash:r.codeHash })) } };
}

export function reviewRangesOverlap(a, b) {
  if (!a?.range || !b?.range || a.path !== b.path || a.section !== b.section) return false;
  return a.range.lines.some(x => b.range.lines.some(y =>
    x.oldLine !== null && x.oldLine === y.oldLine || x.newLine !== null && x.newLine === y.newLine));
}

const sideLabel = (rows, key, name) => {
  const nums = rows.map(r => r[key]).filter(n => n !== null);
  if (!nums.length) return '';
  // Never fabricate a continuous range if called with unvalidated evidence.
  const runs = [];
  for (const n of nums) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n; else runs.push([n,n]);
  }
  return `${name}第 ${runs.map(([a,b]) => a === b ? a : `${a}～${b}`).join('、')} 行`;
};
export function reviewRangeLabel(anchor) {
  const rows = anchor.range.lines;
  const mixed = rows.some(r => r.type === 'add') && rows.some(r => r.type === 'del');
  return [sideLabel(rows,'oldLine','旧文件'),sideLabel(rows,'newLine','新文件')].filter(Boolean).join('；')
    + (mixed ? `（含增删，${rows.length} 个 Diff 行）` : '');
}

/** Match original coordinates + every hash, never search a different location.
 * Context changes may alter hunk headers/indices; the current rows must still
 * form one complete, contiguous hunk. */
export function reconcileReviewRange(anchor, lines, fingerprint) {
  const expected = anchor.range.lines;
  const positions = expected.map(a => lines.filter(b => samePosition(a,b)));
  if (positions.some((found,i) => found.length > 1 || found.length === 1 && !sameEvidence(expected[i],found[0]))) return 'stale';
  if (positions.every(found => found.length === 1)) {
    const found = positions.map(p => p[0]);
    const index = lines.indexOf(found[0]);
    return found.every((r,i) => lines[index+i] === r && r.hunkIndex === found[0].hunkIndex
      && r.hunkHeader === found[0].hunkHeader && r.rangeComplete !== false) ? 'valid' : 'stale';
  }
  if (anchor.diffFingerprint === fingerprint && positions.every((p,i) => p.length || expected[i].type === 'context')) return 'pending';
  return 'stale';
}
