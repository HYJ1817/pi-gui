/* 扩展 › 插件市场：第一阶段只预留位置，不发请求、不安装任何东西。
 *
 * 市场浏览与安装属于第二阶段（见 docs/agent-capabilities.md「2B 边界」）：届时分类、排序与
 * 卡片网格放进本页签，搜索 / 刷新经页面壳的 toolbar / actions 插槽挂到页签行与页头（与「已安装」同一机制）。
 * 注意：PI-Desktop 的 `.piplug` 是它自己的宿主插件包（独立进程 + 权限网关），
 * 不是 Pi 原生 Extension，不能直接装进 pi —— 第二阶段只接入 Pi 能直接加载的来源。 */

import { createIcon } from '../ui/icons.js';
import { resourceEl as el } from '../ui/resource-dom.js';

export function renderExtensionMarket(holder) {
  const empty = el('div', 'extensions-empty extensions-market-empty');
  const chip = el('span', 'extensions-empty-icon');
  chip.append(createIcon('market', { size: 16 }));
  empty.append(chip, el('h3', 'extensions-empty-title', '插件市场尚未开放'),
    el('p', 'extensions-empty-text', '当前只管理本机已安装的 Pi 扩展。'));
  holder.append(empty);
  return { dispose() {} };
}
