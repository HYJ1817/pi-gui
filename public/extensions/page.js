/* 扩展（应用主导航）—— Pi 原生 Extension 的独立工作区页面。
 *
 * 两个页签：「已安装」（只读 Registry + 已知能力设置）与「插件市场」（第一阶段仅预留）。
 * 页签面板懒建、建好后复用；每个面板返回自己的 dispose，页面实例销毁时统一调用 ——
 * Work Surface 的 onDispose 是单槽位（后注册覆盖先注册），所以这里只注册一次。
 * 本模块不 import 技能页或 MCP 页的任何 UI。 */

import { openWorkSurface } from '../ui/workspace-surface.js';
import { renderExtensionNotices } from '../extension-notices.js';
import { resourceEl as el } from '../ui/resource-dom.js';
import { renderInstalledExtensions } from './installed.js';
import { renderExtensionMarket } from './market.js';

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

    const tablist = el('div', 'ext-tabs extensions-tabs');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', '扩展视图');
    const notices = el('section', 'extension-notices');
    const panel = el('div', 'ext-body extensions-panel');
    panel.id = 'extensionsTabPanel';
    panel.setAttribute('role', 'tabpanel');
    const buttons = new Map();
    const panels = new Map();
    let active = initial;

    const installedCount = el('span', 'extensions-tab-count');
    const setInstalledCount = (count) => { installedCount.textContent = Number.isInteger(count) ? String(count) : ''; };

    function select(id, { focus = false } = {}) {
      active = id;
      for (const tab of TABS) {
        const button = buttons.get(tab.id);
        const on = tab.id === active;
        button.classList.toggle('on', on);
        button.setAttribute('aria-selected', String(on));
        button.tabIndex = on ? 0 : -1;
      }
      const current = TABS.find((tab) => tab.id === active);
      panel.setAttribute('aria-labelledby', current.domId);
      let holder = panels.get(active);
      if (holder) {
        panel.replaceChildren(holder);
      } else {
        holder = el('div', 'ext-panel extensions-tab-' + active);
        panels.set(active, holder);
        panel.replaceChildren(holder);
        const handle = current.render(holder, { isLive: instance.isCurrent, onCount: setInstalledCount });
        if (typeof handle?.dispose === 'function') disposers.push(() => handle.dispose());
      }
      if (focus) buttons.get(active).focus();
    }

    for (const tab of TABS) {
      const button = el('button', 'ext-tab extensions-tab');
      button.type = 'button';
      button.id = tab.domId;
      button.dataset.tab = tab.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', panel.id);
      button.append(el('span', '', tab.label));
      if (tab.id === 'installed') button.append(installedCount);
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

    const refreshNotices = () => { if (instance.isCurrent()) renderExtensionNotices(notices); };
    for (const type of NOTICE_EVENTS) document.addEventListener(type, refreshNotices);
    disposers.push(() => { for (const type of NOTICE_EVENTS) document.removeEventListener(type, refreshNotices); });

    card.append(tablist, notices, panel);
    refreshNotices();
    select(initial);
  });
}
