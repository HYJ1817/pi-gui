import {fetchProcesses,controlProcess,fetchProcessLogs} from './api.js';
import {openSecondarySurface} from './ui/secondary-surface.js';
import {S} from './state.js';
import {workspaceView,showChat} from './ui/workspace-surface.js';

const LABELS={starting:'启动中',ready:'已就绪',running:'运行中',exited:'已退出',failed:'失败',stopping:'停止中'};
function element(tag,className,text){const node=document.createElement(tag);node.className=className;node.textContent=text||'';return node;}
export function openProcessPanel(){
  if(workspaceView()!=='chat')showChat();
  openSecondarySurface('process',(host,instance)=>{
    host.classList.add('process-panel');
    const head=element('header','process-head');head.append(element('h3','','开发进程'));host.append(head);
    const permission=element('label','process-permission');const toggle=document.createElement('input');toggle.type='checkbox';toggle.setAttribute('aria-label','允许 Agent 管理当前工作区开发进程');permission.append(toggle,document.createTextNode('允许 Agent 管理开发进程'));host.append(permission);
    const note=element('p','process-note','仅当前工作区；与浏览器权限分开。切换工作区或重启 Pi 会清理进程。');host.append(note);
    const message=element('p','process-message');message.setAttribute('role','status');host.append(message);
    const list=element('div','process-list');host.append(list);
    let generation=null,loading=false,disposed=false;const rows=new Map();
    const workspaceChanged=()=>{rows.clear();list.replaceChildren();generation=null;toggle.checked=false;toggle.disabled=true;message.textContent='工作区已切换，正在刷新进程。';};
    document.addEventListener('pi-gui:workspace-generation',workspaceChanged);
    function valid(){return !disposed&&instance.isCurrent();}
    function rowFor(p){
      if(rows.has(p.id))return rows.get(p.id);
      const row=element('section','process-row'),title=element('h4',''),meta=element('p','process-meta'),endpoint=element('p','process-endpoint');
      const actions=element('div','process-actions'),stop=element('button','btn','停止'),restart=element('button','btn','重启'),logs=element('pre','process-logs');logs.setAttribute('aria-label','已脱敏的进程日志');logs.tabIndex=0;
      stop.type=restart.type='button';actions.append(stop,restart);row.append(title,meta,endpoint,actions,logs);list.append(row);
      const state={row,title,meta,endpoint,stop,restart,logs,p,cursor:0,revision:p.revision,workspace:S.workspaceGeneration};rows.set(p.id,state);
      for(const [button,action] of [[stop,'stop'],[restart,'restart']])button.onclick=async()=>{
        if(state.workspace!==S.workspaceGeneration){await refresh();return;}
        const g=generation,revision=state.p.revision;button.disabled=true;
        const result=await controlProcess({action,generation:g,id:p.id,revision});
        if(!valid()||g!==generation||state.workspace!==S.workspaceGeneration)return;
        message.textContent=result.ok?'':`操作未完成：${result.code||'连接不可用'}`;await refresh();
      };
      return state;
    }
    toggle.onchange=async()=>{
      const g=generation,workspace=S.workspaceGeneration;toggle.disabled=true;
      const result=await controlProcess({action:'permission',generation:g,enabled:toggle.checked});
      if(!valid()||g!==generation||workspace!==S.workspaceGeneration)return;message.textContent=result.ok?'':`权限设置未完成：${result.code||'连接不可用'}`;await refresh();
    };
    async function refresh(){
      if(loading||!valid())return;loading=true;
      try{
        const workspace=S.workspaceGeneration;const result=await fetchProcesses();
        if(!valid()||workspace!==S.workspaceGeneration)return;
        if(!result.ok){message.textContent='无法读取开发进程，请稍后重试。';toggle.disabled=true;return;}
        if(generation!==result.generation){generation=result.generation;rows.clear();list.replaceChildren();}
        toggle.checked=result.enabled;toggle.disabled=!S.hasProject||result.available===false||result.cleanupPending;
        note.hidden=result.enabled;
        if(result.processes.length===0)message.textContent=result.enabled?'暂无进程。Agent 可通过进程工具启动开发服务。':'开启权限后，Agent 可启动当前工作区的开发服务。';
        else message.textContent='';
        if(result.available===false)message.textContent='当前 Pi 未确认支持内置进程工具。';
        if(result.cleanupPending)message.textContent='正在清理旧工作区进程，清理确认后才能开启权限。';
        for(const p of result.processes){
          const r=rowFor(p);r.p=p;r.workspace=workspace;r.title.textContent=`${p.command} · ${p.argCount} 个参数`;
          r.meta.textContent=`${LABELS[p.state]||'未知'} · ${Math.floor(p.uptimeMs/1000)} 秒${p.code?' · '+p.code:''}`;
          r.endpoint.textContent=p.endpoint||'';r.endpoint.hidden=!p.endpoint;r.row.dataset.state=p.state;
          r.stop.disabled=!result.enabled||(!['starting','ready','running'].includes(p.state)&&!(p.state==='failed'&&p.cleanupConfirmed===false));r.restart.disabled=!result.enabled||p.state==='stopping';
          if(r.revision!==p.revision){r.revision=p.revision;r.cursor=0;r.logs.textContent='';}
          if(result.enabled){
            const g=generation,revision=p.revision;const data=await fetchProcessLogs(g,p.id,revision,r.cursor);
            if(!valid()||g!==generation||r.revision!==revision||workspace!==S.workspaceGeneration)return;
            if(data.ok&&data.lines.length){r.cursor=data.cursor;r.logs.textContent=(r.logs.textContent+(r.logs.textContent?'\n':'')+(data.truncated?'[较早日志已丢弃]\n':'')+data.lines.map(l=>l.text).join('\n')).split('\n').slice(-256).join('\n').slice(-65536);r.logs.scrollTop=r.logs.scrollHeight;}
          }
        }
      }finally{loading=false;}
    }
    void refresh();const timer=setInterval(refresh,1000);instance.onDispose(()=>{disposed=true;clearInterval(timer);document.removeEventListener('pi-gui:workspace-generation',workspaceChanged);});
  },{label:'开发进程',headerSelector:'.process-head',triggerId:'btnMore'});
}
