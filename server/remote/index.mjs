/**
 * Remote v1 gateway bootstrap — service key, device store, pair manager,
 * adapters and the self-contained HTTP listener. Started from server.js when
 * `PI_GUI_REMOTE_PORT` is set (or a dedicated default), it binds separately so
 * the existing 127.0.0.1 router is never exposed to remote paths.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ed25519Generate, ed25519PublicFromPrivate, sha256 } from './contract.mjs';
import { DeviceStore } from './device-store.mjs';
import { PairManager } from './pair-manager.mjs';
import { EventStream } from './event-stream.mjs';
import { RemoteGateway } from './listener.mjs';
import { buildAdapters } from './adapters.mjs';

export function startRemote({ dataDir, runtime, runtimeRegistry, projects, ordinarySessions, host = '127.0.0.1', port = 7789, log = console.log }) {
  // Service identity: persisted Ed25519 key; the fingerprint the mobile pins.
  const keyPath = `${dataDir}/remote-service-key.der`;
  let privateKeyDer = null;
  try { privateKeyDer = fs.readFileSync(keyPath); } catch {}
  let publicKeyRaw = null;
  if (privateKeyDer) {
    try { publicKeyRaw = ed25519PublicFromPrivate(privateKeyDer); } catch { privateKeyDer = null; }
  }
  if (!privateKeyDer) {
    const { publicKeyRaw: pub, privateKeyDer: priv } = ed25519Generate();
    privateKeyDer = priv; publicKeyRaw = pub;
    try {
      fs.writeFileSync(keyPath, priv, { mode: 0o600 });
      fs.writeFileSync(keyPath + '.pub', pub);
    } catch (e) { log(`remote service key persist failed: ${e.code}`); }
  }
  const serviceFingerprint = sha256(Buffer.concat([
    Buffer.from('x/pi/gui|'),
    Buffer.from(publicKeyRaw, 'base64url'),
  ]));
  const serviceKey = { publicKeyRaw, privateKeyDer, serviceFingerprint };

  const deviceStore = new DeviceStore(dataDir, m => log(`remote: ${m}`));
  const pairManager = new PairManager({ serviceKey, serviceFingerprint, deviceStore, log });
  const stream = new EventStream({ serviceKey, serviceFingerprint, deviceStore });
  const adapters = buildAdapters({ projects, runtimeRegistry, ordinarySessions, stream });
  const gateway = new RemoteGateway({
    port, host, serviceKey, serviceFingerprint, deviceStore, pairManager, adapters, log,
  });
  return {
    serviceFingerprint,
    servicePublicKey: publicKeyRaw,
    pairManager,
    deviceStore,
    stream,
    gateway,
    adapters,
    listen: () => gateway.listen(),
    close: () => gateway.close(),
  };
}
