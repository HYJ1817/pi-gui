import { node, button, searchControl } from './common.js';

const ROW_HEIGHT = 28;
const ROW_HEADER = 48;
const MAX_COPY_CELLS = 10000;

function columnLabel(value) {
  let label = '';
  while (value > 0) { value--; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26); }
  return label;
}

export function mountGrid(ctx, model, { onEncoding } = {}) {
  const { host, toolbar, resources } = ctx;
  let disposed = false, sheetIndex = Math.min(Math.max(0, Math.trunc(Number(ctx.state.sheet)) || 0), model.sheets.length - 1);
  let selection = { row: 1, column: 1, endRow: 1, endColumn: 1 };
  let formulas = Boolean(ctx.state.formulas), query = '', hits = [], hitIndex = -1, frame = 0;
  let rows, merges, widths, offsets, activeSheet;
  const listeners = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };
  const wrapper = node('div', 'office-grid-view');
  const tabs = node('div', 'office-sheet-tabs');
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '工作表');
  const viewport = node('div', 'office-grid-viewport');
  viewport.tabIndex = 0; viewport.setAttribute('role', 'grid'); viewport.setAttribute('aria-label', '只读表格，方向键移动，Shift 扩展选择，Ctrl+C 复制');
  const canvas = node('div', 'office-grid-canvas');
  const header = node('div', 'office-grid-header'); header.setAttribute('role', 'row');
  const layer = node('div', 'office-grid-rows'); layer.setAttribute('role', 'rowgroup');
  canvas.append(header, layer); viewport.append(canvas);
  const status = node('div', 'office-grid-status'); status.setAttribute('role', 'status');
  wrapper.append(tabs, viewport, status); host.replaceChildren(wrapper);
  const actions = node('div', 'office-actions'); toolbar.append(actions);
  const search = searchControl(actions, value => find(value));
  search.setAttribute('aria-label', '搜索当前工作表');
  const matchCount = node('span', 'office-match-count'); matchCount.setAttribute('aria-live', 'polite');
  actions.append(matchCount);
  actions.append(button('上一处', () => moveHit(-1)), button('下一处', () => moveHit(1)));
  actions.append(button('复制选区', () => copySelection()));
  if (model.kind === 'xlsx') {
    const toggle = button('显示公式', () => { formulas = !formulas; toggle.setAttribute('aria-pressed', String(formulas)); find(query); render(); });
    toggle.setAttribute('aria-pressed', String(formulas)); actions.append(toggle);
  }
  if (onEncoding) {
    const label = node('label', 'office-encoding-label', '编码');
    const select = node('select', 'ds-select office-encoding');
    select.setAttribute('aria-label', '文本编码');
    for (const [value, text] of [['auto', '自动'], ['utf-8', 'UTF-8'], ['gb18030', 'GB18030'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE']]) {
      const option = node('option', '', text); option.value = value; select.append(option);
    }
    select.value = ctx.state.encoding || 'auto';
    listen(select, 'change', () => onEncoding(select.value)); label.append(select); actions.append(label);
  }

  const tabButtons = model.sheets.map((sheet, index) => {
    const tab = button(sheet.name || `Sheet ${index + 1}`, () => chooseSheet(index));
    tab.setAttribute('role', 'tab');
    listen(tab, 'keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % model.sheets.length
        : event.key === 'ArrowLeft' ? (index + model.sheets.length - 1) % model.sheets.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? model.sheets.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); chooseSheet(next); tabButtons[next].focus(); }
    });
    tabs.append(tab); return tab;
  });

  function textAt(row, column) {
    const cell = rows.get(row)?.get(column);
    return cell ? (formulas && cell.formula ? cell.formula : cell.text) : '';
  }

  function selectCell(row, column, extend = false) {
    row = Math.max(1, Math.min(activeSheet.rowCount || 1, row));
    column = Math.max(1, Math.min(activeSheet.columnCount, column));
    if (extend) selection = { ...selection, endRow: row, endColumn: column };
    else selection = { row, column, endRow: row, endColumn: column };
    render();
    status.textContent = `${columnLabel(row === selection.row ? column : selection.column)}${selection.row}${extend ? ` : ${columnLabel(column)}${row}` : ''} · ${activeSheet.rowCount} 行 × ${activeSheet.columnCount} 列`;
  }

  function selected(row, column, endRow = row, endColumn = column) {
    return endRow >= Math.min(selection.row, selection.endRow) && row <= Math.max(selection.row, selection.endRow)
      && endColumn >= Math.min(selection.column, selection.endColumn) && column <= Math.max(selection.column, selection.endColumn);
  }

  function makeCell(row, column, cell, merge) {
    const el = node('div', 'office-grid-cell', cell ? (formulas && cell.formula ? cell.formula : cell.text) : '');
    const endRow = merge?.endRow || row, endColumn = merge?.endColumn || column;
    el.setAttribute('role', 'gridcell'); el.setAttribute('aria-colindex', String(column));
    el.setAttribute('aria-selected', String(selected(row, column, endRow, endColumn)));
    if (merge) { el.setAttribute('aria-rowspan', String(endRow - row + 1)); el.setAttribute('aria-colspan', String(endColumn - column + 1)); }
    el.dataset.row = String(row); el.dataset.column = String(column);
    el.style.left = `${offsets[column - 1]}px`;
    el.style.width = `${offsets[endColumn] - offsets[column - 1]}px`;
    el.style.height = `${(endRow - row + 1) * ROW_HEIGHT}px`;
    if (cell) {
      if (['number', 'date', 'boolean'].includes(cell.type)) el.classList.add('is-numeric');
      const style = cell.style || {};
      if (style.bold) el.style.fontWeight = '700';
      if (style.italic) el.style.fontStyle = 'italic';
      if (style.underline || style.strike) el.style.textDecoration = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ');
      // These are closed values projected by the worker, not document CSS.
      if (/^#[\da-f]{6}$/i.test(style.color || '')) el.style.color = style.color;
      if (/^#[\da-f]{6}$/i.test(style.background || '')) el.style.backgroundColor = style.background;
      if (['left', 'center', 'right'].includes(style.align)) el.style.textAlign = style.align;
      el.title = cell.formula ? `${cell.text}\n${cell.formula}` : cell.text;
    }
    return el;
  }

  function render() {
    if (disposed) return;
    const first = Math.max(1, Math.floor(viewport.scrollTop / ROW_HEIGHT) - 5);
    const count = Math.min(90, Math.ceil((viewport.clientHeight || 500) / ROW_HEIGHT) + 12);
    const last = Math.min(activeSheet.rowCount, first + count);
    const fragment = document.createDocumentFragment();
    const visible = new Set();
    for (let index = first; index <= last; index++) visible.add(index);
    // Merged anchors above the virtual window are still rendered if they span
    // into it. Empty merged cells retain their geometry too.
    for (const merge of merges) if (merge.row < first && merge.endRow >= first) visible.add(merge.row);
    for (const index of [...visible].sort((a, b) => a - b)) {
      const row = node('div', 'office-grid-row'); row.setAttribute('role', 'row'); row.setAttribute('aria-rowindex', String(index));
      row.style.top = `${index * ROW_HEIGHT}px`;
      if (index >= first) {
        const label = node('div', 'office-grid-row-label', String(index)); label.setAttribute('role', 'rowheader'); row.append(label);
      }
      const rowMerges = merges.filter(range => index >= range.row && index <= range.endRow);
      for (let column = 1; column <= activeSheet.columnCount; column++) {
        const merge = rowMerges.find(range => column >= range.column && column <= range.endColumn);
        if (merge && (merge.row !== index || merge.column !== column)) continue;
        if (index < first && (!merge || merge.endRow < first)) continue;
        row.append(makeCell(index, column, rows.get(index)?.get(column), merge));
      }
      fragment.append(row);
    }
    layer.replaceChildren(fragment);
    if (!activeSheet.rowCount) {
      const empty = node('div', 'office-grid-empty', '工作表为空'); empty.setAttribute('role', 'status'); layer.append(empty);
    }
  }

  function chooseSheet(index, restoring = false) {
    sheetIndex = index; activeSheet = model.sheets[index];
    rows = new Map(activeSheet.rows.map(row => [row.index, new Map(row.cells.map(cell => [cell.column, cell]))]));
    merges = activeSheet.merges || []; widths = activeSheet.widths || [];
    offsets = [ROW_HEADER];
    for (let column = 0; column < activeSheet.columnCount; column++) offsets.push(offsets[column] + (widths[column] || 128));
    canvas.style.height = `${Math.max(2, activeSheet.rowCount + 1) * ROW_HEIGHT}px`;
    canvas.style.width = `${offsets.at(-1)}px`; header.style.width = canvas.style.width;
    viewport.setAttribute('aria-rowcount', String(activeSheet.rowCount)); viewport.setAttribute('aria-colcount', String(activeSheet.columnCount));
    tabButtons.forEach((tab, tabIndex) => { tab.setAttribute('aria-selected', String(tabIndex === index)); tab.tabIndex = tabIndex === index ? 0 : -1; });
    header.replaceChildren(node('div', 'office-grid-corner'));
    for (let column = 1; column <= activeSheet.columnCount; column++) {
      const label = node('div', 'office-grid-column-label', columnLabel(column)); label.setAttribute('role', 'columnheader');
      label.style.left = `${offsets[column - 1]}px`; label.style.width = `${offsets[column] - offsets[column - 1]}px`; header.append(label);
    }
    viewport.scrollTop = restoring ? Math.max(0, Number(ctx.state.scrollTop) || 0) : 0;
    viewport.scrollLeft = restoring ? Math.max(0, Number(ctx.state.scrollLeft) || 0) : 0;
    selection = { row: 1, column: 1, endRow: 1, endColumn: 1 };
    find(query); selectCell(1, 1); render();
  }

  function reveal(row, column) {
    const top = row * ROW_HEIGHT;
    if (top < viewport.scrollTop + ROW_HEIGHT) viewport.scrollTop = Math.max(0, top - ROW_HEIGHT);
    else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = Math.max(0, top - viewport.clientHeight + ROW_HEIGHT);
    const left = offsets[column - 1], right = offsets[column];
    if (left < viewport.scrollLeft + ROW_HEADER) viewport.scrollLeft = Math.max(0, left - ROW_HEADER);
    else if (right > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = right - viewport.clientWidth;
    render();
  }

  function find(value) {
    query = String(value || '').slice(0, 256); hits = []; hitIndex = -1;
    if (query) {
      const folded = query.toLocaleLowerCase();
      outer: for (const row of activeSheet.rows) for (const cell of row.cells) {
        if ((formulas && cell.formula ? cell.formula : cell.text).toLocaleLowerCase().includes(folded)) hits.push({ row: row.index, column: cell.column });
        if (hits.length >= 1000) break outer;
      }
    }
    matchCount.textContent = query ? (hits.length ? `${hits.length === 1000 ? '≥' : ''}${hits.length} 处` : '无匹配') : '';
  }

  function moveHit(direction) {
    if (!hits.length) return;
    hitIndex = (hitIndex + direction + hits.length) % hits.length;
    const hit = hits[hitIndex]; selectCell(hit.row, hit.column); reveal(hit.row, hit.column);
    matchCount.textContent = `${hitIndex + 1} / ${hits.length === 1000 ? '≥' : ''}${hits.length}`;
  }

  async function copySelection(event) {
    const [startRow, endRow] = [Math.min(selection.row, selection.endRow), Math.max(selection.row, selection.endRow)];
    const [startColumn, endColumn] = [Math.min(selection.column, selection.endColumn), Math.max(selection.column, selection.endColumn)];
    if ((endRow - startRow + 1) * (endColumn - startColumn + 1) > MAX_COPY_CELLS) {
      status.textContent = '一次最多复制 10,000 个单元格，请缩小选区'; return;
    }
    const lines = [];
    for (let row = startRow; row <= endRow; row++) {
      const values = [];
      for (let column = startColumn; column <= endColumn; column++) {
        const value = textAt(row, column);
        values.push(/[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
      }
      lines.push(values.join('\t'));
    }
    const text = lines.join('\n');
    if (text.length > 1024 * 1024) { status.textContent = '选区文本超过 1 MiB，请缩小选区'; return; }
    try {
      if (event?.clipboardData) { event.clipboardData.setData('text/plain', text); event.preventDefault(); }
      else await navigator.clipboard.writeText(text);
      if (!disposed && resources.isCurrent()) status.textContent = '已复制选区';
    } catch { if (!disposed && resources.isCurrent()) status.textContent = '无法访问剪贴板，请使用 Ctrl+C'; }
  }

  listen(viewport, 'scroll', () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); });
  listen(layer, 'click', event => {
    const cell = event.target.closest('.office-grid-cell');
    if (!cell) return;
    selectCell(Number(cell.dataset.row), Number(cell.dataset.column), event.shiftKey); viewport.focus();
  });
  listen(viewport, 'copy', copySelection);
  listen(viewport, 'keydown', event => {
    let { endRow: row, endColumn: column } = selection;
    const delta = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-15, 0], PageDown: [15, 0] }[event.key];
    if (delta) { event.preventDefault(); row += delta[0]; column += delta[1]; selectCell(row, column, event.shiftKey); reveal(selection.endRow, selection.endColumn); }
    else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); column = event.key === 'Home' ? 1 : activeSheet.columnCount;
      if (event.ctrlKey || event.metaKey) row = event.key === 'Home' ? 1 : activeSheet.rowCount;
      selectCell(row, column, event.shiftKey); reveal(selection.endRow, selection.endColumn);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.focus(); }
  });
  listen(search, 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); moveHit(event.shiftKey ? -1 : 1); } });
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(render) : null; observer?.observe(viewport);
  chooseSheet(sheetIndex, true);
  return {
    getState: () => ({ sheet: sheetIndex, scrollTop: viewport.scrollTop, scrollLeft: viewport.scrollLeft, formulas }),
    dispose() { disposed = true; if (frame) cancelAnimationFrame(frame); observer?.disconnect(); listeners.forEach(remove => remove()); actions.remove(); wrapper.remove(); rows?.clear(); hits = []; },
  };
}
