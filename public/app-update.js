// Optional desktop capability; the page only requests named actions.
import { createSegmentedControl } from './ui/primitives.js';

let latest=null,connected=false,refresh=()=>{},reading=null,events=0,noticeConnected=false;

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
export function connectAppUpdateNotices(onNotice) {
  const api=globalThis.piGuiDesktop?.appUpdate;
  if(!api||noticeConnected||typeof onNotice!=='function')return;
  if(typeof api.onNotice!=='function')return;
  noticeConnected=true;
  api.onNotice(notice=>{
    if(!notice||typeof notice.version!=='string')return;
    onNotice(notice);
  });
}
export function appUpdateSnapshot(){return latest;}
export function requestAppUpdateCheck(){
  const api=globalThis.piGuiDesktop?.appUpdate;
  return api&&typeof api.check==='function'?api.check():Promise.resolve({ok:false,code:'unavailable'});
}
export function saveAppUpdatePreference(preference){
  const api=globalThis.piGuiDesktop?.appUpdate;
  return api&&typeof api.setPreference==='function'
    ?api.setPreference(preference)
    :Promise.resolve({ok:false,code:'unavailable',error:'当前版本不支持修改更新偏好。'});
}
export function ignoreAppUpdateVersion(){
  const api=globalThis.piGuiDesktop?.appUpdate;
  return api&&typeof api.ignore==='function'?api.ignore():Promise.resolve({ok:false,code:'unavailable'});
}
export function unignoreAppUpdateVersion(){
  const api=globalThis.piGuiDesktop?.appUpdate;
  return api&&typeof api.unignore==='function'?api.unignore():Promise.resolve({ok:false,code:'unavailable'});
}
const size=n=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.round((n||0)/1024)} KB`;
const versionOf=s=>s?.version||s?.discovery?.latestVersion||'';
function strictVersion(value){return typeof value==='string'&&/^\d+\.\d+\.\d+$/.test(value);}
function isNewer(candidate,current){
  if(!strictVersion(candidate)||!strictVersion(current))return false;
  const a=candidate.split('.').map(Number),b=current.split('.').map(Number);
  for(let i=0;i<3;i+=1){if(a[i]!==b[i])return a[i]>b[i];}
  return false;
}
function ignoredNow(s){return Boolean(s&&s.ignoredVersion&&s.ignoredVersion===versionOf(s));}
function unsupportedText(reason){
  if(reason==='portable')return '便携版或暂无法确认的安装形态不支持自动安装；更新会保留为手动下载与替换。';
  if(reason==='development')return '开发模式不支持自动下载和安装，仅支持检查更新。';
  if(reason==='platform')return '当前平台不支持自动安装，更新仅支持手动下载。';
  return '当前环境不支持自动安装，更新会保留为手动下载。';
}
function statusText(s){
  if(!s)return '正在读取更新状态…';
  if(s.phase==='downloading')return '正在下载更新';
  if(s.phase==='verifying')return '正在校验安装包';
  if(s.phase==='preparing')return '正在准备安全退出';
  if(s.phase==='recovering')return '正在恢复应用';
  if(s.phase==='installing')return '正在退出并准备安装';
  if(s.phase==='ready')return '更新已准备好';
  if(s.phase==='failed')return '更新失败';
  if(s.phase==='cancelled')return '下载已取消';
  const d=s.discovery;
  if(d?.status==='checking')return '正在检查更新';
  if(d?.status==='available'){
    if(ignoredNow(s))return `已忽略 v${d.latestVersion}`;
    return d.latestVersion?`发现新版本 v${d.latestVersion}`:'发现新版本';
  }
  if(d?.status==='latest')return '已是最新版本';
  if(d?.status==='error')return '检查更新失败';
  return '尚未检查更新';
}
function appendText(container,className,text){
  const n=document.createElement('div');n.className=className;n.textContent=text;container.appendChild(n);return n;
}

/* 信息页里的偏好行。自动选项只在主进程确认「Windows NSIS 安装版」时可用；
 * 其它形态保持可见但禁用并解释原因，绝不显示一个点了也不会生效的开关。 */
export function paintUpdatePreference(container) {
  const api=globalThis.piGuiDesktop?.appUpdate;
  if(!api||typeof api.setPreference!=='function')return false;
  const s=latest;
  const support=Boolean(s?.automaticSupported);
  const selected=s?.preference==='automatic'&&support?'automatic':'manual';
  const row=document.createElement('div');row.className='update-pref-row';
  const copy=document.createElement('div');copy.className='update-pref-copy';
  const label=document.createElement('div');label.className='update-pref-label';label.textContent='更新偏好';
  const hint=document.createElement('div');hint.className='update-pref-hint';
  const automaticHint='自动检查并在后台下载；完成 SHA256 校验后，在正常安全退出应用时安装。';
  const manualHint='自动检查新版本并提醒；下载、校验和安装都由你手动发起。';
  const applyHint=value=>{hint.textContent=value==='automatic'?automaticHint:manualHint;};
  applyHint(selected);
  copy.append(label,hint);
  row.appendChild(copy);

  const tail=document.createElement('div');tail.className='update-pref-tail';
  let appliedValue=selected;
  const control=createSegmentedControl({
    ariaLabel:'更新偏好',
    value:selected,
    options:[
      {value:'automatic',label:'自动',disabled:!support},
      {value:'manual',label:'手动'},
    ],
    onChange:async value=>{
      const previousValue=appliedValue;
      control.setDisabled(true);
      let message='';
      try{
        const result=await saveAppUpdatePreference(value);
        if(result?.ok===false){
          message=result.error||'更新偏好保存失败，请重试。';
          control.setValue(previousValue);
          applyHint(previousValue);
        }else if(result?.persisted===false){
          appliedValue=value;
          applyHint(value);
          message='偏好已在本次运行生效，但写入本地配置失败；重启后可能恢复为上一次设置。';
        }else{
          appliedValue=value;
          applyHint(value);
        }
      }catch{
        message='更新偏好保存失败，请重试。';
        control.setValue(previousValue);
        applyHint(previousValue);
      }finally{
        control.setDisabled(false);
      }
      feedback.textContent=message;
      feedback.hidden=!message;
      feedback.setAttribute('role',message?'alert':'status');
    },
  });
  if(!s)control.setDisabled(true);
  tail.appendChild(control.element);
  row.appendChild(tail);
  container.appendChild(row);

  if(s&&!support){
    appendText(container,'update-pref-note',unsupportedText(s.automaticUnsupportedReason));
  }else if(!s){
    appendText(container,'update-pref-note','正在读取更新偏好…');
  }

  const stateLine=document.createElement('div');
  stateLine.className='update-state';
  stateLine.setAttribute('role','status');
  stateLine.textContent=`更新状态：${statusText(s)}`;
  container.appendChild(stateLine);

  const feedback=document.createElement('div');
  feedback.className='update-pref-error';
  feedback.hidden=true;
  if(s?.preferenceSaveFailed){
    feedback.hidden=false;
    feedback.setAttribute('role','alert');
    feedback.textContent='上次更新设置写入失败；本次运行已按当前选择生效，但重启后可能恢复为上一次设置。';
  }
  container.appendChild(feedback);
  return true;
}

/* 更新器状态与按钮。调用方只在「发现新版本」或更新流程处于活动阶段时调用；
 * 这里仍按 phase 再判一次，避免把过期状态渲染成可安装。 */
export function paintAppUpdate(container,{available=false,onLater=()=>{}}={}) {
  const api=globalThis.piGuiDesktop?.appUpdate,s=latest;
  if(!api)return;
  const note=text=>appendText(container,'update-hint',text);
  const acts=document.createElement('div');acts.className='update-acts update-fixed-actions';
  const feedback=document.createElement('div');feedback.className='update-action-error';feedback.hidden=true;
  feedback.setAttribute('role','alert');
  const action=(text,fn,{primary=false,name=''}={})=>{
    const b=document.createElement('button');b.type='button';b.className=primary?'btn primary':'btn';b.textContent=text;
    if(name)b.setAttribute('data-update-action',name);
    b.onclick=async()=>{
      b.disabled=true;feedback.hidden=true;
      try{
        const r=await fn();
        if(r?.ok===false&&r.code!=='cancelled'){
          feedback.textContent=r.error||'操作未完成，请重试。';
          feedback.hidden=false;
        }
      }catch{
        feedback.textContent='操作失败，请重试或打开 Release 页面。';
        feedback.hidden=false;
      }finally{b.disabled=false;}
    };
    acts.appendChild(b);return b;
  };
  const appendActions=()=>{container.appendChild(feedback);container.appendChild(acts);};
  if(!s){note('正在连接应用内更新服务…');return;}
  if(s.phase==='unavailable'){
    note(s.error);action('重试连接更新服务',()=>readState(),{name:'reconnect'});appendActions();return;
  }
  if(s.completion?.phase==='completed')note(`已更新至 v${s.completion.version}（已确认运行版本）`);
  if(s.completion?.error)note(s.completion.error);
  if(s.completion?.phase==='waiting'){note('更新助手仍在运行，正在等待更新完成…');return;}
  if(s.mode==='development'){note('开发模式仅支持检查更新。');return;}

  const ignoreAction=async()=>{
    const r=await ignoreAppUpdateVersion();
    if(r?.ok!==false)await readState();
    return r;
  };
  const ignored=Boolean(s.ignored||ignoredNow(s));
  const target=versionOf(s)||(ignored?s.ignoredVersion:'');
  if(ignored&&target){
    note(`v${target} 已忽略，不会自动下载或安装。`);
    action('取消忽略',async()=>{const r=await unignoreAppUpdateVersion();if(r?.ok!==false)await readState();return r;},{name:'unignore'});
    appendActions();
    return;
  }

  const active=['ready','downloading','verifying','preparing','recovering','installing','failed','cancelled'].includes(s.phase);
  if(!available&&!active)return;
  if(s.error)note(s.error);
  if(s.phase==='downloading') {
    const p=document.createElement('progress');p.max=s.total||1;p.value=s.received||0;p.setAttribute('aria-label','更新下载进度');container.appendChild(p);
    const pct=s.total?Math.floor(s.received*100/s.total):0;
    note(`${pct}% · ${size(s.received)} / ${size(s.total)} · ${size(s.speed)}/s`);
    action('取消下载',()=>api.cancel(),{name:'cancel'});
    if(target)action('忽略此版本',ignoreAction,{name:'ignore'});
  } else if(s.phase==='verifying') {
    note('正在校验安装包 SHA256…');
    action('取消下载',()=>api.cancel(),{name:'cancel'});
    if(target)action('忽略此版本',ignoreAction,{name:'ignore'});
  }
  else if(s.phase==='preparing')note('正在进行安全退出检查，请稍候…');
  else if(s.phase==='recovering')note('正在安全撤销更新，请保持应用打开，完成后可以重试。');
  else if(s.phase==='installing')note('正在退出并准备安装…');
  else if(s.phase==='ready') {
    const latest=s.discovery?.latestVersion;
    const newer=isNewer(latest,s.version);
    const latestIgnored=strictVersion(latest)&&s.ignoredVersion===latest;
    note(`v${s.version} 已下载并通过 SHA256 校验。`);
    if(newer){
      if(latestIgnored){
        note(`发现更高版本 v${latest}，但它已被忽略；不会自动下载或安装。要更新到这个版本，请先取消忽略。`);
        action('取消忽略',async()=>{const r=await unignoreAppUpdateVersion();if(r?.ok!==false)await readState();return r;},{primary:true,name:'unignore-newer'});
      }else{
        note(`发现更高版本 v${latest}；下载新版本会替换当前已校验包。`);
        action(`下载 v${latest}`,()=>api.download(),{primary:true,name:'download-newer'});
      }
      if(s.mode==='installed')action('重启以更新',()=>api.install(),{name:'install-older'});
      action('稍后',async()=>{onLater();return {ok:true};},{name:'later'});
      appendActions();
      return;
    }
    if(s.preference==='automatic'&&s.automaticSupported&&s.mode==='installed'&&s.installOnQuit!==false)note('将在正常安全退出应用时自动安装；也可以立即重启更新。');
    if(s.mode==='installed')action('重启以更新',()=>api.install(),{primary:true,name:'install'});
    else {note('便携版请退出应用后手动替换文件。');action('打开下载目录',()=>api.openFolder(),{primary:true,name:'folder'});}
    action('稍后',async()=>{onLater();return {ok:true};},{name:'later'});
    if(target)action('忽略此版本',ignoreAction,{name:'ignore'});
  } else {
    if(s.phase==='cancelled')note(s.paused?'下载已取消；在重新下载或发现新版本前，不会自动重试此版本。':'下载已取消，可以重新下载。');
    action(['failed','cancelled'].includes(s.phase)?'重新下载':s.mode==='portable'?'下载便携版':'下载更新',()=>api.download(),{primary:true,name:'download'});
    if(target)action('忽略此版本',ignoreAction,{name:'ignore'});
  }
  appendActions();
}
