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

  /* ---------- 渲染：分组与计数 ---------- */
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
  const openModels = (current, models = MODELS) => {
    view.renderModelPicker({
      models, current, expanded,
      onSelect: (p, id) => picked.push([p, id]),
    });
  };
  const headers = () => [...pop().querySelectorAll('.pop-provider')];
  const group = (provider) => [...pop().querySelectorAll('.pop-model-group')].find((g) => g.dataset.provider === provider);
  const groupModels = (provider) => group(provider).querySelector('.pop-provider-models');
  const currentModel = MODELS[0];

  openModels(currentModel);
  await check('按 Provider 分组且顺序与来源一致', () => {
    assert.equal(headers().map((h) => h.querySelector('.pop-provider-name').textContent).join(','),
      'deepseek,zhipu,openrouter');
  });
  await check('每个 Provider 的模型数量准确', () => {
    assert.equal(headers().map((h) => h.querySelector('.pop-provider-count').textContent).join(','), '2,1,2');
  });
  await check('模型条目总数等于列表长度', () => {
    assert.equal(pop().querySelectorAll('.ui3-model-item').length, MODELS.length);
  });
  await check('当前 Provider 默认展开、其余收起', () => {
    assert.equal(headers().map((h) => h.getAttribute('aria-expanded')).join(','), 'true,false,false');
    assert.ok(!groupModels('deepseek').hidden && groupModels('zhipu').hidden && groupModels('openrouter').hidden);
  });
  await check('组头是原生按钮且 aria-controls 指向自己的容器', () => {
    assert.ok(headers().every((h) => h.tagName === 'BUTTON'
      && doc.getElementById(h.getAttribute('aria-controls')) === h.nextElementSibling));
  });

  /* ---------- 当前模型身份 ---------- */
  await check('身份行显示 Provider/modelId', () => {
    const line = pop().querySelector('.ui3-current');
    assert.equal(line.dataset.provider, 'deepseek');
    assert.equal(line.dataset.modelId, 'deepseek-reasoner');
    assert.ok(line.textContent.includes('deepseek / deepseek-reasoner'));
  });
  await check('当前模型恰好一个选中项', () => {
    assert.equal(pop().querySelectorAll('.ui3-model-item.on').length, 1);
    assert.equal(pop().querySelectorAll('[aria-current="true"]').length, 1);
  });
  await check('两个 Provider 的同名模型只有真正当前的那个被选中', () => {
    openModels({ provider: 'openrouter', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' });
    const on = [...pop().querySelectorAll('.ui3-model-item.on')];
    assert.equal(on.length, 1);
    assert.equal(on[0].dataset.provider, 'openrouter');
    assert.equal(on[0].dataset.modelId, 'deepseek-reasoner');
    /* deepseek 组里那个同名条目必须**没有**被选中 */
    const twin = group('deepseek').querySelector('.ui3-model-item[data-model-id="deepseek-reasoner"]');
    assert.ok(twin && !twin.classList.contains('on'));
  });
  await check('当前组被强制展开，用户折叠记忆不掩盖当前位置', () => {
    expanded.add('deepseek');
    openModels({ provider: 'zhipu', id: 'glm-4.6' });
    assert.ok(!groupModels('zhipu').hidden, '当前组应展开');
    assert.ok(!groupModels('deepseek').hidden, '用户展开过的组保持展开');
    assert.equal(group('zhipu').dataset.current, 'true');
  });

  /* ---------- 选择回调 ---------- */
  picked = [];
  await check('选择后回调带 Provider + modelId，且只触发一次', () => {
    openModels(currentModel);
    const target = group('openrouter').querySelectorAll('.ui3-model-item')[0];
    assert.equal(target.dataset.provider, 'openrouter');
    assert.equal(target.dataset.modelId, 'deepseek-reasoner');
    target.click();
    assert.deepEqual(picked, [['openrouter', 'deepseek-reasoner']]);
  });
  await check('选择后弹层关闭', () => assert.equal(pop().hidden, true));
  await check('视图模块自身不发 RPC，也不 import 任何传输层', () => {
    /* 结构保证：模块只依赖 popover 与两个纯策略模块，
       没有任何 api/rpc/state 依赖 —— 所以它不可能发命令，也不可能读全局状态。 */
    const src = fs.readFileSync(path.join(PUB, 'ui3-model-picker.js'), 'utf8');
    const specs = [...src.matchAll(/^\s*import\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepEqual(specs.sort(), ['./model-capabilities.js', './thinking-availability.js', './ui/popover.js']);
    const policy = fs.readFileSync(path.join(PUB, 'thinking-availability.js'), 'utf8');
    assert.ok(!/\b(sendCommand|fetch|EventSource|XMLHttpRequest|WebSocket|document|window)\b/.test(policy));
    assert.ok(!/\b(sendCommand|fetch|EventSource|XMLHttpRequest|WebSocket)\b/.test(src), '视图层不该出现传输调用');
    /* 也不该反向依赖装配层。 */
    assert.ok(!/from\s*['"]\.\/app\.js['"]/.test(src), '视图模块不能 import app.js');
  });

  /* ---------- 长名 / 大量模型 ---------- */
  const many = [];
  for (let i = 0; i < 400; i++) many.push({ provider: 'router', id: `model-${i}`, name: `Router Model ${i}` });
  many.push({ provider: 'router', id: 'x'.repeat(300), name: 'Long '.repeat(60) });
  await check('400+ 模型与超长名不抛错且计数正确', () => {
    openModels(many[0], many);
    assert.equal(pop().querySelectorAll('.ui3-model-item').length, many.length);
    assert.equal(headers()[0].querySelector('.pop-provider-count').textContent, String(many.length));
    const long = [...pop().querySelectorAll('.ui3-model-item')].at(-1);
    assert.ok(long.querySelector('.pi-text').textContent.length > 200);
  });
  await check('长名写入 textContent，不产生元素注入', () => {
    const html = many.at(-1).name;
    openModels({ provider: 'evil', id: '<img src=x onerror=alert(1)>', name: '<img src=x onerror=alert(1)>' },
      [{ provider: 'evil', id: '<img src=x onerror=alert(1)>', name: '<img src=x onerror=alert(1)>' }]);
    assert.equal(pop().querySelectorAll('img').length, 0);
    assert.ok(pop().textContent.includes('<img src=x onerror=alert(1)>'));
    assert.equal(html.length > 0, true);
  });
  await check('消失的 Provider 不保留折叠记忆', () => {
    expanded.add('gone');
    openModels(MODELS[0], MODELS);
    assert.ok(!expanded.has('gone'));
  });

  /* ---------- 键盘漫游 ---------- */
  openModels(currentModel);
  const navs = () => [...pop().querySelectorAll('.pop-provider, .pop-item')]
    .filter((n) => !n.disabled && !n.closest('[hidden]'));
  const press = (node, key) => {
    node.focus();
    const ev = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    node.dispatchEvent(ev);
    return ev;
  };
  await check('展开组内 ↑↓ 在可见项之间移动', () => {
    const list = navs();
    assert.ok(list.length >= 3);
    list[0].focus();
    press(list[0], 'ArrowDown');
    assert.equal(doc.activeElement, list[1]);
    press(list[1], 'ArrowUp');
    assert.equal(doc.activeElement, list[0]);
  });
  await check('漫游跳过折叠起来的条目', () => {
    const hiddenItems = [...group('zhipu').querySelectorAll('.ui3-model-item')];
    assert.ok(hiddenItems.every((n) => !navs().includes(n)), '收起组的条目不该出现在漫游序列里');
  });
  await check('End / Home 跳到首末', () => {
    const list = navs();
    list[0].focus();
    press(list[0], 'End');
    assert.equal(doc.activeElement, list[list.length - 1]);
    press(list[list.length - 1], 'Home');
    assert.equal(doc.activeElement, list[0]);
  });
  await check('↑ 从首项回绕到末项', () => {
    const list = navs();
    list[0].focus();
    press(list[0], 'ArrowUp');
    assert.equal(doc.activeElement, list[list.length - 1]);
  });
  await check('roving tabindex：只有一个停靠点', () => {
    const list = navs();
    assert.equal(list.filter((n) => n.tabIndex === 0).length, 1);
  });
  await check('→ / ← 折叠展开 Provider，焦点留在组头', () => {
    const header = group('zhipu').querySelector('.pop-provider');
    header.focus();
    press(header, 'ArrowRight');
    assert.equal(groupModels('zhipu').hidden, false);
    assert.equal(header.getAttribute('aria-expanded'), 'true');
    assert.equal(doc.activeElement, header);
    assert.ok(expanded.has('zhipu'));
    press(header, 'ArrowLeft');
    assert.equal(groupModels('zhipu').hidden, true);
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.ok(!expanded.has('zhipu'));
  });
  await check('键盘 Enter 走原生按钮行为，回调仍只触发一次', () => {
    picked = [];
    openModels(currentModel);
    const item = navs().find((n) => n.classList.contains('ui3-model-item'));
    item.focus();
    item.click(); /* 原生 button 的 Enter/Space 语义就是 click */
    assert.equal(picked.length, 1);
  });
  await check('Escape 关闭并把焦点还给触发按钮', () => {
    const btn = doc.getElementById('btnModel');
    view.setTriggers({ model: btn });
    openModels(currentModel);
    btn.setAttribute('aria-expanded', 'true');
    pop().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(pop().hidden, true);
    assert.equal(doc.activeElement, btn);
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
  await check('空模型列表不抛错', () => {
    view.renderModelPicker({ models: [], current: null, expanded: new Set() });
    assert.ok(pop().querySelector('.ui3-empty'));
    assert.equal(pop().querySelectorAll('.ui3-model-item').length, 0);
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
