/* MCP 能力报告 —— 「设置 › 扩展与 MCP › MCP 配置」页底部的折叠区。
 *
 * 拆分前它是「Skills 与扩展」里的 MCP 标签。服务器的增删改、登录、刷新运行状态早已由
 * MCP 配置页（mcp-settings.js）接管，所以这里只保留那一页没有的**证据**：
 * 这个 pi 是否带原生 MCP（版本 / 判断依据 / 出处）、built-in 扩展清单、原生状态、
 * RPC 与 ExtensionAPI 事实、pi 的扩展目录与 settings 声明、本次运行的 MCP 调用观察。
 *
 * - 事实来源：`/api/mcp`（server/mcp.js），原生状态取自 MCP 配置页已读到的 `/api/mcp/servers`，
 *   不再发第二次请求。supported / builtins 读不到时是 null，一律按「未知」显示，不写成「否」。
 * - 第一次展开才读取；换项目后（扩展目录随项目变化）换成「项目已切换」提示，由用户刷新。
 * - 只列出，不安装、不启用、不执行任何扩展。 */

import { S, ownsWorkspace } from './state.js';
import { fetchMcp } from './api.js';
import { snapshotMcpObservation } from './mcp-observer.js';
import { SURFACE_COPY } from './status-copy.js';
import { resourceEl as el, resourceRow as row, resourceNote as note } from './ui/resource-dom.js';

const NATIVE_STATE_META = Object.freeze({
  active: Object.freeze({ dot: 'on', label: '原生 MCP 生效中' }),
  replaced: Object.freeze({ dot: 'warn', label: '内置 MCP 被扩展接管' }),
  disabled: Object.freeze({ dot: 'off', label: '内置 MCP 已禁用' }),
  unsupported: Object.freeze({ dot: 'dim', label: '这个 pi 不带原生 MCP' }),
  unknown: Object.freeze({ dot: 'dim', label: '原生状态未知' }),
});

function headline(dot, text) {
  const head = el('div', 'ext-mcp-head');
  head.append(el('span', 'ext-dot ' + dot), el('h4', '', text));
  return head;
}

function supportSection(box, report) {
  if (report.supported === false) box.append(headline('dim', '这个 pi 不带原生 MCP'));
  else if (report.supported === true) box.append(headline('on', '这个 pi 带 MCP 能力'));
  else box.append(headline('dim', '无法确定这个 pi 是否支持 MCP'));
  const ver = report.version || null;
  if (ver && ver.value) box.append(note(`检测到的 pi 版本：${ver.value}（来源 ${ver.source}${ver.updatedAt ? ' · ' + ver.updatedAt : ''}）`, 'dim'));
  else if (ver && ver.status === 'malformed') box.append(note('读到了 pi 包，但它的 version 字段不是一个版本号 —— 按「版本未知」处理。', 'warn'));
  else box.append(note('读不到本机 pi 包的版本 —— 按「版本未知」处理。', 'warn'));
  if (report.reason) box.append(note(report.reason, 'dim'));
  if (report.evidence) box.append(el('div', 'ext-sec-head', '出处'), el('pre', 'ext-code quote', report.evidence));
}

function builtinSection(box, report) {
  const builtins = report.builtins || {};
  box.append(el('div', 'ext-sec-head', 'built-in 能力（pi 自带）'));
  if (!builtins.known || !Array.isArray(builtins.entries)) {
    box.append(note('读不到这个 pi 包的 built-in 扩展清单 —— 按「未知」处理，不硬编码结论。', 'dim'));
    return;
  }
  if (builtins.entries.length) {
    const chips = el('div', 'ext-files');
    for (const entry of builtins.entries) {
      const chip = el('span', 'ext-file', `builtin:${entry.id}`);
      chip.title = entry.evidence || '';
      if (entry.replaceable) chip.append(el('span', 'ext-badge', '可被替换'));
      chips.append(chip);
    }
    box.append(chips);
  } else {
    box.append(note('这个 pi 包里没有列出任何 built-in 扩展。', 'dim'));
  }
  if (builtins.evidence) box.append(el('pre', 'ext-code quote', builtins.evidence));
  if (builtins.note) box.append(note(builtins.note, 'dim'));
}

function rpcSection(box, report) {
  const rpc = report.rpc || null;
  if (!rpc) return;
  box.append(el('div', 'ext-sec-head', 'RPC 事实'));
  box.append(note(rpc.commandCount === null
    ? '读不到 RPC 命令表，无法确认它有没有工具清单命令。'
    : `RpcCommand 联合共 ${rpc.commandCount} 条命令，其中没有一条返回已注册工具清单。`, rpc.toolListCommand === false ? 'dim' : 'warn'));
  if (rpc.note) box.append(note(rpc.note, 'dim'));
  const api = report.extensionApi;
  if (api && api.available) {
    box.append(note(`ExtensionAPI：registerMcpServer ${api.registerMcpServer ? '有' : '没有'} · `
      + `getMcpServers ${api.getMcpServers ? '有' : '没有'} · getAllTools ${api.getAllTools ? '有' : '没有'}`
      + '（这些是扩展进程内的 API，RPC 客户端拿不到）', 'dim'));
  }
}

function extensionRouteSection(box, report) {
  const route = report.extensionRoute || {};
  box.append(el('div', 'ext-sec-head', 'pi 的做法：扩展（extension）'));
  if (route.note) box.append(note(route.note, 'dim'));
  const dirs = el('div', 'ext-rows');
  if (route.userDir) dirs.append(row('用户级扩展目录', route.userDir));
  if (route.projectDir) dirs.append(row('项目级扩展目录', route.projectDir));
  box.append(dirs);
  for (const [label, side] of [['用户级', route.user], ['项目级', route.project]]) {
    if (!side) continue;
    const list = el('div', 'ext-list-static');
    list.append(el('div', 'ext-sec-head', `${label}（${side.exists ? side.count + ' 项' : '目录不存在'}）`));
    if (side.error) list.append(note(side.error, 'warn'));
    for (const entry of side.entries || []) {
      const line = el('div', 'ext-item static');
      line.append(el('span', 'ext-name', entry.name));
      if (entry.kind === 'dir') line.append(el('span', 'ext-badge', '目录'));
      if (typeof entry.size === 'number') line.append(el('span', 'ext-badge', `${entry.size} B`));
      list.append(line);
    }
    box.append(list);
  }
  const fromSettings = route.fromSettings || [];
  const packages = route.packages || [];
  if (fromSettings.length || packages.length) {
    const rows = el('div', 'ext-rows');
    for (const item of fromSettings) rows.append(row(`extensions（${item.scope}）`, item.value));
    for (const item of packages) rows.append(row(`packages（${item.scope}）`, item.value));
    box.append(el('div', 'ext-sec-head', '来自 settings 的声明'), rows);
  }
  box.append(note('Pi GUI 只列出这些扩展，不安装、不启用、也不执行它们 —— 扩展是能执行代码的，装什么由你在 pi 那边决定。', 'dim'));
}

function observationNote(box) {
  try {
    const seen = snapshotMcpObservation();
    box.append(note(seen.any
      ? `这次运行观察到 ${seen.count} 个 MCP 来源被调用（最近：${seen.names.join(' · ')}）。观察到只说明调用过，不构成「已配置」的证据。`
      : '这次运行尚未观察到 MCP 工具调用（没调用过≠不支持）。', 'dim'));
  } catch { /* 观察快照失败不挡住整个报告 */ }
}

function renderNative(box, native) {
  box.replaceChildren();
  if (native === null) {
    box.append(note('读不到原生 MCP 摘要，原生状态按「未知」处理。', 'warn'));
    return;
  }
  const meta = NATIVE_STATE_META[native.state] || NATIVE_STATE_META.unknown;
  box.append(headline(meta.dot, meta.label));
  if (native.reason) box.append(note(native.reason, 'dim'));
}

/**
 * @returns {{ element: HTMLDetailsElement, setNative(native): void, dispose(): void }}
 */
export function createMcpReport() {
  const details = el('details', 'mcp-report');
  const summary = el('summary', 'mcp-report-summary', 'MCP 能力报告');
  summary.dataset.focusKey = 'mcp-report'; // MCP 配置页整页重绘后按这个键把焦点还回来
  details.append(summary);
  const body = el('div', 'mcp-report-body');
  details.append(body);
  const nativeBox = el('div', 'mcp-report-native');
  let native = null;
  let loaded = false;
  let disposed = false;
  let token = 0;

  function retryState(text, label) {
    const box = el('div', 'ext-empty', text);
    const retry = el('button', 'btn tiny', label);
    retry.type = 'button';
    retry.onclick = () => { void load(); };
    box.append(retry);
    body.replaceChildren(box);
  }

  async function load() {
    const my = ++token;
    const generation = S.workspaceGeneration;
    body.replaceChildren(el('div', 'ext-empty', SURFACE_COPY.loading('MCP 能力报告')));
    const report = await fetchMcp().catch(() => null);
    if (disposed || my !== token) return;
    if (!ownsWorkspace(generation)) { loaded = false; retryState('项目已切换，刷新后查看当前项目的 MCP 能力报告。', '刷新'); return; }
    loaded = true;
    if (!report || report.ok === false) { retryState((report && report.error) || '读取 MCP 状态失败', SURFACE_COPY.retry); return; }
    body.replaceChildren();
    supportSection(body, report);
    renderNative(nativeBox, native);
    body.append(nativeBox);
    builtinSection(body, report);
    rpcSection(body, report);
    extensionRouteSection(body, report);
    observationNote(body);
  }

  const onGeneration = () => {
    if (disposed || !loaded) return;
    loaded = false;
    token += 1;
    retryState('项目已切换，刷新后查看当前项目的 MCP 能力报告。', '刷新');
  };
  const onBridgeReady = () => {
    if (disposed) return;
    // /mcp 与 /mcp/servers 独立返回；新摘要到达前不能沿用上一轮的原生状态。
    native = {};
    loaded = false;
    token += 1;
    if (details.open) void load();
    else body.replaceChildren();
  };
  details.addEventListener('toggle', () => { if (details.open && !loaded && !disposed) void load(); });
  document.addEventListener('pi-gui:workspace-generation', onGeneration);
  document.addEventListener('pi-gui:capability-bridge-ready', onBridgeReady);

  return {
    element: details,
    /** MCP 配置页每读完一次 `/api/mcp/servers` 就交给报告，原生状态与列表同源。
     *  `null` = 这一次没读到：显示「读不到原生 MCP 摘要」，不沿用上一次的结论；
     *  读到了但没有 native 对象 → 「原生状态未知」，不写成「否」。 */
    setNative(next) {
      native = next === null ? null : (next && typeof next === 'object' ? next : {});
      if (loaded) renderNative(nativeBox, native);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      token += 1;
      document.removeEventListener('pi-gui:workspace-generation', onGeneration);
      document.removeEventListener('pi-gui:capability-bridge-ready', onBridgeReady);
    },
  };
}
