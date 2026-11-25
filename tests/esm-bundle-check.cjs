'use strict';
// The legacy jsdom linker must preserve real module values instead of replacing
// the new preview boundary with fake globals. Fixtures never touch user data.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { bundle } = require('./esm-bundle.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-esm-linker-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;
function fixture(files) {
  const dir = path.join(root, String(++serial)); fs.mkdirSync(dir);
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), source);
  return { dir, entry: path.join(dir, 'entry.js') };
}
function execute(entry) {
  const linked = bundle(entry), window = {};
  vm.runInNewContext(linked.code, { window, URL });
  return { linked, window };
}
test('named imports, aliases and dependency execution remain intact', () => {
  const { entry } = fixture({ 'dep.js': 'export const value = 41;', 'entry.js': "import { value as answer } from './dep.js';\nexport const next = answer + 1;" });
  const { linked, window } = execute(entry); assert.equal(window.next, 42); assert.equal(linked.files.length, 2); assert.match(linked.sources, /value as answer/);
});
test('namespace imports see actual original and aliased exports', () => {
  const { entry } = fixture({ 'dep.js': 'const local = 17;\nexport { local as publicValue };\nexport const other = 4;', 'entry.js': "import * as Api from './dep.js';\nexport const next = Api.publicValue + Api.other;" });
  const { window } = execute(entry); assert.equal(window.publicValue, 17); assert.equal(window.next, 21); assert.equal(window.local, undefined);
});
test('import.meta.url resolves against the declaring module, not the entry', () => {
  const { entry, dir } = fixture({ 'dep.js': 'export const localUrl = new URL("worker.js", import.meta.url).href;', 'entry.js': "import { localUrl } from './dep.js';\nexport const resolved = localUrl;" });
  assert.equal(execute(entry).window.resolved, pathToFileURL(path.join(dir, 'worker.js')).href);
});
test('a static lazy engine remains lazy and is not silently linked', () => {
  const { entry } = fixture({ 'entry.js': "export const open = () => import('./nonexistent-lazy-engine.js');" });
  const { linked, window } = execute(entry); assert.equal(linked.files.length, 1); assert.equal(typeof window.open, 'function'); assert.match(linked.code, /import\('\.\/nonexistent-lazy-engine.js'\)/);
});
for (const source of ["import Missing from './missing.js';", "export * from './missing.js';", 'const target = "./missing.js";\nexport const open = () => import(target);']) test(`unsupported syntax fails loudly: ${source.slice(0, 30)}`, () => {
  const { entry } = fixture({ 'entry.js': source }); assert.throws(() => bundle(entry), /链接器不支持/);
});
