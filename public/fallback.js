/* Single coordinator for a single owned user prompt. Payload stays in closure,
 * never in the public runtime/history. Model switching is injected by rpc.js. */
import { S, el } from './state.js';
import { fetchProjectConfig, sendCommand } from './api.js';
import { toast } from './ui/toast.js';
import { updateSendState } from './composer.js';
import { modelIdentity } from './model-capabilities.js';
import { normalizeFallbackConfig, sameModel, safeFallbackFailure, nextFallbackCandidate, createFallbackRuntime } from './model-fallback.js';
let active=null,epoch=0,sequence=0,switchModel=null;
const requestPrefix='composer-generation-'+Math.random().toString(36).slice(2)+'-';
const sessionIdentity=()=>S.state?.sessionId || S.state?.sessionFile || null;
function identity(){return {workspace:S.workspaceGeneration,cwd:S.cwd,session:sessionIdentity(),run:S.bridgeRun,instance:S.bridgeInstance};}
function owns(s){const i=identity();return active===s && s.epoch===epoch && !S.switching && S.bridgeState==='ready'
  && Object.keys(i).every(k=>i[k]===s.identity[k]);}
export function setFallbackModelSwitcher(fn){switchModel=fn;}
function publish(s){S.fallbackRuntime=s.runtime.snapshot();S.fallbackActive=S.fallbackRuntime.active;renderFallbackStatus();updateSendState();}
function finish(s,result,{cleanup=false,notice=''}={}) {
  if(active!==s)return;
  if(cleanup && owns(s))s.cleanup();
  s.runtime.finish(result);active=null;publish(s);
  // Release large request/image buffers at the terminal boundary.
  s.command=null;s.cleanup=null;
  if(notice)toast(notice,result==='completed'?'info':'warn');
}
export function cancelFallback(reason='user-operation') {
  epoch++;
  if(active)finish(active,'cancelled');
  if (['workspace-switch','session-switch','session-changed','boot','bridge-lifecycle'].includes(reason)) {
    S.fallbackRuntime=null;renderFallbackStatus();
  }
}
S.cancelFallback=cancelFallback;
export async function startFallbackRequest(command,cleanup) {
  if(command.type!=='prompt' || command.message.trimStart().startsWith('/') || !sessionIdentity() || !switchModel) return false;
  const before=identity(),startEpoch=epoch;
  const j=await fetchProjectConfig();
  if(startEpoch!==epoch || Object.keys(before).some(k=>before[k]!==identity()[k]) || S.switching || S.bridgeState!=='ready')return true;
  if(!j?.ok || !j.hasProject || !j.config || (j.cwd && j.cwd!==S.cwd))return false;
  const config=normalizeFallbackConfig(j.config.fallback,S.state?.model);
  if(!config.enabled)return false;
  const model=modelIdentity(S.state?.model);
  if(!model.providerId || !model.modelId || S.streaming)return false;
  const s=active={epoch,identity:before,config,command:{...command,images:command.images?.map(i=>({...i}))},cleanup,
    requestId:requestPrefix+(++sequence),processing:false,
    requirements:{textInput:true,imageInput:!!command.images?.length},runtime:createFallbackRuntime({generation:epoch,originalModel:model})};
  publish(s);
  const result=await sendCommand({...s.command,id:s.requestId});
  if(active===s && !result?.ok)finish(s,'stopped');
  return true;
}
export function observeFallbackState(data) {
  if(active && (data?.sessionId || data?.sessionFile) && (data.sessionId || data.sessionFile)!==active.identity.session)cancelFallback('session-changed');
}
export function observeFallbackEvent(evt) {
  if(evt?._replay)return;
  const s=active;
  if(!s)return;
  if(!owns(s)){cancelFallback('identity-changed');return;}
  if(evt.type==='agent_start' && evt.generationRequestId!==s.requestId){cancelFallback('other-generation');return;}
  if(evt.type==='agent_settled' && !evt.generationResult){finish(s,'stopped',{notice:'Pi 未提供可归属的生成结果，自动备用未执行。'});return;}
  if(evt.type==='response' && evt.command==='prompt' && evt.id===s.requestId && evt.success
    && ['queued','handled'].includes(evt.data?.disposition)) {finish(s,'completed',{cleanup:true});return;}
  const result=evt.generationResult;
  if(!result || result.requestId!==s.requestId || s.processing)return;
  s.processing=true;
  // Let agent_settled UI finish first; Pi native retry lifecycle has priority.
  queueMicrotask(()=>completeAttempt(s,result));
}
async function completeAttempt(s,result) {
  if(!owns(s))return;
  if(result.outcome==='success')return finish(s,'completed',{cleanup:true,
    notice:s.runtime.snapshot().history.length?'已使用备用模型完成请求，当前模型保持不变。':''});
  const failure=safeFallbackFailure(result.failure);
  if(result.outcome!=='failed' || result.hasVisibleOutput!==false || !failure.retryable) {
    return finish(s,'stopped',{notice:result.hasVisibleOutput?'已有回答或工具活动，自动备用未执行。':failure.reason});
  }
  const chosen=nextFallbackCandidate({...s.config,attemptedModels:s.runtime.snapshot().attemptedModels,models:S.models,requirements:s.requirements});
  if(!chosen.candidate)return finish(s,'exhausted',{notice:'备用模型已耗尽或不适合当前请求，已停止自动切换。'});
  const id=chosen.candidate;
  s.runtime.attempt(id,failure,chosen.unconfirmed);publish(s);
  toast(`${failure.reason}，正在尝试 ${id.providerId} / ${id.modelId}${chosen.unconfirmed.length?'（输入能力未确认）':''}。`,'info');
  const confirmed=await switchModel(id,s.requestId);
  if(!owns(s))return;
  if(!confirmed || !sameModel(S.state?.model,id))return finish(s,'stopped',{notice:'Pi 未确认备用模型，已停止自动切换。'});
  s.runtime.confirmed(S.state.model);publish(s);
  // Recheck actual Pi-reported capabilities, not the older discovery list.
  const check=nextFallbackCandidate({chain:[id],models:[S.state.model],requirements:s.requirements});
  if(!check.candidate){s.processing=false;return completeAttempt(s,result);}
  if(S.streaming)return finish(s,'stopped',{notice:'Pi 已开始另一轮工作，自动备用未执行。'});
  const previous=s.requestId;s.requestId=requestPrefix+(++sequence);s.processing=false;
  const response=await sendCommand({...s.command,id:s.requestId,__fallbackOwner:previous});
  if(active===s && !response?.ok)finish(s,'stopped');
}
export function renderFallbackStatus() {
  let box=document.getElementById('fallbackStatus');
  if(!box){box=document.createElement('details');box.id='fallbackStatus';box.className='fallback-status';el.composerBox.prepend(box);}
  const state=S.fallbackRuntime;
  box.hidden=!state;box.replaceChildren();if(!state)return;
  const summary=document.createElement('summary');
  const labels={running:'自动备用已启用，正在等待 Pi 结果',switching:'正在切换备用模型',completed:'请求已完成',stopped:'自动备用已停止',exhausted:'备用模型已耗尽',cancelled:'自动备用已取消'};
  summary.textContent=labels[state.phase] || '自动备用';box.appendChild(summary);
  const results={switching:'切换中',running:'生成中',failed:'失败',completed:'已完成',cancelled:'已取消',exhausted:'已耗尽',stopped:'已停止'};
  for(const h of state.history){const row=document.createElement('div');row.textContent=`${h.from.providerId}/${h.from.modelId} → ${h.to.providerId}/${h.to.modelId} · ${h.reason} · ${results[h.result] || '已结束'}${h.unconfirmed.length?' · 输入能力未确认':''}`;box.appendChild(row);}
  el.btnStop.hidden=!(S.streaming || S.fallbackActive);
}
