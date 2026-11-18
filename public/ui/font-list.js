/* Fixed-height windowing model for the appearance font picker.
 *
 * Only rows intersecting the scroll viewport (plus overscan) are mounted, so
 * opening a list with hundreds of installed families does not force Chromium
 * to shape hundreds of preview fonts at once. The arithmetic mirrors
 * PI-Desktop v0.22.0's `font-list.ts`; this module has no DOM dependency.
 */

export const FONT_OPTION_ROW_HEIGHT = 32;
export const FONT_GROUP_ROW_HEIGHT = 28;
export const FONT_LIST_OVERSCAN = 8;

export function buildFontListLayout(options, groupLabel) {
  const rows = [];
  const heights = [];
  options.forEach((option, optionIndex) => {
    const previous = optionIndex === 0 ? null : options[optionIndex - 1];
    if (!previous || previous.group !== option.group) {
      rows.push({
        kind: 'group',
        index: rows.length,
        id: `group:${option.group}`,
        label: groupLabel(option.group)
      });
      heights.push(FONT_GROUP_ROW_HEIGHT);
    }
    rows.push({
      kind: 'option',
      index: rows.length,
      id: `option:${option.group}:${option.value}`,
      option,
      optionIndex
    });
    heights.push(FONT_OPTION_ROW_HEIGHT);
  });
  const offsets = new Array(rows.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < rows.length; index += 1) {
    offsets[index + 1] = offsets[index] + heights[index];
  }
  const optionRowIndex = new Array(options.length);
  for (const row of rows) {
    if (row.kind === 'option') optionRowIndex[row.optionIndex] = row.index;
  }
  return { rows, heights, offsets, optionRowIndex, totalHeight: offsets[rows.length] };
}

/** First row index whose top edge is at or below `y` (binary search). */
function firstRowAtOrBelow(offsets, y) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] < y) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function visibleRowRange(layout, scrollTop, viewportHeight, overscan = FONT_LIST_OVERSCAN) {
  if (layout.rows.length === 0) return { start: 0, end: 0 };
  const start = Math.max(0, firstRowAtOrBelow(layout.offsets, Math.max(0, scrollTop)) - overscan);
  const end = Math.min(
    layout.rows.length,
    firstRowAtOrBelow(layout.offsets, scrollTop + Math.max(0, viewportHeight)) + overscan + 1
  );
  return { start, end };
}
