import { sendJSON } from './api.js';
const unavailable=async()=>({ok:false,code:'production_allowlist_empty'});
// Ordinary clients can only ask for a display projection. No Apply endpoint,
// global test hook, environment flag or provider option is consulted here.
export const objectRevertTransport=Object.freeze({
 qualification:body=>sendJSON('/api/session-revert/object-qualification',{body}),
 history:body=>sendJSON('/api/session-revert/object-history',{body}),
 prepare:unavailable,apply:unavailable,cancel:unavailable,inspectRecovery:unavailable,
 prepareRecovery:unavailable,exportMaterial:unavailable,
});
