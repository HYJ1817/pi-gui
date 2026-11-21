import { fetchSystemStorage } from './api.js';
import { confirmModal } from './ui/modal.js';
import { createSettingsCard, createSettingsRow, createSettingsToggle, createSegmentedControl } from './ui/primitives.js';
import { createSystemNetworkCard } from './system-settings-network.js';
import { createSystemStorageControl, createCacheBreakdown } from './system-settings-storage.js';

const PRESERVED = '聊天记录、设置、凭据、附件、模型和插件数据均会保留。';
const SOURCE_LABELS = {
  'electron-user-data': 'Electron 默认用户数据目录',
  environment: '由 PI_GUI_DATA 指定',
  managed: '由固定启动引导配置管理',
  'resolver-default': '应用默认目录',
};

function node(tag, text = '', className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(label, className = 'btn', run, disabled = false) {
  const element = node('button', label, className);
  element.type = 'button';
  element.disabled = disabled;
  if (run) element.onclick = run;
  return element;
}

function status(id) {
  const element = node('p', '', 'system-status');
  element.id = id;
  element.setAttribute('role', 'status');
  return element;
}

function message(element, text, tone) {
  element.textContent = text;
  element.classList.toggle('is-error', tone === 'error');
}

function sizeText(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '大小未知';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0;
  while (unit < units.length - 1 && bytes >= 1024) { bytes /= 1024; unit++; }
  return `${bytes.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function directoryValue(initial) {
  const path = node('code', initial, 'system-path');
  const source = node('span');
  const detail = node('div', '', 'system-path-detail');
  detail.setAttribute('role', 'status');
  detail.append(path, source);
  return { detail, update(value, origin = '') { path.textContent = value; source.textContent = origin; } };
}

function storageCard({ desktop, call, current, fetchStorage }) {
  const data = directoryValue('正在读取…');
  const browser = directoryValue(desktop ? '正在读取…' : '当前为网页版，无 Electron 浏览器数据目录。');
  const agent = directoryValue('正在读取…');
  const cacheSize = node('span', desktop ? '正在统计…' : '仅桌面版可统计和清理。');
  cacheSize.id = 'system-cache-size';
  cacheSize.setAttribute('role', 'status');
  const feedback = status('system-cache-feedback');
  const migration = createSystemStorageControl({ desktop, call, current, sizeText });
  const breakdown = createCacheBreakdown(sizeText);
  let supported = false, busy = false, bytes = null, cleanable = false;
  const refreshButton = button('重新统计', 'btn ghost', refresh, true);
  const clearButton = button('清理缓存…', 'btn danger ghost', clear, true);
  clearButton.setAttribute('aria-describedby', `${cacheSize.id} ${feedback.id}`);
  const actions = node('div', '', 'system-actions');
  actions.id = 'system-cache-actions';
  actions.append(refreshButton, clearButton);
  function paint() {
    refreshButton.disabled = busy || !supported;
    clearButton.disabled = busy || !supported || !cleanable;
  }
  function renderSize(result) {
    bytes = Number.isSafeInteger(result?.bytes) && result.bytes >= 0 ? result.bytes : null;
    cleanable = bytes > 0 || result?.ok === true && result?.buckets?.some(bucket => bucket.cacheBytes > 0);
    cacheSize.textContent = result?.scope === 'system-cache-p2'
      ? `磁盘 ${sizeText(result.diskBytes)} · 内存 ${sizeText(result.memoryBytes)}` : sizeText(bytes);
    breakdown.update(result);
  }
  async function measure() {
    const result = await call('measureCache');
    if (current()) renderSize(result);
    return result;
  }
  async function refresh() {
    if (!supported || busy) return;
    busy = true;
    const hadFocus = document.activeElement === refreshButton;
    paint();
    message(feedback, '正在统计…');
    const result = await measure();
    if (!current()) return;
    busy = false;
    paint();
    if (hadFocus && document.activeElement === document.body) refreshButton.focus();
    message(feedback, result.ok ? '' : result.error || '缓存统计失败，请重试。', result.ok ? '' : 'error');
  }
  async function clear() {
    if (!supported || busy || !cleanable) return;
    // Re-read immediately before asking for consent. The main-process ticket
    // expires and can only clear this fixed bucket once.
    busy = true;
    paint();
    message(feedback, '正在统计…');
    try {
      const preview = await measure();
      if (!current()) return;
      if (!preview.ok || !preview.ticket) {
        message(feedback, preview.error || '缓存统计失败，请重试。', 'error');
        return;
      }
      if (preview.status === 'empty' || preview.bytes === 0 && !preview.buckets?.some(bucket => bucket.cacheBytes > 0)) { message(feedback, '当前没有可清理缓存。'); return; }
      // Don't overwrite another confirmation opened while measurement awaited.
      if (document.getElementById('confirmLayer')?.hidden === false) {
        message(feedback, '请先处理当前确认，再重试清理。');
        return;
      }
      message(feedback, '');
      let result;
      await confirmModal({ title: '清理缓存？', danger: true, okText: '清理缓存',
        message: preview.scope === 'system-cache-p2'
          ? `预计清理磁盘 ${sizeText(preview.diskBytes)}、内存 ${sizeText(preview.memoryBytes)} 的已验证缓存。容量可能在运行时再生，磁盘释放以清理后实测为准。${PRESERVED}`
          : `预计清理 ${sizeText(preview.bytes)} 内置浏览器 HTTP 内存缓存。${PRESERVED}`,
        onDecide: async decision => {
          if (decision === true && current()) result = await call('clearCache', preview.ticket);
          // The ticket is one-shot; results belong beside the cache row, not
          // in a confirmation that would allow resubmitting the same ticket.
          return true;
        }, submittingText: '正在清理…',
      });
      if (!current() || !result) return;
      renderSize(result);
      if (result.status === 'cleared') message(feedback, result.scope === 'system-cache-p2'
        ? result.diskReleaseConfirmed ? `缓存已清理。实测磁盘文件占用减少 ${sizeText(result.releasedDiskBytes)}。`
          : '缓存已清理；未确认磁盘占用下降，不宣称释放磁盘空间。' : '缓存已清理。');
      else if (result.status === 'empty') message(feedback, '当前没有可清理缓存。');
      else if (result.status === 'partial') message(feedback, `清理未完全确认。${result.diskReleaseConfirmed ? `实测磁盘文件占用减少 ${sizeText(result.releasedDiskBytes)}。` : ''}${result.error || ''}`, 'error');
      else message(feedback, result.error || '清理缓存失败，请重试。', 'error');
    } finally {
      if (current()) {
        busy = false;
        paint();
        // The confirmation layer restores its previous focus asynchronously;
        // an empty cache can disable its original trigger.
        if (document.activeElement === document.body) (clearButton.disabled ? refreshButton : clearButton).focus();
      }
    }
  }
  const card = createSettingsCard({ title: '存储', children: [
    createSettingsRow({ label: '数据保存路径', detail: data.detail,
      control: migration.change, help: '原生选择空目录，停写重启后白名单复制并逐文件校验；旧目录保留。受路径授权、工作树或回退证据绑定的数据会拒绝迁移。' }),
    migration.feedback,
    createSettingsRow({ label: '可清理缓存', detail: cacheSize, control: actions,
      help: '仅清理已验证的主窗口 HTTP / Code Cache 与内置及 Runtime 浏览器 HTTP 内存缓存。不清除 Cookie 或登录状态；磁盘释放仅按实测下降报告。' }),
    breakdown.detail, feedback,
    createSettingsRow({ label: 'Electron 浏览器数据目录', detail: browser.detail }),
    createSettingsRow({ label: 'Pi Agent 配置目录', detail: agent.detail, help: '由 Pi 管理，不属于可清理缓存。' }),
    createSettingsRow({ label: '用户项目目录', detail: '由各工作区管理，不在此处读取、迁移或清理。' }),
  ] });
  async function loadPaths() {
    const result = await fetchStorage().catch(() => ({ ok: false }));
    if (!current()) return;
    const storage = result.ok ? result.storage : null;
    const available = typeof storage?.dataDirectory === 'string' && storage.dataDirectory;
    data.update(available || '无法读取数据目录。', available ? SOURCE_LABELS[storage.source] || '' : '');
    agent.update(storage?.piAgentDirectory || '无法读取 Pi Agent 目录。', storage?.piAgentDirectory
      ? (storage.piAgentSource === 'environment' ? '由 PI_CODING_AGENT_DIR 指定' : 'Pi 默认目录') : '');
  }
  function adoptDesktop(snapshot) {
    if (!desktop) return;
    browser.update(snapshot?.browserDirectory || '无法读取 Electron 浏览器数据目录。',
      snapshot?.browserDirectory ? '主窗口 Session · 由 Electron 管理' : '');
    migration.adopt(snapshot?.storage);
    supported = snapshot?.capabilities?.cache === true;
    if (supported) void refresh();
    else { cacheSize.textContent = '当前环境不支持缓存管理。'; paint(); }
  }
  return { card, loadPaths, adoptDesktop };
}

function desktopCards({ desktop, call, current }) {
  let snapshot = null, busy = false;
  const feedback = status('system-preference-feedback');
  const powerReason = status('system-power-reason');
  const trayReason = status('system-tray-reason');
  const labels = { keepAwake: '保持电脑唤醒', preventDisplaySleep: '阻止屏幕休眠' };
  const switches = Object.fromEntries(Object.entries(labels).map(([key, ariaLabel]) => [key,
    createSettingsToggle({ disabled: true, ariaLabel, onChange: value => save(key, value) })]));
  const behavior = createSegmentedControl({ ariaLabel: '关闭主窗口时', options: [
    { value: 'tray', label: '关闭到托盘', disabled: true },
    { value: 'quit', label: '退出应用', disabled: true },
  ], onChange: value => save('closeBehavior', value) });
  const quit = button('退出应用…', 'btn', requestQuit, true);
  const quitFeedback = status('system-quit-feedback');
  quit.setAttribute('aria-describedby', quitFeedback.id);
  function paint() {
    const writable = !busy && snapshot && snapshot.persistence !== 'unavailable';
    for (const [key, toggle] of Object.entries(switches)) {
      const value = snapshot?.effective[key];
      toggle.setChecked(value === true);
      toggle.setDisabled(!writable || snapshot.capabilities.power !== true || value === null);
      toggle.element.setAttribute('aria-describedby', `${powerReason.id} ${feedback.id}`);
    }
    behavior.setValue(snapshot?.effective.closeBehavior ?? '');
    behavior.setDisabled(!writable || snapshot.capabilities.tray !== true);
    quit.disabled = busy || !snapshot;
  }
  async function save(key, value) {
    if (busy || !snapshot) return;
    const focused = document.activeElement;
    busy = true;
    paint(); // Unconfirmed edits do not appear effective, even while saving.
    message(feedback, '正在保存系统设置…');
    const result = await call('set', key, value);
    if (!current()) return;
    // The main process may have committed even if the reply was interrupted.
    const next = result.snapshot || (await call('state')).snapshot;
    if (!current()) return;
    snapshot = next || null;
    busy = false;
    paint();
    const uncertain = '未能确认设置是否已保存，请重新打开此页。';
    const text = result.ok ? ['已保存。', next?.error].filter(Boolean).join(' ')
      : result.snapshot?.error || [uncertain, next?.error].filter(Boolean).join(' ');
    message(feedback, text, next?.error || !result.ok ? 'error' : '');
    if (focused?.isConnected && !focused.disabled && document.activeElement === document.body) focused.focus();
  }
  async function requestQuit() {
    if (!snapshot || quit.disabled || document.getElementById('confirmLayer')?.hidden === false) return;
    // app.quit remains subject to the existing update/maintenance gates.
    await confirmModal({ title: '退出 pi-GUI？', okText: '退出应用',
      message: '退出会结束本机服务及应用内正在运行的任务。要让任务继续运行，请取消并使用关闭到托盘。',
      onDecide: async decision => {
        if (decision !== true || !current()) return true;
        const result = await call('quit');
        if (current()) message(quitFeedback, result.ok ? '已请求退出，正在检查应用状态。' : '无法请求退出，请使用应用退出快捷键。', result.ok ? '' : 'error');
        return true;
      },
    });
  }
  const power = createSettingsCard({ title: '电源', children: [
    createSettingsRow({ label: labels.keepAwake, control: switches.keepAwake,
      detail: '运行期间阻止电脑自动休眠，仍允许屏幕关闭。' }),
    createSettingsRow({ label: labels.preventDisplaySleep, control: switches.preventDisplaySleep,
      detail: '运行期间阻止屏幕自动休眠。', help: '不会拦截主动休眠、关机或合上笔记本盖子。' }),
    powerReason,
  ] });
  const close = createSettingsCard({ title: '关闭行为', children: [
    createSettingsRow({ label: '关闭主窗口时', detail: '关闭到托盘会保留窗口、任务和待处理的审批。', control: behavior }),
    trayReason,
    createSettingsRow({ label: '真正退出', control: quit }),
    quitFeedback,
  ] });
  function adopt(result) {
    snapshot = result.ok ? result.snapshot : null;
    const unavailable = desktop ? '当前环境不支持此设置。' : '仅桌面版可用。';
    message(powerReason, snapshot?.capabilities.power === true
      ? Object.values(snapshot.effective).includes(null) ? '部分电源状态无法确认。' : ''
      : unavailable);
    message(trayReason, snapshot?.capabilities.tray === true ? '' : unavailable);
    paint();
    message(feedback, snapshot?.error || (desktop && !snapshot ? '无法读取桌面系统设置，请重新打开此页。' : ''), 'error');
  }
  return { power, close, feedback, adopt };
}

export function openSystemSettings({ present, fetchStorage = fetchSystemStorage } = {}) {
  let active = true;
  const current = () => active;
  const desktop = window.piGuiDesktop;
  const bridge = desktop?.systemSettings;
  const call = async (operation, ...args) => {
    try { return await bridge?.[operation](...args) || { ok: false }; }
    catch { return { ok: false }; }
  };
  return present(card => {
    // Match the shared detail layout, without the old bare h3/30px override.
    const head = node('header', '', 'system-heading');
    head.append(node('h2', '系统'), node('p', '网络、存储、电源，以及本机的窗口行为。'));
    const storage = storageCard({ desktop, call, current, fetchStorage });
    const settings = desktopCards({ desktop, call, current });
    const network = createSystemNetworkCard({ desktop, call, current });
    card.append(head, network.card, storage.card, settings.power, settings.close, settings.feedback);
    void storage.loadPaths();
    void call('state').then(result => {
      if (!current()) return;
      settings.adopt(result);
      network.adopt(result.ok ? result.snapshot : null);
      storage.adoptDesktop(result.ok ? result.snapshot : null);
    });
  }, () => { active = false; }, { className: 'system-settings-card' });
}
