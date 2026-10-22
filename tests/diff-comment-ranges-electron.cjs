/* Reuse T3-B's production-backend/process restart fixture, with range phases. */
process.env.T3C_RANGES = '1';
require('./review-comment-electron.cjs');
