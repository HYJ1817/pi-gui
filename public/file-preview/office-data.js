// Bounded data projection for the mature parsers; never evaluate formulas or
// use cell text as HTML, a URL, CSS, an identifier, or a JS property path.
import { OFFICE_LIMITS, officeError } from './office-policy.js';

export function decodeDelimited(bytes, encoding = 'auto') {
  if (!(bytes instanceof Uint8Array) || bytes.length > OFFICE_LIMITS.csvBytes) throw officeError('size');
  if (!['auto', 'utf-8', 'gb18030', 'utf-16le', 'utf-16be'].includes(encoding)) throw officeError('encoding');
  try {
    if (encoding !== 'auto') return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
  } catch { throw officeError('encoding'); }
}

export function parseDelimited(Papa, bytes, kind, encoding) {
  const text = decodeDelimited(bytes, encoding);
  if (text.includes('\0')) throw officeError('format');
  let count = 0, chars = 0;
  const rows = [];
  const result = Papa.parse(text, {
    delimiter: kind === 'tsv' ? '\t' : '',
    dynamicTyping: false,
    skipEmptyLines: true,
    preview: OFFICE_LIMITS.rows + 1,
    step(item, parser) {
      if (item.errors?.some(error => error.code === 'MissingQuotes' || error.code === 'InvalidQuotes')) {
        parser.abort(); throw officeError('csv-format');
      }
      const values = item.data;
      count += values.length;
      chars += values.reduce((sum, value) => sum + String(value).length, 0);
      if (values.length > OFFICE_LIMITS.columns || count > OFFICE_LIMITS.cells
        || chars > OFFICE_LIMITS.textChars || rows.length >= OFFICE_LIMITS.rows) {
        parser.abort(); throw officeError('sheet-limit');
      }
      rows.push({ index: rows.length + 1, cells: values.map((value, column) => ({ column: column + 1, text: String(value), type: 'text' })) });
    },
  });
  if (result?.meta?.truncated) throw officeError('sheet-limit');
  return { kind, sheets: [{ name: kind.toUpperCase(), rows, rowCount: rows.length, columnCount: Math.max(1, ...rows.map(row => row.cells.length)), merges: [], widths: [] }] };
}

function safeColor(color) {
  return typeof color?.argb === 'string' && /^[\da-f]{8}$/i.test(color.argb) ? `#${color.argb.slice(2)}` : undefined;
}

function projectStyle(cell) {
  const result = {};
  const font = cell.font || {};
  if (font.bold) result.bold = true;
  if (font.italic) result.italic = true;
  if (font.underline) result.underline = true;
  if (font.strike) result.strike = true;
  if (safeColor(font.color)) result.color = safeColor(font.color);
  if (cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid' && safeColor(cell.fill.fgColor)) result.background = safeColor(cell.fill.fgColor);
  if (['left', 'center', 'right'].includes(cell.alignment?.horizontal)) result.align = cell.alignment.horizontal;
  return result;
}

function primitive(value, numFmt = '') {
  if (value === null || value === undefined) return { text: '', type: 'empty' };
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return { text: '', type: 'empty' };
    const iso = value.toISOString();
    return { text: /[hs]/i.test(numFmt.replace(/"[^\"]*"/g, '')) ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 10), type: 'date' };
  }
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', type: 'boolean' };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { text: String(value), type: 'number' };
    // A deliberately small display-format subset. ExcelJS owns parsing, dates,
    // cached results and types. We do not pretend to implement Excel's engine.
    const format = String(numFmt).split(';')[0].replace(/"[^\"]*"|\[[^\]]*\]|\\./g, '');
    if (/[0#?]/.test(format) && !/[eE]/.test(format)) {
      const digits = Math.min(10, (format.match(/\.([0#?]+)/)?.[1] || '').length);
      const minimum = Math.min(digits, (format.match(/\.([0]+)/)?.[1] || '').length);
      const percent = format.includes('%');
      const text = new Intl.NumberFormat('en-US', { useGrouping: format.includes(','), minimumFractionDigits: minimum, maximumFractionDigits: digits }).format(value * (percent ? 100 : 1));
      const currency = format.match(/[$€£¥]/)?.[0] || '';
      return { text: currency + text + (percent ? '%' : ''), type: 'number' };
    }
    return { text: String(value), type: 'number' };
  }
  if (typeof value === 'string') return { text: value, type: 'text' };
  if (Array.isArray(value.richText)) return { text: value.richText.map(part => String(part.text ?? '')).join(''), type: 'text' };
  if (typeof value.text === 'string') return { text: value.text, type: 'text' };
  if (typeof value.error === 'string') return { text: value.error, type: 'error' };
  return { text: '', type: 'empty' };
}

export function projectWorkbook(workbook) {
  const sheets = [];
  let cells = 0, chars = 0;
  for (const worksheet of workbook.worksheets) {
    if (sheets.length >= OFFICE_LIMITS.sheets || worksheet.rowCount > OFFICE_LIMITS.rows || worksheet.columnCount > OFFICE_LIMITS.columns) throw officeError('sheet-limit');
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, row => {
      const projected = { index: row.number, cells: [] };
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const value = cell.value;
        const formula = value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value);
        const rawFormula = formula ? String(cell.formula || value.formula || '') : '';
        const projectedCell = primitive(formula ? value.result : value, cell.numFmt);
        if (formula) {
          projectedCell.formula = '=' + rawFormula;
          if (value.result === undefined || value.result === null) projectedCell.text = projectedCell.formula;
        }
        chars += projectedCell.text.length + rawFormula.length;
        if (++cells > OFFICE_LIMITS.cells || chars > OFFICE_LIMITS.textChars || column > OFFICE_LIMITS.columns) throw officeError('sheet-limit');
        projected.cells.push({ ...projectedCell, column, style: projectStyle(cell) });
      });
      rows.push(projected);
    });
    // Public model has merge ranges; use ExcelJS's own address decoder result
    // exposed by the master rather than inventing an OOXML reader.
    const merges = (worksheet.model.merges || []).map(address => {
      const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(address);
      if (!match) throw officeError('sheet-limit');
      const col = label => [...label].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
      return { row: Number(match[2]), column: col(match[1]), endRow: Number(match[4]), endColumn: col(match[3]) };
    });
    sheets.push({
      name: String(worksheet.name).slice(0, 128), rows, merges,
      rowCount: worksheet.rowCount, columnCount: Math.max(1, worksheet.columnCount),
      widths: Array.from({ length: worksheet.columnCount }, (_, index) => Math.min(360, Math.max(80, (worksheet.getColumn(index + 1).width || 14) * 7 + 16))),
    });
  }
  if (!sheets.length) throw officeError('format');
  return { kind: 'xlsx', sheets };
}
