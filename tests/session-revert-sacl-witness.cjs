// Authorized audit-environment research tool. Creates only its own TEMP fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const h = require('./session-revert-inplace.cjs');
const { exercise, reopen } = require('./session-revert-inplace-safety.cjs');
const matrix = ['explicit', 'inherited', 'protected', 'mixed'].flatMap(auditProfile => ['protected', 'inherited'].map(metadataKind => ({ auditProfile, metadataKind })));
function compareWitness(before, after, spec) {
  const checks = {};
  checks.readableNonemptyAudit = before.auditReadable === true && after.auditReadable === true && before.auditCount > 0 && after.auditCount > 0 && typeof before.sacl === 'string' && !!before.sacl && typeof before.fullSDDL === 'string' && !!before.fullSDDL;
  for (const key of ['id', 'owner', 'group', 'dacl', 'sacl', 'fullSDDL', 'ads', 'ea', 'attributes', 'isAuditProtected', 'isDaclProtected', 'explicitAuditCount', 'inheritedAuditCount']) checks[key] = before[key] != null && after[key] != null && before[key] === after[key];
  checks.fixtureMaterials = !!before.ea && !before.ea.startsWith('status:') && before.ads === 'original-ads' && before.attributes === 8226;
  checks.daclKind = before.isDaclProtected === (spec.metadataKind === 'protected');
  checks.auditKind = spec.auditProfile === 'protected' ? before.isAuditProtected === true && before.inheritedAuditCount === 0 && before.explicitAuditCount >= 2
    : spec.auditProfile === 'inherited' ? before.inheritedAuditCount > 0 && before.explicitAuditCount === 0
      : spec.auditProfile === 'mixed' ? before.inheritedAuditCount > 0 && before.explicitAuditCount >= 2 : before.explicitAuditCount >= 2;
  return { matched: Object.values(checks).every(Boolean), checks };
}
async function runWitness() {
  const result = { schemaVersion: 1, tool: 'p33-4b-sacl-witness', platform: process.platform, productionQualified: false,
    privileges: { required: 'SeSecurityPrivilege', enabled: false, error: null }, status: 'unavailable', passed: 0, failed: 0, skipped: 0, cases: [] };
  if (process.platform !== 'win32') {
    result.reason = 'windows_required'; result.skipped = matrix.length;
  } else {
    const privilege = await h.one({ mode: 'privilege' }); result.privileges.enabled = privilege.auditEnabled; result.privileges.error = privilege.auditError;
    if (!privilege.auditEnabled) { result.reason = 'audit_privilege_unavailable'; result.skipped = matrix.length; }
    else {
      result.status = 'executed';
      for (const spec of matrix) {
        const row = { ...spec, status: 'failed', reason: null };
        try {
          await h.fixture(Buffer.from('witness C\r\n'), async root => {
            const before = await h.one({ root, relativePath: h.relativePath, mode: 'sacl_setup', ...spec, withExtras: true });
            // Repeating setup must not reset a protected/inherited audit fixture.
            const repeated = h.start({ root, relativePath: h.relativePath, mode: 'sacl_setup', ...spec, withExtras: true });
            await repeated.exit; assert.equal(repeated.lines.at(-1).code, 'fresh_fixture_required');
            const written = await exercise(root, Buffer.from('witness C\r\n'), Buffer.from('witness R\n'), { privateAcl: true, realStorage: true, metadata: before });
            assert.equal(written.exited.code, 0); const compared = compareWitness(before, written.observed, spec); assert.equal(compared.matched, true);
            const restarted = await reopen(written.materials), savedC = await restarted.store.restoreRead(written.materials.scope, written.materials.file.currentRef);
            assert.deepEqual(savedC, Buffer.from('witness C\r\n'));
            const restored = await exercise(root, written.actual, savedC, { privateAcl: true, realStorage: true, metadata: written.observed });
            assert.equal(restored.exited.code, 0); assert.equal(compareWitness(before, restored.observed, spec).matched, true);
            assert.deepEqual(await fs.readFile(path.join(root, h.relativePath)), savedC);
            row.status = 'passed'; row.checks = compared.checks; row.osVersion = before.osVersion; row.fileSystem = before.fileSystem;
            row.currentDigest = h.hash(savedC); row.candidateDigest = h.hash(written.actual); row.backupVerified = true; row.secondPlanHandshake = true; row.confirmationSource = 'fixture';
          }); result.passed++;
        } catch { result.failed++; row.reason = 'witness_case_failed'; }
        result.cases.push(row);
      }
      if (result.failed) result.status = 'failed';
    }
  }
  if (result.skipped) result.cases = matrix.map(spec => ({ ...spec, status: 'unverified', reason: result.reason }));
  return result;
}
module.exports = { compareWitness, runWitness };
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--require-audit') || args.length > 1) { console.error('invalid_research_arguments'); process.exitCode = 1; return; }
  const result = await runWitness(); console.log(JSON.stringify(result));
  console.log(`session-revert-sacl-witness: ${result.passed}/${result.passed + result.failed}; failed=${result.failed}; skipped=${result.skipped}; real audit environment only`);
  if (result.failed || (args.includes('--require-audit') && result.status !== 'executed')) process.exitCode = result.failed ? 1 : 2;
})().catch(() => { console.error('witness_unavailable'); process.exitCode = 1; });
