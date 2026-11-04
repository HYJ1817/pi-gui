/* Reuse the normal-sandbox shell runner, including A/B/C regression checks. */
process.env.CONVERSATION_ACCEPTANCE = '1';
require('./app-shell-electron.cjs');
