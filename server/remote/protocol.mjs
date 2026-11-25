/**
 * Remote v1 reference validator — vendored from the mobile repository's
 * scripts/lib/remote-protocol-contract.mjs (frozen M0 contract). Only the
 * CONTRACT_URL differs (local mirror); the rest is byte-identical. Any
 * divergence from the upstream validator is a protocol bug — treat the
 * contract JSON, this validator and the mobile copy as ONE change.
 */
import { createHash, createPrivateKey, createPublicKey, sign as signSignature, verify as verifySignature } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONTRACT_URL = new URL('./contract-v1.json', import.meta.url);
export const REMOTE_V1 = Object.freeze(JSON.parse(readFileSync(fileURLToPath(CONTRACT_URL), 'utf8')));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const ALLOWED_TRANSPORT_HEADERS=new Set([...REMOTE_V1.signedRequestHeaders,'content-type','accept']);
const MAX_REQUEST_BYTES=REMOTE_V1.limits.maxRequestBytes;
const FORBIDDEN_KEYS = new Set(['command','args','path','file','sessionpath','filepath','projectpath','cwd','url','headers','env','token','authorization','piguitoken','apikey','secret','credential']);
const normalizeKey = key => key.toLowerCase().replace(/[_-]/g,'').replace(/[^a-z0-9]/g,'');
const isForbiddenKey = key => {
  const normalized=normalizeKey(key);
  return FORBIDDEN_KEYS.has(normalized)||normalized.endsWith('filepath')||normalized.endsWith('sessionpath')
    ||normalized.endsWith('token')||normalized.endsWith('apikey')||normalized.endsWith('secret')||normalized.endsWith('credential')||normalized.endsWith('password');
};
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytesOf=value=>Buffer.isBuffer(value)?value:typeof value==='string'?Buffer.from(value,'utf8'):null;
const DER_ED25519_PREFIX=Buffer.from('302a300506032b6570032100','hex');
const DER_ED25519_PRIVATE_PREFIX=Buffer.from('302e020100300506032b657004220420','hex');

const MAX_JSON_DEPTH = REMOTE_V1.limits?.maxJsonDepth ?? 16;
// Total canonicalizer: never throws. Cycles, BigInt and non-serializable inputs
// return null (fail closed) instead of crashing the validation path.
function canonicalJson(value,depth=0,seen=new Set()) {
  try {
    if(depth>MAX_JSON_DEPTH)return null;
    if(Array.isArray(value)){if(seen.has(value))return null;seen.add(value);const items=value.map(item=>canonicalJson(item,depth+1,seen));seen.delete(value);return items.some(item=>item===null)?null:`[${items.join(',')}]`;}
    if(isRecord(value)){if(seen.has(value))return null;seen.add(value);const parts=Object.keys(value).sort().map(key=>{const inner=canonicalJson(value[key],depth+1,seen);return inner===null?null:`${JSON.stringify(key)}:${inner}`;});seen.delete(value);return parts.some(part=>part===null)?null:`{${parts.join(',')}}`;}
    return JSON.stringify(value) ?? null;
  } catch { return null; }
}
function strictUtf8(bytes) { try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { return null; } }
function b64url(bytes) {return Buffer.from(bytes).toString('base64url');}
function decodeB64url(text,expectedBytes) {
  if(typeof text!=='string'||!/^[A-Za-z0-9_-]+$/.test(text))return null;
  const bytes=Buffer.from(text,'base64url');
  return bytes.length===expectedBytes&&b64url(bytes)===text?bytes:null;
}
function validateJsonValue(value,depth=0) {
  if(depth>16)return false;
  if(value===null||typeof value==='string'||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(Array.isArray(value))return value.length<=10000&&value.every(item=>validateJsonValue(item,depth+1));
  return isRecord(value)&&Object.entries(value).length<=256&&Object.values(value).every(item=>validateJsonValue(item,depth+1));
}
function validateSchema(value,schema,depth=0) {
  if(depth>16)return false;
  if(schema.type==='object') {
    if(!isRecord(value))return false;
    const props=schema.properties??{};
    if(schema.additionalProperties===false&&Object.keys(value).some(key=>!own(props,key)))return false;
    if((schema.required??[]).some(key=>!own(value,key)))return false;
    return Object.entries(value).every(([key,item])=>{
      if(own(props,key))return validateSchema(item,props[key],depth+1);
      if(isRecord(schema.additionalProperties))return validateSchema(item,schema.additionalProperties,depth+1);
      return schema.additionalProperties===false?false:validateJsonValue(item,depth+1);
    });
  }
  if(schema.type==='array') {
    if(!Array.isArray(value)||(schema.maxItems!==undefined&&value.length>schema.maxItems)||(schema.minItems!==undefined&&value.length<schema.minItems))return false;
    if(schema.uniqueItems&&new Set(value.map(item=>JSON.stringify(item))).size!==value.length)return false;
    if(schema.uniqueItemsBy&&new Set(value.map(item=>isRecord(item)?item[schema.uniqueItemsBy]:undefined)).size!==value.length)return false;
    return schema.items?value.every(item=>validateSchema(item,schema.items,depth+1)):true;
  }
  if(schema.type==='string') {
    if(typeof value!=='string'||(schema.minLength!==undefined&&value.length<schema.minLength)||(schema.maxLength!==undefined&&value.length>schema.maxLength)
      ||(schema.maxUtf8Bytes!==undefined&&Buffer.byteLength(value,'utf8')>schema.maxUtf8Bytes)
      ||(schema.maxSerializedJsonBytes!==undefined&&Buffer.byteLength(JSON.stringify(value),'utf8')>schema.maxSerializedJsonBytes)
      ||(schema.pattern&&!new RegExp(schema.pattern).test(value))||(schema.enum&&!schema.enum.includes(value)))return false;
    if(schema.format==='uuid')return UUID.test(value);
    if(schema.format==='date-time') {
      if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return false;
      const ms=Date.parse(value);
      if(!Number.isFinite(ms))return false;
      // strict calendar: round-trip must reproduce the same wall-clock fields
      const d=new Date(ms),m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
      return d.getUTCFullYear()===+m[1]&&d.getUTCMonth()+1===+m[2]&&d.getUTCDate()===+m[3]
        &&d.getUTCHours()===+m[4]&&d.getUTCMinutes()===+m[5]&&d.getUTCSeconds()===+m[6];
    }
    return true;
  }
  if(schema.type==='integer')return Number.isSafeInteger(value)&&(schema.minimum===undefined||value>=schema.minimum)&&(schema.const===undefined||value===schema.const)&&(schema.enum===undefined||schema.enum.includes(value));
  if(schema.type==='boolean')return typeof value==='boolean';
  return false;
}
// Forbidden values: credentials/Pi secrets AND filesystem paths (absolute POSIX,
// drive, UNC, ~) anywhere in a non-transcript string, plus raw diagnostic text.
const FORBIDDEN_VALUE=new RegExp([
  /(?:^|[^A-Za-z0-9_.\\/~])\/(?!\/)/.source,                     // absolute POSIX path start or '/seg' after any non-path char
  /\w+:\/\/+[A-Za-z]:[\\/]/.source,                                  // URI-scheme drive path (file:///C:/x)
  /\w+:\/\/+\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+/.source,        // URI-scheme POSIX path (file:///etc/x)
  /\/\/+[A-Za-z0-9._~:@-]+\/[A-Za-z0-9._~-]/.source,                // network/UNC authority+path incl :port/@userinfo (//srv:8080/d, scheme://u:p@h/p); bare //host(/) allowed
  /(?:^|[^A-Za-z0-9_.~\/])(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\\(?=[A-Za-z]))/.source, // drive / UNC / ~ / single-\ root path (\\Windows caught)
  /(?:^|[^A-Za-z0-9_.~\/])(?:home|Users|etc|private|var|opt|root|tmp|usr|bin|srv|mnt|data)[\\/][A-Za-z0-9._-]/.source,
  /(?:PI_GUI_TOKEN|api[_-]?key|oauth[_-]?token|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.source,
  /(?:[Bb]earer\s+[A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9]{8,})/.source,
  /["']?(?:password|passwd|secret|credential|token|api[_-]?key)["']?\s*[:=]\s*["']?[^\s,;"']+/i.source,
  /["']?\b[A-Z][A-Z0-9_]{2,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL)["']?=["']?\S+/.source,
  /(?:^|[^A-Za-z0-9_])[A-Z][A-Z0-9_]{2,}["']?=["']?[^\s,;"']+/.source,   // generic env-dump NAME=["]value
  /(?:^|[^A-Za-z0-9_.~\/])\\\\[A-Za-z0-9._-]+[\\]/.source,             // embedded UNC \\srv\dir after any non-path char
  /(?:ENOENT|ECONNREFUSED|stack trace|at [A-Za-z]+ \(|Error: )/.source,
].join('|'),'i');
const CREDENTIAL_VALUE=new RegExp([
  /(?:PI_GUI_TOKEN|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.source,
  /(?:[Bb]earer\s+[A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9]{8,})/.source,
  // assignment-shaped secrets: key=value / key: value / env dump NAME=value
  /["']?(?:api[_-]?key|oauth[_-]?token|secret|credential|password|passwd|token)["']?\s*[:=]\s*["']?[^\s,;"']+/i.source,
  /["']?\b[A-Z][A-Z0-9_]{2,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL)["']?=["']?\S+/.source,
].join('|'),'i');
// Transcript exception paths: only these dotted key paths carry raw conversation
// text that tolerates ordinary prose; they are still credential-scanned.
const TRANSCRIPT_TEXT_PATHS=new Set(['payload.text','messages.text','payload.messages.text','result.messages.text']);
// Cap scanned value length so the path/secret alternation cannot run quadratically
// on a pathological free-text field (a bound the schema should already enforce).
const MAX_SCAN_VALUE_LENGTH=16384;
function hasForbiddenValue(value,depth=0,path=[]) {
  if(depth>MAX_JSON_DEPTH)return true;
  if(typeof value==='string') {
    if(value.length>MAX_SCAN_VALUE_LENGTH)return true; // oversized -> fail closed
    const insideTranscript=TRANSCRIPT_TEXT_PATHS.has(path.join('.'));
    return insideTranscript?CREDENTIAL_VALUE.test(value):FORBIDDEN_VALUE.test(value);
  }
  if(Array.isArray(value))return value.some(item=>hasForbiddenValue(item,depth+1,path));
  if(!isRecord(value))return false;
  return Object.entries(value).some(([key,item])=>hasForbiddenValue(item,depth+1,[...path,key]));
}
function hasForbiddenKey(value,depth=0) {
  if(depth>16)return true;
  if(Array.isArray(value))return value.some(item=>hasForbiddenKey(item,depth+1));
  if(!isRecord(value))return false;
  return Object.entries(value).some(([key,item])=>isForbiddenKey(key)||hasForbiddenKey(item,depth+1));
}
function routeMatches(template,actual,params={}) {
  if(typeof actual!=='string'||!actual.startsWith('/')||actual.includes('?')||actual.includes('#')||actual.includes('\\')||actual.includes('//')||/%2f|%5c/i.test(actual))return false;
  const expected=template.split('/'),received=actual.split('/');if(expected.length!==received.length)return false;
  for(let i=0;i<expected.length;i++) {
    const match=/^\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(expected[i]);
    if(!match){if(expected[i]!==received[i])return false;continue;}
    if(!OPAQUE_ID.test(received[i])||received[i]==='.'||received[i]==='..')return false;
    if(received[i]==='stream-reset')return false;
    params[match[1]]=received[i];
  }
  return true;
}
function validateSignatureHeaders(input,expectedBodyHash,method,eventStream=false) {
  if(!isRecord(input))return {ok:false,code:'signature_headers_missing'};
  const headers=Object.fromEntries(Object.entries(input).map(([key,value])=>[key.toLowerCase(),value]));
  if(Object.keys(headers).length!==Object.keys(input).length||Object.keys(headers).some(name=>!ALLOWED_TRANSPORT_HEADERS.has(name))||own(headers,'x-pi-gui-token'))return {ok:false,code:'signature_headers_invalid'};
  if([...REMOTE_V1.signedRequestHeaders].some(name=>typeof headers[name]!=='string'||!headers[name]))return {ok:false,code:'signature_headers_missing'};
  if(method==='GET'&&headers['content-type']!==undefined)return {ok:false,code:'signature_headers_invalid'};
  if(method!=='GET'&&headers['content-type']!=='application/json; charset=utf-8')return {ok:false,code:'signature_headers_invalid'};
  if(headers.accept!==undefined&&headers.accept!==(eventStream?'text/event-stream':'application/json'))return {ok:false,code:'signature_headers_invalid'};
  if(!OPAQUE_ID.test(headers['x-pi-remote-device'])||!UUID.test(headers['x-pi-remote-request-id'])||!/^[0-9]{13}$/.test(headers['x-pi-remote-timestamp'])
    ||!decodeB64url(headers['x-pi-remote-nonce'],32)||!decodeB64url(headers['x-pi-remote-signature'],64)
    ||!/^[0-9]+$/.test(headers['x-pi-remote-epoch']??'')
    ||!HEX_SHA256.test(headers['x-pi-remote-body-sha256'])||headers['x-pi-remote-body-sha256']!==expectedBodyHash)return {ok:false,code:'signature_headers_invalid'};
  return {ok:true,headers};
}
function validatePairTransportHeaders(input) {
  if(!isRecord(input))return {ok:false,code:'pair_headers_invalid'};
  const headers=Object.fromEntries(Object.entries(input).map(([key,value])=>[key.toLowerCase(),value]));
  if(Object.keys(headers).length!==Object.keys(input).length||Object.keys(headers).some(key=>!['content-type','accept'].includes(key))
    ||headers['content-type']!=='application/json; charset=utf-8'
    ||(headers.accept!==undefined&&headers.accept!=='application/json'))return {ok:false,code:'pair_headers_invalid'};
  return {ok:true};
}
function requestBodyBytes(request) {
  if(request.method==='GET')return request.rawBody===undefined||request.rawBody===null||request.rawBody===''?Buffer.alloc(0):null;
  return bytesOf(request.rawBody);
}
function validateBodyBytes(request) {
  const bytes=requestBodyBytes(request);
  if(!bytes)return {ok:false,code:request.method==='GET'?'get_body_forbidden':'body_bytes_required'};
  if(bytes.length>MAX_REQUEST_BYTES)return {ok:false,code:'request_too_large'};
  if(request.method==='GET') {
    if(request.body!==undefined&&request.body!==null)return {ok:false,code:'get_body_forbidden'};
    return {ok:true,bytes,digest:sha256(bytes)};
  }
  if(bytes.length>=3&&bytes[0]===0xEF&&bytes[1]===0xBB&&bytes[2]===0xBF)return {ok:false,code:'body_parse_mismatch'};
  if(bytes.length>0&&bytes[0]===0xFE&&bytes[1]===0xFF)return {ok:false,code:'body_parse_mismatch'};
  const text=strictUtf8(bytes);
  if(text===null)return {ok:false,code:'body_parse_mismatch'};
  if(!isRecord(request.body))return {ok:false,code:'body_parse_mismatch'};
  let parsed;try {parsed=JSON.parse(text);}catch{return {ok:false,code:'body_parse_mismatch'};}
  const canonical=canonicalJson(parsed);
  if(canonical===null||canonical!==canonicalJson(request.body)||text!==canonical)return {ok:false,code:'body_parse_mismatch'};
  return {ok:true,bytes,digest:sha256(bytes)};
}
function ed25519PublicKey(rawKey) {
  if(!decodeB64url(rawKey,32))return null;
  return createPublicKey({key:Buffer.concat([DER_ED25519_PREFIX,Buffer.from(rawKey,'base64url')]),format:'der',type:'spki'});
}
function ed25519PrivateKey(key) {
  if(key&&key.type==='private'&&key.asymmetricKeyType==='ed25519')return key;
  if(typeof key!=='string')return null;
  const raw=decodeB64url(key,32);if(!raw)return null;
  try{return createPrivateKey({key:Buffer.concat([DER_ED25519_PRIVATE_PREFIX,raw]),format:'der',type:'pkcs8'});}catch{return null;}
}
function signEd25519(privateKey,message) {
  const key=ed25519PrivateKey(privateKey);if(!key)return null;
  try{return signSignature(null,Buffer.from(message,'utf8'),key).toString('base64url');}catch{return null;}
}
function verifyEd25519(rawKey,signature,message) {
  const publicKey=ed25519PublicKey(rawKey),sig=decodeB64url(signature,64);
  if(!publicKey||!sig)return false;
  try{return verifySignature(null,Buffer.from(message,'utf8'),publicKey,sig);}catch{return false;}
}

export function buildPairProofMessage(body) {
  if(!isRecord(body))return null;
  const schema=structuredClone(REMOTE_V1.pairExchange.body);
  schema.required=schema.required.filter(key=>key!=='proofSignature');
  delete schema.properties.proofSignature;
  const {proofSignature,...proofFields}=body;
  if(!validateSchema(proofFields,schema)||hasForbiddenKey(proofFields))return null;
  return ['remote-v1-pair',proofFields.pairingSessionId,proofFields.pairCode,proofFields.deviceName,proofFields.devicePublicKey,proofFields.clientNonce,proofFields.serviceFingerprint,canonicalJson(proofFields.requestedScopes)].join('\n');
}
export function verifyPairProof(body) {
  const message=buildPairProofMessage(body);
  return message!==null&&verifyEd25519(body.devicePublicKey,body.proofSignature,message);
}
export function buildPairProofFields(body) {
  if(!isRecord(body))return null;
  const {proofSignature,...fields}=body;
  return fields;
}
export function buildSignatureMessage({protocolVersion,deviceId,serviceId,replayEpoch,requestId,method,path,query={},timestamp,nonce,bodySha256}) {
  if(!isRecord(query)||Object.values(query).some(value=>typeof value!=='string'))return null;
  if(!OPAQUE_ID.test(deviceId??'')||typeof serviceId!=='string'||serviceId.length===0||!/^[0-9]+$/.test(String(replayEpoch??'')))return null;
  const canonicalQuery=Object.keys(query).sort().map(key=>`${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`).join('&');
  const target=canonicalQuery?`${path}?${canonicalQuery}`:path;
  return [String(protocolVersion),deviceId,serviceId,String(replayEpoch),requestId,String(method).toUpperCase(),target,timestamp,nonce,bodySha256].join('\n');
}
const PRE_AUTHENTICATION_CODES=new Set(['route_mismatch','pair_headers_invalid','signature_headers_missing','signature_headers_invalid','get_body_forbidden','body_bytes_required','body_parse_mismatch','request_too_large','request_invalid','query_invalid','operation_route_mismatch','envelope_invalid','cursor_invalid','replay_store_unavailable','signature_expired','signature_invalid','device_identity_mismatch','device_inactive','service_identity_invalid','device_grants_invalid','grant_store_unavailable','owner_revision_required','owner_revision_invalid']);
export function wireErrorCode(internal,stage='authenticated') {
  if(PRE_AUTHENTICATION_CODES.has(internal))return 'unauthorized';
  // Pair-exchange failures resolve through their own closed map; anything
  // unmapped collapses to internal_error (fail closed, no internal detail leak).
  if(stage==='pair') {
    const pairMap=REMOTE_V1.responseEnvelope.internalCodeMapping?.pairExchange??{};
    return own(pairMap,internal)?pairMap[internal]:'internal_error';
  }
  if(stage!=='authenticated')return 'unauthorized';
  const mapping=REMOTE_V1.responseEnvelope.internalCodeMapping?.postAuthentication??{};
  return own(mapping,internal)?mapping[internal]:'internal_error';
}
function hasDuplicateQueryParams(query) {
  if(!isRecord(query))return false;
  const names=new Set();
  // Dead code kept intentionally: a JS object cannot hold duplicate keys, but the
  // belt-and-braces check documents the duplicate-name rule enforced upstream in
  // validateRawTarget (which sees the raw 'a=1&a=2' string before parsing).
  for(const key of Object.keys(query)) { const normalized=key; if(names.has(normalized))return true; names.add(normalized); }
  return false;
}
// Raw request-target adapter: validate the UNPARSED target string before it is
// collapsed into a {path,query} object. Strict UTF-8, valid percent-encoding,
// single '?', no repeated/blank decoded name, bounded count. Reserved literal
// 'stream-reset' is rejected as a path parameter.
export function validateRawTarget(rawTarget) {
  if(typeof rawTarget!=='string'||rawTarget.length===0||rawTarget.length>2048)return {ok:false,code:'target_invalid'};
  if(rawTarget.charCodeAt(0)===0xFEFF||/^\uFEFF/.test(rawTarget))return {ok:false,code:'target_invalid'};
  if(!/^[^\x00-\x20]*$/.test(rawTarget))return {ok:false,code:'target_invalid'};
  const qIndex=rawTarget.indexOf('?');
  const rawPath=qIndex<0?rawTarget:rawTarget.slice(0,qIndex);
  const rawQuery=qIndex<0?null:rawTarget.slice(qIndex+1);
  if(rawQuery!==null&&rawQuery.includes('?'))return {ok:false,code:'target_invalid'};
  const decodeStrict=text=>{
    if(text.includes('%')) {
      const bytes=[];for(let i=0;i<text.length;i++){
        const ch=text[i];
        if(ch==='%'){
          if(i+2>=text.length||!/^[0-9A-Fa-f]{2}$/.test(text.slice(i+1,i+3)))return null;
          bytes.push(parseInt(text.slice(i+1,i+3),16));i+=2;
        } else bytes.push(ch.charCodeAt(0));
      }
      return strictUtf8(Buffer.from(bytes));
    }
    return text;
  };
  const path=decodeStrict(rawPath);
  // Path charset gate (transportAdapter.rawTarget): ASCII-printable only; rejects
  // non-ASCII, control chars, DEL, '#' and replacement chars before route matching.
  if(path===null||path.includes('\uFFFD')||!path.startsWith('/')||path.includes('\\')||path.includes('//')||path.includes('#')||/[^\x21-\x7E]/.test(path))return {ok:false,code:'target_invalid'};
  if(path.split('/').some(seg=>seg==='stream-reset'))return {ok:false,code:'target_invalid'};
  const params=[];
  if(rawQuery!==null) {
    if(rawQuery.length===0)return {ok:false,code:'target_invalid'};
    const parts=rawQuery.split('&');
    if(parts.length>16||parts.some(part=>part.length===0))return {ok:false,code:'target_invalid'};
    for(const part of parts) {
      const eq=part.indexOf('=');
      const rawName=eq<0?part:part.slice(0,eq);
      const rawValue=eq<0?'':part.slice(eq+1);
      const name=decodeStrict(rawName),value=decodeStrict(rawValue);
      if(name===null||value===null||name.includes('\uFFFD')||value.includes('\uFFFD'))return {ok:false,code:'target_invalid'};
      if(name.length===0||name.length>64)return {ok:false,code:'target_invalid'};
      if(value.length>512)return {ok:false,code:'target_invalid'};
      params.push([name,value]);
    }
    const names=params.map(([name])=>name);
    if(new Set(names).size!==names.length)return {ok:false,code:'target_invalid'};
  }
  return {ok:true,path,query:Object.fromEntries(params)};
}
function validateCursor(cursor) {
  if(cursor===undefined)return {ok:true};
  if(typeof cursor!=='string'||!new RegExp(REMOTE_V1.eventStream.cursorPattern).test(cursor)||cursor.length>REMOTE_V1.eventStream.cursorMaxLength)return {ok:false,code:'cursor_invalid'};
  return {ok:true,cursor};
}
export function canonicalServiceId(serviceFingerprint) {
  if(!HEX_SHA256.test(serviceFingerprint??''))return null;
  return 'svc-'+serviceFingerprint.slice(0,16);
}
export function verifyRemoteSignature({request,device,serviceId,serviceFingerprint,nowMs=Date.now(),consumeNonce}) {
  // Every failure on the signed path is a pre-dispatch authentication failure;
  // the wire code is uniformly 'unauthorized' (internal code never sent).
  const shape=validateRemoteRequest(request);if(!shape.ok)return {ok:false,code:shape.code,wire:'unauthorized'};
  // The service identity is DERIVED from the trusted pin; a caller-supplied id
  // may be cross-checked but never substitutes for the canonical derivation.
  if(!HEX_SHA256.test(serviceFingerprint??''))return {ok:false,code:'service_identity_invalid',wire:'unauthorized'};
  const canonicalId=canonicalServiceId(serviceFingerprint);
  if(serviceId!==undefined&&serviceId!==canonicalId)return {ok:false,code:'service_identity_invalid',wire:'unauthorized'};
  // A complete, consistent, authoritative device record is required before any signature work.
  const recordComplete=isRecord(device)&&typeof device.deviceId==='string'&&typeof device.devicePublicKey==='string'
    &&Array.isArray(device.grantedScopes)&&device.active===true&&device.revoked!==true
    &&Number.isSafeInteger(device.replayEpoch)&&device.replayEpoch>=1
    &&typeof device.expiresAt==='string'&&Number.isFinite(Date.parse(device.expiresAt));
  if(!recordComplete)return {ok:false,code:'device_inactive',wire:'unauthorized'};
  const headers=Object.fromEntries(Object.entries(request.headers).map(([key,value])=>[key.toLowerCase(),value]));
  if(device.deviceId!==headers['x-pi-remote-device'])return {ok:false,code:'device_identity_mismatch',wire:'unauthorized'};
  if(!device.grantedScopes.every(scope=>REMOTE_V1.scopeVocabulary.includes(scope)))return {ok:false,code:'device_grants_invalid',wire:'unauthorized'};
  // device expiry + replay epoch bound into the signed request
  const expiryMs=Date.parse(device.expiresAt);
  if(expiryMs<=nowMs)return {ok:false,code:'device_inactive',wire:'unauthorized'};
  if(Number(headers['x-pi-remote-epoch'])!==device.replayEpoch)return {ok:false,code:'signature_invalid',wire:'unauthorized'};
  // Contract deviceLifecycle.rotation (round-6 R6-SECURITY-1): a device binding
  // is minted under the service pin present at pairing. Rotating the TLS
  // certificate (and with it the derived canonical service id) must invalidate
  // every binding minted under the old pin — otherwise the previously paired
  // device key keeps signing for the NEW service identity without re-pairing.
  if(typeof device.serviceId==='string'&&device.serviceId!==canonicalId)return {ok:false,code:'service_identity_invalid',wire:'unauthorized'};
  if(!Number.isSafeInteger(nowMs))return {ok:false,code:'signature_expired',wire:'unauthorized'};
  const timestamp=Number(headers['x-pi-remote-timestamp']);
  if(!Number.isSafeInteger(timestamp)||Math.abs(nowMs-timestamp)>REMOTE_V1.signedRequest.maximumClockSkewSeconds*1000)return {ok:false,code:'signature_expired',wire:'unauthorized'};
  const message=buildSignatureMessage({protocolVersion:REMOTE_V1.contractVersion,deviceId:device.deviceId,serviceId:canonicalId,replayEpoch:headers['x-pi-remote-epoch'],requestId:headers['x-pi-remote-request-id'],method:request.method,path:request.path,query:request.query??{},timestamp:headers['x-pi-remote-timestamp'],nonce:headers['x-pi-remote-nonce'],bodySha256:headers['x-pi-remote-body-sha256']});
  if(!message||!verifyEd25519(device.devicePublicKey,headers['x-pi-remote-signature'],message))return {ok:false,code:'signature_invalid',wire:'unauthorized'};
  // authenticated-stage failures keep their wire code; stage boundary documented.
  const requiredScope=shape.scope ?? REMOTE_V1.eventStream.scope;
  if(!device.grantedScopes.includes(requiredScope))return {ok:false,stage:'authenticated',code:'scope_denied',wire:'scope_denied'};
  if(typeof consumeNonce!=='function')return {ok:false,code:'replay_store_unavailable',wire:'unauthorized'};
  let consumed;
  try { consumed=consumeNonce(device.deviceId,headers['x-pi-remote-nonce'],timestamp); } catch { return {ok:false,code:'replay_store_unavailable',wire:'unauthorized'}; }
  if(consumed&&typeof consumed.then==='function')return {ok:false,code:'replay_store_unavailable',wire:'unauthorized'};
  if(consumed!==true)return {ok:false,stage:'authenticated',code:'request_replayed',wire:'replay_rejected'};
  return {ok:true,operation:shape.operation,scope:requiredScope,requestId:shape.requestId,deviceId:device.deviceId,pathParameters:shape.pathParameters,cursor:shape.cursor};
}

export function validatePairExchange(request) {
  if(!isRecord(request)||request.method!==REMOTE_V1.pairExchange.method||request.path!==REMOTE_V1.pairExchange.path)return {ok:false,code:'route_mismatch'};
  const query=request.query===undefined?{}:request.query;
  if(!isRecord(query)||Object.keys(query).length!==0)return {ok:false,code:'query_invalid'};
  const transport=validatePairTransportHeaders(request.headers);if(!transport.ok)return transport;
  const body=validateBodyBytes(request);if(!body.ok)return body;
  if(!validateSchema(request.body,REMOTE_V1.pairExchange.body)||hasForbiddenKey(request.body))return {ok:false,code:'pair_payload_invalid'};
  return {ok:true,code:'pair_shape_valid'};
}
export function validatePairExchangeResponse(response) {
  if(!validateSchema(response,REMOTE_V1.pairExchange.responseSchema)||hasForbiddenKey(response))return false;
  const scopes=response.grantedScopes;
  return Array.isArray(scopes)&&scopes.length>=2&&scopes.length<=REMOTE_V1.scopeVocabulary.length&&new Set(scopes).size===scopes.length
    &&scopes.includes('projects.read')&&scopes.includes('sessions.read')
    &&scopes.every(scope=>REMOTE_V1.scopeVocabulary.includes(scope));
}
export function verifyPairExchangeProof(request,expectedServiceFingerprint) {
  const shape=validatePairExchange(request);if(!shape.ok)return shape;
  if(request.body.serviceFingerprint!==expectedServiceFingerprint)return {ok:false,code:'service_fingerprint_mismatch'};
  if(!verifyPairProof(request.body))return {ok:false,code:'pair_proof_invalid'};
  return {ok:true,code:'device_proof_valid_not_authorized'};
}
export function authorizePairExchange({request,expectedServiceFingerprint,peerId,reservePairBudget,validatePairingSession,recordPairAttempt,verifyPairCode,confirmLocally,consumePairingCodeAndRegisterDevice,grantedScopes,deviceId,serverNonce,expiresAt,desktopPrivateKey,nowMs=Date.now()}) {
  const shape=validatePairExchange(request);if(!shape.ok)return shape;
  if(request.body.serviceFingerprint!==expectedServiceFingerprint)return {ok:false,code:'service_fingerprint_mismatch'};
  // Reserve peer + service budget BEFORE any session/code lookup, using a
  // server-derived peer identity, never client-supplied fields.
  if(typeof peerId!=='string'||peerId.length===0)return {ok:false,code:'pair_rate_limiter_unavailable'};
  if(typeof reservePairBudget!=='function')return {ok:false,code:'pair_rate_limiter_unavailable'};
  let budget;try {budget=reservePairBudget({peerId});}catch{return {ok:false,code:'pair_rate_limiter_unavailable'};}
  if(budget&&typeof budget.then==='function')return {ok:false,code:'pair_rate_limiter_unavailable'};
  if(budget!==true)return {ok:false,code:'pair_rate_limited'};
  // Validate the live session, charge the attempt, then verify the code — the
  // attempt is consumed even on a wrong code so guessing exhausts the session budget.
  if(typeof validatePairingSession!=='function')return {ok:false,code:'pair_store_unavailable'};
  let liveSession;
  try { liveSession=validatePairingSession({pairingSessionId:request.body.pairingSessionId}); } catch { return {ok:false,code:'pair_store_unavailable'}; }
  if(liveSession&&typeof liveSession.then==='function')return {ok:false,code:'pair_store_unavailable'};
  if(liveSession!==true)return {ok:false,code:'pairing_session_invalid'};
  if(typeof recordPairAttempt!=='function'||typeof request.body.pairingSessionId!=='string')return {ok:false,code:'pair_rate_limiter_unavailable'};
  const keyFingerprint=sha256(Buffer.from(request.body.devicePublicKey,'base64url'));
  let allowed;try {allowed=recordPairAttempt({peerId,pairingSessionId:request.body.pairingSessionId,deviceKeyFingerprint:keyFingerprint});}catch{return {ok:false,code:'pair_rate_limiter_unavailable'};}
  if(allowed&&typeof allowed.then==='function')return {ok:false,code:'pair_rate_limiter_unavailable'};
  if(allowed!==true)return {ok:false,code:'pair_rate_limited'};
  // Verify the device-key PROOF before the code: an attacker without the key
  // cannot use the correct/wrong-code distinction as a guessing oracle.
  if(!verifyPairProof(request.body))return {ok:false,code:'pair_proof_invalid'};
  // Verify the code AFTER the attempt is charged and the proof holds, still before confirmation.
  if(typeof verifyPairCode!=='function')return {ok:false,code:'pair_store_unavailable'};
  let codeOk;try {codeOk=verifyPairCode({pairingSessionId:request.body.pairingSessionId,pairCode:request.body.pairCode});}catch{return {ok:false,code:'pair_store_unavailable'};}
  if(codeOk&&typeof codeOk.then==='function')return {ok:false,code:'pair_store_unavailable'};
  if(codeOk!==true)return {ok:false,code:'pairing_rejected'};
  // Exact canonical scope agreement: the registered grant set must EQUAL the
  // client's signed requestedScopes and the confirmation-approved set.
  const requestedScopes=request.body.requestedScopes;
  if(!Array.isArray(grantedScopes)||new Set(grantedScopes).size!==grantedScopes.length
    ||!['projects.read','sessions.read'].every(scope=>grantedScopes.includes(scope))
    ||grantedScopes.some(scope=>!REMOTE_V1.scopeVocabulary.includes(scope))||grantedScopes.length>REMOTE_V1.scopeVocabulary.length)return {ok:false,code:'scopes_invalid'};
  if(!Array.isArray(requestedScopes)||new Set(requestedScopes).size!==requestedScopes.length
    ||requestedScopes.length!==grantedScopes.length
    ||!requestedScopes.every(scope=>grantedScopes.includes(scope)))return {ok:false,code:'scopes_invalid'};
  if(typeof confirmLocally!=='function')return {ok:false,code:'desktop_confirmation_required'};
  // Local confirmation binds a one-time approvalId to the FULL verified
  // transcript and the exact approved scope set.
  const proofTranscript=canonicalJson(request.body);
  const confirmation={pairingSessionId:request.body.pairingSessionId,pairCode:request.body.pairCode,deviceName:request.body.deviceName,devicePublicKey:request.body.devicePublicKey,clientNonce:request.body.clientNonce,deviceKeyFingerprint:keyFingerprint,serviceFingerprint:request.body.serviceFingerprint,requestedScopes:[...grantedScopes],proofTranscript};
  let approvalId;
  try { approvalId=confirmLocally(confirmation); } catch { return {ok:false,code:'desktop_confirmation_required'}; }
  if(approvalId&&typeof approvalId.then==='function')return {ok:false,code:'desktop_confirmation_required'};
  if(typeof approvalId!=='string'||approvalId.length===0)return {ok:false,code:'desktop_confirmation_required'};
  // expiresAt must be a well-formed instant and strictly in the future.
  const expiryMs=Date.parse(expiresAt??'');
  if(!OPAQUE_ID.test(deviceId??'')||!decodeB64url(serverNonce,32)||!Number.isFinite(expiryMs)||!(Number.isSafeInteger(nowMs)&&expiryMs>nowMs))return {ok:false,code:'pair_response_invalid'};
  if(typeof consumePairingCodeAndRegisterDevice!=='function')return {ok:false,code:'pair_store_unavailable'};
  const responseRequestId=request.body.clientNonce;
  // Atomically consume approvalId + code + session and register the device,
  // rechecking expiry, capacity and device-key uniqueness in one transaction.
  // The transaction ALLOCATES and returns the committed replayEpoch (re-pairs bump
  // it); the response is signed only AFTER commit so the client stores the real epoch.
  let persisted;
  try {persisted=consumePairingCodeAndRegisterDevice({approvalId,pairingSessionId:request.body.pairingSessionId,pairCode:request.body.pairCode,deviceId,devicePublicKey:request.body.devicePublicKey,grantedScopes,expiresAt,proofTranscript});}
  catch {return {ok:false,code:'pair_store_unavailable'};}
  if(persisted&&typeof persisted.then==='function')return {ok:false,code:'pair_store_unavailable'};
  const committedEpoch=isRecord(persisted)?persisted.replayEpoch:undefined;
  if(persisted===false||persisted===null||persisted===undefined)return {ok:false,code:'pair_code_consumed_or_limited'};
  if(!Number.isSafeInteger(committedEpoch)||committedEpoch<1)return {ok:false,code:'pair_store_unavailable'};
  const unsigned={deviceId,serverNonce,grantedScopes,replayEpoch:committedEpoch,expiresAt};
  if(!validatePairExchangeResponse({...unsigned,serverSignature:'0'.repeat(86)}))return {ok:false,code:'pair_response_invalid'};
  const serverSignature=signEd25519(desktopPrivateKey,['remote-v1-pair-response',responseRequestId,canonicalJson(unsigned)].join('\n'));
  if(!serverSignature)return {ok:false,code:'pair_signing_failed'};
  return {ok:true,code:'device_registered',requestId:responseRequestId,response:{...unsigned,serverSignature}};
}
export function verifyPairExchangeResponse(response,desktopPublicKey,requestId,{outstandingExchange,retireExchange,serviceFingerprint,nowMs=Date.now()}={}) {
  if(!validatePairExchangeResponse(response)||!/^([A-Za-z0-9_-]{43})$/.test(requestId??''))return false;
  const expiryMs=Date.parse(response.expiresAt);
  if(!Number.isFinite(expiryMs)||!(Number.isSafeInteger(nowMs)&&expiryMs>nowMs))return false;
  // A live outstanding exchange for the pinned service is mandatory and must
  // bind this exact service, key, unique scope set and a live deadline.
  if(!isRecord(outstandingExchange)||outstandingExchange.clientNonce!==requestId)return false;
  // The outstanding record must carry the pinned serviceFingerprint and the
  // presented device public key (contract-required completeness).
  if(!HEX_SHA256.test(outstandingExchange.serviceFingerprint??''))return false;
  if(!decodeB64url(outstandingExchange.devicePublicKey,32))return false;
  if(serviceFingerprint!==undefined&&outstandingExchange.serviceFingerprint!==serviceFingerprint)return false;
  if(!Number.isSafeInteger(outstandingExchange.expiresAtMs)||outstandingExchange.expiresAtMs<=nowMs)return false;
  if(outstandingExchange.desktopPublicKey!==undefined&&outstandingExchange.desktopPublicKey!==desktopPublicKey)return false;
  // Compare the response scopes to the outstanding exchange's UNIQUE requestedScopes.
  const expected=outstandingExchange.requestedScopes;
  if(!Array.isArray(expected)||new Set(expected).size!==expected.length)return false;
  if(!(Array.isArray(response.grantedScopes)
    &&expected.length===response.grantedScopes.length
    &&expected.every(scope=>response.grantedScopes.includes(scope))))return false;
  // replayEpoch carried by the response must be a positive integer when present.
  if(response.replayEpoch!==undefined&&(!Number.isSafeInteger(response.replayEpoch)||response.replayEpoch<1))return false;
  const {serverSignature,...unsigned}=response;
  const message=['remote-v1-pair-response',requestId,canonicalJson(unsigned)].join('\n');
  if(!verifyEd25519(desktopPublicKey,serverSignature,message))return false;
  // Retire the outstanding exchange atomically so the response is single-use.
  if(typeof retireExchange!=='function')return false;
  let retired;try {retired=retireExchange(outstandingExchange);}catch{return false;}
  if(retired&&typeof retired.then==='function')return false;
  if(retired!==true)return false;
  return true;
}
export function filterGrantedResources(items,device) {
  if(!Array.isArray(items))return [];
  if(!isRecord(device)||!isRecord(device.grants))return [];
  return items.filter(item=>isRecord(item)&&typeof item.projectId==='string'&&device.grants[item.projectId]===true);
}
export function authorizeRemoteOperation({request,device,serviceId,serviceFingerprint,resolveOwner,resolveResource,nowMs=Date.now(),consumeNonce}) {
  const verification=verifyRemoteSignature({request,device,serviceId,serviceFingerprint,nowMs,consumeNonce});
  if(!verification.ok)return verification;
  // Grants derive from the authoritative device record, not caller input.
  if(!isRecord(device.grants))return {ok:false,code:'grant_store_unavailable',wire:'unauthorized'};
  const params=verification.pathParameters??{};
  const opSpec=REMOTE_V1.operations.find(item=>item.id===verification.operation);
  const ownerRequirement=opSpec?.ownerRequirement??'collection';
  const allowedNamespaces=opSpec?.ownerNamespaces??[];
  // Collection/subscription admission: device + scope only; each returned item /
  // frame is filtered by grant+owner before projection (filterGrantedResources).
  if(ownerRequirement==='collection') {
    return {...verification,owner:null,admissionToken:{deviceId:device.deviceId,replayEpoch:device.replayEpoch,scope:verification.scope,requestId:verification.requestId,issuedAtMs:nowMs}};
  }
  // Resource admission: resolve the authoritative owner for THIS signed target.
  if(typeof resolveOwner!=='function')return {ok:false,code:'stale_owner',wire:'stale_owner'};
  let owner;
  try { owner=resolveOwner({deviceId:device.deviceId,operation:verification.operation,pathParameters:params,ownerRevision:request.body?.ownerRevision}); } catch { return {ok:false,code:'stale_owner',wire:'stale_owner'}; }
  if(owner&&typeof owner.then==='function')return {ok:false,code:'stale_owner',wire:'stale_owner'};
  // Full typed owner must be proven from desktop state, name its project, and be
  // in an allowed namespace for this operation.
  if(!isRecord(owner)||owner.current!==true||!['classic','runtime'].includes(owner.namespace)
    ||typeof owner.identity!=='string'||owner.identity.length===0
    ||!OPAQUE_ID.test(owner.projectId??''))
    return {ok:false,code:'stale_owner',wire:'stale_owner'};
  if(allowedNamespaces.length>0&&!allowedNamespaces.includes(owner.namespace))return {ok:false,code:'stale_owner',wire:'stale_owner'};
  // A resource owner must carry a safe-integer epoch so commitAdmission and the
  // idempotency namespace can detect an owner roll (no epochless TOCTOU).
  if(!Number.isSafeInteger(owner.epoch)||owner.epoch<0)return {ok:false,code:'stale_owner',wire:'stale_owner'};
  // The resolved resource identity must match the signed path, not just any grant.
  if(ownerRequirement==='project'&&owner.projectId!==params.projectId)return {ok:false,code:'unknown_resource',wire:'unknown_resource'};
  if((ownerRequirement==='conversation'||ownerRequirement==='approval')&&owner.conversationId!==params.conversationId)return {ok:false,code:'unknown_resource',wire:'unknown_resource'};
  if(ownerRequirement==='approval'&&owner.dialogId!==params.requestId)return {ok:false,code:'unknown_resource',wire:'unknown_resource'};
  // The grant is checked against the AUTHORITATIVE project the owner resolved to.
  if(device.grants[owner.projectId]!==true)return {ok:false,code:'unknown_resource',wire:'unknown_resource'};
  if(owner.revision===undefined||!Number.isSafeInteger(owner.revision))return {ok:false,code:'stale_owner',wire:'stale_owner'};
  if(request.body?.ownerRevision!==undefined&&owner.revision!==request.body.ownerRevision)return {ok:false,code:'stale_revision',wire:'stale_revision'};
  const admissionToken={deviceId:device.deviceId,replayEpoch:device.replayEpoch,scope:verification.scope,ownerEpoch:owner.epoch,ownerRevision:owner.revision,ownerIdentity:owner.identity,ownerNamespace:owner.namespace,projectId:owner.projectId,resourceId:owner.conversationId??owner.projectId,requestId:verification.requestId,issuedAtMs:nowMs};
  return {...verification,owner,admissionToken};
}
// Versioned admission token recheck at effect commit: re-resolve the CURRENT
// device and owner and compare every bound field before dispatch.
export function commitAdmission({admissionToken,device,resolveOwner,nowMs=Date.now()}) {
  if(!isRecord(admissionToken)||!isRecord(device))return {ok:false,code:'stale_owner'};
  // Full device-record revalidation: the same completeness gate as admission.
  const recordComplete=typeof device.deviceId==='string'&&typeof device.devicePublicKey==='string'
    &&Array.isArray(device.grantedScopes)&&device.active===true&&device.revoked!==true
    &&Number.isSafeInteger(device.replayEpoch)&&device.replayEpoch>=1
    &&typeof device.expiresAt==='string'&&Number.isFinite(Date.parse(device.expiresAt))&&Date.parse(device.expiresAt)>nowMs;
  if(!recordComplete)return {ok:false,code:'device_inactive'};
  if(device.deviceId!==admissionToken.deviceId)return {ok:false,code:'device_inactive'};
  if(device.replayEpoch!==admissionToken.replayEpoch)return {ok:false,code:'signature_invalid'};
  // Scope still granted at commit (scope revocation between admission and dispatch closes it)
  if(!device.grantedScopes.includes(admissionToken.scope))return {ok:false,code:'scope_denied'};
  // Resource-bound token: re-resolve the CURRENT owner and compare project + resource + revision + epoch.
  if(admissionToken.projectId!==undefined) {
    if(!isRecord(device.grants)||device.grants[admissionToken.projectId]!==true)return {ok:false,code:'unknown_resource'};
    if(typeof resolveOwner!=='function')return {ok:false,code:'stale_owner'};
    let owner;try {owner=resolveOwner({deviceId:device.deviceId,projectId:admissionToken.projectId,resourceId:admissionToken.resourceId});}catch{return {ok:false,code:'stale_owner'};}
    if(owner&&typeof owner.then==='function')return {ok:false,code:'stale_owner'};
    if(!isRecord(owner)||owner.current!==true||owner.projectId!==admissionToken.projectId)return {ok:false,code:'stale_owner'};
    // The resolved resource must still be the one the token names (no substitution).
    // A conversation-bound token REQUIRES the re-resolved owner to name that same
    // conversation — an owner missing conversationId cannot satisfy it.
    if(admissionToken.resourceId!==undefined&&admissionToken.resourceId!==admissionToken.projectId&&owner.conversationId!==admissionToken.resourceId)return {ok:false,code:'unknown_resource'};
    // Owner identity/namespace/epoch/revision bound at admission must all still match.
    if(admissionToken.ownerIdentity!==undefined&&owner.identity!==admissionToken.ownerIdentity)return {ok:false,code:'stale_owner'};
    if(admissionToken.ownerNamespace!==undefined&&owner.namespace!==admissionToken.ownerNamespace)return {ok:false,code:'stale_owner'};
    if(admissionToken.ownerRevision!==undefined&&owner.revision!==admissionToken.ownerRevision)return {ok:false,code:'stale_revision'};
    if(admissionToken.ownerEpoch!==undefined&&owner.epoch!==admissionToken.ownerEpoch)return {ok:false,code:'stale_owner'};
  }
  return {ok:true};
}
export function validateRemoteRequest(request) {
  if(!isRecord(request)||typeof request.method!=='string'||typeof request.path!=='string')return {ok:false,code:'request_invalid'};
  const query=request.query===undefined?{}:request.query;
  if(!isRecord(query)||hasForbiddenKey(query)||hasDuplicateQueryParams(query))return {ok:false,code:'query_invalid'};
  let operation=null,operationId='events.stream',cursorCheck=null;
  if(request.path===REMOTE_V1.eventStream.path&&request.method===REMOTE_V1.eventStream.method) {
    if(Object.keys(query).some(key=>!REMOTE_V1.eventStream.queryParameters.includes(key)))return {ok:false,code:'query_invalid'};
    cursorCheck=validateCursor(query.cursor);if(!cursorCheck.ok)return cursorCheck;
  } else {
    operation=REMOTE_V1.operations.find(item=>item.method===request.method&&routeMatches(item.path,request.path));
    if(!operation)return {ok:false,code:'operation_route_mismatch'};
    operationId=operation.id;if(Object.keys(query).length)return {ok:false,code:'query_invalid'};
  }
  const body=validateBodyBytes(request);if(!body.ok)return body;
  const auth=validateSignatureHeaders(request.headers,body.digest,request.method,operationId==='events.stream');if(!auth.ok)return auth;
  const requestId=auth.headers['x-pi-remote-request-id'];
  if(operationId==='events.stream')return {ok:true,code:'event_stream_shape_valid',operation:operationId,requestId,resource:query.cursor??null,cursor:cursorCheck?.cursor};
  if(request.method==='GET') {
    const params={};routeMatches(operation.path,request.path,params);
    return {ok:true,code:'request_shape_valid',operation:operation.id,requestId,scope:operation.scope,pathParameters:params};
  }
  if(!isRecord(request.body)||!validateSchema(request.body,REMOTE_V1.requestEnvelope))return {ok:false,code:'envelope_invalid'};
  if(request.body.operation!==operation.id)return {ok:false,code:'operation_route_mismatch'};
  if(operation.ownerRevisionRequired&&(!Number.isSafeInteger(request.body.ownerRevision)||request.body.ownerRevision<0))return {ok:false,code:'owner_revision_required'};
  if(!operation.ownerRevisionRequired&&own(request.body,'ownerRevision')&&(!Number.isSafeInteger(request.body.ownerRevision)||request.body.ownerRevision<0))return {ok:false,code:'owner_revision_invalid'};
  if(!validateSchema(request.body.payload,operation.payload)||hasForbiddenKey(request.body.payload))return {ok:false,code:'payload_invalid'};
  if(operation.id==='approvals.respond'&&!validateApprovalPayload(request.body.payload))return {ok:false,code:'payload_invalid'};
  const params={};routeMatches(operation.path,request.path,params);
  return {ok:true,code:'request_shape_valid',operation:operation.id,requestId,scope:operation.scope,pathParameters:params};
}
// Atomically resolve the live Pi dialog, validate against its authoritative
// method/options, and consume exactly one response before relaying.
export function settleApproval({request,device,serviceId,serviceFingerprint,deviceResolveOwner,pendingDialog,consumeDialog,nowMs=Date.now(),consumeNonce}) {
  const admission=authorizeRemoteOperation({request,device,serviceId,serviceFingerprint,resolveOwner:deviceResolveOwner,nowMs,consumeNonce});
  if(!admission.ok)return admission;
  if(admission.operation!=='approvals.respond')return {ok:false,code:'operation_rejected',wire:'operation_rejected'};
  const payload=request.body.payload,requestId=admission.pathParameters?.requestId;
  // Live dialog must be a complete authoritative record: pending, finite future
  // expiry, matching method and opaque option ids (never bare labels).
  const dialogLive=isRecord(pendingDialog)&&pendingDialog.requestId===requestId
    &&pendingDialog.owner===admission.owner?.identity
    &&pendingDialog.pending===true&&pendingDialog.method===payload.method
    &&Number.isSafeInteger(pendingDialog.expiresAtMs)&&pendingDialog.expiresAtMs>nowMs
    &&pendingDialog.namespace===admission.owner?.namespace
    &&Number.isSafeInteger(pendingDialog.revision)&&pendingDialog.revision>=0
    &&OPAQUE_ID.test(pendingDialog.projectId??'')&&pendingDialog.projectId===admission.owner?.projectId;
  if(!dialogLive)return {ok:false,code:'stale_owner',wire:'stale_owner'};
  if(payload.method==='select') {
    const offered=pendingDialog.options;
    const validOptions=Array.isArray(offered)&&offered.length>0
      &&offered.every(opt=>isRecord(opt)&&/^[A-Za-z0-9_-]{1,128}$/.test(opt.optionId??''))
      &&new Set(offered.map(opt=>opt.optionId)).size===offered.length;
    if(!validOptions||!offered.some(opt=>opt.optionId===payload.value))return {ok:false,code:'payload_invalid',wire:'payload_invalid'};
  }
  if(typeof consumeDialog!=='function')return {ok:false,code:'stale_owner',wire:'stale_owner'};
  // Single atomic claim-and-enqueue: the live dialog is consumed AND the exact
  // response tuple is durably enqueued to Pi. Returns {enqueued:true} on
  // success; a false/other result means the dialog is still pending (relay
  // failed) and the client may retry - no consumed-but-undelivered state.
  let consumed;
  try { consumed=consumeDialog({requestId,owner:admission.owner.identity,namespace:admission.owner.namespace,method:payload.method,decision:payload.decision,value:payload.value,dialogRevision:pendingDialog.revision}); } catch { return {ok:false,code:'relay_failed',wire:'unavailable'}; }
  if(consumed&&typeof consumed.then==='function')return {ok:false,code:'relay_failed',wire:'unavailable'};
  if(consumed!==true)return {ok:false,code:'relay_failed',wire:'unavailable'};
  return {ok:true,operation:admission.operation,requestId:admission.requestId,deviceId:device.deviceId,owner:admission.owner};
}
export function requiredEventScope(eventName) {
  return REMOTE_V1.eventStream.perEventScopes?.[eventName] ?? null;
}
export function buildEventFrameMessage(event,deviceId,serviceId) {
  if(!isRecord(event)||!OPAQUE_ID.test(deviceId??'')||typeof serviceId!=='string'||serviceId.length===0)return null;
  const payloadBytes=canonicalJson(event.payload);
  if(payloadBytes===null)return null;
  const payloadDigest=sha256(Buffer.from(payloadBytes,'utf8'));
  return [String(REMOTE_V1.contractVersion),deviceId,serviceId,String(event.streamGeneration),String(event.sequence),String(event.conversationId),String(event.ownerRevision),event.cursor,event.event,payloadDigest].join('\n');
}
// Structural validity only — necessary but NOT sufficient for delivery.
export function validateEventEnvelope(event) {
  if(!validateSchema(event,REMOTE_V1.eventStream.eventEnvelope)||hasForbiddenKey(event))return false;
  if(event.event==='reset'&&event.conversationId!=='stream-reset')return false;
  // The reserved reset identity must never appear on ordinary frames either —
  // the server-side emission path could otherwise deliver an ordinary event
  // for a synthetic conversation literally named stream-reset (round-6 R6-NIT-3).
  if(event.event!=='reset'&&event.conversationId==='stream-reset')return false;
  const payloadSchema=REMOTE_V1.eventStream.eventPayloadSchemas[event.event];
  if(!payloadSchema||!validateSchema(event.payload,payloadSchema)||hasForbiddenKey(event.payload)||hasForbiddenValue(event.payload,0,['payload']))return false;
  if(requiredEventScope(event.event)===null)return false;
  const frameBytes=canonicalJson(event);
  if(frameBytes===null||Buffer.byteLength(frameBytes,'utf8')>(REMOTE_V1.limits?.maxEventFrameBytes??65536))return false;
  return true;
}
// Full acceptance: pinned service key + authenticated device + scope + expected stream position.
// Ordinary frames require the expected (generation, sequence); a 'reset' frame
// establishes a new expected position and is not subject to a prior check.
export function acceptEventFrame({event,deviceId,serviceId,desktopPublicKey,deviceScopes,expectedStreamGeneration,expectedSequence,authorizeResource}) {
  if(!validateEventEnvelope(event))return {ok:false,code:'frame_invalid'};
  if(typeof desktopPublicKey!=='string'||!OPAQUE_ID.test(deviceId??'')||typeof serviceId!=='string'||serviceId.length===0)return {ok:false,code:'frame_context_required'};
  const message=buildEventFrameMessage(event,deviceId,serviceId);
  if(!message||!verifyEd25519(desktopPublicKey,event.frameSignature,message))return {ok:false,code:'frame_signature_invalid'};
  const requiredScope=requiredEventScope(event.event);
  if(!Array.isArray(deviceScopes)||!deviceScopes.includes(requiredScope))return {ok:false,code:'scope_denied'};
  if(event.event==='reset') {
    if(event.conversationId!=='stream-reset')return {ok:false,code:'frame_invalid'};
    // A reset must ADVANCE the position: the ONLY fresh-subscribe condition is
    // expectedStreamGeneration===undefined; otherwise the generation must be
    // strictly greater. Stale/duplicate resets are rejected (no bypass flag).
    if(expectedStreamGeneration!==undefined&&!(event.streamGeneration>expectedStreamGeneration))return {ok:false,code:'sequence_gap'};
    // lastAcceptedPosition: the reset OCCUPIES its sequence; callers must feed
    // sequence+1 as the next expected sequence (contract resetSequence).
    return {ok:true,lastAcceptedPosition:{streamGeneration:event.streamGeneration,sequence:event.sequence}};
  }
  if(event.conversationId==='stream-reset')return {ok:false,code:'frame_invalid'};
  if(expectedStreamGeneration===undefined||expectedSequence===undefined)return {ok:false,code:'frame_context_required'};
  if(event.streamGeneration!==expectedStreamGeneration||event.sequence!==expectedSequence)return {ok:false,code:'sequence_gap'};
  // Ordinary frames require a MANDATORY resource authorization that sees the
  // full authenticated context (device, service, conversation, ownerRevision).
  if(typeof authorizeResource!=='function')return {ok:false,code:'frame_context_required'};
  let granted;try {granted=authorizeResource({deviceId,serviceId,conversationId:event.conversationId,ownerRevision:event.ownerRevision,event:event.event});}catch{return {ok:false,code:'unknown_resource'};}
  if(granted&&typeof granted.then==='function')return {ok:false,code:'frame_context_required'};
  if(granted!==true)return {ok:false,code:'unknown_resource'};
  return {ok:true};
}
export function validateApprovalPayload(payload) {
  if(!isRecord(payload))return false;
  const op=REMOTE_V1.operations.find(item=>item.id==='approvals.respond');
  if(!op||!validateSchema(payload,op.payload)||hasForbiddenKey(payload))return false;
  const matrix=op.decisionMatrix?.[payload.method];
  if(!matrix||!matrix.decision.includes(payload.decision))return false;
  const valueRule=matrix.valueOn?.[payload.decision];
  if(valueRule==='required'&&typeof payload.value!=='string')return false;
  if(valueRule==='forbidden'&&payload.value!==undefined)return false;
  if(payload.method==='select'&&payload.decision==='answer'&&!/^[A-Za-z0-9_-]{1,128}$/.test(payload.value??''))return false;
  return true;
}
const ZERO_UUID='00000000-0000-0000-0000-000000000000';
export function validateRemoteResponse(response,operationId=null,requestId=null) {
  if(!isRecord(response)||response.protocolVersion!==REMOTE_V1.contractVersion)return false;
  const rid=response.requestId;
  // requestId must be a primitive UUID string (never an array/object).
  if(typeof rid!=='string')return false;
  // Shared checks always run: serialized size + forbidden-key/value scan.
  const serialized=canonicalJson(response);
  if(serialized===null||Buffer.byteLength(serialized,'utf8')>(REMOTE_V1.limits?.maxSerializedResponseBytes??1048576))return false;
  if(hasForbiddenKey(response)||hasForbiddenValue(response))return false;
  const isError=own(response,'error')&&!own(response,'result');
  // The zero sentinel is ONLY a closed uncorrelated unauthorized error with a
  // fully-validated error object - never a free-form bypass.
  if(rid===ZERO_UUID) {
    return isError&&Object.keys(response).sort().join(',')==='error,protocolVersion,requestId'
      &&Object.keys(response.error).sort().join(',')==='code,retryable'
      &&response.error.code==='unauthorized'&&typeof response.error.retryable==='boolean';
  }
  if(!UUID.test(rid))return false;
  if(requestId!==null&&rid!==requestId)return false;
  if(own(response,'result')) {
    if(Object.keys(response).sort().join(',')!=='operation,protocolVersion,requestId,result,serverRevision'||typeof response.operation!=='string'
      ||(operationId!==null&&response.operation!==operationId)||!Number.isSafeInteger(response.serverRevision)||response.serverRevision<0)return false;
    const operation=REMOTE_V1.operations.find(item=>item.id===response.operation);
    return !!operation&&validateSchema(response.result,operation.result);
  }
  if(!isError||!isRecord(response.error)||Object.keys(response.error).sort().join(',')!=='code,retryable')return false;
  return typeof response.error.code==='string'&&REMOTE_V1.responseEnvelope.errorCodes.includes(response.error.code)
    &&typeof response.error.retryable==='boolean'&&Object.keys(response).sort().join(',')==='error,protocolVersion,requestId';
}
