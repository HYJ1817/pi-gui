// Optional desktop capability; the page only requests named actions.
let latest=null,connected=false,refresh=()=>{},reading=null,events=0;
async function readState() {
  if(reading)return reading;
  const revision=events;
  reading=(async()=>{
    try {
      const value=await globalThis.piGuiDesktop.appUpdate.state();
      if(!value||typeof value.phase!=='string')throw Error('unavailable');
      if(events===revision)latest=value;
    } catch {
      if(events===revision)latest={phase:'unavailable',error:'应用内更新服务暂不可用，请重试连接或使用手动下载。'};
    } finally {reading=null;refresh();}
  })();return reading;
}
export function connectAppUpdate(onRefresh) {
  refresh=onRefresh;
  const api=globalThis.piGuiDesktop?.appUpdate;
  if(!api)return;
  if(!connected){
    connected=true;
    api.onState(value=>{if(value&&typeof value.phase==='string'){events++;latest=value;refresh();}});
  }
  if(!latest||latest.phase==='unavailable')readState();
}
export function appUpdateSnapshot(){return latest;}
const size=n=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.round((n||0)/1024)} KB`;
export function paintAppUpdate(container,{available=false,onLater=()=>{}}={}) {
  const api=globalThis.piGuiDesktop?.appUpdate,s=latest;
  if(!api)return;
  const note=text=>{const n=document.createElement('div');n.className='update-hint';n.textContent=text;container.appendChild(n);return n;};
  const action=(text,fn,primary=false)=>{
    const b=document.createElement('button');b.type='button';b.className=primary?'btn primary':'btn';b.textContent=text;
    b.onclick=async()=>{b.disabled=true;try{const r=await fn();if(r?.ok===false&&r.code!=='cancelled')note(r.error||'操作未完成，请重试。');}catch{note('操作失败，请重试或打开 Release 页面。');}finally{b.disabled=false;}};
    acts.appendChild(b);return b;
  };
  const acts=document.createElement('div');acts.className='update-acts update-fixed-actions';
  if(!s){note('正在连接应用内更新服务…');return;}
  if(s.phase==='unavailable'){
    note(s.error);action('重试连接更新服务',()=>readState());container.appendChild(acts);return;
  }
  if(s.completion?.phase==='completed')note(`已更新至 v${s.completion.version}（已确认运行版本）`);
  if(s.completion?.error)note(s.completion.error);
  if(s.completion?.phase==='waiting'){note('更新助手仍在运行，正在等待更新完成…');return;}
  if(s.mode==='development'){note('开发模式仅支持检查更新。');return;}
  if(!available&&!['ready','downloading','verifying','preparing','recovering','installing','failed','cancelled'].includes(s.phase))return;
  if(s.error)note(s.error);
  if(s.phase==='downloading') {
    const p=document.createElement('progress');p.max=s.total||1;p.value=s.received||0;p.setAttribute('aria-label','更新下载进度');container.appendChild(p);
    const pct=s.total?Math.floor(s.received*100/s.total):0;
    note(`${pct}% · ${size(s.received)} / ${size(s.total)} · ${size(s.speed)}/s`);
    action('取消下载',()=>api.cancel());
  } else if(s.phase==='verifying')note('正在校验安装包 SHA256…');
  else if(s.phase==='preparing')note('正在进行安全退出检查，请稍候…');
  else if(s.phase==='recovering')note('正在安全撤销更新，请保持应用打开，完成后可以重试。');
  else if(s.phase==='installing')note('正在退出并准备安装…');
  else if(s.phase==='ready') {
    note(`v${s.version} 已下载并通过 SHA256 校验。`);
    if(s.mode==='installed')action('重启以更新',()=>api.install(),true);
    else {note('便携版请退出应用后手动替换文件。');action('打开下载目录',()=>api.openFolder(),true);}
    action('稍后',async()=>{onLater();return {ok:true};});
  } else {
    action(['failed','cancelled'].includes(s.phase)?'重新下载':s.mode==='portable'?'下载便携版':'下载更新',()=>api.download(),true);
  }
  container.appendChild(acts);
}
