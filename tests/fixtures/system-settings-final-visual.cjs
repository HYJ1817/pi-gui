'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { contrastSample } = require('./system-settings-states.cjs');

// Drives the real production renderer and authenticated backend in the existing
// normal-sandbox TEMP desktop. No synthetic API successes or composed images.
async function runFinalNetworkVisual({ win, read, until, click, check, out, report, modelUrl, modelHits, agentDir }) {
  const key = async (code, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers });
  };
  const painted = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  async function captures(prefix, selector) {
    for (const [theme, width, height] of [['dark', 1320, 820], ['dark', 700, 600], ['light', 1320, 820], ['light', 700, 600]]) {
      await read(`import('/theme.js').then(m=>m.setThemePreference('${theme}'))`);
      win.setContentSize(width, height);
      await read(`document.documentElement.style.setProperty('--font-scale','${width === 700 ? '1.2' : '1'}')`);
      await until(() => read(`document.documentElement.dataset.theme==='${theme}'&&Math.abs(innerWidth-${width})<=2&&Math.abs(innerHeight-${height})<=6`), prefix + ' viewport');
      await read('Promise.allSettled(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished))');
      await painted();
      // At 150% Windows DPI innerWidth rounds a fractional CSS viewport down.
      // Compare the actual visual viewport at rendered device-pixel boundaries.
      const metrics = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),v=visualViewport,p=n=>Math.round(n*devicePixelRatio);return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},viewport:{width:v.width,height:v.height},inside:p(r.left)>=p(v.offsetLeft)&&p(r.right)<=p(v.offsetLeft+v.width)&&p(r.top)>=p(v.offsetTop)&&p(r.bottom)<=p(v.offsetTop+v.height),overflow:e.scrollWidth>e.clientWidth+1,bodyOverflow:document.documentElement.scrollWidth>innerWidth,focus:e.contains(document.activeElement)}})()`);
      const file = `${prefix}-${theme}-${width}.png`;
      const image = await win.webContents.capturePage(); assert.ok(!image.isEmpty());
      fs.writeFileSync(path.join(out, file), image.toPNG());
      report.screenshots.push({ file, metrics });
      check(prefix + ' ' + theme + '-' + width + ' real CSS bounds', metrics.inside && !metrics.overflow && !metrics.bodyOverflow);
      if (selector === '#confirmCard') {
        const samples = [];
        for (const item of ['h3', '.modal-desc', '.modal-actions button:first-child', '.modal-actions button:last-child']) {
          samples.push(await read(`(${contrastSample.toString()})(${JSON.stringify('#confirmCard ' + item)})`));
        }
        (report.endpointContrasts ||= []).push({ prefix, theme, width, samples });
        check(prefix + ' ' + theme + '-' + width + ' confirmation focus and text contrast', metrics.focus && samples.every(sample => sample.ratio >= 4.5));
        // Window resizing/capture and native key delivery are asynchronous.
        // Observe each actual focus movement before dispatching the next key.
        win.focus(); win.webContents.focus();
        await until(() => read('document.hasFocus()'), prefix + ' keyboard delivery', 5000);
        const ring = () => read(`(()=>{const e=document.activeElement,s=getComputedStyle(e),buttons=[...document.querySelectorAll('#confirmCard .modal-actions button')];return{index:buttons.indexOf(e),visible:e.matches(':focus-visible'),width:parseFloat(s.outlineWidth)}})()`);
        const start = await ring();
        await key('Tab');
        await until(async () => { const next = await ring(); return next.index >= 0 && next.index !== start.index && next.visible; }, prefix + ' forward Tab', 5000);
        await key('Tab', ['shift']);
        await until(async () => { const next = await ring(); return next.index === start.index && next.visible; }, prefix + ' backward Tab', 5000);
        const returned = await ring();
        check(prefix + ' ' + theme + '-' + width + ' real Tab and Shift+Tab retain visible modal focus', returned.index >= 0 && returned.visible && returned.width >= 2);
      }
      if (selector === '.settings-detail') {
        await read("document.querySelector('#system-network-effective').scrollIntoView({block:'center',behavior:'instant'})");
        await painted();
        const statusFile = `${prefix}-${theme}-${width}-effective.png`;
        fs.writeFileSync(path.join(out, statusFile), (await win.webContents.capturePage()).toPNG());
        report.screenshots.push({ file: statusFile, metrics });
        await read("document.querySelector('.settings-detail').scrollTop=0");
      }
      if (width === 700 && selector === '#confirmCard') {
        const original = await read("[...document.querySelectorAll('#confirmCard h3,#confirmCard .modal-desc,#confirmCard .modal-actions button')].map(e=>e.textContent)");
        await read(`{const copy=['Authorize this configured local endpoint','This permission applies only to the exact configured service and target. No credentials or conversations are sent. Other services, redirects and native Pi requests do not inherit this permission.','Cancel authorization','Authorize this endpoint'];[...document.querySelectorAll('#confirmCard h3,#confirmCard .modal-desc,#confirmCard .modal-actions button')].forEach((e,i)=>e.textContent=copy[i])}`);
        const bounds = await read("(()=>{const e=document.querySelector('#confirmCard'),r=e.getBoundingClientRect();return{inside:r.left>=0&&r.right<=visualViewport.width&&r.top>=0&&r.bottom<=visualViewport.height,overflow:e.scrollWidth>e.clientWidth+1}})()");
        check(prefix + ' ' + theme + ' narrow 120% English fixture retains confirmation actions', bounds.inside && !bounds.overflow);
        await painted();
        const englishFile = `${prefix}-${theme}-${width}-english.png`;
        fs.writeFileSync(path.join(out, englishFile), (await win.webContents.capturePage()).toPNG());
        report.screenshots.push({ file: englishFile, fixture: 'representative-English-copy-production-CSS', metrics: bounds });
        await read(`[...document.querySelectorAll('#confirmCard h3,#confirmCard .modal-desc,#confirmCard .modal-actions button')].forEach((e,i)=>e.textContent=${JSON.stringify(original)}[i])`);
      }
    }
    await read("document.documentElement.style.removeProperty('--font-scale')");
  }
  await until(() => read("document.querySelector('#system-network-feedback').textContent.includes('网络设置已保存')"), 'private endpoint policy acknowledgement');
  const networkText = await read("document.querySelector('#system-network-effective').textContent");
  check('network UI separates saved Chromium and Node startup policy and discloses Pi PAC limit',
    networkText.includes('Chromium：自定义代理') && networkText.includes('Node 启动时：系统代理') && networkText.includes('未接入应用系统代理/PAC'));
  await read("document.querySelector('.settings-detail').scrollTop=0");
  await captures('final-network', '.settings-detail');

  await read(`(async()=>{const api=await import('/api.js');const snapshot=await api.fetchProviderManagement();
    const {openProviderDialog}=await import('/provider-management/dialog.js');
    openProviderDialog({snapshot,item:{id:'custom',providerId:'local-final',name:'Local Model Service 本地模型目录',category:'api-key',authMode:'none',connection:{baseUrl:${JSON.stringify(modelUrl)},api:'openai-completions'}}});})()`);
  await until(() => read("!!document.querySelector('[data-authorize-discovery]')"), 'production provider discovery control');
  await click('[data-authorize-discovery]');
  await until(() => read("!document.querySelector('#confirmLayer').hidden&&document.querySelector('#confirmCard').textContent.includes('模型目录')"), 'provider endpoint confirmation');
  check('local provider confirmation names target and credential-free GET scope', await read("document.querySelector('#confirmCard').textContent.includes('不发送对话或密钥')"));
  await captures('final-provider-consent', '#confirmCard');
  const before = modelHits(); await key('Escape');
  await until(() => read("document.querySelector('#confirmLayer').hidden"), 'provider cancel');
  check('provider confirmation cancellation sends no request', modelHits() === before);
  await click('[data-authorize-discovery]');
  await until(() => read("!document.querySelector('#confirmLayer').hidden"), 'provider confirmation reopened');
  await click('#confirmCard .modal-actions button:last-child');
  await until(() => modelHits() > before, 'actual authorized directory GET');
  await until(() => read("document.querySelector('.pm-discovery-note')?.getAttribute('data-discovery-status')==='ready'"), 'directory result in actual UI');
  check('explicit provider grant reaches real loopback model directory and renders candidate', await read("document.querySelector('#modalCard').textContent.includes('local-final-model')"));
  await click('.pm-advanced-entry');
  const registration = '[data-advanced-field="piRegistrationReference"]';
  check('provider advanced form explains that HTTP cannot use a registration reference', await read(`document.querySelector(${JSON.stringify(registration)}).closest('.pm-field').textContent.includes('HTTP 端点须清空')`));
  await click(registration); win.webContents.insertText('$FIXTURE_REFERENCE');
  await read("[...document.querySelectorAll('.pm-dialog-actions button')].find(e=>e.textContent==='保存服务').id='p2-provider-save'");
  await click('#p2-provider-save');
  await until(() => read("document.querySelector('.pm-alert-host').textContent.includes('HTTP 端点不得使用本机注册引用') && document.querySelector('#p2-provider-save').textContent==='保存服务' && !document.querySelector('#p2-provider-save').disabled"), 'registration validation restores editable save action');
  await captures('final-provider-http-reference', '#modalCard');
  check('provider rejects the reference without creating Pi configuration for the target',
    !Object.hasOwn(JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8')).providers, 'local-model-service'));
  await read(`{const field=document.querySelector(${JSON.stringify(registration)});field.value='';field.dispatchEvent(new Event('input'))}`);
  await read("import('/ui/modal.js').then(m=>m.closeModal())");

  // Place a native-only synthetic value in the isolated agent fixture. Do
  // not type it into the renderer, so the view must show only the redaction.
  const mcpFile = path.join(agentDir, 'mcp.json');
  const marker = 'sk-FIXTURE-ONLY-PATH';
  const beforeProtectedEdit = Buffer.from(JSON.stringify({ mcpServers: {
    'local-protected-fixture': { type: 'http', url: `${modelUrl.replace('/v1', '/mcp')}/${marker}` },
  } }));
  fs.writeFileSync(mcpFile, beforeProtectedEdit, { flag: 'wx' });
  await click('#navMcp');
  const editProtected = '[data-focus-key="edit:user:local-protected-fixture"]';
  await until(() => read(`!!document.querySelector(${JSON.stringify(editProtected)})`), 'native MCP protected entry');
  await click(editProtected);
  await until(() => read("!!document.querySelector('.mcp-form-modal [data-field=\"url\"]')"), 'MCP protected editor');
  check('MCP native protected URL stays out of the editor', await read(`document.querySelector('.mcp-form-modal [data-field="url"]').value==='' && document.querySelector('#modalCard').textContent.includes('未回填') && !document.documentElement.textContent.includes(${JSON.stringify(marker)})`));
  await click('.mcp-form-modal [data-field="description"]'); win.webContents.insertText('Description-only fixture edit');
  await click('.mcp-form-modal [data-field="save"]');
  await until(() => read("document.querySelector('.mcp-form-error')?.textContent.includes('本地端点兼容仅支持不携带凭据的配置')"), 'protected MCP save error');
  check('MCP protected URL save is denied without confirmation or replacing native bytes',
    await read(`document.querySelector('#confirmLayer').hidden && !document.documentElement.textContent.includes(${JSON.stringify(marker)})`)
    && fs.readFileSync(mcpFile).equals(beforeProtectedEdit));
  await captures('final-mcp-protected-url', '#modalCard');
  await read("import('/ui/modal.js').then(m=>m.closeModal())");
  await until(() => read("[...document.querySelectorAll('.mcp-page button')].some(e=>!e.disabled&&['新增服务器','新增全局服务器','新增'].includes(e.textContent))"), 'MCP settings add control');
  await read("[...document.querySelectorAll('.mcp-page button')].find(e=>!e.disabled&&['新增服务器','新增全局服务器','新增'].includes(e.textContent)).id='final-mcp-add'");
  await click('#final-mcp-add');
  await until(() => read("!!document.querySelector('.mcp-form-modal [aria-label=\"传输类型\"]')"), 'MCP editor');
  await read("[...document.querySelectorAll('.mcp-form-modal button')].find(e=>e.textContent==='HTTP 端点').id='final-mcp-http'");
  await click('#final-mcp-http');
  await click('.mcp-form-modal [data-field="name"]'); win.webContents.insertText('Local-Network-Tools-本地'.replace('本地', 'MCP'));
  await click('.mcp-form-modal [data-field="url"]'); win.webContents.insertText(modelUrl.replace('/v1', '/mcp/Local-Tools-Without-Secret-Headers'));
  const initialBytes = fs.readFileSync(mcpFile);
  await click('.mcp-form-modal [data-field="save"]');
  await until(() => read("!document.querySelector('#confirmLayer').hidden&&document.querySelector('#confirmCard').textContent.includes('MCP 本地端点')"), 'MCP endpoint confirmation');
  await captures('final-mcp-consent', '#confirmCard');
  await key('Escape');
  await until(() => read("document.querySelector('#confirmLayer').hidden&&!document.querySelector('.mcp-form-modal [data-field=\"save\"]').disabled"), 'MCP cancel restores editor');
  check('MCP cancellation preserves native config bytes', initialBytes ? fs.readFileSync(mcpFile).equals(initialBytes) : !fs.existsSync(mcpFile));
  await click('.mcp-form-modal [data-field="save"]');
  await until(() => read("!document.querySelector('#confirmLayer').hidden"), 'MCP confirmation reopened');
  await click('#confirmCard .modal-actions button:last-child');
  await until(() => fs.existsSync(mcpFile), 'authorized native MCP config write');
  const config = JSON.parse(fs.readFileSync(mcpFile));
  check('MCP explicit confirmation saves only the configured credential-free target',
    config.mcpServers['Local-Network-Tools-MCP']?.url === modelUrl.replace('/v1', '/mcp/Local-Tools-Without-Secret-Headers')
      && !JSON.stringify(config).includes('endpointChallenge'));
  await read("import('/ui/modal.js').then(m=>m.closeModal())");
  await read("document.querySelector('#navSystem').click()");
  await until(() => read("!!document.querySelector('#system-network-feedback')"), 'restore system page');
}
module.exports = { runFinalNetworkVisual };
