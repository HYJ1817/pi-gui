const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

(async () => {
  const dom = new JSDOM(`<!doctype html><button id="open">Open</button><div id="modal" hidden><div id="modalCard"></div></div><div id="confirmLayer" hidden><div id="confirmCard"></div></div><div id="toasts"></div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  const { openModal, confirmModal } = await import('../public/ui/modal.js');
  const { toast } = await import('../public/ui/toast.js');
  const open = document.getElementById('open');
  open.focus();
  openModal((card) => { card.textContent = 'Dialog'; });
  assert.equal(document.activeElement === open, false, 'modal takes focus');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.getElementById('modal').hidden, true, 'Escape closes modal');
  assert.equal(document.activeElement, open, 'focus returns to opener');

  const decision = confirmModal({ title: 'Delete?', okText: 'Delete', danger: true });
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(document.getElementById('confirmLayer').hidden, false, 'Enter cannot confirm destructive action');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await decision, false, 'Escape cancels destructive action');

  toast('Network error', 'error');
  toast('Network error', 'error');
  assert.equal(document.querySelectorAll('.toast').length, 1, 'duplicate toast is suppressed');
  console.log('interactions: passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
