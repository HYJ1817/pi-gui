/* Presentation only: the existing tool buttons retain capability and action ownership.
 *
 * 起始页只决定「怎么摆」：入口仍然来自右栏顶部那排真实按钮，
 * 点击时 focus + click 原按钮 —— 本模块不复制任何打开面板的业务逻辑。
 * 可用性（hidden / disabled）继续观察原按钮；本模块只做投影。
 *
 * 入口可以是元素，也可以是描述：
 *   mountWorkPanelLauncher(host, [
 *     { source: navChanges, label: '变更', shortcutId: 'work-changes' },
 *     { source: btnTree, label: '分支树', more: true },
 *   ])
 * `label` 省略时退回按钮的 aria-label / title；`shortcutId` 从 shortcuts.js
 * 的唯一注册表读取组合键，提示不会和真实按键漂移。 */
import { formatCombo, shortcutFor } from '../shortcuts.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
let moreSerial = 0;

function span(className, text) {
  const node = document.createElement('span');
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function normalise(tool) {
  if (!tool) return null;
  if (tool.nodeType === 1) return { source: tool, label: '', shortcutId: '', more: false };
  const source = tool.source;
  if (!source || source.nodeType !== 1) return null;
  return {
    source,
    label: typeof tool.label === 'string' ? tool.label : '',
    shortcutId: typeof tool.shortcutId === 'string' ? tool.shortcutId : '',
    more: tool.more === true,
  };
}

function moreIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [x, y] of [[4, 4], [14, 4], [4, 14], [14, 14]]) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', '6');
    rect.setAttribute('height', '6');
    rect.setAttribute('rx', '1.4');
    svg.append(rect);
  }
  return svg;
}

function chevronIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'm9 10 3 3 3-3');
  svg.append(path);
  return svg;
}

export function mountWorkPanelLauncher(host, tools, options = {}) {
  const entries = (Array.isArray(tools) ? tools : []).map(normalise).filter(Boolean);
  const primary = entries.filter((entry) => !entry.more);
  const extra = entries.filter((entry) => entry.more);

  const root = document.createElement('section');
  root.className = 'work-panel-empty';
  const title = document.createElement('h2');
  title.textContent = options.title || '工具';

  const grid = document.createElement('div');
  grid.className = 'work-panel-launcher-grid';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', '工作面板工具');

  const extraGrid = document.createElement('div');
  extraGrid.className = 'work-panel-launcher-grid work-panel-launcher-extra';
  extraGrid.id = `workPanelLauncherMore${++moreSerial}`;
  extraGrid.hidden = true;
  extraGrid.setAttribute('role', 'group');
  extraGrid.setAttribute('aria-label', '更多工作面板工具');

  const bindings = [];
  const addCard = (entry, parent) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'work-panel-launcher-row';
    row.dataset.tool = entry.source.id;

    const icon = span('work-panel-launcher-icon');
    icon.setAttribute('aria-hidden', 'true');
    const sourceIcon = entry.source.querySelector('svg');
    if (sourceIcon) icon.append(sourceIcon.cloneNode(true));

    const label = span('work-panel-launcher-label');
    const shortcut = document.createElement('kbd');
    shortcut.className = 'work-panel-launcher-shortcut';
    const registered = entry.shortcutId ? shortcutFor(entry.shortcutId) : null;
    if (registered) shortcut.textContent = formatCombo(registered.combo);
    else shortcut.hidden = true;

    const sync = () => {
      row.hidden = entry.source.hidden;
      row.disabled = entry.source.disabled;
      if (!entry.label) label.textContent = entry.source.getAttribute('aria-label') || entry.source.title || '';
      row.title = entry.source.getAttribute('aria-label') || entry.source.title || label.textContent;
    };

    label.textContent = entry.label;
    row.append(icon, label, shortcut);
    row.onclick = () => {
      if (entry.source.hidden || entry.source.disabled) return;
      entry.source.focus();
      entry.source.click();
    };
    parent.append(row);
    const binding = { entry, row, sync };
    bindings.push(binding);
    sync();
  };

  for (const entry of primary) addCard(entry, grid);
  for (const entry of extra) addCard(entry, extraGrid);

  let moreButton = null;
  if (extra.length) {
    moreButton = document.createElement('button');
    moreButton.type = 'button';
    moreButton.className = 'work-panel-launcher-more';
    moreButton.setAttribute('aria-expanded', 'false');
    moreButton.setAttribute('aria-controls', extraGrid.id);
    const icon = span('work-panel-launcher-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.append(moreIcon());
    const chevron = span('work-panel-launcher-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.append(chevronIcon());
    moreButton.append(icon, span('work-panel-launcher-label', '更多工具…'), chevron);
    moreButton.onclick = () => {
      const open = moreButton.getAttribute('aria-expanded') !== 'true';
      moreButton.setAttribute('aria-expanded', String(open));
      extraGrid.hidden = !open;
    };
    grid.append(moreButton);
  }

  const extraBindings = bindings.filter((binding) => binding.entry.more);
  function syncMore() {
    if (!moreButton) return;
    const available = extraBindings.some((binding) => !binding.row.hidden);
    moreButton.hidden = !available;
    if (!available && moreButton.getAttribute('aria-expanded') === 'true') {
      moreButton.setAttribute('aria-expanded', 'false');
      extraGrid.hidden = true;
    }
  }

  const observer = new MutationObserver(() => {
    for (const binding of bindings) binding.sync();
    syncMore();
  });
  for (const { entry } of bindings) {
    observer.observe(entry.source, { attributes: true, attributeFilter: ['hidden', 'disabled', 'aria-label'] });
  }
  syncMore();

  root.append(title, grid);
  if (extra.length) root.append(extraGrid);
  host.append(root);

  return () => {
    observer.disconnect();
    for (const { row } of bindings) {
      row.disabled = true;
      row.onclick = null;
    }
    if (moreButton) {
      moreButton.disabled = true;
      moreButton.onclick = null;
    }
  };
}
