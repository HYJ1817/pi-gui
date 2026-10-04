'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../electron/browser-agent-policy.cjs');
assert.ok(fs.existsSync(file), 'P29 pure policy exists');
const { allowedAgentUrl, safeUrl, validateRequest, KEYS } = require(file);
let n = 1;
for (const url of ['http://localhost:3000/', 'https://127.0.0.1:3000/', 'http://[::1]:3000/', 'http://127.2.3.4:3000/']) {
  assert.equal(allowedAgentUrl(url, 'http://127.0.0.1:7788'), true); n++;
}
for (const url of ['https://github.com/', 'http://localhost.evil/', 'http://localhost:7788/', 'http://127.2.3.4:7788/', 'file:///a', 'http://u:p@localhost:3000/', 'http://localhost:3000/\nx']) {
  assert.equal(allowedAgentUrl(url, 'http://127.0.0.1:7788'), false); n++;
}
assert.equal(safeUrl('http://u:p@localhost:3000/a?token=secret#x'), 'http://localhost:3000/a'); n++;
for (const action of ['eval', 'execute_js', '__proto__']) { assert.equal(validateRequest({ requestId:'1', action, args:{} }), 'unknown_action'); n++; }
assert.equal(validateRequest({ requestId:'1', action:'fill', args:{ref:'e1', text:'hi'} }), null); n++;
assert.equal(validateRequest({ requestId:'1', action:'press', args:{key:'a'} }), 'invalid_key'); n++;
assert.equal(validateRequest({ requestId:'1', action:'status', args:{expression:'secret'} }), 'invalid_arguments'); n++;
assert.equal(KEYS.Enter.key, 'Enter'); n++;
assert.equal(KEYS['Ctrl+Enter'].modifiers, 2); n++;
console.log(`${n}/${n} gui browser policy checks passed`);
