import { json, readRawBody } from './http-utils.js';
import { createSessionRevertObjectService } from './session-revert-object-service.js';
// Future route shape, intentionally absent from server.js. Construction never
// accepts a service/provider/capability supplied by the caller.
export function createSessionRevertObjectRoutes(){
 const service=createSessionRevertObjectService();
 const methods=new Map([['prepare','prepareObjectRevert'],['apply','applyObjectRevert'],['cancel','cancelObjectRevert'],['recovery','inspectObjectRecovery'],['prepare-recovery','prepareObjectRecovery'],['export','exportVerifiedRecoveryMaterial']]);
 return async(req,res,pathname)=>{
  const prefix='/api/session-revert-object/';if(!pathname.startsWith(prefix))return false;
  const method=methods.get(pathname.slice(prefix.length));if(!method){json(res,404,{ok:false,error:'invalid_request'});return true;}
  if(req.method!=='POST'){json(res,405,{ok:false,error:'invalid_request'});return true;}
  try{await readRawBody(req,16384);await service[method]();}catch{json(res,403,{ok:false,error:'production_allowlist_empty'});}return true;
 };
}
