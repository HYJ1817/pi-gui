'use strict';
const {spawnSync}=require('node:child_process'),path=require('node:path');
const out=process.argv[2];if(!out||!path.isAbsolute(out))throw Error('absolute output required');
process.env.DESIGN_SETTINGS_ONLY='1';process.env.DESIGN_PRODUCTION_OUTPUT=out;
const r=spawnSync(process.execPath,[path.join(__dirname,'verify-production-ui.cjs')],{cwd:path.resolve(__dirname,'../../..'),stdio:'inherit',windowsHide:true});process.exitCode=r.status??1;
