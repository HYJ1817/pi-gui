import {fetchProcesses,controlProcess,fetchProcessLogs} from './api.js';
import {openSecondarySurface} from './ui/secondary-surface.js';
import {S} from './state.js';
import {workspaceView,showChat} from './ui/workspace-surface.js';
import {createPaneHeader} from './right-pane.js';

/* 开发进程这一面。
 *
 * ---------- 它不是什么 ----------
 *
 * 这里**没有终端**，也不会有：进程由 Pi 的 gui_process_* 工具在服务端托管，
 * 页面只能看到既有的状态、脱敏日志与停止/重启，且权限默认关闭、与 Browser 分开。
 * UI-4 只改这一面的层级与状态呈现（标题带、状态标记、空/错误/加载），
 * 不新增任何执行入口，也不把 Agent 的「我要跑个命令」当成已有事实。
 *
 * ---------- 事实来源不变 ----------
 *
 * 进程列表、generation、revision、日志游标、权限开关全部照旧来自 status()/control()/logs()。
 * 本文件只决定它们怎么被画出来。 */
const LABELS={starting:'启动中',ready:'已就绪',running:'运行中',exited:'已退出',failed:'失败',stopping:'停止中'};
const RUNNING=['starting','ready','running'];
function element(tag,className,text){const node=document.createElement(tag);node.className=className;node.textContent=text||'';return node;}
export function openProcessPanel({transport=null,isOwnerCurrent=()=>true}={}){
  if(!transport&&workspaceView()!=='chat')showChat();
  const status=transport?.status||fetchProcesses, control=transport?.control||controlProcess, logsFor=transport?.logs||fetchProcessLogs;
  openSecondarySurface('process',(host,instance)=>{
    host.classList.add('process-panel');

    /* ---------- 标题带：与「本会话变更」同一套外壳 ---------- */
    const refreshBtn=element('button','btn tiny rp-btn','刷新');refreshBtn.type='button';refreshBtn.title='重新读取进程状态';refreshBtn.onclick=()=>void refresh();
    const header=createPaneHeader({title:'开发进程',subtitle:'仅当前工作区 · 与 Browser 权限独立',actions:[refreshBtn]});
    host.append(header.el);

    /* 权限开关自占一行：它是一句完整的话，塞进标题带会把标题挤掉。 */
    const toolbar=element('div','process-toolbar');
    const permission=element('label','process-permission');const toggle=document.createElement('input');toggle.type='checkbox';toggle.disabled=true;toggle.setAttribute('aria-label','允许 Agent 管理当前工作区开发进程');permission.append(toggle,document.createTextNode('允许 Agent 管理开发进程'));toolbar.append(permission);host.append(toolbar);

    const note=element('p','process-note','仅当前工作区；与浏览器权限分开。切换工作区或重启 Pi 会清理进程。');host.append(note);
    /* 状态行：会变的东西（读不到 / 正在清理 / 权限设置失败）才写这里。 */
    const message=element('p','process-message');message.setAttribute('role','status');host.append(message);
    /* 列表自己滚：标题带与权限行固定，长日志/多进程不会把整个面板推走。 */
    const list=element('div','process-list rp-scroll');list.setAttribute('aria-label','本工作区开发进程');host.append(list);

    let generation=null,loading=false,disposed=false,emptyBox=null;
    const rows=new Map();

    function tone(text,kind){message.textContent=text;if(kind)message.dataset.tone=kind;else message.removeAttribute('data-tone');}
    function showEmpty(text){
      if(!emptyBox){emptyBox=element('div','rp-empty');emptyBox.append(element('p','rp-empty-title','暂无开发进程'),element('p','rp-empty-text',text));list.append(emptyBox);}
      else emptyBox.querySelector('.rp-empty-text').textContent=text;
    }
    function hideEmpty(){emptyBox?.remove();emptyBox=null;}

    const workspaceChanged=()=>{rows.clear();list.replaceChildren();hideEmpty();generation=null;toggle.checked=false;toggle.disabled=true;tone('工作区已切换，正在刷新进程。','info');};
    document.addEventListener('pi-gui:workspace-generation',workspaceChanged);
    function valid(){return !disposed&&instance.isCurrent()&&isOwnerCurrent();}
    function rowFor(p){
      if(rows.has(p.id))return rows.get(p.id);
      const row=element('section','process-row'),main=element('div','process-row-main'),title=element('h4','process-title'),meta=element('p','process-meta'),endpoint=element('p','process-endpoint');
      const actions=element('div','process-actions'),stop=element('button','btn tiny','停止'),restart=element('button','btn tiny','重启'),logs=element('pre','process-logs');logs.setAttribute('aria-label','已脱敏的进程日志');logs.tabIndex=0;
      stop.type=restart.type='button';
      main.append(title,meta);actions.append(stop,restart);row.append(main,actions,endpoint,logs);list.append(row);hideEmpty();
      const state={row,title,meta,endpoint,stop,restart,logs,p,cursor:0,revision:p.revision,workspace:S.workspaceGeneration};rows.set(p.id,state);
      for(const [button,action] of [[stop,'stop'],[restart,'restart']])button.onclick=async()=>{
        if(state.workspace!==S.workspaceGeneration){await refresh();return;}
        const g=generation,revision=state.p.revision;button.disabled=true;
        const result=await control({action,generation:g,id:p.id,revision});
        if(!valid()||g!==generation||state.workspace!==S.workspaceGeneration)return;
        tone(result.ok?'':`操作未完成：${result.code||'连接不可用'}`,result.ok?undefined:'error');await refresh();
      };
      return state;
    }
    toggle.onchange=async()=>{
      const g=generation,workspace=S.workspaceGeneration;toggle.disabled=true;
      const result=await control({action:'permission',generation:g,enabled:toggle.checked});
      if(!valid()||g!==generation||workspace!==S.workspaceGeneration)return;
      tone(result.ok?'':`权限设置未完成：${result.code||'连接不可用'}`,result.ok?undefined:'error');await refresh();
    };
    async function refresh(){
      if(loading||!valid())return;loading=true;
      try{
        const workspace=S.workspaceGeneration;const result=await status();
        if(!valid()||workspace!==S.workspaceGeneration)return;
        if(!result.ok){tone('无法读取开发进程，请稍后重试。','error');toggle.disabled=true;return;}
        if(generation!==result.generation){generation=result.generation;rows.clear();list.replaceChildren();hideEmpty();}
        toggle.checked=result.enabled;toggle.disabled=(!transport&&!S.hasProject)||result.available===false||result.cleanupPending;
        note.hidden=result.enabled;
        /* 空态是「这里现在没有进程」，不是「读失败了」—— 两者用不同的区块。 */
        if(result.processes.length===0){tone('');showEmpty(result.enabled?'Agent 可通过进程工具启动开发服务。':'开启权限后，Agent 可启动当前工作区的开发服务。');}
        else {tone('');hideEmpty();}
        if(result.available===false){tone('当前 Pi 未确认支持内置进程工具。','warn');hideEmpty();}
        if(result.cleanupPending){tone('正在清理旧工作区进程，清理确认后才能开启权限。','warn');hideEmpty();}
        for(const p of result.processes){
          const r=rowFor(p);r.p=p;r.workspace=workspace;
          r.title.textContent=`${p.command} · ${p.argCount} 个参数`;r.title.title=`${p.command} · ${p.argCount} 个参数`;
          /* 状态文字仍在这一行里：它同时是读屏与验收脚本的事实来源。 */
          r.meta.textContent=`${LABELS[p.state]||'未知'} · ${Math.floor(p.uptimeMs/1000)} 秒${p.code?' · '+p.code:''}`;
          r.endpoint.textContent=p.endpoint||'';r.endpoint.hidden=!p.endpoint;r.row.dataset.state=p.state;
          r.stop.disabled=!result.enabled||(!RUNNING.includes(p.state)&&!(p.state==='failed'&&p.cleanupConfirmed===false));r.restart.disabled=!result.enabled||p.state==='stopping';
          if(r.revision!==p.revision){r.revision=p.revision;r.cursor=0;r.logs.textContent='';}
          if(result.enabled){
            const g=generation,revision=p.revision;const data=await logsFor(g,p.id,revision,r.cursor);
            if(!valid()||g!==generation||r.revision!==revision||workspace!==S.workspaceGeneration)return;
            if(data.ok&&data.lines.length){r.cursor=data.cursor;r.logs.textContent=(r.logs.textContent+(r.logs.textContent?'\n':'')+(data.truncated?'[较早日志已丢弃]\n':'')+data.lines.map(l=>l.text).join('\n')).split('\n').slice(-256).join('\n').slice(-65536);r.logs.scrollTop=r.logs.scrollHeight;}
          }
        }
      }finally{loading=false;}
    }
    void refresh();const timer=setInterval(refresh,1000);instance.onDispose(()=>{disposed=true;clearInterval(timer);document.removeEventListener('pi-gui:workspace-generation',workspaceChanged);});
  },{label:'开发进程',headerSelector:'.rp-head',triggerId:'btnMore'});
}
