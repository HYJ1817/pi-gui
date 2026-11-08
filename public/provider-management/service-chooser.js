/* 服务选择器：订阅组在前，API Key 组在后；自定义端点固定在 API Key 组首位。
 *
 * 没有网络、没有假登录。订阅卡能不能点只看 snapshot.auth / capabilities，
 * 不确定一律 disabled 并写明原因。 */

import {
  authenticateCatalog,
  catalogDescription,
  catalogEndpointText,
  filterCatalog,
  groupCatalog,
  isSubscription,
  monogram,
  normalizeCatalog,
  subscriptionAvailability,
} from './catalog.js';
import { h, icon, isComposing } from './dom.js';

function tile(item, snapshot, { selectedId, onPick, onUnavailable }) {
  const subscription = isSubscription(item);
  const availability = subscription
    ? subscriptionAvailability(snapshot, item)
    : { available: true, reason: '' };
  const connected = subscription && item.auth?.status === 'connected';
  const button = h('button', {
    type: 'button',
    class: `pm-service-tile${selectedId === item.id ? ' is-selected' : ''}${availability.available ? '' : ' is-disabled'}`,
    'data-service-id': item.id,
    'data-service-category': item.category || 'api-key',
    'aria-current': selectedId === item.id ? 'true' : 'false',
    'aria-disabled': availability.available ? 'false' : 'true',
    title: availability.available ? `${item.name} · ${catalogEndpointText(item)}` : `${item.name} · ${availability.reason}`,
  },
  h('span', { class: `pm-service-monogram${subscription ? ' is-subscription' : ''}`, 'aria-hidden': 'true', text: monogram(item) }),
  h('span', { class: 'pm-service-copy' },
    h('span', { class: 'pm-service-name-row' },
      h('span', { class: 'pm-service-name', text: item.name || item.id }),
      connected ? h('span', { class: 'pm-service-connected', text: '已连接' }) : null,
      !availability.available && item.disabledReason ? h('span', { class: 'pm-service-soon', text: '待接通' }) : null,
    ),
    h('span', { class: 'pm-service-detail', text: availability.available ? catalogEndpointText(item) : availability.reason }),
    availability.available && !subscription ? h('span', { class: 'pm-service-hint', text: catalogDescription(item) }) : null,
  ));
  button.addEventListener('click', () => {
    if (!availability.available) {
      onUnavailable(item, availability.reason);
      return;
    }
    onPick(item);
  });
  button.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      button.click();
    }
  });
  return button;
}

function tileGrid(items, snapshot, options) {
  const grid = h('div', { class: 'pm-service-grid', role: 'list' });
  for (const item of items) {
    const node = tile(item, snapshot, options);
    node.setAttribute('role', 'listitem');
    grid.appendChild(node);
  }
  return grid;
}

export function renderServiceChooser({
  snapshot,
  selectedId = null,
  onPick = () => {},
  onUnavailable = () => {},
  initialQuery = '',
} = {}) {
  const root = h('div', { class: 'pm-chooser' });
  const searchWrap = h('div', { class: 'pm-search' },
    icon('search', 15),
    h('input', {
      class: 'pm-search-input pm-chooser-search',
      type: 'search',
      placeholder: '搜索服务、模型或网址…',
      'aria-label': '搜索服务',
      autocomplete: 'off',
      spellcheck: 'false',
    }),
    h('span', { class: 'pm-search-hint', 'aria-hidden': 'true', text: '方向键选择' }),
  );
  const input = searchWrap.querySelector('input');
  const body = h('div', { class: 'pm-chooser-body' });
  root.append(searchWrap, body);

  const catalog = authenticateCatalog(normalizeCatalog(snapshot), snapshot);
  const authProviders = Array.isArray(snapshot?.auth?.providers) ? snapshot.auth.providers : [];
  let currentSelected = selectedId;
  let visible = [];

  const notifyUnavailable = (item, reason) => {
    status.textContent = reason;
    status.hidden = false;
    onUnavailable(item, reason);
  };

  const status = h('div', { class: 'pm-chooser-status', role: 'status', hidden: true });
  root.appendChild(status);

  const focusableTiles = () => [...body.querySelectorAll('.pm-service-tile')];

  const selectedTile = () => {
    const tiles = focusableTiles();
    return tiles.find(node => node.dataset.serviceId === currentSelected && node.getAttribute('aria-disabled') !== 'true') || null;
  };

  function focusFirstTile() {
    const tiles = focusableTiles();
    const target = tiles.find(node => node.getAttribute('aria-disabled') !== 'true') || tiles[0];
    target?.focus();
  }

  function firstAvailable() {
    const tiles = focusableTiles();
    return tiles.find(node => node.getAttribute('aria-disabled') !== 'true') || null;
  }

  function moveTile(event) {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      if (event.key === 'Enter' || event.key === ' ') return;
      return;
    }
    const tiles = focusableTiles();
    const index = tiles.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'Home') { tiles[0]?.focus(); return; }
    if (event.key === 'End') { tiles[tiles.length - 1]?.focus(); return; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const rect = tiles[index].getBoundingClientRect?.();
      const vertical = event.key === 'ArrowUp' ? -1 : 1;
      let best = null;
      for (const candidate of tiles) {
        if (!candidate.getBoundingClientRect || candidate === tiles[index]) continue;
        const other = candidate.getBoundingClientRect();
        if (vertical < 0 ? other.bottom > rect.top - 1 : other.top < rect.bottom - 1) continue;
        const rowDistance = Math.abs(other.top - rect.top);
        const columnDistance = Math.abs(other.left - rect.left);
        if (!best || rowDistance < best.rowDistance || (rowDistance === best.rowDistance && columnDistance < best.columnDistance)) {
          best = { node: candidate, rowDistance, columnDistance };
        }
      }
      if (best) { best.node.focus(); return; }
      if (event.key === 'ArrowUp') input.focus();
      return;
    }
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const target = tiles[Math.max(0, Math.min(tiles.length - 1, index + offset))];
    target?.focus();
  }

  function render() {
    visible = filterCatalog(catalog, input.value, authProviders);
    const groups = groupCatalog(visible);
    body.innerHTML = '';
    status.hidden = true;
    if (!visible.length) {
      body.appendChild(h('div', { class: 'pm-chooser-empty' },
        h('div', { class: 'pm-empty-title', text: '没有匹配的服务' }),
        h('div', { class: 'pm-empty-text', text: '换一个名称、别名或网址试试。' }),
      ));
      return;
    }
    if (groups.subscription.length) {
      const group = h('section', { class: 'pm-chooser-group', 'aria-label': '订阅账户' },
        h('h3', { class: 'pm-chooser-group-title', text: '订阅账户' }),
        tileGrid(groups.subscription, snapshot, { selectedId: currentSelected, onPick, onUnavailable: notifyUnavailable }),
      );
      body.appendChild(group);
    }
    if (groups.apiKey.length) {
      const group = h('section', { class: 'pm-chooser-group', 'aria-label': 'API Key' },
        h('h3', { class: 'pm-chooser-group-title', text: 'API Key 与本地服务' }),
        tileGrid(groups.apiKey, snapshot, { selectedId: currentSelected, onPick, onUnavailable: notifyUnavailable }),
      );
      body.appendChild(group);
    }
  }

  input.addEventListener('input', event => {
    if (isComposing(event)) return;
    render();
  });
  input.addEventListener('compositionend', render);
  input.addEventListener('keydown', event => {
    if (isComposing(event)) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusFirstTile();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = selectedTile() || firstAvailable();
      target?.click();
    }
  });
  body.addEventListener('keydown', event => {
    if (isComposing(event)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      const target = event.target.closest('.pm-service-tile');
      if (!target) return;
      event.preventDefault();
      target.click();
      return;
    }
    moveTile(event);
  });

  render();
  if (initialQuery) {
    input.value = initialQuery;
    render();
  }

  return {
    node: root,
    input,
    focusSearch() { input.focus(); input.select?.(); },
    focusSelectedOrFirst() { (selectedTile() || firstAvailable() || input).focus(); },
    setSelected(id) {
      currentSelected = id;
      for (const node of root.querySelectorAll('.pm-service-tile')) {
        const selected = node.dataset.serviceId === id;
        node.classList.toggle('is-selected', selected);
        node.setAttribute('aria-current', selected ? 'true' : 'false');
      }
    },
    getVisibleItems() { return visible; },
    chooseFirst() {
      const target = selectedTile() || firstAvailable();
      if (target) target.click();
    },
  };
}
