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
  // The TLS certificate SHA-256 IS the contract serviceFingerprint that every
  // client pins. A self-signed cert embeds a serial + notBefore/notAfter, so
  // regenerating it yields a DIFFERENT fingerprint each boot — which would
  // invalidate every paired device's pin on restart (deviceLifecycle.rotation
  // is for EXPLICIT rotation, not routine reboots). Key and cert are therefore
  // persisted together and only ever minted on first boot or explicit rotation.
  const keyPath = path.join(dataDir, 'remote-service-key.der');
  const certPath = path.join(dataDir, 'remote-service-cert.pem');
  let privateKeyDer, certPem;
  try { privateKeyDer = fs.readFileSync(keyPath); } catch {}
  try { certPem = fs.readFileSync(certPath, 'utf8'); } catch {}
  let publicKeyRaw = privateKeyDer ? ed25519PublicFromPrivate(privateKeyDer) : null;
  if (!privateKeyDer || !publicKeyRaw) {
    const generated = ed25519Generate();
    privateKeyDer = generated.privateKeyDer;
    publicKeyRaw = generated.publicKeyRaw;
    certPem = null;                                            // never bind a stale cert to a new key
    try {
      fs.writeFileSync(keyPath, privateKeyDer, { mode: 0o600 });
      fs.chmodSync(keyPath, 0o600);
    } catch (e) { log(`remote service key persist failed: ${e.code}`); }
  }
  let certDer;
  if (typeof certPem === 'string' && certPem.includes('BEGIN CERTIFICATE')) {
    try { certDer = Buffer.from(certPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64'); } catch { certDer = null; }
  }
  if (!certDer || certDer.length === 0) {
    certDer = selfSignedCert({
      publicKeyDer: crypto.createPublicKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' }).export({ format: 'der', type: 'spki' }),
      privateKeyDer,
      commonName: 'pi-gui-remote',
      hosts: [host, 'localhost', '127.0.0.1', '::1'],
    });
    certPem = pem('CERTIFICATE', certDer);
    try {
      fs.writeFileSync(certPath, certPem, { mode: 0o600 });
      fs.chmodSync(certPath, 0o600);
    } catch (e) { log(`remote service cert persist failed: ${e.code}`); }
  }
  const serviceFingerprint = sha256hex(certDer);
  const serviceKey = {
    privateKey: crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' }),
    privateKeyDer,
    publicKeyRaw,
  };

  // ---- stores + domain ----
  const deviceStore = new DeviceStore(dataDir, m => log(`remote: ${m}`));
  const resolvedDomain = domain ?? buildDomain({ runtime, runtimeRegistry, projects, ordinarySessions });
  // stream and adapters are mutually dependent (adapters.authorizeResource is
  // called by the stream; adapters.runtimeSnapshot needs stream.watermark).
  // Break the cycle with a forward reference — adapters sees a callable that
  // delegates to the stream once it's built.
  let stream;
  const adapters = buildAdapters({
    domain: resolvedDomain, dataDir, deviceStore,
    streamWatermark: id => stream.watermark(id),
  });
  stream = new EventStream({
    serviceKey, serviceFingerprint, deviceStore,
    authorizeResource: adapters.authorizeResource,
    authorizationState: adapters.authorizationState,
  });
  // The device record is the single authority for every authorization
  // transition; stream invalidation is wired here exactly once so admin
  // operations cannot forget or double-apply it.
  deviceStore.onAuthorizationChanged = (deviceId, reason) => stream.authorizationChanged(deviceId, reason);
  const pairManager = new PairManager({
    dataDir, serviceKey, serviceFingerprint, deviceStore, confirmLocally, grantsFor,
    log: m => log(`remote: ${m}`),
  });
  const gateway = new RemoteGateway({
    port, host,
    tlsOptions: {
      key: pem('PRIVATE KEY', privateKeyDer),
      cert: certPem,
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
    listPendingConfirmations: () => pairManager.listPendingConfirmations(),
    approvePendingConfirmation: id => pairManager.approvePendingConfirmation(id),
    declinePendingConfirmation: id => pairManager.declinePendingConfirmation(id),
    listDevices: () => deviceStore.list(),
    revokeDevice: id => deviceStore.revoke(id),
    // Removing a grant revokes access immediately: reset the device's
    // streams (authorization_changed) so no live/replayed frame for the
    // revoked resource can still be delivered (contract resetScope +
    // mustRevalidateAuthorizationBeforeReplay).
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
