/* Main chat generation ownership and safe error normalization, before SSE.
 * Never stores user message/images. Pi's own retries finish at agent_settled. */
import { classifyGenerationError } from '../lib/model-fallback.js';
const TURN_EVENTS=new Set(['agent_start','agent_end','agent_settled','message_start','message_update','message_end','auto_retry_start','auto_retry_end','tool_execution_start','tool_execution_update','tool_execution_end']);
function safeMessage(message) {
  if(!message || typeof message!=='object') return message;
  if(typeof message.errorMessage!=='string') return message;
  return {...message,errorMessage:classifyGenerationError({message:message.errorMessage,source:'pi-assistant',stopReason:message.stopReason}).reason};
}
function visible(message) {
  return message?.role==='assistant' && Array.isArray(message.content) && message.content.some(c=>c?.type==='toolCall'
    || (c?.type==='text' && typeof c.text==='string' && c.text.length>0) || (c?.type==='thinking' && typeof c.thinking==='string' && c.thinking.length>0));
}
function safeTree(tree) {
  const clone=node=>({...node,...(node?.entry?.message?{entry:{...node.entry,message:safeMessage(node.entry.message)}}:{})});
  const roots=tree.map(clone),stack=tree.map((node,i)=>[node,roots[i]]);
  while(stack.length){const [node,copy]=stack.pop();if(!Array.isArray(node?.children))continue;
    copy.children=node.children.map(clone);node.children.forEach((child,i)=>stack.push([child,copy.children[i]]));}
  return roots;
}
export function createModelGeneration() {
  let owner=null,replayOwner=null,busy=false;
  function reset(){owner=null;replayOwner=null;}
  function guardCommand(cmd) {
    if(!cmd?.__fallbackOwner) return;
    if(cmd.__fallbackOwner!==replayOwner || busy || !['set_model','prompt'].includes(cmd.type)) throw new Error('自动备用请求已失效，未执行');
  }
  function noteCommandAccepted(cmd) {
    if(cmd.type==='prompt') {
      if(busy || owner){reset();return;}
      replayOwner=null;
      owner=typeof cmd.id==='string' && !cmd.message?.trimStart().startsWith('/')?{id:cmd.id,started:false,visible:false,last:null}:null;
      busy=true;
    } else if(['steer','follow_up','abort','new_session','switch_session','fork','set_model'].includes(cmd.type)) {
      if(cmd.type==='set_model' && cmd.__fallbackOwner===replayOwner && replayOwner) return;
      reset();
    }
  }
  function observe(event) {
    let out={...event};
    if(event.type==='bridge_status' && event.state!=='ready'){reset();busy=false;}
    if(event.type==='agent_start'){busy=true;if(!owner)replayOwner=null;}
    if(event.type==='response' && ['new_session','fork','switch_session'].includes(event.command) && event.success){reset();busy=false;}
    if(owner && TURN_EVENTS.has(event.type)) out.generationRequestId=owner.id;
    if(event.type==='message_update') {
      const ae=event.assistantMessageEvent;
      if(owner && ((['text_delta','thinking_delta'].includes(ae?.type) && typeof ae.delta==='string' && ae.delta.length)
        || ae?.type==='toolcall_start' || visible(event.message) || visible(ae?.partial))) owner.visible=true;
      if(ae) out.assistantMessageEvent={...ae,...(ae.partial?{partial:safeMessage(ae.partial)}:{}),...(ae.error?{error:safeMessage(ae.error)}:{})};
    }
    if(event.message) out.message=safeMessage(event.message);
    if(Array.isArray(event.messages)) out.messages=event.messages.map(safeMessage);
    for(const key of ['errorMessage','finalError']) if(typeof event[key]==='string') out[key]=classifyGenerationError({message:event[key],source:'pi-assistant'}).reason;
    if(owner && (visible(event.message) || ['tool_execution_start','compaction_start','extension_error'].includes(event.type))) owner.visible=true;
    if(owner && event.type==='message_end' && event.message?.role==='assistant') {
      const m=event.message;
      owner.last=m.stopReason==='error' || m.stopReason==='aborted'
        ? {outcome:'failed',failure:classifyGenerationError({message:m.errorMessage,source:'pi-assistant',stopReason:m.stopReason})}
        : ['stop','toolUse','length'].includes(m.stopReason)?{outcome:'success'}:{outcome:'unknown'};
    }
    if(event.type==='response' && ['prompt','steer','follow_up'].includes(event.command)) {
      if(event.success===false) out.error=classifyGenerationError({message:event.error,source:'pi-prompt-preflight'}).reason;
      if(owner && event.command==='prompt' && event.id===owner.id) {
        if(event.success===true && event.data?.disposition==='started') owner.started=true;
        else if(event.success===false){out.generationResult={requestId:owner.id,outcome:'failed',hasVisibleOutput:owner.visible,
          failure:classifyGenerationError({message:event.error,source:'pi-prompt-preflight'})};replayOwner=owner.id;owner=null;busy=false;}
        else {reset();if(event.data?.disposition==='handled')busy=false;}
      }
    }
    if(event.type==='agent_settled') {
      if(owner?.started){out.generationResult={requestId:owner.id,...(owner.last||{outcome:'unknown'}),hasVisibleOutput:owner.visible};replayOwner=owner.id;}
      owner=null;busy=false;
    }
    // History carries no ownership; normalize error fields there too.
    if(event.type==='response' && event.command==='get_messages' && event.success){
      if(Array.isArray(event.data)) out.data=event.data.map(safeMessage);
      else if(Array.isArray(event.data?.messages))out.data={...event.data,messages:event.data.messages.map(safeMessage)};
    }
    if(event.type==='response' && event.command==='get_tree' && event.success && Array.isArray(event.data?.tree))out.data={...event.data,tree:safeTree(event.data.tree)};
    return out;
  }
  return {noteCommandAccepted,observe,guardCommand,reset};
}
