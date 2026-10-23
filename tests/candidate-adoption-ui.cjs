const assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
let passed=0;const check=(name,ok)=>{assert(ok,name);passed++;console.log('ok '+name);};
const waitFor=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI fixture timeout');};
(async()=>{
 const dom=new JSDOM(require('node:fs').readFileSync(pathToIndex(),'utf8'),{url:'http://127.0.0.1/'});Object.assign(global,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage});
 const {createCandidateFlow}=await import('../public/candidate-review.js');
 const root=document.createElement('section');document.body.append(root);const calls=[];let current=true,reply,held=null;
 const run={id:'fixture-run',state:'completed',inputId:'input',workspace:{branch:'fixture/candidate'}};
 const result={reliable:true,unconfirmedReasons:[],files:[{path:'<img>.txt',patch:'@@ -1 +1 @@\n-old\n+new\n',change:'modified'}]};
 const flow=createCandidateFlow({root,headers:()=>({'x-pi-gui-owner':'owner-A'}),isCurrent:()=>current,isFresh:()=>true,action:async(body,headers)=>{
   calls.push({body,headers});if(body.action==='list')return{ok:true,runs:[run]};
   if(body.action==='get')return{ok:true,run,result};
   if(body.action==='adoption-prepare'){if(held)return held;return reply||{ok:true,state:'checked_readonly',canApply:false,code:'candidate_apply_unavailable',plan:{runId:run.id,source:'source-fixture',branch:run.workspace.branch,inputId:'input',outputId:'output',counts:{staged:1,working:1},files:[{path:'<img>.txt',change:'modified',beforeBytes:4,afterBytes:4}],indexEffect:'unchanged'}};}
   throw Error('unexpected action');
 }});
 const button=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
 try{
   await flow.history();[...root.querySelectorAll('button')].find(b=>b.textContent.includes('fixture-')).click();
   await waitFor(()=>root.querySelector('.candidate-file'));
   check('completed candidate offers adoption preparation',!!button('准备采纳修改'));
   button('准备采纳修改').click();button('准备采纳修改')?.click();await waitFor(()=>root.textContent.includes('暂不可采纳'));
   check('double check click sends one read-only request',calls.filter(c=>c.body.action==='adoption-prepare').length===1);
   check('plan shows source and snapshots and index policy',root.textContent.includes('source-fixture')&&root.textContent.includes('output')&&root.textContent.includes('暂存区保持原状'));
   check('untrusted file name is inert text',root.textContent.includes('<img>.txt')&&!root.querySelector('img'));
   check('no write confirmation or nonce implied',!button('确认采纳')&&!calls.some(c=>['apply','adoption-confirm','confirm'].includes(c.body.action)));
   check('request carries current authority and only run id',JSON.stringify(calls.find(c=>c.body.action==='adoption-prepare'))===JSON.stringify({body:{action:'adoption-prepare',id:'fixture-run'},headers:{'x-pi-gui-owner':'owner-A'}}));
   button('返回候选 Diff').click();await waitFor(()=>root.querySelector('.candidate-file'));
   reply={ok:false,code:'candidate_source_changed',error:'来源文件内容或身份已变化，已拒绝采纳。'};
   button('准备采纳修改').click();await waitFor(()=>root.textContent.includes('来源文件内容或身份已变化'));
   check('conflict remains refusal without force or confirmation',!root.textContent.includes('强制覆盖')&&!button('确认采纳'));
   button('返回候选 Diff').click();await waitFor(()=>root.querySelector('.candidate-file'));
   let release;held=new Promise(r=>release=r);button('准备采纳修改').click();button('返回候选 Diff').click();await waitFor(()=>root.querySelector('.candidate-file'));release({ok:true,state:'checked_readonly',canApply:false,plan:{files:[]}});await new Promise(r=>setTimeout(r,20));
   check('returning to Diff discards late read-only plan',!root.textContent.includes('本次读取未发现快照冲突'));
   held=new Promise(r=>release=r);button('准备采纳修改').click();current=false;flow.dispose();release({ok:true,state:'checked_readonly',canApply:false,plan:{files:[]}});await new Promise(r=>setTimeout(r,20));
   check('late scope response cannot restore a disposed plan',!root.querySelector('.candidate-flow'));
 }finally{flow.dispose();dom.window.close();}
 console.log(`Candidate adoption UI: ${passed}/${passed}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
function pathToIndex(){return require('node:path').join(__dirname,'../public/index.html');}
