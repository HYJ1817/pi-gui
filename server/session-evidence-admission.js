// Startup admission only; holds no evidence, owner, paths or registry records.
export function createSessionEvidenceAdmission(initialize) {
  let state='pending';
  const settled=Promise.resolve().then(initialize).then(()=>{state='ready';},()=>{state='failed';});
  return {
    status:()=>state,
    settled,
    assertReady(){
      if(state!=='ready'){
        const code=state==='pending'?'evidence_initializing':'evidence_unavailable';
        throw Object.assign(Error(code),{code});
      }
    },
  };
}
