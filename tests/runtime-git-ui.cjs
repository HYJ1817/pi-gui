const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
(async()=>{
  let checks=0;const ok=(name,value)=>{assert.ok(value,name);checks++;console.log('PASS '+name);};
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),{url:'http://localhost/'});
  global.document=dom.window.document;global.window=dom.window;global.localStorage=dom.window.localStorage;
  const {configureSecondaryPane}=await import('../public/ui/secondary-surface.js');
  const {setGitConversationScope,restoreGitPath}=await import('../public/api.js');
  const {openChangesPanel,refreshGitNow}=await import('../public/git.js');
  const {S}=await import('../public/state.js');S.hasProject=true;
  let surface;const listeners=[];const pane={root:document.querySelector('#rightPane'),open(next){surface=next;for(const f of listeners)f(next);},close(){surface=null;for(const f of listeners)f(null);},onSurfaceChange:f=>listeners.push(f)};configureSecondaryPane(pane);
  const requests=[];let pendingStatus;
  global.fetch=async(url,opts={})=>({json:async()=>{
    requests.push({url,opts});const scope=opts.headers?.['X-Pi-Gui-Conversation'];
    if(String(url).endsWith('status')){
      if(scope==='A'&&pendingStatus)return new Promise(r=>{pendingStatus=r;});
      return {ok:true,isRepo:true,projectRoot:'/fixture/'+scope,files:[{path:scope+'.txt',status:'M',staged:false,untracked:false,additions:1,deletions:1}]};
    }
    if(String(url).endsWith('restore-all'))return {ok:false,needsPlan:true,plan:{plain:['A.txt'],staged:[],untracked:[],skipped:[]}};
    return {ok:true,action:'restored'};
  }});
  const tick=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
  setGitConversationScope('A');await refreshGitNow();openChangesPanel();await tick();
  [...document.querySelectorAll('.chg-row button')].find(b=>b.textContent==='撤销').click();await tick();
  ok('restore shows actual confirmation',!document.querySelector('#confirmLayer').hidden);
  setGitConversationScope('B');document.querySelector('#confirmCard .danger').click();await tick();
  ok('A confirmation after switch cannot restore B',!requests.some(r=>String(r.url).endsWith('/restore')));
  setGitConversationScope('A');await refreshGitNow();
  [...document.querySelectorAll('.chg-head button')].find(b=>b.textContent==='全部撤销').click();await tick();
  ok('restore-all plan targets captured A',requests.filter(r=>String(r.url).endsWith('restore-all')).at(-1).opts.headers['X-Pi-Gui-Conversation']==='A');
  setGitConversationScope('B');document.querySelector('#confirmCard .danger').click();await tick();
  ok('switch during restore-all confirmation executes no write',requests.filter(r=>String(r.url).endsWith('restore-all')).length===1);
  await restoreGitPath('A.txt',{},'A');ok('explicit captured API identity survives current B',requests.at(-1).opts.headers['X-Pi-Gui-Conversation']==='A');
  setGitConversationScope('A');pendingStatus=true;const old=refreshGitNow();await tick();setGitConversationScope('B');await refreshGitNow();
  pendingStatus({ok:true,isRepo:true,files:[{path:'OLD_A.txt'}]});await old;
  ok('late A Changes status does not overwrite B',S.changes.files[0].path==='B.txt');
  pane.close();dom.window.close();console.log(`Runtime Git UI: ${checks}/${checks}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
