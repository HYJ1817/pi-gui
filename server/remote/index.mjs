/**
 * Remote v1 composition root — service key + TLS cert, device store, pair
 * manager, event stream, adapters, gateway. Started from server.js only when
 * PI_GUI_REMOTE_PORT is set; defaults off and loopback-bound.
 *
 * Contract wiring:
 *  - ONE Ed25519 service key drives both the TLS certificate (self-signed) and
 *    the pair/event signing identity: the cert SHA-256 fingerprint IS the
 *    contract's serviceFingerprint; serviceId = 'svc-'+fp[0:16]
 *  - key/cert rotate on first boot only when absent; any rotation invalidates
 *    old pins (clients must re-pair — contract deviceLifecycle.rotation)
 *  - desktop confirmation is injected; when absent pair exchange fails closed
 *    ('unavailable'), never silently approved
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ed25519Generate, ed25519PublicFromPrivate, selfSignedCert, pem, sha256hex } from './keys.mjs';
import { DeviceStore } from './device-store.mjs';
import { PairManager } from './pair-manager.mjs';
import { EventStream } from './event-stream.mjs';
import { RemoteGateway } from './listener.mjs';
import { buildAdapters } from './adapters.mjs';
import { buildDomain } from './domain.mjs';

export function startRemote({
  dataDir,
  domain = null,
  runtime = null, runtimeRegistry = null, projects = null, ordinarySessions = null,
  host = '127.0.0.1', port = 7789,
  confirmLocally = null,
  grantsFor = null,
  log = () => {},
}) {
  // ---- service identity (persisted Ed25519 key + self-signed TLS cert) ----
  const keyPath = path.join(dataDir, 'remote-service-key.der');
  const certPath = path.join(dataDir, 'remote-service-cert.pem');
  let privateKeyDer;
  try { privateKeyDer = fs.readFileSync(keyPath); } catch {}
  let publicKeyRaw = privateKeyDer ? ed25519PublicFromPrivate(privateKeyDer) : null;
  if (!privateKeyDer || !publicKeyRaw) {
    const generated = ed25519Generate();
    privateKeyDer = generated.privateKeyDer;
    publicKeyRaw = generated.publicKeyRaw;
    try {
      fs.writeFileSync(keyPath, privateKeyDer, { mode: 0o600 });
      fs.chmodSync(keyPath, 0o600);
    } catch (e) { log(`remote service key persist failed: ${e.code}`); }
  }
  const certDer = selfSignedCert({
    publicKeyDer: crypto.createPublicKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' }).export({ format: 'der', type: 'spki' }),
    privateKeyDer,
    commonName: 'pi-gui-remote',
    hosts: [host, 'localhost', '127.0.0.1', '::1'],
  });
  const serviceFingerprint = sha256hex(certDer);
  const serviceKey = {
    privateKey: crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' }),
    privateKeyDer,
    publicKeyRaw,
  };
  try { fs.writeFileSync(certPath, pem('CERTIFICATE', certDer), { mode: 0o600 }); } catch {}

  // ---- stores + domain ----
  const deviceStore = new DeviceStore(dataDir, m => log(`remote: ${m}`));
  const resolvedDomain = domain ?? buildDomain({ runtime, runtimeRegistry, projects, ordinarySessions });
  const adapters = buildAdapters({ domain: resolvedDomain, dataDir, deviceStore });
  const stream = new EventStream({
    serviceKey, serviceFingerprint, deviceStore,
    authorizeResource: adapters.authorizeResource,
  });
  const pairManager = new PairManager({
    dataDir, serviceKey, serviceFingerprint, deviceStore, confirmLocally, grantsFor,
    log: m => log(`remote: ${m}`),
  });
  const gateway = new RemoteGateway({
    port, host,
    tlsOptions: {
      key: pem('PRIVATE KEY', privateKeyDer),
      cert: pem('CERTIFICATE', certDer),
      minVersion: 'TLSv1.2',
      honorCipherOrder: true,
    },
    serviceFingerprint, deviceStore, pairManager, eventStream: stream, adapters, log,
  });

  const admin = {
    /** Local-admin ops (loopback UI calls these over the authenticated 127.0.0.1 API). */
    status: () => ({
      enabled: true, host, port, serviceFingerprint,
      devices: deviceStore.list(),
      pendingPairings: [...pairManager.sessions.keys()].length,
    }),
    issuePairing: () => pairManager.issuePairing(),
    cancelPairing: id => pairManager.cancelPairing(id),
    approvePairing: transcript => pairManager.issueApproval(transcript),
    listDevices: () => deviceStore.list(),
    revokeDevice: id => { const done = deviceStore.revoke(id); if (done) stream.dropDevice(id); return done; },
    setGrants: (id, projectIds) => deviceStore.setGrants(id, projectIds),
  };

  return {
    serviceFingerprint,
    serviceId: `svc-${serviceFingerprint.slice(0, 16)}`,
    serviceKey,
    servicePublicKey: publicKeyRaw,
    pairManager, deviceStore, stream, gateway, adapters, admin,
    listen: () => gateway.listen(),
    close: async () => { stream.close(); await gateway.close(); },
  };
}
