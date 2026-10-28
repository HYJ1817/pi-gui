// Private parent IPC only; this capability is deliberately absent from HTTP.
export function createAppUpdateMaintenance({busyReason,pause,resume,closeSessions,otherBusy=()=>false}) {
  let locked=false,requests=0,epoch=0,preparing=null;
  function inspect() {
    const reason=busyReason();
    return reason||requests||otherBusy()||locked
      ?{ok:false,code:reason?.code||'busy',error:reason?.error||'仍有任务、审批、开发进程或待处理操作，请先安全停止或等待完成。'}
      :{ok:true};
  }
  return {
    locked:()=>locked,
    inspect,
    track(req,res) {
      if(req.method==='GET'||req.method==='HEAD')return;
      requests++;let done=false;
      const finish=()=>{if(!done){done=true;requests--;}};
      res.once('finish',finish);res.once('close',finish);
    },
    prepare() {
      if(locked)return {ok:false,code:'maintenance'};
      const status=inspect();if(!status.ok)return Promise.resolve(status);
      // Acquired synchronously before the first await: all new HTTP work is blocked.
      locked=true;
      const attempt=++epoch;
      preparing=(async()=>{try {
        await closeSessions();
        if(attempt!==epoch||busyReason() || otherBusy())throw Error('busy');
        const r=await pause();if(!r?.ok)throw Error('pause_unconfirmed');
        if(attempt!==epoch)throw Error('cancelled');
        return {ok:true};
      } catch {try{await resume();}finally{locked=false;}return {ok:false,code:'cleanup_pending'};}
      finally{preparing=null;}})();
      return preparing;
    },
    async release(){++epoch;if(preparing)await preparing;else if(locked){await resume();locked=false;}return {ok:true};},
  };
}
