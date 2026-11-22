/* 扩展（应用主导航）—— Pi 原生 Extension 的独立工作区页面。
 *
 * 版式对照 PI-Desktop 扩展页（PluginsPage）：页头 → 页签与工具栏 → 可折叠的运行提示 → 页签面板。
 * 页面自己画「扩展」标题，工作区标题栏里的同名标题在本页隐藏（extensions.css），不出现两个标题。
 *
 * 页签面板懒建、建好后复用；每个面板返回自己的 dispose，以及可选的 toolbar / actions 节点，
 * 由页面壳挂进页签行与页头的插槽 —— 切页签只换插槽里的节点，节点本身复用（搜索词、焦点状态不丢）。
 * Work Surface 的 onDispose 是单槽位（后注册覆盖先注册），所以这里只注册一次。
 * 本模块不 import 技能页或 MCP 页的任何 UI。 */

import { openWorkSurface } from '../ui/workspace-surface.js';
import { extensionNotices, renderExtensionNotices } from '../extension-notices.js';
import { createIcon } from '../ui/icons.js';
import { resourceEl as el } from '../ui/resource-dom.js';
import { renderInstalledExtensions } from './installed.js';
import { renderExtensionMarket } from './market.js';
import { createExtensionOperations } from './operations.js';

const TABS = Object.freeze([
  Object.freeze({ id: 'installed', label: '已安装', domId: 'extensionsTabInstalled', render: renderInstalledExtensions }),
  Object.freeze({ id: 'market', label: '插件市场', domId: 'extensionsTabMarket', render: renderExtensionMarket }),
]);
/** 拆分前的入口参数 `{ tab: 'extensions' }` 仍然落到「已安装」。 */
const TAB_ALIASES = Object.freeze({ extensions: 'installed' });
const NOTICE_EVENTS = Object.freeze(['pi-gui:extension-notices', 'pi-gui:workspace-generation', 'pi-gui:feedback-context']);

/**
 * 打开扩展页。
 * @param options.tab 'installed'（默认）| 'market'
 */
export function openExtensions(options = {}) {
  const requested = TAB_ALIASES[options.tab] || options.tab;
  const initial = TABS.some((tab) => tab.id === requested) ? requested : 'installed';
  openWorkSurface('extensions', (card, instance) => {
    card.classList.add('wide', 'ext', 'extensions-page');
    const disposers = [];
    instance.onDispose(() => {
      for (const dispose of disposers.splice(0)) {
        try { dispose(); } catch { /* 一个面板清理失败不影响其它面板 */ }
      }
    });

    const inner = el('div', 'extensions-inner ds-readable-badges');
    const head = el('header', 'extensions-head');
    const heading = el('h2', 'extensions-title', '扩展');
    const actionsSlot = el('div', 'extensions-head-actions');
    head.append(heading, actionsSlot);

    const toolbarRow = el('div', 'extensions-toolbar-row');
    const tablist = el('div', 'ds-segmented extensions-tabs');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', '扩展视图');
    const toolbarSlot = el('div', 'extensions-toolbar-slot');
    toolbarRow.append(tablist, toolbarSlot);

    const notices = el('details', 'extension-notices');
    const noticeSummary = el('summary', 'extensions-notice-summary');
    const noticeCounts = el('span', 'extensions-notice-counts');
    noticeSummary.append(createIcon('info', { size: 15 }), el('span', '', '运行提示'), noticeCounts,
      createIcon('chevronDown', { size: 14, className: 'extensions-notice-chevron' }));
    const noticeBody = el('div', 'extensions-notice-body');
    noticeBody.tabIndex = 0; // 展开后可用方向键 / PageDown 滚动长诊断，无须鼠标。
    noticeBody.setAttribute('role', 'region');
    noticeBody.setAttribute('aria-label', '运行提示原文');
    notices.append(noticeSummary, noticeBody);
    const panel = el('div', 'extensions-panel');
    panel.id = 'extensionsTabPanel';
    panel.setAttribute('role', 'tabpanel');
    const buttons = new Map();
    const panels = new Map(); // id → { holder, toolbar, actions }
    let active = initial;
    const operations = createExtensionOperations({
      isLive: instance.isCurrent,
      async onChange({ reload = false } = {}) {
        const mounted = [...panels.values()];
        if (reload) await Promise.all(mounted.map((entry) => entry.reload?.()));
        else for (const entry of mounted) entry.sync?.();
      },
    });
    disposers.push(operations.invalidate);

    const counts = new Map(TABS.map(({ id }) => [id, el('span', 'ds-segment-count extensions-tab-count')]));
    const setCount = (id, count) => {
      counts.get(id).textContent = Number.isInteger(count) ? String(count) : '';
    };

    function select(id, { focus = false } = {}) {
      if (active !== id) panels.get(active)?.deactivate?.();
      active = id;
      for (const tab of TABS) {
        const button = buttons.get(tab.id);
        const on = tab.id === active;
        button.classList.toggle('is-active', on);
        button.setAttribute('aria-selected', String(on));
        button.tabIndex = on ? 0 : -1;
      }
      const current = TABS.find((tab) => tab.id === active);
      panel.setAttribute('aria-labelledby', current.domId);
      let entry = panels.get(active);
      if (entry) {
        panel.replaceChildren(entry.holder);
        entry.activate?.();
      } else {
        const holder = el('div', 'extensions-tab-panel extensions-tab-' + active);
        panel.replaceChildren(holder);
        const handle = current.render(holder, {
          isLive: instance.isCurrent,
          operations,
          onCount: (count) => setCount(id, count),
        }) || {};
        if (typeof handle.dispose === 'function') disposers.push(() => handle.dispose());
        entry = { holder, ...handle };
        panels.set(active, entry);
      }
      toolbarSlot.replaceChildren(...(entry.toolbar ? [entry.toolbar] : []));
      actionsSlot.replaceChildren(...(entry.actions ? [entry.actions] : []));
      if (focus) buttons.get(active).focus();
    }

    for (const tab of TABS) {
      const button = el('button', 'ds-segment-item extensions-tab');
      button.type = 'button';
      button.id = tab.domId;
      button.dataset.tab = tab.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', panel.id);
      button.append(el('span', 'extensions-tab-label', tab.label));
      button.append(counts.get(tab.id));
      button.onclick = () => { if (active !== tab.id) select(tab.id); };
      buttons.set(tab.id, button);
      tablist.append(button);
    }
    /* tablist 键盘模型：左右方向键 / Home / End 切换并移动焦点（自动激活）。 */
    tablist.addEventListener('keydown', (event) => {
      const index = TABS.findIndex((tab) => tab.id === active);
      const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      select(TABS[next].id, { focus: true });
    });

    const refreshNotices = (event) => {
      if (!instance.isCurrent()) return;
      if (event?.type === 'pi-gui:workspace-generation') {
        operations.invalidate();
        for (const entry of panels.values()) entry.invalidate?.();
      }
      const items = extensionNotices(); // 当前运行的去重快照；折叠状态只属于这一个页面。
      // 隐藏后 Chromium 会释放焦点；仅当焦点在即将消失的提示区时交还当前页签。
      if (!items.length && notices.contains(document.activeElement)) buttons.get(active).focus();
      notices.hidden = !items.length;
      if (!items.length) notices.open = false;
      const byKind = { error: 0, warning: 0, info: 0 };
      for (const item of items) byKind[item.kind]++;
      noticeSummary.dataset.kind = byKind.error ? 'error' : byKind.warning ? 'warning' : 'info';
      noticeCounts.textContent = [[byKind.error, '错误'], [byKind.warning, '警告'], [byKind.info, '提示']]
        .filter(([count]) => count > 0).map(([count, label]) => `${count} 条${label}`).join(' · ');
      renderExtensionNotices(noticeBody);
    };
    for (const type of NOTICE_EVENTS) document.addEventListener(type, refreshNotices);
    disposers.push(() => { for (const type of NOTICE_EVENTS) document.removeEventListener(type, refreshNotices); });
    const refreshAfterRestart = () => {
      if (!instance.isCurrent()) return;
      refreshNotices();
      void panels.get('installed')?.reload();
    };
    document.addEventListener('pi-gui:capability-bridge-ready', refreshAfterRestart);
    disposers.push(() => document.removeEventListener('pi-gui:capability-bridge-ready', refreshAfterRestart));

    inner.append(head, toolbarRow, notices, panel);
    /* Work Surface 本身不滚动（.work-surface 的 overflow:hidden 契约），整页内容由这一层内部滚动容器承担。 */
    const scroller = el('div', 'extensions-scroll');
    scroller.append(inner);
    card.append(scroller);
    refreshNotices();
    select(initial);
  });
}
