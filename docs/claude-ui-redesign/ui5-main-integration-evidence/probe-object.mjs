import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { observeFileObject } from '../../../server/session-revert-object-observer.js';
import { loadObjectHelper, resolveObjectInterpreter } from '../../../server/session-revert-object-resources.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const scope = {
  runtimeOwner: { backendInstance: 'b', projectId: 'p', repoId: null, workspaceId: 'w', workspaceEpoch: 'e',
    conversationId: 'c', runtimeId: 'r', runtimeGeneration: 'g', sessionId: 's' },
  workspaceId: 'w', workspaceEpoch: 'e', conversationId: 'c', nativeSessionId: 's',
};
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p33-object-probe-'));
const content = Buffer.from('probe fixture');
await fs.writeFile(path.join(root, 'file.txt'), content);
try {
  let helper;
  let interpreter;
  try { helper = loadObjectHelper('observer'); } catch (error) { console.log('helper_error', error.code, error.stack); }
  try { interpreter = await resolveObjectInterpreter(); } catch (error) { console.log('interpreter_error', error.code, error.stack); }
  console.log('helper', helper && { bytes: helper.bytes.length, source: helper.source });
  console.log('interpreter', interpreter);
  try {
    const result = await observeFileObject({ root, relativePath: 'file.txt', scope, operationId: 'operation', expectedDigest: hash(content) });
    console.log('observation', JSON.stringify(result, null, 2));
  } catch (error) {
    console.log('observe_error', error.code, error.stack);
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
