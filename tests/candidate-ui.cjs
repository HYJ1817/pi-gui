const assert=require('node:assert/strict'),{JSDOM}=require('jsdom');let checks=0;
const check=(name,fn)=>{assert(fn(),name);checks++;console.log('ok '+name);};
const tick=()=>new Promise(r=>setTimeout(r,10));
(async()=>{
 const dom=new JSDOM(require('node:fs').readFileSync(require('node:path').join(__dirname,'../public/index.html'),'utf8'),{url:'http://127.0.0.1/'});Object.assign(global,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage});
 let createCandidateFlow;try{({createCandidateFlow}=await import('../public/candidate-review.js'));}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 check('candidate UI is available',()=>typeof createCandidateFlow==='function');
 const calls=[],root=document.createElement('section');document.body.append(root);let fresh=true,reply;
 const flow=createCandidateFlow({root,headers:()=>({}),isCurrent:()=>true,isFresh:()=>fresh,selection:()=>({selectedIds:['a']}),action:async body=>{
  calls.push(body);if(body.action==='prepare')return{ok:true,nonce:'nonce',plan:{head:'a'.repeat(40),inputId:'b'.repeat(64),source:'fixture',conversationId:'A',commentCount:1,files:['<img>.js'],inputFiles:1,inputBytes:4,path:'candidate',counts:{staged:1,working:1,untracked:0,ignored:0},warning:'not OS sandbox',task:'quoted opinion',runtimeCount:1}};
  if(body.action==='confirm')return{ok:true,run:{id:'run',state:'running'}};
  return reply||{ok:true,run:{id:'run',state:'running'},result:null};
 }});
 const button=t=>[...root.querySelectorAll('button')].find(b=>b.textContent===t);
 await flow.open();check('preflight never starts task',()=>calls.length===1&&calls[0].action==='prepare');
 check('paths rendered as inert text',()=>root.textContent.includes('<img>.js')&&!root.querySelector('img'));
 check('confirmation explicit and enabled',()=>button('确认创建并执行')&&!button('确认创建并执行').disabled);
 fresh=false;button('确认创建并执行').click();await tick();check('stale selection never confirms',()=>!calls.some(c=>c.action==='confirm'));
 fresh=true;await flow.open();button('确认创建并执行').click();button('确认创建并执行')?.click();await tick();
 check('double click confirms once',()=>calls.filter(c=>c.action==='confirm').length===1);
 reply={ok:true,run:{id:'run',state:'completed',inputId:'input'},result:{reliable:false,notice:'结果无法可靠确认',files:[{path:'a.js',change:'modified',additions:1,deletions:1,patch:'@@ -1 +1 @@\n-old\n+<script>\n',binary:false}],truncated:false}};
 await flow.refresh();check('actual Diff shown safely',()=>root.textContent.includes('结果无法可靠确认')&&root.textContent.includes('<script>')&&!root.querySelector('script'));
 button('返回修改任务').click();check('back only closes view',()=>!calls.some(c=>['remove','delete','abort'].includes(c.action)));
 flow.dispose();check('dispose removes flow nodes',()=>!root.querySelector('.candidate-flow'));
 console.log(`Candidate UI: ${checks}/${checks}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
