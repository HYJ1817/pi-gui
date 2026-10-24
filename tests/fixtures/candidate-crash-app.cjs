/* Reuse the production UI/server Electron acceptance path with two TEMP files.
 * Only the backend checkpoint and fake Pi are instrumented; restart is unmodified.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const file = path.resolve(__dirname, '../candidate-electron.cjs');
let source = fs.readFileSync(file, 'utf8');
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw Error('Electron fixture marker changed: ' + before.slice(0, 50));
  source = source.replace(before, after);
}
if (process.env.CANDIDATE_CRASH_RESTART === '1') {
  const meta = JSON.parse(fs.readFileSync(path.join(process.env.T4B_EVIDENCE_DIR, 'world.json')));
  replaceOnce("const world=fs.mkdtempSync(path.join(os.tmpdir(),'t4b-electron-'));", 'const world=' + JSON.stringify(meta.world) + ';');
  const start = source.indexOf(' const repo=');
  const end = source.indexOf(" const net=require('node:net')", start);
  if (start < 0 || end < 0) throw Error('restart setup marker changed');
  source = source.slice(0, start) + `
 const repo=path.join(world,'source'),data=path.join(world,'data'),home=path.join(world,'home'),shim=path.join(world,'pi.cmd');
` + source.slice(end);
  const tail = source.indexOf(' await read("document.querySelector(\'#navChanges\').click()")');
  if (tail < 0) throw Error('restart UI marker changed');
  const cleanup = source.indexOf(' await stopBackend();fs.writeFileSync', tail);
  source = source.slice(0, tail) + `
 await read("document.querySelector('#navChanges').click()");
 await until("!!document.querySelector('#btnChangesReview')",'restart Changes');
 await until("import('/review-comment-persistence.js').then(m=>m.reviewPersistenceState().status==='ready')",'restart comments');
 await read("document.querySelector('#btnChangesReview').click()");await click('准备修改任务');await click('候选修改');
 await until("[...document.querySelectorAll('.candidate-flow button')].some(b=>b.textContent.startsWith('已完成'))",'retained candidate');
 await read("[...document.querySelectorAll('.candidate-flow button')].find(b=>b.textContent.startsWith('已完成')).click()");
 await until("document.querySelector('.candidate-flow')?.textContent.includes('候选写入锁尚未释放')",'stale execution lock refusal');
 check('restart UI reports the preserved execution lock',true);
 check('restart offers no adoption or recovery confirmation',!await read("[...document.querySelectorAll('.candidate-flow button')].some(b=>['确认采纳','确认恢复'].includes(b.textContent))"));
 await shot('restart-refused');
` + source.slice(cleanup);
} else {
  // The two-file Diff sorts second.txt first; retain the original app.js assertion.
  source = source.replaceAll("document.querySelector('.candidate-diff').textContent", "[...document.querySelectorAll('.candidate-diff')].map(n=>n.textContent).join('')");
  replaceOnce(' const git=(...a)=>', " fs.writeFileSync(path.join(repo,'second.txt'),'base\\n');\n const git=(...a)=>");
  const copy = " fs.copyFileSync(path.join(ROOT,'tests/fixtures/candidate-pi.cjs'),path.join(pkg,'cli.cjs'));";
  replaceOnce(copy, copy + `
 let fake=fs.readFileSync(path.join(pkg,'cli.cjs'),'utf8');
 const end=" streaming=false;send({type:'agent_end'});send({type:'agent_settled'});";
 if(fake.split(end).length!==2)throw Error('fake Pi write marker changed');
 fake=fake.replace(end,\` const extra='second.txt',bytes='changed'+String.fromCharCode(10),extraCall='fixture-second-'+current;
 send({type:'tool_execution_start',toolCallId:extraCall,toolName:'write',args:{path:extra}});
 await guard('begin',{callId:extraCall,toolCallId:extraCall,readOnly:false,audit:{kind:'write',path:extra,expectedHash:crypto.createHash('sha256').update(bytes).digest('hex')}});
 fs.writeFileSync(path.join(cwd,extra),bytes);await guard('end',{callId:extraCall});
 send({type:'tool_execution_end',toolCallId:extraCall,toolName:'write',isError:false});
\`+end);new (require('node:vm').Script)(fake);fs.writeFileSync(path.join(pkg,'cli.cjs'),fake);
`);
  replaceOnce("[path.join(ROOT,'server.js')]", "[path.join(ROOT,'tests/fixtures/candidate-crash-backend.cjs')]");
  const confirmed = "await click('确认采纳','.candidate-flow');";
  replaceOnce(confirmed, `fs.writeFileSync(path.join(OUT,'world.json'),JSON.stringify({world,index:originalIndex.toString('base64'),staged:git('ls-files','--stage','-z')}));` + confirmed);
  const start = source.indexOf('  await until("document.querySelector(\'.candidate-flow\')?.textContent.includes(\'已采纳\')"');
  const cleanup = source.indexOf(' await stopBackend();fs.writeFileSync', start);
  if (start < 0 || cleanup < 0) throw Error('adoption checkpoint marker changed');
  source = source.slice(0, start) + `
  if(process.env.CANDIDATE_CRASH_PHASE==='recovering'){
   await until("document.querySelector('.candidate-flow')?.textContent.includes('需要恢复')",'partial apply');
   await click('返回候选 Diff','.candidate-flow');
   await until("[...document.querySelectorAll('.candidate-flow button')].some(b=>b.textContent==='检查恢复条件')",'recovery entry');
   await click('检查恢复条件','.candidate-flow');
   await until("document.querySelector('.candidate-flow')?.textContent.includes('恢复条件通过')",'recovery preflight');
   await shot('recovery-preflight');await click('确认恢复','.candidate-flow');
  }
  await new Promise(()=>{}); // Parent kills this entire app tree at the persisted checkpoint.
 }
` + source.slice(cleanup);
}
const compiled = new Module(file, module);
compiled.filename = file;
compiled.paths = Module._nodeModulePaths(path.dirname(file));
compiled._compile(source, file);
