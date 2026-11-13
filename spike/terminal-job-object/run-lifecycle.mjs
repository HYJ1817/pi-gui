// P3-C0 test-only driver for lifecycle-spike.node.
// Run: node run-lifecycle.mjs wait|drain|closeBlock|spam
// Env: BLOCK_MS, QUEUE_SIZE, SPAM_MS, POSTS, BUSY_MS, EXIT_AFTER_MS,
//      STOP_AFTER_MS, POST_AFTER_STOP_MS, UNREF=0, LIFECYCLE_ADDON, STATE_AFTER_MS
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const addon = require(process.env.LIFECYCLE_ADDON || path.join(here, 'lifecycle-spike.node'));

const modeName = process.argv[2] || 'wait';
const modes = { wait: 0, drain: 1, closeBlock: 2, spam: 3 };
if (!(modeName in modes)) {
  console.error(`[js] unknown mode ${modeName}`);
  process.exit(2);
}
const blockMs = Number(process.env.BLOCK_MS || 60000);
const queueSize = Number(process.env.QUEUE_SIZE || 64);
const spamMs = Number(process.env.SPAM_MS || 5);
const posts = Number(process.env.POSTS || 3);
const busyMs = Number(process.env.BUSY_MS || 0);
const exitAfter = Number(process.env.EXIT_AFTER_MS || 100);
const stopAfter = Number(process.env.STOP_AFTER_MS || 0);
const postAfterStop = Number(process.env.POST_AFTER_STOP_MS || 0);
const abortAt = Number(process.env.ABORT_AT_MS || 0);
const stateAfter = Number(process.env.STATE_AFTER_MS || 0);
const unref = process.env.UNREF !== '0';

let first = true;
function cb(seq) {
  console.error(`[js] cb seq=${seq} t=${addon.mark()}ms`);
  if (busyMs && first) {
    first = false;
    const end = Date.now() + busyMs;
    while (Date.now() < end) { /* hold the JS thread */ }
  }
}

addon.start(cb, modes[modeName], blockMs, queueSize, spamMs);
if (process.env.ACQUIRE_BEFORE_ABORT) addon.acquire();
addon.post(posts);
if (unref) addon.unref();

if (stateAfter) {
  setTimeout(() => console.error(`[js] state t=${addon.mark()}ms ${JSON.stringify(addon.state())}`), stateAfter);
}
if (stopAfter) {
  setTimeout(() => { console.error(`[js] stop t=${addon.mark()}ms`); addon.stop(); }, stopAfter);
}
if (abortAt) {
  setTimeout(() => {
    console.error(`[js] abort t=${addon.mark()}ms`);
    addon.abort();
    addon.post(1); // expected: napi_closing, not a crash
    console.error(`[js] state after abort ${JSON.stringify(addon.state())}`);
  }, abortAt);
}
if (postAfterStop) {
  setTimeout(() => {
    try {
      console.error(`[js] post-after-stop t=${addon.mark()}ms`);
      addon.post(1);
    } catch (e) {
      console.error(`[js] post-after-stop threw: ${e && e.message}`);
    }
  }, stopAfter + postAfterStop);
}
if (exitAfter) {
  setTimeout(() => {
    console.error(`[js] exit t=${addon.mark()}ms state=${JSON.stringify(addon.state())}`);
    process.exit(0);
  }, exitAfter);
}
process.on('exit', (code) => {
  console.error(`[js] process-exit code=${code} t=${addon.mark()}ms state=${JSON.stringify(addon.state())}`);
});
