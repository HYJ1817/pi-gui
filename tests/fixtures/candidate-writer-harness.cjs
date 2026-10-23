/* TEMP-only fault compilation, following the existing P33 isolated harness pattern.
 * Production has no helper override, kill endpoint, fault flags or environment switch. */
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
exports.load=async function(fault){const root=path.resolve(__dirname,'../..');let helper=fs.readFileSync(path.join(root,'server/candidate-write-native.ps1'),'utf8');
 if(fault==='write')helper=helper.replace('/*CANDIDATE_WRITE*/','if(b.Length>=0)throw new IOException("injected_write");');
 if(fault==='partial')helper=helper.replace('/*CANDIDATE_WRITE*/','if(b.Length>=0){uint partial;WriteFile(h,new byte[]{90},1,out partial,IntPtr.Zero);throw new IOException("injected_partial");}');
 if(fault==='flush')helper=helper.replace('Check(FlushFileBuffers(h));','if(b.Length>=0)throw new IOException("injected_flush");Check(FlushFileBuffers(h));');
 if(fault==='rename')helper=helper.replace('/*CANDIDATE_RENAME*/','if(name.Length>=0)throw new IOException("injected_rename");');
 let source=fs.readFileSync(path.join(root,'server/candidate-writer.js'),'utf8').replace(/from '((?:\.\.?\/)[^']+)'/g,(_,p)=>'from '+JSON.stringify(pathToFileURL(path.resolve(root,'server',p)).href));
 source=source.replace(/const helper=readAsset\([^;]+;/,'const helper=Buffer.from('+JSON.stringify(Buffer.from(helper).toString('base64'))+',"base64");').replace('return Object.freeze({async apply(index)','return Object.freeze({killForFixture(){child.kill();},async apply(index)');
 return import('data:text/javascript;base64,'+Buffer.from(source+'\n// '+fault).toString('base64'));
};
