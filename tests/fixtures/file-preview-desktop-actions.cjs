'use strict';
// Exercise the actual common menu with trusted input. Never reinsert detached
// controls or call their handlers to make an obsolete toolbar fixture pass.
module.exports = async function readingOption(t, label) {
  await t.click('.fp-reading-menu');
  await t.until(() => t.read("!!document.querySelector('#actionMenu[role=menu]')"), 'reading-options');
  const index = await t.read(`(()=>{const menu=document.querySelector('#actionMenu');return [...menu.children].findIndex(e=>e.getAttribute('role')==='menuitem'&&e.textContent.trim().replace(/\\s*✓$/,'')===${JSON.stringify(label)})})()`);
  t.assert.ok(index >= 0, 'requested reading option exists');
  await t.click(`#actionMenu > :nth-child(${index + 1})`);
  await t.until(() => t.read("!document.querySelector('#actionMenu')"), 'reading-option-completed');
};
