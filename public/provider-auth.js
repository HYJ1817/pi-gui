/* Pi owns credentials and the flow. This view only consumes safe snapshots. */
import { fetchProviderAuth, loginProviderAuth, logoutProviderAuth, respondProviderAuth, cancelProviderAuth, syncProviderAuth } from './api.js';

const terminal = new Set(['success', 'cancelled', 'failed']);
const states = { starting: '开始认证…', 'waiting-browser': '等待浏览器授权', 'waiting-device-code': '在浏览器中输入设备码', 'waiting-input': '等待授权回复', verifying: '正在确认认证状态…', success: '认证操作完成', cancelled: '认证已取消', failed: '认证失败或超时' };

export function safeAuthUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    for (const key of url.searchParams.keys()) {
      if (/(?:token|secret|password|api[_-]?key|credential|^code$)/i.test(key)) return null;
    }
    if (/(?:sk-[a-z0-9]{12}|bearer%?20)/i.test(url.href)) return null;
    return url.href;
  } catch { return null; }
}

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function mountProviderAuth(box, onReadback = () => {}) {
  let disposed = false;
  let request = 0;
  let timer = null;
  let snapshot = null;
  let renderKey = '';
  let busy = false;
  let readbackFlow = '';
  const message = node('div', 'auth-message');
  const content = node('div', 'auth-content');
  box.append(content, message);

  function button(parent, label, action) {
    const b = node('button', 'btn tiny', label);
    b.type = 'button';
    b.disabled = busy;
    b.onclick = action;
    parent.appendChild(b);
    return b;
  }
  function stopTimer() { if (timer !== null) clearTimeout(timer); timer = null; }
  function schedule() {
    stopTimer();
    if (disposed || !box.isConnected) return;
    if ((snapshot?.flow && !terminal.has(snapshot.flow.state)) || ['pending', 'syncing'].includes(snapshot?.sync?.state)) {
      timer = setTimeout(() => { timer = null; refresh(); }, 1000);
    }
  }
  function apply(j, token) {
    if (disposed || token !== request) return;
    if (!j || j.ok === false) {
      message.textContent = '无法更新认证状态，请重试。';
      schedule();
      return;
    }
    if (snapshot?.flow && j.flow?.id === snapshot.flow.id && j.flow.revision < snapshot.flow.revision) { schedule(); return; }
    snapshot = j;
    message.textContent = '';
    render();
    if (j.flow && terminal.has(j.flow.state) && readbackFlow !== j.flow.id) {
      readbackFlow = j.flow.id;
      onReadback();
      // Confirm server readback, never assign Composer models optimistically.
      refresh();
    } else schedule();
  }
  async function refresh() {
    if (disposed) return;
    const token = ++request;
    apply(await fetchProviderAuth(), token);
  }
  async function act(operation) {
    if (disposed || busy) return;
    busy = true;
    stopTimer();
    const buttons = [...content.querySelectorAll('button')].map((b) => [b, b.disabled]);
    buttons.forEach(([b]) => { b.disabled = true; });
    const token = ++request;
    const j = await operation();
    busy = false;
    if (disposed || token !== request) return;
    buttons.forEach(([b, disabled]) => { b.disabled = disabled; });
    apply(j, token);
  }
  function fallback(parent, id) {
    const help = node('div', 'auth-help', 'API Key 请在官方 Pi 交互终端配置；先运行 pi，再输入：');
    help.appendChild(node('code', '', `/login ${id}`));
    help.appendChild(node('span', '', '退出并移除已存凭据：'));
    help.appendChild(node('code', '', '/logout'));
    parent.appendChild(help);
  }
  function render() {
    // Exact same safe revision must preserve the prompt draft and focus.
    const key = JSON.stringify(snapshot);
    if (key === renderKey) return;
    const oldInput = content.querySelector('[data-auth-prompt]');
    const oldPrompt = oldInput?.dataset.authPrompt;
    const oldValue = oldInput?.value;
    const hadFocus = oldInput === document.activeElement;
    renderKey = key;
    content.replaceChildren();
    content.appendChild(node('div', 'hint', '状态来自本机 Pi；已存凭据不代表远端凭据仍有效。退出会移除已存凭据，环境变量认证可能仍然有效。'));
    button(content, '刷新认证状态', refresh);
    if (!snapshot.capability?.sdkAvailable) content.appendChild(node('div', 'auth-notice', '当前 Pi 未提供可用认证接口。请使用官方交互式 pi 的 /login 与 /logout。'));
    for (const p of snapshot.providers || []) {
      const row = node('section', 'auth-provider');
      row.dataset.providerId = p.providerId;
      const oauth = (p.methods || []).some((m) => m.type === 'oauth');
      row.appendChild(node('strong', '', p.providerId === 'openai' && oauth ? 'ChatGPT' : p.displayName || p.providerId));
      const configured = p.authType !== 'oauth' && p.authConfigured === true;
      row.appendChild(node('span', 'auth-status', configured ? '已配置（远端有效性未知）' : ({ connected: '已连接（本机凭据）', disconnected: '未连接', unknown: '未知（无法确认）', error: '状态读取失败' })[p.status] || '未知（无法确认）'));
      row.appendChild(node('div', 'hint', `来源：${p.source || 'unknown'} · 模型：${p.models?.length || 0}`));
      const methods = node('div', 'auth-actions');
      for (const m of p.methods || []) {
        methods.appendChild(node('span', 'auth-method', p.providerId === 'openai' && m.type === 'oauth' ? 'ChatGPT 订阅' : m.label || m.type));
        if (m.type === 'oauth' && m.canLogin && p.canLogin && snapshot.capability?.sdkAvailable) {
          const login = button(methods, '登录', () => act(() => loginProviderAuth(p.providerId)));
          login.dataset.authLogin = p.providerId;
          login.disabled = busy || Boolean(snapshot.flow && !terminal.has(snapshot.flow.state));
        }
      }
      if (p.canLogout && snapshot.capability?.sdkAvailable) {
        const logout = button(methods, '移除已存凭据', () => act(() => logoutProviderAuth(p.providerId)));
        logout.disabled = busy || Boolean(snapshot.flow && !terminal.has(snapshot.flow.state));
      }
      row.appendChild(methods);
      if (!snapshot.capability?.sdkAvailable || !(p.methods || []).length || (p.methods || []).some((m) => m.type === 'api-key')) fallback(row, p.providerId);
      content.appendChild(row);
    }
    if (!snapshot.providers?.length) fallback(content, '<provider>');
    const flow = snapshot.flow;
    if (flow) {
      const panel = node('section', 'auth-flow');
      panel.setAttribute('aria-live', 'polite');
      panel.appendChild(node('strong', '', states[flow.state] || '等待认证状态'));
      if (flow.notice) panel.appendChild(node('div', 'hint', flow.notice));
      const url = safeAuthUrl(flow.url);
      if (url) {
        const link = node('a', 'auth-link', '打开授权页面');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.onclick = async (e) => {
          if (!window.piGuiDesktop?.isDesktop) return;
          e.preventDefault();
          try {
            const result = await window.piGuiDesktop.openWebUrl?.(url);
            message.textContent = result?.ok ? '已请求系统浏览器打开授权页面。' : '打开失败，请复制授权链接到浏览器。';
          } catch { message.textContent = '打开失败，请复制授权链接到浏览器。'; }
        };
        panel.appendChild(link);
      } else if (flow.url) panel.appendChild(node('div', 'hint', '授权链接未通过安全检查，请改用官方 Pi 登录。'));
      if (flow.userCode) panel.appendChild(node('code', 'auth-device-code', flow.userCode));
      if (flow.prompt && !terminal.has(flow.state)) {
        const prompt = flow.prompt;
        const form = node('form', 'auth-prompt');
        const label = node('label', '', prompt.type === 'select' ? '选择认证方法' : '授权回复');
        const input = node(prompt.type === 'select' ? 'select' : 'input');
        input.dataset.authPrompt = `${flow.id}:${prompt.id}`;
        input.id = 'provider-auth-reply'; label.htmlFor = input.id;
        if (prompt.type === 'select') for (const o of prompt.options || []) { const option = node('option', '', o.label); option.value = o.id; input.appendChild(option); }
        else { input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; }
        if (oldPrompt === input.dataset.authPrompt) input.value = oldValue;
        form.append(label, input);
        button(form, '提交授权回复', () => form.requestSubmit());
        form.onsubmit = (e) => { e.preventDefault(); const value = input.value; if (!value.trim()) return; act(() => respondProviderAuth(flow.id, prompt.id, value)); };
        panel.appendChild(form);
      }
      if (!terminal.has(flow.state)) button(panel, '取消认证', () => act(() => cancelProviderAuth(flow.id)));
      panel.appendChild(node('div', 'hint', '关闭面板不会取消认证；再次打开可继续。'));
      // Authorization must remain reachable above a potentially large native
      // provider catalog. Restore focus only after inserting the new input.
      content.insertBefore(panel, content.querySelector('.auth-provider'));
      const restoredInput = panel.querySelector('[data-auth-prompt]');
      if (hadFocus && oldPrompt === restoredInput?.dataset.authPrompt) restoredInput.focus();
    }
    if (['pending', 'syncing', 'error'].includes(snapshot.sync?.state)) {
      const syncText = snapshot.sync.state === 'syncing' ? '正在同步聊天 Pi…' : snapshot.sync.state === 'error' ? '模型同步失败，请重试同步。' : '模型同步待完成；当前任务结束后更新。';
      const sync = node('div', 'auth-notice', syncText);
      if (snapshot.sync.state !== 'syncing') button(sync, '重试模型同步', () => act(syncProviderAuth));
      content.insertBefore(sync, content.querySelector('.auth-provider'));
    }
  }
  content.appendChild(node('h4', '', '供应商与认证'));
  button(content, '刷新认证状态', refresh);
  refresh();
  return () => { disposed = true; ++request; stopTimer(); };
}
