import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { launchOwnedProcess, processAssets } from './process-runner.js';

const LIMIT = 1024 * 1024;
const INPUT_LIMIT = 96 * 1024 * 1024;
const INPUT_CHUNK = 64 * 1024;
const equal = (a,b) => typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const safeError = code => Object.assign(Error(code), {code});

/** Private duplex RPC transport, owned by a Job/process-group guardian, never a PID. */
export function createPiSupervisor({ launch = launchOwnedProcess, assets = processAssets(), node = process.execPath, connectTimeoutMs = 15000, inputLimit = INPUT_LIMIT } = {}) {
  if(!Number.isSafeInteger(inputLimit)||inputLimit<1||inputLimit>INPUT_LIMIT)throw safeError('pi_input_limit');
  const records = new Set(), byChild = new WeakMap();
  let server=null, listening=null, disposed=false, disposal=null;
  function ensureServer() {
    if(listening)return listening;
    server=net.createServer(socket=>{
      let record=null,buffer='',decoder=new StringDecoder('utf8');
      const timer=setTimeout(()=>socket.destroy(),5000);
      const reject=()=>{socket.destroy();if(record)void stop(record).catch(()=>{});};
      socket.on('error',()=>{});
      socket.on('data',chunk=>{
        buffer+=decoder.write(chunk);if(buffer.length>LIMIT)return reject();
        let end;
        while((end=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let frame;
          try{frame=JSON.parse(line);}catch{return reject();}
          if(!record){
            record=[...records].find(r=>!r.socket&&!r.stopping&&equal(frame.token,r.token)&&frame.type==='hello');
            if(!record)return reject();clearTimeout(timer);record.socket=socket;
            send(record,{type:'spec',command:record.command,args:record.args,cwd:record.opts.cwd,env:record.opts.env});
          }else if(frame.type==='spawn'){
            if(record.spawned)return reject();record.spawned=true;clearTimeout(record.timer);record.resolveReady();record.child.emit('spawn');
          }else if(frame.type==='stdout'||frame.type==='stderr'){
            if(!record.spawned||typeof frame.data!=='string'||frame.data.length>128*1024)return reject();
            if(record.child[frame.type].writableLength>LIMIT)return reject();
            const decoded=record.decoders[frame.type].write(Buffer.from(frame.data,'base64'));
            if(decoded)record.child[frame.type].write(decoded);
          }else if(frame.type==='exit'){
            if(!record.spawned||!Number.isInteger(frame.code))return reject();record.code=frame.code;void stop(record).catch(()=>{});
          }else if(frame.type==='failure'){
            record.child.emit('error',safeError('pi_spawn_failed'));void stop(record).catch(()=>{});
          }else return reject();
        }
      });
      socket.on('close',()=>{clearTimeout(timer);if(record&&!record.closed)void stop(record).catch(()=>{});});
    });
    server.maxConnections=16;
    listening=new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    return listening;
  }
  function send(r,frame){
    if(!r.socket||r.socket.destroyed||r.socket.writableLength>LIMIT){void stop(r).catch(()=>{});return;}
    const text=JSON.stringify(frame)+'\n';
    if(Buffer.byteLength(text)>LIMIT){void stop(r).catch(()=>{});return;}
    r.socket.write(text);
  }
  function writeFrame(r,frame){
    return new Promise((resolve,reject)=>{
      const socket=r.socket,text=JSON.stringify(frame)+'\n';
      if(r.closed||r.stopping||!socket||socket.destroyed)return reject(safeError('pi_channel_closed'));
      if(Buffer.byteLength(text)>LIMIT||socket.writableLength>LIMIT)return reject(safeError('pi_input_limit'));
      const failed=()=>{clean();reject(safeError('pi_channel_closed'));};
      const clean=()=>{socket.removeListener('error',failed);socket.removeListener('close',failed);};
      socket.once('error',failed);socket.once('close',failed);
      socket.write(text,error=>{clean();error?reject(safeError('pi_channel_closed')):resolve();});
    });
  }
  function finish(r,code=0){
    if(r.closed)return;r.closed=true;clearTimeout(r.timer);r.rejectReady(safeError('pi_channel_closed'));r.socket?.destroy();records.delete(r);
    for(const stream of ['stdout','stderr']){const tail=r.decoders[stream].end();if(tail)r.child[stream].write(tail);r.child[stream].end();}
    r.child.exitCode=r.code??code;r.child.emit('exit',r.child.exitCode,null);r.child.emit('close',r.child.exitCode,null);r.resolveClose();
  }
  async function stop(r){
    if(r.closed)return;r.stopping=true;clearTimeout(r.timer);
    if(r.stopPromise)return r.stopPromise;
    r.stopPromise=(async()=>{
      if(!r.guardian){await r.launching?.catch(()=>{});if(r.closed)return;if(!r.guardian){finish(r);return;}}
      await r.guardian.stop();await r.completion;
    })();
    try{await r.stopPromise;}catch{r.stopPromise=null;r.child.emit('error',safeError('stop_unconfirmed'));throw safeError('stop_unconfirmed');}
  }
  function spawnProcess(command,args,opts={}){
    args=Array.isArray(args)?[...args]:args;
    opts={...opts,env:{...(opts.env||process.env)}};
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.signalCode=null;
    let resolveClose,resolveReady,rejectReady;const completion=new Promise(r=>{resolveClose=r;});
    const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
    const r={child,command,args,opts,token:randomUUID(),socket:null,guardian:null,stopping:false,closed:false,spawned:false,code:null,lineBytes:0,completion,resolveClose,ready,resolveReady,rejectReady,decoders:{stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')}};
    byChild.set(child,r);records.add(r);
    child.stdin=new Writable({write(chunk,_encoding,callback){
      if(r.closed||r.stopping)return callback(safeError('pi_channel_closed'));
      // Await admission, then flush one bounded frame at a time. The original
      // caller buffer is the only queued payload; base64 never duplicates a line.
      void (async()=>{
        await r.ready;
        for(let offset=0;offset<chunk.length;offset+=INPUT_CHUNK){
          await writeFrame(r,{type:'stdin',data:chunk.subarray(offset,offset+INPUT_CHUNK).toString('base64')});
        }
      })().then(()=>callback(),callback);
    },final(callback){void stop(r).then(()=>callback(),callback);}});
    const nativeWrite=child.stdin.write.bind(child.stdin);
    child.stdin.write=(chunk,encoding,callback)=>{
      if(typeof encoding==='function'){callback=encoding;encoding=undefined;}
      const data=typeof chunk==='string'?Buffer.from(chunk,encoding):chunk;
      let bytes=r.lineBytes,start=0,end;
      if(!Buffer.isBuffer(data))return nativeWrite(chunk,encoding,callback);
      while((end=data.indexOf(10,start))>=0){bytes+=end-start;if(bytes>inputLimit)break;bytes=0;start=end+1;}
      if(bytes<=inputLimit)bytes+=data.length-start;
      if(bytes>inputLimit||data.length+child.stdin.writableLength>inputLimit+1){
        const error=safeError('pi_input_limit');if(callback)queueMicrotask(()=>callback(error));child.stdin.destroy(error);return false;
      }
      r.lineBytes=bytes;return nativeWrite(data,callback);
    };
    child.stdin.on('error',error=>{child.emit('error',safeError(error.code==='pi_input_limit'?'pi_input_limit':'pi_channel_closed'));void stop(r).catch(()=>{});});
    child.kill=()=>{void stop(r).catch(()=>{});return true;};
    r.launching=(async()=>{
      if(disposed)throw safeError('supervisor_closed');
      if(typeof command!=='string'||!Array.isArray(args)||!args.every(v=>typeof v==='string')||opts.shell===true||typeof opts.cwd!=='string')throw safeError('pi_launch_invalid');
      await ensureServer();if(disposed||r.stopping){finish(r);return;}
      const env={ELECTRON_RUN_AS_NODE:'1',PI_GUI_SUPERVISOR_PORT:String(server.address().port),PI_GUI_SUPERVISOR_TOKEN:r.token};
      r.guardian=launch({command:node,args:[path.join(assets,'runtime-child.cjs')],cwd:opts.cwd,env},{identity:randomUUID()});
      r.guardian.on('close',code=>finish(r,code||0));
      r.guardian.on('failure',()=>{child.emit('error',safeError('pi_guardian_failed'));void stop(r).catch(()=>{});});
      // Guardian diagnostics are deliberately not projected into Pi stdout or UI.
      r.timer=setTimeout(()=>{child.emit('error',safeError('pi_connect_timeout'));void stop(r).catch(()=>{});},connectTimeoutMs);
    })().catch(error=>{child.emit('error',safeError(['supervisor_closed','pi_launch_invalid'].includes(error.code)?error.code:'pi_spawn_failed'));finish(r,1);});
    return child;
  }
  return {spawnProcess,
    async killProcessTree(child){const r=byChild.get(child);if(!r)throw safeError('foreign_process');await stop(r);},
    dispose(){if(disposal)return disposal;disposed=true;disposal=(async()=>{await Promise.all([...records].map(stop));await listening?.catch(()=>{});if(server?.listening)await new Promise(resolve=>server.close(resolve));})();return disposal;},
  };
}
