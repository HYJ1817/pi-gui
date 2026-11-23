/* Called by attachments-electron.cjs. Uses production handlers, uploaded TEMP
 * documents, generated real video frames and trusted pointer/keyboard events. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { documentFiles } = require('./attachment-files.cjs');
module.exports = async function ({ read, waitFor, paint, shot, click, key, check, win, facts, commands, world, uploads }) {
  const files = documentFiles();
  const inputs = path.join(world, 'inputs'); fs.mkdirSync(inputs);
  for (const file of files) fs.writeFileSync(path.join(inputs, file.name), file.body);
  await read(`window.fixtureDocs=${JSON.stringify(files.map(file => ({ name: file.name, type: file.type, data: file.body.toString('base64') })))}.map(f=>new File([Uint8Array.from(atob(f.data),c=>c.charCodeAt(0))],f.name,{type:f.type}));`);
  const reset = () => read(`ST.S.attachments=[];A.renderAttachments();ST.el.input.value='';C.autoGrow();C.updateSendState();void 0`);
  async function settle(count) { await waitFor(`ST.S.attachments.length===${count}&&!ST.S.attachments.some(a=>a.loading)`); await paint(); }
  async function geometry(name) {
    const result = await read(`(()=>{
      const q=s=>document.querySelector(s),r=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height,right:b.right,bottom:b.bottom}};
      const box=q('#composerBox'),tray=q('#attachTray'),input=q('#input');
      return {name:${JSON.stringify(name)},width:innerWidth,height:innerHeight,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme,
        page:document.documentElement.scrollWidth,box:r(box),input:r(input),tray:{...r(tray),scroll:tray.scrollHeight,client:tray.clientHeight},
        controls:[...box.querySelectorAll('.composer-bar button')].filter(e=>e.getClientRects().length).map(e=>({id:e.id,...r(e)})),
        rows:[...tray.querySelectorAll('.att')].map(e=>({type:e.dataset.fileType,...r(e),scroll:e.scrollWidth,client:e.clientWidth,border:getComputedStyle(e).borderTopWidth,bg:getComputedStyle(e).backgroundColor})),
        reserved:parseFloat(getComputedStyle(q('.stage')).getPropertyValue('--composer-reserved-height')),outer:r(q('#chatComposer'))};
    })()`);
    facts.push(result);
    check(name + ': no overflow; input and action controls stay usable', result.page <= result.width + 1 && result.box.x >= 0 && result.box.right <= result.width + 1
      && result.controls.every(r => r.x >= result.box.x - 1 && r.right <= result.box.right + 1 && r.bottom <= result.box.bottom + 1)
      && result.input.h >= 50 && result.input.h <= Math.max(62, Math.min(184, result.height * .24)) + 1
      && result.rows.every(r => r.scroll <= r.client + 1 && r.right <= result.box.right + 1), result);
    check(name + ': bounded attachment tray and existing composer reservation', result.tray.h <= Math.max(90, Math.min(148, result.height * .24)) + 2
      && Math.abs(result.reserved - result.outer.h) <= 1 && result.rows.every(r => r.border === '0px'), result);
    return result;
  }
  await reset();
  await read(`A.handleFiles([fixtureMedia.video,fixtureDocs[0],fixtureDocs[1]])`); await settle(3);
  await waitFor(`!!ST.S.attachments.find(a=>a.name===fixtureMedia.video.name).thumbnailUrl`);
  const thumbnailDetail = await read(`(async()=>{const image=new Image();image.src=ST.S.attachments.find(a=>a.name===fixtureMedia.video.name).thumbnailUrl;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;let min=255,max=0;for(let i=0;i<data.length;i+=4){const v=Math.max(data[i],data[i+1],data[i+2]);min=Math.min(min,v);max=Math.max(max,v)}return {min,max,width:c.width,height:c.height}})()`);
  facts.push({ thumbnailDetail });
  check('first WebM video thumbnail contains the actual recorded scene, not an empty decoded frame',thumbnailDetail.max-thumbnailDetail.min>80,thumbnailDetail);
  for (const theme of ['dark', 'light']) {
    await read(`TH.setThemePreference('${theme}');ST.el.input.blur();ST.el.btnAttach.blur();void 0`);
    await waitFor(`document.documentElement.dataset.theme==='${theme}'`);
    win.webContents.sendInputEvent({type:'mouseMove',x:10,y:10});
    await paint(); await shot('reference-three-' + theme);
    const crop = await read(`(()=>{const r=ST.el.composerBox.getBoundingClientRect();return {x:Math.floor(r.x-8),y:Math.floor(r.y-8),width:Math.ceil(r.width+16),height:Math.ceil(r.height+16)}})()`);
    const image = await win.webContents.capturePage(crop);
    fs.writeFileSync(path.join(world,'evidence','reference-composer-' + theme + '.png'),image.toPNG());
    check(theme + ': screenshot reference video plus PDF and Word fits without tray scrolling',await read(`ST.el.attachTray.scrollHeight<=ST.el.attachTray.clientHeight+1&&ST.el.attachTray.querySelectorAll('.att').length===3`));
  }
  await reset();
  // CDP file chooser supplies files to the real hidden input and its change handler.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('DOM.enable');
  const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [path.join(inputs, files[0].name)] });
  await settle(1);
  check('file picker uploads and parses actual PDF through production backend', await read(`ST.S.attachments[0].kind==='text'&&ST.S.attachments[0].text.includes('Attachment fixture')&&!ST.el.btnSend.disabled`));
  await shot('single-pdf');
  check('single PDF is a compact transparent inline item without ready prose', await read(`(()=>{const e=ST.el.attachTray.firstElementChild,c=getComputedStyle(e);return e.getBoundingClientRect().height<=32&&c.backgroundColor==='rgba(0, 0, 0, 0)'&&!/已就绪|读不了/.test(e.textContent)})()`));

  await reset();
  await read(`(()=>{const data=new DataTransfer();data.items.add(fixtureMedia.video);ST.el.composerBox.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));})()`);
  await settle(1);
  await waitFor(`!!ST.S.attachments[0].thumbnailUrl`);
  check('drop generates an actual WebM video thumbnail while retaining raw-file reference', await read(`ST.S.attachments[0].kind!=='image'&&!!ST.S.attachments[0].path&&ST.el.attachTray.querySelector('.att-thumb img').naturalWidth>0&&A.attachmentImages().length===0`));
  await shot('single-video');
  await click('.att-preview');
  await waitFor(`!document.querySelector('#modal').hidden&&document.querySelector('.attachment-preview-dialog video').readyState>=2`);
  check('trusted click opens local WebM video playback with real duration', await read(`(()=>{const v=document.querySelector('.attachment-preview-dialog video');return v.controls&&v.videoWidth===320&&v.duration>0})()`));
  await shot('video-preview'); await key('ESC');
  check('Escape closes video preview and returns keyboard focus', await read(`document.querySelector('#modal').hidden&&document.activeElement.matches('.att-preview')`));

  await reset();
  check('Chromium records a real H.264 MP4 for this offline fixture', await read(`fixtureMedia.mp4Supported===true&&!!fixtureMedia.videoMp4&&fixtureMedia.videoMp4.size>0`));
  await read(`A.handleFiles([fixtureMedia.videoMp4])`); await settle(1);
  await waitFor(`!!ST.S.attachments[0].thumbnailUrl`);
  const mp4Thumbnail = await read(`(async()=>{const image=new Image();image.src=ST.S.attachments[0].thumbnailUrl;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;let min=255,max=0;for(let i=0;i<data.length;i+=4){const v=Math.max(data[i],data[i+1],data[i+2]);min=Math.min(min,v);max=Math.max(max,v)}return {min,max,width:c.width,height:c.height}})()`);
  const mp4Facts = await read(`({name:ST.S.attachments[0].name,size:ST.S.attachments[0].size,path:ST.S.attachments[0].path,kind:ST.S.attachments[0].kind})`);
  const mp4Bytes = fs.readFileSync(mp4Facts.path);
  facts.push({ mp4: { ...mp4Facts, head: mp4Bytes.subarray(4, 8).toString('ascii'), bytes: mp4Bytes.length, sampleEntryReplaced: await read('window.mp4SampleEntryReplaced') }, mp4Thumbnail });
  check('real MP4 upload preserves ftyp bytes and generates a real-frame thumbnail', mp4Facts.name === '操作演示.mp4' && mp4Facts.kind !== 'image'
    && mp4Bytes.length === mp4Facts.size && mp4Bytes.subarray(4, 8).toString('ascii') === 'ftyp'
    && mp4Thumbnail.max - mp4Thumbnail.min > 80, { mp4Facts, mp4Thumbnail, bytes: mp4Bytes.length, head: mp4Bytes.subarray(4, 8).toString('ascii') });
  await shot('single-mp4');
  await click('.att-preview');
  await waitFor(`!document.querySelector('#modal').hidden&&document.querySelector('.attachment-preview-dialog video').readyState>=2`);
  check('trusted click decodes the real MP4 with its actual dimensions and duration', await read(`(()=>{const v=document.querySelector('.attachment-preview-dialog video');return v.controls&&v.videoWidth===320&&v.duration>0})()`));
  await shot('mp4-preview'); await key('ESC');
  await click('#btnSend'); await waitFor('ST.S.attachments.length===0');
  check('real MP4 sends only its original file reference', commands.at(-1).message.includes('操作演示.mp4') && commands.at(-1).message.includes('本机路径：') && !commands.at(-1).images);

  await read(`A.handleFiles([fixtureMedia.videoMp4])`); await settle(1);
  await click('.att-x');
  check('removing the MP4 immediately clears the tray and returns focus to Attach', await read(`ST.S.attachments.length===0&&ST.el.attachTray.hidden&&document.activeElement.id==='btnAttach'`));

  await reset();
  check('unsupported-codec MP4 fixture actually changed the sample entry', await read(`window.mp4SampleEntryReplaced===true`));
  await read(`A.handleFiles([fixtureMedia.videoMp4Unsupported])`); await settle(1);
  await waitFor(`ST.S.attachments[0].previewLoading===false`);
  const unsupported = await read(`({thumbnail:!!ST.S.attachments[0].thumbnailUrl,placeholder:!!ST.el.attachTray.querySelector('[data-file-type="video"] .att-media-placeholder:not([hidden])'),image:!!ST.el.attachTray.querySelector('.att-thumb img'),path:!!ST.S.attachments[0].path,sendable:!ST.el.btnSend.disabled})`);
  facts.push({ unsupported });
  check('MP4 with an unsupported codec falls back to the video placeholder but stays a sendable reference', !unsupported.thumbnail && unsupported.placeholder && !unsupported.image && unsupported.path && unsupported.sendable, unsupported);
  await shot('mp4-codec-fallback');
  await click('[data-file-type="video"] .att-preview');
  await waitFor(`!!document.querySelector('.attachment-preview-error:not([hidden])')`);
  check('unsupported MP4 preview reports local decoding failure only', await read(`document.querySelector('.attachment-preview-error').textContent.includes('无法预览')`));
  await shot('mp4-preview-failure'); await key('ESC');
  await click('#btnSend'); await waitFor('ST.S.attachments.length===0');
  check('unsupported MP4 still sends its preserved file reference without image content', commands.at(-1).message.includes('不支持的编码.mp4') && commands.at(-1).message.includes('本机路径：') && !commands.at(-1).images);

  await reset();
  await read(`(()=>{const data=new DataTransfer();data.items.add(fixtureMedia.image);document.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`);
  await settle(1); await click('.att-preview');
  check('paste image can be previewed and keeps original ImageContent', await read(`!!document.querySelector('.attachment-preview-dialog img')&&A.attachmentImages().length===1`));
  await shot('image-preview'); await key('ESC');

  await reset();
  await read(`A.handleFiles([fixtureMedia.video,...fixtureDocs,fixtureMedia.image])`); await settle(8);
  await waitFor(`!!ST.S.attachments.find(a=>a.name===fixtureMedia.video.name).thumbnailUrl`);
  const sizes = await read(`ST.S.attachments.map(a=>({name:a.name,size:a.size,path:a.path}))`);
  check('all uploaded sizes and paths point to exact original bytes', sizes.every(item => fs.statSync(item.path).size === item.size && item.path.startsWith(uploads.uploadDir + path.sep)), sizes.map(item => ({ name: item.name, size: item.size })));
  check('six document types and two media appear with correct roles', await read(`ST.el.attachTray.querySelectorAll('.att').length===8&&ST.el.attachTray.querySelectorAll('.att-preview').length===2&&ST.el.attachTray.querySelectorAll('.att-info').length===6`));
  await read('window.savedMixed=ST.S.attachments.slice();void 0');
  for (const theme of ['dark', 'light']) {
    await read(`TH.setThemePreference('${theme}')`); await waitFor(`document.documentElement.dataset.theme==='${theme}'`);
    for (const [width, height] of [[1320, 820], [700, 600]]) {
      win.setContentSize(width, height); await paint(); await geometry(`${theme}-${width}-mixed`); await shot(`${theme}-${width}-mixed`);
    }
    win.setContentSize(1320, 820); await paint();
    await read(`ST.el.input.focus();`); win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 }); await paint();
    check(theme + ': remove action is unobtrusive until hover or keyboard focus', await read(`getComputedStyle(ST.el.attachTray.querySelector('.att-file .att-x')).opacity==='0'`));
    const point = await read(`(()=>{const r=ST.el.attachTray.querySelector('.att-file').getBoundingClientRect();return {x:Math.round(r.x+8),y:Math.round(r.y+8)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await paint();
    check(theme + ': hovered file reveals its own remove action', await read(`getComputedStyle(ST.el.attachTray.querySelector('.att-file .att-x')).opacity==='1'`));
    await shot(theme + '-file-hover');
    await click('.att-file .att-info');
    check(theme + ': file hover summary does not open a duplicate popover', await read(`document.querySelector('#composerPopover').hidden===true`));
    await read(`ST.el.attachTray.querySelectorAll('.att-preview')[1].focus()`); await key('Tab'); await key('Tab');
    check(theme + ': keyboard reveals focus-visible remove control', await read(`document.activeElement.matches('.att-file .att-x')&&document.activeElement.matches(':focus-visible')&&getComputedStyle(document.activeElement).opacity==='1'`));
    await shot(theme + '-keyboard-focus');
    await key('Space');
    check(theme + ': keyboard removal updates state immediately and keeps focus in tray', await read(`ST.S.attachments.length===7&&ST.el.attachTray.contains(document.activeElement)&&!ST.el.btnSend.disabled`));
    await read(`ST.S.attachments=savedMixed.slice();A.renderAttachments();C.updateSendState()`);
  }

  await reset();
  await read(`A.handleFiles(Array.from({length:24},(_,i)=>new File(['# offline '+i],(i%2?'long-English-filename-'.repeat(12):'很长的中文文件名'.repeat(14))+i+'.md',{type:'text/markdown'})))`); await settle(24);
  for (const theme of ['dark', 'light']) for (const zoom of [.8, 1, 1.25, 1.5]) {
    win.webContents.setZoomFactor(zoom); win.setContentSize(700, 600);
    await read(`TH.setThemePreference('${theme}')`); await paint();
    const result = await geometry(`${theme}-many-zoom-${zoom}`);
    check(`${theme} ${zoom}: many attachments scroll internally instead of growing composer`, result.tray.scroll > result.tray.client + 20, result.tray);
    await shot(`${theme}-many-zoom-${zoom}`);
  }
  win.webContents.setZoomFactor(1); win.setContentSize(700, 600);
  await read(`document.documentElement.style.setProperty('--font-scale','1.5')`); await paint(); await geometry('font-scale-150'); await shot('font-scale-150');
  await read(`document.documentElement.style.removeProperty('--font-scale')`);

  await reset();
  await read(`window.uploadGate=null;window.originalFetch=window.fetch;window.fetch=(url,options)=>String(url).startsWith('/api/upload')?new Promise(resolve=>{uploadGate=()=>originalFetch(url,options).then(resolve)}):originalFetch(url,options);window.pendingFile=A.handleFiles([fixtureDocs[1]]);void 0`);
  await waitFor('!!uploadGate');
  check('lightweight loading state actually disables send', await read(`ST.el.attachTray.querySelector('[aria-busy="true"]')!==null&&ST.el.btnSend.disabled&&ST.el.attachTray.querySelector('.att-spin')!==null`));
  const before = commands.length;
  await click('#input'); await win.webContents.insertText('等待解析'); await key('Return');
  check('trusted Enter does not send while upload/parser is pending', commands.length === before && await read(`ST.el.input.value==='等待解析'`));
  await shot('loading'); await read('uploadGate();pendingFile');
  await read('window.fetch=originalFetch;void 0'); await settle(1);
  await click('#btnSend'); await waitFor('ST.S.attachments.length===0');
  check('actual send includes DOCX extracted text and consumes only sent files', commands.length === before + 1 && commands.at(-1).message.includes('备忘录 & notes'));

  await reset();
  await read(`A.handleFiles([new File(['broken PDF'],'无法提取.pdf',{type:'application/pdf'}),new File(['no decoder'],'preview-failure.mp4',{type:'video/mp4'})])`); await settle(2);
  await waitFor(`!ST.S.attachments.find(a=>a.name==='preview-failure.mp4').previewLoading`);
  check('parse error keeps original reference; video thumbnail failure is not upload failure', await read(`ST.S.attachments.every(a=>a.path)&&!!ST.S.attachments[0].error&&!ST.S.attachments[1].error&&!ST.el.btnSend.disabled&&!!ST.el.attachTray.querySelector('[data-file-type="video"] [data-icon="video"]')`));
  const statusLayout = await read(`(()=>{
    const item=ST.el.attachTray.querySelector('[data-file-type="pdf"]');
    const rect=element=>{const box=element.getBoundingClientRect();return {top:box.top,bottom:box.bottom,left:box.left,right:box.right,width:box.width,height:box.height}};
    return {item:rect(item),info:rect(item.querySelector('.att-info')),remove:rect(item.querySelector('.att-x')),meta:rect(item.querySelector('.att-meta'))};
  })()`);
  facts.push({ statusLayout });
  check('status text keeps info and remove on row one and the status on row two', statusLayout.remove.top < statusLayout.meta.top
    && statusLayout.remove.left >= statusLayout.info.right - 1
    && Math.abs((statusLayout.info.top + statusLayout.info.bottom) / 2 - (statusLayout.remove.top + statusLayout.remove.bottom) / 2) <= 2
    && statusLayout.meta.top >= statusLayout.info.bottom - 1
    && statusLayout.meta.left <= statusLayout.info.left + 1, statusLayout);
  await shot('parse-error-and-video-fallback');
  await click('[data-file-type="video"] .att-preview');
  await waitFor(`!!document.querySelector('.attachment-preview-error:not([hidden])')`);
  check('unsupported preview reports only local decoding failure', await read(`document.querySelector('.attachment-preview-error').textContent.includes('无法预览')`));
  await shot('video-preview-failure'); await key('ESC');
  await click('#btnSend'); await waitFor('ST.S.attachments.length===0');
  check('failed extraction and video still send accurate preserved references, not fake image content', commands.at(-1).message.includes('preview-failure.mp4') && commands.at(-1).message.includes('本机路径：') && !commands.at(-1).images);

  await reset();
  await read(`(async()=>{window.originalFetch=window.fetch;window.fetch=(url,options)=>String(url).startsWith('/api/upload')?Promise.resolve(new Response(JSON.stringify({ok:false,error:'文件超过上限 32 MB'}),{headers:{'Content-Type':'application/json'}})):originalFetch(url,options);await A.handleFiles([fixtureDocs[5]]);window.fetch=originalFetch;return true})()`);
  check('injected upload rejection stays concise and blocks phantom file send', await read(`ST.el.btnSend.disabled&&ST.el.attachTray.textContent.includes('文件超过上限 32 MB')&&!A.buildMessage('').includes('本机路径：未知')`));
  await shot('upload-failure'); await click('.att-x');
  check('last removal hides tray and returns focus to Attach', await read(`ST.el.attachTray.hidden&&document.activeElement.id==='btnAttach'&&ST.el.btnSend.disabled`));

  // Contrast is measured from the actual rendered semantic colors by compositing
  // their canvas-resolved RGBA over the real Composer surface.
  await read(`A.handleFiles(fixtureDocs)`); await settle(6);
  for (const theme of ['dark', 'light']) {
    await read(`TH.setThemePreference('${theme}')`); await paint();
    const ratios = await read(`(()=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
      const color=css=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=css;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].map((v,i)=>i===3?v/255:v)};
      const composite=(a,b)=>a.slice(0,3).map((v,i)=>v*a[3]+b[i]*(1-a[3]));
      const bg=color(getComputedStyle(ST.el.composerBox).backgroundColor);
      const luminance=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
      return [...ST.el.attachTray.querySelectorAll('.att-name,.ui3-attachment-size,.att-ic')].map(e=>{const fg=composite(color(getComputedStyle(e).color),bg),a=luminance(fg),b=luminance(bg);return {role:e.className,type:e.closest('.att').dataset.fileType,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)}});
    })()`);
    facts.push({ theme, contrast: ratios });
    check(theme + ': actual filename/size text reaches AA and type icons reach 3:1', ratios.every(item => item.ratio >= (item.role.includes('att-ic') ? 3 : 4.5)), ratios);
  }
  await reset(); await shot('empty-after-removal');
};
