const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {
  DEFAULT_UPDATE_PREFERENCE,
  compareVersions,
  createPreferenceStore,
  isNewerVersion,
  isStrictVersion,
  isUpdatePreference,
  resolveAutomaticSupport,
  resolveEffectivePreference,
}=require('../electron/app-update-policy.cjs');

function fileFor(t,name='prefs.json'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-policy-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,file:path.join(dir,name)};
}

test('preferences only accept automatic and manual and default to manual',t=>{
  const {file}=fileFor(t);
  const store=createPreferenceStore({file});
  assert.equal(DEFAULT_UPDATE_PREFERENCE,'manual');
  assert.equal(store.snapshot().preference,'manual');
  assert.equal(isUpdatePreference('automatic'),true);
  assert.equal(isUpdatePreference('manual'),true);
  for(const value of ['disabled','AUTOMATIC','',null,undefined,1,{},[]])assert.equal(isUpdatePreference(value),false);
  assert.deepEqual(store.setPreference('disabled'),{ok:false,code:'invalid_preference'});
  assert.equal(store.snapshot().preference,'manual');
});

test('version comparison is strict, numeric and returns null for malformed input',()=>{
  assert.equal(isStrictVersion('0.34.0'),true);
  assert.equal(isStrictVersion('1.0.0'),true);
  for(const value of ['v0.34.0','0.34','0.34.0-beta','01.2.3.4',' 1.2.3','1.2.3 ','',null,undefined,1])assert.equal(isStrictVersion(value),false);
  assert.equal(compareVersions('0.35.0','0.34.9'),1);
  assert.equal(compareVersions('0.9.9','0.10.0'),-1);
  assert.equal(compareVersions('1.0.0','1.0.0'),0);
  assert.equal(compareVersions('999999999999999999999.0.0','999999999999999999998.9.9'),1);
  assert.equal(compareVersions('1.0.0-beta','1.0.0'),null);
  assert.equal(isNewerVersion('0.35.0','0.34.0'),true);
  assert.equal(isNewerVersion('0.34.0','0.34.0'),false);
  assert.equal(isNewerVersion('0.33.0','0.34.0'),false);
  assert.equal(isNewerVersion('bad','0.34.0'),false);
});

test('automatic support requires Windows packaged NSIS-installed mode',()=>{
  assert.deepEqual(resolveAutomaticSupport({platform:'win32',packaged:true,mode:'installed'}),{supported:true,code:null});
  assert.deepEqual(resolveAutomaticSupport({platform:'win32',packaged:true,mode:'portable'}),{supported:false,code:'portable'});
  assert.deepEqual(resolveAutomaticSupport({platform:'win32',packaged:true,mode:'development'}),{supported:false,code:'portable'});
  assert.deepEqual(resolveAutomaticSupport({platform:'win32',packaged:false,mode:'development'}),{supported:false,code:'development'});
  assert.deepEqual(resolveAutomaticSupport({platform:'darwin',packaged:true,mode:'installed'}),{supported:false,code:'platform'});
  assert.deepEqual(resolveAutomaticSupport({platform:'linux',packaged:true,mode:'portable'}),{supported:false,code:'platform'});
  assert.equal(resolveEffectivePreference('automatic',{supported:false}),'manual');
  assert.equal(resolveEffectivePreference('automatic',{supported:true}),'automatic');
  assert.equal(resolveEffectivePreference('manual',{supported:true}),'manual');
  assert.equal(resolveEffectivePreference('garbage',{supported:true}),'manual');
});

test('preference file is written atomically with the full safe state',t=>{
  const {file}=fileFor(t);
  const store=createPreferenceStore({file});
  const result=store.update({preference:'automatic',ignoredVersion:'0.35.0',pausedVersion:'0.36.0',lastNotifiedVersion:'0.35.0'});
  assert.equal(result.ok,true);
  assert.equal(result.persisted,true);
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.deepEqual(raw,{schemaVersion:1,preference:'automatic',ignoredVersion:'0.35.0',pausedVersion:'0.36.0',lastNotifiedVersion:'0.35.0'});
  const reread=createPreferenceStore({file}).snapshot();
  assert.equal(reread.preference,'automatic');
  assert.equal(reread.ignoredVersion,'0.35.0');
  assert.equal(reread.pausedVersion,'0.36.0');
  assert.equal(reread.lastNotifiedVersion,'0.35.0');
  assert.equal(reread.corrupt,false);
});

test('missing preference file starts manual without writing until a user action',t=>{
  const {file}=fileFor(t);
  const store=createPreferenceStore({file});
  assert.equal(store.snapshot().preference,'manual');
  assert.equal(store.snapshot().loaded,false);
  assert.equal(fs.existsSync(file),false);
  store.setPreference('manual');
  assert.equal(fs.existsSync(file),true);
});

test('corrupt or unknown configuration degrades to manual and is repaired only on save',t=>{
  const {file}=fileFor(t);
  fs.writeFileSync(file,'{not json');
  const store=createPreferenceStore({file});
  assert.equal(store.snapshot().preference,'manual');
  assert.equal(store.snapshot().corrupt,true);
  assert.equal(fs.readFileSync(file,'utf8'),'{not json','startup must not overwrite evidence');
  const bookmark=store.update({lastNotifiedVersion:'0.35.0'},{repair:false});
  assert.equal(bookmark.ok,true);
  assert.equal(bookmark.skipped,true);
  assert.equal(bookmark.state.lastNotifiedVersion,'0.35.0','background bookkeeping may live in memory');
  assert.equal(fs.readFileSync(file,'utf8'),'{not json','a background check must not repair or overwrite a corrupt file');
  store.setPreference('automatic');
  const repaired=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(repaired.preference,'automatic');
  assert.equal(repaired.lastNotifiedVersion,'0.35.0');
  assert.equal(createPreferenceStore({file}).snapshot().corrupt,false);

  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,preference:'disabled',ignoredVersion:'bad',pausedVersion:1,lastNotifiedVersion:'v1.2.3'}));
  const unknown=createPreferenceStore({file}).snapshot();
  assert.equal(unknown.preference,'manual');
  assert.equal(unknown.ignoredVersion,null);
  assert.equal(unknown.pausedVersion,null);
  assert.equal(unknown.lastNotifiedVersion,null);
  assert.equal(unknown.corrupt,true,'malformed ignore/pause fields cannot be trusted as safety state');
  assert.equal(unknown.automaticTrusted,false);
});

test('unsupported schema and oversized or non-regular files are rejected',t=>{
  const {dir,file}=fileFor(t);
  fs.writeFileSync(file,JSON.stringify({schemaVersion:2,preference:'automatic'}));
  assert.equal(createPreferenceStore({file}).snapshot().corrupt,true);
  fs.writeFileSync(file,'x'.repeat(5000));
  assert.equal(createPreferenceStore({file}).snapshot().corrupt,true);
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(createPreferenceStore({file}).snapshot().corrupt,true);
  assert.equal(fs.statSync(file).isDirectory(),true);
  assert.equal(path.dirname(file),dir);
});

test('write failure keeps the in-memory preference and reports persisted false',t=>{
  const {file}=fileFor(t);
  const broken={...fs,
    openSync(file,...args){if(path.basename(file).endsWith('.tmp'))throw Object.assign(Error('disk full'),{code:'ENOSPC'});return fs.openSync(file,...args);},
  };
  const store=createPreferenceStore({file,fsImpl:broken,randomId:()=> 'fixed'});
  const result=store.setPreference('automatic');
  assert.equal(result.ok,true);
  assert.equal(result.persisted,false);
  assert.equal(store.snapshot().preference,'automatic','the current run must honor the user choice');
  assert.equal(store.snapshot().saveFailed,true);
  assert.equal(fs.existsSync(file),false);
});

test('invalid state updates are rejected without partial writes',t=>{
  const {file}=fileFor(t);
  const store=createPreferenceStore({file});
  store.setPreference('manual');
  const before=fs.readFileSync(file,'utf8');
  for(const patch of [null,{},[],{preference:'bad'},{ignoredVersion:'v1.2.3'},{pausedVersion:'1.2'},{lastNotifiedVersion:7},{preference:'automatic',extra:true}]){
    const result=store.update(patch);
    assert.equal(result.ok,false,JSON.stringify(patch));
  }
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.equal(store.snapshot().preference,'manual');
});

test('a later explicit save wins over an older stored snapshot',t=>{
  const {file}=fileFor(t);
  const store=createPreferenceStore({file});
  store.setPreference('automatic');
  const stale=createPreferenceStore({file});
  // There is deliberately no asynchronous loader that could write this stale
  // view back; the current store is the only writer.
  assert.equal(stale.snapshot().preference,'automatic');
  store.setPreference('manual');
  assert.equal(createPreferenceStore({file}).snapshot().preference,'manual');
  assert.equal(store.snapshot().preference,'manual');
});

function preferenceFailFs(isFailing){
  return {...fs,openSync(value,...args){
    const name=path.basename(value);
    if(isFailing()&&name.startsWith('.prefs.json')&&!name.includes('manual-override'))throw Error('disk full');
    return fs.openSync(value,...args);
  }};
}

test('a failed automatic save distinguishes requested from trusted policy',t=>{
  const {file}=fileFor(t);
  const store=createPreferenceStore({file,fsImpl:preferenceFailFs(()=>true),randomId:()=> 'fixed'});
  const result=store.setPreference('automatic');
  assert.equal(result.ok,true);
  assert.equal(result.persisted,false);
  const state=store.snapshot();
  assert.equal(state.requestedPreference,'automatic');
  assert.equal(state.persistedPreference,null);
  assert.equal(state.automaticTrusted,false);
  assert.equal(state.overrideActive,false,'nothing was persisted, so no manual override is needed');
  assert.equal(fs.existsSync(file),false);
});

test('a failed manual switch leaves a cross-process override and a later save clears it',t=>{
  const {file}=fileFor(t);
  let fail=false;
  const store=createPreferenceStore({file,fsImpl:preferenceFailFs(()=>fail),randomId:()=> 'fixed'});
  assert.equal(store.setPreference('automatic').persisted,true,'a valid automatic baseline is persisted first');
  fail=true;
  const manual=store.setPreference('manual');
  assert.equal(manual.ok,true);
  assert.equal(manual.persisted,false);
  assert.equal(store.snapshot().automaticTrusted,false);
  assert.equal(store.snapshot().overrideActive,true);
  assert.equal(store.snapshot().overridePersisted,true);
  assert.equal(fs.existsSync(store.overrideFile),true);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).preference,'automatic','the old file cannot be rewritten');

  const reloaded=createPreferenceStore({file});
  assert.equal(reloaded.snapshot().preference,'manual','the override forces manual after restart');
  assert.equal(reloaded.snapshot().persistedPreference,'automatic');
  assert.equal(reloaded.snapshot().automaticTrusted,false);
  assert.equal(reloaded.snapshot().overrideActive,true);

  fail=false;
  const repaired=reloaded.setPreference('manual');
  assert.equal(repaired.persisted,true);
  assert.equal(reloaded.snapshot().overrideActive,false);
  assert.equal(fs.existsSync(reloaded.overrideFile),false);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).preference,'manual');
});

test('failed ignore or pause writes leave a manual override and revoke trust',t=>{
  for(const kind of ['ignoredVersion','pausedVersion']){
    const {file}=fileFor(t);
    let fail=false;
    const store=createPreferenceStore({file,fsImpl:preferenceFailFs(()=>fail),randomId:()=> 'fixed'});
    store.setPreference('automatic');
    fail=true;
    const result=kind==='ignoredVersion'
      ?store.setIgnoredVersion('0.35.0')
      :store.setPausedVersion('0.35.0');
    assert.equal(result.ok,true,kind);
    assert.equal(result.persisted,false,kind);
    assert.equal(store.snapshot()[kind],'0.35.0',kind);
    assert.equal(store.automaticTrusted(),false,kind);
    assert.equal(store.snapshot().overrideActive,true,kind);
    const reloaded=createPreferenceStore({file}).snapshot();
    assert.equal(reloaded.preference,'manual',kind);
    assert.equal(reloaded.automaticTrusted,false,kind);
  }
});

test('background bookkeeping never persists a requested automatic that failed to save',t=>{
  const {file}=fileFor(t);
  let fail=false;
  const store=createPreferenceStore({file,fsImpl:preferenceFailFs(()=>fail),randomId:()=> 'fixed'});
  store.setPreference('manual');
  fail=true;
  store.setPreference('automatic');
  const bookmark=store.update({lastNotifiedVersion:'0.35.0'},{repair:false});
  assert.equal(bookmark.skipped,true);
  assert.equal(store.snapshot().lastNotifiedVersion,'0.35.0');
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).preference,'manual');
  assert.equal(store.automaticTrusted(),false);
});

test('a corrupt safety field disables trust and the next user action repairs the file',t=>{
  const {file}=fileFor(t);
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,preference:'automatic',ignoredVersion:'not-a-version',pausedVersion:null,lastNotifiedVersion:null}));
  const store=createPreferenceStore({file});
  assert.equal(store.snapshot().corrupt,true);
  assert.equal(store.snapshot().automaticTrusted,false);
  assert.equal(store.snapshot().preference,'manual');
  const bookmark=store.update({lastNotifiedVersion:'0.35.0'},{repair:false});
  assert.equal(bookmark.skipped,true);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).ignoredVersion,'not-a-version');
  store.setPreference('automatic');
  assert.equal(store.snapshot().corrupt,false);
  assert.equal(store.snapshot().automaticTrusted,true);
});

test('an unreadable override marker conservatively forces manual',t=>{
  const {file}=fileFor(t);
  const store=createPreferenceStore({file});
  store.setPreference('automatic');
  fs.mkdirSync(store.overrideFile);
  const reloaded=createPreferenceStore({file});
  assert.equal(reloaded.snapshot().overrideActive,true);
  assert.equal(reloaded.snapshot().preference,'manual');
  assert.equal(reloaded.snapshot().automaticTrusted,false);
  reloaded.setPreference('manual');
  assert.equal(reloaded.snapshot().overrideActive,false,'a successful explicit save replaces the marker');
});
