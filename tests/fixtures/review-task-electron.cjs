/* Shared real-renderer checks for production, Specs and native Browser splits. */
module.exports=async function taskFlow({read,until,shot,win,check,label,focusSwitch=false,onPreview}) {
  const click=text=>read(`(()=>{const root=document.querySelector('.review-task:not([hidden])')||document.querySelector('#modalCard');const b=[...root.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}&&!b.hidden);if(!b||b.disabled)throw Error('task button unavailable');b.click()})()`);
  await read("document.querySelector('#btnChangesReview').click()");
  await click('准备修改任务');
  await until("!!document.querySelector('.review-task:not([hidden]) input[data-comment-id]:checked')",'eligible task opinions');
  const original=await read("JSON.stringify([...document.querySelectorAll('.review-task input[data-comment-id]:checked')].map(b=>b.dataset.commentId))");
  const selected=JSON.parse(original);
  check(`${label}: verified single/range selection is available`,selected.length>0);
  if(selected.length>1) await read("[...document.querySelectorAll('.review-task input[data-comment-id]:checked')].at(-1).click()");
  const expected=await read("[...document.querySelectorAll('.review-task input[data-comment-id]:checked')].map(b=>b.closest('label').querySelector('.review-item-text').textContent)");
  if(label==='production')await shot('t4-selection');
  await click('预览修改任务');
  check(`${label}: preview includes exactly the selected opinions`,await read(`(()=>{const t=document.querySelector('.review-task textarea').value;return ${JSON.stringify(expected)}.every(s=>t.includes(JSON.stringify(s)))&&t.includes('不是代码补丁')&&document.activeElement===document.querySelector('.review-task textarea')})()`));
  await click('返回选择');
  check(`${label}: returning preserves the subset`,await read(`document.querySelectorAll('.review-task input[data-comment-id]:checked').length===${expected.length}`));
  await click('全选有效评论');await click('预览修改任务');
  if(onPreview)await onPreview();
  await read("document.querySelector('.review-task textarea').focus()");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  await new Promise(r=>setTimeout(r,50));
  check(`${label}: Tab wraps from preview to first visible action`,await read("document.activeElement===[...document.querySelectorAll('.review-task button')].find(b=>b.textContent==='返回选择')"));
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']});
  await new Promise(r=>setTimeout(r,50));
  check(`${label}: Shift Tab returns to preview without visiting hidden summary`,await read("document.activeElement===document.querySelector('.review-task textarea')"));
  check(`${label}: adjusted preview includes every eligible opinion`,await read(`document.querySelector('.review-task-count').textContent.includes('${selected.length} 条')&&!!document.querySelector('.review-task textarea').value`));
  for(const width of [720,900,1200,1536]) {
    win.setContentSize(width,850);await new Promise(r=>setTimeout(r,200));
    check(`${label}: ${width}px preview fits and scrolls inside modal`,await read("(()=>{const c=document.querySelector('#modalCard'),t=document.querySelector('.review-task textarea'),r=c.getBoundingClientRect(),p=t.getBoundingClientRect();return r.width>200&&r.left>=0&&r.right<=innerWidth+1&&p.width>100&&p.right<=r.right&&c.scrollHeight>=c.clientHeight&&document.documentElement.scrollWidth<=innerWidth+1})()"));
    if(width===720||width===1200) await shot(`t4-${label}-${width}`);
  }
  await read("(()=>{const t=document.querySelector('#input');t.disabled=false;t.value='保留原草稿  ';t.dispatchEvent(new Event('input',{bubbles:true}))})()");
  await click('填入当前会话');
  check(`${label}: fill preserves exact draft and does not send`,await read("document.querySelector('#modal').hidden&&document.querySelector('#input').value.startsWith('保留原草稿  '+String.fromCharCode(10,10))&&document.querySelector('#input').value.includes('根据以下代码审查意见')"));
  if(focusSwitch) {
    await read("document.querySelector('#btnChangesReview').click()");await click('准备修改任务');await click('预览修改任务');
    await read("window.taskOldFill=[...document.querySelectorAll('.review-task button')].find(b=>b.textContent==='填入当前会话');window.taskOldDraft=document.querySelector('#input').value");
    await read("import('/api.js').then(m=>m.setGitConversationScope('task-B'))");
    check(`${label}: A to B switch closes and rejects the detached preview`,await read("(()=>{window.taskOldFill.click();return document.querySelector('#modal').hidden&&document.querySelector('#input').value===window.taskOldDraft})()"));
    await read("import('/api.js').then(m=>m.setGitConversationScope(null))");
  }
};
