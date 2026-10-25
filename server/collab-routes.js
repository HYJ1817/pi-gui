import { json, readRawBody } from './http-utils.js';
import { COLLAB_MESSAGES } from './collab-service.js';

/* The router authenticates Origin + Token before reaching this handler.
 * Scope is resolved only after the bounded body has arrived; no stale lease
 * can survive a slow upload, and no payload may select a physical path. */
export function createCollabRoutes({ service, withAuthority, beforeAuthority = null } = {}) {
  return {async handle(req,res,url) {
    try {
      if(req.method!=='POST') return json(res,405,{ok:false,code:'collab_invalid',error:COLLAB_MESSAGES.collab_invalid});
      if(url.search) throw Object.assign(Error(),{code:'collab_invalid'});
      let bytes;
      try {bytes=await readRawBody(req,64*1024);} catch {return json(res,413,{ok:false,code:'collab_invalid',error:COLLAB_MESSAGES.collab_invalid});}
      const text=bytes.toString('utf8');
      if(!Buffer.from(text).equals(bytes)) throw Object.assign(Error(),{code:'collab_invalid'});
      let request;
      try {request=JSON.parse(text);} catch {throw Object.assign(Error(),{code:'collab_invalid'});}
      // Z4-3：generate 的通道就绪检查必须在 collab authority 之前完成——
      // assertReady 内部的 withActivation 与 authority 持有的 withWorkspace
      // 是同一把工作区生命周期锁，嵌套调用会自锁。
      if (beforeAuthority) await beforeAuthority(request);
      const result=await withAuthority(req,scope=>service.execute(scope,request));
      if(result.ok) return json(res,200,result);
      const code=Object.hasOwn(COLLAB_MESSAGES,result.code)?result.code:'collab_invalid';
      return json(res,code==='collab_invalid'?400:409,{ok:false,code,error:COLLAB_MESSAGES[code],...(result.conflict?{conflict:result.conflict}:{})});
    } catch(e) {
      const code=Object.hasOwn(COLLAB_MESSAGES,e?.code)?e.code:'collab_storage_unavailable';
      return json(res,code==='collab_invalid'?400:['collab_storage_unavailable','collab_storage_write_failed'].includes(code)?503:409,
        {ok:false,code,error:COLLAB_MESSAGES[code]});
    }
  }};
}
