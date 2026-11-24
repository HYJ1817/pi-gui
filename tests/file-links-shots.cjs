/* 会话内文件引用的真实 Chromium 验收。
 *
 * 使用真实 public/ 页面、真实 runtime-conversation / files-panel / file-links-ui，
 * 后端是 server/files.js 的真实 createFiles，文件来自 os.tmpdir() 两个工作区。
 * 不用静态 HTML，不手工拼截图。产物写入 .shots/file-links/（可再生）。 */
'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const out = path.resolve(process.env.FILE_LINKS_SHOTS || '.shots/file-links');
const chromePath = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((file) => fs.existsSync(file));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(get, name, attempts = 140) {
  for (let n = 0; n < attempts; n++) {
    const result = await Promise.resolve().then(get).catch(() => null);
    if (result) return result;
    await wait(100);
  }
  throw Error(name);
}

async function main() {
  assert.ok(chromePath, 'set CHROME_PATH to a locally installed Chromium');
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-file-links-chrome-'));
  const harness = spawn(process.execPath, [path.join(__dirname, 'visual-harness.cjs')], {
    env: { ...process.env, HARNESS_PORT: '0', FILE_LINKS_HARNESS: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  let url, chrome, ws;
  harness.stdout.on('data', (chunk) => { url ||= String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]; });
  const result = { startedAt: new Date().toISOString(), shots: [], checks: [] };
  const check = (name, value, detail = null) => {
    if (!value) console.error('  FAIL ' + name + '  ' + JSON.stringify(detail));
    assert.ok(value, name);
    result.checks.push({ name, detail });
    console.log('  ok  ' + name + (detail ? '  ' + JSON.stringify(detail) : ''));
  };

  try {
    await until(() => url, 'offline file-links fixture did not start');
    chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-background-networking',
      '--disable-component-update', '--disable-default-apps', '--no-first-run', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { stdio: 'ignore', windowsHide: true });

    const target = await until(async () => {
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
      const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      return pages.find((page) => page.type === 'page')?.webSocketDebuggerUrl;
    }, 'Chromium DevTools did not start');

    ws = new WebSocket(target);
    await once(ws, 'open');
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      callback(message);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      pending.set(++id, (message) => message.error ? reject(Error(message.error.message)) : resolve(message.result));
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const { result: value, exceptionDetails } = await send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true });
      if (exceptionDetails) throw Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return value.value;
    };
    const shot = async (name) => {
      const image = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
      result.shots.push(path.join(out, name + '.png'));
      console.log('  shot ' + name + '.png');
    };
    const metrics = (width, height) => send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false });
    const pointOf = (selector) => evaluate('(() => { const e = document.querySelector(' + JSON.stringify(selector) + ');'
      + 'if (!e) throw Error("missing " + ' + JSON.stringify(selector) + ');'
      + 'const r = e.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 90), y: r.y + r.height / 2 }; })()');
    const move = async (selector) => {
      const point = await pointOf(selector);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      return point;
    };
    const click = async (selector, clickCount = 1) => {
      const point = await pointOf(selector);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount });
      await wait(180);
    };
    const rightClick = async (selector) => {
      const point = await pointOf(selector);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'right', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'right', clickCount: 1 });
      await wait(180);
    };

    await send('Page.enable');
    await send('Page.navigate', { url });
    await until(() => evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#runtimeView'))"), 'application did not boot');
    await wait(600);
    await metrics(1320, 900);

    const seed = async () => {
      const info = await (await fetch('/api/__file-links/info')).json();
      const surface = await import('/ui/workspace-surface.js');
      const shell = await import('/shell.js');
      const runtime = await import('/runtime-state.js');
      const rtc = await import('/runtime-conversation.js');
      const api = await import('/api.js');
      surface.showRuntimeConversation();
      const host = document.querySelector('#runtimeView');
      host.replaceChildren();
      const view = rtc.createRuntimeConversation({ host, onTitle: shell.setRuntimeTitle });
      const owner = (key) => ({ backendInstance: 'fixture', projectId: 'fixture', repoId: 'repo',
        workspaceId: 'ws-' + key, workspaceEpoch: '1', conversationId: key, runtimeId: 'rt-' + key,
        runtimeGeneration: '1', sessionId: 's-' + key });
      const item = (key, cwd, title) => ({ conversationId: key, owner: owner(key),
        workspace: { branch: key, projectId: 'fixture', workspaceId: 'ws-' + key, workspaceEpoch: '1', cwd },
        title, lifecycle: 'ready', activity: 'idle', attention: false, error: null, stop: null,
        createdAt: '2026-11-24T08:00:00.000Z' });
      runtime.seedRuntimeSnapshot({ backendInstance: 'fixture', items: [
        item('fixture-a', info.rootA, '文件引用验收 A'),
        item('fixture-b', info.rootB, '文件引用验收 B'),
      ] });
      const text = [
        '文件引用已经接入。改动集中在：',
        '',
        '- `src/app.ts:18` 的 `EditorSession.open`，范围 `src/app.ts:18-24`。',
        '- 样式在 `src/styles.css`，组件在 `src/App.vue` 与 `src/components/Sidebar.tsx`。',
        '- 配置 `config/settings.json`，说明文档 [`docs/说明 文档.md`](docs/说明 文档.md)。',
        '- 图片 `assets/architecture.png`，PDF `docs/design.pdf`，表格 `data/report.xlsx`，压缩包 `archive.zip`。',
        '- 普通文本 `notes.txt`、日志 `run.log`、脚本 `scripts/build.py` 与 `Makefile`。',
        '',
        '这些路径都绑定当前消息的工作区；`npm install`、v1.2.3、https://example.com 与普通术语不会被当成文件。',
      ].join('\n');
      runtime.observeRuntimeFrame({ type: 'runtime_event', owner: owner('fixture-a'), eventSequence: 1,
        event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } } });
      runtime.observeRuntimeFrame({ type: 'runtime_event', owner: owner('fixture-b'), eventSequence: 1,
        event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta',
          delta: 'B 工作区里的同名文件：`src/app.ts`。打开后应当是 B 的内容。' } } });
      api.setGitConversationScope('fixture-a');
      view.show('fixture-a');
      window.__fileLinks = { view, api, info };
    };
    await evaluate('(' + seed.toString() + ')()');
    await until(() => evaluate("document.querySelectorAll('.rtc-output a.md-file-link').length >= 13"), 'file chips did not render');
    await wait(400);

    const chipCount = await evaluate("document.querySelectorAll('.rtc-output a.md-file-link').length");
    const chipKinds = await evaluate("[...new Set([...document.querySelectorAll('.rtc-output a.md-file-link .file-kind-icon')].map(n => n.dataset.fileKind))].sort()");
    check('dark conversation renders many file types as inline chips', chipCount >= 13, { chipCount, chipKinds });
    await shot('01-dark-conversation');

    const chipLayout = await evaluate(`(() => {
      const body = document.querySelector('.rtc-output .msg-body');
      const chip = [...document.querySelectorAll('.rtc-output a.md-file-link')].find(n => n.dataset.filePath === 'src/styles.css');
      const name = chip.querySelector('.md-file-name');
      const icon = chip.querySelector('.file-kind-icon');
      const bodyStyle = getComputedStyle(body);
      const chipStyle = getComputedStyle(chip);
      const nameRect = name.getBoundingClientRect(), iconRect = icon.getBoundingClientRect();
      return {
        bodyFont: bodyStyle.fontSize, chipFont: chipStyle.fontSize,
        bodyLine: bodyStyle.lineHeight, chipLine: chipStyle.lineHeight,
        background: chipStyle.backgroundColor, border: chipStyle.borderTopWidth,
        radius: chipStyle.borderRadius, title: chip.getAttribute('title'),
        name: name.textContent,
        centerDelta: Math.abs((nameRect.top + nameRect.height / 2) - (iconRect.top + iconRect.height / 2)),
        iconColor: getComputedStyle(icon).color,
      };
    })()`);
    check('chips inherit body typography and have no pill/card surface',
      chipLayout.bodyFont === chipLayout.chipFont && chipLayout.bodyLine === chipLayout.chipLine
      && chipLayout.background === 'rgba(0, 0, 0, 0)' && chipLayout.border === '0px'
      && chipLayout.radius === '0px' && !chipLayout.title && chipLayout.centerDelta < 1.5, chipLayout);

    await evaluate("document.documentElement.dataset.theme = 'light'");
    await wait(250);
    await shot('02-light-conversation');
    await evaluate("document.documentElement.dataset.theme = 'dark'");
    await wait(250);

    const chipSelector = 'a.md-file-link[data-file-path="src/app.ts"][data-file-line="18"]';
    const beforeHover = await pointOf(chipSelector);
    await move(chipSelector);
    const tooltip = await until(() => evaluate(`(() => {
      const tip = document.querySelector('.ui-tooltip.file-link-tip');
      if (!tip || tip.hidden) return null;
      const rect = tip.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { text: tip.textContent, top: rect.top, left: rect.left };
    })()`), 'hover tooltip did not appear');
    const afterHover = await pointOf(chipSelector);
    check('hover shows the full path and real size without moving the link',
      /src[\\/]app\.ts/.test(tooltip.text) && /\d+(?:\.\d+)?\s?(?:B|KB|MB)/.test(tooltip.text) && /L18/.test(tooltip.text)
      && Math.abs(beforeHover.x - afterHover.x) < 0.5 && Math.abs(beforeHover.y - afterHover.y) < 0.5,
      { tooltip: tooltip.text.slice(0, 180), beforeHover, afterHover });
    await shot('03-hover-metadata');

    await click(chipSelector);
    await until(() => evaluate("Boolean(document.querySelector('.files-preview-body'))"), 'source preview did not open');
    const openState = await evaluate(`(() => {
      const row = document.querySelector('.files-entry[data-file-path="src/app.ts"]');
      const highlight = document.querySelector('.files-line-highlight');
      const body = document.querySelector('.files-preview-body');
      const gutter = document.querySelector('.files-preview-gutter');
      const pane = document.querySelector('.files-surface');
      return {
        row: row?.getAttribute('aria-current'), expanded: document.querySelector('.files-entry[data-file-path="src"]')?.getAttribute('aria-expanded'),
        line: highlight?.dataset.lineFrom, tab: document.querySelector('.files-tab-select[aria-selected="true"] .files-tab-label')?.textContent,
        position: document.querySelector('.files-tab-select[aria-selected="true"] .files-tab-position')?.textContent,
        tok: document.querySelectorAll('.files-preview-body [class^="tok-"]').length,
        gutterLeftOfBody: gutter.getBoundingClientRect().right <= body.getBoundingClientRect().left + 1,
        text: body.textContent.slice(0, 80),
        fullText: body.textContent,
        paneVisible: Boolean(pane && pane.getBoundingClientRect().width > 240),
        highlightVisible: highlight && !highlight.hidden,
      };
    })()`);
    check('clicking a chip opens the real file, syncs the tree and locates the line',
      openState.row === 'page' && openState.expanded === 'true' && openState.line === '18'
      && openState.tab === 'app.ts' && openState.position === ':18' && openState.highlightVisible
      && openState.tok > 10 && openState.gutterLeftOfBody && openState.paneVisible, openState);
    check('preview loads the A workspace copy of the same-named file',
      openState.fullText.includes('A 工作区') && openState.fullText.includes('EditorSession'), openState.text);
    await shot('04-open-source');

    const rangeSelector = 'a.md-file-link[data-file-path="src/app.ts"][data-file-end-line="24"]';
    await click(rangeSelector);
    await until(() => evaluate("document.querySelector('.files-line-highlight')?.dataset.lineTo === '24'"), 'range highlight did not move');
    const rangeState = await evaluate(`(() => {
      const h = document.querySelector('.files-line-highlight');
      return { from: h.dataset.lineFrom, to: h.dataset.lineTo, tabs: document.querySelectorAll('.files-tab').length,
        scrollTop: document.querySelector('.files-preview-scroll').scrollTop };
    })()`);
    check('line range re-locates in the same tab and highlights the whole range',
      rangeState.from === '18' && rangeState.to === '24' && rangeState.tabs === 1 && rangeState.scrollTop > 0, rangeState);
    await shot('05-line-range');

    await click('a.md-file-link[data-file-path="assets/architecture.png"]');
    await until(() => evaluate("document.querySelector('.files-preview-image img')?.complete === true && document.querySelector('.files-preview-image img')?.naturalWidth > 0"), 'image preview did not load real bytes');
    const imageState = await evaluate(`(() => {
      const img = document.querySelector('.files-preview-image img');
      return { width: img.naturalWidth, height: img.naturalHeight, tabs: document.querySelectorAll('.files-tab').length,
        active: document.querySelector('.files-tab-select[aria-selected="true"] .files-tab-label')?.textContent };
    })()`);
    check('image chips open the real image through the controlled asset endpoint',
      imageState.width === 240 && imageState.height === 140 && imageState.active === 'architecture.png', imageState);
    await shot('06-image-preview');

    await metrics(720, 780);
    await wait(300);
    const narrow = await evaluate(`(() => {
      const doc = document.documentElement;
      const chip = [...document.querySelectorAll('.rtc-output a.md-file-link')].find(n => n.dataset.filePath === 'src/styles.css');
      return { overflow: doc.scrollWidth - innerWidth, chipWidth: chip.getBoundingClientRect().width,
        nameOverflow: chip.querySelector('.md-file-name').scrollWidth - chip.querySelector('.md-file-name').clientWidth,
        pane: Boolean(document.querySelector('.files-surface')?.getBoundingClientRect().width > 200) };
    })()`);
    check('narrow window keeps the panel and long chips inside the viewport',
      narrow.overflow <= 1 && narrow.pane && narrow.chipWidth < 720, narrow);
    await shot('07-narrow-window');

    await metrics(1320, 900);
    await wait(300);
    await rightClick(chipSelector);
    const menu = await until(() => evaluate(`(() => {
      const menu = document.querySelector('.action-menu[role="menu"]');
      if (!menu) return null;
      const rect = menu.getBoundingClientRect();
      return { labels: [...menu.querySelectorAll('.action-menu-label')].map(n => n.textContent),
        insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 };
    })()`), 'context menu did not open');
    check('right-click exposes the five file actions inside the viewport',
      menu.labels.length === 5 && menu.labels[0].includes('文件面板') && menu.labels[1].includes('系统默认程序')
      && menu.labels[2].includes('文件管理器') && menu.labels[3].includes('复制相对路径')
      && menu.labels[4].includes('复制完整路径') && menu.insideViewport, menu);
    await shot('08-context-menu');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await wait(150);

    await evaluate('window.__fileLinks.api.setGitConversationScope("fixture-b"); window.__fileLinks.view.show("fixture-b")');
    await until(() => evaluate("document.querySelectorAll('.rtc-output a.md-file-link').length === 1"), 'B workspace message missing');
    await click('a.md-file-link[data-file-path="src/app.ts"]');
    await until(() => evaluate("document.querySelector('.files-preview-body')?.textContent.includes(\"project-b\")"), 'B workspace file did not open');
    const switched = await evaluate(`(() => {
      const row = document.querySelector('.files-entry[data-file-path="src/app.ts"]');
      return { text: document.querySelector('.files-preview-body').textContent.slice(0, 120),
        row: row?.getAttribute('aria-current'), path: document.querySelector('.files-preview-path')?.textContent,
        cwd: document.querySelector('a.md-file-link')?.dataset.fileCwd };
    })()`);
    check('switching to another session opens that session\'s same-named file',
      switched.text.includes('project-b') && switched.cwd.endsWith('project-b') && switched.row === 'page', switched);
    await shot('09-workspace-switch');

    await evaluate('window.__fileLinks.api.setGitConversationScope("fixture-a"); window.__fileLinks.view.show("fixture-a")');
    await wait(250);
    await click(chipSelector);
    await until(() => evaluate("document.querySelector('.files-preview-body')?.textContent.includes('EditorSession')"), 'A workspace file did not reopen');
    const back = await evaluate("document.querySelector('.files-preview-body').textContent");
    check('switching back reuses the A workspace binding', back.includes('A 工作区') && back.includes('EditorSession'), back.slice(0, 80));

    /* 键盘路径：Tab 到链接 → 提示出现 → Enter 与单击走同一条打开逻辑。 */
    const notesChip = 'a.md-file-link[data-file-path="notes.txt"]';
    const tabsBefore = await evaluate("document.querySelectorAll('.files-tab').length");
    await evaluate('document.querySelector(' + JSON.stringify(notesChip) + ').focus()');
    const focusTip = await until(() => evaluate(`(() => {
      const tip = document.querySelector('.ui-tooltip.file-link-tip');
      if (!tip || tip.hidden) return null;
      const rect = tip.getBoundingClientRect();
      return rect.width && rect.height ? { text: tip.textContent } : null;
    })()`), 'focus tooltip did not appear');
    check('keyboard focus reveals the same file tooltip', /notes\.txt/.test(focusTip.text), { tooltip: focusTip.text.slice(0, 180) });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await until(() => evaluate("document.querySelector('.files-preview-body')?.textContent.includes('普通文本')"), 'Enter did not open the file');
    const keyboardOpen = await evaluate(`(() => ({
      tabs: document.querySelectorAll('.files-tab').length,
      active: document.querySelector('.files-tab-select[aria-selected="true"] .files-tab-label')?.textContent,
      row: document.querySelector('.files-entry[data-file-path="notes.txt"]')?.getAttribute('aria-current'),
    }))()`);
    check('Enter on a focused chip activates the same internal open',
      keyboardOpen.active === 'notes.txt' && keyboardOpen.tabs === tabsBefore + 1 && keyboardOpen.row === 'page',
      { tabsBefore, ...keyboardOpen });

    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
    console.log(`file-links-shots: ${result.checks.length} checks, ${result.shots.length} screenshots -> ${out}`);
  } finally {
    try { ws?.close(); } catch { /* already closed */ }
    chrome?.kill();
    harness.kill();
    await wait(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 }); } catch { /* Chrome may still hold the profile */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
