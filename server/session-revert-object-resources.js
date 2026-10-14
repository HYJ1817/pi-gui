// Reviewed executable resources only. No project path, environment override,
// fallback to another layout, or materialized executable cache is accepted.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readAsset, hasBundledAssets, isSea } from '../lib/assets.js';
const HELPERS=Object.freeze({
 observer:Object.freeze({sourceKey:'server/session-revert-object-native.ps1',assetKey:'revert-object/observe.ps1',helperHash:'230eade3a3611f2340b8ecb3d536b61d2adb88deabc44b44d7c59ec065a2063f'}),
 writer:Object.freeze({sourceKey:'server/session-revert-object-write-native.ps1',assetKey:'revert-object/write.ps1',helperHash:'7d773b63777d97a6a78d9a81c37cf946929062b22028425889258becd3aa39ef'})
});
const fail=code=>{throw Object.assign(Error(code),{code});};
export const OBJECT_HELPER_HASH=HELPERS.observer.helperHash;
export function loadObjectHelper(kind){
 if(!Object.hasOwn(HELPERS,kind))fail('object_helper_unknown');
 const entry=HELPERS[kind],bundled=hasBundledAssets();let bytes;
 try{bytes=Buffer.from(readAsset(bundled?entry.assetKey:entry.sourceKey));}catch{fail('object_helper_unavailable');}
 if(createHash('sha256').update(bytes).digest('hex')!==entry.helperHash)fail('object_helper_integrity_failed');
 // Fresh bytes on every use: no mutable exported Buffer can poison a later call.
 return Object.freeze({kind,helperVersion:1,helperHash:entry.helperHash,source:isSea()?'sea':bundled?'electron':'source',bytes});
}
// Use the same absolute system interpreter for both helpers. The environment's
// SystemRoot remains an OS configuration prerequisite, not a sandbox guarantee.
export async function resolveObjectInterpreter(){
 const systemRoot=process.env.SystemRoot;
 if(typeof systemRoot!=='string'||!path.isAbsolute(systemRoot)||systemRoot.startsWith('\\\\'))fail('native_interpreter_unavailable');
 const interpreter=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 try{
  for(let at=interpreter;;at=path.dirname(at)){
   const st=await fs.lstat(at);
   if(st.isSymbolicLink()||(at===interpreter?!st.isFile():!st.isDirectory()))fail('native_interpreter_unavailable');
   if(path.dirname(at)===at)break;
  }
 }catch{fail('native_interpreter_unavailable');}
 return interpreter;
}
