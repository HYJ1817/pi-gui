// Private parent IPC only; this capability is deliberately absent from HTTP.
export function createAppUpdateMaintenance({busyReason,pause,resume,closeSessions,otherBusy=()=>false,storageBusy=()=>false}) {
  let owner=null,requests=0,epoch=0,preparing=null;
  const blocked=scope=>otherBusy()||(scope==='storage'&&storageBusy());
  function inspect(scope='update') {
    const reason=busyReason();
    return reason||requests||blocked(scope)||owner
      ?{ok:false,code:reason?.code||'busy',error:reason?.error||'仍有任务、审批、开发进程或待处理操作，请先安全停止或等待完成。'}
      :{ok:true};
  }
  return {
    locked:()=>owner!==null,
    owns:scope=>owner===scope,
    inspect,
    track(req,res) {
      if(req.method==='GET'||req.method==='HEAD')return;
      requests++;let done=false;
      const finish=()=>{if(!done){done=true;requests--;}};
      res.once('finish',finish);res.once('close',finish);
    },
    prepare(scope='update') {
      if(owner)return {ok:false,code:'maintenance'};
      const status=inspect(scope);if(!status.ok)return Promise.resolve(status);
      // Acquired synchronously before the first await: all new HTTP work is blocked.
      owner=scope;
      const attempt=++epoch;
      preparing=(async()=>{try {
        await closeSessions();
        if(attempt!==epoch||busyReason()||blocked(scope))throw Error('busy');
        const r=await pause();if(!r?.ok)throw Error('pause_unconfirmed');
        if(attempt!==epoch)throw Error('cancelled');
        return {ok:true};
      } catch {try{await resume();}finally{owner=null;}return {ok:false,code:'cleanup_pending'};}
      finally{preparing=null;}})();
      return preparing;
    },
    async release(scope='update') {
      if(!owner)return {ok:true};
      if(owner!==scope)return {ok:false,code:'maintenance_owner'};
      ++epoch;
      if(preparing)await preparing;
      else {await resume();owner=null;}
      return {ok:true};
    },
  };
}
