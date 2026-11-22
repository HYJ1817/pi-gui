import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { REMOTE_V1, acceptEventFrame, authorizePairExchange, authorizeRemoteOperation, buildEventFrameMessage, buildPairProofMessage, buildSignatureMessage, commitAdmission, filterGrantedResources, requiredEventScope, settleApproval, validateApprovalPayload, validateEventEnvelope, validatePairExchange, validatePairExchangeResponse, validateRawTarget, validateRemoteRequest, validateRemoteResponse, verifyPairExchangeProof, verifyPairExchangeResponse, verifyRemoteSignature, wireErrorCode } from '../server/remote/protocol.mjs';

const id='4b1f3561-33e1-4aa1-8a54-8dc176cd5367';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function testKeyPair() {
  const pair=generateKeyPairSync('ed25519');
  const spki=pair.publicKey.export({type:'spki',format:'der'});
  const raw=spki.subarray(spki.length-32);
  return {...pair,publicKeyRaw:raw.toString('base64url')};
}
function canonicalJson(value) {
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const DEVICE_EPOCH='1';
function headersFor(rawBody,requestId=id) {
  return {
    'x-pi-remote-device':'device_abc12345',
    'x-pi-remote-epoch':DEVICE_EPOCH,
    'x-pi-remote-request-id':requestId,
    'x-pi-remote-timestamp':'1795273200000',
    'x-pi-remote-nonce':Buffer.alloc(32,8).toString('base64url'),
    'x-pi-remote-signature':Buffer.alloc(64,9).toString('base64url'),
    'x-pi-remote-body-sha256':hash(rawBody),
    'accept':'application/json',
  };
}
const SERVICE_FP=hash('synthetic desktop certificate');
const SERVICE_ID='svc-'+SERVICE_FP.slice(0,16);
function signedRequest(unsigned,keyPair,nonce=Buffer.alloc(32,7).toString('base64url'),timestamp=Date.now().toString(),deviceId='device_abc12345',serviceId=SERVICE_ID) {
  const requestId=unsigned.body?.requestId ?? id;
  const bodyBytes=Buffer.from(unsigned.rawBody ?? '', 'utf8');
  const bodySha256=hash(bodyBytes);
  const message=buildSignatureMessage({protocolVersion:1,deviceId,serviceId,replayEpoch:DEVICE_EPOCH,requestId,method:unsigned.method,path:unsigned.path,query:unsigned.query??{},timestamp,nonce,bodySha256});
  const signature=sign(null,Buffer.from(message,'utf8'),keyPair.privateKey).toString('base64url');
  const headers={
    'x-pi-remote-device':deviceId,
    'x-pi-remote-epoch':DEVICE_EPOCH,
    'x-pi-remote-request-id':requestId,
    'x-pi-remote-timestamp':timestamp,
    'x-pi-remote-nonce':nonce,
    'x-pi-remote-body-sha256':bodySha256,
    'x-pi-remote-signature':signature,
    'accept':'application/json',
    'content-type':'application/json; charset=utf-8',
  };
  return {...unsigned,headers,remoteDeviceId:deviceId,devicePublicKey:keyPair.publicKeyRaw};
}
function request(operation,path,payload={},extra={}) {
  const method=extra.method??REMOTE_V1.operations.find(x=>x.id===operation).method;
  const body=method==='GET'?undefined:{protocolVersion:1,operation,payload,...(extra.ownerRevision===undefined?{}:{ownerRevision:extra.ownerRevision})};
  const rawBody=body===undefined?'':canonicalJson(body);
  return {method,path,headers:{...headersFor(rawBody),'accept':'application/json',...(method==='GET'?{}:{'content-type':'application/json; charset=utf-8'})},rawBody,...(body===undefined?{}:{body}),...(extra.query===undefined?{}:{query:extra.query})};
}
function replaceBody(base,body) {
  const rawBody=canonicalJson(body);
  return {...base,headers:{...base.headers,'x-pi-remote-body-sha256':hash(rawBody)},rawBody,body};
}

test('remote v1 contract is frozen v1, HTTPS-only and disabled by default',()=>{
  assert.equal(REMOTE_V1.contractVersion,1);
  assert.equal(REMOTE_V1.status,'frozen-v1');
  assert.equal(REMOTE_V1.transport.scheme,'https');
  assert.equal(REMOTE_V1.transport.defaultEnabled,false);
  assert.equal(REMOTE_V1.transport.existingLocalApiForwarding,false);
  assert.deepEqual(REMOTE_V1.transport.pairing.defaultScopes,['projects.read','sessions.read']);
  assert.equal(REMOTE_V1.scopeVocabulary.includes('approvals.read'),true);
  assert.equal(REMOTE_V1.operations.find(x=>x.id==='approvals.list').scope,'approvals.read');
  assert.equal(REMOTE_V1.transport.pairing.singleUse,true);
  assert.equal(REMOTE_V1.transport.pairing.attemptWindowSeconds,600);
  assert.equal(REMOTE_V1.signedRequest.algorithm,'Ed25519');
  assert.match(REMOTE_V1.signedRequest.validationNote,/Gateway must independently enforce TLS/);
});

test('operation ids, scopes and methods are unique and closed',()=>{
  const ids=REMOTE_V1.operations.map(x=>x.id);
  assert.equal(new Set(ids).size,ids.length);
  assert.equal(new Set(REMOTE_V1.scopeVocabulary).size,REMOTE_V1.scopeVocabulary.length);
  for (const op of REMOTE_V1.operations) {
    assert.ok(['GET','POST'].includes(op.method));
    assert.ok(REMOTE_V1.scopeVocabulary.includes(op.scope));
    assert.ok(op.path.startsWith('/remote/v1/'));
    assert.equal(op.path.includes('*'),false);
    assert.ok(op.result && op.result.type==='object' && op.result.additionalProperties===false);
  }
  assert.deepEqual(REMOTE_V1.forbiddenCapabilities,['generic-rpc','shell','terminal','filesystem','arbitrary-path','provider-credentials','raw-desktop-token','arbitrary-url-proxy','public-relay']);
});

test('pair exchange accepts only a short-lived-code payload shape',()=>{
  const validBody={pairingSessionId:Buffer.alloc(16,3).toString('base64url'),pairCode:'042817',deviceName:'Test iPhone',devicePublicKey:'P'.repeat(43),clientNonce:'N'.repeat(43),serviceFingerprint:'a'.repeat(64),proofSignature:'p'.repeat(86),requestedScopes:['projects.read','sessions.read']};
  const valid={method:'POST',path:'/remote/v1/pair/exchange',headers:{'content-type':'application/json; charset=utf-8','accept':'application/json'},rawBody:canonicalJson(validBody),body:validBody};
  assert.deepEqual(validatePairExchange(valid),{ok:true,code:'pair_shape_valid'});
  for (const patch of [
    {pairCode:'42817'},
    {pairCode:'042817',unexpected:'field'},
    {pairCode:'042817',deviceName:'',devicePublicKey:'P'.repeat(43),clientNonce:'N'.repeat(43),serviceFingerprint:'a'.repeat(64),proofSignature:'p'.repeat(86)},
    {pairCode:'042817',deviceName:'Phone',devicePublicKey:'P'.repeat(43),clientNonce:'N'.repeat(43),serviceFingerprint:'a'.repeat(64),proofSignature:'p'.repeat(86),token:'secret'},
    {pairCode:'042817',deviceName:'Phone',devicePublicKey:'P'.repeat(48),clientNonce:'N'.repeat(43),serviceFingerprint:'a'.repeat(64),proofSignature:'p'.repeat(86)},
  ]) { const body={...valid.body,...patch}; assert.equal(validatePairExchange({...valid,body,rawBody:canonicalJson(body)}).ok,false); }
  assert.equal(validatePairExchange({...valid,path:'/api/command'}).ok,false);

  const pairResponse={deviceId:'device_12345678',serverNonce:Buffer.alloc(32,4).toString('base64url'),grantedScopes:['projects.read','sessions.read'],replayEpoch:1,expiresAt:'2026-11-21T15:00:00Z',serverSignature:Buffer.alloc(64,5).toString('base64url')};
  assert.equal(validatePairExchangeResponse(pairResponse),true);
  assert.equal(validatePairExchangeResponse({...pairResponse,grantedScopes:['projects.read','projects.read']}),false);
  assert.equal(validatePairExchangeResponse({...pairResponse,accessToken:'secret'}),false);
});

test('project and session reads accept only opaque ids and empty payloads',()=>{
  assert.equal(validateRemoteRequest(request('projects.list','/remote/v1/projects')).ok,true);
  const sessions=request('sessions.list','/remote/v1/projects/project_12345678/sessions');
  assert.equal(validateRemoteRequest(sessions).ok,true);
  assert.equal(validateRemoteRequest({...sessions,path:'/remote/v1/projects/../sessions'}).ok,false);
  assert.equal(validateRemoteRequest({...sessions,path:'/remote/v1/projects/%2fetc/sessions'}).ok,false);
});

test('runtime creation requires a revision and does not allow classic cwd/path fields',()=>{
  const base=request('runtime.create','/remote/v1/projects/project_12345678/conversations',{clientConversationId:id},{ownerRevision:2});
  assert.equal(validateRemoteRequest(base).ok,true);
  assert.equal(validateRemoteRequest(request('runtime.create','/remote/v1/projects/project_12345678/conversations',{clientConversationId:id})).code,'owner_revision_required');
  assert.equal(validateRemoteRequest(replaceBody(base,{...base.body,payload:{clientConversationId:id,cwd:'C:/secret'}})).ok,false);
});

test('chat send is bounded, revision-bound and not a command proxy',()=>{
  const base=request('chat.send','/remote/v1/conversations/conversation_12345678/messages',{clientMessageId:id,text:'hello'},{ownerRevision:3});
  assert.equal(validateRemoteRequest(base).ok,true);
  assert.equal(validateRemoteRequest(replaceBody(base,{...base.body,payload:{...base.body.payload,text:'x'.repeat(100001)}})).ok,false);
  assert.equal(validateRemoteRequest(replaceBody(base,{...base.body,payload:{...base.body.payload,command:'rm -rf'}})).ok,false);
  assert.equal(validateRemoteRequest(replaceBody(base,{...base.body,payload:{...base.body.payload,access_token:'marker'}})).ok,false);
  assert.equal(validateRemoteRequest({...base,headers:{...base.headers,'x-pi-gui-token':'marker'}}).code,'signature_headers_invalid');
  assert.equal(validateRemoteRequest(replaceBody(base,{...base.body,operation:'rpc.call'})).code,'envelope_invalid');
});

test('exact signed body bytes and parsed request body must agree',()=>{
  const base=request('chat.send','/remote/v1/conversations/conversation_12345678/messages',{clientMessageId:id,text:'hello'},{ownerRevision:3});
  assert.equal(validateRemoteRequest({...base,rawBody:base.rawBody+' '}).code,'body_parse_mismatch');
  assert.equal(validateRemoteRequest({...base,headers:{...base.headers,'x-pi-remote-body-sha256':'0'.repeat(64)}}).code,'signature_headers_invalid');
  assert.equal(validateRemoteRequest({...base,body:{...base.body,payload:{clientMessageId:id,text:'different'}}}).code,'body_parse_mismatch');
});

test('stop uses a typed operation and requires current owner revision',()=>{
  const base=request('chat.stop','/remote/v1/conversations/conversation_12345678/stop',{}, {ownerRevision:4});
  assert.equal(validateRemoteRequest(base).ok,true);
  assert.equal(validateRemoteRequest(request('chat.stop','/remote/v1/conversations/conversation_12345678/stop')).code,'owner_revision_required');
});

test('approval response is bound to a real opaque request id and closed method/decision',()=>{
  const base=request('approvals.respond',`/remote/v1/conversations/conversation_12345678/approvals/${id}/respond`,{method:'confirm',decision:'deny'},{ownerRevision:5});
  assert.equal(validateRemoteRequest(base).ok,true);
  assert.equal(validateRemoteRequest(replaceBody(base,{...base.body,payload:{method:'confirm',decision:'allow',always:true}})).ok,false);
  assert.equal(validateRemoteRequest(replaceBody(base,{...base.body,payload:{method:'unknown',decision:'allow'}})).ok,false);
});

test('signature canonicalization binds device, service, request identity, path/query, timestamp, nonce and body digest',()=>{
  const fields={protocolVersion:1,deviceId:'device_abc12345',serviceId:SERVICE_ID,replayEpoch:'1',requestId:id,method:'get',path:'/remote/v1/events',query:{z:'last value',cursor:'a/b'},timestamp:'1795273200000',nonce:'n'.repeat(43),bodySha256:hash('')};
  const expected=['1','device_abc12345',SERVICE_ID,'1',id,'GET','/remote/v1/events?cursor=a%2Fb&z=last%20value','1795273200000','n'.repeat(43),hash('')].join('\n');
  assert.equal(buildSignatureMessage(fields),expected);
  assert.equal(buildSignatureMessage({...fields,query:{cursor:'a/b',z:'last value'}}),expected);
  assert.equal(buildSignatureMessage({...fields,query:{cursor:1}}),null);
  assert.equal(buildSignatureMessage({...fields,deviceId:'bad'}),null);
});
test('Ed25519 request signature, device+service binding, skew and atomic replay gate are exercised with synthetic keys',()=>{
  const pair=testKeyPair();
  const unsigned=request('chat.send','/remote/v1/conversations/conversation_12345678/messages',{clientMessageId:id,text:'synthetic only'},{ownerRevision:7});
  const timestamp=Date.now().toString();
  const nonce=Buffer.alloc(32,9).toString('base64url');
  const valid=signedRequest(unsigned,pair,nonce,timestamp);
  let consumed=0;
  const consumeNonce=(device,seenNonce,at)=>{assert.equal(device,'device_abc12345');assert.equal(seenNonce,nonce);assert.equal(at,Number(timestamp));consumed++;return consumed===1;};
  const device={deviceId:'device_abc12345',devicePublicKey:pair.publicKeyRaw,grantedScopes:['chat.send'],active:true,replayEpoch:1,expiresAt:new Date(Number(timestamp)+3600000).toISOString()};
  const verification={request:valid,device,serviceId:SERVICE_ID,serviceFingerprint:SERVICE_FP,nowMs:Number(timestamp),consumeNonce};
  const first=verifyRemoteSignature(verification);
  assert.equal(first.ok,true); assert.equal(first.operation,'chat.send'); assert.equal(first.scope,'chat.send'); assert.equal(first.deviceId,'device_abc12345'); assert.equal(consumed,1);
  // replay
  assert.equal(verifyRemoteSignature(verification).code,'request_replayed');
  // stale skew
  assert.equal(verifyRemoteSignature({...verification,nowMs:Number(timestamp)+61000,consumeNonce:()=>true}).code,'signature_expired');
  // missing/throwing store fails closed, not exception
  assert.equal(verifyRemoteSignature({...verification,consumeNonce:undefined}).code,'replay_store_unavailable');
  // expired device record is inactive before signature work
  const expired={...device,expiresAt:new Date(Number(timestamp)-1000).toISOString()};
  assert.equal(verifyRemoteSignature({...verification,request:valid,device:expired,consumeNonce:()=>true}).code,'device_inactive');
  // epoch mismatch: record at epoch 2, header still 1 -> signature_invalid
  const epochBump={...device,replayEpoch:2};
  assert.equal(verifyRemoteSignature({...verification,request:valid,device:epochBump,consumeNonce:()=>true}).code,'signature_invalid');
  assert.equal(verifyRemoteSignature({...verification,consumeNonce:()=>{throw Error('disk')}}).code,'replay_store_unavailable');
  assert.equal(verifyRemoteSignature({...verification,consumeNonce:()=>Promise.resolve(true)}).code,'replay_store_unavailable');
  // wrong device key, wrong service, wrong identity
  const wrongKey=testKeyPair();
  const badSigned=signedRequest(unsigned,wrongKey,Buffer.alloc(32,11).toString('base64url'),timestamp);
  assert.equal(verifyRemoteSignature({request:badSigned,device:{...device},serviceFingerprint:SERVICE_FP,nowMs:Number(timestamp),consumeNonce:()=>true}).code,'signature_invalid');
  const otherService=signedRequest(unsigned,pair,Buffer.alloc(32,12).toString('base64url'),timestamp,device.deviceId,'other_service');
  assert.equal(verifyRemoteSignature({request:otherService,device,serviceFingerprint:SERVICE_FP,nowMs:Number(timestamp),consumeNonce:()=>true}).code,'signature_invalid');
  const otherDevice=signedRequest(unsigned,pair,Buffer.alloc(32,13).toString('base64url'),timestamp,'device_zzzz9999');
  assert.equal(verifyRemoteSignature({request:otherDevice,device,serviceFingerprint:SERVICE_FP,nowMs:Number(timestamp),consumeNonce:()=>true}).code,'device_identity_mismatch');
  // inactive device, invalid grant vocabulary, wrong scope
  assert.equal(verifyRemoteSignature({...verification,device:{...device,active:false}}).code,'device_inactive');
  assert.equal(verifyRemoteSignature({...verification,device:{...device,grantedScopes:['chat.send','admin.root']}}).code,'device_grants_invalid');
  assert.equal(verifyRemoteSignature({...verification,device:{...device,grantedScopes:['projects.read']}}).code,'scope_denied');
  // non-finite now fails closed
  assert.equal(verifyRemoteSignature({...verification,nowMs:NaN}).code,'signature_expired');
});

test('pair proof binds code, displayed name, device key, nonce and service fingerprint',()=>{
  const pair=testKeyPair(),fingerprint=hash('synthetic desktop certificate');
  const body={pairingSessionId:Buffer.alloc(16,3).toString('base64url'),pairCode:'042817',deviceName:'Synthetic iPhone',devicePublicKey:pair.publicKeyRaw,clientNonce:Buffer.alloc(32,5).toString('base64url'),serviceFingerprint:fingerprint,requestedScopes:['projects.read','sessions.read']};
  const proof=sign(null,Buffer.from(buildPairProofMessage(body),'utf8'),pair.privateKey).toString('base64url');
  const request={method:'POST',path:REMOTE_V1.pairExchange.path,headers:{'content-type':'application/json; charset=utf-8','accept':'application/json'},body:{...body,proofSignature:proof},rawBody:canonicalJson({...body,proofSignature:proof})};
  assert.equal(verifyPairExchangeProof(request,fingerprint).ok,true);
  assert.equal(verifyPairExchangeProof(request,hash('different desktop')).code,'service_fingerprint_mismatch');
  const tampered={...request,body:{...request.body,deviceName:'Other device'}};
  tampered.rawBody=canonicalJson(tampered.body);
  assert.equal(verifyPairExchangeProof(tampered,fingerprint).code,'pair_proof_invalid');
  const desktop=testKeyPair();
  const privateDer=desktop.privateKey.export({type:'pkcs8',format:'der'});
  const privateRaw=privateDer.subarray(privateDer.length-32).toString('base64url');
  let registered=0,confirmed=null,attempts=0;
  const scopes=['projects.read','sessions.read'];
  const expiresAt=new Date(Date.now()+120000).toISOString();
  const approvalFor=()=>({peerId:'peer-1',reservePairBudget:()=>true,validatePairingSession:()=>true,recordPairAttempt:context=>{attempts++;assert.equal(context.peerId,'peer-1');assert.equal(context.pairingSessionId,body.pairingSessionId);return attempts<=5;},verifyPairCode:ctx=>{assert.equal(ctx.pairingSessionId,body.pairingSessionId);return ctx.pairCode==='042817';},confirmLocally:context=>{confirmed=context;return 'approval_01';},consumePairingCodeAndRegisterDevice:record=>{registered++;assert.equal(record.pairCode,'042817');assert.equal(record.approvalId,'approval_01');assert.deepEqual(record.grantedScopes,scopes);assert.equal(record.replayEpoch,undefined);return {replayEpoch:1};}});
  const approved=authorizePairExchange({request,expectedServiceFingerprint:fingerprint,...approvalFor(),grantedScopes:scopes,deviceId:'device_12345678',serverNonce:Buffer.alloc(32,4).toString('base64url'),expiresAt,desktopPrivateKey:privateRaw});
  assert.equal(approved.ok,true); assert.equal(registered,1); assert.equal(attempts,1); assert.deepEqual(confirmed.requestedScopes,scopes);
  assert.equal(confirmed.pairCode,'042817'); assert.equal(confirmed.clientNonce,body.clientNonce); assert.equal(typeof confirmed.proofTranscript,'string');
  // response needs a live outstanding exchange; retired atomically; single-use
  const outstanding={clientNonce:body.clientNonce,requestedScopes:scopes,expiresAtMs:Date.now()+60000,serviceFingerprint:fingerprint,desktopPublicKey:desktop.publicKeyRaw,devicePublicKey:body.devicePublicKey};
  let retired=0;
  assert.equal(verifyPairExchangeResponse(approved.response,desktop.publicKeyRaw,approved.requestId,{outstandingExchange:outstanding,retireExchange:()=>{retired++;return true;},serviceFingerprint:fingerprint}),true);
  assert.equal(retired,1);
  // second presentation without outstanding state, wrong nonce, scope mismatch, wrong key
  assert.equal(verifyPairExchangeResponse(approved.response,desktop.publicKeyRaw,approved.requestId,{}),false);
  assert.equal(verifyPairExchangeResponse(approved.response,desktop.publicKeyRaw,approved.requestId,{outstandingExchange:{clientNonce:'x'.repeat(43),requestedScopes:scopes,expiresAtMs:Date.now()+60000,serviceFingerprint:fingerprint},retireExchange:()=>true}),false);
  assert.equal(verifyPairExchangeResponse(approved.response,desktop.publicKeyRaw,approved.requestId,{outstandingExchange:{clientNonce:body.clientNonce,requestedScopes:['chat.send'],expiresAtMs:Date.now()+60000,serviceFingerprint:fingerprint},retireExchange:()=>true}),false);
  assert.equal(verifyPairExchangeResponse(approved.response,testKeyPair().publicKeyRaw,approved.requestId,{outstandingExchange:outstanding,retireExchange:()=>true,serviceFingerprint:fingerprint}),false);
  // wrong-service / expired exchange / duplicate scope set rejected
  assert.equal(verifyPairExchangeResponse(approved.response,desktop.publicKeyRaw,approved.requestId,{outstandingExchange:outstanding,retireExchange:()=>true,serviceFingerprint:hash('other service')}),false);
  assert.equal(verifyPairExchangeResponse(approved.response,desktop.publicKeyRaw,approved.requestId,{outstandingExchange:{...outstanding,expiresAtMs:Date.now()-1},retireExchange:()=>true,serviceFingerprint:fingerprint}),false);
  assert.equal(verifyPairExchangeResponse(approved.response,desktop.publicKeyRaw,approved.requestId,{outstandingExchange:{...outstanding,requestedScopes:[...scopes,'sessions.read']},retireExchange:()=>true,serviceFingerprint:fingerprint}),false);
  // budget reserved BEFORE session; session lookup not reached on exhaustion
  let sessionLookedUp=false;
  assert.equal(authorizePairExchange({request,expectedServiceFingerprint:fingerprint,peerId:'peer-1',reservePairBudget:()=>false,validatePairingSession:()=>{sessionLookedUp=true;return true;},recordPairAttempt:()=>true,verifyPairCode:()=>true,confirmLocally:()=>'a',consumePairingCodeAndRegisterDevice:()=>true,grantedScopes:scopes,deviceId:'d_12345678',serverNonce:Buffer.alloc(32,4).toString('base64url'),expiresAt,desktopPrivateKey:privateRaw}).code,'pair_rate_limited');
  assert.equal(sessionLookedUp,false);
  // wrong code with a VALID proof: attempt charged, proof passes, code fails -> pairing_rejected
  let prompted2=false;
  const badBody={...request.body,pairCode:'999999'};
  badBody.proofSignature=sign(null,Buffer.from(buildPairProofMessage(badBody),'utf8'),pair.privateKey).toString('base64url');
  const badCode={...request,body:badBody};
  badCode.rawBody=canonicalJson(badCode.body);
  assert.equal(authorizePairExchange({request:badCode,expectedServiceFingerprint:fingerprint,peerId:'peer-1',reservePairBudget:()=>true,validatePairingSession:()=>true,recordPairAttempt:()=>true,verifyPairCode:()=>false,confirmLocally:()=>{prompted2=true;return 'a';},consumePairingCodeAndRegisterDevice:()=>true,grantedScopes:scopes,deviceId:'device_12345678',serverNonce:Buffer.alloc(32,4).toString('base64url'),expiresAt,desktopPrivateKey:privateRaw}).code,'pairing_rejected');
  // a wrong code with an INVALID proof is rejected as pair_proof_invalid (no correct/wrong-code oracle)
  const badProof={...request,body:{...request.body,pairCode:'999999'}};
  badProof.rawBody=canonicalJson(badProof.body);
  assert.equal(authorizePairExchange({request:badProof,expectedServiceFingerprint:fingerprint,peerId:'peer-1',reservePairBudget:()=>true,validatePairingSession:()=>true,recordPairAttempt:()=>true,verifyPairCode:()=>false,confirmLocally:()=>'a',consumePairingCodeAndRegisterDevice:()=>true,grantedScopes:scopes,deviceId:'device_12345678',serverNonce:Buffer.alloc(32,4).toString('base64url'),expiresAt,desktopPrivateKey:privateRaw}).code,'pair_proof_invalid');
  assert.equal(prompted2,false);
  // live session must exist BEFORE confirmation
  let prompted=false;
  assert.equal(authorizePairExchange({request,expectedServiceFingerprint:fingerprint,peerId:'peer-1',reservePairBudget:()=>true,validatePairingSession:()=>false,recordPairAttempt:()=>true,verifyPairCode:()=>true,confirmLocally:()=>{prompted=true;return 'a';},consumePairingCodeAndRegisterDevice:()=>true,grantedScopes:scopes,deviceId:'device_12345678',serverNonce:Buffer.alloc(32,4).toString('base64url'),expiresAt,desktopPrivateKey:privateRaw}).code,'pairing_session_invalid');
  assert.equal(prompted,false);
  // confirmation must return an approvalId bound to the transcript; bare true rejected
  assert.equal(authorizePairExchange({request,expectedServiceFingerprint:fingerprint,peerId:'peer-1',reservePairBudget:()=>true,validatePairingSession:()=>true,recordPairAttempt:()=>true,verifyPairCode:()=>true,confirmLocally:()=>true,consumePairingCodeAndRegisterDevice:()=>true,grantedScopes:scopes,deviceId:'device_12345678',serverNonce:Buffer.alloc(32,4).toString('base64url'),expiresAt,desktopPrivateKey:privateRaw}).code,'desktop_confirmation_required');
  // past expiresAt rejected before signing/registering
  assert.equal(authorizePairExchange({request,expectedServiceFingerprint:fingerprint,peerId:'peer-1',reservePairBudget:()=>true,validatePairingSession:()=>true,recordPairAttempt:()=>true,verifyPairCode:()=>true,confirmLocally:()=>'a',consumePairingCodeAndRegisterDevice:()=>{throw Error('must not register')},grantedScopes:scopes,deviceId:'device_12345678',serverNonce:Buffer.alloc(32,4).toString('base64url'),expiresAt:'2020-01-01T00:00:00Z',desktopPrivateKey:privateRaw}).code,'pair_response_invalid');
});
test('signed operation requests require all device-authentication header shapes',()=>{
  const base=request('projects.list','/remote/v1/projects');
  for (const name of REMOTE_V1.signedRequestHeaders) {
    const h={...base.headers}; delete h[name];
    assert.equal(validateRemoteRequest({...base,headers:h}).code,'signature_headers_missing');
  }
  assert.equal(validateRemoteRequest({...base,headers:{...base.headers,'x-pi-gui-token':'not-forwarded'}}).code,'signature_headers_invalid');
  assert.equal(validateRemoteRequest({...base,headers:{...base.headers,'x-pi-remote-body-sha256':'bad'}}).code,'signature_headers_invalid');
  // Signature shape and digest are checked here; actual key verification is tested below.
});



test('event stream accepts only a pattern-bound cursor and signed device headers',()=>{
  const base={method:'GET',path:'/remote/v1/events',headers:{...headersFor(''),'accept':'text/event-stream'},rawBody:'',query:{cursor:'opaque-cursor-01'}};
  assert.equal(validateRemoteRequest(base).ok,true);
  assert.equal(validateRemoteRequest(base).cursor,'opaque-cursor-01');
  assert.equal(validateRemoteRequest({...base,query:{cursor:'x'.repeat(129)}}).code,'cursor_invalid');
  assert.equal(validateRemoteRequest({...base,query:{cursor:''}}).code,'cursor_invalid');
  assert.equal(validateRemoteRequest({...base,query:{cursor:'bad/cursor'}}).code,'cursor_invalid');
  assert.equal(validateRemoteRequest({...base,query:{cursor:'c',projectPath:'C:/private'}}).code,'query_invalid');
  assert.equal(REMOTE_V1.eventStream.perDeviceBacklog,true);
  assert.equal(REMOTE_V1.eventStream.mustRevalidateAuthorizationBeforeReplay,true);
  assert.equal(REMOTE_V1.eventStream.frameAuthentication.signed,true);
});

test('event frames carry generation/cursor/signature, per-event scopes and closed payloads',()=>{
  const desktop=testKeyPair();
  const base={protocolVersion:1,sequence:1,conversationId:'conversation_12345678',ownerRevision:2,streamGeneration:1,cursor:'cur_abc123',event:'message.append',payload:{messageId:'message_12345678',role:'assistant',text:'hello'}};
  base.frameSignature=sign(null,Buffer.from(buildEventFrameMessage(base,'device_abc12345',SERVICE_ID),'utf8'),desktop.privateKey).toString('base64url');
  assert.equal(validateEventEnvelope(base),true);
  const ctx={event:base,deviceId:'device_abc12345',serviceId:SERVICE_ID,desktopPublicKey:desktop.publicKeyRaw,deviceScopes:['sessions.read'],expectedStreamGeneration:1,expectedSequence:1,authorizeResource:ctx0=>ctx0.conversationId===base.conversationId&&ctx0.ownerRevision===base.ownerRevision};
  assert.equal(acceptEventFrame(ctx).ok,true);
  // approval events require approvals.read even when conversation is owned
  assert.equal(requiredEventScope('approval.pending'),'approvals.read');
  const approval={...base,event:'approval.pending',payload:{requestId:'req_12345678',method:'confirm',title:'t',message:'m'}};
  approval.frameSignature=sign(null,Buffer.from(buildEventFrameMessage(approval,'device_abc12345',SERVICE_ID),'utf8'),desktop.privateKey).toString('base64url');
  assert.equal(acceptEventFrame({...ctx,event:approval,deviceScopes:['sessions.read','approvals.read']}).ok,true);
  assert.equal(acceptEventFrame({...ctx,event:approval,deviceScopes:['sessions.read']}).code,'scope_denied');
  // wrong key/device/service/generation/sequence/ungranted resource rejected
  assert.equal(acceptEventFrame({...ctx,desktopPublicKey:testKeyPair().publicKeyRaw}).code,'frame_signature_invalid');
  assert.equal(acceptEventFrame({...ctx,deviceId:'device_other001'}).code,'frame_signature_invalid');
  assert.equal(acceptEventFrame({...ctx,serviceId:'other_service'}).code,'frame_signature_invalid');
  assert.equal(acceptEventFrame({...ctx,expectedStreamGeneration:2}).code,'sequence_gap');
  assert.equal(acceptEventFrame({...ctx,expectedSequence:2}).code,'sequence_gap');
  assert.equal(acceptEventFrame({...ctx,authorizeResource:()=>false}).code,'unknown_resource');
  // missing frame fields, unknown event, forbidden key, payload ownerRevision conflict
  const noSig={...base};delete noSig.frameSignature;
  assert.equal(validateEventEnvelope(noSig),false);
  assert.equal(validateEventEnvelope({...base,event:'arbitrary.tool'}),false);
  const leak={...base,payload:{messageId:'m_12345678',role:'assistant',text:'x',sessionPath:'C:/secret'}};
  assert.equal(validateEventEnvelope(leak),false);
  const conflict={...base,payload:{messageId:'m_12345678',role:'assistant',text:'x',ownerRevision:9}};
  assert.equal(validateEventEnvelope(conflict),false);
  // stream-wide reset uses the reserved reset conversation id and a closed reason
  const reset={...base,event:'reset',conversationId:'stream-reset',payload:{reason:'authorization_changed'}};
  reset.frameSignature=sign(null,Buffer.from(buildEventFrameMessage(reset,'device_abc12345',SERVICE_ID),'utf8'),desktop.privateKey).toString('base64url');
  assert.equal(validateEventEnvelope(reset),true);
  assert.equal(validateEventEnvelope({...reset,conversationId:'conversation_12345678'}),false);
  assert.equal(validateEventEnvelope({...reset,payload:{reason:'unexpected'}}),false);
  // reset establishes the new expected position; not subject to prior sequence
  assert.equal(acceptEventFrame({event:reset,deviceId:'device_abc12345',serviceId:SERVICE_ID,desktopPublicKey:desktop.publicKeyRaw,deviceScopes:['sessions.read']}).lastAcceptedPosition.streamGeneration,1);
  // 'stream-reset' reserved in ordinary frames (signature verified over its own conversationId first)
  const badReset={...base,conversationId:'stream-reset'};
  badReset.frameSignature=sign(null,Buffer.from(buildEventFrameMessage(badReset,'device_abc12345',SERVICE_ID),'utf8'),desktop.privateKey).toString('base64url');
  assert.equal(acceptEventFrame({event:badReset,deviceId:'device_abc12345',serviceId:SERVICE_ID,desktopPublicKey:desktop.publicKeyRaw,deviceScopes:['sessions.read'],expectedStreamGeneration:1,expectedSequence:1}).code,'frame_invalid');
  // owner-filtered replay: a frame for an ungranted conversation fails authorizeResource
  assert.equal(acceptEventFrame({...ctx,authorizeResource:ctx0=>ctx0.conversationId!=='conversation_12345678'}).code,'unknown_resource');
  // authorizeResource is mandatory for ordinary frames; omitted -> context error
  const noAuth={...ctx};delete noAuth.authorizeResource;
  assert.equal(acceptEventFrame(noAuth).code,'frame_context_required');
  // stale reset (equal or lower generation) rejected; fresh subscribe allowed
  const staleReset={...reset,streamGeneration:1};
  staleReset.frameSignature=sign(null,Buffer.from(buildEventFrameMessage(staleReset,'device_abc12345',SERVICE_ID),'utf8'),desktop.privateKey).toString('base64url');
  assert.equal(acceptEventFrame({event:staleReset,deviceId:'device_abc12345',serviceId:SERVICE_ID,desktopPublicKey:desktop.publicKeyRaw,deviceScopes:['sessions.read'],expectedStreamGeneration:2,expectedSequence:1}).code,'sequence_gap');
  const nextReset={...reset,streamGeneration:3};
  nextReset.frameSignature=sign(null,Buffer.from(buildEventFrameMessage(nextReset,'device_abc12345',SERVICE_ID),'utf8'),desktop.privateKey).toString('base64url');
  assert.equal(acceptEventFrame({event:nextReset,deviceId:'device_abc12345',serviceId:SERVICE_ID,desktopPublicKey:desktop.publicKeyRaw,deviceScopes:['sessions.read'],expectedStreamGeneration:2,expectedSequence:1}).ok,true);
});

test('request envelope rejects unknown version, fields and duplicate transport paths',()=>{
  const base=request('chat.send','/remote/v1/conversations/conversation_12345678/messages',{clientMessageId:id,text:'hello'},{ownerRevision:1});
  assert.equal(validateRemoteRequest(replaceBody(base,{...base.body,protocolVersion:2})).code,'envelope_invalid');
  assert.equal(validateRemoteRequest(replaceBody(base,{...base.body,extra:true})).code,'envelope_invalid');
  assert.equal(validateRemoteRequest({...base,method:'PUT'}).code,'operation_route_mismatch');
  assert.equal(validateRemoteRequest({...base,path:'/api/command'}).code,'operation_route_mismatch');
});

test('responses use operation-specific closed projections and never carry raw errors/secrets/paths',()=>{
  const projectResult={projects:[{projectId:'project_12345678',displayName:'Demo'}],registryRevision:3};
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:id,operation:'projects.list',serverRevision:7,result:projectResult},'projects.list',id),true);
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:id,operation:'projects.list',serverRevision:7,result:{projects:[{projectId:'project_12345678',displayName:'Demo',path:'C:/secret'}],registryRevision:3}},'projects.list',id),false);
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:id,operation:'projects.list',serverRevision:7,result:{projects:[{projectId:'project_12345678',displayName:'C:/absolute'}],registryRevision:3}},'projects.list',id),false);
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:id,operation:'projects.list',serverRevision:7,result:{projects:[{projectId:'project_12345678',displayName:'Demo'}],registryRevision:3,accessToken:'secret'}},'projects.list',id),false);
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:id,operation:'chat.send',serverRevision:7,result:{accepted:true,ownerRevision:7,clientMessageId:id}},'projects.list',id),false);
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:id,error:{code:'stale_owner',retryable:true}},null,id),true);
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:id,error:{code:'failed',retryable:false,message:'raw detail'}},null,id),false);
  assert.equal(validateRemoteResponse({protocolVersion:2,requestId:id,operation:'projects.list',serverRevision:7,result:projectResult},'projects.list',id),false);
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:'4b1f3561-33e1-4aa1-8a54-8dc176cd5368',error:{code:'stale_owner',retryable:true}},null,id),false);
});

test('device grants and owner recheck gate admission (IDOR / stale owner / substitution)',()=>{
  const pair=testKeyPair();
  const device={deviceId:'device_abc12345',devicePublicKey:pair.publicKeyRaw,grantedScopes:['sessions.read','chat.send'],active:true,replayEpoch:1,expiresAt:new Date(Date.now()+3600000).toISOString(),grants:{'project_12345678':true}};
  const ts=Date.now().toString();
  const ownedConvo='conversation_12345678';
  const send=(path,ownerRev=3)=>signedRequest(request('chat.send',path,{clientMessageId:id,text:'x'},{ownerRevision:ownerRev}),pair,Buffer.alloc(32,10).toString('base64url'),ts);
  const baseArgs={device,serviceId:SERVICE_ID,serviceFingerprint:SERVICE_FP,nowMs:Number(ts),consumeNonce:()=>true};
  const granted=()=>({current:true,revision:3,epoch:9,namespace:'runtime',identity:'rt-1',projectId:'project_12345678',conversationId:ownedConvo});
  // conversation in a granted project + current full owner admits
  const ok=authorizeRemoteOperation({...baseArgs,request:send(`/remote/v1/conversations/${ownedConvo}/messages`),resolveOwner:()=>granted()});
  assert.equal(ok.ok,true); assert.equal(ok.owner.namespace,'runtime');
  // conversation in an UNGRANTED project: resolveOwner names the foreign project -> grant rejects (IDOR)
  const idor=authorizeRemoteOperation({...baseArgs,request:send(`/remote/v1/conversations/${ownedConvo}/messages`),resolveOwner:()=>({...granted(),projectId:'project_other00'})});
  assert.equal(idor.code,'unknown_resource');
  // stale owner / stale revision rejected
  assert.equal(authorizeRemoteOperation({...baseArgs,request:send(`/remote/v1/conversations/${ownedConvo}/messages`),resolveOwner:()=>({...granted(),current:false})}).code,'stale_owner');
  assert.equal(authorizeRemoteOperation({...baseArgs,request:send(`/remote/v1/conversations/${ownedConvo}/messages`,4),resolveOwner:()=>({...granted(),revision:9})}).code,'stale_revision');
  // untyped owner (missing namespace/identity) rejected as stale
  assert.equal(authorizeRemoteOperation({...baseArgs,request:send(`/remote/v1/conversations/${ownedConvo}/messages`),resolveOwner:()=>({current:true,revision:3,projectId:'project_12345678'})}).code,'stale_owner');
  // owner missing projectId rejected as stale
  assert.equal(authorizeRemoteOperation({...baseArgs,request:send(`/remote/v1/conversations/${ownedConvo}/messages`),resolveOwner:()=>({current:true,revision:3,namespace:'runtime',identity:'rt-1'})}).code,'stale_owner');
  assert.equal(authorizeRemoteOperation({...baseArgs,request:send(`/remote/v1/conversations/${ownedConvo}/messages`),resolveOwner:()=>{throw Error('gone')}}).code,'stale_owner');
  // grant store absent fails closed
  const noGrants={...device,grants:undefined};
  assert.equal(authorizeRemoteOperation({...baseArgs,device:noGrants,request:send(`/remote/v1/conversations/${ownedConvo}/messages`),resolveOwner:()=>granted()}).code,'grant_store_unavailable');
  // list filtering through same grants
  const items=[{projectId:'project_12345678',displayName:'A'},{projectId:'project_other00',displayName:'B'},{displayName:'no-id'}];
  assert.deepEqual(filterGrantedResources(items,device).map(i=>i.displayName),['A']);
});

test('approval payload enforces the per-method decision/value matrix',()=>{
  assert.equal(validateApprovalPayload({method:'confirm',decision:'allow'}),true);
  assert.equal(validateApprovalPayload({method:'confirm',decision:'answer'}),false);
  assert.equal(validateApprovalPayload({method:'select',decision:'answer',value:'opt_aaaaaaaa'}),true);
  assert.equal(validateApprovalPayload({method:'select',decision:'answer'}),false);
  assert.equal(validateApprovalPayload({method:'input',decision:'answer'}),false);
  assert.equal(validateApprovalPayload({method:'input',decision:'cancel',value:'x'}),false);
  assert.equal(validateApprovalPayload({method:'editor',decision:'answer',value:'x'}),true);
});

test('approval settlement resolves and consumes a live Pi dialog exactly once',()=>{
  const pair=testKeyPair();
  const reqId='req_pending_01';
  const device={deviceId:'device_abc12345',devicePublicKey:pair.publicKeyRaw,grantedScopes:['approvals.respond'],active:true,replayEpoch:1,expiresAt:new Date(Date.now()+3600000).toISOString(),grants:{'project_12345678':true}};
  const ts=Date.now().toString();
  const respond=(method='confirm',decision='allow',value)=>signedRequest(request('approvals.respond',`/remote/v1/conversations/conversation_12345678/approvals/${reqId}/respond`,{method,decision,...(value===undefined?{}:{value})},{ownerRevision:5}),pair,Buffer.alloc(32,14).toString('base64url'),ts);
  const owner={current:true,revision:5,epoch:9,namespace:'runtime',identity:'rt-1',projectId:'project_12345678',conversationId:'conversation_12345678',dialogId:reqId};
  const dialog={requestId:reqId,owner:'rt-1',pending:true,method:'confirm',expiresAtMs:Date.now()+60000,revision:0,projectId:'project_12345678',namespace:'runtime'};
  let consumed=0;
  const base={device,serviceId:SERVICE_ID,serviceFingerprint:SERVICE_FP,deviceResolveOwner:()=>owner,pendingDialog:dialog,consumeDialog:({requestId,owner,method,decision,value})=>{consumed++;assert.equal(requestId,reqId);assert.equal(owner,'rt-1');assert.equal(method,'confirm');assert.equal(decision,'allow');const ok=consumed===1;if(ok)dialog.pending=false;return ok;},nowMs:Number(ts),consumeNonce:()=>true};
  const ok=settleApproval({...base,request:respond()});
  assert.equal(ok.ok,true); assert.equal(consumed,1);
  // duplicate settlement: dialog already consumed -> second consume returns false
  assert.equal(settleApproval({...base,request:respond()}).code,'stale_owner');
  // wrong method vs authoritative dialog, stale owner, non-pending, option not offered
  const selectDialog=options=>({requestId:reqId,owner:'rt-1',pending:true,method:'select',expiresAtMs:Date.now()+60000,revision:0,projectId:'project_12345678',namespace:'runtime',options});
  assert.equal(settleApproval({...base,request:respond('select','answer','opt_xxx000'),pendingDialog:selectDialog([{optionId:'opt_aaa000',label:'A'}])}).code,'payload_invalid');
  // bare display label is never accepted as an answer
  assert.equal(settleApproval({...base,request:respond('select','answer','Label text'),pendingDialog:selectDialog([{optionId:'opt_xxx000',label:'Label text'}])}).code,'payload_invalid');
  assert.equal(settleApproval({...base,request:respond('select','answer','opt_xxx000'),pendingDialog:selectDialog([{optionId:'opt_xxx000',label:'X'}]),consumeDialog:()=>true}).ok,true);
  const freshDialog=(patch={})=>({...dialog,pending:true,...patch});
  assert.equal(settleApproval({...base,request:respond(),pendingDialog:freshDialog({owner:'rt-2'})}).code,'stale_owner');
  assert.equal(settleApproval({...base,request:respond(),pendingDialog:freshDialog({pending:false})}).code,'stale_owner');
  assert.equal(settleApproval({...base,request:respond(),pendingDialog:freshDialog({expiresAtMs:Date.now()-1000})}).code,'stale_owner');
  assert.equal(settleApproval({...base,request:respond(),pendingDialog:freshDialog({expiresAtMs:undefined})}).code,'stale_owner');
});

test('pre-auth failures map to a closed wire code and internal codes never leak',()=>{
  for(const internal of ['signature_invalid','signature_expired','device_identity_mismatch','body_parse_mismatch','operation_route_mismatch','replay_store_unavailable']) {
    const wire=wireErrorCode(internal);
    assert.ok(REMOTE_V1.responseEnvelope.errorCodes.includes(wire));
  }
  assert.equal(wireErrorCode('signature_invalid'),'unauthorized');
  assert.equal(wireErrorCode('request_replayed'),'replay_rejected');
  assert.equal(wireErrorCode('unknown_resource'),'unknown_resource');
});

test('UTF-8 byte limits and duplicate query params are enforced',()=>{
  const pair=testKeyPair();
  const device={deviceId:'device_abc12345',devicePublicKey:pair.publicKeyRaw,grantedScopes:['chat.send'],active:true};
  // multibyte text at/over byte limit
  const heavy='\u4e2d'.repeat(Math.ceil(REMOTE_V1.limits.maxTranscriptSerializedBytes/3));
  const over=request('chat.send','/remote/v1/conversations/conversation_12345678/messages',{clientMessageId:id,text:heavy},{ownerRevision:1});
  assert.equal(validateRemoteRequest(over).ok,false);
  // undeclared query parameter rejected (wire-level duplicate params rejected per contract)
  const dup={method:'GET',path:'/remote/v1/events',headers:{...headersFor(''),'accept':'text/event-stream'},rawBody:'',query:{cursor:'a',cursor2:'a'}};
  assert.equal(validateRemoteRequest(dup).code,'query_invalid');
  // malformed UTF-8 body rejected strictly
  const bad={method:'POST',path:'/remote/v1/conversations/conversation_12345678/messages',headers:{...headersFor('x'),'content-type':'application/json; charset=utf-8'},rawBody:Buffer.from([0xff,0xfe]),body:{}};
  assert.equal(validateRemoteRequest(bad).code,'body_parse_mismatch');
});

test('raw transport adapter rejects duplicate names, bad encoding, BOM and reserved literals',()=>{
  assert.equal(validateRawTarget('/remote/v1/events?cursor=a').ok,true);
  assert.equal(validateRawTarget('/remote/v1/events?cursor=a&cursor=b').ok,false);
  assert.equal(validateRawTarget('/remote/v1/events?cursor=a&=b').ok,false);
  assert.equal(validateRawTarget('/remote/v1/conversations/stream-reset/snapshot').ok,false);
  assert.equal(validateRawTarget('/remote/v1/events?cursor=%zz').ok,false);
  assert.equal(validateRawTarget('/remote/v1/events').ok,true);
  assert.equal(validateRawTarget('/remote/v1/events?cursor=a?x=1').ok,false);
  const good2=validateRawTarget('/remote/v1/events?cursor=a%2Fb');
  assert.equal(good2.ok,true); assert.equal(good2.query.cursor,'a/b');
  // decoded percent sequences that would smuggle separators are still rejected downstream
  assert.equal(validateRawTarget('/remote/v1/%00').ok,false); // %00 -> NUL char invalid raw char after decode? (raw has no ctl; decoded NUL rejected below)
});

test('admission token recheck binds owner, device epoch and project at commit',()=>{
  const device={deviceId:'device_abc12345',devicePublicKey:'k',active:true,replayEpoch:1,expiresAt:new Date(Date.now()+3600000).toISOString(),grantedScopes:['chat.send'],grants:{project_12345678:true}};
  const owner={current:true,revision:3,epoch:9,projectId:'project_12345678',namespace:'runtime',identity:'rt-1',conversationId:'conversation_12345678'};
  const token={deviceId:'device_abc12345',replayEpoch:1,scope:'chat.send',ownerEpoch:9,ownerRevision:3,projectId:'project_12345678',resourceId:'conversation_12345678',requestId:id,issuedAtMs:Date.now()};
  assert.equal(commitAdmission({admissionToken:token,device,resolveOwner:()=>owner}).ok,true);
  assert.equal(commitAdmission({admissionToken:token,device:{...device,revoked:true},resolveOwner:()=>owner}).code,'device_inactive');
  assert.equal(commitAdmission({admissionToken:token,device,resolveOwner:()=>({...owner,current:false})}).code,'stale_owner');
  assert.equal(commitAdmission({admissionToken:token,device,resolveOwner:()=>({...owner,epoch:10})}).code,'stale_owner');
  assert.equal(commitAdmission({admissionToken:token,device,resolveOwner:()=>({...owner,revision:4})}).code,'stale_revision');
  assert.equal(commitAdmission({admissionToken:{...token,replayEpoch:2},device,resolveOwner:()=>owner}).code,'signature_invalid');
});

test('wire error stage-awareness and closed mapping with own-property lookup',()=>{
  assert.equal(wireErrorCode('signature_invalid'),'unauthorized');
  assert.equal(wireErrorCode('signature_invalid','preauth'),'unauthorized');
  assert.equal(wireErrorCode('scope_denied','preauth'),'unauthorized');
  assert.equal(wireErrorCode('request_replayed'),'replay_rejected');
  // prototype / inherited names never leak through; unknown code -> closed fallback
  assert.equal(wireErrorCode('constructor'),'internal_error');
  assert.equal(wireErrorCode('toString'),'internal_error');
  assert.equal(wireErrorCode('made_up_internal'),'internal_error');
});

test('zero-UUID sentinel only on uncorrelated unauthorized error; arrays rejected',()=>{
  const zero='00000000-0000-0000-0000-000000000000';
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:zero,error:{code:'unauthorized',retryable:false}},null,null),true);
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:zero,error:{code:'stale_owner',retryable:true}},null,null),false);
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:zero,operation:'projects.list',serverRevision:1,result:{projects:[],registryRevision:1}},'projects.list',null),false);
  // array/other types rejected outright
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:[id],error:{code:'stale_owner',retryable:true}},null,id),false);
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:{v:id},error:{code:'stale_owner',retryable:true}},null,id),false);
});

test('forbidden values: embedded POSIX/drive paths, credentials; transcript only scans credentials',()=>{
  const okProject={projects:[{projectId:'project_12345678',displayName:'Demo'}],registryRevision:1};
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:id,operation:'projects.list',serverRevision:1,result:okProject},'projects.list',id),true);
  // embedded POSIX path and drive path in a metadata display name rejected
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:id,operation:'projects.list',serverRevision:1,result:{projects:[{projectId:'project_12345678',displayName:'see /opt/demo/config'}],registryRevision:1}},'projects.list',id),false);
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:id,operation:'projects.list',serverRevision:1,result:{projects:[{projectId:'project_12345678',displayName:'see C:/Users/me'}],registryRevision:1}},'projects.list',id),false);
  assert.equal(validateRemoteResponse({protocolVersion:1,requestId:id,operation:'projects.list',serverRevision:1,result:{projects:[{projectId:'project_12345678',displayName:'key sk-abc123456'}],registryRevision:1}},'projects.list',id),false);
  // transcript text may contain paths (legitimate) but not credentials
  const frame={protocolVersion:1,sequence:1,conversationId:'conversation_12345678',ownerRevision:1,streamGeneration:1,cursor:'cursor_aaaaaaaa',event:'message.append',payload:{messageId:'m_12345678',role:'assistant',text:'open /etc/passwd and C:/x/y'},frameSignature:'x'.repeat(86)};
  assert.equal(validateEventEnvelope(frame),true);
  const leak={...frame,payload:{...frame.payload,text:'PI_GUI_TOKEN=abc'}};
  assert.equal(validateEventEnvelope(leak),false);
  // but a path in a NON-transcript field (title) is still forbidden
  const ap={...frame,event:'approval.pending',payload:{requestId:'req_aaaaaaaa',method:'confirm',title:'open /etc/x',message:'m'}};
  assert.equal(validateEventEnvelope(ap),false);
});

test('wireErrorCode pair-stage resolves the closed pairExchange map',()=>{
  // every internal pair code resolves to its documented wire code (closed fallback)
  for(const [internal,wire] of Object.entries(REMOTE_V1.responseEnvelope.internalCodeMapping.pairExchange)) {
    const preauth=['route_mismatch','pair_headers_invalid','query_invalid'].includes(internal);
    assert.equal(wireErrorCode(internal,'pair'),preauth?'unauthorized':wire,internal);
  }
  assert.equal(wireErrorCode('pairing_session_invalid','pair'),'pairing_expired');
  assert.equal(wireErrorCode('pair_rate_limited','pair'),'rate_limited');
  assert.equal(wireErrorCode('pair_code_consumed_or_limited','pair'),'pairing_rejected');
  assert.equal(wireErrorCode('made_up_pair_code','pair'),'internal_error');
  assert.equal(wireErrorCode('signature_invalid','pair'),'unauthorized');
});

test('forbidden-value boundary matrix: paths and env dumps after any delimiter',()=>{
  const rsp=name=>({protocolVersion:1,requestId:id,operation:'projects.list',serverRevision:1,result:{projects:[{projectId:'project_12345678',displayName:name}],registryRevision:1}});
  for(const name of ['k=C:/x','"C:/q"',';C:/q','path=C:\\x','k=\\\\files\\dir','=\\\\backup\\d','x=/foo/bar','(C:/q','WINDIR=C:\\Windows','USER=admin','KEY=abc','HTTP_PROXY=http://h:8080','MY_KEY=abc123']) {
    assert.equal(validateRemoteResponse(rsp(name),'projects.list',id),false,name);
  }
  // legitimate names still pass
  assert.equal(validateRemoteResponse(rsp('Demo project'),'projects.list',id),true);
  assert.equal(validateRemoteResponse(rsp('a/b relative'),'projects.list',id),true);
});

test('raw target charset gate: non-ASCII, DEL, and # rejected before routing',()=>{
  assert.equal(validateRawTarget('/remote/v1/projects').ok,true);
  assert.equal(validateRawTarget('/remote/v1/e中v').ok,false);
  assert.equal(validateRawTarget('/remote/v1/a b').ok,false);
  assert.equal(validateRawTarget('/remote/v1/a\x7f').ok,false);
  assert.equal(validateRawTarget('/remote/v1/a#b').ok,false);
});

test('reset occupies its sequence; next frame is reset.sequence+1, no freshSubscribe bypass',()=>{
  const mk=(seq,gen)=>({protocolVersion:1,sequence:seq,conversationId:'stream-reset',ownerRevision:1,streamGeneration:gen,cursor:'cursor_aaaaaaaa',event:'reset',payload:{reason:'cursor_expired'}});
  const desktop=testKeyPair();
  const signFrame=f=>{f.frameSignature=sign(null,Buffer.from(buildEventFrameMessage(f,'device_abc12345','svc-1'),'utf8'),desktop.privateKey).toString('base64url');return f;};
  const pub=desktop.publicKeyRaw;
  // fresh subscribe accepts reset at any generation
  const r1=acceptEventFrame({event:signFrame(mk(7,3)),deviceId:'device_abc12345',serviceId:'svc-1',desktopPublicKey:pub,deviceScopes:['sessions.read']});
  assert.equal(r1.ok,true); assert.deepEqual(r1.lastAcceptedPosition,{streamGeneration:3,sequence:7});
  // established stream: a reset at a LOWER/equal generation is rejected (no bypass flag)
  assert.equal(acceptEventFrame({event:signFrame(mk(1,3)),deviceId:'device_abc12345',serviceId:'svc-1',desktopPublicKey:pub,deviceScopes:['sessions.read'],expectedStreamGeneration:5,expectedSequence:2}).code,'sequence_gap');
  // greater generation accepted; next ordinary frame expected at reset.sequence+1
  const r2=acceptEventFrame({event:signFrame(mk(9,6)),deviceId:'device_abc12345',serviceId:'svc-1',desktopPublicKey:pub,deviceScopes:['sessions.read'],expectedStreamGeneration:5,expectedSequence:2});
  assert.equal(r2.ok,true); assert.deepEqual(r2.lastAcceptedPosition,{streamGeneration:6,sequence:9});
});

test('out-of-scope and network-path vectors per valueScanOutOfScope',()=>{
  const rsp=name=>({protocolVersion:1,requestId:id,operation:'projects.list',serverRevision:1,result:{projects:[{projectId:'project_12345678',displayName:name}],registryRevision:1}});
  // out-of-scope forms PASS the scan (documented)
  for(const ok of ['C:relative','D:relative/x','~root/x','~user/dir','https://example.com','https://example.com/','https://h:8080','ftp://host','plain text']) {
    assert.equal(validateRemoteResponse(rsp(ok),'projects.list',id),true,`out-of-scope allowed: ${ok}`);
  }
  // network-path shapes scanned scheme-agnostically (incl :port/@userinfo) -> REJECTED
  for(const bad of ['https://example.com/x','smb://srv/share/x','//srv/dir','//srv:8080/dir','smb://srv:9/share','https://user:pw@h/x','ftp://u@h/p','x=//h:9/s','file:///etc/passwd','file:///C:/x','\\Windows\System32']) {
    assert.equal(validateRemoteResponse(rsp(bad),'projects.list',id),false,`network path rejected: ${bad}`);
  }
});

test('quoted-key credentials rejected in metadata AND transcript text',()=>{
  const rsp=name=>({protocolVersion:1,requestId:id,operation:'projects.list',serverRevision:1,result:{projects:[{projectId:'project_12345678',displayName:name}],registryRevision:1}});
  for(const bad of ['{"token":"abc12345"}','{"password":"hunter2"}',"'token': 'abc'",'token="v"','API_KEY="x"']) {
    assert.equal(validateRemoteResponse(rsp(bad),'projects.list',id),false,`metadata cred rejected: ${bad}`);
  }
  const frame={protocolVersion:1,sequence:1,conversationId:'conversation_12345678',ownerRevision:1,streamGeneration:1,cursor:'cursor_aaaaaaaa',event:'message.append',payload:{messageId:'m_12345678',role:'assistant',text:'x'},frameSignature:'x'.repeat(86)};
  for(const bad of ['{"token":"abc12345"}','token="abc"','sk-abcdef123456']) {
    assert.equal(validateEventEnvelope({...frame,payload:{...frame.payload,text:bad}}),false,`transcript cred rejected: ${bad}`);
  }
});
