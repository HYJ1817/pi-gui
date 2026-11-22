/**
 * Contract compatibility shim — everything remote-facing resolves through the
 * vendored frozen contract (protocol.mjs) or crypto primitives (keys.mjs).
 * The previous ad-hoc constants module was retired: it had drifted from the
 * frozen contract (wrong paths, wrong wire vocabulary). Any consumer reading
 * REMOTE_V1 here now gets the same frozen object the mobile repo validates.
 */
export * from './protocol.mjs';
export {
  sha256hex as sha256, sha256bytes, b64url, decodeB64url, isRecord,
  timingSafeEqual as timingSafe, canonicalJson,
  ed25519Generate, ed25519PublicFromPrivate, ed25519Sign, ed25519Verify,
  selfSignedCert, pem,
} from './keys.mjs';
