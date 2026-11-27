'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { getNormalSamples, normalSample } = require('./fixtures/visual-replies-normal-samples.cjs');

test('six benign fixture categories have stable identities and no external resources', () => {
  const samples = getNormalSamples();
  assert.equal(samples.length, 6);
  assert.equal(new Set(samples.map(x => x.id)).size, 6);
  assert.throws(() => normalSample('not-a-sample'), /unknown_normal_sample/);
  for (const row of samples) {
    assert.ok(row.height >= 80 && row.height <= 2048);
    assert.ok(Buffer.byteLength(row.html) < 2 * 1024 * 1024);
    assert.doesNotMatch(row.html, /https?:|fetch\(|XMLHttpRequest|WebSocket|postMessage|require\(|import\s|localStorage|sessionStorage/);
    const dom = new JSDOM(row.html);
    assert.equal(dom.window.document.querySelectorAll('#sample-action').length, 1);
    for (const script of dom.window.document.scripts) new vm.Script(script.textContent);
    dom.window.close();
  }
});
for (const row of getNormalSamples()) test('normal interaction fixture: ' + row.id, () => {
  const dom = new JSDOM(row.html, { runScripts: 'dangerously' });
  try {
    const doc = dom.window.document;
    assert.equal(doc.documentElement.dataset.sampleReady, 'true');
    doc.querySelector('#sample-action').click();
    assert.equal(doc.documentElement.dataset.interacted, '1');
    assert.equal(doc.querySelector('#sample-state').textContent, row.expected);
    if (row.id === 'long-table') {
      assert.equal(doc.querySelectorAll('tbody tr').length, 180);
      doc.querySelector('#sample-action').click();
      assert.equal(doc.querySelectorAll('tbody tr').length, 0);
    }
    if (row.id === 'charts') {
      assert.equal(doc.querySelectorAll('svg').length, 3);
      doc.querySelector('[data-week="2"]').dispatchEvent(new dom.window.Event('focus'));
      assert.equal(doc.querySelector('#sample-state').textContent, 'W3: 30 files');
    }
    if (row.id === 'raster-image') {
      const png = Buffer.from(doc.querySelector('img').src.split(',')[1], 'base64');
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16), 2); assert.equal(png.readUInt32BE(20), 2);
    }
  } finally { dom.window.close(); }
});
