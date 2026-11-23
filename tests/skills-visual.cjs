/* 技能页第二阶段的真实 Chromium 截图取证。
 *
 * 页面由 tests/visual-harness.cjs 提供脚本数据（技能列表 / 编辑 / 导入 / 市场），
 * 不启动真 pi、不碰用户技能目录、不联网。jsdom 不做布局 —— 排版、换行、
 * 弹层滚动只有真实浏览器能证明，所以这里走真实前端渲染路径截图。
 *
 * 覆盖：1320×820 与 700×600，深 / 浅色，各含
 *   正常列表、展开详情、编辑弹窗、导入弹窗（已暂存计划）、市场、
 *   市场预览、空状态、读取错误、外部扫描、目录源。
 *
 * 用法：node tests/skills-visual.cjs
 *       CHROME_PATH=... CDP_PORT=9233 node tests/skills-visual.cjs
 * 产物：.shots/skills-phase2a/*.png 与 manifest.json，可用 SKILLS_SHOTS_DIR 指定单次取证目录。
 * 只用于验收取证，不属于 npm test 的 canonical 链。 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { contrastSample } = require('./fixtures/system-settings-states.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.SKILLS_SHOTS_DIR || path.join(ROOT, '.shots', 'skills-phase2a');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FIXED_PORT = process.env.CDP_PORT ? Number(process.env.CDP_PORT) : 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chrome 的 DevTools 端口：没指定就临时要一个空闲端口，避免和并行会话撞车。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-skills-shot-'));
  const skillFile = path.join(world, 'SKILL.md');
  fs.writeFileSync(skillFile, [
    '---',
    'name: claude-notes',
    'description: 把会议记录整理成结构化笔记：结论、待办、负责人。',
    '---',
    '',
    '# 会议笔记',
    '',
    '## 什么时候用',
    '',
    '用户贴来一段会议记录，或要求把讨论整理成可以执行的结论。',
    '',
    '## 步骤',
    '',
    '1. 先列出结论，再列待办；待办必须有负责人。',
    '2. 删掉重复的讨论过程，保留分歧与未决项。',
    '3. 最后核对一遍：每条待办都能在原文里找到出处。',
    '',
  ].join('\n'), 'utf8');

  const harness = spawn(process.execPath, [path.join(ROOT, 'tests', 'visual-harness.cjs')], {
    cwd: world,
    env: { ...process.env, HARNESS_PORT: '0', VISUAL_UPLOAD_DIR: path.join(world, 'uploads') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const harnessErrors = [];
  harness.stderr.on('data', (chunk) => harnessErrors.push(String(chunk)));
  const origin = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('视觉夹具启动超时：' + harnessErrors.join(''))), 15000);
    harness.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    harness.on('exit', (code) => { clearTimeout(timer); reject(new Error(`视觉夹具提前退出（${code}）：${harnessErrors.join('')}`)); });
  });

  if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME);
  const port = FIXED_PORT || await freePort();
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-component-update', '--disable-background-networking',
    '--disable-default-apps', '--metrics-recording-only', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(world, 'chrome')}`,
    '--window-size=1320,820', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let targets = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(250);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await response.json();
      if (targets.some((target) => target.type === 'page')) break;
    } catch { /* 还没起来 */ }
  }
  const page = targets && targets.find((target) => target.type === 'page');
  if (!page) throw new Error('拿不到 DevTools page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || '未知异常');
    }
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evalJs = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 400));
    return result.result?.result?.value;
  };
  const waitFor = async (expression, label, timeout = 15000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evalJs(expression)) return;
      await sleep(100);
    }
    throw new Error(`等待超时：${label}`);
  };
  const expect = async (expression, message) => {
    const value = await evalJs(expression);
    assert(value, message);
  };
  const setViewport = (width, height) => send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  const shots = [];
  const metrics = [];
  const shot = async (name) => {
    await sleep(300);
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(result.result.data, 'base64'));
    const bytes = fs.statSync(file).size;
    shots.push({ name, bytes });
    console.log(`截图: ${path.relative(ROOT, file)}（${bytes} 字节）`);
  };
  const click = (selector) => evalJs(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('找不到 ${selector.replace(/'/g, "\\'")}');
    node.click();
    return true;
  })()`);
  const clickText = (selector, text) => evalJs(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = nodes.find((candidate) => (candidate.textContent || '').includes(${JSON.stringify(text)}));
    if (!node) throw new Error('找不到按钮 ${selector.replace(/'/g, "\\'")} / ${text}');
    node.click();
    return true;
  })()`);
  const setValue = (selector, value) => evalJs(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('找不到字段 ${selector.replace(/'/g, "\\'")}');
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const scrollTop = () => evalJs(`(() => {
    const surface = document.getElementById('workSurface');
    if (surface) surface.scrollTop = 0;
    return true;
  })()`);
  const scrollBottom = () => evalJs(`(() => {
    const surface = document.getElementById('workSurface');
    if (surface) surface.scrollTop = surface.scrollHeight;
    return true;
  })()`);
  const closeModal = async (label = '取消') => {
    await clickText('#modalCard button', label);
    await waitFor(`document.getElementById('modal').hidden`, '弹窗关闭');
    await sleep(150);
  };
  const uploadFile = async (selector, filePath) => {
    const documentResult = await send('DOM.getDocument', { depth: -1, pierce: true });
    const found = await send('DOM.querySelector', { nodeId: documentResult.result.root.nodeId, selector });
    if (!found.result.nodeId) throw new Error('找不到文件输入：' + selector);
    await send('DOM.setFileInputFiles', { nodeId: found.result.nodeId, files: [filePath] });
  };
  const setMode = async (patch) => {
    const response = await fetch(origin + '/api/__skills/mode', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error('设置技能夹具形态失败：' + response.status);
    return response.json();
  };

  const closeChrome = () => { try { chrome.kill(); } catch { /* ignore */ } };
  const closeHarness = () => { try { harness.kill(); } catch { /* ignore */ } };
  const cleanup = () => { closeChrome(); closeHarness(); };
  process.on('exit', cleanup);

  async function applyTheme(theme) {
    await evalJs(`localStorage.setItem('pi-gui.theme.v1', ${JSON.stringify(theme)})`);
    await send('Page.reload', { ignoreCache: false });
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('navSkills')`, `主题 ${theme}`);
    await sleep(400);
    const applied = await evalJs(`document.documentElement.dataset.theme`);
    assert(applied === theme, `主题没有切到 ${theme}（实际 ${applied}）`);
  }

  async function openSkills() {
    if (!(await evalJs(`!!document.querySelector('.skills-page')`))) {
      await evalJs(`document.getElementById('navSkills').click()`);
    }
    await waitFor(`!!document.querySelector('.skills-page')`, '技能页挂载');
    await waitFor(`!document.querySelector('.skills-content.is-loading')`, '技能列表读取完成');
    await sleep(200);
  }

  async function refreshList() {
    await click('.skills-page .skills-head button[aria-label="刷新技能列表"]');
    await waitFor(`!document.querySelector('.skills-content.is-loading')`, '刷新完成');
    await sleep(200);
  }

  async function openEditor() {
    await clickText('.skills-page .skills-actions-bar button', '新建');
    await waitFor(`!!document.querySelector('.skills-editor-dialog')`, '新建技能弹窗');
    await waitFor(`!!document.querySelector('.skills-editor-dialog .skills-field-name input')`, '名称字段');
    await sleep(400);
  }

  async function openImport() {
    await clickText('.skills-page .skills-group[data-scope="user"] .skills-group-actions button', '导入文件');
    await waitFor(`!!document.querySelector('.skills-import-dialog')`, '导入弹窗');
    await uploadFile('.skills-import-dialog .skills-file-input', skillFile);
    await waitFor(`!!document.querySelector('.skills-import-dialog .skills-import-plan:not([hidden])')`, '导入计划');
    await expect(
      `document.querySelector('.skills-import-dialog input[aria-label="导入后的名称"]')?.value === 'claude-notes'`,
      '导入计划没有认出名称',
    );
    await sleep(200);
  }

  async function openMarket() {
    await clickText('.skills-page .skills-actions-bar button', '市场');
    await waitFor(`!!document.querySelector('.skills-market')`, '技能市场');
    await waitFor(`document.querySelectorAll('.skills-market-card').length >= 24`, '市场卡片');
    await expect(`[...document.querySelectorAll('.skills-page h2')].map((h) => h.textContent).join() === '技能市场'
      && !document.querySelector('.skills-page .skills-head')`, '市场只应有一个页面标题');
    await scrollTop();
    const layout = await evalJs(`(() => {
      const grid = document.querySelector('.skills-market-grid');
      const inner = document.querySelector('.skills-inner');
      return { viewport: [innerWidth, innerHeight], columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        overflow: inner.scrollWidth - inner.clientWidth, theme: document.documentElement.dataset.theme };
    })()`);
    assert(layout.columns === (layout.viewport[0] === 700 ? 1 : 2) && layout.overflow <= 1, '技能市场列数或内容溢出：' + JSON.stringify(layout));
    metrics.push({ market: layout });
    await sleep(250);
  }

  async function closeMarket() {
    await click('.skills-market-back');
    await waitFor(`!document.querySelector('.skills-market') && !document.querySelector('.skills-page .skills-toolbar').hidden`, '返回技能列表');
    await sleep(200);
  }

  async function openEdit() {
    await click('.skills-page .skill-row[data-skill-id="a1c0de0000000001"] .skill-row-main');
    await waitFor(`!!document.querySelector('.skills-page .skill-detail')`, '技能详情');
    await clickText('.skills-page .skill-detail-actions button', '编辑');
    await waitFor(
      `(document.querySelector('.skills-editor-dialog textarea[aria-label="描述"]')?.value || '').includes('审查源代码')`,
      '编辑表单回填',
    );
    await expect(`!document.querySelector('.skills-editor-dialog [data-field="target"]')`, '编辑弹窗不应提供保存位置');
  }

  async function openExternal() {
    await click('.skills-toolbar .skills-scan');
    await waitFor(`document.querySelectorAll('.skills-external-dialog .skills-external-list .skills-external-row').length >= 4`, '扫描候选');
    await expect(`[...document.querySelectorAll('.skills-external-group-title')].every((node) =>
      getComputedStyle(node).fontSize === '16px' && getComputedStyle(node).lineHeight === '20px')`, '扫描分组标题使用公共字号与行高');
  }

  async function measureList(theme) {
    const result = await evalJs(`(() => {
      const inner = document.querySelector('.skills-inner');
      const title = inner.querySelector('h2');
      const measure = (selector) => {
        const nodes = [...document.querySelectorAll(selector)];
        return nodes.map((node) => {
          const style = getComputedStyle(node);
          const box = node.getBoundingClientRect();
          return { text: node.textContent.trim(), font: style.fontSize, leading: style.lineHeight, height: box.height };
        });
      };
      return {
        viewport: [innerWidth, innerHeight, devicePixelRatio],
        pageHeading: measure('.skills-page h2'), titleWeight: getComputedStyle(title).fontWeight,
        overflow: inner.scrollWidth - inner.clientWidth,
        groupHeadings: measure('.skills-group-title'),
        rows: measure('.skill-row-line'),
        buttons: measure('.skills-head .skills-actions-bar .btn'),
        badges: [...document.querySelectorAll('.skill-row-actions')].map((row) =>
          [...row.querySelectorAll('.ds-badge')].map((badge) => badge.textContent)),
      };
    })()`);
    assert(result.pageHeading.length === 1 && result.pageHeading[0].font === '30px' && result.titleWeight === '700', '标题应与原版 MCP 设置页一致');
    assert(result.overflow <= 1, '技能列表内容区出现横向溢出：' + result.overflow);
    assert(result.groupHeadings.length === 2 && result.groupHeadings.every(({ font, leading }) => font === '16px' && leading === '20px'),
      '列表分组标题使用公共字号与行高');
    assert(result.badges.length === 3 && result.badges.every((items) => items.length === 1), '每行只有一个必要状态');
    assert(result.buttons.length === 3 && result.buttons.every(({ height }) => height === 32), '同行动作使用同高的标准按钮');
    const labels = ['.skills-group-path', '.skill-name', '.skill-row-desc', '.skill-row .ds-badge-success', '.skill-row .ds-badge-neutral'];
    const contrasts = await evalJs(`${JSON.stringify(labels)}.map(selector => (${contrastSample.toString()})(selector))`);
    for (const sample of contrasts) assert(sample.ratio >= 4.5, `${theme} ${sample.selector} 文字对比度 ${sample.ratio.toFixed(2)}:1`);
    metrics.push({ theme, ...result, contrasts });
  }

  // CDP 读取真实 Chromium 暴露的可访问描述，不只检查 DOM 里是否有 ARIA 属性。
  async function verifyRowStatus() {
    const row = '.skill-row[data-skill-id="a1c0de0000000001"]';
    const doc = (await send('DOM.getDocument')).result.root.nodeId;
    for (const [selector, role] of [['.skill-row-main', 'button'], ['.skill-toggle', 'switch']]) {
      const { nodeId } = (await send('DOM.querySelector', { nodeId: doc, selector: row + ' ' + selector })).result;
      const tree = (await send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })).result;
      const action = tree.nodes.find(node => !node.ignored && node.role?.value === role);
      assert(action?.description?.value === '已加载', `${role} 缺少独立于启停配置的加载状态`);
    }
  }

  async function captureDesktop(theme) {
    await setViewport(1320, 820);
    await applyTheme(theme);
    await setMode({ trusted: true, empty: false, error: false });
    await openSkills();
    await waitFor(`document.querySelectorAll('.skills-page .skill-row').length === 3`, '三条技能');
    await scrollTop();
    await expect(`document.querySelector('.skills-title')?.textContent === '技能'`, '技能页标题不对');
    await expect(`document.querySelectorAll('.skills-page .skills-group').length === 2`, '分组应为全局级 + 项目级');
    await expect(
      `[...document.querySelectorAll('.skills-page .skills-group-path')].every((node) => node.textContent.trim())`,
      '分组头缺少发现目录',
    );
    await measureList(theme);
    await verifyRowStatus();
    await shot(`1320-${theme}-01-list`);

    await click('.skills-page .skill-row[data-skill-id="a1c0de0000000001"] .skill-row-main');
    await waitFor(`(document.querySelector('.skills-page .skill-detail')?.textContent || '').includes('name: code-review')`, '技能详情正文');
    await shot(`1320-${theme}-02-detail`);
    await click('.skills-page .skill-row[data-skill-id="a1c0de0000000001"] .skill-row-main');
    await waitFor(`!document.querySelector('.skills-page .skill-detail')`, '详情收起');

    await openEditor();
    await expect(`!!document.querySelector('.skills-editor-dialog [data-field="target"]')`, '新建弹窗缺少保存位置');
    await shot(`1320-${theme}-03-editor`);
    await closeModal('取消');

    /* 编辑既有技能：详情里的「编辑」打开同一份弹窗，表单已被回填。 */
    await openEdit();
    await shot(`1320-${theme}-03b-editor-edit`);
    await closeModal('取消');
    await click('.skills-page .skill-row[data-skill-id="a1c0de0000000001"] .skill-row-main');
    await waitFor(`!document.querySelector('.skills-page .skill-detail')`, '详情收起');

    await openImport();
    await shot(`1320-${theme}-04-import`);
    await closeModal('取消');

    await openMarket();
    await expect(`(document.querySelector('.skills-market-count')?.textContent || '').includes('共 25 个')`, '市场计数不对');
    await shot(`1320-${theme}-05-market`);
    await scrollBottom();
    await sleep(250);
    await expect(
      `(document.querySelector('.skills-page-jump-label')?.textContent || '').includes('第 1 / 2 页')`,
      '市场分页摘要不对',
    );
    await shot(`1320-${theme}-05b-market-bottom`);
    await scrollTop();

    await clickText('.skills-market-head-actions button', '目录源');
    await waitFor(`!!document.querySelector('.skills-market-sources-dialog')`, '目录源弹窗');
    await expect(`document.querySelectorAll('.skills-market-sources-dialog .skills-sources-row').length === 3`, '目录源应有 3 个');
    await shot(`1320-${theme}-06-sources`);
    await closeModal('完成');

    await click('.skills-market-card[data-entry-id="e000000000000001"] .skills-market-card-actions button');
    await waitFor(`!!document.querySelector('.skills-preview-dialog')`, '预览弹窗');
    await waitFor(`(document.querySelector('.skills-preview-pre')?.textContent || '').includes('# code-review')`, '预览全文');
    await shot(`1320-${theme}-07-preview`);
    await closeModal('关闭');
    await closeMarket();

    await openExternal();
    await shot(`1320-${theme}-08-external`);
    await closeModal('关闭');

    await setMode({ empty: true });
    await refreshList();
    await waitFor(`document.querySelectorAll('.skills-page .skills-empty-group').length === 2`, '两个空分组');
    await scrollTop();
    await shot(`1320-${theme}-09-empty`);

    await setMode({ empty: false, error: true });
    await refreshList();
    await waitFor(`(document.querySelector('.skills-content .skills-empty')?.textContent || '').includes('读取技能失败')`, '读取错误状态');
    await shot(`1320-${theme}-10-error`);

    await setMode({ error: false });
    await clickText('.skills-content .skills-empty button', '重试');
    await waitFor(`document.querySelectorAll('.skills-page .skill-row').length === 3`, '错误恢复后的技能行');

    /* 内联成功反馈：创建只落在夹具里（不写盘），验证提示条与撤销 / 重启入口都在页面内。 */
    await openEditor();
    await setValue('.skills-editor-dialog .skills-field-name input', 'meeting-notes');
    await setValue('.skills-editor-dialog textarea[aria-label="描述"]', '把会议记录整理成结论、待办与负责人。');
    await setValue('.skills-editor-dialog textarea[aria-label="正文"]', '# 会议笔记\n\n1. 先列结论，再列待办。\n');
    await sleep(900);
    await clickText('#modalCard .skills-dialog-foot button', '创建');
    await waitFor(`document.getElementById('modal').hidden`, '创建完成');
    await waitFor(`!!document.querySelector('.skills-notice.is-success')`, '成功提示');
    /* 关闭按钮是共享 .icon-btn（页面不再给它叠 .btn，否则 32px 最小高度会把它挤变形）。 */
    await expect(`!!document.querySelector('.skills-notice [aria-label="关闭提示"]')`, '提示缺少关闭按钮');
    await sleep(300);
    await scrollTop();
    await shot(`1320-${theme}-11-notice`);
    await click('.skills-notice-close');
    await sleep(150);
  }

  async function captureNarrow(theme) {
    await setViewport(700, 600);
    await sleep(400);
    await scrollTop();
    await expect(`document.querySelectorAll('.skills-page .skill-row').length === 3`, '700 宽度下技能行缺失');
    await expect(
      `document.documentElement.scrollWidth <= window.innerWidth + 1`,
      '700 宽度出现横向滚动',
    );
    await measureList(theme);
    await shot(`700-${theme}-01-list`);

    /* 滚到底：最后一个分组必须整个露出，并与窗口底部留出呼吸空间。
     * 曾经在内容溢出时只差最后一段滚不出来 / 空状态瓦片贴住窗口边缘。 */
    await scrollBottom();
    await sleep(250);
    const listBottom = await evalJs(`(() => {
      const surface = document.getElementById('workSurface');
      const groups = [...document.querySelectorAll('.skills-page .skills-content > .skills-group')];
      const last = groups[groups.length - 1];
      return {
        top: Math.round(surface.scrollTop),
        max: Math.round(surface.scrollHeight - surface.clientHeight),
        gap: Math.round(surface.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom),
      };
    })()`);
    assert(listBottom.max > 0, '700 宽度下技能列表应可滚动（夹具前提）: ' + JSON.stringify(listBottom));
    assert(Math.abs(listBottom.top - listBottom.max) <= 1, '技能列表没有滚到底: ' + JSON.stringify(listBottom));
    assert(listBottom.gap >= 24, '技能列表滚到底后最后一个分组贴住窗口: ' + JSON.stringify(listBottom));
    await shot(`700-${theme}-01b-list-bottom`);
    await scrollTop();

    await openEditor();
    await shot(`700-${theme}-02-editor`);
    /* 600px 高的窗口放不下整张表单；滚到底证明「保存到」仍然可达。 */
    await evalJs(`(() => {
      const body = document.querySelector('.skills-editor-dialog .skills-dialog-body');
      if (body) body.scrollTop = body.scrollHeight;
      return true;
    })()`);
    await waitFor(
      `(() => {
        const select = document.querySelector('.skills-editor-dialog [data-field="target"]');
        if (!select) return false;
        const rect = select.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      })()`,
      '窄窗保存位置可见',
    );
    await shot(`700-${theme}-02b-editor-bottom`);
    await closeModal('取消');

    await openEdit();
    await shot(`700-${theme}-02c-editor-edit`);
    await closeModal('取消');
    await click('.skills-page .skill-row[data-skill-id="a1c0de0000000001"] .skill-row-main');
    await waitFor(`!document.querySelector('.skills-page .skill-detail')`, '详情收起');

    await openImport();
    await shot(`700-${theme}-03-import`);
    await closeModal('取消');

    await openMarket();
    await expect(
      `document.documentElement.scrollWidth <= window.innerWidth + 1`,
      '700 宽度市场出现横向滚动',
    );
    await shot(`700-${theme}-04-market`);
    await closeMarket();

    await openExternal();
    await shot(`700-${theme}-04b-external`);
    await closeModal('关闭');

    await setMode({ empty: true });
    await refreshList();
    await waitFor(`document.querySelectorAll('.skills-page .skills-empty-group').length === 2`, '700 空分组');
    await scrollTop();
    await shot(`700-${theme}-05-empty`);

    await setMode({ empty: false, error: true });
    await refreshList();
    await waitFor(`(document.querySelector('.skills-content .skills-empty')?.textContent || '').includes('读取技能失败')`, '700 读取错误');
    await shot(`700-${theme}-06-error`);

    await setMode({ error: false });
    await clickText('.skills-content .skills-empty button', '重试');
    await waitFor(`document.querySelectorAll('.skills-page .skill-row').length === 3`, '700 错误恢复');
  }

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    await setViewport(1320, 820);
    await send('Page.navigate', { url: origin + '/' });
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('navSkills')`, '应用外壳');

    for (const theme of ['light', 'dark']) {
      await captureDesktop(theme);
      await captureNarrow(theme);
    }

    if (pageErrors.length) throw new Error('页面有运行时异常：\n' + pageErrors.join('\n'));
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      viewports: ['1320x820', '700x600'],
      themes: ['light', 'dark'],
      browser: (await send('Browser.getVersion')).result.product,
      metrics,
      shots,
      pageErrors,
    }, null, 2) + '\n', 'utf8');
    console.log(`截图完成：${shots.length} 张，页面无运行时异常。`);
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
