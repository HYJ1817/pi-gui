/* 离线契约：fixture 对照 pi-browser-harness 0.11.0 的 registerBrowserTool（src/util/tool.ts）
 * 与 src/domains/* 的真实 details 形状。
 *
 * 完全离线：不启动 Chrome / Playwright、不联网、不登录任何站点、不安装任何包。
 * 真实浏览器验收是单独的手工流程（docs/browser.md），不进默认 CI。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

(async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' });
  global.document = dom.window.document;
  global.window = dom.window;

  const { browserActivity, safeBrowserUrl, browserHost, nonSensitiveOption, BROWSER_TOOLS } = await import('../public/browser-activity.js');
  const { createBrowserObservation, browserSetup, BROWSER_INSTALL_COMMAND, BROWSER_EXTENSION_NAME, acceptBrowserEvent } = await import('../public/browser-capabilities.js');
  const { webActivity } = await import('../public/web-activity.js');
  const { subagentActivity } = await import('../public/subagent-activity.js');
  const { memoryActivity } = await import('../public/memory-activity.js');
  const model = await import('../public/tool-model.js');
  const view = await import('../public/tool-view.js');

  const entry = (name, args = {}) => model.makeEntry({ toolCallId: name, toolName: name, args }, 1);
  const ok = (details = {}) => ({ ok: true, ...details });
  const fail = (kind, extra = {}) => ({ ok: false, kind, message: 'upstream message with PRIVATE_DETAIL', ...extra });
  /* result 正文里塞一个 marker：它**永远**不该出现在 Activity 里。 */
  const end = (e, details, isError = false) => model.applyEnd(e, { result: { content: [{ type: 'text', text: 'RAW_RESULT_MARKER' }], details }, isError }, 10);

  /* ---------- 适配面被钉住 ---------- */
  console.log('\n--- A. 适配面 ---');
  check('适配 40 个工具', () => assert.equal(BROWSER_TOOLS.size, 40));
  check('全部以 browser_ 前缀', () => { for (const n of BROWSER_TOOLS) assert.match(n, /^browser_[a-z_]+$/); });

  /* ---------- 每个动作的 start / success / error ---------- */
  console.log('\n--- B. 全量动作状态 ---');
  for (const name of BROWSER_TOOLS) {
    check(name + ' start', () => {
      const a = browserActivity(entry(name));
      assert.equal(a.status, 'running');
      assert.match(a.label, /…$/);
    });
    check(name + ' success', () => {
      const a = browserActivity(end(entry(name), ok()));
      assert.equal(a.status, 'success');
      assert.doesNotMatch(a.label, /…$/);
      assert.doesNotMatch(a.label, /failed|unavailable/);
    });
    check(name + ' error', () => {
      const a = browserActivity(end(entry(name), fail('timeout'), true));
      assert.equal(a.status, 'error');
      assert.match(a.label, /failed/);
    });
  }

  /* ---------- navigate ---------- */
  console.log('\n--- C. navigate / open_urls ---');
  const nav = end(entry('browser_navigate', { url: 'https://pi.dev/docs' }), ok({
    outcome: { kind: 'new_tab_created', targetId: 'ABC' },
    page: { url: 'https://pi.dev/docs', title: 'PRIVATE_PAGE_TITLE', width: 1280, height: 720 },
  }));
  check('Opened <host> 用真实页面地址', () => assert.equal(browserActivity(nav).label, 'Opened pi.dev'));
  check('viewport 来自 details', () => assert.match(browserActivity(nav).facts, /Viewport: 1280x720/));
  check('新标签页语义来自闭集', () => assert.match(browserActivity(nav).facts, /Opened in a new tab/));
  check('页面标题不投影', () => assert.ok(!JSON.stringify(browserActivity(nav)).includes('PRIVATE_PAGE_TITLE')));
  check('running 时显示请求主机名', () => assert.equal(browserActivity(entry('browser_navigate', { url: 'https://example.org/a' })).summary, 'example.org'));
  check('无证据 → 明确说结果不可用', () => {
    const a = browserActivity(end(entry('browser_navigate', { url: 'https://example.org' }), {}));
    assert.match(a.label, /result unavailable/);
    assert.equal(a.facts, 'Result details unavailable');
    assert.equal(a.summary, '');
    assert.deepEqual(a.sources, []);
  });
  check('open_urls 用真实成败计数', () => {
    const a = browserActivity(end(entry('browser_open_urls', { urls: ['https://a.example', 'https://b.example'] }), ok({
      tabs: [{ url: 'https://a.example', targetId: 'A', ok: true }, { url: 'https://b.example', targetId: '', ok: false, error: 'x' }],
    })));
    assert.equal(a.label, 'Opened 1 page');
    assert.match(a.facts, /Opened 1\/2 URLs/);
    assert.equal(a.sources.length, 1);
  });

  /* ---------- 输入内容默认不投影 ---------- */
  console.log('\n--- D. 输入内容与凭据 ----------');
  check('type 的正文不投影', () => {
    const a = browserActivity(end(entry('browser_type', { text: 'SUPER_SECRET_PASSWORD' }), ok()));
    assert.equal(a.label, 'Entered text');
    assert.ok(!JSON.stringify(a).includes('SUPER_SECRET'));
  });
  check('fill 的 value 不投影，只给元素与标签名', () => {
    const a = browserActivity(end(entry('browser_fill', { ref: 'e7', value: 'SUPER_SECRET_PASSWORD' }), ok({ ref: 'e7', value: 'SUPER_SECRET_PASSWORD', verified: 'SUPER_SECRET_PASSWORD', tag: 'INPUT' })));
    assert.equal(a.label, 'Entered text');
    assert.match(a.facts, /Field: <input>/);
    assert.ok(!JSON.stringify(a).includes('SUPER_SECRET'));
  });
  check('fill_form 只给计数', () => {
    const a = browserActivity(end(entry('browser_fill_form', { fields: [{ ref: 'e1', value: 'SUPER_SECRET_PASSWORD' }] }), ok({ results: [{ ref: 'e1', ok: true, value: 'SUPER_SECRET_PASSWORD' }] })));
    assert.equal(a.label, 'Filled 1/1 fields');
    assert.ok(!JSON.stringify(a).includes('SUPER_SECRET'));
  });
  check('select 显示非敏感选项', () => {
    const a = browserActivity(end(entry('browser_select_option', { ref: 'e3' }), ok({ ref: 'e3', value: 'us', label: 'United States' })));
    assert.equal(a.label, 'Selected option');
    assert.equal(a.summary, 'United States');
    assert.match(a.facts, /Option: United States/);
  });
  check('select 隐藏像凭据的选项', () => {
    const a = browserActivity(end(entry('browser_select_option', { ref: 'e3' }), ok({ ref: 'e3', value: 'tok_live_9f', label: 'API Token 483920' })));
    assert.equal(a.label, 'Selected option');
    assert.ok(!JSON.stringify(a).includes('API Token'));
    assert.ok(!JSON.stringify(a).includes('tok_live_9f'));
  });
  check('选项 allowlist 是保守的', () => {
    for (const v of ['user@example.org', 'a/b', 'OTP 123456', 'password', 'x'.repeat(60), '', 'Card number 411111', 'Bearer abc']) assert.equal(nonSensitiveOption(v), null);
    assert.equal(nonSensitiveOption('United States'), 'United States');
    assert.equal(nonSensitiveOption('  Visa  '), 'Visa');
  });
  check('具名按键显示，单字符不显示', () => {
    assert.equal(browserActivity(end(entry('browser_press_key', { key: 'Enter' }), ok())).label, 'Pressed Enter');
    const a = browserActivity(end(entry('browser_press_key', { key: 'h' }), ok()));
    assert.equal(a.label, 'Pressed key');
    assert.equal(a.summary, '');
  });
  check('prompt 文本不投影', () => {
    const a = browserActivity(end(entry('browser_handle_dialog', { accept: true, promptText: 'PRIVATE_PROMPT' }), ok({ accept: true })));
    assert.equal(a.label, 'Handled dialog (accepted)');
    assert.ok(!JSON.stringify(a).includes('PRIVATE_PROMPT'));
  });
  check('请求头（Authorization/Cookie）不投影', () => {
    const a = browserActivity(end(entry('browser_http_get', { url: 'https://api.example.org/v1', headers: { Authorization: 'Bearer PRIVATE_TOKEN', Cookie: 'PRIVATE_COOKIE' } }), ok({ status: 200, contentType: 'application/json', length: 120 })));
    assert.equal(a.label, 'Fetched api.example.org');
    assert.match(a.facts, /HTTP status: 200/);
    const s = JSON.stringify(a);
    assert.ok(!s.includes('PRIVATE_TOKEN') && !s.includes('PRIVATE_COOKIE'));
  });

  /* ---------- 原始页面内容不进入 Activity ---------- */
  console.log('\n--- E. 原始结果与页面内容 ----------');
  check('execute_js 不求值结果', () => {
    const a = browserActivity(end(entry('browser_execute_js', { expression: 'document.cookie' }), ok({ valueLength: 42, full: 'PRIVATE_EVAL', pretty: 'PRIVATE_EVAL' })));
    assert.match(a.facts, /Result size: 42 chars/);
    assert.ok(!JSON.stringify(a).includes('PRIVATE_EVAL'));
    assert.ok(!JSON.stringify(a).includes('document.cookie'));
  });
  check('read_page 不铺正文与标题', () => {
    const a = browserActivity(end(entry('browser_read_page', { url: 'https://example.org/post' }), ok({ title: 'PRIVATE_PAGE_TITLE', url: 'https://example.org/post', wordCount: 1200, render: { body: 'PRIVATE_PAGE_BODY' } })));
    assert.equal(a.label, 'Read example.org');
    assert.match(a.facts, /Words: 1200/);
    const s = JSON.stringify(a);
    assert.ok(!s.includes('PRIVATE_PAGE_BODY') && !s.includes('PRIVATE_PAGE_TITLE'));
  });
  check('snapshot 只给结构计数', () => {
    const a = browserActivity(end(entry('browser_snapshot'), ok({ nodeCount: 210, truncated: false, url: 'https://example.org', title: 'PRIVATE_PAGE_TITLE', summary: '3 landmarks · 12 buttons · 4 links', fullOutputPath: 'C:\\PRIVATE\\snap.txt' })));
    assert.equal(a.label, 'Read page structure (210 elements)');
    assert.match(a.facts, /Structure: 3 landmarks · 12 buttons · 4 links/);
    assert.ok(!JSON.stringify(a).includes('PRIVATE_'));
  });
  check('网络与控制台记录不投影', () => {
    const net = browserActivity(end(entry('browser_network_requests'), ok({ total: 30, returned: 10, includeBodies: true, requests: [{ url: 'https://x/PRIVATE_REQ' }] })));
    assert.match(net.facts, /Requests: 10\/30/);
    assert.ok(!JSON.stringify(net).includes('PRIVATE_REQ'));
    const con = browserActivity(end(entry('browser_console'), ok({ total: 5, returned: 5, records: [{ text: 'PRIVATE_CONSOLE' }] })));
    assert.match(con.facts, /Messages: 5\/5/);
    assert.ok(!JSON.stringify(con).includes('PRIVATE_CONSOLE'));
  });
  check('本机路径不投影', () => {
    const cases = [
      ['browser_upload_file', ok({ mode: 'cdp', filePath: 'C:\\PRIVATE\\a.txt' })],
      ['browser_download', ok({ downloadPath: 'C:\\PRIVATE\\dl' })],
      ['browser_print_to_pdf', ok({ path: 'C:\\PRIVATE\\a.pdf' })],
      ['browser_screenshot', ok({ path: 'C:\\PRIVATE\\shot.jpeg', format: 'jpeg', attached: false })],
    ];
    for (const [name, details] of cases) {
      const a = browserActivity(end(entry(name), details));
      assert.ok(!JSON.stringify(a).includes('PRIVATE'), name);
    }
  });
  check('截图只说格式与「已捕获」', () => {
    const a = browserActivity(end(entry('browser_screenshot', { fullPage: true }), ok({ path: 'C:\\PRIVATE\\shot.png', format: 'png', attached: false })));
    assert.equal(a.label, 'Captured page screenshot');
    assert.match(a.facts, /Format: png/);
  });
  check('结果正文从不被解析', () => {
    const a = browserActivity(end(entry('browser_click', { ref: 'e1' }), ok({ ref: 'e1' })));
    assert.ok(!JSON.stringify(a).includes('RAW_RESULT_MARKER'));
    assert.doesNotMatch(src('public/browser-activity.js'), /entry\.output|entry\.error|resultLine/);
  });
  check('事实长度有界', () => {
    const e = entry('browser_snapshot');
    e.output = 'x'.repeat(20000);
    e.details = ok({ nodeCount: 5, summary: 'y'.repeat(5000) });
    assert.ok(browserActivity(e).facts.length < 1000);
  });

  /* ---------- 错误证据 ---------- */
  console.log('\n--- F. 错误证据 ----------');
  check('kind 是闭集才回显', () => {
    assert.match(browserActivity(end(entry('browser_click', { ref: 'e1' }), fail('timeout'), true)).facts, /Error: timeout/);
    const weird = browserActivity(end(entry('browser_click', { ref: 'e1' }), { ok: false, kind: 'PRIVATE_KIND', message: 'PRIVATE_MSG' }, true));
    assert.equal(weird.facts, 'Result details unavailable');
    assert.ok(!JSON.stringify(weird).includes('PRIVATE_'));
  });
  check('ok:false 优先于 pi 的 isError', () => {
    assert.equal(browserActivity(end(entry('browser_click'), { ok: false, kind: 'cdp_error' }, false)).status, 'error');
  });
  check('失败时仍给出请求目标（不是成功声明）', () => {
    const a = browserActivity(end(entry('browser_navigate', { url: 'https://example.org/x' }), fail('cdp_error'), true));
    assert.equal(a.label, 'Navigation failed');
    assert.equal(a.summary, 'example.org');
    assert.deepEqual(a.sources, []);
  });

  /* ---------- URL 安全 ---------- */
  console.log('\n--- G. URL 安全 ---');
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'data:text/html,hi', 'vbscript:msgbox(1)', 'chrome://settings', 'about:blank', 'https://user:pass@example.org', 'https://example.org/\nhi', 'https://', 'bad', '']) {
    check('拒绝 ' + (url || '(空)'), () => {
      assert.equal(safeBrowserUrl(url), null);
      assert.equal(browserHost(url), null);
    });
  }
  for (const url of ['https://pi.dev', 'http://example.org/a', 'https://pi.dev/docs']) {
    check('放行 ' + url, () => assert.ok(safeBrowserUrl(url)));
  }
  check('带 query/fragment 不给链接，但主机名照常显示', () => {
    assert.equal(safeBrowserUrl('https://example.org/?token=abc'), null);
    assert.equal(safeBrowserUrl('https://example.org/#frag'), null);
    assert.equal(browserHost('https://example.org/?token=abc'), 'example.org');
  });
  check('token URL 有主机名、无链接', () => {
    const a = browserActivity(end(entry('browser_navigate', { url: 'https://pi.dev/?token=abc' }), ok({ page: { url: 'https://pi.dev/?token=abc', width: 1, height: 1 } })));
    assert.equal(a.label, 'Opened pi.dev');
    assert.deepEqual(a.sources, []);
  });
  check('只有「打开页面」类动作给来源', () => {
    assert.equal(browserActivity(end(entry('browser_navigate', { url: 'https://pi.dev/' }), ok({ page: { url: 'https://pi.dev/', width: 1, height: 1 } }))).sources[0].hostname, 'pi.dev');
    assert.deepEqual(browserActivity(end(entry('browser_click', { ref: 'e1' }), ok({ ref: 'e1' }))).sources, []);
    assert.deepEqual(browserActivity(end(entry('browser_execute_js'), ok({ valueLength: 1 }))).sources, []);
  });

  /* ---------- 并发 / 取消 ---------- */
  console.log('\n--- H. 并发与取消 ---');
  check('并发按 toolCallId 各自独立', () => {
    const a = entry('browser_navigate', { url: 'https://a.example' });
    const b = entry('browser_navigate', { url: 'https://b.example' });
    b.id = 'B';
    end(b, ok({ page: { url: 'https://b.example', width: 1, height: 1 } }));
    assert.equal(browserActivity(a).status, 'running');
    assert.equal(browserActivity(a).label, 'Opening…');
    assert.equal(browserActivity(b).label, 'Opened b.example');
  });
  check('逆序完成不串结果', () => {
    const a = entry('browser_fill', { ref: 'e1', value: 'A_SECRET' });
    const b = entry('browser_fill', { ref: 'e2', value: 'B_SECRET' });
    b.id = 'B';
    end(b, ok({ ref: 'e2', tag: 'TEXTAREA' }));
    end(a, ok({ ref: 'e1', tag: 'INPUT' }));
    assert.match(browserActivity(a).facts, /Field: <input>/);
    assert.match(browserActivity(b).facts, /Field: <textarea>/);
  });
  check('中断不残留 spinner', () => {
    const e = entry('browser_wait', { seconds: 30 });
    e.status = 'incomplete';
    const a = browserActivity(e);
    assert.doesNotMatch(a.label, /…$/);
    assert.match(a.label, /stopped/);
  });
  check('cancelled metadata', () => {
    const a = browserActivity(end(entry('browser_navigate', { url: 'https://a.example' }), { cancelled: true }));
    assert.equal(a.status, 'cancelled');
    assert.doesNotMatch(a.label, /…$/);
  });
  check('interrupted metadata', () => {
    const e = entry('browser_click', { ref: 'e1' });
    e.status = 'interrupted';
    assert.match(browserActivity(e).label, /stopped/);
  });

  /* ---------- 历史 ---------- */
  console.log('\n--- I. 历史重建 ---');
  check('历史与实时同一适配器', () => {
    const live = end(entry('browser_navigate', { url: 'https://pi.dev/' }), ok({ page: { url: 'https://pi.dev/', title: 'PRIVATE_PAGE_TITLE', width: 1280, height: 720 } }));
    const h = model.entryFromHistory({ id: 'h', name: 'browser_navigate', arguments: live.args }, { content: [], details: live.details }, {});
    assert.equal(browserActivity(h).label, browserActivity(live).label);
    assert.equal(browserActivity(h).facts, browserActivity(live).facts);
    assert.deepEqual(browserActivity(h).sources, browserActivity(live).sources);
  });
  check('历史缺 result → 未完成，不猜', () => {
    const h = model.entryFromHistory({ id: 'h2', name: 'browser_navigate', arguments: { url: 'https://pi.dev/' } }, null, {});
    const a = browserActivity(h);
    assert.equal(a.status, 'incomplete');
    assert.match(a.label, /stopped/);
    assert.deepEqual(a.sources, []);
  });
  check('历史不铺原始 JSON', () => {
    const h = model.entryFromHistory({ id: 'h3', name: 'browser_fill', arguments: { ref: 'e1', value: 'PRIVATE_ARG_VALUE' } }, { content: [{ type: 'text', text: 'PRIVATE_RAW' }], details: ok({ ref: 'e1', tag: 'INPUT' }) }, {});
    const s = JSON.stringify(browserActivity(h));
    assert.ok(!s.includes('PRIVATE_ARG_VALUE') && !s.includes('PRIVATE_RAW'));
  });

  /* ---------- 能力与运行观察 ---------- */
  console.log('\n--- J. 能力状态与运行观察 ---');
  const o = createBrowserObservation();
  const registry = { extensions: [{ name: BROWSER_EXTENSION_NAME, state: { installed: true, enabled: true, loaded: null } }] };
  check('固定安装命令', () => assert.equal(BROWSER_INSTALL_COMMAND, 'pi install npm:pi-browser-harness'));
  check('没有自动安装', () => assert.equal(browserSetup(registry).automaticInstall, false));
  check('未发现', () => assert.equal(browserSetup({ extensions: [] }).installed, false));
  check('发现 ≠ 观察到', () => { assert.equal(browserSetup(registry).installed, true); assert.equal(o.snapshot(0, 1).any, false); });
  check('configured 来自 enabled 证据', () => assert.equal(browserSetup(registry).configured, true));
  check('发现但被停用', () => { const s = browserSetup({ extensions: [{ name: BROWSER_EXTENSION_NAME, state: { installed: true, enabled: false } }] }); assert.equal(s.discovered, true); assert.equal(s.configured, false); });
  check('存在推不出已配置', () => assert.equal(browserSetup({ extensions: [{ name: BROWSER_EXTENSION_NAME, state: { installed: true, enabled: null } }] }).configured, null));
  check('loaded 无证据就是未知', () => assert.equal(browserSetup(registry).loaded, null));
  check('发现失败保持未知', () => assert.equal(browserSetup({ ok: false }).installed, null));
  check('别的包名不冒充', () => assert.equal(browserSetup({ extensions: [{ name: 'pi-browser-use', state: { installed: true, enabled: true } }] }).installed, false));
  check('运行时观察', () => {
    o.observe({ type: 'tool_execution_start', toolName: 'browser_navigate', bridgeRun: 1 }, 0, 1);
    const s = o.snapshot(0, 1);
    assert.equal(s.any, true);
    assert.equal(s.count, 1);
    assert.deepEqual(s.names, ['browser_navigate']);
  });
  check('非浏览器工具不计入', () => { o.observe({ type: 'tool_execution_start', toolName: 'web_search', bridgeRun: 1 }, 0, 1); assert.equal(o.snapshot(0, 1).count, 1); });
  check('bridge 变更清空', () => assert.equal(o.snapshot(0, 2).any, false));
  check('切项目清空', () => { o.observe({ type: 'tool_execution_start', toolName: 'browser_click', bridgeRun: 2 }, 0, 2); assert.equal(o.snapshot(1, 2).any, false); });
  check('旧 run 事件被拒', () => { o.observe({ type: 'tool_execution_start', toolName: 'browser_click', bridgeRun: 1 }, 1, 2); assert.equal(o.snapshot(1, 2).any, false); });
  check('restart 生命周期清空', () => {
    o.observe({ type: 'tool_execution_start', toolName: 'browser_click', bridgeRun: 2 }, 1, 2);
    o.observe({ type: 'bridge_status', state: 'restarting', bridgeRun: 2 }, 1, 2);
    assert.equal(o.snapshot(1, 2).any, false);
  });
  check('最近列表有界、计数不丢', () => {
    const p = createBrowserObservation();
    for (const n of ['browser_click', 'browser_fill', 'browser_navigate', 'browser_wait']) p.observe({ type: 'tool_execution_start', toolName: n, bridgeRun: 1 }, 0, 1);
    const s = p.snapshot(0, 1);
    assert.equal(s.count, 4);
    assert.equal(s.names.length, 3);
    assert.equal(s.names[0], 'browser_wait');
  });
  check('入口守卫', () => {
    assert.equal(acceptBrowserEvent({ type: 'tool_execution_start', bridgeRun: 1 }, { switching: true, bridgeRun: 1 }), false);
    assert.equal(acceptBrowserEvent({ type: 'message_update' }, { switching: true, bridgeRun: 1 }), true);
    assert.equal(acceptBrowserEvent({ type: 'tool_execution_start', bridgeRun: 2 }, { switching: false, bridgeRun: 1 }), false);
    assert.equal(acceptBrowserEvent({ type: 'tool_execution_start', bridgeRun: 1 }, { switching: false, bridgeRun: 1 }), true);
  });

  /* ---------- 回归：别的适配器不受影响 ---------- */
  console.log('\n--- K. 回归 ---');
  check('web adapter 不受影响', () => {
    assert.equal(webActivity(entry('web_search', { query: 'a' })).known, true);
    assert.equal(browserActivity(entry('web_search', { query: 'a' })), null);
  });
  check('browser_web_search 不是 web_search', () => {
    assert.equal(webActivity(entry('browser_web_search', { query: 'a' })), null);
    assert.ok(browserActivity(entry('browser_web_search', { query: 'a' })));
  });
  check('browser 搜索结果只给计数与引擎', () => {
    const a = browserActivity(end(entry('browser_web_search', { query: 'pi coding agent' }), ok({ engine: 'google', results: [{}, {}], render: { body: 'PRIVATE_SERP' } })));
    assert.equal(a.label, 'Searched the web (2 results)');
    assert.equal(a.summary, 'pi coding agent');
    assert.ok(!JSON.stringify(a).includes('PRIVATE_SERP'));
  });
  check('subagent / memory 不受影响', () => {
    assert.equal(subagentActivity(entry('browser_click')), null);
    assert.equal(memoryActivity(entry('browser_click')), null);
    assert.equal(browserActivity(entry('workflow')), null);
    assert.equal(browserActivity(entry('memory_write')), null);
  });
  check('planner 不引用 browser 适配器', () => assert.doesNotMatch(src('public/planner.js'), /browser-activity|browserActivity/));
  check('未适配的 browser 工具走 generic fallback', () => assert.equal(browserActivity(entry('browser_magic')), null));
  check('普通工具不受影响', () => { assert.equal(browserActivity(entry('read')), null); assert.equal(browserActivity(entry('bash')), null); });

  /* ---------- DOM ---------- */
  console.log('\n--- L. DOM ---');
  const live = entry('browser_navigate', { url: 'https://pi.dev/' });
  const node = view.renderEntry(live);
  document.body.appendChild(node);
  check('开始渲染', () => assert.match(node.textContent, /Opening…/));
  model.applyUpdate(live, { partialResult: { content: [{ type: 'text', text: 'RAW_PARTIAL' }], details: ok() } });
  view.updateEntry(node, live);
  check('partial 原始正文不出现', () => assert.ok(!node.textContent.includes('RAW_PARTIAL')));
  check('partial 阶段仍紧凑', () => assert.ok(node.textContent.length < 600));
  end(live, ok({ page: { url: 'https://pi.dev/', width: 1280, height: 720 } }));
  view.updateEntry(node, live);
  check('同一节点更新', () => assert.equal(document.body.querySelectorAll('.tl-item').length, 1));
  check('成功文案与安全来源', () => {
    assert.match(node.textContent, /Opened pi.dev/);
    assert.equal(node.querySelector('.web-source').href, 'https://pi.dev/');
  });
  check('原始参数不进 DOM', () => assert.ok(!node.textContent.includes('{"url"')));
  check('无危险 HTML', () => assert.equal(node.querySelector('script'), null));

  const secretEntry = end(entry('browser_fill', { ref: 'e7', value: 'SUPER_SECRET_PASSWORD' }), ok({ ref: 'e7', value: 'SUPER_SECRET_PASSWORD', tag: 'INPUT' }));
  const secretNode = view.renderEntry(secretEntry);
  document.body.appendChild(secretNode);
  check('输入内容不进 DOM（含属性）', () => {
    assert.ok(!secretNode.textContent.includes('SUPER_SECRET'));
    assert.ok(!secretNode.outerHTML.includes('SUPER_SECRET'));
  });
  const unsafeEntry = end(entry('browser_navigate', { url: 'javascript:alert(1)' }), ok({ page: { url: 'javascript:alert(1)', width: 1, height: 1 } }));
  const unsafeNode = view.renderEntry(unsafeEntry);
  document.body.appendChild(unsafeNode);
  check('危险 scheme 不生成链接', () => assert.equal(unsafeNode.querySelector('a'), null));

  check('未知工具 fallback 文案', () => assert.match(view.renderEntry(entry('browser_magic')).textContent, /执行工具 browser_magic/));
  check('历史与实时渲染同一标签', () => {
    const h = model.entryFromHistory({ id: 'h', name: 'browser_navigate', arguments: live.args }, { content: [], details: live.details }, {});
    assert.equal(view.renderEntry(h).querySelector('.tl-label').textContent, node.querySelector('.tl-label').textContent);
  });

  /* ---------- setup 源码纪律 ---------- */
  console.log('\n--- M. 设置区纪律 ---');
  const setupSource = src('public/browser.js');
  const browserCapSource = src('public/browser-capabilities.js');
  check('安装后重启委托给唯一共享实现', () => {
    assert.match(setupSource, /from '\.\/ui\/capability-setup\.js'/);
    assert.doesNotMatch(setupSource, /restartBackend/);
  });
  check('共享重启流程保留失败可重试', () => assert.match(src('public/ui/capability-setup.js'), /finally \{\s*button\.disabled = false/));
  check('不假装有审批', () => {
    assert.doesNotMatch(setupSource, /from '\.\/approval\.js'/);
    assert.doesNotMatch(browserCapSource, /extension_ui_request/);
    assert.match(browserCapSource, /没有审批协议/);
  });
  check('说明与 Web Search 的区别', () => assert.match(browserCapSource, /Browser Use 与 Web Search 是两件事/));
  check('上游只给只读链接', () => assert.match(browserCapSource, /pi-browser-harness#readme/));

  dom.window.close();
  console.log(`\n${count}/${count} 通过`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
