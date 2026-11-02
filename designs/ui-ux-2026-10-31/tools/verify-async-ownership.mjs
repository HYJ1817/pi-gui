// Exercise the actual prototype Component with a deterministic clock, no browser/backend.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const input=process.argv[2]??path.join(root,'canvas/project/Main.dc.html');
const html=await fs.readFile(input,'utf8'),logic=html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
function component(){let now=0,id=0;const queue=[];class DCLogic{constructor(){this.props={}}setState(x){this.state={...this.state,...x}}forceUpdate(){}}
 const C=vm.runInNewContext(logic+';Component',{DCLogic,setTimeout:(fn,ms)=>{queue.push({id:++id,at:now+ms,fn});return id},clearTimeout:k=>{const x=queue.find(x=>x.id===k);if(x)x.cancel=true}});const c=new C();const advance=ms=>{const end=now+ms;while(true){queue.sort((a,b)=>a.at-b.at);const next=queue.find(x=>!x.done&&!x.cancel&&x.at<=end);if(!next)break;now=next.at;next.done=true;next.fn()}now=end};return {c,advance};}
const checks=[];const check=(pass,name,detail)=>checks.push({name,pass:!!pass,detail});
{
 const {c,advance}=component();c.setState({sid:'s4',mode:'error',hasError:true});c.renderVals().retryError();advance(400);c.send();check(c.state.mode==='stopping','stop enters stopping');advance(500);check(c.state.mode==='stopping','old retry cannot release stop barrier',c.state.mode);advance(200);check(c.state.mode==='chat','stop confirmation releases barrier');
}
{
 const {c,advance}=component();c.setState({sid:'s4',mode:'error',hasError:true});c.renderVals().retryError();c.chooseSession('s2');advance(900);check(c.state.sid==='s2'&&c.state.mode==='running','background retry cannot change another session');check(c.views.s4?.mode==='chat','retry writes its own session');
}
{
 const {c,advance}=component();c.chooseSession('s2');c.send();c.chooseSession('s1');advance(700);check(c.state.sid==='s1'&&c.state.mode==='chat','background stop cannot change active session');check(c.views.s2?.mode==='chat','stop completes for its own session');c.chooseSession('s2');check(c.state.mode==='chat','completed stop survives switching');check(!c.renderVals().sessions.find(x=>x.id==='s2').time.includes('运行'),'sidebar follows stopped state');
}
const result={source:input,passed:checks.filter(c=>c.pass).length,failed:checks.filter(c=>!c.pass).length,checks};console.log(JSON.stringify(result,null,2));if(!process.argv[2])await fs.writeFile(path.join(root,'evidence/prototype/async-ownership.json'),JSON.stringify(result,null,2));process.exitCode=result.failed?1:0;
