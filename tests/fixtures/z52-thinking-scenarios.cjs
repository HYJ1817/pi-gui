const fs = require('node:fs'), path = require('node:path');
module.exports = async ({ win, read, check, until, origin, out, screenshots, errors }) => {
  const shot = async name => { fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage()).toPNG()); screenshots.push(name + '.png'); };
  const state = () => read("import('/state.js').then(m=>({id:m.S.state?.model?.id,status:m.S.thinkingReadStatus,pending:m.S.modelSwitchPending,reasoning:m.S.state?.model?.capability?.capabilities.reasoning}))");
  const close = () => read("import('/ui/popover.js').then(m=>m.closePop())");
  const classicChoose = async id => {
    await close();
    await read(`document.querySelector('#btnModel').click();document.querySelector('.pop [data-model-id="${id}"].pop-item').click()`);
    await until(async () => { const s = await state(); return !s.pending && s.status !== 'pending' && (id === 'read-error' ? s.status === 'error' : s.id === id); }, 'Classic ' + id);
  };
  await until(async () => (await state()).status === 'success', 'Classic native initial read');
  check('Classic false model accepts native levels while capability remains false', await read("!document.querySelector('#btnThink').disabled") && (await state()).reasoning === false);
  await read("document.querySelector('#btnThink').click()");
  check('Classic options are exactly native off/low/high', await read("[...document.querySelectorAll('.ui3-think-item')].map(n=>n.dataset.level).join(',')==='off,low,high'"));
  await shot('classic-false-ready'); await close();
  const classic = {};
  for (const id of ['false', 'unknown', 'empty', 'off', 'read-error']) {
    await classicChoose(id);
    classic[id] = await read("({disabled:document.querySelector('#btnThink').disabled,reason:document.querySelector('#btnThink').title})");
    check('Classic native availability: ' + id, classic[id].disabled === !['false', 'unknown'].includes(id));
  }
  await read("document.querySelector('#btnThinkInfo').click()"); await shot('classic-read-failed'); await close();
  await classicChoose('false');
  const repo = await read("import('/state.js').then(m=>m.S.cwd)");
  const api = async (body, route = '/api/runtime-sessions') => {
    const legacy = (await (await fetch(origin + '/api/status')).json()).legacyOwner;
    return (await fetch(origin + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Gui-Owner': JSON.stringify(legacy) }, body: JSON.stringify(body) } : {})).json();
  };
  for (const name of ['A', 'B']) {
    const route = '/api/worktrees', list = await api(null, route + '?project=' + encodeURIComponent(repo));
    const plan = await api({ action: 'prepare', project: repo, branch: 'z52-' + name, source: 'HEAD', contextGeneration: list.contextGeneration }, route);
    check('temporary worktree ' + name + ' prepared', plan.ok);
    const created = await api({ action: 'create', nonce: plan.nonce, contextGeneration: list.contextGeneration }, route); check('temporary worktree ' + name + ' created', created.ok);
    const next = await api(null, route + '?project=' + encodeURIComponent(repo)); const workspace = next.items.find(w => w.branch === 'z52-' + name);
    check('fake Pi Runtime ' + name + ' started', (await api({ action: 'start', args: { id: workspace.id, epoch: workspace.epoch, ...(name === 'B' ? { allowThird: true } : {}) } })).ok);
  }
  let snapshot;
  await until(async () => { snapshot = await api(); return snapshot.items.length === 2 && snapshot.items.every(i => i.lifecycle === 'ready' && i.owner?.sessionId); }, 'Runtime native identities');
  const [A, B] = snapshot.items.map(i => i.conversationId);
  await read("import('/sessions.js').then(m=>m.refreshSidebarSessions())");
  const focus = async id => {
    await until(() => read(`!!document.querySelector('#pjRuntimeList [data-conversation-id="${id}"] button')`), 'sidebar row');
    await read(`document.querySelector('#pjRuntimeList [data-conversation-id="${id}"] button').click()`);
    await until(() => read("document.querySelector('#workspace').dataset.workspaceView==='runtime'&&!!document.querySelector('#runtimeView select[aria-label=\"当前会话模型\"]')"), 'Runtime visible');
  };
  const model = '#runtimeView select[aria-label="当前会话模型"]', thinking = '#runtimeView select[aria-label="当前会话推理强度"]';
  const selected = () => read(`(()=>{try{return JSON.parse(document.querySelector(${JSON.stringify(model)}).value).modelId}catch{return null}})()`);
  const choose = id => read(`(()=>{const s=document.querySelector(${JSON.stringify(model)});s.value=JSON.stringify({providerId:'fixture',modelId:${JSON.stringify(id)}});s.dispatchEvent(new Event('change'))})()`);
  const ready = () => read(`!document.querySelector(${JSON.stringify(model)}).disabled`);
  await focus(A); await until(async () => await ready() && await selected() === 'false', 'Runtime initial native model');
  await shot('runtime-false-ready');
  for (const id of ['false', 'unknown', 'empty', 'off', 'read-error']) {
    await choose(id);
    await until(async () => await ready() && (id === 'read-error' ? await read("document.querySelector('.rtc-model-notice').textContent.includes('未能读取')") : await selected() === id), 'Runtime ' + id);
    const actual = await read(`({disabled:document.querySelector(${JSON.stringify(thinking)}).disabled,reason:document.querySelector(${JSON.stringify(thinking)}).title})`);
    check('Classic/Runtime window agree on availability and reason: ' + id, actual.disabled === classic[id].disabled && (!actual.disabled || actual.reason === classic[id].reason));
    if (!actual.disabled) check('Runtime options equal Classic native off/low/high: ' + id,
      await read(`[...document.querySelector(${JSON.stringify(thinking)}).options].slice(1).map(n=>n.value).join(',')==='off,low,high'`));
    if (id === 'off' || id === 'read-error' || id === 'unknown') await shot('runtime-' + id);
  }
  await choose('false'); await until(async () => await ready() && await selected() === 'false', 'Runtime restored');
  await read(`(()=>{const s=document.querySelector(${JSON.stringify(thinking)});s.value='high';s.dispatchEvent(new Event('change'))})()`);
  await until(() => read(`document.querySelector(${JSON.stringify(thinking)}).disabled`), 'thinking pending');
  check('Runtime thinking stays pending before native confirmation', await read(`document.querySelector(${JSON.stringify(thinking)}).value==='low'`));
  await until(() => read(`!document.querySelector(${JSON.stringify(thinking)}).disabled&&document.querySelector(${JSON.stringify(thinking)}).value==='high'`), 'thinking confirmed');
  check('Runtime thinking success is the native readback value', true);
  await choose('reject'); await until(() => ready(), 'model rejection');
  check('Runtime rejected model keeps reliable selection and visible failure', await selected() === 'false' && await read("!!document.querySelector('.rtc-model-notice').textContent"));
  await read("document.querySelector('#runtimeView textarea').value='draft-A';document.querySelector('#runtimeView textarea').dispatchEvent(new Event('input'))");
  await choose('delayed'); await focus(B); await until(async () => await ready() && await selected() === 'false', 'B current model');
  await read("document.querySelector('#runtimeView textarea').value='draft-B';document.querySelector('#runtimeView textarea').dispatchEvent(new Event('input'))");
  await new Promise(resolve => setTimeout(resolve, 800));
  check('A late model/levels cannot change B model or draft', await selected() === 'false' && await read("document.querySelector('#runtimeView textarea').value==='draft-B'"));
  await focus(A); await until(async () => await ready() && await selected() === 'delayed', 'A delayed native readback');
  check('return A preserves its model and Z5-1 draft', await read("document.querySelector('#runtimeView textarea').value==='draft-A'"));
  await choose('no-model'); await until(async () => await ready() && await selected() === null, 'no current model');
  check('Runtime no-model rejects even returned native levels', await read(`document.querySelector(${JSON.stringify(thinking)}).disabled&&document.querySelector(${JSON.stringify(thinking)}).options.length===1`));
  await shot('runtime-no-model');
  for (const width of [1200, 760]) {
    win.setContentSize(width, 820); await new Promise(resolve => setTimeout(resolve, 120));
    check('Runtime model controls remain within content width ' + width, await read("[...document.querySelectorAll('#runtimeView .rtc-model-row select')].every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width>0})"));
    await shot('runtime-' + width);
  }
  for (const row of (await api()).items) if (row.owner) check('explicit fixture Runtime close', (await api({ action: 'close', owner: row.owner })).ok);
  check('thinking scenarios have no renderer errors', errors.length === 0);
};
