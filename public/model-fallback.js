/* Pure fallback policy. No I/O, names-as-capabilities, raw payload history or credentials. */
import { modelIdentity, modelCapability } from './model-capabilities.js';
export const sameModel = (a,b) => {
  const x=modelIdentity(a), y=modelIdentity(b);
  return !!x.providerId && !!x.modelId && x.providerId===y.providerId && x.modelId===y.modelId;
};
export function normalizeFallbackConfig(raw, primary=null) {
  const chain=[];
  for(const item of (Array.isArray(raw?.chain)?raw.chain:[]).slice(0,100)) {
    const id=modelIdentity(item);
    if(!id.providerId || !id.modelId || sameModel(id,primary) || chain.some(m=>sameModel(m,id))) continue;
    chain.push(id);
    if(chain.length===20) break;
  }
  return {enabled:raw?.enabled===true && chain.length>0,chain};
}
const REASONS={
  rate_limited:'当前模型触发限流',quota_exhausted:'当前模型额度已耗尽',
  provider_unavailable:'模型服务暂时不可用',retryable_provider_error:'模型服务端暂时出错',
  model_unavailable:'当前模型不可用',auth_error:'当前模型认证失败，自动备用未执行',
  request_incompatible:'请求与模型不兼容，自动备用未执行',context_overflow:'上下文超出上限，自动备用未执行',
  user_cancelled:'请求已取消',unknown:'模型请求失败，无法确认可安全重试',
};
const RETRYABLE=new Set(['rate_limited','quota_exhausted','provider_unavailable','retryable_provider_error','model_unavailable']);
/* Pi RPC loses SDK status objects. Only parse known HTTP display prefixes from
 * pi-ai error-body.formatProviderError / SDK APIError.makeMessage. Do not scan
 * arbitrary text for status numbers. Structured body codes are read privately. */
export function classifyGenerationError({message='',source='unknown',stopReason}={}) {
  const trusted=['pi-assistant','pi-prompt-preflight'].includes(source);
  const raw=trusted && typeof message==='string'?message.slice(0,8192).trim():'';
  const match=/^(?:([45]\d\d)(?=[:\s])|(?:OpenAI API error|Anthropic API error|Google API error|Mistral API error|Bedrock API error) \(([45]\d\d)\):)/.exec(raw);
  const statusCode=match?Number(match[1]||match[2]):null;
  let code=null, bodyMessage='';
  try {const obj=JSON.parse(raw.slice(match?.[0].length||0).replace(/^:\s*/,''));
    const e=obj?.error||obj; code=e?.code||e?.type; bodyMessage=typeof e?.message==='string'?e.message:'';
  } catch { /* Unstructured formats remain conservative. */ }
  let cls='unknown';
  if(stopReason==='aborted' || raw==='Retry cancelled') cls='user_cancelled';
  else if(statusCode===401 || statusCode===403) cls='auth_error';
  else if(code==='context_length_exceeded' || code==='model_context_window_exceeded'
    || /^(?:Your input exceeds the context window|prompt (?:is )?too long|context_length_exceeded)/i.test(bodyMessage||raw)) cls='context_overflow';
  else if(statusCode===400 || statusCode===413 || statusCode===422) cls='request_incompatible';
  else if((statusCode===429 || statusCode===402) && (['insufficient_quota','quota_exhausted','insufficient_balance'].includes(code)
    || /^(?:Insufficient Balance|You exceeded your current quota|Quota exceeded)/i.test(bodyMessage))) cls='quota_exhausted';
  else if(statusCode===429) cls='rate_limited';
  else if(statusCode===503 || statusCode===502 || statusCode===504) cls='provider_unavailable';
  else if(statusCode>=500 && statusCode<=599) cls='retryable_provider_error';
  else if(statusCode===404 && ['model_not_found','model_unavailable'].includes(code)) cls='model_unavailable';
  else if(['Connection error.','Request timed out.','fetch failed','Provider finish_reason: network_error'].includes(raw)) cls='provider_unavailable';
  return {class:cls,retryable:trusted && RETRYABLE.has(cls),reason:REASONS[cls],source:trusted?source:'unknown',statusCode};
}
export function safeFallbackFailure(value) {
  const cls=Object.hasOwn(REASONS,value?.class)?value.class:'unknown';
  return {class:cls,retryable:RETRYABLE.has(cls) && value?.retryable===true,reason:REASONS[cls],
    source:['pi-assistant','pi-prompt-preflight'].includes(value?.source)?value.source:'unknown',
    statusCode:Number.isInteger(value?.statusCode) && value.statusCode>=400 && value.statusCode<=599?value.statusCode:null};
}
export function nextFallbackCandidate({chain=[],attemptedModels=[],models=[],requirements={}}={}) {
  const skipped=[];
  for(const id of chain) {
    if(attemptedModels.some(m=>sameModel(m,id))) continue;
    const found=models.find(m=>sameModel(m,id));
    if(!found){skipped.push({...modelIdentity(id),reason:'model-unavailable'});continue;}
    const caps=modelCapability(found).capabilities, needed=['textInput','imageInput'].filter(k=>requirements[k]===true);
    const blocked=needed.find(k=>caps[k]===false);
    if(blocked){skipped.push({...modelIdentity(id),reason:blocked+'-unsupported'});continue;}
    return {candidate:modelIdentity(found),unconfirmed:needed.filter(k=>caps[k]===null),skipped};
  }
  return {candidate:null,unconfirmed:[],skipped};
}
export function createFallbackRuntime({generation,originalModel}={}) {
  const original=modelIdentity(originalModel),attemptedModels=[original],history=[];
  let currentModel=original,phase='running';
  return {
    attempt(to,failure,unconfirmed=[],startedAt=Date.now()) {
      if(attemptedModels.some(m=>sameModel(m,to))) return false;
      if(history.length)history.at(-1).result='failed';
      const id=modelIdentity(to),e=safeFallbackFailure(failure);
      history.push({from:currentModel,to:id,reason:e.reason,errorClass:e.class,source:e.source,statusCode:e.statusCode,
        unconfirmed:unconfirmed.filter(k=>['textInput','imageInput'].includes(k)),startedAt,result:'switching'});
      attemptedModels.push(id);phase='switching';return true;
    },
    confirmed(model){currentModel=modelIdentity(model);phase='running';if(history.length)history.at(-1).result='running';},
    finish(result){phase=result;if(history.length)history.at(-1).result=result;},
    snapshot(){return {generation,originalModel:original,currentModel,attemptedModels:attemptedModels.map(m=>({...m})),history:history.map(h=>({...h})),phase,
      active:['running','switching'].includes(phase),exhausted:phase==='exhausted'};},
  };
}
