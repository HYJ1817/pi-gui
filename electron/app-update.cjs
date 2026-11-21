'use strict';
// Main-process authority. No URL, local path or argv is accepted from the page.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const REPO = 'https://github.com/HYJ1817/pi-gui/releases/download/';
const VERSION = /^\d+\.\d+\.\d+$/;
const fail = code => Object.assign(new Error(code), {code});
const TEXT = {
  unsupported:'此运行形态只支持检查更新或手动安装。', invalid_asset:'官方 Release 的版本、安装包名称或大小不匹配，请使用 Release 页面。',
  untrusted:'已拒绝不可信的更新请求。', checksum:'安装包 SHA256 校验失败，请重新下载。', network:'下载失败，请检查网络后重试，或打开 Release 页面手动安装。',
  busy:'仍有任务、审批或后台操作未结束，请等待完成，或先在对应会话安全停止任务。',
  cache:'更新缓存不可用，请重新下载。', install:'无法准备安装，应用和用户数据已保留，请重试或手动安装。',
  revoked:'更新资格已改变，未启动安装；已校验的包保留，可稍后重试。',
  ignored:'此版本已被忽略，未开始下载。', paused:'此版本已暂停自动下载，请手动重新下载。',
  superseded:'发现了更高版本，已停止旧版本的下载。', stale:'更新事务已变化，请重新检查。',
  cancelled:'下载已取消，可重新下载。',
};
function allowedDownload(value, redirect=false) {
  try {
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return false;
    if(redirect && ['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))return true;
    return value.startsWith(REPO)&&u.hostname==='github.com'&&!u.search&&/^\/HYJ1817\/pi-gui\/releases\/download\/v\d+\.\d+\.\d+\/[A-Za-z0-9._-]+$/.test(u.pathname);
  } catch { return false; }
}
function selectAsset(info, portable=false) {
  const v=info?.latestVersion;
  if(!info?.ok||!info.updateAvailable||!VERSION.test(v)||info.release?.tag!==`v${v}`)throw fail('invalid_asset');
  const name=portable?`Pi-GUI-${v}-portable.zip`:`Pi-GUI-Setup-${v}.exe`;
  const assets=info.release.assets.filter(a=>a.name===name);
  if(assets.length!==1)throw fail('invalid_asset');
  const a=assets[0];
  if(a.url!==`${REPO}v${v}/${name}`||!allowedDownload(a.url)||!Number.isSafeInteger(a.size)||a.size<1||a.size>1024*1024*1024)throw fail('invalid_asset');
  return {name,url:a.url,size:a.size,version:v,digest:/^sha256:[a-f0-9]{64}$/.test(a.digest)?a.digest.slice(7):null};
}
function readInstall({run=execFileSync}={}) {
  try {
    // reg.exe uses the active Windows code page when stdout is redirected.
    // Read Unicode directly and choose the pipe encoding explicitly.
    const script="[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Pi GUI'); if ($key) { try { [Console]::WriteLine($key.GetValue('InstallLocation', '')) } finally { $key.Dispose() } }";
    const s=run(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
      ['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:5000,stdio:['ignore','pipe','ignore']});
    return s.trim()||null;
  } catch { return null; }
}
function detectMode({packaged,exe,readInstall:read=readInstall}) {
  if(!packaged)return 'development';
  try {
    const install=read();
    if(install&&fs.realpathSync(path.join(install,'Pi GUI.exe')).toLowerCase()===fs.realpathSync(exe).toLowerCase()
      &&fs.statSync(path.join(install,'Uninstall Pi GUI.exe')).isFile())return 'installed';
  } catch { /* Unknown packaging always degrades to portable. */ }
  return 'portable';
}
async function disposeResponse(response) {
  try {
    if (typeof response?.dispose === 'function') await response.dispose();
    else if (typeof response?.body?.cancel === 'function') await response.body.cancel();
    else response?.body?.destroy?.();
  } catch { /* Cleanup must not mask the original validation or network failure. */ }
}
function createAppUpdate({directory,version,mode,readUpdate,fetchImpl=globalThis.fetch,prepare,release=async()=>{},launch,quit}) {
  let state={phase:'idle',mode,currentVersion:version,received:0,total:0,speed:0,transactionId:null}, job=null,ctl=null,installing=false,asset=null;
  const listeners=new Set();
  fs.mkdirSync(directory,{recursive:true});
  const root=fs.realpathSync(directory), identity=fs.statSync(root);
  function guard() {
    const st=fs.lstatSync(directory);
    if(st.isSymbolicLink()||fs.realpathSync(directory)!==root||st.ino!==identity.ino||st.dev!==identity.dev)throw fail('cache');
  }
  function file(name) {
    guard();if(!/^[A-Za-z0-9._-]+$/.test(name))throw fail('cache');
    const p=path.join(root,name);
    if(fs.existsSync(p)){const st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||fs.realpathSync(p)!==p)throw fail('cache');}
    return p;
  }
  const view=()=>({...state});
  function set(next){state={...state,...next};for(const cb of listeners)cb(view());}
  function error(e,fallback='network'){const code=e?.code||fallback;return {ok:false,code,error:TEXT[code]||TEXT.install};}
  async function response(url,signal) {
    for(let i=0;i<5;i++) {
      if(!allowedDownload(url,i>0))throw fail('untrusted');
      const r=await fetchImpl(url,{signal,redirect:'manual',headers:{'User-Agent':`pi-gui/${version}`,'Accept':'application/octet-stream'}});
      let admitted=false;
      try {
        if([301,302,303,307,308].includes(r.status)){url=new URL(r.headers.get('location'),url).href;continue;}
        if(!r.ok||!r.body)throw fail('network');
        admitted=true;return r;
      } finally {if(!admitted)await disposeResponse(r);}
    }
    throw fail('untrusted');
  }
  async function verify(a) {
    const p=file(a.name),st=fs.statSync(p);
    if(st.size!==a.size||!/^[a-f0-9]{64}$/.test(a.sha256))throw fail('checksum');
    const h=createHash('sha256');for await(const chunk of fs.createReadStream(p))h.update(chunk);
    file(a.name);if(h.digest('hex')!==a.sha256)throw fail('checksum');return p;
  }
  async function trustedDigest(info,a,signal) {
    if(a.digest)return a.digest;
    const sums=info.release.assets.filter(x=>x.name==='SHA256SUMS.txt');
    if(sums.length!==1||sums[0].url!==`${REPO}v${a.version}/SHA256SUMS.txt`)throw fail('invalid_asset');
    const r=await response(sums[0].url,signal);let text='';
    try {
      for await(const c of r.body){text+=Buffer.from(c).toString('utf8');if(text.length>16384)throw fail('invalid_asset');}
    } finally {await disposeResponse(r);}
    const matches=text.split(/\r?\n/).map(s=>/^([a-fA-F0-9]{64}) [ *](.+)$/.exec(s)).filter(m=>m?.[2]===a.name);
    if(matches.length!==1)throw fail('checksum');return matches[0][1].toLowerCase();
  }
  async function restore() {
    if(mode==='development')return view();
    try {
      const p=file('ready.json');if(fs.statSync(p).size>4096)throw fail('cache');
      const a=JSON.parse(fs.readFileSync(p,'utf8'));
      if(!VERSION.test(a.version))return view();
      const target=a.version.split('.').map(Number),current=version.split('.').map(Number);
      const different=target.findIndex((n,i)=>n!==current[i]);
      if(different<0||target[different]<current[different])return view();
      const expected=selectAsset({ok:true,updateAvailable:true,latestVersion:a.version,release:{tag:`v${a.version}`,assets:[{...a,url:`${REPO}v${a.version}/${a.name}`}] }},mode==='portable');
      if(expected.name!==a.name)throw fail('cache');
      await verify(a);if(state.phase!=='idle')return view();
      asset=a;set({phase:'ready',version:a.version,total:a.size,received:a.size,speed:0});
    } catch { /* Missing or invalid cache is never admitted for execution. */ }
    return view();
  }
  function download(request={}) {
    if(
      request.confirm!==true||
      Object.keys(request).some(k=>!['confirm','transactionId','expectedVersion','approve'].includes(k))||
      (request.transactionId!==undefined&&!Number.isSafeInteger(request.transactionId))||
      (request.expectedVersion!==undefined&&request.expectedVersion!==null&&!VERSION.test(request.expectedVersion))||
      (request.approve!==undefined&&typeof request.approve!=='function')
    )return Promise.resolve(error(fail('untrusted')));
    if(mode==='development')return Promise.resolve(error(fail('unsupported')));
    if(job||installing)return Promise.resolve({ok:false,code:'busy',error:TEXT.busy});
    const transactionId=Number.isSafeInteger(request.transactionId)?request.transactionId:null;
    const expectedVersion=VERSION.test(request.expectedVersion)?request.expectedVersion:null;
    const approve=typeof request.approve==='function'?request.approve:null;
    ctl=new AbortController();const signal=ctl.signal;
    // Never keep the previous task's version visible in a new transaction:
    // until the official metadata resolves, the target is explicitly unknown.
    set({phase:'downloading',version:null,received:0,total:0,speed:0,error:'',transactionId});
    job=(async()=>{
      let part=null,timer=setTimeout(()=>ctl?.abort(),30*60*1000);
      try {
        const info=await readUpdate({force:true});
        // 元数据读取期间可能已经被取消/替换。迟到的响应不能继续启动下载。
        if(signal.aborted)throw fail('cancelled');
        const a=selectAsset(info,mode==='portable');
        // Semantic comparison is owned by the existing checker; it must use this app version.
        if(info.currentVersion&&info.currentVersion!==version)throw fail('invalid_asset');
        set({version:a.version,total:a.size});
        let approval=null;
        if(approve){
          let verdict;
          try{verdict=approve({version:a.version,transactionId,expectedVersion});}
          catch{verdict={ok:false,code:'revoked'};}
          if(!verdict||verdict.ok!==true)throw fail(verdict?.code||'revoked');
          approval=verdict;
        }
        // The official Release is the download authority. A stale expected
        // version may only proceed when the approval is explicitly bound to
        // the actual target (the manager converges the discovery version).
        if(expectedVersion&&a.version!==expectedVersion&&approval?.version!==a.version)throw fail('superseded');
        if(signal.aborted)throw fail('cancelled');
        const digest=await trustedDigest(info,a,signal);
        a.sha256=digest;
        if(signal.aborted)throw fail('cancelled');
        part=file(a.name+'.part');fs.rmSync(part,{force:true});
        const out=fs.openSync(part,'wx');const h=createHash('sha256'),start=Date.now();let received=0;
        let r;
        try {
          r=await response(a.url,signal);
          const len=r.headers.get('content-length');if(len!==null&&Number(len)!==a.size)throw fail('checksum');
          for await(const c of r.body){
            if(signal.aborted)throw fail('cancelled');const b=Buffer.from(c);received+=b.length;
            if(received>a.size)throw fail('checksum');fs.writeFileSync(out,b);h.update(b);
            set({received,speed:Math.round(received*1000/Math.max(1,Date.now()-start))});
          }
        } finally {await disposeResponse(r);fs.closeSync(out);}
        set({phase:'verifying',speed:0});
        if(signal.aborted)throw fail('cancelled');
        if(received!==a.size||h.digest('hex')!==digest)throw fail('checksum');
        guard();fs.renameSync(file(a.name+'.part'),file(a.name));part=null;
        const manifest=file('ready.json.tmp');fs.writeFileSync(manifest,JSON.stringify(a),{flag:'w'});fs.renameSync(manifest,file('ready.json'));
        asset=a;set({phase:'ready'});return {ok:true};
      } catch(e) {
        const r=signal.aborted?{ok:false,code:'cancelled',error:TEXT.cancelled}:error(e);
        const soft=['cancelled','superseded','ignored','paused','stale','revoked'].includes(r.code);
        set({phase:soft?'cancelled':'failed',error:r.error,speed:0});
        return r;
      } finally {
        clearTimeout(timer);if(part)try{fs.rmSync(part,{force:true});}catch{}
        job=null;ctl=null;
        if(state.transactionId===transactionId)set({transactionId:null});
      }
    })();return job;
  }
  async function install(request={}, options={}) {
    if(request.confirm!==true||Object.keys(request).some(k=>k!=='confirm'))return error(fail('untrusted'));
    if(mode!=='installed')return error(fail('unsupported'));
    if(installing||job||state.phase!=='ready'||!asset)return error(fail('busy'));
    const authorize=typeof options?.authorize==='function'?options.authorize:null;
    const stillAuthorized=()=>{
      if(!authorize)return true;
      try{return authorize()===true;}catch{return false;}
    };
    if(!stillAuthorized())return error(fail('revoked'));
    installing=true;let preparing=false,committed=false;
    set({phase:'preparing',error:''});
    try {
      const p=await verify(asset);
      // 预检与下载校验之间用户可能改回手动、忽略或取消。每个异步步骤后
      // 都重新确认资格。真正的最终检查在 quit() 写入 armed 之前同步执行。
      if(!stillAuthorized())throw fail('revoked');
      const info=await readUpdate({force:true});const fresh=selectAsset(info);
      if(fresh.version!==asset.version||fresh.size!==asset.size)throw fail('invalid_asset');
      if(await trustedDigest(info,fresh,AbortSignal.timeout(15000))!==asset.sha256)throw fail('checksum');
      if(!stillAuthorized())throw fail('revoked');
      preparing=true;
      const r=await prepare();if(!r?.ok)throw Object.assign(fail(r?.code||'busy'),{publicError:r?.error||TEXT.busy});
      if(!stillAuthorized())throw fail('revoked');
      await verify(asset);
      // 安装助手可能已经启动并在等待 ready；这里失败会走 release() 的
      // cancelled 标记，让尚未 armed 的助手安全退出并释放 OS 锁。
      if(!stillAuthorized())throw fail('revoked');
      await launch({...asset,path:p});
      // 助手完成准备后必须再次确认；随后 quit() 在 armed 写入前同步复核。
      if(!stillAuthorized())throw fail('revoked');
      try {
        await quit({authorize:stillAuthorized});
        committed=true;
      } catch(e) {
        // quit() 在 armed 之后失败时，事务已经进入不可撤销阶段：
        // 不能再写 cancelled、删除 armed 或强行终止安装。
        if(e&&e.committed===true)committed=true;
        throw e;
      }
      set({phase:'installing'});return {ok:true};
    } catch(e){
      const r=error(e,'install');if(e?.publicError)r.error=e.publicError;
      if(committed){
        // 已 armed：保持 installing，禁止再次下载/安装，也禁止撤销准备。
        set({phase:'installing',error:r.error});
        return {...r,committed:true};
      }
      const damaged=['checksum','cache','invalid_asset','ENOENT','EACCES','EPERM'].includes(r.code);
      set({phase:damaged?'failed':'ready',error:r.error});return r;
    }
    finally {
      if(!committed){
        try{if(preparing)await release();}finally{installing=false;}
      }
      // committed 事务保持 installing=true，直到应用退出。
    }
  }
  return {state:view,download,restore,install,cancel(){ctl?.abort();return {ok:true};},onChange(cb){listeners.add(cb);return()=>listeners.delete(cb);}};
}
module.exports={createAppUpdate,selectAsset,detectMode,allowedDownload,readInstall};
