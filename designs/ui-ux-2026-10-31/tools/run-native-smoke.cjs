'use strict';
const {spawnSync}=require('node:child_process'),path=require('node:path');
const out=process.argv[2];if(!out||!path.isAbsolute(out))throw Error('absolute output required');
process.env.G2_SMOKE_OUTPUT=out;
const r=spawnSync('npm.cmd',['run','test:electron-smoke'],{cwd:path.resolve(__dirname,'../../..'),stdio:'inherit',windowsHide:true,shell:true,env:process.env});process.exitCode=r.status??1;
