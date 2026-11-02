// Production renderer/backend with the Runtime harness's TEMP Git and fake Pi.
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ win, read, api, until, check, click, key, shot, owners, OUT }) => {
  const [A, B] = owners.map(owner => owner.conversationId);
  const input = '#runtimeView .rtc-composer>textarea';
  const menu = '.rtc-picker-menu:not([hidden])';
  const model = '#runtimeView .rtc-model-trigger', thinking = '#runtimeView .rtc-thinking-trigger';
  const focus = async id => {
    await click(`#pjRuntimeList [data-conversation-id="${id}"] .pj-sess-primary`);
    await until(() => read(`document.querySelector('#runtimeView .runtime-conversation')?.dataset.conversationId===${JSON.stringify(id)}&&document.querySelector('#workspace').dataset.workspaceView==='runtime'`));
  };
  const text = selector => read(`document.querySelector(${JSON.stringify(selector)})?.textContent`);
  const press = async value => {
    win.show(); win.focus(); win.webContents.focus();
    await until(() => win.isFocused() && win.webContents.isFocused());
    check('physical ' + value + ' targets an enabled focused control', await read("!!document.activeElement&&!document.activeElement.disabled&&document.activeElement!==document.body"));
    key(value);
  };
  const type = async value => {
    win.show(); win.focus(); win.webContents.focus();
    await until(() => win.isFocused() && win.webContents.isFocused());
    await click(input);
    await until(() => read(`document.activeElement===document.querySelector('${input}')&&!document.activeElement.disabled`));
    await read(`document.querySelector('${input}').select()`);
    await win.webContents.insertText(value);
    await until(() => read(`document.querySelector('${input}').value===${JSON.stringify(value)}`));
  };
  const send = async value => {
    await type(value);
    await until(() => read("!document.querySelector('#runtimeView .rtc-composer-actions button:last-child').disabled"));
    await press('Enter');
  };
  const choose = async (trigger, value) => {
    await click(trigger);
    await click(`${menu} [data-picker-value=${JSON.stringify(value)}]`);
  };
  const geometry = [];
  async function inspect(name) {
    const box = await read(`(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();const c=rect('#runtimeView .rtc-composer'),o=rect('#runtimeView .rtc-output'),p=document.querySelector('${menu}');return{viewport:{width:innerWidth,height:innerHeight},composer:c,output:o,prose:getComputedStyle(document.querySelector('#runtimeView .rtc-output')).fontSize,radius:getComputedStyle(document.querySelector('#runtimeView .rtc-composer')).borderRadius,menu:p?p.getBoundingClientRect().toJSON():null,menuZ:p?+getComputedStyle(p).zIndex:null}})()`);
    geometry.push({ name, ...box });
    check(name + ' composer and reading axis share bounded content width', Math.abs(box.composer.x - box.output.x) < 1 && Math.abs(box.composer.width - box.output.width) < 1 && box.composer.width <= 760 && box.composer.right <= box.viewport.width && box.composer.bottom <= box.viewport.height);
    check(name + ' consumes Refined prose and radius tokens', box.prose === '15px' && box.radius === '18px');
    if (box.menu) check(name + ' menu fits viewport below modal layer', box.menu.x >= 0 && box.menu.right <= box.viewport.width && box.menu.y >= 0 && box.menu.bottom <= box.viewport.height && box.menuZ < 60);
    if (box.menu) check(name + ' menu leaves the whole composer visible', box.menu.bottom <= box.composer.top);
    await shot(name, OUT); return box;
  }

  await read("import('/sessions.js').then(m=>m.refreshSidebarSessions())");
  await until(() => read("document.querySelectorAll('#pjRuntimeList [data-conversation-id]').length===2"));
  await focus(A); await until(() => read(`!document.querySelector('${model}').disabled`));
  check('visible Runtime chips show A native readback', (await text(model)).includes('Reason A') && (await text(thinking)).includes('low'));
  check('native select implementations are hidden from layout and focus', await read("[...document.querySelectorAll('#runtimeView .rtc-models select')].every(s=>s.hidden&&s.tabIndex===-1&&s.getBoundingClientRect().width===0)"));
  await click(model); await click(`${menu} .rtc-picker-search`); await win.webContents.insertText('delayed');
  check('visible model search filters native owner catalogue', await read(`document.querySelectorAll('${menu} [data-picker-value]').length===1&&document.querySelector('${menu} [data-picker-value]').textContent.includes('Delayed')`));
  await click(`${menu} [data-picker-value]`);
  check('model chip keeps confirmed A value while native setter is pending', (await text(model)).includes('Reason A'));
  await focus(B); await until(() => read(`!document.querySelector('${model}').disabled`));
  check('A pending model does not disable or replace B', (await text(model)).includes('Text B') && await read(`document.querySelector('${thinking}').disabled`));
  await until(async () => {
    const state = await api(); return state.items.find(item => item.conversationId === A)?.activity === 'idle';
  });
  await focus(A); await until(async () => (await text(model)).includes('Delayed') && await read(`!document.querySelector('${model}').disabled`));
  check('return to A shows confirmed native model readback', true);
  check('confirmed native model selection reports no failure', (await text('#runtimeView .rtc-model-notice')) === '');
  await choose(thinking, 'high');
  check('thinking chip keeps native low value until confirmation', (await text(thinking)).includes('low'));
  try { await until(async () => (await text(thinking)).includes('high') && await read(`!document.querySelector('${thinking}').disabled`)); }
  catch (error) {
    console.error('Refined fixture thinking state: ' + JSON.stringify(await read("({thinking:document.querySelector('#runtimeView select[aria-label=\"当前会话推理强度\"]').value,disabled:document.querySelector('#runtimeView .rtc-thinking-trigger').disabled,notice:document.querySelector('#runtimeView .rtc-model-notice').textContent,menu:!!document.querySelector('.rtc-picker-menu:not([hidden])'),focused:document.activeElement.className})")));
    await shot('failure-thinking-choice', OUT); throw error;
  }
  check('confirmed high thinking selection reports no failure', (await text('#runtimeView .rtc-model-notice')) === '');
  await click(thinking);
  await until(() => read("document.activeElement?.dataset.pickerValue==='high'"));
  await press('Up'); await until(() => read("document.activeElement?.dataset.pickerValue==='low'")); await press('Enter');
  await until(async () => (await text(thinking)).includes('low') && await read(`!document.querySelector('${thinking}').disabled`));
  check('physical Arrow and Enter select native thinking level through visible menu', true);
  check('confirmed keyboard thinking selection reports no failure', (await text('#runtimeView .rtc-model-notice')) === '');
  await click(model); await press('Escape');
  await until(() => read(`!document.querySelector('${menu}')`));
  check('physical Escape closes menu and restores model chip focus', await read(`!document.querySelector('${menu}')&&document.activeElement===document.querySelector('${model}')`));
  await click(model); await press('Tab');
  await until(() => read("Boolean(document.activeElement?.dataset.pickerValue)"));
  await press('Tab'); await until(() => read(`!document.querySelector('${menu}')`));
  check('physical Tab moving focus outside closes the Runtime menu', await read(`!document.querySelector('${menu}')`));
  check('leaving the model picker does not start an unintended model operation', (await text('#runtimeView .rtc-model-notice')) === '' && await read(`!document.querySelector('${model}').disabled`));

  await type('Draft A remains owned by A'); await focus(B); await type('Draft B remains owned by B'); await focus(A);
  check('actual Runtime navigation restores A draft', await read(`document.querySelector('${input}').value==='Draft A remains owned by A'`));
  await focus(B); check('actual Runtime navigation restores B draft', await read(`document.querySelector('${input}').value==='Draft B remains owned by B'`)); await focus(A);
  const prompt = 'Refined Runtime fixture\n\n# Native Markdown\n\n**Verified** native output with `inline code`.\n\n- first item\n- second item\n\n```js\nconst fixture = true;\n```\n\n' + Array.from({ length: 65 }, (_, index) => `Paragraph ${index + 1}. Readable Runtime output remains on the same reading axis.\n\n`).join('');
  await send(prompt);
  try { await until(() => read("document.querySelector('#runtimeView .rtc-output').textContent.includes('Paragraph 65')")); }
  catch (error) {
    console.error('Refined fixture send structure: ' + JSON.stringify(await read("({inputLength:document.querySelector('#runtimeView .rtc-composer>textarea').value.length,sendDisabled:document.querySelector('#runtimeView .rtc-composer-actions button:last-child').disabled,notice:document.querySelector('#runtimeView .rtc-notice').textContent,outputLength:document.querySelector('#runtimeView .rtc-output').textContent.length,focus:document.activeElement.tagName})")));
    await shot('failure-send', OUT); throw error;
  }
  check('physical Enter renders safe native Markdown and clears acknowledged draft', await read(`document.querySelector('${input}').value===''&&document.querySelector('#runtimeView .rtc-output h4')?.textContent==='Native Markdown'&&document.querySelectorAll('#runtimeView .rtc-output li').length===2&&!!document.querySelector('#runtimeView .rtc-output pre.code')`));
  await click('#runtimeView .rtc-composer-actions button:first-child');
  await until(async () => (await api()).items.find(item => item.conversationId === A)?.activity === 'idle');
  await until(() => read("!document.querySelector('#runtimeView .rtc-composer-actions button:last-child').disabled"));
  const point = await read("(()=>{const r=document.querySelector('#runtimeView .rtc-output').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaY: -700, deltaX: 0 });
  await until(() => read("(()=>{const o=document.querySelector('#runtimeView .rtc-output');return o.scrollHeight-o.clientHeight-o.scrollTop>160})()"));
  const scrollA = await read("document.querySelector('#runtimeView .rtc-output').scrollTop");
  await focus(B); await focus(A);
  check('native wheel scroll is restored independently for A', Math.abs((await read("document.querySelector('#runtimeView .rtc-output').scrollTop")) - scrollA) < 2);
  await send('New tail leaves the reader in control');
  await until(() => read("document.querySelector('#runtimeView .rtc-output').textContent.includes('New tail leaves the reader in control')"));
  check('new Runtime output does not force an off-bottom reader to the end', Math.abs((await read("document.querySelector('#runtimeView .rtc-output').scrollTop")) - scrollA) < 2);
  await click('#runtimeView .rtc-composer-actions button:first-child');
  await until(async () => (await api()).items.find(item => item.conversationId === A)?.activity === 'idle');

  for (const theme of ['light', 'dark']) {
    await read(`import('/theme.js').then(m=>m.setThemePreference(${JSON.stringify(theme)}))`);
    await until(() => read(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`));
    for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080], [760, 820]]) {
      win.setContentSize(width, height);
      await until(() => read(`innerWidth===${width}&&innerHeight===${height}`));
      const base = await inspect(`${theme}-${width}-conversation`);
      await click(model); await click(`${menu} .rtc-picker-search`); await win.webContents.insertText('fixture');
      const modelBox = await inspect(`${theme}-${width}-model`);
      check(`${theme}-${width} opening model menu keeps composer stable`, Math.abs(base.composer.y - modelBox.composer.y) < 1);
      await press('Escape'); await click(thinking);
      const thinkingBox = await inspect(`${theme}-${width}-thinking`);
      check(`${theme}-${width} opening thinking menu keeps composer stable`, Math.abs(base.composer.y - thinkingBox.composer.y) < 1);
      await press('Escape');
    }
  }
  fs.writeFileSync(path.join(OUT, 'refined-geometry.json'), JSON.stringify(geometry, null, 2));
};
