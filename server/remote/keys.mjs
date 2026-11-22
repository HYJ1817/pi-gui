/**
 * Remote v1 crypto primitives — Ed25519 key/SPKI handling and a tiny pure-JS
 * DER encoder for the self-signed TLS certificate. No external dependencies;
 * everything a mobile client pins is derived here (TLS certificate SHA-256
 * fingerprint is the contract's serviceFingerprint).
 */
import crypto from 'node:crypto';

export const sha256hex = input => crypto.createHash('sha256').update(input).digest('hex');
export const sha256bytes = input => crypto.createHash('sha256').update(input).digest();
export const b64url = bytes => Buffer.from(bytes).toString('base64url');
export function decodeB64url(text, expectedBytes) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === expectedBytes && b64url(bytes) === text ? bytes : null;
}
export const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const timingSafeEqual = (a, b) => {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const y = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const MAX_JSON_DEPTH = 16;
/** Total canonical JSON (sorted keys, fail-closed on cycles/depth/non-serializable). */
export function canonicalJson(value, depth = 0, seen = new Set()) {
  try {
    if (depth > MAX_JSON_DEPTH) return null;
    if (Array.isArray(value)) {
      if (seen.has(value)) return null;
      seen.add(value);
      const items = value.map(item => canonicalJson(item, depth + 1, seen));
      seen.delete(value);
      return items.some(item => item === null) ? null : `[${items.join(',')}]`;
    }
    if (isRecord(value)) {
      if (seen.has(value)) return null;
      seen.add(value);
      const parts = Object.keys(value).sort().map(key => {
        const inner = canonicalJson(value[key], depth + 1, seen);
        return inner === null ? null : `${JSON.stringify(key)}:${inner}`;
      });
      seen.delete(value);
      return parts.some(part => part === null) ? null : `{${parts.join(',')}}`;
    }
    return JSON.stringify(value) ?? null;
  } catch { return null; }
}

export function ed25519Generate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  return { publicKeyRaw: b64url(spki.subarray(spki.length - 32)), privateKeyDer: pkcs8 };
}
export function ed25519PublicFromPrivate(privateKeyDer) {
  try {
    const pub = crypto.createPublicKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' }).export({ format: 'der', type: 'spki' });
    return b64url(pub.subarray(pub.length - 32));
  } catch { return null; }
}
export function ed25519Sign(privateKeyDer, messageBytes) {
  try {
    const priv = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
    return crypto.sign(null, messageBytes, priv);
  } catch { return null; }
}
export function ed25519Verify(publicKeyRawB64, signatureBytes, messageBytes) {
  try {
    const raw = decodeB64url(publicKeyRawB64, 32); if (!raw) return false;
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    return crypto.verify(null, messageBytes, pub, signatureBytes);
  } catch { return false; }
}

/* ---- minimal DER builder (enough for an Ed25519 self-signed certificate) ---- */
const derLen = n => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x82, n >> 8, n & 255]) : Buffer.from([0x83, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
const der = (tag, content) => Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
const derSeq = (...parts) => der(0x30, Buffer.concat(parts));
const derSet = (...parts) => der(0x31, Buffer.concat(parts));
const derOid = hex => der(0x06, Buffer.from(hex, 'hex'));
const derBool = v => der(0x01, Buffer.from([v ? 0xff : 0x00]));
const derNull = () => Buffer.from([0x05, 0x00]);
const derInt = bytes => {
  let b = typeof bytes === 'number' ? (bytes === 0 ? Buffer.alloc(1) : Buffer.from(Array.from({ length: 8 }, (_, i) => (bytes / 256 ** (7 - i) | 0) & 0xff)).filter(b => true)) : Buffer.from(bytes);
  while (b.length > 1 && b[0] === 0 && b[1] < 0x80) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.alloc(1), b]);
  return der(0x02, b);
};
const derUtc = d => { const p = n => String(n).padStart(2, '0'); return der(0x17, Buffer.from(`${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`)); };
const derUtf8 = s => der(0x0c, Buffer.from(s, 'utf8'));
const derPrintable = s => der(0x13, Buffer.from(s, 'ascii'));
const derBitString = (bytes, unused = 0) => der(0x03, Buffer.concat([Buffer.from([unused]), bytes]));
const derOctet = bytes => der(0x04, bytes);
const derCtx = (n, inner, explicit = true) => explicit ? der(0xa0 + n, inner) : Buffer.concat([Buffer.from([0x80 + n]), inner]);
const ED25519_ALG = derSeq(derOid('2b6570')); // OID 1.3.101.112 (Ed25519)

/**
 * Self-signed Ed25519 X.509 certificate (CN + optional SAN hosts/IPs).
 * Pinning is by SHA-256 fingerprint of the DER — the contract never relies on
 * CA path validation, so a minimal self-signed cert is exactly what it wants.
 */
export function selfSignedCert({ publicKeyDer, privateKeyDer, commonName = 'pi-gui-remote', hosts = ['127.0.0.1', 'localhost'], days = 365, serial = crypto.randomBytes(16) }) {
  const name = derSeq(derSet(derSeq(derOid('550403'), derUtf8(commonName))));
  const now = new Date();
  const notAfter = new Date(now.getTime() + days * 86400000);
  const san = [];
  for (const h of hosts) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) san.push(der(0x87, Buffer.from(h.split('.').map(Number))));     // iPAddress
    else if (h.includes(':')) {
      // minimal IPv6 SAN (expand ::); skip when unparseable
      const parts = h.split(':'); const zeros = 8 - parts.filter(Boolean).length;
      const groups = []; let ok = true;
      for (const p of parts) {
        if (p === '') { for (let i = 0; i <= zeros; i++) groups.push(0); }
        else { const n = parseInt(p, 16); if (Number.isNaN(n) || n > 0xffff) { ok = false; break; } groups.push(n); }
      }
      if (ok && groups.length === 8) { const buf = Buffer.alloc(16); groups.forEach((g, i) => buf.writeUInt16BE(g, i * 2)); san.push(der(0x87, buf)); }
    } else san.push(der(0x82, Buffer.from(h, 'ascii')));                                                // dNSName
  }
  const extensions = derSeq(derSeq(
    derOid('551d11'),                                 // subjectAltName 2.5.29.17
    derOctet(derSeq(...san)),
  ));
  const tbs = derSeq(
    derCtx(0, derInt(2)),                             // version v3
    derInt(serial),
    ED25519_ALG,
    name,
    derSeq(derUtc(now), derUtc(notAfter)),
    name,
    derSeq(ED25519_ALG, derBitString(publicKeyDer.subarray(publicKeyDer.length - 32))), // raw 32-byte key
    derCtx(3, extensions),
  );
  const sig = crypto.sign(null, tbs, crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' }));
  return derSeq(tbs, ED25519_ALG, derBitString(sig));
}

/** PEM-encode a DER blob. */
export function pem(label, derBytes) {
  const b64 = Buffer.from(derBytes).toString('base64').replace(/.{64}/g, '$&\n').replace(/\n+$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}
