// Explicit model-controls scenario using the existing normal-sandbox harness.
process.env.G2_SMOKE_THINKING = '1';
require('./electron-smoke.cjs');
