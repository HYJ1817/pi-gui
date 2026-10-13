import { createHash } from 'node:crypto';
import { readAsset, hasBundledAssets } from '../lib/assets.js';
export const OBJECT_HELPER_BYTES = readAsset(hasBundledAssets() ? 'revert-object/observe.ps1' : 'server/session-revert-object-native.ps1');
export const OBJECT_HELPER_HASH = createHash('sha256').update(OBJECT_HELPER_BYTES).digest('hex');
