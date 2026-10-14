import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { objectScopeBinding } from './session-revert-object-profile.js';

const fail = code => { throw Object.assign(Error(code), { code }); };
const ownerEqual = (a,b) => a && b && Object.keys(a).length === 9 && Object.keys(b).length === 9 && Object.keys(a).every(k=>a[k]===b[k]);
const fingerprint = s => createHash('sha256').update(JSON.stringify([s.dev,s.ino,s.birthtimeMs])).digest('hex');
const identity = s => [s.dev,s.ino,s.birthtimeNs].join(':');
const samePath = (a,b) => process.platform === 'win32' ? a.toLowerCase()===b.toLowerCase() : a===b;
async function rootState(root) {
  if(typeof root!=='string'||!path.isAbsolute(root)||root.startsWith('\\\\'))fail('stale_workspace');
  try {
    const link=await fs.lstat(root),real=await fs.realpath(root),big=await fs.stat(root,{bigint:true}),stat=await fs.stat(root);
    if(link.isSymbolicLink()||!link.isDirectory()||!samePath(real,path.resolve(root)))fail('stale_workspace');
    return {root:real,id:identity(big),fingerprint:fingerprint(stat)};
  }catch{fail('stale_workspace');}
}

/** Additional B boundary over the existing P32 authority, never an owner registry. */
export function createSessionRevertObjectRuntimeAuthority({withAuthority,registry,classicCurrent=()=>null}={}) {
  if(typeof withAuthority!=='function'||!registry||typeof registry.contextRevision!=='function')fail('stale_runtime');
  return async(req,body,action)=>{
   const captured=await withAuthority(req,body,async authority=>{
    const scope=authority.scope,binding=objectScopeBinding(scope),owner=scope?.runtimeOwner,context=registry.contextRevision();
    if(!binding||!owner?.sessionId||scope.nativeSessionId!==owner.sessionId)fail('stale_runtime');
    const current=()=>{
      const snapshot=registry.snapshot();
      if(registry.contextRevision()!==context)fail('stale_runtime');
      if(owner.conversationId==='classic-chat'){
        const classic=classicCurrent();
        if(snapshot.focusedConversationId||classic?.ready!==true||!ownerEqual(classic.owner,owner))fail('stale_runtime');
      }else{
        const item=snapshot.items.find(x=>x.conversationId===owner.conversationId);
        if(item?.lifecycle!=='ready'||!ownerEqual(item.owner,owner)||snapshot.focusedConversationId!==owner.conversationId)fail('stale_runtime');
        registry.getAdapter(owner);
      }
    };
    current();const initial=await rootState(authority.root);
    if(scope.workspaceFingerprint!==initial.fingerprint)fail('stale_workspace');
    return {...authority,scope:structuredClone(scope),contextRevision:context,initial,binding,current};
  });
   const revalidate=()=>withAuthority(req,body,async latest=>{
    captured.current();
    if(objectScopeBinding(latest.scope)!==captured.binding||!samePath(latest.root,captured.root))fail('stale_runtime');
    await latest.revalidate();captured.current();const now=await rootState(latest.root);
    if(now.id!==captured.initial.id||now.fingerprint!==captured.initial.fingerprint)fail('stale_workspace');
   });
   // P32's metadata lock is global. Keep it only for each trusted snapshot;
   // workspace admission, runtime resources and Native pins own the attempt.
   const {initial,binding,current,...authority}=captured;
   return action({...authority,revalidate});
  };
}

/** The same Stop/drain composition used by A; no executable B registration. */
export function createSessionRevertStopAndDrain({admission,registry,worktrees,classic}={}) {
  return async root=>{
    const key=admission.keyOf(root),targets=[],classicRoot=classic.root();
    if(classicRoot&&admission.keyOf(classicRoot)===key){
      if(classic.blocked?.())fail('active_writer');
      targets.push({classic:true,manager:classic.manager});
    }
    for(const item of registry.snapshot().items){
      if(!item.owner)continue;
      const workspace=await worktrees.withWorkspace(registry.workspaceIdentityOf(item.conversationId),w=>w);
      if(admission.keyOf(workspace.root)===key)targets.push({owner:item.owner,manager:registry.getAdapter(item.owner).managed.manager});
    }
    for(const target of targets){
      const state=target.manager.snapshot();
      if(state.activeCount||state.cleanupPending||state.processes.some(p=>!p.cleanupConfirmed))fail('active_writer');
    }
    for(const target of targets){
      const command={type:'abort',id:randomUUID()};
      const result=target.classic?await classic.abort(command):await registry.command(target.owner,command);
      if(!result?.ok)fail('active_writer');
    }
  };
}

/** Holds existing session-read/workspace authority around private history reads.
 * The historical scope comes only from the Reader's verified journal prefix.
 * No old owner is installed in Registry, and this yields no mutation authority. */
export function createSessionRevertObjectHistoryAuthority({registry,worktrees,withReadAuthority,classicHistory}={}) {
  return async(req,body,action)=>{
    if(typeof withReadAuthority!=='function'||!body||Object.keys(body).some(k=>k!=='conversationId')||typeof body.conversationId!=='string')fail('recovery_unauthorized');
    return withReadAuthority(req,body,async access=>{
      if(access?.conversationId!==body.conversationId)fail('recovery_unauthorized');
      const classic=body.conversationId==='classic-chat';
      const target=classic?await classicHistory?.(access):registry.historyTarget(body.conversationId);
      if(!target?.sessionId||!target.sessionLocator||!target.sessionIdentity)fail('recovery_unauthorized');
      const workspaceIdentity=classic?target.workspaceIdentity:registry.workspaceIdentityOf(body.conversationId);
      if(!workspaceIdentity&&!(classic&&typeof target.withWorkspace==='function'))fail('recovery_unauthorized');
      const hold=classic&&typeof target.withWorkspace==='function'?target.withWorkspace:fn=>worktrees.withWorkspace(workspaceIdentity,fn);
      return hold(async workspace=>{
        const initial=await rootState(workspace.root);
        const session=async()=>{
          try{
            const st=await fs.lstat(target.sessionLocator);
            if(!st.isFile()||st.isSymbolicLink()||st.dev!==target.sessionIdentity.dev||st.ino!==target.sessionIdentity.ino||st.birthtimeMs!==target.sessionIdentity.birthtimeMs)fail('recovery_unauthorized');
            const handle=await fs.open(target.sessionLocator,'r');try{
              const before=await handle.stat({bigint:true}),named=await fs.lstat(target.sessionLocator,{bigint:true});
              if(identity(before)!==identity(named)||before.nlink!==1n)fail('recovery_unauthorized');
              const bytes=Buffer.alloc(4096),read=await handle.read(bytes,0,bytes.length,0),line=bytes.subarray(0,read.bytesRead).toString('utf8').split('\n')[0],header=JSON.parse(line);
              if(header.type!=='session'||header.id!==target.sessionId)fail('recovery_unauthorized');
              if(identity(await handle.stat({bigint:true}))!==identity(before)||identity(await fs.lstat(target.sessionLocator,{bigint:true}))!==identity(before))fail('recovery_unauthorized');
            }finally{await handle.close();}
          }catch{fail('recovery_unauthorized');}
        };
        const revalidate=async()=>{
          await access.revalidate?.();const now=await rootState(workspace.root);
          if(now.id!==initial.id||now.fingerprint!==initial.fingerprint)fail('recovery_unauthorized');
          if(!classic){const latest=registry.historyTarget(body.conversationId),id=registry.workspaceIdentityOf(body.conversationId);
            if(latest?.sessionId!==target.sessionId||latest.sessionLocator!==target.sessionLocator||id?.id!==workspaceIdentity.id||id.epoch!==workspaceIdentity.epoch)fail('recovery_unauthorized');}
          await session();
        };
        await revalidate();
        const authorizeHistorical=async({scope})=>{
          if(!objectScopeBinding(scope))return false;
          const namespace=classic?workspace.scope:workspace;
          if(!namespace||scope.conversationId!==body.conversationId||scope.nativeSessionId!==target.sessionId||scope.workspaceId!==namespace.workspaceId||!classic&&scope.workspaceEpoch!==namespace.workspaceEpoch||scope.workspaceFingerprint!==initial.fingerprint||scope.runtimeOwner.projectId!==(namespace.projectId??namespace.runtimeOwner?.projectId)||scope.runtimeOwner.repoId!==(namespace.repoId??namespace.runtimeOwner?.repoId))return false;
          await revalidate();return true;
        };
        const result=await action({authorizeHistorical,revalidate,readOnly:true,applyEligible:false});await revalidate();return result;
      });
    });
  };
}
