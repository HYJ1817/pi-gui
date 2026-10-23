/* Candidate UI owns display lifetime only. Execution is owned by the backend. */
import {candidateRunAction,runtimeSessionAction} from './api.js';
import {diffHtml,bindDiffToggles} from './diff.js';
import {runtimeStore,observeRuntimeFrame,refreshRuntimeViews} from './runtime-state.js';
import {refreshRuntimeResources} from './runtime-resources.js';
import {focusRuntimeById} from './runtime-nav.js';
const states={pending:'待启动',running:'执行中',completed:'已完成',failed:'失败',stopped:'已停止',interrupted:'中断'};
const element=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
export function createCandidateFlow({root,headers,isCurrent,isFresh,selection,action=candidateRunAction}={}){
  const pane=element('section','candidate-flow');pane.hidden=true;root.append(pane);
  let epoch=0,disposed=false,timer=null,runId=null,confirming=false,preparedNonce=null,preparedHeaders=null;
  const alive=()=>!disposed&&!pane.hidden&&root.isConnected&&isCurrent();
  const clearTimer=()=>{if(timer)clearTimeout(timer);timer=null;};
  function cancelPlan(){if(preparedNonce){void action({action:'cancel',nonce:preparedNonce},preparedHeaders).catch(()=>{});preparedNonce=null;}}
  function begin(){cancelPlan();epoch++;clearTimer();pane.hidden=false;root.dataset.candidate='true';pane.replaceChildren();return epoch;}
  function button(text,fn,cls=''){const n=element('button','btn '+cls,text);n.type='button';n.onclick=fn;return n;}
  function back(){cancelPlan();epoch++;clearTimer();pane.hidden=true;delete root.dataset.candidate;root.querySelector('button:not([hidden])')?.focus();}
  function shell(title){pane.replaceChildren(element('h4','',title));const status=element('p','review-summary-status');status.setAttribute('role','status');pane.append(status);
    const bar=element('div','review-summary-actions');bar.append(button('返回修改任务',back));pane.append(bar);return{status,bar};}
  async function open(){
    if(!isFresh())return;
    const token=begin(),{status,bar}=shell('执行前检查');status.textContent='正在核对当前评论、文件内容和执行状态…';
    const sourceHeaders=headers();const result=await action({action:'prepare',...selection()},sourceHeaders);
    if(token!==epoch||!alive()){if(result.ok)void action({action:'cancel',nonce:result.nonce},sourceHeaders);return;}
    if(!result.ok){status.textContent=result.error||'预检未通过，未创建工作区或启动 Agent。';return;}
    preparedNonce=result.nonce;preparedHeaders=sourceHeaders;
    const p=result.plan;status.textContent='预检通过。请核对以下范围，确认后才会创建候选工作区并启动 Agent。';
    pane.append(element('p','review-summary-note',p.warning));
    const info=element('dl','candidate-facts');
    const facts=[['来源',p.source],['当前会话',p.conversationId],['Git HEAD',p.head],['输入快照',p.inputId],['评论 / 文件',`${p.commentCount} 条 / ${p.files.length} 个`],
      ['输入容量',`${p.inputFiles} 个文件 / ${p.inputBytes} 字节`],['Git 状态',`staged ${p.counts.staged} · working ${p.counts.working} · untracked ${p.counts.untracked} · ignored ${p.counts.ignored}`],
      ['候选位置',p.path],['执行资源',`当前 ${p.runtimeCount||0} 条执行线；本次增加一条，上限 3。`],['本次写入','候选工作区、受控 Git 登记、应用内输入/结果证据及独立 Pi 会话；不向原工作区应用修改。']];
    for(const[k,v]of facts)info.append(element('dt','',k),element('dd','',String(v)));pane.append(info);
    const files=element('ul','candidate-files');for(const name of p.files)files.append(element('li','',name));pane.append(files);
    const text=element('textarea','review-feedback-preview');text.readOnly=true;text.rows=8;text.value=p.task;text.setAttribute('aria-label','候选执行任务');pane.append(text);
    const confirm=button('确认创建并执行',async()=>{
      if(confirming||!alive())return;if(!isFresh()){status.textContent='评论、Diff 或会话已变化，请返回重新生成。';confirm.disabled=true;return;}
      confirming=true;preparedNonce=null;confirm.disabled=true;status.textContent='已提交本次确认。正在创建候选，不会自动重试…';
      try{const accepted=await action({action:'confirm',nonce:result.nonce},sourceHeaders);
        if(token!==epoch||!alive())return;
        if(!accepted.ok){status.textContent=accepted.error||'确认结果未知，请查看候选记录，不要重复启动。';return;}
        runId=accepted.run.id;await refresh();
      }finally{confirming=false;}
    },'primary');bar.append(confirm);confirm.focus();
  }
  async function refresh(){
    clearTimer();if(!runId||!alive())return;const token=epoch;
    const result=await action({action:'get',id:runId},headers());
    if(token!==epoch||!alive())return;
    const{status,bar}=shell('候选修改');
    if(!result.ok){status.textContent=result.error||'无法核实候选状态。';bar.append(button('重新查看',refresh));return;}
    const run=result.run;
    if(run.conversationId&&!runtimeStore.get(run.conversationId)){
      // Unknown SSE frames were deliberately refused before this authoritative snapshot.
      await refreshRuntimeResources();if(token!==epoch||!alive())return;
      const record=runtimeStore.get(run.conversationId);
      if(record?.owner){const owner={...record.owner};const events=await runtimeSessionAction({action:'events',owner,cursor:record.cursor});
        if(events?.ok&&JSON.stringify(runtimeStore.get(run.conversationId)?.owner)===JSON.stringify(owner)){
          for(const frame of events.events||[])observeRuntimeFrame(frame);
          runtimeStore.reconcileApprovals(owner,events.approvals||[],events.cursor);refreshRuntimeViews();
        }
      }
      if(token!==epoch||!alive())return;
    }
    status.textContent=`${states[run.state]||'结果不可用'}${run.reason?' · '+run.reason:''}`;
    pane.append(element('p','review-summary-note',run.warning||'关闭预览会保留候选工作区。'));
    pane.append(element('p','candidate-snapshot','输入快照：'+(run.inputId||'待确认')));
    if(run.workspace)pane.append(element('p','candidate-snapshot','候选分支：'+run.workspace.branch));
    if(run.conversationId)bar.append(button('打开候选会话查看审批',async()=>{if(alive())await focusRuntimeById(run.conversationId);}));
    if(['pending','running'].includes(run.state)){
      const stop=button('停止候选执行',async()=>{if(!alive())return;stop.disabled=true;const result=await action({action:'stop',id:runId},headers());if(!alive())return;if(!result.ok)status.textContent=result.error||'停止尚未确认。';else await refresh();});bar.append(stop);
      pane.append(element('p','review-summary-note','执行由独立会话持有。关闭面板不会停止、删除或重发任务；审批可在候选会话处理。'));
      timer=setTimeout(()=>void refresh(),1500);timer.unref?.();
    }else bar.append(button('保留候选结果',()=>{status.textContent='候选工作区已保留；未应用到原项目，结束预览不会删除。';}));
    if(!result.result){pane.append(element('p','review-summary-note','尚无可核实的执行前后 Diff。'));return;}
    const evidence=result.result;pane.append(element('p','review-summary-note',evidence.notice||(!evidence.reliable?'结果无法可靠确认':'执行前后真实 Diff')));
    if(evidence.truncated)pane.append(element('p','review-summary-note','Diff 超出容量，以下为明确截断的结果。'));
    if(!evidence.files.length)pane.append(element('p','review-summary-empty','相对输入快照未观察到文件变化。'));
    for(const file of evidence.files){const detail=element('details','candidate-file'),summary=element('summary','',`${file.path} · ${file.change} · +${file.additions??'—'} −${file.deletions??'—'}`);detail.append(summary);
      if(file.oldPath)detail.append(element('p','review-summary-note','原路径：'+file.oldPath));
      if(file.binary)detail.append(element('p','','二进制文件已变化，不展示文本 Diff。'));
      else{const diff=element('div','candidate-diff');diff.innerHTML=diffHtml(file.patch);bindDiffToggles(diff);detail.append(diff);}
      if(file.truncated)detail.append(element('p','','该文件 Diff 已截断。'));pane.append(detail);}
  }
  async function history(){const token=begin(),{status,bar}=shell('保留的候选修改');const result=await action({action:'list'},headers());if(token!==epoch||!alive())return;
    if(!result.ok){status.textContent=result.error||'候选记录不可用。';return;}status.textContent=result.runs.length?'候选结果与当前来源作用域关联；不会自动恢复 Agent。':'当前作用域没有候选结果。';
    for(const run of result.runs)bar.append(button(`${states[run.state]||'结果不可用'} · ${run.id.slice(0,8)}`,()=>{runId=run.id;void refresh();}));}
  return{open,history,refresh,dispose(){cancelPlan();disposed=true;epoch++;clearTimer();pane.remove();delete root.dataset.candidate;}};
}
