process.env.T4A_TASKS='1';
process.env.T3C_RANGES='1';
process.env.T3A_EVIDENCE_DIR=process.env.T4A_EVIDENCE_DIR||require('node:path').join(__dirname,'../.probe/t4-a-electron');
require('./diff-comments-electron.cjs');
