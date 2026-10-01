/* Capability 视图（P22）——**一条统一的界面，回答「这个能力现在能不能用」**。
 *
 * ---------- 它是投影，不是事实源 ----------
 *
 * 这里**不判断任何状态**：每一行都由 `capability-model.js` 从已经带出处的证据投影出来：
 *   - Extension Registry（`/api/extensions`）；
 *   - 各 feature 自己的运行观察（**复用它们的同一个观察实例**，不新建第二份）；
 *   - P20.5 的 built-in 事实（`/api/mcp`）与 P20.6 的原生状态机（`/api/mcp/servers`）。
 *
 * MCP 的 native / replaced / disabled / unknown **原样搬运**，这里不重新判断。
 *
 * ---------- 为什么不建缓存 ----------
 *
 * 观察属于「当前 workspaceGeneration / bridgeRun」；换项目、重启 pi 之后旧观察必须
 * 立刻不可见。所以这一层每次都向各 feature 要**当前**快照，自己不存一份 ——
 * 存一份就多了一个会过期的真相。
 */
import { S, ownsWorkspace } from './state.js';
import { fetchExtensions, fetchMcp, fetchMcpServers, fetchSkills, fetchApprovalCapability } from './api.js';
import { webSourceLink } from './web-activity.js';
import { buildCapabilityCatalog, catalogCounts, filterRows, setupViewModel, usageEntry } from './capability-model.js';
import { renderSetupSection } from './ui/capability-setup.js';
import { openCtxTip } from './usage.js';
import { mcpCapability } from './mcp-capabilities.js';
import { snapshotMcpObservation } from './mcp-observer.js';
/* descriptor 一律从 `*-capabilities.js` 取（那是事实层），运行观察单例从
 * feature 模块取（那是浏览器侧唯一的观察实例）。两者不能混着 import。 */
import { webCapability } from './web-capabilities.js';
import { subagentCapability } from './subagent-capabilities.js';
import { memoryCapability } from './memory-capabilities.js';
import { browserCapability } from './browser-capabilities.js';
import { approvalCapability } from './approval.js';
import { webObservation } from './web-access.js';
import { subagentObservation } from './subagents.js';
import { memoryObservation } from './memory.js';
import { browserObservation } from './browser.js';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function note(text, kind = '') {
  return el('div', 'cfg-note' + (kind ? ' ' + kind : ''), text);
}

/**
 * Usage / Quota 入口。descriptor 本体在模型层（纯投影），这里只注入打开动作 ——
 * 模型层不碰 DOM，也不需要知道 Tip 是怎么弹的。
 */
export function usageEntryRow(onOpen = openCtxTip) {
  return { ...usageEntry(), onOpen: typeof onOpen === 'function' ? onOpen : null };
}

/**
 * 把当前所有已知能力收集成 descriptor 列表。
 * **运行观察一律取自各 feature 自己的实例** —— 这样 Capability 视图与 feature 设置区
 * 看到的永远是同一份观察。
 */
export function collectKnownCapabilities({ registry = null, mcp = null, mcpNative = null, approval = null } = {}) {
  return [
    webCapability(registry, webObservation()),
    subagentCapability(registry, subagentObservation()),
    memoryCapability(registry, memoryObservation()),
    browserCapability(registry, browserObservation()),
    mcpCapability(mcp, mcpNative, mcpSnapshot()),
    approvalCapability(approval),
    usageEntryRow(),
  ];
}

/** MCP 的工具观察（同名工具聚合到 server）。取不到就交给模型按未知处理。 */
function mcpSnapshot() {
  try {
    return snapshotMcpObservation();
  } catch {
    return null;
  }
}

/**
 * Capability tab。
 *
 * @param holder   面板容器（`.ext-panel`）
 * @param isCurrent Surface 实例身份守卫
 * @param options.filterId 这一页用哪个过滤器：`all`（All）或 `capabilities`（Capabilities）
 */
export function capabilityTab(holder, isCurrent, { filterId = 'all' } = {}) {
  const wrap = el('div', 'ext-skills cap-view');
  holder.appendChild(wrap);

  const bar = el('div', 'ext-bar');
  const search = el('input', 'ext-search');
  search.type = 'search';
  search.placeholder = '搜索名称 / 用途 / 状态…';
  const refresh = el('button', 'btn tiny', '刷新');
  refresh.type = 'button';
  bar.append(search, refresh);
  wrap.appendChild(bar);

  const summary = el('div', 'ext-summary');
  const split = el('div', 'ext-split');
  const listBox = el('div', 'ext-list');
  const detailBox = el('div', 'ext-detail');
  split.append(listBox, detailBox);
  wrap.append(summary, split);

  let rows = [];
  let selectedId = '';
  let diagnostics = [];

  function visible() {
    return filterRows(rows, filterId, search.value);
  }

  function renderDetail(row) {
    detailBox.replaceChildren();
    if (!row) {
      detailBox.appendChild(el('div', 'ext-empty', filterId === 'capabilities'
        ? '选一个能力看它的安装 / 加载 / 运行观察。'
        : '选一项看详情。'));
      return;
    }
    /* 外链统一走既有的 `webSourceLink`（它自己做 http/https 与凭据校验）：
     * 这一层自己判断 URL 就是第二套边界。没有 link 时它返回 null，不画。 */
    detailBox.appendChild(renderSetupSection(setupViewModel(row), { linkFactory: webSourceLink }));
  }

  function renderList() {
    const items = visible();
    listBox.replaceChildren();
    if (!items.length) {
      listBox.appendChild(el('div', 'ext-empty', rows.length ? '没有符合筛选条件的能力' : '没有可显示的能力状态'));
      renderDetail(null);
      return;
    }
    for (const row of items) {
      const button = el('button', 'ext-item');
      button.type = 'button';
      button.setAttribute('aria-current', row.id === selectedId ? 'true' : 'false');
      button.classList.toggle('on', row.id === selectedId);
      const top = el('div', 'ext-item-top');
      top.appendChild(el('span', 'ext-dot ' + (row.status?.dot || 'dim')));
      top.appendChild(el('span', 'ext-name', row.name));
      button.appendChild(top);
      button.appendChild(el('div', 'ext-item-desc', row.purpose));
      button.appendChild(el('div', 'ext-item-note cap-status-line', row.status?.label || ''));
      button.onclick = () => {
        selectedId = row.id;
        renderList();
        renderDetail(row);
      };
      listBox.appendChild(button);
    }
    renderDetail(items.find((row) => row.id === selectedId) || null);
  }

  function renderSummary() {
    summary.replaceChildren();
    const counts = catalogCounts(rows);
    const shown = visible().length;
    const bits = [
      `共 ${counts.total} 项`,
      `已加载 ${counts.available}`,
      `未加载/不可用 ${counts.unavailable}`,
      `未知 ${counts.unknown}`,
    ];
    if (shown !== counts.total) bits.push(`当前筛选 ${shown}`);
    summary.appendChild(el('span', 'ext-sum-label', bits.join('　·　')));
    if (S.hasProject === false) {
      summary.appendChild(note('还没有选择项目 —— 只能看到用户级与 pi 自带的能力。', 'dim'));
    }
    for (const diagnostic of diagnostics) summary.appendChild(note(diagnostic.message, 'warn'));
    summary.appendChild(
      note(
        '「未知（无法确认）」不是「否」：没观察到调用不等于没有这个能力，Pi RPC 也没有权威的已注册工具清单。运行观察只说明这次 bridge run 真的见过调用。',
        'dim',
      ),
    );
  }

  async function load(isRefresh) {
    const generation = S.workspaceGeneration;
    if (isRefresh) summary.replaceChildren();
    listBox.replaceChildren(el('div', 'ext-empty', '正在读取能力状态…'));
    detailBox.replaceChildren();
    const [registry, mcp, mcpNative, skills, approval] = await Promise.all([
      fetchExtensions(), fetchMcp(), fetchMcpServers(), fetchSkills(), fetchApprovalCapability(),
    ]);
    if (!isCurrent()) return;
    if (!ownsWorkspace(generation)) {
      listBox.replaceChildren();
      const stale = el('div', 'ext-empty', '项目已切换，刷新后查看当前项目的能力状态。');
      const retry = el('button', 'btn tiny', '刷新');
      retry.type = 'button';
      retry.onclick = () => load(true);
      stale.appendChild(retry);
      listBox.appendChild(stale);
      detailBox.replaceChildren();
      return;
    }
    const catalog = buildCapabilityCatalog({
      registry, mcp, mcpNative, skills,
      features: collectKnownCapabilities({ registry, mcp, mcpNative, approval }),
    });
    rows = catalog.rows;
    diagnostics = catalog.diagnostics;
    renderSummary();
    renderList();
  }

  search.addEventListener('input', () => { renderList(); renderSummary(); });
  refresh.onclick = () => load(true);
  load(false);
}
