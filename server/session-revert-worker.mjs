import { parentPort, workerData } from 'node:worker_threads';

// Worker receives only backend-authorized evidence; it has no writeback API.
const { computeSessionRevert } = await import(workerData.module);
const input = workerData.input;
input.current = input.current === null ? null : Buffer.from(input.current);
for (const record of input.records) {
  for (const key of ['before', 'intendedAfter', 'observedAfter']) {
    record[key] = record[key] === null ? null : Buffer.from(record[key]);
  }
}
parentPort.postMessage(computeSessionRevert(input));
