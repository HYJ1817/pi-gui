/* Fire-and-forget extension status, scoped to the current Pi run. No disk copy
 * and no inferred extension identity: Pi notify does not provide a source. */
import { S } from './state.js';
import { toast } from './ui/toast.js';
import { logRendererEvent } from './log-client.js';

let scope = '';
let notices = [];
function current() {
  const next = JSON.stringify([S.workspaceGeneration, S.bridgeRun]);
  if (scope !== next) { scope = next; notices = []; }
  return notices;
}

export function extensionNotices() {
  return current().map(item => ({ ...item }));
}

export function handleExtensionNotification(event) {
  if (event?._replay || S.switching || (Number.isInteger(event?.bridgeRun) && event.bridgeRun !== S.bridgeRun)) return;
  if (typeof event?.message !== 'string' || !event.message.trim()) return;
  const kind = event.notifyType === 'error' ? 'error' : event.notifyType === 'warning' ? 'warning' : 'info';
  // Recognize only the reported dependency failure, not arbitrary qmd mentions.
  const memoryDependency = /\bmemory(?:_search)?\b[^\n]{0,80}\brequires?\s+qmd\b/i.test(event.message);
  const text = event.message.slice(0, 4000);
  const list = current();
  const existing = list.find(item => item.kind === kind && item.text === text);
  if (existing) existing.count++;
  else {
    list.push({ kind, text, count: 1, feature: memoryDependency ? 'memory' : null });
    if (list.length > 30) list.shift();
  }
  logRendererEvent(kind === 'error' ? 'ui.notification_error' : 'ui.notification', { kind });
  document.dispatchEvent(new window.Event('pi-gui:extension-notices'));
  // Optional dependency and ordinary extension status belong in settings.
  // Unclassified errors remain visible: their severity must not be guessed away.
  if (kind === 'error' && !memoryDependency) return toast(text, 'error');
  return null;
}

export function renderExtensionNotices(host, { feature = null } = {}) {
  host.replaceChildren();
  const list = extensionNotices().filter(item => feature === null || item.feature === feature);
  host.hidden = !list.length;
  if (!list.length) return;
  const title = document.createElement('div');
  title.className = 'ext-sec-head';
  title.textContent = feature === 'memory' ? '本次运行的 Memory 提示' : '本次运行的扩展提示（未提供来源的提示不归属到具体扩展）';
  host.append(title);
  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'extension-notice';
    row.dataset.kind = item.kind;
    row.textContent = item.text + (item.count > 1 ? `（重复 ${item.count} 次）` : '');
    host.append(row);
  }
}
