/* 扩展 › 插件市场：第一阶段只预留布局，不发请求、不安装任何东西。
 *
 * 市场浏览与安装属于第二阶段（见 docs/agent-capabilities.md「2B 边界」）。
 * 注意：PI-Desktop 的 `.piplug` 是它自己的宿主插件包（独立进程 + 权限网关），
 * 不是 Pi 原生 Extension，不能直接装进 pi —— 第二阶段只接入 Pi 能直接加载的来源。 */

import { createIcon } from '../ui/icons.js';
import { resourceEl as el } from '../ui/resource-dom.js';

export function renderExtensionMarket(holder) {
  const empty = el('div', 'extensions-market-empty');
  const glyph = el('span', 'extensions-market-icon');
  glyph.append(createIcon('market', { size: 20 }));
  empty.append(glyph, el('h4', 'extensions-market-title', '插件市场尚未开放'),
    el('p', 'extensions-market-desc', '当前版本只管理本机已发现的 Pi 原生扩展；市场浏览与安装会在后续版本提供。'));
  holder.append(empty);
  return { dispose() {} };
}
