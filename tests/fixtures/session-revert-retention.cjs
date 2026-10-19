// Test evidence only. No production module imports this helper.
const fs=require('node:fs/promises'),path=require('node:path');
const indexes=new Set(['p33-d2-retained-materials.jsonl','p33-d3-retained-materials.jsonl','p33-d4-retained-materials.jsonl']);
async function appendRetentionIndex(base,name,record){
 if(!indexes.has(name))throw Object.assign(Error('invalid_fixture_retention_index'),{code:'invalid_fixture_retention_index'});
 const directory=path.join(base,'.probe');
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const fd=await fs.open(path.join(directory,name),'a',0o600);
 try{await fd.writeFile(JSON.stringify(record)+'\n');await fd.sync();}finally{await fd.close();}
}
async function preserveFixtureFailure(base,record,error){
 try{await appendRetentionIndex(base,'p33-d4-retained-materials.jsonl',record);}
 catch{console.error('fixture_retention_index_unavailable');}
 throw error;
}
module.exports={appendRetentionIndex,preserveFixtureFailure};
