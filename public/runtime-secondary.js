/* Product binding only: the existing controllers retain all authority. */
import { runtimeStore as store, onRuntimeChange } from './runtime-state.js';
import { runtimeSessionAction } from './api.js';
import { createBrowserSurface } from './browser-pane.js';
import { openProcessPanel } from './process-panel.js';
import { openSecondarySurface } from './ui/secondary-surface.js';

const same = (a,b) => Boolean(a&&b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k]));
export function createRuntimeSecondary({pane}) {
  let id=null, owner=null, browser=null, browserScope=null, pendingBrowser=false, serial=0, rebinding=false, alive=true;
  const desktop=()=>window.piGuiDesktop?.runtimeBrowser;
  const current=(captured,token)=>alive&&serial===token&&same(store.get(id)?.owner,captured)&&same(owner,captured);
  const scopeOf=captured=>{const {repoId,...scope}=captured;return scope;};
  function detach(){
    if(browserScope)void desktop()?.occluded(browserScope,true);
    browser?.close();browser=null;browserScope=null;pendingBrowser=false;
  }
  function empty(kind,text,action){
    openSecondarySurface(kind,(host)=>{
      const head=document.createElement('header');head.className='process-head';const title=document.createElement('h3');title.textContent=kind==='runtime-browser'?'Browser':'开发进程';head.append(title);host.append(head);
      const note=document.createElement('p');note.className='process-message';note.setAttribute('role','status');note.textContent=text;host.append(note);
      if(action){const b=document.createElement('button');b.type='button';b.className='btn';b.textContent='打开 Browser';b.onclick=action;host.append(b);}
    },{label:kind==='runtime-browser'?'Browser':'开发进程',headerSelector:'.process-head',triggerId:'btnMore'});
  }
  async function mountBrowser(create=false){
    detach();const captured=owner?{...owner}:null,token=++serial;
    if(!captured){empty('runtime-browser','会话已关闭；恢复会话后可以使用 Browser。');return;}
    if(!desktop()){empty('runtime-browser','Browser 仅在桌面版可用。');return;}
    const scope=scopeOf(captured),api=desktop();
    pendingBrowser=true;empty('runtime-browser','正在读取 Browser…');
    const status=await api.status(scope);if(!current(captured,token))return;
    pendingBrowser=false;
    if(!status?.ok){empty('runtime-browser','此会话的 Browser 当前不可用。');return;}
    if(!create&&!status.opened){empty('runtime-browser','此会话尚未打开 Browser。',()=>void mountBrowser(true));return;}
    const matches=frame=>current(captured,token)&&same(scopeOf(captured),{...frame.scope,sessionId:captured.sessionId});
    const guard=fn=>(...args)=>current(captured,token)?fn(...args):Promise.resolve({ok:false,code:'stale_runtime'});
    const bridge={open:guard(()=>api.open(scope)),navigate:guard(url=>api.navigate(scope,url)),
      back:guard(()=>api.command(scope,'back')),forward:guard(()=>api.command(scope,'forward')),reload:guard(()=>api.command(scope,'reload')),stop:guard(()=>api.command(scope,'stop')),
      setBounds:guard(rect=>api.bounds(scope,rect)),setOccluded:guard(flag=>api.occluded(scope,flag)),setAgentControl:guard(value=>api.enable(scope,value)),agentStatus:guard(()=>api.status(scope)),
      onState:cb=>{const off=api.onState(frame=>{if(matches(frame))cb(frame.state);});queueMicrotask(()=>{if(current(captured,token)&&status.browserState)cb(status.browserState);});return off;},
      onAgentState:cb=>api.onAgentState(frame=>{if(matches(frame))cb(frame.state);}),onNotice:()=>()=>{},openExternal:()=>Promise.resolve({ok:false})};
    browserScope=scope;
    pane.root.querySelector('.rp-body').replaceChildren();
    browser=createBrowserSurface({pane,bridge,surfaceName:'runtime-browser',onAgentState:()=>{},onRequestClose:()=>{
      if(!current(captured,token))return;void api.command(scope,'close');pane.close();
    }});browser.ui.external.hidden=true;
    if(create)await browser.open();else browser.openFromAgent();
  }
  function mountProcesses(){
    detach();
    const captured=owner?{...owner}:null,token=++serial;
    if(!captured){empty('process','会话已关闭；恢复会话后可以使用开发进程。');return;}
    const call=args=>runtimeSessionAction({action:'process',owner:captured,args});
    openProcessPanel({transport:{status:()=>call({action:'status'}),control:call,logs:(generation,id,revision,cursor)=>call({action:'logs',generation,id,revision,cursor})},isOwnerCurrent:()=>current(captured,token)});
  }
  function rebind(){
    const kind=pane.surface();serial++;detach();
    rebinding=true;
    try{if(kind==='runtime-browser'||kind==='browser')void mountBrowser();else if(kind==='process')mountProcesses();}
    finally{rebinding=false;}
  }
  const surfaceOff=pane.onSurfaceChange(next=>{if(!rebinding&&next!=='runtime-browser'&&(browser||pendingBrowser)){serial++;detach();}});
  const unsubscribe=onRuntimeChange(()=>{
    if(!id)return;const next=store.get(id)?.owner||null;
    if(!same(owner,next)&&Boolean(owner||next)){owner=next?{...next}:null;rebind();}
  });
  const openOff=desktop()?.onOpen?.(frame=>{
    if(!owner||!same(scopeOf(owner),{...frame.scope,sessionId:owner.sessionId})||pane.surface()!=='runtime-browser')return;
    void mountBrowser();
  });
  return {focus(next){id=next;owner=store.get(id)?.owner?{...store.get(id).owner}:null;rebind();},
    openBrowser:()=>mountBrowser(true),openProcesses:()=>mountProcesses(),
    leave(){const old=owner;id=null;owner=null;serial++;detach();if(['runtime-browser','process'].includes(pane.surface()))pane.close();if(old)void runtimeSessionAction({action:'blur',owner:old});},
    dispose(){alive=false;serial++;detach();surfaceOff();unsubscribe();openOff?.();}};
}
