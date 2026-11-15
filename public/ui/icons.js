/* Trusted, repository-local UI artwork. Pass semantic names, never SVG from data. */
const glyphs = Object.freeze({
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  archive: '<path d="M3.5 5h17v4h-17z"/><path d="M5.5 9v9.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M12 11.5v4.5"/><path d="M9.8 14l2.2 2.2L14.2 14"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  arrowUp: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',
  box: '<path d="M21 8l-9-5-9 5 9 5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7"/><path d="M8.5 6h4a3 3 0 0 1 3 3v.5"/>',
  changes: '<path d="M7 4.5h10a2 2 0 0 1 2 2v13l-3-2-3 2-3-2-3 2v-13a2 2 0 0 1 2-2z"/><path d="M10 9.5h4M10 13h4"/>',
  chart: '<path d="M3 3v18h18m-2-12-5 5-4-4-3 3"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chip: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  command: '<polyline points="4 17 10 12 4 7"/><line x1="12" y1="19" x2="20" y2="19"/>',
  context: '<circle cx="12" cy="12" r="8.5"/><path d="M12 12l4.5-4.5"/>',
  conversation: '<path d="M20 12.5a2.5 2.5 0 0 1-2.5 2.5H8l-4 3.5V5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5zM12 6v6M9 9h6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 4H6a2 2 0 0 0-2 2v9"/>',
  diagram: '<rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><path d="M6.5 8v10.5H14M11 15.5l3 3-3 3"/>',
  drag: '<path d="M9 7h.01M15 7h.01M9 12h.01M15 12h.01M9 17h.01M15 17h.01"/>',
  edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 5.5l3 3"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  exitSplit: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 16V8m-3 3 3-3 3 3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1.4"/><rect x="14" y="4" width="6" height="6" rx="1.4"/><rect x="4" y="14" width="6" height="6" rx="1.4"/><rect x="14" y="14" width="6" height="6" rx="1.4"/>',
  help: '<circle cx="12" cy="12" r="8"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17v.4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l2 2M14 9l2 2"/>',
  keyboard: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h.01M11 9h.01M15 9h.01M7 13h.01M11 13h.01M15 13h.01M7 16h10"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  market: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9 20v-6h6v6"/>',
  minus: '<path d="M6.5 12h11"/>',
  more: '<circle cx="5.5" cy="12" r="1.55" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.55" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.55" fill="currentColor" stroke="none"/>',
  package: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M14 5v14"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  pending: '<circle cx="12" cy="12" r="6.5" stroke-dasharray="2.4 2.8"/>',
  pin: '<path d="M9 4h6M10 4v5l-3.5 4.5h11L14 9V4M12 13.5V20"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  progress: '<circle cx="12" cy="12" r="6.5"/><circle class="plan-pulse-dot" cx="12" cy="12" r="2.1"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  restore: '<path d="M3.5 5h17v4h-17z"/><path d="M5.5 9v9.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M12 16v-4.5"/><path d="M9.8 13.5l2.2-2.2 2.2 2.2"/>',
  running: '<circle cx="12" cy="12" r="4.5"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M7 12h10"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  settings: '<path d="M9 4h6l1 3 3 1v6l-3 1-1 3H9l-1-3-3-1V8l3-1z"/><circle cx="12" cy="11" r="3"/>',
  sidebarCollapse: '<path d="M4 5h16v14H4zM10 5v14M17 12h-5m2-2-2 2 2 2"/>',
  sidebarExpand: '<path d="M4 5h16v14H4zM10 5v14M13 12h5m-2-2 2 2-2 2"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  split: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  task: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  test: '<path d="M9 3h6M10 3v5l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 17l-5-9V3"/><path d="M7.5 14h9"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 1 5 5l-8.4 8.4a2 2 0 0 1-2.8-2.8z"/><path d="M5 5l4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10.5 11v6M13.5 11v6"/>',
  update: '<circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4M12 16V8"/>',
  warning: '<path d="M12 4l9 16H3z"/><path d="M12 9v5M12 17h.01"/>',
});

const attributes = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.7',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
  focusable: 'false',
};
const attributeMarkup = Object.entries(attributes).map(([key, value]) => `${key}="${value}"`).join(' ');

export function iconMarkup(name) {
  if (!Object.hasOwn(glyphs, name)) return '';
  return `<svg ${attributeMarkup} data-icon="${name}">${glyphs[name]}</svg>`;
}

function paint(svg, name) {
  if (!Object.hasOwn(glyphs, name)) return;
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
  svg.setAttribute('data-icon', name);
  svg.innerHTML = glyphs[name];
}

export function createIcon(name, { size, className, fallback, ownerDocument = document } = {}) {
  const svg = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  paint(svg, Object.hasOwn(glyphs, name) ? name : fallback);
  if (size) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
  }
  if (className) svg.setAttribute('class', className);
  return svg;
}

export function hydrateIcons(root) {
  for (const svg of root.querySelectorAll('svg[data-icon]:empty')) paint(svg, svg.dataset.icon);
}
