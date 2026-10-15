// Test composition only. Mirrors the production context.getOwner/isCurrent
// bounded startup readback; it never registers an identity or a writer.
const keys=['backendInstance','projectId','repoId','workspaceId','workspaceEpoch','conversationId','runtimeId','runtimeGeneration','sessionId'];
const workspaceKeys=['projectId','repoId','workspaceId','workspaceEpoch','root','cwd','workspaceFingerprint'];
const fail=code=>{throw Object.assign(Error(code),{code});};
export async function awaitVerifiedNativeOwner({context,requestState,isReady,waitForChange=ms=>new Promise(resolve=>setTimeout(resolve,ms)),maxPolls=25,pollMs=20}={}){
 if(!context||typeof context.isCurrent!=='function'||typeof context.getOwner!=='function'||typeof requestState!=='function'||typeof isReady!=='function'||!Number.isInteger(maxPolls)||maxPolls<0||maxPolls>25||!Number.isInteger(pollMs)||pollMs<0||pollMs>20)fail('stale_runtime');
 const first=context.getOwner(),root=context.cwd,workspace=Object.fromEntries(workspaceKeys.map(k=>[k,context.workspace?.[k]]));
 if(!first||keys.some(k=>!Object.hasOwn(first,k)||k!=='sessionId'&&k!=='repoId'&&(typeof first[k]!=='string'||!first[k])))fail('stale_runtime');
 const identity=Object.fromEntries(keys.map(k=>[k,first[k]]));
 function current(){
  if(!context.isCurrent()||context.cwd!==root||workspaceKeys.some(k=>context.workspace?.[k]!==workspace[k]))fail('stale_runtime');
  const owner=context.getOwner();
  if(!owner||keys.some(k=>!Object.hasOwn(owner,k)||k!=='sessionId'&&owner[k]!==identity[k]))fail('stale_runtime');
  return owner;
 }
 async function state(){try{const value=await requestState();current();if(!value||value.__error||typeof value.sessionId!=='string'||!value.sessionId)fail('stale_runtime');return value;}catch{fail('stale_runtime');}}
 current();const observed=await state();
 for(let poll=0;;poll++){
  const owner=current();
  if(owner.sessionId!==null&&owner.sessionId!==observed.sessionId)fail('stale_runtime');
  if(owner.sessionId===observed.sessionId&&isReady()){
   const confirmed=await state(),latest=current();
   if(!isReady()||confirmed.sessionId!==observed.sessionId||latest.sessionId!==observed.sessionId)fail('stale_runtime');
   return Object.fromEntries(keys.map(k=>[k,latest[k]]));
  }
  if(poll===maxPolls)fail('session_binding_unconfirmed');
  await waitForChange(pollMs);
 }
}
