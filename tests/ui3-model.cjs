/* UI-3B：模型选择器与 Thinking 等级选择器的专项契约测试。
 *
 * ---------- 测什么 ----------
 *
 * 视图模块的**契约**：分组与计数、当前项身份、同名模型跨 Provider、长名/大量模型、
 * Thinking 四档可用性、能力三值、pending/失败/回读、键盘漫游与焦点、回调只触发一次。
 *
 * ---------- 不测什么 ----------
 *
 * 不测像素。jsdom 不做布局（getBoundingClientRect 恒为 0）也不套用外部样式表，
 * 所以「排版对不对」在这里测不出来 —— 明暗主题、窄屏、弹层遮挡由 --real 模式
 * （真实 Chromium + CDP）覆盖，见文件末尾。
 *
 * 数据全是 fixture：不发真实网络、不启 Pi、不碰用户数据。
 *
 * 用法：
 *   node tests/ui3-model.cjs            # 纯 jsdom 契约
 *   node tests/ui3-model.cjs --real     # 额外跑真实 Chromium 并出截图
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.error(' FAIL ' + name + ': ' + e.message); }
}

const PUB = path.resolve(__dirname, '../public');

async function main() {
  /* ---------- 环境 ---------- */
  /* 视图模块按**原生 ESM** 直接 import，不经过 esm-bundle 链接器 ——
   * 链接器只从 app.js 出发跟随 import，而本模块按并行开发约定**不**改 app.js，
   * 所以它此刻还不在那张图里。UI-2B 的 runtime-display 用的是同一条路子。
   *
   * 代价是这里只覆盖视图模块本身；「接进 app.js 之后仍成立」由集成方在接线后
   * 用既有 smoke 覆盖（见验收文档的接入步骤）。 */
  /* 只放本模块真正会碰的节点：两个触发 Chip（带既有 ID 契约）+ 一个独立的宿主，
   * 不整页加载 index.html —— 那会连带把 app.js 的执行环境也拖进来。 */
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="composer"><div class="composer-bar"><div class="cb-right">
      <button type="button" class="chip" id="btnModel" aria-controls="composerPopover" aria-expanded="false">
        <span class="chip-dot"></span><span id="modelText">模型</span>
      </button>
      <button type="button" class="chip" id="btnThink" aria-controls="composerPopover" aria-expanded="false">
        <span id="thinkText">思考 —</span>
      </button>
    </div></div></div>
  </body></html>`, { url: 'http://localhost:7788', pretendToBeVisual: true });
  const w = dom.window;
  global.window = w;
  global.document = w.document;
  w.HTMLElement.prototype.scrollIntoView = () => {};

  const view = await import('../public/ui3-model-picker.js');
  const doc = w.document;
  const pop = () => doc.querySelector('.pop');

  /* 断言导出真的存在 —— 否则下面所有断言都在测空气。 */
  await check('视图模块导出契约完整', () => {
    for (const name of ['renderModelPicker', 'renderThinkingPicker', 'thinkingAvailability',
      'capabilityFacts', 'modelDisplayLabel', 'applyChipState', 'setTriggers', 'THINK_DESC']) {
      assert.ok(typeof view[name] !== 'undefined', `缺少导出 ${name}`);
    }
  });

  /* 接线前必须能被链接器接受：esm-bundle 会拒绝 default / 命名空间 / 裸导入 /
   * 动态 import() / re-export，遇到就抛。先静态挡一道，免得集成时才发现。 */
  await check('模块写法能被 esm-bundle 链接器接受', () => {
    const src = fs.readFileSync(path.join(PUB, 'ui3-model-picker.js'), 'utf8');
    assert.ok(!/^\s*export\s+default/m.test(src), '不能有 default 导出');
    assert.ok(!/^\s*import\s*\*/m.test(src), '不能有命名空间导入');
    assert.ok(!/^\s*import\s+['"]/m.test(src), '不能有裸导入');
    assert.ok(!/\bimport\s*\(/.test(src), '不能有动态 import()');
    assert.ok(!/^\s*export\s+\*\s*from/m.test(src), '不能有 re-export');
    assert.ok(!/^\s*import\s+[A-Za-z_$][\w$]*\s*(,|from)/m.test(src), '不能有默认导入');
  });

  /* ---------- 纯函数：Thinking 可用性（四值 + pending） ---------- */
  await check('thinkingAvailability 区分五种状态，不把它们压成一句', () => {
    const base = { levels: ['off', 'low', 'high'], model: { provider: 'p', id: 'm', reasoning: true } };
    assert.equal(view.thinkingAvailability({ ...base, pending: true }).state, 'pending');
    assert.equal(view.thinkingAvailability({ model: null, levels: [] }).state, 'no-model');
    assert.equal(view.thinkingAvailability({ model: { provider: 'p', id: 'm', reasoning: false }, levels: [] }).state, 'unsupported');
    /* reasoning=true 但 Pi 没给档位 —— 是「没给」不是「不支持」 */
    assert.equal(view.thinkingAvailability({ model: { provider: 'p', id: 'm', reasoning: true }, levels: [] }).state, 'unavailable');
    /* 没有 reasoning 证据 —— 未知，既不是不支持也不是没给 */
    assert.equal(view.thinkingAvailability({ model: { provider: 'p', id: 'm' }, levels: [] }).state, 'unknown');
    assert.equal(view.thinkingAvailability({ ...base }).state, 'ready');
    /* 五种状态两两不同，没有哪一种被折叠进另一种 */
    const states = ['pending', 'no-model', 'unsupported', 'unavailable', 'unknown', 'ready'];
    assert.equal(new Set(states).size, states.length);
  });

  await check('Pi 的实时档位优先于静态 reasoning=false', () => {
    /* 上游 metadata 说 reasoning=false，但 Pi 回读了 off/low/high —— 以 Pi 为准。
       （smoke「reasoning=false 仍按 Pi 返回两档」钉的是同一条，这里从视图侧再钉一次。） */
    const a = view.thinkingAvailability({ model: { provider: 'p', id: 'm', reasoning: false }, levels: ['off', 'low', 'high'] });
    assert.equal(a.state, 'ready');
    assert.deepEqual(a.usable, ['low', 'high']);
  });

  await check('只有 off 的清单视为不可用', () => {
    const a = view.thinkingAvailability({ model: { provider: 'p', id: 'm', reasoning: true }, levels: ['off'] });
    assert.equal(a.state, 'unavailable');
    assert.deepEqual(a.usable, []);
  });

  await check('能力未知不显示成不支持', () => {
    const facts = view.capabilityFacts({ provider: 'p', id: 'm' });
    assert.ok(facts.rows.every((r) => r.state === 'unknown'));
    assert.equal(facts.anyKnown, false);
  });

  await check('明确 false 与 unknown 在能力行里是不同的值', () => {
    const facts = view.capabilityFacts({ provider: 'p', id: 'm', reasoning: false, input: ['text'] });
    const byKey = Object.fromEntries(facts.rows.map((r) => [r.key, r.state]));
    assert.equal(byKey.reasoning, 'no');
    assert.equal(byKey.imageInput, 'no');   /* input:['text'] 是明确的「不支持图片」 */
    assert.equal(byKey.toolCalling, 'unknown'); /* 没提到 ≠ 不支持 */
    assert.equal(facts.anyKnown, true);
  });

  await check('Runtime 标签能分辨同名不同 Provider 的模型', () => {
    const a = view.modelDisplayLabel({ provider: 'alpha', id: 'same', name: 'Same' });
    const b = view.modelDisplayLabel({ provider: 'beta', id: 'same', name: 'Same' });
    assert.equal(a, 'Same · alpha');
    assert.equal(b, 'Same · beta');
    assert.notEqual(a, b);
  });

  /* ---------- 渲染：两栏、最近使用与计数 ---------- */
  const MODELS = [
    { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: true },
    { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: false },
    { provider: 'zhipu', id: 'glm-4.6', name: 'GLM-4.6', reasoning: true },
    /* 两个 Provider 含同名模型 —— 身份必须靠 Provider + id 判定 */
    { provider: 'openrouter', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    { provider: 'openrouter', id: 'long', name: 'L'.repeat(180) },
  ];
  const expanded = new Set();
  let picked = [];
  let pickedThinking = [];
  const openModels = (current, models = MODELS, extra = {}) => view.renderModelPicker({
    models, current, expanded,
    levels: ['off', 'low', 'medium', 'high'], currentLevel: 'medium',
    onSelect: (p, id) => picked.push([p, id]),
    onSelectThinking: (lv) => pickedThinking.push(lv),
    ...extra,
  });
  const railItems = () => [...pop().querySelectorAll('.model-rail-item')];
  const railLabels = () => railItems().map((n) => n.querySelector('.model-rail-name').textContent);
  const railCounts = () => railItems().map((n) => n.querySelector('.model-rail-count').textContent);
  const selectSection = (section) => railItems().find((n) => n.dataset.section === section).click();
  const rows = () => [...pop().querySelectorAll('.ui3-model-item')];
  const currentModel = MODELS[0];
  w.localStorage.clear();

  openModels(currentModel);
  await check('左栏按「最近使用 + 已配置供应商」排列，计数准确', () => {
    assert.deepEqual(railLabels(), ['最近使用', 'deepseek', 'zhipu', 'openrouter']);
    assert.deepEqual(railCounts(), ['1', '2', '1', '2']);
  });
  await check('默认打开最近使用，右栏只画该来源的模型', () => {
    assert.equal(pop().querySelector('.model-pane-title').textContent, '最近使用');
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].dataset.provider, 'deepseek');
    assert.equal(rows()[0].dataset.modelId, 'deepseek-reasoner');
  });
  await check('点击左栏供应商切换右栏，不重建另一套弹层', () => {
    selectSection('provider:deepseek');
    assert.equal(pop().querySelector('.model-pane-title').textContent, 'deepseek');
    assert.equal(pop().querySelector('.model-pane-count').textContent, '2');
    assert.deepEqual(rows().map((n) => n.dataset.modelId), ['deepseek-reasoner', 'deepseek-chat']);
    assert.equal(doc.querySelectorAll('.pop').length, 1);
  });
  await check('当前模型恰好一个选中项，且带 aria-current', () => {
    assert.equal(pop().querySelectorAll('.ui3-model-item.on').length, 1);
    assert.equal(pop().querySelectorAll('[aria-current="true"]').length, 1);
    assert.equal(pop().querySelector('.ui3-model-item.on').dataset.modelId, 'deepseek-reasoner');
  });
  await check('两个 Provider 的同名模型只有真正当前的那个被选中', () => {
    openModels({ provider: 'openrouter', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' });
    assert.equal(rows().length, 1, '最近使用里只有当前模型');
    assert.equal(rows()[0].dataset.provider, 'openrouter');
    assert.ok(rows()[0].classList.contains('on'));
    selectSection('provider:deepseek');
    const twin = rows().find((n) => n.dataset.modelId === 'deepseek-reasoner');
    assert.ok(twin && !twin.classList.contains('on'), 'deepseek 的同名条目不能被选中');
    assert.equal(pop().querySelectorAll('.ui3-model-item.on').length, 0);
    selectSection('provider:openrouter');
    assert.equal(pop().querySelector('.ui3-model-item.on').dataset.provider, 'openrouter');
  });
  await check('最近使用行带供应商信息，便于区分同名模型', () => {
    openModels({ provider: 'openrouter', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' });
    const sub = rows()[0].querySelector('.pi-sub').textContent;
    assert.ok(sub.includes('openrouter'), sub);
  });

  /* ---------- 搜索 ---------- */
  await check('搜索跨供应商过滤，并在左栏显示匹配数量', () => {
    openModels(currentModel);
    const search = pop().querySelector('.ui3-model-search');
    search.focus();
    search.value = 'GLM'; search.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(pop().querySelector('.model-pane-title').textContent, '搜索结果');
    assert.equal(pop().querySelector('.model-pane-count').textContent, '1');
    assert.deepEqual(railLabels(), ['搜索结果', 'zhipu']);
    assert.deepEqual(railCounts(), ['1', '1']);
    assert.deepEqual(rows().map((n) => n.dataset.provider), ['zhipu']);
    assert.equal(pop().querySelector('.ui3-model-search').value, 'GLM', '保留用户输入的大小写');
    assert.equal(doc.activeElement, pop().querySelector('.ui3-model-search'));
  });
  await check('搜索按名称、ID、Provider 匹配；清空后回到原来源', () => {
    let search = pop().querySelector('.ui3-model-search');
    search.focus();
    search.value = 'deepseek'; search.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(rows().length, 3, 'deepseek 两个 + openrouter 同名的一个都应命中');
    search = pop().querySelector('.ui3-model-search');
    search.focus();
    search.value = ''; search.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.deepEqual(railLabels(), ['最近使用', 'deepseek', 'zhipu', 'openrouter']);
    assert.equal(pop().querySelector('.model-pane-title').textContent, '最近使用');
  });
  await check('搜索同一模型名时按供应商分组，身份不混', () => {
    const search = pop().querySelector('.ui3-model-search');
    search.value = 'deepseek-reasoner'; search.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(rows().length, 2);
    assert.deepEqual(rows().map((n) => n.dataset.provider), ['deepseek', 'openrouter']);
    assert.deepEqual([...pop().querySelectorAll('.model-group-label')].map((n) => n.textContent), ['deepseek', 'openrouter']);
    assert.equal(pop().querySelectorAll('.ui3-model-item.on').length, 1);
    assert.equal(pop().querySelector('.ui3-model-item.on').dataset.provider, 'deepseek');
  });
  await check('无匹配显示空状态与 0 计数，不触发选择', () => {
    const before = picked.length;
    const search = pop().querySelector('.ui3-model-search');
    search.value = 'no-such-model'; search.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(rows().length, 0);
    assert.equal(pop().querySelector('.model-menu-empty').textContent, '没有匹配的模型');
    assert.equal(pop().querySelector('.model-pane-count').textContent, '0');
    assert.equal(railCounts()[0], '0');
    assert.equal(picked.length, before);
  });
  await check('搜索框 ArrowDown 进入匹配项，Enter 不擅自选择', () => {
    openModels(currentModel);
    const search = pop().querySelector('.ui3-model-search');
    const before = picked.length;
    search.value = 'glm'; search.dispatchEvent(new w.Event('input', { bubbles: true }));
    const field = pop().querySelector('.ui3-model-search');
    field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    assert.equal(doc.activeElement.dataset.modelId, 'glm-4.6');
    field.focus();
    const event = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(picked.length, before);
  });
  await check('Escape 先清搜索，再关闭并归还焦点', () => {
    const btn = doc.getElementById('btnModel');
    view.setTriggers({ model: btn });
    openModels(currentModel);
    let search = pop().querySelector('.ui3-model-search');
    search.focus();
    search.value = 'glm'; search.dispatchEvent(new w.Event('input', { bubbles: true }));
    search = pop().querySelector('.ui3-model-search');
    search.focus();
    search.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(pop().hidden, false, '第一次 Escape 只清搜索');
    assert.equal(pop().querySelector('.ui3-model-search').value, '');
    assert.equal(doc.activeElement, pop().querySelector('.ui3-model-search'));
    search = pop().querySelector('.ui3-model-search');
    search.focus();
    search.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(pop().hidden, true);
    assert.equal(doc.activeElement, btn);
  });

  /* ---------- 选择回调与 pending ---------- */
  picked = [];
  await check('选择后回调带 Provider + modelId，只触发一次且菜单保持打开', () => {
    openModels(currentModel);
    selectSection('provider:openrouter');
    const target = rows().find((n) => n.dataset.modelId === 'deepseek-reasoner');
    target.click();
    assert.deepEqual(picked, [['openrouter', 'deepseek-reasoner']]);
    assert.equal(pop().hidden, false, '切换未回读前保持菜单，等待权威状态');
  });
  await check('选择后写入最近使用（只存身份，去重且封顶）', () => {
    const recent = view.readRecentModelIdentities();
    assert.deepEqual(recent[0], { providerId: 'openrouter', modelId: 'deepseek-reasoner' });
    for (let i = 0; i < 8; i++) view.rememberRecentModel('p', 'm' + i);
    const capped = view.readRecentModelIdentities();
    assert.equal(capped.length, 6);
    assert.deepEqual(capped[0], { providerId: 'p', modelId: 'm7' });
    assert.equal(new Set(capped.map((x) => x.providerId + '/' + x.modelId)).size, capped.length);
    w.localStorage.clear();
  });
  await check('pending 显示切换状态；连点仍交给 setModel 的既有队列', () => {
    picked = [];
    openModels(currentModel, MODELS, { pending: true });
    assert.equal(pop().querySelector('.model-menu-pending').textContent, '正在切换模型…');
    assert.equal(pop().querySelector('.model-pane-list').getAttribute('aria-busy'), 'true');
    selectSection('provider:deepseek');
    const next = rows().find((n) => !n.classList.contains('on'));
    next.click();
    assert.equal(picked.length, 1, '下一次选择仍会交给调用方排队，不静默丢弃');
  });
  await check('顶部齿轮打开既有模型设置并关闭菜单', () => {
    let opened = 0;
    openModels(currentModel, MODELS, { onOpenSettings: () => { opened++; } });
    pop().querySelector('.model-menu-settings').click();
    assert.equal(opened, 1);
    assert.equal(pop().hidden, true);
  });

  /* ---------- 长名 / 大量模型 / 注入 ---------- */
  const many = [];
  for (let i = 0; i < 400; i++) many.push({ provider: 'router', id: `model-${i}`, name: `Router Model ${i}` });
  many.push({ provider: 'router', id: 'x'.repeat(300), name: 'Long '.repeat(60) });
  await check('400+ 模型与超长名不抛错且计数正确', () => {
    openModels(null, many);
    assert.equal(rows().length, many.length);
    assert.equal(railCounts()[0], String(many.length));
    const long = rows().at(-1);
    assert.ok(long.querySelector('.pi-text').textContent.length > 200);
    assert.ok(!pop().querySelector('img'));
  });
  await check('长名写入 textContent，不产生元素注入', () => {
    openModels({ provider: 'evil', id: '<img src=x onerror=alert(1)>', name: '<img src=x onerror=alert(1)>' },
      [{ provider: 'evil', id: '<img src=x onerror=alert(1)>', name: '<img src=x onerror=alert(1)>' }]);
    assert.equal(pop().querySelectorAll('img').length, 0);
    assert.ok(pop().textContent.includes('<img src=x onerror=alert(1)>'));
  });
  await check('空模型列表显示空状态，不抛错', () => {
    view.renderModelPicker({ models: [], current: null });
    assert.ok(pop().querySelector('.model-menu-empty'));
    assert.equal(pop().querySelectorAll('.ui3-model-item').length, 0);
    assert.equal(pop().querySelector('.ui3-think-state').dataset.state, 'no-model');
  });

  /* ---------- 键盘漫游 ---------- */
  openModels(currentModel);
  selectSection('provider:deepseek');
  const navs = () => [...pop().querySelectorAll('.model-rail-item, .ui3-model-item')]
    .filter((n) => !n.disabled && !n.closest('[hidden]'));
  const press = (node, key) => {
    node.focus();
    const ev = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    node.dispatchEvent(ev);
    return ev;
  };
  await check('↑↓ 在左栏与模型行之间移动', () => {
    const list = navs();
    assert.ok(list.length >= 4);
    list[1].focus();
    press(list[1], 'ArrowDown');
    assert.equal(doc.activeElement, list[2]);
    press(list[2], 'ArrowUp');
    assert.equal(doc.activeElement, list[1]);
  });
  await check('End / Home 跳到首末，↑ 从首项回绕', () => {
    const list = navs();
    list[0].focus();
    press(list[0], 'End');
    assert.equal(doc.activeElement, list[list.length - 1]);
    press(list[list.length - 1], 'Home');
    assert.equal(doc.activeElement, list[0]);
    press(list[0], 'ArrowUp');
    assert.equal(doc.activeElement, list[list.length - 1]);
  });
  await check('roving tabindex：列表里只有一个停靠点', () => {
    const list = navs();
    assert.equal(list.filter((n) => n.tabIndex === 0).length, 1);
  });
  await check('← 从模型行进入左栏，→ 从栏目进入模型行', () => {
    const row = navs().find((n) => n.classList.contains('ui3-model-item'));
    press(row, 'ArrowLeft');
    const rail = doc.activeElement;
    assert.ok(rail.classList.contains('model-rail-item'));
    assert.ok(rail.classList.contains('on'));
    press(rail, 'ArrowRight');
    assert.ok(doc.activeElement.classList.contains('ui3-model-item'));
  });
  await check('原生点击选择路径只触发一次回调', () => {
    picked = [];
    const item = navs().find((n) => n.classList.contains('ui3-model-item') && !n.classList.contains('on'));
    item.focus();
    item.click();
    assert.equal(picked.length, 1);
  });

  /* ---------- 底部分段推理滑杆 ---------- */
  await check('滑杆档位完全来自 Pi 返回，不硬编码 off..max', () => {
    openModels(currentModel, MODELS, { levels: ['off', 'low', 'high'], currentLevel: 'low' });
    assert.deepEqual([...pop().querySelectorAll('.ui3-think-item')].map((n) => n.dataset.level), ['off', 'low', 'high']);
    assert.equal(pop().querySelectorAll('.ui3-think-item.on').length, 1);
    assert.equal(pop().querySelector('.ui3-think-item.on').dataset.level, 'low');
  });
  await check('滑杆等宽分段、原生 range 值与当前档位一致', () => {
    openModels(currentModel, MODELS, { levels: ['off', 'low', 'medium', 'high'], currentLevel: 'medium' });
    const slider = pop().querySelector('.model-thinking-slider');
    assert.equal(slider.style.getPropertyValue('--stop-count'), '4');
    assert.ok(slider.style.getPropertyValue('--thinking-progress').startsWith('50'));
    const range = pop().querySelector('.model-thinking-range');
    assert.equal(range.value, '2');
    assert.equal(range.getAttribute('aria-valuetext'), 'medium');
    assert.equal(range.disabled, false);
    assert.equal(pop().querySelectorAll('.ui3-think-item').length, 4);
  });
  await check('点击档位回调一次并保持打开，未回读前不乐观改选中态', () => {
    pickedThinking = [];
    openModels(currentModel, MODELS, { levels: ['off', 'low', 'medium', 'high'], currentLevel: 'medium' });
    const high = [...pop().querySelectorAll('.ui3-think-item')].find((n) => n.dataset.level === 'high');
    high.click();
    assert.deepEqual(pickedThinking, ['high']);
    assert.equal(pop().hidden, false);
    assert.equal(pop().querySelector('.ui3-think-item.on').dataset.level, 'medium', '回读前仍显示权威 current');
    assert.equal(pop().querySelector('.model-thinking-range').disabled, true, '提交未收口前禁止再次提交');
    openModels(currentModel, MODELS, { levels: ['off', 'low', 'medium', 'high'], currentLevel: 'high' });
    assert.equal(pop().querySelector('.ui3-think-item.on').dataset.level, 'high');
  });
  await check('档位不可用时画出来但不可提交，原因来自 availability', () => {
    pickedThinking = [];
    openModels(MODELS[1], MODELS, { levels: [], currentLevel: null });
    const state = pop().querySelector('.ui3-think-state');
    assert.equal(state.dataset.state, 'unsupported');
    assert.ok(state.textContent.includes('不支持推理'));
    assert.equal(pop().querySelectorAll('.ui3-think-item').length, 0);
    assert.equal(pickedThinking.length, 0);
  });
  await check('pending 时滑杆与档位全部禁用', () => {
    openModels(currentModel, MODELS, { levels: ['off', 'low', 'high'], currentLevel: 'low', pending: true });
    assert.equal(pop().querySelector('.model-thinking-range').disabled, true);
    assert.ok([...pop().querySelectorAll('.ui3-think-item')].every((n) => n.disabled));
    const state = pop().querySelector('.ui3-think-state');
    assert.equal(state.dataset.state, 'pending');
  });
  await check('未知 / 重复档位被过滤，不污染渲染', () => {
    openModels(currentModel, MODELS, { levels: ['off', 'off', null, 42, '', 'high'], currentLevel: 'off' });
    assert.deepEqual([...pop().querySelectorAll('.ui3-think-item')].map((n) => n.dataset.level), ['off', 'high']);
  });

  /* ---------- Thinking ---------- */
  const openThink = (o) => view.renderThinkingPicker({
    onSelect: (lv) => picked.push(['think', lv]), onClose: () => {}, ...o,
  });
  await check('可用档位按 Pi 返回原样渲染，不加也不减', () => {
    picked = [];
    openThink({ levels: ['off', 'low', 'high'], current: 'low', model: { provider: 'p', id: 'm', reasoning: true } });
    assert.deepEqual([...pop().querySelectorAll('.ui3-think-item')].map((n) => n.dataset.level), ['off', 'low', 'high']);
    assert.equal(pop().querySelectorAll('.ui3-think-item.on').length, 1);
    assert.equal(pop().querySelector('.ui3-think-item.on').dataset.level, 'low');
  });
  await check('不存在的档位不会凭空出现（不硬编码 off..max）', () => {
    openThink({ levels: ['off', 'medium'], current: 'medium', model: { provider: 'p', id: 'm', reasoning: true } });
    const levels = [...pop().querySelectorAll('.ui3-think-item')].map((n) => n.dataset.level);
    assert.deepEqual(levels, ['off', 'medium']);
    for (const absent of ['minimal', 'low', 'high', 'xhigh', 'max']) assert.ok(!levels.includes(absent));
  });
  await check('档位说明来自展示文案，未知档位不编造说明', () => {
    openThink({ levels: ['off', 'quantum'], current: 'off', model: { provider: 'p', id: 'm', reasoning: true } });
    const items = [...pop().querySelectorAll('.ui3-think-item')];
    assert.equal(items[0].querySelector('.pi-sub').textContent, view.THINK_DESC.off);
    /* quantum 不在文案表里 —— 不画说明行，而不是编一句。 */
    assert.equal(items[1].querySelector('.pi-sub'), null);
    assert.equal(items[1].querySelector('.pi-text').textContent, 'quantum');
  });
  await check('推理能力 false：明确不可用，档位画出来但不可点', () => {
    picked = [];
    openThink({ levels: [], current: null, model: { provider: 'p', id: 'm', reasoning: false } });
    const state = pop().querySelector('.ui3-think-state');
    assert.equal(state.dataset.state, 'unsupported');
    assert.ok(state.textContent.includes('不支持推理'));
    assert.equal(pop().querySelectorAll('.ui3-think-item').length, 0);
  });
  await check('推理能力 unknown：不显示成已支持', () => {
    openThink({ levels: [], current: null, model: { provider: 'p', id: 'm' } });
    const state = pop().querySelector('.ui3-think-state');
    assert.equal(state.dataset.state, 'unknown');
    assert.ok(!/不支持/.test(state.textContent), '未知不能说成不支持');
  });
  await check('Pi 没给档位：说明是「没给」而不是「不支持」', () => {
    openThink({ levels: [], current: null, model: { provider: 'p', id: 'm', reasoning: true } });
    assert.equal(pop().querySelector('.ui3-think-state').dataset.state, 'unavailable');
  });
  await check('pending 优先于其它一切判断', () => {
    openThink({ levels: ['off', 'low'], current: 'low', model: { provider: 'p', id: 'm', reasoning: true }, pending: true });
    assert.equal(pop().querySelector('.ui3-think-state').dataset.state, 'pending');
    assert.ok([...pop().querySelectorAll('.ui3-think-item')].every((n) => n.disabled));
  });
  await check('pending 时点击档位不产生回调', () => {
    picked = [];
    const item = pop().querySelector('.ui3-think-item');
    item.click();
    assert.deepEqual(picked, []);
  });
  await check('可用时选档位回调一次并关闭', () => {
    picked = [];
    openThink({ levels: ['off', 'low', 'high'], current: 'off', model: { provider: 'p', id: 'm', reasoning: true } });
    pop().querySelectorAll('.ui3-think-item')[2].click();
    assert.deepEqual(picked, [['think', 'high']]);
    assert.equal(pop().hidden, true);
  });
  await check('可用时不画状态行（「有 3 档」不是信息）', () => {
    openThink({ levels: ['off', 'low', 'high'], current: 'low', model: { provider: 'p', id: 'm', reasoning: true } });
    assert.equal(pop().querySelectorAll('.ui3-think-state').length, 0);
  });
  await check('Thinking 弹层不套 model-mode（不受模型高度钳制）', () => {
    openThink({ levels: ['off', 'high'], current: 'off', model: { provider: 'p', id: 'm', reasoning: true } });
    assert.ok(!pop().classList.contains('model-mode'));
  });

  /* ---------- 回读 / 失败：视图不保留乐观选择 ---------- */
  await check('pending 期间选中态只反映调用方传入的 current，且条目不可点', () => {
    openThink({ levels: ['off', 'low', 'high'], current: 'low', model: { provider: 'p', id: 'm', reasoning: true }, pending: true });
    const on = [...pop().querySelectorAll('.ui3-think-item.on')];
    /* 标出来的必须是**调用方给的** current —— 那是回读值，不是乐观值。 */
    assert.equal(on.length, 1);
    assert.equal(on[0].dataset.level, 'low');
    assert.ok([...pop().querySelectorAll('.ui3-think-item')].every((n) => n.disabled));
  });
  await check('无乐观选择：点击后视图不自己改选中态', () => {
    /* 用户点了 high，但调用方还没回读确认 —— 视图必须仍然显示 low。
     * 「设置失败后保留虚假的乐观选择」因此在结构上不可能发生：视图从不写 current。 */
    picked = [];
    openThink({ levels: ['off', 'low', 'high'], current: 'low', model: { provider: 'p', id: 'm', reasoning: true } });
    const high = [...pop().querySelectorAll('.ui3-think-item')].find((n) => n.dataset.level === 'high');
    high.click();
    assert.deepEqual(picked, [['think', 'high']], '回调照发');
    /* 重新渲染时仍以调用方传入的 current 为准（弹层已关，重开验证）。 */
    openThink({ levels: ['off', 'low', 'high'], current: 'low', model: { provider: 'p', id: 'm', reasoning: true } });
    assert.equal(pop().querySelector('.ui3-think-item.on').dataset.level, 'low', '未回读前不得显示 high');
  });
  await check('设置失败后回读纠正：视图只反映传入的 current', () => {
    openThink({ levels: ['off', 'low', 'high'], current: 'off', model: { provider: 'p', id: 'm', reasoning: true } });
    assert.equal(pop().querySelector('.ui3-think-item.on').dataset.level, 'off');
    openThink({ levels: ['off', 'low', 'high'], current: 'high', model: { provider: 'p', id: 'm', reasoning: true } });
    assert.equal(pop().querySelector('.ui3-think-item.on').dataset.level, 'high');
  });
  await check('空列表 + 无当前模型不抛错', () => {
    openThink({ levels: [], current: null, model: null });
    assert.equal(pop().querySelector('.ui3-think-state').dataset.state, 'no-model');
  });
  await check('非字符串 / 重复档位被过滤，不污染渲染', () => {
    openThink({ levels: ['off', 'off', null, 42, '', 'high'], current: 'off', model: { provider: 'p', id: 'm', reasoning: true } });
    assert.deepEqual([...pop().querySelectorAll('.ui3-think-item')].map((n) => n.dataset.level), ['off', 'high']);
  });

  /* ---------- Chip 状态 ---------- */
  await check('applyChipState 写 data-ui3-state，清空时移除属性', () => {
    const chip = doc.getElementById('btnThink');
    view.applyChipState(chip, 'unsupported');
    assert.equal(chip.dataset.ui3State, 'unsupported');
    view.applyChipState(chip, '');
    assert.equal(chip.hasAttribute('data-ui3-state'), false);
    view.applyChipState(null, 'ready'); /* 不抛错 */
  });
  await check('弹层沿用既有 ID 契约，未另建一套全局弹层', () => {
    assert.equal(pop().id, 'composerPopover');
    assert.equal(pop().className.split(' ').includes('pop'), true);
    /* 整个文档里只有一个 .pop —— 本模块没有偷偷创建第二个弹层。 */
    assert.equal(doc.querySelectorAll('.pop').length, 1);
    /* 触发 Chip 的既有 ID 与 aria 契约原样保留（本模块只写 aria-expanded）。 */
    const btn = doc.getElementById('btnModel');
    assert.equal(btn.getAttribute('aria-controls'), 'composerPopover');
    assert.equal(doc.getElementById('btnThink').getAttribute('aria-controls'), 'composerPopover');
  });

  await check('上下文浮层在触发按钮保留焦点时 Escape 关闭并还原焦点', async () => {
    const { openPop } = await import('../public/ui/popover.js');
    const anchor = doc.createElement('button'); anchor.type = 'button'; doc.body.append(anchor);
    openPop(anchor, { tip: true }); anchor.focus();
    anchor.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(pop().hidden, true); assert.equal(doc.activeElement, anchor);
    assert.equal(anchor.getAttribute('aria-expanded'), 'false');
  });
  console.log(`\nUI-3B 模型选择器: ${pass}/${pass + fail} 通过`);

  /* ---------- 真实渲染（可选） ---------- */
  if (process.argv.includes('--real')) {
    const { realRender } = require('./ui3-model-real.cjs');
    const real = await realRender({ out: path.join(__dirname, '..', '.shots', 'ui3-model') });
    pass += real.pass; fail += real.fail;
    console.log(`\nUI-3B 合计（含真实渲染）: ${pass}/${pass + fail} 通过`);
  }

  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
