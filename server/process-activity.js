const NAMES=new Set(['gui_process_start','gui_process_status','gui_process_logs','gui_process_stop','gui_process_restart']);
const STATES=new Set(['starting','ready','running','exited','failed','stopping']);
// SSE/diagnostics get a structural projection; Pi's private ToolResult is unchanged.
export function projectProcessEvent(event){
  if(!NAMES.has(event?.toolName||event?.name))return event;
  if(event.type==='tool_execution_start')return {...event,args:{}};
  if(['tool_execution_end','tool_execution_update'].includes(event.type)){
    const details=event.result?.details||{};
    const projected={content:[{type:'text',text:'开发进程动作'}],details:{ok:details.ok===true,process:STATES.has(details.process?.state)?{state:details.process.state}:null}};
    return event.type==='tool_execution_update'?{...event,args:{},partialResult:projected,result:projected}:{...event,result:projected};
  }
  return event;
}
