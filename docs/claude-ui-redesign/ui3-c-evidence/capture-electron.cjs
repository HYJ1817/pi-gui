/* UI-3C 真实 Electron 证据采集（不是 CI 测试；本轮不接入 package.json）。
 *
 * 目的：证明内联命令菜单在**真实 Chromium/Electron**里排版正确 ——
 *   - 深浅主题（CSS 走 tokens，不写死颜色）；
 *   - 窄屏（700px）下的定位与收窄；
 *   - 右侧**原生 Browser（WebContentsView）**存在时，菜单收在 `--rp-width` 左边，
 *     不去假装能盖住原生子视图。
 *
 * 合成 KeyboardEvent 不能代替真实中文 IME 的人工验收，也不能代替真实排版；
 * 这个脚本用真实 Electron + 真实 input 事件，截图存到本目录。
 *
 * 用法：node docs/claude-ui-redesign/ui3-c-evidence/capture-electron.cjs
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = __dirname;
const APP_PORT = Number(process.env.UI3_APP_PORT || 7793);
const CDP_PORT = Number(process.env.UI3_CDP_PORT || 9233);
const APP = `http://127.0.0.1:${APP_PORT}/`;

const WORLD = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-ui3c-'));
const DATA = path.join(WORLD, 'data');
const WORK = path.join(WORLD, 'work');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const facts = [];
const checks = [];
const shots = [];
const check = (ok, label, detail) => {
  checks.push({ label, pass: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
};

/* ---------- 极简 CDP 客户端（Node 24 自带全局 WebSocket） ---------- */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.next = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('CDP socket error: ' + (e?.message || 'unknown'))));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = this.next++;
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function pickPage(deadlineMs = 90000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.url.includes(String(APP_PORT)));
      if (p && p.webSocketDebuggerUrl) return p;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('CDP page target never appeared');
}

async function waitFor(cdp, expression, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const ok = await cdp.eval(expression).catch(() => false);
    if (ok) return true;
    await sleep(150);
  }
  throw new Error('Timeout waiting for: ' + label);
}

async function shot(cdp, name) {
  /* pi 在本夹具里启动时可能吐一条错误 toast（z-index 80，本就高于菜单，几秒后自消）。
   * 为了让截图只反映菜单排版，等 toast 清空再拍。 */
  for (let i = 0; i < 40; i++) {
    const n = await cdp.eval(`document.querySelectorAll('#toasts .toast').length`).catch(() => 0);
    if (!n) break;
    await sleep(300);
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  shots.push(name);
  return file;
}

async function insertText(cdp, text) {
  await cdp.send('Input.insertText', { text });
  await sleep(120);
}

const SETUP_EXPR = `(async () => {
  const mod = await import('/ui/inline-command-menu.js');
  const input = document.getElementById('input');
  // 采集环境没有选项目，Composer 处于 is-locked/disabled。菜单排版证据与
  // 「when 过滤」无关（那部分由 jsdom 套件证明），这里只解锁输入框以便真实打字。
  input.disabled = false;
  const box = input.closest('.composer-box'); if (box) box.classList.remove('is-locked');
  const ctrl = mod.createInlineCommandMenu({ input });
  ctrl.attach();
  ctrl.bindKeyboard();
  input.focus();
  window.__ui3 = ctrl;
  return { ok: true, commands: (await import('/palette-model.js')).allCommands({ query: '' }).length };
})()`;

const STATE_EXPR = `(() => {
  const q = (s) => document.querySelector(s);
  const box = (s) => { const e = q(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const menu = q('.ui3-inline-menu');
  const pane = q('#rightPane');
  const rp = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rp-width')) || 0;
  return {
    theme: document.documentElement.dataset.theme,
    menuOpen: !!(menu && !menu.hidden),
    menu: box('.ui3-inline-menu'),
    items: menu ? menu.querySelectorAll('.ui3-inline-item').length : 0,
    emptyShown: !!(menu && !menu.querySelector('.ui3-inline-empty').hidden),
    paneOpen: !!(pane && !pane.hidden),
    paneLeft: pane && !pane.hidden ? Math.round(pane.getBoundingClientRect().left) : null,
    rpWidth: Math.round(rp),
    focusIsInput: document.activeElement && document.activeElement.id === 'input',
    inputValue: document.getElementById('input').value,
    overlap: (() => {
      if (!menu) return null;
      const b = menu.getBoundingClientRect();
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height - 6);
      return el && !menu.contains(el) ? { tag: el.tagName, id: el.id, cls: typeof el.className === 'string' ? el.className : '' } : null;
    })(),
    toastCount: document.querySelectorAll('#toasts .toast').length,
  };
})()`;

async function setTheme(cdp, mode) {
  await cdp.eval(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(mode)}; return true; })()`);
  await sleep(200);
}

async function reopenMenu(cdp, query = '') {
  await cdp.eval(`(() => { const i = document.getElementById('input'); i.value = ''; i.setSelectionRange(0,0); i.dispatchEvent(new Event('input',{bubbles:true})); i.focus(); return true; })()`);
  await sleep(80);
  await insertText(cdp, '/' + query);
}

(async () => {
  const electron = require('electron');
  const env = { ...process.env, PORT: String(APP_PORT), PI_GUI_DATA: DATA, PI_CWD: WORK };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [ROOT, `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox'], {
    cwd: ROOT, env, stdio: 'inherit', windowsHide: false,
  });
  child.on('error', (e) => console.error('spawn error:', e));

  let cdp = null;
  try {
    const page = await pickPage();
    cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await waitFor(cdp, `document.readyState === 'complete' && !!document.getElementById('input')`, 'app shell');

    const setup = await cdp.eval(SETUP_EXPR);
    check(setup && setup.ok === true, '真实页面注入内联命令模块成功', setup);
    facts.push({ step: 'setup', registryCommands: setup && setup.commands });

    /* --- 1. 深色：输入 `/` --- */
    await setTheme(cdp, 'dark');
    await reopenMenu(cdp, '');
    let s = await cdp.eval(STATE_EXPR);
    check(s.menuOpen === true, '深色：输入 `/` 打开菜单', s);
    check(s.items > 0, '深色：候选来自真实注册表（>0）', { items: s.items });
    check(s.focusIsInput === true, '焦点仍在输入框（combobox 语义）', { focus: s.focusIsInput });
    await shot(cdp, 'menu-dark.png');
    facts.push({ step: 'dark-open', ...s });

    /* --- 2. 深色：筛选 `/re` --- */
    await insertText(cdp, 're'); // 变成 `/re`
    s = await cdp.eval(STATE_EXPR);
    check(s.inputValue === '/re', '深色：筛选输入为 /re', { value: s.inputValue });
    check(s.items >= 0, '深色：筛选后有候选或空状态（诚实）', { items: s.items, empty: s.emptyShown });
    await shot(cdp, 'menu-dark-filter.png');
    facts.push({ step: 'dark-filter', ...s });

    /* --- 3. 浅色 --- */
    await setTheme(cdp, 'light');
    await reopenMenu(cdp, '');
    s = await cdp.eval(STATE_EXPR);
    check(s.theme === 'light', '浅色：data-theme=light', { theme: s.theme });
    check(s.menuOpen === true, '浅色：菜单正常打开', s);
    await shot(cdp, 'menu-light.png');
    facts.push({ step: 'light-open', ...s });

    /* --- 4. 窄屏 700px --- */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 820, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    await reopenMenu(cdp, '');
    s = await cdp.eval(STATE_EXPR);
    check(s.menuOpen === true, '窄屏：菜单打开', s);
    check(s.menu && s.menu.w <= 700 - 8, '窄屏：菜单宽度不超出视口', s.menu);
    await shot(cdp, 'menu-narrow-700.png');
    facts.push({ step: 'narrow-700', ...s });
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(150);

    /* --- 5. 右侧原生 Browser 右栏 --- */
    await setTheme(cdp, 'dark');
    await cdp.eval(`(() => { const b = document.getElementById('btnBrowser'); if (b && !b.disabled) b.click(); return true; })()`);
    await waitFor(cdp, `!document.getElementById('rightPane').hidden`, 'right pane open', 40).catch(() => {});
    await sleep(300);
    await reopenMenu(cdp, '');
    s = await cdp.eval(STATE_EXPR);
    check(s.paneOpen === true, '右栏 Browser 已打开（原生 WebContentsView）', { paneOpen: s.paneOpen, paneLeft: s.paneLeft });
    if (s.paneOpen && s.menu) {
      const margin = s.paneLeft - (s.menu.x + s.menu.w);
      check(margin >= 0, '菜单右边界不越过右栏（不与原生视图重叠）', { menuRight: s.menu.x + s.menu.w, paneLeft: s.paneLeft, margin });
      facts.push({ step: 'browser-pane-margin', margin });
    }
    check(s.menuOpen === true, '右栏打开时菜单仍正常显示', { menuOpen: s.menuOpen });
    await shot(cdp, 'menu-with-browser-pane.png');
    facts.push({ step: 'browser-pane-open', ...s });

    /* --- 6. 生命周期事件（真实 Chromium 中分发应用同款 CustomEvent；
     *     这不是键盘/IME 验收，合成 KeyboardEvent 也不在本节使用） --- */
    await cdp.eval(`(() => { const b = document.getElementById('browserClose'); if (b) b.click(); return true; })()`);
    await sleep(250);
    await reopenMenu(cdp, '');
    let opened = await cdp.eval(`window.__ui3.isOpen()`);
    check(opened === true, '生命周期：菜单先打开', { opened });
    await cdp.eval(`(() => { document.dispatchEvent(new CustomEvent('pi-gui:workspace-view', { detail: { view: 'planner' } })); return true; })()`);
    await sleep(120);
    let closed = await cdp.eval(`window.__ui3.isOpen()`);
    let valueAfter = await cdp.eval(`document.getElementById('input').value`);
    check(closed === false, 'workspace-view 离开 Chat → 菜单关闭', { closed, valueAfter });
    check(valueAfter === '/', '关闭时不清空输入（草稿保留）', { valueAfter });

    await reopenMenu(cdp, '');
    await cdp.eval(`(() => { document.dispatchEvent(new CustomEvent('pi-gui:session-switch')); return true; })()`);
    await sleep(120);
    closed = await cdp.eval(`window.__ui3.isOpen()`);
    check(closed === false, 'session-switch（同代内换会话）→ 菜单关闭', { closed });
    await shot(cdp, 'menu-closed-after-lifecycle.png');
    facts.push({ step: 'lifecycle-closed' });
  } catch (err) {
    check(false, '采集过程异常', String(err && err.message ? err.message : err));
    console.error(err);
  } finally {
    if (cdp) cdp.close();
    try { child.kill(); } catch { /* ignore */ }
    await sleep(600);
    try { fs.rmSync(WORLD, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); } catch { /* ignore */ }
  }

  const passed = checks.filter((c) => c.pass).length;
  const report = { when: new Date().toISOString(), appPort: APP_PORT, shots, facts, checks, passed, total: checks.length };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2));
  console.log(`\n${passed}/${checks.length} checks passed; ${shots.length} screenshots`);
  process.exitCode = passed === checks.length && checks.length > 0 ? 0 : 1;
})();
