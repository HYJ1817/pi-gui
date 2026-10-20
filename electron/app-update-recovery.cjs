'use strict';
const fs=require('node:fs'),path=require('node:path');

// Recovery only reads fixed local diagnostics. It never starts an executable.
function readUpdateRecovery(directory,version,mode) {
  function regular(file) {
    const st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>8192)throw Error('invalid_diagnostic');
    return st;
  }
  function folder(dir) {
    const st=fs.lstatSync(dir);
    if(!st.isDirectory()||st.isSymbolicLink())throw Error('invalid_diagnostic');
  }
  const pendingFile=path.join(directory,'pending.json');
  try {
    folder(directory);regular(pendingFile);
    const raw=fs.readFileSync(pendingFile,'utf8'),pending=JSON.parse(raw);
    if(!/^install-[A-Za-z0-9]+$/.test(pending.run)||!/^\d+\.\d+\.\d+$/.test(pending.expectedVersion))return null;
    const run=path.join(directory,pending.run);folder(run);
    // The helper holds FileShare.None from preparation through installer exit.
    // Failure to prove the lock is free must never enable a second update.
    const lock=path.join(directory,'install.lock');let fd;
    try {regular(lock);fd=fs.openSync(lock,'r+');}
    catch(e) {if(e.code!=='ENOENT')return {phase:'waiting',mode};}
    finally {if(fd!==undefined)fs.closeSync(fd);}
    let result=null;
    try {const file=path.join(run,'result.json');regular(file);result=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{}
    const completed=result?.phase==='installed'&&pending.expectedVersion===version;
    const completion=completed?{phase:'completed',mode,version}
      :{phase:'failed',mode,error:'上次更新未完成。当前程序与用户数据已保留，可重试或打开 Release 页面手动安装。'};
    // Consume only the marker we read, never a replacement from a newer attempt.
    regular(pendingFile);
    if(fs.readFileSync(pendingFile,'utf8')===raw)fs.unlinkSync(pendingFile);
    return completion;
  } catch {return null;}
}
module.exports={readUpdateRecovery};
