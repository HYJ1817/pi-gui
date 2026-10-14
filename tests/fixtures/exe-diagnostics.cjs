// Test-only classification. Never suppress general warnings or stack traces.
function unexpectedExeDiagnostics({ executable, stdout = '', stderr = '', exit = null }) {
  let remaining = stderr.replaceAll('\r\n', '\n');
  if (typeof executable === 'string' && executable && !/[\r\n]/.test(executable)) {
    const known = `Warning: Cannot load "@napi-rs/canvas" package: "Error: Cannot find module '@napi-rs/canvas'\nRequire stack:\n- ${executable}".`;
    const escaped = known.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    remaining = remaining.replace(new RegExp('(^|\\n)' + escaped + '(?=\\n|$)', 'g'), '$1');
  }
  // Keep the original Error/throw rule, additionally detect uncaught/rejection
  // diagnostics that need not contain an Error: prefix.
  return /Error:|throw|uncaught|unhandled(?:promise)?\s*rejection/i.test(stdout + '\n' + remaining)
    ? 'unexpected_error_output' : exit !== null ? 'unexpected_exit' : null;
}
module.exports = { unexpectedExeDiagnostics };
