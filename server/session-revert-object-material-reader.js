import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const fail = code => { throw Object.assign(Error(code), { code }); };
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every(k => a[k] === b[k]);

// Query only: this module never initializes, repairs or grants permissions.
export async function recoveryMaterialPrivacy(target, initialize = false, requireProtected = true) {
  if (initialize) return false;
  if (process.platform !== 'win32') {
    const st = await fs.lstat(target);
    return st.uid === process.getuid() && (st.mode & 0o077) === 0;
  }
  const script = `$ErrorActionPreference='Stop'; $i=[System.Security.Principal.WindowsIdentity]::GetCurrent(); $sid=$i.User.Value; $allowed=@($sid,'S-1-5-18','S-1-5-32-544'); $a=Get-Acl -LiteralPath $env:PI_GUI_RECOVERY_ACL_TARGET; $owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; `
    + (requireProtected ? `if($owner -ne $sid -or -not $a.AreAccessRulesProtected){exit 2}; ` : `if($owner -ne $sid -and ($owner -ne $i.Owner.Value -or $allowed -notcontains $owner)){exit 2}; `)
    + `$own=$false; foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow'){if($allowed -notcontains $r.IdentityReference.Value){exit 3}; if($r.IdentityReference.Value -eq $sid -and (($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)){$own=$true}}}; if(-not $own){exit 4}; 'private'`;
  const env = { ...process.env, PI_GUI_RECOVERY_ACL_TARGET: target };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return await new Promise(resolve => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { env, windowsHide: true, timeout: 10000, maxBuffer: 8192 }, (error, stdout) => resolve(!error && stdout.trim() === 'private')));
}

export async function recoveryNoLinks(target, file = false) {
  const resolved = path.resolve(target), chain = [];
  let current = resolved;
  while (true) {
    const st = await fs.lstat(current);
    if (st.isSymbolicLink() || (current === resolved && file ? !st.isFile() || st.nlink !== 1 : !st.isDirectory())) fail('evidence_privacy_unavailable');
    chain.push([current, st]);
    const parent = path.dirname(current); if (parent === current) return chain; current = parent;
  }
}

/** Read fixed server-derived names with lstat/handle/name and parent-chain checks. */
export async function readRecoveryFile({ root, target, maxBytes, privacyCheck = recoveryMaterialPrivacy, deadline, digest, bytes }) {
  const tick = () => { if (Date.now() > deadline) fail('recovery_budget_exceeded'); };
  tick();
  const rootChain = await recoveryNoLinks(root);
  if (!await privacyCheck(root, false, true)) fail('evidence_privacy_unavailable');
  const chain = await recoveryNoLinks(target, true);
  const parent = path.dirname(target);
  if (parent !== root && !await privacyCheck(parent, false, false)) fail('evidence_privacy_unavailable');
  if (!await privacyCheck(target, false, false)) fail('evidence_privacy_unavailable');
  tick();
  const named = chain[0][1];
  if (named.size > maxBytes || bytes !== undefined && named.size !== bytes) fail('evidence_integrity_failed');
  let handle;
  try {
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !same(before, named)) fail('evidence_integrity_failed');
    // A bounded buffer avoids unbounded readFile allocation if another writer grows the file.
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      tick(); const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break; length += result.bytesRead;
    }
    const after = await handle.stat(), endChain = await recoveryNoLinks(target, true);
    if (!same(before, after) || !same(after, endChain[0][1]) || length !== before.size) fail('evidence_integrity_failed');
    for (const [name, st] of [...rootChain, ...chain.slice(1)]) {
      const end = endChain.find(([p]) => p === name)?.[1];
      if (!end || st.dev !== end.dev || st.ino !== end.ino) fail('evidence_privacy_unavailable');
    }
    if (!await privacyCheck(root, false, true) || !await privacyCheck(target, false, false)
      || parent !== root && !await privacyCheck(parent, false, false)) fail('evidence_privacy_unavailable');
    const finalChain = await recoveryNoLinks(target, true), finalHandle = await handle.stat();
    if (!same(after, finalHandle) || !same(finalHandle, finalChain[0][1])) fail('evidence_integrity_failed');
    for (const [name, st] of chain.slice(1)) {
      const end = finalChain.find(([p]) => p === name)?.[1];
      if (!end || st.dev !== end.dev || st.ino !== end.ino) fail('evidence_privacy_unavailable');
    }
    tick(); const output = buffer.subarray(0, length);
    if (digest !== undefined && createHash('sha256').update(output).digest('hex') !== digest) fail('evidence_integrity_failed');
    return output;
  } finally { await handle?.close(); }
}
