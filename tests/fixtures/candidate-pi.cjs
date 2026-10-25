/* Deterministic fake Pi: no model/network except the existing private loopback guard. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
if(process.argv.includes('--version')){console.log('1.3.0');process.exit(0);}
if(!process.argv.includes('--mode'))process.exit(0);
const cwd=process.cwd(),hash=crypto.createHash('sha256').update(cwd).digest('hex');
const sessionId=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
const dir=path.join(process.env.PI_CODING_AGENT_DIR,'sessions','--'+cwd.replace(/[\\/:]/g,'-')+'--');fs.mkdirSync(dir,{recursive:true});
const sessionFile=path.join(dir,'2026-01-01T00-00-00-000Z_'+sessionId+'.jsonl');
if(!fs.existsSync(sessionFile))fs.writeFileSync(sessionFile,JSON.stringify({type:'session',version:3,id:sessionId,cwd,timestamp:'2026-01-01T00:00:00.000Z'})+'\n');
const send=e=>console.log(JSON.stringify(e));let streaming=false,pendingApproval=null,turn=0;
async function guard(action,body){if(!process.env.PI_GUI_TOOL_URL)return;
 const r=await fetch(process.env.PI_GUI_TOOL_URL+'/'+action,{method:'POST',headers:{'content-type':'application/json','x-pi-gui-tool-token':process.env.PI_GUI_TOOL_TOKEN},body:JSON.stringify({sessionId,...body})});
 const result=await r.json();if(!result.ok)throw Error('fixture guard refused');}
const hello=guard('hello',{}).catch(()=>{});
async function run(cmd){const current=++turn;streaming=true;send({type:'agent_start'});send({type:'response',id:cmd.id,command:cmd.type,success:true,data:{disposition:'started'}});
 if(process.env.PI_GUI_CANDIDATE_AUDIT!=='1'){send({type:'response',id:cmd.id,command:cmd.type,success:false});streaming=false;send({type:'agent_settled'});return;}
 send({type:'extension_ui_request',id:'candidate-approval',method:'confirm',title:'允许候选 fixture 写入？',message:'仅修改候选工作区。'});
 const approved=await new Promise(resolve=>{pendingApproval=resolve;});if(!approved||current!==turn)return;
 await hello;
 const relative='src/app.js',content='export const value = 3;\n',callId='fixture-write-'+current;
 send({type:'tool_execution_start',toolCallId:callId,toolName:'write',args:{path:relative}});
 await guard('begin',{callId,toolCallId:callId,readOnly:false,audit:{kind:'write',path:relative,expectedHash:crypto.createHash('sha256').update(content).digest('hex')}});
 fs.writeFileSync(path.join(cwd,relative),content);
 await guard('end',{callId});send({type:'tool_execution_end',toolCallId:callId,toolName:'write',isError:false});
 streaming=false;send({type:'agent_end'});send({type:'agent_settled'});
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 let cmd;try{cmd=JSON.parse(line);}catch{return;}
 if(process.env.CANDIDATE_TRACE)fs.appendFileSync(process.env.CANDIDATE_TRACE,JSON.stringify({type:cmd.type,candidate:process.env.PI_GUI_CANDIDATE_AUDIT==='1'})+'\n');
 if(cmd.type==='prompt'){
  // Z4-3：以真实 RPC 事件形状（agent_start → message_end 终值 → agent_settled）
  // 应答协同文档生成请求；仅 PI_FAKE_COLLAB=1 时启用，不影响其他套件。
  if(process.env.PI_FAKE_COLLAB==='1'&&typeof cmd.message==='string'&&cmd.message.includes('```pi-gui-collab')){
    streaming=true;
    send({type:'response',id:cmd.id,command:'prompt',success:true,data:{disposition:'started'}});
    send({type:'agent_start'});
    send({type:'message_end',message:{role:'assistant',stopReason:'stop',timestamp:1,content:[{type:'text',text:'已分析流程图。'+String.fromCharCode(10)+'```pi-gui-collab'+String.fromCharCode(10)+JSON.stringify({version:1,rationale:'Fixture 建议：修改开始节点文字',ops:[{type:'node.update',params:{id:'n1',label:'Agent 修改的开始'}}]})+String.fromCharCode(10)+'```'+String.fromCharCode(10)+'以上是建议。'}]}});
    streaming=false;send({type:'agent_settled',aborted:false});
    return;
  }
  void run(cmd).catch(()=>{streaming=false;send({type:'response',id:cmd.id,command:cmd.type,success:false});send({type:'agent_settled'});});return;}
 if(cmd.type==='extension_ui_response'){const resolve=pendingApproval;pendingApproval=null;resolve?.(cmd.confirmed===true);}
 if(cmd.type==='abort'){turn++;streaming=false;pendingApproval?.(false);pendingApproval=null;send({type:'agent_settled'});}
 const data=cmd.type==='get_state'?{sessionId,sessionFile,isStreaming:streaming,pendingMessageCount:0,messageCount:0,model:{provider:'fixture',id:'fake'}}:cmd.type==='get_messages'?{messages:[]}:cmd.type==='get_tree'?{tree:[]}:cmd.type==='get_available_models'?{models:[]}:cmd.type==='get_commands'?{commands:[]}:{};
 send({type:'response',id:cmd.id,command:cmd.type,success:true,data});
});
