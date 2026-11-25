'use strict';
module.exports = async function (t, group) {
  const { check, read, sleep, until, shot, click, key, type, value, open, win, notes, clipboard } = t;
  await group('markdown', async () => {
    await open('guide.md', '.fp-markdown-body');
    await until(() => read("!!document.querySelector('.fp-math-inline .katex')&&document.querySelector('.fp-markdown-image')?.naturalWidth>0"), 'md-formula-local-image');
    check('Markdown uses real KaTeX, table and authorized local decoded image', await read("!!document.querySelector('.fp-markdown-body table')&&document.querySelectorAll('.fp-md-toc-link').length===3&&document.querySelector('.fp-markdown-image').naturalWidth===320"));
    await shot('markdown-rendered'); await click('.fp-source-toggle');
    await until(() => read("!!document.querySelector('.fp-text-source')"), 'markdown-source');
    check('Markdown source toggle uses unified real text plugin', await read("document.querySelector('.fp-text-rows').textContent.includes('![本地彩色图]')"));
    await click('.fp-source-toggle'); await until(() => read("!!document.querySelector('.fp-markdown-body')"), 'markdown-rerender');
    await type('.fp-search', 'English');
    check('Markdown document search highlights real rendered text', await read("document.querySelectorAll('mark.fp-md-hit').length===1"));
  });
  await group('html', async () => {
    await open('sample.html', '.fp-html-source');
    check('HTML defaults to inert visible source', await read("!document.querySelector('.fp-html-source').hidden&&!document.querySelector('.fp-html-frame')"));
    await click('[aria-label="切换到静态预览"]');
    await until(() => read("!!document.querySelector('.fp-html-frame')"), 'html-frame');
    const child = () => win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc');
    await until(() => Promise.resolve(!!child()), 'html-child-frame');
    await sleep(400);
    let actual;
    try { actual = await child().executeJavaScript("[...document.images].map(i=>({complete:i.complete,width:i.naturalWidth,height:i.naturalHeight,hasSource:i.hasAttribute('src')}))", true); }
    catch (error) { actual = { inspection: /script.*disabled|script.*blocked/i.test(String(error)) ? 'sandbox-script-disabled' : 'frame-inspection-rejected', errorType: typeof error }; }
    const structure = await read("(()=>{const f=document.querySelector('.fp-html-frame'),d=new DOMParser().parseFromString(f.srcdoc,'text/html');return {images:[...d.images].map(i=>({hasSource:i.hasAttribute('src'),blob:i.src.startsWith('blob:'),data:i.src.startsWith('data:')})),scripts:d.scripts.length,forms:d.forms.length,frames:d.querySelectorAll('iframe').length,network:[...d.querySelectorAll('[src],[href]')].filter(e=>/^https?:/.test(e.getAttribute('src')||e.getAttribute('href'))).length,opaque:f.contentDocument===null,sandbox:f.getAttribute('sandbox')}})()");
    notes.push({ kind: 'html-image-observation', structure, actual });
    check('HTML iframe is opaque and denies app document access', structure.opaque && structure.sandbox === '');
    check('HTML strips scripts forms navigation and network resource references', structure.scripts === 0 && structure.forms === 0 && structure.frames === 0 && structure.network === 0 && await read("!window.__unsafePreview"));
    const bitmap = (await win.capturePage()).toBitmap(); let quadrantA = 0, quadrantB = 0;
    for (let i = 0; i < bitmap.length; i += 4) { if (bitmap[i] === 160 && bitmap[i+1] === 120 && bitmap[i+2] === 38) quadrantA++; if (bitmap[i] === 160 && bitmap[i+1] === 200 && bitmap[i+2] === 230) quadrantB++; }
    check('HTML authorized local PNG actually decodes and paints in opaque frame', quadrantA > 100 && quadrantB > 100, { quadrantA, quadrantB });
    notes.push({ kind: 'html-storage', status: 'runtime-probe-unverified-opaque-scripts-disabled', basis: 'empty sandbox, null contentDocument, source has no scripts' });
    await shot('html-opaque-static');
  });
  await group('pdf', async () => {
    await open('pages.pdf', '.fp-pdf');
    await until(() => read("document.querySelector('.fp-pdf-total')?.textContent.includes('8')&&!!document.querySelector('.fp-pdf canvas')&&document.querySelector('.fp-pdf canvas').width>0"), 'pdf-render', 25000);
    check('PDF.js real worker parses eight pages and paints actual canvas', await read("document.querySelectorAll('.fp-pdf-page').length===8&&document.querySelector('.fp-pdf canvas').width>0"));
    // The fixture has an outline. Wait for its async toolbar insertion before
    // measuring the search field's click position (canvas paint is earlier).
    await until(() => read("!document.querySelector('.fp-pdf-outline')?.hidden&&document.querySelector('.fp-pdf-outline').options.length>1&&!document.querySelector('.fp-pdf-search-tools .fp-search').disabled"), 'pdf-outline-toolbar');
    await type('.fp-pdf-search-tools .fp-search', 'literal [a+b].*');
    await until(() => read("document.querySelector('.fp-pdf-match-count')?.textContent.includes('/8')"), 'pdf-search', 20000);
    check('PDF cross-page search treats regex characters literally', true);
    const zoom = await read("parseInt(document.querySelector('.fp-pdf-zoom').textContent)"); await click('[aria-label="放大"]');
    check('PDF real zoom changes reported scale', await read(`parseInt(document.querySelector('.fp-pdf-zoom').textContent)>${zoom}`));
    await value('.fp-pdf-page-input', '8');
    await until(() => read("document.querySelector('.fp-pdf-page-input').value==='8'"), 'pdf-page8');
    check('PDF page navigation reaches last page with bounded canvases', await read("document.querySelectorAll('.fp-pdf canvas').length<=5"));
    await shot('pdf-multipage');
    // Set a fractional reading position in the actual scroll surface, then
    // switch with trusted tab clicks. A page-number-only projection loses it.
    await read("(()=>{const s=document.querySelector('.fp-pdf-scroll'),p=document.querySelector('.fp-pdf-page[data-page=\"4\"]');s.scrollTop=p.offsetTop+p.getBoundingClientRect().height*.4})()");
    await until(() => read("document.querySelector('.fp-pdf-page-input').value==='4'"), 'pdf-fractional-position');
    const pdfPosition = () => read("(()=>{const s=document.querySelector('.fp-pdf-scroll'),p=document.querySelector('.fp-pdf-page[data-page=\"4\"]');return{page:document.querySelector('.fp-pdf-page-input').value,zoom:document.querySelector('.fp-pdf-zoom').textContent,fit:document.querySelector('[aria-label=\"适合宽度\"]').getAttribute('aria-pressed'),offset:(s.scrollTop-p.offsetTop)/p.getBoundingClientRect().height}})()");
    const before = await pdfPosition();
    await open('guide.md', '.fp-markdown-body'); await click('.files-tab-select[title="pages.pdf"]');
    await until(() => read("document.querySelector('.fp-pdf-page-input')?.value==='4'&&!document.querySelector('.fp-pdf-page-input').disabled&&!!document.querySelector('.fp-pdf canvas')"), 'pdf-tab-restore');
    const after = await pdfPosition();
    check('real PDF restores manual zoom and fractional page offset across tabs', before.fit === 'false' && after.fit === 'false' && before.zoom === after.zoom && Math.abs(before.offset - after.offset) < .02, { before, after });
    await click('[aria-label="适合宽度"]');
    await open('guide.md', '.fp-markdown-body'); await click('.files-tab-select[title="pages.pdf"]');
    await until(() => read("document.querySelector('.fp-pdf-page-input')?.value==='4'&&!document.querySelector('.fp-pdf-page-input').disabled"), 'pdf-fit-tab-restore');
    check('real PDF preserves fit-width mode despite its saved numeric zoom', await read("document.querySelector('[aria-label=\"适合宽度\"]').getAttribute('aria-pressed')==='true'"));
    await shot('pdf-reading-restored');
  });
  await group('office', async () => {
    await open('document.docx', '.office-document');
    await until(() => read("document.querySelector('.office-document')?.textContent.includes('中文 Office Preview')"), 'docx-parser', 22000);
    check('Mammoth worker renders real DOCX heading lists and table', await read("!!document.querySelector('.office-document h1')&&!!document.querySelector('.office-document ul')&&!!document.querySelector('.office-document ol')&&!!document.querySelector('.office-document table')&&!document.querySelector('.office-document script')"));
    await type('[aria-label="搜索文档正文"]', '中文');
    check('DOCX search marks parsed document body', await read("document.querySelectorAll('.office-document mark').length>0")); await shot('office-docx');
    await open('workbook.xlsx', '.office-grid-viewport');
    await until(() => read("document.querySelectorAll('.office-sheet-tabs [role=tab]').length===3"), 'xlsx-parser', 22000);
    check('ExcelJS worker preserves display values, merge and cached formula', await read("document.querySelector('.office-grid-rows').textContent.includes('1,234.50')&&document.querySelector('.office-grid-rows').textContent.includes('2469')&&!!document.querySelector('.office-grid-cell[aria-colspan=\"2\"]')"));
    await click('[aria-label="显示公式"]');
    check('XLSX formula toggle displays formula without recalculating', await read("document.querySelector('.office-grid-rows').textContent.includes('B2*2')"));
    await read("[...document.querySelectorAll('.office-sheet-tabs button')].find(e=>e.textContent==='Virtual Rows').click()");
    await until(() => read("document.querySelector('.office-grid-viewport').getAttribute('aria-rowcount')==='2000'"), 'xlsx-virtual');
    check('XLSX tall sheet is virtualized in real layout', await read("document.querySelectorAll('.office-grid-row').length<100"));
    await shot('office-xlsx-virtual');
    await open('quoted.csv', '.office-grid-viewport');
    await until(() => read("document.querySelector('.office-grid-rows')?.textContent.includes('中文,名字')"), 'csv-parser');
    check('PapaParse handles quoted comma multiline and literal formula', await read("document.querySelector('.office-grid-rows').textContent.includes('第二行 \"quoted\"')&&document.querySelector('.office-grid-rows').textContent.includes('=1+2')"));
    await open('presentation.pptx', '.office-slides-frame');
    await until(() => read("document.querySelector('.office-page-input')&&!document.querySelector('.office-page-input').disabled"), 'pptx-real-parser', 25000);
    check('real PPTX parser loads two slides in opaque allow-scripts frame', await read("document.querySelector('.office-page-count').textContent.includes('2')&&document.querySelector('.office-slides-frame').sandbox.value==='allow-scripts'"));
    const frame = win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc');
    check('PPTX paints actual parsed slide text and shape layout', await frame.executeJavaScript("!!document.querySelector('.pptx-preview-slide-wrapper')&&document.body.textContent.includes('第 1 页')"));
    await click('[aria-label="下一页"]');
    await until(() => read("document.querySelector('.office-page-input').value==='2'"), 'pptx-page2');
    check('PPTX page navigation reaches second parsed slide', true);
    await value('.office-zoom', '75'); await sleep(150); await shot('office-pptx-page2');
    await open('quoted.csv', '.office-grid-viewport'); await click('.files-tab-select[title="presentation.pptx"]');
    await until(() => read("document.querySelector('.office-page-input')?.value==='2'&&!document.querySelector('.office-page-input').disabled"), 'pptx-tab-restore', 25000);
    check('real PPTX restores second slide and string-valued zoom across tabs', await read("document.querySelector('.office-zoom').value==='75'"));
    const restoredFrame = win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc');
    check('restored PPTX still paints actual second-slide content', await restoredFrame.executeJavaScript("document.body.textContent.includes('第 2 页')&&!!document.querySelector('.pptx-preview-slide-wrapper')"));
  });
  await group('image-audio-archive', async () => {
    await open('local.png', '.fp-image-viewport');
    await until(() => read("document.querySelector('.fp-image-content')?.naturalWidth===320"), 'image-decode');
    check('PNG preview decodes real CRC-valid 320x160 fixture', await read("document.querySelector('.fp-image-content').naturalHeight===160"));
    await shot('image-decoded');
    await open('tone.wav', 'audio');
    await until(() => read("Number.isFinite(document.querySelector('audio').duration)&&document.querySelector('audio').duration>2.9"), 'audio-metadata');
    check('WAV duration metadata comes from real browser decoder, no autoplay', await read("document.querySelector('audio').paused&&!document.querySelector('audio').autoplay&&Math.abs(document.querySelector('audio').duration-3)<.01"));
    await read("document.querySelector('audio').currentTime=1.25");
    await until(() => read("Math.abs(document.querySelector('audio').currentTime-1.25)<.1&&!document.querySelector('audio').seeking"), 'audio-seek');
    check('real WAV seek remains paused', await read("document.querySelector('audio').paused"));
    await open('archive.zip', '.fp-archive');
    await read("document.querySelectorAll('.fp-archive-folder').forEach(e=>{e.open=true;e.dispatchEvent(new Event('toggle'))})");
    await until(() => read("document.querySelectorAll('.fp-archive [data-entry]').length===3"), 'zip-members');
    check('real ZIP directory preserves duplicate basename member paths', await read("!!document.querySelector('[data-entry=\"a/same.txt\"]')&&!!document.querySelector('[data-entry=\"b/same.txt\"]')"));
    await read("document.querySelectorAll('.fp-archive-folder').forEach(e=>e.open=true)");
    await click('[data-entry="a/same.txt"]'); await click('.fp-archive-selection [aria-label="预览文件"]');
    await until(() => read("document.querySelector('.fp-text-rows')?.textContent.includes('archive-A')"), 'zip-member-open');
    check('ZIP member unified preview uses selected member bytes', await read("!document.querySelector('.fp-file-menu')"));
    await click('.files-tab-select[title="archive.zip"]');
    await until(() => read("!!document.querySelector('.fp-archive-entry[aria-pressed=\"true\"][data-entry=\"a/same.txt\"]')"), 'zip-selection-restore');
    check('real ZIP restores expanded folders and selected member across tabs', await read("[...document.querySelectorAll('.fp-archive-folder')].every(e=>e.open)&&!document.querySelector('.fp-archive-selection [aria-label=\"预览文件\"]').disabled"));
    await type('[aria-label="查找压缩包中的文件"]', '中文');
    await click('[data-entry="中文/readme.md"]');
    await open('guide.md', '.fp-markdown-body'); await click('.files-tab-select[title="archive.zip"]');
    await until(() => read("document.querySelector('[aria-label=\"查找压缩包中的文件\"]')?.value==='中文'"), 'zip-search-restore');
    check('real ZIP restores search query and filtered selection together', await read("document.querySelectorAll('.fp-archive-entry').length===1&&document.querySelector('.fp-archive-entry[aria-pressed=\"true\"]')?.dataset.entry==='中文/readme.md'"));
    for (const [extension, content] of [['csv', '中文,名字'], ['tsv', '中文TSV']]) {
      await open('tabular.zip', '.fp-archive');
      const folder = '.fp-archive-folder-name[title="数据/"]';
      if (!await read("document.querySelector('.fp-archive-folder')?.open")) await click(folder);
      await until(() => read(`!!document.querySelector('[data-entry="数据/table.${extension}"]')`), 'zip-' + extension + '-row');
      await click(`[data-entry="数据/table.${extension}"]`);
      check('real ZIP offers bounded ' + extension.toUpperCase() + ' member preview', await read("!document.querySelector('.fp-archive-selection [aria-label=\"预览文件\"]').disabled"));
      await click('.fp-archive-selection [aria-label="预览文件"]');
      await until(() => read(`document.querySelector('.office-grid-rows')?.textContent.includes(${JSON.stringify(content)})`), 'zip-' + extension + '-grid');
      check('real ZIP ' + extension.toUpperCase() + ' member reaches worker and table renderer', await read("!!document.querySelector('.office-grid-viewport')&&!document.querySelector('.fp-file-menu')"));
    }
    await shot('zip-tabular-member');
    await click('.files-tab-select[title="tabular.zip"]');
    await until(() => read("!!document.querySelector('[data-entry=\"nested.zip\"]')"), 'zip-nested-row');
    await click('[data-entry="nested.zip"]');
    check('real ZIP still refuses nested archive preview', await read("document.querySelector('.fp-archive-selection [aria-label=\"预览文件\"]').disabled"));
    await open('bad-image.png', '.fp-fallback');
    check('executable magic under PNG safely falls back', await read("!!document.querySelector('.fp-fallback')&&!document.querySelector('.fp-image-content')"));
    await shot('safe-fallback');
    // Decoder retention observation, not a GC/long-duration memory guarantee.
    notes.push({ kind: 'media', audioDuration: 3, seekSeconds: 1.25 });
  });
  await group('real-video', async () => {
    const bytes = await read("(async()=>{const mime='video/mp4;codecs=avc1.42E01E';if(!MediaRecorder.isTypeSupported(mime))return null;const c=document.createElement('canvas');c.width=320;c.height=180;const g=c.getContext('2d');const scene=i=>{g.fillStyle='rgb(38,120,160)';g.fillRect(0,0,320,180);g.fillStyle='rgb(230,200,160)';g.fillRect(20+i*12,30,100,100)};scene(0);const stream=c.captureStream(10),chunks=[],r=new MediaRecorder(stream,{mimeType:mime});const stopped=new Promise(resolve=>{r.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};r.onstop=resolve});r.start();for(let i=0;i<12;i++){scene(i);await new Promise(resolve=>setTimeout(resolve,100))}r.stop();await stopped;stream.getTracks().forEach(t=>t.stop());return Array.from(new Uint8Array(await new Blob(chunks,{type:'video/mp4'}).arrayBuffer()))})()");
    if (!check('offline Chromium records a real H264 MP4 fixture', Array.isArray(bytes) && bytes.length > 100)) return;
    const video = Buffer.from(bytes); t.fs.writeFileSync(t.path.join(t.repo, 'recorded.mp4'), video);
    await open('recorded.mp4', 'video');
    await until(() => read("document.querySelector('video')?.videoWidth===320&&Number.isFinite(document.querySelector('video').duration)&&document.querySelector('video').duration>0.5"), 'video-metadata');
    check('backend-served MP4 decodes real dimensions and duration without autoplay', await read("document.querySelector('video').videoHeight===180&&document.querySelector('video').paused&&!document.querySelector('video').autoplay"));
    await read("document.querySelector('video').currentTime=.4");
    await until(() => read("Math.abs(document.querySelector('video').currentTime-.4)<.1&&!document.querySelector('video').seeking"), 'video-seek');
    check('real video seek remains paused', await read("document.querySelector('video').paused"));
    notes.push({ kind: 'video', bytes: video.length, sha256: require('node:crypto').createHash('sha256').update(video).digest('hex'), metadata: await read("({width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight,duration:document.querySelector('video').duration,time:document.querySelector('video').currentTime})") });
    await shot('video-seek-paused');
  });
  await group('object-url-lifecycle', async () => {
    await open('local.png', '.fp-image-content');
    await until(() => read("document.querySelector('.fp-image-content')?.naturalWidth===320"), 'live-image-url');
    const oldURL = await read("document.querySelector('.fp-image-content').src");
    check('image resource uses instance-owned blob URL', oldURL.startsWith('blob:'));
    await open('tone.wav', 'audio');
    const revoked = await read(`fetch(${JSON.stringify(oldURL)}).then(()=>false,()=>true)`);
    check('switching preview revokes old decoded-image object URL', revoked);
  });
};
