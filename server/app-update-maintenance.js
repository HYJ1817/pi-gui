// Private parent IPC only; this capability is deliberately absent from HTTP.
export function createAppUpdateMaintenance({busyReason,pause,resume,closeSessions,otherBusy=()=>false}) {
  let locked=false,requests=0;
  return {
    locked:()=>locked,
    track(req,res) {
      if(req.method==='GET'||req.method==='HEAD')return;
      requests++;let done=false;
      const finish=()=>{if(!done){done=true;requests--;}};
      res.once('finish',finish);res.once('close',finish);
    },
    async prepare() {
      if(locked)return {ok:false,code:'maintenance'};
      const reason=busyReason();
      if(reason||requests||otherBusy())return {ok:false,code:reason?.code||'busy'};
      // Acquired synchronously before the first await: all new HTTP work is blocked.
      locked=true;
      try {
        await closeSessions();
        if(busyReason() || otherBusy())throw Error('busy');
        const r=await pause();if(!r?.ok)throw Error('pause_unconfirmed');
        return {ok:true};
      } catch {locked=false;await resume();return {ok:false,code:'cleanup_pending'};}
    },
    async release(){if(locked){await resume();locked=false;}return {ok:true};},
  };
}
